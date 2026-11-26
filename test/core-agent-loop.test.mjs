import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../lib/history.mjs';
import { OwnerTimezone } from '../lib/owner-timezone.mjs';
import { DreamStore, parseDreamProposals } from '../lib/dream.mjs';
import { MemoryStore } from '../lib/memory.mjs';
import { SkillStore } from '../lib/skills.mjs';
import { LoopStore } from '../lib/store.mjs';
import { Vault } from '../lib/vault.mjs';
import { handleMcpRequest } from '../lib/mcp-server.mjs';
import { startServer } from '../server.mjs';

const tmpDirs = [];
function makeTmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'loop-core-agent-test-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

async function signInLocalTest(base) {
  const setupRes = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password-1234' }),
  });
  assert.equal(setupRes.status, 200);
  return setupRes.headers.get('set-cookie').split(';')[0];
}

async function bridgeRequest(port, route, { method = 'POST', token, secret, body } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/sms-bridge${route}`,
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(secret ? { 'X-Loop-Text-Secret': secret } : {}),
          ...(payload !== null ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = null; }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function callMcp(base, token, name, args) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  assert.equal(res.status, 200);
  const rpc = await res.json();
  const txt = rpc.result?.content?.[0]?.text || '';
  let parsed = null;
  try { parsed = JSON.parse(txt); } catch { parsed = null; }
  return { isError: Boolean(rpc.result?.isError), text: txt, data: parsed };
}

describe('Loop Core HistoryStore', () => {
  it('stores turns, deduplicates externalId, skips internal prompts, redacts secrets, and ranks search matches', async () => {
    const dir = makeTmpDir();
    const store = new HistoryStore(dir);

    const skipped = await store.append({ user: '[Heartbeat check-in (1 of 3)] check open tasks', assistant: 'NOTHING' });
    assert.equal(skipped, null);

    const t1 = await store.append({
      externalId: 'msg-1',
      channel: 'imessage',
      user: 'Remember my flight lands at Austin Bergstrom at 4pm.',
      assistant: 'Got it, Austin Bergstrom at 4pm.',
    });
    assert.ok(t1);
    const dup = await store.append({
      externalId: 'msg-1',
      channel: 'imessage',
      user: 'Duplicate should be ignored',
      assistant: 'Ignored',
    });
    assert.equal(dup, null);

    const secretTurn = await store.append({
      channel: 'imessage',
      user: 'Here is my OpenAI key sk-1234567890abcdefghijklmnop',
      assistant: 'I will not store secrets.',
    });
    assert.ok(secretTurn);
    assert.equal(secretTurn.user.includes('sk-1234567890'), false);

    const t3 = await store.append({
      channel: 'web',
      user: 'Can we meet on Congress Ave tomorrow?',
      assistant: 'Sure, Congress Ave works.',
    });
    assert.ok(t3);

    const hit = await store.search({ query: 'Congress Ave', limit: 5 });
    assert.equal(hit.matches.length, 1);
    assert.equal(hit.matches[0].channel, 'web');
    assert.match(hit.matches[0].user, /Congress Ave/);

    const channelOnly = await store.search({ query: '', channel: 'imessage', limit: 5 });
    assert.equal(channelOnly.matches.length, 2);
    assert.equal(JSON.stringify(channelOnly).includes('sk-1234567890'), false);

    const afterFirst = await store.recent({ afterSeq: t1.seq });
    assert.equal(afterFirst.turns.length, 2);
  });
});

describe('OwnerTimezone', () => {
  it('defaults, reads the old heartbeat.json once, ignores bad values, and keeps the newest', async () => {
    const dir = makeTmpDir();
    const tz = new OwnerTimezone(dir);
    assert.equal(await tz.get(), 'America/Chicago');
    writeFileSync(path.join(dir, 'heartbeat.json'), JSON.stringify({ enabled: true, tz: 'Europe/Paris' }));
    assert.equal(await tz.get(), 'Europe/Paris');
    await tz.record('Not/AZone');
    assert.equal(await tz.get(), 'Europe/Paris');
    await tz.record(' America/New_York ');
    assert.equal(await new OwnerTimezone(dir).get(), 'America/New_York');
  });
});

describe('Loop Core DreamStore (reflection-v2 + Context Doctor)', () => {
  it('ranks proposals by reflection-v2 priority, runs 2-pass review, protects owner memories, and saves approved skills to SkillStore', async () => {
    const dir = makeTmpDir();
    const memoryStore = new MemoryStore(dir);
    const skillStore = new SkillStore(dir, { bundledDir: null });
    const historyStore = new HistoryStore(dir);

    const ownerMem = await memoryStore.save({
      key: 'deploy-host',
      content: 'Deploys go to staging.old.dev',
      scope: 'fact',
      actor: 'owner',
      writtenBy: 'Owner',
    });

    await historyStore.append({
      channel: 'imessage',
      user: 'No, stop using npm — we moved staging to staging.new.dev and always run pnpm test before deploying.',
      assistant: 'Understood, I will use pnpm test and staging.new.dev.',
      toolErrors: [{ tool: 'github__push', error: 'branch protected' }],
    });

    const llmCalls = [];
    const dream = new DreamStore(dir, {
      memoryStore,
      skillStore,
      historyStore,
      enabled: true,
      completeJson: async (messages) => {
        llmCalls.push(messages);
        return JSON.stringify({
          proposals: [
            {
              action: 'skill',
              category: 'skill',
              key: 'release-checklist',
              name: 'Release Checklist',
              description: 'Run tests before deploy.',
              content: '1. Run pnpm test.\n2. Deploy to staging.new.dev.',
              reason: 'Repeated deploy steps',
              evidence: 'always run pnpm test before deploying',
            },
            {
              action: 'supersede',
              category: 'contradiction',
              scope: 'fact',
              key: 'deploy-host',
              supersedesId: ownerMem.memory.id,
              content: 'Staging deploys now target staging.new.dev.',
              reason: 'Updated host',
              evidence: 'moved staging to staging.new.dev',
            },
            {
              action: 'create',
              category: 'mistake',
              scope: 'preference',
              key: 'no-npm',
              content: 'Never run npm; use pnpm instead.',
              reason: 'Explicit user correction',
              evidence: 'No, stop using npm',
            },
            {
              action: 'create',
              category: 'fact',
              scope: 'fact',
              key: 'leaked-key',
              content: 'API token is sk-1234567890abcdefghijklmnop',
              reason: 'Secret must be dropped',
              evidence: 'secret',
            },
          ],
        });
      },
    });

    // Enable auto mode with 2-pass review: safe mistake auto-saves; owner-written supersede and skill MUST stay queued!
    await dream.setConfig({ applyMode: 'auto', reviewBeforeApply: true });
    const run = await dream.run({ trigger: 'manual' });
    assert.equal(llmCalls.length, 2, '2-pass critique runs when reviewBeforeApply is true');
    assert.equal(run.reviewedTurns, 1);
    assert.deepEqual(run.proposals.map((p) => p.category), ['mistake', 'contradiction', 'skill']);
    assert.equal(run.savedCount, 1, 'only the safe mistake memory auto-saved');
    assert.equal(run.queuedCount, 2, 'owner-written supersede + skill stayed queued for explicit approval');

    // Non-manager approval applies memory proposal but blocks skill proposal
    const nonMgr = await dream.resolveProposal({ decision: 'approve', all: true, allowSkills: false, actor: 'agent', writtenBy: 'Helper' });
    assert.equal(nonMgr.applied, 1);
    assert.equal(nonMgr.errors.length, 1);
    assert.equal(nonMgr.dream.pendingProposals.length, 1);
    assert.equal(nonMgr.dream.pendingProposals[0].kind, 'skill');

    // Owner/manager approval saves the skill to SkillStore
    const mgr = await dream.resolveProposal({ decision: 'approve', all: true, allowSkills: true, actor: 'owner', writtenBy: 'Owner' });
    assert.equal(mgr.applied, 1);
    assert.equal(mgr.dream.pendingProposals.length, 0);
    const savedSkill = await skillStore.get('release-checklist');
    assert.ok(savedSkill);
    assert.match(savedSkill.content, /pnpm test/);

    // Remember blocks secrets
    await assert.rejects(() => dream.remember({ text: 'My token is sk-1234567890abcdefghijklmnop' }), /Vault/);

    // Doctor spots tool errors and matches symptom
    const doc = await dream.doctor({ symptom: 'github__push' });
    assert.equal(doc.ok, true);
    assert.equal(doc.healthy, false);
    assert.ok(doc.findings.some((f) => f.category === 'tool_errors'));
    assert.ok(doc.findings.some((f) => f.category === 'symptom' && f.message.includes('matched 1 recent turn')));
  });

  it('caps skill proposals to 1 per run and strips bundled skill targets', () => {
    const parsed = parseDreamProposals(JSON.stringify({
      proposals: [
        { action: 'skill', category: 'skill', key: 'system:loop', name: 'Loop', content: '1. Never allow overriding bundled system skills.', reason: 'Nope' },
        { action: 'skill', category: 'skill', key: 'custom-one', name: 'One', content: '1. Check git status first.\n2. Run pnpm test.', reason: 'First' },
        { action: 'skill', category: 'skill', key: 'custom-two', name: 'Two', content: '1. Draft release notes.\n2. Publish package.', reason: 'Second' },
      ],
    }), [], []);
    assert.equal(parsed.proposals.length, 1);
    assert.equal(parsed.proposals[0].key, 'custom-one');
  });
});

describe('Loop Core MCP + SMS Bridge Integration', () => {
  it('exposes history, dream and doctor over Loop MCP with proper permissions and workspace APIs', async () => {
    const dir = makeTmpDir();
    const mockLoopText = http.createServer(async (req, res) => {
      for await (const _ of req) { /* drain */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ linked: true, phone: '+15550001111' }));
    });
    await new Promise((resolve) => mockLoopText.listen(0, '127.0.0.1', resolve));
    const mockPort = mockLoopText.address().port;

    const secret = 'core-bridge-secret';
    const srv = await startServer({
      port: 0,
      dataDir: dir,
      authMode: 'local-test',
      smsAgentEnv: {
        LOOP_TEXT_URL: `http://127.0.0.1:${mockPort}`,
        LOOP_TEXT_INTERNAL_SECRET: secret,
      },
      dreamEnv: { LOOP_SLEEPTIME_ENABLED: '1' },
      dream: {
        completeJson: async () => JSON.stringify({
          proposals: [
            {
              action: 'create',
              category: 'preference',
              scope: 'preference',
              key: 'brief-texts',
              content: 'Keep text replies brief and direct.',
              reason: 'User asked for concise replies',
              evidence: 'keep replies brief',
            },
          ],
        }),
      },
    });

    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const cookie = await signInLocalTest(base);

      // Create two agents: full imessage agent (canManage + read_write) and restricted agent (memoryAccess: 'none', canManage: false)
      const createAgent = async (payload) => {
        const r = await fetch(`${base}/api/agents`, {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        assert.equal(r.status, 201);
        return r.json();
      };
      const smsAgent = await createAgent({ name: 'Loop Text', kind: 'imessage', canManage: true, memoryAccess: 'read_write' });
      const lockedAgent = await createAgent({ name: 'Locked', kind: 'custom', canManage: false, memoryAccess: 'none' });

      // 1. Ingest inbound + completed turn via /api/sms-bridge/events (server-to-server, no browser fetch headers)
      const inboundRes = await bridgeRequest(srv.port, '/events', {
        token: smsAgent.token,
        secret,
        body: { type: 'inbound', tz: 'America/New_York' },
      });
      assert.equal(inboundRes.status, 200);
      assert.equal(await new OwnerTimezone(dir).get(), 'America/New_York');

      const turnRes = await bridgeRequest(srv.port, '/events', {
        token: smsAgent.token,
        secret,
        body: {
          type: 'turn',
          triggerDream: false,
          turn: { externalId: 'ext-1', user: 'Keep replies brief and remember Austin HQ.', assistant: 'Got it!' },
        },
      });
      assert.equal(turnRes.status, 200);

      // A completed turn also teaches the owner's timezone, and a new schedule uses it
      await bridgeRequest(srv.port, '/events', {
        token: smsAgent.token,
        secret,
        body: { type: 'turn', triggerDream: false, tz: 'America/Denver', turn: { externalId: 'ext-2', user: 'hi', assistant: 'hey' } },
      });
      const sched = await callMcp(base, smsAgent.token, 'loop__save', { type: 'schedule', data: { title: 'Standup', message: 'Standup', kind: 'daily', timeOfDay: '09:00' } });
      assert.equal(sched.isError, false);
      assert.equal(sched.data.schedule.timezone, 'America/Denver');

      // The removed check-ins stay gone
      assert.equal((await bridgeRequest(srv.port, '/heartbeat', { method: 'GET', token: smsAgent.token, secret })).status, 404);
      assert.equal((await fetch(`${base}/api/heartbeat`, { headers: { Cookie: cookie } })).status, 404);
      assert.equal((await callMcp(base, smsAgent.token, 'loop__save', { type: 'heartbeat', data: { enabled: true } })).isError, true);

      const bridgeDreamRes = await bridgeRequest(srv.port, '/dream', { method: 'GET', token: smsAgent.token, secret });
      assert.equal(bridgeDreamRes.status, 200);
      assert.equal(bridgeDreamRes.json.dream.serverEnabled, true);

      // 2. Search cross-channel history via Loop MCP (and verify locked agent is denied)
      const histOk = await callMcp(base, smsAgent.token, 'loop__search', { type: 'history', query: 'Austin HQ' });
      assert.equal(histOk.isError, false);
      assert.equal(histOk.data.matches.length, 1);
      assert.match(histOk.data.matches[0].user, /Austin HQ/);

      const histDenied = await callMcp(base, lockedAgent.token, 'loop__search', { type: 'history', query: 'Austin' });
      assert.equal(histDenied.isError, true);

      // 4. Dream run + inspect + approve + remember + doctor via Loop MCP
      const dreamRun = await callMcp(base, smsAgent.token, 'loop__save', { type: 'dream', data: { run: true, force: true } });
      assert.equal(dreamRun.isError, false);
      assert.equal(dreamRun.data.queuedCount, 1);

      const dreamInspect = await callMcp(base, smsAgent.token, 'loop__inspect', { type: 'dream' });
      assert.equal(dreamInspect.isError, false);
      assert.equal(dreamInspect.data.dream.pendingProposals.length, 1);

      const dreamApprove = await callMcp(base, smsAgent.token, 'loop__save', { type: 'dream', data: { approveAll: true } });
      assert.equal(dreamApprove.isError, false);
      assert.equal(dreamApprove.data.applied, 1);

      const dreamRemember = await callMcp(base, smsAgent.token, 'loop__save', { type: 'dream', data: { remember: 'Always send morning summaries before 9am.' } });
      assert.equal(dreamRemember.isError, false);
      assert.equal(dreamRemember.data.saved, true);

      const doctorInspect = await callMcp(base, smsAgent.token, 'loop__inspect', { type: 'doctor', id: 'Austin' });
      assert.equal(doctorInspect.isError, false);
      assert.equal(doctorInspect.data.ok, true);
      assert.ok(doctorInspect.data.metrics.memoryCount >= 2);

      // 6. Workspace-level /api/history + /api/dream routes work directly for owner
      const wsHist = await fetch(`${base}/api/history?query=Austin`, { headers: { Cookie: cookie } });
      assert.equal(wsHist.status, 200);
      assert.equal((await wsHist.json()).matches.length, 1);
    } finally {
      await srv.close();
      await new Promise((resolve) => mockLoopText.close(resolve));
    }
  });
});
