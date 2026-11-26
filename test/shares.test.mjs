import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hashAgentToken } from '../lib/agents.mjs';
import { startServer } from '../server.mjs';
import { ShareStore, TokenRouter, shareCodeFromPath } from '../lib/shares.mjs';

const HOST = 'share.hosted.dev';
const ISSUER = 'https://share-test.clerk.accounts.dev';

function fakeClerk(users) {
  return {
    publishableKey: 'pk_test_share_fixture',
    frontendApi: ISSUER,
    async verifyRequest(req) {
      const userId = req.headers['x-fixture-auth'];
      if (!users.includes(userId)) return null;
      return { userId, sessionId: `sess_${userId}`, issuer: ISSUER, expiresAt: Date.now() + 60_000 };
    },
  };
}

function request(port, route, { method, user, body, headers = {} } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: route,
      method: method || (payload === null ? 'GET' : 'POST'),
      headers: {
        Host: HOST,
        ...(payload !== null ? { 'Content-Type': 'application/json' } : {}),
        ...(user ? { 'X-Fixture-Auth': user } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function hosted(t) {
  const prev = process.env.LOOP_HUB_ALLOWED_HOSTS;
  process.env.LOOP_HUB_ALLOWED_HOSTS = HOST;
  t.after(() => {
    if (prev === undefined) delete process.env.LOOP_HUB_ALLOWED_HOSTS;
    else process.env.LOOP_HUB_ALLOWED_HOSTS = prev;
  });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'loop-shares-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const srv = await startServer({
    port: 0, dataDir, detectLocalAgents: false, hosted: true, clerkApp: fakeClerk(['owner', 'friend']),
  });
  t.after(() => srv.close());
  const mcp = (token, method = 'initialize', params = {}) => request(srv.port, '/mcp', {
    method: 'POST',
    headers: { Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: {
      jsonrpc: '2.0', id: 1, method,
      params: method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } : params,
    },
  });
  return { port: srv.port, dataDir, mcp };
}

test('share codes only match /j/<code>', () => {
  assert.equal(shareCodeFromPath('/j/abcDEF123456'), 'abcDEF123456');
  assert.equal(shareCodeFromPath('/j/short'), null);
  assert.equal(shareCodeFromPath('/j/abc..def/../x'), null);
  assert.equal(shareCodeFromPath('/x/abcDEF123456'), null);
});

test('ShareStore keeps one live link per profile and kind, and refuses Default', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-sharestore-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ws = 'a'.repeat(64);
  const store = new ShareStore(dir);
  const a = await store.linkFor({ workspaceId: ws, profile: 'video', kind: 'other', ownerName: 'Matt' });
  const b = await store.linkFor({ workspaceId: ws, profile: 'video', kind: 'other' });
  const c = await store.linkFor({ workspaceId: ws, profile: 'video', kind: 'me' });
  assert.equal(a.code, b.code);
  assert.notEqual(a.code, c.code);
  await assert.rejects(store.linkFor({ workspaceId: ws, profile: 'all', kind: 'other' }), /Default is never shared/);
  await assert.rejects(store.linkFor({ workspaceId: ws, profile: 'video', kind: 'boss' }), /kind/);
  assert.equal(await store.revokeLink('b'.repeat(64), a.code), false, 'only the owner revokes');
  assert.equal(await store.revokeLink(ws, a.code), true);
  assert.equal(await store.getLink(a.code), null);
  const reloaded = new ShareStore(dir);
  assert.ok(await reloaded.getLink(c.code), 'links persist across restarts');
});

test('TokenRouter ignores malformed tokens', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-router-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const router = new TokenRouter(dir);
  assert.equal(await router.resolve('nope'), null);
  assert.equal(await router.resolve(`loop_${'x'.repeat(43)}`), null);
});

test('a disabled OAuth grant can still be revoked after a restart', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-revoke-disabled-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ws = 'a'.repeat(64);
  const token = `loop_${'x'.repeat(43)}`;
  await mkdir(path.join(dir, ws));
  await writeFile(path.join(dir, ws, 'config.json'), JSON.stringify({
    agents: [{ enabled: false, oauthClientId: 'fixture-client', tokenHashes: [hashAgentToken(token)] }],
  }));
  const router = new TokenRouter(dir);
  assert.equal(await router.resolve(token), null);
  assert.equal(await router.resolve(token, { includeDisabledOAuth: true }), ws);
});

test('hosted: share a profile with someone else, they join, use it, and get removed', async (t) => {
  const { port, mcp } = await hosted(t);
  const owner = (route, opts = {}) => request(port, route, { ...opts, user: 'owner' });
  const friend = (route, opts = {}) => request(port, route, { ...opts, user: 'friend' });

  const created = await owner('/api/profiles', { body: { name: 'Video research' } });
  assert.equal(created.status, 201, created.text);
  const profileId = created.json.profile.id;
  await owner('/api/profiles', { body: { name: 'Secret stuff' } });

  const def = await owner('/api/shares', { body: { profile: 'all', kind: 'other' } });
  assert.equal(def.status, 400);

  const link = await owner('/api/shares', { body: { profile: profileId, kind: 'other', ownerName: 'Matt' } });
  assert.equal(link.status, 200, link.text);
  assert.match(link.json.url, /\/j\/[A-Za-z0-9]+$/);
  const again = await owner('/api/shares', { body: { profile: profileId, kind: 'other' } });
  assert.equal(again.json.code, link.json.code);
  const code = link.json.code;

  // Anyone can preview the invite; nothing about other profiles leaks.
  const preview = await request(port, `/api/join/${code}`);
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.json.ownerName, 'Matt');
  assert.equal(preview.json.profile.name, 'Video research');
  assert.equal(preview.json.signedIn, false);
  assert.ok(!preview.text.includes('Secret stuff'));

  // Signing in is required to get a key.
  const anon = await request(port, `/api/join/${code}/agents`, { body: { kind: 'claude' } });
  assert.equal(anon.status, 401);

  const minted = await friend(`/api/join/${code}/agents`, { body: { kind: 'claude', name: 'Luke', email: 'luke@example.com' } });
  assert.equal(minted.status, 201, minted.text);
  assert.match(minted.json.token, /^loop_[A-Za-z0-9_-]{43}$/);
  assert.equal(minted.json.agentName, 'Luke · Claude Code');

  const before = await friend(`/api/join/${code}/agents/${minted.json.agentId}`);
  assert.equal(before.status, 200);
  assert.equal(before.json.connected, false);

  // Plain /mcp routes the member's key to the owner's workspace.
  const init = await mcp(minted.json.token);
  assert.equal(init.status, 200, init.text);

  const after = await friend(`/api/join/${code}/agents/${minted.json.agentId}`);
  assert.equal(after.json.connected, true);

  // The owner cannot be impersonated: someone else's status probe is refused.
  const nosy = await owner(`/api/join/${code}/agents/does_not_exist`);
  assert.equal(nosy.status, 404);

  // The member's agent is scoped to the shared profile and cannot manage anything.
  const agents = await owner('/api/agents');
  const agent = agents.json.agents.find((a) => a.id === minted.json.agentId);
  assert.equal(agent.profile, profileId);
  assert.equal(agent.canManage, false);

  // The friend's own workspace stays separate: they do not see the owner's profiles.
  const friendProfiles = await friend('/api/profiles');
  assert.ok(!JSON.stringify(friendProfiles.json).includes('Video research'));
  const withMe = await friend('/api/shares/with-me');
  assert.equal(withMe.json.shared.length, 1);
  assert.equal(withMe.json.shared[0].profile, 'Video research');

  const members = await owner(`/api/shares/profiles/${profileId}/members`);
  assert.equal(members.json.members.length, 1);
  assert.equal(members.json.members[0].name, 'Luke');
  assert.deepEqual(members.json.members[0].agents, ['Luke · Claude Code']);

  // A "me" link only works for the owner.
  const meLink = await owner('/api/shares', { body: { profile: profileId, kind: 'me' } });
  const notMe = await friend(`/api/join/${meLink.json.code}/agents`, { body: { kind: 'codex' } });
  assert.equal(notMe.status, 403);
  const mine = await owner(`/api/join/${meLink.json.code}/agents`, { body: { kind: 'codex' } });
  assert.equal(mine.status, 201, mine.text);
  assert.equal((await mcp(mine.json.token)).status, 200);

  // Removing the member revokes their keys immediately.
  const removed = await owner(`/api/shares/members/${members.json.members[0].id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.agentsRevoked, 1);
  assert.equal((await mcp(minted.json.token)).status, 401);

  // Unknown keys on plain /mcp get the normal sign-in challenge.
  const bogus = await mcp(`loop_${'A'.repeat(43)}`);
  assert.equal(bogus.status, 401);
  assert.ok(bogus.headers['www-authenticate']);
});

test('hosted: signed-out "/" shows the landing page and /j/<code> shows the invite page', async (t) => {
  const { port } = await hosted(t);
  const landing = await request(port, '/');
  assert.equal(landing.status, 200);
  assert.match(landing.text, /id="handoff"/);
  const app = await request(port, '/', { headers: { Cookie: '__client_uat=1795282591' } });
  assert.match(app.text, /Loading Loop/);
  const signedOutCookie = await request(port, '/', { headers: { Cookie: '__client_uat=0' } });
  assert.match(signedOutCookie.text, /id="handoff"/);
  const withQuery = await request(port, '/?loop-auth=sign-in');
  assert.match(withQuery.text, /Loading Loop/);
  const join = await request(port, '/j/abcDEF123456');
  assert.equal(join.status, 200);
  assert.match(join.text, /join\.js/);
  assert.match(String(join.headers['content-security-policy'] || ''), /script-src 'self'/);
});

test('hosted: an agent added with plain /mcp signs in with OAuth and lands in the approving account', async (t) => {
  const { port, mcp } = await hosted(t);
  const { createHash, randomBytes } = await import('node:crypto');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const reg = await request(port, '/oauth/register', {
    body: { client_name: 'Claude Code (loop)', redirect_uris: ['http://localhost:53682/callback'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' },
  });
  assert.equal(reg.status, 201, reg.text);
  const q = new URLSearchParams({
    response_type: 'code', client_id: reg.json.client_id, redirect_uri: 'http://localhost:53682/callback',
    code_challenge: challenge, code_challenge_method: 'S256', state: 's1', scope: 'mcp:tools', resource: `https://${HOST}/mcp`,
  });
  const auth = await request(port, `/oauth/authorize?${q}`);
  assert.equal(auth.status, 302, auth.text);
  const txId = new URL(auth.headers.location, `https://${HOST}`).searchParams.get('loop-oauth');
  assert.ok(txId);
  const pending = await request(port, `/api/oauth/requests/${txId}`, { user: 'owner' });
  assert.equal(pending.status, 200, pending.text);
  assert.equal(pending.json.canApprove, true);
  const approved = await request(port, `/api/oauth/requests/${txId}/approve`, { user: 'owner', body: {} });
  assert.equal(approved.status, 200, approved.text);
  const code = new URL(approved.json.redirectUrl).searchParams.get('code');
  const tok = await request(port, '/oauth/token', {
    body: { grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:53682/callback', client_id: reg.json.client_id, code_verifier: verifier, resource: `https://${HOST}/mcp` },
  });
  assert.equal(tok.status, 200, tok.text);
  assert.equal((await mcp(tok.json.access_token)).status, 200);
  const agents = await request(port, '/api/agents', { user: 'owner' });
  assert.ok(agents.json.agents.some((a) => a.name.startsWith('Claude Code')), 'the agent is created in the approving account');
  const friendAgents = await request(port, '/api/agents', { user: 'friend' });
  assert.equal(friendAgents.json.agents.length, 0);
  const revocation = { token: tok.json.access_token, client_id: reg.json.client_id };
  assert.match(tok.json.workspace_id, /^[a-f0-9]{64}$/);
  const revoked = await request(port, `/w/${tok.json.workspace_id}/oauth/revoke`, { body: revocation });
  assert.equal(revoked.status, 200);
  assert.equal((await mcp(tok.json.access_token)).status, 401);
});
