// Import path: header/arg secrets are moved to the Vault, URL-embedded tokens are not and reach agents.
import { startLegacy, startMockUpstream, result } from '../../harness.mjs';
process.on('unhandledRejection', (e) => console.log('UNHANDLED', e?.stack || e));
const txt = (r) => r.result?.content?.[0]?.text || r.error?.message || r.text || '';
const up = await startMockUpstream({ tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object' } }], callTool: async () => ({ content: [{ type: 'text', text: 'pong' }] }) });
const L = await startLegacy();
const json = JSON.stringify({ mcpServers: {
  hdr: { type: 'http', url: up.url, headers: { Authorization: 'Bearer sk-live-HEADERSECRET-1234567890' } },
  pathtok: { type: 'http', url: `${up.url}/s/PATHTOKEN7x9Qk2Lm4Np6Rs8Tv0Wy3Za5/x` },
  querytok: { type: 'http', url: `${up.url}?api_key=sk-live-QUERYSECRET-1234567890` },
} });
const imp = await L.api('/api/mcps/import', { body: { json } });
result('import', { s: imp.status, added: imp.json?.added ?? imp.json?.imported?.length, skipped: imp.json?.skipped });
const mcps = (await L.api('/api/mcps')).json?.mcps || [];
result('stored after import', mcps.map((m) => ({ id: m.id, url: m.url, headerKeys: m.headerKeys })));
const vaultKeys = ((await L.api('/api/vault')).json?.secrets || []).map((s) => s.key);
result('vault keys after import', vaultKeys);
const agent = await L.createAgent({ name: 'NoSecrets', canManage: false });
const s = txt(await L.callTool('loop__search', { type: 'connections' }, { token: agent.token }));
result('agent (no secrets shared) loop__search connections', { headerSecretVisible: s.includes('HEADERSECRET'), queryTokenVisible: s.includes('QUERYSECRET'), pathTokenVisible: s.includes('PATHTOKEN7x9') });
await L.close();
await up.close?.();
console.log('DONE');
