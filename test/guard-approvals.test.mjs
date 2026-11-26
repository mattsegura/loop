// The Guard mode: a yes that only the owner can give, on the Loop page, with the Loop password.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ApprovalQueue,
  PolicyStore,
  canAlwaysAllow,
  ownActionRule,
  patchSetsGuard,
  policiesLeaveGuard,
  stricterRule,
  vaultItemLeavesGuard,
} from '../lib/policies.mjs';
import { buildApprovalUiSpec } from '../lib/json-render-ui.mjs';
import { startServer } from '../server.mjs';

const PASSWORD = 'only-for-local-regression';
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) {
    try { await cleanups.pop()(); } catch { /* ignore */ }
  }
});

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const MAILER = {
  id: 'mailer',
  name: 'Mailer',
  tools: [
    { name: 'read', annotations: { readOnlyHint: true } },
    { name: 'send', annotations: { readOnlyHint: false, destructiveHint: false } },
    { name: 'wipe', annotations: { destructiveHint: true } },
  ],
};
const guarded = (source) => ({ decision: 'always_ask', guard: true, source });
const pick = ({ decision, guard, source }) => (guard ? { decision, guard, source } : { decision, source });

describe('Guard rules', () => {
  it('can hold every tool call, one kind of tool, a connection, a tool, a Vault kind, and one item', async () => {
    const policies = new PolicyStore(tempDir('loop-guard-'));
    const run = async (toolName, referencedSecrets = []) => pick(await policies.evaluateRun({ conn: MAILER, toolName, referencedSecrets }));
    assert.deepEqual(await run('send'), { decision: 'auto', source: 'default' });

    await policies.update({ toolKinds: { destructive: 'guard' } });
    assert.deepEqual(await run('wipe'), guarded('toolKind:destructive'));
    assert.deepEqual(await run('send'), { decision: 'auto', source: 'default' });

    await policies.update({ default: 'guard' });
    assert.deepEqual(await run('read'), guarded('default'));

    const own = new PolicyStore(tempDir('loop-guard-'));
    const runOwn = async (toolName, referencedSecrets = []) => pick(await own.evaluateRun({ conn: MAILER, toolName, referencedSecrets }));
    await own.update({ connections: { mailer: 'guard' }, tools: { mailer__read: 'auto' } });
    assert.deepEqual(await runOwn('send'), guarded('connection:mailer'));
    assert.deepEqual(await runOwn('read'), { decision: 'auto', source: 'tool:mailer__read' });

    const cards = new PolicyStore(tempDir('loop-guard-'));
    const runCard = async (approval) => pick(await cards.evaluateRun({
      conn: MAILER,
      toolName: 'send',
      referencedSecrets: [{ key: 'VISA', type: 'payment', approval }],
    }));
    await cards.update({ vaultTypes: { payment: 'guard' } });
    assert.deepEqual(await runCard('inherit'), guarded('vaultType:payment'));
    // A card with its own mode does not follow the other cards.
    assert.deepEqual(await runCard('always_ask'), { decision: 'always_ask', source: 'secret:VISA' });
    assert.deepEqual(await runCard('auto'), { decision: 'auto', source: 'default' });
  });

  it('takes the stricter of the tool and the Vault item, both ways', async () => {
    const policies = new PolicyStore(tempDir('loop-guard-'));
    const run = async (approval) => pick(await policies.evaluateRun({
      conn: MAILER,
      toolName: 'send',
      referencedSecrets: [{ key: 'VISA', type: 'payment', approval }],
    }));
    await policies.update({ tools: { mailer__send: 'auto' } });
    assert.deepEqual(await run('always_ask'), { decision: 'always_ask', source: 'secret:VISA' });
    assert.deepEqual(await run('guard'), guarded('secret:VISA'));
    await policies.update({ tools: { mailer__send: 'guard' } });
    assert.deepEqual(await run('auto'), guarded('tool:mailer__send'));
    assert.deepEqual(await run('always_ask'), guarded('tool:mailer__send'));
  });

  it('holds an action when the action, the item, or the Vault kind is on Guard', async () => {
    const policies = new PolicyStore(tempDir('loop-guard-'));
    assert.deepEqual(pick(await policies.evaluateAction({ action: 'delete', vaultType: 'payment', itemApproval: 'guard' })), guarded('item'));
    await policies.update({ actions: { delete: 'guard' } });
    assert.deepEqual(pick(await policies.evaluateAction({ action: 'delete', itemApproval: 'auto' })), guarded('action:delete'));
    assert.deepEqual(pick(ownActionRule(await policies.get(), 'delete')), guarded('action:delete'));
    assert.equal(ownActionRule(await policies.get(), 'nothing_here'), null);
    const ask = { decision: 'always_ask', source: 'a' };
    assert.equal(stricterRule(ask, { decision: 'always_ask', guard: true, source: 'b' }).source, 'b');
    assert.equal(stricterRule(ask, { decision: 'always_ask', source: 'b' }).source, 'a');
    assert.equal(stricterRule(null, ask), ask);
  });

  it('never comes off Guard without the owner, however the change is written', async () => {
    const policies = new PolicyStore(tempDir('loop-guard-'), { listConnections: async () => [MAILER] });
    await policies.update({
      connections: { bank: 'guard' },
      tools: { shop__buy: 'guard' },
      vaultTypes: { payment: 'guard' },
      toolKinds: { destructive: 'guard' },
      actions: { delete: 'guard' },
    });
    const refused = [
      { connections: { bank: 'auto' } },
      { connections: { bank: 'always_ask' } },
      { connections: { bank: 'inherit' } },
      { connections: { bank: null } },
      { tools: { shop__buy: 'auto' } },
      { tools: { bank__pay: 'auto' } }, // a tool rule under a connection on Guard
      { vaultTypes: { payment: 'always_ask' } },
      { toolKinds: { destructive: 'auto' } },
      { actions: { delete: 'auto' } },
      { actions: { delete: null } }, // back to its default, which is Ask
      { tools: { mailer__wipe: 'auto' } }, // a tool that says it can delete
      { connections: { mailer: 'auto' } }, // a connection that has such a tool
    ];
    for (const patch of refused) {
      await assert.rejects(() => policies.update(patch), { code: 'guard_password', status: 403 }, JSON.stringify(patch));
    }
    // Rules that no Guard touches still save, and Guard can always be added.
    await policies.update({ tools: { mailer__send: 'auto' }, default: 'always_ask', connections: { shop: 'guard' } });
    await policies.update({ connections: { bank: 'auto' } }, { ownerConfirmed: true });
    assert.equal((await policies.get()).connections.bank, 'auto');
  });

  it('counts an unknown tool or connection as one that Guard can hold', () => {
    const base = { default: 'auto', vaultTypes: {}, categories: {}, connections: {}, tools: {}, toolKinds: { destructive: 'guard' }, actions: {} };
    const after = { ...base, tools: { new__tool: 'auto' } };
    assert.equal(policiesLeaveGuard(base, after), true);
    assert.equal(policiesLeaveGuard(base, after, [MAILER]), true);
    assert.equal(policiesLeaveGuard(base, { ...base, tools: { mailer__send: 'auto' } }, [MAILER]), false);
    assert.equal(patchSetsGuard({ default: 'guard' }), true);
    assert.equal(patchSetsGuard({ vaultTypes: { payment: 'GUARD' } }), true);
    assert.equal(patchSetsGuard({ vaultTypes: { payment: 'always_ask' } }), false);
  });

  it('knows when a Vault item leaves Guard by its own mode or by its kind', () => {
    const policies = { vaultTypes: { payment: 'guard', note: 'auto' } };
    const leaves = (before, after) => vaultItemLeavesGuard(policies, before, after);
    assert.equal(leaves({ type: 'note', approval: 'guard' }, { type: 'note', approval: 'inherit' }), true);
    assert.equal(leaves({ type: 'payment', approval: 'inherit' }, { type: 'note', approval: 'inherit' }), true);
    assert.equal(leaves({ type: 'payment', approval: 'inherit' }, { type: 'payment', approval: 'auto' }), true);
    assert.equal(leaves({ type: 'payment', approval: 'guard' }, { type: 'payment', approval: 'inherit' }), false);
    assert.equal(leaves({ type: 'note', approval: 'always_ask' }, { type: 'note', approval: 'auto' }), false);
  });

  it('offers "always allow" only where it can change something', () => {
    const run = (extra) => canAlwaysAllow({ kind: 'run', detail: { rule: 'toolKind:destructive' }, ...extra });
    assert.equal(run({}), true);
    assert.equal(run({ guard: true }), false);
    assert.equal(run({ detail: { rule: 'secret:VISA' } }), false);
    assert.equal(run({ detail: { rule: 'vaultType:login' } }), false);
    assert.equal(run({ kind: 'delete' }), false);
  });
});

describe('Guard requests', () => {
  const ask = (queue, extra = {}) => queue.create({
    agentId: 'a1',
    agentName: 'Agent',
    kind: 'run',
    title: 'Use card',
    target: 'mailer__send',
    fingerprint: 'f1',
    detail: {},
    guard: true,
    ...extra,
  });

  it('refuses a plain yes, takes a no, and runs one time after the owner confirms', () => {
    const queue = new ApprovalQueue();
    const record = ask(queue);
    assert.equal(record.guard, true);
    const plain = queue.approve(record.id);
    assert.equal(plain.ok, false);
    assert.equal(plain.status, 403);
    assert.equal(plain.reason, 'guard');
    assert.equal(queue.get(record.id).status, 'pending');
    assert.equal(queue.approve(record.id, null, { ownerConfirmed: true }).ok, true);
    const use = () => queue.consume(record.id, 'f1', { agentId: 'a1', guard: true });
    assert.equal(use().ok, true);
    assert.equal(use().ok, false);

    const other = ask(queue, { fingerprint: 'f2' });
    assert.equal(queue.deny(other.id).ok, true);
  });

  it('does not let an old plain yes open something that went onto Guard', () => {
    const queue = new ApprovalQueue();
    const record = ask(queue, { guard: false });
    assert.equal(queue.approve(record.id).ok, true);
    const used = queue.consume(record.id, 'f1', { agentId: 'a1', guard: true });
    assert.equal(used.ok, false);
    assert.equal(used.status, 'guard');
  });

  it('follows the rule when the same request is asked again', () => {
    const queue = new ApprovalQueue();
    const first = ask(queue, { guard: false });
    const again = ask(queue);
    assert.equal(again.id, first.id);
    assert.equal(queue.get(first.id).guard, true);
    assert.equal(queue.approve(first.id).ok, false);
  });

  it('is still on Guard after a restart', async () => {
    const dir = tempDir('loop-guard-queue-');
    const queue = new ApprovalQueue({ dir });
    const record = ask(queue);
    await queue.close?.();
    await queue.flush?.();
    const reopened = new ApprovalQueue({ dir });
    cleanups.push(() => reopened.close?.());
    assert.equal(reopened.get(record.id)?.guard, true);
    assert.equal(reopened.approve(record.id).ok, false);
  });

  it('shows a chat card with the Loop address and no way to say yes', () => {
    const spec = buildApprovalUiSpec({
      kind: 'run',
      title: 'Use card',
      target: 'mailer__send',
      evalRes: { decision: 'always_ask', guard: true, source: 'secret:VISA', reason: 'Vault secret "VISA" is on Guard' },
      detail: { rule: 'secret:VISA' },
      confirmUrl: 'http://127.0.0.1:8799/#approvals?id=apr_1',
    });
    const text = JSON.stringify(spec);
    assert.match(text, /#approvals\?id=apr_1/);
    assert.doesNotMatch(text, /"decision":"approve"/);
    assert.match(text, /"decision":"deny"/);
  });
});

/* ---------- end to end ---------- */

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// An upstream with one tool that says it adds or changes things.
async function startMailer() {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(req.method === 'DELETE' ? 204 : 405);
      res.end();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    const msg = raw ? JSON.parse(raw) : {};
    const reply = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    };
    if (msg.method === 'initialize') {
      return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1.0.0' } });
    }
    if (msg.method === 'tools/list') {
      return reply({
        tools: [{
          name: 'send_note',
          description: 'Send a note',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          annotations: { readOnlyHint: false, destructiveHint: false },
        }],
      });
    }
    if (msg.method === 'tools/call') {
      calls.push(msg.params);
      return reply({ content: [{ type: 'text', text: `sent ${msg.params?.arguments?.text || ''}` }] });
    }
    // A request always gets an answer; a notification has no id and gets none.
    if (msg.id !== undefined) return reply({});
    res.writeHead(202);
    return res.end();
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => { srv.closeAllConnections?.(); srv.close(resolve); }));
  return { url: `http://127.0.0.1:${srv.address().port}/mcp`, calls };
}

async function setup({ elicitation = null } = {}) {
  const dir = tempDir('loop-guard-e2e-');
  const stub = await startMailer();
  const bridgeSecret = 'test-bridge-secret';
  const before = process.env.LOOP_TEXT_INTERNAL_SECRET;
  process.env.LOOP_TEXT_INTERNAL_SECRET = bridgeSecret;
  cleanups.push(() => {
    if (before === undefined) delete process.env.LOOP_TEXT_INTERNAL_SECRET;
    else process.env.LOOP_TEXT_INTERNAL_SECRET = before;
  });
  const app = await startServer({
    dataDir: dir,
    home: dir,
    port: 0,
    authMode: 'local-test',
    hosted: false,
    autoSync: false,
    detectLocalAgents: false,
    searchEnv: { LOOP_EMBEDDING_PROVIDER: 'off' },
    smsAgentEnv: { LOOP_TEXT_INTERNAL_SECRET: bridgeSecret },
  });
  cleanups.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const first = await request(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(first.status, 200);
  const cookie = String([].concat(first.headers['set-cookie'])[0] || '').split(';')[0];
  const api = (pathname, method = 'GET', body = undefined) => request(`${base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const added = await api('/api/mcps', 'POST', { name: 'Mailer', url: stub.url });
  assert.equal(added.status, 201);
  const connId = added.json.mcp.id;
  assert.equal((await api(`/api/mcps/${connId}/sync`, 'POST')).status, 200);
  const made = await api('/api/agents', 'POST', { name: 'Claude Code', profile: 'all', canManage: true });
  assert.equal(made.status, 201);
  const token = made.json.token;
  const mcp = (sessionId, body) => request(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: elicitation ? 'application/json, text/event-stream' : 'application/json',
      Authorization: `Bearer ${token}`,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const init = await mcp(null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: elicitation ? { elicitation } : {},
      clientInfo: { name: 'claude-code', version: '2.1.76' },
    },
  });
  const sessionId = init.headers['mcp-session-id'];
  let id = 1;
  const call = async (name, args) => {
    id += 1;
    const res = await mcp(sessionId, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    let message = res.json;
    if (!message) {
      const frames = res.text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
      assert.equal(frames.some((f) => f.method === 'elicitation/create' && f.params.mode !== 'url'), false, 'Guard never asks in a form');
      message = frames.at(-1);
    }
    const text = message.result.content[0].text;
    let json = null;
    try { json = JSON.parse(text); } catch { /* plain text */ }
    return { isError: message.result.isError === true, text, json };
  };
  const callNoKey = async (name, args) => {
    const res = await request(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name, arguments: args } }),
    });
    const result = res.json.result;
    return { isError: result.isError === true, text: result.content[0].text };
  };
  const send = (text, extra = {}) => call('loop__run', { tool: `${connId}__send_note`, arguments: { text }, ...extra });
  const bridge = (pathname, body) => request(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Loop-Text-Secret': bridgeSecret },
    body: JSON.stringify(body),
  });
  return { base, api, bridge, call, callNoKey, send, connId, stub };
}

describe('Guard end to end', () => {
  it('runs a tool on Guard only after the Loop password, one time, and never from a text', async () => {
    const { api, bridge, send, connId, stub } = await setup();
    assert.equal((await api('/api/policies', 'PATCH', { connections: { [connId]: 'guard' } })).status, 200);

    const held = await send('one');
    assert.equal(held.json.status, 'approval_required');
    assert.equal(held.json.guard, true);
    assert.ok(held.json.confirmUrl.endsWith(`#approvals?id=${held.json.approvalId}`));
    const id = held.json.approvalId;

    // A text, a tapped link, or the dashboard's yes without the password: refused, still open.
    for (const body of [{ decision: 'approve' }, { decision: 'approve', source: 'link', alwaysAllow: 'tool' }]) {
      const res = await bridge(`/api/sms-bridge/approvals/${id}/decide`, body);
      assert.equal(res.status, 403);
      assert.equal(res.json.error, 'guard');
    }
    for (const [pathname, body] of [
      [`/api/approvals/${id}/approve`, undefined],
      [`/api/approvals/${id}/decide`, { decision: 'approve' }],
      [`/api/approvals/${id}/approve`, { password: 'not-the-password' }],
      [`/api/approvals/${id}/decide`, { decision: 'approve', alwaysAllow: 'tool', password: '' }],
    ]) {
      const res = await api(pathname, 'POST', body);
      assert.equal(res.status, 403, pathname);
      assert.equal(res.json.code, 'guard_password');
    }
    assert.equal((await api(`/api/approvals/${id}`)).json.approval.status, 'pending');
    assert.equal((await send('one', { approvalId: id })).json?.status, 'approval_required');
    assert.equal(stub.calls.length, 0);

    const yes = await api(`/api/approvals/${id}/approve`, 'POST', { password: PASSWORD, alwaysAllow: true });
    assert.equal(yes.status, 200);
    assert.notEqual(yes.json.alwaysAllowed, true);
    const ran = await send('one', { approvalId: id });
    assert.match(ran.text, /sent one/);
    assert.equal(stub.calls.length, 1);

    // One use: the next call asks again, and the rule is still Guard.
    const next = await send('one');
    assert.equal(next.json.status, 'approval_required');
    assert.notEqual(next.json.approvalId, id);
    assert.equal((await api('/api/policies')).json.policies.connections[connId], 'guard');
    assert.equal(stub.calls.length, 1);
  });

  it('does not take the password of a request from an agent', async () => {
    const { api, call, send, connId, stub } = await setup();
    await api('/api/policies', 'PATCH', { connections: { [connId]: 'guard' } });
    const held = await send('one');
    const again = await send('one', { approvalId: held.json.approvalId, password: PASSWORD });
    assert.equal(again.isError || again.json?.status === 'approval_required', true);
    assert.equal(stub.calls.length, 0);
    const approve = await call('loop__run', { tool: 'loop__approve', arguments: { id: held.json.approvalId, password: PASSWORD } });
    assert.equal(stub.calls.length, 0);
    assert.notEqual(approve.json?.status, 'approved');
  });

  it('asks an app that can show a form only to open the Loop page', async () => {
    const { api, send, connId, stub } = await setup({ elicitation: { form: {} } });
    await api('/api/policies', 'PATCH', { connections: { [connId]: 'guard' } });
    const held = await send('one');
    assert.equal(held.json.status, 'approval_required');
    assert.equal(held.json.guard, true);
    assert.equal(stub.calls.length, 0);
  });

  it('holds a card on Guard for a tool that is on Allow', async () => {
    const { api, send, connId, stub } = await setup();
    assert.equal((await api('/api/vault', 'POST', { key: 'VISA', value: 'test-card-value', type: 'payment', approval: 'guard' })).status, 201);
    await api('/api/policies', 'PATCH', { tools: { [`${connId}__send_note`]: 'auto' } });
    const agents = (await api('/api/agents')).json.agents;
    await api(`/api/agents/${agents[0].id}`, 'PATCH', { secrets: ['VISA'] });
    const held = await send('{{vault:VISA}}');
    assert.equal(held.json?.status, 'approval_required', held.text);
    assert.equal(held.json.guard, true);
    assert.equal(stub.calls.length, 0);
  });

  it('asks for the password to take a rule or a Vault item off Guard', async () => {
    const { api, connId } = await setup();
    await api('/api/policies', 'PATCH', { connections: { [connId]: 'guard' }, vaultTypes: { payment: 'guard' } });
    for (const patch of [{ connections: { [connId]: 'auto' } }, { vaultTypes: { payment: 'always_ask' } }, { tools: { [`${connId}__send_note`]: 'auto' } }]) {
      const none = await api('/api/policies', 'PATCH', patch);
      assert.equal(none.status, 403);
      assert.equal(none.json.code, 'guard_password');
      const wrong = await api('/api/policies', 'PATCH', { ...patch, password: 'nope-nope' });
      assert.equal(wrong.status, 403);
      assert.equal(wrong.json.error, 'Wrong password.');
    }
    const saved = await api('/api/policies', 'PATCH', { connections: { [connId]: 'always_ask' }, password: PASSWORD });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.policies.connections[connId], 'always_ask');
    assert.equal(JSON.stringify(saved.json).includes(PASSWORD), false);

    await api('/api/vault', 'POST', { key: 'NOTE_A', value: 'a private line', type: 'note', approval: 'guard' });
    for (const body of [{ approval: 'auto' }, { approval: 'inherit' }]) {
      const res = await api('/api/vault/NOTE_A', 'PATCH', body);
      assert.equal(res.status, 403);
      assert.equal(res.json.code, 'guard_password');
    }
    const again = await api('/api/vault', 'POST', { key: 'NOTE_A', value: 'another line', type: 'note', approval: 'auto' });
    assert.equal(again.status, 403);
    assert.equal((await api('/api/vault/NOTE_A', 'PATCH', { approval: 'auto', password: PASSWORD })).status, 200);
    // A description is no rule, so it needs no password.
    await api('/api/vault/NOTE_A', 'PATCH', { approval: 'guard' });
    assert.equal((await api('/api/vault/NOTE_A', 'PATCH', { description: 'Door code' })).status, 200);
  });

  it('locks password tries the same way as sign-in', async () => {
    const { api, send, connId } = await setup();
    await api('/api/policies', 'PATCH', { connections: { [connId]: 'guard' } });
    const { approvalId } = (await send('one')).json;
    let last = null;
    for (let i = 0; i < 12 && last?.status !== 429; i += 1) {
      last = await api(`/api/approvals/${approvalId}/approve`, 'POST', { password: `wrong-${i}` });
    }
    assert.equal(last.status, 429);
    assert.equal((await api(`/api/approvals/${approvalId}`)).json.approval.status, 'pending');
  });

  it('does not let an agent, or a client with no key, lower Guard', async () => {
    const { api, call, callNoKey, connId } = await setup();
    assert.equal((await api('/api/settings', 'PATCH', { requireAgentToken: false })).status, 200);
    await api('/api/policies', 'PATCH', { connections: { [connId]: 'guard' } });
    await api('/api/vault', 'POST', { key: 'VISA', value: 'test-card-value', type: 'payment', approval: 'guard' });
    const rule = async () => (await api('/api/policies')).json.policies.connections[connId];
    const card = async () => (await api('/api/vault')).json.secrets.find((s) => s.key === 'VISA');
    for (const approval of ['auto', 'always_ask', 'inherit']) {
      // An agent cannot change a rule at all.
      const agent = await call('loop__save', { type: 'connection', id: connId, data: {}, approval });
      assert.equal(agent.isError, true, approval);
      assert.equal(await rule(), 'guard', approval);
      // With "Require an agent key" off, a client with no key can: but not this one.
      await callNoKey('loop__save', { type: 'connection', id: connId, data: {}, approval });
      assert.equal(await rule(), 'guard', approval);
      const item = await callNoKey('loop__save', { type: 'payment', id: 'VISA', data: { description: 'Card' }, approval });
      assert.equal(item.isError, true, item.text);
      assert.equal((await card()).approval, 'guard', approval);
    }
    // It can make a rule stricter.
    await api('/api/policies', 'PATCH', { connections: { [connId]: 'auto' }, password: PASSWORD });
    await callNoKey('loop__save', { type: 'connection', id: connId, data: {}, approval: 'guard' });
    assert.equal(await rule(), 'guard');
  });
});
