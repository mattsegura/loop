import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectionReadiness, isWorkspaceUnsupportedConnection } from '../lib/connection-readiness.mjs';
import { assertPersonalConnection } from '../lib/personal-upstreams.mjs';
import { classifyUpstreamError } from '../lib/mcp-errors.mjs';
import { buildDoctorReport } from '../lib/dream.mjs';
import { handleCoreLoopInspect } from '../lib/mcp/core-loop-handlers.mjs';
import { startServer } from '../server.mjs';

test('connectionReadiness reports unsupported_workspace for stdio connections in personal mode', () => {
  const stdioConn = {
    id: 'local_cli',
    name: 'Local CLI',
    transport: 'stdio',
    command: 'npx',
    enabled: true,
    tools: [{ name: 'run_thing' }],
    lastError: 'Personal MCP allows only remote HTTP or SSE without command, environment, or OAuth settings.',
  };
  assert.equal(isWorkspaceUnsupportedConnection(stdioConn, { personal: true }), true);
  assert.equal(isWorkspaceUnsupportedConnection(stdioConn, { personal: false }), true);

  const r = connectionReadiness(stdioConn, { personal: true });
  assert.equal(r.state, 'unsupported_workspace');
  assert.equal(r.label, 'Cannot run here');
  assert.equal(r.ready, false);
  assert.equal(r.action, null);
  assert.match(r.nextStep, /hosted|personal/i);
  assert.doesNotMatch(r.nextStep, /Check the local connector installation/i);
  assert.doesNotMatch(r.handoff, /Verify that an enabled tool is available/i);

  // Disabled takes priority over unsupported_workspace.
  const disabled = connectionReadiness({ ...stdioConn, enabled: false }, { personal: true });
  assert.equal(disabled.state, 'disabled');

  // Local mode without the personal refusal error still treats stdio normally.
  const normalLocal = connectionReadiness({ ...stdioConn, lastError: null }, { personal: false });
  assert.equal(normalLocal.state, 'ready');
});

test('assertPersonalConnection throws a non-retryable NOT_SUPPORTED_HERE error', () => {
  let caught = null;
  try {
    assertPersonalConnection({ id: 'x', name: 'X', transport: 'stdio', command: 'echo' });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.equal(caught.code, 'NOT_SUPPORTED_HERE');
  assert.equal(caught.status, 400);
  assert.equal(caught.retryable, false);

  const classified = classifyUpstreamError(caught, { isReadOnly: true });
  assert.equal(classified.code, 'NOT_SUPPORTED_HERE');
  assert.equal(classified.retryable, false);
  assert.equal(classified.mayHaveWritten, false);
  assert.equal(classified.recovery.action, 'use_other_tool');
});

test('doctor report reflects connection health and does not advise sleep-time review when off', async () => {
  const reportOff = buildDoctorReport({
    memories: [
      { id: 'm1', key: 'k1', content: 'Always write clean commit messages for Loop releases.' },
      { id: 'm2', key: 'k2', content: 'Always write clean commit messages for Loop releases.' },
    ],
    skills: [],
    turns: [],
    dreamSummary: { serverEnabled: false, enabled: false, pendingProposals: [] },
  });
  assert.doesNotMatch(reportOff.nextAction, /Run a sleep-time reflection pass/i);
  assert.match(reportOff.nextAction, /sleep-time review is off/i);

  const inspected = await handleCoreLoopInspect({
    type: 'doctor',
    args: {},
    access: { memoryAccess: 'read_write', profile: 'all', personal: true },
    dreamStore: {
      doctor: async () => buildDoctorReport({ memories: [], skills: [], turns: [], dreamSummary: { serverEnabled: false, enabled: false, pendingProposals: [] } }),
    },
    connections: {
      mode: 'hosted',
      total: 4,
      ready: 1,
      needsSignIn: 1,
      tokenRejected: 0,
      failed: 0,
      unsupported: 2,
      disabled: 0,
      notSynced: 0,
      byState: { ready: 1, needs_sign_in: 1, unsupported_workspace: 2 },
      notReady: [
        { id: 'c1', name: 'C1', state: 'unsupported_workspace', label: 'Cannot run here' },
        { id: 'c2', name: 'C2', state: 'unsupported_workspace', label: 'Cannot run here' },
        { id: 'c3', name: 'C3', state: 'needs_sign_in', label: 'Needs sign-in' },
      ],
    },
    textResult: (payload, isError = false) => ({ payload, isError }),
  });
  assert.equal(inspected.isError, false);
  assert.equal(inspected.payload.healthy, false);
  assert.equal(inspected.payload.connections.unsupported, 2);
  assert.ok(inspected.payload.findings.some((f) => f.category === 'connections_unsupported'));
  assert.match(inspected.payload.summaryText, /2 cannot run here/);
});

test('loop__run blocks unsupported_workspace connection with NOT_SUPPORTED_HERE and doctor reports it', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-unsupported-ws-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const boot = () => startServer({
    dataDir: dir,
    home: dir,
    port: 0,
    authMode: 'local-test',
    hosted: false,
    autoSync: false,
    detectLocalAgents: false,
    searchEnv: { LOOP_EMBEDDING_PROVIDER: 'off' },
  });

  // First boot: create owner, agent, and stdio connection via normal routes so config.json has the exact store shape.
  const srv1 = await boot();
  const base1 = `http://127.0.0.1:${srv1.port}`;
  const setupRes = await fetch(`${base1}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password-1234' }),
  });
  assert.equal(setupRes.status, 200);
  const cookie = (setupRes.headers.get('set-cookie') || '').split(';')[0];
  const agentRes = await fetch(`${base1}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Test Agent', profile: 'all', memoryAccess: 'read_write', canManage: true }),
  });
  const { token } = await agentRes.json();
  const addRes = await fetch(`${base1}/api/mcps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id: 'local_cmd',
      name: 'Local Cmd',
      transport: 'stdio',
      command: 'echo',
      args: ['hi'],
      enabled: true,
    }),
  });
  assert.ok([200, 201].includes(addRes.status));
  await srv1.close();

  // Persist the hosted-mode refusal error and a discovered tool catalog on disk, then reboot.
  const cfgPath = path.join(dir, 'config.json');
  const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
  const target = (cfg.mcps || []).find((m) => m.id === 'local_cmd');
  assert.ok(target);
  target.lastError = 'Personal MCP allows only remote HTTP or SSE without command, environment, or OAuth settings.';
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
  const catDir = path.join(dir, 'catalogs');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(catDir, { recursive: true });
  await writeFile(
    path.join(catDir, 'local_cmd.json'),
    JSON.stringify({
      tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }],
      resources: [],
      prompts: [],
      skills: [],
    }, null, 2),
  );

  const srv = await boot();
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;

  const mcpCall = async (method, params) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return r.json();
  };

  const runResp = await mcpCall('tools/call', { name: 'loop__run', arguments: { tool: 'local_cmd__ping', arguments: {} } });
  assert.equal(runResp.result.isError, true);
  assert.equal(runResp.result.structuredContent.code, 'NOT_SUPPORTED_HERE');
  assert.equal(runResp.result.structuredContent.retryable, false);

  const docResp = await mcpCall('tools/call', { name: 'loop__inspect', arguments: { type: 'doctor' } });
  const docData = JSON.parse(docResp.result.content[0].text);
  assert.equal(docData.connections.unsupported, 1);
  assert.ok(docData.findings.some((f) => f.category === 'connections_unsupported'));
});
