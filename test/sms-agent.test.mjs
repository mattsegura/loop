import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureSmsAgentRecord,
  isPlanActiveForSms,
  loadSmsAgentConfig,
  SmsAgentClient,
} from '../lib/sms-agent.mjs';
import { LoopStore } from '../lib/store.mjs';
import { Vault } from '../lib/vault.mjs';
import { startServer } from '../server.mjs';

const tmpDirs = [];
function makeTmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'loop-sms-agent-test-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function signStripe(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const sig = createHmac('sha256', secret).update(`${timestamp}.${raw}`, 'utf8').digest('hex');
  return { raw, header: `t=${timestamp},v1=${sig}` };
}

async function startMockLoopText({ secret = 'test-internal-secret' } = {}) {
  const calls = [];
  let linked = false;
  let brain = { mode: 'default', provider: 'anthropic', model: 'claude-sonnet-4-5' };
  let cliAuth = { status: 'idle', provider: null };
  let dream = {
    serverEnabled: true,
    enabled: true,
    active: true,
    triggerMode: 'both',
    stepInterval: 8,
    reviewBeforeApply: true,
    applyMode: 'propose',
    turnsSinceDream: 2,
    lastDreamAt: null,
    lastTrigger: null,
    lastStatus: null,
    lastError: null,
    totalRuns: 0,
    totalSaved: 0,
    pendingProposals: [
      { id: 'drm_abc12345', action: 'create', scope: 'preference', key: 'use-pnpm', content: 'Always use pnpm in Loop.', reason: 'Explicit preference', evidence: 'always use pnpm', createdAt: 1700000000000 },
    ],
  };

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body = rawBody ? JSON.parse(rawBody) : null;

    calls.push({
      method: req.method,
      path: reqUrl.pathname,
      query: Object.fromEntries(reqUrl.searchParams.entries()),
      secret: req.headers['x-loop-text-secret'],
      body,
    });

    if (req.headers['x-loop-text-secret'] !== secret) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized internal secret' }));
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/internal/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        linked,
        phone: '+15551234567',
        workspaceId: reqUrl.searchParams.get('workspaceId'),
        brain,
        dream,
      }));
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/internal/dream') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, linked, dream }));
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/internal/dream') {
      if (typeof body?.enabled === 'boolean') dream.enabled = body.enabled;
      if (body?.triggerMode) dream.triggerMode = body.triggerMode;
      if (body?.stepInterval) dream.stepInterval = body.stepInterval;
      if (typeof body?.reviewBeforeApply === 'boolean') dream.reviewBeforeApply = body.reviewBeforeApply;
      if (body?.applyMode) dream.applyMode = body.applyMode;
      dream.active = Boolean(dream.serverEnabled && dream.enabled);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dream }));
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/internal/dream/run') {
      dream.totalRuns += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dryRun: Boolean(body?.dryRun), reviewedTurns: 4, queuedCount: 1, savedCount: 0, dream }));
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/internal/dream/proposals') {
      const dropAll = Boolean(body?.all);
      const removed = dropAll
        ? dream.pendingProposals.length
        : dream.pendingProposals.filter((p) => p.id === body?.id).length;
      dream.pendingProposals = dropAll ? [] : dream.pendingProposals.filter((p) => p.id !== body?.id);
      if (body?.decision === 'approve') dream.totalSaved += removed;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, decision: body?.decision, applied: body?.decision === 'approve' ? removed : 0, dismissed: body?.decision === 'dismiss' ? removed : 0, dream }));
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/internal/dream/doctor') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, healthy: true, symptom: body?.symptom || null, summaryText: 'Context check looks healthy.', findings: [], metrics: { memoryCount: 2 } }));
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/internal/dream/remember') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, saved: true, memory: { key: 'saved-note', content: body?.text }, dream }));
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/internal/traces') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        linked,
        workspaceId: reqUrl.searchParams.get('workspaceId'),
        turns: [{
          id: 42,
          userText: 'Add composio',
          hasError: false,
          thinkingCount: 1,
          toolCount: 1,
          steps: [{ id: 43, kind: 'model', thinking: ['Need to add Composio'], toolCalls: [], text: 'Added Composio.' }],
        }],
      }));
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/internal/link-code') {
      linked = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        code: 'LOOP-8421',
        expiresAt: '2026-12-01T00:00:00Z',
        phone: '+15551234567',
      }));
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/internal/brain') {
      brain = {
        mode: body.mode,
        provider: body.provider || 'anthropic',
        model: body.model || 'claude-sonnet-4-5',
        ...(body.vaultKey ? { vaultKey: body.vaultKey } : {}),
      };
      // Deliberately echo apiKey from mock upstream to prove Loop strips it before responding
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        brain,
        apiKey: body.apiKey,
      }));
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/internal/cli-auth/start') {
      cliAuth = {
        status: 'pending',
        provider: body.provider,
        authUrl: `https://auth.example.com/${body.provider}/device`,
        userCode: 'ABCD-1234',
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cliAuth));
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/internal/cli-auth/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cliAuth));
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/internal/disconnect') {
      linked = false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ disconnected: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function signInLocalTest(base) {
  const setupRes = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password-1234' }),
  });
  assert.equal(setupRes.status, 200);
  return setupRes.headers.get('set-cookie').split(';')[0];
}

describe('lib/sms-agent unit helpers', () => {
  it('loadSmsAgentConfig validates URL and secret properly', () => {
    assert.deepEqual(loadSmsAgentConfig({}), {
      enabled: false,
      url: null,
      secret: null,
      phone: null,
      loopback: false,
    });

    const badUrl = loadSmsAgentConfig({
      LOOP_TEXT_URL: 'ftp://127.0.0.1:8810',
      LOOP_TEXT_INTERNAL_SECRET: 'sec',
    });
    assert.equal(badUrl.enabled, false);
    assert.equal(badUrl.url, null);

    const credUrl = loadSmsAgentConfig({
      LOOP_TEXT_URL: 'http://user:pass@127.0.0.1:8810',
      LOOP_TEXT_INTERNAL_SECRET: 'sec',
    });
    assert.equal(credUrl.enabled, false);

    const valid = loadSmsAgentConfig({
      LOOP_TEXT_URL: 'http://127.0.0.1:8810///',
      LOOP_TEXT_INTERNAL_SECRET: '  my-secret  ',
      LOOP_TEXT_PHONE: '+15550001111',
    });
    assert.equal(valid.enabled, true);
    assert.equal(valid.url, 'http://127.0.0.1:8810');
    assert.equal(valid.secret, 'my-secret');
    assert.equal(valid.phone, '+15550001111');
    assert.equal(valid.loopback, true);
  });

  it('isPlanActiveForSms allows disabled billing, paid plans, and active/trialing subscriptions', () => {
    assert.equal(isPlanActiveForSms(null), true);
    assert.equal(isPlanActiveForSms({ billingEnabled: false, plan: 'free' }), true);
    assert.equal(isPlanActiveForSms({ selfHosted: true, plan: 'free' }), true);
    assert.equal(isPlanActiveForSms({ billingEnabled: true, selfHosted: false, plan: 'free', status: 'free' }), false);
    assert.equal(isPlanActiveForSms({ billingEnabled: true, selfHosted: false, plan: 'pro', status: 'active' }), true);
    assert.equal(isPlanActiveForSms({ billingEnabled: true, selfHosted: false, plan: 'team' }), true);
    assert.equal(isPlanActiveForSms({ billingEnabled: true, selfHosted: false, plan: 'enterprise' }), true);
    assert.equal(isPlanActiveForSms({ billingEnabled: true, selfHosted: false, plan: 'free', status: 'trialing' }), true);
    assert.equal(
      isPlanActiveForSms({ billingEnabled: true, selfHosted: false, plan: 'free', subscription: { status: 'trialing' } }),
      true,
    );
    assert.equal(
      isPlanActiveForSms({ billingEnabled: true, selfHosted: false, plan: 'free', subscription: { status: 'canceled' } }),
      false,
    );
  });

  it('ensureSmsAgentRecord creates iMessage agent with expected defaults and reuses it', async () => {
    const dir = makeTmpDir();
    const store = new LoopStore(dir);
    const vault = new Vault(dir);

    const first = await ensureSmsAgentRecord(store, vault);
    assert.equal(first.agent.name, 'Loop Text (iMessage)');
    assert.equal(first.agent.kind, 'imessage');
    assert.equal(first.agent.profile, 'all');
    assert.equal(first.agent.mode, 'default');
    assert.equal(first.agent.canManage, true);
    assert.equal(first.agent.memoryAccess, 'read_write');
    assert.deepEqual(first.agent.secrets, []);
    assert.equal(first.agent.enabled, true);
    assert.match(first.token, /^loop_[A-Za-z0-9_-]{43}$/);

    // Second call reuses existing record and token
    const second = await ensureSmsAgentRecord(store, vault);
    assert.equal(second.agent.id, first.agent.id);
    assert.equal(second.token, first.token);

    // If disabled, ensureSmsAgentRecord re-enables it
    await store.updateAgent(first.agent.id, { enabled: false });
    const third = await ensureSmsAgentRecord(store, vault);
    assert.equal(third.agent.id, first.agent.id);
    assert.equal(third.agent.enabled, true);
    assert.equal(third.token, first.token);
  });

  it('SmsAgentClient rejects when disabled', async () => {
    const client = new SmsAgentClient(loadSmsAgentConfig({}));
    await assert.rejects(() => client.getStatus('local'), /not configured/);
  });
});

describe('/api/sms-agent HTTP routes', () => {
  it('returns { enabled: false } and 503 on mutations when loop-text env is unset', async () => {
    const srv = await startServer({
      port: 0,
      dataDir: makeTmpDir(),
      authMode: 'local-test',
      smsAgentEnv: {},
      billingEnv: {},
    });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const unauth = await fetch(`${base}/api/sms-agent`);
      assert.equal(unauth.status, 401);

      const cookie = await signInLocalTest(base);
      const statusRes = await fetch(`${base}/api/sms-agent`, { headers: { Cookie: cookie } });
      assert.equal(statusRes.status, 200);
      assert.deepEqual(await statusRes.json(), { enabled: false });

      const linkRes = await fetch(`${base}/api/sms-agent/link-code`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(linkRes.status, 503);
    } finally {
      await srv.close();
    }
  });

  it('enforces plan gating (402 when inactive, 200 when active) and exercises full bridge lifecycle', async () => {
    const secret = 'internal-bridge-secret-123';
    const webhookSecret = 'whsec_sms_test_secret_123';
    const mockText = await startMockLoopText({ secret });
    const dataDir = makeTmpDir();

    const srv = await startServer({
      port: 0,
      dataDir,
      authMode: 'local-test',
      hosted: true,
      billingEnv: {
        STRIPE_SECRET_KEY: 'sk_test_sms_mock_123456',
        STRIPE_WEBHOOK_SECRET: webhookSecret,
        STRIPE_PRO_PRICE_ID: 'price_pro_sms_123',
      },
      smsAgentEnv: {
        LOOP_TEXT_URL: mockText.url,
        LOOP_TEXT_INTERNAL_SECRET: secret,
        LOOP_TEXT_PHONE: '+15559990000',
      },
      dreamEnv: { LOOP_SLEEPTIME_ENABLED: '1' },
      dream: {
        completeJson: async () => JSON.stringify({
          proposals: [
            {
              action: 'create',
              category: 'preference',
              scope: 'preference',
              key: 'use-pnpm',
              content: 'Always use pnpm in Loop.',
              reason: 'Explicit preference',
              evidence: 'always use pnpm',
            },
          ],
        }),
      },
    });

    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const cookie = await signInLocalTest(base);

      // Seed a Vault secret + an internal secret directly to ensure internal keys and values never leak
      const vaultRes = await fetch(`${base}/api/vault`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'ANTHROPIC_API_KEY',
          value: 'sk-ant-super-secret-value-999',
          description: 'Anthropic key',
        }),
      });
      assert.equal(vaultRes.status, 201);

      // Initial GET /api/sms-agent shows planActive: false on hosted free plan
      const initialRes = await fetch(`${base}/api/sms-agent`, { headers: { Cookie: cookie } });
      assert.equal(initialRes.status, 200);
      const initial = await initialRes.json();
      assert.equal(initial.enabled, true);
      assert.equal(initial.planActive, false);
      assert.equal(initial.phone, '+15551234567');
      assert.equal(initial.billingUrl, '/?tab=settings&upgrade=1');
      assert.equal(initial.status.linked, false);
      assert.deepEqual(initial.vaultKeys, [
        { key: 'ANTHROPIC_API_KEY', description: 'Anthropic key', type: 'api_key' },
      ]);
      // Ensure secret value never appears in GET response
      assert.equal(JSON.stringify(initial).includes('sk-ant-super-secret-value-999'), false);

      // POST /api/sms-agent/link-code returns 402 when plan is inactive
      const blockedLink = await fetch(`${base}/api/sms-agent/link-code`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(blockedLink.status, 402);
      const blockedJson = await blockedLink.json();
      assert.equal(blockedJson.upgradeRequired, true);
      assert.equal(blockedJson.billingUrl, '/?tab=settings&upgrade=1');

      // Upgrade workspace to Pro via Stripe webhook
      const completedEvt = {
        id: 'evt_sms_pro_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            customer: 'cus_sms_001',
            subscription: 'sub_sms_001',
            client_reference_id: 'local',
            metadata: { workspace_key: 'local', plan_id: 'pro' },
          },
        },
      };
      const signed = signStripe(completedEvt, webhookSecret);
      const hookRes = await fetch(`${base}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signed.header },
        body: signed.raw,
      });
      assert.equal(hookRes.status, 200);

      // Now POST /api/sms-agent/link-code succeeds, creates iMessage agent, forwards token to loop-text
      const linkRes = await fetch(`${base}/api/sms-agent/link-code`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(linkRes.status, 200);
      const linkJson = await linkRes.json();
      assert.equal(linkJson.code, 'LOOP-8421');
      assert.equal(linkJson.agent.kind, 'imessage');
      assert.equal(linkJson.agent.profile, 'all');
      assert.equal(linkJson.agent.memoryAccess, 'read_write');
      assert.equal(linkJson.agent.canManage, true);
      assert.deepEqual(linkJson.agent.secrets, []);
      assert.equal(linkJson.agent.tokenHash, undefined);

      const linkCall = mockText.calls.find((c) => c.path === '/internal/link-code');
      assert.ok(linkCall);
      assert.equal(linkCall.secret, secret);
      assert.equal(linkCall.body.workspaceId, 'local');
      assert.equal(linkCall.body.agentId, linkJson.agent.id);
      assert.match(linkCall.body.agentToken, /^loop_[A-Za-z0-9_-]{43}$/);
      assert.equal(linkCall.body.planActive, true);
      assert.ok(Array.isArray(linkCall.body.connections));
      // Agent token must not leak in HTTP response to browser
      assert.equal(JSON.stringify(linkJson).includes(linkCall.body.agentToken), false);

      // POST /api/sms-agent/brain validation
      const badMode = await fetch(`${base}/api/sms-agent/brain`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'invalid_mode' }),
      });
      assert.equal(badMode.status, 400);

      const badVaultKey = await fetch(`${base}/api/sms-agent/brain`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'byo_key', vaultKey: '__agent_token_secret' }),
      });
      assert.equal(badVaultKey.status, 400);

      const missingVaultKey = await fetch(`${base}/api/sms-agent/brain`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'byo_key', vaultKey: 'DOES_NOT_EXIST' }),
      });
      assert.equal(missingVaultKey.status, 404);

      // POST /api/sms-agent/brain with byo_key resolves Vault secret and forwards to loop-text without leaking it
      const byoRes = await fetch(`${base}/api/sms-agent/brain`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'byo_key',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          vaultKey: 'ANTHROPIC_API_KEY',
        }),
      });
      assert.equal(byoRes.status, 200);
      const byoJson = await byoRes.json();
      assert.equal(byoJson.ok, true);
      assert.equal(byoJson.apiKey, undefined);
      assert.equal(JSON.stringify(byoJson).includes('sk-ant-super-secret-value-999'), false);

      const brainCall = mockText.calls.find((c) => c.path === '/internal/brain');
      assert.ok(brainCall);
      assert.equal(brainCall.body.mode, 'byo_key');
      assert.equal(brainCall.body.vaultKey, 'ANTHROPIC_API_KEY');
      assert.equal(brainCall.body.apiKey, 'sk-ant-super-secret-value-999');

      // POST /api/sms-agent/cli-auth/start + GET /api/sms-agent/cli-auth/status
      const badProvider = await fetch(`${base}/api/sms-agent/cli-auth/start`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'other' }),
      });
      assert.equal(badProvider.status, 400);

      const startAuthRes = await fetch(`${base}/api/sms-agent/cli-auth/start`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'claude' }),
      });
      assert.equal(startAuthRes.status, 200);
      const startAuthJson = await startAuthRes.json();
      assert.equal(startAuthJson.status, 'pending');
      assert.equal(startAuthJson.provider, 'claude');
      assert.equal(startAuthJson.userCode, 'ABCD-1234');

      const authStatusRes = await fetch(`${base}/api/sms-agent/cli-auth/status`, {
        headers: { Cookie: cookie },
      });
      assert.equal(authStatusRes.status, 200);
      const authStatusJson = await authStatusRes.json();
      assert.equal(authStatusJson.status, 'pending');
      assert.equal(authStatusJson.provider, 'claude');

      // GET /api/sms-agent/traces proxies recent reasoning & stack traces for the workspace
      const tracesRes = await fetch(`${base}/api/sms-agent/traces?limit=10`, {
        headers: { Cookie: cookie },
      });
      assert.equal(tracesRes.status, 200);
      const tracesJson = await tracesRes.json();
      assert.equal(tracesJson.ok, true);
      assert.equal(tracesJson.turns.length, 1);
      assert.equal(tracesJson.turns[0].steps[0].thinking[0], 'Need to add Composio');

      // GET/POST /api/sms-agent/dream + /run + /proposals manage Loop Core sleep-time memory review
      const dreamGetRes = await fetch(`${base}/api/sms-agent/dream`, { headers: { Cookie: cookie } });
      assert.equal(dreamGetRes.status, 200);
      const dreamGetJson = await dreamGetRes.json();
      assert.equal(dreamGetJson.dream.stepInterval, 8);
      assert.equal(dreamGetJson.dream.serverEnabled, true);

      const dreamBadRes = await fetch(`${base}/api/sms-agent/dream`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepInterval: 99 }),
      });
      assert.equal(dreamBadRes.status, 400);

      const dreamUpdRes = await fetch(`${base}/api/sms-agent/dream`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ triggerMode: 'steps', stepInterval: 10, reviewBeforeApply: true, applyMode: 'propose' }),
      });
      assert.equal(dreamUpdRes.status, 200);
      assert.equal((await dreamUpdRes.json()).dream.stepInterval, 10);

      // Push a completed SMS turn through the server-to-server bridge (http.request without browser Sec-Fetch headers)
      const turnPushStatus = await new Promise((resolve, reject) => {
        const payload = JSON.stringify({
          type: 'turn',
          triggerDream: false,
          turn: { user: 'Please always use pnpm in Loop.', assistant: 'Got it, I will use pnpm.' },
        });
        const req = http.request(
          {
            host: '127.0.0.1',
            port: srv.port,
            path: '/api/sms-bridge/events',
            method: 'POST',
            headers: {
              Authorization: `Bearer ${linkCall.body.agentToken}`,
              'X-Loop-Text-Secret': secret,
              'Content-Type': 'application/json',
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
      assert.equal(turnPushStatus, 200);

      const dreamRunRes = await fetch(`${base}/api/sms-agent/dream/run`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      assert.equal(dreamRunRes.status, 200);
      const dreamRunJson = await dreamRunRes.json();
      assert.equal(dreamRunJson.reviewedTurns, 1);
      assert.equal(dreamRunJson.queuedCount, 1);
      const propId = dreamRunJson.dream.pendingProposals[0].id;

      const dreamPropBad = await fetch(`${base}/api/sms-agent/dream/proposals`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });
      assert.equal(dreamPropBad.status, 400);

      const dreamPropOk = await fetch(`${base}/api/sms-agent/dream/proposals`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: propId, decision: 'approve' }),
      });
      assert.equal(dreamPropOk.status, 200);
      const dreamPropJson = await dreamPropOk.json();
      assert.equal(dreamPropJson.applied, 1);
      assert.equal(dreamPropJson.dream.pendingProposals.length, 0);

      const doctorRes = await fetch(`${base}/api/sms-agent/dream/doctor`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ symptom: 'pnpm' }),
      });
      assert.equal(doctorRes.status, 200);
      const doctorJson = await doctorRes.json();
      assert.equal(doctorJson.ok, true);
      assert.equal(doctorJson.metrics.memoryCount >= 1, true);

      const remBadRes = await fetch(`${base}/api/sms-agent/dream/remember`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      assert.equal(remBadRes.status, 400);

      const remOkRes = await fetch(`${base}/api/sms-agent/dream/remember`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Keep replies under two sentences' }),
      });
      assert.equal(remOkRes.status, 200);
      assert.equal((await remOkRes.json()).saved, true);

      // POST /api/sms-agent/disconnect proxies to loop-text and disables the imessage agent
      const discRes = await fetch(`${base}/api/sms-agent/disconnect`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(discRes.status, 200);
      assert.deepEqual(await discRes.json(), { disconnected: true });

      const agentsRes = await fetch(`${base}/api/agents`, { headers: { Cookie: cookie } });
      assert.equal(agentsRes.status, 200);
      const agentsJson = await agentsRes.json();
      const imessageAgent = agentsJson.agents.find((a) => a.kind === 'imessage');
      assert.ok(imessageAgent);
      assert.equal(imessageAgent.enabled, false);
    } finally {
      await srv.close();
      await mockText.close();
    }
  });

  it('allows link-code when billing is disabled (local/self-hosted dev)', async () => {
    const secret = 'local-dev-secret';
    const mockText = await startMockLoopText({ secret });
    const srv = await startServer({
      port: 0,
      dataDir: makeTmpDir(),
      authMode: 'local-test',
      hosted: false,
      billingEnv: {},
      smsAgentEnv: {
        LOOP_TEXT_URL: mockText.url,
        LOOP_TEXT_INTERNAL_SECRET: secret,
      },
    });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const cookie = await signInLocalTest(base);

      const statusRes = await fetch(`${base}/api/sms-agent`, { headers: { Cookie: cookie } });
      assert.equal(statusRes.status, 200);
      const statusJson = await statusRes.json();
      assert.equal(statusJson.enabled, true);
      assert.equal(statusJson.planActive, true);

      const linkRes = await fetch(`${base}/api/sms-agent/link-code`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(linkRes.status, 200);
      assert.equal((await linkRes.json()).code, 'LOOP-8421');
    } finally {
      await srv.close();
      await mockText.close();
    }
  });

  it('adapts MCP initialize.instructions and omits terminal visual trees for loop-text / iMessage clients', async () => {
    const secret = 'sms-mcp-surface-secret';
    const mockText = await startMockLoopText({ secret });
    const srv = await startServer({
      port: 0,
      dataDir: makeTmpDir(),
      authMode: 'local-test',
      hosted: false,
      billingEnv: {},
      smsAgentEnv: {
        LOOP_TEXT_URL: mockText.url,
        LOOP_TEXT_INTERNAL_SECRET: secret,
      },
    });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const cookie = await signInLocalTest(base);

      // Provision iMessage agent via link-code to get a real imessage agent token
      const linkRes = await fetch(`${base}/api/sms-agent/link-code`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(linkRes.status, 200);
      const linkCall = mockText.calls.find((c) => c.path === '/internal/link-code');
      const agentToken = linkCall.body.agentToken;

      // 1. Initialize as loop-text with iMessage agent token
      const initSmsRes = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${agentToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'loop-text', version: '1.0.0' },
          },
        }),
      });
      assert.equal(initSmsRes.status, 200);
      const initSmsJson = await initSmsRes.json();
      const smsInstr = initSmsJson.result.instructions;
      assert.ok(!smsInstr.includes('fenced `text` block'), 'SMS instructions omit fenced text block tree rule');
      assert.ok(!smsInstr.includes('copying to clipboard'), 'SMS instructions omit desktop clipboard rule');

      // 2. loop__search({ type: 'connections' }) omits terminal visual & displayHint for SMS client
      const smsSessionId = initSmsRes.headers.get('mcp-session-id');
      const searchSmsRes = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${agentToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(smsSessionId ? { 'Mcp-Session-Id': smsSessionId } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'loop__search', arguments: { type: 'connections' } },
        }),
      });
      assert.equal(searchSmsRes.status, 200);
      const searchSmsJson = await searchSmsRes.json();
      const smsPayload = JSON.parse(searchSmsJson.result.content[0].text);
      assert.equal(smsPayload.visual, undefined, 'SMS connections search omits terminal visual');
      assert.equal(smsPayload.displayHint, undefined, 'SMS connections search omits terminal displayHint');

      // 2b. Adding Gmail before OAuth sign-in explicitly reports connected: false + signInUrl (never connected: true)
      let gmailPort = 0;
      const unauthGmailUpstream = http.createServer((req, res) => {
        const origin = `http://127.0.0.1:${gmailPort}`;
        if (req.url?.startsWith('/.well-known/oauth-protected-resource')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }));
          return;
        }
        if (req.url?.startsWith('/.well-known/oauth-authorization-server')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              issuer: origin,
              authorization_endpoint: `${origin}/authorize`,
              token_endpoint: `${origin}/token`,
              registration_endpoint: `${origin}/register`,
              code_challenge_methods_supported: ['S256'],
            }),
          );
          return;
        }
        res.writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ error: 'unauthorized' }));
      });
      await new Promise((resolve) => unauthGmailUpstream.listen(0, '127.0.0.1', resolve));
      gmailPort = unauthGmailUpstream.address().port;
      try {
        const addGmailRes = await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${agentToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...(smsSessionId ? { 'Mcp-Session-Id': smsSessionId } : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 25,
            method: 'tools/call',
            params: {
              name: 'loop__save',
              arguments: {
                type: 'connection',
                action: 'save',
                data: { id: 'gmail', name: 'Gmail', url: `http://127.0.0.1:${gmailPort}/mcp` },
              },
            },
          }),
        });
        assert.equal(addGmailRes.status, 200);
        const addGmailJson = await addGmailRes.json();
        const savedGmail = JSON.parse(addGmailJson.result.content[0].text);
        assert.equal(savedGmail.saved, true);
        assert.equal(savedGmail.connection.enabled, true);
        assert.equal(savedGmail.connection.connected, false, 'Unauthenticated Gmail must never report connected: true');
        assert.equal(savedGmail.connection.authRequired, true);
        assert.equal(savedGmail.connection.statusLabel, 'Needs sign-in');
        assert.match(savedGmail.signInUrl || '', /signin=gmail/);
        assert.match(savedGmail.nextStep || '', /not connected yet/);
      } finally {
        await new Promise((resolve) => unauthGmailUpstream.close(resolve));
      }

      // 3. Control: desktop client (claude-code) still receives desktop instructions and visual tree
      const createDesktopAgentRes = await fetch(`${base}/api/agents`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Claude Code', kind: 'claude-code', profile: 'all', mode: 'progressive' }),
      });
      assert.equal(createDesktopAgentRes.status, 201);
      const desktopAgent = await createDesktopAgentRes.json();
      const desktopToken = desktopAgent.token;
      const initDesktopRes = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${desktopToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'claude-code', version: '1.0.0' },
          },
        }),
      });
      assert.equal(initDesktopRes.status, 200);
      const initDesktopJson = await initDesktopRes.json();
      assert.ok(!initDesktopJson.result.instructions.includes('fenced `text` block'), 'desktop client omits fenced visual rule');
    } finally {
      await srv.close();
      await mockText.close();
    }
  });

  it('forwards userPhone on /api/sms-agent/link-code and renders phone input for Photon shared pool', async () => {
    const secret = 'photon-secret';
    const mockText = await startMockLoopText({ secret });
    const srv = await startServer({
      port: 0,
      dataDir: makeTmpDir(),
      authMode: 'local-test',
      hosted: false,
      billingEnv: {},
      smsAgentEnv: {
        LOOP_TEXT_URL: mockText.url,
        LOOP_TEXT_INTERNAL_SECRET: secret,
      },
    });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const cookie = await signInLocalTest(base);
      const res = await fetch(`${base}/api/sms-agent/link-code`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '+15553334444' }),
      });
      assert.equal(res.status, 200);
      const lastCall = [...mockText.calls].reverse().find((c) => c.path === '/internal/link-code');
      assert.equal(lastCall?.body?.userPhone, '+15553334444');

      const { renderSmsAgentCard } = await import('../public/agents-view.js');
      const photonHtml = renderSmsAgentCard({ enabled: true, planActive: true, needsUserPhone: true, status: { linked: false, needsUserPhone: true } }, {});
      assert.match(photonHtml, /data-sms-user-phone/);
      const blooioHtml = renderSmsAgentCard({ enabled: true, planActive: true, needsUserPhone: false, status: { linked: false, needsUserPhone: false } }, {});
      assert.doesNotMatch(blooioHtml, /data-sms-user-phone/);
    } finally {
      await srv.close();
      await mockText.close();
    }
  });
});
