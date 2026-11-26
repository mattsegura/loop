import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Vault } from '../lib/vault.mjs';
import { startServer } from '../server.mjs';

test('atomic create-only check rejects occupied keys and tombstones', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-capture-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vault = new Vault(dir);
  const write = () => new Vault(dir)._set('collision', 'synthetic-only', {}, null, true);
  const outcomes = await Promise.allSettled([write(), write()]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  await vault.delete('collision');
  await assert.rejects(write, /unavailable/);
  const form = vault.openCaptureForm({type:'api_key', label:'Credential', profile:'all'});
  vault.captureForms.get(form).expires = Date.now() - 1;
  await assert.rejects(vault.submitCaptureForm(form, 'synthetic-only'), /expired/);
});

test('capture via MCP and authenticated secure form creates private, encrypted, separate entries', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-capture-http-'));
  const srv = await startServer({ authMode: 'local-test', dataDir: dir, port: 0 });
  t.after(async () => { await srv.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${srv.port}`;
  const post = (route, body, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const setup = await post('/api/auth/setup', { password: 'synthetic-test-password' });
  const owner = { Cookie: setup.headers.get('set-cookie').split(';')[0] };
  const agent = async canManage => (await post('/api/agents', { name: canManage ? 'Capturer' : 'Reader', canManage, kind: 'other', profile: 'all' }, owner)).json();
  const manager = await agent(true), reader = await agent(false);
  const call = async (args, client = manager) => (await (await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'loop__save', arguments: args } }, { Authorization: `Bearer ${client.token}` })).json()).result;
  const value = 'synthetic-test-credential-not-valid';
  const args = { type: 'api_key', action: 'capture', id: 'Example account', data: { value } };
  assert.equal((await call(args, reader)).isError, true);
  assert.equal((await call({ ...args, approval: 'auto' })).isError, true);
  assert.equal((await call({ ...args, data: { value, profiles: ['all'] } })).isError, true);
  const captures = await Promise.all([call(args), call(args)]);
  for (const result of captures) {
    assert.equal(result.isError, false);
    assert.equal(JSON.stringify(result).includes(value), false);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(result.structuredContent.grantsAdded, false);
  }
  assert.notEqual(captures[0].structuredContent.key, captures[1].structuredContent.key);
  const handoff = (await call({ type: 'login', action: 'capture' })).structuredContent;
  assert.equal(handoff.saved, false);
  const url = new URL(handoff.formUrl);
  assert.equal(url.origin, base);
  const form = /^#vault\?capture=([a-f0-9]{48})$/.exec(url.hash)[1];
  assert.equal((await post('/api/vault/capture', { form, value })).status, 401);
  assert.deepEqual(await (await post('/api/vault/capture', { form }, owner)).json(), { type: 'login', label: 'Credential' });
  const submit = () => post('/api/vault/capture', { form, value }, owner);
  const replies = await Promise.all([submit(), submit()]);
  assert.deepEqual(replies.map(r => r.status).sort(), [201, 410]);
  const disk = new Vault(dir);
  const items = await disk.list();
  assert.equal(items.length, 3);
  assert.equal(items.filter(m => m.description === 'Example account').length, 2);
  for (const item of items) {
    assert.equal(await disk.get(item.key), value);
    assert.deepEqual(item.allowedSinks, []);
    assert.equal(item.approval, 'inherit');
  }
  const overview = await (await fetch(base + '/api/overview', { headers: owner })).json();
  assert.equal(JSON.stringify(overview).includes(value), false);
  const agents = await (await fetch(base + '/api/agents', { headers: owner })).json();
  assert.ok(agents.agents.length >= 2);
  for (const a of agents.agents) assert.deepEqual(a.secrets || [], []);
  const policyUpdate = await fetch(base + '/api/policies', { method: 'PATCH', headers: { ...owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ default: 'always_ask' }) });
  assert.equal(policyUpdate.status, 200);
  const pending = await call(args);
  assert.ok(!JSON.stringify(pending).includes(value));
  const approval = JSON.parse(pending.content[0].text);
  assert.equal(approval.status, 'approval_required');
  const queue = await (await fetch(base + '/api/approvals', {headers:owner})).json();
  assert.equal(queue.pending.length, 1);
  assert.ok(!JSON.stringify(queue).includes(value));
  assert.equal((await disk.list()).length, 3);
  const approved = await post('/api/approvals/' + approval.approvalId + '/approve', {}, owner);
  assert.equal(approved.status, 200);
  const final = await call({ ...args, approvalId: approval.approvalId });
  assert.equal(final.structuredContent.saved, true);
  assert.equal((await disk.list()).length, 4);
  assert.ok(!(await readFile(path.join(dir, 'vault.json'), 'utf8')).includes(value));
});
