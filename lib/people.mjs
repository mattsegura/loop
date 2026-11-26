// People of a hosted Loop: an invite gives somebody a Loop of their own, filled with what the owner picked.
//
// The owner types a name and picks connections and skills. Each connection is one of two kinds:
//   "own"  : the person signs in with an account of their own. Loop copies the address, never a key.
//   "mine" : the person's agents use the owner's account. The call runs in the owner's Loop, so the
//            owner's approval rules, limits and activity apply, and the owner can end it at any time.
// The person opens a one-use link, signs in to their own Loop account, and gets that list in their own
// Loop. There are no roles: nobody works inside the Loop of somebody else.
//
// Security invariants:
// - The link is the only proof of who joins: 14 + 20 random characters, the code after the "#" is kept
//   only as a SHA-256 hash, compared in constant time, limited per address, and used up by one join.
// - The name in the owner's list is the name the owner typed. The person who joins cannot choose it.
// - The owner sees of each person only the state of what the owner gave them.
// - After the join the owner can only offer more. Nothing new enters the person's Loop without their yes.
// - No secret moves: no header, key, sign-in or query of an address is copied. An address that could hold
//   a secret of its own is not given away, and the owner sees the exact address before they give it.
// - A lent connection is checked on every call against this file, for the Loop and the record that call. To
//   end it stops the calls that still run, and their results are thrown away.
// - A share is tied to one record with one address (its seal). A new connection under the same id, or another
//   address, is something that the owner did not pick: the share ends. A pause and the end of the owner's plan
//   stop the calls too.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { extractUrlSecrets } from './connection-admission.mjs';
import { findSecretRefs } from './secret-refs.mjs';
import { isCloudRouteConnection, isRelayConnection } from './loop-connect.mjs';
import { buildSharedUrl, isSharedConnection, parseSharedUrl } from './shared-connection.mjs';
import { isToolEnabled } from './store.mjs';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PEOPLE = 20; // people and open invites of one Loop together
const MAX_ITEMS = 60; // what one person can get
const MAX_RECORDS = 20_000;
const MAX_CALLS_PER_SHARE = 8; // at the same time
const MAX_WAITING = 5000;
const MAX_QUESTIONS = 5; // that one person's agents can have open at the owner
const DENIED_MS = 10 * 60 * 1000; // a no counts for the same call for this long
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const INVITE_ID_RE = /^[a-z0-9]{14}$/;
const CODE_RE = /^[a-z0-9]{20}$/;
const WS_RE = /^[0-9a-f]{64}$/;
const MAX_POINTS_PER_IP = 300; // a look costs 1 point, a wrong link 10
const WRONG_LINK_POINTS = 10;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_RATE_IPS = 10_000;
const START = 's1.'; // a link that holds its list
const MAX_START_ITEMS = 20;
const MAX_START_CHARS = 6000;
const DEFAULT_LOCAL_ORIGIN = 'http://127.0.0.1:8799';
const ENDED = 'This link has ended. Ask for a new one.';
const FIRST_SYNC_WAIT_MS = 6000;

export class SharedCallError extends Error {}
const ENDED_SHARE = 'This connection has ended. Its owner does not lend it any more.';

function httpError(message, status = 400, code = undefined) {
  return Object.assign(new Error(message), { status, publicMessage: message, ...(code ? { code } : {}) });
}

function cleanName(value, max = 60) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// A name that goes into the Loop, and so to the agents, of somebody else: words only.
const plainName = (value, max = 40) => cleanName(String(value ?? '').replace(/[`|{}[\]$"\\;]/g, ' '), max);

// Every character is equally likely: bytes past the last full run of the alphabet are drawn again.
function randomText(len) {
  const limit = 256 - (256 % ID_ALPHABET.length);
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len)) {
      if (b < limit && out.length < len) out += ID_ALPHABET[b % ID_ALPHABET.length];
    }
  }
  return out;
}

const hashCode = (code) => createHash('sha256').update(String(code), 'utf8').digest('hex');

function sameHash(a, b) {
  const left = Buffer.from(String(a), 'hex');
  const right = Buffer.from(String(b), 'hex');
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}

export function peopleInviteIdFromPath(pathname) {
  const m = /^\/p\/([a-z0-9]+)\/?$/.exec(pathname);
  return m && INVITE_ID_RE.test(m[1]) ? m[1] : null;
}

/* ---------------- what can be given ---------------- */

const UUID_PART_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// A part of an address that looks like somebody's own number or code, not like a word of the service. It
// cannot know a name or a short word, so the owner also sees the exact address before they give it.
function isOwnCode(segment) {
  const text = segment;
  if (!text) return false;
  if (!/^[A-Za-z0-9._~@:+,-]+$/.test(text) || UUID_PART_RE.test(text)) return true;
  const digitsOf = (word) => (word.match(/\d/g) || []).length;
  if (text.length >= 40 || (text.length >= 16 && digitsOf(text) >= 3)) return true;
  return text.split(/[-_.~@:+,]/).some((word) => {
    const digits = digitsOf(word);
    if (word.length >= 18) return true;
    if (digits === word.length) return digits >= 5;
    if (digits >= 2 && word.length >= 8) return true;
    if (word.length < 10) return false;
    const turns = [...word].filter((c, i) => i > 0 && /[A-Z]/.test(c) !== /[A-Z]/.test(word[i - 1])).length;
    return /\d(?!$)/.test(word) || turns >= 3;
  });
}

// The address a person signs in at with an account of their own, or null. The query is left out: it
// names the owner's own project or account.
export function ownSignInUrl(conn) {
  if (!['http', 'sse'].includes(conn?.transport) || isSharedConnection(conn) || isRelayConnection(conn) || isCloudRouteConnection(conn)) return null;
  if (typeof conn.url !== 'string' || findSecretRefs(conn.url).length || conn.url.includes('{{')) return null;
  let parsed;
  try { parsed = new URL(conn.url); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  const bare = `${parsed.origin}${parsed.pathname}`;
  if (extractUrlSecrets(bare).secrets.length) return null;
  if (parsed.pathname.split('/').some(isOwnCode)) return null;
  // A label of the host can be somebody's own too, as a project of its own.
  if (parsed.hostname.split('.').some(isOwnCode)) return null;
  return bare;
}

// The texts by which an address can come back in the error of a service, the longest first.
export function addressParts(url) {
  let at;
  try { at = new URL(url); } catch { return typeof url === 'string' && url ? [url] : []; }
  const own = (text, split) => (text.split(split).some(isOwnCode) ? [text] : []);
  const plain = [url, at.href, `${at.pathname}${at.search}`, at.search.slice(1), ...at.searchParams.values(), ...own(at.pathname, '/'), ...own(at.hostname, '.')];
  const forms = plain.flatMap((text) => [text, encodeURIComponent(text), text.replaceAll('/', '\\/'), text.replaceAll('&', '&amp;')]);
  return [...new Set(forms)].filter((text) => text.length >= 6).sort((a, b) => b.length - a.length);
}

export function canLend(conn) {
  return ['http', 'sse'].includes(conn?.transport) && conn.enabled !== false &&
    !isSharedConnection(conn) && !isRelayConnection(conn) && !isCloudRouteConnection(conn);
}

// What an item is tied to: this record, and for a share also its address.
const sealOf = (conn, mode) => createHash('sha256')
  .update(JSON.stringify([conn.createdAt || '', mode === 'mine' ? conn.url || '' : '']))
  .digest('hex');
const holdsSeal = (item, conn) => Boolean(conn && item.seal) && item.seal === sealOf(conn, item.mode);
const lends = (item, conn) => canLend(conn) && holdsSeal(item, conn);

// What the owner can give: every connection that is on, with the kinds that are possible for it.
export async function shareOptions(ctx) {
  const [conns, skills] = await Promise.all([ctx.store.list(), ctx.skillStore.list()]);
  const connections = [];
  let onComputer = 0;
  for (const c of conns) {
    if (c.enabled === false || c.transport === 'builtin' || isSharedConnection(c)) continue;
    const url = ownSignInUrl(c);
    const mine = canLend(c);
    if (!url && !mine) { onComputer += 1; continue; }
    connections.push({
      id: c.id,
      name: plainName(c.name) || c.id,
      own: url !== null,
      mine,
      ...(url ? { url } : {}),
      projects: Array.isArray(c.profiles) ? c.profiles.filter((p) => p !== 'all') : [],
    });
  }
  connections.sort((a, b) => a.name.localeCompare(b.name));
  return {
    connections,
    skills: skills
      .filter((s) => !s.bundled)
      .map((s) => ({ id: s.id, name: plainName(s.name) || s.id, projects: Array.isArray(s.profiles) ? s.profiles.filter((p) => p !== 'all') : [] }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    onComputer,
  };
}

async function pickItems(ctx, raw) {
  if (!Array.isArray(raw)) throw httpError('items must be a list.');
  if (raw.length > MAX_ITEMS) throw httpError(`One person can get ${MAX_ITEMS} things.`);
  const [options, conns] = await Promise.all([shareOptions(ctx), ctx.store.list()]);
  const have = new Set();
  const out = [];
  for (const wanted of raw) {
    const kind = wanted?.kind;
    const ref = typeof wanted?.ref === 'string' ? wanted.ref : '';
    const option = kind === 'connection' ? options.connections.find((c) => c.id === ref) : kind === 'skill' ? options.skills.find((s) => s.id === ref) : null;
    if (!option) throw httpError('One of these is not in your Loop any more. Open the list again.', 409);
    if (have.has(`${kind}:${ref}`)) continue;
    const item = { id: randomBytes(6).toString('hex'), kind, ref, name: option.name };
    if (kind === 'connection') {
      const mode = wanted.mode === 'mine' ? 'mine' : 'own';
      if (!option[mode]) {
        throw httpError(mode === 'own' ? `${option.name} has an address of your own, so it can only use yours.` : `${option.name} cannot use yours.`);
      }
      const conn = conns.find((c) => c.id === ref);
      if (!conn) throw httpError('One of these is not in your Loop any more. Open the list again.', 409);
      item.mode = mode;
      item.seal = sealOf(conn, mode);
      item.about = cleanName(conn.description, 200);
      // The address that the person sees before they say yes is the address that they get.
      if (mode === 'own') Object.assign(item, { url: option.url, transport: conn.transport });
      if (mode === 'mine') item.share = randomText(12);
    }
    have.add(`${kind}:${ref}`);
    out.push(item);
  }
  return out;
}

/* ---------------- the store ---------------- */
export class PeopleStore {
  constructor(baseDir, { inviteTtlMs = INVITE_TTL_MS } = {}) {
    this.dir = path.resolve(baseDir);
    this.file = path.join(this.dir, 'people.json');
    this.inviteTtlMs = inviteTtlMs;
    this.data = null;
    this._queue = Promise.resolve();
    this._tries = new Map();
    this._calls = new Map(); // share id -> the calls that run now
    this._waiting = new Map(); // a call that waits for the owner's yes -> its approval
    this._denied = new Map(); // a call that the owner said no to -> until when that counts
    this._ending = new Map(); // share id -> how many requests end it now
    this._accepts = new Map(); // person id -> the accept that runs now
  }

  async _load() {
    if (this.data) return this.data;
    let raw = { owners: {}, people: [], invites: [] };
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (err) {
      // A broken file must not look like "nobody is here", and its text must not get into an error.
      if (err?.code !== 'ENOENT') throw new Error('The list of people cannot be read.', { cause: err?.code || err?.name });
    }
    if (this.data) return this.data;
    const isObject = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
    const isRecord = (x) => isObject(x) && WS_RE.test(String(x.workspaceId || '')) && Array.isArray(x.items) && x.items.every(isObject);
    if (!isObject(raw) || !isObject(raw.owners) || ![raw.people, raw.invites].every((l) => Array.isArray(l) && l.every(isRecord))) {
      throw new Error('The list of people cannot be read.');
    }
    this.data = { owners: raw.owners, people: raw.people, invites: raw.invites };
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
      const data = await this._load();
      const now = Date.now();
      data.invites = data.invites.filter((i) => Date.parse(i.expiresAt) > now);
      try {
        return await fn(data, now);
      } catch (err) {
        this.data = null; // read what is on disk again before the next try
        throw err;
      }
    });
    this._queue = run.catch(() => {});
    return run;
  }

  // Too many tries from one address: the links are then closed to it for a while. A wrong link counts most.
  tooManyTries(ip, now = Date.now()) {
    const tries = this._triesOf(ip, now);
    if (!tries) return false;
    if (tries.points >= MAX_POINTS_PER_IP) return true;
    tries.points += 1;
    return false;
  }

  wrongLink(ip, now = Date.now()) {
    const tries = this._triesOf(ip, now);
    if (tries) tries.points += WRONG_LINK_POINTS - 1;
  }

  _triesOf(ip, now) {
    const key = typeof ip === 'string' ? ip.trim() : '';
    if (!key) return null;
    let tries = this._tries.get(key);
    if (!tries || tries.from <= now - RATE_WINDOW_MS) {
      if (!tries && this._tries.size >= MAX_RATE_IPS) this._tries.delete(this._tries.keys().next().value);
      tries = { from: now, points: 0 };
      this._tries.set(key, tries);
    }
    return tries;
  }

  // The name of the owner as it was when they gave it: a later name does not change what the person sees.
  _ownerName(data, record) {
    return typeof record.ownerName === 'string' ? record.ownerName : data.owners[record.workspaceId] || '';
  }

  async ownerName(workspaceId) {
    return (await this._load()).owners[workspaceId] || '';
  }

  async list(workspaceId) {
    const data = await this._load();
    const now = Date.now();
    return {
      people: structuredClone(data.people.filter((p) => p.workspaceId === workspaceId)),
      invites: data.invites
        .filter((i) => i.workspaceId === workspaceId && Date.parse(i.expiresAt) > now)
        .map(({ codeHash: _hash, ...i }) => structuredClone(i)),
    };
  }

  // Who gave something to this Loop.
  async fromFor(personKey) {
    const data = await this._load();
    return data.people
      .filter((p) => p.personKey === personKey)
      .map((p) => ({ ...structuredClone(p), ownerName: this._ownerName(data, p) }));
  }

  // The person that this account became with this link, or null: a used link still opens for who used it.
  async joinedWith(inviteId, personKey) {
    if (!INVITE_ID_RE.test(String(inviteId || '')) || !WS_RE.test(String(personKey || ''))) return null;
    const person = (await this._load()).people.find((p) => p.inviteId === inviteId && p.personKey === personKey);
    return person ? structuredClone(person) : null;
  }

  _newLink(invite, now) {
    const code = randomText(20);
    invite.codeHash = hashCode(code);
    invite.expiresAt = new Date(now + this.inviteTtlMs).toISOString();
    return code;
  }

  async invite({ workspaceId, ownerName, name, items = [] }) {
    const clean = plainName(name, 60);
    if (!WS_RE.test(String(workspaceId || ''))) throw httpError('To invite people, use Loop Cloud.');
    if (!clean) throw httpError('Enter a name.');
    return this._locked(async (data, now) => {
      const mine = (x) => x.workspaceId === workspaceId;
      const same = (x) => mine(x) && x.name.toLowerCase() === clean.toLowerCase();
      if (data.people.some(same) || data.invites.some(same)) throw httpError(`${clean} is in the list already.`, 409);
      if (data.people.filter(mine).length + data.invites.filter(mine).length >= MAX_PEOPLE) {
        throw httpError(`You can invite ${MAX_PEOPLE} people.`, 409);
      }
      if (data.people.length + data.invites.length >= MAX_RECORDS) throw httpError('No new invite is possible now. Try again later.', 429);
      let id = randomText(14);
      while (data.invites.some((i) => i.id === id)) id = randomText(14);
      const owner = plainName(ownerName) || data.owners[workspaceId] || '';
      const invite = { id, workspaceId, ownerName: owner, name: clean, items, createdAt: new Date(now).toISOString() };
      const code = this._newLink(invite, now);
      data.invites.push(invite);
      if (owner) data.owners[workspaceId] = owner;
      await this._save();
      const { codeHash: _hash, ...shown } = invite;
      return { invite: shown, code };
    });
  }

  // A new code for an open invite. The link before it ends.
  async renew(workspaceId, inviteId) {
    return this._locked(async (data, now) => {
      const invite = data.invites.find((i) => i.id === inviteId && i.workspaceId === workspaceId);
      if (!invite) return null;
      const code = this._newLink(invite, now);
      await this._save();
      const { codeHash: _hash, ...shown } = invite;
      return { invite: shown, code };
    });
  }

  async cancelInvite(workspaceId, inviteId) {
    return this._locked(async (data) => {
      const at = data.invites.findIndex((i) => i.id === inviteId && i.workspaceId === workspaceId);
      if (at < 0) return false;
      data.invites.splice(at, 1);
      await this._save();
      return true;
    });
  }

  _open(data, id, code, now) {
    if (!INVITE_ID_RE.test(String(id || '')) || !CODE_RE.test(String(code || ''))) return null;
    const invite = data.invites.find((i) => i.id === id);
    if (!invite || Date.parse(invite.expiresAt) <= now || !sameHash(invite.codeHash, hashCode(code))) return null;
    return invite;
  }

  async peek(id, code) {
    const data = await this._load();
    const invite = this._open(data, id, code, Date.now());
    if (!invite) throw httpError(ENDED, 404);
    const { codeHash: _hash, ...shown } = invite;
    return { ...structuredClone(shown), ownerName: this._ownerName(data, invite) };
  }

  async join(id, code, personKey) {
    if (!WS_RE.test(String(personKey || ''))) throw httpError('Sign in to Loop to continue.', 401);
    return this._locked(async (data, now) => {
      const invite = this._open(data, id, code, now);
      if (!invite) throw httpError(ENDED, 404);
      if (invite.workspaceId === personKey) throw httpError('This link is for somebody else. It is your own Loop.', 409, 'OWN_LOOP');
      if (data.people.some((p) => p.workspaceId === invite.workspaceId && p.personKey === personKey)) {
        throw httpError('You have this already.', 409, 'ALREADY_IN');
      }
      const person = {
        id: randomBytes(8).toString('hex'),
        workspaceId: invite.workspaceId,
        ownerName: this._ownerName(data, invite),
        personKey,
        inviteId: invite.id,
        name: invite.name,
        items: invite.items,
        joinedAt: new Date(now).toISOString(),
      };
      data.people.push(person);
      data.invites.splice(data.invites.indexOf(invite), 1);
      await this._save();
      return structuredClone(person);
    });
  }

  // The owner offers more to somebody who joined. The person says yes to each one in their own Loop. What the
  // person removed (`gone`: item ids) can be offered again.
  async offer(workspaceId, personId, items, gone = []) {
    return this._locked(async (data) => {
      const person = data.people.find((p) => p.id === personId && p.workspaceId === workspaceId);
      if (!person) return null;
      const keyOf = (i) => `${i.kind}:${i.ref}`;
      const wanted = new Set(items.map(keyOf));
      const again = person.items.filter((i) => gone.includes(i.id) && wanted.has(keyOf(i)));
      const kept = person.items.filter((i) => !again.includes(i));
      const have = new Set(kept.map(keyOf));
      const added = items.filter((i) => !have.has(keyOf(i)));
      if (kept.length + added.length > MAX_ITEMS) throw httpError(`One person can get ${MAX_ITEMS} things.`);
      person.items = [...kept, ...added];
      for (const item of again) this._endCalls(item.share);
      await this._save();
      return { ...structuredClone(person), added: added.length };
    });
  }

  // `apply` puts one offered thing into the person's own Loop and returns what to remember of it. It can take
  // some time, so it runs without the lock of the file: the owner can stop things while it runs, and `undo`
  // then removes what it made. One accept of one person at a time.
  async accept(personKey, personId, itemIds, apply, undo = async () => {}) {
    const run = (this._accepts.get(personId) || Promise.resolve()).then(() => this._accept(personKey, personId, itemIds, apply, undo));
    const last = run.catch(() => {});
    this._accepts.set(personId, last);
    try {
      return await run;
    } finally {
      if (this._accepts.get(personId) === last) this._accepts.delete(personId);
    }
  }

  async _accept(personKey, personId, itemIds, apply, undo) {
    const find = (data) => data.people.find((p) => p.id === personId && p.personKey === personKey);
    const data = await this._load();
    const person = structuredClone(find(data) || null);
    if (!person) return null;
    person.ownerName = this._ownerName(data, person);
    const done = [];
    for (const item of person.items) {
      if (item.accepted || (itemIds && !itemIds.includes(item.id))) continue;
      let patch;
      try {
        patch = { ...await apply(item, person), accepted: true };
      } catch (err) {
        // Only a text that is made for the person: another one can hold an address of the owner.
        patch = { problem: String(err?.publicMessage || 'It could not be added.').slice(0, 160) };
      }
      const kept = await this._locked(async (now) => {
        const live = find(now)?.items.find((i) => i.id === item.id && !i.accepted);
        if (!live) return null;
        if (patch.accepted) delete live.problem;
        Object.assign(live, patch);
        await this._save();
        return structuredClone(live);
      });
      if (kept?.accepted) done.push(kept);
      if (!kept && patch.accepted) await undo(item, person);
    }
    const after = await this._load();
    const now = structuredClone(find(after) || null);
    return now && { ...now, ownerName: person.ownerName, done };
  }

  // The owner takes one thing back: an offer that waits, or a connection that they lend.
  async stop(workspaceId, personId, itemId) {
    const find = (data) => data.people.find((p) => p.id === personId && p.workspaceId === workspaceId);
    const shares = (find(await this._load())?.items || []).filter((i) => i.id === itemId).map((i) => i.share);
    return this._endNow(shares, async (data) => {
      const person = find(data);
      const item = person?.items.find((i) => i.id === itemId);
      if (!item) return null;
      if (item.accepted && item.mode !== 'mine') throw httpError(`${item.name} is ${person.name}'s own now.`, 409);
      person.items = person.items.filter((i) => i !== item);
      this._endCalls(item.share);
      await this._save();
      return { person: structuredClone(person), item: structuredClone(item) };
    });
  }

  // Takes away every offer and share that the check names, of the people and of the open invites of one owner.
  // The check is made again inside the lock: an item that is new since then must not look lost.
  async dropLost(workspaceId, makeCheck) {
    const lostOf = (data, isLost) => [...data.people, ...data.invites]
      .filter((r) => r.workspaceId === workspaceId)
      .map((record) => ({ record, items: record.items.filter(isLost) }))
      .filter((x) => x.items.length);
    if (!lostOf(await this._load(), await makeCheck()).length) return [];
    return this._locked(async (data) => {
      const lost = lostOf(data, await makeCheck());
      if (!lost.length) return [];
      for (const { record, items } of lost) {
        record.items = record.items.filter((i) => !items.includes(i));
        for (const item of items) this._endCalls(item.share);
      }
      await this._save();
      return structuredClone(lost.filter((x) => x.record.personKey));
    });
  }

  // The owner removes the person, or the person leaves. What is lent ends at once; the person keeps the rest.
  async remove(match) {
    const shares = ((await this._load()).people.find(match)?.items || []).map((i) => i.share);
    return this._endNow(shares, async (data) => {
      const at = data.people.findIndex(match);
      if (at < 0) return null;
      const [person] = data.people.splice(at, 1);
      for (const item of person.items) this._endCalls(item.share);
      await this._save();
      return { ...structuredClone(person), ownerName: this._ownerName(data, person) };
    });
  }

  // The calls of these shares stop now, also when the file has a line of other work before this.
  async _endNow(shares, fn) {
    const ids = shares.filter(Boolean);
    for (const id of ids) {
      this._ending.set(id, (this._ending.get(id) || 0) + 1);
      this._endCalls(id);
    }
    try {
      return await this._locked(fn);
    } finally {
      for (const id of ids) {
        const left = this._ending.get(id) - 1;
        if (left > 0) this._ending.set(id, left);
        else this._ending.delete(id);
      }
    }
  }

  /* ---- a lent connection ---- */

  _endCalls(shareId) {
    if (!shareId) return;
    for (const call of this._calls.get(shareId) || []) call.abort(new SharedCallError('This connection has ended.'));
    this._calls.delete(shareId);
    for (const map of [this._waiting, this._denied]) {
      for (const key of map.keys()) if (key.startsWith(`${shareId}\n`)) map.delete(key);
    }
  }

  // The record that the accept made is the only one that can use the share: the owner sees that one.
  _findShare(data, shareId, callerKey, connId) {
    if (!shareId || !connId || !WS_RE.test(String(callerKey || '')) || this._ending.has(shareId)) return null;
    for (const person of data.people) {
      if (person.personKey !== callerKey) continue;
      const item = person.items.find((i) => i.share === shareId && i.mode === 'mine' && i.accepted && i.connId === connId);
      if (item) return { person: structuredClone(person), item: structuredClone(item), ownerName: this._ownerName(data, person) };
    }
    return null;
  }

  // The question of the owner that a call waits for, so that the same call finds it again.
  remember(waitKey, approvalId) {
    if (this._waiting.size >= MAX_WAITING) this._waiting.delete(this._waiting.keys().next().value);
    this._waiting.set(waitKey, approvalId);
  }

  // The owner said no: the same call gets the same answer for a while, and asks nothing.
  rememberNo(waitKey, now = Date.now()) {
    if (this._denied.size >= MAX_WAITING) this._denied.delete(this._denied.keys().next().value);
    this._denied.set(waitKey, now + DENIED_MS);
  }

  saidNo(waitKey, now = Date.now()) {
    const until = this._denied.get(waitKey);
    if (until > now) return true;
    this._denied.delete(waitKey);
    return false;
  }

  async shareFor(shareId, callerKey, connId) {
    return this._findShare(await this._load(), shareId, callerKey, connId);
  }

  // Registers one call. Whoever ends the share later stops it: there is no pause between the check and that.
  async beginCall(shareId, callerKey, connId) {
    const data = await this._load();
    const found = this._findShare(data, shareId, callerKey, connId);
    if (!found) throw new SharedCallError(ENDED_SHARE);
    const running = this._calls.get(shareId) || new Set();
    if (running.size >= MAX_CALLS_PER_SHARE) throw new SharedCallError('Too many calls at the same time. Try again in a moment.');
    const call = new AbortController();
    running.add(call);
    this._calls.set(shareId, running);
    return {
      ...found,
      signal: call.signal,
      end: () => {
        running.delete(call);
        if (!running.size && this._calls.get(shareId) === running) this._calls.delete(shareId);
      },
    };
  }
}

/* ---------------- what a person gets ---------------- */

// A service that answered before is signed in, also while it has a fault.
function isSignedIn(conn) {
  const answered = conn.lastSyncAt && (!conn.lastError || conn.tools?.length > 0);
  return Boolean(answered && !conn.authRequired && !conn.signInBroken);
}

// What a person does for a sign-in that is left: sign in at the service, put a key in, or look at a fault.
const signInStep = (conn) => (conn.signInBroken ? 'key' : conn.authRequired ? 'signin' : 'open');

const sameAddress = (a, b) => {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname.replace(/\/+$/, '') === right.pathname.replace(/\/+$/, '');
  } catch {
    return false;
  }
};

// Puts one thing into the person's Loop. Throws when it cannot, and the person can try it again.
async function applyItem(item, { person, ownerCtx, personCtx }) {
  const owner = person.ownerName || 'the owner';
  if (item.kind === 'skill') {
    const skill = await ownerCtx.skillStore.get(item.ref);
    if (!skill || skill.bundled) throw httpError(`${item.name} is not there any more.`);
    if (await personCtx.skillStore.get(item.ref)) return { had: true }; // their own one stays as it is
    await personCtx.skillStore.saveFromDir(item.ref, path.join(ownerCtx.skillStore.skillsDir, item.ref), { source: `From ${owner}` });
    return {};
  }
  const conn = await ownerCtx.store.get(item.ref);
  if (!conn || conn.enabled === false || !holdsSeal(item, conn)) throw httpError(`${item.name} is not there any more.`);
  const mine = await personCtx.store.list();
  if (item.mode === 'mine') {
    if (!canLend(conn)) throw httpError(`${item.name} cannot be lent any more.`);
    const there = mine.find((c) => parseSharedUrl(c.url) === item.share);
    if (there) return { connId: there.id };
    const taken = mine.some((c) => String(c.name || '').toLowerCase() === item.name.toLowerCase());
    const entry = await personCtx.store.add({
      name: taken ? `${item.name} (${owner})` : item.name,
      description: `${owner}'s account. ${item.about || ''}`.trim(),
      transport: 'http',
      url: buildSharedUrl(item.share),
      serverIcons: conn.serverIcons || [],
      websiteUrl: conn.websiteUrl || null,
      profiles: ['all'],
    });
    return { connId: entry.id };
  }
  if (!item.url) throw httpError(`${item.name} cannot be given any more.`);
  return addOwn(item, personCtx, mine);
}

// The connection that a person has for a service. Of more than one, the one that is signed in counts.
function ownOf(item, conns) {
  const same = conns.filter((c) => sameAddress(c.url, item.url));
  const on = same.filter((c) => c.enabled !== false);
  return on.find(isSignedIn) || on[0] || same[0] || null;
}

// A service that the person signs in to themself. One that they have already stays as it is.
async function addOwn(item, ctx, conns) {
  const same = ownOf(item, conns);
  if (same) return { connId: same.id, had: true };
  const { entry } = await ctx.admit({
    name: item.name,
    description: item.about || '',
    transport: item.transport === 'sse' ? 'sse' : 'http',
    url: item.url,
    profiles: ['all'],
  });
  return { connId: entry.id };
}

// The first look at what was added, so that Loop knows which ones ask for a sign-in.
async function firstSync(personCtx, items) {
  const ids = items.filter((i) => i.connId && !i.had).map((i) => i.connId);
  if (!ids.length) return;
  let timer;
  const wait = new Promise((resolve) => { timer = setTimeout(resolve, FIRST_SYNC_WAIT_MS); timer.unref?.(); });
  await Promise.race([Promise.allSettled(ids.map((id) => personCtx.pool.sync(id))), wait]);
  clearTimeout(timer);
}

async function acceptItems({ people, workspaces, personWs, personId, itemIds = null }) {
  const personCtx = personWs.peopleContext;
  const result = await personCtx.hold(() => people.accept(personWs.id, personId, itemIds, async (item, person) => {
    const ownerWs = workspaces.personal(person.workspaceId, false);
    if (!ownerWs) throw httpError(`${item.name} is not there any more.`);
    return ownerWs.peopleContext.hold(() => applyItem(item, { person, ownerCtx: ownerWs.peopleContext, personCtx }));
  }, (item, person) => dropShares(person, [item], workspaces)));
  if (!result) return null;
  if (result.done.length) {
    await personCtx.hold(() => firstSync(personCtx, result.done));
    personCtx.changed(result.done.some((i) => i.kind === 'skill'));
  }
  return result;
}

// 'offer' : waits for the person's yes   'signin' : they must sign in   'ready'   'gone' : they removed it
// 'mine'  : uses the owner's account
function itemState(item, conns) {
  if (!item.accepted) return 'offer';
  if (item.kind === 'skill') return 'ready';
  const conn = conns.find((c) => c.id === item.connId);
  if (!conn) return 'gone';
  if (item.mode === 'mine') return parseSharedUrl(conn.url) === item.share ? 'mine' : 'gone';
  // With another address it is not the service of the invite any more.
  if (conn.enabled === false || !sameAddress(conn.url, item.url)) return 'gone';
  return isSignedIn(conn) ? 'ready' : 'signin';
}

const hostOf = (url) => {
  try { return new URL(url).host; } catch { return ''; }
};

// For somebody who must decide: what it is, and which service an own sign-in goes to.
const offerView = (item) => ({
  kind: item.kind,
  name: item.name,
  ...(item.mode ? { mode: item.mode } : {}),
  ...(item.url ? { host: hostOf(item.url) } : {}),
});

const itemView = (item, state) => ({
  ...offerView(item),
  id: item.id,
  ref: item.ref,
  state,
});

// What the owner sees: the state of what they gave, and nothing else of the person's Loop.
async function personView(person, workspaces) {
  const ws = workspaces.personal(person.personKey, false);
  const conns = ws ? await ws.peopleContext.store.list() : [];
  const items = person.items.map((i) => itemView(i, itemState(i, conns)));
  const own = items.filter((i) => i.kind === 'connection' && i.mode === 'own' && (i.state === 'ready' || i.state === 'signin'));
  return {
    id: person.id,
    name: person.name,
    joinedAt: person.joinedAt,
    items,
    signedIn: own.filter((i) => i.state === 'ready').length,
    signIns: own.length,
  };
}

// What the person sees of it, in their own Loop.
export async function fromViews(people, personWs) {
  const [list, conns] = await Promise.all([people.fromFor(personWs.id), personWs.peopleContext.store.list()]);
  return list.map((p) => ({
    id: p.id,
    owner: p.ownerName || 'A Loop user',
    items: p.items.map((i) => {
      const conn = conns.find((c) => c.id === i.connId);
      const state = itemState(i, conns);
      return {
        ...itemView(i, state),
        ...(conn ? { connId: conn.id } : {}),
        ...(state === 'signin' ? { step: signInStep(conn) } : {}),
        ...(!i.accepted && i.problem ? { problem: i.problem } : {}),
      };
    }),
  }));
}

// The connections of an invite that still wait for the person's own sign-in, for their agents.
export async function signInsLeft(people, personWs) {
  const views = await fromViews(people, personWs);
  return views.flatMap((v) => v.items.filter((i) => i.state === 'signin' && i.connId).map((i) => ({ id: i.connId, name: i.name })));
}

/* ---------------- a call to a lent connection ---------------- */

// The dispatcher of one Loop: it lists and runs the tools of connections that others lend to it.
export function createSharedDispatcher({ people, workspaceId, openWorkspace, hasPlan = async () => true }) {
  const ended = () => new SharedCallError(ENDED_SHARE);
  const ownerOf = async (found) => {
    const ws = openWorkspace(found.person.workspaceId);
    if (!ws) throw ended();
    if (!(await hasPlan(found.person.workspaceId).catch(() => false))) throw new SharedCallError(`${found.ownerName || 'The owner'} cannot lend ${found.item.name} now.`);
    return ws.peopleContext;
  };
  return {
    // Name of the owner and what to show, or null when the share has ended.
    async about(conn) {
      const found = await people.shareFor(parseSharedUrl(conn?.url), workspaceId, conn?.id);
      return found ? { owner: found.ownerName || 'A Loop user' } : null;
    },

    async catalog(conn) {
      const found = await people.shareFor(parseSharedUrl(conn?.url), workspaceId, conn?.id);
      if (!found) throw ended();
      const ownerCtx = await ownerOf(found);
      const own = await ownerCtx.hold(() => ownerCtx.store.get(found.item.ref));
      const owner = found.ownerName || 'the owner';
      if (!holdsSeal(found.item, own)) throw ended();
      if (!canLend(own)) throw new SharedCallError(`${found.item.name} is off in ${owner}'s Loop.`);
      if (own.authRequired) throw new SharedCallError(`${owner} must sign in to ${found.item.name} again.`);
      const tools = (Array.isArray(own.tools) ? own.tools : [])
        .filter((t) => t?.name && isToolEnabled(own, t.name))
        .map((t) => ({
          name: t.name,
          ...(t.title ? { title: t.title } : {}),
          description: t.description || '',
          inputSchema: t.inputSchema || { type: 'object', properties: {} },
          ...(t.annotations ? { annotations: t.annotations } : {}),
        }));
      return { tools, serverIcons: own.serverIcons || [], websiteUrl: own.websiteUrl || null };
    },

    async callTool(conn, toolName, args, { signal = null } = {}) {
      const call = await people.beginCall(parseSharedUrl(conn?.url), workspaceId, conn?.id);
      const stop = () => abort.abort(signal.reason);
      const abort = new AbortController();
      call.signal.addEventListener('abort', () => abort.abort(call.signal.reason), { once: true });
      if (signal?.aborted) stop();
      else signal?.addEventListener('abort', stop, { once: true });
      const owner = call.ownerName || 'The owner';
      const waitKey = [call.item.share, toolName, createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex')].join('\n');
      try {
        if (people.saidNo(waitKey)) return approvalAnswer({ status: 'denied' }, owner, call.item.name);
        const ownerCtx = await ownerOf(call);
        const result = await ownerCtx.hold(() => ownerCtx.runForPerson({
          personId: call.person.id,
          personName: call.person.name,
          connId: call.item.ref,
          toolName,
          args: args ?? {},
          approvalId: people._waiting.get(waitKey) || '',
          maxQuestions: MAX_QUESTIONS,
          lends: (own) => lends(call.item, own),
          signal: abort.signal,
        }));
        const { approval } = result;
        // Nobody must answer a question of a share that ended while it was asked.
        if (call.signal.aborted && approval?.status === 'pending') ownerCtx.approvalQueue.deny(approval.id);
        if (call.signal.aborted) throw call.signal.reason instanceof Error ? call.signal.reason : ended();
        people._waiting.delete(waitKey);
        if (approval?.status === 'pending') people.remember(waitKey, approval.id);
        if (approval?.status === 'denied') people.rememberNo(waitKey);
        if (abort.signal.aborted) throw abort.signal.reason instanceof Error ? abort.signal.reason : ended();
        if (approval) return approvalAnswer(approval, owner, call.item.name);
        return result.result;
      } finally {
        signal?.removeEventListener('abort', stop);
        call.end();
      }
    },
  };
}

// The owner's question stays with the owner: the person's agent gets no link to answer it.
function approvalAnswer(approval, owner, name) {
  const waits = approval.status === 'pending';
  const text = waits
    ? { status: 'approval_required', from: owner, message: `${owner} must say yes to this in their own Loop. They see the question now.`, nextStep: `Tell the user that ${owner} must approve this ${name} action. When they say that it is approved, call the same tool again with exactly the same arguments.` }
    : approval.status === 'denied'
      ? { status: 'approval_denied', from: owner, message: `${owner} said no to this.`, nextStep: 'Tell the user. Stop; do not retry.' }
      : { status: 'approval_required', from: owner, message: 'The earlier question has ended.', nextStep: 'Call the same tool again to ask once more.' };
  return { content: [{ type: 'text', text: JSON.stringify(text, null, 2) }], isError: true };
}

/* ---------------- a Loop on one computer ---------------- */
// Nobody reaches this Loop from outside and it has one account. So the link holds the list itself, names and
// addresses only, and it opens the Loop on the computer of the person. Nothing proves who made such a link:
// the person sees every host before they say yes, and each address must be the same for everybody and public.

function isPublicHost(url) {
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  return host.includes('.') && !/^[\d.]+$|^\[/.test(host) && !/\.(local|localhost|internal|intranet|lan|home|corp|arpa|test|invalid|onion)$/.test(host);
}

async function startOptions(ctx) {
  const { connections, onComputer } = await shareOptions(ctx);
  const open = connections.filter((c) => c.url && isPublicHost(c.url));
  return { connections: open.map((c) => ({ ...c, mine: false })), skills: [], onComputer, onlyYours: connections.length - open.length };
}

async function makeStart(ctx, body, origin) {
  const name = plainName(body?.name, 60);
  if (!name) throw httpError('Enter a name.');
  if (!Array.isArray(body?.items) || !body.items.length) throw httpError('Pick one connection or more.');
  if (body.items.length > MAX_START_ITEMS) throw httpError(`A link can hold ${MAX_START_ITEMS} connections.`);
  const [{ connections }, conns] = await Promise.all([startOptions(ctx), ctx.store.list()]);
  const items = body.items.map((wanted) => {
    const option = connections.find((c) => c.id === wanted?.ref);
    if (!option || wanted.kind !== 'connection' || wanted.mode !== 'own') throw httpError('One of these cannot be in a link. Open the list again.', 409);
    return { kind: 'connection', mode: 'own', ref: option.id, name: option.name, url: option.url, sse: conns.find((c) => c.id === option.id)?.transport === 'sse' };
  });
  const list = items.map((i) => [i.name, i.url.slice('https://'.length), ...(i.sse ? [1] : [])]);
  const text = START + Buffer.from(JSON.stringify([plainName(body.ownerName), list])).toString('base64url');
  if (text.length > MAX_START_CHARS) throw httpError('That is too much for one link. Pick less.');
  const at = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(String(origin)) ? origin : DEFAULT_LOCAL_ORIGIN;
  return { invite: { id: 'start', name, items: items.map((i) => itemView({ ...i, id: i.ref }, 'offer')) }, url: `${at}/p/#${text}` };
}

// The list of a link, or null when one part of it is not what Loop makes.
export function readStart(text) {
  if (typeof text !== 'string' || text.length > MAX_START_CHARS || !/^s1\.[A-Za-z0-9_-]+$/.test(text)) return null;
  let raw;
  try { raw = JSON.parse(Buffer.from(text.slice(START.length), 'base64url').toString('utf8')); } catch { return null; }
  if (!Array.isArray(raw) || !Array.isArray(raw[1]) || !raw[1].length || raw[1].length > MAX_START_ITEMS) return null;
  const items = [];
  for (const row of raw[1]) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string' || row[1].length > 300) return null;
    const item = { name: plainName(row[0]), url: `https://${row[1]}`, transport: row[2] === 1 ? 'sse' : 'http' };
    if (!item.name || ownSignInUrl({ transport: item.transport, url: item.url }) !== item.url || !isPublicHost(item.url)) return null;
    if (!items.some((i) => sameAddress(i.url, item.url))) items.push(item);
  }
  return { owner: typeof raw[0] === 'string' ? plainName(raw[0]) : '', items };
}

// /api/people of a Loop on one computer. The caller is the owner, signed in.
export async function handleLocalPeople({ req, res, pathname, method, ctx, origin, readJsonBody, sendJson }) {
  const ok = (status, body) => sendJson(res, status, body);
  try {
    if (pathname === '/api/people' && method === 'GET') return ok(200, { available: true, local: true, owner: '', canAdd: true, people: [], invites: [], from: [] });
    if (pathname === '/api/people/options' && method === 'GET') return ok(200, await startOptions(ctx));
    if (pathname === '/api/people/invites' && method === 'POST') return ok(201, await makeStart(ctx, await readJsonBody(req), origin));
    if (pathname === '/api/people/start/look' && method === 'POST') {
      const start = readStart((await readJsonBody(req))?.data);
      if (!start) return ok(400, { error: 'This link is not complete.' });
      const conns = await ctx.store.list();
      const logos = await ctx.logosFor(start.items.map((i) => ownOf(i, conns)?.id).filter(Boolean));
      return ok(200, {
        owner: start.owner,
        items: start.items.map((i) => {
          const conn = ownOf(i, conns);
          const state = !conn ? 'add' : conn.enabled === false ? 'off' : isSignedIn(conn) ? 'ready' : 'signin';
          return {
            name: i.name,
            host: hostOf(i.url),
            state,
            ...(conn ? { connId: conn.id } : {}),
            ...(conn && logos[conn.id] ? { logo: logos[conn.id] } : {}),
            ...(state === 'signin' ? { step: signInStep(conn) } : {}),
          };
        }),
      });
    }
    if (pathname === '/api/people/start' && method === 'POST') {
      const start = readStart((await readJsonBody(req))?.data);
      if (!start) return ok(400, { error: 'This link is not complete.' });
      const done = [];
      const failed = [];
      for (const item of start.items) {
        try {
          done.push(await addOwn(item, ctx, await ctx.store.list()));
        } catch {
          failed.push(item.name);
        }
      }
      const added = done.filter((i) => !i.had).length;
      if (added) {
        await firstSync(ctx, done);
        ctx.activity?.record({ agentId: null, agentName: 'Owner', method: 'people/start', target: start.owner || 'A link', ok: true });
        ctx.changed(false);
      }
      if (failed.length && !done.length) return ok(409, { error: 'Loop could not add these.', failed });
      return ok(200, { added, had: done.length - added, failed });
    }
    return ok(404, { error: 'Not found.' });
  } catch (err) {
    if (!err?.publicMessage) throw err;
    return ok(err.status, { error: err.publicMessage });
  }
}

/* ---------------- HTTP ---------------- */
const inviteUrl = (origin, id, code) => `${origin}/p/${id}#${code}`;

// The join page: POST /api/people/preview (anybody with the link) and POST /api/people/join (signed in).
// Returns true when it answered the request.
export async function handlePeopleJoin({ req, res, pathname, method, workspace, clientIp, workspaces, people, text = false, hasPlan = async () => true, readJsonBody, sendJson }) {
  if (pathname !== '/api/people/preview' && pathname !== '/api/people/join') return false;
  if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }), true;
  if (people.tooManyTries(clientIp)) return sendJson(res, 429, { error: 'Too many tries. Wait some minutes and open the link again.' }), true;
  const body = await readJsonBody(req);
  try {
    let used = null;
    const invite = await people.peek(body?.id, body?.code).catch(async (err) => {
      if (err?.status === 404) used = await people.joinedWith(body?.id, workspace?.id);
      if (used) return null;
      if (err?.status === 404) people.wrongLink(clientIp);
      throw err;
    });
    if (used) {
      if (pathname.endsWith('/join')) return sendJson(res, 200, { id: used.id, owner: used.ownerName, added: 0 }), true;
      return sendJson(res, 200, { joined: used.id, text: Boolean(text), needsPlan: !(await hasPlan(workspace.id)) }), true;
    }
    const ownerWs = workspaces.personal(invite.workspaceId, false);
    // Without the plan of the owner nothing new starts. The link works again when the plan does.
    if (!ownerWs || !(await hasPlan(invite.workspaceId))) throw httpError(ENDED, 404);
    if (pathname.endsWith('/preview')) {
      const own = Boolean(workspace) && workspace.id === invite.workspaceId;
      const already = Boolean(workspace) && !own && (await people.fromFor(workspace.id)).some((p) => p.workspaceId === invite.workspaceId);
      const isLost = await lostCheck(ownerWs);
      const items = invite.items.filter((i) => !isLost(i));
      const logos = await ownerWs.peopleContext.logosFor(items.filter((i) => i.kind === 'connection').map((i) => i.ref));
      return sendJson(res, 200, {
        owner: invite.ownerName,
        name: invite.name,
        expiresAt: invite.expiresAt,
        items: items.map((i) => ({ ...offerView(i), ...(logos[i.ref] && i.kind === 'connection' ? { logo: logos[i.ref] } : {}) })),
        text: Boolean(text),
        needsPlan: !(await hasPlan(workspace?.id || null)), // for the agents: Loop itself opens without it
        signedIn: Boolean(workspace),
        own,
        already,
      }), true;
    }
    if (!workspace?.id) return sendJson(res, 401, { error: 'Sign in to Loop to continue.', auth: 'required' }), true;
    await endLost({ people, ws: ownerWs, workspaces });
    const person = await people.join(body?.id, body?.code, workspace.id);
    const result = await acceptItems({ people, workspaces, personWs: workspace, personId: person.id });
    ownerWs.peopleContext.activity?.record({ agentId: null, agentName: person.name, method: 'people/join', target: person.name, ok: true });
    ownerWs.peopleContext.broadcast?.('people');
    return sendJson(res, 201, { id: person.id, owner: person.ownerName, added: result?.done.length || 0 }), true;
  } catch (err) {
    if (!err?.publicMessage) throw err;
    return sendJson(res, err.status, { error: err.publicMessage, ...(err.code ? { code: err.code } : {}) }), true;
  }
}

// Which offers and shares the owner's Loop cannot keep: their connection or skill is gone, or it is another one
// now. What a person said yes to and signs in to themself stays theirs.
async function lostCheck(ownerWs) {
  const { store, skillStore } = ownerWs.peopleContext;
  const [conns, skills] = await Promise.all([store.list(), skillStore.list()]);
  return (item) => {
    if (item.kind === 'skill') return !item.accepted && !skills.some((s) => s.id === item.ref && !s.bundled);
    if (item.accepted && item.mode !== 'mine') return false;
    return !holdsSeal(item, conns.find((c) => c.id === item.ref));
  };
}

async function endLost({ people, ws, workspaces }) {
  for (const { record, items } of await people.dropLost(ws.id, () => lostCheck(ws))) {
    for (const item of items) if (item.share) dropQuestions(ws.peopleContext, record.id, item.ref);
    await dropShares(record, items, workspaces);
  }
}

// What a person loses when a share ends: the record in their Loop that only pointed at it.
async function dropShares(person, items, workspaces) {
  const ws = workspaces.personal(person.personKey, false);
  if (!ws) return;
  const shares = new Set(items.map((i) => i.share).filter(Boolean));
  if (!shares.size) return;
  const ctx = ws.peopleContext;
  await ctx.hold(async () => {
    for (const conn of await ctx.store.list()) {
      const share = parseSharedUrl(conn.url);
      if (!share || !shares.has(share)) continue;
      await ctx.store.remove(conn.id);
      await ctx.pool.invalidate(conn.id).catch(() => {});
    }
  });
  ctx.changed(false);
}

// Questions that a person's agents asked and that nobody must answer any more.
function dropQuestions(ctx, personId, connId = null) {
  for (const apr of ctx.approvalQueue.listPending()) {
    if (apr.agentId === `person_${personId}` && (!connId || apr.target.startsWith(`${connId}__`))) ctx.approvalQueue.deny(apr.id);
  }
}

// /api/people for a signed-in account, in their own Loop.
export async function handlePeopleApi({ req, res, pathname, method, workspace, workspaces, people, origin, hasPlan = async () => true, readJsonBody, sendJson }) {
  if (pathname !== '/api/people' && !pathname.startsWith('/api/people/')) return false;
  const ctx = workspace.peopleContext;
  const workspaceId = workspace.id;
  const ok = (status, body) => (sendJson(res, status, body), true);
  const canAdd = () => hasPlan(workspaceId);
  const noPlan = () => ok(402, { error: 'To invite people, you need Loop Connect.', upgradeRequired: true, billingUrl: '/#settings?tab=billing' });
  const inviteView = (i) => ({ id: i.id, name: i.name, expiresAt: i.expiresAt, items: i.items.map((x) => itemView(x, 'offer')) });
  const record = (what, target) => {
    ctx.activity?.record({ agentId: null, agentName: 'Owner', method: `people/${what}`, target, ok: true });
    ctx.broadcast?.('people');
  };
  try {
    if (pathname === '/api/people' && method === 'GET') {
      await endLost({ people, ws: workspace, workspaces });
      const [{ people: list, invites }, owner, from, access] = await Promise.all([
        people.list(workspaceId), people.ownerName(workspaceId), fromViews(people, workspace), canAdd(),
      ]);
      return ok(200, {
        available: true,
        owner,
        canAdd: access,
        people: await Promise.all(list.map((p) => personView(p, workspaces))),
        invites: invites.map(inviteView),
        from,
      });
    }

    // What others gave to this Loop. Home asks for this one.
    if (pathname === '/api/people/from' && method === 'GET') {
      const from = await fromViews(people, workspace);
      if (!String(req.url).endsWith('?logos=1')) return ok(200, { from });
      const logos = await ctx.logosFor(from.flatMap((p) => p.items.map((i) => i.connId)).filter(Boolean));
      return ok(200, { from: from.map((p) => ({ ...p, items: p.items.map((i) => (logos[i.connId] ? { ...i, logo: logos[i.connId] } : i)) })) });
    }
    const fromMatch = /^\/api\/people\/from\/([0-9a-f]{16})(?:\/items\/([0-9a-f]{12}))?$/.exec(pathname);
    if (fromMatch) {
      const [, personId, itemId] = fromMatch;
      if (itemId && method === 'POST') {
        const giver = (await people.fromFor(workspaceId)).find((p) => p.id === personId);
        if (giver && !(await hasPlan(giver.workspaceId))) return ok(409, { error: `${giver.ownerName || 'The owner'} cannot give this now.` });
        const result = await acceptItems({ people, workspaces, personWs: workspace, personId, itemIds: [itemId] });
        const item = result?.items.find((i) => i.id === itemId);
        if (!item) return ok(404, { error: 'This is not offered any more.' });
        if (!item.accepted) return ok(409, { error: item.problem || 'It could not be added.' });
        workspaces.personal(result.workspaceId, false)?.peopleContext.broadcast?.('people');
        const view = (await fromViews(people, workspace)).find((v) => v.id === personId)?.items.find((i) => i.id === itemId);
        return ok(200, { item: view || null });
      }
      if (!itemId && method === 'DELETE') {
        const gone = await people.remove((p) => p.id === personId && p.personKey === workspaceId);
        if (!gone) return ok(404, { error: 'You left already.' });
        await dropShares(gone, gone.items, workspaces);
        const ownerWs = workspaces.personal(gone.workspaceId, false);
        if (ownerWs) {
          dropQuestions(ownerWs.peopleContext, gone.id);
          ownerWs.peopleContext.activity?.record({ agentId: null, agentName: gone.name, method: 'people/leave', target: gone.name, ok: true });
          ownerWs.peopleContext.broadcast?.('people');
        }
        ctx.broadcast?.('people');
        return ok(200, { left: true });
      }
      return ok(404, { error: 'Not found.' });
    }

    if (pathname === '/api/people/options' && method === 'GET') return ok(200, await shareOptions(ctx));

    if (pathname === '/api/people/invites' && method === 'POST') {
      if (!(await canAdd())) return noPlan();
      const body = await readJsonBody(req);
      const items = await pickItems(ctx, body?.items ?? []);
      const { invite, code } = await people.invite({ workspaceId, ownerName: body?.ownerName, name: body?.name, items });
      record('invite', invite.name);
      return ok(201, { invite: inviteView(invite), url: inviteUrl(origin, invite.id, code) });
    }
    const inviteMatch = /^\/api\/people\/invites\/([a-z0-9]{14})(\/link)?$/.exec(pathname);
    if (inviteMatch) {
      const [, id, link] = inviteMatch;
      if (link && method === 'POST') {
        if (!(await canAdd())) return noPlan();
        const made = await people.renew(workspaceId, id);
        return made ? ok(200, { invite: inviteView(made.invite), url: inviteUrl(origin, id, made.code) }) : ok(404, { error: 'This invite has ended.' });
      }
      if (!link && method === 'DELETE') {
        const done = await people.cancelInvite(workspaceId, id);
        if (done) ctx.broadcast?.('people');
        return ok(done ? 200 : 404, done ? { canceled: true } : { error: 'This invite has ended.' });
      }
    }

    const personMatch = /^\/api\/people\/([0-9a-f]{16})(?:\/(items)(?:\/([0-9a-f]{12}))?)?$/.exec(pathname);
    if (personMatch) {
      const [, personId, items, itemId] = personMatch;
      if (items && !itemId && method === 'POST') {
        if (!(await canAdd())) return noPlan();
        const body = await readJsonBody(req);
        await endLost({ people, ws: workspace, workspaces });
        const now = (await people.list(workspaceId)).people.find((p) => p.id === personId);
        if (!now) return ok(404, { error: 'This person is not in your list any more.' });
        const picked = await pickItems(ctx, body?.items);
        const gone = (await personView(now, workspaces)).items.filter((i) => i.state === 'gone').map((i) => i.id);
        const updated = await people.offer(workspaceId, personId, picked, gone);
        if (!updated) return ok(404, { error: 'This person is not in your list any more.' });
        record('offer', updated.name);
        workspaces.personal(updated.personKey, false)?.peopleContext.broadcast?.('people');
        return ok(200, { person: await personView(updated, workspaces) });
      }
      if (items && itemId && method === 'DELETE') {
        const stopped = await people.stop(workspaceId, personId, itemId);
        if (!stopped) return ok(404, { error: 'This has ended already.' });
        if (stopped.item.share) {
          dropQuestions(ctx, personId, stopped.item.ref);
          await dropShares(stopped.person, [stopped.item], workspaces);
        }
        record('stop', `${stopped.item.name}: ${stopped.person.name}`);
        return ok(200, { person: await personView(stopped.person, workspaces) });
      }
      if (!items && method === 'DELETE') {
        const removed = await people.remove((p) => p.id === personId && p.workspaceId === workspaceId);
        if (!removed) return ok(404, { error: 'This person is not in your list any more.' });
        dropQuestions(ctx, removed.id);
        await dropShares(removed, removed.items, workspaces);
        record('remove', removed.name);
        return ok(200, { removed: true });
      }
    }
    return ok(404, { error: 'Not found.' });
  } catch (err) {
    if (!err?.publicMessage) throw err;
    return ok(err.status, { error: err.publicMessage, ...(err.code ? { code: err.code } : {}) });
  }
}
