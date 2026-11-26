// Local encrypted secret vault backed by AES-256-GCM with an owner-only key file.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { currentRevision, updatedRevisions, validateRevision } from './sync-revisions.mjs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile, readJsonWithBackup } from './json-file-store.mjs';
import {
  MAX_PROFILES,
  PROFILE_CONTROL_RE,
  itemMatchesProfile,
  normalizeItemProfiles,
  normalizeProfileTag,
  stripProfileFromItemProfiles,
} from './profiles.mjs';
import { PLACEHOLDER_RE, VAULT_KEY_PATTERN, isInternalVaultKey } from './secret-refs.mjs';
import { normalizeAllowedSinkEntry, normalizeAllowedSinks, sinkKey } from './sink.mjs';

const execFileAsync = promisify(execFile);
const AES_ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VAULT_AAD_PREFIX = 'loop:vault:v2:';

async function defaultOsKeychainGet(account) {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password', '-s', 'sh.useloop.vault', '-a', account, '-w',
      ], { timeout: 5000 });
      const b64 = String(stdout || '').trim();
      return b64 ? Buffer.from(b64, 'base64') : null;
    } catch (err) {
      if (err?.code === 44 || /could not be found/i.test(String(err?.stderr || err?.message || ''))) return null;
      throw Object.assign(new Error('OS keychain is unavailable for Loop Vault.'), { code: 'KEYCHAIN_UNAVAILABLE' });
    }
  }
  if (process.platform === 'linux') {
    try {
      const { stdout } = await execFileAsync('secret-tool', [
        'lookup', 'service', 'sh.useloop.vault', 'account', account,
      ], { timeout: 5000 });
      const b64 = String(stdout || '').trim();
      return b64 ? Buffer.from(b64, 'base64') : null;
    } catch (err) {
      if (err?.code === 1) return null;
      throw Object.assign(new Error('OS keychain (secret-tool) is unavailable for Loop Vault.'), { code: 'KEYCHAIN_UNAVAILABLE' });
    }
  }
  throw Object.assign(new Error(`OS keychain is not supported on platform "${process.platform}".`), { code: 'KEYCHAIN_UNAVAILABLE' });
}

async function defaultOsKeychainSet(account, keyBuf) {
  const b64 = keyBuf.toString('base64');
  if (process.platform === 'darwin') {
    try {
      await execFileAsync('security', [
        'add-generic-password', '-U', '-s', 'sh.useloop.vault', '-a', account, '-w', b64,
      ], { timeout: 5000 });
      return;
    } catch {
      throw Object.assign(new Error('Failed to store Loop Vault key in macOS Keychain.'), { code: 'KEYCHAIN_UNAVAILABLE' });
    }
  }
  throw Object.assign(new Error(`Storing keys in OS keychain is not supported on platform "${process.platform}".`), { code: 'KEYCHAIN_UNAVAILABLE' });
}

export const VAULT_TYPES = Object.freeze(['api_key', 'login', 'payment', 'note']);
export const APPROVAL_MODES = Object.freeze(['inherit', 'auto', 'always_ask', 'guard']);

const VAULT_TYPE_SET = new Set(VAULT_TYPES);
const APPROVAL_MODE_SET = new Set(APPROVAL_MODES);

function normalizeVaultType(raw, fallback = 'api_key') {
  const clean = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return VAULT_TYPE_SET.has(clean) ? clean : fallback;
}

function normalizeApprovalMode(raw, fallback = 'inherit') {
  const clean = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return APPROVAL_MODE_SET.has(clean) ? clean : fallback;
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// A Vault category is a free name for the group an item shows under ("SSH keys", "Crypto").
// Empty means the item's type picks its group. The type still decides the approval rule.
export const VAULT_CATEGORY_MAX = 40;
export function normalizeVaultCategory(raw) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw badRequest('Vault category must be a string.');
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, VAULT_CATEGORY_MAX)
    .trim();
}

function withCategory(entry, category) {
  const next = { ...entry };
  if (category) next.category = category;
  else delete next.category;
  return next;
}

function isAllProfiles(profiles) {
  return Array.isArray(profiles) && profiles.length === 1 && profiles[0] === 'all';
}

function profilesEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function validateVaultProfiles(raw) {
  if (typeof raw === 'string') {
    if (PROFILE_CONTROL_RE.test(raw)) {
      throw badRequest('Vault profiles cannot contain control characters.');
    }
    return normalizeItemProfiles(raw);
  }
  if (!Array.isArray(raw)) {
    throw badRequest('Vault profiles must be a string or an array of strings.');
  }
  if (raw.length > MAX_PROFILES) {
    throw badRequest(`Vault secret can belong to at most ${MAX_PROFILES} profiles.`);
  }
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw badRequest('Each Vault profile must be a string.');
    }
    if (PROFILE_CONTROL_RE.test(item)) {
      throw badRequest('Vault profiles cannot contain control characters.');
    }
  }
  return normalizeItemProfiles(raw);
}

function withProfiles(entry, profiles) {
  const next = { ...entry };
  const normalized = normalizeItemProfiles(profiles);
  if (isAllProfiles(normalized)) {
    delete next.profiles;
  } else {
    next.profiles = normalized;
  }
  return next;
}

function validateVaultPayload(parsed) {
  return Boolean(
    parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      parsed.entries &&
      typeof parsed.entries === 'object' &&
      !Array.isArray(parsed.entries),
  );
}

function entryToMeta(key, entry) {
  return {
    key,
    description: typeof entry.description === 'string' ? entry.description : '',
    type: normalizeVaultType(entry.type, 'api_key'),
    category: typeof entry.category === 'string' ? entry.category : '',
    ...(typeof entry.username === 'string' && entry.username ? { username: entry.username } : {}),
    approval: normalizeApprovalMode(entry.approval, 'inherit'),
    updatedAt: entry.updatedAt || null,
    masked: entry.masked === '' ? '' : '••••',
    allowedSinks: Array.isArray(entry.allowedSinks) ? normalizeAllowedSinks(entry.allowedSinks) : [],
    profiles: normalizeItemProfiles(entry?.profiles),
  };
}

export function defaultDataDir() {
  if (process.env.LOOP_HUB_DATA) return path.resolve(process.env.LOOP_HUB_DATA);
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Loop Hub');
  }
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    'loop-hub',
  );
}

function maskSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  return '••••';
}

// All writers in this server process serialize by backing file, even across workspace reloads.
const pendingWrites = new Map();

export class Vault {
  constructor(dir = defaultDataDir(), { keystore = null, keychainBridge = null } = {}) {
    this.dir = dir;
    this.keyFile = path.join(dir, 'vault.key');
    this.file = path.join(dir, 'vault.json');
    const mode = String(keystore || process.env.LOOP_VAULT_KEYSTORE || 'file').trim().toLowerCase();
    this.keystore = mode === 'keychain' ? 'keychain' : 'file';
    this.keychainBridge = keychainBridge || { get: defaultOsKeychainGet, set: defaultOsKeychainSet };
    this._keychainAccount = `vault-${createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 16)}`;
    this.captureForms = new Map(); // Workspace-local, short-lived metadata only.
    this.writeGeneration = 0;
    this._key = null;
    this._keyPromise = null;
  }

  _withLock(fn) {
    const file = path.resolve(this.file);
    const tail = pendingWrites.get(file) || Promise.resolve();
    const write = tail.then(fn, fn);
    pendingWrites.set(file, write);
    const release = () => { if (pendingWrites.get(file) === write) pendingWrites.delete(file); };
    write.then(release, release);
    return write;
  }

  async _loadOrCreateKey() {
    if (this._key) return this._key;
    if (this._keyPromise) return this._keyPromise;

    this._keyPromise = (async () => {
      if (this.keystore === 'keychain') {
        // Refuse silent keystore switches when a local vault.key file already exists.
        const hasDiskKey = await stat(this.keyFile).then(() => true, () => false);
        if (hasDiskKey) {
          throw Object.assign(
            new Error('vault.key already exists on disk while LOOP_VAULT_KEYSTORE=keychain is set. Migrate explicitly before switching keystores.'),
            { code: 'KEYSTORE_CONFLICT' },
          );
        }
        const fromKc = await this.keychainBridge.get(this._keychainAccount);
        if (fromKc) {
          const buf = Buffer.isBuffer(fromKc) ? fromKc : Buffer.from(String(fromKc), 'base64');
          if (buf.length !== KEY_BYTES) {
            throw new Error(`Invalid OS keychain vault key (expected ${KEY_BYTES} bytes).`);
          }
          this._key = buf;
          return buf;
        }
        const existingEntries = await this._readRaw();
        if (Object.keys(existingEntries).length > 0) {
          throw new Error('OS keychain vault key is missing while vault.json contains encrypted secrets.');
        }
        const key = randomBytes(KEY_BYTES);
        await this.keychainBridge.set(this._keychainAccount, key);
        this._key = key;
        return key;
      }

      try {
        const existing = await readFile(this.keyFile);
        if (existing.length !== KEY_BYTES) {
          throw new Error(`Invalid vault key in ${this.keyFile} (expected ${KEY_BYTES} bytes).`);
        }
        this._key = existing;
        return existing;
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }

      const existingEntries = await this._readRaw();
      if (Object.keys(existingEntries).length > 0) {
        throw new Error(
          'Vault key file (vault.key) is missing while vault.json contains encrypted secrets. Restore vault.key or remove vault.json before saving new secrets.',
        );
      }

      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const key = randomBytes(KEY_BYTES);
      try {
        await writeFile(this.keyFile, key, { mode: 0o600, flag: 'wx' });
        await chmod(this.keyFile, 0o600);
        this._key = key;
        return key;
      } catch (err) {
        if (err?.code === 'EEXIST') {
          const existing = await readFile(this.keyFile);
          if (existing.length !== KEY_BYTES) {
            throw new Error(`Invalid vault key in ${this.keyFile} (expected ${KEY_BYTES} bytes).`);
          }
          this._key = existing;
          return existing;
        }
        throw err;
      }
    })();

    try {
      return await this._keyPromise;
    } finally {
      this._keyPromise = null;
    }
  }

  async _loadKeyOnly() {
    if (this._key) return this._key;
    if (this.keystore === 'keychain') {
      const fromKc = await this.keychainBridge.get(this._keychainAccount);
      if (!fromKc) throw new Error('OS keychain vault key not found.');
      const buf = Buffer.isBuffer(fromKc) ? fromKc : Buffer.from(String(fromKc), 'base64');
      if (buf.length !== KEY_BYTES) {
        throw new Error(`Invalid OS keychain vault key (expected ${KEY_BYTES} bytes).`);
      }
      this._key = buf;
      return buf;
    }
    const existing = await readFile(this.keyFile);
    if (existing.length !== KEY_BYTES) {
      throw new Error(`Invalid vault key in ${this.keyFile} (expected ${KEY_BYTES} bytes).`);
    }
    this._key = existing;
    return existing;
  }

  async _readDocument() {
    const { data: parsed, missing } = await readJsonWithBackup(this.file, {
      validate: validateVaultPayload,
      fallbackToBackup: true,
    });
    const entries = Object.create(null);
    if (missing || !parsed) return { entries, versions: {} };
    for (const [k, v] of Object.entries(parsed.entries)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) entries[k] = v;
    }
    return { entries, versions: parsed.syncVersions || {} };
  }

  async _readRaw() {
    return (await this._readDocument()).entries;
  }

  async _writeRaw(entries, accepted, previous) {
    const prior = previous || await this._readDocument();
    const userEntries = (items) => new Map(Object.entries(items).filter(([key]) => !isInternalVaultKey(key)));
    const syncVersions = updatedRevisions(userEntries(prior.entries), userEntries(entries), prior.versions, accepted);
    const payload = JSON.stringify({ version: 1, entries, syncVersions }, null, 2) + '\n';
    await atomicWriteFile(this.file, payload, { mode: 0o600, backup: true });
    this.writeGeneration++;
    try { this.onWrite?.(); } catch { /* A notification cannot undo the stored change. */ }
  }

  _encrypt(key, plaintext, keyName = '') {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(AES_ALGO, key, iv);
    if (keyName) {
      cipher.setAAD(Buffer.from(`${VAULT_AAD_PREFIX}${keyName}`, 'utf8'));
    }
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64'),
      ...(keyName ? { aadVersion: 2 } : {}),
    };
  }

  _decrypt(key, record, keyName = '') {
    const iv = Buffer.from(record.iv, 'base64');
    const tag = Buffer.from(record.tag, 'base64');
    const data = Buffer.from(record.data, 'base64');
    const decipher = createDecipheriv(AES_ALGO, key, iv);
    if (record.aadVersion === 2) {
      decipher.setAAD(Buffer.from(`${VAULT_AAD_PREFIX}${keyName}`, 'utf8'));
    }
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  async list({ includeInternal = false, profile = 'all' } = {}) {
    const entries = await this._readRaw();
    const items = [];
    for (const [key, entry] of Object.entries(entries)) {
      if (!includeInternal && isInternalVaultKey(key)) continue;
      const meta = entryToMeta(key, entry);
      if (profile && profile !== 'all' && !itemMatchesProfile(meta, profile)) continue;
      items.push(meta);
    }
    items.sort((a, b) => a.key.localeCompare(b.key));
    return items;
  }

  async syncRecords() {
    const { entries, versions } = await this._readDocument();
    const records = [];
    for (const key of new Set([...Object.keys(entries), ...Object.keys(versions)])) {
      if (isInternalVaultKey(key)) continue;
      const entry = entries[key];
      const revision = currentRevision(versions, key, entry);
      if (!entry) records.push({ key, deleted: true, revision });
      else records.push({ ...entryToMeta(key, entry), value: this._decrypt(await this._loadKeyOnly(), entry, key), revision });
    }
    return records;
  }

  async applySyncRecord(record) {
    const { key, revision } = record || {};
    if (typeof key !== 'string' || !VAULT_KEY_PATTERN.test(key) || isInternalVaultKey(key)) {
      throw badRequest('Invalid synced Vault key.');
    }
    validateRevision(revision, record.deleted === true);
    if (record.deleted === true) return this.delete(key, revision);
    return Boolean(await this.set(key, record.value, {
      description: record.description || '', username: record.username || '', category: record.category || '',
      profiles: record.profiles, allowedSinks: record.allowedSinks || [], type: record.type, approval: record.approval,
    }, revision));
  }

  async getMeta(key) {
    if (typeof key !== 'string' || !key) return null;
    const entries = await this._readRaw();
    if (!Object.hasOwn(entries, key)) return null;
    return entryToMeta(key, entries[key]);
  }

  async updateMeta(key, patch = {}) {
    if (typeof key !== 'string' || !key) return null;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw badRequest('Vault metadata patch must be an object.');
    }
    if (
      Object.hasOwn(patch, 'description') &&
      patch.description !== undefined &&
      patch.description !== null &&
      typeof patch.description !== 'string'
    ) {
      throw badRequest('Vault secret description must be a string.');
    }
    if (
      Object.hasOwn(patch, 'allowedSinks') &&
      patch.allowedSinks !== undefined &&
      !Array.isArray(patch.allowedSinks)
    ) {
      throw badRequest('Vault allowedSinks must be an array.');
    }
    const patchCategory = Object.hasOwn(patch, 'category') && patch.category !== undefined
      ? normalizeVaultCategory(patch.category)
      : undefined;
    const patchProfiles = Object.hasOwn(patch, 'profiles') && patch.profiles !== undefined
      ? validateVaultProfiles(patch.profiles)
      : undefined;

    return this._withLock(async () => {
      const entries = await this._readRaw();
      if (!Object.hasOwn(entries, key)) return null;

      const existing = entries[key];
      const currentType = normalizeVaultType(existing.type, 'api_key');
      const currentApproval = normalizeApprovalMode(existing.approval, 'inherit');
      const currentAllowedSinks = Array.isArray(existing.allowedSinks)
        ? normalizeAllowedSinks(existing.allowedSinks)
        : [];
      const description =
        Object.hasOwn(patch, 'description') && patch.description !== undefined
          ? String(patch.description ?? '').trim()
          : typeof existing.description === 'string'
            ? existing.description
            : '';
      const type =
        Object.hasOwn(patch, 'type') && patch.type !== undefined
          ? normalizeVaultType(patch.type, currentType)
          : currentType;
      const approval =
        Object.hasOwn(patch, 'approval') && patch.approval !== undefined
          ? normalizeApprovalMode(patch.approval, currentApproval)
          : currentApproval;
      const allowedSinks =
        Object.hasOwn(patch, 'allowedSinks') && patch.allowedSinks !== undefined
          ? normalizeAllowedSinks(patch.allowedSinks)
          : currentAllowedSinks;
      const updatedAt = new Date().toISOString();

      const category = patchCategory !== undefined
        ? patchCategory
        : typeof existing.category === 'string' ? existing.category : '';
      const profiles = patchProfiles !== undefined
        ? patchProfiles
        : normalizeItemProfiles(existing.profiles);
      const nextEntry = withProfiles(
        withCategory({
          ...existing,
          description,
          type,
          approval,
          updatedAt,
          masked: existing.masked === '' ? '' : '••••',
        }, category),
        profiles,
      );
      if (allowedSinks.length > 0) {
        nextEntry.allowedSinks = allowedSinks;
      } else {
        delete nextEntry.allowedSinks;
      }

      entries[key] = nextEntry;
      await this._writeRaw(entries);
      return entryToMeta(key, entries[key]);
    });
  }

  async addAllowedSink(key, sinkEntry) {
    if (typeof key !== 'string' || !key) return null;
    const rawEntry =
      typeof sinkEntry === 'string'
        ? sinkEntry
        : sinkEntry && typeof sinkEntry === 'object'
          ? sinkKey(sinkEntry)
          : null;
    const normalized = normalizeAllowedSinkEntry(rawEntry);
    if (!normalized) {
      throw badRequest('Invalid allowed sink entry.');
    }

    return this._withLock(async () => {
      const entries = await this._readRaw();
      if (!Object.hasOwn(entries, key)) return null;

      const existing = entries[key];
      const current = Array.isArray(existing.allowedSinks)
        ? normalizeAllowedSinks(existing.allowedSinks)
        : [];
      if (current.includes(normalized)) {
        return entryToMeta(key, existing);
      }

      entries[key] = {
        ...existing,
        allowedSinks: [...current, normalized],
        updatedAt: new Date().toISOString(),
        masked: existing.masked === '' ? '' : '••••',
      };
      await this._writeRaw(entries);
      return entryToMeta(key, entries[key]);
    });
  }

  async get(key) {
    if (typeof key !== 'string' || !key) return null;
    const entries = await this._readRaw();
    if (!Object.hasOwn(entries, key)) return null;
    const encKey = await this._loadKeyOnly();
    return this._decrypt(encKey, entries[key], key);
  }

  async getInternal(key) {
    return this.get(key);
  }

  openCaptureForm(options) {
    for (const [id, form] of this.captureForms) {
      if (form.expires <= Date.now()) this.captureForms.delete(id);
    }
    if (this.captureForms.size >= 256) throw badRequest('Too many open capture forms.');
    const id = randomBytes(24).toString('hex');
    this.captureForms.set(id, { options, expires: Date.now() + 15 * 60_000 });
    return id;
  }

  captureForm(id) {
    const form = this.captureForms.get(id);
    return form && form.expires > Date.now() ? form.options : null;
  }

  async submitCaptureForm(id, value) {
    const form = this.captureForm(id);
    if (!form) throw badRequest('Capture form is expired or unavailable.');
    this.captureForms.delete(id); // Consume synchronously before any await.
    return this.capture(value, form);
  }

  async capture(value, { label, type, profile }) {
    if (!VAULT_TYPES.includes(type) || typeof value !== 'string' || !value.length || value.length > 65536) {
      throw badRequest('Capture requires a non-empty credential of at most 65536 characters.');
    }
    // Never reuse a caller-selected key: stale grants and placeholders can outlive deletion.
    const key = 'capture_' + randomBytes(16).toString('hex');
    const description = label && !label.includes(value) ? label : 'Credential';
    await this._set(key, value, { description, type, profiles: [profile], approval: 'inherit' }, null, true);
    return { saved: true, key, type, grantsAdded: false };
  }

  async set(key, value, descriptionOrOpts, revision = null) {
    return this._set(key, value, descriptionOrOpts, revision, false);
  }

  async _set(key, value, descriptionOrOpts, revision, createOnly) {
    if (typeof key !== 'string' || !VAULT_KEY_PATTERN.test(key)) {
      throw badRequest(
        'Vault key must be 1–100 characters matching letters, numbers, "_", ".", or "-".',
      );
    }

    if (typeof value !== 'string') {
      throw badRequest('Vault secret value must be a string.');
    }

    const isOptsObject =
      descriptionOrOpts !== null &&
      typeof descriptionOrOpts === 'object' &&
      !Array.isArray(descriptionOrOpts);

    if (
      !isOptsObject &&
      descriptionOrOpts !== undefined &&
      descriptionOrOpts !== null &&
      typeof descriptionOrOpts !== 'string'
    ) {
      throw badRequest('Vault secret description must be a string.');
    }

    if (isOptsObject) {
      if (
        descriptionOrOpts.description !== undefined &&
        descriptionOrOpts.description !== null &&
        typeof descriptionOrOpts.description !== 'string'
      ) {
        throw badRequest('Vault secret description must be a string.');
      }
      if (
        descriptionOrOpts.allowedSinks !== undefined &&
        !Array.isArray(descriptionOrOpts.allowedSinks)
      ) {
        throw badRequest('Vault allowedSinks must be an array.');
      }
    }

    const plaintext = value;
    const optsCategory = isOptsObject && descriptionOrOpts.category !== undefined
      ? normalizeVaultCategory(descriptionOrOpts.category)
      : undefined;
    // A login's username is not secret: it is kept beside the encrypted password, in the clear.
    let optsUsername;
    if (isOptsObject && descriptionOrOpts.username !== undefined) {
      const u = descriptionOrOpts.username;
      if (u !== null && (typeof u !== 'string' || u.length > 320 || /[\u0000-\u001f\u007f]/.test(u))) {
        throw badRequest('Vault username must be a short single-line string.');
      }
      optsUsername = u === null ? '' : u.trim();
    }
    const optsProfiles = isOptsObject && descriptionOrOpts.profiles !== undefined
      ? validateVaultProfiles(descriptionOrOpts.profiles)
      : undefined;

    return this._withLock(async () => {
      const prior = await this._readDocument();
      const entries = Object.assign(Object.create(null), prior.entries);
      const existing = entries[key];
      if (createOnly && (Object.hasOwn(entries, key) || Object.hasOwn(prior.versions, key))) {
        throw badRequest('Vault capture key unavailable.');
      }
      if (isOptsObject && descriptionOrOpts.createOnly === true && Object.hasOwn(entries, key)) {
        throw Object.assign(new Error(`Vault item "${key}" already exists.`), {
          status: 409,
          code: 'VAULT_EXISTS',
          existing: entryToMeta(key, existing),
        });
      }
      if (revision && revision <= currentRevision(prior.versions, key, existing)) return null;
      const encKey = await this._loadOrCreateKey();
      const encrypted = this._encrypt(encKey, plaintext, key);
      const updatedAt = new Date().toISOString();
      const masked = maskSecret(plaintext);

      const existingDesc =
        existing && typeof existing.description === 'string' ? existing.description : '';
      const existingType = existing ? normalizeVaultType(existing.type, 'api_key') : 'api_key';
      const existingApproval = existing
        ? normalizeApprovalMode(existing.approval, 'inherit')
        : 'inherit';
      const existingAllowedSinks =
        existing && Array.isArray(existing.allowedSinks)
          ? normalizeAllowedSinks(existing.allowedSinks)
          : [];

      let cleanDesc;
      let type;
      let approval;
      let allowedSinks;

      if (isOptsObject) {
        cleanDesc =
          descriptionOrOpts.description !== undefined
            ? String(descriptionOrOpts.description ?? '').trim()
            : existingDesc;
        type =
          descriptionOrOpts.type !== undefined
            ? normalizeVaultType(descriptionOrOpts.type, existingType)
            : existingType;
        approval =
          descriptionOrOpts.approval !== undefined
            ? normalizeApprovalMode(descriptionOrOpts.approval, existingApproval)
            : existingApproval;
        allowedSinks =
          descriptionOrOpts.allowedSinks !== undefined
            ? normalizeAllowedSinks(descriptionOrOpts.allowedSinks)
            : existingAllowedSinks;
      } else {
        cleanDesc =
          descriptionOrOpts !== undefined ? String(descriptionOrOpts ?? '').trim() : existingDesc;
        type = existingType;
        approval = existingApproval;
        allowedSinks = existingAllowedSinks;
      }

      const existingCategory = existing && typeof existing.category === 'string' ? existing.category : '';
      const profiles = optsProfiles !== undefined
        ? optsProfiles
        : normalizeItemProfiles(existing?.profiles);
      const nextEntry = withProfiles(
        withCategory({
          ...encrypted,
          description: cleanDesc,
          type,
          approval,
          updatedAt,
          masked,
        }, optsCategory !== undefined ? optsCategory : existingCategory),
        profiles,
      );
      if (allowedSinks.length > 0) {
        nextEntry.allowedSinks = allowedSinks;
      }
      const username = type === 'login'
        ? (optsUsername !== undefined ? optsUsername : (typeof existing?.username === 'string' ? existing.username : ''))
        : '';
      if (username) nextEntry.username = username;

      entries[key] = nextEntry;
      await this._writeRaw(entries, revision ? new Map([[key, revision]]) : undefined, prior);
      return entryToMeta(key, entries[key]);
    });
  }

  async stripProfile(profileId) {
    const cleanId = normalizeProfileTag(profileId);
    if (!cleanId || cleanId === 'all') return { updated: 0 };

    return this._withLock(async () => {
      const entries = await this._readRaw();
      let updated = 0;
      const now = new Date().toISOString();
      for (const [key, entry] of Object.entries(entries)) {
        if (isInternalVaultKey(key)) continue;
        if (!Array.isArray(entry.profiles)) continue;
        const current = normalizeItemProfiles(entry.profiles);
        if (isAllProfiles(current)) continue;
        const next = stripProfileFromItemProfiles(current, cleanId);
        if (profilesEqual(current, next)) continue;
        entries[key] = withProfiles(
          {
            ...entry,
            updatedAt: now,
            masked: entry.masked === '' ? '' : '••••',
          },
          next,
        );
        updated += 1;
      }
      if (updated > 0) {
        await this._writeRaw(entries);
      }
      return { updated };
    });
  }

  async delete(key, revision = null, { expectedValue } = {}) {
    if (typeof key !== 'string' || !key) return false;
    return this._withLock(async () => {
      const prior = await this._readDocument();
      if (revision && revision <= currentRevision(prior.versions, key, prior.entries[key])) return false;
      if (!revision && !Object.hasOwn(prior.entries, key)) return false;
      if (expectedValue !== undefined && (!prior.entries[key] ||
          this._decrypt(await this._loadKeyOnly(), prior.entries[key], key) !== expectedValue)) return false;
      const entries = Object.assign(Object.create(null), prior.entries);
      delete entries[key];
      await this._writeRaw(entries, revision ? new Map([[key, revision]]) : undefined, prior);
      return true;
    });
  }

  async resolveString(str) {
    if (typeof str !== 'string' || !str.includes('{{vault:')) return str;
    const matches = [...str.matchAll(new RegExp(PLACEHOLDER_RE.source, 'g'))];
    if (matches.length === 0) return str;

    for (const match of matches) {
      if (isInternalVaultKey(match[1])) {
        throw new Error('Vault secret references cannot access internal Loop credentials.');
      }
    }

    const resolved = new Map();
    for (const match of matches) {
      const key = match[1];
      if (resolved.has(key)) continue;
      const val = await this.get(key);
      if (val === null) {
        throw new Error(`Vault secret "${key}" not found.`);
      }
      resolved.set(key, val);
    }

    return str.replace(new RegExp(PLACEHOLDER_RE.source, 'g'), (_, key) => resolved.get(key));
  }

  async resolveRecord(record) {
    if (!record || typeof record !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(record)) {
      out[k] = typeof v === 'string' ? await this.resolveString(v) : v;
    }
    return out;
  }
}
