import { SANDBOX, FAKE_HOME, startLegacy, startMockUpstream, result } from '../../harness.mjs';
import os from 'node:os';
if (!os.homedir().startsWith(SANDBOX) || !FAKE_HOME.startsWith(SANDBOX)) throw new Error('SAFETY: homedir not sandboxed');
delete process.env.CODEX_HOME;
process.on('unhandledRejection', (e) => result('UNHANDLED', String(e?.stack || e)));
if (typeof globalThis.MemoryStore === 'undefined') globalThis.MemoryStore = (await import('../../../../lib/memory.mjs')).MemoryStore;

const txt = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r.json);
const upSave = await startMockUpstream();
const upImport = await startMockUpstream();
const srv = await startLegacy();
try {
  await srv.api('/api/vault', { method: 'POST', body: { key: 'stripe_live_key', value: 'sk_live_OWNER_ONLY_0123456789', description: 'not shared with any agent' } });
  // A management agent that was deliberately given NO vault secrets.
  const mgr = await srv.createAgent({ name: 'Ops Agent', canManage: true, profile: 'all', secrets: [] });
  result('mgr.secrets', mgr.agent.secrets);
  const otherKey = `__agent_token_${srv.agent.id}`;

  // Path 1 (G3b zone, for comparison): loop__save a connection whose header references the unshared secret.
  const saveRes = await srv.callTool('loop__save', { type: 'connection', dryRun: false, data: { name: 'save-probe', url: upSave.url, headers: { 'X-K': '{{vault:stripe_live_key}}' } } }, { token: mgr.token });
  result('loop__save.response', txt(saveRes).slice(0, 220));
  await new Promise((r) => setTimeout(r, 800));
  result('loop__save.upstreamGot', upSave.requests.map((r) => r.headers['x-k']).filter(Boolean)[0] ?? null);

  // Path 2 (importer): loop_host__import with raw mcpJson.
  const mcpJson = JSON.stringify({ mcpServers: { 'import-probe': { url: upImport.url, headers: { 'X-K': '{{vault:stripe_live_key}}', 'X-Agent': `{{vault:${otherKey}}}` } } } });
  const impRes = await srv.callTool('loop__run', { tool: 'loop_host__import', arguments: { scope: 'connections', mcpJson } }, { token: mgr.token });
  const parsed = (() => { try { return JSON.parse(txt(impRes)); } catch { return txt(impRes); } })();
  result('import.response', typeof parsed === 'string' ? parsed.slice(0, 200) : parsed.connections?.results);
  const got = upImport.requests.find((r) => r.headers['x-k']);
  result('import.upstreamGot.X-K', got?.headers['x-k'] ?? null);
  result('import.upstreamGot.X-Agent(other agent key)', got ? got.headers['x-agent'] === srv.agent.token : null);
} catch (e) { result('ERROR', e.stack); } finally { await srv.close(); await upSave.close(); await upImport.close(); }
console.log('done');
