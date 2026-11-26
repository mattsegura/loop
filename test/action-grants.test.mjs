import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSafeToolMap, handleMcpRequest } from '../lib/mcp-server.mjs';
import { ApprovalQueue } from '../lib/policies.mjs';

function fixture() {
  const work = {
    id: 'work', name: 'Work', enabled: true, transport: 'http', url: 'https://fixture.example.invalid/mcp',
    tools: ['read.record', 'write.record', 'broker_execute'].map(name => ({
      name, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: name === 'read.record' },
    })),
    resources: [{ name: 'fixture-private-resource', uri: 'synthetic://record' }],
    prompts: [{ name: 'fixture-private-prompt' }],
  };
  const personal = { ...work, id: 'personal', name: 'fixture-private-account' };
  const calls = [];
  const store = {
    list: async () => [work, personal],
    get: async id => [work, personal].find(connection => connection.id === id),
    getSettings: async () => ({ defaultProfile: 'all' }),
  };
  const pool = {
    callTool: async (id, name, args) => {
      calls.push({ id, name, args });
      return { content: [{ type: 'text', text: 'synthetic-record' }] };
    },
    readResource: async (...args) => { calls.push({ method: 'resources/read', args }); return { contents: [] }; },
    getPrompt: async (...args) => { calls.push({ method: 'prompts/get', args }); return { messages: [] }; },
  };
  const agent = { id: 'host', name: 'Host', enabled: true, profile: 'all', allowedConnections: [work.id],
    allowedSkills: [], secrets: [], canManage: false, memoryAccess: 'none', toolGrants: { work: ['read.record'] } };
  const alias = raw => buildSafeToolMap([work]).byRaw.get('work__' + raw).exposedName;
  const rpc = (method, params, options = {}) => handleMcpRequest(store, null, pool, {
    jsonrpc: '2.0', id: 1, method, params,
  }, { agent, ...options });
  const call = (name, args = {}, options) => rpc('tools/call', { name, arguments: args }, options);
  return { agent, alias, calls, rpc, call, store };
}

function payload(reply) {
  assert.ok(reply.result && !reply.result.isError, JSON.stringify(reply));
  return JSON.parse(reply.result.content[0].text);
}

function denied(reply) {
  assert.ok(reply.error || reply.result?.isError, JSON.stringify(reply));
}

test('an action grant lists only approved upstream actions and permits direct, aliased and wrapped calls', async () => {
  const { rpc, call, alias, calls } = fixture();
  const read = alias('read.record');
  const write = alias('write.record');
  assert.notEqual(read, 'work__read.record');
  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Host', version: 'test' } });
  assert.ok(init.result.capabilities.tools);
  assert.doesNotMatch(JSON.stringify(init), /fixture-private|broker_execute|write\.record/);
  const list = await rpc('tools/list', {});
  const names = list.result.tools.map(tool => tool.name);
  assert.ok(names.includes(read));
  assert.ok(!names.includes(write) && !names.includes('work__broker_execute'));
  const found = payload(await call('loop__search', { type: 'tools', connection: 'work' }));
  assert.equal(found.tools.length, 1);
  assert.doesNotMatch(JSON.stringify(found), /write\.record|broker_execute|fixture-private/);
  const inspected = payload(await call('loop__inspect', { type: 'tool', id: found.tools[0].tool }));
  assert.ok(inspected.tool);
  for (const [name, args] of [[read, {}], ['work__read.record', {}], ['loop__run', { tool: read, arguments: {} }]]) {
    const reply = await call(name, args);
    assert.equal(reply.result.content[0].text, 'synthetic-record');
  }
  for (const name of [write, 'work__write.record', 'work__broker_execute', 'personal__read.record', 'work__invented']) {
    denied(await call(name));
    denied(await call('loop__run', { tool: name, arguments: {} }));
  }
  denied(await call('loop__inspect', { type: 'tool', id: write }));
  denied(await call('loop__search', { type: 'vault' }));
  assert.deepEqual(calls, Array(3).fill({ id: 'work', name: 'read.record', args: {} }));
});

test('every batch item respects grants and connection resources and prompts stay inaccessible', async () => {
  const { rpc, call, alias, calls } = fixture();
  const batch = payload(await call('loop__run', { calls: [
    { tool: alias('read.record') }, { tool: alias('write.record') }, { tool: 'work__broker_execute' },
  ] }));
  assert.equal(batch.ok, 1);
  assert.equal(batch.failed, 2);
  assert.deepEqual((await rpc('resources/list', {})).result.resources, []);
  assert.deepEqual((await rpc('prompts/list', {})).result.prompts, []);
  denied(await rpc('resources/read', { uri: 'loop://work/' + encodeURIComponent('synthetic://record') }));
  denied(await rpc('prompts/get', { name: 'work__fixture-private-prompt' }));
  assert.deepEqual(calls, [{ id: 'work', name: 'read.record', args: {} }]);
});

test('a named action resumes approval without consuming a provider argument of the same name', async () => {
  const { call, rpc, store, alias, calls } = fixture();
  const work = await store.get('work');
  work.tools[0].inputSchema = {
    type: 'object', additionalProperties: false, required: ['_approvalId'], properties: { _approvalId: { type: 'string' } },
  };
  const queue = new ApprovalQueue();
  const options = { approvalQueue: queue, approvalWaitMs: 0, policyStore: { evaluateRun: async () => ({ decision: 'always_ask', reason: 'Review access' }) } };
  try {
    const name = alias('read.record');
    const listing = await rpc('tools/list', {});
    const schema = listing.result.tools.find(tool => tool.name === name).inputSchema;
    assert.ok(schema.properties.__approvalId);
    const pending = payload(await call(name, { _approvalId: 'provider-id' }, options));
    assert.match(pending.nextStep, /__approvalId/);
    assert.ok(queue.approve(pending.approvalId).ok);
    const result = await call(name, { _approvalId: 'provider-id', __approvalId: pending.approvalId }, options);
    assert.equal(result.result.content[0].text, 'synthetic-record');
    assert.deepEqual(calls, [{ id: 'work', name: 'read.record', args: { _approvalId: 'provider-id' } }]);
  } finally {
    await queue.close();
  }
});

test('narrowing an agent to one action cancels its in-flight approval for a different tool', { timeout: 3000 }, async () => {
  const { agent, call, calls, store } = fixture();
  const { toolGrants, ...priorRights } = agent;
  const original = { ...priorRights, tokenHash: 'synthetic' };
  let current = original;
  store.getAgent = async () => current;
  const queue = new ApprovalQueue();
  const waiting = Promise.withResolvers();
  const off = queue.subscribe(() => {
    const pending = queue.listPending()[0];
    if (pending) waiting.resolve(pending);
  });
  try {
    const inflight = call('loop__run', { tool: 'work__write.record', arguments: {}, waitForApproval: true }, {
      agent: original, policyStore: { evaluateRun: async () => ({ decision: 'always_ask', reason: 'fixture approval' }) },
      approvalQueue: queue, approvalWaitMs: 2000,
    });
    const pending = await Promise.race([waiting.promise, inflight.then(reply => assert.fail('Expected a pending approval: ' + JSON.stringify(reply)))]);
    current = { ...original, toolGrants };
    assert.ok(queue.approve(pending.id).ok);
    denied(await inflight);
    assert.deepEqual(calls, []);
  } finally {
    off();
    await queue.close();
  }
});
