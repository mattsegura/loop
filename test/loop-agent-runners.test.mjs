import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { createRunTokenRegistry } from '../lib/loop-agent-tokens.mjs';
import {
  extractCreatedItems,
  normalizeMausbotEndpoint,
  runApiAgentLoop,
  runClaudeCli,
  runCodexCli,
  runMausbot,
} from '../lib/loop-agent-runners.mjs';
import { LoopAgentStore } from '../lib/loop-agent-store.mjs';
import { runTraceCli } from '../scripts/agent-traces.mjs';

function makeMockChild(onStart) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit('close', 143));
  };
  let stdinText = '';
  child.stdin.on('data', (c) => { stdinText += c.toString('utf8'); });
  child.stdin.on('end', () => {
    setImmediate(() => onStart(child, stdinText));
  });
  return child;
}

test('RunTokenRegistry issues, resolves, filters internal keys, expires, and revokes tokens', () => {
  const reg = createRunTokenRegistry({ ttlMs: 10_000 });
  try {
    const issued = reg.issue({
      runId: 'run_1',
      workspaceId: 'local',
      profile: 'work',
      agentName: 'Loop Specialist (Claude)',
      runnerKind: 'claude-cli',
      secrets: ['GITHUB_TOKEN', '__internal_secret'],
    });
    assert.ok(issued.token.startsWith('loop_run_'));
    const resolved = reg.resolve(issued.token, { workspaceId: 'local' });
    assert.equal(resolved.id, 'loop_specialist');
    assert.equal(resolved.profile, 'work');
    assert.equal(resolved.ownerSession, true);
    assert.deepEqual(resolved.secrets, ['GITHUB_TOKEN']);
    assert.equal(reg.resolve(issued.token, { workspaceId: 'other' }), null);
    assert.equal(reg.resolve(issued.token, { workspaceId: 'local', now: issued.expiresAt + 1 }), null);

    const issued2 = reg.issue({ runId: 'run_2', workspaceId: 'local' });
    assert.ok(reg.resolve(issued2.token));
    assert.equal(reg.revokeByRunId('run_2'), true);
    assert.equal(reg.resolve(issued2.token), null);
  } finally {
    reg.close();
  }
});

test('runClaudeCli streams NDJSON deltas, parses tool steps and created items, and cleans temp mcp.json', async () => {
  let capturedArgs = null;
  let capturedMcpPath = '';
  let capturedMcpContent = null;
  const events = [];

  const spawnImpl = (_bin, args) => {
    capturedArgs = args;
    const idx = args.indexOf('--mcp-config');
    capturedMcpPath = idx >= 0 ? args[idx + 1] : '';
    capturedMcpContent = JSON.parse(readFileSync(capturedMcpPath, 'utf8'));
    return makeMockChild((child, stdinText) => {
      assert.equal(stdinText, 'Map out my project');
      const lines = [
        { type: 'system', subtype: 'init', session_id: 'claude_sess_42' },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__loop__loop__save', input: { type: 'memory', data: { content: 'Launch Friday' } } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: JSON.stringify({ memory: { id: 'mem_abc123', content: 'Launch Friday' } }) }] } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Saved your ' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'launch note.' } } },
        { type: 'result', session_id: 'claude_sess_42', result: 'Saved your launch note.', is_error: false },
      ];
      for (const l of lines) child.stdout.write(`${JSON.stringify(l)}\n`);
      child.stdout.end();
      child.emit('close', 0);
    });
  };

  const out = await runClaudeCli({
    prompt: 'Map out my project',
    systemPrompt: 'Loop specialist prompt',
    mcpUrl: 'http://127.0.0.1:8799/mcp',
    runToken: 'loop_run_secret_token_xyz',
    model: 'sonnet',
    effort: 'high',
    claudeBin: '/mock/claude',
    spawnImpl,
    onEvent: (ev) => events.push(ev),
  });

  assert.equal(out.sessionId, 'claude_sess_42');
  assert.equal(out.text, 'Saved your launch note.');
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].tool, 'loop__save');
  assert.equal(out.steps[0].ok, true);
  assert.deepEqual(out.createdItems, [{ id: 'mem_abc123', kind: 'memory', title: 'Launch Friday' }]);
  assert.equal(capturedMcpContent.mcpServers.loop.headers.Authorization, 'Bearer loop_run_secret_token_xyz');
  assert.ok(capturedArgs.includes('--dangerously-skip-permissions'), 'Claude CLI runner must bypass permission prompts');
  assert.ok(capturedArgs.includes('--append-system-prompt'));
  assert.equal(existsSync(capturedMcpPath), false, 'Temp mcp.json must be removed after run');
  assert.ok(events.some((e) => e.type === 'item_created' && e.item.id === 'mem_abc123'));
});

test('runCodexCli passes run token only in env (never argv) and streams JSONL events', async () => {
  let capturedArgs = null;
  let capturedEnv = null;

  const spawnImpl = (_bin, args, opts) => {
    capturedArgs = args;
    capturedEnv = opts.env;
    return makeMockChild((child, stdinText) => {
      assert.equal(stdinText, 'Check my memories');
      const lines = [
        { type: 'thread.started', thread_id: 'codex_thr_99' },
        { type: 'item.started', item: { id: 'it_1', type: 'mcp_tool_call', tool: 'loop__search', arguments: { type: 'memory' } } },
        { type: 'item.completed', item: { id: 'it_1', type: 'mcp_tool_call', tool: 'loop__search', status: 'completed', result: '{"memories":[]}' } },
        { type: 'item.completed', item: { id: 'it_2', type: 'agent_message', text: 'Your memory list is empty.' } },
      ];
      for (const l of lines) child.stdout.write(`${JSON.stringify(l)}\n`);
      child.stdout.end();
      child.emit('close', 0);
    });
  };

  const out = await runCodexCli({
    prompt: 'Check my memories',
    systemPrompt: 'Loop specialist instructions',
    mcpUrl: 'http://127.0.0.1:8799/mcp',
    runToken: 'loop_run_codex_secret_123',
    codexBin: '/mock/codex',
    spawnImpl,
  });

  assert.equal(out.sessionId, 'codex_thr_99');
  assert.equal(out.text, 'Your memory list is empty.');
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].tool, 'loop__search');
  assert.equal(capturedEnv.LOOP_RUN_TOKEN, 'loop_run_codex_secret_123');
  assert.ok(capturedArgs.includes('--dangerously-bypass-approvals-and-sandbox'), 'Codex CLI runner must bypass approvals and sandbox');
  assert.ok(capturedArgs.includes('mcp_servers.loop.enabled=true'), 'Codex CLI runner must enable the loop MCP server');
  assert.equal(capturedArgs.join(' ').includes('loop_run_codex_secret_123'), false, 'Run token must never appear in argv');

  // Resuming a Codex session must keep full-permission flags too.
  let resumedArgs = null;
  await runCodexCli({
    prompt: 'Follow up',
    mcpUrl: 'http://127.0.0.1:8799/mcp',
    runToken: 'loop_run_codex_secret_456',
    sessionId: 'codex_thr_99',
    codexBin: '/mock/codex',
    spawnImpl: (_bin, args) => {
      resumedArgs = args;
      return makeMockChild((child) => {
        child.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { id: 'it_3', type: 'agent_message', text: 'Resumed ok.' } })}\n`);
        child.stdout.end();
        child.emit('close', 0);
      });
    },
  });
  assert.equal(resumedArgs[0], 'exec');
  assert.equal(resumedArgs[1], 'resume');
  assert.equal(resumedArgs[2], 'codex_thr_99');
  assert.ok(resumedArgs.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('runApiAgentLoop runs multi-turn OpenAI-compatible tool calls through MCP', async () => {
  let callNum = 0;
  const fetchImpl = async () => {
    callNum += 1;
    if (callNum === 1) {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'tc_1',
              type: 'function',
              function: { name: 'loop__save', arguments: JSON.stringify({ type: 'saved', data: { title: 'Research plan', markdown: '# Plan' } }) },
            }],
          },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Created your Research plan note.' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const out = await runApiAgentLoop({
    provider: 'openai',
    apiKey: 'sk-test-123456',
    model: 'gpt-5.4',
    systemPrompt: 'Specialist prompt',
    prompt: 'Make a research plan',
    fetchImpl,
    listMcpTools: async () => [{ name: 'loop__save', description: 'Save item', inputSchema: { type: 'object' } }],
    callMcpTool: async (name, args) => {
      assert.equal(name, 'loop__save');
      assert.equal(args.data.title, 'Research plan');
      return { ok: true, text: JSON.stringify({ saved: { id: 'sav_plan1', title: 'Research plan' } }) };
    },
  });

  assert.equal(out.text, 'Created your Research plan note.');
  assert.equal(out.steps.length, 1);
  assert.deepEqual(out.createdItems, [{ id: 'sav_plan1', kind: 'saved', title: 'Research plan' }]);
});

test('runMausbot sends exact Bearer + { message } POST and parses JSON or SSE responses', async () => {
  let seenReq = null;
  const jsonRes = await runMausbot({
    endpoint: 'http://127.0.0.1:18880/hooks/api/bots/bot-1/messages',
    apiKey: 'bak_test_token_12345',
    message: 'Hello MausBot',
    fetchImpl: async (url, init) => {
      seenReq = { url, method: init.method, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ reply: 'I can help with your computer and Loop.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  assert.equal(seenReq.url, 'http://127.0.0.1:18880/hooks/api/bots/bot-1/messages');
  assert.equal(seenReq.method, 'POST');
  assert.equal(seenReq.headers.Authorization, 'Bearer bak_test_token_12345');
  assert.deepEqual(seenReq.body, { message: 'Hello MausBot' });
  assert.equal(jsonRes.text, 'I can help with your computer and Loop.');

  const sseDeltas = [];
  const sseRes = await runMausbot({
    endpoint: 'https://bot.example.com/hooks/api/bots/bot-1/messages',
    apiKey: 'bak_test_token_12345',
    message: 'Stream please',
    onEvent: (ev) => { if (ev.type === 'delta') sseDeltas.push(ev.text); },
    fetchImpl: async () => new Response('data: {"delta":"Part 1 "}\n\ndata: {"delta":"Part 2"}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  });
  assert.equal(sseRes.text, 'Part 1 Part 2');
  assert.deepEqual(sseDeltas, ['Part 1 ', 'Part 2']);

  assert.equal(normalizeMausbotEndpoint('http://127.0.0.1:18880/hooks/api/bots/x/messages', { allowLoopback: true }), 'http://127.0.0.1:18880/hooks/api/bots/x/messages');
  assert.equal(normalizeMausbotEndpoint('http://127.0.0.1:18880/hooks/api/bots/x/messages', { allowLoopback: false }), null);
  assert.equal(normalizeMausbotEndpoint('https://mausbot.example.com/hooks/api/bots/x/messages', { allowLoopback: false }), 'https://mausbot.example.com/hooks/api/bots/x/messages');
});

test('extractCreatedItems and trace CLI inspect flagged runs cleanly', async (t) => {
  const extracted = extractCreatedItems('loop__save', JSON.stringify({
    results: [
      { memory: { id: 'mem_1', content: 'Fact one' } },
      { task: { id: 'task_2', title: 'Ship feature' } },
    ],
  }));
  assert.equal(extracted.length, 2);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-traces-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const store = new LoopAgentStore(dir);
  const thr = store.createThread({ title: 'Test' });
  store.startRun({
    id: 'run_flag_1',
    threadId: thr.id,
    runner: 'claude-cli',
    model: 'sonnet',
    promptVersion: 'loop-specialist-v1',
    userMessage: 'Build my map',
  });
  store.finishRun('run_flag_1', {
    status: 'completed',
    assistantReply: 'Done',
    steps: [{ tool: 'loop__save', input: { type: 'memory' }, output: '{"ok":true}', ok: true, durationMs: 120 }],
  });
  store.flagRun('run_flag_1', { flagged: true, note: 'Forgot to link to parent note' });

  const out = [];
  const code = runTraceCli(['--data', dir, '--flagged'], { log: (s) => out.push(s) });
  assert.equal(code, 0);
  assert.match(out.join('\n'), /\[FLAGGED\].*run_flag_1/);
  assert.match(out.join('\n'), /Forgot to link to parent note/);

  const detail = [];
  assert.equal(runTraceCli(['show', 'run_flag_1', '--data', dir], { log: (s) => detail.push(s) }), 0);
  assert.match(detail.join('\n'), /Prompt version: loop-specialist-v1/);
  assert.match(detail.join('\n'), /loop__save/);
});
