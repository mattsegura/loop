// In-memory run-scoped bearer tokens for built-in Loop Specialist CLI runs.
// Tokens never touch disk, expire automatically, and are revoked when each run ends.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const RUN_TOKEN_PREFIX = 'loop_run_';
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

function digestOf(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function safeTokenEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createRunTokenRegistry({ ttlMs = DEFAULT_TTL_MS } = {}) {
  const byDigest = new Map();
  const byRunId = new Map();

  function revokeByDigest(digest) {
    const entry = byDigest.get(digest);
    if (!entry) return false;
    byDigest.delete(digest);
    if (byRunId.get(entry.runId) === digest) byRunId.delete(entry.runId);
    return true;
  }

  function prune(now = Date.now()) {
    let removed = 0;
    for (const [digest, entry] of byDigest.entries()) {
      if (entry.expiresAt <= now) {
        revokeByDigest(digest);
        removed += 1;
      }
    }
    return removed;
  }

  const cleanupTimer = setInterval(() => prune(), CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();

  return {
    issue({
      runId,
      workspaceId = 'local',
      profile = 'all',
      agentName = 'Loop Specialist',
      runnerKind = 'loop-specialist',
      secrets = [],
      ownerSession = true,
      ttl = ttlMs,
    } = {}) {
      const id = String(runId || randomBytes(12).toString('hex')).trim();
      const existing = byRunId.get(id);
      if (existing) revokeByDigest(existing);

      const token = `${RUN_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
      const digest = digestOf(token);
      const now = Date.now();
      const expiresAt = now + Math.max(5_000, Number(ttl) || DEFAULT_TTL_MS);
      const cleanSecrets = Array.isArray(secrets)
        ? [...new Set(secrets.filter((s) => typeof s === 'string' && s && !s.startsWith('__')))]
        : [];

      const entry = {
        token,
        runId: id,
        workspaceId: String(workspaceId || 'local'),
        profile: String(profile || 'all') || 'all',
        agentName: String(agentName || 'Loop Specialist').slice(0, 80),
        runnerKind: String(runnerKind || 'loop-specialist').slice(0, 40),
        secrets: cleanSecrets,
        ownerSession: ownerSession !== false,
        createdAt: now,
        expiresAt,
      };
      byDigest.set(digest, entry);
      byRunId.set(id, digest);
      return { token, runId: id, expiresAt };
    },

    resolve(token, { workspaceId = null, now = Date.now() } = {}) {
      if (typeof token !== 'string' || !token.startsWith(RUN_TOKEN_PREFIX)) return null;
      const digest = digestOf(token);
      const entry = byDigest.get(digest);
      if (!entry) return null;
      if (entry.expiresAt <= now) {
        revokeByDigest(digest);
        return null;
      }
      if (!safeTokenEqual(entry.token, token)) return null;
      if (workspaceId !== null && String(workspaceId || 'local') !== entry.workspaceId) return null;
      return {
        id: 'loop_specialist',
        name: entry.agentName,
        kind: entry.runnerKind,
        profile: entry.profile,
        mode: 'default',
        canManage: true,
        memoryAccess: 'read_write',
        ownerSession: entry.ownerSession !== false,
        enabled: true,
        secrets: [...entry.secrets],
        ephemeralRunId: entry.runId,
      };
    },

    revoke(token) {
      if (typeof token !== 'string' || !token.startsWith(RUN_TOKEN_PREFIX)) return false;
      return revokeByDigest(digestOf(token));
    },

    revokeByRunId(runId) {
      const digest = byRunId.get(String(runId || '').trim());
      if (!digest) return false;
      return revokeByDigest(digest);
    },

    prune,

    size() {
      prune();
      return byDigest.size;
    },

    close() {
      clearInterval(cleanupTimer);
      byDigest.clear();
      byRunId.clear();
    },
  };
}
