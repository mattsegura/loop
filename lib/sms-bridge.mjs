// Server-to-server bridge for loop-text (the iMessage agent service). With an agent's own
// Loop key plus the shared LOOP_TEXT_INTERNAL_SECRET, loop-text can settle that agent's
// pending approvals when the owner answers by text, and keep site logins in the Vault,
// bound to the one https origin they belong to. Browsers never reach these routes.

import { createHash, timingSafeEqual } from 'node:crypto';
import { itemEditableInProfile, itemMatchesProfile, normalizeConnectionProfiles, normalizeProfileTag } from './profiles.mjs';
import { isInternalVaultKey } from './secret-refs.mjs';
import { normalizeAllowedSinkEntry } from './sink.mjs';
import { resolveSpecDecisionOption, sanitizeSpecValues } from './json-render-ui.mjs';
import { canAlwaysAllow, ownActionRule, vaultItemMode } from './policies.mjs';

export const SMS_BRIDGE_PREFIX = '/api/sms-bridge';

const MAX_USERNAME = 320;
const MAX_LABEL = 200;
const MAX_PASSWORD = 4096;
const OWNER_BY_TEXT = 'Owner (text)';
const OWNER_BY_TEXT_LINK = 'Owner (text link)';
const MAX_EXTRA_ORIGINS = 10;
// Vault groups by free-text category; logins saved by text show under one group.
const LOGIN_CATEGORY = 'Websites';

export function isSmsBridgePath(pathname) {
  return pathname === SMS_BRIDGE_PREFIX || String(pathname || '').startsWith(`${SMS_BRIDGE_PREFIX}/`);
}

// Constant-time, and the digests keep the secret's length from showing either.
export function smsBridgeSecretMatches(expected, given) {
  if (typeof expected !== 'string' || !expected || typeof given !== 'string' || !given) return false;
  const a = createHash('sha256').update(expected, 'utf8').digest();
  const b = createHash('sha256').update(given, 'utf8').digest();
  return timingSafeEqual(a, b);
}

// Only browsers send these; a server calling the bridge never does.
export function isBrowserRequest(req) {
  const h = req?.headers || {};
  return h.origin !== undefined || h['sec-fetch-site'] !== undefined || h['sec-fetch-mode'] !== undefined;
}

// "https://Example.com:443/login?x" -> "https://example.com". Anything not https is refused.
export function normalizeLoginOrigin(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return null;
  const parsed = URL.parse(raw.trim());
  if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return null;
  return parsed.origin.toLowerCase();
}

// A login holds only the password; its username sits in the item's metadata. Older bridge
// logins held {"username","password"} as JSON, which still reads.
function readLoginValue(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.password === 'string') {
      return { username: typeof parsed.username === 'string' ? parsed.username : '', password: parsed.password };
    }
  } catch {
    // Not JSON: the whole value is the password.
  }
  return { username: '', password: typeof raw === 'string' ? raw : '' };
}

function loginKeyFor(origin, username, taken) {
  const host = new URL(origin).host.replace(/[^A-Za-z0-9.-]/g, '_').slice(0, 80);
  const digest = createHash('sha256').update(`${origin}\n${username}`, 'utf8').digest('hex').slice(0, 8);
  const base = `login.${host}.${digest}`;
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}-${n}`;
  return key;
}

function optionalText(value, max) {
  if (value === undefined || value === null) return { ok: true, value: '' };
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return { ok: false };
  return { ok: true, value: value.trim() };
}

function agentProfile(agent) {
  return normalizeProfileTag(agent?.profile) || 'all';
}

// Login items this agent can see in its profile that are bound to exactly this origin.
async function loginsBoundTo(vault, agent, origin) {
  const sink = normalizeAllowedSinkEntry(origin);
  const items = await vault.list({ profile: agentProfile(agent) });
  return items.filter((m) => m.type === 'login' && m.allowedSinks.includes(sink));
}

async function readLogin(vault, key, meta = null) {
  try {
    const raw = await vault.get(key);
    if (raw === null) return null;
    const login = readLoginValue(raw);
    return meta?.username ? { ...login, username: meta.username } : login;
  } catch {
    return null;
  }
}

const OWNER_TEXT_BRIDGE_KINDS = new Set(['imessage', 'telegram', 'slack']);

// Owner-text bridge agents (iMessage, Telegram, Slack) can list and settle any Agent's
// Ask approval in this workspace by text. Guard approvals still require the Owner's Loop password.
export function isOwnerTextBridgeAgent(agent) {
  if (!agent) return false;
  return OWNER_TEXT_BRIDGE_KINDS.has(String(agent.kind || '').toLowerCase()) || agent.id === 'loop_text_imessage';
}

function canBridgeApproval(agent, approval) {
  if (!agent || !approval) return false;
  return approval.agentId === agent.id || isOwnerTextBridgeAgent(agent);
}

async function listApprovals({ res, agent, ctx, sendJson }) {
  const all = typeof ctx.approvalQueue?.listPending === 'function' ? ctx.approvalQueue.listPending() : [];
  const pending = isOwnerTextBridgeAgent(agent) ? all : all.filter((a) => a.agentId === agent.id);
  return sendJson(res, 200, {
    ok: true,
    crossAgent: isOwnerTextBridgeAgent(agent),
    pending: pending.map((a) => ({
      id: a.id,
      kind: a.kind,
      mode: a.mode || 'always_ask',
      guard: a.mode === 'guard',
      agentId: a.agentId,
      agentName: a.agentName,
      target: a.target,
      summary: a.summary,
      status: a.status,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
    })),
  });
}

async function inspectApproval({ res, agent, ctx, approvalId, sendJson }) {
  const current = ctx.approvalQueue.get(approvalId);
  if (!current || !canBridgeApproval(agent, current)) return sendJson(res, 404, { error: 'not_found' });
  return sendJson(res, 200, { ok: true, approval: current });
}

async function decide({ res, agent, ctx, body, approvalId, sendJson }) {
  // Non-bridge agents only see their own approvals; owner-text bridges can settle any Ask approval
  // in the workspace (Guard still requires the Owner's password in the Loop web dashboard).
  const current = ctx.approvalQueue.get(approvalId);
  if (!current || !canBridgeApproval(agent, current)) {
    const rawDecision = body?.decision;
    if (rawDecision !== 'approve' && rawDecision !== 'deny' && !body?.optionId) {
      return sendJson(res, 400, { error: 'invalid_decision' });
    }
    return sendJson(res, 404, { error: 'not_found' });
  }
  const opt = current.uiSpec
    ? resolveSpecDecisionOption(current.uiSpec, {
        optionId: body?.optionId || '',
        decision: body?.decision || '',
        alwaysAllow: body?.alwaysAllow ?? null,
      })
    : null;
  const decision = opt?.decision || body?.decision;
  if (decision !== 'approve' && decision !== 'deny') return sendJson(res, 400, { error: 'invalid_decision' });
  if (current.status !== 'pending') return sendJson(res, 409, { error: 'already_decided', status: current.status });
  const values = current.uiSpec ? sanitizeSpecValues(current.uiSpec, body?.values) : {};
  const resolution = (opt?.optionId || Object.keys(values).length > 0)
    ? {
        ...(opt?.optionId ? { optionId: opt.optionId } : {}),
        ...(Object.keys(values).length > 0 ? { values } : {}),
      }
    : null;
  const outcome = decision === 'approve'
    ? ctx.approvalQueue.approve(approvalId, resolution)
    : ctx.approvalQueue.deny(approvalId, resolution);
  if (!outcome.ok) {
    if (outcome.status === 404) return sendJson(res, 404, { error: 'not_found' });
    // A text or a tapped link is no Loop password: the owner confirms this one in Loop.
    if (outcome.reason === 'guard') return sendJson(res, 403, { error: 'guard', message: outcome.error });
    return sendJson(res, 409, { error: 'already_decided', status: outcome.approval?.status || outcome.reason });
  }
  const actorName = body?.source === 'link' ? OWNER_BY_TEXT_LINK : OWNER_BY_TEXT;
  ctx.activity.record({
    agentId: null,
    agentName: actorName,
    method: decision === 'approve' ? 'approval/approve' : 'approval/deny',
    target: `${outcome.approval.target} (${approvalId})`,
    ok: true,
  });
  // Explicit policy choices are allowed only when selected on the verified gateway approval link.
  if (body?.source === 'link' && decision === 'approve' && opt?.alwaysAllow && ctx.policyStore && canAlwaysAllow(outcome.approval)) {
    // It never takes anything off Guard: the one request runs, the rule stays.
    const keepRule = (patch) => ctx.policyStore.update(patch).then(() => true, (err) => {
      if (err?.code === 'guard_password') return false;
      throw err;
    });
    const detail = outcome.approval.detail && typeof outcome.approval.detail === 'object' ? outcome.approval.detail : {};
    const connId = typeof detail.connectionId === 'string' ? detail.connectionId : '';
    if (opt.alwaysAllow === 'connection' && outcome.approval.kind === 'run' && connId && String(detail.rule || '').startsWith('toolKind:') && await keepRule({ connections: { [connId]: 'auto' } })) {
      ctx.activity.record({ agentId: null, agentName: actorName, method: 'approval/always-allow', target: `${connId}__* (${approvalId})`, ok: true });
      ctx.broadcast?.('policies');
    } else if (opt.alwaysAllow === 'tool' && outcome.approval.kind === 'run' && typeof outcome.approval.target === 'string' && outcome.approval.target.includes('__') && await keepRule({ tools: { [outcome.approval.target]: 'auto' } })) {
      ctx.activity.record({ agentId: null, agentName: actorName, method: 'approval/always-allow', target: `${outcome.approval.target} (${approvalId})`, ok: true });
      ctx.broadcast?.('policies');
    }
  }
  return sendJson(res, 200, { ok: true, status: outcome.approval.status });
}

// The login's own origin first, then up to ten more sites it also works on, without repeats.
function loginOrigins(body) {
  const origin = normalizeLoginOrigin(body?.origin);
  const extra = body?.origins === undefined || body?.origins === null ? [] : body.origins;
  if (!origin || !Array.isArray(extra) || extra.length > MAX_EXTRA_ORIGINS) return null;
  const all = [origin];
  for (const raw of extra) {
    const next = normalizeLoginOrigin(raw);
    if (!next) return null;
    if (!all.includes(next)) all.push(next);
  }
  return all;
}

async function saveLogin({ res, agent, ctx, body, sendJson }) {
  const origins = loginOrigins(body);
  if (!origins) return sendJson(res, 400, { error: 'invalid_origin' });
  const [origin] = origins;
  const allowedSinks = origins.map((o) => normalizeAllowedSinkEntry(o));
  const password = body?.password;
  if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD) {
    return sendJson(res, 400, { error: 'invalid_password' });
  }
  const username = optionalText(body?.username, MAX_USERNAME);
  if (!username.ok) return sendJson(res, 400, { error: 'invalid_username' });
  const label = optionalText(body?.label, MAX_LABEL);
  if (!label.ok) return sendJson(res, 400, { error: 'invalid_label' });

  const policies = await ctx.policyStore.get();
  if (ownActionRule(policies, 'save')?.decision === 'always_ask') return sendJson(res, 403, { error: 'needs_approval' });

  const { vault, store } = ctx;
  const profile = agentProfile(agent);
  const value = password;
  let existing = null;
  for (const meta of await loginsBoundTo(vault, agent, origin)) {
    const login = meta.username ? { username: meta.username } : await readLogin(vault, meta.key);
    if (login && login.username === username.value) {
      existing = meta;
      break;
    }
  }

  let key;
  if (existing) {
    // Same site and username: a new password, not a second login. Like loop__save, an agent
    // may only overwrite a login that is already shared with it.
    if (!agent.secrets.includes(existing.key) || !itemEditableInProfile(existing, profile)) {
      return sendJson(res, 409, { error: 'exists_not_shared' });
    }
    key = existing.key;
    await vault.set(key, value, { allowedSinks, username: username.value, ...(label.value ? { description: label.value } : {}) });
  } else {
    const taken = new Set((await vault.list({ includeInternal: true })).map((m) => m.key));
    key = loginKeyFor(origin, username.value, taken);
    await vault.set(key, value, {
      type: 'login',
      description: label.value || `Login for ${new URL(origin).host}`,
      category: LOGIN_CATEGORY,
      username: username.value,
      // The owner typed this login into Loop's own page for these sites, so filling it there
      // needs no second OK, unless logins are on Guard. It stays bound to these https origins only.
      approval: savedLoginApproval(policies),
      allowedSinks,
      ...(profile !== 'all' ? { profiles: [profile] } : {}),
    });
    try {
      await store.grantAgentSecret(agent.id, key);
    } catch (err) {
      await vault.delete(key).catch(() => {});
      if (err?.status === 409) return sendJson(res, 409, { error: 'too_many_secrets' });
      throw err;
    }
    ctx.broadcast?.('agents');
  }
  ctx.activity.record({
    agentId: agent.id,
    agentName: agent.name,
    method: 'secret/save',
    target: `${key} → ${origins.join(', ')}`,
    ok: true,
  });
  return sendJson(res, 200, { ok: true, key, origin, username: username.value || null });
}

async function listLogins({ res, agent, ctx, url, sendJson }) {
  const origin = normalizeLoginOrigin(url.searchParams.get('origin'));
  if (!origin) return sendJson(res, 400, { error: 'invalid_origin' });
  const logins = [];
  for (const meta of await loginsBoundTo(ctx.vault, agent, origin)) {
    if (!agent.secrets.includes(meta.key)) continue;
    const login = meta.username ? { username: meta.username } : await readLogin(ctx.vault, meta.key);
    if (!login) continue;
    logins.push({ key: meta.key, label: meta.description, username: login.username || null, origin });
  }
  return sendJson(res, 200, { logins });
}

async function revealLogin({ res, agent, ctx, body, sendJson }) {
  const origin = normalizeLoginOrigin(body?.origin);
  if (!origin) return sendJson(res, 400, { error: 'invalid_origin' });
  const key = typeof body?.key === 'string' ? body.key : '';
  const meta = key && !isInternalVaultKey(key) ? await ctx.vault.getMeta(key) : null;
  if (
    !meta ||
    meta.type !== 'login' ||
    !agent.secrets.includes(key) ||
    !itemMatchesProfile(meta, agentProfile(agent))
  ) {
    return sendJson(res, 404, { error: 'not_found' });
  }
  const used = (ok, error) =>
    ctx.activity.record({
      agentId: agent.id,
      agentName: agent.name,
      method: 'secret/use',
      target: `${key} → ${origin}`,
      ok,
      ...(error ? { error } : {}),
    });
  if (!meta.allowedSinks.includes(normalizeAllowedSinkEntry(origin))) {
    used(false, 'sink_mismatch');
    return sendJson(res, 403, { error: 'origin_mismatch' });
  }
  // Item rule first, then the login type's rule, then the default (the rules on the Vault page).
  const rule = await ctx.policyStore.evaluateAction({ vaultType: meta.type, itemApproval: meta.approval });
  if (rule.decision === 'always_ask') {
    used(false, 'needs_approval');
    return sendJson(res, 403, { error: 'needs_approval' });
  }
  const login = await readLogin(ctx.vault, key, meta);
  if (!login) return sendJson(res, 404, { error: 'not_found' });
  used(true);
  return sendJson(res, 200, { username: login.username || null, password: login.password });
}

/** A login the owner saved for its own sites fills there without a question. Guard stays Guard. */
function savedLoginApproval(policies, existing = null) {
  if (vaultItemMode(policies, existing || { type: 'login', approval: 'inherit' }) !== 'guard') return 'auto';
  return existing?.approval || 'inherit';
}

// Owner-facing helper for saving a website/account login into Vault (identical format to the
// SMS bridge so both Loop Text and MCP agents can discover and use it when granted).
export async function saveOwnerLogin({
  vault,
  store,
  policyStore = null,
  origin: rawOrigin,
  origins: extraOrigins,
  username: rawUsername = '',
  password,
  label: rawLabel = '',
  profiles: rawProfiles = ['all'],
  agentIds = undefined,
} = {}) {
  const origins = loginOrigins({ origin: rawOrigin, origins: extraOrigins });
  if (!origins) throw Object.assign(new Error('Enter a valid https:// sign-in address.'), { status: 400 });
  const [origin] = origins;
  const allowedSinks = origins.map((o) => normalizeAllowedSinkEntry(o));
  if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD) {
    throw Object.assign(new Error('Password is required.'), { status: 400 });
  }
  const username = optionalText(rawUsername, MAX_USERNAME);
  if (!username.ok) throw Object.assign(new Error('Enter a valid email or username.'), { status: 400 });
  const label = optionalText(rawLabel, MAX_LABEL);
  if (!label.ok) throw Object.assign(new Error('Label contains invalid characters.'), { status: 400 });

  const profiles = normalizeConnectionProfiles(rawProfiles);
  const allItems = await vault.list();
  const sink = normalizeAllowedSinkEntry(origin);
  let existing = null;
  for (const meta of allItems) {
    if (meta.type !== 'login' || !meta.allowedSinks.includes(sink)) continue;
    const login = meta.username ? { username: meta.username } : await readLogin(vault, meta.key);
    if (login && login.username === username.value) {
      existing = meta;
      break;
    }
  }

  const finalLabel = label.value || `Login for ${new URL(origin).host}`;
  const policies = policyStore ? await policyStore.get() : null;
  let key;
  if (existing) {
    key = existing.key;
    const mergedSinks = [...new Set([...existing.allowedSinks, ...allowedSinks])];
    await vault.set(key, password, {
      type: 'login',
      allowedSinks: mergedSinks,
      username: username.value,
      approval: savedLoginApproval(policies, existing),
      ...(label.value ? { description: label.value } : {}),
      ...(!profiles.includes('all') ? { profiles } : {}),
    });
  } else {
    const taken = new Set((await vault.list({ includeInternal: true })).map((m) => m.key));
    key = loginKeyFor(origin, username.value, taken);
    await vault.set(key, password, {
      type: 'login',
      description: finalLabel,
      category: LOGIN_CATEGORY,
      username: username.value,
      approval: savedLoginApproval(policies),
      allowedSinks,
      ...(!profiles.includes('all') ? { profiles } : {}),
    });
  }

  const allAgents = store && typeof store.listAgents === 'function' ? await store.listAgents() : [];
  let targetAgents;
  if (Array.isArray(agentIds)) {
    const wanted = new Set(agentIds.map((x) => String(x || '').trim()).filter(Boolean));
    targetAgents = allAgents.filter((a) => a.enabled !== false && wanted.has(a.id));
  } else {
    targetAgents = allAgents.filter((a) => {
      if (a.enabled === false) return false;
      if (profiles.includes('all')) return true;
      const ap = normalizeProfileTag(a.profile) || 'all';
      return ap === 'all' || profiles.includes(ap);
    });
  }

  const sharedWith = [];
  for (const agent of targetAgents) {
    try {
      await store.grantAgentSecret(agent.id, key);
      sharedWith.push({ id: agent.id, name: agent.name });
    } catch (err) {
      if (err?.status !== 409) throw err;
    }
  }

  return {
    key,
    origin,
    origins,
    username: username.value || null,
    label: finalLabel,
    sharedWith,
  };
}

async function ingestEvent({ res, agent, ctx, body, sendJson }) {
  const type = typeof body?.type === 'string' ? body.type.trim().toLowerCase() : '';
  if (typeof body?.tz === 'string') await ctx.ownerTimezone?.record(body.tz).catch(() => {});
  if (type === 'inbound') return sendJson(res, 200, { ok: true, ignored: true }); // older Loop Text
  if (type === 'turn') {
    const rawTurn = body?.turn && typeof body.turn === 'object' ? body.turn : body;
    const saved = ctx.historyStore
      ? await ctx.historyStore.append({
          ...rawTurn,
          channel: rawTurn?.channel || 'imessage',
          agentId: agent.id,
          agentName: agent.name,
        })
      : null;
    let dreamResult = null;
    if (saved && body?.triggerDream !== false && ctx.dreamStore) {
      const work = ctx.dreamStore.onTurnCompleted({
        tz: typeof body?.tz === 'string' && body.tz.trim() ? body.tz.trim() : undefined,
      });
      if (body?.waitForDream === true) dreamResult = await work.catch(() => null);
      else void work.catch(() => {});
    }
    return sendJson(res, 200, { ok: true, saved: Boolean(saved), turn: saved, ...(dreamResult ? { dream: dreamResult } : {}) });
  }
  if (type === 'compaction') {
    if (!ctx.dreamStore) return sendJson(res, 200, { ok: true, ignored: true });
    const turnsOverride = Array.isArray(body?.turns) ? body.turns : null;
    const work = ctx.dreamStore.onCompaction({
      turnsOverride,
      tz: typeof body?.tz === 'string' && body.tz.trim() ? body.tz.trim() : undefined,
    });
    const dreamResult = body?.waitForDream === true ? await work.catch(() => null) : null;
    if (body?.waitForDream !== true) void work.catch(() => {});
    return sendJson(res, 200, { ok: true, ...(dreamResult ? { dream: dreamResult } : {}) });
  }
  return sendJson(res, 400, { error: 'invalid_event_type' });
}

async function bridgeDream({ req, res, agent, ctx, body, sendJson }) {
  if (!ctx.dreamStore) return sendJson(res, 503, { error: 'dream_unavailable' });
  if (req.method === 'GET') {
    const [dream, statusText] = await Promise.all([
      ctx.dreamStore.summary(),
      ctx.dreamStore.formatStatusText(),
    ]);
    return sendJson(res, 200, { ok: true, dream, statusText });
  }
  const action = typeof body?.action === 'string' ? body.action.trim().toLowerCase() : 'config';
  const profile = agentProfile(agent);
  try {
    if (action === 'config') {
      const dream = await ctx.dreamStore.setConfig({
        ...(typeof body?.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(body?.triggerMode !== undefined ? { triggerMode: body.triggerMode } : {}),
        ...(body?.stepInterval !== undefined ? { stepInterval: body.stepInterval } : {}),
        ...(typeof body?.reviewBeforeApply === 'boolean' ? { reviewBeforeApply: body.reviewBeforeApply } : {}),
        ...(body?.applyMode !== undefined ? { applyMode: body.applyMode } : {}),
      });
      const statusText = await ctx.dreamStore.formatStatusText();
      return sendJson(res, 200, { ok: true, dream, statusText });
    }
    if (action === 'run') {
      const result = await ctx.dreamStore.run({
        trigger: typeof body?.trigger === 'string' ? body.trigger : 'manual',
        dryRun: Boolean(body?.dryRun),
        force: Boolean(body?.force),
        profile,
      });
      return sendJson(res, 200, result);
    }
    if (action === 'approve' || action === 'dismiss') {
      const result = await ctx.dreamStore.resolveProposal({
        id: typeof body?.id === 'string' ? body.id.trim() : '',
        decision: action,
        all: Boolean(body?.all),
        actor: 'owner',
        writtenBy: OWNER_BY_TEXT,
        profile,
        allowSkills: true,
      });
      if (result.applied > 0) ctx.broadcast?.('memory');
      return sendJson(res, 200, result);
    }
    if (action === 'doctor') {
      const report = await ctx.dreamStore.doctor({
        symptom: typeof body?.symptom === 'string' ? body.symptom.trim().slice(0, 200) : '',
        profile,
      });
      return sendJson(res, 200, report);
    }
    if (action === 'remember') {
      const result = await ctx.dreamStore.remember({
        text: body?.text,
        actor: 'owner',
        writtenBy: OWNER_BY_TEXT,
        profile,
      });
      ctx.broadcast?.('memory');
      return sendJson(res, 200, result);
    }
    return sendJson(res, 400, { error: 'invalid_dream_action' });
  } catch (err) {
    return sendJson(res, err?.status || 400, { error: err?.message || 'dream_action_failed' });
  }
}

// `agent` is already proven by its key and the shared secret (see server.mjs).
export async function handleSmsBridge({ req, res, url, pathname, agent, ctx, readJsonBody, sendJson }) {
  const route = pathname.slice(SMS_BRIDGE_PREFIX.length);
  const decideMatch = /^\/approvals\/([^/]+)\/decide$/.exec(route);
  const inspectApprovalMatch = !decideMatch ? /^\/approvals\/([^/]+)$/.exec(route) : null;
  const listApprovalsRoute = route === '/approvals';
  const known =
    decideMatch ||
    inspectApprovalMatch ||
    listApprovalsRoute ||
    route === '/vault/logins' ||
    route === '/vault/reveal' ||
    route === '/events' ||
    route === '/dream';
  if (!known) return sendJson(res, 404, { error: 'not_found' });

  const allowed = inspectApprovalMatch || listApprovalsRoute
    ? ['GET']
    : route === '/vault/logins' || route === '/dream'
      ? ['GET', 'POST']
      : ['POST'];
  if (!allowed.includes(req.method)) {
    return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: allowed.join(', ') });
  }
  if (req.method === 'GET') {
    if (listApprovalsRoute) {
      return listApprovals({ res, agent, ctx, sendJson });
    }
    if (inspectApprovalMatch) {
      let approvalId;
      try {
        approvalId = decodeURIComponent(inspectApprovalMatch[1]);
      } catch {
        return sendJson(res, 404, { error: 'not_found' });
      }
      return inspectApproval({ res, agent, ctx, approvalId, sendJson });
    }
    if (route === '/dream') return bridgeDream({ req, res, agent, ctx, body: null, sendJson });
    return listLogins({ res, agent, ctx, url, sendJson });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err?.code === 'BODY_TOO_LARGE') return sendJson(res, 413, { error: 'body_too_large' }, { Connection: 'close' });
    return sendJson(res, 400, { error: 'invalid_json' });
  }
  if (decideMatch) {
    let approvalId;
    try {
      approvalId = decodeURIComponent(decideMatch[1]);
    } catch {
      return sendJson(res, 404, { error: 'not_found' });
    }
    return decide({ res, agent, ctx, body, approvalId, sendJson });
  }
  if (route === '/vault/logins') return saveLogin({ res, agent, ctx, body, sendJson });
  if (route === '/events') return ingestEvent({ res, agent, ctx, body, sendJson });
  if (route === '/dream') return bridgeDream({ req, res, agent, ctx, body, sendJson });
  return revealLogin({ res, agent, ctx, body, sendJson });
}
