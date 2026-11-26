// Direct, zero-dependency agent MCP config detector and atomic writer.
// Lets local Loop (one-click Connect) and the hosted Device Code CLI (`connect-agents.mjs`)
// write a scoped `Authorization: Bearer loop_...` entry straight into each installed agent's
// config file — no localhost OAuth callback server, no browser redirect handoff, no Keychain prompts.

import { randomBytes } from 'node:crypto';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/i;
const LOOP_TOKEN_RE = /^loop_[A-Za-z0-9_-]{16,128}$/;

function isLoopbackHostname(hostname) {
  const clean = String(hostname || '').toLowerCase();
  return clean === '127.0.0.1' || clean === 'localhost' || clean === '::1' || clean === '[::1]';
}

function validateInstallInputs({ url, token, serverName = 'loop' }) {
  const cleanName = String(serverName || 'loop').trim();
  if (!SERVER_NAME_RE.test(cleanName)) {
    throw new Error('Server name must start with a letter or digit and use only letters, digits, "-" or "_".');
  }
  const cleanToken = String(token || '').trim();
  if (!LOOP_TOKEN_RE.test(cleanToken)) {
    throw new Error('Agent token must be a valid Loop bearer token.');
  }
  const rawUrl = String(url || '').trim();
  if (!rawUrl || /[\r\n\u0000-\u001f"\\]/.test(rawUrl)) {
    throw new Error('Loop MCP URL is invalid.');
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Loop MCP URL must be a valid http or https URL.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Loop MCP URL must not contain embedded credentials.');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname))) {
    throw new Error('Loop MCP URL must use https:// (or http:// on loopback).');
  }
  return { serverName: cleanName, url: parsed.href, token: cleanToken };
}

function stripUtf8Bom(text) {
  const s = String(text ?? '');
  return s.startsWith('\uFEFF') ? s.slice(1) : s;
}

export function parseJsoncLoose(text) {
  const src = stripUtf8Bom(text);
  let out = '';
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
    } else if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  let cleaned = '';
  inString = false;
  for (let j = 0; j < out.length; j += 1) {
    const ch = out[j];
    if (inString) {
      cleaned += ch;
      if (ch === '\\') {
        cleaned += out[j + 1] ?? '';
        j += 1;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }
    if (ch === ',') {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k += 1;
      if (out[k] === '}' || out[k] === ']') continue;
    }
    cleaned += ch;
  }
  return JSON.parse(cleaned);
}

function escapeTomlString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function formatTomlKey(seg) {
  return /^[A-Za-z0-9_-]+$/.test(seg) ? seg : `"${escapeTomlString(seg)}"`;
}

function parseTomlHeaderSegments(rawHeader) {
  const segs = [];
  let i = 0;
  const s = rawHeader.trim();
  while (i < s.length) {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
    if (i >= s.length) break;
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i];
      i += 1;
      let val = '';
      while (i < s.length && s[i] !== q) {
        if (q === '"' && s[i] === '\\' && i + 1 < s.length) {
          val += s[i + 1];
          i += 2;
          continue;
        }
        val += s[i];
        i += 1;
      }
      if (s[i] === q) i += 1;
      segs.push(val);
    } else {
      const start = i;
      while (i < s.length && s[i] !== '.' && s[i] !== ' ' && s[i] !== '\t') i += 1;
      segs.push(s.slice(start, i));
    }
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
    if (s[i] === '.') i += 1;
  }
  return segs;
}

function stripTomlLineComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inDouble) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '"') inDouble = false;
    } else if (inSingle) {
      if (ch === "'") inSingle = false;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Surgically replaces (or appends) `[mcp_servers.<serverName>]` in a Codex `config.toml`
 * while preserving comments, unrelated tables, and any existing `default_tools_approval_mode`.
 */
export function upsertTomlMcpServer(rawText, serverName, { url, token }) {
  const eol = rawText.includes('\r\n') ? '\r\n' : '\n';
  const lines = stripUtf8Bom(rawText).split(/\r?\n/);
  const kept = [];
  let inTargetSection = false;
  let existingApprovalMode = null;

  for (const line of lines) {
    const code = stripTomlLineComment(line).trim();
    const tableMatch = /^\[(\[?)(.+?)(\]?)\]$/.exec(code);
    if (tableMatch) {
      const segs = parseTomlHeaderSegments(tableMatch[2]);
      const isTarget = segs[0] === 'mcp_servers' && segs[1] === serverName;
      inTargetSection = isTarget;
      if (isTarget) continue;
      kept.push(line);
      continue;
    }
    if (inTargetSection) {
      const modeMatch = /^default_tools_approval_mode\s*=\s*"([^"\r\n\\]{1,32})"/.exec(code);
      if (modeMatch) existingApprovalMode = modeMatch[1];
      continue;
    }
    // Also drop top-level dotted keys targeting mcp_servers.<serverName>.*
    const eqIdx = code.indexOf('=');
    if (eqIdx > 0) {
      const lhsSegs = parseTomlHeaderSegments(code.slice(0, eqIdx));
      if (lhsSegs[0] === 'mcp_servers' && lhsSegs[1] === serverName) {
        continue;
      }
    }
    kept.push(line);
  }

  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();

  const approvalMode = existingApprovalMode || 'approve';
  const block = [
    `[mcp_servers.${formatTomlKey(serverName)}]`,
    `url = "${escapeTomlString(url)}"`,
    `http_headers = { Authorization = "Bearer ${escapeTomlString(token)}" }`,
    `default_tools_approval_mode = "${escapeTomlString(approvalMode)}"`,
  ];

  const prefix = kept.length > 0 ? `${kept.join(eol)}${eol}${eol}` : '';
  return `${prefix}${block.join(eol)}${eol}`;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export const INSTALLABLE_HARNESSES = Object.freeze([
  'muse',
  'claude-code',
  'codex',
  'cursor',
  'antigravity',
  'pi',
  'opencode',
  'gemini',
  'vscode',
  'windsurf',
  'kimi-code',
  'zed',
]);

export function agentInstallTargets({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const appSupport =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : xdgConfig;
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : null;

  return [
    {
      id: 'muse',
      name: 'Muse Code',
      kind: 'muse',
      format: 'json',
      containerKey: 'mcpServers',
      files: [path.join(xdgConfig, 'muse', 'settings.json')],
      detectPaths: [
        path.join(xdgConfig, 'muse', 'settings.json'),
        path.join(xdgConfig, 'muse'),
        path.join(home, '.local', 'bin', 'muse'),
      ],
      defaultRoot: { schema_version: 1 },
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      kind: 'claude-code',
      format: 'json',
      containerKey: 'mcpServers',
      files: claudeConfigDir
        ? [path.join(claudeConfigDir, '.claude.json'), path.join(home, '.claude.json')]
        : [path.join(home, '.claude.json')],
      detectPaths: [
        path.join(home, '.claude.json'),
        path.join(home, '.claude'),
        path.join(home, '.local', 'bin', 'claude'),
      ],
    },
    {
      id: 'codex',
      name: 'Codex',
      kind: 'codex',
      format: 'toml',
      containerKey: 'mcp_servers',
      files: [path.join(codexHome, 'config.toml')],
      detectPaths: [
        path.join(codexHome, 'config.toml'),
        codexHome,
        path.join(home, '.local', 'bin', 'codex'),
      ],
    },
    {
      id: 'cursor',
      name: 'Cursor',
      kind: 'cursor',
      format: 'json',
      containerKey: 'mcpServers',
      files: [path.join(home, '.cursor', 'mcp.json')],
      detectPaths: [
        path.join(home, '.cursor', 'mcp.json'),
        path.join(home, '.cursor'),
        ...(platform === 'darwin' && home === os.homedir() ? ['/Applications/Cursor.app'] : []),
      ],
    },
    {
      id: 'antigravity',
      name: 'Antigravity',
      kind: 'antigravity',
      format: 'json',
      containerKey: 'mcpServers',
      files: [
        path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
        path.join(home, '.gemini', 'config', 'mcp_config.json'),
      ],
      detectPaths: [
        path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
        path.join(home, '.gemini', 'antigravity'),
      ],
    },
    {
      id: 'pi',
      name: 'Pi',
      kind: 'pi',
      format: 'json',
      containerKey: 'mcpServers',
      files: [path.join(home, '.pi', 'agent', 'mcp.json')],
      detectPaths: [
        path.join(home, '.pi', 'agent', 'mcp.json'),
        path.join(home, '.pi'),
        path.join(home, '.local', 'bin', 'pi'),
      ],
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      kind: 'opencode',
      format: 'jsonc',
      containerKey: 'mcp',
      files: [
        path.join(xdgConfig, 'opencode', 'opencode.json'),
        path.join(xdgConfig, 'opencode', 'opencode.jsonc'),
      ],
      detectPaths: [
        path.join(xdgConfig, 'opencode', 'opencode.json'),
        path.join(xdgConfig, 'opencode', 'opencode.jsonc'),
        path.join(xdgConfig, 'opencode'),
        path.join(home, '.opencode', 'bin', 'opencode'),
      ],
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      kind: 'gemini',
      format: 'jsonc',
      containerKey: 'mcpServers',
      files: [path.join(home, '.gemini', 'settings.json')],
      detectPaths: [path.join(home, '.gemini', 'settings.json')],
    },
    {
      id: 'vscode',
      name: 'VS Code',
      kind: 'vscode',
      format: 'jsonc',
      containerKey: 'servers',
      files: [path.join(appSupport, 'Code', 'User', 'mcp.json')],
      detectPaths: [
        path.join(appSupport, 'Code', 'User', 'mcp.json'),
        path.join(appSupport, 'Code', 'User'),
      ],
    },
    {
      id: 'windsurf',
      name: 'Windsurf',
      kind: 'windsurf',
      format: 'json',
      containerKey: 'mcpServers',
      files: [path.join(home, '.codeium', 'windsurf', 'mcp_config.json')],
      detectPaths: [
        path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
        path.join(home, '.codeium', 'windsurf'),
      ],
    },
    {
      id: 'kimi-code',
      name: 'Kimi',
      kind: 'kimi-code',
      format: 'json',
      containerKey: 'mcpServers',
      files: [
        path.join(home, '.kimi-code', 'mcp.json'),
        path.join(home, '.kimi', 'mcp.json'),
      ],
      detectPaths: [
        path.join(home, '.kimi-code', 'mcp.json'),
        path.join(home, '.kimi-code'),
        path.join(home, '.kimi', 'mcp.json'),
      ],
    },
    {
      id: 'zed',
      name: 'Zed',
      kind: 'zed',
      format: 'jsonc',
      containerKey: 'context_servers',
      files: [path.join(xdgConfig, 'zed', 'settings.json')],
      detectPaths: [path.join(xdgConfig, 'zed', 'settings.json')],
    },
  ];
}

export function buildServerEntry(harnessId, { url, token }) {
  const authHeader = `Bearer ${token}`;
  switch (harnessId) {
    case 'muse':
      return {
        type: 'streamable-http',
        url,
        headers: { Authorization: authHeader },
      };
    case 'claude-code':
    case 'vscode':
      return {
        type: 'http',
        url,
        headers: { Authorization: authHeader },
      };
    case 'opencode':
      return {
        type: 'remote',
        url,
        headers: { Authorization: authHeader },
        enabled: true,
      };
    case 'gemini':
      return {
        httpUrl: url,
        headers: { Authorization: authHeader },
      };
    case 'windsurf':
      return {
        serverUrl: url,
        headers: { Authorization: authHeader },
      };
    default:
      return {
        url,
        headers: { Authorization: authHeader },
      };
  }
}

function normalizeEndpointForMatch(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    const host = isLoopbackHostname(u.hostname) ? '127.0.0.1' : u.hostname.toLowerCase();
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const pathname = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${host}:${port}${pathname}`;
  } catch {
    return '';
  }
}

function inspectTomlLoopEntry(text, serverName, expectedEndpoint) {
  const lines = stripUtf8Bom(text).split(/\r?\n/);
  let inTarget = false;
  let url = '';
  let hasLoopToken = false;
  for (const line of lines) {
    const code = stripTomlLineComment(line).trim();
    const tableMatch = /^\[(\[?)(.+?)(\]?)\]$/.exec(code);
    if (tableMatch) {
      const segs = parseTomlHeaderSegments(tableMatch[2]);
      inTarget = segs[0] === 'mcp_servers' && segs[1] === serverName;
      continue;
    }
    if (!inTarget) continue;
    const urlMatch = /^url\s*=\s*"([^"]+)"/.exec(code);
    if (urlMatch) url = urlMatch[1];
    if (/Authorization\s*=\s*"Bearer\s+loop_[A-Za-z0-9_-]{16,128}"/.test(code)) {
      hasLoopToken = true;
    }
  }
  if (!url) return { hasEntry: false, matchesEndpoint: false, hasLoopToken: false };
  const matchesEndpoint = !expectedEndpoint || normalizeEndpointForMatch(url) === normalizeEndpointForMatch(expectedEndpoint);
  return { hasEntry: true, matchesEndpoint, hasLoopToken };
}

function inspectJsonLoopEntry(parsed, containerKey, serverName, expectedEndpoint) {
  const container = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed[containerKey] : null;
  const entry = container && typeof container === 'object' && !Array.isArray(container) ? container[serverName] : null;
  if (!entry || typeof entry !== 'object') {
    return { hasEntry: false, matchesEndpoint: false, hasLoopToken: false };
  }
  const url = String(entry.url || entry.httpUrl || entry.serverUrl || '');
  const headers = entry.headers && typeof entry.headers === 'object' ? entry.headers : {};
  const auth = String(headers.Authorization || headers.authorization || '');
  const hasLoopToken = /^Bearer\s+loop_[A-Za-z0-9_-]{16,128}$/i.test(auth.trim());
  const matchesEndpoint = !expectedEndpoint || (Boolean(url) && normalizeEndpointForMatch(url) === normalizeEndpointForMatch(expectedEndpoint));
  return { hasEntry: Boolean(url), matchesEndpoint, hasLoopToken };
}

async function resolveTargetFile(target) {
  for (const candidate of target.files) {
    if (await exists(candidate)) return { filePath: candidate, fileExists: true };
  }
  return { filePath: target.files[0], fileExists: false };
}

function displayHomePath(filePath, home) {
  if (!home || !filePath) return filePath;
  const prefix = home.endsWith(path.sep) ? home : `${home}${path.sep}`;
  return filePath.startsWith(prefix) ? `~/${filePath.slice(prefix.length)}` : filePath;
}

export async function detectInstallableAgents({
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  endpoint = '',
  serverName = 'loop',
} = {}) {
  const targets = agentInstallTargets({ home, platform, env });
  const results = [];

  for (const target of targets) {
    let installed = false;
    for (const probe of target.detectPaths) {
      if (await exists(probe)) {
        installed = true;
        break;
      }
    }
    const { filePath, fileExists } = await resolveTargetFile(target);
    let status = { hasEntry: false, matchesEndpoint: false, hasLoopToken: false };
    let parseError = null;
    if (fileExists) {
      try {
        const raw = await readFile(filePath, 'utf8');
        if (target.format === 'toml') {
          status = inspectTomlLoopEntry(raw, serverName, endpoint);
        } else {
          const parsed = raw.trim() ? parseJsoncLoose(raw) : {};
          status = inspectJsonLoopEntry(parsed, target.containerKey, serverName, endpoint);
        }
      } catch (err) {
        parseError = err?.message || 'Could not parse config file';
      }
    }

    results.push({
      id: target.id,
      name: target.name,
      kind: target.kind,
      installed,
      fileExists,
      configPath: displayHomePath(filePath, home),
      connected: Boolean(status.hasEntry && status.matchesEndpoint && status.hasLoopToken),
      configuredWithoutToken: Boolean(status.hasEntry && status.matchesEndpoint && !status.hasLoopToken),
      ...(parseError ? { parseError } : {}),
    });
  }

  return results;
}

export async function installLoopIntoAgent(
  harnessId,
  {
    url,
    token,
    serverName = 'loop',
    home = os.homedir(),
    platform = process.platform,
    env = process.env,
    backup = true,
  } = {},
) {
  const valid = validateInstallInputs({ url, token, serverName });
  const targets = agentInstallTargets({ home, platform, env });
  const target = targets.find((t) => t.id === harnessId);
  if (!target) {
    throw new Error(`Unsupported agent harness "${String(harnessId || '')}".`);
  }

  const { filePath, fileExists } = await resolveTargetFile(target);
  const realTarget = fileExists ? await realpath(filePath) : filePath;
  await mkdir(path.dirname(realTarget), { recursive: true, mode: 0o700 });

  let existingRaw = '';
  let existingMode = 0o600;
  let backupPath = null;
  if (fileExists) {
    const st = await stat(realTarget);
    existingMode = (st.mode & 0o777) || 0o600;
    existingRaw = await readFile(realTarget, 'utf8');
    if (backup) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = `${realTarget}.loop-backup-${stamp}`;
      await copyFile(realTarget, backupPath);
      await chmod(backupPath, 0o600).catch(() => {});
    }
  }

  let nextText;
  if (target.format === 'toml') {
    nextText = upsertTomlMcpServer(existingRaw, valid.serverName, {
      url: valid.url,
      token: valid.token,
    });
  } else {
    let root = target.defaultRoot ? { ...target.defaultRoot } : {};
    if (existingRaw.trim()) {
      const parsed = parseJsoncLoose(existingRaw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Config file ${displayHomePath(filePath, home)} must contain a JSON object.`);
      }
      root = parsed;
    }
    const existingContainer = root[target.containerKey];
    const container =
      existingContainer && typeof existingContainer === 'object' && !Array.isArray(existingContainer)
        ? { ...existingContainer }
        : {};
    container[valid.serverName] = buildServerEntry(target.id, {
      url: valid.url,
      token: valid.token,
    });
    root[target.containerKey] = container;
    nextText = `${JSON.stringify(root, null, 2)}\n`;
  }

  const tmpPath = `${realTarget}.loop-tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    // Files holding a Loop Bearer token stay owner-only (0600) if newly created or stricter.
    const writeMode = fileExists ? (existingMode & 0o600) || 0o600 : 0o600;
    await writeFile(tmpPath, nextText, { encoding: 'utf8', mode: writeMode });
    await chmod(tmpPath, writeMode).catch(() => {});
    await rename(tmpPath, realTarget);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }

  return {
    id: target.id,
    name: target.name,
    kind: target.kind,
    serverName: valid.serverName,
    configPath: displayHomePath(filePath, home),
    realPath: realTarget,
    ...(backupPath ? { backupPath: displayHomePath(backupPath, home) } : {}),
  };
}
