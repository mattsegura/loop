// Configurable policy & approval engine: persistent policies.json, canonical SHA-256 argument
// fingerprinting, and a bounded single-use ApprovalQueue.
//
// Three modes say where the owner's yes comes from:
//   'auto'       Allow: no question; Loop keeps a log.
//   'always_ask' Ask: a yes in the chat, by text or in Loop.
//   'guard'      Guard: only on the Loop page, with the Loop password, one time per use. An
//                agent's own app answers a chat card, so a chat yes is no proof of the person.
//
// A run has two rules: the tool's (tool > connection > category > tool kind > default) and the
// Vault item's (the item, else its type). The stricter one wins, so "Allow" on a tool never
// opens a card that is on Ask or Guard.
//
// "Tool kind" is what a tool says about itself in its MCP annotations (read / write /
// destructive, or nothing at all). An agent that reaches tools through `loop__run` gives its
// own app one tool to allow, so that app cannot ask per tool; Loop asks instead, before a tool
// that can delete or that does not say what it does. The owner's "Always allow" (a per-tool or
// per-connection `auto`) turns the question off for good.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, createWriteQueue, readJsonWithBackup } from './json-file-store.mjs';
import { VAULT_TYPES, defaultDataDir } from './vault.mjs';

export const DEFAULT_POLICIES = Object.freeze({
  default: 'auto', // 'auto' | 'always_ask' | 'guard'
  vaultTypes: Object.freeze({
    payment: 'always_ask',
    login: 'always_ask',
    api_key: 'auto',
    note: 'auto',
  }),
  categories: Object.freeze({}), // categoryId -> 'inherit' or a mode
  connections: Object.freeze({}), // connId -> 'inherit' or a mode
  tools: Object.freeze({}), // `${connId}__${toolName}` -> 'inherit' or a mode
  // By what the tool says about itself (see toolKindOf). Escalation only: 'auto' here means
  // "no extra question", and the rules below it (the default) still apply. Read-only tools
  // have no entry: they always follow the default.
  // Off by default: agents run tools without extra questions. The owner can turn asking on per
  // kind in the Vault's Tools section (for example destructive: 'always_ask').
  toolKinds: Object.freeze({
    write: 'auto', // changes data, says it does not delete or overwrite
    destructive: 'auto', // says it can delete or overwrite
    unmarked: 'auto', // does not say either way
  }),
  actions: Object.freeze({
    cleanup: 'always_ask',
    organize: 'always_ask',
    delete: 'always_ask',
    add_local: 'always_ask',
    repoint: 'always_ask',
  }),
  argRules: Object.freeze([]),
});

export const MAX_PENDING_PER_AGENT = 20;
export const MAX_PENDING_TOTAL = 200;

const DECISION_MODES = new Set(['auto', 'always_ask', 'guard']);
const ARG_RULE_DECISIONS = new Set(['always_ask', 'guard', 'deny']);
const ARG_RULE_OPS = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'in', 'not_in', 'contains', 'regex']);
const MODE_RANK = Object.freeze({ auto: 0, always_ask: 1, guard: 2, deny: 3 });

function readDottedArg(obj, dottedPath) {
  if (!obj || typeof obj !== 'object' || typeof dottedPath !== 'string') return undefined;
  let cur = obj;
  for (const part of dottedPath.split('.')) {
    if (!part || FORBIDDEN_KEYS.has(part) || cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, part)) {
      return undefined;
    }
    cur = cur[part];
  }
  return cur;
}

function normalizeArgRule(raw, idx = 0) {
  if (!isPlainObject(raw)) return null;
  const tool = typeof raw.tool === 'string' ? raw.tool.trim().slice(0, 160) : '';
  const argPath = typeof raw.path === 'string' ? raw.path.trim().slice(0, 120) : '';
  const op = typeof raw.op === 'string' ? raw.op.trim().toLowerCase() : '';
  const decision = typeof raw.decision === 'string' ? raw.decision.trim().toLowerCase() : '';
  if (!tool || !argPath || !ARG_RULE_OPS.has(op) || !ARG_RULE_DECISIONS.has(decision)) return null;
  if (argPath.split('.').some((p) => !p || FORBIDDEN_KEYS.has(p))) return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 64) : `arg_${idx + 1}`;
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 200) : '';
  return { id, tool, path: argPath, op, value: raw.value, decision, ...(reason ? { reason } : {}) };
}

function normalizeArgRules(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (let i = 0; i < list.length && out.length < 100; i += 1) {
    const r = normalizeArgRule(list[i], i);
    if (r) out.push(r);
  }
  return out;
}

function argRuleMatches(rule, args) {
  const actual = readDottedArg(args, rule.path);
  if (actual === undefined) return false;
  switch (rule.op) {
    case 'gt': return typeof actual === 'number' && typeof rule.value === 'number' && actual > rule.value;
    case 'gte': return typeof actual === 'number' && typeof rule.value === 'number' && actual >= rule.value;
    case 'lt': return typeof actual === 'number' && typeof rule.value === 'number' && actual < rule.value;
    case 'lte': return typeof actual === 'number' && typeof rule.value === 'number' && actual <= rule.value;
    case 'eq': return actual === rule.value;
    case 'neq': return actual !== rule.value;
    case 'in': return Array.isArray(rule.value) && rule.value.includes(actual);
    case 'not_in': return Array.isArray(rule.value) && !rule.value.includes(actual);
    case 'contains': return typeof actual === 'string' && typeof rule.value === 'string' && actual.toLowerCase().includes(rule.value.toLowerCase());
    case 'regex': {
      if (typeof actual !== 'string' || typeof rule.value !== 'string' || rule.value.length > 160) return false;
      try { return new RegExp(rule.value, 'i').test(actual); } catch { return false; }
    }
    default: return false;
  }
}
const VAULT_TYPE_SET = new Set(VAULT_TYPES);
const TOOL_KIND_SET = new Set(Object.keys(DEFAULT_POLICIES.toolKinds));

/**
 * What a tool says about itself, from its MCP annotations:
 *   'read'        readOnlyHint: true
 *   'destructive' destructiveHint: true
 *   'write'       destructiveHint: false (changes things, says it does not delete or overwrite)
 *   'unmarked'    says neither (MCP's own default for such a tool is "may be destructive")
 * Annotations are the upstream server's word, not a guarantee; they only decide whether
 * Loop asks first, never what a tool is allowed to do.
 */
export function toolKindOf(annotations) {
  const a = annotations !== null && typeof annotations === 'object' && !Array.isArray(annotations) ? annotations : null;
  if (a?.readOnlyHint === true) return 'read';
  if (a?.destructiveHint === true) return 'destructive';
  if (a?.destructiveHint === false) return 'write';
  return 'unmarked';
}

const TOOL_KIND_REASONS = Object.freeze({
  write: 'changes data',
  destructive: 'says it can delete or overwrite data',
  unmarked: 'does not say whether it can delete or overwrite data',
});
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_RETAINED_TERMINAL = 1000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeKey(key) {
  return typeof key === 'string' && key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function normalizeDecision(raw) {
  if (typeof raw !== 'string') return null;
  const clean = raw.trim().toLowerCase();
  return DECISION_MODES.has(clean) ? clean : null;
}

/**
 * The result callers see. Guard is an ask that only the owner can answer on the Loop page, so
 * `decision` stays 'always_ask' and `guard` says which kind of ask it is.
 */
function ruleResult(mode, reason, source) {
  return mode === 'guard'
    ? { decision: 'always_ask', guard: true, reason, source }
    : { decision: mode, reason, source };
}

function ruleReason(mode, subject) {
  if (mode === 'guard') return `${subject} is on Guard`;
  return mode === 'always_ask' ? `${subject} requires approval` : `${subject} is set to auto-approve`;
}

/** The owner's own rule for an action, when there is one. Unlike evaluateAction, no default. */
export function ownActionRule(policies, action) {
  const mode = normalizeDecision(policies?.actions?.[action]);
  return mode ? ruleResult(mode, ruleReason(mode, `Action "${action}"`), `action:${action}`) : null;
}

/** The stricter of two evaluated rules; the first one on a tie. Either can be null. */
export function stricterRule(a, b) {
  if (!a || !b) return a || b || null;
  const rank = (r) => (r.decision === 'always_ask' ? (r.guard ? 2 : 1) : 0);
  return rank(b) > rank(a) ? b : a;
}

/** The mode a Vault item follows: its own, else its type's. */
export function vaultItemMode(policies, { type, approval } = {}) {
  return normalizeDecision(approval) || normalizeDecision(policies?.vaultTypes?.[type]) || 'auto';
}

/** True when a change takes a Vault item off Guard. */
export function vaultItemLeavesGuard(policies, before, after) {
  return vaultItemMode(policies, before) === 'guard' && vaultItemMode(policies, after) !== 'guard';
}

/**
 * Whether "always allow" may follow a yes. A card or a login that asks keeps its own rule, so a
 * rule on the tool would change nothing there; Guard asks every time.
 */
export function canAlwaysAllow(approval) {
  const rule = String(approval?.detail?.rule || '');
  return approval?.kind === 'run' && !approval.guard && !rule.startsWith('secret:') && !rule.startsWith('vaultType:');
}

/** A change that takes something off Guard and has no Loop password with it. */
export function guardPasswordError() {
  return Object.assign(new Error('Enter your Loop password to take this off Guard.'), {
    status: 403,
    code: 'guard_password',
  });
}

/** True when a policy change puts anything on Guard. */
export function patchSetsGuard(patch) {
  if (!isPlainObject(patch)) return false;
  return Object.values(patch).some((value) => (isPlainObject(value)
    ? Object.values(value).some((mode) => normalizeDecision(mode) === 'guard')
    : normalizeDecision(value) === 'guard'));
}

/**
 * True when new policies let something run that Guard held before. `connections` (with their
 * tools) makes it exact for a rule on one tool or connection; without it, or for one Loop does
 * not know, a broader Guard that could apply counts.
 */
export function policiesLeaveGuard(before, after, connections = null) {
  const RULE_MAPS = ['vaultTypes', 'categories', 'connections', 'tools', 'toolKinds', 'actions'];
  if (before.default === 'guard' && after.default !== 'guard') return true;
  for (const map of RULE_MAPS) {
    for (const [key, mode] of Object.entries(before[map] || {})) {
      if (mode === 'guard' && after[map]?.[key] !== 'guard') return true;
    }
  }
  // A new rule for one tool, connection or category that replaces a broader Guard.
  const looser = (map) => Object.keys(after[map] || {}).filter((key) => {
    const mode = normalizeDecision(after[map][key]);
    return mode && mode !== 'guard' && !normalizeDecision(before[map]?.[key]);
  });
  const conns = new Map((Array.isArray(connections) ? connections : []).map((c) => [c.id, c]));
  const isGuard = (mode) => mode === 'guard';
  const anyCategory = Object.values(before.categories || {}).some(isGuard);
  const kindGuards = (tools) => (tools
    ? tools.some((t) => isGuard(before.toolKinds?.[toolKindOf(t?.annotations)]))
    : Object.values(before.toolKinds || {}).some(isGuard));
  const toolsOf = (connId) => (Array.isArray(conns.get(connId)?.tools) ? conns.get(connId).tools : null);
  for (const key of looser('tools')) {
    const sep = key.indexOf('__');
    const connId = sep > 0 ? key.slice(0, sep) : '';
    const connRule = normalizeDecision(before.connections?.[connId]);
    if (isGuard(connRule)) return true;
    if (connRule) continue;
    const tool = toolsOf(connId)?.find((t) => t?.name === key.slice(sep + 2));
    if (isGuard(before.default) || anyCategory || kindGuards(tool ? [tool] : null)) return true;
  }
  for (const connId of looser('connections')) {
    if (isGuard(before.default) || anyCategory || kindGuards(toolsOf(connId))) return true;
  }
  return looser('categories').length > 0 && (isGuard(before.default) || kindGuards(null));
}

function isClearOverride(raw) {
  if (raw === null) return true;
  if (typeof raw !== 'string') return false;
  const clean = raw.trim().toLowerCase();
  return clean === '' || clean === 'inherit';
}

function sanitizeDecisionMap(raw, { allowedKeys = null, lowercaseKeys = false } = {}) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const key = lowercaseKeys ? String(k).trim().toLowerCase() : String(k).trim();
    if (!isSafeKey(key)) continue;
    if (allowedKeys && !allowedKeys.has(key)) continue;
    const decision = normalizeDecision(v);
    if (decision) out[key] = decision;
  }
  return out;
}

function applyMapPatch(target, patchMap, { allowedKeys = null, lowercaseKeys = false } = {}) {
  if (!isPlainObject(patchMap)) return;
  for (const [k, v] of Object.entries(patchMap)) {
    const key = lowercaseKeys ? String(k).trim().toLowerCase() : String(k).trim();
    if (!isSafeKey(key)) continue;
    if (allowedKeys && !allowedKeys.has(key)) continue;
    if (isClearOverride(v)) {
      delete target[key];
      continue;
    }
    const decision = normalizeDecision(v);
    if (decision) target[key] = decision;
  }
}

function defaultRule(policies) {
  const mode = normalizeDecision(policies.default) || DEFAULT_POLICIES.default;
  return {
    mode,
    reason: {
      auto: 'Allowed by global default policy',
      always_ask: 'Global default policy requires approval',
      guard: 'Every tool call is on Guard',
    }[mode],
    source: 'default',
  };
}

export class PolicyStore {
  /** `listConnections` (async) gives the connections with their tools; see policiesLeaveGuard. */
  constructor(dir = defaultDataDir(), { listConnections = null } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'policies.json');
    this.listConnections = typeof listConnections === 'function' ? listConnections : null;
    this._enqueue = createWriteQueue();
  }

  _withLock(fn) {
    return this._enqueue(fn);
  }

  async _readStored() {
    const { data: parsed, missing } = await readJsonWithBackup(this.file, {
      validate: (candidate) => {
        if (!isPlainObject(candidate)) {
          throw new Error(`Invalid policies file "${this.file}": expected a JSON object.`);
        }
        for (const field of ['vaultTypes', 'categories', 'connections', 'tools', 'toolKinds', 'actions']) {
          if (candidate[field] !== undefined && !isPlainObject(candidate[field])) {
            throw new Error(
              `Invalid policies file "${this.file}": "${field}" must be a JSON object.`,
            );
          }
        }
        return true;
      },
      fallbackToBackup: true,
    });

    if (missing || !parsed) {
      return {
        vaultTypes: {},
        categories: {},
        connections: {},
        tools: {},
        toolKinds: {},
        actions: {},
      };
    }

    const stored = {};
    const def = normalizeDecision(parsed.default);
    if (def) stored.default = def;
    stored.vaultTypes = sanitizeDecisionMap(parsed.vaultTypes, {
      allowedKeys: VAULT_TYPE_SET,
      lowercaseKeys: true,
    });
    stored.categories = sanitizeDecisionMap(parsed.categories);
    stored.connections = sanitizeDecisionMap(parsed.connections);
    stored.tools = sanitizeDecisionMap(parsed.tools);
    stored.toolKinds = sanitizeDecisionMap(parsed.toolKinds, {
      allowedKeys: TOOL_KIND_SET,
      lowercaseKeys: true,
    });
    stored.actions = sanitizeDecisionMap(parsed.actions);
    stored.argRules = normalizeArgRules(parsed.argRules);
    return stored;
  }

  _normalize(stored = {}) {
    return {
      default: stored.default || DEFAULT_POLICIES.default,
      vaultTypes: {
        ...DEFAULT_POLICIES.vaultTypes,
        ...(stored.vaultTypes || {}),
      },
      categories: { ...(stored.categories || {}) },
      connections: { ...(stored.connections || {}) },
      tools: { ...(stored.tools || {}) },
      toolKinds: {
        ...DEFAULT_POLICIES.toolKinds,
        ...(stored.toolKinds || {}),
      },
      actions: {
        ...DEFAULT_POLICIES.actions,
        ...(stored.actions || {}),
      },
      argRules: normalizeArgRules(stored.argRules),
    };
  }

  async _writeStored(stored) {
    const payload = {
      version: 1,
      ...(stored.default ? { default: stored.default } : {}),
      vaultTypes: stored.vaultTypes || {},
      categories: stored.categories || {},
      connections: stored.connections || {},
      tools: stored.tools || {},
      toolKinds: stored.toolKinds || {},
      actions: stored.actions || {},
      ...(Array.isArray(stored.argRules) && stored.argRules.length > 0 ? { argRules: stored.argRules } : {}),
    };
    await atomicWriteFile(this.file, JSON.stringify(payload, null, 2) + '\n', {
      mode: 0o600,
      backup: true,
    });
  }

  async get() {
    const stored = await this._readStored();
    return this._normalize(stored);
  }

  /**
   * Takes nothing off Guard unless `ownerConfirmed` says the owner's password was checked, so
   * no "always allow" from a chat, a text or an agent can lower it.
   */
  async update(patch, { ownerConfirmed = false } = {}) {
    if (!isPlainObject(patch)) {
      throw new Error('Policy patch must be an object.');
    }

    return this._withLock(async () => {
      const stored = await this._readStored();
      const before = this._normalize(structuredClone(stored));

      if (Object.hasOwn(patch, 'default')) {
        if (isClearOverride(patch.default)) {
          delete stored.default;
        } else {
          const def = normalizeDecision(patch.default);
          if (def) stored.default = def;
        }
      }

      if (Object.hasOwn(patch, 'vaultTypes')) {
        applyMapPatch(stored.vaultTypes, patch.vaultTypes, {
          allowedKeys: VAULT_TYPE_SET,
          lowercaseKeys: true,
        });
      }

      if (Object.hasOwn(patch, 'categories')) {
        applyMapPatch(stored.categories, patch.categories);
      }

      if (Object.hasOwn(patch, 'connections')) {
        applyMapPatch(stored.connections, patch.connections);
      }

      if (Object.hasOwn(patch, 'tools')) {
        applyMapPatch(stored.tools, patch.tools);
      }

      if (Object.hasOwn(patch, 'toolKinds')) {
        applyMapPatch(stored.toolKinds, patch.toolKinds, {
          allowedKeys: TOOL_KIND_SET,
          lowercaseKeys: true,
        });
      }

      if (Object.hasOwn(patch, 'actions')) {
        applyMapPatch(stored.actions, patch.actions);
      }

      if (Object.hasOwn(patch, 'argRules')) {
        stored.argRules = normalizeArgRules(patch.argRules);
      }

      const after = this._normalize(stored);
      if (!ownerConfirmed && policiesLeaveGuard(before, after)) {
        // A second look with the real tools, only when a Guard rule is in the way.
        const connections = this.listConnections ? await this.listConnections().catch(() => null) : null;
        if (!connections || policiesLeaveGuard(before, after, connections)) throw guardPasswordError();
      }

      await this._writeStored(stored);
      return after;
    });
  }

  async deleteConnection(connId) {
    const cleanId = typeof connId === 'string' ? connId.trim() : '';
    if (!cleanId || !isSafeKey(cleanId)) {
      return this.get();
    }

    return this._withLock(async () => {
      const stored = await this._readStored();
      let changed = false;

      if (Object.hasOwn(stored.connections, cleanId)) {
        delete stored.connections[cleanId];
        changed = true;
      }

      const prefix = `${cleanId}__`;
      for (const toolKey of Object.keys(stored.tools)) {
        if (toolKey.startsWith(prefix)) {
          delete stored.tools[toolKey];
          changed = true;
        }
      }

      if (changed) {
        await this._writeStored(stored);
      }
      return this._normalize(stored);
    });
  }

  /**
   * `toolAnnotations` is the tool's MCP annotations when the caller has them; otherwise they
   * are looked up in `conn.tools`. A tool Loop has no record of counts as unmarked.
   */
  async evaluateRun({ conn, toolName, toolAnnotations, categoryId = null, referencedSecrets = [], args = null } = {}) {
    const policies = await this.get();
    const connId = typeof conn === 'string' ? conn.trim() : String(conn?.id || '').trim();
    const connLabel =
      (conn && typeof conn === 'object' && typeof conn.name === 'string' && conn.name.trim()) ||
      connId ||
      'connection';
    const cleanTool = String(toolName || '').trim();
    const toolKey = connId && cleanTool ? `${connId}__${cleanTool}` : cleanTool;

    // Rules are listed in the order that breaks a tie; the strictest one decides.
    const rules = [];

    // Argument-value rules (e.g. amount > 50, recipient not in allowlist).
    if (args && typeof args === 'object' && Array.isArray(policies.argRules) && policies.argRules.length > 0) {
      for (const ar of policies.argRules) {
        const matchesTool = ar.tool === '*' || ar.tool === toolKey || ar.tool === cleanTool || (connId && ar.tool === `${connId}__*`);
        if (!matchesTool) continue;
        if (!argRuleMatches(ar, args)) continue;
        const reason = ar.reason || `Argument "${ar.path}" matched policy rule (${ar.op} ${JSON.stringify(ar.value)})`;
        if (ar.decision === 'deny') {
          return { decision: 'deny', reason, source: `argRule:${ar.id}` };
        }
        rules.push({ mode: ar.decision, reason, source: `argRule:${ar.id}` });
      }
    }

    // The tool's own rule (most specific)
    const toolDecision = toolKey ? normalizeDecision(policies.tools[toolKey]) : null;
    if (toolDecision) {
      rules.push({
        mode: toolDecision,
        reason: ruleReason(toolDecision, `Tool "${toolKey}"`),
        source: `tool:${toolKey}`,
      });
    }

    const secrets = (Array.isArray(referencedSecrets) ? referencedSecrets : [])
      .filter((s) => s && typeof s === 'object' && typeof s.key === 'string' && s.key)
      .map((s) => {
        const rawApproval =
          typeof s.approval === 'string' ? s.approval.trim().toLowerCase() : 'inherit';
        return {
          key: s.key,
          type:
            typeof s.type === 'string' && VAULT_TYPE_SET.has(s.type.trim().toLowerCase())
              ? s.type.trim().toLowerCase()
              : 'api_key',
          approval: DECISION_MODES.has(rawApproval) ? rawApproval : 'inherit',
        };
      });

    // Vault items only make a run stricter, so their 'auto' is never a rule here.
    const askModes = (s) => s.approval === 'always_ask' || s.approval === 'guard';
    for (const s of secrets.filter(askModes)) {
      rules.push({
        mode: s.approval,
        reason: ruleReason(s.approval, `Vault secret "${s.key}"`),
        source: `secret:${s.key}`,
      });
    }

    const connDecision = connId ? normalizeDecision(policies.connections[connId]) : null;
    const cleanCat = typeof categoryId === 'string' ? categoryId.trim() : '';
    const catDecision = cleanCat ? normalizeDecision(policies.categories[cleanCat]) : null;
    if (connDecision && !toolDecision) {
      rules.push({
        mode: connDecision,
        reason: ruleReason(connDecision, `Connection "${connLabel}"`),
        source: `connection:${connId}`,
      });
    }

    // An item with a mode of its own does not follow its type.
    for (const s of secrets.filter((x) => x.approval === 'inherit')) {
      const mode = normalizeDecision(policies.vaultTypes[s.type]);
      if (mode !== 'always_ask' && mode !== 'guard') continue;
      rules.push({
        mode,
        reason: ruleReason(mode, `Vault ${s.type} secret "${s.key}"`),
        source: `vaultType:${s.type}`,
      });
    }

    const decide = () => {
      let best = rules[0];
      for (const rule of rules) if (MODE_RANK[rule.mode] > MODE_RANK[best.mode]) best = rule;
      return ruleResult(best.mode, best.reason, best.source);
    };
    if (toolDecision || connDecision) return decide();

    if (catDecision) {
      rules.push({
        mode: catDecision,
        reason: ruleReason(catDecision, `Category "${cleanCat}"`),
        source: `category:${cleanCat}`,
      });
      return decide();
    }

    // What the tool says about itself (escalation only; skipped when no tool is named,
    // as when a caller asks for a connection's own rule)
    if (cleanTool && policies.toolKinds) {
      const annotations =
        toolAnnotations !== undefined
          ? toolAnnotations
          : (conn && typeof conn === 'object' && Array.isArray(conn.tools)
              ? conn.tools.find((t) => t && t.name === cleanTool)?.annotations
              : undefined);
      const kind = toolKindOf(annotations);
      const kindDecision = normalizeDecision(policies.toolKinds[kind]);
      if (kindDecision && kindDecision !== 'auto') {
        rules.push({
          mode: kindDecision,
          reason: `Tool "${toolKey}" ${TOOL_KIND_REASONS[kind]}`,
          source: `toolKind:${kind}`,
        });
      }
    }

    rules.push(defaultRule(policies));
    return decide();
  }

  async evaluateAction({ action, vaultType = null, itemApproval = 'inherit' } = {}) {
    const policies = await this.get();

    const rules = [];

    // 1. Explicit item approval
    const itemDecision = normalizeDecision(itemApproval);
    if (itemDecision) {
      rules.push({
        mode: itemDecision,
        reason: {
          auto: 'Item approval policy allows auto-approval',
          always_ask: 'Item approval policy requires approval',
          guard: 'This item is on Guard',
        }[itemDecision],
        source: 'item',
      });
    }

    // 2. Action policy override
    const cleanAction = typeof action === 'string' ? action.trim() : '';
    const actionDecision = cleanAction ? normalizeDecision(policies.actions[cleanAction]) : null;
    if (actionDecision) {
      rules.push({
        mode: actionDecision,
        reason: ruleReason(actionDecision, `Action "${cleanAction}"`),
        source: `action:${cleanAction}`,
      });
    }

    // 3. Vault type policy (when applicable; an item with a mode of its own does not follow it)
    const cleanType = typeof vaultType === 'string' ? vaultType.trim().toLowerCase() : '';
    const typeDecision = cleanType && !itemDecision ? normalizeDecision(policies.vaultTypes[cleanType]) : null;
    if (typeDecision) {
      rules.push({
        mode: typeDecision,
        reason: {
          auto: `Vault ${cleanType} policy allows auto-approval`,
          always_ask: `Vault ${cleanType} policy requires approval`,
          guard: `Vault ${cleanType} items are on Guard`,
        }[typeDecision],
        source: `vaultType:${cleanType}`,
      });
    }

    // 4. Global default
    if (rules.length === 0) rules.push(defaultRule(policies));

    // The most specific rule decides, but nothing opens what another of them has on Guard.
    const rule = rules.find((r) => r.mode === 'guard') || rules[0];
    return ruleResult(rule.mode, rule.reason, rule.source);
  }
}

/* ---------------- Canonical Argument Fingerprinting ---------------- */

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'object') {
    return null;
  }
  if (seen.has(value)) {
    throw new TypeError('Cannot compute approval fingerprint for circular structure.');
  }
  if (typeof value.toJSON === 'function') {
    return canonicalize(value.toJSON(), seen);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => (item === undefined ? null : canonicalize(item, seen)));
    }
    const sorted = Object.create(null);
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [key, val] of entries) {
      if (val === undefined) continue;
      Object.defineProperty(sorted, key, {
        value: canonicalize(val, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return sorted;
  } finally {
    seen.delete(value);
  }
}

export function approvalFingerprint(payload = {}) {
  const input = {
    kind: payload?.kind ?? null,
    target: payload?.target ?? null,
    args: payload?.args === undefined ? null : payload.args,
  };
  if (payload && payload.sink !== undefined && payload.sink !== null) {
    input.sink = payload.sink;
  }
  const canonical = canonicalize(input);
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/* ---------------- Single-Use Approval Queue (Optional Disk Persistence) ---------------- */

const PERSISTABLE_STATUSES = new Set(['pending', 'approved', 'denied', 'consumed']);

function makeNotFoundWaitResult() {
  const res = { status: 'not_found', approval: null };
  Object.defineProperty(res, 'decided', {
    value: false,
    enumerable: false,
    configurable: true,
  });
  return res;
}

function normalizeAgentId(raw) {
  if (raw === null || raw === undefined) return null;
  const clean = String(raw).trim();
  return clean ? clean : null;
}

function safeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function cloneDetail(detail) {
  if (detail === undefined || detail === null) return null;
  if (typeof detail === 'object') return structuredClone(detail);
  return detail;
}

export class ApprovalQueue {
  constructor(options = {}) {
    const opts = typeof options === 'number' ? { ttlMs: options } : options || {};
    this.ttlMs =
      typeof opts.ttlMs === 'number' && Number.isFinite(opts.ttlMs) && opts.ttlMs >= 0
        ? opts.ttlMs
        : DEFAULT_TTL_MS;
    this.consumeTtlMs =
      typeof opts.consumeTtlMs === 'number' &&
      Number.isFinite(opts.consumeTtlMs) &&
      opts.consumeTtlMs >= 0
        ? opts.consumeTtlMs
        : this.ttlMs;
    this.maxPendingPerAgent =
      typeof opts.maxPendingPerAgent === 'number' &&
      Number.isInteger(opts.maxPendingPerAgent) &&
      opts.maxPendingPerAgent > 0
        ? opts.maxPendingPerAgent
        : MAX_PENDING_PER_AGENT;
    this.maxPendingTotal =
      typeof opts.maxPendingTotal === 'number' &&
      Number.isInteger(opts.maxPendingTotal) &&
      opts.maxPendingTotal > 0
        ? opts.maxPendingTotal
        : MAX_PENDING_TOTAL;
    this._usesSystemClock = typeof opts.now !== 'function';
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.dir = typeof opts.dir === 'string' && opts.dir.trim() ? opts.dir.trim() : null;
    this.file = this.dir ? path.join(this.dir, 'approvals.json') : null;
    this._enqueue = this.file ? createWriteQueue() : null;
    this._persistQueued = false;
    this._persistPromise = Promise.resolve();
    this._closed = false;
    this._records = new Map();
    this._listeners = new Set();
    this._eventListeners = new Set();
    this._waiters = new Map(); // approvalId -> Set<{ onRecordChange, onClose }>
    this._seq = 0;

    if (typeof opts.onChange === 'function') {
      this._listeners.add(opts.onChange);
    }

    if (this.file) {
      this._loadFromDiskSync();
    }
  }

  _loadFromDiskSync() {
    let parsed;
    try {
      const raw = readFileSync(this.file, 'utf8');
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.records)) {
      return;
    }

    const nowMs = this._now();
    let maxSeq =
      typeof parsed.seq === 'number' && Number.isInteger(parsed.seq) && parsed.seq >= 0
        ? parsed.seq
        : 0;

    for (const entry of parsed.records) {
      if (!isPlainObject(entry)) continue;
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      if (!id) continue;
      const status = typeof entry.status === 'string' ? entry.status : '';
      if (!PERSISTABLE_STATUSES.has(status)) continue;
      if (entry.fingerprint !== undefined && typeof entry.fingerprint !== 'string') continue;

      const createdAtMs =
        typeof entry._createdAtMs === 'number' && Number.isFinite(entry._createdAtMs)
          ? entry._createdAtMs
          : typeof entry.createdAtMs === 'number' && Number.isFinite(entry.createdAtMs)
            ? entry.createdAtMs
            : Date.parse(entry.createdAt);
      const expiresAtMs =
        typeof entry._expiresAtMs === 'number' && Number.isFinite(entry._expiresAtMs)
          ? entry._expiresAtMs
          : typeof entry.expiresAtMs === 'number' && Number.isFinite(entry.expiresAtMs)
            ? entry.expiresAtMs
            : Date.parse(entry.expiresAt);
      if (!Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs)) continue;

      const seq =
        typeof entry._seq === 'number' && Number.isInteger(entry._seq) && entry._seq >= 0
          ? entry._seq
          : typeof entry.seq === 'number' && Number.isInteger(entry.seq) && entry.seq >= 0
            ? entry.seq
            : 0;
      if (seq > maxSeq) maxSeq = seq;

      // Skip expired records on reload.
      if (nowMs >= expiresAtMs) continue;

      const record = {
        id,
        kind: String(entry.kind ?? ''),
        target: String(entry.target ?? ''),
        title: String(entry.title ?? ''),
        detail: cloneDetail(entry.detail),
        reason: String(entry.reason ?? ''),
        agentId: normalizeAgentId(entry.agentId),
        agentName:
          entry.agentName !== null && entry.agentName !== undefined && String(entry.agentName).trim()
            ? String(entry.agentName).trim()
            : null,
        fingerprint: typeof entry.fingerprint === 'string' ? entry.fingerprint : '',
        uiSpec: entry.uiSpec && typeof entry.uiSpec === 'object' ? cloneDetail(entry.uiSpec) : null,
        resolution: entry.resolution && typeof entry.resolution === 'object' ? cloneDetail(entry.resolution) : null,
        guard: entry.guard === true,
        status,
        createdAt:
          typeof entry.createdAt === 'string' && Number.isFinite(Date.parse(entry.createdAt))
            ? entry.createdAt
            : new Date(createdAtMs).toISOString(),
        expiresAt:
          typeof entry.expiresAt === 'string' && Number.isFinite(Date.parse(entry.expiresAt))
            ? entry.expiresAt
            : new Date(expiresAtMs).toISOString(),
        decidedAt: typeof entry.decidedAt === 'string' && entry.decidedAt ? entry.decidedAt : null,
        consumedAt: typeof entry.consumedAt === 'string' && entry.consumedAt ? entry.consumedAt : null,
        _createdAtMs: createdAtMs,
        _expiresAtMs: expiresAtMs,
        _seq: seq,
      };
      this._records.set(id, record);
    }

    if (maxSeq > this._seq) {
      this._seq = maxSeq;
    }
  }

  _serializeForDisk() {
    const nowMs = this._now();
    const records = [];
    for (const record of this._records.values()) {
      if (!PERSISTABLE_STATUSES.has(record.status)) continue;
      if (nowMs >= record._expiresAtMs) continue;
      records.push({
        id: record.id,
        kind: record.kind,
        target: record.target,
        title: record.title,
        detail: cloneDetail(record.detail),
        reason: record.reason,
        agentId: record.agentId,
        agentName: record.agentName,
        fingerprint: record.fingerprint,
        ...(record.uiSpec ? { uiSpec: cloneDetail(record.uiSpec) } : {}),
        ...(record.resolution ? { resolution: cloneDetail(record.resolution) } : {}),
        ...(record.guard ? { guard: true } : {}),
        status: record.status,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        decidedAt: record.decidedAt,
        consumedAt: record.consumedAt,
        createdAtMs: record._createdAtMs,
        expiresAtMs: record._expiresAtMs,
        seq: record._seq,
      });
    }
    return JSON.stringify({ version: 1, seq: this._seq, records }, null, 2) + '\n';
  }

  _schedulePersist() {
    if (!this.file || this._persistQueued) return;
    this._persistQueued = true;
    const task = this._enqueue(async () => {
      this._persistQueued = false;
      const payload = this._serializeForDisk();
      try {
        await atomicWriteFile(this.file, payload, {
          mode: 0o600,
          backup: false,
          fsync: true,
        });
      } catch {
        // Disk persistence errors must not break in-memory approval queue transitions.
      }
    });
    this._persistPromise = task;
  }

  async flush() {
    if (!this.file) return;
    while (true) {
      const current = this._persistPromise;
      await current;
      if (current === this._persistPromise) break;
    }
  }

  async close() {
    this._closed = true;
    for (const [id, set] of [...this._waiters.entries()]) {
      const record = this._records.get(id) || null;
      for (const waiter of [...set]) {
        waiter.onClose(record);
      }
    }
    this._waiters.clear();
    await this.flush();
  }

  subscribe(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('ApprovalQueue subscriber must be a function.');
    }
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }

  onEvent(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('ApprovalQueue event listener must be a function.');
    }
    this._eventListeners.add(fn);
    return () => {
      this._eventListeners.delete(fn);
    };
  }

  _emitEvent(eventType, record) {
    if (this._eventListeners.size === 0 || !record) return;
    const pub = this._publicRecord(record);
    for (const fn of [...this._eventListeners]) {
      try {
        fn(eventType, pub);
      } catch {
        // Event listener errors must not break approval queue transitions.
      }
    }
  }

  _isExpired(record, nowMs = this._now()) {
    return nowMs >= record._expiresAtMs;
  }

  _makeTerminalWaitResult(record) {
    return {
      decided: record.status === 'approved' || record.status === 'denied',
      status: record.status,
      approval: this._publicRecord(record),
    };
  }

  _settleWaitersForRecord(record) {
    if (!record || record.status === 'pending') return;
    const set = this._waiters.get(record.id);
    if (!set || set.size === 0) return;
    for (const waiter of [...set]) {
      waiter.onRecordChange(record);
    }
  }

  _pruneExpired(nowMs = this._now()) {
    const expiredRecords = [];
    for (const record of this._records.values()) {
      if ((record.status === 'pending' || record.status === 'approved') && this._isExpired(record, nowMs)) {
        record.status = 'expired';
        expiredRecords.push(record);
      }
    }
    // Bound memory if many terminal records accumulate over a long session.
    if (this._records.size > MAX_RETAINED_TERMINAL) {
      for (const [id, record] of this._records) {
        if (
          record.status !== 'pending' &&
          record.status !== 'approved' &&
          this._records.size > MAX_RETAINED_TERMINAL
        ) {
          this._records.delete(id);
        }
      }
    }
    if (expiredRecords.length > 0) {
      for (const record of expiredRecords) {
        this._settleWaitersForRecord(record);
      }
      this._schedulePersist();
    }
    return expiredRecords.length > 0;
  }

  _publicRecord(record) {
    const out = {
      id: record.id,
      kind: record.kind,
      target: record.target,
      title: record.title,
      detail: cloneDetail(record.detail),
      reason: record.reason,
      agentId: record.agentId,
      agentName: record.agentName,
      fingerprint: record.fingerprint,
      status: record.status,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
    if (record.uiSpec) out.uiSpec = cloneDetail(record.uiSpec);
    if (record.resolution) out.resolution = cloneDetail(record.resolution);
    if (record.guard) out.guard = true;
    if (record.decidedAt) out.decidedAt = record.decidedAt;
    if (record.consumedAt) out.consumedAt = record.consumedAt;
    return out;
  }

  _buildPendingList(nowMs = this._now(), { prune = true } = {}) {
    if (prune) this._pruneExpired(nowMs);
    const pending = [];
    for (const record of this._records.values()) {
      if (record.status === 'pending') pending.push(record);
    }
    pending.sort((a, b) => b._createdAtMs - a._createdAtMs || b._seq - a._seq);
    return pending.map((r) => this._publicRecord(r));
  }

  _notify(nowMs = this._now()) {
    if (this._listeners.size === 0) return;
    const pending = this._buildPendingList(nowMs, { prune: false });
    for (const fn of [...this._listeners]) {
      try {
        fn(pending);
      } catch {
        // Subscriber errors must not break approval queue transitions.
      }
    }
  }

  _generateId() {
    let id;
    do {
      id = `apr_${randomBytes(6).toString('hex')}`;
    } while (this._records.has(id));
    return id;
  }

  create({
    kind = '',
    target = '',
    title = '',
    detail = null,
    reason = '',
    agentId = null,
    agentName = null,
    fingerprint = '',
    uiSpec = null,
    guard = false,
    ttlMs = null,
    maxPending = this.maxPendingPerAgent, // a caller that Loop trusts less can have a lower limit
  } = {}) {
    const nowMs = this._now();
    this._pruneExpired(nowMs);

    const cleanAgentId = normalizeAgentId(agentId);
    const cleanFingerprint = typeof fingerprint === 'string' ? fingerprint : '';
    const cleanUiSpec = uiSpec && typeof uiSpec === 'object' ? cloneDetail(uiSpec) : null;

    // Deduplicate identical active pending approval for the same agent and fingerprint
    if (cleanFingerprint) {
      for (const existing of this._records.values()) {
        if (
          existing.status === 'pending' &&
          existing.agentId === cleanAgentId &&
          safeEqualStrings(existing.fingerprint, cleanFingerprint)
        ) {
          // The owner changed the rule while the question was open: the open question follows it.
          if (existing.guard !== (guard === true)) {
            existing.guard = guard === true;
            existing.reason = String(reason ?? '');
            existing.uiSpec = cleanUiSpec;
            this._schedulePersist();
            this._notify(nowMs);
          }
          return this._publicRecord(existing);
        }
      }
    }

    // Enforce bounded pending queue caps (per-agent and global)
    let totalPending = 0;
    let agentPending = 0;
    for (const existing of this._records.values()) {
      if (existing.status !== 'pending') continue;
      totalPending += 1;
      if (existing.agentId === cleanAgentId) {
        agentPending += 1;
      }
    }
    if (agentPending >= Math.min(maxPending, this.maxPendingPerAgent) || totalPending >= this.maxPendingTotal) {
      throw Object.assign(
        new Error('Too many pending approval requests. Wait for existing approvals to be decided.'),
        { status: 429 },
      );
    }

    const MAX_RECORD_TTL_MS = 24 * 60 * 60 * 1000;
    const MIN_RECORD_TTL_MS = 10_000;
    const effectiveTtlMs =
      typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0
        ? Math.min(Math.max(ttlMs, MIN_RECORD_TTL_MS), MAX_RECORD_TTL_MS)
        : this.ttlMs;

    const id = this._generateId();
    const record = {
      id,
      kind: String(kind ?? ''),
      target: String(target ?? ''),
      title: String(title ?? ''),
      detail: cloneDetail(detail),
      reason: String(reason ?? ''),
      agentId: cleanAgentId,
      agentName:
        agentName !== null && agentName !== undefined && String(agentName).trim()
          ? String(agentName).trim()
          : null,
      fingerprint: cleanFingerprint,
      uiSpec: cleanUiSpec,
      resolution: null,
      guard: guard === true,
      status: 'pending',
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + effectiveTtlMs).toISOString(),
      decidedAt: null,
      consumedAt: null,
      _createdAtMs: nowMs,
      _expiresAtMs: nowMs + effectiveTtlMs,
      _seq: ++this._seq,
    };

    this._records.set(id, record);
    this._schedulePersist();
    this._notify(nowMs);
    this._emitEvent('approval.requested', record);
    return this._publicRecord(record);
  }

  listPending() {
    return this._buildPendingList(this._now(), { prune: true });
  }

  get(id) {
    if (typeof id !== 'string' || !id) return null;
    const record = this._records.get(id);
    if (!record) return null;
    if ((record.status === 'pending' || record.status === 'approved') && this._isExpired(record)) {
      record.status = 'expired';
      this._settleWaitersForRecord(record);
      this._schedulePersist();
    }
    return this._publicRecord(record);
  }

  /**
   * A Guard question takes a yes only with `ownerConfirmed`: the caller checked the owner's
   * password on the Loop page. A no is always fine.
   */
  decideApproval(id, decision, resolution = null, { ownerConfirmed = false } = {}) {
    let approved;
    if (typeof decision === 'boolean') {
      approved = decision;
    } else if (decision === 'approved' || decision === 'approve') {
      approved = true;
    } else if (decision === 'denied' || decision === 'deny') {
      approved = false;
    } else {
      throw new TypeError('Approval decision must be boolean or "approved" / "denied".');
    }

    if (typeof id !== 'string' || !id) {
      return {
        ok: false,
        status: 404,
        reason: 'not_found',
        approval: null,
        error: 'Approval request not found.',
      };
    }

    const record = this._records.get(id);
    if (!record) {
      return {
        ok: false,
        status: 404,
        reason: 'not_found',
        approval: null,
        error: 'Approval request not found.',
      };
    }

    const nowMs = this._now();
    if (record.status === 'pending' && this._isExpired(record, nowMs)) {
      record.status = 'expired';
      this._pruneExpired(nowMs);
      this._settleWaitersForRecord(record);
      this._schedulePersist();
      this._notify(nowMs);
      return {
        ok: false,
        status: 410,
        reason: 'expired',
        approval: this._publicRecord(record),
        error: 'Approval request has expired.',
      };
    }

    if (record.status === 'approved' && this._isExpired(record, nowMs)) {
      record.status = 'expired';
      this._settleWaitersForRecord(record);
      this._schedulePersist();
    }

    if (record.status === 'expired' && !record.decidedAt) {
      return {
        ok: false,
        status: 410,
        reason: 'expired',
        approval: this._publicRecord(record),
        error: 'Approval request has expired.',
      };
    }

    if (record.status !== 'pending') {
      const error =
        record.status === 'approved'
          ? 'Approval request has already been approved.'
          : record.status === 'denied'
            ? 'Approval request has already been denied.'
            : record.status === 'consumed'
              ? 'Approval request has already been used.'
              : 'Approval request was already decided and has expired.';
      return {
        ok: false,
        status: 409,
        reason: 'already_decided',
        approval: this._publicRecord(record),
        error,
      };
    }

    if (approved && record.guard && ownerConfirmed !== true) {
      return {
        ok: false,
        status: 403,
        reason: 'guard',
        approval: this._publicRecord(record),
        error: 'This request is on Guard. Open it in Loop and enter your Loop password.',
      };
    }

    record.status = approved ? 'approved' : 'denied';
    record.decidedAt = new Date(nowMs).toISOString();
    if (resolution && typeof resolution === 'object') {
      record.resolution = cloneDetail(resolution);
    }
    if (approved) {
      record._expiresAtMs = nowMs + this.consumeTtlMs;
      record.expiresAt = new Date(record._expiresAtMs).toISOString();
    }
    this._pruneExpired(nowMs);
    this._settleWaitersForRecord(record);
    this._schedulePersist();
    this._notify(nowMs);
    this._emitEvent('approval.decided', record);
    return {
      ok: true,
      status: 200,
      reason: record.status,
      approval: this._publicRecord(record),
      error: null,
    };
  }

  approve(id, resolution = null, options = {}) {
    return this.decideApproval(id, 'approved', resolution, options);
  }

  deny(id, resolution = null) {
    return this.decideApproval(id, 'denied', resolution);
  }

  decide(id, approved) {
    const res = this.decideApproval(id, Boolean(approved));
    return res.ok ? res.approval : null;
  }

  async waitForDecision(
    id,
    { agentId = null, timeoutMs = 45_000, signal = null, unref = false } = {},
  ) {
    if (typeof id !== 'string' || !id) {
      return makeNotFoundWaitResult();
    }

    const nowMs = this._now();
    this._pruneExpired(nowMs);
    const record = this._records.get(id);
    if (!record) {
      return makeNotFoundWaitResult();
    }

    const callerAgentId = normalizeAgentId(agentId);
    if (record.agentId !== null && record.agentId !== callerAgentId) {
      return makeNotFoundWaitResult();
    }

    if (record.status !== 'pending') {
      return this._makeTerminalWaitResult(record);
    }

    if (this._closed) {
      return {
        decided: false,
        closed: true,
        status: record.status,
        approval: this._publicRecord(record),
      };
    }

    if (signal?.aborted) {
      return {
        decided: false,
        aborted: true,
        timedOut: true,
        status: record.status,
        approval: this._publicRecord(record),
      };
    }

    const cleanTimeoutMs =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 0
        ? timeoutMs
        : 45_000;
    const remainingUntilExpiry = Math.max(0, record._expiresAtMs - nowMs);

    if (cleanTimeoutMs === 0) {
      const checkNow = this._now();
      if (record.status === 'pending' && this._isExpired(record, checkNow)) {
        record.status = 'expired';
        this._pruneExpired(checkNow);
        this._settleWaitersForRecord(record);
        this._schedulePersist();
        this._notify(checkNow);
        return this._makeTerminalWaitResult(record);
      }
      return {
        decided: false,
        timedOut: true,
        status: record.status,
        approval: this._publicRecord(record),
      };
    }

    const waitMs = Math.min(Math.max(1, cleanTimeoutMs), Math.max(1, remainingUntilExpiry));
    const wallStart = Date.now();
    const waitingForExpiry = cleanTimeoutMs > remainingUntilExpiry;

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;

      const waiter = {
        onRecordChange: (updated) => {
          if (updated && updated.status !== 'pending') {
            finish(this._makeTerminalWaitResult(updated));
          }
        },
        onClose: (current) => {
          finish({
            decided: false,
            closed: true,
            status: current ? current.status : 'closed',
            approval: current ? this._publicRecord(current) : null,
          });
        },
      };

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        const set = this._waiters.get(id);
        if (set) {
          set.delete(waiter);
          if (set.size === 0) {
            this._waiters.delete(id);
          }
        }
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
        resolve(result);
      };

      const onAbort = () => {
        const current = this._records.get(id);
        if (!current) {
          finish(makeNotFoundWaitResult());
          return;
        }
        const checkNow = this._now();
        if (current.status === 'pending' && this._isExpired(current, checkNow)) {
          current.status = 'expired';
          this._pruneExpired(checkNow);
          this._settleWaitersForRecord(current);
          this._schedulePersist();
          this._notify(checkNow);
        }
        if (current.status !== 'pending') {
          finish(this._makeTerminalWaitResult(current));
          return;
        }
        finish({
          decided: false,
          aborted: true,
          timedOut: true,
          status: current.status,
          approval: this._publicRecord(current),
        });
      };

      const scheduleTimer = (delayMs) => {
        timer = setTimeout(onTimeout, delayMs);
        if (unref) {
          timer.unref?.();
        }
      };

      const onTimeout = () => {
        timer = null;
        const current = this._records.get(id);
        if (!current) {
          finish(makeNotFoundWaitResult());
          return;
        }
        const checkNow = this._now();
        if (current.status === 'pending' && this._isExpired(current, checkNow)) {
          current.status = 'expired';
          this._pruneExpired(checkNow);
          this._settleWaitersForRecord(current);
          this._schedulePersist();
          this._notify(checkNow);
        }
        if (current.status !== 'pending') {
          finish(this._makeTerminalWaitResult(current));
          return;
        }
        // Guard against 1ms early setTimeout jitter when waiting on real-clock expiry.
        if (
          this._usesSystemClock &&
          waitingForExpiry &&
          checkNow < current._expiresAtMs &&
          Date.now() - wallStart < cleanTimeoutMs
        ) {
          const nextDelay = Math.max(
            1,
            Math.min(current._expiresAtMs - checkNow, cleanTimeoutMs - (Date.now() - wallStart)),
          );
          scheduleTimer(nextDelay);
          return;
        }
        finish({
          decided: false,
          timedOut: true,
          status: current.status,
          approval: this._publicRecord(current),
        });
      };

      let set = this._waiters.get(id);
      if (!set) {
        set = new Set();
        this._waiters.set(id, set);
      }
      set.add(waiter);

      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      scheduleTimer(waitMs);
    });
  }

  consume(id, fingerprint, options = {}) {
    if (typeof id !== 'string' || !id) {
      return { ok: false, status: 'not_found', error: 'Approval request not found.' };
    }
    const record = this._records.get(id);
    if (!record) {
      return { ok: false, status: 'not_found', error: 'Approval request not found.' };
    }

    const callerAgentId = normalizeAgentId(options?.agentId);
    if (record.agentId !== null && record.agentId !== callerAgentId) {
      return {
        ok: false,
        status: 'forbidden',
        error: 'Approval belongs to a different agent.',
      };
    }

    if (record.status === 'consumed') {
      return { ok: false, status: 'consumed', error: 'Approval has already been used.' };
    }
    if (record.status === 'denied') {
      return { ok: false, status: 'denied', error: 'Approval request was denied.' };
    }

    const nowMs = this._now();
    if (record.status === 'expired' || this._isExpired(record, nowMs)) {
      const wasPending = record.status === 'pending';
      const changed = record.status !== 'expired';
      record.status = 'expired';
      if (changed) {
        this._settleWaitersForRecord(record);
        this._schedulePersist();
      }
      if (wasPending) {
        this._pruneExpired(nowMs);
        this._notify(nowMs);
      }
      return { ok: false, status: 'expired', error: 'Approval request has expired.' };
    }

    if (record.status === 'pending') {
      return { ok: false, status: 'pending', error: 'Approval request is still pending.' };
    }
    if (record.status !== 'approved') {
      return { ok: false, status: record.status, error: `Approval request is ${record.status}.` };
    }

    if (!safeEqualStrings(record.fingerprint, fingerprint)) {
      return {
        ok: false,
        status: 'mismatch',
        error: 'Approval does not match the requested arguments.',
      };
    }

    // The rule became Guard after a plain yes: that yes is not enough any more.
    if (options?.guard === true && !record.guard) {
      return {
        ok: false,
        status: 'guard',
        error: 'This is on Guard now. The owner must confirm it on the Loop page.',
      };
    }

    record.status = 'consumed';
    record.consumedAt = new Date(nowMs).toISOString();
    this._pruneExpired(nowMs);
    this._settleWaitersForRecord(record);
    this._schedulePersist();
    this._notify(nowMs);
    return { ok: true, ...(record.resolution ? { resolution: cloneDetail(record.resolution) } : {}) };
  }
}
