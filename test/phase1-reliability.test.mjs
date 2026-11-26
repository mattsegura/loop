import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../server.mjs';
import { LoopStore } from '../lib/store.mjs';
import { Vault } from '../lib/vault.mjs';
import { ConnectionPool } from '../lib/mcp-client.mjs';
import { issueAgentToken } from '../lib/agents.mjs';
import { refreshOAuthToken, startOAuthFlow } from '../lib/oauth.mjs';
import { DEFAULT_USER_AGENT, probeConnection } from '../lib/outbound-policy.mjs';
import { createRedactor } from '../lib/secret-refs.mjs';
import { ScheduleStore } from '../lib/schedules.mjs';
import { NotificationStore } from '../lib/notifications.mjs';

const bodyOf = async (req) => {
  let out = '';
  for await (const chunk of req) out += chunk;
  return out;
};

const listenJson = (handler) =>
  new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            srv.closeAllConnections?.();
            srv.close(() => r());
          }),
      });
    });
  });

const sendJson = (res, status, obj, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
};

test('Phase 1: notifications/cancelled aborts in-flight upstream tool call and keeps session healthy', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-p1-cancel-'));
  const seen = { started: 0, finished: 0, closedEarly: 0, cancelNotices: 0 };
  const upstream = await listenJson(async (req, res) => {
    const raw = await bodyOf(req);
    const msg = raw ? JSON.parse(raw) : {};
    if (msg.method === 'notifications/cancelled') {
      seen.cancelNotices += 1;
      res.writeHead(202);
      res.end();
      return;
    }
    if (req.method !== 'POST' || msg.id === undefined) {
      res.writeHead(req.method === 'POST' ? 202 : 405);
      res.end();
      return;
    }
    if (msg.method === 'initialize') {
      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '1' } },
      });
    }
    if (msg.method === 'tools/list') {
      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: [{ name: 'slow_write', description: 'Slow write', inputSchema: { type: 'object' } }] },
      });
    }
    if (msg.method === 'tools/call') {
      seen.started += 1;
      let done = false;
      res.on('close', () => { if (!done) seen.closedEarly += 1; });
      await new Promise((r) => setTimeout(r, 2000));
      if (res.destroyed) return;
      done = true;
      seen.finished += 1;
      return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'written' }] } });
    }
    res.writeHead(404).end();
  });

  let srv;
  let client;
  try {
    const store = new LoopStore(dir);
    const vault = new Vault(dir);
    const pool = new ConnectionPool(store, vault);
    const conn = await store.add({ name: 'Slow', transport: 'http', url: `${upstream.url}/mcp` });
    await pool.sync(conn.id);
    await pool.closeAll();

    const agent = await store.addAgent({ name: 'Claude', kind: 'claude-code', profile: 'all', enabled: true, canManage: true, secrets: [] });
    const { token } = await issueAgentToken(store, vault, agent.id);
    srv = await startServer({ port: 0, dataDir: dir, detectLocalAgents: false, authMode: 'local-test', schedulePollMs: 0 });

    client = new Client({ name: 'cancel-test', version: '1' }, { capabilities: {} });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );

    const ac = new AbortController();
    setTimeout(() => ac.abort('user pressed Esc'), 250);
    await assert.rejects(
      client.callTool({ name: 'loop__run', arguments: { tool: `${conn.id}__slow_write`, arguments: {} } }, undefined, { signal: ac.signal }),
    );
    await new Promise((r) => setTimeout(r, 400));

    assert.equal(seen.started, 1);
    assert.ok(seen.closedEarly >= 1 || seen.cancelNotices >= 1, 'upstream should be notified or closed early on cancel');
    assert.equal(seen.finished, 0, 'cancelled upstream write must not finish');

    const followUp = await client.callTool({ name: 'loop__search', arguments: { type: 'connections' } });
    assert.equal(Boolean(followUp.isError), false, 'session remains healthy after cancel');
  } finally {
    await client?.close().catch(() => {});
    await srv?.close().catch(() => {});
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Phase 1: outputSchema without structuredContent never fails post-write and preserves title/outputSchema', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-p1-outschema-'));
  let ran = 0;
  const upstream = await listenJson(async (req, res) => {
    const raw = await bodyOf(req);
    const msg = raw ? JSON.parse(raw) : {};
    if (req.method !== 'POST' || msg.id === undefined) {
      res.writeHead(req.method === 'POST' ? 202 : 405).end();
      return;
    }
    if (msg.method === 'initialize') {
      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'shop', version: '1' } },
      });
    }
    if (msg.method === 'tools/list') {
      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'create_order',
              title: 'Create an order',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
            },
          ],
        },
      });
    }
    if (msg.method === 'tools/call') {
      ran += 1;
      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: '{"id":"ord_1"}' }] },
      });
    }
    res.writeHead(404).end();
  });

  const store = new LoopStore(dir);
  const vault = new Vault(dir);
  const pool = new ConnectionPool(store, vault);
  try {
    const conn = await store.add({ name: 'Shop', transport: 'http', url: `${upstream.url}/mcp` });
    await pool.sync(conn.id);
    const saved = await store.get(conn.id);
    assert.equal(saved.tools[0].title, 'Create an order');
    assert.equal(saved.tools[0].description, 'Create an order');
    assert.deepEqual(saved.tools[0].outputSchema.required, ['id']);

    const res = await pool.callTool(conn.id, 'create_order', {});
    assert.equal(ran, 1);
    assert.equal(res.content[0].text, '{"id":"ord_1"}');
  } finally {
    await pool.closeAll();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Phase 1: OAuth keeps refresh token on invalid_client, re-registers DCR, handles HTTP 200 error, string expires_in, and Retry-After', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-p1-oauth-'));
  const state = { token: null, registrations: 0, tokenCalls: 0, lastRegistration: null, seenUserAgents: [] };
  const as = await listenJson(async (req, res) => {
    state.seenUserAgents.push(req.headers['user-agent'] || '');
    const url = new URL(req.url, 'http://x');
    const raw = await bodyOf(req);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return sendJson(res, 200, { resource: `${as.url}/mcp`, authorization_servers: [as.url] });
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      return sendJson(res, 200, {
        issuer: as.url,
        authorization_endpoint: `${as.url}/authorize`,
        token_endpoint: `${as.url}/token`,
        registration_endpoint: `${as.url}/register`,
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/register') {
      state.registrations += 1;
      state.lastRegistration = JSON.parse(raw);
      return sendJson(res, 201, { client_id: `new-client-${state.registrations}` });
    }
    if (url.pathname === '/token') {
      state.tokenCalls += 1;
      return sendJson(res, state.token.status, state.token.body, state.token.headers || {});
    }
    res.writeHead(404).end();
  });

  const makeVault = (init) => {
    const m = new Map(Object.entries(init));
    return {
      deleted: [],
      async get(k) { return m.get(k) ?? null; },
      async set(k, v) { m.set(k, v); },
      async delete(k) { this.deleted.push(k); m.delete(k); },
    };
  };
  const makeConn = (extra = {}) => ({
    id: 'c1',
    name: 'Probe',
    url: `${as.url}/mcp`,
    oauth: {
      clientId: 'old-client',
      clientOrigin: 'dcr',
      tokenEndpoint: `${as.url}/token`,
      issuer: as.url,
      callbackUrl: 'http://127.0.0.1:8799/oauth/callback',
      accessTokenVaultKey: 'a',
      refreshTokenVaultKey: 'r',
      grantId: 'g1g1g1g1',
      boundOrigin: as.url,
      ...extra,
    },
  });

  try {
    // 1. invalid_client keeps refresh token and triggers fresh DCR on next sign-in.
    state.token = { status: 401, body: { error: 'invalid_client' } };
    const v1 = makeVault({ a: 'acc', r: 'ref' });
    let clientRejected = false;
    let revoked = null;
    const c1 = makeConn();
    const r1 = await refreshOAuthToken(c1, v1, {
      onRevoked: async (e) => { revoked = e; },
      onClientRejected: async () => { clientRejected = true; },
    });
    assert.equal(r1, null);
    assert.equal(v1.deleted.includes('r'), false, 'refresh token must survive invalid_client');
    assert.equal(revoked, null);
    assert.equal(clientRejected, true);
    const flow1 = await startOAuthFlow(c1, c1.oauth.callbackUrl, { dataDir: dir, workspace: 'local' });
    assert.equal(new URL(flow1.authorizeUrl).searchParams.get('client_id'), 'new-client-1');
    assert.equal(state.lastRegistration.application_type, 'web');
    assert.ok(state.seenUserAgents.every((ua) => ua === DEFAULT_USER_AGENT), 'every OAuth request sends User-Agent');

    // 2. HTTP 200 error body revokes dead refresh token.
    state.token = { status: 200, body: { error: 'bad_refresh_token', error_description: 'expired' } };
    const v2 = makeVault({ a: 'acc', r: 'ref' });
    let revoked2 = null;
    const r2 = await refreshOAuthToken(makeConn({ grantId: 'g2g2g2g2' }), v2, { onRevoked: async (e) => { revoked2 = e; } });
    assert.equal(r2, null);
    assert.equal(revoked2, 'bad_refresh_token');
    assert.equal(v2.deleted.includes('r'), true);

    // 3. String expires_in computes ttlMs and expiresAt.
    state.token = { status: 200, body: { access_token: 'fresh-tok', token_type: 'bearer', expires_in: '3600' } };
    const v3 = makeVault({ a: 'acc', r: 'ref' });
    const r3 = await refreshOAuthToken(makeConn({ grantId: 'g3g3g3g3' }), v3, {});
    assert.equal(r3.ttlMs, 3_600_000);
    assert.ok(r3.expiresAt > Date.now());

    // 4. 429 Retry-After suppresses repeated token calls during backoff window.
    state.token = { status: 429, body: { error: 'slow_down' }, headers: { 'Retry-After': '120' } };
    const callsBefore = state.tokenCalls;
    const v4 = makeVault({ a: 'acc', r: 'ref' });
    const c4 = makeConn({ grantId: 'g4g4g4g4' });
    for (let i = 0; i < 4; i += 1) {
      await refreshOAuthToken(c4, v4, {});
    }
    assert.equal(state.tokenCalls - callsBefore, 1, 'Retry-After must prevent hammering token endpoint');
  } finally {
    await as.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Phase 1: probeConnection detects 403 HTML firewall, tools/list auth gate, session cleanup, and sends User-Agent', async () => {
  let firewallUa = '';
  const firewall = await listenJson((req, res) => {
    firewallUa = req.headers['user-agent'] || '';
    res.writeHead(403, { 'Content-Type': 'text/html' });
    res.end('<html><title>Access denied</title></html>');
  });

  const calls = [];
  const gated = await listenJson(async (req, res) => {
    const raw = await bodyOf(req);
    const msg = raw ? JSON.parse(raw) : {};
    calls.push(`${req.method} ${msg.method || ''}`.trim());
    if (req.method === 'DELETE') {
      res.writeHead(204).end();
      return;
    }
    if (msg.method === 'initialize') {
      return sendJson(
        res,
        200,
        { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'gated', version: '1' } } },
        { 'Mcp-Session-Id': 's1' },
      );
    }
    if (msg.method === 'tools/list') {
      return sendJson(res, 401, { error: 'unauthorized' });
    }
    res.writeHead(202).end();
  });

  try {
    const fwRes = await probeConnection(`${firewall.url}/mcp`, { timeoutMs: 3000 });
    assert.equal(firewallUa, DEFAULT_USER_AGENT);
    assert.equal(fwRes.status, 'error');
    assert.equal(fwRes.reason, 'refused');

    const gatedRes = await probeConnection(`${gated.url}/mcp`, { timeoutMs: 3000 });
    assert.equal(gatedRes.status, 'api_key');
    assert.ok(calls.includes('POST tools/list'), 'probe must verify tools/list');
    assert.ok(calls.includes('DELETE'), 'probe must close the temporary MCP session');
  } finally {
    await firewall.close();
    await gated.close();
  }
});

test('Phase 1: redactor hides base64(user:secret) Basic auth tokens', () => {
  const secret = 'sk-live-Ab3dEf6hIj9kLmNo';
  const basic = Buffer.from(`api:${secret}`).toString('base64');
  const redactor = createRedactor([secret]);
  const masked = redactor.redact(`Authorization: Basic ${basic}`);
  assert.equal(masked.includes(basic), false);
  assert.equal(masked.includes('••••'), true);
});

test('Phase 1: hosted schedules wake unloaded workspaces, failed one-time reminders retry, and SMS failure sets error status', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-p1-sched-'));
  let srv;
  try {
    // 1. Unloaded hosted workspace wakes and fires on tickSchedules.
    const wsId = 'c'.repeat(64);
    const userDir = path.join(dir, 'user-workspaces', wsId);
    await mkdir(userDir, { recursive: true, mode: 0o700 });
    const at = new Date(Date.now() + 60_000).toISOString();
    const hostedSched = new ScheduleStore(userDir);
    const { schedule } = await hostedSched.save({ title: 'Call the bank', kind: 'once', runAt: at, action: 'notify' });

    srv = await startServer({ port: 0, dataDir: dir, detectLocalAgents: false, authMode: 'local-test', schedulePollMs: 0 });
    const due = Date.parse(at) + 120_000;
    const fired = await srv.tickSchedules(due);
    assert.ok(fired.some((row) => row.workspaceId === wsId), 'hosted workspace must wake and fire');
    assert.equal((await hostedSched.get(schedule.id)).status, 'completed');

    // 2. Failed one-time reminder stays active and retries later.
    const retryDir = path.join(dir, 'retry');
    const retryStore = new ScheduleStore(retryDir);
    const { schedule: sRetry } = await retryStore.save({ title: 'Pay rent', kind: 'once', runAt: at, action: 'notify' });
    const firstTry = await retryStore.tick({
      now: Date.parse(at) + 1000,
      dispatchNotify: async () => { throw new Error('rate limited'); },
    });
    assert.equal(firstTry[0].status, 'error');
    const afterFail = await retryStore.get(sRetry.id);
    assert.equal(afterFail.status, 'active', 'failed one-time reminder must remain active for retry');
    assert.ok(Date.parse(afterFail.nextRunAt) > Date.parse(at));
    const secondTry = await retryStore.tick({
      now: Date.parse(afterFail.nextRunAt) + 1000,
      dispatchNotify: async () => ({ deliveredSms: true, smsFailed: false }),
    });
    assert.equal(secondTry.length, 1);
    assert.equal(secondTry[0].status, 'ok');
    assert.equal((await retryStore.get(sRetry.id)).status, 'completed');

    // 3. SMS delivery error marks schedule run status as error.
    const smsDir = path.join(dir, 'sms');
    const smsSched = new ScheduleStore(smsDir);
    const smsNotes = new NotificationStore(smsDir);
    const { schedule: sSms } = await smsSched.save({ title: 'SMS check', kind: 'once', runAt: at, action: 'notify' });
    const smsRun = await smsSched.tick({
      now: Date.parse(at) + 1000,
      dispatchNotify: async (s) => {
        const res = await smsNotes.send(
          { title: s.title, message: s.title },
          { agentId: 'loop_schedules', deliverSms: async () => { throw new Error('carrier down'); } },
        );
        return { deliveredSms: res.deliveredSms, smsFailed: !res.deliveredSms, smsNote: res.notification?.smsNote };
      },
    });
    assert.equal(smsRun[0].status, 'error');
    assert.match(smsRun[0].error, /carrier down/i);
    assert.equal((await smsSched.get(sSms.id)).status, 'active');
  } finally {
    await srv?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
