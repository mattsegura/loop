// SQLite store for built-in Loop Specialist threads, messages, runner config, and secret-free run traces.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { openWorkspaceDb } from './storage/workspace-db.mjs';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT 'all',
  runner TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  cli_session_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  run_id TEXT NOT NULL DEFAULT '',
  steps_json TEXT NOT NULL DEFAULT '[]',
  created_items_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at ASC);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  runner TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  prompt_version TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT 'all',
  focused_node_id TEXT NOT NULL DEFAULT '',
  context_json TEXT NOT NULL DEFAULT '{}',
  user_message TEXT NOT NULL,
  steps_json TEXT NOT NULL DEFAULT '[]',
  created_items_json TEXT NOT NULL DEFAULT '[]',
  assistant_reply TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  flag_note TEXT NOT NULL DEFAULT '',
  flagged_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_flagged ON runs(flagged, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, created_at DESC);
`;

const MAX_TRACES_KEEP = 500;

function makeId(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function safeJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function defaultTitle(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  return clean.length > 64 ? `${clean.slice(0, 63).trimEnd()}…` : clean;
}

function scrub(value, redact) {
  if (typeof redact !== 'function') return value;
  if (typeof value === 'string') return redact(value);
  try {
    return JSON.parse(redact(JSON.stringify(value)));
  } catch {
    return value;
  }
}

export class LoopAgentStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dbFile = path.join(dataDir, 'loop-agent.db');
    this.db = openWorkspaceDb(this.dbFile, { initSql: SCHEMA_SQL });
  }

  getConfig() {
    const rows = this.db.prepare('SELECT key, value FROM config').all();
    const map = {};
    for (const r of rows) map[r.key] = safeJson(r.value, r.value);
    return {
      defaultRunner: typeof map.defaultRunner === 'string' ? map.defaultRunner : '',
      models: map.models && typeof map.models === 'object' && !Array.isArray(map.models) ? map.models : {},
      efforts: map.efforts && typeof map.efforts === 'object' && !Array.isArray(map.efforts) ? map.efforts : {},
      mausbotEndpoint: typeof map.mausbotEndpoint === 'string' ? map.mausbotEndpoint : '',
      mausbotLabel: typeof map.mausbotLabel === 'string' ? map.mausbotLabel : 'MausBot',
    };
  }

  updateConfig(patch = {}) {
    const current = this.getConfig();
    const next = {
      defaultRunner: patch.defaultRunner !== undefined ? String(patch.defaultRunner || '').trim() : current.defaultRunner,
      models: patch.models && typeof patch.models === 'object' && !Array.isArray(patch.models)
        ? { ...current.models, ...patch.models }
        : current.models,
      efforts: patch.efforts && typeof patch.efforts === 'object' && !Array.isArray(patch.efforts)
        ? { ...current.efforts, ...patch.efforts }
        : current.efforts,
      mausbotEndpoint: patch.mausbotEndpoint !== undefined ? String(patch.mausbotEndpoint || '').trim() : current.mausbotEndpoint,
      mausbotLabel: patch.mausbotLabel !== undefined
        ? (String(patch.mausbotLabel || '').trim().slice(0, 60) || 'MausBot')
        : current.mausbotLabel,
    };
    const upsert = this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(next)) {
      upsert.run(k, JSON.stringify(v));
    }
    return next;
  }

  _rowToThread(row) {
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      project: row.project,
      runner: row.runner,
      model: row.model,
      cliSessionId: row.cli_session_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  _rowToMessage(row) {
    if (!row) return null;
    return {
      id: row.id,
      threadId: row.thread_id,
      role: row.role,
      text: row.text,
      runId: row.run_id || '',
      steps: safeJson(row.steps_json, []),
      createdItems: safeJson(row.created_items_json, []),
      createdAt: row.created_at,
    };
  }

  _rowToRun(row) {
    if (!row) return null;
    return {
      id: row.id,
      threadId: row.thread_id,
      runner: row.runner,
      model: row.model,
      promptVersion: row.prompt_version,
      project: row.project,
      focusedNodeId: row.focused_node_id,
      context: safeJson(row.context_json, {}),
      userMessage: row.user_message,
      steps: safeJson(row.steps_json, []),
      createdItems: safeJson(row.created_items_json, []),
      assistantReply: row.assistant_reply,
      error: row.error,
      status: row.status,
      durationMs: Number(row.duration_ms) || 0,
      flagged: Boolean(row.flagged),
      flagNote: row.flag_note || '',
      flaggedAt: row.flagged_at || '',
      createdAt: row.created_at,
      finishedAt: row.finished_at || '',
    };
  }

  listThreads({ limit = 40 } = {}) {
    const cap = Math.max(1, Math.min(Number(limit) || 40, 200));
    const rows = this.db.prepare(
      `SELECT t.*,
              (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
         FROM threads t
        ORDER BY t.updated_at DESC
        LIMIT ?`,
    ).all(cap);
    return rows.map((r) => ({
      ...this._rowToThread(r),
      messageCount: Number(r.message_count) || 0,
    }));
  }

  createThread({ title = 'New chat', project = 'all', runner = '', model = '' } = {}) {
    const now = new Date().toISOString();
    const id = makeId('thr');
    const cleanTitle = defaultTitle(title);
    this.db.prepare(
      `INSERT INTO threads (id, title, project, runner, model, cli_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
    ).run(id, cleanTitle, String(project || 'all'), String(runner || ''), String(model || ''), now, now);
    return this.getThread(id);
  }

  getThread(id) {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(String(id || ''));
    if (!row) return null;
    const msgs = this.db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC').all(row.id);
    const flags = this.db.prepare('SELECT id, flagged, flag_note FROM runs WHERE thread_id = ?').all(row.id);
    const flagByRun = new Map(flags.map((f) => [f.id, { flagged: Boolean(f.flagged), flagNote: f.flag_note || '' }]));
    return {
      ...this._rowToThread(row),
      messages: msgs.map((m) => {
        const msg = this._rowToMessage(m);
        const flag = msg.runId ? flagByRun.get(msg.runId) : null;
        return flag ? { ...msg, flagged: flag.flagged, flagNote: flag.flagNote } : msg;
      }),
    };
  }

  updateThread(id, patch = {}) {
    const existing = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(String(id || ''));
    if (!existing) return null;
    const now = new Date().toISOString();
    const title = patch.title !== undefined ? defaultTitle(patch.title) : existing.title;
    const project = patch.project !== undefined ? String(patch.project || 'all') : existing.project;
    const runner = patch.runner !== undefined ? String(patch.runner || '') : existing.runner;
    const model = patch.model !== undefined ? String(patch.model || '') : existing.model;
    const cliSessionId = patch.cliSessionId !== undefined ? String(patch.cliSessionId || '') : existing.cli_session_id;
    this.db.prepare(
      `UPDATE threads SET title = ?, project = ?, runner = ?, model = ?, cli_session_id = ?, updated_at = ? WHERE id = ?`,
    ).run(title, project, runner, model, cliSessionId, now, existing.id);
    return this.getThread(existing.id);
  }

  deleteThread(id) {
    const info = this.db.prepare('DELETE FROM threads WHERE id = ?').run(String(id || ''));
    return info.changes > 0;
  }

  addMessage({ threadId, role, text, runId = '', steps = [], createdItems = [], redact = null } = {}) {
    const now = new Date().toISOString();
    const id = makeId('msg');
    const cleanText = scrub(String(text || ''), redact);
    const cleanSteps = scrub(Array.isArray(steps) ? steps : [], redact);
    const cleanItems = scrub(Array.isArray(createdItems) ? createdItems : [], redact);
    this.db.prepare(
      `INSERT INTO messages (id, thread_id, role, text, run_id, steps_json, created_items_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, String(threadId), String(role), cleanText, String(runId || ''), JSON.stringify(cleanSteps), JSON.stringify(cleanItems), now);
    this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(now, String(threadId));
    return {
      id,
      threadId: String(threadId),
      role: String(role),
      text: cleanText,
      runId: String(runId || ''),
      steps: cleanSteps,
      createdItems: cleanItems,
      createdAt: now,
    };
  }

  startRun({
    id = makeId('run'),
    threadId,
    runner,
    model = '',
    promptVersion = '',
    project = 'all',
    focusedNodeId = '',
    context = {},
    userMessage,
    redact = null,
  } = {}) {
    const now = new Date().toISOString();
    const cleanMsg = scrub(String(userMessage || ''), redact);
    const cleanCtx = scrub(context && typeof context === 'object' ? context : {}, redact);
    this.db.prepare(
      `INSERT INTO runs (
         id, thread_id, runner, model, prompt_version, project, focused_node_id,
         context_json, user_message, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
    ).run(
      id,
      String(threadId),
      String(runner || ''),
      String(model || ''),
      String(promptVersion || ''),
      String(project || 'all'),
      String(focusedNodeId || ''),
      JSON.stringify(cleanCtx),
      cleanMsg,
      now,
    );
    this._pruneOldRuns();
    return this.getTrace(id);
  }

  finishRun(runId, {
    status = 'completed',
    assistantReply = '',
    steps = [],
    createdItems = [],
    error = '',
    durationMs = 0,
    model = '',
    redact = null,
  } = {}) {
    const now = new Date().toISOString();
    const cleanReply = scrub(String(assistantReply || ''), redact);
    const cleanSteps = scrub(Array.isArray(steps) ? steps : [], redact);
    const cleanItems = scrub(Array.isArray(createdItems) ? createdItems : [], redact);
    const cleanError = scrub(String(error || ''), redact);
    this.db.prepare(
      `UPDATE runs
          SET status = ?,
              model = CASE WHEN ? != '' THEN ? ELSE model END,
              assistant_reply = ?,
              steps_json = ?,
              created_items_json = ?,
              error = ?,
              duration_ms = ?,
              finished_at = ?
        WHERE id = ?`,
    ).run(
      String(status),
      String(model || ''),
      String(model || ''),
      cleanReply,
      JSON.stringify(cleanSteps),
      JSON.stringify(cleanItems),
      cleanError,
      Math.max(0, Math.round(Number(durationMs) || 0)),
      now,
      String(runId),
    );
    return this.getTrace(runId);
  }

  getTrace(runId) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(String(runId || ''));
    return this._rowToRun(row);
  }

  listTraces({ flaggedOnly = false, threadId = '', limit = 40 } = {}) {
    const cap = Math.max(1, Math.min(Number(limit) || 40, 200));
    const clauses = [];
    const params = [];
    if (flaggedOnly) clauses.push('flagged = 1');
    if (threadId) {
      clauses.push('thread_id = ?');
      params.push(String(threadId));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM runs ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, cap);
    return rows.map((r) => this._rowToRun(r));
  }

  flagRun(runId, { flagged = true, note = '', redact = null } = {}) {
    const existing = this.getTrace(runId);
    if (!existing) return null;
    const isFlagged = Boolean(flagged);
    const cleanNote = isFlagged ? scrub(String(note || '').trim().slice(0, 1000), redact) : '';
    const flaggedAt = isFlagged ? new Date().toISOString() : '';
    this.db.prepare('UPDATE runs SET flagged = ?, flag_note = ?, flagged_at = ? WHERE id = ?')
      .run(isFlagged ? 1 : 0, cleanNote, flaggedAt, existing.id);
    return this.getTrace(existing.id);
  }

  _pruneOldRuns() {
    this.db.prepare(
      `DELETE FROM runs
        WHERE flagged = 0
          AND id NOT IN (
            SELECT id FROM runs ORDER BY created_at DESC LIMIT ?
          )`,
    ).run(MAX_TRACES_KEEP);
  }
}
