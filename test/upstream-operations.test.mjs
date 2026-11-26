import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ApprovalQueue } from '../lib/policies.mjs';
import { LoopStore } from '../lib/store.mjs';
import { Vault } from '../lib/vault.mjs';
import { ConnectionPool } from '../lib/mcp-client.mjs';
import { handleMcpRequest } from '../lib/mcp-server.mjs';
import { reserveOperation, completeOperation, OPERATION_WINDOW_MS, OPERATION_LIMIT } from '../lib/upstream-operations.mjs';

test('durable receipts fence committed writes across gateway reopen and direct/wrapped calls', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-receipts-'));
  let store, vault, pool;
  function open() { store = new LoopStore(dir); vault = new Vault(dir); pool = new ConnectionPool(store, vault); }
  open();
  t.after(async () => { try { await pool.close(); } finally { await rm(dir, { recursive: true, force: true }); } });
  const log = join(dir, 'upstream.log');
  const conn = await store.add({ name: 'ledger', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/interrupted-write.mjs', import.meta.url)), log] });
  await pool.sync(conn.id);
  const tool = `${conn.id}__append_record`;
  let id = 0;
  const call = async (operationId, drop, { direct = false, agent, policyStore, approvalQueue } = {}) => {
    const params = direct ? { name: tool, arguments: { drop }, _meta: { 'loop/operationId': operationId } }
      : { name: 'loop__run', arguments: { tool, operationId, arguments: { drop } } };
    const res = await handleMcpRequest(store, vault, pool, { jsonrpc: '2.0', id: ++id, method: 'tools/call', params }, { agent, policyStore, approvalQueue });
    return res.result?.content[0]?.text ?? res.error?.message;
  };
  assert.match(await call('first', true), /uncertain/);
  await pool.close(); open();
  assert.match(await call('first', true, { direct: true }), /uncertain/);
  assert.match(await call('first', false), /conflict/);
  assert.equal(await readFile(log, 'utf8'), 'committed\n');
  const both = await Promise.all([call('second', false), call('second', false)]);
  assert.equal(both.filter(v => v === 'private fixture result').length, 1);
  assert.match(await call('second', false), /completed/);
  assert.doesNotMatch(await call('second', false), /private fixture result/);
  assert.doesNotMatch(await readFile(join(dir, 'upstream-operations.sqlite'), 'latin1'), /private fixture result/);
  assert.match(await call('second', false, { agent: { id: 'separate', profile: 'all' } }), /private fixture result/);
  const pending = JSON.parse(await call('second', false, { approvalQueue: new ApprovalQueue(), policyStore: {
    evaluateRun: async () => ({ decision: 'always_ask', reason: 'new policy' }),
  } }));
  assert.equal(pending.code, 'pending');
  assert.equal(await readFile(log, 'utf8'), 'committed\n'.repeat(3));
  await store.update(conn.id, { enabled: false });
  assert.doesNotMatch(await call('second', false), /completed|private fixture result/);
});

test('canonical request and expiring reservations fence late completions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-window-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reserve = (args, time) => reserveOperation(dir, ['agent', 'work'], 'key', args, time);
  const first = reserve({ x: 1, y: 2 }, 0);
  assert.equal(reserve({ y: 2, x: 1 }, 1).state, 'uncertain');
  assert.equal(reserve({ x: 2 }, 2).state, 'conflict');
  const next = reserve({ x: 2 }, OPERATION_WINDOW_MS);
  assert.equal(next.state, 'reserved');
  assert.equal(completeOperation(dir, first), false);
  assert.equal(completeOperation(dir, next), true);
  assert.equal(reserve({ x: 2 }, OPERATION_WINDOW_MS + 1).state, 'completed');
});

test('capacity refuses new operations without evicting uncertain receipts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-cap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reserve = key => reserveOperation(dir, 'owner', key, 'request', 0);
  assert.equal(reserve('original').state, 'reserved');
  const db = new DatabaseSync(join(dir, 'upstream-operations.sqlite'));
  try {
    db.exec('BEGIN');
    const insert = db.prepare('INSERT INTO receipts(id,fingerprint,ticket,expires) VALUES(?, ?, ?, ?)');
    for (let i = 1; i < OPERATION_LIMIT; i++) insert.run(String(i), 'f', 't', OPERATION_WINDOW_MS);
    db.exec('COMMIT');
  } finally { db.close(); }
  assert.equal(reserve('new').state, 'full');
  assert.equal(reserve('original').state, 'uncertain');
});
