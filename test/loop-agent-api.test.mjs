import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { startServer } from '../server.mjs';

const OWNER_PW = 'specialist-owner-pw-123';

function reqRaw(port, route, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method,
        headers: {
          ...(payload !== null && !headers['Content-Type'] ? { 'Content-Type': 'application/json' } : {}),
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
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function parseSseFrames(text) {
  const out = [];
  for (const frame of String(text || '').split(/\r?\n\r?\n/)) {
    let event = 'message';
    const dataLines = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    let data = dataLines.join('\n');
    try { data = JSON.parse(data); } catch { /* raw */ }
    out.push({ event, data });
  }
  return out;
}

async function startFixture(t, extraOpts = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-agent-api-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {}));
  const srv = await startServer({
    port: 0,
    dataDir: dir,
    authMode: 'local-test',
    autoSync: false,
    detectLocalAgents: false,
    billingEnv: {},
    ...extraOpts,
  });
  t.after(() => srv.close());
  const setup = await reqRaw(srv.port, '/api/auth/setup', { method: 'POST', body: { password: OWNER_PW } });
  assert.equal(setup.status, 200);
  const cookie = String([].concat(setup.headers['set-cookie'])[0] || '').split(';')[0];
  const api = (route, opts = {}) => reqRaw(srv.port, route, { ...opts, headers: { Cookie: cookie, ...(opts.headers || {}) } });
  return { srv, api, dir };
}

test('Loop Specialist API: local run uses ephemeral MCP token for full loop__save + revokes token after exit', async (t) => {
  let seenRunToken = '';
  let seenMcpUrl = '';
  const fix = await startFixture(t, {
    loopAgentDetectClis: () => ({ claude: '/mock/claude', codex: '/mock/codex' }),
    loopAgentRunnerImpls: {
      runClaudeCli: async ({ mcpUrl, runToken, prompt, onEvent }) => {
        seenMcpUrl = mcpUrl;
        seenRunToken = runToken;
        assert.match(prompt, /Build a memory/);
        // Call the REAL Loop /mcp endpoint using the temporary run token!
        const res = await fetch(mcpUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${runToken}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'loop__save',
              arguments: {
                type: 'memory',
                data: { content: 'Architecture uses five-item center Loop bar.', scope: 'project', tags: ['ui'] },
              },
            },
          }),
        });
        assert.equal(res.status, 200);
        const rpc = await res.json();
        const savedText = rpc.result.content[0].text;
        const parsed = JSON.parse(savedText);
        assert.ok(parsed.memory?.id);
        onEvent({ type: 'delta', text: 'Saved your architecture memory.' });
        return {
          text: 'Saved your architecture memory.',
          sessionId: 'claude_sess_live_1',
          steps: [{ callId: 'c1', tool: 'loop__save', input: { type: 'memory' }, output: savedText, ok: true, durationMs: 25 }],
          createdItems: [{ id: parsed.memory.id, kind: 'memory', title: parsed.memory.content }],
          model: 'sonnet',
        };
      },
    },
  });

  // 1) Capabilities report local enabled with claude-cli + codex-cli ready
  const caps = await fix.api('/api/loop-agent/capabilities');
  assert.equal(caps.status, 200);
  assert.equal(caps.json.enabled, true);
  assert.equal(caps.json.defaultRunner, 'claude-cli');
  assert.ok(caps.json.runners.some((r) => r.id === 'claude-cli' && r.available));
  assert.ok(caps.json.runners.some((r) => r.id === 'codex-cli' && r.available));

  // 2) Create thread and run SSE turn
  const thrRes = await fix.api('/api/loop-agent/threads', { method: 'POST', body: {} });
  assert.equal(thrRes.status, 201);
  const threadId = thrRes.json.thread.id;

  const runRes = await fix.api(`/api/loop-agent/threads/${threadId}/runs`, {
    method: 'POST',
    body: { message: 'Build a memory about our nav bar' },
  });
  assert.equal(runRes.status, 200);
  assert.match(String(runRes.headers['content-type']), /text\/event-stream/);
  const frames = parseSseFrames(runRes.text);
  const doneFrame = frames.find((f) => f.event === 'done');
  assert.ok(doneFrame, 'SSE stream should emit a done frame');
  assert.equal(doneFrame.data.message.text, 'Saved your architecture memory.');
  assert.equal(doneFrame.data.message.createdItems.length, 1);

  // 3) Temporary run token MUST be revoked immediately after the run ends!
  assert.ok(seenRunToken.startsWith('loop_run_'));
  const afterRevoke = await fetch(seenMcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${seenRunToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  assert.equal(afterRevoke.status, 401);

  // 4) Memory truly landed in Loop Library graph!
  const graphRes = await fix.api('/api/memory/graph');
  assert.equal(graphRes.status, 200);
  const nodes = graphRes.json?.graph?.nodes || [];
  assert.ok(nodes.some((n) => /five-item center Loop bar/i.test(n.content || n.label || '')));

  // 5) Flag the run trace and inspect it
  const runId = doneFrame.data.runId;
  const flagRes = await fix.api(`/api/loop-agent/runs/${runId}/flag`, {
    method: 'POST',
    body: { flagged: true, note: 'Should also create a linked saved note.' },
  });
  assert.equal(flagRes.status, 200);
  assert.equal(flagRes.json.trace.flagged, true);

  const flaggedList = await fix.api('/api/loop-agent/traces?flagged=1');
  assert.equal(flaggedList.status, 200);
  assert.equal(flaggedList.json.traces.length, 1);
  assert.equal(flaggedList.json.traces[0].flagNote, 'Should also create a linked saved note.');
});

test('Loop Specialist API: Vault API-key runner executes in-process MCP tools and redacts secrets from traces', async (t) => {
  const SECRET_VALUE = 'sk-ant-super-secret-value-987654321';
  const fix = await startFixture(t, {
    loopAgentDetectClis: () => ({ claude: null, codex: null }),
    loopAgentRunnerImpls: {
      runApiAgentLoop: async ({ apiKey, listMcpTools, callMcpTool, onEvent }) => {
        assert.equal(apiKey, SECRET_VALUE);
        const tools = await listMcpTools();
        assert.ok(tools.some((tool) => tool.name === 'loop__save'));
        assert.ok(tools.some((tool) => tool.name === 'loop__search'));
        const saveOut = await callMcpTool('loop__save', {
          type: 'saved',
          data: { title: 'Strategy brief', markdown: '# Strategy\n\nBuilt by Loop Specialist.' },
        });
        assert.equal(saveOut.ok, true);
        // Simulate accidental secret echo — Loop must redact it before SSE & SQLite!
        const reply = `Saved brief. Leaked echo check: ${SECRET_VALUE}`;
        onEvent({ type: 'delta', text: reply });
        return {
          text: reply,
          sessionId: '',
          steps: [{ callId: 't1', tool: 'loop__save', input: { type: 'saved' }, output: saveOut.text, ok: true, durationMs: 12 }],
          createdItems: [],
          model: 'claude-sonnet-4-6',
        };
      },
    },
  });

  // Save Anthropic key into Vault via runner API
  const saveKey = await fix.api('/api/loop-agent/runners', {
    method: 'PUT',
    body: { defaultRunner: 'anthropic', apiKey: { provider: 'anthropic', key: SECRET_VALUE } },
  });
  assert.equal(saveKey.status, 200);
  assert.equal(saveKey.text.includes(SECRET_VALUE), false, 'API response must never echo raw secret');
  assert.ok(saveKey.json.runners.some((r) => r.id === 'anthropic' && r.available && r.hasKey));

  // Save MausBot endpoint + token into Vault too
  const saveMaus = await fix.api('/api/loop-agent/runners', {
    method: 'PUT',
    body: {
      mausbot: {
        endpoint: 'http://127.0.0.1:18880/hooks/api/bots/test-bot/messages',
        apiKey: 'bak_secret_mausbot_token_12345',
      },
    },
  });
  assert.equal(saveMaus.status, 200);
  assert.equal(saveMaus.json.mausbot.configured, true);
  assert.equal(saveMaus.json.mausbot.hasKey, true);
  assert.equal(saveMaus.text.includes('bak_secret_mausbot_token_12345'), false);

  const thr = (await fix.api('/api/loop-agent/threads', { method: 'POST', body: {} })).json.thread;
  const runRes = await fix.api(`/api/loop-agent/threads/${thr.id}/runs`, {
    method: 'POST',
    body: { message: 'Write a strategy brief', runner: 'anthropic' },
  });
  assert.equal(runRes.status, 200);
  assert.equal(runRes.text.includes(SECRET_VALUE), false, 'SSE stream must redact Vault secrets');

  const traces = (await fix.api('/api/loop-agent/traces')).json.traces;
  assert.equal(traces.length, 1);
  assert.equal(JSON.stringify(traces[0]).includes(SECRET_VALUE), false, 'Stored trace must redact Vault secrets');
});

test('Loop Specialist API: hosted mode disables chat without MausBot and enables it when MausBot HTTPS URL is set', async (t) => {
  const hostedOff = await startFixture(t, { hosted: true, env: {} });
  const capsOff = await hostedOff.api('/api/loop-agent/capabilities');
  assert.equal(capsOff.status, 200);
  assert.equal(capsOff.json.enabled, false);
  assert.equal(capsOff.json.hosted, true);
  const blockedThread = await hostedOff.api('/api/loop-agent/threads', { method: 'POST', body: {} });
  assert.equal(blockedThread.status, 403);

  const hostedOn = await startFixture(t, {
    hosted: true,
    env: { LOOP_MAUSBOT_URL: 'https://mausbot.example.com/hooks/api/bots/abc/messages', LOOP_MAUSBOT_TOKEN: 'bak_hosted_secret_99' },
  });
  const capsOn = await hostedOn.api('/api/loop-agent/capabilities');
  assert.equal(capsOn.status, 200);
  assert.equal(capsOn.json.enabled, true);
  assert.equal(capsOn.json.defaultRunner, 'mausbot');
  assert.equal(capsOn.json.mausbot.configured, true);

  // Dashboard HTML and JS assets serve cleanly. The nav has no Loop chat button.
  const html = await hostedOff.api('/');
  assert.equal(html.status, 200);
  assert.doesNotMatch(html.text, /data-nav="loop"/);
  assert.match(html.text, />Home</);
  const chatJs = await hostedOff.api('/loop-chat-view.js');
  assert.equal(chatJs.status, 200);
  assert.match(chatJs.text, /renderLoopChat/);
});

test('Loop Specialist API: runs with full owner-session permissions across CLI and API-key runners while keeping Guard and external agent limits', async (t) => {
  const fix = await startFixture(t, {
    loopAgentDetectClis: () => ({ claude: '/mock/claude', codex: null }),
    loopAgentRunnerImpls: {
      runClaudeCli: async ({ mcpUrl, runToken }) => {
        // Initialize MCP session (verifying ?project=work focuses cleanly without locking workspace access)
        const initRes = await fetch(mcpUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${runToken}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '1.0' } },
          }),
        });
        assert.equal(initRes.status, 200);
        const sessionId = initRes.headers.get('mcp-session-id');
        assert.ok(sessionId, 'initialize must return an MCP session id');

        const callMcp = async (id, name, args) => {
          const res = await fetch(mcpUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${runToken}`,
              'mcp-session-id': sessionId,
            },
            body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
          });
          assert.equal(res.status, 200);
          const rpc = await res.json();
          const text = rpc.result?.content?.[0]?.text || '';
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
          return { isError: Boolean(rpc.result?.isError), parsed };
        };

        // 1) Delete an owner-created memory immediately without always_ask approval block
        const listMem = await callMcp(1, 'loop__search', { type: 'memory', query: 'Owner pre-existing fact' });
        assert.equal(listMem.isError, false);
        const memId = listMem.parsed.memories[0]?.id;
        assert.ok(memId, 'Specialist should see workspace-wide owner memory even when a project is focused');

        const delMem = await callMcp(2, 'loop__save', { type: 'memory', action: 'delete', id: memId });
        assert.equal(delMem.isError, false);
        assert.equal(delMem.parsed.deleted ?? delMem.parsed.forgotten, true);

        // 2) Create a new Vault secret mid-run and immediately see + delete it (not blocked by stale secrets snapshot)
        const saveSecret = await callMcp(3, 'loop__save', {
          type: 'api_key',
          id: 'SPECIALIST_MIDRUN_KEY',
          data: { value: 'tok_midrun_secret_abcdef1234', description: 'Created mid-run' },
        });
        assert.equal(saveSecret.isError, false);
        assert.equal(saveSecret.parsed.sharedWithThisAgent, true);

        const searchVault = await callMcp(4, 'loop__search', { type: 'vault', query: 'SPECIALIST_MIDRUN_KEY' });
        assert.equal(searchVault.isError, false);
        assert.ok(searchVault.parsed.vault.some((v) => v.key === 'SPECIALIST_MIDRUN_KEY'));

        const delSecret = await callMcp(5, 'loop__save', { type: 'api_key', action: 'delete', id: 'SPECIALIST_MIDRUN_KEY' });
        assert.equal(delSecret.isError, false);
        assert.equal(delSecret.parsed.deleted, true);

        // 3) Check /mcp/whoami reports ownerSession: true and profile: 'all'
        const whoamiUrl = `${new URL(mcpUrl).origin}/mcp/whoami`;
        const whoamiRes = await fetch(whoamiUrl, { headers: { Authorization: `Bearer ${runToken}` } });
        assert.equal(whoamiRes.status, 200);
        const whoami = await whoamiRes.json();
        assert.equal(whoami.agent.ownerSession, true);
        assert.equal(whoami.agent.profile, 'all');

        // 4) Explicit Guard rule still requires Loop password confirmation
        const guardOrg = await callMcp(6, 'loop__save', {
          type: 'category',
          dryRun: false,
          data: { createCategories: [{ id: 'custom-ops', label: 'Ops' }] },
        });
        assert.equal(guardOrg.parsed.status, 'approval_required');
        assert.equal(guardOrg.parsed.guard, true);

        return { text: 'Owner-session checks passed.', sessionId: 's_owner_1', steps: [], createdItems: [], model: 'sonnet' };
      },
      runApiAgentLoop: async ({ callMcpTool }) => {
        const listMem = await callMcpTool('loop__search', { type: 'memory', query: 'Second owner fact' });
        assert.equal(listMem.ok, true);
        const memId = JSON.parse(listMem.text).memories[0]?.id;
        assert.ok(memId);
        const delMem = await callMcpTool('loop__save', { type: 'memory', action: 'delete', id: memId });
        assert.equal(delMem.ok, true);
        const delParsed = JSON.parse(delMem.text);
        assert.equal(delParsed.deleted ?? delParsed.forgotten, true);
        return { text: 'API runner owner-session passed.', sessionId: '', steps: [], createdItems: [], model: 'claude-sonnet-4-6' };
      },
    },
  });

  // Seed a project, three owner memories, and policies (delete: always_ask, organize: guard).
  assert.equal((await fix.api('/api/profiles', { method: 'POST', body: { id: 'work', name: 'Work' } })).status, 201);
  assert.equal((await fix.api('/api/memory', { method: 'POST', body: { content: 'Owner pre-existing fact', scope: 'global' } })).status, 201);
  assert.equal((await fix.api('/api/memory', { method: 'POST', body: { content: 'Second owner fact', scope: 'global' } })).status, 201);
  const thirdMemRes = await fix.api('/api/memory', { method: 'POST', body: { content: 'External agent cannot delete without approval', scope: 'global' } });
  assert.equal(thirdMemRes.status, 201);
  const thirdMemId = thirdMemRes.json.memory.id;

  assert.equal((await fix.api('/api/policies', { method: 'PUT', body: { actions: { delete: 'always_ask', organize: 'guard' } } })).status, 200);

  // Run CLI specialist while focused on project "work"
  const thr1 = (await fix.api('/api/loop-agent/threads', { method: 'POST', body: { project: 'work' } })).json.thread;
  const cliRun = await fix.api(`/api/loop-agent/threads/${thr1.id}/runs`, {
    method: 'POST',
    body: { message: 'Run owner-session checks', project: 'work' },
  });
  assert.equal(cliRun.status, 200);
  const cliDone = parseSseFrames(cliRun.text).find((f) => f.event === 'done');
  assert.ok(cliDone, `CLI run failed: ${cliRun.text}`);
  assert.equal(cliDone.data.message.text, 'Owner-session checks passed.');

  // Configure Anthropic API key and run in-process API runner while focused on project "work"
  assert.equal((await fix.api('/api/loop-agent/runners', {
    method: 'PUT',
    body: { apiKey: { provider: 'anthropic', key: 'sk-ant-owner-session-test-999' } },
  })).status, 200);
  const apiRun = await fix.api(`/api/loop-agent/threads/${thr1.id}/runs`, {
    method: 'POST',
    body: { message: 'Delete second owner fact', runner: 'anthropic', project: 'work' },
  });
  assert.equal(apiRun.status, 200);
  const apiDone = parseSseFrames(apiRun.text).find((f) => f.event === 'done');
  assert.ok(apiDone, `API run failed: ${apiRun.text}`);
  assert.equal(apiDone.data.message.text, 'API runner owner-session passed.');

  // External agent with canManage: true MUST still hit delete: always_ask approval
  const extAgentRes = await fix.api('/api/agents', {
    method: 'POST',
    body: { name: 'External Bot', kind: 'custom', profile: 'all', canManage: true, memoryAccess: 'read_write' },
  });
  assert.equal(extAgentRes.status, 201);
  const extToken = extAgentRes.json.token;
  assert.ok(extToken);
  const extDelRes = await fetch(`http://127.0.0.1:${fix.srv.port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${extToken}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'loop__save', arguments: { type: 'memory', action: 'delete', id: thirdMemId } },
    }),
  });
  assert.equal(extDelRes.status, 200);
  const extDelRpc = await extDelRes.json();
  const extDelParsed = JSON.parse(extDelRpc.result.content[0].text);
  assert.equal(extDelParsed.status, 'approval_required');
});
