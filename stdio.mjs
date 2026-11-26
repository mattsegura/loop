#!/usr/bin/env node
// Lightweight newline-delimited JSON-RPC stdio-to-HTTP bridge for Loop MCP Gateway.
// Usage: LOOP_HUB_TOKEN=loop_... node stdio.mjs [--profile=name]
//        [--url=http://127.0.0.1:8799/mcp] [--token=loop_...]
// Prefer the LOOP_HUB_TOKEN environment variable: command-line flags are visible to other processes.

import readline from 'node:readline';
import { parseLoopPort } from './lib/json-file-store.mjs';

function parseArgs(argv) {
  const envUrl = String(process.env.LOOP_HUB_URL ?? '').trim();
  let explicitUrl = false;
  const out = {
    url: envUrl || null,
    profile: process.env.LOOP_HUB_PROFILE || null,
    token: process.env.LOOP_HUB_TOKEN || null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--url=')) {
      out.url = arg.slice('--url='.length).trim();
      explicitUrl = true;
    } else if (arg === '--url') {
      if (i + 1 >= argv.length) throw new Error('Missing value for --url.');
      out.url = String(argv[++i]).trim();
      explicitUrl = true;
    } else if (arg.startsWith('--profile=')) {
      out.profile = arg.slice('--profile='.length);
    } else if (arg === '--profile') {
      if (i + 1 >= argv.length) throw new Error('Missing value for --profile.');
      out.profile = argv[++i];
    } else if (arg === '--mode') {
      if (i + 1 >= argv.length) throw new Error('Missing value for --mode.');
      i++; // Consume the argument from older configs. Loop has one tool interface.
    } else if (arg.startsWith('--token=')) {
      out.token = arg.slice('--token='.length);
    } else if (arg === '--token') {
      if (i + 1 >= argv.length) throw new Error('Missing value for --token.');
      out.token = argv[++i];
    }
  }

  if (explicitUrl && !out.url) {
    throw new Error('Invalid gateway URL "": expected a valid http:// or https:// URL.');
  }

  if (!out.url) {
    const port = parseLoopPort(process.env.LOOP_HUB_PORT);
    out.url = `http://127.0.0.1:${port}/mcp`;
  }

  return out;
}

function redactUrlSecrets(text, urlObj = null, safeUrl = '') {
  let out = String(text || '');
  if (urlObj && safeUrl) {
    out = out.split(urlObj.href).join(safeUrl);
    if (urlObj.search) out = out.split(urlObj.search).join('');
    if (urlObj.password) out = out.split(urlObj.password).join('***');
    if (urlObj.username) out = out.split(urlObj.username).join('***');
  }
  out = out.replace(/(https?:\/\/)([^/\s@]+)@/gi, '$1***@');
  out = out.replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1');
  return out;
}

let config;
let targetUrl;
try {
  config = parseArgs(process.argv.slice(2));
  try {
    targetUrl = new URL(config.url);
  } catch {
    throw new Error(`Invalid gateway URL "${redactUrlSecrets(config.url)}": expected a valid http:// or https:// URL.`);
  }
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    throw new Error(`Unsupported gateway URL protocol "${targetUrl.protocol}" (expected http: or https:).`);
  }
} catch (err) {
  const oneLine = redactUrlSecrets(err?.message || 'Invalid gateway configuration.')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  process.stderr.write(`[loop-stdio] ${oneLine}\n`);
  process.exit(1);
}

if (config.profile) targetUrl.searchParams.set('profile', config.profile);
if (process.env.LOOP_HUB_PROJECT) targetUrl.searchParams.set('project', process.env.LOOP_HUB_PROJECT);
// Credential-free URL for logs and error messages (never exposes username, password, or query params).
const safeTargetUrl = `${targetUrl.protocol}//${targetUrl.host}${targetUrl.pathname}`;
const authHeaders = config.token ? { Authorization: `Bearer ${config.token}` } : {};
// Loop counts each app as one agent and each initialize as one session.
let sessionId = null;

function writeMessage(payload) {
  const line = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (!line) return;
  try {
    process.stdout.write(`${line}\n`);
  } catch (err) {
    if (err?.code !== 'EPIPE') {
      process.stderr.write(`[loop-stdio] stdout write error: ${err?.message || err}\n`);
    }
  }
}

function flushStdout() {
  return new Promise((resolve) => {
    if (process.stdout.destroyed || !process.stdout.writable) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdout.off('error', finish);
      process.stdout.off('close', finish);
      process.stdout.off('drain', onDrain);
      resolve();
    };
    const timer = setTimeout(finish, 2000);
    timer.unref?.();
    const writeFlush = () => {
      try {
        process.stdout.write('', finish);
      } catch {
        finish();
      }
    };
    const onDrain = () => writeFlush();
    process.stdout.once('error', finish);
    process.stdout.once('close', finish);
    if (process.stdout.writableNeedDrain) {
      process.stdout.once('drain', onDrain);
    } else {
      writeFlush();
    }
  });
}

process.stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') process.exit(0);
});

function extractErrorMessage(body, status) {
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed) return `Loop MCP Gateway returned HTTP ${status}.`;
    try {
      return extractErrorMessage(JSON.parse(trimmed), status);
    } catch {
      return trimmed.slice(0, 300);
    }
  }
  if (body && typeof body === 'object') {
    if (typeof body.error === 'string' && body.error.trim()) return body.error.trim();
    if (typeof body.error?.message === 'string' && body.error.message.trim()) {
      return body.error.message.trim();
    }
    if (typeof body.message === 'string' && body.message.trim()) return body.message.trim();
  }
  return `Loop MCP Gateway error (HTTP ${status}).`;
}

function normalizeJsonRpcResponse(json, requestId, status) {
  if (json && typeof json === 'object' && !Array.isArray(json) && json.jsonrpc === '2.0') {
    const id = json.id !== undefined && json.id !== null ? json.id : requestId;
    if (json.error && typeof json.error === 'object') {
      const code = typeof json.error.code === 'number' ? json.error.code : -32001;
      const message =
        typeof json.error.message === 'string' && json.error.message.trim()
          ? json.error.message
          : `Loop MCP Gateway error (HTTP ${status}).`;
      const error =
        json.error.data !== undefined ? { code, message, data: json.error.data } : { code, message };
      return { jsonrpc: '2.0', id, error };
    }
    if ('result' in json) {
      return { ...json, id };
    }
  }
  return {
    jsonrpc: '2.0',
    id: requestId,
    error: {
      code: -32001,
      message: extractErrorMessage(json, status),
    },
  };
}

const REQUEST_TIMEOUT_MS = Number(process.env.LOOP_STDIO_TIMEOUT_MS) > 0
  ? Number(process.env.LOOP_STDIO_TIMEOUT_MS)
  : 120_000;

async function postToGateway(payload, { includeSession = true, signal = null } = {}) {
  const sentSessionId = includeSession ? sessionId : null;
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Loop-Bridge': 'stdio',
      ...authHeaders,
      ...(sentSessionId ? { 'Mcp-Session-Id': sentSessionId } : {}),
    },
    body: JSON.stringify(payload),
    signal: signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { res, sentSessionId };
}

function isJsonRpcResponse(msg) {
  return Boolean(
    msg &&
    typeof msg === 'object' &&
    !Array.isArray(msg) &&
    !Object.hasOwn(msg, 'method') &&
    msg.id !== undefined &&
    msg.id !== null &&
    (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error')),
  );
}

// Streams SSE events from POST /mcp, immediately forwarding server->client requests
// (e.g., elicitation/create) and notifications to stdout while awaiting the final reply.
async function consumeSseResponse(res, parsed, isBatch, hasId) {
  if (!res.body || typeof res.body.getReader !== 'function') return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const dispatchEvent = (rawEvent) => {
    const dataLines = [];
    for (const line of rawEvent.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        const val = line.slice(5);
        dataLines.push(val.startsWith(' ') ? val.slice(1) : val);
      }
    }
    const dataText = dataLines.join('\n').trim();
    if (!dataText) return;
    let json;
    try {
      json = JSON.parse(dataText);
    } catch {
      return;
    }
    if (Array.isArray(json)) {
      if (hasId) writeMessage(json);
      return;
    }
    if (json && typeof json === 'object' && typeof json.method === 'string') {
      // Server->client request (e.g. elicitation/create) or notification (e.g. progress).
      writeMessage(json);
      return;
    }
    if (hasId) {
      writeMessage(normalizeJsonRpcResponse(json, isBatch ? null : parsed.id, res.status));
    }
  };

  try {
    while (true) {
      let timer;
      const readPromise = reader.read();
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('SSE idle timeout')), REQUEST_TIMEOUT_MS);
        timer.unref?.();
      });
      let chunk;
      try {
        chunk = await Promise.race([readPromise, timeoutPromise]);
      } finally {
        clearTimeout(timer);
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buf))) {
        const frame = buf.slice(0, match.index);
        buf = buf.slice(match.index + match[0].length);
        if (frame.trim()) dispatchEvent(frame);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) dispatchEvent(buf);
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

let initGate = Promise.resolve();
const inFlightRequests = new Map(); // String(id) -> { ac, cancelledByClient: boolean }

async function handleLine(rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed) return;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    writeMessage({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Invalid JSON.' },
    });
    return;
  }

  const isBatch = Array.isArray(parsed);
  const isInitialize = !isBatch && parsed?.method === 'initialize';
  const isClientReply = !isBatch && isJsonRpcResponse(parsed);
  const isCancelNotif = !isBatch && parsed?.method === 'notifications/cancelled' && parsed?.id === undefined;
  const hasId = isBatch
    ? parsed.some((item) => item && typeof item === 'object' && item.id !== undefined && item.id !== null && Object.hasOwn(item, 'method'))
    : Boolean(parsed && typeof parsed === 'object' && parsed.id !== undefined && parsed.id !== null && !isClientReply);

  if (isCancelNotif && parsed?.params?.requestId !== undefined && parsed?.params?.requestId !== null) {
    const entry = inFlightRequests.get(String(parsed.params.requestId));
    if (entry) {
      entry.cancelledByClient = true;
      entry.ac.abort(new Error(parsed.params.reason || 'Cancelled by client'));
    }
  }

  if (!isInitialize) {
    await initGate;
  }

  let releaseInit = null;
  if (isInitialize) {
    initGate = new Promise((resolve) => { releaseInit = resolve; });
  }

  let reqEntry = null;
  const reqIdKey = !isBatch && hasId ? String(parsed.id) : null;
  try {
    // Client JSON-RPC responses (e.g., answering elicitation/create) are posted back with
    // Mcp-Session-Id; the gateway accepts them with HTTP 202 and resumes the open SSE call.
    if (isClientReply) {
      const { res } = await postToGateway(parsed, { includeSession: true });
      if (!res.ok && res.status !== 202) {
        const detail = extractErrorMessage((await res.text()).trim(), res.status);
        process.stderr.write(`[loop-stdio] Client response failed (HTTP ${res.status}): ${detail}\n`);
      }
      return;
    }

    // Never replay a stale scoped request as a stateless, potentially wider call.
    // Keep sending the stale id until the client explicitly reinitializes.
    const isToolCall = !isBatch && parsed?.method === 'tools/call';
    const timeoutMs = isToolCall ? Math.max(REQUEST_TIMEOUT_MS, 600_000) : REQUEST_TIMEOUT_MS;
    const reqAc = new AbortController();
    const timeoutSig = AbortSignal.timeout(timeoutMs);
    const combinedSignal = AbortSignal.any ? AbortSignal.any([reqAc.signal, timeoutSig]) : reqAc.signal;
    if (reqIdKey !== null) {
      reqEntry = { ac: reqAc, cancelledByClient: false };
      inFlightRequests.set(reqIdKey, reqEntry);
    }
    const { res } = await postToGateway(parsed, {
      includeSession: !isInitialize,
      signal: combinedSignal,
    });
    const newSession = res.headers.get('mcp-session-id');
    if (newSession) sessionId = newSession;
    releaseInit?.();
    releaseInit = null;

    if (res.status === 202 || reqEntry?.cancelledByClient) return;

    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/event-stream')) {
      await consumeSseResponse(res, parsed, isBatch, hasId);
      return;
    }

    const text = (await res.text()).trim();

    // JSON-RPC notifications must never write to stdout, even on gateway HTTP errors.
    if (!hasId) {
      if (!res.ok) {
        const detail = extractErrorMessage(text, res.status);
        process.stderr.write(`[loop-stdio] Notification failed (HTTP ${res.status}): ${detail}\n`);
      }
      return;
    }

    if (!text) {
      if (!res.ok && !isBatch) {
        writeMessage({
          jsonrpc: '2.0',
          id: parsed.id,
          error: {
            code: res.status === 401 || res.status === 403 ? -32001 : -32603,
            message: `Loop MCP Gateway returned HTTP ${res.status}.`,
          },
        });
      }
      return;
    }

    try {
      const json = JSON.parse(text);
      if (isBatch && Array.isArray(json)) {
        writeMessage(json);
      } else {
        writeMessage(normalizeJsonRpcResponse(json, parsed.id, res.status));
      }
    } catch {
      if (!isBatch) {
        writeMessage({
          jsonrpc: '2.0',
          id: parsed.id,
          error: {
            code: -32603,
            message: `Invalid response from Loop MCP Gateway (HTTP ${res.status}).`,
          },
        });
      }
    }
  } catch (err) {
    releaseInit?.();
    releaseInit = null;
    if (reqEntry?.cancelledByClient) return;
    const detail = redactUrlSecrets(err?.message || err, targetUrl, safeTargetUrl);
    const message = `Could not reach Loop at ${safeTargetUrl} (${detail}). Make sure that Loop runs, then try again.`;
    if (hasId && !isBatch) {
      writeMessage({
        jsonrpc: '2.0',
        id: parsed.id,
        error: { code: -32603, message },
      });
    } else {
      process.stderr.write(`[loop-stdio] ${message}\n`);
    }
  } finally {
    if (reqIdKey !== null && inFlightRequests.get(reqIdKey) === reqEntry) {
      inFlightRequests.delete(reqIdKey);
    }
  }
}

const pending = new Set();
const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  const task = handleLine(line).finally(() => {
    pending.delete(task);
  });
  pending.add(task);
});

rl.on('close', async () => {
  if (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
  if (sessionId) {
    await fetch(targetUrl, {
      method: 'DELETE',
      headers: { ...authHeaders, 'Mcp-Session-Id': sessionId },
      signal: AbortSignal.timeout(1000),
    }).catch(() => {});
  }
  await flushStdout();
  process.exit(0);
});
