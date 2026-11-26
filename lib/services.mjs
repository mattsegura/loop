// Service grouping, multi-account selection, and Access Sets (v3 hybrid contract).
// A Project organizes items; an Access Set and accountChoice limit what an Agent can run.

import path from 'node:path';
import { toolKindOf } from './policies.mjs';
import { connectionReadiness } from './connection-readiness.mjs';

export const BUILTIN_ACCESS_SET_IDS = Object.freeze(['everything', 'read-only']);
export const AGENT_APPROVAL_MODES = Object.freeze(['ask', 'allow', 'guard']);
const ACCESS_SET_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,46}[a-z0-9])?$/;
const MAX_ACCESS_SETS = 64;

export function serviceKeyOf(conn) {
  if (!conn || typeof conn !== 'object') return 'unknown';
  const transport = String(conn.transport || '').toLowerCase();
  if (transport === 'builtin') {
    return `builtin:${String(conn.id || 'unknown').trim()}`;
  }
  if (transport === 'stdio') {
    // The command and its arguments name the server: "npx" alone is shared by many different servers.
    const cmd = typeof conn.command === 'string' ? conn.command.trim() : '';
    if (!cmd) return `local:${String(conn.id || 'local')}`;
    const args = Array.isArray(conn.args) ? conn.args.filter((a) => typeof a === 'string').map((a) => a.trim()).filter(Boolean) : [];
    return `local:${[path.basename(cmd), ...args].join(' ').toLowerCase().slice(0, 180)}`;
  }
  const rawUrl = typeof conn.url === 'string' ? conn.url.trim() : '';
  if (rawUrl) {
    try {
      const u = new URL(rawUrl);
      const pathname = u.pathname.replace(/\/+$/, '');
      return `${u.host.toLowerCase()}${pathname}`;
    } catch {
      // Fallback below.
    }
  }
  return `conn:${String(conn.id || 'unknown')}`;
}

const SECRET_QUERY_KEY_RE = /(key|token|secret|passw|pwd|auth|credential|bearer|cookie|session|private|signature|jwt)|^(?:sig|pass|pat)$/i;

// Like serviceKeyOf, but preserves non-secret query options (for example ?project_ref=appB or ?read_only=true)
// so two scoped endpoints on one service group on Home without colliding on creation.
export function serviceEndpointKeyOf(conn) {
  const base = serviceKeyOf(conn);
  if (!conn || typeof conn !== 'object') return base;
  const transport = String(conn.transport || '').toLowerCase();
  if (transport === 'builtin' || transport === 'stdio') return base;
  const rawUrl = typeof conn.url === 'string' ? conn.url.trim() : '';
  if (!rawUrl) return base;
  try {
    const u = new URL(rawUrl);
    const kept = [];
    for (const [k, v] of u.searchParams.entries()) {
      const lk = String(k || '').trim().toLowerCase();
      if (!lk || SECRET_QUERY_KEY_RE.test(lk)) continue;
      const sv = String(v ?? '').trim();
      if (sv.includes('{{vault:')) continue;
      kept.push(`${lk}=${sv}`);
    }
    if (!kept.length) return base;
    kept.sort();
    return `${base}?${kept.join('&')}`;
  } catch {
    return base;
  }
}

export function serviceNameOf(conn, catalog = []) {
  const key = serviceKeyOf(conn);
  if (Array.isArray(catalog)) {
    for (const item of catalog) {
      if (!item?.url) continue;
      if (serviceKeyOf({ transport: 'http', url: item.url }) === key && item.name) {
        return String(item.name);
      }
    }
  }
  return String(conn?.name || conn?.id || 'Service');
}

export function slugifyAccessSetId(name, existingIds = new Set()) {
  const raw = String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 44);
  const base = raw && !BUILTIN_ACCESS_SET_IDS.includes(raw) ? raw : 'custom-set';
  let id = base;
  let n = 2;
  while (existingIds.has(id) || BUILTIN_ACCESS_SET_IDS.includes(id)) {
    id = `${base}-${n++}`;
  }
  return id;
}

export function normalizeAccessSet(raw, existingIds = new Set()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = String(raw.name || '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 80);
  if (!name) return null;
  let id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : '';
  if (!id || !ACCESS_SET_ID_RE.test(id) || BUILTIN_ACCESS_SET_IDS.includes(id)) {
    id = slugifyAccessSetId(name, existingIds);
  }
  const connections = {};
  if (raw.connections && typeof raw.connections === 'object' && !Array.isArray(raw.connections)) {
    for (const [connId, tools] of Object.entries(raw.connections)) {
      if (typeof connId !== 'string' || !connId.trim() || connId === '__proto__' || connId === 'constructor' || connId === 'prototype') continue;
      if (!Array.isArray(tools)) continue;
      const cleanTools = [...new Set(tools.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 120)))].slice(0, 500);
      connections[connId.trim()] = cleanTools;
    }
  }
  const skills = Array.isArray(raw.skills)
    ? [...new Set(raw.skills.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 120)))].slice(0, 200)
    : [];
  return {
    id,
    name,
    connections,
    skills,
  };
}

export function normalizeAccessSets(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (out.length >= MAX_ACCESS_SETS) break;
    const normalized = normalizeAccessSet(item, seen);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    out.push(normalized);
  }
  return out;
}

export function builtinAccessSets() {
  return [
    { id: 'everything', name: 'Everything', builtin: true, kind: 'all', connections: {}, skills: [] },
    { id: 'read-only', name: 'Read-only', builtin: true, kind: 'read_only', connections: {}, skills: [] },
  ];
}

export function listAllAccessSets(customSets = [], agents = []) {
  const agentList = Array.isArray(agents) ? agents : [];
  const usersOf = (setId) =>
    agentList
      .filter((a) => (a?.accessSet || null) === setId)
      .map((a) => ({ id: a.id, name: a.name }));

  const builtins = builtinAccessSets().map((s) => ({
    ...s,
    agents: usersOf(s.id),
  }));
  const customs = normalizeAccessSets(customSets).map((s) => ({
    ...s,
    builtin: false,
    kind: 'custom',
    agents: usersOf(s.id),
  }));
  return [...builtins, ...customs];
}

export function resolveAccessSetRecord(accessSetId, customSets = []) {
  if (!accessSetId) return null;
  if (accessSetId === 'everything') return { id: 'everything', name: 'Everything', builtin: true, kind: 'all', connections: {}, skills: [] };
  if (accessSetId === 'read-only') return { id: 'read-only', name: 'Read-only', builtin: true, kind: 'read_only', connections: {}, skills: [] };
  const found = normalizeAccessSets(customSets).find((s) => s.id === accessSetId);
  return found ? { ...found, builtin: false, kind: 'custom' } : { id: accessSetId, name: accessSetId, builtin: false, kind: 'missing', connections: {}, skills: [] };
}

export function connectionAllowedByAccessSet(setRecord, conn) {
  if (!setRecord || setRecord.kind === 'all') return true;
  if (setRecord.kind === 'missing') return false;
  if (setRecord.kind === 'read_only') {
    const tools = Array.isArray(conn?.tools) ? conn.tools : [];
    // If tools have not synced yet, keep connection visible only if it can carry read tools.
    if (tools.length === 0) return true;
    return tools.some((t) => toolKindOf(t.annotations) === 'read');
  }
  return Boolean(conn?.id && Object.hasOwn(setRecord.connections || {}, conn.id));
}

export function toolAllowedByAccessSet(setRecord, connId, tool) {
  if (!setRecord || setRecord.kind === 'all') return { allowed: true };
  if (setRecord.kind === 'missing') {
    return { allowed: false, reason: `Stopped: access set "${setRecord.name}" does not exist.` };
  }
  if (setRecord.kind === 'read_only') {
    const kind = toolKindOf(tool?.annotations);
    if (kind !== 'read') {
      return { allowed: false, reason: `Stopped: the ${setRecord.name} set allows reads only.` };
    }
    return { allowed: true };
  }
  const allowedTools = Object.hasOwn(setRecord.connections || {}, connId) ? setRecord.connections[connId] : null;
  if (!Array.isArray(allowedTools) || !allowedTools.includes(tool?.name)) {
    return { allowed: false, reason: `Stopped: the ${setRecord.name} set does not allow this tool.` };
  }
  return { allowed: true };
}

export function skillAllowedByAccessSet(setRecord, skillId) {
  if (!setRecord || setRecord.kind === 'all' || setRecord.kind === 'read_only') return true;
  if (setRecord.kind === 'missing') return false;
  return Array.isArray(setRecord.skills) && setRecord.skills.includes(skillId);
}

// An Agent's accountChoice maps a service key to the one Connection (account) it uses there.
// ANY_ACCOUNT means every account of that service; a missing key means the same.
export const ANY_ACCOUNT = '*';

export function connectionAllowedByAccountChoice(accountChoice, conn) {
  if (!accountChoice || typeof accountChoice !== 'object') return true;
  const svcKey = serviceKeyOf(conn);
  if (!Object.hasOwn(accountChoice, svcKey)) return true;
  const chosenId = accountChoice[svcKey];
  if (!chosenId || chosenId === ANY_ACCOUNT) return true;
  return conn?.id === chosenId;
}

// The Connections that share a service with conn, in the order the workspace lists them (conn included).
export function accountsOfService(connections, key) {
  return (Array.isArray(connections) ? connections : []).filter((c) => c?.id && c.transport !== 'builtin' && serviceKeyOf(c) === key);
}

// A new account never widens an Agent silently: every Agent without a choice for this service stays on
// the account that was there first. Returns the Agents it changed.
export function pinAgentsToDefaultAccount(agents, key, defaultId) {
  const changed = [];
  if (!key || !defaultId) return changed;
  for (const agent of Array.isArray(agents) ? agents : []) {
    const choice = agent?.accountChoice && typeof agent.accountChoice === 'object' ? agent.accountChoice : {};
    if (Object.hasOwn(choice, key)) continue;
    agent.accountChoice = { ...choice, [key]: defaultId };
    changed.push(agent);
  }
  return changed;
}

// A new Agent starts on the first account of each service that has more than one.
export function defaultAccountChoice(connections, existing = {}) {
  const out = { ...(existing && typeof existing === 'object' ? existing : {}) };
  const firstByKey = new Map();
  const countByKey = new Map();
  for (const conn of Array.isArray(connections) ? connections : []) {
    if (!conn?.id || conn.transport === 'builtin') continue;
    const key = serviceKeyOf(conn);
    countByKey.set(key, (countByKey.get(key) || 0) + 1);
    if (!firstByKey.has(key)) firstByKey.set(key, conn.id);
  }
  for (const [key, n] of countByKey) {
    if (n > 1 && !Object.hasOwn(out, key)) out[key] = firstByKey.get(key);
  }
  return out;
}

// An account was removed: Agents on it move to the first account left, or lose the choice when none is left.
export function repinAgentsAfterRemove(agents, key, removedId, nextId) {
  const changed = [];
  for (const agent of Array.isArray(agents) ? agents : []) {
    const choice = agent?.accountChoice;
    if (!choice || typeof choice !== 'object' || choice[key] !== removedId) continue;
    const next = { ...choice };
    if (nextId) next[key] = nextId;
    else delete next[key];
    agent.accountChoice = next;
    changed.push(agent);
  }
  return changed;
}

export function buildServicesView({ connections = [], agents = [], catalog = [] } = {}) {
  const groups = new Map();
  for (const conn of connections) {
    const key = serviceKeyOf(conn);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: serviceNameOf(conn, catalog),
        accounts: [],
        tools: [],
        agents: [],
        _rawConns: [],
      };
      groups.set(key, group);
    }
    group._rawConns.push(conn);
    const readiness = connectionReadiness(conn);
    group.accounts.push({
      connectionId: conn.id,
      name: conn.name,
      accountLabel: conn.accountLabel || '',
      label: conn.accountLabel || conn.agentLogin?.username || conn.name,
      note: conn.agentNote || '',
      status: readiness.state || (conn.enabled === false ? 'off' : 'ready'),
      ready: readiness.ready === true,
      enabled: conn.enabled !== false,
      needsSignIn: readiness.action === 'sign_in',
      readinessAction: readiness.action || null,
      hasAuth: Boolean(
        conn.oauth?.accessTokenVaultKey ||
        conn.oauth?.accessToken ||
        Object.keys(conn.headers || {}).length > 0 ||
        conn.agentLogin,
      ),
      transport: conn.transport,
    });
  }

  const services = [];
  for (const group of groups.values()) {
    const readyConn = group._rawConns.find((c) => c.enabled !== false && connectionReadiness(c).ready) || group._rawConns[0];
    group.tools = (Array.isArray(readyConn?.tools) ? readyConn.tools : []).map((t) => ({
      name: t.name,
      description: t.description || '',
      kind: toolKindOf(t.annotations),
    }));
    const connIds = new Set(group._rawConns.map((c) => c.id));
    group.defaultConnectionId = group._rawConns[0]?.id || null;
    for (const ag of agents) {
      const raw = ag?.accountChoice && Object.hasOwn(ag.accountChoice, group.key) ? ag.accountChoice[group.key] : null;
      const chosen = raw && raw !== ANY_ACCOUNT && connIds.has(raw) ? raw : null;
      const allowedList = Array.isArray(ag?.allowedConnections) ? ag.allowedConnections : null;
      const reaches = allowedList ? group._rawConns.some((c) => allowedList.includes(c.id)) : true;
      if (reaches || chosen) {
        group.agents.push({
          id: ag.id,
          name: ag.name,
          kind: ag.kind || null,
          accessSet: ag.accessSet || null,
          approvalMode: ag.approvalMode || null,
          connectionId: chosen || (group._rawConns.length === 1 ? group._rawConns[0].id : null),
          // 'any' when the agent may use every account, 'account' when it is held to one.
          choice: chosen || group._rawConns.length === 1 ? 'account' : 'any',
        });
      }
    }
    delete group._rawConns;
    services.push(group);
  }

  services.sort((a, b) => a.name.localeCompare(b.name));
  return { services };
}
