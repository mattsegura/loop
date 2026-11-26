// Persistent configuration and MCP connection store with legacy mcps.json migration.

import { existsSync } from 'node:fs';
import { readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  atomicWriteFile,
  backupPathFor,
  createWriteQueue,
  readJsonWithBackup,
} from './json-file-store.mjs';
import {
  MAX_PROFILES,
  PROFILE_ID_MAX,
  PROFILE_NAME_MAX,
  PROFILE_DESC_MAX,
  FORBIDDEN_PROFILE_KEYS,
  PROFILE_CONTROL_RE,
  normalizeProfileTag,
  normalizeConnectionProfiles,
  normalizeProjectToolGrants,
  projectToolConnection,
} from './profiles.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { validateRevision } from './sync-revisions.mjs';
import { defaultDataDir } from './vault.mjs';
import { normalizePicture } from './agent-pictures.mjs';
import { normalizeAddedBy } from './context-names.mjs';
import { normalizeUpstreamToolUiMeta } from './mcp-apps.mjs';
import { normalizeUpstreamSkills } from './mcp-skills.mjs';
import {
  AGENT_APPROVAL_MODES, accountsOfService, defaultAccountChoice, normalizeAccessSets,
  pinAgentsToDefaultAccount, repinAgentsAfterRemove, serviceKeyOf,
} from './services.mjs';
import { isNamedActionId, listNamedActionsForConnection } from './named-actions.mjs';
import {
  BUILTIN_CONNECTIONS,
  BUILTIN_WEB_CONNECTION,
  BUILTIN_WEB_ID,
  isBuiltinConnection,
  listBuiltinTools,
} from './builtin-web.mjs';

export { defaultDataDir, MAX_PROFILES };

const VALID_TRANSPORTS = new Set(['http', 'sse', 'stdio', 'builtin', 'openapi', 'graphql']);
const TRANSPORT_ALIASES = {
  http: 'http',
  'streamable-http': 'http',
  streamable_http: 'http',
  streamablehttp: 'http',
  sse: 'sse',
  stdio: 'stdio',
  builtin: 'builtin',
  openapi: 'openapi',
  graphql: 'graphql',
};

export const DEFAULT_SETTINGS = Object.freeze({
  defaultProfile: 'all',
  requireAgentToken: true,
  paused: false,
  turnRecall: false,
  oauthRefreshTtlDays: null,
});

export const AGENT_KINDS = Object.freeze([
  'claude-code',
  'claude-desktop',
  'codex',
  'kimi-code',
  'cursor',
  'antigravity',
  'gemini',
  'vscode',
  'opencode',
  'windsurf',
  'zed',
  'openbot',
  'muse',
  'pi',
  'grok-bot',
  'meta-muse',
  'claude-duet',
  'openmausbot',
  'imessage',
  'other',
]);
const AGENT_KIND_SET = new Set(AGENT_KINDS);
export const AGENT_MODES = new Set(['default', 'auto', 'progressive', 'direct']);
export const AGENT_TOOL_MODES = Object.freeze(['gateway', 'direct', 'hybrid']);
const AGENT_TOOL_MODE_SET = new Set(AGENT_TOOL_MODES);
export const AGENT_MODULE_KEYS = Object.freeze([
  'connections',
  'vault',
  'memory',
  'skills',
  'tasks',
  'storage',
  'builtinWeb',
  'uiCards',
]);
const AGENT_MODULE_KEY_SET = new Set(AGENT_MODULE_KEYS);
export const AGENT_HOST_APPROVAL_DELEGATIONS = Object.freeze(['none', 'low_risk_ask']);
const AGENT_HOST_APPROVAL_DELEGATION_SET = new Set(AGENT_HOST_APPROVAL_DELEGATIONS);
const MIN_APPROVAL_TTL_SECONDS = 60;
const MAX_APPROVAL_TTL_SECONDS = 86_400;
const AGENT_MEMORY_ACCESS = new Set(['read_write', 'read', 'none']);

export const RESERVED_CONNECTION_IDS = new Set(['loop', 'loop_host']);
export const MAX_AGENTS = 100;
export const MAX_CONNECTIONS = 500;
export const MAX_SECRETS_PER_AGENT = 500;
export const MAX_ALLOWLIST_ITEMS_PER_AGENT = 1000;
export const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
export const CATALOG_FIELDS = Object.freeze([
  'tools',
  'resources',
  'prompts',
  'skills',
  'serverInstructions',
  'syncWarnings',
  'syncVersion',
]);

const SAFE_CATALOG_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

const AGENT_SECRET_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const VAULT_REF_PATTERN = /\{\{vault:[^{}]*\}\}/;
const TOOL_ANNOTATION_BOOLEAN_KEYS = Object.freeze([
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
]);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const HEADER_CONTROL_RE = /[\r\n\0]/;

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateBooleanField(value, fieldName) {
  if (typeof value !== 'boolean') {
    throw httpError(`${fieldName} must be a boolean.`, 400);
  }
  return value;
}

function isValidConfigObject(data) {
  if (!isPlainObject(data)) return false;
  if (data.settings !== undefined && !isPlainObject(data.settings)) return false;
  if (data.mcps !== undefined && !Array.isArray(data.mcps)) return false;
  if (data.agents !== undefined && !Array.isArray(data.agents)) return false;
  if (data.profiles !== undefined && !Array.isArray(data.profiles)) return false;
  return true;
}

function slugify(name) {
  const collapsed = String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const sliced = collapsed.slice(0, 40).replace(/^_+|_+$/g, '');
  const base = sliced || 'mcp';
  return RESERVED_CONNECTION_IDS.has(base) ? `${base}_conn` : base;
}

function isValidConnectionId(id) {
  return (
    typeof id === 'string' &&
    /^[a-z0-9](?:[a-z0-9_]*[a-z0-9])?$/.test(id) &&
    !id.includes('__') &&
    !RESERVED_CONNECTION_IDS.has(id)
  );
}

function uniqueId(name, existing) {
  const base = slugify(name);
  let id = base;
  let n = 2;
  while (existing.some((m) => m.id === id)) {
    id = `${base}_${n++}`;
  }
  return id;
}

function validateAgentSecrets(secrets) {
  if (secrets === undefined) return;
  if (!Array.isArray(secrets)) {
    throw httpError('Agent secrets must be an array.', 400);
  }
  if (secrets.length > MAX_SECRETS_PER_AGENT) {
    throw httpError(`An agent can be granted at most ${MAX_SECRETS_PER_AGENT} secrets.`, 400);
  }
  for (const entry of secrets) {
    if (
      typeof entry !== 'string' ||
      !AGENT_SECRET_KEY_PATTERN.test(entry) ||
      entry.startsWith('__')
    ) {
      throw httpError('Invalid Vault secret name in agent grant.', 400);
    }
  }
}

function validateAgentAllowlist(list, fieldName) {
  if (list === undefined || list === null) return;
  if (!Array.isArray(list)) {
    throw httpError(`${fieldName} must be an array or null.`, 400);
  }
  if (list.length > MAX_ALLOWLIST_ITEMS_PER_AGENT) {
    throw httpError(`${fieldName} can contain at most ${MAX_ALLOWLIST_ITEMS_PER_AGENT} items.`, 400);
  }
  for (const entry of list) {
    if (
      typeof entry !== 'string' ||
      !entry.trim() ||
      entry.length > 120 ||
      /[\x00-\x1f\x7f]/.test(entry)
    ) {
      throw httpError(`Invalid id in ${fieldName}.`, 400);
    }
  }
}

function normalizeOptionalAllowlist(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const clean = entry.trim();
    if (!clean || clean.length > 120 || /[\x00-\x1f\x7f]/.test(clean) || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= MAX_ALLOWLIST_ITEMS_PER_AGENT) break;
  }
  return out;
}

function containsVaultRef(value) {
  if (typeof value === 'string') return VAULT_REF_PATTERN.test(value);
  if (Array.isArray(value)) return value.some((item) => containsVaultRef(item));
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (VAULT_REF_PATTERN.test(k) || containsVaultRef(v)) return true;
    }
  }
  return false;
}

function validateProfileName(raw) {
  if (typeof raw !== 'string') {
    throw httpError('Profile name must be a non-empty string.', 400);
  }
  if (PROFILE_CONTROL_RE.test(raw)) {
    throw httpError('Profile name contains invalid characters.', 400);
  }
  const clean = raw.trim();
  if (!clean) {
    throw httpError('Profile name is required.', 400);
  }
  if (clean.length > PROFILE_NAME_MAX) {
    throw httpError(`Profile name must be at most ${PROFILE_NAME_MAX} characters.`, 400);
  }
  return clean;
}

function validateProfileDescription(raw) {
  if (raw === undefined) return '';
  if (typeof raw !== 'string') {
    throw httpError('Profile description must be a string.', 400);
  }
  if (PROFILE_CONTROL_RE.test(raw)) {
    throw httpError('Profile description contains invalid characters.', 400);
  }
  const clean = raw.trim();
  if (clean.length > PROFILE_DESC_MAX) {
    throw httpError(`Profile description must be at most ${PROFILE_DESC_MAX} characters.`, 400);
  }
  return clean;
}

const PROFILE_REPO_URL_MAX = 500;
const SCP_GIT_URL_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/;

function normalizeProfileRepositoryUrl(raw, { strict = false } = {}) {
  if (raw === undefined) return undefined;
  if (raw === null) return '';
  if (typeof raw !== 'string') {
    if (strict) throw httpError('Project repositoryUrl must be a string.', 400);
    return '';
  }
  if (PROFILE_CONTROL_RE.test(raw)) {
    if (strict) throw httpError('Project repositoryUrl contains invalid characters.', 400);
    return '';
  }
  const clean = raw.trim();
  if (!clean) return '';
  if (clean.length > PROFILE_REPO_URL_MAX) {
    if (strict) throw httpError(`Project repositoryUrl must be at most ${PROFILE_REPO_URL_MAX} characters.`, 400);
    return '';
  }
  if (VAULT_REF_PATTERN.test(clean)) {
    if (strict) throw httpError('Project repositoryUrl cannot contain Vault placeholders.', 400);
    return '';
  }
  if (SCP_GIT_URL_RE.test(clean)) {
    const host = clean.slice(clean.indexOf('@') + 1, clean.indexOf(':'));
    if (host && host.includes('.') && !host.startsWith('.') && !host.endsWith('.')) return clean;
    if (strict) throw httpError('Project repositoryUrl must use a valid hostname.', 400);
    return '';
  }
  let parsed;
  try {
    parsed = new URL(clean);
  } catch {
    if (strict) throw httpError('Project repositoryUrl must be a valid Git repository URL (https://, ssh://, or git@host:owner/repo).', 400);
    return '';
  }
  const proto = parsed.protocol.toLowerCase();
  if (proto !== 'https:' && proto !== 'ssh:') {
    if (strict) throw httpError('Project repositoryUrl must use https://, ssh://, or git@host:owner/repo.', 400);
    return '';
  }
  if (proto === 'https:' && (parsed.username || parsed.password)) {
    if (strict) throw httpError('Project repositoryUrl cannot include embedded credentials.', 400);
    return '';
  }
  if (proto === 'ssh:' && parsed.password) {
    if (strict) throw httpError('Project repositoryUrl cannot include a password.', 400);
    return '';
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    if (strict) throw httpError('Project repositoryUrl must include a repository path.', 400);
    return '';
  }
  return clean;
}

// Legacy projects may exist only as membership tags, including tool-only grants.
function connectionProjectIds(conn) {
  return [...(conn.profiles || []), ...Object.keys(conn.projectToolGrants || {})];
}

function validateProfileId(raw, { fallbackName = null } = {}) {
  let candidate;
  if (raw !== undefined && raw !== null && raw !== '') {
    if (typeof raw !== 'string') {
      throw httpError('Profile ID must be a string.', 400);
    }
    if (PROFILE_CONTROL_RE.test(raw)) {
      throw httpError('Profile ID contains invalid characters.', 400);
    }
    if (raw.trim().length > PROFILE_ID_MAX) {
      throw httpError(`Profile ID must be at most ${PROFILE_ID_MAX} characters.`, 400);
    }
    candidate = raw;
  } else if (fallbackName !== null) {
    candidate = fallbackName;
  } else {
    throw httpError('Profile ID is required.', 400);
  }
  const id = normalizeProfileTag(candidate);
  if (!id || FORBIDDEN_PROFILE_KEYS.has(id)) {
    throw httpError('Profile ID must contain letters or numbers.', 400);
  }
  if (id === 'all') {
    throw httpError('Profile ID "all" is reserved.', 400);
  }
  if (id.length > PROFILE_ID_MAX) {
    throw httpError(`Profile ID must be at most ${PROFILE_ID_MAX} characters.`, 400);
  }
  return id;
}

const PROFILE_APPEARANCE = {
  icon: ['smile', 'star', 'diamond', 'sun', 'leaf', 'briefcase'],
  color: ['slate', 'blue', 'green', 'purple', 'rose', 'amber'],
};
function profileAppearance(raw, strict = false) {
  const out = {};
  for (const [key, allowed] of Object.entries(PROFILE_APPEARANCE)) {
    if (allowed.includes(raw[key])) out[key] = raw[key];
    else if (strict && raw[key] !== undefined) throw httpError('Invalid profile ' + key + '.', 400);
  }
  return out;
}

function normalizeProfileRecord(raw) {
  if (!isPlainObject(raw)) return null;
  const rawId = typeof raw.id === 'string' && !PROFILE_CONTROL_RE.test(raw.id) ? raw.id : '';
  const id = normalizeProfileTag(rawId);
  if (!id || id === 'all' || FORBIDDEN_PROFILE_KEYS.has(id)) return null;
  const rawName =
    typeof raw.name === 'string'
      ? raw.name.replace(/[\r\n\0]+/g, ' ').trim().slice(0, PROFILE_NAME_MAX)
      : '';
  const name = rawName || id;
  const description =
    typeof raw.description === 'string'
      ? raw.description.replace(/[\r\n\0]+/g, ' ').trim().slice(0, PROFILE_DESC_MAX)
      : '';
  const now = new Date().toISOString();
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : now;
  const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : createdAt;
  const repositoryUrl = normalizeProfileRepositoryUrl(raw.repositoryUrl, { strict: false }) || '';
  return {
    id,
    name,
    description,
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...profileAppearance(raw),
    createdAt,
    updatedAt,
  };
}

function normalizeProfileRecords(rawList) {
  if (!Array.isArray(rawList)) return [];
  const seen = new Set();
  const out = [];
  for (const item of rawList) {
    if (out.length >= MAX_PROFILES) break;
    const record = normalizeProfileRecord(item);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    out.push(record);
  }
  return out;
}

function normalizeHeaders(headers) {
  const out = Object.create(null);
  if (!isPlainObject(headers)) return {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== 'string') continue;
    if (HEADER_CONTROL_RE.test(k) || HEADER_CONTROL_RE.test(v)) continue;
    const key = k.trim();
    const val = v.trim();
    if (!key || FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
    if (val) out[key] = val;
  }
  return Object.fromEntries(Object.entries(out));
}

function validateHeadersStrict(headers) {
  if (!isPlainObject(headers)) {
    throw httpError('Headers must be a plain object.', 400);
  }
  const out = Object.create(null);
  for (const [k, v] of Object.entries(headers)) {
    if (typeof k !== 'string' || typeof v !== 'string') {
      throw httpError(`Header "${String(k)}" value must be a string.`, 400);
    }
    if (HEADER_CONTROL_RE.test(k) || HEADER_CONTROL_RE.test(v)) {
      throw httpError(`Header "${k.trim() || '(empty)'}" contains invalid CR/LF or NUL characters.`, 400);
    }
    const key = k.trim();
    const val = v.trim();
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw httpError(`Invalid header name "${key}".`, 400);
    }
    if (!key && val) {
      throw httpError('Header name must be a non-empty string.', 400);
    }
    if (key && val) out[key] = val;
  }
  return Object.fromEntries(Object.entries(out));
}

function normalizeEnv(env) {
  const out = Object.create(null);
  if (!isPlainObject(env)) return {};
  for (const [k, v] of Object.entries(env)) {
    const key = String(k).trim();
    if (!key || FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
    if (typeof v !== 'string' || v.includes('\0') || key.includes('\0')) continue;
    out[key] = v;
  }
  return Object.fromEntries(Object.entries(out));
}

function validateEnvStrict(env) {
  if (!isPlainObject(env)) {
    throw httpError('Environment variables must be a plain object.', 400);
  }
  const out = Object.create(null);
  for (const [k, v] of Object.entries(env)) {
    if (typeof k !== 'string' || typeof v !== 'string') {
      throw httpError(`Environment variable "${String(k)}" value must be a string.`, 400);
    }
    const key = k.trim();
    if (!key || FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw httpError(`Invalid environment variable name "${k}".`, 400);
    }
    if (key.includes('\0') || v.includes('\0')) {
      throw httpError(`Environment variable "${key}" cannot contain NUL characters.`, 400);
    }
    out[key] = v;
  }
  return Object.fromEntries(Object.entries(out));
}

function normalizeArgs(args) {
  if (!Array.isArray(args)) return [];
  return args.filter((a) => typeof a === 'string' && !a.includes('\0'));
}

function validateArgsStrict(args) {
  if (!Array.isArray(args)) {
    throw httpError('Args must be an array of strings.', 400);
  }
  const out = [];
  for (const item of args) {
    if (typeof item !== 'string') {
      throw httpError('Every entry in args must be a string.', 400);
    }
    if (item.includes('\0')) {
      throw httpError('Args cannot contain NUL characters.', 400);
    }
    out.push(item);
  }
  return out;
}

function validateCwdStrict(cwd) {
  if (cwd === undefined || cwd === null) return null;
  if (typeof cwd !== 'string') {
    throw httpError('Working directory (cwd) must be a string.', 400);
  }
  if (cwd.includes('\0')) {
    throw httpError('Working directory (cwd) cannot contain NUL characters.', 400);
  }
  return cwd.trim() || null;
}

function validateAllowedToolsStrict(allowedTools) {
  if (allowedTools === undefined || allowedTools === null) return null;
  if (!Array.isArray(allowedTools)) {
    throw httpError('allowedTools must be an array of strings or null.', 400);
  }
  const seen = new Set();
  const out = [];
  for (const item of allowedTools) {
    if (typeof item !== 'string') {
      throw httpError('Every entry in allowedTools must be a string.', 400);
    }
    const val = item.trim();
    if (val && !seen.has(val)) {
      seen.add(val);
      out.push(val);
    }
  }
  return out;
}

function normalizeStringList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const val = String(item ?? '').trim();
    if (val && !seen.has(val)) {
      seen.add(val);
      out.push(val);
    }
  }
  return out;
}

export function normalizeToolAnnotations(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  if (typeof raw.title === 'string') {
    const title = raw.title.trim().slice(0, 120);
    if (title) out.title = title;
  }
  for (const key of TOOL_ANNOTATION_BOOLEAN_KEYS) {
    if (typeof raw[key] === 'boolean') {
      out[key] = raw[key];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t) => t && typeof t === 'object' && typeof t.name === 'string' && t.name.trim())
    .map((t) => {
      const annotations = normalizeToolAnnotations(t.annotations);
      const uiMeta = normalizeUpstreamToolUiMeta(t._meta);
      const title = typeof t.title === 'string' && t.title.trim() ? t.title.trim().slice(0, 200) : '';
      const description = typeof t.description === 'string' && t.description.trim() ? t.description : title;
      const outputSchema =
        t.outputSchema && typeof t.outputSchema === 'object' && !Array.isArray(t.outputSchema)
          ? t.outputSchema
          : undefined;
      return {
        name: t.name,
        ...(title ? { title } : {}),
        description,
        inputSchema:
          t.inputSchema && typeof t.inputSchema === 'object'
            ? t.inputSchema
            : { type: 'object', properties: {} },
        ...(outputSchema ? { outputSchema } : {}),
        ...(annotations ? { annotations } : {}),
        ...(uiMeta ? { _meta: uiMeta } : {}),
      };
    });
}

function normalizeResources(resources) {
  if (!Array.isArray(resources)) return [];
  return resources
    .filter((r) => r && typeof r === 'object' && typeof r.uri === 'string' && r.uri.trim())
    .map((r) => ({
      uri: r.uri,
      name: typeof r.name === 'string' ? r.name : '',
      description: typeof r.description === 'string' ? r.description : '',
      mimeType: typeof r.mimeType === 'string' ? r.mimeType : null,
    }));
}

function normalizePrompts(prompts) {
  if (!Array.isArray(prompts)) return [];
  return prompts
    .filter((p) => p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim())
    .map((p) => ({
      name: p.name,
      description: typeof p.description === 'string' ? p.description : '',
      arguments: Array.isArray(p.arguments) ? p.arguments : [],
    }));
}

function normalizeOAuth(oauth, { stripVaultBackedInline = false } = {}) {
  if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) return null;
  const clientSecretVaultKey =
    typeof oauth.clientSecretVaultKey === 'string' && oauth.clientSecretVaultKey
      ? oauth.clientSecretVaultKey
      : null;
  const accessTokenVaultKey =
    typeof oauth.accessTokenVaultKey === 'string' && oauth.accessTokenVaultKey
      ? oauth.accessTokenVaultKey
      : null;
  const refreshTokenVaultKey =
    typeof oauth.refreshTokenVaultKey === 'string' && oauth.refreshTokenVaultKey
      ? oauth.refreshTokenVaultKey
      : null;
  const out = {
    clientId: oauth.clientId ?? null,
    clientSecret:
      stripVaultBackedInline && clientSecretVaultKey ? null : (oauth.clientSecret ?? null),
    clientSecretVaultKey,
    issuer: typeof oauth.issuer === 'string' && oauth.issuer ? oauth.issuer : null,
    tokenEndpoint: oauth.tokenEndpoint ?? null,
    callbackUrl: typeof oauth.callbackUrl === 'string' && oauth.callbackUrl ? oauth.callbackUrl : null,
    accessTokenVaultKey,
    refreshTokenVaultKey,
    expiresAt: oauth.expiresAt ?? null,
  };
  if (typeof oauth.grantId === 'string' && oauth.grantId) {
    out.grantId = oauth.grantId;
  }
  if (typeof oauth.boundOrigin === 'string' && oauth.boundOrigin) {
    out.boundOrigin = oauth.boundOrigin;
  }
  if (typeof oauth.boundSinkKey === 'string' && oauth.boundSinkKey) {
    out.boundSinkKey = oauth.boundSinkKey;
  }
  if (typeof oauth.issuedAt === 'number' && Number.isFinite(oauth.issuedAt) && oauth.issuedAt > 0) {
    out.issuedAt = oauth.issuedAt;
  }
  if (typeof oauth.ttlMs === 'number' && Number.isFinite(oauth.ttlMs) && oauth.ttlMs > 0) {
    out.ttlMs = oauth.ttlMs;
  }
  if (typeof oauth.tokenEndpointAuthMethod === 'string' && oauth.tokenEndpointAuthMethod) {
    out.tokenEndpointAuthMethod = oauth.tokenEndpointAuthMethod;
  }
  // Preserve legacy inline tokens prior to vault migration (stripped on update once vault-backed).
  if (
    typeof oauth.accessToken === 'string' &&
    oauth.accessToken &&
    !(stripVaultBackedInline && accessTokenVaultKey)
  ) {
    out.accessToken = oauth.accessToken;
  }
  if (
    typeof oauth.refreshToken === 'string' &&
    oauth.refreshToken &&
    !(stripVaultBackedInline && refreshTokenVaultKey)
  ) {
    out.refreshToken = oauth.refreshToken;
  }
  return out;
}

function normalizeDescription(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function normalizeServerInstructions(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, 4000);
}

function validateHttpUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw httpError('Enter a valid http(s) URL.', 400);
  }
  const clean = rawUrl.trim();
  let parsed;
  try {
    parsed = new URL(clean);
  } catch {
    throw httpError('Enter a valid http(s) URL.', 400);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw httpError('URL must use http or https.', 400);
  }
  return parsed.href.replace(
    /%7[Bb]%7[Bb]vault(?:%3[Aa]|:)([A-Za-z0-9_.-]{1,100})%7[Dd]%7[Dd]/g,
    '{{vault:$1}}',
  );
}

function resolveTransport(input) {
  const explicit = input.transport ?? input.type;
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    const key = String(explicit).trim().toLowerCase();
    const mapped = TRANSPORT_ALIASES[key];
    if (!mapped || !VALID_TRANSPORTS.has(mapped)) {
      throw httpError('Transport must be "http", "sse", or "stdio".', 400);
    }
    return mapped;
  }
  const hasCommand = typeof input.command === 'string' && input.command.trim().length > 0;
  const hasUrl = typeof input.url === 'string' && input.url.trim().length > 0;
  return hasCommand && !hasUrl ? 'stdio' : 'http';
}

function normalizeAccountLabel(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 60);
}

function normalizeAgentNote(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 280);
}

function normalizeAccountChoice(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || typeof v !== 'string') continue;
    const key = k.trim().slice(0, 200);
    const val = v.trim().slice(0, 120);
    if (!key || !val || FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
    out[key] = val;
  }
  return out;
}

function normalizeSettings(raw) {
  const defaultProfile =
    raw && typeof raw.defaultProfile === 'string'
      ? normalizeProfileTag(raw.defaultProfile) || DEFAULT_SETTINGS.defaultProfile
      : DEFAULT_SETTINGS.defaultProfile;
  const requireAgentToken =
    raw && typeof raw.requireAgentToken === 'boolean'
      ? raw.requireAgentToken
      : DEFAULT_SETTINGS.requireAgentToken;
  const paused = raw && typeof raw.paused === 'boolean' ? raw.paused : DEFAULT_SETTINGS.paused;
  const turnRecall = raw && typeof raw.turnRecall === 'boolean' ? raw.turnRecall : DEFAULT_SETTINGS.turnRecall;
  const dismissedBuiltins = normalizeStringList(raw?.dismissedBuiltins);
  const accessSets = normalizeAccessSets(raw?.accessSets);
  const rawRefreshDays = raw?.oauthRefreshTtlDays;
  const oauthRefreshTtlDays =
    Number.isInteger(rawRefreshDays) && rawRefreshDays >= 1 && rawRefreshDays <= 3650
      ? rawRefreshDays
      : null;
  return {
    defaultProfile,
    requireAgentToken,
    paused,
    turnRecall,
    ...(oauthRefreshTtlDays !== null ? { oauthRefreshTtlDays } : {}),
    ...(typeof raw?.agentFeedback === 'boolean' ? { agentFeedback: raw.agentFeedback } : {}),
    ...(dismissedBuiltins.length > 0 ? { dismissedBuiltins } : {}),
    ...(accessSets.length > 0 ? { accessSets } : {}),
  };
}

function publicSettings(settings) {
  return {
    defaultProfile: settings.defaultProfile,
    requireAgentToken: settings.requireAgentToken,
    paused: Boolean(settings.paused),
    turnRecall: Boolean(settings.turnRecall),
    // Absent: permanent refresh tokens (default). Present: explicit TTL in days (1..3650).
    ...(Number.isInteger(settings.oauthRefreshTtlDays) && settings.oauthRefreshTtlDays >= 1
      ? { oauthRefreshTtlDays: settings.oauthRefreshTtlDays }
      : {}),
    // Absent: the owner has not decided (lib/feedback.mjs).
    ...(typeof settings.agentFeedback === 'boolean' ? { agentFeedback: settings.agentFeedback } : {}),
    ...(Array.isArray(settings.accessSets) ? { accessSets: settings.accessSets } : {}),
  };
}

function filedProject(raw) {
  const id = typeof raw === 'string' && !PROFILE_CONTROL_RE.test(raw) ? normalizeProfileTag(raw) : '';
  return id && id !== 'all' ? id : null;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonicalValue(value[key]);
    }
    return out;
  }
  return value;
}

export function normalizeAgentModules(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) return null;
  const out = {};
  let hasAny = false;
  for (const key of AGENT_MODULE_KEYS) {
    if (typeof raw[key] === 'boolean') {
      out[key] = raw[key];
      hasAny = true;
    }
  }
  return hasAny ? out : null;
}

function validateAgentModules(raw) {
  if (raw === undefined || raw === null) return;
  if (!isPlainObject(raw)) {
    throw httpError('modules must be an object or null.', 400);
  }
  for (const [key, val] of Object.entries(raw)) {
    if (!AGENT_MODULE_KEY_SET.has(key)) {
      throw httpError(`Unknown module "${key}". Allowed: ${AGENT_MODULE_KEYS.join(', ')}.`, 400);
    }
    if (typeof val !== 'boolean') {
      throw httpError(`Module "${key}" must be a boolean.`, 400);
    }
  }
}

function normalizeApprovalTtlSeconds(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_APPROVAL_TTL_SECONDS || n > MAX_APPROVAL_TTL_SECONDS) return null;
  return n;
}

function validateApprovalTtlSeconds(raw) {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < MIN_APPROVAL_TTL_SECONDS || raw > MAX_APPROVAL_TTL_SECONDS) {
    throw httpError(`approvalTtlSeconds must be an integer between ${MIN_APPROVAL_TTL_SECONDS} and ${MAX_APPROVAL_TTL_SECONDS}, or null.`, 400);
  }
}

function validateHostApprovalDelegation(raw) {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== 'string' || !AGENT_HOST_APPROVAL_DELEGATION_SET.has(raw)) {
    throw httpError(`hostApprovalDelegation must be one of: ${AGENT_HOST_APPROVAL_DELEGATIONS.join(', ')}.`, 400);
  }
}

export function agentRightsDigest(agent) {
  if (!agent || typeof agent !== 'object') return '';
  const payload = canonicalValue({
    profile: agent.profile || 'all',
    canManage: agent.canManage === true,
    memoryAccess: agent.memoryAccess || 'read_write',
    secrets: Array.isArray(agent.secrets) ? [...agent.secrets].sort() : [],
    allowedConnections: Array.isArray(agent.allowedConnections) ? [...agent.allowedConnections].sort() : null,
    allowedSkills: Array.isArray(agent.allowedSkills) ? [...agent.allowedSkills].sort() : null,
    toolGrants: agent.toolGrants ?? null,
    modules: agent.modules ?? null,
    accessSet: agent.accessSet ?? null,
    approvalMode: agent.approvalMode ?? null,
    hostApprovalDelegation: agent.hostApprovalDelegation || 'none',
    accountChoice: isPlainObject(agent.accountChoice) ? agent.accountChoice : {},
  });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function normalizeAgent(raw, existing = []) {
  const name = String(raw?.name || '').trim().slice(0, 80) || 'Agent';
  const id =
    typeof raw?.id === 'string' && /^[a-z0-9_]+$/.test(raw.id) ? raw.id : uniqueId(name, existing);
  const kind = AGENT_KIND_SET.has(raw?.kind) ? raw.kind : 'other';
  const mode = AGENT_MODES.has(raw?.mode) ? raw.mode : 'default';
  const toolMode = AGENT_TOOL_MODE_SET.has(raw?.toolMode) ? raw.toolMode : 'gateway';
  const profile = normalizeProfileTag(raw?.profile) || 'all';
  const canManage = Boolean(raw?.canManage);
  const memoryAccess = AGENT_MEMORY_ACCESS.has(raw?.memoryAccess)
    ? raw.memoryAccess
    : canManage
      ? 'read_write'
      : 'read';
  return {
    id,
    name,
    kind,
    profile,
    // The drawer that Home shows this agent in. It never limits what the agent can reach; `profile` does.
    project: filedProject(raw?.project),
    picture: normalizePicture(raw?.picture),
    mode,
    toolMode,
    ...(normalizeAgentModules(raw?.modules) ? { modules: normalizeAgentModules(raw.modules) } : {}),
    canManage,
    memoryAccess,
    secrets: normalizeStringList(raw?.secrets)
      .filter((k) => AGENT_SECRET_KEY_PATTERN.test(k) && !k.startsWith('__'))
      .slice(0, MAX_SECRETS_PER_AGENT),
    allowedConnections: normalizeOptionalAllowlist(raw?.allowedConnections),
    ...(raw?.toolGrants != null ? { toolGrants: raw.toolGrants } : {}),
    allowedSkills: normalizeOptionalAllowlist(raw?.allowedSkills),
    accessSet: typeof raw?.accessSet === 'string' && raw.accessSet.trim() ? raw.accessSet.trim().toLowerCase().slice(0, 64) : null,
    approvalMode: AGENT_APPROVAL_MODES.includes(raw?.approvalMode) ? raw.approvalMode : null,
    ...(normalizeApprovalTtlSeconds(raw?.approvalTtlSeconds) !== null ? { approvalTtlSeconds: normalizeApprovalTtlSeconds(raw.approvalTtlSeconds) } : {}),
    ...(raw?.hostApprovalDelegation === 'low_risk_ask' ? { hostApprovalDelegation: 'low_risk_ask' } : {}),
    accountChoice: normalizeAccountChoice(raw?.accountChoice),
    rateLimitPerMin: Number.isInteger(raw?.rateLimitPerMin) && raw.rateLimitPerMin > 0 ? Math.min(raw.rateLimitPerMin, 10_000) : null,
    enabled: raw?.enabled !== undefined ? Boolean(raw.enabled) : true,
    turnRecall: typeof raw?.turnRecall === 'boolean' ? raw.turnRecall : null,
    oauthClientId: typeof raw?.oauthClientId === 'string' && raw.oauthClientId.trim() ? raw.oauthClientId.trim() : null,
    tokenHash: typeof raw?.tokenHash === 'string' ? raw.tokenHash : null,
    tokenHashes: Array.isArray(raw?.tokenHashes) ? raw.tokenHashes.filter((h) => typeof h === 'string' && h.length > 0).slice(-20) : [],
    recallTokenHash: typeof raw?.recallTokenHash === 'string' ? raw.recallTokenHash : null,
    tokenHint: typeof raw?.tokenHint === 'string' ? raw.tokenHint : null,
    createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  };
}

// What a new agent may do when nobody chose: save memories, and manage Connections (local commands,
// address changes and deletes still ask the owner). An agent that the owner limited to a Project or
// to picked items does not manage Connections. A stored agent keeps the rights that it has.
export function newAgentRights(input) {
  const limited =
    (normalizeProfileTag(input?.profile) || 'all') !== 'all' ||
    Array.isArray(input?.allowedConnections) ||
    Array.isArray(input?.allowedSkills);
  return {
    canManage: input?.canManage === undefined ? !limited : input.canManage,
    memoryAccess: input?.memoryAccess === undefined ? 'read_write' : input.memoryAccess,
  };
}

// Catalog search tools are shown at the top level unless the owner has chosen their own pins.
export function defaultPinnedTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map((t) => (typeof t === 'string' ? t : t?.name))
    .filter((name) => typeof name === 'string' && /(^|_)(catalog_search|search_catalog)$/i.test(name))
    .slice(0, 2);
}

const ACCEPTED_ACCESS = Symbol('synced access revision');

function stampAccess(previous, next) {
  if (previous.enabled === next.enabled && JSON.stringify(previous.allowedTools) === JSON.stringify(next.allowedTools)
      && JSON.stringify(previous.disabledTools) === JSON.stringify(next.disabledTools)) return;
  const counter = parseInt(previous.accessRevision?.split(':')[1] || '0', 16) + 1;
  next.accessRevision = '00000000:' + counter.toString(16).padStart(12, '0') + ':' + randomBytes(12).toString('hex');
}

export function isToolEnabled(conn, toolName) {
  if (Array.isArray(conn?.allowedTools) && conn.allowedTools.length > 0) {
    if (!conn.allowedTools.includes(toolName)) return false;
  }
  return !Array.isArray(conn?.disabledTools) || !conn.disabledTools.includes(toolName);
}

// The pins in effect: the owner's own list once they have set one (even an empty one), and the
// defaults until then. Defaults are worked out here and never saved, so they cannot overwrite a choice.
export function effectivePinnedTools(conn) {
  const saved = Array.isArray(conn?.pinnedTools) ? conn.pinnedTools : [];
  if (conn?.pinsCustomized === true || saved.length > 0) return saved;
  return defaultPinnedTools(Array.isArray(conn?.tools) ? conn.tools : conn?.toolNames);
}

// Icons a connection declares about itself (MCP serverInfo.icons): an https address or an inline image.
function normalizeServerIcons(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const icon of raw) {
    const src = typeof icon?.src === 'string' ? icon.src.trim() : '';
    if (!src || src.length > 350_000) continue;
    if (!/^https:\/\//i.test(src) && !/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);/i.test(src)) continue;
    out.push({
      src,
      ...(typeof icon.mimeType === 'string' ? { mimeType: icon.mimeType.slice(0, 60) } : {}),
      ...(Array.isArray(icon.sizes) ? { sizes: icon.sizes.filter((x) => typeof x === 'string').slice(0, 8).map((x) => x.slice(0, 20)) } : {}),
      ...(icon.theme === 'light' || icon.theme === 'dark' ? { theme: icon.theme } : {}),
    });
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeWebsiteUrl(raw) {
  if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw.trim())) return null;
  try {
    return new URL(raw.trim()).href.slice(0, 500);
  } catch {
    return null;
  }
}

function normalizeSyncFailures(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function normalizeSyncWarnings(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const val = item.trim().slice(0, 500);
    if (val && !seen.has(val)) {
      seen.add(val);
      out.push(val);
    }
    if (out.length >= 20) break;
  }
  return out;
}

function isSafeCatalogId(connId) {
  return typeof connId === 'string' && SAFE_CATALOG_ID_RE.test(connId);
}

function resolveCatalogPath(catalogsDir, connId) {
  if (!isSafeCatalogId(connId)) {
    throw httpError('Invalid connection ID for catalog path.', 400);
  }
  const base = path.resolve(catalogsDir);
  const full = path.resolve(base, `${connId}.json`);
  if (path.dirname(full) !== base) {
    throw httpError('Invalid connection ID for catalog path.', 400);
  }
  return full;
}

function emptyCatalog() {
  return {
    tools: [],
    resources: [],
    prompts: [],
    skills: [],
    serverInstructions: '',
    syncWarnings: [],
    syncVersion: 0,
  };
}

function normalizeCatalog(raw) {
  if (!isPlainObject(raw)) return emptyCatalog();
  return {
    tools: normalizeTools(raw.tools),
    resources: normalizeResources(raw.resources),
    prompts: normalizePrompts(raw.prompts),
    skills: normalizeUpstreamSkills(raw.skills),
    serverInstructions: normalizeServerInstructions(raw.serverInstructions),
    syncWarnings: normalizeSyncWarnings(raw.syncWarnings),
    syncVersion: Number.isInteger(raw.syncVersion) && raw.syncVersion > 0 ? raw.syncVersion : 0,
  };
}

function extractCatalog(conn) {
  return normalizeCatalog({
    tools: conn?.tools,
    resources: conn?.resources,
    prompts: conn?.prompts,
    skills: conn?.skills,
    serverInstructions: conn?.serverInstructions,
    syncWarnings: conn?.syncWarnings,
    syncVersion: conn?.syncVersion,
  });
}

function isEmptyCatalog(catalog) {
  return (
    catalog.tools.length === 0 &&
    catalog.resources.length === 0 &&
    catalog.prompts.length === 0 &&
    (!Array.isArray(catalog.skills) || catalog.skills.length === 0) &&
    catalog.serverInstructions === '' &&
    catalog.syncWarnings.length === 0 &&
    catalog.syncVersion === 0
  );
}

function catalogsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function hasInlineCatalogFields(raw) {
  if (!isPlainObject(raw)) return false;
  for (const field of CATALOG_FIELDS) {
    if (raw[field] !== undefined) return true;
  }
  return false;
}

function extractToolNames(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const name =
      typeof item === 'string'
        ? item.trim()
        : item && typeof item === 'object' && typeof item.name === 'string'
          ? item.name.trim()
          : '';
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function toHotConnection(conn) {
  const hot = { ...conn };
  const toolNames = Array.isArray(conn?.tools)
    ? extractToolNames(conn.tools)
    : extractToolNames(conn?.toolNames);
  for (const field of CATALOG_FIELDS) {
    delete hot[field];
  }
  hot.toolNames = toolNames;
  return hot;
}

function applyCatalogToConnection(conn, catalog) {
  const hydrated = {
    ...conn,
    tools: catalog.tools,
    resources: catalog.resources,
    prompts: catalog.prompts,
    skills: Array.isArray(catalog.skills) ? catalog.skills : [],
    serverInstructions: catalog.serverInstructions,
    syncVersion: catalog.syncVersion,
  };
  delete hydrated.toolNames;
  if (catalog.syncWarnings.length > 0) {
    hydrated.syncWarnings = catalog.syncWarnings;
  } else {
    delete hydrated.syncWarnings;
  }
  return hydrated;
}

function normalizeHotConnection(raw, existing = []) {
  const name = String(raw?.name || raw?.id || 'MCP').trim() || 'MCP';
  const id =
    isValidConnectionId(raw?.id) && !existing.some((m) => m.id === raw.id)
      ? raw.id
      : uniqueId(name, existing);

  let transport = 'http';
  try {
    transport = resolveTransport(raw || {});
  } catch {
    transport = raw?.command && !raw?.url ? 'stdio' : 'http';
  }

  const isStdio = transport === 'stdio';
  const isBuiltin = transport === 'builtin';
  const url =
    isStdio || isBuiltin ? null : typeof raw?.url === 'string' && raw.url.trim() ? raw.url.trim() : null;
  const command = isStdio
    ? typeof raw?.command === 'string' && raw.command.trim()
      ? raw.command.trim()
      : null
    : null;

  const inlineCatalog = hasInlineCatalogFields(raw) ? extractCatalog(raw) : null;
  let toolNames = inlineCatalog
    ? extractToolNames(inlineCatalog.tools)
    : extractToolNames(raw?.toolNames);
  if (isBuiltin && toolNames.length === 0) {
    toolNames = extractToolNames(listBuiltinTools(id));
  }

  const hot = {
    id,
    name,
    description: normalizeDescription(raw?.description),
    ...(normalizeAccountLabel(raw?.accountLabel) ? { accountLabel: normalizeAccountLabel(raw?.accountLabel) } : {}),
    ...(normalizeAgentNote(raw?.agentNote) ? { agentNote: normalizeAgentNote(raw?.agentNote) } : {}),
    ...(typeof raw?.specUrl === 'string' && raw.specUrl.trim() ? { specUrl: raw.specUrl.trim().slice(0, 2048) } : {}),
    ...(isPlainObject(raw?.apiOperations) ? { apiOperations: structuredClone(raw.apiOperations) } : {}),
    serverIcons: normalizeServerIcons(raw?.serverIcons),
    websiteUrl: normalizeWebsiteUrl(raw?.websiteUrl),
    ...(typeof raw?.serverVersion === 'string' && raw.serverVersion.trim()
      ? { serverVersion: raw.serverVersion.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 80) }
      : {}),
    transport,
    url,
    headers: isStdio || isBuiltin ? {} : normalizeHeaders(raw?.headers),
    command,
    args: isStdio ? normalizeArgs(raw?.args) : [],
    env: isStdio ? normalizeEnv(raw?.env) : {},
    cwd: isStdio && typeof raw?.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : null,
    profiles: normalizeConnectionProfiles(raw?.profiles),
    ...(raw?.projectToolGrants ? { projectToolGrants: normalizeProjectToolGrants(raw.projectToolGrants) } : {}),
    enabled: raw?.enabled !== undefined ? Boolean(raw.enabled) : true,
    partnerSkillsEnabled: raw?.partnerSkillsEnabled === true,
    disabledTools: normalizeStringList(raw?.disabledTools),
    ...(raw?.accessRevision ? { accessRevision: raw.accessRevision } : {}),
    allowedTools: Array.isArray(raw?.allowedTools) ? normalizeStringList(raw.allowedTools) : null,
    pinnedTools: normalizeStringList(raw?.pinnedTools),
    // Saved before pin choices were tracked: a non-empty list is a choice, an empty one is not.
    pinsCustomized: typeof raw?.pinsCustomized === 'boolean'
      ? raw.pinsCustomized
      : normalizeStringList(raw?.pinnedTools).length > 0,
    toolNames,
    oauth: normalizeOAuth(raw?.oauth),
    authRequired: Boolean(raw?.authRequired),
    // A real tool call was turned away for sign-in; a tool listing alone no longer counts as signed in.
    signInRejectedCall: Boolean(raw?.signInRejectedCall),
    // Why a sign-in could not even start (no automatic sign-in, bad setup). Agents read it and
    // connect the app another way; the dashboard shows a plain message instead of the raw error.
    signInBroken: typeof raw?.signInBroken === 'string' && raw.signInBroken ? raw.signInBroken.slice(0, 300) : null,
    // Non-secret metadata pointing to an owner-saved Vault login an agent can use to sign in.
    agentLogin: normalizeAgentLogin(raw?.agentLogin),
    lastSyncAt: typeof raw?.lastSyncAt === 'string' ? raw.lastSyncAt : null,
    lastSyncAttemptAt: typeof raw?.lastSyncAttemptAt === 'string' ? raw.lastSyncAttemptAt : null,
    syncFailures: normalizeSyncFailures(raw?.syncFailures),
    lastError: typeof raw?.lastError === 'string' ? raw.lastError : null,
    createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    ...(raw?.remoteAccess === 'local_only' || raw?.remoteAccess === 'ask_approval' || raw?.remoteAccess === 'remote_auto'
      ? { remoteAccess: raw.remoteAccess }
      : {}),
    ...(raw?.home === 'cloud' || raw?.home === 'local' ? { home: raw.home } : {}),
    ...(typeof raw?.toolSetupId === 'string' && raw.toolSetupId.trim() ? { toolSetupId: raw.toolSetupId.trim().slice(0, 64) } : {}),
    ...(isPlainObject(raw?.installSpec) ? { installSpec: structuredClone(raw.installSpec) } : {}),
  };
  const addedBy = normalizeAddedBy(raw?.addedBy);
  if (addedBy) hot.addedBy = addedBy;

  return { hot, inlineCatalog };
}

function normalizeAgentLogin(raw) {
  if (!isPlainObject(raw)) return null;
  const vaultKey = typeof raw.vaultKey === 'string' ? raw.vaultKey.trim() : '';
  if (!vaultKey || vaultKey.startsWith('__') || !AGENT_SECRET_KEY_PATTERN.test(vaultKey)) return null;
  const rawOrigin = typeof raw.origin === 'string' ? raw.origin.trim() : '';
  if (!rawOrigin || rawOrigin.length > 2048) return null;
  let origin;
  try {
    const parsed = new URL(rawOrigin);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return null;
    origin = parsed.origin.toLowerCase();
  } catch {
    return null;
  }
  const username = typeof raw.username === 'string' && !/[\u0000-\u001f\u007f]/.test(raw.username)
    ? raw.username.trim().slice(0, 320)
    : '';
  const savedAt = typeof raw.savedAt === 'string' && raw.savedAt ? raw.savedAt : null;
  return {
    vaultKey,
    origin,
    ...(username ? { username } : {}),
    ...(savedAt ? { savedAt } : {}),
  };
}

function normalizeConnection(raw, existing = []) {
  const { hot, inlineCatalog } = normalizeHotConnection(raw, existing);
  return applyCatalogToConnection(hot, inlineCatalog || emptyCatalog());
}

function buildNewEntry(input, existing) {
  if (!isPlainObject(input)) {
    throw httpError('Connection input is required.', 400);
  }

  if (typeof input.name !== 'string' || !input.name.trim()) {
    throw httpError('Name is required.', 400);
  }
  const cleanName = input.name.trim();

  const enabled = input.enabled !== undefined ? validateBooleanField(input.enabled, 'enabled') : true;
  const partnerSkillsEnabled =
    input.partnerSkillsEnabled !== undefined
      ? validateBooleanField(input.partnerSkillsEnabled, 'partnerSkillsEnabled')
      : false;
  const authRequired =
    input.authRequired !== undefined ? validateBooleanField(input.authRequired, 'authRequired') : false;
  const allowedTools = validateAllowedToolsStrict(input.allowedTools);

  const transport = resolveTransport(input);
  let url = null;
  let headers = {};
  let command = null;
  let args = [];
  let env = {};
  let cwd = null;

  if (transport === 'builtin') {
    // Built-in connections do not require a URL or stdio command.
  } else if (transport === 'stdio') {
    if (typeof input.command !== 'string' || !input.command.trim()) {
      throw httpError('Command is required for stdio transport.', 400);
    }
    command = input.command.trim();
    args = input.args !== undefined ? validateArgsStrict(input.args) : [];
    env = input.env !== undefined ? validateEnvStrict(input.env) : {};
    cwd = validateCwdStrict(input.cwd);
  } else {
    url = validateHttpUrl(input.url);
    headers = input.headers !== undefined ? validateHeadersStrict(input.headers) : {};
  }

  const syncWarnings = normalizeSyncWarnings(input.syncWarnings);

  return {
    id: uniqueId(cleanName, existing),
    name: cleanName,
    description: normalizeDescription(input.description),
    ...(normalizeAccountLabel(input.accountLabel) ? { accountLabel: normalizeAccountLabel(input.accountLabel) } : {}),
    ...(normalizeAgentNote(input.agentNote) ? { agentNote: normalizeAgentNote(input.agentNote) } : {}),
    ...(typeof input.specUrl === 'string' && input.specUrl.trim() ? { specUrl: input.specUrl.trim().slice(0, 2048) } : {}),
    ...(isPlainObject(input.apiOperations) ? { apiOperations: structuredClone(input.apiOperations) } : {}),
    serverInstructions: normalizeServerInstructions(input.serverInstructions),
    serverIcons: normalizeServerIcons(input.serverIcons),
    websiteUrl: normalizeWebsiteUrl(input.websiteUrl),
    transport,
    url,
    headers,
    command,
    args,
    env,
    cwd,
    profiles: normalizeConnectionProfiles(input.profiles),
    enabled,
    partnerSkillsEnabled,
    disabledTools: normalizeStringList(input.disabledTools),
    allowedTools,
    pinnedTools: normalizeStringList(input.pinnedTools),
    pinsCustomized: typeof input.pinsCustomized === 'boolean'
      ? input.pinsCustomized
      : normalizeStringList(input.pinnedTools).length > 0,
    tools: normalizeTools(input.tools),
    resources: normalizeResources(input.resources),
    prompts: normalizePrompts(input.prompts),
    skills: normalizeUpstreamSkills(input.skills),
    ...(syncWarnings.length > 0 ? { syncWarnings } : {}),
    oauth: normalizeOAuth(input.oauth, { stripVaultBackedInline: true }),
    authRequired,
    agentLogin: normalizeAgentLogin(input.agentLogin),
    syncVersion: Number.isInteger(input.syncVersion) && input.syncVersion > 0 ? input.syncVersion : 0,
    lastSyncAt: typeof input.lastSyncAt === 'string' ? input.lastSyncAt : null,
    lastSyncAttemptAt: typeof input.lastSyncAttemptAt === 'string' ? input.lastSyncAttemptAt : null,
    syncFailures: normalizeSyncFailures(input.syncFailures),
    lastError: typeof input.lastError === 'string' ? input.lastError : null,
    createdAt: new Date().toISOString(),
    ...(normalizeAddedBy(input.addedBy) ? { addedBy: normalizeAddedBy(input.addedBy) } : {}),
    ...(input.remoteAccess === 'local_only' || input.remoteAccess === 'ask_approval' || input.remoteAccess === 'remote_auto'
      ? { remoteAccess: input.remoteAccess }
      : {}),
    ...(input.home === 'cloud' || input.home === 'local' ? { home: input.home } : {}),
    ...(typeof input.toolSetupId === 'string' && input.toolSetupId.trim() ? { toolSetupId: input.toolSetupId.trim().slice(0, 64) } : {}),
    ...(isPlainObject(input.installSpec) ? { installSpec: structuredClone(input.installSpec) } : {}),
  };
}

function applyConnectionPatch(current, patch) {
  if (!isPlainObject(patch)) {
    throw httpError('Update patch must be an object.', 400);
  }

  const next = { ...current };

  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim()) {
      throw httpError('Name is required.', 400);
    }
    next.name = patch.name.trim();
  }

  if (patch.description !== undefined) {
    next.description = normalizeDescription(patch.description);
  }
  if (patch.accountLabel !== undefined) {
    const clean = normalizeAccountLabel(patch.accountLabel);
    if (clean) next.accountLabel = clean;
    else delete next.accountLabel;
  }
  if (patch.agentNote !== undefined) {
    const clean = normalizeAgentNote(patch.agentNote);
    if (clean) next.agentNote = clean;
    else delete next.agentNote;
  }
  if (patch.specUrl !== undefined) {
    if (typeof patch.specUrl === 'string' && patch.specUrl.trim()) next.specUrl = patch.specUrl.trim().slice(0, 2048);
    else delete next.specUrl;
  }
  if (patch.apiOperations !== undefined) {
    if (isPlainObject(patch.apiOperations)) next.apiOperations = structuredClone(patch.apiOperations);
    else delete next.apiOperations;
  }

  if (patch.serverInstructions !== undefined) {
    next.serverInstructions = normalizeServerInstructions(patch.serverInstructions);
  }
  if (patch.serverIcons !== undefined) next.serverIcons = normalizeServerIcons(patch.serverIcons);
  if (patch.websiteUrl !== undefined) next.websiteUrl = normalizeWebsiteUrl(patch.websiteUrl);
  if (patch.serverVersion !== undefined) {
    const clean = typeof patch.serverVersion === 'string'
      ? patch.serverVersion.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 80)
      : '';
    if (clean) next.serverVersion = clean;
    else delete next.serverVersion;
  }

  if (patch.transport !== undefined || patch.type !== undefined) {
    next.transport = resolveTransport({
      transport: patch.transport,
      type: patch.type,
      command: patch.command ?? current.command,
      url: patch.url ?? current.url,
    });
  }

  if (next.transport === 'builtin') {
    next.url = null;
    next.headers = {};
    next.command = null;
    next.args = [];
    next.env = {};
    next.cwd = null;
  } else if (next.transport === 'stdio') {
    if (patch.command !== undefined || current.transport !== 'stdio') {
      const candidateCmd = patch.command !== undefined ? patch.command : next.command;
      if (typeof candidateCmd !== 'string' || !candidateCmd.trim()) {
        throw httpError('Command is required for stdio transport.', 400);
      }
      next.command = candidateCmd.trim();
    }
    if (patch.args !== undefined) next.args = validateArgsStrict(patch.args);
    if (patch.env !== undefined) next.env = validateEnvStrict(patch.env);
    if (patch.cwd !== undefined) {
      next.cwd = validateCwdStrict(patch.cwd);
    } else if (current.transport !== 'stdio') {
      next.cwd = null;
    }
    next.url = null;
    next.headers = {};
  } else {
    if (patch.url !== undefined || current.transport === 'stdio' || current.transport === 'builtin') {
      next.url = validateHttpUrl(patch.url !== undefined ? patch.url : next.url);
    }
    if (patch.headers !== undefined) next.headers = validateHeadersStrict(patch.headers);
    next.command = null;
    next.args = [];
    next.env = {};
    next.cwd = null;
  }

  if (patch.profiles !== undefined) next.profiles = normalizeConnectionProfiles(patch.profiles);
  if (patch.enabled !== undefined) next.enabled = validateBooleanField(patch.enabled, 'enabled');
  if (patch.partnerSkillsEnabled !== undefined) {
    next.partnerSkillsEnabled = validateBooleanField(patch.partnerSkillsEnabled, 'partnerSkillsEnabled');
  }
  if (patch.disabledTools !== undefined) {
    next.disabledTools = normalizeStringList(patch.disabledTools);
  }
  if (patch.allowedTools !== undefined) {
    next.allowedTools = validateAllowedToolsStrict(patch.allowedTools);
  }
  // Setting the pins, even to none, is the owner's choice and replaces the defaults for good.
  if (patch.pinnedTools !== undefined) {
    next.pinnedTools = normalizeStringList(patch.pinnedTools);
    next.pinsCustomized = true;
  }
  if (patch.tools !== undefined) next.tools = normalizeTools(patch.tools);
  if (patch.resources !== undefined) next.resources = normalizeResources(patch.resources);
  if (patch.prompts !== undefined) next.prompts = normalizePrompts(patch.prompts);
  if (patch.skills !== undefined) next.skills = normalizeUpstreamSkills(patch.skills, current.id);
  if (patch.syncWarnings !== undefined) {
    const normalizedWarnings = normalizeSyncWarnings(patch.syncWarnings);
    if (normalizedWarnings.length > 0) {
      next.syncWarnings = normalizedWarnings;
    } else {
      delete next.syncWarnings;
    }
  }
  if (patch.oauth !== undefined) {
    next.oauth =
      patch.oauth === null ? null : normalizeOAuth(patch.oauth, { stripVaultBackedInline: true });
  }
  if (patch.authRequired !== undefined) {
    next.authRequired = validateBooleanField(patch.authRequired, 'authRequired');
  }
  if (patch.signInRejectedCall !== undefined) {
    next.signInRejectedCall = validateBooleanField(patch.signInRejectedCall, 'signInRejectedCall');
  }
  // A new address or freshly supplied credentials get a fresh chance at sign-in.
  if (patch.signInBroken === undefined && (next.url !== current.url || patch.headers !== undefined || (patch.oauth !== undefined && patch.oauth !== null))) {
    next.signInBroken = null;
  }
  if (patch.signInRejectedCall === undefined && patch.headers !== undefined) {
    next.signInRejectedCall = false;
  }
  if (patch.signInBroken !== undefined) {
    next.signInBroken = typeof patch.signInBroken === 'string' && patch.signInBroken ? patch.signInBroken.slice(0, 300) : null;
  }
  if (patch.agentLogin !== undefined) {
    next.agentLogin = patch.agentLogin === null ? null : normalizeAgentLogin(patch.agentLogin);
  }
  if (patch.syncVersion !== undefined) {
    next.syncVersion = Number.isInteger(patch.syncVersion) && patch.syncVersion > 0 ? patch.syncVersion : 0;
  }
  if (patch.lastSyncAt !== undefined) next.lastSyncAt = patch.lastSyncAt ?? null;
  if (patch.lastSyncAttemptAt !== undefined) next.lastSyncAttemptAt = patch.lastSyncAttemptAt ?? null;
  if (patch.syncFailures !== undefined) next.syncFailures = normalizeSyncFailures(patch.syncFailures);
  if (patch.lastError !== undefined) next.lastError = patch.lastError ?? null;
  if (patch.addedBy !== undefined) {
    const addedBy = normalizeAddedBy(patch.addedBy);
    if (addedBy) next.addedBy = addedBy;
    else delete next.addedBy;
  }
  if (patch.remoteAccess !== undefined) {
    if (patch.remoteAccess === null || patch.remoteAccess === '') {
      delete next.remoteAccess;
    } else if (patch.remoteAccess === 'local_only' || patch.remoteAccess === 'ask_approval' || patch.remoteAccess === 'remote_auto') {
      next.remoteAccess = patch.remoteAccess;
    } else {
      throw httpError('remoteAccess must be "local_only", "ask_approval", or "remote_auto".', 400);
    }
  }
  if (patch.home !== undefined) {
    if (patch.home === null || patch.home === '') delete next.home;
    else if (patch.home === 'cloud' || patch.home === 'local') next.home = patch.home;
    else throw httpError('home must be "cloud" or "local".', 400);
  }
  if (patch.toolSetupId !== undefined) {
    if (patch.toolSetupId === null || patch.toolSetupId === '') delete next.toolSetupId;
    else if (typeof patch.toolSetupId === 'string') next.toolSetupId = patch.toolSetupId.trim().slice(0, 64);
  }
  if (patch.installSpec !== undefined) {
    if (patch.installSpec === null) delete next.installSpec;
    else if (isPlainObject(patch.installSpec)) next.installSpec = structuredClone(patch.installSpec);
    else throw httpError('installSpec must be an object or null.', 400);
  }

  // Preserve immutable identity fields.
  next.id = current.id;
  next.createdAt = current.createdAt;
  stampAccess(current, next);
  if (patch[ACCEPTED_ACCESS]) next.accessRevision = patch[ACCEPTED_ACCESS];
  return next;
}

function argsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function isDuplicateEntry(candidate, existingList) {
  if (candidate.transport === 'builtin') {
    return existingList.some((m) => m.transport === 'builtin' && m.id === candidate.id);
  }
  if (candidate.transport === 'stdio') {
    return existingList.some(
      (m) =>
        m.transport === 'stdio' &&
        m.command === candidate.command &&
        argsEqual(m.args || [], candidate.args || []),
    );
  }
  return existingList.some((m) => m.url && m.url === candidate.url);
}

function ensureBuiltinConnections(config) {
  const dismissed = new Set(
    Array.isArray(config?.settings?.dismissedBuiltins) ? config.settings.dismissedBuiltins : [],
  );
  for (const builtin of BUILTIN_CONNECTIONS) {
    if (!dismissed.has(builtin.id) && !config.mcps.some((m) => m.id === builtin.id)) {
      const { hot } = normalizeHotConnection(builtin, config.mcps);
      config.mcps.push(hot);
    }
  }
  return config;
}

export class LoopStore {
  constructor(dir = defaultDataDir(), opts = {}) {
    this.dir = dir;
    this.seedBuiltins = Boolean(opts?.seedBuiltins);
    this.file = path.join(dir, 'config.json');
    this.legacyFile = path.join(dir, 'mcps.json');
    this.catalogsDir = path.join(dir, 'catalogs');
    this._writeQueue = createWriteQueue();
    this._cache = null;
    this._catalogCache = new Map();
    this._migrated = false;
    this._migrationPromise = null;
    this._primaryWasCorrupt = false;
  }

  _withLock(fn) {
    return this._writeQueue(fn);
  }

  _catalogPath(connId) {
    return resolveCatalogPath(this.catalogsDir, connId);
  }

  async _catalogExists(connId) {
    if (!isSafeCatalogId(connId)) return false;
    try {
      await stat(this._catalogPath(connId));
      return true;
    } catch {
      return false;
    }
  }

  async _readCatalog(connId, { clone = true } = {}) {
    if (!isSafeCatalogId(connId)) return emptyCatalog();
    const filePath = this._catalogPath(connId);
    let st;
    try {
      st = await stat(filePath);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        this._catalogCache.delete(connId);
        return emptyCatalog();
      }
      throw err;
    }

    const cached = this._catalogCache.get(connId);
    if (
      cached &&
      cached.mtimeMs === st.mtimeMs &&
      cached.size === st.size &&
      cached.ino === st.ino
    ) {
      return clone ? structuredClone(cached.catalog) : cached.catalog;
    }

    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) {
        this._catalogCache.delete(connId);
        return emptyCatalog();
      }
      const catalog = normalizeCatalog(parsed);
      this._catalogCache.set(connId, {
        mtimeMs: st.mtimeMs,
        size: st.size,
        ino: st.ino,
        catalog: structuredClone(catalog),
      });
      return clone ? catalog : this._catalogCache.get(connId).catalog;
    } catch (err) {
      this._catalogCache.delete(connId);
      if (err?.code === 'ENOENT') return emptyCatalog();
      return emptyCatalog();
    }
  }

  async _writeCatalog(connId, catalog) {
    const filePath = this._catalogPath(connId);
    const normalized = normalizeCatalog(catalog);
    const payload = JSON.stringify(normalized, null, 2) + '\n';
    try {
      await atomicWriteFile(filePath, payload, {
        mode: 0o600,
        backup: false,
        fsync: true,
      });
    } catch (err) {
      this._catalogCache.delete(connId);
      throw err;
    }
    try {
      const st = await stat(filePath);
      this._catalogCache.set(connId, {
        mtimeMs: st.mtimeMs,
        size: st.size,
        ino: st.ino,
        catalog: structuredClone(normalized),
      });
    } catch {
      this._catalogCache.delete(connId);
    }
  }

  async _deleteCatalog(connId) {
    this._catalogCache.delete(connId);
    if (!isSafeCatalogId(connId)) return;
    const filePath = this._catalogPath(connId);
    try {
      await unlink(filePath);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  async _persistInlineCatalogs(inlineCatalogs, { excludeIds = null } = {}) {
    if (!inlineCatalogs || inlineCatalogs.size === 0) return;
    const writes = [];
    for (const [connId, catalog] of inlineCatalogs.entries()) {
      if (excludeIds && excludeIds.has(connId)) continue;
      writes.push(
        (async () => {
          if (!isEmptyCatalog(catalog) || (await this._catalogExists(connId))) {
            await this._writeCatalog(connId, catalog);
          }
        })(),
      );
    }
    if (writes.length > 0) {
      await Promise.all(writes);
    }
  }

  async _hydrateConnection(hotConn, inlineCatalogs = null, { clone = true } = {}) {
    let catalog;
    if (inlineCatalogs && inlineCatalogs.has(hotConn.id)) {
      const cat = inlineCatalogs.get(hotConn.id);
      catalog = clone ? structuredClone(cat) : cat;
    } else {
      catalog = await this._readCatalog(hotConn.id, { clone });
    }
    if (isBuiltinConnection(hotConn) && catalog.tools.length === 0) {
      const builtinTools = listBuiltinTools(hotConn.id);
      if (builtinTools.length > 0) {
        catalog = {
          ...catalog,
          tools: builtinTools,
          syncVersion: catalog.syncVersion || 3,
        };
      }
    }
    return applyCatalogToConnection(hotConn, catalog);
  }

  async _migrateLegacyInsideLock() {
    if (this._migrated) return;
    // Skip legacy migration if config.json or its backup already exists.
    try {
      await stat(this.file);
      this._migrated = true;
      return;
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        this._migrated = true;
        return;
      }
    }
    try {
      await stat(backupPathFor(this.file));
      this._migrated = true;
      return;
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        this._migrated = true;
        return;
      }
    }

    try {
      const legacyRaw = await readFile(this.legacyFile, 'utf8');
      const legacyData = JSON.parse(legacyRaw);
      const rawMcps = Array.isArray(legacyData?.mcps) ? legacyData.mcps : [];
      const mcps = [];
      for (const item of rawMcps) {
        mcps.push(normalizeConnection(item, mcps));
      }
      const migrated = {
        settings: { ...DEFAULT_SETTINGS, requireAgentToken: false },
        mcps,
        agents: [],
        profiles: [],
      };
      await this._save(migrated);
      this._migrated = true;
    } catch (err) {
      if (err?.code === 'ENOENT' || err instanceof SyntaxError) {
        this._migrated = true;
        return;
      }
      throw err;
    }
  }

  async _ensureMigrated({ locked = false } = {}) {
    if (this._migrated) return;
    if (locked) {
      await this._migrateLegacyInsideLock();
      return;
    }
    if (!this._migrationPromise) {
      this._migrationPromise = this._withLock(() => this._migrateLegacyInsideLock()).finally(() => {
        this._migrationPromise = null;
      });
    }
    await this._migrationPromise;
  }

  _normalizeHotConfigData(data) {
    // Installs from before agent keys existed keep working without keys until the
    // owner turns them on; brand-new installs require keys from the start.
    const settings = normalizeSettings({ requireAgentToken: false, ...(data?.settings || {}) });
    const rawMcps = Array.isArray(data?.mcps) ? data.mcps : [];
    const mcps = [];
    const inlineCatalogs = new Map();
    for (const item of rawMcps) {
      const { hot, inlineCatalog } = normalizeHotConnection(item, mcps);
      mcps.push(hot);
      if (inlineCatalog) {
        inlineCatalogs.set(hot.id, inlineCatalog);
      }
    }
    const agents = [];
    for (const item of Array.isArray(data?.agents) ? data.agents : []) {
      agents.push(normalizeAgent(item, agents));
    }
    const profiles = normalizeProfileRecords(data?.profiles);
    return { config: { settings, mcps, agents, profiles }, inlineCatalogs };
  }

  async _readHot({ locked = false } = {}) {
    await this._ensureMigrated({ locked });

    let st = null;
    try {
      st = await stat(this.file);
      if (
        !this._primaryWasCorrupt &&
        this._cache &&
        this._cache.mtimeMs === st.mtimeMs &&
        this._cache.size === st.size &&
        this._cache.ino === st.ino
      ) {
        return {
          config: structuredClone(this._cache.config),
          inlineCatalogs: new Map(
            Array.from(this._cache.inlineCatalogs.entries(), ([k, v]) => [k, structuredClone(v)]),
          ),
        };
      }
    } catch (err) {
      this._cache = null;
      if (err?.code !== 'ENOENT') throw err;
    }

    let res;
    try {
      res = await readJsonWithBackup(this.file, {
        validate: isValidConfigObject,
        fallbackToBackup: true,
      });
    } catch (err) {
      this._cache = null;
      throw err;
    }

    if (res.missing) {
      this._cache = null;
      this._primaryWasCorrupt = false;
      const base = {
        settings: { ...DEFAULT_SETTINGS },
        mcps: [],
        agents: [],
        profiles: [],
      };
      return {
        config: this.seedBuiltins ? ensureBuiltinConnections(base) : base,
        inlineCatalogs: new Map(),
      };
    }

    const { config: loaded, inlineCatalogs } = this._normalizeHotConfigData(res.data);
    if (this.seedBuiltins) ensureBuiltinConnections(loaded);

    if (res.recoveredFromBackup) {
      this._cache = null;
      this._primaryWasCorrupt = true;
      console.warn(`Recovered Loop configuration from backup (${backupPathFor(this.file)}).`);
      const repair = async () => {
        await this._persistInlineCatalogs(inlineCatalogs);
        await this._saveHot(loaded, { backup: false });
      };
      if (locked) {
        await repair().catch(() => {});
      } else {
        await this._withLock(async () => {
          try {
            const check = await readJsonWithBackup(this.file, {
              validate: isValidConfigObject,
              fallbackToBackup: false,
            });
            if (!check.missing && check.data) {
              this._primaryWasCorrupt = false;
              return;
            }
          } catch {
            // Primary is still corrupt; repair it from the valid backup.
          }
          await repair();
        }).catch(() => {});
      }
      return { config: loaded, inlineCatalogs };
    }

    this._primaryWasCorrupt = false;
    if (st) {
      this._cache = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        ino: st.ino,
        config: structuredClone(loaded),
        inlineCatalogs: new Map(
          Array.from(inlineCatalogs.entries(), ([k, v]) => [k, structuredClone(v)]),
        ),
      };
    }
    return { config: loaded, inlineCatalogs };
  }

  async _read({ locked = false, clone = true } = {}) {
    const { config, inlineCatalogs } = await this._readHot({ locked });
    const mcps = await Promise.all(
      config.mcps.map((conn) => this._hydrateConnection(conn, inlineCatalogs, { clone })),
    );
    return {
      settings: config.settings,
      mcps,
      agents: config.agents,
      profiles: config.profiles,
    };
  }

  async _load(opts) {
    return this._read(opts);
  }

  _buildHotConfigObject(config) {
    return {
      settings: normalizeSettings(config.settings),
      mcps: (Array.isArray(config.mcps) ? config.mcps : []).map(toHotConnection),
      agents: Array.isArray(config.agents) ? config.agents : [],
      profiles: normalizeProfileRecords(config.profiles),
    };
  }

  async _saveHot(config, { backup = true } = {}) {
    const normalized = this._buildHotConfigObject(config);
    const payload = JSON.stringify(normalized, null, 2) + '\n';
    if (Buffer.byteLength(payload, 'utf8') > MAX_CONFIG_BYTES) {
      throw Object.assign(new Error('Workspace configuration size limit exceeded.'), { status: 413 });
    }
    try {
      await atomicWriteFile(this.file, payload, {
        mode: 0o600,
        backup: backup && !this._primaryWasCorrupt,
        fsync: true,
      });
    } catch (err) {
      this._cache = null;
      throw err;
    }
    this._primaryWasCorrupt = false;
    try {
      const st = await stat(this.file);
      this._cache = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        ino: st.ino,
        config: structuredClone(normalized),
        inlineCatalogs: new Map(),
      };
    } catch {
      this._cache = null;
    }
  }

  async _save(config, { backup = true } = {}) {
    const mcps = Array.isArray(config.mcps) ? config.mcps : [];
    const writes = [];
    for (const conn of mcps) {
      if (!conn?.id) continue;
      const catalog = extractCatalog(conn);
      writes.push(
        (async () => {
          if (!isEmptyCatalog(catalog) || (await this._catalogExists(conn.id))) {
            await this._writeCatalog(conn.id, catalog);
          }
        })(),
      );
    }
    if (writes.length > 0) {
      await Promise.all(writes);
    }
    await this._saveHot(config, { backup });
  }

  async _commitConnectionUpdate(config, inlineCatalogs, idx, current, next) {
    const prevHot = config.mcps[idx];
    const nextHot = toHotConnection(next);
    const prevCatalog = extractCatalog(current);
    const nextCatalog = extractCatalog(next);

    const catalogChanged = !catalogsEqual(prevCatalog, nextCatalog);
    const shouldWriteCatalog =
      catalogChanged ||
      (!isEmptyCatalog(nextCatalog) && !(await this._catalogExists(next.id)));

    if (shouldWriteCatalog) {
      await this._writeCatalog(next.id, nextCatalog);
    }

    if (inlineCatalogs.size > 0) {
      await this._persistInlineCatalogs(inlineCatalogs, {
        excludeIds: shouldWriteCatalog ? new Set([next.id]) : null,
      });
    }

    config.mcps[idx] = nextHot;
    const hotChanged = JSON.stringify(prevHot) !== JSON.stringify(nextHot);
    if (hotChanged || inlineCatalogs.size > 0) {
      await this._saveHot(config);
    }
    return next;
  }

  async transaction(fn) {
    if (typeof fn !== 'function') {
      throw httpError('Transaction callback must be a function.', 400);
    }
    return this._withLock(async () => {
      const { config: hotConfig, inlineCatalogs } = await this._readHot({ locked: true });
      const hydratedMcps = await Promise.all(
        hotConfig.mcps.map((conn) => this._hydrateConnection(conn, inlineCatalogs)),
      );
      const cfg = {
        settings: hotConfig.settings,
        mcps: hydratedMcps,
        agents: hotConfig.agents,
        profiles: hotConfig.profiles,
      };
      const before = JSON.stringify(cfg);
      const beforeCatalogs = new Map(
        cfg.mcps.map((m) => [m.id, JSON.stringify(extractCatalog(m))]),
      );
      const beforeIds = new Set(cfg.mcps.map((m) => m.id));

      const result = await fn(cfg);

      const after = JSON.stringify(cfg);
      if (after !== before) {
        const afterIds = new Set();
        const catalogWrites = [];
        for (const conn of Array.isArray(cfg.mcps) ? cfg.mcps : []) {
          if (!conn?.id) continue;
          afterIds.add(conn.id);
          const nextCatalog = extractCatalog(conn);
          const nextJson = JSON.stringify(nextCatalog);
          const prevJson = beforeCatalogs.get(conn.id);
          const changed = prevJson !== nextJson;
          catalogWrites.push(
            (async () => {
              if (
                changed ||
                (!isEmptyCatalog(nextCatalog) && !(await this._catalogExists(conn.id)))
              ) {
                await this._writeCatalog(conn.id, nextCatalog);
              }
            })(),
          );
        }
        if (catalogWrites.length > 0) {
          await Promise.all(catalogWrites);
        }
        await this._saveHot(cfg);
        const removedIds = [];
        for (const id of beforeIds) {
          if (!afterIds.has(id)) removedIds.push(id);
        }
        if (removedIds.length > 0) {
          await Promise.all(removedIds.map((id) => this._deleteCatalog(id)));
        }
      }
      return result;
    });
  }

  async getSettings() {
    const { config } = await this._readHot();
    return publicSettings(config.settings);
  }

  async updateSettings(patch, { personal = false, knownProfilesOnly = false } = {}) {
    if (!isPlainObject(patch)) {
      throw httpError('Settings patch must be an object.', 400);
    }

    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      const next = { ...config.settings };

      if (patch.defaultProfile !== undefined) {
        if (typeof patch.defaultProfile !== 'string') {
          throw httpError('Default profile must be a non-empty string.', 400);
        }
        if (PROFILE_CONTROL_RE.test(patch.defaultProfile)) {
          throw httpError('Default profile contains invalid characters.', 400);
        }
        const trimmed = patch.defaultProfile.trim();
        if (trimmed.length > PROFILE_ID_MAX) {
          throw httpError('Default profile must be a non-empty string.', 400);
        }
        const clean = normalizeProfileTag(trimmed);
        if (!clean || clean.length > PROFILE_ID_MAX || FORBIDDEN_PROFILE_KEYS.has(clean)) {
          throw httpError('Default profile must be a non-empty string.', 400);
        }
        if (knownProfilesOnly && clean !== 'all') {
          const existingProfiles = new Set(['all']);
          for (const profile of config.profiles || []) {
            const tag = normalizeProfileTag(profile?.id);
            if (tag) existingProfiles.add(tag);
          }
          for (const mcp of config.mcps) {
            for (const p of connectionProjectIds(mcp)) {
              const tag = normalizeProfileTag(p);
              if (tag) existingProfiles.add(tag);
            }
          }
          if (!existingProfiles.has(clean)) {
            throw httpError(`Unknown profile "${clean}".`, 400);
          }
        }
        next.defaultProfile = clean;
      }
      if (patch.requireAgentToken !== undefined) {
        validateBooleanField(patch.requireAgentToken, 'requireAgentToken');
        if (personal === true && patch.requireAgentToken === false) {
          throw httpError('Loop requires a workspace agent key.', 400);
        }
        next.requireAgentToken = patch.requireAgentToken;
      }
      if (patch.paused !== undefined) {
        next.paused = validateBooleanField(patch.paused, 'paused');
      }
      if (patch.turnRecall !== undefined) {
        next.turnRecall = validateBooleanField(patch.turnRecall, 'turnRecall');
      }
      if (patch.agentFeedback === null) {
        next.agentFeedback = undefined;
      } else if (patch.agentFeedback !== undefined) {
        next.agentFeedback = validateBooleanField(patch.agentFeedback, 'agentFeedback');
      }
      if (patch.accessSets !== undefined) {
        if (!Array.isArray(patch.accessSets)) {
          throw httpError('accessSets must be an array.', 400);
        }
        next.accessSets = normalizeAccessSets(patch.accessSets);
      }
      if (patch.oauthRefreshTtlDays !== undefined) {
        if (patch.oauthRefreshTtlDays === null || patch.oauthRefreshTtlDays === 0 || patch.oauthRefreshTtlDays === '' || patch.oauthRefreshTtlDays === 'never') {
          next.oauthRefreshTtlDays = null;
        } else {
          const days = Number(patch.oauthRefreshTtlDays);
          if (!Number.isInteger(days) || days < 1 || days > 3650) {
            throw httpError('oauthRefreshTtlDays must be null (never expires) or an integer between 1 and 3650.', 400);
          }
          next.oauthRefreshTtlDays = days;
        }
      }

      await this._persistInlineCatalogs(inlineCatalogs);
      config.settings = next;
      await this._saveHot(config);
      return publicSettings(config.settings);
    });
  }

  async list(opts = {}) {
    const { mcps } = await this._read(opts);
    return mcps;
  }

  async get(id) {
    if (typeof id !== 'string' || !id) return null;
    const { config, inlineCatalogs } = await this._readHot();
    const found = config.mcps.find((m) => m.id === id);
    if (!found) return null;
    return this._hydrateConnection(found, inlineCatalogs);
  }

  async add(input, accessRevision = '') {
    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      if (config.mcps.length >= MAX_CONNECTIONS) {
        throw httpError('Maximum number of connections reached for this workspace.', 400);
      }
      const entry = buildNewEntry(input, config.mcps);
      if (accessRevision) {
        validateRevision(accessRevision, false);
        entry.accessRevision = accessRevision;
      }
      const catalog = extractCatalog(entry);
      let wroteCatalog = false;
      if (!isEmptyCatalog(catalog)) {
        await this._writeCatalog(entry.id, catalog);
        wroteCatalog = true;
      }
      try {
        await this._persistInlineCatalogs(inlineCatalogs);
        config.mcps.push(toHotConnection(entry));
        await this._saveHot(config);
      } catch (err) {
        if (wroteCatalog) {
          await this._deleteCatalog(entry.id).catch(() => {});
        }
        throw err;
      }
      return entry;
    });
  }

  async syncConnectionAccess(id, incoming) {
    if (incoming.accessRevision) validateRevision(incoming.accessRevision, false);
    return this.updateIf(id, (current) => current.url === incoming.url && current.transport === incoming.transport,
      (current) => {
        const local = current.accessRevision || '';
        const remote = incoming.accessRevision || '';
        const concurrent = local && remote && local !== remote && local.slice(0, 21) === remote.slice(0, 21);
        if (!concurrent && remote > local) {
          return { enabled: incoming.enabled, allowedTools: incoming.allowedTools, disabledTools: incoming.disabledTools,
            [ACCEPTED_ACCESS]: incoming.accessRevision };
        }
        if (!concurrent && (local || remote)) return null;
        // Before either copy tracked edits, keep every existing restriction on the first merge.
        const left = current.allowedTools || [], right = incoming.allowedTools || [];
        const allowedTools = left.length && right.length ? left.filter((name) => right.includes(name)) : left.length ? left : right;
        const enabled = current.enabled && incoming.enabled && !(left.length && right.length && !allowedTools.length);
        const disabledTools = [...new Set([...current.disabledTools, ...incoming.disabledTools])].sort();
        const patch = { enabled, allowedTools: allowedTools.length ? [...allowedTools].sort() : null, disabledTools };
        if (concurrent) {
          const counter = parseInt(local.split(':')[1], 16) + 1;
          const tie = createHash('sha256').update([local, remote].sort().join('/')).digest('hex').slice(0, 24);
          patch[ACCEPTED_ACCESS] = '00000000:' + counter.toString(16).padStart(12, '0') + ':' + tie;
        }
        return patch;
      });
  }

  async update(id, patch) {
    if (typeof id !== 'string' || !id) return null;
    if (!isPlainObject(patch)) {
      throw httpError('Update patch must be an object.', 400);
    }

    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      const idx = config.mcps.findIndex((m) => m.id === id);
      if (idx === -1) return null;

      const current = await this._hydrateConnection(config.mcps[idx], inlineCatalogs);
      const next = applyConnectionPatch(current, patch);
      return this._commitConnectionUpdate(config, inlineCatalogs, idx, current, next);
    });
  }

  // Atomic compare-and-swap connection update inside the store write lock.
  // Returns the updated connection if `predicate(current)` holds and a patch is returned,
  // or `null` if the connection is missing, the predicate fails, or `patchOrFn` returns null/undefined.
  async updateIf(id, predicate, patchOrFn) {
    if (typeof id !== 'string' || !id) return null;
    if (typeof predicate !== 'function') {
      throw httpError('Update predicate must be a function.', 400);
    }
    if (typeof patchOrFn !== 'function' && !isPlainObject(patchOrFn)) {
      throw httpError('Update patch must be an object or function.', 400);
    }

    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      const idx = config.mcps.findIndex((m) => m.id === id);
      if (idx === -1) return null;

      const current = await this._hydrateConnection(config.mcps[idx], inlineCatalogs);
      const allowed = await predicate(structuredClone(current));
      if (!allowed) return null;

      const patch =
        typeof patchOrFn === 'function' ? await patchOrFn(structuredClone(current)) : patchOrFn;
      if (patch === null || patch === undefined) return null;

      const next = applyConnectionPatch(current, patch);
      return this._commitConnectionUpdate(config, inlineCatalogs, idx, current, next);
    });
  }

  // Atomically toggles (or explicitly sets) a connection's enabled state inside the store lock.
  async toggle(id, explicitEnabled) {
    if (typeof id !== 'string' || !id) return null;
    if (explicitEnabled !== undefined) {
      validateBooleanField(explicitEnabled, 'enabled');
    }

    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      const idx = config.mcps.findIndex((m) => m.id === id);
      if (idx === -1) return null;

      const nextHot = {
        ...config.mcps[idx],
        enabled: explicitEnabled !== undefined ? explicitEnabled : !config.mcps[idx].enabled,
      };
      await this._persistInlineCatalogs(inlineCatalogs);
      stampAccess(config.mcps[idx], nextHot);
      config.mcps[idx] = nextHot;
      await this._saveHot(config);
      return this._hydrateConnection(nextHot);
    });
  }

  async remove(id) {
    if (typeof id !== 'string' || !id) return false;
    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      const removed = config.mcps.find((m) => m.id === id);
      if (!removed) return false;
      const next = config.mcps.filter((m) => m.id !== id);
      await this._persistInlineCatalogs(inlineCatalogs, { excludeIds: new Set([id]) });
      config.mcps = next;
      const serviceKey = serviceKeyOf(removed);
      repinAgentsAfterRemove(config.agents, serviceKey, id, accountsOfService(next, serviceKey)[0]?.id || null);
      if (id === BUILTIN_WEB_ID || isBuiltinConnection(removed)) {
        config.settings = {
          ...config.settings,
          dismissedBuiltins: normalizeStringList([
            ...(Array.isArray(config.settings?.dismissedBuiltins) ? config.settings.dismissedBuiltins : []),
            id,
          ]),
        };
      }
      await this._saveHot(config);
      await this._deleteCatalog(id);
      return true;
    });
  }

  async toggleTool(id, toolName, enabled) {
    const cleanTool = String(toolName || '').trim();
    if (!cleanTool) throw httpError('Tool name is required.', 400);
    if (typeof id !== 'string' || !id) return null;

    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      const idx = config.mcps.findIndex((m) => m.id === id);
      if (idx === -1) return null;

      const entry = { ...config.mcps[idx] };
      const disabled = new Set(entry.disabledTools || []);
      if (enabled) {
        disabled.delete(cleanTool);
      } else {
        disabled.add(cleanTool);
      }
      entry.disabledTools = Array.from(disabled);
      stampAccess(config.mcps[idx], entry);

      await this._persistInlineCatalogs(inlineCatalogs);
      config.mcps[idx] = entry;
      await this._saveHot(config);
      return this._hydrateConnection(entry);
    });
  }

  async pinTool(id, toolName, pinned) {
    const cleanTool = String(toolName || '').trim();
    if (!cleanTool) throw httpError('Tool name is required.', 400);
    if (typeof id !== 'string' || !id) return null;

    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      const idx = config.mcps.findIndex((m) => m.id === id);
      if (idx === -1) return null;

      // Start from the pins in effect, so unpinning a default sticks and pinning another tool keeps it.
      const hydrated = await this._hydrateConnection(config.mcps[idx], inlineCatalogs);
      const set = new Set(effectivePinnedTools(hydrated));
      if (pinned) set.add(cleanTool);
      else set.delete(cleanTool);
      hydrated.pinnedTools = Array.from(set);
      hydrated.pinsCustomized = true;

      await this._persistInlineCatalogs(inlineCatalogs);
      config.mcps[idx] = toHotConnection(hydrated);
      await this._saveHot(config);
      return hydrated;
    });
  }

  // Migrates legacy plaintext OAuth tokens/clientSecret stored inline in config.json into Vault
  // and strips them from both config.json and config.json.bak.
  async migrateLegacyOAuthSecrets(vault) {
    if (!vault || typeof vault.set !== 'function') {
      return { migrated: 0, connections: [] };
    }
    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      const migratedConnections = [];

      for (const conn of config.mcps) {
        const oauth = conn.oauth;
        if (!oauth || typeof oauth !== 'object') continue;
        const hasInlineAccess = typeof oauth.accessToken === 'string' && oauth.accessToken.length > 0;
        const hasInlineRefresh =
          typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0;
        const hasInlineClientSecret =
          typeof oauth.clientSecret === 'string' && oauth.clientSecret.length > 0;

        if (!hasInlineAccess && !hasInlineRefresh && !hasInlineClientSecret) continue;

        const label = conn.name || conn.id;
        if (hasInlineAccess) {
          const key = oauth.accessTokenVaultKey || `__oauth_access_${conn.id}`;
          await vault.set(key, oauth.accessToken, `OAuth access token for ${label}`);
          oauth.accessTokenVaultKey = key;
          delete oauth.accessToken;
        }
        if (hasInlineRefresh) {
          const key = oauth.refreshTokenVaultKey || `__oauth_refresh_${conn.id}`;
          await vault.set(key, oauth.refreshToken, `OAuth refresh token for ${label}`);
          oauth.refreshTokenVaultKey = key;
          delete oauth.refreshToken;
        }
        if (hasInlineClientSecret) {
          const key = oauth.clientSecretVaultKey || `__oauth_client_secret_${conn.id}`;
          await vault.set(key, oauth.clientSecret, `OAuth client secret for ${label}`);
          oauth.clientSecretVaultKey = key;
          oauth.clientSecret = null;
        }

        migratedConnections.push(conn.id);
      }

      if (migratedConnections.length > 0) {
        // Persist any legacy inline catalogs first, then save with backup:false so we never
        // copy plaintext secrets into config.json.bak, and refresh config.json.bak if present.
        await this._persistInlineCatalogs(inlineCatalogs);
        await this._saveHot(config, { backup: false });
        const bakFile = backupPathFor(this.file);
        if (existsSync(bakFile)) {
          const sanitized = JSON.stringify(this._buildHotConfigObject(config), null, 2) + '\n';
          await atomicWriteFile(bakFile, sanitized, {
            mode: 0o600,
            backup: false,
            fsync: true,
          }).catch(() => {});
        }
      }

      return { migrated: migratedConnections.length, connections: migratedConnections };
    });
  }

  // ---- Agents (each MCP client that connects to Loop gets its own identity) ----

  async validateOAuthToolGrants(grants, profile, hot = null, { appSignIns = null } = {}) {
    const entries = isPlainObject(grants) ? Object.entries(grants) : [];
    if (entries.length === 0 || entries.length > 50) throw httpError('Select at least one connection and its actions.', 400);
    const { config, inlineCatalogs } = hot || await this._readHot();
    for (const [id, names] of entries) {
      if (!Array.isArray(names) || !names.length) throw httpError('Select at least one action.', 400);
      validateAgentAllowlist(names, 'toolGrants');
      const stored = config.mcps.find(c => c.id === id && c.enabled && !c.authRequired);
      const conn = stored && projectToolConnection(await this._hydrateConnection(stored, inlineCatalogs), profile);
      const available = new Set(conn?.tools?.filter(tool => isToolEnabled(conn, tool.name)).map(tool => tool.name));
      if (conn && names.some(isNamedActionId)) {
        for (const action of listNamedActionsForConnection(conn, { appSignIns })) {
          available.add(action.id);
        }
      }
      if (!conn || names.some(name => !available.has(name))) {
        throw httpError('This connection or selected action is no longer available. Choose again.', 400);
      }
    }
  }

  // Issue the token and commit its rights together. A sibling token from an earlier grant
  // must never acquire a different set of rights during a second sign-in.
  async bindOAuthAgent({ name, kind, clientId, profile, access, defaultCanManage, tokenHash, tokenHint, appSignIns = null }, saveToken) {
    return this._withLock(async () => {
      const hot = await this._readHot({ locked: true });
      const agents = hot.config.agents;
      const index = clientId ? agents.findIndex(a => a.enabled && a.oauthClientId === clientId) : -1;
      const previous = agents[index];
      if (!previous && agents.length >= MAX_AGENTS) throw httpError('Maximum number of agents reached for this workspace.', 400);
      if (previous?.toolGrants && access && !access.toolGrants) {
        throw httpError('Choose actions explicitly to change this agent’s action grant.', 400);
      }
      const rights = { profile: previous?.toolGrants && !access ? previous.profile : profile };
      for (const field of ['canManage', 'memoryAccess', 'allowedConnections', 'allowedSkills', 'secrets', 'toolGrants', 'toolMode', 'modules', 'accessSet', 'approvalMode', 'accountChoice']) {
        if (access?.[field] !== undefined) rights[field] = access[field];
      }
      validateAgentModules(rights.modules);
      validateAgentAllowlist(rights.allowedConnections, 'allowedConnections');
      validateAgentAllowlist(rights.allowedSkills, 'allowedSkills');
      validateAgentSecrets(rights.secrets);
      const grants = rights.toolGrants ?? previous?.toolGrants;
      if (grants) await this.validateOAuthToolGrants(grants, rights.profile, hot, { appSignIns });
      let entry;
      if (previous) {
        entry = normalizeAgent({ ...previous, ...rights }, agents);
      } else {
        let displayName = name;
        for (let n = 2; agents.some(a => a.name.toLowerCase() === displayName.toLowerCase()); n++) {
          displayName = `${name.slice(0, 80 - String(n).length - 3)} (${n})`;
        }
        entry = normalizeAgent({
          name: displayName, kind, oauthClientId: clientId, ...rights,
          accountChoice: defaultAccountChoice(hot.config.mcps, rights.accountChoice),
          ...newAgentRights({ canManage: defaultCanManage, ...rights }),
        }, agents);
      }
      const sameRights = previous && Object.keys(rights).every(field => isDeepStrictEqual(entry[field], previous[field]));
      entry.tokenHashes = sameRights
        ? [...new Set([...previous.tokenHashes, previous.tokenHash, tokenHash].filter(Boolean))].slice(-20)
        : [];
      entry.tokenHash = tokenHash;
      entry.tokenHint = tokenHint;
      await this._persistInlineCatalogs(hot.inlineCatalogs);
      await saveToken(entry.id);
      if (previous) agents[index] = entry;
      else agents.push(entry);
      await this._saveHot(hot.config);
      return entry;
    });
  }

  // Renew an OAuth access token for an already-bound enabled agent.
  // Never creates a new agent, never re-enables a disabled agent, and never overwrites permissions.
  async renewOAuthAgentToken({ agentId = null, clientId, expectedRightsDigest = null, tokenHash, tokenHint, appSignIns = null }, saveToken) {
    const invalidGrant = (msg) =>
      Object.assign(new Error(msg), { status: 400, oauthError: 'invalid_grant', oauthDescription: msg });
    if (typeof clientId !== 'string' || !clientId.trim()) {
      throw invalidGrant('Refresh token is missing client_id.');
    }
    const cleanClientId = clientId.trim();
    return this._withLock(async () => {
      const hot = await this._readHot({ locked: true });
      const agents = hot.config.agents;
      const index = agentId
        ? agents.findIndex((a) => a.id === agentId)
        : agents.findIndex((a) => a.oauthClientId === cleanClientId);
      const current = index === -1 ? null : agents[index];
      if (!current || current.enabled === false || current.oauthClientId !== cleanClientId) {
        throw invalidGrant('Agent access was removed or disabled. Re-authenticate the agent.');
      }
      const hasActiveToken = Boolean(current.tokenHash) || (Array.isArray(current.tokenHashes) && current.tokenHashes.length > 0);
      if (!hasActiveToken) {
        throw invalidGrant('Agent token was revoked. Re-authenticate the agent.');
      }
      if (expectedRightsDigest && agentRightsDigest(current) !== expectedRightsDigest) {
        throw invalidGrant('Agent permissions changed. Re-authenticate the agent.');
      }
      if (current.toolGrants) {
        try {
          await this.validateOAuthToolGrants(current.toolGrants, current.profile || 'all', hot, { appSignIns });
        } catch {
          throw invalidGrant('Agent action grant is no longer available. Re-authenticate the agent.');
        }
      }
      const others = agents.filter((a) => a.id !== current.id);
      const entry = normalizeAgent({ ...current }, others);
      entry.createdAt = current.createdAt;
      entry.tokenHashes = [...new Set([...(current.tokenHashes || []), current.tokenHash, tokenHash].filter(Boolean))].slice(-20);
      entry.tokenHash = tokenHash;
      entry.tokenHint = tokenHint;
      await this._persistInlineCatalogs(hot.inlineCatalogs);
      await saveToken(entry.id);
      agents[index] = entry;
      await this._saveHot(hot.config);
      return entry;
    });
  }

  async listAgents() {
    const { config } = await this._readHot();
    return config.agents;
  }

  async getAgent(id) {
    if (typeof id !== 'string' || !id) return null;
    const { config } = await this._readHot();
    return config.agents.find((a) => a.id === id) || null;
  }

  async addAgent(input) {
    if (!isPlainObject(input)) throw httpError('Agent input is required.', 400);
    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw httpError('Agent name must be a non-empty string.', 400);
    }
    if (input.canManage !== undefined) validateBooleanField(input.canManage, 'canManage');
    if (input.enabled !== undefined) validateBooleanField(input.enabled, 'enabled');
    if (input.turnRecall !== undefined && input.turnRecall !== null) {
      validateBooleanField(input.turnRecall, 'turnRecall');
    }
    validateAgentSecrets(input.secrets);
    validateAgentAllowlist(input.allowedConnections, 'allowedConnections');
    validateAgentAllowlist(input.allowedSkills, 'allowedSkills');
    validateAgentModules(input.modules);
    validateApprovalTtlSeconds(input.approvalTtlSeconds);
    validateHostApprovalDelegation(input.hostApprovalDelegation);

    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      if (config.agents.length >= MAX_AGENTS) {
        throw httpError('Maximum number of agents reached for this workspace.', 400);
      }
      const { id: _ignored, ...rest } = input;
      // A new Agent starts on the first account of every service that has several.
      rest.accountChoice = defaultAccountChoice(config.mcps, rest.accountChoice);
      const entry = normalizeAgent({ ...rest, ...newAgentRights(rest) }, config.agents);
      entry.createdAt = new Date().toISOString();
      await this._persistInlineCatalogs(inlineCatalogs);
      config.agents.push(entry);
      await this._saveHot(config);
      return entry;
    });
  }

  async updateAgent(id, patch) {
    if (typeof id !== 'string' || !id) return null;
    if (!isPlainObject(patch)) {
      throw httpError('Agent patch must be an object.', 400);
    }
    if (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name.trim())) {
      throw httpError('Agent name must be a non-empty string.', 400);
    }
    if (patch.canManage !== undefined) validateBooleanField(patch.canManage, 'canManage');
    if (patch.enabled !== undefined) validateBooleanField(patch.enabled, 'enabled');
    if (patch.turnRecall !== undefined && patch.turnRecall !== null) {
      validateBooleanField(patch.turnRecall, 'turnRecall');
    }
    if (patch.secrets !== undefined) validateAgentSecrets(patch.secrets);
    if (patch.allowedConnections !== undefined) validateAgentAllowlist(patch.allowedConnections, 'allowedConnections');
    if (patch.allowedSkills !== undefined) validateAgentAllowlist(patch.allowedSkills, 'allowedSkills');
    if (patch.modules !== undefined) validateAgentModules(patch.modules);
    if (patch.approvalTtlSeconds !== undefined) validateApprovalTtlSeconds(patch.approvalTtlSeconds);
    if (patch.hostApprovalDelegation !== undefined) validateHostApprovalDelegation(patch.hostApprovalDelegation);

    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      const idx = config.agents.findIndex((a) => a.id === id);
      if (idx === -1) return null;
      const current = config.agents[idx];
      const merged = { ...current };
      for (const field of ['name', 'kind', 'profile', 'project', 'picture', 'mode', 'toolMode', 'modules', 'canManage', 'memoryAccess', 'secrets', 'allowedConnections', 'allowedSkills', 'accessSet', 'approvalMode', 'approvalTtlSeconds', 'hostApprovalDelegation', 'accountChoice', 'rateLimitPerMin', 'enabled', 'turnRecall', 'oauthClientId', 'tokenHash', 'tokenHashes', 'recallTokenHash', 'tokenHint']) {
        if (patch[field] !== undefined) merged[field] = patch[field];
      }
      const others = config.agents.filter((a) => a.id !== id);
      const next = normalizeAgent({ ...merged, id: current.id }, others);
      next.createdAt = current.createdAt;
      await this._persistInlineCatalogs(inlineCatalogs);
      config.agents[idx] = next;
      await this._saveHot(config);
      return next;
    });
  }

  // Compare the presented hash under the write lock so a late disconnect cannot revoke a new sign-in.
  async revokeOAuthToken(clientId, hash) {
    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      const agent = config.agents.find((item) => item.oauthClientId === clientId &&
        (item.tokenHash === hash || item.tokenHashes.includes(hash)));
      if (!agent) return null;
      agent.tokenHashes = agent.tokenHashes.filter((value) => value !== hash);
      if (agent.tokenHash === hash) {
        agent.tokenHash = null;
        agent.tokenHint = null;
      }
      await this._persistInlineCatalogs(inlineCatalogs);
      await this._saveHot(config);
      return agent;
    });
  }

  // Shares one more Vault key with an agent. Reads and writes under the lock, so a grant
  // made at the same time as an owner's edit keeps both.
  async grantAgentSecret(id, key) {
    if (typeof id !== 'string' || !id) return null;
    validateAgentSecrets([key]);
    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      const idx = config.agents.findIndex((a) => a.id === id);
      if (idx === -1) return null;
      const current = config.agents[idx];
      if (current.secrets.includes(key)) return current;
      if (current.secrets.length >= MAX_SECRETS_PER_AGENT) {
        throw httpError(`An agent can be granted at most ${MAX_SECRETS_PER_AGENT} secrets.`, 409);
      }
      const others = config.agents.filter((a) => a.id !== id);
      const next = normalizeAgent({ ...current, secrets: [...current.secrets, key] }, others);
      next.createdAt = current.createdAt;
      await this._persistInlineCatalogs(inlineCatalogs);
      config.agents[idx] = next;
      await this._saveHot(config);
      return next;
    });
  }

  // The owner added another account of a service (Add account). Every Agent without a choice for that
  // service stays on the first account, and the Agents the owner picked move to the new one.
  async adoptAccount(connId, agentIds = []) {
    if (typeof connId !== 'string' || !connId) return null;
    const picked = new Set((Array.isArray(agentIds) ? agentIds : []).filter((id) => typeof id === 'string'));
    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      const conn = config.mcps.find((m) => m.id === connId);
      if (!conn || conn.transport === 'builtin') return null;
      const key = serviceKeyOf(conn);
      const first = accountsOfService(config.mcps, key).find((m) => m.id !== connId);
      if (first) pinAgentsToDefaultAccount(config.agents.filter((a) => !picked.has(a.id)), key, first.id);
      const moved = [];
      for (const agent of config.agents) {
        if (!picked.has(agent.id)) continue;
        agent.accountChoice = { ...(agent.accountChoice || {}), [key]: connId };
        moved.push(agent.id);
      }
      await this._persistInlineCatalogs(inlineCatalogs);
      await this._saveHot(config);
      return { key, moved };
    });
  }

  // Makes one account of a multi-account service the default for future agents without moving agents
  // that already have a pinned choice.
  async setDefaultAccount(connId) {
    if (typeof connId !== 'string' || !connId) return null;
    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      const idx = config.mcps.findIndex((m) => m.id === connId);
      if (idx === -1) return null;
      const conn = config.mcps[idx];
      if (!conn || conn.transport === 'builtin') return null;
      const key = serviceKeyOf(conn);
      const siblings = accountsOfService(config.mcps, key);
      const prevFirst = siblings[0];
      if (prevFirst && siblings.length > 1) {
        // Keep any previously unpinned agents on the former default so changing default only affects new agents.
        pinAgentsToDefaultAccount(config.agents, key, prevFirst.id);
      }
      const firstIdx = config.mcps.findIndex((m) => m.transport !== 'builtin' && serviceKeyOf(m) === key);
      if (firstIdx !== -1 && firstIdx !== idx) {
        config.mcps.splice(idx, 1);
        config.mcps.splice(firstIdx, 0, conn);
      }
      await this._persistInlineCatalogs(inlineCatalogs);
      await this._saveHot(config);
      return { key, defaultConnectionId: conn.id };
    });
  }

  async removeAgent(id) {
    if (typeof id !== 'string' || !id) return false;
    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      const next = config.agents.filter((a) => a.id !== id);
      if (next.length === config.agents.length) return false;
      await this._persistInlineCatalogs(inlineCatalogs);
      config.agents = next;
      await this._saveHot(config);
      return true;
    });
  }

  // ---- Profiles (first-class workspace scoping) ----

  // This is a management operation: callers enforce the account authorization
  // and connection allowlist before requesting any catalog grants.
  // knownProject: the caller found the project in listNamedProjects (it may exist only as a Skill tag).
  // Puts exact tools, or a whole Connection (toolName "*"), into a project.
  async addProjectTools(projectId, selections, { knownProject = false } = {}) {
    const project = validateProfileId(projectId);
    if (!Array.isArray(selections) || !selections.length || selections.length > 100) {
      throw httpError('Select between 1 and 100 tools. For a whole Connection use one entry with toolName "*".', 400);
    }
    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      if (!knownProject && !config.profiles.some((p) => p.id === project) && !config.mcps.some((c) => connectionProjectIds(c).includes(project))) {
        throw httpError('Unknown project.', 404);
      }
      const grouped = new Map();
      for (const entry of selections) {
        if (!isPlainObject(entry) || typeof entry.connectionId !== 'string' || !entry.connectionId ||
            typeof entry.toolName !== 'string' || !entry.toolName) throw httpError('Invalid catalog tool.', 400);
        if (!grouped.has(entry.connectionId)) grouped.set(entry.connectionId, new Set());
        grouped.get(entry.connectionId).add(entry.toolName);
      }
      let added = 0, alreadyAvailable = 0, wholeAdded = 0;
      for (const [id, requested] of grouped) {
        const hot = config.mcps.find((c) => c.id === id);
        if (!hot?.enabled) throw httpError(`Connection "${id}" is ${hot ? 'off, so its tools are unavailable' : 'unavailable'}.`, 404);
        const conn = await this._hydrateConnection(hot, inlineCatalogs);
        const available = new Set(conn.tools.map((t) => t.name));
        if (requested.has('*') && !available.has('*')) {
          const count = conn.tools.filter((t) => isToolEnabled(conn, t.name)).length;
          if (hot.profiles.includes(project)) alreadyAvailable += count;
          else {
            hot.profiles = normalizeConnectionProfiles([...hot.profiles, project]);
            wholeAdded++;
            added += count;
          }
          requested.delete('*');
        }
        const grants = new Set(hot.projectToolGrants?.[project] || []);
        for (const name of requested) {
          if (!available.has(name) || !isToolEnabled(conn, name)) throw httpError(`Tool "${name}" is unavailable on Connection "${id}".`, 404);
          if (hot.profiles.includes(project) || grants.has(name)) alreadyAvailable++;
          else { grants.add(name); added++; }
        }
        if (grants.size) hot.projectToolGrants = { ...hot.projectToolGrants, [project]: [...grants].sort() };
      }
      if (added || wholeAdded) {
        await this._persistInlineCatalogs(inlineCatalogs);
        await this._saveHot(config);
      }
      return { project, added, alreadyAvailable, ...(wholeAdded ? { connectionsAdded: wholeAdded } : {}) };
    });
  }

  async listProfileRecords() {
    const { config } = await this._readHot();
    return structuredClone(config.profiles).sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
  }

  async getProfile(id) {
    if (typeof id !== 'string' || !id) return null;
    if (PROFILE_CONTROL_RE.test(id) || id.trim().length > PROFILE_ID_MAX) return null;
    const cleanId = normalizeProfileTag(id);
    if (!cleanId || cleanId === 'all') return null;
    const { config } = await this._readHot();
    const found = config.profiles.find((p) => p.id === cleanId);
    return found ? structuredClone(found) : null;
  }

  async createProfile(input = {}) {
    if (!isPlainObject(input)) {
      throw httpError('Profile input must be an object.', 400);
    }
    const name = validateProfileName(input.name);
    const description = validateProfileDescription(input.description);
    const repositoryUrl = normalizeProfileRepositoryUrl(input.repositoryUrl, { strict: true }) || '';
    const id = validateProfileId(input.id, { fallbackName: name });

    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      if (config.profiles.some((p) => p.id === id)) {
        throw httpError(`Profile "${id}" already exists.`, 409);
      }
      if (config.profiles.length >= MAX_PROFILES) {
        throw httpError(`Maximum number of profiles (${MAX_PROFILES}) reached for this workspace.`, 400);
      }
      const now = new Date().toISOString();
      const record = {
        id,
        name,
        description,
        ...(repositoryUrl ? { repositoryUrl } : {}),
        ...profileAppearance(input, true),
        createdAt: now,
        updatedAt: now,
      };
      await this._persistInlineCatalogs(inlineCatalogs);
      config.profiles.push(record);
      await this._saveHot(config);
      return structuredClone(record);
    });
  }

  async updateProfile(id, patch = {}) {
    const cleanId = validateProfileId(id);
    if (!isPlainObject(patch)) {
      throw httpError('Profile patch must be an object.', 400);
    }
    const appearance = profileAppearance(patch, true);
    const nextName = patch.name !== undefined ? validateProfileName(patch.name) : undefined;
    const nextDesc =
      patch.description !== undefined ? validateProfileDescription(patch.description) : undefined;
    const nextRepo =
      patch.repositoryUrl !== undefined
        ? normalizeProfileRepositoryUrl(patch.repositoryUrl, { strict: true })
        : undefined;

    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      const idx = config.profiles.findIndex((p) => p.id === cleanId);
      const now = new Date().toISOString();

      if (idx !== -1) {
        const current = config.profiles[idx];
        const next = {
          ...current,
          ...appearance,
          id: current.id,
          name: nextName !== undefined ? nextName : current.name,
          description: nextDesc !== undefined ? nextDesc : current.description,
          createdAt: current.createdAt,
          updatedAt: now,
        };
        if (nextRepo !== undefined) {
          if (nextRepo) next.repositoryUrl = nextRepo;
          else delete next.repositoryUrl;
        }
        await this._persistInlineCatalogs(inlineCatalogs);
        config.profiles[idx] = next;
        await this._saveHot(config);
        return structuredClone(next);
      }

      const referencedOnConnection = config.mcps.some(
        (mcp) =>
          connectionProjectIds(mcp).includes(cleanId),
      );
      const referencedOnAgent = config.agents.some(
        (agent) => normalizeProfileTag(agent.profile) === cleanId,
      );
      if (!referencedOnConnection && !referencedOnAgent) {
        return null;
      }
      if (config.profiles.length >= MAX_PROFILES) {
        throw httpError(`Maximum number of profiles (${MAX_PROFILES}) reached for this workspace.`, 400);
      }

      const promoted = {
        ...appearance,
        id: cleanId,
        name: nextName !== undefined ? nextName : cleanId,
        description: nextDesc !== undefined ? nextDesc : '',
        ...(nextRepo ? { repositoryUrl: nextRepo } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await this._persistInlineCatalogs(inlineCatalogs);
      config.profiles.push(promoted);
      await this._saveHot(config);
      return structuredClone(promoted);
    });
  }

  async deleteProfile(id) {
    const cleanId = validateProfileId(id);

    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });

      const hadRecord = config.profiles.some((p) => p.id === cleanId);
      if (hadRecord) {
        config.profiles = config.profiles.filter((p) => p.id !== cleanId);
      }

      const resetDefaultProfile = config.settings.defaultProfile === cleanId;
      if (resetDefaultProfile) {
        config.settings = { ...config.settings, defaultProfile: 'all' };
      }

      let updatedConnections = 0;
      for (let i = 0; i < config.mcps.length; i += 1) {
        const mcp = config.mcps[i];
        const currentProfiles = Array.isArray(mcp.profiles) ? mcp.profiles : ['all'];
        const hasToolGrants = Object.hasOwn(mcp.projectToolGrants || {}, cleanId);
        if (hasToolGrants || currentProfiles.some((p) => normalizeProfileTag(p) === cleanId)) {
          const nextProfiles = normalizeConnectionProfiles(
            currentProfiles.filter((p) => normalizeProfileTag(p) !== cleanId),
          );
          config.mcps[i] = { ...mcp, profiles: nextProfiles };
          if (hasToolGrants) {
            const remaining = { ...mcp.projectToolGrants };
            delete remaining[cleanId];
            if (Object.keys(remaining).length) config.mcps[i].projectToolGrants = remaining;
            else delete config.mcps[i].projectToolGrants;
          }
          updatedConnections += 1;
        }
      }

      // SECURITY INVARIANT: disable agents bound to the deleted profile and NEVER
      // widen agent.profile to 'all' (keep agent.profile === cleanId).
      let referencedAgents = 0;
      const disabledAgents = [];
      for (let i = 0; i < config.agents.length; i += 1) {
        const agent = config.agents[i];
        if (normalizeProfileTag(agent.profile) === cleanId) {
          referencedAgents += 1;
          if (agent.enabled !== false) {
            config.agents[i] = { ...agent, enabled: false };
            disabledAgents.push(agent.id);
          }
        }
      }

      // An agent that was only filed in this project stays as it is, in no project.
      let unfiledAgents = 0;
      config.agents = config.agents.map((agent) => {
        if (agent.project !== cleanId) return agent;
        unfiledAgents += 1;
        return { ...agent, project: null };
      });

      if (!hadRecord && !resetDefaultProfile && updatedConnections === 0 && referencedAgents === 0 && unfiledAgents === 0) {
        return null;
      }

      if (hadRecord || resetDefaultProfile || updatedConnections > 0 || disabledAgents.length > 0 || unfiledAgents > 0) {
        await this._persistInlineCatalogs(inlineCatalogs);
        await this._saveHot(config);
      }

      return {
        deleted: true,
        id: cleanId,
        disabledAgents,
        updatedConnections,
      };
    });
  }

  async listProfiles() {
    const { config } = await this._readHot();
    const tags = new Set();
    for (const profile of config.profiles || []) {
      const clean = normalizeProfileTag(profile?.id);
      if (clean && clean !== 'all') tags.add(clean);
    }
    for (const mcp of config.mcps) {
      for (const p of connectionProjectIds(mcp)) {
        const clean = normalizeProfileTag(p);
        if (clean && clean !== 'all') tags.add(clean);
      }
    }
    return ['all', ...Array.from(tags).sort((a, b) => a.localeCompare(b))];
  }

  async importMcpJson(raw, { profile = 'all' } = {}) {
    let parsed;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw httpError('Invalid JSON input.', 400);
      }
    } else {
      parsed = raw;
    }

    if (!isPlainObject(parsed)) {
      throw httpError('MCP config must be a JSON object.', 400);
    }

    const serversMap =
      parsed.mcpServers && isPlainObject(parsed.mcpServers)
        ? parsed.mcpServers
        : parsed;

    return this._withLock(async () => {
      const { config, inlineCatalogs } = await this._readHot({ locked: true });
      const added = [];
      const skipped = [];

      for (const [rawName, cfg] of Object.entries(serversMap)) {
        const name = String(rawName || '').trim();
        if (!name || !isPlainObject(cfg)) {
          skipped.push({ name: name || '(unnamed)', reason: 'Invalid server entry.' });
          continue;
        }

        if (config.mcps.length >= MAX_CONNECTIONS) {
          skipped.push({
            name,
            reason: 'Maximum number of connections reached for this workspace.',
          });
          continue;
        }

        const candidateInput = {
          name,
          transport: cfg.transport ?? cfg.type,
          url: cfg.url ?? cfg.serverUrl ?? null,
          headers: cfg.headers,
          command: cfg.command ?? null,
          args: cfg.args,
          env: cfg.env,
          ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}),
          ...(cfg.enabled !== undefined ? { enabled: cfg.enabled } : {}),
          ...(cfg.disabledTools !== undefined
            ? { disabledTools: cfg.disabledTools }
            : cfg.excludeTools !== undefined
              ? { disabledTools: cfg.excludeTools }
              : {}),
          ...(cfg.allowedTools !== undefined
            ? { allowedTools: cfg.allowedTools }
            : cfg.includeTools !== undefined
              ? { allowedTools: cfg.includeTools }
              : {}),
          profiles: [...(Array.isArray(cfg.profiles) ? cfg.profiles : []), profile],
        };

        if (containsVaultRef(candidateInput)) {
          skipped.push({
            name,
            reason: 'Imported MCP configs cannot reference Vault secrets directly.',
          });
          continue;
        }

        let entry;
        try {
          entry = buildNewEntry(candidateInput, config.mcps);
        } catch (err) {
          skipped.push({ name, reason: err?.message || 'Invalid server configuration.' });
          continue;
        }

        if (isDuplicateEntry(entry, config.mcps)) {
          skipped.push({ name, reason: 'Already exists.' });
          continue;
        }

        config.mcps.push(toHotConnection(entry));
        added.push(entry);
      }

      if (added.length > 0) {
        await this._persistInlineCatalogs(inlineCatalogs);
        const newCatalogWrites = [];
        for (const entry of added) {
          const catalog = extractCatalog(entry);
          if (!isEmptyCatalog(catalog)) {
            newCatalogWrites.push(this._writeCatalog(entry.id, catalog));
          }
        }
        if (newCatalogWrites.length > 0) {
          await Promise.all(newCatalogWrites);
        }
        await this._saveHot(config);
      }

      return { added, skipped };
    });
  }
}
