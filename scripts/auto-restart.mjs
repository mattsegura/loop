#!/usr/bin/env node
// Keeps the running Loop on the newest code. When server.mjs, anything under lib/, or the
// package files change, it waits for edits to settle, makes sure the new code loads, and then
// restarts Loop (scripts/restart-loop.sh --when-idle, so running agent calls finish first). Saves
// that leave the code as Loop runs it, and the temporary files of editors, do not restart it. If
// the new code does not load, Loop keeps running the last good version and the reason goes to the
// log. Files under public/, hooks/ and skills/ are already live without a restart, so they are not
// watched.
//
// Runs as the launchd agent local.loop-autoreload. Logs: ~/Library/Logs/loop-gateway/autoreload.log

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUIET_MS = Number(process.env.LOOP_RELOAD_QUIET_MS) || 4000;
// Every restart drops the agents' connections, and launchd holds back a program that stops within
// 10 s of its start, so several edits in a row share one restart.
const MIN_GAP_MS = Number(process.env.LOOP_RELOAD_MIN_GAP_MS) || 30_000;
const ROOT_FILES = new Set(['server.mjs', 'package.json', 'package-lock.json']);
const CODE_RE = /\.(mjs|cjs|js|json)$/;
const isCode = (name) => CODE_RE.test(name) && !path.basename(name).startsWith('.');
const libDir = path.join(root, 'lib');

const changed = new Set();
let timer = null;
let busy = false;
let again = false;
let lastRestart = 0;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(reload, Math.max(QUIET_MS, lastRestart + MIN_GAP_MS - Date.now()));
}

function queue(file) {
  changed.add(path.relative(root, file));
  schedule();
}

function codeHash() {
  const files = [...ROOT_FILES].map((name) => path.join(root, name));
  if (existsSync(libDir)) {
    for (const name of readdirSync(libDir, { recursive: true })) {
      if (isCode(name)) files.push(path.join(libDir, name));
    }
  }
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    try {
      hash.update(`${path.relative(root, file)}\0`).update(readFileSync(file));
    } catch {
      // Removed while it was read: the watcher reports it again.
    }
  }
  return hash.digest('hex');
}
let running = codeHash();

// Loads server.mjs and everything it imports without starting a server (server.mjs starts only
// when it is the main script). This finds syntax errors and broken imports before a restart.
function newCodeLoads() {
  const url = pathToFileURL(path.join(root, 'server.mjs')).href;
  const res = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(url)}); process.exit(0);`],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, LOOP_NO_AGENT_HOOKS: '1', LOOP_EMBEDDING_PROVIDER: 'off' },
    },
  );
  if (res.status === 0) return { ok: true };
  const detail = (res.stderr || res.stdout || res.error?.message || 'unknown error').trim().split('\n').slice(0, 6).join('\n');
  return { ok: false, detail };
}

function reload() {
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  const files = [...changed];
  changed.clear();
  try {
    const next = codeHash();
    if (next === running) return;
    const check = newCodeLoads();
    if (!check.ok) {
      log(`Not restarted: the new code does not load. Loop keeps running the last good version.\n  Changed: ${files.join(', ')}\n${check.detail}`);
      return;
    }
    const res = spawnSync('sh', [path.join(root, 'scripts', 'restart-loop.sh'), '--when-idle'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
    });
    lastRestart = Date.now();
    if (res.status === 0) running = next;
    const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
    log(`${res.status === 0 ? 'Restarted' : 'Restart failed'} after changes to ${files.join(', ')}${out ? `\n  ${out}` : ''}`);
  } finally {
    busy = false;
    if (again) {
      again = false;
      schedule();
    }
  }
}

// Watch folders, not single files: editors and git replace a file on save, which ends a
// watch on the old file.
watch(root, (_event, name) => {
  if (name && ROOT_FILES.has(String(name))) queue(path.join(root, String(name)));
});
if (existsSync(libDir)) {
  watch(libDir, { recursive: true }, (_event, name) => {
    if (name && isCode(String(name))) queue(path.join(libDir, String(name)));
  });
}
log(`Watching ${root} (server.mjs, lib/, package files). Loop restarts ${QUIET_MS} ms after the last change, at most once every ${MIN_GAP_MS} ms.`);
