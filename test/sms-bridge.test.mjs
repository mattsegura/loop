// loop-text's server-to-server bridge: an agent's own key plus the shared secret lets the
// texting service settle that agent's approvals and keep site logins in the Vault.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { normalizeLoginOrigin, smsBridgeSecretMatches } from '../lib/sms-bridge.mjs';
import { startServer } from '../server.mjs';

const OWNER_PASSWORD = 'sms-bridge-test-pw';
const SECRET = 'loop-text-bridge-secret';

function request(port, route, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method,
        headers: { ...(payload !== null ? { 'Content-Type': 'application/json' } : {}), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      },
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function startLoop(t, smsAgentEnv = { LOOP_TEXT_INTERNAL_SECRET: SECRET }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-sms-bridge-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {}));
  const srv = await startServer({
    port: 0,
    dataDir: dir,
    authMode: 'local-test',
    autoSync: false,
    detectLocalAgents: false,
    smsAgentEnv,
    billingEnv: {},
  });
  t.after(() => srv.close());
  const setup = await request(srv.port, '/api/auth/setup', { method: 'POST', body: { password: OWNER_PASSWORD } });
  assert.equal(setup.status, 200);
  const cookie = String([].concat(setup.headers['set-cookie'])[0] || '').split(';')[0];
  const api = (route, opts = {}) => request(srv.port, route, { ...opts, headers: { Cookie: cookie, ...(opts.headers || {}) } });
  const addAgent = async (name, extra = {}) => {
    const res = await api('/api/agents', { method: 'POST', body: { name, canManage: true, ...extra } });
    assert.equal(res.status, 201);
    return { id: res.json.agent.id, token: res.json.token };
  };
  const bridge = (agent, route, { method = 'POST', body, secret = SECRET, headers = {} } = {}) =>
    request(srv.port, `/api/sms-bridge${route}`, {
      method,
      body,
      headers: {
        ...(agent ? { Authorization: `Bearer ${agent.token}` } : {}),
        ...(secret !== null ? { 'X-Loop-Text-Secret': secret } : {}),
        ...headers,
      },
    });
  let rpcId = 0;
  const save = async (agent, args) => {
    rpcId += 1;
    const res = await request(srv.port, '/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent.token}` },
      body: { jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name: 'loop__save', arguments: args } },
    });
    assert.equal(res.status, 200);
    const text = res.json.result.content[0].text;
    try {
      return { isError: res.json.result.isError === true, parsed: JSON.parse(text) };
    } catch {
      return { isError: res.json.result.isError === true, parsed: text };
    }
  };
  return { dir, port: srv.port, api, addAgent, bridge, save };
}

test('helpers: https origins only, normalized; secret compare', () => {
  assert.equal(normalizeLoginOrigin('https://Example.com:443/login?next=1'), 'https://example.com');
  assert.equal(normalizeLoginOrigin('https://example.com:8443'), 'https://example.com:8443');
  assert.equal(normalizeLoginOrigin('http://example.com'), null);
  assert.equal(normalizeLoginOrigin('https://user:pw@example.com'), null);
  assert.equal(normalizeLoginOrigin('javascript:alert(1)'), null);
  assert.equal(normalizeLoginOrigin(42), null);
  assert.equal(smsBridgeSecretMatches('abc', 'abc'), true);
  assert.equal(smsBridgeSecretMatches('abc', 'abcd'), false);
  assert.equal(smsBridgeSecretMatches('abc', undefined), false);
  assert.equal(smsBridgeSecretMatches(null, ''), false);
});

test('the bridge does not exist when the shared secret is unset', async (t) => {
  const loop = await startLoop(t, {});
  const agent = await loop.addAgent('Texter');
  const res = await loop.bridge(agent, '/vault/logins?origin=https://example.com', { method: 'GET' });
  assert.equal(res.status, 404);
  assert.deepEqual(res.json, { error: 'not_found' });
});

test('every call needs the shared secret and a real agent key, and never comes from a browser', async (t) => {
  const loop = await startLoop(t);
  const agent = await loop.addAgent('Texter');
  const route = '/vault/logins?origin=https://example.com';

  const noSecret = await loop.bridge(agent, route, { method: 'GET', secret: null });
  assert.equal(noSecret.status, 401);
  assert.deepEqual(noSecret.json, { error: 'unauthorized' });

  const badSecret = await loop.bridge(agent, route, { method: 'GET', secret: `${SECRET}x` });
  assert.equal(badSecret.status, 401);
  assert.deepEqual(badSecret.json, { error: 'unauthorized' });

  const noToken = await loop.bridge(null, route, { method: 'GET' });
  assert.equal(noToken.status, 401);

  const unknownToken = await loop.bridge({ token: `loop_${'A'.repeat(43)}` }, route, { method: 'GET' });
  assert.equal(unknownToken.status, 401);
  assert.deepEqual(unknownToken.json, { error: 'unauthorized' });

  // The owner's dashboard cookie is not a way in.
  const cookieOnly = await loop.api(`/api/sms-bridge${route}`, { headers: { 'X-Loop-Text-Secret': SECRET } });
  assert.equal(cookieOnly.status, 401);

  const fromBrowser = await loop.bridge(agent, route, {
    method: 'GET',
    headers: { Origin: `http://127.0.0.1:${loop.port}` },
  });
  assert.equal(fromBrowser.status, 403);
  assert.equal(fromBrowser.headers['access-control-allow-origin'], undefined);

  const disabled = await loop.api(`/api/agents/${agent.id}`, { method: 'PATCH', body: { enabled: false } });
  assert.equal(disabled.status, 200);
  assert.equal((await loop.bridge(agent, route, { method: 'GET' })).status, 401);
});

test('approvals: only the requesting agent can settle its own, once, like the owner tapping Approve or Deny', async (t) => {
  const loop = await startLoop(t);
  const texter = await loop.addAgent('Texter');
  const other = await loop.addAgent('Other');
  assert.equal((await loop.api('/api/policies', { method: 'PATCH', body: { actions: { save: 'always_ask' } } })).status, 200);

  // Saving while the owner asks to approve saves: the bridge does not skip that rule either.
  const blockedSave = await loop.bridge(texter, '/vault/logins', {
    body: { origin: 'https://example.com', username: 'a', password: 'pw-blocked' },
  });
  assert.equal(blockedSave.status, 403);
  assert.deepEqual(blockedSave.json, { error: 'needs_approval' });

  const args = { type: 'api_key', action: 'save', data: { key: 'TEXT_KEY', value: 'value-1' } };
  const paused = await loop.save(texter, args);
  assert.equal(paused.parsed.status, 'approval_required');
  const approvalId = paused.parsed.approvalId;

  // Someone else's approval looks the same as one that does not exist.
  const wrongAgent = await loop.bridge(other, `/approvals/${approvalId}/decide`, { body: { decision: 'approve' } });
  assert.equal(wrongAgent.status, 404);
  assert.deepEqual(wrongAgent.json, { error: 'not_found' });
  assert.equal((await loop.bridge(texter, '/approvals/apr_000000000000/decide', { body: { decision: 'approve' } })).status, 404);
  const badDecision = await loop.bridge(texter, `/approvals/${approvalId}/decide`, { body: { decision: 'always' } });
  assert.equal(badDecision.status, 400);

  // The agent is waiting on its approval; the owner answers by text and the call goes through.
  const waiting = loop.save(texter, { ...args, approvalId, waitForApproval: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const approved = await loop.bridge(texter, `/approvals/${approvalId}/decide`, { body: { decision: 'approve' } });
  assert.equal(approved.status, 200);
  assert.deepEqual(approved.json, { ok: true, status: 'approved' });
  const result = await waiting;
  assert.equal(result.isError, false);
  assert.equal(result.parsed.saved, true);
  assert.equal(result.parsed.key, 'TEXT_KEY');

  const again = await loop.bridge(texter, `/approvals/${approvalId}/decide`, { body: { decision: 'deny' } });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'already_decided');
  assert.ok(['approved', 'consumed'].includes(again.json.status));

  // Plain approve: the owner's rule still asks next time.
  const policies = await loop.api('/api/policies');
  assert.equal(policies.json.policies.actions.save, 'always_ask');

  const deniedArgs = { type: 'api_key', action: 'save', data: { key: 'TEXT_KEY_2', value: 'value-2' } };
  const paused2 = await loop.save(texter, deniedArgs);
  assert.equal(paused2.parsed.status, 'approval_required');
  const denied = await loop.bridge(texter, `/approvals/${paused2.parsed.approvalId}/decide`, { body: { decision: 'deny' } });
  assert.equal(denied.status, 200);
  assert.deepEqual(denied.json, { ok: true, status: 'denied' });
  const afterDeny = await loop.save(texter, { ...deniedArgs, approvalId: paused2.parsed.approvalId });
  assert.notEqual(afterDeny.parsed.saved, true);
  const vault = await loop.api('/api/vault');
  assert.equal(vault.json.secrets.some((s) => s.key === 'TEXT_KEY_2'), false);
  assert.equal((await loop.api('/api/approvals')).json.pending.length, 0);

  const activity = await loop.api('/api/activity?limit=50');
  const byText = activity.json.entries.filter((e) => e.agentName === 'Owner (text)');
  assert.deepEqual(byText.map((e) => e.method).sort(), ['approval/approve', 'approval/deny']);
});

test('logins: save, list and reveal stay bound to one https origin and to the agent they are shared with', async (t) => {
  const loop = await startLoop(t);
  const texter = await loop.addAgent('Texter');
  const other = await loop.addAgent('Other');

  const httpOrigin = await loop.bridge(texter, '/vault/logins', {
    body: { origin: 'http://example.com', username: 'me', password: 'pw-1' },
  });
  assert.equal(httpOrigin.status, 400);
  assert.deepEqual(httpOrigin.json, { error: 'invalid_origin' });
  assert.equal((await loop.bridge(texter, '/vault/logins', { body: { origin: 'https://example.com' } })).status, 400);

  const saved = await loop.bridge(texter, '/vault/logins', {
    body: { origin: 'https://Example.com:443/sign-in', username: 'me@example.com', password: 'pw-first', label: 'Example' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.ok, true);
  assert.equal(saved.json.origin, 'https://example.com');
  assert.equal(saved.json.username, 'me@example.com');
  assert.doesNotMatch(saved.text, /pw-first/);
  const { key } = saved.json;

  // Same site and username: the password changes, no second login appears.
  const updated = await loop.bridge(texter, '/vault/logins', {
    body: { origin: 'https://example.com', username: 'me@example.com', password: 'pw-second' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.key, key);
  const second = await loop.bridge(texter, '/vault/logins', {
    body: { origin: 'https://example.com', username: 'work@example.com', password: 'pw-work' },
  });
  assert.notEqual(second.json.key, key);

  const vault = await loop.api('/api/vault');
  const item = vault.json.secrets.find((s) => s.key === key);
  assert.equal(item.type, 'login');
  assert.equal(item.description, 'Example');
  assert.deepEqual(item.allowedSinks, ['origin:https://example.com']);
  const agents = await loop.api('/api/agents');
  const texterRecord = agents.json.agents.find((a) => a.id === texter.id);
  assert.deepEqual(texterRecord.secrets.sort(), [key, second.json.key].sort());
  assert.deepEqual(agents.json.agents.find((a) => a.id === other.id).secrets, []);

  const listed = await loop.bridge(texter, '/vault/logins?origin=https://example.com', { method: 'GET' });
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.json.logins.sort((a, b) => a.username.localeCompare(b.username)),
    [
      { key, label: 'Example', username: 'me@example.com', origin: 'https://example.com' },
      { key: second.json.key, label: 'Login for example.com', username: 'work@example.com', origin: 'https://example.com' },
    ],
  );
  assert.doesNotMatch(listed.text, /pw-/);
  assert.deepEqual((await loop.bridge(texter, '/vault/logins?origin=https://other.example', { method: 'GET' })).json, { logins: [] });
  assert.deepEqual((await loop.bridge(other, '/vault/logins?origin=https://example.com', { method: 'GET' })).json, { logins: [] });
  assert.equal((await loop.bridge(texter, '/vault/logins?origin=http://example.com', { method: 'GET' })).status, 400);

  // The owner typed these into Loop's own page for this site, so filling them there needs no
  // second OK; the password sits alone in the Vault and the username beside it.
  const savedItem = (await loop.api('/api/vault')).json.secrets.find((s) => s.key === key);
  assert.equal(savedItem.approval, 'auto');
  assert.equal(savedItem.username, 'me@example.com');
  assert.equal(savedItem.category, 'Websites');
  // An owner who turns this login to "always ask" is still asked.
  assert.equal((await loop.api(`/api/vault/${key}`, { method: 'PATCH', body: { approval: 'always_ask' } })).status, 200);
  const asks = await loop.bridge(texter, '/vault/reveal', { body: { key, origin: 'https://example.com' } });
  assert.equal(asks.status, 403);
  assert.deepEqual(asks.json, { error: 'needs_approval' });

  assert.equal((await loop.api(`/api/vault/${key}`, { method: 'PATCH', body: { approval: 'auto' } })).status, 200);
  const revealed = await loop.bridge(texter, '/vault/reveal', { body: { key, origin: 'https://example.com/login' } });
  assert.equal(revealed.status, 200);
  assert.deepEqual(revealed.json, { username: 'me@example.com', password: 'pw-second' });

  const wrongOrigin = await loop.bridge(texter, '/vault/reveal', { body: { key, origin: 'https://evil.example' } });
  assert.equal(wrongOrigin.status, 403);
  assert.deepEqual(wrongOrigin.json, { error: 'origin_mismatch' });
  const subdomain = await loop.bridge(texter, '/vault/reveal', { body: { key, origin: 'https://www.example.com' } });
  assert.equal(subdomain.status, 403);
  assert.equal((await loop.bridge(texter, '/vault/reveal', { body: { key, origin: 'http://example.com' } })).status, 400);

  // Not shared with this agent: it does not exist as far as the agent can tell.
  const notGranted = await loop.bridge(other, '/vault/reveal', { body: { key, origin: 'https://example.com' } });
  assert.equal(notGranted.status, 404);
  assert.deepEqual(notGranted.json, { error: 'not_found' });
  const ownerLogin = await loop.api('/api/vault', {
    method: 'POST',
    body: { key: 'OWNER_LOGIN', value: 'owner-pw', type: 'login', approval: 'auto', allowedSinks: ['https://example.com'] },
  });
  assert.equal(ownerLogin.status, 201);
  assert.equal((await loop.bridge(texter, '/vault/reveal', { body: { key: 'OWNER_LOGIN', origin: 'https://example.com' } })).status, 404);
  assert.equal((await loop.bridge(texter, '/vault/reveal', { body: { key: '__agent_token_texter', origin: 'https://example.com' } })).status, 404);
  const listedAfterOwner = await loop.bridge(texter, '/vault/logins?origin=https://example.com', { method: 'GET' });
  assert.equal(listedAfterOwner.json.logins.some((l) => l.key === 'OWNER_LOGIN'), false);

  // An agent may not overwrite a login the owner has not shared with it.
  const takeover = await loop.bridge(texter, '/vault/logins', { body: { origin: 'https://example.com', password: 'hijack' } });
  assert.equal(takeover.status, 409);
  assert.deepEqual(takeover.json, { error: 'exists_not_shared' });

  // Shared, but only an API key: never revealed as a login.
  assert.equal((await loop.api('/api/vault', {
    method: 'POST',
    body: { key: 'SHARED_API', value: 'sk-123', type: 'api_key', approval: 'auto', allowedSinks: ['https://example.com'] },
  })).status, 201);
  assert.equal((await loop.api(`/api/agents/${texter.id}`, {
    method: 'PATCH',
    body: { secrets: [key, second.json.key, 'SHARED_API'] },
  })).status, 200);
  assert.equal((await loop.bridge(texter, '/vault/reveal', { body: { key: 'SHARED_API', origin: 'https://example.com' } })).status, 404);

  // The item asks every time: no value.
  assert.equal((await loop.api(`/api/vault/${key}`, { method: 'PATCH', body: { approval: 'always_ask' } })).status, 200);
  const alwaysAsk = await loop.bridge(texter, '/vault/reveal', { body: { key, origin: 'https://example.com' } });
  assert.equal(alwaysAsk.status, 403);
  assert.deepEqual(alwaysAsk.json, { error: 'needs_approval' });

  // The log names the key and the site, never a value.
  const activity = await loop.api('/api/activity?limit=100');
  const uses = activity.json.entries.filter((e) => e.method === 'secret/use' && e.agentId === texter.id);
  assert.ok(uses.some((e) => e.ok && e.target === `${key} → https://example.com`));
  assert.ok(uses.some((e) => !e.ok && e.error === 'sink_mismatch'));
  const logText = await readFile(path.join(loop.dir, 'activity.jsonl'), 'utf8');
  assert.doesNotMatch(logText, /pw-first|pw-second|pw-work|owner-pw/);
});

test('logins: one login can work on several https sites', async (t) => {
  const loop = await startLoop(t);
  const texter = await loop.addAgent('Texter');
  const login = (body) => loop.bridge(texter, '/vault/logins', { body: { username: 'me', password: 'pw-multi', ...body } });

  for (const origins of [['http://app.example.com'], ['https://ok.example', 'nope'], 'https://app.example.com',
    Array.from({ length: 11 }, (_, i) => `https://s${i}.example.com`)]) {
    const bad = await login({ origin: 'https://example.com', origins });
    assert.equal(bad.status, 400, JSON.stringify(origins));
    assert.deepEqual(bad.json, { error: 'invalid_origin' });
  }

  const saved = await login({ origin: 'https://example.com', origins: ['https://App.example.com/dash', 'https://example.com', 'https://app.example.com'] });
  assert.equal(saved.status, 200);
  assert.deepEqual(Object.keys(saved.json).sort(), ['key', 'ok', 'origin', 'username']);
  assert.equal(saved.json.origin, 'https://example.com');
  const meta = async () => (await loop.api('/api/vault')).json.secrets.find((s) => s.key === saved.json.key);
  assert.deepEqual((await meta()).allowedSinks, ['origin:https://example.com', 'origin:https://app.example.com']);
  assert.equal((await meta()).category, 'Websites');

  const onApp = await loop.bridge(texter, '/vault/logins?origin=https://app.example.com', { method: 'GET' });
  assert.deepEqual(onApp.json.logins, [{ key: saved.json.key, label: 'Login for example.com', username: 'me', origin: 'https://app.example.com' }]);
  assert.equal((await loop.api(`/api/vault/${saved.json.key}`, { method: 'PATCH', body: { approval: 'auto' } })).status, 200);
  const revealed = await loop.bridge(texter, '/vault/reveal', { body: { key: saved.json.key, origin: 'https://app.example.com' } });
  assert.deepEqual(revealed.json, { username: 'me', password: 'pw-multi' });

  // Updating the same site and username replaces the list of sites.
  const updated = await login({ origin: 'https://example.com', origins: ['https://admin.example.com'], password: 'pw-multi-2' });
  assert.equal(updated.json.key, saved.json.key);
  assert.deepEqual((await meta()).allowedSinks, ['origin:https://example.com', 'origin:https://admin.example.com']);
  const dropped = await loop.bridge(texter, '/vault/reveal', { body: { key: saved.json.key, origin: 'https://app.example.com' } });
  assert.equal(dropped.status, 403);
  assert.deepEqual(dropped.json, { error: 'origin_mismatch' });
});

test('a profile-scoped agent saves into its own profile', async (t) => {
  const loop = await startLoop(t);
  const created = await loop.api('/api/profiles', { method: 'POST', body: { name: 'Home' } });
  assert.ok(created.status === 200 || created.status === 201, created.text);
  const profileId = created.json.profile?.id || 'home';
  const texter = await loop.addAgent('Texter', { profile: profileId });
  const saved = await loop.bridge(texter, '/vault/logins', {
    body: { origin: 'https://example.com', username: 'me', password: 'pw-home' },
  });
  assert.equal(saved.status, 200);
  const vault = await loop.api('/api/vault');
  assert.deepEqual(vault.json.secrets.find((s) => s.key === saved.json.key).profiles, [profileId]);
});

test('hosted: each agent key reaches its own account, exactly as /mcp routes it', async (t) => {
  const HOST = 'bridge.hosted.dev';
  const ISSUER = 'https://bridge-test.clerk.accounts.dev';
  const prev = process.env.LOOP_HUB_ALLOWED_HOSTS;
  process.env.LOOP_HUB_ALLOWED_HOSTS = HOST;
  t.after(() => {
    if (prev === undefined) delete process.env.LOOP_HUB_ALLOWED_HOSTS;
    else process.env.LOOP_HUB_ALLOWED_HOSTS = prev;
  });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'loop-sms-bridge-hosted-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {}));
  const clerkApp = {
    publishableKey: 'pk_test_bridge_fixture',
    frontendApi: ISSUER,
    async verifyRequest(req) {
      const userId = req.headers['x-fixture-auth'];
      if (!['alice', 'bob'].includes(userId)) return null;
      return { userId, sessionId: `sess_${userId}`, issuer: ISSUER, expiresAt: Date.now() + 60_000 };
    },
  };
  const srv = await startServer({
    port: 0, dataDir, detectLocalAgents: false, hosted: true, clerkApp,
    smsAgentEnv: { LOOP_TEXT_INTERNAL_SECRET: SECRET }, billingEnv: {},
  });
  t.after(() => srv.close());
  const call = (route, opts = {}) => request(srv.port, route, { ...opts, headers: { Host: HOST, ...(opts.headers || {}) } });
  const agentFor = async (user) => {
    const res = await call('/api/agents', { method: 'POST', body: { name: 'Texter' }, headers: { 'X-Fixture-Auth': user } });
    assert.equal(res.status, 201, res.text);
    return res.json.token;
  };
  const alice = await agentFor('alice');
  const bob = await agentFor('bob');
  const bridge = (token, route, opts = {}) => call(`/api/sms-bridge${route}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'X-Loop-Text-Secret': SECRET },
  });

  const saved = await bridge(alice, '/vault/logins', {
    method: 'POST',
    body: { origin: 'https://example.com', username: 'alice', password: 'pw-alice' },
  });
  assert.equal(saved.status, 200, saved.text);
  const aliceList = await bridge(alice, '/vault/logins?origin=https://example.com');
  assert.deepEqual(aliceList.json.logins.map((l) => l.username), ['alice']);
  const bobList = await bridge(bob, '/vault/logins?origin=https://example.com');
  assert.equal(bobList.status, 200);
  assert.deepEqual(bobList.json.logins, []);
  const bobReveal = await bridge(bob, '/vault/reveal', { method: 'POST', body: { key: saved.json.key, origin: 'https://example.com' } });
  assert.equal(bobReveal.status, 404);
  assert.equal((await bridge(`loop_${'A'.repeat(43)}`, '/vault/logins?origin=https://example.com')).status, 401);
});
