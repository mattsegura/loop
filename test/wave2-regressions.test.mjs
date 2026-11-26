// Wave 2 regression tests verifying stored state, Activity receipts, and UI rendering for:
// 1. Approved bulk deletions validate all targets before approval and before mutation, show titles, and never partially delete in silence.
// 2. Failed one-time schedules (e.g. at the 100-task limit) report ok:false, status:'failed', Activity failure, and Retry (never Completed).
// 3. Restricted-agent read denials log to Activity, Inspector traces preserve agent/profile identity, and simulated sessions do not inflate live presence.
// 4. Open Activity panels catch up live, render readable labels, and paginate cleanly past 60 rows to an explicit end.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';

import { startServer } from '../server.mjs';
import { closeAllWorkspaceDbs } from '../lib/storage/workspace-db.mjs';
import { TaskStore, MAX_TASKS_PER_PROFILE } from '../lib/tasks.mjs';
import { renderSchedulesSection } from '../public/saved-view.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[c]));

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-wave2-'));
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
    for (const id of timers) clearTimeout(id);
    timers.clear();
    for (const [k, v] of Object.entries(savedGlobals)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
}

async function setupServer(dir) {
  const srv = await startServer({ port: 0, dataDir: dir, legacy: true, seedBuiltins: false });
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

/* ---------------- Wave 2.1: Atomic validated bulk delete & titled approvals (Finding 5) ---------------- */

test('Wave 2.1: Bulk delete rejects stale IDs without partial deletion, logs failures, and shows item titles in approvals', async () => {
  await withTempDir(async (dir) => {
    const { srv, api, mcp } = await setupServer(dir);
    try {
      const agRes = await api('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Cleanup Agent', kind: 'cursor', memoryAccess: 'read_write', canManage: false }),
      });
      const { agent, token } = agRes.json;

      // Require owner approval for Saved, Files, and Schedules actions.
      await api('/api/policies', {
        method: 'PATCH',
        body: JSON.stringify({ actions: { saved: 'always_ask', file: 'always_ask', schedule: 'always_ask' } }),
      });

      const savedA = (await api('/api/saved', { method: 'POST', body: JSON.stringify({ title: 'Keep Me Safe', text: 'Important note' }) })).json.item;
      const savedB = (await api('/api/saved', { method: 'POST', body: JSON.stringify({ title: 'Disappears Mid-Approval', text: 'Second note' }) })).json.item;
      const fileA = (await api('/api/files', { method: 'POST', body: JSON.stringify({ name: 'quarterly.txt', contentBase64: Buffer.from('Q4 numbers').toString('base64') }) })).json.file;
      const schedA = (await api('/api/schedules', { method: 'POST', body: JSON.stringify({ title: 'Morning Standup', kind: 'daily', timeOfDay: '09:00', action: 'notify' }) })).json.schedule;

      // 1. Pre-approval check: requesting deletion of [validId, staleId] fails BEFORE approval and keeps valid items intact across all 3 types.
      for (const [type, validId, staleId] of [
        ['saved', savedA.id, 'sav_missing'],
        ['file', fileA.id, 'fil_missing'],
        ['schedule', schedA.id, 'sch_missing'],
      ]) {
        const res = await mcp(token, 'tools/call', {
          name: 'loop__save',
          arguments: { type, action: 'delete', ids: [validId, staleId], waitMs: 0 },
        });
        assert.equal(res.isError, true, `${type} stale batch must fail`);
        const body = JSON.parse(res.content[0].text);
        assert.equal(body.deleted, false);
        assert.deepEqual(body.missingIds, [staleId]);
      }

      // Confirm ZERO items were silently deleted.
      assert.equal((await api('/api/saved')).json.items.length, 2);
      assert.equal((await api('/api/files')).json.files.length, 1);
      assert.equal((await api('/api/schedules')).json.schedules.length, 1);

      // 2. Post-approval staleness race: approve batch [savedA, savedB], delete savedB before retry -> savedA MUST survive!
      const reqBatch = await mcp(token, 'tools/call', {
        name: 'loop__save',
        arguments: { type: 'saved', action: 'delete', ids: [savedA.id, savedB.id], waitMs: 0 },
      });
      const reqBody = JSON.parse(reqBatch.content[0].text);
      assert.equal(reqBody.status, 'approval_required');
      const pending = (await api('/api/approvals')).json.pending.find((a) => a.id === reqBody.approvalId);
      assert.match(pending.title, /Keep Me Safe/);
      assert.match(pending.title, /Disappears Mid-Approval/);

      // Owner approves, then savedB is removed externally before agent retries with approvalId.
      assert.equal((await api(`/api/approvals/${reqBody.approvalId}/approve`, { method: 'POST', body: '{}' })).status, 200);
      assert.equal((await api(`/api/saved/${savedB.id}`, { method: 'DELETE' })).status, 200);

      const retryStale = await mcp(token, 'tools/call', {
        name: 'loop__save',
        arguments: { type: 'saved', action: 'delete', ids: [savedA.id, savedB.id], approvalId: reqBody.approvalId, waitMs: 0 },
      });
      assert.equal(retryStale.isError, true);
      const retryBody = JSON.parse(retryStale.content[0].text);
      assert.equal(retryBody.deleted, false);
      assert.deepEqual(retryBody.missingIds, [savedB.id]);

      // savedA is STILL intact!
      const remainingSaved = (await api('/api/saved')).json.items;
      assert.equal(remainingSaved.length, 1);
      assert.equal(remainingSaved[0].id, savedA.id);

      // Activity logged the failed attempts (not silent!).
      const actEntries = (await api(`/api/activity?agent=${agent.id}&limit=50`)).json.entries;
      assert.ok(actEntries.some((e) => e.method === 'saved/delete' && e.ok === false));

      // 3. Valid single-item delete approval shows recognizable title and logs readable success.
      const reqFile = await mcp(token, 'tools/call', {
        name: 'loop__save',
        arguments: { type: 'file', action: 'delete', id: fileA.id, waitMs: 0 },
      });
      const reqFileBody = JSON.parse(reqFile.content[0].text);
      const pendingFile = (await api('/api/approvals')).json.pending.find((a) => a.id === reqFileBody.approvalId);
      assert.match(pendingFile.title, /quarterly\.txt/);
      await api(`/api/approvals/${reqFileBody.approvalId}/approve`, { method: 'POST', body: '{}' });
      const delFile = await mcp(token, 'tools/call', {
        name: 'loop__save',
        arguments: { type: 'file', action: 'delete', id: fileA.id, approvalId: reqFileBody.approvalId, waitMs: 0 },
      });
      assert.notEqual(delFile.isError, true);
      assert.equal((await api('/api/files')).json.files.length, 0);
      const actAfter = (await api(`/api/activity?agent=${agent.id}&limit=50`)).json.entries;
      assert.ok(actAfter.some((e) => e.method === 'file/delete' && e.ok === true && /quarterly\.txt/.test(e.target)));
    } finally {
      await srv.close();
    }
  });
});

/* ---------------- Wave 2.2: Failed one-time schedule reports failure truthfully (Finding 6) ---------------- */

test('Wave 2.2: Failed one-time schedule at 100-task limit returns ok:false, marks Failed, logs error in Activity, and succeeds on retry', async () => {
  await withTempDir(async (dir) => {
    const { srv, api, mcp } = await setupServer(dir);
    try {
      // Fill workspace to the 100-task limit.
      const taskStore = new TaskStore(dir);
      const createdIds = [];
      for (let i = 0; i < MAX_TASKS_PER_PROFILE; i += 1) {
        const res = await taskStore.save({ expectedRevision: 0, title: `Task ${i + 1}` }, { profile: 'all', writtenBy: 'Seed' });
        createdIds.push(res.task.id);
      }

      const agRes = await api('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Scheduler Agent', kind: 'cursor', memoryAccess: 'read_write' }),
      });
      const { agent, token } = agRes.json;

      const sched = (await api('/api/schedules', {
        method: 'POST',
        body: JSON.stringify({
          title: 'Create 101st task',
          message: 'Follow up on invoice',
          kind: 'once',
          delayMinutes: 60,
          action: 'task',
        }),
      })).json.schedule;

      // 1. Run via MCP at capacity -> MUST return isError:true and ok:false!
      const runMcp = await mcp(token, 'tools/call', {
        name: 'loop__save',
        arguments: { type: 'schedule', action: 'run', id: sched.id },
      });
      assert.equal(runMcp.isError, true);
      const runBody = JSON.parse(runMcp.content[0].text);
      assert.equal(runBody.ok, false);
      assert.match(runBody.error, /100 saved tasks/);

      // Stored schedule MUST be 'failed' (NOT 'completed') with runCount: 0 and retained error.
      const afterFail = (await api(`/api/schedules/${sched.id}`)).json.schedule;
      assert.equal(afterFail.status, 'failed');
      assert.equal(afterFail.lastStatus, 'error');
      assert.match(afterFail.lastError, /100 saved tasks/);
      assert.equal(afterFail.runCount, 0);

      // Activity MUST record ok:false with the error!
      const actFail = (await api(`/api/activity?agent=${agent.id}&limit=20`)).json.entries;
      assert.ok(actFail.some((e) => e.method === 'schedule/run' && e.ok === false && /100 saved tasks/.test(e.error || '')));

      // Owner schedule card MUST render Failed + exact error + Retry (NEVER Completed!).
      const failCardHtml = renderSchedulesSection({ loaded: true, items: [afterFail], error: '' }, esc);
      assert.match(failCardHtml, /Failed/);
      assert.match(failCardHtml, /100 saved tasks/);
      assert.match(failCardHtml, />Retry</);
      assert.doesNotMatch(failCardHtml, /Completed/);

      // 2. HTTP /api/schedules/:id/run also reports 409 + ok:false on capacity error.
      const httpFail = await api(`/api/schedules/${sched.id}/run`, { method: 'POST', body: '{}' });
      assert.equal(httpFail.status, 409);
      assert.equal(httpFail.json.ok, false);

      // 3. Free one task slot and retry -> succeeds, links created taskId, and transitions to completed!
      await taskStore.forget(createdIds[0], { profile: 'all' });
      const httpRetry = await api(`/api/schedules/${sched.id}/run`, { method: 'POST', body: '{}' });
      assert.equal(httpRetry.status, 200);
      assert.equal(httpRetry.json.ok, true);
      assert.match(httpRetry.json.run.taskId, /^task_/);

      const afterSuccess = (await api(`/api/schedules/${sched.id}`)).json.schedule;
      assert.equal(afterSuccess.status, 'completed');
      assert.equal(afterSuccess.lastStatus, 'ok');
      assert.equal(afterSuccess.runCount, 1);
      assert.equal(afterSuccess.lastTaskId, httpRetry.json.run.taskId);

      const okCardHtml = renderSchedulesSection({ loaded: true, items: [afterSuccess], error: '' }, esc);
      assert.match(okCardHtml, /Completed/);
      assert.match(okCardHtml, new RegExp(afterSuccess.lastTaskId));
    } finally {
      await srv.close();
    }
  });
});

/* ---------------- Wave 2.3: Read denials in Activity, Inspector trace identity, and simulated presence (Findings 8 & 24) ---------------- */

test('Wave 2.3: Restricted agent memory denial logs to Activity, Inspector traces preserve agent/profile, and simulations do not inflate presence', async () => {
  await withTempDir(async (dir) => {
    const { srv, api, mcp } = await setupServer(dir);
    try {
      const restricted = (await api('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Restricted Reader',
          kind: 'cursor',
          memoryAccess: 'none',
          canManage: false,
          allowedConnections: [],
          allowedSkills: [],
        }),
      })).json;

      // 1. Restricted agent searches memory -> denied!
      const denied = await mcp(restricted.token, 'tools/call', {
        name: 'loop__search',
        arguments: { type: 'memory', query: 'secret roadmap' },
      });
      assert.equal(denied.isError, true);

      // Activity MUST show the denied attempt for that agent (not "Nothing yet"!).
      const actPage = (await api(`/api/activity?agent=${restricted.agent.id}&limit=20`)).json;
      assert.ok(actPage.entries.some((e) => e.method === 'memory/read-denied' && e.ok === false));

      // Live Inspector trace MUST record agentId + agentName + profile + ok:false.
      const traces = (await api('/api/inspector/trace?limit=20')).json.entries;
      const liveDenied = traces.find((t) => t.source === 'mcp' && t.agentId === restricted.agent.id);
      assert.ok(liveDenied, 'Expected live trace entry for restricted agent');
      assert.equal(liveDenied.agentName, 'Restricted Reader');
      assert.equal(liveDenied.profile, 'all');
      assert.equal(liveDenied.ok, false);

      // 2. Inspector initializes and replays as the recorded restricted agent -> stays denied AND does not create real-client presence!
      const simInit = await api('/api/inspector/rpc', {
        method: 'POST',
        body: JSON.stringify({
          rpc: { jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'loop-inspector', version: '2.0.0' }, capabilities: {} } },
          agentId: restricted.agent.id,
          profile: liveDenied.profile,
        }),
      });
      assert.equal(simInit.status, 200);

      const replay = await api('/api/inspector/rpc', {
        method: 'POST',
        body: JSON.stringify({
          rpc: liveDenied.request,
          agentId: liveDenied.agentId,
          profile: liveDenied.profile,
          sessionId: simInit.json.sessionId,
        }),
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.json.response.result.isError, true);

      // Home /api/agents connected presence MUST exclude simulated Inspector sessions!
      const agentsRes = (await api('/api/agents')).json;
      const connectedForRestricted = (agentsRes.connected || []).filter((c) => c.agentId === restricted.agent.id);
      assert.deepEqual(connectedForRestricted, []);
    } finally {
      await srv.close();
    }
  });
});

/* ---------------- Wave 2.4: Open Activity live catch-up, readable labels, and pagination past 60 (Findings 26 & 27) ---------------- */

test('Wave 2.4: Open Activity panel renders readable labels, catches up live, and paginates past 60 rows to an explicit end', async () => {
  await withDom('<div id="host"></div>', async ({ document }) => {
    const { openAgentPopup, closeAgentPopup, refreshOpenAgentActivity } = await import('../public/agent-popup.js');
    const now = Date.now();
    const agent = {
      id: 'ag_act',
      name: 'Busy Agent',
      kind: 'cursor',
      profile: 'all',
      canManage: false,
      allowedConnections: [],
      allowedSkills: [],
      memoryAccess: 'read_write',
      secrets: [],
      enabled: true,
      hasToken: true,
    };

    const allEntries = [
      { at: new Date(now - 1000).toISOString(), agentId: agent.id, agentName: agent.name, method: 'memory/read-denied', target: 'roadmap', ok: false, error: 'memory_access_denied' },
      { at: new Date(now - 2000).toISOString(), agentId: agent.id, agentName: agent.name, method: 'task/save', target: 'Ship Wave 2 (task_123)', ok: true },
      { at: new Date(now - 3000).toISOString(), agentId: agent.id, agentName: agent.name, method: 'schedule/run', target: 'Create 101st task (sch_1)', ok: false, error: '100 saved tasks' },
    ];
    for (let i = 0; i < 72; i += 1) {
      allEntries.push({
        at: new Date(now - (i + 4) * 1000).toISOString(),
        agentId: agent.id,
        agentName: agent.name,
        method: 'tools/call',
        target: `loop_utils__calc_${i}`,
        ok: true,
      });
    }

    const mockApi = async (route) => {
      if (route === '/api/agents') return { agents: [agent], connected: [], secrets: [], profileRecords: [] };
      if (route.startsWith('/api/activity')) {
        const u = new URL(route, 'http://127.0.0.1');
        const limit = Number(u.searchParams.get('limit') || 100);
        const offset = Number(u.searchParams.get('offset') || 0);
        const slice = allEntries.slice(offset, offset + limit);
        return { entries: slice, total: allEntries.length, hasMore: offset + slice.length < allEntries.length };
      }
      return {};
    };

    await openAgentPopup({ esc, api: mockApi, toast: () => {}, copyText: () => {} }, agent.id, 'activity');

    // Readable labels (never raw "task/save") + blocked/failed count in Today summary.
    const initialHtml = document.querySelector('#ap-pane').innerHTML;
    assert.match(initialHtml, /Tried to read memory without permission/);
    assert.match(initialHtml, /Saved a task.*Ship Wave 2/);
    assert.match(initialHtml, /Schedule run failed.*100 saved tasks/);
    assert.doesNotMatch(initialHtml, />task\/save/);
    assert.match(initialHtml, /2 blocked or failed/);
    assert.equal(document.querySelectorAll('.ap-ev').length, 9);

    // Click "Show older" once -> advances from 9 to 59 rows.
    document.querySelector('[data-ap-older]').click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(document.querySelectorAll('.ap-ev').length, 59);
    assert.ok(document.querySelector('[data-ap-older]'));

    // Click "Show older" again -> advances PAST 60 to all 75 rows, removes button, shows explicit end!
    document.querySelector('[data-ap-older]').click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(document.querySelectorAll('.ap-ev').length, 75);
    assert.equal(document.querySelector('[data-ap-older]'), null);
    assert.match(document.querySelector('#ap-pane').innerHTML, /Showing all 75 recorded events/);

    // Live catch-up while panel stays open: push a new event and trigger SSE refreshOpenAgentActivity().
    allEntries.unshift({
      at: new Date(now + 5000).toISOString(),
      agentId: agent.id,
      agentName: agent.name,
      method: 'tools/call',
      target: 'loop_utils__date_math',
      ok: true,
    });
    const refreshed = await refreshOpenAgentActivity();
    assert.equal(refreshed, true);
    assert.equal(document.querySelectorAll('.ap-ev').length, 76);
    assert.match(document.querySelector('#ap-pane').innerHTML, /loop_utils · date_math/);

    closeAgentPopup({ immediate: true, quiet: true });
  });
});
