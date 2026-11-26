// Personal invite links and quota tracking for Loop.
// Persists atomically to <dataDir>/invites.json with zero external dependencies.

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, createWriteQueue } from './json-file-store.mjs';

export const RESERVED_INVITE_SLUGS = Object.freeze(
  new Set([
    'admin',
    'api',
    'invite',
    'login',
    'signup',
    'settings',
    'text',
    'mcp',
    'oauth',
    'billing',
    'health',
  ]),
);

const SLUG_RE = /^[a-z0-9_-]{3,32}$/;
const ALNUM_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const GENERIC_INVITER_NAMES = new Set(['a friend', 'loop user', 'someone']);

export function parseInviteQuota(raw, fallback = 5) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : fallback;
  }
  const str = String(raw).trim();
  if (!/^\d+$/.test(str)) return fallback;
  const n = Number(str);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export const DEFAULT_INVITE_QUOTA = parseInviteQuota(process.env.LOOP_INVITE_QUOTA, 5);

export class InviteError extends Error {
  constructor(message, status = 400, code = 'INVITE_ERROR') {
    super(message);
    this.name = 'InviteError';
    this.status = status;
    this.code = code;
    this.publicMessage = message;
  }
}

export function cleanInviterName(raw, max = 60) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function sanitizeInviteSlug(raw) {
  if (typeof raw !== 'string') return '';
  const slug = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32)
    .replace(/[-_]+$/g, '');
  if (!SLUG_RE.test(slug) || !/[a-z0-9]/.test(slug)) return '';
  if (RESERVED_INVITE_SLUGS.has(slug)) return '';
  return slug;
}

function normalizeLookupSlug(raw) {
  if (typeof raw !== 'string') return '';
  const slug = raw.trim().toLowerCase();
  if (!SLUG_RE.test(slug) || RESERVED_INVITE_SLUGS.has(slug)) return '';
  return slug;
}

function generateRandomSlug(length = 8) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALNUM_CHARS[bytes[i] % ALNUM_CHARS.length];
  }
  return out;
}

export function formatInviteShare(rec, origin) {
  const inviteUrl = `${origin}/invite?t=${encodeURIComponent(rec.slug)}`;
  const shareMessage = `I've really enjoyed working with Loop and have an invite for you: ${inviteUrl}`;
  return {
    ...rec,
    inviteUrl,
    shareMessage,
  };
}

function emptyData() {
  return {
    version: 1,
    byWorkspace: {},
    claims: {},
  };
}

function summarizeRecord(rec) {
  const claimedBy = Array.isArray(rec.claimedBy) ? rec.claimedBy : [];
  const quota = parseInviteQuota(rec.quota, DEFAULT_INVITE_QUOTA);
  const used = claimedBy.length;
  const remaining = Math.max(0, quota - used);
  return {
    slug: rec.slug,
    inviterName: rec.inviterName,
    quota,
    used,
    remaining,
    createdAt: rec.createdAt,
  };
}

export class InviteStore {
  constructor(dir, { quota, env } = {}) {
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, 'invites.json');
    if (quota !== undefined) {
      this.quota = parseInviteQuota(quota, DEFAULT_INVITE_QUOTA);
    } else if (env !== undefined) {
      this.quota = parseInviteQuota(env?.LOOP_INVITE_QUOTA, DEFAULT_INVITE_QUOTA);
    } else {
      this.quota = DEFAULT_INVITE_QUOTA;
    }
    this._data = null;
    this._bySlug = new Map();
    this._loadPromise = null;
    this._withLock = createWriteQueue();
  }

  _rebuildIndex(data) {
    this._bySlug = new Map();
    for (const [workspaceId, rec] of Object.entries(data.byWorkspace)) {
      if (rec && typeof rec.slug === 'string' && rec.slug) {
        this._bySlug.set(rec.slug.toLowerCase(), workspaceId);
      }
    }
  }

  async _load() {
    if (this._data) return this._data;
    if (!this._loadPromise) {
      this._loadPromise = (async () => {
        try {
          const parsed = JSON.parse(await readFile(this.file, 'utf8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const byWorkspace =
              parsed.byWorkspace && typeof parsed.byWorkspace === 'object' && !Array.isArray(parsed.byWorkspace)
                ? parsed.byWorkspace
                : {};
            const claims =
              parsed.claims && typeof parsed.claims === 'object' && !Array.isArray(parsed.claims)
                ? parsed.claims
                : {};
            this._data = { version: 1, byWorkspace, claims };
          } else {
            this._data = emptyData();
          }
        } catch (err) {
          if (err?.code !== 'ENOENT') {
            console.warn(`[invites] Could not read ${this.file}: ${err.message}`);
          }
          this._data = emptyData();
        }
        this._rebuildIndex(this._data);
        return this._data;
      })().finally(() => {
        this._loadPromise = null;
      });
    }
    return this._loadPromise;
  }

  async _save() {
    await atomicWriteFile(this.file, JSON.stringify(this._data, null, 2) + '\n', {
      mode: 0o600,
      backup: true,
    });
  }

  _pickUniqueSlug(preferredSlug, inviterName) {
    const cleanName = cleanInviterName(inviterName);
    const nameFallback = GENERIC_INVITER_NAMES.has(cleanName.toLowerCase()) ? '' : cleanName;
    const base = sanitizeInviteSlug(preferredSlug) || sanitizeInviteSlug(nameFallback);

    if (base) {
      if (!this._bySlug.has(base)) return base;
      for (let n = 2; n < 1000; n += 1) {
        const suffix = String(n);
        const trimmed = base.slice(0, Math.max(1, 32 - suffix.length)).replace(/[-_]+$/g, '');
        const candidate = sanitizeInviteSlug(`${trimmed}${suffix}`);
        if (candidate && !this._bySlug.has(candidate)) return candidate;
      }
    }

    for (let attempts = 0; attempts < 64; attempts += 1) {
      const candidate = generateRandomSlug(8);
      if (!RESERVED_INVITE_SLUGS.has(candidate) && !this._bySlug.has(candidate)) {
        return candidate;
      }
    }
    throw new InviteError('Could not allocate an invite link.', 500, 'SLUG_ALLOCATION_FAILED');
  }

  _ensureRecordUnlocked(data, { workspaceId, inviterName, preferredSlug }) {
    const existing = data.byWorkspace[workspaceId];
    if (existing) {
      return { record: existing, created: false };
    }
    const slug = this._pickUniqueSlug(preferredSlug, inviterName);
    const cleanName = cleanInviterName(inviterName) || 'A friend';
    const record = {
      workspaceId,
      slug,
      inviterName: cleanName,
      quota: this.quota,
      claimedBy: [],
      createdAt: new Date().toISOString(),
    };
    data.byWorkspace[workspaceId] = record;
    this._bySlug.set(slug, workspaceId);
    return { record, created: true };
  }

  async getOrCreateForUser({ workspaceId, inviterName, preferredSlug } = {}) {
    const wsId = typeof workspaceId === 'string' ? workspaceId.trim() : '';
    if (!wsId) {
      throw new InviteError('Workspace id is required.', 400, 'INVALID_WORKSPACE');
    }
    return this._withLock(async () => {
      const data = await this._load();
      const { record, created } = this._ensureRecordUnlocked(data, {
        workspaceId: wsId,
        inviterName,
        preferredSlug,
      });
      if (created) {
        await this._save();
      }
      return summarizeRecord(record);
    });
  }

  async updateForUser({ workspaceId, inviterName, slug, defaultInviterName, defaultPreferredSlug } = {}) {
    const wsId = typeof workspaceId === 'string' ? workspaceId.trim() : '';
    if (!wsId) {
      throw new InviteError('Workspace id is required.', 400, 'INVALID_WORKSPACE');
    }
    return this._withLock(async () => {
      const data = await this._load();

      let nextSlug;
      if (slug !== undefined) {
        nextSlug = sanitizeInviteSlug(slug);
        if (!nextSlug) {
          throw new InviteError(
            'Invite link must be 3-32 characters (letters, numbers, hyphens, or underscores) and cannot be a reserved word.',
            400,
            'INVALID_SLUG',
          );
        }
        const owner = this._bySlug.get(nextSlug);
        if (owner && owner !== wsId) {
          throw new InviteError('That invite link is already taken.', 409, 'SLUG_TAKEN');
        }
      }

      let nextName;
      if (inviterName !== undefined) {
        nextName = cleanInviterName(inviterName);
        if (!nextName) {
          throw new InviteError('Inviter name cannot be empty.', 400, 'INVALID_NAME');
        }
      }

      const { record, created } = this._ensureRecordUnlocked(data, {
        workspaceId: wsId,
        inviterName: nextName || defaultInviterName,
        preferredSlug: nextSlug || defaultPreferredSlug,
      });

      let dirty = created;
      if (nextSlug && record.slug !== nextSlug) {
        this._bySlug.delete(record.slug.toLowerCase());
        record.slug = nextSlug;
        this._bySlug.set(nextSlug, wsId);
        dirty = true;
      }
      if (nextName && record.inviterName !== nextName) {
        record.inviterName = nextName;
        dirty = true;
      }

      if (dirty) {
        await this._save();
      }
      return summarizeRecord(record);
    });
  }

  async lookup(slug) {
    const normalized = normalizeLookupSlug(slug);
    if (!normalized) {
      return { valid: false, error: 'Invite link not found.' };
    }
    const data = await this._load();
    const workspaceId = this._bySlug.get(normalized);
    const rec = workspaceId ? data.byWorkspace[workspaceId] : null;
    if (!rec) {
      return { valid: false, error: 'Invite link not found.' };
    }
    const summary = summarizeRecord(rec);
    return {
      valid: true,
      slug: summary.slug,
      inviterName: summary.inviterName,
      quota: summary.quota,
      used: summary.used,
      remaining: summary.remaining,
      exhausted: summary.remaining <= 0,
    };
  }

  async claim({ slug, claimerWorkspaceId } = {}) {
    const claimerId = typeof claimerWorkspaceId === 'string' ? claimerWorkspaceId.trim() : '';
    if (!claimerId) {
      throw new InviteError('Claimer workspace id is required.', 400, 'INVALID_WORKSPACE');
    }
    const normalized = normalizeLookupSlug(slug);
    if (!normalized) {
      throw new InviteError('Invite link not found.', 404, 'INVITE_NOT_FOUND');
    }
    return this._withLock(async () => {
      const data = await this._load();
      const ownerWorkspaceId = this._bySlug.get(normalized);
      const rec = ownerWorkspaceId ? data.byWorkspace[ownerWorkspaceId] : null;
      if (!rec) {
        throw new InviteError('Invite link not found.', 404, 'INVITE_NOT_FOUND');
      }

      if (!Array.isArray(rec.claimedBy)) {
        rec.claimedBy = [];
      }
      const quota = parseInviteQuota(rec.quota, DEFAULT_INVITE_QUOTA);
      const currentRemaining = Math.max(0, quota - rec.claimedBy.length);

      if (claimerId === rec.workspaceId) {
        return {
          claimed: false,
          isSelf: true,
          inviterName: rec.inviterName,
          remaining: currentRemaining,
          slug: rec.slug,
        };
      }

      if (rec.claimedBy.includes(claimerId)) {
        return {
          claimed: true,
          alreadyClaimed: true,
          inviterName: rec.inviterName,
          remaining: currentRemaining,
          slug: rec.slug,
        };
      }

      if (rec.claimedBy.length >= quota) {
        throw new InviteError('This invite link has no invites left.', 410, 'INVITE_EXHAUSTED');
      }

      rec.claimedBy.push(claimerId);
      data.claims[claimerId] = {
        slug: rec.slug,
        inviterName: rec.inviterName,
        claimedAt: new Date().toISOString(),
      };
      await this._save();

      const nextRemaining = Math.max(0, quota - rec.claimedBy.length);
      return {
        claimed: true,
        alreadyClaimed: false,
        inviterName: rec.inviterName,
        remaining: nextRemaining,
        slug: rec.slug,
      };
    });
  }

  async isInvited(workspaceId) {
    const wsId = typeof workspaceId === 'string' ? workspaceId.trim() : '';
    if (!wsId) return false;
    const data = await this._load();
    return Boolean(data.claims?.[wsId]);
  }
}
