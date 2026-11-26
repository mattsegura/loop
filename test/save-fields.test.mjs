// What an agent hears from loop__save: a field that Loop does not keep is refused by name, the tool
// text and the check say the same thing, and a project takes a working folder that the owner confirms.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server.mjs';
import { callBuiltinTool } from '../lib/builtin-web.mjs';
import { buildDoctorReport, DreamStore } from '../lib/dream.mjs';
import { validateSavedCardSpec } from '../lib/json-render-ui.mjs';
import { HygieneQueue } from '../lib/memory-hygiene.mjs';
import { projectNames } from '../lib/profiles.mjs';
import { checkedActions, saveDataText, shownFields, unknownSaveFields } from '../lib/save-fields.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOWN_TYPES = ['connection', 'skill', 'project', 'agent', 'memory', 'task', 'saved', 'schedule', 'file', 'dream', 'api_key', 'category', 'feedback'];

/* ---------------- the table ---------------- */

test('a field that Loop does not keep is named, with the fields that it takes', () => {
  const task = { expectedRevision: 0, title: 'Deploy', objective: 'o', notes: 'n', nextStep: 's', sources: [] };
  assert.equal(unknownSaveFields('task', task), null);

  const refused = unknownSaveFields('task', { ...task, priority: 'high', dueDate: '2026-12-01' });
  assert.match(refused, /^Loop does not keep "priority", "dueDate" for a task, so nothing was saved\./);
  assert.match(refused, /sources\?: \[\{ reference, observation\?, observedAt\? \}\]/);
  assert.match(refused, /Put other details in notes\.$/);

  const nested = unknownSaveFields('task', { ...task, sources: [{ reference: 'https://example.com' }, { reference: 'x', label: 'Docs', url: 'y' }] });
  assert.equal(nested, 'Loop does not keep "label", "url" in data.sources[1], so nothing was saved. It takes { reference, observation?, observedAt? }.');

  // A wrong name in a tool entry must not turn into "the whole Connection".
  assert.match(
    unknownSaveFields('project', { tools: [{ connection: 'gmail', tool: 'send' }] }, 'add_tools'),
    /does not keep "connection", "tool" in data\.tools\[0\], so nothing was done\. It takes \{ connectionId, toolName\? \}\./,
  );
  // Action-specific fields are refused on the wrong action and name the right one.
  assert.match(
    unknownSaveFields('project', { name: 'Atlas', connections: ['gmail'] }, 'save'),
    /does not keep "connections" for a project, so nothing was saved\. Use action "add_tools" for "connections"\./,
  );
  assert.match(
    unknownSaveFields('project', { name: 'Atlas', kind: 'other' }, 'save'),
    /Use action "invite" for "kind"\./,
  );
  assert.match(
    unknownSaveFields('connection', { name: 'X', url: 'https://x.test', waitForSignIn: true }, 'save'),
    /Use action "sync" for "waitForSignIn"\./,
  );
  assert.equal(unknownSaveFields('connection', { waitForSignIn: true }, 'sync'), null);
  assert.match(
    unknownSaveFields('dream', { remember: 'fact', enabled: false }, 'save'),
    /Cannot mix dream remember and settings fields in one call, so nothing was saved\./,
  );
  assert.equal(unknownSaveFields('dream', { enabled: true, triggerMode: 'both' }, 'save'), null);
  assert.equal(unknownSaveFields('dream', { run: true, dryRun: true }, 'save'), null);
  assert.match(unknownSaveFields('memory', { content: 'x', reason: 'old' }, 'delete'), /so nothing was done\. Pass id or ids instead of data\./);
});

test('the old names still work, and a type with its own check is left to it', () => {
  assert.equal(unknownSaveFields('profile', { name: 'Work', description: 'd' }), null);
  assert.equal(unknownSaveFields('skill', { name: 'a', description: 'b', content: 'c', profiles: ['work'] }), null);
  assert.equal(unknownSaveFields('skill', { name: 'a', description: 'b', content: 'c', projects: ['work'] }), null);
  assert.equal(unknownSaveFields('login', { key: 'k', value: 'v', description: 'd', username: 'u' }), null);
  assert.match(unknownSaveFields('note', { key: 'k', value: 'v', colour: 'red' }), /for a Vault item/);
  assert.equal(unknownSaveFields('category', { anything: 1 }), null);
  assert.equal(unknownSaveFields('no-such-type', { anything: 1 }), null);
  assert.equal(unknownSaveFields('task', 'not an object'), null);
});

test('every field in the tool text passes the check, so the text and the check cannot differ', () => {
  for (const type of SHOWN_TYPES) {
    const allShown = shownFields(type);
    assert.ok(allShown.length > 0, type);
    const text = saveDataText([type === 'api_key' ? 'vault' : type]);
    for (const name of allShown) assert.ok(text.includes(name), `${type}.${name} is in the tool text`);
    for (const action of checkedActions(type)) {
      const fields = shownFields(type, action);
      if (fields.length === 0) continue;
      if (type === 'dream') {
        for (const name of fields) assert.equal(unknownSaveFields(type, { [name]: 1 }, action), null, `${type}.${action}.${name}`);
      } else {
        assert.equal(unknownSaveFields(type, Object.fromEntries(fields.map((name) => [name, 1])), action), null, `${type}.${action}`);
      }
    }
  }
});

// The body of a function that starts at column 0, up to the brace that closes it.
function functionBody(source, start) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `"${start}" exists`);
  const end = source.indexOf('\n}\n', from);
  return source.slice(from, end);
}

test('every data field that the save code reads is a field that the check lets through', async () => {
  const read = async (file) => readFile(path.join(ROOT, file), 'utf8');
  const bodies = [
    functionBody(await read('lib/mcp-server.mjs'), 'async function handleSave({'),
    functionBody(await read('lib/mcp/workspace-tools-handlers.mjs'), 'export async function handleWorkspaceSave({'),
    functionBody(await read('lib/mcp/core-loop-handlers.mjs'), 'export async function handleCoreLoopSave({'),
  ];
  const names = new Set();
  for (const body of bodies) {
    // Text in a message for the agent is not a read.
    const code = body.replace(/\(data\.\w+\)/g, '');
    for (const found of code.matchAll(/\b(?:data|cleanData)\??\.([A-Za-z_]\w*)/g)) names.add(found[1]);
  }
  assert.ok(names.size > 40, 'the scan found the reads');
  const checked = SHOWN_TYPES.filter((type) => type !== 'category');
  const categoryFields = new Set([...shownFields('category'), 'reason']);
  const unknown = [...names].filter((name) =>
    !categoryFields.has(name) &&
    checked.every((type) => checkedActions(type).every((action) => unknownSaveFields(type, { [name]: 1 }, action) !== null)));
  // A file reads `text` only to tell two uploads apart; its store takes `content`.
  assert.deepEqual(unknown.filter((name) => name !== 'text'), [], 'add the field to lib/save-fields.mjs');

  // These stores get the whole `data`, so what they read from it is what the type takes.
  for (const [type, file] of [['saved', 'lib/saved.mjs'], ['schedule', 'lib/schedules.mjs'], ['file', 'lib/files.mjs'], ['task', 'lib/tasks.mjs']]) {
    const reads = new Set([...(await read(file)).matchAll(/\binput\??\.([A-Za-z_]\w*)/g)].map((found) => found[1]));
    assert.ok(reads.size >= 8, `${file}: the scan found the reads`);
    // Only an upload from a page of Loop carries a Buffer.
    const missing = [...reads].filter((name) => name !== 'buffer' && unknownSaveFields(type, { [name]: 1 }) !== null);
    assert.deepEqual(missing, [], `${file} reads a field that lib/save-fields.mjs does not list for a ${type}`);
  }
});

/* ---------------- the examples that agents copy ---------------- */

// The top-level names of an object literal as an example writes it: { a, "b": 1, c?: [..] }.
function exampleKeys(literal) {
  const keys = [];
  let depth = 0;
  let start = 0;
  const inner = literal.slice(1, -1);
  const parts = [];
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if ('{[('.includes(ch)) depth += 1;
    else if ('}])'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1; }
  }
  parts.push(inner.slice(start));
  for (const part of parts) {
    // `name: value` is one field. `a | b` and `a?|b?` with no value are fields that stand for each other.
    const named = /^\s*["']?([A-Za-z_]\w*)["']?\??\s*:/.exec(part);
    const names = named ? [named[1]] : part.split('|').map((name) => name.trim().replace(/^["']|["']$|\?$/g, ''));
    for (const name of names) if (/^[A-Za-z_]\w*$/.test(name)) keys.push(name);
  }
  return keys;
}

function balanced(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(open, i + 1); }
  }
  return null;
}

test('every loop__save example in the skills and in the answers of Loop uses fields that Loop keeps', async () => {
  const files = [];
  for (const dir of await readdir(path.join(ROOT, 'skills'))) files.push(path.join('skills', dir, 'SKILL.md'));
  for (const name of await readdir(path.join(ROOT, 'lib'))) if (name.endsWith('.mjs')) files.push(path.join('lib', name));
  let seen = 0;
  for (const file of files) {
    const text = await readFile(path.join(ROOT, file), 'utf8').catch(() => '');
    for (const call of text.matchAll(/loop__save\(\{/g)) {
      const literal = balanced(text, call.index + 'loop__save('.length);
      if (!literal) continue;
      const dataAt = literal.search(/["']?data["']?\s*:\s*\{/);
      const data = dataAt === -1 ? null : balanced(literal, literal.indexOf('{', dataAt));
      if (!data || data.includes('${')) continue;
      const outside = literal.replace(data, '{}');
      const type = /["']?type["']?\s*:\s*["'](\w+)["']/.exec(outside)?.[1];
      const action = /["']?action["']?\s*:\s*["'](\w+)["']/.exec(outside)?.[1] || 'save';
      if (!type || action === 'capture') continue;
      const keys = exampleKeys(data);
      seen += 1;
      assert.equal(unknownSaveFields(type, Object.fromEntries(keys.map((key) => [key, 1])), action), null, `${file}: ${literal.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
  assert.ok(seen >= 15, `the scan found the examples (${seen})`);
});

/* ---------------- the words of other answers ---------------- */

test('the health check counts in correct words', () => {
  const long = { id: 'mem_1', key: 'long', content: 'word '.repeat(150), scope: 'global' };
  const report = buildDoctorReport({ memories: [long], skills: [{ id: 'one', name: 'one' }], turns: [] });
  const oversized = report.findings.find((f) => /600 characters/.test(f.message));
  assert.match(oversized.message, /^1 memory item exceeds 600 characters/);

  const healthy = buildDoctorReport({ memories: [{ id: 'mem_2', key: 'k', content: 'The office is in Lisbon.', scope: 'global' }], skills: [{ id: 'one', name: 'one' }], turns: [{}] });
  assert.equal(healthy.healthy, true, healthy.summaryText);
  assert.match(healthy.summaryText, /\(1 memory, 0 pinned, 1 custom skill, 1 recent turn\)/);
  const two = buildDoctorReport({ memories: [long, { ...long, id: 'mem_3', key: 'long-2', content: 'other '.repeat(150) }], skills: [], turns: [] });
  assert.ok(two.findings.some((f) => /^2 memory items exceed 600 characters/.test(f.message)));
});

test('the dream status says why background review does not run', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-dream-status-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const offOnServer = await new DreamStore(dir, { enabled: false }).summary();
  assert.equal(offOnServer.active, false);
  assert.match(offOnServer.inactiveReason, /off on this Loop server/);
  const on = await new DreamStore(dir, { enabled: true }).summary();
  assert.equal(on.active, on.enabled);
  if (on.active) assert.equal(on.inactiveReason, undefined);
  else assert.match(on.inactiveReason, /turned off for this workspace/);
});

test('a card in a wrong shape gets the right shape back', () => {
  const nested = validateSavedCardSpec({ type: 'Card', props: { title: 'Ops' }, children: [{ type: 'Text', props: { text: 'hello' } }] });
  assert.equal(nested.valid, false);
  assert.match(nested.errors[0], /ui is a flat json-render card: \{ root: "<element id>", elements:/);
  const example = /For example (\{.*\})\.$/.exec(nested.errors[0])[1];
  assert.equal(validateSavedCardSpec(JSON.parse(example)).valid, true, 'the example in the message is a card that Loop takes');
});

/* ---------------- memory checks that run at the same time ---------------- */

test('the check of one saved memory does not wait for the check of another', async () => {
  const queue = new HygieneQueue();
  const order = [];
  const gate = () => { let open; const wait = new Promise((resolve) => { open = resolve; }); return { wait, open }; };
  const first = gate();
  const second = gate();
  const a = queue.saveCheck(async () => { order.push('a starts'); await first.wait; order.push('a ends'); return 'a'; });
  const b = queue.saveCheck(async () => { order.push('b starts'); await second.wait; order.push('b ends'); return 'b'; });
  // A pass that reads the whole cache waits for both.
  const pass = queue.pass(async () => { order.push('pass runs'); });
  // A check that comes after the pass waits for the pass.
  const c = queue.saveCheck(async () => { order.push('c runs'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['a starts', 'b starts']);
  second.open();
  assert.equal(await b, 'b');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['a starts', 'b starts', 'b ends']);
  first.open();
  await Promise.all([a, pass, c]);
  assert.deepEqual(order, ['a starts', 'b starts', 'b ends', 'a ends', 'pass runs', 'c runs']);

  // A check that fails does not stop what comes after it.
  await assert.rejects(queue.saveCheck(async () => { throw new Error('no'); }));
  let ran = false;
  await queue.pass(async () => { ran = true; });
  assert.equal(ran, true);
});

/* ---------------- through MCP ---------------- */

function request(port, route, { method, headers = {}, body } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: route, method: method || (payload === null ? 'GET' : 'POST'),
      headers: { ...(payload === null ? {} : { 'Content-Type': 'application/json' }), Accept: 'application/json, text/event-stream', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function localLoop(t, options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'loop-save-fields-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const srv = await startServer({ port: 0, dataDir: path.join(home, 'data'), home, authMode: 'local-test', detectLocalAgents: false, autoSync: false, ...options });
  t.after(() => srv.close());
  const setup = await request(srv.port, '/api/auth/setup', { body: { password: 'test-password-1234' } });
  const cookie = String(setup.headers['set-cookie']).split(';')[0];
  const api = (route, opts = {}) => request(srv.port, route, { ...opts, headers: { Cookie: cookie, ...opts.headers } });
  const agent = async (fields = {}) => {
    const made = await api('/api/agents', { body: { name: 'Agent', kind: 'other', profile: 'all', canManage: true, memoryAccess: 'read_write', ...fields } });
    assert.equal(made.status, 201, made.text);
    const auth = { Authorization: `Bearer ${made.json.token}` };
    const init = await request(srv.port, '/mcp', {
      headers: auth,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.332' } } },
    });
    const rpc = async (method, params, headers = {}) => (await request(srv.port, '/mcp', {
      headers: { ...auth, 'Mcp-Session-Id': init.headers['mcp-session-id'], ...headers }, body: { jsonrpc: '2.0', id: 2, method, params },
    })).json;
    const call = async (name, args, headers) => {
      const { result, error } = await rpc('tools/call', { name, arguments: args }, headers);
      const text = error ? error.message : result.content[0].text;
      let json = null;
      try { json = JSON.parse(text); } catch { /* a sentence */ }
      return { text, json, isError: Boolean(error || result.isError) };
    };
    return { call, tools: async () => (await rpc('tools/list')).result.tools };
  };
  return { srv, home, api, agent };
}

test('the tool says "project" and shows the shape of every nested field', async (t) => {
  const loop = await localLoop(t);
  const agent = await loop.agent();
  const tools = await agent.tools();
  const save = tools.find((tool) => tool.name === 'loop__save');
  const search = tools.find((tool) => tool.name === 'loop__search');
  assert.ok(save.inputSchema.properties.type.enum.includes('project'));
  assert.ok(!save.inputSchema.properties.type.enum.includes('profile'));
  assert.ok(save.inputSchema.properties.items);
  assert.ok(!search.inputSchema.properties.type.enum.includes('profiles'));
  assert.ok(!/profile/i.test(save.description), save.description);

  // Loop Text (imessage) keeps the legacy "profile" enum alias so its harness does not reject old prompts.
  const smsAgent = await loop.agent({ name: 'Loop Text', kind: 'imessage' });
  const smsSave = (await smsAgent.tools()).find((tool) => tool.name === 'loop__save');
  assert.ok(smsSave.inputSchema.properties.type.enum.includes('profile'));

  const data = save.inputSchema.properties.data.description;
  for (const shape of [
    'sources?: [{ reference, observation?, observedAt? }]',
    'repositoryUrl?',
    'workingDirectory?',
    'tools?: [{ connectionId, toolName? }]',
    'saved { url?, title?, note?',
    'one of url, note, markdown or ui is enough',
    'schedule { title, message?',
    'file { name, content?, contentBase64?',
    'memory { content, key?, scope?, projects?, project?',
    'projects: the ids of the Loop projects that the memory is in; project is only a label',
  ]) assert.ok(data.includes(shape), shape);
  assert.match(save.inputSchema.properties.action.description, /data\.connections: \["<connection_id>"\]/);

  // An agent that can only use memory gets the same shapes for what it can save.
  const memoryOnly = await loop.agent({ name: 'Notes only', canManage: false });
  const memorySave = (await memoryOnly.tools()).find((tool) => tool.name === 'loop__save');
  assert.ok(memorySave.inputSchema.properties.data.description.includes('sources?: [{ reference, observation?, observedAt? }]'));
});

test('a refused save writes nothing, and the answer names what to change', async (t) => {
  const loop = await localLoop(t);
  const agent = await loop.agent();
  const task = { expectedRevision: 0, title: 'Deploy check', objective: 'o', notes: 'n', nextStep: 's' };

  const extra = await agent.call('loop__save', { type: 'task', data: { ...task, sources: [], priority: 'high' } });
  assert.equal(extra.isError, true);
  assert.match(extra.text, /Loop does not keep "priority" for a task, so nothing was saved/);

  const label = await agent.call('loop__save', { type: 'task', data: { ...task, sources: [{ reference: 'https://example.com/a', observation: 'seen', label: 'Docs' }] } });
  assert.equal(label.isError, true);
  assert.match(label.text, /does not keep "label" in data\.sources\[0\]/);

  const noReference = await agent.call('loop__save', { type: 'task', data: { ...task, sources: [{ observation: 'seen' }] } });
  assert.equal(noReference.isError, true);
  assert.match(noReference.text, /Each source is \{ reference, observation\? \}: reference is where you looked/);
  assert.equal((await agent.call('loop__search', { type: 'tasks' })).json.tasks.length, 0);

  // A source given as plain text is its reference.
  const plain = await agent.call('loop__save', { type: 'task', data: { ...task, sources: ['https://example.com/a'] } });
  assert.equal(plain.isError, false, plain.text);
  assert.equal(plain.json.task.sources[0].reference, 'https://example.com/a');

  for (const [type, data, rows] of [
    ['memory', { content: 'The brand colour is blue.', importance: 5 }, 'memories'],
    ['saved', { title: 'A note', note: 'text', colour: 'red' }, 'items'],
    ['file', { name: 'notes.md', content: '# notes', folder: 'docs' }, 'files'],
  ]) {
    const refused = await agent.call('loop__save', { type, data });
    assert.equal(refused.isError, true, type);
    assert.match(refused.text, /^Loop does not keep "\w+" for a /, type);
    const found = await agent.call('loop__search', { type: type === 'file' ? 'files' : type });
    assert.equal(found.json[rows].length, 0, `${type}: ${found.text}`);
  }

  // A card and a note need no url.
  const card = await agent.call('loop__save', { type: 'saved', data: { kind: 'artifact', title: 'Ops', ui: { root: 'card', elements: { card: { type: 'Card', props: { title: 'Ops' } } } } } });
  assert.equal(card.isError, false, card.text);
});

test('a memory that is too long is refused whole and not cut', async (t) => {
  const loop = await localLoop(t);
  const agent = await loop.agent();
  const long = await agent.call('loop__save', { type: 'memory', data: { content: `Deploy notes. ${'The deploy runs after the check. '.repeat(40)}` } });
  assert.equal(long.isError, true);
  assert.match(long.text, /A memory holds at most 1000 characters and this one has \d+, so nothing was saved\..*type "saved" \(data\.markdown\) or type "file"/);
  assert.equal((await agent.call('loop__search', { type: 'memory' })).json.memories.length, 0);

  const fits = await agent.call('loop__save', { type: 'memory', data: { content: 'x'.repeat(1000) } });
  assert.equal(fits.isError, false, fits.text);
  assert.equal(fits.json.memory.content.length, 1000);
});

test('a project takes a working folder after the owner confirms it', async (t) => {
  const loop = await localLoop(t);
  const agent = await loop.agent();
  const checkout = path.join(loop.home, 'checkout');
  await mkdir(checkout);
  const folder = await realpath(checkout);
  const args = { type: 'project', data: { name: 'atlas', description: 'Ops', workingDirectory: checkout } };

  const asked = await agent.call('loop__save', args);
  assert.equal(asked.json.status, 'approval_required', asked.text);
  assert.ok(asked.json.title.includes(folder));
  assert.equal((await agent.call('loop__search', { type: 'projects' })).json.projects.length, 0, 'nothing exists before the owner answers');

  // Another folder with the same approval is refused.
  const other = path.join(loop.home, 'other');
  await mkdir(other);
  const decided = await loop.api(`/api/approvals/${asked.json.approvalId}/decide`, { body: { decision: 'approve' } });
  assert.equal(decided.status, 200, decided.text);
  const swapped = await agent.call('loop__save', { ...args, data: { ...args.data, workingDirectory: other }, approvalId: asked.json.approvalId });
  assert.equal(swapped.isError, true, swapped.text);
  assert.equal((await agent.call('loop__search', { type: 'projects' })).json.projects.length, 0);

  const saved = await agent.call('loop__save', { ...args, approvalId: asked.json.approvalId });
  assert.equal(saved.isError, false, saved.text);
  assert.equal(saved.json.saved, true);
  assert.equal(saved.json.workingDirectory, folder);
  assert.equal(saved.json.folderStatus, 'available');

  const entered = await agent.call('loop__save', { type: 'project', action: 'enter', id: 'atlas' });
  assert.equal(entered.json.workingDirectory, folder);
  assert.equal(entered.json.folderStatus, 'available');
  assert.equal(entered.json.activeProject, 'atlas');
  assert.equal('activeProfile' in entered.json, false);
  const status = await agent.call('loop__inspect', { type: 'project' });
  assert.equal(status.json.workingDirectory, folder);
  assert.equal('activeProfile' in status.json, false);

  // A later save with the folder that the project has asks nobody: nothing changes.
  const again = await agent.call('loop__save', { type: 'project', id: 'atlas', data: { name: 'atlas', description: 'Operations', workingDirectory: checkout } });
  assert.equal(again.isError, false, again.text);
  assert.equal(again.json.saved, true, again.text);
  assert.equal(again.json.workingDirectory, folder);
  assert.equal(again.json.folderStatus, 'available');
  assert.deepEqual((await loop.api('/api/approvals')).json.pending, []);
  // A change of the folder asks again, and the project keeps its folder until the owner answers.
  const moved = await agent.call('loop__save', { type: 'project', id: 'atlas', data: { name: 'atlas', workingDirectory: other } });
  assert.equal(moved.json.status, 'approval_required', moved.text);
  assert.ok(moved.json.title.includes(await realpath(other)));
  assert.equal((await loop.api('/api/approvals')).json.pending.length, 1);
  assert.equal((await agent.call('loop__inspect', { type: 'project' })).json.workingDirectory, folder);
});

test('a folder that cannot be used is refused before anything is saved', async (t) => {
  const loop = await localLoop(t);
  const agent = await loop.agent();
  const none = async () => (await agent.call('loop__search', { type: 'projects' })).json.projects.length;

  const missing = await agent.call('loop__save', { type: 'project', data: { name: 'ghost', workingDirectory: path.join(loop.home, 'no-such-folder') } });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /must be a folder that exists on the computer that runs Loop/);
  const relative = await agent.call('loop__save', { type: 'project', data: { name: 'ghost', workingDirectory: 'checkout' } });
  assert.match(relative.text, /must be a folder that exists/);
  const empty = await agent.call('loop__save', { type: 'project', data: { name: 'ghost', workingDirectory: '' } });
  assert.match(empty.text, /must be the path of a folder/);
  assert.equal(await none(), 0);

  // A session that comes through a proxy is not on the computer that runs Loop.
  const checkout = path.join(loop.home, 'checkout');
  await mkdir(checkout);
  const remote = await agent.call('loop__save', { type: 'project', data: { name: 'ghost', workingDirectory: checkout } }, { 'X-Forwarded-For': '203.0.113.9' });
  assert.equal(remote.isError, true, remote.text);
  assert.match(remote.text, /keeps a working folder only for an agent on the computer that runs Loop/);
  assert.equal(await none(), 0);

  // The owner says no: no project.
  const asked = await agent.call('loop__save', { type: 'project', data: { name: 'ghost', workingDirectory: checkout } });
  await loop.api(`/api/approvals/${asked.json.approvalId}/decide`, { body: { decision: 'deny' } });
  const denied = await agent.call('loop__save', { type: 'project', data: { name: 'ghost', workingDirectory: checkout }, approvalId: asked.json.approvalId });
  assert.equal(denied.json.status, 'approval_denied', denied.text);
  assert.equal(await none(), 0);

  // A project without a folder needs no question.
  const plain = await agent.call('loop__save', { type: 'project', data: { name: 'plain' } });
  assert.equal(plain.json.saved, true, plain.text);
  assert.equal('workingDirectory' in plain.json, false);
});

test('"projects" puts a skill and a memory in a project, and add_tools says what it needs', async (t) => {
  const loop = await localLoop(t, { seedBuiltins: true });
  const agent = await loop.agent();
  assert.equal((await agent.call('loop__save', { type: 'project', data: { name: 'work' } })).json.saved, true);

  const skill = await agent.call('loop__save', { type: 'skill', data: { name: 'deploy-steps', description: 'How to deploy the site', content: '# Deploy\n\n1. Run the check.', projects: ['work'] } });
  assert.equal(skill.isError, false, skill.text);
  assert.deepEqual(skill.json.skill.projects, ['work']);
  const memory = await agent.call('loop__save', { type: 'memory', data: { content: 'The work site deploys on Fridays.', projects: ['work'] } });
  assert.equal(memory.isError, false, memory.text);
  assert.deepEqual(memory.json.memory.projects, ['work']);
  assert.equal('notInProject' in memory.json, false);

  // "project" on a memory is only a label. When it names a project, the answer says how to put the memory there.
  const labelled = await agent.call('loop__save', { type: 'memory', data: { content: 'The work site uses a green theme.', project: 'Work' } });
  assert.equal(labelled.json.saved, true, labelled.text);
  assert.deepEqual(labelled.json.memory.projects, ['all']);
  assert.match(labelled.json.notInProject, /not in the project "work".*data\.projects: \["work"\]/);
  assert.equal((await agent.call('loop__search', { type: 'memory', project: 'work', query: 'green theme' })).json.total, 0);
  const placed = await agent.call('loop__save', { type: 'memory', id: labelled.json.memory.id, data: { content: 'The work site uses a green theme.', project: 'Work', projects: ['work'] } });
  assert.deepEqual(placed.json.memory.projects, ['work']);
  assert.equal('notInProject' in placed.json, false);
  assert.equal((await agent.call('loop__search', { type: 'memory', project: 'work', query: 'green theme' })).json.total, 1);
  // A label that is not the name of a project needs no note.
  const other = await agent.call('loop__save', { type: 'memory', data: { content: 'The billing code is in the payments repository.', project: 'payments-repo' } });
  assert.equal(other.json.saved, true, other.text);
  assert.equal('notInProject' in other.json, false);

  const noProject = await agent.call('loop__save', { type: 'project', action: 'add_tools', data: { connections: ['loop_web'] } });
  assert.equal(noProject.isError, true);
  assert.match(noProject.text, /add_tools needs a project: pass its id, or enter the project first/);

  const wrongKey = await agent.call('loop__save', { type: 'project', action: 'add_tools', id: 'work', data: { tools: [{ connection: 'loop_web', tool: 'web_search' }] } });
  assert.equal(wrongKey.isError, true);
  assert.match(wrongKey.text, /It takes \{ connectionId, toolName\? \}/);
  assert.deepEqual((await agent.call('loop__inspect', { type: 'project', id: 'work' })).json.project.connections, []);

  const whole = await agent.call('loop__save', { type: 'project', action: 'add_tools', id: 'work', data: { connections: ['loop_web'] } });
  assert.equal(whole.isError, false, whole.text);
  assert.equal(whole.json.connectionsAdded, 1);
});

/* ---------------- an app that has no Connection ---------------- */

test('an item for an agent has the new names only', () => {
  // The old name moves to the new name.
  assert.deepEqual(projectNames({ id: 'm1', profiles: ['work'] }), { id: 'm1', projects: ['work'] });
  assert.deepEqual(Object.keys(projectNames({ id: 'a1', profile: 'work', kind: 'other' })), ['id', 'project', 'kind']);
  // A store that gives both names keeps the value of the new name.
  assert.deepEqual(projectNames({ id: 't1', profile: 'all', project: null }), { id: 't1', project: null });
  assert.deepEqual(projectNames({ id: 's1', projects: ['work'], profiles: ['work'] }), { id: 's1', projects: ['work'] });
  // A memory keeps its own "project" label beside the projects it is in.
  assert.deepEqual(projectNames({ id: 'm2', project: 'site', profiles: ['work'] }), { id: 'm2', project: 'site', projects: ['work'] });
  // Only the item itself: what the user or another server wrote inside stays as it is.
  assert.deepEqual(projectNames({ id: 'c1', ui: { elements: { profile: { type: 'Card' } } } }), { id: 'c1', ui: { elements: { profile: { type: 'Card' } } } });
  for (const other of [null, undefined, 'text', 3, ['profiles']]) assert.equal(projectNames(other), other);
  // A field with the name of a built-in property is a field like any other.
  const odd = projectNames(JSON.parse('{"constructor":1,"toString":2,"__proto__":3,"profiles":["work"]}'));
  assert.deepEqual(Object.keys(odd), ['constructor', 'toString', '__proto__', 'projects']);
  assert.equal(Object.getPrototypeOf(odd), Object.prototype);
});

// The keys of an answer that hold the old word. A tool schema of another server is not Loop's text.
function oldWordKeys(value, at = '', found = []) {
  if (Array.isArray(value)) value.forEach((entry) => oldWordKeys(entry, `${at}[]`, found));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'inputSchema') continue;
      if (/profile/i.test(key)) found.push(`${at}.${key}`);
      oldWordKeys(entry, `${at}.${key}`, found);
    }
  }
  return found;
}

test('what an agent reads says "project", and only the old list type answers in the old word', async (t) => {
  const loop = await localLoop(t, { seedBuiltins: true, memoryHygieneEnv: {} });
  const agent = await loop.agent();
  const folder = await realpath(await mkdtemp(path.join(loop.home, 'checkout-')));
  const answers = new Map();
  // The owner approves what needs approval, so the check also reads the answer that asks.
  const call = async (label, name, args) => {
    let answer = await agent.call(name, args);
    const keys = oldWordKeys(answer.json);
    if (answer.json?.status === 'approval_required') {
      const decided = await loop.api(`/api/approvals/${answer.json.approvalId}/decide`, { body: { decision: 'approve' } });
      assert.equal(decided.status, 200, decided.text);
      answer = await agent.call(name, { ...args, approvalId: answer.json.approvalId });
      keys.push(...oldWordKeys(answer.json));
    }
    answers.set(label, keys);
    return answer;
  };
  const saved = async (label, args) => {
    const answer = await call(label, 'loop__save', args);
    assert.equal(answer.isError, false, `${label}: ${answer.text}`);
    return answer.json;
  };

  await saved('project', { type: 'project', data: { name: 'atlas', description: 'Atlas work', workingDirectory: folder } });
  await saved('enter', { type: 'project', action: 'enter', id: 'atlas' });
  await saved('add_tools', { type: 'project', action: 'add_tools', data: { connections: ['loop_web'] } });
  const memory = await saved('memory', { type: 'memory', data: { content: 'Atlas deploys on Fridays.', key: 'atlas-deploy' } });
  assert.deepEqual(memory.memory.projects, ['atlas']);
  const skill = await saved('skill', { type: 'skill', data: { name: 'atlas-deploy', description: 'How to deploy Atlas safely', content: '# Deploy\n\n1. Check.\n2. Deploy.' } });
  assert.deepEqual(skill.skill.projects, ['atlas']);
  const item = await saved('saved', { type: 'saved', data: { title: 'Atlas note', note: 'A note.' } });
  const schedule = await saved('schedule', { type: 'schedule', data: { title: 'Check Atlas', kind: 'daily', timeOfDay: '09:00' } });
  assert.deepEqual(schedule.schedule.projects, ['atlas']);
  const file = await saved('file', { type: 'file', data: { name: 'atlas.md', content: '# Atlas' } });
  const task = await saved('task', { type: 'task', data: { expectedRevision: 0, title: 'Atlas check', objective: 'x', notes: 'y', nextStep: 'z' } });
  assert.equal(task.task.project, 'atlas');
  const note = await saved('vault note', { type: 'note', data: { key: 'atlas-note', value: 'not a secret', description: 'Atlas note' } });
  assert.deepEqual(note.projects, ['atlas']);
  const invited = await saved('agent invite', { type: 'agent', action: 'invite', data: { name: 'Helper', kind: 'other', project: 'atlas' } });
  assert.equal(invited.project, 'atlas');
  const shared = await saved('project invite', { type: 'project', action: 'invite', id: 'atlas', data: { name: 'Helper two' } });
  assert.equal(shared.createdProject, false);
  assert.equal(shared.project.id, 'atlas');
  await saved('memory by the review tool', { type: 'dream', data: { remember: 'The Atlas team meets on Mondays.' } });
  await saved('connection off', { type: 'connection', id: 'loop_web', data: { enabled: false } });
  await saved('connection on', { type: 'connection', id: 'loop_web', data: { enabled: true } });

  for (const type of ['all', 'tools', 'connections', 'skills', 'memory', 'saved', 'schedules', 'files', 'history', 'tasks', 'agents', 'vault', 'categories', 'projects']) {
    await call(`search ${type}`, 'loop__search', { type });
    await call(`search ${type} for words`, 'loop__search', { type, query: 'atlas deploy' });
  }
  await call('search memory, two queries', 'loop__search', { type: 'memory', queries: ['atlas', 'deploy'] });
  const found = (await agent.call('loop__search', { type: 'connections' })).json;
  assert.equal(found.project, 'atlas');
  assert.ok(found.connections.find((row) => row.id === 'loop_web').projects.includes('atlas'));
  assert.equal((await agent.call('loop__search', { type: 'agents' })).json.agents[0].project, 'all');

  for (const [type, id] of [['project', undefined], ['project', 'atlas'], ['connection', 'loop_web'], ['skill', 'atlas-deploy'], ['memory', 'atlas-deploy'],
    ['saved', item.item?.id ?? item.id], ['schedule', schedule.schedule.id], ['file', file.file?.id ?? file.id], ['task', task.task.id], ['dream', undefined], ['doctor', undefined]]) {
    const answer = await call(`inspect ${type} ${id || ''}`, 'loop__inspect', { type, ...(id ? { id } : {}) });
    assert.equal(answer.isError, false, `inspect ${type}: ${answer.text}`);
  }
  await call('inspect two memories', 'loop__inspect', { type: 'memory', ids: ['atlas-deploy'] });
  await saved('project delete', { type: 'project', action: 'delete', id: 'atlas' });

  const withOldWord = [...answers].filter(([, keys]) => keys.length > 0).map(([label, keys]) => `${label}: ${keys.join(', ')}`);
  assert.deepEqual(withOldWord, []);
});

test('a program that asks with the old list type gets the old names', async (t) => {
  const loop = await localLoop(t);
  const agent = await loop.agent();
  assert.equal((await agent.call('loop__save', { type: 'project', data: { name: 'atlas' } })).json.saved, true);
  // Loop Text reads "activeProfile" from this answer to know the open project of a session.
  const before = (await agent.call('loop__search', { type: 'profiles', limit: 1 })).json;
  assert.equal(before.activeProfile, 'all');
  assert.deepEqual(before.profiles.map((row) => row.id), ['atlas']);
  assert.equal((await agent.call('loop__save', { type: 'project', action: 'enter', id: 'atlas' })).isError, false);
  assert.equal((await agent.call('loop__search', { type: 'profiles', limit: 1 })).json.activeProfile, 'atlas');
  // The new type says the same in the new names.
  const now = (await agent.call('loop__search', { type: 'projects' })).json;
  assert.equal(now.activeProject, 'atlas');
  assert.deepEqual(now.projects.map((row) => row.id), ['atlas']);
  assert.equal((await agent.call('loop__inspect', { type: 'project' })).json.activeProject, 'atlas');
});

async function catalogServer(t, toolName = 'search_tools') {
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (req.method !== 'POST' || body.id === undefined || body.id === null) {
      res.writeHead(req.method === 'POST' ? 202 : 405);
      return res.end();
    }
    const reply = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    };
    if (body.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'hub', version: '1.0.0' } });
    if (body.method === 'tools/list') {
      return reply({ tools: [{ name: toolName, description: 'Search tools across 900 apps by what you want to do.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] });
    }
    return reply({});
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  return `http://127.0.0.1:${upstream.address().port}/mcp`;
}

test('for an app that is not connected, Loop names a connected catalog before a new server', async (t) => {
  const loop = await localLoop(t);
  const agent = await loop.agent();

  const before = await agent.call('loop__search', { type: 'connections', query: 'gmail' });
  assert.match(before.json.hint, /that app is not connected\. To add it, use the app’s official hosted MCP server/);

  const added = await loop.api('/api/mcps', { body: { name: 'App hub', transport: 'http', url: await catalogServer(t) } });
  assert.equal(added.status, 201, added.text);
  const tool = `${added.json.mcp.id}__search_tools`;

  const after = await agent.call('loop__search', { type: 'connections', query: 'gmail' });
  assert.equal(after.json.noNameMatch, true, after.text);
  assert.ok(after.json.hint.includes('that app is not connected'), after.json.hint);
  assert.ok(after.json.hint.includes(`App hub is connected and reaches many apps: look for the app there first with loop__run({ tool: "${tool}" }).`), after.json.hint);
  assert.ok(after.json.hint.includes('To add the app itself, use the app’s official hosted MCP server'), after.json.hint);

  const several = await agent.call('loop__search', { type: 'connections', queries: ['gmail', 'notion'] });
  assert.ok(several.json.hint.includes(`loop__run({ tool: "${tool}" })`), several.json.hint);

  // An agent that cannot add a Connection still hears about the catalog.
  const reader = await loop.agent({ name: 'Reader', canManage: false, memoryAccess: 'none' });
  const readerHint = (await reader.call('loop__search', { type: 'connections', query: 'gmail' })).json.hint;
  assert.ok(readerHint.includes(`loop__run({ tool: "${tool}" })`), readerHint);

  // Loop cannot know which catalog has the app, so it names each one.
  const second = await loop.api('/api/mcps', { body: { name: 'Data market', transport: 'http', url: await catalogServer(t, 'find_tools') } });
  assert.equal(second.status, 201, second.text);
  const both = (await agent.call('loop__search', { type: 'connections', query: 'gmail' })).json.hint;
  assert.ok(both.includes('App hub and Data market are connected and reach many apps: look for the app in each of them first with loop__run'), both);
  assert.ok(both.includes(`"${tool}"`) && both.includes(`"${second.json.mcp.id}__find_tools"`), both);
});

test('loop_web__web_fetch returns markdown without duplicate content', async () => {
  const html = '<!doctype html><html><head><title>Doc</title></head><body><article><h1>Doc</h1><p>Single copy of page text.</p></article></body></html>';
  const fetched = await callBuiltinTool('loop_web', 'web_fetch', { url: 'https://docs.example.com/guide' }, {
    fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
  });
  assert.match(fetched.markdown, /Single copy of page text/);
  assert.equal('content' in fetched, false);
});

test('loop__search type "all" with query keeps real workspace totals beside matched counts', async (t) => {
  const loop = await localLoop(t);
  const agent = await loop.agent();

  assert.equal((await agent.call('loop__save', { type: 'memory', data: { content: 'Deploy uses Node 22 on Ubuntu.' } })).isError, false);
  assert.equal((await agent.call('loop__save', { type: 'memory', data: { content: 'Design system uses Inter and slate gray.' } })).isError, false);

  const missed = await agent.call('loop__search', { type: 'all', query: 'feedback' });
  assert.equal(missed.isError, false, missed.text);
  assert.equal(missed.json.summary.totalMemories, 2);
  assert.equal(missed.json.summary.matchedMemories, 0);
  assert.equal(missed.json.memories.length, 0);
  assert.ok(missed.json.summary.totalSkills >= 5);

  const hit = await agent.call('loop__search', { type: 'all', query: 'Node 22' });
  assert.equal(hit.isError, false, hit.text);
  assert.equal(hit.json.summary.totalMemories, 2);
  assert.equal(hit.json.summary.matchedMemories, 1);
  assert.equal(hit.json.memories.length, 1);
});

test('projects support repositoryUrl, ?project= URLs, and batch loop__save items', async (t) => {
  const loop = await localLoop(t);
  const agent = await loop.agent();
  const addedConn = await loop.api('/api/mcps', { body: { name: 'Docs Hub', transport: 'http', url: await catalogServer(t, 'read_doc') } });
  assert.equal(addedConn.status, 201, addedConn.text);
  const connId = addedConn.json.mcp.id;

  // Bad repository URLs (embedded creds or javascript:) are refused.
  const badCreds = await agent.call('loop__save', {
    type: 'project',
    data: { name: 'LumaDial', repositoryUrl: 'https://user:secret@github.com/acme/lumadial.git' },
  });
  assert.equal(badCreds.isError, true);
  assert.match(badCreds.text, /credentials/i);

  // Batch pre-validation rejects unknown fields in any item before writing anything.
  const badBatch = await agent.call('loop__save', {
    items: [
      { type: 'project', data: { name: 'Ghost', repositoryUrl: 'https://github.com/acme/ghost' } },
      { type: 'project', action: 'save', data: { name: 'Ghost', connections: [connId] } },
    ],
  });
  assert.equal(badBatch.isError, true);
  assert.match(badBatch.text, /^items\[1\]:.*Use action "add_tools" for "connections"/);
  assert.equal((await agent.call('loop__search', { type: 'projects' })).json.projects.length, 0);

  // Batch creates a project with repositoryUrl, adds a connection, and saves a project memory in one call.
  const batch = await agent.call('loop__save', {
    items: [
      { type: 'project', id: 'lumadial', data: { name: 'LumaDial', description: 'Voice app', repositoryUrl: 'git@github.com:acme/lumadial.git' } },
      { type: 'project', action: 'add_tools', id: 'lumadial', data: { connections: [connId] } },
      { type: 'memory', data: { content: 'LumaDial deploys via Fly.', projects: ['lumadial'] } },
    ],
  });
  assert.equal(batch.isError, false, batch.text);
  assert.equal(batch.json.batch, true);
  assert.equal(batch.json.completed, 3);
  assert.equal(batch.json.failed, 0);
  assert.equal(batch.json.results[0].result.project.repositoryUrl, 'git@github.com:acme/lumadial.git');
  assert.match(batch.json.results[0].result.mcpUrl, /\?project=lumadial$/);
  assert.match(batch.json.results[0].result.dashboardUrl, /\?project=lumadial$/);

  // Legacy type "profile" still returns the normalized `project` key.
  const legacySave = await agent.call('loop__save', { type: 'profile', id: 'lumadial', data: { description: 'Voice platform' } });
  assert.equal(legacySave.isError, false, legacySave.text);
  assert.equal(legacySave.json.project.description, 'Voice platform');
  assert.equal('profile' in legacySave.json, false);

  // inspect, enter, projects search, and REST /api/profiles?project= all expose repositoryUrl.
  const inspected = await agent.call('loop__inspect', { type: 'project', id: 'lumadial' });
  assert.equal(inspected.json.project.repositoryUrl, 'git@github.com:acme/lumadial.git');
  const entered = await agent.call('loop__save', { type: 'project', action: 'enter', id: 'lumadial' });
  assert.equal(entered.json.project.repositoryUrl, 'git@github.com:acme/lumadial.git');
  const listed = await agent.call('loop__search', { type: 'projects', query: 'github.com:acme' });
  assert.equal(listed.json.projects.length, 1);
  assert.equal(listed.json.projects[0].repositoryUrl, 'git@github.com:acme/lumadial.git');
  assert.match(listed.json.projects[0].mcpUrl, /\?project=lumadial$/);

  const memViaProjectParam = await loop.api('/api/memory?project=lumadial');
  assert.equal(memViaProjectParam.status, 200);
  assert.equal(memViaProjectParam.json.memories.length, 1);
});

test('loop__inspect type "agent" returns exact Connection, Skill, and Vault grants with project isolation', async (t) => {
  const loop = await localLoop(t);
  const owner = await loop.agent({ name: 'Owner Agent' });
  const addedConn = await loop.api('/api/mcps', { body: { name: 'Docs Hub', transport: 'http', url: await catalogServer(t, 'read_doc') } });
  assert.equal(addedConn.status, 201, addedConn.text);
  const connId = addedConn.json.mcp.id;

  // Create two projects, one skill in work, one Vault secret in work, and one Vault secret in private.
  assert.equal((await loop.api('/api/profiles', { body: { id: 'work', name: 'Work' } })).status, 201);
  assert.equal((await loop.api('/api/profiles', { body: { id: 'private', name: 'Private' } })).status, 201);
  const grantTools = await owner.call('loop__save', {
    type: 'project', action: 'add_tools', id: 'work',
    data: { tools: [{ connectionId: connId, toolName: 'read_doc' }] },
  });
  assert.equal(grantTools.isError, false, grantTools.text);
  assert.equal((await owner.call('loop__save', {
    type: 'skill', id: 'work-guide',
    data: { name: 'work-guide', description: 'Work playbook', content: '# Work', projects: ['work'] },
  })).isError, false);
  assert.equal((await loop.api('/api/vault', { body: { key: 'WORK_KEY', value: 'super-secret-work', type: 'api_key', description: 'Work API', profiles: ['work'] } })).status, 201);
  assert.equal((await loop.api('/api/vault', { body: { key: 'PRIVATE_KEY', value: 'super-secret-private', type: 'api_key', description: 'Private API', profiles: ['private'] } })).status, 201);

  const worker = await loop.api('/api/agents', {
    body: {
      name: 'Work Bot',
      kind: 'claude',
      profile: 'work',
      canManage: false,
      memoryAccess: 'read',
      secrets: ['WORK_KEY', 'PRIVATE_KEY'],
      allowedSkills: ['work-guide'],
    },
  });
  assert.equal(worker.status, 201, worker.text);
  const workerId = worker.json.agent.id;

  const inspected = await owner.call('loop__inspect', { type: 'agent', id: workerId });
  assert.equal(inspected.isError, false, inspected.text);
  assert.equal(inspected.json.id, workerId);
  assert.equal(inspected.json.project, 'work');
  assert.equal(inspected.json.canManage, false);
  assert.equal(inspected.json.memoryAccess, 'read');
  assert.equal('tokenHash' in inspected.json, false);
  assert.equal(inspected.json.grants.connections.mode, 'project');
  const connGrant = inspected.json.grants.connections.effective.find((c) => c.id === connId);
  assert.ok(connGrant);
  assert.deepEqual(connGrant.toolScope, ['read_doc']);
  assert.equal(inspected.json.grants.skills.mode, 'allowlist');
  assert.deepEqual(inspected.json.grants.skills.effective.map((s) => s.id), ['work-guide']);
  // PRIVATE_KEY is outside "work", so effective vault keys include only WORK_KEY and never raw values.
  assert.deepEqual(inspected.json.grants.vault.keys, ['WORK_KEY']);
  assert.doesNotMatch(inspected.text, /super-secret/);

  // A private-scoped agent cannot inspect a work-scoped agent.
  const privateAgent = await loop.agent({ name: 'Private Bot', profile: 'private', canManage: false });
  const denied = await privateAgent.call('loop__inspect', { type: 'agent', id: workerId });
  assert.equal(denied.isError, true);
});

test('broken DCR/CIMD endpoints are hidden from default listings and surfaced only to managers', async (t) => {
  // Mock an MCP endpoint whose OAuth server lacks DCR and CIMD so Loop marks it signInBroken.
  let brokenBase = '';
  const brokenUpstream = http.createServer((req, res) => {
    if (req.url === '/.well-known/oauth-protected-resource') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ resource: `${brokenBase}/mcp`, authorization_servers: [brokenBase] }));
    }
    if (req.url === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        issuer: brokenBase,
        authorization_endpoint: `${brokenBase}/authorize`,
        token_endpoint: `${brokenBase}/token`,
        response_types_supported: ['code'],
      }));
    }
    res.writeHead(401, {
      'WWW-Authenticate': `Bearer resource_metadata="${brokenBase}/.well-known/oauth-protected-resource"`,
    });
    res.end('Unauthorized');
  });
  await new Promise((resolve) => brokenUpstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => brokenUpstream.close(resolve)));
  brokenBase = `http://127.0.0.1:${brokenUpstream.address().port}`;

  const loop = await localLoop(t);
  const manager = await loop.agent({ name: 'Manager', canManage: true });
  const reader = await loop.agent({ name: 'Reader', canManage: false, memoryAccess: 'read' });

  const created = await loop.api('/api/mcps', {
    body: {
      name: 'Broken Gmail',
      transport: 'http',
      url: `${brokenBase}/mcp`,
    },
  });
  assert.equal(created.status, 201, created.text);
  const connId = created.json.mcp.id;

  // Manager sees Broken Gmail under unavailableConnections (not in main connections) on type "all".
  const mgrAll = await manager.call('loop__search', { type: 'all' });
  assert.equal(mgrAll.json.connections.some((c) => c.id === connId), false, mgrAll.text);
  assert.equal(mgrAll.json.unavailableConnections?.some((c) => c.id === connId), true, mgrAll.text);

  // Manager sees it under unavailable on unqueried type "connections", and in main list when explicitly queried.
  const mgrConns = await manager.call('loop__search', { type: 'connections' });
  assert.equal(mgrConns.json.connections.some((c) => c.id === connId), false);
  assert.equal(mgrConns.json.unavailable?.some((c) => c.id === connId), true);
  const mgrQuery = await manager.call('loop__search', { type: 'connections', query: 'Broken Gmail' });
  assert.equal(mgrQuery.json.connections.some((c) => c.id === connId), true);

  // Non-manager does not see broken DCR/CIMD endpoints at all in default listings.
  const readerAll = await reader.call('loop__search', { type: 'all' });
  assert.equal(readerAll.json.connections.some((c) => c.id === connId), false);
  assert.equal(readerAll.json.unavailableConnections, undefined);
  const readerConns = await reader.call('loop__search', { type: 'connections' });
  assert.equal(readerConns.json.connections.some((c) => c.id === connId), false);
  assert.equal(readerConns.json.unavailable, undefined);
});
