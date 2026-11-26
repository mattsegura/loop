import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runLoopCli } from '../scripts/loop-cli.mjs';
import { startServer } from '../server.mjs';

async function setupServer(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'loop-phase4-'));
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
    body: JSON.stringify({ password: 'phase4-password' }),
  });
  assert.equal(setupRes.status, 200);
  const cookie = (setupRes.headers.get('set-cookie') || '').split(';')[0];
  const agentRes = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Universal Client', kind: 'openbot' }),
  });
  assert.equal(agentRes.status, 201);
  const { token, agent } = await agentRes.json();
  return { dataDir, base, port: srv.port, cookie, token, agent, srv };
}

test('Phase 4: open CORS allows Bearer browser requests on /mcp while blocking cookies and dashboard CSRF', async (t) => {
  const { base, cookie, token } = await setupServer(t);

  // 1. OPTIONS preflight succeeds with Access-Control-Allow-Origin: * and never Access-Control-Allow-Credentials
  const preflight = await fetch(`${base}/mcp`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://openbot.example.com',
      'Sec-Fetch-Site': 'cross-site',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type, Authorization, Mcp-Session-Id, X-Loop-Actor',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /X-Loop-Actor/i);
  assert.match(preflight.headers.get('access-control-expose-headers') || '', /Mcp-Session-Id/i);

  // 2. Cross-origin POST /mcp with Bearer token (no cookie) works
  const mcpRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://openbot.example.com',
      'Sec-Fetch-Site': 'cross-site',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(mcpRes.status, 200);
  assert.equal(mcpRes.headers.get('access-control-allow-origin'), '*');
  assert.equal(mcpRes.headers.get('access-control-allow-credentials'), null);
  const mcpJson = await mcpRes.json();
  assert.ok(Array.isArray(mcpJson.result.tools) && mcpJson.result.tools.length > 0);

  // 3. Cross-origin POST /mcp WITH a Cookie header is still blocked (403)
  const withCookie = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://evil.example.com',
      'Sec-Fetch-Site': 'cross-site',
      Authorization: `Bearer ${token}`,
      Cookie: cookie,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  assert.equal(withCookie.status, 403);

  // 4. Cross-origin dashboard API remains strictly blocked (403)
  const dashCross = await fetch(`${base}/api/agents`, {
    headers: {
      Origin: 'https://evil.example.com',
      'Sec-Fetch-Site': 'cross-site',
      Cookie: cookie,
    },
  });
  assert.equal(dashCross.status, 403);
});

test('Phase 4: stateless session recovery heals stale Mcp-Session-Id while still rejecting closed or foreign sessions', async (t) => {
  const { base, cookie, token } = await setupServer(t);

  // 1. Unknown/stale session ID (e.g. after server restart) auto-recovers for an enabled Bearer agent
  const recovered = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Mcp-Session-Id': 'stale-session-from-before-restart',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(recovered.status, 200);
  const newSid = recovered.headers.get('mcp-session-id');
  assert.ok(newSid && newSid !== 'stale-session-from-before-restart');
  assert.equal(recovered.headers.get('x-loop-session-recovered'), '1');

  // 2. Explicitly closed (DELETE) session STILL returns 404
  const delRes = await fetch(`${base}/mcp`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': newSid },
  });
  assert.equal(delRes.status, 204);
  const afterClose = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Mcp-Session-Id': newSid,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  assert.equal(afterClose.status, 404);

  // 3. Another agent's active session STILL returns 404
  const init1 = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Bot1' } },
    }),
  });
  const bot1Sid = init1.headers.get('mcp-session-id');
  const otherAgentRes = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Other Bot' }),
  });
  const { token: otherToken } = await otherAgentRes.json();
  const hijack = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${otherToken}`,
      'Mcp-Session-Id': bot1Sid,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
  });
  assert.equal(hijack.status, 404);
});

test('Phase 4: legacy MCP 2024-11-05 HTTP+SSE transport (/sse + /messages) works end-to-end', async (t) => {
  const { base, port, token } = await setupServer(t);

  // Open SSE stream over raw http so we can read incremental events cleanly
  const events = [];
  let resolveEndpoint;
  const endpointReady = new Promise((r) => { resolveEndpoint = r; });
  let resolveMessage;
  const messageReady = new Promise((r) => { resolveMessage = r; });

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/sse',
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    },
    (res) => {
      assert.equal(res.statusCode, 200);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        while (buf.includes('\n\n')) {
          const idx = buf.indexOf('\n\n');
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (frame.startsWith(':')) continue;
          const evMatch = frame.match(/^event:\s*(.+)$/m);
          const dataMatch = frame.match(/^data:\s*(.+)$/m);
          if (evMatch && dataMatch) {
            const ev = { event: evMatch[1].trim(), data: dataMatch[1].trim() };
            events.push(ev);
            if (ev.event === 'endpoint') resolveEndpoint(ev.data);
            if (ev.event === 'message') resolveMessage(JSON.parse(ev.data));
          }
        }
      });
    },
  );
  req.end();
  t.after(() => req.destroy());

  const messageEndpoint = await endpointReady;
  assert.match(messageEndpoint, /^\/messages\?sessionId=sse_/);

  // Post a 2024-11-05 initialize request to /messages?sessionId=...
  const postRes = await fetch(`${base}${messageEndpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 42,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Legacy SSE Client' } },
    }),
  });
  assert.equal(postRes.status, 202);

  const initReply = await messageReady;
  assert.equal(initReply.id, 42);
  assert.equal(initReply.result.protocolVersion, '2024-11-05');
});

test('Phase 4: REST bridge (/api/v1/tools, /call, /openapi.json) and loop CLI tools/call work end-to-end', async (t) => {
  const { base, token } = await setupServer(t);

  // 1. GET /api/v1/tools
  const toolsRes = await fetch(`${base}/api/v1/tools`, {
    headers: { Authorization: `Bearer ${token}`, Origin: 'https://webui.example.com', 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(toolsRes.status, 200);
  assert.equal(toolsRes.headers.get('access-control-allow-origin'), '*');
  const toolsJson = await toolsRes.json();
  assert.ok(toolsJson.count > 0);
  assert.ok(toolsJson.tools.some((tool) => tool.name === 'loop__run'));

  // 2. POST /api/v1/tools/:name/call (runs direct tool through Loop policies)
  const callRes = await fetch(`${base}/api/v1/tools/loop_utils__calc/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ arguments: { expression: '21 * 2' } }),
  });
  assert.equal(callRes.status, 200);
  const callJson = await callRes.json();
  assert.equal(callJson.ok, true);
  assert.match(callJson.text, /42/);

  // 3. GET /api/v1/openapi.json returns valid OpenAPI 3.1 document
  const specRes = await fetch(`${base}/api/v1/openapi.json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(specRes.status, 200);
  const spec = await specRes.json();
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.paths['/api/v1/tools']);
  assert.ok(spec.components.securitySchemes.bearerAuth);

  // 4. loop tools & loop call CLI subcommands work cleanly
  const cliLines = [];
  const cliTools = await runLoopCli(['tools', '--url', base, '--token', token], {
    log: (line) => cliLines.push(line),
  });
  assert.ok(cliTools.count > 0);
  assert.ok(cliLines.some((line) => line.includes('loop__search')));

  const callLines = [];
  const cliCall = await runLoopCli(
    ['call', 'loop_utils__calc', '--json', '{"expression":"9 + 10"}', '--url', base, '--token', token],
    { log: (line) => callLines.push(line) },
  );
  assert.equal(cliCall.ok, true);
  assert.match(callLines.join('\n'), /19/);
});
