// People (lib/people.mjs): an invite gives somebody a Loop of their own, filled with what the owner picked.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { workspaceId } from '../lib/app-workspaces.mjs';
import { ConnectionPool } from '../lib/mcp-client.mjs';
import { InviteStore } from '../lib/invites.mjs';
import { PeopleStore, addressParts, canLend, handlePeopleJoin, ownSignInUrl, peopleInviteIdFromPath, readStart } from '../lib/people.mjs';
import { buildSharedUrl, isSharedConnection, parseSharedUrl } from '../lib/shared-connection.mjs';
import { startServer } from '../server.mjs';

const HOST = 'people.hosted.dev';
const ISSUER = 'https://people-test.clerk.accounts.dev';
const USERS = ['sam', 'theo', 'nia', 'priya'];
const key = (userId) => workspaceId({ issuer: ISSUER, userId });
const WS = 'a'.repeat(64);
const WS2 = 'b'.repeat(64);
const SAM_TOKEN = 'fixture-sam-notes-token';

const fakeClerk = {
  publishableKey: 'pk_test_people_fixture',
  frontendApi: ISSUER,
  async verifyRequest(req) {
    const userId = req.headers['x-fixture-auth'];
    if (!USERS.includes(userId)) return null;
    return { userId, sessionId: `sess_${userId}`, issuer: ISSUER, expiresAt: Date.now() + 60_000 };
  },
};

const TOOLS = [
  ['read_note', { readOnlyHint: true, destructiveHint: false }],
  ['write_note', { readOnlyHint: false, destructiveHint: false }],
  ['slow_note', { readOnlyHint: true, destructiveHint: false }],
].map(([name, annotations]) => ({ name, description: `Fixture tool ${name}`, inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations }));

// Two services. Both want a key: without one they answer 401. It also keeps what each call carried.
function upstream() {
  const seen = [];
  const gate = { release: null, started: null };
  const fetchUpstream = async (input, init = {}) => {
    const url = String(input?.url || input);
    const headers = new Headers(init.headers || {});
    if (!url.startsWith('https://notes.example.com/') && !url.startsWith('https://tasks.example.com/')) return new Response(null, { status: 404 });
    if (url.includes('/.well-known/')) return new Response(null, { status: 404 });
    if (init.method !== 'POST') return new Response(null, { status: 405 });
    if (!headers.get('authorization')) return new Response('no', { status: 401 });
    const msg = JSON.parse(init.body);
    if (msg.id == null) return new Response(null, { status: 202 });
    if (msg.method === 'tools/call') {
      seen.push({ url, auth: headers.get('authorization'), name: msg.params.name, args: msg.params.arguments });
      if (msg.params.name === 'slow_note') {
        gate.started?.();
        await new Promise((resolve) => { gate.release = resolve; init.signal?.addEventListener('abort', resolve, { once: true }); });
      }
    }
    const result = {
      initialize: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'notes', version: '1' } },
      'tools/list': { tools: TOOLS },
      'tools/call': { content: [{ type: 'text', text: `ran ${msg.params?.name}` }] },
    }[msg.method] ?? {};
    return Response.json({ jsonrpc: '2.0', id: msg.id, result });
  };
  return { fetchUpstream, seen, gate };
}

function request(port, route, { method, user, body, headers = {} } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: route, method: method || (payload === null ? 'GET' : 'POST'),
      headers: {
        Host: HOST,
        ...(payload !== null ? { 'Content-Type': 'application/json' } : {}),
        ...(user ? { 'X-Fixture-Auth': user } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function tempDir(t, close = null) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-people-'));
  t.after(async () => {
    await close?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return dir;
}

async function hosted(t, extra = {}) {
  const prev = process.env.LOOP_HUB_ALLOWED_HOSTS;
  process.env.LOOP_HUB_ALLOWED_HOSTS = HOST;
  const up = upstream();
  let srv;
  const dataDir = await tempDir(t, async () => {
    up.gate.release?.();
    await srv?.close();
    if (prev === undefined) delete process.env.LOOP_HUB_ALLOWED_HOSTS;
    else process.env.LOOP_HUB_ALLOWED_HOSTS = prev;
  });
  srv = await startServer({ port: 0, dataDir, detectLocalAgents: false, hosted: true, clerkApp: fakeClerk, upstreamFetch: up.fetchUpstream, ...extra });
  const call = (route, opts) => request(srv.port, route, opts);
  const as = (user) => (route, opts = {}) => call(route, { user, ...opts });
  const agent = async (user, fields = {}) => {
    const made = await call('/api/agents', { user, body: { name: `${user} agent`, kind: 'other', canManage: false, ...fields } });
    assert.equal(made.status, 201, made.text);
    const rpc = async (method, params) => {
      const res = await call('/mcp', {
        method: 'POST',
        headers: { Accept: 'application/json, text/event-stream', Authorization: `Bearer ${made.json.token}` },
        body: { jsonrpc: '2.0', id: 1, method, params },
      });
      assert.equal(res.status, 200, res.text);
      return res.json.result;
    };
    const run = async (tool, args = {}, more = {}) => {
      const result = await rpc('tools/call', { name: 'loop__run', arguments: { tool, arguments: args, ...more } });
      return { isError: Boolean(result?.isError), text: (result?.content || []).map((c) => c.text || '').join('\n') };
    };
    return { run, rpc, id: made.json.agent.id };
  };
  return { port: srv.port, dataDir, call, as, agent, up };
}

const parts = (url) => {
  const m = /\/p\/([a-z0-9]{14})#([a-z0-9]{20})$/.exec(url);
  assert.ok(m, `one-use link: ${url}`);
  return { id: m[1], code: m[2] };
};
const own = (ref) => ({ kind: 'connection', ref, mode: 'own' });
const mine = (ref) => ({ kind: 'connection', ref, mode: 'mine' });
const skill = (ref) => ({ kind: 'skill', ref });

async function fillSam(hub) {
  const sam = hub.as('sam');
  for (const [name, url] of [['Notes', 'https://notes.example.com/mcp?team=sam-team-42'], ['Tasks', 'https://tasks.example.com/mcp?project=sam-private']]) {
    const made = await sam('/api/mcps', { body: { name, description: `${name} of the team`, transport: 'http', url, token: SAM_TOKEN } });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.json.mcp.lastError, null, made.text);
  }
  // Reads pass, writes ask: the rule of Sam's Loop.
  return sam;
}

async function invite(hub, items, name = 'Theo') {
  const made = await hub.call('/api/people/invites', { user: 'sam', body: { name, ownerName: 'Sam', items } });
  assert.equal(made.status, 201, made.text);
  return { ...parts(made.json.url), invite: made.json.invite, url: made.json.url };
}

async function join(hub, items, user = 'theo', name = 'Theo') {
  const link = await invite(hub, items, name);
  const done = await hub.call('/api/people/join', { user, body: { id: link.id, code: link.code } });
  assert.equal(done.status, 201, done.text);
  return done.json;
}

const sams = async (hub) => (await hub.call('/api/people', { user: 'sam' })).json;
const mcpsOf = async (hub, user) => (await hub.call('/api/mcps', { user })).json.mcps.filter((m) => m.transport !== 'builtin');
const until = async (check, label) => {
  for (let i = 0; i < 100; i += 1) {
    const got = await check();
    if (got) return got;
    await new Promise((r) => setTimeout(r, 20));
  }
  return assert.fail(`not in time: ${label}`);
};

/* ---------------- what can be given ---------------- */
test('own sign-in: only an address that is the same for everybody, and never its query', () => {
  const at = (url, more = {}) => ownSignInUrl({ transport: 'http', url, ...more });
  assert.equal(at('https://mcp.notion.com/mcp'), 'https://mcp.notion.com/mcp');
  assert.equal(at('https://mcp.supabase.com/mcp?project_ref=abcdefgh12345678'), 'https://mcp.supabase.com/mcp');
  assert.equal(at('https://api.githubcopilot.com/mcp/'), 'https://api.githubcopilot.com/mcp/');
  for (const url of ['https://mcp.linear.app/sse', 'https://mcp.example.com/v1/mcp', 'https://mcp.example.com/2025-03-26/streamable-http', 'https://mcp.example.com/@team/mcp-server', 'https://ep1.example.com/oauth2/mcp']) assert.equal(at(url), url);
  for (const url of [
    'https://mcp.zapier.example/api/mcp/s/Zm9vYmFyMTIzNDU2Nzg5MDEyMzQ1/mcp',
    'https://mcp.composio.example/server/7f3d9f60-1111-4222-8333-944455556666/mcp',
    'https://u:p@mcp.example.com/mcp',
    'http://mcp.example.com/mcp',
    'https://mcp.example.com/{{vault:TEAM}}/mcp',
    'https://abcd1234efgh5678ijkl.functions.example.com/mcp',
    'https://mcp.example.com/key/sk-proj-12345678',
    'https://mcp.example.com/kzqwvxjhgtrbnmplsdfg/mcp',
    'https://mcp.example.com/u/83120457/mcp',
    'https://mcp.example.com/a1b2c3d4/mcp',
    'https://mcp.example.com/s/kX9aLp2q-77Zd/mcp',
    'https://mcp.example.com/mcp;session=AB12',
    'https://mcp.example.com/mcp/%41%42%31%32%33',
    'https://aQbWcEdRfT.example.com.kzqwvxjhgtrbnmplsdfg.example.com/mcp',
    buildSharedUrl('abcdefgh2345'),
    'https://relay.useloop.sh/d/dev_0123456789abcdef/notes',
    'not an address',
  ]) assert.equal(at(url), null, url);
  assert.equal(ownSignInUrl({ transport: 'stdio', command: 'npx' }), null);
  assert.equal(canLend({ transport: 'http', url: 'https://mcp.notion.com/mcp', enabled: true }), true);
  assert.equal(canLend({ transport: 'http', url: 'https://mcp.notion.com/mcp', enabled: false }), false);
  assert.equal(canLend({ transport: 'http', url: buildSharedUrl('abcdefgh2345'), enabled: true }), false, 'what is lent cannot be lent on');
  assert.equal(canLend({ transport: 'http', url: 'https://relay.useloop.sh/d/dev_0123456789abcdef/notes', enabled: true }), false);
  assert.equal(canLend({ transport: 'stdio', command: 'npx', enabled: true }), false);
  assert.equal(canLend({ transport: 'builtin', enabled: true }), false);
});

test('the address of a lent connection never opens a network session', async () => {
  assert.equal(parseSharedUrl(buildSharedUrl('abcdefgh2345')), 'abcdefgh2345');
  for (const url of ['https://people.useloop.sh/c/abcdefgh2345/x', 'https://people.useloop.sh/c/ABCDEFGH2345', 'https://people.useloop.sh', 'HTTPS://PEOPLE.useloop.sh:8443/c/x', 'https://people.useloop.sh/c/abcdefgh2345?x=1']) {
    assert.equal(isSharedConnection({ url }), true, url);
    assert.equal(parseSharedUrl(url), null, url);
  }
  assert.equal(isSharedConnection({ url: 'https://people.useloop.sh.example.com/c/abcdefgh2345' }), false);
  let fetched = 0;
  const conn = { id: 'x', name: 'X', transport: 'http', url: buildSharedUrl('abcdefgh2345'), enabled: true };
  const pool = new ConnectionPool({ get: async () => conn, update: async (_id, patch) => ({ ...conn, ...patch }) }, null, {
    upstreamFetch: async () => { fetched += 1; return new Response(null, { status: 500 }); },
  });
  await assert.rejects(pool.callTool('x', 'read_note', {}), /works only in Loop Cloud/);
  await assert.rejects(pool.getClient('x'), /somebody else's Loop/);
  await assert.rejects(pool.readResource('x', 'a://b'), /somebody else's Loop/);
  await assert.rejects(pool.getPrompt('x', 'p'), /somebody else's Loop/);
  const synced = await pool.sync('x');
  assert.deepEqual(synced.tools, []);
  assert.match(synced.lastError, /works only in Loop Cloud/);
  assert.equal(fetched, 0);
  await pool.closeAll();
});

/* ---------------- the store ---------------- */
test('the link is one use, kept only as a hash, and a new link ends the one before', async (t) => {
  const dir = await tempDir(t);
  const people = new PeopleStore(dir);
  const { invite: inv, code } = await people.invite({ workspaceId: WS, ownerName: 'Sam', name: ` Theo${String.fromCharCode(0x202e)} `, items: [] });
  assert.equal(inv.name, 'Theo');
  assert.ok(!(await readFile(path.join(dir, 'people.json'), 'utf8')).includes(code), 'the code is not on disk');
  assert.equal((await stat(path.join(dir, 'people.json'))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(await people.list(WS)).includes('codeHash'));
  assert.ok(!JSON.stringify(await people.peek(inv.id, code)).includes('codeHash'));

  await assert.rejects(people.peek(inv.id, 'x'.repeat(20)), /has ended/);
  await assert.rejects(people.join(inv.id, `${code.slice(1)}a`, WS2), /has ended/);
  const renewed = await people.renew(WS, inv.id);
  await assert.rejects(people.join(inv.id, code, WS2), /has ended/, 'the first link ended');
  await assert.rejects(people.join(inv.id, renewed.code, WS), /your own Loop/);
  assert.equal(await people.renew(WS2, inv.id), null, 'only the owner makes a new link');
  assert.equal(await people.cancelInvite(WS2, inv.id), false);

  const both = await Promise.allSettled([people.join(inv.id, renewed.code, WS2), people.join(inv.id, renewed.code, 'c'.repeat(64))]);
  assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1, 'two at the same time: one joins');
  assert.equal((await people.list(WS)).invites.length, 0);
  const again = new PeopleStore(dir);
  const [person] = (await again.list(WS)).people;
  assert.equal(person.name, 'Theo', 'kept after a restart');
  assert.equal((await again.fromFor(person.personKey))[0].ownerName, 'Sam');
});

test('a link ends after its time, a name is in the list once, and the list has a limit', async (t) => {
  const dir = await tempDir(t);
  const short = new PeopleStore(dir, { inviteTtlMs: 1 });
  const old = await short.invite({ workspaceId: WS, name: 'Theo' });
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(short.join(old.invite.id, old.code, WS2), /has ended/);
  assert.deepEqual((await short.list(WS)).invites, []);

  const people = new PeopleStore(dir);
  await people.invite({ workspaceId: WS, name: 'Theo' });
  await assert.rejects(people.invite({ workspaceId: WS, name: 'theo' }), /in the list already/);
  await assert.rejects(people.invite({ workspaceId: WS, name: '  ' }), /Enter a name/);
  await assert.rejects(people.invite({ workspaceId: null, name: 'Ana' }), /Loop Cloud/);
  for (let i = 1; i < 20; i += 1) await people.invite({ workspaceId: WS, name: `P${i}` });
  await assert.rejects(people.invite({ workspaceId: WS, name: 'One more' }), /invite 20 people/);
});

test('a broken people file is an error, never an empty list', async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, 'people.json'), '{');
  for (const text of ['{', 'null', '[]', '{}', '{"owners":{},"people":{},"invites":[]}', '{"owners":{},"people":[null],"invites":[]}', `{"owners":{},"people":[{"workspaceId":"${WS}"}],"invites":[]}`]) {
    await writeFile(path.join(dir, 'people.json'), text);
    await assert.rejects(new PeopleStore(dir).list(WS), /^Error: The list of people cannot be read\.$/, text);
    await assert.rejects(new PeopleStore(dir).beginCall('abcdefgh2345', WS2, 'notes'), /^Error: The list of people cannot be read\.$/, text);
  }
});

test('one address cannot try links without end', async (t) => {
  const people = new PeopleStore(await tempDir(t));
  for (let i = 0; i < 30; i += 1) {
    assert.equal(people.tooManyTries('203.0.113.7'), false);
    people.wrongLink('203.0.113.7');
  }
  assert.equal(people.tooManyTries('203.0.113.7'), true);
  assert.equal(people.tooManyTries('203.0.113.7', Date.now() + 11 * 60 * 1000), false, 'for a while');
  for (let i = 0; i < 100; i += 1) assert.equal(people.tooManyTries('203.0.113.8'), false, 'a good link does not close itself');
  for (let i = 0; i < 30; i += 1) { people.tooManyTries('203.0.113.7'); people.wrongLink('203.0.113.7'); }
  let sent = null;
  await handlePeopleJoin({
    req: {}, res: {}, pathname: '/api/people/join', method: 'POST', workspace: { id: WS2 }, clientIp: '203.0.113.7', people,
    workspaces: null, readJsonBody: async () => assert.fail('must not read the code'), sendJson: (_res, status) => { sent = status; },
  });
  assert.equal(sent, 429);
  assert.equal(peopleInviteIdFromPath('/p/abcdefgh234567'), 'abcdefgh234567');
  assert.equal(peopleInviteIdFromPath('/p/short'), null);
  assert.equal(peopleInviteIdFromPath('/p/../../etc/passwd'), null);
});

/* ---------------- the invite and the join ---------------- */
test('an invite fills the person\'s own Loop, with no key and no query of the owner', async (t) => {
  const hub = await hosted(t);
  const sam = await fillSam(hub);
  const options = (await sam('/api/people/options')).json;
  assert.deepEqual(options.connections.map((c) => [c.id, c.own, c.mine]), [['notes', true, true], ['tasks', true, true]], 'built-in tools are not in the list');

  const empty = await sams(hub);
  assert.deepEqual(empty, { available: true, owner: '', canAdd: true, people: [], invites: [], from: [] });
  assert.equal((await hub.call('/api/people')).status, 401);
  assert.equal((await hub.call('/api/people/invites', { body: { name: 'Theo', items: [] } })).status, 401);
  assert.equal((await hub.call('/api/people/options')).status, 401);

  const link = await invite(hub, [own('tasks'), mine('notes')]);
  const listed = await sams(hub);
  assert.equal(listed.owner, 'Sam');
  assert.deepEqual(listed.invites.map((i) => [i.name, i.items.map((x) => [x.name, x.mode])]), [['Theo', [['Tasks', 'own'], ['Notes', 'mine']]]]);

  // Anybody with the link sees what it is for. No code, no look.
  assert.equal((await hub.call(`/p/${link.id}`, { headers: { Accept: 'text/html' } })).status, 200);
  assert.equal((await hub.call('/people-join.html')).status, 404);
  const preview = await hub.call('/api/people/preview', { body: { id: link.id, code: link.code } });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.owner, 'Sam');
  assert.equal(preview.json.signedIn, false);
  // An own sign-in says which service it goes to, so that a name cannot hide another one.
  assert.deepEqual(preview.json.items, [{ kind: 'connection', name: 'Tasks', mode: 'own', host: 'tasks.example.com' }, { kind: 'connection', name: 'Notes', mode: 'mine' }]);
  for (const secret of [key('sam'), SAM_TOKEN, 'sam-team-42', 'sam-private', 'notes.example.com']) assert.ok(!preview.text.includes(secret), secret);
  // What the page showed is what the person gets, also when the owner changes the address after that.
  const moved = await sam('/api/mcps/tasks', { method: 'PATCH', body: { url: 'https://notes.example.com/moved' } });
  assert.equal(moved.status, 200, moved.text);
  assert.equal((await hub.call('/api/people/preview', { body: { id: link.id, code: 'a'.repeat(20) } })).status, 404);
  assert.equal((await hub.call('/api/people/preview', { body: { id: link.id } })).status, 404);

  // The link alone does not join: the account does.
  assert.equal((await hub.call('/api/people/join', { body: { id: link.id, code: link.code } })).status, 401);
  assert.equal((await hub.call('/api/people/join', { user: 'sam', body: { id: link.id, code: link.code } })).status, 409);
  const joined = await hub.call('/api/people/join', { user: 'theo', body: { id: link.id, code: link.code, name: 'Admin' } });
  assert.equal(joined.status, 201, joined.text);
  assert.equal(joined.json.added, 2);
  assert.equal((await hub.call('/api/people/join', { user: 'priya', body: { id: link.id, code: link.code } })).status, 404, 'one use');
  // The used link still opens for the account that used it, and for nobody else.
  const look = (user) => hub.call('/api/people/preview', { user, body: { id: link.id, code: link.code } });
  assert.deepEqual((await look('theo')).json, { joined: joined.json.id, text: false, needsPlan: false });
  assert.deepEqual((await hub.call('/api/people/join', { user: 'theo', body: { id: link.id, code: link.code } })).json, { id: joined.json.id, owner: 'Sam', added: 0 });
  for (const user of ['priya', 'sam', undefined]) assert.equal((await look(user)).status, 404);
  assert.equal((await hub.call('/api/people/preview', { user: 'theo', body: {} })).status, 404);

  const [notes, tasks] = (await mcpsOf(hub, 'theo')).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(tasks.url, 'https://tasks.example.com/mcp', 'the query of the owner is left out');
  assert.equal(tasks.hasAuth, false);
  assert.equal(tasks.authRequired, true, 'Theo signs in with an account of their own');
  assert.equal(notes.lent, true);
  assert.equal(notes.lastError, null);
  assert.deepEqual(notes.tools.map((x) => x.name), TOOLS.map((x) => x.name));
  const theoFile = await readFile(path.join(hub.dataDir, 'user-workspaces', key('theo'), 'config.json'), 'utf8');
  for (const secret of [SAM_TOKEN, 'sam-team-42', 'sam-private', 'notes.example.com', key('sam')]) assert.ok(!theoFile.includes(secret), secret);

  // Sam sees the state of these two things, and nothing else of Theo's Loop.
  await hub.call('/api/mcps', { user: 'theo', body: { name: 'Private of Theo', transport: 'http', url: 'https://notes.example.com/other', skipSync: true } });
  const after = await hub.call('/api/people', { user: 'sam' });
  const [person] = after.json.people;
  assert.deepEqual([person.name, person.signedIn, person.signIns], ['Theo', 0, 1], 'the name is the one that Sam typed');
  assert.deepEqual(person.items.map((i) => [i.name, i.state]), [['Tasks', 'signin'], ['Notes', 'mine']]);
  assert.ok(!after.text.includes('Private of Theo'));
  assert.ok(!after.text.includes(key('theo')));
  assert.ok(!/"share"/.test(after.text));

  // Theo signs in (here: a key of their own), and Sam's list says so.
  const signed = await hub.call('/api/mcps/tasks', { user: 'theo', method: 'PATCH', body: { token: 'fixture-theo-own-token' } });
  assert.equal(signed.status, 200, signed.text);
  await hub.call('/api/mcps/tasks/sync', { user: 'theo', method: 'POST', body: {} });
  assert.deepEqual((await sams(hub)).people.map((p) => [p.signedIn, p.signIns]), [[1, 1]]);
  const mineView = (await hub.call('/api/people/from', { user: 'theo' })).json.from;
  assert.deepEqual((await hub.call('/api/overview', { user: 'theo' })).json.from, mineView, 'Home has it too');
  assert.deepEqual((await hub.call('/api/overview', { user: 'sam' })).json.from, []);
  assert.deepEqual(mineView.map((v) => [v.owner, v.items.map((i) => [i.name, i.state, i.connId])]), [['Sam', [['Tasks', 'ready', 'tasks'], ['Notes', 'mine', 'notes']]]]);
});

test('an invite can only give what is in the Loop of the owner, in a way that is possible', async (t) => {
  const hub = await hosted(t);
  const sam = await fillSam(hub);
  await sam('/api/mcps', { body: { name: 'Own code', transport: 'http', url: 'https://notes.example.com/server/7f3d9f60-1111-4222-8333-944455556666/mcp', skipSync: true } });
  const options = (await sam('/api/people/options')).json;
  assert.deepEqual(options.connections.find((c) => c.id === 'own_code'), { id: 'own_code', name: 'Own code', own: false, mine: true, projects: [] });
  const bad = async (items, status) => assert.equal((await sam('/api/people/invites', { body: { name: 'Theo', items } })).status, status, JSON.stringify(items));
  await bad([own('own_code')], 400);
  await bad([own('nothing')], 409);
  await bad([skill('nothing')], 409);
  await bad([{ kind: 'vault', ref: 'STRIPE_KEY' }], 409);
  await bad([null], 409);
  await bad('all', 400);
  await bad(Array.from({ length: 61 }, () => own('tasks')), 400);
  assert.deepEqual((await sams(hub)).invites, []);
});

test('skills are copied, and one that the person has already stays as it is', async (t) => {
  const hub = await hosted(t);
  const write = async (user, id, text) => {
    const { SkillStore } = await import('../lib/skills.mjs');
    const dir = path.join(hub.dataDir, 'user-workspaces', key(user));
    await hub.call('/api/people', { user });
    await new SkillStore(dir, { personal: true }).saveSkillMarkdown(id, { name: id, description: 'A fixture skill.', content: text });
  };
  await write('sam', 'release-notes', 'Text of Sam.');
  await write('sam', 'tone', 'Tone of Sam.');
  await write('theo', 'tone', 'Tone of Theo.');
  await join(hub, [skill('release-notes'), skill('tone')]);
  const skills = path.join(hub.dataDir, 'user-workspaces', key('theo'), 'skills');
  assert.match(await readFile(path.join(skills, 'release-notes', 'SKILL.md'), 'utf8'), /Text of Sam/);
  assert.match(await readFile(path.join(skills, 'tone', 'SKILL.md'), 'utf8'), /Tone of Theo/);
  const [person] = (await sams(hub)).people;
  assert.deepEqual(person.items.map((i) => [i.name, i.state]), [['release-notes', 'ready'], ['tone', 'ready']]);
});

test('a person who has the service already keeps their own connection', async (t) => {
  const hub = await hosted(t);
  await fillSam(hub);
  await hub.call('/api/mcps', { user: 'theo', body: { name: 'My tasks', transport: 'http', url: 'https://tasks.example.com/mcp/', token: 'fixture-theo-own-token' } });
  await hub.call('/api/mcps', { user: 'theo', body: { name: 'Notes', transport: 'http', url: 'https://notes.example.com/theo', token: 'fixture-theo-own-token' } });
  await join(hub, [own('tasks'), mine('notes')]);
  const mcps = await mcpsOf(hub, 'theo');
  assert.deepEqual(mcps.map((m) => m.name).sort(), ['My tasks', 'Notes', 'Notes (Sam)']);
  assert.deepEqual((await sams(hub)).people[0].items.map((i) => i.state), ['ready', 'mine']);
});

/* ---------------- uses mine ---------------- */
test('a lent connection runs in the owner\'s Loop, by the owner\'s rules', async (t) => {
  const hub = await hosted(t);
  const sam = await fillSam(hub);
  await join(hub, [mine('notes')]);
  const agent = await hub.agent('theo');

  const read = await agent.run('notes__read_note', { text: 'hello' });
  assert.deepEqual([read.isError, read.text], [false, 'ran read_note']);
  assert.deepEqual(hub.up.seen.at(-1), { url: 'https://notes.example.com/mcp?team=sam-team-42', auth: `Bearer ${SAM_TOKEN}`, name: 'read_note', args: { text: 'hello' } });
  const samFeed = (await sam('/api/activity')).json.entries;
  const entry = samFeed.find((e) => e.target === 'notes__read_note');
  assert.equal(entry.agentName, 'Theo');
  assert.ok(!JSON.stringify(samFeed).includes('hello'), 'no arguments in the list');

  // Ask: the question goes to Sam, and Theo's agent gets no link to answer it.
  await sam('/api/policies', { method: 'PATCH', body: { connections: { notes: 'always_ask' } } });
  const before = hub.up.seen.length;
  const asked = await agent.run('notes__read_note', { text: 'ask me' });
  assert.equal(asked.isError, true);
  assert.match(asked.text, /Sam must say yes/);
  for (const secret of ['approveUrl', 'apr_', 'notes.example.com', key('sam'), HOST]) assert.ok(!asked.text.includes(secret), secret);
  assert.equal(hub.up.seen.length, before);
  const pending = (await sam('/api/approvals')).json.pending;
  assert.deepEqual(pending.map((p) => [p.agentName, p.target]), [['Theo', 'notes__read_note']]);
  assert.deepEqual((await hub.call('/api/approvals', { user: 'theo' })).json.pending, [], 'nothing to decide for Theo');
  assert.equal((await hub.call(`/api/approvals/${pending[0].id}/approve`, { user: 'theo', method: 'POST', body: {} })).status, 404);
  assert.match((await agent.run('notes__read_note', { text: 'ask me' })).text, /Sam must say yes/, 'still waits');
  assert.equal((await sam('/api/approvals')).json.pending.length, 1, 'one question');

  const yes = await sam(`/api/approvals/${pending[0].id}/approve`, { method: 'POST', body: {} });
  assert.equal(yes.status, 200, yes.text);
  assert.equal((await agent.run('notes__read_note', { text: 'other words' })).isError, true, 'the yes is for these arguments only');
  const done = await agent.run('notes__read_note', { text: 'ask me' });
  assert.deepEqual([done.isError, done.text], [false, 'ran read_note']);
  assert.match((await agent.run('notes__read_note', { text: 'ask me' })).text, /Sam must say yes/, 'and for one time');

  for (const p of (await sam('/api/approvals')).json.pending) await sam(`/api/approvals/${p.id}/deny`, { method: 'POST', body: {} });
  assert.match((await agent.run('notes__read_note', { text: 'ask me' })).text, /Sam said no/);
  assert.match((await agent.run('notes__read_note', { text: 'ask me' })).text, /Sam said no/, 'and it is not asked again');
  assert.equal((await sam('/api/approvals')).json.pending.length, 0);
  for (let i = 0; i < 8; i += 1) await agent.run('notes__read_note', { text: `flood ${i}` });
  assert.equal((await sam('/api/approvals')).json.pending.length, 5, 'one person has five open questions at most');
  for (const p of (await sam('/api/approvals')).json.pending) await sam(`/api/approvals/${p.id}/deny`, { method: 'POST', body: {} });

  // Sam turns one tool off, then the connection.
  await sam('/api/policies', { method: 'PATCH', body: { connections: { notes: 'auto' } } });
  await sam('/api/mcps/notes/tools/toggle', { body: { toolName: 'read_note', enabled: false } });
  assert.match((await agent.run('notes__read_note')).text, /does not lend the tool/);
  assert.equal((await agent.run('notes__write_note')).text, 'ran write_note');
  await sam('/api/mcps/notes/toggle', { body: { enabled: false } });
  assert.match((await agent.run('notes__write_note')).text, /turned this connection off/);
  const synced = await hub.call('/api/mcps/notes/sync', { user: 'theo', method: 'POST', body: {} });
  assert.match(synced.json.mcp.lastError, /off in Sam's Loop/);
});

test('Guard: a yes of the owner with their password, and nothing of the person counts', async (t) => {
  const hub = await hosted(t);
  const sam = await fillSam(hub);
  await join(hub, [mine('notes')]);
  const agent = await hub.agent('theo');
  await sam('/api/auth/vault-password', { body: { current: '', next: 'fixture-vault-password' } });
  const set = await sam('/api/policies', { method: 'PATCH', body: { connections: { notes: 'guard' } } });
  assert.equal(set.status, 200, set.text);
  assert.match((await agent.run('notes__read_note')).text, /Sam must say yes/);
  const [question] = (await sam('/api/approvals')).json.pending;
  assert.equal(question.guard, true);
  assert.notEqual((await sam(`/api/approvals/${question.id}/approve`, { method: 'POST', body: {} })).status, 200, 'not without the password');
  assert.match((await agent.run('notes__read_note')).text, /Sam must say yes/);
  assert.equal(hub.up.seen.length, 0);
});

test('no secret of either Vault goes through a lent connection', async (t) => {
  const hub = await hosted(t);
  const sam = await fillSam(hub);
  await sam('/api/vault', { body: { key: 'SAM_SECRET', value: 'fixture-sam-vault-value' } });
  await hub.call('/api/vault', { user: 'theo', body: { key: 'THEO_SECRET', value: 'fixture-theo-vault-value' } });
  await join(hub, [mine('notes')]);
  const agent = await hub.agent('theo', { secrets: ['THEO_SECRET'] });
  for (const name of ['THEO_SECRET', 'SAM_SECRET', '__oauth_access_notes']) {
    const res = await agent.run('notes__write_note', { text: `{{vault:${name}}}` });
    assert.equal(res.isError, true, name);
    assert.match(res.text, /cannot be sent|not been shared|cannot be referenced/, name);
  }
  assert.equal((await agent.run('notes__write_note', { text: 'x' }, { operationId: 'op-1' })).isError, true, 'no receipt for a call that can wait for somebody');
  assert.equal(hub.up.seen.length, 0);
});

test('the share belongs to one account: its address is worth nothing in another Loop', async (t) => {
  const hub = await hosted(t);
  await fillSam(hub);
  await join(hub, [mine('notes')]);
  const { url } = (await mcpsOf(hub, 'theo'))[0];
  assert.ok(parseSharedUrl(url));
  for (const user of ['nia', 'sam']) {
    const made = await hub.call('/api/mcps', { user, body: { name: 'Forged', transport: 'http', url } });
    assert.equal(made.status, 201, made.text);
    assert.match(made.json.mcp.lastError, /has ended/);
    assert.deepEqual(made.json.mcp.tools, []);
    const agent = await hub.agent(user);
    const res = await agent.run('forged__read_note');
    assert.equal(res.isError, true);
    assert.equal(hub.up.seen.length, 0, user);
  }
  // Theo cannot give it on, in either way.
  const options = (await hub.call('/api/people/options', { user: 'theo' })).json;
  assert.deepEqual(options.connections, []);
  assert.equal((await hub.call('/api/people/invites', { user: 'theo', body: { name: 'Nia', items: [mine('notes')] } })).status, 409);
});

test('Stop ends it at once: the next call, the call that runs, and the record in the person\'s Loop', async (t) => {
  const hub = await hosted(t);
  const sam = await fillSam(hub);
  await join(hub, [mine('notes'), own('tasks')]);
  const agent = await hub.agent('theo');
  assert.equal((await agent.run('notes__read_note')).text, 'ran read_note');

  await sam('/api/policies', { method: 'PATCH', body: { tools: { notes__write_note: 'always_ask' } } });
  await agent.run('notes__write_note', { text: 'wait' });
  assert.equal((await sam('/api/approvals')).json.pending.length, 1);

  const started = new Promise((resolve) => { hub.up.gate.started = resolve; });
  const running = agent.run('notes__slow_note');
  await started;
  const [person] = (await sams(hub)).people;
  const item = (name) => person.items.find((i) => i.name === name);
  assert.equal((await hub.call(`/api/people/${person.id}/items/${item('Notes').id}`, { user: 'nia', method: 'DELETE' })).status, 404, 'only Sam');
  assert.equal((await hub.call(`/api/people/${person.id}/items/${item('Notes').id}`, { user: 'theo', method: 'DELETE' })).status, 404);
  assert.equal((await sam(`/api/people/${person.id}/items/${item('Tasks').id}`, { method: 'DELETE' })).status, 409, 'Tasks is Theo\'s own now');
  const stop = await sam(`/api/people/${person.id}/items/${item('Notes').id}`, { method: 'DELETE' });
  assert.equal(stop.status, 200, stop.text);
  assert.deepEqual(stop.json.person.items.map((i) => i.name), ['Tasks']);
  hub.up.gate.release?.();
  const cut = await running;
  assert.equal(cut.isError, true, cut.text);
  assert.doesNotMatch(cut.text, /ran slow_note/);

  assert.deepEqual((await mcpsOf(hub, 'theo')).map((m) => m.name), ['Tasks'], 'the record is gone, the own one stays');
  assert.equal((await sam('/api/approvals')).json.pending.length, 0, 'the open question is gone too');
  assert.equal((await agent.run('notes__read_note')).isError, true);
  const back = await hub.call('/api/mcps', { user: 'theo', body: { name: 'Back', transport: 'http', url: buildSharedUrl('abcdefgh2345') } });
  assert.match(back.json.mcp.lastError, /has ended/);
});

test('what is lent is tied to one connection with one address, and stops with a pause', async (t) => {
  const hub = await hosted(t);
  const sam = await fillSam(hub);
  await join(hub, [mine('notes'), mine('tasks')]);
  const agent = await hub.agent('theo');
  assert.equal((await agent.run('notes__read_note')).text, 'ran read_note');

  // A pause stops it, and nothing is lost by it.
  assert.equal((await sam('/api/settings', { method: 'PATCH', body: { paused: true } })).status, 200);
  assert.match((await agent.run('notes__read_note')).text, /paused/);
  await sam('/api/settings', { method: 'PATCH', body: { paused: false } });
  assert.equal((await agent.run('notes__read_note')).text, 'ran read_note');

  // Another address is something that Sam did not pick.
  const calls = hub.up.seen.length;
  assert.equal((await sam('/api/mcps/notes', { method: 'PATCH', body: { url: 'https://tasks.example.com/payroll' } })).status, 200);
  assert.equal((await agent.run('notes__read_note')).isError, true);
  const synced = await hub.call('/api/mcps/notes/sync', { user: 'theo', method: 'POST', body: {} });
  assert.deepEqual(synced.json.mcp.tools, []);

  // So is a new connection under the id of one that Sam deleted.
  assert.equal((await sam('/api/mcps/tasks', { method: 'DELETE' })).status, 200);
  assert.equal((await agent.run('tasks__read_note')).isError, true);
  await sam('/api/mcps', { body: { name: 'Tasks', transport: 'http', url: 'https://tasks.example.com/mcp?project=sam-private', token: SAM_TOKEN } });
  assert.equal((await agent.run('tasks__read_note')).isError, true, 'the same name and address, but not the same connection');
  assert.equal(hub.up.seen.length, calls);

  // Sam's list and Theo's Loop show it, and Sam can offer it again.
  const [person] = (await sams(hub)).people;
  assert.deepEqual(person.items, []);
  assert.deepEqual(await mcpsOf(hub, 'theo'), []);
  const more = await sam(`/api/people/${person.id}/items`, { body: { items: [mine('tasks')] } });
  assert.deepEqual(more.json.person.items.map((i) => [i.name, i.state]), [['Tasks', 'offer']]);
});

test('an invite and an offer end with the connection, and an own sign-in with another address is not "signed in"', async (t) => {
  const hub = await hosted(t);
  const sam = await fillSam(hub);
  await join(hub, [mine('notes')], 'nia', 'Nia');
  const link = await invite(hub, [own('tasks'), mine('notes')]);
  await sam('/api/mcps/notes', { method: 'DELETE' });
  await sam('/api/mcps', { body: { name: 'Notes', transport: 'http', url: 'https://notes.example.com/other', token: SAM_TOKEN } });
  const preview = await hub.call('/api/people/preview', { body: { id: link.id, code: link.code } });
  assert.deepEqual(preview.json.items.map((i) => i.name), ['Tasks']);
  assert.equal((await hub.call('/api/people/join', { user: 'theo', body: { id: link.id, code: link.code } })).json.added, 1);
  assert.deepEqual((await mcpsOf(hub, 'theo')).map((m) => [m.name, m.url]), [['Tasks', 'https://tasks.example.com/mcp']]);
  assert.deepEqual(await mcpsOf(hub, 'nia'), [], 'what Nia had of it is gone too');
  const theos = async () => (await sams(hub)).people.find((p) => p.name === 'Theo');
  assert.deepEqual((await theos()).items.map((i) => i.name), ['Tasks']);

  await hub.call('/api/mcps/tasks', { user: 'theo', method: 'PATCH', body: { url: 'https://notes.example.com/mine', token: 'fixture-theo-own-token' } });
  const person = await theos();
  assert.deepEqual([person.items[0].state, person.signedIn, person.signIns], ['gone', 0, 0]);
  // What the person removed can be offered again.
  const again = await sam(`/api/people/${person.id}/items`, { body: { items: [own('tasks')] } });
  assert.deepEqual(again.json.person.items.map((i) => [i.name, i.state]), [['Tasks', 'offer']]);
});

test('only the record that the owner sees can use the share, and the owner can stop it in every state', async (t) => {
  const hub = await hosted(t);
  const sam = await fillSam(hub);
  await join(hub, [mine('notes')]);
  const agent = await hub.agent('theo');
  const { url } = (await mcpsOf(hub, 'theo'))[0];
  const hidden = await hub.call('/api/mcps', { user: 'theo', body: { name: 'Hidden', transport: 'http', url } });
  assert.deepEqual(hidden.json.mcp.tools, []);
  assert.match((await agent.run('hidden__read_note')).text, /has ended|not found/i);
  await hub.call('/api/mcps/notes', { user: 'theo', method: 'DELETE' });
  await hub.call('/api/mcps/hidden/sync', { user: 'theo', method: 'POST', body: {} });
  assert.equal((await agent.run('hidden__read_note')).isError, true);
  assert.equal(hub.up.seen.length, 0);
  assert.match((await hub.call('/api/mcps/hidden/oauth/start', { user: 'theo', method: 'POST', body: {} })).text, /account of somebody else/, 'a share has no sign-in');
  const [person] = (await sams(hub)).people;
  assert.equal(person.items[0].state, 'gone');
  assert.equal((await sam(`/api/people/${person.id}/items/${person.items[0].id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await mcpsOf(hub, 'theo'), [], 'and nothing of it stays');
});

test('a project link does not lend on what somebody lends', async (t) => {
  const hub = await hosted(t);
  await fillSam(hub);
  await join(hub, [mine('notes')]);
  const theo = hub.as('theo');
  await theo('/api/mcps', { body: { name: 'Own', transport: 'http', url: 'https://tasks.example.com/theo', token: 'fixture-theo-own-token' } });
  assert.equal((await theo('/api/profiles', { body: { name: 'Team' } })).status, 201);
  for (const id of ['notes', 'own']) await theo(`/api/mcps/${id}`, { method: 'PATCH', body: { profiles: ['team'] } });
  const link = await theo('/api/shares', { body: { profile: 'team', kind: 'other', ownerName: 'Theo' } });
  assert.ok([200, 201].includes(link.status), link.text);
  const { code } = link.json;
  assert.deepEqual((await hub.call(`/api/join/${code}`)).json.profile.connections, ['Own']);
  const minted = await hub.call(`/api/join/${code}/agents`, { user: 'nia', body: { kind: 'other', name: 'Nia' } });
  assert.equal(minted.status, 201, minted.text);
  const rpc = async (method, params) => (await hub.call('/mcp', {
    method: 'POST', headers: { Accept: 'application/json, text/event-stream', Authorization: `Bearer ${minted.json.token}` }, body: { jsonrpc: '2.0', id: 1, method, params },
  })).text;
  assert.match(await rpc('tools/call', { name: 'loop__run', arguments: { tool: 'own__read_note', arguments: {} } }), /ran read_note/);
  const calls = hub.up.seen.length;
  assert.match(await rpc('tools/call', { name: 'loop__run', arguments: { tool: 'notes__read_note', arguments: {} } }), /not found/);
  for (const args of [{ type: 'connections' }, { type: 'tools', query: 'note' }, { query: 'notes' }]) {
    assert.doesNotMatch(await rpc('tools/call', { name: 'loop__search', arguments: args }), /notes__|Sam's account/);
  }
  assert.equal(hub.up.seen.length, calls);
  // Theo's own agent of the same project uses both.
  assert.equal((await (await hub.agent('theo', { profile: 'team' })).run('notes__read_note')).text, 'ran read_note');
});

test('the end of the owner\'s plan stops what is lent, the open links and the offers', async (t) => {
  class Plans extends InviteStore {
    active = new Set(['sam', 'theo', 'nia'].map(key));
    async isInvited(ws) { return this.active.has(ws); }
  }
  const plans = new Plans(await tempDir(t), { env: {} });
  const hub = await hosted(t, {
    inviteStore: plans,
    billingEnv: { STRIPE_SECRET_KEY: 'sk_test_people_fixture', STRIPE_PRO_PRICE_ID: 'price_people_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_people_fixture' },
    billingFetch: async () => assert.fail('no call to Stripe'),
  });
  const sam = await fillSam(hub);
  await join(hub, [mine('notes')]);
  const [person] = (await sams(hub)).people;
  await sam(`/api/people/${person.id}/items`, { body: { items: [own('tasks')] } });
  const open = await invite(hub, [mine('tasks')], 'Nia');
  const agent = await hub.agent('theo');
  assert.equal((await agent.run('notes__read_note')).text, 'ran read_note');
  const [from] = (await hub.call('/api/people/from', { user: 'theo' })).json.from;
  const offer = from.items.find((i) => i.state === 'offer');

  plans.active.delete(key('sam'));
  const calls = hub.up.seen.length;
  assert.match((await agent.run('notes__read_note')).text, /cannot lend Notes now/);
  assert.equal(hub.up.seen.length, calls);
  assert.equal((await sam(`/api/people/invites/${open.id}/link`, { method: 'POST', body: {} })).status, 402);
  assert.equal((await hub.call('/api/people/preview', { body: { id: open.id, code: open.code } })).status, 404);
  assert.equal((await hub.call('/api/people/join', { user: 'nia', body: { id: open.id, code: open.code } })).status, 404);
  assert.equal((await hub.call(`/api/people/from/${from.id}/items/${offer.id}`, { user: 'theo', method: 'POST', body: {} })).status, 409);

  plans.active.add(key('sam'));
  assert.equal((await agent.run('notes__read_note')).text, 'ran read_note', 'with the plan it works again');
});

test('a lent connection does not write the memory of the owner', async (t) => {
  const hub = await hosted(t);
  const tools = TOOLS.splice(0, TOOLS.length, { name: 'add_memory', description: 'Store a memory', inputSchema: { type: 'object', properties: { content: { type: 'string' } } }, annotations: { readOnlyHint: false, destructiveHint: false } });
  t.after(() => TOOLS.splice(0, TOOLS.length, ...tools));
  const sam = await fillSam(hub);
  const set = await sam('/api/memory/config', { method: 'PATCH', body: { mode: 'external', externalConnectionId: 'notes' } });
  assert.equal(set.status, 200, set.text);
  await join(hub, [mine('notes')]);
  const res = await (await hub.agent('theo')).run('notes__add_memory', { content: 'Sam pays every invoice' });
  assert.match(res.text, /does not have permission to write Memory/);
  assert.equal(hub.up.seen.length, 0);
});

test('a slow accept holds nobody up, and what is stopped meanwhile does not stay', async (t) => {
  const people = new PeopleStore(await tempDir(t));
  const item = (id, share) => ({ id, kind: 'connection', ref: 'notes', name: 'Notes', mode: 'mine', share, seal: 'x' });
  const joined = async (ws, personKey, items) => {
    const made = await people.invite({ workspaceId: ws, ownerName: 'Sam', name: 'Theo', items });
    return people.join(made.invite.id, made.code, personKey);
  };
  const slow = await joined(WS, WS2, [item('a', 'aaaaaaaaaaaa'), item('b', 'bbbbbbbbbbbb')]);
  const other = await joined('c'.repeat(64), 'd'.repeat(64), [item('c', 'cccccccccccc')]);
  let go;
  const wait = new Promise((resolve) => { go = resolve; });
  const undone = [];
  const accept = people.accept(WS2, slow.id, null, async (i) => { await wait; return { connId: `conn_${i.id}` }; }, async (i) => undone.push(i.id));
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(await people.stop('c'.repeat(64), other.id, 'c'), 'another owner does not wait');
  assert.ok(await people.stop(WS, slow.id, 'a'), 'the same owner does not wait');
  go();
  const done = await accept;
  assert.deepEqual([done.done.map((i) => i.id), undone], [['b'], ['a']]);
  await assert.rejects(people.beginCall('aaaaaaaaaaaa', WS2, 'conn_a'), /has ended/);
  const call = await people.beginCall('bbbbbbbbbbbb', WS2, 'conn_b');
  await assert.rejects(people.beginCall('bbbbbbbbbbbb', WS2, 'conn_x'), /has ended/);

  // Stop counts from the moment it starts, also when the file is busy.
  let free;
  const busy = people._locked(() => new Promise((resolve) => { free = resolve; }));
  const stopping = people.stop(WS, slow.id, 'b');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(call.signal.aborted, true);
  await assert.rejects(people.beginCall('bbbbbbbbbbbb', WS2, 'conn_b'), /has ended/);
  free();
  await busy;
  assert.ok(await stopping);
});

test('a person sees no text of the owner\'s Loop when something cannot be added', async (t) => {
  const people = new PeopleStore(await tempDir(t));
  const made = await people.invite({ workspaceId: WS, ownerName: 'Sam', name: 'Theo', items: [{ id: 'a', kind: 'skill', ref: 'x', name: 'X' }] });
  const person = await people.join(made.invite.id, made.code, WS2);
  const res = await people.accept(WS2, person.id, null, async () => { throw new Error('/data/users/sam/secret-path'); });
  assert.equal(res.items[0].problem, 'It could not be added.');
  assert.deepEqual(addressParts('https://mcp.example.com/mcp?ref=sam-private').includes('sam-private'), true);
  assert.equal(addressParts('https://mcp.example.com/mcp?ref=sam-private')[0], encodeURIComponent('https://mcp.example.com/mcp?ref=sam-private'));
  // Names are words only, and the name that the person saw stays.
  const odd = await people.invite({ workspaceId: 'e'.repeat(64), ownerName: 'Sam "`x`" {{y}}', name: 'Nia; [z]', items: [] });
  assert.deepEqual([odd.invite.name, odd.invite.ownerName], ['Nia z', 'Sam x y']);
  await people.invite({ workspaceId: WS, ownerName: 'Your bank', name: 'Nia', items: [] });
  assert.equal((await people.fromFor(WS2))[0].ownerName, 'Sam');
});

test('remove and leave: what is lent ends, the person keeps their own', async (t) => {
  const hub = await hosted(t);
  const sam = await fillSam(hub);
  await join(hub, [mine('notes'), own('tasks')]);
  await join(hub, [mine('notes')], 'nia', 'Nia');
  const agent = await hub.agent('theo');
  const people = (await sams(hub)).people;
  const theo = people.find((p) => p.name === 'Theo');

  assert.equal((await hub.call(`/api/people/${theo.id}`, { user: 'nia', method: 'DELETE' })).status, 404);
  assert.equal((await sam(`/api/people/${theo.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await mcpsOf(hub, 'theo')).map((m) => m.name), ['Tasks']);
  assert.equal((await agent.run('notes__read_note')).isError, true);
  assert.deepEqual((await sams(hub)).people.map((p) => p.name), ['Nia']);
  assert.deepEqual((await hub.call('/api/people/from', { user: 'theo' })).json.from, []);

  const [from] = (await hub.call('/api/people/from', { user: 'nia' })).json.from;
  assert.equal((await hub.call(`/api/people/from/${from.id}`, { user: 'theo', method: 'DELETE' })).status, 404);
  assert.equal((await hub.call(`/api/people/from/${from.id}`, { user: 'nia', method: 'DELETE' })).status, 200);
  assert.deepEqual(await mcpsOf(hub, 'nia'), []);
  assert.deepEqual((await sams(hub)).people, []);
});

test('Add more only offers: nothing enters the person\'s Loop without their yes', async (t) => {
  const hub = await hosted(t);
  const sam = await fillSam(hub);
  await join(hub, [own('tasks')]);
  const [person] = (await sams(hub)).people;
  assert.equal((await hub.call(`/api/people/${person.id}/items`, { user: 'nia', body: { items: [own('notes')] } })).status, 404);
  const more = await sam(`/api/people/${person.id}/items`, { body: { items: [mine('notes'), own('tasks')] } });
  assert.equal(more.status, 200, more.text);
  assert.deepEqual(more.json.person.items.map((i) => [i.name, i.state]), [['Tasks', 'signin'], ['Notes', 'offer']], 'what they have is not offered again');
  assert.deepEqual((await mcpsOf(hub, 'theo')).map((m) => m.name), ['Tasks']);
  assert.equal(more.json.person.signIns, 1, 'an offer is not a sign-in');

  const [from] = (await hub.call('/api/people/from', { user: 'theo' })).json.from;
  const offer = from.items.find((i) => i.state === 'offer');
  assert.equal((await hub.call(`/api/people/from/${from.id}/items/${offer.id}`, { user: 'nia', method: 'POST', body: {} })).status, 404);
  const taken = await hub.call(`/api/people/from/${from.id}/items/${offer.id}`, { user: 'theo', method: 'POST', body: {} });
  assert.equal(taken.status, 200, taken.text);
  assert.equal(taken.json.item.state, 'mine');
  assert.equal((await (await hub.agent('theo')).run('notes__read_note')).text, 'ran read_note');

  // An offer that the owner takes back, and one whose connection is gone.
  await sam('/api/mcps', { body: { name: 'Later', transport: 'http', url: 'https://notes.example.com/later', token: SAM_TOKEN } });
  const offered = (await sam(`/api/people/${person.id}/items`, { body: { items: [own('later')] } })).json.person.items.find((i) => i.name === 'Later');
  await sam('/api/mcps/later', { method: 'DELETE' });
  const gone = await hub.call(`/api/people/from/${from.id}/items/${offered.id}`, { user: 'theo', method: 'POST', body: {} });
  assert.equal(gone.status, 409);
  assert.match(gone.json.error, /not there any more/);
  await sam('/api/mcps', { body: { name: 'Later', transport: 'http', url: 'https://notes.example.com/another', token: SAM_TOKEN } });
  assert.equal((await hub.call(`/api/people/from/${from.id}/items/${offered.id}`, { user: 'theo', method: 'POST', body: {} })).status, 409, 'another one under the same id is not it');
  assert.equal((await sam(`/api/people/${person.id}/items/${offered.id}`, { method: 'DELETE' })).status, 200);
});

test('a person\'s agent is told which sign-ins are left, with the link, until the last one is done', async (t) => {
  const hub = await hosted(t);
  await fillSam(hub);
  await join(hub, [own('tasks'), mine('notes')]);
  const agent = await hub.agent('theo');
  const start = () => agent.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  const first = (await start()).instructions;
  assert.match(first, /Sign-ins left/);
  assert.match(first, /#connections\?signin=tasks/);
  assert.doesNotMatch(first, /signin=notes/, 'a lent one needs no sign-in');
  const steps = async () => (await hub.call('/api/people/from?logos=1', { user: 'theo' })).json.from[0].items.map((i) => [i.connId, i.state, i.step]).sort();
  assert.deepEqual(await steps(), [['notes', 'mine', undefined], ['tasks', 'signin', 'signin']], 'the page of the invite shows what is left');
  const other = await hub.agent('theo', { name: 'Limited', allowedConnections: ['notes'] });
  assert.doesNotMatch((await other.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } })).instructions, /Sign-ins left/, 'not for an agent that may not use it');
  await hub.call('/api/mcps/tasks', { user: 'theo', method: 'PATCH', body: { token: 'fixture-theo-own-token' } });
  await hub.call('/api/mcps/tasks/sync', { user: 'theo', method: 'POST', body: {} });
  await until(async () => !/Sign-ins left/.test((await start()).instructions), 'no sign-in left');
  assert.deepEqual((await steps())[1], ['tasks', 'ready', undefined]);
  assert.doesNotMatch((await (await hub.agent('sam')).rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } })).instructions, /Sign-ins left/);
});

test('the page of an invite says that agents need a plan, until the person has one', async (t) => {
  const inviteStore = new InviteStore(await tempDir(t));
  const { slug } = await inviteStore.getOrCreateForUser({ workspaceId: key('nia'), inviterName: 'Nia' });
  await inviteStore.claim({ slug, claimerWorkspaceId: key('sam') });
  const hub = await hosted(t, {
    inviteStore,
    billingEnv: { STRIPE_SECRET_KEY: 'sk_test_people_fixture', STRIPE_PRO_PRICE_ID: 'price_people_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_people_fixture' },
    billingFetch: async () => assert.fail('no call to Stripe'),
  });
  const link = await invite(hub, []);
  const look = async (user) => (await hub.call('/api/people/preview', { user, body: { id: link.id, code: link.code } })).json.needsPlan;
  assert.deepEqual([await look(undefined), await look('theo'), await look('sam')], [true, true, false]);
  await inviteStore.claim({ slug, claimerWorkspaceId: key('theo') });
  assert.equal(await look('theo'), false);
});

test('the plan is checked for an invite', async (t) => {
  const paid = await hosted(t, {
    billingEnv: { STRIPE_SECRET_KEY: 'sk_test_people_fixture', STRIPE_PRO_PRICE_ID: 'price_people_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_people_fixture' },
    billingFetch: async () => assert.fail('no call to Stripe'),
  });
  assert.equal((await sams(paid)).canAdd, false);
  const no = await paid.call('/api/people/invites', { user: 'sam', body: { name: 'Theo', items: [] } });
  assert.equal(no.status, 402);
  assert.equal(no.json.upgradeRequired, true);
});

/* ---------------- a Loop on one computer ---------------- */
async function localLoop(t) {
  const up = upstream();
  let srv;
  const dataDir = await tempDir(t, async () => { await srv?.close(); });
  srv = await startServer({ port: 0, dataDir, detectLocalAgents: false, authMode: 'local-test', upstreamFetch: up.fetchUpstream });
  const base = `http://127.0.0.1:${srv.port}`;
  const json = { 'Content-Type': 'application/json' };
  const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: json, body: JSON.stringify({ password: 'fixture-owner-password' }) });
  const cookie = { Cookie: setup.headers.getSetCookie()[0].split(';')[0] };
  const call = async (route, body, { method, signedIn = true } = {}) => {
    const res = await fetch(base + route, { method: method || (body ? 'POST' : 'GET'), headers: { ...(signedIn ? cookie : {}), ...(body ? json : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, json: data };
  };
  return { base, call };
}
const startText = (raw) => `s1.${Buffer.from(JSON.stringify(raw)).toString('base64url')}`;

test('a Loop on one computer makes a link that holds its list, and the Loop of the person adds it', async (t) => {
  const sam = await localLoop(t);
  for (const [name, url] of [['Notes', 'https://notes.example.com/mcp?team=sam-team-42'], ['Tasks', 'https://tasks.example.com/mcp'], ['Mine', 'https://notes.example.com/u/83120457/mcp']]) {
    const made = await sam.call('/api/mcps', { name, transport: 'http', url, token: SAM_TOKEN });
    assert.equal(made.status, 201, made.text);
  }
  assert.equal((await sam.call('/api/people', null, { signedIn: false })).status, 401);
  assert.deepEqual((await sam.call('/api/people')).json, { available: true, local: true, owner: '', canAdd: true, people: [], invites: [], from: [] });
  const options = (await sam.call('/api/people/options')).json;
  assert.deepEqual([options.connections.map((c) => [c.name, c.own, c.mine]), options.skills, options.onlyYours], [[['Notes', true, false], ['Tasks', true, false]], [], 1]);

  for (const [body, status] of [[{ name: '', items: [own('notes')] }, 400], [{ name: 'Theo', items: [] }, 400], [{ name: 'Theo', items: [mine('notes')] }, 409], [{ name: 'Theo', items: [own('mine')] }, 409]]) {
    assert.equal((await sam.call('/api/people/invites', body)).status, status, JSON.stringify(body));
  }
  const made = await sam.call('/api/people/invites', { name: 'Theo', ownerName: 'Sam', items: [own('notes'), own('tasks')] });
  assert.equal(made.status, 201, made.text);
  assert.ok(made.json.url.startsWith(`${sam.base}/p/#s1.`), 'it opens a Loop on a computer, not the cloud');
  const data = made.json.url.split('#')[1];
  const plain = Buffer.from(data.slice(3), 'base64url').toString('utf8');
  for (const secret of [SAM_TOKEN, 'sam-team-42', '?', 'Theo']) assert.ok(!plain.includes(secret), secret);

  const theo = await localLoop(t);
  assert.equal((await fetch(`${theo.base}/p/`)).status, 200);
  assert.equal((await theo.call('/api/people/start/look', { data }, { signedIn: false })).status, 401);
  assert.equal((await theo.call('/api/people/start', { data }, { signedIn: false })).status, 401);
  const look = await theo.call('/api/people/start/look', { data });
  assert.deepEqual(look.json, { owner: 'Sam', items: [{ name: 'Notes', host: 'notes.example.com', state: 'add' }, { name: 'Tasks', host: 'tasks.example.com', state: 'add' }] });
  assert.deepEqual((await theo.call('/api/mcps')).json.mcps.filter((m) => m.transport !== 'builtin'), [], 'a look adds nothing');
  assert.deepEqual((await theo.call('/api/people/start', { data })).json, { added: 2, had: 0, failed: [] });
  const got = (await theo.call('/api/mcps')).json.mcps.filter((m) => m.transport !== 'builtin');
  assert.deepEqual(got.map((m) => [m.name, m.url, m.authRequired]), [['Notes', 'https://notes.example.com/mcp', true], ['Tasks', 'https://tasks.example.com/mcp', true]]);
  assert.deepEqual((await theo.call('/api/people/start', { data })).json, { added: 0, had: 2, failed: [] }, 'a second time adds nothing');
  const states = async (loop) => (await loop.call('/api/people/start/look', { data })).json.items.map((i) => [i.connId, i.state, i.step]);
  assert.deepEqual(await states(sam), [['notes', 'ready', undefined], ['tasks', 'ready', undefined]]);
  assert.deepEqual(await states(theo), [['notes', 'signin', 'signin'], ['tasks', 'signin', 'signin']], 'what is there but not signed in is a sign-in left');
  // A service without its own sign-in page wants a key.
  assert.equal((await theo.call('/api/mcps/notes/oauth/start', {})).json.signInBroken, true);
  assert.deepEqual((await states(theo))[0], ['notes', 'signin', 'key']);
  await theo.call('/api/mcps/notes', { token: 'fixture-theo-own-token' }, { method: 'PATCH' });
  await theo.call('/api/mcps/notes/sync', {});
  assert.deepEqual((await states(theo))[0], ['notes', 'ready', undefined]);
  await theo.call('/api/mcps/tasks', { enabled: false }, { method: 'PATCH' });
  assert.deepEqual((await states(theo))[1], ['tasks', 'off', undefined]);
  // Of two with the same address, the one that is on counts.
  await theo.call('/api/mcps', { name: 'Tasks too', transport: 'http', url: 'https://tasks.example.com/mcp', token: 'fixture-theo-own-token' });
  assert.deepEqual((await states(theo))[1], ['tasks_too', 'ready', undefined]);
  assert.equal((await sam.call('/api/people/preview', {})).status, 404);
});

test('a link that holds its list: only public addresses that are the same for everybody', () => {
  const good = startText(['Sam', [['Notes', 'notes.example.com/mcp'], ['Again', 'notes.example.com/mcp/'], ['Old', 'tasks.example.com/sse', 1]]]);
  assert.deepEqual(readStart(good), { owner: 'Sam', items: [{ name: 'Notes', url: 'https://notes.example.com/mcp', transport: 'http' }, { name: 'Old', url: 'https://tasks.example.com/sse', transport: 'sse' }] });
  for (const url of [
    '127.0.0.1/mcp', '0x7f000001/mcp', '2130706433/mcp', '[::1]/mcp', 'localhost/mcp', 'router.local/mcp', 'db.internal/mcp', 'nas.lan/mcp', 'intranet/mcp',
    'u:p@notes.example.com/mcp', 'notes.example.com/mcp?key=1', 'notes.example.com/mcp#x', 'notes.example.com/../mcp', 'notes.example.com/{{vault:KEY}}', 'NOTES.example.com/mcp',
    'people.useloop.sh/c/abcdefgh2345', 'relay.useloop.sh/d/dev_0123456789abcdef/x', 'notes.example.com/u/83120457/mcp', `notes.example.com/${'x/'.repeat(200)}`, '', ' ',
  ]) assert.equal(readStart(startText(['Sam', [['Notes', url]]])), null, url);
  const row = ['Notes', 'notes.example.com/mcp'];
  for (const raw of [null, [], ['Sam'], ['Sam', []], ['Sam', [null]], ['Sam', [['', 'notes.example.com/mcp']]], ['Sam', [['Notes']]], ['Sam', { length: 1 }], ['Sam', Array(21).fill(row)]]) assert.equal(readStart(startText(raw)), null, JSON.stringify(raw)?.slice(0, 60));
  for (const text of [null, 1, '', 's1.', 's1.@@', 's2.abc', `s1.${'A'.repeat(7000)}`, 's1.bm90IGpzb24']) assert.equal(readStart(text), null, String(text).slice(0, 20));
  assert.deepEqual(readStart(startText([{ a: 1 }, [['No`tes; {x}', 'notes.example.com/mcp']]])), { owner: '', items: [{ name: 'No tes x', url: 'https://notes.example.com/mcp', transport: 'http' }] });
});
