// Category requests: an agent looked for something in the wrong category more than once, and asks
// the owner to file it better. Loop counts the wrong looks itself, so one bad search is never
// enough; the owner sees one request on Home with the reason, and a "no" is remembered per item.
//
// Kept apart from the approval queue on purpose: nothing waits on this answer, so it must not
// expire in minutes, hold a hosted workspace awake, or stop the agent's task.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { CATEGORIES, GENERAL_CATEGORY, categorizeItem, matchesCategory, normalizeCategoryQuery } from './categories.mjs';
import { atomicWriteFile, createWriteQueue, readJsonWithBackup } from './json-file-store.mjs';
import { stemToken, tokenizeQuery } from './search-index.mjs';

export const FINDS_NEEDED = 3;
const WINDOW_MS = 10 * 60 * 1000; // a wrong look counts if the item is found soon after it
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 500;
const MAX_SEARCHES = 8;
const MAX_FINDS_PER_ITEM = 20;
const MAX_ITEMS = 1000;
const MAX_DECLINED = 1000;
const MAX_REQUESTS = 5;
const MAX_MOVES = 40;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keyOf = (kind, id) => `${kind}:${id}`;
const cleanLine = (raw, max) => String(raw ?? '').replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim().slice(0, max);
const words = (text) => new Set(tokenizeQuery(String(text || '').slice(0, 2000)).map(stemToken).filter((t) => t.length > 2));

// The category an agent's filter names, or null when it names none.
function categoryNamed(raw, state) {
  const q = normalizeCategoryQuery(raw);
  if (!q || q === 'all') return null;
  const all = [...(Array.isArray(state?.categories) ? state.categories : []), ...CATEGORIES, GENERAL_CATEGORY];
  return all.find((c) => normalizeCategoryQuery(c.id) === q || normalizeCategoryQuery(c.label) === q)
    || all.find((c) => normalizeCategoryQuery(c.id).includes(q) || normalizeCategoryQuery(c.label).includes(q))
    || null;
}

export class CategoryRequests {
  constructor(dir, { catStore, now = () => Date.now(), onChange = null } = {}) {
    this.file = path.join(dir, 'category-requests.json');
    this.catStore = catStore;
    this._now = now;
    this._onChange = onChange;
    this._lock = createWriteQueue();
    this._searches = new Map(); // session -> [{ at, filter, label, words }], memory only: never what was typed
    this._hints = new Map(); // session -> item key
  }

  async _load() {
    let data = null;
    try {
      ({ data } = await readJsonWithBackup(this.file, { validate: isObj }));
    } catch {
      data = null; // unreadable: start again, nothing here is the owner's own data
    }
    const cutoff = this._now() - KEEP_MS;
    const finds = {};
    for (const [key, list] of Object.entries(isObj(data?.finds) ? data.finds : {})) {
      const fresh = (Array.isArray(list) ? list : []).filter((f) => isObj(f) && Date.parse(f.at) > cutoff && Array.isArray(f.looked));
      if (fresh.length && /^(connection|skill):/.test(key)) finds[key] = fresh;
    }
    return {
      finds,
      declined: (Array.isArray(data?.declined) ? data.declined : []).filter((k) => typeof k === 'string'),
      requests: (Array.isArray(data?.requests) ? data.requests : []).filter((r) => isObj(r) && typeof r.id === 'string' && Array.isArray(r.items) && isObj(r.target)),
    };
  }

  async _save(doc) {
    const keys = Object.keys(doc.finds);
    if (keys.length > MAX_ITEMS) {
      const last = (k) => doc.finds[k].at(-1).at;
      keys.sort((a, b) => last(a).localeCompare(last(b))).slice(0, keys.length - MAX_ITEMS).forEach((k) => { delete doc.finds[k]; });
    }
    doc.declined = doc.declined.slice(-MAX_DECLINED);
    await atomicWriteFile(this.file, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600, backup: false });
  }

  _changed() {
    try { this._onChange?.(); } catch { /* a listener must not break a request */ }
  }

  // An agent searched inside one category.
  noteSearch(session, { query, category } = {}, state = null) {
    const named = categoryNamed(category, state);
    const w = words(query);
    if (!named || !w.size) return;
    const now = this._now();
    for (const [k, list] of this._searches) {
      if (now - list.at(-1).at > WINDOW_MS) this._searches.delete(k);
    }
    while (this._searches.size >= MAX_SESSIONS) this._searches.delete(this._searches.keys().next().value);
    const key = String(session || 'default');
    const list = (this._searches.get(key) || []).filter((s) => now - s.at <= WINDOW_MS).slice(-(MAX_SEARCHES - 1));
    list.push({ at: now, filter: String(category), label: named.label, words: w });
    this._searches.delete(key);
    this._searches.set(key, list);
  }

  // An agent used an item. If it had just looked for it in other categories, that is one find.
  async noteFound(session, kind, item, { state = null, text = '', canAsk = false } = {}) {
    if (!item || typeof item.id !== 'string' || !item.id || item.bundled) return false;
    const sess = String(session || 'default');
    const recent = this._searches.get(sess);
    if (!recent?.length) return false;
    const now = this._now();
    const about = words(`${item.id} ${item.name || ''} ${item.description || ''} ${text}`);
    const wrong = recent.filter((s) => now - s.at <= WINDOW_MS
      && !matchesCategory(item, s.filter, { kind, state })
      && [...s.words].some((t) => about.has(t)));
    if (!wrong.length) return false;
    const rest = recent.filter((s) => !wrong.includes(s)); // each wrong look counts once
    if (rest.length) this._searches.set(sess, rest);
    else this._searches.delete(sess);
    const foundIn = categorizeItem(item, { kind, state });
    const key = keyOf(kind, item.id);
    const ask = await this._lock(async () => {
      const doc = await this._load();
      // Finds from before the item was moved say nothing about where it is now.
      const list = (doc.finds[key] || []).filter((f) => f.in === foundIn.id);
      list.push({ at: new Date(now).toISOString(), in: foundIn.id, looked: [...new Set(wrong.map((s) => s.label))] });
      doc.finds[key] = list.slice(-MAX_FINDS_PER_ITEM);
      await this._save(doc);
      return list.length >= FINDS_NEEDED && this._canAsk(doc, key);
    });
    if (ask && canAsk) {
      while (this._hints.size >= MAX_SESSIONS) this._hints.delete(this._hints.keys().next().value);
      this._hints.set(sess, { key, at: now, label: foundIn.label });
    }
    return true;
  }

  _canAsk(doc, key) {
    return !doc.declined.includes(key) && !doc.requests.some((r) => r.items.some((it) => keyOf(it.kind, it.id) === key));
  }

  // What to tell the agent, once, after enough finds.
  async takeHint(session) {
    const sess = String(session || 'default');
    const hint = this._hints.get(sess);
    if (!hint) return null;
    this._hints.delete(sess);
    if (this._now() - hint.at > WINDOW_MS) return null;
    const doc = await this._load();
    const finds = doc.finds[hint.key] || [];
    if (finds.length < FINDS_NEEDED || !this._canAsk(doc, hint.key)) return null; // answered or asked meanwhile
    const i = hint.key.indexOf(':');
    const kind = hint.key.slice(0, i);
    const id = hint.key.slice(i + 1);
    const looked = [...new Set(finds.flatMap((f) => f.looked))].slice(0, 4).join(', ');
    const field = kind === 'skill' ? 'assignSkills' : 'assignConnections';
    return `Category check: agents looked for ${kind} ${JSON.stringify(id)} in ${looked} ${finds.length} times and found it in ${hint.label}. `
      + `If a better category is clear, ask the owner once: loop__save({ type: "category", dryRun: false, data: { reason: "<one short sentence for the owner>", createCategories: [{ label: "<category>" }], ${field}: { ${JSON.stringify(id)}: "<category>" } } }). `
      + 'Use an existing category when one fits (then leave out createCategories), and add other items only if they clearly belong there too. The owner answers on Loop Home: do not wait or bring it up, carry on with the task. If no better category is clear, ignore this.';
  }

  // An agent asks. `connections` and `skills` are the ones this agent can see.
  async submit({ data = {}, agentId = null, agentName = '', connections = [], skills = [] } = {}) {
    const refuse = (status, message) => ({ ok: false, status, message });
    const reason = cleanLine(data.reason, 240);
    if (!reason) return refuse('invalid', 'Give a one-sentence reason for the owner.');
    const extra = Object.keys(data).filter((k) => !['reason', 'createCategories', 'assignConnections', 'assignSkills'].includes(k));
    if (extra.length) return refuse('invalid', `A category request only takes reason, createCategories, assignConnections and assignSkills (not ${extra.join(', ')}).`);
    const creates = Array.isArray(data.createCategories) ? data.createCategories : [];
    if (creates.length > 1) return refuse('invalid', 'Ask for one category at a time.');
    const description = cleanLine(creates[0]?.description, 240);

    const before = await this.catStore.load();
    const moves = [];
    const maps = { assignConnections: {}, assignSkills: {} };
    for (const [field, kind, list] of [['assignConnections', 'connection', connections], ['assignSkills', 'skill', skills]]) {
      for (const [rawId, to] of Object.entries(isObj(data[field]) ? data[field] : {})) {
        const id = String(rawId).trim();
        const item = list.find((x) => x.id === id);
        const label = cleanLine(to, 60);
        if (!item || !label) return refuse('invalid', `${kind === 'skill' ? 'Skill' : 'Connection'} ${JSON.stringify(id)} cannot be moved.`);
        moves.push({ kind, item });
        maps[field][id] = label;
      }
    }
    if (!moves.length) return refuse('invalid', 'Say which items to move.');
    if (moves.length > MAX_MOVES) return refuse('invalid', `Ask to move at most ${MAX_MOVES} items.`);

    const names = new Set([...Object.values(maps.assignConnections), ...Object.values(maps.assignSkills)]);
    const create = creates.length ? [{ label: cleanLine(creates[0]?.label ?? creates[0], 60), description }] : [];
    const after = await this.catStore.organize({ createCategories: create, ...maps, dryRun: true });
    const targets = new Map(moves.map(({ kind, item }) => {
      const c = categorizeItem(item, { kind, state: after });
      return [c.id, c];
    }));
    if (targets.size !== 1) return refuse('invalid', 'Ask for one category at a time.');
    const target = [...targets.values()][0];
    if (create.length && !names.has(create[0].label) && !names.has(target.id)) return refuse('invalid', 'createCategories must name the category the items move to.');
    const isNew = target.id !== GENERAL_CATEGORY.id && ![...before.categories, ...CATEGORIES].some((c) => c.id === target.id);

    const items = moves.map(({ kind, item }) => {
      const from = categorizeItem(item, { kind, state: before });
      return { kind, id: item.id, name: cleanLine(item.name || item.id, 80), from: from.id, fromLabel: from.label };
    }).filter((it) => it.from !== target.id);
    if (!items.length) return refuse('already_there', 'These items are already in that category. Carry on.');

    const result = await this._lock(async () => {
      const doc = await this._load();
      const keys = items.map((it) => keyOf(it.kind, it.id));
      if (keys.some((k) => doc.declined.includes(k))) {
        return refuse('declined', 'The owner already said no to moving one of these items. Do not ask again; carry on.');
      }
      const same = doc.requests.find((r) => r.items.some((it) => keys.includes(keyOf(it.kind, it.id))));
      const who = cleanLine(agentName, 80) || 'An agent';
      if (same) {
        if (same.target.id === target.id && !same.askedBy.includes(who)) {
          same.askedBy = [...same.askedBy, who].slice(0, 5);
          await this._save(doc);
        }
        return { ok: true, status: 'already_asked', request: same };
      }
      const proof = items.map((it) => (doc.finds[keyOf(it.kind, it.id)] || []).filter((f) => f.in === it.from))
        .sort((a, b) => b.length - a.length)[0];
      if (proof.length < FINDS_NEEDED) {
        return refuse('not_yet', `Agents have not looked for these in the wrong place often enough to ask the owner (${proof.length} of ${FINDS_NEEDED}). Nothing was sent. Carry on.`);
      }
      if (doc.requests.length >= MAX_REQUESTS) return refuse('busy', 'The owner already has several category requests. Nothing was sent. Carry on.');
      const request = {
        id: `crq_${randomBytes(6).toString('hex')}`,
        target: { id: target.id, label: target.label, isNew, description },
        reason,
        agentId,
        askedBy: [who],
        items,
        finds: proof.length,
        looked: [...new Set(proof.flatMap((f) => f.looked))].slice(0, 4),
        createdAt: new Date(this._now()).toISOString(),
      };
      doc.requests.push(request);
      await this._save(doc);
      return { ok: true, status: 'asked', request };
    });
    if (result.ok) this._changed();
    return result;
  }

  // Open requests, without items that are gone or were moved since. Takes the whole inventory:
  // a request with nothing left to move is settled, so it is dropped.
  async list({ connections = [], skills = [] } = {}) {
    if (!(await this._load()).requests.length) return [];
    const state = await this.catStore.load();
    return this._lock(async () => {
      const doc = await this._load();
      const open = doc.requests.map((r) => ({ ...r, items: this._current(r, { connections, skills, state }) })).filter((r) => r.items.length);
      if (open.length !== doc.requests.length) {
        doc.requests = doc.requests.filter((r) => open.some((o) => o.id === r.id));
        await this._save(doc);
      }
      return open;
    });
  }

  _current(request, { connections, skills, state }) {
    return request.items.filter((it) => {
      const item = (it.kind === 'skill' ? skills : connections).find((x) => x.id === it.id);
      return item && categorizeItem(item, { kind: it.kind, state }).id === it.from;
    });
  }

  // The owner's answer. A yes files the items; a no is remembered for each of them.
  async decide(id, approved, { connections = [], skills = [] } = {}) {
    const result = await this._lock(async () => {
      const doc = await this._load();
      const request = doc.requests.find((r) => r.id === id);
      if (!request) return { ok: false, status: 404 };
      const items = this._current(request, { connections, skills, state: await this.catStore.load() });
      if (approved && items.length) {
        const to = request.target.isNew ? request.target.label : request.target.id;
        const maps = { assignConnections: {}, assignSkills: {} };
        for (const it of items) maps[it.kind === 'skill' ? 'assignSkills' : 'assignConnections'][it.id] = to;
        await this.catStore.organize({
          createCategories: request.target.isNew ? [{ label: request.target.label, description: request.target.description || '' }] : [],
          ...maps,
          dryRun: false,
        });
      }
      for (const it of request.items) {
        const key = keyOf(it.kind, it.id);
        delete doc.finds[key];
        if (!approved && !doc.declined.includes(key)) doc.declined.push(key);
      }
      doc.requests = doc.requests.filter((r) => r !== request);
      await this._save(doc);
      return { ok: true, status: 200, request, moved: approved ? items.length : 0 };
    });
    if (result.ok) this._changed();
    return result;
  }
}
