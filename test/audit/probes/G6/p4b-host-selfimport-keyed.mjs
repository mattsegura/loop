import { SANDBOX, FAKE_HOME, startLegacy, result } from '../../harness.mjs';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
if (!os.homedir().startsWith(SANDBOX) || !FAKE_HOME.startsWith(SANDBOX)) throw new Error('SAFETY: homedir not sandboxed');
delete process.env.CODEX_HOME;
process.on('unhandledRejection', (e) => result('UNHANDLED', String(e?.stack || e)));
process.on('uncaughtException', (e) => result('UNCAUGHT', String(e?.stack || e)));

// Probe-side shim ONLY: the project's working tree currently references MemoryStore in lib/mcp-server.mjs without importing it
// (in-progress edit by the developer). Defining the global lets /mcp run so the importer behaviour can be observed.
if (typeof globalThis.MemoryStore === 'undefined') globalThis.MemoryStore = (await import('../../../../lib/memory.mjs')).MemoryStore;
const text = (r) => { const t = r.result?.content?.[0]?.text; try { return JSON.parse(t); } catch { return t ?? r.json ?? r.text; } };
const srv = await startLegacy();
try {
  const P = srv.port;
  const T = srv.agent.token;
  // Cursor connects to Loop with an agent key under a non-default entry name; Claude Code uses the default name "loop".
  await mkdir(path.join(FAKE_HOME, '.cursor'), { recursive: true });
  const cursorPath = path.join(FAKE_HOME, '.cursor', 'mcp.json');
  await writeFile(cursorPath, JSON.stringify({ mcpServers: { 'loop-hub': { url: `http://127.0.0.1:${P}/mcp`, headers: { Authorization: `Bearer ${T}` } } } }, null, 2));
  const claudePath = path.join(FAKE_HOME, '.claude.json');
  await writeFile(claudePath, JSON.stringify({ mcpServers: {} }, null, 2));

  // 1. REST discovery (passes loopPort) vs MCP host discovery (passes nothing).
  const rest = await srv.api('/api/import/sources');
  result('rest.statuses', rest.json.sources.flatMap((s) => s.servers.map((x) => `${s.id}:${x.name}:${x.status}`)));
  const discRaw = await srv.callTool("loop__run", { tool: "loop_host__discover", arguments: { scope: "connections" } }); result("mcp.discover.raw", JSON.stringify(discRaw.json).slice(0, 600)); const disc = text(discRaw);
  result('mcp.discover.statuses', disc.connections.sources.flatMap((s) => s.servers.map((x) => `${s.id}:${x.name}:${x.status}`)));

  // 2. Import exactly as skills/sync-agents/SKILL.md step 4.1 says.
  const imp = text(await srv.callTool('loop__run', { tool: 'loop_host__import', arguments: { scope: 'connections' } }));
  result('mcp.import.results', imp.connections?.results?.map((r) => `${r.id}:${r.status}:${r.detail}`));
  result('mcp.import.secretsMoved', imp.secretsMoved);
  const mcps = (await srv.api('/api/mcps')).json;
  const list = mcps.mcps || mcps;
  result('loop.connections', list.map((m) => `${m.id} -> ${m.url} tools=${(m.tools || []).map((t) => t.name).join(',')}`));
  const vault = (await srv.api('/api/vault')).json;
  result('vault.keys', (vault.secrets || vault.items || vault).map?.((s) => s.key));

  // 3. Privilege escalation: an agent WITHOUT canManage reaches host tools through the self-connection, as the imported key.
  const bot = await srv.createAgent({ name: 'Restricted Bot', canManage: false, profile: 'all' });
  const direct = await srv.callTool('loop__run', { tool: 'loop_host__discover', arguments: { scope: 'connections' } }, { token: bot.token });
  result('bot.direct.hostTool', String(text(direct)).slice(0, 120));
  const selfConn = list.find((m) => m.url && m.url.includes(`:${P}/`));
  if (selfConn) {
    const via = await srv.callTool('loop__run', { tool: `${selfConn.id}__loop__run`, arguments: { tool: 'loop_host__discover', arguments: { scope: 'connections' } } }, { token: bot.token });
    const t = text(via);
    result('bot.viaSelf.isError', via.result?.isError);
    result('bot.viaSelf.output', (typeof t === 'string' ? t : JSON.stringify(t)).slice(0, 300));
  }

  // 4. Cleanup as sync-agents step 4.2 says (owner approves in the dashboard).
  const c1 = text(await srv.callTool('loop__run', { tool: 'loop_host__cleanup', arguments: { scope: 'connections' } }));
  result('cleanup.first', { status: c1.status, approvalId: Boolean(c1.approvalId) });
  if (c1.approvalId) {
    const ap = await srv.api(`/api/approvals/${encodeURIComponent(c1.approvalId)}/approve`, { method: 'POST', body: {} });
    result('cleanup.approve', ap.status);
    const c2 = text(await srv.callTool('loop__run', { tool: 'loop_host__cleanup', arguments: { scope: 'connections' }, approvalId: c1.approvalId }));
    result('cleanup.agents', c2.connections?.agents?.map((a) => ({ id: a.id, removed: a.removed.map((x) => x.name), kept: a.kept.map((x) => `${x.name}:${x.reason}`) })));
  }
  result('cursor.after', JSON.parse(await readFile(cursorPath, 'utf8')));
  result('claude.after', JSON.parse(await readFile(claudePath, 'utf8')));
} catch (e) {
  result('ERROR', e.stack);
} finally {
  await srv.close();
}
console.log('done');
