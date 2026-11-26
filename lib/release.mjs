// Release metadata, checksums, and safe artifact resolution for Loop downloads and updates.

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const MIN_NODE_VERSION = '22.13.0';
const SAFE_TARBALL_RE = /^loop-[a-zA-Z0-9._-]{1,96}\.tar\.gz$/;

export function sha256Buffer(data) {
  return createHash('sha256').update(data).digest('hex');
}

export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function parseSemver(raw) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(raw || '').trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNodeVersionSupported(actual = process.versions.node, minimum = MIN_NODE_VERSION) {
  const a = parseSemver(actual);
  const m = parseSemver(minimum);
  if (!a || !m) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== m[i]) return a[i] > m[i];
  }
  return true;
}

export function parseReleaseFile(root) {
  try {
    const raw = readFileSync(path.join(root, 'RELEASE'), 'utf8').trim();
    if (!raw) return { release: '', commit: '' };
    const [release = '', commit = ''] = raw.split(/\s+/);
    return {
      release: release.slice(0, 80),
      commit: /^[0-9a-f]{7,64}$/i.test(commit) ? commit : '',
    };
  } catch {
    return { release: '', commit: '' };
  }
}

export function readPackageVersion(root) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    return typeof pkg?.version === 'string' && pkg.version.trim() ? pkg.version.trim().slice(0, 40) : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readGitHeadSha(root) {
  try {
    const head = readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
    const sha = ref ? readFileSync(path.join(root, '.git', ref), 'utf8').trim() : head;
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : '';
  } catch {
    return '';
  }
}

/**
 * Concise build/version string for MCP serverInfo.version and /health.
 * Prefers the deployed RELEASE tag, falls back to package.json version + short git sha.
 */
export function currentLoopVersion(root, env = process.env) {
  if (env?.LOOP_BUILD && String(env.LOOP_BUILD).trim()) {
    return String(env.LOOP_BUILD).trim().slice(0, 60);
  }
  const { release } = parseReleaseFile(root);
  if (release) return release;
  const pkgVersion = readPackageVersion(root);
  const sha = readGitHeadSha(root);
  return sha ? `${pkgVersion}+git.${sha.slice(0, 12)}` : pkgVersion;
}

export function resolveReleasesDir(root, env = process.env) {
  const configured = typeof env?.LOOP_RELEASES_DIR === 'string' ? env.LOOP_RELEASES_DIR.trim() : '';
  if (configured) return path.resolve(configured);
  return path.resolve(root, '..', 'releases');
}

export function isValidTarballFilename(name) {
  if (typeof name !== 'string' || !name) return false;
  if (path.basename(name) !== name) return false;
  return SAFE_TARBALL_RE.test(name);
}

async function readPublishedReleaseJson(releasesDir) {
  if (!releasesDir) return null;
  try {
    const raw = await readFile(path.join(releasesDir, 'release.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function resolveTarballDownload(releasesDir, requestedName) {
  if (!releasesDir || typeof requestedName !== 'string' || !requestedName) return null;
  let filename = requestedName;
  if (requestedName === 'loop-latest.tar.gz') {
    const published = await readPublishedReleaseJson(releasesDir);
    filename = published?.tarball?.filename || '';
  }
  if (!isValidTarballFilename(filename)) return null;
  let baseReal;
  try {
    baseReal = await realpath(releasesDir);
  } catch {
    return null;
  }
  const candidate = path.join(baseReal, filename);
  let targetReal;
  try {
    targetReal = await realpath(candidate);
  } catch {
    return null;
  }
  const rel = path.relative(baseReal, targetReal);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const info = await stat(targetReal).catch(() => null);
  if (!info?.isFile()) return null;
  const published = await readPublishedReleaseJson(releasesDir);
  const sha256 =
    published?.tarball?.filename === filename && typeof published?.tarball?.sha256 === 'string'
      ? published.tarball.sha256
      : await sha256File(targetReal);
  return {
    filename,
    filePath: targetReal,
    bytes: info.size,
    sha256,
    release: published?.release || '',
    immutable: requestedName !== 'loop-latest.tar.gz',
  };
}

export async function buildReleaseManifest({
  root,
  origin,
  releasesDir = null,
  connectBundle = null,
  env = process.env,
}) {
  const cleanOrigin = String(origin || '').replace(/\/+$/, '');
  const pkgVersion = readPackageVersion(root);
  const fileInfo = parseReleaseFile(root);
  const gitSha = fileInfo.commit || readGitHeadSha(root);
  const effectiveReleasesDir = releasesDir || resolveReleasesDir(root, env);
  const published = await readPublishedReleaseJson(effectiveReleasesDir);

  const release = published?.release || fileInfo.release || currentLoopVersion(root, env);
  const commit = published?.commit || gitSha || '';
  const publishedAt = typeof published?.publishedAt === 'string' ? published.publishedAt : null;
  const notes = typeof published?.notes === 'string' ? published.notes.slice(0, 600) : '';

  const [skillBuf, hookBuf] = await Promise.all([
    readFile(path.join(root, 'skills', 'loop', 'SKILL.md')).catch(() => null),
    readFile(path.join(root, 'hooks', 'loop-hook.mjs')).catch(() => null),
  ]);

  let tarball = null;
  const pubTarball = published?.tarball;
  if (pubTarball && isValidTarballFilename(pubTarball.filename)) {
    const resolved = await resolveTarballDownload(effectiveReleasesDir, pubTarball.filename);
    if (resolved) {
      tarball = {
        filename: resolved.filename,
        url: `${cleanOrigin}/downloads/loop-latest.tar.gz`,
        versionedUrl: `${cleanOrigin}/downloads/${encodeURIComponent(resolved.filename)}`,
        sha256: resolved.sha256,
        bytes: resolved.bytes,
      };
    }
  }

  return {
    app: 'loop-hub',
    version: pkgVersion,
    release,
    ...(commit ? { commit } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    minNode: MIN_NODE_VERSION,
    ...(notes ? { notes } : {}),
    tarball,
    agentFiles: {
      ...(skillBuf
        ? { skill: { url: `${cleanOrigin}/agent-files/loop-skill.md`, sha256: sha256Buffer(skillBuf) } }
        : {}),
      ...(hookBuf
        ? { hook: { url: `${cleanOrigin}/agent-files/loop-hook.mjs`, sha256: sha256Buffer(hookBuf) } }
        : {}),
      ...(connectBundle
        ? { connect: { url: `${cleanOrigin}/connect.mjs`, sha256: sha256Buffer(connectBundle) } }
        : {}),
    },
    install: {
      scriptUrl: `${cleanOrigin}/install.sh`,
      command: `curl -fsSL ${cleanOrigin}/install.sh | sh`,
      agentUpdateCommand: `curl -fsSL ${cleanOrigin}/connect.mjs | node - --update`,
    },
  };
}
