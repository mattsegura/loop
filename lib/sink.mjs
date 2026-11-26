// Canonical immutable destination ("Sink") representation shared across Vault secret binding,
// OAuth origin binding, connection admission, and approval cards/fingerprints.

import { createHash } from 'node:crypto';

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

export function resolveTransportLoose(obj) {
  const raw = String(obj?.transport ?? obj?.type ?? '').trim().toLowerCase();
  if (raw && TRANSPORT_ALIASES[raw]) return TRANSPORT_ALIASES[raw];
  return obj?.command && !obj?.url ? 'stdio' : 'http';
}

export function normalizedOriginOf(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    const u = new URL(rawUrl.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function sinkOf(conn) {
  if (!conn || typeof conn !== 'object') {
    return { transport: 'http', origin: null };
  }
  const transport = resolveTransportLoose(conn);
  if (transport === 'builtin') {
    return {
      transport: 'builtin',
      id: typeof conn.id === 'string' && conn.id.trim() ? conn.id.trim() : null,
    };
  }
  if (transport === 'stdio') {
    return {
      transport: 'stdio',
      command: typeof conn.command === 'string' ? conn.command.trim() : '',
      args: Array.isArray(conn.args) ? conn.args.map(String) : [],
      cwd: typeof conn.cwd === 'string' && conn.cwd.trim() ? conn.cwd.trim() : null,
    };
  }
  const origin =
    Object.hasOwn(conn, 'origin') && conn.url === undefined
      ? typeof conn.origin === 'string'
        ? conn.origin.toLowerCase()
        : null
      : normalizedOriginOf(conn.url);
  return { transport, origin };
}

export function sinksEqual(a, b) {
  const sa = sinkOf(a);
  const sb = sinkOf(b);
  if (sa.transport !== sb.transport) return false;
  if (sa.transport === 'builtin') {
    return sa.id === sb.id;
  }
  if (sa.transport === 'stdio') {
    if (!sa.command || sa.command !== sb.command) return false;
    if (sa.cwd !== sb.cwd) return false;
    if (sa.args.length !== sb.args.length) return false;
    for (let i = 0; i < sa.args.length; i += 1) {
      if (sa.args[i] !== sb.args[i]) return false;
    }
    return true;
  }
  return sa.origin !== null && sa.origin === sb.origin;
}

// Deterministic canonical sink key for binding Vault secrets & OAuth grants to a destination.
// HTTP/SSE: "origin:https://api.example.com"
// Stdio:    "stdio:<sha256-of-canonical-command-args-cwd>"
export function sinkKey(connOrSink) {
  const s =
    connOrSink && typeof connOrSink === 'object' && ('origin' in connOrSink || 'command' in connOrSink) && !('url' in connOrSink)
      ? connOrSink
      : sinkOf(connOrSink);
  if (s.transport === 'builtin') {
    return s.id ? `builtin:${s.id}` : 'builtin';
  }
  if (s.transport === 'stdio') {
    if (!s.command) return null;
    const digest = createHash('sha256')
      .update(JSON.stringify([s.command, s.args || [], s.cwd || null]))
      .digest('hex')
      .slice(0, 24);
    return `stdio:${digest}`;
  }
  if (!s.origin) return null;
  return `origin:${s.origin.toLowerCase()}`;
}

// Human-readable destination label shown prominently on approval cards and audit logs.
export function sinkDisplay(conn) {
  const s = sinkOf(conn);
  if (s.transport === 'builtin') {
    return 'Built-in';
  }
  if (s.transport === 'stdio') {
    const cmdLine = [s.command, ...(s.args || [])].filter(Boolean).join(' ');
    return s.cwd ? `${cmdLine} (cwd: ${s.cwd})` : cmdLine || '(local command)';
  }
  return s.origin || '(unknown origin)';
}

// Normalizes an allowedSinks entry into either:
// - "origin:https://host[:port]"
// - "stdio:<hash>"
// - "conn:<id>" (explicit connection binding fallback)
// Also accepts raw "https://..." / "http://..." URLs and converts them to "origin:..."
export function normalizeAllowedSinkEntry(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512) return null;
  if (trimmed.startsWith('origin:')) {
    const origin = normalizedOriginOf(trimmed.slice('origin:'.length));
    return origin ? `origin:${origin}` : null;
  }
  if (trimmed.startsWith('stdio:')) {
    const hash = trimmed.slice('stdio:'.length).trim().toLowerCase();
    return /^[0-9a-f]{16,64}$/.test(hash) ? `stdio:${hash}` : null;
  }
  if (trimmed.startsWith('conn:')) {
    const id = trimmed.slice('conn:'.length).trim();
    return /^[a-z0-9](?:[a-z0-9_]*[a-z0-9])?$/.test(id) ? `conn:${id}` : null;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const origin = normalizedOriginOf(trimmed);
    return origin ? `origin:${origin}` : null;
  }
  return null;
}

export function normalizeAllowedSinks(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const norm = normalizeAllowedSinkEntry(item);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

// Checks whether a connection matches a secret's allowedSinks list.
export function connectionMatchesAllowedSinks(conn, allowedSinks) {
  if (!Array.isArray(allowedSinks) || allowedSinks.length === 0) return false;
  const key = sinkKey(conn);
  const connTag = conn?.id ? `conn:${conn.id}` : null;
  for (const entry of allowedSinks) {
    const norm = normalizeAllowedSinkEntry(entry);
    if (!norm) continue;
    if (key && norm === key) return true;
    if (connTag && norm === connTag) return true;
  }
  return false;
}
