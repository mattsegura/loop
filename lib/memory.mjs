// Loop Semantic Memory Store — portable cross-agent facts, preferences, and project context
// with per-workspace isolation, provenance tagging, pinned turn-1 context, secret guard,
// smart local recall (BM25 + concept synonyms + fuzzy + graph neighbors), typed relationships,
// conflict detection, configurable external/hybrid coexistence, and read-only importers/sync
// for Claude Code, Codex, Cursor, Windsurf, Gemini, OpenCode, watched Markdown folders,
// and pasted ChatGPT exports.

import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { currentRevision, updatedRevisions, validateRevision } from './sync-revisions.mjs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_PROFILES,
  PROFILE_CONTROL_RE,
  itemMatchesProfile,
  normalizeItemProfiles,
  normalizeProfileTag,
  stripProfileFromItemProfiles,
} from './profiles.mjs';
import { defaultDataDir } from './vault.mjs';
import { memoryPinnedBy } from './context-names.mjs';

export const MEMORY_SCOPES = Object.freeze(['global', 'preference', 'project', 'fact']);
const SCOPE_SET = new Set(MEMORY_SCOPES);

export const MEMORY_TRUST_TIERS = Object.freeze(['confirmed', 'owner_agent', 'guest_agent', 'imported']);
const TRUST_TIER_SET = new Set(MEMORY_TRUST_TIERS);

export function computeMemoryTrustTier(raw = {}) {
  const actor = String(raw?.actor || '').trim().toLowerCase();
  if (actor === 'guest') return 'guest_agent';
  if (actor === 'owner') return 'confirmed';
  if (actor === 'import' || actor === 'imported') return 'imported';
  if (actor === 'agent') return 'owner_agent';
  if (TRUST_TIER_SET.has(raw?.trustTier)) return raw.trustTier;
  const source = String(raw?.source || 'Manual').trim();
  const writtenBy = String(raw?.writtenBy || 'Owner').trim();
  if (/import|markdown|folder|external|chatgpt/i.test(source)) return 'imported';
  if (writtenBy === 'Owner' && source === 'Manual') return 'confirmed';
  return 'owner_agent';
}

export const MEMORY_RELATIONS = Object.freeze(['relates', 'extends', 'updates', 'contradicts']);
const RELATION_SET = new Set(MEMORY_RELATIONS);

export const MEMORY_MODES = Object.freeze(['local', 'external', 'off']);
const MODE_SET = new Set(MEMORY_MODES);

export const DEFAULT_MEMORY_CONFIG = Object.freeze({
  mode: 'local',
  externalConnectionId: '',
  syncFolders: Object.freeze([]),
  dismissedExternalIds: Object.freeze([]),
});

export const MAX_MEMORIES = 500;
export const MAX_PINNED_MEMORIES = 12;
export const MAX_CONTENT_LEN = 1000;
const MAX_LINKS_PER_MEMORY = 20;
const MAX_KEPT_WITH = 50;
const MEMORY_ID_RE = /^mem_[a-z0-9_-]+$/i;
const MAX_SYNC_FOLDERS = 5;
const MAX_FOLDER_FILES = 50;
const MAX_FOLDER_FILE_BYTES = 256 * 1024;

const SECRET_PATTERNS = [
  /\b(?:sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{18,}|sk-ant-[A-Za-z0-9_-]{18,})\b/,
  /\b(?:pk_live_[A-Za-z0-9_-]{16,}|rk_live_[A-Za-z0-9_-]{16,})\b/,
  /\b(?:ghp_[A-Za-z0-9]{24,}|gho_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{24,})\b/,
  /\b(?:xox[baprs]-[A-Za-z0-9-]{16,})\b/,
  /\b(?:AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})\b/,
  /\bloop_[A-Za-z0-9_-]{32,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/i,
  /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|password|passwd|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}["']?/i,
  /\b(?:\d[ -]*?){13,19}\b/,
];

function looksLikeCardNumber(text) {
  const digits = String(text || '').replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  // Luhn check so ordinary long IDs or timestamps don't false-positive.
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function looksLikeSecret(text) {
  const raw = String(text || '');
  if (!raw) return false;
  for (let i = 0; i < SECRET_PATTERNS.length - 1; i += 1) {
    if (SECRET_PATTERNS[i].test(raw)) return true;
  }
  const cardMatches = raw.match(/\b(?:\d[ -]?){13,19}\b/g);
  if (cardMatches) {
    for (const candidate of cardMatches) {
      if (looksLikeCardNumber(candidate)) return true;
    }
  }
  return false;
}

/**
 * Recursively checks arbitrary tool arguments (strings, arrays, plain objects) for raw secrets,
 * ignoring intentional {{vault:KEY}} placeholder references.
 */
export function containsSecretValue(value, depth = 0) {
  if (depth > 8 || value == null) return false;
  if (typeof value === 'string') {
    const stripped = value.replace(/\{\{vault:[^{}]+\}\}/g, '');
    return looksLikeSecret(stripped);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsSecretValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (containsSecretValue(k, depth + 1) || containsSecretValue(v, depth + 1)) return true;
    }
  }
  return false;
}

export function isExternalMemoryWriteTool(conn, toolName) {
  const name = String(toolName || '').trim();
  if (!name) return false;
  const picked = pickExternalMemoryTools(conn);
  if (picked.saveTool && picked.saveTool.name === name) return true;
  return /^(add|save|store|create|update|write|remember|upsert|append|ingest).*(memor|entit|observation|fact|relation|knowledge)/i.test(name);
}

function slugifyKey(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function normalizeScope(raw) {
  const clean = String(raw || '').trim().toLowerCase();
  return SCOPE_SET.has(clean) ? clean : 'global';
}

function normalizeTags(tags) {
  const arr = Array.isArray(tags)
    ? tags
    : typeof tags === 'string'
      ? tags.split(',')
      : [];
  const seen = new Set();
  const out = [];
  for (const t of arr) {
    const clean = slugifyKey(t).slice(0, 32);
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
    if (out.length >= 10) break;
  }
  return out;
}

function normalizeLinks(links, selfId = '', selfKey = '') {
  if (!Array.isArray(links)) return [];
  const seen = new Set();
  const out = [];
  for (const item of links) {
    const rawTarget = typeof item === 'string' ? item : item?.target;
    const target = String(rawTarget || '').trim().slice(0, 80);
    if (!target || target === selfId || (selfKey && target === selfKey)) continue;
    const rawRel = typeof item === 'object' && item ? String(item.relation || 'relates').trim().toLowerCase() : 'relates';
    const relation = RELATION_SET.has(rawRel) ? rawRel : 'relates';
    const dedup = `${target}::${relation}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push({ target, relation });
    if (out.length >= MAX_LINKS_PER_MEMORY) break;
  }
  return out;
}

function hasSecretInLinks(links) {
  if (!Array.isArray(links)) return false;
  for (const item of links) {
    const rawTarget = typeof item === 'string' ? item : item?.target;
    if (rawTarget && looksLikeSecret(rawTarget)) return true;
  }
  return false;
}

function normalizeContent(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT_LEN);
}

function normalizeFingerprint(text) {
  return normalizeContent(text).toLowerCase();
}

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawMode = String(src.mode || 'local').trim().toLowerCase();
  // Map legacy hybrid/passthrough modes cleanly to the unified single-source 'external' mode.
  const mappedMode = rawMode === 'hybrid' || rawMode === 'passthrough' ? 'external' : rawMode;
  const mode = MODE_SET.has(mappedMode) ? mappedMode : 'local';
  const externalConnectionId = String(src.externalConnectionId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '')
    .slice(0, 64);
  const syncFolders = [];
  const seen = new Set();
  if (Array.isArray(src.syncFolders)) {
    for (const f of src.syncFolders) {
      const clean = String(f || '').trim().slice(0, 300);
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        syncFolders.push(clean);
      }
      if (syncFolders.length >= MAX_SYNC_FOLDERS) break;
    }
  }
  const dismissedExternalIds = [];
  const seenDismissed = new Set();
  if (Array.isArray(src.dismissedExternalIds)) {
    for (const id of src.dismissedExternalIds) {
      const clean = String(id || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '').slice(0, 64);
      if (clean && !seenDismissed.has(clean)) {
        seenDismissed.add(clean);
        dismissedExternalIds.push(clean);
      }
      if (dismissedExternalIds.length >= 20) break;
    }
  }
  return { mode, externalConnectionId, syncFolders, dismissedExternalIds };
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

function validateMemoryProfiles(raw) {
  if (typeof raw === 'string') {
    if (PROFILE_CONTROL_RE.test(raw)) {
      throw Object.assign(new Error('Memory profiles cannot contain control characters.'), { status: 400 });
    }
    return normalizeItemProfiles(raw);
  }
  if (!Array.isArray(raw)) {
    throw Object.assign(new Error('Memory profiles must be a string or an array of strings.'), { status: 400 });
  }
  if (raw.length > MAX_PROFILES) {
    throw Object.assign(new Error(`A memory can belong to at most ${MAX_PROFILES} profiles.`), { status: 400 });
  }
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw Object.assign(new Error('Each memory profile must be a string.'), { status: 400 });
    }
    if (PROFILE_CONTROL_RE.test(item)) {
      throw Object.assign(new Error('Memory profiles cannot contain control characters.'), { status: 400 });
    }
  }
  return normalizeItemProfiles(raw);
}

function makeUniqueMemoryKey(baseKey, list, excludeIdx = -1) {
  let uniqueKey = baseKey;
  let n = 2;
  while (list.some((m, i) => i !== excludeIdx && m.key === uniqueKey)) {
    const suffix = `-${n++}`;
    const stem = baseKey.slice(0, Math.max(1, 64 - suffix.length)).replace(/-+$/, '');
    uniqueKey = `${stem}${suffix}`;
  }
  return uniqueKey;
}

function normalizeEntry(raw) {
  const content = normalizeContent(raw?.content);
  if (!content) return null;
  const id = typeof raw?.id === 'string' && /^mem_[a-z0-9_-]+$/i.test(raw.id)
    ? raw.id
    : `mem_${randomBytes(6).toString('hex')}`;
  const key = slugifyKey(raw?.key) || slugifyKey(content.slice(0, 48)) || id;
  const now = new Date().toISOString();
  return {
    id,
    key,
    ...(raw?.scopeKey && slugifyKey(raw.scopeKey) !== key ? { scopeKey: slugifyKey(raw.scopeKey) } : {}),
    content,
    scope: normalizeScope(raw?.scope),
    project: String(raw?.project || '').trim().slice(0, 80),
    tags: normalizeTags(raw?.tags),
    links: normalizeLinks(raw?.links, id, key),
    pinned: Boolean(raw?.pinned),
    // Who pinned it: only owner pins reach other agents' startup context (lib/context-names.mjs).
    ...(raw?.pinned ? { pinnedBy: memoryPinnedBy({ pinned: true, pinnedBy: raw?.pinnedBy, writtenBy: raw?.writtenBy }) } : {}),
    profiles: normalizeItemProfiles(raw?.profiles),
    source: String(raw?.source || 'Manual').trim().slice(0, 60) || 'Manual',
    writtenBy: String(raw?.writtenBy || 'Owner').trim().slice(0, 80) || 'Owner',
    trustTier: computeMemoryTrustTier(raw),
    createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : now,
    ...(typeof raw?.ephemeral === 'boolean' ? { ephemeral: raw.ephemeral } : {}),
    // Tidy: a replaced or archived memory stays on disk (so it can be restored) but agents and
    // the map no longer see it. keptWith lists memories the owner chose to keep alongside this
    // one, so Tidy stops suggesting that pair.
    ...(typeof raw?.supersededBy === 'string' && MEMORY_ID_RE.test(raw.supersededBy) && raw.supersededBy !== id
      ? { supersededBy: raw.supersededBy, supersededAt: typeof raw?.supersededAt === 'string' ? raw.supersededAt : now }
      : {}),
    ...(raw?.archived
      ? { archived: true, supersededAt: typeof raw?.supersededAt === 'string' ? raw.supersededAt : now }
      : {}),
    ...(Array.isArray(raw?.keptWith) && raw.keptWith.some((x) => typeof x === 'string' && MEMORY_ID_RE.test(x) && x !== id)
      ? { keptWith: [...new Set(raw.keptWith.filter((x) => typeof x === 'string' && MEMORY_ID_RE.test(x) && x !== id))].slice(-MAX_KEPT_WITH) }
      : {}),
  };
}

export function isActiveMemory(m) {
  return Boolean(m) && !m.supersededBy && !m.archived;
}

export function keptTogether(a, b) {
  return (a.keptWith || []).includes(b.id) || (b.keptWith || []).includes(a.id);
}

const TEMPORARY_NOTE_RE = /\b(?:safe\s+to\s+delete|delete\s+me|temporary\b[\s\S]{0,40}\b(?:check|test|note|burst|probe|ping)|test\s+memory|scratch\s+note|throwaway\s+(?:note|check|test|memory))\b/i;

export function isTemporaryMemory(m) {
  if (!m || !isActiveMemory(m)) return false;
  if (m.ephemeral === true) return true;
  if (m.ephemeral === false) return false;
  if (m.pinned) return false;
  return TEMPORARY_NOTE_RE.test(String(m.content || ''));
}

// Who wrote it, as the platform knows it: the owner by hand in the hub, or an agent/import.
export function ownerWritten(m) {
  return (m.writtenBy || 'Owner') === 'Owner' && (m.source || 'Manual') === 'Manual';
}

// Which of two overlapping or conflicting memories Tidy suggests keeping: the owner's own words
// first, then a pinned one, then the most recently updated (the latest value wins).
export function suggestKeep(a, b) {
  if (ownerWritten(a) !== ownerWritten(b)) return ownerWritten(a) ? a : b;
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? a : b;
  const ta = Date.parse(a.updatedAt) || 0;
  const tb = Date.parse(b.updatedAt) || 0;
  if (ta !== tb) return ta > tb ? a : b;
  return a.content.length >= b.content.length ? a : b;
}

async function atomicWriteFile(filePath, content, mode = 0o600) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpFile = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    await writeFile(tmpFile, content, { mode });
    await chmod(tmpFile, mode);
    await rename(tmpFile, filePath);
  } catch (err) {
    await unlink(tmpFile).catch(() => {});
    throw err;
  }
}

/* ---------------- Smart Local Recall (BM25 + Concept Expansion + Fuzzy + Graph) ---------------- */

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'just', 'me', 'my', 'not', 'of', 'on', 'or', 'our', 'out', 'she', 'so', 'than', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'too', 'up', 'us', 'very',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would',
  'you', 'your', 'user', 'about', 'also', 'always', 'using', 'used', 'uses', 'make', 'like',
]);

// Domain concept clusters so queries like "tech stack" match "Node.js and TypeScript"
// and "answer style" matches "concise direct responses without emojis".
const CONCEPT_GROUPS = [
  ['stack', 'tech', 'technology', 'framework', 'language', 'runtime', 'node', 'nodejs', 'typescript', 'javascript', 'python', 'swift', 'swiftui', 'rust', 'go', 'react', 'nextjs', 'vanilla'],
  ['style', 'tone', 'format', 'formatting', 'response', 'responses', 'answer', 'answers', 'concise', 'short', 'terse', 'brief', 'direct', 'verbose', 'detailed', 'emoji', 'emojis', 'bullet', 'markdown', 'prose'],
  ['package', 'pkg', 'manager', 'npm', 'pnpm', 'yarn', 'bun', 'pip', 'uv', 'brew', 'homebrew'],
  ['editor', 'ide', 'cursor', 'vscode', 'zed', 'neovim', 'vim', 'windsurf', 'xcode', 'claude', 'codex', 'antigravity'],
  ['os', 'machine', 'platform', 'computer', 'laptop', 'mac', 'macos', 'apple', 'ios', 'linux', 'ubuntu', 'windows'],
  ['test', 'tests', 'testing', 'spec', 'unit', 'coverage', 'jest', 'vitest', 'pytest', 'tdd'],
  ['git', 'github', 'branch', 'commit', 'commits', 'pr', 'pull', 'merge', 'rebase', 'repo', 'repository'],
  ['workspace', 'directory', 'folder', 'path', 'project', 'codebase', 'monorepo', 'local'],
  ['deploy', 'deployment', 'hosting', 'ship', 'release', 'vercel', 'docker', 'cloudflare', 'aws', 'prod', 'production'],
  ['database', 'db', 'sql', 'sqlite', 'postgres', 'postgresql', 'mysql', 'redis', 'mongo', 'neo4j', 'supabase'],
  ['ui', 'ux', 'design', 'css', 'tailwind', 'theme', 'light', 'dark', 'font', 'layout', 'aesthetic', 'minimal'],
  ['indent', 'indentation', 'tabs', 'spaces', 'semicolon', 'semicolons', 'quotes', 'prettier', 'eslint', 'lint'],
  ['workflow', 'process', 'habit', 'preference', 'prefer', 'rule', 'rules', 'convention', 'guideline'],
  ['timezone', 'tz', 'location', 'city', 'country', 'schedule', 'hours', 'work', 'role', 'job'],
];

const CONCEPT_LOOKUP = new Map();
for (let i = 0; i < CONCEPT_GROUPS.length; i += 1) {
  for (const term of CONCEPT_GROUPS[i]) {
    const list = CONCEPT_LOOKUP.get(term) || [];
    list.push(i);
    CONCEPT_LOOKUP.set(term, list);
  }
}

function stemToken(raw) {
  let w = String(raw || '').toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  if (!w) return '';
  if (w === 'ts') return 'typescript';
  if (w === 'js') return 'javascript';
  if (w === 'nodejs' || w === 'node.js') return 'node';
  if (w === 'macos' || w === 'osx') return 'mac';
  if (w === 'prefs') return 'prefer';
  if (w === 'repo' || w === 'repos') return 'repository';
  if (w === 'db' || w === 'dbs') return 'database';
  if (w.length > 5 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed') && !w.endsWith('eed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es') && !w.endsWith('ses')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
    return w.slice(0, -1);
  }
  return w;
}

export function tokenizeText(text, { keepStop = false } = {}) {
  const raw = String(text || '').toLowerCase().match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g) || [];
  const out = [];
  for (const piece of raw) {
    const parts = piece.split(/[._-]+/).filter(Boolean);
    for (const p of parts) {
      if (p.length < 2) continue;
      if (!keepStop && STOP_WORDS.has(p)) continue;
      const stemmed = stemToken(p);
      if (stemmed && (keepStop || !STOP_WORDS.has(stemmed))) {
        out.push(stemmed);
      }
    }
  }
  return out;
}

function conceptIdsForTokens(tokens) {
  const ids = new Set();
  for (const t of tokens) {
    const groups = CONCEPT_LOOKUP.get(t);
    if (groups) {
      for (const g of groups) ids.add(g);
    }
  }
  return ids;
}

function charTrigrams(word) {
  const s = ` ${word} `;
  const set = new Set();
  for (let i = 0; i <= s.length - 3; i += 1) set.add(s.slice(i, i + 3));
  return set;
}

function fuzzyTokenMatch(qTok, docTokens) {
  if (qTok.length < 4) return 0;
  let best = 0;
  const qTri = charTrigrams(qTok);
  for (const dTok of docTokens) {
    if (dTok.length < 4) continue;
    if (dTok.startsWith(qTok) || qTok.startsWith(dTok)) {
      const ratio = Math.min(qTok.length, dTok.length) / Math.max(qTok.length, dTok.length);
      if (ratio >= 0.72) best = Math.max(best, 0.85 * ratio);
      continue;
    }
    if (Math.abs(dTok.length - qTok.length) > 2) continue;
    const dTri = charTrigrams(dTok);
    let overlap = 0;
    for (const tri of qTri) {
      if (dTri.has(tri)) overlap += 1;
    }
    const union = qTri.size + dTri.size - overlap;
    const jaccard = union > 0 ? overlap / union : 0;
    if (jaccard >= 0.5) best = Math.max(best, jaccard * 0.75);
  }
  return best;
}

/**
 * Ranks memories against a query using BM25 + field weighting + concept synonyms + fuzzy matching
 * + optional semantic similarity + 1-hop graph boost.
 * Returns sorted array of matching memories (or with scores when `withScores: true`).
 */
export function searchMemories(memories, query, { withScores = false, semanticScores = null, minSemanticScore = 0.34 } = {}) {
  const list = Array.isArray(memories) ? memories : [];
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) {
    const sorted = [...list].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
    return withScores ? sorted.map((memory) => ({ memory, score: 1 })) : sorted;
  }

  const qLower = cleanQuery.toLowerCase();
  const qTokens = [...new Set(tokenizeText(cleanQuery))];
  const qAllTokens = qTokens.length > 0 ? qTokens : [...new Set(tokenizeText(cleanQuery, { keepStop: true }))];
  const qConcepts = conceptIdsForTokens(qAllTokens);

  // Precompute document token stats for BM25 IDF across this workspace's memories.
  const docs = list.map((m) => {
    const metaTokens = tokenizeText(`${m.key} ${m.project} ${(m.tags || []).join(' ')} ${m.scope} ${m.source} ${m.writtenBy}`);
    const bodyTokens = tokenizeText(m.content);
    const allTokens = [...metaTokens, ...bodyTokens];
    const tf = new Map();
    for (const t of metaTokens) tf.set(t, (tf.get(t) || 0) + 2);
    for (const t of bodyTokens) tf.set(t, (tf.get(t) || 0) + 1);
    const uniqueTokens = new Set(allTokens);
    const concepts = conceptIdsForTokens(uniqueTokens);
    const hay = `${m.key} ${m.content} ${m.scope} ${m.project} ${(m.tags || []).join(' ')} ${m.source} ${m.writtenBy}`.toLowerCase();
    return { m, tf, uniqueTokens, len: allTokens.length || 1, concepts, hay };
  });

  const N = Math.max(docs.length, 1);
  const avgLen = docs.reduce((acc, d) => acc + d.len, 0) / N || 1;
  const df = new Map();
  for (const d of docs) {
    for (const t of d.uniqueTokens) df.set(t, (df.get(t) || 0) + 1);
  }

  const k1 = 1.4;
  const b = 0.65;
  const scoreMap = new Map();
  const reasonMap = new Map();
  // Pure semantic-only matches (with zero lexical or concept overlap) need a stronger cosine floor
  // so unrelated memories do not flood recall for queries like "loop-eval".
  const pureSemanticFloor = Math.max(minSemanticScore, 0.46);

  for (const d of docs) {
    let score = 0;
    let reason = '';
    if (d.hay.includes(qLower)) {
      score += 120;
      reason = 'exact';
    }

    let exactHits = 0;
    let fuzzyHits = 0;
    for (const qt of qAllTokens) {
      const freq = d.tf.get(qt) || 0;
      if (freq > 0) {
        exactHits += 1;
        const nDoc = df.get(qt) || 0;
        const idf = Math.log(1 + (N - nDoc + 0.5) / (nDoc + 0.5));
        const bm25 = ((freq * (k1 + 1)) / (freq + k1 * (1 - b + (b * d.len) / avgLen))) * (1 + idf);
        score += 22 * bm25;
      } else {
        const fuzzy = fuzzyTokenMatch(qt, d.uniqueTokens);
        if (fuzzy > 0) {
          fuzzyHits += 1;
          score += 18 * fuzzy;
        }
      }
    }
    if (!reason && exactHits > 0) reason = 'keyword';
    else if (!reason && fuzzyHits > 0) reason = 'fuzzy';

    if (qAllTokens.length > 1 && exactHits === qAllTokens.length) {
      score += 45;
    }

    // Concept-level semantic match (e.g., "tech stack" -> "Node.js + TypeScript")
    if (qConcepts.size > 0) {
      let conceptHits = 0;
      for (const cid of qConcepts) {
        if (d.concepts.has(cid)) conceptHits += 1;
      }
      if (conceptHits > 0) {
        score += (score > 0 ? 12 : 16) * conceptHits;
        if (!reason) reason = 'concept';
      }
    }

    // Optional embedding-backed semantic recall (safe to blend here because memories are user-owned).
    if (semanticScores && typeof semanticScores.get === 'function') {
      const sim = semanticScores.get(d.m.id);
      if (typeof sim === 'number' && Number.isFinite(sim)) {
        if (score > 0 && sim >= minSemanticScore) {
          score += sim * 85;
        } else if (score === 0 && sim >= pureSemanticFloor) {
          score += sim * 85;
          reason = 'semantic';
        } else if (score > 0 && sim > 0.2) {
          score += sim * 25;
        }
      }
    }

    if (score > 0) {
      scoreMap.set(d.m.id, score);
      reasonMap.set(d.m.id, reason || 'keyword');
    }
  }

  // Gentle 1-hop associative recall boost for memories explicitly linked to a strong hit.
  if (scoreMap.size > 0) {
    const byIdOrKey = new Map();
    for (const m of list) {
      byIdOrKey.set(m.id, m);
      byIdOrKey.set(m.key, m);
    }
    const bonus = new Map();
    for (const m of list) {
      const baseScore = scoreMap.get(m.id) || 0;
      if (baseScore < 30) continue;
      for (const link of m.links || []) {
        const neighbor = byIdOrKey.get(link.target);
        if (!neighbor || neighbor.id === m.id) continue;
        const add = Math.min(24, baseScore * 0.22);
        bonus.set(neighbor.id, Math.max(bonus.get(neighbor.id) || 0, add));
      }
    }
    for (const [id, add] of bonus) {
      scoreMap.set(id, (scoreMap.get(id) || 0) + add);
      if (!reasonMap.has(id)) reasonMap.set(id, 'linked');
    }
  }

  const ranked = [];
  for (const m of list) {
    const score = scoreMap.get(m.id) || 0;
    if (score > 0) ranked.push({ memory: m, score: Math.round(score * 100) / 100, reason: reasonMap.get(m.id) || 'keyword' });
  }
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.memory.pinned) - Number(a.memory.pinned) ||
      Date.parse(b.memory.updatedAt) - Date.parse(a.memory.updatedAt),
  );
  return withScores ? ranked : ranked.map((r) => r.memory);
}

/* ---------------- Brain Graph Builder & Cross-Agent Conflict Detection ---------------- */

const EXCLUSIVE_PREFERENCE_GROUPS = [
  {
    topic: 'package manager',
    options: [/\bpnpm\b/i, /\bnpm\b/i, /\byarn\b/i, /\bbun\b/i],
  },
  {
    topic: 'indentation',
    options: [/\btabs\b/i, /\bspaces\b/i],
    // Singular "tab" / "space" only when indentation is mentioned, avoiding "table" / "workspace".
    contextualOptions: [/\btab\b/i, /\bspace\b/i],
    context: /\b(?:indent|indentation|format|formatting)\b/i,
  },
  {
    topic: 'response length',
    options: [/\b(?:concise|terse|brief)\b/i, /\bverbose\b/i],
    contextualOptions: [/\bshort\b/i, /\b(?:detailed|thorough|long)\b/i],
    context: /\b(?:response|responses|answer|answers|reply|replies|output|tone|style|message|messages)\b/i,
  },
  {
    topic: 'theme',
    options: [/\bdark\s+(?:mode|theme)\b/i, /\blight\s+(?:mode|theme)\b/i],
    contextualOptions: [/\bdark\b/i, /\blight\b/i],
    context: /\b(?:theme|mode|ui|appearance|color|scheme|palette|interface)\b/i,
  },
  {
    topic: 'quote style',
    options: [/\bsingle\s+quotes?\b/i, /\bdouble\s+quotes?\b/i],
    contextualOptions: [/\bsingle\b/i, /\bdouble\b/i],
    context: /\bquotes?\b/i,
  },
  {
    topic: 'semicolons',
    options: [
      /\b(?:use|prefer|always|with|include)\s+semicolons?\b/i,
      /\b(?:no|never|avoid|without|omit)[\s-]+semicolons?\b/i,
    ],
  },
];

const POLARITY_IGNORE = new Set([
  'use', 'prefer', 'always', 'never', 'want', 'include', 'includ', 'love', 'like',
  'add', 'keep', 'write', 'writ', 'run', 'make', 'have', 'get', 'set', 'put',
  'with', 'without', 'more', 'less', 'all', 'any', 'some', 'one', 'two',
  'new', 'old', 'good', 'bad', 'best', 'only', 'same', 'other', 'thing', 'stuff',
]);

const NEGATIVE_CUE = /\b(?:no|never|avoid|dont|don't|do\s+not|without|dislike|hate|stop)\s+(?:(?:use|using|prefer|preferring|want|wanting|include|including|add|adding|write|writing|run|running|show|showing|enable|enabling)\s+)?(?:the\s+|any\s+|a\s+|an\s+)?([a-z0-9_-]{3,})\b/gi;
const POSITIVE_CUE = /\b(?:use|prefer|always|love|want|include|with)\s+(?:(?:use|using|prefer|include|including|add|adding|write|writing|run|running|enable|enabling)\s+)?(?:the\s+|a\s+|an\s+)?([a-z0-9_-]{3,})\b/gi;

function extractPolarities(text) {
  const neg = new Set();
  const pos = new Set();
  const str = String(text || '');
  let m;
  // Consume negative phrases first and replace them with a clause break so POSITIVE_CUE
  // cannot misread "never use emojis" as positive "use emojis" or bridge across the gap.
  NEGATIVE_CUE.lastIndex = 0;
  const withoutNeg = str.replace(NEGATIVE_CUE, (_full, term) => {
    const tok = stemToken(term);
    if (tok && !STOP_WORDS.has(tok) && !POLARITY_IGNORE.has(tok)) neg.add(tok);
    return ' , ';
  });
  POSITIVE_CUE.lastIndex = 0;
  while ((m = POSITIVE_CUE.exec(withoutNeg))) {
    const tok = stemToken(m[1]);
    if (tok && !STOP_WORDS.has(tok) && !POLARITY_IGNORE.has(tok) && !neg.has(tok)) pos.add(tok);
  }
  return { pos, neg };
}

function matchExclusiveOptions(group, text) {
  const hits = new Set();
  for (let i = 0; i < group.options.length; i += 1) {
    if (group.options[i].test(text)) hits.add(i);
  }
  if (group.contextualOptions && group.context && group.context.test(text)) {
    for (let i = 0; i < group.contextualOptions.length; i += 1) {
      if (group.contextualOptions[i].test(text)) hits.add(i);
    }
  }
  return hits;
}

// Captures standalone numbers (including single digits like 2, 3, 4), decimals, versions (v2),
// and indexed labels (q3) so distinct numbered items are never treated as duplicates.
export function extractNumericTokens(text) {
  const matches = String(text || '').toLowerCase().match(/\b[a-z]?\d+(?:[._-]\d+)*\b/g) || [];
  return new Set(matches);
}

function sameStringSet(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function detectPairConflict(
  a,
  b,
  contentTokA = new Set(tokenizeText(a.content)),
  contentTokB = new Set(tokenizeText(b.content)),
  numA = extractNumericTokens(a.content),
  numB = extractNumericTokens(b.content),
) {
  // 1. Explicit "contradicts" link always surfaces as a conflict.
  const explicitContradict =
    (a.links || []).some((l) => (l.target === b.id || l.target === b.key) && l.relation === 'contradicts') ||
    (b.links || []).some((l) => (l.target === a.id || l.target === a.key) && l.relation === 'contradicts');
  if (explicitContradict) {
    return { reason: 'Marked as conflicting', kind: 'contradiction' };
  }

  // 2. Polarity clash ("no emojis" vs "use emojis", "avoid tailwind" vs "prefer tailwind")
  const polA = extractPolarities(a.content);
  const polB = extractPolarities(b.content);
  for (const term of polA.neg) {
    if (polB.pos.has(term)) {
      return { reason: `Conflicting preference around "${term}"`, kind: 'contradiction' };
    }
  }
  for (const term of polB.neg) {
    if (polA.pos.has(term)) {
      return { reason: `Conflicting preference around "${term}"`, kind: 'contradiction' };
    }
  }

  // 3. Mutually exclusive tool/style choices in preference/global/project scopes
  const comparableScope = a.scope === b.scope || a.scope === 'preference' || b.scope === 'preference';
  if (comparableScope) {
    const hasPrefCue = (txt) => /\b(prefer|use|always|default|stick|keep|write)\b/i.test(txt);
    if (hasPrefCue(a.content) && hasPrefCue(b.content)) {
      for (const group of EXCLUSIVE_PREFERENCE_GROUPS) {
        const hitsA = matchExclusiveOptions(group, a.content);
        const hitsB = matchExclusiveOptions(group, b.content);
        // Ignore if either memory mentions multiple options (e.g. "use pnpm instead of npm").
        if (hitsA.size === 1 && hitsB.size === 1) {
          const [optA] = hitsA;
          const [optB] = hitsB;
          if (optA !== optB) {
            return { reason: `Different ${group.topic} preferences`, kind: 'contradiction' };
          }
        }
      }
    }
  }

  // 4. Near-duplicate content (compared strictly on content tokens, with matching numeric tokens
  // so distinct numbered/versioned items like "check 3" vs "check 4" are not called duplicates).
  if (contentTokA.size >= 4 && contentTokB.size >= 4 && sameStringSet(numA, numB)) {
    let inter = 0;
    for (const t of contentTokA) if (contentTokB.has(t)) inter += 1;
    const union = contentTokA.size + contentTokB.size - inter;
    const jaccard = union > 0 ? inter / union : 0;
    const diffOrigin =
      (a.source || '').toLowerCase() !== (b.source || '').toLowerCase() ||
      (a.writtenBy || '').toLowerCase() !== (b.writtenBy || '').toLowerCase();
    if (jaccard >= 0.75 && (diffOrigin || a.scope === b.scope)) {
      return {
        reason: diffOrigin
          ? `Overlapping memory from ${a.source || a.writtenBy} and ${b.source || b.writtenBy}`
          : 'Very similar memories',
        kind: 'overlap',
        score: jaccard,
      };
    }
  }

  return null;
}

// A cluster of N near-duplicate memories produces N*(N-1)/2 pairwise matches. Collapse each
// connected overlap component into a spanning tree rooted at the canonical keeper so N copies
// yield N-1 review pairs instead of combinatorial noise.
function collapseOverlapClusters(overlaps, byId) {
  if (overlaps.length <= 1) return overlaps;
  const adj = new Map();
  for (const ov of overlaps) {
    if (!adj.has(ov.a)) adj.set(ov.a, []);
    if (!adj.has(ov.b)) adj.set(ov.b, []);
    adj.get(ov.a).push({ other: ov.b, overlap: ov });
    adj.get(ov.b).push({ other: ov.a, overlap: ov });
  }
  const visited = new Set();
  const kept = [];
  for (const startId of adj.keys()) {
    if (visited.has(startId)) continue;
    const component = [];
    const queue = [startId];
    visited.add(startId);
    while (queue.length > 0) {
      const cur = queue.shift();
      component.push(cur);
      for (const edge of adj.get(cur) || []) {
        if (!visited.has(edge.other)) {
          visited.add(edge.other);
          queue.push(edge.other);
        }
      }
    }
    let anchor = byId.get(component[0]);
    for (let i = 1; i < component.length; i += 1) {
      const cand = byId.get(component[i]);
      if (cand && anchor) anchor = suggestKeep(anchor, cand);
    }
    const anchorId = anchor ? anchor.id : component[0];
    const inTree = new Set([anchorId]);
    const bfs = [anchorId];
    while (bfs.length > 0) {
      const cur = bfs.shift();
      const neighbors = [...(adj.get(cur) || [])].sort((x, y) => (y.overlap.score || 0) - (x.overlap.score || 0));
      for (const edge of neighbors) {
        if (inTree.has(edge.other)) continue;
        inTree.add(edge.other);
        kept.push(edge.overlap);
        bfs.push(edge.other);
      }
    }
  }
  return kept;
}

function shortNodeLabel(m) {
  if (m.project && m.scope === 'project') {
    const clean = m.content.replace(new RegExp(`^${m.project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:—-]\\s*`, 'i'), '').trim();
    const snippet = clean.length > 32 ? `${clean.slice(0, 31).trim()}…` : clean;
    return `${m.project}: ${snippet}`.slice(0, 42);
  }
  const firstClause = m.content.split(/[.!?\n]/)[0].trim() || m.content;
  return firstClause.length > 36 ? `${firstClause.slice(0, 35).trim()}…` : firstClause;
}

function verdictToConflict(verdict) {
  if (!verdict || verdict.relation === 'distinct') return null;
  if (verdict.relation === 'contradicts') {
    return { kind: 'contradiction', reason: verdict.reason || 'Memories disagree' };
  }
  if (verdict.relation === 'supersedes') {
    return { kind: 'supersedes', reason: verdict.reason || 'Newer memory updates an older one', score: verdict.probability || 0.9 };
  }
  if (verdict.relation === 'duplicate') {
    return { kind: 'overlap', reason: verdict.reason || 'Very similar memories', score: verdict.probability || 0.9 };
  }
  return null;
}

const LOCAL_PAIRWISE_LIMIT = 300;

export function buildMemoryGraph(memories, { verdicts = null } = {}) {
  const list = Array.isArray(memories) ? memories : [];
  const byId = new Map();
  const byIdOrKey = new Map();
  const tokenSets = new Map();
  const contentTokenSets = new Map();
  const numericTokenSets = new Map();
  for (const m of list) {
    byId.set(m.id, m);
    byIdOrKey.set(m.id, m);
    byIdOrKey.set(m.key, m);
    tokenSets.set(m.id, new Set(tokenizeText(`${m.key} ${m.project} ${(m.tags || []).join(' ')} ${m.content}`)));
    contentTokenSets.set(m.id, new Set(tokenizeText(m.content)));
    numericTokenSets.set(m.id, extractNumericTokens(m.content));
  }

  const verdictMap = new Map();
  if (verdicts instanceof Map) {
    for (const [k, v] of verdicts.entries()) verdictMap.set(k, v);
  } else if (Array.isArray(verdicts)) {
    for (const v of verdicts) {
      if (v?.a && v?.b) verdictMap.set([v.a, v.b].sort().join('::'), v);
    }
  }

  const edges = [];
  const edgeKeys = new Set();
  const addEdge = (source, target, kind, relation, label, weight) => {
    if (!source || !target || source === target) return;
    const ordered = kind === 'link' ? `${source}->${target}:${relation}` : [source, target].sort().join('--') + `:${kind}`;
    if (edgeKeys.has(ordered)) return;
    edgeKeys.add(ordered);
    edges.push({ id: ordered, source, target, kind, relation: relation || kind, label: label || '', weight });
  };

  // 1. Explicit user/agent links
  for (const m of list) {
    for (const l of m.links || []) {
      const dst = byIdOrKey.get(l.target);
      if (!dst || dst.id === m.id) continue;
      addEdge(m.id, dst.id, 'link', l.relation, l.relation, 1.0);
    }
  }

  // 2. Pairwise structural links (shared project, shared tags), conflicts, and top-2 semantic affinity
  const conflicts = [];
  const rawOverlaps = [];
  const seenConflictPairs = new Set();
  const similarityCandidates = new Map(); // id -> Array<{ otherId, score, shared }>
  const runLocalPairwise = list.length <= LOCAL_PAIRWISE_LIMIT;

  const recordConflict = (a, b, conflict) => {
    const pk = [a.id, b.id].sort().join('::');
    if (seenConflictPairs.has(pk)) return;
    seenConflictPairs.add(pk);
    const entry = {
      id: `cf_${a.id}_${b.id}`,
      a: a.id,
      b: b.id,
      kind: conflict.kind,
      reason: conflict.reason,
      ...(typeof conflict.score === 'number' ? { score: conflict.score } : {}),
    };
    if (conflict.kind === 'overlap' || conflict.kind === 'supersedes') {
      rawOverlaps.push(entry);
    } else {
      conflicts.push(entry);
      addEdge(a.id, b.id, 'conflict', conflict.kind, conflict.reason, 0.85);
    }
  };

  // Apply cached incremental verdicts first (works at any store size, beyond LOCAL_PAIRWISE_LIMIT).
  for (const v of verdictMap.values()) {
    const a = byId.get(v.a);
    const b = byId.get(v.b);
    if (!a || !b || a.id === b.id || keptTogether(a, b)) continue;
    const conflict = verdictToConflict(v);
    if (conflict) recordConflict(a, b, conflict);
  }

  // Always apply explicit "contradicts" links regardless of store size.
  for (const m of list) {
    for (const l of m.links || []) {
      if (l.relation !== 'contradicts') continue;
      const dst = byIdOrKey.get(l.target);
      if (!dst || dst.id === m.id || keptTogether(m, dst)) continue;
      recordConflict(m, dst, { reason: 'Marked as conflicting', kind: 'contradiction' });
    }
  }

  if (runLocalPairwise) {
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      const tokA = tokenSets.get(a.id);
      const contentTokA = contentTokenSets.get(a.id);
      const numA = numericTokenSets.get(a.id);
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j];
        const tokB = tokenSets.get(b.id);
        const contentTokB = contentTokenSets.get(b.id);
        const numB = numericTokenSets.get(b.id);

        const pk = [a.id, b.id].sort().join('::');
        if (!verdictMap.has(pk) && !keptTogether(a, b)) {
          const conflict = detectPairConflict(a, b, contentTokA, contentTokB, numA, numB);
          if (conflict) recordConflict(a, b, conflict);
        }

        if (a.project && b.project && a.project.toLowerCase() === b.project.toLowerCase()) {
          addEdge(a.id, b.id, 'project', 'same-project', a.project, 0.72);
        }

        if ((a.tags || []).length > 0 && (b.tags || []).length > 0) {
          const bTagSet = new Set(b.tags);
          const sharedTags = a.tags.filter((t) => bTagSet.has(t));
          if (sharedTags.length > 0) {
            addEdge(a.id, b.id, 'tag', 'shared-tag', `#${sharedTags[0]}`, 0.62);
          }
        }

        // Compute semantic keyword affinity (capped to top-2 per node below to avoid hairballs)
        if (tokA.size >= 2 && tokB.size >= 2) {
          const shared = [];
          for (const t of tokA) if (tokB.has(t)) shared.push(t);
          if (shared.length >= 2) {
            const score = shared.length / Math.sqrt(tokA.size * tokB.size);
            if (score >= 0.28) {
              const arrA = similarityCandidates.get(a.id) || [];
              arrA.push({ otherId: b.id, score, shared: shared[0] });
              similarityCandidates.set(a.id, arrA);
              const arrB = similarityCandidates.get(b.id) || [];
              arrB.push({ otherId: a.id, score, shared: shared[0] });
              similarityCandidates.set(b.id, arrB);
            }
          }
        }
      }
    }
  }

  for (const ov of collapseOverlapClusters(rawOverlaps, byId)) {
    conflicts.push({ id: ov.id, a: ov.a, b: ov.b, kind: ov.kind, reason: ov.reason });
    addEdge(ov.a, ov.b, 'conflict', ov.kind, ov.reason, 0.85);
  }

  for (const [id, candidates] of similarityCandidates) {
    candidates.sort((x, y) => y.score - x.score);
    for (const c of candidates.slice(0, 2)) {
      const pairHasStronger = edges.some(
        (e) =>
          (e.source === id && e.target === c.otherId) ||
          (e.source === c.otherId && e.target === id),
      );
      if (!pairHasStronger) {
        addEdge(id, c.otherId, 'similar', 'related', c.shared, Math.min(0.6, Math.max(0.3, c.score)));
      }
    }
  }

  const degreeMap = new Map();
  const conflictCountMap = new Map();
  for (const e of edges) {
    degreeMap.set(e.source, (degreeMap.get(e.source) || 0) + 1);
    degreeMap.set(e.target, (degreeMap.get(e.target) || 0) + 1);
  }
  for (const c of conflicts) {
    conflictCountMap.set(c.a, (conflictCountMap.get(c.a) || 0) + 1);
    conflictCountMap.set(c.b, (conflictCountMap.get(c.b) || 0) + 1);
  }

  const sourceCounts = new Map();
  const nodes = list.map((m) => {
    const origin = m.source && m.source !== 'Manual' ? m.source : (m.writtenBy && m.writtenBy !== 'Owner' ? m.writtenBy : 'You');
    sourceCounts.set(origin, (sourceCounts.get(origin) || 0) + 1);
    return {
      id: m.id,
      key: m.key,
      label: shortNodeLabel(m),
      content: m.content,
      scope: m.scope,
      project: m.project,
      tags: m.tags,
      links: m.links || [],
      pinned: m.pinned,
      ...(m.pinned ? { pinnedBy: memoryPinnedBy(m) } : {}),
      profiles: normalizeItemProfiles(m.profiles),
      source: m.source,
      writtenBy: m.writtenBy,
      origin,
      updatedAt: m.updatedAt,
      degree: degreeMap.get(m.id) || 0,
      conflictCount: conflictCountMap.get(m.id) || 0,
    };
  });

  const sources = [...sourceCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return {
    nodes,
    edges,
    conflicts,
    sources,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      pinnedCount: nodes.filter((n) => n.pinned).length,
      conflictCount: conflicts.length,
    },
  };
}

/* ---------------- Portable Markdown Export & External Memory Detection ---------------- */

const SCOPE_HEADINGS = {
  global: 'About you',
  preference: 'Preferences',
  project: 'Projects',
  fact: 'Facts',
};

export function exportMemoriesMarkdown(memories) {
  const list = Array.isArray(memories) ? memories : [];
  const lines = [
    '# Loop Shared Memory',
    '',
    `Exported ${new Date().toISOString().slice(0, 10)} · ${list.length} memories`,
    '',
  ];

  const pinned = list.filter((m) => m.pinned);
  if (pinned.length > 0) {
    lines.push('## Startup context (Pinned)', '');
    for (const m of pinned) {
      const meta = [SCOPE_HEADINGS[m.scope] || m.scope, m.project ? `project:${m.project}` : '', ...(m.tags || []).map((t) => `#${t}`)]
        .filter(Boolean)
        .join(' · ');
      lines.push(`- ${m.content}${meta ? ` _(${meta})_` : ''}`);
    }
    lines.push('');
  }

  for (const scope of MEMORY_SCOPES) {
    const items = list.filter((m) => m.scope === scope);
    if (items.length === 0) continue;
    lines.push(`## ${SCOPE_HEADINGS[scope]}`, '');
    for (const m of items) {
      const extras = [
        m.project ? `[${m.project}]` : '',
        m.pinned ? '[pinned]' : '',
        ...(m.tags || []).map((t) => `#${t}`),
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(`- ${m.content}${extras ? ` ${extras}` : ''}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

const MEMORY_CONNECTION_PATTERN = /\b(supermemory|mem0|openmemory|graphiti|zep|cognee|engram|hindsight|letta|memgpt|obsidian|second[-_\s]?brain|knowledge[-_\s]?graph|memory)\b/i;

export function detectExternalMemoryConnections(connections) {
  const list = Array.isArray(connections) ? connections : [];
  const matches = [];
  for (const c of list) {
    if (!c || c.enabled === false) continue;
    const hay = `${c.id || ''} ${c.name || ''} ${c.description || ''} ${c.url || ''}`;
    const toolMatch = Array.isArray(c.tools) && c.tools.some((t) => /\b(memory|memories|remember|recall|knowledge_graph|add_observations|read_graph)\b/i.test(`${t.name || ''} ${t.description || ''}`));
    if (MEMORY_CONNECTION_PATTERN.test(hay) || toolMatch) {
      const picked = pickExternalMemoryTools(c);
      matches.push({
        id: c.id,
        name: c.name || c.id,
        description: c.description || '',
        ready: !c.authRequired && (Array.isArray(c.tools) ? c.tools.length > 0 : false),
        searchTool: picked.searchTool?.name || '',
        saveTool: picked.saveTool?.name || '',
        listTool: picked.listTool?.name || '',
      });
    }
  }
  return matches;
}

function queryParamName(tool) {
  const props = tool?.inputSchema?.properties;
  if (!props || typeof props !== 'object') return 'query';
  const keys = Object.keys(props);
  for (const preferred of ['query', 'q', 'search', 'text', 'prompt', 'input', 'keyword', 'topic']) {
    if (keys.includes(preferred)) return preferred;
  }
  const req = Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : [];
  const stringReq = req.find((k) => props[k]?.type === 'string');
  return stringReq || keys.find((k) => props[k]?.type === 'string') || 'query';
}

function toolAcceptsSimpleQuery(tool) {
  const req = Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : [];
  if (req.length === 0) return true;
  if (req.length === 1) {
    const props = tool?.inputSchema?.properties || {};
    return !props[req[0]] || props[req[0]].type === 'string';
  }
  return false;
}

function toolAcceptsNoArgs(tool) {
  const req = Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : [];
  return req.length === 0;
}

/**
 * Inspects a connected external Memory MCP's discovered tools and identifies the best
 * search, list/graph, and save tool candidates for routing and Brain preview.
 */
export function pickExternalMemoryTools(conn) {
  const disabled = new Set(Array.isArray(conn?.disabledTools) ? conn.disabledTools : []);
  const tools = (Array.isArray(conn?.tools) ? conn.tools : []).filter((t) => t && t.name && !disabled.has(t.name));

  const findBest = (patterns) => {
    for (const rx of patterns) {
      const hit = tools.find((t) => rx.test(t.name));
      if (hit) return hit;
    }
    return null;
  };

  const searchTool = findBest([
    /^(search_memor|memory_search|recall_memor|retrieve_memor|query_memor|search_nodes|search_facts)/i,
    /(search|recall|retrieve|query).*(memor|node|fact|knowledge|graph|context)/i,
    /^recall$/i,
    /^search$/i,
  ]);
  const listTool = findBest([
    /^(read_graph|list_memor|get_all_memor|get_memor|fetch_memor|dump_graph|open_nodes)/i,
    /(list|get|read|fetch).*(memor|graph|entities)/i,
  ]);
  const saveTool = findBest([
    /^(add_memor|save_memor|store_memor|create_memor|remember|memory_add|create_entities|add_observations)/i,
    /(add|save|store|create|write|remember).*(memor|entit|observation|fact|knowledge)/i,
  ]);

  return {
    searchTool: searchTool
      ? { name: searchTool.name, queryParam: queryParamName(searchTool), simpleQuery: toolAcceptsSimpleQuery(searchTool) }
      : null,
    listTool: listTool
      ? { name: listTool.name, noArgs: toolAcceptsNoArgs(listTool) }
      : null,
    saveTool: saveTool
      ? { name: saveTool.name }
      : null,
  };
}

/**
 * Parses common MCP tool call results from external memory servers (Anthropic server-memory
 * read_graph, Mem0/OpenMemory arrays, Supermemory results, or plain markdown text) into clean,
 * secret-checked Loop memory candidates.
 */
export function extractMemoriesFromExternalResult(result, sourceName = 'External Memory') {
  const texts = [];
  if (typeof result === 'string') {
    texts.push(result);
  } else if (Array.isArray(result?.content)) {
    for (const part of result.content) {
      if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    }
  } else if (result && typeof result === 'object') {
    texts.push(JSON.stringify(result));
  }

  const rawItems = [];
  const pushCandidate = (content, extra = {}) => {
    const clean = normalizeContent(content);
    if (clean.length < 6 || looksLikeSecret(clean)) return;
    rawItems.push({
      key: slugifyKey(extra.key || clean.slice(0, 48)),
      content: clean,
      scope: normalizeScope(extra.scope || 'global'),
      project: String(extra.project || '').trim().slice(0, 80),
      tags: normalizeTags(extra.tags || []),
      source: sourceName,
    });
  };

  for (const rawText of texts) {
    const trimmed = rawText.trim();
    if (!trimmed) continue;
    let parsed = null;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = null;
      }
    }

    if (parsed && typeof parsed === 'object') {
      // 1. Anthropic @modelcontextprotocol/server-memory graph format: { entities: [{ name, entityType, observations }] }
      if (Array.isArray(parsed.entities)) {
        for (const ent of parsed.entities) {
          const name = String(ent?.name || '').trim();
          const entType = String(ent?.entityType || '').trim().toLowerCase();
          const scope = /pref|style|rule/i.test(entType) ? 'preference' : /proj|repo|app/i.test(entType) ? 'project' : 'fact';
          const obs = Array.isArray(ent?.observations) ? ent.observations : [];
          if (obs.length > 0) {
            for (const line of obs) {
              const txt = name && !String(line).toLowerCase().includes(name.toLowerCase()) ? `${name}: ${line}` : String(line);
              pushCandidate(txt, { scope, project: scope === 'project' ? name : '', tags: entType ? [entType] : [] });
            }
          } else if (name) {
            pushCandidate(`${name}${entType ? ` (${entType})` : ''}`, { scope });
          }
        }
        continue;
      }

      // 2. Supermemory / Mem0 / OpenMemory list or search results
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.memories)
          ? parsed.memories
          : Array.isArray(parsed.results)
            ? parsed.results
            : Array.isArray(parsed.items)
              ? parsed.items
              : Array.isArray(parsed.data)
                ? parsed.data
                : [];
      for (const item of arr) {
        if (typeof item === 'string') {
          pushCandidate(item);
        } else if (item && typeof item === 'object') {
          const text =
            item.memory ||
            item.content ||
            item.text ||
            item.fact ||
            item.summary ||
            (Array.isArray(item.chunks) ? item.chunks.map((c) => c?.content || '').join(' ') : '') ||
            item.title ||
            '';
          const meta = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
          pushCandidate(text, {
            key: item.key || item.id,
            scope: item.scope || meta.scope || item.category || 'global',
            project: item.project || meta.project || '',
            tags: item.tags || meta.tags || item.categories || [],
          });
        }
      }
      continue;
    }

    // 3. Plain text / markdown fallback
    for (const item of parseMarkdownFacts(trimmed, { source: sourceName, scope: 'global' })) {
      rawItems.push(item);
    }
  }

  const seen = new Set();
  const deduped = [];
  for (const it of rawItems) {
    const fp = normalizeFingerprint(it.content);
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    deduped.push(it);
    if (deduped.length >= 60) break;
  }
  return deduped;
}

/* ---------------- MemoryStore ---------------- */

export class MemoryStore {
  constructor(dir = defaultDataDir()) {
    this.dir = dir;
    this.file = path.join(dir, 'memory.json');
    this._lock = Promise.resolve();
    this._subscribers = new Set();
  }

  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this._subscribers.add(fn);
    return () => {
      this._subscribers.delete(fn);
    };
  }

  _notify(event = {}) {
    for (const fn of this._subscribers) {
      try {
        fn(event);
      } catch {
        // never break mutations on listener error
      }
    }
  }

  _withLock(fn) {
    const next = this._lock.then(fn, fn);
    this._lock = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  async _loadDoc() {
    let text;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return { memories: [], versions: {}, config: normalizeConfig(DEFAULT_MEMORY_CONFIG) };
      }
      throw err;
    }

    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.memories)) {
      throw new Error(`Invalid memory file "${this.file}": expected an object with a "memories" array.`);
    }
    return {
      memories: raw.memories.map(normalizeEntry).filter(Boolean),
      versions: raw.syncVersions || {},
      config: normalizeConfig(raw.config),
    };
  }

  async _load() {
    const { memories } = await this._loadDoc();
    return memories;
  }

  async _saveDoc(memories, config, accepted, previous) {
    const prior = previous || await this._loadDoc();
    const byId = (rows) => new Map(rows.map((record) => [record.id, record]));
    const syncVersions = updatedRevisions(byId(prior.memories), byId(memories), prior.versions, accepted);
    const cleanConfig = normalizeConfig(config);
    const payload = JSON.stringify({ version: 1, memories, syncVersions, config: cleanConfig }, null, 2) + '\n';
    await atomicWriteFile(this.file, payload, 0o600);
  }

  async syncRecords() {
    const { memories, versions } = await this._loadDoc();
    const live = new Map(memories.map((m) => [m.id, m]));
    return [...new Set([...live.keys(), ...Object.keys(versions)])].map((id) => {
      const record = live.get(id);
      return { ...(record || { id, deleted: true }), revision: currentRevision(versions, id, record) };
    });
  }

  async applySyncRecords(records) {
    return this._withLock(async () => {
      const doc = await this._loadDoc();
      const result = new Map(doc.memories.map((m) => [m.id, m]));
      const accepted = new Map();
      for (const row of records) {
        const { id, revision } = row || {};
        if (typeof id !== 'string' || !MEMORY_ID_RE.test(id) || accepted.has(id)) {
          throw Object.assign(new Error('Invalid synced memory ID.'), { status: 400 });
        }
        validateRevision(revision, row.deleted === true);
        if (revision <= currentRevision(doc.versions, id, result.get(id))) continue;
        if (row.deleted === true) result.delete(id);
        else {
          if (!normalizeContent(row.content) || looksLikeSecret(row.content) || looksLikeSecret(row.key || '') ||
              hasSecretInLinks(row.links)) throw Object.assign(new Error('Invalid synced memory.'), { status: 400 });
          const normalized = normalizeEntry({ ...row, profiles: validateMemoryProfiles(row.profiles) });
          result.set(id, normalized);
        }
        accepted.set(id, revision);
      }
      if (!accepted.size) return false;
      const memories = [...result.values()];
      const active = memories.filter(isActiveMemory);
      if (active.length > MAX_MEMORIES || active.filter((m) => m.pinned).length > MAX_PINNED_MEMORIES) {
        throw Object.assign(new Error('Sync would exceed the memory or pin limit.'), { status: 409 });
      }
      const keys = new Set();
      for (const m of memories) {
        if (keys.has(m.key)) throw Object.assign(new Error('Two memories share the key "' + m.key + '". Rename one to sync.'), { status: 409 });
        keys.add(m.key);
      }
      await this._saveDoc(memories, doc.config, accepted, doc);
      this._notify({ action: 'sync', ids: [...accepted.keys()] });
      return true;
    });
  }

  async getConfig() {
    const { config } = await this._loadDoc();
    return config;
  }

  async updateConfig(patch = {}, { home = os.homedir(), allowSyncFolders = true } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw Object.assign(new Error('Memory config patch must be an object.'), { status: 400 });
    }
    if (patch.syncFolders !== undefined && !allowSyncFolders) {
      throw Object.assign(
        new Error('Watching local folders is only available in the local Mac workspace.'),
        { status: 403 },
      );
    }

    return this._withLock(async () => {
      const { memories, config } = await this._loadDoc();
      const next = { ...config };

      if (patch.mode !== undefined) {
        const rawMode = String(patch.mode || '').trim().toLowerCase();
        const cleanMode = rawMode === 'hybrid' || rawMode === 'passthrough' ? 'external' : rawMode;
        if (!MODE_SET.has(cleanMode)) {
          throw Object.assign(
            new Error('Memory mode must be "local", "external", or "off".'),
            { status: 400 },
          );
        }
        next.mode = cleanMode;
      }

      if (patch.externalConnectionId !== undefined) {
        const cleanId = String(patch.externalConnectionId || '').trim();
        if (cleanId && !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(cleanId)) {
          throw Object.assign(new Error('Invalid external memory connection id.'), { status: 400 });
        }
        next.externalConnectionId = cleanId;
      }

      if (patch.dismissedExternalIds !== undefined) {
        if (!Array.isArray(patch.dismissedExternalIds)) {
          throw Object.assign(new Error('dismissedExternalIds must be an array.'), { status: 400 });
        }
        const cleaned = [];
        const seen = new Set();
        for (const rawId of patch.dismissedExternalIds) {
          const clean = String(rawId || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '').slice(0, 64);
          if (clean && !seen.has(clean)) {
            seen.add(clean);
            cleaned.push(clean);
          }
          if (cleaned.length >= 20) break;
        }
        next.dismissedExternalIds = cleaned;
      }

      if (patch.syncFolders !== undefined) {
        if (!Array.isArray(patch.syncFolders)) {
          throw Object.assign(new Error('syncFolders must be an array of folder paths.'), { status: 400 });
        }
        if (patch.syncFolders.length > MAX_SYNC_FOLDERS) {
          throw Object.assign(
            new Error(`You can watch up to ${MAX_SYNC_FOLDERS} local folders at a time.`),
            { status: 400 },
          );
        }
        const validated = [];
        const seen = new Set();
        for (const rawFolder of patch.syncFolders) {
          const clean = validateSyncFolder(rawFolder, { home, dataDir: this.dir });
          if (!seen.has(clean)) {
            seen.add(clean);
            validated.push(clean);
          }
        }
        next.syncFolders = validated;
      }

      if (next.mode === 'external' && !next.externalConnectionId) {
        throw Object.assign(
          new Error('Choose a connected external memory service for External Connection mode.'),
          { status: 400 },
        );
      }

      await this._saveDoc(memories, next);
      this._notify({ action: 'config' });
      return next;
    });
  }

  async list({
    scope = '',
    project = '',
    pinnedOnly = false,
    query = '',
    profile = 'all',
    includeGlobal = false,
    semanticScores = null,
    minSemanticScore = undefined,
    withScores = false,
  } = {}) {
    const all = (await this._load()).filter(isActiveMemory);
    const cleanScope = String(scope || '').trim().toLowerCase();
    const cleanProject = String(project || '').trim().toLowerCase();
    const filtered = all.filter((m) => {
      if (profile && profile !== 'all' && !itemMatchesProfile(m, profile) && !(includeGlobal && isAllProfiles(m.profiles))) return false;
      if (pinnedOnly && !m.pinned) return false;
      if (cleanScope && cleanScope !== 'all' && m.scope !== cleanScope) return false;
      if (cleanProject && m.project.toLowerCase() !== cleanProject) return false;
      return true;
    });

    return searchMemories(filtered, query, {
      withScores,
      semanticScores,
      ...(typeof minSemanticScore === 'number' ? { minSemanticScore } : {}),
    });
  }

  async graph({ profile = 'all', verdicts = null } = {}) {
    const all = (await this._load()).filter(isActiveMemory);
    const filtered = profile && profile !== 'all'
      ? all.filter((m) => itemMatchesProfile(m, profile))
      : all;
    return buildMemoryGraph(filtered, { verdicts });
  }

  async get(idOrKey, { includeReplaced = false, profile = 'all', includeGlobal = false } = {}) {
    const target = String(idOrKey || '').trim();
    if (!target) return null;
    const all = await this._load();
    return all.find((m) => {
      if (m.id !== target && m.key !== target) return false;
      if (!includeReplaced && !isActiveMemory(m)) return false;
      if (profile && profile !== 'all' && !itemMatchesProfile(m, profile) && !(includeGlobal && isAllProfiles(m.profiles))) return false;
      return true;
    }) || null;
  }

  /* ---------- Tidy: review queue for conflicts, duplicate/update clusters, and temporary notes ---------- */

  // Builds Tidy queues: contradictions (pinned first), duplicate/update clusters, temporary scratch
  // notes, and set-aside memories that can be restored. Nothing changes until the owner acts.
  async tidy({ profile = 'all', verdicts = null } = {}) {
    const rawAll = await this._load();
    const active = rawAll.filter(isActiveMemory);
    const scoped = profile && profile !== 'all' ? active.filter((m) => itemMatchesProfile(m, profile)) : active;
    const byId = new Map(scoped.map((m) => [m.id, m]));
    const { conflicts } = buildMemoryGraph(scoped, { verdicts });

    const suggestions = conflicts
      .map((c) => {
        const a = byId.get(c.a);
        const b = byId.get(c.b);
        if (!a || !b) return null;
        const keep = suggestKeep(a, b);
        return {
          id: c.id,
          kind: c.kind === 'overlap' ? 'duplicate' : c.kind === 'supersedes' ? 'update' : 'conflict',
          reason: c.reason,
          a: c.a,
          b: c.b,
          keep: keep.id,
          pinnedInvolved: Boolean(a.pinned || b.pinned),
        };
      })
      .filter(Boolean)
      .sort((x, y) => {
        // Conflicts before duplicates, pinned conflicts first.
        const rank = (s) => (s.kind === 'conflict' ? (s.pinnedInvolved ? 0 : 1) : s.kind === 'update' ? 2 : 3);
        return rank(x) - rank(y);
      });

    // Group connected duplicate/update pairs into multi-item clusters so N copies resolve in 1 click.
    const dupEdges = suggestions.filter((s) => s.kind === 'duplicate' || s.kind === 'update');
    const adj = new Map();
    for (const s of dupEdges) {
      if (!adj.has(s.a)) adj.set(s.a, []);
      if (!adj.has(s.b)) adj.set(s.b, []);
      adj.get(s.a).push({ other: s.b, s });
      adj.get(s.b).push({ other: s.a, s });
    }
    const visited = new Set();
    const clusters = [];
    for (const startId of adj.keys()) {
      if (visited.has(startId)) continue;
      const memberIds = [];
      const edgeReasons = [];
      let hasUpdate = false;
      const queue = [startId];
      visited.add(startId);
      while (queue.length > 0) {
        const cur = queue.shift();
        memberIds.push(cur);
        for (const e of adj.get(cur) || []) {
          if (e.s.kind === 'update') hasUpdate = true;
          if (e.s.reason) edgeReasons.push(e.s.reason);
          if (!visited.has(e.other)) {
            visited.add(e.other);
            queue.push(e.other);
          }
        }
      }
      const members = memberIds.map((id) => byId.get(id)).filter(Boolean);
      if (members.length < 2) continue;
      const anchor = members.reduce((best, cur) => suggestKeep(best, cur));
      const orderedIds = [
        anchor.id,
        ...members
          .filter((m) => m.id !== anchor.id)
          .sort((x, y) => (Date.parse(y.updatedAt) || 0) - (Date.parse(x.updatedAt) || 0))
          .map((m) => m.id),
      ];
      clusters.push({
        id: `cl_${anchor.id}`,
        kind: hasUpdate ? 'update' : 'duplicate',
        reason: edgeReasons[0] || (hasUpdate ? 'Newer memory updates an older one' : 'Very similar memories'),
        keep: anchor.id,
        ids: orderedIds,
        dropIds: orderedIds.slice(1),
      });
    }

    const temporary = scoped
      .filter((m) => isTemporaryMemory(m))
      .sort((x, y) => (Date.parse(y.updatedAt) || 0) - (Date.parse(x.updatedAt) || 0))
      .map((m) => ({
        id: m.id,
        content: m.content,
        scope: m.scope,
        writtenBy: m.writtenBy,
        source: m.source,
        updatedAt: m.updatedAt,
      }));

    const replaced = rawAll
      .filter((m) => !isActiveMemory(m) && (!profile || profile === 'all' || itemMatchesProfile(m, profile)))
      .sort((x, y) => String(y.supersededAt).localeCompare(String(x.supersededAt)));
    return { suggestions, clusters, temporary, replaced };
  }

  // Settle a Tidy pair ({ a, b, keep }), a cluster ({ ids, keep }), archive temporary notes ({ dropIds }),
  // or dismiss temporary notes as permanent ({ keepIds }).
  async resolveTidy({ a, b, keep, ids, dropIds, keepIds } = {}) {
    // Mode 0: Keep flagged temporary notes (marks ephemeral: false so Tidy stops flagging them).
    if (Array.isArray(keepIds) && keepIds.length > 0) {
      const cleanKeeps = [...new Set(keepIds.map((x) => String(x || '').trim()).filter(Boolean))];
      if (cleanKeeps.length === 0) throw Object.assign(new Error('Pick at least one memory to keep.'), { status: 400 });
      return this._withLock(async () => {
        const { memories: list, config } = await this._loadDoc();
        const kept = [];
        for (const id of cleanKeeps) {
          const idx = list.findIndex((m) => m.id === id);
          if (idx === -1) throw Object.assign(new Error('That memory no longer exists.'), { status: 404 });
          if (!isActiveMemory(list[idx])) continue;
          list[idx] = normalizeEntry({ ...list[idx], ephemeral: false });
          kept.push(list[idx].id);
        }
        await this._saveDoc(list, config);
        this._notify({ action: 'tidy', ids: kept });
        return {
          kept,
          replaced: null,
          replacedIds: [],
        };
      });
    }

    // Mode 1: Set aside temporary/scratch notes (no replacement memory; restorable via restore()).
    if (Array.isArray(dropIds) && dropIds.length > 0) {
      const cleanDrops = [...new Set(dropIds.map((x) => String(x || '').trim()).filter(Boolean))];
      if (cleanDrops.length === 0) throw Object.assign(new Error('Pick at least one memory to set aside.'), { status: 400 });
      return this._withLock(async () => {
        const { memories: list, config } = await this._loadDoc();
        const now = new Date().toISOString();
        const dropped = [];
        for (const id of cleanDrops) {
          const idx = list.findIndex((m) => m.id === id);
          if (idx === -1) throw Object.assign(new Error('That memory no longer exists.'), { status: 404 });
          if (!isActiveMemory(list[idx])) continue;
          list[idx] = normalizeEntry({ ...list[idx], pinned: false, archived: true, supersededAt: now });
          dropped.push(list[idx]);
        }
        await this._saveDoc(list, config);
        this._notify({ action: 'tidy', ids: cleanDrops });
        return {
          kept: [],
          replaced: dropped[0] || null,
          replacedIds: dropped.map((m) => m.id),
        };
      });
    }

    // Mode 2 & 3: Cluster ({ ids, keep }) or Pair ({ a, b, keep }).
    const groupIds = Array.isArray(ids) && ids.length >= 2
      ? [...new Set(ids.map((x) => String(x || '').trim()).filter(Boolean))]
      : [String(a || '').trim(), String(b || '').trim()].filter(Boolean);
    const uniqueIds = [...new Set(groupIds)];
    if (uniqueIds.length < 2) throw Object.assign(new Error('Pick two different memories.'), { status: 400 });
    const choice = String(keep || '').trim();
    const keepAll = choice === 'both' || choice === 'all';
    if (!keepAll && !uniqueIds.includes(choice)) {
      throw Object.assign(new Error('keep must be one of the memory ids, or "both".'), { status: 400 });
    }
    return this._withLock(async () => {
      const { memories: list, config } = await this._loadDoc();
      const indices = uniqueIds.map((id) => list.findIndex((m) => m.id === id));
      if (indices.some((i) => i === -1)) throw Object.assign(new Error('That memory no longer exists.'), { status: 404 });
      if (indices.some((i) => !isActiveMemory(list[i]))) {
        throw Object.assign(new Error('One of these memories was already replaced.'), { status: 409 });
      }
      const now = new Date().toISOString();
      if (keepAll) {
        for (const idx of indices) {
          const id = list[idx].id;
          const others = uniqueIds.filter((x) => x !== id);
          list[idx] = normalizeEntry({ ...list[idx], keptWith: [...(list[idx].keptWith || []), ...others] });
        }
        await this._saveDoc(list, config);
        this._notify({ action: 'tidy', ids: uniqueIds });
        return { kept: uniqueIds, replaced: null, replacedIds: [] };
      }
      const keepIdx = list.findIndex((m) => m.id === choice);
      const dropIndices = indices.filter((i) => i !== keepIdx);
      const dropped = [];
      for (const dropIdx of dropIndices) {
        const drop = list[dropIdx];
        // The kept memory takes over the pin, so choosing never silently drops something from turn 1.
        if (drop.pinned && !list[keepIdx].pinned) {
          list[keepIdx] = normalizeEntry({ ...list[keepIdx], pinned: true, pinnedBy: memoryPinnedBy(drop) });
        }
        list[dropIdx] = normalizeEntry({ ...drop, pinned: false, supersededBy: list[keepIdx].id, supersededAt: now });
        dropped.push(list[dropIdx]);
      }
      await this._saveDoc(list, config);
      this._notify({ action: 'tidy', ids: uniqueIds });
      return {
        kept: [list[keepIdx].id],
        replaced: dropped[0] || null,
        replacedIds: dropped.map((m) => m.id),
      };
    });
  }

  // Undo a Tidy choice: the replaced or archived memory comes back as it was.
  async restore(idOrKey) {
    const target = String(idOrKey || '').trim();
    if (!target) return null;
    return this._withLock(async () => {
      const { memories: list, config } = await this._loadDoc();
      const idx = list.findIndex((m) => m.id === target || m.key === target);
      if (idx === -1) return null;
      if (isActiveMemory(list[idx])) return list[idx];
      const { supersededBy, supersededAt, archived, ...rest } = list[idx];
      const keeper = supersededBy ? list.find((m) => m.id === supersededBy) : null;
      list[idx] = normalizeEntry({
        ...rest,
        // Restoring an archived temporary note marks it explicitly non-ephemeral so Tidy stops flagging it.
        ...(archived ? { ephemeral: false } : {}),
        // Restoring is the owner saying both belong, so the pair is not suggested again.
        keptWith: [...(rest.keptWith || []), ...(keeper ? [keeper.id] : [])],
      });
      await this._saveDoc(list, config);
      this._notify({ action: 'restore', id: list[idx].id });
      return list[idx];
    });
  }

  async save(input = {}, { enforceProfileScope = false } = {}) {
    const content = normalizeContent(input.content);
    if (!content) {
      throw Object.assign(new Error('Memory content is required.'), { status: 400 });
    }
    if (looksLikeSecret(content) || looksLikeSecret(input.key || '') || hasSecretInLinks(input.links)) {
      throw Object.assign(
        new Error(
          'This looks like a secret or credential. Store secrets in Loop Vault instead (type: "api_key" | "login" | "payment" | "note") and reference them with {{vault:KEY}}.',
        ),
        { status: 400, code: 'SECRET_IN_MEMORY' },
      );
    }
    const incomingProfiles = input.profiles !== undefined ? validateMemoryProfiles(input.profiles) : null;
    const supersedesTarget = typeof input.supersedes === 'string' ? input.supersedes.trim() : '';

    return this._withLock(async () => {
      const { memories: list, config } = await this._loadDoc();
      const targetId = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : '';
      const targetKey = slugifyKey(input.key);
      const fp = normalizeFingerprint(content);

      const effectiveProfiles = incomingProfiles !== null ? incomingProfiles : ['all'];
      const sameProfileScope = (m) =>
        profilesEqual(normalizeItemProfiles(m.profiles), effectiveProfiles);

      let matchedById = false;
      let idx = targetId ? list.findIndex((m) => m.id === targetId) : -1;
      if (idx !== -1) {
        if (enforceProfileScope && !sameProfileScope(list[idx])) throw new Error('Cannot update memory outside the selected scope.');
        matchedById = true;
      } else if (!targetId) {
        idx = list.findIndex(
          (m) =>
            sameProfileScope(m) &&
            ((targetKey && (m.key === targetKey || m.scopeKey === targetKey)) || normalizeFingerprint(m.content) === fp),
        );
      }

      const isGuestActor = String(input.actor || '').trim().toLowerCase() === 'guest';
      const wantPinned = input.pinned !== undefined ? Boolean(input.pinned) : idx !== -1 ? list[idx].pinned : false;
      if (isGuestActor && wantPinned) {
        throw Object.assign(
          new Error('Guest agents cannot pin memories into startup context.'),
          { status: 403, code: 'GUEST_CANNOT_PIN' },
        );
      }
      if (isGuestActor && idx !== -1 && computeMemoryTrustTier(list[idx]) === 'confirmed') {
        throw Object.assign(
          new Error('Guest agents cannot overwrite owner-confirmed memories.'),
          { status: 403, code: 'CANNOT_OVERWRITE_CONFIRMED' },
        );
      }
      if (wantPinned) {
        const pinnedCount = list.filter((m, i) => m.pinned && i !== idx).length;
        if (pinnedCount >= MAX_PINNED_MEMORIES) {
          throw Object.assign(
            new Error(`You can pin up to ${MAX_PINNED_MEMORIES} memories at a time. Unpin one first.`),
            { status: 400 },
          );
        }
      }

      const applySupersedes = (keeper, now) => {
        if (!supersedesTarget) return null;
        const oldIdx = list.findIndex(
          (m) => (m.id === supersedesTarget || m.key === supersedesTarget) && m.id !== keeper.id && isActiveMemory(m) && sameProfileScope(m),
        );
        if (oldIdx === -1) return null;
        const old = list[oldIdx];
        if (isGuestActor && computeMemoryTrustTier(old) === 'confirmed') {
          throw Object.assign(
            new Error('Guest agents cannot supersede owner-confirmed memories.'),
            { status: 403, code: 'CANNOT_OVERWRITE_CONFIRMED' },
          );
        }
        // A generic agent supersession must not silently change startup context.
        // Owner-driven Tidy has its own reviewed pin-transfer path.
        if ((input.actor === 'agent' || isGuestActor) && old.pinned && input.pinned !== true) {
          throw new Error('Pinned source unchanged. Confirm retaining the startup pin, then resubmit with pinned:true, or leave the source alone.');
        }
        if (old.pinned && !keeper.pinned) {
          const keeperIdx = list.findIndex((m) => m.id === keeper.id);
          if (keeperIdx !== -1) {
            list[keeperIdx] = normalizeEntry({ ...list[keeperIdx], pinned: true, pinnedBy: memoryPinnedBy(old) });
          }
        }
        list[oldIdx] = normalizeEntry({ ...old, pinned: false, supersededBy: keeper.id, supersededAt: now });
        return list[oldIdx].id;
      };

      const now = new Date().toISOString();
      if (idx !== -1) {
        const cur = list[idx];
        let nextKey = targetKey && targetKey !== cur.scopeKey ? targetKey : cur.key;
        if (nextKey !== cur.key) {
          const colliding = list.find((m, i) => i !== idx && m.key === nextKey);
          if (colliding) {
            if (!matchedById && !sameProfileScope(colliding)) {
              const suffixRe = new RegExp(`^${nextKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`);
              nextKey = suffixRe.test(cur.key) ? cur.key : makeUniqueMemoryKey(nextKey, list, idx);
            } else {
              throw Object.assign(
                new Error(`A memory with key "${nextKey}" already exists.`),
                { status: 409, code: 'DUPLICATE_KEY' },
              );
            }
          }
        }
        const next = normalizeEntry({
          ...cur,
          key: nextKey,
          scopeKey: nextKey === cur.key ? cur.scopeKey : undefined,
          content,
          scope: input.scope !== undefined ? input.scope : cur.scope,
          project: input.project !== undefined ? input.project : cur.project,
          tags: input.tags !== undefined ? input.tags : cur.tags,
          links: input.links !== undefined ? input.links : cur.links,
          pinned: wantPinned,
          pinnedBy: input.actor === 'agent' || isGuestActor ? 'agent' : 'owner',
          profiles: incomingProfiles !== null ? incomingProfiles : cur.profiles,
          source: input.source !== undefined ? input.source : cur.source,
          writtenBy: input.writtenBy !== undefined ? input.writtenBy : cur.writtenBy,
          trustTier: computeMemoryTrustTier({
            actor: input.actor,
            source: input.source !== undefined ? input.source : cur.source,
            writtenBy: input.writtenBy !== undefined ? input.writtenBy : cur.writtenBy,
          }),
          ...(typeof input.ephemeral === 'boolean' ? { ephemeral: input.ephemeral } : {}),
          createdAt: cur.createdAt,
          updatedAt: now,
          // Saving a replaced or archived memory again brings it back.
          supersededBy: '',
          archived: false,
        });
        list[idx] = next;
        const supersededId = applySupersedes(next, now);
        await this._saveDoc(list, config);
        this._notify({ action: 'update', id: next.id });
        return { memory: list[idx], created: false, previous: cur, ...(supersededId ? { supersededId } : {}) };
      }

      if (list.filter(isActiveMemory).length >= MAX_MEMORIES) {
        throw Object.assign(
          new Error(`Loop Memory limit (${MAX_MEMORIES}) reached. Delete old memories before adding new ones.`),
          { status: 400 },
        );
      }

      const baseKey = targetKey || slugifyKey(content.slice(0, 48)) || `mem-${randomBytes(3).toString('hex')}`;
      const uniqueKey = makeUniqueMemoryKey(baseKey, list);

      const entry = normalizeEntry({
        id: `mem_${randomBytes(6).toString('hex')}`,
        key: uniqueKey,
        scopeKey: baseKey,
        content,
        scope: input.scope || 'global',
        project: input.project || '',
        tags: input.tags || [],
        links: input.links || [],
        pinned: wantPinned,
        pinnedBy: input.actor === 'agent' || isGuestActor ? 'agent' : 'owner',
        profiles: incomingProfiles !== null ? incomingProfiles : ['all'],
        source: input.source || 'Manual',
        writtenBy: input.writtenBy || 'Owner',
        trustTier: computeMemoryTrustTier({
          actor: input.actor,
          source: input.source || 'Manual',
          writtenBy: input.writtenBy || 'Owner',
        }),
        ...(typeof input.ephemeral === 'boolean' ? { ephemeral: input.ephemeral } : {}),
        createdAt: now,
        updatedAt: now,
      });
      list.unshift(entry);
      const supersededId = applySupersedes(entry, now);
      await this._saveDoc(list, config);
      this._notify({ action: 'save', id: entry.id });
      return { memory: list[0], created: true, ...(supersededId ? { supersededId } : {}) };
    });
  }

  async update(idOrKey, patch = {}) {
    const target = String(idOrKey || '').trim();
    if (!target) return null;
    if (
      (patch?.content !== undefined && looksLikeSecret(patch.content)) ||
      (patch?.key !== undefined && looksLikeSecret(patch.key)) ||
      (patch?.links !== undefined && hasSecretInLinks(patch.links))
    ) {
      throw Object.assign(
        new Error('This looks like a secret or credential. Store secrets in Loop Vault instead.'),
        { status: 400, code: 'SECRET_IN_MEMORY' },
      );
    }
    const nextProfilesPatch = patch?.profiles !== undefined ? validateMemoryProfiles(patch.profiles) : null;
    return this._withLock(async () => {
      const { memories: list, config } = await this._loadDoc();
      const idx = list.findIndex((m) => m.id === target || m.key === target);
      if (idx === -1) return null;
      const cur = list[idx];
      const nextPinned = patch.pinned !== undefined ? Boolean(patch.pinned) : cur.pinned;
      if (nextPinned && !cur.pinned) {
        const pinnedCount = list.filter((m) => m.pinned).length;
        if (pinnedCount >= MAX_PINNED_MEMORIES) {
          throw Object.assign(
            new Error(`You can pin up to ${MAX_PINNED_MEMORIES} memories at a time. Unpin one first.`),
            { status: 400 },
          );
        }
      }
      const nextContent = patch.content !== undefined ? normalizeContent(patch.content) : cur.content;
      if (!nextContent) throw Object.assign(new Error('Memory content cannot be empty.'), { status: 400 });
      const nextKey = patch.key !== undefined ? slugifyKey(patch.key) || cur.key : cur.key;
      if (nextKey !== cur.key && list.some((m, i) => i !== idx && m.key === nextKey)) {
        throw Object.assign(
          new Error(`A memory with key "${nextKey}" already exists.`),
          { status: 409, code: 'DUPLICATE_KEY' },
        );
      }
      const next = normalizeEntry({
        ...cur,
        key: nextKey,
        scopeKey: nextKey === cur.key ? cur.scopeKey : undefined,
        content: nextContent,
        scope: patch.scope !== undefined ? patch.scope : cur.scope,
        project: patch.project !== undefined ? patch.project : cur.project,
        tags: patch.tags !== undefined ? patch.tags : cur.tags,
        links: patch.links !== undefined ? patch.links : cur.links,
        pinned: nextPinned,
        // update() is the owner's dashboard edit, so saving it approves the pin.
        pinnedBy: 'owner',
        profiles: nextProfilesPatch !== null ? nextProfilesPatch : cur.profiles,
        createdAt: cur.createdAt,
        updatedAt: new Date().toISOString(),
      });
      list[idx] = next;
      await this._saveDoc(list, config);
      this._notify({ action: 'update', id: next.id });
      return next;
    });
  }

  async stripProfile(profileId) {
    const cleanId = normalizeProfileTag(profileId);
    if (!cleanId || cleanId === 'all') return { updated: 0 };

    return this._withLock(async () => {
      const { memories: list, config } = await this._loadDoc();
      let updated = 0;
      const now = new Date().toISOString();
      const nextList = list.map((m) => {
        const current = normalizeItemProfiles(m.profiles);
        if (isAllProfiles(current)) return m;
        const nextProfiles = stripProfileFromItemProfiles(current, cleanId);
        if (profilesEqual(current, nextProfiles)) return m;
        updated += 1;
        return {
          ...m,
          profiles: nextProfiles,
          updatedAt: now,
        };
      });
      if (updated > 0) {
        await this._saveDoc(nextList, config);
        this._notify({ action: 'stripProfile', profileId: cleanId, updated });
      }
      return { updated };
    });
  }

  async remove(idOrKey) {
    const target = String(idOrKey || '').trim();
    if (!target) return false;
    return this._withLock(async () => {
      const { memories: list, config } = await this._loadDoc();
      const removed = list.find((m) => m.id === target || m.key === target);
      if (!removed) return false;
      const next = list
        .filter((m) => m.id !== removed.id)
        .map((m) => {
          if (!Array.isArray(m.links) || m.links.length === 0) return m;
          const cleanedLinks = m.links.filter((l) => l.target !== removed.id && l.target !== removed.key);
          return cleanedLinks.length === m.links.length ? m : { ...m, links: cleanedLinks };
        });
      await this._saveDoc(next, config);
      this._notify({ action: 'remove', id: removed.id });
      return true;
    });
  }
}

/* ---------------- Safe Watched Folder Validation ---------------- */

const BLOCKED_HOME_SUBDIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.npm', '.config/gh', 'Library/Keychains'];
const BLOCKED_ABS_PREFIXES = ['/etc', '/System', '/private/etc', '/var/db', '/var/root', '/private/var/db', '/private/var/root', '/proc', '/dev', '/bin', '/sbin', '/usr'];

export function validateSyncFolder(rawPath, { home = os.homedir(), dataDir = defaultDataDir() } = {}) {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed || trimmed.includes('\0')) {
    throw Object.assign(new Error('Folder path is required.'), { status: 400 });
  }
  const expanded = trimmed === '~'
    ? home
    : trimmed.startsWith('~/')
      ? path.join(home, trimmed.slice(2))
      : trimmed;
  if (!path.isAbsolute(expanded)) {
    throw Object.assign(
      new Error('Use an absolute folder path or start with ~/ (for example ~/Notes/AgentMemory).'),
      { status: 400 },
    );
  }
  const resolved = path.resolve(expanded);
  const normHome = path.resolve(home);
  const normData = dataDir ? path.resolve(dataDir) : '';
  if (resolved === '/' || resolved === normHome) {
    throw Object.assign(
      new Error('Choose a specific subfolder instead of your entire home or root directory.'),
      { status: 400 },
    );
  }
  if (normData && (resolved === normData || resolved.startsWith(normData + path.sep) || normData.startsWith(resolved + path.sep))) {
    throw Object.assign(new Error('Loop’s own data folder cannot be added as a watched memory folder.'), { status: 400 });
  }
  for (const sub of BLOCKED_HOME_SUBDIRS) {
    const blocked = path.resolve(normHome, sub);
    if (resolved === blocked || resolved.startsWith(blocked + path.sep)) {
      throw Object.assign(new Error(`Cannot watch sensitive directory "~/${sub}".`), { status: 400 });
    }
  }
  for (const prefix of BLOCKED_ABS_PREFIXES) {
    if (resolved === prefix || resolved.startsWith(prefix + path.sep)) {
      throw Object.assign(new Error(`Cannot watch system directory "${prefix}".`), { status: 400 });
    }
  }
  return resolved;
}

/* ---------------- Native Agent Memory Discovery & Import ---------------- */

function isBoilerplateLine(line) {
  return (
    /SKILL\.md|PLAYBOOK\.md|Trigger:\s*\/|invoke the Skill tool|Shared operating instructions/i.test(line) ||
    /^[-*]\s*\*\*[^*]+\*\*\s*\(`[^`]+SKILL\.md`\)/i.test(line)
  );
}

function parseMarkdownFacts(raw, { source, scope = 'global', project = '', singleCard = false }) {
  const cleanedRaw = String(raw || '')
    .replace(/<!--\s*agent-ops:begin\s*-->[\s\S]*?<!--\s*agent-ops:end\s*-->/gi, '')
    .trim();
  if (!cleanedRaw) return [];

  // Strip YAML frontmatter if present (Claude Code / Obsidian memory files use frontmatter)
  let body = cleanedRaw;
  let fmName = '';
  let fmDesc = '';
  let fmType = '';
  let fmTags = [];
  const fmMatch = cleanedRaw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fmMatch) {
    const header = fmMatch[1];
    body = fmMatch[2].trim();
    fmName = header.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || '';
    fmDesc = header.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || '';
    fmType = header.match(/^type:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || '';
    const rawTags = header.match(/^tags:\s*\[([^\]]+)\]/m)?.[1] || '';
    if (rawTags) fmTags = normalizeTags(rawTags.split(',').map((t) => t.replace(/['"]/g, '')));
  }

  // Claude Code memory/*.md files each represent ONE memory card — never explode a long file into 30 fragments.
  if (fmMatch || singleCard) {
    const firstUseful = body
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^[-*•#]+\s*/, '').trim())
      .filter((l) => l && !l.startsWith('```') && !l.startsWith('<!--') && !isBoilerplateLine(l))
      .slice(0, 3)
      .join(' ');
    const combined = fmDesc
      ? (firstUseful && !firstUseful.toLowerCase().includes(fmDesc.toLowerCase()) && fmDesc.length < 180
          ? `${fmDesc} — ${firstUseful}`
          : fmDesc)
      : firstUseful;
    const clean = normalizeContent(combined).slice(0, 320);
    if (clean.length >= 10 && !looksLikeSecret(clean) && !isBoilerplateLine(clean)) {
      return [{
        key: slugifyKey(fmName || clean.slice(0, 48)),
        content: clean,
        scope: fmType === 'feedback' ? 'preference' : fmType === 'project' ? 'project' : scope,
        project,
        tags: fmTags,
        source,
      }];
    }
    return [];
  }

  // Otherwise extract concise bullet lines or short paragraphs (skipping HTML comments, headings, code blocks, pure links, boilerplate)
  const items = [];
  let inCode = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode || !line || line.startsWith('#') || line.startsWith('<!--') || line.startsWith('-->')) continue;
    if (isBoilerplateLine(line)) continue;
    // Skip markdown index links like "- [file.md](file.md)"
    if (/^[-*]\s+\[[^\]]+\]\([^)]+\)\s*$/.test(line)) continue;
    const bullet = line.replace(/^[-*•]\s+/, '').trim();
    const clean = normalizeContent(bullet);
    if (clean.length < 12 || clean.length > 400) continue;
    if (looksLikeSecret(clean)) continue;
    items.push({
      key: slugifyKey(clean.slice(0, 48)),
      content: clean,
      scope,
      project,
      tags: fmTags,
      source,
    });
    if (items.length >= 25) break;
  }
  return items;
}

function parseMemoryJsonl(rawText, source = 'MCP Memory') {
  const lines = String(rawText || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const entities = [];
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.type === 'entity' || Array.isArray(obj?.observations)) {
        entities.push(obj);
      }
    } catch {
      // ignore non-JSON lines
    }
  }
  if (entities.length === 0) return [];
  return extractMemoriesFromExternalResult({ entities }, source);
}

export function parsePastedMemories(rawText, source = 'Import') {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return [];
  // Support JSON array/object (ChatGPT export, Anthropic server-memory JSON, or custom JSON)
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entities)) {
        const fromEntities = extractMemoriesFromExternalResult(parsed, source);
        if (fromEntities.length > 0) return fromEntities;
      }
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.memories)
          ? parsed.memories
          : [];
      const out = [];
      for (const item of arr) {
        const content = normalizeContent(typeof item === 'string' ? item : item?.content || item?.text || item?.memory || '');
        if (content.length < 6 || looksLikeSecret(content)) continue;
        out.push({
          key: slugifyKey(typeof item === 'object' ? item.key || content.slice(0, 48) : content.slice(0, 48)),
          content,
          scope: normalizeScope(typeof item === 'object' ? item.scope : 'global'),
          project: typeof item === 'object' ? String(item.project || '').trim().slice(0, 80) : '',
          tags: typeof item === 'object' ? normalizeTags(item.tags) : [],
          source,
        });
      }
      if (out.length > 0) return out;
    } catch {
      // Try JSONL (Anthropic @modelcontextprotocol/server-memory memory.json format)
      const fromJsonl = parseMemoryJsonl(trimmed, source);
      if (fromJsonl.length > 0) return fromJsonl;
    }
  }
  return parseMarkdownFacts(trimmed, { source, scope: 'global' });
}

async function scanMarkdownFolder(folderPath, label) {
  const items = [];
  let rootReal;
  try {
    const st = await stat(folderPath);
    if (!st.isDirectory()) return items;
    rootReal = await realpath(folderPath);
  } catch {
    return items;
  }

  let fileCount = 0;
  async function walk(dir, depth) {
    if (depth > 1 || fileCount >= MAX_FOLDER_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (fileCount >= MAX_FOLDER_FILES) break;
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const full = path.join(dir, ent.name);
      try {
        const lst = await lstat(full);
        if (lst.isSymbolicLink()) continue;
        if (lst.isDirectory()) {
          if (depth < 1) await walk(full, depth + 1);
          continue;
        }
        if (!lst.isFile() || lst.size > MAX_FOLDER_FILE_BYTES) continue;
        const ext = path.extname(ent.name).toLowerCase();
        if (ext !== '.md' && ext !== '.mdc' && ext !== '.txt') continue;
        const real = await realpath(full);
        if (real !== rootReal && !real.startsWith(rootReal + path.sep)) continue;
        fileCount += 1;
        const raw = await readFile(real, 'utf8');
        items.push(...parseMarkdownFacts(raw, { source: label, scope: 'global' }));
      } catch {
        // skip unreadable files
      }
    }
  }

  await walk(rootReal, 0);
  return items;
}

export async function discoverMemorySources(
  memoryStore,
  { home = os.homedir(), syncFolders = null, dataDir = memoryStore?.dir || defaultDataDir() } = {},
) {
  const existing = memoryStore ? await memoryStore.list() : [];
  const existingFps = new Set(existing.map((m) => normalizeFingerprint(m.content)));
  const sources = [];

  const addSource = (id, label, rawItems, extra = {}) => {
    const seen = new Set();
    const items = [];
    for (let i = 0; i < rawItems.length; i += 1) {
      const it = rawItems[i];
      const fp = normalizeFingerprint(it.content);
      if (!fp || seen.has(fp)) continue;
      seen.add(fp);
      items.push({
        key: `${id}:${it.key || i}`,
        memoryKey: it.key,
        content: it.content,
        scope: it.scope,
        project: it.project || '',
        tags: it.tags || [],
        source: label,
        status: existingFps.has(fp) ? 'imported' : 'new',
      });
    }
    if (items.length > 0) {
      sources.push({
        id,
        label,
        total: items.length,
        newCount: items.filter((x) => x.status === 'new').length,
        items,
        ...extra,
      });
    }
  };

  // 1. Claude Code (~/.claude/CLAUDE.md + ~/.claude/projects/*/memory/*.md)
  const claudeItems = [];
  try {
    const claudeMd = await readFile(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
    claudeItems.push(...parseMarkdownFacts(claudeMd, { source: 'Claude Code', scope: 'global' }));
  } catch { /* optional */ }
  try {
    const projectsDir = path.join(home, '.claude', 'projects');
    const dirs = await readdir(projectsDir, { withFileTypes: true });
    for (const d of dirs.slice(0, 40)) {
      if (!d.isDirectory()) continue;
      const memDir = path.join(projectsDir, d.name, 'memory');
      try {
        const files = await readdir(memDir);
        const projLabel = d.name.split('-').filter(Boolean).slice(-1)[0] || d.name;
        for (const file of files.slice(0, 20)) {
          if (!file.endsWith('.md') || file.toLowerCase() === 'memory.md') continue;
          try {
            const raw = await readFile(path.join(memDir, file), 'utf8');
            claudeItems.push(...parseMarkdownFacts(raw, { source: 'Claude Code', scope: 'project', project: projLabel, singleCard: true }));
          } catch { /* ignore unreadable */ }
        }
      } catch { /* no memory dir */ }
    }
  } catch { /* optional */ }
  addSource('claude-code', 'Claude Code', claudeItems, { kind: 'agent' });

  // 2. Codex (~/.codex/AGENTS.md)
  try {
    const codexMd = await readFile(path.join(home, '.codex', 'AGENTS.md'), 'utf8');
    addSource('codex', 'Codex', parseMarkdownFacts(codexMd, { source: 'Codex', scope: 'global' }), { kind: 'agent' });
  } catch { /* optional */ }

  // 3. Cursor (~/.cursor/rules/*.mdc / *.md)
  try {
    const rulesDir = path.join(home, '.cursor', 'rules');
    const files = await readdir(rulesDir);
    const cursorItems = [];
    for (const file of files.slice(0, 25)) {
      if (!file.endsWith('.mdc') && !file.endsWith('.md')) continue;
      try {
        const raw = await readFile(path.join(rulesDir, file), 'utf8');
        cursorItems.push(...parseMarkdownFacts(raw, { source: 'Cursor', scope: 'preference' }));
      } catch { /* ignore */ }
    }
    addSource('cursor', 'Cursor', cursorItems, { kind: 'agent' });
  } catch { /* optional */ }

  // 4. Windsurf (~/.codeium/windsurf/memories/global_rules.md)
  try {
    const wsMd = await readFile(path.join(home, '.codeium', 'windsurf', 'memories', 'global_rules.md'), 'utf8');
    addSource('windsurf', 'Windsurf', parseMarkdownFacts(wsMd, { source: 'Windsurf', scope: 'preference' }), { kind: 'agent' });
  } catch { /* optional */ }

  // 5. Gemini CLI / Antigravity (~/.gemini/GEMINI.md)
  try {
    const gemMd = await readFile(path.join(home, '.gemini', 'GEMINI.md'), 'utf8');
    addSource('gemini', 'Gemini', parseMarkdownFacts(gemMd, { source: 'Gemini', scope: 'global' }), { kind: 'agent' });
  } catch { /* optional */ }

  // 6. OpenCode (~/.config/opencode/AGENTS.md)
  try {
    const ocMd = await readFile(path.join(home, '.config', 'opencode', 'AGENTS.md'), 'utf8');
    addSource('opencode', 'OpenCode', parseMarkdownFacts(ocMd, { source: 'OpenCode', scope: 'global' }), { kind: 'agent' });
  } catch { /* optional */ }

  // 7. OpenClaw (~/.openclaw/workspace/MEMORY.md & USER.md)
  const openclawItems = [];
  for (const [fname, sc] of [['MEMORY.md', 'global'], ['USER.md', 'global']]) {
    try {
      const raw = await readFile(path.join(home, '.openclaw', 'workspace', fname), 'utf8');
      openclawItems.push(...parseMarkdownFacts(raw, { source: 'OpenClaw', scope: sc }));
    } catch { /* optional */ }
  }
  addSource('openclaw', 'OpenClaw', openclawItems, { kind: 'agent' });

  // 8. Cline global rules (~/Documents/Cline/Rules/*.md)
  try {
    const clineDir = path.join(home, 'Documents', 'Cline', 'Rules');
    const files = await readdir(clineDir);
    const clineItems = [];
    for (const file of files.slice(0, 25)) {
      if (!file.endsWith('.md') && !file.endsWith('.txt')) continue;
      try {
        const raw = await readFile(path.join(clineDir, file), 'utf8');
        clineItems.push(...parseMarkdownFacts(raw, { source: 'Cline', scope: 'preference' }));
      } catch { /* ignore */ }
    }
    addSource('cline', 'Cline', clineItems, { kind: 'agent' });
  } catch { /* optional */ }

  // 9. Local Anthropic MCP server-memory JSONL (~/.mcp-memory/memory.json or ~/.local/share/mcp-memory/memory.json)
  const mcpMemItems = [];
  for (const candidate of [
    path.join(home, '.mcp-memory', 'memory.json'),
    path.join(home, '.local', 'share', 'mcp-memory', 'memory.json'),
  ]) {
    try {
      const raw = await readFile(candidate, 'utf8');
      const fromJsonl = parseMemoryJsonl(raw, 'MCP Memory');
      if (fromJsonl.length > 0) {
        mcpMemItems.push(...fromJsonl);
      } else {
        mcpMemItems.push(...parsePastedMemories(raw, 'MCP Memory'));
      }
    } catch { /* optional */ }
  }
  addSource('mcp-memory', 'MCP Memory', mcpMemItems, { kind: 'agent' });

  // 10. User-configured watched Markdown / Obsidian folders
  let folders = Array.isArray(syncFolders) ? syncFolders : null;
  if (folders === null && memoryStore && typeof memoryStore.getConfig === 'function') {
    const cfg = await memoryStore.getConfig().catch(() => DEFAULT_MEMORY_CONFIG);
    folders = cfg.syncFolders || [];
  }
  for (const rawFolder of (folders || []).slice(0, MAX_SYNC_FOLDERS)) {
    let validPath;
    try {
      validPath = validateSyncFolder(rawFolder, { home, dataDir });
    } catch {
      continue;
    }
    const base = path.basename(validPath) || 'Folder';
    const slug = slugifyKey(base) || 'folder';
    const folderItems = await scanMarkdownFolder(validPath, base);
    addSource(`folder-${slug}`, base, folderItems, { kind: 'folder', path: validPath });
  }

  return sources;
}
