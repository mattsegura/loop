#!/usr/bin/env node
// Loop Device Code CLI & agent updater: connects installed local AI agents (Muse Code, Claude Code,
// Codex, Cursor, Antigravity, Pi, OpenCode, Gemini CLI, VS Code, Windsurf, Kimi, Zed) to Local Loop
// or Hosted Loop (useloop.sh) via RFC 8628 Device Code flow, and installs or updates the standalone
// `loop` skill and SessionStart hook cleanly.
//
// Usage:
//   node scripts/connect-agents.mjs [--url https://useloop.sh] [--agents muse,codex] [--project work] [--no-open]
//   curl -fsSL https://useloop.sh/connect.mjs | node
//   curl -fsSL https://useloop.sh/connect.mjs | node - --update

import { execFile } from 'node:child_process';
import * as nodeCrypto from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';
import * as nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
// __INLINE_INSTALLER_START__
import { detectInstallableAgents, installLoopIntoAgent } from '../lib/agent-installer.mjs';
// __INLINE_INSTALLER_END__

const DEFAULT_LOOP_URL = '__DEFAULT_LOOP_URL__'.startsWith('http')
  ? '__DEFAULT_LOOP_URL__'
  : (process.env.LOOP_URL || 'http://127.0.0.1:8799');

const LOOP_SKILL_MARKER = 'loop-managed-skill';
const HOOK_MARKER = 'loop-hook.mjs';

export function parseConnectArgs(argv) {
  const opts = {
    url: DEFAULT_LOOP_URL,
    agents: null,
    profile: '',
    claim: '',
    serverName: 'loop',
    noOpen: false,
    noFiles: false,
    update: false,
    check: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--no-open' || arg === '--headless') opts.noOpen = true;
    else if (arg === '--no-files') opts.noFiles = true;
    else if (arg === '--update') opts.update = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--url' && argv[i + 1]) { opts.url = argv[++i]; }
    else if (arg.startsWith('--url=')) { opts.url = arg.slice(6); }
    else if (arg === '--agents' && argv[i + 1]) { opts.agents = argv[++i].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); }
    else if (arg.startsWith('--agents=')) { opts.agents = arg.slice(9).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); }
    else if ((arg === '--profile' || arg === '--project') && argv[i + 1]) { opts.profile = argv[++i].trim(); }
    else if (arg.startsWith('--profile=')) { opts.profile = arg.slice(10).trim(); }
    else if (arg.startsWith('--project=')) { opts.profile = arg.slice(10).trim(); }
    else if (arg === '--claim' && argv[i + 1]) { opts.claim = argv[++i].trim(); }
    else if (arg.startsWith('--claim=')) { opts.claim = arg.slice(8).trim(); }
    else if (arg === '--server-name' && argv[i + 1]) { opts.serverName = argv[++i].trim(); }
    else if (arg.startsWith('--server-name=')) { opts.serverName = arg.slice(14).trim(); }
  }
  return opts;
}

function tryOpenBrowser(url) {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.CI) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = execFile(cmd, args, { stdio: 'ignore' });
    child.unref?.();
    child.on('error', () => {});
  } catch {
    // Best effort: the URL is always printed in the terminal.
  }
}

function sha256Hex(buf) {
  return nodeCrypto.createHash('sha256').update(buf).digest('hex');
}

function isLoopbackHostName(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function validateAgentFileUrl(rawUrl, baseOrigin) {
  const parsed = new URL(String(rawUrl || ''), baseOrigin);
  if (parsed.username || parsed.password) throw new Error('Agent file URL must not contain credentials.');
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHostName(parsed.hostname))) {
    throw new Error('Agent file URL must use https://.');
  }
  if (parsed.origin !== baseOrigin) {
    throw new Error(`Agent file URL origin "${parsed.origin}" does not match "${baseOrigin}".`);
  }
  return parsed.href;
}

async function atomicWriteText(filePath, content, mode = 0o644) {
  await fsPromises.mkdir(nodePath.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.loop-tmp-${process.pid}-${Date.now()}`;
  await fsPromises.writeFile(tmp, content, { mode });
  await fsPromises.rename(tmp, filePath);
}

async function dirExistsSafe(dir) {
  try {
    const s = await fsPromises.stat(dir);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fetchVerifiedText(url, expectedSha, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Could not download ${url} (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (expectedSha) {
    const actual = sha256Hex(buf);
    if (actual !== String(expectedSha).toLowerCase()) {
      throw new Error(`SHA-256 mismatch for ${url}: expected ${expectedSha}, got ${actual}.`);
    }
  }
  return { text: buf.toString('utf8'), sha256: sha256Hex(buf) };
}

function standaloneSkillTargets({ home, env }) {
  const claudeDir = env.CLAUDE_CONFIG_DIR || nodePath.join(home, '.claude');
  const codexDir = env.CODEX_HOME || nodePath.join(home, '.codex');
  const geminiDir = env.GEMINI_CONFIG_DIR || nodePath.join(home, '.gemini');
  return [
    { id: 'claude-code', baseDir: claudeDir, skillLink: nodePath.join(claudeDir, 'skills', 'loop') },
    { id: 'codex', baseDir: codexDir, skillLink: nodePath.join(codexDir, 'skills', 'loop') },
    { id: 'antigravity', baseDir: nodePath.join(geminiDir, 'config'), skillLink: nodePath.join(geminiDir, 'config', 'skills', 'loop') },
    { id: 'cursor', baseDir: nodePath.join(home, '.cursor'), skillLink: nodePath.join(home, '.cursor', 'skills', 'loop') },
    { id: 'shared-agents', baseDir: nodePath.join(home, '.agents'), skillLink: nodePath.join(home, '.agents', 'skills', 'loop') },
  ];
}

async function linkLoopSkill(skillDir, targetLink) {
  let info = null;
  try {
    info = await fsPromises.lstat(targetLink);
  } catch (err) {
    if (err?.code !== 'ENOENT') return 'error';
  }
  if (info) {
    if (!info.isSymbolicLink()) return 'kept';
    const currentReal = await fsPromises.realpath(targetLink).catch(() => null);
    const wantedReal = await fsPromises.realpath(skillDir).catch(() => skillDir);
    if (currentReal === wantedReal) return 'linked';
    const rawTarget = await fsPromises.readlink(targetLink).catch(() => '');
    const normalized = rawTarget.replace(/[\\/]+$/, '');
    const isLoopOwned =
      normalized.endsWith('/skills/loop') ||
      normalized.endsWith('\\skills\\loop') ||
      normalized.includes(LOOP_SKILL_MARKER);
    if (!isLoopOwned) return 'kept';
    await fsPromises.unlink(targetLink);
  }
  await fsPromises.mkdir(nodePath.dirname(targetLink), { recursive: true });
  await fsPromises.symlink(skillDir, targetLink, process.platform === 'win32' ? 'junction' : 'dir');
  return info ? 'updated' : 'created';
}

function quoteShellArg(value) {
  return `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`;
}

async function upsertSessionStartHook({ hookScript, home, env, nodePathExec = process.execPath }) {
  const claudeDir = env.CLAUDE_CONFIG_DIR || nodePath.join(home, '.claude');
  const codexDir = env.CODEX_HOME || nodePath.join(home, '.codex');
  const targets = [
    { id: 'claude-code', dir: claudeDir, file: nodePath.join(claudeDir, 'settings.json') },
    { id: 'codex', dir: codexDir, file: nodePath.join(codexDir, 'hooks.json') },
  ];
  const updated = [];
  for (const t of targets) {
    if (!(await dirExistsSafe(t.dir))) continue;
    let data = {};
    let existed = false;
    try {
      const raw = await fsPromises.readFile(t.file, 'utf8');
      existed = true;
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        data = parsed;
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') continue;
    }
    const hooks = data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks) ? { ...data.hooks } : {};
    const existingGroups = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
    const keptGroups = [];
    for (const group of existingGroups) {
      if (!Array.isArray(group?.hooks)) {
        keptGroups.push(group);
        continue;
      }
      const kept = group.hooks.filter((h) => !(typeof h?.command === 'string' && h.command.includes(HOOK_MARKER)));
      if (kept.length) keptGroups.push({ ...group, hooks: kept });
    }
    const cmd = `${quoteShellArg(nodePathExec)} ${quoteShellArg(hookScript)} session-start --client ${t.id}`;
    hooks.SessionStart = [...keptGroups, { hooks: [{ type: 'command', command: cmd, timeout: 5 }] }];
    const next = { ...data, hooks };
    const before = JSON.stringify(data);
    if (JSON.stringify(next) !== before) {
      if (existed) await fsPromises.copyFile(t.file, `${t.file}.before-loop-hooks`).catch(() => {});
      await atomicWriteText(t.file, JSON.stringify(next, null, 2) + '\n', 0o600);
      updated.push({ id: t.id, status: 'updated', file: t.file });
    } else {
      updated.push({ id: t.id, status: 'unchanged', file: t.file });
    }
  }
  return updated;
}

export async function syncStandaloneAgentFiles({ baseOrigin, home, env, fetchImpl, checkOnly = false }) {
  const loopHome = env.LOOP_HOME || nodePath.join(home, '.loop');
  const agentFilesDir = nodePath.join(loopHome, 'agent-files');
  const statePath = nodePath.join(agentFilesDir, 'release.json');
  let localState = null;
  try {
    localState = JSON.parse(await fsPromises.readFile(statePath, 'utf8'));
  } catch {
    localState = null;
  }

  const manifestRes = await fetchImpl(`${baseOrigin}/release.json`);
  if (!manifestRes.ok) {
    throw new Error(`Could not read ${baseOrigin}/release.json (HTTP ${manifestRes.status}).`);
  }
  const manifest = await manifestRes.json();
  const skillMeta = manifest?.agentFiles?.skill || null;
  const hookMeta = manifest?.agentFiles?.hook || null;
  if (!skillMeta?.url && !hookMeta?.url) {
    throw new Error(`No agent files were listed in ${baseOrigin}/release.json.`);
  }

  const latestRelease = String(manifest?.release || manifest?.version || '');
  const skillChanged = Boolean(skillMeta?.sha256 && skillMeta.sha256 !== localState?.skillSha256);
  const hookChanged = Boolean(hookMeta?.sha256 && hookMeta.sha256 !== localState?.hookSha256);
  const releaseChanged = Boolean(latestRelease && latestRelease !== localState?.release);
  const updateAvailable = !localState || skillChanged || hookChanged || releaseChanged;

  if (checkOnly) {
    return {
      ok: true,
      origin: baseOrigin,
      installedRelease: localState?.release || null,
      latestRelease,
      updateAvailable,
      skillChanged,
      hookChanged,
    };
  }

  const skillDir = nodePath.join(agentFilesDir, 'skills', 'loop');
  const skillFile = nodePath.join(skillDir, 'SKILL.md');
  const hookFile = nodePath.join(agentFilesDir, 'loop-hook.mjs');

  let skillSha256 = localState?.skillSha256 || null;
  let hookSha256 = localState?.hookSha256 || null;

  if (skillMeta?.url) {
    const skillUrl = validateAgentFileUrl(skillMeta.url, baseOrigin);
    const fetched = await fetchVerifiedText(skillUrl, skillMeta.sha256, fetchImpl);
    await atomicWriteText(skillFile, fetched.text, 0o644);
    skillSha256 = fetched.sha256;
  }

  if (hookMeta?.url) {
    const hookUrl = validateAgentFileUrl(hookMeta.url, baseOrigin);
    const fetched = await fetchVerifiedText(hookUrl, hookMeta.sha256, fetchImpl);
    await atomicWriteText(hookFile, fetched.text, 0o755);
    hookSha256 = fetched.sha256;
  }

  const skillLinks = [];
  if (skillMeta?.url) {
    for (const target of standaloneSkillTargets({ home, env })) {
      if (!(await dirExistsSafe(target.baseDir))) continue;
      const state = await linkLoopSkill(skillDir, target.skillLink);
      skillLinks.push({ id: target.id, status: state, path: target.skillLink });
    }
  }

  const hooks = hookMeta?.url ? await upsertSessionStartHook({ hookScript: hookFile, home, env }) : [];

  const nextState = {
    origin: baseOrigin,
    release: latestRelease,
    version: manifest?.version || null,
    skillSha256,
    hookSha256,
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteText(statePath, JSON.stringify(nextState, null, 2) + '\n', 0o644);

  return {
    ok: true,
    updated: updateAvailable,
    origin: baseOrigin,
    release: latestRelease,
    agentFilesDir,
    skillLinks,
    hooks,
  };
}

export async function runConnectCli(argv = process.argv.slice(2), deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const log = deps.log || ((msg) => console.log(msg));
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const home = deps.home || os.homedir();
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const openUrl = deps.openUrl || tryOpenBrowser;

  const opts = parseConnectArgs(argv);
  if (opts.help) {
    log('Loop Connect — connect installed AI agents and keep their Loop skill and hooks up to date.');
    log('');
    log('Usage: node scripts/connect-agents.mjs [options]');
    log('  --url <origin>         Loop server URL (default: http://127.0.0.1:8799 or $LOOP_URL)');
    log('  --update               Update only the local loop skill and hook files (no new sign-in)');
    log('  --check                Check whether newer agent skill or hook files exist');
    log('  --agents <list>        Comma-separated agent ids (e.g. muse,claude-code,codex,cursor,pi)');
    log('  --project <name>       Optional Loop project to pre-select');
    log('  --claim <code>         Claim a single-use agent handoff code directly (no browser sign-in)');
    log('  --server-name <name>   MCP server key name in agent configs (default: loop)');
    log('  --no-files             Skip installing or updating standalone loop skill and hook files');
    log('  --no-open              Print the sign-in URL without opening a browser');
    log('  --json                 Output JSON for --update or --check');
    return { ok: true, help: true };
  }

  let baseOrigin;
  try {
    const u = new URL(opts.url);
    baseOrigin = u.origin;
  } catch {
    throw new Error(`Invalid --url "${opts.url}". Use https://useloop.sh or http://127.0.0.1:8799.`);
  }

  if (opts.check || opts.update) {
    const res = await syncStandaloneAgentFiles({
      baseOrigin,
      home,
      env,
      fetchImpl,
      checkOnly: opts.check && !opts.update,
    });
    if (opts.json) {
      log(JSON.stringify(res, null, 2));
    } else if (opts.check && !opts.update) {
      if (res.updateAvailable) {
        log(`Agent file update available: ${res.installedRelease || 'none'} -> ${res.latestRelease}`);
        log(`Run: curl -fsSL ${baseOrigin}/connect.mjs | node - --update`);
      } else {
        log(`Agent files are up to date (${res.latestRelease}).`);
      }
    } else {
      log(`Updated Loop agent files to ${res.release} (SHA-256 verified).`);
      for (const link of res.skillLinks) log(`  Skill ${link.id}: ${link.status} (${link.path})`);
      for (const hook of res.hooks) log(`  Hook ${hook.id}: ${hook.status} (${hook.file})`);
    }
    return res;
  }

  const detected = await detectInstallableAgents({
    home,
    platform,
    env,
    endpoint: `${baseOrigin}/mcp`,
    serverName: opts.serverName,
  });

  const maybeSyncFiles = async () => {
    if (opts.noFiles) return null;
    try {
      const synced = await syncStandaloneAgentFiles({ baseOrigin, home, env, fetchImpl });
      log(`  Synced loop skill and hooks (${synced.release}).`);
      return synced;
    } catch {
      return null;
    }
  };

  // One-step claim path: exchanges a single-use LPAG-... claim code directly for a scoped agent token.
  if (opts.claim) {
    let target = null;
    if (opts.agents && opts.agents.length > 0) {
      target = detected.find((a) => opts.agents.includes(a.id)) || null;
      if (!target) throw new Error(`No matching agent found for --agents=${opts.agents.join(',')}.`);
    }
    log(`Loop target: ${baseOrigin}`);
    log('Claiming single-use agent connect code...');
    const claimRes = await fetchImpl(`${baseOrigin}/api/agent-handoff/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claimCode: opts.claim,
        ...(target ? { clientId: target.id, agentName: target.name } : {}),
      }),
    });
    const claimJson = await claimRes.json().catch(() => ({}));
    if (!claimRes.ok || !claimJson.access_token) {
      throw new Error(claimJson.error || `Could not claim connect code (HTTP ${claimRes.status}).`);
    }
    const mcpUrl = claimJson.mcp_url || `${baseOrigin}/mcp`;
    const claimedKind = String(claimJson.agent?.kind || '').toLowerCase();
    const resolvedTarget =
      target ||
      detected.find((a) => a.id === claimedKind) ||
      detected.find((a) => a.installed) ||
      null;
    const installed = [];
    if (resolvedTarget) {
      const written = await installLoopIntoAgent(resolvedTarget.id, {
        url: mcpUrl,
        token: claimJson.access_token,
        serverName: opts.serverName,
        home,
        platform,
        env,
      });
      installed.push(written);
      log(`  Connected ${written.name} -> ${written.configPath}`);
    } else {
      log(`Connected "${claimJson.agent?.name || 'Agent'}" to ${mcpUrl}. No local agent config matched automatically.`);
    }
    const agentFiles = await maybeSyncFiles();
    log('');
    log(`Done. Connected ${claimJson.agent?.name || resolvedTarget?.name || 'agent'} to ${mcpUrl}.`);
    return { ok: true, claimed: true, mcpUrl, agent: claimJson.agent || null, installed, agentFiles };
  }

  let selected;
  if (opts.agents && opts.agents.length > 0) {
    const wanted = new Set(opts.agents);
    selected = detected.filter((a) => wanted.has(a.id));
    if (selected.length === 0) {
      throw new Error(`No matching agents found for --agents=${opts.agents.join(',')}.`);
    }
  } else {
    selected = detected.filter((a) => a.installed);
    if (selected.length === 0) {
      throw new Error('No supported AI agents were found on this machine. Pass --agents muse,claude-code,... to force one.');
    }
  }

  const hostLabel = os.hostname().replace(/\.local$/i, '').slice(0, 40) || 'this machine';
  log(`Loop target: ${baseOrigin}`);
  log(`Detected agents (${selected.length}): ${selected.map((a) => a.name).join(', ')}`);

  const startRes = await fetchImpl(`${baseOrigin}/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: `Loop CLI (${hostLabel})`,
      agents: selected.map((a) => ({ id: a.id, name: a.name })),
      ...(opts.profile ? { profile: opts.profile } : {}),
    }),
  });
  const startJson = await startRes.json().catch(() => ({}));
  if (!startRes.ok || !startJson.device_code || !startJson.user_code) {
    throw new Error(startJson.error_description || startJson.error || `Could not start sign-in (HTTP ${startRes.status}).`);
  }

  const verifyUrl = startJson.verification_uri_complete || startJson.verification_uri;
  log('');
  log(`Sign-in code: ${startJson.user_code}`);
  log(`Open this page in any browser to approve:`);
  log(`  ${verifyUrl}`);
  log('');
  if (!opts.noOpen) openUrl(verifyUrl);
  log('Waiting for approval in Loop...');

  const deadline = Date.now() + (Number(startJson.expires_in) || 600) * 1000;
  let intervalMs = Math.max(1000, (Number(startJson.interval) || 2) * 1000);
  let grant = null;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const pollRes = await fetchImpl(`${baseOrigin}/oauth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: startJson.device_code,
      }),
    });
    const pollJson = await pollRes.json().catch(() => ({}));
    if (pollRes.ok && (pollJson.access_token || Array.isArray(pollJson.agents))) {
      grant = pollJson;
      break;
    }
    if (pollJson.error === 'authorization_pending') {
      continue;
    }
    if (pollJson.error === 'slow_down') {
      intervalMs = Math.max(intervalMs + 2000, (Number(pollJson.interval) || 4) * 1000);
      continue;
    }
    throw new Error(pollJson.error_description || pollJson.error || `Sign-in failed (HTTP ${pollRes.status}).`);
  }

  if (!grant) {
    throw new Error('Sign-in code expired before approval. Run this command again.');
  }

  const mcpUrl = grant.mcp_url || `${baseOrigin}/mcp`;
  const grantedAgents = Array.isArray(grant.agents) && grant.agents.length > 0
    ? grant.agents
    : selected.map((a) => ({ id: a.id, name: a.name, access_token: grant.access_token }));

  const installed = [];
  for (const agentGrant of grantedAgents) {
    if (!agentGrant?.id || agentGrant.id === 'other' || !agentGrant.access_token) continue;
    const written = await installLoopIntoAgent(agentGrant.id, {
      url: mcpUrl,
      token: agentGrant.access_token,
      serverName: opts.serverName,
      home,
      platform,
      env,
    });
    installed.push(written);
    log(`  Connected ${written.name} -> ${written.configPath}`);
  }

  const agentFiles = await maybeSyncFiles();
  log('');
  log(`Done. Connected ${installed.length} ${installed.length === 1 ? 'agent' : 'agents'} to ${mcpUrl}. Restart your agents if they are already open.`);
  return { ok: true, mcpUrl, installed, agentFiles };
}

const isMain =
  Boolean(process.argv[1]) &&
  process.argv[1] !== '-' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
const isStdinPipe = !process.argv[1] || process.argv[1] === '-';

if (isMain || isStdinPipe) {
  runConnectCli().catch((err) => {
    console.error(`Error: ${err?.message || err}`);
    process.exit(1);
  });
}
