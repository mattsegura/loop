import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';

import { startServer } from '../server.mjs';
import { AppSignIns, callKeyOf } from '../lib/app-sign-ins.mjs';
import { ActivityLog } from '../lib/activity.mjs';
import { buildSafeToolMap, handleMcpRequest } from '../lib/mcp-server.mjs';
import {
  listNamedActionsForConnection,
  publicNamedAction,
  translateNamedActionCall,
} from '../lib/named-actions.mjs';
import { ApprovalQueue } from '../lib/policies.mjs';
import { LoopStore } from '../lib/store.mjs';
import { closeAllWorkspaceDbs } from '../lib/storage/workspace-db.mjs';
import { mountOAuthConsentPicker } from '../public/oauth-consent-view.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
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

// Synthetic OAuth + MCP server whose tool discovery can be toggled between failing and succeeding.
async function startOAuthDiscoveryFixture(t, { failToolsList = true } = {}) {
  let shouldFailTools = failToolsList;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const origin = `http://127.0.0.1:${server.address().port}`;

    if (url.pathname === '/.well-known/oauth-protected-resource') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }));
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      }));
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ client_id: 'fixture-client', token_endpoint_auth_method: 'none' }));
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: 3600 }));
    }
    if (url.pathname === '/mcp' && req.method === 'POST') {
      if (req.headers.authorization !== 'Bearer fixture-access-token') {
        res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` });
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (body.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'Fixture OAuth MCP', version: '1.0.0' },
          },
        }));
      }
      if (body.method === 'notifications/initialized') {
        res.writeHead(202);
        return res.end();
      }
      if (body.method === 'tools/list') {
        if (shouldFailTools) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Upstream tool catalog unavailable' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [{
              name: 'read_status',
              description: 'Read sample status.',
              inputSchema: { type: 'object', properties: {} },
              annotations: { readOnlyHint: true },
            }],
          },
        }));
      }
      if (body.method === 'tools/call' && body.params?.name === 'read_status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: '{"ok":true,"status":"healthy"}' }] },
        }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }));
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    setFailToolsList(next) { shouldFailTools = next; },
  };
}

/* ============================================================================
 * 1. Show whether the connection actually works after OAuth sign-in
 * ============================================================================ */

test('1. OAuth callback returns post-sign-in discovery failure, never claims ready or Read succeeded, and supports retry', { timeout: 15_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-post-signin-'));
  const upstream = await startOAuthDiscoveryFixture(t, { failToolsList: true });
  const srv = await startServer({
    port: 0, dataDir: dir, authMode: 'local-test', detectLocalAgents: false, seedBuiltins: false,
    searchEnv: { LOOP_EMBEDDING_PROVIDER: 'off' },
  });
  t.after(async () => {
    await srv.close();
    closeAllWorkspaceDbs();
    await rm(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${srv.port}`;
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'fixture-owner-password' }),
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const api = async (route, opts = {}) => {
    const res = await fetch(`${base}${route}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(opts.headers || {}) },
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  const added = await api('/api/mcps', {
    method: 'POST',
    body: JSON.stringify({ name: 'Fixture Mail', accountLabel: 'Work', transport: 'http', url: upstream.url, skipSync: true }),
  });
  assert.equal(added.status, 201);
  const connId = added.json.mcp.id;

  const started = await api(`/api/mcps/${connId}/oauth/start`, { method: 'POST' });
  assert.equal(started.status, 200);
  const oauthState = new URL(started.json.authorizeUrl).searchParams.get('state');

  // OAuth token exchange succeeds, but upstream tools/list returns HTTP 500.
  const finished = await api('/api/mcps/oauth/finish', {
    method: 'POST',
    body: JSON.stringify({ code: 'fixture-code', state: oauthState }),
  });
  assert.equal(finished.status, 200);
  assert.equal(finished.json.connected, connId);
  assert.equal(finished.json.ready, false);
  assert.equal(finished.json.readiness.ready, false);
  assert.equal(finished.json.readiness.state, 'error');
  assert.equal(finished.json.readEvidence, null);
  assert.ok(finished.json.discoveryError);

  // Dashboard connection popup shows discovery failure + Retry discovery button, never "Read succeeded".
  let postSignInSummary;
  await withDom('<main></main>', async ({ document }) => {
    const popupMod = await import('../public/connection-popup.js');
    postSignInSummary = popupMod.postSignInSummary;
    const failNotice = postSignInSummary(finished.json);
    assert.equal(failNotice.ready, false);
    assert.equal(failNotice.tone, 'err');
    assert.equal(failNotice.canRetry, true);
    assert.doesNotMatch(failNotice.toast, /go back to your agent|return to your agent|Read succeeded/i);

    const toasts = [];
    const popupApi = async (route, opts = {}) => {
      const r = await api(route, opts);
      if (r.status >= 400) throw new Error(r.json?.error || `HTTP ${r.status}`);
      return r.json;
    };
    await popupMod.openConnectionPopup(
      { esc, api: popupApi, toast: (msg, tone) => toasts.push({ msg, tone }), renderConnLogo: () => '' },
      connId,
      { oauthResult: finished.json },
    );
    try {
      const alertBox = document.querySelector('[data-cp-post-signin-error]');
      assert.ok(alertBox, 'expected post-sign-in discovery failure callout');
      assert.match(alertBox.textContent, /Tool discovery failed after sign-in/);
      const retryBtn = alertBox.querySelector('[data-cp-sync]');
      assert.ok(retryBtn, 'expected Retry discovery button');
      assert.doesNotMatch(document.body.textContent, /Read succeeded/);

      // Upstream recovers; clicking Retry discovery discovers tools without falsely claiming "Read succeeded".
      upstream.setFailToolsList(false);
      retryBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(document.querySelector('[data-cp-post-signin-error]'), null);
      assert.match(document.querySelector('.cp-st').textContent, /Ready · \d+ tools?/);
      assert.doesNotMatch(document.body.textContent, /Read succeeded/);
    } finally {
      popupMod.closeConnectionPopup({ immediate: true, quiet: true });
    }
  });

  // Only an actual successful read establishes readEvidence and "Read succeeded".
  const readBefore = await api(`/api/mcps/${connId}/read-status`);
  assert.equal(readBefore.json.readiness.ready, true);
  assert.equal(readBefore.json.readEvidence, null);
  const okNotice = postSignInSummary({ ...readBefore.json, ready: true });
  assert.equal(okNotice.ready, true);
  assert.equal(okNotice.readSucceeded, false);
  assert.doesNotMatch(okNotice.toast, /Read succeeded/);

  const testRead = await api(`/api/mcps/${connId}/tools/test`, {
    method: 'POST',
    body: JSON.stringify({ toolName: 'read_status', arguments: {} }),
  });
  assert.equal(testRead.status, 200);
  const readAfter = await api(`/api/mcps/${connId}/read-status`);
  assert.equal(readAfter.json.readEvidence?.tool, 'read_status');
  assert.ok(readAfter.json.readEvidence?.succeededAt);
});

/* ============================================================================
 * 2. Separate per-account sign-ins, provider account ID, and account labels
 * ============================================================================ */

test('2. Personal and Work Gmail sign-ins stay separate rows, and with Personal working Work stays pending until Work is confirmed', async () => {
  let clock = 1_700_000_000_000;
  const signIns = new AppSignIns({ now: () => clock });
  const conn = { id: 'composio', name: 'Composio', enabled: true, transport: 'http', url: 'https://composio.example.test/mcp' };
  const caller = 'ag_1';
  const manageKey = callKeyOf(conn.id, 'COMPOSIO_MANAGE_CONNECTIONS', { toolkits: ['gmail'] });

  const personalUrl = 'https://connect.composio.dev/link/ln_personal_1';
  const workUrl = 'https://connect.composio.dev/link/ln_work_2';

  // Step A: Two sign-in links arrive from the same connector tool (even same callKey).
  signIns.noteResult({
    conn,
    caller,
    toolName: 'COMPOSIO_MANAGE_CONNECTIONS',
    callKey: manageKey,
    result: {
      content: [{
        type: 'text',
        text: JSON.stringify({
          redirect_url: personalUrl,
          connected_account_id: 'ca_personal',
          account_label: 'Personal',
        }),
      }],
    },
  });
  const foundPersonal = signIns.resultWith({ conn, caller, toolName: 'COMPOSIO_MANAGE_CONNECTIONS', url: personalUrl });
  assert.equal(foundPersonal.accountId, 'ca_personal');
  assert.equal(foundPersonal.accountLabel, 'Personal');

  const recPersonal = signIns.open(conn, {
    url: personalUrl,
    app: 'Gmail',
    accountLabel: foundPersonal.accountLabel,
    accountId: foundPersonal.accountId,
    callKey: foundPersonal.callKey,
    askedBy: 'Assistant',
    reported: true,
  });

  // Start Work Gmail sign-in before Personal is finished -> MUST produce TWO separate pending rows.
  clock += 1000;
  signIns.noteResult({
    conn,
    caller,
    toolName: 'COMPOSIO_MANAGE_CONNECTIONS',
    callKey: manageKey,
    result: {
      content: [{
        type: 'text',
        text: JSON.stringify({
          redirect_url: workUrl,
          connected_account_id: 'ca_work',
          account_label: 'Work',
        }),
      }],
    },
  });
  const foundWork = signIns.resultWith({ conn, caller, toolName: 'COMPOSIO_MANAGE_CONNECTIONS', url: workUrl });
  assert.equal(foundWork.accountId, 'ca_work');
  assert.equal(foundWork.accountLabel, 'Work');

  const recWork = signIns.open(conn, {
    url: workUrl,
    app: 'Gmail',
    accountLabel: foundWork.accountLabel,
    accountId: foundWork.accountId,
    callKey: foundWork.callKey,
    askedBy: 'Assistant',
    reported: true,
  });

  assert.notEqual(recPersonal.id, recWork.id);
  const pendingBoth = signIns.list(conn);
  assert.equal(pendingBoth.length, 2);
  assert.deepEqual(
    pendingBoth.map((r) => ({ app: r.app, label: r.accountLabel, id: r.accountId, state: r.state })),
    [
      { app: 'Gmail', label: 'Personal', id: 'ca_personal', state: 'open' },
      { app: 'Gmail', label: 'Work', id: 'ca_work', state: 'open' },
    ],
  );

  // Step B: Owner opens Personal, Personal call succeeds, Personal is confirmed -> Personal is ready, Work stays pending!
  clock += 1000;
  assert.ok(signIns.opened(conn, recPersonal.id));
  clock += 1000;
  signIns.noteResult({
    conn,
    caller,
    toolName: 'COMPOSIO_MULTI_EXECUTE_TOOL',
    callKey: callKeyOf(conn.id, 'COMPOSIO_MULTI_EXECUTE_TOOL', { connected_account_id: 'ca_personal' }),
    args: { tools: [{ tool_slug: 'GMAIL_GET_PROFILE', connected_account_id: 'ca_personal', arguments: { user_id: 'me' } }] },
    result: { content: [{ type: 'text', text: '{"successful":true,"connected_account_id":"ca_personal"}' }] },
  });
  const personalConfirmed = signIns.confirm({
    conn,
    caller,
    app: 'Gmail',
    accountLabel: 'Personal',
    accountId: 'ca_personal',
    toolName: 'COMPOSIO_MULTI_EXECUTE_TOOL',
  });
  assert.equal(personalConfirmed.reason, undefined);
  assert.equal(personalConfirmed.record.state, 'ready');

  // Acceptance checks: Work MUST stay pending despite Personal working!
  const afterPersonal = signIns.list(conn);
  assert.equal(afterPersonal.find((r) => r.id === recPersonal.id).state, 'ready');
  assert.equal(afterPersonal.find((r) => r.id === recWork.id).state, 'open');

  // Ambiguous confirmation without account selector refuses instead of guessing Personal or confirming Work.
  const ambiguous = signIns.confirm({ conn, caller, app: 'Gmail', toolName: 'COMPOSIO_MULTI_EXECUTE_TOOL' });
  assert.equal(ambiguous.reason, 'ambiguous');
  assert.equal(signIns.list(conn).find((r) => r.id === recWork.id).state, 'open');

  // Confirming Work before opening Work's link fails with not_opened.
  const workBeforeOpen = signIns.confirm({
    conn,
    caller,
    app: 'Gmail',
    accountLabel: 'Work',
    toolName: 'COMPOSIO_MULTI_EXECUTE_TOOL',
  });
  assert.equal(workBeforeOpen.reason, 'not_opened');
  assert.equal(signIns.list(conn).find((r) => r.id === recWork.id).state, 'open');

  // Opening Work, then running a call for Personal (ca_personal), STILL cannot confirm Work!
  clock += 1000;
  assert.ok(signIns.opened(conn, recWork.id));
  clock += 1000;
  signIns.noteResult({
    conn,
    caller,
    toolName: 'COMPOSIO_MULTI_EXECUTE_TOOL',
    callKey: callKeyOf(conn.id, 'COMPOSIO_MULTI_EXECUTE_TOOL', { connected_account_id: 'ca_personal', n: 2 }),
    args: { tools: [{ tool_slug: 'GMAIL_GET_PROFILE', connected_account_id: 'ca_personal', arguments: { user_id: 'me' } }] },
    result: { content: [{ type: 'text', text: '{"successful":true,"connected_account_id":"ca_personal"}' }] },
  });
  const wrongAccount = signIns.confirm({
    conn,
    caller,
    app: 'Gmail',
    accountLabel: 'Work',
    accountId: 'ca_work',
    toolName: 'COMPOSIO_MULTI_EXECUTE_TOOL',
  });
  assert.equal(wrongAccount.reason, 'account_mismatch');
  assert.equal(signIns.list(conn).find((r) => r.id === recWork.id).state, 'open');

  // Only after a working call for Work (ca_work) does Work confirm to ready.
  clock += 1000;
  signIns.noteResult({
    conn,
    caller,
    toolName: 'COMPOSIO_MULTI_EXECUTE_TOOL',
    callKey: callKeyOf(conn.id, 'COMPOSIO_MULTI_EXECUTE_TOOL', { connected_account_id: 'ca_work' }),
    args: { tools: [{ tool_slug: 'GMAIL_GET_PROFILE', connected_account_id: 'ca_work', arguments: { user_id: 'me' } }] },
    result: { content: [{ type: 'text', text: '{"successful":true,"connected_account_id":"ca_work"}' }] },
  });
  const workConfirmed = signIns.confirm({
    conn,
    caller,
    app: 'Gmail',
    accountLabel: 'Work',
    accountId: 'ca_work',
    toolName: 'COMPOSIO_MULTI_EXECUTE_TOOL',
  });
  assert.equal(workConfirmed.reason, undefined);
  assert.equal(workConfirmed.record.state, 'ready');
  assert.deepEqual(
    signIns.list(conn).map((r) => ({ label: r.accountLabel, id: r.accountId, state: r.state })),
    [
      { label: 'Personal', id: 'ca_personal', state: 'ready' },
      { label: 'Work', id: 'ca_work', state: 'ready' },
    ],
  );
});

test('2b. Account label flows through Add Connection setup, Connection popup pending rows, and approval cards', async () => {
  await withDom('<main></main>', async ({ document }) => {
    const { openAddConnectionPopup, openConnectionPopup, closeConnectionPopup } = await import('../public/connection-popup.js');
    const submittedBodies = [];
    const mockApi = async (route, opts = {}) => {
      if (route === '/api/profiles') return { profiles: [] };
      if (route === '/api/mcps/probe') return { status: 'ready', url: 'https://mail.example.test/mcp', suggestedName: 'Gmail', transport: 'http' };
      if (route === '/api/mcps' && opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        submittedBodies.push(body);
        return { mcp: { id: 'gmail_work', name: body.name, accountLabel: body.accountLabel, enabled: true, tools: [] } };
      }
      if (route === '/api/mcps') {
        return {
          mcps: [{
            id: 'composio',
            name: 'Composio',
            accountLabel: 'Team Workspace',
            enabled: true,
            transport: 'http',
            url: 'https://composio.example.test/mcp',
            tools: [{ name: 'COMPOSIO_MULTI_EXECUTE_TOOL', enabled: true }],
            readiness: { ready: true, state: 'ready', label: 'Ready', discoveredTools: 1, enabledTools: 1 },
            appSignIns: [
              { id: '1111111111111111', app: 'Gmail', accountLabel: 'Personal', accountId: 'ca_personal', state: 'ready', host: 'connect.composio.dev', url: null, opened: true },
              { id: '2222222222222222', app: 'Gmail', accountLabel: 'Work', accountId: 'ca_work', state: 'open', host: 'connect.composio.dev', url: 'https://connect.composio.dev/link/ln_work', opened: false },
            ],
          }],
        };
      }
      return {};
    };

    // Add Connection form carries accountLabel to POST /api/mcps.
    await openAddConnectionPopup({ esc, api: mockApi, toast() {} }, {});
    const urlInput = document.querySelector('#cp-add-url');
    const acctInput = document.querySelector('#cp-add-form input[name="accountLabel"]');
    assert.ok(acctInput, 'Add Connection form should include accountLabel input');
    urlInput.value = 'https://mail.example.test/mcp';
    urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    acctInput.value = 'Work';
    acctInput.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#cp-add-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(submittedBodies[0]?.accountLabel, 'Work');
    closeConnectionPopup({ immediate: true, quiet: true });

    // Connection popup shows Personal as signed in and Work as a separate pending sign-in row with accountId.
    await openConnectionPopup({ esc, api: mockApi, toast() {}, renderConnLogo: () => '' }, 'composio');
    try {
      assert.match(document.querySelector('#cp-title').textContent, /Composio.*Team Workspace/s);
      const pendingRow = document.querySelector('[data-cp-app-signin-row="2222222222222222"]');
      assert.ok(pendingRow);
      assert.match(pendingRow.textContent, /Sign in to Gmail \(Work\)/);
      assert.match(pendingRow.textContent, /ca_work/);
      assert.match(document.body.textContent, /Gmail \(Personal\)/);
    } finally {
      closeConnectionPopup({ immediate: true, quiet: true });
    }
  });
});

/* ============================================================================
 * 3. Pilot "Search Work Gmail" named action grant
 * ============================================================================ */

test('3. Named action grant "Search Work Gmail" maps to GMAIL_FETCH_EMAILS pinned to Work, blocks broker tool and Personal, and uses Loop policies + Activity log', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-gmail-action-'));
  t.after(async () => {
    closeAllWorkspaceDbs();
    await rm(dir, { recursive: true, force: true });
  });

  // Set up one multi-action connector with Personal (ready) and Work (pending -> ready).
  let clock = 1_700_000_000_000;
  const signIns = new AppSignIns({ dir, now: () => clock });
  const store = new LoopStore(dir);
  const activity = new ActivityLog(dir);
  const conn = await store.add({
    name: 'Composio',
    transport: 'http',
    url: 'https://composio.example.test/mcp',
    enabled: true,
    tools: [
      {
        name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
        description: 'Execute any Composio tool.',
        inputSchema: { type: 'object', properties: { tools: { type: 'array' } } },
      },
    ],
  });

  // Open Personal and Work Gmail sign-ins behind this single connector.
  const personalRec = signIns.open(conn, {
    url: 'https://connect.composio.dev/link/p1',
    app: 'Gmail',
    accountLabel: 'Personal',
    accountId: 'ca_personal',
    callKey: 'k1',
    reported: true,
  });
  const workRec = signIns.open(conn, {
    url: 'https://connect.composio.dev/link/w1',
    app: 'Gmail',
    accountLabel: 'Work',
    accountId: 'ca_work',
    callKey: 'k2',
    reported: true,
  });

  // Confirm Personal only -> ONLY "Search Personal Gmail" is offered; Work cannot be granted while pending!
  signIns.opened(conn, personalRec.id);
  clock += 1000;
  signIns.noteResult({
    conn,
    caller: 'owner',
    toolName: 'COMPOSIO_MULTI_EXECUTE_TOOL',
    callKey: 'k_verify_p',
    args: { connected_account_id: 'ca_personal' },
    result: { content: [{ type: 'text', text: '{"successful":true}' }] },
  });
  assert.equal(signIns.confirm({ conn, caller: 'owner', app: 'Gmail', accountId: 'ca_personal', toolName: 'COMPOSIO_MULTI_EXECUTE_TOOL' }).reason, undefined);

  const actionsBeforeWork = listNamedActionsForConnection(conn, { appSignIns: signIns.list(conn) });
  assert.deepEqual(actionsBeforeWork.map((a) => ({ id: a.id, title: a.title })), [
    { id: 'action:gmail.search:ca_personal', title: 'Search Personal Gmail' },
  ]);
  await assert.rejects(
    store.validateOAuthToolGrants({ [conn.id]: ['action:gmail.search:ca_work'] }, 'all', null, { appSignIns: (c) => signIns.list(c) }),
    /no longer available/i,
  );

  // Confirm Work -> now BOTH "Search Personal Gmail" and "Search Work Gmail" are available and grantable.
  signIns.opened(conn, workRec.id);
  clock += 1000;
  signIns.noteResult({
    conn,
    caller: 'owner',
    toolName: 'COMPOSIO_MULTI_EXECUTE_TOOL',
    callKey: 'k_verify_w',
    args: { connected_account_id: 'ca_work' },
    result: { content: [{ type: 'text', text: '{"successful":true}' }] },
  });
  assert.equal(signIns.confirm({ conn, caller: 'owner', app: 'Gmail', accountId: 'ca_work', toolName: 'COMPOSIO_MULTI_EXECUTE_TOOL' }).reason, undefined);

  const actionsBoth = listNamedActionsForConnection(conn, { appSignIns: signIns.list(conn) });
  assert.deepEqual(actionsBoth.map((a) => ({ id: a.id, title: a.title })), [
    { id: 'action:gmail.search:ca_personal', title: 'Search Personal Gmail' },
    { id: 'action:gmail.search:ca_work', title: 'Search Work Gmail' },
  ]);
  await store.validateOAuthToolGrants({ [conn.id]: ['action:gmail.search:ca_work'] }, 'all', null, { appSignIns: (c) => signIns.list(c) });

  // Pure translation check: rejects operation/account overrides.
  const workAction = actionsBoth.find((a) => a.id === 'action:gmail.search:ca_work');
  assert.equal(translateNamedActionCall(workAction, { query: 'q', tool_slug: 'GMAIL_SEND_EMAIL' }).ok, false);
  assert.equal(translateNamedActionCall(workAction, { query: 'q', connected_account_id: 'ca_personal' }).ok, false);

  // OAuth consent UI lets owner pick "Search Work Gmail" without picking COMPOSIO_MULTI_EXECUTE_TOOL.
  await withDom('<button id="oauth-allow"></button><button id="oauth-expand"></button><div id="oc-drawer"><div id="oc-picker"></div></div>', async ({ document }) => {
    const picker = mountOAuthConsentPicker(document.body, {
      esc,
      api: async (route) => route === '/api/overview'
        ? {
            mcps: [{
              ...conn,
              namedActions: actionsBoth.map(publicNamedAction),
            }],
            categories: [],
          }
        : { secrets: [] },
      renderConnLogo: () => '',
      groupConnectionsByCategory: () => [],
      clientName: 'OpenMausBot',
      offerOneConnection: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const sel = document.getElementById('oc-one-connection');
    sel.querySelector(`option[value="${conn.id}"]`).selected = true;
    sel.dispatchEvent(new Event('change'));

    const workBox = document.querySelector('[data-oc-action][value="action:gmail.search:ca_work"]');
    assert.ok(workBox, 'expected Search Work Gmail checkbox');
    assert.match(workBox.closest('label').textContent, /Search Work Gmail/);
    workBox.checked = true;
    workBox.dispatchEvent(new Event('change', { bubbles: true }));
    assert.deepEqual(picker.getApprovalPayload(), {
      profile: 'all',
      access: {
        allowedConnections: [conn.id],
        allowedSkills: [],
        memoryAccess: 'none',
        canManage: false,
        secrets: [],
        toolGrants: { [conn.id]: ['action:gmail.search:ca_work'] },
      },
    });
  });

  // Agent popup renders the readable title "Search Work Gmail".
  await withDom('<main></main>', async ({ document }) => {
    const { openAgentPopup, closeAgentPopup } = await import('../public/agent-popup.js');
    const scopedAgent = {
      id: 'ag_work_gmail', name: 'OpenMausBot', kind: 'other', enabled: true,
      allowedConnections: [conn.id], allowedSkills: [], secrets: [], canManage: false, memoryAccess: 'none',
      toolGrants: { [conn.id]: ['action:gmail.search:ca_work'] },
    };
    await openAgentPopup({
      esc,
      api: async (route) => route === '/api/agents'
        ? { agents: [scopedAgent], connected: [] }
        : route === '/api/overview'
          ? { mcps: [{ ...conn, namedActions: actionsBoth.map(publicNamedAction) }] }
          : { entries: [] },
      addAgent() {},
    }, scopedAgent.id, 'access');
    try {
      assert.match(document.querySelector('#ap-pane').textContent, /Search Work Gmail/);
    } finally {
      closeAgentPopup({ immediate: true, quiet: true });
    }
  });

  // MCP execution: agent with ONLY "Search Work Gmail" grant.
  const dispatched = [];
  const pool = {
    signIns,
    callTool: async (id, name, args) => {
      dispatched.push({ id, name, args });
      return { content: [{ type: 'text', text: JSON.stringify({ successful: true, messages: [{ id: 'm1', subject: 'Q4 Invoice' }] }) }] };
    },
  };
  const agent = {
    id: 'ag_work_gmail',
    name: 'OpenMausBot',
    enabled: true,
    profile: 'all',
    allowedConnections: [conn.id],
    allowedSkills: [],
    secrets: [],
    canManage: false,
    memoryAccess: 'none',
    toolGrants: { [conn.id]: ['action:gmail.search:ca_work'] },
  };
  const rpc = (method, params, options = {}) => handleMcpRequest(store, null, pool, {
    jsonrpc: '2.0', id: 1, method, params,
  }, { agent, activity, ...options });

  // tools/list shows ONLY Search Work Gmail, never COMPOSIO_MULTI_EXECUTE_TOOL or Personal.
  const listRes = await rpc('tools/list', {});
  assert.equal(listRes.result.tools.length, 1);
  const exposed = listRes.result.tools[0];
  assert.equal(exposed.title, 'Search Work Gmail');
  assert.equal(exposed.annotations?.readOnlyHint, true);
  assert.doesNotMatch(JSON.stringify(listRes), /COMPOSIO_MULTI_EXECUTE_TOOL|ca_personal|Personal/);

  // Direct call translates to COMPOSIO_MULTI_EXECUTE_TOOL -> GMAIL_FETCH_EMAILS + ca_work.
  const searchRes = await rpc('tools/call', {
    name: exposed.name,
    arguments: { query: 'from:finance@company.com', maxResults: 5 },
  });
  assert.equal(Boolean(searchRes.result?.isError), false, JSON.stringify(searchRes));
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0], {
    id: conn.id,
    name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
    args: {
      tools: [{
        tool_slug: 'GMAIL_FETCH_EMAILS',
        connected_account_id: 'ca_work',
        arguments: {
          user_id: 'me',
          max_results: 5,
          query: 'from:finance@company.com',
        },
      }],
      sync_response_to_workbench: false,
    },
  });

  // Raw multi-action broker tool, Personal Gmail, and argument injection are ALL blocked!
  for (const [name, args] of [
    [`${conn.id}__COMPOSIO_MULTI_EXECUTE_TOOL`, { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: {} }] }],
    ['loop__run', { tool: `${conn.id}__COMPOSIO_MULTI_EXECUTE_TOOL`, arguments: { tools: [] } }],
    [`${conn.id}__action:gmail.search:ca_personal`, { query: 'secret' }],
    ['loop__run', { tool: `${conn.id}__action:gmail.search:ca_personal`, arguments: { query: 'secret' } }],
    [exposed.name, { query: 'invoice', tool_slug: 'GMAIL_SEND_EMAIL' }],
    [exposed.name, { query: 'invoice', connected_account_id: 'ca_personal' }],
  ]) {
    const blocked = await rpc('tools/call', { name, arguments: args });
    assert.ok(blocked.error || blocked.result?.isError, `Expected denial for ${name}`);
  }
  assert.equal(dispatched.length, 1, 'blocked calls must never reach upstream');

  // Loop policy / approval enforcement carries Work account + operation details and resumes cleanly.
  const queue = new ApprovalQueue();
  try {
    const askOpts = {
      approvalQueue: queue,
      approvalWaitMs: 0,
      policyStore: { evaluateRun: async () => ({ decision: 'always_ask', reason: 'Owner reviews Gmail searches' }) },
    };
    const paused = await rpc('tools/call', { name: exposed.name, arguments: { query: 'board deck' } }, askOpts);
    const pausedBody = JSON.parse(paused.result.content[0].text);
    assert.equal(pausedBody.status, 'approval_required');
    const pending = queue.listPending()[0];
    assert.match(pending.title, /Search Work Gmail/);
    assert.equal(pending.detail.account, 'Work');
    assert.equal(pending.detail.operation, 'GMAIL_FETCH_EMAILS');
    assert.equal(pending.detail.accountId, 'ca_work');

    assert.ok(queue.approve(pending.id).ok);
    const resumed = await rpc('tools/call', {
      name: exposed.name,
      arguments: { query: 'board deck', _approvalId: pending.id },
    }, askOpts);
    assert.equal(Boolean(resumed.result?.isError), false, JSON.stringify(resumed));
    assert.equal(dispatched.length, 2);
  } finally {
    await queue.close();
  }

  // Loop Activity log records the named action, Work account, and translated provider operation.
  await activity.flush();
  const entries = await activity.list({ agentId: agent.id, limit: 20 });
  const okEntries = entries.filter((e) => e.ok && e.method === 'tools/call');
  assert.equal(okEntries.length, 2);
  assert.equal(okEntries[0].account, 'Work');
  assert.equal(okEntries[0].tool, 'action:gmail.search:ca_work');
  assert.equal(okEntries[0].toolKind, 'read');
  assert.equal(okEntries[0].actionTitle, 'Search Work Gmail');
  assert.equal(okEntries[0].providerTool, 'COMPOSIO_MULTI_EXECUTE_TOOL');
  assert.equal(okEntries[0].providerOperation, 'GMAIL_FETCH_EMAILS');
  assert.equal(okEntries[0].accountId, 'ca_work');
});

test('2c. MCP loop__run signIn reports Personal and Work Gmail as separate rows and refuses ambiguous confirm', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loop-mcp-signin-'));
  t.after(async () => {
    closeAllWorkspaceDbs();
    await rm(dir, { recursive: true, force: true });
  });
  let clock = 1_700_000_000_000;
  const signIns = new AppSignIns({ dir, now: () => clock });
  const store = new LoopStore(dir);
  const conn = await store.add({
    name: 'Composio',
    transport: 'http',
    url: 'https://composio.example.test/mcp',
    enabled: true,
    tools: [
      { name: 'COMPOSIO_MANAGE_CONNECTIONS', inputSchema: { type: 'object', properties: { account: { type: 'string' } } } },
      { name: 'COMPOSIO_MULTI_EXECUTE_TOOL', inputSchema: { type: 'object', properties: { account: { type: 'string' } } } },
    ],
  });
  const pool = {
    signIns,
    callTool: async (_id, name, args) => {
      if (name === 'COMPOSIO_MANAGE_CONNECTIONS') {
        const acct = args?.account === 'work' ? { id: 'ca_work', label: 'Work', url: 'https://connect.composio.dev/link/work_mcp' }
          : { id: 'ca_personal', label: 'Personal', url: 'https://connect.composio.dev/link/personal_mcp' };
        return { content: [{ type: 'text', text: JSON.stringify({ redirect_url: acct.url, connected_account_id: acct.id, account_label: acct.label }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, connected_account_id: args?.account === 'work' ? 'ca_work' : 'ca_personal' }) }] };
    },
  };
  const agent = { id: 'ag_1', name: 'Assistant', enabled: true, profile: 'all', canManage: true, memoryAccess: 'none', secrets: [] };
  const run = (args) => handleMcpRequest(store, null, pool, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'loop__run', arguments: args },
  }, { agent, dashboardUrl: 'http://127.0.0.1:8799' });

  // Obtain and report Personal + Work links.
  await run({ tool: `${conn.id}__COMPOSIO_MANAGE_CONNECTIONS`, arguments: { account: 'personal' } });
  const repPersonal = JSON.parse((await run({
    tool: `${conn.id}__COMPOSIO_MANAGE_CONNECTIONS`,
    signIn: { url: 'https://connect.composio.dev/link/personal_mcp', app: 'Gmail' },
  })).result.content[0].text);
  assert.equal(repPersonal.status, 'app_sign_in_required');
  assert.equal(repPersonal.accountLabel, 'Personal');
  assert.equal(repPersonal.accountId, 'ca_personal');

  clock += 1000;
  await run({ tool: `${conn.id}__COMPOSIO_MANAGE_CONNECTIONS`, arguments: { account: 'work' } });
  const repWork = JSON.parse((await run({
    tool: `${conn.id}__COMPOSIO_MANAGE_CONNECTIONS`,
    signIn: { url: 'https://connect.composio.dev/link/work_mcp', app: 'Gmail' },
  })).result.content[0].text);
  assert.equal(repWork.status, 'app_sign_in_required');
  assert.equal(repWork.accountLabel, 'Work');
  assert.equal(repWork.accountId, 'ca_work');
  assert.notEqual(repPersonal.signInId, repWork.signInId);
  assert.equal(signIns.list(conn).length, 2);

  // Confirm Personal; ambiguous confirm fails and Work stays open until opened + Work call + confirmed.
  signIns.opened(conn, repPersonal.signInId);
  clock += 1000;
  await run({ tool: `${conn.id}__COMPOSIO_MULTI_EXECUTE_TOOL`, arguments: { account: 'personal' } });
  const okPersonal = JSON.parse((await run({
    tool: `${conn.id}__COMPOSIO_MULTI_EXECUTE_TOOL`,
    signIn: { app: 'Gmail', signInId: repPersonal.signInId, done: true },
  })).result.content[0].text);
  assert.equal(okPersonal.status, 'ready');

  const amb = await run({
    tool: `${conn.id}__COMPOSIO_MULTI_EXECUTE_TOOL`,
    signIn: { app: 'Gmail', done: true },
  });
  assert.equal(amb.result.isError, true);
  assert.match(amb.result.content[0].text, /More than one sign-in matches/);
  assert.equal(signIns.list(conn).find((r) => r.id === repWork.signInId).state, 'open');

  signIns.opened(conn, repWork.signInId);
  clock += 1000;
  await run({ tool: `${conn.id}__COMPOSIO_MULTI_EXECUTE_TOOL`, arguments: { account: 'work' } });
  const okWork = JSON.parse((await run({
    tool: `${conn.id}__COMPOSIO_MULTI_EXECUTE_TOOL`,
    signIn: { app: 'Gmail', signInId: repWork.signInId, done: true },
  })).result.content[0].text);
  assert.equal(okWork.status, 'ready');
  assert.equal(okWork.accountLabel, 'Work');
  assert.equal(okWork.accountId, 'ca_work');
});
