import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BillingStore, loadBillingConfig, verifyStripeSignature } from '../lib/billing.mjs';
import { startServer } from '../server.mjs';

const tmpDirs = [];
function makeTmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'loop-billing-test-'));
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

describe('loadBillingConfig & verifyStripeSignature', () => {
  it('stays disabled when Stripe env vars are unset or malformed', () => {
    const empty = loadBillingConfig({});
    assert.equal(empty.enabled, false);
    assert.equal(empty.webhookEnabled, false);

    const bad = loadBillingConfig({
      STRIPE_SECRET_KEY: 'not_a_stripe_key',
      STRIPE_WEBHOOK_SECRET: 'bad_secret',
      STRIPE_PRO_PRICE_ID: 'bad_price',
    });
    assert.equal(bad.enabled, false);
    assert.equal(bad.webhookEnabled, false);
  });

  it('verifies valid Stripe HMAC-SHA256 signatures and rejects tampered/expired ones', () => {
    const secret = 'whsec_test_secret_123456';
    const now = 1_700_000_000;
    const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
    const { header } = signStripe(body, secret, now);

    assert.equal(verifyStripeSignature(body, header, secret, { nowSec: now }), true);

    // Supports multiple v1 signatures (secret rotation)
    const rotatedHeader = `t=${now},v1=${'0'.repeat(64)},${header.split(',')[1]}`;
    assert.equal(verifyStripeSignature(body, rotatedHeader, secret, { nowSec: now }), true);

    // Tampered payload
    assert.throws(
      () => verifyStripeSignature(body + ' ', header, secret, { nowSec: now }),
      /Invalid Stripe webhook signature/,
    );

    // Expired timestamp (> 5 min old)
    assert.throws(
      () => verifyStripeSignature(body, header, secret, { nowSec: now + 301 }),
      /outside tolerance window/,
    );

    // Missing or malformed header
    assert.throws(() => verifyStripeSignature(body, '', secret, { nowSec: now }), /Missing Stripe-Signature/);
    assert.throws(() => verifyStripeSignature(body, 't=abc,v1=xyz', secret, { nowSec: now }), /Malformed Stripe-Signature/);
  });
});

describe('BillingStore self-hosted vs hosted lifecycle', () => {
  it('unlocks all local features with no paywalls when self-hosted', async () => {
    const store = new BillingStore(makeTmpDir(), { env: {}, hosted: false });
    const status = await store.getWorkspaceStatus('local');
    assert.equal(status.selfHosted, true);
    assert.equal(status.billingEnabled, false);
    assert.equal(status.entitlements.unlimitedLocal, true);
    assert.equal(status.entitlements.limits.maxConnections, null);

    await assert.rejects(
      () => store.createCheckoutSession({ workspaceKey: 'local', origin: 'http://127.0.0.1:8799' }),
      /Billing is not enabled/,
    );
  });

  it('handles checkout, portal, webhooks, idempotency, and waitlist end-to-end over HTTP', async () => {
    const dataDir = makeTmpDir();
    const webhookSecret = 'whsec_test_http_secret';
    const stripeCalls = [];

    const mockFetch = async (url, init) => {
      stripeCalls.push({ url, method: init.method, body: init.body, auth: init.headers.Authorization });
      if (url.endsWith('/checkout/sessions')) {
        return new Response(JSON.stringify({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/billing_portal/sessions')) {
        return new Response(JSON.stringify({ id: 'bps_test_123', url: 'https://billing.stripe.com/p/session/bps_test_123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: { message: 'Unexpected URL' } }), { status: 404 });
    };

    const srv = await startServer({
      port: 0,
      dataDir,
      authMode: 'local-test',
      hosted: true,
      billingEnv: {
        STRIPE_SECRET_KEY: 'sk_test_mock_key_123456',
        STRIPE_WEBHOOK_SECRET: webhookSecret,
        STRIPE_PRO_PRICE_ID: 'price_pro_test_123',
        STRIPE_EXTRA_DEVICE_PRICE_ID: 'price_extra_dev_test_5',
      },
      billingFetch: mockFetch,
    });

    try {
      const base = `http://127.0.0.1:${srv.port}`;

      // Unauthenticated GET /api/billing is rejected
      const unauth = await fetch(`${base}/api/billing`);
      assert.equal(unauth.status, 401);

      // Sign in as local-test owner
      const setupRes = await fetch(`${base}/api/auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'test-password-1234' }),
      });
      assert.equal(setupRes.status, 200);
      const cookie = setupRes.headers.get('set-cookie').split(';')[0];

      // Initial hosted status without Loop Connect subscription
      const initial = await (await fetch(`${base}/api/billing`, { headers: { Cookie: cookie } })).json();
      assert.equal(initial.plan, 'free');
      assert.equal(initial.selfHosted, false);
      assert.equal(initial.billingEnabled, true);
      assert.equal(initial.loopConnectActive, false);
      assert.equal(initial.canManageBilling, false);
      assert.equal(initial.entitlements.limits.maxConnections, null);
      assert.equal(initial.entitlements.limits.maxDevices, 0);

      // Create checkout session
      const checkoutRes = await fetch(`${base}/api/billing/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ plan: 'pro' }),
      });
      assert.equal(checkoutRes.status, 200);
      const checkoutJson = await checkoutRes.json();
      assert.equal(checkoutJson.url, 'https://checkout.stripe.com/c/pay/cs_test_123');
      assert.equal(stripeCalls[0].auth, 'Bearer sk_test_mock_key_123456');
      assert.match(stripeCalls[0].body, /line_items%5B0%5D%5Bprice%5D=price_pro_test_123/);

      // Reject invalid webhook signature
      const badHook = await fetch(`${base}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=123,v1=' + 'a'.repeat(64) },
        body: JSON.stringify({ id: 'evt_bad', type: 'checkout.session.completed' }),
      });
      assert.equal(badHook.status, 400);

      // Deliver valid checkout.session.completed webhook
      const completedEvt = {
        id: 'evt_completed_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            customer: 'cus_test_001',
            subscription: 'sub_test_001',
            client_reference_id: 'local',
            metadata: { workspace_key: 'local', plan_id: 'pro' },
          },
        },
      };
      const signedCompleted = signStripe(completedEvt, webhookSecret);
      const hookOk = await fetch(`${base}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signedCompleted.header },
        body: signedCompleted.raw,
      });
      assert.equal(hookOk.status, 200);
      assert.equal((await hookOk.json()).duplicate, false);

      // Duplicate delivery is idempotent
      const hookDup = await fetch(`${base}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signedCompleted.header },
        body: signedCompleted.raw,
      });
      assert.equal(hookDup.status, 200);
      assert.equal((await hookDup.json()).duplicate, true);

      // Workspace is now Loop Connect (pro) with billing portal access and 2-device entitlement
      const proStatus = await (await fetch(`${base}/api/billing`, { headers: { Cookie: cookie } })).json();
      assert.equal(proStatus.plan, 'pro');
      assert.equal(proStatus.planName, 'Loop Connect');
      assert.equal(proStatus.loopConnectActive, true);
      assert.equal(proStatus.canManageBilling, true);
      assert.equal(proStatus.entitlements.features.loopConnect, true);
      assert.equal(proStatus.entitlements.features.cloudSync, true);
      assert.equal(proStatus.entitlements.limits.maxConnections, null);
      assert.equal(proStatus.entitlements.limits.maxDevices, 2);

      // Create billing portal session
      const portalRes = await fetch(`${base}/api/billing/portal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: '{}',
      });
      assert.equal(portalRes.status, 200);
      assert.equal((await portalRes.json()).url, 'https://billing.stripe.com/p/session/bps_test_123');

      // Subscription updated in Stripe Billing Portal with 2 extra devices syncs maxDevices = 4
      const updatedEvt = {
        id: 'evt_updated_extra_2',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_test_001',
            customer: 'cus_test_001',
            status: 'active',
            items: {
              data: [
                { id: 'si_base_1', price: { id: 'price_pro_test_123' }, quantity: 1 },
                { id: 'si_extra_1', price: { id: 'price_extra_dev_test_5' }, quantity: 2 },
              ],
            },
          },
        },
      };
      const signedUpdated = signStripe(updatedEvt, webhookSecret);
      const updRes = await fetch(`${base}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signedUpdated.header },
        body: signedUpdated.raw,
      });
      assert.equal(updRes.status, 200);
      const withExtras = await (await fetch(`${base}/api/billing`, { headers: { Cookie: cookie } })).json();
      assert.equal(withExtras.plan, 'pro');
      assert.equal(withExtras.extraDevices, 2);
      assert.equal(withExtras.entitlements.limits.maxDevices, 4);

      // Subscription deleted downgrades back to free and resets extraDevices to 0
      const deletedEvt = {
        id: 'evt_deleted_1',
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_test_001', customer: 'cus_test_001', status: 'canceled' } },
      };
      const signedDeleted = signStripe(deletedEvt, webhookSecret);
      const delRes = await fetch(`${base}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signedDeleted.header },
        body: signedDeleted.raw,
      });
      assert.equal(delRes.status, 200);
      const downgraded = await (await fetch(`${base}/api/billing`, { headers: { Cookie: cookie } })).json();
      assert.equal(downgraded.plan, 'free');
      assert.equal(downgraded.status, 'canceled');
      assert.equal(downgraded.extraDevices, 0);
      assert.equal(downgraded.entitlements.limits.maxDevices, 0);

      // Waitlist validation, join, and deduplication
      const badEmail = await fetch(`${base}/api/billing/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ email: 'not-an-email', plan: 'team' }),
      });
      assert.equal(badEmail.status, 400);

      const join1 = await (await fetch(`${base}/api/billing/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ email: 'Founder@Example.com', plan: 'team', teamSize: '10' }),
      })).json();
      assert.equal(join1.joined, true);
      assert.equal(join1.alreadyJoined, false);

      const join2 = await (await fetch(`${base}/api/billing/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ email: 'founder@example.com', plan: 'team', teamSize: '15' }),
      })).json();
      assert.equal(join2.joined, true);
      assert.equal(join2.alreadyJoined, true);
    } finally {
      await srv.close();
    }
  });
});
