// Unified outbound network policy, self-identity guard, SSRF-safe fetch, and zero-credential probe.

import dns from 'node:dns/promises';
import { realpathSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

export const DEFAULT_USER_AGENT = 'Loop-MCP-Gateway/1.0 (+https://useloop.sh)';

const PUBLIC_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/;
const LOCAL_SUFFIX = /\.(?:local|localhost|localdomain|internal|lan|home|corp|test|invalid|example|onion|arpa)$/;
const STRIP_HOST_PREFIXES = new Set(['mcp', 'api', 'www', 'app', 'remote', 'server', 'connect', 'gateway']);

const OAUTH_URL_LABELS = {
  'sign-in server': 'sign-in server',
  registration: 'sign-in registration address',
  token: 'sign-in token address',
  'sign-in page': 'sign-in page',
  'protected resource metadata': 'sign-in metadata address',
};

// Use only public IPv4 to keep the classification fail-closed (no mapped/NAT64 IPv6).
// Check at socket resolution, not in a separate preflight followed by another DNS lookup.
const NON_PUBLIC = new BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
]) NON_PUBLIC.addSubnet(address, bits);

// Explicit direct agents ignore ambient HTTP proxy settings. No socket reuse means the
// address policy is checked on every outbound request; TLS still checks the DNS name.
const DIRECT_HTTPS_AGENT = new https.Agent({ keepAlive: false });
const DIRECT_HTTP_AGENT = new http.Agent({ keepAlive: false });

function extractHostname(value) {
  if (value instanceof URL) return value.hostname.toLowerCase();
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (raw.includes('://')) {
    try {
      return new URL(raw).hostname.toLowerCase();
    } catch {
      return '';
    }
  }
  return raw.toLowerCase();
}

function stripBrackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function canonicalizeHost(value) {
  const host = extractHostname(value);
  if (!host) return '';
  const bare = stripBrackets(host);
  if (bare.includes(':')) {
    try {
      return stripBrackets(new URL(`http://[${bare}]`).hostname.toLowerCase());
    } catch {
      return bare;
    }
  }
  return bare;
}

export function isLoopbackHostname(value) {
  const bare = canonicalizeHost(value);
  if (!bare) return false;
  if (bare === 'localhost' || bare === 'localhost.' || bare.endsWith('.localhost') || bare.endsWith('.localhost.')) {
    return true;
  }
  if (isIPv4(bare) && bare.startsWith('127.')) return true;
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;
  if (/^::ffff:127\.\d+\.\d+\.\d+$/.test(bare)) return true;
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(bare)) return true;
  return false;
}

function isSelfLoopbackHost(value) {
  if (isLoopbackHostname(value)) return true;
  const bare = canonicalizeHost(value);
  if (!bare) return false;
  return bare === '0.0.0.0' || bare === '::' || bare === '0:0:0:0:0:0:0:0' ||
    bare === '::ffff:0.0.0.0' || bare === '::ffff:0:0';
}

function effectivePort(url) {
  if (url.port) return Number(url.port);
  if (url.protocol === 'https:') return 443;
  if (url.protocol === 'http:') return 80;
  return null;
}

function parseHostEntry(entry) {
  const trimmed = String(entry || '').trim().toLowerCase();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
    const hasExplicitPort = trimmed.includes('://')
      ? Boolean(u.port)
      : trimmed.startsWith('[')
        ? /\]:\d+$/.test(trimmed)
        : /:\d+$/.test(trimmed);
    return {
      hostname: canonicalizeHost(u.hostname).replace(/\.$/, ''),
      port: hasExplicitPort ? Number(u.port || effectivePort(u)) : null,
    };
  } catch {
    return null;
  }
}

export function buildSelfIdentity({ port = null, allowedHosts = [], extraOrigins = [], stdioPath = null } = {}) {
  const selfPort = port != null && Number.isFinite(Number(port)) && Number(port) > 0 ? Number(port) : null;

  const staticAllowedHosts = (Array.isArray(allowedHosts) ? allowedHosts : [])
    .map(parseHostEntry)
    .filter(Boolean);

  const normalizedExtraOrigins = new Set();
  for (const entry of Array.isArray(extraOrigins) ? extraOrigins : []) {
    try {
      normalizedExtraOrigins.add(new URL(String(entry).trim()).origin.toLowerCase());
    } catch {
      // Ignore invalid extraOrigins entries.
    }
  }

  const stdioTargets = new Set();
  if (typeof stdioPath === 'string' && stdioPath.trim()) {
    const resolved = path.resolve(stdioPath);
    stdioTargets.add(resolved);
    try {
      stdioTargets.add(realpathSync(resolved));
    } catch {
      // Best-effort realpath resolution.
    }
  }

  function matchesStdioToken(raw) {
    if (typeof raw !== 'string') return false;
    const cleaned = raw.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    if (!cleaned) return false;
    try {
      const resolved = path.resolve(cleaned);
      if (stdioTargets.has(resolved)) return true;
      try {
        if (stdioTargets.has(realpathSync(resolved))) return true;
      } catch {
        // Non-existent path or unresolvable symlink.
      }
    } catch {
      // Ignore invalid path strings.
    }
    return false;
  }

  function matchesStdioCandidate(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return false;
    if (matchesStdioToken(raw)) return true;
    const eqIdx = raw.indexOf('=');
    if (eqIdx > 0 && matchesStdioToken(raw.slice(eqIdx + 1))) return true;
    if (/\s/.test(raw)) {
      for (const target of stdioTargets) {
        if (raw.includes(target)) return true;
      }
      for (const part of raw.split(/\s+/)) {
        if (matchesStdioToken(part)) return true;
      }
    }
    return false;
  }

  function isSelfUrl(raw) {
    let url;
    if (raw instanceof URL) {
      url = raw;
    } else {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (!text) return false;
      try {
        url = new URL(text);
      } catch {
        return false;
      }
    }

    if (normalizedExtraOrigins.has(url.origin.toLowerCase())) {
      return true;
    }

    const urlPort = effectivePort(url);
    if (selfPort !== null && urlPort === selfPort && isSelfLoopbackHost(url.hostname)) {
      return true;
    }

    const urlHost = canonicalizeHost(url.hostname).replace(/\.$/, '');
    const envHosts = String(process.env.LOOP_HUB_ALLOWED_HOSTS || '')
      .split(',')
      .map(parseHostEntry)
      .filter(Boolean);

    for (const entry of [...staticAllowedHosts, ...envHosts]) {
      if (!entry.hostname || entry.hostname !== urlHost) continue;
      if (entry.port === null || entry.port === urlPort) return true;
    }

    return false;
  }

  function isSelfStdio(command, args = []) {
    if (!stdioTargets.size) return false;
    if (matchesStdioCandidate(command)) return true;
    if (Array.isArray(args)) {
      for (const arg of args) {
        if (matchesStdioCandidate(arg)) return true;
      }
    }
    return false;
  }

  return {
    isSelfUrl,
    isSelfStdio,
    port: selfPort,
  };
}

export function parsePublicHttpsUrl(value, { label = 'address' } = {}) {
  const raw = value instanceof URL ? value.href : value;
  const text = typeof raw === 'string' ? raw.trim() : '';
  // Apply the authority check before WHATWG URL normalization (credentials and encoded hostnames).
  const authority = /^https:\/\/([a-z0-9.-]+)(?::443)?(?:[/?]|$)/i.exec(text);
  const host = authority?.[1].toLowerCase();
  if (!host || host.length > 253 || !PUBLIC_HOST.test(host) || LOCAL_SUFFIX.test(host) || /[\s\\#]/.test(text)) {
    throw new Error(`${label} requires a public HTTPS domain on port 443.`);
  }
  const url = new URL(text);
  if (url.hostname !== host || url.username || url.password || url.port) {
    throw new Error(`${label} requires a public HTTPS domain on port 443.`);
  }
  return url;
}

export function getHostedOriginPolicy() {
  const raw = String(process.env.LOOP_TRUSTED_MCP_ORIGINS || '').trim();
  if (!raw) {
    return { mode: 'public', allowlist: null };
  }
  const origins = new Set();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    // Configuration is an origin, never a URL path, query, or wildcard.
    if (!/^https:\/\/[a-z0-9.-]+(?::443)?\/?$/i.test(trimmed)) continue;
    try {
      origins.add(parsePublicHttpsUrl(trimmed).origin);
    } catch {
      // Invalid settings do not grant access.
    }
  }
  return { mode: 'allowlist', allowlist: [...origins] };
}

export function assertPublicIPv4(address) {
  if (!isIPv4(address) || NON_PUBLIC.check(address) ||
      Object.values(networkInterfaces()).flat().some((iface) => iface.address === address)) {
    throw new Error('Upstream must resolve to a public IPv4 address.');
  }
}

function toLimitedWebStream(res, byteCap) {
  let received = 0;
  let finished = false;
  return new ReadableStream({
    start(controller) {
      const cleanup = () => {
        res.off('data', onData);
        res.off('end', onEnd);
        res.off('error', onError);
        res.off('close', onClose);
      };
      const onData = (chunk) => {
        if (finished) return;
        received += chunk.length;
        if (byteCap !== null && received > byteCap) {
          finished = true;
          cleanup();
          res.destroy();
          controller.error(new Error('Response exceeded maximum allowed size.'));
          return;
        }
        controller.enqueue(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          res.pause();
        }
      };
      const onEnd = () => {
        if (finished) return;
        finished = true;
        cleanup();
        controller.close();
      };
      const onError = (err) => {
        if (finished) return;
        finished = true;
        cleanup();
        controller.error(err);
      };
      const onClose = () => {
        if (finished) return;
        finished = true;
        cleanup();
        controller.close();
      };
      res.on('data', onData);
      res.on('end', onEnd);
      res.on('error', onError);
      res.on('close', onClose);
    },
    pull() {
      if (!finished && !res.destroyed) res.resume();
    },
    cancel() {
      finished = true;
      if (!res.destroyed) res.destroy();
    },
  });
}

export function createSafeFetch({
  requirePublic = true,
  allowedOrigin = null,
  allowlist = null,
  selfIdentity = null,
  returnRedirect = false,
  maxResponseBytes = 10 * 1024 * 1024,
} = {}) {
  return async (input, init = {}) => {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const rawUrl = input instanceof URL ? input.href : (isRequest ? input.url : input);

    let url;
    if (requirePublic) {
      url = parsePublicHttpsUrl(rawUrl, { label: 'Outbound request' });
    } else {
      try {
        url = new URL(String(rawUrl || '').trim());
      } catch {
        throw new Error('Outbound request URL is not valid.');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Outbound requests require http or https.');
      }
    }

    if (selfIdentity?.isSelfUrl(url.href)) {
      throw new Error('Loop cannot send requests to itself.');
    }
    if (allowedOrigin != null && url.origin !== allowedOrigin) {
      throw new Error('Outbound request must stay on the allowed origin.');
    }
    if (Array.isArray(allowlist) && !allowlist.includes(url.origin)) {
      throw new Error('Outbound request origin is not approved.');
    }

    const mergedHeaders = new Headers(isRequest ? input.headers : undefined);
    if (init.headers) {
      for (const [k, v] of new Headers(init.headers)) {
        mergedHeaders.set(k, v);
      }
    }
    if (!mergedHeaders.has('user-agent')) {
      mergedHeaders.set('user-agent', DEFAULT_USER_AGENT);
    }
    const headers = Object.fromEntries(mergedHeaders);

    let body = init.body;
    if (body instanceof URLSearchParams) {
      body = body.toString();
    } else if (body instanceof Uint8Array && !Buffer.isBuffer(body)) {
      body = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    }
    if (body != null && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      throw new Error('Unsupported outbound request body.');
    }
    if (body != null) {
      headers['content-length'] = Buffer.byteLength(body);
    }

    const method = init.method !== undefined ? init.method : (isRequest ? input.method : undefined);
    const isHttps = url.protocol === 'https:';
    const requestFn = isHttps ? https.request : http.request;
    const requestOptions = {
      agent: isHttps ? DIRECT_HTTPS_AGENT : DIRECT_HTTP_AGENT,
      method,
      headers,
      signal: init.signal || undefined,
    };

    if (isHttps) {
      requestOptions.rejectUnauthorized = true;
    }

    if (requirePublic) {
      requestOptions.family = 4;
      requestOptions.autoSelectFamily = false;
      requestOptions.lookup = function safeLookup(host, lookupOptions, callback) {
        dns.lookup(host, { family: 4, all: true }).then((records) => {
          if (!records.length) throw new Error('Upstream did not resolve.');
          for (const { address } of records) assertPublicIPv4(address);
          return records;
        }).then(
          (records) => (lookupOptions?.all
            ? callback(null, records.map(({ address }) => ({ address, family: 4 })))
            : callback(null, records[0].address, 4)),
          callback,
        );
      };
    }

    // Never follow HTTP redirects automatically, even if a caller or SDK asks to.
    return new Promise((resolve, reject) => {
      const req = requestFn(url, requestOptions, (res) => {
        const status = res.statusCode;
        const responseHeaders = new Headers();
        try {
          for (let i = 0; i < (res.rawHeaders?.length || 0); i += 2) {
            responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
          }
        } catch (err) {
          res.destroy();
          reject(err);
          return;
        }

        if (status >= 300 && status < 400) {
          if (returnRedirect) {
            res.resume();
            resolve(new Response(null, { status, headers: responseHeaders }));
            return;
          }
          res.destroy();
          reject(new Error('Redirects are not followed.'));
          return;
        }

        const byteCap = Number.isFinite(maxResponseBytes) && maxResponseBytes > 0 ? maxResponseBytes : null;
        if (byteCap !== null) {
          const contentLength = Number(responseHeaders.get('content-length'));
          if (Number.isFinite(contentLength) && contentLength > byteCap) {
            res.destroy();
            reject(new Error('Response exceeded maximum allowed size.'));
            return;
          }
        }

        try {
          const noBody = status === 204 || status === 205 || method === 'HEAD';
          if (noBody) {
            res.resume();
            resolve(new Response(null, { status, headers: responseHeaders }));
            return;
          }

          resolve(new Response(toLimitedWebStream(res, byteCap), { status, headers: responseHeaders }));
        } catch (err) {
          res.destroy();
          reject(err);
        }
      });
      req.on('error', reject);
      req.end(body ?? undefined);
    });
  };
}

export function createOutboundPolicy({ personal = false, selfIdentity = null } = {}) {
  const isPersonal = Boolean(personal);
  const identity = selfIdentity || null;

  function assertConnectionUrl(rawUrl) {
    if (identity?.isSelfUrl(rawUrl)) {
      throw new Error('Loop cannot connect to itself.');
    }

    if (isPersonal) {
      const url = parsePublicHttpsUrl(rawUrl, { label: 'Personal MCP' });
      if (identity?.isSelfUrl(url.href)) {
        throw new Error('Loop cannot connect to itself.');
      }
      const hosted = getHostedOriginPolicy();
      if (hosted.mode === 'allowlist' && !hosted.allowlist.includes(url.origin)) {
        throw new Error('Personal MCP origin is not approved by the server operator.');
      }
      return url;
    }

    let url;
    try {
      url = rawUrl instanceof URL ? new URL(rawUrl.href) : new URL(String(rawUrl || '').trim());
    } catch {
      throw new Error('Connection URL must be a valid http or https address.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Connection URL must use http or https.');
    }
    if (identity?.isSelfUrl(url.href)) {
      throw new Error('Loop cannot connect to itself.');
    }
    return url;
  }

  function assertOAuthUrl(rawUrl, purpose = 'sign-in server', { connectionUrl = null } = {}) {
    const label = OAUTH_URL_LABELS[purpose] || 'sign-in address';
    const text = rawUrl instanceof URL ? rawUrl.href : (typeof rawUrl === 'string' ? rawUrl.trim() : '');

    let parsed;
    try {
      parsed = new URL(text);
    } catch {
      throw new Error(`This connection's ${label} is not a secure (https) public address, so Loop will not use it.`);
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`This connection's ${label} is not a secure (https) public address, so Loop will not use it.`);
    }
    if (parsed.username || parsed.password || parsed.hash || /[\s\\]/.test(text)) {
      throw new Error(`This connection's ${label} is not a secure (https) public address, so Loop will not use it.`);
    }
    if (parsed.protocol === 'http:' && (isPersonal || !isLoopbackHostname(parsed.hostname))) {
      throw new Error(`This connection's ${label} is not a secure (https) public address, so Loop will not use it.`);
    }

    if (identity?.isSelfUrl(parsed.href)) {
      throw new Error('Loop cannot use itself as an upstream sign-in server.');
    }

    if (isPersonal) {
      let url;
      try {
        url = parsePublicHttpsUrl(parsed.href, { label });
      } catch {
        throw new Error(`This connection's ${label} is not a secure (https) public address, so Loop will not use it.`);
      }
      const hosted = getHostedOriginPolicy();
      if (hosted.mode === 'allowlist' && !hosted.allowlist.includes(url.origin)) {
        throw new Error(`This connection's ${label} (${url.origin}) is not approved by the server operator, so Loop will not use it.`);
      }
      return url;
    }

    let connParsed = null;
    if (connectionUrl != null) {
      try {
        connParsed = connectionUrl instanceof URL ? connectionUrl : new URL(String(connectionUrl).trim());
      } catch {
        connParsed = null;
      }
    }
    const connIsLoopback = connParsed ? isLoopbackHostname(connParsed.hostname) : false;

    if (connParsed && !connIsLoopback) {
      try {
        return parsePublicHttpsUrl(parsed.href, { label });
      } catch {
        throw new Error(`This connection's ${label} is not a secure (https) public address, so Loop will not use it.`);
      }
    }

    if (connParsed && connIsLoopback) {
      if (parsed.origin === connParsed.origin) {
        return parsed;
      }
      try {
        return parsePublicHttpsUrl(parsed.href, { label });
      } catch {
        throw new Error(`This connection's ${label} (${parsed.origin}) must be a secure (https) public address or match the connection's own origin.`);
      }
    }

    // Local mode without a connectionUrl: allow loopback (already checked against selfIdentity)
    // or require public HTTPS for any non-loopback address.
    if (isLoopbackHostname(parsed.hostname)) {
      return parsed;
    }
    try {
      return parsePublicHttpsUrl(parsed.href, { label });
    } catch {
      throw new Error(`This connection's ${label} is not a secure (https) public address, so Loop will not use it.`);
    }
  }

  function createFetchForUrl(targetUrl, { allowedOrigin = null, returnRedirect = false, maxResponseBytes } = {}) {
    const parsedTarget = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl).trim());
    const requirePublic = isPersonal || !isLoopbackHostname(parsedTarget.hostname);
    const hosted = isPersonal ? getHostedOriginPolicy() : null;
    const allowlist = hosted && hosted.mode === 'allowlist' ? hosted.allowlist : null;
    return createSafeFetch({
      requirePublic,
      allowedOrigin,
      allowlist,
      selfIdentity: identity,
      returnRedirect,
      ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
    });
  }

  function oauthNetwork(connectionUrl = null) {
    return {
      assertUrl: (val, purpose) => assertOAuthUrl(val, purpose, { connectionUrl }),
      async fetch(input, init) {
        const u = assertOAuthUrl(input, 'sign-in server', { connectionUrl });
        return createFetchForUrl(u, { allowedOrigin: u.origin })(u.href, init);
      },
    };
  }

  return {
    personal: isPersonal,
    selfIdentity: identity,
    assertConnectionUrl,
    assertOAuthUrl,
    createFetchForUrl,
    oauthNetwork,
  };
}

function titleCase(word) {
  return word
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

export function suggestNameFromHost(hostname) {
  if (isLoopbackHostname(hostname)) return 'Local MCP';
  const clean = stripBrackets(String(hostname || '').toLowerCase()).replace(/\.$/, '');
  const parts = clean.split('.').filter(Boolean);
  while (parts.length > 2 && STRIP_HOST_PREFIXES.has(parts[0])) {
    parts.shift();
  }
  const base = parts[0] || clean || 'MCP Server';
  return titleCase(base) || 'MCP Server';
}

async function readInitializePayload(res) {
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    return { html: true, payload: null };
  }

  if (contentType.includes('text/event-stream')) {
    if (!res.body) return { html: false, payload: null };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (buffer.length < 65536) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split(/\r?\n/);
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const rawData = line.slice(5).trim();
          if (!rawData || rawData === '[DONE]') continue;
          try {
            const parsed = JSON.parse(rawData);
            return { html: false, payload: parsed };
          } catch {
            // Keep reading until complete JSON event arrives.
          }
        }
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return { html: false, payload: null };
  }

  const text = await res.text().catch(() => '');
  if (!text.trim()) return { html: false, payload: null };
  try {
    return { html: false, payload: JSON.parse(text) };
  } catch {
    return { html: false, payload: null };
  }
}

export async function probeConnection(rawUrl, { policy = null, transport = null, timeoutMs = 10_000, callbackUrl = null } = {}) {
  const activePolicy = policy || createOutboundPolicy({ personal: false });

  let parsed;
  try {
    parsed = activePolicy.assertConnectionUrl(rawUrl);
  } catch (err) {
    return { status: 'error', error: err?.message || 'Invalid connection URL.' };
  }

  const fallbackName = suggestNameFromHost(parsed.hostname);
  const safeFetch = activePolicy.createFetchForUrl(parsed, {
    allowedOrigin: parsed.origin,
    returnRedirect: true,
  });

  const handleRedirect = (res) => {
    const location = res.headers.get('location');
    if (!location) {
      return { status: 'error', error: `Server returned HTTP ${res.status} without a redirect target.` };
    }
    let resolved;
    try {
      resolved = new URL(location, parsed);
    } catch {
      return { status: 'error', error: 'Server returned an invalid redirect URL.' };
    }
    try {
      const validated = activePolicy.assertConnectionUrl(resolved.href);
      return { status: 'redirect', originalUrl: parsed.href, redirectUrl: validated.href };
    } catch (err) {
      return { status: 'error', error: err?.message || 'Redirect target is not allowed.' };
    }
  };

  const isFirewallBlock = (res) => {
    if (res.status !== 403) return false;
    const wwwAuth = res.headers.get('www-authenticate');
    if (wwwAuth && wwwAuth.trim()) return false;
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    if (res.headers.get('cf-mitigated')) return true;
    return ct.includes('text/html');
  };

  const handleAuthChallenge = async (res) => {
    if (isFirewallBlock(res)) {
      return {
        status: 'error',
        reason: 'refused',
        url: parsed.href,
        error: 'Server refused the connection (HTTP 403 HTML/firewall block).',
      };
    }
    const wwwAuthenticate = res.headers.get('www-authenticate') || null;
    try {
      const { buildCimdClientId, discoverOAuth } = await import('./oauth.mjs');
      const meta = await discoverOAuth(parsed.href, {
        network: activePolicy.oauthNetwork(parsed.href),
        wwwAuthenticate,
      });
      const canInstantOAuth = Boolean(
        meta?.authorizationEndpoint &&
        meta?.tokenEndpoint &&
        (meta?.registrationEndpoint || (meta?.cimdSupported && buildCimdClientId(callbackUrl))),
      );
      if (canInstantOAuth) {
        const authUrl = new URL(meta.authorizationEndpoint);
        return {
          status: 'oauth',
          url: parsed.href,
          authHost: authUrl.host,
          sameOrigin: authUrl.origin === parsed.origin,
          issuer: meta.issuer || null,
          suggestedName: fallbackName,
        };
      }
    } catch {
      // No OAuth / DCR / CIMD support or disallowed OAuth metadata -> fall back to API key flow.
    }
    return {
      status: 'api_key',
      url: parsed.href,
      suggestedName: fallbackName,
    };
  };

  const trySseProbe = async () => {
    const sseRes = await safeFetch(parsed.href, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (sseRes.status >= 300 && sseRes.status < 400) {
      return handleRedirect(sseRes);
    }
    if (sseRes.status === 401 || sseRes.status === 403) {
      await sseRes.body?.cancel().catch(() => {});
      return handleAuthChallenge(sseRes);
    }
    const ct = String(sseRes.headers.get('content-type') || '').toLowerCase();
    await sseRes.body?.cancel().catch(() => {});
    if (sseRes.status === 200 && ct.includes('text/event-stream')) {
      return {
        status: 'ready',
        url: parsed.href,
        transport: 'sse',
        suggestedName: fallbackName,
      };
    }
    return {
      status: 'error',
      error: `Server responded with HTTP ${sseRes.status}.`,
    };
  };

  try {
    if (transport === 'sse') {
      return await trySseProbe();
    }

    const res = await safeFetch(parsed.href, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'loop-probe', version: '1.0.0' },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      return handleRedirect(res);
    }

    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      return handleAuthChallenge(res);
    }

    if (res.status === 200) {
      const sessionId = res.headers.get('mcp-session-id') || null;
      const { html, payload } = await readInitializePayload(res);
      if (html) {
        return { status: 'error', reason: 'not_mcp', error: 'Endpoint returned HTML instead of an MCP response.' };
      }
      const negotiatedVersion = typeof payload?.result?.protocolVersion === 'string' && payload.result.protocolVersion.trim()
        ? payload.result.protocolVersion.trim()
        : '2025-03-26';
      const serverInfo = payload?.result?.serverInfo;
      const suggestedName = typeof serverInfo?.name === 'string' && serverInfo.name.trim()
        ? serverInfo.name.trim()
        : fallbackName;
      const description = typeof serverInfo?.description === 'string' && serverInfo.description.trim()
        ? serverInfo.description.trim()
        : null;

      // Complete initialize -> notifications/initialized -> tools/list and close the probe session,
      // so servers that allow initialize anonymously but gate tools/list behind auth are detected accurately.
      const sessionHeaders = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': negotiatedVersion,
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      };
      try {
        try {
          const notifRes = await safeFetch(parsed.href, {
            method: 'POST',
            headers: sessionHeaders,
            body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
            signal: AbortSignal.timeout(Math.min(timeoutMs, 5000)),
          });
          await notifRes.body?.cancel().catch(() => {});
        } catch {
          // Best-effort notification before tools/list check.
        }
        const toolsRes = await safeFetch(parsed.href, {
          method: 'POST',
          headers: sessionHeaders,
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (toolsRes.status === 401 || toolsRes.status === 403) {
          await toolsRes.body?.cancel().catch(() => {});
          return await handleAuthChallenge(toolsRes);
        }
        await toolsRes.body?.cancel().catch(() => {});
      } catch {
        // If the server only answered initialize cleanly and timed out or rejected follow-up, keep ready.
      } finally {
        if (sessionId) {
          await safeFetch(parsed.href, {
            method: 'DELETE',
            headers: {
              'Mcp-Session-Id': sessionId,
              'MCP-Protocol-Version': negotiatedVersion,
            },
            signal: AbortSignal.timeout(2000),
          }).then((r) => r.body?.cancel().catch(() => {})).catch(() => {});
        }
      }

      return {
        status: 'ready',
        url: parsed.href,
        transport: 'http',
        suggestedName,
        description,
      };
    }

    await res.body?.cancel().catch(() => {});
    if ((res.status === 404 || res.status === 405) && transport !== 'http') {
      return await trySseProbe();
    }

    return {
      status: 'error',
      error: `Server responded with HTTP ${res.status}.`,
    };
  } catch (err) {
    return { status: 'error', error: noAnswerText(err, parsed.host) };
  }
}

// What the person who adds a server reads when it gives no usable answer. An error without a code is
// a rule of Loop, which is a sentence already.
function noAnswerText(err, host) {
  const code = String(err?.code || err?.cause?.code || '');
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /TIMEDOUT|TIMEOUT/.test(code)) {
    return `${host} did not answer in time. Check the address, or try again.`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Loop cannot find ${host}. Check the address.`;
  if (/CERT|LEAF_SIGNATURE/.test(code)) return `${host} has no valid security certificate, so Loop does not connect to it.`;
  if (code) return `No MCP server answers at ${host}. Check the address, and that the server is on.`;
  return err?.message || 'Failed to reach MCP server.';
}

// Preflight check used by loop__save before saving an unauthenticated remote connection:
// verifies whether an auth-gated server actually supports instant OAuth (DCR or CIMD),
// including servers that answer HTTP 200 to unauthenticated initialize while publishing PRM.
export async function probeAuthRequirement(
  rawUrl,
  { policy = null, transport = null, callbackUrl = null, timeoutMs = 8_000 } = {},
) {
  const activePolicy = policy || createOutboundPolicy({ personal: false });

  let parsed;
  try {
    parsed = activePolicy.assertConnectionUrl(rawUrl);
  } catch (err) {
    return { status: 'policy_error', error: err?.message || 'Invalid connection URL.' };
  }

  const safeFetch = activePolicy.createFetchForUrl(parsed, {
    allowedOrigin: parsed.origin,
    returnRedirect: true,
  });
  const oauthNet = activePolicy.oauthNetwork(parsed.href);

  const checkOAuth = async (wwwAuthenticate) => {
    const { checkInstantOAuth } = await import('./oauth.mjs');
    const res = await checkInstantOAuth(parsed.href, {
      network: oauthNet,
      wwwAuthenticate,
      callbackUrl,
    });
    if (res.ok) return { status: 'oauth_ready', mode: res.mode, meta: res.meta };
    if (res.reason === 'no_instant_oauth') {
      return { status: 'no_instant_oauth', issuer: res.issuer, error: res.error };
    }
    if (res.reason === 'no_oauth') {
      return { status: 'api_key_only', error: res.error };
    }
    return { status: 'oauth_incompatible', error: res.error };
  };

  const hasProtectedResourceMetadata = async () => {
    const pathname = parsed.pathname.replace(/\/+$/, '');
    const candidates = [];
    if (pathname && pathname !== '/') {
      candidates.push(`${parsed.origin}/.well-known/oauth-protected-resource${pathname}`);
    }
    candidates.push(`${parsed.origin}/.well-known/oauth-protected-resource`);
    for (const candidate of [...new Set(candidates)]) {
      try {
        const res = await oauthNet.fetch(candidate, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(Math.min(timeoutMs, 4_000)),
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          continue;
        }
        const json = await res.json().catch(() => null);
        if (json && typeof json === 'object' && Array.isArray(json.authorization_servers) && json.authorization_servers.length > 0) {
          return true;
        }
      } catch {
        // Ignore missing/unreachable PRM candidates.
      }
    }
    return false;
  };

  const probeSse = async () => {
    const sseRes = await safeFetch(parsed.href, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const wwwAuth = sseRes.headers.get('www-authenticate') || null;
    const location = sseRes.headers.get('location') || null;
    const contentType = (sseRes.headers.get('content-type') || '').toLowerCase();
    await sseRes.body?.cancel().catch(() => {});
    if (sseRes.status === 401 || sseRes.status === 403) {
      return await checkOAuth(wwwAuth);
    }
    if (sseRes.status === 200) {
      if (contentType.includes('text/html')) {
        return {
          status: 'unreachable',
          httpStatus: sseRes.status,
          error: 'Endpoint returned an HTML page instead of an MCP server response.',
        };
      }
      if (await hasProtectedResourceMetadata()) {
        const oauthCheck = await checkOAuth(null);
        return oauthCheck.status === 'oauth_ready'
          ? { ...oauthCheck, status: 'oauth_ready_unauthenticated_init' }
          : oauthCheck;
      }
      return { status: 'open_ready' };
    }
    if (sseRes.status >= 300 && sseRes.status < 400) {
      return {
        status: 'unreachable',
        httpStatus: sseRes.status,
        error: location
          ? `Endpoint redirected (${sseRes.status}) to ${location} instead of answering as an MCP server.`
          : `Endpoint redirected (${sseRes.status}) instead of answering as an MCP server.`,
      };
    }
    return {
      status: 'unreachable',
      httpStatus: sseRes.status,
      error: `Endpoint returned HTTP ${sseRes.status} instead of answering as an MCP server.`,
    };
  };

  try {
    if (transport === 'sse') {
      return await probeSse();
    }
    const res = await safeFetch(parsed.href, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'loop-auth-preflight', version: '1.0.0' },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const wwwAuth = res.headers.get('www-authenticate') || null;
    const location = res.headers.get('location') || null;
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    await res.body?.cancel().catch(() => {});

    if (res.status === 401 || res.status === 403) {
      return await checkOAuth(wwwAuth);
    }
    if (res.status === 200) {
      if (contentType.includes('text/html')) {
        return {
          status: 'unreachable',
          httpStatus: res.status,
          error: 'Endpoint returned an HTML page instead of an MCP server response.',
        };
      }
      if (await hasProtectedResourceMetadata()) {
        const oauthCheck = await checkOAuth(null);
        return oauthCheck.status === 'oauth_ready'
          ? { ...oauthCheck, status: 'oauth_ready_unauthenticated_init' }
          : oauthCheck;
      }
      return { status: 'open_ready' };
    }
    if (res.status >= 300 && res.status < 400) {
      return {
        status: 'unreachable',
        httpStatus: res.status,
        error: location
          ? `Endpoint redirected (${res.status}) to ${location} instead of answering as an MCP server.`
          : `Endpoint redirected (${res.status}) instead of answering as an MCP server.`,
      };
    }
    if ((res.status === 404 || res.status === 405) && transport !== 'http') {
      return await probeSse();
    }
    return {
      status: 'unreachable',
      httpStatus: res.status,
      error: `Endpoint returned HTTP ${res.status} instead of answering as an MCP server.`,
    };
  } catch (err) {
    return {
      status: 'unreachable',
      error: err?.message || 'Endpoint could not be reached.',
    };
  }
}
