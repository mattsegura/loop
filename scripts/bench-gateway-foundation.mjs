// A local, disposable read-path smoke test. No upstream services, credentials, or deploy required.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { startServer } from '../server.mjs';

function integer(value, fallback, max) {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw Error(`Expected an integer between 1 and ${max}`);
  return n;
}
const count = integer(process.argv[2], 200, 10000);
const concurrency = Math.min(count, integer(process.argv[3], 8, 64));
const tenantCount = integer(process.argv[4], 4, 32);
const dataDir = await mkdtemp(join(tmpdir(), 'loop-gateway-bench-'));
let hub;
try {
  // Random, ephemeral fixture sessions: this only listens on a random loopback port.
  const sessions = new Map(Array.from({length:tenantCount}, (_, i) => [randomUUID(), 'user_fixture_' + i]));
  const issuer = 'https://fixture.invalid';
  const clerkApp = { frontendApi:issuer, publishableKey:'fixture', async verifyRequest(req) {
    const userId = sessions.get(req.headers['x-fixture-session']);
    return userId ? {userId, issuer, sessionId:userId, expiresAt:Date.now()+60000} : null;
  } };
  hub = await startServer({ port:0, hosted:true, clerkApp, dataDir, detectLocalAgents:false, searchEnv:{}, smsAgentEnv:{}, billingEnv:{} });
  const base = 'http://127.0.0.1:' + hub.port;
  const post = (url, body, headers = {}) => fetch(base + url, { method:'POST', headers:{ 'Content-Type':'application/json', ...headers }, body:JSON.stringify(body), signal:AbortSignal.timeout(10000) });
  const keys = [];
  for (const session of sessions.keys()) {
    const r = await post('/api/agents', { name:'Benchmark', kind:'other', profile:'all', canManage:false }, { 'x-fixture-session':session });
    assert.equal(r.status, 201); keys.push((await r.json()).token);
  }
  async function read(i) {
    const r = await post('/mcp', { jsonrpc: '2.0', id: i, method: 'tools/list', params: {} }, { Authorization: `Bearer ${keys[i%keys.length]}` });
    assert.equal(r.status, 200); const payload = await r.json(); assert.equal(payload.id, i);
    assert.ok(payload.result?.tools?.some(t => t.name === 'loop__search'), 'expected usable MCP discovery response');
  }
  for (let i=0; i<keys.length; i++) await read(i);
  const start = performance.now(), times = []; let issued = 0;
  const results = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
    while (issued < count) { const i = ++issued; const t = performance.now(); await read(i); times.push(performance.now()-t); }
  }));
  const failure = results.find(r => r.status === 'rejected'); if (failure) throw failure.reason;
  assert.equal(times.length, count); const elapsed = performance.now()-start; times.sort((a,b) => a-b);
  const ms = p => +times[Math.ceil(p*count)-1].toFixed(2);
  console.log(JSON.stringify({ workload:'authenticated tools/list, hosted fixture, warm', tenantCount, count, concurrency, requestsPerSecond:Math.round(count*1000/elapsed), p50Ms:ms(.5), p95Ms:ms(.95), p99Ms:ms(.99), node:process.version }));
} finally { try { await hub?.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } }
