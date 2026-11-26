// Loop Owner Notifications Store & built-in `loop_notify` connection.
// Lets authorized agents alert the Loop owner via Loop Text (iMessage) and the Loop dashboard,
// with per-agent rate limiting, deduplication, and secret redaction/blocking.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { openWorkspaceDb } from './storage/workspace-db.mjs';
import { looksLikeSecret } from './memory.mjs';
import { defaultDataDir } from './vault.mjs';

export const BUILTIN_NOTIFY_ID = 'loop_notify';
export const NOTIFICATION_LEVELS = Object.freeze(['info', 'ok', 'warn', 'urgent']);
const LEVEL_SET = new Set(NOTIFICATION_LEVELS);
const DEFAULT_MAX_PER_HOUR = 10;
const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const MAX_NOTIFICATIONS = 200;

export const BUILTIN_NOTIFY_TOOLS = Object.freeze([
  Object.freeze({
    name: 'notify_owner',
    description:
      'Send a short alert to the Loop owner (delivers via Loop Text / iMessage when connected and always shows in the Loop dashboard). Rate-limited to prevent spam.',
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    }),
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short headline (max 120 chars), e.g. "Build passed".' },
        message: { type: 'string', description: 'Concise notification body (max 600 chars).' },
        level: { type: 'string', enum: ['info', 'ok', 'warn', 'urgent'], default: 'info' },
        project: { type: 'string', description: 'Optional Project id related to this alert.' },
        link: { type: 'string', description: 'Optional public http(s) link for the owner to open.' },
        dedupKey: { type: 'string', description: 'Optional deduplication key to suppress identical alerts within 5 minutes.' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: 'list_notifications',
    description: 'List recent owner notifications sent in this Loop workspace.',
    annotations: Object.freeze({
      readOnlyHint: true,
      openWorldHint: false,
    }),
    inputSchema: {
      type: 'object',
      properties: {
        unreadOnly: { type: 'boolean', default: false },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
  }),
]);

export const BUILTIN_NOTIFY_CONNECTION = Object.freeze({
  id: BUILTIN_NOTIFY_ID,
  name: 'Notify Owner',
  description: 'Built-in rate-limited alert bridge to notify you in Messages (Loop Text) and the Loop dashboard.',
  transport: 'builtin',
  url: null,
  command: null,
  args: [],
  env: {},
  headers: {},
  profiles: ['all'],
  enabled: true,
  disabledTools: [],
  allowedTools: null,
  pinnedTools: ['notify_owner'],
  pinsCustomized: false,
  authRequired: false,
  toolNames: ['notify_owner', 'list_notifications'],
});

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  source_agent_id TEXT NOT NULL DEFAULT '',
  source_agent_name TEXT NOT NULL DEFAULT 'Agent',
  project TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  delivered_sms INTEGER NOT NULL DEFAULT 0,
  sms_note TEXT NOT NULL DEFAULT '',
  dedup_key TEXT NOT NULL DEFAULT '',
  read_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_agent ON notifications(source_agent_id, created_at DESC);
`;

function notifError(message, status = 400, code = 'NOTIFY_INVALID') {
  return Object.assign(new Error(message), { status, code });
}

function rowToNotif(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title || '',
    message: row.message,
    level: row.level || 'info',
    sourceAgentId: row.source_agent_id || '',
    sourceAgentName: row.source_agent_name || 'Agent',
    ...(row.project ? { project: row.project } : {}),
    ...(row.link ? { link: row.link } : {}),
    deliveredSms: Boolean(row.delivered_sms),
    ...(row.sms_note ? { smsNote: row.sms_note } : {}),
    read: Boolean(row.read_at),
    ...(row.read_at ? { readAt: row.read_at } : {}),
    createdAt: row.created_at,
  };
}

export class NotificationStore {
  constructor(dir = defaultDataDir(), { maxPerHour = DEFAULT_MAX_PER_HOUR } = {}) {
    this.dir = dir;
    this.dbFile = path.resolve(dir, 'notifications.db');
    this.maxPerHour = Math.max(1, Number(maxPerHour) || DEFAULT_MAX_PER_HOUR);
  }

  _db() {
    return openWorkspaceDb(this.dbFile, { initSql: SCHEMA_SQL });
  }

  async send(input = {}, { agentId = '', agentName = 'Agent', deliverSms = null, now = Date.now() } = {}) {
    const db = this._db();
    const message = String(input.message || '').trim().slice(0, 600);
    const title = String(input.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!message) throw notifError('message is required.', 400);
    if (looksLikeSecret(title) || looksLikeSecret(message)) {
      throw notifError('Notifications cannot contain secrets or credentials.', 400, 'SECRET_IN_NOTIFY');
    }

    const rawLevel = String(input.level || 'info').trim().toLowerCase();
    const level = LEVEL_SET.has(rawLevel) ? rawLevel : 'info';
    const project = String(input.project || '').trim().slice(0, 80);
    const dedupKey = String(input.dedupKey || '').trim().slice(0, 120);

    let link = '';
    if (typeof input.link === 'string' && input.link.trim()) {
      let parsed;
      try { parsed = new URL(input.link.trim()); } catch { throw notifError('link must be a valid http(s) URL.', 400); }
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
        throw notifError('link must be a public http(s) URL without credentials.', 400);
      }
      link = parsed.href;
    }

    // Per-agent hourly rate limit.
    const rateKey = String(agentId || agentName || 'agent');
    const hourAgoIso = new Date(now - 3_600_000).toISOString();
    const recentCount = db.prepare(
      'SELECT COUNT(*) AS n FROM notifications WHERE source_agent_id = ? AND created_at >= ?',
    ).get(rateKey, hourAgoIso)?.n || 0;
    if (recentCount >= this.maxPerHour) {
      throw notifError(`Notification rate limit reached (${this.maxPerHour}/hour for ${agentName}).`, 429, 'NOTIFY_RATE_LIMIT');
    }

    // Dedup check within 5 minutes.
    if (dedupKey) {
      const windowIso = new Date(now - DEDUP_WINDOW_MS).toISOString();
      const dup = db.prepare(
        'SELECT * FROM notifications WHERE dedup_key = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1',
      ).get(dedupKey, windowIso);
      if (dup) {
        return { notification: rowToNotif(dup), deduplicated: true, deliveredSms: Boolean(dup.delivered_sms) };
      }
    }

    const id = `ntf_${randomBytes(6).toString('hex')}`;
    const nowIso = new Date(now).toISOString();
    let deliveredSms = false;
    let smsNote = '';

    if (typeof deliverSms === 'function') {
      try {
        const text = title ? `${title}: ${message}` : message;
        const smsRes = await deliverSms({ id, title, message: link ? `${text}\n${link}` : text, level, dedupKey: dedupKey || id });
        deliveredSms = Boolean(smsRes?.sent || smsRes?.ok);
        if (!deliveredSms && smsRes?.reason) smsNote = String(smsRes.reason).slice(0, 120);
      } catch (err) {
        smsNote = String(err?.message || 'Loop Text unavailable').slice(0, 120);
      }
    }

    db.prepare(`
      INSERT INTO notifications (
        id, title, message, level, source_agent_id, source_agent_name, project, link,
        delivered_sms, sms_note, dedup_key, read_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)
    `).run(
      id, title, message, level, rateKey, String(agentName || 'Agent').slice(0, 80),
      project, link, deliveredSms ? 1 : 0, smsNote, dedupKey, nowIso,
    );

    // Prune oldest records above cap.
    db.prepare(`
      DELETE FROM notifications WHERE id NOT IN (
        SELECT id FROM notifications ORDER BY created_at DESC LIMIT ?
      )
    `).run(MAX_NOTIFICATIONS);

    const saved = rowToNotif(db.prepare('SELECT * FROM notifications WHERE id = ?').get(id));
    return { notification: saved, deduplicated: false, deliveredSms };
  }

  async list({ unreadOnly = false, limit = 20 } = {}) {
    const size = Math.max(1, Math.min(Number(limit) || 20, 50));
    const rows = this._db().prepare(
      unreadOnly
        ? "SELECT * FROM notifications WHERE read_at = '' ORDER BY created_at DESC LIMIT ?"
        : 'SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?',
    ).all(size);
    const unreadCount = this._db().prepare("SELECT COUNT(*) AS n FROM notifications WHERE read_at = ''").get()?.n || 0;
    return { unreadCount, notifications: rows.map(rowToNotif) };
  }

  async markRead(id = '', { all = false, now = Date.now() } = {}) {
    const db = this._db();
    const nowIso = new Date(now).toISOString();
    if (all) {
      db.prepare("UPDATE notifications SET read_at = ? WHERE read_at = ''").run(nowIso);
      return { ok: true, all: true };
    }
    const res = db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND read_at = ''").run(nowIso, String(id || ''));
    return { ok: true, id: String(id || ''), updated: Number(res?.changes) > 0 };
  }
}
