import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from '../server.mjs';
import { validateUiSpec } from '../lib/json-render-ui.mjs';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop();
    try { await fn(); } catch { /* ignore */ }
  }
});

// Tiny stub upstream MCP HTTP server with one echo tool.
async function startStubMcp() {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(req.method === 'DELETE' ? 204 : 405);
      res.end();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) { res.writeHead(202); res.end(); return; }
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'stub', version: '1.0.0' },
        },
      }));
      return;
    }
    if (msg.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    if (msg.method === 'tools/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'send_note',
              description: 'Send a note',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
            },
          ],
        },
      }));
      return;
    }
    if (msg.method === 'tools/call') {
      calls.push(msg.params);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, echoed: msg.params?.arguments?.text || '' }) }] },
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  cleanups.push(() => new Promise((r) => srv.close(() => r())));
  return { url: `http://127.0.0.1:${port}/mcp`, calls };
}

function rawHttp(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Opens an SSE POST /mcp request and feeds every JSON-RPC `event: message` to onMessage.
function postMcpSse(baseUrl, { headers, body, onMessage }) {
  return new Promise((resolve, reject) => {
    const u = new URL('/mcp', baseUrl);
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      const ct = String(res.headers['content-type'] || '');
      if (!ct.includes('text/event-stream')) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, sse: false, json: text ? JSON.parse(text) : null, events: [] });
        });
        return;
      }
      const events = [];
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let match;
        while ((match = /\r?\n\r?\n/.exec(buf))) {
          const frame = buf.slice(0, match.index);
          buf = buf.slice(match.index + match[0].length);
          const dataLines = frame
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => (l.startsWith('data: ') ? l.slice(6) : l.slice(5)));
          if (!dataLines.length) continue;
          const msg = JSON.parse(dataLines.join('\n'));
          events.push(msg);
          Promise.resolve(onMessage?.(msg)).catch(reject);
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, sse: true, events, final: events.at(-1) || null }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function setupGateway({ smsBridgeSecret = 'test-bridge-secret' } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'loop-elicit-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const stub = await startStubMcp();
  const prevSecret = process.env.LOOP_TEXT_INTERNAL_SECRET;
  process.env.LOOP_TEXT_INTERNAL_SECRET = smsBridgeSecret;
  cleanups.push(() => {
    if (prevSecret === undefined) delete process.env.LOOP_TEXT_INTERNAL_SECRET;
    else process.env.LOOP_TEXT_INTERNAL_SECRET = prevSecret;
  });

  const app = await startServer({
    dataDir: dir,
    home: dir,
    port: 0,
    authMode: 'local-test',
    hosted: false,
    autoSync: false,
    detectLocalAgents: false,
    searchEnv: { LOOP_EMBEDDING_PROVIDER: 'off' },
    smsAgentEnv: { LOOP_TEXT_INTERNAL_SECRET: smsBridgeSecret },
  });
  const port = app.port;
  cleanups.push(() => app.close());
  const baseUrl = `http://127.0.0.1:${port}`;

  const setup = await rawHttp(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'only-for-local-regression' }),
  });
  assert.equal(setup.status, 200);
  const cookie = String([].concat(setup.headers['set-cookie'])[0] || '').split(';')[0];

  // Add stub connection and require approval on it.
  const added = await rawHttp(`${baseUrl}/api/mcps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Mailer', url: stub.url }),
  });
  assert.equal(added.status, 201);
  const connId = added.json.mcp.id;

  const synced = await rawHttp(`${baseUrl}/api/mcps/${connId}/sync`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(synced.status, 200);

  const pol = await rawHttp(`${baseUrl}/api/policies`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ connections: { [connId]: 'always_ask' } }),
  });
  assert.equal(pol.status, 200);

  const agentRes = await rawHttp(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Claude Code', profile: 'all', canManage: true }),
  });
  assert.equal(agentRes.status, 201);

  return { baseUrl, cookie, connId, stub, agent: agentRes.json.agent, token: agentRes.json.token, smsBridgeSecret };
}

async function initSession(baseUrl, token, { protocolVersion = '2025-11-25', capabilities = {}, clientInfo = { name: 'claude-code', version: '2.1.76' } } = {}) {
  const res = await rawHttp(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion, capabilities, clientInfo },
    }),
  });
  assert.equal(res.status, 200);
  const sessionId = res.headers['mcp-session-id'];
  assert.ok(sessionId);
  return { sessionId, result: res.json.result };
}

describe('Approval deep links & terminal MCP elicitation option selection', () => {
  it('returns deep approveUrl (#approvals?id=...) and exposes GET /api/approvals/:id + SMS bridge inspect', async () => {
    const { baseUrl, cookie, connId, token, smsBridgeSecret } = await setupGateway();
    const { sessionId } = await initSession(baseUrl, token, { capabilities: {} });

    const callRes = await rawHttp(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Mcp-Session-Id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'loop__run', arguments: { tool: `${connId}__send_note`, arguments: { text: 'hello' } } },
      }),
    });
    assert.equal(callRes.status, 200);
    const body = JSON.parse(callRes.json.result.content[0].text);
    assert.equal(body.status, 'approval_required');
    assert.match(body.approvalId, /^apr_/);
    assert.equal(body.approveUrl, `${baseUrl}/#approvals?id=${body.approvalId}`);
    assert.equal(body.target, `${connId}__send_note`);
    assert.match(body.title, /send_note/);

    // Owner dashboard GET /api/approvals/:id
    const ownerGet = await rawHttp(`${baseUrl}/api/approvals/${body.approvalId}`, { headers: { Cookie: cookie } });
    assert.equal(ownerGet.status, 200);
    assert.equal(ownerGet.json.approval.id, body.approvalId);
    assert.equal(ownerGet.json.approval.status, 'pending');
    assert.equal(validateUiSpec(ownerGet.json.approval.uiSpec).valid, true);

    // SMS bridge GET /api/sms-bridge/approvals/:id
    const bridgeGet = await rawHttp(`${baseUrl}/api/sms-bridge/approvals/${body.approvalId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Loop-Text-Secret': smsBridgeSecret,
      },
    });
    assert.equal(bridgeGet.status, 200);
    assert.equal(bridgeGet.json.approval.id, body.approvalId);
    assert.equal(bridgeGet.json.approval.target, `${connId}__send_note`);
  });

  it('prompts terminal client with 2025-11-25 form option selection and executes tool immediately on approve', async () => {
    const { baseUrl, connId, stub, token } = await setupGateway();
    const { sessionId, result } = await initSession(baseUrl, token, {
      protocolVersion: '2025-11-25',
      capabilities: { elicitation: { form: {} } },
    });
    assert.equal(result.protocolVersion, '2025-11-25');

    const elicitRequests = [];
    const sseRes = await postMcpSse(baseUrl, {
      headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sessionId },
      body: {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'loop__run', arguments: { tool: `${connId}__send_note`, arguments: { text: 'ship it' } } },
      },
      onMessage: async (msg) => {
        if (msg.method === 'elicitation/create') {
          elicitRequests.push(msg);
          const reply = await rawHttp(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
              'Mcp-Session-Id': sessionId,
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { action: 'accept', content: { decision: 'approve' } },
            }),
          });
          assert.equal(reply.status, 202);
        }
      },
    });

    assert.equal(sseRes.sse, true);
    assert.equal(elicitRequests.length, 1);
    const reqParams = elicitRequests[0].params;
    assert.equal(reqParams.mode, 'form');
    const oneOf = reqParams.requestedSchema.properties.decision.oneOf;
    assert.deepEqual(
      oneOf.map((o) => o.const),
      ['approve', 'approve_always_tool', 'deny'],
    );
    assert.equal(sseRes.final.id, 10);
    assert.equal(sseRes.final.result.isError, undefined);
    assert.match(sseRes.final.result.content[0].text, /ship it/);
    assert.equal(stub.calls.length, 1);
  });

  it('supports approve_always_tool option and stops prompting on subsequent calls', async () => {
    const { baseUrl, connId, stub, token } = await setupGateway();
    const { sessionId } = await initSession(baseUrl, token, {
      protocolVersion: '2025-11-25',
      capabilities: { elicitation: { form: {} } },
    });

    const first = await postMcpSse(baseUrl, {
      headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sessionId },
      body: {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: { name: 'loop__run', arguments: { tool: `${connId}__send_note`, arguments: { text: 'first' } } },
      },
      onMessage: async (msg) => {
        if (msg.method === 'elicitation/create') {
          await rawHttp(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
              'Mcp-Session-Id': sessionId,
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { action: 'accept', content: { decision: 'approve_always_tool' } },
            }),
          });
        }
      },
    });
    assert.match(first.final.result.content[0].text, /first/);

    // Second call runs immediately without elicitation or approval prompt.
    const second = await rawHttp(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Mcp-Session-Id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: 'loop__run', arguments: { tool: `${connId}__send_note`, arguments: { text: 'second' } } },
      }),
    });
    assert.equal(second.status, 200);
    assert.match(second.json.result.content[0].text, /second/);
    assert.equal(stub.calls.length, 2);
  });

  it('denies cleanly when terminal user selects deny or cancels, and blocks cross-session spoofing', async () => {
    const { baseUrl, connId, stub, token } = await setupGateway();
    const { sessionId } = await initSession(baseUrl, token, {
      protocolVersion: '2025-06-18',
      capabilities: { elicitation: {} },
    });
    const { sessionId: otherSession } = await initSession(baseUrl, token, {
      protocolVersion: '2025-06-18',
      capabilities: { elicitation: {} },
    });

    const sseRes = await postMcpSse(baseUrl, {
      headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sessionId },
      body: {
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: { name: 'loop__run', arguments: { tool: `${connId}__send_note`, arguments: { text: 'nope' } } },
      },
      onMessage: async (msg) => {
        if (msg.method === 'elicitation/create') {
          // 2025-06-18 schema uses enum + enumNames.
          assert.deepEqual(msg.params.requestedSchema.properties.decision.enum, ['approve', 'approve_always_tool', 'deny']);
          // Cross-session spoof attempt MUST be ignored!
          await rawHttp(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
              'Mcp-Session-Id': otherSession,
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { action: 'accept', content: { decision: 'approve' } },
            }),
          });
          // Now the real session declines/denies.
          await rawHttp(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
              'Mcp-Session-Id': sessionId,
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { action: 'accept', content: { decision: 'deny' } },
            }),
          });
        }
      },
    });

    const out = JSON.parse(sseRes.final.result.content[0].text);
    assert.equal(out.status, 'approval_denied');
    assert.equal(sseRes.final.result.isError, true);
    assert.equal(stub.calls.length, 0);
  });

  it('supports URL-mode elicitation and settles immediately when owner approves via HTTP', async () => {
    const { baseUrl, cookie, connId, stub, token } = await setupGateway();
    const { sessionId } = await initSession(baseUrl, token, {
      protocolVersion: '2025-11-25',
      capabilities: { elicitation: { url: {} } },
    });

    let elicitedUrl = null;
    const sseRes = await postMcpSse(baseUrl, {
      headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sessionId },
      body: {
        jsonrpc: '2.0',
        id: 40,
        method: 'tools/call',
        params: { name: 'loop__run', arguments: { tool: `${connId}__send_note`, arguments: { text: 'via-url' } } },
      },
      onMessage: async (msg) => {
        if (msg.method === 'elicitation/create') {
          assert.equal(msg.params.mode, 'url');
          elicitedUrl = msg.params.url;
          assert.match(elicitedUrl, /#approvals\?id=apr_/);
          await rawHttp(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
              'Mcp-Session-Id': sessionId,
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { action: 'accept' } }),
          });
          // Owner taps Yes on the opened URL -> POST /api/approvals/:id/approve
          const aprRes = await rawHttp(`${baseUrl}/api/approvals/${msg.params.elicitationId}/approve`, { method: 'POST', headers: { Cookie: cookie } });
          assert.equal(aprRes.status, 200);
        }
      },
    });

    assert.ok(elicitedUrl);
    assert.match(sseRes.final.result.content[0].text, /via-url/);
    assert.equal(stub.calls.length, 1);
  });

  it('relays interactive elicitation end-to-end through stdio.mjs', async () => {
    const { baseUrl, connId, stub, token } = await setupGateway();
    const child = spawn(process.execPath, [path.resolve('stdio.mjs'), `--url=${baseUrl}/mcp`], {
      env: { ...process.env, LOOP_HUB_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    cleanups.push(() => { try { child.kill(); } catch { /* ignore */ } });

    const lines = [];
    const waiters = [];
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (waiters.length) waiters.shift()(msg);
        else lines.push(msg);
      }
    });
    const nextMsg = () => (lines.length ? Promise.resolve(lines.shift()) : new Promise((r) => waiters.push(r)));
    const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: { elicitation: { form: {} } },
        clientInfo: { name: 'codex', version: '1.0' },
      },
    });
    const initReply = await nextMsg();
    assert.equal(initReply.id, 1);
    assert.equal(initReply.result.protocolVersion, '2025-11-25');

    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'loop__run', arguments: { tool: `${connId}__send_note`, arguments: { text: 'from-stdio' } } },
    });

    const elicitMsg = await nextMsg();
    assert.equal(elicitMsg.method, 'elicitation/create');
    assert.equal(elicitMsg.params.mode, 'form');

    // Terminal client sends back human's selection over stdin -> stdio.mjs relays to POST /mcp
    send({
      jsonrpc: '2.0',
      id: elicitMsg.id,
      result: { action: 'accept', content: { decision: 'approve' } },
    });

    const toolReply = await nextMsg();
    assert.equal(toolReply.id, 2);
    assert.match(toolReply.result.content[0].text, /from-stdio/);
    assert.equal(stub.calls.length, 1);

    child.stdin.end();
  });

  it('dynamically generates @json-render/core scope controls for agent invites and applies owner choices from terminal elicitation', async () => {
    const { baseUrl, cookie, token } = await setupGateway();

    // Create a real project so the dynamic approval UI includes it in the live scope picker.
    const projRes = await rawHttp(`${baseUrl}/api/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ id: 'work', name: 'Work' }),
    });
    assert.equal(projRes.status, 201);

    const { sessionId } = await initSession(baseUrl, token, {
      protocolVersion: '2025-11-25',
      capabilities: { elicitation: { form: {} } },
    });

    let seenSchema = null;
    const sseRes = await postMcpSse(baseUrl, {
      headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sessionId },
      body: {
        jsonrpc: '2.0',
        id: 55,
        method: 'tools/call',
        params: {
          name: 'loop__save',
          arguments: { type: 'agent', action: 'invite', data: { name: 'Codex', profile: 'all', canManage: true } },
        },
      },
      onMessage: async (msg) => {
        if (msg.method === 'elicitation/create') {
          seenSchema = msg.params.requestedSchema;
          // Owner narrows scope to "work", read_only memory, and turns off canManage right in the picker!
          const reply = await rawHttp(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
              'Mcp-Session-Id': sessionId,
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                action: 'accept',
                content: {
                  decision: 'approve',
                  profile: 'work',
                  memoryAccess: 'read',
                  canManage: false,
                },
              },
            }),
          });
          assert.equal(reply.status, 202);
        }
      },
    });

    assert.ok(seenSchema);
    assert.ok(seenSchema.properties.profile.oneOf.some((o) => o.const === 'work' && o.title === 'Work'));
    assert.equal(seenSchema.properties.canManage.type, 'boolean');
    const out = JSON.parse(sseRes.final.result.content[0].text);
    assert.equal(out.invited, true);
    assert.equal(out.project, 'work');
    assert.equal(out.canManage, false);
    assert.equal(out.memoryAccess, 'read');
  });

  it('supports POST /api/approvals/:id/decide with dynamic optionId + values and capability-based surface routing', async () => {
    const { baseUrl, cookie, connId, token } = await setupGateway();

    // Unknown client name declaring delegatedApprovals capability gets SMS-style link behavior without elicitation.
    const { sessionId } = await initSession(baseUrl, token, {
      protocolVersion: '2025-11-25',
      capabilities: {
        elicitation: { form: {} },
        experimental: { loop: { surface: 'sms', delegatedApprovals: true } },
      },
      clientInfo: { name: 'custom-mobile-client', version: '1.0' },
    });

    const paused = await postMcpSse(baseUrl, {
      headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sessionId },
      body: {
        jsonrpc: '2.0',
        id: 60,
        method: 'tools/call',
        params: { name: 'loop__run', arguments: { tool: `${connId}__send_note`, arguments: { text: 'cap-test' } } },
      },
    });
    assert.equal(paused.sse, false, 'delegatedApprovals skips terminal elicitation');
    const body = JSON.parse(paused.json.result.content[0].text);
    assert.equal(body.status, 'approval_required');

    // Settle via unified POST /api/approvals/:id/decide with optionId "approve_always_tool".
    const decided = await rawHttp(`${baseUrl}/api/approvals/${body.approvalId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ optionId: 'approve_always_tool' }),
    });
    assert.equal(decided.status, 200);
    assert.equal(decided.json.alwaysAllowed, true);
    assert.equal(decided.json.scope, 'tool');
  });
});
