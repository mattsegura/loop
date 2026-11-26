import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  discoverOAuthMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  registerClient,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { AppWorkspaces, workspaceId } from '../lib/app-workspaces.mjs';
import {
  ALLOWED_DESKTOP_REDIRECT_SCHEMES,
  MAX_AUTHORIZE_PER_IP,
  MAX_CODES_PER_WORKSPACE,
  MAX_REGISTRATIONS_PER_IP,
  McpOAuthServer,
  inferAgentKind,
  isValidRedirectUri,
  resolvePublicOrigin,
} from '../lib/mcp-oauth.mjs';
import { OwnerAuth } from '../lib/owner.mjs';
import { guardRequest, hasProxyHeaders, isLocalDeviceRequest, isOAuthPublicCorsPath, PROXY_HEADERS } from '../lib/security.mjs';
import { defaultSnippetTab, signInStep, snippetTabsFor } from '../public/agents-view.js';
import { renderOAuthHandoffFallback } from '../public/oauth-consent-view.js';
import { startServer } from '../server.mjs';

const frontendApi = 'https://loop-oauth-test.clerk.accounts.dev';
const publishableKey = 'fixture';
const legacyPassword = 'fixture-original-password';

const clerkApp = {
  publishableKey,
  frontendApi,
  async verifyRequest(req, port) {
    assert.equal(req.headers.host, `127.0.0.1:${port}`);
    const userId = req.headers['x-fixture-auth'];
    if (userId !== 'user_A' && userId !== 'user_B') return null;
    return { userId, sessionId: 'sess_oauth', issuer: frontendApi, expiresAt: Date.now() + 60_000 };
  },
};

function makePkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

async function setupFixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'loop-mcp-oauth-'));
  const servers = [];
  t.after(async () => {
    try {
      await Promise.all(servers.map((s) => s.close()));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  return {
    dataDir,
    async start(opts = {}) {
      const srv = await startServer({ port: 0, dataDir, detectLocalAgents: false, clerkApp, ...opts });
      servers.push(srv);
      return srv;
    },
  };
}

test('full MCP OAuth 2.1 flow with @modelcontextprotocol/sdk: 401 discovery -> DCR -> Clerk sign-in & approve -> PKCE token -> live /mcp', async (t) => {
  const fixture = await setupFixture(t);

  // Seed legacy owner password so local workspace exists and can be claimed by user_A
  const legacySrv = await fixture.start({ authMode: 'local-test', clerkApp: undefined });
  const setupRes = await fetch(`http://127.0.0.1:${legacySrv.port}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: legacyPassword }),
  });
  assert.equal(setupRes.status, 200);
  await legacySrv.close();

  const srv = await fixture.start({ seedBuiltins: true });
  const base = `http://127.0.0.1:${srv.port}`;
  const mcpUrl = `${base}/mcp`;

  // 1. Unauthenticated /mcp returns 401 with RFC 9728 WWW-Authenticate header
  const unauth = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(unauth.status, 401);
  const unauthBody = await unauth.json();
  assert.match(unauthBody.error.message, /codex mcp login loop/i);
  assert.match(unauthBody.error.message, /Authenticate/i);
  const wwwAuth = unauth.headers.get('www-authenticate') || '';
  assert.match(wwwAuth, /Bearer\s+resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/);

  // 2. Official MCP SDK discovers Protected Resource Metadata and Authorization Server Metadata
  const prm = await discoverOAuthProtectedResourceMetadata(mcpUrl);
  assert.equal(prm.resource, mcpUrl);
  assert.deepEqual(prm.authorization_servers, [base]);

  const asMeta = await discoverOAuthMetadata(prm.authorization_servers[0]);
  assert.equal(asMeta.issuer, base);
  assert.equal(asMeta.authorization_endpoint, `${base}/oauth/authorize`);
  assert.equal(asMeta.token_endpoint, `${base}/oauth/token`);
  assert.equal(asMeta.registration_endpoint, `${base}/oauth/register`);

  // 3. Official MCP SDK registers dynamically (DCR)
  const redirectUri = 'http://localhost:51234/callback';
  const clientInfo = await registerClient(base, {
    metadata: asMeta,
    clientMetadata: {
      client_name: 'Claude Code',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  });
  assert.match(clientInfo.client_id, /^loop_client_/);
  assert.equal(clientInfo.client_name, 'Claude Code');

  // 4. Browser hits /oauth/authorize with PKCE S256 -> redirects to /?loop-oauth=<txId>
  const pkce = makePkce();
  const authUrl = new URL(asMeta.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientInfo.client_id);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', 'claude-state-123');
  authUrl.searchParams.set('resource', mcpUrl);

  const authRes = await fetch(authUrl, { redirect: 'manual' });
  assert.equal(authRes.status, 302);
  const consentLoc = new URL(authRes.headers.get('location'), base);
  const txId = consentLoc.searchParams.get('loop-oauth');
  assert.ok(txId, 'authorize must redirect to /?loop-oauth=<txId>');

  // 5. Consent API requires verified sign-in
  const unauthConsent = await fetch(`${base}/api/oauth/requests/${txId}`);
  assert.equal(unauthConsent.status, 401);

  // 6. Because a legacy password exists, user_A must restore the local Mac workspace with the
  //    original password before approving /mcp (never auto-claimed without password).
  const preRestoreConsent = await fetch(`${base}/api/oauth/requests/${txId}`, {
    headers: { 'X-Fixture-Auth': 'user_A' },
  });
  assert.equal(preRestoreConsent.status, 200);
  const preRestoreJson = await preRestoreConsent.json();
  assert.equal(preRestoreJson.canApprove, false);
  assert.equal(preRestoreJson.needsLocalRestore, true);
  assert.equal(preRestoreJson.workspace, 'personal');
  assert.equal(preRestoreJson.request.redirectUri, redirectUri);

  // Wrong password is rejected with 403; original password restores the local workspace.
  const wrongClaim = await fetch(`${base}/api/auth/claim-local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Fixture-Auth': 'user_A' },
    body: JSON.stringify({ password: 'wrong-password' }),
  });
  assert.equal(wrongClaim.status, 403);

  const restoreRes = await fetch(`${base}/api/auth/claim-local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Fixture-Auth': 'user_A' },
    body: JSON.stringify({ password: legacyPassword }),
  });
  assert.equal(restoreRes.status, 200);

  const consentRes = await fetch(`${base}/api/oauth/requests/${txId}`, {
    headers: { 'X-Fixture-Auth': 'user_A' },
  });
  assert.equal(consentRes.status, 200);
  const consentJson = await consentRes.json();
  assert.equal(consentJson.canApprove, true);
  assert.equal(consentJson.workspace, 'local');
  assert.equal(consentJson.request.redirectUri, redirectUri);

  // 7. user_B STILL cannot approve /mcp because user_A owns the local workspace (404 zero-leak, G1-10)
  const userBApprove = await fetch(`${base}/api/oauth/requests/${txId}/approve`, {
    method: 'POST',
    headers: { 'X-Fixture-Auth': 'user_B' },
  });
  assert.equal(userBApprove.status, 404);

  // 8. user_A approves -> gets redirect URL back to Claude Code's localhost callback with code & state
  const approveRes = await fetch(`${base}/api/oauth/requests/${txId}/approve`, {
    method: 'POST',
    headers: { 'X-Fixture-Auth': 'user_A' },
  });
  assert.equal(approveRes.status, 200);
  const { redirectUrl, status: approveStatus } = await approveRes.json();
  assert.equal(approveStatus, 'waiting');
  const callback = new URL(redirectUrl);
  assert.equal(`${callback.origin}${callback.pathname}`, redirectUri);
  assert.equal(callback.searchParams.get('state'), 'claude-state-123');
  const code = callback.searchParams.get('code');
  assert.ok(code);

  // 9. Handoff status reports waiting until token exchange completes, and enforces auth & tenant isolation
  const unauthStatus = await fetch(`${base}/api/oauth/requests/${txId}/status`);
  assert.equal(unauthStatus.status, 401);
  const userBStatus = await fetch(`${base}/api/oauth/requests/${txId}/status`, {
    headers: { 'X-Fixture-Auth': 'user_B' },
  });
  assert.equal(userBStatus.status, 404);
  const waitingStatusRes = await fetch(`${base}/api/oauth/requests/${txId}/status`, {
    headers: { 'X-Fixture-Auth': 'user_A' },
  });
  assert.equal(waitingStatusRes.status, 200);
  const waitingStatus = await waitingStatusRes.json();
  assert.equal(waitingStatus.status, 'waiting');
  assert.equal(waitingStatus.clientName, 'Claude Code');

  // 10. Official MCP SDK exchanges code + PKCE verifier for a real workspace agent Bearer token
  const tokens = await exchangeAuthorization(base, {
    metadata: asMeta,
    clientInformation: clientInfo,
    authorizationCode: code,
    codeVerifier: pkce.verifier,
    redirectUri,
    resource: new URL(mcpUrl),
  });
  assert.match(tokens.access_token, /^loop_[A-Za-z0-9_-]{43}$/);
  assert.equal(tokens.token_type, 'Bearer');

  const connectedStatusRes = await fetch(`${base}/api/oauth/requests/${txId}/status`, {
    headers: { 'X-Fixture-Auth': 'user_A' },
  });
  assert.equal(connectedStatusRes.status, 200);
  const connectedStatus = await connectedStatusRes.json();
  assert.equal(connectedStatus.status, 'connected');
  assert.equal(connectedStatus.clientName, 'Claude Code');

  // Replaying the same authorization code MUST fail
  await assert.rejects(() =>
    exchangeAuthorization(base, {
      metadata: asMeta,
      clientInformation: clientInfo,
      authorizationCode: code,
      codeVerifier: pkce.verifier,
      redirectUri,
      resource: new URL(mcpUrl),
    }),
  );

  // 11. The issued access_token immediately authenticates POST /mcp and appears in Agents
  const initRes = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '1.0' } },
    }),
  });
  assert.equal(initRes.status, 200);
  const initJson = await initRes.json();
  assert.equal(initJson.result.serverInfo.name, 'loop');

  const agentsRes = await fetch(`${base}/api/agents`, {
    headers: { 'X-Fixture-Auth': 'user_A' },
  });
  const agentsJson = await agentsRes.json();
  assert.ok(agentsJson.agents.some((a) => a.name === 'Claude Code' && a.kind === 'claude-code' && a.hasToken));

  // 12. A second distinct OAuth client with the same client_name gets its own agent row so both tokens stay valid
  const client2 = await registerClient(base, {
    metadata: asMeta,
    clientMetadata: {
      client_name: 'Claude Code',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  });
  const pkce2 = makePkce();
  const authUrl2 = new URL(asMeta.authorization_endpoint);
  authUrl2.searchParams.set('response_type', 'code');
  authUrl2.searchParams.set('client_id', client2.client_id);
  authUrl2.searchParams.set('redirect_uri', redirectUri);
  authUrl2.searchParams.set('code_challenge', pkce2.challenge);
  authUrl2.searchParams.set('code_challenge_method', 'S256');
  authUrl2.searchParams.set('resource', mcpUrl);
  const tx2 = new URL((await fetch(authUrl2, { redirect: 'manual' })).headers.get('location'), base).searchParams.get('loop-oauth');
  const actionAccess = (name) => ({
    allowedConnections: ['loop_utils'], toolGrants: { loop_utils: [name] },
    allowedSkills: [], memoryAccess: 'none', canManage: false, secrets: [],
  });
  const approve = (id, access) => fetch(`${base}/api/oauth/requests/${id}/approve`, {
    method: 'POST', headers: { 'X-Fixture-Auth': 'user_A', 'Content-Type': 'application/json' },
    body: JSON.stringify({ access }),
  });
  assert.equal((await approve(tx2, actionAccess('removed_tool'))).status, 400);
  const approval = await approve(tx2, actionAccess('calc'));
  const approvedAction = await approval.json();
  assert.equal(approval.status, 200, approvedAction.error);
  const code2 = new URL(approvedAction.redirectUrl).searchParams.get('code');
  const tokens2 = await exchangeAuthorization(base, {
    metadata: asMeta,
    clientInformation: client2,
    authorizationCode: code2,
    codeVerifier: pkce2.verifier,
    redirectUri,
    resource: new URL(mcpUrl),
  });
  assert.notEqual(tokens2.access_token, tokens.access_token);
  // Both tokens work simultaneously without clobbering each other
  for (const tok of [tokens.access_token, tokens2.access_token]) {
    const r = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} }),
    });
    assert.equal(r.status, 200);
  }
  const agentsAfter = await (await fetch(`${base}/api/agents`, { headers: { 'X-Fixture-Auth': 'user_A' } })).json();
  assert.deepEqual(agentsAfter.agents.find((a) => a.name === 'Claude Code (2)').toolGrants, { loop_utils: ['calc'] });

  const revoke = (clientId, token, url = `${base}/oauth/revoke`) => fetch(url, {
    method: 'POST', body: new URLSearchParams({ client_id: clientId, token, token_type_hint: 'unknown' }),
  });
  const ping = (token) => fetch(mcpUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
  });
  assert.equal((await revoke('direct:other', tokens.access_token)).status, 400);
  assert.equal((await revoke(clientInfo.client_id, '')).status, 400);
  assert.equal((await revoke(clientInfo.client_id, 'no-such-token')).status, 200);
  assert.equal((await revoke(client2.client_id, tokens.access_token)).status, 200);
  assert.equal((await revoke(clientInfo.client_id, tokens.access_token, `${base}/w/${'a'.repeat(64)}/oauth/revoke`)).status, 200);
  assert.equal((await ping(tokens.access_token)).status, 200);
  assert.equal((await revoke(clientInfo.client_id, tokens.access_token)).status, 200);
  assert.equal((await revoke(clientInfo.client_id, tokens.access_token)).status, 200);
  assert.equal((await ping(tokens.access_token)).status, 401);
  assert.equal((await ping(tokens2.access_token)).status, 200);

  async function reconnect(access) {
    const next = makePkce();
    authUrl2.searchParams.set('code_challenge', next.challenge);
    const location = (await fetch(authUrl2, { redirect: 'manual' })).headers.get('location');
    const id = new URL(location, base).searchParams.get('loop-oauth');
    const result = await approve(id, access);
    assert.equal(result.status, 200);
    const code = new URL((await result.json()).redirectUrl).searchParams.get('code');
    return (await exchangeAuthorization(base, {
      metadata: asMeta, clientInformation: client2, authorizationCode: code, codeVerifier: next.verifier,
      redirectUri, resource: new URL(mcpUrl),
    })).access_token;
  }
  const sibling = await reconnect();
  assert.equal((await ping(tokens2.access_token)).status, 200);
  const replacement = await reconnect(actionAccess('date_math'));
  assert.equal((await ping(sibling)).status, 401);
  assert.equal((await ping(tokens2.access_token)).status, 401);
  assert.equal((await ping(replacement)).status, 200);
});

test('MCP OAuth rejects unsafe redirect URIs, bad PKCE verifier, and handles deny + personal workspace isolation', async (t) => {
  const fixture = await setupFixture(t);
  const srv = await fixture.start();
  const base = `http://127.0.0.1:${srv.port}`;

  // Reject non-loopback HTTP and javascript: redirect URIs on DCR
  for (const badUri of ['http://evil.example/cb', 'javascript:alert(1)', 'http://localhost:9999/cb#frag']) {
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Bad', redirect_uris: [badUri] }),
    });
    assert.equal(res.status, 400, `expected 400 for ${badUri}`);
  }

  // Register valid client
  const redirectUri = 'http://127.0.0.1:54321/cb';
  const regRes = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Cursor', redirect_uris: [redirectUri] }),
  });
  assert.equal(regRes.status, 201);
  const client = await regRes.json();

  // Personal workspace scoped OAuth for user_B (/w/<userBWorkspaceId>/mcp)
  const userBWs = workspaceId({ issuer: frontendApi, userId: 'user_B' });
  const scopedUrl = `${base}/w/${userBWs}/mcp`;
  const pkce = makePkce();
  const authUrl = new URL(`${base}/oauth/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', client.client_id);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', 'st-personal');
  authUrl.searchParams.set('resource', scopedUrl);

  const authRes = await fetch(authUrl, { redirect: 'manual' });
  const txId = new URL(authRes.headers.get('location'), base).searchParams.get('loop-oauth');

  // user_A cannot approve user_B's personal workspace request (404 zero-leak, G1-10)
  const wrongUser = await fetch(`${base}/api/oauth/requests/${txId}/approve`, {
    method: 'POST',
    headers: { 'X-Fixture-Auth': 'user_A' },
  });
  assert.equal(wrongUser.status, 404);

  // user_B approves -> wrong PKCE verifier is rejected and consumes the code
  const approveRes = await fetch(`${base}/api/oauth/requests/${txId}/approve`, {
    method: 'POST',
    headers: { 'X-Fixture-Auth': 'user_B' },
  });
  assert.equal(approveRes.status, 200);
  const { redirectUrl } = await approveRes.json();
  const code = new URL(redirectUrl).searchParams.get('code');

  const badPkce = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      code_verifier: 'wrong_verifier_padding_to_43_chars_minimum_length_12345',
    }),
  });
  assert.equal(badPkce.status, 400);

  // Deny flow on local /mcp returns error=access_denied with original state
  const localDenyUrl = new URL(`${base}/oauth/authorize`);
  localDenyUrl.searchParams.set('response_type', 'code');
  localDenyUrl.searchParams.set('client_id', client.client_id);
  localDenyUrl.searchParams.set('redirect_uri', redirectUri);
  localDenyUrl.searchParams.set('code_challenge', pkce.challenge);
  localDenyUrl.searchParams.set('code_challenge_method', 'S256');
  localDenyUrl.searchParams.set('state', 'st-local-deny');
  localDenyUrl.searchParams.set('resource', `${base}/mcp`);
  const denyAuth = await fetch(localDenyUrl, { redirect: 'manual' });
  const denyTx = new URL(denyAuth.headers.get('location'), base).searchParams.get('loop-oauth');
  const denyRes = await fetch(`${base}/api/oauth/requests/${denyTx}/deny`, {
    method: 'POST',
    headers: { 'X-Fixture-Auth': 'user_A' },
  });
  assert.equal(denyRes.status, 200);
  const denied = new URL((await denyRes.json()).redirectUrl);
  assert.equal(denied.searchParams.get('error'), 'access_denied');
  assert.equal(denied.searchParams.get('state'), 'st-local-deny');
});

test('security: PROXY_HEADERS, hasProxyHeaders, and isLocalDeviceRequest enforce hosted and proxy boundaries', () => {
  assert.equal(Object.isFrozen(PROXY_HEADERS), true);
  assert.ok(PROXY_HEADERS.includes('x-forwarded-for'));
  assert.ok(PROXY_HEADERS.includes('x-real-ip'));
  assert.ok(PROXY_HEADERS.includes('tailscale-user-login'));

  const cleanReq = { headers: { host: '127.0.0.1:8799' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(hasProxyHeaders(cleanReq), false);
  assert.equal(isLocalDeviceRequest(cleanReq, 8799), true);
  assert.equal(isLocalDeviceRequest(cleanReq, 8799, { hosted: true }), false);

  for (const h of PROXY_HEADERS) {
    const emptyValReq = { headers: { host: '127.0.0.1:8799', [h]: '' }, socket: { remoteAddress: '127.0.0.1' } };
    assert.equal(hasProxyHeaders(emptyValReq), true, `empty ${h} must be detected`);
    assert.equal(isLocalDeviceRequest(emptyValReq, 8799), false, `empty ${h} must not be local device`);
  }

  for (const [host, remoteAddress, expected] of [
    ['localhost:8799', '::1', true],
    ['[::1]:8799', '::ffff:127.0.0.1', true],
    ['loop.example.com', '127.0.0.1', false],
    ['127.0.0.1:9999', '127.0.0.1', false],
    ['127.0.0.1:8799', '198.51.100.9', false],
  ]) {
    assert.equal(isLocalDeviceRequest({ headers: { host }, socket: { remoteAddress } }, 8799), expected);
  }
});

test('AppWorkspaces: atomic claim state, password-gated restore, multi-process refresh, and corrupt file resilience', async (t) => {
  const mkWsFactory = () => (dir, id) => ({
    id,
    dir,
    owner: new OwnerAuth(dir),
    close: async () => {},
  });
  const idA = { issuer: frontendApi, userId: 'user_A' };
  const idB = { issuer: frontendApi, userId: 'user_B' };

  // 1. Brand-new install (no owner.json) auto-claims for first device user
  const freshDir = await mkdtemp(path.join(tmpdir(), 'loop-ws-fresh-'));
  t.after(() => rm(freshDir, { recursive: true, force: true }));
  const wsFresh = new AppWorkspaces(freshDir, mkWsFactory());
  assert.equal(wsFresh.forUser(idA, true).id, null);
  assert.equal(wsFresh.forUser(idB, true).id, workspaceId(idB));
  assert.equal(wsFresh.forUser(idA, false).id, workspaceId(idA));

  // 2. Pre-existing password-protected Mac workspace does NOT auto-claim; two processes stay in sync (G1-08)
  const seededDir = await mkdtemp(path.join(tmpdir(), 'loop-ws-seeded-'));
  t.after(() => rm(seededDir, { recursive: true, force: true }));
  const seedOwner = new OwnerAuth(seededDir);
  assert.equal(seedOwner.hasPasswordSync(), false);
  await seedOwner.setup(legacyPassword);
  assert.equal(seedOwner.hasPasswordSync(), true);

  const proc1 = new AppWorkspaces(seededDir, mkWsFactory());
  const proc2 = new AppWorkspaces(seededDir, mkWsFactory());
  assert.equal(proc1.forUser(idB, true).id, workspaceId(idB));
  assert.equal(proc1.claimed, null);
  await assert.rejects(() => proc1.claim(idB, 'wrong-password'), { status: 403 });
  await proc1.claim(idA, legacyPassword);
  assert.equal(proc1.forUser(idA, true).id, null);
  // Process 2 refreshes claim from disk without restart
  assert.equal(proc2.forUser(idA, true).id, null);
  assert.equal(proc2.forUser(idB, true).id, workspaceId(idB));
  await assert.rejects(() => proc2.claim(idB, legacyPassword), { status: 409 });

  // 3. Corrupt claim files do not crash constructor and never grant local access
  for (const [name, content] of Object.entries({ emptyObj: '{}', jsonNull: 'null', badId: '{"workspace":"x"}', empty: '', dir: null })) {
    const cDir = await mkdtemp(path.join(tmpdir(), `loop-ws-corrupt-${name}-`));
    t.after(() => rm(cDir, { recursive: true, force: true }));
    const claimPath = path.join(cDir, 'local-clerk-owner.json');
    if (content === null) await mkdir(claimPath);
    else await writeFile(claimPath, content);
    const ws = new AppWorkspaces(cDir, mkWsFactory());
    assert.equal(ws.claimCorrupt, true, `${name} should be flagged corrupt`);
    assert.equal(ws.forUser(idA, true).id, workspaceId(idA), `${name} must not grant local workspace`);
    await assert.rejects(() => ws.claim(idA, legacyPassword), { status: 409 });
  }
});

test('OwnerAuth: concurrent burst verify serialization (G1-03) and corrupt owner.json handling (G1-07)', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-owner-hardening-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const owner = new OwnerAuth(dir);
  await owner.setup(legacyPassword);

  // Fire 8 wrong guesses concurrently: first 5 fail and trigger lockout, remaining 3 reject with 429
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => owner.verify(`wrong-guess-${i}`)),
  );
  const falseCount = results.filter((r) => r.status === 'fulfilled' && r.value === false).length;
  const lockedCount = results.filter((r) => r.status === 'rejected' && r.reason?.status === 429).length;
  assert.equal(falseCount, 5);
  assert.equal(lockedCount, 3);

  // Corrupt owner.json rejects cleanly with 500 rather than caching bad data
  const corruptDir = await mkdtemp(path.join(tmpdir(), 'loop-owner-corrupt-'));
  t.after(() => rm(corruptDir, { recursive: true, force: true }));
  await writeFile(path.join(corruptDir, 'owner.json'), '{"version":1');
  const broken = new OwnerAuth(corruptDir);
  assert.equal(broken.hasPasswordSync(), true);
  await assert.rejects(() => broken.verify('anything'), { status: 500 });
});

test('McpOAuthServer: redirectUri disclosure (G7-01), anti-eviction & per-IP/per-workspace caps (G4a-05), debounced flush, and oldest-first restart eviction (G4a-09)', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-oauth-hardening-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const origin = 'http://127.0.0.1:8799';
  const server = new McpOAuthServer(dir, { maxClients: 120 });
  const pkce = makePkce();

  const startFor = (srv, client, redirectUri, state = 's', resource = `${origin}/mcp`, opts = {}) =>
    srv.startAuthorization(
      new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        state,
        ...(resource ? { resource } : {}),
      }),
      origin,
      opts,
    );

  // 1. G7-01: getPending includes full redirectUri alongside redirectHost
  const victimClient = server.registerClient({ client_name: 'Claude Code', redirect_uris: ['https://evil.example/cb/path?x=1'] });
  const victimStart = startFor(server, victimClient, 'https://evil.example/cb/path?x=1');
  assert.ok(victimStart.txId);
  const pending = server.getPending(victimStart.txId, { workspaceId: null });
  assert.equal(pending.redirectUri, 'https://evil.example/cb/path?x=1');
  assert.equal(pending.redirectHost, 'evil.example');

  // 2. G4a-05 per-client pending cap (10): 11th request for same client returns 429 and keeps victimStart alive
  const floodClient = server.registerClient({ client_name: 'Flood', redirect_uris: ['http://127.0.0.1:9001/cb'] });
  for (let i = 0; i < 10; i += 1) {
    const r = startFor(server, floodClient, 'http://127.0.0.1:9001/cb', `f${i}`);
    assert.ok(r.txId, `request ${i + 1} should succeed`);
  }
  const eleventh = startFor(server, floodClient, 'http://127.0.0.1:9001/cb', 'f10');
  assert.equal(eleventh.status, 429);
  assert.equal(eleventh.error, 'temporarily_unavailable');
  assert.ok(server.getPending(victimStart.txId, { workspaceId: null }), 'victim pending tx must survive per-client flood');

  // 3. G4a-05 anti-eviction: filling clients with recent (< 1h) clients refuses 429 instead of evicting
  while (server.clients.size < 120) {
    server.registerClient({ client_name: `DCR ${server.clients.size}`, redirect_uris: ['http://127.0.0.1:9002/cb'] });
  }
  assert.throws(
    () => server.registerClient({ client_name: 'TooMany', redirect_uris: ['http://127.0.0.1:9002/cb'] }),
    { status: 429, oauthError: 'temporarily_unavailable' },
  );
  assert.ok(server.clients.has(victimClient.client_id), 'active recent client must not be evicted by DCR flood');

  // Global pending cap (200) keeps victimStart alive
  const fillerClients = [...server.clients.values()].filter(
    (c) => c.client_id !== victimClient.client_id && c.client_id !== floodClient.client_id,
  );
  let idx = 0;
  while (server.pending.size < 200 && idx < fillerClients.length) {
    const c = fillerClients[idx++];
    for (let j = 0; j < 10 && server.pending.size < 200; j += 1) {
      const r = startFor(server, c, c.redirect_uris[0], `g${idx}_${j}`);
      assert.ok(r.txId);
    }
  }
  const globalOverflow = startFor(server, fillerClients[idx], fillerClients[idx].redirect_uris[0], 'over');
  assert.equal(globalOverflow.status, 429);
  assert.equal(globalOverflow.error, 'temporarily_unavailable');
  assert.ok(server.getPending(victimStart.txId, { workspaceId: null }), 'victim pending tx must survive global pending cap');

  // 4. G4a-05 per-workspace codes cap (50) & global codes cap (200)
  const codeServer = new McpOAuthServer(null);
  const ws1 = '1'.repeat(64);
  const ws2 = '2'.repeat(64);
  const ws3 = '3'.repeat(64);
  const workspaces = [null, ws1, ws2, ws3];
  const codeClients = Array.from({ length: 22 }, (_, i) =>
    codeServer.registerClient({ client_name: `C${i}`, redirect_uris: ['http://127.0.0.1:9010/cb'] }),
  );
  let firstCode = null;
  let clientCursor = 0;
  for (const ws of workspaces) {
    const resUrl = ws ? `${origin}/w/${ws}/mcp` : `${origin}/mcp`;
    for (let i = 0; i < MAX_CODES_PER_WORKSPACE; i += 1) {
      const c = codeClients[Math.floor(clientCursor / 10) % codeClients.length];
      clientCursor += 1;
      const { txId } = startFor(codeServer, c, 'http://127.0.0.1:9010/cb', `c_${ws}_${i}`, resUrl);
      const { redirectUrl } = codeServer.approvePending(txId, { workspaceId: ws, userId: 'u' });
      if (!firstCode) firstCode = new URL(redirectUrl).searchParams.get('code');
    }
    // 51st code in this workspace must fail with 429 without starving other workspaces
    const overWsTx = startFor(codeServer, codeClients[21], 'http://127.0.0.1:9010/cb', `over_${ws}`, resUrl);
    assert.throws(
      () => codeServer.approvePending(overWsTx.txId, { workspaceId: ws, userId: 'u' }),
      { status: 429, oauthError: 'temporarily_unavailable' },
    );
    assert.ok(codeServer.getPending(overWsTx.txId, { workspaceId: ws }), 'unapproved pending tx remains retryable after 429');
    codeServer.denyPending(overWsTx.txId, { workspaceId: ws });
  }
  assert.equal(codeServer.codes.size, 200);
  // 5th workspace hits global MAX_CODES = 200 cap without evicting live codes
  const ws5 = '5'.repeat(64);
  const ws5Tx = startFor(codeServer, codeClients[21], 'http://127.0.0.1:9010/cb', 'ws5', `${origin}/w/${ws5}/mcp`);
  assert.throws(
    () => codeServer.approvePending(ws5Tx.txId, { workspaceId: ws5, userId: 'u5' }),
    { status: 429, oauthError: 'temporarily_unavailable' },
  );
  assert.ok(codeServer.codes.has(firstCode), 'live authorization code must not be evicted');

  // 5. G4a-05 per-IP rate limiting on registerClient (20/10m) and startAuthorization (60/10m)
  const rlServer = new McpOAuthServer(null);
  let lastClient = null;
  for (let i = 0; i < MAX_REGISTRATIONS_PER_IP; i += 1) {
    lastClient = rlServer.registerClient(
      { client_name: `IP1-${i}`, redirect_uris: ['http://127.0.0.1:9030/cb'] },
      { clientIp: '198.51.100.10' },
    );
  }
  assert.throws(
    () => rlServer.registerClient(
      { client_name: 'IP1-over', redirect_uris: ['http://127.0.0.1:9030/cb'] },
      { clientIp: '198.51.100.10' },
    ),
    { status: 429, oauthError: 'temporarily_unavailable' },
  );
  // Different IP is unaffected
  const otherIpClient = rlServer.registerClient(
    { client_name: 'IP2-ok', redirect_uris: ['http://127.0.0.1:9030/cb'] },
    { clientIp: '198.51.100.11' },
  );
  assert.ok(otherIpClient.client_id);

  for (let i = 0; i < MAX_AUTHORIZE_PER_IP; i += 1) {
    // Use invalid_client so pending cap doesn't hit first; rate limit counts every call
    const r = rlServer.startAuthorization(new URLSearchParams({ client_id: 'unknown' }), origin, {
      clientIp: '198.51.100.20',
    });
    assert.equal(r.status, 400);
  }
  const rateLimitedAuth = rlServer.startAuthorization(
    new URLSearchParams({ client_id: lastClient.client_id }),
    origin,
    { clientIp: '198.51.100.20' },
  );
  assert.equal(rateLimitedAuth.status, 429);
  assert.equal(rateLimitedAuth.error, 'temporarily_unavailable');

  // 6. G4a-05 debounced save + flush() and G4a-09 oldest-first eviction of expired (>1h) unconfirmed clients across restart
  const restartDir = await mkdtemp(path.join(tmpdir(), 'loop-oauth-restart-'));
  t.after(() => rm(restartDir, { recursive: true, force: true }));
  const beforeRestart = new McpOAuthServer(restartDir, { maxClients: 20, saveDebounceMs: 5000 });
  const registered = [];
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  for (let i = 0; i < 20; i += 1) {
    const c = beforeRestart.registerClient({ client_name: `Client ${i}`, redirect_uris: ['http://127.0.0.1:9020/cb'] });
    beforeRestart.clients.get(c.client_id).createdAt = twoHoursAgo + i;
    registered.push(c.client_id);
  }
  // Mark oldest client (index 0) confirmed so index 1 (oldest unconfirmed expired) is evicted instead
  beforeRestart.clients.get(registered[0]).confirmed = true;
  await beforeRestart.flush();

  const afterRestart = new McpOAuthServer(restartDir, { maxClients: 20 });
  assert.equal(afterRestart.clients.get(registered[0]).confirmed, true, 'confirmed flag survives restart');
  const brandNew = afterRestart.registerClient({ client_name: 'Client 20', redirect_uris: ['http://127.0.0.1:9020/cb'] });
  assert.equal(afterRestart.clients.has(registered[0]), true, 'confirmed oldest client must never be evicted');
  assert.equal(afterRestart.clients.has(registered[1]), false, 'oldest unconfirmed expired client must be evicted after restart');
  assert.equal(afterRestart.clients.has(registered[19]), true, 'newest pre-restart client must survive');
  assert.equal(afterRestart.clients.has(brandNew.client_id), true, 'newly registered client must be kept');
  await afterRestart.flush();
});

test('G1-10 tenant-scoped consent: getPending, approvePending, and denyPending enforce identical workspace isolation with zero leak', () => {
  const origin = 'https://loop.example.com';
  const server = new McpOAuthServer(null);
  const pkce = makePkce();
  const wsA = 'a'.repeat(64);
  const wsB = 'b'.repeat(64);
  const client = server.registerClient({ client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1:51234/cb'] });

  const makeTx = (resource) => {
    const res = server.startAuthorization(
      new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:51234/cb',
        response_type: 'code',
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        state: 's1',
        resource,
      }),
      origin,
    );
    assert.ok(res.txId);
    return res.txId;
  };

  // Personal workspace B transaction
  const txB = makeTx(`${origin}/w/${wsB}/mcp`);
  assert.equal(server.getPending(txB, { workspaceId: null }), null);
  assert.equal(server.getPending(txB, { workspaceId: wsA }), null);
  assert.equal(server.getPending(txB, { workspaceId: wsA, allowLocalRestore: true }), null);
  assert.ok(server.getPending(txB, { workspaceId: wsB }));

  assert.throws(() => server.approvePending(txB, { workspaceId: null, userId: 'local' }), { status: 404 });
  assert.throws(() => server.approvePending(txB, { workspaceId: wsA, userId: 'user_A' }), { status: 404 });
  assert.throws(() => server.denyPending(txB, { workspaceId: null }), { status: 404 });
  assert.throws(() => server.denyPending(txB, { workspaceId: wsA }), { status: 404 });
  assert.ok(server.getPending(txB, { workspaceId: wsB }), 'failed cross-tenant deny/approve must not consume tx');

  const deniedB = server.denyPending(txB, { workspaceId: wsB });
  assert.match(deniedB.redirectUrl, /error=access_denied/);
  assert.equal(server.getPending(txB, { workspaceId: wsB }), null);

  // Local root (/mcp) transaction
  const txLocal = makeTx(`${origin}/mcp`);
  assert.equal(server.getPending(txLocal, { workspaceId: wsA }), null);
  assert.ok(server.getPending(txLocal, { workspaceId: wsA, allowLocalRestore: true }));
  assert.ok(server.getPending(txLocal, { workspaceId: null }));
  assert.throws(() => server.approvePending(txLocal, { workspaceId: wsA, userId: 'user_A' }), { status: 404 });
  assert.throws(() => server.denyPending(txLocal, { workspaceId: wsA }), { status: 404 });
  const approvedLocal = server.approvePending(txLocal, { workspaceId: null, userId: 'local' });
  assert.match(approvedLocal.redirectUrl, /code=/);
});

test('G4a-08 redirect URI desktop scheme allowlist & no open redirect for unconfirmed DCR clients', () => {
  // Safe schemes allowed
  for (const scheme of ALLOWED_DESKTOP_REDIRECT_SCHEMES) {
    assert.equal(isValidRedirectUri(`${scheme}//oauth/callback`), true, `${scheme} should be allowed`);
  }
  assert.equal(isValidRedirectUri('http://127.0.0.1:8080/cb'), true);
  assert.equal(isValidRedirectUri('http://localhost:8080/cb'), true);
  assert.equal(isValidRedirectUri('http://[::1]:8080/cb'), true);
  assert.equal(isValidRedirectUri('https://app.example.com/oauth/cb'), true);

  // Dangerous OS schemes, non-loopback HTTP, fragments, credentials, oversized URIs rejected
  for (const bad of [
    'ms-msdt:/id/PCWDiagnostic',
    'search-ms:query=foo',
    'smb://evil.example/share',
    'cmd://calc',
    'shell:startup',
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///etc/passwd',
    'unknown-scheme://cb',
    'http://evil.example/cb',
    'https://user:pass@evil.example/cb',
    'https://evil.example/cb#frag',
    `https://evil.example/${'a'.repeat(520)}`,
  ]) {
    assert.equal(isValidRedirectUri(bad), false, `${bad} must be rejected`);
  }

  // Record size cap (>10 redirect_uris rejected)
  const server = new McpOAuthServer(null);
  assert.throws(
    () => server.registerClient({
      client_name: 'TooManyUris',
      redirect_uris: Array.from({ length: 11 }, (_, i) => `http://127.0.0.1:${50000 + i}/cb`),
    }),
    { status: 400, oauthError: 'invalid_redirect_uri' },
  );

  // Unconfirmed DCR client must NOT trigger 302 open redirect on invalid authorize params
  const origin = 'https://loop.example.com';
  const evilClient = server.registerClient({
    client_name: 'Phish',
    redirect_uris: ['https://evil.example/landing'],
  });
  for (const badParams of [
    { response_type: 'token', code_challenge: makePkce().challenge, code_challenge_method: 'S256' },
    { response_type: 'code', code_challenge: 'too-short', code_challenge_method: 'S256' },
    { response_type: 'code', code_challenge: makePkce().challenge, code_challenge_method: 'plain' },
    { response_type: 'code', code_challenge: makePkce().challenge, code_challenge_method: 'S256', resource: 'https://other.example/mcp' },
  ]) {
    const res = server.startAuthorization(
      new URLSearchParams({
        client_id: evilClient.client_id,
        redirect_uri: 'https://evil.example/landing',
        state: 'st',
        ...badParams,
      }),
      origin,
    );
    assert.equal(res.redirectErrorUrl, undefined, 'unconfirmed client must never produce redirectErrorUrl');
    assert.equal(res.status, 400);
    assert.ok(res.error);
  }

  // Once user actually approves consent, client becomes confirmed
  const pkce = makePkce();
  const okStart = server.startAuthorization(
    new URLSearchParams({
      client_id: evilClient.client_id,
      redirect_uri: 'https://evil.example/landing',
      response_type: 'code',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      resource: `${origin}/mcp`,
    }),
    origin,
  );
  assert.ok(okStart.txId);
  server.approvePending(okStart.txId, { workspaceId: null, userId: 'local' });
  assert.equal(server.clients.get(evilClient.client_id).confirmed, true);

  const afterConfirmErr = server.startAuthorization(
    new URLSearchParams({
      client_id: evilClient.client_id,
      redirect_uri: 'https://evil.example/landing',
      response_type: 'token',
      state: 'st2',
    }),
    origin,
  );
  assert.ok(afterConfirmErr.redirectErrorUrl);
  assert.match(afterConfirmErr.redirectErrorUrl, /error=unsupported_response_type/);
});

test('G4a-13 workspace-scoped PRM & AS metadata and defaultWorkspaceId for clients omitting resource', () => {
  const origin = 'https://loop.example.com';
  const ws = 'c'.repeat(64);
  const otherWs = 'd'.repeat(64);
  const server = new McpOAuthServer(null);

  const rootPrm = server.protectedResourceMetadata(origin, '/mcp');
  assert.equal(rootPrm.resource, `${origin}/mcp`);
  assert.deepEqual(rootPrm.authorization_servers, [origin]);

  const scopedPrm = server.protectedResourceMetadata(origin, `/w/${ws}/mcp`);
  assert.equal(scopedPrm.resource, `${origin}/w/${ws}/mcp`);
  assert.deepEqual(scopedPrm.authorization_servers, [`${origin}/w/${ws}`]);

  const rootAs = server.authorizationServerMetadata(origin);
  assert.equal(rootAs.issuer, origin);
  assert.equal(rootAs.authorization_endpoint, `${origin}/oauth/authorize`);
  assert.equal(rootAs.token_endpoint, `${origin}/oauth/token`);
  assert.equal(rootAs.revocation_endpoint, `${origin}/oauth/revoke`);
  assert.deepEqual(rootAs.revocation_endpoint_auth_methods_supported, ['none']);
  assert.equal(rootAs.registration_endpoint, `${origin}/oauth/register`);

  const scopedAs = server.authorizationServerMetadata(origin, ws);
  assert.equal(scopedAs.issuer, `${origin}/w/${ws}`);
  assert.equal(scopedAs.authorization_endpoint, `${origin}/w/${ws}/oauth/authorize`);
  assert.equal(scopedAs.token_endpoint, `${origin}/w/${ws}/oauth/token`);
  assert.equal(scopedAs.revocation_endpoint, `${origin}/w/${ws}/oauth/revoke`);
  assert.equal(scopedAs.registration_endpoint, `${origin}/w/${ws}/oauth/register`);

  // Client omitting RFC 8707 `resource` on workspace-scoped authorize endpoint defaults to /w/<ws>/mcp
  const client = server.registerClient({ client_name: 'NoResourceAgent', redirect_uris: ['http://127.0.0.1:52222/cb'] });
  const pkce = makePkce();
  const started = server.startAuthorization(
    new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'http://127.0.0.1:52222/cb',
      response_type: 'code',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    }),
    origin,
    { defaultWorkspaceId: ws },
  );
  assert.ok(started.txId);
  const pending = server.getPending(started.txId, { workspaceId: ws });
  assert.equal(pending.resourcePath, `/w/${ws}/mcp`);
  assert.equal(pending.targetWorkspaceId, ws);

  // Explicit resource targeting another workspace on ws's endpoint is rejected
  const mismatch = server.startAuthorization(
    new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'http://127.0.0.1:52222/cb',
      response_type: 'code',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      resource: `${origin}/w/${otherWs}/mcp`,
    }),
    origin,
    { defaultWorkspaceId: ws },
  );
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.error, 'invalid_target');

  // exchangeCode enforces expectedWorkspaceId when called from a workspace-scoped token endpoint
  const { redirectUrl } = server.approvePending(started.txId, { workspaceId: ws, userId: 'u' });
  const code = new URL(redirectUrl).searchParams.get('code');
  assert.throws(
    () => server.exchangeCode(
      { grant_type: 'authorization_code', code, code_verifier: pkce.verifier, redirect_uri: 'http://127.0.0.1:52222/cb', client_id: client.client_id },
      origin,
      { expectedWorkspaceId: otherWs },
    ),
    { status: 400, oauthError: 'invalid_grant' },
  );
});

test('G4a-15 resolvePublicOrigin honors LOOP_PUBLIC_ORIGIN, RFC 7239 Forwarded, first X-Forwarded-* values, and safe fallback', (t) => {
  const prev = process.env.LOOP_PUBLIC_ORIGIN;
  t.after(() => {
    if (prev === undefined) delete process.env.LOOP_PUBLIC_ORIGIN;
    else process.env.LOOP_PUBLIC_ORIGIN = prev;
  });

  // 1. LOOP_PUBLIC_ORIGIN always takes precedence
  process.env.LOOP_PUBLIC_ORIGIN = 'https://Loop.Prod.Example.com:443/ignored/path';
  assert.equal(
    resolvePublicOrigin({ headers: { host: '127.0.0.1:8799', 'x-forwarded-host': 'evil.example' } }, 8799),
    'https://loop.prod.example.com',
  );
  delete process.env.LOOP_PUBLIC_ORIGIN;

  // 2. RFC 7239 Forwarded (first element, quoted host with port)
  assert.equal(
    resolvePublicOrigin(
      { headers: { forwarded: 'for=192.0.2.1;proto=https;host="loop.example.com:8443", for=10.0.0.1;proto=http;host=internal', host: '127.0.0.1:8799' } },
      8799,
    ),
    'https://loop.example.com:8443',
  );

  // 3. First comma-separated values of X-Forwarded-Proto and X-Forwarded-Host
  assert.equal(
    resolvePublicOrigin(
      { headers: { 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'public.loop.dev, internal.local', host: '127.0.0.1:8799' } },
      8799,
    ),
    'https://public.loop.dev',
  );

  // 4. Rejects malformed/injected forwarded headers and falls back cleanly
  assert.equal(
    resolvePublicOrigin(
      { headers: { 'x-forwarded-proto': 'javascript', 'x-forwarded-host': 'evil.com/path', host: 'loop.valid.dev' } },
      8799,
    ),
    'http://loop.valid.dev',
  );
  assert.equal(resolvePublicOrigin({ headers: {} }, 9123), 'http://127.0.0.1:9123');
  assert.equal(
    resolvePublicOrigin({ headers: { host: 'local.tls:8443' }, socket: { encrypted: true } }, 8799),
    'https://local.tls:8443',
  );
});

test('OAuth handoff status tracks waiting -> connected, failed (PKCE error), expired, and enforces workspace scoping', () => {
  const origin = 'http://127.0.0.1:8799';
  const wsA = 'a'.repeat(64);
  const wsB = 'b'.repeat(64);
  const server = new McpOAuthServer(null);
  const redirectUri = 'http://127.0.0.1:54994/oauth/callback/headless';
  const client = server.registerClient({
    client_name: 'Muse Code',
    redirect_uris: [redirectUri],
  });

  // 1. Failed PKCE verification marks handoff as failed with the reason
  const pkce1 = makePkce();
  const s1 = server.startAuthorization(
    new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: pkce1.challenge,
      code_challenge_method: 'S256',
      resource: `${origin}/w/${wsA}/mcp`,
    }),
    origin,
  );
  const a1 = server.approvePending(s1.txId, { workspaceId: wsA, userId: 'uA' });
  assert.equal(a1.status, 'waiting');
  assert.equal(server.getHandoffStatus(s1.txId, { workspaceId: wsA })?.status, 'waiting');
  assert.equal(server.getHandoffStatus(s1.txId, { workspaceId: wsB }), null);
  assert.equal(server.getHandoffStatus(s1.txId, { workspaceId: null }), null);

  const code1 = new URL(a1.redirectUrl).searchParams.get('code');
  assert.throws(
    () => server.exchangeCode(
      {
        grant_type: 'authorization_code',
        code: code1,
        code_verifier: 'x'.repeat(48),
        redirect_uri: redirectUri,
        client_id: client.client_id,
      },
      origin,
      { expectedWorkspaceId: wsA },
    ),
    { status: 400, oauthError: 'invalid_grant' },
  );
  const failed = server.getHandoffStatus(s1.txId, { workspaceId: wsA });
  assert.equal(failed?.status, 'failed');
  assert.match(failed?.error || '', /PKCE/i);

  // 2. Expired code transitions handoff from waiting to expired
  const pkce2 = makePkce();
  const s2 = server.startAuthorization(
    new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: pkce2.challenge,
      code_challenge_method: 'S256',
    }),
    origin,
  );
  server.approvePending(s2.txId, { workspaceId: null, userId: 'local' });
  const h2 = server.handoffs.get(s2.txId);
  h2.expiresAt = Date.now() - 1;
  const expired = server.getHandoffStatus(s2.txId, { workspaceId: null });
  assert.equal(expired?.status, 'expired');
  assert.equal(expired?.clientName, 'Muse Code');
});


test('loopback redirect accepts any port on later sign-ins (RFC 8252 7.3), nothing else loosens', () => {
  const origin = 'http://127.0.0.1:8799';
  const server = new McpOAuthServer(null);
  // Muse Code registers once, then listens on a fresh port for every later sign-in.
  const client = server.registerClient({
    client_name: 'Muse Code',
    redirect_uris: ['http://127.0.0.1:60551/oauth/callback/KqoeLzA3MxHl3OSsi2jhoQ'],
  });
  const start = (redirectUri) => {
    const pkce = makePkce();
    return server.startAuthorization(
      new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        resource: `${origin}/mcp`,
      }),
      origin,
    );
  };
  assert.notEqual(start('http://127.0.0.1:61165/oauth/callback/KqoeLzA3MxHl3OSsi2jhoQ').error, 'invalid_redirect_uri');
  assert.notEqual(start('http://127.0.0.1/oauth/callback/KqoeLzA3MxHl3OSsi2jhoQ').error, 'invalid_redirect_uri');
  for (const bad of [
    'http://127.0.0.1:61165/oauth/callback/other',
    'http://localhost:61165/oauth/callback/KqoeLzA3MxHl3OSsi2jhoQ',
    'http://127.0.0.1:61165/oauth/callback/KqoeLzA3MxHl3OSsi2jhoQ?x=1',
    'https://127.0.0.1:61165/oauth/callback/KqoeLzA3MxHl3OSsi2jhoQ',
    'http://evil.example:61165/oauth/callback/KqoeLzA3MxHl3OSsi2jhoQ',
    'http://user@127.0.0.1:61165/oauth/callback/KqoeLzA3MxHl3OSsi2jhoQ',
  ]) {
    assert.equal(start(bad).error, 'invalid_redirect_uri', bad);
  }

  // https redirects still need an exact match, port included.
  const web = server.registerClient({ client_name: 'Web', redirect_uris: ['https://app.example/cb'] });
  const pkce = makePkce();
  const webStart = server.startAuthorization(
    new URLSearchParams({
      client_id: web.client_id,
      redirect_uri: 'https://app.example:8443/cb',
      response_type: 'code',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      resource: `${origin}/mcp`,
    }),
    origin,
  );
  assert.equal(webStart.error, 'invalid_redirect_uri');

  assert.equal(inferAgentKind('Muse Code'), 'muse');
  assert.equal(inferAgentKind('Meta Muse'), 'meta-muse');
  assert.equal(inferAgentKind('Muse Agent'), 'meta-muse');
  assert.equal(inferAgentKind('GrokBot'), 'grok-bot');
  assert.equal(inferAgentKind('Claude Duet'), 'claude-duet');
  assert.equal(inferAgentKind('OpenMausBot'), 'openmausbot');
  assert.equal(inferAgentKind('OpenBot'), 'openbot');
  assert.equal(inferAgentKind('Museum Guide'), 'other');
});

test('Muse Code setup snippet tab, sign-in step, and OAuth handoff fallback UI', () => {
  const personalTabs = snippetTabsFor({ personal: true }).map(([id]) => id);
  const museTab = defaultSnippetTab('muse', { personal: true });
  assert.equal(museTab, 'json');
  assert.ok(personalTabs.includes(museTab), 'Muse default snippet tab must match an existing tab');
  assert.equal(signInStep('muse'), 'run `muse mcp login loop` in a terminal');

  const cbUrl = 'http://127.0.0.1:55536/oauth/callback/KqoeLzA3MxHl3OSsi2jhoQ?code=abc123&state=st1';
  const museHtml = renderOAuthHandoffFallback({ name: 'Muse Code', redirectUrl: cbUrl });
  assert.match(museHtml, /Press Enter to open it in your browser/);
  assert.match(museHtml, /--headless/);
  assert.ok(museHtml.includes('id="oauth-auth-code">http://127.0.0.1:55536/oauth/callback/KqoeLzA3MxHl3OSsi2jhoQ?code=abc123&amp;state=st1<'));
  assert.match(museHtml, /<button[^>]*id="oauth-open-callback"[^>]*>Retry redirect<\/button>/);
  assert.doesNotMatch(museHtml, /<a\b[^>]*id="oauth-open-callback"/);
  assert.match(museHtml, /id="oauth-copy-callback"/);
  assert.match(museHtml, /id="oauth-copy-code"/);

  const otherHtml = renderOAuthHandoffFallback({ name: 'Claude Code', redirectUrl: cbUrl });
  assert.ok(otherHtml.includes('id="oauth-auth-code">http://127.0.0.1:55536/oauth/callback/KqoeLzA3MxHl3OSsi2jhoQ?code=abc123&amp;state=st1<'));
  assert.match(otherHtml, /id="oauth-copy-callback"/);
  assert.match(otherHtml, /<button[^>]*id="oauth-open-callback"[^>]*>Retry redirect<\/button>/);
  assert.match(otherHtml, /id="oauth-copy-code"/);

  assert.equal(renderOAuthHandoffFallback({ name: 'Muse Code', redirectUrl: '' }), '');

  const ws = 'a'.repeat(64);
  assert.equal(isOAuthPublicCorsPath('/register'), true);
  assert.equal(isOAuthPublicCorsPath('/oauth/revoke'), true);
  assert.equal(isOAuthPublicCorsPath(`/w/${ws}/oauth/revoke`), true);
  assert.equal(isOAuthPublicCorsPath(`/w/${ws}/.well-known/oauth-authorization-server`), true);
  assert.equal(isOAuthPublicCorsPath(`/w/${ws}/.well-known/openid-configuration`), true);
  assert.equal(
    guardRequest(
      { method: 'GET', headers: { host: '127.0.0.1:8799', 'sec-fetch-site': 'cross-site', origin: 'https://client.example' } },
      `/w/${ws}/.well-known/oauth-authorization-server`,
      8799,
    ),
    null,
  );
  assert.equal(
    guardRequest(
      { method: 'GET', headers: { host: '127.0.0.1:8799', 'sec-fetch-site': 'cross-site' } },
      `/w/${ws}/oauth/authorize`,
      8799,
    ),
    null,
  );
});

test('Phase 0 security: OAuth refresh token cannot resurrect deleted/disabled agents or restore narrowed permissions', async (t) => {
  const fixture = await setupFixture(t);
  const srv = await fixture.start({ authMode: 'local-test', clerkApp: undefined, seedBuiltins: true });
  const base = `http://127.0.0.1:${srv.port}`;
  const mcpUrl = `${base}/mcp`;

  // Set up local Owner cookie
  const setupRes = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'phase0-owner-password' }),
  });
  assert.equal(setupRes.status, 200);
  const cookie = (setupRes.headers.get('set-cookie') || '').split(';')[0];
  const ownerHeaders = { 'Content-Type': 'application/json', Cookie: cookie };

  const redirectUri = 'http://127.0.0.1:53331/cb';
  async function mintOAuthSession(name, access) {
    const reg = await (await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    })).json();
    const pkce = makePkce();
    const authUrl = new URL(`${base}/oauth/authorize`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', reg.client_id);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('resource', mcpUrl);
    const txId = new URL((await fetch(authUrl, { redirect: 'manual' })).headers.get('location'), base).searchParams.get('loop-oauth');
    const approveRes = await fetch(`${base}/api/oauth/requests/${txId}/approve`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify(access ? { access } : {}),
    });
    assert.equal(approveRes.status, 200);
    const { redirectUrl } = await approveRes.json();
    const code = new URL(redirectUrl).searchParams.get('code');
    const tokenRes = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: reg.client_id,
        redirect_uri: redirectUri,
        code_verifier: pkce.verifier,
      }),
    });
    assert.equal(tokenRes.status, 200);
    const tokens = await tokenRes.json();
    assert.match(tokens.access_token, /^loop_/);
    assert.match(tokens.refresh_token, /^loop_rt_/);
    const agents = (await (await fetch(`${base}/api/agents`, { headers: { Cookie: cookie } })).json()).agents;
    const agent = agents.find((a) => a.name === name);
    assert.ok(agent, `expected agent ${name}`);
    return { clientId: reg.client_id, agent, ...tokens };
  }

  async function refreshWith(clientId, refreshToken) {
    const res = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
      }),
    });
    return { status: res.status, body: await res.json() };
  }

  // 1. Normal refresh succeeds when permissions are unchanged, and rotates the refresh token (replay fails).
  const s1 = await mintOAuthSession('Refresh Happy', {
    canManage: true,
    memoryAccess: 'read_write',
    allowedConnections: null,
    allowedSkills: null,
  });
  const rotated = await refreshWith(s1.clientId, s1.refresh_token);
  assert.equal(rotated.status, 200);
  assert.match(rotated.body.access_token, /^loop_/);
  assert.notEqual(rotated.body.access_token, s1.access_token);
  assert.notEqual(rotated.body.refresh_token, s1.refresh_token);
  const pingNew = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rotated.body.access_token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(pingNew.status, 200);
  const replay = await refreshWith(s1.clientId, s1.refresh_token);
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, 'invalid_grant');

  // 2. Narrowing permissions via PATCH /api/agents/:id invalidates refresh tokens and never restores withdrawn rights.
  const s2 = await mintOAuthSession('Refresh Narrow', {
    canManage: true,
    memoryAccess: 'read_write',
    allowedConnections: null,
    allowedSkills: null,
  });
  const narrowRes = await fetch(`${base}/api/agents/${encodeURIComponent(s2.agent.id)}`, {
    method: 'PATCH',
    headers: ownerHeaders,
    body: JSON.stringify({ canManage: false, allowedSkills: [] }),
  });
  assert.equal(narrowRes.status, 200);
  const afterNarrow = await refreshWith(s2.clientId, s2.refresh_token);
  assert.equal(afterNarrow.status, 400);
  assert.equal(afterNarrow.body.error, 'invalid_grant');
  const agentsAfterNarrow = (await (await fetch(`${base}/api/agents`, { headers: { Cookie: cookie } })).json()).agents;
  const s2Now = agentsAfterNarrow.find((a) => a.id === s2.agent.id);
  assert.equal(s2Now.canManage, false);
  assert.deepEqual(s2Now.allowedSkills, []);

  // 3. Disabling an Agent blocks refresh and keeps it disabled.
  const s3 = await mintOAuthSession('Refresh Disable');
  const disableRes = await fetch(`${base}/api/agents/${encodeURIComponent(s3.agent.id)}`, {
    method: 'PATCH',
    headers: ownerHeaders,
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disableRes.status, 200);
  const afterDisable = await refreshWith(s3.clientId, s3.refresh_token);
  assert.equal(afterDisable.status, 400);
  assert.equal(afterDisable.body.error, 'invalid_grant');
  const agentsAfterDisable = (await (await fetch(`${base}/api/agents`, { headers: { Cookie: cookie } })).json()).agents;
  assert.equal(agentsAfterDisable.find((a) => a.id === s3.agent.id).enabled, false);

  // 4. Deleting an Agent blocks refresh and never recreates/resurrects the Agent.
  const s4 = await mintOAuthSession('Refresh Delete');
  const delRes = await fetch(`${base}/api/agents/${encodeURIComponent(s4.agent.id)}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });
  assert.equal(delRes.status, 200);
  const afterDelete = await refreshWith(s4.clientId, s4.refresh_token);
  assert.equal(afterDelete.status, 400);
  assert.equal(afterDelete.body.error, 'invalid_grant');
  const agentsAfterDelete = (await (await fetch(`${base}/api/agents`, { headers: { Cookie: cookie } })).json()).agents;
  assert.equal(agentsAfterDelete.some((a) => a.id === s4.agent.id || a.name === 'Refresh Delete'), false);

  // 5. POST /oauth/revoke with a refresh token or access token kills the refresh family.
  const s5 = await mintOAuthSession('Refresh Revoke RT');
  const revRt = await fetch(`${base}/oauth/revoke`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: s5.clientId, token: s5.refresh_token, token_type_hint: 'refresh_token' }),
  });
  assert.equal(revRt.status, 200);
  assert.equal((await refreshWith(s5.clientId, s5.refresh_token)).status, 400);

  const s6 = await mintOAuthSession('Refresh Revoke AT');
  const revAt = await fetch(`${base}/oauth/revoke`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: s6.clientId, token: s6.access_token }),
  });
  assert.equal(revAt.status, 200);
  assert.equal((await refreshWith(s6.clientId, s6.refresh_token)).status, 400);
});
