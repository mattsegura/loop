// MCP OAuth 2.1 client helper (RFC 9728 Protected Resource + RFC 8414 Auth Server + PKCE + DCR + RFC 8707 + RFC 9207).

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './json-file-store.mjs';
import { createOutboundPolicy, isLoopbackHostname } from './outbound-policy.mjs';
import { normalizedOriginOf } from './sink.mjs';

// The token and registration endpoints come from the authorization server's own metadata,
// fetched from its issuer origin over HTTPS with the issuer checked (RFC 8414), so they are
// exactly as trustworthy as the server itself. Plenty of real servers split them across hosts
// (Google, Microsoft, Composio, Auth0 custom domains...). What we refuse is a downgrade: an
// HTTPS authorization server sending codes or secrets to a plain-HTTP endpoint. Private and
// internal addresses are refused separately by the outbound network policy (assertUrl).
// Static client secrets are only ever re-sent to the exact token endpoint they were stored
// with (see storedMatches in startOAuth), so a changed endpoint cannot collect them.
export function isAllowedTokenEndpointOrigin(tokenOrigin, authServerOrigin) {
  if (typeof tokenOrigin !== 'string' || typeof authServerOrigin !== 'string') return false;
  const tok = tokenOrigin.trim().toLowerCase();
  const auth = authServerOrigin.trim().toLowerCase();
  if (!tok || !auth) return false;
  if (tok === auth) return true;
  return tok.startsWith('https://');
}

// MCP 2025-11-25 Client ID Metadata Document (CIMD): only valid over public HTTPS.
export function buildCimdClientId(callbackUrl) {
  if (typeof callbackUrl !== 'string' || !callbackUrl.trim()) return null;
  try {
    const parsed = new URL(callbackUrl.trim());
    if (parsed.protocol !== 'https:' || isLoopbackHostname(parsed.hostname)) return null;
    return `${parsed.origin}/oauth/client.json`;
  } catch {
    return null;
  }
}

function chooseDcrAuthMethod(supportedMethods) {
  if (!Array.isArray(supportedMethods) || supportedMethods.length === 0) return 'none';
  if (supportedMethods.includes('none')) return 'none';
  if (supportedMethods.includes('client_secret_post')) return 'client_secret_post';
  if (supportedMethods.includes('client_secret_basic')) return 'client_secret_basic';
  return 'none';
}

function applyTokenClientAuth(headers, body, { clientId, clientSecret, authMethod }) {
  if (clientSecret && authMethod === 'client_secret_basic' && clientId) {
    const basic = Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`, 'utf8').toString('base64');
    headers.Authorization = `Basic ${basic}`;
    body.delete('client_id');
    body.delete('client_secret');
    return;
  }
  if (clientId) body.set('client_id', clientId);
  if (clientSecret) body.set('client_secret', clientSecret);
}

const FLOW_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PENDING_FLOWS = 50;
const MAX_TOKEN_LENGTH = 65536;
const MAX_EXPIRES_IN_SEC = 365 * 24 * 60 * 60;
const FLOWS_FILE = 'oauth-pending.json';
export const SIGN_IN_EXPIRED_MESSAGE = 'This sign-in link expired. Start the sign-in again.';

// Used only by callers that give no data directory; a workspace keeps its flows on disk.
const memoryFlows = new Map();

// Single-flight deduplication for concurrent token refreshes (prevents rotating refresh-token races).
const inFlightRefreshes = new Map();
// Honor Retry-After backoff windows on 429 / 503 token renewal responses.
const refreshRetryAfterUntil = new Map();
const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;
const DEAD_GRANT_ERRORS = new Set([
  'invalid_grant',
  'refresh_token_already_used',
  'bad_refresh_token',
  'invalid_refresh_token',
  'token_expired',
]);
const CLIENT_REJECTED_ERRORS = new Set([
  'invalid_client',
  'unauthorized_client',
]);
const vaultInstanceIds = new WeakMap();
let nextVaultInstanceId = 1;

function parseRetryAfterMs(headerVal) {
  if (typeof headerVal !== 'string' || !headerVal.trim()) return 0;
  const trimmed = headerVal.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.min(dateMs - Date.now(), MAX_RETRY_AFTER_MS));
  }
  return 0;
}

function isDeadGrantError(code) {
  return typeof code === 'string' && DEAD_GRANT_ERRORS.has(code.trim().toLowerCase());
}

function isClientRejectedError(code) {
  return typeof code === 'string' && CLIENT_REJECTED_ERRORS.has(code.trim().toLowerCase());
}

function vaultFlightPrefix(vault) {
  if (typeof vault?.dir === 'string' && vault.dir) return vault.dir;
  if (vault && typeof vault === 'object') {
    let id = vaultInstanceIds.get(vault);
    if (!id) {
      id = `mem:${nextVaultInstanceId++}`;
      vaultInstanceIds.set(vault, id);
    }
    return id;
  }
  return 'mem';
}

// Always enforce an outbound network policy — direct callers never get an unguarded raw fetch.
function networkOf(options, connectionUrl = null) {
  if (options?.network) return options.network;
  return createOutboundPolicy({
    personal: false,
    selfIdentity: options?.selfIdentity || null,
  }).oauthNetwork(connectionUrl);
}

function workspaceOf(options) {
  return typeof options?.workspace === 'string' && options.workspace ? options.workspace : 'local';
}

function normalizeIssuer(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

function base64url(buf) {
  return buf.toString('base64url');
}

function createPkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function flowsFile(options) {
  return options?.dataDir ? path.join(path.resolve(options.dataDir), FLOWS_FILE) : null;
}

function isFlow(flow) {
  return Boolean(flow) && typeof flow === 'object' &&
    ['connId', 'workspace', 'callbackUrl', 'tokenEndpoint', 'clientId', 'verifier'].every((k) => typeof flow[k] === 'string') &&
    Number.isFinite(flow.createdAt);
}

// A pending sign-in holds a PKCE verifier and maybe a client secret. It lives only in the
// workspace's own data directory (0600), is never logged and is never returned by any API.
function loadFlows(file, now = Date.now()) {
  if (!file) {
    for (const [state, flow] of memoryFlows) {
      if (now - flow.createdAt > FLOW_TTL_MS) memoryFlows.delete(state);
    }
    return memoryFlows;
  }
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))?.flows;
  } catch {
    raw = null; // Missing or unreadable: no sign-in is waiting.
  }
  const flows = new Map();
  if (raw && typeof raw === 'object') {
    for (const [state, flow] of Object.entries(raw)) {
      if (isFlow(flow) && now - flow.createdAt <= FLOW_TTL_MS) flows.set(state, flow);
    }
  }
  return flows;
}

// Synchronous on purpose: a read-modify-write never interleaves with another one in this process,
// so a flow is handed out at most once.
function saveFlows(file, flows) {
  if (!file) return;
  if (!flows.size) {
    try { unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    return;
  }
  atomicWriteFileSync(
    file,
    JSON.stringify({ version: 1, flows: Object.fromEntries(flows) }) + '\n',
    { mode: 0o600 },
  );
}

function parseResourceMetadataUrl(wwwAuthenticate) {
  if (typeof wwwAuthenticate !== 'string' || !wwwAuthenticate.trim()) return null;
  const match = /(?:^|[\s,])resource_metadata\s*=\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|([^\s,;"]+))/i.exec(wwwAuthenticate);
  const raw = match?.[1] ?? match?.[2] ?? '';
  const cleaned = raw.replace(/\\(.)/g, '$1').trim();
  return cleaned || null;
}

export function parseAuthChallengeScope(wwwAuthenticate) {
  if (typeof wwwAuthenticate !== 'string' || !wwwAuthenticate.trim()) return '';
  const match = /(?:^|[\s,])scope\s*=\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|([^\s,;"]+))/i.exec(wwwAuthenticate);
  const raw = match?.[1] ?? match?.[2] ?? '';
  return raw.replace(/\\(.)/g, '$1').trim();
}

function validateTokenResponse(tokens) {
  if (!tokens || typeof tokens !== 'object') {
    return { valid: false, error: 'Invalid token response.' };
  }
  if (typeof tokens.error === 'string' && tokens.error.trim()) {
    const code = tokens.error.trim();
    return {
      valid: false,
      oauthError: code,
      error: typeof tokens.error_description === 'string' && tokens.error_description.trim()
        ? tokens.error_description.trim().slice(0, 500)
        : code,
    };
  }
  if (tokens.ok === false) {
    return { valid: false, oauthError: 'token_error', error: 'Token response reported ok=false.' };
  }
  const accessTokenRaw =
    typeof tokens.access_token === 'string'
      ? tokens.access_token
      : (typeof tokens.authed_user?.access_token === 'string' ? tokens.authed_user.access_token : null);
  if (typeof accessTokenRaw !== 'string' ||
      accessTokenRaw.length === 0 ||
      accessTokenRaw.length > MAX_TOKEN_LENGTH ||
      /[\r\n]/.test(accessTokenRaw)) {
    return { valid: false, error: 'Token response contained an invalid access_token.' };
  }
  const refreshTokenRaw =
    tokens.refresh_token !== undefined && tokens.refresh_token !== null
      ? tokens.refresh_token
      : tokens.authed_user?.refresh_token;
  if (refreshTokenRaw !== undefined && refreshTokenRaw !== null) {
    if (typeof refreshTokenRaw !== 'string' || refreshTokenRaw.length > MAX_TOKEN_LENGTH) {
      return { valid: false, error: 'Token response contained an invalid refresh_token.' };
    }
  }
  let expiresAt = null;
  let ttlMs = null;
  if (tokens.expires_in !== undefined && tokens.expires_in !== null) {
    const numericExpires =
      typeof tokens.expires_in === 'number'
        ? tokens.expires_in
        : (typeof tokens.expires_in === 'string' && /^\d+(?:\.\d+)?$/.test(tokens.expires_in.trim())
            ? Number(tokens.expires_in.trim())
            : NaN);
    if (Number.isFinite(numericExpires) && numericExpires > 0) {
      ttlMs = Math.min(numericExpires, MAX_EXPIRES_IN_SEC) * 1000;
      expiresAt = Date.now() + ttlMs;
    }
  }
  return {
    valid: true,
    accessToken: accessTokenRaw,
    refreshToken: typeof refreshTokenRaw === 'string' && refreshTokenRaw.length > 0
      ? refreshTokenRaw
      : null,
    expiresAt,
    ttlMs,
  };
}

async function fetchJson(url, net) {
  try {
    const res = await net.fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

function buildAuthServerMetadataUrls(authServerUrl) {
  const urls = [];
  const trimmed = String(authServerUrl || '').replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    if (pathname && pathname !== '/') {
      // RFC 8414 path-inserted well-known URLs
      urls.push(`${parsed.origin}/.well-known/oauth-authorization-server${pathname}`);
      urls.push(`${parsed.origin}/.well-known/openid-configuration${pathname}`);
      urls.push(`${trimmed}/.well-known/openid-configuration`);
    }
    urls.push(`${parsed.origin}/.well-known/oauth-authorization-server`);
    urls.push(`${parsed.origin}/.well-known/openid-configuration`);
  } catch {
    urls.push(`${trimmed}/.well-known/oauth-authorization-server`);
    urls.push(`${trimmed}/.well-known/openid-configuration`);
  }
  return [...new Set(urls)];
}

export async function discoverOAuth(mcpUrl, options = {}) {
  const net = networkOf(options, mcpUrl);
  net.assertUrl(mcpUrl, 'sign-in server');
  const parsed = new URL(mcpUrl);
  const origin = parsed.origin;
  const pathname = parsed.pathname.replace(/\/+$/, '');

  // 1. Try RFC 9728 Protected Resource Metadata (WWW-Authenticate resource_metadata first)
  let authServerUrl = origin;
  let scopesSupported = [];
  let challengeScope = parseAuthChallengeScope(options?.wwwAuthenticate);
  const prmCandidates = [];
  const hintUrl = parseResourceMetadataUrl(options?.wwwAuthenticate);
  if (hintUrl) {
    net.assertUrl(hintUrl, 'sign-in server');
    prmCandidates.push(hintUrl);
  }
  if (pathname && pathname !== '/') {
    prmCandidates.push(`${origin}/.well-known/oauth-protected-resource${pathname}`);
  }
  prmCandidates.push(`${origin}/.well-known/oauth-protected-resource`);

  let prm = null;
  for (const candidate of [...new Set(prmCandidates)]) {
    prm = await fetchJson(candidate, net);
    if (prm) break;
  }

  // If caller did not supply WWW-Authenticate and well-known PRM was absent, probe mcpUrl once
  // (zero credentials) to read any RFC 9728 WWW-Authenticate resource_metadata or scope hint.
  if (!prm && options?.wwwAuthenticate === undefined) {
    let challengeHeader = null;
    try {
      const challengeRes = await net.fetch(mcpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'loop-oauth-discovery', version: '1.0.0' },
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (challengeRes.status === 401 || challengeRes.status === 403) {
        challengeHeader = challengeRes.headers.get('www-authenticate');
      }
      await challengeRes.body?.cancel().catch(() => {});
    } catch {
      challengeHeader = null;
    }
    if (!challengeScope) challengeScope = parseAuthChallengeScope(challengeHeader);
    const discoveredHint = parseResourceMetadataUrl(challengeHeader);
    if (discoveredHint) {
      net.assertUrl(discoveredHint, 'sign-in server');
      prm = await fetchJson(discoveredHint, net);
    }
  }

  if (prm && typeof prm === 'object') {
    if (prm.resource !== undefined && prm.resource !== null) {
      let prmResourceOrigin = null;
      try {
        prmResourceOrigin = new URL(String(prm.resource)).origin;
      } catch {
        prmResourceOrigin = null;
      }
      if (!prmResourceOrigin || prmResourceOrigin !== parsed.origin) {
        throw new Error(`Protected resource metadata resource does not match ${parsed.origin}.`);
      }
    }
    if (Array.isArray(prm.authorization_servers) && prm.authorization_servers[0]) {
      authServerUrl = String(prm.authorization_servers[0]).replace(/\/+$/, '');
    }
    if (Array.isArray(prm.scopes_supported)) {
      scopesSupported = prm.scopes_supported.filter((s) => typeof s === 'string');
    }
  }

  // 2. Fetch RFC 8414 Authorization Server Metadata (or OIDC fallback)
  const normalizedAuthServer = normalizeIssuer(authServerUrl);
  net.assertUrl(normalizedAuthServer, 'sign-in server');
  const authServerOrigin = new URL(normalizedAuthServer).origin;

  let meta = null;
  for (const candidate of buildAuthServerMetadataUrls(normalizedAuthServer)) {
    meta = await fetchJson(candidate, net);
    if (meta?.authorization_endpoint && meta?.token_endpoint) break;
  }

  if (!meta?.authorization_endpoint || !meta?.token_endpoint) {
    throw new Error(`Could not discover OAuth endpoints for ${origin}.`);
  }

  // Validate RFC 8414 issuer strictly against the authorization server identifier when present.
  let issuer = null;
  if (meta.issuer !== undefined && meta.issuer !== null) {
    const normalizedMetaIssuer = normalizeIssuer(meta.issuer);
    if (!normalizedMetaIssuer || normalizedMetaIssuer !== normalizedAuthServer) {
      throw new Error('OAuth server metadata issuer does not match the authorization server.');
    }
    issuer = normalizedMetaIssuer;
  }

  // Validate every discovered endpoint against the outbound network policy.
  net.assertUrl(meta.authorization_endpoint, 'sign-in page');
  net.assertUrl(meta.token_endpoint, 'token');
  if (meta.registration_endpoint) net.assertUrl(meta.registration_endpoint, 'registration');

  // Backchannel endpoints may live on another host, but never downgrade to plain HTTP.
  const tokenOrigin = new URL(meta.token_endpoint).origin;
  if (!isAllowedTokenEndpointOrigin(tokenOrigin, authServerOrigin)) {
    throw new Error(`OAuth token endpoint origin does not match authorization server (${authServerOrigin}).`);
  }
  if (meta.registration_endpoint && !isAllowedTokenEndpointOrigin(new URL(meta.registration_endpoint).origin, authServerOrigin)) {
    throw new Error(`OAuth registration endpoint origin does not match authorization server (${authServerOrigin}).`);
  }

  const tokenEndpointAuthMethods = Array.isArray(meta.token_endpoint_auth_methods_supported)
    ? meta.token_endpoint_auth_methods_supported.filter((m) => typeof m === 'string')
    : [];
  const grantTypesSupported = Array.isArray(meta.grant_types_supported)
    ? meta.grant_types_supported.filter((g) => typeof g === 'string')
    : [];
  const serverScopesSupported = Array.isArray(meta.scopes_supported)
    ? meta.scopes_supported.filter((s) => typeof s === 'string')
    : [];
  const combinedScopeParts = (challengeScope || scopesSupported.join(' ')).split(/\s+/).filter(Boolean);
  if (serverScopesSupported.includes('offline_access') && !combinedScopeParts.includes('offline_access')) {
    combinedScopeParts.push('offline_access');
  }

  return {
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint || null,
    cimdSupported: Boolean(meta.client_id_metadata_document_supported),
    tokenEndpointAuthMethods,
    grantTypesSupported,
    hasPrm: Boolean(prm && typeof prm === 'object'),
    scope: combinedScopeParts.join(' '),
    issuer,
    authServerUrl: normalizedAuthServer,
    authServerOrigin,
    issSupported: Boolean(meta.authorization_response_iss_parameter_supported),
  };
}

// Preflight check: verifies whether Loop can run a zero-setup instant OAuth sign-in
// (DCR or CIMD) for mcpUrl before saving a connection or issuing a signInUrl.
export async function checkInstantOAuth(mcpUrl, options = {}) {
  try {
    const meta = await discoverOAuth(mcpUrl, options);
    const hasDcr = Boolean(meta.registrationEndpoint);
    const hasCimd = Boolean(meta.cimdSupported && buildCimdClientId(options?.callbackUrl));
    if (hasDcr || hasCimd) {
      return {
        ok: true,
        mode: hasDcr ? 'dcr' : 'cimd',
        meta,
      };
    }
    return {
      ok: false,
      reason: 'no_instant_oauth',
      issuer: meta.issuer || meta.authServerUrl || meta.authServerOrigin,
      meta,
      error: `This server (${meta.issuer || meta.authServerOrigin}) does not support Dynamic Client Registration or Client ID Metadata Documents.`,
    };
  } catch (err) {
    const msg = err?.message || 'Could not discover OAuth endpoints.';
    if (/Could not discover OAuth endpoints/i.test(msg)) {
      return {
        ok: false,
        reason: 'no_oauth',
        error: msg,
      };
    }
    return {
      ok: false,
      reason: 'oauth_incompatible',
      error: msg,
    };
  }
}

async function registerClient(registrationEndpoint, callbackUrl, net, { authMethods = [], grantTypesSupported = [] } = {}) {
  net.assertUrl(registrationEndpoint, 'registration');
  const chosenMethod = chooseDcrAuthMethod(authMethods);
  const supportsRefresh = grantTypesSupported.length === 0 || grantTypesSupported.includes('refresh_token');
  const grantTypes = supportsRefresh ? ['authorization_code', 'refresh_token'] : ['authorization_code'];
  const res = await net.fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Loop MCP Gateway',
      application_type: 'web',
      redirect_uris: [callbackUrl],
      grant_types: grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: chosenMethod,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.client_id) {
    throw new Error(
      data.error_description || data.error || `Dynamic client registration failed (HTTP ${res.status}).`,
    );
  }
  const clientSecret = typeof data.client_secret === 'string' && data.client_secret ? data.client_secret : null;
  const serverMethod =
    typeof data.token_endpoint_auth_method === 'string' && data.token_endpoint_auth_method.trim()
      ? data.token_endpoint_auth_method.trim()
      : chosenMethod;
  const effectiveMethod = clientSecret && serverMethod === 'none'
    ? (authMethods.includes('client_secret_basic') && !authMethods.includes('client_secret_post')
        ? 'client_secret_basic'
        : 'client_secret_post')
    : serverMethod;
  return {
    clientId: String(data.client_id),
    clientSecret,
    tokenEndpointAuthMethod: effectiveMethod,
  };
}

// options: { network, selfIdentity, dataDir, workspace, wwwAuthenticate, vault }.
// The flow is bound to `workspace` (the workspace id, or "local" for the device workspace)
// and saved in `dataDir`, so it survives a Loop restart.
export async function startOAuthFlow(conn, callbackUrl, options = {}) {
  if (!conn?.url) {
    throw new Error('Connection URL is required to start OAuth.');
  }
  const connOrigin = normalizedOriginOf(conn.url);
  if (!connOrigin) {
    throw new Error('Connection URL must be a valid http or https address.');
  }
  const net = networkOf(options, conn.url);

  const explicitClientId = typeof options?.clientId === 'string' && options.clientId.trim()
    ? options.clientId.trim()
    : null;
  const explicitClientSecret = explicitClientId && typeof options?.clientSecret === 'string' && options.clientSecret.trim()
    ? options.clientSecret.trim()
    : null;

  const meta = await discoverOAuth(conn.url, { ...options, network: net });
  const cimdClientId = meta.cimdSupported ? buildCimdClientId(callbackUrl) : null;
  const clientWasRejected = Boolean(conn.oauth?.clientRejected) && conn.oauth?.clientOrigin !== 'static';
  const storedMatches =
    !explicitClientId &&
    !clientWasRejected &&
    Boolean(conn.oauth?.clientId) &&
    conn.oauth.callbackUrl === callbackUrl &&
    conn.oauth.tokenEndpoint === meta.tokenEndpoint &&
    (!conn.oauth.boundOrigin || String(conn.oauth.boundOrigin).toLowerCase() === connOrigin);
  let clientId = explicitClientId || (storedMatches ? conn.oauth.clientId : null);
  let clientOrigin = explicitClientId ? 'static' : (storedMatches ? (conn.oauth.clientOrigin || 'dcr') : null);
  let clientSecret = explicitClientId
    ? explicitClientSecret
    : (storedMatches && !conn.oauth.clientSecretVaultKey ? (conn.oauth.clientSecret || null) : null);
  let clientSecretVaultKey = explicitClientId ? null : (storedMatches ? (conn.oauth.clientSecretVaultKey || null) : null);
  let tokenEndpointAuthMethod = explicitClientId
    ? (explicitClientSecret
        ? (meta.tokenEndpointAuthMethods.includes('client_secret_basic') &&
           !meta.tokenEndpointAuthMethods.includes('client_secret_post')
            ? 'client_secret_basic'
            : 'client_secret_post')
        : 'none')
    : (storedMatches ? (conn.oauth.tokenEndpointAuthMethod || null) : null);

  if (!clientId) {
    if (meta.registrationEndpoint) {
      try {
        const reg = await registerClient(meta.registrationEndpoint, callbackUrl, net, {
          authMethods: meta.tokenEndpointAuthMethods,
          grantTypesSupported: meta.grantTypesSupported,
        });
        clientId = reg.clientId;
        clientOrigin = 'dcr';
        clientSecret = reg.clientSecret;
        clientSecretVaultKey = null;
        tokenEndpointAuthMethod = reg.tokenEndpointAuthMethod;
      } catch (regErr) {
        if (cimdClientId) {
          clientId = cimdClientId;
          clientOrigin = 'cimd';
          clientSecret = null;
          clientSecretVaultKey = null;
          tokenEndpointAuthMethod = 'none';
        } else {
          throw regErr;
        }
      }
    } else if (cimdClientId) {
      clientId = cimdClientId;
      clientOrigin = 'cimd';
      clientSecret = null;
      clientSecretVaultKey = null;
      tokenEndpointAuthMethod = 'none';
    } else if (conn.oauth?.clientId && !clientWasRejected) {
      // No DCR/CIMD endpoint: keep any existing static client registration.
      clientId = conn.oauth.clientId;
      clientOrigin = conn.oauth.clientOrigin || 'static';
      clientSecret = conn.oauth.clientSecretVaultKey ? null : (conn.oauth.clientSecret || null);
      clientSecretVaultKey = conn.oauth.clientSecretVaultKey || null;
      tokenEndpointAuthMethod = conn.oauth.tokenEndpointAuthMethod || null;
    } else {
      throw new Error('This server does not support Dynamic Client Registration or Client ID Metadata Documents.');
    }
  }

  const pkce = createPkce();
  const state = base64url(randomBytes(24));
  const now = Date.now();
  const expectedIssuer = meta.issuer || meta.authServerUrl || meta.authServerOrigin;

  const file = flowsFile(options);
  const flows = loadFlows(file, now);
  // The oldest waiting sign-ins give way first; one person rarely has more than a few open.
  for (const key of [...flows.keys()].slice(0, Math.max(0, flows.size - MAX_PENDING_FLOWS + 1))) flows.delete(key);
  flows.set(state, {
    connId: conn.id,
    connUrl: conn.url,
    connOrigin,
    resource: conn.url,
    workspace: workspaceOf(options),
    callbackUrl,
    tokenEndpoint: meta.tokenEndpoint,
    tokenEndpointAuthMethod: tokenEndpointAuthMethod || null,
    issuer: meta.issuer || null,
    expectedIssuer,
    authServerOrigin: meta.authServerOrigin,
    issSupported: Boolean(meta.issSupported),
    clientId,
    clientOrigin: clientOrigin || 'dcr',
    clientSecret,
    clientSecretVaultKey,
    verifier: pkce.verifier,
    createdAt: now,
  });
  try {
    saveFlows(file, flows);
  } catch {
    throw new Error('Loop could not save this sign-in. Try again.');
  }

  const authUrl = new URL(meta.authorizationEndpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('resource', conn.url);
  if (meta.scope) authUrl.searchParams.set('scope', meta.scope);
  // Google only issues a refresh_token when access_type=offline is requested.
  if (authUrl.origin === 'https://accounts.google.com') {
    if (!authUrl.searchParams.has('access_type')) authUrl.searchParams.set('access_type', 'offline');
    if (!authUrl.searchParams.has('prompt')) authUrl.searchParams.set('prompt', 'consent');
  }

  return {
    authorizeUrl: authUrl.href,
    sameOrigin: authUrl.origin.toLowerCase() === connOrigin,
    authHost: authUrl.host,
    issuer: meta.issuer || null,
  };
}

// options: { network, selfIdentity, dataDir, workspace, iss }, the same as the start.
// A state that belongs to another workspace is refused exactly like an unknown one and stays unused.
export async function finishOAuthFlow(code, state, vault, options = {}) {
  const now = Date.now();
  const file = flowsFile(options);
  const flows = loadFlows(file, now);
  const key = String(state ?? '');
  const flow = flows.get(key);
  if (!flow || flow.workspace !== workspaceOf(options) || now - flow.createdAt > FLOW_TTL_MS) {
    throw new Error(SIGN_IN_EXPIRED_MESSAGE);
  }
  // Single use: the flow is gone from disk before any network request is made.
  flows.delete(key);
  try {
    saveFlows(file, flows);
  } catch {
    throw new Error('Loop could not finish this sign-in. Start the sign-in again.');
  }

  const expectedIssuer = normalizeIssuer(flow.expectedIssuer || flow.issuer || flow.authServerOrigin);
  const hasIssOption = options?.iss !== undefined && options?.iss !== null;
  const providedIss = typeof options?.iss === 'string' ? normalizeIssuer(options.iss) : '';
  if (hasIssOption || flow.issSupported) {
    if (!providedIss || !expectedIssuer || providedIss !== expectedIssuer) {
      throw new Error('OAuth callback issuer mismatch. Start the sign-in again.');
    }
  }

  const net = networkOf(options, flow.connUrl || flow.resource || null);
  net.assertUrl(flow.tokenEndpoint, 'token');
  if (flow.authServerOrigin && !isAllowedTokenEndpointOrigin(new URL(flow.tokenEndpoint).origin, flow.authServerOrigin)) {
    throw new Error('OAuth token endpoint origin does not match the authorization server.');
  }

  let clientSecret = flow.clientSecret || null;
  if (!clientSecret && flow.clientSecretVaultKey && vault && typeof vault.get === 'function') {
    clientSecret = await vault.get(flow.clientSecretVaultKey);
  }

  const tokenHeaders = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: flow.callbackUrl,
    code_verifier: flow.verifier,
  });
  const resource = flow.resource || flow.connUrl;
  if (resource) body.set('resource', resource);
  applyTokenClientAuth(tokenHeaders, body, {
    clientId: flow.clientId,
    clientSecret,
    authMethod: flow.tokenEndpointAuthMethod,
  });

  const res = await net.fetch(flow.tokenEndpoint, {
    method: 'POST',
    headers: tokenHeaders,
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const tokens = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      tokens.error_description || tokens.error || `Token exchange failed (HTTP ${res.status}).`,
    );
  }

  const validated = validateTokenResponse(tokens);
  if (!validated.valid) {
    throw new Error(validated.error);
  }

  if (!vault || typeof vault.set !== 'function') {
    throw new Error('Vault is required to store OAuth tokens.');
  }

  const grantId = randomUUID();
  const grantTag = grantId.slice(0, 8);
  const boundOrigin =
    typeof flow.connOrigin === 'string' && flow.connOrigin.trim()
      ? flow.connOrigin.trim().toLowerCase()
      : normalizedOriginOf(flow.connUrl || flow.resource || '');
  const issuedAt = Date.now();

  const accessTokenVaultKey = `__oauth_access_${flow.connId}_${grantTag}`;
  await vault.set(accessTokenVaultKey, validated.accessToken);

  let refreshTokenVaultKey = null;
  if (validated.refreshToken) {
    refreshTokenVaultKey = `__oauth_refresh_${flow.connId}_${grantTag}`;
    await vault.set(refreshTokenVaultKey, validated.refreshToken);
  }

  let clientSecretVaultKey = null;
  if (clientSecret) {
    clientSecretVaultKey = `__oauth_client_secret_${flow.connId}_${grantTag}`;
    await vault.set(clientSecretVaultKey, clientSecret);
  }

  return {
    connId: flow.connId,
    connUrl: typeof flow.connUrl === 'string' ? flow.connUrl : null,
    oauth: {
      grantId,
      boundOrigin: boundOrigin || null,
      clientId: flow.clientId,
      clientOrigin: flow.clientOrigin || 'dcr',
      clientRejected: false,
      clientSecret: null,
      clientSecretVaultKey,
      issuer: expectedIssuer || null,
      tokenEndpoint: flow.tokenEndpoint,
      ...(flow.tokenEndpointAuthMethod ? { tokenEndpointAuthMethod: flow.tokenEndpointAuthMethod } : {}),
      callbackUrl: flow.callbackUrl,
      accessTokenVaultKey,
      refreshTokenVaultKey,
      issuedAt,
      ttlMs: validated.ttlMs,
      expiresAt: validated.expiresAt,
    },
  };
}

async function performRefreshOAuthToken(conn, vault, options = {}) {
  const oauth = conn?.oauth;
  if (!oauth?.refreshTokenVaultKey || !oauth?.tokenEndpoint || !vault || typeof vault.get !== 'function') {
    return null;
  }

  const connOrigin = normalizedOriginOf(conn?.url);
  const declaredBoundOrigin =
    typeof oauth.boundOrigin === 'string' && oauth.boundOrigin.trim()
      ? oauth.boundOrigin.trim().toLowerCase()
      : null;
  if (declaredBoundOrigin && (!connOrigin || connOrigin !== declaredBoundOrigin)) {
    return null;
  }
  const boundOrigin = declaredBoundOrigin || connOrigin || null;

  const net = networkOf(options, conn?.url || null);
  try {
    const tokenUrl = net.assertUrl(oauth.tokenEndpoint, 'token');
    if (oauth.issuer) {
      const issuerUrl = net.assertUrl(oauth.issuer, 'sign-in server');
      if (!isAllowedTokenEndpointOrigin(tokenUrl.origin, issuerUrl.origin)) {
        return null;
      }
    }
  } catch {
    return null;
  }

  const refreshToken = await vault.get(oauth.refreshTokenVaultKey);
  if (!refreshToken) {
    return null;
  }

  let clientSecret = null;
  if (oauth.clientSecretVaultKey) {
    clientSecret = await vault.get(oauth.clientSecretVaultKey);
  }
  if (!clientSecret && oauth.clientSecret) {
    clientSecret = oauth.clientSecret;
  }

  const refreshHeaders = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  applyTokenClientAuth(refreshHeaders, body, {
    clientId: oauth.clientId,
    clientSecret,
    authMethod: oauth.tokenEndpointAuthMethod,
  });
  if (conn?.url) body.set('resource', conn.url);

  const backoffKey = `${vaultFlightPrefix(vault)}::${conn?.id || ''}::${oauth.grantId || oauth.refreshTokenVaultKey}`;
  const retryAfterUntil = refreshRetryAfterUntil.get(backoffKey) || 0;
  if (retryAfterUntil > Date.now()) {
    return null;
  }

  let res;
  try {
    res = await net.fetch(oauth.tokenEndpoint, {
      method: 'POST',
      headers: refreshHeaders,
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }

  const tokens = await res.json().catch(() => ({}));
  if (res.status === 429 || res.status === 503) {
    const waitMs = parseRetryAfterMs(res.headers?.get?.('retry-after')) || 30_000;
    refreshRetryAfterUntil.set(backoffKey, Date.now() + waitMs);
    if (typeof options.onRefreshError === 'function') {
      await options.onRefreshError({
        kind: res.status === 429 ? 'rate_limited' : 'service_unavailable',
        status: res.status,
        retryAfterMs: waitMs,
        error: typeof tokens?.error === 'string' ? tokens.error : `HTTP ${res.status}`,
      });
    }
    return null;
  }
  if (!res.ok) {
    const errCode = typeof tokens?.error === 'string' ? tokens.error.trim() : '';
    if ((res.status === 400 || res.status === 401) && isDeadGrantError(errCode)) {
      if (typeof vault.delete === 'function') {
        await vault.delete(oauth.refreshTokenVaultKey).catch(() => {});
      }
      if (typeof options.onRevoked === 'function') {
        await options.onRevoked(errCode);
      }
    } else if ((res.status === 400 || res.status === 401) && isClientRejectedError(errCode)) {
      // Keep the refresh token intact on client rejection; mark the registered client rejected
      // so the next sign-in registers a fresh client instead of reusing a dead client_id.
      if (conn.oauth && typeof conn.oauth === 'object') {
        conn.oauth.clientRejected = true;
      }
      if (typeof options.onClientRejected === 'function') {
        await options.onClientRejected({ error: errCode, clientId: oauth.clientId || null });
      }
    }
    return null;
  }

  const validated = validateTokenResponse(tokens);
  if (!validated.valid) {
    const errCode = validated.oauthError || '';
    if (isDeadGrantError(errCode)) {
      if (typeof vault.delete === 'function') {
        await vault.delete(oauth.refreshTokenVaultKey).catch(() => {});
      }
      if (typeof options.onRevoked === 'function') {
        await options.onRevoked(errCode);
      }
    } else if (isClientRejectedError(errCode)) {
      if (conn.oauth && typeof conn.oauth === 'object') {
        conn.oauth.clientRejected = true;
      }
      if (typeof options.onClientRejected === 'function') {
        await options.onClientRejected({ error: errCode, clientId: oauth.clientId || null });
      }
    }
    return null;
  }
  refreshRetryAfterUntil.delete(backoffKey);

  const grantId = typeof oauth.grantId === 'string' && oauth.grantId ? oauth.grantId : null;
  const grantSuffix = grantId ? `_${grantId.slice(0, 8)}` : '';
  const accessTokenVaultKey = oauth.accessTokenVaultKey || `__oauth_access_${conn.id}${grantSuffix}`;
  await vault.set(accessTokenVaultKey, validated.accessToken);

  const refreshTokenVaultKey = oauth.refreshTokenVaultKey;
  if (validated.refreshToken) {
    await vault.set(refreshTokenVaultKey, validated.refreshToken);
  }

  let clientSecretVaultKey = oauth.clientSecretVaultKey || null;
  if (clientSecret && !clientSecretVaultKey && conn?.id && typeof vault.set === 'function') {
    clientSecretVaultKey = `__oauth_client_secret_${conn.id}${grantSuffix}`;
    await vault.set(clientSecretVaultKey, clientSecret);
  }

  return {
    grantId,
    boundOrigin,
    clientId: oauth.clientId || null,
    clientOrigin: oauth.clientOrigin || 'dcr',
    clientRejected: false,
    clientSecret: null,
    clientSecretVaultKey,
    issuer: oauth.issuer || null,
    tokenEndpoint: oauth.tokenEndpoint,
    ...(oauth.tokenEndpointAuthMethod ? { tokenEndpointAuthMethod: oauth.tokenEndpointAuthMethod } : {}),
    callbackUrl: oauth.callbackUrl || null,
    accessTokenVaultKey,
    refreshTokenVaultKey,
    issuedAt: Date.now(),
    ttlMs: validated.ttlMs,
    expiresAt: validated.expiresAt,
  };
}

// options: { network, selfIdentity, onRevoked }. Concurrent calls for the same connection & grant share one in-flight request.
export function refreshOAuthToken(conn, vault, options = {}) {
  const oauth = conn?.oauth;
  if (!oauth?.refreshTokenVaultKey || !oauth?.tokenEndpoint || !vault || typeof vault.get !== 'function') {
    return Promise.resolve(null);
  }
  const connKey = conn?.id || oauth.refreshTokenVaultKey;
  const grantKey = oauth.grantId || oauth.refreshTokenVaultKey;
  const flightKey = `${vaultFlightPrefix(vault)}:${connKey}:${grantKey}`;
  const existing = inFlightRefreshes.get(flightKey);
  if (existing) return existing;

  const promise = performRefreshOAuthToken(conn, vault, options).finally(() => {
    if (inFlightRefreshes.get(flightKey) === promise) {
      inFlightRefreshes.delete(flightKey);
    }
  });
  inFlightRefreshes.set(flightKey, promise);
  return promise;
}
