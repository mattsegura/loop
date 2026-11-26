// Installs Loop's hooks into supported AI coding agents:
// - Stateless SessionStart hook + `loop` skill link for Claude Code and Codex.
// - Optional turn-by-turn recall hook per agent capability tier:
//   - Tier 1 (`mcp_pair`): Claude Code UserPromptSubmit (`turn-sketch` command + `loop__turn_recall` mcp_tool)
//   - Tier 2 (`command`):  Codex (`UserPromptSubmit`) and Gemini CLI (`BeforeAgent`) via local `turn-recall` command
//   - Tier 3 (`on_demand`): Other apps use startup pins + on-demand `loop__search({ type: "memory", query })`.
//
// Other keys and third-party hooks are preserved, and legacy Loop UserPromptSubmit entries are
// removed cleanly on upgrade.

import { copyFile, lstat, mkdir, readFile, readlink, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'loop-hook.mjs');
export const LOOP_SKILL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'loop');
const TURN_TOOL = 'loop__turn_recall';
const MARKER = 'loop-hook.mjs';

export const TURN_RECALL_CAPABILITIES = Object.freeze({
  'claude-code': Object.freeze({
    supported: true,
    mode: 'mcp_pair',
    event: 'UserPromptSubmit',
    label: 'Native MCP hook',
  }),
  codex: Object.freeze({
    supported: true,
    mode: 'command',
    event: 'UserPromptSubmit',
    label: 'Local folder hook',
  }),
  gemini: Object.freeze({
    supported: true,
    mode: 'command',
    event: 'BeforeAgent',
    label: 'Local folder hook',
  }),
});

export function turnRecallCapability(kind) {
  const clean = String(kind || '').trim().toLowerCase();
  return (
    TURN_RECALL_CAPABILITIES[clean] || {
      supported: false,
      mode: 'on_demand',
      event: null,
      label: 'On-demand search only',
    }
  );
}

const turnMcp = (h) => h?.type === 'mcp_tool' && h.server === 'loop' && h.tool === TURN_TOOL;
const turnSketchCommand = (h) =>
  h?.type === 'command' &&
  typeof h.command === 'string' &&
  h.command.includes(MARKER) &&
  h.command.includes('turn-sketch --client claude-code');
const turnCommandFor = (clientId) => (h) =>
  h?.type === 'command' &&
  typeof h.command === 'string' &&
  h.command.includes(MARKER) &&
  h.command.includes(`turn-recall --client ${clientId}`);

const EVENTS = [['SessionStart', 'session-start']];
const LEGACY_EVENTS = ['UserPromptSubmit'];
const ALL_MANAGED_EVENTS = ['SessionStart', 'UserPromptSubmit', 'BeforeAgent'];

function allTargetDefs({ home = os.homedir(), env = process.env } = {}) {
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codexDir = env.CODEX_HOME || path.join(home, '.codex');
  const geminiDir = env.GEMINI_CONFIG_DIR || path.join(home, '.gemini');
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      dir: claudeDir,
      file: path.join(claudeDir, 'settings.json'),
      skillLink: path.join(claudeDir, 'skills', 'loop'),
      sessionStart: true,
      recallMode: 'mcp_pair',
      recallEvent: 'UserPromptSubmit',
    },
    {
      id: 'codex',
      label: 'Codex',
      dir: codexDir,
      file: path.join(codexDir, 'hooks.json'),
      skillLink: path.join(codexDir, 'skills', 'loop'),
      sessionStart: true,
      recallMode: 'command',
      recallEvent: 'UserPromptSubmit',
    },
    {
      id: 'gemini',
      label: 'Gemini CLI',
      dir: geminiDir,
      file: path.join(geminiDir, 'settings.json'),
      skillLink: null,
      sessionStart: false,
      recallMode: 'command',
      recallEvent: 'BeforeAgent',
    },
  ];
}

export function agentHookTargets({ home = os.homedir(), env = process.env, includeRecallOnly = false } = {}) {
  const all = allTargetDefs({ home, env });
  return includeRecallOnly ? all : all.filter((t) => t.sessionStart);
}

function selectTargets(opts = {}) {
  const only = Array.isArray(opts.agents) && opts.agents.length ? new Set(opts.agents) : null;
  const includeRecallOnly = Boolean(opts.includeRecallOnly) || (only ? [...only].some((id) => id === 'gemini') : false);
  return agentHookTargets({ ...opts, includeRecallOnly }).filter((t) => !only || only.has(t.id));
}

const sameDir = async (a, b) => {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
};

/**
 * What is at an agent's skills/loop path:
 *   'missing' nothing there
 *   'linked'  a symlink to this checkout's skill
 *   'broken'  a symlink to a skills/loop folder that no longer exists (a moved Loop checkout)
 *   'other'   anything else: a real folder or file, or a link to somewhere else
 */
async function skillLinkState(link, skillDir) {
  if (!link) return 'missing';
  let info;
  try {
    info = await lstat(link);
  } catch (err) {
    if (err?.code === 'ENOENT') return 'missing';
    throw err;
  }
  if (!info.isSymbolicLink()) return 'other';
  if (await sameDir(link, skillDir)) return 'linked';
  const target = (await readlink(link).catch(() => '')).replace(/[\\/]+$/, '');
  const dangling = await realpath(link).then(() => false, () => true);
  return dangling && target.split(/[\\/]/).slice(-2).join('/') === 'skills/loop' ? 'broken' : 'other';
}

// mode: true = link it (or repair a broken link); 'repair' = only repair; 'remove' = take our link away.
async function applySkillLink(target, mode, skillDir) {
  if (!target.skillLink) return {};
  const out = { skillPath: target.skillLink };
  try {
    const state = await skillLinkState(target.skillLink, skillDir);
    if (mode === 'remove') {
      if (state === 'linked' || state === 'broken') {
        await unlink(target.skillLink);
        return { ...out, skill: 'removed' };
      }
      return { ...out, skill: state === 'other' ? 'kept' : 'missing' };
    }
    if (state === 'linked') return { ...out, skill: 'linked' };
    if (state === 'other') return { ...out, skill: 'kept', skillReason: 'Something else is already at this path; left alone.' };
    if (state === 'missing' && mode === 'repair') return { ...out, skill: 'missing' };
    if (state === 'broken') await unlink(target.skillLink);
    await mkdir(path.dirname(target.skillLink), { recursive: true });
    await symlink(skillDir, target.skillLink, process.platform === 'win32' ? 'junction' : 'dir');
    return { ...out, skill: state === 'broken' ? 'repaired' : 'created' };
  } catch (err) {
    return { ...out, skill: 'error', skillReason: err.message };
  }
}

const quote = (value) => `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`;
const safeArg = (value) => (/^[a-zA-Z0-9._-]+$/.test(value) ? value : quote(value));

export function hookCommand(
  arg,
  { node = process.execPath, script = HOOK_SCRIPT, client = null, recallDataDir = null } = {},
) {
  const parts = [quote(node), quote(script), arg];
  if (client) parts.push('--client', safeArg(String(client)));
  if (arg === 'turn-recall' && recallDataDir) parts.push('--data-dir', quote(String(recallDataDir)));
  return parts.join(' ');
}

const isLoopHook = (hook) => turnMcp(hook) || (typeof hook?.command === 'string' && hook.command.includes(MARKER));

// Drops Loop's own entries from one event's groups, keeping everything else.
function withoutLoop(groups) {
  const kept = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    if (!Array.isArray(group?.hooks)) {
      kept.push(group);
      continue;
    }
    const hooks = group.hooks.filter((hook) => !isLoopHook(hook));
    if (hooks.length === group.hooks.length) kept.push(group);
    else if (hooks.length) kept.push({ ...group, hooks });
  }
  return kept;
}

async function readJson(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { exists: false, data: {} };
    throw err;
  }
  if (!raw.trim()) return { exists: true, data: {} };
  const data = JSON.parse(raw); // A file we cannot parse is never overwritten.
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} is not a JSON object.`);
  return { exists: true, data };
}

async function writeJson(file, data, { backup }) {
  await mkdir(path.dirname(file), { recursive: true });
  if (backup) await copyFile(file, `${file}.before-loop-hooks`).catch(() => {});
  const tmp = `${file}.loop-tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, file);
}

async function dirExists(dir) {
  try {
    await readFile(path.join(dir, '.')); // EISDIR when present
    return true;
  } catch (err) {
    return err?.code === 'EISDIR';
  }
}

function flatHooks(data, event) {
  const groups = data?.hooks?.[event];
  return (Array.isArray(groups) ? groups : []).flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []));
}

function hasLoopHook(data, event) {
  return flatHooks(data, event).some(isLoopHook);
}

function hasTurnRecallHook(data, target) {
  if (!target.recallEvent) return false;
  const hooks = flatHooks(data, target.recallEvent);
  if (target.recallMode === 'mcp_pair') {
    return hooks.some(turnMcp) && hooks.some(turnSketchCommand);
  }
  if (target.recallMode === 'command') {
    return hooks.some(turnCommandFor(target.id));
  }
  return false;
}

function isExpectedRecallHook(hook, target) {
  if (target.recallMode === 'mcp_pair') return turnMcp(hook) || turnSketchCommand(hook);
  if (target.recallMode === 'command') return turnCommandFor(target.id)(hook);
  return false;
}

export async function agentHookStatus(opts = {}) {
  const out = [];
  for (const target of selectTargets(opts)) {
    const present = await dirExists(target.dir);
    let installed = false;
    let partlyInstalled = false;
    let turnRecall = false;
    let error = null;
    if (present) {
      try {
        const { data } = await readJson(target.file);
        const hasCurrent = target.sessionStart ? EVENTS.every(([event]) => hasLoopHook(data, event)) : true;
        turnRecall = hasTurnRecallHook(data, target);
        const promptHooks = flatHooks(data, 'UserPromptSubmit');
        const hasLegacy = promptHooks.some(
          (h) => isLoopHook(h) && !(turnRecall && target.recallEvent === 'UserPromptSubmit' && isExpectedRecallHook(h, target)),
        );
        installed = target.sessionStart ? hasCurrent && !hasLegacy : turnRecall;
        partlyInstalled = ALL_MANAGED_EVENTS.some((event) => hasLoopHook(data, event));
      } catch (err) {
        error = err.message;
      }
    }
    const skill = present && target.skillLink
      ? await skillLinkState(target.skillLink, opts.skillDir || LOOP_SKILL_DIR).catch(() => 'missing')
      : 'missing';
    out.push({
      id: target.id,
      label: target.label,
      file: target.file,
      agentInstalled: present,
      installed,
      partlyInstalled,
      turnRecall,
      recallMode: target.recallMode,
      recallEvent: target.recallEvent,
      error,
      skill,
      skillPath: target.skillLink,
    });
  }
  return out;
}

// `skillMode` (see applySkillLink) is applied to each agent whose hook file was handled
// without an error; `opts.skill === false` leaves skills alone entirely.
async function apply(opts, edit, skillMode = null) {
  const results = [];
  for (const target of selectTargets(opts)) {
    const base = { id: target.id, label: target.label, file: target.file, recallMode: target.recallMode };
    if (!(await dirExists(target.dir))) {
      results.push({ ...base, status: 'skipped', reason: `${target.label} is not installed.` });
      continue;
    }
    try {
      const { exists, data } = await readJson(target.file);
      const before = JSON.stringify(data);
      const hooks = data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks) ? { ...data.hooks } : {};
      edit(hooks, target);
      const next = { ...data, hooks };
      if (!Object.keys(hooks).length) delete next.hooks;
      const changed = JSON.stringify(next) !== before;
      if (changed) await writeJson(target.file, next, { backup: exists });
      const skill = skillMode && opts.skill !== false && target.skillLink
        ? await applySkillLink(target, skillMode, opts.skillDir || LOOP_SKILL_DIR)
        : {};
      results.push({ ...base, status: changed ? 'updated' : 'unchanged', ...skill });
    } catch (err) {
      results.push({ ...base, status: 'error', reason: err.message });
    }
  }
  return results;
}

/**
 * Adds (or refreshes) Loop's hook in each installed agent, and links the `loop` skill next to
 * it. Safe to run repeatedly. `opts.skill`: false leaves skills alone; 'repair' only fixes a
 * link that broke (what startup uses, so starting Loop never adds a new file to an agent).
 */
export function installAgentHooks(opts = {}) {
  return apply(opts, (hooks, target) => {
    const cmdOpts = { ...opts, client: target.id };
    if (target.sessionStart) {
      for (const [event, arg] of EVENTS) {
        hooks[event] = [
          ...withoutLoop(hooks[event]),
          { hooks: [{ type: 'command', command: hookCommand(arg, cmdOpts), timeout: 5 }] },
        ];
      }
    }
    const existingRecall = hasTurnRecallHook({ hooks }, target);
    const recall = opts.turnRecall ?? existingRecall;
    const eventsToClean = new Set([...LEGACY_EVENTS, ...(target.recallEvent ? [target.recallEvent] : [])]);
    for (const event of eventsToClean) {
      if (!(event in hooks)) continue;
      const kept = withoutLoop(hooks[event]);
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    }
    if (recall && target.recallEvent) {
      if (target.recallMode === 'mcp_pair') {
        (hooks[target.recallEvent] ||= []).push({
          hooks: [
            { type: 'command', command: hookCommand('turn-sketch', cmdOpts), timeout: 2 },
            {
              type: 'mcp_tool',
              server: 'loop',
              tool: TURN_TOOL,
              input: { session_id: '${session_id}', prompt_id: '${prompt_id}' },
              timeout: 2,
              onFailure: 'continue',
            },
          ],
        });
      } else if (target.recallMode === 'command') {
        const entry =
          target.id === 'gemini'
            ? { name: 'loop-turn-recall', type: 'command', command: hookCommand('turn-recall', cmdOpts), timeout: 2 }
            : { type: 'command', command: hookCommand('turn-recall', cmdOpts), timeout: 2 };
        (hooks[target.recallEvent] ||= []).push({ hooks: [entry] });
      }
    }
  }, opts.skill === 'repair' ? 'repair' : true);
}

/**
 * What Loop runs at startup. The hook is opt-in: Loop refreshes it only in agents
 * where it is already installed (by `npm run hooks -- install` or an earlier
 * version), so a fresh install never edits another tool's settings unasked.
 * `addNew` (LOOP_AGENT_HOOKS=1) also adds it, and the skill link, to every other installed agent.
 * Agents left alone come back with status 'not-enabled'.
 */
export async function refreshAgentHooks(opts = {}, { addNew = false } = {}) {
  if (addNew) return installAgentHooks(opts);
  const status = await agentHookStatus(opts);
  const enabled = status.filter((s) => s.partlyInstalled).map((s) => s.id);
  // A refresh keeps what is there working; it does not add the skill where it was never linked.
  const results = enabled.length
    ? await installAgentHooks({ ...opts, agents: enabled, skill: opts.skill === false ? false : 'repair' })
    : [];
  for (const s of status) {
    if (enabled.includes(s.id)) continue;
    const reason = s.error || (s.agentInstalled ? 'Loop hook not enabled.' : `${s.label} is not installed.`);
    const state = s.error ? 'error' : s.agentInstalled ? 'not-enabled' : 'skipped';
    results.push({ id: s.id, label: s.label, file: s.file, status: state, reason });
  }
  return results;
}

/** Removes only Loop's hook entries, and the skill link if it is Loop's. */
export function uninstallAgentHooks(opts = {}) {
  return apply(opts, (hooks) => {
    for (const event of ALL_MANAGED_EVENTS) {
      if (!(event in hooks)) continue;
      const kept = withoutLoop(hooks[event]);
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    }
  }, 'remove');
}
