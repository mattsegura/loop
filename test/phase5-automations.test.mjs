import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ScheduleStore } from '../lib/schedules.mjs';
import { signWebhookPayload, verifyWebhookSignature, WebhookStore } from '../lib/webhooks.mjs';
import { Vault } from '../lib/vault.mjs';
import { startServer } from '../server.mjs';

const OWNER_PW = 'phase5-owner-pw-123';

function reqRaw(port, route, { method = 'GET', headers = {}, rawBody = null } = {}) {
  const buf = rawBody === null ? null : Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method,
        headers: {
          ...(buf !== null && !headers['Content-Type'] ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = null; }
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      },
    );
    req.on('error', reject);
    if (buf !== null) req.write(buf);
    req.end();
  });
}

test('Phase 5: ScheduleStore tool runs default to paused, enforce atomic claim lock, and record run history', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-phase5-sched-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {}));

  const store = new ScheduleStore(dir);
  const { schedule } = await store.save({
    title: 'Nightly sync',
    kind: 'interval',
    intervalMinutes: 10,
    action: 'tool',
    tool: 'demo__sync_records',
    toolArgs: { scope: 'recent' },
  });

  // Tool schedules MUST default to paused until Owner activates them.
  assert.equal(schedule.status, 'paused');
  assert.equal(schedule.toolConnectionId, 'demo');
  assert.equal(schedule.toolName, 'sync_records');

  // Activate the schedule and verify overlapping runs are blocked by SQLite claim lock.
  await store.save({ id: schedule.id, status: 'active' });
  let releaseFirst;
  const firstEntered = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let finishFirst;
  const firstBlocker = new Promise((resolve) => {
    finishFirst = resolve;
  });

  let callCount = 0;
  const run1 = store.runNow(schedule.id, {
    executeTool: async () => {
      callCount += 1;
      releaseFirst();
      await firstBlocker;
      return { summary: 'synced 12 items' };
    },
  });

  await firstEntered;
  const overlapping = await store.runNow(schedule.id, {
    executeTool: async () => {
      callCount += 1;
      return { summary: 'should never run' };
    },
  });
  assert.equal(overlapping.status, 'skipped');
  assert.equal(overlapping.reason, 'already_claimed');

  finishFirst();
  const res1 = await run1;
  assert.equal(res1.status, 'ok');
  assert.equal(callCount, 1);

  const runs = await store.listRuns(schedule.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'ok');
  assert.equal(runs[0].resultSummary, 'synced 12 items');
});

test('Phase 5: WebhookStore HMAC raw-byte verification, Vault secret isolation, dedup, and retry queue', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-phase5-wh-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {}));

  const vault = new Vault(dir);
  const whStore = new WebhookStore(dir, { vault });

  const { webhook, secret } = await whStore.create({
    name: 'Stripe Events',
    targetType: 'notify',
    targetConfig: { title: 'Stripe alert' },
  });
  assert.ok(secret.startsWith('whsec_'));
  assert.ok(webhook.secretVaultKey.startsWith('__webhook_secret_'));
  // Public vault listing hides internal webhook secrets.
  const publicSecrets = await vault.list();
  assert.equal(publicSecrets.some((s) => s.key === webhook.secretVaultKey), false);

  const rawBytes = Buffer.from('{"event":"invoice.paid",   "amount": 4900}', 'utf8');
  const validSig = signWebhookPayload(secret, rawBytes);
  assert.equal(verifyWebhookSignature(secret, rawBytes, validSig), true);
  // Changing even whitespace breaks raw-byte HMAC!
  assert.equal(verifyWebhookSignature(secret, Buffer.from('{"event":"invoice.paid","amount":4900}', 'utf8'), validSig), false);

  // Reject bad signature with 401
  await assert.rejects(
    () => whStore.receive({
      webhookId: webhook.id,
      rawBytes,
      signature: 'sha256=deadbeef',
      handler: async () => {},
    }),
    (err) => err.status === 401 && err.code === 'WEBHOOK_BAD_SIGNATURE',
  );

  // Simulate transient failure -> queued for retry -> succeeds on processRetries!
  let failOnce = true;
  const baseNow = 1_750_000_000_000;
  const first = await whStore.receive({
    webhookId: webhook.id,
    rawBytes,
    signature: validSig,
    eventId: 'evt_1',
    now: baseNow,
    handler: async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error('upstream 503');
      }
    },
  });
  assert.equal(first.status, 'failed');
  assert.equal(first.attempts, 1);
  assert.ok(first.nextAttemptAt);

  // Before retry time: nothing retried
  const early = await whStore.processRetries({ now: baseNow + 10_000, handler: async () => {} });
  assert.equal(early.length, 0);

  // After backoff (2 minutes later): succeeds!
  let retriedPayload = null;
  const retried = await whStore.processRetries({
    now: baseNow + 120_000,
    handler: async (_wh, payload) => {
      retriedPayload = payload;
    },
  });
  assert.equal(retried.length, 1);
  assert.equal(retried[0].status, 'ok');
  assert.equal(retriedPayload.amount, 4900);

  // Duplicate eventId after success is skipped idempotently
  const dup = await whStore.receive({
    webhookId: webhook.id,
    rawBytes,
    signature: validSig,
    eventId: 'evt_1',
    now: baseNow + 130_000,
    handler: async () => {
      throw new Error('must not run duplicate');
    },
  });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.status, 'ok');
});

test('Phase 5: End-to-end scheduled tool run (with runtime policy re-check) and signed POST /hooks/:id', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-phase5-e2e-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {}));

  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    if (req.url === '/openapi.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Automation API', version: '1.0.0' },
        servers: [{ url: `http://127.0.0.1:${upstream.address().port}` }],
        paths: {
          '/run': {
            get: {
              operationId: 'triggerJob',
              summary: 'Run job',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      }));
      return;
    }
    upstreamHits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hit: upstreamHits }));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => upstream.close(r)));

  const srv = await startServer({
    port: 0,
    dataDir: dir,
    authMode: 'local-test',
    autoSync: false,
    detectLocalAgents: false,
    billingEnv: {},
  });
  t.after(() => srv.close());

  const setup = await reqRaw(srv.port, '/api/auth/setup', {
    method: 'POST',
    rawBody: JSON.stringify({ password: OWNER_PW }),
  });
  const cookie = String([].concat(setup.headers['set-cookie'])[0] || '').split(';')[0];
  const api = (route, { method = 'GET', body } = {}) =>
    reqRaw(srv.port, route, {
      method,
      headers: { Cookie: cookie },
      rawBody: body === undefined ? null : JSON.stringify(body),
    });

  // Import OpenAPI connection
  const imp = await api('/api/mcps/import-api', {
    method: 'POST',
    body: {
      kind: 'openapi',
      name: 'Auto API',
      url: `http://127.0.0.1:${upstream.address().port}/openapi.json`,
    },
  });
  assert.equal(imp.status, 201);
  const connId = imp.json.connection.id;

  // Create scheduled tool run -> defaults to paused
  const created = await api('/api/schedules', {
    method: 'POST',
    body: {
      title: 'Trigger Auto Job',
      kind: 'interval',
      intervalMinutes: 10,
      action: 'tool',
      tool: `${connId}__triggerjob`,
      toolArgs: {},
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.schedule.status, 'paused');
  const schedId = created.json.schedule.id;

  // Run now -> succeeds and records run history
  const run1 = await api(`/api/schedules/${schedId}/run`, { method: 'POST' });
  assert.equal(run1.status, 200);
  assert.equal(upstreamHits, 1);

  const runsRes = await api(`/api/schedules/${schedId}/runs`);
  assert.equal(runsRes.status, 200);
  assert.equal(runsRes.json.runs.length, 1);
  assert.equal(runsRes.json.runs[0].status, 'ok');

  // Now set policy on this tool to always_ask -> unattended schedule MUST refuse to run!
  assert.equal((await api('/api/policies', {
    method: 'PATCH',
    body: { tools: { [`${connId}__triggerjob`]: 'always_ask' } },
  })).status, 200);

  const blocked = await api(`/api/schedules/${schedId}/run`, { method: 'POST' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, /always_ask/i);
  assert.equal(upstreamHits, 1);

  // Restore policy to auto and test signed POST /hooks/:id -> tool execution
  assert.equal((await api('/api/policies', {
    method: 'PATCH',
    body: { tools: { [`${connId}__triggerjob`]: 'auto' } },
  })).status, 200);

  const whRes = await api('/api/webhooks', {
    method: 'POST',
    body: {
      name: 'Inbound Trigger',
      targetType: 'tool',
      targetConfig: { toolConnectionId: connId, toolName: 'triggerjob' },
    },
  });
  assert.equal(whRes.status, 201);
  const whId = whRes.json.webhook.id;
  const whSecret = whRes.json.secret;

  const rawHookBody = Buffer.from('{"source":"github","ref":"main"}', 'utf8');
  const badHook = await reqRaw(srv.port, `/hooks/${whId}`, {
    method: 'POST',
    headers: { 'X-Loop-Signature-256': 'sha256=0000' },
    rawBody: rawHookBody,
  });
  assert.equal(badHook.status, 401);

  const goodHook = await reqRaw(srv.port, `/hooks/${whId}`, {
    method: 'POST',
    headers: {
      'X-Loop-Signature-256': signWebhookPayload(whSecret, rawHookBody),
      'X-Loop-Event-Id': 'evt_hook_1',
    },
    rawBody: rawHookBody,
  });
  assert.equal(goodHook.status, 200);
  assert.equal(goodHook.json.ok, true);
  assert.equal(upstreamHits, 2);

  const delivRes = await api(`/api/webhooks/${whId}/deliveries`);
  assert.equal(delivRes.status, 200);
  assert.equal(delivRes.json.deliveries.length, 1);
  assert.equal(delivRes.json.deliveries[0].status, 'ok');
});
