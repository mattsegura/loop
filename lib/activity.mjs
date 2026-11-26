// SQLite WAL Activity log with 30-day retention, 20,000-row cap, unique call_ reference IDs,
// and structured filters (agents, people, vault, approvals, stopped, before, exact callId).
// Arguments and secret values are never stored.

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { openWorkspaceDb } from './storage/workspace-db.mjs';
import { defaultDataDir } from './vault.mjs';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 20_000;
const PRUNE_EVERY_WRITES = 100;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS activity_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL,
  at TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  agent_name TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT '',
  connection_id TEXT NOT NULL DEFAULT '',
  account TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL DEFAULT '',
  tool_kind TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT 'ok',
  ok INTEGER NOT NULL DEFAULT 1,
  ms INTEGER,
  vault_key TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  extra_json TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_activity_at ON activity_log(at DESC, seq DESC);
CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity_log(agent_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_activity_call_id ON activity_log(call_id);
CREATE INDEX IF NOT EXISTS idx_activity_outcome ON activity_log(outcome, seq DESC);
`;

export function generateCallId() {
  return `call_${randomBytes(7).toString('hex')}`;
}

function deriveOutcome(entry) {
  if (typeof entry?.outcome === 'string' && ['ok', 'error', 'blocked', 'waiting'].includes(entry.outcome)) {
    return entry.outcome;
  }
  if (entry?.ok === false) {
    const err = String(entry?.error || '').toLowerCase();
    if (/block|denied|policy|access_set|rate_limit|local_only|sink_mismatch|not shared|account_choice/.test(err)) {
      return 'blocked';
    }
    return 'error';
  }
  return 'ok';
}

function rowToEntry(row) {
  if (!row) return null;
  let extra = {};
  if (row.extra_json) {
    try { extra = JSON.parse(row.extra_json); } catch { extra = {}; }
  }
  return {
    ...extra,
    callId: row.call_id,
    at: row.at,
    agentId: row.agent_id || null,
    agentName: row.agent_name || undefined,
    method: row.method || undefined,
    target: row.target || undefined,
    ...(row.connection_id ? { connectionId: row.connection_id } : {}),
    ...(row.account ? { account: row.account } : {}),
    ...(row.tool ? { tool: row.tool } : {}),
    ...(row.tool_kind ? { toolKind: row.tool_kind } : {}),
    outcome: row.outcome || (row.ok ? 'ok' : 'error'),
    ok: Boolean(row.ok),
    ...(row.ms !== null && row.ms !== undefined ? { ms: Number(row.ms) } : {}),
    ...(row.vault_key ? { vaultKey: row.vault_key } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

export class ActivityLog {
  constructor(dir = defaultDataDir()) {
    this.dir = dir;
    this.file = path.join(dir, 'activity.jsonl');
    this.dbFile = path.resolve(dir, 'activity.db');
    this.lastSeen = new Map(); // agentId -> ISO timestamp of last request of any kind
    this._queue = Promise.resolve();
    this._listeners = new Set();
    this._migrated = false;
    this._writesSincePrune = 0;
  }

  _db() {
    const db = openWorkspaceDb(this.dbFile, { initSql: SCHEMA_SQL });
    if (!this._migrated) {
      this._migrated = true;
      this._migrateLegacyJsonl(db);
      this._hydrateLastSeen(db);
    }
    return db;
  }

  _migrateLegacyJsonl(db) {
    try {
      const count = db.prepare('SELECT COUNT(*) AS n FROM activity_log').get()?.n || 0;
      if (count > 0 || !existsSync(this.file)) return;
      const raw = readFileSync(this.file, 'utf8');
      const lines = raw.split('\n').filter(Boolean).slice(-MAX_ROWS);
      const insert = db.prepare(`
        INSERT INTO activity_log (
          call_id, at, agent_id, agent_name, method, target, connection_id, account,
          tool, tool_kind, outcome, ok, ms, vault_key, error, extra_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (!parsed || typeof parsed !== 'object') continue;
          const full = this._normalizeEntry(parsed);
          this._insertRow(insert, full);
        } catch {
          // Skip corrupt legacy line.
        }
      }
    } catch {
      // Never fail startup on legacy activity import.
    }
  }

  _hydrateLastSeen(db) {
    try {
      const rows = db.prepare(`
        SELECT agent_id, MAX(at) AS last_at
        FROM activity_log
        WHERE agent_id != ''
        GROUP BY agent_id
      `).all();
      for (const r of rows) {
        if (r.agent_id && r.last_at) this.lastSeen.set(r.agent_id, r.last_at);
      }
    } catch {
      // Ignore read errors.
    }
  }

  _normalizeEntry(entry) {
    const at = typeof entry?.at === 'string' && entry.at ? entry.at : new Date().toISOString();
    const callId = typeof entry?.callId === 'string' && entry.callId.trim() ? entry.callId.trim() : generateCallId();
    const ok = entry?.ok !== undefined ? Boolean(entry.ok) : true;
    const outcome = deriveOutcome({ ...entry, ok });
    let connectionId = typeof entry?.connectionId === 'string' ? entry.connectionId : '';
    let tool = typeof entry?.tool === 'string' ? entry.tool : '';
    if (!connectionId && !tool && typeof entry?.target === 'string' && entry.target.includes('__')) {
      const sep = entry.target.indexOf('__');
      connectionId = entry.target.slice(0, sep);
      tool = entry.target.slice(sep + 2).split(/\s+/)[0];
    }
    let vaultKey = typeof entry?.vaultKey === 'string' ? entry.vaultKey : '';
    if (!vaultKey && String(entry?.method || '').startsWith('secret/') && typeof entry?.target === 'string') {
      vaultKey = entry.target.split(/\s*→\s*/)[0].trim().slice(0, 100);
    }
    return {
      ...entry,
      callId,
      at,
      agentId: entry?.agentId ? String(entry.agentId) : null,
      agentName: typeof entry?.agentName === 'string' ? entry.agentName.slice(0, 120) : '',
      method: typeof entry?.method === 'string' ? entry.method.slice(0, 120) : '',
      target: typeof entry?.target === 'string' ? entry.target.slice(0, 300) : '',
      connectionId: connectionId.slice(0, 120),
      account: typeof entry?.account === 'string' ? entry.account.slice(0, 80) : '',
      tool: tool.slice(0, 120),
      toolKind: typeof entry?.toolKind === 'string' ? entry.toolKind.slice(0, 32) : '',
      outcome,
      ok,
      ms: Number.isFinite(Number(entry?.ms)) ? Math.max(0, Math.round(Number(entry.ms))) : null,
      vaultKey: vaultKey.slice(0, 120),
      error: typeof entry?.error === 'string' ? entry.error.slice(0, 240) : '',
    };
  }

  _insertRow(stmt, full) {
    const known = new Set([
      'callId', 'at', 'agentId', 'agentName', 'method', 'target', 'connectionId', 'account',
      'tool', 'toolKind', 'outcome', 'ok', 'ms', 'vaultKey', 'error',
    ]);
    const extra = {};
    for (const [k, v] of Object.entries(full)) {
      if (!known.has(k) && v !== undefined) extra[k] = v;
    }
    const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : '';
    stmt.run(
      full.callId,
      full.at,
      full.agentId || '',
      full.agentName || '',
      full.method || '',
      full.target || '',
      full.connectionId || '',
      full.account || '',
      full.tool || '',
      full.toolKind || '',
      full.outcome || 'ok',
      full.ok ? 1 : 0,
      full.ms,
      full.vaultKey || '',
      full.error || '',
      extraJson,
    );
  }

  _pruneIfNeeded(db) {
    this._writesSincePrune += 1;
    if (this._writesSincePrune < PRUNE_EVERY_WRITES) return;
    this._writesSincePrune = 0;
    const cutoffIso = new Date(Date.now() - RETENTION_MS).toISOString();
    db.prepare('DELETE FROM activity_log WHERE at < ?').run(cutoffIso);
    const total = db.prepare('SELECT COUNT(*) AS n FROM activity_log').get()?.n || 0;
    if (total > MAX_ROWS) {
      db.prepare(`
        DELETE FROM activity_log WHERE seq NOT IN (
          SELECT seq FROM activity_log ORDER BY seq DESC LIMIT ?
        )
      `).run(MAX_ROWS);
    }
  }

  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }

  _notify(entry) {
    for (const fn of this._listeners) {
      try {
        fn(entry);
      } catch {
        // Ignore SSE listener errors.
      }
    }
  }

  touch(agentId) {
    if (agentId) this.lastSeen.set(agentId, new Date().toISOString());
  }

  record(entry) {
    const full = this._normalizeEntry(entry);
    this.touch(full.agentId);
    this._queue = this._queue
      .then(() => {
        try {
          const db = this._db();
          const insert = db.prepare(`
            INSERT INTO activity_log (
              call_id, at, agent_id, agent_name, method, target, connection_id, account,
              tool, tool_kind, outcome, ok, ms, vault_key, error, extra_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          this._insertRow(insert, full);
          this._pruneIfNeeded(db);
          try {
            mkdirSync(this.dir, { recursive: true, mode: 0o700 });
            appendFileSync(this.file, `${JSON.stringify(full)}\n`, { mode: 0o600 });
          } catch {
            // Mirror write is best-effort for legacy audit/file readers.
          }
        } catch {
          // Log write errors must never break or fail an active tool call.
        }
        this._notify(full);
        return full;
      })
      .catch(() => full);
    return this._queue;
  }

  async getByCallId(callId) {
    await this._queue;
    const clean = String(callId || '').trim();
    if (!clean) return null;
    try {
      const row = this._db().prepare('SELECT * FROM activity_log WHERE call_id = ? LIMIT 1').get(clean);
      return rowToEntry(row);
    } catch {
      return null;
    }
  }

  async listPage({ agentId = null, actor = '', filter = '', before = '', callId = '', limit = 100, offset = 0 } = {}) {
    await this._queue;
    const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 100), 500));
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    try {
      const db = this._db();
      const exactRef = String(callId || '').trim();
      if (exactRef) {
        const row = db.prepare('SELECT * FROM activity_log WHERE call_id = ? LIMIT 1').get(exactRef);
        const entries = row ? [rowToEntry(row)] : [];
        return { entries, total: entries.length, hasMore: false };
      }

      const clauses = [];
      const params = [];
      if (agentId) {
        clauses.push('agent_id = ?');
        params.push(String(agentId));
      }
      const cleanActor = String(actor || '').trim().slice(0, 64);
      if (cleanActor) {
        clauses.push('extra_json LIKE ?');
        params.push(`%"actor":${JSON.stringify(cleanActor)}%`);
      }
      if (before && typeof before === 'string' && before.trim()) {
        clauses.push('at < ?');
        params.push(before.trim());
      }
      const cleanFilter = String(filter || '').trim().toLowerCase();
      if (cleanFilter === 'agents') {
        clauses.push("agent_id != ''");
      } else if (cleanFilter === 'people') {
        clauses.push("(method LIKE 'people/%' OR method LIKE 'share/%')");
      } else if (cleanFilter === 'vault') {
        clauses.push("(vault_key != '' OR method LIKE 'secret/%' OR method LIKE 'vault/%')");
      } else if (cleanFilter === 'approvals') {
        clauses.push("method LIKE 'approval/%'");
      } else if (cleanFilter === 'stopped') {
        clauses.push("(outcome = 'blocked' OR ok = 0)");
      }

      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM activity_log ${where}`).get(...params)?.n || 0;
      const rows = db
        .prepare(`SELECT * FROM activity_log ${where} ORDER BY seq DESC LIMIT ? OFFSET ?`)
        .all(...params, safeLimit, safeOffset);
      const entries = rows.map(rowToEntry);
      return {
        entries,
        total,
        hasMore: safeOffset + entries.length < total,
      };
    } catch {
      return { entries: [], total: 0, hasMore: false };
    }
  }

  async list(opts = {}) {
    const page = await this.listPage(opts);
    return page.entries;
  }

  async lastSeenFor(agentId) {
    try { this._db(); } catch { /* ignore */ }
    return this.lastSeen.get(agentId) || null;
  }

  async flush() {
    await this._queue;
  }
}
