import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { ActivityLog } from '../lib/activity.mjs';
import { PolicyStore } from '../lib/policies.mjs';
import { McpOAuthServer } from '../lib/mcp-oauth.mjs';
import { LoopStore } from '../lib/store.mjs';
import { Vault } from '../lib/vault.mjs';
import { ConnectionPool } from '../lib/mcp-client.mjs';
import { issueAgentToken } from '../lib/agents.mjs';

const bodyOf = async (req) => {
  let out = '';
  for await (const chunk of req) out += chunk;
  return out;
};

const listenJson = (handler) =>
  new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${srv.address().port}`,
        close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
      });
    });
  });

const sendJson = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

async function mcpPost(port, token, body) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

test('Phase 3: SQLite ActivityLog migrates legacy jsonl, assigns call_ IDs, supports exact lookup and filters', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-p3-act-'));
  try {
    await writeFile(
      path.join(dir, 'activity.jsonl'),
      JSON.stringify({ at: '2026-11-20T00:00:00.000Z', agentId: 'a1', agentName: 'Legacy', method: 'tools/call', target: 'gh__list', ok: true }) + '\n',
      'utf8',
    );
    const log = new ActivityLog(dir);
    const rec1 = await log.record({ agentId: 'a1', agentName: 'Claude', method: 'tools/call', target: 'stripe__charge', ok: false, outcome: 'blocked', error: 'policy_denied' });
    const rec2 = await log.record({ agentId: 'a1', agentName: 'Claude', method: 'secret/use', target: 'STRIPE_KEY → stripe__charge', ok: true });
    assert.match(rec1.callId, /^call_[0-9a-f]{14}$/);

    const exact = await log.listPage({ callId: rec1.callId, filter: 'vault' });
    assert.equal(exact.entries.length, 1);
    assert.equal(exact.entries[0].callId, rec1.callId);

    const stopped = await log.listPage({ filter: 'stopped' });
    assert.equal(stopped.entries.length, 1);
    assert.equal(stopped.entries[0].outcome, 'blocked');

    const vaultOnly = await log.listPage({ filter: 'vault' });
    assert.equal(vaultOnly.entries.length, 1);
    assert.equal(vaultOnly.entries[0].vaultKey, 'STRIPE_KEY');

    const all = await log.listPage({ limit: 10 });
    assert.equal(all.total, 3, 'includes migrated legacy jsonl row plus two new rows');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Phase 3: PolicyStore argRules evaluate numeric/list/dotted predicates and deny or escalate cleanly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-p3-pol-'));
  try {
    const policies = new PolicyStore(dir);
    await policies.update({
      argRules: [
        { id: 'cap_spend', tool: 'stripe__charge', path: 'amount', op: 'gt', value: 100, decision: 'always_ask', reason: 'Charges over $100 need approval' },
        { id: 'block_ext', tool: 'mail__send', path: 'recipient.email', op: 'not_in', value: ['team@acme.com'], decision: 'deny', reason: 'External recipients blocked' },
      ],
    });
    const small = await policies.evaluateRun({ conn: { id: 'stripe', name: 'Stripe' }, toolName: 'charge', args: { amount: 25 } });
    assert.equal(small.decision, 'auto');
    const large = await policies.evaluateRun({ conn: { id: 'stripe', name: 'Stripe' }, toolName: 'charge', args: { amount: 250 } });
    assert.equal(large.decision, 'always_ask');
    assert.equal(large.source, 'argRule:cap_spend');
    const denied = await policies.evaluateRun({ conn: { id: 'mail', name: 'Mail' }, toolName: 'send', args: { recipient: { email: 'evil@other.com' } } });
    assert.equal(denied.decision, 'deny');
    assert.equal(denied.source, 'argRule:block_ext');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Phase 3: Batch run supports parallel: true, $from chaining, pick projection, no duplicate output/structuredContent, structured errors with callId, and /mcp/whoami', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-p3-batch-'));
  let concurrentPeak = 0;
  let concurrentNow = 0;

  const upstream = await listenJson(async (req, res) => {
    const raw = await bodyOf(req);
    const msg = raw ? JSON.parse(raw) : {};
    if (req.method !== 'POST' || msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (msg.method === 'initialize') {
      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '1' } },
      });
    }
    if (msg.method === 'tools/list') {
      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            { name: 'slow_read', description: 'Slow read', inputSchema: { type: 'object', properties: { tag: { type: 'string' } } }, annotations: { readOnlyHint: true } },
            { name: 'get_user', description: 'Get user', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
            { name: 'greet_user', description: 'Greet user', inputSchema: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] }, annotations: { readOnlyHint: true } },
            { name: 'fail_write', description: 'Failing write', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
          ],
        },
      });
    }
    if (msg.method === 'tools/call') {
      const { name, arguments: a = {} } = msg.params;
      if (name === 'slow_read') {
        concurrentNow += 1;
        concurrentPeak = Math.max(concurrentPeak, concurrentNow);
        await new Promise((r) => setTimeout(r, 120));
        concurrentNow -= 1;
        const obj = { tag: a.tag, extra: 'drop-me', nested: { keep: 1 } };
        return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj } });
      }
      if (name === 'get_user') {
        return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ user: { id: 'usr_99', name: 'Grace' }, noisy: 'x' }) }] } });
      }
      if (name === 'greet_user') {
        return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ greeting: `Hi ${a.userId}` }) }] } });
      }
      if (name === 'fail_write') {
        return sendJson(res, 500, { error: 'upstream boom' });
      }
    }
    res.writeHead(404).end();
  });

  let srv;
  try {
    const store = new LoopStore(dir);
    const vault = new Vault(dir);
    const pool = new ConnectionPool(store, vault);
    const conn = await store.add({ name: 'Demo', transport: 'http', url: `${upstream.url}/mcp` });
    await pool.sync(conn.id);
    await pool.closeAll();

    const agent = await store.addAgent({ name: 'Builder', kind: 'claude-code', profile: 'all', enabled: true, canManage: true, secrets: [] });
    const { token } = await issueAgentToken(store, vault, agent.id);
    srv = await startServer({ port: 0, dataDir: dir, detectLocalAgents: false, authMode: 'local-test', schedulePollMs: 0 });

    // 1. Parallel batch + pick + F14 deduplication (structuredContent omitted when identical to output).
    const parRes = await mcpPost(srv.port, token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'loop__run',
        arguments: {
          parallel: true,
          calls: [
            { tool: `${conn.id}__slow_read`, arguments: { tag: 'a' }, pick: ['tag', 'nested.keep'] },
            { tool: `${conn.id}__slow_read`, arguments: { tag: 'b' }, pick: ['tag'] },
          ],
        },
      },
    });
    const parPayload = JSON.parse(parRes.result.content[0].text);
    assert.equal(parPayload.ok, 2);
    assert.ok(concurrentPeak >= 2, `parallel: true should execute concurrently (peak=${concurrentPeak})`);
    assert.deepEqual(parPayload.results[0].output, { tag: 'a', 'nested.keep': 1 });
    assert.equal(parPayload.results[0].structuredContent, undefined, 'duplicate structuredContent must be omitted');

    // 2. Chained $from output reference between sequential calls.
    const chainRes = await mcpPost(srv.port, token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'loop__run',
        arguments: {
          calls: [
            { tool: `${conn.id}__get_user`, arguments: {} },
            { tool: `${conn.id}__greet_user`, arguments: { userId: { $from: 'calls[0].output.user.id' } } },
          ],
        },
      },
    });
    const chainPayload = JSON.parse(chainRes.result.content[0].text);
    assert.equal(chainPayload.ok, 2);
    assert.deepEqual(chainPayload.results[1].output, { greeting: 'Hi usr_99' });

    // 3. Structured upstream error carries call_ reference matching ActivityLog + mayHaveWritten.
    const errRes = await mcpPost(srv.port, token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'loop__run', arguments: { tool: `${conn.id}__fail_write`, arguments: {} } },
    });
    assert.equal(errRes.result.isError, true);
    const errBody = JSON.parse(errRes.result.content[0].text);
    assert.match(errBody.reference, /^call_[0-9a-f]{14}$/);
    assert.equal(errBody.mayHaveWritten, true);
    assert.equal(errBody.retryable, false);
    assert.ok(errBody.recovery?.instructions);

    // 4. GET /mcp/whoami returns agent identity and reachable connections.
    const whoami = await fetch(`http://127.0.0.1:${srv.port}/mcp/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    assert.equal(whoami.authenticated, true);
    assert.equal(whoami.agent.id, agent.id);
    assert.ok(whoami.connections.some((c) => c.id === conn.id));
  } finally {
    await srv?.close().catch(() => {});
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Phase 3: MCP OAuth advertises refresh_token + device_code, rotates refresh tokens, and revokes family on replay', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-p3-oauth-'));
  try {
    const oauth = new McpOAuthServer(dir);
    const meta = oauth.authorizationServerMetadata('https://useloop.sh');
    assert.ok(meta.grant_types_supported.includes('refresh_token'));
    assert.ok(meta.grant_types_supported.includes('urn:ietf:params:oauth:grant-type:device_code'));
    assert.equal(meta.device_authorization_endpoint, 'https://useloop.sh/oauth/device/code');

    const first = oauth.issueRefreshToken({ clientId: 'c1', clientName: 'Codex', workspaceId: null, profile: 'all' });
    const rotated = oauth.exchangeRefreshToken({ refresh_token: first.refreshToken, client_id: 'c1' });
    assert.ok(rotated.refreshToken && rotated.refreshToken !== first.refreshToken);

    // Replay of the old rotated token must fail AND revoke the rotated token too!
    assert.throws(
      () => oauth.exchangeRefreshToken({ refresh_token: first.refreshToken, client_id: 'c1' }),
      /already used/i,
    );
    assert.throws(
      () => oauth.exchangeRefreshToken({ refresh_token: rotated.refreshToken, client_id: 'c1' }),
      /invalid or expired/i,
    );
    await oauth.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
