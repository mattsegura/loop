#!/usr/bin/env node
// Inspect built-in Loop Specialist run traces and user-flagged prompts.
// Usage:
//   npm run traces
//   npm run traces -- --flagged
//   npm run traces -- show <runId>
//   npm run traces -- --json

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LoopAgentStore } from '../lib/loop-agent-store.mjs';
import { defaultDataDir } from '../lib/vault.mjs';

const HELP = `Loop Specialist run traces: inspect prompts, MCP tool calls, and flagged outputs.

  npm run traces                      list recent runs
  npm run traces -- --flagged         list only flagged runs
  npm run traces -- show <runId>      show full prompt, context, tool calls, and reply

Options: --data <folder>  --limit <n>  --flagged  --json`;

const WITH_VALUE = new Set(['data', 'limit', 'thread']);

export function parseTraceArgs(argv) {
  const opts = {};
  const words = [];
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) words.push(argv[i]);
    else if (WITH_VALUE.has(m[1])) opts[m[1]] = m[2] ?? argv[(i += 1)] ?? '';
    else opts[m[1]] = true;
  }
  return { command: words[0] || 'list', target: words[1] || '', opts };
}

function clip(raw, max) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function formatRunRow(r) {
  const badge = r.flagged ? '[FLAGGED] ' : '';
  const meta = [
    r.id,
    r.status,
    r.runner + (r.model ? `/${r.model}` : ''),
    r.promptVersion || 'unknown-prompt',
    `${(r.steps || []).length} tool(s)`,
    `${Math.round((r.durationMs || 0) / 100) / 10}s`,
    String(r.createdAt || '').slice(0, 19).replace('T', ' '),
  ].join(' · ');
  const lines = [
    `${badge}${meta}`,
    `  prompt: ${clip(r.userMessage, 140)}`,
  ];
  if (r.flagged && r.flagNote) lines.push(`  flag note: ${r.flagNote}`);
  if (r.error) lines.push(`  error: ${clip(r.error, 140)}`);
  return lines.join('\n');
}

function formatRunDetail(r) {
  const lines = [
    `Run: ${r.id}`,
    `Thread: ${r.threadId}`,
    `Status: ${r.status}${r.flagged ? ' [FLAGGED]' : ''}`,
    `Runner: ${r.runner}${r.model ? ` (${r.model})` : ''}`,
    `Prompt version: ${r.promptVersion || 'unknown'}`,
    `Project: ${r.project || 'all'}${r.focusedNodeId ? ` · Focused node: ${r.focusedNodeId}` : ''}`,
    `Duration: ${r.durationMs} ms`,
    `Created: ${r.createdAt}`,
  ];
  if (r.flagged) {
    lines.push(`Flagged at: ${r.flaggedAt || 'unknown'}`);
    if (r.flagNote) lines.push(`Flag note: ${r.flagNote}`);
  }
  lines.push('', '--- User prompt ---', r.userMessage || '(empty)');
  if (r.context && Object.keys(r.context).length > 0) {
    lines.push('', '--- Context ---', JSON.stringify(r.context, null, 2));
  }
  if (Array.isArray(r.steps) && r.steps.length > 0) {
    lines.push('', `--- Tool steps (${r.steps.length}) ---`);
    r.steps.forEach((s, i) => {
      lines.push(
        `[${i + 1}] ${s.tool} (${s.ok === false ? 'ERROR' : 'ok'}, ${s.durationMs || 0} ms)`,
        `    input: ${JSON.stringify(s.input || {})}`,
        `    output: ${clip(s.output || '', 500)}`,
      );
    });
  }
  if (Array.isArray(r.createdItems) && r.createdItems.length > 0) {
    lines.push('', '--- Created / updated Library items ---');
    for (const item of r.createdItems) {
      lines.push(`- [${item.kind}] ${item.id}: ${item.title}`);
    }
  }
  if (r.error) lines.push('', '--- Error ---', r.error);
  lines.push('', '--- Assistant reply ---', r.assistantReply || '(empty)');
  return lines.join('\n');
}

export function runTraceCli(argv = process.argv.slice(2), { log = console.log } = {}) {
  const { command, target, opts } = parseTraceArgs(argv);
  if (command === 'help' || opts.help) {
    log(HELP);
    return 0;
  }
  const dataDir = path.resolve(opts.data || process.env.LOOP_HUB_DATA || defaultDataDir());
  const store = new LoopAgentStore(dataDir);

  if (command === 'show') {
    if (!target) {
      log('Provide a run ID: npm run traces -- show <runId>');
      return 1;
    }
    const run = store.getTrace(target);
    if (!run) {
      log(`Run "${target}" not found in ${store.dbFile}.`);
      return 1;
    }
    log(opts.json ? JSON.stringify(run, null, 2) : formatRunDetail(run));
    return 0;
  }

  const runs = store.listTraces({
    flaggedOnly: Boolean(opts.flagged),
    threadId: opts.thread || '',
    limit: Number(opts.limit) || 25,
  });
  if (opts.json) {
    log(JSON.stringify({ dbFile: store.dbFile, runs }, null, 2));
    return 0;
  }
  if (runs.length === 0) {
    log(opts.flagged ? `No flagged runs in ${store.dbFile}.` : `No specialist runs recorded yet in ${store.dbFile}.`);
    return 0;
  }
  log(`Loop Specialist traces in ${store.dbFile} (${runs.length}):\n`);
  log(runs.map(formatRunRow).join('\n\n'));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = runTraceCli();
}
