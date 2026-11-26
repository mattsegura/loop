// Official @modelcontextprotocol/sdk ConnectionPool supporting Streamable HTTP (with SSE fallback),
// SSE, and stdio transports, vault-backed auth resolution, and automatic OAuth token refresh.

import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Protocol } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  ErrorCode,
  McpError,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResultSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { AppSignIns, SIGN_IN_META, asksOfError, asksOfResult, signInAddress, signInResult } from './app-sign-ins.mjs';
import { refreshOAuthToken } from './oauth.mjs';
import { createOutboundPolicy } from './outbound-policy.mjs';
import { assertPersonalHeaders, assertPersonalStoredConnection, createPersonalFetch, personalOAuthNetwork } from './personal-upstreams.mjs';
import {
  PLACEHOLDER_RE,
  connectionSecretKeys,
  createRedactor,
  findSecretRefs,
  isInternalVaultKey,
  readSecrets,
} from './secret-refs.mjs';
import { normalizedOriginOf } from './sink.mjs';
import { serviceEndpointKeyOf } from './services.mjs';
import { isToolEnabled, normalizeToolAnnotations } from './store.mjs';
import { normalizeUpstreamToolUiMeta } from './mcp-apps.mjs';
import { MCP_SKILLS_EXTENSION, MAX_REMOTE_SKILLS_PER_CONN, normalizeUpstreamSkills } from './mcp-skills.mjs';
import { callBuiltinTool, isBuiltinConnection, listBuiltinTools } from './builtin-web.mjs';
import { isCloudRouteConnection, isRelayConnection } from './loop-connect.mjs';
import { isSharedConnection } from './shared-connection.mjs';
import { executeApiTransportTool } from './api-transports.mjs';

const CLIENT_INFO = { name: 'loop-gateway', version: '1.0.0' };
const OAUTH_REFRESH_WINDOW_MS = 60_000;
const CONNECT_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 60_000;
// A tool may work for minutes (a video, a crawl). Below the 300 seconds after which Node itself
// gives up on a reply.
const TOOL_CALL_TIMEOUT_MS = 240_000;
const MAX_LIST_PAGES = 50;
export const MAX_TOOLS_PER_CONN = 500;
export const MAX_RESOURCES_PER_CONN = 500;
export const MAX_PROMPTS_PER_CONN = 500;
export const MAX_TOOL_DESCRIPTION_CHARS = 4000;
export const MAX_TOOL_INPUT_SCHEMA_BYTES = 64 * 1024;
export const MAX_LAST_ERROR_CHARS = 500;
export const DEFAULT_STDIO_IDLE_TTL_MS = 10 * 60 * 1000;
export const SYNC_BACKOFF_BASE_MS = 5_000;
export const SYNC_BACKOFF_MAX_MS = 60_000;
const OVERSIZED_SCHEMA_NOTE = '[Input schema omitted: exceeded 64 KB limit.]';

// Same rule as connectionAuthInfo(conn).hasAuth in mcp-server.mjs: a sign-in token or a key header.
function hasStoredCredential(conn) {
  const headerKeys = conn?.headers && typeof conn.headers === 'object' ? Object.keys(conn.headers) : [];
  return headerKeys.length > 0 || Boolean(conn?.oauth?.accessTokenVaultKey || conn?.oauth?.accessToken);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const key of keys) {
    if (value[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  }
  return `{${parts.join(',')}}`;
}

function normalizeIdleTtlMs(value, fallback) {
  if (value === undefined) return fallback;
  if (value === null || value === false || value === 0 || value === Infinity) return 0;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function createAbortError(signal) {
  const reason = signal?.reason;
  const message =
    reason instanceof Error
      ? reason.message || 'The operation was aborted.'
      : typeof reason === 'string' && reason.trim()
        ? reason
        : 'The operation was aborted.';
  const err = new Error(message);
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  if (reason !== undefined && reason !== err) {
    err.cause = reason;
  }
  return err;
}

function isAbortError(err, signal = null) {
  if (signal?.aborted) return true;
  if (!err || typeof err !== 'object') return false;
  return err.name === 'AbortError' || err.code === 'ABORT_ERR';
}

export function computeSyncBackoffMs(failures) {
  const count = Math.max(1, Number(failures) || 1);
  return Math.min(SYNC_BACKOFF_MAX_MS, SYNC_BACKOFF_BASE_MS * (3 ** (count - 1)));
}

function truncateText(text, maxChars) {
  if (typeof text !== 'string') return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function computeOAuthRefreshWindowMs(oauth) {
  const ttlMs = Number(oauth?.ttlMs);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return OAUTH_REFRESH_WINDOW_MS;
  }
  const quarter = Math.floor(ttlMs * 0.25);
  if (ttlMs <= 10_000) {
    return quarter;
  }
  return Math.min(OAUTH_REFRESH_WINDOW_MS, Math.max(5_000, quarter));
}

export function isUnauthorizedError(err) {
  if (!err || typeof err !== 'object') return false;
  if (
    err.status === 401 ||
    err.statusCode === 401 ||
    err.code === 401 ||
    err.event?.code === 401
  ) {
    return true;
  }
  return err.name === 'UnauthorizedError';
}

function normalizeError(err, stderrOutput = '') {
  const error = err instanceof Error ? err : new Error(String(err || 'Upstream MCP error.'));
  if (isUnauthorizedError(error)) {
    error.status = 401;
  } else if (error.status === undefined) {
    const httpCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : typeof error.code === 'number' && error.code >= 400 && error.code < 600
          ? error.code
          : typeof error.event?.code === 'number' && error.event.code >= 400 && error.event.code < 600
            ? error.event.code
            : undefined;
    if (httpCode !== undefined) {
      error.status = httpCode;
    }
  }
  if (stderrOutput && !error.message.includes(stderrOutput.trim())) {
    const snippet = stderrOutput.trim().slice(-400);
    if (snippet) {
      error.message = `${error.message} (stderr: ${snippet})`;
    }
  }
  return error;
}

function redactError(err, redactor) {
  if (!err || !redactor || !redactor.hasSecrets) return err;
  if (err instanceof Error) {
    err.message = redactor.redact(String(err.message || ''));
    if (typeof err.name === 'string') {
      err.name = redactor.redact(err.name);
    }
    if (typeof err.stack === 'string') {
      err.stack = redactor.redact(err.stack);
    }
    if (err.cause !== undefined) {
      err.cause = redactor.redact(err.cause);
    }
    for (const [k, v] of Object.entries(err)) {
      if (typeof v === 'string' || (v && typeof v === 'object')) {
        err[k] = redactor.redact(v);
      }
    }
    return err;
  }
  return redactor.redact(err);
}

export function shouldFallbackToSse(err) {
  if (!err || typeof err !== 'object' || isUnauthorizedError(err)) return false;
  return (
    err.code === 404 ||
    err.code === 405 ||
    err.status === 404 ||
    err.status === 405 ||
    err.statusCode === 404 ||
    err.statusCode === 405
  );
}

function isUnsupportedMethodError(err) {
  if (!err || isUnauthorizedError(err)) return false;
  if (err.code === -32601) return true;
  const msg = String(err.message || '');
  return /method not found|does not support|not supported|not implemented/i.test(msg);
}

function isNonRetryableRpcError(err) {
  if (!err) return false;
  // Invalid params (-32602), method not found (-32601), invalid request (-32600)
  return err.code === -32602 || err.code === -32601 || err.code === -32600;
}

// Connection failures where the request cannot have reached the upstream.
const NEVER_CONNECTED_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
]);

// True only when the upstream cannot have run the request: it never left Loop, the connection was
// refused, or the server rejected the HTTP request itself (an expired session or token). Anything
// else (a JSON-RPC answer, a timeout, a connection that closed mid-call, a 5xx) may have run.
function wasNeverAccepted(err) {
  if (!err) return false;
  if (typeof err.code === 'number' && err.code < 0) return false;
  if (err.message === 'Not connected') return true;
  const posted = /\(HTTP (\d{3})\)/.exec(String(err.message || ''));
  const status = Number(err.status) || (posted ? Number(posted[1]) : 0);
  if (status) return status >= 400 && status < 500 && status !== 408 && status !== 429;
  return NEVER_CONNECTED_CODES.has(err.cause?.code);
}

const UNCONFIRMED_NOTE = 'Loop did not send it again because the call may already have run. Check before repeating it.';

// Tells the caller when a failed call may still have run upstream, so it checks before repeating it.
function noteIfUnconfirmed(err) {
  const message = String(err.message || '');
  const lostAfterSending =
    (err.code === -32001 && /timed? ?out/i.test(message)) ||
    (err.code === -32000 && /connection closed/i.test(message)) ||
    (err.status >= 500 && err.status < 600) ||
    (err.name === 'TypeError' && /fetch failed|terminated/i.test(message));
  if (lostAfterSending && !message.includes(UNCONFIRMED_NOTE)) {
    err.message = `${message.replace(/[.\s]+$/, '')}. ${UNCONFIRMED_NOTE}`;
  }
  return err;
}

function sortRecord(record) {
  if (!record || typeof record !== 'object') return {};
  const sorted = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key];
  }
  return sorted;
}

function computeFingerprint(conn, resolvedHeaders, resolvedEnv, oauth, resolvedUrl = null, resolvedArgs = null) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        transport: conn.transport || (conn.command ? 'stdio' : 'http'),
        url: resolvedUrl?.href || conn.url || null,
        command: conn.command || null,
        args: Array.isArray(resolvedArgs) ? resolvedArgs : (Array.isArray(conn.args) ? conn.args : []),
        cwd: conn.cwd || null,
        inheritEnv: conn.inheritEnv === true,
        headers: sortRecord(resolvedHeaders),
        env: sortRecord(resolvedEnv),
        oauthGrantId: oauth?.grantId ?? null,
        oauthBoundOrigin: oauth?.boundOrigin ?? null,
        oauthExpiresAt: oauth?.expiresAt ?? null,
        oauthAccessKey: oauth?.accessTokenVaultKey ?? null,
      }),
    )
    .digest('base64');
}

// A short mark for a Connection's saved settings and sign-in. A refreshed token does not change it.
function settingsMark(conn) {
  const { url, command, args, cwd, headers, env, oauth, createdAt } = conn;
  return createHash('sha256')
    .update(JSON.stringify([url, command, args, cwd, sortRecord(headers), sortRecord(env), oauth?.grantId, createdAt]))
    .digest('base64');
}

function readSettingsMark(conn, vault) {
  return createHash('sha256').update(JSON.stringify([
    settingsMark(conn), conn.transport, conn.oauth, conn.accountLabel, conn.name,
    conn.accessRevision, conn.specUrl, conn.inheritEnv, vault?.writeGeneration,
  ])).digest('base64');
}

function advertisedRead(conn, name) {
  const tool = conn?.tools?.find((t) => t.name === name);
  return tool?.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true && isToolEnabled(conn, name);
}

function reportedToolSuccess(result) {
  if (!result || result.isError || result._meta?.[SIGN_IN_META] || (!result.structuredContent && !Array.isArray(result.content))) return false;
  let payload = result.structuredContent;
  const item = result.content?.length === 1 ? result.content[0] : null;
  if (!payload && item?.type === 'text' && typeof item.text === 'string' &&
      item.text.length <= 65536 && item.text.trimStart().startsWith('{')) {
    try { payload = JSON.parse(item.text); } catch { /* Ordinary text result. */ }
  }
  return !payload?.error && payload?.success !== false && payload?.successful !== false && payload?.ok !== false;
}

export function buildStdioEnv(resolvedEnv, { inheritEnv = false } = {}) {
  const base = inheritEnv ? process.env : getDefaultEnvironment();
  const env = {};
  for (const [key, value] of Object.entries({ ...base, ...resolvedEnv })) {
    if (value !== undefined && value !== null) {
      env[key] = String(value);
    }
  }
  return env;
}

async function safeClose(client, transport) {
  if (client) {
    try {
      await client.close();
      return;
    } catch {
      // Fall through to ensure transport closes too
    }
  }
  if (transport) {
    try {
      await transport.close();
    } catch {
      // Ignore cleanup errors
    }
  }
}

export async function listAllPages(fetcher, key, { maxItems = Infinity } = {}) {
  const items = [];
  const seenCursors = new Set();
  let cursor;
  let truncated = false;
  let truncationReason = null;

  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const res = await fetcher(cursor ? { cursor } : undefined);
    if (Array.isArray(res?.[key])) {
      for (const entry of res[key]) {
        if (items.length >= maxItems) {
          truncated = true;
          truncationReason = truncationReason || 'limit';
          break;
        }
        items.push(entry);
      }
      if (truncated) break;
    }
    const nextCursor =
      typeof res?.nextCursor === 'string' && res.nextCursor.length > 0 ? res.nextCursor : null;
    if (!nextCursor) break;
    if (nextCursor === cursor || seenCursors.has(nextCursor)) {
      truncated = true;
      truncationReason = 'cursor_cycle';
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
    if (page === MAX_LIST_PAGES - 1) {
      truncated = true;
      truncationReason = 'max_pages';
    }
  }
  return { items, truncated, truncationReason };
}

export const SYNC_VERSION = 3;
export const STALE_SYNC_MS = 6 * 60 * 60 * 1000;
export const REMOTE_STALE_SYNC_MS = 60 * 60 * 1000;
export const SYNC_RETRY_MS = 30 * 60 * 1000;
export const REACTIVE_SYNC_COOLDOWN_MS = 60 * 1000;
const RESYNC_AFTER_CALL_MS = 60 * 1000;

const TOOL_MISMATCH_RE = /\b(?:unknown tool|tool\b[^.\n]{0,48}\bnot found|no such tool|method not found|invalid (?:params|arguments|input|schema)|missing required (?:parameter|argument|field|property)|unexpected (?:parameter|argument|property|field)|unrecognized key)\b/i;

function cleanServerVersion(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 80);
}

// True when an upstream error or tool result looks like a renamed/removed tool or updated input schema,
// so Loop refreshes the tool catalog immediately instead of waiting for the next periodic sync.
export function isToolSchemaMismatchError(errOrResult) {
  if (!errOrResult || typeof errOrResult !== 'object') return false;
  const code = errOrResult.code;
  if (code === -32601 || code === -32602 || code === ErrorCode.MethodNotFound || code === ErrorCode.InvalidParams) {
    return true;
  }
  const chunks = [];
  if (typeof errOrResult.message === 'string') chunks.push(errOrResult.message);
  if (Array.isArray(errOrResult.content)) {
    for (const part of errOrResult.content) {
      if (typeof part?.text === 'string') chunks.push(part.text);
    }
  }
  const combined = chunks.join('\n').slice(0, 2000);
  return Boolean(combined && TOOL_MISMATCH_RE.test(combined));
}

// How long a Connection is left alone after its Nth failed sync in a row: 30 min, 1 h, 2 h, 4 h, then 6 h.
export function syncRetryDelayMs(failures) {
  return Math.min(STALE_SYNC_MS, SYNC_RETRY_MS * 2 ** Math.max(0, failures - 1));
}

export function needsAutoSync(conn, now = Date.now()) {
  if (!conn || conn.enabled === false || conn.authRequired === true || isBuiltinConnection(conn) || isRelayConnection(conn)) return false;
  // A failing Connection waits out its retry delay first, whatever else is due. An error recorded
  // before attempts were tracked counts as one failure with no attempt time, so it is due now.
  const failures = Math.max(Number(conn.syncFailures) || 0, conn.lastError ? 1 : 0);
  if (failures > 0) {
    const attemptTs = Date.parse(conn.lastSyncAttemptAt);
    if (!Number.isFinite(attemptTs) || attemptTs > now) return true;
    return now - attemptTs >= syncRetryDelayMs(failures);
  }
  if (!conn.lastSyncAt) return true;
  if ((Number(conn.syncVersion) || 0) < SYNC_VERSION) return true;
  const lastTs = Date.parse(conn.lastSyncAt);
  if (!Number.isFinite(lastTs) || lastTs <= 0) return true;
  const isRemoteHttp = (conn.transport === 'http' || conn.transport === 'sse') && Boolean(conn.url);
  const staleLimit = isRemoteHttp ? REMOTE_STALE_SYNC_MS : STALE_SYNC_MS;
  return now - lastTs >= staleLimit;
}

// A call that just worked on a Connection marked failed is proof it is reachable again, so it is
// synced now (at most once a minute) instead of waiting out the retry delay.
function shouldSyncAfterCall(conn, now = Date.now()) {
  if (needsAutoSync(conn, now)) return true;
  if (!conn || conn.enabled === false || conn.authRequired === true || !conn.lastError) return false;
  const attemptTs = Date.parse(conn.lastSyncAttemptAt);
  return !Number.isFinite(attemptTs) || now - attemptTs >= RESYNC_AFTER_CALL_MS;
}

export class ConnectionPool {
  constructor(
    store,
    vault,
    {
      personal = false,
      outboundPolicy = null,
      selfIdentity = null,
      onSync = null,
      onCatalogChanged = null,
      idleTtlMs = undefined,
      stdioIdleTtlMs = undefined,
      httpIdleTtlMs = undefined,
      idleSweepIntervalMs = undefined,
      now = null,
      builtinFetch = null,
      builtinContext = null,
      upstreamFetch = null,
      relayDispatcher = null,
      sharedDispatcher = null,
    } = {},
  ) {
    this.store = store;
    this.vault = vault;
    this.personal = personal === true;
    this.builtinFetch = typeof builtinFetch === 'function' ? builtinFetch : null;
    this.builtinContext = builtinContext && typeof builtinContext === 'object' ? { ...builtinContext } : {};
    this.upstreamFetch = typeof upstreamFetch === 'function' ? upstreamFetch : null;
    this.relayDispatcher = relayDispatcher && typeof relayDispatcher === 'object' ? relayDispatcher : null;
    // Connections that another Loop lends to this one (lib/people.mjs). Only a hosted Loop has it.
    this.sharedDispatcher = sharedDispatcher && typeof sharedDispatcher === 'object' ? sharedDispatcher : null;
    this.outboundPolicy = outboundPolicy || createOutboundPolicy({ personal: this.personal, selfIdentity });
    this.selfIdentity = this.outboundPolicy.selfIdentity || selfIdentity || null;
    this.onSync = typeof onSync === 'function' ? onSync : null;
    this._catalogListeners = new Set();
    if (typeof onCatalogChanged === 'function') {
      this._catalogListeners.add(onCatalogChanged);
    }
    this._now = typeof now === 'function' ? now : () => Date.now();
    if (idleTtlMs !== undefined) {
      const baseTtl = normalizeIdleTtlMs(idleTtlMs, 0);
      this.stdioIdleTtlMs = stdioIdleTtlMs !== undefined ? normalizeIdleTtlMs(stdioIdleTtlMs, 0) : baseTtl;
      this.httpIdleTtlMs = httpIdleTtlMs !== undefined ? normalizeIdleTtlMs(httpIdleTtlMs, 0) : baseTtl;
    } else {
      this.stdioIdleTtlMs = normalizeIdleTtlMs(stdioIdleTtlMs, DEFAULT_STDIO_IDLE_TTL_MS);
      this.httpIdleTtlMs = normalizeIdleTtlMs(httpIdleTtlMs, 0);
    }
    const activeTtls = [this.stdioIdleTtlMs, this.httpIdleTtlMs].filter((ms) => ms > 0);
    if (activeTtls.length === 0) {
      this.idleSweepIntervalMs = 0;
    } else if (idleSweepIntervalMs !== undefined) {
      this.idleSweepIntervalMs = normalizeIdleTtlMs(idleSweepIntervalMs, 0);
    } else {
      const minTtl = Math.min(...activeTtls);
      this.idleSweepIntervalMs = Math.max(1, Math.min(60_000, Math.floor(minTtl / 2) || minTtl));
    }
    this.sessions = new Map();
    this.draining = new Set(); // replaced sessions that close once the calls still using them finish
    this.pendingConnects = new Map();
    this.bgSyncs = new Map();
    this.reactiveSyncs = new Map();
    this.inFlightSyncs = new Map();
    this.activeCalls = new Map();
    this._invalidations = new Map(); // connId -> incrementing counter
    this._syncBackoff = new Map(); // connId -> { failures, nextRetryAt }
    this._reactiveSyncAt = new Map(); // connId -> last reactive refresh timestamp
    this._failedCalls = new Map(); // connId -> { count, latestAt, mark }
    this._readObservations = new Map();
    this._opening = new Set();
    // Sign-ins that a Connection asks for during a call (lib/app-sign-ins.mjs).
    this.signIns = new AppSignIns({
      dir: store?.dir,
      mark: settingsMark,
      address: (url) => signInAddress(url, { personal: this.personal, selfIdentity: this.selfIdentity }),
      now: this._now,
    });
    this._liveCalls = new WeakMap(); // client -> tool calls that run on it
    this._formAskers = new Set(); // connIds of servers that ask for a form, which Loop does not offer
    this._idleSweepTimer = null;
    this._closed = false;
  }

  addCatalogListener(fn) {
    if (typeof fn !== 'function') {
      return () => {};
    }
    this._catalogListeners.add(fn);
    return () => {
      this._catalogListeners.delete(fn);
    };
  }

  _emitCatalogChanged(event) {
    for (const listener of [...this._catalogListeners]) {
      try {
        listener(event);
      } catch {
        // Listener errors must never break sync.
      }
    }
  }

  _ttlForSession(session) {
    if (!session) return 0;
    return session.transportType === 'stdio' ? this.stdioIdleTtlMs : this.httpIdleTtlMs;
  }

  _ensureIdleSweep() {
    if (this._closed || this._idleSweepTimer || this.idleSweepIntervalMs <= 0) return;
    this._idleSweepTimer = setInterval(() => {
      if (this._closed) {
        this._stopIdleSweep();
        return;
      }
      this.evictIdle().catch(() => {});
    }, this.idleSweepIntervalMs);
    this._idleSweepTimer.unref?.();
  }

  _stopIdleSweep() {
    if (this._idleSweepTimer) {
      clearInterval(this._idleSweepTimer);
      this._idleSweepTimer = null;
    }
  }

  shouldSkipAutoSync(connId, nowMs = this._now()) {
    const state = this._syncBackoff.get(connId);
    if (!state) return false;
    return nowMs < state.nextRetryAt;
  }

  _recordSyncFailure(connId, nowMs = this._now()) {
    const prev = this._syncBackoff.get(connId);
    const failures = (prev?.failures || 0) + 1;
    const delayMs = computeSyncBackoffMs(failures);
    const next = { failures, nextRetryAt: nowMs + delayMs };
    this._syncBackoff.set(connId, next);
    return next;
  }

  _clearSyncBackoff(connId) {
    this._syncBackoff.delete(connId);
  }

  async _resolveUrlAndSecrets(rawUrl) {
    const urlStr = typeof rawUrl === 'string'
      ? rawUrl.trim().replace(
          /%7[Bb]%7[Bb]vault(?:%3[Aa]|:)([A-Za-z0-9_.-]{1,100})%7[Dd]%7[Dd]/g,
          '{{vault:$1}}',
        )
      : '';
    if (!urlStr) {
      return { url: null, secrets: [] };
    }

    const keys = findSecretRefs(urlStr);
    if (keys.length === 0) {
      let parsed;
      try {
        parsed = new URL(urlStr);
      } catch {
        throw new Error('Connection URL must be a valid http or https address.');
      }
      this.outboundPolicy.assertConnectionUrl(parsed.href);
      return { url: parsed, secrets: [] };
    }

    // Check literal origin BEFORE substitution: {{vault:...}} can NEVER appear in scheme, host, or port.
    const probeA = urlStr.replace(new RegExp(PLACEHOLDER_RE.source, 'g'), 'loopvaulta');
    const probeB = urlStr.replace(new RegExp(PLACEHOLDER_RE.source, 'g'), 'loopvaultb');
    let parsedA;
    let parsedB;
    try {
      parsedA = new URL(probeA);
      parsedB = new URL(probeB);
    } catch {
      throw new Error('Vault placeholders cannot be used in the connection URL scheme, host, or port.');
    }
    if (
      (parsedA.protocol !== 'http:' && parsedA.protocol !== 'https:') ||
      parsedA.origin !== parsedB.origin
    ) {
      throw new Error('Vault placeholders cannot be used in the connection URL scheme, host, or port.');
    }
    const literalOrigin = parsedA.origin;
    this.outboundPolicy.assertConnectionUrl(parsedA.href);

    if (!this.vault || typeof this.vault.resolveString !== 'function') {
      throw new Error('Vault is required to resolve secret references in connection URL.');
    }

    const resolvedStr = await this.vault.resolveString(urlStr);
    let resolvedUrl;
    try {
      resolvedUrl = new URL(resolvedStr);
    } catch {
      throw new Error('Resolved connection URL is not a valid http or https address.');
    }
    if (resolvedUrl.origin !== literalOrigin) {
      throw new Error('Vault substitution cannot change the connection URL origin.');
    }
    this.outboundPolicy.assertConnectionUrl(resolvedUrl.href);

    const secrets = [];
    if (typeof this.vault.get === 'function') {
      const secretMap = await readSecrets(this.vault, keys, { allowInternal: false });
      for (const val of secretMap.values()) {
        if (typeof val === 'string' && val.length > 0) secrets.push(val);
      }
    }
    return { url: resolvedUrl, secrets };
  }

  async _collectConnectionSecrets(conn) {
    if (!conn || typeof conn !== 'object') return [];
    if (this.personal) {
      try {
        assertPersonalStoredConnection(conn, { selfIdentity: this.selfIdentity });
      } catch {
        return [];
      }
    }

    const secrets = new Set();
    const add = (val) => {
      if (typeof val === 'string' && val.length > 0) secrets.add(val);
    };

    if (this.vault && typeof this.vault.get === 'function') {
      const userKeys = connectionSecretKeys(conn).filter((k) => !isInternalVaultKey(k));
      const oauthKeys = [];
      const oauth = conn.oauth;
      if (oauth && typeof oauth === 'object') {
        if (typeof oauth.accessTokenVaultKey === 'string' && oauth.accessTokenVaultKey) {
          oauthKeys.push(oauth.accessTokenVaultKey);
        }
        if (typeof oauth.refreshTokenVaultKey === 'string' && oauth.refreshTokenVaultKey) {
          oauthKeys.push(oauth.refreshTokenVaultKey);
        }
        if (typeof oauth.clientSecretVaultKey === 'string' && oauth.clientSecretVaultKey) {
          oauthKeys.push(oauth.clientSecretVaultKey);
        }
      }
      const allKeys = [...new Set([...userKeys, ...oauthKeys])];
      if (allKeys.length > 0) {
        const map = await readSecrets(this.vault, allKeys, { allowInternal: true });
        for (const val of map.values()) add(val);
      }
    }

    if (conn.oauth && typeof conn.oauth === 'object') {
      if (!this.personal && typeof conn.oauth.accessToken === 'string') add(conn.oauth.accessToken);
      if (!this.personal && typeof conn.oauth.refreshToken === 'string') add(conn.oauth.refreshToken);
      if (typeof conn.oauth.clientSecret === 'string') add(conn.oauth.clientSecret);
    }

    return [...secrets];
  }

  async _updateConnectionIf(connId, predicate, patch) {
    if (!this.store || !connId) return { updated: false, entry: null };
    if (typeof this.store.updateIf === 'function') {
      const res = await this.store.updateIf(connId, predicate, patch);
      if (res && typeof res === 'object' && typeof res.updated === 'boolean') {
        return { updated: res.updated, entry: res.entry ?? null };
      }
      return { updated: Boolean(res), entry: res || null };
    }
    if (typeof this.store.update !== 'function') {
      return { updated: false, entry: null };
    }
    if (typeof this.store.get === 'function') {
      const latest = await this.store.get(connId);
      if (!latest || !predicate(latest)) {
        return { updated: false, entry: latest || null };
      }
    }
    const entry = await this.store.update(connId, patch);
    return { updated: Boolean(entry), entry: entry || null };
  }

  async _cleanupDiscardedRefreshKeys(refreshed, latestConn) {
    if (!this.vault || typeof this.vault.delete !== 'function' || !refreshed) return;
    const liveKeys = new Set();
    const liveOAuth = latestConn?.oauth;
    if (liveOAuth && typeof liveOAuth === 'object') {
      for (const k of [
        liveOAuth.accessTokenVaultKey,
        liveOAuth.refreshTokenVaultKey,
        liveOAuth.clientSecretVaultKey,
      ]) {
        if (typeof k === 'string' && k) liveKeys.add(k);
      }
    }
    for (const k of [
      refreshed.accessTokenVaultKey,
      refreshed.refreshTokenVaultKey,
      refreshed.clientSecretVaultKey,
    ]) {
      if (typeof k === 'string' && k && !liveKeys.has(k)) {
        await this.vault.delete(k).catch(() => {});
      }
    }
  }

  async buildResolvedAuth(conn) {
    // A personal record may carry only the sign-in Loop stored itself (checked here on every use).
    if (this.personal) assertPersonalStoredConnection(conn, { selfIdentity: this.selfIdentity });

    const transportType = this.personal
      ? (conn.transport ?? conn.type ?? 'http')
      : String(conn?.transport || (conn?.command ? 'stdio' : 'http')).toLowerCase();
    const isStdio = transportType === 'stdio';

    const sentSecrets = new Set();
    const addSecret = (val) => {
      if (typeof val === 'string' && val.length > 0) sentSecrets.add(val);
    };

    let resolvedUrl = null;
    if (!isStdio && conn?.url) {
      const { url, secrets } = await this._resolveUrlAndSecrets(conn.url);
      resolvedUrl = url;
      for (const s of secrets) addSecret(s);
    }

    const rawHeaders = !isStdio && conn?.headers && typeof conn.headers === 'object' ? conn.headers : {};
    const rawEnv = isStdio && !this.personal && conn?.env && typeof conn.env === 'object' ? conn.env : {};
    const rawArgs = isStdio && !this.personal && Array.isArray(conn?.args) ? conn.args.map(String) : [];

    const resolvedHeaders = this.vault && typeof this.vault.resolveRecord === 'function'
      ? { ...(await this.vault.resolveRecord(rawHeaders)) }
      : { ...rawHeaders };

    if (this.personal) assertPersonalHeaders(resolvedHeaders);

    const resolvedEnv = !isStdio || this.personal
      ? {}
      : this.vault && typeof this.vault.resolveRecord === 'function'
        ? { ...(await this.vault.resolveRecord(rawEnv)) }
        : { ...rawEnv };

    const resolvedArgs = !isStdio || this.personal
      ? []
      : this.vault && typeof this.vault.resolveString === 'function'
        ? await Promise.all(rawArgs.map((a) => this.vault.resolveString(a)))
        : rawArgs;

    if (this.vault && typeof this.vault.get === 'function') {
      const refKeys = findSecretRefs({ headers: rawHeaders, env: rawEnv, args: rawArgs });
      if (refKeys.length > 0) {
        const secretMap = await readSecrets(this.vault, refKeys, { allowInternal: false });
        for (const val of secretMap.values()) addSecret(val);
      }
    }

    let oauth = conn?.oauth || null;
    const resolvedOrigin = resolvedUrl ? resolvedUrl.origin.toLowerCase() : normalizedOriginOf(conn?.url);
    const boundOrigin =
      typeof oauth?.boundOrigin === 'string' && oauth.boundOrigin.trim()
        ? oauth.boundOrigin.trim().toLowerCase()
        : null;
    // G4a-03: Never refresh or attach Bearer credentials if the destination origin no longer matches boundOrigin.
    const oauthOriginMatches = !boundOrigin || (resolvedOrigin !== null && resolvedOrigin === boundOrigin);

    if (oauth?.accessTokenVaultKey && this.vault && typeof this.vault.get === 'function') {
      const expectedOrigin = boundOrigin || resolvedOrigin;
      const expectedGrantId = typeof oauth.grantId === 'string' && oauth.grantId ? oauth.grantId : null;
      const expectedAccessKey = oauth.accessTokenVaultKey;
      const matchesGrantAndOrigin = (latest) => {
        if (!latest || !latest.oauth) return false;
        if (expectedGrantId) {
          if (latest.oauth.grantId !== expectedGrantId) return false;
        } else if (latest.oauth.accessTokenVaultKey !== expectedAccessKey) {
          return false;
        }
        const latestOrigin = normalizedOriginOf(latest.url);
        if (expectedOrigin && latestOrigin !== expectedOrigin) return false;
        return true;
      };

      let refreshDiscarded = false;
      if (oauthOriginMatches) {
        const expiresAt = Number(oauth.expiresAt);
        const hasExpiry = Number.isFinite(expiresAt) && expiresAt > 0;
        const refreshWindow = computeOAuthRefreshWindowMs(oauth);
        if (hasExpiry && expiresAt - Date.now() <= refreshWindow && oauth.refreshTokenVaultKey) {
          const oauthNet = this.personal
            ? personalOAuthNetwork({ selfIdentity: this.selfIdentity })
            : this.outboundPolicy.oauthNetwork(resolvedUrl ? resolvedUrl.href : null);
          const refreshed = await refreshOAuthToken(conn, this.vault, {
            network: oauthNet,
            selfIdentity: this.selfIdentity,
            onRevoked: async () => {
              await this._updateConnectionIf(conn.id, matchesGrantAndOrigin, {
                authRequired: true,
                lastError: 'Sign in required.',
              }).catch(() => {});
            },
            onClientRejected: async () => {
              await this._updateConnectionIf(conn.id, matchesGrantAndOrigin, {
                authRequired: true,
                lastError: 'The service refused Loop’s OAuth client. Sign in again to register a fresh client.',
                oauth: { ...oauth, clientRejected: true },
              }).catch(() => {});
            },
          });
          if (refreshed) {
            if (this.store && (typeof this.store.updateIf === 'function' || typeof this.store.update === 'function')) {
              const cas = await this._updateConnectionIf(conn.id, matchesGrantAndOrigin, { oauth: refreshed });
              if (cas.updated) {
                oauth = refreshed;
              } else {
                refreshDiscarded = true;
                const latestConn =
                  cas.entry ??
                  (typeof this.store.get === 'function' ? await this.store.get(conn.id).catch(() => null) : null);
                await this._cleanupDiscardedRefreshKeys(refreshed, latestConn);
              }
            } else {
              oauth = refreshed;
            }
          }
        }

        const effectiveExpiresAt = Number(oauth.expiresAt);
        const isExpiredNow =
          Number.isFinite(effectiveExpiresAt) && effectiveExpiresAt > 0 && effectiveExpiresAt <= Date.now();
        if (isExpiredNow && !refreshDiscarded) {
          await this._updateConnectionIf(conn.id, matchesGrantAndOrigin, {
            authRequired: true,
            lastError: 'Sign in required.',
          }).catch(() => {});
        } else if (!refreshDiscarded) {
          const accessToken = await this.vault.get(oauth.accessTokenVaultKey);
          if (accessToken) {
            addSecret(accessToken);
            const hasAuthHeader = Object.keys(resolvedHeaders).some(
              (key) => key.toLowerCase() === 'authorization' && Boolean(resolvedHeaders[key]),
            );
            if (!hasAuthHeader) {
              resolvedHeaders.Authorization = `Bearer ${accessToken}`;
            }
          }
        }
      }

      if (oauth.refreshTokenVaultKey) {
        const refreshToken = await this.vault.get(oauth.refreshTokenVaultKey).catch(() => null);
        if (refreshToken) addSecret(refreshToken);
      }
      if (oauth.clientSecretVaultKey) {
        const clientSecret = await this.vault.get(oauth.clientSecretVaultKey).catch(() => null);
        if (clientSecret) addSecret(clientSecret);
      }
      if (oauth.clientSecret) {
        addSecret(oauth.clientSecret);
      }
    } else if (!this.personal && oauth?.accessToken) {
      addSecret(oauth.accessToken);
      if (oauth.refreshToken) addSecret(oauth.refreshToken);
      if (oauth.clientSecret) addSecret(oauth.clientSecret);
      if (oauthOriginMatches) {
        const expiresAt = Number(oauth.expiresAt);
        const isExpiredNow = Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now();
        if (isExpiredNow) {
          await this._updateConnectionIf(
            conn.id,
            (latest) => Boolean(latest?.oauth) && normalizedOriginOf(latest.url) === (boundOrigin || resolvedOrigin),
            { authRequired: true, lastError: 'Sign in required.' },
          ).catch(() => {});
        } else {
          const hasAuthHeader = Object.keys(resolvedHeaders).some(
            (key) => key.toLowerCase() === 'authorization' && Boolean(resolvedHeaders[key]),
          );
          if (!hasAuthHeader) {
            resolvedHeaders.Authorization = `Bearer ${oauth.accessToken}`;
          }
        }
      }
    } else if (oauth) {
      if (oauth.refreshTokenVaultKey && this.vault && typeof this.vault.get === 'function') {
        const refreshToken = await this.vault.get(oauth.refreshTokenVaultKey).catch(() => null);
        if (refreshToken) addSecret(refreshToken);
      }
      if (oauth.clientSecretVaultKey && this.vault && typeof this.vault.get === 'function') {
        const clientSecret = await this.vault.get(oauth.clientSecretVaultKey).catch(() => null);
        if (clientSecret) addSecret(clientSecret);
      }
      if (oauth.clientSecret) addSecret(oauth.clientSecret);
    }

    if (this.personal) assertPersonalHeaders(resolvedHeaders);
    return {
      url: resolvedUrl,
      headers: resolvedHeaders,
      env: resolvedEnv,
      args: resolvedArgs,
      oauth,
      sentSecrets: [...sentSecrets],
    };
  }

  // Loop opens sign-in links that a server asks for, and nothing else: no forms, no sampling.
  _newClient(conn) {
    if (this._formAskers.has(conn.id)) return new Client(CLIENT_INFO, { capabilities: {} });
    const client = new Client(CLIENT_INFO, { capabilities: { elicitation: { url: {} } } });
    // Below the SDK's own wrapper, which answers a form before Loop can see that the server asks for one.
    Protocol.prototype.setRequestHandler.call(client, ElicitRequestSchema, async ({ params }) => {
      if (params?.mode !== 'url') {
        // An older server takes the capability for "can fill in forms". The next session does not offer it.
        this._formAskers.add(conn.id);
        await this.retire(conn.id).catch(() => {});
        throw new McpError(ErrorCode.InvalidParams, 'Client does not support form-mode elicitation requests');
      }
      // The request does not say which call it belongs to. With more than one, nobody may get the link.
      const calls = [...(this._liveCalls.get(client) || [])];
      if (calls.length !== 1 || !calls[0].onSignIn) return { action: 'cancel' };
      return calls[0].onSignIn({ url: params.url, message: params.message });
    });
    return client;
  }

  async _openSession(conn, resolvedHeaders, resolvedEnv, { resolvedUrl = null, resolvedArgs = null, redactor = null } = {}) {
    const personalUrl = this.personal ? assertPersonalStoredConnection(conn, { selfIdentity: this.selfIdentity }) : null;
    if (this.personal) assertPersonalHeaders(resolvedHeaders);
    const transportType = personalUrl
      ? (conn.transport ?? conn.type ?? 'http')
      : String(conn.transport || (conn.command ? 'stdio' : 'http')).toLowerCase();

    if (transportType === 'stdio') {
      if (!conn.command) {
        throw new Error(`Connection "${conn.name || conn.id}" is missing a stdio command.`);
      }
      const rawArgs = Array.isArray(conn.args) ? conn.args.map(String) : [];
      const finalArgs = Array.isArray(resolvedArgs)
        ? resolvedArgs
        : this.vault && typeof this.vault.resolveString === 'function'
          ? await Promise.all(rawArgs.map((a) => this.vault.resolveString(a)))
          : rawArgs;
      if (this.selfIdentity?.isSelfStdio?.(conn.command, finalArgs)) {
        throw new Error('Loop cannot connect to itself.');
      }

      if (conn.cwd) {
        let cwdStat;
        try {
          cwdStat = await stat(conn.cwd);
        } catch {
          throw new Error(`Working directory not found: ${conn.cwd}`);
        }
        if (!cwdStat.isDirectory()) {
          throw new Error(`Working directory not found: ${conn.cwd}`);
        }
      }

      const client = this._newClient(conn);
      const transport = new StdioClientTransport({
        command: conn.command,
        args: finalArgs,
        env: buildStdioEnv(resolvedEnv, { inheritEnv: conn.inheritEnv === true }),
        ...(conn.cwd ? { cwd: conn.cwd } : {}),
        stderr: 'pipe',
      });

      let stderrBuf = '';
      if (transport.stderr) {
        transport.stderr.on('data', (chunk) => {
          stderrBuf = (stderrBuf + String(chunk)).slice(-2048);
        });
      }

      try {
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
        return { client, transport };
      } catch (err) {
        await safeClose(client, transport);
        const safeStderr = redactor?.hasSecrets ? redactor.redact(stderrBuf) : stderrBuf;
        throw redactError(normalizeError(err, safeStderr), redactor);
      }
    }

    if (!conn.url && !resolvedUrl) {
      throw new Error(`Connection "${conn.name || conn.id}" is missing a server URL.`);
    }

    const endpointUrl = resolvedUrl || personalUrl || new URL(conn.url);
    this.outboundPolicy.assertConnectionUrl(endpointUrl.href);

    const requestInit = { headers: resolvedHeaders };
    const transportOptions = this.personal
      ? { requestInit, fetch: this.upstreamFetch || createPersonalFetch(endpointUrl.origin, { selfIdentity: this.selfIdentity }) }
      : { requestInit, ...(this.upstreamFetch ? { fetch: this.upstreamFetch } : {}) };

    if (transportType === 'sse') {
      const client = this._newClient(conn);
      const transport = new SSEClientTransport(endpointUrl, transportOptions);
      try {
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
        return { client, transport };
      } catch (err) {
        await safeClose(client, transport);
        throw redactError(normalizeError(err), redactor);
      }
    }

    // Default: Streamable HTTP with automatic fallback to SSE on 404/405/not-found errors (never on 401)
    const httpClient = this._newClient(conn);
    const httpTransport = new StreamableHTTPClientTransport(endpointUrl, transportOptions);
    try {
      await httpClient.connect(httpTransport, { timeout: CONNECT_TIMEOUT_MS });
      return { client: httpClient, transport: httpTransport };
    } catch (err) {
      await safeClose(httpClient, httpTransport);
      const normalized = redactError(normalizeError(err), redactor);
      if (!shouldFallbackToSse(normalized)) {
        throw normalized;
      }

      const sseClient = this._newClient(conn);
      const sseTransport = new SSEClientTransport(endpointUrl, transportOptions);
      try {
        await sseClient.connect(sseTransport, { timeout: CONNECT_TIMEOUT_MS });
        return { client: sseClient, transport: sseTransport };
      } catch (sseErr) {
        await safeClose(sseClient, sseTransport);
        throw redactError(normalizeError(sseErr), redactor);
      }
    }
  }

  async getClient(connId) {
    return (await this._getSession(connId)).client;
  }

  async _getSession(connId) {
    if (this._closed) {
      throw new Error(`Connection "${connId}" was closed or removed while connecting.`);
    }

    const gen = this._invalidations.get(connId) || 0;
    const conn = await this.store.get(connId);
    if (!conn) {
      throw new Error(`Connection "${connId}" not found.`);
    }
    if (conn.enabled === false) {
      throw new Error(`Connection "${conn.name || connId}" is disabled.`);
    }
    // Its address is not on the network: Loop hands each call to the Loop that lends it.
    if (isSharedConnection(conn)) {
      throw new Error(`Connection "${conn.name || connId}" comes from somebody else's Loop and has no session of its own.`);
    }

    const {
      url: resolvedUrl,
      headers: resolvedHeaders,
      env: resolvedEnv,
      args: resolvedArgs,
      oauth,
      sentSecrets,
    } = await this.buildResolvedAuth(conn);

    const isInvalidated = () => this._closed || (this._invalidations.get(connId) || 0) !== gen;
    if (isInvalidated()) {
      throw new Error(`Connection "${connId}" was closed or removed while connecting.`);
    }

    const fingerprint = computeFingerprint(conn, resolvedHeaders, resolvedEnv, oauth, resolvedUrl, resolvedArgs);

    const existing = this.sessions.get(connId);
    if (existing && existing.fingerprint === fingerprint) {
      existing.lastUsedAt = this._now();
      return existing;
    }

    const pendingKey = `${connId}:${fingerprint}`;
    if (this.pendingConnects.has(pendingKey)) {
      return this.pendingConnects.get(pendingKey);
    }

    const redactor = createRedactor(sentSecrets);

    const connectPromise = (async () => {
      // Settings or credentials changed (a refreshed token, say). Calls already running on the
      // old session finish there; it is not closed under them.
      if (existing) {
        await this.retire(connId);
      }

      if (isInvalidated()) {
        throw new Error(`Connection "${connId}" was closed or removed while connecting.`);
      }

      const { client, transport } = await this._openSession(conn, resolvedHeaders, resolvedEnv, {
        resolvedUrl,
        resolvedArgs,
        redactor,
      });

      if (isInvalidated()) {
        await safeClose(client, transport);
        throw new Error(`Connection "${connId}" was closed or removed while connecting.`);
      }

      const latest = await this.store.get(connId);
      if (!latest || latest.enabled === false || isInvalidated()) {
        await safeClose(client, transport);
        throw new Error(`Connection "${connId}" was closed or removed while connecting.`);
      }

      const transportType = String(conn.transport || (conn.command ? 'stdio' : 'http')).toLowerCase();
      const session = {
        client,
        transport,
        transportType,
        fingerprint,
        sentSecrets,
        redactor,
        uses: 0,
        retired: false,
        lastUsedAt: this._now(),
      };

      client.onclose = () => {
        this.draining.delete(session);
        if (this.sessions.get(connId) === session) {
          this.sessions.delete(connId);
        }
      };
      client.onerror = () => {
        // Transport errors are surfaced to in-flight requests; prevent unhandled error noise.
      };
      if (typeof client.setNotificationHandler === 'function') {
        const handleListChanged = () => {
          this.sync(connId).catch(() => {});
        };
        client.setNotificationHandler(ToolListChangedNotificationSchema, handleListChanged);
        client.setNotificationHandler(ResourceListChangedNotificationSchema, handleListChanged);
        client.setNotificationHandler(PromptListChangedNotificationSchema, handleListChanged);
      }

      const prev = this.sessions.get(connId);
      if (prev && prev !== session) {
        await this.retire(connId);
      }
      this.sessions.set(connId, session);
      if (this._ttlForSession(session) > 0) {
        this._ensureIdleSweep();
      }
      // If the upstream server deployed a new MCP serverInfo.version since our last sync,
      // trigger an immediate background catalog refresh so new or updated tools appear right away.
      const liveVersion = cleanServerVersion(
        typeof client.getServerVersion === 'function' ? client.getServerVersion()?.version : '',
      );
      if (liveVersion && latest.serverVersion && liveVersion !== latest.serverVersion) {
        this._triggerReactiveRefresh(connId);
      }
      return session;
    })();

    this._opening.add(connectPromise);
    connectPromise.finally(() => {
      this._opening.delete(connectPromise);
    }).catch(() => {});

    this.pendingConnects.set(pendingKey, connectPromise);
    try {
      return await connectPromise;
    } finally {
      if (this.pendingConnects.get(pendingKey) === connectPromise) {
        this.pendingConnects.delete(pendingKey);
      }
    }
  }

  // A session counts each call or sync using it, so replacing it never cuts one off.
  async _acquire(connId) {
    const session = await this._getSession(connId);
    session.uses += 1;
    session.lastUsedAt = this._now();
    return session;
  }

  async _release(session) {
    session.uses -= 1;
    session.lastUsedAt = this._now();
    if (session.retired && session.uses <= 0) {
      this.draining.delete(session);
      await safeClose(session.client, session.transport);
    }
  }

  // Evicts idle sessions whose transport TTL has elapsed. Active sessions (uses > 0) are never evicted.
  async evictIdle(nowMs = this._now()) {
    if (this._closed) return [];
    const targets = [];
    for (const [connId, session] of this.sessions.entries()) {
      if (!session || session.uses > 0 || session.retired) continue;
      const ttl = this._ttlForSession(session);
      if (!ttl || ttl <= 0) continue;
      const lastUsedAt = Number.isFinite(session.lastUsedAt) ? session.lastUsedAt : 0;
      if (nowMs - lastUsedAt >= ttl) {
        targets.push([connId, session]);
      }
    }
    const evicted = [];
    for (const [connId, session] of targets) {
      if (this.sessions.get(connId) !== session || session.uses > 0 || session.retired) continue;
      await this.retire(connId);
      evicted.push(connId);
    }
    return evicted;
  }

  // Takes a Connection's session out of use so the next call or sync opens a new one. Calls already
  // running finish on the old session, which then closes. Use this when settings or sign-in change
  // or a fresh connection is wanted; use invalidate() to stop a Connection outright.
  async retire(connId) {
    this._clearReadEvidence(connId);
    this._clearSyncBackoff(connId);
    const session = this.sessions.get(connId);
    if (!session) return;
    this.sessions.delete(connId);
    if (session.uses > 0) {
      session.retired = true;
      this.draining.add(session);
      return;
    }
    await safeClose(session.client, session.transport);
  }

  _isBusy(connId) {
    return (this.activeCalls.get(connId) || 0) > 0;
  }

  // Nothing is running: no calls and no syncs.
  isIdle() {
    return (
      this.activeCalls.size === 0 &&
      this.inFlightSyncs.size === 0 &&
      this.bgSyncs.size === 0 &&
      this.reactiveSyncs.size === 0 &&
      this._opening.size === 0
    );
  }

  async sync(connId) {
    if (this.inFlightSyncs.has(connId)) {
      return this.inFlightSyncs.get(connId);
    }
    const run = this._runSync(connId).finally(() => {
      if (this.inFlightSyncs.get(connId) === run) {
        this.inFlightSyncs.delete(connId);
      }
    });
    this.inFlightSyncs.set(connId, run);
    return run;
  }

  // Reads what the upstream offers (tools, resources, prompts, instructions) over an open session.
  async _readCatalog(client, redactor = null) {
    const redactVal = (val) => (redactor?.hasSecrets ? redactor.redact(val) : val);
    const caps = client.getServerCapabilities() || {};
    const serverInfo = typeof client.getServerVersion === 'function' ? client.getServerVersion() : null;
    const rawInstructions =
      typeof client.getInstructions === 'function' ? client.getInstructions() : '';
    const safeInstructions = typeof rawInstructions === 'string' ? redactVal(rawInstructions) : '';
    const serverInstructions =
      typeof safeInstructions === 'string' ? safeInstructions.trim().slice(0, 4000) : '';
    const rawServerName = typeof serverInfo?.name === 'string' ? redactVal(serverInfo.name) : '';
    const discoveredName = typeof rawServerName === 'string'
      ? rawServerName.replace(/\s+/g, ' ').trim().slice(0, 120)
      : '';
    const rawDescription = typeof serverInfo?.description === 'string' ? redactVal(serverInfo.description) : '';
    const discoveredDescription =
      typeof rawDescription === 'string'
        ? rawDescription.replace(/\s+/g, ' ').trim().slice(0, 500)
        : '';

    const warnings = [];
    const notePagination = (label, pageResult) => {
      if (!pageResult?.truncated) return;
      if (pageResult.truncationReason === 'cursor_cycle') {
        warnings.push(`${label} pagination stopped early due to a cursor cycle.`);
      } else if (pageResult.truncationReason === 'max_pages') {
        warnings.push(`${label} listing truncated after ${MAX_LIST_PAGES} pages.`);
      }
    };

    const requestPage = (method, fallbackFn) => (params) => {
      if (typeof client.request === 'function') {
        return client.request({ method, params }, ResultSchema, { timeout: REQUEST_TIMEOUT_MS });
      }
      return fallbackFn(params, { timeout: REQUEST_TIMEOUT_MS });
    };

    let rawTools = [];
    let toolsPageResult = { items: [], truncated: false, truncationReason: null };
    try {
      toolsPageResult = await listAllPages(
        requestPage('tools/list', (params, opts) => client.listTools(params, opts)),
        'tools',
        { maxItems: MAX_TOOLS_PER_CONN * 4 },
      );
      rawTools = toolsPageResult.items;
    } catch (err) {
      const normalized = redactError(normalizeError(err), redactor);
      if (!isUnsupportedMethodError(normalized)) throw normalized;
    }

    const tools = [];
    const validRawToolsForCache = [];
    const seenToolNames = new Set();
    let toolsCapped = false;
    for (const t of rawTools) {
      if (!t || typeof t !== 'object' || Array.isArray(t)) continue;
      if (typeof t.name !== 'string' || !t.name.trim()) continue;
      const name = t.name;
      if (seenToolNames.has(name)) continue;
      if (tools.length >= MAX_TOOLS_PER_CONN) {
        toolsCapped = true;
        break;
      }
      seenToolNames.add(name);

      const title =
        typeof t.title === 'string' && t.title.trim()
          ? truncateText(redactVal(t.title.trim()), 200)
          : '';
      let description =
        typeof t.description === 'string' && t.description.trim()
          ? truncateText(redactVal(t.description), MAX_TOOL_DESCRIPTION_CHARS)
          : title;
      const rawSchema =
        t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)
          ? redactVal(t.inputSchema)
          : { type: 'object', properties: {} };
      let inputSchema = rawSchema;
      let schemaOversized = false;
      try {
        const serialized = JSON.stringify(rawSchema);
        if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_TOOL_INPUT_SCHEMA_BYTES) {
          schemaOversized = true;
        }
      } catch {
        schemaOversized = true;
      }
      if (schemaOversized) {
        inputSchema = { type: 'object', properties: {} };
        const joined = description ? `${description} ${OVERSIZED_SCHEMA_NOTE}` : OVERSIZED_SCHEMA_NOTE;
        description =
          joined.length <= MAX_TOOL_DESCRIPTION_CHARS
            ? joined
            : `${description.slice(0, Math.max(0, MAX_TOOL_DESCRIPTION_CHARS - OVERSIZED_SCHEMA_NOTE.length - 2))}… ${OVERSIZED_SCHEMA_NOTE}`;
      }

      let outputSchema;
      if (t.outputSchema && typeof t.outputSchema === 'object' && !Array.isArray(t.outputSchema)) {
        try {
          const redactedOut = redactVal(t.outputSchema);
          const serializedOut = JSON.stringify(redactedOut);
          if (typeof serializedOut === 'string' && Buffer.byteLength(serializedOut, 'utf8') <= MAX_TOOL_INPUT_SCHEMA_BYTES) {
            outputSchema = redactedOut;
          }
        } catch {
          // Skip unserializable outputSchema.
        }
      }

      const safeAnnotationsInput =
        t.annotations && typeof t.annotations === 'object' && !Array.isArray(t.annotations)
          ? redactVal(t.annotations)
          : undefined;
      const annotations = normalizeToolAnnotations(safeAnnotationsInput);
      const safeMeta = normalizeUpstreamToolUiMeta(
        t._meta && typeof t._meta === 'object' && !Array.isArray(t._meta) ? redactVal(t._meta) : undefined,
      );

      tools.push(
        redactVal({
          name,
          ...(title ? { title } : {}),
          description,
          inputSchema,
          ...(outputSchema ? { outputSchema } : {}),
          ...(annotations ? { annotations } : {}),
          ...(safeMeta ? { _meta: safeMeta } : {}),
        }),
      );
      validRawToolsForCache.push(t);
    }
    if (toolsCapped || (toolsPageResult.truncated && toolsPageResult.truncationReason === 'limit')) {
      warnings.push(`Tools list truncated to ${MAX_TOOLS_PER_CONN} tools.`);
    } else {
      notePagination('Tools', toolsPageResult);
    }

    // Do not call client.cacheToolMetadata(validRawToolsForCache): when an upstream tool declares
    // outputSchema but omits structuredContent, the MCP SDK throws AFTER the write succeeded.

    let resources = [];
    try {
      const resourcesPageResult = await listAllPages(
        requestPage('resources/list', (params, opts) => client.listResources(params, opts)),
        'resources',
        { maxItems: MAX_RESOURCES_PER_CONN * 4 },
      );
      const seenUris = new Set();
      let resourcesCapped = false;
      for (const r of resourcesPageResult.items) {
        if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
        if (typeof r.uri !== 'string' || !r.uri.trim()) continue;
        if (seenUris.has(r.uri)) continue;
        if (resources.length >= MAX_RESOURCES_PER_CONN) {
          resourcesCapped = true;
          break;
        }
        seenUris.add(r.uri);
        resources.push(
          redactVal({
            uri: r.uri,
            name: typeof r.name === 'string' && r.name ? r.name : r.uri,
            description:
              typeof r.description === 'string'
                ? truncateText(r.description, MAX_TOOL_DESCRIPTION_CHARS)
                : '',
            mimeType: typeof r.mimeType === 'string' ? r.mimeType : null,
          }),
        );
      }
      if (resourcesCapped || (resourcesPageResult.truncated && resourcesPageResult.truncationReason === 'limit')) {
        warnings.push(`Resources list truncated to ${MAX_RESOURCES_PER_CONN} resources.`);
      } else {
        notePagination('Resources', resourcesPageResult);
      }
    } catch (err) {
      const normalized = redactError(normalizeError(err), redactor);
      if (isUnauthorizedError(normalized)) throw normalized;
      if (!isUnsupportedMethodError(normalized) && caps.resources) {
        // Best-effort: ignore unsupported/unimplemented resource listing errors
      }
    }

    let prompts = [];
    try {
      const promptsPageResult = await listAllPages(
        requestPage('prompts/list', (params, opts) => client.listPrompts(params, opts)),
        'prompts',
        { maxItems: MAX_PROMPTS_PER_CONN * 4 },
      );
      const seenPrompts = new Set();
      let promptsCapped = false;
      for (const p of promptsPageResult.items) {
        if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
        if (typeof p.name !== 'string' || !p.name.trim()) continue;
        if (seenPrompts.has(p.name)) continue;
        if (prompts.length >= MAX_PROMPTS_PER_CONN) {
          promptsCapped = true;
          break;
        }
        seenPrompts.add(p.name);
        prompts.push(
          redactVal({
            name: p.name,
            description:
              typeof p.description === 'string'
                ? truncateText(p.description, MAX_TOOL_DESCRIPTION_CHARS)
                : '',
            arguments: Array.isArray(p.arguments) ? p.arguments : [],
          }),
        );
      }
      if (promptsCapped || (promptsPageResult.truncated && promptsPageResult.truncationReason === 'limit')) {
        warnings.push(`Prompts list truncated to ${MAX_PROMPTS_PER_CONN} prompts.`);
      } else {
        notePagination('Prompts', promptsPageResult);
      }
    } catch (err) {
      const normalized = redactError(normalizeError(err), redactor);
      if (isUnauthorizedError(normalized)) throw normalized;
      if (!isUnsupportedMethodError(normalized) && caps.prompts) {
        // Best-effort: ignore unsupported/unimplemented prompt listing errors
      }
    }

    // Skills over MCP (SEP-2640): discover provider Skills when advertised by the upstream server.
    // Stored on the Connection for the Owner to review; hidden from agents until partnerSkillsEnabled is true.
    let skills = [];
    const advertisesSkills = Boolean(
      (caps?.extensions && typeof caps.extensions === 'object' && caps.extensions[MCP_SKILLS_EXTENSION]) ||
      (caps?.experimental && typeof caps.experimental === 'object' && caps.experimental[MCP_SKILLS_EXTENSION]),
    );
    if (advertisesSkills) {
      try {
        const skillsPageResult = await listAllPages(
          requestPage('skills/list', (params, opts) =>
            client.request({ method: 'skills/list', params }, ResultSchema, opts),
          ),
          'skills',
          { maxItems: MAX_REMOTE_SKILLS_PER_CONN * 2 },
        );
        skills = normalizeUpstreamSkills(redactVal(skillsPageResult.items));
        if (skillsPageResult.truncated) {
          if (skillsPageResult.truncationReason === 'limit') {
            warnings.push(`Skills list truncated to ${MAX_REMOTE_SKILLS_PER_CONN} skills.`);
          } else {
            notePagination('Skills', skillsPageResult);
          }
        }
      } catch (err) {
        const normalized = redactError(normalizeError(err), redactor);
        if (isUnauthorizedError(normalized)) throw normalized;
        // Best-effort: ignore unsupported/unimplemented skill listing errors
      }
    }

    // What the connection says about itself for display: its icons, version, and website (used for its logo).
    const serverIcons = Array.isArray(serverInfo?.icons) ? redactVal(serverInfo.icons) : [];
    const websiteUrl = typeof serverInfo?.websiteUrl === 'string' ? redactVal(serverInfo.websiteUrl) : null;
    const serverVersion = cleanServerVersion(typeof serverInfo?.version === 'string' ? redactVal(serverInfo.version) : '');
    const truncationNote = warnings.length > 0 ? truncateText(warnings.join(' '), MAX_LAST_ERROR_CHARS) : null;

    return {
      tools: redactVal(tools),
      resources: redactVal(resources),
      prompts: redactVal(prompts),
      skills: redactVal(skills),
      serverInstructions: redactVal(serverInstructions),
      discoveredName: redactVal(discoveredName),
      discoveredDescription: redactVal(discoveredDescription),
      serverIcons,
      websiteUrl,
      serverVersion,
      truncated: warnings.length > 0,
      truncationNote,
    };
  }

  // A sync leaves the Connection's session as it found it: an open one is reused, never closed
  // under running calls, and a local process the sync had to start is stopped again afterwards.
  // Callers that need a new connection (an edit, a sign-in, the Sync button) call retire() first.
  // Whether a remote server publishes OAuth Protected Resource Metadata (RFC 9728). MCP servers
  // that require sign-in publish it, even when they let anyone list their tools.
  async _advertisesSignIn(conn) {
    if (!conn?.url || conn.transport === 'stdio') return false;
    let parsed;
    try { parsed = new URL(conn.url); } catch { return false; }
    this._signInAdvertCache = this._signInAdvertCache || new Map();
    const cached = this._signInAdvertCache.get(parsed.href);
    if (cached && cached.until > this._now()) return cached.value;
    const net = this.personal
      ? personalOAuthNetwork({ selfIdentity: this.selfIdentity })
      : this.outboundPolicy.oauthNetwork(parsed.href);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    const candidates = [];
    if (pathname && pathname !== '/') candidates.push(`${parsed.origin}/.well-known/oauth-protected-resource${pathname}`);
    candidates.push(`${parsed.origin}/.well-known/oauth-protected-resource`);
    let value = false;
    for (const candidate of candidates) {
      try {
        const res = await net.fetch(candidate, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4_000) });
        if (!res.ok) { await res.body?.cancel().catch(() => {}); continue; }
        const json = await res.json().catch(() => null);
        if (json && Array.isArray(json.authorization_servers) && json.authorization_servers.length > 0) { value = true; break; }
      } catch {
        // Missing or unreachable metadata: no evidence either way.
      }
    }
    this._signInAdvertCache.set(parsed.href, { value, until: this._now() + 10 * 60_000 });
    return value;
  }

  // The tools of a lent connection come from the Loop that lends it. When that has ended, it has none.
  async _syncShared(current, attemptAt) {
    let catalog = { tools: [], serverIcons: [], websiteUrl: null };
    let lastError = null;
    try {
      if (!this.sharedDispatcher) throw new Error('This connection works only in Loop Cloud.');
      catalog = await this.sharedDispatcher.catalog(current);
    } catch (err) {
      lastError = truncateText(String(err?.message || 'This connection has ended.'), MAX_LAST_ERROR_CHARS);
    }
    const updated = await this.store.update(current.id, {
      tools: catalog.tools,
      resources: [],
      prompts: [],
      serverIcons: catalog.serverIcons,
      websiteUrl: catalog.websiteUrl,
      authRequired: false,
      syncVersion: SYNC_VERSION,
      lastSyncAt: attemptAt,
      lastSyncAttemptAt: attemptAt,
      syncFailures: lastError ? Math.max(0, Number(current.syncFailures) || 0) + 1 : 0,
      lastError,
    });
    this._clearSyncBackoff(current.id);
    try { this.onSync?.(updated); } catch { /* ignore listener errors */ }
    if (updated && canonicalJson(Array.isArray(current.tools) ? current.tools : []) !== canonicalJson(updated.tools)) {
      this._emitCatalogChanged({ connId: current.id, toolsChanged: true, resourcesChanged: false, promptsChanged: false, connection: updated });
    }
    return updated || current;
  }

  async _runSync(connId) {
    // A Connection that is turned off is not refreshed, so it never records "is disabled" as an error.
    const current = await this.store?.get?.(connId);
    if (current?.enabled === false) {
      if (current.lastError && /^Connection ".*" is disabled\.$/.test(current.lastError)) {
        return (await this.store.update(connId, { lastError: null })) || current;
      }
      return current;
    }
    const attemptMs = this._now();
    const attemptAt = new Date(attemptMs).toISOString();
    if (isRelayConnection(current)) {
      const updated = await this.store.update(connId, {
        authRequired: false,
        syncVersion: SYNC_VERSION,
        lastSyncAt: attemptAt,
        lastSyncAttemptAt: attemptAt,
        syncFailures: 0,
        lastError: null,
      });
      this._clearSyncBackoff(connId);
      try { this.onSync?.(updated); } catch { /* ignore listener errors */ }
      return updated;
    }
    if (isSharedConnection(current)) return this._syncShared(current, attemptAt);
    if (current.transport === 'openapi' || current.transport === 'graphql') {
      const updated = await this.store.update(connId, {
        authRequired: false,
        syncVersion: SYNC_VERSION,
        lastSyncAt: attemptAt,
        lastSyncAttemptAt: attemptAt,
        syncFailures: 0,
        lastError: null,
      });
      this._clearSyncBackoff(connId);
      try { this.onSync?.(updated); } catch { /* ignore */ }
      return updated || current;
    }
    if (isBuiltinConnection(current)) {
      const tools = listBuiltinTools(current.id);
      const prevTools = Array.isArray(current.tools) ? current.tools : [];
      const updated = await this.store.update(connId, {
        tools,
        resources: [],
        prompts: [],
        authRequired: false,
        syncVersion: SYNC_VERSION,
        lastSyncAt: attemptAt,
        lastSyncAttemptAt: attemptAt,
        syncFailures: 0,
        lastError: null,
      });
      this._clearSyncBackoff(connId);
      try { this.onSync?.(updated); } catch { /* ignore listener errors */ }
      if (updated && this._catalogListeners.size > 0) {
        const nextTools = Array.isArray(updated.tools) ? updated.tools : tools;
        if (canonicalJson(prevTools) !== canonicalJson(nextTools)) {
          this._emitCatalogChanged({
            connId,
            toolsChanged: true,
            resourcesChanged: false,
            promptsChanged: false,
            connection: updated,
          });
        }
      }
      return updated || current;
    }
    const before = this.sessions.get(connId) || null;
    const seenSecrets = new Set(Array.isArray(before?.sentSecrets) ? before.sentSecrets : []);
    try {
      let session = await this._acquire(connId);
      if (Array.isArray(session.sentSecrets)) {
        for (const s of session.sentSecrets) seenSecrets.add(s);
      }
      let catalog;
      try {
        try {
          catalog = await this._readCatalog(session.client, session.redactor);
        } catch (err) {
          const normalized = normalizeError(err);
          const refreshed = isUnauthorizedError(normalized)
            ? await this._forceRefreshOAuth(connId).catch(() => false)
            : false;
          // Retry once on an OAuth 401 refresh or when an already-open session went stale.
          if (!refreshed && (session !== before || this._isBusy(connId))) throw err;
          const stale = session;
          session = null;
          await this._release(stale);
          if (this.sessions.get(connId) === stale) {
            if (refreshed) await this.retire(connId);
            else await this.invalidate(connId);
          }
          session = await this._acquire(connId);
          if (Array.isArray(session.sentSecrets)) {
            for (const s of session.sentSecrets) seenSecrets.add(s);
          }
          catalog = await this._readCatalog(session.client, session.redactor);
        }
      } finally {
        if (session) await this._release(session);
      }
      const {
        tools,
        resources,
        prompts,
        skills,
        serverInstructions,
        discoveredName,
        discoveredDescription,
        serverIcons,
        websiteUrl,
        serverVersion,
        truncationNote,
      } = catalog;

      const existingConn = await this.store.get(connId);
      const prevTools = Array.isArray(existingConn?.tools) ? existingConn.tools : [];
      const prevResources = Array.isArray(existingConn?.resources) ? existingConn.resources : [];
      const prevPrompts = Array.isArray(existingConn?.prompts) ? existingConn.prompts : [];
      const prevSkills = Array.isArray(existingConn?.skills) ? existingConn.skills : [];
      const prevServerVersion = existingConn?.serverVersion || '';
      // Some servers list their tools without sign-in and still reject every call, so a listing
      // alone doesn't prove sign-in. With no stored credential, the connection still needs sign-in
      // when a call was already turned away, or when the server says it requires sign-in.
      const stillNeedsSignIn = !hasStoredCredential(existingConn) && (
        Boolean(existingConn?.signInRejectedCall) || await this._advertisesSignIn(existingConn)
      );
      const isGenericName = existingConn?.name === 'Local MCP' || existingConn?.name === 'MCP Server';
      const patch = {
        ...(discoveredName && isGenericName ? { name: discoveredName } : {}),
        tools,
        resources,
        prompts,
        skills: Array.isArray(skills) ? skills : [],
        serverInstructions,
        serverIcons: serverIcons || [],
        websiteUrl: websiteUrl || null,
        ...(serverVersion ? { serverVersion } : {}),
        authRequired: stillNeedsSignIn,
        ...(!stillNeedsSignIn ? { signInBroken: null, signInRejectedCall: false } : {}),
        syncVersion: SYNC_VERSION,
        lastSyncAt: attemptAt,
        lastSyncAttemptAt: attemptAt,
        syncFailures: 0,
        lastError: stillNeedsSignIn
          ? 'Sign in required.'
          : truncationNote ? truncateText(truncationNote, MAX_LAST_ERROR_CHARS) : null,
      };
      if (discoveredDescription && !existingConn?.description) {
        patch.description = discoveredDescription;
      }
      const updated = await this.store.update(connId, patch);
      if (
        session !== before &&
        updated?.transport === 'stdio' &&
        this.sessions.get(connId) === session &&
        !this._isBusy(connId)
      ) {
        await this.invalidate(connId);
      }
      this._clearSyncBackoff(connId);
      try { this.onSync?.(updated); } catch { /* ignore listener errors */ }
      if (updated) {
        const nextTools = Array.isArray(updated.tools) ? updated.tools : tools;
        const nextResources = Array.isArray(updated.resources) ? updated.resources : resources;
        const nextPrompts = Array.isArray(updated.prompts) ? updated.prompts : prompts;
        const nextSkills = Array.isArray(updated.skills) ? updated.skills : (Array.isArray(skills) ? skills : []);
        const toolsChanged = canonicalJson(prevTools) !== canonicalJson(nextTools);
        const resourcesChanged = canonicalJson(prevResources) !== canonicalJson(nextResources);
        const promptsChanged = canonicalJson(prevPrompts) !== canonicalJson(nextPrompts);
        const skillsChanged = canonicalJson(prevSkills) !== canonicalJson(nextSkills);
        const versionChanged = Boolean(serverVersion && prevServerVersion && serverVersion !== prevServerVersion);
        if ((toolsChanged || resourcesChanged || promptsChanged || skillsChanged) && this._catalogListeners.size > 0) {
          this._emitCatalogChanged({
            connId,
            toolsChanged,
            resourcesChanged,
            promptsChanged,
            skillsChanged,
            connection: updated,
          });
        }
        if (toolsChanged || versionChanged) {
          this._reactiveSyncAt.set(connId, this._now());
          this._refreshEndpointSiblings(updated);
        }
      }
      return updated;
    } catch (err) {
      const normalized = normalizeError(err);
      // Close only a session this sync opened, and never under a running call.
      const current = this.sessions.get(connId);
      if (current && current !== before && !this._isBusy(connId)) {
        await this.invalidate(connId);
      }
      const failedConn = await this.store.get(connId).catch(() => null);
      const fallbackSecrets = await this._collectConnectionSecrets(failedConn);
      for (const s of fallbackSecrets) seenSecrets.add(s);
      const redactor = seenSecrets.size > 0 ? createRedactor([...seenSecrets]) : null;
      redactError(normalized, redactor);
      const authRequired = normalized.status === 401;
      const rawError = authRequired
        ? 'Sign in required.'
        : (redactor?.hasSecrets
          ? redactor.redact(normalized.message || 'Could not reach upstream MCP.')
          : (normalized.message || 'Could not reach upstream MCP.'));
      const safeError = truncateText(String(rawError), MAX_LAST_ERROR_CHARS);
      const updated = await this.store.update(connId, {
        authRequired,
        lastSyncAttemptAt: attemptAt,
        syncFailures: (Number(failedConn?.syncFailures) || 0) + 1,
        lastError: safeError,
      });
      if (!updated) {
        this._clearSyncBackoff(connId);
        throw normalized;
      }
      if (authRequired) {
        this._clearSyncBackoff(connId);
      } else {
        this._recordSyncFailure(connId, this._now());
      }
      try { this.onSync?.(updated); } catch { /* ignore listener errors */ }
      return updated;
    }
  }

  async syncIfNeeded(connId, { nowMs = this._now() } = {}) {
    if (!connId || !this.store || typeof this.store.get !== 'function') return null;
    const conn = await this.store.get(connId);
    if (!conn || conn.enabled === false || conn.authRequired === true) return conn;
    if (this.shouldSkipAutoSync(connId, nowMs)) return conn;
    if (!needsAutoSync(conn, nowMs)) return conn;
    return this.sync(connId);
  }

  async syncStale({ concurrency = 4 } = {}) {
    if (!this.store || typeof this.store.list !== 'function') return { total: 0, synced: 0, failed: 0 };
    const nowMs = this._now();
    const all = await this.store.list();
    const due = all.filter(
      (m) => needsAutoSync(m, nowMs) && !this.inFlightSyncs.has(m.id) && !this.shouldSkipAutoSync(m.id, nowMs),
    );
    if (due.length === 0) return { total: 0, synced: 0, failed: 0 };
    let synced = 0;
    let failed = 0;
    const queue = [...due];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        try {
          const res = await this.sync(item.id);
          if (res?.lastError) failed += 1;
          else synced += 1;
        } catch {
          failed += 1;
        }
      }
    });
    await Promise.all(workers);
    return { total: due.length, synced, failed };
  }

  _maybeRefreshStale(connId) {
    if (
      this.bgSyncs.has(connId) ||
      this.inFlightSyncs.has(connId) ||
      this.shouldSkipAutoSync(connId) ||
      !this.store ||
      typeof this.store.get !== 'function'
    ) return;
    const task = (async () => {
      const nowMs = this._now();
      if (this.shouldSkipAutoSync(connId, nowMs)) return;
      const conn = await this.store.get(connId);
      if (!shouldSyncAfterCall(conn, nowMs)) return;
      await this.sync(connId);
    })()
      .catch(() => {})
      .finally(() => {
        if (this.bgSyncs.get(connId) === task) this.bgSyncs.delete(connId);
      });
    this.bgSyncs.set(connId, task);
  }

  // Triggered immediately (with a 60-second cooldown) when a server reports a new version,
  // rejects a renamed/removed tool or updated schema, or a sibling account receives new tools.
  _triggerReactiveRefresh(connId) {
    if (
      !connId ||
      this._closed ||
      this.reactiveSyncs.has(connId) ||
      this.inFlightSyncs.has(connId) ||
      !this.store ||
      typeof this.store.get !== 'function'
    ) return;
    const nowMs = this._now();
    const lastAt = this._reactiveSyncAt.get(connId) || 0;
    if (nowMs - lastAt < REACTIVE_SYNC_COOLDOWN_MS) return;
    this._reactiveSyncAt.set(connId, nowMs);
    const task = (async () => {
      const conn = await this.store.get(connId);
      if (!conn || conn.enabled === false || conn.authRequired === true || isBuiltinConnection(conn) || isRelayConnection(conn) || isSharedConnection(conn)) {
        return;
      }
      await this.sync(connId);
    })()
      .catch(() => {})
      .finally(() => {
        if (this.reactiveSyncs.get(connId) === task) this.reactiveSyncs.delete(connId);
      });
    this.reactiveSyncs.set(connId, task);
  }

  _refreshEndpointSiblings(sourceConn) {
    if (
      !sourceConn?.id ||
      this._closed ||
      isBuiltinConnection(sourceConn) ||
      isRelayConnection(sourceConn) ||
      isSharedConnection(sourceConn) ||
      !this.store ||
      typeof this.store.list !== 'function'
    ) return;
    const key = serviceEndpointKeyOf(sourceConn);
    if (!key) return;
    this.store.list().then((all) => {
      if (this._closed || !Array.isArray(all)) return;
      for (const other of all) {
        if (!other || other.id === sourceConn.id) continue;
        if (other.enabled === false || other.authRequired === true) continue;
        if (isBuiltinConnection(other) || isRelayConnection(other) || isSharedConnection(other)) continue;
        if (serviceEndpointKeyOf(other) !== key) continue;
        this._triggerReactiveRefresh(other.id);
      }
    }).catch(() => {});
  }

  // Reactive refresh on HTTP 401 when the upstream rejected an access token early
  // (clock skew, omitted expires_in, or early rotation) and we hold a refresh token.
  async _forceRefreshOAuth(connId) {
    if (!connId || !this.store || typeof this.store.get !== 'function' || !this.vault || typeof this.vault.get !== 'function') {
      return false;
    }
    const conn = await this.store.get(connId).catch(() => null);
    const oauth = conn?.oauth;
    if (!conn || !oauth?.refreshTokenVaultKey || !oauth?.tokenEndpoint || !oauth?.accessTokenVaultKey) {
      return false;
    }
    const resolvedOrigin = normalizedOriginOf(conn.url);
    const boundOrigin =
      typeof oauth.boundOrigin === 'string' && oauth.boundOrigin.trim()
        ? oauth.boundOrigin.trim().toLowerCase()
        : null;
    if (boundOrigin && (!resolvedOrigin || resolvedOrigin !== boundOrigin)) {
      return false;
    }
    const expectedOrigin = boundOrigin || resolvedOrigin;
    const expectedGrantId = typeof oauth.grantId === 'string' && oauth.grantId ? oauth.grantId : null;
    const expectedAccessKey = oauth.accessTokenVaultKey;
    const matchesGrantAndOrigin = (latest) => {
      if (!latest || !latest.oauth) return false;
      if (expectedGrantId) {
        if (latest.oauth.grantId !== expectedGrantId) return false;
      } else if (latest.oauth.accessTokenVaultKey !== expectedAccessKey) {
        return false;
      }
      const latestOrigin = normalizedOriginOf(latest.url);
      if (expectedOrigin && latestOrigin !== expectedOrigin) return false;
      return true;
    };
    const oauthNet = this.personal
      ? personalOAuthNetwork({ selfIdentity: this.selfIdentity })
      : this.outboundPolicy.oauthNetwork(conn.url || null);
    const refreshed = await refreshOAuthToken(conn, this.vault, {
      network: oauthNet,
      selfIdentity: this.selfIdentity,
      onRevoked: async () => {
        await this._updateConnectionIf(conn.id, matchesGrantAndOrigin, {
          authRequired: true,
          lastError: 'Sign in required.',
        }).catch(() => {});
      },
      onClientRejected: async () => {
        await this._updateConnectionIf(conn.id, matchesGrantAndOrigin, {
          authRequired: true,
          lastError: 'The service refused Loop’s OAuth client. Sign in again to register a fresh client.',
          oauth: { ...oauth, clientRejected: true },
        }).catch(() => {});
      },
    });
    if (!refreshed) return false;
    const cas = await this._updateConnectionIf(conn.id, matchesGrantAndOrigin, { oauth: refreshed });
    if (!cas.updated) {
      const latestConn = cas.entry ?? (await this.store.get(conn.id).catch(() => null));
      await this._cleanupDiscardedRefreshKeys(refreshed, latestConn);
      return false;
    }
    return true;
  }

  // Runs one request on the Connection's session. A request is sent a second time only when the
  // upstream cannot have run the first: a tool call that may have run is never repeated, because
  // the upstream would do the work twice. Reads (safeToRepeat) are repeated on any dropped session.
  async _withRetry(connId, fn, { safeToRepeat = false, singleAttempt = false, extraSecrets = [], signal = null } = {}) {
    if (signal?.aborted) {
      throw createAbortError(signal);
    }
    this.activeCalls.set(connId, (this.activeCalls.get(connId) || 0) + 1);
    const seenSecrets = new Set();
    if (Array.isArray(extraSecrets)) {
      for (const s of extraSecrets) {
        if (typeof s === 'string' && s.length > 0) seenSecrets.add(s);
      }
    }
    const trackSessionSecrets = (sess) => {
      if (Array.isArray(sess?.sentSecrets)) {
        for (const s of sess.sentSecrets) {
          if (typeof s === 'string' && s.length > 0) seenSecrets.add(s);
        }
      }
    };

    let session = null;
    try {
      session = await this._acquire(connId);
      trackSessionSecrets(session);
      if (signal?.aborted) {
        throw createAbortError(signal);
      }
      let res;
      try {
        res = await fn(session.client);
      } catch (err) {
        if (isAbortError(err, signal)) {
          throw createAbortError(signal);
        }
        const normalized = normalizeError(err);
        let refreshedAfter401 = false;
        if (isUnauthorizedError(normalized)) {
          refreshedAfter401 = await this._forceRefreshOAuth(connId).catch(() => false);
        }
        if (singleAttempt && !refreshedAfter401) throw noteIfUnconfirmed(normalized);
        const resend = refreshedAfter401 || (safeToRepeat ? !isNonRetryableRpcError(normalized) : wasNeverAccepted(normalized));
        if (!resend) throw safeToRepeat ? normalized : noteIfUnconfirmed(normalized);
        // Replace the session that failed. Other calls still running on it finish there.
        const failed = session;
        session = null;
        if (this.sessions.get(connId) === failed) await this.retire(connId);
        await this._release(failed);
        if (signal?.aborted) {
          throw createAbortError(signal);
        }
        session = await this._acquire(connId);
        trackSessionSecrets(session);
        if (signal?.aborted) {
          throw createAbortError(signal);
        }
        try {
          res = await fn(session.client);
        } catch (retryErr) {
          if (isAbortError(retryErr, signal)) {
            throw createAbortError(signal);
          }
          const retryNormalized = normalizeError(retryErr);
          throw safeToRepeat ? retryNormalized : noteIfUnconfirmed(retryNormalized);
        }
      }
      if (signal?.aborted) {
        throw createAbortError(signal);
      }
      this._clearSyncBackoff(connId);
      this._maybeRefreshStale(connId);
      const redactor = createRedactor([...seenSecrets]);
      return redactor.hasSecrets ? redactor.redact(res) : res;
    } catch (err) {
      if (!session && !isAbortError(err, signal)) {
        const conn = await this.store?.get?.(connId).catch(() => null);
        const fallback = await this._collectConnectionSecrets(conn);
        for (const s of fallback) seenSecrets.add(s);
      }
      const redactor = createRedactor([...seenSecrets]);
      throw redactError(err, redactor);
    } finally {
      if (session) await this._release(session);
      const remaining = (this.activeCalls.get(connId) || 1) - 1;
      if (remaining <= 0) this.activeCalls.delete(connId);
      else this.activeCalls.set(connId, remaining);
    }
  }

  // The calls to a Connection that failed since the last one that worked, or null. A server can list
  // its tools and still refuse every call, so a good sync does not prove that the Connection works.
  // Kept in memory without any error text; new settings or a new sign-in start over.
  failedCalls(conn) {
    const failed = this._failedCalls.get(conn?.id);
    return failed && failed.mark === settingsMark(conn) ? { count: failed.count, latestAt: failed.latestAt } : null;
  }

  // Owner dashboard evidence about a provider-reported tool result. It never contains result data.
  readEvidence(conn) {
    const observation = this._readObservations.get(conn?.id);
    if (!observation?.proof) return null;
    if (!conn.enabled || conn.authRequired || conn.lastError || conn.signInBroken ||
        !advertisedRead(conn, observation.proof.tool) || observation.mark !== readSettingsMark(conn, this.vault)) {
      this._readObservations.delete(conn.id);
      return null;
    }
    return { ...observation.proof };
  }

  _clearReadEvidence(id) {
    const hadProof = Boolean(this._readObservations.get(id)?.proof);
    this._readObservations.delete(id);
    if (hadProof) this.onReadEvidenceChange?.();
  }

  clearReadEvidence() {
    if (!this._readObservations.size) return;
    this._readObservations.clear();
    this.onReadEvidenceChange?.();
  }

  _noteCall(conn, worked) {
    if (!conn || isBuiltinConnection(conn)) return;
    if (worked) {
      this._failedCalls.delete(conn.id);
      return;
    }
    this._failedCalls.set(conn.id, {
      count: (this.failedCalls(conn)?.count || 0) + 1,
      latestAt: new Date(this._now()).toISOString(),
      mark: settingsMark(conn),
    });
  }

  async callTool(connId, toolName, args = {}, options = {}) {
    const { signal = null } = options;
    if (signal?.aborted) {
      throw createAbortError(signal);
    }
    let conn = await this.store?.get?.(connId);
    if (!conn && typeof this.relayDispatcher?.listCloudRoutes === 'function') {
      const routes = await this.relayDispatcher.listCloudRoutes().catch(() => []);
      const match = (Array.isArray(routes) ? routes : []).find((r) => r && r.id === connId);
      if (match) {
        conn = { ...match, transport: 'http', home: 'cloud', url: `https://cloud.useloop.sh/c/${match.cloudConnId || match.id}` };
      }
    }
    // The Loop that lends it keeps the record of the calls: an answer such as "wait for a yes" is no fault here.
    if (isSharedConnection(conn)) return this._dispatchTool(conn, connId, toolName, args, options);
    let observation = null;
    if (conn?.enabled && !conn.authRequired && !isBuiltinConnection(conn) && !isCloudRouteConnection(conn) && !isRelayConnection(conn) &&
        advertisedRead(conn, toolName)) {
      const mark = readSettingsMark(conn, this.vault);
      observation = this._readObservations.get(connId);
      if (observation?.mark !== mark) {
        observation = { mark };
        this._readObservations.set(connId, observation);
      }
    }
    try {
      const result = await this._dispatchTool(conn, connId, toolName, args, options);
      if (!reportedToolSuccess(result)) {
        this._clearReadEvidence(connId);
      } else if (observation && this._readObservations.get(connId) === observation && !observation.proof && !signal?.aborted) {
        observation.proof = { connectionId: connId, tool: toolName, succeededAt: new Date(this._now()).toISOString() };
        this.onReadEvidenceChange?.();
      }
      // A call that waits for a sign-in says nothing about the Connection.
      if (!result?._meta?.[SIGN_IN_META]) this._noteCall(conn, !result?.isError);
      if (result?.isError && isToolSchemaMismatchError(result)) {
        this._triggerReactiveRefresh(connId);
      }
      return result;
    } catch (err) {
      this._clearReadEvidence(connId);
      // A rejected sign-in has its own status, and a call the server could not read says nothing
      // about the Connection.
      if (!isAbortError(err, signal) && !isUnauthorizedError(err) && !isNonRetryableRpcError(err)) this._noteCall(conn, false);
      if (!isAbortError(err, signal) && !isUnauthorizedError(err) && isToolSchemaMismatchError(err)) {
        this._triggerReactiveRefresh(connId);
      }
      throw err;
    }
  }

  async _dispatchTool(conn, connId, toolName, args, opts = {}) {
    const { extraSecrets = [], signal = null, profile = 'all', ownerApproved = false, singleAttempt = false } = opts;
    if (isCloudRouteConnection(conn)) {
      if (conn.enabled === false) {
        throw new Error(`Connection "${conn.name || connId}" is disabled.`);
      }
      if (!this.relayDispatcher || typeof this.relayDispatcher.callCloudTool !== 'function') {
        throw new Error(`Connection "${conn.name || connId}" runs in Loop Cloud and requires an active Loop Connect link.`);
      }
      return this.relayDispatcher.callCloudTool(conn, toolName, args || {}, { extraSecrets, signal });
    }
    if (isRelayConnection(conn)) {
      if (conn.enabled === false) {
        throw new Error(`Connection "${conn.name || connId}" is disabled.`);
      }
      if (!this.relayDispatcher || typeof this.relayDispatcher.callTool !== 'function') {
        throw new Error(`Connection "${conn.name || connId}" requires an active Loop Connect session.`);
      }
      return this.relayDispatcher.callTool(conn, toolName, args || {}, { extraSecrets, signal, profile, ownerApproved });
    }
    if (isSharedConnection(conn)) {
      if (conn.enabled === false) {
        throw new Error(`Connection "${conn.name || connId}" is disabled.`);
      }
      if (!this.sharedDispatcher) throw new Error(`Connection "${conn.name || connId}" works only in Loop Cloud.`);
      return this.sharedDispatcher.callTool(conn, toolName, args || {}, { signal });
    }
    if (isBuiltinConnection(conn)) {
      if (conn.enabled === false) {
        throw new Error(`Connection "${conn.name || connId}" is disabled.`);
      }
      const data = await callBuiltinTool(conn.id, toolName, args || {}, {
        fetchImpl: this.builtinFetch || null,
        selfIdentity: this.outboundPolicy?.selfIdentity || null,
        signal,
        agent: opts.agent || null,
        ...(this.builtinContext || {}),
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        isError: false,
      };
    }
    if (conn.transport === 'openapi' || conn.transport === 'graphql') {
      return executeApiTransportTool({
        conn,
        toolName,
        args: args || {},
        vault: this.vault,
        outboundPolicy: this.outboundPolicy,
        extraSecrets,
        signal,
        ...(this.upstreamFetch ? { fetchImpl: this.upstreamFetch } : {}),
      });
    }
    const requestOptions = { timeout: TOOL_CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) };
    return this._withRetry(
      connId,
      (client) => this._callOn(client, conn, { name: toolName, arguments: args || {}, ...(opts.resume || {}) }, requestOptions, opts.onSignIn),
      { extraSecrets, signal, singleAttempt },
    );
  }

  // One tool call on one session. A sign-in that the server asks for comes back as a result.
  async _callOn(client, conn, params, requestOptions, onSignIn = null) {
    const live = this._liveCalls.get(client) || new Set();
    this._liveCalls.set(client, live);
    const call = { onSignIn: typeof onSignIn === 'function' ? onSignIn : null };
    live.add(call);
    let asked = null;
    const name = conn?.name || conn?.id;
    try {
      // The SDK checks a result against the output schema of its tool. A question has no such output.
      const schema = CallToolResultSchema.refine((result) => {
        asked = asksOfResult(result);
        return true;
      });
      const result = await client.callTool(params, schema, requestOptions);
      if (asked) return signInResult(asked, name);
      if (!result?._meta || !Object.hasOwn(result._meta, SIGN_IN_META)) return result;
      const { [SIGN_IN_META]: _forged, ...meta } = result._meta;
      return { ...result, _meta: meta };
    } catch (err) {
      const ask = asked || asksOfError(err);
      if (ask) return signInResult(ask, name);
      throw err;
    } finally {
      live.delete(call);
    }
  }

  async readResource(connId, uri, { extraSecrets = [], signal = null } = {}) {
    if (signal?.aborted) {
      throw createAbortError(signal);
    }
    const requestOptions = { timeout: REQUEST_TIMEOUT_MS, ...(signal ? { signal } : {}) };
    return this._withRetry(
      connId,
      (client) => client.readResource({ uri }, requestOptions),
      { safeToRepeat: true, extraSecrets, signal },
    );
  }

  async getPrompt(connId, name, args = {}, { extraSecrets = [], signal = null } = {}) {
    if (signal?.aborted) {
      throw createAbortError(signal);
    }
    const requestOptions = { timeout: REQUEST_TIMEOUT_MS, ...(signal ? { signal } : {}) };
    return this._withRetry(
      connId,
      (client) =>
        client.getPrompt(
          { name, arguments: args || {} },
          requestOptions,
        ),
      { extraSecrets, signal },
    );
  }

  async invalidate(connId) {
    this._clearReadEvidence(connId);
    this._clearSyncBackoff(connId);
    this._invalidations.set(connId, (this._invalidations.get(connId) || 0) + 1);
    const session = this.sessions.get(connId);
    this.sessions.delete(connId);
    for (const key of this.pendingConnects.keys()) {
      if (key.startsWith(`${connId}:`)) {
        this.pendingConnects.delete(key);
      }
    }
    if (session) {
      await safeClose(session.client, session.transport);
    }
  }

  async close() {
    return this.closeAll();
  }

  async closeAll() {
    this._closed = true;
    this._stopIdleSweep();
    this._syncBackoff.clear();
    await Promise.allSettled([
      ...this.bgSyncs.values(),
      ...this.inFlightSyncs.values(),
      ...this._opening,
    ]);
    if (this._opening.size > 0) {
      await Promise.allSettled([...this._opening]);
    }
    this.bgSyncs.clear();
    this.inFlightSyncs.clear();
    const ids = [...this.sessions.keys()];
    const draining = [...this.draining];
    this.draining.clear();
    this.pendingConnects.clear();
    await Promise.allSettled([
      ...ids.map((id) => this.invalidate(id)),
      ...draining.map((session) => safeClose(session.client, session.transport)),
    ]);
  }
}
