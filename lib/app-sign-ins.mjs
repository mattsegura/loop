// Sign-ins that a Connection asks for during a call.
//
// "Ready" says that Loop can reach a server. The account behind it is another fact: a server can be
// signed in to itself and still need a sign-in for the app that one call uses. Such a question comes
// on any call, in one of three forms:
//   - MCP 2025-11-25: the error -32042, or a request "elicitation/create" while the call runs
//   - MCP 2026-07-28: a result with resultType "input_required"
//   - an ordinary result that holds a link, which the agent that made the call reports
// Each sign-in attempt (and each distinct provider account) stays its own record. A record is Ready only when:
//   - for a protocol ask (-32042 / elicitation / input_required): the call that asked, repeated with
//     the same arguments, works and does not ask again, or
//   - for a reported link: the agent names a call to this Connection that worked after the owner opened
//     this specific attempt's link (matching the provider account ID when present).
//
// Rules:
// - A link is for the owner of this Loop. It stays in memory, for a short time, and is never saved.
// - An agent can report only a link that was in a result it received from that tool of that Connection.
// - A server may be told "accept" only after the owner opened the link.
// - Nothing here opens, fetches or follows a link.

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Set only by the ConnectionPool, which removes it from what a server sends.
export const SIGN_IN_META = 'loop/signIn';

const LINK_TTL_MS = 15 * 60_000;
const RESULT_TTL_MS = 30 * 60_000;
const MAX_RECORDS = 200;
const MAX_URL_CHARS = 2048;
const MAX_LINKS = 50; // of one result
const MAX_RESULTS = 20; // of one caller
const MAX_WORKED_PER_TOOL = 12; // recent working calls per tool
const MAX_CALLERS = 200;
const MAX_SCAN_CHARS = 256 * 1024; // of one result
const MAX_HELD = 20;
const MAX_CALL_KEYS = 8; // of one record

const ACCOUNT_ID_KEYS = new Set([
  'connected_account_id',
  'connectedAccountId',
  'account_id',
  'accountId',
  'provider_account_id',
  'providerAccountId',
]);

const ACCOUNT_LABEL_KEYS = new Set([
  'account_label',
  'accountLabel',
  'account_email',
  'accountEmail',
  'email',
  'emailAddress',
]);

const clean = (value, max) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f<>`\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

function cleanAccountId(value) {
  const s = clean(value, 120);
  if (!s || /\s/.test(s) || /^bearer$/i.test(s)) return '';
  return s;
}

const isLoopback = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

export function formatAppSignInLabel(record) {
  const base = clean(record?.app, 60) || clean(record?.message, 80) || clean(record?.host, 80) || 'App';
  const label = clean(record?.accountLabel, 60);
  if (!label) return base;
  if (base.toLowerCase().includes(label.toLowerCase())) return base;
  return `${base} (${label})`;
}

// The address of a sign-in page as Loop may show it, or null.
export function signInAddress(raw, { personal = false, selfIdentity = null } = {}) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL_CHARS) return null;
  let url;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.href.length > MAX_URL_CHARS || url.username || url.password) return null;
  const secure = url.protocol === 'https:' || (!personal && url.protocol === 'http:' && isLoopback(url.hostname));
  if (!secure) return null;
  // A page of Loop itself is never the sign-in page of a Connection.
  if (selfIdentity?.isSelfUrl?.(url)) return null;
  return url.href;
}

// Links of one kind of sign-in differ in their code only.
function linkKeyOf(href) {
  const url = new URL(href);
  return `${url.origin}/${url.pathname.split('/')[1] || ''}`;
}

function urlHashOf(href) {
  const norm = normalized(href);
  return norm ? createHash('sha256').update(norm).digest('hex') : '';
}

function textsOf(result) {
  const out = [];
  let left = MAX_SCAN_CHARS;
  const add = (text) => {
    if (left <= 0 || typeof text !== 'string') return;
    out.push(text.slice(0, left));
    left -= text.length;
  };
  for (const part of Array.isArray(result?.content) ? result.content : []) {
    add(part?.text);
    add(part?.uri);
    add(part?.resource?.text);
  }
  const walk = (value, depth) => {
    if (depth > 12 || left <= 0) return;
    if (typeof value === 'string') add(value);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item, depth + 1);
  };
  walk(result?.structuredContent, 0);
  return out;
}

const normalized = (raw) => { try { return new URL(raw).href; } catch { return null; } };

function urlsInString(raw) {
  const out = [];
  if (typeof raw !== 'string' || !raw) return out;
  const text = raw.replaceAll('\\/', '/').replace(/\\u0026/gi, '&').replace(/\\u003d/gi, '=');
  for (const [found] of text.matchAll(/https?:\/\/[^\s"'<>`\\^{}|]+/g)) {
    if (out.length >= MAX_LINKS) break;
    if (found.length > MAX_URL_CHARS) continue;
    for (const form of [found, found.replace(/[.,;:!?)\]*_]+$/, '')]) {
      const href = normalized(form);
      if (href && !out.includes(href)) out.push(href);
    }
  }
  return out;
}

export function linksIn(result) {
  const links = new Set();
  for (const raw of textsOf(result)) {
    for (const href of urlsInString(raw)) {
      if (links.size >= MAX_LINKS) return links;
      links.add(href);
    }
  }
  return links;
}

function accountIdFromUrl(href) {
  try {
    const parsed = new URL(href);
    for (const param of ['connected_account_id', 'connectedAccountId', 'account_id', 'accountId', 'provider_account_id']) {
      const value = cleanAccountId(parsed.searchParams.get(param));
      if (value) return value;
    }
  } catch {
    // ignore malformed URL
  }
  return '';
}

function localObjectMeta(obj) {
  let accountId = '';
  let accountLabel = '';
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { accountId, accountLabel };
  for (const [k, v] of Object.entries(obj)) {
    if (!accountId && ACCOUNT_ID_KEYS.has(k) && typeof v === 'string') {
      accountId = cleanAccountId(v);
    }
    if (!accountLabel && ACCOUNT_LABEL_KEYS.has(k) && typeof v === 'string') {
      accountLabel = clean(v, 60);
    }
  }
  if (!accountId) {
    for (const nestedKey of ['account', 'connectedAccount', 'connected_account']) {
      const nested = obj[nestedKey];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        if (typeof nested.id === 'string') accountId = cleanAccountId(nested.id);
        if (!accountLabel && typeof nested.label === 'string') accountLabel = clean(nested.label, 60);
        if (!accountLabel && typeof nested.email === 'string') accountLabel = clean(nested.email, 60);
      }
    }
  }
  return { accountId, accountLabel };
}

function parseJsonObjectSafe(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < 2 || trimmed.length > MAX_SCAN_CHARS) return null;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

// Extracts per-link provider account metadata (connected_account_id / account_id / account_label)
// from structuredContent, JSON text blocks, and URL query parameters.
export function linkMetadataIn(result) {
  const metaByUrl = new Map();
  const note = (href, meta) => {
    const prev = metaByUrl.get(href) || { accountId: '', accountLabel: '' };
    const next = {
      accountId: prev.accountId || meta.accountId || accountIdFromUrl(href),
      accountLabel: prev.accountLabel || meta.accountLabel || '',
    };
    if (next.accountId || next.accountLabel) metaByUrl.set(href, next);
  };

  const walk = (value, inherited, depth) => {
    if (depth > 12 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      const parsed = parseJsonObjectSafe(value);
      if (parsed) {
        walk(parsed, inherited, depth + 1);
        return;
      }
      for (const href of urlsInString(value)) note(href, inherited);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, inherited, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      const own = localObjectMeta(value);
      const next = {
        accountId: own.accountId || inherited.accountId,
        accountLabel: own.accountLabel || inherited.accountLabel,
      };
      for (const item of Object.values(value)) walk(item, next, depth + 1);
    }
  };

  if (result?.structuredContent !== undefined) {
    walk(result.structuredContent, { accountId: '', accountLabel: '' }, 0);
  }
  for (const part of Array.isArray(result?.content) ? result.content : []) {
    if (typeof part?.text === 'string') walk(part.text, { accountId: '', accountLabel: '' }, 0);
    if (typeof part?.resource?.text === 'string') walk(part.resource.text, { accountId: '', accountLabel: '' }, 0);
    if (typeof part?.uri === 'string') {
      const href = normalized(part.uri);
      if (href) note(href, { accountId: '', accountLabel: '' });
    }
  }
  for (const href of linksIn(result)) {
    const id = accountIdFromUrl(href);
    if (id) note(href, { accountId: id, accountLabel: '' });
  }
  return metaByUrl;
}

export function accountIdsIn(value) {
  const ids = new Set();
  const walk = (cur, depth) => {
    if (depth > 12 || cur === null || cur === undefined || ids.size >= 20) return;
    if (typeof cur === 'string') {
      const parsed = parseJsonObjectSafe(cur);
      if (parsed) walk(parsed, depth + 1);
      return;
    }
    if (Array.isArray(cur)) {
      for (const item of cur) walk(item, depth + 1);
      return;
    }
    if (typeof cur === 'object') {
      const own = localObjectMeta(cur);
      if (own.accountId) ids.add(own.accountId);
      for (const item of Object.values(cur)) walk(item, depth + 1);
    }
  };
  walk(value, 0);
  return ids;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function callKeyOf(connId, toolName, args) {
  return createHash('sha256').update(JSON.stringify([connId, toolName, canonical(args ?? {})])).digest('hex');
}

export class AppSignIns {
  constructor({ dir = null, mark = () => '', address = signInAddress, now = () => Date.now(), onChange = null } = {}) {
    this.file = typeof dir === 'string' && dir ? path.join(dir, 'app-sign-ins.json') : null;
    this.mark = mark; // changes with the settings or the sign-in of a Connection
    this.address = address; // checks an address with the rules of this Loop
    this.now = now;
    this.onChange = onChange;
    this._records = null;
    this._live = new Map(); // record id -> { url, expiresAt, accept, openedAt }
    this._results = new Map(); // caller -> results with links, the oldest first
    this._worked = new Map(); // caller + Connection -> toolName -> recent successful calls
    this._held = new Map(); // caller + call -> a call that waits for the owner
    this._resume = new Map(); // caller + call -> what the retry must carry (MCP 2026-07-28)
  }

  _load() {
    if (this._records) return this._records;
    this._records = [];
    if (this.file) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'));
        if (Array.isArray(raw?.records)) {
          this._records = raw.records
            .filter((r) => r && typeof r.id === 'string' && Array.isArray(r.callKeys))
            .map((r) => ({
              accountLabel: '',
              accountId: '',
              ...r,
            }));
        }
      } catch {
        // No file yet, or one that cannot be read: the next call asks again.
      }
    }
    return this._records;
  }

  _changed() {
    if (this.file) {
      try {
        mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        writeFileSync(tmp, `${JSON.stringify({ records: this._records }, null, 2)}\n`, { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, this.file);
      } catch {
        // The records are still right in memory.
      }
    }
    try { this.onChange?.(); } catch { /* a listener never breaks a call */ }
  }

  _of(conn) {
    const mark = this.mark(conn);
    return this._load().filter((r) => r.connId === conn.id && r.mark === mark);
  }

  _liveOf(id) {
    const live = this._live.get(id);
    if (live && live.expiresAt <= this.now()) {
      this._live.delete(id);
      return null;
    }
    return live || null;
  }

  // A sign-in that a Connection asks for. `url` must come from address().
  // Distinct sign-in attempts and distinct provider accounts stay separate rows.
  open(conn, {
    url,
    app = '',
    accountLabel = '',
    accountId = '',
    signInId = '',
    message = '',
    callKey,
    askedBy = '',
    accept = null,
    reported = false,
  }) {
    const name = clean(app, 60);
    const label = clean(accountLabel, 60);
    const providerAccountId = cleanAccountId(accountId || accountIdFromUrl(url));
    const requestedId = clean(signInId, 32);
    const says = clean(message, 200);
    const hash = urlHashOf(url);
    const own = this._of(conn);

    const appMatches = (r) => !name || !r.app || r.app.toLowerCase() === name.toLowerCase();
    const idCompatible = (r) => !providerAccountId || !r.accountId || r.accountId === providerAccountId;
    const labelCompatible = (r) => !label || !r.accountLabel || r.accountLabel.toLowerCase() === label.toLowerCase();

    let record = null;
    if (requestedId) {
      record = own.find((r) => r.id === requestedId && appMatches(r) && idCompatible(r) && labelCompatible(r)) || null;
    }
    if (!record && providerAccountId) {
      record = own.find((r) => r.accountId === providerAccountId && appMatches(r) && labelCompatible(r)) || null;
    }
    if (!record && hash) {
      record = own.find((r) =>
        r.state === 'open' &&
        r.urlHash === hash &&
        appMatches(r) &&
        idCompatible(r) &&
        labelCompatible(r),
      ) || null;
    }
    if (!record && !reported) {
      record = own.find((r) =>
        r.state === 'open' &&
        !r.reported &&
        r.callKeys.includes(callKey) &&
        appMatches(r) &&
        (r.accountId || '') === providerAccountId &&
        (r.accountLabel || '').toLowerCase() === label.toLowerCase() &&
        (!says || !r.message || r.message === says),
      ) || null;
    }

    if (!record) {
      record = {
        id: randomBytes(8).toString('hex'),
        connId: conn.id,
        app: '',
        accountLabel: '',
        accountId: '',
        message: '',
        callKeys: [],
      };
      this._records.push(record);
    }

    Object.assign(record, {
      mark: this.mark(conn),
      app: name || record.app,
      accountLabel: label || record.accountLabel || '',
      accountId: providerAccountId || record.accountId || '',
      message: says || record.message,
      host: new URL(url).host,
      linkKey: linkKeyOf(url),
      urlHash: hash,
      callKeys: [callKey, ...record.callKeys.filter((key) => key !== callKey)].slice(0, MAX_CALL_KEYS),
      state: 'open',
      reported,
      askedAt: new Date(this.now()).toISOString(),
      askedBy: clean(askedBy, 60),
    });
    delete record.readyAt;
    delete record.openedAt;
    delete record.toldToCheck;
    this._live.set(record.id, { url, expiresAt: this.now() + LINK_TTL_MS, accept, openedAt: null });
    // Records of a Connection that changed or is gone are the first to leave.
    if (this._records.length > MAX_RECORDS) this._records.splice(0, this._records.length - MAX_RECORDS);
    this._changed();
    return record;
  }

  // What the owner sees.
  list(conn) {
    return this._of(conn).map((r) => {
      const live = this._liveOf(r.id);
      return {
        id: r.id,
        app: r.app,
        ...(r.accountLabel ? { accountLabel: r.accountLabel } : {}),
        ...(r.accountId ? { accountId: r.accountId } : {}),
        message: r.message,
        host: r.host,
        state: r.state,
        askedAt: r.askedAt,
        askedBy: r.askedBy,
        ...(r.readyAt ? { readyAt: r.readyAt } : {}),
        url: r.state === 'open' && live ? live.url : null,
        opened: Boolean(live?.openedAt || r.openedAt),
      };
    });
  }

  // Confirmed accounts for one app (or all apps) on a Connection.
  readyAccounts(conn, app = '') {
    const target = clean(app, 60).toLowerCase();
    return this._of(conn)
      .filter((r) => r.state === 'ready' && (!target || r.app.toLowerCase() === target))
      .map((r) => ({
        id: r.id,
        app: r.app,
        accountLabel: r.accountLabel || '',
        accountId: r.accountId || '',
        readyAt: r.readyAt || null,
      }));
  }

  // What an agent sees: never a link.
  forAgents(conn) {
    return this._of(conn).map((r) => ({
      id: r.id,
      app: r.app || r.message || r.host,
      ...(r.accountLabel ? { accountLabel: r.accountLabel } : {}),
      ...(r.accountId ? { accountId: r.accountId } : {}),
      state: r.state === 'ready' ? 'ready' : 'needs sign-in',
    }));
  }

  // The owner opened the link. Only now may the server know that somebody agreed to it.
  opened(conn, id) {
    const record = this._of(conn).find((r) => r.id === id);
    const live = record && record.state === 'open' ? this._liveOf(id) : null;
    if (!live) return null;
    live.openedAt = this.now();
    record.openedAt = live.openedAt;
    delete record.toldToCheck;
    const { accept } = live;
    live.accept = null;
    try { accept?.(); } catch { /* the call that asked has ended */ }
    this._changed();
    return { url: live.url, host: record.host };
  }

  wasOpened(id) {
    return Boolean(this._liveOf(id)?.openedAt);
  }

  remove(conn, id) {
    const before = this._load().length;
    this._records = this._records.filter((r) => !(r.id === id && r.connId === conn.id));
    this._live.delete(id);
    if (this._records.length === before) return false;
    this._changed();
    return true;
  }

  // Remembers the links of a result, and settles protocol-level records that this call belongs to.
  noteResult({ conn, caller, toolName, callKey, args = null, result }) {
    const links = linksIn(result);
    const linkMeta = links.size ? linkMetadataIn(result) : new Map();
    const callAccountIds = new Set([...accountIdsIn(args), ...accountIdsIn(result)]);
    if (links.size) {
      const now = this.now();
      const list = (this._results.get(caller) || []).filter((r) => r.at > now - RESULT_TTL_MS).slice(-(MAX_RESULTS - 1));
      list.push({ connId: conn.id, mark: this.mark(conn), toolName, callKey, links, linkMeta, at: now });
      this._results.delete(caller);
      this._results.set(caller, list);
      if (this._results.size > MAX_CALLERS) this._results.delete(this._results.keys().next().value);
    }
    if (!result?.isError) {
      const key = `${caller}\n${conn.id}`;
      const tools = this._worked.get(key) || new Map();
      const prev = tools.get(toolName) || [];
      const nextEntry = {
        at: this.now(),
        mark: this.mark(conn),
        linkKeys: new Set([...links].map(linkKeyOf)),
        accountIds: callAccountIds,
      };
      const updated = [...prev.slice(-(MAX_WORKED_PER_TOOL - 1)), nextEntry];
      tools.delete(toolName);
      tools.set(toolName, updated);
      if (tools.size > MAX_RESULTS) tools.delete(tools.keys().next().value);
      this._worked.delete(key);
      this._worked.set(key, tools);
      if (this._worked.size > MAX_CALLERS) this._worked.delete(this._worked.keys().next().value);
    }
    let changed = false;
    const linkAgain = []; // opened by the owner, and this result has a new link
    const own = this._of(conn);
    for (const record of own) {
      if (!record.callKeys.includes(callKey)) continue;
      if (record.accountId && callAccountIds.size > 0 && !callAccountIds.has(record.accountId)) continue;
      const again = [...links].filter((href) => {
        if (linkKeyOf(href) !== record.linkKey) return false;
        const meta = linkMeta.get(href);
        if (record.accountId && meta?.accountId && meta.accountId !== record.accountId) return false;
        return true;
      });
      if (again.length) {
        // It asks again. The owner gets the new link, because the old one can have ended. With more than
        // one matching record, nobody knows which link is for which account.
        const matchingRecords = own.filter((r) =>
          r.callKeys.includes(callKey) &&
          r.linkKey === record.linkKey &&
          (!r.accountId || !callAccountIds.size || callAccountIds.has(r.accountId)),
        );
        if (record.reported) {
          if (record.state === 'open' && record.openedAt && matchingRecords.length === 1) {
            linkAgain.push(record);
          }
          continue;
        }
        if (record.state === 'ready') record.askedAt = new Date(this.now()).toISOString();
        record.state = 'open';
        const alone = again.length === 1 && matchingRecords.length === 1;
        const url = alone ? this.address(again[0]) : null;
        if (url && this._liveOf(record.id)?.url !== url) {
          delete record.openedAt;
          record.urlHash = urlHashOf(url);
          this._live.set(record.id, { url, expiresAt: this.now() + LINK_TTL_MS, accept: null, openedAt: null });
        }
        changed = true;
      } else if (!record.reported && !result?.isError && record.state !== 'ready') {
        // Protocol-level sign-ins (-32042 / elicitation / input_required) settle when the exact failing call works.
        // Reported sign-ins settle ONLY through explicit confirm() for that specific account/attempt.
        this._ready(record);
        changed = true;
      }
    }
    if (changed) this._changed();
    return linkAgain;
  }

  // The result that held this link, or null: an agent cannot bring a link of its own.
  resultWith({ conn, caller, toolName, url }) {
    const href = normalized(url);
    if (!href) return null;
    const mark = this.mark(conn);
    const since = this.now() - RESULT_TTL_MS;
    const hit = (this._results.get(caller) || []).findLast((r) =>
      r.connId === conn.id && r.mark === mark && r.toolName === toolName && r.at > since && r.links.has(href)) || null;
    if (!hit) return null;
    const meta = hit.linkMeta?.get(href) || null;
    return {
      ...hit,
      accountId: meta?.accountId || accountIdFromUrl(href) || '',
      accountLabel: meta?.accountLabel || '',
    };
  }

  _matchReported(records, { app = '', accountLabel = '', accountId = '', signInId = '' } = {}) {
    const reqId = clean(signInId, 32);
    const reqAccountId = cleanAccountId(accountId);
    const reqLabel = clean(accountLabel, 60).toLowerCase();
    const reqApp = clean(app, 60).toLowerCase();
    return records.filter((r) => {
      if (!r.reported) return false;
      if (reqId && r.id !== reqId) return false;
      if (reqAccountId && r.accountId !== reqAccountId) return false;
      if (reqLabel && (r.accountLabel || '').toLowerCase() !== reqLabel) return false;
      if (reqApp && r.app.toLowerCase() !== reqApp) return false;
      return Boolean(reqId || reqAccountId || reqLabel || reqApp);
    });
  }

  // The tool that worked last for this caller, on a Connection with a sign-in to this app/account.
  workedFor({ caller, app = '', accountLabel = '', accountId = '', signInId = '' }) {
    const matches = this._matchReported(this._load(), { app, accountLabel, accountId, signInId });
    for (const record of [...matches].reverse()) {
      const tools = this._worked.get(`${caller}\n${record.connId}`);
      if (tools?.size) return `${record.connId}__${[...tools.keys()].at(-1)}`;
    }
    return null;
  }

  // An agent reports a sign-in again after the owner opened it. Match only the exact account/attempt
  // so opening Personal never suppresses reporting a new Work link.
  checkFirst({ conn, app = '', accountLabel = '', accountId = '', signInId = '', url = '' }) {
    const matches = this._matchReported(this._of(conn), { app, accountLabel, accountId, signInId });
    if (matches.length !== 1) return null;
    const [record] = matches;
    // A brand-new link for a different account or without explicit account match is treated as a separate attempt
    // unless it matches the same signInId, same accountId, or same accountLabel.
    const targeted = Boolean(clean(signInId, 32) || cleanAccountId(accountId) || clean(accountLabel, 60));
    const sameUrl = url && record.urlHash && urlHashOf(url) === record.urlHash;
    if (!targeted && !sameUrl) return null;
    if (record.state !== 'open' || !record.openedAt || record.toldToCheck) return null;
    record.toldToCheck = true;
    this._changed();
    return record;
  }

  // An agent says that a call it made shows that the sign-in works.
  confirm({ conn, caller, app = '', accountLabel = '', accountId = '', signInId = '', toolName }) {
    const matches = this._matchReported(this._of(conn), { app, accountLabel, accountId, signInId });
    if (!matches.length) return { reason: 'unknown' };
    if (matches.length > 1) return { reason: 'ambiguous', records: matches };
    const [record] = matches;
    if (record.state === 'ready') return { record };
    if (!record.openedAt) return { reason: 'not_opened', record };
    const calls = this._worked.get(`${caller}\n${conn.id}`)?.get(toolName) || [];
    const postOpen = calls.filter((call) =>
      call.mark === record.mark &&
      call.at > record.openedAt &&
      !call.linkKeys.has(record.linkKey),
    );
    if (!postOpen.length) return { reason: 'no_call', record };
    if (record.accountId) {
      const hasMatchingCall = postOpen.some((call) =>
        call.accountIds.size === 0 || call.accountIds.has(record.accountId),
      );
      if (!hasMatchingCall) return { reason: 'account_mismatch', record };
    }
    this._ready(record);
    this._changed();
    return { record };
  }

  _ready(record) {
    record.state = 'ready';
    record.readyAt = new Date(this.now()).toISOString();
    this._live.delete(record.id);
  }

  // The tool whose result held this link. Whether it still counts, resultWith() decides.
  toolWith({ caller, url }) {
    const href = normalized(url);
    const found = href && (this._results.get(caller) || []).findLast((r) => r.links.has(href));
    return found ? `${found.connId}__${found.toolName}` : null;
  }

  /* ---------- a call that waits for the owner (elicitation/create) ---------- */

  hold(caller, callKey, call, recordOf) {
    const key = `${caller}\n${callKey}`;
    const entry = { recordOf, done: null };
    entry.settled = call.then((result) => { entry.done = { result }; }, (error) => { entry.done = { error }; });
    this._held.set(key, entry);
    if (this._held.size > MAX_HELD) this._held.delete(this._held.keys().next().value);
    // A result that nobody came back for is not kept for long.
    entry.settled.then(() => {
      const timer = setTimeout(() => { if (this._held.get(key) === entry) this._held.delete(key); }, LINK_TTL_MS);
      timer.unref?.();
    });
    return entry;
  }

  held(caller, callKey) {
    return this._held.get(`${caller}\n${callKey}`) || null;
  }

  unhold(caller, callKey) {
    this._held.delete(`${caller}\n${callKey}`);
  }

  /* ---------- what a retry must carry (MCP 2026-07-28) ---------- */

  setResume(caller, callKey, { requestState, asks }) {
    this._resume.set(`${caller}\n${callKey}`, { requestState, asks, at: this.now() });
    if (this._resume.size > MAX_HELD) this._resume.delete(this._resume.keys().next().value);
  }

  // Used once, and only when the owner opened every link of it.
  takeResume(caller, callKey) {
    const key = `${caller}\n${callKey}`;
    const entry = this._resume.get(key);
    if (!entry) return null;
    this._resume.delete(key);
    if (entry.at + LINK_TTL_MS <= this.now() || !entry.asks.every((ask) => this.wasOpened(ask.recordId))) return null;
    return {
      ...(entry.requestState !== undefined ? { requestState: entry.requestState } : {}),
      inputResponses: Object.fromEntries(entry.asks.map((ask) => [ask.key, { action: 'accept' }])),
    };
  }
}

/* ---------- what a server sends ---------- */

const isUrlAsk = (params) => params?.mode === 'url' && typeof params.url === 'string';

// The questions of error -32042 (MCP 2025-11-25), or null.
export function asksOfError(err) {
  if (err?.code !== -32042 || !Array.isArray(err.data?.elicitations)) return null;
  const asks = err.data.elicitations.filter(isUrlAsk).slice(0, 5)
    .map(({ url, message }) => ({ url, message }));
  return asks.length ? { form: 'error', asks } : null;
}

// The questions of an input_required result (MCP 2026-07-28), or null.
export function asksOfResult(result) {
  if (result?.resultType !== 'input_required') return null;
  const requests = Object.entries(result.inputRequests && typeof result.inputRequests === 'object' ? result.inputRequests : {});
  const asks = requests
    .filter(([, r]) => r?.method === 'elicitation/create' && isUrlAsk(r.params))
    .map(([key, r]) => ({ key, url: r.params.url, message: r.params.message }));
  return {
    form: 'result',
    asks: asks.slice(0, 5),
    // Loop says only that it opens links. Another question cannot be answered.
    other: requests.length !== asks.length || asks.length > 5 || asks.length === 0,
    ...(typeof result.requestState === 'string' ? { requestState: result.requestState } : {}),
  };
}

// The same as an ordinary result, for a caller that does not know this field.
export function signInResult(ask, connName) {
  const text = ask.other
    ? `${connName} asks for input that Loop cannot give.`
    : [`${connName} asks for a sign-in.`, ...ask.asks.map((a) => `${clean(a.message, 200)} ${a.url}`.trim())].join('\n');
  return { isError: true, content: [{ type: 'text', text }], _meta: { [SIGN_IN_META]: ask } };
}
