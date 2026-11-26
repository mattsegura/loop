// Boundary 1: Unified connection admission, secret extraction, sink integrity,
// transactional rollback, and cascading deletion.

import { assertPersonalEdit } from './personal-upstreams.mjs';
import { addedByFor } from './context-names.mjs';
import {
  itemMatchesProfile,
  normalizeConnectionProfiles,
  normalizeProfileTag,
} from './profiles.mjs';
import {
  connectionSecretKeys,
  findSecretRefs,
  hasInternalSecretRefs,
  isInternalVaultKey,
} from './secret-refs.mjs';
import {
  normalizedOriginOf,
  resolveTransportLoose,
  sinkDisplay,
  sinkKey,
  sinkOf,
  sinksEqual,
} from './sink.mjs';

export {
  normalizedOriginOf,
  resolveTransportLoose,
  sinkDisplay,
  sinkKey,
  sinkOf,
  sinksEqual,
};

const SECRET_NAME = /(key|token|secret|passw|pwd|auth|credential|bearer|cookie|session|private|signature)/i;
const SECRET_QUERY_NAME =
  /(key|token|secret|passw|pwd|auth|credential|bearer|cookie|session|private|signature|jwt|api[-_]?key|access[-_]?token|client[-_]?secret)|^(?:sig|pass|pat)$/i;
const SECRET_PATH_MARKER =
  /^(?:s|t|k|key|keys|apikey|api[_-]?key|token|tokens|secret|secrets|auth|bearer|hook|hooks|webhook|webhooks)$/i;
const EXPLICIT_SECRET_PATH_MARKER =
  /^(?:key|keys|apikey|api[_-]?key|token|tokens|secret|secrets|bearer)$/i;
const BENIGN_HEADERS = new Set([
  'accept',
  'content-type',
  'user-agent',
  'accept-language',
  'mcp-protocol-version',
  'notion-version',
]);
const KNOWN_SECRET_PREFIX =
  /^(sbp_|sk-|sk_live_|sk_test_|rk_live_|shpat_|shpca_|ghp_|gho_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza|hf_|pk_live_|ya29\.)/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENCODED_PLACEHOLDER_RE =
  /%7[Bb]%7[Bb]vault(?:%3[Aa]|:)([A-Za-z0-9_.-]{1,100})%7[Dd]%7[Dd]/g;

const RESERVED_CONNECTION_IDS = new Set(['loop', 'loop_host']);
const FORBIDDEN_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const HEADER_CONTROL_RE = /[\r\n\0]/;

export function isValidConnectionId(id) {
  return (
    typeof id === 'string' &&
    /^[a-z0-9](?:[a-z0-9_]*[a-z0-9])?$/.test(id) &&
    !id.includes('__') &&
    !RESERVED_CONNECTION_IDS.has(id)
  );
}

const TRANSPORT_ALIASES = {
  http: 'http',
  'streamable-http': 'http',
  streamable_http: 'http',
  streamablehttp: 'http',
  remote: 'http',
  sse: 'sse',
  stdio: 'stdio',
  local: 'stdio',
  builtin: 'builtin',
  openapi: 'openapi',
  graphql: 'graphql',
};

const ALLOWED_WRITE_FIELDS = [
  'name',
  'description',
  'accountLabel',
  'agentNote',
  'transport',
  'type',
  'url',
  'specUrl',
  'apiOperations',
  'headers',
  'command',
  'args',
  'env',
  'cwd',
  'profiles',
  'enabled',
  'partnerSkillsEnabled',
  'disabledTools',
  'allowedTools',
  'pinnedTools',
  'remoteAccess',
  'installSpec',
  'toolSetupId',
  'home',
];

// How a Connection runs on the owner's other computers, and whether its remote partner Skills
// are exposed to agents. Only the owner sets these in the Loop dashboard.
const OWNER_ONLY_FIELDS = ['partnerSkillsEnabled', 'remoteAccess', 'installSpec', 'toolSetupId', 'home'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function httpError(message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
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

function vaultSafe(str) {
  return String(str || '')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'x';
}

function normalizeVaultPlaceholdersInUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  return url.replace(ENCODED_PLACEHOLDER_RE, '{{vault:$1}}');
}

function hasVaultPlaceholder(str) {
  if (typeof str !== 'string') return false;
  return str.includes('{{vault:') || normalizeVaultPlaceholdersInUrl(str).includes('{{vault:');
}

function findConnectionRefs(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const normalizedUrl = typeof obj.url === 'string' ? normalizeVaultPlaceholdersInUrl(obj.url) : '';
  return findSecretRefs({
    url: normalizedUrl,
    headers: obj.headers || {},
    env: obj.env || {},
    args: obj.args || [],
  });
}

function findAllInputRefs(input) {
  if (!input || typeof input !== 'object') return [];
  const normalizedUrl = typeof input.url === 'string' ? normalizeVaultPlaceholdersInUrl(input.url) : '';
  return findSecretRefs({
    url: normalizedUrl,
    headers: input.headers,
    env: input.env,
    args: input.args,
    command: input.command,
    cwd: input.cwd,
    token: input.token,
  });
}

export function looksLikeSecretValue(value) {
  const v = String(value);
  if (v.length < 24 || /\s/.test(v)) return false;
  if (/^(https?:)?\/\//.test(v) || v.startsWith('/') || v.startsWith('~') || v.startsWith('.')) {
    return false;
  }
  return /[A-Za-z]/.test(v) && /\d/.test(v) && /^[A-Za-z0-9_\-+/=.:]+$/.test(v);
}

export function isSecretEnv(key, value) {
  if (typeof value !== 'string' || !value || value.includes('{{vault:')) return false;
  return SECRET_NAME.test(key) || looksLikeSecretValue(value);
}

// Finds command-line arguments that carry secrets: "--api-key VALUE",
// "--token=VALUE", or a bare value with a well-known secret prefix.
export function secretArgs(args) {
  const out = [];
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = String(list[i]);
    if (a.includes('{{vault:')) continue;
    const eq = a.match(/^(--?[A-Za-z0-9][\w-]*)=(.+)$/);
    if (eq && SECRET_NAME.test(eq[1])) {
      out.push({ index: i, prefix: `${eq[1]}=`, value: eq[2], label: eq[1].replace(/^-+/, '') });
      continue;
    }
    const prev = i > 0 ? String(list[i - 1]) : '';
    if (
      /^--?[A-Za-z]/.test(prev) &&
      !prev.includes('=') &&
      SECRET_NAME.test(prev) &&
      !a.startsWith('-')
    ) {
      out.push({ index: i, prefix: '', value: a, label: prev.replace(/^-+/, '') });
      continue;
    }
    if (KNOWN_SECRET_PREFIX.test(a)) {
      out.push({ index: i, prefix: '', value: a, label: `arg${i + 1}` });
    }
  }
  return out;
}

export function isSecretHeader(key, value) {
  if (typeof value !== 'string' || !value || value.includes('{{vault:')) return false;
  return !BENIGN_HEADERS.has(String(key).toLowerCase());
}

function isSecretPathSegment(seg, prevSeg = '') {
  if (typeof seg !== 'string' || !seg || hasVaultPlaceholder(seg)) return false;
  if (KNOWN_SECRET_PREFIX.test(seg)) return true;
  if (UUID_RE.test(seg)) return false;
  if (!/^[A-Za-z0-9_\-+=.:]+$/.test(seg)) return false;

  const hasLower = /[a-z]/.test(seg);
  const hasUpper = /[A-Z]/.test(seg);
  const hasLetter = hasLower || hasUpper;
  const hasDigit = /\d/.test(seg);
  const mixedCase = hasLower && hasUpper;

  // Segments immediately after a secret path marker (e.g. /s/<tok>, /token/<tok>, /key/<tok>).
  if (prevSeg && SECRET_PATH_MARKER.test(prevSeg)) {
    if (seg.length >= 12 && hasLetter && hasDigit) return true;
    if (seg.length >= 16 && mixedCase) return true;
    if (EXPLICIT_SECRET_PATH_MARKER.test(prevSeg) && seg.length >= 8 && (hasDigit || mixedCase)) {
      return true;
    }
  }

  // Standalone high-entropy secret-like segment (not a UUID or normal hyphenated slug).
  if (seg.length < 20 || !hasLetter || !hasDigit) return false;

  // Hex token of >= 24 chars with both letters and digits.
  if (seg.length >= 24 && /^[0-9a-fA-F]{24,}$/.test(seg)) return true;

  // Mixed-case + digits token (e.g. PATHTOKEN7x9Qk2Lm4Np6Rs8Tv0Wy3Za5 or URLSECRET-0123456789abcdef).
  const hyphenCount = (seg.match(/-/g) || []).length;
  const hasLongAlnumRun = /[A-Za-z0-9_]{12,}/.test(seg);
  if (mixedCase && (hyphenCount <= 2 || hasLongAlnumRun)) return true;

  // Long non-slug token (>= 24 chars) with substantial alphanumeric run and >= 3 digits.
  const digitCount = (seg.match(/\d/g) || []).length;
  if (seg.length >= 24 && digitCount >= 3 && (hyphenCount === 0 || /[A-Za-z0-9_]{20,}/.test(seg))) {
    return true;
  }

  return false;
}

function safeDecodeURIComponent(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

// Extracts embedded secrets from a URL's userinfo, path segments, and query parameters.
// Never touches protocol or host (origin stays literal). Builds sanitized URLs cleanly
// without percent-encoding {{vault:KEY}} placeholders.
export function extractUrlSecrets(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return {
      url: rawUrl,
      secrets: [],
      buildUrl: () => rawUrl,
      maskUrl: () => rawUrl,
    };
  }

  const trimmed = rawUrl.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      url: rawUrl,
      secrets: [],
      buildUrl: () => rawUrl,
      maskUrl: () => rawUrl,
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      url: rawUrl,
      secrets: [],
      buildUrl: () => rawUrl,
      maskUrl: () => rawUrl,
    };
  }

  const secrets = [];

  // 1. Userinfo (username / password) — inspect raw authority to preserve existing {{vault:...}}.
  const schemeEnd = trimmed.indexOf('://');
  const afterScheme = schemeEnd === -1 ? '' : trimmed.slice(schemeEnd + 3);
  const pathBoundary = afterScheme.search(/[/?#]/);
  const rawAuthority = pathBoundary === -1 ? afterScheme : afterScheme.slice(0, pathBoundary);
  const atIdx = rawAuthority.lastIndexOf('@');
  const rawUserinfo = atIdx === -1 ? '' : rawAuthority.slice(0, atIdx);

  let preserveRawUserinfo = false;
  let userSlot = null;
  let passSlot = null;

  if (rawUserinfo) {
    if (hasVaultPlaceholder(rawUserinfo)) {
      preserveRawUserinfo = true;
    } else {
      if (parsed.username) {
        userSlot = secrets.length;
        secrets.push({
          kind: 'userinfo',
          field: 'username',
          label: 'url_username',
          value: safeDecodeURIComponent(parsed.username),
        });
      }
      if (parsed.password) {
        passSlot = secrets.length;
        secrets.push({
          kind: 'userinfo',
          field: 'password',
          label: 'url_password',
          value: safeDecodeURIComponent(parsed.password),
        });
      }
    }
  }

  // 2. Path segments (preserve existing {{vault:...}} placeholders unencoded).
  const normalizedPathname = normalizeVaultPlaceholdersInUrl(parsed.pathname);
  const pathSegments = normalizedPathname.split('/');
  const pathSlots = new Map();
  let prevNonEmptySeg = '';

  for (let i = 0; i < pathSegments.length; i += 1) {
    const seg = pathSegments[i];
    if (!seg) continue;
    if (hasVaultPlaceholder(seg)) {
      prevNonEmptySeg = seg;
      continue;
    }
    const decoded = safeDecodeURIComponent(seg);
    if (isSecretPathSegment(decoded, prevNonEmptySeg)) {
      const markerLabel =
        prevNonEmptySeg && EXPLICIT_SECRET_PATH_MARKER.test(prevNonEmptySeg)
          ? `url_${prevNonEmptySeg.toLowerCase()}`
          : 'url_token';
      const slot = secrets.length;
      secrets.push({
        kind: 'path',
        index: i,
        label: markerLabel,
        value: decoded,
      });
      pathSlots.set(i, slot);
    }
    prevNonEmptySeg = decoded;
  }

  // 3. Query parameters (preserve existing {{vault:...}} and unrelated parameter encoding).
  const rawSearch = parsed.search;
  const queryParts = rawSearch.length > 1 ? rawSearch.slice(1).split('&') : [];
  const queryEntries = [];

  for (const part of queryParts) {
    if (!part) {
      queryEntries.push({ raw: part, slot: null });
      continue;
    }
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) {
      queryEntries.push({ raw: part, slot: null });
      continue;
    }
    const rawKey = part.slice(0, eqIdx);
    const rawVal = part.slice(eqIdx + 1);
    const normVal = normalizeVaultPlaceholdersInUrl(rawVal);
    if (!normVal || hasVaultPlaceholder(normVal)) {
      queryEntries.push({ raw: `${rawKey}=${normVal}`, slot: null });
      continue;
    }
    const decodedKey = safeDecodeURIComponent(rawKey.replace(/\+/g, ' '));
    const decodedVal = safeDecodeURIComponent(rawVal);
    const isSecret =
      decodedVal.length > 0 &&
      (SECRET_QUERY_NAME.test(decodedKey) ||
        KNOWN_SECRET_PREFIX.test(decodedVal) ||
        looksLikeSecretValue(decodedVal));
    if (isSecret) {
      // Preserve rawVal if decoding introduces URL query delimiters (&, #, ?, whitespace).
      const storedVal = /[&#?\s]/.test(decodedVal) ? rawVal : decodedVal;
      const slot = secrets.length;
      secrets.push({
        kind: 'query',
        key: decodedKey,
        label: decodedKey || 'query_secret',
        value: storedVal,
      });
      queryEntries.push({ rawKey, slot });
    } else {
      queryEntries.push({ raw: part, slot: null });
    }
  }

  const render = (replacementForSlot) => {
    if (secrets.length === 0) return trimmed;
    let userinfoPart = '';
    if (preserveRawUserinfo) {
      userinfoPart = `${normalizeVaultPlaceholdersInUrl(rawUserinfo)}@`;
    } else if (userSlot !== null || passSlot !== null) {
      const u = userSlot !== null ? replacementForSlot(userSlot) : '';
      const p = passSlot !== null ? replacementForSlot(passSlot) : '';
      userinfoPart = passSlot !== null ? `${u}:${p}@` : `${u}@`;
    }

    const builtPath = pathSegments
      .map((seg, idx) => (pathSlots.has(idx) ? replacementForSlot(pathSlots.get(idx)) : seg))
      .join('/');

    let builtSearch = '';
    if (queryEntries.length > 0) {
      const rebuilt = queryEntries.map((entry) =>
        entry.slot !== null ? `${entry.rawKey}=${replacementForSlot(entry.slot)}` : entry.raw,
      );
      builtSearch = `?${rebuilt.join('&')}`;
    } else if (rawSearch === '?') {
      builtSearch = '?';
    }

    return `${parsed.protocol}//${userinfoPart}${parsed.host}${builtPath}${builtSearch}${parsed.hash}`;
  };

  const buildUrl = (keyByIndex) => {
    if (secrets.length === 0) return trimmed;
    return render((idx) => {
      const key =
        typeof keyByIndex === 'function' ? keyByIndex(idx, secrets[idx]) : keyByIndex?.[idx];
      if (typeof key !== 'string' || !key) {
        throw new Error(`Missing Vault key for extracted URL secret at index ${idx}.`);
      }
      return `{{vault:${key}}}`;
    });
  };

  const maskUrl = (mask = '••••') => {
    if (secrets.length === 0) return trimmed;
    return render(() => mask);
  };

  return {
    url: trimmed,
    secrets,
    buildUrl,
    maskUrl,
  };
}

function setAuthorizationPlaceholder(headers, vaultKey) {
  const out = {};
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() !== 'authorization') out[k] = v;
    }
  }
  out.Authorization = `Bearer {{vault:${vaultKey}}}`;
  return out;
}

async function pickVaultKey(vault, base, value, reserved) {
  let clean = String(base || '').replace(/^_+/, '').slice(0, 96);
  if (!clean) clean = 'secret';
  for (let n = 1; n < 100; n += 1) {
    const key = n === 1 ? clean : `${clean}_${n}`;
    if (reserved.has(key)) continue;
    const current = await vault.get(key).catch(() => null);
    if (current === null) return { key, isNew: true };
    if (current === value) return { key, isNew: false };
  }
  throw new Error('Could not find a free Vault key.');
}

// Extracts plaintext secrets from a connection (explicitToken, URL, headers, env, args)
// into Vault, binding newly created entries to the connection's canonical destination sink,
// reusing identical existing entries without clobbering their metadata, and providing a
// transactional rollback() that deletes only newly created keys and restores any rotated token.
export async function extractConnectionSecrets(
  conn,
  vault,
  { connName = '', connId = null, explicitToken = null, existing = null, targetSink = undefined } = {},
) {
  const name = connName || conn?.name || connId || 'conn';
  const prefix = vaultSafe(name).toLowerCase();
  const transport = resolveTransportLoose(conn);
  const newlyCreatedKeys = [];
  const restorables = [];
  const reserved = new Set();
  let movedCount = 0;

  let url = conn?.url ?? null;
  let headers = isPlainObject(conn?.headers) ? { ...conn.headers } : {};
  let env = isPlainObject(conn?.env) ? { ...conn.env } : {};
  let args = Array.isArray(conn?.args) ? [...conn.args] : [];
  const initialSink = targetSink !== undefined ? targetSink : sinkKey(conn);
  const connProfiles = normalizeConnectionProfiles(
    conn?.profiles !== undefined ? conn.profiles : existing?.profiles,
  );
  const specificProfiles = connProfiles.filter((p) => p !== 'all');
  const newSecretMeta = (description) => ({
    description,
    allowedSinks: initialSink ? [initialSink] : [],
    ...(specificProfiles.length > 0 ? { profiles: specificProfiles } : {}),
  });

  let rolledBack = false;
  const rollback = async () => {
    if (rolledBack || !vault) return;
    rolledBack = true;
    for (const key of newlyCreatedKeys) {
      await vault.delete(key).catch(() => {});
    }
    for (const prev of restorables) {
      await vault.set(prev.key, prev.value, prev.meta || '').catch(() => {});
    }
  };

  try {
    // 1. Explicit bearer token
    if (typeof explicitToken === 'string' && explicitToken.trim()) {
      const rawToken = explicitToken.trim().replace(/^Bearer\s+/i, '').trim();
      if (rawToken) {
        if (!vault) throw new Error('Vault is required to store connection secrets.');
        const slug = connId ? vaultSafe(connId) : slugify(name);
        const ownKey = `conn_${slug}_token`;
        let targetKey = ownKey;
        const currentVal = await vault.get(ownKey).catch(() => null);

        if (currentVal === null) {
          await vault.set(ownKey, rawToken, newSecretMeta(`Bearer token for ${name}`));
          newlyCreatedKeys.push(ownKey);
          reserved.add(ownKey);
          movedCount += 1;
        } else if (currentVal === rawToken) {
          reserved.add(ownKey);
          movedCount += 1;
        } else {
          // Only rotate conn_<connId>_token in place when updating an existing connection
          // that actually owns this key (never clobber an unowned Vault entry).
          const existingRefs = existing ? findConnectionRefs(existing) : [];
          const prevMeta = await vault.getMeta?.(ownKey).catch(() => null);
          const isOwnedByExisting =
            Boolean(existing) &&
            Boolean(connId) &&
            (existingRefs.includes(ownKey) ||
              (prevMeta?.description &&
                prevMeta.description === `Bearer token for ${existing.name}`));

          if (isOwnedByExisting) {
            restorables.push({
              key: ownKey,
              value: currentVal,
              meta: prevMeta
                ? {
                    description: prevMeta.description,
                    type: prevMeta.type,
                    approval: prevMeta.approval,
                    allowedSinks: Array.isArray(prevMeta.allowedSinks) ? prevMeta.allowedSinks : [],
                    ...(Array.isArray(prevMeta.profiles) ? { profiles: prevMeta.profiles } : {}),
                  }
                : '',
            });
            const nextAllowedSinks = initialSink
              ? [initialSink]
              : Array.isArray(prevMeta?.allowedSinks)
                ? prevMeta.allowedSinks
                : [];
            await vault.set(
              ownKey,
              rawToken,
              prevMeta
                ? {
                    description: prevMeta.description || `Bearer token for ${name}`,
                    type: prevMeta.type,
                    approval: prevMeta.approval,
                    allowedSinks: nextAllowedSinks,
                    ...(specificProfiles.length > 0 ? { profiles: specificProfiles } : {}),
                  }
                : newSecretMeta(`Bearer token for ${name}`),
            );
            reserved.add(ownKey);
            movedCount += 1;
          } else {
            const picked = await pickVaultKey(vault, ownKey, rawToken, reserved);
            targetKey = picked.key;
            reserved.add(targetKey);
            if (picked.isNew) {
              await vault.set(targetKey, rawToken, newSecretMeta(`Bearer token for ${name}`));
              newlyCreatedKeys.push(targetKey);
            }
            movedCount += 1;
          }
        }

        if (transport !== 'stdio') {
          headers = setAuthorizationPlaceholder(headers, targetKey);
        }
      }
    }

    // 2. URL secrets (userinfo, path tokens, query params)
    if (transport !== 'stdio' && typeof url === 'string' && url) {
      const extractedUrl = extractUrlSecrets(url);
      if (extractedUrl.secrets.length > 0) {
        if (!vault) throw new Error('Vault is required to store connection secrets.');
        const keys = [];
        for (const item of extractedUrl.secrets) {
          const picked = await pickVaultKey(
            vault,
            `${prefix}_${vaultSafe(item.label)}`,
            item.value,
            reserved,
          );
          reserved.add(picked.key);
          if (picked.isNew) {
            await vault.set(
              picked.key,
              item.value,
              newSecretMeta(`${item.label} in URL for ${name}`),
            );
            newlyCreatedKeys.push(picked.key);
          }
          movedCount += 1;
          keys.push(picked.key);
        }
        url = extractedUrl.buildUrl(keys);
      }
    }

    // 3. Headers (non-stdio)
    if (transport !== 'stdio') {
      for (const [k, v] of Object.entries(headers)) {
        if (!isSecretHeader(k, v)) continue;
        const bearer = /^authorization$/i.test(k) ? v.match(/^Bearer\s+(.+)$/i) : null;
        const secret = bearer ? bearer[1].trim() : v;
        if (!secret || secret.includes('{{vault:')) continue;
        if (!vault) throw new Error('Vault is required to store connection secrets.');
        const picked = await pickVaultKey(vault, `${prefix}_${vaultSafe(k)}`, secret, reserved);
        reserved.add(picked.key);
        if (picked.isNew) {
          await vault.set(picked.key, secret, newSecretMeta(`${k} header for ${name}`));
          newlyCreatedKeys.push(picked.key);
        }
        movedCount += 1;
        headers[k] = bearer ? `Bearer {{vault:${picked.key}}}` : `{{vault:${picked.key}}}`;
      }
    }

    // 4. Environment variables (stdio)
    if (transport === 'stdio') {
      for (const [k, v] of Object.entries(env)) {
        if (!isSecretEnv(k, v)) continue;
        if (!vault) throw new Error('Vault is required to store connection secrets.');
        const picked = await pickVaultKey(vault, `${prefix}_${vaultSafe(k)}`, v, reserved);
        reserved.add(picked.key);
        if (picked.isNew) {
          await vault.set(picked.key, v, newSecretMeta(`${k} for ${name}`));
          newlyCreatedKeys.push(picked.key);
        }
        movedCount += 1;
        env[k] = `{{vault:${picked.key}}}`;
      }
    }

    // 5. Command-line arguments (stdio)
    let argsReplaced = false;
    if (transport === 'stdio') {
      for (const hit of secretArgs(args)) {
        if (!vault) throw new Error('Vault is required to store connection secrets.');
        const picked = await pickVaultKey(
          vault,
          `${prefix}_${vaultSafe(hit.label)}`,
          hit.value,
          reserved,
        );
        reserved.add(picked.key);
        if (picked.isNew) {
          await vault.set(picked.key, hit.value, newSecretMeta(`${hit.label} argument for ${name}`));
          newlyCreatedKeys.push(picked.key);
        }
        movedCount += 1;
        args[hit.index] = `${hit.prefix}{{vault:${picked.key}}}`;
        argsReplaced = true;
      }
    }

    // For stdio connections whose args had plaintext secrets replaced with {{vault:...}},
    // re-bind newly created keys to the post-extraction sinkKey so it matches the stored entry.
    if (transport === 'stdio' && argsReplaced && newlyCreatedKeys.length > 0 && vault?.updateMeta) {
      const command =
        typeof conn?.command === 'string' && conn.command.trim()
          ? conn.command.trim()
          : typeof existing?.command === 'string'
            ? existing.command.trim()
            : '';
      const cwd =
        conn?.cwd !== undefined
          ? conn.cwd
          : existing?.cwd ?? null;
      const finalSink = sinkKey({ transport: 'stdio', command, args, cwd });
      if (finalSink && finalSink !== initialSink) {
        for (const key of newlyCreatedKeys) {
          await vault.updateMeta(key, { allowedSinks: [finalSink] });
        }
      }
    }
  } catch (err) {
    await rollback();
    throw err;
  }

  return {
    conn: {
      ...conn,
      ...(transport === 'stdio' ? { args, env } : { url, headers }),
    },
    newlyCreatedKeys,
    restorables,
    movedCount,
    rollback,
  };
}

export function resolveTransportStrict(input, existing = null) {
  const hasTransport = input.transport !== undefined && input.transport !== null && String(input.transport).trim() !== '';
  const hasType = input.type !== undefined && input.type !== null && String(input.type).trim() !== '';
  if (hasTransport || hasType) {
    const mappedTransport = hasTransport
      ? TRANSPORT_ALIASES[String(input.transport).trim().toLowerCase()]
      : null;
    const mappedType = hasType
      ? TRANSPORT_ALIASES[String(input.type).trim().toLowerCase()]
      : null;
    if ((hasTransport && !mappedTransport) || (hasType && !mappedType)) {
      throw httpError('Transport must be "http", "sse", or "stdio".', 400);
    }
    if (mappedTransport && mappedType && mappedTransport !== mappedType) {
      throw httpError('Transport and type must match.', 400);
    }
    return mappedTransport || mappedType;
  }
  if (existing?.transport) return resolveTransportLoose(existing);
  const hasCommand = typeof input.command === 'string' && input.command.trim().length > 0;
  const hasUrl = typeof input.url === 'string' && input.url.trim().length > 0;
  return hasCommand && !hasUrl ? 'stdio' : 'http';
}

// Strict input type & character validation shared by admitConnectionWrite and pre-approval checks (G5-19).
export function validateConnectionInput(input, { existing = null } = {}) {
  if (!isPlainObject(input)) {
    throw httpError('Connection input must be an object.', 400);
  }
  if (input.oauth !== undefined) {
    throw httpError('OAuth settings are managed by Loop and cannot be supplied directly.', 400);
  }
  if (input.token !== undefined && input.token !== null && typeof input.token !== 'string') {
    throw httpError('Connection token must be a string.', 400);
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw httpError('enabled must be a boolean.', 400);
  }
  if (input.partnerSkillsEnabled !== undefined && typeof input.partnerSkillsEnabled !== 'boolean') {
    throw httpError('partnerSkillsEnabled must be a boolean.', 400);
  }
  if (input.name !== undefined && typeof input.name !== 'string') {
    throw httpError('Name must be a string.', 400);
  }
  if (input.description !== undefined && input.description !== null && typeof input.description !== 'string') {
    throw httpError('Description must be a string.', 400);
  }
  if (input.url !== undefined && input.url !== null && typeof input.url !== 'string') {
    throw httpError('URL must be a string.', 400);
  }
  if (input.command !== undefined && input.command !== null && typeof input.command !== 'string') {
    throw httpError('Command must be a string.', 400);
  }
  if (input.headers !== undefined) {
    if (!isPlainObject(input.headers)) {
      throw httpError('Headers must be a plain object.', 400);
    }
    for (const [k, v] of Object.entries(input.headers)) {
      if (typeof k !== 'string' || typeof v !== 'string') {
        throw httpError(`Header "${String(k)}" value must be a string.`, 400);
      }
      if (HEADER_CONTROL_RE.test(k) || HEADER_CONTROL_RE.test(v)) {
        throw httpError(
          `Header "${k.trim() || '(empty)'}" contains invalid CR/LF or NUL characters.`,
          400,
        );
      }
      if (FORBIDDEN_RECORD_KEYS.has(k.trim().toLowerCase())) {
        throw httpError(`Invalid header name "${k}".`, 400);
      }
    }
  }
  if (input.env !== undefined) {
    if (!isPlainObject(input.env)) {
      throw httpError('Environment variables must be a plain object.', 400);
    }
    for (const [k, v] of Object.entries(input.env)) {
      if (typeof k !== 'string' || typeof v !== 'string') {
        throw httpError(`Environment variable "${String(k)}" value must be a string.`, 400);
      }
      if (k.includes('\0') || v.includes('\0')) {
        throw httpError(`Environment variable "${k}" cannot contain NUL characters.`, 400);
      }
      if (FORBIDDEN_RECORD_KEYS.has(k.trim().toLowerCase())) {
        throw httpError(`Invalid environment variable name "${k}".`, 400);
      }
    }
  }
  if (input.args !== undefined) {
    if (!Array.isArray(input.args)) {
      throw httpError('Args must be an array of strings.', 400);
    }
    for (const item of input.args) {
      if (typeof item !== 'string') {
        throw httpError('Every entry in args must be a string.', 400);
      }
      if (item.includes('\0')) {
        throw httpError('Args cannot contain NUL characters.', 400);
      }
    }
  }
  if (input.cwd !== undefined && input.cwd !== null) {
    if (typeof input.cwd !== 'string') {
      throw httpError('Working directory (cwd) must be a string.', 400);
    }
    if (input.cwd.includes('\0')) {
      throw httpError('Working directory (cwd) cannot contain NUL characters.', 400);
    }
  }
  for (const field of ['allowedTools', 'disabledTools', 'pinnedTools']) {
    if (input[field] !== undefined && input[field] !== null) {
      if (!Array.isArray(input[field])) {
        throw httpError(`${field} must be an array of strings.`, 400);
      }
      for (const item of input[field]) {
        if (typeof item !== 'string') {
          throw httpError(`Every entry in ${field} must be a string.`, 400);
        }
      }
    }
  }
  if (!existing && input.id !== undefined && input.id !== null && input.id !== '') {
    if (typeof input.id !== 'string' || !isValidConnectionId(input.id.trim())) {
      throw httpError(
        'Connection id must contain only lowercase letters, numbers, and single underscores (cannot be "loop" or "loop_host").',
        400,
      );
    }
  }
}

function assertLiteralOrigin(rawUrl) {
  const text = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!text) {
    throw httpError('Enter a valid http(s) URL.', 400);
  }
  const norm = normalizeVaultPlaceholdersInUrl(text);
  const schemeIdx = norm.indexOf('://');
  if (schemeIdx === -1) {
    throw httpError('Enter a valid http(s) URL.', 400);
  }
  const scheme = norm.slice(0, schemeIdx);
  if (scheme.includes('{{vault:')) {
    throw httpError('Vault placeholders cannot be used in the connection URL scheme or host.', 400);
  }
  const afterScheme = norm.slice(schemeIdx + 3);
  const pathStart = afterScheme.search(/[/?#]/);
  const authority = pathStart === -1 ? afterScheme : afterScheme.slice(0, pathStart);
  const atIdx = authority.lastIndexOf('@');
  const hostPart = atIdx === -1 ? authority : authority.slice(atIdx + 1);
  if (hostPart.includes('{{vault:')) {
    throw httpError('Vault placeholders cannot be used in the connection URL scheme or host.', 400);
  }

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw httpError('Enter a valid http(s) URL.', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw httpError('URL must use http or https.', 400);
  }
  if (hasVaultPlaceholder(parsed.host)) {
    throw httpError('Vault placeholders cannot be used in the connection URL scheme or host.', 400);
  }
  return parsed;
}

async function deleteOAuthVaultKeys(vault, id, conn = null) {
  if (!vault || typeof vault.delete !== 'function') return;
  const keys = new Set([
    `__oauth_access_${id}`,
    `__oauth_refresh_${id}`,
    `__oauth_client_secret_${id}`,
  ]);
  if (conn?.oauth && typeof conn.oauth === 'object') {
    for (const k of [
      conn.oauth.accessTokenVaultKey,
      conn.oauth.refreshTokenVaultKey,
      conn.oauth.clientSecretVaultKey,
    ]) {
      if (typeof k === 'string' && k) keys.add(k);
    }
  }
  for (const key of keys) {
    await vault.delete(key).catch(() => {});
  }
}

// Every check of a write, before Loop saves anything: throws the refusal, or tells what the write does.
// `needsOwner`: it starts a local command or moves an address, so an agent asks the owner first.
export async function checkConnectionWrite({
  actor = { kind: 'owner' },
  policy = null,
  existing = null,
  input = {},
  allowVaultRefs = true,
  vault,
} = {}) {
  // Step 1: Reject forbidden fields & validate actor/profile/policy BEFORE touching Vault.
  validateConnectionInput(input, { existing });
  const requestedId =
    !existing && typeof input.id === 'string' && input.id.trim() ? input.id.trim() : null;

  const isAgent = actor?.kind === 'agent';
  const actorProfile = isAgent ? normalizeProfileTag(actor.profile) : '';
  const ownerOnly = isAgent ? OWNER_ONLY_FIELDS.find((field) => input[field] !== undefined) : null;
  if (ownerOnly) throw httpError(`Only the Loop owner can set "${ownerOnly}", in the Loop dashboard.`, 403);

  if (isAgent && actorProfile && actorProfile !== 'all') {
    if (existing) {
      const existingProfiles = normalizeConnectionProfiles(existing.profiles);
      if (!existingProfiles.includes(actorProfile)) {
        throw httpError(
          `This agent is limited to the "${actorProfile}" profile and cannot modify this connection.`,
          403,
        );
      }
    }
  }

  // Merge allowed fields into effective next state.
  const patch = {};
  for (const field of ALLOWED_WRITE_FIELDS) {
    if (input[field] !== undefined) patch[field] = input[field];
  }

  const transport = resolveTransportStrict(patch, existing);
  const next = {
    ...(existing || {}),
    ...patch,
    transport,
  };

  // Validate profile scope for agent writes.
  if (isAgent && actorProfile && actorProfile !== 'all') {
    if (!existing && patch.profiles === undefined) {
      patch.profiles = [actorProfile];
      next.profiles = normalizeConnectionProfiles([actorProfile]);
    } else {
      const nextProfiles = normalizeConnectionProfiles(next.profiles);
      if (!nextProfiles.includes(actorProfile)) {
        throw httpError(
          `This agent is limited to the "${actorProfile}" profile and cannot move a connection out of it.`,
          403,
        );
      }
    }
  }

  // Validate required name before touching Vault.
  const effectiveName = String(next.name ?? '').trim();
  if (!effectiveName) {
    throw httpError('Name is required.', 400);
  }
  next.name = effectiveName;

  // Provenance: who wrote the name decides whether other agents see it in their startup
  // context (lib/context-names.mjs). A new name from an agent waits for the owner's approval,
  // unless the owner already approved this exact write (actor.ownerApproved).
  if (!existing || String(existing.name || '').trim() !== effectiveName) {
    patch.addedBy = addedByFor(actor, { approved: actor?.ownerApproved === true });
  }

  if (transport === 'builtin') {
    next.url = null;
    next.headers = {};
    next.command = null;
    next.args = [];
    next.env = {};
    next.cwd = null;
  } else if (transport === 'stdio') {
    next.url = null;
    next.headers = {};
    next.command = typeof next.command === 'string' ? next.command.trim() : '';
    next.args = Array.isArray(next.args) ? [...next.args] : [];
    next.env = isPlainObject(next.env) ? next.env : {};
    next.cwd = typeof next.cwd === 'string' && next.cwd.trim() ? next.cwd.trim() : null;
  } else {
    next.command = null;
    next.args = [];
    next.env = {};
    next.cwd = null;
    next.headers = isPlainObject(next.headers) ? next.headers : {};
  }

  // Enforce personal workspace policy before touching Vault.
  if (policy?.personal) {
    const { token: _token, ...inputWithoutToken } = input;
    const personalInput =
      !existing && inputWithoutToken.transport === undefined && inputWithoutToken.type === undefined
        ? { ...inputWithoutToken, transport }
        : inputWithoutToken;
    try {
      assertPersonalEdit(existing, personalInput, { selfIdentity: policy.selfIdentity || null });
    } catch (err) {
      throw err?.status ? err : httpError(err?.message || 'Unsupported personal MCP connection.', 400);
    }
  }

  if (transport === 'builtin') {
    // Built-in connections do not require a URL or local command.
  } else if (transport !== 'stdio') {
    assertLiteralOrigin(next.url);
    if (policy && typeof policy.assertConnectionUrl === 'function') {
      try {
        policy.assertConnectionUrl(next.url);
      } catch (err) {
        throw err?.status ? err : httpError(err?.message || 'Connection URL is not allowed.', 400);
      }
    }
  } else {
    if (policy?.personal) {
      throw httpError('Personal workspaces allow only remote HTTPS connections.', 400);
    }
    if (!next.command) {
      throw httpError('Command is required for stdio transport.', 400);
    }
    if (policy?.selfIdentity?.isSelfStdio(next.command, next.args)) {
      throw httpError('Loop cannot connect to itself.', 400);
    }
  }

  // Step 2: Vault ref authorization & sink integrity.
  const inputRefs = findAllInputRefs(input);
  const effectiveRefs = [
    ...new Set([...connectionSecretKeys(next), ...findConnectionRefs(next)]),
  ];

  if (
    hasInternalSecretRefs(input) ||
    inputRefs.some(isInternalVaultKey) ||
    effectiveRefs.some(isInternalVaultKey)
  ) {
    throw httpError('Connections cannot reference internal Loop secrets.', 400);
  }

  if (!allowVaultRefs && inputRefs.length > 0) {
    throw httpError('Imported configs cannot reference existing Vault secrets.', 400);
  }

  const sinkChanged = Boolean(existing && !sinksEqual(existing, next));

  if (isAgent) {
    const granted = new Set(Array.isArray(actor.secrets) ? actor.secrets : []);
    const isRefAllowed = async (k) => {
      if (!granted.has(k)) return false;
      if (actorProfile && actorProfile !== 'all' && vault && typeof vault.getMeta === 'function') {
        const meta = await vault.getMeta(k).catch(() => null);
        if (!meta || !itemMatchesProfile(meta, actorProfile)) return false;
      }
      return true;
    };
    const notSharedInput = [];
    for (const k of inputRefs) {
      if (!(await isRefAllowed(k))) notSharedInput.push(k);
    }
    if (notSharedInput.length > 0) {
      throw httpError(
        `These secrets have not been shared with this agent: ${notSharedInput.join(', ')}.`,
        403,
        { code: 'SECRET_NOT_SHARED', keys: notSharedInput },
      );
    }

    if (sinkChanged) {
      const notSharedEffective = [];
      for (const k of effectiveRefs) {
        if (!(await isRefAllowed(k))) notSharedEffective.push(k);
      }
      if (notSharedEffective.length > 0) {
        throw httpError(
          `Cannot change this connection's destination because it uses secrets not shared with this agent: ${notSharedEffective.join(', ')}.`,
          403,
          { code: 'SECRET_NOT_SHARED', keys: notSharedEffective },
        );
      }
      if (existing.oauth) {
        throw httpError(
          'Cannot change the address of a signed-in connection. Only the Loop owner can change or remove it.',
          403,
        );
      }
    }
  }

  const needsOwner = isAgent && (sinkChanged || (transport === 'stdio' && (!existing || patch.env !== undefined)));
  return { patch, next, transport, requestedId, sinkChanged, needsOwner };
}

export async function admitConnectionWrite({
  actor = { kind: 'owner' },
  policy = null,
  existing = null,
  input = {},
  allowVaultRefs = true,
  ownerAsked = null, // false: the owner did not say yes to this write
  store,
  vault,
} = {}) {
  const { patch, next, transport, requestedId, sinkChanged, needsOwner } = await checkConnectionWrite({
    actor,
    policy,
    existing,
    input,
    allowVaultRefs,
    vault,
  });
  if (needsOwner && ownerAsked === false) {
    throw httpError('Nothing was saved: this change needs the approval of the owner. Send the same call again.', 403, {
      code: 'OWNER_NOT_ASKED',
    });
  }

  // Step 3: Owner OAuth origin change cleanup.
  const shouldClearOAuth = Boolean(
    existing && existing.oauth && sinkChanged && actor?.kind === 'owner' && !policy?.personal,
  );

  // Step 4: Extract plaintext secrets into Vault + transactional commit/rollback.
  const explicitToken =
    typeof input.token === 'string' && input.token.trim() ? input.token : null;
  const switchedTransport = Boolean(existing && resolveTransportLoose(existing) !== transport);
  const targetSink = sinkKey(next);

  let extracted;
  if (!existing) {
    extracted = await extractConnectionSecrets(next, vault, {
      connName: next.name,
      connId: requestedId,
      explicitToken,
      existing: null,
      targetSink,
    });
  } else {
    // Only extract from fields touched by this update (plus existing.headers when rotating token).
    const toExtract = {
      name: next.name,
      transport,
      profiles: next.profiles,
      url: patch.url !== undefined || switchedTransport ? next.url : null,
      headers:
        patch.headers !== undefined || explicitToken !== null || switchedTransport
          ? next.headers
          : {},
      command: next.command,
      cwd: next.cwd,
      env: patch.env !== undefined || switchedTransport ? next.env : {},
      args: patch.args !== undefined || switchedTransport ? next.args : [],
    };
    extracted = await extractConnectionSecrets(toExtract, vault, {
      connName: next.name,
      connId: existing.id,
      explicitToken,
      existing,
      targetSink,
    });
  }

  let entry;
  try {
    if (!existing) {
      const createPayload = { ...patch, transport };
      delete createPayload.type;
      if (requestedId) createPayload.id = requestedId;
      if (transport === 'builtin') {
        // No url/headers/command/args/env for built-in connections.
      } else if (transport === 'stdio') {
        createPayload.command = next.command;
        createPayload.args = extracted.conn.args;
        createPayload.env = extracted.conn.env;
        if (next.cwd !== null) createPayload.cwd = next.cwd;
      } else {
        createPayload.url = extracted.conn.url;
        createPayload.headers = extracted.conn.headers;
      }
      entry = await store.add(createPayload);
      if (requestedId && entry && entry.id !== requestedId && typeof store.transaction === 'function') {
        const addedId = entry.id;
        const tx = await store.transaction((cfg) => {
          if (cfg.mcps.some((m) => m.id === requestedId)) {
            cfg.mcps = cfg.mcps.filter((m) => m.id !== addedId);
            return { conflict: true, entry: null };
          }
          const target = cfg.mcps.find((m) => m.id === addedId);
          if (!target) return { conflict: false, entry };
          target.id = requestedId;
          return { conflict: false, entry: structuredClone(target) };
        });
        if (tx.conflict) {
          throw httpError(`Connection "${requestedId}" already exists.`, 409);
        }
        entry = tx.entry;
      }
    } else {
      const updatePatch = { ...patch };
      delete updatePatch.type;
      if (patch.transport !== undefined || patch.type !== undefined) {
        updatePatch.transport = transport;
      }
      if (transport === 'builtin') {
        // Built-in connections have no URL/headers/command fields to update.
      } else if (transport === 'stdio') {
        if (patch.env !== undefined || switchedTransport) updatePatch.env = extracted.conn.env;
        if (patch.args !== undefined || switchedTransport) updatePatch.args = extracted.conn.args;
      } else {
        if (patch.url !== undefined || switchedTransport) updatePatch.url = extracted.conn.url;
        if (patch.headers !== undefined || explicitToken !== null || switchedTransport) {
          updatePatch.headers = extracted.conn.headers;
        }
      }
      if (shouldClearOAuth) {
        updatePatch.oauth = null;
        updatePatch.authRequired = false;
      }
      entry = await store.update(existing.id, updatePatch);
      if (!entry) {
        throw httpError('Connection not found.', 404);
      }
    }
  } catch (err) {
    await extracted.rollback();
    throw err;
  }

  if (shouldClearOAuth && vault) {
    await deleteOAuthVaultKeys(vault, existing.id, existing);
  }

  return {
    entry,
    movedCount: extracted.movedCount,
    newlyCreatedKeys: extracted.newlyCreatedKeys,
    oauthCleared: shouldClearOAuth,
  };
}

export async function deleteConnection({
  id,
  store,
  vault,
  pool = null,
  policyStore = null,
  catStore = null,
} = {}) {
  const existing = await store.get(id);
  if (!existing) return false;

  await pool?.invalidate?.(id);
  await deleteOAuthVaultKeys(vault, id, existing);

  if (vault) {
    const tokenKey = `conn_${id}_token`;
    const allConns = await store.list();
    const usedElsewhere = allConns.some(
      (conn) => conn.id !== id && findConnectionRefs(conn).includes(tokenKey),
    );
    if (!usedElsewhere) {
      const exists = vault.getMeta ? Boolean(await vault.getMeta(tokenKey).catch(() => null)) : true;
      if (exists) {
        await vault.delete(tokenKey).catch(() => {});
      }
    }
  }

  await store.remove(id);
  await policyStore?.deleteConnection?.(id);
  await catStore?.removeConnection?.(id);
  return true;
}
