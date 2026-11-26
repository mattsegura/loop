#!/usr/bin/env node
// Comprehensive live browser evaluation for Loop MCP Apps inline chat widgets & Local MCP Inspector.
// Usage: npm run eval:inspector [-- --report=/path/to/report.json --screenshots=/path/to/dir]
//
// Starts a real Loop server + mock upstream MCP server (tools, images, errors, upstream MCP App with CSP,
// resources, prompts) and drives headless Chrome via scripts/eval-inspector-browser.py across every user workflow.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_EVAL_PY = path.join(__dirname, 'eval-inspector-browser.py');

const SECRET_VAL = 'sk-eval-super-secret-88442211';
const CARD_VAL = '4242-4242-4242-4242';
const XSS_PAYLOAD = '<img src=x onerror="window.__XSS_PWNED__=true"><script>window.__XSS_PWNED__=true</script>';
// 1x1 green PNG pixel
const VALID_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const UPSTREAM_WIDGET_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Mock Chart Widget</title>
<style>body{font-family:system-ui;padding:12px;margin:0;color:#222;background:#fff} .box{padding:8px;border:1px solid #ddd;border-radius:8px}</style>
</head>
<body>
<div id="chart-root" class="box">Waiting for chart data...</div>
<script>
const root = document.getElementById('chart-root');
let partialCount = 0;
window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.jsonrpc !== '2.0') return;
  if (m.id === 'u1') {
    window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
    return;
  }
  if (m.method === 'ui/notifications/tool-input-partial') {
    partialCount += 1;
    root.textContent = 'Streaming partial #' + partialCount + ': ' + JSON.stringify(m.params?.arguments || {});
  }
  if (m.method === 'ui/notifications/tool-result') {
    root.textContent = 'Upstream Chart Loaded: ' + (m.params?.content?.[0]?.text || 'empty');
    window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: 400, height: 180 } }, '*');
  }
});
window.parent.postMessage({ jsonrpc: '2.0', id: 'u1', method: 'ui/initialize', params: { protocolVersion: '2026-01-26', appInfo: { name: 'mock-chart', version: '1.0.0' }, appCapabilities: {} } }, '*');
</script>
</body>
</html>`;

async function startMockUpstream() {
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/mcp') {
      res.writeHead(404);
      return res.end('Not found');
    }
    if (req.method === 'DELETE') {
      res.writeHead(200);
      return res.end();
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE' });
      return res.end();
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.id === undefined || body.id === null) {
      res.writeHead(202);
      return res.end();
    }
    const ok = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    };
    if (body.method === 'initialize') {
      return ok({
        protocolVersion: '2025-11-25',
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
          extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } },
        },
        serverInfo: { name: 'acme-analytics', version: '1.0.0' },
      });
    }
    if (body.method === 'tools/list') {
      return ok({
        tools: [
          {
            name: 'echo',
            description: 'Echoes text back (read-only).',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
            inputSchema: {
              type: 'object',
              properties: { message: { type: 'string', description: 'Text to echo' } },
              required: ['message'],
            },
          },
          {
            name: 'delete_record',
            description: 'Deletes a record permanently.',
            annotations: { readOnlyHint: false, destructiveHint: true },
            inputSchema: {
              type: 'object',
              properties: { recordId: { type: 'string', description: 'Record ID' } },
              required: ['recordId'],
            },
          },
          {
            name: 'fail_boom',
            description: 'Always returns an upstream tool error.',
            annotations: { readOnlyHint: true },
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'render_badge_image',
            description: 'Returns one valid PNG image and one blocked SVG image.',
            annotations: { readOnlyHint: true },
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'xss_probe',
            description: 'Returns untrusted HTML/script string to test XSS safety.',
            annotations: { readOnlyHint: true },
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'revenue_chart',
            description: 'Returns quarterly revenue metrics with an inline MCP App chart widget.',
            annotations: { readOnlyHint: true },
            inputSchema: {
              type: 'object',
              properties: { quarter: { type: 'string', description: 'Quarter e.g. Q4' } },
            },
            _meta: {
              ui: {
                resourceUri: 'ui://mock/chart',
                visibility: ['model', 'app'],
              },
            },
          },
        ],
      });
    }
    if (body.method === 'tools/call') {
      const name = body.params?.name;
      const args = body.params?.arguments || {};
      if (name === 'echo') {
        return ok({ content: [{ type: 'text', text: JSON.stringify({ echoed: args.message || 'hello', ok: true }) }] });
      }
      if (name === 'delete_record') {
        return ok({ content: [{ type: 'text', text: JSON.stringify({ deleted: args.recordId || 'unknown' }) }] });
      }
      if (name === 'fail_boom') {
        return ok({ isError: true, content: [{ type: 'text', text: 'Upstream simulated failure: rate limit exceeded.' }] });
      }
      if (name === 'render_badge_image') {
        return ok({
          content: [
            { type: 'text', text: 'Badge image generated.' },
            { type: 'image', mimeType: 'image/png', data: VALID_PNG_B64 },
            { type: 'image', mimeType: 'image/svg+xml', data: Buffer.from('<svg onload="alert(1)"/>').toString('base64') },
          ],
        });
      }
      if (name === 'xss_probe') {
        return ok({ content: [{ type: 'text', text: JSON.stringify({ untrusted: XSS_PAYLOAD }) }] });
      }
      if (name === 'revenue_chart') {
        return ok({ content: [{ type: 'text', text: JSON.stringify({ quarter: args.quarter || 'Q4', revenueUsd: 142500, growthPct: 24 }) }] });
      }
      return ok({ isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }] });
    }
    if (body.method === 'resources/list') {
      return ok({
        resources: [
          {
            uri: 'ui://mock/chart',
            name: 'Revenue Chart Widget',
            description: 'Upstream MCP App widget with declarative CSP.',
            mimeType: 'text/html;profile=mcp-app',
          },
          {
            uri: 'mock://handbook/ops',
            name: 'Ops Handbook',
            description: 'Plain text operations guide.',
            mimeType: 'text/plain',
          },
        ],
      });
    }
    if (body.method === 'resources/read') {
      if (body.params?.uri === 'ui://mock/chart') {
        return ok({
          contents: [
            {
              uri: 'ui://mock/chart',
              mimeType: 'text/html;profile=mcp-app',
              text: UPSTREAM_WIDGET_HTML,
              _meta: {
                ui: {
                  csp: {
                    connectDomains: ['https://api.example.com', 'http://127.0.0.1:8799', 'https://localhost'],
                    resourceDomains: ['https://cdn.example.com'],
                  },
                },
              },
            },
          ],
        });
      }
      return ok({ contents: [{ uri: body.params?.uri, mimeType: 'text/plain', text: 'Loop Live Eval Ops Guide' }] });
    }
    if (body.method === 'prompts/list') {
      return ok({
        prompts: [
          {
            name: 'weekly_digest',
            description: 'Build a weekly digest for a team.',
            arguments: [{ name: 'team', description: 'Team name', required: true }],
          },
        ],
      });
    }
    if (body.method === 'prompts/get') {
      return ok({
        messages: [{ role: 'user', content: { type: 'text', text: `Weekly digest for ${body.params?.arguments?.team || 'Core'}` } }],
      });
    }
    return ok({});
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { server: srv, url: `http://127.0.0.1:${srv.address().port}/mcp` };
}

function findPython() {
  const candidates = [
    '/Library/Frameworks/Python.framework/Versions/3.10/bin/python3',
    'python3',
  ];
  for (const bin of candidates) {
    if (bin === 'python3' || existsSync(bin)) return bin;
  }
  return 'python3';
}

function parseCliArgs(argv) {
  const out = { report: null, screenshots: null };
  for (const arg of argv) {
    if (arg.startsWith('--report=')) out.report = arg.slice('--report='.length);
    if (arg.startsWith('--screenshots=')) out.screenshots = arg.slice('--screenshots='.length);
  }
  return out;
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'loop-eval-inspector-'));
  const upstream = await startMockUpstream();
  const loop = await startServer({ port: 0, dataDir: tmpDir, authMode: 'local-test' });
  const baseUrl = `http://127.0.0.1:${loop.port}`;

  let cookie = '';
  const api = async (route, opts = {}) => {
    const res = await fetch(`${baseUrl}${route}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(opts.headers || {}),
      },
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  try {
    const PASSWORD = 'eval-password-2026';
    await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) });

    // 1. Add and sync upstream connection
    const connRes = await api('/api/mcps', {
      method: 'POST',
      body: JSON.stringify({ name: 'Acme Analytics', url: upstream.url, transport: 'http', enabled: true }),
    });
    const connId = connRes.json.mcp.id;
    await api(`/api/mcps/${connId}/sync`, { method: 'POST' });

    // 2. Policy: destructive tool asks for owner approval
    await api('/api/policies', {
      method: 'PATCH',
      body: JSON.stringify({ tools: { [`${connId}__delete_record`]: 'always_ask' } }),
    });

    // 3. Vault items: API key (auto) + Payment card (Guard)
    await api('/api/vault', {
      method: 'POST',
      body: JSON.stringify({ key: 'ACME_SECRET', value: SECRET_VAL, type: 'api_key', approval: 'auto' }),
    });
    await api('/api/vault', {
      method: 'POST',
      body: JSON.stringify({ key: 'CORP_CARD', value: CARD_VAL, type: 'payment', approval: 'guard' }),
    });

    // 4. Agents: full owner agent + restricted reader agent
    const ownerAgent = await api('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Claude Desktop',
        kind: 'claude-desktop',
        profile: 'all',
        memoryAccess: 'read_write',
        canManage: true,
        sharedSecrets: ['ACME_SECRET', 'CORP_CARD'],
      }),
    });
    const readOnlyAgent = await api('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Restricted Reader',
        kind: 'other',
        profile: 'all',
        memoryAccess: 'none',
        canManage: false,
      }),
    });

    // 5. Seed real Memory, Skill, Task, and full @json-render/core Saved Artifact Card via dashboard/MCP APIs
    const seedRpc = async (method, params) => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${ownerAgent.json.token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return res.json();
    };
    const memSeed = await seedRpc('tools/call', {
      name: 'loop__save',
      arguments: {
        type: 'memory',
        data: { key: 'deploy-region', content: 'Deploy Loop production to Hetzner Nuremberg.', scope: 'preference' },
      },
    });
    const skillSeed = await seedRpc('tools/call', {
      name: 'loop__save',
      arguments: {
        type: 'skill',
        data: {
          name: 'Release Checklist',
          description: 'Steps to safely cut a Loop production release.',
          content: '# Release Checklist\n\n1. Run `npm test`\n2. Run `npm run test:audit`\n3. Run `npm run eval:inspector`',
        },
      },
    });
    const taskSeed = await seedRpc('tools/call', {
      name: 'loop__save',
      arguments: {
        type: 'task',
        data: {
          expectedRevision: 0,
          title: 'Ship MCP Apps v2',
          objective: 'Verify inline widgets in Claude and ChatGPT.',
          notes: 'All 4 Loop widgets active.',
          nextStep: 'Run final live browser eval.',
          status: 'active',
        },
      },
    });
    const evilSavedAttempt = await api('/api/saved', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'artifact',
        title: 'Evil Link Card',
        ui: {
          root: 'c1',
          elements: {
            c1: { type: 'Card', props: { title: 'Evil' }, children: ['l1'] },
            l1: { type: 'Link', props: { label: 'XSS', url: 'javascript:alert(1)' } },
          },
        },
      }),
    });
    const savedSeed = await api('/api/saved', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'artifact',
        title: 'Q4 Launch Readiness Card',
        ui: {
          root: 'card1',
          state: { healthy: true, envLabel: 'Production (Hetzner)' },
          elements: {
            card1: {
              type: 'Card',
              props: { kicker: 'Launch Gate', title: 'Q4 Launch Readiness', subtitle: { $state: '/envLabel' }, tone: 'ok' },
              children: ['metrics', 'div1', 'checks', 'tbl', 'linkOk', 'code1'],
            },
            metrics: {
              type: 'MetricGrid',
              props: {
                items: [
                  { label: 'Unit Tests', value: '365', change: '100% pass', tone: 'ok' },
                  { label: 'Security Audit', value: '0 open', change: '21 closed', tone: 'ok' },
                ],
              },
            },
            div1: { type: 'Divider', props: {} },
            checks: {
              type: 'Checklist',
              visible: { $state: '/healthy', eq: true },
              props: {
                items: [
                  { label: 'Sandbox opaque origin verified', checked: true },
                  { label: 'Live SSE trace verified', checked: true },
                ],
              },
            },
            tbl: {
              type: 'Table',
              props: {
                columns: ['Surface', 'Status'],
                rows: [
                  ['ui://loop/search', 'Connected'],
                  ['ui://loop/run', 'Connected'],
                ],
              },
            },
            linkOk: {
              type: 'Link',
              props: { label: 'Open Loop Docs', url: 'https://useloop.sh/', description: 'Safe external HTTPS link' },
            },
            code1: {
              type: 'CodeBlock',
              props: { label: 'Release command', code: 'sh deploy/release.sh', collapsible: true },
            },
          },
        },
      }),
    });

    const configPayload = {
      baseUrl,
      password: PASSWORD,
      connId,
      ownerToken: ownerAgent.json.token,
      restrictedAgentId: readOnlyAgent.json.agent.id,
      secretVal: SECRET_VAL,
      cardVal: CARD_VAL,
      savedCardId: savedSeed.json?.item?.id || null,
      evilSavedRejected: evilSavedAttempt.status === 400,
      seedStatus: {
        memoryOk: !memSeed?.result?.isError,
        skillOk: !skillSeed?.result?.isError,
        taskOk: !taskSeed?.result?.isError,
        savedOk: savedSeed.status === 201 || savedSeed.status === 200,
      },
      reportPath: cli.report || path.join(tmpDir, 'eval-inspector-report.json'),
      screenshotsDir: cli.screenshots || '',
    };
    console.log('[eval:inspector] Seeded workspace:', JSON.stringify(configPayload.seedStatus), 'savedCardId=', configPayload.savedCardId, 'savedStatus=', savedSeed.status);

    const python = findPython();
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(python, [BROWSER_EVAL_PY], {
        stdio: ['pipe', 'inherit', 'inherit'],
        env: { ...process.env, LOOP_EVAL_CONFIG: JSON.stringify(configPayload) },
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });
    process.exitCode = exitCode;
  } finally {
    await loop.close?.();
    upstream.server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[eval:inspector] Failed:', err);
  process.exit(1);
});
