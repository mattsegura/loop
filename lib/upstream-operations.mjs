// A receipt is a dispatch fence, not a result cache. SQLite serializes competing
// gateway processes; no transaction spans an upstream call. Crashes after the
// first commit therefore leave an uncertain receipt, never permission to resend.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const OPERATION_ID_PATTERN = '^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$';
export const OPERATION_WINDOW_MS = 7 * 86400_000;
export const OPERATION_LIMIT = 4096;

function digest(input) {
  const canonical = JSON.stringify(input, (_, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
  return createHash('sha256').update(canonical).digest('hex');
}

function withDb(dir, work) {
  const db = new DatabaseSync(join(dir, 'upstream-operations.sqlite'));
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
        ticket TEXT NOT NULL, expires INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0)`);
    return work(db);
  } finally { db.close(); } // also rolls back an interrupted transaction
}

export function reserveOperation(dir, scope, operationId, request, now = Date.now()) {
  const id = digest([scope, operationId]);
  const fingerprint = digest(request);
  return withDb(dir, db => {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM receipts WHERE expires <= ?').run(now);
    const row = db.prepare('SELECT fingerprint, done FROM receipts WHERE id=?').get(id);
    let result;
    if (row) result = { state: row.fingerprint !== fingerprint ? 'conflict' : row.done ? 'completed' : 'uncertain' };
    else if (db.prepare('SELECT count(*) AS n FROM receipts').get().n >= OPERATION_LIMIT) result = { state: 'full' };
    else {
      const ticket = randomUUID();
      db.prepare('INSERT INTO receipts(id,fingerprint,ticket,expires) VALUES(?,?,?,?)').run(id, fingerprint, ticket, now + OPERATION_WINDOW_MS);
      result = { state: 'reserved', id, ticket };
    }
    db.exec('COMMIT');
    return result;
  });
}

export function completeOperation(dir, { id, ticket }) {
  return withDb(dir, db => db.prepare('UPDATE receipts SET done=1 WHERE id=? AND ticket=?').run(id, ticket).changes === 1);
}
