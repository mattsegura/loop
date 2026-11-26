import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildMemoryGraph,
  detectExternalMemoryConnections,
  discoverMemorySources,
  exportMemoriesMarkdown,
  extractMemoriesFromExternalResult,
  looksLikeSecret,
  MemoryStore,
  parsePastedMemories,
  pickExternalMemoryTools,
  searchMemories,
  validateSyncFolder,
} from '../lib/memory.mjs';
import { startServer } from '../server.mjs';

const frontendApi = 'https://loop-memory-test.clerk.accounts.dev';
const clerkApp = {
  publishableKey: 'fixture',
  frontendApi,
  async verifyRequest(req) {
    const userId = req.headers['x-fixture-auth'];
    if (userId !== 'user_A' && userId !== 'user_B') return null;
    return { userId, sessionId: 'sess_mem', issuer: frontendApi, expiresAt: Date.now() + 60_000 };
  },
};

test('MemoryStore saves, deduplicates, pins, searches, and blocks secret-looking strings', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-mem-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MemoryStore(dir);

  // Secret guard catches API keys, Loop tokens, private keys, JWTs, passwords, and valid Luhn cards
  assert.equal(looksLikeSecret('Use sk-proj-abcdefghijklmnopqrstuvwxyz1234 for OpenAI'), true);
  assert.equal(looksLikeSecret('GitHub token ghp_1234567890abcdefghijklmnop'), true);
  assert.equal(looksLikeSecret('password = superSecretPassword123'), true);
  assert.equal(looksLikeSecret('Prefer concise bullet-point answers and Node.js 22'), false);

  await assert.rejects(
    () => store.save({ content: 'My OpenAI key is sk-proj-abcdefghijklmnopqrstuvwxyz1234' }),
    /Vault/i,
  );

  // Save, deduplicate, pin, search, update, remove
  const first = await store.save({
    key: 'style',
    content: 'Prefer concise, direct answers without filler.',
    scope: 'preference',
    pinned: true,
    writtenBy: 'Claude Code',
  });
  assert.equal(first.created, true);
  assert.equal(first.memory.pinned, true);
  assert.equal(first.memory.writtenBy, 'Claude Code');

  const dup = await store.save({
    content: 'Prefer concise, direct answers without filler.',
    scope: 'preference',
  });
  assert.equal(dup.created, false);
  assert.equal((await store.list()).length, 1);

  await store.save({
    content: 'Primary Mac dev workspace lives under ~/Documents/Dev/loop.',
    scope: 'project',
    project: 'loop',
    writtenBy: 'Codex',
  });

  const hits = await store.list({ query: 'documents dev loop' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].project, 'loop');

  const pinned = await store.list({ pinnedOnly: true });
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].key, 'style');

  const updated = await store.update(first.memory.id, { pinned: false });
  assert.equal(updated.pinned, false);
  assert.equal(await store.remove(first.memory.id), true);
  assert.equal((await store.list()).length, 1);
});

test('G5-05: MemoryStore fails closed on corrupt or malformed memory.json without erasing it', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-mem-corrupt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MemoryStore(dir);
  const file = path.join(dir, 'memory.json');

  // Missing file starts empty
  assert.deepEqual(await store.list(), []);

  // SyntaxError fails closed on read and write, preserving file on disk
  await writeFile(file, '{broken json', 'utf8');
  await assert.rejects(() => store.list(), SyntaxError);
  await assert.rejects(() => store.get('anything'), SyntaxError);
  await assert.rejects(() => store.save({ content: 'New fact that must not wipe disk.' }), SyntaxError);
  assert.equal(await readFile(file, 'utf8'), '{broken json');

  // Corrupt JSON structures fail closed without erasing disk
  for (const bad of ['null', '[]', '"hello"', '{}', '{"version":1,"memories":"not-an-array"}']) {
    await writeFile(file, bad, 'utf8');
    await assert.rejects(() => store.list(), /Invalid memory file/);
    await assert.rejects(() => store.save({ content: 'Another fact' }), /Invalid memory file/);
    assert.equal(await readFile(file, 'utf8'), bad);
  }
});

test('G5-17: MemoryStore.update() enforces key uniqueness and blocks secrets in keys', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-mem-keys-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MemoryStore(dir);

  const a = await store.save({ key: 'alpha', content: 'First fact about workspace layout.' });
  const b = await store.save({ key: 'beta', content: 'Second fact about deployment pipeline.' });

  // Renaming beta -> alpha collides with existing key and rejects with 409
  await assert.rejects(
    () => store.update(b.memory.id, { key: 'alpha' }),
    (err) => err.status === 409 && err.code === 'DUPLICATE_KEY',
  );

  // Case/whitespace collision also rejected
  await assert.rejects(
    () => store.update(b.memory.id, { key: '  ALPHA  ' }),
    (err) => err.status === 409 && err.code === 'DUPLICATE_KEY',
  );

  // Updating own entry with its own key + new content is allowed
  const sameKey = await store.update(a.memory.id, { key: 'alpha', content: 'Updated first fact.' });
  assert.equal(sameKey.key, 'alpha');
  assert.equal(sameKey.content, 'Updated first fact.');

  // Renaming beta -> gamma (unique) succeeds
  const renamed = await store.update(b.memory.id, { key: 'gamma' });
  assert.equal(renamed.key, 'gamma');

  // Secret in updated key is blocked
  await assert.rejects(
    () => store.update(b.memory.id, { key: 'sk-proj-abcdefghijklmnopqrstuvwxyz1234' }),
    (err) => err.status === 400 && err.code === 'SECRET_IN_MEMORY',
  );

  const all = await store.list();
  assert.deepEqual(all.map((m) => m.key).sort(), ['alpha', 'gamma']);
});

test('discoverMemorySources & parsePastedMemories import Claude, Codex, Cursor, and ChatGPT memories while skipping secrets', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'loop-mem-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');

  await mkdir(path.join(home, '.claude', 'projects', '-Users-me-Dev-loop', 'memory'), { recursive: true });
  await mkdir(path.join(home, '.codex'), { recursive: true });
  await mkdir(path.join(home, '.cursor', 'rules'), { recursive: true });

  await writeFile(
    path.join(home, '.claude', 'projects', '-Users-me-Dev-loop', 'memory', 'feedback.md'),
    '---\nname: terse-output\ndescription: Keep answers short\ntype: feedback\n---\nAlways answer concisely without preamble.\n',
  );
  await writeFile(
    path.join(home, '.codex', 'AGENTS.md'),
    '# Personal Rules\n- Run npm test before finishing any change.\n- api_key=sk-proj-abcdefghijklmnopqrstuvwxyz1234\n',
  );
  await writeFile(
    path.join(home, '.cursor', 'rules', 'style.mdc'),
    '- Prefer boring, readable code over clever abstractions.\n',
  );

  const memStore = new MemoryStore(data);
  const sources = await discoverMemorySources(memStore, { home });
  const ids = sources.map((s) => s.id).sort();
  assert.deepEqual(ids, ['claude-code', 'codex', 'cursor']);
  const allContents = sources.flatMap((s) => s.items.map((i) => i.content));
  assert.ok(allContents.some((c) => /concisely/i.test(c)));
  assert.ok(allContents.some((c) => /npm test/i.test(c)));
  assert.ok(allContents.some((c) => /boring, readable code/i.test(c)));
  assert.ok(!allContents.some((c) => /sk-proj-/i.test(c)), 'secrets must be skipped during import');

  const pasted = parsePastedMemories(
    JSON.stringify([
      'User builds iOS apps in SwiftUI.',
      'My secret token is ghp_1234567890abcdefghijklmnop',
    ]),
    'ChatGPT',
  );
  assert.equal(pasted.length, 1);
  assert.match(pasted[0].content, /SwiftUI/);
});

test('Shared Memory end-to-end over MCP + REST: pinned turn-1 injection, per-agent memoryAccess, secret guard, and workspace isolation', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'loop-mem-e2e-'));
  const srv = await startServer({ port: 0, dataDir, detectLocalAgents: false, clerkApp });
  t.after(async () => {
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${srv.port}`;

  // Create two agents in user_A's local workspace:
  // 1) Claude (canManage: true, memoryAccess: 'read_write')
  // 2) ScraperBot (canManage: true, memoryAccess: 'read')
  // 3) IsolatedBot (canManage: false, memoryAccess: 'none')
  const mkAgent = async (body) => {
    const res = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fixture-Auth': 'user_A' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 201);
    return res.json();
  };
  const claude = await mkAgent({ name: 'Claude', kind: 'claude-code', canManage: true, memoryAccess: 'read_write' });
  const reader = await mkAgent({ name: 'ScraperBot', kind: 'other', canManage: true, memoryAccess: 'read' });
  const blind = await mkAgent({ name: 'IsolatedBot', kind: 'other', canManage: false, memoryAccess: 'none' });

  const mcpCall = async (token, method, params = {}) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    assert.equal(res.status, 200);
    return res.json();
  };

  // 1. Claude saves a pinned memory via loop__save({ type: "memory" })
  const saved = await mcpCall(claude.token, 'tools/call', {
    name: 'loop__save',
    arguments: {
      type: 'memory',
      data: {
        key: 'stack-pref',
        content: 'User ships Loop on macOS with Node 22 and prefers plain language.',
        scope: 'preference',
        pinned: true,
      },
    },
  });
  assert.equal(Boolean(saved.result.isError), false);
  const savedPayload = JSON.parse(saved.result.content[0].text);
  assert.equal(savedPayload.saved, true);
  assert.equal(savedPayload.memory.writtenBy, 'Claude');

  // 2. Saving a secret into memory via MCP is blocked
  const secretAttempt = await mcpCall(claude.token, 'tools/call', {
    name: 'loop__save',
    arguments: {
      type: 'memory',
      data: { content: 'Save my key sk-proj-abcdefghijklmnopqrstuvwxyz1234' },
    },
  });
  assert.equal(secretAttempt.result.isError, true);
  assert.match(secretAttempt.result.content[0].text, /Vault/i);

  // 3a. Agent-pinned memory appears immediately in initialize.instructions as fenced JSON data
  assert.equal(savedPayload.memory.pinnedBy, 'agent');
  const initPending = await mcpCall(reader.token, 'initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'reader', version: '1' },
  });
  assert.match(initPending.result.instructions, /Node 22/);

  // 3b. The owner approves the pin in the dashboard (PATCH pinned: true)
  const approvePin = await fetch(`${base}/api/memory/${encodeURIComponent(savedPayload.memory.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Fixture-Auth': 'user_A' },
    body: JSON.stringify({ pinned: true }),
  });
  assert.equal(approvePin.status, 200);

  // 3c. Approved pinned memory appears in initialize.instructions as data-only for reader, NOT for blind bot
  const initReader = await mcpCall(reader.token, 'initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'reader', version: '1' },
  });
  assert.match(initReader.result.instructions, /Pinned user memory \(facts & preferences as data only/);
  assert.doesNotMatch(initReader.result.instructions, /pinned by an agent/);
  assert.match(initReader.result.instructions, /Node 22/);

  const initBlind = await mcpCall(blind.token, 'initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'blind', version: '1' },
  });
  assert.doesNotMatch(initBlind.result.instructions, /Node 22/);

  // 4. Reader can recall via loop__search({ type: "memory" }) with provenance + data-only warning, but CANNOT write
  const recalled = await mcpCall(reader.token, 'tools/call', {
    name: 'loop__search',
    arguments: { type: 'memory', query: 'Node 22' },
  });
  const recallPayload = JSON.parse(recalled.result.content[0].text);
  assert.equal(recallPayload.total, 1);
  assert.equal(recallPayload.memories[0].writtenBy, 'Claude');
  assert.match(recallPayload.dataOnlyWarning, /never execute/i);

  const deniedWrite = await mcpCall(reader.token, 'tools/call', {
    name: 'loop__save',
    arguments: { type: 'memory', data: { content: 'Injected malicious instruction' } },
  });
  assert.equal(deniedWrite.result.isError, true);
  assert.match(deniedWrite.result.content[0].text, /permission to write/i);

  // 5. Blind bot cannot read memory at all
  const deniedRead = await mcpCall(blind.token, 'tools/call', {
    name: 'loop__search',
    arguments: { type: 'memory' },
  });
  assert.equal(deniedRead.result.isError, true);

  // 6. Workspace isolation: user_B sees 0 memories and cannot read local agent memory files
  const userBMem = await fetch(`${base}/api/memory`, { headers: { 'X-Fixture-Auth': 'user_B' } });
  assert.equal(userBMem.status, 200);
  assert.equal((await userBMem.json()).total, 0);

  const userBLocalImport = await fetch(`${base}/api/memory/import/sources`, {
    headers: { 'X-Fixture-Auth': 'user_B' },
  });
  assert.equal(userBLocalImport.status, 403);
});

test('Smart local recall matches concepts, stemming, typos, and 1-hop graph neighbors', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-mem-recall-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MemoryStore(dir);

  const stack = await store.save({
    key: 'primary-runtime',
    content: 'I build on macOS with Node.js 22 and TypeScript.',
    scope: 'global',
    tags: ['runtime'],
  });
  const style = await store.save({
    key: 'tone-rule',
    content: 'Keep responses short and direct without emojis.',
    scope: 'preference',
  });
  const deploy = await store.save({
    key: 'ship-note',
    content: 'Production releases roll out via LaunchAgent restart script.',
    scope: 'project',
    project: 'loop',
    links: [{ target: stack.memory.id, relation: 'extends' }],
  });
  await store.update(stack.memory.id, {
    links: [{ target: deploy.memory.id, relation: 'relates' }],
  });

  // Concept synonym expansion: "tech stack" -> "Node.js 22 and TypeScript"
  const stackHits = await store.list({ query: 'tech stack' });
  assert.ok(stackHits.length >= 1);
  assert.equal(stackHits[0].key, 'primary-runtime');

  // Concept expansion: "answer style" -> "short and direct without emojis"
  const styleHits = await store.list({ query: 'answer style' });
  assert.ok(styleHits.some((m) => m.key === 'tone-rule'));

  // Typo / fuzzy trigram match: "typescrpt" -> "TypeScript"
  const typoHits = await store.list({ query: 'typescrpt' });
  assert.equal(typoHits[0]?.key, 'primary-runtime');

  // 1-hop graph neighbor recall: searching "typescript" also softly surfaces linked LaunchAgent note
  const linkedHits = searchMemories(await store.list(), 'typescript');
  assert.ok(linkedHits.some((m) => m.key === 'ship-note'));
});

test('Memory graph builds typed edges, detects cross-agent conflicts, cleans dangling links, and exports Markdown', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-mem-graph-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MemoryStore(dir);

  const a = await store.save({
    key: 'pkg-pnpm',
    content: 'Always use pnpm for Node packages in Loop.',
    scope: 'preference',
    project: 'loop',
    tags: ['tooling'],
    pinned: true,
    source: 'Claude Code',
    writtenBy: 'Claude Code',
  });
  const b = await store.save({
    key: 'pkg-npm',
    content: 'Prefer npm as default package manager.',
    scope: 'preference',
    source: 'Cursor',
    writtenBy: 'Cursor',
  });
  const c = await store.save({
    key: 'loop-ui',
    content: 'Loop dashboard uses vanilla ES modules and warm ivory styling.',
    scope: 'project',
    project: 'loop',
    tags: ['tooling', 'ui'],
    links: [{ target: a.memory.id, relation: 'extends' }],
    source: 'Manual',
  });

  // Secrets inside links are blocked
  await assert.rejects(
    () => store.update(c.memory.id, { links: [{ target: 'sk-proj-abcdefghijklmnopqrstuvwxyz1234', relation: 'relates' }] }),
    (err) => err.status === 400 && err.code === 'SECRET_IN_MEMORY',
  );

  const graph = buildMemoryGraph(await store.list());
  assert.equal(graph.nodes.length, 3);
  assert.ok(graph.edges.some((e) => e.kind === 'link' && e.relation === 'extends'));
  assert.ok(graph.edges.some((e) => e.kind === 'project' && e.label === 'loop'));
  assert.ok(graph.edges.some((e) => e.kind === 'tag' && e.label === '#tooling'));
  assert.ok(
    graph.conflicts.some(
      (cf) => (cf.a === a.memory.id && cf.b === b.memory.id) || (cf.a === b.memory.id && cf.b === a.memory.id),
    ),
    'pnpm vs npm preference clash should be flagged',
  );

  // Markdown export includes Startup context and scopes
  const md = exportMemoriesMarkdown(await store.list());
  assert.match(md, /## Startup context \(Pinned\)/);
  assert.match(md, /Always use pnpm/);
  assert.match(md, /## Projects/);

  // Removing a memory cleans dangling links on remaining memories
  assert.equal(await store.remove(a.memory.id), true);
  const cAfter = await store.get(c.memory.id);
  assert.deepEqual(cAfter.links, []);
});

test('Watched local Markdown folders, Windsurf/Gemini/OpenCode discovery, and folder path guardrails', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'loop-mem-folders-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const notesDir = path.join(home, 'Notes', 'AgentBrain');

  await mkdir(path.join(home, '.codeium', 'windsurf', 'memories'), { recursive: true });
  await mkdir(path.join(home, '.gemini'), { recursive: true });
  await mkdir(path.join(home, '.config', 'opencode'), { recursive: true });
  await mkdir(notesDir, { recursive: true });

  await writeFile(
    path.join(home, '.codeium', 'windsurf', 'memories', 'global_rules.md'),
    '- Keep pull requests small and focused.\n',
  );
  await writeFile(path.join(home, '.gemini', 'GEMINI.md'), '- Prefer vanilla JS over heavy frameworks.\n');
  await writeFile(path.join(home, '.config', 'opencode', 'AGENTS.md'), '- Always run unit tests before committing.\n');
  await writeFile(
    path.join(notesDir, 'preferences.md'),
    '---\nname: design-taste\ndescription: Warm editorial UI style\ntype: feedback\ntags: [design, ui]\n---\nFavor calm ivory surfaces and clear hierarchy.\n',
  );
  await mkdir(path.join(home, '.openclaw', 'workspace'), { recursive: true });
  await writeFile(
    path.join(home, '.openclaw', 'workspace', 'MEMORY.md'),
    '- OpenClaw runs automated daily research briefings.\n',
  );
  await mkdir(path.join(home, 'Documents', 'Cline', 'Rules'), { recursive: true });
  await writeFile(
    path.join(home, 'Documents', 'Cline', 'Rules', 'rules.md'),
    '- Keep commits atomic and descriptive.\n',
  );
  await mkdir(path.join(home, '.mcp-memory'), { recursive: true });
  await writeFile(
    path.join(home, '.mcp-memory', 'memory.json'),
    `${JSON.stringify({ type: 'entity', name: 'Loop', entityType: 'project', observations: ['Runs locally on port 8799', 'sk-proj-abcdefghijklmnopqrstuvwxyz1234'] })}\n`,
  );

  // Dangerous folders rejected
  assert.throws(() => validateSyncFolder('/etc', { home, dataDir: data }), /system directory/i);
  assert.throws(() => validateSyncFolder('~/.ssh', { home, dataDir: data }), /sensitive directory/i);
  assert.throws(() => validateSyncFolder(home, { home, dataDir: data }), /subfolder/i);
  assert.throws(() => validateSyncFolder(data, { home, dataDir: data }), /own data folder/i);

  const memStore = new MemoryStore(data);
  const cfg = await memStore.updateConfig({ syncFolders: ['~/Notes/AgentBrain'] }, { home, allowSyncFolders: true });
  assert.deepEqual(cfg.syncFolders, [path.resolve(notesDir)]);

  // Personal workspaces cannot set watched folders
  await assert.rejects(
    () => memStore.updateConfig({ syncFolders: ['~/Notes/AgentBrain'] }, { home, allowSyncFolders: false }),
    (err) => err.status === 403,
  );

  const sources = await discoverMemorySources(memStore, { home, dataDir: data });
  const ids = sources.map((s) => s.id);
  assert.ok(ids.includes('windsurf'));
  assert.ok(ids.includes('gemini'));
  assert.ok(ids.includes('opencode'));
  assert.ok(ids.includes('openclaw'));
  assert.ok(ids.includes('cline'));
  assert.ok(ids.includes('mcp-memory'));
  assert.ok(ids.includes('folder-agentbrain'));
  const mcpMemSrc = sources.find((s) => s.id === 'mcp-memory');
  assert.equal(mcpMemSrc.items.length, 1, 'JSONL secrets must be filtered');
  assert.match(mcpMemSrc.items[0].content, /port 8799/);

  // JSONL paste import also works
  const pastedJsonl = parsePastedMemories(
    `${JSON.stringify({ type: 'entity', name: 'Editor', entityType: 'preference', observations: ['Prefers Zed for quick edits'] })}\n`,
    'MCP Memory',
  );
  assert.equal(pastedJsonl.length, 1);
  assert.match(pastedJsonl[0].content, /Zed/);
  const folderSrc = sources.find((s) => s.id === 'folder-agentbrain');
  assert.equal(folderSrc.kind, 'folder');
  assert.ok(folderSrc.items.some((i) => /Warm editorial UI style/.test(i.content)));
});

test('First-principles modes (local / external / off): anti-split-brain, live routing with policy respect, pull-external, and off suppression', async (t) => {
  // Spin up a tiny mock external Memory MCP server (Streamable HTTP JSON-RPC)
  let upstreamCalls = 0;
  const mockMemServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (body.method === 'initialize') {
        return res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock-supermemory', version: '1.0' } },
        }));
      }
      if (body.method === 'tools/list') {
        return res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              { name: 'search_memories', description: 'Search memories', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
              { name: 'read_graph', description: 'Read memory graph', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
              { name: 'add_memory', description: 'Add a memory', inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] }, annotations: { readOnlyHint: false, destructiveHint: false } },
            ],
          },
        }));
      }
      if (body.method === 'tools/call') {
        upstreamCalls += 1;
        const name = body.params?.name;
        if (name === 'read_graph') {
          return res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  entities: [
                    { name: 'Loop', entityType: 'project', observations: ['Shared local MCP hub on macOS'] },
                    { name: 'Leak', entityType: 'fact', observations: ['sk-proj-abcdefghijklmnopqrstuvwxyz1234'] },
                  ],
                }),
              }],
            },
          }));
        }
        return res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                results: [{ content: `External recall hit for "${body.params?.arguments?.query || ''}"`, scope: 'fact' }],
              }),
            }],
          },
        }));
      }
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, result: {} }));
    });
  });
  await new Promise((resolve) => mockMemServer.listen(0, '127.0.0.1', resolve));
  const mockPort = mockMemServer.address().port;

  const dataDir = await mkdtemp(path.join(tmpdir(), 'loop-mem-coexist-'));
  await writeFile(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      version: 2,
      settings: { defaultProfile: 'all', gatewayMode: 'auto', requireAgentToken: true, paused: false },
      agents: [],
      mcps: [
        {
          id: 'supermemory',
          name: 'Supermemory',
          transport: 'http',
          url: `http://127.0.0.1:${mockPort}/mcp`,
          enabled: true,
          profiles: ['all'],
          tools: [
            { name: 'search_memories', description: 'Search memories', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
            { name: 'read_graph', description: 'Read memory graph', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
            { name: 'add_memory', description: 'Add memory', inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] }, annotations: { readOnlyHint: false, destructiveHint: false } },
          ],
        },
      ],
    }, null, 2),
    'utf8',
  );
  const srv = await startServer({ port: 0, dataDir, detectLocalAgents: false, clerkApp });
  t.after(async () => {
    await srv.close();
    await new Promise((resolve) => mockMemServer.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${srv.port}`;

  // Unit checks for tool picking & extraction (with Secret Guard)
  const detected = detectExternalMemoryConnections([
    {
      id: 'supermemory',
      name: 'Supermemory',
      description: 'AI memory graph',
      enabled: true,
      tools: [
        { name: 'search_memories', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
        { name: 'add_memory', inputSchema: { type: 'object', properties: { content: { type: 'string' } } } },
      ],
    },
    { id: 'github', name: 'GitHub', description: 'Repos & PRs', enabled: true, tools: [{ name: 'list_issues' }] },
  ]);
  assert.deepEqual(detected.map((d) => d.id), ['supermemory']);
  const picked = pickExternalMemoryTools({
    tools: [
      { name: 'read_graph', inputSchema: { type: 'object', properties: {} } },
      { name: 'search_nodes', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'create_entities', inputSchema: { type: 'object', properties: {} } },
    ],
  });
  assert.equal(picked.listTool?.name, 'read_graph');
  assert.equal(picked.searchTool?.name, 'search_nodes');
  assert.equal(picked.saveTool?.name, 'create_entities');

  const extracted = extractMemoriesFromExternalResult(
    JSON.stringify({
      entities: [
        { name: 'Loop', entityType: 'project', observations: ['Shared local hub', 'sk-proj-abcdefghijklmnopqrstuvwxyz1234'] },
      ],
    }),
    'Supermemory',
  );
  assert.equal(extracted.length, 1);
  assert.match(extracted[0].content, /Shared local hub/);

  const agentRes = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Fixture-Auth': 'user_A' },
    body: JSON.stringify({ name: 'Claude', kind: 'claude-code', canManage: true, memoryAccess: 'read_write' }),
  });
  assert.equal(agentRes.status, 201);
  const claude = await agentRes.json();

  // Save a pinned Startup Context memory via REST
  const createRes = await fetch(`${base}/api/memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Fixture-Auth': 'user_A' },
    body: JSON.stringify({
      content: 'Always lead with the conclusion.',
      scope: 'preference',
      tags: ['style'],
      pinned: true,
    }),
  });
  assert.equal(createRes.status, 201);

  // Dismissing an auto-detected suggestion persists
  const dismissRes = await fetch(`${base}/api/memory/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Fixture-Auth': 'user_A' },
    body: JSON.stringify({ dismissedExternalIds: ['supermemory'] }),
  });
  assert.equal(dismissRes.status, 200);
  assert.deepEqual((await dismissRes.json()).config.dismissedExternalIds, ['supermemory']);

  // Unknown external connection rejected
  const badCfg = await fetch(`${base}/api/memory/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Fixture-Auth': 'user_A' },
    body: JSON.stringify({ mode: 'external', externalConnectionId: 'nonexistent' }),
  });
  assert.equal(badCfg.status, 400);

  // Legacy 'hybrid' maps cleanly to single-source 'external' mode
  const okCfg = await fetch(`${base}/api/memory/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Fixture-Auth': 'user_A' },
    body: JSON.stringify({ mode: 'hybrid', externalConnectionId: 'supermemory' }),
  });
  assert.equal(okCfg.status, 200);
  assert.equal((await okCfg.json()).config.mode, 'external');

  // Personal workspace (user_B) blocked from setting syncFolders
  const personalFolders = await fetch(`${base}/api/memory/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Fixture-Auth': 'user_B' },
    body: JSON.stringify({ syncFolders: ['~/Notes'] }),
  });
  assert.equal(personalFolders.status, 403);

  // GET /api/memory, /api/memory/graph, /api/memory/export, and POST /api/memory/pull-external
  const memGet = await (await fetch(`${base}/api/memory`, { headers: { 'X-Fixture-Auth': 'user_A' } })).json();
  assert.equal(memGet.graph.nodes.length, 1);
  assert.equal(memGet.config.mode, 'external');
  assert.equal(memGet.externalStatus?.state, 'ready');
  assert.ok(memGet.externalCandidates.some((c) => c.id === 'supermemory'));

  const graphRes = await fetch(`${base}/api/memory/graph`, { headers: { 'X-Fixture-Auth': 'user_A' } });
  assert.equal(graphRes.status, 200);
  assert.equal((await graphRes.json()).graph.nodes.length, 1);

  const exportRes = await fetch(`${base}/api/memory/export`, { headers: { 'X-Fixture-Auth': 'user_A' } });
  assert.equal(exportRes.status, 200);
  assert.match(exportRes.headers.get('content-type') || '', /text\/markdown/);
  assert.match(await exportRes.text(), /Always lead with the conclusion/);

  const pullRes = await fetch(`${base}/api/memory/pull-external`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Fixture-Auth': 'user_A' },
    body: JSON.stringify({ connectionId: 'supermemory' }),
  });
  assert.equal(pullRes.status, 200);
  const pulled = await pullRes.json();
  assert.equal(pulled.toolUsed, 'read_graph');
  assert.equal(pulled.items.length, 1, 'Secret observation must be filtered out');
  assert.match(pulled.items[0].content, /Shared local MCP hub/);

  const mcpCall = async (method, params = {}) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${claude.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    assert.equal(res.status, 200);
    return res.json();
  };

  // MCP initialize shows Startup Context + single external backend guidance
  const initExt = await mcpCall('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude', version: '1' },
  });
  assert.match(initExt.result.instructions, /Always lead with the conclusion/);
  assert.match(initExt.result.instructions, /single long-term memory store/);
  assert.match(initExt.result.instructions, /supermemory__add_memory/);

  // Live recall routes directly to Supermemory when policy is 'auto'
  const callsBeforeSearch = upstreamCalls;
  const searchRes = await mcpCall('tools/call', {
    name: 'loop__search',
    arguments: { type: 'memory', query: 'conclusion' },
  });
  const searchPayload = JSON.parse(searchRes.result.content[0].text);
  assert.equal(searchPayload.mode, 'external');
  assert.equal(searchPayload.externalMemory?.connectionId, 'supermemory');
  assert.equal(searchPayload.routedTo?.tool, 'supermemory__search_memories');
  assert.ok(upstreamCalls > callsBeforeSearch);

  // If user marks Supermemory policy as 'always_ask', loop__search does NOT bypass approval
  await fetch(`${base}/api/policies`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Fixture-Auth': 'user_A' },
    body: JSON.stringify({ connections: { supermemory: 'always_ask' } }),
  });
  const callsBeforePolicy = upstreamCalls;
  const searchBlocked = await mcpCall('tools/call', {
    name: 'loop__search',
    arguments: { type: 'memory', query: 'conclusion' },
  });
  const blockedPayload = JSON.parse(searchBlocked.result.content[0].text);
  assert.equal(blockedPayload.routedTo, undefined, 'Must not auto-route when connection policy is always_ask');
  assert.equal(upstreamCalls, callsBeforePolicy);

  // Anti-split-brain: non-pinned loop__save redirects to Supermemory instead of writing locally
  const splitAttempt = await mcpCall('tools/call', {
    name: 'loop__save',
    arguments: { type: 'memory', data: { content: 'Non-pinned fact that should not split-brain' } },
  });
  assert.equal(splitAttempt.result.isError, true);
  assert.match(splitAttempt.result.content[0].text, /split-brain/i);
  assert.match(splitAttempt.result.content[0].text, /supermemory__add_memory/);

  // Explicit pinned: true Startup Context card IS allowed in external mode
  const pinAllowed = await mcpCall('tools/call', {
    name: 'loop__save',
    arguments: { type: 'memory', data: { content: 'Keep answers terse.', scope: 'preference', pinned: true } },
  });
  assert.equal(Boolean(pinAllowed.result.isError), false);

  // Secret Guard & memoryAccess enforced even when writing directly via loop__run to external Memory backend!
  const readOnlyRes = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Fixture-Auth': 'user_A' },
    body: JSON.stringify({ name: 'ReadOnlyBot', kind: 'other', canManage: false, memoryAccess: 'read' }),
  });
  assert.equal(readOnlyRes.status, 201);
  const readOnlyBot = await readOnlyRes.json();

  // Restore auto policy so we specifically test Secret Guard & memoryAccess on external writes
  await fetch(`${base}/api/policies`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Fixture-Auth': 'user_A' },
    body: JSON.stringify({ connections: { supermemory: 'auto' } }),
  });

  const callsBeforeSecret = upstreamCalls;
  const secretExtWrite = await mcpCall('tools/call', {
    name: 'loop__run',
    arguments: {
      tool: 'supermemory__add_memory',
      arguments: { content: 'Store my OpenAI key sk-proj-abcdefghijklmnopqrstuvwxyz1234' },
    },
  });
  assert.equal(secretExtWrite.result.isError, true);
  assert.match(secretExtWrite.result.content[0].text, /Secret Guard/i);
  assert.equal(upstreamCalls, callsBeforeSecret, 'Secret must never leave Loop to external memory');

  // Read-only agent cannot write to external Memory backend either
  const roWriteRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readOnlyBot.token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'loop__run',
        arguments: { tool: 'supermemory__add_memory', arguments: { content: 'Unauthorized write attempt' } },
      },
    }),
  });
  const roWritePayload = await roWriteRes.json();
  assert.equal(roWritePayload.result.isError, true);
  assert.match(roWritePayload.result.content[0].text, /permission to write/i);
  assert.equal(upstreamCalls, callsBeforeSecret);

  // Legitimate non-secret write from read_write agent succeeds and reaches external backend
  const okExtWrite = await mcpCall('tools/call', {
    name: 'loop__run',
    arguments: {
      tool: 'supermemory__add_memory',
      arguments: { content: 'User prefers dark roast espresso.' },
    },
  });
  assert.equal(Boolean(okExtWrite.result.isError), false);
  assert.equal(upstreamCalls, callsBeforeSecret + 1);

  // Disabling the external connection surfaces externalStatus.state === 'disabled'
  const disableRes = await fetch(`${base}/api/mcps/supermemory`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Fixture-Auth': 'user_A' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disableRes.status, 200);
  const memDisabled = await (await fetch(`${base}/api/memory`, { headers: { 'X-Fixture-Auth': 'user_A' } })).json();
  assert.equal(memDisabled.externalStatus?.state, 'disabled');

  // Mode 'off': completely suppresses memory instructions, search, and save
  const offRes = await fetch(`${base}/api/memory/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Fixture-Auth': 'user_A' },
    body: JSON.stringify({ mode: 'off', externalConnectionId: '' }),
  });
  assert.equal(offRes.status, 200);

  const initOff = await mcpCall('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude', version: '1' },
  });
  assert.doesNotMatch(initOff.result.instructions, /Always lead with the conclusion/);
  assert.doesNotMatch(initOff.result.instructions, /Shared Memory in Loop/);

  const searchOff = await mcpCall('tools/call', {
    name: 'loop__search',
    arguments: { type: 'memory', query: 'conclusion' },
  });
  const offPayload = JSON.parse(searchOff.result.content[0].text);
  assert.equal(offPayload.disabled, true);
  assert.equal(offPayload.total, 0);

  const saveOff = await mcpCall('tools/call', {
    name: 'loop__save',
    arguments: { type: 'memory', data: { content: 'Should be rejected while off' } },
  });
  assert.equal(saveOff.result.isError, true);
  assert.match(saveOff.result.content[0].text, /turned off/i);
});
