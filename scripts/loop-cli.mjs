#!/usr/bin/env node
// Loop CLI: manage Local Loop and agent updates cleanly.
//
// Commands:
//   loop version               Show installed version and path
//   loop status                Show version, running health, and agent hooks/skills
//   loop check [--url ...]     Check for a newer release (explicit, never silent)
//   loop update [--url ...]    Download, verify SHA-256, smoke-test, swap, and restart
//   loop update --agents-only  Refresh hosted agent skill and hook without re-login
//   loop rollback              Switch back to the previous installed release
//   loop start | restart       Start or gracefully restart Local Loop
//   loop connect [args...]     Connect local AI agents (connect-agents.mjs)
//   loop hooks [args...]       Install, check, or remove agent hooks

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MIN_NODE_VERSION,
  currentLoopVersion,
  isNodeVersionSupported,
  parseReleaseFile,
  sha256File,
} from '../lib/release.mjs';
import { agentHookStatus, refreshAgentHooks } from '../lib/agent-hooks.mjs';
import { runConnectCli } from './connect-agents.mjs';

const DEFAULT_ORIGIN = process.env.LOOP_ORIGIN || 'https://useloop.sh';
const MAX_KEPT_RELEASES = 5;
const SAFE_TAG_RE = /[^a-zA-Z0-9._-]+/g;

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export function validateReleaseOrigin(raw) {
  const value = String(raw || '').trim();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid update URL "${raw}". Use https://useloop.sh.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Update URL must not contain embedded credentials.');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
    throw new Error('Update URL must use https:// (or http:// on loopback).');
  }
  return parsed.origin;
}

function validateDownloadUrl(raw, origin) {
  const value = String(raw || '').trim();
  let parsed;
  try {
    parsed = new URL(value, origin);
  } catch {
    throw new Error('Release manifest contains an invalid tarball URL.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Tarball URL must not contain embedded credentials.');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
    throw new Error('Tarball URL must use https://.');
  }
  if (parsed.origin !== origin) {
    throw new Error(`Tarball URL origin "${parsed.origin}" does not match "${origin}".`);
  }
  return parsed.href;
}

function safeReleaseFolderName(release) {
  const clean = String(release || '').trim().replace(/\//g, '-').replace(SAFE_TAG_RE, '-').replace(/^-+|-+$/g, '');
  return clean.slice(0, 80) || `release-${Date.now()}`;
}

async function atomicSymlink(target, linkPath) {
  await mkdir(path.dirname(linkPath), { recursive: true });
  const tmpLink = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
  await rm(tmpLink, { force: true }).catch(() => {});
  await symlink(target, tmpLink, process.platform === 'win32' ? 'junction' : 'dir');
  await rename(tmpLink, linkPath);
}

async function readSymlinkTarget(linkPath) {
  try {
    const info = await lstat(linkPath);
    if (!info.isSymbolicLink()) return null;
    return await realpath(linkPath);
  } catch {
    return null;
  }
}

export function smokeTestReleaseDir(releaseDir, { nodePath = process.execPath } = {}) {
  const serverUrl = pathToFileURL(path.join(releaseDir, 'server.mjs')).href;
  const res = spawnSync(
    nodePath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(serverUrl)}); process.exit(0);`],
    {
      cwd: releaseDir,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, LOOP_NO_AGENT_HOOKS: '1', LOOP_EMBEDDING_PROVIDER: 'off' },
    },
  );
  if (res.status === 0) return { ok: true };
  const detail = (res.stderr || res.stdout || res.error?.message || 'unknown error').trim().split('\n').slice(0, 8).join('\n');
  return { ok: false, detail };
}

async function downloadFileTo(url, destPath, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Download failed (HTTP ${res.status}) for ${url}.`);
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(destPath, buf);
    return;
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
}

async function pruneOldReleases(releasesDir, keepPaths) {
  const keepSet = new Set(keepPaths.filter(Boolean));
  let entries;
  try {
    entries = await readdir(releasesDir, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const full = path.join(releasesDir, entry.name);
    const resolved = await realpath(full).catch(() => full);
    dirs.push({ name: entry.name, full, resolved });
  }
  dirs.sort((a, b) => b.name.localeCompare(a.name));
  let keptCount = 0;
  for (const d of dirs) {
    if (keepSet.has(d.resolved) || keepSet.has(d.full)) {
      keptCount += 1;
      continue;
    }
    if (keptCount < MAX_KEPT_RELEASES) {
      keptCount += 1;
      continue;
    }
    await rm(d.full, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeCliShim(binDir, currentLink) {
  if (!binDir) return null;
  await mkdir(binDir, { recursive: true });
  const shimPath = path.join(binDir, 'loop');
  const script = `#!/bin/sh\nexec node "${currentLink}/scripts/loop-cli.mjs" "$@"\n`;
  const tmpPath = `${shimPath}.tmp-${process.pid}`;
  await writeFile(tmpPath, script, { mode: 0o755 });
  await chmod(tmpPath, 0o755);
  await rename(tmpPath, shimPath);
  return shimPath;
}

function tryRestartLaunchd(releaseDir) {
  if (process.platform !== 'darwin') return { restarted: false, reason: 'not-macos' };
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) return { restarted: false, reason: 'no-uid' };
  const check = spawnSync('launchctl', ['print', `gui/${uid}/local.loop-gateway`], { stdio: 'ignore' });
  if (check.status !== 0) return { restarted: false, reason: 'service-not-loaded' };
  const script = path.join(releaseDir, 'scripts', 'restart-loop.sh');
  if (!existsSync(script)) return { restarted: false, reason: 'no-restart-script' };
  const res = spawnSync('sh', [script, '--when-idle'], { cwd: releaseDir, encoding: 'utf8', timeout: 90_000 });
  if (res.status === 0) return { restarted: true };
  return { restarted: false, reason: (res.stderr || res.stdout || 'restart failed').trim() };
}

export function parseLoopCliArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const command = args[0] && !args[0].startsWith('-') ? args.shift().toLowerCase() : 'help';
  const opts = {
    command,
    rest: [],
    url: DEFAULT_ORIGIN,
    urlSpecified: false,
    token: null,
    actor: null,
    role: null,
    argsJson: null,
    agentsOnly: false,
    checkOnly: false,
    force: false,
    json: false,
    noRestart: false,
    noHooks: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') opts.command = 'help';
    else if (arg === '--url' && args[i + 1]) { opts.url = args[++i]; opts.urlSpecified = true; }
    else if (arg.startsWith('--url=')) { opts.url = arg.slice(6); opts.urlSpecified = true; }
    else if (arg === '--token' && args[i + 1]) opts.token = args[++i];
    else if (arg.startsWith('--token=')) opts.token = arg.slice(8);
    else if (arg === '--actor' && args[i + 1]) opts.actor = args[++i];
    else if (arg.startsWith('--actor=')) opts.actor = arg.slice(8);
    else if (arg === '--role' && args[i + 1]) opts.role = args[++i];
    else if (arg.startsWith('--role=')) opts.role = arg.slice(7);
    else if (arg === '--args' && args[i + 1]) opts.argsJson = args[++i];
    else if (arg.startsWith('--args=')) opts.argsJson = arg.slice(7);
    else if (arg === '--agents-only') opts.agentsOnly = true;
    else if (arg === '--check') opts.checkOnly = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--json') {
      if (command === 'call' && args[i + 1] && args[i + 1].trim().startsWith('{')) {
        opts.argsJson = args[++i];
      } else {
        opts.json = true;
      }
    } else if (arg.startsWith('--json=')) opts.argsJson = arg.slice(7);
    else if (arg === '--no-restart') opts.noRestart = true;
    else if (arg === '--no-hooks') opts.noHooks = true;
    else opts.rest.push(arg);
  }
  return opts;
}

export async function runLoopCli(argv = process.argv.slice(2), deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const log = deps.log || ((line) => console.log(line));
  const home = deps.home || os.homedir();
  const env = deps.env || process.env;
  const currentRepoRoot = deps.appDir || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const installRoot = deps.installRoot || path.join(env.LOOP_HOME || path.join(home, '.loop'), 'app');
  const currentLink = path.join(installRoot, 'current');
  const previousLink = path.join(installRoot, 'previous');
  const releasesDir = path.join(installRoot, 'releases');
  const binDir = deps.binDir !== undefined ? deps.binDir : (env.LOOP_BIN_DIR || path.join(home, '.local', 'bin'));
  const port = Number(env.LOOP_HUB_PORT) || 8799;

  const opts = parseLoopCliArgs(argv);

  if (opts.command === 'help') {
    log('Loop CLI — manage Local Loop and agent updates.');
    log('');
    log('Usage: loop <command> [options]');
    log('  version                     Show installed Loop release and directory');
    log('  status                      Show version, local health, and installed agent hooks');
    log('  check [--url <origin>]      Check whether a newer Loop release exists');
    log('  update [--url <origin>]     Download, verify SHA-256, test, install, and restart');
    log('  update --agents-only        Update only local agent skill and hook files (no re-login)');
    log('  rollback                    Switch back to the previous installed release');
    log('  start                       Start Local Loop');
    log('  restart                     Restart the local launchd Loop service gracefully');
    log('  connect [options]           Connect local AI agents (connect-agents.mjs)');
    log('  hooks [install|status|...]  Manage agent SessionStart hooks and loop skill');
    log('  tools [--url ...] [--token ...]         List available Loop tools via REST');
    log('  call <tool> [--json \'{...}\']           Invoke a Loop tool via REST');
    return { ok: true, command: 'help' };
  }

  if (opts.command === 'tools' || opts.command === 'call') {
    const baseUrl = String(
      opts.urlSpecified ? opts.url : (env.LOOP_HUB_URL || `http://127.0.0.1:${port}`),
    ).replace(/\/+$/, '');
    const token = opts.token || env.LOOP_HUB_TOKEN || env.LOOP_TOKEN || '';
    const headers = {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.actor ? { 'X-Loop-Actor': opts.actor } : {}),
    };
    const roleSuffix = opts.role ? `?role=${encodeURIComponent(opts.role)}` : '';

    if (opts.command === 'tools') {
      const res = await fetchImpl(`${baseUrl}/api/v1/tools${roleSuffix}`, { headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Failed to list tools (HTTP ${res.status}).`);
      }
      if (opts.json) {
        log(JSON.stringify(data, null, 2));
      } else {
        for (const tool of Array.isArray(data.tools) ? data.tools : []) {
          const desc = String(tool.description || '').replace(/\s+/g, ' ').slice(0, 80);
          log(`${tool.name}${desc ? ` — ${desc}` : ''}`);
        }
      }
      return data;
    }

    const toolName = opts.rest[0];
    if (!toolName) {
      throw new Error('Usage: loop call <tool> [--json \'{...}\']');
    }
    const rawArgs = opts.argsJson ?? opts.rest[1] ?? '{}';
    let parsedArgs;
    try {
      parsedArgs = JSON.parse(rawArgs);
    } catch {
      throw new Error('Tool arguments must be valid JSON.');
    }
    if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
      throw new Error('Tool arguments must be a JSON object.');
    }
    const res = await fetchImpl(`${baseUrl}/api/v1/tools/${encodeURIComponent(toolName)}/call${roleSuffix}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ arguments: parsedArgs }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `Tool call failed (HTTP ${res.status}).`);
    }
    if (opts.json) {
      log(JSON.stringify(data, null, 2));
    } else if (typeof data.text === 'string' && data.text) {
      log(data.text);
    } else {
      log(JSON.stringify(data, null, 2));
    }
    return data;
  }

  const activeDir = (await readSymlinkTarget(currentLink)) || currentRepoRoot;
  const installedVersion = currentLoopVersion(activeDir, env);
  const installedFile = parseReleaseFile(activeDir);

  if (opts.command === 'version') {
    const out = { version: installedVersion, release: installedFile.release || null, commit: installedFile.commit || null, dir: activeDir };
    if (opts.json) log(JSON.stringify(out, null, 2));
    else log(`Loop ${installedVersion} (${activeDir})`);
    return { ok: true, ...out };
  }

  if (opts.command === 'status') {
    let health = null;
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/health?detail=1`);
      if (res.ok) health = await res.json().catch(() => null);
    } catch {
      health = null;
    }
    const hooks = await agentHookStatus({ home, env }).catch(() => []);
    const out = {
      version: installedVersion,
      dir: activeDir,
      running: Boolean(health?.ok),
      health,
      previousAvailable: Boolean(await readSymlinkTarget(previousLink)),
      hooks: hooks.map((h) => ({ id: h.id, installed: h.installed, skill: h.skill, agentInstalled: h.agentInstalled })),
    };
    if (opts.json) {
      log(JSON.stringify(out, null, 2));
    } else {
      log(`Loop ${installedVersion}`);
      log(`Install dir: ${activeDir}`);
      log(`Local server: ${out.running ? `running (http://127.0.0.1:${port}, ${health.version || installedVersion})` : 'not running'}`);
      log(`Rollback ready: ${out.previousAvailable ? 'yes' : 'no'}`);
      for (const h of out.hooks) {
        if (!h.agentInstalled) continue;
        log(`Agent ${h.id}: hook=${h.installed ? 'installed' : 'off'}, skill=${h.skill}`);
      }
    }
    return { ok: true, ...out };
  }

  if (opts.command === 'connect') {
    return runConnectCli(argv.slice(1), { fetch: fetchImpl, log, home, env });
  }

  if (opts.command === 'hooks') {
    const hookScript = path.join(activeDir, 'scripts', 'agent-hooks.mjs');
    const res = spawnSync(process.execPath, [hookScript, ...argv.slice(1)], { stdio: 'inherit', cwd: activeDir });
    return { ok: res.status === 0, status: res.status };
  }

  if (opts.command === 'start') {
    const child = spawn(process.execPath, [path.join(activeDir, 'server.mjs')], { cwd: activeDir, stdio: 'inherit' });
    return new Promise((resolve) => child.on('exit', (code) => resolve({ ok: code === 0, status: code })));
  }

  if (opts.command === 'restart') {
    const res = tryRestartLaunchd(activeDir);
    if (res.restarted) log('Loop restarted cleanly.');
    else log(`Could not restart launchd service (${res.reason}). Restart Loop manually.`);
    return { ok: res.restarted, ...res };
  }

  if (opts.command === 'check' || (opts.command === 'update' && opts.checkOnly)) {
    const origin = validateReleaseOrigin(opts.url);
    const res = await fetchImpl(`${origin}/release.json`);
    if (!res.ok) throw new Error(`Could not read ${origin}/release.json (HTTP ${res.status}).`);
    const manifest = await res.json();
    const latest = String(manifest?.release || manifest?.version || '');
    const updateAvailable = Boolean(latest && latest !== installedVersion && latest !== installedFile.release);
    const out = {
      ok: true,
      origin,
      installed: installedVersion,
      latest,
      updateAvailable,
      hasTarball: Boolean(manifest?.tarball?.url && manifest?.tarball?.sha256),
      notes: manifest?.notes || '',
    };
    if (opts.json) {
      log(JSON.stringify(out, null, 2));
    } else if (updateAvailable) {
      log(`Update available: ${installedVersion} -> ${latest}`);
      if (out.notes) log(`Notes: ${out.notes}`);
      log(out.hasTarball ? 'Run `loop update` to install it.' : 'Run `loop update --agents-only` to refresh agent files.');
    } else {
      log(`Loop is up to date (${installedVersion}).`);
    }
    return out;
  }

  if (opts.command === 'update') {
    const origin = validateReleaseOrigin(opts.url);
    if (opts.agentsOnly) {
      return runConnectCli(['--url', origin, '--update', ...(opts.json ? ['--json'] : [])], {
        fetch: fetchImpl,
        log,
        home,
        env,
      });
    }

    const res = await fetchImpl(`${origin}/release.json`);
    if (!res.ok) throw new Error(`Could not read ${origin}/release.json (HTTP ${res.status}).`);
    const manifest = await res.json();
    const latestRelease = String(manifest?.release || '').trim();
    const minNode = manifest?.minNode || MIN_NODE_VERSION;
    if (!isNodeVersionSupported(process.versions.node, minNode)) {
      throw new Error(`Loop ${latestRelease || 'latest'} requires Node.js ${minNode} or newer (found ${process.versions.node}).`);
    }
    if (!manifest?.tarball?.url || !/^[0-9a-f]{64}$/i.test(String(manifest?.tarball?.sha256 || ''))) {
      throw new Error(`No downloadable release archive is published at ${origin}/release.json.`);
    }

    const currentTarget = await readSymlinkTarget(currentLink);
    if (!opts.force && currentTarget && latestRelease && (latestRelease === installedVersion || latestRelease === installedFile.release)) {
      if (!opts.noHooks) {
        await refreshAgentHooks({
          home,
          env,
          script: path.join(currentLink, 'hooks', 'loop-hook.mjs'),
          skillDir: path.join(currentLink, 'skills', 'loop'),
        }).catch(() => {});
      }
      const out = { ok: true, updated: false, version: installedVersion, dir: currentTarget };
      if (opts.json) log(JSON.stringify(out, null, 2));
      else log(`Loop is already up to date (${installedVersion}).`);
      return out;
    }

    const tarballUrl = validateDownloadUrl(manifest.tarball.url, origin);
    const expectedSha = manifest.tarball.sha256.toLowerCase();
    const stamp = `${Date.now()}-${process.pid}`;
    const stagingDir = path.join(releasesDir, `.staging-${stamp}`);
    const archivePath = path.join(stagingDir, 'release.tar.gz');
    const extractDir = path.join(stagingDir, 'app');
    await mkdir(extractDir, { recursive: true });

    try {
      if (!opts.json) log(`Downloading Loop ${latestRelease || manifest.version} from ${origin}...`);
      await downloadFileTo(tarballUrl, archivePath, fetchImpl);
      const actualSha = await sha256File(archivePath);
      if (actualSha.toLowerCase() !== expectedSha) {
        throw new Error(`SHA-256 mismatch for ${tarballUrl}: expected ${expectedSha}, got ${actualSha}.`);
      }

      execFileSync('tar', ['-xzf', archivePath, '-C', extractDir], { stdio: 'pipe' });

      if (!deps.skipNpmCi) {
        if (!opts.json) log('Installing production dependencies...');
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const npmRes = spawnSync(npmCmd, ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
          cwd: extractDir,
          encoding: 'utf8',
          timeout: 180_000,
        });
        if (npmRes.status !== 0) {
          throw new Error(`npm ci failed: ${(npmRes.stderr || npmRes.stdout || '').trim().slice(0, 400)}`);
        }
      }

      if (!deps.skipSmokeTest) {
        const smoke = smokeTestReleaseDir(extractDir);
        if (!smoke.ok) {
          throw new Error(`New release failed load check; existing install left untouched.\n${smoke.detail}`);
        }
      }

      const folderName = safeReleaseFolderName(latestRelease || manifest.version || stamp);
      let finalDir = path.join(releasesDir, folderName);
      if (existsSync(finalDir)) {
        finalDir = path.join(releasesDir, `${folderName}-${Date.now()}`);
      }
      await rename(extractDir, finalDir);

      if (currentTarget && currentTarget !== finalDir) {
        await atomicSymlink(currentTarget, previousLink);
      }
      await atomicSymlink(finalDir, currentLink);
      const shimPath = await writeCliShim(binDir, currentLink);
      await pruneOldReleases(releasesDir, [finalDir, currentTarget]);

      if (!opts.noHooks) {
        await refreshAgentHooks({
          home,
          env,
          script: path.join(currentLink, 'hooks', 'loop-hook.mjs'),
          skillDir: path.join(currentLink, 'skills', 'loop'),
        }).catch(() => {});
      }

      const restart = opts.noRestart || deps.skipRestart ? { restarted: false, reason: 'skipped' } : tryRestartLaunchd(finalDir);
      const out = {
        ok: true,
        updated: true,
        previous: currentTarget ? installedVersion : null,
        version: latestRelease || currentLoopVersion(finalDir, env),
        sha256: actualSha,
        dir: finalDir,
        currentLink,
        shimPath,
        restarted: restart.restarted,
      };
      if (opts.json) {
        log(JSON.stringify(out, null, 2));
      } else {
        log(`Updated Loop to ${out.version} (SHA-256 verified).`);
        log(`Active install: ${currentLink} -> ${finalDir}`);
        if (restart.restarted) log('Restarted Local Loop service cleanly.');
        else if (!opts.noRestart && !deps.skipRestart) log('Run `loop start` (or restart Loop) to use the new release.');
      }
      return out;
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (opts.command === 'rollback') {
    const prevTarget = await readSymlinkTarget(previousLink);
    if (!prevTarget) {
      throw new Error('No previous Loop release is available to roll back to.');
    }
    if (!deps.skipSmokeTest) {
      const smoke = smokeTestReleaseDir(prevTarget);
      if (!smoke.ok) {
        throw new Error(`Previous release failed load check: ${smoke.detail}`);
      }
    }
    const oldCurrent = await readSymlinkTarget(currentLink);
    await atomicSymlink(prevTarget, currentLink);
    if (oldCurrent && oldCurrent !== prevTarget) {
      await atomicSymlink(oldCurrent, previousLink);
    }
    if (!opts.noHooks) {
      await refreshAgentHooks({
        home,
        env,
        script: path.join(currentLink, 'hooks', 'loop-hook.mjs'),
        skillDir: path.join(currentLink, 'skills', 'loop'),
      }).catch(() => {});
    }
    const restart = opts.noRestart || deps.skipRestart ? { restarted: false, reason: 'skipped' } : tryRestartLaunchd(prevTarget);
    const rolledVersion = currentLoopVersion(prevTarget, env);
    const out = { ok: true, rolledBack: true, version: rolledVersion, dir: prevTarget, restarted: restart.restarted };
    if (opts.json) log(JSON.stringify(out, null, 2));
    else log(`Rolled back Loop to ${rolledVersion} (${prevTarget}).`);
    return out;
  }

  throw new Error(`Unknown command "${opts.command}". Run "loop help" for usage.`);
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runLoopCli().catch((err) => {
    console.error(`Error: ${err?.message || err}`);
    process.exit(1);
  });
}
