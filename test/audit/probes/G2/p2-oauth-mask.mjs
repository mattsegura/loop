// P2: the OAuth access token Loop injects from conn.oauth.accessTokenVaultKey is not part of secretsToMask().
import { startLegacy, startMockUpstream, sandboxDir, result } from '../../harness.mjs';
process.on('unhandledRejection', (e) => result('UNHANDLED', String(e?.stack || e)));
const { Vault } = await import('../../../../lib/vault.mjs');
const { LoopStore } = await import('../../../../lib/store.mjs');

const OAUTH_TOKEN = 'ya29.oauth-access-token-SECRET-000111222';
// Upstream "whoami"-style tool that reflects the Authorization header it received (like many debug/introspection tools or API error bodies).
const up = await startMockUpstream({
  tools: [{ name: 'whoami', description: 'who am I', inputSchema: { type: 'object' } }],
  callTool: async (name, args, ctx) => ({ content: [{ type: 'text', text: `auth header was: ${ctx.requests.at(-1).headers.authorization}` }] }),
  handler: async (body, req, res) => {
    if (body?.method === 'resources/read') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { contents: [{ uri: 'x', text: `token=${req.headers.authorization}` }] } }));
      return true;
    }
    return false;
  },
});
const dataDir = sandboxDir('data');
const vault = new Vault(dataDir);
await vault.set('__oauth_access_oauthy', OAUTH_TOKEN, 'OAuth access token');
const store = new LoopStore(dataDir);
const added = await store.add({ name: 'Oauthy', transport: 'http', url: up.url });
await store.update(added.id, { oauth: { accessTokenVaultKey: '__oauth_access_oauthy', expiresAt: Date.now() + 3600_000 } });
result('pre-seeded connection', { id: added.id, oauth: (await store.get(added.id)).oauth });

const L = await startLegacy({ dataDir });
try {
  const sync = await L.api(`/api/mcps/${added.id}/sync`, { method: 'POST' });
  result('sync', { status: sync.status, tools: sync.json?.mcp?.tools?.map((t) => t.name), err: sync.json?.error || sync.json?.mcp?.lastError });
  const ag = await L.createAgent({ name: 'NoSecrets', canManage: false, secrets: [] });
  const r = await L.callTool('loop__run', { tool: `${added.id}__whoami`, arguments: {} }, { token: ag.token });
  const text = r.result?.content?.[0]?.text;
  result('whoami via loop__run', { text, leaked: String(text).includes(OAUTH_TOKEN) });
  const rr = await L.rpc('resources/read', { uri: `loop://${added.id}/${encodeURIComponent('x')}` }, { token: ag.token });
  result('resources/read result', { text: rr.json?.result?.contents?.[0]?.text, leaked: JSON.stringify(rr.json).includes(OAUTH_TOKEN) });
  // Control: the same reflection with a header placeholder token IS masked.
  await vault.set('HDR_TOKEN', 'header-placeholder-token-999888', '');
  const add2 = await L.api('/api/mcps', { method: 'POST', body: { name: 'Hdr', transport: 'http', url: up.url, headers: { Authorization: 'Bearer {{vault:HDR_TOKEN}}' } } });
  const r2 = await L.callTool('loop__run', { tool: `${add2.json?.mcp?.id}__whoami`, arguments: {} }, { token: ag.token });
  result('control: header placeholder whoami', r2.result?.content?.[0]?.text);
} catch (e) { result('FATAL', String(e?.stack || e)); }
finally { await L.close(); await up.close(); }
