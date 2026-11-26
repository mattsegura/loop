// Loop Skills over MCP (SEP-2640 / io.modelcontextprotocol/skills).
//
// Security invariants:
// - Never advertises directoryRead until resources/directory/read is implemented.
// - Enforces one unified permission check across search, skills/list, skills/get, and resources/read.
// - Partner Skills from upstream MCP servers require explicit Owner opt-in (conn.partnerSkillsEnabled === true).
// - Action-only agents (toolGrants != null) receive zero Skills across every read path.
// - Verifies SHA-256 digests and byte limits on proxied remote Skill files; rejects mismatches.

import { createHash } from 'node:crypto';
import path from 'node:path';

export const MCP_SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';
export const SKILL_URI_PREFIX = 'skill://';
export const MAX_REMOTE_SKILLS_PER_CONN = 100;
export const MAX_SKILL_MANIFEST_FILES = 512;
export const MAX_SKILL_BUNDLE_BYTES = 16 * 1024 * 1024;
export const SKILLS_LIST_TTL_MS = 300_000;
export const SKILLS_LIST_PAGE_SIZE = 100;

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;
const SAFE_AUTHORITY_RE = /^[a-z0-9][a-z0-9._-]{0,160}$/i;
const SYSTEM_URI_PREFIX = 'loop-system--';

const TEXT_EXTENSIONS = new Map([
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.txt', 'text/plain'],
  ['.json', 'application/json'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.toml', 'application/toml'],
  ['.xml', 'application/xml'],
  ['.csv', 'text/csv'],
  ['.tsv', 'text/tab-separated-values'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.css', 'text/css'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.cjs', 'text/javascript'],
  ['.ts', 'text/typescript'],
  ['.tsx', 'text/typescript'],
  ['.jsx', 'text/javascript'],
  ['.py', 'text/x-python'],
  ['.sh', 'text/x-shellscript'],
  ['.rb', 'text/x-ruby'],
  ['.go', 'text/x-go'],
  ['.rs', 'text/x-rust'],
  ['.sql', 'text/x-sql'],
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(raw, maxLen) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function sanitizeSlugSegment(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/g, '')
    .slice(0, 80);
}

export function inferSkillFileMimeType(relPath) {
  const ext = path.extname(String(relPath || '')).toLowerCase();
  return TEXT_EXTENSIONS.get(ext) || 'application/octet-stream';
}

export function isTextSkillMimeType(mimeType) {
  const clean = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return (
    clean.startsWith('text/') ||
    clean === 'application/json' ||
    clean === 'application/yaml' ||
    clean === 'application/toml' ||
    clean === 'application/xml'
  );
}

/**
 * Extracts Skills over MCP (SEP-2640) client capability support from initialize or _meta capabilities.
 */
export function extractMcpSkillsCapability(rawCaps) {
  const caps = isPlainObject(rawCaps) ? rawCaps : {};
  const ext =
    (isPlainObject(caps.extensions) ? caps.extensions[MCP_SKILLS_EXTENSION] : null) ||
    (isPlainObject(caps.experimental) ? caps.experimental[MCP_SKILLS_EXTENSION] : null);
  return {
    supported: Boolean(isPlainObject(ext)),
  };
}

/**
 * Converts a Loop skill id (local, system:<slug>, or <connId>__<slug>) into a safe skill:// authority.
 */
export function skillIdToUriAuthority(skillId) {
  const raw = String(skillId || '').trim();
  if (!raw) return null;
  if (raw.startsWith('system:')) {
    const slug = raw.slice('system:'.length);
    return SAFE_AUTHORITY_RE.test(slug) ? `${SYSTEM_URI_PREFIX}${slug}` : null;
  }
  return SAFE_AUTHORITY_RE.test(raw) ? raw : null;
}

/**
 * Converts a skill:// authority back to a Loop skill id.
 */
export function uriAuthorityToSkillId(authority) {
  const raw = String(authority || '').trim();
  if (!raw || !SAFE_AUTHORITY_RE.test(raw)) return null;
  if (raw.startsWith(SYSTEM_URI_PREFIX)) {
    const inner = raw.slice(SYSTEM_URI_PREFIX.length);
    return SAFE_AUTHORITY_RE.test(inner) ? `system:${inner}` : null;
  }
  return raw;
}

export function buildSkillFileUri(skillId, relPath = 'SKILL.md') {
  const authority = skillIdToUriAuthority(skillId);
  if (!authority) return null;
  const cleanRel = validateSkillRelPath(relPath);
  if (!cleanRel) return null;
  return `${SKILL_URI_PREFIX}${authority}/${cleanRel}`;
}

export function validateSkillRelPath(rawRel) {
  if (typeof rawRel !== 'string' || !rawRel || rawRel.length > 512) return null;
  if (rawRel.includes('\0') || rawRel.includes('\\') || rawRel.includes('?') || rawRel.includes('#')) {
    return null;
  }
  if (rawRel.startsWith('/') || rawRel.endsWith('/')) return null;
  const parts = rawRel.split('/');
  if (parts.some((seg) => !seg || seg === '.' || seg === '..' || /[\u0000-\u001f\u007f]/.test(seg))) {
    return null;
  }
  return parts.join('/');
}

/**
 * Parses a skill://<authority>/<relPath> URI strictly (no traversal, query, or fragment).
 */
export function parseSkillUri(rawUri) {
  if (typeof rawUri !== 'string' || !rawUri.startsWith(SKILL_URI_PREFIX) || rawUri.length > 1024) {
    return null;
  }
  const rest = rawUri.slice(SKILL_URI_PREFIX.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx <= 0) return null;
  const authority = rest.slice(0, slashIdx);
  const rawRel = rest.slice(slashIdx + 1);
  if (!rawRel || rawRel.includes('?') || rawRel.includes('#') || rawRel.includes('\\') || rawRel.includes('\0')) {
    return null;
  }
  let decodedRel;
  try {
    decodedRel = rawRel
      .split('/')
      .map((seg) => {
        const dec = decodeURIComponent(seg);
        if (dec.includes('/') || dec.includes('\\')) throw new Error('invalid_segment');
        return dec;
      })
      .join('/');
  } catch {
    return null;
  }
  const relPath = validateSkillRelPath(decodedRel);
  if (!SAFE_AUTHORITY_RE.test(authority) || !relPath) return null;
  const skillId = uriAuthorityToSkillId(authority);
  if (!skillId) return null;
  return { authority, skillId, relPath, uri: `${SKILL_URI_PREFIX}${authority}/${relPath}` };
}

export function isSkillResourceUri(uri) {
  return typeof uri === 'string' && uri.startsWith(SKILL_URI_PREFIX);
}

/**
 * Splits a partner skill id ("<connId>__<remoteSlug>"). Connection IDs never contain "__".
 */
export function splitPartnerSkillId(skillId) {
  if (typeof skillId !== 'string') return null;
  const idx = skillId.indexOf('__');
  if (idx <= 0) return null;
  const connId = skillId.slice(0, idx);
  const remoteSlug = skillId.slice(idx + 2);
  if (!connId || !remoteSlug || !/^[a-z0-9](?:[a-z0-9_]*[a-z0-9])?$/.test(connId) || connId.includes('__')) {
    return null;
  }
  return { connId, remoteSlug };
}

function extractRelPathFromUpstreamUri(entryUri, resourceUri) {
  if (typeof entryUri !== 'string' || typeof resourceUri !== 'string') return null;
  const entryTrim = entryUri.trim();
  const resTrim = resourceUri.trim();
  if (!resTrim || resTrim.length > 1024) return null;
  if (resTrim === entryTrim) return 'SKILL.md';

  const lastSlash = entryTrim.lastIndexOf('/');
  if (lastSlash > 0) {
    const basePrefix = entryTrim.slice(0, lastSlash + 1);
    if (resTrim.startsWith(basePrefix)) {
      return validateSkillRelPath(resTrim.slice(basePrefix.length));
    }
  }
  const parsed = parseSkillUri(resTrim);
  return parsed ? parsed.relPath : null;
}

/**
 * Normalizes and caps remote Skills returned by an upstream MCP server's `skills/list`.
 */
export function normalizeUpstreamSkills(rawSkills, connId = '') {
  if (!Array.isArray(rawSkills)) return [];
  const out = [];
  const seenSlugs = new Set();

  for (const item of rawSkills) {
    if (!isPlainObject(item)) continue;
    if (out.length >= MAX_REMOTE_SKILLS_PER_CONN) break;

    const upstreamUri =
      typeof item.uri === 'string' && item.uri.trim()
        ? item.uri.trim()
        : typeof item.upstreamUri === 'string' && item.upstreamUri.trim()
          ? item.upstreamUri.trim()
          : '';
    if (!upstreamUri || upstreamUri.length > 1024) continue;
    const parsedUpstream = parseSkillUri(upstreamUri);
    const fm = isPlainObject(item.frontmatter) ? item.frontmatter : {};
    const name = cleanText(fm.name || item.name || parsedUpstream?.authority || '', 120);
    const description = cleanText(fm.description || item.description || '', 1000);
    const remoteSlug = sanitizeSlugSegment(item.slug || parsedUpstream?.authority || name);
    if (!remoteSlug || seenSlugs.has(remoteSlug)) continue;
    seenSlugs.add(remoteSlug);

    let resources = 'dynamic';
    if (item.resources === 'dynamic') {
      resources = 'dynamic';
    } else if (Array.isArray(item.resources)) {
      const normalizedRes = [];
      const seenRel = new Set();
      let totalBytes = 0;
      for (const r of item.resources) {
        if (!isPlainObject(r)) continue;
        if (normalizedRes.length >= MAX_SKILL_MANIFEST_FILES) break;
        const rUri =
          typeof r.uri === 'string' && r.uri.trim()
            ? r.uri.trim()
            : typeof r.upstreamUri === 'string' && r.upstreamUri.trim()
              ? r.upstreamUri.trim()
              : '';
        if (!rUri || rUri.length > 1024) continue;
        const relPath =
          (typeof r.relPath === 'string' ? validateSkillRelPath(r.relPath) : null) ||
          extractRelPathFromUpstreamUri(upstreamUri, rUri);
        if (!relPath || seenRel.has(relPath)) continue;
        const size = Number.isInteger(r.size) && r.size >= 0 ? r.size : null;
        if (size !== null && totalBytes + size > MAX_SKILL_BUNDLE_BYTES) continue;
        const digest = typeof r.digest === 'string' && DIGEST_RE.test(r.digest.trim())
          ? r.digest.trim().toLowerCase()
          : null;
        seenRel.add(relPath);
        if (size !== null) totalBytes += size;
        normalizedRes.push({
          relPath,
          upstreamUri: rUri,
          ...(digest ? { digest } : {}),
          ...(size !== null ? { size } : {}),
        });
      }
      if (!seenRel.has('SKILL.md')) {
        normalizedRes.unshift({ relPath: 'SKILL.md', upstreamUri });
      }
      resources = normalizedRes;
    } else {
      resources = [{ relPath: 'SKILL.md', upstreamUri }];
    }

    out.push({
      slug: remoteSlug,
      ...(connId ? { id: `${connId}__${remoteSlug}` } : {}),
      name: name || remoteSlug,
      description,
      upstreamUri,
      resources,
    });
  }

  return out;
}

/**
 * Projects one stored upstream skill entry on a Connection into a Loop catalog skill record.
 */
export function buildPartnerSkillRecord(conn, rawSkill) {
  if (!conn || !rawSkill || typeof rawSkill !== 'object') return null;
  const slug = sanitizeSlugSegment(rawSkill.slug || rawSkill.name);
  if (!slug) return null;
  const id = `${conn.id}__${slug}`;
  const uri = buildSkillFileUri(id, 'SKILL.md');
  if (!uri) return null;
  return {
    id,
    slug,
    name: rawSkill.name || slug,
    description: rawSkill.description || '',
    namespace: 'partner',
    partner: true,
    connectionId: conn.id,
    connectionName: conn.name || conn.id,
    source: `${conn.name || conn.id} (MCP)`,
    profiles: Array.isArray(conn.profiles) ? conn.profiles : ['all'],
    upstreamUri: rawSkill.upstreamUri,
    uri,
    resources: rawSkill.resources,
    files: Array.isArray(rawSkill.resources)
      ? rawSkill.resources.filter((r) => r.relPath !== 'SKILL.md').map((r) => r.relPath)
      : [],
  };
}

/**
 * Formats a local SkillStore skill into a SEP-2640 skills/list or skills/get entry.
 */
export async function buildLocalMcpSkillEntry(skillStore, skill, { maskText = null } = {}) {
  const manifest = await skillStore.listSkillManifestFiles(skill.systemId || skill.id, {
    maxFiles: MAX_SKILL_MANIFEST_FILES,
    maxBytes: MAX_SKILL_BUNDLE_BYTES,
    maskText:
      typeof maskText === 'function'
        ? (rel, text) => (isTextSkillMimeType(inferSkillFileMimeType(rel)) ? maskText(text) : text)
        : null,
  });
  if (!manifest) return null;
  const entryUri = buildSkillFileUri(skill.id, 'SKILL.md');
  if (!entryUri) return null;
  const resources = manifest.files
    .map((f) => {
      const uri = buildSkillFileUri(skill.id, f.rel);
      if (!uri) return null;
      return { uri, digest: f.digest, size: f.size };
    })
    .filter(Boolean);
  return {
    uri: entryUri,
    frontmatter: {
      name: skill.name || skill.id,
      description: skill.description || '',
    },
    resources,
  };
}

/**
 * Formats an enabled remote partner Skill into a SEP-2640 skills/list or skills/get entry.
 */
export function buildPartnerMcpSkillEntry(partnerSkill) {
  const entryUri = buildSkillFileUri(partnerSkill.id, 'SKILL.md');
  if (!entryUri) return null;
  let resources = 'dynamic';
  if (Array.isArray(partnerSkill.resources)) {
    resources = partnerSkill.resources
      .map((r) => {
        const uri = buildSkillFileUri(partnerSkill.id, r.relPath);
        if (!uri) return null;
        return {
          uri,
          ...(r.digest ? { digest: r.digest } : {}),
          ...(Number.isInteger(r.size) ? { size: r.size } : {}),
        };
      })
      .filter(Boolean);
  }
  return {
    uri: entryUri,
    frontmatter: {
      name: partnerSkill.name || partnerSkill.slug,
      description: partnerSkill.description
        ? `[${partnerSkill.connectionName}] ${partnerSkill.description}`
        : `[${partnerSkill.connectionName}] Partner skill`,
    },
    resources,
  };
}

/**
 * Verifies a fetched remote Skill resource payload against expected manifest size and SHA-256 digest.
 */
export function verifySkillFileContent(contentItem, expected = null) {
  if (!isPlainObject(contentItem)) {
    return { ok: false, reason: 'missing_content' };
  }
  let bytes;
  if (typeof contentItem.text === 'string') {
    bytes = Buffer.from(contentItem.text, 'utf8');
  } else if (typeof contentItem.blob === 'string') {
    bytes = Buffer.from(contentItem.blob, 'base64');
  } else {
    return { ok: false, reason: 'missing_content' };
  }
  if (bytes.byteLength > MAX_SKILL_BUNDLE_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (expected && Number.isInteger(expected.size) && bytes.byteLength !== expected.size) {
    return { ok: false, reason: 'size_mismatch', actualSize: bytes.byteLength, expectedSize: expected.size };
  }
  if (expected && typeof expected.digest === 'string' && DIGEST_RE.test(expected.digest)) {
    if (digest !== expected.digest.toLowerCase()) {
      return { ok: false, reason: 'digest_mismatch', actualDigest: digest, expectedDigest: expected.digest };
    }
  }
  return { ok: true, size: bytes.byteLength, digest, bytes };
}

/**
 * Builds an MCP resources/read payload for a local SkillStore file read.
 */
export function buildLocalSkillResourcePayload(uri, readRes) {
  const mimeType = inferSkillFileMimeType(readRes.relPath);
  if (isTextSkillMimeType(mimeType)) {
    return {
      contents: [
        {
          uri,
          mimeType,
          text: readRes.buffer.toString('utf8'),
        },
      ],
    };
  }
  return {
    contents: [
      {
        uri,
        mimeType,
        blob: readRes.buffer.toString('base64'),
      },
    ],
  };
}
