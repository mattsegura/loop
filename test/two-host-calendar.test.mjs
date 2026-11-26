import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  discoverOAuthMetadata, discoverOAuthProtectedResourceMetadata, exchangeAuthorization, registerClient,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startServer } from '../server.mjs';

// Two synthetic accounts at one provider. Only a provider credential selects the calendar.
async function startCalendar(t, calls) {
  const calendar = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const account = { 'Bearer fixture-work': 'Work', 'Bearer fixture-personal': 'Personal' }[req.headers.authorization];
    if (!account) {
      res.writeHead(401).end();
      return;
    }
    const server = new Server({ name: 'calendar-fixture', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: ['next_meeting', 'create_event'].map(name => ({
        name, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: name === 'next_meeting' },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
      calls.push({ account, tool: params.name });
      return { content: [{ type: 'text', text: JSON.stringify({ account, title: account === 'Work' ? 'Design review' : 'Family dinner' }) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => void server.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise(resolve => calendar.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    calendar.close(resolve);
    calendar.closeAllConnections();
  }));
  return `http://127.0.0.1:${calendar.address().port}`;
}

async function authorizeHost(base, metadata, owner, name, connectionId) {
  const resource = new URL('/mcp', base);
  const redirectUri = 'https://host.example/callback';
  const client = await registerClient(base, {
    metadata,
    clientMetadata: { client_name: name, redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' },
  });
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL(metadata.authorization_endpoint);
  authorize.search = new URLSearchParams({
    response_type: 'code', client_id: client.client_id, resource: resource.href, redirect_uri: redirectUri,
    state: 'fixture-state', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  });
  const consent = await fetch(authorize, { redirect: 'manual' });
  assert.equal(consent.status, 302);
  const requestId = new URL(consent.headers.get('location'), base).searchParams.get('loop-oauth');
  assert.ok(requestId);
  const approved = await owner(`/api/oauth/requests/${requestId}/approve`, {
    profile: 'all',
    access: {
      allowedConnections: [connectionId], toolGrants: { [connectionId]: ['next_meeting'] },
      allowedSkills: [], secrets: [], canManage: false, memoryAccess: 'none',
    },
  });
  const callback = new URL(approved.redirectUrl);
  assert.equal(callback.searchParams.get('state'), 'fixture-state');
  const tokens = await exchangeAuthorization(base, {
    metadata, clientInformation: client, authorizationCode: callback.searchParams.get('code'), codeVerifier: verifier, redirectUri, resource,
  });
  return { clientId: client.client_id, token: tokens.access_token };
}

test('two OAuth hosts reuse one Work calendar connection and revoking one preserves the other', { timeout: 15_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'loop-two-host-calendar-'));
  const calls = [];
  const calendarUrl = await startCalendar(t, calls);
  const loop = await startServer({
    port: 0, dataDir, authMode: 'local-test', detectLocalAgents: false, seedBuiltins: false,
    searchEnv: { LOOP_EMBEDDING_PROVIDER: 'off' },
  });
  t.after(async () => { await loop.close(); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${loop.port}`;
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ password: 'fixture-owner-password' }),
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  async function owner(route, body) {
    const result = await fetch(base + route, {
      method: 'POST', headers: { ...jsonHeaders, Cookie: cookie }, body: JSON.stringify(body),
    });
    assert.ok(result.ok, `${route} returned ${result.status}`);
    return result.json();
  }
  async function addCalendar(name, token) {
    const { mcp } = await owner('/api/mcps', { name, transport: 'http', url: `${calendarUrl}/${name}`, token });
    assert.ok(mcp.tools.some(tool => tool.name === 'next_meeting'));
    return mcp.id;
  }
  const work = await addCalendar('Work', 'fixture-work');
  const personal = await addCalendar('Personal', 'fixture-personal');

  const protectedResource = await discoverOAuthProtectedResourceMetadata(new URL('/mcp', base));
  const metadata = await discoverOAuthMetadata(protectedResource.authorization_servers[0]);
  const first = await authorizeHost(base, metadata, owner, 'OpenMausBot', work);
  const second = await authorizeHost(base, metadata, owner, 'Grok', work);
  assert.notEqual(first.clientId, second.clientId);
  assert.notEqual(first.token, second.token);

  function call(host, name, args) {
    return fetch(`${base}/mcp`, {
      method: 'POST', headers: { ...jsonHeaders, Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
  }
  async function value(host, name, args) {
    const response = await call(host, name, args);
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.ok(reply.result && !reply.result.isError, JSON.stringify(reply));
    return JSON.parse(reply.result.content[0].text);
  }
  const expectedMeeting = { account: 'Work', title: 'Design review' };
  const workTool = `${work}__next_meeting`;
  for (const host of [first, second]) {
    const directory = await value(host, 'loop__search', { type: 'connections' });
    assert.deepEqual(directory.connections.map(connection => connection.id), [work]);
    const search = await value(host, 'loop__search', { type: 'tools', connection: work });
    assert.deepEqual(search.tools.map(tool => tool.tool), [workTool]);
    const tool = await value(host, 'loop__inspect', { type: 'tool', id: search.tools[0].tool });
    assert.equal(tool.tool, workTool);
    assert.deepEqual(await value(host, 'loop__run', { tool: tool.tool, arguments: {} }), expectedMeeting);
    for (const prohibited of [`${personal}__next_meeting`, `${work}__create_event`]) {
      const response = await call(host, 'loop__run', { tool: prohibited, arguments: {} });
      const reply = await response.json();
      assert.ok(reply.error || reply.result?.isError, `Expected denial for ${prohibited}`);
    }
    const headers = { ...jsonHeaders, Authorization: `Bearer ${host.token}` };
    for (const path of ['/api/saved', '/api/files']) {
      const denied = await fetch(base + path, { headers });
      assert.equal(denied.status, 403, `An app-only token cannot list ${path}`);
    }
    const saved = await fetch(base + '/api/saved', {
      method: 'POST', headers, body: JSON.stringify({ note: 'synthetic out-of-scope note' }),
    });
    assert.equal(saved.status, 403, 'An app-only token cannot save notes');
  }
  assert.equal(metadata.revocation_endpoint, `${base}/oauth/revoke`);
  const revoked = await fetch(metadata.revocation_endpoint, {
    method: 'POST', body: new URLSearchParams({ token: first.token, client_id: first.clientId }),
  });
  assert.equal(revoked.status, 200);
  assert.equal((await call(first, 'loop__run', { tool: workTool, arguments: {} })).status, 401);
  assert.deepEqual(await value(second, 'loop__run', { tool: workTool, arguments: {} }), expectedMeeting);
  assert.deepEqual(calls, Array(3).fill({ account: 'Work', tool: 'next_meeting' }));
});
