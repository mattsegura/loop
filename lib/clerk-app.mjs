import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { parseEnv } from 'node:util';
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose';
import { allowedHosts, allowedOrigins } from './security.mjs';

const KEY_VAR = 'CLERK_PUBLISHABLE_KEY';
const LOCAL_ENV = new URL('../.env.local', import.meta.url);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const COMPACT_JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const USER_ID = /^user_[a-zA-Z0-9]{1,128}$/;
const SESSION_ID = /^sess_[a-zA-Z0-9]{1,128}$/;
// Default Clerk v2 browser sessions need not include a JWT ID (jti).
const REQUIRED_CLAIMS = ['iss', 'sub', 'sid', 'azp', 'v', 'exp', 'iat', 'nbf'];

export class ClerkAppConfigError extends Error {
  constructor() {
    super('Clerk app authentication is not configured. Set a valid CLERK_PUBLISHABLE_KEY.');
    this.name = 'ClerkAppConfigError';
    this.code = 'CLERK_APP_NOT_CONFIGURED';
  }
}

function readPublishableKey() {
  if (process.env[KEY_VAR] !== undefined) return process.env[KEY_VAR];
  try {
    return parseEnv(readFileSync(LOCAL_ENV, 'utf8'))[KEY_VAR];
  } catch {
    // Setup failures must not disclose filesystem errors or dotenv contents.
    throw new ClerkAppConfigError();
  }
}

function pinnedFrontendApi(key) {
  // Clerk encodes the Frontend API hostname followed by a literal '$'. Buffer
  // decoding is permissive, so compare the complete encoding before using it.
  const match = typeof key === 'string' && key.length <= 360 && /^pk_(?:test|live)_([A-Za-z0-9+/]+={0,2})$/.exec(key);
  if (!match) throw new ClerkAppConfigError();
  const encoded = match[1];
  const bytes = Buffer.from(encoded, 'base64');
  const b64 = bytes.toString('base64');
  if (encoded !== b64 && encoded !== b64.replace(/=+$/, '')) throw new ClerkAppConfigError();
  const decoded = bytes.toString('utf8');
  const hostname = decoded.slice(0, -1);
  const labels = hostname.split('.');
  if (!decoded.endsWith('$') || hostname.length > 253 || labels.length < 2 ||
      !labels.every(label => DNS_LABEL.test(label)) || isIP(hostname) ||
      /\.(?:localhost|local|internal|lan)$/.test(hostname)) {
    throw new ClerkAppConfigError();
  }
  const issuer = `https://${hostname}`;
  // Refuse alternative URL spellings, including URL-normalized IP literals.
  if (URL.parse(issuer)?.origin !== issuer) throw new ClerkAppConfigError();
  return issuer;
}

function requestOrigins(headers, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof headers.host !== 'string') return null;
  const host = headers.host.toLowerCase();
  if (!allowedHosts(port).has(host) || !/^(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::[1-9]\d{0,4})?$/.test(host)) return null;
  const loopOrigins = allowedOrigins(port);
  const current = new Set();
  for (const scheme of ['http', 'https']) {
    const raw = `${scheme}://${host}`;
    const url = URL.parse(raw);
    // Browsers omit explicit default ports, but do not accept other URL normalization.
    const defaultPort = scheme === 'http' ? ':80' : ':443';
    if (loopOrigins.has(raw) && url && (url.origin === raw || raw === `${url.origin}${defaultPort}`)) {
      current.add(url.origin);
    }
  }
  return current.size ? { current, canonical: new URL(`http://127.0.0.1:${port}`).origin } : null;
}

function cookieToken(headers, current) {
  if (typeof headers.cookie !== 'string') return null;
  const origin = headers.origin;
  const site = headers['sec-fetch-site'];
  if ((origin !== undefined && !current.has(origin)) ||
      (site !== undefined && site !== 'same-origin' && site !== 'none')) return null;
  let token;
  for (const field of headers.cookie.split(';')) {
    const index = field.indexOf('=');
    if (index < 0 || field.slice(0, index).trim() !== '__session') continue;
    if (token !== undefined) return null;
    token = field.slice(index + 1).trim();
  }
  return token;
}

/** Load once per app; pass a static JWKS only from in-process tests. */
export function loadClerkApp({ legacyMode = false, jwks } = {}) {
  if (legacyMode === true) return null;
  const publishableKey = readPublishableKey();
  const frontendApi = pinnedFrontendApi(publishableKey);
  // jose does not follow redirects and does not use JWT key URLs. The only
  // runtime key source is this app's configured HTTPS Frontend API.
  const keys = jwks === undefined
    ? createRemoteJWKSet(new URL('/.well-known/jwks.json', frontendApi), {
      timeoutDuration: 3000,
      cooldownDuration: 30000,
      cacheMaxAge: 600000,
    })
    : createLocalJWKSet(jwks);

  return Object.freeze({
    publishableKey,
    frontendApi,
    async verifyRequest(req, port) {
      const headers = req?.headers;
      if (!headers || req.headersDistinct?.host?.length > 1 || req.headersDistinct?.authorization?.length > 1) return null;
      const origins = requestOrigins(headers, port);
      if (!origins) return null;
      const authorization = headers.authorization;
      const bearer = authorization !== undefined;
      // Even a malformed Authorization header prevents fallback to cookies.
      const token = bearer
        ? (typeof authorization === 'string' && /^Bearer +([^ ]+)$/i.exec(authorization)?.[1])
        : cookieToken(headers, origins.current);
      if (!token || token.length > 16384 || !COMPACT_JWT.test(token)) return null;

      try {
        const now = new Date();
        const { payload } = await jwtVerify(token, (header, jwt) => {
          if (typeof header.kid !== 'string' || !header.kid ||
              (header.typ !== undefined && header.typ !== 'JWT')) throw new Error('Not a Clerk session token.');
          return keys(header, jwt);
        }, { algorithms: ['RS256'], issuer: frontendApi, requiredClaims: REQUIRED_CLAIMS, currentDate: now });
        const { sub, sid, azp, v, sts, jti, exp, iat, nbf } = payload;
        if (v !== 2 || (sts !== undefined && sts !== 'active') ||
            Object.hasOwn(payload, 'act') || Object.hasOwn(payload, 'may_act') ||
            typeof sub !== 'string' || !USER_ID.test(sub) || typeof sid !== 'string' || !SESSION_ID.test(sid) ||
            (jti !== undefined && (typeof jti !== 'string' || jti.length === 0)) ||
            ![exp, iat, nbf].every(time => Number.isSafeInteger(time * 1000) && Number.isSafeInteger(time) && time > 0) ||
            iat > Math.floor(now.getTime() / 1000) + 10 || exp <= Math.max(iat, nbf) || exp * 1000 <= Date.now()) {
          return null;
        }

        if (bearer) {
          if (azp !== origins.canonical && !origins.current.has(azp)) return null;
        } else if (!origins.current.has(azp) || (headers.origin !== undefined && headers.origin !== azp)) {
          return null;
        }
        return { userId: sub, sessionId: sid, issuer: frontendApi, expiresAt: exp * 1000 };
      } catch {
        // Includes bad signatures, bad claims and inaccessible keys. Never log credentials.
        return null;
      }
    },
  });
}
