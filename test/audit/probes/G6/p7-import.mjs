import { SANDBOX, FAKE_HOME, sandboxDir, startLegacy, startMockUpstream, writeMockStdio, result } from '../../harness.mjs';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
if (!os.homedir().startsWith(SANDBOX) || !FAKE_HOME.startsWith(SANDBOX)) throw new Error('SAFETY: homedir not sandboxed');
delete process.env.CODEX_HOME;
process.on('unhandledRejection', (e) => result('UNHANDLED', String(e?.stack || e)));
if (typeof globalThis.MemoryStore === 'undefined') globalThis.MemoryStore = (await import('../../../../lib/memory.mjs')).MemoryStore; // probe-side shim for in-progress project edit

const { importCandidates, candidatesFromMcpJson } = await import('../../../../lib/importers.mjs');
const { LoopStore } = await import('../../../../lib/store.mjs');
const { Vault } = await import('../../../../lib/vault.mjs');
const text = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r.json);

/* (c)+(d) unit level: an existing secret with the same derived key + value is reused, its description overwritten, and DELETED on rollback */
try {
  const data = sandboxDir('vault');
  const store = new LoopStore(data);
  const vault = new Vault(data);
  await vault.set('remote_Authorization', 'shared-token-123', { description: 'My prod API token (used by Remote MCP)', type: 'api_key', approval: 'always_ask' });
  const good = await store.add({ name: 'remote', transport: 'http', url: 'https://remote.example.test/mcp', headers: { Authorization: 'Bearer {{vault:remote_Authorization}}' } });
  // Another agent has a same-named entry with the same token but a ws:// URL (passes toCandidate, rejected by store.add).
  const items = candidatesFromMcpJson({ mcpServers: { remote: { url: 'ws://127.0.0.1:3999/mcp', headers: { Authorization: 'Bearer shared-token-123' } } } }, {});
  const res = await importCandidates(store, vault, items);
  result('rollback.skipped', res.skipped);
  result('rollback.secretAfter', await vault.get('remote_Authorization'));
  result('rollback.existingConnStillReferencesIt', (await store.get(good.id)).headers.Authorization);

  await vault.set('svc_API_KEY', 'same-value', { description: 'Hand-written note: rotate every 90 days', approval: 'always_ask' });
  await importCandidates(store, vault, candidatesFromMcpJson({ mcpServers: { svc: { command: 'npx', args: ['-y', 'svc-mcp'], env: { API_KEY: 'same-value' } } } }, {}));
  result('reuse.metaAfter', await vault.getMeta('svc_API_KEY'));
} catch (e) { result('unit.error', e.stack); }

/* (a)(b)(e) server level */
const up = await startMockUpstream({ tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' } }] });
const srv = await startLegacy();
try {
  // (a) Codex server explicitly disabled by the user; /api/import/absorb imports it ENABLED and starts it.
  const stdio = writeMockStdio(sandboxDir('stdio'));
  await mkdir(path.join(FAKE_HOME, '.codex'), { recursive: true });
  const codexCfg = path.join(FAKE_HOME, '.codex', 'config.toml');
  await writeFile(codexCfg, `[mcp_servers.disabled_tool]\ncommand = ${JSON.stringify(stdio.command)}\nargs = [${JSON.stringify(stdio.scriptPath)}]\nenabled = false\n`);
  const disc = await srv.api('/api/import/sources');
  result('absorb.discovered', disc.json.sources.flatMap((s) => s.servers.map((x) => `${s.id}:${x.name}:${x.status}:enabled=${x.enabled}`)));
  const absorb = await srv.api('/api/import/absorb', { method: 'POST', body: {} });
  result('absorb.status', `${absorb.status} imported=${absorb.json?.importedCount} cleaned=${absorb.json?.cleanedCount}`);
  const after = (await srv.api('/api/mcps')).json;
  const conns = after.mcps || after;
  result('absorb.loopEntry', conns.filter((m) => m.name === 'disabled_tool').map((m) => ({ enabled: m.enabled, tools: (m.tools || []).map((t) => t.name), lastSyncAt: Boolean(m.lastSyncAt) })));
  result('absorb.codexConfigAfter', await readFile(codexCfg, 'utf8'));

  // (b) pasted JSON with "disabled": true is imported enabled.
  const pasted = await srv.api('/api/mcps/import', { method: 'POST', body: { json: JSON.stringify({ mcpServers: { paused: { url: up.url, disabled: true } } }) } });
  result('pasted.disabled.enabledInLoop', (pasted.json?.added || []).map((m) => `${m.name}:enabled=${m.enabled}`));

  // (e) URL-embedded API key stays plaintext and is shown to a RESTRICTED agent.
  const keyed = `${up.url}?api_key=URLSECRET-0123456789abcdef`;
  const imp = await srv.api('/api/mcps/import', { method: 'POST', body: { json: JSON.stringify({ mcpServers: { keyed: { url: keyed } } }) } });
  result('urlkey.import', `${imp.status} secretsMoved=${imp.json?.secretsMoved}`);
  const cfg = await readFile(path.join(srv.dataDir, 'config.json'), 'utf8');
  result('urlkey.plaintextInConfigJson', cfg.includes('URLSECRET-0123456789abcdef'));
  const bot = await srv.createAgent({ name: 'Read-only bot', canManage: false, profile: 'all' });
  const search = text(await srv.callTool('loop__search', { type: 'connections' }, { token: bot.token }));
  result('urlkey.restrictedAgent.loop__search.leaks', search.includes('URLSECRET-0123456789abcdef'));
  const id = (imp.json?.added || [])[0]?.id;
  const insp = text(await srv.callTool('loop__inspect', { type: 'connection', id }, { token: bot.token }));
  result('urlkey.restrictedAgent.loop__inspect.leaks', insp.includes('URLSECRET-0123456789abcdef'));
  const m = insp.match(/[^"\s]*URLSECRET[^"\s]*/);
  result('urlkey.restrictedAgent.sample', m ? m[0] : null);
} catch (e) { result('server.error', e.stack); } finally { await srv.close(); await up.close(); }
console.log('done');
