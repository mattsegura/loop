// Agents refer to Vault secrets by name as {{vault:KEY}} inside tool arguments.
// Loop swaps in the real value just before calling the upstream tool and masks
// any copy of it in what comes back, so agents never see secret values.

export const VAULT_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
export const PLACEHOLDER_RE = /\{\{vault:([A-Za-z0-9_.-]{1,100})\}\}/g;
export const MASK = '••••';

export function isInternalVaultKey(key) {
  return typeof key === 'string' && key.startsWith('__');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function setOwnProp(obj, key, val) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    Object.defineProperty(obj, key, {
      value: val,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return;
  }
  obj[key] = val;
}

function createPlaceholderRegex() {
  return new RegExp(PLACEHOLDER_RE.source, 'g');
}

export function findSecretRefs(value) {
  const keys = new Set();
  const seen = new WeakSet();
  const scanString = (str) => {
    if (!str.includes('{{vault:')) return;
    for (const m of str.matchAll(createPlaceholderRegex())) {
      keys.add(m[1]);
    }
  };
  const visit = (node) => {
    if (typeof node === 'string') {
      scanString(node);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node instanceof Error) {
      if (typeof node.message === 'string') scanString(node.message);
    }
    for (const [k, v] of Object.entries(node)) {
      scanString(k);
      visit(v);
    }
  };

  visit(value);
  return [...keys];
}

export function hasInternalSecretRefs(value) {
  return findSecretRefs(value).some(isInternalVaultKey);
}

export function fillSecretRefs(value, values) {
  if (!values || typeof values.has !== 'function') return value;
  const seen = new WeakMap();
  const replaceString = (str) => {
    if (!str.includes('{{vault:')) return str;
    return str.replace(createPlaceholderRegex(), (match, key) => {
      if (isInternalVaultKey(key) || !values.has(key)) return match;
      const replacement = values.get(key);
      return replacement !== null && replacement !== undefined ? String(replacement) : match;
    });
  };
  const visit = (node) => {
    if (typeof node === 'string') return replaceString(node);
    if (!node || typeof node !== 'object') return node;
    if (seen.has(node)) return seen.get(node);

    if (Array.isArray(node)) {
      const out = [];
      seen.set(node, out);
      for (const item of node) out.push(visit(item));
      return out;
    }
    if (isPlainObject(node)) {
      const out = Object.getPrototypeOf(node) === null ? Object.create(null) : {};
      seen.set(node, out);
      for (const [k, v] of Object.entries(node)) {
        setOwnProp(out, k, visit(v));
      }
      return out;
    }
    return node;
  };

  return visit(value);
}

export function expandSecretVariants(secret) {
  if (typeof secret !== 'string' || secret.length < 4) return [];

  const variants = new Set();
  const add = (candidate) => {
    if (typeof candidate === 'string' && candidate.length >= 4) {
      variants.add(candidate);
    }
  };

  // 1. Raw secret
  add(secret);

  // 2. JSON string interior (\n, \r, \t, \", \\, control escapes)
  const jsonInner = JSON.stringify(secret).slice(1, -1);
  add(jsonInner);

  // 3. PHP/HTML slash-escaped JSON
  add(jsonInner.replace(/\//g, '\\/'));

  // 4. Python ensure_ascii JSON (lowercase & uppercase \uXXXX), normal and slash-escaped
  const pyJsonLower = jsonInner.replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  const pyJsonUpper = jsonInner.replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
  );
  add(pyJsonLower);
  add(pyJsonUpper);
  add(pyJsonLower.replace(/\//g, '\\/'));
  add(pyJsonUpper.replace(/\//g, '\\/'));

  // 5. Double-JSON-escaped (JSON embedded in JSON error messages)
  add(JSON.stringify(jsonInner).slice(1, -1));

  // 6. URL percent-encoded (uppercase & lowercase hex, plus %20 -> + form encoding)
  try {
    const enc = encodeURIComponent(secret);
    const encLower = enc.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    add(enc);
    add(encLower);
    if (enc.includes('%20')) {
      add(enc.replace(/%20/g, '+'));
      add(encLower.replace(/%20/g, '+'));
    }
  } catch {
    // Gracefully skip URL encoding for strings with lone UTF-16 surrogates.
  }

  // 7. Base64 and Base64url (for secrets >= 6 chars to limit false positives)
  if (secret.length >= 6) {
    const buf = Buffer.from(secret, 'utf8');
    add(buf.toString('base64'));
    add(buf.toString('base64url'));
  }

  return [...variants];
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createRedactor(secretValues) {
  const rawSecrets = new Set();
  const shortSecrets = new Set();
  if (
    secretValues &&
    typeof secretValues !== 'string' &&
    typeof secretValues[Symbol.iterator] === 'function'
  ) {
    for (const v of secretValues) {
      if (typeof v !== 'string') continue;
      if (v.length >= 4) {
        rawSecrets.add(v);
      } else if (v.length >= 1) {
        shortSecrets.add(v);
      }
    }
  }

  const allVariants = new Set();
  for (const s of rawSecrets) {
    for (const variant of expandSecretVariants(s)) {
      allVariants.add(variant);
    }
  }

  const needles = [...allVariants].sort((a, b) => b.length - a.length);
  const shortNeedles = [...shortSecrets].sort((a, b) => b.length - a.length);
  const shortNeedleSet = new Set(shortNeedles);

  const shortTokens = new Set();
  for (const s of shortNeedles) {
    shortTokens.add(s);
    const jsonInner = JSON.stringify(s).slice(1, -1);
    if (jsonInner && jsonInner !== s) {
      shortTokens.add(jsonInner);
    }
    const phpInner = jsonInner.replace(/\//g, '\\/');
    if (phpInner && phpInner !== jsonInner && phpInner !== s) {
      shortTokens.add(phpInner);
    }
    try {
      const enc = encodeURIComponent(s);
      if (enc && enc !== s) {
        shortTokens.add(enc);
        const encLower = enc.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
        if (encLower !== enc) shortTokens.add(encLower);
        if (enc.includes('%20')) {
          shortTokens.add(enc.replace(/%20/g, '+'));
          shortTokens.add(encLower.replace(/%20/g, '+'));
        }
      }
    } catch {
      // Gracefully skip URL encoding for strings with lone UTF-16 surrogates.
    }
  }

  const shortMatchers = [...shortTokens]
    .sort((a, b) => b.length - a.length)
    .map((token) => ({
      token,
      re: new RegExp(`(?<![A-Za-z0-9])${escapeRegex(token)}(?![A-Za-z0-9])`, 'g'),
    }));

  const hasSecrets = needles.length > 0 || shortNeedles.length > 0;

  const rawSecretList = [...rawSecrets];
  const redactBase64Tokens = (str) => {
    if (rawSecretList.length === 0 || str.length < 8) return str;
    return str.replace(/[A-Za-z0-9+/_-]{8,4096}={0,2}/g, (token) => {
      if (token.length < 8) return token;
      const tryDecode = (encoding) => {
        try {
          const buf = Buffer.from(token, encoding);
          if (buf.length < 4) return null;
          return buf.toString('utf8');
        } catch {
          return null;
        }
      };
      const decodedStd = tryDecode('base64');
      if (decodedStd) {
        for (const s of rawSecretList) {
          if (decodedStd.includes(s)) return MASK;
        }
      }
      if (token.includes('-') || token.includes('_')) {
        const decodedUrl = tryDecode('base64url');
        if (decodedUrl) {
          for (const s of rawSecretList) {
            if (decodedUrl.includes(s)) return MASK;
          }
        }
      }
      return token;
    });
  };

  const redactString = (str) => {
    let out = str;
    for (const needle of needles) {
      if (out.includes(needle)) out = out.split(needle).join(MASK);
    }
    if (rawSecretList.length > 0) {
      out = redactBase64Tokens(out);
    }
    if (shortNeedles.length > 0) {
      if (shortNeedleSet.has(out) || shortNeedleSet.has(out.trim())) {
        return MASK;
      }
      for (const { token, re } of shortMatchers) {
        if (out.includes(token)) {
          out = out.replace(re, MASK);
        }
      }
    }
    return out;
  };

  const redact = (value) => {
    if (!hasSecrets) return value;
    const seen = new WeakMap();

    const visit = (node) => {
      if (typeof node === 'string') return redactString(node);
      if (typeof node === 'number') {
        if (shortNeedleSet.size > 0 && Number.isFinite(node) && shortNeedleSet.has(String(node))) {
          return MASK;
        }
        return node;
      }
      if (!node || typeof node !== 'object') return node;
      if (seen.has(node)) return seen.get(node);

      if (Array.isArray(node)) {
        const out = [];
        seen.set(node, out);
        for (const item of node) out.push(visit(item));
        return out;
      }

      if (node instanceof Error) {
        const out = new Error(redactString(String(node.message ?? '')));
        out.name = typeof node.name === 'string' ? redactString(node.name) : 'Error';
        seen.set(node, out);
        if (typeof node.stack === 'string') {
          out.stack = redactString(node.stack);
        }
        if (node.cause !== undefined) {
          out.cause = visit(node.cause);
        }
        for (const [k, v] of Object.entries(node)) {
          setOwnProp(out, redactString(k), visit(v));
        }
        return out;
      }

      if (isPlainObject(node)) {
        const out = Object.getPrototypeOf(node) === null ? Object.create(null) : {};
        seen.set(node, out);
        for (const [k, v] of Object.entries(node)) {
          const maskedKey = redactString(k);
          const maskedVal = visit(v);
          setOwnProp(out, maskedKey, maskedVal);
        }
        return out;
      }

      return node;
    };

    return visit(value);
  };

  return { redact, hasSecrets };
}

// Masks every occurrence of each secret value (and wire-encoding variants) anywhere in `value`.
export function maskSecrets(value, secretValues) {
  return createRedactor(secretValues).redact(value);
}

// Vault keys a connection's own config refers to (headers, env, args, URL).
export function connectionSecretKeys(conn) {
  return findSecretRefs({
    url: conn?.url || '',
    headers: conn?.headers || {},
    env: conn?.env || {},
    args: conn?.args || [],
  });
}

export async function readSecrets(vault, keys, { allowInternal = false } = {}) {
  const values = new Map();
  if (!vault || !keys) return values;
  for (const key of keys) {
    if (typeof key !== 'string' || !key) continue;
    if (!allowInternal && isInternalVaultKey(key)) continue;
    if (values.has(key)) continue;
    const v = await vault.get(key).catch(() => null);
    if (v !== null && v !== undefined) values.set(key, v);
  }
  return values;
}
