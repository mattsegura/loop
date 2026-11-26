// Agent identities: every MCP client that connects to Loop gets its own token,
// profile, gateway mode, management permission and secret grants.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_PREFIX = 'loop_';
const TOKEN_PATTERN = /^loop_[A-Za-z0-9_-]{43}$/;
const RECALL_TOKEN_PREFIX = 'loop_rc_';
const RECALL_TOKEN_PATTERN = /^loop_rc_[A-Za-z0-9_-]{43}$/;

export function agentTokenVaultKey(agentId) {
  return `__agent_token_${agentId}`;
}

export function generateAgentToken() {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function isAgentTokenFormat(token) {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

export function generateRecallToken() {
  return RECALL_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function isRecallTokenFormat(token) {
  return typeof token === 'string' && RECALL_TOKEN_PATTERN.test(token);
}

export function hashAgentToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export function tokenHint(token) {
  return `${TOKEN_PREFIX}…${String(token).slice(-4)}`;
}

// Gives the agent a fresh token: stores its hash for lookup and an encrypted copy
// in the vault so the dashboard can show connect snippets again later.
// Pass keepExisting: true (e.g. sibling OAuth sign-ins) so earlier instances stay signed in.
export async function issueAgentToken(store, vault, agentId, { keepExisting = false } = {}) {
  const token = generateAgentToken();
  const nextHash = hashAgentToken(token);
  await vault.set(agentTokenVaultKey(agentId), token, 'Loop agent token');
  let tokenHashes = [];
  if (keepExisting && typeof store.getAgent === 'function') {
    const existing = await store.getAgent(agentId).catch(() => null);
    const prior = [];
    if (Array.isArray(existing?.tokenHashes)) prior.push(...existing.tokenHashes);
    if (existing?.tokenHash && !prior.includes(existing.tokenHash)) prior.push(existing.tokenHash);
    if (!prior.includes(nextHash)) prior.push(nextHash);
    tokenHashes = prior.slice(-20);
  }
  const agent = await store.updateAgent(agentId, {
    tokenHash: nextHash,
    tokenHashes,
    tokenHint: tokenHint(token),
  });
  return { agent, token };
}

// Least-privilege read-only recall token: works ONLY on /api/turn-recall, never on /mcp or /api/*.
export async function issueRecallToken(store, agentId) {
  const token = generateRecallToken();
  const agent = await store.updateAgent(agentId, {
    recallTokenHash: hashAgentToken(token),
  });
  return { agent, token };
}

export async function revokeRecallToken(store, agentId) {
  return store.updateAgent(agentId, { recallTokenHash: null });
}

export async function readAgentToken(vault, agentId) {
  try {
    return await vault.get(agentTokenVaultKey(agentId));
  } catch {
    return null;
  }
}

export function extractBearerToken(req) {
  const header = req.headers?.authorization;
  if (typeof header === 'string') {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  const alt = req.headers?.['x-loop-token'];
  return typeof alt === 'string' ? alt.trim() : null;
}

// The key in an app's settings entry for Loop: in a header, an argument or a variable.
export function agentTokenIn({ headers = {}, args = [], env = {} }) {
  const texts = [...Object.values(headers), ...args, ...Object.values(env)];
  return texts.map((text) => String(text).split(/[\s=]/).pop()).find((word) => TOKEN_PATTERN.test(word)) ?? null;
}

export async function findAgentByToken(store, token) {
  if (!isAgentTokenFormat(token)) return null;
  const wanted = Buffer.from(hashAgentToken(token), 'hex');
  const agents = await store.listAgents();
  let found = null;
  for (const agent of agents) {
    const candidates = [];
    if (agent.tokenHash) candidates.push(agent.tokenHash);
    if (Array.isArray(agent.tokenHashes)) {
      for (const h of agent.tokenHashes) {
        if (h && h !== agent.tokenHash) candidates.push(h);
      }
    }
    for (const hex of candidates) {
      const have = Buffer.from(hex, 'hex');
      // Compare every candidate so timing does not reveal which agent matched.
      if (have.length === wanted.length && timingSafeEqual(have, wanted)) found = agent;
    }
  }
  return found;
}

export async function findAgentByRecallToken(store, token) {
  if (typeof token !== 'string' || !RECALL_TOKEN_PATTERN.test(token)) return null;
  const wanted = Buffer.from(hashAgentToken(token), 'hex');
  const agents = await store.listAgents();
  let found = null;
  for (const agent of agents) {
    if (!agent.recallTokenHash) continue;
    const have = Buffer.from(agent.recallTokenHash, 'hex');
    if (have.length === wanted.length && timingSafeEqual(have, wanted)) found = agent;
  }
  return found;
}

// Effective per-agent turn-recall switch:
// - explicit agent.turnRecall === true / false always wins
// - agent.turnRecall === null (default) inherits workspace settings.turnRecall or legacy LOOP_TURN_RECALL=1
export function isTurnRecallEnabled(agent, settings = null, env = process.env) {
  if (!agent || agent.enabled === false) return false;
  if (settings?.paused) return false;
  if (agent.memoryAccess === 'none') return false;
  if (typeof agent.turnRecall === 'boolean') return agent.turnRecall;
  return Boolean(settings?.turnRecall || env?.LOOP_TURN_RECALL === '1');
}

export function publicAgent(agent, extra = {}) {
  if (!agent) return null;
  const { tokenHash: _hash, tokenHashes: _hashes, recallTokenHash: _recallHash, ...rest } = agent;
  return { ...rest, hasToken: Boolean(agent.tokenHash), ...extra };
}

// Per-agent (and optional per-actor) sliding-window call rate limiter to stop runaway autonomous loops.
export class AgentRateLimiter {
  constructor({ windowMs = 60_000 } = {}) {
    this.windowMs = Math.max(1000, Number(windowMs) || 60_000);
    this.buckets = new Map(); // bucketKey -> number[]
  }

  check(agent, now = Date.now(), { actor = null } = {}) {
    const limit = Number(agent?.rateLimitPerMin);
    if (!agent?.id || !Number.isInteger(limit) || limit <= 0) {
      return { allowed: true };
    }
    const cleanActor = typeof actor === 'string' && actor.trim() ? actor.trim().toLowerCase().slice(0, 64) : '';
    const bucketKey = cleanActor ? `${agent.id}::${cleanActor}` : agent.id;
    const cutoff = now - this.windowMs;
    const prev = this.buckets.get(bucketKey) || [];
    const active = prev.filter((ts) => ts > cutoff);
    if (active.length >= limit) {
      this.buckets.set(bucketKey, active);
      const retryAfterSec = Math.max(1, Math.ceil((active[0] + this.windowMs - now) / 1000));
      return {
        allowed: false,
        limit,
        remaining: 0,
        retryAfterSec,
      };
    }
    active.push(now);
    this.buckets.set(bucketKey, active);
    return { allowed: true, limit, remaining: Math.max(0, limit - active.length) };
  }
}
