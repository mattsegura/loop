// Wave 1 regression tests verifying stored state and owner/recipient UI for:
// 1. Vault name collision preserves the original item and approval rule; explicit overwrite clears stale username.
// 2. "Share Memory only" grants narrow empty allowlists (canManage: false, allowedConnections: [], allowedSkills: []),
//    matches confirmation and recipient preview, stays narrow tomorrow when new items are added, and offers review on broad grants.
// 3. Saved preserves both primary text and annotation and rejects over-limit notes without truncating.
// 4. Live SSE updates refresh the Saved list without erasing an unfinished draft, optional fields, or focus.
// 5. Failed reads show Unavailable + Retry instead of Allow, 0, or an empty library.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';

import { startServer } from '../server.mjs';
import { closeAllWorkspaceDbs } from '../lib/storage/workspace-db.mjs';
import { describeShareGrant, mountOAuthConsentPicker } from '../public/oauth-consent-view.js';
import { rowsHtml } from '../public/agent-link.js';
import {
  renderSaved,
  refreshSavedLive,
  renderSavedList,
  renderSchedulesSection,
} from '../public/saved-view.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[c]));

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-wave1-'));
  try {
    return await fn(dir);
  } finally {
    closeAllWorkspaceDbs();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function withDom(html, fn) {
  const dom = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const { window, document } = dom;
  const savedGlobals = {
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
    setTimeout: globalThis.setTimeout,
  };
  let activeEl = document.body;
  Object.defineProperty(document, 'activeElement', {
    configurable: true,
    get: () => activeEl,
  });
  const origFocus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function focusPatched() {
    activeEl = this;
    if (typeof origFocus === 'function') {
      try { origFocus.call(this); } catch { /* ignore */ }
    }
  };
  if (typeof window.HTMLElement.prototype.getBoundingClientRect !== 'function') {
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 });
  }
  const origSetTimeout = globalThis.setTimeout;
  const timers = new Set();
  globalThis.setTimeout = (cb, ms, ...args) => {
    const id = origSetTimeout(() => {
      timers.delete(id);
      cb(...args);
    }, ms);
    timers.add(id);
    return id;
  };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = { origin: 'http://127.0.0.1:8799', pathname: '/', hash: '#knowledge/saved' };
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
    return await fn({ window, document, setActiveElement: (el) => { activeEl = el; } });
  } finally {
    for (const id of timers) clearTimeout(id);
    timers.clear();
    for (const [k, v] of Object.entries(savedGlobals)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
}

test('an exact-action agent shows the account, permitted actions and revoke controls', async () => {
  await withDom('<main></main>', async ({ document }) => {
    const { openAgentPopup, closeAgentPopup } = await import('../public/agent-popup.js');
    const agent = {
      id: 'ag_scoped', name: 'Fixture agent', kind: 'grok-bot', enabled: true,
      toolGrants: { work: ['list_files', 'read_file'] }, allowedConnections: ['work'], allowedSkills: [],
    };
    const api = async (url) => {
      if (url === '/api/agents') return { agents: [agent], connected: [] };
      if (url === '/api/overview') return { mcps: [{ id: 'work', name: 'Drive', accountLabel: 'Work account' }] };
      return { entries: [] };
    };
    await openAgentPopup({ esc, api, addAgent() {} }, agent.id, 'access');
    try {
      const pane = document.querySelector('#ap-pane');
      assert.match(pane.textContent, /Drive.*Work account/s);
      for (const action of agent.toolGrants.work) assert.match(pane.textContent, new RegExp(action));
      assert.match(pane.textContent, /Reconnect Loop from the agent.*Change shared actions/s);
      assert.equal(document.querySelector('[data-ap-reset-scope], [data-ap-memory-only], [data-ap-edit]'), null);
      assert.equal(document.querySelector('[data-ap-toggle]').textContent, 'Turn off');
      assert.ok(document.querySelector('[data-ap-remove]'));
    } finally {
      closeAgentPopup({ immediate: true, quiet: true });
    }
  });
});

async function setupLoopServer(dir, { seedBuiltins = false } = {}) {
  const srv = await startServer({ port: 0, dataDir: dir, legacy: true, seedBuiltins });
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
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        ...(opts.headers || {}),
      },
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };

  return { srv, base, cookie, api };
}

/* ---------------- Outcome 1: Vault collision preserves original item & approval rule ---------------- */

test('Wave 1.1: Vault rejects same-named create without overwrite, preserves login & Ask rule, and clears username on explicit replace', async () => {
  await withTempDir(async (dir) => {
    const { srv, api } = await setupLoopServer(dir);
    try {
      // 1. Create a login (default vaultTypes.login policy is always_ask).
      const created = await api('/api/vault', {
        method: 'POST',
        body: JSON.stringify({
          key: 'github_login',
          value: 'orig-login-password-99',
          type: 'login',
          username: 'alice@example.com',
          approval: 'inherit',
        }),
      });
      assert.equal(created.status, 201);
      assert.equal(created.json.secret.type, 'login');
      assert.equal(created.json.secret.username, 'alice@example.com');
      assert.equal(created.json.secret.approval, 'inherit');

      // 2. Attempt to create an API key with the colliding name (no overwrite flag).
      const collision = await api('/api/vault', {
        method: 'POST',
        body: JSON.stringify({
          key: 'github_login',
          value: 'sk-colliding-api-key-00',
          type: 'api_key',
        }),
      });
      assert.equal(collision.status, 409);
      assert.equal(collision.json.code, 'VAULT_EXISTS');
      assert.equal(collision.json.existing.type, 'login');
      assert.equal(collision.json.existing.username, 'alice@example.com');
      assert.equal(collision.json.existingApproval, 'always_ask');

      // 3. Verify original login value, type, username, and inherited approval rule are untouched.
      const listAfter = await api('/api/vault');
      assert.equal(listAfter.json.secrets.length, 1);
      assert.equal(listAfter.json.secrets[0].type, 'login');
      assert.equal(listAfter.json.secrets[0].username, 'alice@example.com');
      assert.equal(listAfter.json.secrets[0].approval, 'inherit');

      const revealed = await api('/api/vault/github_login/reveal', {
        method: 'POST',
        body: JSON.stringify({ password: 'owner-password-1234' }),
      });
      assert.equal(revealed.status, 200);
      assert.equal(revealed.json.value, 'orig-login-password-99');

      // 4. Explicit confirmed replacement updates value and type and drops stale login username.
      const replaced = await api('/api/vault', {
        method: 'POST',
        body: JSON.stringify({
          key: 'github_login',
          value: 'sk-confirmed-replacement-77',
          type: 'api_key',
          overwrite: true,
        }),
      });
      assert.equal(replaced.status, 200);
      assert.equal(replaced.json.replaced, true);
      assert.equal(replaced.json.secret.type, 'api_key');
      assert.equal(replaced.json.secret.username, undefined);

      const revealedAfter = await api('/api/vault/github_login/reveal', {
        method: 'POST',
        body: JSON.stringify({ password: 'owner-password-1234' }),
      });
      assert.equal(revealedAfter.json.value, 'sk-confirmed-replacement-77');
    } finally {
      await srv.close();
    }
  });
});

/* ---------------- Outcome 2: "Share Memory only" stays narrow today AND tomorrow ---------------- */

test('Wave 1.2: "Share Memory only" produces narrow empty allowlists, matches button/preview, and excludes items added tomorrow', async () => {
  // Part A: Picker + confirmation button labels with 0 connections, 0 skills, and 1 unselected Vault secret.
  let pickedAccess = null;
  await withDom('<div id="host"><div id="oc-picker"></div></div>', async ({ document }) => {
    let lastSummary = null;
    const host = document.getElementById('host');
    const picker = mountOAuthConsentPicker(host, {
      esc,
      api: async (route) => {
        if (route === '/api/overview') return { mcps: [], categories: [] };
        if (route === '/api/vault') return { secrets: [{ key: 'STRIPE_KEY', type: 'api_key', description: 'Stripe' }] };
        return {};
      },
      renderConnLogo: () => '',
      groupConnectionsByCategory: () => [],
      clientName: 'Memory Helper',
      panel: true,
      onChange: (sum) => { lastSummary = sum; },
    });

    // Wait for loadCatalog microtasks.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(lastSummary.ready, true);
    assert.equal(lastSummary.canManage, false);
    assert.equal(lastSummary.includeFuture, false);
    assert.equal(describeShareGrant(lastSummary).buttonLabel, 'Share Memory only');
    assert.equal(describeShareGrant(lastSummary).summaryText, 'Memory only');

    pickedAccess = picker.getAccess();
    assert.deepEqual(pickedAccess, {
      allowedConnections: [],
      allowedSkills: [],
      memoryAccess: 'read_write',
      canManage: false,
      secrets: [],
    });

    // Opting into Manage connections updates confirmation label so it never says "Memory only".
    host.querySelector('[data-oc-manage]').click();
    assert.equal(lastSummary.canManage, true);
    assert.equal(describeShareGrant(lastSummary).buttonLabel, 'Share Memory and manage connections');
    assert.equal(picker.getAccess().canManage, true);

    // Opting into Future items switches allowlists to null and updates confirmation label.
    host.querySelector('[data-oc-future]').click();
    assert.equal(lastSummary.includeFuture, true);
    assert.equal(picker.getAccess().allowedConnections, null);
    assert.equal(picker.getAccess().allowedSkills, null);
    assert.match(describeShareGrant(lastSummary).buttonLabel, /future items/i);
    assert.match(describeShareGrant(lastSummary).buttonLabel, /manage connections/i);

    // Turning both back off returns to exact narrow memory-only access.
    host.querySelector('[data-oc-future]').click();
    host.querySelector('[data-oc-manage]').click();
    assert.deepEqual(picker.getAccess(), pickedAccess);
    assert.equal(describeShareGrant(lastSummary).buttonLabel, 'Share Memory only');
  });

  // Part B: End-to-end server + recipient preview + "tomorrow" test.
  await withTempDir(async (dir) => {
    const { srv, base, api } = await setupLoopServer(dir, { seedBuiltins: false });
    try {
      // Seed 1 unselected Vault secret, 0 connections, 0 custom skills.
      await api('/api/vault', {
        method: 'POST',
        body: JSON.stringify({ key: 'STRIPE_KEY', value: 'sk-test-vault-1234', type: 'api_key' }),
      });

      // Create the agent with the exact access object returned by "Share Memory only".
      const made = await api('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Memory Helper', kind: 'cursor', ...pickedAccess }),
      });
      assert.equal(made.status, 201);
      const { agent, token } = made.json;
      assert.equal(agent.canManage, false);
      assert.deepEqual(agent.allowedConnections, []);
      assert.deepEqual(agent.allowedSkills, []);
      assert.equal(agent.memoryAccess, 'read_write');

      // Check recipient link preview matches the exact grant (no management, no future access).
      const linkRes = await api(`/api/agents/${agent.id}/link`, {
        method: 'POST',
        body: JSON.stringify({ from: 'Owner' }),
      });
      assert.equal(linkRes.status, 201);
      const parsedLink = new URL(linkRes.json.url);
      const linkId = parsedLink.pathname.split('/').pop();
      const claimCode = decodeURIComponent(parsedLink.hash.slice(1));
      const preview = await fetch(`${base}/api/agent-handoff/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: linkId, claimCode }),
      }).then((r) => r.json());
      assert.equal(preview.agent.canManage, false);
      assert.equal(preview.agent.futureConnections, false);
      assert.equal(preview.agent.futureSkills, false);
      const previewHtml = rowsHtml(preview);
      assert.match(previewHtml, /Memory/);
      assert.doesNotMatch(previewHtml, /Manage connections/);
      assert.doesNotMatch(previewHtml, /Any added later/);

      // A broad agent with canManage + future access MUST disclose both in recipient preview.
      const broadMade = await api('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Admin Helper',
          kind: 'claude-code',
          canManage: true,
          allowedConnections: null,
          allowedSkills: null,
          memoryAccess: 'read_write',
        }),
      });
      const broadLink = await api(`/api/agents/${broadMade.json.agent.id}/link`, {
        method: 'POST',
        body: JSON.stringify({ from: 'Owner' }),
      });
      const broadUrl = new URL(broadLink.json.url);
      const broadPreview = await fetch(`${base}/api/agent-handoff/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: broadUrl.pathname.split('/').pop(),
          claimCode: decodeURIComponent(broadUrl.hash.slice(1)),
        }),
      }).then((r) => r.json());
      assert.equal(broadPreview.agent.canManage, true);
      assert.equal(broadPreview.agent.futureConnections, true);
      const broadHtml = rowsHtml(broadPreview);
      assert.match(broadHtml, /Manage connections/);
      assert.match(broadHtml, /Any added later/);

      // TOMORROW: owner adds a brand-new connection and a brand-new custom skill.
      const newConn = await api('/api/mcps', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Tomorrow CRM',
          transport: 'http',
          url: 'https://crm.example.test/mcp',
          token: 'crm-secret-token',
        }),
      });
      assert.equal(newConn.status, 201);

      const callMcp = async (bearer, method, params = {}) => {
        const res = await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        return (await res.json()).result;
      };

      const savedSkill = await callMcp(broadMade.json.token, 'tools/call', {
        name: 'loop__save',
        arguments: {
          type: 'skill',
          id: 'tomorrow-playbook',
          data: {
            name: 'Tomorrow Playbook',
            description: 'Internal playbook added tomorrow',
            content: '# Tomorrow Playbook\nFollow these private steps.',
          },
        },
      });
      assert.notEqual(savedSkill.isError, true);
      const savedSkillId = JSON.parse(savedSkill.content[0].text).skill.id;

      // Confirm the workspace now contains the new skill (Admin Helper can see it).
      const adminSkills = JSON.parse((await callMcp(broadMade.json.token, 'tools/call', { name: 'loop__search', arguments: { type: 'skills', query: 'Tomorrow Playbook' } })).content[0].text);
      assert.ok((adminSkills.skills || []).some((s) => s.id === savedSkillId));

      // Memory Helper still sees ZERO connections and ZERO custom skills tomorrow.
      const connSearch = JSON.parse((await callMcp(token, 'tools/call', { name: 'loop__search', arguments: { type: 'connections' } })).content[0].text);
      assert.deepEqual(connSearch.connections, []);

      const skillSearch = JSON.parse((await callMcp(token, 'tools/call', { name: 'loop__search', arguments: { type: 'skills', query: 'Tomorrow Playbook' } })).content[0].text);
      const visibleCustomSkills = (skillSearch.skills || []).filter((s) => s.id === savedSkillId || /Tomorrow Playbook/i.test(s.name || ''));
      assert.deepEqual(visibleCustomSkills, []);

      // Memory Helper cannot inspect tomorrow's skill directly either.
      const skillInspect = await callMcp(token, 'tools/call', {
        name: 'loop__inspect',
        arguments: { type: 'skill', id: savedSkillId },
      });
      assert.equal(skillInspect.isError, true);

      // Memory Helper cannot manage connections.
      const manageAttempt = await callMcp(token, 'tools/call', {
        name: 'loop__save',
        arguments: { type: 'connection', action: 'delete', id: newConn.json.mcp.id },
      });
      assert.equal(manageAttempt.isError, true);
      assert.match(manageAttempt.content[0].text, /not allowed|manage connections/i);

      // Memory Helper CAN still save and search Memory.
      const memSave = await callMcp(token, 'tools/call', {
        name: 'loop__save',
        arguments: { type: 'memory', data: { key: 'tone_pref', content: 'Keep updates concise and direct.' } },
      });
      assert.notEqual(memSave.isError, true);
      const memSearch = JSON.parse((await callMcp(token, 'tools/call', { name: 'loop__search', arguments: { type: 'memory', query: 'concise' } })).content[0].text);
      assert.equal(memSearch.memories.length, 1);
    } finally {
      await srv.close();
    }
  });
});

/* ---------------- Outcome 3: Saved preserves primary text + annotation & enforces limits ---------------- */

test('Wave 1.3: Saved stores both primary text and annotation, renders both, and rejects 4,014-char note with 400', async () => {
  await withTempDir(async (dir) => {
    const { srv, api } = await setupLoopServer(dir);
    try {
      const saved = await api('/api/saved', {
        method: 'POST',
        body: JSON.stringify({
          text: 'Rotate the staging webhook certificate on Friday',
          note: 'Q4 release ops checklist',
          tags: ['ops'],
        }),
      });
      assert.equal(saved.status, 201);
      assert.equal(saved.json.item.markdown, 'Rotate the staging webhook certificate on Friday');
      assert.equal(saved.json.item.note, 'Q4 release ops checklist');
      assert.equal(saved.json.item.displayTitle, 'Rotate the staging webhook certificate on Friday');

      // Both primary text and annotation are searchable.
      const byPrimary = await api('/api/saved?query=webhook');
      assert.equal(byPrimary.json.items.length, 1);
      const byReason = await api('/api/saved?query=checklist');
      assert.equal(byReason.json.items.length, 1);

      // Owner list rendering displays both the primary text and the annotation.
      const html = renderSavedList({ loaded: true, items: [saved.json.item], error: '' }, [saved.json.item], '', esc);
      assert.match(html, /Rotate the staging webhook certificate on Friday/);
      assert.match(html, /Q4 release ops checklist/);

      // 4,014-character note is rejected with 400 (never silently truncated to 4,000).
      const tooLong = await api('/api/saved', {
        method: 'POST',
        body: JSON.stringify({ text: 'x'.repeat(4014) }),
      });
      assert.equal(tooLong.status, 400);
      assert.equal(tooLong.json.code, 'SAVED_TOO_LONG');

      const allAfter = await api('/api/saved');
      assert.equal(allAfter.json.total, 1);
    } finally {
      await srv.close();
    }
  });
});

/* ---------------- Outcome 4: Second-tab live SSE updates preserve unfinished draft & focus ---------------- */

test('Wave 1.4: Live Saved refresh updates the list while preserving composer text, optional fields, and focus', async () => {
  await withDom('<div id="root"></div>', async ({ document }) => {
    const root = document.getElementById('root');
    const savedItems = [
      { id: 'sav_1', kind: 'note', displayTitle: 'Existing note', note: 'Existing note', updatedAt: new Date().toISOString(), projects: ['all'] },
    ];
    const mockApi = async (route) => {
      if (route.startsWith('/api/saved')) return { items: [...savedItems], total: savedItems.length };
      if (route === '/api/files') return { files: [] };
      if (route === '/api/schedules') return { schedules: [] };
      if (route === '/api/overview') return { profileRecords: [] };
      if (route === '/api/policies') return { policies: { default: 'auto', actions: { saved: 'always_ask', file: 'auto', schedule: 'auto' } } };
      if (route.startsWith('/api/memory')) return { memories: [] };
      return {};
    };

    await renderSaved(root, {
      esc,
      api: mockApi,
      toast: () => {},
      copyText: () => {},
      isCurrent: () => true,
      params: new URLSearchParams(),
      part: 'saved',
      activeProfile: () => 'all',
      syncTopChrome: () => {},
      pageTop: ({ title }) => `<h1>${title}</h1>`,
    });

    const formBefore = root.querySelector('#saved-quick-form');
    const inputBefore = root.querySelector('#saved-quick-input');
    const extraBefore = root.querySelector('#saved-composer-extra');
    const noteBefore = formBefore.querySelector('input[name="note"]');

    // Simulate owner drafting in Tab A with optional fields open and focus in the primary field.
    root.querySelector('#saved-more-toggle').click();
    assert.equal(extraBefore.hidden, false);
    inputBefore.value = 'Draft note in Tab A';
    noteBefore.value = 'Reason drafted in Tab A';
    inputBefore.focus();
    assert.equal(document.activeElement, inputBefore);

    // Simulate Tab B saving a new item and SSE triggering refreshSavedLive() in Tab A.
    savedItems.unshift({
      id: 'sav_2',
      kind: 'note',
      displayTitle: 'Saved from Tab B',
      note: 'Saved from Tab B',
      updatedAt: new Date().toISOString(),
      projects: ['all'],
    });
    const refreshed = await refreshSavedLive();
    assert.equal(refreshed, true);

    // List updated with Tab B's item, while Tab A's composer node, draft values, open options, and focus survived intact.
    assert.match(root.querySelector('#saved-content').innerHTML, /Saved from Tab B/);
    assert.equal(root.querySelector('#saved-quick-form'), formBefore);
    assert.equal(root.querySelector('#saved-quick-input'), inputBefore);
    assert.equal(inputBefore.value, 'Draft note in Tab A');
    assert.equal(noteBefore.value, 'Reason drafted in Tab A');
    assert.equal(extraBefore.hidden, false);
    assert.equal(document.activeElement, inputBefore);
  });
});

/* ---------------- Outcome 5: Failed reads show Unavailable + Retry instead of Allow, 0, or empty ---------------- */

test('Wave 1.5: Failed reads show Unavailable + Retry for Files, Policies, Schedules, and Activity, and expose broad-access review', async () => {
  await withDom('<div id="root"></div>', async ({ document }) => {
    const root = document.getElementById('root');
    let failReads = true;

    const mockApi = async (route) => {
      if (route === '/api/files') {
        if (failReads) throw Object.assign(new Error('Service unavailable (HTTP 503)'), { status: 503 });
        return { files: [{ id: 'fil_1', name: 'invoice.pdf', mimeType: 'application/pdf', sizeBytes: 1024, updatedAt: new Date().toISOString(), writtenBy: 'Owner', hasText: true }] };
      }
      if (route === '/api/policies') {
        if (failReads) throw Object.assign(new Error('Policy service unavailable'), { status: 503 });
        return { policies: { default: 'auto', actions: { saved: 'always_ask', file: 'always_ask', schedule: 'auto' } } };
      }
      if (route.startsWith('/api/saved')) return { items: [], total: 0 };
      if (route === '/api/schedules') return { schedules: [] };
      if (route === '/api/overview') return { profileRecords: [] };
      if (route.startsWith('/api/memory')) return { memories: [] };
      return {};
    };

    await renderSaved(root, {
      esc,
      api: mockApi,
      toast: () => {},
      copyText: () => {},
      isCurrent: () => true,
      params: new URLSearchParams(),
      part: 'files',
      activeProfile: () => 'all',
      syncTopChrome: () => {},
      pageTop: ({ title }) => `<h1>${title}</h1>`,
    });

    // Files 503 shows Unavailable + Retry, NEVER "No dropped files yet."
    const filesHtml = root.querySelector('#saved-content').innerHTML;
    assert.match(filesHtml, /Files unavailable/);
    assert.match(filesHtml, /Retry/);
    assert.doesNotMatch(filesHtml, /No dropped files yet/);

    // Policies 503 shows Unavailable on rule header, NEVER "Allow".
    const ruleHtml = root.querySelector('#saved-rule-slot').innerHTML;
    assert.match(ruleHtml, /Unavailable/);
    assert.match(ruleHtml, /is-unavailable/);
    assert.doesNotMatch(ruleHtml, />Allow</);

    // Schedules 503 shows Unavailable + Retry, NEVER "No schedules yet."
    const schedErrHtml = renderSchedulesSection({ loaded: false, items: [], error: 'HTTP 503' }, esc);
    assert.match(schedErrHtml, /Schedules unavailable/);
    assert.match(schedErrHtml, /Retry/);
    assert.doesNotMatch(schedErrHtml, /No schedules yet/);

    // Clicking Retry once endpoints recover displays the real file and real Ask rule.
    failReads = false;
    root.querySelector('[data-saved-retry]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.match(root.querySelector('#saved-content').innerHTML, /invoice\.pdf/);
    assert.match(root.querySelector('#saved-rule-slot').innerHTML, />Ask</);
  });

  // Activity 503 in Agent Popup shows Unavailable + Try again (never "0 tool calls" or "Nothing yet"),
  // and Access tab shows the broad-access review path for legacy agents.
  await withDom('<div id="host"></div>', async ({ document }) => {
    const { openAgentPopup, closeAgentPopup } = await import('../public/agent-popup.js');
    const patches = [];
    const agent = {
      id: 'ag_legacy',
      name: 'Legacy Agent',
      kind: 'cursor',
      profile: 'all',
      canManage: true,
      allowedConnections: null,
      allowedSkills: null,
      memoryAccess: 'read_write',
      secrets: [],
      enabled: true,
      hasToken: true,
    };

    const popupApi = async (route, opts = {}) => {
      if (route === '/api/agents') return { agents: [agent], connected: [], secrets: [], profileRecords: [] };
      if (route.startsWith('/api/activity')) throw Object.assign(new Error('Activity backend 503'), { status: 503 });
      if (route === `/api/agents/${agent.id}` && opts.method === 'PATCH') {
        const body = JSON.parse(opts.body);
        patches.push(body);
        Object.assign(agent, body);
        return { agent };
      }
      return {};
    };

    await openAgentPopup({ esc, api: popupApi, toast: () => {}, copyText: () => {} }, agent.id, 'activity');
    const actText = document.body.innerHTML;
    assert.match(actText, /Activity is unavailable/);
    assert.match(actText, /Try again/);
    assert.doesNotMatch(actText, /0 tool calls/);
    assert.doesNotMatch(actText, /Nothing yet/);

    // Switch to Access tab and verify the visible review path for existing broad grants.
    document.querySelector('[data-ap-tab="access"]').click();
    const accessHtml = document.body.innerHTML;
    assert.match(accessHtml, /Review broad access/);
    assert.match(accessHtml, /Limit to Memory only/);

    // Clicking "Limit to Memory only" tightens the agent to explicit empty allowlists + canManage: false.
    document.querySelector('[data-ap-memory-only]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(patches[0], { canManage: false, allowedConnections: [], allowedSkills: [] });
    closeAgentPopup({ immediate: true, quiet: true });
  });
});
