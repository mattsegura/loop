// Profile share links and members for hosted Loop.
//
// A share link always points at one named profile in one owner workspace.
//   kind "me"    : the owner opens it on another device and connects another of their own agents.
//   kind "other" : someone else signs in to their own Loop account and joins. Their agents get
//                  their own keys in the owner's workspace, scoped to that profile only, so they
//                  can never see the owner's other profiles. Removing them revokes those keys.
// Links never carry a key. A key is minted only after the person signs in.

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { agentTokenVaultKey, hashAgentToken, issueAgentToken } from './agents.mjs';
import { connectionMatchesProfile, normalizeProfileTag } from './profiles.mjs';
import { isSharedConnection } from './shared-connection.mjs';

export const SHARE_KINDS = new Set(['me', 'other']);
const CODE_RE = /^[A-Za-z0-9]{10,32}$/;
const WS_RE = /^[0-9a-f]{64}$/;
const MAX_LINKS = 5000;
const MAX_MEMBERS = 20000;
const MAX_AGENTS_PER_MEMBER = 10;
const AGENT_LABELS = new Map([
  ['claude', 'Claude Code'],
  ['cursor', 'Cursor'],
  ['codex', 'Codex'],
  ['other', 'Agent'],
]);

export function isShareCode(code) {
  return typeof code === 'string' && CODE_RE.test(code);
}

function cleanText(value, max = 80) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function newCode() {
  // 16 base62-ish chars from 96 random bits.
  return randomBytes(12).toString('base64url').replace(/[-_]/g, '').slice(0, 14) + randomBytes(2).toString('hex');
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status, publicMessage: message });
}

export class ShareStore {
  constructor(baseDir) {
    this.dir = path.resolve(baseDir);
    this.file = path.join(this.dir, 'shares.json');
    this.data = null;
    this._queue = Promise.resolve();
  }

  async _load() {
    if (this.data) return this.data;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (this.data) return this.data;
      this.data = {
        links: raw && typeof raw.links === 'object' && !Array.isArray(raw.links) ? raw.links : {},
        members: Array.isArray(raw?.members) ? raw.members : [],
      };
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      if (this.data) return this.data;
      this.data = { links: {}, members: [] };
    }
    return this.data;
  }

  async _save() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }

  _locked(fn) {
    const run = this._queue.then(async () => {
      await this._load();
      try {
        return await fn(this.data);
      } catch (err) {
        this.data = null; // Reload the durable membership before retrying a failed write.
        throw err;
      }
    });
    this._queue = run.catch(() => {});
    return run;
  }

  async getLink(code) {
    if (!isShareCode(code)) return null;
    const data = await this._load();
    const link = data.links[code];
    return link && !link.revoked ? { ...link } : null;
  }

  // One live link per (workspace, profile, kind), so the owner always sees the same URL.
  async linkFor({ workspaceId, profile, kind, ownerName }) {
    if (!WS_RE.test(String(workspaceId || ''))) throw httpError('Sharing needs a Loop Cloud workspace.', 400);
    if (!SHARE_KINDS.has(kind)) throw httpError('kind must be "me" or "other".', 400);
    const cleanProfile = normalizeProfileTag(profile);
    if (!cleanProfile || cleanProfile === 'all') throw httpError('Make a profile first. Default is never shared.', 400);
    return this._locked(async (data) => {
      const existing = Object.values(data.links).find(
        (l) => !l.revoked && l.workspaceId === workspaceId && l.profile === cleanProfile && l.kind === kind,
      );
      if (existing) {
        const name = cleanText(ownerName, 60);
        if (name && existing.ownerName !== name) {
          existing.ownerName = name;
          await this._save();
        }
        return { ...existing };
      }
      if (Object.keys(data.links).length >= MAX_LINKS) throw httpError('Too many share links.', 429);
      let code = newCode();
      while (data.links[code]) code = newCode();
      const link = {
        code,
        workspaceId,
        profile: cleanProfile,
        kind,
        ownerName: cleanText(ownerName, 60),
        createdAt: new Date().toISOString(),
        revoked: false,
      };
      data.links[code] = link;
      await this._save();
      return { ...link };
    });
  }

  async revokeLink(workspaceId, code) {
    return this._locked(async (data) => {
      const link = data.links[code];
      if (!link || link.workspaceId !== workspaceId || link.revoked) return false;
      link.revoked = true;
      link.revokedAt = new Date().toISOString();
      await this._save();
      return true;
    });
  }

  async membersOf(workspaceId, profile = null) {
    const data = await this._load();
    return data.members
      .filter((m) => m.workspaceId === workspaceId && (!profile || m.profile === profile))
      .map((m) => ({ ...m, agentIds: [...m.agentIds] }));
  }

  async memberFor(workspaceId, profile, memberWorkspaceId) {
    const data = await this._load();
    const m = data.members.find(
      (x) => x.workspaceId === workspaceId && x.profile === profile && x.memberWorkspaceId === memberWorkspaceId,
    );
    return m ? { ...m, agentIds: [...m.agentIds] } : null;
  }

  // Is this the agent of a member, and so of somebody else than the owner?
  async isMemberAgent(workspaceId, agentId) {
    const data = await this._load();
    return data.members.some((m) => m.workspaceId === workspaceId && m.agentIds.includes(agentId));
  }

  async sharedWith(memberWorkspaceId) {
    const data = await this._load();
    return data.members
      .filter((m) => m.memberWorkspaceId === memberWorkspaceId)
      .map((m) => ({ ...m, agentIds: [...m.agentIds] }));
  }

  async upsertMember({ workspaceId, profile, memberWorkspaceId, name, email, code }) {
    return this._locked(async (data) => {
      const link = data.links[code];
      if (!link || link.revoked || link.workspaceId !== workspaceId || link.profile !== profile || link.removedMembers?.includes(memberWorkspaceId)) {
        throw httpError('This invitation is no longer available to this member.', 403);
      }
      let m = data.members.find(
        (x) => x.workspaceId === workspaceId && x.profile === profile && x.memberWorkspaceId === memberWorkspaceId,
      );
      if (!m) {
        if (data.members.length >= MAX_MEMBERS) throw httpError('Too many members.', 429);
        m = {
          id: randomBytes(8).toString('hex'),
          workspaceId,
          profile,
          memberWorkspaceId,
          code,
          name: cleanText(name, 60) || 'Someone',
          email: cleanText(email, 120),
          agentIds: [],
          joinedAt: new Date().toISOString(),
        };
        data.members.push(m);
      } else {
        if (cleanText(name, 60)) m.name = cleanText(name, 60);
        if (cleanText(email, 120)) m.email = cleanText(email, 120);
      }
      await this._save();
      return { ...m, agentIds: [...m.agentIds] };
    });
  }

  async mintMemberAgent(memberId, code, mint, discard) {
    return this._locked(async (data) => {
      const m = data.members.find((x) => x.id === memberId);
      if (!m || !data.links[code] || data.links[code].revoked) throw httpError('Membership is no longer active.', 403);
      if (m.agentIds.length >= MAX_AGENTS_PER_MEMBER) throw httpError('Agent limit reached.', 400);
      const issued = await mint();
      m.agentIds.push(issued.agent.id);
      try {
        await this._save();
      } catch (err) {
        await discard(issued.agent.id);
        throw err;
      }
      return issued;
    });
  }

  async removeMember(workspaceId, memberId, revoke) {
    return this._locked(async (data) => {
      const idx = data.members.findIndex((x) => x.id === memberId && x.workspaceId === workspaceId);
      if (idx < 0) return null;
      await revoke(data.members[idx].agentIds);
      const [removed] = data.members.splice(idx, 1);
      for (const link of Object.values(data.links)) {
        if (link.workspaceId === workspaceId && link.profile === removed.profile && !link.revoked && link.kind === 'other') {
          link.removedMembers = [...new Set([...(link.removedMembers || []), removed.memberWorkspaceId])];
        }
      }
      await this._save();
      return removed;
    });
  }

  async leaveMember(memberWorkspaceId, memberId, revoke) {
    return this._locked(async (data) => {
      const idx = data.members.findIndex((x) => x.id === memberId && x.memberWorkspaceId === memberWorkspaceId);
      if (idx < 0) return null;
      const member = data.members[idx];
      await revoke(member);
      data.members.splice(idx, 1);
      await this._save();
      return member;
    });
  }

  // Drops members (and reports their agents) when a profile is deleted.
  async removeProfile(workspaceId, profile) {
    return this._locked(async (data) => {
      const gone = data.members.filter((m) => m.workspaceId === workspaceId && m.profile === profile);
      data.members = data.members.filter((m) => !(m.workspaceId === workspaceId && m.profile === profile));
      for (const l of Object.values(data.links)) {
        if (l.workspaceId === workspaceId && l.profile === profile && !l.revoked) {
          l.revoked = true;
          l.revokedAt = new Date().toISOString();
        }
      }
      await this._save();
      return gone;
    });
  }
}

// Finds which hosted workspace issued an agent token, so a plain https://host/mcp works
// for every account. Misses rescan workspace configs at most once every few seconds.
export class TokenRouter {
  constructor(usersDir, { rescanMs = 3000 } = {}) {
    this.usersDir = path.resolve(usersDir);
    this.rescanMs = rescanMs;
    this.byHash = new Map();
    this.disabledOAuthByHash = new Map();
    this.lastScan = 0;
    this._scan = null;
    this.duringScan = new Map();
  }

  remember(token, workspaceId) {
    if (typeof token === 'string' && WS_RE.test(String(workspaceId || ''))) {
      const hash = hashAgentToken(token);
      this.byHash.set(hash, workspaceId);
      if (this._scan) this.duringScan.set(hash, workspaceId);
    }
  }

  async _rescan() {
    const next = new Map();
    const disabledOAuth = new Map();
    let dirs = [];
    try {
      dirs = await readdir(this.usersDir);
    } catch {
      dirs = [];
    }
    for (const id of dirs) {
      if (!WS_RE.test(id)) continue;
      try {
        const cfg = JSON.parse(await readFile(path.join(this.usersDir, id, 'config.json'), 'utf8'));
        for (const agent of Array.isArray(cfg?.agents) ? cfg.agents : []) {
          const enabled = agent.enabled !== false;
          if (!enabled && !agent.oauthClientId) continue;
          const index = enabled ? next : disabledOAuth;
          if (typeof agent.tokenHash === 'string') index.set(agent.tokenHash, id);
          for (const hash of Array.isArray(agent.tokenHashes) ? agent.tokenHashes : []) {
            if (typeof hash === 'string') index.set(hash, id);
          }
          if (enabled && typeof agent.recallTokenHash === 'string') next.set(agent.recallTokenHash, id);
        }
      } catch {
        // Workspace without config yet, or mid-write: skip it this round.
      }
    }
    for (const [hash, id] of this.duringScan) next.set(hash, id);
    this.duringScan.clear();
    this.byHash = next;
    this.disabledOAuthByHash = disabledOAuth;
    this.lastScan = Date.now();
  }

  async resolve(token, { includeDisabledOAuth = false } = {}) {
    if (typeof token !== 'string' || !/^loop_(?:rc_)?[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = hashAgentToken(token);
    if (this.byHash.has(hash)) return this.byHash.get(hash);
    if (Date.now() - this.lastScan >= this.rescanMs) {
      if (!this._scan) this._scan = this._rescan().finally(() => { this._scan = null; });
      await this._scan;
    }
    return this.byHash.get(hash) || (includeDisabledOAuth && this.disabledOAuthByHash.get(hash)) || null;
  }
}

function agentKind(kind) {
  return AGENT_LABELS.has(kind) ? kind : 'other';
}

async function profileSummary(ctx, profile) {
  const [record, mcps] = await Promise.all([ctx.store.getProfile(profile), ctx.store.list()]);
  if (!record) return null;
  const connections = mcps
    .filter((m) => connectionMatchesProfile(m, profile) && !isSharedConnection(m)) // what is lent is not lent on
    .map((m) => ({ id: m.id, name: cleanText(m.name || m.id, 80) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { id: record.id, name: cleanText(record.name || record.id, 60), connections };
}

// Mints a fresh, non-managing agent in the owner's workspace for this profile.
async function mintAgent(ctx, { name, kind, profile }) {
  const existing = await ctx.store.listAgents();
  let unique = cleanText(name, 80) || 'Agent';
  if (existing.some((a) => String(a.name).toLowerCase() === unique.toLowerCase())) {
    for (let n = 2; ; n += 1) {
      const candidate = `${unique.slice(0, 74)} (${n})`;
      if (!existing.some((a) => String(a.name).toLowerCase() === candidate.toLowerCase())) {
        unique = candidate;
        break;
      }
    }
  }
  const created = await ctx.store.addAgent({
    name: unique,
    kind: agentKind(kind),
    profile,
    mode: 'default',
    canManage: false,
    memoryAccess: 'read',
    secrets: [],
    enabled: true,
  });
  try {
    const { agent, token } = await issueAgentToken(ctx.store, ctx.vault, created.id);
    ctx.broadcast?.('agents');
    return { agent, token };
  } catch (err) {
    await ctx.store.removeAgent(created.id).catch(() => {});
    await ctx.vault.delete(agentTokenVaultKey(created.id)).catch(() => {});
    throw err;
  }
}

async function dropAgents(ctx, agentIds) {
  for (const id of agentIds) {
    await ctx.store.removeAgent(id);
    await ctx.vault.delete(agentTokenVaultKey(id));
  }
  ctx.broadcast?.('agents');
}

// HTTP handler for /api/shares* (owner, signed in) and /api/join/* (public preview, signed-in join).
// Returns true when it answered the request.
export async function handleShareApi({
  req, res, pathname, method, workspace, identity, workspaces, shares, router, origin, readJsonBody, sendJson,
}) {
  if (!pathname.startsWith('/api/shares') && !pathname.startsWith('/api/join/')) return false;
  const mcpUrl = `${origin}/mcp`;

  // ---- Public invite preview -------------------------------------------------------------
  const joinMatch = pathname.match(/^\/api\/join\/([A-Za-z0-9]+)(?:\/(agents)(?:\/([a-z0-9_]+))?)?$/);
  if (joinMatch) {
    const [, code, sub, agentId] = joinMatch;
    const link = await shares.getLink(code);
    const ownerWs = link ? workspaces.personal(link.workspaceId, false) : null;
    const ctx = ownerWs?.shareContext || null;
    const summary = ctx ? await profileSummary(ctx, link.profile) : null;
    if (!link || !summary) {
      sendJson(res, 404, { error: 'This invite link is no longer active.' });
      return true;
    }
    const isOwner = Boolean(workspace?.id && workspace.id === link.workspaceId);

    if (!sub && method === 'GET') {
      let joined = null;
      if (workspace?.id && !isOwner && link.kind === 'other') {
        joined = await shares.memberFor(link.workspaceId, link.profile, workspace.id);
      }
      sendJson(res, 200, {
        kind: link.kind,
        ownerName: link.ownerName || 'A Loop user',
        profile: { name: summary.name, connections: summary.connections.map((c) => c.name) },
        signedIn: Boolean(workspace),
        isOwner,
        joined: Boolean(joined) || (isOwner && link.kind === 'me'),
        mcpUrl,
      });
      return true;
    }

    if (!workspace) {
      sendJson(res, 401, { error: 'Sign in to Loop to continue.', auth: 'required' });
      return true;
    }
    if (link.kind === 'me' && !isOwner) {
      sendJson(res, 403, { error: `This link is only for ${link.ownerName || 'its owner'}’s own agents. Ask them for an invite link.` });
      return true;
    }

    // Mint a key for one agent. Owner on a "me" link, or a member (joining on first use).
    if (sub === 'agents' && !agentId && method === 'POST') {
      const body = await readJsonBody(req);
      const kind = agentKind(body?.kind);
      const label = AGENT_LABELS.get(kind);
      let member = null;
      let name;
      if (isOwner) {
        name = `${label} · ${summary.name}`;
      } else {
        member = await shares.upsertMember({
          workspaceId: link.workspaceId,
          profile: link.profile,
          memberWorkspaceId: workspace.id,
          name: body?.name,
          email: body?.email,
          code,
        });
        if (member.agentIds.length >= MAX_AGENTS_PER_MEMBER) {
          sendJson(res, 400, { error: 'You already have the most agents allowed on this profile. Remove one first.' });
          return true;
        }
        name = `${member.name} · ${label}`;
      }
      const mint = () => mintAgent(ctx, { name, kind, profile: link.profile });
      const { agent, token } = member
        ? await shares.mintMemberAgent(member.id, code, mint, (id) => dropAgents(ctx, [id]))
        : await mint();
      router?.remember(token, link.workspaceId);
      // Logged without agentId so making the key does not count as the agent having connected.
      ctx.activity?.record({ agentName: agent.name, method: 'share/join', target: summary.name, ok: true });
      sendJson(res, 201, { agentId: agent.id, agentName: agent.name, token, mcpUrl, profile: summary.name });
      return true;
    }

    // Has this freshly minted agent connected yet? Only the person who minted it may ask.
    if (sub === 'agents' && agentId && method === 'GET') {
      let allowed = isOwner;
      if (!allowed) {
        const member = await shares.memberFor(link.workspaceId, link.profile, workspace.id);
        allowed = Boolean(member?.agentIds.includes(agentId));
      }
      const agent = allowed ? await ctx.store.getAgent(agentId) : null;
      if (!agent) {
        sendJson(res, 404, { error: 'Agent not found.' });
        return true;
      }
      const lastSeenAt = await ctx.activity.lastSeenFor(agent.id);
      sendJson(res, 200, { agentId: agent.id, connected: Boolean(lastSeenAt), lastSeenAt });
      return true;
    }

    sendJson(res, 405, { error: 'Method not allowed.' });
    return true;
  }

  // ---- Owner side -------------------------------------------------------------------------
  if (!workspace) {
    sendJson(res, 401, { error: 'Sign in to Loop to continue.', auth: 'required' });
    return true;
  }
  const ctx = workspace.shareContext;

  if (pathname === '/api/shares/with-me' && method === 'GET') {
    const list = workspace.id ? await shares.sharedWith(workspace.id) : [];
    const out = [];
    for (const m of list) {
      const link = await shares.getLink(m.code);
      const ownerWs = workspaces.personal(m.workspaceId, false);
      const summary = ownerWs?.shareContext ? await profileSummary(ownerWs.shareContext, m.profile) : null;
      if (!summary) continue;
      out.push({ id: m.id, ownerName: link?.ownerName || 'A Loop user', profile: summary.name, connections: summary.connections.length, agents: m.agentIds.length, code: link ? m.code : null });
    }
    sendJson(res, 200, { shared: out });
    return true;
  }

  const leaveMatch = pathname.match(/^\/api\/shares\/with-me\/([0-9a-f]{16})$/);
  if (leaveMatch && method === 'DELETE') {
    if (!workspace.id) {
      sendJson(res, 400, { error: 'Sign in to Loop Cloud to manage shared projects.' });
      return true;
    }
    const left = await shares.leaveMember(workspace.id, leaveMatch[1], async (member) => {
      const ownerWs = workspaces.personal(member.workspaceId, false);
      if (ownerWs?.shareContext) await dropAgents(ownerWs.shareContext, member.agentIds);
    });
    if (!left) {
      sendJson(res, 404, { error: 'Shared project membership not found.' });
      return true;
    }
    sendJson(res, 200, { left: true, agentsRevoked: left.agentIds.length });
    return true;
  }

  if (!workspace.id) {
    sendJson(res, 400, { error: 'Sharing needs Loop Cloud. Sign in at useloop.sh to share a profile.' });
    return true;
  }

  if (pathname === '/api/shares' && method === 'POST') {
    const body = await readJsonBody(req);
    const profile = normalizeProfileTag(body?.profile);
    if (!profile || profile === 'all') {
      sendJson(res, 400, { error: 'Make a profile first. Default is never shared.' });
      return true;
    }
    if (!(await ctx.store.getProfile(profile))) {
      sendJson(res, 404, { error: 'Profile not found.' });
      return true;
    }
    const link = await shares.linkFor({ workspaceId: workspace.id, profile, kind: body?.kind, ownerName: body?.ownerName });
    sendJson(res, 200, { code: link.code, kind: link.kind, url: `${origin}/j/${link.code}` });
    return true;
  }

  const profMatch = pathname.match(/^\/api\/shares\/profiles\/([^/]+)\/members$/);
  if (profMatch && method === 'GET') {
    const profile = normalizeProfileTag(decodeURIComponent(profMatch[1]));
    const members = await shares.membersOf(workspace.id, profile);
    const agents = await ctx.store.listAgents();
    sendJson(res, 200, {
      members: members.map((m) => ({
        id: m.id,
        name: m.name,
        email: m.email,
        joinedAt: m.joinedAt,
        agents: m.agentIds.map((id) => agents.find((a) => a.id === id)?.name).filter(Boolean),
      })),
    });
    return true;
  }

  const memberMatch = pathname.match(/^\/api\/shares\/members\/([0-9a-f]{16})$/);
  if (memberMatch && method === 'DELETE') {
    const removed = await shares.removeMember(workspace.id, memberMatch[1], (ids) => dropAgents(ctx, ids));
    if (!removed) {
      sendJson(res, 404, { error: 'Member not found.' });
      return true;
    }
    sendJson(res, 200, { removed: true, agentsRevoked: removed.agentIds.length });
    return true;
  }

  const revokeMatch = pathname.match(/^\/api\/shares\/([A-Za-z0-9]+)$/);
  if (revokeMatch && method === 'DELETE') {
    const ok = await shares.revokeLink(workspace.id, revokeMatch[1]);
    sendJson(res, ok ? 200 : 404, ok ? { revoked: true } : { error: 'Link not found.' });
    return true;
  }

  sendJson(res, 404, { error: 'Not found.' });
  return true;
}

export function shareCodeFromPath(pathname) {
  const m = /^\/j\/([A-Za-z0-9]+)\/?$/.exec(pathname);
  return m && isShareCode(m[1]) ? m[1] : null;
}
