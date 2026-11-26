import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  ALLOWED_DESKTOP_REDIRECT_SCHEMES,
  McpOAuthServer,
  isCimdClientId,
  parseBasicClientAuth,
} from '../lib/mcp-oauth.mjs';
import { startServer } from '../server.mjs';

function makePkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

async function setupLocalServer(t, extraOpts = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'loop-oauth-univ-'));
  const servers = [];
  t.after(async () => {
    try {
      await Promise.all(servers.map((s) => s.close()));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  async function start(opts = {}) {
    const srv = await startServer({
      port: 0,
      dataDir,
      authMode: 'local-test',
      detectLocalAgents: false,
      seedBuiltins: true,
      ...extraOpts,
      ...opts,
    });
    servers.push(srv);
    return srv;
  }
  const srv = await start();
  const base = `http://127.0.0.1:${srv.port}`;
  const setupRes = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'universal-owner-pass' }),
  });
  assert.equal(setupRes.status, 200);
  const cookie = (setupRes.headers.get('set-cookie') || '').split(';')[0];
  return { dataDir, srv, base, cookie, start };
}

async function completeOAuthFlow({ base, cookie, clientId, redirectUri, clientSecret = null, authMethod = 'none' }) {
  const pkce = makePkce();
  const authUrl = new URL(`${base}/oauth/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('resource', `${base}/mcp`);
  const authRes = await fetch(authUrl, { redirect: 'manual' });
  assert.equal(authRes.status, 302, 'authorize should redirect to consent');
  const txId = new URL(authRes.headers.get('location'), base).searchParams.get('loop-oauth');
  assert.ok(txId);

  const approveRes = await fetch(`${base}/api/oauth/requests/${txId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({}),
  });
  assert.equal(approveRes.status, 200);
  const { redirectUrl } = await approveRes.json();
  const code = new URL(redirectUrl).searchParams.get('code');

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: pkce.verifier,
  });
  if (authMethod === 'client_secret_basic' && clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
  } else if (authMethod === 'client_secret_post' && clientSecret) {
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);
  } else {
    body.set('client_id', clientId);
  }

  const tokenRes = await fetch(`${base}/oauth/token`, { method: 'POST', headers, body });
  return { status: tokenRes.status, json: await tokenRes.json() };
}

test('Phase 1: hashed refresh tokens persist across server restart, are permanent by default, and honor configurable lifetime', async (t) => {
  const { dataDir, srv, base, cookie, start } = await setupLocalServer(t);
  const redirectUri = 'http://127.0.0.1:54111/cb';

  // Default setting omits oauthRefreshTtlDays (never expires)
  const settingsRes = await fetch(`${base}/api/settings`, { headers: { Cookie: cookie } });
  assert.equal(settingsRes.status, 200);
  assert.equal((await settingsRes.json()).settings.oauthRefreshTtlDays ?? null, null);

  const reg = await (await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Grok Bot', redirect_uris: [redirectUri] }),
  })).json();
  const tok = await completeOAuthFlow({ base, cookie, clientId: reg.client_id, redirectUri });
  assert.equal(tok.status, 200);
  assert.match(tok.json.refresh_token, /^loop_rt_/);

  // Restart Loop completely
  await srv.close();

  // Verify raw refresh token is never written in plaintext on disk
  const rawRefreshFile = await readFile(path.join(dataDir, 'oauth-refresh.json'), 'utf8');
  assert.equal(rawRefreshFile.includes(tok.json.refresh_token), false, 'plaintext refresh token must never be stored on disk');
  const parsedDisk = JSON.parse(rawRefreshFile);
  assert.equal(parsedDisk.tokens.length, 1);
  assert.equal(parsedDisk.tokens[0].expiresAt, null, 'refresh token must be permanent by default');

  const srv2 = await start();
  const base2 = `http://127.0.0.1:${srv2.port}`;

  // Refresh succeeds after restart
  const refreshed = await fetch(`${base2}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: reg.client_id,
      refresh_token: tok.json.refresh_token,
    }),
  });
  assert.equal(refreshed.status, 200);
  const refJson = await refreshed.json();
  assert.match(refJson.access_token, /^loop_/);
  assert.notEqual(refJson.refresh_token, tok.json.refresh_token);

  // Configure finite lifetime (e.g. 7 days) via PATCH /api/settings and verify next rotated token has expiresAt
  const loginRes = await fetch(`${base2}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'universal-owner-pass' }),
  });
  const cookie2 = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  const patchRes = await fetch(`${base2}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
    body: JSON.stringify({ oauthRefreshTtlDays: 7 }),
  });
  assert.equal(patchRes.status, 200);
  assert.equal((await patchRes.json()).settings.oauthRefreshTtlDays, 7);

  const rotated7d = await fetch(`${base2}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: reg.client_id,
      refresh_token: refJson.refresh_token,
    }),
  });
  assert.equal(rotated7d.status, 200);
  await srv2.close();
  const parsed7d = JSON.parse(await readFile(path.join(dataDir, 'oauth-refresh.json'), 'utf8'));
  assert.equal(parsed7d.tokens.length, 1);
  assert.ok(typeof parsed7d.tokens[0].expiresAt === 'number' && parsed7d.tokens[0].expiresAt > Date.now() + 6 * 86_400_000);
});

test('Phase 1: parallel concurrent refreshes coalesce safely and optional grace window handles post-completion retries', async (t) => {
  const { base, cookie } = await setupLocalServer(t);
  const redirectUri = 'http://127.0.0.1:54112/cb';
  const reg = await (await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'OpenMausBot', redirect_uris: [redirectUri] }),
  })).json();
  const tok = await completeOAuthFlow({ base, cookie, clientId: reg.client_id, redirectUri });
  assert.equal(tok.status, 200);

  // Fire 3 concurrent refreshes for the exact same refresh token simultaneously
  const results = await Promise.all(
    [1, 2, 3].map(() =>
      fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: reg.client_id,
          refresh_token: tok.json.refresh_token,
        }),
      }).then(async (r) => ({ status: r.status, body: await r.json() })),
    ),
  );
  assert.ok(results.every((r) => r.status === 200), `all concurrent refreshes should succeed: ${JSON.stringify(results)}`);
  assert.equal(results[0].body.refresh_token, results[1].body.refresh_token);
  assert.equal(results[1].body.refresh_token, results[2].body.refresh_token);

  // Unit check: optional refreshGraceMs allows retry within window, then revokes family after window expires
  const oauth = new McpOAuthServer(null, { refreshGraceMs: 15_000 });
  const t0 = 1_700_000_000_000;
  const issued = oauth.issueRefreshToken({
    agentId: 'a1',
    clientId: 'c1',
    clientName: 'Grok Bot',
    now: t0,
  });
  const first = oauth.exchangeRefreshToken({ refresh_token: issued.refreshToken, client_id: 'c1' }, { now: t0 + 1000 });
  const withinGrace = oauth.exchangeRefreshToken({ refresh_token: issued.refreshToken, client_id: 'c1' }, { now: t0 + 5000 });
  assert.equal(withinGrace.refreshToken, first.refreshToken);
  assert.equal(withinGrace.graceHit, true);

  // After grace window expires, replaying old token triggers family revocation
  assert.throws(
    () => oauth.exchangeRefreshToken({ refresh_token: issued.refreshToken, client_id: 'c1' }, { now: t0 + 20_000 }),
    { status: 400, oauthError: 'invalid_grant' },
  );
  assert.throws(
    () => oauth.exchangeRefreshToken({ refresh_token: first.refreshToken, client_id: 'c1' }, { now: t0 + 21_000 }),
    { status: 400, oauthError: 'invalid_grant' },
  );
});

test('Phase 1: confidential clients (client_secret_basic & client_secret_post) enforce secret verification', async (t) => {
  const { base, cookie } = await setupLocalServer(t);
  const redirectUri = 'http://127.0.0.1:54113/cb';

  // AS metadata advertises confidential auth methods + CIMD while keeping revocation_endpoint_auth_methods_supported intact
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(meta.token_endpoint_auth_methods_supported, ['none', 'client_secret_basic', 'client_secret_post']);
  assert.equal(meta.client_id_metadata_document_supported, true);

  // 1. client_secret_basic
  const regBasic = await (await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'OpenBot Enterprise',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'client_secret_basic',
    }),
  })).json();
  assert.match(regBasic.client_secret, /^loop_cs_/);

  // Missing secret fails with 401
  const missingSecret = await completeOAuthFlow({
    base,
    cookie,
    clientId: regBasic.client_id,
    redirectUri,
    authMethod: 'none',
  });
  assert.equal(missingSecret.status, 401);
  assert.equal(missingSecret.json.error, 'invalid_client');

  // Correct Basic auth succeeds on code exchange and refresh
  const okBasic = await completeOAuthFlow({
    base,
    cookie,
    clientId: regBasic.client_id,
    redirectUri,
    clientSecret: regBasic.client_secret,
    authMethod: 'client_secret_basic',
  });
  assert.equal(okBasic.status, 200);
  const refreshBasic = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${encodeURIComponent(regBasic.client_id)}:${encodeURIComponent(regBasic.client_secret)}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: okBasic.json.refresh_token }),
  });
  assert.equal(refreshBasic.status, 200);

  // 2. client_secret_post
  const regPost = await (await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'OpenBot Post',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'client_secret_post',
    }),
  })).json();
  assert.match(regPost.client_secret, /^loop_cs_/);
  const okPost = await completeOAuthFlow({
    base,
    cookie,
    clientId: regPost.client_id,
    redirectUri,
    clientSecret: regPost.client_secret,
    authMethod: 'client_secret_post',
  });
  assert.equal(okPost.status, 200);
  assert.equal(parseBasicClientAuth('Basic ' + Buffer.from('id:sec').toString('base64')).clientSecret, 'sec');
});

test('Phase 1: CIMD URL client_id fetches metadata safely, skips DCR, and blocks SSRF loopback when disallowed', async (t) => {
  // Loopback CIMD rejected by default
  assert.equal(isCimdClientId('http://127.0.0.1:9999/oauth/client.json'), false);
  assert.equal(isCimdClientId('https://bot.example.com/'), false);
  assert.equal(isCimdClientId('https://bot.example.com/oauth/client.json'), true);

  // Serve a mock CIMD metadata document on loopback (explicitly enabled only in this test)
  const redirectUri = 'http://127.0.0.1:54114/cb';
  const cimdSrv = http.createServer((req, res) => {
    const port = cimdSrv.address().port;
    const clientId = `http://127.0.0.1:${port}/oauth/client.json`;
    if (req.url === '/oauth/client.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
      return res.end(JSON.stringify({
        client_id: clientId,
        client_name: 'Meta Muse',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
      }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => cimdSrv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => cimdSrv.close(resolve)));

  const cimdClientId = `http://127.0.0.1:${cimdSrv.address().port}/oauth/client.json`;
  const { base, cookie } = await setupLocalServer(t, { allowLoopbackCimd: true });

  // Authorize directly with URL client_id (no DCR call needed!)
  const tok = await completeOAuthFlow({ base, cookie, clientId: cimdClientId, redirectUri });
  assert.equal(tok.status, 200);
  assert.match(tok.json.access_token, /^loop_/);
  assert.match(tok.json.refresh_token, /^loop_rt_/);

  // Desktop schemes include OpenMausBot, MausBot, OpenBot, Grok
  for (const scheme of ['openmausbot:', 'mausbot:', 'openbot:', 'grok:']) {
    assert.equal(ALLOWED_DESKTOP_REDIRECT_SCHEMES.has(scheme), true, `${scheme} should be allowed`);
  }
});
