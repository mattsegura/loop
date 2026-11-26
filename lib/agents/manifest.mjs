// Single declarative manifest of AI agent harnesses supported by Loop.
// Used across importers, installers, hooks, skills, and memory discovery so agent IDs,
// server config keys, and environment variable overrides stay consistent everywhere.
import os from 'node:os';
import path from 'node:path';

export const AGENT_MANIFEST = Object.freeze([
  Object.freeze({
    id: 'claude-code',
    label: 'Claude Code',
    format: 'json',
    serverKey: 'mcpServers',
    envDirVar: 'CLAUDE_CONFIG_DIR',
    defaultSubdir: '.claude',
    supportsHooks: true,
    supportsSkillLink: true,
  }),
  Object.freeze({
    id: 'claude-desktop',
    label: 'Claude Desktop',
    format: 'json',
    serverKey: 'mcpServers',
    envDirVar: null,
    defaultSubdir: null,
    supportsHooks: false,
    supportsSkillLink: false,
  }),
  Object.freeze({
    id: 'codex',
    label: 'Codex',
    format: 'toml',
    serverKey: 'mcp_servers',
    envDirVar: 'CODEX_HOME',
    defaultSubdir: '.codex',
    supportsHooks: true,
    supportsSkillLink: true,
  }),
  Object.freeze({
    id: 'cursor',
    label: 'Cursor',
    format: 'json',
    serverKey: 'mcpServers',
    envDirVar: null,
    defaultSubdir: '.cursor',
    supportsHooks: false,
    supportsSkillLink: true,
  }),
  Object.freeze({
    id: 'antigravity',
    label: 'Antigravity',
    format: 'json',
    serverKey: 'mcpServers',
    envDirVar: null,
    defaultSubdir: path.join('.gemini', 'antigravity'),
    supportsHooks: false,
    supportsSkillLink: true,
  }),
  Object.freeze({
    id: 'gemini',
    label: 'Gemini CLI',
    format: 'jsonc',
    serverKey: 'mcpServers',
    envDirVar: 'GEMINI_CONFIG_DIR',
    defaultSubdir: '.gemini',
    supportsHooks: true,
    supportsSkillLink: false,
  }),
  Object.freeze({
    id: 'vscode',
    label: 'VS Code',
    format: 'jsonc',
    serverKey: 'servers',
    envDirVar: null,
    defaultSubdir: null,
    supportsHooks: false,
    supportsSkillLink: false,
  }),
  Object.freeze({
    id: 'windsurf',
    label: 'Windsurf',
    format: 'json',
    serverKey: 'mcpServers',
    envDirVar: null,
    defaultSubdir: path.join('.codeium', 'windsurf'),
    supportsHooks: false,
    supportsSkillLink: false,
  }),
  Object.freeze({
    id: 'opencode',
    label: 'OpenCode',
    format: 'jsonc',
    serverKey: 'mcp',
    envDirVar: 'XDG_CONFIG_HOME',
    defaultSubdir: path.join('.config', 'opencode'),
    supportsHooks: false,
    supportsSkillLink: false,
  }),
  Object.freeze({
    id: 'zed',
    label: 'Zed',
    format: 'jsonc',
    serverKey: 'context_servers',
    envDirVar: 'XDG_CONFIG_HOME',
    defaultSubdir: path.join('.config', 'zed'),
    supportsHooks: false,
    supportsSkillLink: false,
  }),
  Object.freeze({
    id: 'kimi-code',
    label: 'Kimi Code',
    format: 'json',
    serverKey: 'mcpServers',
    envDirVar: null,
    defaultSubdir: '.kimi',
    supportsHooks: false,
    supportsSkillLink: false,
  }),
  Object.freeze({
    id: 'muse',
    label: 'Muse Code',
    format: 'json',
    serverKey: 'mcpServers',
    envDirVar: null,
    defaultSubdir: '.muse',
    supportsHooks: false,
    supportsSkillLink: false,
  }),
  Object.freeze({
    id: 'pi',
    label: 'Pi',
    format: 'json',
    serverKey: 'mcpServers',
    envDirVar: null,
    defaultSubdir: '.pi',
    supportsHooks: false,
    supportsSkillLink: false,
  }),
]);

export const AGENT_MANIFEST_BY_ID = Object.freeze(
  Object.fromEntries(AGENT_MANIFEST.map((entry) => [entry.id, entry])),
);

export const JSON_SERVER_KEY_MAP = Object.freeze(
  Object.fromEntries(
    AGENT_MANIFEST
      .filter((entry) => entry.format === 'json' || entry.format === 'jsonc')
      .map((entry) => [entry.id, entry.serverKey]),
  ),
);

export function resolveAgentConfigDir(id, { home = os.homedir(), env = process.env } = {}) {
  const spec = AGENT_MANIFEST_BY_ID[id];
  if (!spec) return null;
  if (spec.envDirVar && env?.[spec.envDirVar]) {
    const base = String(env[spec.envDirVar]).trim();
    if (base) {
      if (spec.envDirVar === 'XDG_CONFIG_HOME') return path.join(base, id);
      return base;
    }
  }
  return spec.defaultSubdir ? path.join(home, spec.defaultSubdir) : null;
}
