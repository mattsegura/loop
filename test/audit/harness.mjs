import { tmpdir as __loopAuditTmp } from 'node:os';
// Shared probe harness from the 2026-11-20 Loop audit, now living in the repo.
//
// SAFETY CONTRACT (why this file exists):
//   * `import '<this file>'` MUST be the FIRST import of every probe. It repoints HOME, LOOP_HUB_DATA,
//     XDG_DATA_HOME and CLERK_PUBLISHABLE_KEY at throw-away values BEFORE any Loop module is loaded, so a probe can
//     never read or write the user's real Loop vault, the real agent configs (~/.claude.json, ~/.codex, ...) or the
//     real .env.local.
//   * Servers are started in-process on ephemeral ports (port 0). Never use port 8799 (that is the user's live service).
//   * Probes test the checkout this file sits in (PROJECT below), so a fix on a branch or in a worktree is what gets
//     tested there. They never write to the project.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SCRATCH = path.dirname(fileURLToPath(import.meta.url)); // test/audit
export const PROJECT = path.resolve(SCRATCH, '..', '..'); // the checkout under test
// highs.test.mjs sets LOOP_AUDIT_TMP to a folder it deletes afterwards; run by hand, sandboxes land in the OS temp dir.
export const SANDBOX = mkdtempSync(path.join(process.env.LOOP_AUDIT_TMP || __loopAuditTmp(), 'loop-audit-probe-'));
export const FAKE_HOME = path.join(SANDBOX, 'home');
export const DEFAULT_DATA = path.join(SANDBOX, 'default-data');
mkdirSync(FAKE_HOME, { recursive: true });
mkdirSync(DEFAULT_DATA, { recursive: true });

const FIXTURE_HOSTNAME = 'loop-probe.clerk.accounts.dev';
const FIXTURE_PK = `pk_test_${Buffer.from(`${FIXTURE_HOSTNAME}$`).toString('base64').replace(/=+$/, '')}`;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.LOOP_HUB_DATA = DEFAULT_DATA;
process.env.XDG_DATA_HOME = path.join(SANDBOX, 'xdg');
process.env.LOOP_NO_OPEN = '1';
process.env.CLERK_PUBLISHABLE_KEY = FIXTURE_PK; // never falls through to the real .env.local
for (const k of ['LOOP_HUB_PORT', 'LOOP_HUB_TOKEN', 'LOOP_HUB_URL', 'LOOP_HUB_ALLOWED_HOSTS', 'LOOP_TRUSTED_MCP_ORIGINS', 'LOOP_HUB_PROFILE', 'LOOP_HUB_MODE']) delete process.env[k];

const { startServer } = await import(`${PROJECT}/server.mjs`);
const { workspaceId } = await import(`${PROJECT}/lib/app-workspaces.mjs`);

let dirCounter = 0;
/** A fresh empty directory inside this probe's sandbox. */
export function sandboxDir(label = 'dir') {
  const dir = path.join(SANDBOX, `${label}-${++dirCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------------------------------------------
// Low-level HTTP: exact control over headers (Host, Origin, duplicates) and raw bytes. fetch() cannot do this.
// ---------------------------------------------------------------------------------------------------------------
/** Send one HTTP request with exactly the headers you give. Resolves (never rejects): {status, headers, rawHeaders, body, error}. */
export function rawHttp({ port, method = 'GET', path: reqPath = '/', headers = {}, body, noHost = false, timeoutMs = 5000, host = '127.0.0.1' }) {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    const h = { ...headers };
    if (payload && !Object.keys(h).some((k) => k.toLowerCase() === 'content-length')) h['content-length'] = payload.length;
    const req = http.request({ host, port, method, path: reqPath, headers: h, setHost: !noHost }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks).toString('utf8'), bodyBuffer: Buffer.concat(chunks) }));
      res.on('error', (error) => resolve({ error: error.code || error.message }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', (error) => resolve({ error: error.code || error.message }));
    req.end(payload);
  });
}

/** Write raw bytes to a TCP socket (malformed/smuggled HTTP). Resolves {response, closed, error}. */
export function rawSocket({ port, data, host = '127.0.0.1', timeoutMs = 2500 }) {
  return new Promise((resolve) => {
    let response = '';
    let settled = false;
    const done = (extra) => { if (!settled) { settled = true; sock.destroy(); resolve({ response, ...extra }); } };
    const sock = net.connect({ port, host }, () => sock.write(data));
    sock.on('data', (c) => { response += c.toString('latin1'); });
    sock.on('close', () => done({ closed: true }));
    sock.on('error', (error) => done({ error: error.code || error.message }));
    sock.setTimeout(timeoutMs, () => done({ closed: false, timedOut: true }));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// fetch-based API client (cookie / fixture-identity / bearer aware). Returns {status, headers, setCookies, text, json}.
// ---------------------------------------------------------------------------------------------------------------
function makeApi(base, defaults = {}) {
  return async function api(route, { method, body, headers = {}, timeoutMs = 10000 } = {}) {
    const h = { ...(defaults.headers || {}), ...headers };
    const hasBody = body !== undefined;
    if (hasBody && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(base + route, {
        method: method || (hasBody ? 'POST' : 'GET'), headers: h, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        body: hasBody ? (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined,
      });
    } catch (error) { return { status: 0, error: String(error?.cause?.code || error?.message || error), text: '' }; }
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, setCookies: res.headers.getSetCookie(), text, json };
  };
}

function makeRpc(api, pathPrefix, defaultToken) {
  /** JSON-RPC POST to the MCP endpoint. Pass rawBody to send arbitrary bytes. id:null => notification. */
  return function rpc(method, params, { token = defaultToken, query = '', id = 1, headers = {}, sessionId, rawBody, routePath = `${pathPrefix}/mcp` } = {}) {
    const body = rawBody ?? JSON.stringify({ jsonrpc: '2.0', ...(id !== null && id !== undefined ? { id } : {}), method, ...(params !== undefined ? { params } : {}) });
    return api(`${routePath}${query}`, {
      method: 'POST', body,
      headers: { accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(sessionId ? { 'mcp-session-id': sessionId } : {}), ...headers },
    });
  };
}

/** Call an MCP tool through the gateway and return {status, result, json}. */
function makeCallTool(rpc) {
  return async (name, args = {}, opts = {}) => {
    const r = await rpc('tools/call', { name, arguments: args }, opts);
    return { ...r, result: r.json?.result, error: r.json?.error };
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Server fixtures
// ---------------------------------------------------------------------------------------------------------------
/**
 * Single-owner "local-test" (password) mode == the root/local workspace. Already signed in (session cookie) and with one
 * all-access agent key that can manage connections.
 * Returns { port, base, dataDir, api, rpc, callTool, createAgent(body), agent:{id,token}, cookie, srv, close }.
 * `api` carries the owner session cookie. Use api(route,{headers:{cookie:''}}) style overrides for anonymous calls.
 */
export async function startLegacy({ dataDir = sandboxDir('data'), password = 'probe-owner-password', server = {}, agent = {} } = {}) {
  const srv = await startServer({ authMode: 'local-test', port: 0, dataDir, detectLocalAgents: false, home: FAKE_HOME, ...server });
  const base = `http://127.0.0.1:${srv.port}`;
  const anon = makeApi(base);
  const setup = await anon('/api/auth/setup', { method: 'POST', body: { password } });
  if (setup.status !== 200) throw new Error(`owner setup failed: ${setup.status} ${setup.text}`);
  const cookie = setup.setCookies[0]?.split(';')[0];
  const api = makeApi(base, { headers: { cookie } });
  const createAgent = async (body = {}) => {
    const r = await api('/api/agents', { method: 'POST', body: { name: 'Probe Agent', kind: 'other', profile: 'all', canManage: true, ...body } });
    if (r.status !== 201) throw new Error(`createAgent failed: ${r.status} ${r.text}`);
    return { id: r.json.agent.id, token: r.json.token, agent: r.json.agent };
  };
  const owner = await createAgent(agent);
  const rpc = makeRpc(api, '', owner.token);
  return { srv, port: srv.port, base, dataDir, password, cookie, anon, api, rpc, callTool: makeCallTool(rpc), createAgent, agent: owner, close: () => srv.close() };
}

/**
 * Multi-user Clerk-style mode (the production topology): identity comes from the X-Fixture-Auth header (any string you like
 * is accepted as the userId, e.g. 'user_A'). Starts Loop in hosted mode by default (`hosted: true`) unless overridden via
 * `server.hosted`. Pass `forwarded: true` to add X-Forwarded-For to every request.
 * Returns { port, base, dataDir, srv, as(userId) , anon, close }.
 *   as(user) -> { userId, workspaceId, api, rpc, callTool, createAgent(body), mcpPath }
 * Personal-workspace agents talk to /w/<workspaceId>/mcp (rpc() does this for you).
 */
export async function startMulti({ dataDir = sandboxDir('data'), forwarded = false, clerkApp, server = {} } = {}) {
  const frontendApi = `https://${FIXTURE_HOSTNAME}`;
  const app = clerkApp || {
    publishableKey: FIXTURE_PK, frontendApi,
    async verifyRequest(req) {
      const u = req.headers['x-fixture-auth'];
      return u ? { userId: String(u), sessionId: `sess_${String(u)}`, issuer: frontendApi, expiresAt: Date.now() + 60_000 } : null;
    },
  };
  const srv = await startServer({
    port: 0,
    dataDir,
    detectLocalAgents: false,
    home: FAKE_HOME,
    clerkApp: app,
    ...server,
    hosted: server.hosted !== undefined ? server.hosted : true,
  });
  const base = `http://127.0.0.1:${srv.port}`;
  const fwd = forwarded ? { 'x-forwarded-for': '203.0.113.7' } : {};
  const anon = makeApi(base, { headers: fwd });
  const cache = new Map();
  function as(userId, { personal = true } = {}) {
    const key = `${userId}|${personal}`;
    if (cache.has(key)) return cache.get(key);
    const wid = workspaceId({ issuer: frontendApi, userId });
    const api = makeApi(base, { headers: { 'x-fixture-auth': userId, ...fwd } });
    const mcpPath = personal ? `/w/${wid}` : '';
    const createAgent = async (body = {}) => {
      const r = await api('/api/agents', { method: 'POST', body: { name: `Agent ${userId}`, kind: 'other', profile: 'all', canManage: false, ...body } });
      if (r.status !== 201) throw new Error(`createAgent(${userId}) failed: ${r.status} ${r.text}`);
      return { id: r.json.agent.id, token: r.json.token, agent: r.json.agent };
    };
    const handle = { userId, workspaceId: wid, api, createAgent, mcpPath, rpcWith: (token) => makeRpc(anon, mcpPath, token) };
    handle.rpc = (method, params, o = {}) => makeRpc(anon, mcpPath, o.token)(method, params, o);
    handle.callTool = (name, args, o = {}) => makeCallTool(handle.rpc)(name, args, o);
    cache.set(key, handle);
    return handle;
  }
  return { srv, port: srv.port, base, dataDir, anon, as, workspaceId: (userId) => workspaceId({ issuer: frontendApi, userId }), frontendApi, close: () => srv.close() };
}

// ---------------------------------------------------------------------------------------------------------------
// Hostile / configurable upstream MCP servers
// ---------------------------------------------------------------------------------------------------------------
/**
 * Plain JSON-RPC-over-HTTP MCP upstream on 127.0.0.1 (same shape as test/gateway.test.mjs's mock). Options:
 *   token      -> require `Authorization: Bearer <token>` else 401
 *   tools      -> [{name, description, inputSchema}] (default: echo)
 *   resources / prompts -> arrays
 *   callTool   -> async (name, args, ctx) => MCP tool result object (default: echoes args as JSON text)
 *   handler    -> async (body, req, res, ctx) => true if it fully handled the request (hostile behaviours: delays, junk, huge bodies, SSE...)
 * Records every request in .requests = [{method, url, headers, body}].
 */
// Loop asks the owner before it runs a tool that carries no safety label. These scenarios are
// about what happens once a call runs, so the mock's tools say what they do unless a probe
// sets its own annotations, exactly as a hostile server would to avoid that question.
// `label: false` serves the tools as given.
const MOCK_TOOL_LABEL = Object.freeze({ readOnlyHint: false, destructiveHint: false });

export async function startMockUpstream({ token = null, tools, resources = [], prompts = [], callTool, handler, serverInfo, label = true } = {}) {
  const requests = [];
  const givenTools = tools || [{ name: 'echo', description: 'Echo arguments', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } }];
  const toolList = label ? givenTools.map((t) => (t && typeof t === 'object' && !t.annotations ? { ...t, annotations: MOCK_TOOL_LABEL } : t)) : givenTools;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body; try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
    const ctx = { raw, requests };
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (token && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
    if (handler && await handler(body, req, res, ctx)) return;
    if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST, DELETE' }); return res.end(); }
    if (!body || body.id === undefined || body.id === null) { res.writeHead(202); return res.end(); }
    const ok = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); };
    const fail = (code, message) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code, message } })); };
    switch (body.method) {
      case 'initialize': return ok({ protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: serverInfo || { name: 'probe-upstream', version: '1.0.0' } });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: toolList });
      case 'resources/list': return ok({ resources });
      case 'prompts/list': return ok({ prompts });
      case 'tools/call': {
        const { name, arguments: args = {} } = body.params || {};
        if (callTool) return ok(await callTool(name, args, ctx));
        return ok({ content: [{ type: 'text', text: `echo:${JSON.stringify(args)}` }] });
      }
      case 'resources/read': return ok({ contents: [{ uri: body.params?.uri, mimeType: 'text/plain', text: 'resource-body' }] });
      case 'prompts/get': return ok({ messages: [{ role: 'user', content: { type: 'text', text: 'prompt-body' } }] });
      default: return fail(-32601, `Method not found: ${body.method}`);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  return {
    port, url: `http://127.0.0.1:${port}/mcp`, requests,
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeIdleConnections?.(); server.closeAllConnections?.(); }),
  };
}

/**
 * Writes a tiny stdio MCP server script (uses the project's @modelcontextprotocol/sdk) and returns {command, args, scriptPath}.
 * `toolsSource` may be replaced with your own JS source for hostile behaviours (print junk to stdout, exit, hang, flood stderr).
 */
export function writeMockStdio(dir = sandboxDir('stdio'), { source } = {}) {
  const sdk = (p) => JSON.stringify(import.meta.resolve(`@modelcontextprotocol/sdk/${p}`));
  const script = source || `
import { Server } from ${sdk('server/index.js')};
import { StdioServerTransport } from ${sdk('server/stdio.js')};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${sdk('types.js')};
const server = new Server({ name: 'probe-stdio', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'read_env', description: 'Return an env var', inputSchema: { type: 'object', properties: { name: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'add', description: 'Add numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } }, annotations: { readOnlyHint: true } },
] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  if (name === 'read_env') return { content: [{ type: 'text', text: String(process.env[a.name] ?? '') }] };
  if (name === 'add') return { content: [{ type: 'text', text: String(Number(a.a) + Number(a.b)) }] };
  throw new Error('Unknown tool: ' + name);
});
await server.connect(new StdioServerTransport());
`;
  const scriptPath = path.join(dir, 'mock-stdio.mjs');
  writeFileSync(scriptPath, script);
  return { command: process.execPath, args: [scriptPath], scriptPath };
}

// ---------------------------------------------------------------------------------------------------------------
// Clerk JWT fixtures (for lib/clerk-app.mjs verification probes). Mirrors test/clerk-identity.test.mjs.
// ---------------------------------------------------------------------------------------------------------------
export async function clerkFixture({ hostname = 'renewing-bobcat-00.clerk.accounts.dev', port = 8799 } = {}) {
  const jose = await import('jose');
  const { loadClerkApp } = await import(`${PROJECT}/lib/clerk-app.mjs`);
  const pk = `pk_test_${Buffer.from(`${hostname}$`).toString('base64').replace(/=+$/, '')}`;
  process.env.CLERK_PUBLISHABLE_KEY = pk;
  const keyPair = await jose.generateKeyPair('RS256');
  const jwks = { keys: [{ ...await jose.exportJWK(keyPair.publicKey), kid: 'probe', alg: 'RS256' }] };
  const issuer = `https://${hostname}`;
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const now = () => Math.floor(Date.now() / 1000);
  const sign = (claims = {}, headerChanges = {}, key = keyPair.privateKey) =>
    new jose.SignJWT({ iss: issuer, sub: 'user_A', sid: 'sess_A', azp: origin, v: 2, iat: now(), nbf: now() - 10, exp: now() + 60, ...claims })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'probe', ...headerChanges }).sign(key);
  const app = loadClerkApp({ jwks });
  const verify = (headers, p = port) => app.verifyRequest({ headers: { host, ...headers } }, p);
  return { jose, app, sign, verify, issuer, origin, host, port, jwks, keyPair, pk, now };
}

/** Print a machine-greppable result line. Use for the facts you want quoted in a report. */
export function result(label, value) { console.log(`PROBE-RESULT ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`); }
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export { startServer, workspaceId };
