import { startMulti, result } from '../../harness.mjs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
process.on('unhandledRejection', (e) => console.log('UNHANDLED', e?.stack || e));
const M = await startMulti({ forwarded: true });
const A = M.as('user_attacker'); const B = M.as('user_victim');
const cfg = path.join(M.dataDir, 'user-workspaces', A.workspaceId, 'config.json');
const bAgent = await B.createAgent({ name: 'victim-bot' });
const timeB = async () => { const t = Date.now(); const r = await B.rpc('tools/list', undefined, { token: bAgent.token }); return { s: r.status, ms: Date.now() - t }; };
result('victim baseline tools/list', await timeB());
// attacker: plain signed-in user, no upstream, no special rights. Each agent gets ~900 KB of "secret grant" names.
const big = Array.from({ length: 9 }, (_, i) => `K${i}_` + 'x'.repeat(100000));
let t = Date.now(); let made = 0;
for (let i = 0; i < 40; i++) {
  const r = await A.api('/api/agents', { body: { name: `bloat ${i}`, secrets: big }, timeoutMs: 30000 });
  if (r.status === 201) made++; else { result('stopped', r.status + ' ' + r.text.slice(0, 120)); break; }
}
result('attacker created agents', { made, ms: Date.now() - t, configMB: ((await stat(cfg).catch(() => ({ size: 0 }))).size / 1e6).toFixed(1) });
result('attacker own GET /api/settings', await (async () => { const t0 = Date.now(); const r = await A.api('/api/settings'); return { s: r.status, ms: Date.now() - t0 }; })());
result('victim tools/list, idle attacker', await timeB());
// attacker keeps 8 cheap requests in flight; victim measures
const stop = { v: false }; let fired = 0;
const loops = Array.from({ length: 8 }, async () => { while (!stop.v) { fired++; await A.api('/api/settings', { timeoutMs: 60000 }); } });
await new Promise((r) => setTimeout(r, 500));
const samples = []; for (let i = 0; i < 5; i++) samples.push((await timeB()).ms);
stop.v = true; await Promise.all(loops);
result('victim tools/list while attacker loops 8 GETs', { victimMs: samples, attackerRequests: fired });
await M.close();
console.log('DONE');
