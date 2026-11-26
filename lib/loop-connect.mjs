// Loop Connect: single source of truth in Loop Cloud (Memory, Skills, Vault, saved ToolSetups),
// machine-local installations on each computer, one active home per tool (Cloud or Local, never both),
// built-in outbound TLS relay with per-device Ed25519 identity + signed single-use CallTokens,
// 3-level remote access (local_only / ask_approval / remote_auto), and optional private tunnels
// (Tailscale / Cloudflare Tunnel).
//
// Free Local Loop never loads a token or starts any background network activity until the owner
// explicitly pairs the device with Loop Connect.

import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONNECT_MAX_DEVICES, EXTRA_DEVICE_PRICE_MONTHLY } from './billing.mjs';
import { atomicWriteFile, createWriteQueue } from './json-file-store.mjs';
import { isLoopbackHostname } from './outbound-policy.mjs';
import { assertPersonalConnection } from './personal-upstreams.mjs';
import { connectionMatchesProfile, normalizeItemProfiles, normalizeProfileTag } from './profiles.mjs';
import { connectionSecretKeys, maskSecrets } from './secret-refs.mjs';
import { isToolEnabled } from './store.mjs';
import {
  LocalInstallStore,
  ToolSetupError,
  ToolSetupStore,
  analyzeStdioPortability,
  defaultRemoteAccessFor,
  normalizeInstallSpec,
  normalizeRemoteAccess,
  slugifySetupId,
  validateDeviceNetworkConfig,
  validateRemoteAccess,
} from './tool-setups.mjs';

export const CONNECT_TOKEN_VAULT_KEY = '__loop_connect_token';
export const DEVICE_PRIV_VAULT_KEY = '__loop_device_ed25519_priv';
export const DEVICE_PUB_VAULT_KEY = '__loop_device_ed25519_pub';
export const RELAY_URL_PREFIX = 'https://relay.useloop.sh/d/';
export const CLOUD_ROUTE_URL_PREFIX = 'https://cloud.useloop.sh/c/';
const RELAY_URL_RE = /^https:\/\/relay\.useloop\.sh\/d\/(dev_[0-9a-f]{16})\/([a-z0-9][a-z0-9_]*)$/i;
const CLOUD_ROUTE_URL_RE = /^https:\/\/cloud\.useloop\.sh\/c\/([a-z0-9][a-z0-9_]*)$/i;
const CONNECT_TOKEN_RE = /^lpc_[A-Za-z0-9_-]{43}$/;
const PAIR_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const CALL_TOKEN_TTL_MS = 120 * 1000;
const DEVICE_SIG_WINDOW_MS = 5 * 60 * 1000;
const MAX_PENDING_PAIR_CODES = 500;
const DEFAULT_RELAY_CALL_TIMEOUT_MS = 25_000;
const DEFAULT_RELAY_POLL_HOLD_MS = 12_000;
const ONLINE_GRACE_MS = 45_000;
const WS_ID_RE = /^[0-9a-f]{64}$/;

const executionComputer = new AsyncLocalStorage();

export function withAgentComputer(options, run) {
  const bound = options.agent?.oauthClientId?.match(/^paired:(dev_[a-f0-9]{16}):/)?.[1] || null;
  return executionComputer.run({ bound, target: bound || options.executionDevice || null }, run);
}

export function isAgentsComputer(conn) {
  const id = parseRelayUrl(conn?.url)?.deviceId;
  return Boolean(id && executionComputer.getStore()?.bound === id);
}

export class LoopConnectError extends Error {
  constructor(message, status = 400, code = 'LOOP_CONNECT_ERROR', extra = {}) {
    super(message);
    this.name = 'LoopConnectError';
    this.status = status;
    this.code = code;
    this.publicMessage = message;
    Object.assign(this, extra);
  }
}

export function buildRelayUrl(deviceId, connId) {
  return `${RELAY_URL_PREFIX}${deviceId}/${connId}`;
}

export function parseRelayUrl(url) {
  if (typeof url !== 'string') return null;
  const m = RELAY_URL_RE.exec(url.trim());
  if (!m) return null;
  return { deviceId: m[1].toLowerCase(), connId: m[2] };
}

export function isRelayConnection(conn) {
  if (!conn || typeof conn !== 'object') return false;
  const transport = conn.transport ?? conn.type ?? 'http';
  if (transport !== 'http') return false;
  return parseRelayUrl(conn.url) !== null;
}

export function buildCloudRouteUrl(cloudConnId) {
  return `${CLOUD_ROUTE_URL_PREFIX}${cloudConnId}`;
}

export function parseCloudRouteUrl(url) {
  if (typeof url !== 'string') return null;
  const m = CLOUD_ROUTE_URL_RE.exec(url.trim());
  if (!m) return null;
  return { cloudConnId: m[1].toLowerCase() };
}

export function isCloudRouteConnection(conn) {
  if (!conn || typeof conn !== 'object') return false;
  return conn.home === 'cloud' && parseCloudRouteUrl(conn.url) !== null;
}

export function hashConnectToken(token) {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

export function fingerprintPublicKey(publicKeyPem) {
  if (typeof publicKeyPem !== 'string' || !publicKeyPem.trim()) return null;
  const digest = createHash('sha256').update(publicKeyPem.trim(), 'utf8').digest('hex').slice(0, 12);
  return `ed25519:${digest}`;
}

export function signDeviceRequest(privateKeyPem, method, pathAndQuery, timestampMs) {
  const payload = Buffer.from(`${String(method || 'GET').toUpperCase()}\n${String(pathAndQuery || '/')}\n${String(timestampMs)}`, 'utf8');
  return cryptoSign(null, payload, privateKeyPem).toString('base64url');
}

export function verifyDeviceSignature(publicKeyPem, method, pathAndQuery, timestampMs, signature, now = Date.now()) {
  if (!publicKeyPem || !signature) return false;
  const ts = Number(timestampMs);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > DEVICE_SIG_WINDOW_MS) return false;
  try {
    const payload = Buffer.from(`${String(method || 'GET').toUpperCase()}\n${String(pathAndQuery || '/')}\n${String(ts)}`, 'utf8');
    const sigBuf = Buffer.from(String(signature), 'base64url');
    return cryptoVerify(null, payload, publicKeyPem, sigBuf);
  } catch {
    return false;
  }
}

function issueConnectToken() {
  return `lpc_${randomBytes(32).toString('base64url')}`;
}

function generatePairCode() {
  const bytes = randomBytes(8);
  let raw = '';
  for (let i = 0; i < 8; i += 1) {
    raw += PAIR_CODE_CHARS[bytes[i] % PAIR_CODE_CHARS.length];
  }
  return `LP-${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

function normalizePairCode(raw) {
  const cleaned = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const stripped = cleaned.startsWith('LP') && cleaned.length === 10 ? cleaned.slice(2) : cleaned;
  if (stripped.length !== 8) return null;
  return `LP-${stripped.slice(0, 4)}-${stripped.slice(4, 8)}`;
}

function cleanText(value, max = 80, fallback = '') {
  const out = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return out || fallback;
}

function extractBearer(req) {
  const raw = req?.headers?.authorization;
  if (typeof raw !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return m ? m[1] : null;
}

export function validateCloudOrigin(rawUrl, { allowLoopbackHttp = false } = {}) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new LoopConnectError('Loop Cloud URL is required.', 400, 'INVALID_CLOUD_URL');
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new LoopConnectError('Invalid Loop Cloud URL.', 400, 'INVALID_CLOUD_URL');
  }
  if (parsed.username || parsed.password) {
    throw new LoopConnectError('Loop Cloud URL must not contain credentials.', 400, 'INVALID_CLOUD_URL');
  }
  if (parsed.protocol === 'https:') {
    return parsed.origin;
  }
  if (parsed.protocol === 'http:' && allowLoopbackHttp && isLoopbackHostname(parsed.hostname)) {
    return parsed.origin;
  }
  throw new LoopConnectError('Loop Cloud URL must use https://.', 400, 'INSECURE_CLOUD_URL');
}

function publicDevice(rec, now = Date.now(), defaultDeviceId = null) {
  const lastSeenMs = rec.lastSeenAt ? Date.parse(rec.lastSeenAt) : 0;
  return {
    id: rec.id,
    name: rec.name,
    platform: rec.platform || '',
    keyFingerprint: rec.keyFingerprint || fingerprintPublicKey(rec.publicKeyPem) || null,
    transportMode: rec.transportMode || 'loop_relay',
    tunnelEndpoint: rec.tunnelEndpoint || null,
    requirePrivateTunnel: Boolean(rec.requirePrivateTunnel),
    isDefault: Boolean(defaultDeviceId && rec.id === defaultDeviceId),
    createdAt: rec.createdAt,
    lastSeenAt: rec.lastSeenAt || null,
    lastSyncAt: rec.lastSyncAt || null,
    online: Number.isFinite(lastSeenMs) && lastSeenMs > 0 && now - lastSeenMs <= ONLINE_GRACE_MS,
  };
}

// Resolves `lpc_...` device tokens to `{ workspaceKey, deviceId }` across hosted workspaces.
export class ConnectTokenRouter {
  constructor(baseDir, { rescanMs = 2000 } = {}) {
    this.baseDir = path.resolve(baseDir);
    this.usersDir = path.join(this.baseDir, 'user-workspaces');
    this.rescanMs = rescanMs;
    this.byHash = new Map();
    this.lastScan = 0;
    this._scan = null;
  }

  remember(token, workspaceKey, deviceId) {
    if (CONNECT_TOKEN_RE.test(String(token || '')) && workspaceKey && deviceId) {
      this.byHash.set(hashConnectToken(token), { workspaceKey, deviceId });
    }
  }

  forgetHash(tokenHash) {
    if (tokenHash) this.byHash.delete(tokenHash);
  }

  async _scanWorkspaceFile(filePath, workspaceKey, next) {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      for (const dev of Array.isArray(parsed?.devices) ? parsed.devices : []) {
        if (typeof dev?.tokenHash === 'string' && dev.id) {
          next.set(dev.tokenHash, { workspaceKey, deviceId: dev.id });
        }
      }
    } catch {
      // Ignore missing or mid-write workspace files.
    }
  }

  async _rescan() {
    const next = new Map();
    await this._scanWorkspaceFile(path.join(this.baseDir, 'loop-connect-devices.json'), 'local', next);
    let dirs = [];
    try {
      dirs = await readdir(this.usersDir);
    } catch {
      dirs = [];
    }
    for (const id of dirs) {
      if (!WS_ID_RE.test(id)) continue;
      await this._scanWorkspaceFile(path.join(this.usersDir, id, 'loop-connect-devices.json'), id, next);
    }
    this.byHash = next;
    this.lastScan = Date.now();
  }

  async resolve(token) {
    if (typeof token !== 'string' || !CONNECT_TOKEN_RE.test(token)) return null;
    const hash = hashConnectToken(token);
    if (this.byHash.has(hash)) return this.byHash.get(hash);
    if (Date.now() - this.lastScan >= this.rescanMs) {
      if (!this._scan) this._scan = this._rescan().finally(() => { this._scan = null; });
      await this._scan;
    }
    return this.byHash.get(hash) || null;
  }
}

async function readDevicesDoc(wsDir) {
  const file = path.join(wsDir, 'loop-connect-devices.json');
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.devices)) {
      return {
        version: 2,
        defaultDeviceId: typeof parsed.defaultDeviceId === 'string' && parsed.defaultDeviceId ? parsed.defaultDeviceId : null,
        devices: parsed.devices,
      };
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn(`[loop-connect] Could not read ${file}: ${err.message}`);
    }
  }
  return { version: 2, defaultDeviceId: null, devices: [] };
}

async function writeDevicesDoc(wsDir, doc) {
  const file = path.join(wsDir, 'loop-connect-devices.json');
  await atomicWriteFile(file, JSON.stringify({
    version: 2,
    defaultDeviceId: doc.defaultDeviceId || null,
    devices: Array.isArray(doc.devices) ? doc.devices : [],
  }, null, 2) + '\n', { mode: 0o600, backup: true });
}

function publishedTools(conn) {
  return (conn.tools || []).filter((tool) => isToolEnabled(conn, tool.name));
}

function permitsRelayTool(conn, name, sameDevice = false) {
  if (!conn || conn.enabled === false) return false;
  if (!sameDevice && defaultRemoteAccessFor(conn) === 'local_only') return false;
  return isToolEnabled(conn, name) && conn.tools?.some((tool) => tool.name === name);
}

function projectRelay(conn, entry, sameDevice = false) {
  if (!entry || !Array.isArray(entry.tools) || !Array.isArray(entry.profiles) || !conn.enabled) return null;
  if (!sameDevice && (entry.remoteAccess === 'local_only' || conn.remoteAccess === 'local_only')) return null;
  const names = new Set(entry.tools);
  const tools = publishedTools(conn).filter((tool) => names.has(tool.name));
  return {
    ...conn,
    ...(entry.remoteAccess ? { remoteAccess: entry.remoteAccess } : {}),
    tools,
    toolNames: tools.map((tool) => tool.name),
    profiles: (conn.profiles || []).filter((profile) => entry.profiles.includes(profile)),
  };
}

function cloudRouteToVirtualConn(route) {
  const tools = Array.isArray(route.tools) ? route.tools : [];
  return {
    id: route.id,
    name: route.name || route.id,
    description: route.description || '',
    transport: 'http',
    url: buildCloudRouteUrl(route.cloudConnId || route.id),
    home: 'cloud',
    cloudConnId: route.cloudConnId || route.id,
    headers: {},
    command: null,
    args: [],
    env: {},
    cwd: null,
    profiles: normalizeItemProfiles(route.profiles),
    enabled: route.enabled !== false,
    disabledTools: Array.isArray(route.disabledTools) ? route.disabledTools : [],
    allowedTools: null,
    pinnedTools: [],
    pinsCustomized: false,
    tools,
    toolNames: tools.map((t) => t.name),
    resources: [],
    prompts: [],
    authRequired: false,
    lastSyncAt: route.movedAt || new Date().toISOString(),
    lastError: null,
  };
}

// Request-local catalog view:
// - Filters relayed connections through the live source device catalog (hiding offline & local_only tools).
// - Merges Cloud-homed tools (`cloudRoutes`) into the single local Loop bridge without keeping duplicate local copies.
export function relayCatalogView(store, dispatcher) {
  if (!dispatcher?.catalogFor && !dispatcher?.listCloudRoutes) return store;
  const catalogs = new Map();
  async function visible(conn) {
    const relay = parseRelayUrl(conn?.url);
    if (!relay) return conn;
    const device = executionComputer.getStore();
    if (device?.target && device.target !== relay.deviceId) return null;
    if (!dispatcher?.catalogFor) return conn;
    if (!catalogs.has(relay.deviceId)) {
      catalogs.set(relay.deviceId, dispatcher.catalogFor(relay.deviceId).catch(() => ({})));
    }
    const catalog = await catalogs.get(relay.deviceId);
    return projectRelay(conn, catalog?.[relay.connId], device?.bound === relay.deviceId);
  }
  async function loadCloudRoutes() {
    if (typeof dispatcher?.listCloudRoutes !== 'function') return [];
    const routes = await dispatcher.listCloudRoutes().catch(() => []);
    return (Array.isArray(routes) ? routes : []).filter((r) => r && r.enabled !== false).map(cloudRouteToVirtualConn);
  }
  return new Proxy(store, {
    get(target, key) {
      if (key === 'list') {
        return async (...args) => {
          const [rawList, cloudConns] = await Promise.all([target.list(...args), loadCloudRoutes()]);
          const resolved = (await Promise.all(rawList.map(visible))).filter(Boolean);
          const existingIds = new Set(resolved.map((c) => c.id));
          for (const cc of cloudConns) {
            if (!existingIds.has(cc.id)) resolved.push(cc);
          }
          return resolved;
        };
      }
      if (key === 'get') {
        return async (id) => {
          const found = await target.get(id);
          if (found) return visible(found);
          const cloudConns = await loadCloudRoutes();
          return cloudConns.find((c) => c.id === id) || null;
        };
      }
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function getToolSetupStore(wsCtx) {
  if (wsCtx?.toolSetupStore) return wsCtx.toolSetupStore;
  return new ToolSetupStore(wsCtx.dataDir);
}

function getLocalInstallStore(wsCtx) {
  if (wsCtx?.localInstallStore) return wsCtx.localInstallStore;
  return new LocalInstallStore(wsCtx.dataDir);
}

function deviceCatalogRow(conn) {
  const { id, name, description, profiles, enabled, command, args, env, cwd, installSpec } = conn;
  const portable = analyzeStdioPortability({ name, command, args, env, cwd, installSpec });
  return {
    id, setupId: slugifySetupId(conn.toolSetupId || id), name, description,
    profiles: normalizeItemProfiles(profiles), enabled: enabled !== false,
    remoteAccess: defaultRemoteAccessFor(conn), tools: publishedTools(conn),
    ready: Boolean(conn.lastSyncAt && !conn.lastError), installSpec: portable.installSpec,
    reason: portable.reason,
  };
}

async function registerDeviceCatalog(ws, device, entries) {
  if (!Array.isArray(entries) || entries.length > 1000) throw new LoopConnectError('Invalid device catalog.');
  const setups = getToolSetupStore(ws);
  const existing = (await ws.store.list()).filter(c => parseRelayUrl(c.url)?.deviceId === device.id);
  const active = new Set();
  for (const row of entries) {
    if (!row || !/^[a-z0-9][a-z0-9_]{0,99}$/.test(row.id) || !Array.isArray(row.tools)) throw new LoopConnectError('Invalid device tool.');
    const name = cleanText(row.name, 80, row.id);
    const profiles = normalizeItemProfiles(row.profiles);
    const remoteAccess = validateRemoteAccess(row.remoteAccess);
    const setup = await setups.upsert({
      id: slugifySetupId(row.setupId || row.id), name, description: cleanText(row.description, 400), profiles,
      home: 'local', remoteAccess, enabled: true, originDeviceId: device.id, originDeviceName: device.name,
      portable: Boolean(row.installSpec), installSpec: row.installSpec || null, nonPortableReason: cleanText(row.reason, 300),
    }, { discoverOnly: true });
    if (!setup || setup.home !== 'local') continue;
    const url = buildRelayUrl(device.id, row.id);
    active.add(url);
    if (row.ready !== true || !row.enabled) continue;
    await setups.recordDeviceInstall(setup.id, device.id, { status: 'ready', step: 'ready', toolCount: row.tools.length, version: setup.installSpec?.version });
    if (!setup.enabled) continue;
    const conn = existing.find(c => c.url === url);
    const catalog = { tools: row.tools, lastSyncAt: new Date().toISOString(), lastError: null };
    if (conn) {
      // An inventory refresh cannot change permissions edited in the cloud.
      await ws.store.update(conn.id, catalog);
    } else {
      await ws.store.add({ name: name + ' (' + device.name + ')', transport: 'http', url,
        description: cleanText(row.description, 400), toolSetupId: setup.id, remoteAccess: setup.remoteAccess, profiles: setup.profiles, ...catalog });
    }
  }
  for (const conn of existing) if (!active.has(conn.url)) await ws.store.remove(conn.id);
  ws.broadcast?.('connections');
}

// Hosted Loop Connect Coordinator (lives on `startServer` for `useloop.sh`).
export class LoopConnectServer {
  constructor(
    baseDir,
    {
      relayCallTimeoutMs = DEFAULT_RELAY_CALL_TIMEOUT_MS,
      pollHoldMs = DEFAULT_RELAY_POLL_HOLD_MS,
      tunnelFetch = null,
      allowLoopbackTunnel = false,
      signingSecret = null,
    } = {},
  ) {
    this.baseDir = path.resolve(baseDir);
    this.router = new ConnectTokenRouter(this.baseDir);
    this.relayCallTimeoutMs = relayCallTimeoutMs;
    this.pollHoldMs = pollHoldMs;
    this.tunnelFetch = typeof tunnelFetch === 'function' ? tunnelFetch : null;
    this.allowLoopbackTunnel = Boolean(allowLoopbackTunnel);
    this._signingSecret = typeof signingSecret === 'string' && signingSecret
      ? signingSecret
      : randomBytes(32).toString('hex');
    this._consumedTokenJtis = new Map(); // jti -> expiresAt
    this._pendingInstallByKey = new Map(); // `${workspaceKey}:${deviceId}:${setupId}:${idem}` -> Promise
    this._pendingAppInstalls = new Map(); // token -> { workspaceKey, setupId, expiresAt }
    this._memoryIdempotency = new Map(); // `${workspaceKey}:${idem}` -> memoryId
    this._locks = new Map(); // wsDir -> writeQueue
    this._pairCodes = new Map(); // normalizedCode -> { workspaceKey, expiresAt, pendingSetupId? }
    this._pendingRelay = new Map(); // deviceId -> Array<entry>
    this._inFlightRelay = new Map(); // callId -> entry
    this._pollWaiters = new Map(); // deviceId -> Set<() => void>
  }

  _lockFor(wsDir) {
    const key = path.resolve(wsDir);
    if (!this._locks.has(key)) this._locks.set(key, createWriteQueue());
    return this._locks.get(key);
  }

  _prunePairCodes(now = Date.now()) {
    for (const [code, entry] of this._pairCodes) {
      if (entry.expiresAt <= now) this._pairCodes.delete(code);
    }
    for (const [jti, exp] of this._consumedTokenJtis) {
      if (exp <= now) this._consumedTokenJtis.delete(jti);
    }
    for (const [tok, entry] of this._pendingAppInstalls) {
      if (entry.expiresAt <= now) this._pendingAppInstalls.delete(tok);
    }
  }

  // Mints a short-lived, single-use HMAC-SHA256 CallToken bound to user/workspace, device, target, and version/hash.
  mintCallToken({
    kind = 'tool_call',
    workspaceKey = 'local',
    deviceId,
    targetId,
    version = null,
    sha256 = null,
    idempotencyKey = null,
    ttlMs = CALL_TOKEN_TTL_MS,
  }) {
    const now = Date.now();
    const payload = {
      v: 1,
      jti: `ct_${randomBytes(12).toString('hex')}`,
      kind,
      workspaceKey,
      deviceId,
      targetId,
      ...(version ? { version } : {}),
      ...(sha256 ? { sha256 } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      iat: now,
      exp: now + Math.max(1000, Number(ttlMs) || CALL_TOKEN_TTL_MS),
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = createHmac('sha256', this._signingSecret).update(encoded, 'utf8').digest('base64url');
    return `${encoded}.${sig}`;
  }

  // Verifies signature, expiry, bindings, and single-use replay protection.
  verifyCallToken(
    token,
    {
      consume = true,
      expectedKind = null,
      expectedDeviceId = null,
      expectedTargetId = null,
      expectedWorkspaceKey = null,
      now = Date.now(),
    } = {},
  ) {
    this._prunePairCodes(now);
    if (typeof token !== 'string' || !token.includes('.')) {
      throw new LoopConnectError('Missing or malformed CallToken.', 401, 'INVALID_CALL_TOKEN');
    }
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new LoopConnectError('Malformed CallToken.', 401, 'INVALID_CALL_TOKEN');
    }
    const [encoded, sig] = parts;
    const expectedSig = createHmac('sha256', this._signingSecret).update(encoded, 'utf8').digest('base64url');
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expectedSig, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new LoopConnectError('CallToken signature is invalid.', 401, 'INVALID_CALL_TOKEN');
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      throw new LoopConnectError('CallToken payload is unreadable.', 401, 'INVALID_CALL_TOKEN');
    }
    if (!payload || typeof payload !== 'object' || !payload.jti || !Number.isFinite(payload.exp)) {
      throw new LoopConnectError('CallToken payload is incomplete.', 401, 'INVALID_CALL_TOKEN');
    }
    if (payload.exp <= now) {
      throw new LoopConnectError('CallToken has expired.', 401, 'EXPIRED_CALL_TOKEN');
    }
    if (this._consumedTokenJtis.has(payload.jti)) {
      throw new LoopConnectError('CallToken has already been used.', 409, 'REPLAYED_CALL_TOKEN');
    }
    if (expectedKind && payload.kind !== expectedKind) {
      throw new LoopConnectError('CallToken kind does not match this operation.', 403, 'CALL_TOKEN_MISMATCH');
    }
    if (expectedDeviceId && payload.deviceId !== expectedDeviceId) {
      throw new LoopConnectError('CallToken is bound to a different computer.', 403, 'CALL_TOKEN_MISMATCH');
    }
    if (expectedTargetId && payload.targetId !== expectedTargetId) {
      throw new LoopConnectError('CallToken is bound to a different tool.', 403, 'CALL_TOKEN_MISMATCH');
    }
    if (expectedWorkspaceKey && payload.workspaceKey !== expectedWorkspaceKey) {
      throw new LoopConnectError('CallToken is bound to a different account.', 403, 'CALL_TOKEN_MISMATCH');
    }
    if (consume) {
      this._consumedTokenJtis.set(payload.jti, payload.exp);
    }
    return payload;
  }

  async listDevices(wsDir) {
    const doc = await readDevicesDoc(wsDir);
    const now = Date.now();
    return doc.devices.map((d) => publicDevice(d, now, doc.defaultDeviceId));
  }

  async getDevicesInfo(wsDir) {
    const doc = await readDevicesDoc(wsDir);
    const now = Date.now();
    return {
      defaultDeviceId: doc.defaultDeviceId || null,
      devices: doc.devices.map((d) => publicDevice(d, now, doc.defaultDeviceId)),
    };
  }

  async setDefaultDevice(wsDir, deviceId) {
    const lock = this._lockFor(wsDir);
    return lock(async () => {
      const doc = await readDevicesDoc(wsDir);
      if (deviceId === null || deviceId === '') {
        doc.defaultDeviceId = null;
        await writeDevicesDoc(wsDir, doc);
        return { defaultDeviceId: null, devices: doc.devices.map((d) => publicDevice(d, Date.now(), null)) };
      }
      const found = doc.devices.find((d) => d.id === deviceId);
      if (!found) {
        throw new LoopConnectError('Device not found.', 404, 'DEVICE_NOT_FOUND');
      }
      doc.defaultDeviceId = found.id;
      await writeDevicesDoc(wsDir, doc);
      return {
        defaultDeviceId: doc.defaultDeviceId,
        devices: doc.devices.map((d) => publicDevice(d, Date.now(), doc.defaultDeviceId)),
      };
    });
  }

  async updateDeviceNetwork(wsDir, deviceId, networkInput) {
    const validated = validateDeviceNetworkConfig(networkInput, {
      allowLoopbackHttp: this.allowLoopbackTunnel || process.env.LOOP_ALLOW_INSECURE_CONNECT === '1',
    });
    const lock = this._lockFor(wsDir);
    return lock(async () => {
      const doc = await readDevicesDoc(wsDir);
      const dev = doc.devices.find((d) => d.id === deviceId);
      if (!dev) {
        throw new LoopConnectError('Device not found.', 404, 'DEVICE_NOT_FOUND');
      }
      dev.transportMode = validated.transportMode;
      dev.tunnelEndpoint = validated.tunnelEndpoint;
      dev.requirePrivateTunnel = validated.requirePrivateTunnel;
      await writeDevicesDoc(wsDir, doc);
      return publicDevice(dev, Date.now(), doc.defaultDeviceId);
    });
  }

  async resolveTargetDevice(wsCtx, { setupId, requestedDeviceId = null } = {}) {
    const doc = await readDevicesDoc(wsCtx.dataDir);
    const now = Date.now();
    const setupStore = getToolSetupStore(wsCtx);
    const setup = setupId ? await setupStore.get(setupId).catch(() => null) : null;
    const cleanSetupId = slugifySetupId(setupId || '');
    const conns = await wsCtx.store.list().catch(() => []);

    const isOnline = (dev) => {
      const lastSeenMs = dev.lastSeenAt ? Date.parse(dev.lastSeenAt) : 0;
      const hasWaiter = (this._pollWaiters.get(dev.id)?.size || 0) > 0;
      return hasWaiter || (Number.isFinite(lastSeenMs) && lastSeenMs > 0 && now - lastSeenMs <= ONLINE_GRACE_MS);
    };

    const deviceHasTool = (dev) => {
      if (setup?.installations?.[dev.id]?.status === 'ready') return true;
      return conns.some((c) => {
        const rel = parseRelayUrl(c.url);
        return rel && rel.deviceId === dev.id && (rel.connId === cleanSetupId || c.toolSetupId === cleanSetupId);
      });
    };

    if (requestedDeviceId) {
      const target = doc.devices.find((d) => d.id === requestedDeviceId);
      if (!target) {
        throw new LoopConnectError('Selected computer was not found.', 404, 'DEVICE_NOT_FOUND');
      }
      if (!isOnline(target)) {
        throw new LoopConnectError(
          `Computer "${target.name}" is currently offline. Turn it on or choose another computer.`,
          503,
          'DEVICE_OFFLINE',
          { deviceId: target.id, deviceName: target.name },
        );
      }
      return { resolved: true, device: publicDevice(target, now, doc.defaultDeviceId) };
    }

    const candidates = doc.devices.filter(deviceHasTool);
    if (candidates.length === 0) {
      return {
        resolved: false,
        ambiguous: false,
        needsInstall: true,
        candidates: doc.devices.map((d) => publicDevice(d, now, doc.defaultDeviceId)),
        message: `No computer has "${setup?.name || cleanSetupId}" installed yet. Click Install on one of your computers.`,
      };
    }

    // Default computer rule: honor user's default computer if it has the tool (fail closed if offline!)
    if (doc.defaultDeviceId) {
      const def = candidates.find((d) => d.id === doc.defaultDeviceId);
      if (def) {
        if (!isOnline(def)) {
          throw new LoopConnectError(
            `Default computer "${def.name}" is currently offline. Turn it on or pick another computer.`,
            503,
            'DEVICE_OFFLINE',
            { deviceId: def.id, deviceName: def.name },
          );
        }
        return { resolved: true, device: publicDevice(def, now, doc.defaultDeviceId) };
      }
    }

    const onlineCandidates = candidates.filter(isOnline);
    if (onlineCandidates.length === 0) {
      const names = candidates.map((d) => d.name).join(', ');
      throw new LoopConnectError(
        `No computer with "${setup?.name || cleanSetupId}" is online (${names} offline).`,
        503,
        'DEVICE_OFFLINE',
      );
    }
    if (onlineCandidates.length === 1) {
      return { resolved: true, device: publicDevice(onlineCandidates[0], now, doc.defaultDeviceId) };
    }

    return {
      resolved: false,
      ambiguous: true,
      candidates: onlineCandidates.map((d) => publicDevice(d, now, doc.defaultDeviceId)),
      message: `Choose which computer to run "${setup?.name || cleanSetupId}" on: ${onlineCandidates.map((d) => d.name).join(', ')}.`,
    };
  }

  async createPairCode({ workspaceKey, wsDir, maxDevices = DEFAULT_CONNECT_MAX_DEVICES, pendingSetupId = null }) {
    this._prunePairCodes();
    const doc = await readDevicesDoc(wsDir);
    if (maxDevices !== null && doc.devices.length >= maxDevices) {
      throw new LoopConnectError(
        `Your plan currently has ${maxDevices} connected device slots (${doc.devices.length}/${maxDevices} in use). Add an extra device (+$${EXTRA_DEVICE_PRICE_MONTHLY}/mo) in Settings → Plan or disconnect an existing device.`,
        403,
        'DEVICE_LIMIT_REACHED',
        {
          maxDevices,
          currentDevices: doc.devices.length,
          canAddDeviceSlot: true,
          extraDevicePriceMonthly: EXTRA_DEVICE_PRICE_MONTHLY,
        },
      );
    }
    if (this._pairCodes.size >= MAX_PENDING_PAIR_CODES) {
      throw new LoopConnectError('Too many pending pairing codes. Try again shortly.', 429, 'RATE_LIMITED');
    }
    let code = generatePairCode();
    while (this._pairCodes.has(code)) code = generatePairCode();
    const expiresAt = Date.now() + PAIR_CODE_TTL_MS;
    this._pairCodes.set(code, {
      workspaceKey,
      expiresAt,
      ...(pendingSetupId ? { pendingSetupId: slugifySetupId(pendingSetupId) } : {}),
    });
    return {
      code,
      expiresAt: new Date(expiresAt).toISOString(),
      ...(pendingSetupId ? { pendingSetupId: slugifySetupId(pendingSetupId) } : {}),
    };
  }

  async redeemPairCode({ code, name, platform, deviceId: existingId, publicKeyPem = null, resolveWorkspace }) {
    this._prunePairCodes();
    const normalized = normalizePairCode(code);
    if (!normalized) {
      throw new LoopConnectError('Enter a valid pairing code (e.g. LP-ABCD-2345).', 400, 'INVALID_PAIR_CODE');
    }
    const pending = this._pairCodes.get(normalized);
    if (!pending || pending.expiresAt <= Date.now()) {
      this._pairCodes.delete(normalized);
      throw new LoopConnectError('This pairing code is invalid or has expired. Generate a new code in Loop.', 400, 'EXPIRED_PAIR_CODE');
    }
    // Single-use consumption before async work
    this._pairCodes.delete(normalized);

    const resolved = await resolveWorkspace(pending.workspaceKey);
    if (!resolved || !resolved.wsCtx) {
      throw new LoopConnectError('Target Loop Cloud workspace was not found.', 404, 'WORKSPACE_NOT_FOUND');
    }
    if (!resolved.loopConnectActive) {
      throw new LoopConnectError(
        'An active Loop Connect subscription is required to pair devices.',
        402,
        'UPGRADE_REQUIRED',
        { upgradeRequired: true },
      );
    }

    let cleanPubKey = null;
    if (typeof publicKeyPem === 'string' && publicKeyPem.trim()) {
      if (!publicKeyPem.includes('BEGIN PUBLIC KEY') || publicKeyPem.length > 2048) {
        throw new LoopConnectError('Invalid device public key.', 400, 'INVALID_DEVICE_KEY');
      }
      cleanPubKey = publicKeyPem.trim();
    }

    const maxDevices = resolved.maxDevices === undefined ? DEFAULT_CONNECT_MAX_DEVICES : resolved.maxDevices;
    const wsDir = resolved.wsCtx.dataDir;
    const lock = this._lockFor(wsDir);

    return lock(async () => {
      const doc = await readDevicesDoc(wsDir);
      const matchIdx = typeof existingId === 'string'
        ? doc.devices.findIndex((d) => d.id === existingId)
        : -1;

      if (matchIdx === -1 && maxDevices !== null && doc.devices.length >= maxDevices) {
        throw new LoopConnectError(
          `Your plan currently has ${maxDevices} connected device slots (${doc.devices.length}/${maxDevices} in use). Add an extra device (+$${EXTRA_DEVICE_PRICE_MONTHLY}/mo) in Settings → Plan or disconnect an existing device.`,
          403,
          'DEVICE_LIMIT_REACHED',
          {
            maxDevices,
            currentDevices: doc.devices.length,
            canAddDeviceSlot: true,
            extraDevicePriceMonthly: EXTRA_DEVICE_PRICE_MONTHLY,
          },
        );
      }

      const token = issueConnectToken();
      const tokenHash = hashConnectToken(token);
      const nowIso = new Date().toISOString();
      const cleanName = cleanText(name, 80, 'Loop Device');
      const cleanPlat = cleanText(platform, 40, '');
      const keyFingerprint = cleanPubKey ? fingerprintPublicKey(cleanPubKey) : null;

      let rec;
      if (matchIdx !== -1) {
        const prev = doc.devices[matchIdx];
        this.router.forgetHash(prev.tokenHash);
        rec = {
          ...prev,
          name: cleanName,
          platform: cleanPlat || prev.platform || '',
          tokenHash,
          ...(cleanPubKey ? { publicKeyPem: cleanPubKey, keyFingerprint } : {}),
          transportMode: prev.transportMode || 'loop_relay',
          tunnelEndpoint: prev.tunnelEndpoint || null,
          requirePrivateTunnel: Boolean(prev.requirePrivateTunnel),
          lastSeenAt: nowIso,
        };
        doc.devices[matchIdx] = rec;
      } else {
        rec = {
          id: `dev_${randomBytes(8).toString('hex')}`,
          name: cleanName,
          platform: cleanPlat,
          tokenHash,
          publicKeyPem: cleanPubKey,
          keyFingerprint,
          transportMode: 'loop_relay',
          tunnelEndpoint: null,
          requirePrivateTunnel: false,
          createdAt: nowIso,
          lastSeenAt: nowIso,
          lastSyncAt: null,
        };
        doc.devices.push(rec);
      }

      if (!doc.defaultDeviceId && doc.devices.length === 1) {
        doc.defaultDeviceId = rec.id;
      }

      await writeDevicesDoc(wsDir, doc);
      this.router.remember(token, pending.workspaceKey, rec.id);
      return {
        workspaceKey: pending.workspaceKey,
        device: publicDevice(rec, Date.now(), doc.defaultDeviceId),
        token,
        ...(pending.pendingSetupId ? { pendingSetupId: pending.pendingSetupId } : {}),
      };
    });
  }

  async authenticateDevice(req, resolveWorkspace) {
    const token = extractBearer(req);
    if (!token || !CONNECT_TOKEN_RE.test(token)) {
      throw new LoopConnectError('Valid Loop Connect device token required.', 401, 'UNAUTHORIZED');
    }
    const route = await this.router.resolve(token);
    if (!route) {
      throw new LoopConnectError('Device is disconnected or unrecognized.', 401, 'UNAUTHORIZED');
    }
    const resolved = await resolveWorkspace(route.workspaceKey);
    if (!resolved?.wsCtx) {
      throw new LoopConnectError('Workspace not found.', 401, 'UNAUTHORIZED');
    }
    const wsDir = resolved.wsCtx.dataDir;
    const doc = await readDevicesDoc(wsDir);
    const expectedHash = hashConnectToken(token);
    const dev = doc.devices.find((d) => {
      if (d.id !== route.deviceId || typeof d.tokenHash !== 'string' || d.tokenHash.length !== expectedHash.length) {
        return false;
      }
      return timingSafeEqual(Buffer.from(d.tokenHash, 'utf8'), Buffer.from(expectedHash, 'utf8'));
    });
    if (!dev) {
      this.router.forgetHash(expectedHash);
      throw new LoopConnectError('Device access has been revoked.', 401, 'UNAUTHORIZED');
    }
    // Verify per-device Ed25519 signature whenever the device registered a public key.
    if (dev.publicKeyPem) {
      const tsHeader = req?.headers?.['x-loop-device-ts'];
      const sigHeader = req?.headers?.['x-loop-device-sig'];
      if (!tsHeader || !sigHeader || !verifyDeviceSignature(dev.publicKeyPem, req.method, req.url, tsHeader, sigHeader)) {
        throw new LoopConnectError('Device cryptographic signature verification failed.', 401, 'INVALID_DEVICE_SIGNATURE');
      }
    }
    if (!resolved.loopConnectActive) {
      throw new LoopConnectError(
        'Loop Connect subscription is inactive. Renew in Settings → Plan to use this paired computer.',
        402,
        'UPGRADE_REQUIRED',
        { upgradeRequired: true },
      );
    }
    return { workspaceKey: route.workspaceKey, device: dev, wsCtx: resolved.wsCtx, maxDevices: resolved.maxDevices };
  }

  async touchDevice(wsDir, deviceId, { synced = false } = {}) {
    if (!this._lastTouchAt) this._lastTouchAt = new Map();
    const touchKey = `${wsDir}\0${deviceId}`;
    const nowMs = Date.now();
    const prevTouch = this._lastTouchAt.get(touchKey) || 0;
    if (!synced && prevTouch && nowMs - prevTouch < 60_000) {
      return null;
    }
    this._lastTouchAt.set(touchKey, nowMs);
    if (this._lastTouchAt.size > 4096) {
      const oldest = this._lastTouchAt.keys().next().value;
      if (oldest !== undefined) this._lastTouchAt.delete(oldest);
    }
    const lock = this._lockFor(wsDir);
    return lock(async () => {
      const doc = await readDevicesDoc(wsDir);
      const dev = doc.devices.find((d) => d.id === deviceId);
      if (!dev) return null;
      const nowIso = new Date().toISOString();
      dev.lastSeenAt = nowIso;
      if (synced) dev.lastSyncAt = nowIso;
      await writeDevicesDoc(wsDir, doc);
      return dev;
    });
  }

  async removeDevice({ wsCtx, deviceId }) {
    const wsDir = wsCtx.dataDir;
    const lock = this._lockFor(wsDir);
    const removed = await lock(async () => {
      const doc = await readDevicesDoc(wsDir);
      const idx = doc.devices.findIndex((d) => d.id === deviceId);
      if (idx === -1) return null;
      const [gone] = doc.devices.splice(idx, 1);
      if (doc.defaultDeviceId === deviceId) {
        doc.defaultDeviceId = doc.devices[0]?.id || null;
      }
      await writeDevicesDoc(wsDir, doc);
      this.router.forgetHash(gone.tokenHash);
      return gone;
    });
    if (!removed) return false;

    // Drop any relayed stdio connections belonging to the disconnected device
    const prefix = `${RELAY_URL_PREFIX}${deviceId}/`;
    const conns = await wsCtx.store.list().catch(() => []);
    let droppedAny = false;
    for (const c of conns) {
      if (typeof c.url === 'string' && c.url.startsWith(prefix)) {
        await wsCtx.store.remove(c.id).catch(() => {});
        droppedAny = true;
      }
    }
    if (droppedAny) wsCtx.broadcast?.('connections');
    this._failDeviceRelayCalls(deviceId, 'Device was disconnected from Loop Connect.');
    return true;
  }

  _failDeviceRelayCalls(deviceId, reason) {
    const queue = this._pendingRelay.get(deviceId) || [];
    this._pendingRelay.delete(deviceId);
    for (const item of queue) {
      clearTimeout(item.timer);
      this._inFlightRelay.delete(item.callId);
      item.reject(new Error(reason));
    }
    for (const [callId, entry] of this._inFlightRelay) {
      if (entry.deviceId === deviceId) {
        clearTimeout(entry.timer);
        this._inFlightRelay.delete(callId);
        entry.reject(new Error(reason));
      }
    }
  }

  // Creates a `relayDispatcher` passed into hosted `ConnectionPool` so hosted `/mcp` can execute
  // relayed `stdio` tools on the paired local device seamlessly (respecting 3-level remoteAccess
  // and optional private tunnel configuration).
  createHostedRelayDispatcher(wsDir, workspaceKey = 'local') {
    return {
      handles: (conn) => isRelayConnection(conn),
      catalogFor: async (deviceId) => {
        const doc = await readDevicesDoc(wsDir);
        if (!doc.devices.some((device) => device.id === deviceId)) return {};
        return this.dispatchRelayCall(deviceId, '', '', {}, { catalog: true, payload: { sameDevice: executionComputer.getStore()?.bound === deviceId }, signal: AbortSignal.timeout(2500) });
      },
      callTool: async (conn, toolName, args = {}, { extraSecrets = [], signal = null, profile = 'all', ownerApproved = false } = {}) => {
        const parsed = parseRelayUrl(conn?.url);
        if (!parsed) throw new Error('Invalid Loop Connect relay URL.');
        const scope = executionComputer.getStore();
        const sameDevice = scope?.bound === parsed.deviceId;
        if (scope?.target && scope.target !== parsed.deviceId) throw new Error('Tool unavailable on this computer.');
        if (!sameDevice && conn?.remoteAccess === 'local_only') {
          throw new Error(`"${conn.name || parsed.connId}" is set to "This computer only" and does not allow remote calls.`);
        }
        const doc = await readDevicesDoc(wsDir);
        const dev = doc.devices.find((d) => d.id === parsed.deviceId);
        if (!dev) {
          throw new Error('The paired device for this local connection is no longer connected.');
        }

        const callToken = this.mintCallToken({
          kind: 'tool_call',
          workspaceKey,
          deviceId: parsed.deviceId,
          targetId: `${parsed.connId}__${toolName}`,
        });

        // Optional private tunnel transport (Tailscale / Cloudflare Tunnel) when configured on the device.
        if ((!sameDevice || dev.requirePrivateTunnel) && (dev.transportMode === 'tailscale' || dev.transportMode === 'cloudflare_tunnel') && dev.tunnelEndpoint) {
          const fetcher = this.tunnelFetch;
          if (fetcher) {
            try {
              const res = await fetcher(`${dev.tunnelEndpoint}/api/local/tunnel/invoke`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Loop-Call-Token': callToken,
                  'X-Loop-Device-Id': dev.id,
                },
                body: JSON.stringify({
                  connId: parsed.connId,
                  toolName,
                  arguments: args || {},
                  profile,
                  extraSecrets,
                  ownerApproved: Boolean(ownerApproved),
                }),
                ...(signal ? { signal } : {}),
              });
              const json = await res.json().catch(() => ({}));
              if (res.ok && Object.hasOwn(json, 'result')) {
                return maskSecrets(json.result, extraSecrets);
              }
              if (dev.requirePrivateTunnel) {
                throw new Error(json?.error || `Private ${dev.transportMode} tunnel call failed (${res.status}).`);
              }
            } catch (err) {
              if (dev.requirePrivateTunnel) {
                throw new Error(maskSecrets(err?.message || `Private ${dev.transportMode} tunnel is unreachable.`, extraSecrets));
              }
              // Fall through to built-in outbound TLS relay when private tunnel is optional.
            }
          } else if (dev.requirePrivateTunnel) {
            throw new Error(`Device "${dev.name}" requires its configured ${dev.transportMode} tunnel (${dev.tunnelEndpoint}).`);
          }
        }

        const lastSeenMs = dev.lastSeenAt ? Date.parse(dev.lastSeenAt) : 0;
        const hasWaiter = (this._pollWaiters.get(parsed.deviceId)?.size || 0) > 0;
        if (!hasWaiter && (!Number.isFinite(lastSeenMs) || Date.now() - lastSeenMs > ONLINE_GRACE_MS)) {
          throw new Error(`Device "${dev.name}" is currently offline. Open or start Loop on "${dev.name}" to run "${toolName}".`);
        }
        try {
          const result = await this.dispatchRelayCall(parsed.deviceId, parsed.connId, toolName, args, {
            signal,
            extraSecrets,
            profile,
            callToken,
            payload: { sameDevice },
            ownerApproved: Boolean(ownerApproved),
          });
          return maskSecrets(result, extraSecrets);
        } catch (err) {
          throw new Error(maskSecrets(err.message, extraSecrets));
        }
      },
    };
  }

  dispatchRelayCall(
    deviceId,
    sourceConnId,
    toolName,
    args = {},
    {
      signal = null,
      catalog = false,
      kind = null,
      payload = null,
      extraSecrets = [],
      profile = 'all',
      callToken = null,
      ownerApproved = false,
    } = {},
  ) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Relay tool call aborted.'));
        return;
      }
      const callId = `rc_${randomBytes(10).toString('hex')}`;
      const cleanupAbort = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const discard = () => {
        cleanupAbort();
        this._inFlightRelay.delete(callId);
        const queue = this._pendingRelay.get(deviceId);
        if (!queue) return;
        const index = queue.findIndex((entry) => entry.callId === callId);
        if (index >= 0) queue.splice(index, 1);
        if (!queue.length) this._pendingRelay.delete(deviceId);
      };
      const timer = setTimeout(() => {
        discard();
        reject(new Error(entry.phase === 'started'
          ? 'The device started this action but did not confirm its outcome. Check before retrying.'
          : `Timed out waiting for paired device to run "${toolName || kind || 'request'}".`));
      }, this.relayCallTimeoutMs);
      timer.unref?.();

      const onAbort = () => {
        clearTimeout(timer);
        discard();
        reject(new Error(entry.phase === 'started' ? 'The device already started this action. Check its outcome before retrying.' : 'Relay tool call aborted.'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      const wrappedResolve = (val) => {
        clearTimeout(timer);
        cleanupAbort();
        resolve(val);
      };
      const wrappedReject = (err) => {
        clearTimeout(timer);
        cleanupAbort();
        reject(err);
      };

      const entry = {
        callId,
        deviceId,
        phase: 'queued',
        catalog,
        kind,
        payload,
        extraSecrets,
        profile,
        callToken,
        ownerApproved: Boolean(ownerApproved),
        connId: sourceConnId,
        toolName,
        args: args || {},
        resolve: wrappedResolve,
        reject: wrappedReject,
        timer,
      };
      this._inFlightRelay.set(callId, entry);
      if (!this._pendingRelay.has(deviceId)) this._pendingRelay.set(deviceId, []);
      this._pendingRelay.get(deviceId).push(entry);

      const waiters = this._pollWaiters.get(deviceId);
      if (waiters && waiters.size > 0) {
        for (const wake of [...waiters]) wake();
      }
    });
  }

  async waitForRelayCalls(deviceId, { holdMs = this.pollHoldMs, req = null, maxBatch = 8 } = {}) {
    const drain = () => {
      const q = this._pendingRelay.get(deviceId);
      if (!q || q.length === 0) return [];
      const items = q.splice(0, Math.max(1, Math.min(Number(maxBatch) || 8, 16)));
      for (const it of items) it.phase = 'delivered';
      if (!q.length) this._pendingRelay.delete(deviceId);
      return items.map((it) => ({
        callId: it.callId,
        profile: it.profile,
        ...(it.catalog ? { kind: 'catalog' } : it.kind ? { kind: it.kind } : {}),
        ...(it.payload !== null && it.payload !== undefined ? { payload: it.payload } : {}),
        ...(it.callToken ? { callToken: it.callToken } : {}),
        ...(it.ownerApproved ? { ownerApproved: true } : {}),
        ...(it.extraSecrets.length ? { extraSecrets: it.extraSecrets } : {}),
        connId: it.connId,
        toolName: it.toolName,
        arguments: it.args,
      }));
    };
    const immediate = drain();
    if (immediate.length > 0 || holdMs <= 0) return immediate;

    return new Promise((resolve) => {
      let settled = false;
      const disconnected = () => finish(false);
      const finish = (deliver = true) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._pollWaiters.get(deviceId)?.delete(wake);
        req?.removeListener?.('close', disconnected);
        resolve(deliver ? drain() : []);
      };
      const wake = () => finish();
      if (!this._pollWaiters.has(deviceId)) this._pollWaiters.set(deviceId, new Set());
      this._pollWaiters.get(deviceId).add(wake);
      const timer = setTimeout(finish, holdMs);
      timer.unref?.();
      req?.once?.('close', disconnected);
    });
  }

  startRelayCall(deviceId, callId) {
    const entry = this._inFlightRelay.get(callId);
    if (!entry || entry.deviceId !== deviceId || entry.phase !== 'delivered') return false;
    entry.phase = 'started';
    return true;
  }

  completeRelayCall(deviceId, { callId, result, error }) {
    const entry = this._inFlightRelay.get(callId);
    if (!entry || entry.deviceId !== deviceId) return false;
    this._inFlightRelay.delete(callId);
    if (error) {
      entry.reject(new Error(typeof error === 'string' ? error : 'Remote local tool failed.'));
    } else {
      entry.resolve(result && typeof result === 'object' ? result : { content: [{ type: 'text', text: String(result ?? '') }] });
    }
    return true;
  }

  close() {
    for (const deviceId of [...this._pendingRelay.keys()]) {
      this._failDeviceRelayCalls(deviceId, 'Server shutting down.');
    }
    for (const [callId, entry] of this._inFlightRelay) {
      clearTimeout(entry.timer);
      this._inFlightRelay.delete(callId);
      entry.reject(new Error('Server shutting down.'));
    }
    for (const waiters of this._pollWaiters.values()) {
      for (const wake of [...waiters]) wake();
    }
    this._pollWaiters.clear();
  }

  // Handles `/api/connect/*` on the hosted Loop Cloud server.
  async handleHttp({ req, res, pathname, method, origin, ownerWorkspace, resolveWorkspace, readJsonBody, sendJson }) {
    if (!pathname.startsWith('/api/connect/')) return false;
    try {
      // 1. Public/Token-authenticated Device Pairing, Sync, Relay, Promote, & Direct Cloud routes
      if (pathname === '/api/connect/redeem' && method === 'POST') {
        const body = await readJsonBody(req);
        const out = await this.redeemPairCode({
          code: body?.code,
          name: body?.name,
          platform: body?.platform,
          deviceId: body?.deviceId,
          publicKeyPem: body?.publicKeyPem || null,
          resolveWorkspace,
        });
        sendJson(res, 200, {
          ok: true,
          workspaceKey: out.workspaceKey,
          device: out.device,
          token: out.token,
          mcpUrl: `${origin}/mcp`,
          ...(out.pendingSetupId ? { pendingSetupId: out.pendingSetupId } : {}),
        });
        return true;
      }

      if (['/api/connect/bundle', '/api/connect/sync', '/api/connect/sync/v2'].includes(pathname)) {
        throw new LoopConnectError('Update Loop on this computer. Workspace changes are saved directly in Loop Cloud.', 426, 'SYNC_RETIRED');
      }
      if (pathname === '/api/connect/device-catalog' && method === 'POST') {
        const auth = await this.authenticateDevice(req, resolveWorkspace);
        const { tools } = await readJsonBody(req);
        await this._lockFor(auth.wsCtx.dataDir)(() => registerDeviceCatalog(auth.wsCtx, auth.device, tools));
        await this.touchDevice(auth.wsCtx.dataDir, auth.device.id, { synced: true });
        sendJson(res, 200, { ok: true });
        return true;
      }

      // Direct Cloud Memory read/write (single source of truth, retry-safe deduplication)
      if (pathname === '/api/connect/memory' && method === 'GET') {
        const auth = await this.authenticateDevice(req, resolveWorkspace);
        await this.touchDevice(auth.wsCtx.dataDir, auth.device.id);
        const memories = await auth.wsCtx.memoryStore.list();
        sendJson(res, 200, { ok: true, memories });
        return true;
      }
      if (pathname === '/api/connect/memory/save' && method === 'POST') {
        const auth = await this.authenticateDevice(req, resolveWorkspace);
        await this.touchDevice(auth.wsCtx.dataDir, auth.device.id);
        const body = await readJsonBody(req);
        const idemKey = typeof body?.idempotencyKey === 'string' && body.idempotencyKey.trim()
          ? `${auth.workspaceKey}:${body.idempotencyKey.trim()}`
          : null;
        if (idemKey && this._memoryIdempotency.has(idemKey)) {
          const existingId = this._memoryIdempotency.get(idemKey);
          const existingMem = await auth.wsCtx.memoryStore.get(existingId).catch(() => null);
          if (existingMem) {
            sendJson(res, 200, { ok: true, memory: existingMem, created: false, deduplicated: true });
            return true;
          }
        }
        const saved = await auth.wsCtx.memoryStore.save({
          key: body?.key,
          content: body?.content,
          scope: body?.scope,
          project: body?.project,
          tags: body?.tags,
          links: body?.links,
          pinned: body?.pinned,
          profiles: body?.profiles,
          source: body?.source || auth.device.name || 'Device',
          writtenBy: body?.writtenBy || `Device (${auth.device.name})`,
        });
        if (idemKey && saved?.memory?.id) {
          this._memoryIdempotency.set(idemKey, saved.memory.id);
        }
        auth.wsCtx.broadcast?.('memory');
        sendJson(res, saved.created ? 201 : 200, { ok: true, memory: saved.memory, created: saved.created });
        return true;
      }

      // Atomic Move from Local to Loop Cloud: verifies in Cloud FIRST before local deletes its copy!
      if (pathname === '/api/connect/promote' && method === 'POST') {
        const auth = await this.authenticateDevice(req, resolveWorkspace);
        await this.touchDevice(auth.wsCtx.dataDir, auth.device.id);
        const body = await readJsonBody(req);
        const incoming = body?.connection;
        if (!incoming || typeof incoming !== 'object') {
          throw new LoopConnectError('Connection setup is required to move to Loop Cloud.', 400, 'INVALID_PROMOTE');
        }
        const transport = incoming.transport === 'sse' ? 'sse' : 'http';
        if (incoming.transport === 'stdio' || typeof incoming.url !== 'string' || !incoming.url.trim()) {
          throw new LoopConnectError(
            'Only cloud-capable HTTP or SSE connections can move to Loop Cloud. Local command tools run on each computer.',
            400,
            'NOT_CLOUD_CAPABLE',
          );
        }
        // Apply any referenced Vault secret sync records before verifying in Cloud
        if (Array.isArray(body?.secrets)) {
          for (const rec of body.secrets) {
            await auth.wsCtx.vault.applySyncRecord(rec).catch(() => {});
          }
        }
        const candidate = {
          name: cleanText(incoming.name, 80, incoming.id || 'Cloud Tool'),
          description: cleanText(incoming.description, 500, ''),
          transport,
          url: incoming.url.trim(),
          headers: incoming.headers && typeof incoming.headers === 'object' ? { ...incoming.headers } : {},
          profiles: normalizeItemProfiles(incoming.profiles),
          enabled: true,
          home: 'cloud',
        };
        if (auth.wsCtx.personal) {
          try {
            assertPersonalConnection(candidate);
          } catch (err) {
            throw new LoopConnectError(err?.message || 'Connection cannot run in Loop Cloud.', 400, 'INVALID_CLOUD_URL');
          }
        }

        const existingConns = await auth.wsCtx.store.list();
        const existingMatch = existingConns.find((c) => c.url === candidate.url && c.transport === candidate.transport) || null;
        let cloudConn;
        let createdNew = false;
        if (existingMatch) {
          cloudConn = await auth.wsCtx.store.update(existingMatch.id, candidate);
        } else {
          cloudConn = await auth.wsCtx.store.add({
            ...(incoming.id ? { id: slugifySetupId(incoming.id) } : {}),
            ...candidate,
          });
          createdNew = true;
        }

        // Verification gate: prove Loop Cloud can reach the server and list tools BEFORE returning Ready!
        let synced = null;
        let syncErr = null;
        try {
          await auth.wsCtx.pool.retire(cloudConn.id).catch(() => {});
          synced = await auth.wsCtx.pool.sync(cloudConn.id);
        } catch (err) {
          syncErr = err?.message || 'Loop Cloud could not reach this server.';
        }

        const failed = Boolean(syncErr || !synced || synced.lastError || synced.authRequired);
        if (failed) {
          if (createdNew) {
            await auth.wsCtx.pool.invalidate(cloudConn.id).catch(() => {});
            await auth.wsCtx.store.remove(cloudConn.id).catch(() => {});
          }
          sendJson(res, 422, {
            ok: false,
            ready: false,
            error: syncErr || synced?.lastError || (synced?.authRequired ? 'Server requires sign-in in Loop Cloud before moving.' : 'Loop Cloud could not verify this tool.'),
          });
          return true;
        }

        const setupStore = getToolSetupStore(auth.wsCtx);
        const setup = await setupStore.upsert({
          id: cloudConn.id,
          name: synced.name || cloudConn.name,
          description: synced.description || cloudConn.description,
          profiles: synced.profiles || candidate.profiles,
          home: 'cloud',
          enabled: true,
          portable: true,
          cloudSpec: {
            transport: synced.transport,
            url: synced.url,
            cloudConnId: synced.id,
          },
        });
        auth.wsCtx.broadcast?.('connections');
        sendJson(res, 200, {
          ok: true,
          ready: true,
          cloudConnId: synced.id,
          connection: {
            id: synced.id,
            name: synced.name,
            description: synced.description || '',
            transport: synced.transport,
            url: synced.url,
            profiles: synced.profiles || ['all'],
            enabled: synced.enabled !== false,
            home: 'cloud',
            tools: synced.tools || [],
          },
          setup,
        });
        return true;
      }

      // Local desktop bridge invokes a Cloud-homed tool directly in Loop Cloud (zero local copy!)
      if (pathname === '/api/connect/cloud/invoke' && method === 'POST') {
        const auth = await this.authenticateDevice(req, resolveWorkspace);
        if ((await auth.wsCtx.store.getSettings()).paused) {
          throw new LoopConnectError('Gateway paused.', 403, 'GATEWAY_PAUSED');
        }
        await this.touchDevice(auth.wsCtx.dataDir, auth.device.id);
        const body = await readJsonBody(req);
        const cloudConnId = cleanText(body?.cloudConnId || body?.connId, 64, '');
        const toolName = cleanText(body?.toolName, 120, '');
        if (!cloudConnId || !toolName) {
          throw new LoopConnectError('cloudConnId and toolName are required.', 400, 'INVALID_REQUEST');
        }
        const setupStore = getToolSetupStore(auth.wsCtx);
        const setup = await setupStore.get(cloudConnId).catch(() => null);
        if (setup && setup.enabled === false) {
          throw new LoopConnectError(`"${setup.name}" is disabled in Loop.`, 403, 'TOOL_DISABLED');
        }
        const conn = await auth.wsCtx.store.get(cloudConnId);
        if (!conn || conn.enabled === false || !isToolEnabled(conn, toolName)) {
          throw new LoopConnectError('Cloud tool is unavailable or disabled.', 404, 'TOOL_UNAVAILABLE');
        }
        const extraSecrets = Array.isArray(body?.extraSecrets) ? body.extraSecrets.filter((v) => typeof v === 'string') : [];
        const result = await auth.wsCtx.pool.callTool(conn.id, toolName, body?.arguments || {}, { extraSecrets });
        sendJson(res, 200, { ok: true, result: maskSecrets(result, extraSecrets) });
        return true;
      }

      // Paired device updates its own network settings (Tailscale / Cloudflare Tunnel)
      if (pathname === '/api/connect/device/network' && method === 'PATCH') {
        const auth = await this.authenticateDevice(req, resolveWorkspace);
        const body = await readJsonBody(req);
        const updated = await this.updateDeviceNetwork(auth.wsCtx.dataDir, auth.device.id, body);
        sendJson(res, 200, { ok: true, device: updated });
        return true;
      }

      // Paired device reports installation status for a ToolSetup back to Cloud
      const devStatusMatch = pathname.match(/^\/api\/connect\/tool-setups\/([a-z0-9_-]+)\/status$/);
      if (devStatusMatch && method === 'POST') {
        const auth = await this.authenticateDevice(req, resolveWorkspace);
        const body = await readJsonBody(req);
        const setupStore = getToolSetupStore(auth.wsCtx);
        const updated = await setupStore.recordDeviceInstall(devStatusMatch[1], auth.device.id, body || {});
        if (!updated) {
          sendJson(res, 404, { error: 'Tool setup not found.' });
          return true;
        }
        auth.wsCtx.broadcast?.('connections');
        sendJson(res, 200, { ok: true, setup: updated });
        return true;
      }

      // Paired device reads/upserts/updates account ToolSetups (also reachable by owner below)
      if (pathname === '/api/connect/tool-setups' && extractBearer(req)?.startsWith('lpc_')) {
        const auth = await this.authenticateDevice(req, resolveWorkspace);
        await this.touchDevice(auth.wsCtx.dataDir, auth.device.id);
        const setupStore = getToolSetupStore(auth.wsCtx);
        if (method === 'GET') {
          const [setups, devInfo] = await Promise.all([setupStore.list(), this.getDevicesInfo(auth.wsCtx.dataDir)]);
          sendJson(res, 200, { ok: true, setups, ...devInfo });
          return true;
        }
        if (method === 'POST') {
          const body = await readJsonBody(req);
          const setup = await setupStore.upsert({
            ...body,
            originDeviceId: body?.originDeviceId || auth.device.id,
            originDeviceName: body?.originDeviceName || auth.device.name,
          });
          auth.wsCtx.broadcast?.('connections');
          sendJson(res, 200, { ok: true, setup });
          return true;
        }
      }

      const devSetupPatchMatch = pathname.match(/^\/api\/connect\/tool-setups\/([a-z0-9_-]+)$/);
      if (devSetupPatchMatch && method === 'PATCH' && extractBearer(req)?.startsWith('lpc_')) {
        const auth = await this.authenticateDevice(req, resolveWorkspace);
        const body = await readJsonBody(req);
        const setupStore = getToolSetupStore(auth.wsCtx);
        const updated = await setupStore.update(devSetupPatchMatch[1], body || {});
        if (!updated) {
          sendJson(res, 404, { error: 'Tool setup not found.' });
          return true;
        }
        // Mirror remoteAccess/enabled changes onto matching relay connections on Cloud immediately
        const conns = await auth.wsCtx.store.list();
        for (const c of conns) {
          const rel = parseRelayUrl(c.url);
          if ((rel && rel.connId === updated.id) || c.id === updated.id || c.toolSetupId === updated.id) {
            const patch = {};
            if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
            if (body.remoteAccess !== undefined) patch.remoteAccess = updated.remoteAccess;
            if (Object.keys(patch).length) await auth.wsCtx.store.update(c.id, patch).catch(() => {});
          }
        }
        auth.wsCtx.broadcast?.('connections');
        sendJson(res, 200, { ok: true, setup: updated });
        return true;
      }

      if (pathname === '/api/connect/relay/poll' && method === 'GET') {
        throw new LoopConnectError('Update this device to relay tools.', 426, 'RELAY_VERSION');
      }
      if (pathname === '/api/connect/relay/poll/v2' && method === 'GET') {
        const auth = await this.authenticateDevice(req, resolveWorkspace);
        await this.touchDevice(auth.wsCtx.dataDir, auth.device.id);
        const reqUrl = new URL(req.url, origin);
        const requestedWait = Number(reqUrl.searchParams.get('waitMs'));
        const holdMs = Number.isFinite(requestedWait) && requestedWait >= 0
          ? Math.min(requestedWait, 20_000)
          : this.pollHoldMs;
        const calls = await this.waitForRelayCalls(auth.device.id, { holdMs, req: res });
        if (!res.writableEnded && !res.destroyed) sendJson(res, 200, { calls });
        return true;
      }

      if (pathname === '/api/connect/relay/start' && method === 'POST') {
        const auth = await this.authenticateDevice(req, resolveWorkspace);
        const body = await readJsonBody(req);
        const ok = this.startRelayCall(auth.device.id, body?.callId);
        sendJson(res, ok ? 200 : 409, { ok });
        return true;
      }
      if (pathname === '/api/connect/relay/respond' && method === 'POST') {
        const auth = await this.authenticateDevice(req, resolveWorkspace);
        await this.touchDevice(auth.wsCtx.dataDir, auth.device.id);
        const body = await readJsonBody(req);
        const ok = this.completeRelayCall(auth.device.id, {
          callId: body?.callId,
          result: body?.result,
          error: body?.error,
        });
        sendJson(res, 200, { ok });
        return true;
      }

      if (pathname === '/api/connect/relay/catalog' && method === 'GET') {
        const auth = await this.authenticateDevice(req, resolveWorkspace);
        if ((await auth.wsCtx.store.getSettings()).paused) {
          sendJson(res, 200, { catalog: {} });
          return true;
        }
        const id = new URL(req.url, origin).searchParams.get('device');
        const relays = (await auth.wsCtx.store.list()).filter((conn) => parseRelayUrl(conn.url)?.deviceId === id && conn.enabled);
        const catalog = Object.create(null);
        if (relays.length) {
          const live = await this.createHostedRelayDispatcher(auth.wsCtx.dataDir, auth.workspaceKey).catalogFor(id);
          for (const conn of relays) {
            const { connId } = parseRelayUrl(conn.url);
            const row = projectRelay(conn, live?.[connId]);
            if (row) catalog[connId] = { tools: row.toolNames, profiles: row.profiles, ...(row.remoteAccess ? { remoteAccess: row.remoteAccess } : {}) };
          }
        }
        sendJson(res, 200, { catalog });
        return true;
      }

      if (pathname === '/api/connect/relay/invoke' && method === 'POST') {
        const auth = await this.authenticateDevice(req, resolveWorkspace);
        if ((await auth.wsCtx.store.getSettings()).paused) throw new LoopConnectError('Gateway paused.', 403);
        await this.touchDevice(auth.wsCtx.dataDir, auth.device.id);
        const body = await readJsonBody(req);
        const relayUrl = typeof body?.relayUrl === 'string' ? body.relayUrl : '';
        const parsed = parseRelayUrl(relayUrl);
        if (!parsed) {
          sendJson(res, 400, { error: 'Valid relayUrl is required.' });
          return true;
        }
        const registered = (await auth.wsCtx.store.list()).find((conn) => conn.url === relayUrl);
        const profile = normalizeProfileTag(body?.profile) || 'all';
        if (!connectionMatchesProfile(registered, profile) || !permitsRelayTool(registered, body?.toolName)) {
          throw new LoopConnectError('Tool unavailable.', 404);
        }
        const dispatcher = this.createHostedRelayDispatcher(auth.wsCtx.dataDir, auth.workspaceKey);
        const abort = new AbortController();
        const cancel = () => { if (!res.writableEnded) abort.abort(); };
        res.once('close', cancel);
        let result;
        try {
          result = await dispatcher.callTool(registered, String(body?.toolName || ''), body?.arguments || {}, {
            signal: abort.signal,
            profile,
            ownerApproved: Boolean(body?.ownerApproved),
            extraSecrets: Array.isArray(body?.extraSecrets) ? body.extraSecrets.filter((v) => typeof v === 'string') : [],
          });
        } finally {
          res.removeListener('close', cancel);
        }
        if (!res.destroyed) sendJson(res, 200, { ok: true, result });
        return true;
      }

      // 2. Owner-authenticated Dashboard routes (/api/connect/devices, /api/connect/pair-code, /api/connect/tool-setups)
      if (!ownerWorkspace) {
        sendJson(res, 401, { error: 'Sign in to Loop to continue.', auth: 'required' });
        return true;
      }
      const wsInfo = await resolveWorkspace(ownerWorkspace.id || 'local');
      if (!wsInfo?.wsCtx) {
        sendJson(res, 404, { error: 'Workspace not found.' });
        return true;
      }
      const wsKey = ownerWorkspace.id || 'local';

      if (pathname === '/api/connect/devices' && method === 'GET') {
        const devInfo = await this.getDevicesInfo(wsInfo.wsCtx.dataDir);
        sendJson(res, 200, {
          devices: devInfo.devices,
          defaultDeviceId: devInfo.defaultDeviceId,
          maxDevices: wsInfo.maxDevices ?? DEFAULT_CONNECT_MAX_DEVICES,
          loopConnectActive: Boolean(wsInfo.loopConnectActive),
          upgradeRequired: !wsInfo.loopConnectActive,
        });
        return true;
      }

      if (pathname === '/api/connect/devices/default' && method === 'PATCH') {
        const body = await readJsonBody(req);
        const updated = await this.setDefaultDevice(wsInfo.wsCtx.dataDir, body?.deviceId ?? null);
        sendJson(res, 200, { ok: true, ...updated });
        return true;
      }

      const devNetworkMatch = pathname.match(/^\/api\/connect\/devices\/(dev_[0-9a-f]{16})\/network$/);
      if (devNetworkMatch && method === 'PATCH') {
        const body = await readJsonBody(req);
        const updated = await this.updateDeviceNetwork(wsInfo.wsCtx.dataDir, devNetworkMatch[1], body);
        sendJson(res, 200, { ok: true, device: updated });
        return true;
      }

      if (pathname === '/api/connect/pair-code' && method === 'POST') {
        if (!wsInfo.loopConnectActive) {
          sendJson(res, 402, {
            error: 'An active Loop Connect subscription is required to connect devices.',
            upgradeRequired: true,
            billingUrl: '/#settings?tab=billing',
          });
          return true;
        }
        const body = await readJsonBody(req).catch(() => ({}));
        const pair = await this.createPairCode({
          workspaceKey: wsKey,
          wsDir: wsInfo.wsCtx.dataDir,
          maxDevices: wsInfo.maxDevices ?? DEFAULT_CONNECT_MAX_DEVICES,
          pendingSetupId: body?.pendingSetupId || null,
        });
        sendJson(res, 200, pair);
        return true;
      }

      const devMatch = pathname.match(/^\/api\/connect\/devices\/(dev_[0-9a-f]{16})$/);
      if (devMatch && method === 'DELETE') {
        const removed = await this.removeDevice({ wsCtx: wsInfo.wsCtx, deviceId: devMatch[1] });
        sendJson(res, removed ? 200 : 404, removed ? { removed: true } : { error: 'Device not found.' });
        return true;
      }

      if (pathname === '/api/connect/resolve-device' && method === 'POST') {
        const body = await readJsonBody(req);
        const out = await this.resolveTargetDevice(wsInfo.wsCtx, {
          setupId: body?.setupId,
          requestedDeviceId: body?.deviceId || null,
        });
        sendJson(res, 200, out);
        return true;
      }

      // Account ToolSetups (Owner Dashboard API)
      const setupStore = getToolSetupStore(wsInfo.wsCtx);
      if (pathname === '/api/connect/tool-setups' && method === 'GET') {
        const [setups, devInfo] = await Promise.all([
          setupStore.list(),
          this.getDevicesInfo(wsInfo.wsCtx.dataDir),
        ]);
        sendJson(res, 200, { setups, ...devInfo });
        return true;
      }

      if (pathname === '/api/connect/tool-setups' && method === 'POST') {
        const body = await readJsonBody(req);
        let setupInput = { ...body };
        if (!setupInput.installSpec && setupInput.command) {
          const analysis = analyzeStdioPortability({
            name: setupInput.name,
            command: setupInput.command,
            args: setupInput.args,
            env: setupInput.env,
            cwd: setupInput.cwd,
          });
          setupInput = {
            ...setupInput,
            portable: analysis.portable,
            nonPortableReason: analysis.reason,
            installSpec: analysis.installSpec,
          };
        } else if (setupInput.installSpec) {
          setupInput.installSpec = normalizeInstallSpec(setupInput.installSpec, { rejectRawSecrets: true });
          setupInput.portable = true;
          setupInput.nonPortableReason = null;
        }
        const saved = await setupStore.upsert(setupInput);
        wsInfo.wsCtx.broadcast?.('connections');
        sendJson(res, 201, { setup: saved });
        return true;
      }

      const setupItemMatch = pathname.match(/^\/api\/connect\/tool-setups\/([a-z0-9_-]+)$/);
      if (setupItemMatch && method === 'PATCH') {
        const body = await readJsonBody(req);
        const updated = await setupStore.update(setupItemMatch[1], body);
        if (!updated) {
          sendJson(res, 404, { error: 'Tool setup not found.' });
          return true;
        }
        // Propagate global Disable in Loop / remoteAccess immediately to Cloud connections & online devices!
        const conns = await wsInfo.wsCtx.store.list();
        for (const c of conns) {
          const rel = parseRelayUrl(c.url);
          if ((rel && rel.connId === updated.id) || c.id === updated.id || c.toolSetupId === updated.id) {
            const patch = {};
            if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
            if (body.remoteAccess !== undefined) patch.remoteAccess = updated.remoteAccess;
            if (Object.keys(patch).length) await wsInfo.wsCtx.store.update(c.id, patch).catch(() => {});
          }
        }
        if (body.enabled !== undefined || body.remoteAccess !== undefined) {
          const devInfo = await this.getDevicesInfo(wsInfo.wsCtx.dataDir);
          for (const d of devInfo.devices.filter((x) => x.online)) {
            this.dispatchRelayCall(d.id, updated.id, '', {}, {
              kind: 'policy_sync',
              payload: { setupId: updated.id, enabled: updated.enabled, remoteAccess: updated.remoteAccess },
              signal: AbortSignal.timeout(3000),
            }).catch(() => {});
          }
        }
        wsInfo.wsCtx.broadcast?.('connections');
        sendJson(res, 200, { setup: updated });
        return true;
      }

      if (setupItemMatch && method === 'DELETE') {
        const removed = await setupStore.remove(setupItemMatch[1]);
        if (!removed) {
          sendJson(res, 404, { error: 'Tool setup not found.' });
          return true;
        }
        wsInfo.wsCtx.broadcast?.('connections');
        sendJson(res, 200, { removed: true });
        return true;
      }

      // One-Click Install over Outbound TLS Channel (zero localhost probing!)
      const installMatch = pathname.match(/^\/api\/connect\/tool-setups\/([a-z0-9_-]+)\/install$/);
      if (installMatch && method === 'POST') {
        const setupId = slugifySetupId(installMatch[1]);
        const setup = await setupStore.get(setupId);
        if (!setup) {
          sendJson(res, 404, { error: 'Saved tool setup not found.' });
          return true;
        }
        if (setup.enabled === false) {
          throw new LoopConnectError(`"${setup.name}" is disabled in Loop.`, 403, 'TOOL_DISABLED');
        }
        if (setup.home === 'cloud') {
          sendJson(res, 200, { ok: true, alreadyInCloud: true, status: 'ready', setup });
          return true;
        }
        if (!setup.portable || !setup.installSpec) {
          throw new LoopConnectError(
            setup.nonPortableReason || `"${setup.name}" is not portable and can only run on its original computer.`,
            400,
            'NOT_PORTABLE',
          );
        }
        const body = await readJsonBody(req);
        const devInfo = await this.getDevicesInfo(wsInfo.wsCtx.dataDir);
        if (!body?.deviceId && devInfo.devices.length) {
          throw new LoopConnectError('Choose the computer where you want to install this tool.', 409, 'CHOOSE_DEVICE');
        }
        const targetDevice = devInfo.devices.find((d) => d.id === body?.deviceId);
        if (body?.deviceId && !targetDevice) {
          throw new LoopConnectError('The selected computer is no longer paired.', 404, 'DEVICE_NOT_FOUND');
        }

        if (!targetDevice) {
          // If no Loop app is paired/online yet, guide user to Install Loop once and resume this tool install!
          const pendingToken = `pi_${randomBytes(12).toString('hex')}`;
          this._pendingAppInstalls.set(pendingToken, {
            workspaceKey: wsKey,
            setupId,
            expiresAt: Date.now() + PAIR_CODE_TTL_MS,
          });
          sendJson(res, 200, {
            ok: false,
            needsLoopApp: true,
            setupId,
            pendingInstallToken: pendingToken,
            installAppUrl: `${origin}/#settings?tab=billing&resume_install=${encodeURIComponent(setupId)}`,
            message: 'Install and pair the Loop app on this computer to continue installing this tool.',
          });
          return true;
        }
        if (!targetDevice.online) {
          throw new LoopConnectError(
            `Computer "${targetDevice.name}" is offline. Open Loop on "${targetDevice.name}" and click Retry.`,
            503,
            'DEVICE_OFFLINE',
          );
        }

        const idemKey = cleanText(body?.idempotencyKey, 80, '') || `${setup.id}@${setup.installSpec.version || 'default'}`;
        const dedupeKey = `${wsKey}:${targetDevice.id}:${setup.id}:${idemKey}`;
        if (this._pendingInstallByKey.has(dedupeKey)) {
          const sharedRes = await this._pendingInstallByKey.get(dedupeKey);
          sendJson(res, 200, sharedRes);
          return true;
        }

        const runPromise = (async () => {
          await setupStore.recordDeviceInstall(setup.id, targetDevice.id, {
            status: 'installing',
            step: 'dispatched',
            version: setup.installSpec.version || null,
          });
          const callToken = this.mintCallToken({
            kind: 'install',
            workspaceKey: wsKey,
            deviceId: targetDevice.id,
            targetId: setup.id,
            version: setup.installSpec.version || null,
            sha256: setup.installSpec.sha256 || null,
            idempotencyKey: idemKey,
          });
          const result = await this.dispatchRelayCall(targetDevice.id, setup.id, 'install', {}, {
            kind: 'install',
            callToken,
            payload: {
              setup,
              localConfig: body?.localConfig || {},
              idempotencyKey: idemKey,
            },
          });
          const installRec = result?.install || result;
          const updatedSetup = await setupStore.recordDeviceInstall(setup.id, targetDevice.id, {
            status: installRec?.status || 'ready',
            step: installRec?.step || 'ready',
            version: installRec?.version || setup.installSpec.version || null,
            sha256Verified: Boolean(installRec?.sha256Verified),
            toolCount: Number(installRec?.toolCount) || 0,
            missingStep: installRec?.missingStep || null,
            lastError: installRec?.lastError || null,
          });
          wsInfo.wsCtx.broadcast?.('connections');
          return {
            ok: installRec?.status === 'ready',
            deviceId: targetDevice.id,
            deviceName: targetDevice.name,
            install: installRec,
            setup: updatedSetup,
          };
        })().finally(() => {
          this._pendingInstallByKey.delete(dedupeKey);
        });

        this._pendingInstallByKey.set(dedupeKey, runPromise);
        const outcome = await runPromise;
        sendJson(res, 200, outcome);
        return true;
      }

      // Uninstall from one computer only (saved ToolSetup stays in account, ready to install again!)
      const uninstallMatch = pathname.match(/^\/api\/connect\/tool-setups\/([a-z0-9_-]+)\/uninstall$/);
      if (uninstallMatch && method === 'POST') {
        const setupId = slugifySetupId(uninstallMatch[1]);
        const setup = await setupStore.get(setupId);
        if (!setup) {
          sendJson(res, 404, { error: 'Saved tool setup not found.' });
          return true;
        }
        const body = await readJsonBody(req);
        const devInfo = await this.getDevicesInfo(wsInfo.wsCtx.dataDir);
        if (!body?.deviceId) {
          throw new LoopConnectError('Choose the computer to uninstall this tool from.', 409, 'CHOOSE_DEVICE');
        }
        const targetDevice = devInfo.devices.find((d) => d.id === body.deviceId);
        if (!targetDevice || !targetDevice.online) {
          throw new LoopConnectError('Target computer must be online to uninstall its local tool.', 503, 'DEVICE_OFFLINE');
        }
        const callToken = this.mintCallToken({
          kind: 'uninstall',
          workspaceKey: wsKey,
          deviceId: targetDevice.id,
          targetId: setup.id,
        });
        await this.dispatchRelayCall(targetDevice.id, setup.id, 'uninstall', {}, {
          kind: 'uninstall',
          callToken,
          payload: { setupId: setup.id },
        });
        const updatedSetup = await setupStore.markDeviceUninstalled(setup.id, targetDevice.id);
        wsInfo.wsCtx.broadcast?.('connections');
        sendJson(res, 200, { ok: true, uninstalled: true, deviceId: targetDevice.id, setup: updatedSetup });
        return true;
      }

      sendJson(res, 404, { error: 'Not found.' });
      return true;
    } catch (err) {
      if (err instanceof LoopConnectError || err instanceof ToolSetupError) {
        sendJson(res, err.status || 400, {
          error: err.publicMessage || err.message,
          code: err.code,
          ...(err.upgradeRequired ? { upgradeRequired: true, billingUrl: '/#settings?tab=billing' } : {}),
          ...(err.maxDevices !== undefined ? { maxDevices: err.maxDevices } : {}),
          ...(err.canAddDeviceSlot ? { canAddDeviceSlot: true, extraDevicePriceMonthly: err.extraDevicePriceMonthly } : {}),
        });
        return true;
      }
      throw err;
    }
  }
}

// Local Loop Connect Client (lives inside Local Loop on `127.0.0.1:8799`; completely inert unless linked).
export class LoopConnectClient {
  constructor(
    wsCtx,
    {
      fetchImpl = fetch,
      allowLoopbackHttp = false,
      relayPollWaitMs = 10_000,
      resolveArtifactBytes = null,
      checkOsPermission = null,
    } = {},
  ) {
    this.wsCtx = wsCtx;
    this.agentRequests = new Map();
    this.file = path.join(wsCtx.dataDir, 'loop-connect.json');
    this.localInstallStore = getLocalInstallStore(wsCtx);
    this.fetchImpl = fetchImpl;
    this.allowLoopbackHttp = allowLoopbackHttp;
    this.relayPollWaitMs = relayPollWaitMs;
    this.resolveArtifactBytes = typeof resolveArtifactBytes === 'function' ? resolveArtifactBytes : null;
    this.checkOsPermission = typeof checkOsPermission === 'function' ? checkOsPermission : null;
    this._withLock = createWriteQueue();
    this._closed = false;
    this._relayAbort = null;
    this._relayLoopPromise = null;
  }

  async pairing() {
    if (this.pairState === undefined) this.pairState = await this._readState();
    return this.pairState;
  }

  scheduleCatalog() {
    if (this._closed || !this.pairState || this.catalogTimer) return;
    this.catalogTimer = setTimeout(() => {
      this.catalogTimer = null;
      this.syncNow().catch(err => console.warn('[loop-connect] Device tools could not be published:', err.code || err.name));
    }, 150);
    this.catalogTimer.unref?.();
  }

  async beginAgents(agents, profile, serverName) {
    const state = await this.pairing();
    const token = state && await this.wsCtx.vault.getInternal(CONNECT_TOKEN_VAULT_KEY);
    if (!token) throw new LoopConnectError('Pair this computer again.', 401);
    const url = state.cloudUrl + '/oauth/device/code';
    const res = await this.fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: await this._signedDeviceHeaders(token, 'POST', url, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ agents, profile, client_name: state.deviceName }) });
    const auth = await res.json();
    if (!res.ok) throw new LoopConnectError(auth.error_description || 'Cloud sign-in failed.', res.status);
    const verification = new URL(auth.verification_uri_complete);
    if (verification.origin !== state.cloudUrl) throw new LoopConnectError('Unexpected cloud sign-in address.', 502);
    const now = Date.now();
    for (const [id, v] of this.agentRequests) if (v.expires <= now) this.agentRequests.delete(id);
    if (this.agentRequests.size >= 32) throw new LoopConnectError('Finish an existing agent sign-in first.', 429);
    const requestId = randomBytes(18).toString('hex');
    this.agentRequests.set(requestId, { code: auth.device_code, deviceId: state.deviceId, cloudUrl: state.cloudUrl,
      agents: agents.map(a => a.id), serverName, expires: now + Math.min(600, Number(auth.expires_in) || 600) * 1000 });
    return { requestId, verificationUrl: verification.href, userCode: auth.user_code, interval: auth.interval || 2 };
  }

  async finishAgents(id) {
    const pending = this.agentRequests.get(id);
    const state = await this.pairing();
    if (!pending || pending.expires <= Date.now() || !state || pending.deviceId !== state.deviceId || pending.cloudUrl !== state.cloudUrl) {
      this.agentRequests.delete(id);
      throw new LoopConnectError('Start agent sign-in again.', 410);
    }
    if (pending.working) return { pending: true };
    pending.working = true;
    try {
      if (!pending.grant) {
        const res = await this.fetchImpl(state.cloudUrl + '/oauth/device/token', { method: 'POST', redirect: 'error',
          signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: pending.code }) });
        const json = await res.json();
        if (['authorization_pending', 'slow_down'].includes(json.error)) return { pending: true, interval: json.interval || 2 };
        if (!res.ok) throw new LoopConnectError(json.error_description || 'Cloud sign-in failed.', res.status);
        pending.grant = json;
      }
      const results = [];
      for (const grant of pending.grant.agents || []) {
        if (!pending.agents.includes(grant.id) || !grant.access_token) continue;
        try {
          await this.wsCtx.installAgent(grant.id, { url: state.cloudUrl + '/mcp', token: grant.access_token, serverName: pending.serverName });
          results.push({ id: grant.id, ok: true });
        } catch (err) { results.push({ id: grant.id, ok: false, error: err.message }); }
      }
      if (results.every(r => r.ok)) this.agentRequests.delete(id);
      return { results };
    } finally { pending.working = false; }
  }

  async _readState() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && typeof parsed.cloudUrl === 'string') {
        return parsed;
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        throw err;
      }
    }
    return null;
  }

  async _writeState(state) {
    await atomicWriteFile(this.file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, backup: true });
    this.pairState = state;
  }

  async _ensureDeviceKeypair() {
    let priv = await this.wsCtx.vault.getInternal(DEVICE_PRIV_VAULT_KEY).catch(() => null);
    let pub = await this.wsCtx.vault.getInternal(DEVICE_PUB_VAULT_KEY).catch(() => null);
    if (!priv || !pub) {
      const pair = generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      priv = pair.privateKey;
      pub = pair.publicKey;
      await this.wsCtx.vault.set(DEVICE_PRIV_VAULT_KEY, priv, {
        description: 'Loop device Ed25519 signing private key (managed by Loop)',
      });
      await this.wsCtx.vault.set(DEVICE_PUB_VAULT_KEY, pub, {
        description: 'Loop device Ed25519 public key (managed by Loop)',
      });
    }
    return { privateKeyPem: priv, publicKeyPem: pub, keyFingerprint: fingerprintPublicKey(pub) };
  }

  async _signedDeviceHeaders(token, method, fullUrl, extra = {}) {
    const headers = {
      Authorization: `Bearer ${token}`,
      ...extra,
    };
    const priv = await this.wsCtx.vault.getInternal(DEVICE_PRIV_VAULT_KEY).catch(() => null);
    if (priv) {
      const parsed = new URL(fullUrl);
      const pathAndQuery = `${parsed.pathname}${parsed.search}`;
      const ts = String(Date.now());
      headers['X-Loop-Device-Ts'] = ts;
      headers['X-Loop-Device-Sig'] = signDeviceRequest(priv, method, pathAndQuery, ts);
    }
    return headers;
  }

  async getStatus() {
    const state = await this._readState();
    if (!state) {
      return {
        linked: false,
        defaultDeviceName: os.hostname() || 'This Computer',
      };
    }
    const token = await this.wsCtx.vault.getInternal(CONNECT_TOKEN_VAULT_KEY).catch(() => null);
    if (!token) {
      return {
        linked: false,
        defaultDeviceName: os.hostname() || 'This Computer',
      };
    }
    return {
      linked: true,
      cloudUrl: state.cloudUrl,
      mcpUrl: state.mcpUrl || `${state.cloudUrl}/mcp`,
      deviceId: state.deviceId,
      deviceName: state.deviceName,
      keyFingerprint: state.keyFingerprint || null,
      transportMode: state.transportMode || 'loop_relay',
      tunnelEndpoint: state.tunnelEndpoint || null,
      requirePrivateTunnel: Boolean(state.requirePrivateTunnel),
      relayLocalTools: state.relayLocalTools !== false,
      linkedAt: state.linkedAt,
      lastSyncAt: state.lastSyncAt || null,
      lastError: state.lastError || null,
    };
  }

  async startIfLinked() {
    if (this._closed) return;
    await this.pairing();
    const status = await this.getStatus();
    if (status.linked) this.scheduleCatalog();
    if (status.linked && status.relayLocalTools) {
      this._startRelayLoop();
    }
  }

  async link({ cloudUrl, code, deviceName, relayLocalTools = true }) {
    const allowLoopback = this.allowLoopbackHttp || process.env.LOOP_ALLOW_INSECURE_CONNECT === '1';
    const origin = validateCloudOrigin(cloudUrl || 'https://useloop.sh', { allowLoopbackHttp: allowLoopback });
    const name = cleanText(deviceName, 80, os.hostname() || 'My Computer');
    const platform = `${process.platform}-${process.arch}`;
    const prior = await this._readState();
    const { publicKeyPem, keyFingerprint } = await this._ensureDeviceKeypair();

    let res;
    try {
      res = await this.fetchImpl(`${origin}/api/connect/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          name,
          platform,
          publicKeyPem,
          ...(prior?.deviceId ? { deviceId: prior.deviceId } : {}),
        }),
      });
    } catch {
      throw new LoopConnectError(`Could not reach ${origin}. Check your connection and try again.`, 502, 'NETWORK_ERROR');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.token || !json?.device?.id) {
      throw new LoopConnectError(
        json?.error || `Failed to link device (${res.status}).`,
        res.status >= 400 && res.status < 600 ? res.status : 400,
        json?.code || 'REDEEM_FAILED',
      );
    }

    await this.wsCtx.vault.set(CONNECT_TOKEN_VAULT_KEY, json.token, {
      description: 'Loop Connect device token (managed by Loop)',
    });
    const nowIso = new Date().toISOString();
    const nextState = {
      version: 2,
      cloudUrl: origin,
      mcpUrl: json.mcpUrl || `${origin}/mcp`,
      deviceId: json.device.id,
      deviceName: json.device.name || name,
      keyFingerprint,
      transportMode: json.device.transportMode || 'loop_relay',
      tunnelEndpoint: json.device.tunnelEndpoint || null,
      requirePrivateTunnel: Boolean(json.device.requirePrivateTunnel),
      relayLocalTools: Boolean(relayLocalTools),
      linkedAt: nowIso,
      lastSyncAt: null,
      lastError: null,
    };
    await this._writeState(nextState);
    await this.syncNow();
    if (nextState.relayLocalTools) this._startRelayLoop();
    else this._stopRelayLoop();
    // If pairing originated from a pending tool install ("Install Loop" flow), resume it automatically!
    if (json.pendingSetupId) {
      await this.installLocalSetup(json.pendingSetupId).catch(() => {});
    }
    return this.getStatus();
  }

  async syncNow() {
    return this._withLock(async () => {
      const state = await this._readState();
      const token = state ? await this.wsCtx.vault.getInternal(CONNECT_TOKEN_VAULT_KEY) : null;
      if (!state || !token) {
        throw new LoopConnectError('This computer is not linked to Loop Connect yet.', 400, 'NOT_LINKED');
      }
      const tools = state.relayLocalTools ? (await this.wsCtx.store.list()).filter(c => c.transport === 'stdio').map(deviceCatalogRow) : [];
      const syncUrl = state.cloudUrl + '/api/connect/device-catalog';
      let res;
      try {
        res = await this.fetchImpl(syncUrl, {
          method: 'POST',
          headers: await this._signedDeviceHeaders(token, 'POST', syncUrl, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ tools }),
        });
      } catch (err) {
        state.lastError = 'Could not reach Loop Cloud.';
        await this._writeState(state);
        throw new LoopConnectError(`Could not reach ${state.cloudUrl}: ${err.message}`, 502, 'NETWORK_ERROR');
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = json?.error || `Sync failed (${res.status}).`;
        state.lastError = msg;
        await this._writeState(state);
        throw new LoopConnectError(msg, res.status, json?.code || 'SYNC_FAILED');
      }
      state.lastSyncAt = new Date().toISOString();
      state.lastError = null;
      await this._writeState(state);
      return this.getStatus();
    });
  }

  async updateNetworkConfig(networkInput) {
    const validated = validateDeviceNetworkConfig(networkInput, {
      allowLoopbackHttp: this.allowLoopbackHttp || process.env.LOOP_ALLOW_INSECURE_CONNECT === '1',
    });
    const state = await this._readState();
    const token = state ? await this.wsCtx.vault.getInternal(CONNECT_TOKEN_VAULT_KEY).catch(() => null) : null;
    if (state && token) {
      const url = `${state.cloudUrl}/api/connect/device/network`;
      const res = await this.fetchImpl(url, {
        method: 'PATCH',
        headers: await this._signedDeviceHeaders(token, 'PATCH', url, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(validated),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new LoopConnectError(json?.error || `Could not update network settings (${res.status}).`, res.status);
      }
      state.transportMode = validated.transportMode;
      state.tunnelEndpoint = validated.tunnelEndpoint;
      state.requirePrivateTunnel = validated.requirePrivateTunnel;
      await this._writeState(state);
    }
    return this.getStatus();
  }

  // One active home per tool: moves a cloud-capable local connection to Loop Cloud.
  // Verifies in Loop Cloud FIRST; deletes local copy ONLY AFTER Cloud marks it Ready!
  async promoteToCloud(connId) {
    const state = await this._readState();
    const token = state ? await this.wsCtx.vault.getInternal(CONNECT_TOKEN_VAULT_KEY).catch(() => null) : null;
    if (!state || !token) {
      throw new LoopConnectError('Connect this computer to Loop Connect before moving tools to Loop Cloud.', 400, 'NOT_LINKED');
    }
    const conn = await this.wsCtx.store.get(connId);
    if (!conn) {
      throw new LoopConnectError('Connection not found.', 404, 'NOT_FOUND');
    }
    if (conn.transport === 'stdio') {
      throw new LoopConnectError(
        'Local command tools need this computer and cannot move to Loop Cloud. Make it portable to install on other computers instead.',
        400,
        'NOT_CLOUD_CAPABLE',
      );
    }

    // Collect only referenced user Vault secret sync records needed by this connection
    const neededKeys = new Set(connectionSecretKeys(conn));
    const allVaultSync = await this.wsCtx.vault.syncRecords().catch(() => []);
    const relevantSecrets = allVaultSync.filter((r) => neededKeys.has(r.key));

    const promoteUrl = `${state.cloudUrl}/api/connect/promote`;
    const res = await this.fetchImpl(promoteUrl, {
      method: 'POST',
      headers: await this._signedDeviceHeaders(token, 'POST', promoteUrl, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        connection: {
          id: conn.id,
          name: conn.name,
          description: conn.description || '',
          transport: conn.transport,
          url: conn.url,
          headers: conn.headers || {},
          profiles: conn.profiles || ['all'],
        },
        secrets: relevantSecrets,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok || !json?.ready) {
      // Cloud verification failed — DO NOT delete the local copy!
      throw new LoopConnectError(
        json?.error || 'Loop Cloud could not verify this connection. Your local copy was kept unchanged.',
        res.status >= 400 ? res.status : 422,
        'CLOUD_VERIFY_FAILED',
      );
    }

    // Cloud check passed and marked Ready! Now delete the local copy and add a lightweight Cloud route!
    await this.wsCtx.pool.invalidate(conn.id).catch(() => {});
    await this.wsCtx.store.remove(conn.id);
    const route = await this.localInstallStore.setCloudRoute({
      id: conn.id,
      cloudConnId: json.cloudConnId || conn.id,
      name: json.connection?.name || conn.name,
      description: json.connection?.description || conn.description || '',
      url: json.connection?.url || conn.url,
      transport: json.connection?.transport || conn.transport,
      profiles: json.connection?.profiles || conn.profiles || ['all'],
      enabled: true,
      tools: json.connection?.tools || conn.tools || [],
    });
    this.wsCtx.broadcast?.('connections');
    return { ok: true, movedToCloud: true, deletedLocalCopy: true, cloudRoute: route, setup: json.setup || null };
  }

  // Explicit switch back from Loop Cloud to local execution (never both active at once).
  async demoteToLocal(routeId) {
    const route = await this.localInstallStore.getCloudRoute(routeId);
    if (!route || !route.url) {
      throw new LoopConnectError('Cloud-routed connection not found.', 404, 'NOT_FOUND');
    }
    const created = await this.wsCtx.store.add({
      id: route.id,
      name: route.name,
      description: route.description || '',
      transport: route.transport || 'http',
      url: route.url,
      profiles: route.profiles || ['all'],
      enabled: true,
      home: 'local',
    });
    await this.localInstallStore.removeCloudRoute(route.id);
    const state = await this._readState();
    const token = state ? await this.wsCtx.vault.getInternal(CONNECT_TOKEN_VAULT_KEY).catch(() => null) : null;
    if (state && token) {
      const patchUrl = `${state.cloudUrl}/api/connect/tool-setups/${encodeURIComponent(route.id)}`;
      await this.fetchImpl(patchUrl, {
        method: 'PATCH',
        headers: await this._signedDeviceHeaders(token, 'PATCH', patchUrl, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ home: 'local' }),
      }).catch(() => {});
    }
    this.wsCtx.broadcast?.('connections');
    return { ok: true, home: 'local', connection: created };
  }

  // Save a portable install recipe onto an existing local stdio connection (and push to Cloud ToolSetupStore).
  async makeLocalToolPortable(connId, installSpecInput) {
    const conn = await this.wsCtx.store.get(connId);
    if (!conn || conn.transport !== 'stdio') {
      throw new LoopConnectError('Local stdio connection not found.', 404, 'NOT_FOUND');
    }
    const normalizedSpec = normalizeInstallSpec(installSpecInput, { rejectRawSecrets: true });
    const setupId = slugifySetupId(conn.toolSetupId || conn.id);
    const updated = await this.wsCtx.store.update(conn.id, {
      installSpec: normalizedSpec,
      toolSetupId: setupId,
    });
    const setupPayload = {
      id: setupId,
      name: updated.name,
      description: updated.description || '',
      profiles: updated.profiles || ['all'],
      home: 'local',
      enabled: updated.enabled !== false,
      remoteAccess: defaultRemoteAccessFor(updated),
      portable: true,
      nonPortableReason: null,
      installSpec: normalizedSpec,
      sharedSettings: normalizedSpec.sharedSettings || {},
    };
    await getToolSetupStore(this.wsCtx).upsert(setupPayload);

    const state = await this._readState();
    const token = state ? await this.wsCtx.vault.getInternal(CONNECT_TOKEN_VAULT_KEY).catch(() => null) : null;
    if (state && token) {
      const url = `${state.cloudUrl}/api/connect/tool-setups`;
      await this.fetchImpl(url, {
        method: 'POST',
        headers: await this._signedDeviceHeaders(token, 'POST', url, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(setupPayload),
      }).catch(() => {});
    }
    this.wsCtx.broadcast?.('connections');
    return { ok: true, connection: updated, setup: setupPayload };
  }

  async setLocalRemoteAccess(connId, remoteAccess) {
    const level = validateRemoteAccess(remoteAccess);
    const conn = await this.wsCtx.store.get(connId);
    if (!conn) throw new LoopConnectError('Connection not found.', 404, 'NOT_FOUND');
    const updated = await this.wsCtx.store.update(conn.id, { remoteAccess: level });
    const setupId = slugifySetupId(conn.toolSetupId || conn.id);
    await getToolSetupStore(this.wsCtx).update(setupId, { remoteAccess: level }).catch(() => null);
    const state = await this._readState();
    const token = state ? await this.wsCtx.vault.getInternal(CONNECT_TOKEN_VAULT_KEY).catch(() => null) : null;
    if (state && token) {
      const url = `${state.cloudUrl}/api/connect/tool-setups/${encodeURIComponent(setupId)}`;
      await this.fetchImpl(url, {
        method: 'PATCH',
        headers: await this._signedDeviceHeaders(token, 'PATCH', url, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ remoteAccess: level }),
      }).catch(() => {});
    }
    this.wsCtx.broadcast?.('connections');
    return { ok: true, connection: updated, remoteAccess: level };
  }

  // Lists saved ToolSetups (live from Cloud when online, or cached when offline) merged with this computer's local status.
  async listToolSetupsForThisComputer() {
    const state = await this._readState();
    const token = state ? await this.wsCtx.vault.getInternal(CONNECT_TOKEN_VAULT_KEY).catch(() => null) : null;
    let setups = [];
    let fetchedCloud = false;
    if (state && token) {
      try {
        const url = `${state.cloudUrl}/api/connect/tool-setups`;
        const res = await this.fetchImpl(url, {
          headers: await this._signedDeviceHeaders(token, 'GET', url),
        });
        if (res.ok) {
          const json = await res.json();
          if (Array.isArray(json?.setups)) {
            setups = json.setups;
            fetchedCloud = true;
            await this.localInstallStore.saveCachedSetups(setups).catch(() => {});
          }
        }
      } catch {
        // Offline fallback to cached setups
      }
    }
    if (!fetchedCloud && setups.length === 0) {
      const [cached, localStoreSetups] = await Promise.all([
        this.localInstallStore.listCachedSetups().catch(() => []),
        state ? Promise.resolve([]) : getToolSetupStore(this.wsCtx).list().catch(() => []),
      ]);
      const byId = new Map();
      for (const s of [...localStoreSetups, ...cached]) byId.set(s.id, s);
      setups = [...byId.values()];
    }

    const [localInstalls, localConns, cloudRoutes] = await Promise.all([
      this.localInstallStore.listInstalls().catch(() => ({})),
      this.wsCtx.store.list().catch(() => []),
      this.localInstallStore.listCloudRoutes().catch(() => []),
    ]);

    const localBySetup = new Map();
    for (const c of localConns) {
      if (c.transport === 'stdio') {
        localBySetup.set(slugifySetupId(c.toolSetupId || c.id), c);
      }
    }
    const routeById = new Map(cloudRoutes.map((r) => [r.id, r]));

    return setups.map((s) => {
      const inst = localInstalls[s.id] || null;
      const localConn = localBySetup.get(s.id) || null;
      const cloudRoute = routeById.get(s.id) || null;
      let localStatus = 'not_installed';
      if (s.home === 'cloud' || cloudRoute) localStatus = 'cloud_ready';
      else if (inst?.status && inst.status !== 'not_installed') localStatus = inst.status;
      else if (localConn && localConn.lastSyncAt && !localConn.lastError) localStatus = 'ready';
      else if (localConn) localStatus = 'needs_attention';

      return {
        ...s,
        localStatus,
        localConnId: localConn?.id || inst?.connId || null,
        localInstall: inst,
      };
    });
  }

  // One-click install directly on this computer (works even while the original Mac is turned off!).
  async installLocalSetup(setupId, { localConfig = {}, idempotencyKey = '', setupOverride = null } = {}) {
    const cleanId = slugifySetupId(setupId);
    let setup = setupOverride;
    if (!setup) {
      const all = await this.listToolSetupsForThisComputer();
      setup = all.find((s) => s.id === cleanId) || null;
    }
    if (!setup) {
      throw new LoopConnectError(`Saved tool setup "${cleanId}" was not found.`, 404, 'SETUP_NOT_FOUND');
    }
    if (setup.enabled === false) {
      throw new LoopConnectError(`"${setup.name}" is disabled in Loop.`, 403, 'TOOL_DISABLED');
    }

    const reportToCloud = async (installRec) => {
      const state = await this._readState();
      const token = state ? await this.wsCtx.vault.getInternal(CONNECT_TOKEN_VAULT_KEY).catch(() => null) : null;
      if (!state || !token) return;
      const url = `${state.cloudUrl}/api/connect/tool-setups/${encodeURIComponent(cleanId)}/status`;
      await this.fetchImpl(url, {
        method: 'POST',
        headers: await this._signedDeviceHeaders(token, 'POST', url, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          status: installRec.status,
          step: installRec.step,
          version: installRec.version,
          sha256Verified: installRec.sha256Verified,
          toolCount: installRec.toolCount || 0,
          missingStep: installRec.missingStep || null,
          lastError: installRec.lastError || null,
        }),
      }).catch(() => {});
    };

    const install = await this.localInstallStore.runInstallJob({
      setup,
      store: this.wsCtx.store,
      pool: this.wsCtx.pool,
      localConfig,
      idempotencyKey,
      resolveArtifactBytes: this.resolveArtifactBytes,
      checkOsPermission: this.checkOsPermission,
      onProgress: reportToCloud,
    });
    if (install.status === 'ready' && await this.pairing()) await this.syncNow();
    this.wsCtx.broadcast?.('connections');
    return { ok: install.status === 'ready', install };
  }

  // Distinct from Disable in Loop: removes ONLY this computer's local installation;
  // keeps the saved ToolSetup in Loop Cloud ready to install again!
  async uninstallLocalSetup(setupId) {
    const cleanId = slugifySetupId(setupId);
    const out = await this.localInstallStore.uninstallLocal({
      setupId: cleanId,
      store: this.wsCtx.store,
      pool: this.wsCtx.pool,
    });
    const state = await this._readState();
    const token = state ? await this.wsCtx.vault.getInternal(CONNECT_TOKEN_VAULT_KEY).catch(() => null) : null;
    if (state && token) {
      const url = `${state.cloudUrl}/api/connect/tool-setups/${encodeURIComponent(cleanId)}/status`;
      await this.fetchImpl(url, {
        method: 'POST',
        headers: await this._signedDeviceHeaders(token, 'POST', url, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ status: 'uninstalled', step: 'uninstalled', toolCount: 0 }),
      }).catch(() => {});
    }
    this.wsCtx.broadcast?.('connections');
    return out;
  }

  // Direct Cloud Memory write (single source of truth with retry-safe idempotency).
  async saveMemoryToCloud(memoryInput) {
    const state = await this._readState();
    const token = state ? await this.wsCtx.vault.getInternal(CONNECT_TOKEN_VAULT_KEY).catch(() => null) : null;
    if (!state || !token) {
      throw new LoopConnectError('This computer is not linked to Loop Connect.', 400, 'NOT_LINKED');
    }
    const url = `${state.cloudUrl}/api/connect/memory/save`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: await this._signedDeviceHeaders(token, 'POST', url, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(memoryInput || {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new LoopConnectError(json?.error || `Cloud memory save failed (${res.status}).`, res.status);
    }
    return json;
  }

  async readMemoriesFromCloud() {
    const state = await this._readState();
    const token = state ? await this.wsCtx.vault.getInternal(CONNECT_TOKEN_VAULT_KEY).catch(() => null) : null;
    if (!state || !token) {
      throw new LoopConnectError('This computer is not linked to Loop Connect.', 400, 'NOT_LINKED');
    }
    const url = `${state.cloudUrl}/api/connect/memory`;
    const res = await this.fetchImpl(url, {
      headers: await this._signedDeviceHeaders(token, 'GET', url),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new LoopConnectError(json?.error || `Cloud memory read failed (${res.status}).`, res.status);
    }
    return Array.isArray(json?.memories) ? json.memories : [];
  }

  async unlink() {
    this._stopRelayLoop();
    await this.wsCtx.vault.delete(CONNECT_TOKEN_VAULT_KEY).catch(() => {});
    await atomicWriteFile(this.file, '{}\n', { mode: 0o600 });
    this.pairState = null;
    this.agentRequests.clear();
    return { linked: false };
  }

  createLocalRelayDispatcher() {
    return {
      handles: (conn) => isRelayConnection(conn) || isCloudRouteConnection(conn),
      listCloudRoutes: () => this.localInstallStore.listCloudRoutes(),
      catalogFor: async (deviceId) => {
        const state = await this._readState();
        const token = state && await this.wsCtx.vault.getInternal(CONNECT_TOKEN_VAULT_KEY);
        if (!token) return {};
        const url = new URL('/api/connect/relay/catalog', state.cloudUrl);
        url.searchParams.set('device', deviceId);
        const response = await this.fetchImpl(url.href, {
          headers: await this._signedDeviceHeaders(token, 'GET', url.href),
          signal: AbortSignal.timeout(3500),
        });
        return response.ok ? (await response.json()).catalog : {};
      },
      callCloudTool: async (conn, toolName, args = {}, { extraSecrets = [], signal = null } = {}) => {
        const state = await this._readState();
        const token = state ? await this.wsCtx.vault.getInternal(CONNECT_TOKEN_VAULT_KEY) : null;
        if (!state || !token) {
          throw new Error('Connect this device to Loop Connect to call Loop Cloud tools.');
        }
        const parsed = parseCloudRouteUrl(conn?.url);
        const cloudConnId = conn?.cloudConnId || parsed?.cloudConnId || conn?.id;
        const invokeUrl = `${state.cloudUrl}/api/connect/cloud/invoke`;
        const res = await this.fetchImpl(invokeUrl, {
          method: 'POST',
          headers: await this._signedDeviceHeaders(token, 'POST', invokeUrl, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            cloudConnId,
            toolName,
            arguments: args || {},
            extraSecrets,
          }),
          ...(signal ? { signal } : {}),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(maskSecrets(json?.error || `Cloud tool call failed (${res.status}).`, extraSecrets));
        }
        return maskSecrets(json.result, extraSecrets);
      },
      callTool: async (conn, toolName, args = {}, { extraSecrets = [], signal = null, profile = 'all', ownerApproved = false } = {}) => {
        if (isCloudRouteConnection(conn)) {
          return this.createLocalRelayDispatcher().callCloudTool(conn, toolName, args, { extraSecrets, signal });
        }
        const state = await this._readState();
        const token = state ? await this.wsCtx.vault.getInternal(CONNECT_TOKEN_VAULT_KEY) : null;
        if (!state || !token) {
          throw new Error('Connect this device to Loop Connect to run relayed tools from your other computer.');
        }
        const invokeUrl = `${state.cloudUrl}/api/connect/relay/invoke`;
        const res = await this.fetchImpl(invokeUrl, {
          method: 'POST',
          headers: await this._signedDeviceHeaders(token, 'POST', invokeUrl, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            relayUrl: conn.url,
            profile,
            extraSecrets,
            ownerApproved: Boolean(ownerApproved),
            toolName,
            arguments: args || {},
          }),
          ...(signal ? { signal } : {}),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(maskSecrets(json?.error || `Relayed tool call failed (${res.status}).`, extraSecrets));
        }
        if (!Object.hasOwn(json, 'result')) throw new Error('The device did not confirm a relay result. Check the action before retrying.');
        return maskSecrets(json.result, extraSecrets);
      },
    };
  }

  _startRelayLoop() {
    if (this._closed || this._relayLoopPromise) return;
    const ac = new AbortController();
    this._relayAbort = ac;
    this._relayLoopPromise = (async () => {
      let backoffMs = 250;
      while (!this._closed && !ac.signal.aborted) {
        const state = await this._readState();
        const token = state ? await this.wsCtx.vault.getInternal(CONNECT_TOKEN_VAULT_KEY).catch(() => null) : null;
        if (!state || !token || state.relayLocalTools === false) break;
        try {
          const pollUrl = `${state.cloudUrl}/api/connect/relay/poll/v2?waitMs=${this.relayPollWaitMs}`;
          const pollRes = await this.fetchImpl(pollUrl, {
            headers: await this._signedDeviceHeaders(token, 'GET', pollUrl),
            signal: ac.signal,
          });
          if (pollRes.status === 401 || pollRes.status === 402) {
            state.lastError = pollRes.status === 402
              ? 'Loop Connect subscription is inactive.'
              : 'Device token was disconnected.';
            await this._writeState(state).catch(() => {});
            break;
          }
          if (!pollRes.ok) {
            await new Promise((r) => setTimeout(r, backoffMs));
            backoffMs = Math.min(5000, backoffMs * 2);
            continue;
          }
          backoffMs = 250;
          const payload = await pollRes.json().catch(() => ({}));
          const calls = Array.isArray(payload?.calls) ? payload.calls : [];
          // Dispatch delivered relay calls concurrently so slow local stdio tools never
          // head-of-line block fast catalog or policy_sync polls.
          const runRelayCall = async (call) => {
            if (ac.signal.aborted) return;
            let body;
            try {
              const settings = await this.wsCtx.store.getSettings();
              if (settings.paused && call.kind !== 'policy_sync') throw new Error('Device gateway paused.');

              if (call.kind === 'catalog') {
                const catalog = Object.create(null);
                for (const conn of await this.wsCtx.store.list()) {
                  if (conn.transport !== 'stdio' || !conn.enabled) continue;
                  const remoteAccess = defaultRemoteAccessFor(conn);
                  if (remoteAccess === 'local_only' && !call.payload?.sameDevice) continue;
                  catalog[conn.id] = {
                    profiles: normalizeItemProfiles(conn.profiles),
                    remoteAccess,
                    tools: publishedTools(conn).map((t) => t.name),
                  };
                }
                body = { callId: call.callId, result: catalog };
              } else if (call.kind === 'install') {
                const installPayload = call.payload || {};
                const outcome = await this.installLocalSetup(installPayload.setup?.id || call.connId, {
                  setupOverride: installPayload.setup,
                  localConfig: installPayload.localConfig || {},
                  idempotencyKey: installPayload.idempotencyKey || '',
                });
                body = { callId: call.callId, result: outcome };
              } else if (call.kind === 'uninstall') {
                const targetId = call.payload?.setupId || call.connId;
                const outcome = await this.uninstallLocalSetup(targetId);
                body = { callId: call.callId, result: outcome };
              } else if (call.kind === 'policy_sync') {
                const p = call.payload || {};
                const targetId = slugifySetupId(p.setupId || call.connId);
                const localConns = await this.wsCtx.store.list();
                for (const c of localConns) {
                  if (c.id === targetId || c.toolSetupId === targetId) {
                    const patch = {};
                    if (p.enabled !== undefined) patch.enabled = Boolean(p.enabled);
                    if (p.remoteAccess !== undefined) patch.remoteAccess = p.remoteAccess;
                    if (Object.keys(patch).length) {
                      await this.wsCtx.store.update(c.id, patch).catch(() => {});
                      if (patch.enabled === false) await this.wsCtx.pool.invalidate(c.id).catch(() => {});
                    }
                  }
                }
                const route = await this.localInstallStore.getCloudRoute(targetId).catch(() => null);
                if (route && p.enabled !== undefined) {
                  await this.localInstallStore.setCloudRoute({ ...route, enabled: Boolean(p.enabled) });
                }
                this.wsCtx.broadcast?.('connections');
                body = { callId: call.callId, result: { synced: true } };
              } else {
                const localConn = await this.wsCtx.store.get(call.connId);
                if (localConn?.transport !== 'stdio' || !permitsRelayTool(localConn, call.toolName, call.payload?.sameDevice === true)) {
                  const accessMode = localConn ? defaultRemoteAccessFor(localConn) : null;
                  if (accessMode === 'local_only') {
                    throw new Error(`"${localConn.name}" is set to "This computer only" and does not allow remote calls.`);
                  }
                  throw new Error('Local tool unavailable.');
                }
                const accessMode = defaultRemoteAccessFor(localConn);
                if (accessMode === 'ask_approval' && !call.ownerApproved && !call.payload?.sameDevice) {
                  throw new Error(`"${localConn.name}" requires owner approval (2FA) before running remotely.`);
                }
                const startUrl = `${state.cloudUrl}/api/connect/relay/start`;
                const claim = await this.fetchImpl(startUrl, {
                  method: 'POST',
                  headers: await this._signedDeviceHeaders(token, 'POST', startUrl, { 'Content-Type': 'application/json' }),
                  body: JSON.stringify({ callId: call.callId }),
                  signal: ac.signal,
                });
                if (!claim.ok) return;
                const current = await this.wsCtx.store.get(call.connId);
                if (
                  (await this.wsCtx.store.getSettings()).paused ||
                  current?.transport !== 'stdio' ||
                  !connectionMatchesProfile(current, call.profile) ||
                  !permitsRelayTool(current, call.toolName, call.payload?.sameDevice === true)
                ) {
                  throw new Error('Local tool unavailable.');
                }
                const result = await this.wsCtx.pool.callTool(localConn.id, call.toolName, call.arguments || {}, {
                  signal: ac.signal,
                  extraSecrets: call.extraSecrets || [],
                });
                body = { callId: call.callId, result: maskSecrets(result, call.extraSecrets || []) };
              }
            } catch (err) {
              body = { callId: call.callId, error: maskSecrets(err?.message || 'Local tool execution failed.', call.extraSecrets || []) };
            }
            const respondUrl = `${state.cloudUrl}/api/connect/relay/respond`;
            await this.fetchImpl(respondUrl, {
              method: 'POST',
              headers: await this._signedDeviceHeaders(token, 'POST', respondUrl, { 'Content-Type': 'application/json' }),
              body: JSON.stringify(body),
              signal: ac.signal,
            }).catch(() => {});
          };
          if (calls.length > 0) {
            for (const call of calls) {
              void runRelayCall(call);
            }
          }
        } catch {
          if (ac.signal.aborted || this._closed) break;
          await new Promise((r) => setTimeout(r, backoffMs));
          backoffMs = Math.min(5000, backoffMs * 2);
        }
      }
    })().finally(() => {
      if (this._relayAbort === ac) this._relayAbort = null;
      this._relayLoopPromise = null;
    });
  }

  _stopRelayLoop() {
    if (this._relayAbort) {
      this._relayAbort.abort();
      this._relayAbort = null;
    }
  }

  async close() {
    clearTimeout(this.catalogTimer);
    this.agentRequests.clear();
    this._closed = true;
    this._stopRelayLoop();
    if (this._relayLoopPromise) {
      await this._relayLoopPromise.catch(() => {});
    }
  }

  async handleHttp({ req, res, pathname, method, readJsonBody, sendJson }) {
    const handlesPath =
      pathname.startsWith('/api/local/connect') ||
      pathname.startsWith('/api/local/tool-setups') ||
      /^\/api\/local\/mcps\/[a-z0-9_]+\/(?:promote|demote|make-portable|remote-access)$/.test(pathname);
    if (!handlesPath) return false;

    try {
      const grantPoll = /^\/api\/local\/connect\/agent-requests\/([a-f0-9]{36})$/.exec(pathname);
      if (grantPoll && method === 'POST') {
        sendJson(res, 200, await this.finishAgents(grantPoll[1]));
        return true;
      }
      if (pathname === '/api/local/connect' && method === 'GET') {
        sendJson(res, 200, await this.getStatus());
        return true;
      }
      if (pathname === '/api/local/connect/link' && method === 'POST') {
        const body = await readJsonBody(req);
        const status = await this.link({
          cloudUrl: body?.cloudUrl,
          code: body?.code,
          deviceName: body?.deviceName,
          relayLocalTools: body?.relayLocalTools !== false,
        });
        sendJson(res, 200, status);
        return true;
      }
      if (pathname === '/api/local/connect/sync' && method === 'POST') {
        sendJson(res, 200, await this.syncNow());
        return true;
      }
      if (pathname === '/api/local/connect/network' && method === 'PATCH') {
        const body = await readJsonBody(req);
        sendJson(res, 200, await this.updateNetworkConfig(body));
        return true;
      }
      if (pathname === '/api/local/connect/memory' && method === 'POST') {
        const body = await readJsonBody(req);
        sendJson(res, 200, await this.saveMemoryToCloud(body));
        return true;
      }
      if (pathname === '/api/local/connect/memory' && method === 'GET') {
        sendJson(res, 200, { memories: await this.readMemoriesFromCloud() });
        return true;
      }
      if (pathname === '/api/local/connect' && method === 'DELETE') {
        sendJson(res, 200, await this.unlink());
        return true;
      }

      // Local ToolSetup catalog + one-click install + distinct uninstall
      if (pathname === '/api/local/tool-setups' && method === 'GET') {
        const [setups, cloudRoutes] = await Promise.all([
          this.listToolSetupsForThisComputer(),
          this.localInstallStore.listCloudRoutes(),
        ]);
        sendJson(res, 200, { setups, cloudRoutes });
        return true;
      }
      const localInstallMatch = pathname.match(/^\/api\/local\/tool-setups\/([a-z0-9_-]+)\/install$/);
      if (localInstallMatch && method === 'POST') {
        const body = await readJsonBody(req);
        const out = await this.installLocalSetup(localInstallMatch[1], {
          localConfig: body?.localConfig || {},
          idempotencyKey: body?.idempotencyKey || '',
        });
        sendJson(res, 200, out);
        return true;
      }
      const localUninstallMatch = pathname.match(/^\/api\/local\/tool-setups\/([a-z0-9_-]+)\/uninstall$/);
      if (localUninstallMatch && method === 'POST') {
        const out = await this.uninstallLocalSetup(localUninstallMatch[1]);
        sendJson(res, 200, out);
        return true;
      }

      // Promote / Demote / Make Portable / Remote Access on local connections
      const promoteMatch = pathname.match(/^\/api\/local\/mcps\/([a-z0-9_]+)\/promote$/);
      if (promoteMatch && method === 'POST') {
        sendJson(res, 200, await this.promoteToCloud(promoteMatch[1]));
        return true;
      }
      const demoteMatch = pathname.match(/^\/api\/local\/mcps\/([a-z0-9_]+)\/demote$/);
      if (demoteMatch && method === 'POST') {
        sendJson(res, 200, await this.demoteToLocal(demoteMatch[1]));
        return true;
      }
      const portableMatch = pathname.match(/^\/api\/local\/mcps\/([a-z0-9_]+)\/make-portable$/);
      if (portableMatch && method === 'POST') {
        const body = await readJsonBody(req);
        sendJson(res, 200, await this.makeLocalToolPortable(portableMatch[1], body?.installSpec || body));
        return true;
      }
      const remoteAccessMatch = pathname.match(/^\/api\/local\/mcps\/([a-z0-9_]+)\/remote-access$/);
      if (remoteAccessMatch && method === 'PATCH') {
        const body = await readJsonBody(req);
        sendJson(res, 200, await this.setLocalRemoteAccess(remoteAccessMatch[1], body?.remoteAccess));
        return true;
      }

      sendJson(res, 404, { error: 'Not found.' });
      return true;
    } catch (err) {
      if (err instanceof LoopConnectError || err instanceof ToolSetupError) {
        sendJson(res, err.status || 400, { error: err.publicMessage || err.message, code: err.code });
        return true;
      }
      throw err;
    }
  }
}
