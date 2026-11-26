// RFC 8628-style Device Authorization Grant server for Loop.
// Lets a CLI (`scripts/connect-agents.mjs` / `curl .../connect.mjs | node`) connect one or many
// local agents to Local Loop or Hosted Loop (`useloop.sh`) with zero localhost callback server
// and zero browser-to-localhost redirects: both CLI and browser talk outbound to Loop.

import { randomBytes } from 'node:crypto';
import { INSTALLABLE_HARNESSES } from './agent-installer.mjs';
import { PROFILE_CONTROL_RE, normalizeProfileTag } from './profiles.mjs';

const USER_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEVICE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_POLL_INTERVAL_SEC = 2;
const MIN_POLL_SPACING_MS = 900;
const MAX_PENDING_DEVICES = 200;
const MAX_AGENTS_PER_DEVICE = 20;
const MAX_START_PER_IP = 20;
const MAX_LOOKUP_PER_IP = 60;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const MAX_RATE_LIMIT_IPS = 10_000;
const WORKSPACE_ID_RE = /^[0-9a-f]{64}$/;
const ALLOWED_AGENT_IDS = new Set([...INSTALLABLE_HARNESSES, 'other']);
const TOO_MANY_REQUESTS_MSG = 'Too many device sign-in requests. Try again shortly.';

function deviceError(status, error, errorDescription, extra = {}) {
  return Object.assign(new Error(errorDescription || error), {
    status,
    oauthError: error,
    oauthDescription: errorDescription || error,
    ...extra,
  });
}

function generateUserCode() {
  const bytes = randomBytes(8);
  let raw = '';
  for (let i = 0; i < 8; i += 1) {
    raw += USER_CODE_CHARS[bytes[i] % USER_CODE_CHARS.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

export function normalizeUserCode(raw) {
  const cleaned = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (cleaned.length !== 8) return null;
  for (const ch of cleaned) {
    if (!USER_CODE_CHARS.includes(ch)) return null;
  }
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
}

function cleanLabel(raw, fallback = 'Loop CLI', max = 80) {
  const clean = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return clean || fallback;
}

function normalizeRequestedAgents(rawAgents, clientName) {
  if (rawAgents === undefined || rawAgents === null) {
    return [{ id: 'other', name: clientName }];
  }
  if (!Array.isArray(rawAgents) || rawAgents.length === 0 || rawAgents.length > MAX_AGENTS_PER_DEVICE) {
    throw deviceError(400, 'invalid_request', `agents must be a list of 1 to ${MAX_AGENTS_PER_DEVICE} items.`);
  }
  const out = [];
  const seen = new Set();
  for (const item of rawAgents) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw deviceError(400, 'invalid_request', 'Each requested agent must be an object.');
    }
    const rawId = String(item.id || 'other').trim().toLowerCase();
    const id = ALLOWED_AGENT_IDS.has(rawId) ? rawId : 'other';
    const name = cleanLabel(item.name || item.id, 'MCP Client', 80);
    const key = id === 'other' ? `other:${name.toLowerCase()}` : id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, name });
  }
  if (out.length === 0) {
    return [{ id: 'other', name: clientName }];
  }
  return out;
}

function validateAccessGrant(access) {
  if (access === undefined || access === null) return null;
  if (typeof access !== 'object' || Array.isArray(access)) {
    throw deviceError(400, 'invalid_request', 'Access configuration must be an object.');
  }
  const nextAccess = {};
  const normalizeIdArray = (val, label) => {
    if (val === null) return null;
    if (!Array.isArray(val)) throw deviceError(400, 'invalid_request', `${label} must be an array or null.`);
    if (val.length > 1000) throw deviceError(400, 'invalid_request', `${label} has too many items.`);
    const out = [];
    const seen = new Set();
    for (const item of val) {
      if (typeof item !== 'string' || !item.trim() || item.length > 120 || /[\x00-\x1f\x7f]/.test(item)) {
        throw deviceError(400, 'invalid_request', `Invalid entry in ${label}.`);
      }
      const clean = item.trim();
      if (!seen.has(clean)) {
        seen.add(clean);
        out.push(clean);
      }
    }
    return out;
  };
  if (access.allowedConnections !== undefined) {
    nextAccess.allowedConnections = normalizeIdArray(access.allowedConnections, 'allowedConnections');
  }
  if (access.allowedSkills !== undefined) {
    nextAccess.allowedSkills = normalizeIdArray(access.allowedSkills, 'allowedSkills');
  }
  if (access.memoryAccess !== undefined) {
    if (access.memoryAccess !== 'read_write' && access.memoryAccess !== 'read' && access.memoryAccess !== 'none') {
      throw deviceError(400, 'invalid_request', 'memoryAccess must be "read_write", "read", or "none".');
    }
    nextAccess.memoryAccess = access.memoryAccess;
  }
  if (access.canManage !== undefined) {
    if (typeof access.canManage !== 'boolean') {
      throw deviceError(400, 'invalid_request', 'canManage must be true or false.');
    }
    nextAccess.canManage = access.canManage;
  }
  if (access.secrets !== undefined) {
    if (!Array.isArray(access.secrets)) throw deviceError(400, 'invalid_request', 'secrets must be an array.');
    if (access.secrets.length > 500) throw deviceError(400, 'invalid_request', 'Too many secrets selected.');
    const out = [];
    const seen = new Set();
    for (const s of access.secrets) {
      if (typeof s !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(s) || s.startsWith('__')) {
        throw deviceError(400, 'invalid_request', 'Invalid secret key in access grant.');
      }
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    nextAccess.secrets = out;
  }
  return Object.keys(nextAccess).length > 0 ? nextAccess : null;
}

export class DeviceAuthServer {
  constructor({
    hostedRoot = false,
    ttlMs = DEVICE_TTL_MS,
    pollIntervalSec = DEFAULT_POLL_INTERVAL_SEC,
    minPollSpacingMs = MIN_POLL_SPACING_MS,
  } = {}) {
    this.hostedRoot = hostedRoot === true;
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEVICE_TTL_MS;
    this.pollIntervalSec = Number.isInteger(pollIntervalSec) && pollIntervalSec > 0 ? pollIntervalSec : DEFAULT_POLL_INTERVAL_SEC;
    this.minPollSpacingMs = Number.isFinite(minPollSpacingMs) && minPollSpacingMs >= 0 ? minPollSpacingMs : MIN_POLL_SPACING_MS;
    this.byDeviceCode = new Map();
    this.byUserCode = new Map();
    this._startHits = new Map();
    this._lookupHits = new Map();
  }

  _consumeIpRateLimit(bucket, clientIp, maxHits, now = Date.now()) {
    if (typeof clientIp !== 'string' || !clientIp.trim()) return true;
    const ip = clientIp.trim();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    const existing = bucket.get(ip);
    const hits = existing ? existing.filter((ts) => ts > cutoff) : [];
    if (hits.length >= maxHits) {
      bucket.set(ip, hits);
      return false;
    }
    if (!bucket.has(ip) && bucket.size >= MAX_RATE_LIMIT_IPS) {
      const oldestKey = bucket.keys().next().value;
      if (oldestKey !== undefined) bucket.delete(oldestKey);
    }
    hits.push(now);
    bucket.set(ip, hits);
    return true;
  }

  _prune(now = Date.now()) {
    for (const [deviceCode, rec] of this.byDeviceCode) {
      if (rec.expiresAt <= now) {
        this.byDeviceCode.delete(deviceCode);
        this.byUserCode.delete(rec.userCode);
      }
    }
  }

  _workspaceAllowed(rec, workspaceId) {
    if (rec.targetWorkspaceId === null) {
      if (workspaceId === null) return true;
      if (this.hostedRoot && typeof workspaceId === 'string' && WORKSPACE_ID_RE.test(workspaceId)) return true;
      return false;
    }
    return typeof workspaceId === 'string' && workspaceId === rec.targetWorkspaceId;
  }

  startDeviceAuth(body, origin, { defaultWorkspaceId = null, clientIp = null, pairedDevice = null } = {}) {
    const now = Date.now();
    this._prune(now);
    if (!this._consumeIpRateLimit(this._startHits, clientIp, MAX_START_PER_IP, now)) {
      throw deviceError(429, 'temporarily_unavailable', TOO_MANY_REQUESTS_MSG);
    }
    if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) {
      throw deviceError(400, 'invalid_request', 'Device sign-in payload must be a JSON object.');
    }
    const payload = body || {};
    const scopedWs =
      typeof defaultWorkspaceId === 'string' && WORKSPACE_ID_RE.test(defaultWorkspaceId)
        ? defaultWorkspaceId
        : null;
    if (defaultWorkspaceId !== null && defaultWorkspaceId !== undefined && !scopedWs) {
      throw deviceError(400, 'invalid_target', 'Requested MCP workspace is not valid.');
    }

    if (this.byDeviceCode.size >= MAX_PENDING_DEVICES) {
      throw deviceError(429, 'temporarily_unavailable', TOO_MANY_REQUESTS_MSG);
    }

    const clientName = cleanLabel(payload.client_name || payload.clientName, 'Loop CLI', 80);
    const agents = normalizeRequestedAgents(payload.agents, clientName);
    let requestedProfile = '';
    if (typeof payload.profile === 'string' && payload.profile.trim()) {
      if (PROFILE_CONTROL_RE.test(payload.profile)) {
        throw deviceError(400, 'invalid_request', 'Profile must be a valid string without control characters.');
      }
      const clean = normalizeProfileTag(payload.profile);
      if (clean && clean !== 'all') requestedProfile = clean;
    }

    let userCode = '';
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = generateUserCode();
      if (!this.byUserCode.has(candidate)) {
        userCode = candidate;
        break;
      }
    }
    if (!userCode) {
      throw deviceError(503, 'temporarily_unavailable', TOO_MANY_REQUESTS_MSG);
    }

    const deviceCode = randomBytes(32).toString('base64url');
    const cleanOrigin = String(origin || '').replace(/\/+$/, '');
    const record = {
      deviceCode,
      userCode,
      clientName,
      agents,
      requestedProfile,
      targetWorkspaceId: scopedWs,
      pairedDevice,
      status: 'pending', // 'pending' | 'approved' | 'denied'
      approvedWorkspaceId: null,
      approvedUserId: null,
      approvedProfile: 'all',
      approvedAccess: null,
      approvedAgents: null,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      lastPollAt: 0,
      intervalSec: this.pollIntervalSec,
    };

    this.byDeviceCode.set(deviceCode, record);
    this.byUserCode.set(userCode, record);

    return {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${cleanOrigin}/?loop-device=1`,
      verification_uri_complete: `${cleanOrigin}/?loop-device=${encodeURIComponent(userCode)}`,
      expires_in: Math.floor(this.ttlMs / 1000),
      interval: this.pollIntervalSec,
    };
  }

  getPendingByUserCode(rawUserCode, { workspaceId = null, clientIp = null } = {}) {
    const now = Date.now();
    this._prune(now);
    if (!this._consumeIpRateLimit(this._lookupHits, clientIp, MAX_LOOKUP_PER_IP, now)) {
      throw deviceError(429, 'temporarily_unavailable', TOO_MANY_REQUESTS_MSG);
    }
    const userCode = normalizeUserCode(rawUserCode);
    if (!userCode) return null;
    const rec = this.byUserCode.get(userCode);
    if (!rec || rec.status !== 'pending') return null;
    if (!this._workspaceAllowed(rec, workspaceId)) return null;
    return {
      userCode: rec.userCode,
      clientName: rec.clientName,
      agents: rec.agents.map((a) => ({ id: a.id, name: a.name })),
      ...(rec.requestedProfile ? { requestedProfile: rec.requestedProfile } : {}),
      targetWorkspaceId: rec.targetWorkspaceId,
      expiresAt: rec.expiresAt,
    };
  }

  approveByUserCode(
    rawUserCode,
    { workspaceId = null, userId = 'local', profile = 'all', access = null, selectedAgentIds = null } = {},
  ) {
    this._prune();
    const userCode = normalizeUserCode(rawUserCode);
    const rec = userCode ? this.byUserCode.get(userCode) : null;
    if (!rec || rec.status !== 'pending' || !this._workspaceAllowed(rec, workspaceId)) {
      throw deviceError(404, 'invalid_request', 'This device code is invalid or expired. Start connect again in your terminal.');
    }

    let approvedProfile = 'all';
    if (profile !== undefined && profile !== null && profile !== '') {
      if (typeof profile !== 'string' || PROFILE_CONTROL_RE.test(profile)) {
        throw deviceError(400, 'invalid_request', 'Profile must be a valid string without control characters.');
      }
      approvedProfile = normalizeProfileTag(profile) || 'all';
    }

    const approvedAccess = validateAccessGrant(access);

    let approvedAgents = rec.agents;
    if (Array.isArray(selectedAgentIds)) {
      const wanted = new Set(selectedAgentIds.map((id) => String(id || '').trim().toLowerCase()));
      approvedAgents = rec.agents.filter((a) => wanted.has(a.id));
      if (approvedAgents.length === 0) {
        throw deviceError(400, 'invalid_request', 'Select at least one agent to connect.');
      }
    }

    rec.status = 'approved';
    rec.approvedWorkspaceId = workspaceId ?? null;
    rec.approvedUserId = userId;
    rec.approvedProfile = approvedProfile;
    rec.approvedAccess = approvedAccess;
    rec.approvedAgents = approvedAgents.map((a) => ({ id: a.id, name: a.name }));
    // Prevent re-lookup or double-approval by userCode once decided.
    this.byUserCode.delete(rec.userCode);

    return {
      approved: true,
      userCode: rec.userCode,
      clientName: rec.clientName,
      agents: rec.approvedAgents,
    };
  }

  denyByUserCode(rawUserCode, { workspaceId = null } = {}) {
    this._prune();
    const userCode = normalizeUserCode(rawUserCode);
    const rec = userCode ? this.byUserCode.get(userCode) : null;
    if (!rec || rec.status !== 'pending' || !this._workspaceAllowed(rec, workspaceId)) {
      throw deviceError(404, 'invalid_request', 'This device code is invalid or expired.');
    }
    rec.status = 'denied';
    this.byUserCode.delete(rec.userCode);
    return { denied: true };
  }

  pollDeviceToken(params, { expectedWorkspaceId = null } = {}) {
    const now = Date.now();
    this._prune(now);
    const grantType = String(params?.grant_type || '');
    if (grantType !== 'urn:ietf:params:oauth:grant-type:device_code') {
      throw deviceError(
        400,
        'unsupported_grant_type',
        'Only grant_type=urn:ietf:params:oauth:grant-type:device_code is supported.',
      );
    }
    const deviceCode = String(params?.device_code || '').trim();
    if (!deviceCode) {
      throw deviceError(400, 'invalid_request', 'device_code is required.');
    }
    const rec = this.byDeviceCode.get(deviceCode);
    if (!rec || rec.expiresAt <= now) {
      if (rec) {
        this.byDeviceCode.delete(deviceCode);
        this.byUserCode.delete(rec.userCode);
      }
      throw deviceError(400, 'expired_token', 'Device code has expired. Start connect again.');
    }
    if (expectedWorkspaceId !== null && rec.targetWorkspaceId !== null && rec.targetWorkspaceId !== expectedWorkspaceId) {
      throw deviceError(400, 'invalid_grant', 'Device code does not match this workspace.');
    }
    if (rec.status === 'denied') {
      this.byDeviceCode.delete(deviceCode);
      this.byUserCode.delete(rec.userCode);
      throw deviceError(400, 'access_denied', 'The user declined the device connection request.');
    }
    if (rec.status === 'pending') {
      if (rec.lastPollAt > 0 && now - rec.lastPollAt < this.minPollSpacingMs) {
        rec.intervalSec = Math.min(rec.intervalSec + 2, 15);
        rec.lastPollAt = now;
        throw deviceError(400, 'slow_down', 'Polling too quickly; wait before retrying.', {
          interval: rec.intervalSec,
        });
      }
      rec.lastPollAt = now;
      throw deviceError(400, 'authorization_pending', 'Waiting for owner approval in Loop.');
    }
    if (expectedWorkspaceId !== null && rec.approvedWorkspaceId !== expectedWorkspaceId) {
      this.byDeviceCode.delete(deviceCode);
      throw deviceError(400, 'invalid_grant', 'Device code does not match this workspace.');
    }

    // Consume atomically (single-use).
    this.byDeviceCode.delete(deviceCode);
    this.byUserCode.delete(rec.userCode);

    return {
      clientName: rec.clientName,
      pairedDevice: rec.pairedDevice,
      workspaceId: rec.approvedWorkspaceId,
      userId: rec.approvedUserId,
      profile: rec.approvedProfile,
      access: rec.approvedAccess,
      agents: rec.approvedAgents || rec.agents,
    };
  }
}
