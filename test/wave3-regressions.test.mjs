// Wave 3 regression tests verifying stored state and owner UI across:
// 1. ADR-0001 open-project ordering, project badges, Run now / Delete confirmations, and project creation setup.
// 2. Task handoff assignee validation, read-only warnings, operationId create deduplication, title update lookup, and Tasks UI.
// 3. Project invite refresh persistence, accurate join title, 404 revocation exit, owner Revoke, guest Leave, and local handoff notice.
// 4. Connection saved-vs-connected toast, Saved paging & empty search, schedule interval validation, lexical math search,
//    iMessage trace reply parity, skill cache invalidation, backup copy, password form draft retention, and cross-tab sign-out.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';

import { startServer } from '../server.mjs';
import { closeAllWorkspaceDbs } from '../lib/storage/workspace-db.mjs';
import { ShareStore, handleShareApi } from '../lib/shares.mjs';
import { LoopStore } from '../lib/store.mjs';
import { ActivityLog } from '../lib/activity.mjs';
import { Vault } from '../lib/vault.mjs';
import { tokenizeQuery } from '../lib/search-index.mjs';
import {
  renderSaved,
  renderSavedList,
  renderFilesSection,
  renderSchedulesSection,
  renderTasksSection,
} from '../public/saved-view.js';
import { traceTimeline, traceSummary } from '../public/agents-view.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[c]));

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-wave3-'));
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
    FormData: globalThis.FormData,
    Event: globalThis.Event,
    CustomEvent: globalThis.CustomEvent,
    CSS: globalThis.CSS,
    matchMedia: globalThis.matchMedia,
    MutationObserver: globalThis.MutationObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    setTimeout: globalThis.setTimeout,
  };
  let activeEl = document.body;
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => activeEl });
  window.HTMLElement.prototype.focus = function focusPatched() { activeEl = this; };
  if (typeof window.HTMLElement.prototype.getBoundingClientRect !== 'function') {
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 });
  }
  const origSetTimeout = globalThis.setTimeout;
  const timers = new Set();
  globalThis.setTimeout = (cb, ms, ...args) => {
    const id = origSetTimeout(() => { timers.delete(id); cb(...args); }, ms);
    timers.add(id);
    return id;
  };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = { origin: 'http://127.0.0.1:8799', pathname: '/', search: '', hash: '#knowledge/files' };
  globalThis.history = { replaceState() {} };
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLDialogElement = window.HTMLDialogElement || class HTMLDialogElement { showModal() {} show() {} close() {} };
  globalThis.FormData = class SimpleFormData {
    constructor(form) {
      this._map = new Map();
      if (form && typeof form.querySelectorAll === 'function') {
        for (const el of form.querySelectorAll('input[name], select[name], textarea[name]')) {
          this._map.set(el.getAttribute('name'), el.value ?? '');
        }
      }
    }
    get(k) { return this._map.has(k) ? this._map.get(k) : null; }
  };
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.CSS = { escape: (s) => String(s).replace(/([^\w-])/g, '\\$1') };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.MutationObserver = class MutationObserver { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
  try {
    return await fn({ window, document });
  } finally {
    for (const id of timers) clearTimeout(id);
    timers.clear();
    for (const [k, v] of Object.entries(savedGlobals)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
}

async function setupServer(dir, extraOpts = {}) {
  const srv = await startServer({ port: 0, dataDir: dir, legacy: true, seedBuiltins: false, ...extraOpts });
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
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };

  const mcp = async (token, method, params = {}) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await res.json()).result;
  };

  return { srv, base, cookie, api, mcp };
}

/* ---------------- Wave 3.1: Project labels, ADR-0001 sorting, confirmations, and setup (Findings 7 & 16) ---------------- */

test('Wave 3.1: Files and Schedules follow ADR-0001 open-project sorting, show project badges and confirmations, and enforce agent limits', async () => {
  await withTempDir(async (dir) => {
    const { srv, base, api } = await setupServer(dir);
    try {
      const raven = (await api('/api/profiles', { method: 'POST', body: JSON.stringify({ name: 'Raven' }) })).json.profile;
      const finch = (await api('/api/profiles', { method: 'POST', body: JSON.stringify({ name: 'Finch' }) })).json.profile;

      const ravenFile = (await api('/api/files', {
        method: 'POST',
        body: JSON.stringify({ name: 'raven-brief.txt', contentBase64: Buffer.from('Raven only').toString('base64'), project: raven.id }),
      })).json.file;
      const finchFile = (await api('/api/files', {
        method: 'POST',
        body: JSON.stringify({ name: 'finch-brief.txt', contentBase64: Buffer.from('Finch only').toString('base64'), project: finch.id }),
      })).json.file;

      const ravenSched = (await api('/api/schedules', {
        method: 'POST',
        body: JSON.stringify({ title: 'Raven standup', kind: 'daily', timeOfDay: '09:00', action: 'notify', project: raven.id }),
      })).json.schedule;
      const finchSched = (await api('/api/schedules', {
        method: 'POST',
        body: JSON.stringify({ title: 'Finch check-in', kind: 'daily', timeOfDay: '10:00', action: 'notify', project: finch.id }),
      })).json.schedule;

      // Owner looking at Finch sees BOTH items, with Finch items sorted FIRST.
      const filesForFinch = (await api(`/api/files?profile=${encodeURIComponent(finch.id)}`)).json.files;
      assert.equal(filesForFinch.length, 2);
      assert.equal(filesForFinch[0].id, finchFile.id);
      assert.equal(filesForFinch[1].id, ravenFile.id);

      const schedsForFinch = (await api(`/api/schedules?profile=${encodeURIComponent(finch.id)}`)).json.schedules;
      assert.equal(schedsForFinch.length, 2);
      assert.equal(schedsForFinch[0].id, finchSched.id);
      assert.equal(schedsForFinch[1].id, ravenSched.id);

      // Existing scoped-agent access limit stays enforced (Raven agent sees only Raven file).
      const ravenAgent = (await api('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Raven Helper', kind: 'cursor', profile: raven.id, memoryAccess: 'read' }),
      })).json;
      const agentFilesRes = await fetch(`${base}/api/files`, {
        headers: { Authorization: `Bearer ${ravenAgent.token}` },
      });
      assert.equal(agentFilesRes.status, 200);
      const agentFiles = (await agentFilesRes.json()).files;
      assert.deepEqual(agentFiles.map((f) => f.id), [ravenFile.id]);

      // UI renders project badges beside every file and schedule name.
      const profiles = [raven, finch];
      const filesHtml = renderFilesSection({ loaded: true, items: filesForFinch, error: '' }, esc, { profiles, activeProject: finch.id });
      assert.match(filesHtml, /finch-brief\.txt[\s\S]*data-item-project="Finch"/);
      assert.match(filesHtml, /raven-brief\.txt[\s\S]*data-item-project="Raven"/);

      const schedsHtml = renderSchedulesSection({ loaded: true, items: schedsForFinch, error: '' }, esc, { profiles, activeProject: finch.id });
      assert.match(schedsHtml, /Finch check-in[\s\S]*data-item-project="Finch"/);
      assert.match(schedsHtml, /Raven standup[\s\S]*data-item-project="Raven"/);

      // Run now and Delete confirmations explicitly display "Project: Raven" when acting on a Raven item from Finch.
      await withDom('<div id="root"></div>', async ({ document }) => {
        const root = document.getElementById('root');
        const dialogs = [];
        const deleteCalls = [];
        const runCalls = [];
        const stubApi = async (route, opts = {}) => {
          if (route.startsWith('/api/saved')) return { items: [], total: 0 };
          if (route.startsWith('/api/files') && opts.method === 'DELETE') { deleteCalls.push(route); return { ok: true }; }
          if (route.startsWith('/api/files')) return { files: filesForFinch, total: filesForFinch.length };
          if (route.endsWith('/run') && opts.method === 'POST') { runCalls.push(route); return { ok: true, run: { status: 'ok' } }; }
          if (route.startsWith('/api/schedules') && opts.method === 'DELETE') { deleteCalls.push(route); return { ok: true }; }
          if (route.startsWith('/api/schedules')) return { schedules: schedsForFinch, total: schedsForFinch.length };
          if (route.startsWith('/api/tasks')) return { tasks: [], total: 0 };
          if (route === '/api/overview') return { profileRecords: profiles };
          if (route === '/api/policies') return { policies: { default: 'auto', actions: {} } };
          return {};
        };

        await renderSaved(root, {
          esc,
          api: stubApi,
          toast() {},
          copyText() {},
          confirmDialog: async (cfg) => { dialogs.push(cfg); return false; }, // cancel
          isCurrent: () => true,
          params: new URLSearchParams(),
          part: 'schedules',
          activeProfile: () => finch.id,
          pageTop: ({ title }) => `<h1>${title}</h1>`,
        });

        root.querySelector(`[data-sched-run="${ravenSched.id}"]`).click();
        await new Promise((r) => setTimeout(r, 10));
        root.querySelector(`[data-sched-del="${ravenSched.id}"]`).click();
        await new Promise((r) => setTimeout(r, 10));

        assert.equal(dialogs.length, 2);
        assert.match(dialogs[0].message, /Project: Raven/);
        assert.match(dialogs[0].confirmLabel, /Raven/);
        assert.match(dialogs[1].message, /Project: Raven/);
        assert.match(dialogs[1].confirmLabel, /Raven/);
        assert.equal(runCalls.length, 0);
        assert.equal(deleteCalls.length, 0);
      });

      // Saved search uses AND matching so a hyphenated non-matching query never false-matches "note" on "no*".
      await api('/api/saved', { method: 'POST', body: JSON.stringify({ title: 'Primary note', text: 'Primary saved note body' }) });
      const missSearch = (await api('/api/saved?query=zzzz-no-such-item-qa')).json;
      assert.equal(missSearch.items.length, 0);
      const hitSearch = (await api('/api/saved?query=primary+note')).json;
      assert.equal(hitSearch.items.length, 1);
    } finally {
      await srv.close();
    }
  });
});

/* ---------------- Wave 3.2: Task handoffs, deduplication, lookup parity, and Tasks UI (Findings 9 & 10) ---------------- */

test('Wave 3.2: Tasks reject nonexistent/blind assignees, warn on read-only assignees, deduplicate operationId creates, and support title updates', async () => {
  await withTempDir(async (dir) => {
    const dispatches = [];
    const { srv, api, mcp } = await setupServer(dir, {
      onTaskDispatch: async (task) => {
        dispatches.push(task.id);
        return { dispatched: false };
      },
    });
    try {
      const writer = (await api('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Builder Bot', kind: 'codex', memoryAccess: 'read_write' }),
      })).json;
      const reader = (await api('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'ReadOnly Bot', kind: 'cursor', memoryAccess: 'read' }),
      })).json;
      await api('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'NoMem Bot', kind: 'other', memoryAccess: 'none' }),
      });

      // 1. Nonexistent assignee is rejected.
      const badAssignee = await mcp(writer.token, 'tools/call', {
        name: 'loop__save',
        arguments: {
          type: 'task',
          data: { expectedRevision: 0, title: 'Ghost task', assignedTo: 'Nonexistent Agent' },
        },
      });
      assert.equal(badAssignee.isError, true);
      assert.match(badAssignee.content[0].text, /No enabled agent matches assignedTo/);

      // 2. Blind assignee (memoryAccess: none) is rejected.
      const blindAssignee = await mcp(writer.token, 'tools/call', {
        name: 'loop__save',
        arguments: {
          type: 'task',
          data: { expectedRevision: 0, title: 'Blind task', assignedTo: 'NoMem Bot' },
        },
      });
      assert.equal(blindAssignee.isError, true);
      assert.match(blindAssignee.content[0].text, /Memory access is set to "None"/);

      // 3. Read-only assignee warns explicitly that it cannot mark the task complete.
      const roCreate = await mcp(writer.token, 'tools/call', {
        name: 'loop__save',
        arguments: {
          type: 'task',
          data: { expectedRevision: 0, title: 'Review draft', assignedTo: 'ReadOnly Bot', operationId: 'op-ro-1' },
        },
      });
      assert.notEqual(roCreate.isError, true);
      const roBody = JSON.parse(roCreate.content[0].text);
      assert.equal(roBody.created, true);
      assert.equal(roBody.assigneeCapability.canComplete, false);
      assert.ok(Array.isArray(roBody.warnings) && roBody.warnings.some((w) => /read-only/i.test(w)));
      assert.equal(dispatches.length, 1);

      // 4. Retry create with same operationId (without id) returns the SAME task and fires zero extra dispatches!
      const roRetry = await mcp(writer.token, 'tools/call', {
        name: 'loop__save',
        arguments: {
          type: 'task',
          data: { expectedRevision: 0, title: 'Review draft', assignedTo: 'ReadOnly Bot', operationId: 'op-ro-1' },
        },
      });
      assert.notEqual(roRetry.isError, true);
      const retryBody = JSON.parse(roRetry.content[0].text);
      assert.equal(retryBody.created, false);
      assert.equal(retryBody.deduplicated, true);
      assert.equal(retryBody.task.id, roBody.task.id);
      assert.equal(dispatches.length, 1, 'Retry must not trigger duplicate dispatch');

      // 5. Update task by TITLE (matching inspect/delete lookup behavior).
      const updByTitle = await mcp(writer.token, 'tools/call', {
        name: 'loop__save',
        arguments: {
          type: 'task',
          id: 'Review draft',
          data: { expectedRevision: 1, status: 'completed', result: 'Done via title lookup' },
        },
      });
      assert.notEqual(updByTitle.isError, true);
      const updBody = JSON.parse(updByTitle.content[0].text);
      assert.equal(updBody.task.id, roBody.task.id);
      assert.equal(updBody.task.status, 'completed');

      // 6. Read-only agent cannot complete tasks and error names Tasks.
      const roFail = await mcp(reader.token, 'tools/call', {
        name: 'loop__save',
        arguments: {
          type: 'task',
          id: roBody.task.id,
          data: { expectedRevision: 2, status: 'completed' },
        },
      });
      assert.equal(roFail.isError, true);
      assert.match(roFail.content[0].text, /Tasks/);

      // 7. Owner /api/tasks and renderTasksSection expose the task with project badge.
      const tasksApi = (await api('/api/tasks')).json;
      assert.equal(tasksApi.total, 1);
      const tasksHtml = renderTasksSection({ loaded: true, items: tasksApi.tasks, error: '' }, esc);
      assert.match(tasksHtml, /Review draft/);
      assert.match(tasksHtml, /ReadOnly Bot/);
      assert.match(tasksHtml, /data-item-project="All"/);
    } finally {
      await srv.close();
    }
  });
});

/* ---------------- Wave 3.3: Project invites, refresh persistence, revocation, guest Leave (Findings 12, 13, 14, 19) ---------------- */

test('Wave 3.3: Share invites support guest Leave, owner Revoke, refresh draft persistence, honest join title, and 404 revoke detection', async () => {
  await withDom('<div id="host"></div>', async () => {
    const {
      readJoinDraft,
      writeJoinDraft,
      clearJoinDraft,
      pickAgentTitle,
      pollStatusAction,
    } = await import('../public/join.js');
    await withTempDir(async (dir) => {
    const ownerDir = path.join(dir, 'owner');
    const guestDir = path.join(dir, 'guest');
    const shares = new ShareStore(path.join(dir, 'shares'));
    const ownerId = 'a'.repeat(64);
    const guestId = 'b'.repeat(64);

    const ownerStore = new LoopStore(ownerDir);
    await ownerStore.createProfile({ name: 'Raven' });
    const ownerWs = {
      id: ownerId,
      shareContext: {
        store: ownerStore,
        vault: new Vault(ownerDir),
        activity: new ActivityLog(ownerDir),
      },
    };
    const guestWs = {
      id: guestId,
      shareContext: {
        store: new LoopStore(guestDir),
        vault: new Vault(guestDir),
        activity: new ActivityLog(guestDir),
      },
    };
    const workspaces = {
      personal: (id) => (id === ownerId ? ownerWs : id === guestId ? guestWs : null),
    };
    const callShare = async (ws, method, pathname, body = null) => {
      let status = 200;
      let payload = null;
      await handleShareApi({
        req: { method },
        res: {},
        pathname,
        method,
        workspace: ws,
        workspaces,
        shares,
        router: null,
        origin: 'https://useloop.sh',
        readJsonBody: async () => body,
        sendJson: (_res, s, p) => { status = s; payload = p; },
      });
      return { status, json: payload };
    };

    // Owner creates share link for Raven.
    const created = await callShare(ownerWs, 'POST', '/api/shares', { profile: 'raven', kind: 'other', ownerName: 'Alex' });
    assert.equal(created.status, 200);
    const code = created.json.code;

    // Before guest mints an agent, preview reports joined: false and pickAgentTitle says "Join Raven" (not "You're in").
    const preview = await callShare(guestWs, 'GET', `/api/join/${code}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.json.joined, false);
    assert.equal(pickAgentTitle(preview.json), 'Join Raven');

    // Guest joins & mints a Cursor key.
    const minted = await callShare(guestWs, 'POST', `/api/join/${code}/agents`, { kind: 'cursor', name: 'Sam', email: 'sam@example.com' });
    assert.equal(minted.status, 201);
    assert.equal(pickAgentTitle({ ...preview.json, joined: true }), 'You’re in Raven');

    // Guest sees shared project via /api/shares/with-me (with id) and can Leave via DELETE /api/shares/with-me/:id.
    const withMe = await callShare(guestWs, 'GET', '/api/shares/with-me');
    assert.equal(withMe.status, 200);
    assert.equal(withMe.json.shared.length, 1);
    assert.ok(withMe.json.shared[0].id);

    const left = await callShare(guestWs, 'DELETE', `/api/shares/with-me/${withMe.json.shared[0].id}`);
    assert.equal(left.status, 200);
    assert.equal(left.json.left, true);
    assert.equal(left.json.agentsRevoked, 1);
    assert.equal((await ownerStore.getAgent(minted.json.agentId)), null, 'Guest agent must be removed on Leave');
    assert.equal((await callShare(guestWs, 'GET', '/api/shares/with-me')).json.shared.length, 0);

    // Owner revokes link -> /api/join/:code returns 404 and pollStatusAction stops waiting.
    const revoked = await callShare(ownerWs, 'DELETE', `/api/shares/${code}`);
    assert.equal(revoked.status, 200);
    const afterRevoke = await callShare(guestWs, 'GET', `/api/join/${code}`);
    assert.equal(afterRevoke.status, 404);
    assert.equal(pollStatusAction({ status: 404 }), 'revoked');
    assert.equal(pollStatusAction({ status: 503 }), 'retry');

    // Refresh persistence helpers keep chosen agent kind & minted credential without issuing a duplicate.
    const memStore = new Map();
    const fakeStorage = {
      getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
      setItem: (k, v) => memStore.set(k, v),
      removeItem: (k) => memStore.delete(k),
    };
    writeJoinDraft(code, { kind: 'cursor', minted: { agentId: 'ag_1', token: 'tok_1', mcpUrl: 'https://useloop.sh/mcp' } }, fakeStorage);
    const restored = readJoinDraft(code, fakeStorage);
    assert.equal(restored.kind, 'cursor');
    assert.equal(restored.minted.agentId, 'ag_1');
    clearJoinDraft(code, fakeStorage);
    assert.equal(readJoinDraft(code, fakeStorage).minted, null);
    });
  });
});

/* ---------------- Wave 3.4: Daily-use UI accuracy, lexical math search, and trace parity (Findings 11, 17, 18, 20-23, 25) ---------------- */

test('Wave 3.4: Connection save copy, Saved paging & empty search, interval validation, math search, trace parity, and settings hygiene', async () => {
  // Finding 11: connectionSaveToast distinguishes ready vs failed/unverified connections.
  await withDom('<div id="host"></div>', async () => {
    const { connectionSaveToast } = await import('../public/connection-popup.js');
    const failed = connectionSaveToast({ name: 'Down API', status: 'error', lastError: 'ECONNREFUSED' });
    assert.equal(failed.tone, 'err');
    assert.match(failed.message, /saved, but connection check failed/i);
    assert.doesNotMatch(failed.message, /Down API connected/i);

    const unverified = connectionSaveToast({ name: 'Pending API', status: 'unknown' });
    assert.match(unverified.message, /saved/i);
    assert.doesNotMatch(unverified.message, /connected\./i);

    const ready = connectionSaveToast({ name: 'Live API', status: 'ready' });
    assert.equal(ready.tone, 'ok');
    assert.match(ready.message, /connected\./i);
  });

  // Finding 17: Saved empty search copy and pagination button past 60 items.
  const emptySearchHtml = renderSavedList(
    { loaded: true, items: [], error: '' },
    [],
    '',
    esc,
    { query: 'unicorn', filter: 'all', total: 0 },
  );
  assert.match(emptySearchHtml, /No saved items match/);
  assert.doesNotMatch(emptySearchHtml, /Nothing saved here yet/);
  assert.match(emptySearchHtml, /data-saved-clear-search/);

  const pageItems = Array.from({ length: 60 }, (_, i) => ({
    id: `sav_${i}`,
    kind: 'note',
    displayTitle: `Note ${i}`,
    updatedAt: new Date().toISOString(),
    projects: ['all'],
  }));
  const pagedHtml = renderSavedList(
    { loaded: true, items: pageItems, error: '' },
    pageItems,
    '',
    esc,
    { query: '', filter: 'all', total: 75 },
  );
  assert.match(pagedHtml, /Showing 60 of 75/);
  assert.match(pagedHtml, /data-saved-more/);

  // Finding 18: Invalid schedule interval ("banana") is rejected client-side without creating a 60-minute schedule.
  await withDom('<div id="root"></div>', async ({ document }) => {
    const root = document.getElementById('root');
    const toasts = [];
    const postCalls = [];
    await renderSaved(root, {
      esc,
      api: async (route, opts = {}) => {
        if (route === '/api/schedules' && opts.method === 'POST') { postCalls.push(opts.body); return { ok: true }; }
        if (route.startsWith('/api/saved')) return { items: [], total: 0 };
        if (route.startsWith('/api/files')) return { files: [], total: 0 };
        if (route.startsWith('/api/schedules')) return { schedules: [], total: 0 };
        if (route.startsWith('/api/tasks')) return { tasks: [], total: 0 };
        if (route === '/api/overview') return { profileRecords: [] };
        if (route === '/api/policies') return { policies: { default: 'auto', actions: {} } };
        return {};
      },
      toast: (msg, tone) => toasts.push({ msg, tone }),
      copyText() {},
      isCurrent: () => true,
      params: new URLSearchParams(),
      part: 'schedules',
      activeProfile: () => 'all',
      pageTop: ({ title }) => `<h1>${title}</h1>`,
    });

    const form = root.querySelector('#saved-schedule-form');
    form.querySelector('input[name="title"]').value = 'Bad interval test';
    form.querySelectorAll('select[name="kind"] option').forEach((opt) => {
      if (opt.getAttribute('value') === 'interval') opt.setAttribute('selected', '');
      else opt.removeAttribute('selected');
    });
    form.querySelector('input[name="value"]').value = 'banana';
    form.dispatchEvent(new globalThis.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(postCalls.length, 0, 'Invalid interval must never submit 60 minutes');
    assert.ok(toasts.some((t) => t.tone === 'err' && /between 5 and 43200/.test(t.msg)));
  });

  // Finding 23: Lexical query tokenization expands arithmetic expressions without misclassifying ISO dates.
  const mathToks = tokenizeQuery('what is 12 * 34');
  assert.ok(mathToks.includes('calculate'));
  assert.ok(mathToks.includes('calculator'));
  assert.ok(mathToks.includes('multiply'));

  const dateToks = tokenizeQuery('2026-11-25 release notes');
  assert.ok(!dateToks.includes('calculator'), 'ISO dates must not trigger math expansion');

  // Finding 25: iMessage trace timeline and summary agree in both directions.
  const stepReplyOnly = {
    steps: [{ kind: 'model', text: 'Your flight is on time.' }],
    finalText: '',
  };
  const itemsA = traceTimeline(stepReplyOnly);
  assert.equal(traceSummary(stepReplyOnly, itemsA), 'Your flight is on time.');

  const finalTextOnly = {
    steps: [{ kind: 'model', toolCalls: [{ id: 'tc1', name: 'loop__search', arguments: {} }] }],
    finalText: 'Found 3 matching notes.',
  };
  const itemsB = traceTimeline(finalTextOnly);
  assert.ok(itemsB.some((it) => it.kind === 'reply' && it.detail === 'Found 3 matching notes.'));
  assert.equal(traceSummary(finalTextOnly, itemsB), 'Found 3 matching notes.');

  // Static contract checks for Findings 16, 19, 20, 21, 22, and Command Palette Tasks entry.
  const [appSrc, paletteSrc, addAgentSrc, shareSrc] = await Promise.all([
    readFile(path.resolve('public/app.js'), 'utf8'),
    readFile(path.resolve('public/components/command-palette.js'), 'utf8'),
    readFile(path.resolve('public/add-agent.js'), 'utf8'),
    readFile(path.resolve('public/share.js'), 'utf8'),
  ]);
  assert.doesNotMatch(appSrc, /'Delete profile'/);
  assert.match(appSrc, /'Delete project'/);
  assert.match(appSrc, /Settings and connections only \(excludes Vault secrets/);
  assert.match(appSrc, /SIGN_OUT_STORAGE_KEY/);
  assert.match(appSrc, /if \(sharedHost && appMode\)/);
  assert.match(appSrc, /data-share-leave/);
  assert.doesNotMatch(appSrc, /confirmText:/);
  assert.doesNotMatch(shareSrc, /confirmText:/);
  assert.match(paletteSrc, /#knowledge\/tasks/);
  assert.match(addAgentSrc, /localOnlyNoticeHtml/);
  assert.match(shareSrc, /data-share-revoke/);
});
