// Links between Library items of different kinds: a memory, a saved item, a file or a task.
// The rows are in <dataDir>/library.db.
//
// A link between two memories with one of Memory's own relations stays on the memory
// (lib/memory.mjs), because Memory uses those links to find conflicts. lib/library.mjs sends each
// link to the right place and reads both places as one.
//
// This store keeps rows and nothing more. It does not know if an item exists or who can see it.
// The service checks the two ends before it adds a link, and it hides a link when an end is gone
// or is not visible in the open Project. A row for a deleted item does no harm: ids are never
// used again, and prune() removes such rows a few at a time.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { MEMORY_RELATIONS } from './memory.mjs';
import { openWorkspaceDb } from './storage/workspace-db.mjs';
import { defaultDataDir } from './vault.mjs';

// One vocabulary for all links. The first four are Memory's, with the same names, so a relation
// never changes when a link goes to one store or the other.
export const LINK_RELATIONS = Object.freeze([...MEMORY_RELATIONS, 'cites', 'derived_from', 'part_of']);
const RELATION_SET = new Set(LINK_RELATIONS);
const RELATION_ALIASES = Object.freeze({
  relates_to: 'relates',
  related: 'relates',
  related_to: 'relates',
  references: 'cites',
  reference: 'cites',
  cite: 'cites',
  source: 'derived_from',
  from: 'derived_from',
  derived: 'derived_from',
  based_on: 'derived_from',
  supersedes: 'updates',
  replaces: 'updates',
  update: 'updates',
  extend: 'extends',
  contradict: 'contradicts',
  conflicts: 'contradicts',
  part: 'part_of',
  belongs_to: 'part_of',
});

// The kinds of item that a link can join. People and agents are not items: who wrote an item is
// a fact of the item, not a link.
export const LINK_KINDS = Object.freeze(['memory', 'saved', 'file', 'task']);
const KIND_SET = new Set(LINK_KINDS);
const KIND_PREFIX = Object.freeze({ mem_: 'memory', sav_: 'saved', file_: 'file', task_: 'task' });

export const MAX_LINKS_PER_SAVE = 24;
export const MAX_LINKS_PER_ITEM = 200;
const MAX_ID_LEN = 96;
const ID_CHUNK = 400; // ids in one IN (...) list; SQLite allows 999 parameters

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS library_links (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'relates',
  written_by TEXT NOT NULL DEFAULT 'Owner',
  created_at TEXT NOT NULL,
  UNIQUE(source_id, target_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_library_links_source ON library_links(source_id);
CREATE INDEX IF NOT EXISTS idx_library_links_target ON library_links(target_id);
`;

/** The kind that an id names, from its prefix, or null. A memory key has no prefix. */
export function kindOfId(rawId) {
  const id = String(rawId || '');
  for (const [prefix, kind] of Object.entries(KIND_PREFIX)) {
    if (id.startsWith(prefix)) return kind;
  }
  return null;
}

/** One of LINK_RELATIONS. An unknown word becomes "relates", the relation that claims the least. */
export function normalizeRelation(raw) {
  const clean = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (RELATION_SET.has(clean)) return clean;
  return RELATION_ALIASES[clean] || 'relates';
}

/** A link as a caller wrote it ("sav_1" or { target, relation }) becomes { target, relation }, or null. */
export function normalizeLinkInput(raw) {
  const target = String((typeof raw === 'string' ? raw : raw?.target ?? raw?.targetId ?? raw?.id) || '').trim();
  if (!target || target.length > MAX_ID_LEN) return null;
  return { target, relation: normalizeRelation(typeof raw === 'object' && raw ? raw.relation : '') };
}

function rowToLink(row) {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceKind: row.source_kind,
    targetId: row.target_id,
    targetKind: row.target_kind,
    relation: row.relation,
    writtenBy: row.written_by || 'Owner',
    createdAt: row.created_at,
  };
}

export class LibraryLinkStore {
  constructor(dir = defaultDataDir()) {
    this.dir = dir;
    this.dbFile = path.resolve(dir, 'library.db');
    this._pruneCursor = '';
  }

  _db() {
    return openWorkspaceDb(this.dbFile, { initSql: SCHEMA_SQL });
  }

  /**
   * Adds one link between two items that the caller has checked. The same link again is not a
   * second row. Returns { link, created }, or null when the link is not valid.
   */
  add({ sourceId, sourceKind, targetId, targetKind, relation = 'relates', writtenBy = 'Owner' } = {}) {
    const source = String(sourceId || '').trim();
    const target = String(targetId || '').trim();
    if (!source || !target || source === target) return null;
    if (source.length > MAX_ID_LEN || target.length > MAX_ID_LEN) return null;
    if (!KIND_SET.has(sourceKind) || !KIND_SET.has(targetKind)) return null;
    const rel = normalizeRelation(relation);
    const db = this._db();
    const find = db.prepare('SELECT * FROM library_links WHERE source_id = ? AND target_id = ? AND relation = ?');
    const existing = find.get(source, target, rel);
    if (existing) return { link: rowToLink(existing), created: false };
    const held = db.prepare('SELECT COUNT(*) AS n FROM library_links WHERE source_id = ?').get(source);
    if (Number(held?.n || 0) >= MAX_LINKS_PER_ITEM) return null;
    db.prepare(`
      INSERT INTO library_links (id, source_id, source_kind, target_id, target_kind, relation, written_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `lnk_${randomBytes(6).toString('hex')}`,
      source,
      sourceKind,
      target,
      targetKind,
      rel,
      String(writtenBy || 'Owner').trim().slice(0, 80) || 'Owner',
      new Date().toISOString(),
    );
    return { link: rowToLink(find.get(source, target, rel)), created: true };
  }

  get(linkId) {
    const row = this._db().prepare('SELECT * FROM library_links WHERE id = ?').get(String(linkId || ''));
    return row ? rowToLink(row) : null;
  }

  remove(linkId) {
    const res = this._db().prepare('DELETE FROM library_links WHERE id = ?').run(String(linkId || ''));
    return Number(res?.changes || 0) > 0;
  }

  /** Removes every link from or to an item that is gone for good. */
  removeForItem(itemId) {
    const id = String(itemId || '');
    if (!id) return 0;
    const res = this._db().prepare('DELETE FROM library_links WHERE source_id = ? OR target_id = ?').run(id, id);
    return Number(res?.changes || 0);
  }

  /**
   * An item was replaced by a newer one (a memory that an agent updated): its links go to the
   * newer item. A link that the newer item already has, or a link to itself, is dropped.
   */
  moveItem(fromId, toId) {
    const from = String(fromId || '');
    const to = String(toId || '');
    if (!from || !to || from === to) return 0;
    const db = this._db();
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM library_links WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)').run(from, to, to, from);
      const out = db.prepare('UPDATE OR IGNORE library_links SET source_id = ? WHERE source_id = ?').run(to, from);
      const inn = db.prepare('UPDATE OR IGNORE library_links SET target_id = ? WHERE target_id = ?').run(to, from);
      db.prepare('DELETE FROM library_links WHERE source_id = ? OR target_id = ?').run(from, from);
      db.exec('COMMIT');
      return Number(out?.changes || 0) + Number(inn?.changes || 0);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The links from an item and to it, the newest first. Two indexed lookups. */
  forItem(itemId) {
    const id = String(itemId || '');
    if (!id) return { out: [], in: [] };
    const db = this._db();
    return {
      out: db.prepare('SELECT * FROM library_links WHERE source_id = ? ORDER BY created_at DESC LIMIT ?').all(id, MAX_LINKS_PER_ITEM).map(rowToLink),
      in: db.prepare('SELECT * FROM library_links WHERE target_id = ? ORDER BY created_at DESC LIMIT ?').all(id, MAX_LINKS_PER_ITEM).map(rowToLink),
    };
  }

  /** Every link that touches one of these items, each once. The map asks for all its items at one time. */
  touching(itemIds, { limit = 4000 } = {}) {
    const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).map((id) => String(id || '')).filter(Boolean))];
    const db = this._db();
    const seen = new Map();
    for (let i = 0; i < ids.length && seen.size < limit; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      const marks = chunk.map(() => '?').join(',');
      for (const column of ['source_id', 'target_id']) {
        const rows = db.prepare(`SELECT * FROM library_links WHERE ${column} IN (${marks}) LIMIT ?`).all(...chunk, limit);
        for (const row of rows) {
          if (seen.size >= limit) break;
          if (!seen.has(row.id)) seen.set(row.id, rowToLink(row));
        }
      }
    }
    return [...seen.values()];
  }

  count() {
    return Number(this._db().prepare('SELECT COUNT(*) AS n FROM library_links').get()?.n || 0);
  }

  /**
   * Removes links whose item is gone. It looks at a small batch each call and continues from there
   * on the next call, so no call is slow however many links there are. `exists(id, kind)` answers
   * for an item of any Project, and also for a memory that was set aside and can come back.
   */
  async prune(exists, { batch = 200 } = {}) {
    if (typeof exists !== 'function') return { checked: 0, removed: 0 };
    const db = this._db();
    const rows = db.prepare('SELECT * FROM library_links WHERE id > ? ORDER BY id LIMIT ?').all(this._pruneCursor, batch);
    this._pruneCursor = rows.length < batch ? '' : rows[rows.length - 1].id;
    const known = new Map();
    const alive = async (id, kind) => {
      if (!known.has(id)) known.set(id, Boolean(await exists(id, kind)));
      return known.get(id);
    };
    let removed = 0;
    for (const row of rows) {
      if ((await alive(row.source_id, row.source_kind)) && (await alive(row.target_id, row.target_kind))) continue;
      removed += Number(db.prepare('DELETE FROM library_links WHERE id = ?').run(row.id)?.changes || 0);
    }
    return { checked: rows.length, removed };
  }
}
