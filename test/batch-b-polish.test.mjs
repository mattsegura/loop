import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { validateSavedCardSpec } from '../lib/json-render-ui.mjs';
import { searchMemories } from '../lib/memory.mjs';
import { TaskStore } from '../lib/tasks.mjs';

async function setupLoop(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-batchb-polish-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const srv = await startServer({
    dataDir: dir,
    home: dir,
    port: 0,
    authMode: 'local-test',
    hosted: false,
    autoSync: false,
    detectLocalAgents: false,
    searchEnv: { LOOP_EMBEDDING_PROVIDER: 'off' },
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const setupRes = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password-1234' }),
  });
  const cookie = (setupRes.headers.get('set-cookie') || '').split(';')[0];
  const agentRes = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Polish Agent', profile: 'all', memoryAccess: 'read_write', canManage: true }),
  });
  const { token } = await agentRes.json();
  const call = async (name, args) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const j = await r.json();
    const text = j.result?.content?.[0]?.text || '';
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { isError: Boolean(j.result?.isError), text, json, raw: j.result };
  };
  return { dir, base, cookie, token, call };
}

test('validateSavedCardSpec lists permitted components and strictly validates component props', () => {
  const badComp = validateSavedCardSpec({
    root: 'x',
    elements: { x: { type: 'Chart', props: {} } },
  });
  assert.equal(badComp.valid, false);
  assert.match(badComp.errors[0], /Permitted components:.*Card.*Table/);

  const missingCols = validateSavedCardSpec({
    root: 't',
    elements: { t: { type: 'Table', props: { rows: [['a']] } } },
  });
  assert.equal(missingCols.valid, false);
  assert.ok(missingCols.errors.some((e) => /columns/i.test(e)));

  const extraProp = validateSavedCardSpec({
    root: 't',
    elements: { t: { type: 'Table', props: { columns: ['A'], rows: [['1']], bogusProp: true } } },
  });
  assert.equal(extraProp.valid, false);
  assert.ok(extraProp.errors.some((e) => /bogusProp|unrecognized/i.test(e)));
});

test('searchMemories enforces pure-semantic floor and tight fuzzy matching', () => {
  const mems = [
    { id: 'm1', key: 'k1', content: 'Temporary burst check for latency', scope: 'fact', project: '', tags: [], source: '', writtenBy: 'Owner', updatedAt: '2026-11-25T00:00:00Z', pinned: false },
    { id: 'm2', key: 'k2', content: 'Use pnpm in this workspace', scope: 'preference', project: '', tags: [], source: '', writtenBy: 'Owner', updatedAt: '2026-11-25T00:00:00Z', pinned: false },
  ];
  const weakSem = new Map([['m1', 0.36], ['m2', 0.35]]);
  const hits = searchMemories(mems, 'loop-eval', { withScores: true, semanticScores: weakSem, minSemanticScore: 0.34 });
  assert.equal(hits.length, 0);

  const strongSem = new Map([['m1', 0.62], ['m2', 0.30]]);
  const semHits = searchMemories(mems, 'latency benchmark', { withScores: true, semanticScores: strongSem, minSemanticScore: 0.34 });
  assert.equal(semHits.length, 1);
  assert.equal(semHits[0].memory.id, 'm1');
  assert.ok(semHits[0].reason);
});

test('TaskStore.save reports current revision when expectedRevision is missing or stale', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-task-rev-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new TaskStore(dir);
  const created = await store.save({ title: 'Release notes', expectedRevision: 0 });
  assert.equal(created.task.revision, 1);

  await assert.rejects(
    () => store.save({ id: created.task.id, notes: 'Forgot rev' }),
    (err) => err.code === 'TASK_INVALID' && /Current revision is 1/.test(err.message),
  );

  await assert.rejects(
    () => store.save({ id: created.task.id, notes: 'Stale rev', expectedRevision: 0 }),
    (err) => err.code === 'TASK_CONFLICT' && /Current revision.*is 1/.test(err.message),
  );
});

test('loop__inspect reads skill reference files, loop__save rejects empty skills, and history/memory explain empty hits', async (t) => {
  const { dir, call } = await setupLoop(t);

  // Empty skill is refused.
  const emptySkill = await call('loop__save', {
    type: 'skill',
    data: { name: 'empty-skill', description: '', content: '   ' },
  });
  assert.equal(emptySkill.isError, true);
  assert.match(emptySkill.text, /Skill content is required/i);

  // Save a real skill and add a reference file under its directory.
  const saved = await call('loop__save', {
    type: 'skill',
    data: { name: 'billing-guide', description: 'Billing rules', content: '# Billing\nRead references/tax.md.' },
  });
  assert.equal(saved.isError, false, saved.text);
  const refDir = path.join(dir, 'skills', 'billing-guide', 'references');
  await mkdir(refDir, { recursive: true });
  await writeFile(path.join(refDir, 'tax.md'), '# Tax rules\nVAT rate is 20%.\n');

  const inspected = await call('loop__inspect', { type: 'skill', id: 'billing-guide' });
  assert.equal(inspected.isError, false, inspected.text);
  assert.ok(inspected.json.files.includes('references/tax.md'));
  assert.ok(inspected.json.fileResources.some((r) => r.path === 'references/tax.md' && r.uri.startsWith('skill://')));
  assert.match(inspected.json.filesHint, /loop__inspect/);

  const refFile = await call('loop__inspect', { type: 'skill', id: 'billing-guide', file: 'references/tax.md' });
  assert.equal(refFile.isError, false, refFile.text);
  assert.equal(refFile.json.file, 'references/tax.md');
  assert.match(refFile.json.content, /VAT rate is 20%/);

  const missingFile = await call('loop__inspect', { type: 'skill', id: 'billing-guide', file: 'references/missing.md' });
  assert.equal(missingFile.isError, true);
  assert.match(missingFile.text, /references\/tax\.md/);

  // Empty history gives an explicit emptyReason.
  const hist = await call('loop__search', { type: 'history', query: 'anything' });
  assert.equal(hist.isError, false);
  assert.equal(hist.json.total, 0);
  assert.match(hist.json.emptyReason, /No conversation history is recorded/i);

  // Memory recall reports noCloseMatch on miss and matchScore/matchReason on hit.
  await call('loop__save', { type: 'memory', data: { content: 'Deploy uses Node 22 on Ubuntu.' } });
  const miss = await call('loop__search', { type: 'memory', query: 'xyzzy-unrelated-token' });
  assert.equal(miss.json.total, 0);
  assert.equal(miss.json.noCloseMatch, true);
  const hit = await call('loop__search', { type: 'memory', query: 'Node 22' });
  assert.equal(hit.json.total, 1);
  assert.ok(hit.json.memories[0].matchScore > 0);
  assert.ok(hit.json.memories[0].matchReason);
});

test('fast elicitation response (< LOOP_ELICIT_MIN_HUMAN_MS) keeps approval pending in dashboard', async (t) => {
  const prev = process.env.LOOP_ELICIT_MIN_HUMAN_MS;
  process.env.LOOP_ELICIT_MIN_HUMAN_MS = '500';
  t.after(() => {
    if (prev === undefined) delete process.env.LOOP_ELICIT_MIN_HUMAN_MS;
    else process.env.LOOP_ELICIT_MIN_HUMAN_MS = prev;
  });

  const { base, cookie, token } = await setupLoop(t);
  // Create a memory and make delete require approval via an older memory or different caller:
  // Simpler: create an agent invite (which always asks via elicitation) with an instant-declining SSE client.
  const initRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'auto-exec', version: '1.0' } },
    }),
  });
  const sessionId = initRes.headers.get('mcp-session-id');

  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sessionId },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'loop__save', arguments: { type: 'agent', action: 'invite', data: { name: 'FastBot' } } },
    }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let finalMsg = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const frame = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const dataLines = frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
      if (!dataLines.length) continue;
      const msg = JSON.parse(dataLines.join('\n'));
      if (msg.method === 'elicitation/create') {
        // Reply immediately (< 20ms), simulating a non-interactive client like codex exec.
        await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sessionId },
          body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { action: 'accept', content: { decision: 'deny' } } }),
        });
      } else if (msg.id === 2) {
        finalMsg = msg;
      }
    }
  }
  assert.ok(finalMsg);
  const body = JSON.parse(finalMsg.result.content[0].text);
  assert.equal(body.status, 'approval_required');
  assert.match(body.reason || '', /too fast|open in Loop/i);

  // Confirm the approval stayed pending in the dashboard queue!
  const aprRes = await fetch(`${base}/api/approvals/${body.approvalId}`, { headers: { Cookie: cookie } });
  const aprJson = await aprRes.json();
  assert.equal(aprJson.approval.status, 'pending');
});
