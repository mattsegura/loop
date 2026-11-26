// Incremental memory hygiene: write-time neighbor lookup, cached pair verdicts,
// and an optional 4-class semantic classifier (TypeSafe / Jev) with high-precision
// local fallback.
//
// Replaces read-time O(n^2) scans and the 300-memory ceiling:
// - When a memory is saved or edited, only its top-K semantic/lexical neighbors in
//   overlapping profiles are inspected.
// - Verdicts are cached in memory-hygiene.json keyed by both memories' content hashes,
//   so unchanged pairs are never re-classified.
// - Four crisp outcomes: contradicts | supersedes | duplicate | distinct.
// - Without a classifier key (or when confidence is below threshold), stays strictly
//   high-precision so Home's "Needs you" never cries wolf.

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  detectPairConflict,
  isActiveMemory,
  keptTogether,
  ownerWritten,
  searchMemories,
  tokenizeText,
} from './memory.mjs';
import { normalizeItemProfiles } from './profiles.mjs';
import { keyRefused, noteKeyAnswer } from './typesafe-key.mjs';

export const HYGIENE_VERSION = 1;
export const DEFAULT_HYGIENE_MODEL = 'jev-latest';
export const DEFAULT_HYGIENE_URL = 'https://api.typesafe.ai/v1/systemone';
// High-precision bias: below this probability, treat a pair as 'distinct' rather than alerting.
export const DEFAULT_MIN_PROBABILITY = 0.6;
export const DEFAULT_NEIGHBOR_LIMIT = 6;
export const DEFAULT_MIN_SEMANTIC_SIM = 0.62;
const MAX_VERDICTS = 4000;
const VALID_RELATIONS = new Set(['contradicts', 'supersedes', 'duplicate', 'distinct']);

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function resolveHygieneConfig(env = process.env) {
  const raw = String(env?.LOOP_MEMORY_HYGIENE || 'auto').trim().toLowerCase();
  if (raw === 'off' || raw === 'none') return { enabled: false, reason: 'disabled_by_config' };
  const apiKey = String(env?.LOOP_TYPESAFE_API_KEY || env?.TYPESAFE_API_KEY || '').trim();
  if (!apiKey) return { enabled: false, reason: 'missing_api_key' };
  const min = Number(env?.LOOP_MEMORY_HYGIENE_MIN_PROBABILITY);
  return {
    enabled: true,
    apiKey,
    url: String(env?.LOOP_TYPESAFE_URL || '').trim() || DEFAULT_HYGIENE_URL,
    model: String(env?.LOOP_MEMORY_HYGIENE_MODEL || '').trim() || DEFAULT_HYGIENE_MODEL,
    minProbability: min > 0 && min <= 1 ? min : DEFAULT_MIN_PROBABILITY,
  };
}

export function memoryContentHash(m) {
  const text = `${String(m?.scope || 'global')}\n${String(m?.content || '').replace(/\s+/g, ' ').trim().toLowerCase()}`;
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function pairKey(idA, idB) {
  return [String(idA || ''), String(idB || '')].sort().join('::');
}

export function verdictHash(a, b, model = 'local') {
  const ordered = [a, b].sort((x, y) => String(x.id).localeCompare(String(y.id)));
  const raw = JSON.stringify([
    HYGIENE_VERSION,
    model,
    memoryContentHash(ordered[0]),
    memoryContentHash(ordered[1]),
  ]);
  return createHash('sha256').update(raw).digest('hex').slice(0, 20);
}

export function profilesOverlap(a, b) {
  const pa = normalizeItemProfiles(a?.profiles);
  const pb = normalizeItemProfiles(b?.profiles);
  if (pa.includes('all') || pb.includes('all')) return true;
  const setA = new Set(pa);
  return pb.some((p) => setA.has(p));
}

export function orderByAge(a, b) {
  const ta = Date.parse(a?.updatedAt || a?.createdAt || '') || 0;
  const tb = Date.parse(b?.updatedAt || b?.createdAt || '') || 0;
  if (ta !== tb) return ta < tb ? { older: a, newer: b } : { older: b, newer: a };
  const ca = Date.parse(a?.createdAt || '') || 0;
  const cb = Date.parse(b?.createdAt || '') || 0;
  if (ca !== cb) return ca < cb ? { older: a, newer: b } : { older: b, newer: a };
  return String(a?.id || '').localeCompare(String(b?.id || '')) <= 0
    ? { older: a, newer: b }
    : { older: b, newer: a };
}

function memorySummaryForModel(m) {
  return {
    scope: m.scope || 'global',
    project: m.project || '',
    content: clip(m.content, 500),
    writtenBy: m.writtenBy || 'Owner',
    updatedAt: m.updatedAt || '',
  };
}

export function buildHygieneRequest(a, b, model = DEFAULT_HYGIENE_MODEL) {
  const { older, newer } = orderByAge(a, b);
  return {
    model,
    state: {
      older: memorySummaryForModel(older),
      newer: memorySummaryForModel(newer),
    },
    questions: {
      relation: {
        type: 'choice',
        instructions:
          'Compare these two personal AI agent memories (`older` and `newer`). ' +
          'Choose the single best relationship between them. ' +
          'Pick `distinct` whenever both can be true at the same time, including numbered or separate items (e.g. check 2 vs check 3, step 1 vs step 2).',
        criteria: {
          contradicts: 'Incompatible preferences, rules, or facts that directly disagree and cannot both be true at the same time',
          supersedes: '`newer` is a newer revision or updated value replacing `older` (such as a newer version, port, city, schedule, or decision)',
          duplicate: 'Both memories state essentially the same fact or preference in different words',
          distinct: 'Separate or complementary notes that can safely coexist without conflict or redundancy',
        },
      },
    },
  };
}

const DEFAULT_REASONS = {
  contradicts: 'Memories disagree',
  supersedes: 'Newer memory updates an older one',
  duplicate: 'Very similar memories',
  distinct: '',
};

export async function classifyPair(
  a,
  b,
  {
    apiKey,
    url = DEFAULT_HYGIENE_URL,
    model = DEFAULT_HYGIENE_MODEL,
    minProbability = DEFAULT_MIN_PROBABILITY,
    fetchImpl = fetch,
    timeoutMs = 15000,
  } = {},
) {
  if (keyRefused(apiKey)) throw new Error('memory hygiene: TypeSafe refused this key');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildHygieneRequest(a, b, model)),
      signal: ctrl.signal,
    });
    noteKeyAnswer(apiKey, res.status);
    if (!res.ok) throw new Error(`memory hygiene http ${res.status}`);
    const data = await res.json();
    const ans = data?.answers?.relation;
    const rawChoice = typeof ans?.choice === 'string' ? ans.choice.trim().toLowerCase() : null;
    if (!rawChoice || !VALID_RELATIONS.has(rawChoice)) {
      throw new Error('memory hygiene: unexpected answer');
    }
    const probs = ans?.probabilities && typeof ans.probabilities === 'object' ? ans.probabilities : {};
    const probability = Number(probs[rawChoice]) || 0;
    const relation = rawChoice !== 'distinct' && probability < minProbability ? 'distinct' : rawChoice;
    return {
      relation,
      rawChoice,
      probability,
      confidence: Number(ans?.confidence) || 0,
      reason: DEFAULT_REASONS[relation] || '',
    };
  } finally {
    clearTimeout(timer);
  }
}

function localPairVerdict(a, b) {
  const local = detectPairConflict(a, b);
  if (!local) {
    return { relation: 'distinct', reason: '', probability: 1, source: 'local' };
  }
  const relation = local.kind === 'overlap' ? 'duplicate' : 'contradicts';
  return {
    relation,
    reason: local.reason || DEFAULT_REASONS[relation],
    probability: typeof local.score === 'number' ? local.score : 1,
    source: 'local',
  };
}

function hasExplicitContradictLink(a, b) {
  return (
    (a.links || []).some((l) => (l.target === b.id || l.target === b.key) && l.relation === 'contradicts') ||
    (b.links || []).some((l) => (l.target === a.id || l.target === a.key) && l.relation === 'contradicts')
  );
}

// Pulls only the top-K relevant neighbors of `target` within overlapping profiles so each write
// does O(K) work instead of scanning all N^2 pairs.
export async function findCandidateNeighbors(
  target,
  allActive,
  {
    searchIndex = null,
    limit = DEFAULT_NEIGHBOR_LIMIT,
    minSemantic = DEFAULT_MIN_SEMANTIC_SIM,
    signal = null,
  } = {},
) {
  if (!target || !Array.isArray(allActive) || allActive.length <= 1) return [];
  const pool = allActive.filter(
    (m) => m && m.id !== target.id && isActiveMemory(m) && profilesOverlap(target, m) && !keptTogether(target, m),
  );
  if (pool.length === 0) return [];

  const byId = new Map(pool.map((m) => [m.id, m]));
  const picked = new Map(); // id -> { memory, score, via }

  // 1. Explicit "contradicts" links are always included.
  for (const m of pool) {
    if (hasExplicitContradictLink(target, m)) {
      picked.set(m.id, { memory: m, score: 1.0, via: 'link' });
    }
  }

  // 2. Semantic neighbors via Loop's local/cloud vector index when available.
  if (searchIndex?.embedder?.isAvailable?.()) {
    try {
      const semScores = await searchIndex.scoreMemoriesSemantic(pool, target.content, { signal });
      if (semScores instanceof Map) {
        const rankedSem = [...semScores.entries()]
          .filter(([, score]) => score >= minSemantic)
          .sort((x, y) => y[1] - x[1])
          .slice(0, limit);
        for (const [id, score] of rankedSem) {
          const m = byId.get(id);
          if (m && !picked.has(id)) picked.set(id, { memory: m, score, via: 'semantic' });
        }
      }
    } catch {
      // Fall through to lexical candidate discovery.
    }
  }

  // 3. Fast local BM25/concept candidates (ensures neighbor discovery works offline / without embeddings).
  const lexical = searchMemories(pool, target.content, { withScores: true }).slice(0, limit);
  for (const hit of lexical) {
    if (!hit?.memory || picked.has(hit.memory.id)) continue;
    picked.set(hit.memory.id, { memory: hit.memory, score: hit.score, via: 'lexical' });
  }

  // 4. Local high-precision contradiction check for smaller pools (catches low-overlap polarity/exclusive clashes).
  if (pool.length <= 300) {
    for (const m of pool) {
      if (picked.has(m.id)) continue;
      const local = detectPairConflict(target, m);
      if (local) picked.set(m.id, { memory: m, score: local.score || 0.9, via: 'local' });
    }
  }

  return [...picked.values()].slice(0, Math.max(limit * 2, 12));
}

// How much nearer than the index's minimum a memory must be to count as the same topic (the same
// margin the Skill search uses for a confident match).
const SAME_TOPIC_MARGIN = 0.05;
// Without an embedding model: the share of the new memory's words that the old one must contain.
const SAME_TOPIC_WORDS = 1 / 3;

// The one saved memory most likely to be about the same thing, or null.
async function closestMemory(saved, allActive, { searchIndex = null, signal = null } = {}) {
  const pool = allActive.filter((m) => m && m.id !== saved.id && isActiveMemory(m) && !keptTogether(saved, m));
  if (pool.length === 0) return null;
  const minSemanticScore = searchIndex?.effectiveMinSemanticScore?.();
  const semanticScores = searchIndex?.embedder?.isAvailable?.()
    ? await searchIndex.scoreMemoriesSemantic(pool, saved.content, { signal }).catch(() => null)
    : null;
  const [top] = searchMemories(pool, saved.content, {
    withScores: true,
    semanticScores,
    ...(typeof minSemanticScore === 'number' ? { minSemanticScore } : {}),
  });
  if (!top) return null;
  if (semanticScores) {
    return (semanticScores.get(top.memory.id) ?? 0) >= Math.max((minSemanticScore || 0.34) + 0.12, 0.55) ? top.memory : null;
  }
  const words = new Set(tokenizeText(saved.content));
  const known = new Set(tokenizeText(top.memory.content));
  const shared = [...words].filter((w) => known.has(w)).length;
  return words.size > 0 && shared >= Math.min(2, words.size) && shared / words.size >= SAME_TOPIC_WORDS ? top.memory : null;
}

const RELATION_ORDER = ['supersedes', 'contradicts', 'duplicate', 'similar', 'closest'];

function feedbackItem(saved, other, relation, reason) {
  const replace = `loop__save({ type: "memory", id: "${saved.id}", data: { supersedes: "${other.id}" } })`;
  const hint = {
    supersedes: `Looks like an update of ${other.id}. Replace it with ${replace}; the owner can restore it.`,
    contradicts: `May disagree with ${other.id}. If this one replaces it, call ${replace}; if you are not sure, ask the user.`,
    duplicate: `Says the same as ${other.id}. Keep one: call ${replace}.`,
    similar: `Very close to ${other.id}. If this one replaces it, call ${replace}; otherwise leave both.`,
    closest: `The closest memory already saved. If this one changes or repeats that fact, call ${replace}; otherwise leave both.`,
  }[relation];
  return { id: other.id, key: other.key, content: clip(other.content, 160), relation, reason, hint };
}

// Write-time feedback for agents calling loop__save({ type: 'memory', ... }): up to `limit` saved
// memories that the new one updates, contradicts or repeats, so the agent can replace the old one
// instead of leaving both. `verdicts` (pairKey -> verdict) are the classifier's answers when there
// is one; the high-precision local check adds its own, and when nothing is found the closest memory
// is shown for the agent itself to judge (unless the classifier called it distinct).
export async function findWriteFeedback(
  saved,
  allActive,
  { searchIndex = null, limit = 3, signal = null, verdicts = null } = {},
) {
  if (!saved || !Array.isArray(allActive) || allActive.length <= 1) return [];
  const verdictFor = (other) => {
    const verdict = verdicts?.get?.(pairKey(saved.id, other.id));
    return verdict && verdict.source !== 'local' ? verdict : null;
  };
  const out = [];
  for (const other of allActive) {
    const verdict = other.id === saved.id ? null : verdictFor(other);
    if (verdict && verdict.relation !== 'distinct') out.push(feedbackItem(saved, other, verdict.relation, verdict.reason));
  }
  const candidates = await findCandidateNeighbors(saved, allActive, {
    searchIndex,
    limit: 6,
    minSemantic: 0.78,
    signal,
  });
  for (const cand of candidates) {
    const other = cand.memory;
    const verdict = verdictFor(other);
    if (verdict && verdict.relation !== 'distinct') continue; // listed above
    const local = detectPairConflict(saved, other);
    if (local) {
      out.push(feedbackItem(saved, other, local.kind === 'overlap' ? 'duplicate' : 'contradicts', local.reason));
    } else if (!verdict && cand.via === 'semantic' && cand.score >= 0.84) {
      out.push(feedbackItem(saved, other, 'similar', 'Semantically very close to an existing memory'));
    }
  }
  if (out.length === 0) {
    const closest = await closestMemory(saved, allActive, { searchIndex, signal });
    if (closest && !verdictFor(closest)) out.push(feedbackItem(saved, closest, 'closest', 'Closest saved memory'));
  }
  // A stable sort: within one relation, the first found stays first.
  return out.sort((x, y) => RELATION_ORDER.indexOf(x.relation) - RELATION_ORDER.indexOf(y.relation)).slice(0, limit);
}

// The relations that make the older memory of a pair possibly out of date.
export const OUTDATING_RELATIONS = ['supersedes', 'contradicts'];

// Search results: a memory that a newer one updates or contradicts (cached verdicts only, no new
// calls) names that newer memory and never comes before it. Nothing is hidden or removed, and only
// memories in `visible` are ever named.
export function markOutdated(rows, visible, verdicts) {
  if (!(verdicts instanceof Map) || verdicts.size === 0 || rows.length === 0) return rows;
  const byId = new Map(visible.map((m) => [m.id, m]));
  const newerOf = new Map(); // older id -> { newer, relation }
  for (const verdict of verdicts.values()) {
    if (!OUTDATING_RELATIONS.includes(verdict.relation)) continue;
    const a = byId.get(verdict.a);
    const b = byId.get(verdict.b);
    if (!a || !b) continue;
    const { older, newer } = orderByAge(a, b);
    // Once the older one is edited or saved again, which is current is not known. And an agent's
    // memory never makes the owner's own words look out of date.
    if ((verdict.older && verdict.older !== older.id) || (ownerWritten(older) && !ownerWritten(newer))) continue;
    const known = newerOf.get(older.id);
    if (!known || orderByAge(known.newer, newer).newer === newer) newerOf.set(older.id, { newer, relation: verdict.relation });
  }
  if (newerOf.size === 0) return rows;
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const placed = new Set();
  const out = [];
  const place = (row) => {
    if (placed.has(row.id)) return;
    placed.add(row.id);
    const found = newerOf.get(row.id);
    if (!found) return void out.push(row);
    const newerRow = rowById.get(found.newer.id);
    if (newerRow) place(newerRow);
    out.push({
      ...row,
      newerMemory: {
        id: found.newer.id,
        content: clip(found.newer.content, 160),
        relation: found.relation === 'supersedes' ? 'updates this one' : 'disagrees with this one',
      },
    });
  };
  for (const row of rows) place(row);
  return out;
}

export const NEWER_MEMORY_NOTE =
  'A memory with newerMemory may be out of date. Use the newer memory, and ask the user when the difference matters.';

async function atomicWriteJson(file, data) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// The order of memory checks. A background pass reads and prunes the whole cache, so it runs alone.
// The check of a memory that was just saved waits for a pass that runs now, and it does not wait
// for the check of another save: memories saved at the same time each get their answer in time.
export class HygieneQueue {
  constructor() {
    this._passes = Promise.resolve();
    this._saveChecks = new Set();
  }

  pass(run) {
    const before = Promise.all([this._passes, ...this._saveChecks]);
    this._passes = before.then(run).catch(() => null);
    return this._passes;
  }

  saveCheck(run) {
    const check = this._passes.then(run);
    const ended = check.catch(() => null);
    this._saveChecks.add(ended);
    ended.then(() => this._saveChecks.delete(ended));
    return check;
  }
}

export class MemoryHygieneStore {
  constructor(dataDir = null) {
    this.dir = dataDir;
    this.file = dataDir ? path.join(dataDir, 'memory-hygiene.json') : null;
    this._loaded = false;
    this._verdicts = new Map(); // pairKey -> verdict record
    this._lock = Promise.resolve();
  }

  _withLock(fn) {
    const next = this._lock.then(fn, fn);
    this._lock = next.catch(() => {});
    return next;
  }

  async _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    if (!this.file) return;
    try {
      const text = await readFile(this.file, 'utf8');
      const raw = JSON.parse(text);
      if (raw && typeof raw === 'object' && raw.verdicts && typeof raw.verdicts === 'object') {
        for (const [k, v] of Object.entries(raw.verdicts)) {
          if (v && typeof v === 'object' && v.a && v.b && VALID_RELATIONS.has(v.relation)) {
            this._verdicts.set(k, v);
          }
        }
      }
    } catch {
      // Missing or unreadable cache starts fresh; verdicts are recomputed incrementally.
    }
  }

  async _persist() {
    if (!this.file) return;
    // Cap persisted cache size by most recently checked.
    if (this._verdicts.size > MAX_VERDICTS) {
      const sorted = [...this._verdicts.entries()].sort((x, y) => String(y[1].at || '').localeCompare(String(x[1].at || '')));
      this._verdicts = new Map(sorted.slice(0, MAX_VERDICTS));
    }
    const obj = {};
    for (const [k, v] of this._verdicts.entries()) obj[k] = v;
    await atomicWriteJson(this.file, { version: HYGIENE_VERSION, verdicts: obj });
  }

  // Returns a Map<pairKey, verdict> of cached verdicts that still match the current content hashes
  // of `memories` (including cached 'distinct' verdicts so classifier judgments override regexes,
  // unless `relations` names the ones wanted).
  async activeVerdictMap(memories, { model = null, relations = null } = {}) {
    await this._ensureLoaded();
    const byId = new Map((Array.isArray(memories) ? memories : []).map((m) => [m.id, m]));
    const out = new Map();
    for (const [pk, rec] of this._verdicts.entries()) {
      if (relations && !relations.includes(rec.relation)) continue;
      const a = byId.get(rec.a);
      const b = byId.get(rec.b);
      if (!a || !b || !isActiveMemory(a) || !isActiveMemory(b) || keptTogether(a, b)) continue;
      if (model && rec.model && rec.model !== model && rec.source === 'classifier') continue;
      const expectedHash = verdictHash(a, b, rec.model || 'local');
      if (rec.hash !== expectedHash) continue;
      out.set(pk, rec);
    }
    return out;
  }

  async _evaluatePair(a, b, classifierConfig) {
    if (hasExplicitContradictLink(a, b)) {
      return {
        a: a.id,
        b: b.id,
        relation: 'contradicts',
        reason: 'Marked as conflicting',
        probability: 1,
        source: 'link',
        model: 'local',
        hash: verdictHash(a, b, 'local'),
        at: new Date().toISOString(),
      };
    }

    const useClassifier = Boolean(classifierConfig?.enabled && classifierConfig?.apiKey);
    const model = useClassifier ? (classifierConfig.model || DEFAULT_HYGIENE_MODEL) : 'local';
    const pk = pairKey(a.id, b.id);
    const hash = verdictHash(a, b, model);
    const cached = this._verdicts.get(pk);
    if (cached && cached.hash === hash) {
      return null; // Cache hit; nothing changed.
    }

    if (useClassifier) {
      try {
        const res = await classifyPair(a, b, classifierConfig);
        return {
          a: a.id,
          b: b.id,
          older: orderByAge(a, b).older.id,
          relation: res.relation,
          reason: res.reason,
          probability: res.probability,
          source: 'classifier',
          model,
          hash,
          at: new Date().toISOString(),
        };
      } catch {
        // Fall through to local high-precision check when classifier is unreachable.
      }
    }

    const local = localPairVerdict(a, b);
    return {
      a: a.id,
      b: b.id,
      older: orderByAge(a, b).older.id,
      relation: local.relation,
      reason: local.reason,
      probability: local.probability,
      source: 'local',
      model: 'local',
      hash: verdictHash(a, b, 'local'),
      at: new Date().toISOString(),
    };
  }

  // Incremental write-time check: evaluates only `target` against its top-K neighbors.
  async reviewMemory(
    target,
    allActive,
    { searchIndex = null, classifierConfig = null, concurrency = 4, limit = DEFAULT_NEIGHBOR_LIMIT, signal = null } = {},
  ) {
    if (!target || !isActiveMemory(target)) return { checked: 0, changed: false };
    await this._ensureLoaded();
    const candidates = await findCandidateNeighbors(target, allActive, { searchIndex, limit, signal });
    if (candidates.length === 0) return { checked: 0, changed: false };

    const results = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < candidates.length) {
        const idx = cursor;
        cursor += 1;
        const other = candidates[idx].memory;
        const rec = await this._evaluatePair(target, other, classifierConfig);
        if (rec) results.push(rec);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()));

    if (results.length === 0) return { checked: candidates.length, changed: false };
    await this._withLock(async () => {
      for (const rec of results) this._verdicts.set(pairKey(rec.a, rec.b), rec);
      await this._persist();
    });
    return { checked: candidates.length, changed: true, updated: results.length };
  }

  // Prunes stale entries and incrementally reviews candidate pairs across the store (works past 300 memories).
  async syncAll(
    allActive,
    { searchIndex = null, classifierConfig = null, concurrency = 4, limit = DEFAULT_NEIGHBOR_LIMIT, maxPairs = 120, signal = null } = {},
  ) {
    await this._ensureLoaded();
    const active = (Array.isArray(allActive) ? allActive : []).filter(isActiveMemory);
    const byId = new Map(active.map((m) => [m.id, m]));
    let pruned = false;

    for (const [pk, rec] of this._verdicts.entries()) {
      const a = byId.get(rec.a);
      const b = byId.get(rec.b);
      if (!a || !b || keptTogether(a, b) || rec.hash !== verdictHash(a, b, rec.model || 'local')) {
        this._verdicts.delete(pk);
        pruned = true;
      }
    }

    const useClassifier = Boolean(classifierConfig?.enabled && classifierConfig?.apiKey);
    const targetModel = useClassifier ? (classifierConfig.model || DEFAULT_HYGIENE_MODEL) : 'local';
    const seenPairs = new Set();
    const pending = [];

    for (const m of active) {
      if (pending.length >= maxPairs) break;
      const neighbors = await findCandidateNeighbors(m, active, { searchIndex, limit, signal });
      for (const n of neighbors) {
        const pk = pairKey(m.id, n.memory.id);
        if (seenPairs.has(pk)) continue;
        seenPairs.add(pk);
        const existing = this._verdicts.get(pk);
        if (existing && existing.hash === verdictHash(m, n.memory, targetModel)) continue;
        pending.push([m, n.memory]);
        if (pending.length >= maxPairs) break;
      }
    }

    const results = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const idx = cursor;
        cursor += 1;
        const [a, b] = pending[idx];
        const rec = await this._evaluatePair(a, b, classifierConfig);
        if (rec) results.push(rec);
      }
    };
    if (pending.length > 0) {
      await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
    }

    const changed = pruned || results.length > 0;
    if (changed) {
      await this._withLock(async () => {
        for (const rec of results) this._verdicts.set(pairKey(rec.a, rec.b), rec);
        await this._persist();
      });
    }
    return { checked: pending.length, updated: results.length, changed };
  }
}
