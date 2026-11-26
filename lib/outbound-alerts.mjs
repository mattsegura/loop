// Loop Signed Outbound Alert Webhooks — SQLite WAL registry and durable retry queue.
// Pushes approval.requested, approval.decided, signin.required, and task.completed
// events to any user-configured HTTP endpoint (Slack/Discord/Telegram relay, n8n,
// OpenMausBot, custom mobile push server) with HMAC-SHA256 signatures, Vault-stored
// signing secrets, SSRF protection via createOutboundPolicy, and exponential backoff.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createOutboundPolicy } from './outbound-policy.mjs';
import { openWorkspaceDb } from './storage/workspace-db.mjs';
import { defaultDataDir } from './vault.mjs';
import { signWebhookPayload } from './webhooks.mjs';

export const OUTBOUND_EVENT_TYPES = Object.freeze([
  'approval.requested',
  'approval.decided',
  'signin.required',
  'task.completed',
]);
const OUTBOUND_EVENT_SET = new Set(OUTBOUND_EVENT_TYPES);
export const MAX_OUTBOUND_WEBHOOKS = 50;
const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS outbound_webhooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '["*"]',
  secret_vault_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbound_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER DEFAULT NULL,
  next_attempt_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_out_deliv_hook ON outbound_deliveries(webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_out_deliv_retry ON outbound_deliveries(status, next_attempt_at);
`;

function alertError(message, status = 400, code = 'OUTBOUND_WEBHOOK_INVALID') {
  return Object.assign(new Error(message), { status, code });
}

function normalizeEvents(raw) {
  if (raw === undefined || raw === null) return ['*'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw alertError(`events must be a non-empty array containing "*" or values from: ${OUTBOUND_EVENT_TYPES.join(', ')}.`, 400);
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw alertError('Every event name must be a string.', 400);
    const val = item.trim();
    if (val === '*') return ['*'];
    if (!OUTBOUND_EVENT_SET.has(val)) {
      throw alertError(`Unknown event "${val}". Allowed: ${OUTBOUND_EVENT_TYPES.join(', ')}, *.`, 400);
    }
    if (!seen.has(val)) {
      seen.add(val);
      out.push(val);
    }
  }
  return out;
}

function rowToHook(row) {
  if (!row) return null;
  let events = ['*'];
  try {
    const parsed = JSON.parse(row.events_json || '["*"]');
    if (Array.isArray(parsed) && parsed.length > 0) events = parsed;
  } catch { events = ['*']; }
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events,
    secretVaultKey: row.secret_vault_key,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    webhookId: row.webhook_id,
    eventType: row.event_type,
    status: row.status,
    attempts: Number(row.attempts) || 0,
    ...(row.http_status !== null && row.http_status !== undefined ? { httpStatus: Number(row.http_status) } : {}),
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class OutboundAlertStore {
  constructor(
    dir = defaultDataDir(),
    {
      vault = null,
      personal = false,
      getOutboundPolicy = null,
      fetchImpl = globalThis.fetch,
      allowLoopback = false,
      timeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS,
      redact = null,
    } = {},
  ) {
    this.dir = dir;
    this.dbFile = path.resolve(dir, 'outbound-alerts.db');
    this.vault = vault;
    this.personal = Boolean(personal);
    this.getOutboundPolicy = typeof getOutboundPolicy === 'function' ? getOutboundPolicy : null;
    this.fetchImpl = fetchImpl;
    this.allowLoopback = Boolean(allowLoopback);
    this.timeoutMs = Math.max(500, Number(timeoutMs) || DEFAULT_DELIVERY_TIMEOUT_MS);
    this.redact = typeof redact === 'function' ? redact : null;
  }

  _db() {
    return openWorkspaceDb(this.dbFile, { initSql: SCHEMA_SQL });
  }

  _policy() {
    if (this.getOutboundPolicy) return this.getOutboundPolicy();
    return createOutboundPolicy({ personal: this.personal });
  }

  async _validateTargetUrl(rawUrl) {
    const clean = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!clean) throw alertError('url is required for an outbound webhook.', 400);
    let parsed;
    try {
      parsed = new URL(clean);
    } catch {
      throw alertError('Outbound webhook URL is invalid.', 400);
    }
    if (parsed.username || parsed.password) {
      throw alertError('Outbound webhook URL must not contain embedded credentials.', 400);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw alertError('Outbound webhook URL must use https:// (or http:// only when permitted).', 400);
    }
    const isLoopback =
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '::1' ||
      parsed.hostname === '[::1]';
    if (isLoopback) {
      if (!this.allowLoopback) {
        throw alertError('Outbound webhook URL cannot target localhost or loopback addresses.', 400, 'SSRF_BLOCKED');
      }
      return parsed.href;
    }
    if (parsed.protocol !== 'https:') {
      throw alertError('Outbound webhook URL must use https://.', 400);
    }
    const basePolicy = this._policy();
    const strictPolicy = createOutboundPolicy({
      personal: true,
      selfIdentity: basePolicy?.selfIdentity || null,
    });
    try {
      strictPolicy.assertConnectionUrl(parsed.href);
    } catch (err) {
      throw alertError(err?.publicMessage || err?.message || 'Outbound webhook URL blocked by network policy.', 400, 'SSRF_BLOCKED');
    }
    return parsed.href;
  }

  async list() {
    const rows = this._db().prepare('SELECT * FROM outbound_webhooks ORDER BY created_at DESC').all();
    return rows.map(rowToHook);
  }

  async get(id) {
    const row = this._db().prepare('SELECT * FROM outbound_webhooks WHERE id = ?').get(String(id || ''));
    return rowToHook(row);
  }

  async create(input = {}, { now = Date.now() } = {}) {
    if (!this.vault) throw alertError('Vault is required for outbound webhook signing secrets.', 503, 'VAULT_UNAVAILABLE');
    const name = String(input.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name) throw alertError('name is required for an outbound webhook.', 400);
    const url = await this._validateTargetUrl(input.url);
    const events = normalizeEvents(input.events);

    const db = this._db();
    const count = db.prepare('SELECT COUNT(*) AS n FROM outbound_webhooks').get()?.n || 0;
    if (count >= MAX_OUTBOUND_WEBHOOKS) {
      throw alertError(`Outbound webhook limit (${MAX_OUTBOUND_WEBHOOKS}) reached.`, 409, 'WEBHOOK_CAPACITY');
    }

    const id = `owh_${randomBytes(8).toString('hex')}`;
    const secret = `loop_owh_${randomBytes(24).toString('hex')}`;
    const secretVaultKey = `__outbound_alert_secret_${id}`;
    await this.vault.set(secretVaultKey, secret, `Outbound webhook secret for ${name}`);

    const iso = new Date(now).toISOString();
    const enabled = input.enabled !== false ? 1 : 0;
    db.prepare(
      `INSERT INTO outbound_webhooks (id, name, url, events_json, secret_vault_key, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, url, JSON.stringify(events), secretVaultKey, enabled, iso, iso);

    const webhook = await this.get(id);
    return { webhook, secret };
  }

  async update(id, patch = {}, { now = Date.now() } = {}) {
    const current = await this.get(id);
    if (!current) throw alertError(`Outbound webhook "${id}" not found.`, 404, 'WEBHOOK_NOT_FOUND');

    const name = patch.name !== undefined
      ? String(patch.name || '').replace(/\s+/g, ' ').trim().slice(0, 120)
      : current.name;
    if (!name) throw alertError('name cannot be empty.', 400);
    const url = patch.url !== undefined ? await this._validateTargetUrl(patch.url) : current.url;
    const events = patch.events !== undefined ? normalizeEvents(patch.events) : current.events;
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (current.enabled ? 1 : 0);
    const iso = new Date(now).toISOString();

    this._db()
      .prepare('UPDATE outbound_webhooks SET name = ?, url = ?, events_json = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(name, url, JSON.stringify(events), enabled, iso, current.id);
    return this.get(current.id);
  }

  async delete(id) {
    const current = await this.get(id);
    if (!current) throw alertError(`Outbound webhook "${id}" not found.`, 404, 'WEBHOOK_NOT_FOUND');
    const db = this._db();
    db.prepare('DELETE FROM outbound_deliveries WHERE webhook_id = ?').run(current.id);
    db.prepare('DELETE FROM outbound_webhooks WHERE id = ?').run(current.id);
    if (this.vault && current.secretVaultKey) {
      await this.vault.delete(current.secretVaultKey).catch(() => {});
    }
    return { deleted: true, id: current.id };
  }

  async listDeliveries(webhookId, { limit = 50 } = {}) {
    const cap = Math.min(Math.max(1, Number(limit) || 50), 200);
    const rows = this._db()
      .prepare('SELECT * FROM outbound_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(String(webhookId || ''), cap);
    return rows.map(rowToDelivery);
  }

  async _deliverRow(hook, deliveryRow, { now = Date.now() } = {}) {
    const db = this._db();
    const attempt = (Number(deliveryRow.attempts) || 0) + 1;
    const iso = new Date(now).toISOString();

    let safeUrl;
    try {
      safeUrl = await this._validateTargetUrl(hook.url);
    } catch (err) {
      db.prepare(
        `UPDATE outbound_deliveries
         SET status = 'dead', attempts = ?, http_status = NULL, next_attempt_at = '', last_error = ?, updated_at = ?
         WHERE id = ?`,
      ).run(attempt, String(err?.message || 'Blocked URL').slice(0, 400), iso, deliveryRow.id);
      return { deliveryId: deliveryRow.id, status: 'dead', error: err?.message || 'Blocked URL' };
    }

    const secret = this.vault ? await this.vault.get(hook.secretVaultKey).catch(() => null) : null;
    if (!secret) {
      db.prepare(
        `UPDATE outbound_deliveries
         SET status = 'dead', attempts = ?, next_attempt_at = '', last_error = ?, updated_at = ?
         WHERE id = ?`,
      ).run(attempt, 'Signing secret unavailable in Vault.', iso, deliveryRow.id);
      return { deliveryId: deliveryRow.id, status: 'dead', error: 'Signing secret unavailable.' };
    }

    const bodyStr = String(deliveryRow.payload_json || '{}');
    const signature = signWebhookPayload(secret, bodyStr);
    const timestamp = String(Math.floor(now / 1000));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('Outbound webhook timed out.')), this.timeoutMs);
    timer.unref?.();

    let httpStatus = null;
    let errMsg = '';
    try {
      const targetParsed = new URL(safeUrl);
      const isLoopbackTarget =
        targetParsed.hostname === '127.0.0.1' ||
        targetParsed.hostname === 'localhost' ||
        targetParsed.hostname === '::1' ||
        targetParsed.hostname === '[::1]';
      const activeFetch =
        this.fetchImpl === globalThis.fetch && !isLoopbackTarget
          ? createOutboundPolicy({ personal: true, selfIdentity: this._policy()?.selfIdentity || null }).createFetchForUrl(
              safeUrl,
              { allowedOrigin: targetParsed.origin },
            )
          : this.fetchImpl;
      const resp = await activeFetch(safeUrl, {
        method: 'POST',
        redirect: 'error',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Loop-Outbound-Webhook/1.0',
          'X-Loop-Event': deliveryRow.event_type,
          'X-Loop-Delivery-Id': deliveryRow.id,
          'X-Loop-Timestamp': timestamp,
          'X-Loop-Signature-256': signature,
        },
        body: bodyStr,
      });
      httpStatus = resp.status;
      if (resp.ok) {
        db.prepare(
          `UPDATE outbound_deliveries
           SET status = 'ok', attempts = ?, http_status = ?, next_attempt_at = '', last_error = '', updated_at = ?
           WHERE id = ?`,
        ).run(attempt, httpStatus, iso, deliveryRow.id);
        return { deliveryId: deliveryRow.id, status: 'ok', httpStatus };
      }
      errMsg = `HTTP ${httpStatus}`;
      // Only retry 429 and 5xx; 4xx client errors go straight to dead.
      const retryable = httpStatus === 429 || httpStatus >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        db.prepare(
          `UPDATE outbound_deliveries
           SET status = 'dead', attempts = ?, http_status = ?, next_attempt_at = '', last_error = ?, updated_at = ?
           WHERE id = ?`,
        ).run(attempt, httpStatus, errMsg, iso, deliveryRow.id);
        return { deliveryId: deliveryRow.id, status: 'dead', httpStatus, error: errMsg };
      }
    } catch (err) {
      errMsg = String(err?.message || 'Network delivery failed.').slice(0, 400);
      if (attempt >= MAX_ATTEMPTS) {
        db.prepare(
          `UPDATE outbound_deliveries
           SET status = 'dead', attempts = ?, http_status = NULL, next_attempt_at = '', last_error = ?, updated_at = ?
           WHERE id = ?`,
        ).run(attempt, errMsg, iso, deliveryRow.id);
        return { deliveryId: deliveryRow.id, status: 'dead', error: errMsg };
      }
    } finally {
      clearTimeout(timer);
    }

    const delayMs = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
    const nextIso = new Date(now + delayMs).toISOString();
    db.prepare(
      `UPDATE outbound_deliveries
       SET status = 'retry', attempts = ?, http_status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
    ).run(attempt, httpStatus, nextIso, errMsg, iso, deliveryRow.id);
    return { deliveryId: deliveryRow.id, status: 'retry', httpStatus, nextAttemptAt: nextIso, error: errMsg };
  }

  async emit(eventType, data = {}, { now = Date.now() } = {}) {
    if (!OUTBOUND_EVENT_SET.has(eventType)) return [];
    const hooks = (await this.list()).filter(
      (h) => h.enabled && (h.events.includes('*') || h.events.includes(eventType)),
    );
    if (hooks.length === 0) return [];

    const iso = new Date(now).toISOString();
    const db = this._db();
    const results = [];

    for (const hook of hooks) {
      const deliveryId = `odlv_${randomBytes(8).toString('hex')}`;
      const envelope = {
        id: deliveryId,
        event: eventType,
        timestamp: iso,
        data,
      };
      let payloadStr = JSON.stringify(envelope);
      if (this.redact) {
        try {
          payloadStr = await this.redact(payloadStr);
        } catch {
          // Keep original serialized envelope if redactor fails
        }
      }
      db.prepare(
        `INSERT INTO outbound_deliveries (id, webhook_id, event_type, status, attempts, http_status, next_attempt_at, last_error, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, NULL, '', '', ?, ?, ?)`,
      ).run(deliveryId, hook.id, eventType, payloadStr, iso, iso);

      const row = db.prepare('SELECT * FROM outbound_deliveries WHERE id = ?').get(deliveryId);
      const outcome = await this._deliverRow(hook, row, { now });
      results.push({ webhookId: hook.id, ...outcome });
    }
    return results;
  }

  async processRetries({ now = Date.now() } = {}) {
    const db = this._db();
    const iso = new Date(now).toISOString();
    const due = db
      .prepare(
        `SELECT * FROM outbound_deliveries
         WHERE status = 'retry' AND next_attempt_at != '' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC LIMIT 50`,
      )
      .all(iso);
    const results = [];
    for (const row of due) {
      const hook = await this.get(row.webhook_id);
      if (!hook || !hook.enabled) {
        db.prepare(
          `UPDATE outbound_deliveries SET status = 'dead', next_attempt_at = '', last_error = 'Webhook disabled or deleted.', updated_at = ? WHERE id = ?`,
        ).run(iso, row.id);
        continue;
      }
      results.push(await this._deliverRow(hook, row, { now }));
    }
    return results;
  }
}
