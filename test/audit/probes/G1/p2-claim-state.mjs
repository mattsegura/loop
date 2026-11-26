// P2: forUser() auto-claim on the device (no password), claim-local reachability, two processes on one data dir,
// and local-clerk-owner.json failure modes (fault-injected ENOSPC, corrupt file at startup).
import { startLegacy, startMulti, startServer, rawHttp, clerkFixture, sandboxDir, result, FAKE_HOME } from '../../harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

process.on('unhandledRejection', (e) => result('UNHANDLED', String(e?.stack || e).slice(0, 300)));
const C = await clerkFixture({ hostname: 'renewing-bobcat-00.clerk.accounts.dev' });
const j = (r) => { try { return JSON.parse(r.body); } catch { return r.body; } };
const as = (port, sub, route = '/api/auth/status', opts = {}) => C.sign({ sub, sid: `sess_${sub.slice(5)}`, azp: `http://127.0.0.1:${port}` })
  .then((t) => rawHttp({ port, path: route, method: opts.method || 'GET', body: opts.body, headers: { authorization: `Bearer ${t}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) } }));

async function legacyRoot(label) {
  const dataDir = sandboxDir(label);
  const L = await startLegacy({ dataDir, password: 'original-owner-pass' });
  await L.api('/api/vault', { method: 'POST', body: { key: 'OWNER_SECRET', value: 'owner-value' } });
  const agent = L.agent; await L.close();
  return { dataDir, agent };
}

// a) A second account on the same Mac signs in first: auto-claims without ever giving the original Loop password.
try {
  const seed = await legacyRoot('a');
  const M = await startMulti({ dataDir: seed.dataDir, clerkApp: C.app, server: { hosted: false } });
  try {
    const st = await as(M.port, 'user_housemate');
    result('a.first device sign-in by a NON-owner account', { workspace: j(st).workspace, canImportLocal: j(st).canImportLocal });
    const tok = await as(M.port, 'user_housemate', `/api/agents/${seed.agent.id}/token`);
    result('a.housemate reads the original owner agent key', j(tok).token === seed.agent.token);
    const claimSelf = await as(M.port, 'user_housemate', '/api/auth/claim-local', { method: 'POST', body: { password: 'WRONG' } });
    result('a.claim-local even for the claimer itself', { status: claimSelf.status, body: j(claimSelf) });
    const claimPath = path.join(seed.dataDir, 'local-clerk-owner.json');
    result('a.claim file', fs.existsSync(claimPath) ? fs.readFileSync(claimPath, 'utf8').trim() : 'none');
  } finally {
    await M.close();
  }
} catch (e) { result('a.error', String(e?.stack || e)); }

// b) Two Loop processes on one data dir (e.g. the service plus a manual run on another LOOP_HUB_PORT).
try {
  const seed = await legacyRoot('b');
  const M1 = await startMulti({ dataDir: seed.dataDir, clerkApp: C.app, server: { hosted: false } });
  const M2 = await startMulti({ dataDir: seed.dataDir, clerkApp: C.app, server: { hosted: false } });
  try {
    const s1 = await as(M1.port, 'user_owner');
    const s2 = await as(M2.port, 'user_owner');
    result('b.owner on process 1', { workspace: j(s1).workspace });
    result('b.same owner on process 2', { workspace: j(s2).workspace, localAvailable: j(s2).localAvailable });
    const c2 = await as(M2.port, 'user_owner', '/api/auth/claim-local', { method: 'POST', body: { password: 'original-owner-pass' } });
    result('b.restore offered on process 2 then fails', { status: c2.status, body: j(c2) });
    const v2 = await as(M2.port, 'user_owner', '/api/vault');
    result('b.owner vault on process 2', j(v2).secrets?.map((s) => s.key));
  } finally {
    await M1.close(); await M2.close();
  }
} catch (e) { result('b.error', String(e?.stack || e)); }

// c) The claim write fails half-way (ENOSPC injected after O_EXCL create, as a full disk would do).
try {
  const seed = await legacyRoot('c');
  const M = await startMulti({ dataDir: seed.dataDir, clerkApp: C.app, server: { hosted: false } });
  const orig = fs.writeFileSync;
  try {
    let injected = 0;
    fs.writeFileSync = function (p, d, o) {
      if (String(p).endsWith('local-clerk-owner.json') && !injected++) {
        fs.closeSync(fs.openSync(p, 'wx', 0o600));
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      return orig.call(this, p, d, o);
    };
    syncBuiltinESMExports();
    const first = await as(M.port, 'user_owner');
    const second = await as(M.port, 'user_owner');
    fs.writeFileSync = orig; syncBuiltinESMExports();
    result('c.first device sign-in while disk full', { status: first.status, body: j(first) });
    result('c.next sign-in (disk ok again)', { status: second.status, workspace: j(second).workspace });
    const claimPath = path.join(seed.dataDir, 'local-clerk-owner.json');
    result('c.claim file size', fs.existsSync(claimPath) ? fs.statSync(claimPath).size : 0);
  } finally {
    fs.writeFileSync = orig; syncBuiltinESMExports();
    await M.close();
  }
  try { const again = await startServer({ port: 0, dataDir: seed.dataDir, detectLocalAgents: false, home: FAKE_HOME, clerkApp: C.app }); result('c.restart', 'started'); await again.close(); }
  catch (e) { result('c.restart after half-written claim', `${e.name}: ${e.message}`); }
} catch (e) { result('c.error', String(e?.stack || e)); }

// d) Other malformed claim files at startup.
for (const [name, content] of Object.entries({ emptyObject: '{}', jsonNull: 'null', badId: '{"workspace":"x"}', directory: null })) {
  const dataDir = sandboxDir(`d-${name}`);
  const file = path.join(dataDir, 'local-clerk-owner.json');
  if (content === null) fs.mkdirSync(file); else fs.writeFileSync(file, content);
  try { const s = await startServer({ port: 0, dataDir, detectLocalAgents: false, home: FAKE_HOME, clerkApp: C.app }); result(`d.${name}`, 'started'); await s.close(); }
  catch (e) { result(`d.${name}`, `${e.name}: ${e.message}`); }
}
console.log('P2 DONE');
