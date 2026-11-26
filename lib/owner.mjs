// Owner sign-in for the Loop dashboard: one password (scrypt-hashed in owner.json)
// and persistent hashed sessions (sessions.json, 0600) carried in an HttpOnly, SameSite=Strict cookie.

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  atomicWriteFile,
  atomicWriteFileSync,
  backupPathFor,
  createWriteQueue,
  readJsonWithBackup,
} from './json-file-store.mjs';
import { defaultDataDir } from './vault.mjs';

const scrypt = promisify(scryptCb);
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 32;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CONCURRENT_SCRYPT = 2;
export const MIN_PASSWORD = 8;

// Process-wide semaphore so concurrent password operations across tenants cannot
// saturate the shared libuv threadpool.
let activeScrypt = 0;
const scryptWaiters = [];

function acquireScryptSlot() {
  if (activeScrypt < MAX_CONCURRENT_SCRYPT) {
    activeScrypt += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => scryptWaiters.push(resolve));
}

function releaseScryptSlot() {
  const next = scryptWaiters.shift();
  if (next) {
    next();
  } else {
    activeScrypt -= 1;
  }
}

async function runScrypt(password, salt) {
  await acquireScryptSlot();
  try {
    return await scrypt(String(password), salt, KEY_LEN, SCRYPT);
  } finally {
    releaseScryptSlot();
  }
}

function sha(token) {
  return createHash('sha256').update(token).digest('hex');
}

function pathExistsSync(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (err) {
    return err?.code !== 'ENOENT';
  }
}

function isValidOwnerRecord(parsed) {
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof parsed.salt !== 'string' ||
    !parsed.salt.trim() ||
    typeof parsed.hash !== 'string' ||
    !parsed.hash.trim()
  ) {
    return false;
  }
  return Buffer.from(parsed.salt, 'base64').length > 0 && Buffer.from(parsed.hash, 'base64').length > 0;
}

export class OwnerAuth {
  constructor(dir = defaultDataDir(), port = 0) {
    this.dir = dir;
    this.file = path.join(dir, 'owner.json');
    this.sessionsFile = path.join(dir, 'sessions.json');
    this.cookieName = `loop_session_${port}`;
    this.sessions = new Map(); // sha(token) -> expiresAt
    this.failures = 0;
    this.lockedUntil = 0;
    this._record = undefined;
    // Single per-instance mutex serializing setup, setVaultPassword, changePassword, login, and verify.
    this._authQueue = createWriteQueue();
    this._loadSessions();
  }

  _withAuthLock(fn) {
    return this._authQueue(fn);
  }

  hasPasswordSync() {
    return pathExistsSync(this.file) || pathExistsSync(backupPathFor(this.file));
  }

  _loadSessions() {
    try {
      const raw = JSON.parse(readFileSync(this.sessionsFile, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const now = Date.now();
      for (const [k, exp] of Object.entries(raw)) {
        if (typeof exp === 'number' && Number.isFinite(exp) && exp > now) this.sessions.set(k, exp);
      }
    } catch {
      // no sessions file yet
    }
  }

  _saveSessions() {
    try {
      const now = Date.now();
      const out = {};
      for (const [k, exp] of this.sessions) {
        if (exp > now) out[k] = exp;
        else this.sessions.delete(k);
      }
      atomicWriteFileSync(this.sessionsFile, JSON.stringify(out) + '\n', {
        mode: 0o600,
        backup: false,
        fsync: true,
      });
    } catch {
      // best effort
    }
  }

  setPort(port) {
    this.cookieName = `loop_session_${port}`;
  }

  async _load() {
    if (this._record) return this._record;
    let res;
    try {
      res = await readJsonWithBackup(this.file, {
        validate: isValidOwnerRecord,
        fallbackToBackup: true,
      });
    } catch (err) {
      throw Object.assign(
        new Error(
          'Owner password file is corrupted or unreadable. Restore owner.json from backup or remove it to reset the password.',
        ),
        { status: 500, code: 'OWNER_FILE_CORRUPT', cause: err },
      );
    }
    if (res.missing) {
      this._record = null;
      return null;
    }
    if (res.recoveredFromBackup) {
      console.warn(`Recovered owner password record from backup (${backupPathFor(this.file)}).`);
      try {
        await atomicWriteFile(this.file, JSON.stringify(res.data, null, 2) + '\n', {
          mode: 0o600,
          backup: false,
          fsync: true,
        });
      } catch {
        // Best-effort primary repair; still serve recovered record.
      }
    }
    this._record = res.data;
    return this._record;
  }

  async isSetUp() {
    return Boolean(await this._load());
  }

  async _hash(password, salt) {
    return runScrypt(password, salt);
  }

  async _write(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
      throw Object.assign(new Error(`Use a password with at least ${MIN_PASSWORD} characters.`), { status: 400 });
    }
    const salt = randomBytes(16);
    const hash = await this._hash(password, salt);
    const record = {
      version: 1,
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
      updatedAt: new Date().toISOString(),
    };
    await atomicWriteFile(this.file, JSON.stringify(record, null, 2) + '\n', {
      mode: 0o600,
      backup: true,
      fsync: true,
    });
    this._record = record;
  }

  async setup(password) {
    return this._withAuthLock(async () => {
      if (await this._load()) {
        throw Object.assign(new Error('Loop already has a password.'), { status: 409 });
      }
      await this._write(password);
      return this.createSession();
    });
  }

  lockedFor() {
    return Math.max(0, this.lockedUntil - Date.now());
  }

  // Serializes verification and credential writes per OwnerAuth instance so concurrent
  // bursts cannot bypass the failure lockout or race setup/password changes.
  verify(password) {
    return this._withAuthLock(() => this._verifyOnce(password));
  }

  async _verifyOnce(password) {
    const wait = this.lockedFor();
    if (wait > 0) {
      throw Object.assign(new Error(`Too many tries. Wait ${Math.ceil(wait / 1000)} seconds.`), { status: 429 });
    }
    const record = await this._load();
    if (!record) return false;
    const expected = Buffer.from(record.hash, 'base64');
    const actual = await this._hash(password ?? '', Buffer.from(record.salt, 'base64'));
    const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
    if (ok) {
      this.failures = 0;
    } else {
      this.failures += 1;
      if (this.failures >= 5) this.lockedUntil = Date.now() + Math.min(60000, 1000 * 2 ** (this.failures - 5));
    }
    return ok;
  }

  async login(password) {
    return this._withAuthLock(async () => {
      if (!(await this._verifyOnce(password))) {
        throw Object.assign(new Error('Wrong password.'), { status: 401 });
      }
      return this.createSession();
    });
  }

  // In app mode this protects Vault reveal only; it never creates a login session.
  async setVaultPassword(current, next) {
    return this._withAuthLock(async () => {
      const existing = await this._load();
      if (existing && !(await this._verifyOnce(current ?? ''))) {
        throw Object.assign(new Error('Current Vault password is wrong.'), { status: 401 });
      }
      await this._write(next);
    });
  }

  async changePassword(current, next) {
    return this._withAuthLock(async () => {
      if (!(await this._verifyOnce(current))) {
        throw Object.assign(new Error('Current password is wrong.'), { status: 401 });
      }
      await this._write(next);
      this.sessions.clear();
      return this.createSession();
    });
  }

  createSession() {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(sha(token), Date.now() + SESSION_MS);
    this._saveSessions();
    return token;
  }

  tokenFrom(req) {
    const header = String(req.headers.cookie || '');
    for (const part of header.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === this.cookieName) return rest.join('=');
    }
    return null;
  }

  isSignedIn(req) {
    const token = this.tokenFrom(req);
    if (!token) return false;
    const key = sha(token);
    const expires = this.sessions.get(key);
    if (!expires) return false;
    if (expires < Date.now()) {
      this.sessions.delete(key);
      this._saveSessions();
      return false;
    }
    return true;
  }

  logout(req) {
    const token = this.tokenFrom(req);
    if (token) {
      this.sessions.delete(sha(token));
      this._saveSessions();
    }
  }

  cookie(token) {
    return `${this.cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;
  }

  clearCookie() {
    return `${this.cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }
}
