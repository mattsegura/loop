// Single-use, short-lived agent onboarding handoff tickets for Loop.
//
// Lets an already-connected agent (like Loop Text) or the owner generate a one-prompt
// setup link + claim code for another agent (Claude Code, Cursor, Codex, etc.).
//
// Security invariants:
// - Raw bearer tokens NEVER appear in URLs, setup pages, or SMS transcripts.
// - Claim codes carry 60 bits of entropy (12 chars from an unambiguous 32-char alphabet),
//   are stored only as SHA-256 hashes, verified in constant time, and burned atomically on first claim.
// - Setup pages (/a/<id>) never reveal the claim code or workspace id.
// - Tickets default to least privilege (canManage: false, memoryAccess: 'read_write') and expire in 10 minutes.
// - A link for one agent that the owner already made (agentId) carries no access of its own: the
//   agent's record decides. It lasts 24 hours, is one per agent, and is kept on disk as a hash.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { atomicWriteFile } from './json-file-store.mjs';
import { INSTALLABLE_HARNESSES } from './agent-installer.mjs';
import { normalizeProfileTag } from './profiles.mjs';
import { HOST_KINDS } from '../public/host-setup.js';

export const AGENT_HANDOFF_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const AGENT_LINK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const MAX_ACTIVE_TICKETS = 200;
const MAX_LINKS_PER_WORKSPACE = 50;
const MAX_LINKS = 20_000;
const MAX_CLAIMS_PER_IP = 30;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const MAX_RATE_LIMIT_IPS = 10_000;
const ALLOWED_KINDS = new Set([...INSTALLABLE_HARNESSES, 'other']);
const ALLOWED_MEMORY = new Set(['read_write', 'read', 'none']);

const KIND_ALIASES = new Map([
  ['claude duet', 'claude-duet'],
  ['claude-duet', 'claude-duet'],
  ['meta muse', 'meta-muse'],
  ['meta-muse', 'meta-muse'],
  ['grok bot', 'grok-bot'],
  ['grok-bot', 'grok-bot'],
  ['openmausbot', 'openmausbot'],
  ['openbot', 'openbot'],
  ['claude', 'claude-code'],
  ['claude code', 'claude-code'],
  ['claude-code', 'claude-code'],
  ['claudecode', 'claude-code'],
  ['cursor', 'cursor'],
  ['codex', 'codex'],
  ['openai codex', 'codex'],
  ['gemini', 'gemini'],
  ['gemini cli', 'gemini'],
  ['gemini-cli', 'gemini'],
  ['antigravity', 'antigravity'],
  ['agy', 'antigravity'],
  ['pi', 'pi'],
  ['opencode', 'opencode'],
  ['muse', 'muse'],
  ['vscode', 'vscode'],
  ['vs code', 'vscode'],
  ['windsurf', 'windsurf'],
  ['zed', 'zed'],
  ['kimi', 'kimi'],
]);

function handoffError(message, status = 400, code = 'AGENT_HANDOFF_ERROR') {
  return Object.assign(new Error(message), { status, code, publicMessage: message });
}

function cleanText(raw, fallback = 'Agent', max = 80) {
  const clean = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return clean || fallback;
}

function randomFromAlphabet(alphabet, len) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function generateTicketId() {
  return randomFromAlphabet(ID_ALPHABET, 14);
}

function generateClaimCode() {
  const raw = randomFromAlphabet(CODE_ALPHABET, 12);
  return `LPAG-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export function normalizeClaimCode(raw) {
  const cleaned = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const stripped = cleaned.startsWith('LPAG') && cleaned.length === 16 ? cleaned.slice(4) : cleaned;
  if (stripped.length !== 12) return null;
  for (const ch of stripped) {
    if (!CODE_ALPHABET.includes(ch)) return null;
  }
  return `LPAG-${stripped.slice(0, 4)}-${stripped.slice(4, 8)}-${stripped.slice(8, 12)}`;
}

export function normalizeAgentKind(rawKind, fallbackName = '') {
  const k = String(rawKind || '').trim().toLowerCase();
  if (k && KIND_ALIASES.has(k)) return KIND_ALIASES.get(k);
  if (k && ALLOWED_KINDS.has(k)) return k;
  const n = String(fallbackName || '').trim().toLowerCase();
  if (n && KIND_ALIASES.has(n)) return KIND_ALIASES.get(n);
  for (const [alias, id] of KIND_ALIASES) {
    if (n.includes(alias)) return id;
  }
  return 'other';
}

function hashCode(code) {
  return createHash('sha256').update(String(code), 'utf8').digest('hex');
}

export function formatAgentHandoff(ticket, claimCode, origin) {
  const cleanOrigin = String(origin || '').replace(/\/+$/, '');
  const setupUrl = `${cleanOrigin}/a/${ticket.id}`;
  const claimUrl = `${cleanOrigin}/api/agent-handoff/claim`;
  const agentFlag = ticket.agentKind && ticket.agentKind !== 'other' ? ` --agents ${ticket.agentKind}` : '';
  const cliCommand = ticket.agentKind === 'other' || INSTALLABLE_HARNESSES.includes(ticket.agentKind)
    ? `curl -fsSL ${cleanOrigin}/connect.mjs | node - --claim ${claimCode}${agentFlag}` : null;
  const inviteUrl = HOST_KINDS.includes(ticket.agentKind) ? `${setupUrl}#${claimCode}` : null;
  const onePrompt = inviteUrl ? null :
    `Connect to my Loop workspace: fetch ${setupUrl} in full and follow it with claim code ${claimCode}` +
    (cliCommand ? ` (or run \`${cliCommand}\`).` : '.');
  return {
    id: ticket.id,
    name: ticket.name,
    agentKind: ticket.agentKind,
    profile: ticket.profile,
    canManage: ticket.canManage,
    memoryAccess: ticket.memoryAccess,
    expiresAt: new Date(ticket.expiresAt).toISOString(),
    expiresInSeconds: Math.max(0, Math.round((ticket.expiresAt - Date.now()) / 1000)),
    setupUrl,
    claimUrl,
    claimCode,
    ...(inviteUrl ? { inviteUrl } : {}),
    cliCommand,
    onePrompt,
  };
}

export class AgentHandoffStore {
  constructor({ ttlMs = AGENT_HANDOFF_TTL_MS, linkTtlMs = AGENT_LINK_TTL_MS, file = null } = {}) {
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : AGENT_HANDOFF_TTL_MS;
    this.linkTtlMs = Number.isFinite(linkTtlMs) && linkTtlMs > 0 ? linkTtlMs : AGENT_LINK_TTL_MS;
    this.byId = new Map();
    this.byHash = new Map();
    this._claimHits = new Map();
    this.file = file;
    this._writes = Promise.resolve();
    if (file) this._loadLinks();
  }

  // Links live 24 hours, so a restart must not end them. Only their hash is on disk.
  _loadLinks(now = Date.now()) {
    let saved;
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return;
    }
    for (const rec of Array.isArray(saved?.links) ? saved.links : []) {
      if (!rec?.agentId || !/^[0-9a-f]{64}$/.test(rec.claimCodeHash || '') || !(rec.expiresAt > now)) continue;
      this.byId.set(rec.id, rec);
      if (!rec.claimedAt) this.byHash.set(rec.claimCodeHash, rec);
    }
  }

  _saveLinks() {
    if (!this.file) return;
    this._writes = this._writes
      .then(() => {
        const links = [...this.byId.values()].filter((rec) => rec.agentId);
        return atomicWriteFile(this.file, JSON.stringify({ links }, null, 2) + '\n', { mode: 0o600, backup: false });
      })
      .catch(() => {});
  }

  async flush() {
    await this._writes;
  }

  _prune(now = Date.now()) {
    for (const [id, rec] of this.byId) {
      if (rec.expiresAt <= now) {
        this.byId.delete(id);
        this.byHash.delete(rec.claimCodeHash);
      }
    }
  }

  _consumeIpRateLimit(clientIp, now = Date.now()) {
    if (typeof clientIp !== 'string' || !clientIp.trim()) return true;
    const ip = clientIp.trim();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    const prev = this._claimHits.get(ip);
    const hits = prev ? prev.filter((ts) => ts > cutoff) : [];
    if (hits.length >= MAX_CLAIMS_PER_IP) {
      this._claimHits.set(ip, hits);
      return false;
    }
    if (!this._claimHits.has(ip) && this._claimHits.size >= MAX_RATE_LIMIT_IPS) {
      const oldest = this._claimHits.keys().next().value;
      if (oldest !== undefined) this._claimHits.delete(oldest);
    }
    hits.push(now);
    this._claimHits.set(ip, hits);
    return true;
  }

  create({
    workspaceId = null,
    name = 'Agent',
    agentKind = '',
    profile = 'all',
    canManage = false,
    memoryAccess = 'read_write',
    createdBy = 'Owner',
    agentId = null,
    from = '',
    origin = 'https://useloop.sh',
    now = Date.now(),
  } = {}) {
    this._prune(now);
    const links = [...this.byId.values()].filter((rec) => rec.agentId);
    if (agentId) {
      this.revokeLink(workspaceId, agentId);
      const own = links.filter((rec) => rec.workspaceId === (workspaceId ? String(workspaceId) : null) && rec.agentId !== agentId);
      if (own.length >= MAX_LINKS_PER_WORKSPACE || links.length >= MAX_LINKS) {
        throw handoffError('Too many open agent links. Wait until some of them end.', 429, 'TOO_MANY_HANDOFFS');
      }
    } else if (this.byId.size - links.length >= MAX_ACTIVE_TICKETS) {
      throw handoffError('Too many pending agent connect codes. Wait a few minutes and try again.', 429, 'TOO_MANY_HANDOFFS');
    }

    const cleanName = cleanText(name, 'Agent', 80);
    const resolvedKind = normalizeAgentKind(agentKind, cleanName);
    const cleanProfile = normalizeProfileTag(profile) || 'all';
    const cleanMemory = ALLOWED_MEMORY.has(memoryAccess) ? memoryAccess : 'read_write';

    let id = generateTicketId();
    while (this.byId.has(id)) id = generateTicketId();
    const claimCode = generateClaimCode();
    const claimCodeHash = hashCode(claimCode);

    const ticket = {
      id,
      claimCodeHash,
      workspaceId: workspaceId ? String(workspaceId) : null,
      name: cleanName,
      agentKind: resolvedKind,
      profile: cleanProfile,
      canManage: canManage === true,
      memoryAccess: cleanMemory,
      createdBy: cleanText(createdBy, 'Owner', 80),
      createdAt: now,
      expiresAt: now + (agentId ? this.linkTtlMs : this.ttlMs),
      claimedAt: null,
      claimedAgentId: null,
      ...(agentId ? { agentId: String(agentId), from: cleanText(from, '', 60) } : {}),
    };

    this.byId.set(id, ticket);
    this.byHash.set(claimCodeHash, ticket);
    if (agentId) this._saveLinks();
    return formatAgentHandoff(ticket, claimCode, origin);
  }

  /** Ends the open link of one agent. True when there was one. */
  revokeLink(workspaceId, agentId) {
    const ws = workspaceId ? String(workspaceId) : null;
    let ended = false;
    for (const [id, rec] of this.byId) {
      if (rec.agentId !== agentId || rec.workspaceId !== ws) continue;
      this.byId.delete(id);
      this.byHash.delete(rec.claimCodeHash);
      ended = true;
    }
    if (ended) this._saveLinks();
    return ended;
  }

  /** The link that this id and code belong to, without using it up. Wrong codes count against the address. */
  peekLink({ id = '', claimCode = '', clientIp = '', now = Date.now() } = {}) {
    this._prune(now);
    const rec = this.byId.get(String(id || '').trim().toLowerCase()) || null;
    const normalized = normalizeClaimCode(claimCode);
    const given = Buffer.from(hashCode(normalized || ''), 'hex');
    const known = rec && (rec.agentId || HOST_KINDS.includes(rec.agentKind)) ? Buffer.from(rec.claimCodeHash, 'hex') : null;
    if (known && normalized && known.length === given.length && timingSafeEqual(known, given)) {
      return {
        id: rec.id,
        workspaceId: rec.workspaceId,
        agentId: rec.agentId || rec.claimedAgentId || null,
        pendingAgent: !rec.agentId && !rec.claimedAgentId ? {
          name: rec.name, kind: rec.agentKind, profile: rec.profile,
          canManage: rec.canManage, memoryAccess: rec.memoryAccess, secrets: [],
        } : null,
        from: rec.from || rec.createdBy || '',
        expiresAt: new Date(rec.expiresAt).toISOString(),
        claimed: Boolean(rec.claimedAt),
        claimedAt: rec.claimedAt,
      };
    }
    if (!this._consumeIpRateLimit(clientIp, now)) {
      throw handoffError('Too many attempts. Wait a few minutes and try again.', 429, 'RATE_LIMITED');
    }
    throw handoffError('This link has ended. Ask for a new one.', 404, 'HANDOFF_NOT_FOUND');
  }

  recordClaimedAgent(id, agentId) {
    const rec = this.byId.get(id);
    if (rec?.claimedAt && !rec.agentId) rec.claimedAgentId = agentId;
  }

  getPublic(id, now = Date.now()) {
    this._prune(now);
    const cleanId = String(id || '').trim().toLowerCase();
    if (!/^[a-z0-9]{10,24}$/.test(cleanId)) return null;
    const rec = this.byId.get(cleanId);
    if (!rec) return null;
    return {
      id: rec.id,
      name: rec.name,
      agentKind: rec.agentKind,
      profile: rec.profile,
      canManage: rec.canManage,
      memoryAccess: rec.memoryAccess,
      expiresAt: new Date(rec.expiresAt).toISOString(),
      expiresInSeconds: Math.max(0, Math.round((rec.expiresAt - now) / 1000)),
      claimed: Boolean(rec.claimedAt),
    };
  }

  renderSetupMarkdown(id, origin, now = Date.now()) {
    const pub = this.getPublic(id, now);
    if (!pub) return null;
    const cleanOrigin = String(origin || '').replace(/\/+$/, '');
    const agentFlag = pub.agentKind && pub.agentKind !== 'other' ? ` --agents ${pub.agentKind}` : '';
    const scopeLine = this.byId.get(pub.id)?.agentId
      ? 'what the owner shared with it'
      : pub.profile === 'all' ? 'full workspace' : `project "${pub.profile}"`;
    return [
      `# Connect ${pub.name} to Loop`,
      '',
      pub.claimed
        ? 'This one-time connect link has already been used. Ask the owner for a fresh invite if you still need to connect.'
        : `This is a single-use Loop agent connect link (${scopeLine}, valid for ${pub.expiresInSeconds}s). You also need the claim code (\`LPAG-...\`): the user gave it to you, or it is the part of the link after \`#\`.`,
      '',
      ...(pub.agentKind === 'other' || INSTALLABLE_HARNESSES.includes(pub.agentKind) ? [
      '## Automatic CLI setup (for a local agent)',
      '',
      'Run this command with the user\'s claim code:',
      '```bash',
      `curl -fsSL ${cleanOrigin}/connect.mjs | node - --claim <CLAIM_CODE>${agentFlag}`,
      '```',
      'This exchanges the single-use code for your scoped Loop token and writes your MCP config automatically.',
      '',
      ] : []),
      '## Direct API claim',
      '',
      `1. POST JSON to \`${cleanOrigin}/api/agent-handoff/claim\`:`,
      '```json',
      JSON.stringify({ id: pub.id, claimCode: '<CLAIM_CODE>', agentName: pub.name }, null, 2),
      '```',
      '2. Read `mcp_url` and `access_token` from the JSON response. Never print `access_token` back to the user.',
      '3. Register `mcp_url` as a Streamable HTTP MCP server named `loop` with header `Authorization: Bearer <access_token>`.',
      '4. Verify the connection by calling `loop__search({ type: "connections" })` and `loop__search({ type: "tasks", assignedTo: "me" })`.',
      '',
      '## Working with Loop',
      '- Use `loop__search`, `loop__inspect`, `loop__run`, and (when allowed) `loop__save`.',
      '- Check assigned tasks with `loop__search({ type: "tasks", assignedTo: "me" })` and mark them `completed` with a concise `result` when done so Loop notifies the owner.',
      '',
    ].join('\n');
  }

  claim({ id = '', claimCode = '', agentName = '', clientId = '', clientIp = '', now = Date.now() } = {}) {
    this._prune(now);
    if (!this._consumeIpRateLimit(clientIp, now)) {
      throw handoffError('Too many claim attempts. Wait a few minutes and try again.', 429, 'RATE_LIMITED');
    }
    const normalized = normalizeClaimCode(claimCode);
    if (!normalized) {
      throw handoffError('Invalid or malformed claim code.', 400, 'INVALID_CLAIM_CODE');
    }
    const givenHash = hashCode(normalized);
    const cleanId = String(id || '').trim().toLowerCase();
    const rec = cleanId ? this.byId.get(cleanId) : this.byHash.get(givenHash);
    if (!rec) {
      throw handoffError('This connect code is invalid or expired. Ask the owner for a fresh one.', 404, 'HANDOFF_NOT_FOUND');
    }
    const expectedBuf = Buffer.from(rec.claimCodeHash, 'hex');
    const givenBuf = Buffer.from(givenHash, 'hex');
    if (expectedBuf.length !== givenBuf.length || !timingSafeEqual(expectedBuf, givenBuf)) {
      throw handoffError('This connect code is invalid or expired. Ask the owner for a fresh one.', 404, 'HANDOFF_NOT_FOUND');
    }
    if (rec.expiresAt <= now) {
      this.byId.delete(rec.id);
      this.byHash.delete(rec.claimCodeHash);
      throw handoffError('This connect code has expired. Ask the owner for a fresh one.', 410, 'HANDOFF_EXPIRED');
    }
    if (rec.claimedAt) {
      throw handoffError('This connect code was already used. Ask the owner for a fresh one.', 409, 'HANDOFF_ALREADY_CLAIMED');
    }

    // Burn atomically before returning so concurrent calls can never mint a second token.
    rec.claimedAt = now;
    this.byHash.delete(rec.claimCodeHash);
    if (rec.agentId) this._saveLinks();

    // An agent that the owner made keeps the name that the owner gave it.
    const finalName = rec.agentId ? rec.name : cleanText(agentName, rec.name, 80);
    const finalKind = clientId ? normalizeAgentKind(clientId, finalName) : rec.agentKind;
    return {
      id: rec.id,
      ...(rec.agentId ? { agentId: rec.agentId } : {}),
      workspaceId: rec.workspaceId,
      name: finalName,
      agentKind: finalKind,
      profile: rec.profile,
      canManage: rec.canManage,
      memoryAccess: rec.memoryAccess,
      createdBy: rec.createdBy,
    };
  }
}
