import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import dns from 'node:dns/promises';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ConnectionPool } from '../lib/mcp-client.mjs';
import { handleMcpRequest } from '../lib/mcp-server.mjs';
import {
  discoverOAuth,
  finishOAuthFlow,
  refreshOAuthToken,
  startOAuthFlow,
} from '../lib/oauth.mjs';
import {
  buildSelfIdentity,
  createOutboundPolicy,
  createSafeFetch,
  getHostedOriginPolicy,
  parsePublicHttpsUrl,
  probeConnection,
} from '../lib/outbound-policy.mjs';
import {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  MAX_UPSTREAM_RESPONSE_BYTES,
  assertApprovedOAuthUrl,
  assertPersonalConnection,
  assertPersonalStoredOAuth,
  assertPublicIPv4,
  createPersonalFetch,
  listPersonalUpstreamOrigins,
} from '../lib/personal-upstreams.mjs';
import { LoopStore } from '../lib/store.mjs';
import { Vault } from '../lib/vault.mjs';

const valid = { url: 'https://mcp.linear.app/mcp', transport: 'http' };

function setEnv(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function memoryVault() {
  const values = new Map();
  return {
    values,
    async set(key, value) { values.set(key, value); },
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async delete(key) { return values.delete(key); },
  };
}

function mockHttps(t, reply) {
  const mocked = t.mock.method(https, 'request', (url, opts, receive) => {
    const req = new EventEmitter();
    req.end = (body) => queueMicrotask(() => {
      const [statusCode, rawHeaders, data] = reply(url, opts, body);
      const res = new PassThrough();
      Object.assign(res, { statusCode, rawHeaders });
      receive(res);
      res.end(data);
    });
    return req;
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  return mocked;
}

async function startLocalHttpServer(t, handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const origin = `http://127.0.0.1:${server.address().port}`;
    await handler(req, res, { origin, body });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  return { port, origin: `http://127.0.0.1:${port}` };
}

test('hosted default allows any public HTTPS domain on port 443 while blocking private, local, and self targets', (t) => {
  setEnv(t, 'LOOP_TRUSTED_MCP_ORIGINS', undefined);
  setEnv(t, 'LOOP_HUB_ALLOWED_HOSTS', 'loop.example.dev');

  assert.deepEqual(getHostedOriginPolicy(), { mode: 'public', allowlist: null });
  assert.equal(listPersonalUpstreamOrigins(), null);

  assert.equal(assertPersonalConnection({ ...valid, url: 'https://doop.design/mcp' }).origin, 'https://doop.design');
  assert.equal(assertPersonalConnection({ ...valid, url: 'https://mcp.service.dev:443/sse', transport: 'sse' }).pathname, '/sse');
  assert.equal(assertApprovedOAuthUrl('https://auth.doop.design/authorize', 'sign-in page').origin, 'https://auth.doop.design');

  // Self-Loop host is refused even though it is a public HTTPS domain.
  assert.throws(() => assertPersonalConnection({ ...valid, url: 'https://loop.example.dev/mcp' }), /cannot connect to itself/);
  assert.throws(() => assertApprovedOAuthUrl('https://loop.example.dev/oauth/token', 'token'), /cannot use itself/);

  for (const url of [
    'http://mcp.linear.app/mcp', 'https://mcp.linear.app:8443/mcp',
    'https://localhost', 'https://[::1]', 'https://127.0.0.1',
    'https://service.local/mcp', 'https://app.internal/mcp', 'https://demo.example/mcp',
    'https://user@mcp.linear.app', 'https://@mcp.linear.app', 'https://mcp.linear.app./mcp',
  ]) {
    assert.throws(() => assertPersonalConnection({ ...valid, url }), /public HTTPS/);
  }
});

test('LOOP_TRUSTED_MCP_ORIGINS switches hosted mode to a strict opt-in allowlist', (t) => {
  setEnv(
    t,
    'LOOP_TRUSTED_MCP_ORIGINS',
    ' https://mcp.service.dev:443/, https://has-path.dev/path, https://127.0.0.1, https://service.local, https://*.other.dev',
  );

  assert.deepEqual(getHostedOriginPolicy(), { mode: 'allowlist', allowlist: ['https://mcp.service.dev'] });
  assert.deepEqual(listPersonalUpstreamOrigins(), ['https://mcp.service.dev']);
  assert.equal(assertPersonalConnection({ ...valid, url: 'https://mcp.service.dev/sse', transport: 'sse' }).pathname, '/sse');

  for (const url of [
    'https://mcp.linear.app/mcp', 'https://somewhere.dev/mcp', 'https://mcp.service.dev.other.dev/mcp',
    'http://mcp.service.dev/mcp', 'https://mcp.service.dev:8443/mcp',
    'https://localhost', 'https://[::1]', 'https://127.0.0.1',
    'https://user@mcp.service.dev', 'https://@mcp.service.dev', 'https://mcp.service.dev./mcp',
  ]) {
    assert.throws(() => assertPersonalConnection({ ...valid, url }), /public HTTPS|not approved/);
  }

  // Only invalid entries in LOOP_TRUSTED_MCP_ORIGINS must fail closed (never fall back to public).
  process.env.LOOP_TRUSTED_MCP_ORIGINS = 'https://127.0.0.1, https://bad.local';
  assert.deepEqual(getHostedOriginPolicy(), { mode: 'allowlist', allowlist: [] });
  assert.throws(() => assertPersonalConnection(valid), /not approved/);
});

test('personal configuration rejects local execution, OAuth, and unsafe headers', (t) => {
  setEnv(t, 'LOOP_TRUSTED_MCP_ORIGINS', undefined);
  assert.doesNotThrow(() => assertPersonalConnection({
    ...valid, command: null, cwd: null, env: {}, args: [], oauth: null,
    headers: { Authorization: 'Bearer {{vault:API_KEY}}' },
  }));
  for (const patch of [
    { transport: 'stdio' }, { type: 'stdio' }, { command: '' }, { cwd: '/tmp' }, { args: ['x'] },
    { env: { SECRET: 'value' } }, { oauth: {} }, { accessToken: 'raw' }, { tokenEndpoint: 'https://other.dev' },
    ...['Host', 'cookie', 'Proxy-Authorization', 'Origin', 'Forwarded', 'Content-Length', 'mcp-session-id'].map((h) => ({ headers: { [h]: 'value' } })),
    { headers: { Authorization: 'a\r\nb' } }, { headers: { Authorization: 'a', authorization: 'b' } },
  ]) assert.throws(() => assertPersonalConnection({ ...valid, ...patch }));
  for (const address of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '100.64.0.1', '198.18.0.1', '224.1.1.1', '::1', '::ffff:127.0.0.1']) {
    assert.throws(() => assertPublicIPv4(address), /public IPv4/);
  }

  // Stored OAuth accepts optional issuer and clientSecretVaultKey bound to conn.id.
  assert.doesNotThrow(() => assertPersonalStoredOAuth({
    id: 'linear',
    oauth: {
      clientId: 'cid',
      clientSecret: null,
      clientSecretVaultKey: '__oauth_client_secret_linear',
      issuer: 'https://mcp.linear.app',
      tokenEndpoint: 'https://mcp.linear.app/token',
      callbackUrl: 'https://loop.example.dev/oauth/callback',
      accessTokenVaultKey: '__oauth_access_linear',
      refreshTokenVaultKey: '__oauth_refresh_linear',
      expiresAt: Date.now() + 60_000,
    },
  }));
  assert.throws(() => assertPersonalStoredOAuth({
    id: 'linear',
    oauth: {
      clientId: 'cid',
      clientSecretVaultKey: '__oauth_client_secret_other',
      tokenEndpoint: 'https://mcp.linear.app/token',
      accessTokenVaultKey: '__oauth_access_linear',
    },
  }), /sign-in record/);
  assert.throws(() => assertPersonalStoredOAuth({
    id: 'linear',
    oauth: {
      clientId: 'cid',
      issuer: 'https://auth.other.dev',
      tokenEndpoint: 'http://mcp.linear.app/token', // a plain-HTTP token endpoint is never accepted
      accessTokenVaultKey: '__oauth_access_linear',
    },
  }), /sign-in record|secure \(https\)/);
});

test('personal pool validates before secrets or networking for every operation', async (t) => {
  setEnv(t, 'LOOP_TRUSTED_MCP_ORIGINS', undefined);
  for (const config of [
    { ...valid, url: 'http://localhost/mcp' },
    { ...valid, oauth: { accessTokenVaultKey: 'x', tokenEndpoint: 'https://other.dev' } },
    { transport: 'stdio', command: 'ignored' },
  ]) {
    let authCalls = 0;
    const store = { get: async () => config, update: async (_id, patch) => patch };
    const vault = { resolveRecord: async () => { authCalls += 1; }, get: async () => { authCalls += 1; } };
    const pool = new ConnectionPool(store, vault, { personal: true });
    const denied = /Personal MCP/;
    assert.match((await pool.sync('x')).lastError, denied);
    await assert.rejects(pool.callTool('x', 'tool'), denied);
    await assert.rejects(pool.readResource('x', 'file:///unused'), denied);
    await assert.rejects(pool.getPrompt('x', 'prompt'), denied);
    assert.equal(authCalls, 0);
  }
});

test('personal HTTP and SSE never follow redirects, including the SSE message POST', async (t) => {
  setEnv(t, 'LOOP_TRUSTED_MCP_ORIGINS', undefined);
  const requested = [];
  mockHttps(t, (url, opts) => {
    assert.equal(opts.rejectUnauthorized, true);
    assert.equal(opts.family, 4);
    assert.equal(typeof opts.lookup, 'function');
    requested.push([opts.method || 'GET', url.href]);
    if (!opts.method && url.pathname === '/sse') {
      return [200, ['content-type', 'text/event-stream'], 'event: endpoint\ndata: /message\n\n'];
    }
    return [302, ['location', 'https://mcp.linear.app/other'], ''];
  });
  for (const cfg of [valid, { ...valid, url: 'https://mcp.linear.app/sse', transport: 'sse' }]) {
    const pool = new ConnectionPool({ get: async () => cfg }, null, { personal: true });
    await assert.rejects(pool.getClient('x'), /redirects/i);
  }
  assert.deepEqual(requested, [
    ['POST', 'https://mcp.linear.app/mcp'], ['GET', 'https://mcp.linear.app/sse'], ['POST', 'https://mcp.linear.app/message'],
  ]);
});

test('personal fallback uses the same SSE request policy and workspace headers', async (t) => {
  setEnv(t, 'LOOP_TRUSTED_MCP_ORIGINS', undefined);
  const request = mockHttps(t, (url, opts) => {
    assert.equal(opts.headers.authorization, 'Bearer fixture');
    if (url.pathname === '/mcp' && opts.method === 'POST') return [405, [], ''];
    if (url.pathname === '/mcp') {
      return [200, ['content-type', 'text/event-stream'], 'event: endpoint\ndata: /message\n\n'];
    }
    return [302, ['location', 'https://mcp.notion.com/other'], ''];
  });
  const store = { get: async () => ({ ...valid, headers: { Authorization: 'Bearer {{vault:ONLY_THIS_WORKSPACE}}' } }) };
  const vault = { resolveRecord: async () => ({ Authorization: 'Bearer fixture' }) };
  const pool = new ConnectionPool(store, vault, { personal: true });
  await assert.rejects(pool.getClient('x'), /redirects/i);
  assert.deepEqual(
    request.mock.calls.map(({ arguments: [url, opts] }) => [url.pathname, opts.method || 'GET']),
    [['/mcp', 'POST'], ['/mcp', 'GET'], ['/message', 'POST']],
  );
});

test('personal SSE rejects an advertised endpoint on a different origin', async (t) => {
  setEnv(t, 'LOOP_TRUSTED_MCP_ORIGINS', undefined);
  const request = mockHttps(t, () => [200, ['content-type', 'text/event-stream'],
    'event: endpoint\ndata: https://mcp.notion.com/message\n\n']);
  const pool = new ConnectionPool({ get: async () => ({ ...valid, transport: 'sse' }) }, null, { personal: true });
  await assert.rejects(pool.getClient('x'), /origin/);
  assert.equal(request.mock.callCount(), 1);
});

test('HTTPS socket uses only validated DNS results and an explicit direct agent', async (t) => {
  setEnv(t, 'LOOP_TRUSTED_MCP_ORIGINS', undefined);
  const resolver = t.mock.method(dns, 'lookup', async () => [{ address: '192.168.1.1', family: 4 }]);
  t.after(() => { resolver.mock.restore(); syncBuiltinESMExports(); });
  const fakeRequest = t.mock.method(https, 'request', (_url, opts, receive) => {
    const req = new EventEmitter();
    req.end = () => opts.lookup('mcp.linear.app', {}, (err, address, family) => {
      if (err) { req.emit('error', err); return; }
      assert.deepEqual([address, family], ['1.1.1.1', 4]);
      assert.ok(opts.agent instanceof https.Agent);
      const res = new PassThrough();
      Object.assign(res, { statusCode: 200, rawHeaders: ['content-type', 'application/json'] });
      receive(res);
      res.end('{"accepted":true}');
    });
    return req;
  });
  t.after(() => { fakeRequest.mock.restore(); syncBuiltinESMExports(); });
  syncBuiltinESMExports();
  const fetch = createPersonalFetch('https://mcp.linear.app');
  await assert.rejects(fetch(valid.url), /must resolve to a public IPv4/);
  resolver.mock.mockImplementation(async () => [{ address: '1.1.1.1', family: 4 }]);
  assert.deepEqual(await (await fetch(valid.url)).json(), { accepted: true });
});

test('personal dispatcher denies host actions and unsafe saves in both public and allowlist modes', async (t) => {
  setEnv(t, 'LOOP_TRUSTED_MCP_ORIGINS', undefined);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-personal-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new LoopStore(dir);
  const vault = new Vault(dir);
  const pool = new ConnectionPool(store, vault, { personal: true });
  const call = (name, args) => handleMcpRequest(store, vault, pool, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  }, { personal: true });
  for (const tool of ['discover', 'import', 'cleanup'].map((name) => `loop_host__${name}`)) {
    assert.equal((await call(tool)).result.isError, true);
    assert.equal((await call('loop__run', { tool })).result.isError, true);
    assert.equal((await call('loop__inspect', { type: 'tool', id: tool })).result.isError, true);
  }
  const save = (data, id) => call('loop__save', { type: 'connection', data, id });
  for (const data of [
    { name: 'Bad', command: 'blocked', transport: 'stdio' },
    { name: 'Bad', url: 'http://127.0.0.1:8799/mcp' },
    { name: 'Bad', ...valid, oauth: {} },
  ]) assert.equal((await save(data)).result.isError, true);
  // In allowlist mode, unlisted public domains are refused too.
  process.env.LOOP_TRUSTED_MCP_ORIGINS = 'https://mcp.linear.app';
  assert.equal((await save({ name: 'Bad', url: 'https://unapproved.dev/mcp' })).result.isError, true);
  delete process.env.LOOP_TRUSTED_MCP_ORIGINS;
  assert.deepEqual(await store.list(), []);

  const existing = await store.add({ name: 'Safe', ...valid });
  assert.equal((await save({ url: 'http://localhost', token: 'ignored' }, existing.id)).result.isError, true);
  assert.equal((await store.get(existing.id)).url, valid.url);
  assert.equal(await vault.get(`conn_${existing.id}_token`), null);
  const updated = await save({ description: 'Personal description' }, existing.id);
  assert.equal(updated.result.isError, false, JSON.stringify(updated.result.content));
  assert.equal((await store.get(existing.id)).description, 'Personal description');
  assert.ok(!(await call('loop__save', { type: 'note', id: 'fixture', data: { value: 'fixture text' } })).result.isError);
  assert.equal(await vault.get('fixture'), 'fixture text');
});

test('buildSelfIdentity blocks every loopback alias, allowedHosts, extraOrigins, and stdio symlinks', async (t) => {
  setEnv(t, 'LOOP_HUB_ALLOWED_HOSTS', 'hosted.loop.dev');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-self-id-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stdioFile = path.join(dir, 'stdio.mjs');
  const stdioLink = path.join(dir, 'sneaky-link.mjs');
  await writeFile(stdioFile, '// stub\n');
  await symlink(stdioFile, stdioLink);

  const self = buildSelfIdentity({
    port: 8799,
    allowedHosts: ['custom.loop.dev:9443'],
    extraOrigins: ['https://edge.loop.dev'],
    stdioPath: stdioFile,
  });

  assert.equal(self.port, 8799);
  for (const url of [
    'http://127.0.0.1:8799/mcp',
    'http://localhost:8799/oauth/token',
    'http://localhost.:8799/mcp',
    'http://0.0.0.0:8799/mcp',
    'http://[::1]:8799/mcp',
    'http://[::ffff:127.0.0.1]:8799/mcp',
    'http://[0:0:0:0:0:0:0:1]:8799/mcp',
    'https://hosted.loop.dev/mcp',
    'https://custom.loop.dev:9443/mcp',
    'https://edge.loop.dev/mcp',
  ]) {
    assert.equal(self.isSelfUrl(url), true, `expected self URL: ${url}`);
  }

  for (const url of [
    'http://127.0.0.1:9999/mcp',
    'http://localhost:3000/mcp',
    'https://mcp.linear.app/mcp',
    'https://custom.loop.dev:443/mcp',
  ]) {
    assert.equal(self.isSelfUrl(url), false, `expected non-self URL: ${url}`);
  }

  assert.equal(self.isSelfStdio(stdioFile, []), true);
  assert.equal(self.isSelfStdio(stdioLink, []), true);
  assert.equal(self.isSelfStdio('node', [stdioFile]), true);
  assert.equal(self.isSelfStdio('node', [stdioLink]), true);
  assert.equal(self.isSelfStdio('node', ['/tmp/other-mcp.mjs']), false);
});

test('createOutboundPolicy enforces OAuth URL scheme, self-identity, downward-pivot, and cross-port loopback guards', () => {
  const selfIdentity = buildSelfIdentity({ port: 8799 });
  const localPolicy = createOutboundPolicy({ personal: false, selfIdentity });

  // Self-Loop blocked for both connections and OAuth endpoints (G4a-01A).
  assert.throws(() => localPolicy.assertConnectionUrl('http://127.0.0.1:8799/mcp'), /cannot connect to itself/);
  assert.throws(
    () => localPolicy.assertOAuthUrl('http://127.0.0.1:8799/oauth/token', 'token', { connectionUrl: 'http://127.0.0.1:41000/mcp' }),
    /cannot use itself/,
  );

  // Dangerous schemes blocked immediately (G4a-16).
  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'http://evil.dev/token']) {
    assert.throws(
      () => localPolicy.assertOAuthUrl(bad, 'sign-in page', { connectionUrl: 'http://127.0.0.1:41000/mcp' }),
      /secure \(https\)/,
    );
  }

  // Loopback MCP on port A cannot pivot to a different loopback port B (G4a-01B),
  // but CAN use its own exact origin or a public HTTPS OAuth server.
  assert.equal(
    localPolicy.assertOAuthUrl('http://127.0.0.1:41000/token', 'token', { connectionUrl: 'http://127.0.0.1:41000/mcp' }).href,
    'http://127.0.0.1:41000/token',
  );
  assert.equal(
    localPolicy.assertOAuthUrl('https://auth.doop.design/authorize', 'sign-in page', { connectionUrl: 'http://127.0.0.1:41000/mcp' }).origin,
    'https://auth.doop.design',
  );
  assert.throws(
    () => localPolicy.assertOAuthUrl('http://127.0.0.1:42000/internal/admin', 'token', { connectionUrl: 'http://127.0.0.1:41000/mcp' }),
    /own origin/,
  );

  // Public remote MCP cannot pivot downward to loopback or private addresses.
  assert.throws(
    () => localPolicy.assertOAuthUrl('http://127.0.0.1:41000/token', 'token', { connectionUrl: 'https://mcp.doop.design/mcp' }),
    /secure \(https\) public/,
  );
  assert.throws(
    () => localPolicy.assertOAuthUrl('https://service.local/token', 'token', { connectionUrl: 'https://mcp.doop.design/mcp' }),
    /secure \(https\) public/,
  );
  assert.equal(
    localPolicy.assertOAuthUrl('https://auth.doop.design/token', 'token', { connectionUrl: 'https://mcp.doop.design/mcp' }).origin,
    'https://auth.doop.design',
  );
  assert.equal(parsePublicHttpsUrl('https://doop.design/mcp').hostname, 'doop.design');
});

test('createSafeFetch enforces maxResponseBytes and returnRedirect mode', async (t) => {
  const srv = await startLocalHttpServer(t, (req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/target' });
      res.end();
      return;
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('A'.repeat(2048));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });

  const strictFetch = createSafeFetch({ requirePublic: false, returnRedirect: false, maxResponseBytes: 512 });
  await assert.rejects(strictFetch(`${srv.origin}/redirect`), /Redirects are not followed/);
  const bigRes = await strictFetch(`${srv.origin}/big`);
  await assert.rejects(bigRes.text(), /maximum allowed size/);

  const inspectRedirectFetch = createSafeFetch({ requirePublic: false, returnRedirect: true });
  const redirRes = await inspectRedirectFetch(`${srv.origin}/redirect`);
  assert.equal(redirRes.status, 302);
  assert.equal(redirRes.headers.get('location'), '/target');
});

test('an address where no MCP server answers is told in plain words', async () => {
  const told = async (error) => (await probeConnection('https://mcp.example.com/mcp', {
    policy: { assertConnectionUrl: (url) => new URL(url), createFetchForUrl: () => async () => { throw error; } },
  })).error;
  const failed = (code) => Object.assign(new Error(`raw ${code}`), { code });
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EPROTO', 'HPE_INVALID_CONSTANT']) {
    assert.equal(await told(failed(code)), 'No MCP server answers at mcp.example.com. Check the address, and that the server is on.');
  }
  assert.match(await told(Object.assign(new TypeError('fetch failed'), { cause: failed('ECONNREFUSED') })), /^No MCP server answers at mcp\.example\.com\./);
  assert.equal(await told(failed('ENOTFOUND')), 'Loop cannot find mcp.example.com. Check the address.');
  for (const error of [failed('ETIMEDOUT'), failed('UND_ERR_CONNECT_TIMEOUT'), AbortSignal.abort().reason, new DOMException('late', 'TimeoutError')]) {
    assert.equal(await told(error), 'mcp.example.com did not answer in time. Check the address, or try again.');
  }
  for (const code of ['DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
    assert.equal(await told(failed(code)), 'mcp.example.com has no valid security certificate, so Loop does not connect to it.');
  }
  assert.equal(await told(new Error('Upstream must resolve to a public IPv4 address.')), 'Upstream must resolve to a public IPv4 address.');
});

test('probeConnection handles ready (HTTP & SSE), redirect, OAuth (via WWW-Authenticate), api_key, and policy errors with zero credentials', async (t) => {
  const seenAuthHeaders = [];
  const srv = await startLocalHttpServer(t, (req, res, { origin }) => {
    if (req.headers.authorization || req.headers.cookie) {
      seenAuthHeaders.push({ url: req.url, auth: req.headers.authorization, cookie: req.headers.cookie });
    }
    if (req.url === '/http-ready' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { serverInfo: { name: 'Doop MCP', description: 'Design tools' } },
      }));
      return;
    }
    if (req.url === '/sse-only' && req.method === 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (req.url === '/sse-only' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: endpoint\ndata: /msg\n\n');
      res.end();
      return;
    }
    if (req.url === '/old-path') {
      res.writeHead(308, { Location: '/http-ready' });
      res.end();
      return;
    }
    if (req.url === '/evil-redirect') {
      res.writeHead(302, { Location: 'http://127.0.0.1:8799/mcp' });
      res.end();
      return;
    }
    if (req.url === '/oauth-mcp') {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${origin}/custom/prm"`,
      });
      res.end('{"error":"unauthorized"}');
      return;
    }
    if (req.url === '/custom/prm') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ resource: `${origin}/oauth-mcp`, authorization_servers: [origin] }));
      return;
    }
    if (req.url === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
      }));
      return;
    }
    if (req.url === '/apikey-mcp') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"api key required"}');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const policy = createOutboundPolicy({
    personal: false,
    selfIdentity: buildSelfIdentity({ port: 8799 }),
  });

  assert.deepEqual(await probeConnection(`${srv.origin}/http-ready`, { policy }), {
    status: 'ready',
    url: `${srv.origin}/http-ready`,
    transport: 'http',
    suggestedName: 'Doop MCP',
    description: 'Design tools',
  });

  assert.deepEqual(await probeConnection(`${srv.origin}/sse-only`, { policy }), {
    status: 'ready',
    url: `${srv.origin}/sse-only`,
    transport: 'sse',
    suggestedName: 'Local MCP',
  });

  assert.deepEqual(await probeConnection(`${srv.origin}/old-path`, { policy }), {
    status: 'redirect',
    originalUrl: `${srv.origin}/old-path`,
    redirectUrl: `${srv.origin}/http-ready`,
  });

  const evilRedirect = await probeConnection(`${srv.origin}/evil-redirect`, { policy });
  assert.equal(evilRedirect.status, 'error');
  assert.match(evilRedirect.error, /cannot connect to itself/);

  assert.deepEqual(await probeConnection(`${srv.origin}/oauth-mcp`, { policy }), {
    status: 'oauth',
    url: `${srv.origin}/oauth-mcp`,
    authHost: `127.0.0.1:${srv.port}`,
    sameOrigin: true,
    issuer: srv.origin,
    suggestedName: 'Local MCP',
  });

  // 401 without OAuth metadata (separate server without well-known) -> api_key
  const keyOnly = await startLocalHttpServer(t, (_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":"missing key"}');
  });
  assert.deepEqual(await probeConnection(`${keyOnly.origin}/mcp`, { policy }), {
    status: 'api_key',
    url: `${keyOnly.origin}/mcp`,
    suggestedName: 'Local MCP',
  });

  // Self URL fails immediately before networking.
  const selfProbe = await probeConnection('http://127.0.0.1:8799/mcp', { policy });
  assert.equal(selfProbe.status, 'error');
  assert.match(selfProbe.error, /cannot connect to itself/);

  assert.deepEqual(seenAuthHeaders, []);
});

test('hardened oauth.mjs enforces issuer, RFC 8707 resource, RFC 9207 iss, token validation, Vault clientSecret, and single-flight refresh', async (t) => {
  const tokenBodies = [];
  let tokenReply = () => ({ status: 200, body: { access_token: 'tok-1', refresh_token: 'ref-1', expires_in: 3600 } });
  let metaOverride = null;
  let prmOverride = null;
  let refreshCount = 0;

  const srv = await startLocalHttpServer(t, async (req, res, { origin, body }) => {
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.url === '/custom/prm') {
      return json(200, prmOverride ? prmOverride(origin) : { resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (req.url === '/.well-known/oauth-authorization-server') {
      return json(200, metaOverride ? metaOverride(origin) : {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (req.url === '/register' && req.method === 'POST') {
      return json(201, { client_id: 'cid-1', client_secret: 'super-secret-client' });
    }
    if (req.url === '/token' && req.method === 'POST') {
      const params = Object.fromEntries(new URLSearchParams(body));
      tokenBodies.push(params);
      if (params.grant_type === 'refresh_token') {
        refreshCount += 1;
        await new Promise((r) => setTimeout(r, 40));
      }
      const reply = tokenReply(params);
      return json(reply.status, reply.body);
    }
    if (req.url === '/mcp' && req.method === 'POST') {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${origin}/custom/prm"`,
      });
      res.end('{"error":"unauthorized"}');
      return;
    }
    return json(404, {});
  });

  const conn = { id: 'hardened_1', url: `${srv.origin}/mcp` };
  const vault = memoryVault();

  // 0. Automatic RFC 9728 WWW-Authenticate resource_metadata discovery when well-known PRM is absent.
  const autoDiscovered = await discoverOAuth(conn.url);
  assert.equal(autoDiscovered.issuer, srv.origin);
  assert.equal(autoDiscovered.tokenEndpoint, `${srv.origin}/token`);

  // 1. WWW-Authenticate resource_metadata + RFC 8707 resource + startOAuthFlow metadata.
  const started = await startOAuthFlow(conn, 'http://127.0.0.1:8799/oauth/callback', {
    wwwAuthenticate: `Bearer resource_metadata="${srv.origin}/custom/prm"`,
  });
  assert.equal(started.sameOrigin, true);
  assert.equal(started.authHost, `127.0.0.1:${srv.port}`);
  assert.equal(started.issuer, srv.origin);
  const authUrl = new URL(started.authorizeUrl);
  assert.equal(authUrl.searchParams.get('resource'), conn.url);
  const state1 = authUrl.searchParams.get('state');

  // 2. RFC 9207 iss required when authorization_response_iss_parameter_supported is true.
  await assert.rejects(
    finishOAuthFlow('code-1', state1, vault, {}),
    /issuer mismatch/,
  );

  // 3. Valid iss succeeds, sends resource, and stores clientSecret in Vault (never plaintext on oauth).
  const started2 = await startOAuthFlow(conn, 'http://127.0.0.1:8799/oauth/callback');
  const state2 = new URL(started2.authorizeUrl).searchParams.get('state');
  const finished = await finishOAuthFlow('code-2', state2, vault, { iss: srv.origin });
  assert.equal(tokenBodies.at(-1).resource, conn.url);
  assert.equal(tokenBodies.at(-1).client_secret, 'super-secret-client');
  assert.equal(finished.oauth.clientSecret, null);
  assert.match(finished.oauth.grantId, /^[0-9a-f-]{36}$/i);
  const tag = finished.oauth.grantId.slice(0, 8);
  assert.equal(finished.oauth.boundOrigin, srv.origin);
  assert.equal(finished.oauth.ttlMs, 3_600_000);
  assert.ok(Number.isFinite(finished.oauth.issuedAt));
  assert.equal(finished.oauth.clientSecretVaultKey, `__oauth_client_secret_hardened_1_${tag}`);
  assert.equal(finished.oauth.accessTokenVaultKey, `__oauth_access_hardened_1_${tag}`);
  assert.equal(finished.oauth.refreshTokenVaultKey, `__oauth_refresh_hardened_1_${tag}`);
  assert.equal(finished.oauth.issuer, srv.origin);
  assert.equal(await vault.get(finished.oauth.clientSecretVaultKey), 'super-secret-client');
  assert.equal(await vault.get(finished.oauth.accessTokenVaultKey), 'tok-1');

  // 4. Single-flight deduplication on concurrent refreshOAuthToken calls (G4a-04).
  const signedConn = { ...conn, oauth: finished.oauth };
  tokenReply = () => ({ status: 200, body: { access_token: 'tok-2', refresh_token: 'ref-2', expires_in: 3600 } });
  const [r1, r2, r3] = await Promise.all([
    refreshOAuthToken(signedConn, vault),
    refreshOAuthToken(signedConn, vault),
    refreshOAuthToken(signedConn, vault),
  ]);
  assert.equal(refreshCount, 1);
  assert.equal(r1.grantId, finished.oauth.grantId);
  assert.equal(r1.boundOrigin, srv.origin);
  assert.equal(r1.accessTokenVaultKey, `__oauth_access_hardened_1_${tag}`);
  assert.deepEqual(r2, r1);
  assert.deepEqual(r3, r1);
  assert.equal(tokenBodies.at(-1).client_secret, 'super-secret-client');
  assert.equal(await vault.get(r1.accessTokenVaultKey), 'tok-2');
  assert.equal(await vault.get(r1.refreshTokenVaultKey), 'ref-2');

  // 5. invalid_grant clears dead refresh token and invokes onRevoked without throwing.
  let revokedReason = null;
  tokenReply = () => ({ status: 400, body: { error: 'invalid_grant' } });
  assert.equal(
    await refreshOAuthToken(signedConn, vault, { onRevoked: (err) => { revokedReason = err; } }),
    null,
  );
  assert.equal(revokedReason, 'invalid_grant');
  assert.equal(await vault.get(r1.refreshTokenVaultKey), null);

  // 6. Malformed token responses rejected (G4a-17).
  for (const badBody of [
    { access_token: 12345 },
    { access_token: { nested: true } },
    { access_token: 'A'.repeat(70_000) },
    { access_token: 'ok-token', refresh_token: 'R'.repeat(70_000) },
  ]) {
    tokenReply = () => ({ status: 200, body: badBody });
    const s = await startOAuthFlow(conn, 'http://127.0.0.1:8799/oauth/callback');
    const st = new URL(s.authorizeUrl).searchParams.get('state');
    await assert.rejects(finishOAuthFlow('code-bad', st, vault, { iss: srv.origin }), /invalid (access|refresh)_token/i);
  }

  // 7. Discovery guards: mismatched issuer, mismatched prm.resource, javascript: endpoint, cross-port loopback.
  metaOverride = (o) => ({ issuer: 'https://impostor.dev', authorization_endpoint: `${o}/authorize`, token_endpoint: `${o}/token` });
  await assert.rejects(discoverOAuth(conn.url), /issuer does not match/);

  metaOverride = (o) => ({ issuer: o, authorization_endpoint: 'javascript:alert(1)', token_endpoint: `${o}/token` });
  await assert.rejects(discoverOAuth(conn.url), /secure \(https\)/);

  metaOverride = (o) => ({ issuer: o, authorization_endpoint: `${o}/authorize`, token_endpoint: 'http://127.0.0.1:59999/internal/admin' });
  await assert.rejects(discoverOAuth(conn.url), /own origin/);

  metaOverride = null;
  prmOverride = () => ({ resource: 'https://victim.dev/mcp', authorization_servers: [srv.origin] });
  await assert.rejects(
    discoverOAuth(conn.url, { wwwAuthenticate: `Bearer resource_metadata="${srv.origin}/custom/prm"` }),
    /resource does not match/,
  );
});

test('G4b-07 & G4a-03: createPersonalFetch enforces 4 MiB default byte cap, headers/idle timeouts, SSE streaming, and grant-scoped OAuth validation', async (t) => {
  setEnv(t, 'LOOP_TRUSTED_MCP_ORIGINS', undefined);
  assert.equal(MAX_UPSTREAM_RESPONSE_BYTES, 4 * 1024 * 1024);
  assert.equal(DEFAULT_UPSTREAM_TIMEOUT_MS, 30_000);

  // 1. Grant-scoped stored OAuth validation
  const grantId = '12345678-aaaa-4bbb-8ccc-1234567890ab';
  assert.doesNotThrow(() => assertPersonalStoredOAuth({
    id: 'linear',
    url: 'https://mcp.linear.app/mcp',
    oauth: {
      grantId,
      boundOrigin: 'https://mcp.linear.app',
      issuedAt: Date.now(),
      ttlMs: 3600_000,
      clientId: 'cid',
      clientSecret: null,
      clientSecretVaultKey: '__oauth_client_secret_linear_12345678',
      tokenEndpoint: 'https://mcp.linear.app/token',
      accessTokenVaultKey: '__oauth_access_linear_12345678',
      refreshTokenVaultKey: '__oauth_refresh_linear_12345678',
      expiresAt: Date.now() + 3600_000,
    },
  }));
  // Mismatched boundOrigin or mismatched grant tag rejected
  assert.throws(() => assertPersonalStoredOAuth({
    id: 'linear',
    url: 'https://mcp.linear.app/mcp',
    oauth: {
      grantId,
      boundOrigin: 'https://mcp.other.dev',
      clientId: 'cid',
      tokenEndpoint: 'https://mcp.linear.app/token',
      accessTokenVaultKey: '__oauth_access_linear_12345678',
    },
  }), /sign-in record/);
  assert.throws(() => assertPersonalStoredOAuth({
    id: 'linear',
    url: 'https://mcp.linear.app/mcp',
    oauth: {
      grantId,
      boundOrigin: 'https://mcp.linear.app',
      clientId: 'cid',
      tokenEndpoint: 'https://mcp.linear.app/token',
      accessTokenVaultKey: '__oauth_access_linear_deadbeef',
    },
  }), /sign-in record/);

  // 2. createPersonalFetch byte cap (Content-Length & streaming) + timeouts + SSE preservation
  let scenario = 'ok';
  let abortCount = 0;
  const mocked = t.mock.method(https, 'request', (url, opts, receive) => {
    const req = new EventEmitter();
    opts.signal?.addEventListener('abort', () => {
      abortCount += 1;
    });
    req.end = () => {
      if (scenario === 'stall-headers') {
        // Never invoke receive(): simulates slowloris / dead upstream
        return;
      }
      queueMicrotask(() => {
        if (scenario === 'big-header') {
          const res = new PassThrough();
          Object.assign(res, {
            statusCode: 200,
            rawHeaders: ['content-type', 'application/json', 'content-length', String(2048)],
          });
          receive(res);
          res.end('x'.repeat(2048));
          return;
        }
        if (scenario === 'big-stream') {
          const res = new PassThrough();
          Object.assign(res, { statusCode: 200, rawHeaders: ['content-type', 'application/json'] });
          receive(res);
          res.write('A'.repeat(600));
          res.end('B'.repeat(600));
          return;
        }
        if (scenario === 'stall-body') {
          const res = new PassThrough();
          Object.assign(res, { statusCode: 200, rawHeaders: ['content-type', 'application/json'] });
          receive(res);
          res.write('{"partial":');
          // Leave open indefinitely without ending
          return;
        }
        if (scenario === 'sse-live') {
          const res = new PassThrough();
          Object.assign(res, { statusCode: 200, rawHeaders: ['content-type', 'text/event-stream'] });
          receive(res);
          res.write('event: msg\ndata: 1\n\n');
          setTimeout(() => {
            res.write('event: msg\ndata: 2\n\n');
            res.end();
          }, 40);
          return;
        }
        if (scenario === 'sse-stall') {
          const res = new PassThrough();
          Object.assign(res, { statusCode: 200, rawHeaders: ['content-type', 'text/event-stream'] });
          receive(res);
          res.write('event: msg\ndata: 1\n\n');
          // Stall afterwards
          return;
        }
      });
    };
    return req;
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });

  const boundedFetch = createPersonalFetch('https://mcp.linear.app', {
    maxResponseBytes: 1024,
    timeoutMs: 80,
    sseIdleTimeoutMs: 120,
  });

  // Content-Length > maxResponseBytes rejected immediately
  scenario = 'big-header';
  await assert.rejects(boundedFetch('https://mcp.linear.app/mcp'), /maximum allowed size/);

  // Streaming body > maxResponseBytes aborted mid-stream
  scenario = 'big-stream';
  const bigStreamRes = await boundedFetch('https://mcp.linear.app/mcp');
  await assert.rejects(bigStreamRes.text(), /maximum allowed size/);

  // A real upstream socket keeps Node alive for the unref'ed deadline timers.
  // The in-memory request has no socket. Give it a bounded stand-in that cannot
  // resolve a request or satisfy any of the timeout/abort assertions below.
  const mockSocketLifetime = setTimeout(() => {}, 5000);
  t.after(() => clearTimeout(mockSocketLifetime));

  // Stalled headers aborts after timeoutMs
  scenario = 'stall-headers';
  const abortsBeforeHeaders = abortCount;
  await assert.rejects(boundedFetch('https://mcp.linear.app/mcp'), /timed out/i);
  assert.ok(abortCount > abortsBeforeHeaders, 'timed-out header request must abort signal');

  // Stalled body aborts after idle timeoutMs
  scenario = 'stall-body';
  const abortsBeforeBody = abortCount;
  const stalledRes = await boundedFetch('https://mcp.linear.app/mcp');
  await assert.rejects(stalledRes.text(), /timed out/i);
  assert.ok(abortCount > abortsBeforeBody, 'stalled body must abort underlying request');

  // Healthy SSE stream preserves chunk-by-chunk streaming when events arrive within sseIdleTimeoutMs
  scenario = 'sse-live';
  const sseRes = await boundedFetch('https://mcp.linear.app/sse');
  const sseText = await sseRes.text();
  assert.match(sseText, /data: 1/);
  assert.match(sseText, /data: 2/);

  // Stalled SSE stream aborts after sseIdleTimeoutMs
  scenario = 'sse-stall';
  const sseStallRes = await boundedFetch('https://mcp.linear.app/sse');
  await assert.rejects(sseStallRes.text(), /timed out/i);
});
