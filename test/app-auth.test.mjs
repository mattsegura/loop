import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LoopStore } from '../lib/store.mjs';
import { startServer } from '../server.mjs';

const frontendApi = 'https://loop-test.clerk.accounts.dev';
const publishableKey = 'fixture';
const legacyPassword = 'fixture-original-password';
const vaultPassword = 'fixture-vault-password';
const clerkApp = {
  publishableKey,
  frontendApi,
  async verifyRequest(req, port) {
    assert.equal(req.headers.host, `127.0.0.1:${port}`);
    const userId = req.headers['x-fixture-auth'];
    if (userId !== 'user_A' && userId !== 'user_B') return null;
    // Both subjects present the same fixture session ID so the workspace must be keyed by subject.
    return { userId, sessionId: 'sess_A', issuer: frontendApi, expiresAt: Date.now() + 60000 };
  },
};

async function isolatedData(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'loop-app-auth-'));
  const servers = [];
  t.after(async () => {
    try {
      await Promise.all(servers.map((server) => server.close()));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  return {
    dataDir,
    async start(options = { clerkApp }) {
      const server = await startServer({ port: 0, dataDir, detectLocalAgents: false, ...options });
      servers.push(server);
      return server;
    },
  };
}

async function request(server, route, { user, cookie, body, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const headers = {};
  if (user) headers['X-Fixture-Auth'] = user;
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
  const json = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : undefined;
  if (json === undefined) await response.body?.cancel();
  return { status: response.status, headers: response.headers, json, route };
}

function expectStatus(response, status) {
  assert.equal(response.status, status, `${response.route}: ${JSON.stringify(response.json)}`);
  return response.json;
}

async function status(server, options) {
  return expectStatus(await request(server, '/api/auth/status', options), 200);
}

async function setupLegacy(server) {
  const setup = await request(server, '/api/auth/setup', { body: { password: legacyPassword } });
  expectStatus(setup, 200);
  const cookie = setup.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'local-test setup should issue a local cookie');
  return cookie;
}

async function categoryIds(server, options) {
  const overview = expectStatus(await request(server, '/api/overview', options), 200);
  return overview.categories.map(({ id }) => id);
}

async function addCategory(server, options, label, id) {
  const created = expectStatus(await request(server, '/api/categories', { ...options, body: { label } }), 201);
  assert.equal(created.category.id, id);
}

function assertNoSession(response) {
  assert.deepEqual(response.headers.getSetCookie(), [], `${response.route} must not set a session cookie`);
  assert.notEqual(response.json?.signedIn, true);
}

test('Clerk status is public, but dashboard data, private events, and retired auth routes do not grant sessions', async (t) => {
  const fixture = await isolatedData(t);
  const server = await fixture.start();
  const anonymous = await status(server);
  assert.equal(anonymous.mode, 'clerk');
  assert.equal(anonymous.signedIn, false);
  assert.equal(anonymous.publishableKey, publishableKey);
  assert.equal(anonymous.frontendApi, frontendApi);
  assert.equal(anonymous.userId, undefined);
  assert.equal(anonymous.workspace, undefined);
  expectStatus(await request(server, '/api/overview'), 401);
  expectStatus(await request(server, '/events'), 401);
  assert.equal((await status(server, { user: 'unrecognized' })).signedIn, false);

  const signedIn = await status(server, { user: 'user_A' });
  assert.equal(signedIn.mode, 'clerk');
  assert.equal(signedIn.signedIn, true);
  assert.equal(signedIn.userId, 'user_A');

  for (const user of [undefined, 'user_A']) {
    for (const route of ['/api/auth/setup', '/api/auth/login', '/api/auth/clerk/link']) {
      const response = await request(server, route, { user, body: { password: legacyPassword } });
      expectStatus(response, 404);
      assertNoSession(response);
    }
  }
  assert.equal((await status(server)).signedIn, false);
  expectStatus(await request(server, '/api/overview'), 401);
});

test('personal Clerk workspaces isolate categories, vault metadata, profiles, and settings from one another and root', async (t) => {
  const fixture = await isolatedData(t);
  const server = await fixture.start();
  const a = { user: 'user_A' };
  const b = { user: 'user_B' };

  await addCategory(server, a, 'Fixture Category Alpha', 'fixture-category-alpha');
  await addCategory(server, b, 'Fixture Category Beta', 'fixture-category-beta');
  const note = { key: 'FIXTURE_ALPHA_NOTE', value: 'example note text', description: 'Alpha note metadata', type: 'note' };
  expectStatus(await request(server, '/api/vault', { ...a, body: note }), 201);

  const aCategories = await categoryIds(server, a);
  const bCategories = await categoryIds(server, b);
  assert.ok(aCategories.includes('fixture-category-alpha'));
  assert.ok(!aCategories.includes('fixture-category-beta'));
  assert.ok(bCategories.includes('fixture-category-beta'));
  assert.ok(!bCategories.includes('fixture-category-alpha'));

  const aVault = expectStatus(await request(server, '/api/vault', a), 200);
  const aNote = aVault.secrets.find(({ key }) => key === note.key);
  assert.equal(aNote?.type, 'note');
  assert.equal(aNote?.description, note.description);
  assert.equal(aNote?.value, undefined);
  assert.deepEqual(expectStatus(await request(server, '/api/vault', b), 200).secrets, []);
  const categoryFiles = (await readdir(fixture.dataDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name === 'categories.json');
  const dirs = [];
  for (const id of ['fixture-category-alpha', 'fixture-category-beta']) {
    const matches = [];
    for (const { name, parentPath } of categoryFiles) {
      if ((await readFile(path.join(parentPath, name), 'utf8')).includes(id)) matches.push(parentPath);
    }
    assert.equal(matches.length, 1, `${id} belongs to exactly one data dir`);
    dirs.push(matches[0]);
  }
  assert.notEqual(dirs[0], dirs[1]);
  await server.close();

  // Profiles are derived from saved connections. Seed disabled definitions while
  // the server is stopped so listing and changing settings never contacts an upstream.
  const workspaces = [[a, 'fixture-alpha', dirs[0]], [b, 'fixture-beta', dirs[1]]];
  for (const [, profile, dir] of workspaces) {
    await new LoopStore(dir).add({
      name: profile, transport: 'http', url: 'https://mcp.example.invalid/', enabled: false, profiles: [profile],
    });
  }
  const restarted = await fixture.start();
  for (const [identity, profile] of workspaces) {
    expectStatus(await request(restarted, '/api/settings', {
      ...identity, method: 'PATCH', body: { defaultProfile: profile },
    }), 200);
  }
  for (const [identity, profile] of workspaces) {
    const { settings, profiles } = expectStatus(await request(restarted, '/api/settings', identity), 200);
    assert.deepEqual(profiles, ['all', profile]);
    assert.equal(settings.defaultProfile, profile);
  }
  await restarted.close();
});

test('personal users cannot discover local imports or reach unscoped MCP without an agent token', async (t) => {
  const fixture = await isolatedData(t);
  const server = await fixture.start();
  // user_A claims the local Mac workspace; user_B gets an isolated personal workspace
  await status(server, { user: 'user_A' });
  const identity = { user: 'user_B' };
  expectStatus(await request(server, '/api/import/sources', identity), 403);
  expectStatus(await request(server, '/api/import/sources', { ...identity, body: { keys: ['fixture'] } }), 403);
  const body = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'auth-fixture', version: '1' } },
  };
  for (const caller of [{}, identity]) {
    const response = await request(server, '/mcp', { ...caller, body });
    expectStatus(response, 401);
    assert.equal(response.headers.get('mcp-session-id'), null);
  }
});

test('password-protected Mac workspace requires the original Loop password to claim and survives restart', async (t) => {
  const fixture = await isolatedData(t);
  const legacy = await fixture.start({ authMode: 'local-test' });
  const cookie = await setupLegacy(legacy);
  const originalId = 'fixture-original-category';
  await addCategory(legacy, { cookie }, 'Fixture Original Category', originalId);
  assert.ok((await categoryIds(legacy, { cookie })).includes(originalId));
  await legacy.close();

  const server = await fixture.start();
  const a = { user: 'user_A' };
  const b = { user: 'user_B' };
  // Neither user auto-claims a password-protected Mac workspace without giving the original password.
  assert.ok(!(await categoryIds(server, a)).includes(originalId));
  assert.ok(!(await categoryIds(server, b)).includes(originalId));
  expectStatus(await request(server, '/api/auth/claim-local', { ...b, body: { password: 'wrong-password' } }), 403);
  expectStatus(await request(server, '/api/auth/claim-local', { ...a, body: { password: legacyPassword } }), 200);
  assert.ok((await categoryIds(server, a)).includes(originalId));
  assert.ok(!(await categoryIds(server, b)).includes(originalId));
  await server.close();

  const restarted = await fixture.start();
  assert.ok((await categoryIds(restarted, a)).includes(originalId));
  assert.ok(!(await categoryIds(restarted, b)).includes(originalId));
  const rejected = await request(restarted, '/api/auth/claim-local', { ...b, body: { password: legacyPassword } });
  expectStatus(rejected, 409);
  assert.ok(!(await categoryIds(restarted, b)).includes(originalId));
  assert.ok((await categoryIds(restarted, a)).includes(originalId));
});

test('brand-new passwordless Mac workspace is automatically owned by the first signed-in Clerk user', async (t) => {
  const fixture = await isolatedData(t);
  const server = await fixture.start();
  const a = { user: 'user_A' };
  const b = { user: 'user_B' };
  assert.equal((await status(server, a)).workspace, 'local');
  assert.equal((await status(server, b)).workspace, 'personal');
});

test('setting a vault password requires Clerk and cannot create a dashboard session', async (t) => {
  const fixture = await isolatedData(t);
  const server = await fixture.start();
  const identity = { user: 'user_A' };
  const body = { next: vaultPassword };
  assert.equal((await status(server, identity)).vaultPasswordSet, false);
  expectStatus(await request(server, '/api/auth/vault-password', { body }), 401);
  const setup = await request(server, '/api/auth/vault-password', { ...identity, body });
  expectStatus(setup, 200);
  assertNoSession(setup);
  assert.equal((await status(server, identity)).vaultPasswordSet, true);
  assert.equal((await status(server, { user: 'user_B' })).vaultPasswordSet, false);
  assert.equal((await status(server)).signedIn, false);
  expectStatus(await request(server, '/api/overview'), 401);
});
