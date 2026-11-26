import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../server.mjs';

async function startMockMcp(t, tools) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const rpc = JSON.parse(body || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (rpc.method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1.0' } } }));
        return;
      }
      if (rpc.method === 'tools/list') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: tools.map(({ run, ...meta }) => meta) } }));
        return;
      }
      if (rpc.method === 'tools/call') {
        const found = tools.find((x) => x.name === rpc.params?.name);
        if (!found) {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { isError: true, content: [{ type: 'text', text: 'not found' }] } }));
          return;
        }
        const out = found.run(rpc.params?.arguments || {});
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: out }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {} }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  return `http://127.0.0.1:${srv.address().port}/mcp`;
}

async function setupLoop(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-search-batch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const srv = await startServer({
    dataDir: dir,
    home: dir,
    port: 0,
    authMode: 'local-test',
    hosted: false,
    autoSync: false,
    detectLocalAgents: false,
    seedBuiltins: true,
    searchEnv: { LOOP_EMBEDDING_PROVIDER: 'off' },
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const setupRes = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password-1234' }),
  });
  const cookie = (setupRes.headers.get('set-cookie') || '').split(';')[0];
  const agentRes = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Eval Agent', profile: 'all', memoryAccess: 'read_write', canManage: true }),
  });
  const { token } = await agentRes.json();
  const call = async (name, args) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const j = await r.json();
    const text = j.result?.content?.[0]?.text || '';
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { isError: Boolean(j.result?.isError), text, json, raw: j.result };
  };
  return { dir, base, cookie, token, call };
}

test('search connections handles inventory queries, workspace totals, and deduplicated stateGuidance', async (t) => {
  const { dir, base, cookie, call } = await setupLoop(t);

  // Add two local command connections marked as unsupported in hosted mode.
  for (const id of ['broken_one', 'broken_two']) {
    await fetch(`${base}/api/mcps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ id, name: id, transport: 'stdio', command: 'echo', enabled: true }),
    });
  }
  const cfgPath = path.join(dir, 'config.json');
  const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
  for (const m of cfg.mcps) {
    if (m.id === 'broken_one' || m.id === 'broken_two') {
      m.lastError = 'Personal MCP allows only remote HTTP or SSE without command, environment, or OAuth settings.';
    }
  }
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2));

  // Inventory question returns full workspace list rather than filtering to 0-2 rows.
  const inv = await call('loop__search', { type: 'connections', query: 'what do I have connected?' });
  assert.equal(inv.isError, false);
  assert.ok(inv.json.total >= 4);
  assert.equal(inv.json.workspaceTotal, inv.json.total);
  assert.equal(inv.json.summary.unsupported, 2);
  assert.ok(inv.json.stateGuidance?.unsupported_workspace);
  assert.equal(inv.json.stateGuidance.unsupported_workspace.count, 2);
  // Compact readiness omits duplicated handoff strings on multi-row responses.
  const b1 = inv.json.connections.find((c) => c.id === 'broken_one');
  assert.equal(b1.readiness.state, 'unsupported_workspace');
  assert.equal(b1.readiness.handoff, undefined);

  // Filtered connection search reports workspaceTotal and notShown clearly.
  const filtered = await call('loop__search', { type: 'connections', query: 'loop_utils' });
  assert.equal(filtered.isError, false);
  assert.ok(filtered.json.workspaceTotal > filtered.json.returned);
  assert.equal(filtered.json.notShown, filtered.json.workspaceTotal - filtered.json.returned);
  assert.ok(filtered.json.workspaceSummary.ready >= 1);
});

test('search tools does not contradict a clear ready tool match with "No tool here clearly fits"', async (t) => {
  const { call } = await setupLoop(t);
  const res = await call('loop__search', { type: 'tools', query: 'what time is it in Tokyo' });
  assert.equal(res.isError, false);
  assert.equal(res.json.tools[0]?.tool, 'loop_utils__time_now');
  assert.notEqual(res.json.lowConfidence, true);
  assert.doesNotMatch(String(res.json.nextStep || ''), /No tool here clearly fits/i);
  assert.equal(res.json.suggestedSkills, undefined);
});

test('batch run supports bracket $from, array pick, unmatched pick fallback, and failed-only summary', async (t) => {
  const url = await startMockMcp(t, [
    {
      name: 'list_rows',
      description: 'Return sample rows',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      run: () => ({ content: [{ type: 'text', text: JSON.stringify({ rows: [{ n: 42, title: 'Alpha' }, { n: 99, title: 'Beta' }] }) }] }),
    },
    {
      name: 'echo_num',
      description: 'Echo a number',
      inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
      annotations: { readOnlyHint: true },
      run: (a) => ({ content: [{ type: 'text', text: JSON.stringify({ echoed: a.value }) }] }),
    },
    {
      name: 'always_fail',
      description: 'Fail on purpose',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      run: () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }),
    },
  ]);
  const { base, cookie, call } = await setupLoop(t);
  const added = await fetch(`${base}/api/mcps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Mock', transport: 'http', url }),
  });
  const { mcp } = await added.json();
  await fetch(`${base}/api/mcps/${mcp.id}/sync`, { method: 'POST', headers: { Cookie: cookie } });

  // Bracket $from (`rows[0].n`) and array-mapped pick (`rows.title`).
  const chained = await call('loop__run', {
    stopOnError: false,
    calls: [
      { tool: `${mcp.id}__list_rows`, arguments: {} },
      { tool: `${mcp.id}__echo_num`, arguments: { value: { $from: 'calls[0].output.rows[0].n' } } },
      { tool: `${mcp.id}__list_rows`, arguments: {}, pick: ['rows.title'] },
      { tool: `${mcp.id}__list_rows`, arguments: {}, pick: ['does_not_exist'] },
      { tool: `${mcp.id}__always_fail`, arguments: {} },
    ],
  });
  assert.equal(chained.json.results[1].ok, true);
  assert.equal(chained.json.results[1].output.echoed, 42);
  assert.deepEqual(chained.json.results[2].output['rows.title'], ['Alpha', 'Beta']);
  // Unmatched pick keeps original output instead of returning `{}` and names the unmatched path.
  assert.deepEqual(chained.json.results[3].unmatchedPick, ['does_not_exist']);
  assert.ok(Array.isArray(chained.json.results[3].output.rows));
  assert.ok(chained.json.results[3].availableFields.includes('rows'));
  // Summary names only the failed tool.
  assert.match(chained.json.summary, /failed: .*always_fail/);
  assert.doesNotMatch(chained.json.summary, /echo_num/);

  // Missing $from field names available fields.
  const badFrom = await call('loop__run', {
    calls: [
      { tool: `${mcp.id}__list_rows`, arguments: {} },
      { tool: `${mcp.id}__echo_num`, arguments: { value: { $from: 'calls[0].output.missing' } } },
    ],
  });
  assert.equal(badFrom.json.results[1].ok, false);
  assert.match(badFrom.json.results[1].output.error, /Available fields:.*rows/);
});

test('batch loop__save validates required content before writing anything', async (t) => {
  const { call } = await setupLoop(t);
  const bad = await call('loop__save', {
    items: [
      { type: 'memory', data: { content: 'First item must not be written when item 2 is invalid.' } },
      { type: 'memory', data: { content: '' } },
    ],
  });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /items\[1\]:.*Memory content is required.*Nothing was saved/i);

  const mems = await call('loop__search', { type: 'memory' });
  assert.equal(mems.json.memories.length, 0);
});
