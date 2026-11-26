import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { startServer } from '../server.mjs';
import { LoopStore } from '../lib/store.mjs';
import { closeAllWorkspaceDbs } from '../lib/storage/workspace-db.mjs';
import {
  ANY_ACCOUNT,
  buildServicesView,
  connectionAllowedByAccountChoice,
  serviceEndpointKeyOf,
  serviceKeyOf,
} from '../lib/services.mjs';
import {
  ConnectionPool,
  REMOTE_STALE_SYNC_MS,
  STALE_SYNC_MS,
  isToolSchemaMismatchError,
  needsAutoSync,
} from '../lib/mcp-client.mjs';
import {
  extractStdioPackageIdentity,
  findUpdatableConnection,
  importCandidates,
} from '../lib/importers.mjs';
import { Vault } from '../lib/vault.mjs';
import { homeMatchScore } from '../public/home-search.js';
import { mountOAuthConsentPicker } from '../public/oauth-consent-view.js';

const DRIVE = 'https://drive.example.com/mcp';

async function withStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-account-choice-'));
  try {
    await fn(new LoopStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('local servers that share a command are separate services', () => {
  const a = { id: 'a', transport: 'stdio', command: '/usr/local/bin/npx', args: ['-y', 'server-one'] };
  const b = { id: 'b', transport: 'stdio', command: 'npx', args: ['-y', 'server-two'] };
  const c = { id: 'c', transport: 'stdio', command: 'npx', args: ['-y', 'server-one'] };
  assert.notEqual(serviceKeyOf(a), serviceKeyOf(b));
  assert.equal(serviceKeyOf(a), serviceKeyOf(c));
});

test('the any-account choice reaches every account', () => {
  const conn = { id: 'drive-2', transport: 'http', url: DRIVE };
  const key = serviceKeyOf(conn);
  assert.equal(connectionAllowedByAccountChoice({ [key]: ANY_ACCOUNT }, conn), true);
  assert.equal(connectionAllowedByAccountChoice({ [key]: 'drive-1' }, conn), false);
  assert.equal(connectionAllowedByAccountChoice({ [key]: 'drive-2' }, conn), true);
});

test('a second account keeps agents on the first, and a new agent starts there', () => withStore(async (store) => {
  const personal = await store.add({ name: 'Google Drive', transport: 'http', url: DRIVE, accountLabel: 'Personal' });
  const early = await store.addAgent({ name: 'Early agent', kind: 'claude-code' });
  const chooser = await store.addAgent({ name: 'Chooser', kind: 'codex' });
  const key = serviceKeyOf(personal);
  // One account only: nothing to choose yet.
  assert.equal(Object.hasOwn(early.accountChoice, key), false);
  await store.updateAgent(chooser.id, { accountChoice: { [key]: ANY_ACCOUNT } });

  const work = await store.add({ name: 'Google Drive', transport: 'http', url: `${DRIVE}?account=work`, accountLabel: 'Work' });
  assert.equal(serviceKeyOf(work), key);
  // A plain add (an agent's own loop__save) moves nobody.
  assert.deepEqual((await store.getAgent(early.id)).accountChoice, {});
  const picked = await store.addAgent({ name: 'Picked agent', kind: 'gemini' });
  assert.equal(picked.accountChoice[key], personal.id);
  const adopted = await store.adoptAccount(work.id, [picked.id]);
  assert.deepEqual(adopted.moved, [picked.id]);
  assert.equal((await store.getAgent(picked.id)).accountChoice[key], work.id, 'a picked agent moves to the new account');
  const afterAdd = await store.listAgents();
  assert.equal(afterAdd.find((a) => a.id === early.id).accountChoice[key], personal.id, 'the earlier agent stays on Personal');
  assert.equal(afterAdd.find((a) => a.id === chooser.id).accountChoice[key], ANY_ACCOUNT, 'an explicit choice is kept');

  const late = await store.addAgent({ name: 'Late agent', kind: 'cursor' });
  assert.equal(late.accountChoice[key], personal.id, 'a new agent starts on the first account');

  const view = buildServicesView({ connections: await store.list(), agents: await store.listAgents() });
  const svc = view.services.find((s) => s.key === key);
  assert.equal(svc.defaultConnectionId, personal.id);
  assert.equal(svc.agents.find((a) => a.id === chooser.id).choice, 'any');
  assert.equal(svc.agents.find((a) => a.id === early.id).connectionId, personal.id);

  // Removing Personal moves its agents to the account that is left.
  await store.remove(personal.id);
  const afterRemove = await store.listAgents();
  assert.equal(afterRemove.find((a) => a.id === early.id).accountChoice[key], work.id);
  assert.equal(afterRemove.find((a) => a.id === chooser.id).accountChoice[key], ANY_ACCOUNT);
}));

test('a different service does not move any agent', () => withStore(async (store) => {
  await store.add({ name: 'Drive', transport: 'http', url: DRIVE });
  const agent = await store.addAgent({ name: 'Agent', kind: 'codex' });
  await store.add({ name: 'Other', transport: 'stdio', command: 'npx', args: ['-y', 'other-server'] });
  await store.add({ name: 'Another', transport: 'stdio', command: 'npx', args: ['-y', 'another-server'] });
  const [after] = (await store.listAgents()).filter((a) => a.id === agent.id);
  assert.deepEqual(after.accountChoice, {});
}));

test('serviceEndpointKeyOf distinguishes non-secret scope query params while ignoring secret params', () => {
  const wide = { id: 'a', transport: 'http', url: 'https://mcp.supabase.com/mcp' };
  const projA = { id: 'b', transport: 'http', url: 'https://mcp.supabase.com/mcp?project_ref=appA' };
  const projB = { id: 'c', transport: 'http', url: 'https://mcp.supabase.com/mcp?project_ref=appB' };
  const projASecret = { id: 'd', transport: 'http', url: 'https://mcp.supabase.com/mcp?project_ref=appA&api_key=secret123' };

  assert.equal(serviceKeyOf(wide), serviceKeyOf(projA));
  assert.equal(serviceKeyOf(projA), serviceKeyOf(projB));
  assert.notEqual(serviceEndpointKeyOf(wide), serviceEndpointKeyOf(projA));
  assert.notEqual(serviceEndpointKeyOf(projA), serviceEndpointKeyOf(projB));
  assert.equal(serviceEndpointKeyOf(projA), serviceEndpointKeyOf(projASecret));
});

test('setDefaultAccount promotes a narrow account for future agents without moving pinned agents', () => withStore(async (store) => {
  const wide = await store.add({ name: 'supabase', transport: 'http', url: 'https://mcp.supabase.com/mcp', accountLabel: 'All projects' });
  const narrow = await store.add({ name: 'supabase', transport: 'http', url: 'https://mcp.supabase.com/mcp', accountLabel: 'Project X' });
  const early = await store.addAgent({ name: 'Early bot', kind: 'claude-code' });
  const key = serviceKeyOf(wide);
  assert.equal(early.accountChoice[key], wide.id);

  const promoted = await store.setDefaultAccount(narrow.id);
  assert.equal(promoted.defaultConnectionId, narrow.id);

  const late = await store.addAgent({ name: 'New bot', kind: 'codex' });
  assert.equal(late.accountChoice[key], narrow.id, 'new bots default to the promoted narrow account');
  assert.equal((await store.getAgent(early.id)).accountChoice[key], wide.id, 'existing bots keep their pinned account');

  const view = buildServicesView({ connections: await store.list(), agents: await store.listAgents() });
  const svc = view.services.find((s) => s.key === key);
  assert.equal(svc.defaultConnectionId, narrow.id);
}));

async function startSimpleMcpStub(t) {
  const srv = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      return res.end();
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const msg = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (msg.method === 'initialize') {
        return res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'supabase', version: '1.0.0' } },
        }));
      }
      if (msg.method === 'tools/list') {
        return res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: [{ name: 'list_projects', description: 'List projects', inputSchema: { type: 'object', properties: {} } }] },
        }));
      }
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  return `http://127.0.0.1:${srv.address().port}/mcp`;
}

test('accounts API reuses unfinished sign-ins, labels first account, supports set-default, and deduplicates loop__save', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-accounts-api-'));
  const stubUrl = await startSimpleMcpStub(t);
  const srv = await startServer({ port: 0, dataDir: dir, legacy: true, seedBuiltins: false });
  t.after(async () => {
    await srv.close();
    closeAllWorkspaceDbs();
    await rm(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${srv.port}`;
  const setupRes = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'owner-password-1234' }),
  });
  assert.equal(setupRes.status, 200);
  const cookie = setupRes.headers.get('set-cookie').split(';')[0];
  const api = async (route, opts = {}) => {
    const res = await fetch(`${base}${route}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(opts.headers || {}) },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  // 1. Add initial unnamed supabase connection.
  const first = await api('/api/mcps', {
    method: 'POST',
    body: JSON.stringify({ name: 'supabase', transport: 'http', url: stubUrl }),
  });
  assert.equal(first.status, 201);
  assert.ok(first.body.mcp.serviceKey);

  // 2. Add a second scoped account while naming the first account cleanly.
  const second = await api(`/api/mcps/${first.body.mcp.id}/accounts`, {
    method: 'POST',
    body: JSON.stringify({ accountLabel: 'Project X', firstAccountLabel: 'All projects' }),
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.mcp.accountLabel, 'Project X');

  // Verify the first account received its label.
  const list1 = await api('/api/mcps');
  assert.equal(list1.body.mcps.find((m) => m.id === first.body.mcp.id).accountLabel, 'All projects');

  // 3. Re-requesting the same unfinished label reuses the pending account instead of making a third copy.
  const retry = await api(`/api/mcps/${first.body.mcp.id}/accounts`, {
    method: 'POST',
    body: JSON.stringify({ accountLabel: 'project x' }),
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.reused, true);
  assert.equal(retry.body.mcp.id, second.body.mcp.id);

  // 4. Re-requesting a label already on a ready account returns 409.
  const dupLabel = await api(`/api/mcps/${first.body.mcp.id}/accounts`, {
    method: 'POST',
    body: JSON.stringify({ accountLabel: 'All projects' }),
  });
  assert.equal(dupLabel.status, 409);
  assert.equal(dupLabel.body.existingId, first.body.mcp.id);

  // 5. Promote Project X to default via POST /api/mcps/:id/default-account.
  const defRes = await api(`/api/mcps/${second.body.mcp.id}/default-account`, { method: 'POST' });
  assert.equal(defRes.status, 200);
  assert.equal(defRes.body.defaultConnectionId, second.body.mcp.id);

  const svcRes = await api('/api/services');
  const supaSvc = svcRes.body.services.find((s) => s.key === first.body.mcp.serviceKey);
  assert.equal(supaSvc.defaultConnectionId, second.body.mcp.id);

  // 6. Agent loop__save for the same URL without a new accountLabel reuses the existing connection (no duplicate).
  const agRes = await api('/api/agents', {
    method: 'POST',
    body: JSON.stringify({ name: 'Test Bot', kind: 'claude-code', canManage: true }),
  });
  assert.equal(agRes.status, 201);
  const agentToken = agRes.body.token;
  const mcpCall = async (name, args) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${agentToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const payload = await res.json();
    const txt = payload?.result?.content?.[0]?.text || '{}';
    return JSON.parse(txt);
  };

  const reuseRes = await mcpCall('loop__save', {
    type: 'connection',
    data: { name: 'Supabase MCP', transport: 'http', url: stubUrl },
  });
  assert.equal(reuseRes.saved, true);
  assert.equal(reuseRes.alreadyExists, true);
  assert.equal((await api('/api/mcps')).body.mcps.length, 2, 'no third duplicate connection was created');

  // Distinct query scope (?project_ref=appB) is allowed as a separate scoped account.
  const scopedRes = await mcpCall('loop__save', {
    type: 'connection',
    data: { name: 'supabase', accountLabel: 'App B', transport: 'http', url: `${stubUrl}?project_ref=appB` },
  });
  assert.equal(scopedRes.saved, true);
  assert.equal(scopedRes.alreadyExists, undefined);
  assert.equal((await api('/api/mcps')).body.mcps.length, 3);

  // Turning off the App B connection and re-saving it returns alreadyExists with a clear note instead of a copy.
  await api(`/api/mcps/${scopedRes.connection.id}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled: false }),
  });
  const offReuse = await mcpCall('loop__save', {
    type: 'connection',
    data: { name: 'supabase', transport: 'http', url: `${stubUrl}?project_ref=appB` },
  });
  assert.equal(offReuse.saved, true);
  assert.equal(offReuse.alreadyExists, true);
  assert.match(offReuse.note || '', /turned off/i);
  assert.equal((await api('/api/mcps')).body.mcps.length, 3);
});

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

async function withDom(html, fn) {
  const dom = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const { window, document } = dom;
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    Element: globalThis.Element,
    Node: globalThis.Node,
    HTMLElement: globalThis.HTMLElement,
    HTMLDialogElement: globalThis.HTMLDialogElement,
    Event: globalThis.Event,
    CustomEvent: globalThis.CustomEvent,
    CSS: globalThis.CSS,
    matchMedia: globalThis.matchMedia,
    MutationObserver: globalThis.MutationObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = { origin: 'http://127.0.0.1:8799', pathname: '/', hash: '#home' };
  globalThis.history = { replaceState() {} };
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLDialogElement = window.HTMLDialogElement || class HTMLDialogElement { showModal() {} show() {} close() {} };
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.CSS = { escape: (s) => String(s).replace(/([^\w-])/g, '\\$1') };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.MutationObserver = class MutationObserver { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
  try {
    return await fn({ window, document });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
}

test('UI: no ctl-dup badge, grouped search matches account labels, popup & Add flow handle multi-account cleanly', async () => {
  const [appJs, appCss] = await Promise.all([
    readFile(path.resolve('public/app.js'), 'utf8'),
    readFile(path.resolve('public/app.css'), 'utf8'),
  ]);
  assert.equal(appJs.includes('ctl-dup'), false, 'Home no longer renders ctl-dup');
  assert.equal(appCss.includes('.ctl-dup'), false, 'CSS no longer defines .ctl-dup');

  // homeMatchScore matches grouped _accounts labels.
  const groupedItem = {
    id: 'supa_1',
    name: 'supabase',
    _accounts: [
      { id: 'supa_1', name: 'supabase', accountLabel: 'All projects' },
      { id: 'supa_2', name: 'supabase', accountLabel: 'Project X' },
    ],
  };
  assert.ok(homeMatchScore(groupedItem, 'project x') > 0);
  assert.ok(homeMatchScore(groupedItem, 'supabase') > 0);

  await withDom('<main></main>', async ({ document }) => {
    const { openAddConnectionPopup, openConnectionPopup, closeConnectionPopup } = await import('../public/connection-popup.js');
    const postCalls = [];
    const mockApi = async (route, opts = {}) => {
      if (route === '/api/profiles') return { profiles: [{ id: 'proj-b', name: 'Project B' }] };
      if (route === '/api/mcps/probe') {
        return { status: 'oauth', url: 'https://mcp.supabase.com/mcp', suggestedName: 'supabase', transport: 'http' };
      }
      if (route === '/api/mcps' && opts.method === 'POST') {
        postCalls.push(JSON.parse(opts.body));
        return { mcp: { id: 'unexpected_dup', name: 'supabase' } };
      }
      if (route === '/api/mcps') {
        return {
          mcps: [
            {
              id: 'supa_1',
              name: 'supabase',
              serviceKey: 'mcp.supabase.com/mcp',
              transport: 'http',
              url: 'https://mcp.supabase.com/mcp',
              enabled: true,
              profiles: ['all'],
              tools: [{ name: 'list_projects', enabled: true }],
              readiness: { ready: true, state: 'ready', label: 'Ready', discoveredTools: 1, enabledTools: 1 },
            },
            {
              id: 'supa_2',
              name: 'supabase',
              accountLabel: 'Project X',
              serviceKey: 'mcp.supabase.com/mcp',
              transport: 'http',
              url: 'https://mcp.supabase.com/mcp',
              enabled: true,
              authRequired: true,
              profiles: ['all'],
              tools: [],
              readiness: { ready: false, state: 'needs_sign_in', label: 'Needs sign-in', action: 'sign_in' },
            },
          ],
        };
      }
      if (route === '/api/services') {
        return {
          services: [{
            key: 'mcp.supabase.com/mcp',
            name: 'supabase',
            defaultConnectionId: 'supa_1',
            accounts: [
              { connectionId: 'supa_1', name: 'supabase', accountLabel: '', label: 'supabase', ready: true, enabled: true },
              { connectionId: 'supa_2', name: 'supabase', accountLabel: 'Project X', label: 'Project X', ready: false, enabled: true, needsSignIn: true },
            ],
            agents: [],
          }],
        };
      }
      if (route === '/api/agents') return { agents: [] };
      if (route === '/api/policies') return { policies: {} };
      return {};
    };

    // 1. Pasting an existing URL in Add Connection shows the exists card instead of creating a duplicate.
    await openAddConnectionPopup({ esc, api: mockApi, toast() {} }, {});
    const urlInput = document.querySelector('#cp-add-url');
    urlInput.value = 'https://mcp.supabase.com/mcp';
    urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#cp-add-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(postCalls.length, 0, 'did not silently POST a duplicate connection');
    const existsCard = document.querySelector('[data-cp-exists-card]');
    assert.ok(existsCard, 'shows existing connection card');
    assert.match(existsCard.textContent, /supabase is already in your Loop/);
    assert.ok(document.querySelector('#cp-exists-label'));
    assert.ok(document.querySelector('[data-cp-exists-add]'));
    assert.ok(document.querySelector('[data-cp-exists-open]'));
    closeConnectionPopup({ immediate: true, quiet: true });

    // 2. Connection popup renders Default + Project X with Set default & Disconnect actions and inline Add account form.
    await openConnectionPopup({ esc, api: mockApi, toast() {}, renderConnLogo: () => '' }, 'supa_1');
    try {
      const text = document.body.textContent;
      assert.match(text, /Default/);
      assert.match(text, /Project X/);
      assert.match(text, /active/);
      assert.ok(document.querySelector('[data-cp-acc-default="supa_2"]'));
      assert.ok(document.querySelector('[data-cp-acc-disconnect="supa_2"]'));
      document.querySelector('[data-cp-add-account]').click();
      assert.ok(document.querySelector('[data-cp-acc-form] input[name="accountLabel"]'));
      assert.match(document.querySelector('[data-cp-acc-form]').textContent, /Continue/);
    } finally {
      closeConnectionPopup({ immediate: true, quiet: true });
    }
  });

  // 3. Bot OAuth consent labels unnamed multi-account rows as "Default" alongside named scopes.
  await withDom('<button id="oauth-allow"></button><button id="oauth-expand"><span id="oc-expand-label"></span></button><div id="oc-drawer"><div id="oc-picker"></div></div>', async ({ document }) => {
    mountOAuthConsentPicker(document.body, {
      esc,
      renderConnLogo: () => '',
      groupConnectionsByCategory: (mcps) => [{ id: 'databases', label: 'Databases', mcps }],
      api: async (route) => {
        if (route === '/api/overview' || route === '/api/mcps') {
          return {
            mcps: [
              { id: 'supa_1', name: 'supabase', serviceKey: 'mcp.supabase.com/mcp', enabled: true, profiles: ['all'], tools: [{ name: 'q', enabled: true }], readiness: { ready: true } },
              { id: 'supa_2', name: 'supabase', accountLabel: 'Project X', serviceKey: 'mcp.supabase.com/mcp', enabled: true, profiles: ['all'], tools: [{ name: 'q', enabled: true }], readiness: { ready: true } },
            ],
            categories: [{ id: 'databases', label: 'Databases', connections: [{ id: 'supa_1' }, { id: 'supa_2' }], skills: [] }],
            skills: [],
            secrets: [],
            agents: [],
          };
        }
        return { skills: [], secrets: [], agents: [] };
      },
      clientName: 'Claude Code',
      defaultProfile: 'all',
    });
    await new Promise((r) => setTimeout(r, 40));
    const text = document.querySelector('#oc-picker').textContent;
    assert.match(text, /supabase · Default/);
    assert.match(text, /supabase · Project X/);
  });
});

test('update lifecycle: 1-hour remote staleness, version-bump auto-refresh, and tool-mismatch reactive refresh', async (t) => {
  const MINUTE = 60 * 1000;
  const now = Date.parse('2026-11-25T12:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();

  // Remote HTTP connections go stale after 1 hour; local stdio stays at 6 hours.
  assert.equal(REMOTE_STALE_SYNC_MS, 60 * MINUTE);
  assert.equal(STALE_SYNC_MS, 360 * MINUTE);
  assert.equal(
    needsAutoSync({ enabled: true, transport: 'http', url: 'https://mcp.supabase.com/mcp', syncVersion: 99, lastSyncAt: ago(59 * MINUTE), syncFailures: 0, lastError: null }, now),
    false,
  );
  assert.equal(
    needsAutoSync({ enabled: true, transport: 'http', url: 'https://mcp.supabase.com/mcp', syncVersion: 99, lastSyncAt: ago(61 * MINUTE), syncFailures: 0, lastError: null }, now),
    true,
  );
  assert.equal(
    needsAutoSync({ enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'srv'], syncVersion: 99, lastSyncAt: ago(90 * MINUTE), syncFailures: 0, lastError: null }, now),
    false,
  );

  // Tool schema mismatch detector catches JSON-RPC codes and tool-not-found / invalid-params text.
  assert.equal(isToolSchemaMismatchError({ code: -32601, message: 'Method not found' }), true);
  assert.equal(isToolSchemaMismatchError({ code: -32602, message: 'Invalid params' }), true);
  assert.equal(isToolSchemaMismatchError({ isError: true, content: [{ type: 'text', text: 'Unknown tool: old_query' }] }), true);
  assert.equal(isToolSchemaMismatchError({ isError: true, content: [{ type: 'text', text: 'Rate limit exceeded' }] }), false);

  // Live MCP stub that changes serverVersion and tools dynamically.
  let version = '1.0.0';
  let tools = [{ name: 'old_tool', description: 'Old', inputSchema: { type: 'object', properties: {} } }];
  let failToolCallsWithUnknown = false;
  const stub = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const msg = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (msg.method === 'initialize') {
        return res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'supabase', version } },
        }));
      }
      if (msg.method === 'tools/list') {
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools } }));
      }
      if (msg.method === 'tools/call') {
        if (failToolCallsWithUnknown) {
          return res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { isError: true, content: [{ type: 'text', text: `Unknown tool: ${msg.params?.name}` }] },
          }));
        }
        return res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'ok' }] },
        }));
      }
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => stub.close(r)));
  const stubUrl = `http://127.0.0.1:${stub.address().port}/mcp`;

  const dir = await mkdtemp(path.join(tmpdir(), 'loop-update-life-'));
  let clock = Date.now();
  const store = new LoopStore(dir);
  const vault = new Vault(dir);
  const pool = new ConnectionPool(store, vault, { now: () => clock });
  t.after(async () => {
    await pool.closeAll();
    closeAllWorkspaceDbs();
    await rm(dir, { recursive: true, force: true });
  });

  // 1. Initial sync saves serverVersion 1.0.0 and old_tool.
  const conn = await store.add({ name: 'supabase', transport: 'http', url: stubUrl });
  const synced1 = await pool.sync(conn.id);
  assert.equal(synced1.serverVersion, '1.0.0');
  assert.deepEqual(synced1.tools.map((x) => x.name), ['old_tool']);

  // 2. Vendor deploys 1.0.1 (renames old_tool -> renamed_tool) while session is open; tool mismatch triggers immediate refresh.
  clock += 120_000;
  tools = [{ name: 'renamed_tool', description: 'Renamed', inputSchema: { type: 'object', properties: {} } }];
  failToolCallsWithUnknown = true;
  const errRes = await pool.callTool(conn.id, 'old_tool', {});
  assert.equal(errRes.isError, true);
  // Wait for background reactive sync to settle.
  for (let i = 0; i < 40 && !pool.isIdle(); i += 1) await new Promise((r) => setTimeout(r, 20));
  const afterMismatch = await store.get(conn.id);
  assert.deepEqual(afterMismatch.tools.map((x) => x.name), ['renamed_tool']);

  // 3. Vendor deploys 2.0.0 with new_tool; retiring session and reconnecting detects version bump and refreshes automatically.
  clock += 120_000;
  failToolCallsWithUnknown = false;
  version = '2.0.0';
  tools = [{ name: 'renamed_tool', description: 'Renamed', inputSchema: { type: 'object', properties: {} } }, { name: 'new_v2_tool', description: 'New', inputSchema: { type: 'object', properties: {} } }];
  await pool.retire(conn.id);
  await pool.callTool(conn.id, 'renamed_tool', {});
  for (let i = 0; i < 40 && !pool.isIdle(); i += 1) await new Promise((r) => setTimeout(r, 20));
  const afterVersionBump = await store.get(conn.id);
  assert.equal(afterVersionBump.serverVersion, '2.0.0');
  assert.deepEqual(afterVersionBump.tools.map((x) => x.name), ['renamed_tool', 'new_v2_tool']);
});

test('sibling account sync, address propagation, and safe in-place import updates', async (t) => {
  // Unit checks for package identity and update guards.
  assert.equal(extractStdioPackageIdentity('npx', ['-y', '@supabase/mcp-server@1.2.0']), 'npx:@supabase/mcp-server');
  assert.equal(extractStdioPackageIdentity('/usr/local/bin/npx', ['-y', '@supabase/mcp-server@2.0.0']), 'npx:@supabase/mcp-server');
  assert.equal(extractStdioPackageIdentity('uvx', ['mcp-server-git==0.1.0']), 'uvx:mcp-server-git');
  assert.equal(extractStdioPackageIdentity('docker', ['run', '-i', '--rm', 'ghcr.io/org/mcp:v1']), 'docker:ghcr.io/org/mcp');

  const dir = await mkdtemp(path.join(tmpdir(), 'loop-update-import-'));
  let toolName = 'v1_tool';
  const stub = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const msg = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (msg.method === 'initialize') {
        return res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'supabase', version: '1.0.0' } },
        }));
      }
      if (msg.method === 'tools/list') {
        return res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: [{ name: toolName, description: 'Tool', inputSchema: { type: 'object', properties: {} } }] },
        }));
      }
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => stub.close(r)));
  const stubOrigin = `http://127.0.0.1:${stub.address().port}`;
  const urlV1 = `${stubOrigin}/v1/mcp`;
  const urlV2 = `${stubOrigin}/v2/mcp`;
  const urlProjB = `${stubOrigin}/v1/mcp?project_ref=projB`;

  const srv = await startServer({ port: 0, dataDir: dir, legacy: true, seedBuiltins: false });
  t.after(async () => {
    await srv.close();
    closeAllWorkspaceDbs();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${srv.port}`;
  const setupRes = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'owner-password-1234' }),
  });
  const cookie = setupRes.headers.get('set-cookie').split(';')[0];
  const api = async (route, opts = {}) => {
    const res = await fetch(`${base}${route}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(opts.headers || {}) },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  // Create two accounts on urlV1 plus one query-scoped account on urlProjB.
  const acc1 = await api('/api/mcps', {
    method: 'POST',
    body: JSON.stringify({ name: 'supabase', transport: 'http', url: urlV1 }),
  });
  const acc2 = await api('/api/mcps', {
    method: 'POST',
    body: JSON.stringify({ name: 'supabase', accountLabel: 'Project X', transport: 'http', url: urlV1 }),
  });
  const accProjB = await api('/api/mcps', {
    method: 'POST',
    body: JSON.stringify({ name: 'supabase', accountLabel: 'Proj B', transport: 'http', url: urlProjB }),
  });
  assert.equal(acc1.status, 201);
  assert.equal(acc2.status, 201);
  assert.equal(accProjB.status, 201);

  // 1. Manual refresh on acc1 refreshes sibling accounts on the same service.
  toolName = 'v2_tool';
  const syncRes = await api(`/api/mcps/${acc1.body.mcp.id}/sync`, { method: 'POST', body: '{}' });
  assert.equal(syncRes.status, 200);
  assert.equal(syncRes.body.syncedSiblings, 2);
  await new Promise((r) => setTimeout(r, 120));
  const afterSyncList = (await api('/api/mcps')).body.mcps;
  assert.deepEqual(afterSyncList.find((m) => m.id === acc2.body.mcp.id).tools.map((x) => x.name), ['v2_tool']);

  // 2. PATCH with applyToService: true propagates urlV1 -> urlV2 to acc2 (same exact old URL) but NOT accProjB.
  const patchRes = await api(`/api/mcps/${acc1.body.mcp.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ url: urlV2, applyToService: true }),
  });
  assert.equal(patchRes.status, 200);
  const afterPatchList = (await api('/api/mcps')).body.mcps;
  assert.equal(afterPatchList.find((m) => m.id === acc1.body.mcp.id).url, urlV2);
  assert.equal(afterPatchList.find((m) => m.id === acc2.body.mcp.id).url, urlV2);
  assert.equal(afterPatchList.find((m) => m.id === accProjB.body.mcp.id).url, urlProjB, 'query-scoped sibling kept untouched');

  // 3. Importing updated JSON path updates in place instead of creating a duplicate.
  const urlV3 = `${stubOrigin}/v3/mcp`;
  const impRes = await api('/api/mcps/import', {
    method: 'POST',
    body: JSON.stringify({ json: JSON.stringify({ mcpServers: { supabase: { url: urlV3 } } }) }),
  });
  assert.equal(impRes.status, 200);
  assert.equal(impRes.body.added.length, 0);
  assert.equal(impRes.body.updated.length, 1);
  assert.equal(impRes.body.updated[0].id, acc1.body.mcp.id);
  assert.equal(impRes.body.updated[0].url, urlV3);

  // 4. Guards: different credentials (G6-04) and different query scopes are NOT overwritten by import updates.
  const guardStore = new LoopStore(await mkdtemp(path.join(tmpdir(), 'loop-import-guard-')));
  const guardVault = new Vault(guardStore.dir);
  t.after(() => rm(guardStore.dir, { recursive: true, force: true }));
  await guardStore.add({ name: 'api', transport: 'http', url: 'https://api.example.test/v1', headers: { Authorization: 'Bearer tok-A' } });
  await guardStore.add({ name: 'supa', transport: 'http', url: 'https://mcp.supabase.com/mcp?project_ref=appA' });
  await guardStore.add({ name: 'local-cli', transport: 'stdio', command: 'npx', args: ['-y', '@org/mcp@1.0.0', '--api-key', 'secret-A'] });

  const existing = await guardStore.list();
  assert.equal(
    await findUpdatableConnection({ name: 'api', transport: 'http', url: 'https://api.example.test/v2', headers: { Authorization: 'Bearer tok-B' } }, existing, guardVault),
    null,
    'different bearer token is a separate account, never an overwrite',
  );
  assert.equal(
    await findUpdatableConnection({ name: 'supa', transport: 'http', url: 'https://mcp.supabase.com/mcp?project_ref=appB', headers: {} }, existing, guardVault),
    null,
    'different query scope (?project_ref=appB) never overwrites ?project_ref=appA',
  );
  assert.equal(
    await findUpdatableConnection({ name: 'local-cli', transport: 'stdio', command: 'npx', args: ['-y', '@org/mcp@2.0.0', '--api-key', 'secret-B'], env: {} }, existing, guardVault),
    null,
    'different --api-key arg never overwrites existing stdio account',
  );
  const pkgMatch = await findUpdatableConnection({ name: 'local-cli', transport: 'stdio', command: 'npx', args: ['-y', '@org/mcp@2.0.0', '--api-key', 'secret-A'], env: {} }, existing, guardVault);
  assert.ok(pkgMatch, 'same stdio package with matching credentials updates in place');

  // Verify importCandidates updates the stdio package in place while preserving its id.
  const stdioImp = await importCandidates(
    guardStore,
    guardVault,
    [{ name: 'local-cli', candidate: { name: 'local-cli', transport: 'stdio', command: 'npx', args: ['-y', '@org/mcp@2.0.0', '--api-key', 'secret-A'], env: {} } }],
    { updateExisting: true },
  );
  assert.equal(stdioImp.added.length, 0);
  assert.equal(stdioImp.updated.length, 1);
  assert.equal(stdioImp.updated[0].entry.id, pkgMatch.id);
});
