import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  CALENDAR_LIST_ACTION_BASE,
  GITHUB_SEARCH_ACTION_BASE,
  GMAIL_SEARCH_ACTION_BASE,
  LINEAR_LIST_ACTION_BASE,
  SLACK_SEARCH_ACTION_BASE,
  listNamedActionsForConnection,
  translateNamedActionCall,
} from '../lib/named-actions.mjs';
import { startServer } from '../server.mjs';

function makePkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

async function setupServer(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'loop-phase2-'));
  const srv = await startServer({
    port: 0,
    dataDir,
    authMode: 'local-test',
    detectLocalAgents: false,
    seedBuiltins: true,
  });
  t.after(async () => {
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${srv.port}`;
  const setupRes = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'phase2-password' }),
  });
  assert.equal(setupRes.status, 200);
  const cookie = (setupRes.headers.get('set-cookie') || '').split(';')[0];
  return { base, cookie, srv };
}

async function mcpPost(url, token, body, extraHeaders = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, json: await res.json() };
}

test('Phase 2: explicit toolMode (direct & hybrid) exposes flat tools with real MCP annotations', async (t) => {
  const { base, cookie } = await setupServer(t);
  const ownerHeaders = { 'Content-Type': 'application/json', Cookie: cookie };

  // Create a direct-mode agent (for hosts like Meta Muse Sentinel or OpenBot CEL)
  const createDirect = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ name: 'Meta Muse Direct', kind: 'meta-muse', toolMode: 'direct' }),
  });
  assert.equal(createDirect.status, 201);
  const { token: directToken, agent: directAgent } = await createDirect.json();
  assert.equal(directAgent.toolMode, 'direct');

  const directList = await mcpPost(`${base}/mcp`, directToken, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  });
  assert.equal(directList.status, 200);
  const directTools = directList.json.result.tools;
  assert.ok(directTools.length > 0);
  assert.equal(directTools.some((tool) => tool.name === 'loop__run'), false, 'direct mode omits meta loop__run');
  const calcTool = directTools.find((tool) => tool.name === 'loop_utils__calc');
  assert.ok(calcTool, 'direct mode exposes concrete loop_utils__calc tool');
  assert.equal(calcTool.annotations?.readOnlyHint, true, 'real MCP readOnlyHint annotation preserved');

  // Execute the direct tool cleanly
  const calcCall = await mcpPost(`${base}/mcp`, directToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'loop_utils__calc', arguments: { expression: '6 * 7' } },
  });
  assert.equal(calcCall.status, 200);
  assert.equal(calcCall.json.result.isError, false);
  assert.match(calcCall.json.result.content[0].text, /42/);

  // Create a hybrid-mode agent: exposes both meta-tools and pinned direct tools
  const createHybrid = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ name: 'Hybrid Bot', kind: 'openbot', toolMode: 'hybrid' }),
  });
  assert.equal(createHybrid.status, 201);
  const { token: hybridToken } = await createHybrid.json();
  const hybridList = await mcpPost(`${base}/mcp`, hybridToken, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/list',
    params: {},
  });
  const hybridNames = hybridList.json.result.tools.map((tool) => tool.name);
  assert.ok(hybridNames.includes('loop__search'), 'hybrid mode keeps loop__search');
  assert.ok(hybridNames.includes('loop__run'), 'hybrid mode keeps loop__run');
  assert.ok(hybridNames.some((n) => n.startsWith('loop_utils__') || n.startsWith('loop_web__') || n.startsWith('loop_notify__')), 'hybrid mode also surfaces direct tools');
});

test('Phase 2: multi-connection OAuth toolGrants exposes only selected actions across multiple connections', async (t) => {
  const { base, cookie } = await setupServer(t);
  const redirectUri = 'http://127.0.0.1:54221/cb';
  const reg = await (await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Grok Bot', redirect_uris: [redirectUri] }),
  })).json();
  const pkce = makePkce();
  const authUrl = new URL(`${base}/oauth/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', reg.client_id);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('resource', `${base}/mcp`);
  const txId = new URL((await fetch(authUrl, { redirect: 'manual' })).headers.get('location'), base).searchParams.get('loop-oauth');

  const approveRes = await fetch(`${base}/api/oauth/requests/${txId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      access: {
        allowedConnections: ['loop_utils', 'loop_notify'],
        toolGrants: {
          loop_utils: ['calc'],
          loop_notify: ['list_notifications'],
        },
        allowedSkills: [],
        memoryAccess: 'none',
        canManage: false,
        secrets: [],
      },
    }),
  });
  assert.equal(approveRes.status, 200);
  const code = new URL((await approveRes.json()).redirectUrl).searchParams.get('code');
  const tokenRes = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: reg.client_id,
      redirect_uri: redirectUri,
      code_verifier: pkce.verifier,
    }),
  });
  assert.equal(tokenRes.status, 200);
  const { access_token: token } = await tokenRes.json();

  const listed = await mcpPost(`${base}/mcp`, token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const names = listed.json.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['loop_notify__list_notifications', 'loop_utils__calc']);

  // Calling an ungranted tool on one of those connections is blocked
  const blocked = await mcpPost(`${base}/mcp`, token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'loop_utils__time_now', arguments: {} },
  });
  assert.ok(blocked.json.error || blocked.json.result?.isError);
});

test('Phase 2: X-Loop-Actor provides per-bot audit attribution & separate rate limits, and ?role= narrows access', async (t) => {
  const { base, cookie } = await setupServer(t);
  const ownerHeaders = { 'Content-Type': 'application/json', Cookie: cookie };

  // Create an agent with rateLimitPerMin: 2 shared by two bots
  const createRes = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ name: 'OpenMausBot Fleet', kind: 'openmausbot', rateLimitPerMin: 2 }),
  });
  assert.equal(createRes.status, 201);
  const { token, agent } = await createRes.json();

  // Bot A uses its 2 calls/min budget
  for (let i = 1; i <= 2; i += 1) {
    const r = await mcpPost(`${base}/mcp`, token, {
      jsonrpc: '2.0',
      id: i,
      method: 'tools/call',
      params: { name: 'loop__run', arguments: { tool: 'loop_utils__calc', arguments: { expression: `${i}+1` } } },
    }, { 'X-Loop-Actor': 'inbox-bot' });
    assert.equal(r.json.result.isError, false);
  }
  // Bot A's 3rd call hits its per-actor rate limit
  const botALimited = await mcpPost(`${base}/mcp`, token, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'loop__run', arguments: { tool: 'loop_utils__calc', arguments: { expression: '3+1' } } },
  }, { 'X-Loop-Actor': 'inbox-bot' });
  assert.equal(botALimited.json.result.isError, true);
  assert.match(botALimited.json.result.content[0].text, /rate limit/i);

  // Bot B sharing the exact same token still succeeds with its own bucket
  const botBOk = await mcpPost(`${base}/mcp`, token, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'loop__run', arguments: { tool: 'loop_utils__calc', arguments: { expression: '10+5' } } },
  }, { 'X-Loop-Actor': 'research-bot' });
  assert.equal(botBOk.json.result.isError, false);

  // Activity log filters cleanly by actor
  const actRes = await fetch(`${base}/api/activity?agent=${encodeURIComponent(agent.id)}&actor=research-bot`, {
    headers: { Cookie: cookie },
  });
  assert.equal(actRes.status, 200);
  const actJson = await actRes.json();
  assert.ok(actJson.entries.length >= 1);
  assert.ok(actJson.entries.every((e) => e.actor === 'research-bot'));

  // ?role=read-only narrows a full-access agent to read-only (blocks write tools)
  const writeBlocked = await mcpPost(`${base}/mcp?role=read-only`, token, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'loop__run', arguments: { tool: 'loop_notify__notify_owner', arguments: { message: 'hi' } } },
  });
  assert.equal(writeBlocked.json.result.isError, true);
  assert.match(writeBlocked.json.result.content[0].text, /read-only|access set/i);
});

test('Phase 2: data-driven named actions cover Gmail, Calendar, Slack, Linear, and GitHub', () => {
  const brokerConn = {
    id: 'composio',
    name: 'Composio',
    enabled: true,
    tools: [{ name: 'composio_multi_execute_tool' }],
  };
  const signIns = [
    { id: 's1', app: 'Gmail', accountLabel: 'Work', accountId: 'acc_gmail', state: 'ready' },
    { id: 's2', app: 'Calendar', accountLabel: 'Work', accountId: 'acc_cal', state: 'ready' },
    { id: 's3', app: 'Slack', accountLabel: 'Team', accountId: 'acc_slack', state: 'ready' },
    { id: 's4', app: 'Linear', accountLabel: 'Eng', accountId: 'acc_lin', state: 'ready' },
    { id: 's5', app: 'GitHub', accountLabel: 'Org', accountId: 'acc_gh', state: 'ready' },
  ];
  const actions = listNamedActionsForConnection(brokerConn, { appSignIns: signIns });
  const ids = actions.map((a) => a.id);
  assert.ok(ids.includes(`${GMAIL_SEARCH_ACTION_BASE}:acc_gmail`));
  assert.ok(ids.includes(`${CALENDAR_LIST_ACTION_BASE}:acc_cal`));
  assert.ok(ids.includes(`${SLACK_SEARCH_ACTION_BASE}:acc_slack`));
  assert.ok(ids.includes(`${LINEAR_LIST_ACTION_BASE}:acc_lin`));
  assert.ok(ids.includes(`${GITHUB_SEARCH_ACTION_BASE}:acc_gh`));
  assert.ok(actions.every((a) => a.annotations.readOnlyHint === true));

  const calAction = actions.find((a) => a.kind === 'calendar.list_events');
  const calCall = translateNamedActionCall(calAction, { query: 'standup', maxResults: 5 });
  assert.equal(calCall.ok, true);
  assert.equal(calCall.arguments.tools[0].tool_slug, 'GOOGLECALENDAR_EVENTS_LIST');
  assert.equal(calCall.arguments.tools[0].connected_account_id, 'acc_cal');

  const slackAction = actions.find((a) => a.kind === 'slack.search');
  const slackCall = translateNamedActionCall(slackAction, { query: 'deploy' });
  assert.equal(slackCall.ok, true);
  assert.equal(slackCall.arguments.tools[0].tool_slug, 'SLACK_SEARCH_MESSAGES');
  assert.equal(translateNamedActionCall(slackAction, { extra: 1 }).ok, false);

  const ghDirect = {
    id: 'gh',
    name: 'GitHub',
    enabled: true,
    tools: [{ name: 'search_issues', inputSchema: { properties: { q: { type: 'string' }, per_page: { type: 'integer' } } } }],
  };
  const ghActions = listNamedActionsForConnection(ghDirect);
  assert.equal(ghActions.length, 1);
  const ghCall = translateNamedActionCall(ghActions[0], { query: 'is:open', perPage: 3 });
  assert.equal(ghCall.ok, true);
  assert.deepEqual(ghCall.arguments, { q: 'is:open', per_page: 3 });
});
