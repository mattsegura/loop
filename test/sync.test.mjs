// How Connections are kept in sync: a sync never disturbs calls that are running, a call that may
// have run is never sent twice, failing Connections back off, syncing follows use instead of a
// clock, and default pins never overwrite an owner's choice.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { startServer } from '../server.mjs';
import {
  ConnectionPool,
  MAX_LAST_ERROR_CHARS,
  MAX_TOOLS_PER_CONN,
  MAX_TOOL_DESCRIPTION_CHARS,
  SYNC_VERSION,
  buildStdioEnv,
  computeOAuthRefreshWindowMs,
  isUnauthorizedError,
  listAllPages,
  needsAutoSync,
  shouldFallbackToSse,
} from '../lib/mcp-client.mjs';
import { buildSelfIdentity } from '../lib/outbound-policy.mjs';
import { MASK } from '../lib/secret-refs.mjs';
import { LoopStore, effectivePinnedTools } from '../lib/store.mjs';
import { Vault } from '../lib/vault.mjs';
import { assertPersonalConnection } from '../lib/personal-upstreams.mjs';

const MINUTE = 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value || Date.now() > deadline) return value;
    await sleep(25);
  }
}

const tool = (name) => ({ name, description: `${name}.`, inputSchema: { type: 'object', properties: {} } });

// A remote MCP server whose behaviour each test sets through `state`.
async function startUpstream(t) {
  const state = {
    tools: [tool('place_order')],
    toolRuns: 0, // times the upstream actually ran a tool call
    callPosts: 0, // tools/call requests received, including refused ones
    initializes: 0,
    callDelayMs: 0,
    refuseNextCallWith: 0, // answer the next tools/call with this HTTP status, without running it
    failAfterRunWith: 0, // run the tool, then answer with this HTTP status
    advertiseSignIn: false, // publish OAuth Protected Resource Metadata (RFC 9728)
  };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/oauth-protected-resource/mcp' && state.advertiseSignIn) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ resource: `http://127.0.0.1:${server.address().port}/mcp`, authorization_servers: ['https://accounts.example.test/'] }));
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      return res.end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const send = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    };
    if (msg.method === 'initialize') {
      state.initializes += 1;
      return send({
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'sync-test-upstream', version: '1.0.0' },
      });
    }
    if (msg.method === 'notifications/initialized') {
      res.writeHead(202);
      return res.end();
    }
    if (msg.method === 'tools/list') return send({ tools: state.tools });
    if (msg.method === 'tools/call') {
      state.callPosts += 1;
      if (state.refuseNextCallWith) {
        const status = state.refuseNextCallWith;
        state.refuseNextCallWith = 0;
        res.writeHead(status);
        return res.end('session not found');
      }
      state.toolRuns += 1;
      const run = state.toolRuns;
      if (state.callDelayMs) await sleep(state.callDelayMs);
      if (state.failAfterRunWith) {
        res.writeHead(state.failAfterRunWith);
        return res.end('bad gateway');
      }
      return send({ content: [{ type: 'text', text: `run #${run}` }] });
    }
    return send({});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  return { state, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

async function poolWithStore(t) {
  const dir = await tempDir(t, 'loop-sync-');
  const store = new LoopStore(dir);
  const pool = new ConnectionPool(store, null);
  t.after(() => pool.closeAll());
  return { dir, store, pool };
}

// A local MCP server (newline-delimited JSON-RPC on stdin/stdout) that logs each start. Calling
// its `grow` tool adds a second tool and announces that the tool list changed.
async function writeLocalServer(dir) {
  const script = path.join(dir, 'local-mcp.mjs');
  await writeFile(script, `
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
appendFileSync(process.env.SPAWN_LOG, process.pid + '\\n');
const tool = (name) => ({ name, description: name + '.', inputSchema: { type: 'object', properties: {} } });
let tools = [tool('ping'), tool('grow')];
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    return write({ id: msg.id, result: {
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'local-test', version: '1.0.0' },
    } });
  }
  if (msg.method === 'tools/list') return write({ id: msg.id, result: { tools } });
  if (msg.method === 'tools/call') {
    if (msg.params.name === 'grow') {
      tools = [...tools, tool('extra')];
      write({ method: 'notifications/tools/list_changed' });
    }
    return write({ id: msg.id, result: { content: [{ type: 'text', text: 'pong' }] } });
  }
  return write({ id: msg.id, result: {} });
});
`, 'utf8');
  return script;
}

const isRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a sync that lands while a tool call is running does not run the call twice', async (t) => {
  const upstream = await startUpstream(t);
  const { store, pool } = await poolWithStore(t);
  const conn = await store.add({ name: 'Orders', transport: 'http', url: upstream.url });
  await pool.sync(conn.id);
  const connectsBefore = upstream.state.initializes;

  upstream.state.callDelayMs = 300;
  const call = pool.callTool(conn.id, 'place_order', {});
  await sleep(80);
  const synced = await pool.sync(conn.id); // a sweep, a stale refresh or a tool-list-changed event
  const result = await call;

  assert.equal(result.content[0].text, 'run #1');
  assert.equal(upstream.state.toolRuns, 1, 'the upstream ran the call once');
  assert.equal(synced.lastError, null);
  assert.equal(upstream.state.initializes, connectsBefore, 'the sync reused the open session');
});

test('a tool call that may have run is never sent again; one the server refused is sent once more', async (t) => {
  const upstream = await startUpstream(t);
  const { store, pool } = await poolWithStore(t);
  const conn = await store.add({ name: 'Orders', transport: 'http', url: upstream.url });
  await pool.sync(conn.id);

  // The upstream ran the tool and then answered 502: Loop cannot know, so it must not repeat it.
  upstream.state.failAfterRunWith = 502;
  await assert.rejects(pool.callTool(conn.id, 'place_order', {}), (err) => {
    assert.match(err.message, /bad gateway/);
    assert.match(err.message, /did not send it again because the call may already have run/);
    return true;
  });
  assert.equal(upstream.state.toolRuns, 1);
  assert.equal(upstream.state.callPosts, 1);

  // The server refused the request outright (an expired session): nothing ran, so reconnect and resend.
  upstream.state.failAfterRunWith = 0;
  upstream.state.refuseNextCallWith = 404;
  const result = await pool.callTool(conn.id, 'place_order', {});
  assert.equal(result.content[0].text, 'run #2');
  assert.equal(upstream.state.toolRuns, 2, 'the refused request never ran, the resend ran once');
  assert.equal(upstream.state.callPosts, 3);
});

test('needsAutoSync leaves a failing Connection alone for longer after each failure', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  const healthy = { enabled: true, syncVersion: 99, lastSyncAt: ago(10 * MINUTE), lastSyncAttemptAt: ago(10 * MINUTE), syncFailures: 0, lastError: null };
  assert.equal(needsAutoSync(healthy, now), false);
  assert.equal(needsAutoSync({ ...healthy, lastSyncAt: ago(7 * 60 * MINUTE) }, now), true, 'stale after six hours');

  const failing = (failures, attemptAgo) => ({
    ...healthy, lastSyncAt: null, lastError: 'offline', syncFailures: failures, lastSyncAttemptAt: ago(attemptAgo),
  });
  assert.equal(needsAutoSync(failing(1, 29 * MINUTE), now), false);
  assert.equal(needsAutoSync(failing(1, 31 * MINUTE), now), true);
  assert.equal(needsAutoSync(failing(2, 31 * MINUTE), now), false);
  assert.equal(needsAutoSync(failing(2, 61 * MINUTE), now), true);
  assert.equal(needsAutoSync(failing(3, 119 * MINUTE), now), false);
  assert.equal(needsAutoSync(failing(3, 121 * MINUTE), now), true);
  assert.equal(needsAutoSync(failing(40, 359 * MINUTE), now), false, 'the wait is capped at six hours');
  assert.equal(needsAutoSync(failing(40, 361 * MINUTE), now), true);

  // A failure outside the sweep (an edit, say) is retried on the same schedule, however recent the last success.
  assert.equal(needsAutoSync({ ...healthy, lastError: 'offline', syncFailures: 1, lastSyncAttemptAt: ago(31 * MINUTE) }, now), true);
  // An error saved before attempts were tracked has no attempt time and is due straight away.
  assert.equal(needsAutoSync({ ...healthy, lastError: 'offline', syncFailures: 0, lastSyncAttemptAt: null }, now), true);
  assert.equal(needsAutoSync({ ...failing(1, 31 * MINUTE), authRequired: true }, now), false);
  assert.equal(needsAutoSync({ ...failing(1, 31 * MINUTE), enabled: false }, now), false);
});

test('failed syncs are counted and not retried by the sweep until the wait is over; a success resets the count', async (t) => {
  const upstream = await startUpstream(t);
  const { store, pool } = await poolWithStore(t);
  const closed = net.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const deadUrl = `http://127.0.0.1:${closed.address().port}/mcp`;
  await new Promise((resolve) => closed.close(resolve));

  const conn = await store.add({ name: 'Flaky', transport: 'http', url: deadUrl });
  const first = await pool.sync(conn.id);
  assert.ok(first.lastError);
  assert.equal(first.syncFailures, 1);
  assert.ok(first.lastSyncAttemptAt);
  assert.equal(first.lastSyncAt, null);
  assert.deepEqual(await pool.syncStale(), { total: 0, synced: 0, failed: 0 }, 'not due again yet');

  const second = await pool.sync(conn.id);
  assert.equal(second.syncFailures, 2);
  const later = Date.parse(second.lastSyncAttemptAt);
  assert.equal(needsAutoSync(second, later + 31 * MINUTE), false);
  assert.equal(needsAutoSync(second, later + 61 * MINUTE), true);

  await store.update(conn.id, { url: upstream.url });
  const recovered = await pool.sync(conn.id);
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.syncFailures, 0);
  assert.equal(recovered.tools.length, 1);
});

test('a tool call that works on a Connection marked failed re-syncs it and clears the error', async (t) => {
  const upstream = await startUpstream(t);
  const { store, pool } = await poolWithStore(t);
  const conn = await store.add({ name: 'Orders', transport: 'http', url: upstream.url });
  await pool.sync(conn.id);
  await store.update(conn.id, {
    lastError: 'fetch failed',
    syncFailures: 3,
    lastSyncAttemptAt: new Date(Date.now() - 2 * MINUTE).toISOString(),
  });

  await pool.callTool(conn.id, 'place_order', {});
  await Promise.allSettled([...pool.bgSyncs.values()]);

  const after = await store.get(conn.id);
  assert.equal(after.lastError, null);
  assert.equal(after.syncFailures, 0);
});

test('a sync stops a local process it had to start, and leaves a running one alone', async (t) => {
  const { dir, store, pool } = await poolWithStore(t);
  const spawnLog = path.join(dir, 'spawns.log');
  const script = await writeLocalServer(dir);
  const spawns = async () => (await readFile(spawnLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number);
  const conn = await store.add({
    name: 'Local',
    transport: 'stdio',
    command: process.execPath,
    args: [script],
    env: { SPAWN_LOG: spawnLog },
  });

  // Nothing was running: the sync starts the process, reads the tools and stops it again.
  const synced = await pool.sync(conn.id);
  assert.equal(synced.lastError, null);
  assert.deepEqual(synced.tools.map((x) => x.name), ['ping', 'grow']);
  assert.equal(pool.sessions.has(conn.id), false);
  const [firstPid] = await spawns();
  assert.equal(await until(() => !isRunning(firstPid)), true, 'the process the sync started has stopped');

  // A call starts the process; a later sync reuses it and leaves it running.
  await pool.callTool(conn.id, 'ping', {});
  const live = pool.sessions.get(conn.id);
  assert.ok(live);
  await pool.sync(conn.id);
  assert.equal(pool.sessions.get(conn.id), live);
  assert.equal((await spawns()).length, 2);

  // "My tool list changed" re-reads the list on the same process instead of restarting it.
  await pool.callTool(conn.id, 'grow', {});
  const grown = await until(async () => {
    const current = await store.get(conn.id);
    return current.tools.length === 3 ? current : null;
  });
  assert.deepEqual(grown?.tools.map((x) => x.name), ['ping', 'grow', 'extra']);
  await Promise.allSettled([...pool.inFlightSyncs.values()]);
  const pids = await spawns();
  assert.equal(pids.length, 2, 'the process was not restarted');
  assert.equal(pool.sessions.get(conn.id), live);
  assert.equal(isRunning(pids[1]), true);
});

test('default pins are worked out when read and never overwrite a choice, even across a sync version bump', async (t) => {
  const upstream = await startUpstream(t);
  upstream.state.tools = [tool('catalog_search'), tool('fetch_news')];
  const { dir, store, pool } = await poolWithStore(t);
  const conn = await store.add({ name: 'Catalog', transport: 'http', url: upstream.url });
  assert.deepEqual(effectivePinnedTools(conn), [], 'no tools yet, so no default pin');

  const synced = await pool.sync(conn.id);
  assert.deepEqual(effectivePinnedTools(synced), ['catalog_search']);
  assert.deepEqual(synced.pinnedTools, [], 'the default is not saved as if the owner chose it');
  assert.equal(synced.pinsCustomized, false);

  // Pinning another tool keeps the default one.
  const added = await store.pinTool(conn.id, 'fetch_news', true);
  assert.deepEqual([...effectivePinnedTools(added)].sort(), ['catalog_search', 'fetch_news']);

  // Unpinning everything is a choice, and it survives re-syncs from an older sync version.
  await store.pinTool(conn.id, 'fetch_news', false);
  const cleared = await store.pinTool(conn.id, 'catalog_search', false);
  assert.deepEqual(effectivePinnedTools(cleared), []);
  await store.update(conn.id, { syncVersion: 0 });
  const resynced = await pool.sync(conn.id);
  assert.ok(resynced.syncVersion > 0);
  assert.deepEqual(effectivePinnedTools(resynced), []);

  // Setting an empty list through an edit is a choice too.
  const other = await store.add({ name: 'Other', transport: 'http', url: upstream.url, tools: upstream.state.tools });
  assert.deepEqual(effectivePinnedTools(other), ['catalog_search']);
  assert.deepEqual(effectivePinnedTools(await store.update(other.id, { pinnedTools: [] })), []);

  // Connections saved before choices were tracked: a non-empty list is kept as the choice it was.
  const file = path.join(dir, 'config.json');
  const config = JSON.parse(await readFile(file, 'utf8'));
  for (const mcp of config.mcps) delete mcp.pinsCustomized;
  config.mcps.find((mcp) => mcp.id === other.id).pinnedTools = ['fetch_news'];
  await writeFile(file, JSON.stringify(config), 'utf8');
  const legacy = await store.get(other.id);
  assert.equal(legacy.pinsCustomized, true);
  assert.deepEqual(effectivePinnedTools(legacy), ['fetch_news']);
});

test('a Connection as the store saves it is still accepted by the personal workspace check', async (t) => {
  const dir = await tempDir(t, 'loop-sync-');
  const store = new LoopStore(dir);
  const conn = await store.add({ name: 'Linear', transport: 'http', url: 'https://mcp.linear.app/mcp' });
  const saved = await store.update(conn.id, {
    lastSyncAttemptAt: new Date().toISOString(),
    syncFailures: 2,
    lastError: 'offline',
    pinnedTools: [],
  });
  assert.doesNotThrow(() => assertPersonalConnection(saved));
});

test('Connections are re-synced when the workspace is used, not on a clock', async (t) => {
  const upstream = await startUpstream(t);
  const dir = await tempDir(t, 'loop-sweep-');
  const disk = new LoopStore(dir);
  const first = await disk.add({ name: 'First', transport: 'http', url: upstream.url });

  const srv = await startServer({
    authMode: 'local-test',
    port: 0,
    dataDir: dir,
    autoSync: true,
    autoSyncDelayMs: 10,
    autoSyncIntervalMs: 1000,
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-owner-password' }),
  });
  const cookie = setup.headers.get('set-cookie').split(';')[0];

  // The one sweep after the workspace loads still happens with nobody using it.
  assert.ok(await until(async () => (await disk.get(first.id)).lastSyncAt), 'synced shortly after start');

  // A Connection that becomes due later is left alone while the workspace is idle, however long that is.
  const second = await disk.add({ name: 'Second', transport: 'http', url: upstream.url });
  await sleep(1300);
  assert.equal((await disk.get(second.id)).lastSyncAt, null, 'no sync ran on a timer');

  // The next signed-in request sweeps it.
  const list = await fetch(`${base}/api/mcps`, { headers: { Cookie: cookie } });
  assert.equal(list.status, 200);
  assert.ok(await until(async () => (await disk.get(second.id)).lastSyncAt), 'synced once the workspace was used');
});

test('asking for a fresh connection (the Sync button, an edit) lets a running call finish', async (t) => {
  const upstream = await startUpstream(t);
  const { store, pool } = await poolWithStore(t);
  const conn = await store.add({ name: 'Orders', transport: 'http', url: upstream.url });
  await pool.sync(conn.id);
  const connectsBefore = upstream.state.initializes;

  upstream.state.callDelayMs = 300;
  const call = pool.callTool(conn.id, 'place_order', {});
  await sleep(80);
  await pool.retire(conn.id);
  const synced = await pool.sync(conn.id);
  assert.equal(synced.lastError, null);
  assert.equal(upstream.state.initializes, connectsBefore + 1, 'the sync used a new session');

  const result = await call;
  assert.equal(result.content[0].text, 'run #1', 'the call finished on the old session');
  assert.equal(upstream.state.toolRuns, 1);
  assert.equal(pool.draining.size, 0, 'the old session closed once its call finished');
});

test('a signed-in workspace nobody is using is dropped from memory and loads again on the next request', async (t) => {
  const dir = await tempDir(t, 'loop-idle-');
  const frontendApi = 'https://loop-test.clerk.accounts.dev';
  const clerkApp = {
    publishableKey: 'fixture',
    frontendApi,
    async verifyRequest(req) {
      const userId = req.headers['x-fixture-auth'];
      if (userId !== 'user_A' && userId !== 'user_B') return null;
      return { userId, sessionId: `sess_${userId}`, issuer: frontendApi, expiresAt: Date.now() + 60000 };
    },
  };
  const srv = await startServer({ port: 0, dataDir: dir, detectLocalAgents: false, clerkApp, workspaceIdleMs: 200 });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const touch = async (user) => {
    const res = await fetch(`${base}/api/auth/status`, { headers: { 'X-Fixture-Auth': user } });
    return res.json();
  };
  // Each loaded workspace greets its dashboard with its own id, so a new id means it was loaded again.
  const openDashboard = async (user) => {
    const controller = new AbortController();
    const res = await fetch(`${base}/events`, { headers: { 'X-Fixture-Auth': user }, signal: controller.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    let text = '';
    while (!/data: \w+\n/.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf8');
    }
    return {
      loadedId: /event: hello\ndata: (\w+)/.exec(text)?.[1],
      close: async () => {
        controller.abort();
        await reader.cancel().catch(() => {});
      },
    };
  };

  // The first user on this Mac takes the Mac workspace, which always stays; user_B gets their own.
  assert.equal((await touch('user_A')).workspace, 'local');
  assert.equal((await touch('user_B')).workspace, 'personal');

  // In use (a dashboard is open): kept, however long other people's requests keep arriving.
  const first = await openDashboard('user_B');
  assert.ok(first.loadedId);
  await sleep(450);
  await touch('user_A');
  const second = await openDashboard('user_B');
  assert.equal(second.loadedId, first.loadedId, 'still the same loaded workspace');
  await first.close();
  await second.close();

  // Unused for longer than the limit: dropped at the next request, loaded again when its owner returns.
  await sleep(450);
  await touch('user_A');
  const third = await openDashboard('user_B');
  assert.ok(third.loadedId);
  assert.notEqual(third.loadedId, first.loadedId, 'the workspace was dropped and loaded again');
  assert.equal((await touch('user_B')).workspace, 'personal');
  await third.close();
});

test('SYNC_VERSION is 3 and sync preserves allowlisted tool annotations while stripping unknown keys and redacting catalog secrets', async (t) => {
  assert.equal(SYNC_VERSION, 3);
  const now = Date.parse('2026-11-20T12:00:00Z');
  const recent = new Date(now - 5 * MINUTE).toISOString();
  assert.equal(
    needsAutoSync({ enabled: true, syncVersion: 2, lastSyncAt: recent, lastSyncAttemptAt: recent, syncFailures: 0, lastError: null }, now),
    true,
    'connections synced under version 2 are due for automatic re-sync',
  );
  assert.equal(
    needsAutoSync({ enabled: true, syncVersion: 3, lastSyncAt: recent, lastSyncAttemptAt: recent, syncFailures: 0, lastError: null }, now),
    false,
  );

  const HEADER_SECRET = 'catalog-header-secret-XYZ987654';
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      return res.end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const send = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    };
    const apiKey = req.headers['x-api-key'] || '';
    if (msg.method === 'initialize') {
      return send({
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        instructions: `Authenticated with ${apiKey}`,
        serverInfo: { name: 'annotated-upstream', version: '1.0.0', description: `Desc echoing ${apiKey}` },
      });
    }
    if (msg.method === 'notifications/initialized') {
      res.writeHead(202);
      return res.end();
    }
    if (msg.method === 'tools/list') {
      return send({
        tools: [
          {
            name: 'read_item',
            description: `Reads an item using ${apiKey}`,
            inputSchema: { type: 'object', properties: {} },
            annotations: {
              title: `Read (${apiKey})`,
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
              unknownExtra: 'must-be-stripped',
              evilNested: { bad: true },
            },
          },
          {
            name: 'plain_tool',
            description: 'No valid annotations.',
            inputSchema: { type: 'object', properties: {} },
            annotations: {
              title: '   ',
              unknownOnly: true,
            },
          },
        ],
      });
    }
    return send({});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));

  const dir = await tempDir(t, 'loop-sync-v3-');
  const store = new LoopStore(dir);
  const vault = new Vault(dir);
  await vault.set('CATALOG_KEY', HEADER_SECRET);
  const pool = new ConnectionPool(store, vault);
  t.after(() => pool.closeAll());

  const conn = await store.add({
    name: 'Annotated',
    transport: 'http',
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    headers: { 'X-Api-Key': '{{vault:CATALOG_KEY}}' },
  });

  const synced = await pool.sync(conn.id);
  assert.equal(synced.lastError, null);
  assert.equal(synced.syncVersion, 3);
  assert.equal(synced.tools.length, 2);

  const [readTool, plainTool] = synced.tools;
  assert.deepEqual(readTool.annotations, {
    title: `Read (${MASK})`,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.equal('unknownExtra' in readTool.annotations, false);
  assert.equal('evilNested' in readTool.annotations, false);
  assert.equal('annotations' in plainTool, false, 'empty/invalid annotations are omitted');

  assert.equal(synced.serverInstructions, `Authenticated with ${MASK}`);
  assert.equal(synced.description, `Desc echoing ${MASK}`);
  assert.equal(readTool.description, `Reads an item using ${MASK}`);

  const diskConfig = await readFile(path.join(dir, 'config.json'), 'utf8');
  assert.equal(diskConfig.includes(HEADER_SECRET), false, 'secret never persisted in config.json');
});

test('pool redacts secrets in lastError (HTTP 403 echo & stdio stderr crash), OAuth tokens, encoded variants, and structuredContent keys', async (t) => {
  const CONN_SECRET = 'conn-header-secret-ABCDEF123';
  const STDIO_SECRET = 'stdio-env-secret-QWERTY9876';
  const OAUTH_ACCESS = 'ya29.oauth-access-token-SECRET-000111222';
  const QUOTE_SECRET = 'pa"ss\\word-9911-quoted';
  const SLASH_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY+abc=';
  const KEYED_SECRET = 'sk-live-keyed-secret-123456';

  // 1. HTTP 403 upstream echoing X-Api-Key in body
  const forbiddenSrv = http.createServer((req, res) => {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end(`Forbidden: API key ${req.headers['x-api-key']} is invalid`);
  });
  await new Promise((resolve) => forbiddenSrv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    forbiddenSrv.closeAllConnections?.();
    forbiddenSrv.close(resolve);
  }));

  // 2. OAuth + encoding + structuredContent upstream
  let failReadAndPrompt = false;
  const reflectSrv = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      return res.end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const send = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    };
    const authHeader = req.headers.authorization || '';
    if (msg.method === 'initialize') {
      return send({
        protocolVersion: '2025-03-26',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'reflect-upstream', version: '1.0.0' },
      });
    }
    if (msg.method === 'notifications/initialized') {
      res.writeHead(202);
      return res.end();
    }
    if (msg.method === 'tools/list') {
      return send({ tools: [tool('reflect')] });
    }
    if (msg.method === 'tools/call') {
      const args = msg.params?.arguments || {};
      return send({
        content: [
          { type: 'text', text: `auth=${authHeader}` },
          { type: 'text', text: `json=${JSON.stringify({ q: args.q })}` },
          { type: 'text', text: `url=https://api.example.test/?k=${encodeURIComponent(String(args.u || ''))}` },
        ],
        structuredContent: {
          [String(args.k || 'empty')]: { echoedAuth: authHeader },
        },
      });
    }
    if (msg.method === 'resources/read') {
      if (failReadAndPrompt) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: `resource denied for ${authHeader}` },
        }));
      }
      return send({ contents: [{ uri: msg.params.uri, text: `resource auth=${authHeader}` }] });
    }
    if (msg.method === 'prompts/get') {
      if (failReadAndPrompt) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: `prompt denied for ${authHeader}` },
        }));
      }
      return send({
        messages: [{ role: 'user', content: { type: 'text', text: `prompt auth=${authHeader}` } }],
      });
    }
    return send({});
  });
  await new Promise((resolve) => reflectSrv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    reflectSrv.closeAllConnections?.();
    reflectSrv.close(resolve);
  }));

  const dir = await tempDir(t, 'loop-redaction-');
  const store = new LoopStore(dir);
  const vault = new Vault(dir);
  await vault.set('CONN_KEY', CONN_SECRET);
  await vault.set('STDIO_KEY', STDIO_SECRET);
  await vault.set('__oauth_access_oauthy', OAUTH_ACCESS);

  const pool = new ConnectionPool(store, vault);
  t.after(() => pool.closeAll());

  // A. HTTP 403 error redaction in sync lastError + callTool error
  const badHttp = await store.add({
    name: 'BadHttp',
    transport: 'http',
    url: `http://127.0.0.1:${forbiddenSrv.address().port}/mcp`,
    headers: { 'X-Api-Key': '{{vault:CONN_KEY}}' },
  });
  const badHttpSynced = await pool.sync(badHttp.id);
  assert.ok(badHttpSynced.lastError);
  assert.equal(badHttpSynced.lastError.includes(CONN_SECRET), false, 'HTTP 403 lastError masks secret');
  assert.equal(badHttpSynced.lastError.includes(MASK), true);
  await assert.rejects(pool.callTool(badHttp.id, 'any', {}), (err) => {
    assert.equal(err.message.includes(CONN_SECRET), false);
    assert.equal(err.message.includes(MASK), true);
    return true;
  });

  // B. Stdio stderr crash redaction in sync lastError
  const crashScript = path.join(dir, 'crash-stdio.mjs');
  await writeFile(
    crashScript,
    `process.stderr.write('FATAL: invalid API key ' + process.env.API_KEY + '\\n'); process.exit(1);\n`,
    'utf8',
  );
  const badStdio = await store.add({
    name: 'Crashy',
    transport: 'stdio',
    command: process.execPath,
    args: [crashScript],
    env: { API_KEY: '{{vault:STDIO_KEY}}' },
  });
  const badStdioSynced = await pool.sync(badStdio.id);
  assert.ok(badStdioSynced.lastError);
  assert.equal(badStdioSynced.lastError.includes(STDIO_SECRET), false, 'stdio stderr lastError masks secret');
  assert.equal(badStdioSynced.lastError.includes(MASK), true);

  const configText = await readFile(path.join(dir, 'config.json'), 'utf8');
  assert.equal(configText.includes(CONN_SECRET), false, 'CONN_SECRET never stored on disk');
  assert.equal(configText.includes(STDIO_SECRET), false, 'STDIO_SECRET never stored on disk');

  // C. OAuth access token + JSON-escaped + URL-encoded + structuredContent keys across callTool/readResource/getPrompt
  const oauthConn = await store.add({
    name: 'Oauthy',
    transport: 'http',
    url: `http://127.0.0.1:${reflectSrv.address().port}/mcp`,
  });
  await store.update(oauthConn.id, {
    oauth: {
      accessTokenVaultKey: '__oauth_access_oauthy',
      expiresAt: Date.now() + 60 * MINUTE,
    },
  });

  const toolRes = await pool.callTool(
    oauthConn.id,
    'reflect',
    { q: QUOTE_SECRET, u: SLASH_SECRET, k: KEYED_SECRET },
    { extraSecrets: [QUOTE_SECRET, SLASH_SECRET, KEYED_SECRET] },
  );
  const serializedToolRes = JSON.stringify(toolRes);
  assert.equal(serializedToolRes.includes(OAUTH_ACCESS), false, 'OAuth access token redacted in callTool');
  assert.equal(serializedToolRes.includes(QUOTE_SECRET), false, 'raw quote secret redacted');
  assert.equal(serializedToolRes.includes(JSON.stringify(QUOTE_SECRET).slice(1, -1)), false, 'JSON-escaped secret redacted');
  assert.equal(serializedToolRes.includes(SLASH_SECRET), false, 'raw slash secret redacted');
  assert.equal(serializedToolRes.includes(encodeURIComponent(SLASH_SECRET)), false, 'URL-encoded secret redacted');
  assert.equal(serializedToolRes.includes(KEYED_SECRET), false, 'structuredContent key secret redacted');
  assert.equal(Object.keys(toolRes.structuredContent).includes(MASK), true);
  assert.equal(toolRes.structuredContent[MASK].echoedAuth, `Bearer ${MASK}`);

  const readRes = await pool.readResource(oauthConn.id, 'file:///doc');
  assert.equal(JSON.stringify(readRes).includes(OAUTH_ACCESS), false, 'OAuth access token redacted in readResource');
  assert.equal(readRes.contents[0].text, `resource auth=Bearer ${MASK}`);

  const promptRes = await pool.getPrompt(oauthConn.id, 'greet', {});
  assert.equal(JSON.stringify(promptRes).includes(OAUTH_ACCESS), false, 'OAuth access token redacted in getPrompt');
  assert.equal(promptRes.messages[0].content.text, `prompt auth=Bearer ${MASK}`);

  // Error paths on readResource and getPrompt must also redact OAuth token
  failReadAndPrompt = true;
  await assert.rejects(pool.readResource(oauthConn.id, 'file:///doc'), (err) => {
    assert.equal(err.message.includes(OAUTH_ACCESS), false, 'readResource error redacts OAuth token');
    assert.equal(err.message.includes(MASK), true);
    return true;
  });
  await assert.rejects(pool.getPrompt(oauthConn.id, 'greet', {}), (err) => {
    assert.equal(err.message.includes(OAUTH_ACCESS), false, 'getPrompt error redacts OAuth token');
    assert.equal(err.message.includes(MASK), true);
    return true;
  });
});

test('URL Vault placeholder resolution (?api_key={{vault:K}}) enforces origin immutability and self-URL policy', async (t) => {
  const URL_KEY = 'url-query-secret-TOKEN-554433';
  const seenUrls = [];
  const server = http.createServer(async (req, res) => {
    seenUrls.push(req.url);
    if (req.method !== 'POST') {
      res.writeHead(405);
      return res.end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const send = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    };
    if (msg.method === 'initialize') {
      return send({
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'url-vault-upstream', version: '1.0.0' },
      });
    }
    if (msg.method === 'notifications/initialized') {
      res.writeHead(202);
      return res.end();
    }
    if (msg.method === 'tools/list') return send({ tools: [tool('echo_url')] });
    if (msg.method === 'tools/call') {
      return send({ content: [{ type: 'text', text: `requested ${req.url}` }] });
    }
    return send({});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  const port = server.address().port;

  const dir = await tempDir(t, 'loop-url-vault-');
  const store = new LoopStore(dir);
  const vault = new Vault(dir);
  await vault.set('URL_KEY', URL_KEY);
  await vault.set('HOST_PART', '127.0.0.1');
  await vault.set('PORT_PART', String(port));
  await vault.set('SCHEME_PART', 'http');
  await vault.set('EVIL_USER', 'user@attacker.test/');

  const pool = new ConnectionPool(store, vault, {
    selfIdentity: buildSelfIdentity({ port: 8799 }),
  });
  t.after(() => pool.closeAll());

  // 1. Valid query placeholder resolves on wire and redacts echoed key
  const conn = await store.add({
    name: 'QueryKey',
    transport: 'http',
    url: `http://127.0.0.1:${port}/mcp?api_key={{vault:URL_KEY}}`,
  });
  const synced = await pool.sync(conn.id);
  assert.equal(synced.lastError, null);
  const res = await pool.callTool(conn.id, 'echo_url', {});
  assert.equal(seenUrls.some((u) => u === `/mcp?api_key=${URL_KEY}`), true, 'upstream received resolved URL key');
  assert.equal(res.content[0].text, `requested /mcp?api_key=${MASK}`, 'echoed URL secret is redacted');

  // 2. Origin-immutability enforcement: placeholders in scheme, host, port, or origin-hijacking userinfo must fail
  for (const badUrl of [
    `http://{{vault:HOST_PART}}:${port}/mcp`,
    `http://127.0.0.1:{{vault:PORT_PART}}/mcp`,
    `{{vault:SCHEME_PART}}://127.0.0.1:${port}/mcp`,
    `http://{{vault:EVIL_USER}}@127.0.0.1:${port}/mcp`,
  ]) {
    await assert.rejects(
      pool.buildResolvedAuth({ id: 'bad', transport: 'http', url: badUrl, headers: {} }),
      /scheme, host, or port|change the connection URL origin/,
      `rejected ${badUrl}`,
    );
  }

  // 3. Self-Loop URL is blocked even before connecting
  await assert.rejects(
    pool.buildResolvedAuth({ id: 'self', transport: 'http', url: 'http://127.0.0.1:8799/mcp?api_key={{vault:URL_KEY}}', headers: {} }),
    /cannot connect to itself/,
  );
});

test('connect-race cleanup closes orphaned sessions and child processes when invalidate() or closeAll() fires mid-connect', async (t) => {
  // Helper: stdio server that logs its PID immediately and delays its initialize reply
  async function writeSlowLocalServer(dir, delayMs) {
    const script = path.join(dir, `slow-mcp-${delayMs}.mjs`);
    await writeFile(script, `
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
appendFileSync(process.env.SPAWN_LOG, process.pid + '\\n');
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    setTimeout(() => {
      write({ id: msg.id, result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'slow-local', version: '1.0.0' },
      } });
    }, ${delayMs});
    return;
  }
  return write({ id: msg.id, result: {} });
});
`, 'utf8');
    return script;
  }

  // Case 1: invalidate() fires mid-connect
  {
    const { dir, store, pool } = await poolWithStore(t);
    const spawnLog = path.join(dir, 'spawns-inv.log');
    const script = await writeSlowLocalServer(dir, 250);
    const conn = await store.add({
      name: 'SlowInvalidate',
      transport: 'stdio',
      command: process.execPath,
      args: [script],
      env: { SPAWN_LOG: spawnLog },
    });

    const connectAttempt = pool.getClient(conn.id);
    const pid = await until(async () => {
      const raw = await readFile(spawnLog, 'utf8').catch(() => '');
      const n = Number(raw.trim().split('\n')[0]);
      return Number.isFinite(n) && n > 0 ? n : 0;
    });
    assert.ok(pid > 0, 'slow stdio process spawned');

    await pool.invalidate(conn.id);
    await assert.rejects(connectAttempt, /closed or removed while connecting/);
    assert.equal(pool.sessions.has(conn.id), false, 'no orphaned session registered');
    assert.equal(await until(() => !isRunning(pid)), true, 'orphaned child process was terminated');
  }

  // Case 2: closeAll() fires mid-connect
  {
    const dir = await tempDir(t, 'loop-race-close-');
    const store = new LoopStore(dir);
    const pool = new ConnectionPool(store, null);
    const spawnLog = path.join(dir, 'spawns-close.log');
    const script = await writeSlowLocalServer(dir, 250);
    const conn = await store.add({
      name: 'SlowCloseAll',
      transport: 'stdio',
      command: process.execPath,
      args: [script],
      env: { SPAWN_LOG: spawnLog },
    });

    const connectAttempt = pool.getClient(conn.id);
    const pid = await until(async () => {
      const raw = await readFile(spawnLog, 'utf8').catch(() => '');
      const n = Number(raw.trim().split('\n')[0]);
      return Number.isFinite(n) && n > 0 ? n : 0;
    });
    assert.ok(pid > 0, 'slow stdio process spawned');

    const closePromise = pool.closeAll();
    await assert.rejects(connectAttempt, /closed or removed while connecting/);
    await closePromise;
    assert.equal(pool.sessions.size, 0, 'no session left open after closeAll');
    assert.equal(pool._opening.size, 0, 'all in-flight opens drained');
    assert.equal(await until(() => !isRunning(pid)), true, 'child process terminated before/during closeAll');
  }

  // Case 3: connection disabled in store mid-connect (without explicit invalidate)
  {
    const { dir, store, pool } = await poolWithStore(t);
    const spawnLog = path.join(dir, 'spawns-disable.log');
    const script = await writeSlowLocalServer(dir, 250);
    const conn = await store.add({
      name: 'SlowDisable',
      transport: 'stdio',
      command: process.execPath,
      args: [script],
      env: { SPAWN_LOG: spawnLog },
    });

    const connectAttempt = pool.getClient(conn.id);
    const pid = await until(async () => {
      const raw = await readFile(spawnLog, 'utf8').catch(() => '');
      const n = Number(raw.trim().split('\n')[0]);
      return Number.isFinite(n) && n > 0 ? n : 0;
    });
    assert.ok(pid > 0);

    await store.update(conn.id, { enabled: false });
    await assert.rejects(connectAttempt, /closed or removed while connecting/);
    assert.equal(pool.sessions.has(conn.id), false);
    assert.equal(await until(() => !isRunning(pid)), true);
  }
});

test('G4b-04 & G4b-06: stdio spawns with minimal getDefaultEnvironment() by default and pre-flights missing/non-directory cwd', async (t) => {
  const prevSecret = process.env.LOOP_SUPER_SECRET_ENV;
  process.env.LOOP_SUPER_SECRET_ENV = 'top-secret-loop-env-value';
  t.after(() => {
    if (prevSecret === undefined) delete process.env.LOOP_SUPER_SECRET_ENV;
    else process.env.LOOP_SUPER_SECRET_ENV = prevSecret;
  });

  // Unit check: buildStdioEnv omits Loop process.env secrets by default, includes them only with inheritEnv: true
  const minimal = buildStdioEnv({ EXPLICIT_VAR: 'allowed' });
  assert.equal(minimal.EXPLICIT_VAR, 'allowed');
  assert.equal(minimal.LOOP_SUPER_SECRET_ENV, undefined);
  const inherited = buildStdioEnv({ EXPLICIT_VAR: 'allowed' }, { inheritEnv: true });
  assert.equal(inherited.LOOP_SUPER_SECRET_ENV, 'top-secret-loop-env-value');

  // Real spawned stdio child process must NOT receive LOOP_SUPER_SECRET_ENV
  const { dir, store, pool } = await poolWithStore(t);
  const envInspectScript = path.join(dir, 'env-inspect-mcp.mjs');
  await writeFile(envInspectScript, `
import readline from 'node:readline';
const write = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    return write({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'env-test', version: '1.0.0' } } });
  }
  if (msg.method === 'tools/list') {
    return write({ id: msg.id, result: { tools: [{ name: 'env_check', description: 'Check env', inputSchema: { type: 'object', properties: {} } }] } });
  }
  if (msg.method === 'tools/call') {
    return write({ id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ secret: process.env.LOOP_SUPER_SECRET_ENV ?? null, explicit: process.env.EXPLICIT_VAR ?? null }) }] } });
  }
  return write({ id: msg.id, result: {} });
});
`, 'utf8');

  const conn = await store.add({
    name: 'EnvCheck',
    transport: 'stdio',
    command: process.execPath,
    args: [envInspectScript],
    env: { EXPLICIT_VAR: 'visible' },
  });
  const callRes = await pool.callTool(conn.id, 'env_check', {});
  const seen = JSON.parse(callRes.content[0].text);
  assert.equal(seen.secret, null, 'stdio child must not inherit Loop process.env secrets');
  assert.equal(seen.explicit, 'visible');

  // G4b-06: missing cwd throws clear Working directory not found error
  const missingCwd = path.join(dir, 'does-not-exist-dir');
  const badCwdConn = await store.add({
    name: 'MissingCwd',
    transport: 'stdio',
    command: process.execPath,
    args: [envInspectScript],
    cwd: missingCwd,
  });
  await assert.rejects(
    pool.getClient(badCwdConn.id),
    { message: `Working directory not found: ${missingCwd}` },
  );

  // G4b-06: file path (not a directory) as cwd also throws Working directory not found
  const fileNotDir = path.join(dir, 'not-a-dir.txt');
  await writeFile(fileNotDir, 'hello', 'utf8');
  const fileCwdConn = await store.add({
    name: 'FileCwd',
    transport: 'stdio',
    command: process.execPath,
    args: [envInspectScript],
    cwd: fileNotDir,
  });
  await assert.rejects(
    pool.getClient(fileCwdConn.id),
    { message: `Working directory not found: ${fileNotDir}` },
  );
});

test('G4b-09: structured error classification ignores message text and checks HTTP status/code/name only', async (t) => {
  // isUnauthorizedError: structured fields only
  assert.equal(isUnauthorizedError({ status: 401 }), true);
  assert.equal(isUnauthorizedError({ statusCode: 401 }), true);
  assert.equal(isUnauthorizedError({ code: 401 }), true);
  assert.equal(isUnauthorizedError({ event: { code: 401 } }), true);
  assert.equal(isUnauthorizedError({ name: 'UnauthorizedError', message: 'auth needed' }), true);
  assert.equal(isUnauthorizedError(new Error('Tool returned 401 unauthorized for user')), false);
  assert.equal(isUnauthorizedError(Object.assign(new Error('401 Unauthorized'), { code: -32000 })), false);

  // shouldFallbackToSse: HTTP 404/405 only, never JSON-RPC or message-text "not found"
  assert.equal(shouldFallbackToSse({ code: 404 }), true);
  assert.equal(shouldFallbackToSse({ code: 405 }), true);
  assert.equal(shouldFallbackToSse({ status: 404 }), true);
  assert.equal(shouldFallbackToSse({ statusCode: 405 }), true);
  assert.equal(shouldFallbackToSse({ code: 401, message: 'not found' }), false);
  assert.equal(shouldFallbackToSse(Object.assign(new Error('Method not found'), { code: -32601 })), false);
  assert.equal(shouldFallbackToSse(new Error('Resource not found or method not allowed')), false);

  // Integration: JSON-RPC error mentioning "401 unauthorized" during sync must NOT flip authRequired=true,
  // and JSON-RPC error mentioning "not found" during initialize must NOT trigger SSE GET fallback.
  let sseGetHits = 0;
  let mode = 'rpc-401-text';
  const srv = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      sseGetHits += 1;
      res.writeHead(405);
      return res.end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (msg.method === 'notifications/initialized') {
      res.writeHead(202);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (mode === 'rpc-not-found-init' && msg.method === 'initialize') {
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Workspace not found' } }));
    }
    if (msg.method === 'initialize') {
      return res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'g4b09', version: '1.0.0' } },
      }));
    }
    if (msg.method === 'tools/list') {
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Upstream tool says 401 unauthorized: ' + 'z'.repeat(900) } }));
    }
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { srv.closeAllConnections?.(); srv.close(resolve); }));

  const { store, pool } = await poolWithStore(t);
  const conn = await store.add({ name: 'TextErr', transport: 'http', url: `http://127.0.0.1:${srv.address().port}/mcp` });

  const synced1 = await pool.sync(conn.id);
  assert.equal(synced1.authRequired, false, 'JSON-RPC error text containing 401 unauthorized must not mark authRequired');
  assert.ok(synced1.lastError && synced1.lastError.length <= MAX_LAST_ERROR_CHARS, 'lastError capped to 500 chars');

  mode = 'rpc-not-found-init';
  await pool.invalidate(conn.id);
  sseGetHits = 0;
  const synced2 = await pool.sync(conn.id);
  assert.equal(sseGetHits, 0, 'JSON-RPC "not found" error on initialize must not fall back to SSE GET');
  assert.match(synced2.lastError, /Workspace not found/);
});

test('G4b-07 & G4b-08: lenient catalog parsing drops malformed entries, breaks cursor cycles, deduplicates, and caps tools/descriptions/schemas', async (t) => {
  // Unit check: listAllPages breaks on multi-step cursor cycle (c1 -> c2 -> c1)
  let pageFetches = 0;
  const cycleRes = await listAllPages(async (params) => {
    pageFetches += 1;
    if (!params?.cursor) return { tools: [{ name: 'a' }], nextCursor: 'c1' };
    if (params.cursor === 'c1') return { tools: [{ name: 'b' }], nextCursor: 'c2' };
    return { tools: [{ name: 'c' }], nextCursor: 'c1' };
  }, 'tools');
  assert.equal(pageFetches, 3);
  assert.equal(cycleRes.truncated, true);
  assert.equal(cycleRes.truncationReason, 'cursor_cycle');
  assert.deepEqual(cycleRes.items.map((x) => x.name), ['a', 'b', 'c']);

  // Integration: malformed tool + duplicate tools/resources/prompts + oversized description + oversized >64KB schema + cursor cycle
  const bigDesc = 'D'.repeat(5000);
  const hugeSchema = {
    type: 'object',
    properties: { big: { type: 'string', description: 'X'.repeat(70 * 1024) } },
  };
  let scenario = 'malformed-and-caps';
  const srv = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const send = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    };
    if (msg.method === 'initialize') {
      return send({ protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'wild', version: '1.0.0' } });
    }
    if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
    if (msg.method === 'tools/list') {
      if (scenario === 'overflow-500') {
        const many = Array.from({ length: 550 }, (_, i) => tool(`t_${i}`));
        return send({ tools: many });
      }
      const cursor = msg.params?.cursor;
      if (!cursor) {
        return send({
          tools: [
            null,
            42,
            { description: 'missing name' },
            { name: 999, description: 'numeric name' },
            { name: 'good_first', description: bigDesc, inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
            { name: 'good_first', description: 'duplicate must be ignored', inputSchema: { type: 'object', properties: {} } },
            { name: 'huge_schema_tool', description: 'Valid tool', inputSchema: hugeSchema },
          ],
          nextCursor: 'loop-cursor',
        });
      }
      return send({
        tools: [tool('page_two_tool')],
        nextCursor: 'loop-cursor', // cycle back to same cursor
      });
    }
    if (msg.method === 'resources/list') {
      return send({
        resources: [
          null,
          { uri: 'file:///a', name: 'A1' },
          { uri: 'file:///a', name: 'A2-dup' },
          { name: 'no-uri' },
        ],
      });
    }
    if (msg.method === 'prompts/list') {
      return send({
        prompts: [
          'not-an-object',
          { name: 'p1', description: 'First' },
          { name: 'p1', description: 'Second-dup' },
        ],
      });
    }
    return send({});
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { srv.closeAllConnections?.(); srv.close(resolve); }));

  const { store, pool } = await poolWithStore(t);
  const conn = await store.add({ name: 'Wild', transport: 'http', url: `http://127.0.0.1:${srv.address().port}/mcp` });

  const synced = await pool.sync(conn.id);
  assert.deepEqual(synced.tools.map((x) => x.name), ['good_first', 'huge_schema_tool', 'page_two_tool']);
  assert.equal(synced.tools[0].description.length, MAX_TOOL_DESCRIPTION_CHARS);
  assert.deepEqual(synced.tools[1].inputSchema, { type: 'object', properties: {} });
  assert.match(synced.tools[1].description, /exceeded 64 KB limit/);
  assert.deepEqual(synced.resources.map((r) => ({ uri: r.uri, name: r.name })), [{ uri: 'file:///a', name: 'A1' }]);
  assert.deepEqual(synced.prompts.map((p) => ({ name: p.name, description: p.description })), [{ name: 'p1', description: 'First' }]);
  assert.match(synced.lastError, /cursor cycle/i);
  assert.equal(synced.syncFailures, 0);

  // >500 tools capped to MAX_TOOLS_PER_CONN (500) with truncation note
  scenario = 'overflow-500';
  const capped = await pool.sync(conn.id);
  assert.equal(capped.tools.length, MAX_TOOLS_PER_CONN);
  assert.match(capped.lastError, /500 tools/);
});

test('G4a-03 & G4a-04: egress boundOrigin guard, proportional refresh window, CAS refresh writeback, and expired token warning', async (t) => {
  // 1. Proportional refresh window formula
  assert.equal(computeOAuthRefreshWindowMs({ ttlMs: 3_600_000 }), 60_000);
  assert.equal(computeOAuthRefreshWindowMs({ ttlMs: 120_000 }), 30_000);
  assert.equal(computeOAuthRefreshWindowMs({ ttlMs: 60_000 }), 15_000);
  assert.equal(computeOAuthRefreshWindowMs({ ttlMs: 15_000 }), 5_000);
  assert.equal(computeOAuthRefreshWindowMs({ ttlMs: 8_000 }), 2_000);
  assert.equal(computeOAuthRefreshWindowMs({ ttlMs: null }), 60_000);

  // Token server for refresh tests
  let refreshHits = 0;
  let refreshDelayMs = 0;
  let onRefreshStarted = null;
  let nextAccess = 'refreshed-token-1';
  const authSrv = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/token' && req.method === 'POST') {
      refreshHits += 1;
      onRefreshStarted?.();
      if (refreshDelayMs) await sleep(refreshDelayMs);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ access_token: nextAccess, refresh_token: 'rotated-ref', expires_in: 60 }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => authSrv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { authSrv.closeAllConnections?.(); authSrv.close(resolve); }));
  const authOrigin = `http://127.0.0.1:${authSrv.address().port}`;

  const vault = {
    values: new Map(),
    async set(k, v) { this.values.set(k, v); },
    async get(k) { return this.values.has(k) ? this.values.get(k) : null; },
    async delete(k) { return this.values.delete(k); },
    async resolveRecord(r) { return { ...r }; },
    async resolveString(s) { return s; },
  };
  await vault.set('__oauth_access_c1_aaaaaaaa', 'secret-access-1');
  await vault.set('__oauth_refresh_c1_aaaaaaaa', 'secret-refresh-1');

  // 2. Egress boundOrigin mismatch prevents attaching Bearer token AND prevents refresh (Vault & legacy inline)
  const memStore = new Map();
  const mockStore = {
    async get(id) { return memStore.get(id) || null; },
    async update(id, patch) {
      const cur = memStore.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      memStore.set(id, next);
      return next;
    },
  };
  const pool = new ConnectionPool(mockStore, vault);
  t.after(() => pool.closeAll());

  const mismatchedVaultConn = {
    id: 'c1',
    transport: 'http',
    url: 'http://127.0.0.1:55555/mcp', // different port = different origin!
    oauth: {
      grantId: 'aaaaaaaa-1111-4222-8333-444444444444',
      boundOrigin: authOrigin,
      tokenEndpoint: `${authOrigin}/token`,
      accessTokenVaultKey: '__oauth_access_c1_aaaaaaaa',
      refreshTokenVaultKey: '__oauth_refresh_c1_aaaaaaaa',
      ttlMs: 60_000,
      expiresAt: Date.now() + 1_000, // within refresh window
    },
  };
  const resolvedMismatch = await pool.buildResolvedAuth(mismatchedVaultConn);
  assert.equal(resolvedMismatch.headers.Authorization, undefined, 'Vault OAuth token must NOT be attached when origin != boundOrigin');
  assert.equal(refreshHits, 0, 'must NOT refresh when origin != boundOrigin');

  const mismatchedLegacyConn = {
    id: 'c_legacy',
    transport: 'http',
    url: 'http://127.0.0.1:55555/mcp',
    oauth: {
      boundOrigin: authOrigin,
      accessToken: 'legacy-inline-secret',
      expiresAt: Date.now() + 60_000,
    },
  };
  const resolvedLegacyMismatch = await pool.buildResolvedAuth(mismatchedLegacyConn);
  assert.equal(resolvedLegacyMismatch.headers.Authorization, undefined, 'legacy inline OAuth token must NOT be attached on origin mismatch');

  // 3. Proportional refresh: 30s TTL with 20s remaining (> 7.5s window) does NOT refresh
  const shortTtlConn = {
    id: 'c1',
    transport: 'http',
    url: `${authOrigin}/mcp`,
    oauth: {
      grantId: 'aaaaaaaa-1111-4222-8333-444444444444',
      boundOrigin: authOrigin,
      tokenEndpoint: `${authOrigin}/token`,
      accessTokenVaultKey: '__oauth_access_c1_aaaaaaaa',
      refreshTokenVaultKey: '__oauth_refresh_c1_aaaaaaaa',
      ttlMs: 30_000,
      expiresAt: Date.now() + 20_000,
    },
  };
  memStore.set('c1', shortTtlConn);
  const noRefreshRes = await pool.buildResolvedAuth(shortTtlConn);
  assert.equal(refreshHits, 0, 'short TTL token outside 25% window must not refresh');
  assert.equal(noRefreshRes.headers.Authorization, 'Bearer secret-access-1');

  // 4. CAS refresh writeback discards refreshed record if connection is repointed mid-refresh (supports store.updateIf AND fallback)
  let updateIfCalled = false;
  const casStore = {
    async get(id) { return memStore.get(id) || null; },
    async update(id, patch) { return mockStore.update(id, patch); },
    async updateIf(id, predicate, patch) {
      updateIfCalled = true;
      const cur = memStore.get(id);
      if (!cur || !predicate(cur)) return null;
      const next = { ...cur, ...patch };
      memStore.set(id, next);
      return next;
    },
  };
  const casPool = new ConnectionPool(casStore, vault);
  t.after(() => casPool.closeAll());

  const expiringConn = {
    ...shortTtlConn,
    oauth: { ...shortTtlConn.oauth, expiresAt: Date.now() + 2_000 },
  };
  memStore.set('c1', expiringConn);
  refreshDelayMs = 80;
  onRefreshStarted = () => {
    // Repoint connection to a different origin (and clear oauth) while refresh is in flight
    memStore.set('c1', { id: 'c1', transport: 'http', url: 'https://other.example/mcp', oauth: null });
  };
  const casRes = await casPool.buildResolvedAuth(expiringConn);
  refreshDelayMs = 0;
  onRefreshStarted = null;
  assert.equal(updateIfCalled, true, 'must use store.updateIf when available');
  assert.equal(memStore.get('c1').oauth, null, 'CAS must discard refresh and never overwrite repointed connection');
  assert.equal(casRes.headers.Authorization, undefined, 'discarded refresh must not attach stale Bearer token');
  assert.equal(await vault.get('__oauth_access_c1_aaaaaaaa'), null, 'orphaned refreshed vault key cleaned up');

  // 5. Already-expired token with NO refresh token marks authRequired: true, lastError: 'Sign in required.' and omits Bearer
  await vault.set('__oauth_access_c2_bbbbbbbb', 'expired-tok');
  const expiredNoRefresh = {
    id: 'c2',
    transport: 'http',
    url: `${authOrigin}/mcp`,
    authRequired: false,
    lastError: null,
    oauth: {
      grantId: 'bbbbbbbb-1111-4222-8333-444444444444',
      boundOrigin: authOrigin,
      tokenEndpoint: `${authOrigin}/token`,
      accessTokenVaultKey: '__oauth_access_c2_bbbbbbbb',
      refreshTokenVaultKey: null,
      ttlMs: 60_000,
      expiresAt: Date.now() - 5_000,
    },
  };
  memStore.set('c2', expiredNoRefresh);
  const expiredRes = await pool.buildResolvedAuth(expiredNoRefresh);
  assert.equal(expiredRes.headers.Authorization, undefined, 'expired token without refresh must not be attached');
  assert.equal(memStore.get('c2').authRequired, true);
  assert.equal(memStore.get('c2').lastError, 'Sign in required.');
});

test('a server that lists tools without sign-in stays "needs sign-in" after a call was turned away, until a credential is added', async (t) => {
  const upstream = await startUpstream(t);
  const { store, pool } = await poolWithStore(t);
  const conn = await store.add({ name: 'Mail', transport: 'http', url: upstream.url });

  // Listing works with no sign-in, so the first sync looks ready.
  assert.equal((await pool.sync(conn.id)).authRequired, false);

  // A real call came back 401 (what loop__run records), then the agent re-syncs while waiting for sign-in.
  await store.update(conn.id, { authRequired: true, signInRejectedCall: true, lastError: 'Sign in required.' });
  const resynced = await pool.sync(conn.id);
  assert.equal(resynced.authRequired, true, 'a tool listing alone does not count as signed in');
  assert.equal(resynced.lastError, 'Sign in required.');
  assert.equal(resynced.tools.length, 1, 'the tool list is still refreshed');
  assert.equal((await store.get(conn.id)).signInRejectedCall, true, 'the flag is saved');

  // Adding a key (or finishing sign-in, which also clears the flag) lets the next sync count again.
  await store.update(conn.id, { headers: { 'X-API-Key': 'abc' } });
  assert.equal((await pool.sync(conn.id)).authRequired, false);
});

test('a new connection whose server says it requires sign-in is "needs sign-in" from its first sync, even though its tools list', async (t) => {
  const upstream = await startUpstream(t);
  upstream.state.advertiseSignIn = true;
  const { store, pool } = await poolWithStore(t);
  const conn = await store.add({ name: 'Mail', transport: 'http', url: upstream.url });
  const synced = await pool.sync(conn.id);
  assert.equal(synced.authRequired, true);
  assert.equal(synced.lastError, 'Sign in required.');
  assert.equal(synced.tools.length, 1, 'its tools are still listed');

  // A server that publishes nothing is unaffected.
  const plain = await startUpstream(t);
  const other = await store.add({ name: 'Plain', transport: 'http', url: plain.url });
  assert.equal((await pool.sync(other.id)).authRequired, false);
});

test('loop__save rejects unreachable or redirecting URLs before saving so broken guesses never trigger repoint', async (t) => {
  const badServer = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(301, { Location: 'https://example.test/toolkits/gmail' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<html><body>404 page</body></html>');
  });
  await new Promise((resolve) => badServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    badServer.closeAllConnections?.();
    badServer.close(resolve);
  }));
  const badBase = `http://127.0.0.1:${badServer.address().port}`;
  const goodUpstream = await startUpstream(t);

  const dir = await tempDir(t, 'loop-preflight-');
  const disk = new LoopStore(dir);
  await disk.updateSettings({ requireAgentToken: false });
  const srv = await startServer({ authMode: 'local-test', port: 0, dataDir: dir, detectLocalAgents: false, autoSync: false });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;

  const mcpCall = async (name, args) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const json = await res.json();
    return json.result;
  };

  // 1. Redirecting URL is rejected before saving.
  const redirRes = await mcpCall('loop__save', {
    type: 'connection',
    data: { name: 'Gmail', url: `${badBase}/redirect` },
  });
  assert.equal(redirRes.isError, true);
  const redirPayload = JSON.parse(redirRes.content[0].text);
  assert.equal(redirPayload.saved, false);
  assert.equal(redirPayload.reason, 'unreachable');
  assert.equal(redirPayload.httpStatus, 301);
  assert.equal(await disk.get('gmail'), null, 'redirecting URL must not be saved');

  // 2. HTML 200 page is also rejected before saving.
  const htmlRes = await mcpCall('loop__save', {
    type: 'connection',
    data: { name: 'Gmail', url: `${badBase}/html` },
  });
  assert.equal(htmlRes.isError, true);
  const htmlPayload = JSON.parse(htmlRes.content[0].text);
  assert.equal(htmlPayload.saved, false);
  assert.equal(htmlPayload.reason, 'unreachable');
  assert.equal(await disk.get('gmail'), null, 'HTML page must not be saved');

  // 3. A subsequent call with a real MCP server saves cleanly with no repoint approval.
  const goodRes = await mcpCall('loop__save', {
    type: 'connection',
    data: { name: 'Gmail', url: goodUpstream.url },
  });
  assert.ok(!goodRes.isError);
  const goodPayload = JSON.parse(goodRes.content[0].text);
  assert.equal(goodPayload.saved, true);
  assert.equal(goodPayload.connection.id, 'gmail');
});
