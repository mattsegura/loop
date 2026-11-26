// Select a workspace exclusively from a server-verified Clerk identity. The old
// Mac workspace is never a default for web requests or an unknown user.
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const workspaceId = ({ issuer, userId }) => createHash('sha256').update(JSON.stringify([issuer, userId])).digest('hex');
const idPattern = /^[0-9a-f]{64}$/;
const MAX_CLAIM_BYTES = 64 * 1024;

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_MAX_USERS = 128;

export class AppWorkspaces {
  constructor(base, create, { idleMs, maxUsers } = {}) {
    // A signed-in user's workspace is dropped from memory once unused for this long. Its data is
    // on disk and it loads again on that user's next request. The Mac workspace always stays.
    this.idleMs = Number.isFinite(Number(idleMs)) && Number(idleMs) >= 0 ? Number(idleMs) : DEFAULT_IDLE_MS;
    this.maxUsers = Number.isFinite(Number(maxUsers)) && Number(maxUsers) > 0 ? Number(maxUsers) : DEFAULT_MAX_USERS;
    this.lastIdleCheck = Date.now();
    this.closing = new Set();
    this.closingById = new Map();
    this.base = path.resolve(base);
    this.usersDir = path.join(this.base, 'user-workspaces');
    this.claimFile = path.join(this.base, 'local-clerk-owner.json');
    this.create = create;
    this.users = new Map();
    this.local = create(this.base, null);
    this.claimed = null;
    this.claimCorrupt = false;
    this._warnedCorruptClaim = false;
    this._refreshClaim();
  }

  _warnCorruptClaim(detail) {
    if (this._warnedCorruptClaim) return;
    this._warnedCorruptClaim = true;
    console.warn(`Ignoring malformed local workspace claim (${this.claimFile}): ${detail}`);
  }

  _readClaimFromDisk() {
    try {
      const stat = lstatSync(this.claimFile);
      if (!stat.isFile()) {
        this._warnCorruptClaim('path is not a regular file');
        return 'corrupt';
      }
      if (stat.size === 0) {
        this._warnCorruptClaim('empty claim file');
        return 'corrupt';
      }
      if (stat.size > MAX_CLAIM_BYTES) {
        this._warnCorruptClaim('oversized claim file');
        return 'corrupt';
      }
      const record = JSON.parse(readFileSync(this.claimFile, 'utf8'));
      if (
        record &&
        typeof record === 'object' &&
        !Array.isArray(record) &&
        typeof record.workspace === 'string' &&
        idPattern.test(record.workspace)
      ) {
        return record.workspace;
      }
      this._warnCorruptClaim('invalid workspace assignment');
      return 'corrupt';
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      this._warnCorruptClaim(err?.message || String(err));
      return 'corrupt';
    }
  }

  // Always refresh when unclaimed so two processes sharing a data directory stay consistent.
  _refreshClaim() {
    if (this.claimed !== null) return this.claimed;
    const disk = this._readClaimFromDisk();
    if (disk === 'corrupt') {
      this.claimCorrupt = true;
      this.claimed = null;
      return null;
    }
    this.claimCorrupt = false;
    this._warnedCorruptClaim = false;
    this.claimed = disk;
    return this.claimed;
  }

  // Write the complete claim payload to a unique temp file and fsync it first, then link it
  // into place exclusively (EEXIST on race). ENOSPC/crash mid-write can never leave a 0-byte claim file.
  _writeClaimExclusive(id) {
    mkdirSync(this.base, { recursive: true, mode: 0o700 });
    const tmp = `${this.claimFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const payload = JSON.stringify({ version: 1, workspace: id }) + '\n';
    let fd = null;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, payload, 'utf8');
      try {
        fsyncSync(fd);
      } catch {
        // Some virtual/network filesystems reject fsync; proceed safely.
      }
      closeSync(fd);
      fd = null;
      chmodSync(tmp, 0o600);
      linkSync(tmp, this.claimFile);
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
      try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    }
    this.claimed = id;
    this.claimCorrupt = false;
    this._warnedCorruptClaim = false;
  }

  // Checked as requests arrive (at most once a minute), so it needs no timer. By the time a
  // workspace has been idle this long its saves have all landed, so closing it writes nothing and
  // cannot clash with a copy loaded again for a new request.
  _evictWorkspace(id, workspace) {
    this.users.delete(id);
    const closing = Promise.resolve()
      .then(() => workspace.close())
      .catch(() => {})
      .finally(() => {
        this.closing.delete(closing);
        if (this.closingById.get(id) === closing) this.closingById.delete(id);
      });
    this.closing.add(closing);
    this.closingById.set(id, closing);
  }

  _dropIdle(keepId = null) {
    const now = Date.now();
    const forceLru = this.users.size > this.maxUsers;
    if (!forceLru && now - this.lastIdleCheck < Math.min(60 * 1000, this.idleMs)) return;
    this.lastIdleCheck = now;
    for (const [id, workspace] of [...this.users.entries()]) {
      if (id === keepId || typeof workspace.isIdle !== 'function' || !workspace.isIdle(this.idleMs, now)) continue;
      this._evictWorkspace(id, workspace);
    }
    if (this.users.size > this.maxUsers) {
      for (const [id, workspace] of [...this.users.entries()]) {
        if (this.users.size <= this.maxUsers) break;
        if (id === keepId) continue;
        if (typeof workspace.isIdle === 'function' && !workspace.isIdle(0, now)) continue;
        this._evictWorkspace(id, workspace);
      }
    }
  }

  personal(id, create = true) {
    if (!idPattern.test(id)) return null;
    if (this.users.has(id)) {
      const existing = this.users.get(id);
      // Refresh LRU recency order
      this.users.delete(id);
      this.users.set(id, existing);
      this._dropIdle(id);
      return existing;
    }
    const directory = path.join(this.usersDir, id);
    for (const dir of [this.usersDir, directory]) {
      if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { if (!lstatSync(dir).isDirectory()) throw Error('Invalid workspace directory.'); }
      catch (err) { if (!create && err.code === 'ENOENT') return null; throw err; }
    }
    const instance = this.create(directory, id);
    this.users.set(id, instance);
    this._dropIdle(id);
    return instance;
  }

  forUser(identity, fromDevice) {
    const id = workspaceId(identity);
    this._refreshClaim();
    if (fromDevice && this.claimed === id) {
      this._dropIdle();
      return this.local;
    }
    if (fromDevice && this.claimed === null && !this.claimCorrupt) {
      // Pre-existing password-protected Mac workspaces must be explicitly claimed with the
      // original Loop password via POST /api/auth/claim-local; only brand-new installs auto-claim.
      let hasPriorPassword = false;
      try {
        hasPriorPassword = typeof this.local?.owner?.hasPasswordSync === 'function'
          ? Boolean(this.local.owner.hasPasswordSync())
          : false;
      } catch {
        // Fail closed: never auto-claim root if password presence cannot be checked safely.
        hasPriorPassword = true;
      }
      if (!hasPriorPassword) {
        try {
          this._writeClaimExclusive(id);
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          this._refreshClaim();
        }
        if (this.claimed === id) {
          this._dropIdle();
          return this.local;
        }
      }
    }
    return this.personal(id);
  }

  async claim(identity, password) {
    const id = workspaceId(identity);
    this._refreshClaim();
    if (this.claimed) throw Object.assign(Error('This Mac workspace has already been restored.'), { status: 409 });
    if (this.claimCorrupt) {
      throw Object.assign(Error('Local workspace ownership file is unreadable. Repair or remove local-clerk-owner.json first.'), { status: 409 });
    }
    if (!await this.local.owner.isSetUp() || !await this.local.owner.verify(password)) {
      throw Object.assign(Error('The original Loop password is required.'), { status: 403 });
    }
    // Atomic exclusive link protects against two simultaneous first claims, restarts, and ENOSPC.
    try {
      this._writeClaimExclusive(id);
    } catch (e) {
      if (e.code === 'EEXIST') {
        this._refreshClaim();
        throw Object.assign(Error('This workspace is already restored.'), { status: 409 });
      }
      throw e;
    }
  }

  async close() {
    await Promise.all([...[this.local, ...this.users.values()].map(w => w.close()), ...this.closing]);
  }
}
