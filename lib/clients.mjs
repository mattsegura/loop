// Tracks which agent apps (Claude Code, Codex, Kimi…) have connected to Loop and
// their sessions. One app = one agent; every MCP `initialize` = one session, the
// way one connection has many tools. Stored in clients.json, never arguments.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './json-file-store.mjs';
import { extractMcpAppCapability } from './mcp-apps.mjs';
import { extractMcpSkillsCapability } from './mcp-skills.mjs';
import { defaultDataDir } from './vault.mjs';

export const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const SESSION_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const SESSIONS_PER_APP = 50;
const MAX_ACTIVE_SESSIONS_PER_APP = 500;

function isSessionActive(session, now) {
  if (!session || session.closedAt) return false;
  const ts = Date.parse(session.lastSeenAt);
  return Number.isFinite(ts) && now - ts < ACTIVE_WINDOW_MS;
}

const CLIENT_LABELS = [
  [/^claude-code$/i, 'Claude Code'],
  [/^claude-ai$|^claude[- ]?desktop$/i, 'Claude Desktop'],
  [/^codex/i, 'Codex'],
  [/^kimi/i, 'Kimi'],
  [/^cursor/i, 'Cursor'],
  [/^antigravity/i, 'Antigravity'],
  [/^gemini/i, 'Gemini CLI'],
  [/^(visual studio code|vscode)/i, 'VS Code'],
  [/^opencode/i, 'OpenCode'],
  [/^windsurf/i, 'Windsurf'],
  [/^zed/i, 'Zed'],
  [/^pi([- ]|$)/i, 'Pi'],
  [/^t3[- ]?code/i, 'T3 Code'],
  [/^mcp-inspector|^inspector/i, 'MCP Inspector'],
];

/** Apps that Loop knows by name. Any other label is text that an app chose for itself. */
export const KNOWN_CLIENT_LABELS = new Set(CLIENT_LABELS.map(([, label]) => label));

export function clientLabel(name) {
  const raw = String(name || '').trim();
  if (!raw) return 'Unknown app';
  for (const [re, label] of CLIENT_LABELS) if (re.test(raw)) return label;
  return raw
    .replace(/[-_]+/g, ' ')
    .replace(/\b(mcp|client)\b/gi, '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase()) || raw;
}

function appKey(clientName, agent) {
  if (agent?.id) return `agent:${agent.id}`;
  return `client:${clientLabel(clientName).toLowerCase()}`;
}

export function summarizeClientCapabilities(rawCaps, clientInfo = null) {
  const caps = rawCaps && typeof rawCaps === 'object' && !Array.isArray(rawCaps) ? rawCaps : {};
  const raw = caps.elicitation;
  let elicitation = { form: false, url: false };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const hasExplicit = Object.hasOwn(raw, 'form') || Object.hasOwn(raw, 'url');
    elicitation = {
      // MCP 2025-06-18 / 2025-11-25: empty `elicitation: {}` signals form support.
      form: !hasExplicit || Boolean(raw.form && typeof raw.form === 'object' && !Array.isArray(raw.form)),
      url: Boolean(raw.url && typeof raw.url === 'object' && !Array.isArray(raw.url)),
    };
  }
  const loopMeta =
    (caps.experimental && typeof caps.experimental === 'object' && caps.experimental.loop && typeof caps.experimental.loop === 'object'
      ? caps.experimental.loop
      : null) ||
    (caps.loop && typeof caps.loop === 'object' ? caps.loop : null) ||
    {};
  const rawSurface = String(loopMeta.surface || clientInfo?.surface || '').trim().toLowerCase().slice(0, 32);
  const surface = rawSurface || null;
  const isSms = surface === 'sms' || surface === 'imessage';
  return {
    elicitation,
    mcpApps: extractMcpAppCapability(caps),
    mcpSkills: extractMcpSkillsCapability(caps),
    surface,
    delegatedApprovals: Boolean(loopMeta.delegatedApprovals || loopMeta.approvalLink || isSms),
    compactInstructions: Boolean(loopMeta.compactInstructions || isSms),
    noVisualTrees: Boolean(loopMeta.noVisualTrees || isSms),
  };
}

export class ClientRegistry {
  constructor(dir = defaultDataDir()) {
    this.dir = dir;
    this.file = path.join(dir, 'clients.json');
    this.apps = null; // key -> app
    this.sessionIndex = new Map(); // sessionId -> app key
    this._loadPromise = null;
    this._queue = Promise.resolve();
    this._saveTimer = null;
    this._listeners = new Set();
  }

  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }

  _notify() {
    for (const fn of this._listeners) {
      try {
        fn();
      } catch {
        // Ignore SSE listener errors.
      }
    }
  }

  async _load() {
    if (this.apps) return;
    if (!this._loadPromise) {
      this._loadPromise = (async () => {
        let data = {};
        try {
          data = JSON.parse(await readFile(this.file, 'utf8'));
        } catch (err) {
          if (err?.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
        }
        const apps = new Map();
        for (const app of Array.isArray(data?.apps) ? data.apps : []) {
          if (!app?.key) continue;
          app.sessions = Array.isArray(app.sessions) ? app.sessions : [];
          apps.set(app.key, app);
          for (const s of app.sessions) this.sessionIndex.set(s.id, app.key);
        }
        this.apps = apps;
      })().finally(() => {
        this._loadPromise = null;
      });
    }
    await this._loadPromise;
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._queue = this._queue.then(() => this._save()).catch(() => {});
    }, 250);
    this._saveTimer.unref?.();
  }

  async _save() {
    await atomicWriteFile(
      this.file,
      JSON.stringify({ apps: [...this.apps.values()] }, null, 2) + '\n',
      { mode: 0o600, backup: false, fsync: true },
    );
  }

  _prune(app, now) {
    const active = [];
    const inactive = [];
    for (const s of app.sessions) {
      if (isSessionActive(s, now)) {
        active.push(s);
      } else {
        const ts = Date.parse(s.lastSeenAt);
        if (Number.isFinite(ts) && now - ts < SESSION_KEEP_MS) {
          inactive.push(s);
        }
      }
    }

    // Preserve active live sessions (up to generous safety cap) and prune closed/idle
    // sessions first so a burst of sessions never evicts live ones.
    const keptActive = active.slice(-MAX_ACTIVE_SESSIONS_PER_APP);
    const inactiveBudget = Math.max(0, SESSIONS_PER_APP - keptActive.length);
    const keptInactive = inactiveBudget > 0 ? inactive.slice(-inactiveBudget) : [];

    const keptSet = new Set([...keptActive, ...keptInactive]);
    const trimmed = app.sessions.filter((s) => keptSet.has(s));
    for (const s of app.sessions) {
      if (!keptSet.has(s)) this.sessionIndex.delete(s.id);
    }
    app.sessions = trimmed;
  }

  /** Record an MCP `initialize`. Returns the new session id. */
  async startSession({
    clientInfo,
    clientCapabilities = null,
    protocolVersion = null,
    agent = null,
    transport = 'http',
    baseProfile = 'all',
    project = null,
    simulated = false,
  } = {}) {
    await this._load();
    const now = Date.now();
    const at = new Date(now).toISOString();
    const clientName = String(clientInfo?.name || '').slice(0, 120);
    const key = appKey(clientName, agent);
    let app = this.apps.get(key);
    if (!app) {
      app = { key, name: agent?.name || clientLabel(clientName), firstSeenAt: at, sessions: [] };
      this.apps.set(key, app);
    }
    if (agent?.name) app.name = agent.name;
    app.agentId = agent?.id || null;
    if (!simulated) {
      app.clientName = clientName || app.clientName || null;
      app.clientVersion = String(clientInfo?.version || '').slice(0, 60) || null;
      app.transport = transport;
      app.lastSeenAt = at;
    }
    const capabilities = summarizeClientCapabilities(clientCapabilities, clientInfo);
    const cleanProtocol = typeof protocolVersion === 'string' ? protocolVersion.trim().slice(0, 40) || null : null;
    const id = randomUUID();
    app.sessions.push({
      id,
      baseProfile,
      project: baseProfile === 'all' ? project : null,
      startedAt: at,
      lastSeenAt: at,
      closedAt: null,
      clientName: clientName || null,
      clientVersion: String(clientInfo?.version || '').slice(0, 60) || null,
      transport,
      capabilities,
      protocolVersion: cleanProtocol,
      ...(simulated ? { simulated: true } : {}),
    });
    this.sessionIndex.set(id, key);
    this._prune(app, now);
    if (!simulated) {
      this._scheduleSave();
      this._notify();
    }
    return id;
  }

  async getSession(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return null;
    await this._load();
    const key = this.sessionIndex.get(sessionId);
    const app = key ? this.apps.get(key) : null;
    const session = app?.sessions.find((s) => s.id === sessionId);
    if (!app || !session) return null;
    const effectiveClientName = session.clientName || app.clientName || null;
    return {
      id: session.id,
      appKey: app.key,
      baseProfile: session.baseProfile ?? null,
      project: session.project ?? null,
      agentId: app.agentId ?? null,
      clientName: effectiveClientName,
      clientVersion: session.clientVersion ?? null,
      transport: session.transport ?? app.transport ?? null,
      capabilities: session.capabilities || { elicitation: { form: false, url: false } },
      protocolVersion: session.protocolVersion ?? null,
      closedAt: session.closedAt ?? null,
    };
  }

  async setSessionProject(sessionId, agentId, project) {
    await this._load();
    const app = this.apps.get(this.sessionIndex.get(sessionId));
    const session = app?.sessions.find(s => s.id === sessionId);
    if (!session || session.closedAt || (app.agentId ?? null) !== agentId || session.baseProfile !== 'all') {
      throw new Error('Project switching requires an active workspace-wide session.');
    }
    session.project = project;
    this._scheduleSave();
  }

  // Sessions that had entered a project that no longer exists.
  async leaveProject(project) {
    await this._load();
    const inside = [...this.apps.values()].flatMap((app) => app.sessions).filter((s) => s.project === project);
    for (const session of inside) session.project = null;
    if (inside.length > 0) this._scheduleSave();
  }

  async ownsSession(sessionId, agentId) {
    await this._load();
    const app = this.apps.get(this.sessionIndex.get(sessionId));
    return !!app && app.agentId === agentId && app.sessions.some(s => s.id === sessionId && !s.closedAt);
  }

  async activeProjectForSession(sessionId) {
    if (!sessionId) return null;
    const session = await this.getSession(sessionId);
    if (!session || session.closedAt) return null;
    return session.project || (session.baseProfile && session.baseProfile !== 'all' ? session.baseProfile : null);
  }

  async activeProjectForAgent(agentId, { sessionId = null } = {}) {
    if (sessionId) return this.activeProjectForSession(sessionId);
    if (!agentId) return null;
    await this._load();
    const app = this.apps.get(`agent:${agentId}`);
    if (!app) return null;
    const now = Date.now();
    const projects = new Set();
    for (const s of app.sessions) {
      if (!isSessionActive(s, now)) continue;
      if (s.project) projects.add(s.project);
    }
    return projects.size === 1 ? [...projects][0] : null;
  }

  async touchSession(sessionId, { used = false } = {}) {
    if (!sessionId) return;
    await this._load();
    const app = this.apps.get(this.sessionIndex.get(sessionId));
    const session = app?.sessions.find((s) => s.id === sessionId);
    if (!session || session.closedAt) return;
    const at = new Date().toISOString();
    if (used) session.used = true;
    session.lastSeenAt = at;
    if (!session.simulated) {
      app.lastSeenAt = at;
      this._scheduleSave();
    }
  }

  async endSession(sessionId) {
    if (!sessionId) return false;
    await this._load();
    const app = this.apps.get(this.sessionIndex.get(sessionId));
    const session = app?.sessions.find((s) => s.id === sessionId);
    if (!session) return false;
    session.closedAt = new Date().toISOString();
    this._scheduleSave();
    this._notify();
    return true;
  }

  async forget(key) {
    await this._load();
    const app = this.apps.get(key);
    if (!app) return false;
    for (const s of app.sessions) this.sessionIndex.delete(s.id);
    this.apps.delete(key);
    this._scheduleSave();
    this._notify();
    return true;
  }

  async list() {
    await this._load();
    const now = Date.now();
    return [...this.apps.values()]
      .map((app) => {
        const realSessions = app.sessions.filter((s) => !s.simulated);
        if (realSessions.length === 0) return null;
        // Clients open a session for every health check and never close it. Count the sessions that
        // called a tool, and the newest one, so one connected agent reads as one session, not three.
        const open = realSessions.filter(
          (s) => !s.closedAt && now - Date.parse(s.lastSeenAt) < ACTIVE_WINDOW_MS,
        );
        const newest = open[open.length - 1]; // sessions are kept in the order they started
        const active = open.filter((s) => s.used || s === newest).length;
        return {
          key: app.key,
          name: app.name,
          clientName: app.clientName || null,
          clientVersion: app.clientVersion || null,
          agentId: app.agentId || null,
          transport: app.transport || 'http',
          firstSeenAt: app.firstSeenAt,
          lastSeenAt: app.lastSeenAt || app.firstSeenAt,
          sessionsActive: active,
          sessionsTotal: realSessions.length,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.sessionsActive - a.sessionsActive || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  }

  async flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this._queue = this._queue.then(() => this._save()).catch(() => {});
    }
    await this._queue;
  }
}
