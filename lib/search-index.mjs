// Unified first-principles Search Index for Loop Tools, Skills, Connections, and Memory.
//
// Design invariants (empirically grounded):
// 1. Works out-of-the-box with ZERO ML dependencies (structured lexical + tiered exact match).
// 2. When a semantic embedder is enabled (local on-demand, Ollama, or hosted HTTP):
//    - Untrusted Tools & Skills rank in STRICT TIERS:
//      Tier 1: exact tool/connection/skill name match (blocks keyword-stuffed descriptions)
//      Tier 2: semantic score over clean text (description + best example, no raw JSON schemas)
//    - Trusted personal Memory combines semantic similarity with MemoryStore's BM25 + fuzzy + 1-hop graph.
//    - Vault secrets are NEVER embedded or indexed here.
// 3. Binary int8 vector cache on disk (<50ms reload for 20k vectors), fingerprint-diffed so unchanged
//    items never re-embed and switching models auto-invalidates cleanly.
// 4. Private tools start on description alone and learn bounded, secret-filtered local examples
//    from confirmed (search -> successful run) pairs.

import { createHash, createHmac, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, createWriteQueue } from './json-file-store.mjs';
import {
  createNullEmbedder,
  dotInt8Float32,
  l2Normalize,
  quantizeInt8,
} from './embedder.mjs';
import { looksLikeSecret } from './memory.mjs';

export const DEFAULT_MAX_PER_CONNECTION = 4;
export const DEFAULT_TOOL_SEARCH_LIMIT = 12;
// In the real-query set the right Skill is in the first 8 whenever it is in the first 12.
export const DEFAULT_SKILL_SEARCH_LIMIT = 8;
// How close to the best Skill's evidence another Skill's has to be. In the same set, listing the
// close ones first puts the right Skill in the first 8 for 70 of 75 searches (66 without), and where
// only one or two are close they are right for 13 of 14.
const SKILL_FOCUS_SEMANTIC_BAND = 0.05;
const SKILL_FOCUS_LEXICAL_RATIO = 0.7;
export const CLEAR_SKILL_MATCHES = 2;
export const DEFAULT_MAX_LEARNED_PER_TOOL = 5;
export const DEFAULT_MIN_SEMANTIC_SCORE = 0.34;
export const DEFAULT_AUTO_SEMANTIC_MIN_TOOLS = 50;
export const DEFAULT_AUTO_SEMANTIC_MIN_CONNECTIONS = 6;
// In the real-query set keyword search lists the right Skill in the first 8 for 76% of searches at
// 50 Skills and 63% at 100 (vectors: 86% and 82%). Memories use the same limit.
export const AUTO_SEMANTIC_MIN_SKILLS = 50;
export const AUTO_SEMANTIC_MIN_MEMORIES = 50;
export const MAX_INLINE_SCHEMA_BYTES = 24 * 1024;
export const MAX_SINGLE_INLINE_SCHEMA_BYTES = 12 * 1024;
export const LEARN_WINDOW_MS = 2 * 60 * 1000;

const BIN_MAGIC = Buffer.from('LPVC', 'ascii');
const BIN_VERSION = 1;
const BIN_HEADER_BYTES = 16; // 4 magic + 4 version + 4 dim + 4 count
const MAX_BIN_DIM = 4096;
const MAX_BIN_COUNT = 250_000;
const MAX_SEARCH_QUERY_CHARS = 512;
const MAX_LEARNED_QUERY_CHARS = 180;
const LEARNED_DEDUPE_COSINE = 0.90;
const MAX_SESSION_SEARCH_HISTORY = 16;
const MAX_TRACKED_SESSIONS = 200;
const COMPOUND_PARAM_KEY_RE = /(?:[_-]|[a-z][A-Z])/;

const SCHEMA_META_CACHE = new WeakMap();

const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'with', 'from', 'by', 'at', 'as',
  'into', 'out', 'over', 'under', 'then', 'than', 'off', 'down',
  'is', 'are', 'was', 'were', 'be', 'my', 'me', 'i', 'we', 'our', 'you', 'your', 'their',
  'and', 'or', 'do', 'does', 'did', 'can', 'could', 'would', 'should', 'please',
  'find', 'get', 'show', 'list', 'check', 'run', 'use', 'using', 'via', 'about',
  'all', 'any', 'some', 'this', 'that', 'these', 'those', 'it', 'its',
  'what', 'how', 'why', 'who', 'where', 'when', 'many', 'much',
  'give', 'let', 'know', 'want', 'need', 'tell', 'just', 'help', 'make', 'take',
]);

/* ---------------- Tokenization & Fingerprinting ---------------- */

export function splitIdentifiers(raw) {
  return String(raw || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function stemToken(raw) {
  const t = String(raw || '').toLowerCase();
  if (t.length <= 3 || /^\d+$/.test(t)) return t;
  if (t.endsWith('ies') && t.length > 4) return `${t.slice(0, -3)}y`;
  if (/(?:sses|xes|ches|shes)$/.test(t) && t.length > 4) return t.slice(0, -2);
  if (t.endsWith('s') && !/(?:ss|us|is)$/.test(t) && t.length > 3) return t.slice(0, -1);
  // Conservative gerund/past-tense stemming: never collapse short doubled stems like "planning" -> "plan"
  if (t.endsWith('ing') && t.length >= 7) {
    const rawStem = t.slice(0, -3);
    const hasDoubled = /(.)\1$/.test(rawStem) && !/[lsz]$/.test(rawStem);
    const base = hasDoubled ? rawStem.slice(0, -1) : rawStem;
    if (base.length >= 5 || (!hasDoubled && base.length >= 4)) return base;
  }
  if (t.endsWith('ed') && t.length >= 6) {
    let base = t.slice(0, -2);
    if (/(.)\1$/.test(base) && !/[lsz]$/.test(base)) base = base.slice(0, -1);
    return base;
  }
  return t;
}

const ARITH_EXPR_RE = /(?<![A-Za-z/])\d+(?:\.\d+)?\s*(?:[+*×÷^%]|\s-\s|\s*\/\s*(?!\/))\s*\d+(?:\.\d+)?(?![A-Za-z/])/;

function expandQuerySymbols(raw) {
  const s = String(raw || '');
  if (!ARITH_EXPR_RE.test(s)) return [];
  const extra = ['calculate', 'calculator', 'math', 'arithmetic'];
  if (/[*×]/.test(s)) extra.push('multiply');
  if (/\+/.test(s)) extra.push('add');
  if (/\d\s+-\s+\d/.test(s)) extra.push('subtract');
  if (/[÷]|(?<![:/])\/(?![/])/.test(s)) extra.push('divide');
  if (/%/.test(s)) extra.push('percent');
  return extra;
}

export function tokenizeQuery(raw, { keepStop = false } = {}) {
  const all = splitIdentifiers(raw);
  const symbolHints = expandQuerySymbols(raw);
  const base = keepStop ? all : all.filter((t) => !STOPWORDS.has(t));
  const combined = [...(base.length > 0 ? base : all), ...symbolHints];
  if (!symbolHints.length) return combined;
  return [...new Set(combined)];
}

function tokenizeStemmed(raw) {
  const toks = splitIdentifiers(raw);
  const out = new Array(toks.length);
  for (let i = 0; i < toks.length; i += 1) out[i] = stemToken(toks[i]);
  return out;
}

// Reusable scratch rows for boundedEditDistance (zero heap allocations for tokens < 64 chars).
const EDIT_SCRATCH_CAP = 64;
const EDIT_ROW_A = new Int16Array(EDIT_SCRATCH_CAP);
const EDIT_ROW_B = new Int16Array(EDIT_SCRATCH_CAP);
const EDIT_ROW_C = new Int16Array(EDIT_SCRATCH_CAP);

// Fast bounded Optimal String Alignment (Damerau-Levenshtein) distance for typo tolerance.
// Returns maxDist + 1 early whenever edit distance exceeds maxDist.
export function boundedEditDistance(a, b, maxDist = 1) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDist) return maxDist + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;

  const useScratch = lb < EDIT_SCRATCH_CAP;
  let prev2 = useScratch ? EDIT_ROW_A : new Int16Array(lb + 1);
  let prev1 = useScratch ? EDIT_ROW_B : new Int16Array(lb + 1);
  let curr = useScratch ? EDIT_ROW_C : new Int16Array(lb + 1);
  for (let j = 0; j <= lb; j += 1) prev1[j] = j;

  for (let i = 1; i <= la; i += 1) {
    curr[0] = i;
    let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j += 1) {
      const cb = b.charCodeAt(j - 1);
      const cost = ca === cb ? 0 : 1;
      let val = prev1[j] + 1;
      const ins = curr[j - 1] + 1;
      if (ins < val) val = ins;
      const sub = prev1[j - 1] + cost;
      if (sub < val) val = sub;
      if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb) {
        const trans = prev2[j - 2] + 1;
        if (trans < val) val = trans;
      }
      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist) return maxDist + 1;
    const tmp = prev2;
    prev2 = prev1;
    prev1 = curr;
    curr = tmp;
  }
  return prev1[lb];
}

function extractQueryClauses(cleanQuery) {
  const parts = String(cleanQuery || '')
    .split(/\s+(?:and then|then|and)\s+|;\s+/iu)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return [];
  // Only treat as a multi-action compound query when every clause has >= 3 substantive tokens
  // (avoids splitting short phrases like "profit and loss" or "read and write").
  for (const part of parts) {
    if (tokenizeQuery(part).length < 3) return [];
  }
  return parts;
}

export function fingerprintText(modelId, kind, key, text) {
  return createHash('sha256')
    .update(`${modelId || 'none'}\0${kind}\0${key}\0${String(text || '').trim()}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
}

const SCHEMA_TYPE_NOISE_RE = /\b(?:string|number|integer|boolean|object|array|null|undefined|enum)\b/gi;

function getCachedSchemaMeta(inputSchema) {
  if (!inputSchema || typeof inputSchema !== 'object') {
    return { keys: [], text: '' };
  }
  const hit = SCHEMA_META_CACHE.get(inputSchema);
  if (hit) return hit;
  const props = inputSchema.properties;
  if (!props || typeof props !== 'object') {
    const empty = { keys: [], text: '' };
    SCHEMA_META_CACHE.set(inputSchema, empty);
    return empty;
  }
  const keys = Object.keys(props).slice(0, 64);
  const parts = [];
  let len = 0;
  for (const [key, spec] of Object.entries(props)) {
    const rawDesc = typeof spec?.description === 'string' ? spec.description.trim().slice(0, 80) : '';
    const desc = rawDesc ? rawDesc.replace(SCHEMA_TYPE_NOISE_RE, ' ').replace(/\s+/g, ' ').trim() : '';
    const piece = desc ? `${key} ${desc}` : key;
    if (len + piece.length + 1 > 480) break;
    parts.push(piece);
    len += piece.length + 1;
  }
  const computed = { keys, text: parts.join(' ') };
  SCHEMA_META_CACHE.set(inputSchema, computed);
  return computed;
}

export function extractSchemaParamKeys(inputSchema) {
  return getCachedSchemaMeta(inputSchema).keys;
}

export function extractSchemaParamText(inputSchema, maxChars = 480) {
  const txt = getCachedSchemaMeta(inputSchema).text;
  return txt.length > maxChars ? txt.slice(0, maxChars) : txt;
}

function cleanToolSemanticText(conn, tool) {
  const nameWords = splitIdentifiers(tool.name).join(' ');
  const desc = String(tool.description || '').replace(/\s+/g, ' ').trim().slice(0, 420);
  const connLabel = String(conn?.name || conn?.id || '').trim().slice(0, 64);
  // Embed strictly THIS tool's own name, Connection label, and description — never conn.description,
  // which summarizes sibling tools and causes cross-contamination inside multi-tool Connections.
  // Optional (LOOP_EMBED_TOOL_PARAMS=1): append input names, which often carry the real noun.
  const params = process.env.LOOP_EMBED_TOOL_PARAMS === '1' ? extractSchemaParamText(tool.inputSchema, 200) : '';
  return `${connLabel}: ${nameWords}${desc ? ` — ${desc}` : ''}${params ? ` Inputs: ${params}` : ''}`.trim();
}

function cleanConnectionSemanticText(conn, categoryLabel = '') {
  const name = String(conn?.name || conn?.id || '').trim();
  const desc = String(conn?.description || '').replace(/\s+/g, ' ').trim().slice(0, 320);
  const cat = String(categoryLabel || '').trim();
  return [name, cat ? `(${cat})` : '', desc].filter(Boolean).join(' ').trim();
}

function cleanSkillSemanticText(skill) {
  const name = String(skill?.name || skill?.id || '').trim();
  const desc = String(skill?.description || '').replace(/\s+/g, ' ').trim().slice(0, 420);
  return desc ? `${name} — ${desc}` : name;
}

function cleanMemorySemanticText(mem) {
  const tags = Array.isArray(mem?.tags) && mem.tags.length > 0 ? ` [${mem.tags.join(', ')}]` : '';
  const project = mem?.project ? ` (${mem.project})` : '';
  return `${String(mem?.content || '').trim()}${project}${tags}`.trim();
}

/* ---------------- Signed Hosted Catalog Bundles ---------------- */

function canonicalCatalogBody(bundle) {
  const { signature: _sig, ...unsigned } = bundle || {};
  return JSON.stringify(unsigned);
}

export function signCatalogBundle(bundle, { hmacSecret = null, privateKeyPem = null } = {}) {
  const body = canonicalCatalogBody(bundle);
  if (privateKeyPem) {
    throw new Error('Use node:crypto sign(null, Buffer.from(body), privateKeyPem) for Ed25519.');
  }
  if (!hmacSecret) throw new Error('hmacSecret is required to sign catalog bundle.');
  const sig = createHmac('sha256', hmacSecret).update(body, 'utf8').digest('hex');
  return { ...bundle, signature: `hmac-sha256:${sig}` };
}

export function verifySignedCatalogBundle(bundle, { hmacSecret = null, publicKeyPem = null } = {}) {
  if (!bundle || typeof bundle !== 'object' || typeof bundle.signature !== 'string') {
    return { valid: false, reason: 'missing_signature' };
  }
  const body = canonicalCatalogBody(bundle);
  const rawSig = bundle.signature.trim();

  if (rawSig.startsWith('ed25519:')) {
    if (!publicKeyPem) return { valid: false, reason: 'missing_public_key' };
    try {
      const sigBuf = Buffer.from(rawSig.slice('ed25519:'.length), 'base64');
      const ok = verifySignature(null, Buffer.from(body, 'utf8'), publicKeyPem, sigBuf);
      return ok ? { valid: true } : { valid: false, reason: 'bad_signature' };
    } catch {
      return { valid: false, reason: 'bad_signature' };
    }
  }

  if (rawSig.startsWith('hmac-sha256:')) {
    if (!hmacSecret) return { valid: false, reason: 'missing_hmac_secret' };
    const provided = rawSig.slice('hmac-sha256:'.length);
    const expected = createHmac('sha256', hmacSecret).update(body, 'utf8').digest('hex');
    if (provided.length !== expected.length) return { valid: false, reason: 'bad_signature' };
    const ok = timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
    return ok ? { valid: true } : { valid: false, reason: 'bad_signature' };
  }

  return { valid: false, reason: 'unsupported_signature_scheme' };
}

/* ---------------- Local Binary int8 Vector Store ---------------- */

export class LocalBinaryVectorStore {
  constructor(dir = null) {
    this.dir = dir;
    this.binPath = dir ? path.join(dir, 'search-vectors.bin') : null;
    this.metaPath = dir ? path.join(dir, 'search-vectors-meta.json') : null;
    this.modelId = null;
    this.dimensions = 0;
    this.entries = []; // [{ key, kind, parentId, slot, fingerprint }]
    this.keyToIdx = new Map();
    this.parentKeys = new Set(); // `${kind}\0${parentId}` for O(1) indexed-coverage checks
    this.vectors = new Int8Array(0);
    this.loaded = false;
    this.dirty = false;
    this._writeQueue = createWriteQueue();
  }

  async load(expectedModelId = null) {
    if (this.loaded) {
      if (expectedModelId && this.modelId && this.modelId !== expectedModelId) {
        this.reset(expectedModelId, 0);
      }
      return;
    }
    this.loaded = true;
    if (!this.binPath || !this.metaPath) {
      this.modelId = expectedModelId;
      return;
    }
    try {
      const [metaRaw, binBuf] = await Promise.all([
        readFile(this.metaPath, 'utf8'),
        readFile(this.binPath),
      ]);
      const meta = JSON.parse(metaRaw);
      if (
        !meta ||
        meta.version !== BIN_VERSION ||
        !Array.isArray(meta.items) ||
        !Number.isInteger(meta.dimensions) ||
        meta.dimensions <= 0
      ) {
        this.reset(expectedModelId, 0);
        return;
      }
      if (expectedModelId && meta.modelId !== expectedModelId) {
        this.reset(expectedModelId, 0);
        return;
      }
      if (
        binBuf.length < BIN_HEADER_BYTES ||
        !binBuf.subarray(0, 4).equals(BIN_MAGIC) ||
        binBuf.readUInt32LE(4) !== BIN_VERSION
      ) {
        this.reset(expectedModelId, 0);
        return;
      }
      const dim = binBuf.readUInt32LE(8);
      const count = binBuf.readUInt32LE(12);
      if (dim < 1 || dim > MAX_BIN_DIM || count > MAX_BIN_COUNT) {
        this.reset(expectedModelId, 0);
        return;
      }
      const expectedBytes = BIN_HEADER_BYTES + count * dim;
      if (dim !== meta.dimensions || count !== meta.items.length || binBuf.length !== expectedBytes) {
        this.reset(expectedModelId, 0);
        return;
      }
      this.modelId = meta.modelId || expectedModelId;
      this.dimensions = dim;
      this.entries = meta.items;
      this.keyToIdx = new Map();
      this.parentKeys = new Set();
      for (let i = 0; i < this.entries.length; i += 1) {
        this.keyToIdx.set(this.entries[i].key, i);
        this.parentKeys.add(`${this.entries[i].kind}\0${this.entries[i].parentId}`);
      }
      this.vectors = new Int8Array(count * dim);
      this.vectors.set(new Int8Array(binBuf.buffer, binBuf.byteOffset + BIN_HEADER_BYTES, count * dim));
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        // Corrupt/unreadable cache: rebuild safely from source of truth.
      }
      this.reset(expectedModelId, 0);
    }
  }

  reset(modelId, dimensions = 0) {
    this.modelId = modelId || null;
    this.dimensions = dimensions;
    this.entries = [];
    this.keyToIdx = new Map();
    this.parentKeys = new Set();
    this.vectors = new Int8Array(0);
    this.dirty = true;
  }

  hasParent(kind, parentId) {
    return this.parentKeys.has(`${kind}\0${parentId}`);
  }

  getFingerprints() {
    const out = new Map();
    for (const e of this.entries) out.set(e.key, e.fingerprint);
    return out;
  }

  upsertBatch(modelId, items) {
    if (!Array.isArray(items) || items.length === 0) return;
    const dim = items[0].vector.length;
    if (!dim) return;
    if (this.modelId && this.modelId !== modelId) {
      this.reset(modelId, dim);
    }
    if (this.dimensions && this.dimensions !== dim) {
      this.reset(modelId, dim);
    }
    this.modelId = modelId;
    this.dimensions = dim;

    const toAppend = [];
    for (const item of items) {
      const q = item.vector instanceof Int8Array ? item.vector : quantizeInt8(item.vector);
      const existingIdx = this.keyToIdx.get(item.key);
      if (existingIdx !== undefined) {
        this.entries[existingIdx] = {
          key: item.key,
          kind: item.kind,
          parentId: item.parentId,
          slot: item.slot,
          fingerprint: item.fingerprint,
        };
        this.parentKeys.add(`${item.kind}\0${item.parentId}`);
        this.vectors.set(q, existingIdx * dim);
      } else {
        toAppend.push({ item, q });
      }
    }

    if (toAppend.length > 0) {
      const prevCount = this.entries.length;
      const nextCount = prevCount + toAppend.length;
      const nextBuf = new Int8Array(nextCount * dim);
      if (prevCount > 0) nextBuf.set(this.vectors.subarray(0, prevCount * dim), 0);
      for (let i = 0; i < toAppend.length; i += 1) {
        const { item, q } = toAppend[i];
        const idx = prevCount + i;
        this.entries.push({
          key: item.key,
          kind: item.kind,
          parentId: item.parentId,
          slot: item.slot,
          fingerprint: item.fingerprint,
        });
        this.keyToIdx.set(item.key, idx);
        this.parentKeys.add(`${item.kind}\0${item.parentId}`);
        nextBuf.set(q, idx * dim);
      }
      this.vectors = nextBuf;
    }
    this.dirty = true;
  }

  pruneKeys(keepKeys) {
    if (this.entries.length === 0) return 0;
    let removed = 0;
    for (const e of this.entries) {
      if (!keepKeys.has(e.key)) removed += 1;
    }
    if (removed === 0) return 0;
    const dim = this.dimensions;
    const nextEntries = [];
    const nextMap = new Map();
    const nextParents = new Set();
    const nextBuf = new Int8Array((this.entries.length - removed) * dim);
    for (let i = 0; i < this.entries.length; i += 1) {
      const e = this.entries[i];
      if (!keepKeys.has(e.key)) continue;
      const nextIdx = nextEntries.length;
      nextEntries.push(e);
      nextMap.set(e.key, nextIdx);
      nextParents.add(`${e.kind}\0${e.parentId}`);
      nextBuf.set(this.vectors.subarray(i * dim, (i + 1) * dim), nextIdx * dim);
    }
    this.entries = nextEntries;
    this.keyToIdx = nextMap;
    this.parentKeys = nextParents;
    this.vectors = nextBuf;
    this.dirty = true;
    return removed;
  }

  scoreByKind(kind, queryF32, allowedParentIds = null) {
    const dim = this.dimensions;
    const out = new Map(); // parentId -> { desc, bestCatEx, bestLearnEx, hasDesc, hasCatEx, hasLearnEx }
    if (!dim || queryF32.length !== dim || this.entries.length === 0) return out;
    const q = l2Normalize(queryF32);
    for (let i = 0; i < this.entries.length; i += 1) {
      const e = this.entries[i];
      if (e.kind !== kind) continue;
      if (allowedParentIds && !allowedParentIds.has(e.parentId)) continue;
      const sim = dotInt8Float32(this.vectors, i * dim, q, dim);
      let rec = out.get(e.parentId);
      if (!rec) {
        rec = { desc: -1, bestCatEx: -1, bestLearnEx: -1, hasDesc: false, hasCatEx: false, hasLearnEx: false };
        out.set(e.parentId, rec);
      }
      if (e.slot === 'desc') {
        rec.desc = sim;
        rec.hasDesc = true;
      } else if (typeof e.slot === 'string' && e.slot.startsWith('ex:learn:')) {
        if (!rec.hasLearnEx || sim > rec.bestLearnEx) rec.bestLearnEx = sim;
        rec.hasLearnEx = true;
      } else if (typeof e.slot === 'string' && e.slot.startsWith('body:')) {
        if (!rec.hasBody || sim > rec.bestBody) rec.bestBody = sim;
        rec.hasBody = true;
      } else {
        if (!rec.hasCatEx || sim > rec.bestCatEx) rec.bestCatEx = sim;
        rec.hasCatEx = true;
      }
    }
    return out;
  }

  scoreByKindMulti(kind, queryF32List, allowedParentIds = null) {
    const kCount = Array.isArray(queryF32List) ? queryF32List.length : 0;
    const maps = Array.from({ length: kCount }, () => new Map());
    const dim = this.dimensions;
    if (!dim || kCount === 0 || this.entries.length === 0) return maps;
    const normQs = queryF32List.map((v) => (v && v.length === dim ? l2Normalize(v) : null));
    for (let i = 0; i < this.entries.length; i += 1) {
      const e = this.entries[i];
      if (e.kind !== kind) continue;
      if (allowedParentIds && !allowedParentIds.has(e.parentId)) continue;
      const offset = i * dim;
      const isDesc = e.slot === 'desc';
      const isLearn = !isDesc && typeof e.slot === 'string' && e.slot.startsWith('ex:learn:');
      const isBody = !isDesc && !isLearn && typeof e.slot === 'string' && e.slot.startsWith('body:');
      for (let qi = 0; qi < kCount; qi += 1) {
        const q = normQs[qi];
        if (!q) continue;
        const sim = dotInt8Float32(this.vectors, offset, q, dim);
        const out = maps[qi];
        let rec = out.get(e.parentId);
        if (!rec) {
          rec = { desc: -1, bestCatEx: -1, bestLearnEx: -1, hasDesc: false, hasCatEx: false, hasLearnEx: false };
          out.set(e.parentId, rec);
        }
        if (isDesc) {
          rec.desc = sim;
          rec.hasDesc = true;
        } else if (isLearn) {
          if (!rec.hasLearnEx || sim > rec.bestLearnEx) rec.bestLearnEx = sim;
          rec.hasLearnEx = true;
        } else if (isBody) {
          if (!rec.hasBody || sim > rec.bestBody) rec.bestBody = sim;
          rec.hasBody = true;
        } else {
          if (!rec.hasCatEx || sim > rec.bestCatEx) rec.bestCatEx = sim;
          rec.hasCatEx = true;
        }
      }
    }
    return maps;
  }

  maxCosineAgainstParent(kind, parentId, queryF32, { organicOnly = false } = {}) {
    const dim = this.dimensions;
    if (!dim || queryF32.length !== dim) return -1;
    const q = l2Normalize(queryF32);
    let best = -1;
    for (let i = 0; i < this.entries.length; i += 1) {
      const e = this.entries[i];
      if (e.kind !== kind || e.parentId !== parentId) continue;
      if (organicOnly && typeof e.slot === 'string' && e.slot.startsWith('ex:learn:')) continue;
      const sim = dotInt8Float32(this.vectors, i * dim, q, dim);
      if (sim > best) best = sim;
    }
    return best;
  }

  async flush() {
    if (!this.dirty || !this.binPath || !this.metaPath) return;
    return this._writeQueue(async () => {
      if (!this.dirty) return;
      const count = this.entries.length;
      const dim = this.dimensions;
      const header = Buffer.alloc(BIN_HEADER_BYTES);
      BIN_MAGIC.copy(header, 0);
      header.writeUInt32LE(BIN_VERSION, 4);
      header.writeUInt32LE(dim, 8);
      header.writeUInt32LE(count, 12);
      const body = Buffer.from(this.vectors.buffer, this.vectors.byteOffset, count * dim);
      const fullBin = Buffer.concat([header, body]);
      const meta = JSON.stringify({
        version: BIN_VERSION,
        modelId: this.modelId,
        dimensions: dim,
        items: this.entries,
      });
      await atomicWriteFile(this.binPath, fullBin, { mode: 0o600, fsync: false });
      await atomicWriteFile(this.metaPath, meta, { mode: 0o600, fsync: false });
      this.dirty = false;
    });
  }

  stats() {
    const counts = { tool: 0, skill: 0, connection: 0, memory: 0 };
    for (const e of this.entries) {
      if (Object.hasOwn(counts, e.kind)) counts[e.kind] += 1;
    }
    return {
      backend: 'local-binary',
      modelId: this.modelId,
      dimensions: this.dimensions,
      vectorCount: this.entries.length,
      vectorBytes: this.vectors.byteLength,
      counts,
    };
  }
}

/* ---------------- Scoring Helpers ---------------- */

function combineDescAndExampleDetail(rec) {
  if (!rec) return { score: -1, organic: -1 };
  const desc = rec.hasDesc ? rec.desc : -1;
  const catEx = rec.hasCatEx ? rec.bestCatEx : -1;
  const learnEx = rec.hasLearnEx ? rec.bestLearnEx : -1;

  // Curated catalog examples receive full multi-view MaxSim weight with light description corroboration.
  let organic;
  if (rec.hasDesc && rec.hasCatEx) {
    organic = 0.1 * desc + 0.9 * Math.max(desc, catEx);
  } else if (rec.hasDesc) {
    organic = desc;
  } else if (rec.hasCatEx) {
    organic = catEx;
  } else {
    organic = -1;
  }

  // Behavioral learned examples (user history) act as a bounded lift so private tools improve
  // without ever locking out a genuinely better newly installed tool (never scores > 0.70 or > desc + 0.18).
  let score = organic;
  if (rec.hasLearnEx) {
    const learnLift = rec.hasDesc
      ? Math.min(0.45 * desc + 0.55 * learnEx, desc + 0.18, 0.70)
      : Math.min(learnEx, 0.70);
    if (learnLift > score) score = learnLift;
  }
  return { score, organic: organic >= 0 ? organic : score };
}

function combineDescAndExampleSim(rec) {
  return combineDescAndExampleDetail(rec).score;
}

// Spam-proof structured-identifier corroboration for Tier 2 semantic ranking:
// inspects ONLY the concise tool name (first 6 tokens) and Connection name/id (first 4 tokens),
// NEVER prose descriptions — so keyword-stuffed descriptions receive strictly 0 boost.
function computeStructuredIdCorroboration(candidate, queryStems) {
  if (!queryStems || queryStems.length === 0) return { bonus: 0, toolHits: 0, connHits: 0 };
  const bag = getTier1ToolBag(candidate);
  let toolHits = 0;
  let connHits = 0;
  for (let i = 0; i < queryStems.length; i += 1) {
    const qt = queryStems[i];
    if (qt.length < 3) continue;
    let hitT = bag.toolStemSet.has(qt);
    if (!hitT && qt.length >= 5) {
      const maxD = qt.length >= 9 ? 2 : 1;
      for (const tok of bag.toolStemCap) {
        if (tok.length >= 4 && boundedEditDistance(qt, tok, maxD) <= maxD) {
          hitT = true;
          break;
        }
      }
    }
    if (hitT) toolHits += 1;

    let hitC = bag.connStemSet.has(qt);
    if (!hitC && qt.length >= 5) {
      const maxD = qt.length >= 9 ? 2 : 1;
      for (const tok of bag.connStemCap) {
        if (tok.length >= 4 && boundedEditDistance(qt, tok, maxD) <= maxD) {
          hitC = true;
          break;
        }
      }
    }
    if (hitC) connHits += 1;
  }
  const dualField = connHits > 0 && toolHits > 0;
  const toolBonus = Math.min(dualField ? 0.06 : 0.055, toolHits * 0.032);
  const connBonus = connHits > 0 ? (dualField ? 0.04 : 0.025) : 0;
  return { bonus: toolBonus + connBonus, toolHits, connHits };
}

function gatedStructuredIdBonus(candidate, queryStems, baseScore, softMinScore) {
  if (baseScore < softMinScore - 0.12) return 0;
  const corr = computeStructuredIdCorroboration(candidate, queryStems);
  if (corr.bonus <= 0) return 0;
  // Dual-field corroboration (query named BOTH the Connection AND the tool action, even with a typo)
  // is structurally specific and safe down to softMinScore - 0.12; single-field requires >= softMinScore - 0.05.
  if (corr.connHits > 0 && corr.toolHits > 0) return corr.bonus;
  return baseScore >= softMinScore - 0.05 ? corr.bonus : 0;
}

// Detect genuine cross-Connection ambiguity (e.g., create_issue across GitHub, Linear, Jira,
// or execute_sql across two Supabase accounts) when the user's query did not name a specific Connection.
function detectCrossConnectionAmbiguity(rankedEntries, queryTokens, { isSemantic = true, connFilter = '' } = {}) {
  if (connFilter || !Array.isArray(rankedEntries) || rankedEntries.length < 2) {
    return { ambiguous: false, ambiguousConnections: [] };
  }
  const lead = rankedEntries[0];
  const leadScore = typeof lead.score === 'number' ? lead.score : 0;
  const leadItem = lead.item;
  if (!leadItem || leadScore <= 0) return { ambiguous: false, ambiguousConnections: [] };

  const qStems = [...new Set(queryTokens.map((t) => stemToken(t)).filter((t) => t.length >= 3))];
  const mentionsConn = (item) => {
    const bag = getTier1ToolBag(item);
    for (const qt of qStems) {
      if (bag.connStemSet.has(qt)) return true;
      if (qt.length >= 5) {
        for (const ct of bag.connStemCap) {
          if (ct.length >= 4 && boundedEditDistance(qt, ct, 1) <= 1) return true;
        }
      }
    }
    return false;
  };

  // If the query explicitly names the top Connection, it is contextual — not ambiguous.
  if (mentionsConn(leadItem)) {
    return { ambiguous: false, ambiguousConnections: [] };
  }

  const sameNameDelta = isSemantic ? 0.06 : leadScore * 0.15;
  const sameNameConns = new Map();
  sameNameConns.set(leadItem.connId, leadItem.connName || leadItem.connId);

  const leadBare = String(leadItem.toolName || '').toLowerCase();
  for (let i = 1; i < Math.min(rankedEntries.length, 8); i += 1) {
    const cand = rankedEntries[i];
    if (!cand?.item) continue;
    if (leadScore - cand.score > sameNameDelta) break;
    if (cand.item.connId === leadItem.connId) continue;
    if (String(cand.item.toolName || '').toLowerCase() === leadBare) {
      if (mentionsConn(cand.item)) return { ambiguous: false, ambiguousConnections: [] };
      sameNameConns.set(cand.item.connId, cand.item.connName || cand.item.connId);
    }
  }

  if (sameNameConns.size >= 2) {
    return { ambiguous: true, ambiguousConnections: [...sameNameConns.values()] };
  }
  return { ambiguous: false, ambiguousConnections: [] };
}

const TIER1_BAG_CACHE = new WeakMap();

function getTier1ToolBag(candidate) {
  const cacheTarget =
    candidate && typeof candidate === 'object'
      ? candidate.toolRef && typeof candidate.toolRef === 'object'
        ? candidate.toolRef
        : candidate
      : null;
  if (cacheTarget) {
    const cached = TIER1_BAG_CACHE.get(cacheTarget);
    if (
      cached &&
      cached.fullToolName === candidate.fullToolName &&
      cached.connName === candidate.connName
    ) {
      return cached;
    }
  }
  const fullLower = String(candidate.fullToolName || '').toLowerCase();
  const toolLower = String(candidate.toolName || '').toLowerCase();
  const connIdLower = String(candidate.connId || '').toLowerCase();
  const connNameLower = String(candidate.connName || '').toLowerCase();
  const compoundParams = new Set();
  const paramKeys = Array.isArray(candidate.paramKeys) ? candidate.paramKeys : [];
  for (let i = 0; i < paramKeys.length; i += 1) {
    const rawKey = String(paramKeys[i] || '');
    if (COMPOUND_PARAM_KEY_RE.test(rawKey)) compoundParams.add(rawKey.toLowerCase());
  }
  const toolRawToks = splitIdentifiers(candidate.toolName);
  const connRawToks = [...splitIdentifiers(candidate.connId), ...splitIdentifiers(candidate.connName)];
  const toolIdTokens = new Set(toolRawToks);
  const combinedIdTokens = new Set([...toolIdTokens, ...connRawToks]);
  const toolStemCap = [...new Set(toolRawToks.slice(0, 6).map((t) => stemToken(t)).filter(Boolean))];
  const connStemCap = [...new Set(connRawToks.slice(0, 4).map((t) => stemToken(t)).filter(Boolean))];
  const bag = {
    fullToolName: candidate.fullToolName,
    connName: candidate.connName,
    fullLower,
    toolLower,
    connIdLower,
    connNameLower,
    compoundParams,
    toolIdTokens,
    combinedIdTokens,
    toolStemCap,
    connStemCap,
    toolStemSet: new Set(toolStemCap),
    connStemSet: new Set(connStemCap),
  };
  if (cacheTarget) TIER1_BAG_CACHE.set(cacheTarget, bag);
  return bag;
}

// A literal lookup is not a relevance prediction. Keep the relative order of other hits,
// including model-ranked ties between multiple tools from the same named connection.
function pinExactNames(result, priorities) {
  if (!priorities.size) return result.ranked;
  const priority = priorities instanceof Map ? id => priorities.get(id) || 0 : id => Number(priorities.has(id));
  const ranked = result.ranked.sort((a, b) => priority(b.id) - priority(a.id));
  if (result.reranked) result.topRr = ranked[0]?.rr ?? null;
  return ranked;
}

function scoreTier1ExactTool(candidate, queryLower, queryTokens) {
  const bag = getTier1ToolBag(candidate);

  if (bag.fullLower === queryLower) return { score: 1000, exactStructural: true, namePriority: 3 };
  if (bag.toolLower === queryLower) return { score: 920, exactStructural: true, namePriority: 2 };
  if (bag.connIdLower === queryLower || bag.connNameLower === queryLower) return { score: 910, exactStructural: true, namePriority: 1 };

  // Exact compound technical parameter key match (e.g. "deployment_id", "org_slug", "invoiceId") —
  // requires snake_case / kebab-case / camelCase boundary so generic words like "email" or "query" never hijack Tier 1.
  if (bag.compoundParams.size > 0 && bag.compoundParams.has(queryLower)) {
    return { score: 840, exactStructural: true };
  }

  if (queryTokens.length === 0) return { score: 0, exactStructural: false };

  let inTool = 0;
  let inCombined = 0;
  for (let i = 0; i < queryTokens.length; i += 1) {
    const t = queryTokens[i];
    if (bag.toolIdTokens.has(t)) inTool += 1;
    if (bag.combinedIdTokens.has(t)) inCombined += 1;
  }

  // Only qualify as Tier 1 exact identifier match if ALL query tokens match structured names
  // (never description prose — blocks keyword-stuffed tool descriptions from hijacking Tier 1!).
  if (inTool === queryTokens.length) {
    return { score: 860 + Math.min(40, queryTokens.length * 10), exactStructural: false };
  }
  if (inCombined === queryTokens.length && (inTool > 0 || queryTokens.length >= 1)) {
    return { score: 760 + inTool * 20, exactStructural: false };
  }
  return { score: 0, exactStructural: false };
}

const LEXICAL_BAG_CACHE = new WeakMap();

function countStemFreqs(tokens) {
  const map = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    map.set(t, (map.get(t) || 0) + 1);
  }
  return map;
}

function getLexicalToolBag(candidate) {
  const cacheTarget =
    candidate && typeof candidate === 'object'
      ? candidate.toolRef && typeof candidate.toolRef === 'object'
        ? candidate.toolRef
        : candidate
      : null;
  const descRaw = String(candidate.description || '');
  const connDescRaw = String(candidate.connDescription || '');
  const secRaw = `${candidate.serverInstructions || ''} ${candidate.brief || ''} ${candidate.matchedSkillDescription || ''}`;
  const fullLower = String(candidate.fullToolName || '').toLowerCase();
  const nameLower = String(candidate.toolName || '').toLowerCase();
  const descLower = descRaw.toLowerCase();
  const paramLower = String(candidate.paramText || '').toLowerCase();
  const connLower = `${candidate.connId || ''} ${candidate.connName || ''} ${connDescRaw} ${candidate.categoryId || ''} ${candidate.categoryLabel || ''}`.toLowerCase();
  const secondaryLower = secRaw.toLowerCase();

  const cached = cacheTarget && LEXICAL_BAG_CACHE.get(cacheTarget);
  if (cached && cached.fullLower === fullLower && cached.nameLower === nameLower && cached.descLower === descLower &&
      cached.paramLower === paramLower && cached.connLower === connLower && cached.secondaryLower === secondaryLower) {
    return cached;
  }

  const nameToks = tokenizeStemmed(`${fullLower} ${nameLower}`);
  const descToks = tokenizeStemmed(descLower);
  const paramToks = tokenizeStemmed(paramLower);
  const connToks = tokenizeStemmed(connLower);
  const secToks = secondaryLower.trim() ? tokenizeStemmed(secondaryLower) : [];

  const bag = {
    fullLower,
    nameLower,
    descLower,
    paramLower,
    connLower,
    secondaryLower,
    nameFreq: countStemFreqs(nameToks),
    descFreq: countStemFreqs(descToks),
    paramFreq: countStemFreqs(paramToks),
    connFreq: countStemFreqs(connToks),
    secFreq: countStemFreqs(secToks),
    descLen: Math.max(1, descToks.length),
    secLen: Math.max(1, secToks.length),
    coreSet: new Set([...nameToks, ...descToks, ...connToks]),
    primarySet: new Set([...nameToks, ...descToks, ...paramToks, ...connToks]),
    secSet: new Set(secToks),
  };
  if (cacheTarget) {
    LEXICAL_BAG_CACHE.set(cacheTarget, bag);
  }
  return bag;
}

function hasPrefixInSet(tokenSet, prefix, { minPrefixLen = 5 } = {}) {
  if (prefix.length < minPrefixLen) return false;
  for (const tok of tokenSet) {
    if (tok.length > prefix.length && tok.startsWith(prefix)) return true;
  }
  return false;
}

function hasFuzzyInSet(tokenSet, queryStem, memo = null) {
  if (queryStem.length < 5) return false;
  const maxD = queryStem.length >= 9 ? 2 : 1;
  for (const tok of tokenSet) {
    if (tok.length < 4) continue;
    if (Math.abs(tok.length - queryStem.length) > maxD) continue;
    if (memo) {
      let hit = memo.get(tok);
      if (hit === undefined) {
        hit = boundedEditDistance(queryStem, tok, maxD) <= maxD;
        memo.set(tok, hit);
      }
      if (hit) return true;
    } else if (boundedEditDistance(queryStem, tok, maxD) <= maxD) {
      return true;
    }
  }
  return false;
}

function scoreLexicalFallbackTool(candidate, queryLower, queryTokens, learnedExamples = []) {
  const bag = getLexicalToolBag(candidate);
  const exLower = learnedExamples.length > 0 ? learnedExamples.join(' \n ').toLowerCase() : '';
  const exSet = exLower ? new Set(tokenizeStemmed(exLower)) : null;

  if (exLower && exLower.includes(queryLower)) return { score: 260, mode: 'strict' };
  if (bag.fullLower.includes(queryLower) || bag.nameLower.includes(queryLower)) return { score: 240, mode: 'strict' };
  if (bag.descLower.includes(queryLower)) return { score: 200, mode: 'strict' };
  if (bag.paramLower.includes(queryLower)) return { score: 175, mode: 'strict' };
  if (bag.connLower.includes(queryLower)) return { score: 145, mode: 'strict' };

  const qStems = [...new Set(queryTokens.map((t) => stemToken(t)).filter(Boolean))];
  if (qStems.length > 0) {
    let primaryMatched = 0;
    let weighted = 110;
    for (const qt of qStems) {
      if (bag.nameFreq.has(qt)) {
        primaryMatched += 1;
        weighted += 26;
      } else if (exSet?.has(qt)) {
        primaryMatched += 1;
        weighted += 24;
      } else if (bag.descFreq.has(qt)) {
        primaryMatched += 1;
        weighted += 16;
      } else if (bag.paramFreq.has(qt)) {
        primaryMatched += 1;
        weighted += 14;
      } else if (bag.connFreq.has(qt)) {
        primaryMatched += 1;
        weighted += 10;
      } else if (hasPrefixInSet(bag.primarySet, qt) || (exSet && hasPrefixInSet(exSet, qt))) {
        primaryMatched += 1;
        weighted += 9;
      }
    }
    if (primaryMatched === qStems.length) {
      return { score: weighted, mode: 'strict' };
    }
  }

  if (bag.secondaryLower) {
    if (bag.secondaryLower.includes(queryLower)) return { score: 95, mode: 'strict' };
    if (
      qStems.length > 0 &&
      qStems.every((qt) => bag.primarySet.has(qt) || exSet?.has(qt) || bag.secSet.has(qt))
    ) {
      return { score: 75 + qStems.length * 6, mode: 'strict' };
    }
  }
  return { score: 0, mode: 'none' };
}

function scoreLexicalToolsBM25F(list, tier1Ids, queryLower, queryTokens, getExamplesForCandidate, { semanticRescue = false } = {}) {
  const N = list.length;
  if (N === 0) return { strict: [], partial: [] };

  const qStems = [...new Set(queryTokens.map((t) => stemToken(t)).filter(Boolean))];
  const qLen = qStems.length;
  const sigStems = qStems.filter((t) => t.length >= 3);
  const allowShortPrefix = qLen === 1;
  const minPrefixLen = allowShortPrefix ? 3 : 5;
  const phraseRe =
    queryLower.length >= 3
      ? new RegExp(`(?:^|[^\\p{L}\\p{N}])${queryLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\p{L}\\p{N}])`, 'u')
      : null;

  const matchedSet = new Set();
  const matchedDocs = [];
  const allBags = new Array(N);
  let docCount = 0;
  let sumDescLen = 0;
  let sumSecLen = 0;
  const df = new Int32Array(qLen);

  // Pass 1: O(N * |query|) fast Set.has() DF count & candidate filter.
  for (let i = 0; i < N; i += 1) {
    const c = list[i];
    if (tier1Ids.has(c.fullToolName)) continue;
    docCount += 1;
    const bag = getLexicalToolBag(c);
    sumDescLen += bag.descLen;
    sumSecLen += bag.secLen;

    const examples = getExamplesForCandidate(c);
    let exLower = '';
    let exFreq = null;
    let exSet = null;
    if (examples.length > 0) {
      exLower = examples.join(' \n ').toLowerCase();
      const exToks = tokenizeStemmed(exLower);
      if (exToks.length > 0) {
        exFreq = countStemFreqs(exToks);
        exSet = new Set(exToks);
      }
    }
    const entry = { item: c, idx: i, bag, exLower, exFreq, exSet };
    allBags[i] = entry;

    let anyOverlap = qLen === 0;
    for (let j = 0; j < qLen; j += 1) {
      const qt = qStems[j];
      if (bag.primarySet.has(qt) || exSet?.has(qt) || bag.secSet.has(qt)) {
        df[j] += 1;
        anyOverlap = true;
      } else if (
        !anyOverlap &&
        qt.length >= minPrefixLen &&
        (hasPrefixInSet(bag.primarySet, qt, { minPrefixLen }) ||
          (exSet ? hasPrefixInSet(exSet, qt, { minPrefixLen }) : false) ||
          hasPrefixInSet(bag.secSet, qt, { minPrefixLen }))
      ) {
        anyOverlap = true;
      }
    }
    if (anyOverlap) {
      matchedDocs.push(entry);
      matchedSet.add(i);
    }
  }

  // Zero-overhead typo recovery: ONLY query stems with df === 0 (misspelled / OOV words, len >= 5)
  // trigger bounded Damerau-Levenshtein matching, memoized per unique corpus token so 5,000 tools stay <2 ms.
  const fuzzyStemIndices = [];
  const fuzzyMemoByStem = new Map();
  for (let j = 0; j < qLen; j += 1) {
    if (df[j] === 0 && qStems[j].length >= 5) {
      fuzzyStemIndices.push(j);
      fuzzyMemoByStem.set(j, new Map());
    }
  }
  if (fuzzyStemIndices.length > 0) {
    for (let i = 0; i < N; i += 1) {
      const entry = allBags[i];
      if (!entry) continue;
      let hitFuzzy = false;
      for (let f = 0; f < fuzzyStemIndices.length; f += 1) {
        const j = fuzzyStemIndices[f];
        const qt = qStems[j];
        const memo = fuzzyMemoByStem.get(j);
        if (hasFuzzyInSet(entry.bag.coreSet, qt, memo) || (entry.exSet && hasFuzzyInSet(entry.exSet, qt, memo))) {
          df[j] += 1;
          hitFuzzy = true;
        }
      }
      if (hitFuzzy && !matchedSet.has(i)) {
        matchedDocs.push(entry);
        matchedSet.add(i);
      }
    }
  }

  if (matchedDocs.length === 0) return { strict: [], partial: [] };

  const denomDocs = Math.max(1, docCount);
  const avgDescLen = Math.max(6, sumDescLen / denomDocs);
  const avgSecLen = Math.max(10, sumSecLen / denomDocs);
  const bloatDescLen = Math.max(26, avgDescLen * 2.2);
  const idfArr = new Float64Array(qLen);
  const isFuzzyStem = new Uint8Array(qLen);
  for (const j of fuzzyStemIndices) isFuzzyStem[j] = 1;
  let totalQueryIdf = 0;
  for (let j = 0; j < qLen; j += 1) {
    const freq = df[j];
    const idf = Math.log(1 + (denomDocs - freq + 0.5) / (freq + 0.5));
    idfArr[j] = idf;
    totalQueryIdf += idf;
  }

  const K1 = 1.2;
  const B_DESC = 0.75;
  const B_SEC = 0.6;
  const strict = [];
  const partial = [];

  // Pass 2: Score ONLY the matched candidates (typically <5% of a 5,000-tool workspace!).
  for (let d = 0; d < matchedDocs.length; d += 1) {
    const { item, idx, bag, exLower, exFreq, exSet } = matchedDocs[d];
    const isBloatedDesc = bag.descLen > bloatDescLen;
    let descNorm = 1 - B_DESC + B_DESC * (bag.descLen / avgDescLen);
    if (isBloatedDesc) {
      // Super-linear length normalization penalizes bloated keyword-stuffed laundry lists
      // without touching concise real MCP tool descriptions (<= ~26 words).
      descNorm *= Math.pow(bag.descLen / bloatDescLen, 1.65);
    }
    const secNorm = 1 - B_SEC + B_SEC * (bag.secLen / avgSecLen);

    let bm25 = 0;
    let matchedIdf = 0;
    let primaryExactHits = 0;
    let coreExactHits = 0;
    let structHits = 0;
    let toolOwnHits = 0;
    let significantOwnExactHits = 0;
    let anyPrimaryHits = 0;
    let anyFieldHits = 0;
    let sigExactHits = 0;
    let prefixOnlyHits = 0;

    for (let j = 0; j < qLen; j += 1) {
      const qt = qStems[j];
      const idf = idfArr[j];
      const tfName = bag.nameFreq.get(qt) || 0;
      const tfEx = exFreq ? exFreq.get(qt) || 0 : 0;
      const tfDesc = bag.descFreq.get(qt) || 0;
      const tfParam = bag.paramFreq.get(qt) || 0;
      const tfConn = bag.connFreq.get(qt) || 0;
      const tfSec = bag.secFreq.get(qt) || 0;

      let weightedTf =
        tfName * 3.2 +
        tfEx * 2.8 +
        (tfDesc * 1.8) / descNorm +
        tfParam * 1.6 +
        tfConn * 1.2 +
        (tfSec * 0.65) / secNorm;

      // nameFreq includes the qualified name; a connection prefix alone isn't tool evidence.
      if (qt.length >= 3 && (tfDesc || tfEx || tfParam || (tfName && !tfConn))) significantOwnExactHits += 1;
      let hitToolOwn = tfName > 0 || tfEx > 0 || tfDesc > 0 || tfParam > 0;
      let hitStruct = tfName > 0 || tfEx > 0 || tfParam > 0 || tfConn > 0;
      let hitCoreExact = tfName > 0 || tfEx > 0 || tfDesc > 0 || tfConn > 0;
      let hitPrimaryExact = hitCoreExact || tfParam > 0;
      let hitPrimary = hitPrimaryExact;
      let hitAny = hitPrimaryExact || tfSec > 0;

      if (!hitAny && isFuzzyStem[j]) {
        const memo = fuzzyMemoByStem.get(j);
        const fName = hasFuzzyInSet(bag.nameFreq.keys(), qt, memo);
        const fDesc = !fName && hasFuzzyInSet(bag.descFreq.keys(), qt, memo);
        const fConn = !fName && !fDesc && hasFuzzyInSet(bag.connFreq.keys(), qt, memo);
        const fEx = !fName && !fDesc && !fConn && exSet && hasFuzzyInSet(exSet, qt, memo);
        if (fName || fDesc || fConn || fEx) {
          weightedTf += fName ? 2.2 : fEx ? 2.0 : fDesc ? 1.3 / descNorm : 0.85;
          if (fName || fDesc || fEx) hitToolOwn = true;
          if (fName || fConn || fEx) hitStruct = true;
          hitCoreExact = true;
          hitPrimaryExact = true;
          hitPrimary = true;
          hitAny = true;
        }
      }

      if (!hitAny && qt.length >= minPrefixLen) {
        const pPrimary =
          hasPrefixInSet(bag.primarySet, qt, { minPrefixLen }) ||
          (exSet ? hasPrefixInSet(exSet, qt, { minPrefixLen }) : false);
        const pSec = !pPrimary && hasPrefixInSet(bag.secSet, qt, { minPrefixLen });
        if (pPrimary) {
          weightedTf += 0.9 / descNorm;
          hitPrimary = true;
          hitAny = true;
          prefixOnlyHits += 1;
        } else if (pSec) {
          weightedTf += 0.35 / secNorm;
          hitAny = true;
          prefixOnlyHits += 1;
        }
      }

      if (hitAny && weightedTf > 0) {
        const sat = (weightedTf * (K1 + 1)) / (weightedTf + K1);
        bm25 += idf * sat;
        matchedIdf += idf;
        anyFieldHits += 1;
        if (hitToolOwn) toolOwnHits += 1;
        if (hitStruct) structHits += 1;
        if (hitCoreExact) coreExactHits += 1;
        if (hitPrimaryExact) primaryExactHits += 1;
        if (hitPrimary) anyPrimaryHits += 1;
        if (qt.length >= 3 && (hitPrimaryExact || tfSec > 0)) sigExactHits += 1;
      }
    }

    const allInPrimary = qLen > 0 && anyPrimaryHits === qLen;
    const allInAny = qLen > 0 && anyFieldHits === qLen;

    // Only run whole-word exact phrase regex when every query stem already matched (skips >99% of regex work at 5,000 tools!)
    let phraseBonus = 0;
    let phraseHitPrimary = false;
    let phraseHitSecondary = false;
    if (allInAny || qLen === 0) {
      const matchPhrase = (hay) => (phraseRe ? phraseRe.test(hay) : hay.includes(queryLower));
      if (exLower && matchPhrase(exLower)) {
        phraseBonus = 120;
        phraseHitPrimary = true;
      } else if (matchPhrase(bag.fullLower) || matchPhrase(bag.nameLower)) {
        phraseBonus = 110;
        phraseHitPrimary = true;
      } else if (matchPhrase(bag.descLower)) {
        phraseBonus = 85 / descNorm;
        phraseHitPrimary = true;
      } else if (matchPhrase(bag.paramLower)) {
        phraseBonus = 75;
        phraseHitPrimary = true;
      } else if (matchPhrase(bag.connLower)) {
        phraseBonus = 55;
        phraseHitPrimary = true;
      } else if (bag.secondaryLower && matchPhrase(bag.secondaryLower)) {
        phraseBonus = 40 / secNorm;
        phraseHitSecondary = true;
      }
    }

    if (phraseBonus === 0 && bm25 === 0) continue;
    const idfCoverage = totalQueryIdf > 0 ? matchedIdf / totalQueryIdf : 1;
    const isBloatedDescOnly = isBloatedDesc && structHits === 0;
    // In semantic Tier 3 rescue, a bloated (>26-word) prose-only match with zero identifier/param overlap
    // and sub-floor semantic similarity is classic keyword-stuffing — never let it hijack rescue results.
    if (semanticRescue && isBloatedDescOnly && !phraseHitPrimary) continue;

    // On multi-word queries, a tool whose own name/description/params have zero overlap and only matched
    // via inherited connection metadata should never outrank tools that matched directly.
    const isConnOnlyPartial = qLen >= 2 && toolOwnHits === 0 && !phraseHitPrimary;
    const rawScore = bm25 * (0.45 + 0.55 * idfCoverage) + phraseBonus;
    const score = isBloatedDescOnly ? rawScore * 0.25 : isConnOnlyPartial ? rawScore * 0.45 : rawScore;

    if (!isBloatedDescOnly && (phraseHitPrimary || phraseHitSecondary || allInPrimary || allInAny)) {
      const strictBonus = primaryExactHits === qLen ? 30 : allInPrimary ? 15 : 0;
      strict.push({ item, score: score + strictBonus, idx });
    } else if (
      isBloatedDescOnly
        ? phraseHitPrimary || (allInPrimary && idfCoverage >= 0.75)
        : (sigStems.length >= 5 && (sigExactHits >= 2 || (coreExactHits > 0 && idfCoverage >= 0.24))) ||
          (sigStems.length >= 2 && sigStems.length < 5 && (coreExactHits > 0 || sigExactHits >= 2)) ||
          (qLen === 1 && prefixOnlyHits > 0)
    ) {
      const strongPartial = !isBloatedDescOnly && significantOwnExactHits >= 2 && significantOwnExactHits * 2 >= sigStems.length;
      partial.push({ item, score, idx, strongPartial });
    }
  }

  strict.sort((a, b) => b.score - a.score || a.idx - b.idx);
  partial.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return { strict, partial };
}

function applyPerConnectionCap(rankedEntries, { maxPerConnection = DEFAULT_MAX_PER_CONNECTION, diversityBand = 0 } = {}) {
  if (!Array.isArray(rankedEntries) || rankedEntries.length === 0) return [];
  const wrapped = rankedEntries[0]?.item && typeof rankedEntries[0]?.score === 'number';
  const getItem = (e) => (wrapped ? e.item : e);
  const getScore = (e) => (wrapped ? e.score : 0);

  if (!maxPerConnection || maxPerConnection <= 0 || rankedEntries.length <= maxPerConnection) {
    return rankedEntries.map(getItem);
  }
  const distinctConns = new Set();
  for (const e of rankedEntries) {
    distinctConns.add(getItem(e).connId);
    if (distinctConns.size > 1) break;
  }
  if (distinctConns.size <= 1) return rankedEntries.map(getItem);

  // First enforce the strict per-connection cap (max 4 per app).
  const byConn = new Map();
  const capped = [];
  for (const e of rankedEntries) {
    const connId = getItem(e).connId;
    const bucket = byConn.get(connId);
    if (bucket) {
      if (bucket.length >= maxPerConnection) continue;
      bucket.push(e);
    } else {
      byConn.set(connId, [e]);
    }
    capped.push(e);
  }

  // Score-aware diversity: when multiple Connections score closely (within `diversityBand`),
  // surface the #1 tool from each distinct Connection before repeating 2nd/3rd tools from the same app.
  // If one Connection leads decisively (beyond `diversityBand`), it keeps consecutive top slots naturally.
  if (!wrapped || diversityBand <= 0) {
    return capped.map(getItem);
  }
  const remaining = [...capped];
  const ordered = [];
  const seenCount = new Map();
  while (remaining.length > 0) {
    const leadScore = getScore(remaining[0]);
    const leadConn = getItem(remaining[0]).connId;
    const leadTier = remaining[0].tier || 2;
    let pickIdx = 0;
    if ((seenCount.get(leadConn) || 0) > 0) {
      const leadUsed = seenCount.get(leadConn);
      for (let i = 1; i < remaining.length; i += 1) {
        const cand = remaining[i];
        if ((cand.tier || 2) !== leadTier) break;
        if (leadScore - getScore(cand) > diversityBand) break;
        const candUsed = seenCount.get(getItem(cand).connId) || 0;
        if (candUsed < leadUsed) {
          pickIdx = i;
          break;
        }
      }
    }
    const [picked] = remaining.splice(pickIdx, 1);
    const pid = getItem(picked).connId;
    seenCount.set(pid, (seenCount.get(pid) || 0) + 1);
    ordered.push(getItem(picked));
  }
  return ordered;
}

/* ---------------- Hybrid Retrieval Helpers (v3) ---------------- */

export const SEARCH_STRATEGIES = ['cascade', 'hybrid'];
export const DEFAULT_SEARCH_STRATEGY = 'hybrid';
const RRF_K = 60;
const SKILL_BODY_CHUNK_CHARS = 900;
const SKILL_BODY_MAX_CHUNKS = 4;

function stripMarkdownNoise(text) {
  return String(text || '')
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function skillBodyChunks(skill) {
  const raw = String(skill?.body || skill?.content || '');
  if (!raw.trim()) return [];
  const clean = stripMarkdownNoise(raw);
  if (!clean) return [];
  const name = String(skill?.name || skill?.id || '').trim();
  const chunks = [];
  for (let i = 0; i < clean.length && chunks.length < SKILL_BODY_MAX_CHUNKS; i += SKILL_BODY_CHUNK_CHARS) {
    const piece = clean.slice(i, i + SKILL_BODY_CHUNK_CHARS).trim();
    if (piece.length >= 40) chunks.push(`${name}: ${piece}`);
  }
  return chunks;
}

function toolRerankText(c) {
  const params = String(c.paramText || '').slice(0, 300);
  const desc = String(c.description || '').replace(/\s+/g, ' ').trim().slice(0, 700);
  return `${c.connName || c.connId}: ${splitIdentifiers(c.toolName).join(' ')}. ${desc}${params ? ` Inputs: ${params}` : ''}`;
}

function skillRerankText(s) {
  const desc = String(s.description || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const body = stripMarkdownNoise(s.body || s.content || '').slice(0, 500);
  return `${s.name || s.id}: ${desc}${body ? ` ${body}` : ''}`;
}

function hybridWeight(envName, fallback) {
  const v = Number(process.env[envName]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

// Reciprocal-rank fusion over several ranked id lists. Each list is [{ id, score }] sorted desc.
function rrfFuse(lists, weights) {
  const fused = new Map();
  for (let li = 0; li < lists.length; li += 1) {
    const list = lists[li] || [];
    const w = weights[li] ?? 1;
    for (let r = 0; r < list.length; r += 1) {
      const id = list[r].id;
      fused.set(id, (fused.get(id) || 0) + w / (RRF_K + r + 1));
    }
  }
  return fused;
}

const SKILL_BAG_CACHE = new Map();

// Small field-weighted BM25 for skills (name x3, description x2, body x1).
function scoreSkillsBM25(list, queryTokens, examplesFor = () => []) {
  const qStems = [...new Set(queryTokens.map((t) => stemToken(t)).filter((t) => t && t.length >= 2))];
  if (qStems.length === 0 || list.length === 0) return [];
  const docs = list.map((s) => {
    const ex = (examplesFor(s.id) || []).join(' ');
    const descRaw = String(s.description || '');
    const bodyRaw = String(s.body || s.content || '');
    const cacheKey = createHash('sha256')
      .update(`${s.id || ''}\0${s.name || ''}\0${descRaw}\0${bodyRaw}\0${ex}`)
      .digest('base64');
    const cached = SKILL_BAG_CACHE.get(cacheKey);
    if (cached) return { ...cached, s };
    const name = countStemFreqs(tokenizeStemmed(`${s.id || ''} ${s.name || ''}`));
    const descToks = tokenizeStemmed(`${descRaw} ${ex}`);
    const bodyToks = tokenizeStemmed(stripMarkdownNoise(bodyRaw).slice(0, 6000));
    const bag = { name, desc: countStemFreqs(descToks), body: countStemFreqs(bodyToks), dl: descToks.length + bodyToks.length * 0.3 + 1 };
    if (SKILL_BAG_CACHE.size > 5000) SKILL_BAG_CACHE.clear();
    SKILL_BAG_CACHE.set(cacheKey, bag);
    return { ...bag, s };
  });
  const N = docs.length;
  const avgdl = docs.reduce((a, d) => a + d.dl, 0) / N;
  const out = [];
  const df = qStems.map((t) => docs.filter((d) => d.name.has(t) || d.desc.has(t) || d.body.has(t)).length);
  for (const d of docs) {
    let score = 0;
    let hits = 0;
    for (let i = 0; i < qStems.length; i += 1) {
      const t = qStems[i];
      const tf = 3 * (d.name.get(t) || 0) + 2 * (d.desc.get(t) || 0) + Math.min(6, d.body.get(t) || 0);
      if (tf <= 0) continue;
      hits += 1;
      const idf = Math.log(1 + (N - df[i] + 0.5) / (df[i] + 0.5));
      score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.dl / avgdl))));
    }
    if (hits > 0) out.push({ id: d.s.id, score: score * (0.5 + 0.5 * (hits / qStems.length)), item: d.s });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/* ---------------- Main SearchIndex Class ---------------- */

export class SearchIndex {
  constructor(dir = null, {
    embedder = null,
    hosted = false,
    autoSemanticThreshold = false,
    semanticMinTools = DEFAULT_AUTO_SEMANTIC_MIN_TOOLS,
    semanticMinConnections = DEFAULT_AUTO_SEMANTIC_MIN_CONNECTIONS,
    minSemanticScore = DEFAULT_MIN_SEMANTIC_SCORE,
    maxLearnedPerTool = DEFAULT_MAX_LEARNED_PER_TOOL,
    storeLearnedText = true,
    strategy = process.env.LOOP_SEARCH_STRATEGY || DEFAULT_SEARCH_STRATEGY,
    reranker = null,
    indexSkillBodies = process.env.LOOP_SEARCH_SKILL_BODIES !== '0',
  } = {}) {
    this.dir = dir;
    this.strategy = SEARCH_STRATEGIES.includes(strategy) ? strategy : DEFAULT_SEARCH_STRATEGY;
    this.reranker = reranker || null;
    this.indexSkillBodies = Boolean(indexSkillBodies);
    this.embedder = embedder || createNullEmbedder();
    this.localStore = new LocalBinaryVectorStore(dir);
    this.hosted = Boolean(hosted);
    this.autoSemanticThreshold = Boolean(autoSemanticThreshold);
    this.semanticMinTools = Number.isFinite(Number(semanticMinTools)) ? Number(semanticMinTools) : DEFAULT_AUTO_SEMANTIC_MIN_TOOLS;
    this.semanticMinConnections = Number.isFinite(Number(semanticMinConnections))
      ? Number(semanticMinConnections)
      : DEFAULT_AUTO_SEMANTIC_MIN_CONNECTIONS;
    this.explicitMinSemanticScore = minSemanticScore !== DEFAULT_MIN_SEMANTIC_SCORE ? minSemanticScore : null;
    this.minSemanticScore = minSemanticScore;
    this.maxLearnedPerTool = maxLearnedPerTool;
    this.storeLearnedText = Boolean(storeLearnedText);

    this.learnedPath = dir ? path.join(dir, 'search-learned.json') : null;
    this.learned = new Map(); // toolId -> [{ text, at }]
    this.learnedLoaded = false;
    this._learnedQueue = createWriteQueue();

    // Verified catalog enrichment (public MCPs): toolKey -> { examples: string[], category?: string, vectors?: Float32Array[] }
    this.catalogEntries = new Map();
    this.catalogModelId = null;
    this.skillExamples = new Map(); // skillId -> string[] (enrichment)

    // Session-scoped recent search memory for (search -> successful run) learning
    this.recentSearches = new Map(); // sessionKey -> [{ query, at, toolIds: Set }]

    // Lightweight in-memory catalog metadata & single-flight sync coalescing
    this._lastToolCount = 0;
    this._lastConnCount = 0;
    this._lastSkillCount = 0;
    this._lastMemoryCount = 0;
    this._syncInFlight = null;
    this._queuedSync = null;
    this._lastSyncStats = { embedded: 0, reused: 0, pruned: 0, at: null };
  }

  setEmbedder(embedder) {
    this.embedder = embedder || createNullEmbedder();
  }

  effectiveMinSemanticScore(override = null) {
    if (typeof override === 'number' && Number.isFinite(override)) return override;
    if (this.explicitMinSemanticScore !== null) return this.explicitMinSemanticScore;
    if (typeof this.embedder?.recommendedMinScore === 'number' && Number.isFinite(this.embedder.recommendedMinScore)) {
      return this.embedder.recommendedMinScore;
    }
    return this.minSemanticScore;
  }

  effectiveSoftMinSemanticScore(override = null) {
    const strong = this.effectiveMinSemanticScore(override);
    if (typeof override === 'number' && Number.isFinite(override)) {
      return Math.max(0.15, Math.round((override - 0.04) * 1000) / 1000);
    }
    if (this.explicitMinSemanticScore !== null) {
      return Math.max(0.15, Math.round((this.explicitMinSemanticScore - 0.04) * 1000) / 1000);
    }
    if (
      typeof this.embedder?.recommendedSoftMinScore === 'number' &&
      Number.isFinite(this.embedder.recommendedSoftMinScore)
    ) {
      return Math.min(strong, this.embedder.recommendedSoftMinScore);
    }
    return Math.max(0.15, Math.round((strong - 0.04) * 1000) / 1000);
  }

  shouldUseSemantic() {
    if (!this.embedder || !this.embedder.isAvailable()) return false;
    if (!this.autoSemanticThreshold) return true;
    // Hosted / shared HTTP embedders add 0 MB RAM on the user's device, so keep semantic ON from tool #1!
    if (this.hosted || this.embedder.provider === 'http') return true;
    return this._aboveSemanticThreshold();
  }

  _aboveSemanticThreshold() {
    return (
      this._lastToolCount >= this.semanticMinTools ||
      this._lastConnCount >= this.semanticMinConnections ||
      this._lastSkillCount >= AUTO_SEMANTIC_MIN_SKILLS ||
      this._lastMemoryCount >= AUTO_SEMANTIC_MIN_MEMORIES
    );
  }

  resolveGear() {
    return this.shouldUseSemantic() ? 'local-semantic' : 'lexical';
  }

  /* ---- Instant Single-Item Index Updates (Skills & Memory Add / Update / Delete) ---- */

  async upsertSkillImmediate(skill, { signal = null } = {}) {
    if (!skill || !skill.id) return { updated: false };
    if (!this.shouldUseSemantic()) return { updated: false, gear: 'lexical' };
    const modelId = this.embedder.modelId;
    await this.localStore.load(modelId);
    const text = cleanSkillSemanticText(skill);
    if (!text) return { updated: false };
    const key = `skill:${skill.id}:desc`;
    const fp = fingerprintText(modelId, 'skill', key, text);
    const existingIdx = this.localStore.keyToIdx.get(key);
    if (existingIdx === undefined || this.localStore.entries[existingIdx]?.fingerprint !== fp) {
      const vecs = await this.embedder.embed([text], { kind: 'document', signal });
      if (!vecs?.[0]) return { updated: false };
      this.localStore.upsertBatch(modelId, [{ key, kind: 'skill', parentId: skill.id, slot: 'desc', fingerprint: fp, vector: quantizeInt8(vecs[0]) }]);
      await this.localStore.flush();
    }
    return { updated: true, key };
  }

  async upsertMemoryImmediate(memory, { signal = null } = {}) {
    if (!memory || !memory.id || !memory.content) return { updated: false };
    if (!this.shouldUseSemantic()) return { updated: false, gear: 'lexical' };
    const modelId = this.embedder.modelId;
    await this.localStore.load(modelId);
    const text = cleanMemorySemanticText(memory);
    if (!text) return { updated: false };
    const key = `memory:${memory.id}:desc`;
    const fp = fingerprintText(modelId, 'memory', key, text);
    const vecs = await this.embedder.embed([text], { kind: 'document', signal });
    if (!vecs?.[0]) return { updated: false };
    const qVec = quantizeInt8(vecs[0]);
    const item = { key, kind: 'memory', parentId: memory.id, slot: 'desc', fingerprint: fp, vector: qVec };
    this.localStore.upsertBatch(modelId, [item]);
    await this.localStore.flush();
    return { updated: true, key };
  }

  async upsertSavedImmediate(savedItem, { signal = null } = {}) {
    if (!savedItem || !savedItem.id) return { updated: false };
    if (!this.shouldUseSemantic()) return { updated: false, gear: 'lexical' };
    const modelId = this.embedder.modelId;
    await this.localStore.load(modelId);
    const parts = [
      savedItem.displayTitle || savedItem.title || savedItem.fetchedTitle || '',
      savedItem.note || '',
      savedItem.summary || '',
      Array.isArray(savedItem.tags) ? savedItem.tags.join(' ') : '',
      savedItem.domain || '',
    ].filter(Boolean);
    const text = parts.join(' — ').replace(/\s+/g, ' ').trim().slice(0, 1200);
    if (!text) return { updated: false };
    const key = `saved:${savedItem.id}:desc`;
    const fp = fingerprintText(modelId, 'saved', key, text);
    const vecs = await this.embedder.embed([text], { kind: 'document', signal });
    if (!vecs?.[0]) return { updated: false };
    const qVec = quantizeInt8(vecs[0]);
    const item = { key, kind: 'saved', parentId: savedItem.id, slot: 'desc', fingerprint: fp, vector: qVec };
    this.localStore.upsertBatch(modelId, [item]);
    await this.localStore.flush();
    return { updated: true, key };
  }

  async scoreSavedSemantic(items, query, { signal = null } = {}) {
    const cleanQuery = String(query || '').trim().slice(0, MAX_SEARCH_QUERY_CHARS);
    if (!cleanQuery || !Array.isArray(items) || items.length === 0) return null;
    if (!this.embedder || !this.embedder.isAvailable()) return null;
    const allowedIds = new Set(items.map((m) => m.id));
    const { scores: semMap } = await this._scoreKindSemantic('saved', cleanQuery, allowedIds, { signal });
    if (!semMap || semMap.size === 0) return null;
    const out = new Map();
    for (const [id, rec] of semMap.entries()) {
      const sim = combineDescAndExampleSim(rec);
      if (sim > 0) out.set(id, sim);
    }
    return out.size > 0 ? out : null;
  }

  async removeItemImmediate(kind, parentId) {
    if (!kind || !parentId) return { removed: 0 };
    if (!this.embedder?.isAvailable()) return { removed: 0 };
    await this.localStore.load(this.embedder.modelId);
    const toDelete = [];
    const keepKeys = new Set();
    for (const e of this.localStore.entries) {
      if (e.kind === kind && e.parentId === parentId) {
        toDelete.push(e.key);
      } else {
        keepKeys.add(e.key);
      }
    }
    if (toDelete.length === 0) return { removed: 0 };
    this.localStore.pruneKeys(keepKeys);
    await this.localStore.flush();
    return { removed: toDelete.length };
  }

  async removeConnectionImmediate(connId) {
    if (!connId) return { removed: 0, learnedPruned: 0 };
    await this._ensureLearnedLoaded();
    const prefix = `${connId}__`;
    let learnedPruned = 0;
    for (const toolId of [...this.learned.keys()]) {
      if (toolId.startsWith(prefix)) {
        this.learned.delete(toolId);
        learnedPruned += 1;
      }
    }
    if (learnedPruned > 0) {
      await this._saveLearned();
    }
    if (!this.embedder?.isAvailable()) return { removed: 0, learnedPruned };
    await this.localStore.load(this.embedder.modelId);
    const toDelete = [];
    const keepKeys = new Set();
    for (const e of this.localStore.entries) {
      const isTargetConn = e.kind === 'connection' && e.parentId === connId;
      const isTargetTool = e.kind === 'tool' && typeof e.parentId === 'string' && e.parentId.startsWith(prefix);
      if (isTargetConn || isTargetTool) {
        toDelete.push(e.key);
      } else {
        keepKeys.add(e.key);
      }
    }
    if (toDelete.length === 0) return { removed: 0, learnedPruned };
    this.localStore.pruneKeys(keepKeys);
    await this.localStore.flush();
    return { removed: toDelete.length, learnedPruned };
  }

  /* ---- Signed Hosted Catalog Enrichment ---- */

  loadCatalogBundle(bundle, { hmacSecret = null, publicKeyPem = null } = {}) {
    const check = verifySignedCatalogBundle(bundle, { hmacSecret, publicKeyPem });
    if (!check.valid) {
      throw new Error(`Rejected catalog bundle: ${check.reason}`);
    }
    this.catalogEntries.clear();
    this.catalogModelId = typeof bundle.modelId === 'string' ? bundle.modelId : null;
    const entries = bundle.entries && typeof bundle.entries === 'object' ? bundle.entries : {};
    for (const [key, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== 'object') continue;
      const examples = Array.isArray(entry.examples)
        ? entry.examples.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 5)
        : [];
      const vectors = Array.isArray(entry.vectors)
        ? entry.vectors.map((v) => l2Normalize(v))
        : null;
      this.catalogEntries.set(key, {
        examples,
        category: typeof entry.category === 'string' ? entry.category : null,
        vectors,
      });
    }
    return { loaded: this.catalogEntries.size, modelId: this.catalogModelId };
  }

  // Unsigned, locally generated enrichment (lib/enrich.mjs): extra example requests per tool/skill.
  // Tool examples share the curated catalog-example slot; skills get their own example slots.
  loadEnrichment({ tools = {}, skills = {} } = {}) {
    let t = 0;
    let k = 0;
    for (const [key, examples] of Object.entries(tools || {})) {
      if (!Array.isArray(examples) || examples.length === 0) continue;
      const prev = this.catalogEntries.get(key);
      if (prev && prev.vectors) continue; // never override signed curated entries
      this.catalogEntries.set(key, {
        examples: examples.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 5),
        category: prev?.category || null,
        vectors: null,
        enriched: true,
      });
      t += 1;
    }
    for (const [id, examples] of Object.entries(skills || {})) {
      if (!Array.isArray(examples) || examples.length === 0) continue;
      this.skillExamples.set(id, examples.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 5));
      k += 1;
    }
    return { tools: t, skills: k };
  }

  getCatalogEntry(toolKey) {
    return this.catalogEntries.get(toolKey) || null;
  }

  /* ---- Bounded, Secret-Safe Learned Examples ---- */

  _learnedExampleId(text) {
    return createHash('sha256').update(String(text || '').toLowerCase(), 'utf8').digest('hex').slice(0, 12);
  }

  async _ensureLearnedLoaded() {
    if (this.learnedLoaded) return;
    this.learnedLoaded = true;
    if (!this.learnedPath) return;
    try {
      const raw = JSON.parse(await readFile(this.learnedPath, 'utf8'));
      if (raw && typeof raw === 'object' && raw.tools && typeof raw.tools === 'object') {
        for (const [toolId, list] of Object.entries(raw.tools)) {
          if (!Array.isArray(list)) continue;
          const clean = list
            .filter((item) => item && typeof item.text === 'string' && item.text.trim() && !looksLikeSecret(item.text))
            .map((item) => ({
              id: typeof item.id === 'string' && item.id ? item.id : this._learnedExampleId(item.text),
              text: item.text,
              at: item.at || new Date().toISOString(),
            }))
            .slice(-this.maxLearnedPerTool);
          if (clean.length > 0) this.learned.set(toolId, clean);
        }
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        // Ignore corrupt learned cache; starts clean.
      }
    }
  }

  async _saveLearned() {
    if (!this.learnedPath) return;
    return this._learnedQueue(async () => {
      const tools = {};
      for (const [toolId, list] of this.learned.entries()) {
        if (list.length > 0) tools[toolId] = list;
      }
      await atomicWriteFile(
        this.learnedPath,
        JSON.stringify({ version: 1, tools }, null, 2) + '\n',
        { mode: 0o600, fsync: false },
      );
    });
  }

  getLearnedExamples(toolId) {
    const list = this.learned.get(toolId);
    return Array.isArray(list) ? list.map((x) => x.text) : [];
  }

  recordSearchEvent(sessionKey, query, returnedToolIds = []) {
    const clean = String(query || '').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length < 4 || clean.length > MAX_LEARNED_QUERY_CHARS) return;
    if (looksLikeSecret(clean)) return;
    const key = String(sessionKey || 'default');
    const now = Date.now();
    // Sweep expired sessions and bound map size to prevent unbounded memory growth.
    if (this.recentSearches.size >= MAX_TRACKED_SESSIONS) {
      for (const [sess, entries] of this.recentSearches.entries()) {
        const latest = entries[entries.length - 1];
        if (!latest || now - latest.at > LEARN_WINDOW_MS) {
          this.recentSearches.delete(sess);
        }
      }
      while (this.recentSearches.size >= MAX_TRACKED_SESSIONS) {
        const oldestKey = this.recentSearches.keys().next().value;
        this.recentSearches.delete(oldestKey);
      }
    }
    const history = this.recentSearches.get(key) || [];
    const fresh = history.filter((h) => now - h.at <= LEARN_WINDOW_MS).slice(-(MAX_SESSION_SEARCH_HISTORY - 1));
    fresh.push({ query: clean, at: now, toolIds: new Set(returnedToolIds) });
    this.recentSearches.delete(key);
    this.recentSearches.set(key, fresh);
  }

  async recordSuccessfulToolRun(sessionKey, toolId) {
    if (!toolId || typeof toolId !== 'string') return { learned: false, reason: 'missing_tool' };
    await this._ensureLearnedLoaded();
    const key = String(sessionKey || 'default');
    const history = this.recentSearches.get(key);
    if (!history || history.length === 0) return { learned: false, reason: 'no_recent_search' };

    const now = Date.now();
    // Pick the most recent unexpired search in this session that either surfaced this tool
    // or returned 0 hits (genuine vocabulary gap). Never attribute an unrelated search that
    // returned completely different tools to avoid cross-task contamination.
    let matched = null;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const h = history[i];
      if (now - h.at > LEARN_WINDOW_MS) continue;
      if (h.toolIds.size === 0 || h.toolIds.has(toolId)) {
        matched = h;
        break;
      }
    }
    if (!matched) return { learned: false, reason: 'no_matching_search' };

    const queryText = matched.query;
    if (looksLikeSecret(queryText)) return { learned: false, reason: 'secret_blocked' };

    // Skip trivial exact-name queries (no value learning "supabase__execute_sql" for itself)
    const parts = toolId.split('__');
    const bareToolName = parts.length > 1 ? parts.slice(1).join('__') : toolId;
    const qLower = queryText.toLowerCase();
    if (qLower === toolId.toLowerCase() || qLower === bareToolName.toLowerCase()) {
      return { learned: false, reason: 'trivial_exact_name' };
    }

    const existing = this.learned.get(toolId) || [];
    const normNew = qLower;
    const dupIdx = existing.findIndex((item) => item.text.toLowerCase() === normNew);
    if (dupIdx !== -1) {
      // Refresh LRU position without consuming a new slot
      const [item] = existing.splice(dupIdx, 1);
      item.at = new Date(now).toISOString();
      existing.push(item);
      this.learned.set(toolId, existing);
      await this._saveLearned();
      return { learned: false, reason: 'duplicate_refreshed' };
    }

    // Optional semantic gap-check & dedupe when embedder is active:
    // Behavioral examples exist to bridge vocabulary gaps (e.g. private tools with terse descriptions).
    // If the tool's own description/catalog ALREADY strictly matches the query (>= minScore + 0.09),
    // skip storing it so session-specific entities (IDs, names) never pollute future prompts.
    let queryVec = null;
    if (this.embedder?.isAvailable()) {
      try {
        await this.localStore.load(this.embedder.modelId);
        const qCheckVecs = await this.embedder.embed([queryText], { kind: 'query' });
        if (qCheckVecs?.[0]) {
          const organicSim = this.localStore.maxCosineAgainstParent('tool', toolId, qCheckVecs[0], { organicOnly: true });
          if (organicSim >= this.effectiveMinSemanticScore() + 0.09) {
            return { learned: false, reason: 'already_well_matched' };
          }
        }
        const vecs = await this.embedder.embed([queryText], { kind: 'document' });
        if (vecs?.[0]) {
          queryVec = vecs[0];
          const maxExistingSim = this.localStore.maxCosineAgainstParent('tool', toolId, queryVec);
          if (maxExistingSim >= LEARNED_DEDUPE_COSINE) {
            return { learned: false, reason: 'semantically_duplicate' };
          }
        }
      } catch {
        // Non-fatal; proceed with lexical storage
      }
    }

    const next = [...existing];
    const evicted = [];
    while (next.length >= this.maxLearnedPerTool) evicted.push(next.shift()); // LRU eviction
    const exId = this._learnedExampleId(queryText);
    const storedText = this.storeLearnedText ? queryText : `[vec:${exId}]`;
    next.push({ id: exId, text: storedText, at: new Date(now).toISOString() });
    this.learned.set(toolId, next);
    await this._saveLearned();

    // Immediately upsert the learned example vector using its stable content-derived slot ID
    // (and prune any evicted LRU vector keys so stale vectors never linger).
    if (queryVec && this.embedder?.modelId) {
      const slot = `ex:learn:${exId}`;
      const vecKey = `tool:${toolId}:${slot}`;
      const fp = fingerprintText(this.embedder.modelId, 'tool', vecKey, queryText);
      const item = {
        key: vecKey,
        kind: 'tool',
        parentId: toolId,
        slot,
        fingerprint: fp,
        vector: quantizeInt8(queryVec),
      };
      this.localStore.upsertBatch(this.embedder.modelId, [item]);
      if (evicted.length > 0) {
        const evictedKeys = new Set(evicted.map((ev) => `tool:${toolId}:ex:learn:${ev.id}`));
        const keepAll = new Set(this.localStore.entries.map((e) => e.key).filter((k) => !evictedKeys.has(k)));
        this.localStore.pruneKeys(keepAll);
      }
      await this.localStore.flush();
    }

    return { learned: true, toolId, count: next.length };
  }

  /* ---- Fingerprint-Diffed Incremental Indexing (Single-Flight Coalesced) ---- */

  async syncIndex(args = {}) {
    if (this._syncInFlight) {
      // Coalesce concurrent sync calls into at most one follow-up pass using the latest snapshot.
      if (!this._queuedSync) {
        let resolveFollowup;
        let rejectFollowup;
        const promise = new Promise((resolve, reject) => {
          resolveFollowup = resolve;
          rejectFollowup = reject;
        });
        this._queuedSync = { args, promise, resolve: resolveFollowup, reject: rejectFollowup };
      } else {
        this._queuedSync.args = args;
      }
      return this._queuedSync.promise;
    }

    const run = this._runSyncIndex(args);
    this._syncInFlight = run;
    try {
      return await run;
    } finally {
      this._syncInFlight = null;
      if (this._queuedSync) {
        const next = this._queuedSync;
        this._queuedSync = null;
        this.syncIndex(next.args).then(next.resolve, next.reject);
      }
    }
  }

  async _runSyncIndex({ connections = [], skills = [], memories = [], categoryFor = null, signal = null } = {}) {
    await this._ensureLearnedLoaded();
    const conns = Array.isArray(connections) ? connections : [];
    const skillList = Array.isArray(skills) ? skills : [];
    const memList = Array.isArray(memories) ? memories : [];

    const activeToolIds = new Set();
    let toolCount = 0;
    for (const c of conns) {
      if (c && c.enabled !== false && Array.isArray(c.tools)) {
        toolCount += c.tools.length;
        for (const t of c.tools) {
          if (t?.name) activeToolIds.add(`${c.id}__${t.name}`);
        }
      }
    }
    this._lastToolCount = toolCount;
    this._lastConnCount = conns.length;
    this._lastSkillCount = skillList.length;
    this._lastMemoryCount = memList.length;

    // Prune orphaned learned examples when Connections/tools are deleted (only when connections list was provided).
    if (conns.length > 0 && this.learned.size > 0) {
      let prunedLearned = false;
      for (const toolId of this.learned.keys()) {
        if (!activeToolIds.has(toolId)) {
          this.learned.delete(toolId);
          prunedLearned = true;
        }
      }
      if (prunedLearned) await this._saveLearned();
    }

    if (!this.shouldUseSemantic()) {
      return { gear: 'lexical', embedded: 0, reused: 0, pruned: 0 };
    }

    const modelId = this.embedder.modelId;
    await this.localStore.load(modelId);
    const existingFps = this.localStore.getFingerprints();

    const desired = []; // [{ key, kind, parentId, slot, text, fingerprint, precomputedVector? }]
    const keepKeys = new Set();

    const pushDesired = (kind, parentId, slot, text, precomputedVector = null) => {
      const clean = String(text || '').trim();
      if (!clean) return;
      const key = `${kind}:${parentId}:${slot}`;
      const fp = fingerprintText(modelId, kind, key, clean);
      keepKeys.add(key);
      desired.push({ key, kind, parentId, slot, text: clean, fingerprint: fp, precomputedVector });
    };

    // 1. Connections + Tools
    for (const conn of conns) {
      if (!conn || conn.enabled === false) continue;
      const catLabel = typeof categoryFor === 'function' ? categoryFor(conn, 'connection') : '';
      pushDesired('connection', conn.id, 'desc', cleanConnectionSemanticText(conn, catLabel));

      const tools = Array.isArray(conn.tools) ? conn.tools : [];
      for (const tool of tools) {
        if (!tool || !tool.name) continue;
        const fullId = `${conn.id}__${tool.name}`;
        pushDesired('tool', fullId, 'desc', cleanToolSemanticText(conn, tool));

        // Catalog examples (pre-signed public MCPs)
        const catEntry = this.catalogEntries.get(fullId) || this.catalogEntries.get(tool.name) || null;
        if (catEntry && Array.isArray(catEntry.examples)) {
          const canReuseCatalogVecs = Boolean(
            catEntry.vectors &&
            this.catalogModelId &&
            this.catalogModelId === modelId &&
            catEntry.vectors.length === catEntry.examples.length,
          );
          for (let i = 0; i < catEntry.examples.length; i += 1) {
            pushDesired(
              'tool',
              fullId,
              `ex:cat:${i}`,
              catEntry.examples[i],
              canReuseCatalogVecs ? catEntry.vectors[i] : null,
            );
          }
        }

        // Local learned examples (stable content-derived slot IDs)
        const learnedEntries = this.learned.get(fullId) || [];
        for (const le of learnedEntries) {
          if (!le?.text || le.text.startsWith('[vec:')) {
            if (le?.id) keepKeys.add(`tool:${fullId}:ex:learn:${le.id}`);
            continue;
          }
          pushDesired('tool', fullId, `ex:learn:${le.id}`, le.text);
        }
      }
    }

    // 2. Skills
    for (const skill of skillList) {
      if (!skill || !skill.id) continue;
      pushDesired('skill', skill.id, 'desc', cleanSkillSemanticText(skill));
      // Skill bodies carry the real routing signal in large, overlapping skill pools (SkillRouter,
      // 2026): embed the first few sections so a skill is findable by what it actually teaches.
      const skillEx = this.skillExamples.get(skill.id) || [];
      for (let ei = 0; ei < skillEx.length; ei += 1) {
        pushDesired('skill', skill.id, `ex:cat:${ei}`, skillEx[ei]);
      }
      if (this.indexSkillBodies) {
        const chunks = skillBodyChunks(skill);
        for (let ci = 0; ci < chunks.length; ci += 1) {
          pushDesired('skill', skill.id, `body:${ci}`, chunks[ci]);
        }
      }
    }

    // 3. Memories (strictly workspace-local, never Vault!)
    for (const mem of memList) {
      if (!mem || !mem.id || !mem.content) continue;
      pushDesired('memory', mem.id, 'desc', cleanMemorySemanticText(mem));
    }

    const toEmbed = [];
    const precomputedToUpsert = [];
    let reused = 0;
    for (const d of desired) {
      if (existingFps.get(d.key) === d.fingerprint) {
        reused += 1;
        continue;
      }
      if (d.precomputedVector) {
        precomputedToUpsert.push({
          key: d.key,
          kind: d.kind,
          parentId: d.parentId,
          slot: d.slot,
          fingerprint: d.fingerprint,
          vector: quantizeInt8(d.precomputedVector),
        });
      } else {
        toEmbed.push(d);
      }
    }

    const newlyUpserted = [...precomputedToUpsert];
    if (toEmbed.length > 0) {
      const BATCH = 64;
      for (let start = 0; start < toEmbed.length; start += BATCH) {
        const chunk = toEmbed.slice(start, start + BATCH);
        const vecs = await this.embedder.embed(chunk.map((c) => c.text), { kind: 'document', signal });
        if (!vecs || vecs.length !== chunk.length) break;
        for (let i = 0; i < chunk.length; i += 1) {
          newlyUpserted.push({
            key: chunk[i].key,
            kind: chunk[i].kind,
            parentId: chunk[i].parentId,
            slot: chunk[i].slot,
            fingerprint: chunk[i].fingerprint,
            vector: quantizeInt8(vecs[i]),
          });
        }
      }
    }

    if (newlyUpserted.length > 0) {
      this.localStore.upsertBatch(modelId, newlyUpserted);
    }
    const pruned = this.localStore.pruneKeys(keepKeys);
    await this.localStore.flush();

    const gear = this.resolveGear();
    this._lastSyncStats = {
      embedded: toEmbed.length,
      precomputed: precomputedToUpsert.length,
      reused,
      pruned,
      at: new Date().toISOString(),
    };
    return { gear, ...this._lastSyncStats };
  }

  /* ---- Semantic Score Lookup (Local Binary Vectors, Live-Filtered!) ---- */

  async _embedQueryCached(textsToEmbed, { signal = null } = {}) {
    if (!this._queryVecCache) this._queryVecCache = new Map();
    const modelKey = this.embedder?.modelId || 'default';
    const cacheKey = `${modelKey}\0${textsToEmbed.join('\x1f')}`;
    const now = Date.now();
    const hit = this._queryVecCache.get(cacheKey);
    if (hit && now - hit.at < 30_000) return hit.vecs;
    const vecs = await this.embedder.embed(textsToEmbed, { kind: 'query', signal });
    if (Array.isArray(vecs) && vecs.length > 0) {
      if (this._queryVecCache.size >= 64) {
        const oldest = this._queryVecCache.keys().next().value;
        if (oldest !== undefined) this._queryVecCache.delete(oldest);
      }
      this._queryVecCache.set(cacheKey, { vecs, at: now });
    }
    return vecs;
  }

  async _scoreKindSemantic(kind, query, allowedParentIds, { signal = null, multiClause = false } = {}) {
    if (!this.shouldUseSemantic()) {
      return { scores: null, clauses: [], clauseScores: [], gear: 'lexical', needsWarmup: false };
    }
    const cleanQ = String(query || '').trim().slice(0, MAX_SEARCH_QUERY_CHARS);
    if (!cleanQ) return { scores: null, clauses: [], clauseScores: [], gear: 'lexical', needsWarmup: false };
    const clauses = multiClause ? extractQueryClauses(cleanQ) : [];
    const textsToEmbed = clauses.length >= 2 ? [cleanQ, ...clauses] : [cleanQ];
    let vecs;
    try {
      vecs = await this._embedQueryCached(textsToEmbed, { signal });
    } catch {
      return { scores: null, clauses: [], clauseScores: [], gear: 'lexical', needsWarmup: false };
    }
    const queryVec = vecs?.[0] || null;
    if (!queryVec) return { scores: null, clauses: [], clauseScores: [], gear: 'lexical', needsWarmup: false };
    const clauseVecs = clauses.length >= 2 && vecs.length === textsToEmbed.length ? vecs.slice(1) : [];

    await this.localStore.load(this.embedder.modelId);
    if (this.localStore.entries.length === 0) {
      return { scores: null, clauses: [], clauseScores: [], gear: 'lexical', needsWarmup: true };
    }
    if (clauseVecs.length > 0) {
      const [raw, ...clauseScores] = this.localStore.scoreByKindMulti(kind, [queryVec, ...clauseVecs], allowedParentIds);
      return { scores: raw, clauses, clauseScores, gear: 'local-semantic', needsWarmup: false };
    }
    const raw = this.localStore.scoreByKind(kind, queryVec, allowedParentIds);
    return { scores: raw, clauses: [], clauseScores: [], gear: 'local-semantic', needsWarmup: false };
  }

  /* ---- Tool Search (Tier 1 Exact -> Tier 2 Semantic + Unindexed Fallback) ---- */

  async searchTools(candidates, query, {
    connFilter = '',
    maxPerConnection = DEFAULT_MAX_PER_CONNECTION,
    pageSize = DEFAULT_TOOL_SEARCH_LIMIT,
    minSemanticScore = null,
    signal = null,
    strategy = null,
    rerank = true,
  } = {}) {
    await this._ensureLearnedLoaded();
    if ((strategy || this.strategy) === 'hybrid' && String(query || '').trim()) {
      return this._searchToolsHybrid(candidates, query, { connFilter, maxPerConnection, pageSize, minSemanticScore, signal, rerank });
    }
    const minScore = this.effectiveMinSemanticScore(minSemanticScore);
    const list = Array.isArray(candidates) ? candidates : [];
    const cleanQuery = String(query || '').trim().slice(0, MAX_SEARCH_QUERY_CHARS);
    if (!cleanQuery) {
      return {
        items: list,
        matchMode: 'all',
        gear: this.resolveGear(),
        topScore: 1,
        lowConfidence: false,
        needsWarmup: false,
      };
    }

    const queryLower = cleanQuery.toLowerCase();
    const queryTokens = tokenizeQuery(cleanQuery);

    // Tier 1: Exact tool name / full ID / connection ID / compound param key (never prose description!)
    const tier1 = [];
    const tier1Ids = new Set();
    let hasExactStructural = false;
    for (let i = 0; i < list.length; i += 1) {
      const c = list[i];
      const { score: exactScore, exactStructural } = scoreTier1ExactTool(c, queryLower, queryTokens);
      if (exactScore > 0) {
        tier1.push({ item: c, score: exactScore, idx: i, tier: 1 });
        tier1Ids.add(c.fullToolName);
        if (exactStructural) hasExactStructural = true;
      }
    }
    tier1.sort((a, b) => b.score - a.score || a.idx - b.idx);

    // Exact structural lookups (exact tool name, full ID, connection ID, or compound param key)
    // short-circuit immediately: <0.2 ms latency and zero unrelated Tier 2 clutter underneath.
    if (hasExactStructural) {
      const ambigT1 = detectCrossConnectionAmbiguity(tier1, queryTokens, { isSemantic: false, connFilter });
      const diverseTier1 = connFilter
        ? tier1.map((e) => e.item)
        : applyPerConnectionCap(tier1, { maxPerConnection, pageSize });
      return {
        items: diverseTier1,
        matchMode: 'strict',
        gear: this.resolveGear(),
        topScore: tier1[0].score,
        lowConfidence: false,
        needsWarmup: false,
        ambiguous: ambigT1.ambiguous,
        ...(ambigT1.ambiguous ? { ambiguousConnections: ambigT1.ambiguousConnections } : {}),
      };
    }

    // Tier 2 (Semantic): pure semantic similarity on description + examples + spam-proof structured ID tie-break
    const allowedIds = new Set(list.map((c) => c.fullToolName));
    const { scores: semMap, clauses, clauseScores, gear, needsWarmup } = await this._scoreKindSemantic('tool', cleanQuery, allowedIds, { signal, multiClause: true });

    if (semMap && semMap.size > 0) {
      const softMinScore = this.effectiveSoftMinSemanticScore(minSemanticScore);
      const qStems = [...new Set(queryTokens.map((t) => stemToken(t)).filter(Boolean))];
      const clauseStemsList =
        clauseScores.length >= 2
          ? clauseScores.map((_, ci) =>
              clauses?.[ci]
                ? [...new Set(tokenizeQuery(clauses[ci]).map((t) => stemToken(t)).filter(Boolean))]
                : qStems,
            )
          : [];
      const rawTier2 = [];
      const softTier2 = [];
      const unindexedStrict = [];
      const clauseBestIds = new Set();
      const clauseBestScore = new Map(); // fullToolName -> { score, organic }
      let maxOrganic = 0;
      let sawUnindexed = false;

      // Track top 2 winners per decomposed clause using EACH clause's own stems so compound
      // multi-step queries never cross-boost or prune the 2nd action!
      if (clauseScores.length >= 2) {
        for (let ci = 0; ci < clauseScores.length; ci += 1) {
          const cMap = clauseScores[ci];
          const cStems = clauseStemsList[ci];
          const clauseRanked = [];
          for (let i = 0; i < list.length; i += 1) {
            const c = list[i];
            const crec = cMap.get(c.fullToolName);
            if (!crec) continue;
            const cdet = combineDescAndExampleDetail(crec);
            const cBoost = gatedStructuredIdBonus(c, cStems, cdet.score, softMinScore);
            const cTotal = Math.min(1, cdet.score + cBoost);
            const cOrg = Math.min(1, cdet.organic + cBoost);
            if (cTotal >= minScore) {
              clauseRanked.push({ id: c.fullToolName, score: cTotal, organic: cOrg });
            }
          }
          clauseRanked.sort((a, b) => b.score - a.score);
          for (const w of clauseRanked.slice(0, 2)) {
            clauseBestIds.add(w.id);
            const prev = clauseBestScore.get(w.id);
            if (!prev || w.score > prev.score) {
              clauseBestScore.set(w.id, { score: w.score, organic: w.organic });
            }
          }
        }
      }

      for (let i = 0; i < list.length; i += 1) {
        const c = list[i];
        if (tier1Ids.has(c.fullToolName)) continue;
        const rec = semMap.get(c.fullToolName);
        const fullDet = rec ? combineDescAndExampleDetail(rec) : null;
        const clauseHit = clauseBestScore.get(c.fullToolName) || null;
        if (fullDet || clauseHit) {
          // Apply bounded structured-ID corroboration ONLY when base semantic score is plausible,
          // preventing unrelated negative queries from crossing the floor via a single coincidental word.
          const fullIdBoost = fullDet ? gatedStructuredIdBonus(c, qStems, fullDet.score, softMinScore) : 0;
          const fullSim = fullDet ? Math.min(1, fullDet.score + fullIdBoost) : -1;
          const fullOrg = fullDet ? Math.min(1, fullDet.organic + fullIdBoost) : -1;
          // Clause winners keep their full per-clause score (scaled by 0.99 only as tie-break vs full query)
          // so valid multi-step actions are never dropped below minScore.
          const clauseSim = clauseHit ? Math.max(minScore, clauseHit.score * 0.99) : -1;
          const clauseOrg = clauseHit ? clauseHit.organic * 0.99 : -1;
          const sim = Math.max(fullSim, clauseSim);
          const organic = Math.max(fullOrg, clauseOrg);
          if (sim >= minScore) {
            rawTier2.push({ item: c, score: sim, organic, idx: i, tier: 2 });
            if (organic > maxOrganic) maxOrganic = organic;
          } else if (sim >= softMinScore) {
            softTier2.push({ item: c, score: sim, organic, idx: i, tier: 2 });
          }
          continue;
        }
        // Newly added tool not yet embedded: allow strict lexical fallback ONLY for unindexed tools
        // so brand-new tools are searchable on millisecond 0 without weakening keyword-stuffing defense on indexed tools.
        if (!this.localStore.hasParent('tool', c.fullToolName)) {
          sawUnindexed = true;
          const learned = this.getLearnedExamples(c.fullToolName);
          const lex = scoreLexicalFallbackTool(c, queryLower, queryTokens, learned);
          if (lex.mode === 'strict' && lex.score > 0) {
            unindexedStrict.push({ item: c, score: lex.score, idx: i, tier: 2 });
          }
        }
      }
      rawTier2.sort((a, b) => b.score - a.score || a.idx - b.idx);
      softTier2.sort((a, b) => b.score - a.score || a.idx - b.idx);
      unindexedStrict.sort((a, b) => b.score - a.score || a.idx - b.idx);

      let tier2;
      let usedSoftBand = false;
      if (rawTier2.length > 0) {
        // Anchor relative tail pruning on maxOrganic so a behavioral learned example can never
        // jack up the cutoff and erase genuinely matching new tools.
        const anchor = maxOrganic > 0 ? maxOrganic : rawTier2[0].score;
        const relativeFloor = anchor > minScore + 0.08 ? Math.max(minScore, anchor - 0.11) : minScore;
        tier2 = rawTier2.filter((e) => e.score >= relativeFloor || clauseBestIds.has(e.item.fullToolName));
      } else if (tier1.length === 0 && unindexedStrict.length === 0 && softTier2.length > 0) {
        const topSoft = softTier2[0].score;
        tier2 = softTier2.filter((e) => e.score >= Math.max(softMinScore, topSoft - 0.035)).slice(0, 6);
        usedSoftBand = true;
      } else {
        tier2 = [];
      }

      const combined = [...tier1, ...tier2, ...unindexedStrict];
      // Strict 3-tier cascade: ONLY when Tier 1 Exact AND Tier 2 Confident Semantic both return
      // nothing, fall through to Tier 3 BM25F rescue (flagged partial / lowConfidence).
      // This never alters any confident semantic hit and never lets spam hijack solved queries.
      if (combined.length > 0) {
        const topScore = combined[0].score;
        const topTier = combined[0].tier;
        const ambig = detectCrossConnectionAmbiguity(combined, queryTokens, { isSemantic: true, connFilter });
        const diverseItems = connFilter
          ? combined.map((e) => e.item)
          : applyPerConnectionCap(combined, { maxPerConnection, pageSize, diversityBand: 0.05 });

        // Intra-Connection margin calibration: when a non-Tier-1 semantic #1 leads another tool
        // inside the SAME Connection by < 0.025 (statistical tie in embedding space), mark it
        // partial / lowConfidence so callers inspect the top few options rather than assuming certainty.
        const second = combined.length >= 2 ? combined[1] : null;
        const tightSameConnTie = Boolean(
          topTier !== 1 &&
          second &&
          second.tier === 2 &&
          second.item.connId === combined[0].item.connId &&
          topScore - second.score < 0.025,
        );

        const matchMode =
          usedSoftBand || ambig.ambiguous || tightSameConnTie
            ? 'partial'
            : topTier === 1 || topScore >= minScore + 0.09 || (tier2.length === 0 && unindexedStrict.length > 0)
              ? 'strict'
              : 'partial';
        const lowConfidence = matchMode !== 'strict';
        return {
          items: diverseItems,
          matchMode,
          gear,
          topScore: Math.round(topScore * 1000) / 1000,
          lowConfidence,
          needsWarmup: needsWarmup || sawUnindexed,
          ambiguous: ambig.ambiguous,
          ...(ambig.ambiguous ? { ambiguousConnections: ambig.ambiguousConnections } : {}),
        };
      }
    }

    // Tier 3 / Fallback (Field-Weighted BM25F + Whole-Token Stemming + Typo Tolerance — zero ML dependencies)
    const isSemanticRescue = Boolean(semMap && semMap.size > 0);
    const getLexExamples = (c) => {
      const learned = this.getLearnedExamples(c.fullToolName);
      const catEntry = this.catalogEntries.get(c.fullToolName) || this.catalogEntries.get(c.toolName);
      return catEntry?.examples ? [...catEntry.examples, ...learned] : learned;
    };
    const { strict: strictLex, partial: partialLex } = scoreLexicalToolsBM25F(
      list,
      tier1Ids,
      queryLower,
      queryTokens,
      getLexExamples,
      { semanticRescue: isSemanticRescue },
    );

    const normalizeRescueScore = (rawScore) =>
      Math.round(Math.min(minScore - 0.005, 0.44 + 0.08 * (rawScore / (rawScore + 5))) * 1000) / 1000;

    const strictAll = [...tier1, ...strictLex];
    if (strictAll.length > 0) {
      const ambig = detectCrossConnectionAmbiguity(strictAll, queryTokens, { isSemantic: false, connFilter });
      const diverse = connFilter
        ? strictAll.map((e) => e.item)
        : applyPerConnectionCap(strictAll, { maxPerConnection, pageSize, diversityBand: 1.5 });
      return {
        items: diverse,
        matchMode: ambig.ambiguous || isSemanticRescue ? 'partial' : 'strict',
        gear: isSemanticRescue ? gear : 'lexical',
        topScore: isSemanticRescue ? normalizeRescueScore(strictAll[0].score) : strictAll[0].score,
        lowConfidence: ambig.ambiguous || isSemanticRescue,
        needsWarmup,
        ambiguous: ambig.ambiguous,
        ...(ambig.ambiguous ? { ambiguousConnections: ambig.ambiguousConnections } : {}),
      };
    }

    if (partialLex.length > 0) {
      const ambig = detectCrossConnectionAmbiguity(partialLex, queryTokens, { isSemantic: false, connFilter });
      const diverse = connFilter
        ? partialLex.map((e) => e.item)
        : applyPerConnectionCap(partialLex, { maxPerConnection, pageSize, diversityBand: 1.0 });
      return {
        items: diverse,
        matchMode: 'partial',
        gear: isSemanticRescue ? gear : 'lexical',
        topScore: isSemanticRescue ? normalizeRescueScore(partialLex[0].score) : partialLex[0].score,
        lowConfidence: true,
        needsWarmup,
        ambiguous: ambig.ambiguous,
        ...(ambig.ambiguous ? { ambiguousConnections: ambig.ambiguousConnections } : {}),
      };
    }

    return {
      items: [],
      matchMode: 'none',
      gear: isSemanticRescue ? gear : 'lexical',
      topScore: 0,
      lowConfidence: true,
      needsWarmup,
      ambiguous: false,
    };
  }

  /* ---- Hybrid Search v3: exact + semantic + BM25F fused by RRF, then optional rerank ---- */

  _rerankThreshold() {
    const v = Number(process.env.LOOP_RERANK_MIN_SCORE);
    if (Number.isFinite(v) && v > 0) return v;
    const p = Number(this.reranker?.noMatchBelow);
    return Number.isFinite(p) && p > 0 ? p : 0.1;
  }

  async _applyRerank(ranked, query, textFor, { signal = null, boostIds = null } = {}) {
    if (!this.reranker || typeof this.reranker.isAvailable !== 'function' || !this.reranker.isAvailable()) {
      return { ranked, reranked: false, topRr: null };
    }
    if (ranked.length < 1) return { ranked, reranked: false, topRr: null };
    const depth = Math.max(2, Number(this.reranker.depth) || 20);
    const head = ranked.slice(0, depth);
    let scores = null;
    try {
      scores = await this.reranker.rerank(query, head.map((e) => textFor(e.item)), { signal });
    } catch {
      scores = null;
    }
    if (!Array.isArray(scores) || scores.length !== head.length) return { ranked, reranked: false, topRr: null };
    const maxFused = head[0].score || 1;
    for (let i = 0; i < head.length; i += 1) {
      const e = head[i];
      e.rr = scores[i];
      e.final = scores[i] + 0.15 * (e.score / maxFused) + (boostIds && boostIds.has(e.id) ? 1 : 0);
    }
    head.sort((a, b) => b.final - a.final);
    return { ranked: [...head, ...ranked.slice(depth)], reranked: true, topRr: head[0].rr };
  }

  async _searchToolsHybrid(candidates, query, { connFilter = '', maxPerConnection = DEFAULT_MAX_PER_CONNECTION, pageSize = DEFAULT_TOOL_SEARCH_LIMIT, minSemanticScore = null, signal = null, rerank = true } = {}) {
    const softMin = this.effectiveSoftMinSemanticScore(minSemanticScore);
    const minScore = this.effectiveMinSemanticScore(minSemanticScore);
    const list = Array.isArray(candidates) ? candidates : [];
    const cleanQuery = String(query || '').trim().slice(0, MAX_SEARCH_QUERY_CHARS);
    const queryLower = cleanQuery.toLowerCase();
    const queryTokens = tokenizeQuery(cleanQuery);
    const byId = new Map();
    for (let i = 0; i < list.length; i += 1) byId.set(list[i].fullToolName, list[i]);

    // 1. Exact identifiers (never prose).
    const exact = [];
    const exactStructuralIds = new Set();
    const namePriority = new Map();
    for (const c of list) {
      const r = scoreTier1ExactTool(c, queryLower, queryTokens);
      if (r.score > 0) {
        exact.push({ id: c.fullToolName, score: r.score });
        if (r.exactStructural) exactStructuralIds.add(c.fullToolName);
        if (r.namePriority) namePriority.set(c.fullToolName, r.namePriority);
      }
    }
    exact.sort((a, b) => b.score - a.score);

    // 2. Semantic (description + catalog/learned examples), with per-clause lists for multi-step needs.
    const sem = await this._scoreKindSemantic('tool', cleanQuery, new Set(byId.keys()), { signal, multiClause: true });
    const qStems = [...new Set(queryTokens.map((t) => stemToken(t)).filter(Boolean))];
    const semScore = new Map();
    const semList = [];
    if (sem.scores) {
      for (const [id, rec] of sem.scores) {
        const c = byId.get(id);
        if (!c) continue;
        const det = combineDescAndExampleDetail(rec);
        const s = Math.min(1, det.score + gatedStructuredIdBonus(c, qStems, det.score, softMin));
        semScore.set(id, s);
        if (s >= softMin - 0.1) semList.push({ id, score: s });
      }
      semList.sort((a, b) => b.score - a.score);
    }
    const clauseLists = [];
    for (const cMap of sem.clauseScores || []) {
      const cl = [];
      for (const [id, rec] of cMap) {
        if (!byId.has(id)) continue;
        const s = combineDescAndExampleDetail(rec).score;
        if (s >= softMin) cl.push({ id, score: s });
      }
      cl.sort((a, b) => b.score - a.score);
      clauseLists.push(cl.slice(0, 10));
    }

    // 3. Lexical BM25F over name, description, params, connection, examples.
    const getLexExamples = (c) => {
      const learned = this.getLearnedExamples(c.fullToolName);
      const catEntry = this.catalogEntries.get(c.fullToolName) || this.catalogEntries.get(c.toolName);
      return catEntry?.examples ? [...catEntry.examples, ...learned] : learned;
    };
    const { strict, partial } = scoreLexicalToolsBM25F(list, new Set(), queryLower, queryTokens, getLexExamples, { semanticRescue: false });
    const lexList = [...strict, ...partial].slice(0, 100).map((e) => ({ id: e.item.fullToolName, score: e.score }));

    // 4. Fuse.
    const hasSem = semList.length > 0;
    const fused = rrfFuse(
      [semList.slice(0, 100), lexList, exact, ...clauseLists],
      [1, hasSem ? hybridWeight('LOOP_HYBRID_TOOL_LEX', 0.3) : 1, 2, ...clauseLists.map(() => hybridWeight('LOOP_HYBRID_CLAUSE', 0.5))],
    );
    // Evidence floor: a tool must match an identifier, match lexically, or clear the soft
    // semantic floor. RRF alone would otherwise surface a long tail of weak neighbours.
    const lexIds = new Set(lexList.map((e) => e.id));
    const exactIds = new Set(exact.map((e) => e.id));
    const clauseIds = new Set(clauseLists.flat().map((e) => e.id));
    let ranked = [...fused.entries()]
      .map(([id, score]) => ({ id, score, item: byId.get(id) }))
      .filter((e) => e.item && (exactIds.has(e.id) || lexIds.has(e.id) || clauseIds.has(e.id) || (semScore.get(e.id) ?? -1) >= softMin - 0.05))
      .sort((a, b) => b.score - a.score);

    // Brand-new tools that are not embedded yet: still findable lexically, and ask for a warmup.
    let sawUnindexed = false;
    if (sem.scores) {
      for (const id of byId.keys()) {
        if (!this.localStore.hasParent('tool', id)) {
          sawUnindexed = true;
          break;
        }
      }
    }

    // Same tool name offered by several Connections and the query names none of them.
    const ambigBase = hasSem
      ? semList.slice(0, 8).map((e) => ({ item: byId.get(e.id), score: e.score }))
      : [...strict, ...partial].slice(0, 8).map((e) => ({ item: e.item, score: e.score }));
    const ambig = detectCrossConnectionAmbiguity(ambigBase, queryTokens, { isSemantic: hasSem, connFilter });

    // 5. Rerank the head with full text.
    const rr = rerank ? await this._applyRerank(ranked, cleanQuery, toolRerankText, { signal, boostIds: exactStructuralIds }) : { ranked, reranked: false, topRr: null };
    ranked = pinExactNames(rr, namePriority);

    // 6. Confidence.
    const topSem = hasSem ? semList[0].score : -1;
    let noGoodMatch;
    if (exactStructuralIds.size > 0) noGoodMatch = false;
    else if (rr.reranked) noGoodMatch = rr.topRr < this._rerankThreshold();
    // Without a reranker, embedding similarity separates "no fitting tool" from real matches only
    // weakly (bge-base on real queries: none-cases 0.52-0.78 vs matches 0.52-0.93), so flag only
    // the clear cases and leave the rest to the calling agent via lowConfidence.
    else if (hasSem) noGoodMatch = topSem < minScore + 0.12 && strict.length === 0;
    // A corroborated lexical lead is worth inspecting, but remains partial and low-confidence.
    else noGoodMatch = strict.length === 0 && exact.length === 0 && !partial[0]?.strongPartial;
    // Two tools of the same Connection tied in embedding space: let the agent look at both.
    const top0 = ranked[0];
    const top1 = ranked[1];
    const tightSameConnTie = Boolean(
      !rr.reranked && hasSem && top0 && top1 && !exactStructuralIds.has(top0.id) &&
      top0.item.connId === top1.item.connId &&
      Math.abs((semScore.get(top0.id) ?? 0) - (semScore.get(top1.id) ?? 0)) < 0.025,
    );
    const confident =
      exactStructuralIds.size > 0 ||
      (!noGoodMatch && !tightSameConnTie && !ambig.ambiguous && (rr.reranked ? rr.topRr >= 0.5 : hasSem ? topSem >= minScore + 0.22 : strict.length > 0));

    const wrapped = ranked.map((e) => ({ item: e.item, score: e.final ?? e.score, tier: 2 }));
    const items = connFilter ? wrapped.map((e) => e.item) : applyPerConnectionCap(wrapped, { maxPerConnection, pageSize });
    const topScore = rr.reranked ? rr.topRr : hasSem ? topSem : ranked[0]?.score || 0;
    return {
      items,
      matchMode: items.length === 0 ? 'none' : confident ? 'strict' : 'partial',
      gear: sem.gear || 'lexical',
      topScore: Math.round((topScore || 0) * 1000) / 1000,
      lowConfidence: !confident,
      noGoodMatch: items.length === 0 || noGoodMatch,
      reranked: rr.reranked,
      needsWarmup: Boolean(sem.needsWarmup) || sawUnindexed,
      ambiguous: ambig.ambiguous,
      ...(ambig.ambiguous ? { ambiguousConnections: ambig.ambiguousConnections } : {}),
      strategy: 'hybrid',
      signals: { topSem: Math.round(topSem * 1000) / 1000, strictLex: strict.length, exact: exact.length, topRr: rr.topRr },
    };
  }

  async _searchSkillsHybrid(skills, query, { minSemanticScore = null, signal = null, rerank = true } = {}) {
    const softMin = this.effectiveSoftMinSemanticScore(minSemanticScore);
    const minScore = this.effectiveMinSemanticScore(minSemanticScore);
    const list = Array.isArray(skills) ? skills : [];
    const cleanQuery = String(query || '').trim().slice(0, MAX_SEARCH_QUERY_CHARS);
    const qLower = cleanQuery.toLowerCase();
    const qTokens = tokenizeQuery(cleanQuery);
    const byId = new Map(list.map((s) => [s.id, s]));

    const exact = [];
    for (const s of list) {
      const idLow = String(s.id || '').toLowerCase();
      const nameLow = String(s.name || '').toLowerCase();
      if (idLow === qLower || nameLow === qLower) exact.push({ id: s.id, score: 1000 });
    }
    const exactIds = new Set(exact.map((e) => e.id));

    const sem = await this._scoreKindSemantic('skill', cleanQuery, new Set(byId.keys()), { signal });
    const descList = [];
    const bodyList = [];
    const semBest = new Map();
    if (sem.scores) {
      for (const [id, rec] of sem.scores) {
        if (!byId.has(id)) continue;
        const d = rec.hasDesc || rec.hasCatEx ? combineDescAndExampleDetail(rec).score : -1;
        if (d >= softMin - 0.1) descList.push({ id, score: d });
        if (rec.hasBody && rec.bestBody >= softMin - 0.1) bodyList.push({ id, score: rec.bestBody });
        semBest.set(id, Math.max(d, rec.hasBody ? rec.bestBody - 0.03 : -1));
      }
      descList.sort((a, b) => b.score - a.score);
      bodyList.sort((a, b) => b.score - a.score);
    }
    const lexList = scoreSkillsBM25(list, qTokens, (id) => this.skillExamples.get(id)).slice(0, 100);
    const hasSem = descList.length > 0 || bodyList.length > 0;
    const fused = rrfFuse([descList.slice(0, 100), bodyList.slice(0, 100), lexList, exact], [1, hybridWeight('LOOP_HYBRID_SKILL_BODY', 0.8), hasSem ? hybridWeight('LOOP_HYBRID_SKILL_LEX', 0.8) : 1, 2]);
    const skillLexIds = new Set(lexList.map((e) => e.id));
    let ranked = [...fused.entries()]
      .map(([id, score]) => ({ id, score, item: byId.get(id) }))
      .filter((e) => e.item && (exactIds.has(e.id) || skillLexIds.has(e.id) || (semBest.get(e.id) ?? -1) >= softMin))
      .sort((a, b) => b.score - a.score);
    const rr = rerank ? await this._applyRerank(ranked, cleanQuery, skillRerankText, { signal, boostIds: exactIds }) : { ranked, reranked: false, topRr: null };
    ranked = pinExactNames(rr, exactIds);

    const topSem = hasSem ? Math.max(...semBest.values()) : -1;
    let noGoodMatch;
    if (exactIds.size > 0) noGoodMatch = false;
    else if (rr.reranked) noGoodMatch = rr.topRr < this._rerankThreshold();
    else if (hasSem) noGoodMatch = topSem < softMin;
    else noGoodMatch = lexList.length === 0;
    const confident = exactIds.size > 0 || (!noGoodMatch && (rr.reranked ? rr.topRr >= 0.5 : hasSem ? topSem >= minScore + 0.05 : lexList.length > 0));
    const topScore = rr.reranked ? rr.topRr : topSem;
    // Compare evidence before fusion: adjacent RRF ranks nearly always look tied.
    const skillNearTie = ranked.length > 1 && (hasSem
      ? semBest.has(ranked[0].id) && semBest.has(ranked[1].id) && Math.abs(semBest.get(ranked[0].id) - semBest.get(ranked[1].id)) < 0.04
      : lexList.length > 1 && lexList[1].score >= 0.8 * lexList[0].score);
    // Skills with evidence close to the best one's come first, and `focused` counts them. Keyword
    // scores alone separate Skills too poorly for this.
    let focused = 0;
    if (hasSem && !rr.reranked && ranked.length > 0) {
      const lexScores = new Map(lexList.map((e) => [e.id, e.score]));
      const minSem = topSem - SKILL_FOCUS_SEMANTIC_BAND;
      const minLex = SKILL_FOCUS_LEXICAL_RATIO * (lexList[0]?.score ?? Infinity);
      const close = new Set(ranked.filter((e, i) =>
        i === 0 || exactIds.has(e.id) || (semBest.get(e.id) ?? -1) >= minSem || (lexScores.get(e.id) ?? -1) >= minLex));
      ranked = [...close, ...ranked.filter((e) => !close.has(e))];
      focused = close.size;
    }
    return {
      items: ranked.map((e) => e.item),
      matchMode: ranked.length === 0 ? 'none' : confident ? 'strict' : 'partial',
      gear: sem.gear || 'lexical',
      topScore: Math.round(Math.max(0, topScore || 0) * 1000) / 1000,
      lowConfidence: !confident,
      noGoodMatch: ranked.length === 0 || noGoodMatch,
      reranked: rr.reranked,
      ...(focused > 0 ? { focused } : {}),
      strategy: 'hybrid',
      signals: { topSem: Math.round(topSem * 1000) / 1000, lex: lexList.length, topLex: lexList[0]?.score ?? 0, exact: exact.length, skillNearTie, topRr: rr.topRr },
    };
  }

  /* ---- Skill Search (Tier 1 Exact -> Tier 2 Semantic or Lexical) ---- */

  async searchSkills(skills, query, { minSemanticScore = null, signal = null, strategy = null, rerank = true } = {}) {
    if ((strategy || this.strategy) === 'hybrid' && String(query || '').trim()) {
      return this._searchSkillsHybrid(skills, query, { minSemanticScore, signal, rerank });
    }
    const minScore = this.effectiveMinSemanticScore(minSemanticScore);
    const list = Array.isArray(skills) ? skills : [];
    const cleanQuery = String(query || '').trim().slice(0, MAX_SEARCH_QUERY_CHARS);
    if (!cleanQuery) return { items: list, matchMode: 'all', gear: this.resolveGear() };

    const qLower = cleanQuery.toLowerCase();
    const qTokens = tokenizeQuery(cleanQuery);

    const tier1 = [];
    const tier1Ids = new Set();
    for (let i = 0; i < list.length; i += 1) {
      const s = list[i];
      const idLow = String(s.id || '').toLowerCase();
      const nameLow = String(s.name || '').toLowerCase();
      let exact = 0;
      if (idLow === qLower || nameLow === qLower) exact = 1000;
      else if (qTokens.length > 0) {
        const toks = new Set([...splitIdentifiers(s.id), ...splitIdentifiers(s.name)]);
        if (qTokens.every((t) => toks.has(t))) exact = 850;
      }
      if (exact > 0) {
        tier1.push({ item: s, score: exact, idx: i });
        tier1Ids.add(s.id);
      }
    }
    tier1.sort((a, b) => b.score - a.score || a.idx - b.idx);

    const allowedIds = new Set(list.map((s) => s.id));
    const { scores: semMap, gear } = await this._scoreKindSemantic('skill', cleanQuery, allowedIds, { signal });

    if (semMap && semMap.size > 0) {
      const softMinScore = this.effectiveSoftMinSemanticScore(minSemanticScore);
      const rawTier2 = [];
      const softTier2 = [];
      const unindexed = [];
      for (let i = 0; i < list.length; i += 1) {
        const s = list[i];
        if (tier1Ids.has(s.id)) continue;
        const rec = semMap.get(s.id);
        if (rec) {
          const sim = combineDescAndExampleSim(rec);
          if (sim >= minScore) rawTier2.push({ item: s, score: sim, idx: i });
          else if (sim >= softMinScore) softTier2.push({ item: s, score: sim, idx: i });
        } else if (!this.localStore.hasParent('skill', s.id)) {
          const hay = `${s.id} ${s.name} ${s.description || ''}`.toLowerCase();
          const stemSet = new Set(tokenizeStemmed(hay));
          const qStems = qTokens.map((t) => stemToken(t));
          if (hay.includes(qLower) || (qStems.length > 0 && qStems.every((t) => stemSet.has(t)))) {
            unindexed.push({ item: s, score: 1, idx: i });
          }
        }
      }
      rawTier2.sort((a, b) => b.score - a.score || a.idx - b.idx);
      softTier2.sort((a, b) => b.score - a.score || a.idx - b.idx);
      let tier2;
      let usedSoft = false;
      if (rawTier2.length > 0) {
        const topS = rawTier2[0].score;
        const relFloor = topS > minScore + 0.08 ? Math.max(minScore, topS - 0.11) : minScore;
        tier2 = rawTier2.filter((e) => e.score >= relFloor);
      } else if (tier1.length === 0 && unindexed.length === 0 && softTier2.length > 0) {
        tier2 = softTier2.filter((e) => e.score >= Math.max(softMinScore, softTier2[0].score - 0.035)).slice(0, 5);
        usedSoft = true;
      } else {
        tier2 = [];
      }
      const merged = [...tier1, ...tier2, ...unindexed];
      if (merged.length > 0) {
        const topScore = Math.round(merged[0].score * 1000) / 1000;
        return {
          items: merged.map((e) => e.item),
          matchMode: usedSoft ? 'partial' : 'strict',
          gear,
          topScore,
          lowConfidence: usedSoft,
        };
      }
    }

    // Lexical fallback (stemmed whole-token + prefix + typo tolerance)
    const isSkillSemanticRescue = Boolean(semMap && semMap.size > 0);
    const strict = [...tier1];
    const partial = [];
    const qStems = [...new Set(qTokens.map((t) => stemToken(t)).filter(Boolean))];
    const sigStems = qStems.filter((t) => t.length >= 3);
    for (let i = 0; i < list.length; i += 1) {
      const s = list[i];
      if (tier1Ids.has(s.id)) continue;
      const hay = `${s.id} ${s.name} ${s.description || ''} ${s.source || ''} ${s.category || ''} ${s.categoryLabel || ''}`.toLowerCase();
      const stemSet = new Set(tokenizeStemmed(hay));
      if (hay.includes(qLower)) {
        strict.push({ item: s, score: 200, idx: i });
      } else if (qStems.length > 0 && qStems.every((t) => stemSet.has(t) || hasPrefixInSet(stemSet, t) || hasFuzzyInSet(stemSet, t))) {
        strict.push({ item: s, score: 120 + qStems.length * 10, idx: i });
      } else if (sigStems.length >= 2) {
        const hits = sigStems.filter((t) => stemSet.has(t) || hasFuzzyInSet(stemSet, t)).length;
        if (hits >= (sigStems.length >= 5 ? 2 : 1)) partial.push({ item: s, score: hits * 20, idx: i });
      }
    }
    strict.sort((a, b) => b.score - a.score || a.idx - b.idx);
    if (strict.length > 0) {
      return {
        items: strict.map((e) => e.item),
        matchMode: isSkillSemanticRescue ? 'partial' : 'strict',
        gear: isSkillSemanticRescue ? gear : 'lexical',
        topScore: isSkillSemanticRescue ? Math.round((minScore - 0.01) * 1000) / 1000 : strict[0].score,
        lowConfidence: isSkillSemanticRescue,
      };
    }
    partial.sort((a, b) => b.score - a.score || a.idx - b.idx);
    return {
      items: partial.map((e) => e.item),
      matchMode: partial.length > 0 ? 'partial' : 'none',
      gear: isSkillSemanticRescue ? gear : 'lexical',
      topScore: partial.length > 0 ? (isSkillSemanticRescue ? Math.round((minScore - 0.02) * 1000) / 1000 : partial[0].score) : 0,
      lowConfidence: true,
    };
  }

  /* ---- Connection Search (Used for type: "connections" and Zoom-Out Map) ---- */

  async searchConnections(conns, query, getHaystack, { minSemanticScore = null, signal = null } = {}) {
    const minScore = this.effectiveMinSemanticScore(minSemanticScore);
    const list = Array.isArray(conns) ? conns : [];
    const cleanQuery = String(query || '').trim().slice(0, MAX_SEARCH_QUERY_CHARS);
    if (!cleanQuery) return { items: list, matchMode: 'all', gear: this.resolveGear(), topScore: 1, lowConfidence: false, named: list.length };

    const qLower = cleanQuery.toLowerCase();
    const qTokens = tokenizeQuery(cleanQuery);

    const tier1 = [];
    const tier1Ids = new Set();
    // How many Connections the query names: a word of it is in their id or name, however it is spaced.
    let named = 0;
    const flat = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const qFlat = flat(cleanQuery);
    const namesFlat = (name) => name.length >= 3 && qFlat.length >= 3 && (name.includes(qFlat) || qFlat.includes(name));
    for (let i = 0; i < list.length; i += 1) {
      const c = list[i];
      const idLow = String(c.id || '').toLowerCase();
      const nameLow = String(c.name || '').toLowerCase();
      const toks = new Set([...splitIdentifiers(c.id), ...splitIdentifiers(c.name)]);
      let exact = 0;
      if (idLow === qLower || nameLow === qLower) exact = 1000;
      else if (qTokens.length > 0 && qTokens.every((t) => toks.has(t))) exact = 850;
      if (exact > 0 || qTokens.some((t) => toks.has(t)) || namesFlat(flat(c.id)) || namesFlat(flat(c.name))) named += 1;
      if (exact > 0) {
        tier1.push({ item: c, score: exact, idx: i });
        tier1Ids.add(c.id);
      }
    }
    tier1.sort((a, b) => b.score - a.score || a.idx - b.idx);

    const allowedIds = new Set(list.map((c) => c.id));
    const { scores: semMap, gear } = await this._scoreKindSemantic('connection', cleanQuery, allowedIds, { signal });

    if (semMap && semMap.size > 0) {
      const softMinScore = this.effectiveSoftMinSemanticScore(minSemanticScore);
      const rawTier2 = [];
      const softTier2 = [];
      const unindexed = [];
      for (let i = 0; i < list.length; i += 1) {
        const c = list[i];
        if (tier1Ids.has(c.id)) continue;
        const rec = semMap.get(c.id);
        if (rec) {
          const sim = combineDescAndExampleSim(rec);
          if (sim >= minScore) rawTier2.push({ item: c, score: sim, idx: i });
          else if (sim >= softMinScore) softTier2.push({ item: c, score: sim, idx: i });
        } else if (!this.localStore.hasParent('connection', c.id)) {
          const hay = String(getHaystack ? getHaystack(c) : `${c.id} ${c.name} ${c.description || ''}`).toLowerCase();
          const stemSet = new Set(tokenizeStemmed(hay));
          const qStems = qTokens.map((t) => stemToken(t));
          if (hay.includes(qLower) || (qStems.length > 0 && qStems.every((t) => stemSet.has(t)))) {
            unindexed.push({ item: c, score: 1, idx: i });
          }
        }
      }
      rawTier2.sort((a, b) => b.score - a.score || a.idx - b.idx);
      softTier2.sort((a, b) => b.score - a.score || a.idx - b.idx);
      const usedSoft = rawTier2.length === 0 && tier1.length === 0 && unindexed.length === 0 && softTier2.length > 0;
      const tier2 = usedSoft
        ? softTier2.filter((e) => e.score >= Math.max(softMinScore, softTier2[0].score - 0.035)).slice(0, 6)
        : rawTier2;
      const merged = [...tier1, ...tier2, ...unindexed];
      if (merged.length > 0) {
        const topScore = Math.round(merged[0].score * 1000) / 1000;
        return {
          items: merged.map((e) => e.item),
          matchMode: usedSoft ? 'partial' : 'strict',
          gear,
          topScore,
          lowConfidence: usedSoft,
          named,
        };
      }
    }

    const strict = [...tier1];
    const partial = [];
    const qStems = [...new Set(qTokens.map((t) => stemToken(t)).filter(Boolean))];
    const sigStems = qStems.filter((t) => t.length >= 3);
    for (let i = 0; i < list.length; i += 1) {
      const c = list[i];
      if (tier1Ids.has(c.id)) continue;
      const hay = String(getHaystack ? getHaystack(c) : `${c.id} ${c.name} ${c.description || ''}`).toLowerCase();
      const stemSet = new Set(tokenizeStemmed(hay));
      if (hay.includes(qLower)) {
        strict.push({ item: c, score: 200, idx: i });
      } else if (qStems.length > 0 && qStems.every((t) => stemSet.has(t) || hasPrefixInSet(stemSet, t) || hasFuzzyInSet(stemSet, t))) {
        strict.push({ item: c, score: 120 + qStems.length * 10, idx: i });
      } else if (sigStems.length >= 2) {
        const hits = sigStems.filter((t) => stemSet.has(t) || hasFuzzyInSet(stemSet, t)).length;
        if (hits >= (sigStems.length >= 5 ? 2 : 1)) partial.push({ item: c, score: hits * 20, idx: i });
      }
    }
    strict.sort((a, b) => b.score - a.score || a.idx - b.idx);
    if (strict.length > 0) {
      return { items: strict.map((e) => e.item), matchMode: 'strict', gear: 'lexical', topScore: strict[0].score, lowConfidence: false, named };
    }
    partial.sort((a, b) => b.score - a.score || a.idx - b.idx);
    return {
      items: partial.map((e) => e.item),
      matchMode: partial.length > 0 ? 'partial' : 'none',
      gear: 'lexical',
      topScore: partial.length > 0 ? partial[0].score : 0,
      lowConfidence: true,
      named,
    };
  }

  /* ---- Memory Semantic Scores (Feeds Directly into MemoryStore.searchMemories) ---- */

  async scoreMemoriesSemantic(memories, query, { signal = null } = {}) {
    const cleanQuery = String(query || '').trim().slice(0, MAX_SEARCH_QUERY_CHARS);
    if (!cleanQuery || !Array.isArray(memories) || memories.length === 0) return null;
    if (!this.embedder || !this.embedder.isAvailable()) return null;

    const allowedIds = new Set(memories.map((m) => m.id));
    const { scores: semMap } = await this._scoreKindSemantic('memory', cleanQuery, allowedIds, { signal });
    if (!semMap || semMap.size === 0) return null;

    const out = new Map();
    for (const [id, rec] of semMap.entries()) {
      const sim = combineDescAndExampleSim(rec);
      if (sim > 0) out.set(id, sim);
    }
    return out.size > 0 ? out : null;
  }

  /* ---- Diagnostics & Lifecycle ---- */

  async getStatus() {
    await this._ensureLearnedLoaded();
    const embedInfo = this.embedder ? this.embedder.getInfo() : createNullEmbedder().getInfo();
    const gear = this.resolveGear();
    let learnedExampleCount = 0;
    for (const list of this.learned.values()) learnedExampleCount += list.length;

    const upgradeRecommended = gear === 'lexical' && this._aboveSemanticThreshold();

    return {
      strategy: this.strategy,
      reranker: this.reranker?.getInfo ? this.reranker.getInfo() : { provider: 'none' },
      enrichment: { tools: [...this.catalogEntries.values()].filter((e) => e.enriched).length, skills: this.skillExamples.size },
      indexSkillBodies: this.indexSkillBodies,
      gear,
      hosted: this.hosted,
      autoSemanticThreshold: this.autoSemanticThreshold,
      semanticMinTools: this.semanticMinTools,
      semanticMinConnections: this.semanticMinConnections,
      semanticMinSkills: AUTO_SEMANTIC_MIN_SKILLS,
      semanticMinMemories: AUTO_SEMANTIC_MIN_MEMORIES,
      upgradeRecommended,
      ...(upgradeRecommended
        ? {
            upgradeReason: `Hub has ${this._lastToolCount} tools across ${this._lastConnCount} Connections, ${this._lastSkillCount} Skills and ${this._lastMemoryCount} memories (semantic search recommended from ${this.semanticMinTools} tools, ${this.semanticMinConnections} Connections, ${AUTO_SEMANTIC_MIN_SKILLS} Skills or ${AUTO_SEMANTIC_MIN_MEMORIES} memories).`,
          }
        : {}),
      toolCount: this._lastToolCount,
      connectionCount: this._lastConnCount,
      skillCount: this._lastSkillCount,
      memoryCount: this._lastMemoryCount,
      embedder: embedInfo,
      localVectors: this.localStore.stats(),
      catalogEnrichedTools: this.catalogEntries.size,
      learnedTools: this.learned.size,
      learnedExamples: learnedExampleCount,
      lastSync: this._lastSyncStats,
    };
  }

  async flush() {
    await Promise.all([
      this.localStore.flush().catch(() => {}),
      this._saveLearned().catch(() => {}),
    ]);
  }

  async close() {
    await this.flush();
    this.recentSearches.clear();
  }
}
