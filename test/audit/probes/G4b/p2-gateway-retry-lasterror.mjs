// P2 (end to end, root workspace): (1) loop__run re-executes side-effecting upstream tools after a failure,
// including an approval-gated call approved once; (2) upstream error bodies / stdio stderr land unmasked in
// lastError and reach an agent that was never shared the secret; (3) lastError size is unbounded.
import { startLegacy, startMockUpstream, writeMockStdio, sandboxDir, result } from '../../harness.mjs';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stdioMockSource } from './stdio-mock-src.mjs';

process.on('unhandledRejection', (e) => console.log('UNHANDLED REJECTION', e?.message || e));
process.on('uncaughtException', (e) => console.log('UNCAUGHT', e?.message || e));

const SECRET = 'sk-probe-SECRET-0123456789abcdef';
const counts = {};
const up = await startMockUpstream({
  tools: ['pay', 'charge_rpc', 'drop', 'approved_pay'].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: { amount: { type: 'number' } } } })),
  handler: async (body, req, res) => {
    if (body?.method !== 'tools/call') return false;
    const name = body.params?.name;
    counts[name] = (counts[name] || 0) + 1;
    const n = counts[name];
    if (name === 'pay' && n === 1) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('temporary glitch after charging'); return true; }
    if (name === 'approved_pay' && n === 1) { res.writeHead(502); res.end('bad gateway'); return true; }
    if (name === 'drop' && n === 1) { req.socket.destroy(); return true; }
    if (name === 'charge_rpc') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'card declined' } })); return true; }
    return false; // default echo
  },
});

// Upstream that echoes the API key it was sent in an error body (common "invalid key <value>" pattern).
const leaky = await startMockUpstream({
  handler: async (body, req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `invalid api key ${req.headers['x-api-key']}` }));
    return true;
  },
});
// Upstream with a 2 MB error page.
const huge = await startMockUpstream({ handler: async (body, req, res) => { res.writeHead(500, { 'content-type': 'text/html' }); res.end('<html>' + 'x'.repeat(2 * 1024 * 1024) + '</html>'); return true; } });

const L = await startLegacy();
try {
  const v = await L.api('/api/vault', { method: 'POST', body: { key: 'API_KEY', value: SECRET } });
  result('vault.set', v.status);
  const add = await L.api('/api/mcps', { method: 'POST', body: { name: 'Up', transport: 'http', url: up.url } });
  result('add.up', { status: add.status, id: add.json?.mcp?.id, err: add.json?.mcp?.lastError });

  // (1) Retries of side-effecting calls through the gateway.
  for (const tool of ['pay', 'charge_rpc', 'drop']) {
    const r = await L.callTool('loop__run', { tool: `up__${tool}`, arguments: { amount: 5 } });
    result(`retry.${tool}`, { agentSaw: r.result?.content?.[0]?.text?.slice(0, 120), isError: r.result?.isError, upstreamExecutions: counts[tool] });
  }
  // Approval-gated tool: approve once, executed twice.
  const pol = await L.api('/api/policies', { method: 'PATCH', body: { tools: { up__approved_pay: 'always_ask' } } });
  result('policy.set', pol.status);
  const first = await L.callTool('loop__run', { tool: 'up__approved_pay', arguments: { amount: 100 } });
  const approvalId = JSON.parse(first.result?.content?.[0]?.text || '{}').approvalId;
  const appr = await L.api(`/api/approvals/${approvalId}/approve`, { method: 'POST' });
  const second = await L.callTool('loop__run', { tool: 'up__approved_pay', arguments: { amount: 100 }, approvalId });
  result('approval.oneApprovalTwoExecutions', { approvalId, approve: appr.status, agentSaw: second.result?.content?.[0]?.text?.slice(0, 80), upstreamExecutions: counts.approved_pay });

  // (2) lastError leak to an agent without the secret.
  const addLeaky = await L.api('/api/mcps', { method: 'POST', body: { name: 'Leaky', transport: 'http', url: leaky.url, headers: { 'X-API-Key': '{{vault:API_KEY}}' } } });
  result('leaky.lastErrorStored', addLeaky.json?.mcp?.lastError);
  const stdio = writeMockStdio(sandboxDir('stdio'), { source: stdioMockSource() });
  const dir = sandboxDir('st'); const pidFile = path.join(dir, 'p'); const callsFile = path.join(dir, 'c'); writeFileSync(pidFile, ''); writeFileSync(callsFile, '');
  const addStdio = await L.api('/api/mcps', { method: 'POST', body: { name: 'CrashyCli', transport: 'stdio', command: stdio.command, args: [stdio.scriptPath, pidFile, callsFile, '--api-key', '{{vault:API_KEY}}'], env: { MOCK_EXIT_EARLY: '1' } } });
  result('stdio.lastErrorStored', addStdio.json?.mcp?.lastError);

  const outsider = await L.createAgent({ name: 'Outsider', profile: 'all', canManage: false, secrets: [] });
  result('outsider.secrets', outsider.agent?.secrets);
  for (const [label, args] of [
    ['inspect.leaky', { type: 'connection', id: 'leaky' }],
    ['inspect.stdio', { type: 'connection', id: 'crashycli' }],
  ]) {
    const r = await L.callTool('loop__inspect', args, { token: outsider.token });
    const text = r.result?.content?.[0]?.text || JSON.stringify(r.json);
    result(label, { containsSecret: text.includes(SECRET), lastError: JSON.parse(text).lastError });
  }
  const s = await L.callTool('loop__search', { type: 'connections' }, { token: outsider.token });
  const stext = s.result?.content?.[0]?.text || '';
  result('search.connections', { containsSecret: stext.includes(SECRET), occurrences: stext.split(SECRET).length - 1 });
  // Same agent cannot read the secret through a tool call result (masking works there):
  const echo = await L.callTool('loop__run', { tool: 'up__pay', arguments: { amount: SECRET } }, { token: outsider.token });
  result('control.toolResultMasked', { containsSecret: (echo.result?.content?.[0]?.text || '').includes(SECRET), text: echo.result?.content?.[0]?.text?.slice(0, 80) });

  // (3) Unbounded lastError.
  const before = statSync(path.join(L.dataDir, 'config.json')).size;
  const addHuge = await L.api('/api/mcps', { method: 'POST', body: { name: 'Huge', transport: 'http', url: huge.url } });
  const after = statSync(path.join(L.dataDir, 'config.json')).size;
  result('huge.lastError', { lastErrorChars: addHuge.json?.mcp?.lastError?.length, configBytesBefore: before, configBytesAfter: after });
  const t0 = Date.now(); const list = await L.api('/api/mcps'); result('huge.apiMcpsResponseBytes', { bytes: list.text.length, ms: Date.now() - t0 });
  const sr = await L.callTool('loop__search', { type: 'connections' }, { token: outsider.token });
  result('huge.agentSearchBytes', (sr.result?.content?.[0]?.text || '').length);
} catch (e) { result('fatal', e.stack); }
await L.close(); await up.close(); await leaky.close(); await huge.close();
process.exit(0);
