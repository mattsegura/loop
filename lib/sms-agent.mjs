// Localhost bridge between Loop and loop-text (SMS / iMessage agent service).
// Disabled cleanly when LOOP_TEXT_URL or LOOP_TEXT_INTERNAL_SECRET is unset.

import { issueAgentToken, readAgentToken } from './agents.mjs';

export const SMS_BRAIN_MODES = new Set(['default', 'byo_key', 'claude_oauth', 'codex_oauth']);
export const SMS_CLI_AUTH_PROVIDERS = new Set(['claude', 'codex']);
export const SMS_AGENT_DEFAULT_ID = 'loop_text_imessage';
export const SMS_AGENT_BILLING_URL = '/?tab=settings&upgrade=1';

const DEFAULT_TIMEOUT_MS = 10_000;
const PAID_PLANS = new Set(['pro', 'team', 'enterprise']);
const ACTIVE_SUB_STATUSES = new Set(['active', 'trialing']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export class SmsAgentError extends Error {
  constructor(message, status = 502, code = 'SMS_AGENT_ERROR') {
    super(message);
    this.name = 'SmsAgentError';
    this.status = status;
    this.code = code;
    this.publicMessage = message;
  }
}

function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return {
    url: `${parsed.origin}${pathname}`,
    loopback: LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()),
  };
}

export function loadSmsAgentConfig(env = process.env) {
  const normalized = normalizeBaseUrl(env?.LOOP_TEXT_URL);
  const url = normalized?.url || null;
  const rawSecret = typeof env?.LOOP_TEXT_INTERNAL_SECRET === 'string'
    ? env.LOOP_TEXT_INTERNAL_SECRET.trim()
    : '';
  const secret = rawSecret || null;
  const rawPhone = typeof env?.LOOP_TEXT_PHONE === 'string'
    ? env.LOOP_TEXT_PHONE.trim()
    : '';
  const phone = rawPhone || null;

  return {
    enabled: Boolean(url && secret),
    url,
    secret,
    phone,
    loopback: Boolean(normalized?.loopback),
  };
}

export function isPlanActiveForSms(billingStatus) {
  if (!billingStatus) return true;
  if (billingStatus.billingEnabled === false || billingStatus.selfHosted === true) return true;
  if (PAID_PLANS.has(billingStatus.plan)) return true;
  if (ACTIVE_SUB_STATUSES.has(billingStatus.status)) return true;
  if (ACTIVE_SUB_STATUSES.has(billingStatus.subscription?.status)) return true;
  return false;
}

export async function ensureSmsAgentRecord(store, vault) {
  const agents = await store.listAgents();
  let agent = agents.find((a) => a.kind === 'imessage' || a.id === SMS_AGENT_DEFAULT_ID) || null;

  if (!agent) {
    agent = await store.addAgent({
      name: 'Loop Text (iMessage)',
      kind: 'imessage',
      profile: 'all',
      mode: 'default',
      canManage: true,
      memoryAccess: 'read_write',
      secrets: [],
      enabled: true,
    });
  } else if (!agent.enabled) {
    agent = (await store.updateAgent(agent.id, { enabled: true })) || agent;
  }

  let token = await readAgentToken(vault, agent.id);
  if (!token || !agent.tokenHash) {
    const issued = await issueAgentToken(store, vault, agent.id);
    agent = issued.agent;
    token = issued.token;
  }

  return { agent, token };
}

export function stripSensitiveBrainFields(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const copy = { ...payload };
  delete copy.apiKey;
  delete copy.api_key;
  if (copy.brain && typeof copy.brain === 'object' && !Array.isArray(copy.brain)) {
    copy.brain = stripSensitiveBrainFields(copy.brain);
  }
  return copy;
}

export class SmsAgentClient {
  constructor(config, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.config = config || { enabled: false, url: null, secret: null, phone: null };
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  get enabled() {
    return Boolean(this.config.enabled && this.config.url && this.config.secret);
  }

  async _request(method, endpoint, body) {
    if (!this.enabled) {
      throw new SmsAgentError('SMS agent is not configured on this Loop instance.', 503, 'SMS_AGENT_DISABLED');
    }
    const targetUrl = `${this.config.url}${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers = {
      Accept: 'application/json',
      'X-Loop-Text-Secret': this.config.secret,
    };
    const init = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await this.fetchImpl(targetUrl, init);
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new SmsAgentError('Loop Text service timed out.', 504, 'SMS_AGENT_TIMEOUT');
      }
      throw new SmsAgentError('Loop Text service is unavailable.', 502, 'SMS_AGENT_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }

    const rawText = await response.text();
    let parsed = null;
    if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const upstreamMessage =
        (parsed && typeof parsed.error === 'string' && parsed.error) ||
        (parsed && typeof parsed.message === 'string' && parsed.message) ||
        `Loop Text service returned HTTP ${response.status}.`;
      const status = response.status >= 400 && response.status < 500 ? response.status : 502;
      throw new SmsAgentError(upstreamMessage, status, 'SMS_AGENT_UPSTREAM_ERROR');
    }

    return parsed ?? {};
  }

  async getStatus(workspaceId) {
    const qs = new URLSearchParams({ workspaceId: String(workspaceId || 'local') }).toString();
    return this._request('GET', `/internal/status?${qs}`);
  }

  async getTraces(workspaceId, { limit = 15 } = {}) {
    const qs = new URLSearchParams({
      workspaceId: String(workspaceId || 'local'),
      limit: String(Math.max(1, Math.min(Number(limit) || 15, 50))),
    }).toString();
    return this._request('GET', `/internal/traces?${qs}`);
  }

  async createLinkCode({ workspaceId, agentId, agentToken, planActive, connections, inviteUrl, userPhone }) {
    return this._request('POST', '/internal/link-code', {
      workspaceId: String(workspaceId || 'local'),
      agentId,
      agentToken,
      planActive: Boolean(planActive),
      connections: Array.isArray(connections) ? connections : [],
      ...(inviteUrl ? { inviteUrl } : {}),
      ...(userPhone ? { userPhone: String(userPhone).trim() } : {}),
    });
  }

  async updateBrain({ workspaceId, mode, provider, model, vaultKey, apiKey }) {
    const payload = {
      workspaceId: String(workspaceId || 'local'),
      mode,
    };
    if (provider !== undefined) payload.provider = provider;
    if (model !== undefined) payload.model = model;
    if (vaultKey !== undefined) payload.vaultKey = vaultKey;
    if (apiKey !== undefined) payload.apiKey = apiKey;
    return this._request('POST', '/internal/brain', payload);
  }

  async startCliAuth({ workspaceId, provider }) {
    return this._request('POST', '/internal/cli-auth/start', {
      workspaceId: String(workspaceId || 'local'),
      provider,
    });
  }

  async getCliAuthStatus(workspaceId) {
    const qs = new URLSearchParams({ workspaceId: String(workspaceId || 'local') }).toString();
    return this._request('GET', `/internal/cli-auth/status?${qs}`);
  }

  async disconnect(workspaceId) {
    return this._request('POST', '/internal/disconnect', {
      workspaceId: String(workspaceId || 'local'),
    });
  }

  async nudge({ workspaceId, phone, prompt, message, dryRun = false, idempotencyKey = null } = {}) {
    const payload = { dryRun: Boolean(dryRun) };
    if (workspaceId) payload.workspaceId = String(workspaceId);
    if (phone) payload.phone = String(phone);
    if (prompt) payload.prompt = String(prompt);
    if (message) payload.message = String(message);
    if (idempotencyKey) payload.idempotencyKey = String(idempotencyKey);
    return this._request('POST', '/internal/nudge', payload);
  }
}
