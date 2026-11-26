// Request guard for the local gateway: blocks DNS-rebinding (unexpected Host) and
// cross-site browser requests (Origin / Sec-Fetch-Site), so a web page can never
// drive Loop's dashboard API or /mcp endpoint from the user's browser.

import { isIP } from 'node:net';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WORKSPACE_OAUTH_PUBLIC_RE =
  /^\/w\/[a-f0-9]{64}\/(?:oauth\/(?:register|token|revoke|device\/(?:code|token))|\.well-known\/(?:oauth-authorization-server|openid-configuration))$/;
const WORKSPACE_OAUTH_AUTHORIZE_RE = /^\/w\/[a-f0-9]{64}\/oauth\/authorize$/;
const WELL_KNOWN_OAUTH_RE =
  /^\/\.well-known\/(?:oauth-[a-z0-9-]+|openid-configuration)(?:\/[a-z0-9_-]+)*$/;
const BEARER_MCP_CORS_RE =
  /^(?:\/w\/[a-f0-9]{64})?(?:\/mcp(?:\/whoami)?|\/sse|\/messages|\/api\/v1\/(?:tools(?:\/[^/]+\/call)?|openapi\.json))$/;

const warnedInvalidHosts = new Set();

export function isValidAllowedHost(raw) {
  if (typeof raw !== 'string') return false;
  const entry = raw.trim().toLowerCase();
  if (!entry || entry.length > 260 || /\s/.test(entry)) return false;

  let hostPart = entry;
  let portPart = null;

  if (entry.startsWith('[')) {
    const closeIdx = entry.indexOf(']');
    if (closeIdx === -1) return false;
    const ipv6 = entry.slice(1, closeIdx);
    if (isIP(ipv6) !== 6) return false;
    const rest = entry.slice(closeIdx + 1);
    if (rest) {
      if (!rest.startsWith(':')) return false;
      portPart = rest.slice(1);
    }
    hostPart = `[${ipv6}]`;
  } else {
    const firstColon = entry.indexOf(':');
    if (firstColon !== -1) {
      if (entry.indexOf(':', firstColon + 1) !== -1) return false;
      hostPart = entry.slice(0, firstColon);
      portPart = entry.slice(firstColon + 1);
    }
    if (!hostPart || hostPart.length > 253) return false;
    const labels = hostPart.split('.');
    if (labels.some((label) => !DNS_LABEL.test(label))) return false;
    if (labels.every((label) => /^\d+$/.test(label)) && isIP(hostPart) !== 4) return false;
  }

  if (portPart !== null) {
    if (!/^[1-9]\d{0,4}$/.test(portPart)) return false;
    const portNum = Number(portPart);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return false;
  }

  const parsed = URL.parse(`http://${entry}`);
  if (!parsed) return false;
  if (
    parsed.hostname !== hostPart ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    return false;
  }
  return true;
}

export function validateAllowedHosts(
  raw = process.env.LOOP_HUB_ALLOWED_HOSTS || '',
  { warn = true } = {},
) {
  const parts = Array.isArray(raw)
    ? raw.map((entry) => String(entry ?? ''))
    : String(raw || '').split(',');
  const valid = [];
  const invalid = [];
  const seen = new Set();

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const normalized = trimmed.toLowerCase();
    if (isValidAllowedHost(normalized)) {
      if (!seen.has(normalized)) {
        seen.add(normalized);
        valid.push(normalized);
      }
    } else {
      invalid.push(trimmed);
      if (warn && !warnedInvalidHosts.has(normalized)) {
        warnedInvalidHosts.add(normalized);
        console.warn(
          `Ignoring invalid LOOP_HUB_ALLOWED_HOSTS entry "${trimmed}": expected RFC hostname[:port] (valid DNS labels, no underscores or whitespace, optional port 1..65535).`,
        );
      }
    }
  }
  return { valid, invalid };
}

export function extraAllowedHosts(raw = process.env.LOOP_HUB_ALLOWED_HOSTS || '') {
  return validateAllowedHosts(raw, { warn: true }).valid;
}

export function allowedHosts(port) {
  return new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    ...extraAllowedHosts(),
  ]);
}

export function allowedOrigins(port) {
  const out = new Set();
  for (const host of allowedHosts(port)) {
    out.add(`http://${host}`);
    if (!host.startsWith('127.0.0.1') && !host.startsWith('localhost') && !host.startsWith('[::1]')) {
      out.add(`https://${host}`);
    }
  }
  return out;
}

export function isOAuthPublicCorsPath(pathname) {
  if (typeof pathname !== 'string' || !pathname) return false;
  if (
    pathname === '/oauth/register' ||
    pathname === '/register' ||
    pathname === '/oauth/token' ||
    pathname === '/oauth/revoke' ||
    pathname === '/oauth/device/code' ||
    pathname === '/oauth/device/token'
  ) {
    return true;
  }
  if (WORKSPACE_OAUTH_PUBLIC_RE.test(pathname)) return true;
  if (WELL_KNOWN_OAUTH_RE.test(pathname)) return true;
  return false;
}

export function isBearerMcpCorsPath(pathname) {
  return typeof pathname === 'string' && pathname.length > 0 && BEARER_MCP_CORS_RE.test(pathname);
}

export function hasExplicitBearerHeader(req) {
  const auth = req?.headers?.authorization;
  if (typeof auth === 'string' && /^Bearer\s+\S+/i.test(auth.trim())) return true;
  const alt = req?.headers?.['x-loop-token'];
  return typeof alt === 'string' && alt.trim().length > 0;
}

// Returns null when the request may proceed, or { status, error } when it must be refused.
export function guardRequest(req, pathname, port) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!allowedHosts(port).has(host)) {
    return {
      status: 421,
      error: 'Unexpected Host header. Loop only answers requests addressed to itself.',
    };
  }

  // Cookie-less OAuth 2.1 metadata, registration, and token endpoints must be reachable
  // cross-origin by browser-based MCP clients (Host check above is still enforced).
  if (isOAuthPublicCorsPath(pathname)) {
    return null;
  }

  // Bearer-authenticated MCP, legacy SSE, and REST bridge endpoints allow open CORS
  // without cookies (never Access-Control-Allow-Credentials). Requests carrying cookies
  // or lacking an explicit Bearer token on non-OPTIONS methods still face full CSRF checks.
  if (isBearerMcpCorsPath(pathname)) {
    const hasCookie = typeof req.headers?.cookie === 'string' && req.headers.cookie.trim().length > 0;
    if (!hasCookie && (req.method === 'OPTIONS' || hasExplicitBearerHeader(req))) {
      return null;
    }
  }

  // OAuth browser redirects (upstream callback + MCP client authorization); state/PKCE protect them.
  if (
    (pathname === '/oauth/callback' || pathname === '/oauth/authorize' || WORKSPACE_OAUTH_AUTHORIZE_RE.test(pathname)) &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    return null;
  }

  // Opening the dashboard from a link elsewhere is a top-level navigation: the page
  // that linked here cannot read the response, and X-Frame-Options blocks framing.
  const isNavigation =
    (req.method === 'GET' || req.method === 'HEAD') &&
    String(req.headers['sec-fetch-mode'] || '').toLowerCase() === 'navigate';

  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (!isNavigation && (fetchSite === 'cross-site' || fetchSite === 'same-site')) {
    return { status: 403, error: 'Cross-site requests to Loop are blocked.' };
  }

  const origin = req.headers.origin;
  if (origin !== undefined && !allowedOrigins(port).has(String(origin).toLowerCase())) {
    return { status: 403, error: 'Requests from other origins are blocked.' };
  }

  return null;
}

export const PROXY_HEADERS = Object.freeze([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-server',
  'x-real-ip',
  'via',
  'cf-connecting-ip',
  'true-client-ip',
  'fly-client-ip',
  'x-original-forwarded-for',
  'x-cluster-client-ip',
  'fastly-client-ip',
  'tailscale-user-login',
]);

const PROXY_HEADER_SET = new Set(PROXY_HEADERS);
const LOOPBACK_REMOTE_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Presence check (not truthiness) so empty forwarding headers like `x-forwarded-for: ""` are still detected.
export function hasProxyHeaders(req) {
  const headers = req?.headers;
  if (!headers || typeof headers !== 'object') return false;
  if (PROXY_HEADERS.some((h) => Object.hasOwn(headers, h))) return true;
  return Object.keys(headers).some((k) => PROXY_HEADER_SET.has(k.toLowerCase()));
}

// Client IP for rate limits. Behind a same-host reverse proxy (Caddy) every
// request arrives from loopback, which would make per-IP limits global. When
// LOOP_TRUST_PROXY=1 and the socket peer is loopback, use the right-most
// X-Forwarded-For entry (the one our own proxy appended).
export function resolveClientIp(req, env = process.env) {
  const peer = req?.socket?.remoteAddress || null;
  if (String(env.LOOP_TRUST_PROXY || '') !== '1' || !LOOPBACK_REMOTE_ADDRESSES.has(peer)) return peer;
  const xff = req?.headers?.['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff.join(',') : String(xff || '');
  const hops = raw.split(',').map((h) => h.trim()).filter(Boolean);
  const last = hops.at(-1);
  if (!last || last.length > 64 || !/^[0-9a-fA-F:.]+$/.test(last)) return peer;
  return last;
}

export function isLocalDeviceRequest(req, port, { hosted = false } = {}) {
  if (hosted === true) return false;
  if (hasProxyHeaders(req)) return false;
  const host = String(req?.headers?.host || '').toLowerCase();
  const loopbackHost =
    host === `127.0.0.1:${port}` ||
    host === `localhost:${port}` ||
    host === `[::1]:${port}`;
  if (!loopbackHost) return false;
  return LOOPBACK_REMOTE_ADDRESSES.has(req?.socket?.remoteAddress);
}

export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
});
