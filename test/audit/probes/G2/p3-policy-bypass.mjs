// P3: agent-controlled ways around always_ask policies and vault approval metadata.
import { startLegacy, startMockUpstream, result } from '../../harness.mjs';
process.on('unhandledRejection', (e) => result('UNHANDLED', String(e?.stack || e)));

const up = await startMockUpstream({});
const L = await startLegacy();
const parse = (r) => { try { return JSON.parse(r.result?.content?.[0]?.text); } catch { return r.result?.content?.[0]?.text ?? r.error ?? r.json; } };
const status = (r) => { const p = parse(r); return typeof p === 'object' && p?.status ? p.status : (String(r.result?.content?.[0]?.text || '').startsWith('echo:') ? 'EXECUTED' : p); };
try {
  const add = await L.api('/api/mcps', { method: 'POST', body: { name: 'Up', transport: 'http', url: up.url } });
  const conn = add.json.mcp.id;
  await L.api('/api/vault', { method: 'POST', body: { key: 'AUTO_S', value: 'auto-approved-secret-1234', approval: 'auto' } });
  const A = await L.createAgent({ name: 'Plain', canManage: false, secrets: ['AUTO_S'] });
  const M = await L.createAgent({ name: 'Manager', canManage: true, secrets: ['SH'] });
  const pat = await L.api('/api/policies', { method: 'PATCH', body: { connections: { [conn]: 'always_ask' } } });
  result('owner policy', pat.json?.policies?.connections);

  // (a) baseline
  result('a. baseline run', status(await L.callTool('loop__run', { tool: `${conn}__echo`, arguments: { message: 'pay bob 100' } }, { token: A.token })));
  // (b) same call + an unused argument that references an auto-approved shared secret
  result('b. run + unused {{vault:AUTO_S}} arg', status(await L.callTool('loop__run', { tool: `${conn}__echo`, arguments: { message: 'pay bob 100', _x: '{{vault:AUTO_S}}' } }, { token: A.token })));
  // (b2) direct-mode name too
  result('b2. direct tools/call + unused arg', status(await L.callTool(`${conn}__echo`, { message: 'pay bob 100', _x: '{{vault:AUTO_S}}' }, { token: A.token })));

  // (c) canManage agent flips the connection policy itself, no approval asked
  const flip = await L.callTool('loop__save', { type: 'connection', id: conn, approval: 'auto' }, { token: M.token });
  result('c. loop__save approval:auto', { isError: flip.result?.isError, text: String(flip.result?.content?.[0]?.text).slice(0, 80) });
  result('c. policies after', (await L.api('/api/policies')).json?.policies?.connections);
  result('c. plain agent run after flip', status(await L.callTool('loop__run', { tool: `${conn}__echo`, arguments: { message: 'pay bob 100' } }, { token: A.token })));
  result('c. pending approvals', (await L.api('/api/approvals')).json?.pending?.length);

  // (d) metadata-only save on a secret NOT shared with the agent: downgrade type+approval, read last-4
  await L.api('/api/vault', { method: 'POST', body: { key: 'PAY', value: '4111-1111-1111-4242', type: 'payment', approval: 'always_ask', description: 'Corporate card' } });
  await L.api('/api/policies', { method: 'PATCH', body: { actions: { save: 'always_ask' } } }); // owner even gates saves
  const meta = await L.callTool('loop__save', { type: 'note', id: 'PAY', data: {}, approval: 'auto' }, { token: M.token });
  result('d. metadata save on unshared PAY', parse(meta));
  const v = (await L.api('/api/vault')).json?.secrets?.find((s) => s.key === 'PAY');
  result('d. PAY in vault after', { type: v?.type, approval: v?.approval });
  // existence oracle for names the agent was never given
  result('d. oracle missing key', parse(await L.callTool('loop__save', { type: 'api_key', id: 'NOPE_KEY', data: {} }, { token: M.token })));
  result('d. oracle existing key', parse(await L.callTool('loop__save', { type: 'payment', id: 'PAY', data: {} }, { token: M.token }))?.saved);
  await L.api('/api/policies', { method: 'PATCH', body: { actions: { save: 'inherit' } } });

  // (e) value save of an existing shared secret silently resets the owner's approval + description
  await L.api('/api/vault', { method: 'POST', body: { key: 'SH', value: 'old-shared-value-5555', type: 'login', approval: 'always_ask', description: 'Owner note' } });
  const sv = await L.callTool('loop__save', { type: 'login', id: 'SH', data: { value: 'new-shared-value-6666' } }, { token: M.token });
  const sh = (await L.api('/api/vault')).json?.secrets?.find((s) => s.key === 'SH');
  result('e. SH after agent value save', { saveOk: !sv.result?.isError, type: sh?.type, approval: sh?.approval, description: sh?.description });

  // (f) stale per-connection policy survives delete and is inherited by a new connection with the same id
  await L.api('/api/policies', { method: 'PATCH', body: { default: 'always_ask', connections: { temp: 'auto' } } });
  const t1 = await L.api('/api/mcps', { method: 'POST', body: { name: 'Temp', transport: 'http', url: up.url } });
  await L.api(`/api/mcps/${t1.json.mcp.id}`, { method: 'DELETE' });
  const t2 = await L.callTool('loop__save', { type: 'connection', data: { name: 'Temp', transport: 'http', url: up.url } }, { token: M.token });
  result('f. policies after delete', (await L.api('/api/policies')).json?.policies?.connections);
  result('f. new temp run under default always_ask', status(await L.callTool('loop__run', { tool: 'temp__echo', arguments: { message: 'x' } }, { token: A.token })));
  result('f. control: up run under default always_ask (conn policy auto from c.)', status(await L.callTool('loop__run', { tool: `${conn}__echo`, arguments: { message: 'x' } }, { token: A.token })));

  // (g) tool-policy key ambiguity: connection "a__b" + tool "c" vs connection "a" + tool "b__c"
  const ab = await L.api('/api/mcps', { method: 'POST', body: { name: 'a__b', transport: 'http', url: up.url } });
  result('g. id for name a__b', ab.json?.mcp?.id ?? ab.json?.error);
} catch (e) { result('FATAL', String(e?.stack || e)); }
finally { await L.close(); await up.close(); }
