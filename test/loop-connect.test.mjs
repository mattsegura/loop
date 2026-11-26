import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { hasLoopConnectAccess } from '../lib/billing.mjs';
import {
  buildRelayUrl,
  ConnectTokenRouter,
  hashConnectToken,
  isRelayConnection,
  LoopConnectServer,
  LoopConnectClient,
  parseRelayUrl,
  validateCloudOrigin,
} from '../lib/loop-connect.mjs';
import { Vault } from '../lib/vault.mjs';
import { SkillStore } from '../lib/skills.mjs';

const tmpDirs = [];
function makeTmpDir(prefix = 'loop-connect-test-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function signStripe(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const sig = createHmac('sha256', secret).update(`${timestamp}.${raw}`, 'utf8').digest('hex');
  return { raw, header: `t=${timestamp},v1=${sig}` };
}

function makeFakeClerk(users = ['owner', 'friend']) {
  const frontendApi = 'https://loop-connect.clerk.accounts.dev';
  return {
    publishableKey: 'pk_test_fixture',
    frontendApi,
    async verifyRequest(req) {
      const u = req.headers['x-fixture-auth'];
      if (!u || !users.includes(u)) return null;
      return {
        userId: `user_${u}`,
        sessionId: `sess_${u}`,
        issuer: frontendApi,
        expiresAt: Date.now() + 60_000,
      };
    },
  };
}

async function setupLocalOwner(base, password = 'local-owner-password-123') {
  const res = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

async function createLocalStdioServerScript(dir) {
  const scriptPath = path.join(dir, 'device1-stdio-mcp.mjs');
  writeFileSync(
    scriptPath,
    `
import readline from 'node:readline';
const write = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    return write({
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'device1-local-notes', version: '1.0.0' },
      },
    });
  }
  if (msg.method === 'tools/list') {
    return write({
      id: msg.id,
      result: {
        tools: [{
          name: 'read_local_note',
          description: 'Reads a note stored on Device 1.',
          annotations: { readOnlyHint: true, destructiveHint: false },
          inputSchema: {
            type: 'object',
            properties: { topic: { type: 'string' } },
            required: ['topic'],
          },
        }],
      },
    });
  }
  if (msg.method === 'tools/call' && msg.params?.name === 'read_local_note') {
    return write({
      id: msg.id,
      result: {
        content: [{ type: 'text', text: 'Device1-Note:' + String(msg.params.arguments?.topic || '') }],
      },
    });
  }
  return write({ id: msg.id, result: {} });
});
`,
    'utf8',
  );
  return scriptPath;
}

describe('Loop (Free Local-Only) vs Loop Connect (Paid Cloud + 2 Connected Devices)', () => {
  it('validates Loop Cloud origins strictly (HTTPS required unless loopback allowed)', () => {
    assert.equal(validateCloudOrigin('https://useloop.sh/some/path'), 'https://useloop.sh');
    assert.throws(() => validateCloudOrigin(''), /required/);
    assert.throws(() => validateCloudOrigin('not a url'), /Invalid Loop Cloud URL/);
    assert.throws(() => validateCloudOrigin('http://useloop.sh'), /must use https/);
    assert.throws(() => validateCloudOrigin('https://user:pass@useloop.sh'), /must not contain credentials/);
    assert.throws(() => validateCloudOrigin('http://127.0.0.1:8799', { allowLoopbackHttp: false }), /must use https/);
    assert.equal(validateCloudOrigin('http://127.0.0.1:8799', { allowLoopbackHttp: true }), 'http://127.0.0.1:8799');
  });

  it('covers relay URL helpers, hasLoopConnectAccess, ConnectTokenRouter cold rescan, and offline device errors', async () => {
    const devId = 'dev_0123456789abcdef';
    const relayUrl = buildRelayUrl(devId, 'mac_notes');
    assert.equal(relayUrl, 'https://relay.useloop.sh/d/dev_0123456789abcdef/mac_notes');
    assert.deepEqual(parseRelayUrl(relayUrl), { deviceId: devId, connId: 'mac_notes' });
    assert.equal(parseRelayUrl('https://mcp.linear.app/mcp'), null);
    assert.equal(isRelayConnection({ transport: 'http', url: relayUrl }), true);
    assert.equal(isRelayConnection({ transport: 'stdio', command: 'node' }), false);

    // hasLoopConnectAccess edge cases
    assert.equal(hasLoopConnectAccess(null), true);
    assert.equal(hasLoopConnectAccess({ billingEnabled: false }), true);
    assert.equal(hasLoopConnectAccess({ billingEnabled: true, selfHosted: true }), false);
    assert.equal(hasLoopConnectAccess({ billingEnabled: true, entitlements: { features: { loopConnect: false } } }), false);
    assert.equal(
      hasLoopConnectAccess({ billingEnabled: true, entitlements: { features: { loopConnect: false } } }, { invited: true }),
      true,
    );
    assert.equal(hasLoopConnectAccess({ billingEnabled: true, entitlements: { features: { loopConnect: true } } }), true);

    // ConnectTokenRouter cold rescan & malformed token rejection
    const baseDir = makeTmpDir('loop-router-unit-');
    const tok = `lpc_${'A'.repeat(43)}`;
    writeFileSync(
      path.join(baseDir, 'loop-connect-devices.json'),
      JSON.stringify({ version: 1, devices: [{ id: devId, name: 'Test Mac', tokenHash: hashConnectToken(tok) }] }),
      'utf8',
    );
    const router = new ConnectTokenRouter(baseDir, { rescanMs: 0 });
    assert.equal(await router.resolve('bad_token'), null);
    assert.deepEqual(await router.resolve(tok), { workspaceKey: 'local', deviceId: devId });

    // Offline device error message when device has not polled within grace window
    const offlineDir = makeTmpDir('loop-offline-relay-');
    writeFileSync(
      path.join(offlineDir, 'loop-connect-devices.json'),
      JSON.stringify({
        version: 1,
        devices: [
          {
            id: devId,
            name: 'Sleeping Laptop',
            tokenHash: hashConnectToken(tok),
            lastSeenAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          },
        ],
      }),
      'utf8',
    );
    const lcSrv = new LoopConnectServer(offlineDir, { relayCallTimeoutMs: 200 });
    const dispatcher = lcSrv.createHostedRelayDispatcher(offlineDir);
    await assert.rejects(
      () => dispatcher.callTool({ transport: 'http', url: relayUrl }, 'read_local_note', {}),
      /Device "Sleeping Laptop" is currently offline/,
    );
    lcSrv.close();
  });

  it('runs 100% standalone locally by default with zero Clerk config and zero cloud connections', async () => {
    const prevKey = process.env.CLERK_PUBLISHABLE_KEY;
    const prevHosted = process.env.LOOP_HOSTED;
    delete process.env.CLERK_PUBLISHABLE_KEY;
    delete process.env.LOOP_HOSTED;

    const dataDir = makeTmpDir('loop-standalone-local-');
    const srv = await startServer({ port: 0, dataDir, detectLocalAgents: false });
    try {
      const base = `http://127.0.0.1:${srv.port}`;

      // Local password mode works out of the box with no Clerk publishable key
      const st0 = await (await fetch(`${base}/api/auth/status`)).json();
      assert.deepEqual(st0, { setUp: false, signedIn: false });

      // Unauthenticated local connect API is protected
      assert.equal((await fetch(`${base}/api/local/connect`)).status, 401);

      const cookie = await setupLocalOwner(base);

      // Billing reports selfHosted local mode with unlimited connections & agents
      const billing = await (await fetch(`${base}/api/billing`, { headers: { Cookie: cookie } })).json();
      assert.equal(billing.selfHosted, true);
      assert.equal(billing.planName, 'Loop (Local)');
      assert.equal(billing.entitlements.unlimitedLocal, true);
      assert.equal(billing.entitlements.limits.maxConnections, null);
      assert.equal(billing.entitlements.limits.maxAgents, null);
      assert.equal(billing.entitlements.limits.maxDevices, 1);

      // Loop Connect is NOT linked by default — completely local-only
      const lc = await (await fetch(`${base}/api/local/connect`, { headers: { Cookie: cookie } })).json();
      assert.equal(lc.linked, false);
    } finally {
      await srv.close();
      if (prevKey !== undefined) process.env.CLERK_PUBLISHABLE_KEY = prevKey;
      if (prevHosted !== undefined) process.env.LOOP_HOSTED = prevHosted;
    }
  });

  it('gates hosted Loop Cloud (/mcp, shares, device pairing) behind Loop Connect or an invite, then syncs & relays across 2 devices', async () => {
    const webhookSecret = 'whsec_loop_connect_e2e_secret';
    const cloudDir = makeTmpDir('loop-cloud-');
    const dev1Dir = makeTmpDir('loop-dev1-');
    const dev2Dir = makeTmpDir('loop-dev2-');
    const dev3Dir = makeTmpDir('loop-dev3-');
    const stdioScript = await createLocalStdioServerScript(dev1Dir);

    const stripeCalls = [];
    const mockBillingFetch = async (url, init = {}) => {
      stripeCalls.push({ url, method: init.method || 'GET', body: init.body || '' });
      if (url.endsWith('/subscriptions/sub_lc_owner') && (init.method || 'GET') === 'GET') {
        return new Response(JSON.stringify({ id: 'sub_lc_owner', items: { data: [{ id: 'si_base_pro', price: { id: 'price_loop_connect_123' }, quantity: 1 }] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/subscription_items') && init.method === 'POST') {
        return new Response(JSON.stringify({ id: 'si_extra_dev_1', quantity: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/subscription_items/si_extra_dev_1') && init.method === 'DELETE') {
        return new Response(JSON.stringify({ id: 'si_extra_dev_1', deleted: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/subscription_items/si_extra_dev_1') && init.method === 'POST') {
        return new Response(JSON.stringify({ id: 'si_extra_dev_1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: { message: 'Unexpected Stripe URL' } }), { status: 404 });
    };

    const cloudSrv = await startServer({
      port: 0,
      dataDir: cloudDir,
      hosted: true,
      detectLocalAgents: false,
      clerkApp: makeFakeClerk(['owner', 'friend']),
      relayPollHoldMs: 400,
      relayCallTimeoutMs: 5000,
      billingFetch: mockBillingFetch,
      billingEnv: {
        STRIPE_SECRET_KEY: 'sk_test_loop_connect_123456',
        STRIPE_WEBHOOK_SECRET: webhookSecret,
        STRIPE_PRO_PRICE_ID: 'price_loop_connect_123',
        STRIPE_EXTRA_DEVICE_PRICE_ID: 'price_extra_device_5usd',
      },
    });

    const dev1Srv = await startServer({
      port: 0,
      dataDir: dev1Dir,
      detectLocalAgents: false,
      relayPollWaitMs: 300,
    });
    const dev2Srv = await startServer({
      port: 0,
      dataDir: dev2Dir,
      detectLocalAgents: false,
      relayPollWaitMs: 300,
    });
    const dev3Srv = await startServer({
      port: 0,
      dataDir: dev3Dir,
      detectLocalAgents: false,
      relayPollWaitMs: 300,
    });

    try {
      const cloudBase = `http://127.0.0.1:${cloudSrv.port}`;
      const dev1Base = `http://127.0.0.1:${dev1Srv.port}`;
      const dev2Base = `http://127.0.0.1:${dev2Srv.port}`;
      const dev3Base = `http://127.0.0.1:${dev3Srv.port}`;
      const ownerHeaders = { 'X-Fixture-Auth': 'owner', 'Content-Type': 'application/json' };

      // Touch hosted owner workspace so it exists
      const ownerAuth = await (await fetch(`${cloudBase}/api/auth/status`, { headers: ownerHeaders })).json();
      assert.equal(ownerAuth.signedIn, true);
      assert.equal(ownerAuth.workspace, 'personal');

      // Mint a cloud agent key and profile on the hosted workspace before subscribing
      await fetch(`${cloudBase}/api/profiles`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ id: 'work', name: 'Work' }),
      });
      const cloudAgentRes = await (
        await fetch(`${cloudBase}/api/agents`, {
          method: 'POST',
          headers: ownerHeaders,
          body: JSON.stringify({ name: 'Cloud Agent', kind: 'claude', profile: 'all', canManage: false }),
        })
      ).json();
      const cloudAgentToken = cloudAgentRes.token;
      assert.match(cloudAgentToken, /^loop_/);

      // 1. BEFORE paying for Loop Connect:
      // - Hosted /mcp returns 402 Payment Required
      const blockedMcp = await fetch(`${cloudBase}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cloudAgentToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
        }),
      });
      assert.equal(blockedMcp.status, 402);

      // - Hosted POST /api/shares returns 402 Payment Required
      const blockedShare = await fetch(`${cloudBase}/api/shares`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ profile: 'work', kind: 'me', ownerName: 'Matt' }),
      });
      assert.equal(blockedShare.status, 402);

      // - Hosted POST /api/connect/pair-code returns 402 Payment Required
      const blockedPair = await fetch(`${cloudBase}/api/connect/pair-code`, {
        method: 'POST',
        headers: ownerHeaders,
        body: '{}',
      });
      assert.equal(blockedPair.status, 402);

      // - Invited user ('friend') unlocks Loop Connect via an invite claim!
      const ownerInvite = await (await fetch(`${cloudBase}/api/invites/mine`, { headers: ownerHeaders })).json();
      const friendHeaders = { 'X-Fixture-Auth': 'friend', 'Content-Type': 'application/json' };
      const claimRes = await fetch(`${cloudBase}/api/invites/claim`, {
        method: 'POST',
        headers: friendHeaders,
        body: JSON.stringify({ t: ownerInvite.slug }),
      });
      assert.equal(claimRes.status, 200);
      const friendBilling = await (await fetch(`${cloudBase}/api/billing`, { headers: friendHeaders })).json();
      assert.equal(friendBilling.invited, true);
      assert.equal(friendBilling.loopConnectActive, true);
      assert.equal(friendBilling.entitlements.limits.maxDevices, 2);

      // 2. Owner upgrades to Loop Connect ($12/mo) via Stripe webhook
      // Discover owner's workspaceId from the invite store file so we deliver the exact Stripe webhook
      const invitesOnDisk = JSON.parse(readFileSync(path.join(cloudDir, 'invites.json'), 'utf8'));
      const ownerWorkspaceKey = Object.keys(invitesOnDisk.byWorkspace)[0];
      assert.match(ownerWorkspaceKey, /^[0-9a-f]{64}$/);

      const completedEvt = {
        id: 'evt_loop_connect_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            customer: 'cus_lc_owner',
            subscription: 'sub_lc_owner',
            client_reference_id: ownerWorkspaceKey,
            metadata: { workspace_key: ownerWorkspaceKey, plan_id: 'pro' },
          },
        },
      };
      const signedEvt = signStripe(completedEvt, webhookSecret);
      const hookRes = await fetch(`${cloudBase}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signedEvt.header },
        body: signedEvt.raw,
      });
      assert.equal(hookRes.status, 200);

      // Hosted /mcp now works immediately!
      const okMcp = await fetch(`${cloudBase}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cloudAgentToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
        }),
      });
      assert.equal(okMcp.status, 200);

      // 3. Account-wide items (Vault, Cloud MCP, Skills, Memory) live directly in Loop Cloud (single source of truth).
      // Device 1 keeps only its own local `stdio` tool (`Mac Notes`).
      const dev1Cookie = await setupLocalOwner(dev1Base);
      const dev1Headers = { Cookie: dev1Cookie, 'Content-Type': 'application/json' };

      assert.equal(
        (
          await fetch(`${cloudBase}/api/vault`, {
            method: 'POST',
            headers: ownerHeaders,
            body: JSON.stringify({
              key: 'LINEAR_TOKEN',
              value: 'lin_api_secret_value_987654321',
              description: 'Linear API key',
              type: 'api_key',
              allowedSinks: ['https://mcp.linear.app'],
            }),
          })
        ).status,
        201,
      );

      const addRemoteRes = await fetch(`${cloudBase}/api/mcps`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({
          name: 'Linear Cloud',
          transport: 'http',
          url: 'https://mcp.linear.app/mcp',
          headers: { Authorization: 'Bearer {{vault:LINEAR_TOKEN}}' },
          skipSync: true,
        }),
      });
      assert.equal(addRemoteRes.status, 201);

      const addStdioRes = await fetch(`${dev1Base}/api/mcps`, {
        method: 'POST',
        headers: dev1Headers,
        body: JSON.stringify({
          name: 'Mac Notes',
          profiles: ['studio'],
          transport: 'stdio',
          command: process.execPath,
          args: [stdioScript],
        }),
      });
      assert.equal(addStdioRes.status, 201);
      const stdioConn = (await addStdioRes.json()).mcp;
      // Sync local stdio connection so its `read_local_note` tool schema is populated on Device 1
      const syncStdioRes = await fetch(`${dev1Base}/api/mcps/${stdioConn.id}/sync`, {
        method: 'POST',
        headers: dev1Headers,
      });
      assert.equal(syncStdioRes.status, 200);

      await new SkillStore(path.join(cloudDir, 'user-workspaces', ownerWorkspaceKey)).saveSkillMarkdown('release-checklist', {
        name: 'Release Checklist',
        description: 'Steps to cut a release',
        content: '# Release Checklist\n1. Run npm test',
      });

      assert.equal(
        (
          await fetch(`${cloudBase}/api/memory`, {
            method: 'POST',
            headers: ownerHeaders,
            body: JSON.stringify({
              key: 'preferred-package-manager',
              content: 'Always use npm in the Loop repository.',
              scope: 'preference',
            }),
          })
        ).status,
        201,
      );

      // 4. Pair Device 1 with Loop Connect — publishes Device 1's local stdio catalog to Loop Cloud (no multi-device sync)
      const pair1 = await (
        await fetch(`${cloudBase}/api/connect/pair-code`, { method: 'POST', headers: ownerHeaders, body: '{}' })
      ).json();
      assert.match(pair1.code, /^LP-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

      const link1Res = await fetch(`${dev1Base}/api/local/connect/link`, {
        method: 'POST',
        headers: dev1Headers,
        body: JSON.stringify({
          cloudUrl: cloudBase,
          code: pair1.code,
          deviceName: 'MacBook Pro',
        }),
      });
      assert.equal(link1Res.status, 200);
      const link1 = await link1Res.json();
      assert.equal(link1.linked, true);
      assert.equal(link1.deviceName, 'MacBook Pro');
      assert.equal('token' in link1, false, 'Device token must never be exposed in status JSON');
      const stateOnDisk = readFileSync(path.join(dev1Dir, 'loop-connect.json'), 'utf8');
      assert.equal(stateOnDisk.includes('lpc_'), false, 'Device token must never be stored in loop-connect.json');

      // Retired multi-device sync route returns 426 SYNC_RETIRED
      const retiredSync = await fetch(`${cloudBase}/api/connect/sync/v2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(retiredSync.status, 426);
      assert.equal((await retiredSync.json()).code, 'SYNC_RETIRED');

      // Re-using a single-use pairing code fails with 400
      const dev2Cookie = await setupLocalOwner(dev2Base);
      const dev2Headers = { Cookie: dev2Cookie, 'Content-Type': 'application/json' };
      const reusedRes = await fetch(`${dev2Base}/api/local/connect/link`, {
        method: 'POST',
        headers: dev2Headers,
        body: JSON.stringify({ cloudUrl: cloudBase, code: pair1.code, deviceName: 'Mac Studio' }),
      });
      assert.equal(reusedRes.status, 400);

      // 5. Pair Device 2 (Mac Studio)
      const pair2 = await (
        await fetch(`${cloudBase}/api/connect/pair-code`, { method: 'POST', headers: ownerHeaders, body: '{}' })
      ).json();
      const link2Res = await fetch(`${dev2Base}/api/local/connect/link`, {
        method: 'POST',
        headers: dev2Headers,
        body: JSON.stringify({
          cloudUrl: cloudBase,
          code: pair2.code,
          deviceName: 'Mac Studio',
        }),
      });
      assert.equal(link2Res.status, 200);

      // Verify Loop Cloud holds Linear Cloud, Mac Notes (MacBook Pro) relay, Release Checklist skill, Memory, and LINEAR_TOKEN secret!
      const cloudMcps = (await (await fetch(`${cloudBase}/api/mcps`, { headers: ownerHeaders })).json()).mcps;
      assert.ok(cloudMcps.some((m) => m.url === 'https://mcp.linear.app/mcp'), 'Linear Cloud lives directly in Loop Cloud');
      const relayedOnCloud = cloudMcps.find((m) => m.url.startsWith('https://relay.useloop.sh/d/'));
      assert.ok(relayedOnCloud, 'Device 1 local stdio connection published as relay in Loop Cloud');
      assert.equal(relayedOnCloud.tools[0]?.name, 'read_local_note');

      const cloudSkills = (await (await fetch(`${cloudBase}/api/skills`, { headers: ownerHeaders })).json()).skills;
      assert.ok(cloudSkills.some((s) => s.id === 'release-checklist'), 'Skill lives in Loop Cloud');

      const cloudMemories = (await (await fetch(`${cloudBase}/api/memory`, { headers: ownerHeaders })).json()).memories;
      assert.ok(cloudMemories.some((m) => m.content.includes('Always use npm')), 'Memory lives in Loop Cloud');

      const cloudVault = (await (await fetch(`${cloudBase}/api/vault`, { headers: ownerHeaders })).json()).secrets;
      assert.ok(cloudVault.some((s) => s.key === 'LINEAR_TOKEN'), 'Vault secret lives in Loop Cloud');
      assert.equal(JSON.stringify(cloudVault).includes('lin_api_secret_value_987654321'), false, 'Secret value never exposed');

      // Device 2 reads saved ToolSetups from Loop Cloud without copying Device 1's local workspace
      const dev2Setups = (await (await fetch(`${dev2Base}/api/local/tool-setups`, { headers: dev2Headers })).json()).setups;
      assert.ok(dev2Setups.some((s) => s.name === 'Mac Notes'), 'Device 2 sees Mac Notes setup from Loop Cloud');

      // 6. Enforce 2-Device Base Limit: trying to pair a 3rd device prompts to add an extra device slot (+$5/mo)
      const blocked3rdCode = await fetch(`${cloudBase}/api/connect/pair-code`, {
        method: 'POST',
        headers: ownerHeaders,
        body: '{}',
      });
      assert.equal(blocked3rdCode.status, 403);
      const blocked3rdJson = await blocked3rdCode.json();
      assert.equal(blocked3rdJson.code, 'DEVICE_LIMIT_REACHED');
      assert.equal(blocked3rdJson.maxDevices, 2);
      assert.equal(blocked3rdJson.canAddDeviceSlot, true);
      assert.equal(blocked3rdJson.extraDevicePriceMonthly, 5);

      // 7. Live Cross-Device Execution: a Loop Cloud agent calls Device 1's local `stdio` tool (`read_local_note`)!
      const cloudDirectAgentRes = await (
        await fetch(`${cloudBase}/api/agents`, {
          method: 'POST',
          headers: ownerHeaders,
          body: JSON.stringify({ name: 'Cloud Relay Agent', kind: 'codex', profile: 'all', mode: 'direct' }),
        })
      ).json();
      const cloudDirectToken = cloudDirectAgentRes.token;

      const callRelayRes = await fetch(`${cloudBase}/mcp?mode=direct`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cloudDirectToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: `${relayedOnCloud.id}__read_local_note`,
            arguments: { topic: 'roadmap' },
          },
        }),
      });
      assert.equal(callRelayRes.status, 200);
      const callRelayJson = await callRelayRes.json();
      assert.equal(callRelayJson.result?.content?.[0]?.text, 'Device1-Note:roadmap');

      // 8. Purchase +1 Additional Device Slot (+$5/mo) via POST /api/billing/devices -> raises maxDevices to 3!
      // A forwarded argument can be echoed by the tool. Both relay hops must return a masked success.
      const paired = new LoopConnectClient({ dataDir: dev2Dir, vault: new Vault(dev2Dir) });
      const dispatch = paired.createLocalRelayDispatcher();
      const masked = await dispatch.callTool(relayedOnCloud, 'read_local_note', { topic: 'fixture-private-topic' },
        { extraSecrets: ['fixture-private-topic'] });
      assert.match(masked.content[0].text, /Device1-Note/);
      assert.equal(JSON.stringify(masked).includes('fixture-private-topic'), false);
      const moveProfile = (profiles) => fetch(dev1Base + '/api/mcps/' + stdioConn.id, {
        method: 'PATCH', headers: dev1Headers, body: JSON.stringify({ profiles }),
      });
      assert.equal((await moveProfile(['work'])).status, 200);
      await assert.rejects(dispatch.callTool(relayedOnCloud, 'read_local_note', { topic: 'fixture' }, { profile: 'studio' }));
      assert.equal((await moveProfile(['studio'])).status, 200);
      await paired.close();

      async function searchTools() {
        const res = await fetch(cloudBase + '/mcp', { method: 'POST',
          headers: { Authorization: 'Bearer ' + cloudDirectToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
            name: 'loop__search', arguments: { type: 'tools', connection: relayedOnCloud.id },
          } }),
        });
        assert.equal(res.status, 200);
        return JSON.parse((await res.json()).result.content[0].text).tools.map((t) => t.tool);
      }
      const relayTool = relayedOnCloud.id + '__read_local_note';
      assert.ok((await searchTools()).includes(relayTool));
      for (const enabled of [false, true]) {
        const toggled = await fetch(dev1Base + '/api/mcps/' + stdioConn.id + '/tools/toggle', {
          method: 'POST', headers: dev1Headers, body: JSON.stringify({ toolName: 'read_local_note', enabled }),
        });
        assert.equal(toggled.status, 200);
        assert.equal((await searchTools()).includes(relayTool), enabled);
      }

      const addSlotRes = await fetch(`${cloudBase}/api/billing/devices`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ delta: 1 }),
      });
      assert.equal(addSlotRes.status, 200);
      const addSlotJson = await addSlotRes.json();
      assert.equal(addSlotJson.extraDevices, 1);
      assert.equal(addSlotJson.entitlements.limits.maxDevices, 3);
      assert.ok(stripeCalls.some((c) => c.url.endsWith('/subscription_items') && c.body.includes('price=price_extra_device_5usd')));

      // Now Device 3 (Linux Devbox) pairs concurrently alongside Device 1 & Device 2 (3/3 devices active!)
      const dev3Cookie = await setupLocalOwner(dev3Base);
      const dev3Headers = { Cookie: dev3Cookie, 'Content-Type': 'application/json' };
      const pair3 = await (
        await fetch(`${cloudBase}/api/connect/pair-code`, { method: 'POST', headers: ownerHeaders, body: '{}' })
      ).json();
      assert.equal(
        (
          await fetch(`${dev3Base}/api/local/connect/link`, {
            method: 'POST',
            headers: dev3Headers,
            body: JSON.stringify({ cloudUrl: cloudBase, code: pair3.code, deviceName: 'Linux Devbox' }),
          })
        ).status,
        200,
      );

      // Cannot lower extra device slots while all 3 slots are actively paired (400 DEVICES_IN_USE)
      const blockedShrink = await fetch(`${cloudBase}/api/billing/devices`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ delta: -1 }),
      });
      assert.equal(blockedShrink.status, 400);
      assert.match((await blockedShrink.json()).error, /Disconnect 1 paired device/);

      // Disconnect Device 2 -> revokes Device 2's token (401) and allows removing the extra device slot cleanly
      const devicesList = (await (await fetch(`${cloudBase}/api/connect/devices`, { headers: ownerHeaders })).json()).devices;
      assert.equal(devicesList.length, 3);
      const dev2Rec = devicesList.find((d) => d.name === 'Mac Studio');
      assert.ok(dev2Rec);

      const delRes = await fetch(`${cloudBase}/api/connect/devices/${dev2Rec.id}`, {
        method: 'DELETE',
        headers: ownerHeaders,
      });
      assert.equal(delRes.status, 200);

      // Device 2 sync now fails with 401
      const revokedSync = await fetch(`${dev2Base}/api/local/connect/sync`, {
        method: 'POST',
        headers: dev2Headers,
        body: '{}',
      });
      assert.equal(revokedSync.status, 401);

      // Removing the unused extra device slot now succeeds and deletes the Stripe subscription item
      const shrinkOk = await fetch(`${cloudBase}/api/billing/devices`, {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ delta: -1 }),
      });
      assert.equal(shrinkOk.status, 200);
      const shrinkJson = await shrinkOk.json();
      assert.equal(shrinkJson.extraDevices, 0);
      assert.equal(shrinkJson.entitlements.limits.maxDevices, 2);
      assert.ok(stripeCalls.some((c) => c.url.endsWith('/subscription_items/si_extra_dev_1') && c.method === 'DELETE'));

      // 9. Canceling Loop Connect subscription locks hosted /mcp & cloud sync (402), while Device 1 local Loop stays 100% functional
      const canceledEvt = {
        id: 'evt_loop_connect_cancel_1',
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_lc_owner', customer: 'cus_lc_owner', status: 'canceled' } },
      };
      const signedCancel = signStripe(canceledEvt, webhookSecret);
      await fetch(`${cloudBase}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signedCancel.header },
        body: signedCancel.raw,
      });

      const canceledSync = await fetch(`${dev1Base}/api/local/connect/sync`, {
        method: 'POST',
        headers: dev1Headers,
        body: '{}',
      });
      assert.equal(canceledSync.status, 402);

      // Unlinking Device 1 works cleanly and local connections still work locally
      assert.equal(
        (await fetch(`${dev1Base}/api/local/connect`, { method: 'DELETE', headers: dev1Headers })).status,
        200,
      );
      const dev1LocalMcps = (await (await fetch(`${dev1Base}/api/mcps`, { headers: dev1Headers })).json()).mcps;
      assert.ok(dev1LocalMcps.some((m) => m.name === 'Mac Notes'), 'Local connections remain intact on Device 1');
    } finally {
      await Promise.all([dev1Srv.close(), dev2Srv.close(), dev3Srv.close(), cloudSrv.close()]);
    }
  });
});
