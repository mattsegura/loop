import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { MemoryStore } from '../lib/memory.mjs';
import { Vault } from '../lib/vault.mjs';
import { startServer } from '../server.mjs';

const OWNER_PW = 'phase6-owner-pw-123';

function reqJson(port, route, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method,
        headers: { ...(payload !== null ? { 'Content-Type': 'application/json' } : {}), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = null; }
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      },
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

test('Phase 6: Vault binds AES-256-GCM AAD to key name, stays backward-compatible, and supports OS keychain mode', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-phase6-vault-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {}));

  const vault = new Vault(dir);
  await vault.set('SECRET_A', 'alpha-secret-value');
  await vault.set('SECRET_B', 'beta-secret-value');
  assert.equal(await vault.get('SECRET_A'), 'alpha-secret-value');
  assert.equal(await vault.get('SECRET_B'), 'beta-secret-value');

  // Tamper attack: copy encrypted blob (iv/tag/data/aadVersion) from SECRET_A onto SECRET_B.
  const rawDoc = JSON.parse(await readFile(path.join(dir, 'vault.json'), 'utf8'));
  assert.equal(rawDoc.entries.SECRET_A.aadVersion, 2);
  rawDoc.entries.SECRET_B = {
    ...rawDoc.entries.SECRET_B,
    iv: rawDoc.entries.SECRET_A.iv,
    tag: rawDoc.entries.SECRET_A.tag,
    data: rawDoc.entries.SECRET_A.data,
    aadVersion: 2,
  };
  await writeFile(path.join(dir, 'vault.json'), JSON.stringify(rawDoc, null, 2));

  // Swapped ciphertext MUST fail GCM authentication because AAD binds key name!
  await assert.rejects(() => vault.get('SECRET_B'));

  // Backward compatibility: legacy entry without aadVersion still decrypts.
  const encKey = await vault._loadKeyOnly();
  const legacyBlob = vault._encrypt(encKey, 'legacy-plaintext-ok', '');
  assert.equal(legacyBlob.aadVersion, undefined);
  rawDoc.entries.LEGACY_KEY = { ...legacyBlob, type: 'api_key', approval: 'inherit', masked: '••••' };
  await writeFile(path.join(dir, 'vault.json'), JSON.stringify(rawDoc, null, 2));
  assert.equal(await vault.get('LEGACY_KEY'), 'legacy-plaintext-ok');

  // Keychain conflict guard: refuses silent switch when vault.key already exists on disk.
  const conflictVault = new Vault(dir, { keystore: 'keychain', keychainBridge: { get: async () => null, set: async () => {} } });
  await assert.rejects(() => conflictVault.set('NEW_KEY', 'val'), (err) => err.code === 'KEYSTORE_CONFLICT');

  // Clean folder with OS keychain provider keeps vault.key off disk.
  const kcDir = await mkdtemp(path.join(os.tmpdir(), 'loop-phase6-kc-'));
  t.after(() => rm(kcDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {}));
  const memKc = new Map();
  const kcBridge = {
    get: async (account) => memKc.get(account) || null,
    set: async (account, buf) => { memKc.set(account, Buffer.from(buf)); },
  };
  const kcVault = new Vault(kcDir, { keystore: 'keychain', keychainBridge: kcBridge });
  await kcVault.set('KC_SECRET', 'stored-via-keychain');
  const keyFileOnDisk = await stat(path.join(kcDir, 'vault.key')).then(() => true, () => false);
  assert.equal(keyFileOnDisk, false);
  const kcVaultReloaded = new Vault(kcDir, { keystore: 'keychain', keychainBridge: kcBridge });
  assert.equal(await kcVaultReloaded.get('KC_SECRET'), 'stored-via-keychain');
});

test('Phase 6: Memory enforces platform trustTier and strict guest isolation (no global leak, no pin, no confirmed overwrite)', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-phase6-mem-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {}));

  const mem = new MemoryStore(dir);
  const { memory: globalMem } = await mem.save({
    key: 'owner-global-note',
    content: 'Owner private global preference: always use metric units.',
    profiles: ['all'],
    actor: 'owner',
    writtenBy: 'Owner',
    source: 'Manual',
  });
  assert.equal(globalMem.trustTier, 'confirmed');

  const { memory: workConfirmed } = await mem.save({
    key: 'work-policy',
    content: 'Work project rule: never auto-refund orders above 100 dollars.',
    profiles: ['work'],
    actor: 'owner',
    writtenBy: 'Owner',
    source: 'Manual',
  });
  assert.equal(workConfirmed.trustTier, 'confirmed');

  // Strict profile lookup hides global memory from work-scoped guest callers.
  assert.equal(await mem.get(globalMem.id, { profile: 'work' }), null);
  const workList = await mem.list({ profile: 'work' });
  assert.equal(workList.some((m) => m.id === globalMem.id), false);
  assert.equal(workList.some((m) => m.id === workConfirmed.id), true);

  // Guest cannot pin memories into startup context.
  await assert.rejects(
    () => mem.save({
      content: 'Guest attempt to hijack turn-1 startup context.',
      profiles: ['work'],
      pinned: true,
      actor: 'guest',
      writtenBy: 'External Guest',
    }),
    (err) => err.code === 'GUEST_CANNOT_PIN',
  );

  // Guest cannot overwrite or supersede owner-confirmed memory.
  await assert.rejects(
    () => mem.save({
      id: workConfirmed.id,
      content: 'Work project rule: auto-refund everything.',
      profiles: ['work'],
      actor: 'guest',
      writtenBy: 'External Guest',
    }),
    (err) => err.code === 'CANNOT_OVERWRITE_CONFIRMED',
  );
  await assert.rejects(
    () => mem.save({
      content: 'Replacement rule from guest.',
      supersedes: workConfirmed.id,
      profiles: ['work'],
      actor: 'guest',
      writtenBy: 'External Guest',
    }),
    (err) => err.code === 'CANNOT_OVERWRITE_CONFIRMED',
  );

  // Guest write gets platform-computed trustTier 'guest_agent' (cannot spoof 'confirmed').
  const { memory: guestNote } = await mem.save({
    content: 'Guest observation: staging server responded slowly.',
    profiles: ['work'],
    actor: 'guest',
    trustTier: 'confirmed',
    writtenBy: 'External Guest',
  });
  assert.equal(guestNote.trustTier, 'guest_agent');
});

test('Phase 6: /metrics exposes JSON & Prometheus telemetry with token gating, and stateful tool-vs-skill CI fixture passes with independent readback', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-phase6-eval-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {}));

  // Stateful mock CRM holding Deal A (target) and Deal B (unchanged bystander)
  let deals;
  const resetDeals = () => {
    deals = {
      deal_a: { id: 'deal_a', name: 'Acme Renewal', stage: 'negotiation', notes: [] },
      deal_b: { id: 'deal_b', name: 'Acme Expansion Bystander', stage: 'negotiation', notes: [] },
    };
  };
  resetDeals();

  const crmServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/openapi.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Stateful CRM', version: '1.0.0' },
        servers: [{ url: `http://127.0.0.1:${crmServer.address().port}` }],
        paths: {
          '/deals': {
            get: { operationId: 'listDeals', summary: 'List all CRM deals', responses: { '200': { description: 'OK' } } },
          },
          '/deals/{dealId}/stage': {
            post: {
              operationId: 'updateDealStage',
              summary: 'Update a deal stage and optional closing note',
              parameters: [{ name: 'dealId', in: 'path', required: true, schema: { type: 'string' } }],
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['stage'],
                      properties: { stage: { type: 'string' }, note: { type: 'string' } },
                    },
                  },
                },
              },
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      }));
      return;
    }
    if (req.method === 'GET' && u.pathname === '/deals') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deals: Object.values(deals) }));
      return;
    }
    const stageMatch = /^\/deals\/([^/]+)\/stage$/.exec(u.pathname);
    if (req.method === 'POST' && stageMatch) {
      const id = decodeURIComponent(stageMatch[1]);
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!deals[id]) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'deal not found' }));
          return;
        }
        deals[id].stage = body.stage;
        if (body.note) deals[id].notes.push(body.note);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ updated: true, deal: deals[id] }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => crmServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => crmServer.close(r)));

  const srv = await startServer({
    port: 0,
    dataDir: dir,
    authMode: 'local-test',
    autoSync: false,
    detectLocalAgents: false,
    metricsToken: 'metrics-secret-token',
    billingEnv: {},
  });
  t.after(() => srv.close());

  // 1) Metrics gating + JSON + Prometheus checks
  const unauthMetrics = await reqJson(srv.port, '/metrics');
  assert.equal(unauthMetrics.status, 401);

  const setup = await reqJson(srv.port, '/api/auth/setup', { method: 'POST', body: { password: OWNER_PW } });
  const cookie = String([].concat(setup.headers['set-cookie'])[0] || '').split(';')[0];
  const api = (route, opts = {}) => reqJson(srv.port, route, { ...opts, headers: { Cookie: cookie, ...(opts.headers || {}) } });

  const promMetrics = await reqJson(srv.port, '/metrics?format=prometheus', {
    headers: { Authorization: 'Bearer metrics-secret-token' },
  });
  assert.equal(promMetrics.status, 200);
  assert.match(promMetrics.text, /loop_http_requests_total/);
  assert.match(promMetrics.text, /loop_http_request_duration_ms\{quantile="0\.95"\}/);

  const jsonMetrics = await api('/metrics');
  assert.equal(jsonMetrics.status, 200);
  assert.equal(jsonMetrics.json.ok, true);
  assert.ok(jsonMetrics.json.counters.http_requests_total >= 1);

  // 2) Stateful Tool-vs-Skill CI Eval Fixture
  const imported = await api('/api/mcps/import-api', {
    method: 'POST',
    body: { kind: 'openapi', name: 'Stateful CRM', url: `http://127.0.0.1:${crmServer.address().port}/openapi.json` },
  });
  assert.equal(imported.status, 201);
  const connId = imported.json.connection.id;

  // Save a real multi-step Skill governing close-won deal transitions via a manager agent,
  // then verify an independent non-manager eval runner can read it back (R6 cross-agent check).
  const mgrRes = await api('/api/agents', { method: 'POST', body: { name: 'Skill Author', canManage: true } });
  assert.equal(mgrRes.status, 201);
  const saveSkillRpc = await reqJson(srv.port, '/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${mgrRes.json.token}` },
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'loop__save',
        arguments: {
          type: 'skill',
          data: {
            name: 'close-won',
            description: 'Verify target deal ID via listdeals before closing a deal as closed_won with a closing note.',
            content: '1. Call listdeals to confirm the exact deal ID.\n2. Update only the verified target deal with stage "closed_won" and a closing note.\n3. Never modify bystander deals.',
          },
        },
      },
    },
  });
  assert.equal(saveSkillRpc.status, 200);
  const savedSkillPayload = JSON.parse(saveSkillRpc.json.result.content[0].text);
  assert.equal(savedSkillPayload.saved, true);
  const skillId = savedSkillPayload.skill.id;

  const agRes = await api('/api/agents', { method: 'POST', body: { name: 'Eval Runner', canManage: false } });
  const agentToken = agRes.json.token;
  let rpcSeq = 0;
  const mcpCall = async (name, args) => {
    rpcSeq += 1;
    const r = await reqJson(srv.port, '/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
      body: { jsonrpc: '2.0', id: rpcSeq, method: 'tools/call', params: { name, arguments: args } },
    });
    assert.equal(r.status, 200);
    return r.json.result;
  };

  // Arm A: Direct tool call (direct-tool control; skill score = not_applicable)
  const directRes = await mcpCall('loop__run', {
    tool: `${connId}__updatedealstage`,
    arguments: { dealId: 'deal_a', body: { stage: 'closed_won' } },
  });
  assert.notEqual(directRes.isError, true);
  // Independent state readback from CRM (not trusting tool return alone!)
  assert.equal(deals.deal_a.stage, 'closed_won');
  assert.equal(deals.deal_b.stage, 'negotiation'); // Bystander B untouched!
  const directScore = {
    toolContract: !directRes.isError,
    skillLayer: 'not_applicable',
    targetOutcome: deals.deal_a.stage === 'closed_won',
    bystanderUnchanged: deals.deal_b.stage === 'negotiation' && deals.deal_b.notes.length === 0,
  };
  assert.equal(directScore.toolContract, true);
  assert.equal(directScore.skillLayer, 'not_applicable');
  assert.equal(directScore.targetOutcome, true);
  assert.equal(directScore.bystanderUnchanged, true);

  // Arm B: Reset state -> replay Skill-guided workflow (discover -> inspect skill -> list -> update target -> independent readback)
  resetDeals();
  const inspectedSkill = await mcpCall('loop__inspect', { type: 'skill', id: skillId });
  assert.notEqual(inspectedSkill.isError, true);
  const skillText = inspectedSkill.content[0].text;
  assert.match(skillText, /closing note/i);

  const listed = await mcpCall('loop__run', { tool: `${connId}__listdeals`, arguments: {} });
  assert.notEqual(listed.isError, true);
  const listedObj = listed.structuredContent || JSON.parse(listed.content[0].text);
  const verifiedTarget = listedObj.deals.find((d) => d.name === 'Acme Renewal');
  assert.equal(verifiedTarget.id, 'deal_a');

  const guidedRes = await mcpCall('loop__run', {
    tool: `${connId}__updatedealstage`,
    arguments: { dealId: verifiedTarget.id, body: { stage: 'closed_won', note: 'Signed Q4 order form' } },
  });
  assert.notEqual(guidedRes.isError, true);

  // Independent state readback verifies both target outcome AND untouched bystander B
  assert.equal(deals.deal_a.stage, 'closed_won');
  assert.deepEqual(deals.deal_a.notes, ['Signed Q4 order form']);
  assert.equal(deals.deal_b.stage, 'negotiation');
  assert.deepEqual(deals.deal_b.notes, []);

  // Verify Dockerfile & .dockerignore exist on disk
  assert.equal(await stat(path.resolve('Dockerfile')).then(() => true, () => false), true);
  assert.equal(await stat(path.resolve('.dockerignore')).then(() => true, () => false), true);
});
