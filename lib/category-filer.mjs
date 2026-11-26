// Files Connections and Skills into categories with a TypeSafe (Jev) Choice question.
//
// One question per item: "which of these categories is this mainly used for?", with each category's
// one-line definition as the option text. Runs when items are added or changed, never at lookup time.
// Results are cached by a hash of the item's text plus the category list, so an item is re-filed only
// when it or the set of categories changes. With no key, a failed call or an unsure answer, the item
// keeps the built-in default (categorizeItem in lib/categories.mjs).
//
// Only an item's name, description and tool names/descriptions (or a skill's text) leave the machine —
// never a Connection's address, command, headers, env or sign-in details.

import { createHash } from 'node:crypto';
import { CATEGORIES, GENERAL_CATEGORY, categorizeItem } from './categories.mjs';
import { connectionPurpose } from './connection-chart.mjs';
import { keyRefused, noteKeyAnswer } from './typesafe-key.mjs';

export const FILER_VERSION = 2;
export const DEFAULT_FILER_MODEL = 'jev-latest';
export const DEFAULT_FILER_URL = 'https://api.typesafe.ai/v1/systemone';
// Accept Jev's pick when its top probability reaches this; below it the built-in default stays.
export const DEFAULT_MIN_PROBABILITY = 0.5;
// A new category is suggested once this many items fit none of the current ones.
export const SUGGEST_MIN_ITEMS = 3;
// An item "fits none" when Jev's fit answer is below this (or it ended up in General).
export const UNFIT_BELOW = 0.5;
// A category is suggested for splitting when it holds at least this many items and this share of all.
export const CROWDED_MIN_ITEMS = 12;
export const CROWDED_SHARE = 0.3;

const MAX_TOOLS = 40;
const MAX_TEXT = 1500;

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function resolveFilerConfig(env = process.env) {
  const raw = String(env?.LOOP_CATEGORY_FILER || 'auto').trim().toLowerCase();
  if (raw === 'off' || raw === 'none') return { enabled: false, reason: 'disabled_by_config' };
  const apiKey = String(env?.LOOP_TYPESAFE_API_KEY || env?.TYPESAFE_API_KEY || '').trim();
  if (!apiKey) return { enabled: false, reason: 'missing_api_key' };
  const min = Number(env?.LOOP_CATEGORY_FILER_MIN_PROBABILITY);
  return {
    enabled: true,
    apiKey,
    url: String(env?.LOOP_TYPESAFE_URL || '').trim() || DEFAULT_FILER_URL,
    model: String(env?.LOOP_CATEGORY_FILER_MODEL || '').trim() || DEFAULT_FILER_MODEL,
    minProbability: min > 0 && min <= 1 ? min : DEFAULT_MIN_PROBABILITY,
  };
}

// The options Jev picks from: built-in categories, the user's own categories, and General.
export function categoryOptions(state = null) {
  const opts = [];
  const seen = new Set();
  const push = (id, label, description) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const desc = clip(description, 240);
    opts.push({ id, label, text: desc ? `${label}: ${desc}` : label });
  };
  for (const c of Array.isArray(state?.categories) ? state.categories : []) push(c.id, c.label || c.id, c.description);
  for (const c of CATEGORIES) push(c.id, c.label, c.description);
  push(GENERAL_CATEGORY.id, GENERAL_CATEGORY.label, GENERAL_CATEGORY.description);
  return opts;
}

// What Jev reads about one item. Deliberately a whitelist of descriptive fields.
export function itemState(item = {}, kind = 'connection') {
  if (kind === 'skill') {
    const body = String(item.body || item.content || '').replace(/^---[\s\S]*?---/, ' ').replace(/```[\s\S]*?```/g, ' ');
    return {
      kind: 'Skill (written instructions an AI agent follows)',
      name: clip(item.name || item.id, 120),
      description: clip(item.description, 600),
      excerpt: clip(body, MAX_TEXT),
    };
  }
  const tools = Array.isArray(item.tools) && item.tools.length
    ? item.tools.slice(0, MAX_TOOLS).map((t) => (t?.description ? `${t.name}: ${clip(t.description, 100)}` : String(t?.name || '')))
    : (Array.isArray(item.toolNames) ? item.toolNames.slice(0, MAX_TOOLS).map(String) : []);
  // Same wording the dashboard shows; its last-resort placeholders carry no meaning, so drop them.
  let description = clip(item.description || item.serverInstructions, 600);
  if (!description) {
    const shown = connectionPurpose(item, Array.isArray(item.tools) ? item.tools : []);
    if (shown && shown !== 'Purpose unavailable.' && !/^Available actions? —/.test(shown)) description = shown;
  }
  return {
    kind: 'Connection (an app or service an AI agent can use through its tools)',
    name: clip(item.name || item.id, 120),
    description,
    tools: tools.filter(Boolean),
  };
}

// A bare name is a guess, not a filing: skip items with nothing descriptive to read.
export function hasEvidence(item, kind) {
  const st = itemState(item, kind);
  return Boolean(st.description || st.excerpt || (st.tools && st.tools.length));
}

export function filingKey(item, kind, options, model = DEFAULT_FILER_MODEL) {
  const text = JSON.stringify([FILER_VERSION, model, kind, itemState(item, kind), options.map((o) => [o.id, o.text])]);
  return createHash('sha256').update(text).digest('hex').slice(0, 20);
}

export function buildRequest(item, kind, options, model = DEFAULT_FILER_MODEL) {
  const criteria = {};
  for (const o of options) criteria[o.id] = o.text;
  return {
    model,
    state: { item: itemState(item, kind), categories: options.filter((o) => o.id !== GENERAL_CATEGORY.id).map((o) => o.text) },
    questions: {
      // Asked alongside the pick, over the same state: does any existing category really cover it?
      fits: {
        type: 'noul',
        instructions: 'Does `item` clearly belong in one of `categories`?',
        criteria: {
          true: 'What `item` is mainly used for is covered by one of `categories`',
          false: 'None of `categories` covers what `item` is mainly used for; it would need a new category',
        },
      },
      category: {
        type: 'choice',
        instructions:
          "Which category should `item` be filed under in the user's catalog of agent tools? " +
          'Pick the category that best describes what `item` is mainly used for. ' +
          'Choose General only when no other category fits.',
        criteria,
      },
    },
  };
}

// One item -> { category, probability, confidence } or throws.
export async function fileOne(item, kind, options, { apiKey, url = DEFAULT_FILER_URL, model = DEFAULT_FILER_MODEL, fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  if (keyRefused(apiKey)) throw new Error('category filer: TypeSafe refused this key');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildRequest(item, kind, options, model)),
      signal: ctrl.signal,
    });
    noteKeyAnswer(apiKey, res.status);
    if (!res.ok) throw new Error(`category filer http ${res.status}`);
    const data = await res.json();
    const ans = data?.answers?.category;
    const probs = ans?.probabilities && typeof ans.probabilities === 'object' ? ans.probabilities : {};
    const category = typeof ans?.choice === 'string' ? ans.choice : null;
    if (!category || !options.some((o) => o.id === category)) throw new Error('category filer: unexpected answer');
    return {
      category,
      probability: Number(probs[category]) || 0,
      confidence: Number(ans.confidence) || 0,
      fit: Number.isFinite(Number(data?.answers?.fits?.noul)) ? Number(data.answers.fits.noul) : null,
      probabilities: probs,
      inputTokens: Number(data?.usage?.input_tokens) || 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

// File every item whose cached filing is missing or stale; earlier filings come from state.auto
// (CategoryStore). Returns { auto, changed, filed, failed } where `auto` is the full next map.
export async function fileAll({ connections = [], skills = [] } = {}, state = null, config = {}, { concurrency = 4, onResult = null } = {}) {
  const options = categoryOptions(state);
  const prev = state?.auto && typeof state.auto === 'object' ? state.auto : {};
  const next = { connections: {}, skills: {} };
  const jobs = [];
  for (const [kind, list, bucket] of [['connection', connections, 'connections'], ['skill', skills, 'skills']]) {
    for (const item of list) {
      if (!item || typeof item.id !== 'string' || !item.id || !hasEvidence(item, kind)) continue;
      const key = filingKey(item, kind, options, config.model);
      const old = prev?.[bucket]?.[item.id];
      if (old && old.key === key) next[bucket][item.id] = old;
      else jobs.push({ kind, bucket, item, key });
    }
  }
  let filed = 0;
  let failed = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      try {
        const r = await fileOne(job.item, job.kind, options, config);
        next[job.bucket][job.item.id] = {
          category: r.category,
          p: Math.round(r.probability * 1000) / 1000,
          ...(r.fit !== null ? { fit: Math.round(r.fit * 1000) / 1000 } : {}),
          key: job.key,
          at: new Date().toISOString(),
        };
        filed += 1;
        onResult?.(job, r);
      } catch (err) {
        failed += 1;
        // Keep an older filing while the new one can't be made; it is retried next time.
        const old = prev?.[job.bucket]?.[job.item.id];
        if (old) next[job.bucket][job.item.id] = old;
        onResult?.(job, null, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  // Changed when anything was filed, or when an item was removed or lost its evidence.
  const sameKeys = (b) => {
    const a = Object.keys(prev?.[b] || {});
    return a.length === Object.keys(next[b]).length && a.every((id) => next[b][id] === prev[b][id]);
  };
  const changed = filed > 0 || !sameKeys('connections') || !sameKeys('skills');
  return { auto: next, changed, filed, failed };
}

// Suggestions for the category list, from the stored filings. Two kinds:
//   new:   at least SUGGEST_MIN_ITEMS items fit none of the current categories (or sit in General);
//   split: one category has grown to hold a large share of everything.
// Loop's bundled Skills are left out. Items placed explicitly are never counted as misfits; dismissed keys
// ("connection:<id>", "skill:<id>", "split:<category id>") are left out.
// Naming is left to whoever acts on it (the adding agent or the owner): Jev returns choices, not text.
export function categorySuggestions({ connections = [], skills = [] } = {}, state = null) {
  if (!state?.auto) return [];
  const dismissed = new Set(Array.isArray(state.dismissedSuggestions) ? state.dismissedSuggestions : []);
  const misfits = [];
  const counts = new Map();
  let total = 0;
  for (const [kind, list, bucket] of [['connection', connections, 'connections'], ['skill', skills, 'skills']]) {
    for (const item of list) {
      // Loop's own bundled Skills are not the user's to reorganize.
      if (!item || typeof item.id !== 'string' || !item.id || item.bundled) continue;
      const cat = categorizeItem(item, { kind, state });
      total += 1;
      const group = counts.get(cat.id) || { id: cat.id, label: cat.label, items: [] };
      group.items.push({ kind, id: item.id, name: item.name || item.id });
      counts.set(cat.id, group);
      const explicit = Object.hasOwn(state[bucket] || {}, item.id);
      const filed = state.auto?.[bucket]?.[item.id];
      if (explicit || !filed || dismissed.has(`${kind}:${item.id}`)) continue;
      const unfit = (typeof filed.fit === 'number' && filed.fit < UNFIT_BELOW) || cat.id === GENERAL_CATEGORY.id;
      if (unfit) misfits.push({ kind, id: item.id, name: item.name || item.id, current: cat.label, fit: filed.fit ?? null, filedAt: filed.at || null });
    }
  }
  const out = [];
  if (misfits.length >= SUGGEST_MIN_ITEMS) {
    out.push({
      type: 'new',
      key: 'new',
      items: misfits,
      message: `${misfits.length} items don't fit any current category well. A new category could group them.`,
    });
  }
  for (const g of counts.values()) {
    if (g.id === GENERAL_CATEGORY.id || dismissed.has(`split:${g.id}`)) continue;
    if (g.items.length >= CROWDED_MIN_ITEMS && g.items.length >= total * CROWDED_SHARE) {
      out.push({
        type: 'split',
        key: `split:${g.id}`,
        category: { id: g.id, label: g.label },
        items: g.items,
        message: `${g.label} holds ${g.items.length} of ${total} items. Splitting it could make it easier to scan.`,
      });
    }
  }
  return out;
}
