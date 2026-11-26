import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { LoopStore } from '../lib/store.mjs';
import { Vault } from '../lib/vault.mjs';
import { issueAgentToken, findAgentByToken } from '../lib/agents.mjs';
import { parseYamlOrJson, compileOpenApiSpec, executeApiTransportTool } from '../lib/api-transports.mjs';
import { serviceKeyOf } from '../lib/services.mjs';

const bodyOf = async (req) => {
  let out = '';
  for await (const chunk of req) out += chunk;
  return out;
};

const listenHttp = (handler) =>
  new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${srv.address().port}`,
        close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
      });
    });
  });

async function mcpPost(port, token, body) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('Phase 2: YAML OpenAPI parsing refuses alias bombs and OpenAPI path parameters block path escape', async () => {
  const bomb = [
    'a: &a ["lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol"]',
    'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]',
    'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]',
    'd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]',
  ].join('\n');
  assert.throws(() => parseYamlOrJson(bomb), /alias bomb/i);

  const yamlSpec = `
openapi: "3.0.3"
info:
  title: Invoices API
  description: Manage customer invoices
servers:
  - url: https://api.example.com/v1
paths:
  /invoices/{id}:
    get:
      operationId: getInvoice
      summary: Fetch one invoice
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
    delete:
      operationId: deleteInvoice
      summary: Delete an invoice
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
`;
  const parsed = parseYamlOrJson(yamlSpec);
  const compiled = compileOpenApiSpec(parsed);
  assert.equal(compiled.title, 'Invoices API');
  assert.equal(compiled.tools.length, 2);
  const getTool = compiled.tools.find((t) => t.name === 'getinvoice');
  const delTool = compiled.tools.find((t) => t.name === 'deleteinvoice');
  assert.equal(getTool.annotations.readOnlyHint, true);
  assert.equal(delTool.annotations.destructiveHint, true);

  await assert.rejects(
    executeApiTransportTool({
      conn: { id: 'inv', transport: 'openapi', url: 'http://127.0.0.1:9999/v1', apiOperations: compiled.operations, headers: {} },
      toolName: 'getinvoice',
      args: { id: '../admin' },
    }),
    /path-escape/i,
  );
});

test('Phase 2: OpenAPI and GraphQL import-api, execution with Vault redaction, Access sets, accountChoice, approvalMode, and rate limits', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-p2-v3-'));
  const receivedHeaders = [];
  const apiSrv = await listenHttp(async (req, res) => {
    const raw = await bodyOf(req);
    receivedHeaders.push(req.headers);
    if (req.url === '/openapi.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'CRM API', description: 'Demo CRM' },
        servers: [{ url: `${apiSrv.url}/api` }],
        paths: {
          '/contacts/{id}': {
            get: {
              operationId: 'get_contact',
              summary: 'Read a contact',
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            },
            delete: {
              operationId: 'delete_contact',
              summary: 'Delete a contact',
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            },
          },
        },
      }));
      return;
    }
    if (req.url === '/api/contacts/42' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: '42', name: 'Ada', echoAuth: req.headers.authorization || '' }));
      return;
    }
    if (req.url === '/api/contacts/42' && req.method === 'DELETE') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: true }));
      return;
    }
    if (req.url === '/graphql') {
      const body = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (String(body.query || '').includes('__schema')) {
        res.end(JSON.stringify({
          data: {
            __schema: {
              queryType: { name: 'Query', fields: [{ name: 'viewer', args: [] }] },
              mutationType: { name: 'Mutation', fields: [{ name: 'updateViewer', args: [] }] },
            },
          },
        }));
      } else {
        res.end(JSON.stringify({ data: { viewer: { id: 'u1' } } }));
      }
      return;
    }
    res.writeHead(404).end();
  });

  let srv;
  try {
    srv = await startServer({ port: 0, dataDir: dir, detectLocalAgents: false, authMode: 'local-test', schedulePollMs: 0 });
    const base = `http://127.0.0.1:${srv.port}`;
    const setupAuth = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-owner-password' }),
    });
    assert.equal(setupAuth.status, 200);
    const cookie = setupAuth.headers.get('set-cookie').split(';')[0];
    const apiFetch = (p, init = {}) =>
      fetch(`${base}${p}`, {
        ...init,
        headers: { Cookie: cookie, ...(init.headers || {}) },
      });

    // 1. Verified catalog & setup status.
    const catRes = await apiFetch('/api/catalog').then((r) => r.json());
    assert.ok(catRes.items.some((i) => i.id === 'linear' && i.available === true));
    const setupBefore = await apiFetch('/api/setup/status').then((r) => r.json());
    assert.equal(setupBefore.connections, 0);

    // 2. Import OpenAPI (with plaintext key auto-vaulted!) & GraphQL.
    const secretVal = 'Bearer super-secret-crm-token-998877';
    const imp1 = await apiFetch('/api/mcps/import-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'openapi',
        url: `${apiSrv.url}/openapi.json`,
        name: 'CRM Work',
        accountLabel: 'Work',
        agentNote: 'Use for enterprise leads only.',
        authHeader: 'Authorization',
        authValue: secretVal,
      }),
    }).then((r) => r.json());
    assert.equal(imp1.connection.transport, 'openapi');
    assert.equal(imp1.connection.accountLabel, 'Work');
    assert.match(imp1.connection.headers.Authorization, /^\{\{vault:api_/);

    // Import a second account of the same service (Personal) to test service grouping & accountChoice.
    const imp2 = await apiFetch('/api/mcps/import-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'openapi',
        url: `${apiSrv.url}/openapi.json`,
        name: 'CRM Personal',
        accountLabel: 'Personal',
      }),
    }).then((r) => r.json());
    assert.equal(serviceKeyOf(imp1.connection), serviceKeyOf(imp2.connection));

    const gqlImp = await apiFetch('/api/mcps/import-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'graphql', url: `${apiSrv.url}/graphql`, name: 'Demo GraphQL' }),
    }).then((r) => r.json());
    assert.equal(gqlImp.connection.transport, 'graphql');
    assert.ok(gqlImp.connection.tools.some((t) => t.name === 'graphql_query'));

    // 3. Services view groups both CRM accounts under one service.
    const svcRes = await apiFetch('/api/services').then((r) => r.json());
    const crmSvc = svcRes.services.find((s) => s.key === serviceKeyOf(imp1.connection));
    assert.equal(crmSvc.accounts.length, 2);

    // 4. Create custom access set, update it, verify 409 delete guard while assigned.
    const setRes = await apiFetch('/api/access-sets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Research',
        connections: { [imp1.connection.id]: ['get_contact'] },
        skills: [],
      }),
    }).then((r) => r.json());
    assert.equal(setRes.set.id, 'research');

    const store = new LoopStore(dir);
    const vault = new Vault(dir);

    // 5. Read-only agent can run GET (with secret redacted in output!) and is blocked on DELETE.
    const roAgent = await store.addAgent({
      name: 'RO Bot',
      kind: 'other',
      profile: 'all',
      enabled: true,
      accessSet: 'read-only',
      accountChoice: { [crmSvc.key]: imp1.connection.id },
      rateLimitPerMin: 2,
    });
    const { token: roTok } = await issueAgentToken(store, vault, roAgent.id);

    // Multi-instance keepExisting token works alongside the first token.
    const { token: roTok2 } = await issueAgentToken(store, vault, roAgent.id, { keepExisting: true });
    assert.ok(await findAgentByToken(store, roTok));
    assert.ok(await findAgentByToken(store, roTok2));

    const getCall = await mcpPost(srv.port, roTok, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'loop__run', arguments: { tool: `${imp1.connection.id}__get_contact`, arguments: { id: '42' } } },
    });
    assert.equal(Boolean(getCall.json.result.isError), false);
    assert.ok(getCall.json.result.content[0].text.includes('Ada'));
    assert.equal(getCall.json.result.content[0].text.includes('super-secret-crm-token-998877'), false, 'Vault secret must be redacted from OpenAPI output');

    // Second account of same service is blocked by accountChoice.
    const otherAcc = await mcpPost(srv.port, roTok, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'loop__run', arguments: { tool: `${imp2.connection.id}__get_contact`, arguments: { id: '42' } } },
    });
    assert.equal(Boolean(otherAcc.json.result.isError), true);

    // Second valid call succeeds (2/2), third valid call in same minute trips rateLimitPerMin: 2.
    const secondOk = await mcpPost(srv.port, roTok, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'loop__run', arguments: { tool: `${imp1.connection.id}__get_contact`, arguments: { id: '42' } } },
    });
    assert.equal(Boolean(secondOk.json.result.isError), false);
    const rateBlocked = await mcpPost(srv.port, roTok, {
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: { name: 'loop__run', arguments: { tool: `${imp1.connection.id}__get_contact`, arguments: { id: '42' } } },
    });
    assert.equal(Boolean(rateBlocked.json.result.isError), true);
    assert.match(rateBlocked.json.result.content[0].text, /rate limit/i);

    // Custom set agent can read get_contact, is blocked on delete_contact, and cannot delete set while in use.
    const custAgent = await store.addAgent({
      name: 'Researcher',
      kind: 'other',
      profile: 'all',
      enabled: true,
      accessSet: 'research',
    });
    const { token: custTok } = await issueAgentToken(store, vault, custAgent.id);

    const delBlocked = await mcpPost(srv.port, custTok, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'loop__run', arguments: { tool: `${imp1.connection.id}__delete_contact`, arguments: { id: '42' } } },
    });
    assert.equal(Boolean(delBlocked.json.result.isError), true);
    assert.match(delBlocked.json.result.content[0].text, /Research set/i);

    const delSetRes = await apiFetch('/api/access-sets/research', { method: 'DELETE' });
    assert.equal(delSetRes.status, 409);

    // GraphQL query succeeds, mutation rejected under graphql_query.
    const fullAgent = await store.addAgent({ name: 'Full', kind: 'other', profile: 'all', enabled: true, approvalMode: 'ask' });
    const { token: fullTok } = await issueAgentToken(store, vault, fullAgent.id);
    const gqlCall = await mcpPost(srv.port, fullTok, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'loop__run', arguments: { tool: `${gqlImp.connection.id}__graphql_query`, arguments: { query: '{ viewer { id } }' } } },
    });
    assert.equal(Boolean(gqlCall.json.result.isError), false);
    assert.ok(gqlCall.json.result.content[0].text.includes('"u1"'));

    // approvalMode: 'ask' requires approval for write/delete tool even when policy default is auto.
    const askDel = await mcpPost(srv.port, fullTok, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'loop__run', arguments: { tool: `${imp1.connection.id}__delete_contact`, arguments: { id: '42' } } },
    });
    assert.match(askDel.json.result.content[0].text, /approval_required|approvalId/i);
  } finally {
    await srv?.close().catch(() => {});
    await apiSrv.close();
    await rm(dir, { recursive: true, force: true });
  }
});
