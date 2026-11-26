import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ApprovalQueue } from '../lib/policies.mjs';
import { OutboundAlertStore } from '../lib/outbound-alerts.mjs';
import { verifyWebhookSignature } from '../lib/webhooks.mjs';
import { Vault } from '../lib/vault.mjs';
import { startServer } from '../server.mjs';

async function setupServer(t, extraOpts = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'loop-phase5-'));
  const srv = await startServer({
    port: 0,
    dataDir,
    authMode: 'local-test',
    detectLocalAgents: false,
    seedBuiltins: true,
    ...extraOpts,
  });
  t.after(async () => {
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${srv.port}`;
  const setupRes = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'phase5-password' }),
  });
  assert.equal(setupRes.status, 200);
  const cookie = (setupRes.headers.get('set-cookie') || '').split(';')[0];
  return { dataDir, base, cookie, srv };
}

async function mcpPost(url, token, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('Phase 5: ApprovalQueue supports up to 24-hour per-approval TTL and persists across reload', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-apr24h-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = 1_700_000_000_000;
  const q1 = new ApprovalQueue({ dir, now: () => now });
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;
  const apr = q1.create({
    kind: 'run',
    target: 'stripe__charge',
    title: 'Charge customer',
    fingerprint: 'fp_24h',
    agentId: 'bot_1',
    ttlMs: twentyFourHoursMs,
  });
  assert.equal(Date.parse(apr.expiresAt) - Date.parse(apr.createdAt), twentyFourHoursMs);
  await q1.close();

  // Reload 12 hours later: still pending and valid!
  const q2 = new ApprovalQueue({ dir, now: () => now + 12 * 60 * 60 * 1000 });
  const reloaded = q2.get(apr.id);
  assert.ok(reloaded);
  assert.equal(reloaded.status, 'pending');
  assert.equal(reloaded.expiresAt, apr.expiresAt);
  await q2.close();
});

test('Phase 5: waitMode: "async" returns approval_required immediately with 24h TTL and fires signed outbound webhook', async (t) => {
  // Start a local webhook receiver server to capture signed outbound alerts
  const received = [];
  const receiver = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    received.push({
      headers: req.headers,
      raw,
      json: JSON.parse(raw.toString('utf8')),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => receiver.close(r)));
  const receiverUrl = `http://127.0.0.1:${receiver.address().port}/alerts`;

  const { base, cookie } = await setupServer(t, { allowLoopbackAlerts: true });
  const ownerHeaders = { 'Content-Type': 'application/json', Cookie: cookie };

  // Register outbound webhook for approval events
  const whRes = await fetch(`${base}/api/outbound-webhooks`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({
      name: 'Bot Alert Relay',
      url: receiverUrl,
      events: ['approval.requested', 'approval.decided'],
    }),
  });
  assert.equal(whRes.status, 201);
  const { webhook, secret } = await whRes.json();
  assert.ok(webhook.id.startsWith('owh_'));
  assert.ok(secret.startsWith('loop_owh_'));

  // Set loop_notify__notify_owner to always_ask
  const polRes = await fetch(`${base}/api/policies`, {
    method: 'PATCH',
    headers: ownerHeaders,
    body: JSON.stringify({ tools: { loop_notify__notify_owner: 'always_ask' } }),
  });
  assert.equal(polRes.status, 200);

  // Create an autonomous bot with 24-hour approval TTL
  const agentRes = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ name: 'Async Bot', kind: 'openmausbot', approvalTtlSeconds: 86400 }),
  });
  assert.equal(agentRes.status, 201);
  const { token } = await agentRes.json();

  // Call with waitMode: "async" -> returns immediately with approvalId, approveUrl, expiresAt
  const startMs = Date.now();
  const call1 = await mcpPost(`${base}/mcp`, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'loop__run',
      arguments: {
        tool: 'loop_notify__notify_owner',
        arguments: { message: 'Overnight report ready' },
        waitMode: 'async',
      },
    },
  });
  assert.ok(Date.now() - startMs < 5000, 'async waitMode returns immediately');
  const payload1 = JSON.parse(call1.json.result.content[0].text);
  assert.equal(payload1.status, 'approval_required');
  assert.equal(payload1.waitMode, 'async');
  assert.ok(payload1.approvalId);
  assert.ok(payload1.approveUrl);
  assert.ok(Date.parse(payload1.expiresAt) > Date.now() + 23 * 60 * 60 * 1000);

  // Wait briefly for background outbound webhook delivery
  for (let i = 0; i < 30 && received.length < 1; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(received.length >= 1, 'approval.requested webhook was delivered');
  assert.equal(received[0].headers['x-loop-event'], 'approval.requested');
  assert.equal(
    verifyWebhookSignature(secret, received[0].raw, received[0].headers['x-loop-signature-256']),
    true,
    'HMAC-SHA256 signature verifies cleanly',
  );
  assert.equal(received[0].json.data.approvalId, payload1.approvalId);

  // Owner approves -> fires approval.decided webhook and lets bot resume cleanly
  const approveRes = await fetch(`${base}/api/approvals/${payload1.approvalId}/approve`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(approveRes.status, 200);

  for (let i = 0; i < 30 && received.length < 2; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(received.some((r) => r.headers['x-loop-event'] === 'approval.decided'));

  const call2 = await mcpPost(`${base}/mcp`, token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'loop__run',
      arguments: {
        tool: 'loop_notify__notify_owner',
        arguments: { message: 'Overnight report ready' },
        approvalId: payload1.approvalId,
      },
    },
  });
  assert.equal(call2.json.result.isError, false);
});

test('Phase 5: OutboundAlertStore blocks SSRF URLs and retries 503 deliveries with backoff', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-owh-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vault = new Vault(dir);

  // SSRF protection (default allowLoopback: false) blocks loopback, private IPs, metadata IP, and plain HTTP
  const strictStore = new OutboundAlertStore(dir, { vault });
  for (const badUrl of [
    'http://127.0.0.1:8799/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/internal',
    'https://192.168.1.10/admin',
    'http://hooks.example.com/insecure',
  ]) {
    await assert.rejects(
      () => strictStore.create({ name: 'Bad', url: badUrl }),
      { status: 400 },
      `should block SSRF/insecure URL: ${badUrl}`,
    );
  }

  // Retry logic: 1st attempt gets 503 -> status 'retry', 2nd attempt gets 200 -> status 'ok'
  let calls = 0;
  const retryStore = new OutboundAlertStore(dir, {
    vault,
    allowLoopback: true,
    fetchImpl: async () => {
      calls += 1;
      return new Response(calls === 1 ? 'unavailable' : 'ok', { status: calls === 1 ? 503 : 200 });
    },
  });
  const { webhook } = await retryStore.create({ name: 'Retry Test', url: 'http://127.0.0.1:9999/hook' });
  const t0 = 1_700_000_000_000;
  const first = await retryStore.emit('task.completed', { taskId: 't1' }, { now: t0 });
  assert.equal(first[0].status, 'retry');
  assert.equal(calls, 1);

  const retried = await retryStore.processRetries({ now: t0 + 60_000 });
  assert.equal(retried.length, 1);
  assert.equal(retried[0].status, 'ok');
  assert.equal(calls, 2);

  const deliveries = await retryStore.listDeliveries(webhook.id);
  assert.equal(deliveries[0].status, 'ok');
  assert.equal(deliveries[0].attempts, 2);
});

test('Phase 5: hostApprovalDelegation: "low_risk_ask" delegates generic write asks but NEVER bypasses Guard, explicit tool rules, or Vault secrets', async (t) => {
  const { base, cookie } = await setupServer(t);
  const ownerHeaders = { 'Content-Type': 'application/json', Cookie: cookie };

  // Enable global toolKind.write = always_ask
  await fetch(`${base}/api/policies`, {
    method: 'PATCH',
    headers: ownerHeaders,
    body: JSON.stringify({ toolKinds: { write: 'always_ask' } }),
  });

  // Create a Vault payment secret and share it with the agent
  await fetch(`${base}/api/vault`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ key: 'CORP_CARD', value: '4242-secret-card', type: 'payment' }),
  });

  // Create an agent with hostApprovalDelegation: 'low_risk_ask'
  const agentRes = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({
      name: 'Sentinel Host',
      kind: 'meta-muse',
      hostApprovalDelegation: 'low_risk_ask',
      secrets: ['CORP_CARD'],
    }),
  });
  assert.equal(agentRes.status, 201);
  const { token } = await agentRes.json();

  // 1. Generic toolKind:write ask on a non-secret tool (loop_notify__notify_owner) IS delegated and succeeds
  const delegatedCall = await mcpPost(`${base}/mcp`, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'loop__run',
      arguments: { tool: 'loop_notify__notify_owner', arguments: { message: 'Low-risk delegated note' } },
    },
  });
  assert.equal(delegatedCall.json.result.isError, false, 'generic low-risk write ask delegated to host');

  // 2. Passing a Vault payment secret STILL requires approval (NEVER delegated!)
  const secretCall = await mcpPost(`${base}/mcp`, token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'loop__run',
      arguments: { tool: 'loop_notify__notify_owner', arguments: { message: 'Card {{vault:CORP_CARD}}' } },
    },
  });
  const secretPayload = JSON.parse(secretCall.json.result.content[0].text);
  assert.equal(secretPayload.status, 'approval_required', 'Vault secret call is NEVER delegated');

  // 3. Explicit tool rule or Guard STILL requires approval (NEVER delegated!)
  await fetch(`${base}/api/policies`, {
    method: 'PATCH',
    headers: ownerHeaders,
    body: JSON.stringify({ tools: { loop_notify__notify_owner: 'guard' } }),
  });
  const guardCall = await mcpPost(`${base}/mcp`, token, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'loop__run',
      arguments: { tool: 'loop_notify__notify_owner', arguments: { message: 'Guarded action' } },
    },
  });
  const guardPayload = JSON.parse(guardCall.json.result.content[0].text);
  assert.equal(guardPayload.status, 'approval_required', 'Guard is NEVER delegated');
  assert.equal(guardPayload.guard, true);
});
