// Loop Skills Hub: local skill store, cross-agent discovery, import, and safe cleanup.

import { normalizeAddedBy } from './context-names.mjs';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile, createWriteQueue } from './json-file-store.mjs';
import { escapeMarkdown, formatCodeList, pluralize } from './markdown.mjs';
import {
  MAX_PROFILES,
  PROFILE_CONTROL_RE,
  itemMatchesProfile,
  normalizeItemProfiles,
  normalizeProfileTag,
  stripProfileFromItemProfiles,
} from './profiles.mjs';
import { defaultDataDir } from './vault.mjs';

export const DEFAULT_BUNDLED_SKILLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'skills',
);

export const MAX_SKILL_FILES = 500;
export const MAX_SKILL_BYTES = 10 * 1024 * 1024;
export const HOST_ONLY_BUNDLED_SKILLS = Object.freeze(['sync-agents', 'organize']);

// Adding a local package must not silently publish host instructions in cloud workspaces.
const CLOUD_BUNDLED_SKILLS = new Set([
  'capability-ladder', 'connections', 'dream', 'find-capability', 'fix-connection', 'learn-workflow', 'loop', 'setup-project', 'skills', 'vault',
]);

// Quiet aliases for renamed bundled skills so older references still resolve cleanly.
const BUNDLED_SKILL_ALIASES = Object.freeze({
  'setup-profile': 'setup-project',
});

const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const SKIP_COPY_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);
// A skill's file list is for display only. Python environments and caches can hold thousands
// of files (one skill's .venv had over 6,000) and made every skills listing slow.
const SKIP_LIST_NAMES = new Set([...SKIP_COPY_NAMES, '.venv', 'venv', '__pycache__']);

const NATIVE_PATH_MARKERS = [
  '/builtin/skills/',
  '/Applications/',
  '/openai-bundled/',
  '/.codex/skills/.system/',
];

const FRONTMATTER_RE = /^\uFEFF?\s*---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??---[ \t]*(?:\r?\n|$)/;

const YAML_DOUBLE_QUOTE_ESCAPES = Object.freeze({
  '0': '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  '\t': '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
});

function codepointSort(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPathWithin(childPath, parentPath) {
  if (!childPath || !parentPath) return false;
  const rel = path.relative(parentPath, childPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function publicSkillMeta(skill, { stripPaths = false } = {}) {
  if (!skill || typeof skill !== 'object') return skill;
  if (!stripPaths) return { ...skill };
  const {
    path: _path,
    dir: _dir,
    filePath: _filePath,
    resolvedPath: _resolvedPath,
    symlinkTarget: _symlinkTarget,
    ...rest
  } = skill;
  return rest;
}

/* ---------------- Skill source definitions ---------------- */

export function skillSourceDefinitions({ home = os.homedir() } = {}) {
  return [
    { id: 'claude-code', label: 'Claude Code', dir: path.join(home, '.claude', 'skills') },
    { id: 'codex', label: 'Codex', dir: path.join(home, '.codex', 'skills') },
    { id: 'antigravity', label: 'Antigravity', dir: path.join(home, '.gemini', 'config', 'skills') },
    { id: 'cursor', label: 'Cursor', dir: path.join(home, '.cursor', 'skills') },
    { id: 'shared-agents', label: 'Shared Agents (~/.agents)', dir: path.join(home, '.agents', 'skills') },
  ];
}

/* ---------------- Frontmatter & classification helpers ---------------- */

function decodeYamlDoubleQuoted(inner) {
  return inner.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|.)/g, (match, seq) => {
    if (seq.startsWith('u') || seq.startsWith('U') || seq.startsWith('x')) {
      const cp = parseInt(seq.slice(1), 16);
      try {
        return String.fromCodePoint(cp);
      } catch {
        return match;
      }
    }
    if (Object.hasOwn(YAML_DOUBLE_QUOTE_ESCAPES, seq)) {
      return YAML_DOUBLE_QUOTE_ESCAPES[seq];
    }
    return match;
  });
}

function stripYamlTrailingComment(raw) {
  const s = String(raw || '');
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s.trimEnd();
}

function parseYamlQuotedScalar(raw) {
  const s = String(raw || '').trim();
  if (s.startsWith('"')) {
    let i = 1;
    while (i < s.length) {
      if (s[i] === '\\' && i + 1 < s.length) {
        i += 2;
        continue;
      }
      if (s[i] === '"') {
        const trailing = s.slice(i + 1).trim();
        if (!trailing || trailing.startsWith('#')) {
          return { matched: true, value: decodeYamlDoubleQuoted(s.slice(1, i)) };
        }
        return { matched: false, value: null };
      }
      i += 1;
    }
    return { matched: false, value: null };
  }
  if (s.startsWith("'")) {
    let i = 1;
    while (i < s.length) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") {
          i += 2;
          continue;
        }
        const trailing = s.slice(i + 1).trim();
        if (!trailing || trailing.startsWith('#')) {
          return { matched: true, value: s.slice(1, i).replace(/''/g, "'") };
        }
        return { matched: false, value: null };
      }
      i += 1;
    }
    return { matched: false, value: null };
  }
  return { matched: false, value: null };
}

function unquoteYamlScalar(raw) {
  const quoted = parseYamlQuotedScalar(raw);
  if (quoted.matched) return quoted.value;
  return stripYamlTrailingComment(String(raw || '').trim());
}

function foldYamlBlock(lines, style) {
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const match = line.match(/^([ \t]*)/);
    if (match && match[1].length < minIndent) minIndent = match[1].length;
  }
  if (!Number.isFinite(minIndent)) minIndent = 0;

  const dedented = lines.map((line) => (line.trim().length === 0 ? '' : line.slice(minIndent)));

  if (style === '|') {
    return dedented.join('\n').trim();
  }

  // Folded scalar ('>'): join consecutive non-blank lines with spaces, keep paragraph breaks.
  const out = [];
  let paragraph = [];
  for (const line of dedented) {
    if (line.trim().length === 0) {
      if (paragraph.length > 0) {
        out.push(paragraph.join(' '));
        paragraph = [];
      }
    } else {
      paragraph.push(line.trim());
    }
  }
  if (paragraph.length > 0) out.push(paragraph.join(' '));
  return out.join('\n').trim();
}

export function parseFrontmatter(md) {
  const text = String(md || '');
  const match = text.match(FRONTMATTER_RE);
  if (!match) return { name: '', description: '' };
  if (match[1] === undefined || match[1].trim().length === 0) {
    return { name: '', description: '' };
  }

  const lines = match[1].split(/\r?\n/);
  const fields = { name: '', description: '' };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^[ \t]*#/.test(line)) {
      i += 1;
      continue;
    }
    const keyMatch = line.match(/^(name|description)[ \t]*:[ \t]*(.*)$/);
    if (!keyMatch) {
      i += 1;
      continue;
    }

    const key = keyMatch[1];
    const rest = keyMatch[2].trim();
    const blockHeader = stripYamlTrailingComment(rest).trim();

    if (/^[>|][+-]?\d*$/.test(blockHeader)) {
      const style = blockHeader[0];
      const block = [];
      i += 1;
      while (i < lines.length) {
        const next = lines[i];
        if (next.trim().length === 0 || /^[ \t]+/.test(next)) {
          block.push(next);
          i += 1;
        } else {
          break;
        }
      }
      fields[key] = foldYamlBlock(block, style);
      continue;
    }

    const quoted = parseYamlQuotedScalar(rest);
    if (quoted.matched) {
      fields[key] = quoted.value.trim();
      i += 1;
      continue;
    }

    // Plain single-line or indented multi-line continuation scalar.
    const firstPart = stripYamlTrailingComment(rest).trim();
    const parts = firstPart ? [firstPart] : [];
    i += 1;
    while (i < lines.length) {
      const next = lines[i];
      if (/^[ \t]*#/.test(next)) {
        i += 1;
        continue;
      }
      if (/^[ \t]+\S/.test(next)) {
        const cleaned = stripYamlTrailingComment(next.trim()).trim();
        if (cleaned) parts.push(cleaned);
        i += 1;
      } else {
        break;
      }
    }
    fields[key] = unquoteYamlScalar(parts.join(' ')).trim();
  }

  return fields;
}

function normalizePosixPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

export function isNativeOrSystemSkill(entryName, resolvedPath) {
  const name = String(entryName || '');
  if (name.startsWith('.')) {
    return 'Native built-in to this harness (never imported)';
  }
  const normalized = normalizePosixPath(resolvedPath);
  for (const marker of NATIVE_PATH_MARKERS) {
    if (normalized.includes(marker)) {
      return 'Native built-in to this harness (never imported)';
    }
  }
  return null;
}

export function isLoopSelfSkill(entryName, resolvedPath) {
  if (String(entryName || '').toLowerCase() === 'loop') return true;
  const normalized = normalizePosixPath(resolvedPath).toLowerCase();
  return normalized.endsWith('/loop/skills/loop');
}

/* ---------------- Filesystem utilities ---------------- */

function isValidSlug(id) {
  if (typeof id !== 'string') return false;
  if (!SLUG_PATTERN.test(id)) return false;
  if (id === '.' || id === '..' || id.includes('/') || id.includes('\\')) return false;
  return true;
}

function sanitizeSlug(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^[^a-z0-9]+/i, '')
    .slice(0, 100);
  return isValidSlug(cleaned) ? cleaned : null;
}

async function resolveConfinedEntry(fullPath, resolvedRoot) {
  let lst;
  try {
    lst = await lstat(fullPath);
  } catch {
    return null;
  }

  if (lst.isSymbolicLink()) {
    let real;
    try {
      real = await realpath(fullPath);
    } catch {
      return null;
    }
    if (!isPathWithin(real, resolvedRoot)) {
      return { escaped: true, real, isDir: false, isFile: false, st: null };
    }
    let st;
    try {
      st = await stat(real);
    } catch {
      return null;
    }
    return { escaped: false, real, isDir: st.isDirectory(), isFile: st.isFile(), st };
  }

  if (lst.isDirectory()) {
    let real;
    try {
      real = await realpath(fullPath);
    } catch {
      return null;
    }
    if (!isPathWithin(real, resolvedRoot)) {
      return { escaped: true, real, isDir: false, isFile: false, st: null };
    }
    return { escaped: false, real, isDir: true, isFile: false, st: lst };
  }

  if (lst.isFile()) {
    return { escaped: false, real: fullPath, isDir: false, isFile: true, st: lst };
  }

  return null;
}

// Deterministically SHA-256 hashes all confined files (relative paths + bytes) in a skill tree.
// Skips .git / node_modules / .DS_Store and any symlink whose target escapes dirPath.
export async function hashSkillTree(dirPath) {
  const resolvedRoot = await realpath(dirPath);
  const visitedDirs = new Set([resolvedRoot]);
  const files = [];

  async function walk(currentDir, relPrefix) {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => codepointSort(a.name, b.name));

    for (const entry of entries) {
      if (SKIP_COPY_NAMES.has(entry.name)) continue;
      const full = path.join(currentDir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      const resolved = await resolveConfinedEntry(full, resolvedRoot);
      if (!resolved || resolved.escaped) continue;

      if (resolved.isDir) {
        if (visitedDirs.has(resolved.real)) continue;
        visitedDirs.add(resolved.real);
        await walk(full, rel);
      } else if (resolved.isFile) {
        files.push({ rel, real: resolved.real });
      }
    }
  }

  await walk(resolvedRoot, '');
  files.sort((a, b) => codepointSort(a.rel, b.rel));

  const hash = createHash('sha256');
  for (const item of files) {
    const buf = await readFile(item.real);
    const relBuf = Buffer.from(item.rel, 'utf8');
    hash.update(`F:${relBuf.length}:`);
    hash.update(relBuf);
    hash.update(`:${buf.length}:`);
    hash.update(buf);
    hash.update('\n');
  }
  return hash.digest('hex');
}

// Copies a skill directory into destDir while confining all symlinks strictly within resolvedSrc
// and enforcing file count and byte size caps (G6-25).
async function copySkillDirConfined(
  resolvedSrc,
  destDir,
  { maxFiles = MAX_SKILL_FILES, maxBytes = MAX_SKILL_BYTES } = {},
) {
  await mkdir(destDir, { recursive: true, mode: 0o700 });
  const visitedDirs = new Set([resolvedSrc]);
  let fileCount = 0;
  let totalBytes = 0;

  async function walk(srcCurrent, destCurrent) {
    const entries = await readdir(srcCurrent, { withFileTypes: true });
    entries.sort((a, b) => codepointSort(a.name, b.name));

    for (const entry of entries) {
      if (SKIP_COPY_NAMES.has(entry.name)) continue;
      const srcFull = path.join(srcCurrent, entry.name);
      const destFull = path.join(destCurrent, entry.name);

      const resolved = await resolveConfinedEntry(srcFull, resolvedSrc);
      if (!resolved || resolved.escaped) {
        // Skip broken symlinks, special files, and any symlink escaping resolvedSrc.
        continue;
      }

      if (resolved.isDir) {
        if (visitedDirs.has(resolved.real)) continue;
        visitedDirs.add(resolved.real);
        await mkdir(destFull, { recursive: true, mode: 0o700 });
        await walk(srcFull, destFull);
      } else if (resolved.isFile) {
        fileCount += 1;
        if (fileCount > maxFiles) {
          const err = new Error(`Skill exceeds maximum file limit (${maxFiles} files).`);
          err.status = 400;
          throw err;
        }
        if (totalBytes + resolved.st.size > maxBytes) {
          const err = new Error(
            `Skill exceeds maximum size limit (${Math.round(maxBytes / (1024 * 1024))} MiB).`,
          );
          err.status = 400;
          throw err;
        }
        const buf = await readFile(resolved.real);
        totalBytes += buf.length;
        if (totalBytes > maxBytes) {
          const err = new Error(
            `Skill exceeds maximum size limit (${Math.round(maxBytes / (1024 * 1024))} MiB).`,
          );
          err.status = 400;
          throw err;
        }
        const mode = resolved.st.mode & 0o100 ? 0o700 : 0o600;
        await writeFile(destFull, buf, { mode });
        await chmod(destFull, mode);
      }
    }
  }

  await walk(resolvedSrc, destDir);
}

async function listAuxiliaryFiles(rootDir) {
  let resolvedRoot;
  try {
    resolvedRoot = await realpath(rootDir);
  } catch {
    return [];
  }
  const files = [];
  const visitedDirs = new Set([resolvedRoot]);

  async function walk(currentDir, relPrefix) {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_LIST_NAMES.has(entry.name)) continue;
      if (!relPrefix && entry.name === 'SKILL.md') continue;

      const full = path.join(currentDir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      const resolved = await resolveConfinedEntry(full, resolvedRoot);
      if (!resolved || resolved.escaped) continue;

      if (resolved.isDir) {
        if (visitedDirs.has(resolved.real)) continue;
        visitedDirs.add(resolved.real);
        await walk(full, rel);
      } else if (resolved.isFile) {
        files.push(rel);
      }
    }
  }

  await walk(resolvedRoot, '');
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

async function moveDirectorySafe(src, dest) {
  await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  try {
    await rename(src, dest);
  } catch (err) {
    if (err?.code !== 'EXDEV' && err?.code !== 'EPERM') throw err;
    await cp(src, dest, { recursive: true });
    await rm(src, { recursive: true, force: true });
  }
}

// G6-18: Match sources strictly by exact def.id (case-insensitive).
// An explicit empty array [] selects zero agents (never all agents).
function filterSkillSourceDefs(defs, sourceFilter) {
  if (sourceFilter === null || sourceFilter === undefined) return defs;
  if (Array.isArray(sourceFilter)) {
    const wanted = new Set(
      sourceFilter.map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean),
    );
    if (wanted.size === 0) return [];
    return defs.filter((d) => wanted.has(d.id.toLowerCase()));
  }
  if (typeof sourceFilter === 'string') {
    const norm = sourceFilter.trim().toLowerCase();
    if (!norm) return defs;
    return defs.filter((d) => d.id.toLowerCase() === norm);
  }
  return [];
}

async function resolveProtectedLoopRoots(skillStore) {
  const candidates = [skillStore?.dir, skillStore?.skillsDir, skillStore?.bundledDir].filter(Boolean);
  const roots = new Set();
  for (const dir of candidates) {
    const resolved = await realpath(dir).catch(() => path.resolve(dir));
    roots.add(resolved);
  }
  return [...roots];
}

function isInsideAnyRoot(targetReal, protectedRoots) {
  if (!targetReal) return false;
  return protectedRoots.some((root) => isPathWithin(targetReal, root));
}

function overlapsProtectedLoopRoot(targetReal, protectedRoots) {
  if (!targetReal) return false;
  return protectedRoots.some((root) => isPathWithin(targetReal, root) || isPathWithin(root, targetReal));
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

function validateSkillProfiles(raw) {
  if (typeof raw === 'string') {
    if (PROFILE_CONTROL_RE.test(raw)) {
      throw Object.assign(new Error('Skill profiles cannot contain control characters.'), { status: 400 });
    }
    return normalizeItemProfiles(raw);
  }
  if (!Array.isArray(raw)) {
    throw Object.assign(new Error('Skill profiles must be a string or an array of strings.'), { status: 400 });
  }
  if (raw.length > MAX_PROFILES) {
    throw Object.assign(new Error(`A skill can belong to at most ${MAX_PROFILES} profiles.`), { status: 400 });
  }
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw Object.assign(new Error('Each skill profile must be a string.'), { status: 400 });
    }
    if (PROFILE_CONTROL_RE.test(item)) {
      throw Object.assign(new Error('Skill profiles cannot contain control characters.'), { status: 400 });
    }
  }
  return normalizeItemProfiles(raw);
}

function withMetaProfiles(metaEntry, profiles) {
  const next = { ...(metaEntry && typeof metaEntry === 'object' && !Array.isArray(metaEntry) ? metaEntry : {}) };
  const normalized = normalizeItemProfiles(profiles);
  if (isAllProfiles(normalized)) {
    delete next.profiles;
  } else {
    next.profiles = normalized;
  }
  return next;
}

/* ---------------- SkillStore ---------------- */

export class SkillStore {
  constructor(dir = defaultDataDir(), options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    this.dir = dir;
    this.skillsDir = path.join(dir, 'skills');
    this.metaFile = path.join(dir, 'skills-meta.json');
    this.personal = Boolean(opts.personal);
    this.cloud = this.personal || Boolean(opts.hosted);
    this.stripPaths = opts.stripPaths !== undefined ? Boolean(opts.stripPaths) : Boolean(this.personal || opts.hosted);
    this.bundledDir =
      opts.bundledDir === undefined ? DEFAULT_BUNDLED_SKILLS_DIR : opts.bundledDir || null;

    if (opts.excludeBundled !== undefined && opts.excludeBundled !== null) {
      const list = Array.isArray(opts.excludeBundled)
        ? opts.excludeBundled
        : opts.excludeBundled instanceof Set
          ? [...opts.excludeBundled]
          : [];
      this.excludeBundled = new Set(list.map((s) => String(s).trim().toLowerCase()).filter(Boolean));
    } else if (this.personal) {
      this.excludeBundled = new Set(HOST_ONLY_BUNDLED_SKILLS);
    } else {
      this.excludeBundled = new Set();
    }

    // These guides describe host operations and are never useful on cloud workspaces.
    if (this.cloud) {
      for (const id of HOST_ONLY_BUNDLED_SKILLS) this.excludeBundled.add(id);
    }
    this._withQueue = createWriteQueue();
  }

  _withLock(fn) {
    return this._withQueue(fn);
  }

  async _readMeta() {
    try {
      const raw = await readFile(this.metaFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const rawMap =
          parsed.skills && typeof parsed.skills === 'object' && !Array.isArray(parsed.skills)
            ? parsed.skills
            : parsed;
        // Deduplicate any legacy case-insensitive key collisions in metadata (G6-15).
        const out = {};
        const seenLower = new Set();
        for (const [k, v] of Object.entries(rawMap)) {
          const lower = k.toLowerCase();
          if (seenLower.has(lower)) continue;
          seenLower.add(lower);
          out[k] = v;
        }
        return out;
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        // Corrupted or unreadable meta file degrades gracefully to empty metadata.
      }
    }
    return {};
  }

  async _writeMeta(skillsMeta) {
    const payload = JSON.stringify({ version: 1, skills: skillsMeta }, null, 2) + '\n';
    await atomicWriteFile(this.metaFile, payload, { mode: 0o600 });
  }

  async _assertNoCaseCollision(slug, metaMap) {
    const slugLower = slug.toLowerCase();
    const existingDirs = await this._listSkillDirs(this.skillsDir);
    for (const existingId of existingDirs) {
      if (existingId.toLowerCase() === slugLower && existingId !== slug) {
        const err = new Error(
          `Skill "${slug}" conflicts with existing skill "${existingId}" (skill IDs are case-insensitive).`,
        );
        err.status = 409;
        err.code = 'SKILL_ID_CONFLICT';
        throw err;
      }
    }
    for (const metaId of Object.keys(metaMap || {})) {
      if (metaId.toLowerCase() === slugLower && metaId !== slug) {
        const err = new Error(
          `Skill "${slug}" conflicts with existing skill "${metaId}" (skill IDs are case-insensitive).`,
        );
        err.status = 409;
        err.code = 'SKILL_ID_CONFLICT';
        throw err;
      }
    }
  }

  async _readSkillRecordFrom(baseDir, id, { meta = null, bundled = false, includeContent = false } = {}) {
    const skillDir = path.join(baseDir, id);
    const mdPath = path.join(skillDir, 'SKILL.md');
    let content;
    try {
      // System provenance comes from a regular packaged file, never a path alias.
      if (bundled && (!(await lstat(skillDir)).isDirectory() || !(await lstat(mdPath)).isFile())) return null;
      content = await readFile(mdPath, 'utf8');
    } catch {
      return null;
    }

    const fm = parseFrontmatter(content);
    const files = await listAuxiliaryFiles(skillDir);
    const record = {
      id,
      name: fm.name || id,
      description: fm.description || '',
      namespace: bundled ? 'system' : 'user',
      source: bundled ? 'Loop built-in' : meta?.source || 'Local',
      files,
      importedAt: bundled ? null : meta?.importedAt || null,
      profiles: normalizeItemProfiles(meta?.profiles),
      path: skillDir,
    };
    if (!bundled && typeof meta?.contentHash === 'string' && meta.contentHash) {
      record.contentHash = meta.contentHash;
    }
    const addedBy = bundled ? null : normalizeAddedBy(meta?.addedBy);
    if (addedBy) record.addedBy = addedBy;
    if (bundled) {
      record.bundled = true;
      record.systemId = `system:${id}`;
    }
    if (includeContent) {
      record.content = content;
    }
    return this.stripPaths ? publicSkillMeta(record, { stripPaths: true }) : record;
  }

  async _readSkillRecord(id, metaMap, includeContent = false) {
    return this._readSkillRecordFrom(this.skillsDir, id, {
      meta: metaMap[id] || {},
      bundled: false,
      includeContent,
    });
  }

  async _listSkillDirs(baseDir, { excludeNames = null } = {}) {
    if (!baseDir) return [];
    let entries;
    try {
      entries = await readdir(baseDir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
      throw err;
    }

    const ids = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (!isValidSlug(entry.name)) continue;
      const lower = entry.name.toLowerCase();
      if (excludeNames && excludeNames.has(lower)) continue;

      const full = path.join(baseDir, entry.name);
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = (await stat(full)).isDirectory();
        } catch {
          continue;
        }
      }
      if (!isDir) continue;
      ids.push(entry.name);
    }
    return ids;
  }

  async _listBundledDirs() {
    const ids = await this._listSkillDirs(this.bundledDir, { excludeNames: this.excludeBundled });
    return this.cloud ? ids.filter((id) => CLOUD_BUNDLED_SKILLS.has(id)) : ids;
  }

  async list({ profile = 'all', includeContent = false } = {}) {
    const [metaMap, bundledIds, userIds] = await Promise.all([
      this._readMeta(),
      this._listBundledDirs(),
      this._listSkillDirs(this.skillsDir),
    ]);

    // Preserve legacy user IDs; disambiguate only a colliding built-in's catalog ID.
    const userKeys = new Set(userIds.map((id) => id.toLowerCase()));
    const records = await Promise.all([
      ...bundledIds.map((id) =>
        this._readSkillRecordFrom(this.bundledDir, id, {
          meta: metaMap[`system:${id}`] || (!userKeys.has(id.toLowerCase()) && metaMap[id]) || null,
          bundled: true,
          includeContent,
        }),
      ),
      ...userIds.map((id) => this._readSkillRecord(id, metaMap, includeContent)),
    ]);
    const byId = new Map();
    for (const record of records) {
      if (!record) continue;
      if (record.bundled && userKeys.has(record.id.toLowerCase())) record.id = record.systemId;
      byId.set(record.id.toLowerCase(), record);
    }

    let out = [...byId.values()];
    if (profile && profile !== 'all') {
      out = out.filter((skill) => itemMatchesProfile(skill, profile));
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  async _resolveSkillLocation(ref) {
    const systemOnly = typeof ref === 'string' && ref.startsWith('system:');
    const rawId = systemOnly ? ref.slice(7) : ref;
    if (!isValidSlug(rawId)) return null;
    const [metaMap, userIds] = await Promise.all([this._readMeta(), this._listSkillDirs(this.skillsDir)]);
    if (!systemOnly && userIds.includes(rawId)) {
      const skillDir = path.join(this.skillsDir, rawId);
      const record = await this._readSkillRecord(rawId, metaMap, false);
      return record ? { skillDir, record, bundled: false } : null;
    }
    const id = BUNDLED_SKILL_ALIASES[rawId] || rawId;
    const bundledIds = await this._listBundledDirs();
    if (!bundledIds.includes(id)) return null;
    const shadowed = userIds.some((key) => key.toLowerCase() === id.toLowerCase());
    if (shadowed && !systemOnly) return null;
    const skillDir = path.join(this.bundledDir, id);
    const record = await this._readSkillRecordFrom(this.bundledDir, id, {
      meta: metaMap[`system:${id}`] || (!shadowed && metaMap[id]) || null,
      bundled: true,
      includeContent: false,
    });
    if (!record) return null;
    if (shadowed) record.id = record.systemId;
    return { skillDir, record, bundled: true };
  }

  // Lists every confined file in a Skill directory (SKILL.md first) with byte sizes and SHA-256 digests.
  async listSkillManifestFiles(ref, { maxFiles = 512, maxBytes = 16 * 1024 * 1024, maskText = null } = {}) {
    const loc = await this._resolveSkillLocation(ref);
    if (!loc) return null;
    let resolvedRoot;
    try {
      resolvedRoot = await realpath(loc.skillDir);
    } catch {
      return null;
    }
    const visitedDirs = new Set([resolvedRoot]);
    const rawFiles = [];

    async function walk(currentDir, relPrefix) {
      let entries;
      try {
        entries = await readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => codepointSort(a.name, b.name));
      for (const entry of entries) {
        if (SKIP_LIST_NAMES.has(entry.name)) continue;
        const full = path.join(currentDir, entry.name);
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        const resolved = await resolveConfinedEntry(full, resolvedRoot);
        if (!resolved || resolved.escaped) continue;
        if (resolved.isDir) {
          if (visitedDirs.has(resolved.real)) continue;
          visitedDirs.add(resolved.real);
          await walk(full, rel);
        } else if (resolved.isFile) {
          rawFiles.push({ rel, real: resolved.real });
        }
      }
    }

    await walk(resolvedRoot, '');
    rawFiles.sort((a, b) => {
      if (a.rel === 'SKILL.md') return -1;
      if (b.rel === 'SKILL.md') return 1;
      return codepointSort(a.rel, b.rel);
    });

    const files = [];
    let totalBytes = 0;
    for (const item of rawFiles) {
      if (files.length >= maxFiles) break;
      let buf;
      try {
        buf = await readFile(item.real);
      } catch {
        continue;
      }
      if (typeof maskText === 'function') {
        const rawText = buf.toString('utf8');
        const maskedText = maskText(item.rel, rawText);
        if (maskedText !== rawText) {
          buf = Buffer.from(maskedText, 'utf8');
        }
      }
      if (totalBytes + buf.byteLength > maxBytes) continue;
      totalBytes += buf.byteLength;
      const digest = `sha256:${createHash('sha256').update(buf).digest('hex')}`;
      files.push({ rel: item.rel, size: buf.byteLength, digest });
    }
    return { skill: loc.record, files };
  }

  // Reads one confined file from a Skill directory. Rejects traversal, backslashes, and escaped symlinks.
  async readSkillFile(ref, rawRelPath, { maxBytes = 16 * 1024 * 1024 } = {}) {
    if (typeof rawRelPath !== 'string' || !rawRelPath || rawRelPath.length > 512) {
      return { ok: false, code: 'invalid_path' };
    }
    if (rawRelPath.includes('\0') || rawRelPath.includes('\\') || rawRelPath.startsWith('/')) {
      return { ok: false, code: 'invalid_path' };
    }
    const segments = rawRelPath.split('/');
    if (segments.some((seg) => !seg || seg === '.' || seg === '..' || SKIP_LIST_NAMES.has(seg))) {
      return { ok: false, code: 'invalid_path' };
    }
    const relPath = segments.join('/');
    const loc = await this._resolveSkillLocation(ref);
    if (!loc) return { ok: false, code: 'not_found' };
    let resolvedRoot;
    try {
      resolvedRoot = await realpath(loc.skillDir);
    } catch {
      return { ok: false, code: 'not_found' };
    }
    const full = path.join(resolvedRoot, ...segments);
    const resolved = await resolveConfinedEntry(full, resolvedRoot);
    if (!resolved || resolved.escaped || !resolved.isFile) {
      return { ok: false, code: 'not_found' };
    }
    let buffer;
    try {
      buffer = await readFile(resolved.real);
    } catch {
      return { ok: false, code: 'not_found' };
    }
    if (buffer.byteLength > maxBytes) {
      return { ok: false, code: 'too_large' };
    }
    const digest = `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
    return { ok: true, skill: loc.record, relPath, buffer, size: buffer.byteLength, digest };
  }

  async get(ref) {
    const systemOnly = typeof ref === 'string' && ref.startsWith('system:');
    const rawId = systemOnly ? ref.slice(7) : ref;
    if (!isValidSlug(rawId)) return null;
    const [metaMap, userIds] = await Promise.all([this._readMeta(), this._listSkillDirs(this.skillsDir)]);
    if (!systemOnly && userIds.includes(rawId)) return this._readSkillRecord(rawId, metaMap, true);
    const id = BUNDLED_SKILL_ALIASES[rawId] || rawId;
    const bundledIds = await this._listBundledDirs();
    if (!bundledIds.includes(id)) return null;
    const shadowed = userIds.some((key) => key.toLowerCase() === id.toLowerCase());
    if (shadowed && !systemOnly) return null;
    const record = await this._readSkillRecordFrom(this.bundledDir, id, {
      meta: metaMap[`system:${id}`] || (!shadowed && metaMap[id]) || null, bundled: true, includeContent: true,
    });
    if (record && shadowed) record.id = record.systemId;
    return record;
  }

  async search(query = '', { profile = 'all' } = {}) {
    const all = await this.list({ profile });
    const q = String(query || '').trim().toLowerCase();
    if (!q) {
      return all.map(({ id, name, description, source, profiles, namespace, systemId, bundled }) =>
        bundled
          ? { id, name, description, source, profiles, namespace, systemId, bundled: true }
          : { id, name, description, source, profiles, namespace },
      );
    }

    const tokens = q.split(/\s+/).filter(Boolean);
    const scored = [];

    for (const skill of all) {
      const idLower = skill.id.toLowerCase();
      const nameLower = skill.name.toLowerCase();
      const descLower = skill.description.toLowerCase();
      const srcLower = skill.source.toLowerCase();
      const haystack = `${idLower} ${nameLower} ${descLower} ${srcLower}`;

      const exactPhrase = haystack.includes(q);
      const allTokens = tokens.every((t) => haystack.includes(t));
      if (!exactPhrase && !allTokens) continue;

      let score = 1;
      if (idLower === q || nameLower === q) score = 4;
      else if (idLower.includes(q) || nameLower.includes(q)) score = 3;
      else if (exactPhrase) score = 2;

      scored.push({
        score,
        item: {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          source: skill.source,
          profiles: skill.profiles,
          namespace: skill.namespace,
          ...(skill.bundled ? { bundled: true, systemId: skill.systemId } : {}),
        },
      });
    }

    scored.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
    return scored.map((s) => s.item);
  }

  async saveFromDir(
    slug,
    srcDir,
    { source = 'Imported', maxFiles = MAX_SKILL_FILES, maxBytes = MAX_SKILL_BYTES, profiles, addedBy } = {},
  ) {
    if (!isValidSlug(slug)) {
      throw new Error(`Invalid skill slug "${slug}".`);
    }
    if (slug.toLowerCase() === 'loop') {
      throw new Error('Skill slug "loop" is reserved.');
    }
    const validatedProfiles = profiles !== undefined ? validateSkillProfiles(profiles) : undefined;

    let resolvedSrc;
    try {
      resolvedSrc = await realpath(srcDir);
    } catch {
      throw new Error(`Skill source directory not found: ${srcDir}`);
    }

    const skillMdEntry = await resolveConfinedEntry(path.join(resolvedSrc, 'SKILL.md'), resolvedSrc);
    if (!skillMdEntry || skillMdEntry.escaped || !skillMdEntry.isFile) {
      throw new Error(
        skillMdEntry?.escaped
          ? `Skill SKILL.md symlink escapes skill directory: ${srcDir}`
          : `Skill directory is missing a readable SKILL.md: ${srcDir}`,
      );
    }

    try {
      await readFile(skillMdEntry.real, 'utf8');
    } catch {
      throw new Error(`Skill directory is missing a readable SKILL.md: ${srcDir}`);
    }

    return this._withLock(async () => {
      await mkdir(this.skillsDir, { recursive: true, mode: 0o700 });
      const metaMap = await this._readMeta();
      await this._assertNoCaseCollision(slug, metaMap);

      const destDir = path.join(this.skillsDir, slug);

      let sameDir = false;
      try {
        sameDir = (await realpath(destDir)) === resolvedSrc;
      } catch {
        sameDir = false;
      }

      if (!sameDir) {
        const tmpDir = path.join(
          this.skillsDir,
          `.tmp-${slug}-${process.pid}-${randomBytes(4).toString('hex')}`,
        );
        try {
          await copySkillDirConfined(resolvedSrc, tmpDir, { maxFiles, maxBytes });
          await rm(destDir, { recursive: true, force: true });
          await rename(tmpDir, destDir);
        } catch (err) {
          await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          throw err;
        }
      }

      const contentHash = await hashSkillTree(destDir);
      const effectiveProfiles = validatedProfiles !== undefined
        ? validatedProfiles
        : normalizeItemProfiles(metaMap[slug]?.profiles);
      metaMap[slug] = withMetaProfiles(
        {
          source: String(source || 'Imported'),
          importedAt: new Date().toISOString(),
          contentHash,
          ...(normalizeAddedBy(addedBy) ? { addedBy: normalizeAddedBy(addedBy) } : {}),
        },
        effectiveProfiles,
      );
      await this._writeMeta(metaMap);

      const summary = await this._readSkillRecord(slug, metaMap, false);
      if (!summary) {
        throw new Error(`Saved skill "${slug}" could not be read back.`);
      }
      return summary;
    });
  }

  async saveSkillMarkdown(
    rawSlug,
    { name = '', description = '', content = '', source = 'Local', profiles, addedBy } = {},
  ) {
    const candidate = typeof rawSlug === 'string' && rawSlug.trim() ? rawSlug.trim() : String(name || '').trim();
    if (candidate.startsWith('system:')) throw new Error('Bundled Loop skills are read-only.');
    const slug = isValidSlug(candidate)
      ? candidate
      : sanitizeSlug(candidate.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-+$/g, ''));
    if (!slug) {
      throw new Error('Skill id or name is required and must contain letters or numbers.');
    }
    if (slug.toLowerCase() === 'loop') {
      throw new Error('Skill slug "loop" is reserved.');
    }
    const validatedProfiles = profiles !== undefined ? validateSkillProfiles(profiles) : undefined;

    const cleanName = String(name || slug).trim();
    const cleanDesc = String(description || '').trim();
    const rawBody = String(content ?? '');
    const hasFm = FRONTMATTER_RE.test(rawBody);
    let md;
    if (hasFm) {
      md = rawBody.endsWith('\n') ? rawBody : `${rawBody}\n`;
    } else {
      const fmLines = ['---', `name: ${JSON.stringify(cleanName)}`];
      if (cleanDesc) fmLines.push(`description: ${JSON.stringify(cleanDesc)}`);
      fmLines.push('---', '');
      const body = rawBody.trim();
      md = `${fmLines.join('\n')}${body ? `${body}\n` : ''}`;
    }

    return this._withLock(async () => {
      await mkdir(this.skillsDir, { recursive: true, mode: 0o700 });
      const metaMap = await this._readMeta();
      await this._assertNoCaseCollision(slug, metaMap);

      const destDir = path.join(this.skillsDir, slug);
      await mkdir(destDir, { recursive: true, mode: 0o700 });
      await atomicWriteFile(path.join(destDir, 'SKILL.md'), md, { mode: 0o600 });

      const contentHash = await hashSkillTree(destDir);
      const effectiveProfiles = validatedProfiles !== undefined
        ? validatedProfiles
        : normalizeItemProfiles(metaMap[slug]?.profiles);
      metaMap[slug] = withMetaProfiles(
        {
          source: String(source || 'Local'),
          importedAt: new Date().toISOString(),
          contentHash,
          ...(normalizeAddedBy(addedBy) ? { addedBy: normalizeAddedBy(addedBy) } : {}),
        },
        effectiveProfiles,
      );
      await this._writeMeta(metaMap);

      const summary = await this._readSkillRecord(slug, metaMap, false);
      if (!summary) {
        throw new Error(`Saved skill "${slug}" could not be read back.`);
      }
      return summary;
    });
  }

  async updateMeta(id, patch = {}) {
    if (typeof id !== 'string') return null;
    const ref = id.trim();
    const systemOnly = ref.startsWith('system:');
    const cleanId = systemOnly ? ref.slice(7) : ref;
    if (!isValidSlug(cleanId)) return null;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw Object.assign(new Error('Skill metadata patch must be an object.'), { status: 400 });
    }
    const patchProfiles = Object.hasOwn(patch, 'profiles') && patch.profiles !== undefined
      ? validateSkillProfiles(patch.profiles)
      : undefined;

    return this._withLock(async () => {
      const [metaMap, userIds, bundledIds] = await Promise.all([
        this._readMeta(),
        this._listSkillDirs(this.skillsDir),
        this._listBundledDirs(),
      ]);

      const inUser = !systemOnly && userIds.includes(cleanId);
      const inBundled = !inUser && bundledIds.includes(cleanId);
      if (!inUser && !inBundled) return null;

      // Existing clients persist unshadowed, plain-ID profile tags at the plain key.
      // Once a canonical override exists, keep using its distinct metadata slot.
      const canonical = `system:${cleanId}`;
      const metaId = inBundled && (systemOnly || Object.hasOwn(metaMap, canonical)) ? canonical : cleanId;
      const previous = metaMap[metaId] || metaMap[cleanId] || {};
      const existingRecord = await this._readSkillRecordFrom(
        inUser ? this.skillsDir : this.bundledDir,
        cleanId,
        {
          meta: previous,
          bundled: !inUser,
          includeContent: false,
        },
      );
      if (!existingRecord) return null;

      if (patchProfiles !== undefined) {
        const nextMeta = withMetaProfiles(inUser ? previous : {}, patchProfiles);
        // An explicit all-profiles choice must not fall back to legacy metadata.
        if (metaId === canonical && !nextMeta.profiles) nextMeta.profiles = ['all'];
        if (Object.keys(nextMeta).length > 0) {
          metaMap[metaId] = nextMeta;
        } else {
          delete metaMap[metaId];
        }
        await this._writeMeta(metaMap);
      }

      return this.get(ref);
    });
  }

  async stripProfile(profileId) {
    const cleanId = normalizeProfileTag(profileId);
    if (!cleanId || cleanId === 'all') return { updated: 0 };

    return this._withLock(async () => {
      const metaMap = await this._readMeta();
      let updated = 0;
      for (const [slug, meta] of Object.entries(metaMap)) {
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
        if (!Array.isArray(meta.profiles)) continue;
        const current = normalizeItemProfiles(meta.profiles);
        if (isAllProfiles(current)) continue;
        const next = stripProfileFromItemProfiles(current, cleanId);
        if (profilesEqual(current, next)) continue;
        metaMap[slug] = withMetaProfiles(meta, next);
        updated += 1;
      }
      if (updated > 0) {
        await this._writeMeta(metaMap);
      }
      return { updated };
    });
  }

  async remove(id) {
    if (!isValidSlug(id)) return false;

    return this._withLock(async () => {
      const [existingDirs, bundledIds, metaMap] = await Promise.all([
        this._listSkillDirs(this.skillsDir),
        this._listBundledDirs(),
        this._readMeta(),
      ]);
      const dirExists = existingDirs.includes(id);
      if (!dirExists && bundledIds.includes(id)) return false;

      const metaExists = Object.prototype.hasOwnProperty.call(metaMap, id);

      if (!dirExists && !metaExists) return false;

      if (dirExists) {
        const destDir = path.join(this.skillsDir, id);
        await rm(destDir, { recursive: true, force: true });
      }
      if (metaExists) {
        delete metaMap[id];
        await this._writeMeta(metaMap);
      }
      return true;
    });
  }
}

/* ---------------- Cross-agent skill discovery ---------------- */

export async function discoverSkillSources(skillStore, ctx = {}) {
  const defs = ctx.sources || skillSourceDefinitions({ home: ctx.home });
  const [existing, protectedRoots] = await Promise.all([
    skillStore.list(),
    resolveProtectedLoopRoots(skillStore),
  ]);
  const existingIds = new Set(
    existing.filter((s) => !s.bundled).map((s) => s.id.toLowerCase()),
  );
  const seen = new Map();

  const sources = [];
  const summary = {
    totalFound: 0,
    newCount: 0,
    existsCount: 0,
    duplicateCount: 0,
    nativeCount: 0,
  };

  for (const def of defs) {
    const sourceReport = {
      id: def.id,
      label: def.label,
      dir: def.dir,
      found: false,
      error: null,
      skills: [],
    };

    const defDirReal = await realpath(def.dir).catch(() => null);
    if (defDirReal && isInsideAnyRoot(defDirReal, protectedRoots)) {
      sources.push(sourceReport);
      continue;
    }

    let entries;
    try {
      entries = await readdir(def.dir, { withFileTypes: true });
      sourceReport.found = true;
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
        sourceReport.error = err?.message || 'Could not read skills directory.';
      }
      sources.push(sourceReport);
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue;

      const entryPath = path.join(def.dir, entry.name);
      const isSymlink = entry.isSymbolicLink();
      let symlinkTarget = null;
      let resolvedPath = entryPath;
      let brokenSymlink = false;

      if (isSymlink) {
        symlinkTarget = await readlink(entryPath).catch(() => null);
        try {
          resolvedPath = await realpath(entryPath);
        } catch {
          brokenSymlink = true;
        }
      } else {
        resolvedPath = await realpath(entryPath).catch(() => entryPath);
      }

      // Determine whether the entry is a directory (following symlinks).
      let isDir = entry.isDirectory();
      if (isSymlink && !brokenSymlink) {
        try {
          isDir = (await stat(resolvedPath)).isDirectory();
        } catch {
          isDir = false;
        }
      }

      // Dot-folders like .system are native built-in harness directories (never imported).
      if (entry.name.startsWith('.')) {
        if (!isDir) continue;
        const item = {
          key: `${def.id}::${entry.name}`,
          id: entry.name,
          entryName: entry.name,
          name: entry.name,
          description: '',
          source: def.id,
          sourceLabel: def.label,
          path: entryPath,
          resolvedPath,
          isSymlink,
          symlinkTarget,
          status: 'native',
          reason: 'Native built-in to this harness (never imported)',
        };
        sourceReport.skills.push(item);
        summary.totalFound += 1;
        summary.nativeCount += 1;
        continue;
      }

      // Loop's own skill is always kept and never imported as a user skill.
      if (isLoopSelfSkill(entry.name, resolvedPath)) {
        let fm = { name: entry.name, description: '' };
        if (!brokenSymlink && isDir) {
          const md = await readFile(path.join(resolvedPath, 'SKILL.md'), 'utf8').catch(() => null);
          if (md !== null) fm = parseFrontmatter(md);
        }
        const item = {
          key: `${def.id}::${entry.name}`,
          id: entry.name,
          entryName: entry.name,
          name: fm.name || entry.name,
          description: fm.description || '',
          source: def.id,
          sourceLabel: def.label,
          path: entryPath,
          resolvedPath,
          isSymlink,
          symlinkTarget,
          status: 'self',
          reason: 'Loop skill (always kept)',
        };
        sourceReport.skills.push(item);
        summary.totalFound += 1;
        continue;
      }

      // G6-14: Never treat Loop's own store or bundled directory as an external agent skill.
      if (!brokenSymlink && overlapsProtectedLoopRoot(resolvedPath, protectedRoots)) {
        continue;
      }

      if (brokenSymlink || !isDir) continue;

      let mdText;
      try {
        mdText = await readFile(path.join(resolvedPath, 'SKILL.md'), 'utf8');
      } catch {
        // Skip directories without a readable SKILL.md.
        continue;
      }

      const slug = isValidSlug(entry.name) ? entry.name : sanitizeSlug(entry.name);
      if (!slug) continue;

      const fm = parseFrontmatter(mdText);
      const displayName = fm.name || slug;
      const slugKey = slug.toLowerCase();

      const item = {
        key: `${def.id}::${encodeURIComponent(entry.name)}`,
        id: slug,
        entryName: entry.name,
        name: displayName,
        description: fm.description || '',
        source: def.id,
        sourceLabel: def.label,
        path: entryPath,
        resolvedPath,
        isSymlink,
        symlinkTarget,
        status: 'new',
        reason: null,
      };

      const nativeReason = isNativeOrSystemSkill(entry.name, resolvedPath);
      if (nativeReason) {
        item.status = 'native';
        item.reason = nativeReason;
        summary.nativeCount += 1;
      } else if (existingIds.has(slugKey)) {
        item.status = 'exists';
        item.reason = 'Already in Loop';
        summary.existsCount += 1;
      } else if (seen.has(slugKey)) {
        const first = seen.get(slugKey);
        item.status = 'duplicate';
        item.reason = `Same skill as ${first.label}`;
        summary.duplicateCount += 1;
      } else {
        item.status = 'new';
        item.reason = null;
        seen.set(slugKey, { sourceId: def.id, label: def.label, name: displayName });
        summary.newCount += 1;
      }

      sourceReport.skills.push(item);
      summary.totalFound += 1;
    }

    sources.push(sourceReport);
  }

  return { sources, summary };
}

/* ---------------- Before -> After Markdown Visual ---------------- */

export function buildSkillsBeforeAfterVisual(agentRows, totalLoopSkills, { dryRun = false } = {}) {
  const active = (agentRows || []).filter((a) => Array.isArray(a.beforeNames) && a.beforeNames.length > 0);
  const totalBefore = active.reduce((n, a) => n + a.beforeNames.length, 0);
  const lines = [];

  lines.push(
    `### Before — ${pluralize(totalBefore, 'scattered user skill')} across ${pluralize(active.length, 'app')}`,
  );
  lines.push('');
  if (active.length === 0) {
    lines.push('- No scattered user skills found.');
  } else {
    for (const a of active) {
      const preview = formatCodeList(a.beforeNames, 4);
      lines.push(`- **${escapeMarkdown(a.label)}** (${a.beforeNames.length}): ${preview}`);
    }
  }

  lines.push('');
  lines.push(`### After Loop${dryRun ? ' (preview)' : ''}`);
  lines.push('');
  lines.push('_Each agent keeps only native built-ins + `loop`._');
  lines.push('');
  if (active.length === 0) {
    lines.push('- All agents are clean.');
  } else {
    for (const a of active) {
      const otherKept = (a.afterNames || []).filter((n) => !/^loop$/i.test(n));
      const hasNative = Array.isArray(a.nativeNames) && a.nativeNames.length > 0;
      const base = a.hasLoop
        ? hasNative
          ? '`native + loop`'
          : '`loop`'
        : hasNative
          ? 'native only'
          : 'ready for `loop`';

      if (otherKept.length === 0) {
        lines.push(`- **${escapeMarkdown(a.label)}**: ${base} — clean`);
      } else {
        const keptPreview = formatCodeList(otherKept, 3);
        lines.push(`- **${escapeMarkdown(a.label)}**: ${base} — still kept: ${keptPreview}`);
      }
    }
  }

  const count = Number(totalLoopSkills) || 0;
  lines.push('');
  lines.push('### Loop Skills');
  lines.push('');
  lines.push(
    `**${pluralize(count, 'shared skill')} ready** — available to every agent via \`loop__search({ type: "skills" })\`.`,
  );

  return lines.join('\n');
}

/* ---------------- Import skills into Loop ---------------- */

function buildImportAgentRows(sources, importedSlugs, existingSlugs) {
  return sources.map((s) => {
    const userSkills = s.skills.filter(
      (sk) => sk.status === 'new' || sk.status === 'exists' || sk.status === 'duplicate',
    );
    const nativeNames = s.skills
      .filter((sk) => sk.status === 'native')
      .map((sk) => sk.entryName || sk.id);
    const hasLoop = s.skills.some((sk) => sk.status === 'self');
    const beforeNames = userSkills.map((sk) => sk.id);
    const afterNames = userSkills
      .filter((sk) => {
        const lower = sk.id.toLowerCase();
        return !importedSlugs.has(lower) && !existingSlugs.has(lower);
      })
      .map((sk) => sk.id);

    return {
      id: s.id,
      label: s.label,
      beforeNames,
      afterNames,
      hasLoop,
      nativeNames,
    };
  });
}

export async function importSkillsFromAgents(
  skillStore,
  { source = null, dryRun = false, keys = null, ctx = {} } = {},
) {
  const existingBefore = await skillStore.list();
  const before = { skills: existingBefore.length };
  const existingSlugs = new Set(existingBefore.filter((s) => !s.bundled).map((s) => s.id.toLowerCase()));

  const allDefs = ctx.sources || skillSourceDefinitions({ home: ctx.home });
  const scopedDefs = filterSkillSourceDefs(allDefs, source);
  const discovered = await discoverSkillSources(skillStore, { ...ctx, sources: scopedDefs });
  const filteredSources = discovered.sources;
  const summary = discovered.summary;

  const keySet = Array.isArray(keys) ? new Set(keys.map((k) => String(k))) : null;

  if (dryRun) {
    const plannedSlugs = new Set();
    for (const s of filteredSources) {
      for (const sk of s.skills) {
        if (sk.status !== 'new') continue;
        if (keySet && !keySet.has(sk.key) && !keySet.has(sk.id)) continue;
        plannedSlugs.add(sk.id.toLowerCase());
      }
    }
    const agentRows = buildImportAgentRows(filteredSources, plannedSlugs, existingSlugs);
    const projectedTotal = before.skills + plannedSlugs.size;
    const visual = buildSkillsBeforeAfterVisual(agentRows, projectedTotal, { dryRun: true });
    return {
      before,
      sources: filteredSources,
      summary,
      visual,
    };
  }

  const imported = [];
  const skipped = [];
  const importedSlugs = new Set();

  for (const s of filteredSources) {
    for (const sk of s.skills) {
      if (sk.status !== 'new') {
        skipped.push({
          id: sk.id,
          name: sk.name,
          source: s.label,
          status: sk.status,
          reason: sk.reason || `Skipped (${sk.status})`,
        });
        continue;
      }

      if (keySet && !keySet.has(sk.key) && !keySet.has(sk.id)) {
        skipped.push({
          id: sk.id,
          name: sk.name,
          source: s.label,
          status: 'unselected',
          reason: 'Not selected in keys filter',
        });
        continue;
      }

      try {
        const saved = await skillStore.saveFromDir(sk.id, sk.resolvedPath || sk.path, {
          source: s.label,
        });
        importedSlugs.add(saved.id.toLowerCase());
        imported.push({
          id: saved.id,
          name: saved.name,
          description: saved.description,
          source: s.label,
          files: saved.files,
          key: sk.key,
        });
      } catch (err) {
        skipped.push({
          id: sk.id,
          name: sk.name,
          source: s.label,
          status: 'error',
          reason: err?.message || 'Could not import skill',
        });
      }
    }
  }

  const afterList = await skillStore.list();
  const after = { skills: afterList.length };
  const agentRows = buildImportAgentRows(filteredSources, importedSlugs, existingSlugs);
  const visual = buildSkillsBeforeAfterVisual(agentRows, after.skills, { dryRun: false });

  return {
    before,
    after,
    summary: {
      imported: imported.length,
      skipped: skipped.length,
    },
    imported,
    skipped,
    visual,
  };
}

/* ---------------- Safe cleanup of agent skill directories ---------------- */

export async function cleanupAgentSkills(
  skillStore,
  { sources: sourceFilter = null, keys = null, approvedTargets = null, dryRun = false, ctx = {} } = {},
) {
  const selected = keys === null ? null : new Set(keys);
  const defs = ctx.sources || skillSourceDefinitions({ home: ctx.home });
  const activeDefs = filterSkillSourceDefs(defs, sourceFilter);

  const [loopSkills, protectedRoots] = await Promise.all([
    skillStore.list(),
    resolveProtectedLoopRoots(skillStore),
  ]);
  // G6-09: Exclude bundled skills so a user's own skill sharing a bundled name is never deleted.
  const userLoopSkills = loopSkills.filter((s) => !s.bundled);
  const loopSkillMap = new Map(userLoopSkills.map((s) => [s.id.toLowerCase(), s]));

  // G6-10: Cache live SHA-256 tree hashes of Loop's stored user skills.
  const loopHashCache = new Map();
  async function getLoopSkillHash(id) {
    if (loopHashCache.has(id)) return loopHashCache.get(id);
    let h = null;
    try {
      h = await hashSkillTree(path.join(skillStore.skillsDir, id));
    } catch {
      h = null;
    }
    loopHashCache.set(id, h);
    return h;
  }

  // Phase 1: Inspect and classify every agent's entries while the filesystem is untouched
  // so cross-agent symlinks (e.g. ~/.claude/skills/foo -> ~/.agents/skills/foo) still resolve cleanly.
  const plans = [];

  for (const def of activeDefs) {
    // G6-14: Never touch Loop's own store or bundled directory if an agent dir points into it.
    const defDirReal = await realpath(def.dir).catch(() => null);
    if (defDirReal && isInsideAnyRoot(defDirReal, protectedRoots)) {
      continue;
    }

    let entries;
    try {
      entries = await readdir(def.dir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') continue;
      plans.push({
        def,
        error: err?.message || 'Could not read skills directory.',
        toRemove: [],
        kept: [],
        nativeNames: [],
        hasLoop: false,
      });
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    const toRemove = [];
    const kept = [];
    const nativeNames = [];
    let hasLoop = false;

    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue;

      const entryPath = path.join(def.dir, entry.name);
      const isSymlink = entry.isSymbolicLink();
      let symlinkTarget = null;
      let resolvedPath = entryPath;
      let brokenSymlink = false;

      if (isSymlink) {
        symlinkTarget = await readlink(entryPath).catch(() => null);
        try {
          resolvedPath = await realpath(entryPath);
        } catch {
          brokenSymlink = true;
        }
      } else {
        resolvedPath = await realpath(entryPath).catch(() => entryPath);
      }

      let isDir = entry.isDirectory();
      if (isSymlink && !brokenSymlink) {
        try {
          isDir = (await stat(resolvedPath)).isDirectory();
        } catch {
          isDir = false;
        }
      }

      // NEVER touch dot-entries (e.g. .system or hidden config files).
      if (entry.name.startsWith('.')) {
        if (isDir) {
          nativeNames.push(entry.name);
          kept.push({
            name: entry.name,
            reason: 'Native built-in to this harness (always kept)',
            native: true,
          });
        }
        continue;
      }

      // NEVER touch Loop's own skill.
      if (isLoopSelfSkill(entry.name, resolvedPath)) {
        hasLoop = true;
        kept.push({
          name: entry.name,
          reason: 'Loop skill (always kept)',
          self: true,
        });
        continue;
      }

      // G6-14: NEVER touch any entry whose realpath is equal to, inside, or an ancestor of Loop's store or bundled dir.
      if (!brokenSymlink && overlapsProtectedLoopRoot(resolvedPath, protectedRoots)) {
        kept.push({
          name: entry.name,
          reason: 'Inside Loop storage (always kept)',
          self: true,
        });
        continue;
      }

      // NEVER touch native/built-in skills.
      const nativeReason = isNativeOrSystemSkill(entry.name, resolvedPath);
      if (nativeReason) {
        nativeNames.push(entry.name);
        kept.push({
          name: entry.name,
          reason: nativeReason,
          native: true,
        });
        continue;
      }

      // Skip non-skill files or broken symlinks.
      if (brokenSymlink || !isDir) continue;

      let hasSkillMd = false;
      try {
        await readFile(path.join(resolvedPath, 'SKILL.md'), 'utf8');
        hasSkillMd = true;
      } catch {
        hasSkillMd = false;
      }
      if (!hasSkillMd) continue;

      const slug = isValidSlug(entry.name) ? entry.name : sanitizeSlug(entry.name);
      const key = `${def.id}::${encodeURIComponent(entry.name)}`;
      if (selected && !selected.has(key)) {
        kept.push({ name: entry.name, reason: 'Outside cleanup selection' });
        continue;
      }
      const match = slug ? loopSkillMap.get(slug.toLowerCase()) : null;

      // NEVER touch any skill not confirmed as a user skill in skillStore (G6-09).
      if (!match) {
        kept.push({
          name: entry.name,
          reason: 'Not in Loop',
        });
        continue;
      }

      // G6-10: Only remove if the live tree hash matches Loop's stored user skill tree hash.
      const [loopHash, agentHash] = await Promise.all([
        getLoopSkillHash(match.id),
        hashSkillTree(resolvedPath).catch(() => null),
      ]);
      if (!loopHash || !agentHash || agentHash !== loopHash) {
        kept.push({
          name: entry.name,
          reason: 'Changed since import (differs from Loop copy)',
        });
        continue;
      }

      const target = JSON.stringify([entryPath, resolvedPath, key, isSymlink, agentHash]);
      if (approvedTargets && !approvedTargets.has(target)) {
        kept.push({ name: entry.name, reason: 'Outside approved cleanup targets' });
        continue;
      }
      toRemove.push({
        key, target,
        name: entry.name,
        id: match.id,
        path: entryPath,
        isSymlink,
        symlinkTarget,
      });
    }

    plans.push({
      def,
      error: null,
      toRemove,
      kept,
      nativeNames,
      hasLoop,
    });
  }

  // Phase 2: Execute backups and moves/unlinks when dryRun is false.
  const anyToRemove = plans.some((p) => p.toRemove.length > 0);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = !dryRun && anyToRemove
    ? path.join(skillStore.dir, 'backups', `skills-${stamp}`)
    : null;

  const agents = [];
  const agentRows = [];
  let totalRemoved = 0;
  let totalKept = 0;

  for (const plan of plans) {
    if (plan.error) {
      agents.push({
        id: plan.def.id,
        label: plan.def.label,
        dir: plan.def.dir,
        error: plan.error,
        removed: [],
        kept: [],
        backupDir: null,
      });
      continue;
    }

    let agentBackupDir = null;
    const removedOut = [];
    const keptOut = [...plan.kept];

    if (!dryRun && plan.toRemove.length > 0) {
      agentBackupDir = path.join(backupDir, plan.def.id);
      await mkdir(agentBackupDir, { recursive: true, mode: 0o700 });
      const symlinksManifest = [];

      for (const item of plan.toRemove) {
        try {
          if (item.isSymlink) {
            symlinksManifest.push({
              name: item.name,
              path: item.path,
              target: item.symlinkTarget,
              removedAt: new Date().toISOString(),
            });
            await unlink(item.path);
          } else {
            const backupDest = path.join(agentBackupDir, item.name);
            await moveDirectorySafe(item.path, backupDest);
          }
          removedOut.push({
            name: item.name,
            key: item.key, target: item.target, path: item.path,
            loopId: item.id,
            isSymlink: item.isSymlink,
            symlinkTarget: item.symlinkTarget,
          });
        } catch (err) {
          keptOut.push({
            name: item.name,
            reason: `Could not move to backup: ${err?.message || 'filesystem error'}`,
          });
        }
      }

      if (symlinksManifest.length > 0) {
        await writeFile(
          path.join(agentBackupDir, 'symlinks.json'),
          JSON.stringify(symlinksManifest, null, 2) + '\n',
          { mode: 0o600 },
        );
      }
    } else {
      for (const item of plan.toRemove) {
        removedOut.push({
          name: item.name,
          key: item.key, target: item.target, path: item.path,
          loopId: item.id,
          isSymlink: item.isSymlink,
          symlinkTarget: item.symlinkTarget,
        });
      }
    }

    totalRemoved += removedOut.length;
    totalKept += keptOut.length;

    const userKeptNames = keptOut
      .filter((k) => !k.native && !k.self)
      .map((k) => k.name);
    const beforeNames = [...removedOut.map((r) => r.name), ...userKeptNames];

    agents.push({
      id: plan.def.id,
      label: plan.def.label,
      dir: plan.def.dir,
      beforeCount: beforeNames.length,
      afterCount: userKeptNames.length,
      removed: removedOut,
      kept: keptOut,
      backupDir: agentBackupDir,
    });

    agentRows.push({
      id: plan.def.id,
      label: plan.def.label,
      beforeNames,
      afterNames: userKeptNames,
      hasLoop: plan.hasLoop,
      nativeNames: plan.nativeNames,
    });
  }

  const visual = buildSkillsBeforeAfterVisual(agentRows, loopSkills.length, { dryRun });

  return {
    dryRun,
    totalRemoved,
    totalKept,
    backupDir,
    agents,
    totalLoopSkills: loopSkills.length,
    visual,
  };
}
