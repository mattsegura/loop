// Model runners for the built-in Loop Specialist agent:
// - local Claude Code CLI (`claude -p`, full computer + temporary run-scoped Loop MCP)
// - local Codex CLI (`codex exec`, full computer + temporary run-scoped Loop MCP)
// - direct provider API keys stored encrypted in Loop Vault (in-process full Loop MCP)
// - hosted or local MausBot HTTP/SSE bridge (`POST /hooks/api/bots/<id>/messages`)

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const BUILTIN_API_PROVIDERS = Object.freeze([
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'deepseek',
]);

export const ALL_RUNNER_IDS = Object.freeze([
  'claude-cli',
  'codex-cli',
  'mausbot',
  ...BUILTIN_API_PROVIDERS,
]);

export const RUNNER_META = Object.freeze({
  'claude-cli': {
    id: 'claude-cli',
    label: 'Claude Code (local)',
    shortLabel: 'Claude Code',
    kind: 'local_cli',
    defaultModel: 'sonnet',
    models: [
      { id: 'sonnet', name: 'Sonnet (default)' },
      { id: 'opus', name: 'Opus' },
      { id: 'haiku', name: 'Haiku' },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  'codex-cli': {
    id: 'codex-cli',
    label: 'Codex CLI (local)',
    shortLabel: 'Codex',
    kind: 'local_cli',
    defaultModel: '',
    models: [
      { id: '', name: 'Codex default' },
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
      { id: 'o3', name: 'o3' },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
  mausbot: {
    id: 'mausbot',
    label: 'MausBot',
    shortLabel: 'MausBot',
    kind: 'bridge',
    defaultModel: '',
    models: [],
    efforts: [],
    defaultEffort: '',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic API',
    shortLabel: 'Anthropic',
    kind: 'api_key',
    endpoint: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-4-6',
    models: [
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    ],
    efforts: [],
    defaultEffort: '',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI API',
    shortLabel: 'OpenAI',
    kind: 'api_key',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-5.4',
    models: [
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
      { id: 'o3', name: 'o3' },
    ],
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini API',
    shortLabel: 'Gemini',
    kind: 'api_key',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    defaultModel: 'gemini-2.5-pro',
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    ],
    efforts: [],
    defaultEffort: '',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter API',
    shortLabel: 'OpenRouter',
    kind: 'api_key',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'anthropic/claude-sonnet-4.6',
    models: [
      { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
      { id: 'openai/gpt-5.4', name: 'GPT-5.4' },
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat' },
    ],
    efforts: [],
    defaultEffort: '',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek API',
    shortLabel: 'DeepSeek',
    kind: 'api_key',
    endpoint: 'https://api.deepseek.com/chat/completions',
    defaultModel: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ],
    efforts: [],
    defaultEffort: '',
  },
});

export function vaultKeyForRunner(runnerId) {
  const clean = String(runnerId || '').trim().toLowerCase();
  if (!BUILTIN_API_PROVIDERS.includes(clean) && clean !== 'mausbot') return null;
  return `__loop_agent_key_${clean}`;
}

export function normalizeMausbotEndpoint(raw, { allowLoopback = true } = {}) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (parsed.protocol === 'https:') {
    if (!allowLoopback && isLoopback) return null;
    return parsed.toString();
  }
  if (parsed.protocol === 'http:' && allowLoopback && isLoopback) {
    return parsed.toString();
  }
  return null;
}

export function findLocalBinary(name, { env = process.env, existsSyncImpl = existsSync } = {}) {
  const home = env?.HOME || os.homedir();
  const pathParts = String(env?.PATH || '')
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
  const extraDirs = [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const dirs = [...new Set([...pathParts, ...extraDirs])];
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      if (existsSyncImpl(candidate)) return candidate;
    } catch {
      // Ignore inaccessible directories.
    }
  }
  return null;
}

export function detectLocalClis({ env = process.env, existsSyncImpl = existsSync } = {}) {
  return {
    claude: findLocalBinary('claude', { env, existsSyncImpl }),
    codex: findLocalBinary('codex', { env, existsSyncImpl }),
  };
}

function safeJsonParse(raw) {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clipText(raw, max = 4000) {
  const str = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function normalizeDisplayToolName(name) {
  return String(name || '').replace(/^mcp__loop__/, '');
}

/** Extract Library item IDs created or updated by Loop MCP tool calls for clickable UI chips. */
export function extractCreatedItems(toolName, rawOutput) {
  const normalized = normalizeDisplayToolName(toolName);
  const parsed = typeof rawOutput === 'string' ? safeJsonParse(rawOutput) : rawOutput;
  if (!parsed || typeof parsed !== 'object') return [];
  const items = [];
  const seen = new Set();
  const push = (id, kind, title) => {
    const cleanId = typeof id === 'string' ? id.trim() : '';
    if (!cleanId || seen.has(cleanId)) return;
    seen.add(cleanId);
    items.push({
      id: cleanId,
      kind: kind || inferKindFromId(cleanId),
      title: String(title || cleanId).replace(/\s+/g, ' ').trim().slice(0, 100),
    });
  };
  const visit = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const entry of obj) visit(entry);
      return;
    }
    if (obj.memory?.id) push(obj.memory.id, 'memory', obj.memory.content || obj.memory.key || obj.memory.id);
    if (obj.saved?.id) push(obj.saved.id, 'saved', obj.saved.displayTitle || obj.saved.title || obj.saved.url || obj.saved.id);
    if (obj.item?.id && (obj.item.kind || obj.item.url || obj.item.title || obj.item.note)) {
      push(obj.item.id, obj.item.kind || inferKindFromId(obj.item.id), obj.item.displayTitle || obj.item.title || obj.item.content || obj.item.id);
    }
    if (obj.file?.id) push(obj.file.id, 'file', obj.file.name || obj.file.id);
    if (obj.task?.id) push(obj.task.id, 'task', obj.task.title || obj.task.id);
    if (obj.skill?.id) push(obj.skill.id, 'skill', obj.skill.name || obj.skill.id);
    if (obj.connection?.id) push(obj.connection.id, 'connection', obj.connection.name || obj.connection.id);
    if (normalized === 'loop__save' && obj.id && !obj.memory && !obj.saved && !obj.file && !obj.task) {
      push(obj.id, obj.type || obj.kind || inferKindFromId(obj.id), obj.title || obj.name || obj.content || obj.id);
    }
    if (Array.isArray(obj.results)) visit(obj.results);
    if (Array.isArray(obj.items)) visit(obj.items);
  };
  visit(parsed);
  return items;
}

function inferKindFromId(id) {
  const s = String(id || '');
  if (s.startsWith('sav_')) return 'saved';
  if (s.startsWith('file_')) return 'file';
  if (s.startsWith('task_')) return 'task';
  if (s.startsWith('mem_')) return 'memory';
  if (s.startsWith('sk_')) return 'skill';
  return 'memory';
}

export function extractApprovalFromOutput(rawOutput) {
  const parsed = typeof rawOutput === 'string' ? safeJsonParse(rawOutput) : rawOutput;
  if (!parsed || typeof parsed !== 'object') return null;
  const approvalId = parsed.approvalId || parsed.approval?.id || null;
  if (!approvalId) return null;
  return {
    id: String(approvalId),
    status: parsed.status || 'pending',
    url: parsed.approveUrl || parsed.approvalUrl || null,
    summary: parsed.message || parsed.summary || 'Approval needed.',
    guard: Boolean(parsed.guard || parsed.mode === 'guard'),
  };
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function resolveSafeCwd(cwd, existsSyncImpl = existsSync) {
  if (typeof cwd === 'string' && cwd.trim()) {
    try {
      if (existsSyncImpl(cwd.trim())) return cwd.trim();
    } catch {
      // Fall back to home directory.
    }
  }
  return os.homedir();
}

function spawnWithCleanup(spawnImpl, bin, args, options, signal) {
  const child = spawnImpl(bin, args, options);
  let killTimer = null;
  const onAbort = () => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, 2000);
    killTimer.unref?.();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const detach = () => {
    clearTimeout(killTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
  };
  return { child, detach };
}

/* -------------------------------------------------------------------------- */
/* 1. Local Claude Code CLI runner                                            */
/* -------------------------------------------------------------------------- */

export async function runClaudeCli({
  prompt,
  systemPrompt = '',
  mcpUrl,
  runToken,
  model = 'sonnet',
  effort = '',
  cwd = '',
  sessionId = '',
  signal = null,
  onEvent = () => {},
  spawnImpl = spawn,
  claudeBin = null,
  env = process.env,
} = {}) {
  const bin = claudeBin || findLocalBinary('claude', { env });
  if (!bin) {
    throw Object.assign(new Error('Local Claude Code CLI (`claude`) was not found on this computer.'), { status: 400, code: 'RUNNER_UNAVAILABLE' });
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'loop-claude-'));
  const mcpConfigPath = path.join(tmpDir, 'mcp.json');
  const mcpConfig = {
    mcpServers: {
      loop: {
        type: 'http',
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${runToken}`,
        },
      },
    },
  };
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), { mode: 0o600 });
  await chmod(mcpConfigPath, 0o600).catch(() => {});

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
    '--mcp-config', mcpConfigPath,
  ];
  if (model) args.push('--model', String(model));
  if (effort) args.push('--effort', String(effort));
  if (sessionId) args.push('--resume', String(sessionId));
  if (systemPrompt) args.push('--append-system-prompt', String(systemPrompt));

  const steps = [];
  const stepById = new Map();
  const createdItems = [];
  const createdIdsSeen = new Set();
  let nextSessionId = sessionId || '';
  let streamedText = '';
  let finalText = '';
  let stderrText = '';

  const addCreated = (list) => {
    for (const it of list) {
      if (createdIdsSeen.has(it.id)) continue;
      createdIdsSeen.add(it.id);
      createdItems.push(it);
      onEvent({ type: 'item_created', item: it });
    }
  };

  try {
    const childEnv = { ...env };
    const safeCwd = resolveSafeCwd(cwd);
    const { child, detach } = spawnWithCleanup(
      spawnImpl,
      bin,
      args,
      { cwd: safeCwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] },
      signal,
    );

    let lineBuf = '';
    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const ev = safeJsonParse(trimmed);
      if (!ev || typeof ev !== 'object') return;

      if (ev.session_id && typeof ev.session_id === 'string') {
        nextSessionId = ev.session_id;
      }

      if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
        const delta = ev.event.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
          streamedText += delta.text;
          onEvent({ type: 'delta', text: delta.text });
        }
        return;
      }

      if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block?.type === 'tool_use') {
            const callId = String(block.id || `call_${steps.length + 1}`);
            if (!stepById.has(callId)) {
              const step = {
                callId,
                tool: normalizeDisplayToolName(block.name),
                rawTool: String(block.name || ''),
                input: block.input && typeof block.input === 'object' ? block.input : {},
                startedAt: Date.now(),
                durationMs: 0,
                ok: null,
                output: '',
              };
              steps.push(step);
              stepById.set(callId, step);
              onEvent({ type: 'tool_start', step: { callId: step.callId, tool: step.tool, input: step.input } });
            }
          } else if (block?.type === 'text' && typeof block.text === 'string' && block.text && !streamedText) {
            finalText = block.text;
          }
        }
        return;
      }

      if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block?.type !== 'tool_result') continue;
          const callId = String(block.tool_use_id || '');
          const step = stepById.get(callId);
          const rawContent = Array.isArray(block.content)
            ? block.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('\n')
            : typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content ?? '');
          const ok = block.is_error !== true;
          const items = extractCreatedItems(step?.tool || '', rawContent);
          addCreated(items);
          const approval = extractApprovalFromOutput(rawContent);
          if (approval) onEvent({ type: 'approval', approval });
          if (step) {
            step.ok = ok;
            step.durationMs = Math.max(0, Date.now() - step.startedAt);
            step.output = clipText(rawContent, 3000);
            onEvent({
              type: 'tool_end',
              step: { callId: step.callId, tool: step.tool, ok, durationMs: step.durationMs, output: clipText(rawContent, 800) },
            });
          }
        }
        return;
      }

      if (ev.type === 'result') {
        if (typeof ev.result === 'string' && ev.result) {
          finalText = ev.result;
          if (!streamedText) {
            streamedText = ev.result;
            onEvent({ type: 'delta', text: ev.result });
          }
        }
        if (ev.is_error) {
          const msg = typeof ev.result === 'string' && ev.result ? ev.result : 'Claude CLI returned an error.';
          stderrText = stderrText ? `${stderrText}\n${msg}` : msg;
        }
      }
    };

    const exitCode = await new Promise((resolve, reject) => {
      child.stdout?.on('data', (chunk) => {
        lineBuf += chunk.toString('utf8');
        let idx;
        while ((idx = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, idx);
          lineBuf = lineBuf.slice(idx + 1);
          handleLine(line);
        }
      });
      child.stderr?.on('data', (chunk) => {
        stderrText += chunk.toString('utf8');
        if (stderrText.length > 8000) stderrText = stderrText.slice(-8000);
      });
      child.on('error', (err) => {
        detach();
        reject(err);
      });
      child.on('close', (code) => {
        if (lineBuf.trim()) handleLine(lineBuf);
        detach();
        resolve(code ?? 0);
      });
      child.stdin?.end(String(prompt || ''));
    });

    if (signal?.aborted) {
      throw Object.assign(new Error('Run stopped.'), { code: 'ABORTED', status: 499 });
    }
    const text = (finalText || streamedText).trim();
    if (exitCode !== 0 && !text) {
      throw Object.assign(new Error(clipText(stderrText.trim() || `Claude exited with code ${exitCode}.`, 400)), { status: 502 });
    }

    return {
      text: text || 'Done.',
      sessionId: nextSessionId,
      steps,
      createdItems,
      model: model || 'sonnet',
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* 2. Local Codex CLI runner                                                  */
/* -------------------------------------------------------------------------- */

export async function runCodexCli({
  prompt,
  systemPrompt = '',
  mcpUrl,
  runToken,
  model = '',
  effort = '',
  cwd = '',
  sessionId = '',
  signal = null,
  onEvent = () => {},
  spawnImpl = spawn,
  codexBin = null,
  env = process.env,
} = {}) {
  const bin = codexBin || findLocalBinary('codex', { env });
  if (!bin) {
    throw Object.assign(new Error('Local Codex CLI (`codex`) was not found on this computer.'), { status: 400, code: 'RUNNER_UNAVAILABLE' });
  }

  const safeCwd = resolveSafeCwd(cwd);
  const args = ['exec'];
  if (sessionId) {
    args.push('resume', String(sessionId));
  }
  args.push(
    '--dangerously-bypass-approvals-and-sandbox',
    '--json',
    '--skip-git-repo-check',
    '-c', `mcp_servers.loop.url=${tomlString(mcpUrl)}`,
    '-c', 'mcp_servers.loop.bearer_token_env_var="LOOP_RUN_TOKEN"',
    '-c', 'mcp_servers.loop.enabled=true',
  );
  if (!sessionId) {
    args.push('-C', safeCwd);
  }
  if (model) args.push('-m', String(model));
  if (effort) args.push('-c', `model_reasoning_effort=${tomlString(effort)}`);
  if (systemPrompt && !sessionId) {
    args.push('-c', `developer_instructions=${tomlString(systemPrompt)}`);
  }
  args.push('-');

  const steps = [];
  const stepById = new Map();
  const createdItems = [];
  const createdIdsSeen = new Set();
  let nextSessionId = sessionId || '';
  let lastAgentText = '';
  let stderrText = '';

  const addCreated = (list) => {
    for (const it of list) {
      if (createdIdsSeen.has(it.id)) continue;
      createdIdsSeen.add(it.id);
      createdItems.push(it);
      onEvent({ type: 'item_created', item: it });
    }
  };

  const childEnv = { ...env, LOOP_RUN_TOKEN: String(runToken || '') };
  const { child, detach } = spawnWithCleanup(
    spawnImpl,
    bin,
    args,
    { cwd: safeCwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] },
    signal,
  );

  let lineBuf = '';
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const ev = safeJsonParse(trimmed);
    if (!ev || typeof ev !== 'object') return;

    if (ev.type === 'thread.started' && ev.thread_id) {
      nextSessionId = String(ev.thread_id);
      return;
    }

    const item = ev.item && typeof ev.item === 'object' ? ev.item : null;
    if (ev.type === 'item.started' && item) {
      if (item.type === 'mcp_tool_call' || item.type === 'command_execution') {
        const callId = String(item.id || `call_${steps.length + 1}`);
        const tool = item.type === 'mcp_tool_call'
          ? normalizeDisplayToolName(item.tool || item.name || 'mcp_tool')
          : 'command';
        const input = item.type === 'mcp_tool_call'
          ? (item.arguments && typeof item.arguments === 'object' ? item.arguments : {})
          : { command: item.command || '' };
        const step = { callId, tool, input, startedAt: Date.now(), durationMs: 0, ok: null, output: '' };
        steps.push(step);
        stepById.set(callId, step);
        onEvent({ type: 'tool_start', step: { callId, tool, input } });
      }
      return;
    }

    if (ev.type === 'item.completed' && item) {
      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text) {
        const prev = lastAgentText;
        lastAgentText = item.text;
        const delta = prev && item.text.startsWith(prev) ? item.text.slice(prev.length) : (prev ? `\n\n${item.text}` : item.text);
        if (delta) onEvent({ type: 'delta', text: delta });
      } else if (item.type === 'mcp_tool_call' || item.type === 'command_execution') {
        const callId = String(item.id || '');
        const step = stepById.get(callId) || {
          callId: callId || `call_${steps.length + 1}`,
          tool: item.type === 'mcp_tool_call' ? normalizeDisplayToolName(item.tool || item.name || 'mcp_tool') : 'command',
          input: item.arguments || { command: item.command || '' },
          startedAt: Date.now(),
        };
        if (!stepById.has(step.callId)) {
          steps.push(step);
          stepById.set(step.callId, step);
        }
        const ok = item.status !== 'failed' && !item.error && (item.exit_code === undefined || item.exit_code === 0);
        const rawOut = item.type === 'mcp_tool_call'
          ? (typeof item.result === 'string' ? item.result : JSON.stringify(item.result?.content?.[0]?.text || item.result || item.error || ''))
          : String(item.aggregated_output || item.output || '');
        const unwrapped = safeJsonParse(rawOut);
        const textOut = typeof unwrapped === 'string' ? unwrapped : rawOut;
        addCreated(extractCreatedItems(step.tool, textOut));
        const approval = extractApprovalFromOutput(textOut);
        if (approval) onEvent({ type: 'approval', approval });
        step.ok = ok;
        step.durationMs = Math.max(0, Date.now() - step.startedAt);
        step.output = clipText(textOut, 3000);
        onEvent({
          type: 'tool_end',
          step: { callId: step.callId, tool: step.tool, ok, durationMs: step.durationMs, output: clipText(textOut, 800) },
        });
      }
      return;
    }

    if ((ev.type === 'error' || ev.type === 'turn.failed') && (ev.message || ev.error?.message)) {
      const msg = String(ev.message || ev.error?.message);
      stderrText = stderrText ? `${stderrText}\n${msg}` : msg;
    }
  };

  const exitCode = await new Promise((resolve, reject) => {
    child.stdout?.on('data', (chunk) => {
      lineBuf += chunk.toString('utf8');
      let idx;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        handleLine(line);
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderrText += chunk.toString('utf8');
      if (stderrText.length > 8000) stderrText = stderrText.slice(-8000);
    });
    child.on('error', (err) => {
      detach();
      reject(err);
    });
    child.on('close', (code) => {
      if (lineBuf.trim()) handleLine(lineBuf);
      detach();
      resolve(code ?? 0);
    });
    child.stdin?.end(String(prompt || ''));
  });

  if (signal?.aborted) {
    throw Object.assign(new Error('Run stopped.'), { code: 'ABORTED', status: 499 });
  }
  const text = lastAgentText.trim();
  if (exitCode !== 0 && !text) {
    throw Object.assign(new Error(clipText(stderrText.trim() || `Codex exited with code ${exitCode}.`, 400)), { status: 502 });
  }

  return {
    text: text || 'Done.',
    sessionId: nextSessionId,
    steps,
    createdItems,
    model: model || 'codex-default',
  };
}

/* -------------------------------------------------------------------------- */
/* 3. Direct Vault API-key runners (Anthropic + OpenAI-compatible loop)       */
/* -------------------------------------------------------------------------- */

async function* parseSseStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split(/\r?\n\r?\n/);
      buf = frames.pop() || '';
      for (const frame of frames) {
        let event = 'message';
        const dataLines = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length > 0) {
          yield { event, data: dataLines.join('\n') };
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

async function runAnthropicTurn({ apiKey, model, systemPrompt, tools, messages, signal, onDelta, fetchImpl }) {
  const res = await fetchImpl(RUNNER_META.anthropic.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      stream: true,
      system: systemPrompt,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description || '',
        input_schema: t.inputSchema || { type: 'object', properties: {} },
      })),
      messages,
    }),
    signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw Object.assign(new Error(clipText(`Anthropic API HTTP ${res.status}: ${errText}`, 400)), { status: res.status === 401 ? 401 : 502 });
  }

  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('text/event-stream')) {
    const data = await res.json();
    const blocks = Array.isArray(data.content) ? data.content : [];
    let text = '';
    const toolCalls = [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text) {
        text += b.text;
        onDelta(b.text);
      } else if (b.type === 'tool_use') {
        toolCalls.push({ id: b.id, name: b.name, input: b.input || {} });
      }
    }
    return { text, toolCalls, assistantMessage: { role: 'assistant', content: blocks } };
  }

  const blocks = [];
  let text = '';
  for await (const frame of parseSseStream(res.body)) {
    const payload = safeJsonParse(frame.data);
    if (!payload) continue;
    if (payload.type === 'content_block_start') {
      const idx = payload.index ?? blocks.length;
      const b = payload.content_block;
      if (b?.type === 'text') blocks[idx] = { type: 'text', text: b.text || '' };
      else if (b?.type === 'tool_use') blocks[idx] = { type: 'tool_use', id: b.id, name: b.name, inputJson: '' };
    } else if (payload.type === 'content_block_delta') {
      const idx = payload.index ?? blocks.length - 1;
      const b = blocks[idx];
      if (payload.delta?.type === 'text_delta' && b?.type === 'text') {
        b.text += payload.delta.text || '';
        text += payload.delta.text || '';
        onDelta(payload.delta.text || '');
      } else if (payload.delta?.type === 'input_json_delta' && b?.type === 'tool_use') {
        b.inputJson += payload.delta.partial_json || '';
      }
    }
  }

  const finalBlocks = [];
  const toolCalls = [];
  for (const b of blocks.filter(Boolean)) {
    if (b.type === 'text') {
      finalBlocks.push({ type: 'text', text: b.text });
    } else if (b.type === 'tool_use') {
      const input = safeJsonParse(b.inputJson || '{}') || {};
      finalBlocks.push({ type: 'tool_use', id: b.id, name: b.name, input });
      toolCalls.push({ id: b.id, name: b.name, input });
    }
  }
  return { text, toolCalls, assistantMessage: { role: 'assistant', content: finalBlocks } };
}

async function runOpenAiCompatTurn({ provider, apiKey, model, systemPrompt, tools, messages, signal, onDelta, fetchImpl }) {
  const endpoint = RUNNER_META[provider]?.endpoint;
  if (!endpoint) throw Object.assign(new Error(`Unknown API provider: ${provider}`), { status: 400 });

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://useloop.sh';
    headers['X-Title'] = 'Loop';
  }

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages,
      ],
      tools: tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.inputSchema || { type: 'object', properties: {} },
        },
      })),
    }),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw Object.assign(new Error(clipText(`${RUNNER_META[provider].label} HTTP ${res.status}: ${errText}`, 400)), { status: res.status === 401 ? 401 : 502 });
  }

  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('text/event-stream')) {
    const data = await res.json();
    const msg = data?.choices?.[0]?.message || {};
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (text) onDelta(text);
    const toolCalls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).map((tc, i) => ({
      id: tc.id || `call_${i + 1}`,
      name: tc.function?.name || '',
      input: safeJsonParse(tc.function?.arguments || '{}') || {},
    }));
    const assistantMessage = {
      role: 'assistant',
      content: text || null,
      ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: msg.tool_calls } : {}),
    };
    return { text, toolCalls, assistantMessage };
  }

  let text = '';
  let reasoning = '';
  const callsByIdx = new Map();
  for await (const frame of parseSseStream(res.body)) {
    if (frame.data === '[DONE]') break;
    const payload = safeJsonParse(frame.data);
    const delta = payload?.choices?.[0]?.delta;
    if (!delta) continue;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      onDelta(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let entry = callsByIdx.get(idx);
        if (!entry) {
          entry = { id: tc.id || `call_${idx + 1}`, name: '', arguments: '' };
          callsByIdx.set(idx, entry);
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.arguments += tc.function.arguments;
      }
    }
  }

  const orderedCalls = [...callsByIdx.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  const toolCalls = orderedCalls.map((c) => ({
    id: c.id,
    name: c.name,
    input: safeJsonParse(c.arguments || '{}') || {},
  }));
  const assistantMessage = {
    role: 'assistant',
    content: text || null,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(orderedCalls.length > 0
      ? {
          tool_calls: orderedCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments || '{}' },
          })),
        }
      : {}),
  };
  return { text, toolCalls, assistantMessage };
}

export async function runApiAgentLoop({
  provider,
  apiKey,
  model = '',
  systemPrompt = '',
  history = [],
  prompt,
  listMcpTools,
  callMcpTool,
  maxTurns = 16,
  signal = null,
  onEvent = () => {},
  fetchImpl = fetch,
} = {}) {
  const meta = RUNNER_META[provider];
  if (!meta || meta.kind !== 'api_key') {
    throw Object.assign(new Error(`Unsupported API provider "${provider}".`), { status: 400 });
  }
  if (!apiKey) {
    throw Object.assign(new Error(`Connect an API key for ${meta.label} in Loop first.`), { status: 400, code: 'MISSING_API_KEY' });
  }
  const chosenModel = model || meta.defaultModel;
  const tools = await listMcpTools();
  const isAnthropic = provider === 'anthropic';

  const messages = [];
  for (const h of Array.isArray(history) ? history.slice(-16) : []) {
    if ((h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string' && h.text.trim()) {
      messages.push({ role: h.role, content: h.text });
    }
  }
  messages.push({ role: 'user', content: String(prompt || '') });

  const steps = [];
  const createdItems = [];
  const createdIdsSeen = new Set();
  const replyParts = [];

  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (signal?.aborted) throw Object.assign(new Error('Run stopped.'), { code: 'ABORTED', status: 499 });

    const onDelta = (chunk) => {
      if (chunk) onEvent({ type: 'delta', text: chunk });
    };
    const turnResult = isAnthropic
      ? await runAnthropicTurn({ apiKey, model: chosenModel, systemPrompt, tools, messages, signal, onDelta, fetchImpl })
      : await runOpenAiCompatTurn({ provider, apiKey, model: chosenModel, systemPrompt, tools, messages, signal, onDelta, fetchImpl });

    if (turnResult.text) replyParts.push(turnResult.text);
    messages.push(turnResult.assistantMessage);

    if (!turnResult.toolCalls.length) break;

    const anthropicResults = [];
    for (const tc of turnResult.toolCalls) {
      if (signal?.aborted) throw Object.assign(new Error('Run stopped.'), { code: 'ABORTED', status: 499 });
      const startedAt = Date.now();
      const step = {
        callId: tc.id,
        tool: tc.name,
        input: tc.input || {},
        startedAt,
        durationMs: 0,
        ok: null,
        output: '',
      };
      steps.push(step);
      onEvent({ type: 'tool_start', step: { callId: step.callId, tool: step.tool, input: step.input } });

      let outcome;
      try {
        outcome = await callMcpTool(tc.name, tc.input || {});
      } catch (err) {
        outcome = { ok: false, text: err?.message || 'Tool call failed.' };
      }

      const rawText = typeof outcome?.text === 'string' ? outcome.text : JSON.stringify(outcome ?? '');
      step.ok = outcome?.ok !== false;
      step.durationMs = Math.max(0, Date.now() - startedAt);
      step.output = clipText(rawText, 3000);

      for (const it of extractCreatedItems(step.tool, rawText)) {
        if (createdIdsSeen.has(it.id)) continue;
        createdIdsSeen.add(it.id);
        createdItems.push(it);
        onEvent({ type: 'item_created', item: it });
      }
      const approval = extractApprovalFromOutput(rawText);
      if (approval) onEvent({ type: 'approval', approval });

      onEvent({
        type: 'tool_end',
        step: { callId: step.callId, tool: step.tool, ok: step.ok, durationMs: step.durationMs, output: clipText(rawText, 800) },
      });

      if (isAnthropic) {
        anthropicResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: clipText(rawText, 24000),
          ...(step.ok ? {} : { is_error: true }),
        });
      } else {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: clipText(rawText, 24000),
        });
      }
    }

    if (isAnthropic) {
      messages.push({ role: 'user', content: anthropicResults });
    }
  }

  return {
    text: replyParts.join('\n\n').trim() || 'Done.',
    sessionId: '',
    steps,
    createdItems,
    model: chosenModel,
  };
}

/* -------------------------------------------------------------------------- */
/* 4. MausBot HTTP / SSE Bridge Runner                                        */
/* -------------------------------------------------------------------------- */

function pickMausbotText(obj) {
  if (typeof obj === 'string') return obj;
  if (!obj || typeof obj !== 'object') return '';
  for (const key of ['reply', 'response', 'text', 'message', 'content', 'output']) {
    if (typeof obj[key] === 'string' && obj[key]) return obj[key];
  }
  if (obj.data && typeof obj.data === 'object') {
    const nested = pickMausbotText(obj.data);
    if (nested) return nested;
  }
  const choice = obj.choices?.[0]?.message?.content || obj.choices?.[0]?.delta?.content;
  if (typeof choice === 'string' && choice) return choice;
  return '';
}

export async function runMausbot({
  endpoint,
  apiKey = '',
  message,
  signal = null,
  onEvent = () => {},
  fetchImpl = fetch,
} = {}) {
  if (!endpoint) {
    throw Object.assign(new Error('Configure a MausBot endpoint URL first.'), { status: 400, code: 'MAUSBOT_UNCONFIGURED' });
  }
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json, text/plain',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: String(message || '') }),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw Object.assign(new Error(clipText(`MausBot returned HTTP ${res.status}: ${errText}`, 400)), { status: res.status === 401 ? 401 : 502 });
  }

  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  const steps = [];
  const createdItems = [];

  if (contentType.includes('text/event-stream') && res.body) {
    let text = '';
    for await (const frame of parseSseStream(res.body)) {
      if (frame.data === '[DONE]') break;
      const parsed = safeJsonParse(frame.data);
      const chunk = parsed
        ? (typeof parsed.delta === 'string' ? parsed.delta : pickMausbotText(parsed))
        : frame.data;
      if (chunk) {
        text += chunk;
        onEvent({ type: 'delta', text: chunk });
      }
    }
    return { text: text.trim() || 'Done.', sessionId: '', steps, createdItems, model: 'mausbot' };
  }

  const rawBody = await res.text();
  const parsed = safeJsonParse(rawBody);
  const text = (parsed ? pickMausbotText(parsed) : rawBody).trim();
  if (text) onEvent({ type: 'delta', text });

  return {
    text: text || 'Done.',
    sessionId: typeof parsed?.sessionId === 'string' ? parsed.sessionId : '',
    steps,
    createdItems,
    model: typeof parsed?.model === 'string' ? parsed.model : 'mausbot',
  };
}
