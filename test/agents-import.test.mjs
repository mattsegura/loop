import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startServer } from '../server.mjs';
import { LoopStore } from '../lib/store.mjs';
import { Vault } from '../lib/vault.mjs';
import { PolicyStore } from '../lib/policies.mjs';
import { CategoryStore } from '../lib/categories.mjs';
import { buildSelfIdentity, createOutboundPolicy } from '../lib/outbound-policy.mjs';
import {
  admitConnectionWrite,
  deleteConnection,
  extractConnectionSecrets,
  extractUrlSecrets,
  sinkOf,
  sinksEqual,
} from '../lib/connection-admission.mjs';
import {
  candidatesFromMcpJson,
  cleanupAgentConfigs,
  discoverSources,
  importCandidates,
  isDuplicateEntry,
  isExactDuplicateForCleanup,
  parseJsonc,
  parseToml,
  parseTomlLite,
  previewOf,
  removeJsoncKeys,
  removeTomlMcpServers,
  resolveCleanupPlan,
  secretArgs,
  sourceDefinitions,
} from '../lib/importers.mjs';

async function writeMockStdio(dir) {
  const serverModUrl = import.meta.resolve('@modelcontextprotocol/sdk/server/index.js');
  const stdioModUrl = import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js');
  const typesModUrl = import.meta.resolve('@modelcontextprotocol/sdk/types.js');
  const script = `
import { Server } from ${JSON.stringify(serverModUrl)};
import { StdioServerTransport } from ${JSON.stringify(stdioModUrl)};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(typesModUrl)};
import { createHash } from 'node:crypto';
const server = new Server({ name: 'mock', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo_arg', description: 'Echo the secret argument', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    { name: 'echo_input', description: 'Echo the text argument', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'echo_input') {
    const text = String(req.params.arguments?.text ?? '');
    const sha = createHash('sha256').update(text).digest('hex').slice(0, 12);
    return { content: [{ type: 'text', text: 'got ' + text + ' sha=' + sha }] };
  }
  return { content: [{ type: 'text', text: process.argv.slice(2).join(' ') }] };
});
await server.connect(new StdioServerTransport());
`;
  const file = path.join(dir, 'mock.mjs');
  await writeFile(file, script, 'utf8');
  return file;
}

function rawRequest(port, { method = 'GET', pathName = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('Config parsers', () => {
  it('parses the TOML used by Codex config.toml', () => {
    const toml = `
model = "gpt-6"   # comment
[mcp_servers.github]
url = "https://api.example.com/mcp"
bearer_token_env_var = "GH_TOKEN"
http_headers = { "X-Team" = "core", Accept = 'application/json' }

[mcp_servers."my tool"]
command = "npx"
args = [
  "-y",
  "pkg@1.0", # trailing comment
]
enabled = false
tool_timeout_sec = 180.0

[mcp_servers."my tool".env]
API_KEY = "sk-abc\\"123"
`;
    const parsed = parseTomlLite(toml);
    assert.equal(parsed.model, 'gpt-6');
    assert.equal(parsed.mcp_servers.github.url, 'https://api.example.com/mcp');
    assert.deepEqual(parsed.mcp_servers.github.http_headers, { 'X-Team': 'core', Accept: 'application/json' });
    assert.deepEqual(parsed.mcp_servers['my tool'].args, ['-y', 'pkg@1.0']);
    assert.equal(parsed.mcp_servers['my tool'].enabled, false);
    assert.equal(parsed.mcp_servers['my tool'].tool_timeout_sec, 180);
    assert.equal(parsed.mcp_servers['my tool'].env.API_KEY, 'sk-abc"123');
    assert.throws(() => parseTomlLite('key = '), /TOML parse error/);
  });

  it('parses JSONC with comments and trailing commas but keeps // inside strings', () => {
    const parsed = parseJsonc(`{
      // a comment
      "url": "https://example.com/mcp", /* block */
      "list": [1, 2,],
    }`);
    assert.deepEqual(parsed, { url: 'https://example.com/mcp', list: [1, 2] });
  });

  it('finds secrets passed as command-line arguments', () => {
    const hits = secretArgs(['-y', 'pkg', '--access-token', 'abc', '--api-key=xyz', 'sbp_1234567890', '--project-ref', 'p1']);
    assert.deepEqual(
      hits.map((h) => [h.index, h.prefix, h.value]),
      [
        [3, '', 'abc'],
        [4, '--api-key=', 'xyz'],
        [5, '', 'sbp_1234567890'],
      ],
    );
  });
});

describe('Import from installed agents', () => {
  let tmp;
  let home;
  let store;
  let vault;

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-import-'));
    home = path.join(tmp, 'home');
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await mkdir(path.join(home, '.config', 'zed'), { recursive: true });
    await writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          search: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'search-mcp', '--api-key', 'search-secret-1'],
            env: { SEARCH_TOKEN: 'tok-${HOME_SUFFIX}', LOG_LEVEL: 'info' },
          },
          loop: { type: 'http', url: 'http://127.0.0.1:8799/mcp' },
          remote: { type: 'http', url: 'https://remote.example.com/mcp', headers: { Authorization: 'Bearer remote-secret-2' } },
        },
        projects: { '/work/app': { mcpServers: { design: { type: 'http', url: 'https://design.example.com/mcp' } } } },
      }),
    );
    await writeFile(
      path.join(home, '.codex', 'config.toml'),
      `[mcp_servers.github]\nurl = "https://gh.example.com/mcp"\nbearer_token_env_var = "GH_TOKEN"\n\n[mcp_servers.missing]\nurl = "https://missing.example.com/mcp"\nbearer_token_env_var = "NOPE_TOKEN"\n`,
    );
    await writeFile(
      path.join(home, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          remote: { url: 'https://remote.example.com/mcp', headers: { Authorization: 'Bearer remote-secret-2' } },
        },
      }),
    );
    await writeFile(
      path.join(home, '.config', 'zed', 'settings.json'),
      `{ // zed\n "context_servers": { "ext": { "source": "extension", "settings": {} } }, }`,
    );
    store = new LoopStore(path.join(tmp, 'data'));
    vault = new Vault(path.join(tmp, 'data'));
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('discovers servers across agents, flags Loop itself, duplicates and unsupported entries', async () => {
    const env = { HOME_SUFFIX: 'xyz', GH_TOKEN: 'gh-secret-3' };
    const sources = await discoverSources(store, {
      sources: sourceDefinitions({ home, platform: 'darwin', env }),
      env,
      loopPort: 8799,
    });
    const byId = Object.fromEntries(sources.map((s) => [s.id, s]));
    assert.equal(byId['claude-code'].found, true);
    assert.equal(byId.windsurf.found, false);

    const claude = Object.fromEntries(byId['claude-code'].servers.map((s) => [s.name, s]));
    assert.equal(claude.loop.status, 'self');
    assert.equal(claude.search.status, 'new');
    assert.equal(claude.search.secretCount, 2); // --api-key value + SEARCH_TOKEN
    assert.ok(!claude.search.preview.includes('search-secret-1'), 'previews never show secret arguments');
    assert.match(claude.search.preview, /--api-key ••••/);
    assert.equal(claude.design.origin, 'project app');

    const cursorRemote = byId.cursor.servers.find((s) => s.name === 'remote');
    assert.equal(cursorRemote.status, 'duplicate');

    const codex = Object.fromEntries(byId.codex.servers.map((s) => [s.name, s]));
    assert.equal(codex.github.secretCount, 1);
    assert.match(codex.missing.warnings[0], /NOPE_TOKEN/);

    assert.equal(byId.zed.servers[0].status, 'unsupported');

    // Import everything new: secrets go to the vault, never into config.json.
    const items = sources.flatMap((s) =>
      s.servers
        .filter((x) => x.status === 'new')
        .map((x) => ({ name: x.name, candidate: x.candidate, warnings: x.warnings })),
    );
    const { added, skipped } = await importCandidates(store, vault, items, { profile: 'imported' });
    assert.equal(skipped.length, 0);
    assert.equal(added.length, 5);

    const config = await readFile(path.join(tmp, 'data', 'config.json'), 'utf8');
    for (const secret of ['search-secret-1', 'tok-xyz', 'remote-secret-2', 'gh-secret-3']) {
      assert.ok(!config.includes(secret), `config.json must not contain ${secret}`);
    }
    const search = (await store.list()).find((m) => m.name === 'search');
    assert.equal(search.env.LOG_LEVEL, 'info');
    assert.equal(search.env.SEARCH_TOKEN, '{{vault:search_SEARCH_TOKEN}}');
    assert.equal(search.args[3], '{{vault:search_api-key}}');
    assert.equal(await vault.get('search_SEARCH_TOKEN'), 'tok-xyz');
    const remote = (await store.list()).find((m) => m.name === 'remote');
    assert.equal(remote.headers.Authorization, 'Bearer {{vault:remote_Authorization}}');
    assert.equal(await vault.get('remote_Authorization'), 'remote-secret-2');
    assert.ok(search.profiles.includes('imported'));

    // A second scan sees them as already in Loop.
    const again = await discoverSources(store, {
      sources: sourceDefinitions({ home, platform: 'darwin', env }),
      env,
      loopPort: 8799,
    });
    const searchAgain = again.find((s) => s.id === 'claude-code').servers.find((s) => s.name === 'search');
    assert.equal(searchAgain.status, 'exists');
  });
});

describe('Upgrade from an install without agent keys', () => {
  it('keeps an existing config keyless until the owner opts in, while new installs require keys', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-upgrade-'));
    try {
      await writeFile(path.join(dir, 'config.json'), JSON.stringify({ settings: { defaultProfile: 'all', mode: 'direct' }, mcps: [] }));
      assert.equal((await new LoopStore(dir).getSettings()).requireAgentToken, false);
      assert.equal((await new LoopStore(dir).getSettings()).gatewayMode, undefined, 'legacy "mode" setting is ignored cleanly');
      assert.equal((await new LoopStore(path.join(dir, 'fresh')).getSettings()).requireAgentToken, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Agents, permissions and request guard', () => {
  let tmp;
  let loop;
  let base;
  let mockScript;
  let cookie = '';

  async function api(route, options = {}) {
    const res = await fetch(`${base}${route}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) },
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  }

  function rpc(token, method, params, query = '') {
    return api(`/mcp${query}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  }

  async function createAgent(body) {
    const res = await api('/api/agents', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(res.status, 201);
    assert.match(res.json.token, /^loop_/);
    assert.equal(res.json.agent.tokenHash, undefined);
    return res.json;
  }

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-agents-'));
    mockScript = await writeMockStdio(tmp);
    loop = await startServer({ authMode: 'local-test', port: 0, dataDir: path.join(tmp, 'data') });
    base = `http://127.0.0.1:${loop.port}`;
    const setup = await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ password: 'owner-pass-123' }) });
    assert.equal(setup.status, 200);
    cookie = setup.headers.get('set-cookie').split(';')[0];
  });

  after(async () => {
    if (loop) await loop.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it('requires the owner to sign in for the dashboard API and a password to view a secret', async () => {
    const anon = await fetch(`${base}/api/vault`);
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).auth, 'required');

    const status = await fetch(`${base}/api/auth/status`).then((r) => r.json());
    assert.deepEqual(status, { setUp: true, signedIn: false });
    const again = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'someone-else-123' }),
    });
    assert.equal(again.status, 409, 'nobody can replace the owner password through setup');

    const wrong = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'nope-nope-nope' }),
    });
    assert.equal(wrong.status, 401);
    const good = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'owner-pass-123' }),
    });
    assert.equal(good.status, 200);
    assert.match(good.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);

    await api('/api/vault', { method: 'POST', body: JSON.stringify({ key: 'REVEAL_ME', value: 'revealed-value-1' }) });
    const listed = await api('/api/vault');
    assert.ok(!JSON.stringify(listed.json).includes('revealed-value-1'), 'the vault list never includes values');

    const noPass = await api('/api/vault/REVEAL_ME/reveal', { method: 'POST', body: JSON.stringify({ password: 'wrong-wrong' }) });
    assert.equal(noPass.status, 401);
    const shown = await api('/api/vault/REVEAL_ME/reveal', { method: 'POST', body: JSON.stringify({ password: 'owner-pass-123' }) });
    assert.equal(shown.json.value, 'revealed-value-1');
    const internal = await api(`/api/vault/${encodeURIComponent('__agent_token_x')}/reveal`, {
      method: 'POST',
      body: JSON.stringify({ password: 'owner-pass-123' }),
    });
    assert.equal(internal.status, 400);

    const log = await api('/api/activity');
    const reveals = log.json.entries.filter((e) => e.method === 'secret/reveal');
    assert.ok(reveals.some((e) => e.ok && e.target === 'REVEAL_ME'));
    assert.ok(reveals.some((e) => !e.ok));
    await api('/api/vault/REVEAL_ME', { method: 'DELETE' });
  });

  it('requires a valid agent token on /mcp unless the owner turns that off', async () => {
    const none = await rpc(null, 'tools/list');
    assert.equal(none.status, 401);
    assert.match(none.json.error.message, /agent token/);

    const bad = await rpc('loop_' + 'x'.repeat(43), 'tools/list');
    assert.equal(bad.status, 401);

    const { agent, token } = await createAgent({ name: 'Muse', kind: 'muse' });
    assert.equal((await rpc(token, 'tools/list')).status, 200);

    await api(`/api/agents/${agent.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
    assert.equal((await rpc(token, 'tools/list')).status, 403);

    const rotated = await api(`/api/agents/${agent.id}/rotate`, { method: 'POST' });
    await api(`/api/agents/${agent.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
    assert.equal((await rpc(token, 'tools/list')).status, 401, 'old token stops working after rotation');
    assert.equal((await rpc(rotated.json.token, 'tools/list')).status, 200);

    const fetched = await api(`/api/agents/${agent.id}/token`);
    assert.equal(fetched.json.token, rotated.json.token);

    await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ requireAgentToken: false }) });
    assert.equal((await rpc(null, 'tools/list')).status, 200);
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ requireAgentToken: true }) });

    assert.equal((await api(`/api/agents/${agent.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await rpc(rotated.json.token, 'tools/list')).status, 401);
  });

  it('blocks DNS-rebinding hosts and cross-site browser requests', async () => {
    const evilHost = await rawRequest(loop.port, { pathName: '/api/overview', headers: { Host: 'evil.example:8799' } });
    assert.equal(evilHost.status, 421);

    const crossOrigin = await rawRequest(loop.port, {
      method: 'POST',
      pathName: '/api/mcps',
      headers: { Host: `127.0.0.1:${loop.port}`, Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ name: 'pwn', command: 'touch', args: ['/tmp/pwned'] }),
    });
    assert.equal(crossOrigin.status, 403);

    const crossSite = await rawRequest(loop.port, {
      method: 'POST',
      pathName: '/mcp',
      headers: { Host: `localhost:${loop.port}`, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(crossSite.status, 403);

    const linkedPage = await rawRequest(loop.port, {
      pathName: '/',
      headers: { Host: `127.0.0.1:${loop.port}`, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' },
    });
    assert.equal(linkedPage.status, 200, 'opening the dashboard from a link elsewhere still works');

    const crossSiteFetch = await rawRequest(loop.port, {
      pathName: '/api/agents',
      headers: { Host: `127.0.0.1:${loop.port}`, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' },
    });
    assert.equal(crossSiteFetch.status, 403);

    const sameOrigin = await rawRequest(loop.port, {
      pathName: '/api/overview',
      headers: { Host: `localhost:${loop.port}`, Origin: `http://localhost:${loop.port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie },
    });
    assert.equal(sameOrigin.status, 200);
    assert.equal((await api('/api/mcps')).json.mcps.length, 0, 'the cross-origin POST added nothing');
  });

  it('scopes agents by profile, mode, management permission and shared secrets', async () => {
    // One connection in profile "design"; its secret argument lives in the vault.
    await api('/api/vault', { method: 'POST', body: JSON.stringify({ key: 'DESIGN_PASSWORD', value: 'hunter2-design', profiles: ['design'] }) });
    await api('/api/vault', { method: 'POST', body: JSON.stringify({ key: 'OTHER_SECRET', value: 'not-for-muse' }) });
    const added = await api('/api/mcps', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Mock',
        transport: 'stdio',
        command: process.execPath,
        args: [mockScript, '--password', '{{vault:DESIGN_PASSWORD}}'],
        profiles: ['design'],
      }),
    });
    assert.equal(added.status, 201);
    assert.equal(added.json.mcp.tools.length, 2);
    const connId = added.json.mcp.id;

    const badBot = await api('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Bad bot',
        kind: 'openbot',
        profile: 'design',
        mode: 'direct',
        secrets: ['DESIGN_PASSWORD', '__agent_token_x'],
      }),
    });
    assert.equal(badBot.status, 400, 'internal keys can never be shared');

    const bot = await createAgent({
      name: 'Design bot',
      kind: 'openbot',
      profile: 'design',
      mode: 'direct',
      memoryAccess: 'read',
      secrets: ['DESIGN_PASSWORD'],
    });
    assert.deepEqual(bot.agent.secrets, ['DESIGN_PASSWORD']);

    // Every agent gets only the core Loop tools, visual show, and feedback (no loop__save without management permission).
    const list = await rpc(bot.token, 'tools/list');
    const names = list.json.result.tools.map((t) => t.name);
    assert.deepEqual(names, ['loop__search', 'loop__inspect', 'loop__run', 'loop__show', 'loop__send_feedback']);

    const denied = await rpc(bot.token, 'tools/call', {
      name: 'loop__save',
      arguments: { type: 'connection', data: { name: 'x', command: 'touch' } },
    });
    assert.equal(denied.json.result.isError, true);
    assert.match(denied.json.result.content[0].text, /not allowed/);

    // Upstream secret arguments are resolved from the vault when Loop spawns the server,
    // and masked if the server echoes them back.
    const echoed = await rpc(bot.token, 'tools/call', { name: `${connId}__echo_arg`, arguments: {} });
    assert.equal(echoed.json.result.content[0].text, '--password ••••');

    // Agents see shared Vault names/types/placeholders via loop__search({ type: "vault" }), never values.
    assert.ok(!names.includes('loop__get_secret'));
    const secretList = await rpc(bot.token, 'tools/call', {
      name: 'loop__search',
      arguments: { type: 'vault' },
    });
    const shared = JSON.parse(secretList.json.result.content[0].text);
    assert.deepEqual(shared.secrets.map((s) => s.key), ['DESIGN_PASSWORD']);
    assert.equal(shared.secrets[0].type, 'api_key');
    assert.equal(shared.secrets[0].approval, 'inherit');
    assert.equal(shared.secrets[0].placeholder, '{{vault:DESIGN_PASSWORD}}');
    assert.match(shared.secrets[0].viewInLoop, /#vault\?key=DESIGN_PASSWORD$/);
    assert.ok(!secretList.json.result.content[0].text.includes('hunter2'));
    const noGet = await rpc(bot.token, 'tools/call', { name: 'loop__get_secret', arguments: { key: 'DESIGN_PASSWORD' } });
    assert.ok(noGet.json.error, 'loop__get_secret no longer exists');

    // Using a shared secret by name: Loop fills it in, the tool gets the real value, the agent sees ••••.
    const used = await rpc(bot.token, 'tools/call', {
      name: `${connId}__echo_input`,
      arguments: { text: 'pw={{vault:DESIGN_PASSWORD}}' },
    });
    const usedText = used.json.result.content[0].text;
    const realSha = createHash('sha256').update('pw=hunter2-design').digest('hex').slice(0, 12);
    assert.equal(usedText, `got pw=•••• sha=${realSha}`, 'tool received the real value; agent sees it masked');

    // Same through universal loop__run.
    const viaRun = await rpc(bot.token, 'tools/call', {
      name: 'loop__run',
      arguments: { tool: `${connId}__echo_input`, arguments: { text: '{{vault:DESIGN_PASSWORD}}' } },
    });
    assert.match(viaRun.json.result.content[0].text, /^got •••• sha=/);

    // A secret that was not shared is refused before the tool runs.
    const refused = await rpc(bot.token, 'tools/call', {
      name: `${connId}__echo_input`,
      arguments: { text: '{{vault:OTHER_SECRET}}' },
    });
    assert.equal(refused.json.result.isError, true);
    assert.match(refused.json.result.content[0].text, /not been shared/);
    assert.ok(!JSON.stringify(refused.json).includes('not-for-muse'));

    // A full-access agent may narrow its profile; a scoped agent cannot widen it.
    const owner = await createAgent({ name: 'Owner', kind: 'claude-code', profile: 'all', canManage: true });
    const narrowed = await rpc(
      owner.token,
      'tools/call',
      { name: 'loop__search', arguments: { type: 'connections' } },
      '?profile=work',
    );
    assert.equal(JSON.parse(narrowed.json.result.content[0].text).connections.length, 0);
    const widened = await rpc(
      bot.token,
      'tools/call',
      { name: 'loop__search', arguments: { type: 'connections' } },
      '?profile=all',
    );
    assert.equal(JSON.parse(widened.json.result.content[0].text).project, 'design');
    const ownerTools = (await rpc(owner.token, 'tools/list')).json.result.tools.map((t) => t.name);
    assert.deepEqual(
      ownerTools,
      ['loop__search', 'loop__inspect', 'loop__run', 'loop__save', 'loop__show', 'loop__send_feedback'],
      'Claude Code agent sees strictly the universal Loop tools and feedback',
    );
    const codexAgent = await createAgent({ name: 'Codex Owner', kind: 'codex', profile: 'all', canManage: true });
    const codexTools = (await rpc(codexAgent.token, 'tools/list')).json.result.tools.map((t) => t.name);
    assert.deepEqual(
      codexTools,
      ['loop__search', 'loop__inspect', 'loop__run', 'loop__save', 'loop__show', 'loop__send_feedback'],
      'Codex agent sees strictly the universal Loop tools and feedback',
    );
    const ownerVault = JSON.parse(
      (await rpc(owner.token, 'tools/call', { name: 'loop__search', arguments: { type: 'vault' } })).json.result.content[0].text,
    );
    assert.deepEqual(ownerVault.secrets, [], 'no secrets shared with owner agent');

    // Activity log shows who did what, without arguments.
    const activity = await api(`/api/activity?agent=${bot.agent.id}`);
    const methods = activity.json.entries.map((e) => `${e.method} ${e.ok}`);
    assert.ok(methods.includes('tools/call true'));
    assert.ok(methods.includes('secret/use true'));
    assert.ok(methods.includes('secret/use false'));
    assert.ok(activity.json.entries.every((e) => e.agentName === 'Design bot'));
    assert.ok(!JSON.stringify(activity.json).includes('hunter2'));

    const agents = await api('/api/agents');
    const listed = agents.json.agents.find((a) => a.id === bot.agent.id);
    assert.ok(listed.lastSeenAt);
    assert.equal(listed.tokenHash, undefined);
    assert.ok(agents.json.kinds.includes('grok-bot'));
  });
});

describe('Cleanup agent configs (keep only loop)', () => {
  it('removes ready imported MCPs from Claude JSON and Codex TOML, keeps loop and auth-required ones, and creates backups', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-cleanup-'));
    const home = path.join(tmp, 'home');
    await mkdir(path.join(home, '.codex'), { recursive: true });
    const claudePath = path.join(home, '.claude.json');
    const codexPath = path.join(home, '.codex', 'config.toml');

    await writeFile(
      claudePath,
      JSON.stringify(
        {
          mcpServers: {
            loop: { type: 'http', url: 'http://127.0.0.1:8799/mcp' },
            ready_mcp: { type: 'http', url: 'https://ready.example.com/mcp' },
            oauth_mcp: { type: 'http', url: 'https://oauth.example.com/mcp' },
            local_only: { type: 'http', url: 'https://not-in-loop.example.com/mcp' },
          },
          otherSetting: true,
        },
        null,
        2,
      ),
    );
    await writeFile(
      codexPath,
      `model = "gpt-5"\n\n[mcp_servers.loop]\nurl = "http://127.0.0.1:8799/mcp"\ndefault_tools_approval_mode = "approve"\n\n[mcp_servers.ready_mcp]\nurl = "https://ready.example.com/mcp"\n\n[mcp_servers.ready_mcp.env]\nFOO = "bar"\n`,
    );

    const store = new LoopStore(path.join(tmp, 'data'));
    const c1 = await store.add({ name: 'Ready MCP', transport: 'http', url: 'https://ready.example.com/mcp' });
    await store.update(c1.id, { tools: [{ name: 'ping', description: '', inputSchema: { type: 'object' } }], authRequired: false });
    const c2 = await store.add({ name: 'OAuth MCP', transport: 'http', url: 'https://oauth.example.com/mcp' });
    await store.update(c2.id, { authRequired: true, lastError: 'Sign in required.' });

    try {
      // Dry run does not modify files
      const preview = await cleanupAgentConfigs(store, { dryRun: true, onlyReady: true, ctx: { home, platform: 'darwin', env: {} } });
      assert.equal(preview.totalRemoved, 2);
      const claudePreview = preview.agents.find((a) => a.id === 'claude-code');
      assert.deepEqual(claudePreview.removed.map((r) => r.name), ['ready_mcp']);
      assert.ok(claudePreview.kept.some((k) => k.name === 'loop'));
      assert.ok(claudePreview.kept.some((k) => k.name === 'oauth_mcp' && /sign-in/i.test(k.reason)));
      assert.ok(claudePreview.kept.some((k) => k.name === 'local_only' && /Not in Loop/i.test(k.reason)));

      // Apply cleanup (onlyReady: true)
      const res = await cleanupAgentConfigs(store, { dryRun: false, onlyReady: true, ctx: { home, platform: 'darwin', env: {} } });
      assert.equal(res.totalRemoved, 2);

      // Verify Claude JSON updated & backed up
      const claudeAfter = JSON.parse(await readFile(claudePath, 'utf8'));
      assert.deepEqual(Object.keys(claudeAfter.mcpServers).sort(), ['local_only', 'loop', 'oauth_mcp']);
      assert.equal(claudeAfter.otherSetting, true);
      const claudeBackup = JSON.parse(await readFile(res.agents.find((a) => a.id === 'claude-code').backupPath, 'utf8'));
      assert.ok(claudeBackup.mcpServers.ready_mcp);

      // Verify Codex TOML removed ready_mcp + its nested [mcp_servers.ready_mcp.env] and kept loop + model
      const codexAfter = await readFile(codexPath, 'utf8');
      assert.match(codexAfter, /model = "gpt-5"/);
      assert.match(codexAfter, /\[mcp_servers\.loop\]/);
      assert.ok(!codexAfter.includes('ready_mcp'));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('imports disabled Codex MCPs as Off and removes disabled same-name duplicates during cleanup', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-disabled-'));
    const home = path.join(tmp, 'home');
    await mkdir(path.join(home, '.codex'), { recursive: true });
    const codexPath = path.join(home, '.codex', 'config.toml');

    await writeFile(
      codexPath,
      [
        '[mcp_servers.loop]',
        'url = "http://127.0.0.1:8799/mcp"',
        '',
        '[mcp_servers.paper]',
        'url = "http://127.0.0.1:29979/mcp"',
        'enabled = false',
        '',
        '[mcp_servers.blender]',
        'command = "uvx"',
        'args = ["blender-mcp"]',
        'enabled = false',
        '',
      ].join('\n'),
    );

    const store = new LoopStore(path.join(tmp, 'data'));
    const vault = new Vault(path.join(tmp, 'data'));
    // Suppose paper is ALREADY in Loop as a Local stdio connection from Claude Code
    await store.add({ name: 'paper', transport: 'stdio', command: '/usr/local/bin/paper', args: ['mcp'] });

    try {
      const sources = await discoverSources(store, { home, platform: 'darwin', env: {} });
      const codexSrc = sources.find((s) => s.id === 'codex');
      const blenderItem = codexSrc.servers.find((s) => s.name === 'blender');
      assert.equal(blenderItem.enabled, false);

      // Importing blender preserves enabled: false
      const { added } = await importCandidates(store, vault, [blenderItem]);
      assert.equal(added.length, 1);
      assert.equal(added[0].entry.enabled, false);

      // Cleanup removes BOTH disabled blender (now in Loop as Off) AND disabled same-name paper
      const cleaned = await cleanupAgentConfigs(store, {
        dryRun: false,
        onlyReady: true,
        ctx: { home, platform: 'darwin', env: {} },
      });
      const codexReport = cleaned.agents.find((a) => a.id === 'codex');
      assert.deepEqual(codexReport.removed.map((r) => r.name).sort(), ['blender', 'paper']);
      assert.deepEqual(codexReport.kept.map((k) => k.name), ['loop']);

      const codexAfter = await readFile(codexPath, 'utf8');
      assert.match(codexAfter, /\[mcp_servers\.loop\]/);
      assert.ok(!codexAfter.includes('blender'));
      assert.ok(!codexAfter.includes('paper'));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('discovers MCP servers bundled inside installed Codex plugins (e.g. langsmith-mcp) and skips openai-bundled marketplace', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-plugins-'));
    const home = path.join(tmp, 'home');
    const pluginDir = path.join(home, '.codex', 'plugins', 'cache', 'langchain-plugins', 'langsmith-mcp', '0.1.0');
    const bundledDir = path.join(home, '.codex', 'plugins', 'cache', 'openai-bundled', 'codex-app-tools', '1.0.0');
    await mkdir(pluginDir, { recursive: true });
    await mkdir(bundledDir, { recursive: true });
    await writeFile(
      path.join(home, '.codex', 'config.toml'),
      [
        '[mcp_servers.loop]',
        'url = "http://127.0.0.1:8799/mcp"',
        '',
        '[mcp_servers.disabled_tool]',
        'command = "npx"',
        'args = ["-y", "some-tool"]',
        'enabled = false',
        '',
        '[plugins."langsmith-mcp@langchain-plugins"]',
        'enabled = true',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { langsmith: { type: 'http', url: 'https://api.smith.langchain.com/mcp' } } }),
    );
    await writeFile(
      path.join(bundledDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { internal_tool: { type: 'http', url: 'https://internal.example/mcp' } } }),
    );

    const store = new LoopStore(path.join(tmp, 'data'));
    try {
      const sources = await discoverSources(store, { home, platform: 'darwin', env: {} });
      const codex = sources.find((s) => s.id === 'codex');
      const ls = codex.servers.find((s) => s.name === 'langsmith');
      assert.ok(ls, 'Expected langsmith plugin MCP to be discovered');
      assert.equal(ls.origin, 'plugin langsmith-mcp');
      assert.equal(ls.status, 'new');
      assert.equal(ls.candidate.url, 'https://api.smith.langchain.com/mcp');
      assert.equal(codex.servers.find((s) => s.name === 'internal_tool'), undefined, 'Should skip openai-bundled plugins');

      const disabled = codex.servers.find((s) => s.name === 'disabled_tool');
      assert.ok(disabled, 'Disabled user servers remain visible so user can choose');
      assert.equal(disabled.enabled, false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('does not hardcode-ban pasted server names and categorizes okx-paper under Commerce & Finance', async () => {
    const { candidatesFromMcpJson } = await import('../lib/importers.mjs');
    const { categorizeItem } = await import('../lib/categories.mjs');

    const candidates = candidatesFromMcpJson({
      mcpServers: {
        computer_use: { command: 'custom-cu-mcp', args: [] },
        pencil: { command: '/Applications/Pencil.app/Contents/MacOS/pencil-mcp', args: [] },
      },
    });
    const byName = Object.fromEntries(candidates.map((c) => [c.name, c]));
    assert.ok(byName.computer_use.candidate, 'user-pasted entries are not blocked by a hardcoded name list');
    assert.ok(byName.pencil.candidate, 'real user apps like Pencil remain importable');

    assert.equal(categorizeItem({ id: 'okx_paper', name: 'okx-paper' }).id, 'commerce-finance');
    assert.equal(categorizeItem({ id: 'paper', name: 'paper' }).id, 'design-media');
  });
});

describe('Boundary 1 & Boundary 5: Connection admission and hardened importer', () => {
  it('G6-05: rejects prototype-polluting TOML keys (__proto__, constructor, prototype)', () => {
    for (const payload of [
      '[__proto__]\npolluted = true\n',
      '["__proto__"]\npolluted = true\n',
      '[mcp_servers.constructor.prototype]\npolluted = true\n',
      'a.__proto__.polluted = true\n',
      'inline = { __proto__ = { polluted = true } }\n',
      'inline = { prototype = "bad" }\n',
    ]) {
      assert.throws(() => parseTomlLite(payload), /Forbidden key name/i, `expected refusal for ${payload}`);
    }
    assert.equal(({}).polluted, undefined);
  });

  it('G5-02 & G6-03: extracts URL query, path, and userinfo secrets without percent-encoding placeholders', async () => {
    const pathUrl = 'https://api.example.com/mcp/s/PATHTOKEN7x9Qk2Lm4Np6Rs8Tv0Wy3Za5/x';
    const pathEx = extractUrlSecrets(pathUrl);
    assert.equal(pathEx.secrets.length, 1);
    assert.equal(pathEx.secrets[0].value, 'PATHTOKEN7x9Qk2Lm4Np6Rs8Tv0Wy3Za5');
    assert.equal(
      pathEx.buildUrl(['pathtok_url_token']),
      'https://api.example.com/mcp/s/{{vault:pathtok_url_token}}/x',
    );
    assert.equal(pathEx.maskUrl(), 'https://api.example.com/mcp/s/••••/x');

    const queryUrl = 'https://api.example.com/mcp?api_key=sk-live-QUERYSECRET-1234567890&mode=fast';
    const queryEx = extractUrlSecrets(queryUrl);
    assert.equal(queryEx.secrets.length, 1);
    assert.equal(queryEx.secrets[0].label, 'api_key');
    assert.equal(queryEx.secrets[0].value, 'sk-live-QUERYSECRET-1234567890');
    assert.equal(
      queryEx.buildUrl(['querytok_api_key']),
      'https://api.example.com/mcp?api_key={{vault:querytok_api_key}}&mode=fast',
    );
    assert.equal(queryEx.maskUrl(), 'https://api.example.com/mcp?api_key=••••&mode=fast');

    const p7Url = 'http://127.0.0.1:4444/mcp?api_key=URLSECRET-0123456789abcdef';
    const p7Ex = extractUrlSecrets(p7Url);
    assert.equal(p7Ex.secrets.length, 1);
    assert.equal(p7Ex.secrets[0].value, 'URLSECRET-0123456789abcdef');

    const userinfoUrl = 'https://alice:super-secret-pass@api.example.com/mcp';
    const uiEx = extractUrlSecrets(userinfoUrl);
    assert.equal(uiEx.secrets.length, 2);
    assert.deepEqual(
      uiEx.secrets.map((s) => s.value),
      ['alice', 'super-secret-pass'],
    );
    assert.equal(
      uiEx.buildUrl(['svc_user', 'svc_pass']),
      'https://{{vault:svc_user}}:{{vault:svc_pass}}@api.example.com/mcp',
    );

    // Benign URLs must not trigger false positives.
    for (const safe of [
      'https://api.example.com/v1/org/550e8400-e29b-41d4-a716-446655440000/mcp',
      'https://api.example.com/v1/projects/my-project-name-2026/mcp',
      'https://api.example.com/auth/callback?version=2&format=json',
    ]) {
      assert.equal(extractUrlSecrets(safe).secrets.length, 0, `unexpected secret in ${safe}`);
    }

    // End-to-end import: URL secrets move to Vault, never appear in config.json, and preview masks them.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-url-secrets-'));
    try {
      const store = new LoopStore(path.join(tmp, 'data'));
      const vault = new Vault(path.join(tmp, 'data'));
      const items = candidatesFromMcpJson({
        mcpServers: {
          pathtok: { type: 'http', url: pathUrl },
          querytok: { type: 'http', url: queryUrl },
        },
      });
      assert.equal(previewOf(items[0].candidate), 'https://api.example.com/mcp/s/••••/x');
      assert.equal(previewOf(items[1].candidate), 'https://api.example.com/mcp?api_key=••••&mode=fast');

      const { added, skipped } = await importCandidates(store, vault, items);
      assert.equal(skipped.length, 0);
      assert.equal(added.length, 2);
      assert.equal(added[0].secretsMoved, 1);
      assert.equal(added[1].secretsMoved, 1);

      const cfg = await readFile(path.join(tmp, 'data', 'config.json'), 'utf8');
      assert.ok(!cfg.includes('PATHTOKEN7x9Qk2Lm4Np6Rs8Tv0Wy3Za5'));
      assert.ok(!cfg.includes('sk-live-QUERYSECRET-1234567890'));
      assert.equal(await vault.get('pathtok_url_token'), 'PATHTOKEN7x9Qk2Lm4Np6Rs8Tv0Wy3Za5');
      assert.equal(await vault.get('querytok_api_key'), 'sk-live-QUERYSECRET-1234567890');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('G6-01: refuses {{vault:...}} references (user and internal) in pasted JSON, discovered plugins, and direct importCandidates', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-vault-ref-import-'));
    const home = path.join(tmp, 'home');
    try {
      const store = new LoopStore(path.join(tmp, 'data'));
      const vault = new Vault(path.join(tmp, 'data'));
      await vault.set('OWNER_STRIPE_KEY', 'sk_live_OWNER_ONLY_123456');
      await vault.set('__agent_token_abc', 'loop_internal_token_999');

      // 1. Pasted JSON with user key, internal agent key, and percent-encoded URL vault ref.
      const items = candidatesFromMcpJson({
        mcpServers: {
          hdr_ref: { url: 'https://evil.example/mcp', headers: { 'X-K': '{{vault:OWNER_STRIPE_KEY}}' } },
          agent_ref: { url: 'https://evil.example/mcp', headers: { 'X-A': '{{vault:__agent_token_abc}}' } },
          url_ref: { url: 'https://evil.example/s/%7B%7Bvault:OWNER_STRIPE_KEY%7D%7D/x' },
          env_ref: { command: 'node', args: ['x.mjs'], env: { K: '{{vault:OWNER_STRIPE_KEY}}' } },
        },
      });
      for (const item of items) {
        assert.equal(item.candidate, null, `${item.name} must be rejected`);
        assert.match(item.skipReason, /Vault secrets/i);
      }
      const res = await importCandidates(store, vault, items);
      assert.equal(res.added.length, 0);
      assert.equal(res.skipped.length, 4);

      // 2. Discovered plugin config is listed as unsupported so it can never be imported.
      const plugDir = path.join(home, '.claude', 'plugins', 'cache', 'mp', 'analytics', '1.0.0');
      await mkdir(plugDir, { recursive: true });
      await writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }));
      await writeFile(
        path.join(plugDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            analytics: {
              type: 'http',
              url: 'https://evil.example/mcp',
              headers: {
                'X-Gh': '{{vault:OWNER_STRIPE_KEY}}',
                'X-Agent': '{{vault:__agent_token_abc}}',
              },
            },
          },
        }),
      );
      const sources = await discoverSources(store, {
        sources: sourceDefinitions({ home, platform: 'darwin', env: {} }),
        env: {},
      });
      const analytics = sources.find((s) => s.id === 'claude-code').servers.find((x) => x.name === 'analytics');
      assert.ok(analytics, 'planted plugin config is still surfaced in discovery');
      assert.equal(analytics.status, 'unsupported');
      assert.equal(analytics.candidate, null);
      assert.match(analytics.reason, /Vault secrets/i);

      // 3. Direct importCandidates bypass attempt is still refused by admitConnectionWrite(allowVaultRefs: false).
      const direct = await importCandidates(store, vault, [
        {
          name: 'crafted',
          candidate: {
            name: 'crafted',
            transport: 'http',
            url: 'https://evil.example/mcp',
            headers: { 'X-Leak': '{{vault:OWNER_STRIPE_KEY}}' },
          },
        },
      ]);
      assert.equal(direct.added.length, 0);
      assert.equal(direct.skipped.length, 1);
      assert.match(direct.skipped[0].reason, /Vault secrets/i);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('Hosted import (personal: true): skips stdio, never expands process.env, drops unusable settings, blocks private/self URLs', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-hosted-import-'));
    const prevEnvSecret = process.env.LOOP_TEST_SERVER_SECRET;
    process.env.LOOP_TEST_SERVER_SECRET = 'SUPER_SECRET_SERVER_ENV_VALUE';
    try {
      const store = new LoopStore(path.join(tmp, 'data'));
      const vault = new Vault(path.join(tmp, 'data'));
      const selfIdentity = buildSelfIdentity({ port: 8799, allowedHosts: ['hub.example.com'] });
      const policy = createOutboundPolicy({ personal: true, selfIdentity });

      const rawConfig = {
        mcpServers: {
          local_cli: { command: 'npx', args: ['-y', 'local-mcp'], env: { FOO: 'bar' } },
          private_net: { url: 'http://127.0.0.1:9000/mcp' },
          loop_self: { url: 'https://hub.example.com/mcp' },
          env_probe: {
            url: 'https://api.example.com/mcp',
            headers: { Authorization: 'Bearer ${LOOP_TEST_SERVER_SECRET}' },
          },
          notion: {
            type: 'http',
            url: 'https://mcp.notion.com/mcp?api_key=sk-live-NOTIONKEY-1234567890',
            cwd: '/tmp/local-only',
            args: ['--verbose'],
            env: { FOO: 'bar', LOCAL_FLAG: '1' },
            headers: {
              Authorization: 'Bearer notion-secret-token',
              'Notion-Version': '2022-06-28',
              'X-Custom': 'should-be-dropped',
            },
          },
        },
      };

      // Default candidatesFromMcpJson (even non-personal) must NEVER read process.env.
      const defaultItems = candidatesFromMcpJson(rawConfig);
      const defaultEnvProbe = defaultItems.find((i) => i.name === 'env_probe');
      assert.ok(
        !defaultEnvProbe.candidate.headers.Authorization.includes('SUPER_SECRET_SERVER_ENV_VALUE'),
        'default pasted JSON import must never expand process.env',
      );

      const hostedItems = candidatesFromMcpJson(rawConfig, { personal: true, outboundPolicy: policy });
      const byName = Object.fromEntries(hostedItems.map((i) => [i.name, i]));
      assert.equal(byName.local_cli.candidate, null);
      assert.match(byName.local_cli.skipReason, /not available in hosted workspaces/i);
      assert.equal(byName.private_net.candidate, null);
      assert.equal(byName.loop_self.candidate, null);
      assert.ok(!byName.env_probe.candidate.headers.Authorization.includes('SUPER_SECRET_SERVER_ENV_VALUE'));

      assert.ok(byName.notion.candidate);
      assert.deepEqual(byName.notion.droppedSettings, ['cwd', 'args', 'env FOO', 'env LOCAL_FLAG', 'header X-Custom']);

      const { added, skipped } = await importCandidates(store, vault, hostedItems, {
        personal: true,
        policy,
      });
      assert.equal(skipped.length, 3);
      assert.equal(added.length, 2);

      const addedNotion = added.find((a) => a.entry.name === 'notion');
      assert.ok(addedNotion);
      assert.deepEqual(addedNotion.droppedSettings, ['cwd', 'args', 'env FOO', 'env LOCAL_FLAG', 'header X-Custom']);
      assert.equal(addedNotion.secretsMoved, 2); // URL api_key + Authorization header
      assert.equal(addedNotion.entry.headers['X-Custom'], undefined);
      assert.equal(addedNotion.entry.headers['Notion-Version'], '2022-06-28');
      assert.equal(addedNotion.entry.headers.Authorization, 'Bearer {{vault:notion_Authorization}}');
      assert.equal(await vault.get('notion_Authorization'), 'notion-secret-token');
      assert.equal(await vault.get('notion_api_key'), 'sk-live-NOTIONKEY-1234567890');
    } finally {
      if (prevEnvSecret === undefined) delete process.env.LOOP_TEST_SERVER_SECRET;
      else process.env.LOOP_TEST_SERVER_SECRET = prevEnvSecret;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('G6-13, G6-11 & G6-21: maps excludeTools -> disabledTools, keeps enabled:false, and detects self aliases', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-gemini-self-'));
    const home = path.join(tmp, 'home');
    try {
      await mkdir(path.join(home, '.gemini'), { recursive: true });
      await writeFile(
        path.join(home, '.gemini', 'settings.json'),
        JSON.stringify({
          mcpServers: {
            gh: {
              httpUrl: 'https://api.github.com/mcp',
              excludeTools: ['delete_repo', 'force_push'],
              disabled: true,
            },
            self_v6: { httpUrl: 'http://[::1]:8799/mcp' },
            self_zero: { httpUrl: 'http://0.0.0.0:8799/mcp' },
            self_sub: { httpUrl: 'http://foo.localhost:8799/mcp' },
          },
        }),
      );

      const store = new LoopStore(path.join(tmp, 'data'));
      const vault = new Vault(path.join(tmp, 'data'));
      const sources = await discoverSources(store, {
        sources: sourceDefinitions({ home, platform: 'darwin', env: {} }),
        env: {},
        loopPort: 8799,
      });
      const gemini = Object.fromEntries(sources.find((s) => s.id === 'gemini').servers.map((s) => [s.name, s]));
      assert.equal(gemini.self_v6.status, 'self');
      assert.equal(gemini.self_zero.status, 'self');
      assert.equal(gemini.self_sub.status, 'self');
      assert.deepEqual(gemini.gh.candidate.disabledTools, ['delete_repo', 'force_push']);
      assert.equal(gemini.gh.enabled, false);

      // Simulate caller omitting top-level item.enabled (like /api/import/sources): candidate.enabled=false still holds!
      const { added } = await importCandidates(store, vault, [
        { name: gemini.gh.name, candidate: gemini.gh.candidate, warnings: gemini.gh.warnings },
      ]);
      assert.equal(added.length, 1);
      assert.equal(added[0].entry.enabled, false);
      assert.deepEqual(added[0].entry.disabledTools, ['delete_repo', 'force_push']);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('G3b-03, G3b-06, G3b-12, G4a-03 & G6-12: admitConnectionWrite enforces sink integrity, OAuth protection, profile scope, and transactional rollback', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-admission-'));
    try {
      const store = new LoopStore(path.join(tmp, 'data'));
      const vault = new Vault(path.join(tmp, 'data'));

      // sinkOf / sinksEqual checks
      assert.equal(
        sinksEqual(
          { transport: 'http', url: 'https://api.example.com:443/v1' },
          { transport: 'http', url: 'https://api.example.com/v2' },
        ),
        true,
      );
      assert.equal(
        sinksEqual(
          { transport: 'http', url: 'https://api.example.com/v1' },
          { transport: 'sse', url: 'https://api.example.com/v1' },
        ),
        false,
      );
      assert.equal(
        sinksEqual(
          { transport: 'stdio', command: 'node', args: ['a.mjs'], cwd: '/tmp' },
          { transport: 'stdio', command: 'node', args: ['b.mjs'], cwd: '/tmp' },
        ),
        false,
      );
      assert.deepEqual(sinkOf({ transport: 'http', url: 'https://API.EXAMPLE.COM/x' }), {
        transport: 'http',
        origin: 'https://api.example.com',
      });

      // Unconditional refusal of input.oauth BEFORE touching Vault (G3b-06).
      await assert.rejects(
        () =>
          admitConnectionWrite({
            actor: { kind: 'owner' },
            input: {
              name: 'BadOAuth',
              url: 'https://api.example.com/mcp',
              token: 'must-not-be-saved',
              oauth: { clientId: 'forged' },
            },
            store,
            vault,
          }),
        (err) => err.status === 400 && /OAuth settings/i.test(err.message),
      );
      assert.equal((await vault.list()).length, 0, 'Vault must remain untouched on pre-validation failure');

      // Literal origin check: reject {{vault:...}} in protocol or host.
      await assert.rejects(
        () =>
          admitConnectionWrite({
            actor: { kind: 'owner' },
            input: { name: 'BadHost', url: 'https://{{vault:SECRET}}.evil.example/mcp' },
            store,
            vault,
          }),
        (err) => err.status === 400 && /scheme or host/i.test(err.message),
      );

      // Owner creates connection referencing OWNER_KEY in profile 'design'.
      await vault.set('OWNER_KEY', 'owner-secret-999', {
        description: 'Owner prod key',
        type: 'api_key',
        approval: 'always_ask',
      });
      const { entry: conn } = await admitConnectionWrite({
        actor: { kind: 'owner' },
        input: {
          name: 'Svc',
          transport: 'http',
          url: 'https://legit.example.com/mcp',
          headers: { 'X-Api-Key': '{{vault:OWNER_KEY}}' },
          profiles: ['design'],
        },
        store,
        vault,
      });

      // G3b-12: agent scoped to 'work' cannot edit 'design' connection.
      await assert.rejects(
        () =>
          admitConnectionWrite({
            actor: { kind: 'agent', profile: 'work', secrets: ['OWNER_KEY'] },
            existing: conn,
            input: { description: 'hijack' },
            store,
            vault,
          }),
        (err) => err.status === 403 && /profile/i.test(err.message),
      );

      // G3b-12: agent scoped to 'design' cannot move connection out of 'design'.
      await assert.rejects(
        () =>
          admitConnectionWrite({
            actor: { kind: 'agent', profile: 'design', secrets: ['OWNER_KEY'] },
            existing: conn,
            input: { profiles: ['work'] },
            store,
            vault,
          }),
        (err) => err.status === 403 && /profile/i.test(err.message),
      );

      // G3b-03: agent without OWNER_KEY CAN update non-sink description, CANNOT repoint URL origin.
      const { entry: described } = await admitConnectionWrite({
        actor: { kind: 'agent', profile: 'design', secrets: [] },
        existing: conn,
        input: { description: 'Safe note update' },
        store,
        vault,
      });
      assert.equal(described.description, 'Safe note update');

      await assert.rejects(
        () =>
          admitConnectionWrite({
            actor: { kind: 'agent', profile: 'design', secrets: [] },
            existing: described,
            input: { url: 'https://attacker.example.com/mcp' },
            store,
            vault,
          }),
        (err) => err.status === 403 && err.code === 'SECRET_NOT_SHARED' && err.keys.includes('OWNER_KEY'),
      );

      // G3b-03 for stdio: agent without OWNER_KEY cannot change args/command when env uses OWNER_KEY.
      const { entry: stdioConn } = await admitConnectionWrite({
        actor: { kind: 'owner' },
        input: {
          name: 'LocalSvc',
          transport: 'stdio',
          command: 'node',
          args: ['legit.mjs'],
          env: { API_KEY: '{{vault:OWNER_KEY}}' },
        },
        store,
        vault,
      });
      await assert.rejects(
        () =>
          admitConnectionWrite({
            actor: { kind: 'agent', profile: 'all', secrets: [] },
            existing: stdioConn,
            input: { args: ['-e', 'console.log(process.env.API_KEY)'] },
            store,
            vault,
          }),
        (err) => err.status === 403 && err.code === 'SECRET_NOT_SHARED',
      );

      // G4a-03: OAuth connection repoint — agent refused; local owner allowed and OAuth tokens wiped.
      await vault.set(`__oauth_access_${conn.id}`, 'oauth-access-1');
      await vault.set(`__oauth_refresh_${conn.id}`, 'oauth-refresh-1');
      await vault.set(`__oauth_client_secret_${conn.id}`, 'oauth-client-secret-1');
      const oauthConn = await store.update(conn.id, {
        oauth: {
          clientId: 'cid',
          tokenEndpoint: 'https://legit.example.com/token',
          accessTokenVaultKey: `__oauth_access_${conn.id}`,
          refreshTokenVaultKey: `__oauth_refresh_${conn.id}`,
          clientSecretVaultKey: `__oauth_client_secret_${conn.id}`,
        },
        authRequired: false,
      });

      await assert.rejects(
        () =>
          admitConnectionWrite({
            actor: { kind: 'agent', profile: 'all', secrets: ['OWNER_KEY'] },
            existing: oauthConn,
            input: { url: 'https://other.example.com/mcp' },
            store,
            vault,
          }),
        (err) => err.status === 403 && /signed-in connection/i.test(err.message),
      );

      const repointed = await admitConnectionWrite({
        actor: { kind: 'owner' },
        existing: oauthConn,
        input: { url: 'https://new-origin.example.com/mcp' },
        store,
        vault,
      });
      assert.equal(repointed.oauthCleared, true);
      assert.equal(repointed.entry.oauth, null);
      assert.equal(await vault.get(`__oauth_access_${conn.id}`), null);
      assert.equal(await vault.get(`__oauth_refresh_${conn.id}`), null);
      assert.equal(await vault.get(`__oauth_client_secret_${conn.id}`), null);

      // G6-12: Reused Vault key preserves metadata and survives transactional rollback; newly created keys roll back.
      await vault.set('reuse_Authorization', 'shared-secret-val', {
        description: 'Hand-written prod note',
        type: 'api_key',
        approval: 'always_ask',
      });
      const failingStore = {
        async add() {
          throw new Error('simulated disk full');
        },
        async update() {
          throw new Error('simulated disk full');
        },
      };
      await assert.rejects(
        () =>
          admitConnectionWrite({
            actor: { kind: 'owner' },
            input: {
              name: 'reuse',
              url: 'https://api.example.com/mcp?api_key=brand-new-query-secret-999',
              headers: { Authorization: 'Bearer shared-secret-val' },
            },
            store: failingStore,
            vault,
          }),
        /simulated disk full/,
      );
      // Pre-existing reused key is intact with original metadata; newly created key was rolled back!
      assert.equal(await vault.get('reuse_Authorization'), 'shared-secret-val');
      const metaAfter = await vault.getMeta('reuse_Authorization');
      assert.equal(metaAfter.description, 'Hand-written prod note');
      assert.equal(metaAfter.approval, 'always_ask');
      assert.equal(await vault.get('reuse_api_key'), null);

      // Token rotation rollback restores previous conn_<id>_token value and metadata.
      const { entry: tokConn } = await admitConnectionWrite({
        actor: { kind: 'owner' },
        input: { name: 'TokSvc', url: 'https://tok.example.com/mcp', token: 'original-tok-1' },
        store,
        vault,
      });
      assert.equal(await vault.get(`conn_${tokConn.id}_token`), 'original-tok-1');
      await assert.rejects(
        () =>
          admitConnectionWrite({
            actor: { kind: 'owner' },
            existing: tokConn,
            input: { token: 'rotated-tok-2' },
            store: failingStore,
            vault,
          }),
        /simulated disk full/,
      );
      assert.equal(await vault.get(`conn_${tokConn.id}_token`), 'original-tok-1');

      // extractConnectionSecrets does not clobber an unowned conn_<slug>_token on new connection.
      const ex = await extractConnectionSecrets(
        { name: 'TokSvc', transport: 'http', url: 'https://tok2.example.com/mcp', headers: {} },
        vault,
        { connName: 'TokSvc', connId: null, explicitToken: 'different-tok-9' },
      );
      assert.equal(await vault.get(`conn_${tokConn.id}_token`), 'original-tok-1');
      assert.equal(ex.conn.headers.Authorization, 'Bearer {{vault:conn_toksvc_token_2}}');
      await ex.rollback();
      assert.equal(await vault.get('conn_toksvc_token_2'), null);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('G5-04: deleteConnection cascades across pool, OAuth keys, unshared conn_<id>_token, store, policies, and categories', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-delete-cascade-'));
    try {
      const dataDir = path.join(tmp, 'data');
      const store = new LoopStore(dataDir);
      const vault = new Vault(dataDir);
      const policyStore = new PolicyStore(dataDir);
      const catStore = new CategoryStore(dataDir);

      const { entry: c1 } = await admitConnectionWrite({
        actor: { kind: 'owner' },
        input: { name: 'Alpha', url: 'https://alpha.example.com/mcp', token: 'alpha-token-1' },
        store,
        vault,
      });
      await vault.set(`__oauth_access_${c1.id}`, 'acc-1');
      await vault.set(`__oauth_refresh_${c1.id}`, 'ref-1');
      await vault.set(`__oauth_client_secret_${c1.id}`, 'sec-1');
      await policyStore.update({
        connections: { [c1.id]: 'always_ask' },
        tools: { [`${c1.id}__pay`]: 'always_ask', other__run: 'auto' },
      });
      await catStore.organize({ assignConnections: { [c1.id]: 'cloud-dev' } });

      const invalidated = [];
      const mockPool = { async invalidate(id) { invalidated.push(id); } };

      const removed = await deleteConnection({
        id: c1.id,
        store,
        vault,
        pool: mockPool,
        policyStore,
        catStore,
      });
      assert.equal(removed, true);
      assert.deepEqual(invalidated, [c1.id]);
      assert.equal(await store.get(c1.id), null);
      assert.equal(await vault.get(`__oauth_access_${c1.id}`), null);
      assert.equal(await vault.get(`__oauth_refresh_${c1.id}`), null);
      assert.equal(await vault.get(`__oauth_client_secret_${c1.id}`), null);
      assert.equal(await vault.get(`conn_${c1.id}_token`), null);

      const polAfter = await policyStore.get();
      assert.equal(polAfter.connections[c1.id], undefined);
      assert.equal(polAfter.tools[`${c1.id}__pay`], undefined);
      assert.equal(polAfter.tools.other__run, 'auto');

      const catsAfter = await catStore.load();
      assert.equal(catsAfter.connections[c1.id], undefined);

      // Deleting a non-existent id returns false.
      assert.equal(await deleteConnection({ id: 'missing', store, vault }), false);

      // Shared conn_<id>_token referenced by another connection is NOT deleted!
      const { entry: c2 } = await admitConnectionWrite({
        actor: { kind: 'owner' },
        input: { name: 'Beta', url: 'https://beta.example.com/mcp', token: 'shared-beta-tok' },
        store,
        vault,
      });
      await admitConnectionWrite({
        actor: { kind: 'owner' },
        input: {
          name: 'Gamma',
          url: 'https://gamma.example.com/mcp',
          headers: { Authorization: `Bearer {{vault:conn_${c2.id}_token}}` },
        },
        store,
        vault,
      });
      await deleteConnection({ id: c2.id, store, vault });
      assert.equal(
        await vault.get(`conn_${c2.id}_token`),
        'shared-beta-tok',
        'token still referenced by another connection must be kept',
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('Wave 1 Importers Hardening (G6-04, G6-06, G6-07, G6-08, G6-13, G6-16, G6-17, G6-18, G6-19, G6-20, G6-23, G6-27)', () => {
  it('G6-23: parses BOM-prefixed JSONC/TOML, TOML 1.0 hex/oct/bin, dates/times, +/-inf/nan, 4-5 closing quotes, single-pass escapes, and degrades per-key', () => {
    // UTF-8 BOM stripped in JSONC and TOML
    assert.deepEqual(parseJsonc('\uFEFF{ "a": 1, }'), { a: 1 });
    assert.equal(parseToml, parseTomlLite);

    const toml = `\uFEFF
hex_val = 0xDEAD_BEEF
oct_val = 0o755
bin_val = 0b1101_0110
pos_inf = +inf
neg_inf = -inf
pos_nan = +nan
neg_nan = -nan
local_date = 2026-05-01
local_time = 07:32:00.25
space_dt = 2026-05-01 07:32:00Z
offset_dt = 2026-05-01T07:32:00-05:00
quad_basic = """hello""""
quint_basic = """hello"""""
quad_lit = '''hi''''
quint_lit = '''hi'''''
single_pass_esc = """C:\\\\new\\\\tab
line2"""
line_cont = """alpha \\
   beta"""
exotic_future_key = @unsupported_exotic_token

[mcp_servers.github]
url = "https://api.github.com/mcp"
`;

    const parsed = parseToml(toml);
    assert.equal(parsed.hex_val, 0xdeadbeef);
    assert.equal(parsed.oct_val, 0o755);
    assert.equal(parsed.bin_val, 0b11010110);
    assert.equal(parsed.pos_inf, Infinity);
    assert.equal(parsed.neg_inf, -Infinity);
    assert.ok(Number.isNaN(parsed.pos_nan));
    assert.ok(Number.isNaN(parsed.neg_nan));
    assert.equal(parsed.local_date, '2026-05-01');
    assert.equal(parsed.local_time, '07:32:00.25');
    assert.equal(parsed.space_dt, '2026-05-01 07:32:00Z');
    assert.equal(parsed.offset_dt, '2026-05-01T07:32:00-05:00');
    assert.equal(parsed.quad_basic, 'hello"');
    assert.equal(parsed.quint_basic, 'hello""');
    assert.equal(parsed.quad_lit, "hi'");
    assert.equal(parsed.quint_lit, "hi''");
    assert.equal(parsed.single_pass_esc, 'C:\\new\\tab\nline2');
    assert.equal(parsed.line_cont, 'alpha beta');
    assert.equal(parsed.exotic_future_key, undefined, 'exotic unsupported value degrades per-key');
    assert.equal(parsed.mcp_servers.github.url, 'https://api.github.com/mcp');

    // Escaped trailing backslash before newline is NOT a line-continuation!
    const trailingSlash = parseToml('s = """ends_with_slash\\\\\nnext"""');
    assert.equal(trailingSlash.s, 'ends_with_slash\\\nnext');

    // Strict mode still rejects unsupported values, and broken syntax always throws.
    assert.throws(() => parseToml('exotic = @unsupported', { strict: true }), /TOML parse error/);
    assert.throws(() => parseToml('key = '), /TOML parse error/);
  });

  it('G6-20: reads Claude Code enabledPlugins from ~/.claude/settings.json and substitutes ${CLAUDE_PLUGIN_ROOT}', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-g6-20-'));
    try {
      const home = path.join(tmp, 'home');
      const enabledVerDir = path.join(home, '.claude', 'plugins', 'cache', 'acme', 'helper-plugin', '1.2.0');
      const disabledVerDir = path.join(home, '.claude', 'plugins', 'cache', 'acme', 'off-plugin', '0.9.0');
      await mkdir(enabledVerDir, { recursive: true });
      await mkdir(disabledVerDir, { recursive: true });

      await writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }), 'utf8');
      await writeFile(
        path.join(home, '.claude', 'settings.json'),
        JSON.stringify({
          enabledPlugins: {
            'helper-plugin@acme': true,
            'off-plugin@acme': false,
          },
        }),
        'utf8',
      );
      await writeFile(
        path.join(enabledVerDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            helper: {
              command: 'node',
              args: ['${CLAUDE_PLUGIN_ROOT}/dist/index.js'],
              cwd: '${CLAUDE_PLUGIN_ROOT}',
              env: { PLUGIN_DATA: '${CLAUDE_PLUGIN_ROOT}/data' },
            },
          },
        }),
        'utf8',
      );
      await writeFile(
        path.join(disabledVerDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            off_srv: { type: 'http', url: 'https://off-plugin.example.com/mcp' },
          },
        }),
        'utf8',
      );

      const store = new LoopStore(path.join(tmp, 'data'));
      const sources = await discoverSources(store, {
        sources: sourceDefinitions({ home, platform: 'darwin', env: {} }),
        env: {},
      });
      const claude = sources.find((s) => s.id === 'claude-code');
      const helper = claude.servers.find((s) => s.name === 'helper');
      const offSrv = claude.servers.find((s) => s.name === 'off_srv');

      assert.ok(helper, 'helper plugin server should be discovered');
      assert.equal(helper.enabled, true);
      assert.equal(helper.status, 'new');
      assert.equal(helper.candidate.args[0], path.join(path.resolve(enabledVerDir), 'dist/index.js'));
      assert.equal(helper.candidate.cwd, path.resolve(enabledVerDir));
      assert.equal(helper.candidate.env.PLUGIN_DATA, path.join(path.resolve(enabledVerDir), 'data'));
      assert.deepEqual(helper.warnings, [], 'no unresolved CLAUDE_PLUGIN_ROOT warning');

      assert.ok(offSrv, 'disabled plugin server should be discovered');
      assert.equal(offSrv.enabled, false, 'enabledPlugins=false from settings.json must be respected');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('G6-13: preserves Gemini includeTools -> allowedTools alongside excludeTools -> disabledTools', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-g6-13-'));
    try {
      const home = path.join(tmp, 'home');
      await mkdir(path.join(home, '.gemini'), { recursive: true });
      await writeFile(
        path.join(home, '.gemini', 'settings.json'),
        JSON.stringify({
          mcpServers: {
            scoped_gh: {
              httpUrl: 'https://api.github.com/mcp',
              includeTools: ['list_issues', 'get_pull_request', 'list_issues'],
              excludeTools: ['delete_repo'],
            },
          },
        }),
        'utf8',
      );

      const store = new LoopStore(path.join(tmp, 'data'));
      const vault = new Vault(path.join(tmp, 'data'));
      const sources = await discoverSources(store, {
        sources: sourceDefinitions({ home, platform: 'darwin', env: {} }),
        env: {},
      });
      const scopedGh = sources.find((s) => s.id === 'gemini').servers.find((s) => s.name === 'scoped_gh');
      assert.ok(scopedGh);
      assert.deepEqual(scopedGh.candidate.allowedTools, ['list_issues', 'get_pull_request']);
      assert.deepEqual(scopedGh.candidate.disabledTools, ['delete_repo']);

      const { added, skipped } = await importCandidates(store, vault, [
        { name: scopedGh.name, candidate: scopedGh.candidate },
      ]);
      assert.equal(skipped.length, 0);
      assert.equal(added.length, 1);
      assert.deepEqual(added[0].entry.disabledTools, ['delete_repo']);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('G6-04: credential-aware duplicate detection protects distinct accounts in discovery, import, and cleanup', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-g6-04-'));
    try {
      const home = path.join(tmp, 'home');
      await mkdir(path.join(home, '.cursor'), { recursive: true });

      const store = new LoopStore(path.join(tmp, 'data'));
      const vault = new Vault(path.join(tmp, 'data'));

      // Two accounts pointing to the same URL with DIFFERENT Bearer tokens.
      const workCand = {
        name: 'gh-work',
        transport: 'http',
        url: 'https://api.github.com/mcp',
        headers: { Authorization: 'Bearer work-token-111' },
      };
      const personalCand = {
        name: 'gh-personal',
        transport: 'http',
        url: 'https://api.github.com/mcp',
        headers: { Authorization: 'Bearer personal-token-222' },
      };

      // Sync isDuplicateEntry never equates different plaintext credentials!
      assert.equal(isDuplicateEntry(personalCand, [workCand]), false);
      assert.equal(
        isDuplicateEntry(
          { transport: 'stdio', command: 'npx', args: ['-y', 's', '--api-key', 'key-a'], env: { TOK: 'a' } },
          [{ transport: 'stdio', command: 'npx', args: ['-y', 's', '--api-key', 'key-b'], env: { TOK: 'a' } }],
        ),
        false,
      );
      assert.equal(
        isDuplicateEntry(
          { transport: 'stdio', command: 'npx', args: ['-y', 's'], env: { TOK: 'a' } },
          [{ transport: 'stdio', command: 'npx', args: ['-y', 's'], env: { TOK: 'b' } }],
        ),
        false,
      );
      assert.equal(
        isDuplicateEntry(
          { transport: 'http', url: 'https://api.example.com/mcp?api_key=sk-acct-111111111111111111111111', headers: {} },
          [{ transport: 'http', url: 'https://api.example.com/mcp?api_key=sk-acct-222222222222222222222222', headers: {} }],
        ),
        false,
      );

      // Import work account into Loop (secret moves to vault).
      const imp1 = await importCandidates(store, vault, [{ name: 'gh-work', candidate: workCand }]);
      assert.equal(imp1.added.length, 1);
      const storedWork = imp1.added[0].entry;
      assert.match(storedWork.headers.Authorization, /\{\{vault:/);

      // isExactDuplicateForCleanup:
      // - Without vault: CANNOT verify {{vault:...}} -> MUST return false!
      assert.equal(await isExactDuplicateForCleanup(workCand, storedWork, null), false);
      // - With vault and matching secret -> returns true!
      assert.equal(await isExactDuplicateForCleanup(workCand, storedWork, vault), true);
      // - With vault and DIFFERENT secret -> returns false!
      assert.equal(await isExactDuplicateForCleanup(personalCand, storedWork, vault), false);

      // Importing personal account succeeds (not falsely skipped as Already exists)!
      const imp2 = await importCandidates(store, vault, [{ name: 'gh-personal', candidate: personalCand }]);
      assert.equal(imp2.added.length, 1);

      // Cleanup test: Claude has work (matching) + third account (different token) + unverified when vault omitted.
      const claudePath = path.join(home, '.claude.json');
      await writeFile(
        claudePath,
        JSON.stringify(
          {
            mcpServers: {
              gh_work: { type: 'http', url: 'https://api.github.com/mcp', headers: { Authorization: 'Bearer work-token-111' } },
              gh_other: { type: 'http', url: 'https://api.github.com/mcp', headers: { Authorization: 'Bearer other-token-999' } },
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      // Without vault: NEITHER is removed because Loop's entries use {{vault:...}} and cannot be verified!
      const withoutVault = await cleanupAgentConfigs(store, {
        dryRun: false,
        onlyReady: true,
        ctx: { home, platform: 'darwin', env: {} },
      });
      assert.equal(withoutVault.totalRemoved, 0);
      assert.equal(withoutVault.agents[0].backupPath, null, 'G6-27: no spurious backup when nothing removed');

      // With vault: ONLY gh_work (exact credential match) is removed; gh_other is KEPT!
      const withVault = await cleanupAgentConfigs(store, {
        dryRun: false,
        onlyReady: true,
        vault,
        ctx: { home, platform: 'darwin', env: {} },
      });
      const claudeReport = withVault.agents.find((a) => a.id === 'claude-code');
      assert.deepEqual(claudeReport.removed.map((r) => r.name), ['gh_work']);
      assert.ok(claudeReport.kept.some((k) => k.name === 'gh_other'));

      const claudeAfter = JSON.parse(await readFile(claudePath, 'utf8'));
      assert.equal(claudeAfter.mcpServers.gh_work, undefined);
      assert.equal(claudeAfter.mcpServers.gh_other.headers.Authorization, 'Bearer other-token-999');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('G6-08: keys Claude Code project scopes by full canonical project path (same basename never collides)', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-g6-08-'));
    try {
      const home = path.join(tmp, 'home');
      await mkdir(home, { recursive: true });
      const claudePath = path.join(home, '.claude.json');
      await writeFile(
        claudePath,
        JSON.stringify(
          {
            mcpServers: {},
            projects: {
              '/work/team-a/app': {
                mcpServers: {
                  shared_name: { type: 'http', url: 'https://team-a.example.com/mcp' },
                },
              },
              '/work/team-b/app': {
                mcpServers: {
                  shared_name: { type: 'http', url: 'https://team-b.example.com/mcp' },
                },
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const store = new LoopStore(path.join(tmp, 'data'));
      // Only team-a's server is in Loop; team-b's is NOT in Loop!
      await store.add({ name: 'Team A', transport: 'http', url: 'https://team-a.example.com/mcp' });

      const discovered = await discoverSources(store, {
        sources: sourceDefinitions({ home, platform: 'darwin', env: {} }),
        env: {},
      });
      const claudeServers = discovered.find((s) => s.id === 'claude-code').servers;
      assert.equal(claudeServers.length, 2);
      assert.notEqual(claudeServers[0].key, claudeServers[1].key, 'project keys must not collide on basename');
      assert.deepEqual(
        claudeServers.map((s) => s.projectPath).sort(),
        ['/work/team-a/app', '/work/team-b/app'],
      );

      const cleaned = await cleanupAgentConfigs(store, {
        dryRun: false,
        onlyReady: true,
        includeProjectScopes: true,
        ctx: { home, platform: 'darwin', env: {} },
      });
      const report = cleaned.agents.find((a) => a.id === 'claude-code');
      assert.equal(report.removed.length, 1);
      assert.equal(report.removed[0].projectPath, '/work/team-a/app');
      assert.equal(report.kept.length, 1);
      assert.equal(report.kept[0].projectPath, '/work/team-b/app');

      const after = JSON.parse(await readFile(claudePath, 'utf8'));
      assert.equal(after.projects['/work/team-a/app'].mcpServers.shared_name, undefined);
      assert.equal(
        after.projects['/work/team-b/app'].mcpServers.shared_name.url,
        'https://team-b.example.com/mcp',
        'team-b project with identical basename must remain untouched',
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('G6-06 & G6-19: TOML-aware surgical removal handles multiline strings, [[array.tables]], quoted/dotted/inline keys, CRLF, and re-parse verification', async () => {
    const crlfToml = [
      '# Top comment',
      'model = "gpt-5"',
      'mcp_servers.dotted_rm.url = "https://dotted.example.com/mcp"',
      'mcp_servers.inline_rm = { url = "https://inline.example.com/mcp", enabled = true }',
      '',
      '[notes]',
      'sample = """',
      '[mcp_servers.target_rm]',
      'url = "fake-inside-multiline-basic"',
      '"""',
      "lit = '''",
      '[mcp_servers.target_rm]',
      "'''",
      '',
      '[mcp_servers.loop]',
      'url = "http://127.0.0.1:8799/mcp"',
      '',
      '[mcp_servers.target_rm]',
      'desc = """',
      '[unrelated_fake]',
      '"""',
      'url = "https://target.example.com/mcp"',
      '',
      '[mcp_servers."foo]bar"]',
      'url = "https://bracket.example.com/mcp"',
      '',
      "[mcp_servers.'a.b'.env]",
      'TOKEN = "abc"',
      '',
      '[[array_of_tables]]',
      'name = "must-survive"',
      '',
    ].join('\r\n');

    const edited = removeTomlMcpServers(crlfToml, ['target_rm', 'foo]bar', 'a.b', 'dotted_rm', 'inline_rm']);
    assert.ok(edited.includes('\r\n'), 'CRLF line endings are preserved');
    assert.ok(!edited.includes('https://target.example.com/mcp'));
    assert.ok(!edited.includes('https://bracket.example.com/mcp'));
    assert.ok(!edited.includes('https://dotted.example.com/mcp'));
    assert.ok(!edited.includes('https://inline.example.com/mcp'));

    const parsedAfter = parseToml(edited);
    assert.equal(parsedAfter.model, 'gpt-5');
    assert.equal(parsedAfter.mcp_servers.loop.url, 'http://127.0.0.1:8799/mcp');
    assert.equal(parsedAfter.mcp_servers.target_rm, undefined);
    assert.equal(parsedAfter.mcp_servers['foo]bar'], undefined);
    assert.equal(parsedAfter.mcp_servers['a.b'], undefined);
    assert.equal(parsedAfter.mcp_servers.dotted_rm, undefined);
    assert.equal(parsedAfter.mcp_servers.inline_rm, undefined);
    assert.match(parsedAfter.notes.sample, /\[mcp_servers\.target_rm\]/, 'multiline string content preserved');
    assert.match(parsedAfter.notes.lit, /\[mcp_servers\.target_rm\]/, 'literal multiline string content preserved');
    assert.deepEqual(parsedAfter.array_of_tables, [{ name: 'must-survive' }], '[[array_of_tables]] preserved');

    // Inline root table mcp_servers = { del = ..., loop = ... }
    const inlineRoot = 'mcp_servers = { del = { url = "https://del.example.com/mcp" }, loop = { url = "http://127.0.0.1:8799/mcp" } }\n';
    const editedInlineRoot = removeTomlMcpServers(inlineRoot, ['del']);
    assert.deepEqual(parseToml(editedInlineRoot), {
      mcp_servers: { loop: { url: 'http://127.0.0.1:8799/mcp' } },
    });

    // Under [mcp_servers] parent header with inline child entries
    const underParentHeader = '[mcp_servers]\ndel = { url = "https://del.example.com/mcp" }\nloop = { url = "http://127.0.0.1:8799/mcp" }\n';
    const editedUnderParent = removeTomlMcpServers(underParentHeader, ['del']);
    assert.deepEqual(parseToml(editedUnderParent), {
      mcp_servers: { loop: { url: 'http://127.0.0.1:8799/mcp' } },
    });

    // End-to-end cleanupAgentConfigs with Codex TOML verifies re-parse diff cleanly.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-g6-06-'));
    try {
      const home = path.join(tmp, 'home');
      await mkdir(path.join(home, '.codex'), { recursive: true });
      const codexPath = path.join(home, '.codex', 'config.toml');
      await writeFile(codexPath, crlfToml, 'utf8');

      const store = new LoopStore(path.join(tmp, 'data'));
      await store.add({ name: 'Target', transport: 'http', url: 'https://target.example.com/mcp' });
      await store.add({ name: 'Bracket', transport: 'http', url: 'https://bracket.example.com/mcp' });

      const res = await cleanupAgentConfigs(store, {
        dryRun: false,
        onlyReady: true,
        ctx: { home, platform: 'darwin', env: {} },
      });
      const codexRep = res.agents.find((a) => a.id === 'codex');
      assert.deepEqual(codexRep.removed.map((r) => r.name).sort(), ['foo]bar', 'target_rm']);
      const onDisk = await readFile(codexPath, 'utf8');
      const parsedOnDisk = parseToml(onDisk);
      assert.deepEqual(parsedOnDisk.array_of_tables, [{ name: 'must-survive' }]);
      assert.equal(parsedOnDisk.mcp_servers.target_rm, undefined);
      assert.equal(parsedOnDisk.mcp_servers['foo]bar'], undefined);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('G6-07: JSONC range-edit preserves comments/trailing commas/CRLF, follows symlinks, and preserves file permissions', async () => {
    const jsonc = [
      '{',
      '  // Top-level settings comment',
      '  "theme": "dark",',
      '  /* Block comment above mcpServers */',
      '  "mcpServers": {',
      '    // Keep Loop gateway',
      '    "loop": { "httpUrl": "http://127.0.0.1:8799/mcp" },',
      '    "remove_me": { "httpUrl": "https://remove.example.com/mcp" },',
      '  },',
      '}',
      '',
    ].join('\r\n');

    const edited = removeJsoncKeys(jsonc, [['mcpServers', 'remove_me']]);
    assert.ok(edited.includes('\r\n'), 'CRLF preserved');
    assert.ok(edited.includes('// Top-level settings comment'), 'line comment preserved');
    assert.ok(edited.includes('/* Block comment above mcpServers */'), 'block comment preserved');
    assert.ok(edited.includes('// Keep Loop gateway'), 'nested comment preserved');
    assert.ok(!edited.includes('remove_me'));
    assert.deepEqual(parseJsonc(edited), {
      theme: 'dark',
      mcpServers: { loop: { httpUrl: 'http://127.0.0.1:8799/mcp' } },
    });

    // Strict JSON without trailing comma: removing the LAST key must also drop the preceding comma.
    const strictJson = '{\n  "mcpServers": {\n    "loop": { "url": "http://127.0.0.1:8799/mcp" },\n    "last_one": { "url": "https://last.example.com/mcp" }\n  }\n}\n';
    const editedStrict = removeJsoncKeys(strictJson, [['mcpServers', 'last_one']]);
    assert.deepEqual(JSON.parse(editedStrict), {
      mcpServers: { loop: { url: 'http://127.0.0.1:8799/mcp' } },
    });

    // Symlink target + permission mode preservation end-to-end in cleanupAgentConfigs.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-g6-07-'));
    try {
      const home = path.join(tmp, 'home');
      const dotfiles = path.join(tmp, 'dotfiles');
      await mkdir(path.join(home, '.gemini'), { recursive: true });
      await mkdir(dotfiles, { recursive: true });

      const realFile = path.join(dotfiles, 'gemini-settings.json');
      const linkFile = path.join(home, '.gemini', 'settings.json');
      await writeFile(realFile, jsonc, { mode: 0o640 });
      await chmod(realFile, 0o640);
      await symlink(realFile, linkFile);

      const store = new LoopStore(path.join(tmp, 'data'));
      await store.add({ name: 'Remove Me', transport: 'http', url: 'https://remove.example.com/mcp' });

      const res = await cleanupAgentConfigs(store, {
        dryRun: false,
        onlyReady: true,
        ctx: { home, platform: 'darwin', env: {} },
      });
      const geminiRep = res.agents.find((a) => a.id === 'gemini');
      assert.deepEqual(geminiRep.removed.map((r) => r.name), ['remove_me']);

      // Symlink must STILL be a symlink (not replaced with a regular file)!
      assert.equal((await lstat(linkFile)).isSymbolicLink(), true, 'symlink must remain a symlink');
      // Target permission mode 0o640 must be preserved!
      assert.equal((await stat(realFile)).mode & 0o777, 0o640, 'existing file mode must be preserved');

      const realAfter = await readFile(realFile, 'utf8');
      assert.ok(realAfter.includes('// Top-level settings comment'));
      assert.ok(realAfter.includes('/* Block comment above mcpServers */'));
      assert.ok(!realAfter.includes('remove_me'));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('G6-16 & G6-27: CAS hash check aborts cleanly on concurrent edits without overwriting or leaving stale backups/tmps', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-g6-16-'));
    try {
      const home = path.join(tmp, 'home');
      await mkdir(home, { recursive: true });
      const claudePath = path.join(home, '.claude.json');
      await writeFile(
        claudePath,
        JSON.stringify(
          {
            mcpServers: {
              loop: { type: 'http', url: 'http://127.0.0.1:8799/mcp' },
              clean_me: { type: 'http', url: 'https://clean.example.com/mcp' },
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const store = new LoopStore(path.join(tmp, 'data'));
      await store.add({ name: 'Clean Me', transport: 'http', url: 'https://clean.example.com/mcp' });

      // Simulate Claude Code concurrently writing to ~/.claude.json right before commit!
      const concurrentContent = JSON.stringify(
        {
          mcpServers: {
            loop: { type: 'http', url: 'http://127.0.0.1:8799/mcp' },
            clean_me: { type: 'http', url: 'https://clean.example.com/mcp' },
            brand_new_from_app: { type: 'http', url: 'https://new.example.com/mcp' },
          },
        },
        null,
        2,
      );

      const res = await cleanupAgentConfigs(store, {
        dryRun: false,
        onlyReady: true,
        ctx: {
          home,
          platform: 'darwin',
          env: {},
          async _beforeCommit({ realTarget }) {
            await writeFile(realTarget, concurrentContent, 'utf8');
          },
        },
      });

      const rep = res.agents.find((a) => a.id === 'claude-code');
      assert.equal(rep.error, 'File changed while cleaning; skipped to preserve concurrent edits.');
      assert.equal(rep.removed.length, 0);
      assert.equal(rep.backupPath, null, 'no stale backup created on CAS abort');

      // Concurrent edit from the app must be 100% preserved!
      assert.equal(await readFile(claudePath, 'utf8'), concurrentContent);

      // No leftover backup or tmp files in home directory!
      const filesInHome = await readdir(home);
      assert.deepEqual(filesInHome, ['.claude.json']);

      // Concurrent cleanupAgentConfigs calls serialize via per-realpath lock without tmp collisions or double backups.
      const [c1, c2] = await Promise.all([
        cleanupAgentConfigs(store, { dryRun: false, onlyReady: true, ctx: { home, platform: 'darwin', env: {} } }),
        cleanupAgentConfigs(store, { dryRun: false, onlyReady: true, ctx: { home, platform: 'darwin', env: {} } }),
      ]);
      const removedSum = c1.totalRemoved + c2.totalRemoved;
      assert.equal(removedSum, 1, 'exactly one concurrent cleanup succeeds; the other aborts or finds nothing left');
      const finalParsed = JSON.parse(await readFile(claudePath, 'utf8'));
      assert.equal(finalParsed.mcpServers.clean_me, undefined);
      assert.ok(finalParsed.mcpServers.brand_new_from_app, 'app server remains intact');
      assert.ok(finalParsed.mcpServers.loop, 'loop remains intact');
      const leftovers = (await readdir(home)).filter((f) => f.includes('.loop-tmp-'));
      assert.deepEqual(leftovers, [], 'no leftover tmp files');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('G6-18: exact source ID matching, empty array = 0 agents, and resolveCleanupPlan helper', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-g6-18-'));
    try {
      const home = path.join(tmp, 'home');
      await mkdir(path.join(home, '.codex'), { recursive: true });
      const claudePath = path.join(home, '.claude.json');
      const codexPath = path.join(home, '.codex', 'config.toml');

      await writeFile(
        claudePath,
        JSON.stringify({ mcpServers: { shared: { type: 'http', url: 'https://shared.example.com/mcp' } } }),
        'utf8',
      );
      await writeFile(
        codexPath,
        '[mcp_servers.shared]\nurl = "https://shared.example.com/mcp"\n',
        'utf8',
      );

      const store = new LoopStore(path.join(tmp, 'data'));
      await store.add({ name: 'Shared', transport: 'http', url: 'https://shared.example.com/mcp' });

      // Empty array [] cleans ZERO agents (never all agents)!
      const emptyRes = await cleanupAgentConfigs(store, {
        sources: [],
        dryRun: false,
        ctx: { home, platform: 'darwin', env: {} },
      });
      assert.equal(emptyRes.totalRemoved, 0);
      assert.equal(emptyRes.agents.length, 0);

      // Substring / label 'claude' or 'Code' matches ZERO agents!
      const substrRes = await cleanupAgentConfigs(store, {
        sources: ['claude', 'Code'],
        dryRun: false,
        ctx: { home, platform: 'darwin', env: {} },
      });
      assert.equal(substrRes.totalRemoved, 0);
      assert.equal(substrRes.agents.length, 0);

      // resolveCleanupPlan returns exact resolved agents & files without touching disk.
      const plan = await resolveCleanupPlan(store, {
        sources: ['claude-code'],
        ctx: { home, platform: 'darwin', env: {} },
      });
      assert.equal(plan.totalRemoved, 1);
      assert.deepEqual(plan.files, [claudePath]);
      assert.deepEqual(plan.targets.map((t) => ({ id: t.id, servers: t.servers })), [
        { id: 'claude-code', servers: ['shared'] },
      ]);

      // Exact ID ['claude-code'] cleans ONLY Claude Code, leaving Codex untouched!
      const exactRes = await cleanupAgentConfigs(store, {
        sources: ['claude-code'],
        dryRun: false,
        ctx: { home, platform: 'darwin', env: {} },
      });
      assert.equal(exactRes.agents.length, 1);
      assert.equal(exactRes.agents[0].id, 'claude-code');
      assert.equal(exactRes.totalRemoved, 1);
      assert.match(await readFile(codexPath, 'utf8'), /\[mcp_servers\.shared\]/, 'codex untouched');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('G6-17: concurrent double-submitted importCandidates calls serialize per store and never create duplicates', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-g6-17-'));
    try {
      const store = new LoopStore(path.join(tmp, 'data'));
      const vault = new Vault(path.join(tmp, 'data'));
      const items = candidatesFromMcpJson({
        mcpServers: {
          stripe: {
            type: 'http',
            url: 'https://mcp.stripe.com/mcp',
            headers: { Authorization: 'Bearer sk_live_STRIPE_CONCURRENT_123456' },
          },
        },
      });

      const [r1, r2, r3] = await Promise.all([
        importCandidates(store, vault, items),
        importCandidates(store, vault, items),
        importCandidates(store, vault, items),
      ]);

      const totalAdded = r1.added.length + r2.added.length + r3.added.length;
      const totalSkipped = r1.skipped.length + r2.skipped.length + r3.skipped.length;
      assert.equal(totalAdded, 1, 'exactly one concurrent call adds the connection');
      assert.equal(totalSkipped, 2, 'subsequent concurrent calls see it and skip as duplicate');
      assert.equal((await store.list()).length, 1, 'store holds exactly one connection');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
