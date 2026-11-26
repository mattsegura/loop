import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { connectionAvailability, connectionReadiness } from '../lib/connection-readiness.mjs';
import { startServer } from '../server.mjs';

async function setupServer(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'loop-phase3-'));
  const srv = await startServer({
    port: 0,
    dataDir,
    authMode: 'local-test',
    detectLocalAgents: false,
    seedBuiltins: true,
  });
  t.after(async () => {
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${srv.port}`;
  const setupRes = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'phase3-password' }),
  });
  assert.equal(setupRes.status, 200);
  const cookie = (setupRes.headers.get('set-cookie') || '').split(';')[0];
  return { base, cookie, srv };
}

async function mcpPost(url, token, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('Phase 3: per-agent modules switches shrink schemas, hide uiCards & builtinWeb, and enforce calls', async (t) => {
  const { base, cookie } = await setupServer(t);
  const ownerHeaders = { 'Content-Type': 'application/json', Cookie: cookie };

  // Create a minimal agent for a host like Grok Bot or OpenBot that already has its own web & memory
  const createRes = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({
      name: 'Minimal Bot',
      kind: 'grok-bot',
      modules: {
        memory: false,
        tasks: false,
        storage: false,
        uiCards: false,
        builtinWeb: false,
        vault: false,
      },
    }),
  });
  assert.equal(createRes.status, 201);
  const { token, agent } = await createRes.json();
  assert.deepEqual(agent.modules, {
    memory: false,
    tasks: false,
    storage: false,
    uiCards: false,
    builtinWeb: false,
    vault: false,
  });

  // 1. tools/list omits loop__show and shrinks loop__search / loop__save enums
  const listRes = await mcpPost(`${base}/mcp`, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  });
  const tools = listRes.json.result.tools;
  const names = tools.map((tool) => tool.name);
  assert.equal(names.includes('loop__show'), false, 'uiCards: false hides loop__show');
  assert.equal(names.includes('loop__search'), true);
  assert.equal(names.includes('loop__run'), true);

  const searchEnum = tools.find((tool) => tool.name === 'loop__search').inputSchema.properties.type.enum;
  assert.equal(searchEnum.includes('memory'), false);
  assert.equal(searchEnum.includes('tasks'), false);
  assert.equal(searchEnum.includes('saved'), false);
  assert.equal(searchEnum.includes('vault'), false);
  assert.equal(searchEnum.includes('tools'), true);
  assert.equal(searchEnum.includes('connections'), true);

  // 2. Direct calls to disabled modules are rejected cleanly
  const showCall = await mcpPost(`${base}/mcp`, token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'loop__show', arguments: { ui: { root: 'r', elements: { r: { type: 'Card', props: { title: 'x' } } } } } },
  });
  assert.equal(showCall.json.result.isError, true);

  const memSearch = await mcpPost(`${base}/mcp`, token, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'loop__search', arguments: { type: 'memory', query: 'prefs' } },
  });
  assert.equal(memSearch.json.result.isError, true);
  assert.match(memSearch.json.result.content[0].text, /disabled/i);

  const taskSave = await mcpPost(`${base}/mcp`, token, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'loop__save', arguments: { type: 'task', data: { title: 'Test' } } },
  });
  assert.equal(taskSave.json.result.isError, true);
  assert.match(taskSave.json.result.content[0].text, /disabled/i);

  // 3. builtinWeb: false hides loop_web while keeping loop_utils
  const connsRes = await mcpPost(`${base}/mcp`, token, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'loop__search', arguments: { type: 'connections' } },
  });
  const connsPayload = JSON.parse(connsRes.json.result.content[0].text);
  const connIds = connsPayload.connections.map((c) => c.id);
  assert.equal(connIds.includes('loop_web'), false, 'builtinWeb: false hides loop_web');
  assert.equal(connIds.includes('loop_utils'), true, 'loop_utils remains visible');

  // 4. initialize instructions omit visual cards and built-in storage when disabled
  const initRes = await mcpPost(`${base}/mcp`, token, {
    jsonrpc: '2.0',
    id: 6,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', clientInfo: { name: 'grok-bot' }, capabilities: {} },
  });
  const instr = initRes.json.result.instructions;
  assert.doesNotMatch(instr, /loop__show/);
  assert.doesNotMatch(instr, /Built-in Loop storage/);

  // 5. Invalid module names are rejected by /api/agents
  const badRes = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ name: 'Bad', modules: { unknownMod: false } }),
  });
  assert.equal(badRes.status, 400);
});

test('Phase 3: connectionAvailability and readiness classify cloud_24x7, paired_mac_online/offline, and local_only', () => {
  const cloudConn = { id: 'gh', transport: 'http', url: 'https://api.github.com/mcp', enabled: true, tools: [{ name: 'list' }] };
  const localConn = { id: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'fs-mcp'], enabled: true, tools: [{ name: 'read' }] };
  const relayConnOnline = {
    id: 'mac_fs',
    transport: 'http',
    url: 'https://relay.useloop.sh/d/dev_0123456789abcdef/fs',
    enabled: true,
    tools: [{ name: 'read' }],
  };
  const relayConnOffline = {
    id: 'mac_notes',
    transport: 'http',
    url: 'https://relay.useloop.sh/d/dev_0123456789abcdef/notes',
    enabled: true,
    tools: [{ name: 'list' }],
    lastError: 'Paired computer is offline',
  };

  assert.equal(connectionAvailability(cloudConn), 'cloud_24x7');
  assert.equal(connectionReadiness(cloudConn).availability, 'cloud_24x7');

  assert.equal(connectionAvailability(localConn), 'local_only');
  assert.equal(connectionReadiness(localConn).availability, 'local_only');
  assert.equal(connectionReadiness(localConn, { personal: true }).availability, 'local_only');

  assert.equal(connectionAvailability(relayConnOnline), 'paired_mac_online');
  assert.equal(connectionAvailability(relayConnOnline, { relayOnline: false }), 'paired_mac_offline');
  assert.equal(connectionAvailability(relayConnOffline), 'paired_mac_offline');
  assert.equal(connectionReadiness(relayConnOffline).availability, 'paired_mac_offline');
});
