// Shared Node.js 22 native SQLite (node:sqlite) WAL connection manager for Loop workspaces.
// Keeps persistent per-workspace WAL handles so repeated writes avoid open/close overhead
// and provides atomic online backups via VACUUM INTO.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const openDbs = new Map();

export function openWorkspaceDb(dbFile, { initSql = '' } = {}) {
  const resolved = path.resolve(dbFile);
  let entry = openDbs.get(resolved);
  if (entry) {
    entry.lastUsed = Date.now();
    return entry.db;
  }
  mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  if (initSql) db.exec(initSql);
  entry = { db, lastUsed: Date.now() };
  openDbs.set(resolved, entry);
  return db;
}

export function closeWorkspaceDb(dbFile) {
  const resolved = path.resolve(dbFile);
  const entry = openDbs.get(resolved);
  if (!entry) return;
  openDbs.delete(resolved);
  try { entry.db.close(); } catch { /* ignore */ }
}

export function closeAllWorkspaceDbs() {
  for (const [key, entry] of [...openDbs.entries()]) {
    openDbs.delete(key);
    try { entry.db.close(); } catch { /* ignore */ }
  }
}

export function snapshotWorkspaceDb(dbFile, destFile) {
  const db = openWorkspaceDb(dbFile);
  const escaped = String(destFile).replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
}
