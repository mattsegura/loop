#!/usr/bin/env node
// Runs a real agent (Claude Code) against a throwaway Loop, one case at a time, and checks what it did.
// Cases are eval/feedback/cases/*.json: some test the feedback tool itself, the others came from
// feedback (`npm run feedback -- eval <issue>`). Format: eval/feedback/README.md.
//
//   npm run eval:feedback -- [--case <id>] [--model sonnet,haiku] [--runs 1] [--json] [--keep]
//
// The Loop, its data and its connections are temporary and on this computer. The agent gets only the
// Loop tools: no shell, files, web, settings, hooks or other MCP servers.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { FAULT_HINT } from '../lib/feedback.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES = path.join(ROOT, 'eval', 'feedback', 'cases');
const HOME = os.homedir();

// The throwaway Loop uses no key, model or file of this computer's own Loop.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('LOOP_') || /TYPESAFE/.test(key)) delete process.env[key];
}
Object.assign(process.env, { LOOP_EMBEDDING_PROVIDER: 'off', LOOP_NO_AGENT_HOOKS: '1', LOOP_SEED_BUILTINS: '0' });

const body = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
};
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer((req, res) => handler(req, res).catch(() => { if (!res.headersSent) res.writeHead(502); res.end(); }));
  server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) }));
});
const json = (res, value) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };

// The services of a case: each tool gives its `result`, or fails with its `error`.
function services(connections, ran) {
  return listen(async (req, res) => {
    const conn = connections.find((c) => req.url === `/${encodeURIComponent(c.name)}/mcp`);
    if (!conn || req.method !== 'POST') { res.writeHead(conn ? 405 : 404); return res.end(); }
    const msg = JSON.parse((await body(req)).toString() || '{}');
    if (msg.id === undefined) { res.writeHead(202); return res.end(); }
    const answer = (result) => json(res, { jsonrpc: '2.0', id: msg.id, result });
    if (msg.method === 'initialize') return answer({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: conn.name, version: '1.0.0' } });
    if (msg.method === 'tools/list') {
      return answer({ tools: conn.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: inputSchema || { type: 'object', properties: {} } })) });
    }
    if (msg.method !== 'tools/call') return answer({ resources: [], prompts: [] });
    const tool = conn.tools.find((t) => t.name === msg.params?.name);
    ran.push(`${conn.name}/${msg.params?.name}`);
    return answer({ content: [{ type: 'text', text: tool?.error || tool?.result || 'ok' }], isError: Boolean(tool?.error) });
  });
}

// Between the agent and Loop: it records the calls, and answers with the fault of the case.
function recorder(loopPort, fault, calls) {
  return listen(async (req, res) => {
    const data = await body(req);
    let msg = null;
    try { msg = JSON.parse(data.toString()); } catch { /* not JSON */ }
    if (msg?.method === 'tools/call') {
      const call = { name: msg.params?.name, arguments: msg.params?.arguments || {} };
      calls.push(call);
      if (fault && call.name === fault.tool) {
        call.result = fault.internal ? `${fault.error}\n${FAULT_HINT}` : fault.error;
        return json(res, { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: call.result }] } });
      }
    }
    const headers = { ...req.headers, host: `127.0.0.1:${loopPort}` };
    const up = await fetch(`http://127.0.0.1:${loopPort}${req.url}`, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(headers).filter(([k]) => !['connection', 'content-length', 'transfer-encoding'].includes(k))),
      ...(data.length ? { body: data } : {}),
    });
    const out = Buffer.from(await up.arrayBuffer());
    const text = out.toString();
    if (msg?.method === 'tools/call') calls.at(-1).result = text.slice(0, 4000);
    res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json', ...(up.headers.get('mcp-session-id') ? { 'Mcp-Session-Id': up.headers.get('mcp-session-id') } : {}) });
    return res.end(out);
  });
}

// One conversation: each prompt is the next message of the user. `afterTurn` sees each answer.
async function runClaude({ url, dir, prompts, model, afterTurn, timeoutMs = 240_000 }) {
  const config = path.join(dir, 'mcp.json');
  await writeFile(config, JSON.stringify({ mcpServers: { loop: { type: 'http', url } } }));
  const cwd = path.join(dir, 'empty');
  await mkdir(cwd, { recursive: true });
  const env = Object.fromEntries(['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']
    .filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  const child = spawn('claude', ['-p', '--mcp-config', config, '--strict-mcp-config', '--allowedTools', 'mcp__loop__*', '--tools', '',
    '--setting-sources', 'project', '--max-turns', '16', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--model', model],
  { cwd, env: { ...env, HOME }, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  let error = '';
  let costUsd = 0;
  const texts = [];
  let timer;
  const say = (text) => {
    clearTimeout(timer);
    timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
  };
  child.stderr.on('data', (c) => { err = (err + c).slice(-1000); });
  child.stdin.on('error', () => {});
  const gone = new Promise((resolve) => {
    child.on('error', (e) => { error = e.message; resolve(); });
    child.on('close', resolve);
  });
  say(prompts[0]);
  for await (const line of createInterface({ input: child.stdout })) {
    let event = null;
    try { event = JSON.parse(line); } catch { /* not JSON */ }
    if (event?.type !== 'result') continue;
    costUsd = event.total_cost_usd || costUsd;
    if (event.is_error) error = event.subtype || 'error';
    texts.push(event.result || '');
    if (!error) await afterTurn(texts.length - 1, texts.at(-1));
    if (!error && texts.length < prompts.length) say(prompts[texts.length]);
    else child.stdin.end();
  }
  await gone;
  clearTimeout(timer);
  if (!error && texts.length < prompts.length) error = `no answer to message ${texts.length + 1} ${err}`.trim();
  return { texts, costUsd, error };
}

/* ---------------- Checks ---------------- */

// Does this answer ask the user about feedback? Words are enough here: it is read again when a case fails.
const asksAboutFeedback = (text) => /\b(?:feedback|reports?)\b[^?\n]*\?/i.test(text);

export function check(expect, { reports, calls, ran, text, state }) {
  const wrong = [];
  const want = { none: [0, 0], one: [1, 1], any: [0, 99] }[expect.feedback || 'none'];
  if (reports.length < want[0] || reports.length > want[1]) wrong.push(`${reports.length} reports, expected ${expect.feedback || 'none'}`);
  for (const r of reports) {
    if (expect.source && r.source !== expect.source) wrong.push(`source ${r.source}, expected ${expect.source}`);
    if (expect.type && r.type !== expect.type) wrong.push(`type ${r.type}, expected ${expect.type}`);
  }
  const sent = calls.filter((c) => c.name === 'loop__send_feedback').map((c) => JSON.stringify(c.arguments).toLowerCase());
  for (const t of expect.noText || []) if (sent.some((s) => s.includes(t.toLowerCase()))) wrong.push(`sent "${t}"`);
  for (const name of expect.calls || []) if (!calls.some((c) => c.name === name)) wrong.push(`did not call ${name}`);
  for (const name of expect.ran || []) if (!ran.includes(name)) wrong.push(`did not run ${name}`);
  for (const t of expect.answerHas || []) if (!text.toLowerCase().includes(t.toLowerCase())) wrong.push(`the answer lacks "${t}"`);
  if (expect.state && state !== expect.state) wrong.push(`feedback is "${state}", expected "${expect.state}"`);
  if (expect.asks !== undefined && asksAboutFeedback(text) !== expect.asks) wrong.push(expect.asks ? 'did not ask the user' : 'asked the user');
  return wrong;
}

async function runCase(test, model, { keep = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-feedback-eval-'));
  const dataDir = path.join(dir, 'data');
  const home = path.join(dir, 'home');
  await mkdir(home, { recursive: true });
  process.env.HOME = home;
  const { startServer } = await import('../server.mjs');
  const { FeedbackStore } = await import('../lib/feedback.mjs');
  const { closeWorkspaceDb } = await import('../lib/storage/workspace-db.mjs');
  const ran = [];
  const calls = [];
  const connections = test.connections || [];
  const mock = await services(connections, ran);
  const loop = await startServer({ port: 0, dataDir, home, authMode: 'local-test', detectLocalAgents: false, autoSync: false, autoSemanticThreshold: false, sharedServer: Boolean(test.shared) });
  const send = async (p, data, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${loop.port}${p}`, {
      method: data === undefined ? 'GET' : p === '/api/settings' ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const text = await res.text();
    return { res, json: JSON.parse(/^data: ?(.*)$/m.exec(text)?.[1] || text || 'null') };
  };
  let agent;
  try {
    const setup = await send('/api/auth/setup', { password: 'feedback-eval-password' });
    const cookie = String(setup.res.headers.get('set-cookie')).split(';')[0];
    await send('/api/settings', { requireAgentToken: false, ...(test.state ? { agentFeedback: { on: true, off: false }[test.state] ?? null } : {}) }, { Cookie: cookie });
    for (const c of connections) {
      const saved = await send('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'loop__save', arguments: { type: 'connection', data: { name: c.name, transport: 'http', url: `http://127.0.0.1:${mock.port}/${encodeURIComponent(c.name)}/mcp` } } } });
      if (saved.json?.result?.isError) throw new Error(saved.json.result.content[0].text);
    }
    const store = new FeedbackStore(dataDir);
    const turns = test.turns || [{ prompt: test.prompt, expect: test.expect }];
    const wrong = [];
    const states = [];
    const proxy = await recorder(loop.port, test.fault, calls);
    try {
      agent = await runClaude({
        url: `http://127.0.0.1:${proxy.port}/mcp`,
        dir,
        prompts: turns.map((turn) => turn.prompt),
        model,
        afterTurn: async (i, text) => {
          const { state } = (await send('/api/feedback', undefined, { Cookie: cookie })).json;
          states.push(state);
          const found = check(turns[i].expect || {}, { reports: store.reports(), calls, ran, text, state });
          wrong.push(...found.map((w) => (turns.length > 1 ? `message ${i + 1}: ${w}` : w)));
        },
      });
    } finally {
      await proxy.close();
    }
    if (agent.error) wrong.push(agent.error);
    const reports = store.reports();
    closeWorkspaceDb(store.dbFile);
    return { case: test.id, model, ok: wrong.length === 0, wrong, states, reports, calls, ran, ...agent };
  } finally {
    process.env.HOME = HOME;
    await loop.close?.();
    await mock.close();
    if (!keep) await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
  const only = opt('case', '');
  const models = opt('model', 'sonnet').split(',');
  const runs = Math.max(1, Number(opt('runs', 1)) || 1);
  const asJson = argv.includes('--json');
  const files = (await readdir(CASES)).filter((f) => f.endsWith('.json')).sort();
  const all = await Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(CASES, f), 'utf8'))));
  const tests = all.filter((t) => (only ? t.id === only : t.reviewed));
  if (!tests.length) throw new Error(only ? `There is no case "${only}".` : 'No reviewed cases.');
  for (const t of tests) if (!t.reviewed) throw new Error(`Read ${t.id} first and set "reviewed" to true: its text came from an agent.`);

  const results = [];
  for (const model of models) {
    for (const t of tests) {
      for (let i = 0; i < runs; i += 1) {
        const r = await runCase(t, model, { keep: argv.includes('--keep') });
        results.push(r);
        if (!asJson) {
          process.stdout.write(`${r.ok ? 'pass' : 'FAIL'}  ${model}  ${t.id}  ${[`${r.reports.length} sent`, `${r.calls.length} calls`, r.costUsd ? `$${r.costUsd.toFixed(3)}` : '', ...r.wrong].filter(Boolean).join(', ')}\n`);
        }
      }
    }
  }
  const passed = results.filter((r) => r.ok).length;
  process.stdout.write(asJson ? `${JSON.stringify(results, null, 2)}\n` : `${passed} of ${results.length} passed\n`);
  process.exit(passed === results.length ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { process.stderr.write(`${err?.stack || err}\n`); process.exit(1); });
}
