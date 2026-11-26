import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';
import { LoopStore } from '../lib/store.mjs';
import { handleMcpRequest } from '../lib/mcp-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const stdioBridgePath = path.join(projectRoot, 'stdio.mjs');

const MOCK_HTTP_TOKEN = 'mock-http-bearer-secret-7788';
const MOCK_STDIO_SECRET = 'mock-stdio-vault-secret-4455';

// With oauth: true the mock also acts as its own sign-in server (metadata, client registration,
// token exchange), handing out the token it currently accepts.
async function startMockHttpMcpServer(expectedToken, { oauth = false } = {}) {
  const receivedAuthHeaders = [];
  let acceptedToken = expectedToken;
  let authorizeEndpoint = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const sendJsonReply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (oauth && req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return sendJsonReply(200, {
        issuer: origin,
        authorization_endpoint: authorizeEndpoint || `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
      });
    }
    if (oauth && req.method === 'POST' && url.pathname === '/register') {
      return sendJsonReply(201, { client_id: 'mock-oauth-client' });
    }
    if (oauth && req.method === 'POST' && url.pathname === '/token') {
      return sendJsonReply(200, { access_token: acceptedToken, token_type: 'Bearer', expires_in: 3600 });
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (req.method === 'DELETE') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const authHeader = req.headers.authorization || '';
    receivedAuthHeaders.push(authHeader);
    if (acceptedToken && authHeader !== `Bearer ${acceptedToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));

    // Notifications (no id) -> 202 Accepted
    if (body.id === undefined || body.id === null) {
      res.writeHead(202);
      res.end();
      return;
    }

    const reply = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    };

    const fail = (code, message) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code, message } }));
    };

    switch (body.method) {
      case 'initialize':
        return reply({
          protocolVersion: '2025-03-26',
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: {
            name: 'mock-http-mcp',
            version: '1.0.0',
            description: 'Mock cloud HTTP service for integration tests.',
          },
        });

      case 'ping':
        return reply({});

      case 'tools/list':
        return reply({
          tools: [
            {
              name: 'echo',
              description: 'Echo a message back from the HTTP mock server',
              annotations: { readOnlyHint: true },
              inputSchema: {
                type: 'object',
                properties: {
                  message: { type: 'string', description: 'Message to echo' },
                },
                required: ['message'],
              },
            },
            {
              name: 'design_palette',
              description: 'Generate a color palette for a design theme',
              annotations: { readOnlyHint: true },
              inputSchema: {
                type: 'object',
                properties: {
                  theme: { type: 'string', description: 'Theme name' },
                },
                required: ['theme'],
              },
            },
          ],
        });

      case 'tools/call': {
        const { name, arguments: toolArgs = {} } = body.params || {};
        if (name === 'echo') {
          if (toolArgs.message === '__trigger_unauthorized__') {
            return fail(-32000, 'Upstream rejected: unauthorized resource access');
          }
          return reply({
            content: [
              {
                type: 'text',
                text: `http-echo:${toolArgs.message ?? ''}`,
              },
            ],
          });
        }
        if (name === 'design_palette') {
          return reply({
            content: [
              {
                type: 'text',
                text: `palette:${toolArgs.theme ?? 'default'}:#111111,#ffffff`,
              },
            ],
          });
        }
        return fail(-32602, `Unknown tool: ${name}`);
      }

      case 'resources/list':
        return reply({
          resources: [
            {
              uri: 'mock://docs/guide',
              name: 'Design Guide',
              description: 'Reference guide for Loop mock HTTP server',
              mimeType: 'text/plain',
            },
          ],
        });

      case 'resources/read': {
        const uri = body.params?.uri;
        if (uri === 'mock://docs/guide') {
          return reply({
            contents: [
              {
                uri,
                mimeType: 'text/plain',
                text: 'Loop Mock Design Guide v1',
              },
            ],
          });
        }
        return fail(-32602, `Unknown resource: ${uri}`);
      }

      case 'prompts/list':
        return reply({
          prompts: [
            {
              name: 'summarize',
              description: 'Summarize a topic clearly',
              arguments: [{ name: 'topic', description: 'Topic name', required: true }],
            },
          ],
        });

      case 'prompts/get': {
        const name = body.params?.name;
        const topic = body.params?.arguments?.topic || 'general';
        if (name === 'summarize') {
          return reply({
            description: 'Summarize prompt',
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: `Please summarize: ${topic}`,
                },
              },
            ],
          });
        }
        return fail(-32602, `Unknown prompt: ${name}`);
      }

      default:
        return fail(-32601, `Method not found: ${body.method}`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    receivedAuthHeaders,
    setAcceptedToken(token) {
      acceptedToken = token;
    },
    setAuthorizeEndpoint(endpoint) {
      authorizeEndpoint = endpoint;
    },
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeIdleConnections === 'function') {
          server.closeIdleConnections();
        }
      });
    },
  };
}

async function createMockStdioScript(dir) {
  const serverModUrl = import.meta.resolve('@modelcontextprotocol/sdk/server/index.js');
  const stdioModUrl = import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js');
  const typesModUrl = import.meta.resolve('@modelcontextprotocol/sdk/types.js');

  const script = `
import { Server } from ${JSON.stringify(serverModUrl)};
import { StdioServerTransport } from ${JSON.stringify(stdioModUrl)};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(typesModUrl)};

const server = new Server(
  { name: 'mock-stdio-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'read_secret_env',
      description: 'Return injected MOCK_STDIO_SECRET env value',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'add_numbers',
      description: 'Add two numbers together',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
      },
      annotations: { readOnlyHint: true },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (name === 'read_secret_env') {
    return {
      content: [{ type: 'text', text: process.env.MOCK_STDIO_SECRET || '' }],
    };
  }
  if (name === 'add_numbers') {
    return {
      content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }],
    };
  }
  throw new Error('Unknown tool: ' + name);
});

const transport = new StdioServerTransport();
await server.connect(transport);
`;

  const scriptPath = path.join(dir, 'mock-stdio-mcp.mjs');
  await writeFile(scriptPath, script, 'utf8');
  return scriptPath;
}

it('indents visible connections under their categories and distinguishes repeated names', async () => {
  const store = { list: async () => [
    { id: 'brush_2', name: 'Brush', enabled: false, authRequired: true, lastError: 'old error' },
    { id: 'inbox', name: 'Inbox', enabled: true },
    { id: 'brush', name: 'Brush', enabled: true, profiles: ['work'], command: 'brush',
      tools: [{ name: 'draw' }, { name: 'erase' }], disabledTools: ['erase'] },
    { id: 'paper', name: 'Paper', enabled: true, authRequired: true, lastError: 'sign in' },
    { id: 'shelf', name: 'Shelf', enabled: true, lastError: 'offline' },
    { id: 'keyed', name: 'Keyed', enabled: true, authRequired: true, lastError: 'Sign in required.',
      headers: { Authorization: 'Bearer {{vault:conn_keyed_token}}' } },
  ] };
  const catStore = { load: async () => ({
    categories: [{ id: 'studio', label: 'Studio' }],
    connections: { brush: 'studio', brush_2: 'studio' },
  }) };
  async function inventory(profile) {
    const { result } = await handleMcpRequest(store, null, null, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'loop__search', arguments: { type: 'connections' } },
    }, { catStore, profile });
    assert.equal(result.isError, false);
    return JSON.parse(result.content[0].text);
  }

  const all = await inventory('all');
  assert.equal(all.visualFormat, undefined);
  assert.equal(all.visual, undefined);
  assert.equal(all.displayHint, undefined);
  assert.deepEqual(all.summary, {
    total: 5, local: 1, cloud: 4, ready: 1, needsSignIn: 1, tokenRejected: 1, failed: 1, disabled: 0, notSynced: 1, totalTools: 1,
  });
  assert.equal(all.connections.some((c) => c.id === 'brush_2'), false);
  // A rejected key gets the place to paste a new one, never a sign-in link.
  const keyed = all.connections.find((c) => c.id === 'keyed');
  assert.equal(keyed.signInUrl, undefined);
  assert.equal(keyed.updateKeyUrl, 'http://127.0.0.1:8799/#connections?conn=keyed');
  assert.equal(all.connections.find((c) => c.id === 'paper').signInUrl, 'http://127.0.0.1:8799/#connections?signin=paper');
  const work = await inventory('work');
  assert.equal(work.total, 1);
  assert.equal(work.connections[0].id, 'brush');
  const empty = await inventory('empty');
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.connections, []);
});

describe('Loop MCP Gateway End-to-End', () => {
  let tempDir;
  let dataDir;
  let mockHttp;
  let mockStdioScript;
  let loopServer;
  let baseUrl;
  let httpConnId;
  let stdioConnId;
  let ownerAgentId;
  let ownerToken;
  let sessionCookie = '';

  async function api(route, options = {}) {
    const res = await fetch(`${baseUrl}${route}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(sessionCookie ? { Cookie: sessionCookie } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { status: res.status, headers: res.headers, json };
  }

  async function mcpRpc(method, params, { query = '', id = 1 } = {}) {
    const body = { jsonrpc: '2.0', method };
    if (id !== null && id !== undefined) body.id = id;
    if (params !== undefined) body.params = params;
    return api(`/mcp${query}`, {
      method: 'POST',
      headers: ownerToken ? { Authorization: `Bearer ${ownerToken}` } : {},
      body: JSON.stringify(body),
    });
  }

  before(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'loop-e2e-'));
    dataDir = path.join(tempDir, 'data');
    mockHttp = await startMockHttpMcpServer(MOCK_HTTP_TOKEN);
    mockStdioScript = await createMockStdioScript(tempDir);
    loopServer = await startServer({ authMode: 'local-test', port: 0, dataDir });
    baseUrl = `http://127.0.0.1:${loopServer.port}`;
    const setup = await fetch(`${baseUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-owner-password' }),
    });
    assert.equal(setup.status, 200);
    sessionCookie = setup.headers.get('set-cookie').split(';')[0];
    const owner = await api('/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test Owner', kind: 'other', profile: 'all', canManage: true }),
    });
    assert.equal(owner.status, 201);
    ownerAgentId = owner.json.agent.id;
    ownerToken = owner.json.token;
  });

  after(async () => {
    if (loopServer) await loopServer.close();
    if (mockHttp) await mockHttp.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('gives Home its feed: memory conflicts, recent activity and today counts, without values', async () => {
    const first = await api('/api/memory', { method: 'POST', body: JSON.stringify({ key: 'home-feed-a', content: 'Never use emojis in commit messages' }) });
    const second = await api('/api/memory', {
      method: 'POST',
      body: JSON.stringify({ key: 'home-feed-b', content: 'Use emojis in commit messages', links: [{ target: 'home-feed-a', relation: 'contradicts' }] }),
    });
    const dupA = await api('/api/memory', { method: 'POST', body: JSON.stringify({ key: 'home-dup-a', content: 'Loop hub ships as plain JavaScript modules without a bundler step', scope: 'project' }) });
    const dupB = await api('/api/memory', { method: 'POST', body: JSON.stringify({ key: 'home-dup-b', content: 'Loop hub ships as plain JavaScript modules, without a bundler step.', scope: 'project', writtenBy: 'Claude' }) });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(dupA.status, 201);
    assert.equal(dupB.status, 201);
    try {
      const overview = await api('/api/overview');
      assert.equal(overview.status, 200);
      const home = overview.json.home;
      assert.ok(home && typeof home === 'object');
      assert.ok(Array.isArray(home.activity));
      assert.deepEqual(Object.keys(home.today).sort(), ['memorySaves', 'secretUses', 'toolCalls']);
      assert.equal(typeof home.vaultByType, 'object');
      assert.ok(home.conflictsTotal >= 1);
      const pair = home.conflicts.find((c) => [c.a.id, c.b.id].includes(first.json.memory.id));
      assert.ok(pair, 'the contradicting pair is listed');
      assert.equal(pair.kind, 'contradiction');
      assert.deepEqual(Object.keys(pair.a).sort(), ['content', 'id', 'source', 'writtenBy']);
      const dupLeak = home.conflicts.find((c) => [c.a.id, c.b.id].includes(dupA.json.memory.id));
      assert.equal(dupLeak, undefined, 'near-duplicate overlaps stay in Memory -> Tidy and do not appear as Home disagreements');
      assert.ok(Array.isArray(overview.json.categories));
    } finally {
      await api(`/api/memory/${first.json.memory.id}`, { method: 'DELETE' });
      await api(`/api/memory/${second.json.memory.id}`, { method: 'DELETE' });
      await api(`/api/memory/${dupA.json.memory.id}`, { method: 'DELETE' });
      await api(`/api/memory/${dupB.json.memory.id}`, { method: 'DELETE' });
    }
  });

  it('serves /health, /api/overview, /api/vault, /api/settings, and /api/export', async () => {
    const health = await api('/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { app: 'loop-hub', ok: true });

    const overview = await api('/api/overview');
    assert.equal(overview.status, 200);
    assert.equal(overview.json.port, loopServer.port);
    assert.equal(overview.json.endpoint, `${baseUrl}/mcp`);
    assert.deepEqual(overview.json.settings, { defaultProfile: 'all', requireAgentToken: true, paused: false, turnRecall: false });
    assert.equal(overview.json.stats.connectionsTotal, 0);

    // Vault REST endpoints
    const badVault = await api('/api/vault', {
      method: 'POST',
      body: JSON.stringify({ key: '__reserved', value: 'nope' }),
    });
    assert.equal(badVault.status, 400);

    const createdSecret = await api('/api/vault', {
      method: 'POST',
      body: JSON.stringify({
        key: 'STDIO_API_KEY',
        value: MOCK_STDIO_SECRET,
        description: 'Key injected into mock stdio MCP',
      }),
    });
    assert.equal(createdSecret.status, 201);
    assert.equal(createdSecret.json.secret.key, 'STDIO_API_KEY');
    assert.equal(createdSecret.json.secret.masked, '••••');

    const vaultList = await api('/api/vault');
    assert.equal(vaultList.status, 200);
    assert.equal(vaultList.json.secrets.length, 1);
    assert.equal(vaultList.json.secrets[0].key, 'STDIO_API_KEY');

    // Create and delete a temporary secret via REST API
    const tempSecret = await api('/api/vault', {
      method: 'POST',
      body: JSON.stringify({ key: 'TEMP_SECRET', value: 'temporary-9999' }),
    });
    assert.equal(tempSecret.status, 201);
    const delSecret = await api('/api/vault/TEMP_SECRET', { method: 'DELETE' });
    assert.equal(delSecret.status, 200);
    assert.deepEqual(delSecret.json, { removed: true });
    const delMissing = await api('/api/vault/TEMP_SECRET', { method: 'DELETE' });
    assert.equal(delMissing.status, 404);

    // Settings GET & PATCH
    const settingsGet = await api('/api/settings');
    assert.equal(settingsGet.status, 200);
    assert.deepEqual(settingsGet.json.settings, { defaultProfile: 'all', requireAgentToken: true, paused: false, turnRecall: false });

    const settingsPatch = await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ defaultProfile: 'design', requireAgentToken: true }),
    });
    assert.equal(settingsPatch.status, 200);
    assert.deepEqual(settingsPatch.json.settings, { defaultProfile: 'design', requireAgentToken: true, paused: false, turnRecall: false });

    // Reset back to all for subsequent tests
    const settingsReset = await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ defaultProfile: 'all', requireAgentToken: true }),
    });
    assert.equal(settingsReset.status, 200);
    assert.deepEqual(settingsReset.json.settings, { defaultProfile: 'all', requireAgentToken: true, paused: false, turnRecall: false });

    // Export
    const exported = await api('/api/export');
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition') || '', /loop-config\.json/);
    assert.ok(exported.json.exportedAt);
    assert.deepEqual(exported.json.settings, { defaultProfile: 'all', requireAgentToken: true, paused: false, turnRecall: false });
    assert.deepEqual(exported.json.mcps, []);
  });

  it('adds HTTP (token auto-saved to Vault) and stdio ({{vault:KEY}} env) connections via REST API', async () => {
    const httpRes = await api('/api/mcps', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Mock HTTP',
        transport: 'http',
        url: mockHttp.url,
        token: MOCK_HTTP_TOKEN,
        profiles: ['design'],
      }),
    });

    assert.equal(httpRes.status, 201);
    const httpMcp = httpRes.json.mcp;
    httpConnId = httpMcp.id;
    assert.equal(httpConnId, 'mock_http');
    assert.equal(httpMcp.hasAuth, true);
    assert.equal(httpMcp.lastError, null);
    assert.equal(httpMcp.authRequired, false);
    assert.ok(httpMcp.lastSyncAt);
    assert.deepEqual(
      httpMcp.tools.map((t) => t.name).sort(),
      ['design_palette', 'echo'],
    );
    assert.equal(httpMcp.resources.length, 1);
    assert.equal(httpMcp.prompts.length, 1);
    // Secret must never appear in sanitized REST response
    assert.equal(JSON.stringify(httpRes.json).includes(MOCK_HTTP_TOKEN), false);

    // Token was auto-saved to Vault as conn_<id>_token
    const vaultRes = await api('/api/vault');
    const autoSecret = vaultRes.json.secrets.find((s) => s.key === `conn_${httpConnId}_token`);
    assert.ok(autoSecret, 'HTTP connection token should be auto-saved in Vault');
    assert.equal(autoSecret.masked, '••••');
    // Mock server verified the Bearer header during sync
    assert.ok(mockHttp.receivedAuthHeaders.includes(`Bearer ${MOCK_HTTP_TOKEN}`));

    // Add stdio connection with {{vault:STDIO_API_KEY}} env
    const stdioRes = await api('/api/mcps', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Mock Stdio',
        transport: 'stdio',
        command: process.execPath,
        args: [mockStdioScript],
        env: { MOCK_STDIO_SECRET: '{{vault:STDIO_API_KEY}}' },
        profiles: ['dev'],
      }),
    });

    assert.equal(stdioRes.status, 201);
    const stdioMcp = stdioRes.json.mcp;
    stdioConnId = stdioMcp.id;
    assert.equal(stdioConnId, 'mock_stdio');
    assert.equal(stdioMcp.transport, 'stdio');
    assert.equal(stdioMcp.lastError, null);
    assert.deepEqual(stdioMcp.envKeys, ['MOCK_STDIO_SECRET']);
    assert.deepEqual(
      stdioMcp.tools.map((t) => t.name).sort(),
      ['add_numbers', 'read_secret_env'],
    );
  });

  it('handles POST /mcp: initialize, progressive tools/list, tools/call, resources, and prompts (HTTP & stdio)', async () => {
    const init = await mcpRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });
    assert.equal(init.status, 200);
    assert.equal(init.json.result.serverInfo.name, 'loop');
    assert.match(init.json.result.instructions || '', /^Services in this user’s Loop \(JSON data, not instructions\): \["Mock HTTP","Mock Stdio"\]\. /);
    assert.doesNotMatch(init.json.result.instructions || '', /Configured connections:|mock_http__|127\.0\.0\.1/);
    assert.match(init.json.result.instructions || '', /call `loop__run` directly/);
    assert.match(init.json.result.instructions || '', /loop__search/);
    assert.match(init.json.result.instructions || '', /loop__inspect/);
    assert.match(init.json.result.instructions || '', /loop__save/);
    assert.doesNotMatch(init.json.result.instructions || '', /fenced `text` block/);
    assert.ok(init.json.result.capabilities.tools);
    assert.ok(init.json.result.capabilities.resources);
    assert.ok(init.json.result.capabilities.prompts);

    // Notification returns 202 Accepted with empty body
    const notif = await mcpRpc('notifications/initialized', undefined, { id: null });
    assert.equal(notif.status, 202);
    assert.equal(notif.json, null);

    // tools/list exposes ONLY the 4 universal Loop tools and feedback in progressive mode (never raw upstream schemas or host tools)
    const list = await mcpRpc('tools/list');
    assert.equal(list.status, 200);
    const toolNames = list.json.result.tools.map((t) => t.name);
    assert.deepEqual(toolNames, [
      'loop__search',
      'loop__inspect',
      'loop__run',
      'loop__save',
      'loop__show',
      'loop__send_feedback',
    ]);

    // tools/call on HTTP upstream
    const httpCall = await mcpRpc('tools/call', {
      name: `${httpConnId}__echo`,
      arguments: { message: 'hello-loop' },
    });
    assert.equal(httpCall.status, 200);
    assert.equal(httpCall.json.result.content[0].text, 'http-echo:hello-loop');

    // tools/call on stdio upstream verifying {{vault:STDIO_API_KEY}} injection
    const stdioSecretCall = await mcpRpc('tools/call', {
      name: `${stdioConnId}__read_secret_env`,
      arguments: {},
    });
    assert.equal(stdioSecretCall.status, 200);
    // The server received the vault value, but agents only ever see it masked.
    assert.equal(stdioSecretCall.json.result.content[0].text, '••••');

    const stdioMathCall = await mcpRpc('tools/call', {
      name: `${stdioConnId}__add_numbers`,
      arguments: { a: 19, b: 23 },
    });
    assert.equal(stdioMathCall.status, 200);
    assert.equal(stdioMathCall.json.result.content[0].text, '42');

    // resources/list + resources/read
    const resList = await mcpRpc('resources/list');
    assert.equal(resList.status, 200);
    assert.equal(resList.json.result.resources.length, 1);
    const expectedUri = `loop://${httpConnId}/${encodeURIComponent('mock://docs/guide')}`;
    assert.equal(resList.json.result.resources[0].uri, expectedUri);

    const resRead = await mcpRpc('resources/read', { uri: expectedUri });
    assert.equal(resRead.status, 200);
    assert.equal(resRead.json.result.contents[0].text, 'Loop Mock Design Guide v1');

    // prompts/list + prompts/get
    const promptsList = await mcpRpc('prompts/list');
    assert.equal(promptsList.status, 200);
    assert.equal(promptsList.json.result.prompts.length, 1);
    assert.equal(promptsList.json.result.prompts[0].name, `${httpConnId}__summarize`);

    const promptGet = await mcpRpc('prompts/get', {
      name: `${httpConnId}__summarize`,
      arguments: { topic: 'MCP gateway' },
    });
    assert.equal(promptGet.status, 200);
    assert.equal(
      promptGet.json.result.messages[0].content.text,
      'Please summarize: MCP gateway',
    );
  });

  it('disables and re-enables individual tools via POST /api/mcps/:id/tools/toggle', async () => {
    const disableRes = await api(`/api/mcps/${httpConnId}/tools/toggle`, {
      method: 'POST',
      body: JSON.stringify({ toolName: 'design_palette', enabled: false }),
    });
    assert.equal(disableRes.status, 200);
    assert.deepEqual(disableRes.json.mcp.disabledTools, ['design_palette']);

    // Hidden from loop__search({ type: "tools" })
    const searchAfterDisable = await mcpRpc('tools/call', {
      name: 'loop__search',
      arguments: { type: 'tools' },
    });
    const namesAfterDisable = JSON.parse(searchAfterDisable.json.result.content[0].text).tools.map((t) => t.tool);
    assert.equal(namesAfterDisable.includes(`${httpConnId}__design_palette`), false);
    assert.equal(namesAfterDisable.includes(`${httpConnId}__echo`), true);

    // Blocked in tools/call
    const blockedCall = await mcpRpc('tools/call', {
      name: `${httpConnId}__design_palette`,
      arguments: { theme: 'sunset' },
    });
    assert.equal(blockedCall.status, 200);
    assert.equal(blockedCall.json.error?.code, -32602);
    assert.match(blockedCall.json.error?.message || '', /disabled/i);

    // Re-enable tool
    const enableRes = await api(`/api/mcps/${httpConnId}/tools/toggle`, {
      method: 'POST',
      body: JSON.stringify({ toolName: 'design_palette', enabled: true }),
    });
    assert.equal(enableRes.status, 200);
    assert.deepEqual(enableRes.json.mcp.disabledTools, []);

    const allowedCall = await mcpRpc('tools/call', {
      name: `${httpConnId}__design_palette`,
      arguments: { theme: 'sunset' },
    });
    assert.equal(allowedCall.status, 200);
    assert.equal(allowedCall.json.result.content[0].text, 'palette:sunset:#111111,#ffffff');
  });

  it('executes upstream tools via built-in tool tester POST /api/mcps/:id/tools/test', async () => {
    await api(`/api/mcps/${httpConnId}/sync`, { method: 'POST', body: '{}' });
    const afterSync = await api(`/api/mcps/${httpConnId}/read-status`);
    assert.equal(afterSync.json.readiness.ready, true);
    assert.equal(afterSync.json.readEvidence, null);
    const httpTest = await api(`/api/mcps/${httpConnId}/tools/test`, {
      method: 'POST',
      body: JSON.stringify({
        toolName: 'echo',
        arguments: { message: 'tester-works' },
      }),
    });
    assert.equal(httpTest.status, 200);
    assert.equal(httpTest.json.result.content[0].text, 'http-echo:tester-works');
    const afterRead = await api(`/api/mcps/${httpConnId}/read-status`);
    assert.equal(afterRead.json.readEvidence?.connectionId, httpConnId);
    assert.equal(afterRead.json.readEvidence?.tool, 'echo');
    assert.ok(Number.isFinite(Date.parse(afterRead.json.readEvidence.succeededAt)));

    // Also accepts JSON string arguments
    const stdioTest = await api(`/api/mcps/${stdioConnId}/tools/test`, {
      method: 'POST',
      body: JSON.stringify({
        toolName: 'add_numbers',
        arguments: '{"a": 7, "b": 8}',
      }),
    });
    assert.equal(stdioTest.status, 200);
    assert.equal(stdioTest.json.result.content[0].text, '15');
  });

  it('filters connections by profile on POST /mcp?profile=design', async () => {
    const search = await mcpRpc(
      'tools/call',
      { name: 'loop__search', arguments: { type: 'tools' } },
      { query: '?profile=design' },
    );
    assert.equal(search.status, 200);
    const names = JSON.parse(search.json.result.content[0].text).tools.map((t) => t.tool);

    assert.ok(names.includes(`${httpConnId}__echo`));
    assert.ok(names.includes(`${httpConnId}__design_palette`));
    assert.equal(names.includes(`${stdioConnId}__add_numbers`), false);
    assert.equal(names.includes(`${stdioConnId}__read_secret_env`), false);

    // Calling a tool from a connection outside the profile is rejected
    const forbiddenCall = await mcpRpc(
      'tools/call',
      { name: `${stdioConnId}__add_numbers`, arguments: { a: 1, b: 2 } },
      { query: '?profile=design' },
    );
    assert.equal(forbiddenCall.status, 200);
    assert.equal(forbiddenCall.json.error?.code, -32602);
    assert.match(forbiddenCall.json.error?.message || '', /not found/i);
    assert.doesNotMatch(forbiddenCall.json.error?.message || '', /profile|agent/i);

    // Calling an in-profile tool succeeds
    const allowedCall = await mcpRpc(
      'tools/call',
      { name: `${httpConnId}__echo`, arguments: { message: 'in-design' } },
      { query: '?profile=design' },
    );
    assert.equal(allowedCall.status, 200);
    assert.equal(allowedCall.json.result.content[0].text, 'http-echo:in-design');
  });

  it('supports Progressive 4-tool mode (POST /mcp?mode=progressive): search -> inspect -> run', async () => {
    const list = await mcpRpc('tools/list', undefined, { query: '?mode=progressive' });
    assert.equal(list.status, 200);
    const names = list.json.result.tools.map((t) => t.name);

    assert.deepEqual(names, ['loop__search', 'loop__inspect', 'loop__run', 'loop__save', 'loop__show', 'loop__send_feedback']);
    // Raw upstream schemas & internal host tools must NOT be listed directly in progressive mode
    assert.equal(names.includes(`${httpConnId}__echo`), false);
    assert.equal(names.includes(`${stdioConnId}__add_numbers`), false);
    assert.equal(names.includes('loop_host__discover'), false);

    // 1. Search (tools + all overview + categories)
    const search = await mcpRpc(
      'tools/call',
      { name: 'loop__search', arguments: { type: 'tools', query: 'palette' } },
      { query: '?mode=progressive' },
    );
    assert.equal(search.status, 200);
    const searchPayload = JSON.parse(search.json.result.content[0].text);
    assert.equal(searchPayload.total, 1);
    assert.equal(searchPayload.tools[0].tool, `${httpConnId}__design_palette`);

    const allSearch = await mcpRpc('tools/call', { name: 'loop__search', arguments: {} });
    const allPayload = JSON.parse(allSearch.json.result.content[0].text);
    assert.equal(allPayload.summary.total, 2);
    assert.equal(allPayload.summary.local, 1);
    assert.equal(allPayload.summary.cloud, 1);
    assert.ok(allPayload.summary.totalSkills >= 2);
    assert.ok(Array.isArray(allPayload.categories));
    assert.equal(allPayload.visual, undefined);
    assert.equal(allPayload.displayHint, undefined);

    const catSearch = await mcpRpc('tools/call', { name: 'loop__search', arguments: { type: 'categories' } });
    const catPayload = JSON.parse(catSearch.json.result.content[0].text);
    assert.ok(catPayload.categories.length >= 1);
    assert.equal(catPayload.visualFormat, 'markdown');
    assert.match(catPayload.visual, /^### Loop Hub$/m);
    assert.doesNotMatch(catPayload.visual, /[┌┐└┘│├┤─]/);

    // 2. Inspect (upstream tool, internal host tool, connection, bundled skill)
    const inspect = await mcpRpc(
      'tools/call',
      { name: 'loop__inspect', arguments: { type: 'tool', id: `${httpConnId}__design_palette` } },
      { query: '?mode=progressive' },
    );
    assert.equal(inspect.status, 200);
    const inspected = JSON.parse(inspect.json.result.content[0].text);
    assert.equal(inspected.tool, `${httpConnId}__design_palette`);
    assert.ok(inspected.inputSchema.properties.theme);
    assert.equal(inspected.approvalPolicy.decision, 'auto');

    const inspectHost = await mcpRpc('tools/call', {
      name: 'loop__inspect',
      arguments: { type: 'tool', id: 'loop_host__cleanup' },
    });
    const hostSchema = JSON.parse(inspectHost.json.result.content[0].text);
    assert.equal(hostSchema.tool, 'loop_host__cleanup');
    assert.equal(hostSchema.approvalPolicy.decision, 'always_ask');

    const inspectConn = await mcpRpc('tools/call', {
      name: 'loop__inspect',
      arguments: { type: 'connection', id: httpConnId },
    });
    const connDetail = JSON.parse(inspectConn.json.result.content[0].text);
    assert.equal(connDetail.id, httpConnId);
    assert.equal(connDetail.locationLabel, 'Endpoint');
    assert.equal(connDetail.approvalPolicy.mode, 'inherit');

    const inspectSkill = await mcpRpc('tools/call', {
      name: 'loop__inspect',
      arguments: { type: 'skill', id: 'sync-agents' },
    });
    const skillDetail = JSON.parse(inspectSkill.json.result.content[0].text);
    assert.equal(skillDetail.id, 'sync-agents');
    assert.equal(skillDetail.bundled, true);
    assert.match(skillDetail.content, /loop_host__discover/);

    // 3. Run (both HTTP and stdio)
    const runHttp = await mcpRpc(
      'tools/call',
      {
        name: 'loop__run',
        arguments: {
          tool: `${httpConnId}__design_palette`,
          arguments: { theme: 'ocean' },
        },
      },
      { query: '?mode=progressive' },
    );
    assert.equal(runHttp.status, 200);
    assert.equal(runHttp.json.result.content[0].text, 'palette:ocean:#111111,#ffffff');

    const runStdio = await mcpRpc(
      'tools/call',
      {
        name: 'loop__run',
        arguments: {
          tool: `${stdioConnId}__add_numbers`,
          arguments: { a: 100, b: 23 },
        },
      },
      { query: '?mode=progressive' },
    );
    assert.equal(runStdio.status, 200);
    assert.equal(runStdio.json.result.content[0].text, '123');
  });

  it('supports built-in agent self-management via loop__search and loop__save (save, sync, approval-gated delete)', async () => {
    // list connections via loop__search
    const list1 = await mcpRpc('tools/call', {
      name: 'loop__search',
      arguments: { type: 'connections' },
    });
    assert.equal(list1.status, 200);
    const inventory = JSON.parse(list1.json.result.content[0].text);
    assert.equal(inventory.connections.length, 2);
    assert.equal(inventory.visualFormat, undefined);
    assert.equal(inventory.visual, undefined);

    // save new connection via loop__save
    const added = await mcpRpc('tools/call', {
      name: 'loop__save',
      arguments: {
        type: 'connection',
        action: 'save',
        data: {
          name: 'Agent Added HTTP',
          transport: 'http',
          url: mockHttp.url,
          token: MOCK_HTTP_TOKEN,
          profiles: ['agent'],
        },
      },
    });
    assert.equal(added.status, 200);
    const addedData = JSON.parse(added.json.result.content[0].text).connection;
    assert.equal(addedData.id, 'agent_added_http');
    assert.equal(addedData.toolCount, 2);
    assert.equal(addedData.lastError, null);

    // sync connection via loop__save
    const synced = await mcpRpc('tools/call', {
      name: 'loop__save',
      arguments: {
        type: 'connection',
        action: 'sync',
        id: 'agent_added_http',
      },
    });
    assert.equal(synced.status, 200);
    assert.equal(synced.json.result.isError, false);
    const syncedData = JSON.parse(synced.json.result.content[0].text).connection;
    assert.equal(syncedData.id, 'agent_added_http');
    assert.equal(syncedData.toolCount, 2);

    // delete connection via loop__save -> gated by actions.delete ('always_ask' by default)
    const delPending = await mcpRpc('tools/call', {
      name: 'loop__save',
      arguments: {
        type: 'connection',
        action: 'delete',
        id: 'agent_added_http',
      },
    });
    assert.equal(delPending.status, 200);
    const pendingData = JSON.parse(delPending.json.result.content[0].text);
    assert.equal(pendingData.status, 'approval_required');
    assert.ok(pendingData.approvalId);

    const approveDel = await api(`/api/approvals/${pendingData.approvalId}/approve`, { method: 'POST' });
    assert.equal(approveDel.status, 200);
    assert.equal(approveDel.json.approval.status, 'approved');

    const removed = await mcpRpc('tools/call', {
      name: 'loop__save',
      arguments: {
        type: 'connection',
        action: 'delete',
        id: 'agent_added_http',
        approvalId: pendingData.approvalId,
      },
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(JSON.parse(removed.json.result.content[0].text), {
      deleted: true,
      removed: true,
      id: 'agent_added_http',
    });

    const list2 = await mcpRpc('tools/call', {
      name: 'loop__search',
      arguments: { type: 'connections' },
    });
    const conns2 = JSON.parse(list2.json.result.content[0].text).connections;
    assert.equal(conns2.length, 2);
    assert.equal(conns2.some((c) => c.id === 'agent_added_http'), false);
  });

  it('enforces configurable approval policies end-to-end (connection policy, payment Vault secret, tampered args rejection, SSE)', async () => {
    // Open SSE stream to confirm event: approvals broadcasts on create & approve
    const sseEvents = [];
    const sseController = new AbortController();
    const sseReady = new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}/events`, { signal: sseController.signal, headers: { Cookie: sessionCookie } }, (res) => {
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
          const parts = buf.split('\n\n');
          buf = parts.pop() || '';
          for (const block of parts) {
            if (block.includes('event: hello')) resolve();
            const m = block.match(/event: approvals\ndata: (\{.*\})/);
            if (m) sseEvents.push(JSON.parse(m[1]));
          }
        });
      });
      req.on('error', (err) => {
        if (err.name !== 'AbortError') reject(err);
      });
    });
    await sseReady;

    try {
      // 1. Set connection policy to always_ask via PATCH /api/policies
      const policiesBefore = await api('/api/policies');
      assert.equal(policiesBefore.status, 200);
      assert.equal(policiesBefore.json.policies.vaultTypes.payment, 'always_ask');
      assert.ok(Array.isArray(policiesBefore.json.categories));

      const patched = await api('/api/policies', {
        method: 'PATCH',
        body: JSON.stringify({ connections: { [httpConnId]: 'always_ask' } }),
      });
      assert.equal(patched.status, 200);
      assert.equal(patched.json.policies.connections[httpConnId], 'always_ask');

      // Verify GET /api/mcps exposes category, categoryLabel, approval, and toolApprovals
      const mcpsRes = await api('/api/mcps');
      assert.equal(mcpsRes.status, 200);
      assert.ok(mcpsRes.json.toolApprovals && typeof mcpsRes.json.toolApprovals === 'object');
      const httpMeta = mcpsRes.json.mcps.find((m) => m.id === httpConnId);
      assert.equal(httpMeta.approval, 'always_ask');
      assert.ok(httpMeta.category);
      assert.ok(httpMeta.categoryLabel);

      // 2. Calling loop__run pauses with status: "approval_required" + approvalId
      const paused = await mcpRpc('tools/call', {
        name: 'loop__run',
        arguments: {
          tool: `${httpConnId}__echo`,
          arguments: { message: 'guarded-call' },
        },
      });
      assert.equal(paused.status, 200);
      assert.equal(paused.json.result.isError, false);
      const pauseData = JSON.parse(paused.json.result.content[0].text);
      assert.equal(pauseData.status, 'approval_required');
      assert.match(pauseData.approvalId, /^apr_/);
      assert.match(pauseData.reason, /requires approval/i);
      assert.equal(pauseData.approveUrl.endsWith(`#approvals?id=${pauseData.approvalId}`), true);

      // Pending approval is visible in GET /api/approvals and GET /api/overview
      const pendingList = await api('/api/approvals');
      assert.equal(pendingList.status, 200);
      assert.equal(pendingList.json.pending.length, 1);
      assert.equal(pendingList.json.pending[0].id, pauseData.approvalId);

      const overviewPending = await api('/api/overview');
      assert.equal(overviewPending.json.pendingApprovals, 1);
      assert.ok(Array.isArray(overviewPending.json.categories));
      assert.equal(overviewPending.json.policies.connections[httpConnId], 'always_ask');

      // Retrying while still pending stays blocked
      const stillPending = await mcpRpc('tools/call', {
        name: 'loop__run',
        arguments: {
          tool: `${httpConnId}__echo`,
          arguments: { message: 'guarded-call' },
          approvalId: pauseData.approvalId,
        },
      });
      assert.equal(JSON.parse(stillPending.json.result.content[0].text).code, 'pending');

      // 3. Approve via POST /api/approvals/:id/approve
      const approved = await api(`/api/approvals/${pauseData.approvalId}/approve`, { method: 'POST' });
      assert.equal(approved.status, 200);
      assert.equal(approved.json.approval.status, 'approved');
      assert.equal((await api('/api/approvals/apr_nonexistent/approve', { method: 'POST' })).status, 404);

      // 4. Tampered arguments with the SAME approvalId MUST be rejected!
      const tampered = await mcpRpc('tools/call', {
        name: 'loop__run',
        arguments: {
          tool: `${httpConnId}__echo`,
          arguments: { message: 'TAMPERED-PAYLOAD' },
          approvalId: pauseData.approvalId,
        },
      });
      assert.equal(tampered.status, 200);
      assert.equal(tampered.json.result.isError, true);
      const tamperBody = JSON.parse(tampered.json.result.content[0].text);
      assert.equal(tamperBody.status, 'approval_required');
      assert.equal(tamperBody.code, 'mismatch');
      assert.match(tamperBody.nextStep, /exact approved arguments/);

      // 5. Retrying with exact original arguments + approvalId succeeds!
      const executed = await mcpRpc('tools/call', {
        name: 'loop__run',
        arguments: {
          tool: `${httpConnId}__echo`,
          arguments: { message: 'guarded-call' },
          approvalId: pauseData.approvalId,
        },
      });
      assert.equal(executed.status, 200);
      assert.equal(executed.json.result.isError, undefined);
      assert.equal(executed.json.result.content[0].text, 'http-echo:guarded-call');

      // 6. Replaying a consumed approvalId is rejected
      const replay = await mcpRpc('tools/call', {
        name: 'loop__run',
        arguments: {
          tool: `${httpConnId}__echo`,
          arguments: { message: 'guarded-call' },
          approvalId: pauseData.approvalId,
        },
      });
      assert.equal(replay.json.result.isError, true);
      assert.equal(JSON.parse(replay.json.result.content[0].text).code, 'consumed');

      // 7. Denying an approval blocks execution
      const pausedForDeny = await mcpRpc('tools/call', {
        name: 'loop__run',
        arguments: {
          tool: `${httpConnId}__echo`,
          arguments: { message: 'will-deny' },
        },
      });
      const denyId = JSON.parse(pausedForDeny.json.result.content[0].text).approvalId;
      const deniedRes = await api(`/api/approvals/${denyId}/deny`, { method: 'POST' });
      assert.equal(deniedRes.status, 200);
      assert.equal(deniedRes.json.approval.status, 'denied');
      const retryDenied = await mcpRpc('tools/call', {
        name: 'loop__run',
        arguments: {
          tool: `${httpConnId}__echo`,
          arguments: { message: 'will-deny' },
          approvalId: denyId,
        },
      });
      assert.equal(retryDenied.json.result.isError, true);
      assert.equal(JSON.parse(retryDenied.json.result.content[0].text).status, 'approval_denied');

      // Reset connection policy back to inherit so payment secret test proves vaultType policy independently!
      await api('/api/policies', {
        method: 'PATCH',
        body: JSON.stringify({ connections: { [httpConnId]: 'inherit' } }),
      });

      // 8. Save a payment secret via loop__save({ type: "payment", ... }) -> encrypted & masked!
      const rawCard = '4242-4242-4242-8899';
      const savedPay = await mcpRpc('tools/call', {
        name: 'loop__save',
        arguments: {
          type: 'payment',
          id: 'CORP_VISA',
          data: { value: rawCard, description: 'Corporate Visa' },
        },
      });
      assert.equal(savedPay.status, 200);
      assert.equal(savedPay.json.result.isError, false);
      assert.equal(savedPay.json.result.content[0].text.includes(rawCard), false, 'never echo raw secret');
      const payMeta = JSON.parse(savedPay.json.result.content[0].text);
      assert.equal(payMeta.saved, true);
      assert.equal(payMeta.key, 'CORP_VISA');
      assert.equal(payMeta.type, 'payment');
      assert.equal(payMeta.masked, '••••');
      assert.equal(payMeta.placeholder, '{{vault:CORP_VISA}}');

      // Verify Vault REST GET + PATCH metadata
      const vaultGet = await api('/api/vault');
      assert.deepEqual(vaultGet.json.vaultTypes, ['api_key', 'login', 'payment', 'note']);
      assert.deepEqual(vaultGet.json.approvalModes, ['inherit', 'auto', 'always_ask', 'guard']);
      assert.equal(JSON.stringify(vaultGet.json).includes(rawCard), false);
      const vaultPatch = await api('/api/vault/CORP_VISA', {
        method: 'PATCH',
        body: JSON.stringify({ description: 'Updated Corporate Visa' }),
      });
      assert.equal(vaultPatch.status, 200);
      assert.equal(vaultPatch.json.secret.description, 'Updated Corporate Visa');
      assert.equal(vaultPatch.json.secret.type, 'payment');
      assert.equal((await api('/api/vault/NO_SUCH_KEY', { method: 'PATCH', body: '{}' })).status, 404);

      // Share CORP_VISA with owner agent and verify payment secret triggers approval_required on loop__run!
      const shareRes = await api(`/api/agents/${ownerAgentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ secrets: ['CORP_VISA'] }),
      });
      assert.equal(shareRes.status, 200);

      const payPaused = await mcpRpc('tools/call', {
        name: 'loop__run',
        arguments: {
          tool: `${httpConnId}__echo`,
          arguments: { message: 'card={{vault:CORP_VISA}}' },
        },
      });
      const payPauseData = JSON.parse(payPaused.json.result.content[0].text);
      assert.equal(payPauseData.status, 'approval_required');
      assert.match(payPauseData.reason, /payment/i);

      // Approval queue detail must NEVER contain the raw card value
      const payPending = await api('/api/approvals');
      assert.equal(JSON.stringify(payPending.json).includes(rawCard), false);

      // Approve and retry -> succeeds AND masks the card number in tool output!
      await api(`/api/approvals/${payPauseData.approvalId}/approve`, { method: 'POST' });
      const payDone = await mcpRpc('tools/call', {
        name: 'loop__run',
        arguments: {
          tool: `${httpConnId}__echo`,
          arguments: { message: 'card={{vault:CORP_VISA}}' },
          approvalId: payPauseData.approvalId,
        },
      });
      assert.equal(payDone.status, 200);
      assert.equal(payDone.json.result.content[0].text, 'http-echo:card=••••');
      assert.equal(payDone.json.result.content[0].text.includes(rawCard), false);

      // SSE received approval count transitions (at least one > 0 and a return to 0)
      await new Promise((r) => setTimeout(r, 25));
      assert.ok(sseEvents.some((e) => e.count >= 1), 'SSE should emit approvals event with count >= 1');
      assert.ok(sseEvents.some((e) => e.count === 0), 'SSE should emit approvals event returning to 0');

      // Clean up test secret
      await api('/api/vault/CORP_VISA', { method: 'DELETE' });
    } finally {
      sseController.abort();
    }
  });

  it('saves, searches, inspects, and manages skills & categories via loop__save and REST /api/skills', async () => {
    // Save a new user skill via loop__save({ type: "skill", ... })
    const saved = await mcpRpc('tools/call', {
      name: 'loop__save',
      arguments: {
        type: 'skill',
        id: 'release-checklist',
        category: 'cloud-dev',
        data: {
          name: 'Release Checklist',
          description: 'Pre-release verification workflow for production deployments',
          content: '# Release Checklist\n\n1. Run `npm test`.\n2. Verify changelog.\n',
        },
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.result.isError, false);
    const savedPayload = JSON.parse(saved.json.result.content[0].text);
    assert.equal(savedPayload.saved, true);
    assert.equal(savedPayload.skill.id, 'release-checklist');
    assert.equal(savedPayload.skill.category, 'cloud-dev');

    // Immediately searchable via loop__search({ type: "skills" })
    const searched = await mcpRpc('tools/call', {
      name: 'loop__search',
      arguments: { type: 'skills', query: 'release', category: 'cloud-dev' },
    });
    const searchedPayload = JSON.parse(searched.json.result.content[0].text);
    assert.equal(searchedPayload.total, 1);
    assert.equal(searchedPayload.skills[0].id, 'release-checklist');
    assert.equal(searchedPayload.skills[0].categoryLabel, 'Cloud & Dev');
    assert.equal(searchedPayload.skills[0].bundled, false);

    // Immediately readable via loop__inspect({ type: "skill" })
    const inspected = await mcpRpc('tools/call', {
      name: 'loop__inspect',
      arguments: { type: 'skill', id: 'release-checklist' },
    });
    const inspectedPayload = JSON.parse(inspected.json.result.content[0].text);
    assert.equal(inspectedPayload.id, 'release-checklist');
    assert.equal(inspectedPayload.name, 'Release Checklist');
    assert.match(inspectedPayload.content, /Run `npm test`/);

    // REST /api/skills & /api/skills/:id
    const skillsList = await api('/api/skills');
    assert.equal(skillsList.status, 200);
    assert.ok(skillsList.json.skills.some((s) => s.id === 'release-checklist' && s.category === 'cloud-dev'));
    assert.ok(Array.isArray(skillsList.json.categories));

    const skillOne = await api('/api/skills/release-checklist');
    assert.equal(skillOne.status, 200);
    assert.equal(skillOne.json.skill.id, 'release-checklist');
    assert.equal(skillOne.json.skill.category, 'cloud-dev');
    assert.match(skillOne.json.skill.content, /Verify changelog/);
    assert.equal((await api('/api/skills/does-not-exist')).status, 404);

    // Category save defaults to dryRun: true, and dryRun: false enforces organize policy
    const catPreview = await mcpRpc('tools/call', {
      name: 'loop__save',
      arguments: {
        type: 'category',
        data: {
          createCategories: [{ id: 'custom-lab', label: 'Custom Lab' }],
          assignSkills: { 'release-checklist': 'custom-lab' },
        },
      },
    });
    const previewBody = JSON.parse(catPreview.json.result.content[0].text);
    assert.equal(previewBody.dryRun, true);
    assert.equal(previewBody.applied, false);
    assert.equal(previewBody.visualFormat, 'markdown');
    assert.deepEqual(catPreview.json.result.structuredContent, previewBody);
    assert.match(previewBody.visual, /Before: .* → After: Custom Lab/);
    assert.equal(previewBody.card.changes.find(r => r.kind === 'skill').after.id, 'custom-lab');
    assert.doesNotMatch(previewBody.visual, /[┌┐└┘│├┤─]/);

    const catApplyGuarded = await mcpRpc('tools/call', {
      name: 'loop__save',
      arguments: {
        type: 'category',
        dryRun: false,
        data: {
          createCategories: [{ id: 'custom-lab', label: 'Custom Lab' }],
          assignSkills: { 'release-checklist': 'custom-lab' },
        },
      },
    });
    const catPause = JSON.parse(catApplyGuarded.json.result.content[0].text);
    assert.equal(catPause.status, 'approval_required');
    assert.match(catPause.nextStep, /call loop__save.*approvalId.*waitForApproval: true/);
    assert.equal('howToContinue' in catPause, false);
    assert.deepEqual(catPause.card, previewBody.card);
    assert.deepEqual(catApplyGuarded.json.result.structuredContent, catPause);
    await api(`/api/approvals/${catPause.approvalId}/approve`, { method: 'POST' });
    const changed = await mcpRpc('tools/call', { name: 'loop__save', arguments: { type: 'category', dryRun: false, approvalId: catPause.approvalId, data: { createCategories: ['Not approved'] } } });
    assert.equal(changed.json.result.structuredContent.code, 'mismatch');

    const catApplied = await mcpRpc('tools/call', {
      name: 'loop__save',
      arguments: {
        type: 'category',
        dryRun: false,
        approvalId: catPause.approvalId,
        data: {
          createCategories: [{ id: 'custom-lab', label: 'Custom Lab' }],
          assignSkills: { 'release-checklist': 'custom-lab' },
        },
      },
    });
    const appliedBody = JSON.parse(catApplied.json.result.content[0].text);
    assert.equal(appliedBody.applied, true);
    assert.ok(appliedBody.categories.some((c) => c.id === 'custom-lab'));
    // Same request, but the observed Before is now different. The preview must not apply.
    const stale = await mcpRpc('tools/call', { name: 'loop__save', arguments: { type: 'category', dryRun: false, data: { planId: previewBody.planId, createCategories: [{ id: 'custom-lab', label: 'Custom Lab' }], assignSkills: { 'release-checklist': 'custom-lab' } } } });
    assert.equal(stale.json.result.structuredContent.status, 'stale_plan');
    assert.equal(stale.json.result.structuredContent.applied, false);
    // The owner may decide while an agent is waiting. An intervening category
    // move must invalidate even identical arguments on that waiting call.
    const move = { type: 'category', dryRun: false, data: { assignSkills: { 'release-checklist': 'cloud-dev' } } };
    const callCategory = args => mcpRpc('tools/call', { name: 'loop__save', arguments: args });
    const pendingMove = (await callCategory(move)).json.result.structuredContent;
    const waiting = callCategory({ ...move, approvalId: pendingMove.approvalId, waitForApproval: true, waitForApprovalSeconds: 5 });
    const intervening = { type: 'category', dryRun: false, data: { assignSkills: { 'release-checklist': 'general' } } };
    const interveningId = (await callCategory(intervening)).json.result.structuredContent.approvalId;
    await api(`/api/approvals/${interveningId}/approve`, { method: 'POST' });
    assert.equal((await callCategory({ ...intervening, approvalId: interveningId })).json.result.structuredContent.applied, true);
    await api(`/api/approvals/${pendingMove.approvalId}/approve`, { method: 'POST' });
    assert.equal((await waiting).json.result.structuredContent.applied, false);
    const fresh = (await callCategory(move)).json.result.structuredContent;
    assert.equal(fresh.status, 'approval_required');
    assert.notEqual(fresh.approvalId, pendingMove.approvalId);
    await api(`/api/approvals/${fresh.approvalId}/deny`, { method: 'POST' });
    assert.equal((await callCategory({ ...move, approvalId: fresh.approvalId })).json.result.structuredContent.status, 'approval_denied');

    // Bundled skill cannot be deleted (400), missing skill returns 404, user skill deletes cleanly (200)
    assert.equal((await api('/api/skills/sync-agents', { method: 'DELETE' })).status, 400);
    assert.equal((await api('/api/skills/does-not-exist', { method: 'DELETE' })).status, 404);
    const delSkill = await api('/api/skills/release-checklist', { method: 'DELETE' });
    assert.equal(delSkill.status, 200);
    assert.deepEqual(delSkill.json, { removed: true });
  });

  it('guards loop_host__cleanup, direct tools/call policy, and keyless vs agent vault visibility', async () => {
    // 1. loop_host__cleanup with dryRun: false pauses for approval (never modifies host files without approval)
    const cleanupPaused = await mcpRpc('tools/call', {
      name: 'loop__run',
      arguments: {
        tool: 'loop_host__cleanup',
        arguments: { scope: 'all', dryRun: false },
      },
    });
    assert.equal(cleanupPaused.status, 200);
    const cleanupBody = JSON.parse(cleanupPaused.json.result.content[0].text);
    assert.equal(cleanupBody.status, 'approval_required');
    assert.match(cleanupBody.reason, /cleanup/i);
    await api(`/api/approvals/${cleanupBody.approvalId}/deny`, { method: 'POST' });

    // 2. Direct tools/call (<connId>__<toolName>) ALSO enforces PolicyStore.evaluateRun
    await api('/api/policies', {
      method: 'PATCH',
      body: JSON.stringify({ tools: { [`${httpConnId}__echo`]: 'always_ask' } }),
    });
    const directPaused = await mcpRpc('tools/call', {
      name: `${httpConnId}__echo`,
      arguments: { message: 'direct-guarded' },
    });
    assert.equal(directPaused.status, 200);
    const directPauseData = JSON.parse(directPaused.json.result.content[0].text);
    assert.equal(directPauseData.status, 'approval_required');
    assert.ok(directPauseData.nextStep.includes(`call ${httpConnId}__echo`));
    assert.match(directPauseData.nextStep, /_approvalId: .*_waitForApproval: true/);
    await api(`/api/approvals/${directPauseData.approvalId}/approve`, { method: 'POST' });
    const directApproved = await mcpRpc('tools/call', {
      name: `${httpConnId}__echo`,
      arguments: { message: 'direct-guarded', _approvalId: directPauseData.approvalId, _waitForApproval: true },
    });
    assert.equal(directApproved.json.result.content[0].text, 'http-echo:direct-guarded');
    await api('/api/policies', {
      method: 'PATCH',
      body: JSON.stringify({ tools: { [`${httpConnId}__echo`]: 'inherit' } }),
    });

    // 3. Keyless mode lists all user secrets via loop__search({ type: "vault" }) without raw values
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ requireAgentToken: false }) });
    const keylessVaultRes = await api('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'loop__search', arguments: { type: 'vault' } },
      }),
    });
    assert.equal(keylessVaultRes.status, 200);
    const keylessVault = JSON.parse(keylessVaultRes.json.result.content[0].text);
    assert.ok(keylessVault.secrets.some((s) => s.key === 'STDIO_API_KEY'));
    assert.equal(keylessVaultRes.json.result.content[0].text.includes(MOCK_STDIO_SECRET), false);
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ requireAgentToken: true }) });
  });

  it('imports standard mcpServers JSON via POST /api/mcps/import with deduplication, vault extraction, and vault-ref blocking', async () => {
    const importRes = await api('/api/mcps/import', {
      method: 'POST',
      body: JSON.stringify({
        profile: 'imported',
        json: {
          mcpServers: {
            DuplicateHttp: {
              url: mockHttp.url,
              headers: { Authorization: `Bearer ${MOCK_HTTP_TOKEN}` },
            },
            VaultRefAttempt: {
              command: process.execPath,
              args: [mockStdioScript, '--evil'],
              env: { MOCK_STDIO_SECRET: '{{vault:STDIO_API_KEY}}' },
            },
            ImportedStdio: {
              command: process.execPath,
              args: [mockStdioScript, '--imported'],
              env: { MOCK_STDIO_SECRET: MOCK_STDIO_SECRET },
            },
          },
        },
      }),
    });

    assert.equal(importRes.status, 200);
    assert.equal(importRes.json.added.length, 1);
    assert.equal(importRes.json.added[0].name, 'ImportedStdio');
    assert.equal(importRes.json.added[0].tools.length, 2);
    assert.equal(JSON.stringify(importRes.json).includes(MOCK_STDIO_SECRET), false, 'plaintext secret moved into Vault');
    assert.equal(importRes.json.skipped.length, 2);
    const dupSkip = importRes.json.skipped.find((s) => s.name === 'DuplicateHttp');
    const refSkip = importRes.json.skipped.find((s) => s.name === 'VaultRefAttempt');
    assert.equal(dupSkip?.reason, 'Already exists.');
    assert.ok(refSkip, 'pasted config naming saved Vault secrets must be refused');

    // Clean up imported connection via REST DELETE
    const del = await api(`/api/mcps/${importRes.json.added[0].id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.deepEqual(del.json, { removed: true });
  });

  it('bridges newline-delimited JSON-RPC over stdio.mjs child process to Loop HTTP /mcp', async () => {
    const child = spawn(
      process.execPath,
      [stdioBridgePath, `--url=${baseUrl}/mcp`, '--profile=design'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LOOP_HUB_TOKEN: ownerToken } },
    );

    const rl = readline.createInterface({ input: child.stdout });
    const pendingResponses = new Map();
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const msg = JSON.parse(trimmed);
      const resolver = pendingResponses.get(msg.id);
      if (resolver) {
        pendingResponses.delete(msg.id);
        resolver(msg);
      }
    });

    const sendRpc = (id, method, params) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingResponses.delete(id);
          reject(new Error(`Timed out waiting for stdio.mjs response to ${method} (stderr: ${stderr})`));
        }, 10_000);
        pendingResponses.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        const payload = { jsonrpc: '2.0', id, method };
        if (params !== undefined) payload.params = params;
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      });

    try {
      const initRes = await sendRpc(1, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'stdio-test', version: '1.0.0' },
      });
      assert.equal(initRes.result.serverInfo.name, 'loop');

      // Send notification (should NOT emit a response line)
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );

      const toolsRes = await sendRpc(2, 'tools/list');
      const toolNames = toolsRes.result.tools.map((t) => t.name);
      assert.deepEqual(toolNames, ['loop__search', 'loop__inspect', 'loop__run', 'loop__save', 'loop__show', 'loop__send_feedback']);

      const searchRes = await sendRpc(20, 'tools/call', {
        name: 'loop__search',
        arguments: { type: 'tools' },
      });
      const searchedNames = JSON.parse(searchRes.result.content[0].text).tools.map((t) => t.tool);
      assert.ok(searchedNames.includes(`${httpConnId}__echo`));
      assert.equal(searchedNames.includes(`${stdioConnId}__add_numbers`), false, 'profile=design should filter out dev stdio');

      const callRes = await sendRpc(3, 'tools/call', {
        name: `${httpConnId}__echo`,
        arguments: { message: 'via-stdio-bridge' },
      });
      assert.equal(callRes.result.content[0].text, 'http-echo:via-stdio-bridge');

      child.stdin.end();
      const exitCode = await new Promise((resolve) => child.once('exit', resolve));
      assert.equal(exitCode, 0, `stdio.mjs should exit cleanly (stderr: ${stderr})`);
    } finally {
      rl.close();
      if (child.exitCode === null) {
        child.kill('SIGTERM');
      }
    }
  });

  it('returns a one-click sign-in link, waits for sign-in, and asks loop__run to sign in again on a 401', async () => {
    const upstream = await startMockHttpMcpServer('mock-oauth-access-1', { oauth: true });
    const tool = (name, args) => mcpRpc('tools/call', { name, arguments: args });
    const body = (res) => JSON.parse(res.json.result.content[0].text);
    try {
      // No key configured and the server answers 401: a sign-in can fix it.
      const saved = body(await tool('loop__save', {
        type: 'connection',
        data: { name: 'OAuth Sign In Test', transport: 'http', url: upstream.url },
      }));
      const connId = saved.connection.id;
      const signInUrl = `${baseUrl}/#connections?signin=${connId}`;
      assert.equal(saved.connection.authRequired, true);
      assert.equal(saved.connection.statusLabel, 'Needs sign-in');
      assert.equal(saved.signInUrl, signInUrl);
      assert.equal(saved.updateKeyUrl, undefined);
      assert.match(saved.nextStep, /waitForSignIn/);

      const listed = body(await tool('loop__search', { type: 'connections' }));
      assert.equal(listed.connections.find((c) => c.id === connId)?.signInUrl, signInUrl);
      const inspected = body(await tool('loop__inspect', { type: 'connection', id: connId }));
      assert.equal(inspected.signInUrl, signInUrl);

      // An agent that cannot manage connections has no loop__save, so it is not told to call it.
      const viewer = await api('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Sign In Viewer', kind: 'other', profile: 'all', canManage: false }),
      });
      assert.equal(viewer.status, 201);
      const viewerInspect = await api('/mcp', {
        method: 'POST',
        headers: { Authorization: `Bearer ${viewer.json.token}` },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'loop__inspect', arguments: { type: 'connection', id: connId } },
        }),
      });
      assert.equal(body(viewerInspect).signInUrl, signInUrl);
      assert.doesNotMatch(body(viewerInspect).nextStep, /loop__save/);
      assert.match(body(viewerInspect).nextStep, /tell you when they are done/);
      assert.equal((await api(`/api/agents/${viewer.json.agent.id}`, { method: 'DELETE' })).status, 200);

      // Running a tool before signing in hands back the link instead of a bare error.
      const blocked = await tool('loop__run', { tool: `${connId}__echo`, arguments: { message: 'hi' } });
      assert.equal(blocked.json.result.isError, true);
      const blockedBody = body(blocked);
      assert.equal(blockedBody.signInUrl, signInUrl);
      assert.equal(blockedBody.statusLabel, 'Needs sign-in');
      assert.match(blockedBody.nextStep, /waitForSignIn/);
      assert.match(blockedBody.nextStep, /retry the same loop__run call/);

      // Still signed out: the wait gives up and repeats the link.
      const timedOut = await tool('loop__save', { type: 'connection', action: 'sync', id: connId, data: { waitForSignIn: 0.3 } });
      assert.equal(timedOut.json.result.isError, true);
      assert.equal(body(timedOut).signedIn, false);
      assert.equal(body(timedOut).signInUrl, signInUrl);

      // Loop refuses to send the user to a sign-in page that is not https (or http on this computer).
      for (const endpoint of ['http://sign-in.example.com/authorize', 'javascript:alert(1)']) {
        upstream.setAuthorizeEndpoint(endpoint);
        const unsafe = await api(`/api/mcps/${connId}/oauth/start`, { method: 'POST' });
        assert.equal(unsafe.status, 400);
        assert.match(unsafe.json.detail, /secure/);
        assert.match(unsafe.json.error, /can't be signed in to directly/, 'the person sees a plain sentence');
      }
      upstream.setAuthorizeEndpoint(null);

      // The user signs in while the agent waits.
      // Simulate a cross-site redirect from the provider: SameSite=Strict strips the cookie, so
      // /oauth/callback bounces code & state to Loop's page without consuming the pending flow,
      // and the dashboard finishes via same-origin POST /api/mcps/oauth/finish.
      // (The refused attempts above marked the sign-in as unable to start; a successful start clears
      // that, so the agent's wait comes after it.)
      const started = await api(`/api/mcps/${connId}/oauth/start`, { method: 'POST' });
      assert.equal(started.status, 200);
      assert.equal((await api('/api/mcps')).json.mcps.find((m) => m.id === connId).signInBroken, null);
      const waiting = tool('loop__save', { type: 'connection', action: 'sync', id: connId, data: { waitForSignIn: 20 } });
      assert.equal(started.json.name, 'OAuth Sign In Test');
      assert.equal(started.json.connectionHost, `127.0.0.1:${upstream.port}`);
      const authorizeUrl = new URL(started.json.authorizeUrl);
      assert.equal(authorizeUrl.origin, `http://127.0.0.1:${upstream.port}`);
      const oauthState = authorizeUrl.searchParams.get('state');
      const callbackPath = `/oauth/callback?code=mock-code&state=${encodeURIComponent(oauthState)}`;

      // Without a cookie (SameSite=Strict) or with Sec-Fetch-Site: cross-site, /oauth/callback bounces.
      const unauthCb = await fetch(`${baseUrl}${callbackPath}`, {
        redirect: 'manual',
        headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' },
      });
      assert.equal(unauthCb.status, 302);
      assert.equal(
        unauthCb.headers.get('location'),
        `/#connections?oauth_code=mock-code&oauth_state=${encodeURIComponent(oauthState)}`,
      );
      const crossSiteWithCookie = await api(callbackPath, {
        redirect: 'manual',
        headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' },
      });
      assert.equal(crossSiteWithCookie.status, 302);
      assert.equal(
        crossSiteWithCookie.headers.get('location'),
        `/#connections?oauth_code=mock-code&oauth_state=${encodeURIComponent(oauthState)}`,
      );

      // Unauthenticated and cross-site POST /api/mcps/oauth/finish are refused without consuming state.
      const unauthFinish = await fetch(`${baseUrl}/api/mcps/oauth/finish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'mock-code', state: oauthState }),
      });
      assert.equal(unauthFinish.status, 401);
      const crossSiteFinish = await api('/api/mcps/oauth/finish', {
        method: 'POST',
        headers: { 'Sec-Fetch-Site': 'cross-site' },
        body: JSON.stringify({ code: 'mock-code', state: oauthState }),
      });
      assert.equal(crossSiteFinish.status, 403);

      // Same-origin signed-in POST finishes the sign-in, returns discovery readiness, and wakes up the waiting agent.
      const finished = await api('/api/mcps/oauth/finish', {
        method: 'POST',
        body: JSON.stringify({ code: 'mock-code', state: oauthState }),
      });
      assert.equal(finished.status, 200);
      assert.equal(finished.json.connected, connId);
      assert.equal(finished.json.ready, true);
      assert.equal(finished.json.readiness?.ready, true);
      assert.equal(finished.json.readiness?.discoveredTools, 2);
      assert.equal(finished.json.readEvidence, null);
      assert.equal(finished.json.discoveryError, null);
      const waited = await waiting;
      assert.notEqual(waited.json.result.isError, true);
      assert.equal(body(waited).synced, true);
      assert.equal(body(waited).connection.toolCount, 2);
      assert.equal(body(waited).signInUrl, undefined);

      const ran = await tool('loop__run', { tool: `${connId}__echo`, arguments: { message: 'hi' } });
      assert.notEqual(ran.json.result.isError, true);
      assert.equal(ran.json.result.content[0].text, 'http-echo:hi');

      // Unknown tools are caught pre-flight without hitting the upstream or signing out.
      const unknownTool = await tool('loop__run', { tool: `${connId}__unauthorized-probe`, arguments: {} });
      assert.equal(unknownTool.json.result.isError, true);
      assert.match(unknownTool.json.result.content[0].text, /not found|Unknown tool/);
      assert.equal((await api('/api/mcps')).json.mcps.find((m) => m.id === connId).authRequired, false);

      // A tool's own error that mentions "unauthorized" is passed through and does not sign the connection out.
      const toolError = await tool('loop__run', { tool: `${connId}__echo`, arguments: { message: '__trigger_unauthorized__' } });
      assert.equal(toolError.json.result.isError, true);
      assert.match(toolError.json.result.content[0].text, /unauthorized resource access/);
      assert.equal((await api('/api/mcps')).json.mcps.find((m) => m.id === connId).authRequired, false);

      // The upstream stops accepting the token mid-task: the 401 marks the connection and returns the link.
      upstream.setAcceptedToken('mock-oauth-access-2');
      const expired = await tool('loop__run', { tool: `${connId}__echo`, arguments: { message: 'again' } });
      assert.equal(expired.json.result.isError, true);
      assert.equal(body(expired).signInUrl, signInUrl);
      assert.match(body(expired).nextStep, /retry the same loop__run call/);
      const marked = (await api('/api/mcps')).json.mcps.find((m) => m.id === connId);
      assert.equal(marked.authRequired, true);
      assert.equal(marked.hasOAuth, true);
      assert.equal(marked.tokenRejected, false);
      const relisted = body(await tool('loop__search', { type: 'connections' })).connections.find((c) => c.id === connId);
      assert.equal(relisted.statusLabel, 'Needs sign-in');
      assert.equal(relisted.signInUrl, signInUrl);

      // The refusal was a one-off: waiting checks once first and returns without a new sign-in.
      upstream.setAcceptedToken('mock-oauth-access-1');
      const healed = await tool('loop__save', {
        type: 'connection', action: 'sync', id: connId, data: { waitForSignIn: 20 },
      });
      assert.notEqual(healed.json.result.isError, true);
      assert.equal(body(healed).synced, true);
      assert.equal(body(healed).connection.authRequired, false);
      assert.equal(body(healed).signInUrl, undefined);
      const rerun = await tool('loop__run', { tool: `${connId}__echo`, arguments: { message: 'back' } });
      assert.notEqual(rerun.json.result.isError, true);

      const delRes = await api(`/api/mcps/${connId}`, { method: 'DELETE' });
      assert.equal(delRes.status, 200);
    } finally {
      await upstream.close();
    }
  });

  it('reports a rejected saved key as "Token rejected" with no sign-in link and recovers once the key is fixed', async () => {
    const tool = (name, args) => mcpRpc('tools/call', { name, arguments: args });
    const body = (res) => JSON.parse(res.json.result.content[0].text);
    const saved = body(await tool('loop__save', {
      type: 'connection',
      data: { name: 'Token Rejected Test', transport: 'http', url: mockHttp.url, token: 'wrong-token-1111' },
    }));
    const connId = saved.connection.id;
    const updateKeyUrl = `${baseUrl}/#connections?conn=${connId}`;
    assert.equal(saved.connection.authRequired, true);
    assert.equal(saved.connection.statusLabel, 'Token rejected');
    assert.equal(saved.signInUrl, undefined);
    assert.equal(saved.updateKeyUrl, updateKeyUrl);
    assert.match(saved.nextStep, /Never ask for the key/);
    assert.doesNotMatch(saved.nextStep, /wrong-token-1111/);

    const listed = body(await tool('loop__search', { type: 'connections' }));
    const entry = listed.connections.find((c) => c.id === connId);
    assert.equal(entry.statusLabel, 'Token rejected');
    assert.equal(entry.signInUrl, undefined);
    assert.equal(entry.updateKeyUrl, updateKeyUrl);
    assert.equal(listed.summary.tokenRejected, 1);
    assert.equal(listed.visual, undefined);
    const all = body(await tool('loop__search', { type: 'all' }));
    assert.equal(all.connections.find((c) => c.id === connId).updateKeyUrl, updateKeyUrl);
    assert.equal(all.connections.find((c) => c.id === connId).signInUrl, undefined);

    const init = await mcpRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });
    const instructions = init.json.result.instructions || '';
    assert.doesNotMatch(instructions, /Token rejected|Token Rejected Test|Connection names/);
    assert.doesNotMatch(instructions, /- Sign-in required \(\d+\):/);

    const dash = (await api('/api/mcps')).json.mcps.find((m) => m.id === connId);
    assert.equal(dash.tokenRejected, true);
    assert.equal(dash.hasOAuth, false);

    const blocked = await tool('loop__run', { tool: `${connId}__echo`, arguments: { message: 'hi' } });
    assert.equal(blocked.json.result.isError, true);
    assert.equal(body(blocked).statusLabel, 'Token rejected');
    assert.equal(body(blocked).signInUrl, undefined);
    assert.equal(body(blocked).updateKeyUrl, updateKeyUrl);
    assert.match(body(blocked).nextStep, /retry the same loop__run call/);

    // Still the old key: the wait gives up and points at the key page again.
    const timedOut = await tool('loop__save', { type: 'connection', action: 'sync', id: connId, data: { waitForSignIn: 0.3 } });
    assert.equal(timedOut.json.result.isError, true);
    assert.equal(body(timedOut).signedIn, false);
    assert.equal(body(timedOut).signInUrl, undefined);
    assert.equal(body(timedOut).updateKeyUrl, updateKeyUrl);

    // The user saves the right key in Loop while the agent waits.
    const waiting = tool('loop__save', { type: 'connection', action: 'sync', id: connId, data: { waitForSignIn: 20 } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const patchRes = await api(`/api/mcps/${connId}`, {
      method: 'PATCH',
      body: JSON.stringify({ token: MOCK_HTTP_TOKEN }),
    });
    assert.equal(patchRes.status, 200);
    const waited = await waiting;
    assert.notEqual(waited.json.result.isError, true);
    assert.equal(body(waited).synced, true);
    assert.equal(body(waited).connection.authRequired, false);
    assert.equal(body(waited).connection.statusLabel, 'Ready');
    assert.equal(body(waited).connection.toolCount, 2);
    assert.equal(body(waited).updateKeyUrl, undefined);

    const ran = await tool('loop__run', { tool: `${connId}__echo`, arguments: { message: 'hi' } });
    assert.equal(ran.json.result.content[0].text, 'http-echo:hi');

    const delRes = await api(`/api/mcps/${connId}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
  });

  it('handles 401 authRequired recovery via PATCH token + sync and connection toggle', async () => {
    // Add connection with wrong token -> mock server returns 401 -> authRequired: true
    const badRes = await api('/api/mcps', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Auth Recovery Test',
        transport: 'http',
        url: mockHttp.url,
        token: 'wrong-token-0000',
      }),
    });
    assert.equal(badRes.status, 201);
    const recId = badRes.json.mcp.id;
    assert.equal(badRes.json.mcp.authRequired, true);
    assert.equal(badRes.json.mcp.lastError, 'Sign in required.');

    // Update token via PATCH and sync -> recovers cleanly
    const patchRes = await api(`/api/mcps/${recId}`, {
      method: 'PATCH',
      body: JSON.stringify({ token: MOCK_HTTP_TOKEN }),
    });
    assert.equal(patchRes.status, 200);

    const syncRes = await api(`/api/mcps/${recId}/sync`, { method: 'POST' });
    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.json.mcp.authRequired, false);
    assert.equal(syncRes.json.mcp.lastError, null);
    assert.equal(syncRes.json.mcp.tools.length, 2);

    // Toggle connection off -> tools hidden
    const offRes = await api(`/api/mcps/${recId}/toggle`, { method: 'POST' });
    assert.equal(offRes.status, 200);
    assert.equal(offRes.json.mcp.enabled, false);
    const listWhileOff = await mcpRpc('tools/list');
    assert.equal(
      listWhileOff.json.result.tools.some((t) => t.name.startsWith(`${recId}__`)),
      false,
    );

    // Clean up
    const delRes = await api(`/api/mcps/${recId}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
  });

  it('auto-captures serverInfo.description on sync, lets agents customize it via loop__save, preserves it on re-sync, and shows it in the indented list', async () => {
    // 1. Mock HTTP server reported serverInfo.description during initial sync
    const inspectInitial = await mcpRpc('tools/call', {
      name: 'loop__inspect',
      arguments: { type: 'connection', id: httpConnId },
    });
    const initialConn = JSON.parse(inspectInitial.json.result.content[0].text);
    assert.equal(initialConn.description, 'Mock cloud HTTP service for integration tests.');

    // 2. Agent updates description via loop__save (e.g. concise custom wording)
    const customDesc = 'Design app screens in .pen files.';
    const saveRes = await mcpRpc('tools/call', {
      name: 'loop__save',
      arguments: {
        type: 'connection',
        id: httpConnId,
        data: { description: customDesc },
      },
    });
    assert.equal(Boolean(saveRes.json.result.isError), false);
    const savedPayload = JSON.parse(saveRes.json.result.content[0].text);
    assert.equal(savedPayload.saved, true);
    assert.equal(savedPayload.connection.description, customDesc);

    // 3. Re-syncing MUST NOT overwrite the custom description with serverInfo.description
    const syncRes = await mcpRpc('tools/call', {
      name: 'loop__save',
      arguments: { type: 'connection', action: 'sync', id: httpConnId },
    });
    const syncedPayload = JSON.parse(syncRes.json.result.content[0].text);
    assert.equal(syncedPayload.connection.description, customDesc);

    // 4. loop__search finds connection by description and renders it in the indented visual
    const searchRes = await mcpRpc('tools/call', {
      name: 'loop__search',
      arguments: { type: 'connections', query: 'pen files' },
    });
    const searchPayload = JSON.parse(searchRes.json.result.content[0].text);
    assert.equal(searchPayload.connections.length, 1);
    assert.equal(searchPayload.connections[0].id, httpConnId);
    assert.equal(searchPayload.connections[0].description, customDesc);
    assert.equal(searchPayload.visual, undefined);

    // 5. REST PATCH /api/mcps/:id also updates description cleanly
    const patchRes = await api(`/api/mcps/${httpConnId}`, {
      method: 'PATCH',
      body: JSON.stringify({ description: 'Edited via dashboard UI.' }),
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.json.mcp.description, 'Edited via dashboard UI.');
  });

  it('counts each connected app as one agent and each initialize as a session', async () => {
    const ephemeralDir = await mkdtemp(path.join(os.tmpdir(), 'loop-clients-'));
    const srv = await startServer({ authMode: 'local-test', port: 0, dataDir: ephemeralDir });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const setup = await fetch(`${base}/api/auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'test-owner-password' }),
      });
      const cookie = setup.headers.get('set-cookie').split(';')[0];
      await fetch(`${base}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ requireAgentToken: false }),
      });
      const init = (name, extra = {}) => fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extra },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name, version: '1.0.0' } },
        }),
      });
      const claudeA = await init('claude-code');
      assert.equal(claudeA.status, 200);
      const sid = claudeA.headers.get('mcp-session-id');
      assert.ok(sid);
      await init('claude-code');
      await init('codex-mcp-client');
      await init('kimi-cli', { 'X-Loop-Bridge': 'stdio' });

      const closed = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { 'Mcp-Session-Id': sid } });
      assert.equal(closed.status, 204);

      const overview = await (await fetch(`${base}/api/overview`, { headers: { Cookie: cookie } })).json();
      assert.equal(overview.stats.agentsTotal, 3);
      const byName = Object.fromEntries(overview.agents.map((a) => [a.name, a]));
      assert.deepEqual(Object.keys(byName).sort(), ['Claude Code', 'Codex', 'Kimi']);
      assert.equal(byName['Claude Code'].sessionsTotal, 2);
      assert.equal(byName['Claude Code'].sessionsActive, 1);
      assert.equal(byName.Kimi.transport, 'stdio');

      const forgot = await fetch(`${base}/api/clients/${encodeURIComponent(byName.Kimi.key)}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });
      assert.equal(forgot.status, 200);
      const after = await (await fetch(`${base}/api/overview`, { headers: { Cookie: cookie } })).json();
      assert.equal(after.stats.agentsTotal, 2);
    } finally {
      await srv.close();
      await rm(ephemeralDir, { recursive: true, force: true });
    }
  });

  it('detects locally configured agents pointing to Loop and merges them cleanly with live sessions', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-local-agents-'));
    const fakeHome = path.join(tmp, 'home');
    await mkdir(path.join(fakeHome, '.codex'), { recursive: true });
    await mkdir(path.join(fakeHome, '.kimi-code'), { recursive: true });
    const srv = await startServer({ authMode: 'local-test', port: 0, dataDir: path.join(tmp, 'data'), home: fakeHome });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      // Configure Claude Code & Codex pointing at this Loop server's exact port
      await writeFile(
        path.join(fakeHome, '.claude.json'),
        JSON.stringify({ mcpServers: { loop: { type: 'http', url: `${base}/mcp` } } }),
      );
      await writeFile(
        path.join(fakeHome, '.codex', 'config.toml'),
        `[mcp_servers.loop]\nurl = "${base}/mcp"\n`,
      );

      const setup = await fetch(`${base}/api/auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'test-owner-password' }),
      });
      const cookie = setup.headers.get('set-cookie').split(';')[0];
      await fetch(`${base}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ requireAgentToken: false }),
      });

      // Before any live initialize, Claude Code + Codex are already detected (2 agents)
      const before = await (await fetch(`${base}/api/overview`, { headers: { Cookie: cookie } })).json();
      assert.equal(before.stats.agentsTotal, 2);
      assert.deepEqual(before.agents.map((a) => a.name).sort(), ['Claude Code', 'Codex']);

      // Now Codex opens a live session (must merge, NOT duplicate!) and Kimi opens a live session (+1 => 3)
      const init = (name) =>
        fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name, version: '2.0.0' } },
          }),
        });
      await init('codex-mcp-client');
      await init('kimi-cli');

      const after = await (await fetch(`${base}/api/overview`, { headers: { Cookie: cookie } })).json();
      assert.equal(after.stats.agentsTotal, 3);
      const byName = Object.fromEntries(after.agents.map((a) => [a.name, a]));
      assert.deepEqual(Object.keys(byName).sort(), ['Claude Code', 'Codex', 'Kimi']);
      assert.equal(byName.Codex.sessionsActive, 1);
      assert.ok(byName.Codex.configuredIn, 'merged Codex keeps its local config path');
      assert.equal(byName['Claude Code'].sessionsActive, 0);
      assert.equal(byName.Kimi.sessionsActive, 1);

      const agentsPage = await (await fetch(`${base}/api/agents`, { headers: { Cookie: cookie } })).json();
      assert.equal(agentsPage.totalConnected, 3);
      assert.equal(agentsPage.connected.length, 3);
    } finally {
      await srv.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('creates and removes custom categories via POST /api/categories and DELETE /api/categories/:id', async () => {
    const createRes = await api('/api/categories', {
      method: 'POST',
      body: JSON.stringify({
        label: 'Video Studio',
        description: 'Clips, edits, and creative workflows',
        connections: [httpConnId],
      }),
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.json.category.id, 'video-studio');
    assert.equal(createRes.json.category.custom, true);
    assert.equal(createRes.json.category.connections.length, 1);
    assert.equal(createRes.json.category.connections[0].id, httpConnId);

    const emptyRes = await api('/api/categories', {
      method: 'POST',
      body: JSON.stringify({ label: 'Empty Lab' }),
    });
    assert.equal(emptyRes.status, 201);
    const overview = await api('/api/overview');
    assert.ok(
      overview.json.categories.some((c) => c.id === 'empty-lab' && c.custom === true),
      'empty custom categories stay visible in /api/overview',
    );

    const del1 = await api('/api/categories/video-studio', { method: 'DELETE' });
    assert.equal(del1.status, 200);
    const del2 = await api('/api/categories/empty-lab', { method: 'DELETE' });
    assert.equal(del2.status, 200);
  });

  it('captures upstream MCP initialize.instructions, surfaces descriptions & all skills, and rescues zero-hit tool searches with catalogTools & suggestedSkills', async () => {
    const ephemeralDir = await mkdtemp(path.join(os.tmpdir(), 'loop-instructions-'));
    let upstreamInstructions =
      'Search 4,200+ live external APIs by task: Reddit posts, X trends, TikTok profiles, news, and web scraping.';
    const upstream = http.createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.id === undefined || body.id === null) {
        res.writeHead(202);
        res.end();
        return;
      }
      const reply = (result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      };
      if (body.method === 'initialize') {
        return reply({
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'treg-mock', version: '1.0.0' }, // intentionally omits serverInfo.description
          instructions: upstreamInstructions,
        });
      }
      if (body.method === 'tools/list') {
        return reply({
          tools: [
            {
              name: 'catalog_search',
              description: 'Search 4,200+ API endpoints by what you want to do.',
              inputSchema: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
              },
            },
            {
              name: 'call',
              description: 'Call a discovered catalog endpoint by id.',
              inputSchema: {
                type: 'object',
                properties: { id: { type: 'string' } },
                required: ['id'],
              },
            },
          ],
        });
      }
      return reply({});
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/mcp`;

    const srv = await startServer({ authMode: 'local-test', port: 0, dataDir: ephemeralDir });
    const base = `http://127.0.0.1:${srv.port}`;
    const rpc = async (method, params = {}) => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return { status: res.status, json: await res.json() };
    };

    try {
      const setup = await fetch(`${base}/api/auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'test-owner-password' }),
      });
      const cookie = setup.headers.get('set-cookie').split(';')[0];
      await fetch(`${base}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ requireAgentToken: false }),
      });

      // Add the upstream catalog connection (syncs immediately)
      const addRes = await fetch(`${base}/api/mcps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'api-catalog', transport: 'http', url: upstreamUrl }),
      });
      assert.equal(addRes.status, 201);
      const added = await addRes.json();
      const connId = added.mcp.id;
      assert.equal(added.mcp.serverInstructions, upstreamInstructions);

      // Save >20 skills including alphabetically late ones like "web-access"
      for (let i = 1; i <= 22; i += 1) {
        const slug = `alpha-skill-${String(i).padStart(2, '0')}`;
        const skRes = await rpc('tools/call', {
          name: 'loop__save',
          arguments: {
            type: 'skill',
            id: slug,
            data: {
              name: slug,
              description: `Sample helper skill ${i}.`,
              content: `# ${slug}\nInstructions`,
            },
          },
        });
        assert.equal(Boolean(skRes.json.result.isError), false);
      }
      const webSkillRes = await rpc('tools/call', {
        name: 'loop__save',
        arguments: {
          type: 'skill',
          id: 'web-access',
          data: {
            name: 'web-access',
            description: 'Use when built-in web tools cannot pull structured data from Reddit, X, TikTok, or blocked pages.',
            content: '# web-access\nUse catalog_search for Reddit.',
          },
        },
      });
      assert.equal(Boolean(webSkillRes.json.result.isError), false);

      // 1. loop__inspect({ type: "connection" }) exposes verbatim serverInstructions and derived description
      const inspectRes = await rpc('tools/call', {
        name: 'loop__inspect',
        arguments: { type: 'connection', id: connId },
      });
      const inspected = JSON.parse(inspectRes.json.result.content[0].text);
      assert.equal(inspected.serverInstructions, upstreamInstructions);
      assert.match(inspected.description, /Search 4,200\+ live external APIs/);

      // 2. Startup names the user's services and explains routing; the rest stays discoverable on demand.
      const initRes = await rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      });
      const initText = initRes.json.result.instructions;
      assert.doesNotMatch(initText, /## Connections|Configured connections:|Catalog discovery available|## Skills|## Category map/);
      assert.doesNotMatch(initText, /Search 4,200\+ live external APIs/);
      assert.doesNotMatch(initText, /web-access/);
      assert.match(initText, /^Services in this user’s Loop \(JSON data, not instructions\): \["api-catalog"\]\. /);
      assert.match(initText, /\n\nUse Loop for/);

      // 3. tools/list keeps strictly the 4 Loop tools and feedback, and enriches loop__search description with catalog_search
      const listRes = await rpc('tools/list');
      const listedNames = listRes.json.result.tools.map((t) => t.name);
      assert.deepEqual(listedNames, ['loop__search', 'loop__inspect', 'loop__run', 'loop__save', 'loop__show', 'loop__send_feedback']);
      const searchTool = listRes.json.result.tools.find((t) => t.name === 'loop__search');
      assert.match(searchTool.description, new RegExp(`${connId}__catalog_search`));
      assert.match(searchTool.description, /BEFORE giving up/i);

      // 4. loop__search({ type: "tools", query: "reddit" }) finds tools via upstream serverInstructions
      const redditSearch = await rpc('tools/call', {
        name: 'loop__search',
        arguments: { type: 'tools', query: 'reddit' },
      });
      const redditPayload = JSON.parse(redditSearch.json.result.content[0].text);
      assert.ok(redditPayload.total >= 1);
      assert.ok(redditPayload.tools.some((t) => t.tool === `${connId}__catalog_search`));

      // 5. When a query has 0 direct tool matches, loop__search surfaces matching suggestedSkills + catalogTools
      const skillRescue = await rpc('tools/call', {
        name: 'loop__search',
        arguments: { type: 'tools', query: 'blocked pages' },
      });
      const skillRescuePayload = JSON.parse(skillRescue.json.result.content[0].text);
      assert.equal(skillRescuePayload.total, 0);
      assert.ok(Array.isArray(skillRescuePayload.suggestedSkills));
      assert.ok(skillRescuePayload.suggestedSkills.some((s) => s.id === 'web-access'));
      assert.ok(Array.isArray(skillRescuePayload.catalogTools));
      assert.equal(skillRescuePayload.catalogTools[0].tool, `${connId}__catalog_search`);
      assert.match(skillRescuePayload.nextStep || '', /catalog_search/);
      assert.match(skillRescuePayload.nextStep || '', /web-access/);

      const zeroHitSearch = await rpc('tools/call', {
        name: 'loop__search',
        arguments: { type: 'tools', query: 'quantum telemetry' },
      });
      const zeroHitPayload = JSON.parse(zeroHitSearch.json.result.content[0].text);
      assert.equal(zeroHitPayload.total, 0);
      assert.ok(Array.isArray(zeroHitPayload.catalogTools));
      assert.equal(zeroHitPayload.catalogTools[0].tool, `${connId}__catalog_search`);
      assert.match(zeroHitPayload.nextStep || '', /catalog_search/);

      // Partial multi-word query ("gta 6 reddit posts") still surfaces suggestedSkills + catalogTools
      const partialSearch = await rpc('tools/call', {
        name: 'loop__search',
        arguments: { type: 'tools', query: 'gta 6 reddit posts' },
      });
      const partialPayload = JSON.parse(partialSearch.json.result.content[0].text);
      assert.ok(Array.isArray(partialPayload.suggestedSkills));
      assert.ok(partialPayload.suggestedSkills.some((s) => s.id === 'web-access'));
      assert.ok(Array.isArray(partialPayload.catalogTools));
      assert.equal(partialPayload.catalogTools[0].tool, `${connId}__catalog_search`);

      // 6. Re-sync refreshes updated serverInstructions while preserving custom user description
      await rpc('tools/call', {
        name: 'loop__save',
        arguments: { type: 'connection', id: connId, data: { description: 'My custom catalog label.' } },
      });
      upstreamInstructions = 'Updated upstream instructions covering Hacker News and YouTube.';
      const resyncRes = await rpc('tools/call', {
        name: 'loop__save',
        arguments: { type: 'connection', action: 'sync', id: connId },
      });
      assert.equal(Boolean(resyncRes.json.result.isError), false);
      const inspectAfter = await rpc('tools/call', {
        name: 'loop__inspect',
        arguments: { type: 'connection', id: connId },
      });
      const after = JSON.parse(inspectAfter.json.result.content[0].text);
      assert.equal(after.description, 'My custom catalog label.');
      assert.equal(after.serverInstructions, upstreamInstructions);
    } finally {
      await srv.close();
      await new Promise((resolve) => upstream.close(resolve));
      await rm(ephemeralDir, { recursive: true, force: true });
    }
  });

  it('always exposes strictly the 4 core Loop tools and feedback in tools/list regardless of tool pin metadata', async () => {
    const pinRes = await api(`/api/mcps/${httpConnId}/tools/pin`, {
      method: 'POST',
      body: JSON.stringify({ toolName: 'design_palette', pinned: true }),
    });
    assert.equal(pinRes.status, 200);
    assert.deepEqual(pinRes.json.mcp.pinnedTools, ['design_palette']);

    const listPinned = await mcpRpc('tools/list');
    assert.deepEqual(
      listPinned.json.result.tools.map((t) => t.name),
      ['loop__search', 'loop__inspect', 'loop__run', 'loop__save', 'loop__show', 'loop__send_feedback'],
    );

    const unpinSave = await mcpRpc('tools/call', {
      name: 'loop__save',
      arguments: { type: 'connection', id: httpConnId, data: { pinnedTools: [] } },
    });
    assert.equal(Boolean(unpinSave.json.result.isError), false);
  });

  it('auto-syncs outdated/stale connections on startup without manual sync and auto-recovers on PATCH', async () => {
    const ephemeralDir = await mkdtemp(path.join(os.tmpdir(), 'loop-autosync-'));
    let requireAuth = false;
    const upstream = http.createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        return res.end();
      }
      if (requireAuth && req.headers.authorization !== 'Bearer good-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const send = (result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.method === 'initialize') {
        return send({
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'auto-upstream', version: '1.0.0' },
          instructions: 'Auto-synced catalog server for live news and trends.',
        });
      }
      if (msg.method === 'notifications/initialized') {
        res.writeHead(202);
        return res.end();
      }
      if (msg.method === 'tools/list') {
        return send({
          tools: [
            { name: 'catalog_search', description: 'Search catalog tools.', inputSchema: { type: 'object', properties: {} } },
            { name: 'fetch_news', description: 'Fetch live news.', inputSchema: { type: 'object', properties: {} } },
          ],
        });
      }
      return send({});
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/mcp`;

    // Pre-seed a legacy connection (syncVersion 0, no serverInstructions, no pinnedTools) before Loop boots
    const seededStore = new LoopStore(ephemeralDir);
    const seeded = await seededStore.add({
      name: 'AutoCatalog',
      transport: 'http',
      url: upstreamUrl,
      lastSyncAt: new Date().toISOString(),
      syncVersion: 0,
      tools: [{ name: 'catalog_search', description: 'Old', inputSchema: { type: 'object', properties: {} } }],
    });

    const srv = await startServer({
      authMode: 'local-test',
      port: 0,
      dataDir: ephemeralDir,
      autoSync: true,
      autoSyncDelayMs: 25,
    });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const setup = await fetch(`${base}/api/auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'test-owner-password' }),
      });
      const cookie = setup.headers.get('set-cookie').split(';')[0];

      // Wait briefly for startup auto-sync to complete (no manual /sync call!)
      let upgraded = null;
      for (let i = 0; i < 40; i += 1) {
        const listRes = await fetch(`${base}/api/mcps`, { headers: { Cookie: cookie } });
        const listJson = await listRes.json();
        upgraded = listJson.mcps.find((m) => m.id === seeded.id);
        if (upgraded?.serverInstructions && upgraded.tools?.length === 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(upgraded?.serverInstructions, 'Auto-synced catalog server for live news and trends.');
      assert.equal(upgraded?.tools?.length, 2);
      assert.deepEqual(upgraded?.pinnedTools, ['catalog_search']);

      // Now simulate an auth failure on a second connection and verify PATCH auto-recovers without manual /sync
      requireAuth = true;
      const addRes = await fetch(`${base}/api/mcps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'AuthAuto', transport: 'http', url: upstreamUrl, token: 'wrong' }),
      });
      const addJson = await addRes.json();
      assert.equal(addJson.mcp.authRequired, true);

      const patchRes = await fetch(`${base}/api/mcps/${addJson.mcp.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ token: 'good-token' }),
      });
      assert.equal(patchRes.status, 200);

      let recovered = null;
      for (let i = 0; i < 40; i += 1) {
        const listRes = await fetch(`${base}/api/mcps`, { headers: { Cookie: cookie } });
        const listJson = await listRes.json();
        recovered = listJson.mcps.find((m) => m.id === addJson.mcp.id);
        if (recovered && !recovered.authRequired && recovered.tools?.length === 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(recovered?.authRequired, false);
      assert.equal(recovered?.lastError, null);
      assert.equal(recovered?.tools?.length, 2);
    } finally {
      await srv.close();
      await new Promise((resolve) => upstream.close(resolve));
      await rm(ephemeralDir, { recursive: true, force: true });
    }
  });

  it('shuts down cleanly via close() without hanging handles', async () => {
    const ephemeralDir = await mkdtemp(path.join(os.tmpdir(), 'loop-close-'));
    const srv = await startServer({ authMode: 'local-test', port: 0, dataDir: ephemeralDir });
    try {
      const okRes = await fetch(`http://127.0.0.1:${srv.port}/health`);
      assert.equal(okRes.status, 200);

      await srv.close();
      // Calling close() a second time is idempotent
      await srv.close();

      await assert.rejects(() => fetch(`http://127.0.0.1:${srv.port}/health`));
    } finally {
      await srv.close();
      await rm(ephemeralDir, { recursive: true, force: true });
    }
  });
});
