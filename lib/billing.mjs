// Env-gated Stripe billing, plan entitlements, and Teams/Enterprise waitlist.
// Self-hosted local deployments never hit paywalls when Stripe is not configured.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, createWriteQueue, readJsonWithBackup } from './json-file-store.mjs';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const DEFAULT_WEBHOOK_TOLERANCE_SEC = 300;
const MAX_PROCESSED_EVENTS = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const DEFAULT_CONNECT_MAX_DEVICES = 2;
export const EXTRA_DEVICE_PRICE_MONTHLY = 5;
export const MAX_EXTRA_DEVICES = 50;

export const PLANS = Object.freeze({
  free: Object.freeze({
    id: 'free',
    name: 'Loop (Local)',
    priceMonthly: 0,
    summary: 'Free forever on 1 local device (127.0.0.1) under AGPL-3.0. Unlimited local connections and agents, local-only.',
    hostedLimits: Object.freeze({
      maxConnections: null,
      maxAgents: null,
      maxDevices: 0,
      activityRetentionDays: 7,
    }),
    features: Object.freeze({
      cloudAccess: false,
      loopConnect: false,
      cloudSync: false,
      managedOAuth: false,
      remoteApprovals: false,
      teamWorkspaces: false,
      ssoSaml: false,
      commercialLicense: false,
    }),
  }),
  pro: Object.freeze({
    id: 'pro',
    name: 'Loop Connect',
    priceMonthly: 12,
    extraDevicePriceMonthly: EXTRA_DEVICE_PRICE_MONTHLY,
    summary: `Unlocks Loop Cloud plus ${DEFAULT_CONNECT_MAX_DEVICES} connected devices (+$${EXTRA_DEVICE_PRICE_MONTHLY}/mo per additional device) with unlimited connections and agents.`,
    hostedLimits: Object.freeze({
      maxConnections: null, // unlimited
      maxAgents: null, // unlimited
      maxDevices: DEFAULT_CONNECT_MAX_DEVICES,
      activityRetentionDays: 30,
    }),
    features: Object.freeze({
      cloudAccess: true,
      loopConnect: true,
      cloudSync: true,
      managedOAuth: true,
      remoteApprovals: true,
      teamWorkspaces: false,
      ssoSaml: false,
      commercialLicense: false,
    }),
  }),
  team: Object.freeze({
    id: 'team',
    name: 'Loop Team',
    priceMonthly: 24,
    perSeat: true,
    waitlistOnly: true,
    summary: 'Shared team Vaults & Connections, unlimited devices, org approval policies, instant offboarding, and 365-day audit logs.',
    hostedLimits: Object.freeze({
      maxConnections: null,
      maxAgents: null,
      maxDevices: null,
      activityRetentionDays: 365,
    }),
    features: Object.freeze({
      cloudAccess: true,
      loopConnect: true,
      cloudSync: true,
      managedOAuth: true,
      remoteApprovals: true,
      teamWorkspaces: true,
      ssoSaml: false,
      commercialLicense: false,
    }),
  }),
  enterprise: Object.freeze({
    id: 'enterprise',
    name: 'Enterprise & Commercial',
    priceMonthly: null,
    waitlistOnly: true,
    summary: 'SSO/SAML/SCIM, SIEM export, BYOK/KMS Vault encryption, unlimited devices, and commercial (non-AGPL) licensing.',
    hostedLimits: Object.freeze({
      maxConnections: null,
      maxAgents: null,
      maxDevices: null,
      activityRetentionDays: 365,
    }),
    features: Object.freeze({
      cloudAccess: true,
      loopConnect: true,
      cloudSync: true,
      managedOAuth: true,
      remoteApprovals: true,
      teamWorkspaces: true,
      ssoSaml: true,
      commercialLicense: true,
    }),
  }),
});

export function hasLoopConnectAccess(billingStatus, { invited = false } = {}) {
  if (invited) return true;
  if (!billingStatus || !billingStatus.billingEnabled) return true;
  if (billingStatus.selfHosted) return false;
  return Boolean(billingStatus.entitlements?.features?.loopConnect);
}

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);
const WAITLIST_PLANS = new Set(['team', 'enterprise', 'pro']);

export class BillingError extends Error {
  constructor(message, status = 400, code = 'BILLING_ERROR') {
    super(message);
    this.name = 'BillingError';
    this.status = status;
    this.code = code;
    this.publicMessage = message;
  }
}

export function loadBillingConfig(env = process.env) {
  const secretKey = typeof env.STRIPE_SECRET_KEY === 'string' && /^sk_(?:test|live)_/.test(env.STRIPE_SECRET_KEY.trim())
    ? env.STRIPE_SECRET_KEY.trim()
    : null;
  const webhookSecret = typeof env.STRIPE_WEBHOOK_SECRET === 'string' && /^whsec_/.test(env.STRIPE_WEBHOOK_SECRET.trim())
    ? env.STRIPE_WEBHOOK_SECRET.trim()
    : null;
  const proPriceId = typeof env.STRIPE_PRO_PRICE_ID === 'string' && /^price_/.test(env.STRIPE_PRO_PRICE_ID.trim())
    ? env.STRIPE_PRO_PRICE_ID.trim()
    : null;
  const extraDevicePriceId =
    typeof env.STRIPE_EXTRA_DEVICE_PRICE_ID === 'string' && /^price_/.test(env.STRIPE_EXTRA_DEVICE_PRICE_ID.trim())
      ? env.STRIPE_EXTRA_DEVICE_PRICE_ID.trim()
      : null;
  const teamPriceId = typeof env.STRIPE_TEAM_PRICE_ID === 'string' && /^price_/.test(env.STRIPE_TEAM_PRICE_ID.trim())
    ? env.STRIPE_TEAM_PRICE_ID.trim()
    : null;
  const parsedExtraUsd = Number(env.STRIPE_EXTRA_DEVICE_MONTHLY_USD);
  const extraDevicePriceMonthly =
    Number.isFinite(parsedExtraUsd) && parsedExtraUsd > 0 ? parsedExtraUsd : EXTRA_DEVICE_PRICE_MONTHLY;

  return {
    enabled: Boolean(secretKey && proPriceId),
    webhookEnabled: Boolean(webhookSecret),
    secretKey,
    webhookSecret,
    extraDevicePriceMonthly,
    prices: {
      pro: proPriceId,
      extraDevice: extraDevicePriceId,
      team: teamPriceId,
    },
  };
}

export function verifyStripeSignature(
  rawBody,
  signatureHeader,
  webhookSecret,
  { nowSec = Math.floor(Date.now() / 1000), toleranceSec = DEFAULT_WEBHOOK_TOLERANCE_SEC } = {},
) {
  if (!webhookSecret) {
    throw new BillingError('Stripe webhook verification is not configured.', 503, 'WEBHOOK_NOT_CONFIGURED');
  }
  if (typeof signatureHeader !== 'string' || !signatureHeader.trim()) {
    throw new BillingError('Missing Stripe-Signature header.', 400, 'INVALID_SIGNATURE');
  }
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
  const parts = signatureHeader.split(',');
  let timestamp = null;
  const signatures = [];

  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key === 't' && /^\d+$/.test(val)) {
      timestamp = Number(val);
    } else if (key === 'v1' && /^[a-f0-9]{64}$/i.test(val)) {
      signatures.push(val.toLowerCase());
    }
  }

  if (timestamp === null || signatures.length === 0) {
    throw new BillingError('Malformed Stripe-Signature header.', 400, 'INVALID_SIGNATURE');
  }
  if (Math.abs(nowSec - timestamp) > toleranceSec) {
    throw new BillingError('Stripe webhook timestamp outside tolerance window.', 400, 'SIGNATURE_EXPIRED');
  }

  const expectedHex = createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${payload}`, 'utf8')
    .digest('hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');

  const matched = signatures.some((sig) => {
    const actualBuf = Buffer.from(sig, 'hex');
    return actualBuf.length === expectedBuf.length && timingSafeEqual(actualBuf, expectedBuf);
  });

  if (!matched) {
    throw new BillingError('Invalid Stripe webhook signature.', 400, 'INVALID_SIGNATURE');
  }
  return true;
}

async function stripeRequest(secretKey, method, endpointPath, fields = null, fetchImpl = fetch) {
  const headers = {
    Authorization: `Bearer ${secretKey}`,
  };
  let encodedBody;
  if (fields && method !== 'GET') {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null && v !== '') {
        body.set(k, String(v));
      }
    }
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    encodedBody = body.toString();
  }
  let res;
  try {
    res = await fetchImpl(`${STRIPE_API_BASE}${endpointPath}`, {
      method,
      headers,
      ...(encodedBody !== undefined ? { body: encodedBody } : {}),
    });
  } catch {
    throw new BillingError('Could not reach Stripe. Please try again.', 502, 'STRIPE_NETWORK_ERROR');
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = json?.error?.message || `Stripe request failed (${res.status}).`;
    throw new BillingError(msg, res.status >= 500 ? 502 : 400, 'STRIPE_API_ERROR');
  }
  return json;
}

function stripePostForm(secretKey, endpointPath, fields, fetchImpl = fetch) {
  return stripeRequest(secretKey, 'POST', endpointPath, fields, fetchImpl);
}

function emptyBillingData() {
  return {
    version: 1,
    workspaces: {},
    customerToWorkspace: {},
    processedEvents: [],
  };
}

function emptyWaitlistData() {
  return {
    version: 1,
    entries: [],
  };
}

export class BillingStore {
  constructor(dataDir, { env = process.env, hosted = false, fetchImpl = fetch } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.billingFile = path.join(this.dataDir, 'billing.json');
    this.waitlistFile = path.join(this.dataDir, 'billing-waitlist.json');
    this.config = loadBillingConfig(env);
    this.hosted = Boolean(hosted);
    this.fetchImpl = fetchImpl;
    this._withBillingLock = createWriteQueue();
    this._recoveredBilling = new WeakSet();
    this._withWaitlistLock = createWriteQueue();
  }

  get enabled() {
    return this.config.enabled;
  }

  get webhookEnabled() {
    return this.config.webhookEnabled;
  }

  async _readBilling() {
    const recordMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
    const validate = (v) => recordMap(v) && recordMap(v.workspaces)
      && (v.customerToWorkspace === undefined || recordMap(v.customerToWorkspace))
      && (v.processedEvents === undefined || Array.isArray(v.processedEvents));
    const read = await readJsonWithBackup(this.billingFile, { validate, strictMissingBackup: true });
    if (read.missing) return emptyBillingData();
    read.data.customerToWorkspace ??= {};
    read.data.processedEvents ??= [];
    if (read.recoveredFromBackup) this._recoveredBilling.add(read.data);
    return read.data;
  }

  async _writeBilling(data) {
    await atomicWriteFile(this.billingFile, JSON.stringify(data, null, 2) + '\n', {
      mode: 0o600,
      backup: !this._recoveredBilling.has(data),
    });
  }

  async _readWaitlist() {
    try {
      const parsed = JSON.parse(await readFile(this.waitlistFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
        return { version: 1, entries: parsed.entries };
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.warn(`BillingStore: could not read ${this.waitlistFile}: ${err.message}`);
      }
    }
    return emptyWaitlistData();
  }

  async _writeWaitlist(data) {
    await atomicWriteFile(this.waitlistFile, JSON.stringify(data, null, 2) + '\n', {
      mode: 0o600,
      backup: true,
    });
  }

  _planIdFromPriceId(priceId) {
    if (!priceId) return 'pro';
    if (this.config.prices.team && priceId === this.config.prices.team) return 'team';
    if (this.config.prices.pro && priceId === this.config.prices.pro) return 'pro';
    return 'pro';
  }

  async getWorkspaceStatus(workspaceKey, { invited = false } = {}) {
    const key = workspaceKey || 'local';
    const [data, waitlist] = await Promise.all([this._readBilling(), this._readWaitlist()]);
    const rec = data.workspaces[key] || null;
    const isActiveSub = Boolean(rec && ACTIVE_SUBSCRIPTION_STATUSES.has(rec.status));
    const planId = isActiveSub && PLANS[rec.planId] ? rec.planId : 'free';
    const plan = PLANS[planId];
    const selfHosted = !this.hosted && !this.config.enabled;
    const extraDevices =
      isActiveSub && plan.id === 'pro'
        ? Math.max(0, Math.min(MAX_EXTRA_DEVICES, Math.trunc(Number(rec?.extraDevices) || 0)))
        : 0;
    const includedDevices = selfHosted
      ? 1
      : plan.id === 'pro' || (invited && plan.id === 'free')
        ? DEFAULT_CONNECT_MAX_DEVICES
        : plan.hostedLimits.maxDevices;
    const effectiveMaxDevices = selfHosted
      ? 1
      : plan.id === 'pro'
        ? DEFAULT_CONNECT_MAX_DEVICES + extraDevices
        : invited && plan.id === 'free'
          ? DEFAULT_CONNECT_MAX_DEVICES
          : plan.hostedLimits.maxDevices;
    const waitlistPlans = waitlist.entries
      .filter((e) => e.workspaceKey === key)
      .map((e) => e.plan);

    const statusObj = {
      plan: plan.id,
      planName: plan.name,
      status: rec?.status || (selfHosted ? 'self_hosted' : 'free'),
      selfHosted,
      billingEnabled: this.config.enabled,
      canManageBilling: Boolean(this.config.enabled && rec?.stripeCustomerId),
      canManageExtraDevices: Boolean(
        this.config.enabled &&
          this.config.prices.extraDevice &&
          isActiveSub &&
          plan.id === 'pro' &&
          rec?.stripeSubscriptionId,
      ),
      includedDevices,
      extraDevices,
      extraDevicePriceMonthly: this.config.extraDevicePriceMonthly,
      cancelAtPeriodEnd: Boolean(rec?.cancelAtPeriodEnd),
      currentPeriodEnd: rec?.currentPeriodEnd || null,
      invited: Boolean(invited),
      entitlements: {
        // Self-hosted local installs never hit hosted plan limits (1 local device, unlimited connections & agents).
        unlimitedLocal: selfHosted,
        limits: selfHosted
          ? { maxConnections: null, maxAgents: null, maxDevices: 1, activityRetentionDays: null }
          : { ...plan.hostedLimits, maxDevices: effectiveMaxDevices },
        features: invited && plan.id === 'free'
          ? { ...plan.features, cloudAccess: true, loopConnect: true, cloudSync: true }
          : plan.features,
      },
      waitlistPlans: [...new Set(waitlistPlans)],
      plans: Object.values(PLANS),
    };
    statusObj.loopConnectActive = hasLoopConnectAccess(statusObj, { invited });
    return statusObj;
  }

  async createCheckoutSession({ workspaceKey, planId = 'pro', extraDevices = 0, origin, customerEmail }) {
    if (!this.config.enabled) {
      throw new BillingError(
        'Billing is not enabled on this Loop instance. Self-hosted installs include all local features for free.',
        400,
        'BILLING_DISABLED',
      );
    }
    const key = workspaceKey || 'local';
    const targetPlan = String(planId || 'pro').toLowerCase();
    const priceId = this.config.prices[targetPlan];
    if (!priceId) {
      throw new BillingError(
        targetPlan === 'team' || targetPlan === 'enterprise'
          ? `${PLANS[targetPlan]?.name || targetPlan} is currently waitlist-only. Join the waitlist below.`
          : `Unsupported plan "${targetPlan}".`,
        400,
        'PLAN_UNAVAILABLE',
      );
    }
    const parsedExtra = extraDevices === undefined || extraDevices === null ? 0 : Number(extraDevices);
    if (!Number.isInteger(parsedExtra) || parsedExtra < 0 || parsedExtra > MAX_EXTRA_DEVICES) {
      throw new BillingError(`extraDevices must be an integer between 0 and ${MAX_EXTRA_DEVICES}.`, 400, 'INVALID_EXTRA_DEVICES');
    }
    if (parsedExtra > 0 && !this.config.prices.extraDevice) {
      throw new BillingError('Additional device billing is not configured on this server.', 400, 'EXTRA_DEVICE_UNAVAILABLE');
    }

    const data = await this._readBilling();
    const existing = data.workspaces[key];
    const safeOrigin = new URL(origin).origin;

    const fields = {
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: `${safeOrigin}/#settings?tab=billing&checkout=success`,
      cancel_url: `${safeOrigin}/#settings?tab=billing&checkout=cancel`,
      client_reference_id: key,
      'metadata[workspace_key]': key,
      'metadata[plan_id]': targetPlan,
      'metadata[extra_devices]': String(parsedExtra),
      'subscription_data[metadata][workspace_key]': key,
      'subscription_data[metadata][plan_id]': targetPlan,
      'subscription_data[metadata][extra_devices]': String(parsedExtra),
      allow_promotion_codes: 'true',
    };
    if (parsedExtra > 0) {
      fields['line_items[1][price]'] = this.config.prices.extraDevice;
      fields['line_items[1][quantity]'] = String(parsedExtra);
    }
    if (existing?.stripeCustomerId) {
      fields.customer = existing.stripeCustomerId;
    } else if (customerEmail && EMAIL_RE.test(customerEmail)) {
      fields.customer_email = customerEmail;
    }

    const session = await stripePostForm(this.config.secretKey, '/checkout/sessions', fields, this.fetchImpl);
    if (!session?.url) {
      throw new BillingError('Stripe did not return a checkout URL.', 502, 'STRIPE_API_ERROR');
    }
    return { url: session.url, sessionId: session.id };
  }

  async updateExtraDevices({ workspaceKey, extraDevices, delta, currentPairedDevices = 0, invited = false }) {
    if (!this.config.enabled) {
      throw new BillingError('Billing is not enabled on this Loop instance.', 400, 'BILLING_DISABLED');
    }
    if (!this.config.prices.extraDevice) {
      throw new BillingError('Additional device billing is not configured on this server.', 400, 'EXTRA_DEVICE_UNAVAILABLE');
    }
    const key = workspaceKey || 'local';

    return this._withBillingLock(async () => {
      const data = await this._readBilling();
      const rec = data.workspaces[key];
      const isActiveSub = Boolean(rec && ACTIVE_SUBSCRIPTION_STATUSES.has(rec.status));
      if (!isActiveSub || rec.planId !== 'pro' || !rec.stripeSubscriptionId) {
        throw new BillingError(
          'An active Loop Connect subscription is required before adding extra device slots.',
          402,
          'UPGRADE_REQUIRED',
        );
      }

      const currentExtra = Math.max(0, Math.trunc(Number(rec.extraDevices) || 0));
      let targetExtra;
      if (delta !== undefined && delta !== null) {
        const d = Number(delta);
        if (!Number.isInteger(d) || d === 0 || Math.abs(d) > MAX_EXTRA_DEVICES) {
          throw new BillingError('delta must be a non-zero integer.', 400, 'INVALID_EXTRA_DEVICES');
        }
        targetExtra = currentExtra + d;
      } else {
        targetExtra = Number(extraDevices);
      }
      if (!Number.isInteger(targetExtra) || targetExtra < 0 || targetExtra > MAX_EXTRA_DEVICES) {
        throw new BillingError(`extraDevices must be an integer between 0 and ${MAX_EXTRA_DEVICES}.`, 400, 'INVALID_EXTRA_DEVICES');
      }

      const targetMaxDevices = DEFAULT_CONNECT_MAX_DEVICES + targetExtra;
      if (currentPairedDevices > targetMaxDevices) {
        const excess = currentPairedDevices - targetMaxDevices;
        throw new BillingError(
          `Disconnect ${excess} paired ${excess === 1 ? 'device' : 'devices'} before lowering your limit to ${targetMaxDevices} devices.`,
          400,
          'DEVICES_IN_USE',
        );
      }

      let itemId = typeof rec.extraDeviceItemId === 'string' && rec.extraDeviceItemId ? rec.extraDeviceItemId : null;
      if (!itemId) {
        const sub = await stripeRequest(
          this.config.secretKey,
          'GET',
          `/subscriptions/${encodeURIComponent(rec.stripeSubscriptionId)}`,
          null,
          this.fetchImpl,
        );
        const found = (Array.isArray(sub?.items?.data) ? sub.items.data : []).find(
          (item) => item?.price?.id === this.config.prices.extraDevice,
        );
        if (found?.id) itemId = found.id;
      }

      if (targetExtra === 0) {
        if (itemId) {
          await stripeRequest(
            this.config.secretKey,
            'DELETE',
            `/subscription_items/${encodeURIComponent(itemId)}`,
            { proration_behavior: 'create_prorations' },
            this.fetchImpl,
          );
        }
        itemId = null;
      } else if (itemId) {
        await stripePostForm(
          this.config.secretKey,
          `/subscription_items/${encodeURIComponent(itemId)}`,
          { quantity: String(targetExtra), proration_behavior: 'create_prorations' },
          this.fetchImpl,
        );
      } else {
        const created = await stripePostForm(
          this.config.secretKey,
          '/subscription_items',
          {
            subscription: rec.stripeSubscriptionId,
            price: this.config.prices.extraDevice,
            quantity: String(targetExtra),
            proration_behavior: 'create_prorations',
          },
          this.fetchImpl,
        );
        itemId = created?.id || null;
      }

      data.workspaces[key] = {
        ...rec,
        extraDevices: targetExtra,
        extraDeviceItemId: itemId,
        updatedAt: new Date().toISOString(),
      };
      await this._writeBilling(data);
      return this.getWorkspaceStatus(key, { invited });
    });
  }

  async createPortalSession({ workspaceKey, origin }) {
    if (!this.config.enabled) {
      throw new BillingError('Billing is not enabled on this Loop instance.', 400, 'BILLING_DISABLED');
    }
    const key = workspaceKey || 'local';
    const data = await this._readBilling();
    const rec = data.workspaces[key];
    if (!rec?.stripeCustomerId) {
      throw new BillingError('No active billing account found for this workspace.', 400, 'NO_CUSTOMER');
    }
    const safeOrigin = new URL(origin).origin;
    const session = await stripePostForm(
      this.config.secretKey,
      '/billing_portal/sessions',
      {
        customer: rec.stripeCustomerId,
        return_url: `${safeOrigin}/#settings?tab=billing`,
      },
      this.fetchImpl,
    );
    if (!session?.url) {
      throw new BillingError('Stripe did not return a billing portal URL.', 502, 'STRIPE_API_ERROR');
    }
    return { url: session.url };
  }

  async handleWebhook(rawBody, signatureHeader, { nowSec } = {}) {
    verifyStripeSignature(rawBody, signatureHeader, this.config.webhookSecret, { nowSec });

    let event;
    try {
      const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
      event = JSON.parse(text);
    } catch {
      throw new BillingError('Invalid JSON payload in Stripe webhook.', 400, 'INVALID_PAYLOAD');
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      throw new BillingError('Malformed Stripe webhook event.', 400, 'INVALID_PAYLOAD');
    }

    return this._withBillingLock(async () => {
      const data = await this._readBilling();
      if (event.id && data.processedEvents.includes(event.id)) {
        return { received: true, duplicate: true, type: event.type };
      }

      const obj = event.data?.object || {};
      let updatedWorkspace = null;

      const created = Number.isSafeInteger(event.created) ? event.created : 0;
      const rank = { 'checkout.session.completed': 1, 'customer.subscription.created': 2,
        'invoice.payment_failed': 3, 'customer.subscription.updated': 4, 'customer.subscription.deleted': 5 }[event.type];
      const started = Number.isSafeInteger(obj.created) ? obj.created : created;
      let newSubscription = false;
      const applicable = (workspaceKey, subscriptionId, kind) => {
        if (!subscriptionId) return false;
        const current = data.workspaces[workspaceKey];
        if (!current) { newSubscription = true; return true; }
        if (current.retiredSubscriptions?.includes(subscriptionId)) return false;
        const replaces = current.stripeSubscriptionId && current.stripeSubscriptionId !== subscriptionId;
        if (replaces && kind !== 'checkout' && kind !== 'customer.subscription.created') return false;
        if (!replaces && current.status === 'canceled') return false;
        if (!replaces && kind === 'checkout' && current.lastStripeRank >= 2) return false;
        if (replaces) {
          if (started && current.subscriptionStarted && started < current.subscriptionStarted) return false;
          current.retiredSubscriptions = [...(current.retiredSubscriptions || []), current.stripeSubscriptionId];
          newSubscription = true;
        } else if (created && current.lastStripeCreated && (created < current.lastStripeCreated ||
            (created === current.lastStripeCreated && rank < current.lastStripeRank))) return false;
        return true;
      };

      if (event.type === 'checkout.session.completed') {
        const wsKey = obj.metadata?.workspace_key || obj.client_reference_id;
        const customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
        const subscriptionId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id;
        const planId = PLANS[obj.metadata?.plan_id] ? obj.metadata.plan_id : 'pro';
        const checkoutExtra = Number.isInteger(Number(obj.metadata?.extra_devices))
          ? Math.max(0, Math.min(MAX_EXTRA_DEVICES, Number(obj.metadata.extra_devices)))
          : null;

        if (wsKey && applicable(wsKey, subscriptionId, 'checkout')) {
          const prev = data.workspaces[wsKey] || {};
          data.workspaces[wsKey] = {
            ...prev,
            planId,
            status: 'active',
            stripeCustomerId: customerId || prev.stripeCustomerId || null,
            stripeSubscriptionId: subscriptionId || prev.stripeSubscriptionId || null,
            extraDevices: checkoutExtra !== null ? checkoutExtra : (Number(prev.extraDevices) || 0),
            cancelAtPeriodEnd: false,
            updatedAt: new Date().toISOString(),
          };
          if (customerId) data.customerToWorkspace[customerId] = wsKey;
          updatedWorkspace = wsKey;
        }
      } else if (
        event.type === 'customer.subscription.created' ||
        event.type === 'customer.subscription.updated' ||
        event.type === 'customer.subscription.deleted'
      ) {
        const customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
        const wsKey = obj.metadata?.workspace_key || (customerId ? data.customerToWorkspace[customerId] : null);
        if (wsKey && applicable(wsKey, obj.id, event.type)) {
          const prev = data.workspaces[wsKey] || {};
          const items = Array.isArray(obj.items?.data) ? obj.items.data : [];
          const extraPriceId = this.config.prices.extraDevice;
          const extraItem = extraPriceId ? items.find((it) => it?.price?.id === extraPriceId) : null;
          const baseItem = items.find((it) => !extraPriceId || it?.price?.id !== extraPriceId) || items[0] || null;
          const priceId = baseItem?.price?.id || null;
          const inferredPlan = PLANS[obj.metadata?.plan_id]
            ? obj.metadata.plan_id
            : this._planIdFromPriceId(priceId);
          const status = event.type === 'customer.subscription.deleted' ? 'canceled' : String(obj.status || 'active');
          const activeNow = ACTIVE_SUBSCRIPTION_STATUSES.has(status);
          const periodEnd = Number.isFinite(Number(obj.current_period_end))
            ? new Date(Number(obj.current_period_end) * 1000).toISOString()
            : prev.currentPeriodEnd || null;
          const nextExtraDevices = !activeNow
            ? 0
            : extraItem
              ? Math.max(0, Math.min(MAX_EXTRA_DEVICES, Math.trunc(Number(extraItem.quantity) || 0)))
              : items.length > 0 && extraPriceId
                ? 0
                : Math.max(0, Math.trunc(Number(prev.extraDevices) || 0));

          data.workspaces[wsKey] = {
            ...prev,
            planId: activeNow ? inferredPlan : 'free',
            status,
            stripeCustomerId: customerId || prev.stripeCustomerId || null,
            stripeSubscriptionId: obj.id || prev.stripeSubscriptionId || null,
            extraDevices: nextExtraDevices,
            extraDeviceItemId: !activeNow ? null : (extraItem?.id || (nextExtraDevices === 0 ? null : prev.extraDeviceItemId || null)),
            cancelAtPeriodEnd: Boolean(obj.cancel_at_period_end),
            currentPeriodEnd: periodEnd,
            updatedAt: new Date().toISOString(),
          };
          if (customerId) data.customerToWorkspace[customerId] = wsKey;
          updatedWorkspace = wsKey;
        }
      } else if (event.type === 'invoice.payment_failed') {
        const customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
        const wsKey = customerId ? data.customerToWorkspace[customerId] : null;
        const invoiceSub = obj.subscription ?? obj.parent?.subscription_details?.subscription;
        const subId = typeof invoiceSub === 'string' ? invoiceSub : invoiceSub?.id;
        if (wsKey && subId && data.workspaces[wsKey] && applicable(wsKey, subId, event.type)) {
          data.workspaces[wsKey] = {
            ...data.workspaces[wsKey],
            status: 'past_due',
            updatedAt: new Date().toISOString(),
          };
          updatedWorkspace = wsKey;
        }
      }

      if (updatedWorkspace) {
        const current = data.workspaces[updatedWorkspace];
        if (newSubscription || !current.subscriptionStarted) current.subscriptionStarted = started;
        if (created) current.lastStripeCreated = created;
        current.lastStripeRank = rank;
      }

      if (event.id) {
        data.processedEvents.push(event.id);
        if (data.processedEvents.length > MAX_PROCESSED_EVENTS) {
          data.processedEvents = data.processedEvents.slice(-MAX_PROCESSED_EVENTS);
        }
      }

      await this._writeBilling(data);
      return { received: true, duplicate: false, type: event.type, workspaceKey: updatedWorkspace };
    });
  }

  async joinWaitlist({ workspaceKey, email, plan = 'team', teamSize = '', note = '' }) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(cleanEmail) || cleanEmail.length > 254) {
      throw new BillingError('Please enter a valid email address.', 400, 'INVALID_EMAIL');
    }
    const cleanPlan = String(plan || 'team').trim().toLowerCase();
    if (!WAITLIST_PLANS.has(cleanPlan)) {
      throw new BillingError('Choose Team, Enterprise, or Pro for the waitlist.', 400, 'INVALID_PLAN');
    }
    const cleanSize = String(teamSize || '').trim().slice(0, 40);
    const cleanNote = String(note || '').trim().slice(0, 400);
    const key = workspaceKey || 'local';

    return this._withWaitlistLock(async () => {
      const data = await this._readWaitlist();
      const existing = data.entries.find((e) => e.email === cleanEmail && e.plan === cleanPlan);
      if (existing) {
        if (cleanSize) existing.teamSize = cleanSize;
        if (cleanNote) existing.note = cleanNote;
        existing.updatedAt = new Date().toISOString();
        await this._writeWaitlist(data);
        return { joined: true, alreadyJoined: true, plan: cleanPlan };
      }
      data.entries.push({
        workspaceKey: key,
        email: cleanEmail,
        plan: cleanPlan,
        teamSize: cleanSize,
        note: cleanNote,
        createdAt: new Date().toISOString(),
      });
      await this._writeWaitlist(data);
      return { joined: true, alreadyJoined: false, plan: cleanPlan };
    });
  }
}
