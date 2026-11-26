// Personal workspace upstream policy built on top of lib/outbound-policy.mjs.
// By default any public HTTPS domain on port 443 is allowed (private IPv4, local suffixes,
// and Loop itself remain blocked). Setting LOOP_TRUSTED_MCP_ORIGINS switches to an explicit allowlist.

import { validateHeaderValue } from 'node:http';
import {
  assertPublicIPv4,
  buildSelfIdentity,
  createOutboundPolicy,
  createSafeFetch,
  getHostedOriginPolicy,
  parsePublicHttpsUrl,
} from './outbound-policy.mjs';
import { normalizedOriginOf } from './sink.mjs';
import { isAllowedTokenEndpointOrigin } from './oauth.mjs';
import { validateRevision } from './sync-revisions.mjs';

export { assertPublicIPv4 };

export const MAX_UPSTREAM_RESPONSE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
export const DEFAULT_SSE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

const USER_HEADERS = new Set(['authorization', 'api-key', 'x-api-key', 'notion-version']);
const CONNECTION_FIELDS = new Set([
  'id', 'name', 'description', 'accountLabel', 'agentNote', 'specUrl', 'apiOperations', 'serverInstructions', 'transport', 'type', 'url', 'headers', 'command', 'args', 'env', 'cwd',
  'profiles', 'enabled', 'partnerSkillsEnabled', 'disabledTools', 'allowedTools', 'pinnedTools', 'pinsCustomized', 'tools', 'resources', 'prompts', 'skills', 'oauth', 'token', 'approval',
  'authRequired', 'signInRejectedCall', 'signInBroken', 'agentLogin', 'syncVersion', 'lastSyncAt', 'lastSyncAttemptAt', 'syncFailures', 'lastError', 'createdAt',
  'serverIcons', 'websiteUrl', 'remoteAccess', 'home', 'toolSetupId',
  // Set by Loop from who made the write (lib/context-names.mjs); never taken from agent input.
  'addedBy',
]);

const isTextList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

// Fields that only Loop's own store writes (lib/store.mjs), each with its format. A saved connection
// may carry them; what an owner or an agent sends may not.
const LOOP_WRITTEN_FIELDS = new Map([
  ['accessRevision', (value) => { try { validateRevision(value, false); return true; } catch { return false; } }],
  ['projectToolGrants', (value) => isRecord(value) && Object.values(value).every(isTextList)],
  ['syncWarnings', isTextList],
  ['toolNames', isTextList],
  ['serverVersion', (value) => typeof value === 'string' && value.length <= 80],
]);

function withoutLoopWrittenFields(conn) {
  const rest = { ...conn };
  for (const [field, isValid] of LOOP_WRITTEN_FIELDS) {
    if (rest[field] != null && !isValid(rest[field])) {
      throw new Error(`Personal MCP field "${field}", as saved by Loop, is not valid.`);
    }
    delete rest[field];
  }
  return rest;
}

const AGENT_LOGIN_FIELDS = new Set(['vaultKey', 'origin', 'username', 'savedAt']);

function assertPersonalAgentLogin(agentLogin) {
  if (agentLogin == null) return;
  if (
    !isRecord(agentLogin) ||
    Object.keys(agentLogin).some((k) => !AGENT_LOGIN_FIELDS.has(k)) ||
    typeof agentLogin.vaultKey !== 'string' ||
    !agentLogin.vaultKey.trim() ||
    agentLogin.vaultKey.startsWith('__') ||
    typeof agentLogin.origin !== 'string' ||
    (agentLogin.username != null && typeof agentLogin.username !== 'string') ||
    (agentLogin.savedAt != null && typeof agentLogin.savedAt !== 'string')
  ) {
    throw new Error('Personal MCP agent login metadata is invalid.');
  }
  parsePublicHttpsUrl(agentLogin.origin, { label: 'Personal MCP login' });
}

const STORED_OAUTH_FIELDS = new Set([
  'grantId', 'boundOrigin', 'boundSinkKey', 'issuedAt', 'ttlMs',
  'clientId', 'clientOrigin', 'clientRejected', 'clientSecret', 'clientSecretVaultKey', 'tokenEndpoint', 'tokenEndpointAuthMethod', 'callbackUrl',
  'issuer', 'accessTokenVaultKey', 'refreshTokenVaultKey', 'expiresAt',
]);

function parseOAuthVaultKey(prefix, connId, key) {
  if (typeof key !== 'string' || !connId) return null;
  const base = `${prefix}_${connId}`;
  if (key === base) return '';
  if (key.startsWith(`${base}_`)) {
    const suffix = key.slice(base.length + 1);
    if (/^[0-9a-f]{8}$/i.test(suffix)) return suffix.toLowerCase();
  }
  return null;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' &&
    [null, Object.prototype].includes(Object.getPrototypeOf(value));
}

function personalPolicy(selfIdentity = null) {
  return createOutboundPolicy({
    personal: true,
    selfIdentity: selfIdentity || buildSelfIdentity(),
  });
}

export function listPersonalUpstreamOrigins() {
  return getHostedOriginPolicy().allowlist;
}

export function assertPersonalHeaders(headers) {
  if (headers == null) return;
  if (!isRecord(headers)) throw new Error('Personal MCP headers must be an object.');
  const seen = new Set();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!USER_HEADERS.has(lower) || seen.has(lower) || typeof value !== 'string') {
      throw new Error('Personal MCP supports only approved credential and service headers.');
    }
    seen.add(lower);
    try { validateHeaderValue(name, value); } catch { throw new Error('Invalid personal MCP header value.'); }
  }
}

export function assertPersonalConnection(input, { selfIdentity = null } = {}) {
  if (!isRecord(input) || Object.keys(input).some((field) => !CONNECTION_FIELDS.has(field))) {
    throw new Error('Unsupported personal MCP connection fields.');
  }
  const transport = input.transport ?? input.type ?? 'http';
  if (transport === 'builtin') {
    if ((input.type != null && input.type !== 'builtin') ||
        input.command != null || input.cwd != null || input.oauth != null || input.url != null ||
        (input.token != null && typeof input.token !== 'string') ||
        (input.args != null && (!Array.isArray(input.args) || input.args.length)) ||
        (input.env != null && (!isRecord(input.env) || Object.keys(input.env).length)) ||
        (input.headers != null && (!isRecord(input.headers) || Object.keys(input.headers).length))) {
      throw new Error('Built-in connections cannot specify URL, command, headers, environment, or OAuth settings.');
    }
    return null;
  }
  if (!['http', 'sse', 'openapi', 'graphql'].includes(transport) || (input.type != null && input.type !== transport) ||
      input.command != null || input.cwd != null || input.oauth != null ||
      (input.token != null && typeof input.token !== 'string') ||
      (input.args != null && (!Array.isArray(input.args) || input.args.length)) ||
      (input.env != null && (!isRecord(input.env) || Object.keys(input.env).length))) {
    throw Object.assign(
      new Error('Personal MCP allows only remote HTTP or SSE without command, environment, or OAuth settings.'),
      {
        status: 400,
        code: 'NOT_SUPPORTED_HERE',
        retryable: false,
        recovery: {
          action: 'use_other_tool',
          instructions: 'This Loop workspace runs in hosted (personal) mode and cannot start local command programs. Do not retry this connection here; use another tool, a remote HTTP/SSE connection, or local mode.',
        },
      },
    );
  }
  assertPersonalHeaders(input.headers);
  assertPersonalAgentLogin(input.agentLogin);
  return personalPolicy(selfIdentity).assertConnectionUrl(input.url);
}

// The sign-in record Loop itself saves after a personal sign-in. It is checked on every use and is
// never accepted from a client: assertPersonalConnection keeps rejecting any supplied `oauth`.
export function assertPersonalStoredOAuth(conn, { selfIdentity = null } = {}) {
  const oauth = conn?.oauth;
  if (oauth == null) return;
  const id = typeof conn.id === 'string' ? conn.id : '';
  const grantIdValid =
    oauth.grantId == null ||
    (typeof oauth.grantId === 'string' && /^[0-9a-f-]{8,64}$/i.test(oauth.grantId));
  const expectedTag =
    typeof oauth.grantId === 'string' && grantIdValid ? oauth.grantId.slice(0, 8).toLowerCase() : null;
  const accessTag = parseOAuthVaultKey('__oauth_access', id, oauth.accessTokenVaultKey);
  const refreshTag =
    oauth.refreshTokenVaultKey == null
      ? null
      : parseOAuthVaultKey('__oauth_refresh', id, oauth.refreshTokenVaultKey);
  const secretTag =
    oauth.clientSecretVaultKey == null
      ? null
      : parseOAuthVaultKey('__oauth_client_secret', id, oauth.clientSecretVaultKey);

  const keysMatchGrant =
    accessTag !== null &&
    (expectedTag === null || accessTag === '' || accessTag === expectedTag) &&
    (oauth.refreshTokenVaultKey == null || (refreshTag !== null && refreshTag === accessTag)) &&
    (oauth.clientSecretVaultKey == null || (secretTag !== null && secretTag === accessTag));

  let boundOriginValid = true;
  if (oauth.boundOrigin != null) {
    if (typeof oauth.boundOrigin !== 'string') {
      boundOriginValid = false;
    } else {
      try {
        const parsedBound = parsePublicHttpsUrl(oauth.boundOrigin, { label: 'Personal MCP' });
        const normBound = parsedBound.origin.toLowerCase();
        boundOriginValid = normBound === oauth.boundOrigin.trim().toLowerCase();
        if (boundOriginValid && conn.url) {
          boundOriginValid = normBound === normalizedOriginOf(conn.url);
        }
      } catch {
        boundOriginValid = false;
      }
    }
  }

  const ok = isRecord(oauth) && !!id &&
    Object.keys(oauth).every((field) => STORED_OAUTH_FIELDS.has(field)) &&
    grantIdValid &&
    boundOriginValid &&
    keysMatchGrant &&
    typeof oauth.clientId === 'string' && oauth.clientId.length > 0 &&
    (oauth.clientSecret == null || typeof oauth.clientSecret === 'string') &&
    (oauth.tokenEndpointAuthMethod == null || typeof oauth.tokenEndpointAuthMethod === 'string') &&
    (oauth.callbackUrl == null || typeof oauth.callbackUrl === 'string') &&
    (oauth.issuer == null || typeof oauth.issuer === 'string') &&
    (oauth.boundSinkKey == null || typeof oauth.boundSinkKey === 'string') &&
    (oauth.issuedAt == null || (typeof oauth.issuedAt === 'number' && Number.isFinite(oauth.issuedAt))) &&
    (oauth.ttlMs == null || (typeof oauth.ttlMs === 'number' && Number.isFinite(oauth.ttlMs) && oauth.ttlMs > 0)) &&
    (oauth.expiresAt == null || Number.isFinite(oauth.expiresAt));
  if (!ok) throw new Error('Personal MCP sign-in record is not valid. Sign in to this connection again.');
  const tokenUrl = assertApprovedOAuthUrl(oauth.tokenEndpoint, 'token', { selfIdentity });
  if (oauth.issuer != null) {
    const issuerUrl = assertApprovedOAuthUrl(oauth.issuer, 'sign-in server', { selfIdentity });
    if (!isAllowedTokenEndpointOrigin(tokenUrl.origin, issuerUrl.origin)) {
      throw new Error('Personal MCP sign-in record is not valid. Sign in to this connection again.');
    }
  }
}

// A connection record read from a personal workspace's own store.
export function assertPersonalStoredConnection(conn, { selfIdentity = null } = {}) {
  if (!isRecord(conn)) throw new Error('Unsupported personal MCP connection fields.');
  const { oauth, ...rest } = conn;
  const url = assertPersonalConnection(withoutLoopWrittenFields(rest), { selfIdentity });
  assertPersonalStoredOAuth(conn, { selfIdentity });
  return url;
}

// A change requested by the owner or an agent to a personal connection. `input` must never carry
// `oauth` or a field that only Loop writes; a sign-in Loop stored earlier is kept, but only while the
// connection stays on its origin.
export function assertPersonalEdit(existing, input, { selfIdentity = null } = {}) {
  if (!existing) return assertPersonalConnection(input, { selfIdentity });
  if (!isRecord(input)) throw new Error('Unsupported personal MCP connection fields.');
  const { oauth, ...rest } = existing;
  const url = assertPersonalConnection({ ...withoutLoopWrittenFields(rest), ...input }, { selfIdentity });
  if (oauth != null) {
    assertPersonalStoredOAuth(existing, { selfIdentity });
    if (url.origin !== parsePublicHttpsUrl(existing.url, { label: 'Personal MCP' }).origin) {
      throw new Error('This connection is signed in to a different address. Remove it and add it again to use a new address.');
    }
  }
  return url;
}

// Every sign-in address a personal workspace uses (server requests and the page the browser opens)
// must be a public https address (and on an approved origin when LOOP_TRUSTED_MCP_ORIGINS is set).
export function assertApprovedOAuthUrl(value, purpose = 'sign-in server', { selfIdentity = null } = {}) {
  return personalPolicy(selfIdentity).assertOAuthUrl(value, purpose);
}

// Network policy for signing in from a personal workspace: public HTTPS (or operator allowlist),
// through the SSRF-safe fetch (public IPv4, no redirects, pinned to the request's own origin).
export function personalOAuthNetwork({ selfIdentity = null } = {}) {
  return personalPolicy(selfIdentity).oauthNetwork(null);
}

function wrapResponseWithIdleTimeout(res, idleTimeoutMs, onAbort, onFinish) {
  if (!res.body || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    onFinish();
    return res;
  }
  const reader = res.body.getReader();
  let timer = null;
  let done = false;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const finish = () => {
    if (!done) {
      done = true;
      clearTimer();
      onFinish();
    }
  };

  const wrappedBody = new ReadableStream({
    async pull(controller) {
      if (done) return;
      let timedOut = false;
      let timeoutErr = null;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          timeoutErr = new Error('Upstream response timed out.');
          reject(timeoutErr);
          onAbort(timeoutErr);
          reader.cancel(timeoutErr).catch(() => {});
        }, idleTimeoutMs);
        timer.unref?.();
      });
      try {
        const readPromise = reader.read();
        readPromise.catch(() => {});
        const result = await Promise.race([readPromise, timeoutPromise]);
        clearTimer();
        if (timedOut) {
          throw timeoutErr;
        }
        if (result.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (err) {
        clearTimer();
        finish();
        if (!timedOut) {
          onAbort(err);
        }
        controller.error(timedOut ? timeoutErr : err);
      }
    },
    async cancel(reason) {
      finish();
      onAbort(reason);
      await reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(wrappedBody, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

export function createPersonalFetch(
  origin,
  {
    selfIdentity = null,
    maxResponseBytes = MAX_UPSTREAM_RESPONSE_BYTES,
    timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
    idleTimeoutMs = null,
    sseIdleTimeoutMs = DEFAULT_SSE_IDLE_TIMEOUT_MS,
  } = {},
) {
  const identity = selfIdentity || buildSelfIdentity();
  const effectiveMaxBytes =
    Number.isFinite(maxResponseBytes) && maxResponseBytes > 0
      ? maxResponseBytes
      : MAX_UPSTREAM_RESPONSE_BYTES;
  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_UPSTREAM_TIMEOUT_MS;
  const effectiveSseIdleMs =
    Number.isFinite(sseIdleTimeoutMs) && sseIdleTimeoutMs > 0
      ? sseIdleTimeoutMs
      : DEFAULT_SSE_IDLE_TIMEOUT_MS;

  return async (input, init = {}) => {
    const hosted = getHostedOriginPolicy();
    const allowlist = hosted.mode === 'allowlist' ? hosted.allowlist : null;
    const fetcher = createSafeFetch({
      requirePublic: true,
      allowedOrigin: origin,
      allowlist,
      selfIdentity: identity,
      maxResponseBytes: effectiveMaxBytes,
    });

    const controller = new AbortController();
    const callerSignal = init.signal || null;
    const onCallerAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort(callerSignal?.reason || new Error('Request aborted.'));
      }
    };
    let signalAttached = false;
    if (callerSignal) {
      if (callerSignal.aborted) {
        onCallerAbort();
      } else {
        callerSignal.addEventListener('abort', onCallerAbort, { once: true });
        signalAttached = true;
      }
    }
    const detachSignal = () => {
      if (signalAttached && callerSignal) {
        callerSignal.removeEventListener('abort', onCallerAbort);
        signalAttached = false;
      }
    };

    const abortRequest = (reason) => {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    };

    let headerTimer = null;
    const clearHeaderTimer = () => {
      if (headerTimer !== null) {
        clearTimeout(headerTimer);
        headerTimer = null;
      }
    };

    const headerTimeoutPromise = new Promise((_, reject) => {
      headerTimer = setTimeout(() => {
        const err = new Error('Upstream request timed out.');
        abortRequest(err);
        reject(err);
      }, effectiveTimeoutMs);
      headerTimer.unref?.();
    });

    let res;
    try {
      const fetchPromise = fetcher(input, { ...init, signal: controller.signal });
      fetchPromise.catch(() => {});
      res = await Promise.race([fetchPromise, headerTimeoutPromise]);
      clearHeaderTimer();
    } catch (err) {
      clearHeaderTimer();
      detachSignal();
      throw err;
    }

    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    const isSse = contentType.includes('text/event-stream');
    const streamIdleMs =
      Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0
        ? idleTimeoutMs
        : isSse
          ? effectiveSseIdleMs
          : effectiveTimeoutMs;

    return wrapResponseWithIdleTimeout(res, streamIdleMs, abortRequest, detachSignal);
  };
}
