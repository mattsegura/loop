// Discover MCP server configurations from every agent installed on this machine
// (Claude Code, Claude Desktop, Codex, Cursor, Antigravity, Gemini CLI, VS Code,
// OpenCode, Windsurf, Zed) and import them into Loop with secrets moved to the Vault.

import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  copyFile,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentTokenIn } from './agents.mjs';
import { JSON_SERVER_KEY_MAP } from './agents/manifest.mjs';
import {
  admitConnectionWrite,
  extractUrlSecrets,
  isSecretEnv,
  isSecretHeader,
  secretArgs,
} from './connection-admission.mjs';
import { createWriteQueue } from './json-file-store.mjs';
import { buildSelfIdentity, createOutboundPolicy, suggestNameFromHost } from './outbound-policy.mjs';
import { assertPersonalHeaders } from './personal-upstreams.mjs';
import { findSecretRefs } from './secret-refs.mjs';

export { extractUrlSecrets, isSecretEnv, isSecretHeader, secretArgs };

/* ---------------- JSONC (comments + trailing commas) ---------------- */

function stripUtf8Bom(text) {
  const s = String(text ?? '');
  return s.startsWith('\uFEFF') ? s.slice(1) : s;
}

export function parseJsonc(text) {
  const src = stripUtf8Bom(text);
  let out = '';
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
    } else if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  // Remove trailing commas (outside strings) before a closing bracket.
  let cleaned = '';
  inString = false;
  for (let j = 0; j < out.length; j += 1) {
    const ch = out[j];
    if (inString) {
      cleaned += ch;
      if (ch === '\\') {
        cleaned += out[j + 1] ?? '';
        j += 1;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }
    if (ch === ',') {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k += 1;
      if (out[k] === '}' || out[k] === ']') continue;
    }
    cleaned += ch;
  }
  return JSON.parse(cleaned);
}

/* ---------------- TOML 1.0 parser (G6-23) ---------------- */

const FORBIDDEN_TOML_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TOML_BASIC_ESCAPES = Object.freeze({
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
});

const TOML_HEX_INT_RE = /^0x[0-9a-fA-F](?:_?[0-9a-fA-F])*$/;
const TOML_OCT_INT_RE = /^0o[0-7](?:_?[0-7])*$/;
const TOML_BIN_INT_RE = /^0b[01](?:_?[01])*$/;
const TOML_DEC_NUM_RE = /^[+-]?\d(?:_?\d)*(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/;
const TOML_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOML_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;
const TOML_LOCAL_TIME_RE = /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

class TomlUnsupportedValueError extends Error {
  constructor(message) {
    super(message);
    this.degradable = true;
  }
}

function toPlainTomlValue(value) {
  if (Array.isArray(value)) return value.map(toPlainTomlValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_TOML_KEYS.has(k)) continue;
      out[k] = toPlainTomlValue(v);
    }
    return out;
  }
  return value;
}

export function parseTomlLite(text, { strict = false } = {}) {
  const src = stripUtf8Bom(text);
  const root = Object.create(null);
  let pos = 0;
  let current = root;

  const fail = (msg) => {
    const line = src.slice(0, pos).split('\n').length;
    throw new Error(`TOML parse error on line ${line}: ${msg}`);
  };
  const failUnsupported = (msg) => {
    const line = src.slice(0, pos).split('\n').length;
    throw new TomlUnsupportedValueError(`TOML parse error on line ${line}: ${msg}`);
  };
  const assertSafeKey = (key) => {
    if (FORBIDDEN_TOML_KEYS.has(key)) fail(`Forbidden key name "${key}"`);
  };
  const peek = (n = 0) => src[pos + n];
  const skipWs = () => {
    while (pos < src.length && (src[pos] === ' ' || src[pos] === '\t')) pos += 1;
  };
  const skipComment = () => {
    if (peek() === '#') while (pos < src.length && src[pos] !== '\n') pos += 1;
  };
  const skipWsNl = () => {
    for (;;) {
      skipWs();
      skipComment();
      if (peek() === '\n' || peek() === '\r') pos += 1;
      else break;
    }
  };
  const skipToEol = () => {
    while (pos < src.length && src[pos] !== '\n' && src[pos] !== '\r') pos += 1;
  };

  function decodeTomlEscape() {
    const esc = src[pos + 1];
    if (esc !== undefined && Object.hasOwn(TOML_BASIC_ESCAPES, esc)) {
      pos += 2;
      return TOML_BASIC_ESCAPES[esc];
    }
    if (esc === 'u' || esc === 'U') {
      const len = esc === 'u' ? 4 : 8;
      const hex = src.slice(pos + 2, pos + 2 + len);
      if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) {
        fail(`bad unicode escape \\${esc}${hex}`);
      }
      const cp = parseInt(hex, 16);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        fail(`invalid unicode scalar value \\${esc}${hex}`);
      }
      pos += 2 + len;
      return String.fromCodePoint(cp);
    }
    return fail(`bad escape \\${esc}`);
  }

  function parseBasicString() {
    pos += 1;
    let out = '';
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === '"') {
        pos += 1;
        return out;
      }
      if (ch === '\n' || ch === '\r') fail('newline in string');
      if (ch === '\\') {
        out += decodeTomlEscape();
        continue;
      }
      out += ch;
      pos += 1;
    }
    return fail('unterminated string');
  }

  function parseMultilineBasicString() {
    pos += 3;
    if (src[pos] === '\r' && src[pos + 1] === '\n') pos += 2;
    else if (src[pos] === '\n') pos += 1;

    let out = '';
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === '\\') {
        // TOML line-ending backslash trims optional spaces/tabs, newline, and subsequent whitespace.
        let look = pos + 1;
        while (look < src.length && (src[look] === ' ' || src[look] === '\t')) look += 1;
        if (src[look] === '\r' || src[look] === '\n') {
          pos = look;
          while (
            pos < src.length &&
            (src[pos] === ' ' || src[pos] === '\t' || src[pos] === '\r' || src[pos] === '\n')
          ) {
            pos += 1;
          }
          continue;
        }
        out += decodeTomlEscape();
        continue;
      }
      if (ch === '"') {
        let qCount = 0;
        while (src[pos + qCount] === '"') qCount += 1;
        if (qCount < 3) {
          out += '"'.repeat(qCount);
          pos += qCount;
          continue;
        }
        if (qCount <= 5) {
          out += '"'.repeat(qCount - 3);
          pos += qCount;
          return out;
        }
        fail('too many consecutive quotes in multi-line basic string');
      }
      out += ch;
      pos += 1;
    }
    return fail('unterminated multi-line string');
  }

  function parseMultilineLiteralString() {
    pos += 3;
    if (src[pos] === '\r' && src[pos + 1] === '\n') pos += 2;
    else if (src[pos] === '\n') pos += 1;

    let out = '';
    while (pos < src.length) {
      if (src[pos] === "'") {
        let qCount = 0;
        while (src[pos + qCount] === "'") qCount += 1;
        if (qCount < 3) {
          out += "'".repeat(qCount);
          pos += qCount;
          continue;
        }
        if (qCount <= 5) {
          out += "'".repeat(qCount - 3);
          pos += qCount;
          return out;
        }
        fail('too many consecutive quotes in multi-line literal string');
      }
      out += src[pos];
      pos += 1;
    }
    return fail('unterminated multi-line string');
  }

  function parseLiteralString() {
    pos += 1;
    const end = src.indexOf("'", pos);
    if (end === -1) fail('unterminated literal string');
    const out = src.slice(pos, end);
    if (out.includes('\n') || out.includes('\r')) fail('newline in literal string');
    pos = end + 1;
    return out;
  }

  function parseKeySegment() {
    skipWs();
    if (peek() === '"') return parseBasicString();
    if (peek() === "'") return parseLiteralString();
    const start = pos;
    while (pos < src.length && /[A-Za-z0-9_-]/.test(src[pos])) pos += 1;
    if (pos === start) fail('expected a key');
    return src.slice(start, pos);
  }

  function parseKeyPath() {
    const parts = [parseKeySegment()];
    skipWs();
    while (peek() === '.') {
      pos += 1;
      parts.push(parseKeySegment());
      skipWs();
    }
    return parts;
  }

  function parseValue() {
    skipWs();
    const ch = peek();
    if (ch === '"') return src.startsWith('"""', pos) ? parseMultilineBasicString() : parseBasicString();
    if (ch === "'") return src.startsWith("'''", pos) ? parseMultilineLiteralString() : parseLiteralString();
    if (ch === '[') {
      pos += 1;
      const arr = [];
      for (;;) {
        skipWsNl();
        if (peek() === ']') {
          pos += 1;
          return arr;
        }
        arr.push(parseValue());
        skipWsNl();
        if (peek() === ',') pos += 1;
        else if (peek() === ']') {
          pos += 1;
          return arr;
        } else fail('expected , or ] in array');
      }
    }
    if (ch === '{') {
      pos += 1;
      const obj = Object.create(null);
      skipWsNl();
      if (peek() === '}') {
        pos += 1;
        return obj;
      }
      for (;;) {
        skipWsNl();
        if (peek() === '}') {
          pos += 1;
          return obj;
        }
        const keys = parseKeyPath();
        skipWs();
        if (peek() !== '=') fail('expected = in inline table');
        pos += 1;
        setPath(obj, keys, parseValue());
        skipWsNl();
        if (peek() === ',') {
          pos += 1;
          continue;
        }
        if (peek() === '}') {
          pos += 1;
          return obj;
        }
        fail('expected , or } in inline table');
      }
    }
    const start = pos;
    while (pos < src.length && !/[\s,\]}#]/.test(src[pos])) pos += 1;
    let word = src.slice(start, pos);
    if (!word) fail('expected a value');

    // TOML 1.0 allows a single space separator between date and time in datetimes.
    if (
      TOML_DATE_ONLY_RE.test(word) &&
      src[pos] === ' ' &&
      /^\d{2}:\d{2}/.test(src.slice(pos + 1, pos + 6))
    ) {
      const timeStart = pos + 1;
      let tPos = timeStart;
      while (tPos < src.length && !/[\s,\]}#]/.test(src[tPos])) tPos += 1;
      const combined = `${word} ${src.slice(timeStart, tPos)}`;
      if (TOML_DATETIME_RE.test(combined)) {
        pos = tPos;
        return combined;
      }
    }

    if (word === 'true') return true;
    if (word === 'false') return false;
    if (TOML_HEX_INT_RE.test(word)) return parseInt(word.slice(2).replace(/_/g, ''), 16);
    if (TOML_OCT_INT_RE.test(word)) return parseInt(word.slice(2).replace(/_/g, ''), 8);
    if (TOML_BIN_INT_RE.test(word)) return parseInt(word.slice(2).replace(/_/g, ''), 2);
    if (TOML_DEC_NUM_RE.test(word)) return Number(word.replace(/_/g, ''));
    if (TOML_DATETIME_RE.test(word) || TOML_LOCAL_TIME_RE.test(word)) return word;
    if (word === 'inf' || word === '+inf') return Infinity;
    if (word === '-inf') return -Infinity;
    if (word === 'nan' || word === '+nan' || word === '-nan') return NaN;
    return failUnsupported(`unsupported value "${word}"`);
  }

  function setPath(obj, keys, value) {
    for (const k of keys) assertSafeKey(k);
    let target = obj;
    for (const k of keys.slice(0, -1)) {
      if (!Object.hasOwn(target, k)) target[k] = Object.create(null);
      if (typeof target[k] !== 'object' || target[k] === null || Array.isArray(target[k])) {
        fail(`key "${k}" is not a table`);
      }
      target = target[k];
    }
    target[keys[keys.length - 1]] = value;
  }

  function tableAt(keys, isArray) {
    for (const k of keys) assertSafeKey(k);
    let target = root;
    keys.forEach((k, idx) => {
      const last = idx === keys.length - 1;
      if (last && isArray) {
        if (!Array.isArray(target[k])) target[k] = [];
        const next = Object.create(null);
        target[k].push(next);
        target = next;
        return;
      }
      if (!Object.hasOwn(target, k)) target[k] = Object.create(null);
      if (typeof target[k] !== 'object' || target[k] === null) fail(`key "${k}" is not a table`);
      if (Array.isArray(target[k])) target = target[k][target[k].length - 1];
      else target = target[k];
    });
    return target;
  }

  while (pos < src.length) {
    skipWsNl();
    if (pos >= src.length) break;
    if (peek() === '[') {
      const isArray = peek(1) === '[';
      pos += isArray ? 2 : 1;
      const keys = parseKeyPath();
      skipWs();
      if (isArray ? !src.startsWith(']]', pos) : peek() !== ']') fail('expected ]');
      pos += isArray ? 2 : 1;
      current = tableAt(keys, isArray);
    } else {
      const keys = parseKeyPath();
      for (const k of keys) assertSafeKey(k);
      skipWs();
      if (peek() !== '=') fail('expected =');
      pos += 1;
      try {
        const val = parseValue();
        setPath(current, keys, val);
      } catch (err) {
        if (!strict && err?.degradable) {
          // G6-23: Degrade per-key on exotic unsupported values instead of rejecting the entire file.
          skipToEol();
        } else {
          throw err;
        }
      }
    }
    skipWs();
    skipComment();
    if (pos < src.length && peek() !== '\n' && peek() !== '\r') fail('expected end of line');
  }
  return toPlainTomlValue(root);
}

export const parseToml = parseTomlLite;

/* ---------------- Helpers ---------------- */

const ENCODED_VAULT_REF_RE = /%7[Bb]%7[Bb]vault(?:%3[Aa]|:)[A-Za-z0-9_.-]{1,100}%7[Dd]%7[Dd]/;

function hasAnyVaultRef(value) {
  if (findSecretRefs(value).length > 0) return true;
  const scanEncoded = (node) => {
    if (typeof node === 'string') return ENCODED_VAULT_REF_RE.test(node);
    if (Array.isArray(node)) return node.some(scanEncoded);
    if (node && typeof node === 'object') {
      return Object.entries(node).some(([k, v]) => ENCODED_VAULT_REF_RE.test(k) || scanEncoded(v));
    }
    return false;
  };
  return scanEncoded(value);
}

function expandRefs(value, env, warnings, where, { expandEnv = true } = {}) {
  if (typeof value !== 'string' || !value.includes('$')) return value;
  const safeEnv = env && typeof env === 'object' ? env : {};
  return value.replace(/\$\{(env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$\{input:([^}]+)\}/g, (m, _e, name, dflt, input) => {
    if (input) {
      warnings.push(`${where} uses a VS Code input (\${input:${input}}). Set its value in Loop.`);
      return m;
    }
    if (!expandEnv) {
      warnings.push(`${where} refers to \${${name}}, which Loop cannot fill in. Edit the connection after import.`);
      return m;
    }
    if (Object.hasOwn(safeEnv, name) && safeEnv[name] !== undefined) return safeEnv[name];
    if (dflt !== undefined) return dflt;
    warnings.push(`${where} refers to \${${name}}, which Loop cannot fill in. Edit the connection after import.`);
    return m;
  });
}

function expandRecord(record, env, warnings, label, opts = {}) {
  const out = {};
  for (const [k, v] of Object.entries(record || {})) {
    if (v === undefined || v === null) continue;
    out[k] = expandRefs(String(v), env, warnings, `${label} ${k}`, opts);
  }
  return out;
}

const TRANSPORT_MAP = {
  stdio: 'stdio',
  local: 'stdio',
  http: 'http',
  'streamable-http': 'http',
  streamable_http: 'http',
  streamablehttp: 'http',
  remote: 'http',
  sse: 'sse',
};

function cleanObject(obj) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
}

function extractDisabledTools(cfg) {
  const out = [];
  const seen = new Set();
  for (const list of [cfg?.excludeTools, cfg?.disabledTools]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const clean = item.trim();
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        out.push(clean);
      }
    }
  }
  return out;
}

function extractAllowedTools(cfg) {
  const out = [];
  const seen = new Set();
  for (const list of [cfg?.includeTools, cfg?.allowedTools]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const clean = item.trim();
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        out.push(clean);
      }
    }
  }
  return out;
}

function sanitizeCandidateForHosted(candidate, rawCfg = null, { outboundPolicy = null } = {}) {
  const droppedSettings = [];
  const pushDropped = (label) => {
    if (label && !droppedSettings.includes(label)) droppedSettings.push(label);
  };

  if (candidate.transport === 'stdio') {
    return {
      skipReason: 'Local command servers are not available in hosted workspaces.',
      droppedSettings,
    };
  }

  const activePolicy =
    outboundPolicy || createOutboundPolicy({ personal: true, selfIdentity: buildSelfIdentity() });
  try {
    activePolicy.assertConnectionUrl(candidate.url);
  } catch (err) {
    return {
      skipReason: err?.message || 'Connection URL is not allowed in hosted workspaces.',
      droppedSettings,
    };
  }

  const raw = cleanObject(rawCfg);
  if (candidate.cwd || (typeof raw.cwd === 'string' && raw.cwd.trim())) {
    pushDropped('cwd');
  }
  if (
    (Array.isArray(candidate.args) && candidate.args.length > 0) ||
    (Array.isArray(raw.args) && raw.args.length > 0)
  ) {
    pushDropped('args');
  }
  for (const envSource of [candidate.env, raw.env, raw.environment]) {
    for (const k of Object.keys(cleanObject(envSource))) {
      pushDropped(`env ${k}`);
    }
  }
  if (raw.oauth !== undefined && raw.oauth !== null) {
    pushDropped('oauth');
  }

  const keptHeaders = {};
  const seenHeaderNames = new Set();
  for (const [k, v] of Object.entries(cleanObject(candidate.headers))) {
    const lower = k.toLowerCase();
    if (seenHeaderNames.has(lower)) {
      pushDropped(`header ${k}`);
      continue;
    }
    try {
      assertPersonalHeaders({ [k]: v });
      keptHeaders[k] = v;
      seenHeaderNames.add(lower);
    } catch {
      pushDropped(`header ${k}`);
    }
  }

  return {
    candidate: {
      ...candidate,
      headers: keptHeaders,
      command: null,
      args: [],
      env: {},
      cwd: null,
    },
    droppedSettings,
  };
}

// Convert one client-specific server entry to a Loop connection candidate.
function toCandidate(
  name,
  cfg,
  flavor,
  env,
  { expandEnv = true, personal = false, allowStdio = true, outboundPolicy = null } = {},
) {
  const warnings = [];
  const c = cleanObject(cfg);
  const safeEnv = expandEnv && env && typeof env === 'object' ? env : {};
  let command = null;
  let args = [];
  let url = null;
  let transport = null;
  let cwd = null;
  let rawEnv = {};
  let rawHeaders = {};
  const enabled = c.enabled !== false && c.disabled !== true;
  const disabledTools = extractDisabledTools(c);
  const allowedTools = extractAllowedTools(c);

  if (flavor === 'opencode') {
    if (Array.isArray(c.command)) {
      command = c.command[0] ? String(c.command[0]) : null;
      args = c.command.slice(1).map(String);
    }
    rawEnv = cleanObject(c.environment || c.env);
    rawHeaders = cleanObject(c.headers);
    url = c.url || null;
    transport = TRANSPORT_MAP[String(c.type || '').toLowerCase()] || null;
  } else if (flavor === 'zed') {
    if (c.command && typeof c.command === 'object') {
      command = c.command.path || c.command.command || null;
      args = Array.isArray(c.command.args) ? c.command.args.map(String) : [];
      rawEnv = cleanObject(c.command.env);
    } else {
      command = typeof c.command === 'string' ? c.command : null;
      args = Array.isArray(c.args) ? c.args.map(String) : [];
      rawEnv = cleanObject(c.env);
    }
    url = c.url || null;
    rawHeaders = cleanObject(c.headers);
    if (!command && !url) {
      return { skipReason: 'Zed extension server (managed inside Zed).', warnings, droppedSettings: [] };
    }
  } else {
    command = typeof c.command === 'string' ? c.command : null;
    args = Array.isArray(c.args) ? c.args.map(String) : [];
    rawEnv = cleanObject(c.env);
    rawHeaders = cleanObject(c.headers || c.http_headers || c.requestInit?.headers);
    cwd = typeof c.cwd === 'string' ? c.cwd : null;
    if (flavor === 'gemini') {
      url = c.httpUrl || c.url || null;
      transport = c.httpUrl ? 'http' : c.url ? 'sse' : null;
    } else {
      url = c.url || c.serverUrl || c.httpUrl || null;
    }
    const explicit = TRANSPORT_MAP[String(c.type || c.transport || '').toLowerCase()];
    if (explicit && !transport) transport = explicit;
  }

  if (flavor === 'codex') {
    if (c.bearer_token_env_var) {
      const tokenVar = String(c.bearer_token_env_var);
      if (expandEnv && Object.hasOwn(safeEnv, tokenVar) && safeEnv[tokenVar]) {
        rawHeaders.Authorization = `Bearer ${safeEnv[tokenVar]}`;
      } else {
        warnings.push(`Needs a bearer token from $${tokenVar}, which Loop cannot see. Add the token on the connection.`);
      }
    }
    for (const [header, varName] of Object.entries(cleanObject(c.env_http_headers))) {
      if (expandEnv && Object.hasOwn(safeEnv, varName) && safeEnv[varName]) {
        rawHeaders[header] = safeEnv[varName];
      } else {
        warnings.push(`Header ${header} comes from $${varName}, which Loop cannot see.`);
      }
    }
    if (Array.isArray(c.env_vars) && c.env_vars.length) {
      const missing = c.env_vars.filter((v) => !expandEnv || !Object.hasOwn(safeEnv, v) || safeEnv[v] === undefined);
      if (missing.length) warnings.push(`Expects ${missing.join(', ')} from Codex's environment.`);
    }
  }

  if (!transport) transport = command && !url ? 'stdio' : 'http';
  if (transport === 'stdio' && (!allowStdio || personal)) {
    return {
      skipReason: 'Local command servers are not available in hosted workspaces.',
      warnings,
      droppedSettings: [],
    };
  }
  if (transport === 'stdio' && !command) return { skipReason: 'No command to run.', warnings, droppedSettings: [] };
  if (transport !== 'stdio' && !url) return { skipReason: 'No URL.', warnings, droppedSettings: [] };

  const expOpts = { expandEnv };
  if (command) command = expandRefs(command, safeEnv, warnings, 'command', expOpts);
  args = args.map((a, i) => expandRefs(a, safeEnv, warnings, `argument ${i + 1}`, expOpts));
  if (url) url = expandRefs(String(url), safeEnv, warnings, 'URL', expOpts);
  if (cwd) cwd = expandRefs(cwd, safeEnv, warnings, 'working directory', expOpts);

  const envOut = transport === 'stdio' ? expandRecord(rawEnv, safeEnv, warnings, 'env', expOpts) : {};
  const headersOut = transport === 'stdio' ? {} : expandRecord(rawHeaders, safeEnv, warnings, 'header', expOpts);

  // Refuse any pre-existing {{vault:...}} references BEFORE URL normalization percent-encodes braces.
  if (
    hasAnyVaultRef({
      url,
      command,
      args,
      cwd,
      env: envOut,
      headers: headersOut,
      rawEnv,
      rawHeaders,
    })
  ) {
    return {
      skipReason: 'Imported configs cannot reference existing Loop Vault secrets.',
      warnings,
      droppedSettings: [],
    };
  }

  if (url) {
    try {
      url = new URL(url).href;
    } catch {
      return { skipReason: `Invalid URL "${url}".`, warnings, droppedSettings: [] };
    }
  }

  let candidate = {
    name,
    transport,
    url: transport === 'stdio' ? null : url,
    command: transport === 'stdio' ? command : null,
    args: transport === 'stdio' ? args : [],
    env: envOut,
    headers: headersOut,
    cwd: transport === 'stdio' ? cwd : null,
    enabled,
    ...(disabledTools.length ? { disabledTools } : {}),
    ...(allowedTools.length ? { allowedTools } : {}),
  };

  let droppedSettings = [];
  if (personal || !allowStdio) {
    const hosted = sanitizeCandidateForHosted(candidate, c, { outboundPolicy });
    if (hosted.skipReason) {
      return { skipReason: hosted.skipReason, warnings, droppedSettings: hosted.droppedSettings };
    }
    candidate = hosted.candidate;
    droppedSettings = hosted.droppedSettings;
  } else if (outboundPolicy && candidate.transport !== 'stdio') {
    try {
      outboundPolicy.assertConnectionUrl(candidate.url);
    } catch (err) {
      return {
        skipReason: err?.message || 'Connection URL is not allowed.',
        warnings,
        droppedSettings: [],
      };
    }
  }

  return {
    candidate,
    warnings,
    droppedSettings,
  };
}

// Returns a reason when a server only works inside the agent that declared it.
function hostBoundReason(candidate, cfg, def, env) {
  const c = cleanObject(cfg);
  if (Array.isArray(c.env_vars) && c.env_vars.length) {
    const missing = c.env_vars.filter((v) => env[v] === undefined);
    if (missing.length) {
      return `Built into ${def.label}: it needs ${missing.length} variable${missing.length === 1 ? '' : 's'} ${def.label} sets at launch, so it will not start from Loop.`;
    }
  }
  if (candidate.transport === 'stdio' && !candidate.cwd && /^\.\.?[\\/]/.test(candidate.command || '')) {
    return `Built into ${def.label}: its command is relative to ${def.label}'s plugin folder, so it will not start from Loop.`;
  }
  return null;
}

function selfIdentityFromCtx(ctx = {}) {
  if (ctx?.selfIdentity && typeof ctx.selfIdentity.isSelfUrl === 'function') {
    return ctx.selfIdentity;
  }
  return buildSelfIdentity({
    port: ctx?.loopPort ?? null,
    allowedHosts: ctx?.allowedHosts ?? [],
    extraOrigins: ctx?.extraOrigins ?? [],
    stdioPath: ctx?.loopStdioPath ?? null,
  });
}

function isLoopItself(candidate, ctx = {}) {
  if (!candidate) return false;
  const identity = selfIdentityFromCtx(ctx);
  if (candidate.url && identity.isSelfUrl(candidate.url)) return true;
  if (candidate.command && identity.isSelfStdio(candidate.command, candidate.args)) return true;
  return false;
}

function secretCount(candidate) {
  let n = 0;
  for (const [k, v] of Object.entries(candidate.env || {})) if (isSecretEnv(k, v)) n += 1;
  for (const [k, v] of Object.entries(candidate.headers || {})) if (isSecretHeader(k, v)) n += 1;
  if (candidate.transport !== 'stdio' && candidate.url) {
    n += extractUrlSecrets(candidate.url).secrets.length;
  }
  return n + secretArgs(candidate.args).length;
}

// Display string for a server with secret arguments and URL tokens masked.
export function previewOf(candidate) {
  if (candidate.transport === 'stdio') {
    const args = [...(candidate.args || [])];
    for (const hit of secretArgs(args)) args[hit.index] = `${hit.prefix}••••`;
    return [candidate.command, ...args].join(' ');
  }
  return candidate.url ? extractUrlSecrets(candidate.url).maskUrl('••••') : '';
}

const VAULT_PLACEHOLDER_GLOBAL_RE = /\{\{vault:([A-Za-z0-9_.-]{1,100})\}\}/g;
const ENCODED_VAULT_REF_GLOBAL_RE = /%7[Bb]%7[Bb]vault(?:%3[Aa]|:)([A-Za-z0-9_.-]{1,100})%7[Dd]%7[Dd]/g;

function normalizeVaultRefEncoding(str) {
  if (typeof str !== 'string') return '';
  return str.replace(ENCODED_VAULT_REF_GLOBAL_RE, '{{vault:$1}}');
}

function normalizeHeadersLower(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return out;
  for (const [k, v] of Object.entries(headers)) {
    const key = String(k).trim().toLowerCase();
    const val = String(v ?? '').trim();
    if (key && val) out[key] = val;
  }
  return out;
}

function normalizeEnvStrings(env) {
  const out = {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) return out;
  for (const [k, v] of Object.entries(env)) {
    const key = String(k).trim();
    if (!key || v === undefined || v === null) continue;
    out[key] = String(v);
  }
  return out;
}

function normalizeUrlForExactCompare(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return '';
  try {
    return new URL(rawUrl).href;
  } catch {
    return rawUrl;
  }
}

function matchesVaultPlaceholderPattern(plainValue, storedValue) {
  if (plainValue === storedValue) return true;
  const normStored = normalizeVaultRefEncoding(String(storedValue ?? ''));
  if (!normStored.includes('{{vault:')) return false;
  const parts = normStored.split(/\{\{vault:[A-Za-z0-9_.-]{1,100}\}\}/g);
  const plain = String(plainValue ?? '');
  if (!plain.startsWith(parts[0]) || !plain.endsWith(parts[parts.length - 1])) return false;
  let cursor = parts[0].length;
  const limit = plain.length - parts[parts.length - 1].length;
  if (cursor >= limit) return false;
  for (let i = 1; i < parts.length - 1; i += 1) {
    const seg = parts[i];
    const idx = plain.indexOf(seg, cursor + 1);
    if (idx === -1 || idx + seg.length >= limit) return false;
    cursor = idx + seg.length;
  }
  return cursor < limit;
}

async function resolveVaultPlaceholdersInString(str, vault) {
  if (typeof str !== 'string') return { ok: true, value: '' };
  const normalized = normalizeVaultRefEncoding(str);
  if (!normalized.includes('{{vault:')) {
    return { ok: true, value: normalized };
  }
  if (!vault || typeof vault.get !== 'function') {
    return { ok: false, value: null };
  }
  let out = '';
  let lastIdx = 0;
  for (const match of normalized.matchAll(VAULT_PLACEHOLDER_GLOBAL_RE)) {
    out += normalized.slice(lastIdx, match.index);
    const key = match[1];
    const resolved = await vault.get(key).catch(() => null);
    if (typeof resolved !== 'string') {
      return { ok: false, value: null };
    }
    out += resolved;
    lastIdx = match.index + match[0].length;
  }
  out += normalized.slice(lastIdx);
  return { ok: true, value: out };
}

function canonicalUrlForDuplicateCheck(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return '';
  const withPlaceholdersMasked = rawUrl
    .replace(ENCODED_VAULT_REF_GLOBAL_RE, '••••')
    .replace(VAULT_PLACEHOLDER_GLOBAL_RE, '••••');
  return extractUrlSecrets(withPlaceholdersMasked).maskUrl('••••');
}

// Credential-aware structural duplicate check (G6-04).
// Plaintext secrets on both sides MUST match strictly so a second account with different
// credentials is never silently treated as identical. Vault placeholders on an existing Loop
// entry match structurally when vault is not available.
export function isDuplicateEntry(candidate, existingList) {
  if (!candidate || !Array.isArray(existingList)) return false;
  const candTransport = candidate.transport || 'http';

  if (candTransport === 'stdio') {
    const candArgs = Array.isArray(candidate.args) ? candidate.args.map(String) : [];
    const candEnv = normalizeEnvStrings(candidate.env);
    const candEnvKeys = Object.keys(candEnv);
    const candCwd = candidate.cwd || null;
    const wild = new Set(secretArgs(candArgs).map((h) => h.index));

    return existingList.some((m) => {
      if ((m.transport || 'http') !== 'stdio' || m.command !== candidate.command) return false;
      if ((m.cwd || null) !== candCwd) return false;
      const bArgs = Array.isArray(m.args) ? m.args.map(String) : [];
      if (candArgs.length !== bArgs.length) return false;
      for (let i = 0; i < candArgs.length; i += 1) {
        if (candArgs[i] === bArgs[i]) continue;
        if (
          (wild.has(i) || String(bArgs[i]).includes('{{vault:')) &&
          matchesVaultPlaceholderPattern(candArgs[i], bArgs[i])
        ) {
          continue;
        }
        return false;
      }

      const mEnv = normalizeEnvStrings(m.env);
      const mEnvKeys = Object.keys(mEnv);
      if (candEnvKeys.length !== mEnvKeys.length) return false;
      for (const k of candEnvKeys) {
        if (!Object.hasOwn(mEnv, k)) return false;
        if (candEnv[k] === mEnv[k]) continue;
        if (mEnv[k].includes('{{vault:') && matchesVaultPlaceholderPattern(candEnv[k], mEnv[k])) {
          continue;
        }
        return false;
      }
      return true;
    });
  }

  if (!candidate.url) return false;
  const candNormUrl = normalizeUrlForExactCompare(candidate.url);
  const candCanon = canonicalUrlForDuplicateCheck(candidate.url);
  const candHeaders = normalizeHeadersLower(candidate.headers);
  const candHeaderKeys = Object.keys(candHeaders);

  return existingList.some((m) => {
    if ((m.transport || 'http') === 'stdio' || !m.url) return false;
    if ((m.transport || 'http') !== candTransport) return false;
    const mNormUrl = normalizeUrlForExactCompare(m.url);
    const mHasVaultUrl = normalizeVaultRefEncoding(m.url).includes('{{vault:');
    const urlMatches =
      mNormUrl === candNormUrl ||
      (mHasVaultUrl && canonicalUrlForDuplicateCheck(m.url) === candCanon);
    if (!urlMatches) return false;

    const mHeaders = normalizeHeadersLower(m.headers);
    const mHeaderKeys = Object.keys(mHeaders);
    if (candHeaderKeys.length !== mHeaderKeys.length) return false;
    for (const h of candHeaderKeys) {
      if (!Object.hasOwn(mHeaders, h)) return false;
      if (candHeaders[h] === mHeaders[h]) continue;
      if (mHeaders[h].includes('{{vault:') && matchesVaultPlaceholderPattern(candHeaders[h], mHeaders[h])) {
        continue;
      }
      return false;
    }
    return true;
  });
}

// Strict credential-verified duplicate check for destructive cleanup decisions (G6-04).
// Resolves {{vault:KEY}} placeholders on Loop's entry when vault is provided, and returns false
// whenever any field/credential differs or cannot be verified equal.
export async function isExactDuplicateForCleanup(candidate, loopEntry, vault = null) {
  if (!candidate || !loopEntry) return false;
  const candTransport = candidate.transport || 'http';
  const loopTransport = loopEntry.transport || 'http';
  if (candTransport !== loopTransport) return false;

  if (candTransport === 'stdio') {
    if ((candidate.command || '') !== (loopEntry.command || '')) return false;
    if ((candidate.cwd || null) !== (loopEntry.cwd || null)) return false;

    const candArgs = Array.isArray(candidate.args) ? candidate.args.map(String) : [];
    const loopArgs = Array.isArray(loopEntry.args) ? loopEntry.args.map(String) : [];
    if (candArgs.length !== loopArgs.length) return false;
    for (let i = 0; i < candArgs.length; i += 1) {
      const resolved = await resolveVaultPlaceholdersInString(loopArgs[i], vault);
      if (!resolved.ok || resolved.value !== candArgs[i]) return false;
    }

    const candEnv = normalizeEnvStrings(candidate.env);
    const loopEnv = normalizeEnvStrings(loopEntry.env);
    const candEnvKeys = Object.keys(candEnv);
    const loopEnvKeys = Object.keys(loopEnv);
    if (candEnvKeys.length !== loopEnvKeys.length) return false;
    for (const k of candEnvKeys) {
      if (!Object.hasOwn(loopEnv, k)) return false;
      const resolved = await resolveVaultPlaceholdersInString(loopEnv[k], vault);
      if (!resolved.ok || resolved.value !== candEnv[k]) return false;
    }
    return true;
  }

  if (!candidate.url || !loopEntry.url) return false;
  const resolvedUrl = await resolveVaultPlaceholdersInString(loopEntry.url, vault);
  if (!resolvedUrl.ok) return false;
  if (normalizeUrlForExactCompare(candidate.url) !== normalizeUrlForExactCompare(resolvedUrl.value)) {
    return false;
  }

  const candHeaders = normalizeHeadersLower(candidate.headers);
  const loopHeaders = normalizeHeadersLower(loopEntry.headers);
  const candHeaderKeys = Object.keys(candHeaders);
  const loopHeaderKeys = Object.keys(loopHeaders);
  if (candHeaderKeys.length !== loopHeaderKeys.length) return false;
  for (const h of candHeaderKeys) {
    if (!Object.hasOwn(loopHeaders, h)) return false;
    const resolvedHdr = await resolveVaultPlaceholdersInString(loopHeaders[h], vault);
    if (!resolvedHdr.ok || resolvedHdr.value.trim() !== candHeaders[h]) return false;
  }
  return true;
}

function stripPackageVersion(spec) {
  const s = String(spec || '').trim();
  if (!s) return '';
  // Scoped npm package: @scope/pkg@1.2.3 -> @scope/pkg
  if (s.startsWith('@')) {
    const slash = s.indexOf('/');
    if (slash === -1) return s.toLowerCase();
    const at = s.indexOf('@', slash + 1);
    return (at === -1 ? s : s.slice(0, at)).toLowerCase();
  }
  // Python or npm version specifiers: pkg==1.0, pkg>=1.0, pkg@1.2.3
  const cut = s.search(/(?:==|>=|<=|~=|!=|@)/);
  return (cut === -1 ? s : s.slice(0, cut)).toLowerCase();
}

export function extractStdioPackageIdentity(command, args = []) {
  const base = path.basename(String(command || '').trim()).toLowerCase();
  const list = Array.isArray(args) ? args.map(String) : [];
  if (!base || list.length === 0) return '';

  if (base === 'npx' || base === 'pnpx' || base === 'bunx') {
    for (let i = 0; i < list.length; i += 1) {
      const tok = list[i];
      if (!tok) continue;
      if (tok === '-y' || tok === '--yes' || tok === '-q' || tok === '--quiet' || tok === '--no' || tok === '--no-install' || tok === '--prefer-offline') {
        continue;
      }
      if (tok === '-p' || tok === '--package') {
        const next = list[i + 1];
        return next ? `${base}:${stripPackageVersion(next)}` : '';
      }
      if (tok.startsWith('--package=')) {
        return `${base}:${stripPackageVersion(tok.slice('--package='.length))}`;
      }
      if (tok.startsWith('-')) continue;
      return `${base}:${stripPackageVersion(tok)}`;
    }
    return '';
  }

  if (base === 'uvx' || base === 'pipx') {
    for (let i = 0; i < list.length; i += 1) {
      const tok = list[i];
      if (!tok) continue;
      if (tok === 'run' && i === 0) continue;
      if (tok === '--from' && list[i + 1]) {
        return `${base}:${stripPackageVersion(list[i + 1])}`;
      }
      if (tok.startsWith('--from=')) {
        return `${base}:${stripPackageVersion(tok.slice('--from='.length))}`;
      }
      if (tok.startsWith('-')) continue;
      return `${base}:${stripPackageVersion(tok)}`;
    }
    return '';
  }

  if (base === 'docker' && list[0] === 'run') {
    const valueFlags = new Set(['-e', '--env', '-v', '--volume', '-p', '--publish', '--name', '-w', '--workdir', '--network', '--env-file', '--entrypoint', '-u', '--user']);
    for (let i = 1; i < list.length; i += 1) {
      const tok = list[i];
      if (!tok) continue;
      if (valueFlags.has(tok)) {
        i += 1;
        continue;
      }
      if (tok.startsWith('-')) continue;
      const noDigest = tok.split('@')[0];
      const lastSlash = noDigest.lastIndexOf('/');
      const colon = noDigest.indexOf(':', lastSlash + 1);
      const image = (colon === -1 ? noDigest : noDigest.slice(0, colon)).toLowerCase();
      return image ? `docker:${image}` : '';
    }
  }
  return '';
}

async function recordsMatchCredentials(candRec, loopRec, vault) {
  const cKeys = Object.keys(candRec);
  const lKeys = Object.keys(loopRec);
  if (cKeys.length !== lKeys.length) return false;
  for (const k of cKeys) {
    if (!Object.hasOwn(loopRec, k)) return false;
    if (candRec[k] === loopRec[k]) continue;
    if (vault) {
      const resolved = await resolveVaultPlaceholdersInString(loopRec[k], vault);
      if (resolved.ok && resolved.value === candRec[k]) continue;
      return false;
    }
    if (String(loopRec[k]).includes('{{vault:') && matchesVaultPlaceholderPattern(candRec[k], loopRec[k])) {
      continue;
    }
    return false;
  }
  return true;
}

const IMPORT_SECRET_QUERY_RE = /(key|token|secret|passw|pwd|auth|credential|bearer|cookie|session|private|signature|jwt)|^(?:sig|pass|pat)$/i;

function nonSecretQuerySignature(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const kept = [];
    for (const [k, v] of u.searchParams.entries()) {
      const lk = String(k || '').trim().toLowerCase();
      if (!lk || IMPORT_SECRET_QUERY_RE.test(lk)) continue;
      const sv = String(v ?? '').trim();
      if (sv.includes('{{vault:')) continue;
      kept.push(`${lk}=${sv}`);
    }
    kept.sort();
    return kept.join('&');
  } catch {
    return '';
  }
}

async function stdioSecretArgsMatch(candArgs, loopArgs, vault) {
  const cList = Array.isArray(candArgs) ? candArgs.map(String) : [];
  const lList = Array.isArray(loopArgs) ? loopArgs.map(String) : [];
  const cSecrets = secretArgs(cList);
  const lSecretPositions = new Set(secretArgs(lList).map((s) => s.index));
  for (let i = 0; i < lList.length; i += 1) {
    if (lList[i].includes('{{vault:')) lSecretPositions.add(i);
  }
  if (cSecrets.length === 0 && lSecretPositions.size === 0) return true;
  if (cSecrets.length !== lSecretPositions.size) return false;
  const lSorted = [...lSecretPositions].sort((a, b) => a - b);
  for (let i = 0; i < cSecrets.length; i += 1) {
    const candTok = cList[cSecrets[i].index];
    const loopTok = lList[lSorted[i]];
    if (candTok === loopTok) continue;
    if (vault) {
      const resolved = await resolveVaultPlaceholdersInString(loopTok, vault);
      if (resolved.ok && resolved.value === candTok) continue;
      return false;
    }
    if (String(loopTok).includes('{{vault:') && matchesVaultPlaceholderPattern(candTok, loopTok)) continue;
    return false;
  }
  return true;
}

// Finds a saved Loop connection that `candidate` safely updates in place (same name + same origin path/transport
// upgrade, or same local package version bump) while strictly preserving credential-aware account separation (G6-04)
// and distinct query-scoped endpoints (for example ?project_ref=appA vs ?project_ref=appB).
export async function findUpdatableConnection(candidate, existingList, vault = null) {
  if (!candidate || !Array.isArray(existingList) || existingList.length === 0) return null;
  const candName = String(candidate.name || '').trim().toLowerCase();
  if (!candName) return null;
  const candTransport = candidate.transport || 'http';
  if (candTransport === 'builtin') return null;

  if (candTransport === 'stdio') {
    const candPkg = extractStdioPackageIdentity(candidate.command, candidate.args);
    if (!candPkg) return null;
    const candCwd = candidate.cwd || null;
    const candEnv = normalizeEnvStrings(candidate.env);
    for (const m of existingList) {
      if (!m || m.lent || (m.transport || 'http') !== 'stdio') continue;
      if (String(m.name || '').trim().toLowerCase() !== candName) continue;
      if ((m.cwd || null) !== candCwd) continue;
      if (extractStdioPackageIdentity(m.command, m.args) !== candPkg) continue;
      const mEnv = normalizeEnvStrings(m.env);
      if (!(await recordsMatchCredentials(candEnv, mEnv, vault))) continue;
      if (!(await stdioSecretArgsMatch(candidate.args, m.args, vault))) continue;
      return m;
    }
    return null;
  }

  if (!candidate.url) return null;
  let candOrigin = '';
  try {
    candOrigin = new URL(candidate.url).origin.toLowerCase();
  } catch {
    return null;
  }
  const candQuerySig = nonSecretQuerySignature(candidate.url);
  const candHeaders = normalizeHeadersLower(candidate.headers);
  for (const m of existingList) {
    if (!m || m.lent || (m.transport || 'http') === 'stdio' || (m.transport || 'http') === 'builtin' || !m.url) continue;
    if (m.accountLabel && (!candidate.accountLabel || m.accountLabel.toLowerCase() !== String(candidate.accountLabel).trim().toLowerCase())) {
      continue;
    }
    if (String(m.name || '').trim().toLowerCase() !== candName) continue;
    let mOrigin = '';
    try {
      mOrigin = new URL(m.url).origin.toLowerCase();
    } catch {
      continue;
    }
    if (mOrigin !== candOrigin) continue;
    if (nonSecretQuerySignature(m.url) !== candQuerySig) continue;
    const mHeaders = normalizeHeadersLower(m.headers);
    if (!(await recordsMatchCredentials(candHeaders, mHeaders, vault))) continue;
    return m;
  }
  return null;
}

/* ---------------- Sources ---------------- */

export function sourceDefinitions({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const appSupport = platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.config');
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  const mcpServersOf = (j) => cleanObject(j?.mcpServers);
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      kind: 'claude-code',
      files: [path.join(home, '.claude.json')],
      pluginCacheDir: path.join(home, '.claude', 'plugins', 'cache'),
      pluginSettingsFile: path.join(home, '.claude', 'settings.json'),
      format: 'json',
      extract: (j) => {
        const groups = [{ origin: 'user', servers: mcpServersOf(j) }];
        for (const [projectPath, proj] of Object.entries(cleanObject(j?.projects))) {
          const servers = mcpServersOf(proj);
          if (Object.keys(servers).length) {
            groups.push({ origin: `project ${path.basename(projectPath)}`, projectPath, servers });
          }
        }
        return groups;
      },
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      kind: 'claude-desktop',
      files: [path.join(appSupport, 'Claude', 'claude_desktop_config.json')],
      format: 'json',
      extract: (j) => [{ origin: 'user', servers: mcpServersOf(j) }],
    },
    {
      id: 'codex',
      label: 'Codex',
      kind: 'codex',
      files: [path.join(codexHome, 'config.toml')],
      pluginCacheDir: path.join(codexHome, 'plugins', 'cache'),
      format: 'toml',
      flavor: 'codex',
      extract: (j) => [{ origin: 'user', servers: cleanObject(j?.mcp_servers) }],
    },
    {
      id: 'kimi-code',
      label: 'Kimi',
      kind: 'kimi-code',
      files: [
        path.join(home, '.kimi-code', 'mcp.json'),
        path.join(home, '.kimi', 'mcp.json'),
      ],
      format: 'json',
      extract: (j) => [{ origin: 'user', servers: mcpServersOf(j) }],
    },
    {
      id: 'cursor',
      label: 'Cursor',
      kind: 'cursor',
      files: [path.join(home, '.cursor', 'mcp.json')],
      format: 'json',
      extract: (j) => [{ origin: 'user', servers: mcpServersOf(j) }],
    },
    {
      id: 'antigravity',
      label: 'Antigravity',
      kind: 'antigravity',
      files: [
        path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
        path.join(home, '.gemini', 'config', 'mcp_config.json'),
      ],
      format: 'json',
      extract: (j) => [{ origin: 'user', servers: mcpServersOf(j) }],
    },
    {
      id: 'gemini',
      label: 'Gemini CLI',
      kind: 'gemini',
      files: [path.join(home, '.gemini', 'settings.json')],
      format: 'jsonc',
      flavor: 'gemini',
      extract: (j) => [{ origin: 'user', servers: mcpServersOf(j) }],
    },
    {
      id: 'vscode',
      label: 'VS Code',
      kind: 'vscode',
      files: [path.join(appSupport, 'Code', 'User', 'mcp.json')],
      format: 'jsonc',
      extract: (j) => [{ origin: 'user', servers: cleanObject(j?.servers) }],
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      kind: 'windsurf',
      files: [path.join(home, '.codeium', 'windsurf', 'mcp_config.json')],
      format: 'json',
      extract: (j) => [{ origin: 'user', servers: mcpServersOf(j) }],
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      kind: 'opencode',
      files: [
        path.join(home, '.config', 'opencode', 'opencode.json'),
        path.join(home, '.config', 'opencode', 'opencode.jsonc'),
      ],
      format: 'jsonc',
      flavor: 'opencode',
      extract: (j) => [{ origin: 'user', servers: cleanObject(j?.mcp) }],
    },
    {
      id: 'zed',
      label: 'Zed',
      kind: 'zed',
      files: [path.join(home, '.config', 'zed', 'settings.json')],
      format: 'jsonc',
      flavor: 'zed',
      extract: (j) => [{ origin: 'user', servers: cleanObject(j?.context_servers) }],
    },
  ];
}

function parseByFormat(text, format) {
  if (format === 'toml') return parseTomlLite(text);
  if (format === 'jsonc') return parseJsonc(text);
  return JSON.parse(stripUtf8Bom(text));
}

const SKIP_PLUGIN_MARKETPLACES = new Set(['openai-bundled']);

function substitutePluginRoot(value, pluginRoot) {
  if (typeof value === 'string') {
    return value.includes('${CLAUDE_PLUGIN_ROOT}')
      ? value.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substitutePluginRoot(item, pluginRoot));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = substitutePluginRoot(v, pluginRoot);
    }
    return out;
  }
  return value;
}

async function discoverPluginMcpGroups(cacheDir, parsedConfig = null, { pluginSettingsFile = null } = {}) {
  if (!cacheDir) return [];
  const groups = [];
  let marketplaces;
  try {
    marketplaces = await readdir(cacheDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const pluginStates = cleanObject(parsedConfig?.plugins);
  let enabledPluginsMap = {};
  if (pluginSettingsFile) {
    try {
      const settingsRaw = await readFile(pluginSettingsFile, 'utf8');
      const settingsJson = parseJsonc(settingsRaw);
      enabledPluginsMap = cleanObject(settingsJson?.enabledPlugins);
    } catch {
      enabledPluginsMap = {};
    }
  }

  for (const mp of marketplaces) {
    if (!mp.isDirectory() || SKIP_PLUGIN_MARKETPLACES.has(mp.name)) continue;
    const mpDir = path.join(cacheDir, mp.name);
    let plugins;
    try {
      plugins = await readdir(mpDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const pl of plugins) {
      if (!pl.isDirectory()) continue;
      const plDir = path.join(mpDir, pl.name);
      let versions;
      try {
        versions = (await readdir(plDir, { withFileTypes: true }))
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      } catch {
        continue;
      }
      if (!versions.length) continue;

      let mcpJson = null;
      let resolvedVerDir = null;
      for (const ver of versions) {
        const verDir = path.join(plDir, ver);
        try {
          const raw = await readFile(path.join(verDir, '.mcp.json'), 'utf8');
          mcpJson = parseJsonc(raw);
          resolvedVerDir = path.resolve(verDir);
          break;
        } catch {
          // try older version if newest has no .mcp.json
        }
      }
      if (!mcpJson) continue;

      const rawServers = cleanObject(mcpJson.mcpServers || mcpJson.servers);
      if (!Object.keys(rawServers).length) continue;

      // G6-20: Respect enabledPlugins from ~/.claude/settings.json as well as Codex config.toml [plugins].
      const pluginKey = `${pl.name}@${mp.name}`;
      let pluginEnabled = true;
      if (Object.hasOwn(enabledPluginsMap, pluginKey)) {
        const state = enabledPluginsMap[pluginKey];
        pluginEnabled = typeof state === 'boolean' ? state : state?.enabled !== false;
      } else if (Object.hasOwn(pluginStates, pluginKey)) {
        pluginEnabled = pluginStates[pluginKey]?.enabled !== false;
      }

      const servers = {};
      for (const [sName, sCfg] of Object.entries(rawServers)) {
        const expandedCfg =
          resolvedVerDir && sCfg && typeof sCfg === 'object'
            ? substitutePluginRoot(sCfg, resolvedVerDir)
            : sCfg;
        servers[sName] =
          expandedCfg && typeof expandedCfg === 'object'
            ? { ...expandedCfg, enabled: expandedCfg.enabled === false ? false : pluginEnabled }
            : expandedCfg;
      }
      groups.push({ origin: `plugin ${pl.name}`, servers });
    }
  }
  return groups;
}

// Keep ordinary discovery keys readable, but never let a name/path inject a key separator.
function connectionDiscoveryKey(sourceId, group, name) {
  const escape = (s) => s.replaceAll('%', '%25').replaceAll(':', '%3A');
  const origin = group.projectPath ? 'project:' + escape(group.projectPath) : escape(group.origin);
  return sourceId + '::' + origin + '::' + escape(name);
}

// Reads every known agent config. Returns sources with their servers and, for each,
// whether it is new, already in Loop, Loop itself, or unsupported. Never returns secret values.
export async function discoverSources(store, ctx = {}) {
  const env = ctx.env || process.env;
  const vault = ctx.vault || null;
  const defs = ctx.sources || sourceDefinitions({ home: ctx.home, platform: ctx.platform, env });
  const existing = await store.list();
  const seen = []; // candidates already offered earlier in this scan
  const results = [];

  for (const def of defs) {
    const source = { id: def.id, label: def.label, kind: def.kind, path: null, found: false, error: null, servers: [] };
    let text = null;
    for (const file of def.files) {
      try {
        text = await readFile(file, 'utf8');
        source.path = file;
        source.found = true;
        break;
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          source.path = file;
          source.error = err?.message || 'Could not read file.';
        }
      }
    }
    if (!source.found) {
      if (!source.path) source.path = def.files[0];
      results.push(source);
      continue;
    }

    let parsed;
    try {
      parsed = parseByFormat(text, def.format);
    } catch (err) {
      source.error = err?.message || 'Could not parse file.';
      results.push(source);
      continue;
    }

    const groups = [
      ...def.extract(parsed),
      ...(await discoverPluginMcpGroups(def.pluginCacheDir, parsed, {
        pluginSettingsFile: def.pluginSettingsFile || null,
      })),
    ];
    for (const group of groups) {
      for (const [name, cfg] of Object.entries(group.servers)) {
        const key = connectionDiscoveryKey(def.id, group, name);
        const conv = toCandidate(name, cfg, def.flavor || 'generic', env);
        const item = {
          key,
          source: def.id,
          origin: group.origin,
          ...(group.projectPath ? { projectPath: group.projectPath } : {}),
          name,
          status: 'new',
          reason: null,
          warnings: conv.warnings,
          transport: conv.candidate?.transport ?? null,
          preview: conv.candidate ? previewOf(conv.candidate) : '',
          enabled: conv.candidate?.enabled ?? false,
          secretCount: conv.candidate ? secretCount(conv.candidate) : 0,
          candidate: conv.candidate || null,
        };
        const bound = conv.candidate ? hostBoundReason(conv.candidate, cfg, def, env) : null;
        if (!conv.candidate) {
          item.status = 'unsupported';
          item.reason = conv.skipReason;
        } else if (bound) {
          // Agent-internal server (e.g. Codex's node_repl or codex-security plugin):
          // it only starts inside that agent, so copying it into Loop gives a dead connection.
          item.status = 'unsupported';
          item.reason = bound;
        } else if (isLoopItself(conv.candidate, ctx)) {
          item.status = 'self';
          item.reason = 'This is Loop itself.';
        } else {
          let alreadyExists = false;
          if (vault) {
            for (const m of existing) {
              if (await isExactDuplicateForCleanup(conv.candidate, m, vault)) {
                alreadyExists = true;
                break;
              }
            }
          } else {
            alreadyExists = isDuplicateEntry(conv.candidate, existing);
          }

          if (alreadyExists) {
            item.status = 'exists';
            item.reason = 'Already in Loop.';
          } else {
            const updateTarget = await findUpdatableConnection(conv.candidate, existing, vault);
            if (updateTarget) {
              item.status = 'update';
              item.updateTargetId = updateTarget.id;
              item.updateTargetName = updateTarget.name;
              item.reason = `Updates "${updateTarget.name}" in Loop (keeps sign-in and settings).`;
            } else {
              const twin = seen.find((x) => isDuplicateEntry(conv.candidate, [x.candidate]));
              if (twin) {
                item.status = 'duplicate';
                item.reason = `Same server as ${twin.label} "${twin.name}".`;
              } else {
                seen.push({ candidate: conv.candidate, label: def.label, name });
              }
            }
          }
        }
        source.servers.push(item);
      }
    }
    results.push(source);
  }
  return results;
}

// Fast local scan: returns every installed agent on this machine whose config
// currently has an enabled entry pointing to this Loop gateway.
export async function discoverConnectedLocalAgents(ctx = {}) {
  const env = ctx.env || process.env;
  const defs = ctx.sources || sourceDefinitions({ home: ctx.home, platform: ctx.platform, env });
  const connected = [];

  for (const def of defs) {
    let matchedPath = null;
    let matchedPreview = null;
    let matchedTransport = 'http';
    let token = null;
    const origins = [];

    for (const file of def.files) {
      let text;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      let parsed;
      try {
        parsed = parseByFormat(text, def.format);
      } catch {
        continue;
      }
      const groups = def.extract(parsed);
      for (const group of groups) {
        for (const [name, cfg] of Object.entries(group.servers)) {
          const conv = toCandidate(name, cfg, def.flavor || 'generic', env);
          if (!conv.candidate || conv.candidate.enabled === false) continue;
          if (!isLoopItself(conv.candidate, ctx)) continue;
          if (!matchedPath) {
            matchedPath = file;
            matchedPreview = previewOf(conv.candidate);
            matchedTransport = conv.candidate.transport === 'stdio' ? 'stdio' : 'http';
            token = agentTokenIn(conv.candidate);
          }
          if (group.origin && !origins.includes(group.origin)) {
            origins.push(group.origin);
          }
        }
      }
      if (matchedPath) break;
    }

    if (matchedPath) {
      connected.push({
        id: def.id,
        name: def.label,
        kind: def.kind,
        transport: matchedTransport,
        configPath: matchedPath,
        preview: matchedPreview || '',
        origins,
        token, // a secret: only to find the agent, never in an answer
      });
    }
  }

  return connected;
}

export function publicSources(sources) {
  return sources.map((s) => ({
    ...s,
    servers: s.servers.map(({ candidate: _c, ...rest }) => rest),
  }));
}

const MCP_JSON_OPTION_KEYS = ['env', 'personal', 'allowStdio', 'outboundPolicy', 'policy', 'expandEnv'];

function parseMcpJsonOptions(envOrOpts) {
  if (!envOrOpts || typeof envOrOpts !== 'object' || Array.isArray(envOrOpts)) {
    return { env: {}, expandEnv: false, personal: false, allowStdio: true, outboundPolicy: null };
  }
  const hasOptionKey = MCP_JSON_OPTION_KEYS.some((k) => Object.hasOwn(envOrOpts, k));
  if (hasOptionKey) {
    const personal = Boolean(envOrOpts.personal);
    const allowStdio = envOrOpts.allowStdio !== undefined ? Boolean(envOrOpts.allowStdio) : !personal;
    const outboundPolicy =
      envOrOpts.outboundPolicy ||
      envOrOpts.policy ||
      (personal ? createOutboundPolicy({ personal: true, selfIdentity: buildSelfIdentity() }) : null);
    const expandEnv = personal
      ? false
      : envOrOpts.expandEnv !== undefined
        ? Boolean(envOrOpts.expandEnv)
        : Boolean(envOrOpts.env && typeof envOrOpts.env === 'object');
    const env = expandEnv && envOrOpts.env && typeof envOrOpts.env === 'object' ? envOrOpts.env : {};
    return { env, expandEnv, personal, allowStdio, outboundPolicy };
  }
  const env = envOrOpts;
  return {
    env,
    expandEnv: Object.keys(env).length > 0,
    personal: false,
    allowStdio: true,
    outboundPolicy: null,
  };
}

// Generic "mcpServers" JSON (pasted by the user) to candidates.
// Never reads process.env by default; callers must pass an explicit env map if expansion is wanted.
const isPlainObject = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const entryAddress = (cfg) => [cfg.url, cfg.serverUrl, cfg.httpUrl].find((u) => typeof u === 'string');

// An entry that says where a server is: an address, or a command as text, as a list, or as a path.
function isServerEntry(cfg) {
  if (!isPlainObject(cfg)) return false;
  const { command } = cfg;
  return Boolean(entryAddress(cfg)) || [command, command?.[0], command?.path].some((c) => typeof c === 'string' && c);
}

// What a pasted text says: JSON (comments are fine), one entry copied out of its braces, or TOML.
function readPastedConfig(text) {
  for (const read of [parseJsonc, (t) => parseJsonc(`{${t}}`), (t) => parseToml(t, { strict: true })]) {
    try {
      const config = read(text);
      if (config && typeof config === 'object') return config;
    } catch {
      // Not written this way.
    }
  }
  throw new Error('Loop cannot read this text. Paste a JSON or TOML configuration, for example { "mcpServers": { … } }.');
}

// The servers of a configuration as [name, entry] pairs. A program keeps them in an object or a list that it
// names after MCP or servers, sometimes deep in its settings. A person can also copy one entry only.
function serverEntries(config) {
  const entriesOf = (x) => (Array.isArray(x) ? x.map((cfg) => [cfg?.name ?? cfg?.id, cfg]) : Object.entries(x));
  const hasServer = (x) => entriesOf(x).some(([, cfg]) => isServerEntry(cfg));
  const known = [config.mcpServers, config.servers].find((x) => isPlainObject(x) && Object.keys(x).length);
  if (known) return entriesOf(known);
  if (isServerEntry(config)) return [[config.name, config]];
  if (hasServer(config)) return entriesOf(config);
  let level = [config];
  for (let depth = 0; depth < 5; depth += 1) {
    const inside = level.flatMap((x) => Object.entries(x)).filter(([, x]) => x && typeof x === 'object');
    const found = inside.find(([key, x]) => /mcp|servers/i.test(key) && hasServer(x));
    if (found) return entriesOf(found[1]);
    level = inside.map(([, x]) => x);
  }
  throw new Error('No MCP server found in this text. Paste a configuration with "mcpServers", or one server entry with a "url" or a "command".');
}

// A name for an entry that has none: its host, or the first word of its command that names a package or a file.
function nameOfEntry(cfg) {
  if (!isServerEntry(cfg)) return '';
  const address = entryAddress(cfg);
  if (address) return URL.canParse(address) ? suggestNameFromHost(new URL(address).hostname) : address;
  const [command, ...args] = [cfg.command?.path ?? cfg.command, cfg.args ?? cfg.command?.args ?? []].flat(2).map(String);
  const words = args.filter((word) => !word.startsWith('-'));
  const word = words.find((w) => /[/@.-]/.test(w)) ?? words[0] ?? command;
  return word.split('/').filter(Boolean).pop()?.replace(/(.)@.*$/, '$1') ?? '';
}

// How the entry is written, from its own fields.
function flavorOfEntry(cfg) {
  if (Array.isArray(cfg.command)) return 'opencode';
  if (isPlainObject(cfg.command)) return 'zed';
  return ['bearer_token_env_var', 'env_http_headers', 'env_vars'].some((key) => Object.hasOwn(cfg, key)) ? 'codex' : 'generic';
}

export function candidatesFromMcpJson(raw, envOrOpts = {}) {
  const opts = parseMcpJsonOptions(envOrOpts);
  const config = typeof raw === 'string' ? readPastedConfig(raw) : raw;
  if (!config || typeof config !== 'object') throw new Error('MCP config must be a JSON object.');
  const out = [];
  for (const [rawName, cfg] of serverEntries(config)) {
    const name = String(rawName || nameOfEntry(cfg)).trim();
    if (!name || !isPlainObject(cfg)) {
      const reason = 'Invalid server entry.';
      out.push({
        name: name || '(unnamed)',
        candidate: null,
        skipReason: reason,
        error: reason,
        warnings: [],
        droppedSettings: [],
      });
      continue;
    }
    const conv = toCandidate(name, cfg, flavorOfEntry(cfg), opts.env, {
      expandEnv: opts.expandEnv,
      personal: opts.personal,
      allowStdio: opts.allowStdio,
      outboundPolicy: opts.outboundPolicy,
    });
    out.push({
      name,
      candidate: conv.candidate || null,
      skipReason: conv.skipReason || null,
      ...(conv.skipReason ? { error: conv.skipReason } : {}),
      warnings: conv.warnings,
      droppedSettings: conv.droppedSettings || [],
      enabled: conv.candidate ? conv.candidate.enabled !== false : false,
      profiles: Array.isArray(cfg.profiles) ? cfg.profiles : [],
    });
  }
  return out;
}

/* ---------------- Import into Loop ---------------- */

// G6-17: Serialize importCandidates per store instance so concurrent/double-submitted imports
// run sequentially and never create duplicate connections.
const importQueuesByStore = new WeakMap();

function withImportLock(store, fn) {
  if (!store || (typeof store !== 'object' && typeof store !== 'function')) {
    return fn();
  }
  let queue = importQueuesByStore.get(store);
  if (!queue) {
    queue = createWriteQueue();
    importQueuesByStore.set(store, queue);
  }
  return queue(fn);
}

// items: [{ name, candidate, skipReason?, profiles?, label?, enabled?, droppedSettings? }]
export async function importCandidates(
  store,
  vault,
  items,
  { profile = 'all', personal = false, policy = null, actor = { kind: 'owner' }, updateExisting = false } = {},
) {
  return withImportLock(store, async () => {
    const isHosted = Boolean(personal || policy?.personal);
    const activePolicy =
      policy || (isHosted ? createOutboundPolicy({ personal: true, selfIdentity: buildSelfIdentity() }) : null);
    const added = [];
    const updated = [];
    const skipped = [];

    for (const item of items) {
      const label = item.label || item.name;
      if (!item.candidate) {
        skipped.push({
          name: label,
          reason: item.skipReason || item.error || 'Invalid server configuration.',
        });
        continue;
      }

      let candidate = item.candidate;
      const droppedSettings = Array.isArray(item.droppedSettings) ? [...item.droppedSettings] : [];

      if (isHosted) {
        const hosted = sanitizeCandidateForHosted(candidate, null, { outboundPolicy: activePolicy });
        if (hosted.skipReason) {
          skipped.push({ name: label, reason: hosted.skipReason });
          continue;
        }
        candidate = hosted.candidate;
        for (const setting of hosted.droppedSettings) {
          if (!droppedSettings.includes(setting)) droppedSettings.push(setting);
        }
      }

      const existing = await store.list();
      let twin = null;
      if (vault) {
        for (const m of existing) {
          if (await isExactDuplicateForCleanup(candidate, m, vault)) {
            twin = m;
            break;
          }
        }
      } else if (isDuplicateEntry(candidate, existing)) {
        twin = {};
      }
      if (twin) {
        // Only the owner may know every Connection by its name.
        const known = twin.id && actor?.kind === 'owner' ? { existing: { id: twin.id, name: twin.name } } : {};
        skipped.push({ name: label, reason: 'Already exists.', ...known });
        continue;
      }

      const updateTarget = actor?.kind === 'owner' && (item.updateTargetId || updateExisting)
        ? (item.updateTargetId
            ? existing.find((m) => m.id === item.updateTargetId)
            : await findUpdatableConnection(candidate, existing, vault))
        : null;

      if (updateTarget) {
        const mergedProfiles = [...new Set([...(Array.isArray(updateTarget.profiles) ? updateTarget.profiles : ['all']), ...(item.profiles || []), profile].filter(Boolean))];
        const updateInput = {
          transport: candidate.transport,
          ...(candidate.transport === 'stdio'
            ? {
                command: candidate.command,
                args: candidate.args || [],
                ...(candidate.cwd ? { cwd: candidate.cwd } : {}),
              }
            : {
                url: candidate.url,
              }),
          profiles: mergedProfiles,
        };
        try {
          const admitted = await admitConnectionWrite({
            actor,
            policy: activePolicy,
            existing: updateTarget,
            input: updateInput,
            allowVaultRefs: false,
            store,
            vault,
          });
          updated.push({
            entry: admitted.entry,
            secretsMoved: admitted.movedCount,
            warnings: item.warnings || [],
            droppedSettings,
          });
        } catch (err) {
          skipped.push({ name: label, reason: err?.message || 'Could not update existing connection.' });
        }
        continue;
      }

      const enabled = item.enabled !== undefined ? item.enabled !== false : candidate.enabled !== false;
      const profiles = [...(item.profiles || []), profile].filter(Boolean);
      const input = {
        name: candidate.name || item.name,
        transport: candidate.transport,
        ...(candidate.transport === 'stdio'
          ? {
              command: candidate.command,
              args: candidate.args || [],
              env: candidate.env || {},
              ...(candidate.cwd ? { cwd: candidate.cwd } : {}),
            }
          : {
              url: candidate.url,
              headers: candidate.headers || {},
            }),
        enabled,
        profiles,
        ...(Array.isArray(candidate.disabledTools) && candidate.disabledTools.length
          ? { disabledTools: candidate.disabledTools }
          : {}),
        ...(Array.isArray(candidate.allowedTools) && candidate.allowedTools.length
          ? { allowedTools: candidate.allowedTools }
          : {}),
      };

      try {
        const admitted = await admitConnectionWrite({
          actor,
          policy: activePolicy,
          existing: null,
          input,
          allowVaultRefs: false,
          store,
          vault,
        });
        added.push({
          entry: admitted.entry,
          secretsMoved: admitted.movedCount,
          warnings: item.warnings || [],
          droppedSettings,
        });
      } catch (err) {
        skipped.push({ name: label, reason: err?.message || 'Invalid server configuration.' });
      }
    }
    return { added, updated, skipped };
  });
}

/* ---------------- Cleanup other agents' configs (keep only Loop) ---------------- */

// G6-16: Module-level per-realpath async lock for config cleanup writes.
const cleanupFileLocks = new Map();

function withCleanupFileLock(realTarget, fn) {
  let queue = cleanupFileLocks.get(realTarget);
  if (!queue) {
    queue = createWriteQueue();
    cleanupFileLocks.set(realTarget, queue);
  }
  return queue(fn);
}

// G6-18: Match sourceFilter strictly by exact def.id (case-insensitive).
// An explicit empty array [] selects zero agents (never all agents).
function filterSourceDefs(defs, sourceFilter) {
  if (sourceFilter === null || sourceFilter === undefined) return defs;
  if (Array.isArray(sourceFilter)) {
    const wanted = new Set(
      sourceFilter.map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean),
    );
    if (wanted.size === 0) return [];
    return defs.filter((d) => wanted.has(d.id.toLowerCase()));
  }
  if (typeof sourceFilter === 'string') {
    const norm = sourceFilter.trim().toLowerCase();
    if (!norm) return defs;
    return defs.filter((d) => d.id.toLowerCase() === norm);
  }
  return [];
}

async function findExactMatchingLoopEntry(candidate, existingList, vault) {
  if (!candidate) return null;
  for (const m of existingList) {
    if (await isExactDuplicateForCleanup(candidate, m, vault)) return m;
  }
  return null;
}

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findSameNameLoopEntry(serverName, existingList) {
  const target = normName(serverName);
  if (!target) return null;
  return existingList.find((m) => normName(m.name) === target || normName(m.id) === target) || null;
}

function sameBaseEndpoint(candidate, existingList) {
  if (!candidate) return false;
  if (candidate.transport === 'stdio') {
    return existingList.some(
      (m) => (m.transport || 'http') === 'stdio' && m.command === candidate.command,
    );
  }
  if (!candidate.url) return false;
  const canon = canonicalUrlForDuplicateCheck(candidate.url);
  return existingList.some(
    (m) => m.url && canonicalUrlForDuplicateCheck(m.url) === canon,
  );
}

/* ---------------- TOML-aware surgical MCP server remover (G6-06, G6-19) ---------------- */

function consumeNewlineAt(src, p) {
  if (p < src.length && src[p] === '\r' && src[p + 1] === '\n') return p + 2;
  if (p < src.length && src[p] === '\n') return p + 1;
  return p;
}

function findEol(src, p) {
  while (p < src.length && src[p] !== '\n' && src[p] !== '\r') p += 1;
  return p;
}

function readTomlBasicStringToken(src, p) {
  if (src[p] !== '"') return null;
  let i = p + 1;
  let out = '';
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') return { value: out, end: i + 1 };
    if (ch === '\n' || ch === '\r') return null;
    if (ch === '\\') {
      const esc = src[i + 1];
      if (esc !== undefined && Object.hasOwn(TOML_BASIC_ESCAPES, esc)) {
        out += TOML_BASIC_ESCAPES[esc];
        i += 2;
        continue;
      }
      if (esc === 'u' || esc === 'U') {
        const len = esc === 'u' ? 4 : 8;
        const hex = src.slice(i + 2, i + 2 + len);
        if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) return null;
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
        out += String.fromCodePoint(cp);
        i += 2 + len;
        continue;
      }
      return null;
    }
    out += ch;
    i += 1;
  }
  return null;
}

function readTomlLiteralStringToken(src, p) {
  if (src[p] !== "'") return null;
  let i = p + 1;
  while (i < src.length) {
    if (src[i] === "'") return { value: src.slice(p + 1, i), end: i + 1 };
    if (src[i] === '\n' || src[i] === '\r') return null;
    i += 1;
  }
  return null;
}

function skipTomlMultilineBasicToken(src, p) {
  let i = p + 3;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      let look = i + 1;
      while (look < src.length && (src[look] === ' ' || src[look] === '\t')) look += 1;
      if (src[look] === '\r' || src[look] === '\n') {
        i = look;
        while (
          i < src.length &&
          (src[i] === ' ' || src[i] === '\t' || src[i] === '\r' || src[i] === '\n')
        ) {
          i += 1;
        }
        continue;
      }
      const esc = src[i + 1];
      if (esc === 'u') i += 6;
      else if (esc === 'U') i += 10;
      else i += 2;
      continue;
    }
    if (ch === '"') {
      let qCount = 0;
      while (src[i + qCount] === '"') qCount += 1;
      if (qCount >= 3) return i + Math.min(qCount, 5);
      i += qCount;
      continue;
    }
    i += 1;
  }
  return src.length;
}

function skipTomlMultilineLiteralToken(src, p) {
  let i = p + 3;
  while (i < src.length) {
    if (src[i] === "'") {
      let qCount = 0;
      while (src[i + qCount] === "'") qCount += 1;
      if (qCount >= 3) return i + Math.min(qCount, 5);
      i += qCount;
      continue;
    }
    i += 1;
  }
  return src.length;
}

function readTomlKeySegmentToken(src, p) {
  let i = p;
  while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i += 1;
  if (i >= src.length) return null;
  if (src[i] === '"') return readTomlBasicStringToken(src, i);
  if (src[i] === "'") return readTomlLiteralStringToken(src, i);
  const start = i;
  while (i < src.length && /[A-Za-z0-9_-]/.test(src[i])) i += 1;
  if (i === start) return null;
  return { value: src.slice(start, i), end: i };
}

function readTomlKeyPathToken(src, p) {
  const first = readTomlKeySegmentToken(src, p);
  if (!first) return null;
  const segs = [first.value];
  let i = first.end;
  for (;;) {
    while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i += 1;
    if (src[i] !== '.') break;
    i += 1;
    const next = readTomlKeySegmentToken(src, i);
    if (!next) return null;
    segs.push(next.value);
    i = next.end;
  }
  return { segs, end: i };
}

function skipTomlWsNlComments(src, p) {
  let i = p;
  for (;;) {
    while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\r' || src[i] === '\n')) {
      i += 1;
    }
    if (src[i] === '#') {
      i = findEol(src, i);
      continue;
    }
    break;
  }
  return i;
}

function skipTomlValueToken(src, p) {
  let i = p;
  while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i += 1;
  if (i >= src.length) return i;
  const ch = src[i];
  if (ch === '"') {
    if (src.startsWith('"""', i)) return skipTomlMultilineBasicToken(src, i);
    const tok = readTomlBasicStringToken(src, i);
    return tok ? tok.end : findEol(src, i);
  }
  if (ch === "'") {
    if (src.startsWith("'''", i)) return skipTomlMultilineLiteralToken(src, i);
    const tok = readTomlLiteralStringToken(src, i);
    return tok ? tok.end : findEol(src, i);
  }
  if (ch === '[') {
    i += 1;
    while (i < src.length) {
      i = skipTomlWsNlComments(src, i);
      if (i >= src.length) return i;
      if (src[i] === ']') return i + 1;
      if (src[i] === ',') {
        i += 1;
        continue;
      }
      const next = skipTomlValueToken(src, i);
      i = next > i ? next : i + 1;
    }
    return src.length;
  }
  if (ch === '{') {
    i += 1;
    while (i < src.length) {
      i = skipTomlWsNlComments(src, i);
      if (i >= src.length) return i;
      if (src[i] === '}') return i + 1;
      if (src[i] === ',') {
        i += 1;
        continue;
      }
      const kp = readTomlKeyPathToken(src, i);
      if (!kp) {
        i += 1;
        continue;
      }
      i = kp.end;
      while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i += 1;
      if (src[i] === '=') {
        i += 1;
        i = skipTomlValueToken(src, i);
      }
    }
    return src.length;
  }
  // Bare scalar (including space-separated TOML 1.0 datetime).
  const start = i;
  while (i < src.length && !/[\s,\]}#]/.test(src[i])) i += 1;
  const word = src.slice(start, i);
  if (
    TOML_DATE_ONLY_RE.test(word) &&
    src[i] === ' ' &&
    /^\d{2}:\d{2}/.test(src.slice(i + 1, i + 6))
  ) {
    let tPos = i + 1;
    while (tPos < src.length && !/[\s,\]}#]/.test(src[tPos])) tPos += 1;
    if (TOML_DATETIME_RE.test(`${word} ${src.slice(i + 1, tPos)}`)) {
      i = tPos;
    }
  }
  return i;
}

function collectTomlInlineTableRemovals(src, braceStart, braceEnd, removeSet) {
  const entries = [];
  let i = braceStart + 1;
  while (i < braceEnd - 1) {
    i = skipTomlWsNlComments(src, i);
    if (i >= braceEnd - 1 || src[i] === '}') break;
    const entryStart = i;
    const kp = readTomlKeyPathToken(src, i);
    if (!kp) return [];
    i = kp.end;
    while (i < braceEnd - 1 && (src[i] === ' ' || src[i] === '\t')) i += 1;
    if (src[i] !== '=') return [];
    i += 1;
    const valEnd = skipTomlValueToken(src, i);
    i = valEnd;
    let commaPos = -1;
    const afterWs = skipTomlWsNlComments(src, i);
    if (afterWs < braceEnd - 1 && src[afterWs] === ',') {
      commaPos = afterWs;
      i = afterWs + 1;
    } else {
      i = afterWs;
    }
    entries.push({ firstKey: kp.segs[0], entryStart, entryEnd: valEnd, commaPos });
  }

  const removeIdx = new Set();
  entries.forEach((e, idx) => {
    if (removeSet.has(e.firstKey)) removeIdx.add(idx);
  });
  if (removeIdx.size === 0) return [];

  const kept = [];
  for (let idx = 0; idx < entries.length; idx += 1) {
    if (!removeIdx.has(idx)) kept.push(idx);
  }
  const hadTrailingComma = entries.length > 0 && entries[entries.length - 1].commaPos !== -1;
  const lastKept = kept.length > 0 ? kept[kept.length - 1] : -1;
  const dropLastKeptComma = !hadTrailingComma && lastKept !== -1 && lastKept < entries.length - 1;

  const edits = [];
  for (const idx of removeIdx) {
    const e = entries[idx];
    let delStart = e.entryStart;
    let delEnd = e.commaPos !== -1 ? e.commaPos + 1 : e.entryEnd;
    if (e.commaPos !== -1) {
      while (delEnd < braceEnd - 1 && (src[delEnd] === ' ' || src[delEnd] === '\t')) delEnd += 1;
    }
    edits.push([delStart, delEnd]);
  }
  if (dropLastKeptComma) {
    const cPos = entries[lastKept].commaPos;
    if (cPos !== -1) {
      let cEnd = cPos + 1;
      const nextEntry = entries[lastKept + 1];
      if (nextEntry) {
        const between = src.slice(cPos + 1, nextEntry.entryStart);
        if (/^[ \t]*$/.test(between)) cEnd = nextEntry.entryStart;
      }
      edits.push([cPos, cEnd]);
    }
  }
  return edits;
}

function applySpansDeletion(text, rawEdits) {
  if (!rawEdits.length) return text;
  const edits = [...rawEdits].sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  let out = text;
  let lastStart = text.length + 1;
  for (const [start, end] of edits) {
    if (start < 0 || end < start || end > text.length) return text;
    if (end > lastStart) return text; // refuse overlapping edits
    out = out.slice(0, start) + out.slice(end);
    lastStart = start;
  }
  return out;
}

// Removes [mcp_servers.<name>], [mcp_servers.<name>.*], dotted keys, and inline-table entries
// from a Codex TOML file using a full TOML statement/string lexer while preserving comments,
// multi-line strings, [[array.of.tables]] sections, CRLF/LF line endings, and unrelated sections.
export function removeTomlMcpServers(text, namesToRemove) {
  const src = String(text ?? '');
  const removeSet = new Set(namesToRemove || []);
  if (!removeSet.size) return src;

  const bomLen = src.startsWith('\uFEFF') ? 1 : 0;
  let pos = bomLen;
  let currentTable = [];
  let inRemovedTable = false;
  let removedBlockStart = -1;
  let removedLastStmtEnd = -1;
  let removedTrailingBlankEnd = -1;
  const edits = [];

  const flushRemovedBlock = (isAtEof) => {
    if (removedBlockStart === -1) return;
    let delStart = removedBlockStart;
    let delEnd = removedTrailingBlankEnd !== -1 ? removedTrailingBlankEnd : removedLastStmtEnd;
    if (isAtEof) {
      // Trim one preceding blank line when deleting the final section at EOF.
      let back = delStart;
      if (back > bomLen && src[back - 1] === '\n') {
        const nlStart = back >= 2 && src[back - 2] === '\r' ? back - 2 : back - 1;
        let lineScan = nlStart;
        while (lineScan > bomLen && (src[lineScan - 1] === ' ' || src[lineScan - 1] === '\t')) {
          lineScan -= 1;
        }
        if (lineScan === bomLen || src[lineScan - 1] === '\n') {
          delStart = lineScan;
        }
      }
      // If only whitespace remains after removedLastStmtEnd to EOF, delete to EOF.
      if (/^[ \t\r\n]*$/.test(src.slice(removedLastStmtEnd))) {
        delEnd = src.length;
      }
    }
    edits.push([delStart, delEnd]);
    removedBlockStart = -1;
    removedLastStmtEnd = -1;
    removedTrailingBlankEnd = -1;
  };

  while (pos < src.length) {
    const lineStart = pos;
    let p = pos;
    while (p < src.length && (src[p] === ' ' || src[p] === '\t')) p += 1;

    if (p >= src.length) break;

    if (src[p] === '\r' || src[p] === '\n') {
      const nextPos = consumeNewlineAt(src, p);
      if (inRemovedTable && removedTrailingBlankEnd === -1) {
        removedTrailingBlankEnd = nextPos;
      }
      pos = nextPos;
      continue;
    }

    if (src[p] === '#') {
      const eol = findEol(src, p);
      pos = consumeNewlineAt(src, eol);
      continue;
    }

    if (src[p] === '[') {
      const isArray = src[p + 1] === '[';
      const kp = readTomlKeyPathToken(src, p + (isArray ? 2 : 1));
      if (!kp) {
        const eol = findEol(src, p);
        pos = consumeNewlineAt(src, eol);
        continue;
      }
      let closePos = kp.end;
      while (closePos < src.length && (src[closePos] === ' ' || src[closePos] === '\t')) {
        closePos += 1;
      }
      const validClose = isArray
        ? src[closePos] === ']' && src[closePos + 1] === ']'
        : src[closePos] === ']';
      const eol = findEol(src, validClose ? closePos + (isArray ? 2 : 1) : p);
      const nextPos = consumeNewlineAt(src, eol);

      if (!validClose) {
        pos = nextPos;
        continue;
      }

      const isTargetTable =
        kp.segs[0] === 'mcp_servers' && Boolean(kp.segs[1]) && removeSet.has(kp.segs[1]);
      if (isTargetTable) {
        if (!inRemovedTable) {
          inRemovedTable = true;
          removedBlockStart = lineStart;
        }
        removedLastStmtEnd = nextPos;
        removedTrailingBlankEnd = -1;
      } else {
        if (inRemovedTable) {
          flushRemovedBlock(false);
          inRemovedTable = false;
        }
      }
      currentTable = kp.segs;
      pos = nextPos;
      continue;
    }

    // Key = Value statement
    const kp = readTomlKeyPathToken(src, p);
    if (!kp) {
      const eol = findEol(src, p);
      pos = consumeNewlineAt(src, eol);
      continue;
    }
    let eqPos = kp.end;
    while (eqPos < src.length && (src[eqPos] === ' ' || src[eqPos] === '\t')) eqPos += 1;
    if (src[eqPos] !== '=') {
      const eol = findEol(src, p);
      pos = consumeNewlineAt(src, eol);
      continue;
    }
    let valStart = eqPos + 1;
    while (valStart < src.length && (src[valStart] === ' ' || src[valStart] === '\t')) valStart += 1;
    const valEnd = skipTomlValueToken(src, valStart);
    const eol = findEol(src, valEnd);
    const nextPos = consumeNewlineAt(src, eol);

    if (inRemovedTable) {
      removedLastStmtEnd = nextPos;
      removedTrailingBlankEnd = -1;
    } else {
      const fullPath = [...currentTable, ...kp.segs];
      if (fullPath[0] === 'mcp_servers' && fullPath[1] && removeSet.has(fullPath[1])) {
        edits.push([lineStart, nextPos]);
      } else if (
        fullPath.length === 1 &&
        fullPath[0] === 'mcp_servers' &&
        src[valStart] === '{' &&
        valEnd > valStart &&
        src[valEnd - 1] === '}'
      ) {
        const inlineEdits = collectTomlInlineTableRemovals(src, valStart, valEnd, removeSet);
        edits.push(...inlineEdits);
      }
    }
    pos = nextPos;
  }

  if (inRemovedTable) {
    flushRemovedBlock(true);
  }

  return applySpansDeletion(src, edits);
}

/* ---------------- JSONC exact property-range remover (G6-07) ---------------- */

function parseJsoncSpanAst(src) {
  let pos = src.startsWith('\uFEFF') ? 1 : 0;

  function skipTrivia() {
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        pos += 1;
        continue;
      }
      if (ch === '/' && src[pos + 1] === '/') {
        pos += 2;
        while (pos < src.length && src[pos] !== '\n') pos += 1;
        continue;
      }
      if (ch === '/' && src[pos + 1] === '*') {
        pos += 2;
        while (pos < src.length && !(src[pos] === '*' && src[pos + 1] === '/')) pos += 1;
        if (pos >= src.length) throw new Error('Unterminated block comment in JSONC.');
        pos += 2;
        continue;
      }
      break;
    }
  }

  function readString() {
    const start = pos;
    if (src[pos] !== '"') throw new Error('Expected string in JSONC.');
    pos += 1;
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === '\\') {
        pos += 2;
        continue;
      }
      if (ch === '"') {
        pos += 1;
        return { value: JSON.parse(src.slice(start, pos)), start, end: pos };
      }
      pos += 1;
    }
    throw new Error('Unterminated string in JSONC.');
  }

  function parseValue() {
    skipTrivia();
    if (pos >= src.length) throw new Error('Unexpected end of JSONC input.');
    const ch = src[pos];
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (ch === '"') {
      const str = readString();
      return { type: 'primitive', start: str.start, end: str.end };
    }
    const start = pos;
    while (pos < src.length && !/[\s,}\]/]/.test(src[pos])) pos += 1;
    if (pos === start) throw new Error(`Unexpected token "${ch}" in JSONC.`);
    return { type: 'primitive', start, end: pos };
  }

  function parseObject() {
    const start = pos;
    pos += 1; // '{'
    const entries = [];
    for (;;) {
      skipTrivia();
      if (pos >= src.length) throw new Error('Unterminated object in JSONC.');
      if (src[pos] === '}') {
        pos += 1;
        return { type: 'object', start, end: pos, entries };
      }
      const keyTok = readString();
      skipTrivia();
      if (src[pos] !== ':') throw new Error('Expected ":" in JSONC object.');
      pos += 1;
      const value = parseValue();
      skipTrivia();
      let commaPos = -1;
      if (src[pos] === ',') {
        commaPos = pos;
        pos += 1;
      } else if (src[pos] !== '}') {
        throw new Error('Expected "," or "}" in JSONC object.');
      }
      entries.push({
        key: keyTok.value,
        keyStart: keyTok.start,
        keyEnd: keyTok.end,
        value,
        entryStart: keyTok.start,
        entryEnd: value.end,
        commaPos,
      });
    }
  }

  function parseArray() {
    const start = pos;
    pos += 1; // '['
    for (;;) {
      skipTrivia();
      if (pos >= src.length) throw new Error('Unterminated array in JSONC.');
      if (src[pos] === ']') {
        pos += 1;
        return { type: 'array', start, end: pos };
      }
      parseValue();
      skipTrivia();
      if (src[pos] === ',') {
        pos += 1;
      } else if (src[pos] !== ']') {
        throw new Error('Expected "," or "]" in JSONC array.');
      }
    }
  }

  const root = parseValue();
  skipTrivia();
  if (pos < src.length) throw new Error('Unexpected trailing content in JSONC.');
  return root;
}

// Removes ONLY the targeted properties specified by pathSpecs (arrays of property names)
// from a JSON or JSONC string while preserving comments, indentation, trailing commas, and CRLF/LF.
export function removeJsoncKeys(text, pathSpecs) {
  const src = String(text ?? '');
  const specs = Array.isArray(pathSpecs)
    ? pathSpecs.filter((p) => Array.isArray(p) && p.length > 0)
    : [];
  if (!specs.length) return src;

  const bomLen = src.startsWith('\uFEFF') ? 1 : 0;
  let root;
  try {
    root = parseJsoncSpanAst(src);
  } catch {
    return src;
  }

  const removalsByObject = new Map();
  for (const pathArr of specs) {
    let node = root;
    for (let i = 0; i < pathArr.length - 1; i += 1) {
      if (!node || node.type !== 'object') {
        node = null;
        break;
      }
      const key = pathArr[i];
      // If duplicate keys exist, follow the last occurrence (matching JSON.parse semantics).
      let found = null;
      for (const entry of node.entries) {
        if (entry.key === key) found = entry.value;
      }
      node = found;
    }
    if (!node || node.type !== 'object') continue;
    const targetKey = pathArr[pathArr.length - 1];
    for (let idx = 0; idx < node.entries.length; idx += 1) {
      if (node.entries[idx].key === targetKey) {
        if (!removalsByObject.has(node)) removalsByObject.set(node, new Set());
        removalsByObject.get(node).add(idx);
      }
    }
  }

  if (removalsByObject.size === 0) return src;

  const edits = [];
  for (const [objNode, removeIdxSet] of removalsByObject.entries()) {
    const entries = objNode.entries;
    const n = entries.length;
    const keptIndices = [];
    for (let i = 0; i < n; i += 1) {
      if (!removeIdxSet.has(i)) keptIndices.push(i);
    }
    const hadTrailingComma = n > 0 && entries[n - 1].commaPos !== -1;
    const lastKept = keptIndices.length > 0 ? keptIndices[keptIndices.length - 1] : -1;
    const needsLastKeptCommaRemoved = !hadTrailingComma && lastKept !== -1 && lastKept < n - 1;

    const entrySpans = new Map();
    for (const i of removeIdxSet) {
      const e = entries[i];
      let lineLead = e.entryStart;
      while (lineLead > bomLen && (src[lineLead - 1] === ' ' || src[lineLead - 1] === '\t')) {
        lineLead -= 1;
      }
      const isLineStart = lineLead === bomLen || src[lineLead - 1] === '\n';
      const rawEnd = e.commaPos !== -1 ? e.commaPos + 1 : e.entryEnd;
      let afterWs = rawEnd;
      while (afterWs < src.length && (src[afterWs] === ' ' || src[afterWs] === '\t')) {
        afterWs += 1;
      }
      const hasNewlineAfter =
        afterWs < src.length && (src[afterWs] === '\n' || (src[afterWs] === '\r' && src[afterWs + 1] === '\n'));

      let delStart;
      let delEnd;
      if (isLineStart && hasNewlineAfter) {
        delStart = lineLead;
        delEnd = consumeNewlineAt(src, afterWs);
      } else if (e.commaPos !== -1) {
        delStart = e.entryStart;
        delEnd = afterWs;
      } else {
        delStart = isLineStart && src[afterWs] === '}' ? lineLead : e.entryStart;
        delEnd = e.entryEnd;
      }
      entrySpans.set(i, [delStart, delEnd]);
      edits.push([delStart, delEnd]);
    }

    if (needsLastKeptCommaRemoved) {
      const cPos = entries[lastKept].commaPos;
      if (cPos !== -1) {
        let cEnd = cPos + 1;
        const nextSpan = entrySpans.get(lastKept + 1);
        if (nextSpan && nextSpan[0] > cPos) {
          const between = src.slice(cPos + 1, nextSpan[0]);
          if (/^[ \t]*$/.test(between)) cEnd = nextSpan[0];
        }
        edits.push([cPos, cEnd]);
      }
    }
  }

  return applySpansDeletion(src, edits);
}

/* ---------------- Re-parse structural verification (G6-06, G6-07, G6-19) ---------------- */

function deepStructuralEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepStructuralEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.hasOwn(b, k)) return false;
    if (!deepStructuralEqual(a[k], b[k])) return false;
  }
  return true;
}

function hasPathKey(obj, pathArr) {
  let cur = obj;
  for (let i = 0; i < pathArr.length - 1; i += 1) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur, pathArr[i])) {
      return false;
    }
    cur = cur[pathArr[i]];
  }
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return false;
  return Object.hasOwn(cur, pathArr[pathArr.length - 1]);
}

function deletePathKey(obj, pathArr) {
  let cur = obj;
  for (let i = 0; i < pathArr.length - 1; i += 1) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur, pathArr[i])) {
      return;
    }
    cur = cur[pathArr[i]];
  }
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
    delete cur[pathArr[pathArr.length - 1]];
  }
}

function verifyEditedConfig({ beforeParsed, afterText, format, removalSpecs }) {
  let afterParsed;
  try {
    afterParsed = parseByFormat(afterText, format);
  } catch (err) {
    return {
      ok: false,
      error: `Edited config failed verification parse: ${err?.message || 'invalid syntax'}`,
      actuallyRemovedIndices: new Set(),
    };
  }

  const actuallyRemovedIndices = new Set();
  const expectedAfter = structuredClone(beforeParsed);

  for (let i = 0; i < removalSpecs.length; i += 1) {
    const pathArr = removalSpecs[i].path;
    const existedBefore = hasPathKey(beforeParsed, pathArr);
    const existsAfter = hasPathKey(afterParsed, pathArr);
    if (existedBefore && !existsAfter) {
      actuallyRemovedIndices.add(i);
      deletePathKey(expectedAfter, pathArr);
    }
  }

  // In TOML, removing the final [mcp_servers.<name>] table removes the implicit mcp_servers table itself.
  if (
    format === 'toml' &&
    expectedAfter &&
    typeof expectedAfter === 'object' &&
    Object.hasOwn(expectedAfter, 'mcp_servers') &&
    expectedAfter.mcp_servers &&
    typeof expectedAfter.mcp_servers === 'object' &&
    Object.keys(expectedAfter.mcp_servers).length === 0 &&
    !Object.hasOwn(afterParsed, 'mcp_servers')
  ) {
    delete expectedAfter.mcp_servers;
  }

  if (!deepStructuralEqual(expectedAfter, afterParsed)) {
    return {
      ok: false,
      error: 'Verification failed: unexpected changes detected outside target MCP entries.',
      actuallyRemovedIndices: new Set(),
    };
  }

  return {
    ok: true,
    error: null,
    actuallyRemovedIndices,
  };
}

const JSON_SERVER_KEY_BY_ID = JSON_SERVER_KEY_MAP;

async function planCleanupForDefs(
  store,
  { sources: sourceFilter = null, keys = null, approvedTargets = null, onlyReady = true, includeProjectScopes = false, vault = null, ctx = {} } = {},
) {
  const env = ctx.env || process.env;
  const activeVault = vault ?? ctx.vault ?? null;
  const defs = ctx.sources || sourceDefinitions({ home: ctx.home, platform: ctx.platform, env });
  const existing = await store.list();
  const activeDefs = filterSourceDefs(defs, sourceFilter);

  const selected = keys === null ? null : new Set(keys);
  const plans = [];

  for (const def of activeDefs) {
    let filePath = null;
    let realTarget = null;
    let initialBytes = null;
    for (const candidateFile of def.files) {
      try {
        const resolved = await realpath(candidateFile);
        initialBytes = await readFile(resolved);
        filePath = candidateFile;
        realTarget = resolved;
        break;
      } catch {
        // try next path
      }
    }
    if (!filePath || !realTarget || initialBytes === null) continue;

    const beforeHash = createHash('sha256').update(initialBytes).digest('hex');
    const text = initialBytes.toString('utf8');

    let parsed;
    try {
      parsed = parseByFormat(text, def.format);
    } catch (err) {
      plans.push({
        def,
        filePath,
        realTarget,
        beforeHash,
        text,
        parsed: null,
        error: `Could not parse config: ${err?.message || 'invalid syntax'}`,
        removed: [],
        kept: [],
        removalSpecs: [],
      });
      continue;
    }

    const groups = def.extract(parsed);
    const removed = [];
    const kept = [];
    const removalSpecs = [];
    const containerKey = def.format === 'toml' ? 'mcp_servers' : JSON_SERVER_KEY_BY_ID[def.id] || 'mcpServers';

    for (const group of groups) {
      const isProject = Boolean(group.projectPath) || group.origin !== 'user';
      if (isProject && !includeProjectScopes) continue;
      const originMeta = group.projectPath
        ? { origin: group.origin, projectPath: group.projectPath }
        : { origin: group.origin };

      for (const [serverName, rawEntry] of Object.entries(group.servers || {})) {
        const key = connectionDiscoveryKey(def.id, group, serverName);
        const entryHash = createHash('sha256').update(JSON.stringify(rawEntry)).digest('hex');
        const target = JSON.stringify([filePath, realTarget, key, entryHash]);
        if ((selected && !selected.has(key)) || (approvedTargets && !approvedTargets.has(target))) {
          kept.push({ name: serverName, ...originMeta, reason: 'Outside cleanup selection' });
          continue;
        }
        const conv = toCandidate(serverName, rawEntry, def.flavor, env);
        const cand = conv.candidate;
        const isDisabledInAgent =
          cand?.enabled === false || rawEntry?.enabled === false || rawEntry?.disabled === true;

        if ((cand && isLoopItself(cand, ctx)) || /^loop$/i.test(serverName)) {
          kept.push({ name: serverName, ...originMeta, reason: 'Loop gateway (always kept)' });
          continue;
        }

        // G6-04: Exact credential-verified match against Loop entries.
        // Same-name fallback for disabled entries is permitted ONLY when the disabled entry carries no credentials.
        const exactMatch = await findExactMatchingLoopEntry(cand, existing, activeVault);
        const disabledFallback =
          !exactMatch && isDisabledInAgent && (!cand || secretCount(cand) === 0)
            ? findSameNameLoopEntry(serverName, existing)
            : null;
        const match = exactMatch || disabledFallback;

        if (!match) {
          let reason;
          if (cand && sameBaseEndpoint(cand, existing)) {
            reason = 'Credentials or config differ from Loop copy (or could not be verified)';
          } else {
            reason = isDisabledInAgent ? 'Disabled & not in Loop' : 'Not in Loop';
          }
          kept.push({ name: serverName, ...originMeta, reason });
          continue;
        }

        // Disabled entries (in the agent or stored as Off in Loop) are always safe to clean up.
        if (onlyReady && !isDisabledInAgent && match.enabled !== false) {
          if (match.authRequired) {
            kept.push({ name: serverName, ...originMeta, reason: 'Needs sign-in in Loop first' });
            continue;
          }
          if (match.lastError) {
            kept.push({ name: serverName, ...originMeta, reason: `Failed in Loop (${match.lastError})` });
            continue;
          }
        }

        const removedEntry = {
          key, target,
          name: serverName,
          ...originMeta,
          loopId: match.id,
          loopName: match.name,
        };
        const pathArr =
          isProject && def.id === 'claude-code' && group.projectPath
            ? ['projects', group.projectPath, 'mcpServers', serverName]
            : [containerKey, serverName];

        removed.push(removedEntry);
        removalSpecs.push({
          entry: removedEntry,
          serverName,
          isProject,
          projectPath: group.projectPath || null,
          path: pathArr,
        });
      }
    }

    plans.push({
      def,
      filePath,
      realTarget,
      beforeHash,
      text,
      parsed,
      error: null,
      removed,
      kept,
      removalSpecs,
    });
  }

  return plans;
}

// Resolves the exact list of agents, file paths, and server entries targeted for cleanup (G6-18, G3a-07).
export async function resolveCleanupPlan(
  store,
  { sources: sourceFilter = null, keys = null, approvedTargets = null, onlyReady = true, includeProjectScopes = false, vault = null, ctx = {} } = {},
) {
  const plans = await planCleanupForDefs(store, {
    sources: sourceFilter, keys, approvedTargets,
    onlyReady,
    includeProjectScopes,
    vault,
    ctx,
  });

  const agents = [];
  const files = [];
  const targets = [];
  let totalRemoved = 0;
  let totalKept = 0;

  for (const plan of plans) {
    totalRemoved += plan.removed.length;
    totalKept += plan.kept.length;
    agents.push({
      id: plan.def.id,
      label: plan.def.label,
      path: plan.filePath,
      realPath: plan.realTarget,
      ...(plan.error ? { error: plan.error } : {}),
      removed: plan.removed,
      kept: plan.kept,
    });
    if (!plan.error && plan.removed.length > 0) {
      files.push(plan.filePath);
      targets.push({
        id: plan.def.id,
        label: plan.def.label,
        path: plan.filePath,
        realPath: plan.realTarget,
        entries: plan.removed.map(({ key, target }) => ({ key, target })),
        servers: plan.removed.map((r) => r.name),
      });
    }
  }

  return {
    onlyReady,
    includeProjectScopes,
    agents,
    files,
    targets,
    totalRemoved,
    totalKept,
  };
}

export async function cleanupAgentConfigs(
  store,
  {
    sources: sourceFilter = null, keys = null, approvedTargets = null,
    onlyReady = true,
    dryRun = false,
    includeProjectScopes = false,
    vault = null,
    ctx = {},
  } = {},
) {
  const plans = await planCleanupForDefs(store, {
    sources: sourceFilter, keys, approvedTargets,
    onlyReady,
    includeProjectScopes,
    vault,
    ctx,
  });

  const reports = [];
  let totalRemoved = 0;
  let totalKept = 0;

  for (const plan of plans) {
    if (plan.error) {
      reports.push({
        id: plan.def.id,
        label: plan.def.label,
        path: plan.filePath,
        error: plan.error,
        removed: [],
        kept: [],
        backupPath: null,
      });
      continue;
    }

    let finalRemoved = [...plan.removed];
    const finalKept = [...plan.kept];
    let backupPath = null;
    let error = null;

    if (!dryRun && plan.removalSpecs.length > 0) {
      const nextText =
        plan.def.format === 'toml'
          ? removeTomlMcpServers(
              plan.text,
              plan.removalSpecs.filter((s) => !s.isProject).map((s) => s.serverName),
            )
          : removeJsoncKeys(
              plan.text,
              plan.removalSpecs.map((s) => s.path),
            );

      const verified = verifyEditedConfig({
        beforeParsed: plan.parsed,
        afterText: nextText,
        format: plan.def.format,
        removalSpecs: plan.removalSpecs,
      });

      if (!verified.ok) {
        error = verified.error;
        for (const spec of plan.removalSpecs) {
          finalKept.push({
            name: spec.entry.name,
            origin: spec.entry.origin,
            ...(spec.entry.projectPath ? { projectPath: spec.entry.projectPath } : {}),
            reason: verified.error,
          });
        }
        finalRemoved = [];
      } else {
        // G6-19: Report ONLY servers actually gone in the re-parsed output as removed.
        finalRemoved = [];
        for (let i = 0; i < plan.removalSpecs.length; i += 1) {
          const spec = plan.removalSpecs[i];
          if (verified.actuallyRemovedIndices.has(i)) {
            finalRemoved.push(spec.entry);
          } else {
            finalKept.push({
              name: spec.entry.name,
              origin: spec.entry.origin,
              ...(spec.entry.projectPath ? { projectPath: spec.entry.projectPath } : {}),
              reason: 'Could not safely remove from config file',
            });
          }
        }

        // G6-27: Skip backup and write when nothing actually changed.
        if (finalRemoved.length > 0 && nextText !== plan.text) {
          if (typeof ctx._beforeCommit === 'function') {
            await ctx._beforeCommit({
              filePath: plan.filePath,
              realTarget: plan.realTarget,
              def: plan.def,
            });
          }

          const commitResult = await withCleanupFileLock(plan.realTarget, async () => {
            // G6-16: Optimistic CAS check against live file bytes before backup & commit.
            const liveBytes = await readFile(plan.realTarget);
            const liveHash = createHash('sha256').update(liveBytes).digest('hex');
            if (liveHash !== plan.beforeHash) {
              return {
                ok: false,
                error: 'File changed while cleaning; skipped to preserve concurrent edits.',
                backupPath: null,
              };
            }

            // G6-07: Preserve existing permission mode on the real symlink target.
            const targetStat = await stat(plan.realTarget);
            const existingMode = (targetStat.mode & 0o777) || 0o600;

            const tmpPath = path.join(
              path.dirname(plan.realTarget),
              `.${path.basename(plan.realTarget)}.loop-tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
            );
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const candidateBackupPath = `${plan.realTarget}.loop-backup-${stamp}`;

            try {
              await writeFile(tmpPath, nextText, { mode: existingMode });
              await chmod(tmpPath, existingMode);
              await copyFile(plan.realTarget, candidateBackupPath);
              await chmod(candidateBackupPath, 0o600).catch(() => {});
              await rename(tmpPath, plan.realTarget);
              return { ok: true, error: null, backupPath: candidateBackupPath };
            } catch (err) {
              await unlink(tmpPath).catch(() => {});
              throw err;
            }
          });

          if (!commitResult.ok) {
            error = commitResult.error;
            for (const r of finalRemoved) {
              finalKept.push({
                name: r.name,
                origin: r.origin,
                ...(r.projectPath ? { projectPath: r.projectPath } : {}),
                reason: commitResult.error,
              });
            }
            finalRemoved = [];
            backupPath = null;
          } else {
            backupPath = commitResult.backupPath;
          }
        }
      }
    }

    totalRemoved += finalRemoved.length;
    totalKept += finalKept.length;
    reports.push({
      id: plan.def.id,
      label: plan.def.label,
      path: plan.filePath,
      ...(error ? { error } : {}),
      beforeCount: finalRemoved.length + finalKept.length,
      afterCount: finalKept.length,
      removed: finalRemoved,
      kept: finalKept,
      backupPath,
    });
  }

  return {
    dryRun,
    onlyReady,
    totalRemoved,
    totalKept,
    agents: reports,
  };
}
