#!/usr/bin/env node
// Stateless SessionStart hook for Claude Code and Codex. Tells the agent the order to use:
// its own built-in tools first, then Loop when they fall short (or at once when the user asks
// for Loop), and points to the `loop` skill for all scenario-based workflows.
//
//   loop-hook.mjs session-start [--client <id>]   on every session start
//
// Standalone and stateless on purpose: no config.json reads, no network calls, no secrets,
// and no connection names. Works identically for Local Loop, Hosted Cloud, and any profile;
// scoping stays strictly on the Loop MCP server. Any failure exits 0 with no output so a
// hook can never block or slow the agent.

import { pathToFileURL } from 'node:url';

// The order every startup channel gives: the agent's own built-ins, then Loop.
export const ORDER_RULE =
  '(1) If the user asks for Loop, use Loop. ' +
  '(2) Otherwise use your own built-in tools first when they can do the task (for example web search, web fetch, files, the browser). ' +
  '(3) When they cannot (a service, account, live data or workflow you do not have), check Loop with `loop__search`, and follow the `nextStep` in its answer, before you tell the user it cannot be done.';

// How to connect this agent to Loop when its Loop tools are missing from a session.
export const CONNECT_HELP = Object.freeze({
  'claude-code': 'run /mcp, pick loop, then Authenticate',
  codex: 'run `codex mcp login loop`',
  muse: 'run `muse mcp login loop`',
});

export function sessionStartContext({ client = '' } = {}) {
  const connectHelp =
    CONNECT_HELP[String(client || '')] || "sign in to Loop from this app's own connection settings";
  return [
    "Loop is this user's shared hub for connected accounts, external services, Skills, Memory, Tasks, and Vault.",
    `Order for any task: ${ORDER_RULE}`,
    'Follow the `loop` skill for query patterns, workflows, sign-in, and approvals.',
    'For "what do I have connected?", answer from `loop__search({ type: "connections" })`.',
    "Use another plugin's connections or CLI only when the user names that plugin or Loop has no matching Connection, and keep its results separate from Loop's.",
    'Loop is the place that every agent of this user shares. When the user says to remember, save for later, keep a key safe, or stop using a service (turn its connection off), do it in Loop (`loop__save`), not only in your own notes or files.',
    'Check `loop__search({ type: "tasks", assignedTo: "me" })` when picking up work handed off from another agent (such as Loop Text), and mark the task `completed` with a concise `result` when finished.',
    `Your app can defer Loop's tools: first load \`loop__search\`, \`loop__run\` and \`loop__save\` with your tool search. Only if it cannot find \`loop__search\` is Loop not connected in this session: then tell the user in one line to ${connectHelp}, and do not look for keys or call Loop's address yourself.`,
  ].join(' ');
}

function emit(hookEventName, additionalContext) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }) + '\n');
}

function parseFlag(argv, name) {
  const prefix = `${name}=`;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith(prefix)) return argv[i].slice(prefix.length);
  }
  return '';
}

export async function main(argv = process.argv.slice(2)) {
  const event = argv[0];
  const client = parseFlag(argv, '--client');
  if (event === 'session-start') {
    emit('SessionStart', sessionStartContext({ client }));
  }
  if (event === 'turn-sketch' && client === 'claude-code') {
    let size = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 65536) return;
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const { offerTurn } = await import('../lib/turn-recall.mjs');
    await offerTurn(input);
  }
  if (event === 'turn-recall' && client) {
    let size = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 65536) return;
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString().trim();
    if (!raw) return;
    const input = JSON.parse(raw);
    const dataDir = parseFlag(argv, '--data-dir') || undefined;
    const { requestCommandTurnRecall } = await import('../lib/turn-recall.mjs');
    const result = await requestCommandTurnRecall(input, { client, ...(dataDir ? { dataDir } : {}) });
    if (result?.hookSpecificOutput) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  }
  // Legacy `prompt` calls (and any unknown event) exit quietly with no output.
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch {
    // Never fail the agent's turn.
  }
  process.exit(0);
}
