// Portable ToolSetups (account-level desired state in Loop Cloud),
// LocalInstallStore (machine-local installations & cloud routes on this computer),
// save-time portability analysis, SHA-256 integrity verification, and optional
// private tunnel validation (Tailscale / Cloudflare Tunnel).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, createWriteQueue, readJsonWithBackup } from './json-file-store.mjs';
import { isLoopbackHostname } from './outbound-policy.mjs';
import { normalizeItemProfiles } from './profiles.mjs';
import { findSecretRefs, hasInternalSecretRefs, isInternalVaultKey } from './secret-refs.mjs';
import { isSecretEnv, looksLikeSecretValue, secretArgs } from './connection-admission.mjs';
import { defaultDataDir } from './vault.mjs';

export const TOOL_HOMES = Object.freeze(['cloud', 'local']);
export const REMOTE_ACCESS_LEVELS = Object.freeze(['local_only', 'ask_approval', 'remote_auto']);
export const TUNNEL_MODES = Object.freeze(['loop_relay', 'tailscale', 'cloudflare_tunnel']);
export const INSTALL_STATUSES = Object.freeze([
  'not_installed',
  'installing',
  'ready',
  'needs_attention',
  'failed',
  'uninstalled',
]);
export const INSTALL_SOURCES = Object.freeze(['npm', 'pypi', 'git', 'docker', 'binary', 'command']);

const TOOL_HOME_SET = new Set(TOOL_HOMES);
const REMOTE_ACCESS_SET = new Set(REMOTE_ACCESS_LEVELS);
const TUNNEL_MODE_SET = new Set(TUNNEL_MODES);
const INSTALL_STATUS_SET = new Set(INSTALL_STATUSES);
const INSTALL_SOURCE_SET = new Set(INSTALL_SOURCES);

const SHA256_RE = /^[0-9a-f]{64}$/i;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;
const SETUP_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const SENSITIVE_LOCAL_TOOL_RE =
  /(?:^|[\s/_-])(shell|bash|zsh|sh|terminal|exec|filesystem|files|fs|command|osascript|applescript|desktop[-_]?commander|playwright|puppeteer|computer[-_]?use)(?:$|[\s/_-])/i;
const MACOS_PERMISSION_HINTS = [
  { re: /\bnotes\b|apple[-_]?notes/i, permission: 'macos_notes', label: 'Allow Notes access in macOS Settings' },
  { re: /\bcontacts\b|address[-_]?book/i, permission: 'macos_contacts', label: 'Allow Contacts access in macOS Settings' },
  { re: /\bcalendar\b|ical/i, permission: 'macos_calendar', label: 'Allow Calendar access in macOS Settings' },
  { re: /\breminders\b/i, permission: 'macos_reminders', label: 'Allow Reminders access in macOS Settings' },
  { re: /\bmail\b|apple[-_]?mail/i, permission: 'macos_mail', label: 'Allow Mail access in macOS Settings' },
  { re: /\bimessage\b|messages\.db/i, permission: 'macos_full_disk', label: 'Allow Full Disk Access in macOS Settings' },
];

const LOCAL_PATH_ARG_RE = /^(?:~\/|\.\.?\/|\/Users\/|\/home\/|\/Volumes\/|\/Applications\/|\/opt\/|\/var\/|\/tmp\/|[A-Za-z]:\\)/;
const SCRIPT_EXT_RE = /\.(?:m?js|cjs|ts|py|rb|sh|zsh|bash|pl|php|exe|bin|jar)$/i;
const RUNNER_COMMANDS = new Set(['node', 'deno', 'bun', 'python', 'python3', 'ruby', 'perl', 'bash', 'sh', 'zsh', 'pwsh']);
const NPX_COMMANDS = new Set(['npx', 'bunx']);
const UVX_COMMANDS = new Set(['uvx', 'pipx']);

export class ToolSetupError extends Error {
  constructor(message, status = 400, code = 'TOOL_SETUP_ERROR', extra = {}) {
    super(message);
    this.name = 'ToolSetupError';
    this.status = status;
    this.code = code;
    this.publicMessage = message;
    Object.assign(this, extra);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, max = 120, fallback = '') {
  const out = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return out || fallback;
}

export function slugifySetupId(raw) {
  const clean = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return clean && clean !== 'loop' && clean !== 'loop_host' ? clean : 'tool';
}

export function normalizeRemoteAccess(raw, fallback = null) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const clean = String(raw).trim().toLowerCase();
  return REMOTE_ACCESS_SET.has(clean) ? clean : fallback;
}

export function validateRemoteAccess(raw) {
  const normalized = normalizeRemoteAccess(raw, null);
  if (!normalized) {
    throw new ToolSetupError(
      'remoteAccess must be "local_only", "ask_approval", or "remote_auto".',
      400,
      'INVALID_REMOTE_ACCESS',
    );
  }
  return normalized;
}

export function defaultRemoteAccessFor(conn) {
  if (!conn || typeof conn !== 'object') return 'local_only';
  const explicit = normalizeRemoteAccess(conn.remoteAccess, null);
  if (explicit) return explicit;
  const transport = String(conn.transport || (conn.command ? 'stdio' : 'http')).toLowerCase();
  if (transport !== 'stdio') return 'remote_auto';

  const haystack = [
    conn.id || '',
    conn.name || '',
    conn.description || '',
    conn.command || '',
    ...(Array.isArray(conn.args) ? conn.args : []),
  ].join(' ');

  if (SENSITIVE_LOCAL_TOOL_RE.test(haystack)) {
    return 'local_only';
  }
  const tools = Array.isArray(conn.tools) ? conn.tools : [];
  if (tools.some((t) => t?.annotations?.destructiveHint === true)) {
    return 'local_only';
  }
  return 'remote_auto';
}

function isMachineBoundPath(token) {
  if (typeof token !== 'string') return false;
  const trimmed = token.trim();
  if (!trimmed || trimmed.startsWith('-')) return false;
  if (trimmed.includes('{{vault:')) return false;
  if (LOCAL_PATH_ARG_RE.test(trimmed)) return true;
  if (trimmed.startsWith('/') && trimmed.length > 1) return true;
  return false;
}

function parseNpmSpecifier(spec) {
  const s = String(spec || '').trim();
  if (!s || s.startsWith('-') || isMachineBoundPath(s)) return null;
  // Scoped: @scope/pkg@1.2.3 or @scope/pkg
  if (s.startsWith('@')) {
    const slash = s.indexOf('/');
    if (slash <= 1 || slash >= s.length - 1) return null;
    const at = s.indexOf('@', slash + 1);
    if (at === -1) {
      return { package: s, version: null, versionPinned: false };
    }
    const pkg = s.slice(0, at);
    const ver = s.slice(at + 1).trim();
    const pinned = Boolean(ver && ver !== 'latest' && ver !== 'next' && !/^[~^*]/.test(ver));
    return { package: pkg, version: ver || null, versionPinned: pinned };
  }
  if (!/^[a-z0-9._-]+(?:@[^\s]+)?$/i.test(s)) return null;
  const at = s.indexOf('@');
  if (at === -1) return { package: s, version: null, versionPinned: false };
  const pkg = s.slice(0, at);
  const ver = s.slice(at + 1).trim();
  const pinned = Boolean(ver && ver !== 'latest' && ver !== 'next' && !/^[~^*]/.test(ver));
  return { package: pkg, version: ver || null, versionPinned: pinned };
}

function parsePypiSpecifier(spec) {
  const s = String(spec || '').trim();
  if (!s || s.startsWith('-') || isMachineBoundPath(s)) return null;
  const eq = s.indexOf('==');
  if (eq > 0) {
    const pkg = s.slice(0, eq).trim();
    const ver = s.slice(eq + 2).trim();
    if (!/^[a-z0-9._-]+$/i.test(pkg)) return null;
    return { package: pkg, version: ver || null, versionPinned: Boolean(ver) };
  }
  const at = s.indexOf('@');
  if (at > 0) {
    const pkg = s.slice(0, at).trim();
    const ver = s.slice(at + 1).trim();
    if (!/^[a-z0-9._-]+$/i.test(pkg)) return null;
    return { package: pkg, version: ver || null, versionPinned: Boolean(ver && ver !== 'latest') };
  }
  if (!/^[a-z0-9._-]+$/i.test(s)) return null;
  return { package: s, version: null, versionPinned: false };
}

function parseDockerImage(spec) {
  const s = String(spec || '').trim();
  if (!s || s.startsWith('-')) return null;
  const digestIdx = s.indexOf('@sha256:');
  if (digestIdx > 0) {
    const sha = s.slice(digestIdx + '@sha256:'.length).trim();
    return {
      package: s.slice(0, digestIdx),
      version: `sha256:${sha}`,
      sha256: SHA256_RE.test(sha) ? sha.toLowerCase() : null,
      versionPinned: SHA256_RE.test(sha),
    };
  }
  const lastColon = s.lastIndexOf(':');
  const lastSlash = s.lastIndexOf('/');
  if (lastColon > lastSlash) {
    const tag = s.slice(lastColon + 1).trim();
    return {
      package: s.slice(0, lastColon),
      version: tag || null,
      sha256: null,
      versionPinned: Boolean(tag && tag !== 'latest'),
    };
  }
  return { package: s, version: null, sha256: null, versionPinned: false };
}

function detectOsPermissionRequirements(text) {
  const out = [];
  for (const hint of MACOS_PERMISSION_HINTS) {
    if (hint.re.test(text)) {
      out.push({
        kind: 'os_permission',
        key: hint.permission,
        label: hint.label,
        required: true,
      });
    }
  }
  return out;
}

// Strips raw secrets from env & args so saved install recipes NEVER carry plaintext credentials.
// Keeps `{{vault:KEY}}` placeholders and splits shared settings vs machine-local path overrides.
export function sanitizeRecipeEnvAndArgs({ env = {}, args = [], cwd = null } = {}) {
  const rawSecretsFound = [];
  const vaultKeys = new Set();
  const sharedEnv = {};
  const localEnvKeys = [];
  const localRequirements = [];

  if (isPlainObject(env)) {
    for (const [rawKey, rawVal] of Object.entries(env)) {
      const key = String(rawKey).trim();
      if (!key || FORBIDDEN_KEYS.has(key.toLowerCase()) || typeof rawVal !== 'string') continue;
      if (hasInternalSecretRefs(rawVal)) {
        rawSecretsFound.push(key);
        continue;
      }
      const refs = findSecretRefs(rawVal).filter((k) => !isInternalVaultKey(k));
      if (refs.length > 0) {
        refs.forEach((k) => vaultKeys.add(k));
        sharedEnv[key] = rawVal;
        continue;
      }
      if (isSecretEnv(key, rawVal)) {
        rawSecretsFound.push(key);
        // Keep a safe Vault placeholder reference hint instead of the raw secret.
        continue;
      }
      if (isMachineBoundPath(rawVal)) {
        localEnvKeys.push(key);
        localRequirements.push({
          kind: 'local_path',
          key,
          label: `Set local path for ${key} on this computer`,
          required: true,
        });
        continue;
      }
      sharedEnv[key] = rawVal;
    }
  }

  const safeArgs = [];
  const rawArgList = Array.isArray(args) ? args.map(String) : [];
  const secretArgHits = new Map(secretArgs(rawArgList).map((h) => [h.index, h]));

  for (let i = 0; i < rawArgList.length; i += 1) {
    const item = rawArgList[i];
    if (hasInternalSecretRefs(item)) {
      rawSecretsFound.push(`arg:${i}`);
      continue;
    }
    const refs = findSecretRefs(item).filter((k) => !isInternalVaultKey(k));
    if (refs.length > 0) {
      refs.forEach((k) => vaultKeys.add(k));
      safeArgs.push(item);
      continue;
    }
    if (secretArgHits.has(i) || looksLikeSecretValue(item)) {
      rawSecretsFound.push(`arg:${i}`);
      continue;
    }
    safeArgs.push(item);
  }

  if (typeof cwd === 'string' && cwd.trim()) {
    localRequirements.push({
      kind: 'folder_path',
      key: 'cwd',
      label: 'Choose a local working folder on this computer',
      required: false,
    });
  }

  return {
    sharedEnv,
    safeArgs,
    vaultKeys: [...vaultKeys],
    localEnvKeys,
    localRequirements,
    rawSecretsStripped: rawSecretsFound,
  };
}

// Strict validator for an explicit installSpec supplied by the owner (e.g. "Make portable" or API).
export function normalizeInstallSpec(raw, { rejectRawSecrets = true } = {}) {
  if (!isPlainObject(raw)) {
    throw new ToolSetupError('installSpec must be an object.', 400, 'INVALID_INSTALL_SPEC');
  }
  const source = String(raw.source || '').trim().toLowerCase();
  if (!INSTALL_SOURCE_SET.has(source)) {
    throw new ToolSetupError(
      `installSpec.source must be one of: ${INSTALL_SOURCES.join(', ')}.`,
      400,
      'INVALID_INSTALL_SPEC',
    );
  }

  const pkg = cleanText(raw.package || raw.repo || raw.image || '', 240, '');
  const version = cleanText(raw.version || '', 120, '') || null;
  const sha256Raw = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : '';
  const commitShaRaw = typeof raw.commitSha === 'string' ? raw.commitSha.trim().toLowerCase() : '';

  if (sha256Raw && !SHA256_RE.test(sha256Raw)) {
    throw new ToolSetupError('installSpec.sha256 must be a 64-character hex SHA-256 digest.', 400, 'INVALID_SHA256');
  }
  if (commitShaRaw && !COMMIT_SHA_RE.test(commitShaRaw)) {
    throw new ToolSetupError('installSpec.commitSha must be a full 40-character git commit SHA.', 400, 'INVALID_COMMIT_SHA');
  }
  if ((source === 'npm' || source === 'pypi' || source === 'docker') && !pkg) {
    throw new ToolSetupError(`installSpec.package is required for "${source}" setups.`, 400, 'INVALID_INSTALL_SPEC');
  }
  if (source === 'git' && !pkg) {
    throw new ToolSetupError('installSpec.package (repository URL) is required for "git" setups.', 400, 'INVALID_INSTALL_SPEC');
  }

  const command = cleanText(raw.command || '', 240, '') || defaultCommandForSource(source);
  const rawArgs = Array.isArray(raw.args) ? raw.args.map(String) : defaultArgsForSource(source, pkg, version);
  const rawEnv = isPlainObject(raw.envTemplate || raw.env) ? (raw.envTemplate || raw.env) : {};

  const sanitized = sanitizeRecipeEnvAndArgs({ env: rawEnv, args: rawArgs });
  if (rejectRawSecrets && sanitized.rawSecretsStripped.length > 0) {
    throw new ToolSetupError(
      'Raw secrets cannot be saved inside a portable install recipe. Use {{vault:KEY}} placeholders instead.',
      400,
      'RAW_SECRET_IN_RECIPE',
    );
  }

  const sharedSettings = {};
  if (isPlainObject(raw.sharedSettings)) {
    for (const [k, v] of Object.entries(raw.sharedSettings)) {
      const key = String(k).trim();
      if (!key || FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        if (typeof v === 'string' && (isSecretEnv(key, v) || looksLikeSecretValue(v)) && !v.includes('{{vault:')) {
          if (rejectRawSecrets) {
            throw new ToolSetupError(
              `Shared setting "${key}" looks like a raw secret. Store it in Vault and reference {{vault:KEY}}.`,
              400,
              'RAW_SECRET_IN_RECIPE',
            );
          }
          continue;
        }
        sharedSettings[key] = v;
      }
    }
  }

  const localRequirements = [];
  const seenReq = new Set();
  for (const reqItem of [
    ...(Array.isArray(raw.localRequirements) ? raw.localRequirements : []),
    ...sanitized.localRequirements,
  ]) {
    if (!isPlainObject(reqItem)) continue;
    const kind = cleanText(reqItem.kind, 40, '');
    const key = cleanText(reqItem.key, 80, '');
    const label = cleanText(reqItem.label, 160, key);
    if (!kind || !key) continue;
    const dedup = `${kind}:${key}`;
    if (seenReq.has(dedup)) continue;
    seenReq.add(dedup);
    localRequirements.push({
      kind,
      key,
      label,
      required: reqItem.required !== false,
    });
  }

  const versionPinned = Boolean(
    sha256Raw ||
    commitShaRaw ||
    (version && version !== 'latest' && version !== 'main' && version !== 'master' && !/^[~^*]/.test(version)),
  );

  return {
    source,
    package: pkg || null,
    version,
    sha256: sha256Raw || null,
    commitSha: commitShaRaw || null,
    versionPinned,
    command,
    args: sanitized.safeArgs,
    envTemplate: sanitized.sharedEnv,
    requiredVaultKeys: sanitized.vaultKeys,
    sharedSettings,
    localRequirements,
  };
}

function defaultCommandForSource(source) {
  switch (source) {
    case 'npm': return 'npx';
    case 'pypi': return 'uvx';
    case 'docker': return 'docker';
    default: return 'node';
  }
}

function defaultArgsForSource(source, pkg, version) {
  if (!pkg) return [];
  if (source === 'npm') {
    return ['-y', version ? `${pkg}@${version}` : pkg];
  }
  if (source === 'pypi') {
    return [version ? `${pkg}==${version}` : pkg];
  }
  if (source === 'docker') {
    const img = version ? (version.startsWith('sha256:') ? `${pkg}@${version}` : `${pkg}:${version}`) : pkg;
    return ['run', '-i', '--rm', img];
  }
  return [];
}

// Save-time portability analyzer: distinguishes portable packages/recipes from machine-bound paths
// like `node ~/projects/my-tool/server.js` so Loop never shows a broken Install button on other computers.
export function analyzeStdioPortability({ name = '', command = '', args = [], env = {}, cwd = null, installSpec = null } = {}) {
  const cleanCmd = String(command || '').trim();
  const rawArgs = Array.isArray(args) ? args.map(String) : [];
  const sanitized = sanitizeRecipeEnvAndArgs({ env, args: rawArgs, cwd });
  // A name can suggest a permission, but only the tool or an explicit recipe can require it.
  const permReqs = detectOsPermissionRequirements([name, cleanCmd, ...rawArgs].join(' ')).map(req => ({ ...req, required: false }));

  if (installSpec && isPlainObject(installSpec)) {
    const normalized = normalizeInstallSpec(installSpec, { rejectRawSecrets: false });
    const reqs = mergeLocalRequirements(normalized.localRequirements, permReqs);
    return {
      portable: true,
      versionPinned: normalized.versionPinned,
      reason: null,
      machineBoundPath: null,
      installSpec: { ...normalized, localRequirements: reqs },
      rawSecretsStripped: sanitized.rawSecretsStripped,
    };
  }

  if (!cleanCmd) {
    return {
      portable: false,
      versionPinned: false,
      reason: 'Missing command for local tool.',
      machineBoundPath: null,
      installSpec: null,
      rawSecretsStripped: sanitized.rawSecretsStripped,
    };
  }

  const baseCmd = path.basename(cleanCmd).toLowerCase();

  // Case 1: Command itself is a machine-bound local path (e.g. ~/bin/my-mcp, /Users/alice/tool)
  // unless it is a standard system binary path like /usr/local/bin/npx or process.execPath running a package.
  if (isMachineBoundPath(cleanCmd) && !RUNNER_COMMANDS.has(baseCmd) && !NPX_COMMANDS.has(baseCmd) && !UVX_COMMANDS.has(baseCmd) && baseCmd !== 'docker') {
    return {
      portable: false,
      versionPinned: false,
      reason: `Runs a local file path ("${cleanCmd}") that exists only on this computer. Add a package or repository to install it on other computers.`,
      machineBoundPath: cleanCmd,
      installSpec: null,
      rawSecretsStripped: sanitized.rawSecretsStripped,
    };
  }

  // Case 2: npx / bunx / pnpm dlx / yarn dlx -> portable npm package!
  const isPnpmDlx = (baseCmd === 'pnpm' || baseCmd === 'yarn') && rawArgs[0] === 'dlx';
  if (NPX_COMMANDS.has(baseCmd) || isPnpmDlx) {
    const startIdx = isPnpmDlx ? 1 : 0;
    let pkgIdx = -1;
    for (let i = startIdx; i < rawArgs.length; i += 1) {
      const a = rawArgs[i];
      if (a === '-y' || a === '--yes' || a === '-q' || a === '--quiet') continue;
      if (a === '-p' || a === '--package') {
        pkgIdx = i + 1;
        break;
      }
      if (a.startsWith('-')) continue;
      pkgIdx = i;
      break;
    }
    const parsed = pkgIdx >= 0 && pkgIdx < rawArgs.length ? parseNpmSpecifier(rawArgs[pkgIdx]) : null;
    if (parsed) {
      // Detect any trailing folder path args (e.g. `npx -y @mcp/server-filesystem /Users/alice/Docs`)
      // and convert them to machine-local requirements instead of copying Mac's path!
      const portableArgs = [];
      const pathReqs = [];
      for (let i = 0; i < sanitized.safeArgs.length; i += 1) {
        const a = sanitized.safeArgs[i];
        if (i > pkgIdx && isMachineBoundPath(a)) {
          const reqKey = `path_arg_${pathReqs.length + 1}`;
          pathReqs.push({
            kind: 'folder_path',
            key: reqKey,
            label: `Choose local folder on this computer (replaces "${a}")`,
            required: true,
          });
          portableArgs.push(`{{local:${reqKey}}}`);
        } else {
          portableArgs.push(a);
        }
      }
      return {
        portable: true,
        versionPinned: parsed.versionPinned,
        reason: null,
        machineBoundPath: null,
        installSpec: {
          source: 'npm',
          package: parsed.package,
          version: parsed.version,
          sha256: null,
          commitSha: null,
          versionPinned: parsed.versionPinned,
          command: baseCmd,
          args: portableArgs,
          envTemplate: sanitized.sharedEnv,
          requiredVaultKeys: sanitized.vaultKeys,
          sharedSettings: {},
          localRequirements: mergeLocalRequirements([...sanitized.localRequirements, ...pathReqs], permReqs),
        },
        rawSecretsStripped: sanitized.rawSecretsStripped,
      };
    }
  }

  // Case 3: uvx / pipx -> portable PyPI package!
  if (UVX_COMMANDS.has(baseCmd)) {
    const startIdx = baseCmd === 'pipx' && rawArgs[0] === 'run' ? 1 : 0;
    let pkgIdx = -1;
    for (let i = startIdx; i < rawArgs.length; i += 1) {
      if (rawArgs[i].startsWith('-')) continue;
      pkgIdx = i;
      break;
    }
    const parsed = pkgIdx >= 0 ? parsePypiSpecifier(rawArgs[pkgIdx]) : null;
    if (parsed) {
      const portableArgs = [];
      const pathReqs = [];
      for (let i = 0; i < sanitized.safeArgs.length; i += 1) {
        const a = sanitized.safeArgs[i];
        if (i > pkgIdx && isMachineBoundPath(a)) {
          const reqKey = `path_arg_${pathReqs.length + 1}`;
          pathReqs.push({
            kind: 'folder_path',
            key: reqKey,
            label: `Choose local folder on this computer (replaces "${a}")`,
            required: true,
          });
          portableArgs.push(`{{local:${reqKey}}}`);
        } else {
          portableArgs.push(a);
        }
      }
      return {
        portable: true,
        versionPinned: parsed.versionPinned,
        reason: null,
        machineBoundPath: null,
        installSpec: {
          source: 'pypi',
          package: parsed.package,
          version: parsed.version,
          sha256: null,
          commitSha: null,
          versionPinned: parsed.versionPinned,
          command: baseCmd,
          args: portableArgs,
          envTemplate: sanitized.sharedEnv,
          requiredVaultKeys: sanitized.vaultKeys,
          sharedSettings: {},
          localRequirements: mergeLocalRequirements([...sanitized.localRequirements, ...pathReqs], permReqs),
        },
        rawSecretsStripped: sanitized.rawSecretsStripped,
      };
    }
  }

  // Case 4: docker run <image> -> portable container image!
  if (baseCmd === 'docker' && rawArgs[0] === 'run') {
    let imgIdx = -1;
    for (let i = 1; i < rawArgs.length; i += 1) {
      const a = rawArgs[i];
      if (a === '-e' || a === '-v' || a === '-p' || a === '--name' || a === '--env' || a === '--volume') {
        i += 1;
        continue;
      }
      if (a.startsWith('-')) continue;
      imgIdx = i;
      break;
    }
    const parsed = imgIdx >= 0 ? parseDockerImage(rawArgs[imgIdx]) : null;
    if (parsed) {
      return {
        portable: true,
        versionPinned: parsed.versionPinned,
        reason: null,
        machineBoundPath: null,
        installSpec: {
          source: 'docker',
          package: parsed.package,
          version: parsed.version,
          sha256: parsed.sha256,
          commitSha: null,
          versionPinned: parsed.versionPinned,
          command: 'docker',
          args: sanitized.safeArgs,
          envTemplate: sanitized.sharedEnv,
          requiredVaultKeys: sanitized.vaultKeys,
          sharedSettings: {},
          localRequirements: mergeLocalRequirements(sanitized.localRequirements, permReqs),
        },
        rawSecretsStripped: sanitized.rawSecretsStripped,
      };
    }
  }

  // Case 5: node/python/etc. running a local script path (e.g. `node ~/projects/my-tool/server.js`) -> NOT portable!
  if (RUNNER_COMMANDS.has(baseCmd)) {
    const firstNonFlag = rawArgs.find((a) => !a.startsWith('-'));
    if (firstNonFlag && (isMachineBoundPath(firstNonFlag) || SCRIPT_EXT_RE.test(firstNonFlag))) {
      return {
        portable: false,
        versionPinned: false,
        reason: `Runs a local script ("${baseCmd} ${firstNonFlag}") that exists only on this computer. Identify a package or repository to make it installable on other computers.`,
        machineBoundPath: firstNonFlag,
        installSpec: null,
        rawSecretsStripped: sanitized.rawSecretsStripped,
      };
    }
  }

  // Case 6: Any other bare command containing machine-bound script/binary paths -> NOT portable.
  const boundArg = rawArgs.find((a) => isMachineBoundPath(a) && SCRIPT_EXT_RE.test(a));
  if (boundArg) {
    return {
      portable: false,
      versionPinned: false,
      reason: `References a local file ("${boundArg}") that exists only on this computer. Identify a package or repository to install it on other computers.`,
      machineBoundPath: boundArg,
      installSpec: null,
      rawSecretsStripped: sanitized.rawSecretsStripped,
    };
  }

  return {
    portable: false,
    versionPinned: false,
    reason: `Command "${cleanCmd}" does not specify a portable package or repository. Add an install recipe to make it one-click installable on other computers.`,
    machineBoundPath: cleanCmd,
    installSpec: null,
    rawSecretsStripped: sanitized.rawSecretsStripped,
  };
}

function mergeLocalRequirements(a = [], b = []) {
  const seen = new Set();
  const out = [];
  for (const item of [...a, ...b]) {
    if (!item || !item.kind || !item.key) continue;
    const k = `${item.kind}:${item.key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

// Verifies SHA-256 artifact integrity (or strict 40-char git commit SHA) before executing a local tool.
export async function verifyArtifactIntegrity(installSpec, { targetPath = null, resolveArtifactBytes = null } = {}) {
  if (!installSpec || typeof installSpec !== 'object') {
    return { verified: false, algorithm: null, digest: null };
  }
  if (installSpec.source === 'git' && installSpec.commitSha) {
    if (!COMMIT_SHA_RE.test(installSpec.commitSha)) {
      throw new ToolSetupError('Git install recipe must pin a full 40-character commit SHA.', 400, 'INVALID_COMMIT_SHA');
    }
  }
  if (!installSpec.sha256) {
    return {
      verified: Boolean(installSpec.source === 'git' && installSpec.commitSha),
      algorithm: installSpec.commitSha ? 'commit_sha' : null,
      digest: installSpec.commitSha || null,
    };
  }

  const expectedHex = String(installSpec.sha256).trim().toLowerCase();
  if (!SHA256_RE.test(expectedHex)) {
    throw new ToolSetupError('Invalid SHA-256 digest in install recipe.', 400, 'INVALID_SHA256');
  }

  let bytes = null;
  if (typeof resolveArtifactBytes === 'function') {
    bytes = await resolveArtifactBytes(installSpec);
  } else {
    const candidatePath =
      targetPath ||
      (Array.isArray(installSpec.args) ? installSpec.args.find((a) => typeof a === 'string' && existsSync(a)) : null) ||
      (typeof installSpec.command === 'string' && existsSync(installSpec.command) ? installSpec.command : null);
    if (candidatePath) {
      const st = await stat(candidatePath).catch(() => null);
      if (st?.isFile()) {
        bytes = await readFile(candidatePath);
      }
    }
  }

  if (bytes === null || bytes === undefined) {
    throw new ToolSetupError(
      'Could not locate local artifact to verify its SHA-256 integrity hash.',
      400,
      'INTEGRITY_ARTIFACT_MISSING',
    );
  }

  const actualHex = createHash('sha256')
    .update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8'))
    .digest('hex');

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const actualBuf = Buffer.from(actualHex, 'hex');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new ToolSetupError(
      `Integrity check failed: expected SHA-256 ${expectedHex.slice(0, 12)}…, got ${actualHex.slice(0, 12)}….`,
      409,
      'INTEGRITY_MISMATCH',
      { expectedSha256: expectedHex, actualSha256: actualHex },
    );
  }

  return { verified: true, algorithm: 'sha256', digest: actualHex };
}

// Validates optional private tunnel configuration (Tailscale / Cloudflare Tunnel) on a device.
export function validateDeviceNetworkConfig(input = {}, { allowLoopbackHttp = false } = {}) {
  if (!isPlainObject(input)) {
    throw new ToolSetupError('Network settings must be a JSON object.', 400, 'INVALID_NETWORK_CONFIG');
  }
  const mode = cleanText(input.transportMode ?? input.mode ?? 'loop_relay', 32, 'loop_relay').toLowerCase();
  if (!TUNNEL_MODE_SET.has(mode)) {
    throw new ToolSetupError(
      'transportMode must be "loop_relay", "tailscale", or "cloudflare_tunnel".',
      400,
      'INVALID_TUNNEL_MODE',
    );
  }

  const requirePrivateTunnel = Boolean(input.requirePrivateTunnel);
  const rawEndpoint = typeof input.tunnelEndpoint === 'string' ? input.tunnelEndpoint.trim() : '';

  if (mode === 'loop_relay') {
    if (requirePrivateTunnel) {
      throw new ToolSetupError(
        'Select "tailscale" or "cloudflare_tunnel" before requiring a private tunnel.',
        400,
        'TUNNEL_ENDPOINT_REQUIRED',
      );
    }
    return {
      transportMode: 'loop_relay',
      tunnelEndpoint: null,
      requirePrivateTunnel: false,
    };
  }

  if (!rawEndpoint) {
    throw new ToolSetupError(
      `Enter a valid https:// endpoint URL for ${mode === 'tailscale' ? 'Tailscale' : 'Cloudflare Tunnel'}.`,
      400,
      'TUNNEL_ENDPOINT_REQUIRED',
    );
  }

  let parsed;
  try {
    parsed = new URL(rawEndpoint);
  } catch {
    throw new ToolSetupError('Tunnel endpoint must be a valid URL.', 400, 'INVALID_TUNNEL_URL');
  }
  if (parsed.username || parsed.password) {
    throw new ToolSetupError('Tunnel endpoint must not contain credentials.', 400, 'INVALID_TUNNEL_URL');
  }
  const loopbackOk = allowLoopbackHttp && parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname);
  if (parsed.protocol !== 'https:' && !loopbackOk) {
    throw new ToolSetupError('Tunnel endpoint must use https://.', 400, 'INSECURE_TUNNEL_URL');
  }
  if (mode === 'tailscale' && !loopbackOk) {
    const host = parsed.hostname.toLowerCase();
    const isTsDomain = host.endsWith('.ts.net');
    const isTailscaleIp = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host);
    if (!isTsDomain && !isTailscaleIp) {
      throw new ToolSetupError(
        'Tailscale tunnel endpoint must use a Tailscale MagicDNS (*.ts.net) host or 100.64.0.0/10 address.',
        400,
        'INVALID_TAILSCALE_HOST',
      );
    }
  }

  return {
    transportMode: mode,
    tunnelEndpoint: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`,
    requirePrivateTunnel,
  };
}

// ---------------- Account-Level ToolSetupStore (Loop Cloud source of truth) ----------------

function normalizeDeviceInstallEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const status = INSTALL_STATUS_SET.has(raw.status) ? raw.status : 'not_installed';
  return {
    status,
    step: cleanText(raw.step, 60, status),
    version: raw.version ? cleanText(raw.version, 120, '') : null,
    sha256Verified: Boolean(raw.sha256Verified),
    toolCount: Number.isInteger(raw.toolCount) && raw.toolCount >= 0 ? raw.toolCount : 0,
    missingStep: raw.missingStep ? cleanText(raw.missingStep, 300, '') : null,
    lastError: raw.lastError ? cleanText(raw.lastError, 300, '') : null,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : new Date().toISOString(),
  };
}

function normalizeToolSetupRecord(raw) {
  if (!isPlainObject(raw)) return null;
  const id = slugifySetupId(raw.id || raw.name);
  if (!SETUP_ID_RE.test(id)) return null;
  const home = TOOL_HOME_SET.has(raw.home) ? raw.home : 'local';
  const now = new Date().toISOString();
  const installations = {};
  if (isPlainObject(raw.installations)) {
    for (const [devId, entry] of Object.entries(raw.installations)) {
      if (!devId || FORBIDDEN_KEYS.has(devId.toLowerCase())) continue;
      const norm = normalizeDeviceInstallEntry(entry);
      if (norm) installations[devId] = norm;
    }
  }
  let installSpec = null;
  if (isPlainObject(raw.installSpec)) {
    try {
      installSpec = normalizeInstallSpec(raw.installSpec, { rejectRawSecrets: false });
    } catch {
      installSpec = null;
    }
  }
  const portable = home === 'cloud' ? true : Boolean(raw.portable && installSpec);
  const remoteAccess =
    normalizeRemoteAccess(raw.remoteAccess, null) ||
    (home === 'cloud' ? 'remote_auto' : defaultRemoteAccessFor({
      id,
      name: raw.name,
      description: raw.description,
      transport: 'stdio',
      command: installSpec?.command || '',
      args: installSpec?.args || [],
    }));

  const cloudSpec =
    home === 'cloud' && isPlainObject(raw.cloudSpec) && typeof raw.cloudSpec.url === 'string'
      ? {
          transport: raw.cloudSpec.transport === 'sse' ? 'sse' : 'http',
          url: raw.cloudSpec.url.trim(),
          cloudConnId: cleanText(raw.cloudSpec.cloudConnId || id, 64, id),
        }
      : null;

  return {
    id,
    name: cleanText(raw.name, 80, id),
    description: cleanText(raw.description, 500, ''),
    profiles: normalizeItemProfiles(raw.profiles),
    home,
    enabled: raw.enabled !== false,
    remoteAccess,
    portable,
    nonPortableReason: portable ? null : cleanText(raw.nonPortableReason, 300, null) || null,
    originDeviceId: raw.originDeviceId ? cleanText(raw.originDeviceId, 64, '') : null,
    originDeviceName: raw.originDeviceName ? cleanText(raw.originDeviceName, 80, '') : null,
    installSpec,
    cloudSpec,
    sharedSettings: isPlainObject(raw.sharedSettings) ? { ...raw.sharedSettings } : {},
    installations,
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : now,
  };
}

export class ToolSetupStore {
  constructor(dir = defaultDataDir()) {
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, 'tool-setups.json');
    this._lock = createWriteQueue();
  }

  async _readDoc() {
    const { data, missing } = await readJsonWithBackup(this.file, {
      validate: (candidate) => isPlainObject(candidate) && Array.isArray(candidate.setups),
      fallbackToBackup: true,
    });
    if (missing || !data) return { version: 1, setups: [] };
    const setups = [];
    const seen = new Set();
    for (const item of data.setups) {
      const rec = normalizeToolSetupRecord(item);
      if (rec && !seen.has(rec.id)) {
        seen.add(rec.id);
        setups.push(rec);
      }
    }
    return { version: 1, setups, deleted: Array.isArray(data.deleted) ? data.deleted : [] };
  }

  async _writeDoc(doc) {
    await atomicWriteFile(this.file, JSON.stringify({ version: 1, setups: doc.setups, deleted: doc.deleted || [] }, null, 2) + '\n', {
      mode: 0o600,
      backup: true,
    });
  }

  async list() {
    const doc = await this._readDoc();
    return structuredClone(doc.setups);
  }

  async get(id) {
    const clean = slugifySetupId(id);
    const doc = await this._readDoc();
    const found = doc.setups.find((s) => s.id === clean);
    return found ? structuredClone(found) : null;
  }

  async upsert(input, { discoverOnly = false } = {}) {
    if (!isPlainObject(input)) {
      throw new ToolSetupError('Tool setup payload must be an object.', 400, 'INVALID_TOOL_SETUP');
    }
    if (input.installSpec !== undefined && input.installSpec !== null) {
      // Strictly reject raw secrets when owner explicitly saves a recipe.
      normalizeInstallSpec(input.installSpec, { rejectRawSecrets: true });
    }
    if (input.remoteAccess !== undefined && input.remoteAccess !== null) {
      validateRemoteAccess(input.remoteAccess);
    }

    return this._lock(async () => {
      const doc = await this._readDoc();
      const id = slugifySetupId(input.id || input.name);
      const idx = doc.setups.findIndex((s) => s.id === id);
      const prev = idx >= 0 ? doc.setups[idx] : null;
      if (discoverOnly && (prev || doc.deleted?.includes(id))) return prev ? structuredClone(prev) : null;
      if (!discoverOnly && doc.deleted) doc.deleted = doc.deleted.filter(key => key !== id);
      const now = new Date().toISOString();

      const merged = normalizeToolSetupRecord({
        ...(prev || {}),
        ...input,
        id,
        installations: {
          ...(prev?.installations || {}),
          ...(isPlainObject(input.installations) ? input.installations : {}),
        },
        createdAt: prev?.createdAt || now,
        updatedAt: now,
      });

      if (idx >= 0) doc.setups[idx] = merged;
      else doc.setups.push(merged);
      await this._writeDoc(doc);
      return structuredClone(merged);
    });
  }

  async update(id, patch) {
    if (!isPlainObject(patch)) {
      throw new ToolSetupError('Tool setup patch must be an object.', 400, 'INVALID_TOOL_SETUP');
    }
    if (patch.installSpec !== undefined && patch.installSpec !== null) {
      normalizeInstallSpec(patch.installSpec, { rejectRawSecrets: true });
    }
    if (patch.remoteAccess !== undefined && patch.remoteAccess !== null) {
      validateRemoteAccess(patch.remoteAccess);
    }
    return this._lock(async () => {
      const doc = await this._readDoc();
      const clean = slugifySetupId(id);
      const idx = doc.setups.findIndex((s) => s.id === clean);
      if (idx === -1) return null;
      const prev = doc.setups[idx];
      const next = normalizeToolSetupRecord({
        ...prev,
        ...patch,
        id: prev.id,
        installations: prev.installations,
        createdAt: prev.createdAt,
        updatedAt: new Date().toISOString(),
      });
      doc.setups[idx] = next;
      await this._writeDoc(doc);
      return structuredClone(next);
    });
  }

  async recordDeviceInstall(id, deviceId, report) {
    const cleanId = slugifySetupId(id);
    const cleanDev = cleanText(deviceId, 64, '');
    if (!cleanDev) return null;
    return this._lock(async () => {
      const doc = await this._readDoc();
      const idx = doc.setups.findIndex((s) => s.id === cleanId);
      if (idx === -1) return null;
      const prev = doc.setups[idx];
      const norm = normalizeDeviceInstallEntry({ ...report, updatedAt: new Date().toISOString() });
      const next = {
        ...prev,
        installations: {
          ...(prev.installations || {}),
          [cleanDev]: norm,
        },
        updatedAt: new Date().toISOString(),
      };
      doc.setups[idx] = next;
      await this._writeDoc(doc);
      return structuredClone(next);
    });
  }

  async markDeviceUninstalled(id, deviceId) {
    return this.recordDeviceInstall(id, deviceId, {
      status: 'uninstalled',
      step: 'uninstalled',
      toolCount: 0,
      missingStep: null,
      lastError: null,
    });
  }

  async remove(id) {
    const clean = slugifySetupId(id);
    return this._lock(async () => {
      const doc = await this._readDoc();
      const next = doc.setups.filter((s) => s.id !== clean);
      if (next.length === doc.setups.length) return false;
      doc.setups = next;
      doc.deleted = [...new Set([...(doc.deleted || []), clean])];
      await this._writeDoc(doc);
      return true;
    });
  }
}

// ---------------- Machine-Local Installation & Cloud Route Store ----------------

function resolveTemplateString(str, localConfig = {}) {
  if (typeof str !== 'string') return str;
  const paths = isPlainObject(localConfig.paths) ? localConfig.paths : {};
  const envOverrides = isPlainObject(localConfig.envOverrides) ? localConfig.envOverrides : {};
  return str.replace(/\{\{local:([A-Za-z0-9_.-]{1,80})\}\}/g, (_m, key) => {
    if (typeof paths[key] === 'string' && paths[key].trim()) return paths[key].trim();
    if (typeof envOverrides[key] === 'string' && envOverrides[key].trim()) return envOverrides[key].trim();
    return '';
  });
}

export class LocalInstallStore {
  constructor(dir = defaultDataDir()) {
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, 'local-installs.json');
    this._lock = createWriteQueue();
    this._inFlightJobs = new Map(); // jobDedupeKey -> Promise
  }

  async _readDoc() {
    const { data, missing } = await readJsonWithBackup(this.file, {
      validate: (c) => isPlainObject(c) && isPlainObject(c.installs) && isPlainObject(c.cloudRoutes),
      fallbackToBackup: true,
    });
    if (missing || !data) return { version: 1, installs: {}, cloudRoutes: {}, cachedSetups: [] };
    return {
      version: 1,
      installs: isPlainObject(data.installs) ? data.installs : {},
      cloudRoutes: isPlainObject(data.cloudRoutes) ? data.cloudRoutes : {},
      cachedSetups: Array.isArray(data.cachedSetups) ? data.cachedSetups : [],
    };
  }

  async _writeDoc(doc) {
    await atomicWriteFile(this.file, JSON.stringify({
      version: 1,
      installs: doc.installs || {},
      cloudRoutes: doc.cloudRoutes || {},
      cachedSetups: doc.cachedSetups || [],
    }, null, 2) + '\n', {
      mode: 0o600,
      backup: true,
    });
  }

  async listInstalls() {
    const doc = await this._readDoc();
    return structuredClone(doc.installs);
  }

  async getInstall(setupId) {
    const clean = slugifySetupId(setupId);
    const doc = await this._readDoc();
    return doc.installs[clean] ? structuredClone(doc.installs[clean]) : null;
  }

  async saveCachedSetups(setups) {
    const list = (Array.isArray(setups) ? setups : [])
      .map(normalizeToolSetupRecord)
      .filter(Boolean);
    return this._lock(async () => {
      const doc = await this._readDoc();
      doc.cachedSetups = list;
      await this._writeDoc(doc);
      return structuredClone(list);
    });
  }

  async listCachedSetups() {
    const doc = await this._readDoc();
    return structuredClone(doc.cachedSetups || []);
  }

  async setCloudRoute(route) {
    const id = slugifySetupId(route.id || route.cloudConnId || route.name);
    return this._lock(async () => {
      const doc = await this._readDoc();
      doc.cloudRoutes[id] = {
        id,
        cloudConnId: cleanText(route.cloudConnId || id, 64, id),
        name: cleanText(route.name, 80, id),
        description: cleanText(route.description, 500, ''),
        url: typeof route.url === 'string' ? route.url : null,
        transport: route.transport === 'sse' ? 'sse' : 'http',
        profiles: normalizeItemProfiles(route.profiles),
        enabled: route.enabled !== false,
        disabledTools: Array.isArray(route.disabledTools) ? route.disabledTools : [],
        tools: Array.isArray(route.tools) ? route.tools : [],
        home: 'cloud',
        movedAt: route.movedAt || new Date().toISOString(),
      };
      await this._writeDoc(doc);
      return structuredClone(doc.cloudRoutes[id]);
    });
  }

  async getCloudRoute(id) {
    const clean = slugifySetupId(id);
    const doc = await this._readDoc();
    return doc.cloudRoutes[clean] ? structuredClone(doc.cloudRoutes[clean]) : null;
  }

  async listCloudRoutes() {
    const doc = await this._readDoc();
    return Object.values(doc.cloudRoutes || {}).map((r) => structuredClone(r));
  }

  async removeCloudRoute(id) {
    const clean = slugifySetupId(id);
    return this._lock(async () => {
      const doc = await this._readDoc();
      if (!Object.hasOwn(doc.cloudRoutes, clean)) return false;
      delete doc.cloudRoutes[clean];
      await this._writeDoc(doc);
      return true;
    });
  }

  async _saveInstall(setupId, record) {
    const clean = slugifySetupId(setupId);
    return this._lock(async () => {
      const doc = await this._readDoc();
      doc.installs[clean] = { ...record, setupId: clean, updatedAt: new Date().toISOString() };
      await this._writeDoc(doc);
      return structuredClone(doc.installs[clean]);
    });
  }

  // Idempotent, retry-safe local installer:
  // - Double-clicking, reloading, or retrying resumes the exact same job.
  // - Checks genuine local requirements (OS permission, local folder path).
  // - Verifies SHA-256 integrity hash before running.
  // - Starts the tool and lists its capabilities (`pool.sync`) BEFORE marking `ready`.
  async runInstallJob({
    setup,
    store,
    pool,
    localConfig = {},
    idempotencyKey = '',
    resolveArtifactBytes = null,
    checkOsPermission = null,
    onProgress = null,
  }) {
    if (!setup || !setup.id) {
      throw new ToolSetupError('A valid saved tool setup is required.', 400, 'INVALID_TOOL_SETUP');
    }
    if (!setup.portable || !setup.installSpec) {
      throw new ToolSetupError(
        setup.nonPortableReason || `"${setup.name || setup.id}" is not portable and cannot be installed on this computer.`,
        400,
        'NOT_PORTABLE',
      );
    }

    const setupId = slugifySetupId(setup.id);
    const dedupeKey = setupId;

    if (this._inFlightJobs.has(dedupeKey)) {
      return this._inFlightJobs.get(dedupeKey);
    }

    const jobPromise = (async () => {
      const existing = await this.getInstall(setupId);
      const mergedLocalConfig = {
        cwd: localConfig.cwd ?? existing?.localConfig?.cwd ?? null,
        paths: {
          ...(isPlainObject(existing?.localConfig?.paths) ? existing.localConfig.paths : {}),
          ...(isPlainObject(localConfig.paths) ? localConfig.paths : {}),
        },
        envOverrides: {
          ...(isPlainObject(existing?.localConfig?.envOverrides) ? existing.localConfig.envOverrides : {}),
          ...(isPlainObject(localConfig.envOverrides) ? localConfig.envOverrides : {}),
        },
        osPermissions: {
          ...(isPlainObject(existing?.localConfig?.osPermissions) ? existing.localConfig.osPermissions : {}),
          ...(isPlainObject(localConfig.osPermissions) ? localConfig.osPermissions : {}),
        },
      };

      const specHash = createHash('sha256')
        .update(JSON.stringify({
          installSpec: setup.installSpec,
          envTemplate: setup.envTemplate || null,
          sharedSettings: setup.sharedSettings || null,
          localConfig: mergedLocalConfig,
        }))
        .digest('hex');

      // If already ready with the exact same spec + version and the local connection still exists,
      // return the verified installation without duplicating anything.
      if (
        existing?.status === 'ready' &&
        existing.version === setup.installSpec.version &&
        (!existing.specHash || existing.specHash === specHash) &&
        existing.connId &&
        (await store.get(existing.connId))
      ) {
        return existing;
      }

      const jobId = existing?.jobId || `job_${randomBytes(6).toString('hex')}`;
      const recordStep = async (patch) => {
        const rec = await this._saveInstall(setupId, {
          ...(existing || {}),
          setupId,
          jobId,
          idempotencyKey: idempotencyKey || existing?.idempotencyKey || dedupeKey,
          version: setup.installSpec.version || null,
          specHash,
          sha256: setup.installSpec.sha256 || null,
          sha256Verified: Boolean(existing?.sha256Verified),
          localConfig: mergedLocalConfig,
          ...patch,
        });
        await onProgress?.(rec);
        return rec;
      };

      await recordStep({ status: 'installing', step: 'checking_requirements', missingStep: null, lastError: null });

      // 1. Check genuine local requirements (local folder paths / OS permissions)
      const reqs = Array.isArray(setup.installSpec.localRequirements) ? setup.installSpec.localRequirements : [];
      for (const reqItem of reqs) {
        if (reqItem.required === false) continue;
        if (reqItem.kind === 'folder_path' || reqItem.kind === 'local_path') {
          const val = mergedLocalConfig.paths?.[reqItem.key] || mergedLocalConfig.envOverrides?.[reqItem.key] || '';
          if (!String(val).trim()) {
            return await recordStep({
              status: 'needs_attention',
              step: 'needs_local_requirement',
              missingStep: reqItem.label || `Provide local path "${reqItem.key}" on this computer.`,
              lastError: null,
            });
          }
        }
        if (reqItem.kind === 'os_permission') {
          let granted = Boolean(mergedLocalConfig.osPermissions?.[reqItem.key]);
          if (!granted && typeof checkOsPermission === 'function') {
            granted = Boolean(await checkOsPermission(reqItem.key, setup));
            if (granted) mergedLocalConfig.osPermissions[reqItem.key] = true;
          }
          if (!granted) {
            return await recordStep({
              status: 'needs_attention',
              step: 'needs_os_permission',
              missingStep: reqItem.label || `Grant "${reqItem.key}" permission on this computer.`,
              lastError: null,
            });
          }
        }
      }

      // 2. Verify SHA-256 / commit SHA integrity BEFORE running any local tool!
      await recordStep({ status: 'installing', step: 'verifying_integrity', missingStep: null });
      let integrity;
      try {
        integrity = await verifyArtifactIntegrity(setup.installSpec, { resolveArtifactBytes });
      } catch (err) {
        return await recordStep({
          status: 'failed',
          step: 'integrity_failed',
          sha256Verified: false,
          missingStep: err?.publicMessage || err?.message || 'Artifact integrity check failed.',
          lastError: err?.publicMessage || err?.message || 'Artifact integrity check failed.',
        });
      }

      // 3. Materialize local stdio connection using shared settings + local overrides (never raw secrets)
      await recordStep({
        status: 'installing',
        step: 'configuring_local_tool',
        sha256Verified: integrity.verified,
      });

      const resolvedArgs = (setup.installSpec.args || [])
        .map((a) => resolveTemplateString(a, mergedLocalConfig))
        .filter((a) => a !== '');

      const resolvedEnv = {
        ...(isPlainObject(setup.installSpec.envTemplate) ? setup.installSpec.envTemplate : {}),
        ...(isPlainObject(setup.sharedSettings)
          ? Object.fromEntries(Object.entries(setup.sharedSettings).map(([k, v]) => [k, String(v)]))
          : {}),
        ...mergedLocalConfig.envOverrides,
      };

      const existingConn =
        (existing?.connId ? await store.get(existing.connId) : null) ||
        (await store.list()).find((c) => c.toolSetupId === setupId || (c.id === setupId && c.transport === 'stdio')) ||
        null;

      const connPayload = {
        name: setup.name || setupId,
        description: setup.description || '',
        transport: 'stdio',
        command: setup.installSpec.command,
        args: resolvedArgs,
        env: resolvedEnv,
        ...(mergedLocalConfig.cwd ? { cwd: mergedLocalConfig.cwd } : {}),
        profiles: normalizeItemProfiles(setup.profiles),
        enabled: setup.enabled !== false,
        remoteAccess: setup.remoteAccess || defaultRemoteAccessFor({
          id: setupId,
          name: setup.name,
          transport: 'stdio',
          command: setup.installSpec.command,
          args: resolvedArgs,
        }),
        installSpec: setup.installSpec,
        toolSetupId: setupId,
      };

      let conn;
      if (existingConn) {
        conn = await store.update(existingConn.id, connPayload);
      } else {
        conn = await store.add({ id: setupId, ...connPayload });
      }

      // 4. Prove it works BEFORE showing Ready: start the tool and list its capabilities!
      await recordStep({
        status: 'installing',
        step: 'verifying_capabilities',
        connId: conn.id,
        sha256Verified: integrity.verified,
      });

      let synced;
      try {
        await pool.retire(conn.id).catch(() => {});
        synced = await pool.sync(conn.id);
      } catch (err) {
        return await recordStep({
          status: 'failed',
          step: 'capability_check_failed',
          connId: conn.id,
          sha256Verified: integrity.verified,
          missingStep: `Tool failed to start: ${err?.message || 'Unknown error'}. Fix the issue and click Retry.`,
          lastError: err?.message || 'Tool failed to start.',
        });
      }

      if (!synced || synced.lastError) {
        const errText = synced?.lastError || 'Tool did not respond to capability check.';
        return await recordStep({
          status: 'failed',
          step: 'capability_check_failed',
          connId: conn.id,
          sha256Verified: integrity.verified,
          missingStep: `Tool check failed: ${errText}`,
          lastError: errText,
        });
      }

      const tools = Array.isArray(synced.tools) ? synced.tools : [];
      return await recordStep({
        status: 'ready',
        step: 'ready',
        connId: conn.id,
        sha256Verified: integrity.verified,
        toolCount: tools.length,
        tools: tools.map((t) => t.name),
        missingStep: null,
        lastError: null,
      });
    })().finally(() => {
      this._inFlightJobs.delete(dedupeKey);
    });

    this._inFlightJobs.set(dedupeKey, jobPromise);
    return jobPromise;
  }

  // Distinct from "Disable in Loop" and "Delete from Loop":
  // Removes ONLY this computer's local installation; the saved ToolSetup stays in the account.
  async uninstallLocal({ setupId, store, pool }) {
    const clean = slugifySetupId(setupId);
    const existing = await this.getInstall(clean);
    const targetConnId = existing?.connId || clean;
    const conn = await store.get(targetConnId);
    let removedConn = false;
    if (conn && conn.transport === 'stdio') {
      await pool.invalidate(conn.id).catch(() => {});
      removedConn = await store.remove(conn.id);
    }
    const next = await this._saveInstall(clean, {
      ...(existing || {}),
      setupId: clean,
      connId: null,
      status: 'uninstalled',
      step: 'uninstalled',
      toolCount: 0,
      tools: [],
      missingStep: null,
      lastError: null,
    });
    return { uninstalled: true, removedConnection: removedConn, install: next };
  }
}
