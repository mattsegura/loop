import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { startServer } from '../server.mjs';

const OWNER_PW = 'phase4-owner-pw-123';
const BRIDGE_SECRET = 'phase4-bridge-secret';

function reqJson(port, route, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method,
        headers: { ...(payload !== null ? { 'Content-Type': 'application/json' } : {}), ...headers },
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
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function startFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-phase4-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {}));
  const srv = await startServer({
    port: 0,
    dataDir: dir,
    authMode: 'local-test',
    autoSync: false,
    detectLocalAgents: false,
    smsAgentEnv: { LOOP_TEXT_INTERNAL_SECRET: BRIDGE_SECRET },
    billingEnv: {},
  });
  t.after(() => srv.close());
  const setup = await reqJson(srv.port, '/api/auth/setup', { method: 'POST', body: { password: OWNER_PW } });
  assert.equal(setup.status, 200);
  const cookie = String([].concat(setup.headers['set-cookie'])[0] || '').split(';')[0];
  const api = (route, opts = {}) => reqJson(srv.port, route, { ...opts, headers: { Cookie: cookie, ...(opts.headers || {}) } });
  const addAgent = async (name, extra = {}) => {
    const res = await api('/api/agents', { method: 'POST', body: { name, canManage: true, ...extra } });
    assert.equal(res.status, 201);
    return { id: res.json.agent.id, token: res.json.token };
  };
  const bridge = (agent, route, { method = 'POST', body } = {}) =>
    reqJson(srv.port, `/api/sms-bridge${route}`, {
      method,
      body,
      headers: {
        Authorization: `Bearer ${agent.token}`,
        'X-Loop-Text-Secret': BRIDGE_SECRET,
      },
    });
  let rpcId = 0;
  const mcpCall = async (agent, name, args) => {
    rpcId += 1;
    const res = await reqJson(srv.port, '/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent.token}` },
      body: { jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: args } },
    });
    assert.equal(res.status, 200);
    const text = res.json.result.content[0].text;
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* plain text */ }
    return { isError: res.json.result.isError === true, parsed };
  };
  return { srv, api, addAgent, bridge, mcpCall };
}

test('Phase 4: Owner-text bridge (imessage) settles cross-Agent Ask approvals while Guard stays password-only', async (t) => {
  const fix = await startFixture(t);
  const claude = await fix.addAgent('Claude Code', { kind: 'claude-code' });
  const bystander = await fix.addAgent('Other Custom Agent', { kind: 'custom' });
  const texter = await fix.addAgent('Loop Text', { kind: 'imessage' });

  // Require Ask for saves.
  assert.equal((await fix.api('/api/policies', { method: 'PATCH', body: { actions: { save: 'always_ask' } } })).status, 200);

  const askArgs = { type: 'api_key', action: 'save', data: { key: 'CROSS_AGENT_KEY', value: 'secret-val-12345' } };
  const paused = await fix.mcpCall(claude, 'loop__save', askArgs);
  assert.equal(paused.parsed.status, 'approval_required');
  const approvalId = paused.parsed.approvalId;

  // Non-bridge agent cannot list or settle Claude's approval.
  const bystanderList = await fix.bridge(bystander, '/approvals', { method: 'GET' });
  assert.equal(bystanderList.status, 200);
  assert.equal(bystanderList.json.crossAgent, false);
  assert.equal(bystanderList.json.pending.length, 0);
  assert.equal((await fix.bridge(bystander, `/approvals/${approvalId}/decide`, { body: { decision: 'approve' } })).status, 404);

  // iMessage bridge lists, inspects, and approves Claude's Ask approval!
  const textList = await fix.bridge(texter, '/approvals', { method: 'GET' });
  assert.equal(textList.status, 200);
  assert.equal(textList.json.crossAgent, true);
  assert.equal(textList.json.pending.length, 1);
  assert.equal(textList.json.pending[0].id, approvalId);
  assert.equal(textList.json.pending[0].agentId, claude.id);

  const inspected = await fix.bridge(texter, `/approvals/${approvalId}`, { method: 'GET' });
  assert.equal(inspected.status, 200);
  assert.equal(inspected.json.approval.id, approvalId);

  const decided = await fix.bridge(texter, `/approvals/${approvalId}/decide`, { body: { decision: 'approve' } });
  assert.equal(decided.status, 200);
  assert.equal(decided.json.status, 'approved');

  // Now Claude retries with the approved id and succeeds!
  const resumed = await fix.mcpCall(claude, 'loop__save', { ...askArgs, approvalId });
  assert.equal(resumed.isError, false);
  assert.equal(resumed.parsed.saved, true);

  // Now escalate save to Guard: iMessage bridge MUST get 403 error: 'guard'!
  assert.equal((await fix.api('/api/policies', { method: 'PATCH', body: { actions: { save: 'guard' } } })).status, 200);
  const guardPaused = await fix.mcpCall(claude, 'loop__save', {
    type: 'api_key',
    action: 'save',
    data: { key: 'GUARDED_KEY', value: 'guard-secret-999' },
  });
  assert.equal(guardPaused.parsed.status, 'approval_required');
  const guardId = guardPaused.parsed.approvalId;

  const guardTry = await fix.bridge(texter, `/approvals/${guardId}/decide`, { body: { decision: 'approve' } });
  assert.equal(guardTry.status, 403);
  assert.equal(guardTry.json.error, 'guard');
});

test('Phase 4: Web Dashboard Chat console (/api/chat, /api/chat/tools) and v3-hybrid-views.js asset', async (t) => {
  const fix = await startFixture(t);

  // Add a mock OpenAPI tool endpoint and import it so chat can search and run it.
  const upstream = http.createServer((req, res) => {
    if (req.url === '/openapi.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Chat Demo API', version: '1.0.0' },
        servers: [{ url: `http://127.0.0.1:${upstream.address().port}` }],
        paths: {
          '/ping': {
            get: {
              operationId: 'pingService',
              summary: 'Ping the demo service',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pong: true, ok: true }));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => upstream.close(r)));

  const imported = await fix.api('/api/mcps/import-api', {
    method: 'POST',
    body: {
      transport: 'openapi',
      name: 'Demo API',
      specUrl: `http://127.0.0.1:${upstream.address().port}/openapi.json`,
      allowLocal: true,
    },
  });
  assert.equal(imported.status, 201);
  const connId = imported.json.connection.id;

  const toolsRes = await fix.api('/api/chat/tools');
  assert.equal(toolsRes.status, 200);
  assert.ok(toolsRes.json.tools.some((tool) => tool.id === `${connId}__pingservice`));

  const helpRes = await fix.api('/api/chat', { method: 'POST', body: { message: '/help' } });
  assert.equal(helpRes.status, 200);
  assert.equal(helpRes.json.mode, 'help');

  const svcRes = await fix.api('/api/chat', { method: 'POST', body: { message: '/services' } });
  assert.equal(svcRes.status, 200);
  assert.ok(svcRes.json.services.length >= 1);

  const runRes = await fix.api('/api/chat', {
    method: 'POST',
    body: { message: `/run ${connId}__pingservice {}` },
  });
  assert.equal(runRes.status, 200);
  assert.equal(runRes.json.ok, true);
  assert.equal(runRes.json.result.pong, true);

  // Verify frontend v3-hybrid-views.js is served cleanly.
  const asset = await reqJson(fix.srv.port, '/v3-hybrid-views.js');
  assert.equal(asset.status, 200);
  assert.match(asset.text, /export async function renderSetup/);
  assert.match(asset.text, /export async function renderServicePage/);
  assert.match(asset.text, /export async function renderChat/);
});
