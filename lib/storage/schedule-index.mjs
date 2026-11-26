// Central SQLite wake index for due schedules across all hosted and local workspaces.
// Lets tickSchedules wake evicted/unloaded hosted workspaces when a schedule is due,
// without scanning every workspace directory on every poll.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { openWorkspaceDb } from './workspace-db.mjs';

const WORKSPACE_ID_RE = /^[0-9a-f]{64}$/;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schedule_wake_index (
  workspace_id TEXT PRIMARY KEY,
  next_run_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedule_wake_due ON schedule_wake_index(next_run_at);
`;

export class ScheduleWakeIndex {
  constructor(rootDataDir) {
    this.rootDataDir = path.resolve(rootDataDir);
    this.dbFile = path.join(this.rootDataDir, 'schedule-wake-index.db');
    this._bootstrapped = false;
  }

  _db() {
    return openWorkspaceDb(this.dbFile, { initSql: SCHEMA_SQL });
  }

  update(workspaceId, nextRunAt, now = Date.now()) {
    const wsId = String(workspaceId || 'local').trim() || 'local';
    const next = typeof nextRunAt === 'string' ? nextRunAt.trim() : '';
    const db = this._db();
    if (!next) {
      db.prepare('DELETE FROM schedule_wake_index WHERE workspace_id = ?').run(wsId);
      return;
    }
    db.prepare(`
      INSERT INTO schedule_wake_index (workspace_id, next_run_at, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        next_run_at = excluded.next_run_at,
        updated_at = excluded.updated_at
    `).run(wsId, next, new Date(now).toISOString());
  }

  // One-time scan of existing user workspace directories so schedules written directly to disk
  // or before this index existed are still discovered and woken on time.
  bootstrapFromDisk(usersDir, now = Date.now()) {
    if (this._bootstrapped) return;
    this._bootstrapped = true;
    const scanOne = (wsId, dir) => {
      const schedFile = path.join(dir, 'schedules.db');
      if (!existsSync(schedFile)) return;
      try {
        const sdb = openWorkspaceDb(schedFile);
        const row = sdb
          .prepare("SELECT MIN(next_run_at) AS next_run_at FROM schedules WHERE status = 'active' AND next_run_at != ''")
          .get();
        if (row?.next_run_at) {
          this.update(wsId, row.next_run_at, now);
        }
      } catch {
        // Ignore unreadable or empty workspace databases.
      }
    };
    scanOne('local', this.rootDataDir);
    if (!usersDir || !existsSync(usersDir)) return;
    let entries = [];
    try {
      entries = readdirSync(usersDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || !WORKSPACE_ID_RE.test(ent.name)) continue;
      scanOne(ent.name, path.join(usersDir, ent.name));
    }
  }

  dueWorkspaces(now = Date.now(), { limit = 64 } = {}) {
    const nowIso = new Date(now).toISOString();
    const rows = this._db()
      .prepare(`
        SELECT workspace_id FROM schedule_wake_index
        WHERE next_run_at != '' AND next_run_at <= ?
        ORDER BY next_run_at ASC
        LIMIT ?
      `)
      .all(nowIso, Math.max(1, Math.min(Number(limit) || 64, 500)));
    return rows.map((r) => r.workspace_id);
  }
}
