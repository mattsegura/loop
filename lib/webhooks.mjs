// Loop Signed Inbound Webhooks Store — SQLite WAL registry and durable retry queue.
// Verifies X-Loop-Signature-256 (HMAC-SHA256 over raw request bytes with timingSafeEqual),
// stores signing secrets encrypted inside Loop Vault, and retries failed deliveries with backoff.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { openWorkspaceDb } from './storage/workspace-db.mjs';
import { defaultDataDir } from './vault.mjs';

export const WEBHOOK_TARGET_TYPES = Object.freeze(['notify', 'task', 'tool']);
export const MAX_WEBHOOKS = 100;
const MAX_DELIVERY_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const DEFAULT_HANDLER_TIMEOUT_MS = 45_000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_vault_key TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT 'notify',
  target_config_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  payload_summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wh_deliv_hook ON webhook_deliveries(webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wh_deliv_retry ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_wh_deliv_event ON webhook_deliveries(webhook_id, event_id);
`;

function whError(message, status = 400, code = 'WEBHOOK_INVALID') {
  return Object.assign(new Error(message), { status, code });
}

export function signWebhookPayload(secret, rawBytes) {
  const buf = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(String(rawBytes ?? ''), 'utf8');
  const hex = createHmac('sha256', String(secret)).update(buf).digest('hex');
  return `sha256=${hex}`;
}

export function verifyWebhookSignature(secret, rawBytes, headerValue) {
  if (typeof secret !== 'string' || !secret || typeof headerValue !== 'string' || !headerValue.trim()) {
    return false;
  }
  const given = headerValue.trim();
  if (!given.startsWith('sha256=')) return false;
  const expected = signWebhookPayload(secret, rawBytes);
  if (expected.length !== given.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(given, 'utf8'));
}

function rowToWebhook(row) {
  if (!row) return null;
  let targetConfig = {};
  try {
    const parsed = JSON.parse(row.target_config_json || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) targetConfig = parsed;
  } catch { targetConfig = {}; }
  return {
    id: row.id,
    name: row.name,
    secretVaultKey: row.secret_vault_key,
    targetType: row.target_type,
    targetConfig,
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
    ...(row.event_id ? { eventId: row.event_id } : {}),
    status: row.status,
    attempts: Number(row.attempts) || 0,
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.payload_summary ? { payloadSummary: row.payload_summary } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function runWithTimeout(fn, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(whError(`Webhook handler timed out after ${timeoutMs}ms.`, 504, 'WEBHOOK_TIMEOUT'));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class WebhookStore {
  constructor(dir = defaultDataDir(), { vault = null } = {}) {
    this.dir = dir;
    this.dbFile = path.resolve(dir, 'webhooks.db');
    this.vault = vault;
  }

  _db() {
    return openWorkspaceDb(this.dbFile, { initSql: SCHEMA_SQL });
  }

  async list() {
    const rows = this._db().prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all();
    return rows.map(rowToWebhook);
  }

  async get(id) {
    const row = this._db().prepare('SELECT * FROM webhooks WHERE id = ?').get(String(id || ''));
    return rowToWebhook(row);
  }

  async create(input = {}, { now = Date.now() } = {}) {
    if (!this.vault) throw whError('Vault is required for webhook secret storage.', 503, 'VAULT_UNAVAILABLE');
    const name = String(input.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name) throw whError('name is required for a webhook.', 400);

    const targetType = String(input.targetType || 'notify').trim().toLowerCase();
    if (!WEBHOOK_TARGET_TYPES.includes(targetType)) {
      throw whError(`targetType must be one of: ${WEBHOOK_TARGET_TYPES.join(', ')}.`, 400);
    }

    const targetConfig = input.targetConfig && typeof input.targetConfig === 'object' && !Array.isArray(input.targetConfig)
      ? input.targetConfig
      : {};
    if (targetType === 'tool' && (!targetConfig.toolConnectionId || !targetConfig.toolName)) {
      throw whError('targetConfig.toolConnectionId and targetConfig.toolName are required for targetType "tool".', 400);
    }

    const db = this._db();
    const count = db.prepare('SELECT COUNT(*) AS n FROM webhooks').get()?.n || 0;
    if (count >= MAX_WEBHOOKS) {
      throw whError(`Webhook limit (${MAX_WEBHOOKS}) reached.`, 409, 'WEBHOOK_CAPACITY');
    }

    const id = `whk_${randomBytes(8).toString('hex')}`;
    const secretVaultKey = `__webhook_secret_${id}`;
    const secret = `whsec_${randomBytes(24).toString('hex')}`;
    const enabled = input.enabled === undefined ? true : Boolean(input.enabled);
    const nowIso = new Date(now).toISOString();

    await this.vault.set(secretVaultKey, secret, {
      type: 'api_key',
      description: `Signing secret for webhook ${name}`,
      internal: true,
    });

    db.prepare(`
      INSERT INTO webhooks (id, name, secret_vault_key, target_type, target_config_json, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, secretVaultKey, targetType, JSON.stringify(targetConfig), enabled ? 1 : 0, nowIso, nowIso);

    return {
      webhook: await this.get(id),
      secret,
    };
  }

  async update(id, patch = {}, { now = Date.now() } = {}) {
    const existing = await this.get(id);
    if (!existing) throw whError(`Webhook "${id}" not found.`, 404, 'WEBHOOK_NOT_FOUND');
    const name = patch.name !== undefined
      ? String(patch.name || '').replace(/\s+/g, ' ').trim().slice(0, 120)
      : existing.name;
    if (!name) throw whError('name cannot be empty.', 400);
    const enabled = patch.enabled !== undefined ? Boolean(patch.enabled) : existing.enabled;
    const targetConfig = patch.targetConfig !== undefined
      ? (patch.targetConfig && typeof patch.targetConfig === 'object' && !Array.isArray(patch.targetConfig)
          ? patch.targetConfig
          : existing.targetConfig)
      : existing.targetConfig;
    const nowIso = new Date(now).toISOString();
    this._db().prepare(`
      UPDATE webhooks SET name = ?, enabled = ?, target_config_json = ?, updated_at = ?
      WHERE id = ?
    `).run(name, enabled ? 1 : 0, JSON.stringify(targetConfig), nowIso, existing.id);
    return this.get(existing.id);
  }

  async delete(id) {
    const existing = await this.get(id);
    if (!existing) throw whError(`Webhook "${id}" not found.`, 404, 'WEBHOOK_NOT_FOUND');
    const db = this._db();
    db.prepare('DELETE FROM webhook_deliveries WHERE webhook_id = ?').run(existing.id);
    db.prepare('DELETE FROM webhooks WHERE id = ?').run(existing.id);
    if (this.vault && existing.secretVaultKey) {
      await this.vault.delete(existing.secretVaultKey).catch(() => {});
    }
    return { deleted: true, id: existing.id };
  }

  async listDeliveries(webhookId, { limit = 50 } = {}) {
    const cap = Math.max(1, Math.min(Number(limit) || 50, 200));
    const rows = this._db().prepare(`
      SELECT * FROM webhook_deliveries
      WHERE webhook_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(String(webhookId || ''), cap);
    return rows.map(rowToDelivery);
  }

  async _attemptDelivery(deliveryRow, webhook, handler, { now = Date.now(), timeoutMs = DEFAULT_HANDLER_TIMEOUT_MS } = {}) {
    const db = this._db();
    let payload = {};
    try { payload = JSON.parse(deliveryRow.payload_json || '{}'); } catch { payload = {}; }
    const attempts = (Number(deliveryRow.attempts) || 0) + 1;
    const nowIso = new Date(now).toISOString();
    try {
      await runWithTimeout(
        () => handler(webhook, payload, { deliveryId: deliveryRow.id, eventId: deliveryRow.event_id || '' }),
        timeoutMs,
      );
      db.prepare(`
        UPDATE webhook_deliveries
        SET status = 'ok', attempts = ?, next_attempt_at = '', last_error = '', updated_at = ?
        WHERE id = ?
      `).run(attempts, nowIso, deliveryRow.id);
      return { id: deliveryRow.id, status: 'ok', attempts };
    } catch (err) {
      const errMsg = String(err?.message || 'Webhook delivery failed.').slice(0, 300);
      const isDead = attempts >= MAX_DELIVERY_ATTEMPTS;
      const delayMs = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
      const nextAttemptAt = isDead ? '' : new Date(now + delayMs).toISOString();
      const nextStatus = isDead ? 'dead' : 'failed';
      db.prepare(`
        UPDATE webhook_deliveries
        SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(nextStatus, attempts, nextAttemptAt, errMsg, nowIso, deliveryRow.id);
      return { id: deliveryRow.id, status: nextStatus, attempts, error: errMsg, nextAttemptAt };
    }
  }

  async receive({
    webhookId,
    rawBytes,
    signature,
    eventId = '',
    handler,
    now = Date.now(),
    timeoutMs = DEFAULT_HANDLER_TIMEOUT_MS,
  }) {
    const webhook = await this.get(webhookId);
    if (!webhook) throw whError('Webhook not found.', 404, 'WEBHOOK_NOT_FOUND');
    if (!webhook.enabled) throw whError('Webhook is disabled.', 403, 'WEBHOOK_DISABLED');
    if (!this.vault) throw whError('Vault unavailable.', 503, 'VAULT_UNAVAILABLE');

    const secret = await this.vault.get(webhook.secretVaultKey);
    if (!secret || !verifyWebhookSignature(secret, rawBytes, signature)) {
      throw whError('Invalid webhook signature.', 401, 'WEBHOOK_BAD_SIGNATURE');
    }

    const db = this._db();
    const cleanEventId = String(eventId || '').trim().slice(0, 128);
    if (cleanEventId) {
      const existingOk = db.prepare(`
        SELECT id FROM webhook_deliveries
        WHERE webhook_id = ? AND event_id = ? AND status = 'ok'
        LIMIT 1
      `).get(webhook.id, cleanEventId);
      if (existingOk) {
        return { deliveryId: existingOk.id, duplicate: true, status: 'ok' };
      }
    }

    const rawText = Buffer.isBuffer(rawBytes) ? rawBytes.toString('utf8') : String(rawBytes ?? '');
    let parsedPayload = {};
    if (rawText.trim()) {
      try {
        parsedPayload = JSON.parse(rawText);
      } catch {
        parsedPayload = { raw: rawText.slice(0, 4000) };
      }
    }

    const deliveryId = `whd_${randomBytes(8).toString('hex')}`;
    const nowIso = new Date(now).toISOString();
    const payloadJson = JSON.stringify(parsedPayload).slice(0, 65_536);
    const payloadSummary = payloadJson.slice(0, 240);

    db.prepare(`
      INSERT INTO webhook_deliveries (
        id, webhook_id, event_id, status, attempts, next_attempt_at,
        last_error, payload_json, payload_summary, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', 0, '', '', ?, ?, ?, ?)
    `).run(deliveryId, webhook.id, cleanEventId, payloadJson, payloadSummary, nowIso, nowIso);

    const row = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(deliveryId);
    const outcome = await this._attemptDelivery(row, webhook, handler, { now, timeoutMs });
    return {
      deliveryId,
      duplicate: false,
      ...outcome,
    };
  }

  async processRetries({ handler, now = Date.now(), limit = 20, timeoutMs = DEFAULT_HANDLER_TIMEOUT_MS } = {}) {
    const db = this._db();
    const nowIso = new Date(now).toISOString();
    const due = db.prepare(`
      SELECT * FROM webhook_deliveries
      WHERE status = 'failed' AND next_attempt_at != '' AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC
      LIMIT ?
    `).all(nowIso, Math.max(1, Math.min(Number(limit) || 20, 100)));

    const results = [];
    for (const row of due) {
      const webhook = await this.get(row.webhook_id);
      if (!webhook || !webhook.enabled) {
        db.prepare("UPDATE webhook_deliveries SET status = 'dead', next_attempt_at = '', last_error = 'Webhook missing or disabled', updated_at = ? WHERE id = ?")
          .run(nowIso, row.id);
        results.push({ id: row.id, status: 'dead' });
        continue;
      }
      results.push(await this._attemptDelivery(row, webhook, handler, { now, timeoutMs }));
    }
    return results;
  }
}
