// Loop MCP OAuth 2.1 Authorization Server (RFC 9728 + RFC 8414 + RFC 7591 + PKCE S256).
// Lets MCP clients (Claude Code, Cursor, Codex, Antigravity, VS Code, etc.) click
// "Authenticate", sign in to Loop in the browser, approve access, and receive a real
// workspace agent key (loop_...) without copying tokens by hand.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import {
  DEFAULT_LOOP_PORT,
  atomicWriteFile,
  atomicWriteFileSync,
  createWriteQueue,
  readJsonWithBackupSync,
} from './json-file-store.mjs';
import { createOutboundPolicy } from './outbound-policy.mjs';
import { PROFILE_CONTROL_RE, normalizeProfileTag } from './profiles.mjs';

// Registered OAuth clients are global (one per agent install via Dynamic Client
// Registration). Hosted deployments serve many users, so the default is high and
// operators can tune it with LOOP_MAX_OAUTH_CLIENTS.
const DEFAULT_MAX_CLIENTS = 10_000;
const envMaxClients = Number.parseInt(String(process.env.LOOP_MAX_OAUTH_CLIENTS || ''), 10);
export const MAX_CLIENTS = Number.isInteger(envMaxClients) && envMaxClients > 0 ? envMaxClients : DEFAULT_MAX_CLIENTS;
const MAX_PENDING = 200;
const MAX_PENDING_PER_CLIENT = 10;
const MAX_CODES = 200;
const MAX_HANDOFFS = 200;
export const MAX_CODES_PER_WORKSPACE = 50;
export const MAX_REDIRECT_URIS_PER_CLIENT = 10;
export const MAX_REDIRECT_URI_LENGTH = 512;
export const MAX_REGISTRATIONS_PER_IP = 20;
export const MAX_AUTHORIZE_PER_IP = 60;
const MAX_AUTHORIZE_PER_CLIENT = 60;
const MAX_REFRESH_TOKENS = 10_000;
const MAX_USED_REFRESH_TOKENS = 10_000;
const MAX_CIMD_CACHE = 2_000;
const MAX_CIMD_BYTES = 32 * 1024;
const CIMD_DEFAULT_TTL_MS = 5 * 60 * 1000;
const CIMD_MIN_TTL_MS = 60 * 1000;
const CIMD_MAX_TTL_MS = 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_RATE_LIMIT_IPS = 10_000;
const CLIENT_PROTECTED_WINDOW_MS = 60 * 60 * 1000; // 1 hour
// An app that registered but whose sign-in nobody approved is dropped after this long, so
// abandoned attempts do not pile up and "sign-in not finished" only reflects recent tries.
// Long on purpose: an app that kept its client_id can still finish a sign-in it started weeks ago.
const UNCONFIRMED_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SAVE_DEBOUNCE_MS = 500;
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const HANDOFF_RETAIN_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_SCOPE = 'mcp:tools';
const TOO_MANY_REQUESTS_MSG = 'Too many active sign-in requests. Try again shortly.';
export const SUPPORTED_TOKEN_AUTH_METHODS = Object.freeze(['none', 'client_secret_basic', 'client_secret_post']);
const TOKEN_AUTH_METHOD_SET = new Set(SUPPORTED_TOKEN_AUTH_METHODS);

export function hashRefreshToken(token) {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function hashClientSecret(secret) {
  return createHash('sha256').update(String(secret || ''), 'utf8').digest('hex');
}

function timingSafeHexEqual(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string' || aHex.length === 0 || aHex.length !== bHex.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(aHex, 'utf8'), Buffer.from(bHex, 'utf8'));
}

export function normalizeRefreshTtlDays(raw) {
  if (raw === null || raw === undefined || raw === '' || raw === 0 || raw === '0' || raw === 'never') {
    return null;
  }
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 1 || num > 3650) {
    return undefined;
  }
  return num;
}

export function resolveEnvRefreshTtlMs(env = process.env) {
  const days = normalizeRefreshTtlDays(env?.LOOP_OAUTH_REFRESH_TTL_DAYS);
  return typeof days === 'number' && days > 0 ? days * 24 * 60 * 60 * 1000 : null;
}

export function parseBasicClientAuth(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const match = headerValue.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  let decoded;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx === -1) return null;
  const decodePart = (part) => {
    try {
      return decodeURIComponent(part.replace(/\+/g, '%20'));
    } catch {
      return part;
    }
  };
  return {
    clientId: decodePart(decoded.slice(0, idx)),
    clientSecret: decodePart(decoded.slice(idx + 1)),
  };
}

export function isCimdClientId(raw, { allowLoopback = false } = {}) {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed !== raw || trimmed.length > MAX_REDIRECT_URI_LENGTH || /[\s#]/.test(trimmed)) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.hash) return false;
  if (!parsed.pathname || parsed.pathname === '/') return false;
  if (parsed.protocol === 'https:') return Boolean(parsed.hostname);
  if (allowLoopback && parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) return true;
  return false;
}

// Explicit allowlist of known safe desktop MCP client URI schemes (G4a-08).
// Arbitrary OS protocol handlers (ms-msdt:, search-ms:, smb:, cmd:, shell:, etc.) are rejected.
export const ALLOWED_DESKTOP_REDIRECT_SCHEMES = Object.freeze(
  new Set([
    'claude:',
    'cursor:',
    'cursor-nightly:',
    'vscode:',
    'vscode-insiders:',
    'vscodium:',
    'windsurf:',
    'zed:',
    'antigravity:',
    'codex:',
    'opencode:',
    'raycast:',
    'muse:',
    'kimi:',
    'kiro:',
    'trae:',
    'goose:',
    'positron:',
    'openmausbot:',
    'mausbot:',
    'openbot:',
    'grok:',
    'loop:',
  ]),
);

const PKCE_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const WORKSPACE_ID_RE = /^[0-9a-f]{64}$/;
const SCOPED_MCP_RE = /^\/w\/([0-9a-f]{64})\/mcp$/;

export function isLoopbackHost(hostname) {
  const clean = String(hostname || '').toLowerCase();
  return clean === '127.0.0.1' || clean === 'localhost' || clean === '::1' || clean === '[::1]';
}

export function isValidRedirectUri(raw) {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed !== raw || trimmed.length > MAX_REDIRECT_URI_LENGTH || /[\s#]/.test(trimmed)) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  const proto = parsed.protocol.toLowerCase();
  if (parsed.username || parsed.password || parsed.hash) return false;
  if (proto === 'http:') {
    return isLoopbackHost(parsed.hostname);
  }
  if (proto === 'https:') {
    return Boolean(parsed.hostname);
  }
  return ALLOWED_DESKTOP_REDIRECT_SCHEMES.has(proto);
}

// RFC 8252 section 7.3: a native app listening on loopback picks a free port each time it
// signs in, so a loopback http redirect matches a registered one when everything but the
// port is the same. Every other redirect must match exactly.
export function redirectUriRegistered(registered, requested) {
  if (!Array.isArray(registered) || typeof requested !== 'string' || !requested) return false;
  if (registered.includes(requested)) return true;
  let want;
  try {
    want = new URL(requested);
  } catch {
    return false;
  }
  if (want.protocol !== 'http:' || !isLoopbackHost(want.hostname) || !isValidRedirectUri(requested)) return false;
  return registered.some((uri) => {
    let have;
    try {
      have = new URL(uri);
    } catch {
      return false;
    }
    return (
      have.protocol === 'http:' &&
      have.hostname === want.hostname &&
      have.pathname === want.pathname &&
      have.search === want.search
    );
  });
}

export function inferAgentKind(clientName) {
  const lower = String(clientName || '').trim().toLowerCase();
  if (/^grok[ -]?bot$/.test(lower)) return 'grok-bot';
  if (/^(?:meta muse|muse agent)$/.test(lower)) return 'meta-muse';
  if (lower === 'claude duet') return 'claude-duet';
  if (lower === 'openmausbot' || lower === 'openbot') return lower;
  if (/claude[\s_-]*code/.test(lower)) return 'claude-code';
  if (/claude/.test(lower)) return 'claude-desktop';
  if (/codex/.test(lower)) return 'codex';
  if (/kimi/.test(lower)) return 'kimi-code';
  if (/cursor/.test(lower)) return 'cursor';
  if (/antigravity/.test(lower)) return 'antigravity';
  if (/gemini/.test(lower)) return 'gemini';
  if (/vs[\s_-]*code|visual studio/.test(lower)) return 'vscode';
  if (/opencode/.test(lower)) return 'opencode';
  if (/windsurf/.test(lower)) return 'windsurf';
  if (/zed/.test(lower)) return 'zed';
  if (/\bmuse\b/.test(lower)) return 'muse';
  if (/\bpi\b/.test(lower)) return 'pi';
  return 'other';
}

function parseFirstForwardedElement(headerValue) {
  if (typeof headerValue !== 'string' || !headerValue.trim()) {
    return { proto: null, host: null };
  }
  // Extract the first comma-separated Forwarded element, respecting quoted strings.
  let first = '';
  let inQuotes = false;
  let escaped = false;
  for (let i = 0; i < headerValue.length; i += 1) {
    const ch = headerValue[i];
    if (escaped) {
      first += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inQuotes) {
      first += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      first += ch;
      continue;
    }
    if (ch === ',' && !inQuotes) break;
    first += ch;
  }

  let proto = null;
  let host = null;
  const parts = first.split(';');
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim().toLowerCase();
    let val = part.slice(eqIdx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    if (key === 'proto' && !proto) {
      const lowerProto = val.toLowerCase();
      if (lowerProto === 'http' || lowerProto === 'https') proto = lowerProto;
    } else if (key === 'host' && !host && val) {
      host = val.trim();
    }
  }
  return { proto, host };
}

function firstCommaToken(raw) {
  if (Array.isArray(raw)) raw = raw[0];
  if (typeof raw !== 'string') return '';
  return raw.split(',')[0].trim();
}

function buildValidatedOrigin(proto, rawHost) {
  if ((proto !== 'http' && proto !== 'https') || typeof rawHost !== 'string') return null;
  const host = rawHost.trim();
  if (!host || host.length > 255 || /[\s/\\?#@]/.test(host)) return null;
  try {
    const u = new URL(`${proto}://${host}`);
    if (
      (u.protocol !== 'http:' && u.protocol !== 'https:') ||
      !u.host ||
      u.username ||
      u.password ||
      u.pathname !== '/' ||
      u.search ||
      u.hash
    ) {
      return null;
    }
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

// Resolves Loop's canonical public origin for OAuth metadata & links (G4a-15).
// 1. Always honors a valid LOOP_PUBLIC_ORIGIN environment variable when set.
// 2. Otherwise parses RFC 7239 Forwarded or first comma-separated X-Forwarded-Proto /
//    X-Forwarded-Host (when proxy headers are present) and Host cleanly.
// 3. Falls back to http://127.0.0.1:<fallbackPort>.
export function resolvePublicOrigin(req, fallbackPort = DEFAULT_LOOP_PORT) {
  const configured = String(process.env.LOOP_PUBLIC_ORIGIN || '').trim();
  if (configured) {
    try {
      const u = new URL(configured);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        return u.origin.toLowerCase();
      }
    } catch {
      // Ignore invalid LOOP_PUBLIC_ORIGIN and fall through.
    }
  }

  const port =
    Number.isInteger(Number(fallbackPort)) && Number(fallbackPort) > 0
      ? Number(fallbackPort)
      : DEFAULT_LOOP_PORT;
  const fallback = `http://127.0.0.1:${port}`;
  const headers = req?.headers && typeof req.headers === 'object' ? req.headers : {};

  const forwarded = parseFirstForwardedElement(
    Array.isArray(headers.forwarded) ? headers.forwarded[0] : headers.forwarded,
  );
  const rawXProto = firstCommaToken(headers['x-forwarded-proto']).toLowerCase();
  const xProto = rawXProto === 'http' || rawXProto === 'https' ? rawXProto : null;
  const xHost = firstCommaToken(headers['x-forwarded-host']);
  const directHost = firstCommaToken(headers.host);
  const hasProxy = Boolean(
    headers.forwarded !== undefined ||
      headers['x-forwarded-proto'] !== undefined ||
      headers['x-forwarded-host'] !== undefined ||
      headers['x-forwarded-for'] !== undefined,
  );

  const socketProto = req?.socket?.encrypted ? 'https' : 'http';
  const proto = hasProxy ? (forwarded.proto || xProto || socketProto) : socketProto;
  const hostCandidates = hasProxy
    ? [forwarded.host, xHost, directHost]
    : [directHost];

  for (const candidate of hostCandidates) {
    if (!candidate) continue;
    const origin = buildValidatedOrigin(proto, candidate);
    if (origin) return origin;
  }

  return fallback;
}

function normalizeClientName(raw) {
  const clean = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return clean || 'MCP Client';
}

function normalizeScope(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_SCOPE;
  const clean = raw.replace(/\s+/g, ' ').trim().slice(0, 120);
  return clean || DEFAULT_SCOPE;
}

function parseResourcePath(rawResource, expectedOrigin) {
  if (!rawResource) return '/mcp';
  if (typeof rawResource !== 'string' || rawResource.length > 512) return null;
  let parsed;
  try {
    parsed = new URL(rawResource);
  } catch {
    return null;
  }
  const expected = new URL(expectedOrigin);
  const sameOrigin =
    parsed.origin === expected.origin ||
    (parsed.protocol === expected.protocol &&
      parsed.port === expected.port &&
      isLoopbackHost(parsed.hostname) &&
      isLoopbackHost(expected.hostname));
  if (!sameOrigin) return null;
  const p = parsed.pathname.replace(/\/+$/, '') || '/';
  if (p === '/mcp' || SCOPED_MCP_RE.test(p)) return p;
  return null;
}

function parseResourceProfile(rawResource) {
  if (!rawResource) return '';
  try {
    const parsed = new URL(String(rawResource));
    const raw = parsed.searchParams.get('profile');
    if (!raw || PROFILE_CONTROL_RE.test(raw)) return '';
    const clean = normalizeProfileTag(raw);
    return clean && clean !== 'all' ? clean : '';
  } catch {
    return '';
  }
}

function targetWorkspaceIdForPath(resourcePath) {
  const match = SCOPED_MCP_RE.exec(resourcePath || '');
  return match ? match[1] : null;
}

function verifyPkceS256(verifier, challenge) {
  if (typeof verifier !== 'string' || !PKCE_RE.test(verifier)) return false;
  if (typeof challenge !== 'string' || !PKCE_RE.test(challenge)) return false;
  const computed = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(challenge, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function appendQuery(baseUri, params) {
  const url = new URL(baseUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function oauthError(status, error, errorDescription) {
  return Object.assign(new Error(errorDescription || error), {
    status,
    oauthError: error,
    oauthDescription: errorDescription || error,
  });
}

export class McpOAuthServer {
  constructor(
    dataDir,
    {
      maxClients = MAX_CLIENTS,
      hostedRoot = false,
      saveDebounceMs = SAVE_DEBOUNCE_MS,
      clientProtectedWindowMs = CLIENT_PROTECTED_WINDOW_MS,
      unconfirmedClientTtlMs = UNCONFIRMED_CLIENT_TTL_MS,
      refreshTtlMs = undefined,
      refreshGraceMs = undefined,
      maxRegistrationsPerIp = undefined,
      maxAuthorizePerIp = undefined,
      maxAuthorizePerClient = MAX_AUTHORIZE_PER_CLIENT,
      allowLoopbackCimd = false,
      cimdFetch = null,
      outboundPolicy = null,
    } = {},
  ) {
    this.dataDir = dataDir ? path.resolve(dataDir) : null;
    this.clientsFile = this.dataDir ? path.join(this.dataDir, 'oauth-clients.json') : null;
    this.refreshFile = this.dataDir ? path.join(this.dataDir, 'oauth-refresh.json') : null;
    this.maxClients = Number.isInteger(maxClients) && maxClients > 0 ? maxClients : MAX_CLIENTS;
    // Hosted (useloop.sh): a sign-in for the plain /mcp resource belongs to whichever account
    // approves it, because there is no Mac workspace behind the public site.
    this.hostedRoot = hostedRoot === true;
    this.saveDebounceMs = Number.isFinite(saveDebounceMs) && saveDebounceMs >= 0 ? saveDebounceMs : SAVE_DEBOUNCE_MS;
    this.clientProtectedWindowMs =
      Number.isFinite(clientProtectedWindowMs) && clientProtectedWindowMs >= 0
        ? clientProtectedWindowMs
        : CLIENT_PROTECTED_WINDOW_MS;
    this.unconfirmedClientTtlMs =
      Number.isFinite(unconfirmedClientTtlMs) && unconfirmedClientTtlMs > 0
        ? unconfirmedClientTtlMs
        : UNCONFIRMED_CLIENT_TTL_MS;
    // Default refresh token lifetime is permanent (null) until revoked or disabled, unless
    // explicitly configured via option, workspace setting, or LOOP_OAUTH_REFRESH_TTL_DAYS.
    if (refreshTtlMs === null) {
      this.refreshTtlMs = null;
    } else if (typeof refreshTtlMs === 'number' && Number.isFinite(refreshTtlMs) && refreshTtlMs > 0) {
      this.refreshTtlMs = refreshTtlMs;
    } else {
      this.refreshTtlMs = resolveEnvRefreshTtlMs(process.env);
    }
    const envGraceMs = Number.parseInt(String(process.env.LOOP_OAUTH_REFRESH_GRACE_MS || ''), 10);
    const resolvedGrace =
      typeof refreshGraceMs === 'number' && Number.isFinite(refreshGraceMs) && refreshGraceMs >= 0
        ? refreshGraceMs
        : Number.isInteger(envGraceMs) && envGraceMs > 0
          ? envGraceMs
          : 0;
    this.refreshGraceMs = Math.min(resolvedGrace, 60_000);
    const envRegIp = Number.parseInt(String(process.env.LOOP_OAUTH_MAX_REGISTRATIONS_PER_IP || ''), 10);
    const envAuthIp = Number.parseInt(String(process.env.LOOP_OAUTH_MAX_AUTHORIZE_PER_IP || ''), 10);
    this.maxRegistrationsPerIp =
      Number.isInteger(maxRegistrationsPerIp) && maxRegistrationsPerIp > 0
        ? maxRegistrationsPerIp
        : Number.isInteger(envRegIp) && envRegIp > 0
          ? envRegIp
          : MAX_REGISTRATIONS_PER_IP;
    this.maxAuthorizePerIp =
      Number.isInteger(maxAuthorizePerIp) && maxAuthorizePerIp > 0
        ? maxAuthorizePerIp
        : Number.isInteger(envAuthIp) && envAuthIp > 0
          ? envAuthIp
          : MAX_AUTHORIZE_PER_IP;
    this.maxAuthorizePerClient =
      Number.isInteger(maxAuthorizePerClient) && maxAuthorizePerClient > 0
        ? maxAuthorizePerClient
        : MAX_AUTHORIZE_PER_CLIENT;
    this.allowLoopbackCimd = allowLoopbackCimd === true;
    this.cimdFetch = typeof cimdFetch === 'function' ? cimdFetch : null;
    this.outboundPolicy = outboundPolicy || null;
    this.clients = new Map();
    this.cimdCache = new Map(); // clientId -> { record, expiresAt }
    this.pending = new Map();
    this.codes = new Map();
    this.handoffs = new Map();
    this.refreshTokens = new Map(); // sha256(token) -> entry
    this.usedRefreshTokens = new Map(); // sha256(token) -> { familyId, usedAt }
    this._graceRefreshCache = new Map(); // sha256(oldToken) -> { expiresAt, clientId, workspaceId, result }
    this._registerHits = new Map();
    this._authorizeHits = new Map();
    this._authorizeClientHits = new Map();
    this._saveTimer = null;
    this._dirty = false;
    this._refreshSaveTimer = null;
    this._refreshDirty = false;
    this._writeQueue = createWriteQueue();
    this._loadClients();
    this._loadRefreshTokens();
  }

  _loadClients() {
    if (!this.clientsFile) return;
    try {
      const { data } = readJsonWithBackupSync(this.clientsFile, {
        validate: (d) => Boolean(d && typeof d === 'object' && Array.isArray(d.clients)),
      });
      const list = Array.isArray(data?.clients) ? data.clients : [];
      const valid = [];
      for (const item of list) {
        if (
          item &&
          typeof item.client_id === 'string' &&
          Array.isArray(item.redirect_uris) &&
          item.redirect_uris.length > 0 &&
          item.redirect_uris.length <= MAX_REDIRECT_URIS_PER_CLIENT &&
          item.redirect_uris.every(isValidRedirectUri)
        ) {
          const authMethod = TOKEN_AUTH_METHOD_SET.has(item.token_endpoint_auth_method)
            ? item.token_endpoint_auth_method
            : 'none';
          const secretHash =
            authMethod !== 'none' && typeof item.client_secret_hash === 'string' && /^[0-9a-f]{64}$/.test(item.client_secret_hash)
              ? item.client_secret_hash
              : null;
          if (authMethod !== 'none' && !secretHash) continue;
          valid.push({
            client_id: item.client_id,
            client_name: normalizeClientName(item.client_name),
            redirect_uris: [...item.redirect_uris],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: authMethod,
            ...(secretHash ? { client_secret_hash: secretHash } : {}),
            confirmed: item.confirmed === true,
            createdAt: Number(item.createdAt) || Date.now(),
          });
        }
      }
      // Preserve oldest-first order (keeping the newest maxClients) so restart evicts oldest first.
      valid.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      for (const record of valid.slice(-this.maxClients)) {
        this.clients.set(record.client_id, record);
      }
    } catch {
      // Ignore corrupted client cache; clients can re-register cleanly.
    }
  }

  _loadRefreshTokens() {
    if (!this.refreshFile) return;
    try {
      const { data } = readJsonWithBackupSync(this.refreshFile, {
        validate: (d) => Boolean(d && typeof d === 'object' && Array.isArray(d.tokens)),
      });
      const now = Date.now();
      for (const item of Array.isArray(data?.tokens) ? data.tokens : []) {
        if (!item || typeof item.hash !== 'string' || !/^[0-9a-f]{64}$/.test(item.hash)) continue;
        if (typeof item.familyId !== 'string' || !item.familyId || typeof item.clientId !== 'string' || !item.clientId) continue;
        const expiresAt = item.expiresAt === null || item.expiresAt === undefined
          ? null
          : Number.isFinite(Number(item.expiresAt))
            ? Number(item.expiresAt)
            : null;
        if (expiresAt !== null && expiresAt <= now) continue;
        this.refreshTokens.set(item.hash, {
          familyId: item.familyId,
          agentId: typeof item.agentId === 'string' && item.agentId ? item.agentId : null,
          rightsDigest: typeof item.rightsDigest === 'string' && item.rightsDigest ? item.rightsDigest : null,
          clientId: item.clientId,
          clientName: normalizeClientName(item.clientName),
          workspaceId: typeof item.workspaceId === 'string' && item.workspaceId ? item.workspaceId : null,
          scope: normalizeScope(item.scope),
          issuedAt: Number(item.issuedAt) || now,
          expiresAt,
        });
      }
      for (const used of Array.isArray(data?.used) ? data.used : []) {
        if (!used || typeof used.hash !== 'string' || !/^[0-9a-f]{64}$/.test(used.hash)) continue;
        if (typeof used.familyId !== 'string' || !used.familyId) continue;
        this.usedRefreshTokens.set(used.hash, {
          familyId: used.familyId,
          usedAt: Number(used.usedAt) || now,
        });
      }
    } catch {
      // Ignore corrupted refresh token cache; clients can re-authenticate cleanly.
    }
  }

  _serializeRefreshTokens() {
    const now = Date.now();
    const tokens = [];
    for (const [hash, entry] of this.refreshTokens) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) continue;
      tokens.push({ hash, ...entry });
    }
    const used = [];
    for (const [hash, info] of this.usedRefreshTokens) {
      const familyId = typeof info === 'string' ? info : info?.familyId;
      if (!familyId) continue;
      used.push({ hash, familyId, usedAt: typeof info === 'object' && info?.usedAt ? info.usedAt : now });
    }
    return JSON.stringify(
      { version: 1, tokens: tokens.slice(-MAX_REFRESH_TOKENS), used: used.slice(-MAX_USED_REFRESH_TOKENS) },
      null,
      2,
    ) + '\n';
  }

  _scheduleSaveRefreshTokens() {
    if (!this.refreshFile) return;
    this._refreshDirty = true;
    if (this._refreshSaveTimer !== null) return;
    this._refreshSaveTimer = setTimeout(() => {
      this._refreshSaveTimer = null;
      this._saveRefreshTokensAsync().catch(() => {});
    }, this.saveDebounceMs);
    this._refreshSaveTimer.unref?.();
  }

  async _saveRefreshTokensAsync() {
    if (!this.refreshFile || !this._refreshDirty) return;
    this._refreshDirty = false;
    const payload = this._serializeRefreshTokens();
    await this._writeQueue(async () => {
      try {
        await atomicWriteFile(this.refreshFile, payload, { mode: 0o600, fsync: false });
      } catch {
        // Best-effort persistence; in-memory refresh store still functions.
      }
    });
  }

  _serializeClients() {
    const entries = [...this.clients.values()]
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .slice(-this.maxClients);
    return JSON.stringify({ version: 1, clients: entries }, null, 2) + '\n';
  }

  _scheduleSaveClients() {
    if (!this.clientsFile) return;
    this._dirty = true;
    if (this._saveTimer !== null) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveClientsAsync().catch(() => {});
    }, this.saveDebounceMs);
    this._saveTimer.unref?.();
  }

  async _saveClientsAsync() {
    if (!this.clientsFile || !this._dirty) return;
    this._dirty = false;
    const payload = this._serializeClients();
    await this._writeQueue(async () => {
      try {
        await atomicWriteFile(this.clientsFile, payload, { mode: 0o600, fsync: false });
      } catch {
        // Best-effort persistence; in-memory registry still functions.
      }
    });
  }

  _saveClients() {
    if (this._saveTimer !== null) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._dirty = false;
    if (!this.clientsFile) return;
    try {
      atomicWriteFileSync(this.clientsFile, this._serializeClients(), { mode: 0o600 });
    } catch {
      // Best-effort persistence; in-memory registry still functions.
    }
  }

  async flush() {
    if (this._saveTimer !== null) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._refreshSaveTimer !== null) {
      clearTimeout(this._refreshSaveTimer);
      this._refreshSaveTimer = null;
    }
    if (this._dirty && this.clientsFile) {
      await this._saveClientsAsync();
    }
    if (this._refreshDirty && this.refreshFile) {
      await this._saveRefreshTokensAsync();
    }
    await this._writeQueue(async () => {});
  }

  _prune() {
    const now = Date.now();
    for (const [id, tx] of this.pending) {
      if (tx.expiresAt <= now) this.pending.delete(id);
    }
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt <= now) this.codes.delete(code);
    }
    for (const [txId, handoff] of this.handoffs) {
      if (handoff.status === 'waiting' && handoff.expiresAt <= now) {
        handoff.status = 'expired';
        handoff.updatedAt = now;
        handoff.retainUntil = Math.max(handoff.retainUntil || 0, now + HANDOFF_RETAIN_MS);
      }
      if ((handoff.retainUntil || 0) <= now) {
        this.handoffs.delete(txId);
      }
    }
    this._expireUnconfirmedClients(now);
  }

  _recordHandoff(txId, entry) {
    if (!this.handoffs.has(txId) && this.handoffs.size >= MAX_HANDOFFS) {
      const oldestKey = this.handoffs.keys().next().value;
      if (oldestKey !== undefined) this.handoffs.delete(oldestKey);
    }
    this.handoffs.set(txId, entry);
  }

  /** Client ids with a sign-in in flight (waiting for approval, or a code not yet exchanged). */
  _activeClientIds() {
    const active = new Set();
    for (const tx of this.pending.values()) active.add(tx.clientId);
    for (const entry of this.codes.values()) active.add(entry.clientId);
    return active;
  }

  /** Drops registrations nobody finished signing in with once they are older than the TTL. */
  _expireUnconfirmedClients(now = Date.now()) {
    let active = null;
    let dropped = false;
    for (const [id, client] of this.clients) {
      if (client.confirmed === true) continue;
      if (now - (Number(client.createdAt) || 0) < this.unconfirmedClientTtlMs) continue;
      active ||= this._activeClientIds();
      if (active.has(id)) continue;
      this.clients.delete(id);
      dropped = true;
    }
    if (dropped) this._scheduleSaveClients();
  }

  /**
   * Sign-ins an app started and nobody finished, one entry per app name:
   * { name, kind, attempts, lastAttemptAt }. Only tries made after that app's last approved
   * sign-in count, so an app that got in on a later try is not reported.
   */
  unfinishedSignIns() {
    this._prune();
    const lastApproved = new Map();
    for (const client of this.clients.values()) {
      if (client.confirmed !== true) continue;
      const key = client.client_name.toLowerCase();
      lastApproved.set(key, Math.max(lastApproved.get(key) || 0, Number(client.createdAt) || 0));
    }
    const groups = new Map();
    for (const client of this.clients.values()) {
      if (client.confirmed === true) continue;
      const key = client.client_name.toLowerCase();
      const at = Number(client.createdAt) || 0;
      if (at <= (lastApproved.get(key) || 0)) continue;
      const group = groups.get(key) || { name: client.client_name, attempts: 0, last: 0 };
      group.attempts += 1;
      if (at >= group.last) {
        group.last = at;
        group.name = client.client_name;
      }
      groups.set(key, group);
    }
    return [...groups.values()]
      .sort((a, b) => b.last - a.last)
      .map((group) => ({
        name: group.name,
        kind: inferAgentKind(group.name),
        attempts: group.attempts,
        lastAttemptAt: new Date(group.last).toISOString(),
      }));
  }

  /**
   * Forgets the unfinished sign-ins of one app name (the owner dismissed them). A sign-in that
   * is in flight right now is kept. Returns how many registrations were removed.
   */
  forgetUnfinishedSignIns(name) {
    this._prune();
    const key = normalizeClientName(name).toLowerCase();
    const active = this._activeClientIds();
    let removed = 0;
    for (const [id, client] of this.clients) {
      if (client.confirmed === true || active.has(id)) continue;
      if (client.client_name.toLowerCase() !== key) continue;
      this.clients.delete(id);
      removed += 1;
    }
    if (removed > 0) this._scheduleSaveClients();
    return removed;
  }

  _consumeIpRateLimit(bucket, clientIp, maxHits, now = Date.now()) {
    if (typeof clientIp !== 'string' || !clientIp.trim()) return true;
    const ip = clientIp.trim();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    const existing = bucket.get(ip);
    const hits = existing ? existing.filter((ts) => ts > cutoff) : [];
    if (hits.length >= maxHits) {
      bucket.set(ip, hits);
      return false;
    }
    if (!bucket.has(ip) && bucket.size >= MAX_RATE_LIMIT_IPS) {
      for (const [k, list] of bucket) {
        const fresh = list.filter((ts) => ts > cutoff);
        if (fresh.length === 0) {
          bucket.delete(k);
        }
        if (bucket.size < MAX_RATE_LIMIT_IPS) break;
      }
      if (bucket.size >= MAX_RATE_LIMIT_IPS) {
        const oldestKey = bucket.keys().next().value;
        if (oldestKey !== undefined) bucket.delete(oldestKey);
      }
    }
    hits.push(now);
    bucket.set(ip, hits);
    return true;
  }

  _getScopedPending(txId, workspaceId = null, { allowLocalRestore = false } = {}) {
    this._prune();
    const tx = this.pending.get(String(txId || ''));
    if (!tx) return null;
    const targetWorkspaceId = targetWorkspaceIdForPath(tx.resourcePath);
    if (targetWorkspaceId === null) {
      if (workspaceId === null || allowLocalRestore === true) return tx;
      if (this.hostedRoot && typeof workspaceId === 'string' && /^[0-9a-f]{64}$/.test(workspaceId)) return tx;
      return null;
    }
    if (typeof workspaceId === 'string' && workspaceId === targetWorkspaceId) {
      return tx;
    }
    return null;
  }

  protectedResourceMetadata(origin, resourcePath = '/mcp') {
    const cleanOrigin = String(origin || '').replace(/\/+$/, '');
    const cleanPath = resourcePath === '/mcp' || SCOPED_MCP_RE.test(resourcePath) ? resourcePath : '/mcp';
    const wsId = targetWorkspaceIdForPath(cleanPath);
    const authServer = wsId ? `${cleanOrigin}/w/${wsId}` : cleanOrigin;
    return {
      resource: `${cleanOrigin}${cleanPath}`,
      authorization_servers: [authServer],
      bearer_methods_supported: ['header'],
      scopes_supported: [DEFAULT_SCOPE],
    };
  }

  authorizationServerMetadata(origin, workspaceId = null) {
    const cleanOrigin = String(origin || '').replace(/\/+$/, '');
    const validWs = typeof workspaceId === 'string' && WORKSPACE_ID_RE.test(workspaceId) ? workspaceId : null;
    const base = validWs ? `${cleanOrigin}/w/${validWs}` : cleanOrigin;
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      device_authorization_endpoint: `${base}/oauth/device/code`,
      revocation_endpoint: `${base}/oauth/revoke`,
      revocation_endpoint_auth_methods_supported: ['none'],
      registration_endpoint: `${base}/oauth/register`,
      scopes_supported: [DEFAULT_SCOPE],
      response_types_supported: ['code'],
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:device_code',
      ],
      token_endpoint_auth_methods_supported: [...SUPPORTED_TOKEN_AUTH_METHODS],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
    };
  }

  wwwAuthenticateHeader(origin, resourcePath = '/mcp') {
    const cleanOrigin = String(origin || '').replace(/\/+$/, '');
    const cleanPath = resourcePath === '/mcp' || SCOPED_MCP_RE.test(resourcePath) ? resourcePath : '/mcp';
    const metaPath = cleanPath === '/mcp'
      ? '/.well-known/oauth-protected-resource'
      : `/.well-known/oauth-protected-resource${cleanPath}`;
    return `Bearer resource_metadata="${cleanOrigin}${metaPath}"`;
  }

  getClient(clientId, now = Date.now()) {
    const cleanId = String(clientId || '').trim();
    if (!cleanId) return null;
    const registered = this.clients.get(cleanId);
    if (registered) return registered;
    const cached = this.cimdCache.get(cleanId);
    if (cached && cached.expiresAt > now) return cached.record;
    if (cached) this.cimdCache.delete(cleanId);
    return null;
  }

  async resolveClient(clientId, { outboundPolicy = null, now = Date.now() } = {}) {
    const cleanId = String(clientId || '').trim();
    if (!cleanId) return null;
    const existing = this.getClient(cleanId, now);
    if (existing) return existing;
    if (!isCimdClientId(cleanId, { allowLoopback: this.allowLoopbackCimd })) {
      return null;
    }

    let parsed;
    try {
      parsed = new URL(cleanId);
    } catch {
      return null;
    }

    const policy = outboundPolicy || this.outboundPolicy || createOutboundPolicy({ personal: !this.allowLoopbackCimd });
    let safeFetch;
    if (this.cimdFetch) {
      if (!this.allowLoopbackCimd) policy.assertConnectionUrl(parsed.href);
      safeFetch = this.cimdFetch;
    } else {
      const checkedUrl = policy.assertConnectionUrl(parsed.href);
      safeFetch = policy.createFetchForUrl(checkedUrl, { allowedOrigin: checkedUrl.origin });
    }

    let res;
    try {
      res = await safeFetch(parsed.href, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      return null;
    }
    if (!res?.ok) return null;
    let rawText;
    try {
      rawText = await res.text();
    } catch {
      return null;
    }
    if (!rawText || Buffer.byteLength(rawText, 'utf8') > MAX_CIMD_BYTES) return null;
    let doc;
    try {
      doc = JSON.parse(rawText);
    } catch {
      return null;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
    if (doc.client_id !== cleanId) return null;
    const authMethod = doc.token_endpoint_auth_method === undefined ? 'none' : String(doc.token_endpoint_auth_method);
    if (authMethod !== 'none') return null;

    const rawUris = doc.redirect_uris;
    if (!Array.isArray(rawUris) || rawUris.length === 0 || rawUris.length > MAX_REDIRECT_URIS_PER_CLIENT) {
      return null;
    }
    const redirectUris = [];
    for (const uri of rawUris) {
      if (!isValidRedirectUri(uri)) return null;
      if (!redirectUris.includes(uri)) redirectUris.push(uri);
    }

    let ttlMs = CIMD_DEFAULT_TTL_MS;
    const cc = String(res.headers?.get?.('cache-control') || '');
    const maxAgeMatch = cc.match(/max-age=(\d+)/i);
    if (maxAgeMatch) {
      const parsedMs = Number.parseInt(maxAgeMatch[1], 10) * 1000;
      if (Number.isFinite(parsedMs)) {
        ttlMs = Math.max(CIMD_MIN_TTL_MS, Math.min(parsedMs, CIMD_MAX_TTL_MS));
      }
    }

    const record = {
      client_id: cleanId,
      client_name: normalizeClientName(doc.client_name || parsed.hostname),
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      confirmed: false,
      isCimd: true,
      createdAt: now,
    };
    if (this.cimdCache.size >= MAX_CIMD_CACHE) {
      const oldest = this.cimdCache.keys().next().value;
      if (oldest !== undefined) this.cimdCache.delete(oldest);
    }
    this.cimdCache.set(cleanId, { record, expiresAt: now + ttlMs });
    return record;
  }

  authenticateClient(params = {}, { authorizationHeader = '', requireRegistered = false } = {}) {
    const basic = parseBasicClientAuth(authorizationHeader);
    const bodyClientId = typeof params?.client_id === 'string' ? params.client_id.trim() : '';
    const bodySecret = typeof params?.client_secret === 'string' ? params.client_secret : undefined;
    if (basic && bodyClientId && basic.clientId !== bodyClientId) {
      throw oauthError(401, 'invalid_client', 'Conflicting client_id in Authorization header and request body.');
    }
    const clientId = basic ? basic.clientId : bodyClientId;
    const client = clientId ? this.getClient(clientId) : null;
    if (requireRegistered && !client) {
      throw oauthError(400, 'invalid_client', 'Unknown client_id.');
    }
    if (!client) {
      if (basic) throw oauthError(401, 'invalid_client', 'Unknown client_id.');
      return { clientId, client: null };
    }
    const method = client.token_endpoint_auth_method || 'none';
    if (method === 'none') {
      if (basic || bodySecret !== undefined) {
        throw oauthError(401, 'invalid_client', 'Public client must not send client_secret.');
      }
      return { clientId: client.client_id, client };
    }
    if (method === 'client_secret_basic') {
      if (!basic || bodySecret !== undefined) {
        throw oauthError(401, 'invalid_client', 'Client must authenticate using HTTP Basic client_secret_basic.');
      }
      if (!timingSafeHexEqual(hashClientSecret(basic.clientSecret), client.client_secret_hash)) {
        throw oauthError(401, 'invalid_client', 'Invalid client credentials.');
      }
      return { clientId: client.client_id, client };
    }
    if (method === 'client_secret_post') {
      if (basic || typeof bodySecret !== 'string' || !bodySecret) {
        throw oauthError(401, 'invalid_client', 'Client must authenticate using client_secret in the request body.');
      }
      if (!timingSafeHexEqual(hashClientSecret(bodySecret), client.client_secret_hash)) {
        throw oauthError(401, 'invalid_client', 'Invalid client credentials.');
      }
      return { clientId: client.client_id, client };
    }
    throw oauthError(401, 'invalid_client', 'Unsupported client authentication method.');
  }

  registerClient(body, { clientIp = null } = {}) {
    this._prune();
    if (!this._consumeIpRateLimit(this._registerHits, clientIp, this.maxRegistrationsPerIp)) {
      throw oauthError(429, 'temporarily_unavailable', TOO_MANY_REQUESTS_MSG);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw oauthError(400, 'invalid_client_metadata', 'Registration payload must be a JSON object.');
    }
    const rawUris = body.redirect_uris;
    if (!Array.isArray(rawUris) || rawUris.length === 0 || rawUris.length > MAX_REDIRECT_URIS_PER_CLIENT) {
      throw oauthError(400, 'invalid_redirect_uri', 'At least one valid redirect_uri is required.');
    }
    const redirectUris = [];
    for (const uri of rawUris) {
      if (!isValidRedirectUri(uri)) {
        throw oauthError(400, 'invalid_redirect_uri', 'Redirect URI must be a loopback http URL, https URL, or safe desktop scheme.');
      }
      if (!redirectUris.includes(uri)) redirectUris.push(uri);
    }
    const rawAuthMethod = body.token_endpoint_auth_method === undefined
      ? 'none'
      : String(body.token_endpoint_auth_method || '').trim();
    if (!TOKEN_AUTH_METHOD_SET.has(rawAuthMethod)) {
      throw oauthError(
        400,
        'invalid_client_metadata',
        `token_endpoint_auth_method must be one of: ${SUPPORTED_TOKEN_AUTH_METHODS.join(', ')}.`,
      );
    }

    const now = Date.now();
    const clientId = `loop_client_${randomBytes(16).toString('base64url')}`;
    const issuedSecret = rawAuthMethod !== 'none' ? `loop_cs_${randomBytes(32).toString('base64url')}` : null;
    const record = {
      client_id: clientId,
      client_name: normalizeClientName(body.client_name),
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: rawAuthMethod,
      ...(issuedSecret ? { client_secret_hash: hashClientSecret(issuedSecret) } : {}),
      confirmed: false,
      createdAt: now,
    };

    if (this.clients.size >= this.maxClients) {
      const activeClientIds = this._activeClientIds();
      let evictKey = null;
      for (const [key, existing] of this.clients) {
        if (activeClientIds.has(key)) continue;
        if (existing.confirmed === true) continue;
        const ageMs = now - (Number(existing.createdAt) || 0);
        if (ageMs < this.clientProtectedWindowMs) continue;
        evictKey = key;
        break;
      }
      if (!evictKey) {
        throw oauthError(429, 'temporarily_unavailable', TOO_MANY_REQUESTS_MSG);
      }
      this.clients.delete(evictKey);
    }
    this.clients.set(clientId, record);
    this._scheduleSaveClients();

    return {
      client_id: record.client_id,
      ...(issuedSecret ? { client_secret: issuedSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(record.createdAt / 1000),
      client_name: record.client_name,
      redirect_uris: record.redirect_uris,
      grant_types: record.grant_types,
      response_types: record.response_types,
      token_endpoint_auth_method: record.token_endpoint_auth_method,
    };
  }

  async startAuthorizationWithCimd(searchParams, origin, opts = {}) {
    const clientId = String(searchParams.get('client_id') || '').trim();
    if (clientId && !this.getClient(clientId) && isCimdClientId(clientId, { allowLoopback: this.allowLoopbackCimd })) {
      await this.resolveClient(clientId, { outboundPolicy: opts.outboundPolicy || null }).catch(() => null);
    }
    return this.startAuthorization(searchParams, origin, opts);
  }

  startAuthorization(searchParams, origin, { defaultWorkspaceId = null, clientIp = null } = {}) {
    this._prune();
    if (!this._consumeIpRateLimit(this._authorizeHits, clientIp, this.maxAuthorizePerIp)) {
      return {
        status: 429,
        error: 'temporarily_unavailable',
        error_description: TOO_MANY_REQUESTS_MSG,
      };
    }

    const clientId = String(searchParams.get('client_id') || '').trim();
    const redirectUri = String(searchParams.get('redirect_uri') || '');
    const state = String(searchParams.get('state') || '').slice(0, 512);
    const responseType = String(searchParams.get('response_type') || '');
    const codeChallenge = String(searchParams.get('code_challenge') || '');
    const codeChallengeMethod = String(searchParams.get('code_challenge_method') || '');
    const scope = normalizeScope(searchParams.get('scope') || '');
    const rawResource = searchParams.get('resource') || '';

    const client = this.getClient(clientId);
    if (!client) {
      return {
        status: 400,
        error: 'invalid_client',
        error_description: 'Unknown client_id. Re-authenticate from your agent to register.',
      };
    }
    if (clientIp && !this._consumeIpRateLimit(this._authorizeClientHits, `${client.client_id}`, this.maxAuthorizePerClient)) {
      return {
        status: 429,
        error: 'temporarily_unavailable',
        error_description: TOO_MANY_REQUESTS_MSG,
      };
    }
    if (!redirectUriRegistered(client.redirect_uris, redirectUri)) {
      return {
        status: 400,
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uri does not match the registered client.',
      };
    }

    // G4a-08: Never redirect unconfirmed DCR clients on error (prevents open redirects to
    // attacker-supplied https:// or desktop scheme URIs). Render error on Loop's own page.
    const failParam = (error, description) => {
      if (client.confirmed === true) {
        return {
          redirectErrorUrl: appendQuery(redirectUri, {
            error,
            error_description: description,
            state: state || undefined,
          }),
        };
      }
      return {
        status: 400,
        error,
        error_description: description,
      };
    };

    if (responseType !== 'code') {
      return failParam('unsupported_response_type', 'Only response_type=code is supported.');
    }
    if (!PKCE_RE.test(codeChallenge) || codeChallengeMethod !== 'S256') {
      return failParam('invalid_request', 'PKCE S256 code_challenge is required.');
    }

    const scopedDefaultWs =
      typeof defaultWorkspaceId === 'string' && WORKSPACE_ID_RE.test(defaultWorkspaceId)
        ? defaultWorkspaceId
        : null;
    if (defaultWorkspaceId !== null && defaultWorkspaceId !== undefined && !scopedDefaultWs) {
      return failParam('invalid_target', 'Requested MCP workspace is not valid.');
    }

    const resourcePath = rawResource
      ? parseResourcePath(rawResource, origin)
      : (scopedDefaultWs ? `/w/${scopedDefaultWs}/mcp` : '/mcp');
    if (!resourcePath) {
      return failParam('invalid_target', 'Requested MCP resource is not served by this Loop server.');
    }
    if (scopedDefaultWs && resourcePath !== `/w/${scopedDefaultWs}/mcp`) {
      return failParam('invalid_target', 'Requested MCP resource does not match this workspace.');
    }

    let clientPending = 0;
    for (const tx of this.pending.values()) {
      if (tx.clientId === clientId) clientPending += 1;
    }
    if (clientPending >= MAX_PENDING_PER_CLIENT || this.pending.size >= MAX_PENDING) {
      return {
        status: 429,
        error: 'temporarily_unavailable',
        error_description: TOO_MANY_REQUESTS_MSG,
      };
    }

    const requestedProfile = parseResourceProfile(rawResource) || parseResourceProfile(searchParams.get('profile') ? `http://local/?profile=${encodeURIComponent(searchParams.get('profile'))}` : '');

    const txId = randomBytes(24).toString('base64url');
    this.pending.set(txId, {
      txId,
      clientId,
      clientName: client.client_name,
      redirectUri,
      state,
      codeChallenge,
      resourcePath,
      ...(requestedProfile ? { requestedProfile } : {}),
      scope,
      createdAt: Date.now(),
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
    return { txId };
  }

  // For the server only: the sign-in page never needs the client id.
  pendingClientId(txId) {
    return this.pending.get(String(txId || ''))?.clientId || null;
  }

  getPending(txId, { workspaceId = null, allowLocalRestore = false } = {}) {
    const tx = this._getScopedPending(txId, workspaceId, { allowLocalRestore });
    if (!tx) return null;
    let redirectHost = tx.redirectUri;
    try {
      const u = new URL(tx.redirectUri);
      redirectHost = u.host || u.protocol.replace(/:$/, '');
    } catch {
      // keep raw
    }
    return {
      txId: tx.txId,
      clientName: tx.clientName,
      redirectUri: tx.redirectUri,
      redirectHost,
      resourcePath: tx.resourcePath,
      ...(tx.requestedProfile ? { requestedProfile: tx.requestedProfile } : {}),
      targetWorkspaceId: targetWorkspaceIdForPath(tx.resourcePath),
      scope: tx.scope,
      expiresAt: tx.expiresAt,
    };
  }

  approvePending(txId, { workspaceId = null, userId = 'local', profile = 'all', access = null } = {}) {
    const key = String(txId || '');
    const tx = this._getScopedPending(key, workspaceId);
    if (!tx) {
      throw oauthError(404, 'invalid_request', 'This sign-in request has expired. Start Authenticate again in your agent.');
    }

    let approvedProfile = 'all';
    if (profile !== undefined && profile !== null && profile !== '') {
      if (typeof profile !== 'string' || PROFILE_CONTROL_RE.test(profile)) {
        throw oauthError(400, 'invalid_request', 'Profile must be a valid string without control characters.');
      }
      approvedProfile = normalizeProfileTag(profile) || 'all';
    }

    let approvedAccess = null;
    if (access !== undefined && access !== null) {
      if (typeof access !== 'object' || Array.isArray(access)) {
        throw oauthError(400, 'invalid_request', 'Access configuration must be an object.');
      }
      const nextAccess = {};
      const normalizeIdArray = (val, label) => {
        if (val === null) return null;
        if (!Array.isArray(val)) throw oauthError(400, 'invalid_request', `${label} must be an array or null.`);
        if (val.length > 1000) throw oauthError(400, 'invalid_request', `${label} has too many items.`);
        const out = [];
        const seen = new Set();
        for (const item of val) {
          if (typeof item !== 'string' || !item.trim() || item.length > 120 || /[\x00-\x1f\x7f]/.test(item)) {
            throw oauthError(400, 'invalid_request', `Invalid entry in ${label}.`);
          }
          const clean = item.trim();
          if (!seen.has(clean)) {
            seen.add(clean);
            out.push(clean);
          }
        }
        return out;
      };
      if (access.allowedConnections !== undefined) {
        nextAccess.allowedConnections = normalizeIdArray(access.allowedConnections, 'allowedConnections');
      }
      if (access.allowedSkills !== undefined) {
        nextAccess.allowedSkills = normalizeIdArray(access.allowedSkills, 'allowedSkills');
      }
      if (access.toolGrants !== undefined) {
        const grants = access.toolGrants;
        const grantKeys = grants && typeof grants === 'object' && !Array.isArray(grants) ? Object.keys(grants) : [];
        if (
          grantKeys.length === 0 ||
          grantKeys.length > 50 ||
          !Array.isArray(nextAccess.allowedConnections) ||
          nextAccess.allowedConnections.length !== grantKeys.length ||
          grantKeys.some((id) => !nextAccess.allowedConnections.includes(id)) ||
          !Array.isArray(nextAccess.allowedSkills) ||
          nextAccess.allowedSkills.length ||
          access.memoryAccess !== 'none' ||
          access.canManage !== false ||
          !Array.isArray(access.secrets) ||
          access.secrets.length
        ) {
          throw oauthError(400, 'invalid_request', 'An action grant requires selected connections matching toolGrants and no other access.');
        }
        const normalizedGrants = {};
        for (const id of grantKeys) {
          const names = normalizeIdArray(grants[id], 'toolGrants');
          if (!names?.length) throw oauthError(400, 'invalid_request', 'Select at least one action.');
          normalizedGrants[id] = names;
        }
        nextAccess.toolGrants = normalizedGrants;
      }
      if (access.toolMode !== undefined) {
        if (!['gateway', 'direct', 'hybrid'].includes(access.toolMode)) {
          throw oauthError(400, 'invalid_request', 'toolMode must be "gateway", "direct", or "hybrid".');
        }
        nextAccess.toolMode = access.toolMode;
      }
      if (access.memoryAccess !== undefined) {
        if (access.memoryAccess !== 'read_write' && access.memoryAccess !== 'read' && access.memoryAccess !== 'none') {
          throw oauthError(400, 'invalid_request', 'memoryAccess must be "read_write", "read", or "none".');
        }
        nextAccess.memoryAccess = access.memoryAccess;
      }
      if (access.canManage !== undefined) {
        if (typeof access.canManage !== 'boolean') {
          throw oauthError(400, 'invalid_request', 'canManage must be true or false.');
        }
        nextAccess.canManage = access.canManage;
      }
      if (access.secrets !== undefined) {
        if (!Array.isArray(access.secrets)) {
          throw oauthError(400, 'invalid_request', 'secrets must be an array.');
        }
        if (access.secrets.length > 500) {
          throw oauthError(400, 'invalid_request', 'Too many secrets selected.');
        }
        const out = [];
        const seen = new Set();
        for (const s of access.secrets) {
          if (typeof s !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(s) || s.startsWith('__')) {
            throw oauthError(400, 'invalid_request', 'Invalid secret key in access grant.');
          }
          if (!seen.has(s)) {
            seen.add(s);
            out.push(s);
          }
        }
        nextAccess.secrets = out;
      }
      if (access.accessSet !== undefined) {
        if (access.accessSet !== null && (typeof access.accessSet !== 'string' || access.accessSet.length > 64)) {
          throw oauthError(400, 'invalid_request', 'Invalid accessSet value.');
        }
        nextAccess.accessSet = access.accessSet ? access.accessSet.trim().toLowerCase() : null;
      }
      if (access.approvalMode !== undefined) {
        if (access.approvalMode !== null && !['ask', 'allow', 'guard'].includes(access.approvalMode)) {
          throw oauthError(400, 'invalid_request', 'approvalMode must be "ask", "allow", "guard", or null.');
        }
        nextAccess.approvalMode = access.approvalMode;
      }
      if (access.accountChoice !== undefined) {
        if (access.accountChoice !== null && (typeof access.accountChoice !== 'object' || Array.isArray(access.accountChoice))) {
          throw oauthError(400, 'invalid_request', 'accountChoice must be an object.');
        }
        nextAccess.accountChoice = access.accountChoice || {};
      }
      if (Object.keys(nextAccess).length > 0) {
        approvedAccess = nextAccess;
      }
    }

    const wsKey = workspaceId ?? '__local__';
    let wsCodes = 0;
    for (const entry of this.codes.values()) {
      if ((entry.workspaceId ?? '__local__') === wsKey) wsCodes += 1;
    }
    if (wsCodes >= MAX_CODES_PER_WORKSPACE || this.codes.size >= MAX_CODES) {
      throw oauthError(429, 'temporarily_unavailable', TOO_MANY_REQUESTS_MSG);
    }

    this.pending.delete(key);
    const client = this.clients.get(tx.clientId);
    if (client && !client.confirmed) {
      client.confirmed = true;
      this._scheduleSaveClients();
    }

    const now = Date.now();
    const codeExpiresAt = now + CODE_TTL_MS;
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, {
      txId: key,
      clientId: tx.clientId,
      clientName: tx.clientName,
      redirectUri: tx.redirectUri,
      codeChallenge: tx.codeChallenge,
      resourcePath: tx.resourcePath,
      scope: tx.scope,
      workspaceId,
      userId,
      profile: approvedProfile,
      access: approvedAccess,
      expiresAt: codeExpiresAt,
    });

    this._recordHandoff(key, {
      status: 'waiting',
      clientName: tx.clientName,
      workspaceId: workspaceId ?? null,
      expiresAt: codeExpiresAt,
      retainUntil: codeExpiresAt + HANDOFF_RETAIN_MS,
      updatedAt: now,
      error: null,
    });

    return {
      redirectUrl: appendQuery(tx.redirectUri, {
        code,
        state: tx.state || undefined,
      }),
      status: 'waiting',
      expiresAt: codeExpiresAt,
    };
  }

  getHandoffStatus(txId, { workspaceId = null } = {}) {
    this._prune();
    const handoff = this.handoffs.get(String(txId || ''));
    if (!handoff) return null;
    if ((handoff.workspaceId ?? null) !== (workspaceId ?? null)) return null;
    return {
      status: handoff.status,
      clientName: handoff.clientName,
      expiresAt: handoff.expiresAt,
      updatedAt: handoff.updatedAt,
      ...(handoff.error ? { error: handoff.error } : {}),
    };
  }

  failHandoff(txId, errorMessage = 'Could not finish connecting the agent.') {
    const handoff = this.handoffs.get(String(txId || ''));
    if (!handoff) return;
    const now = Date.now();
    handoff.status = 'failed';
    handoff.error = String(errorMessage || 'Could not finish connecting the agent.');
    handoff.updatedAt = now;
    handoff.retainUntil = now + HANDOFF_RETAIN_MS;
  }

  denyPending(txId, { workspaceId = null } = {}) {
    const key = String(txId || '');
    const tx = this._getScopedPending(key, workspaceId);
    if (!tx) {
      throw oauthError(404, 'invalid_request', 'This sign-in request has expired.');
    }
    this.pending.delete(key);
    return {
      redirectUrl: appendQuery(tx.redirectUri, {
        error: 'access_denied',
        error_description: 'The user declined the connection request.',
        state: tx.state || undefined,
      }),
    };
  }

  exchangeCode(params, origin, { expectedWorkspaceId = null } = {}) {
    this._prune();
    const grantType = String(params?.grant_type || '');
    if (grantType !== 'authorization_code') {
      throw oauthError(400, 'unsupported_grant_type', 'Only grant_type=authorization_code is supported.');
    }
    const code = String(params?.code || '');
    const codeVerifier = String(params?.code_verifier || '');
    const redirectUri = String(params?.redirect_uri || '');
    const clientId = String(params?.client_id || '');
    const rawResource = params?.resource ? String(params.resource) : '';

    if (!code || !codeVerifier || !redirectUri) {
      throw oauthError(400, 'invalid_request', 'code, code_verifier, and redirect_uri are required.');
    }

    const entry = this.codes.get(code);
    // Always consume immediately (single-use even on failed verification).
    if (entry) this.codes.delete(code);

    const now = Date.now();
    const failAndThrow = (status, errCode, msg) => {
      if (entry?.txId) this.failHandoff(entry.txId, msg);
      throw oauthError(status, errCode, msg);
    };

    if (!entry || entry.expiresAt <= now) {
      if (entry?.txId) {
        const handoff = this.handoffs.get(entry.txId);
        if (handoff) {
          handoff.status = 'expired';
          handoff.updatedAt = now;
          handoff.retainUntil = now + HANDOFF_RETAIN_MS;
        }
      }
      throw oauthError(400, 'invalid_grant', 'Authorization code is invalid or expired.');
    }
    if (expectedWorkspaceId !== null && entry.workspaceId !== expectedWorkspaceId) {
      failAndThrow(400, 'invalid_grant', 'Authorization code does not match this workspace.');
    }
    if (clientId && clientId !== entry.clientId) {
      failAndThrow(401, 'invalid_client', 'client_id does not match authorization code.');
    }
    if (redirectUri !== entry.redirectUri) {
      failAndThrow(400, 'invalid_grant', 'redirect_uri does not match authorization code.');
    }
    if (rawResource) {
      const resourcePath = parseResourcePath(rawResource, origin);
      if (resourcePath !== entry.resourcePath) {
        failAndThrow(400, 'invalid_target', 'resource does not match authorization code.');
      }
    }
    if (!verifyPkceS256(codeVerifier, entry.codeChallenge)) {
      failAndThrow(400, 'invalid_grant', 'PKCE code_verifier verification failed.');
    }

    if (entry.txId) {
      const handoff = this.handoffs.get(entry.txId);
      if (handoff) {
        handoff.status = 'connected';
        handoff.error = null;
        handoff.updatedAt = now;
        handoff.retainUntil = now + HANDOFF_RETAIN_MS;
      }
    }

    return {
      txId: entry.txId || null,
      clientId: entry.clientId,
      clientName: entry.clientName,
      workspaceId: entry.workspaceId,
      resourcePath: entry.resourcePath,
      scope: entry.scope,
      profile: entry.profile || 'all',
      ...(entry.access ? { access: entry.access } : {}),
    };
  }

  // Issues a rotating refresh token bound to an agentId + clientId + workspaceId family.
  // Refresh tokens are permanent by default (expiresAt: null) until revoked, disabled, or replaced,
  // unless a finite ttlMs is configured via workspace settings or LOOP_OAUTH_REFRESH_TTL_DAYS.
  // Never snapshots profile or access grants: renewal always checks the live agent record.
  issueRefreshToken({
    agentId = null,
    rightsDigest = null,
    clientId,
    clientName,
    workspaceId = null,
    scope = DEFAULT_SCOPE,
    familyId = null,
    ttlMs = undefined,
    now = Date.now(),
  } = {}) {
    if (!this.refreshTokens) this.refreshTokens = new Map();
    if (!this.usedRefreshTokens) this.usedRefreshTokens = new Map();
    const resolvedTtlMs =
      ttlMs === null
        ? null
        : typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0
          ? ttlMs
          : this.refreshTtlMs;
    const expiresAt = resolvedTtlMs !== null ? now + resolvedTtlMs : null;
    const token = `loop_rt_${randomBytes(32).toString('base64url')}`;
    const tokenHash = hashRefreshToken(token);
    const fam = familyId || `fam_${randomBytes(12).toString('hex')}`;
    this.refreshTokens.set(tokenHash, {
      familyId: fam,
      agentId: typeof agentId === 'string' && agentId ? agentId : null,
      rightsDigest: typeof rightsDigest === 'string' && rightsDigest ? rightsDigest : null,
      clientId,
      clientName: normalizeClientName(clientName),
      workspaceId,
      scope: normalizeScope(scope),
      issuedAt: now,
      expiresAt,
    });
    if (this.refreshTokens.size > MAX_REFRESH_TOKENS) {
      for (const [k, v] of this.refreshTokens) {
        if (v.expiresAt !== null && v.expiresAt <= now) this.refreshTokens.delete(k);
        if (this.refreshTokens.size <= MAX_REFRESH_TOKENS - 1000) break;
      }
      while (this.refreshTokens.size > MAX_REFRESH_TOKENS) {
        const oldestKey = this.refreshTokens.keys().next().value;
        if (oldestKey === undefined) break;
        this.refreshTokens.delete(oldestKey);
      }
    }
    this._scheduleSaveRefreshTokens();
    return { refreshToken: token, familyId: fam, expiresAt };
  }

  revokeRefreshTokens({ agentId = null, clientId = null, workspaceId = undefined, token = null, familyId = null } = {}) {
    if (!this.refreshTokens) this.refreshTokens = new Map();
    if (!this.usedRefreshTokens) this.usedRefreshTokens = new Map();
    const now = Date.now();
    const families = new Set();
    if (typeof familyId === 'string' && familyId) families.add(familyId);
    let changed = false;

    if (typeof token === 'string' && token) {
      const tokenHash = hashRefreshToken(token);
      const live = this.refreshTokens.get(tokenHash);
      if (live) {
        const clientOk = !clientId || live.clientId === clientId;
        const wsOk = workspaceId === undefined || live.workspaceId === workspaceId;
        if (clientOk && wsOk) {
          families.add(live.familyId);
          this.refreshTokens.delete(tokenHash);
          this.usedRefreshTokens.set(tokenHash, { familyId: live.familyId, usedAt: now });
          changed = true;
        }
      } else if (this.usedRefreshTokens.has(tokenHash)) {
        const usedInfo = this.usedRefreshTokens.get(tokenHash);
        const fam = typeof usedInfo === 'string' ? usedInfo : usedInfo?.familyId;
        if (fam) families.add(fam);
      }
    }

    let revoked = 0;
    for (const [k, v] of this.refreshTokens) {
      const wsMatches = workspaceId === undefined || v.workspaceId === workspaceId;
      const matchesFamily = families.size > 0 && families.has(v.familyId);
      const matchesAgent = Boolean(agentId) && v.agentId === agentId && wsMatches;
      const matchesClient = !agentId && !token && Boolean(clientId) && v.clientId === clientId && wsMatches;
      if (matchesFamily || matchesAgent || matchesClient) {
        this.refreshTokens.delete(k);
        this.usedRefreshTokens.set(k, { familyId: v.familyId, usedAt: now });
        revoked += 1;
        changed = true;
      }
    }
    if (families.size > 0 && this._graceRefreshCache?.size) {
      for (const [k, v] of this._graceRefreshCache) {
        if (families.has(v.result?.familyId)) this._graceRefreshCache.delete(k);
      }
    }
    while (this.usedRefreshTokens.size > MAX_USED_REFRESH_TOKENS) {
      const firstKey = this.usedRefreshTokens.keys().next().value;
      if (firstKey === undefined) break;
      this.usedRefreshTokens.delete(firstKey);
    }
    if (changed) this._scheduleSaveRefreshTokens();
    return revoked;
  }

  peekRefreshWorkspace(rawToken) {
    const raw = String(rawToken || '').trim();
    if (!raw || !this.refreshTokens) return undefined;
    const entry = this.refreshTokens.get(hashRefreshToken(raw));
    return entry ? entry.workspaceId : undefined;
  }

  exchangeRefreshToken(params, { expectedWorkspaceId = null, now = Date.now(), ttlMs = undefined } = {}) {
    if (!this.refreshTokens) this.refreshTokens = new Map();
    if (!this.usedRefreshTokens) this.usedRefreshTokens = new Map();
    if (!this._graceRefreshCache) this._graceRefreshCache = new Map();
    const raw = String(params?.refresh_token || '').trim();
    const clientId = String(params?.client_id || '').trim();
    if (!raw) {
      throw oauthError(400, 'invalid_request', 'refresh_token is required.');
    }
    for (const [k, cached] of this._graceRefreshCache) {
      if (cached.expiresAt <= now) this._graceRefreshCache.delete(k);
    }

    const tokenHash = hashRefreshToken(raw);
    if (this.refreshGraceMs > 0) {
      const grace = this._graceRefreshCache.get(tokenHash);
      if (grace && grace.expiresAt > now) {
        if (expectedWorkspaceId !== null && grace.workspaceId !== expectedWorkspaceId) {
          throw oauthError(400, 'invalid_grant', 'Refresh token does not match this workspace.');
        }
        if (clientId && clientId !== grace.clientId) {
          throw oauthError(401, 'invalid_client', 'client_id does not match refresh token.');
        }
        return { ...grace.result, graceHit: true };
      }
    }

    // Replay detection: an already-rotated token revokes every live token in its family.
    if (this.usedRefreshTokens.has(tokenHash)) {
      const usedInfo = this.usedRefreshTokens.get(tokenHash);
      const fam = typeof usedInfo === 'string' ? usedInfo : usedInfo?.familyId;
      let revokedAny = false;
      for (const [k, v] of this.refreshTokens) {
        if (v.familyId === fam) {
          this.refreshTokens.delete(k);
          revokedAny = true;
        }
      }
      if (revokedAny) this._scheduleSaveRefreshTokens();
      throw oauthError(400, 'invalid_grant', 'Refresh token was already used. Re-authenticate the agent.');
    }
    const entry = this.refreshTokens.get(tokenHash);
    if (!entry || (entry.expiresAt !== null && entry.expiresAt <= now)) {
      if (entry) {
        this.refreshTokens.delete(tokenHash);
        this._scheduleSaveRefreshTokens();
      }
      throw oauthError(400, 'invalid_grant', 'Refresh token is invalid or expired.');
    }
    if (expectedWorkspaceId !== null && entry.workspaceId !== expectedWorkspaceId) {
      throw oauthError(400, 'invalid_grant', 'Refresh token does not match this workspace.');
    }
    if (clientId && clientId !== entry.clientId) {
      throw oauthError(401, 'invalid_client', 'client_id does not match refresh token.');
    }
    this.refreshTokens.delete(tokenHash);
    this.usedRefreshTokens.set(tokenHash, { familyId: entry.familyId, usedAt: now });
    if (this.usedRefreshTokens.size > MAX_USED_REFRESH_TOKENS) {
      const firstKey = this.usedRefreshTokens.keys().next().value;
      if (firstKey !== undefined) this.usedRefreshTokens.delete(firstKey);
    }
    const next = this.issueRefreshToken({
      agentId: entry.agentId,
      rightsDigest: entry.rightsDigest,
      clientId: entry.clientId,
      clientName: entry.clientName,
      workspaceId: entry.workspaceId,
      scope: entry.scope,
      familyId: entry.familyId,
      ttlMs,
      now,
    });
    const result = {
      agentId: entry.agentId,
      rightsDigest: entry.rightsDigest,
      familyId: entry.familyId,
      clientId: entry.clientId,
      clientName: entry.clientName,
      workspaceId: entry.workspaceId,
      scope: entry.scope,
      refreshToken: next.refreshToken,
      expiresAt: next.expiresAt,
    };
    if (this.refreshGraceMs > 0) {
      this._graceRefreshCache.set(tokenHash, {
        expiresAt: now + this.refreshGraceMs,
        clientId: entry.clientId,
        workspaceId: entry.workspaceId,
        result,
      });
    }
    return result;
  }
}
