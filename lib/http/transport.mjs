// Shared HTTP, JSON-RPC 2.0, and SSE transport helpers for Loop Gateway.
import { randomBytes } from 'node:crypto';
import { isLoopbackHost, resolvePublicOrigin } from '../mcp-oauth.mjs';

export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
});

export const MAX_JSON_BODY_BYTES = 1024 * 1024; // 1 MiB
export const MAX_FORM_BODY_BYTES = 64 * 1024; // 64 KiB
export const SLOW_CALL_STREAM_AFTER_MS = 20_000;
export const SLOW_CALL_KEEPALIVE_MS = 10_000;

const INTERNAL_ERR_CODES = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'EISDIR', 'ENOTDIR', 'ENOSPC', 'EMFILE',
  'ENFILE', 'EROFS', 'EBUSY', 'EIO', 'EINVAL', 'ENAMETOOLONG', 'EXDEV',
  'ERR_FS_EISDIR', 'ERR_INVALID_ARG_TYPE',
]);

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function sendJson(res, status, data, extraHeaders = {}) {
  if (data === null && status === 202) {
    res.writeHead(202, extraHeaders);
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(data));
}

export function rpcBodyText(payload, rawUnsafeId = null) {
  if (
    rawUnsafeId !== null &&
    payload &&
    !Array.isArray(payload) &&
    typeof payload === 'object' &&
    typeof payload.id === 'number'
  ) {
    const sentinel = `__LOOP_RAW_RPC_ID_${randomBytes(8).toString('hex')}__`;
    return JSON.stringify({ ...payload, id: sentinel }).replace(`"${sentinel}"`, rawUnsafeId);
  }
  return JSON.stringify(payload);
}

export function sendRpcJson(res, status, payload, extraHeaders = {}, rawUnsafeId = null) {
  if (payload === null && status === 202) {
    res.writeHead(202, extraHeaders);
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(rpcBodyText(payload, rawUnsafeId));
}

// Upgrades long tools/call responses (or interactive elicitations) to SSE streams so proxies
// do not drop idle sockets and servers can emit server->client JSON-RPC requests mid-call.
export function keepSlowCallAlive(req, res, msg, { afterMs = SLOW_CALL_STREAM_AFTER_MS, everyMs = SLOW_CALL_KEEPALIVE_MS } = {}) {
  const accepts = String(req.headers.accept || '').toLowerCase().includes('text/event-stream');
  const canStream = Boolean(accepts && isPlainObject(msg) && msg.method === 'tools/call' && msg.id !== undefined && msg.id !== null);
  const progressToken = msg?.params?._meta?.progressToken;
  const started = Date.now();
  let timer = null;
  let beats = 0;
  function ensureStreamHeaders() {
    if (res.writableEnded || res.destroyed || (res.headersSent && !call.streaming)) return false;
    if (!call.streaming) {
      call.streaming = true;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        'X-Accel-Buffering': 'no',
      });
    }
    return true;
  }
  const beat = () => {
    if (!ensureStreamHeaders()) return;
    res.write(': keepalive\n\n');
    if (typeof progressToken === 'string' || typeof progressToken === 'number') {
      beats += 1;
      const message = `Still running after ${Math.round((Date.now() - started) / 1000)} s`;
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: beats, message } })}\n\n`);
    }
    timer = setTimeout(beat, everyMs);
    timer.unref?.();
  };
  function sendEvent(payload) {
    if (!canStream || !ensureStreamHeaders()) return false;
    try {
      res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      clearTimeout(timer);
      timer = setTimeout(beat, everyMs);
      timer.unref?.();
      return true;
    } catch {
      return false;
    }
  }
  function end(payload, rawUnsafeId = null) {
    clearTimeout(timer);
    res.end(`event: message\ndata: ${rpcBodyText(payload, rawUnsafeId)}\n\n`);
  }
  const call = { streaming: false, canStream, sendEvent, stop: () => clearTimeout(timer), end };
  if (canStream) {
    timer = setTimeout(beat, afterMs);
    timer.unref?.();
  }
  return call;
}

function bodyTooLargeError(maxBytes) {
  const label = maxBytes >= 1024 * 1024
    ? `${Math.round(maxBytes / (1024 * 1024))} MiB`
    : `${Math.round(maxBytes / 1024)} KiB`;
  const publicMessage = `Request body too large (max ${label}).`;
  return Object.assign(new Error(publicMessage), {
    status: 413,
    code: 'BODY_TOO_LARGE',
    publicMessage,
    closeConnection: true,
  });
}

// Event-based body reader so over-limit payloads drain without destroying the socket before 413 flushes.
export function readRawBody(req, { maxBytes = MAX_JSON_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      req.on('error', () => {});
      req.resume();
      reject(bodyTooLargeError(maxBytes));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const onData = (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        chunks.length = 0;
        cleanup();
        req.on('error', () => {});
        req.resume();
        reject(bodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(Buffer.concat(chunks, size).toString('utf8'));
    };
    const onError = (err) => {
      if (done) return;
      done = true;
      chunks.length = 0;
      cleanup();
      reject(err);
    };
    const onAborted = () => {
      if (done) return;
      done = true;
      chunks.length = 0;
      cleanup();
      reject(Object.assign(new Error('Request aborted.'), { status: 400, code: 'REQUEST_ABORTED' }));
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

export async function readJsonBody(req, { allowNonObject = false, maxBytes = MAX_JSON_BODY_BYTES } = {}) {
  const raw = await readRawBody(req, { maxBytes });
  const text = raw.trim();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Invalid JSON.'), {
      status: 400,
      code: 'INVALID_JSON',
      publicMessage: 'Invalid JSON.',
    });
  }
  if (!allowNonObject && !isPlainObject(parsed)) {
    throw Object.assign(new Error('JSON object required.'), {
      status: 400,
      code: 'INVALID_BODY',
      publicMessage: 'JSON object required.',
    });
  }
  return parsed;
}

export async function readFormOrJsonBody(req, { maxBytes = MAX_FORM_BODY_BYTES } = {}) {
  const raw = await readRawBody(req, { maxBytes });
  const text = raw.trim();
  if (!text) return {};
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (ct.includes('application/x-www-form-urlencoded')) {
    const out = {};
    for (const [k, v] of new URLSearchParams(text)) {
      if (!(k in out)) out[k] = v;
    }
    return out;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Invalid JSON.'), {
      status: 400,
      code: 'INVALID_JSON',
      publicMessage: 'Invalid JSON.',
    });
  }
  if (!isPlainObject(parsed)) {
    throw Object.assign(new Error('JSON object required.'), {
      status: 400,
      code: 'INVALID_BODY',
      publicMessage: 'JSON object required.',
    });
  }
  return parsed;
}

// Preserves exact raw integer JSON-RPC IDs exceeding Number.MAX_SAFE_INTEGER (G3b-14).
export function extractRawTopLevelIdToken(rawText) {
  if (typeof rawText !== 'string') return null;
  const s = rawText;
  const len = s.length;
  let i = 0;
  const skipWs = () => {
    while (i < len && (s[i] === ' ' || s[i] === '\t' || s[i] === '\r' || s[i] === '\n')) i += 1;
  };
  const scanString = () => {
    if (s[i] !== '"') return -1;
    const start = i;
    i += 1;
    while (i < len) {
      const ch = s[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') { i += 1; return start; }
      i += 1;
    }
    return -1;
  };
  const scanValue = () => {
    skipWs();
    if (i >= len) return;
    if (s[i] === '"') { scanString(); return; }
    if (s[i] === '{' || s[i] === '[') {
      let depth = 0;
      while (i < len) {
        const ch = s[i];
        if (ch === '"') { scanString(); continue; }
        if (ch === '{' || ch === '[') depth += 1;
        else if (ch === '}' || ch === ']') {
          depth -= 1;
          i += 1;
          if (depth === 0) return;
          continue;
        }
        i += 1;
      }
      return;
    }
    while (i < len && s[i] !== ',' && s[i] !== '}' && s[i] !== ']' && s[i] !== ' ' && s[i] !== '\t' && s[i] !== '\r' && s[i] !== '\n') {
      i += 1;
    }
  };

  skipWs();
  if (s[i] !== '{') return null;
  i += 1;
  let unsafeId = null;
  while (i < len) {
    skipWs();
    if (s[i] === '}') break;
    const keyStart = scanString();
    if (keyStart === -1) return null;
    let key;
    try { key = JSON.parse(s.slice(keyStart, i)); } catch { return null; }
    skipWs();
    if (s[i] !== ':') return null;
    i += 1;
    skipWs();
    const valStart = i;
    scanValue();
    const valEnd = i;
    if (key === 'id') {
      const token = s.slice(valStart, valEnd);
      if (/^-?(?:0|[1-9]\d*)$/.test(token) && !Number.isSafeInteger(Number(token))) {
        unsafeId = token;
      } else {
        unsafeId = null;
      }
    }
    skipWs();
    if (s[i] === ',') { i += 1; continue; }
    break;
  }
  return unsafeId;
}

export function isRawInternalError(err) {
  if (!err || typeof err !== 'object') return true;
  if (
    err instanceof TypeError ||
    err instanceof RangeError ||
    err instanceof ReferenceError ||
    err instanceof URIError ||
    err instanceof EvalError
  ) {
    return true;
  }
  if (err instanceof SyntaxError && err.code !== 'INVALID_JSON') return true;
  if (typeof err.code === 'string' && INTERNAL_ERR_CODES.has(err.code)) return true;
  if (typeof err.syscall === 'string' && err.syscall) return true;
  return false;
}

export function formatErrorResponse(err) {
  if (
    err &&
    Number.isInteger(err.status) &&
    err.status >= 400 &&
    err.status < 500 &&
    !isRawInternalError(err)
  ) {
    const message =
      typeof err.publicMessage === 'string' && err.publicMessage
        ? err.publicMessage
        : typeof err.message === 'string' && err.message
          ? err.message
          : 'Request failed.';
    const extraHeaders = err.closeConnection || err.code === 'BODY_TOO_LARGE'
      ? { Connection: 'close' }
      : {};
    return { status: err.status, message, extraHeaders };
  }
  console.error('[loop-server] Internal error:', err);
  return { status: 500, message: 'Internal server error.', extraHeaders: {} };
}

// Canonical public origin using resolvePublicOrigin (G4a-15).
export function resolveLoopPublicOrigin(req, port) {
  const resolved = resolvePublicOrigin(req, port);
  const configured = String(process.env.LOOP_PUBLIC_ORIGIN || '').trim();
  if (configured) {
    try {
      const u = new URL(configured);
      if (u.protocol === 'http:' || u.protocol === 'https:') return resolved;
    } catch {
      // fall through
    }
  }
  let parsed;
  try {
    parsed = new URL(resolved);
  } catch {
    return `http://127.0.0.1:${port}`;
  }
  if (isLoopbackHost(parsed.hostname)) return resolved;
  const headers = req?.headers && typeof req.headers === 'object' ? req.headers : {};
  const hasExplicitProto =
    typeof headers['x-forwarded-proto'] === 'string' ||
    (typeof headers.forwarded === 'string' && /(?:^|[;,\s])proto\s*=/i.test(headers.forwarded));
  if (parsed.protocol === 'http:' && !hasExplicitProto) {
    return `https://${parsed.host}`;
  }
  return resolved;
}

export function mcpUnauthorizedMessage(origin) {
  return `Sign in to Loop to connect this agent (Claude Code: /mcp → loop → Authenticate · Codex: codex mcp login loop · Muse Code: muse mcp login loop · or connect from ${origin}/#agents).`;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}
