import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { HOST_KINDS, hostSetup, hostSetupHtml, publicMcpEndpoint } from '../public/host-setup.js';
import { INSTALL_KINDS, kindLabel } from '../public/agent-mark.js';
import { AGENT_KINDS } from '../lib/store.mjs';
import { AgentHandoffStore, formatAgentHandoff, normalizeAgentKind } from '../lib/agent-handoff.mjs';

const url = 'https://loop.example.org/w/work/mcp?project=design';
test('host setup keeps an invite on its grant and never puts its key or claim code in a prompt', () => {
  for (const kind of HOST_KINDS) {
    assert.ok(AGENT_KINDS.includes(kind));
    assert.ok(!INSTALL_KINDS.includes(kind));
    assert.equal(normalizeAgentKind(kind), kind);
    const own = hostSetup(kind, url);
    const invite = hostSetup(kind, url, true);
    assert.equal(own.url, url);
    assert.equal(invite.url, url);
    assert.doesNotMatch(invite.prompt, /authorize|sign in/i);
    assert.doesNotMatch(hostSetupHtml(invite, String), /connect\.mjs|Terminal|Register automatically/);
    const handoff = formatAgentHandoff({ id: 'fake', agentKind: kind, expiresAt: Date.now() }, 'FIXTURE', 'https://loop.example.org');
    assert.equal(handoff.cliCommand, null);
    assert.equal(handoff.onePrompt, null);
    assert.equal(handoff.inviteUrl, 'https://loop.example.org/a/fake#FIXTURE');
    assert.notEqual(kindLabel(kind), 'Other');
  }
  const grok = hostSetup('grok-bot', url);
  assert.equal(new URL(grok.open).searchParams.get('text'), grok.prompt);
  assert.match(grok.steps, /Every Bot/);
  assert.equal(kindLabel('muse'), 'Muse Code');
  assert.equal(normalizeAgentKind('', 'Claude Duet'), 'claude-duet');
});

test('short-lived agent-generated hosted invitations reveal the approved scope only with the private code', () => {
  const store = new AgentHandoffStore();
  const ticket = store.create({ name: 'Private Muse', agentKind: 'meta-muse', profile: 'design', canManage: false, origin: 'https://loop.example.org' });
  const params = { id: ticket.id, claimCode: ticket.claimCode };
  assert.throws(() => store.peekLink({ ...params, claimCode: 'wrong' }));
  const preview = store.peekLink(params);
  assert.equal(preview.pendingAgent.profile, 'design');
  assert.equal(preview.pendingAgent.canManage, false);
  assert.equal(preview.claimed, false);
  assert.equal(store.claim(params).profile, 'design');
  assert.throws(() => store.claim(params));
  store.recordClaimedAgent(ticket.id, 'synthetic-agent');
  assert.equal(store.peekLink(params).agentId, 'synthetic-agent');
});

test('a hosted setup never substitutes another workspace for a local or credential-bearing URL', () => {
  for (const endpoint of ['http://127.0.0.1:8799/mcp', 'https://server.local/mcp', 'https://192.168.0.4/mcp',
    'https://127.0.0.1/mcp', 'https://user:secret@host.example.org/mcp', 'https://host.example.org/mcp?token=fake',
    'https://host.example.org/a/id#claim']) {
    assert.equal(publicMcpEndpoint(endpoint), '');
    assert.equal(hostSetup('grok-bot', endpoint, true), null);
  }
  assert.match(hostSetup('claude-duet', url).auth, /Register automatically/);
  assert.match(hostSetup('openbot', url).auth, /Leave Key empty/);
  assert.match(hostSetup('openbot', url, true).auth, /whole team/);
});

test('a Grok invite stays on its original grant until the recipient explicitly claims the key', async (t) => {
  const { document } = parseHTML('<html><body><main id="card"></main><footer id="foot"></footer></body></html>');
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.id, 'abcd567890');
    assert.equal(body.claimCode, 'fixture-code');
    if (_url.endsWith('/preview')) return Response.json({
      mcpUrl: url, from: 'Fixture owner', agent: { kind: 'grok-bot', name: 'Fixture', connectionCount: 0, skillCount: 0, memoryAccess: 'none' },
    });
    if (_url.endsWith('/status')) return Response.json({ claimed: true, connected: true });
    assert.ok(_url.endsWith('/claim'));
    assert.equal(body.clientId, 'grok-bot');
    return Response.json({ mcp_url: url, access_token: 'fixture-key' });
  });
  globalThis.document = document;
  globalThis.location = { pathname: '/a/abcd567890', hash: '#fixture-code' };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  try {
    await import('../public/agent-link.js?host-setup-test');
    await tick();
    document.querySelector('[data-do="host"]').click();
    const link = document.querySelector('a[href^="https://cursor.com/grok-bot/link/v1/prompt?"]');
    assert.ok(link);
    assert.doesNotMatch(link.getAttribute('href'), /fixture-code|fixture-key/);
    assert.equal(fetch.mock.callCount(), 1);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    document.querySelector('[data-do="claim-host"]').click();
    await tick();
    assert.equal(fetch.mock.callCount(), 2);
    assert.ok(document.querySelector('[data-host-copy="key"]'));
    assert.doesNotMatch(document.body.innerHTML, /Register automatically|connect\.mjs|fixture-key/);
    t.mock.timers.tick(2500);
    await tick();
    assert.match(document.querySelector('h1').textContent, /connected/);
  } finally {
    delete globalThis.document;
    delete globalThis.location;
  }
});
