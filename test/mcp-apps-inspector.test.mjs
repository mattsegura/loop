import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';
import {
  LOOP_CHAT_TOOL_WIDGETS,
  LOOP_WIDGET_URIS,
  MCP_APP_EXTENSION,
  MCP_APP_MIME_TYPE,
  MCP_INSPECTOR_SANDBOX_CSP,
  buildSandboxCsp,
  extractMcpAppCapability,
  extractWidgetScripts,
  listLoopAppResources,
  normalizeUpstreamToolUiMeta,
  normalizeWidgetCsp,
  readLoopAppResource,
  toolUiMeta,
} from '../lib/mcp-apps.mjs';
import { InspectorTraceStore } from '../lib/mcp-inspector.mjs';

describe('MCP Apps inline chat widgets and Local MCP Inspector', () => {
  let tmpDir;
  let server;
  let baseUrl;
  let ownerCookie = '';
  let ownerToken = '';
  let restrictedToken = '';
  let restrictedAgentId = '';

  async function api(route, opts = {}) {
    const res = await fetch(`${baseUrl}${route}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(ownerCookie ? { Cookie: ownerCookie } : {}),
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  async function mcpRpc(method, params = {}, { token = ownerToken, sessionId = null } = {}) {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = await res.json();
    return { status: res.status, sessionId: res.headers.get('mcp-session-id'), json };
  }

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'loop-mcp-apps-test-'));
    server = await startServer({ port: 0, dataDir: tmpDir, authMode: 'local-test' });
    baseUrl = `http://127.0.0.1:${server.port}`;

    // Sign up local owner password so dashboard / inspector API routes are authenticated.
    const setup = await api('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ password: 'test-password-1234' }),
    });
    assert.equal(setup.status, 200);
    const setCookie = setup.headers.get('set-cookie') || '';
    ownerCookie = setCookie.split(';')[0];

    // Create one full-access owner agent and one read-only restricted agent.
    const a1 = await api('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Claude Desktop',
        kind: 'claude-desktop',
        profile: 'all',
        memoryAccess: 'read_write',
        canManage: true,
      }),
    });
    assert.equal(a1.status, 201);
    ownerToken = a1.json.token;

    const a2 = await api('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Read Only Bot',
        kind: 'other',
        profile: 'all',
        memoryAccess: 'none',
        canManage: false,
      }),
    });
    assert.equal(a2.status, 201);
    restrictedToken = a2.json.token;
    restrictedAgentId = a2.json.agent.id;

    // Seed a Vault secret so we can verify redaction in both widgets and inspector traffic logs.
    const vRes = await api('/api/vault', {
      method: 'POST',
      body: JSON.stringify({
        key: 'TOP_SECRET_API_KEY',
        value: 'sk-live-never-leak-99887766',
        type: 'api_key',
      }),
    });
    assert.equal(vRes.status, 201);
  });

  after(async () => {
    await server?.close?.();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it('extracts MCP Apps capability and validates upstream _meta.ui metadata', () => {
    assert.deepEqual(extractMcpAppCapability({}), { supported: false, mimeTypes: [] });
    assert.deepEqual(
      extractMcpAppCapability({
        extensions: { [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
      }),
      { supported: true, mimeTypes: [MCP_APP_MIME_TYPE] },
    );
    assert.deepEqual(
      extractMcpAppCapability({
        extensions: { [MCP_APP_EXTENSION]: { mimeTypes: ['text/plain'] } },
      }),
      { supported: false, mimeTypes: ['text/plain'] },
    );
    assert.deepEqual(
      extractMcpAppCapability({
        experimental: { [MCP_APP_EXTENSION]: {} },
      }),
      { supported: true, mimeTypes: [MCP_APP_MIME_TYPE] },
    );

    assert.deepEqual(
      normalizeUpstreamToolUiMeta({ ui: { resourceUri: 'ui://acme/chart', visibility: ['model', 'app'] } }),
      { ui: { resourceUri: 'ui://acme/chart', visibility: ['model', 'app'] } },
    );
    assert.equal(
      normalizeUpstreamToolUiMeta({ ui: { resourceUri: 'javascript:alert(1)' } }),
      undefined,
    );
    assert.equal(
      normalizeUpstreamToolUiMeta({ ui: { resourceUri: 'http://insecure.example/widget' } }),
      undefined,
    );
  });

  it('advertises io.modelcontextprotocol/ui and links _meta.ui only to loop__save on chat tools/list', async () => {
    const init = await mcpRpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {
        extensions: {
          [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] },
        },
      },
      clientInfo: { name: 'claude-desktop', version: '1.0.0' },
    });
    assert.equal(init.status, 200);
    assert.ok(init.sessionId);
    assert.deepEqual(
      init.json.result.capabilities.extensions[MCP_APP_EXTENSION],
      { mimeTypes: [MCP_APP_MIME_TYPE] },
    );

    const toolsRes = await mcpRpc('tools/list', {}, { sessionId: init.sessionId });
    assert.equal(toolsRes.status, 200);
    const byName = new Map(toolsRes.json.result.tools.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(LOOP_CHAT_TOOL_WIDGETS), ['loop__save', 'loop__show']);
    assert.equal(byName.get('loop__save')._meta.ui.resourceUri, LOOP_WIDGET_URIS.save);
    assert.equal(byName.get('loop__show')._meta.ui.resourceUri, LOOP_WIDGET_URIS.show);
    assert.equal(byName.get('loop__search')._meta, undefined);
    assert.equal(byName.get('loop__inspect')._meta, undefined);
    assert.equal(byName.get('loop__run')._meta, undefined);

    // Inspector scope still resolves all 5 built-in widgets.
    assert.equal(toolUiMeta('loop__search')?.ui?.resourceUri, LOOP_WIDGET_URIS.search);
    assert.equal(toolUiMeta('loop__inspect')?.ui?.resourceUri, LOOP_WIDGET_URIS.inspect);
    assert.equal(toolUiMeta('loop__run')?.ui?.resourceUri, LOOP_WIDGET_URIS.run);
    assert.equal(toolUiMeta('loop__save')?.ui?.resourceUri, LOOP_WIDGET_URIS.save);
    assert.equal(toolUiMeta('loop__show')?.ui?.resourceUri, LOOP_WIDGET_URIS.show);
    assert.equal(toolUiMeta('loop__search', { scope: 'chat' }), null);
    assert.equal(toolUiMeta('loop__save', { scope: 'chat' })?.ui?.resourceUri, LOOP_WIDGET_URIS.save);
    assert.equal(toolUiMeta('loop__show', { scope: 'chat' })?.ui?.resourceUri, LOOP_WIDGET_URIS.show);
  });

  it('renders loop__show inline for MCP Apps hosts, returns clean Markdown for Codex/CLI hosts, redacts Vault secrets, and blocks unsafe specs', async () => {
    const sampleUi = {
      root: 'c1',
      state: { env: 'Production' },
      elements: {
        c1: {
          type: 'Card',
          props: { kicker: 'Milestone', title: 'Screens Ready', subtitle: { $state: '/env' }, tone: 'ok' },
          children: ['m1', 'p1', 'b1', 's1', 'il1', 'chk1', 'tbl1', 'img1', 'lnk1'],
        },
        m1: {
          type: 'MetricGrid',
          props: {
            items: [
              { label: 'Screens', value: '5', change: 'All reviewed', tone: 'ok' },
              { label: 'Secret Check', value: 'sk-live-never-leak-99887766' },
            ],
          },
        },
        p1: {
          type: 'Progress',
          props: { label: 'Setup', value: 75, max: 100, tone: 'ok' },
        },
        b1: {
          type: 'BarChart',
          props: {
            title: 'By App',
            items: [
              { label: 'Doop Design', value: 5, displayValue: '5 screens', tone: 'ok' },
            ],
          },
        },
        s1: {
          type: 'Steps',
          props: {
            items: [
              { label: 'Connect Google Drive', status: 'done' },
              { label: 'Review screens', status: 'active' },
            ],
          },
        },
        il1: {
          type: 'ItemList',
          props: {
            items: [
              {
                title: 'Google Drive',
                subtitle: 'Account sign-in needed',
                badge: 'Sign in',
                badgeTone: 'warn',
                url: 'https://example.com/signin',
                actionLabel: 'Sign in',
                actionVariant: 'primary',
              },
            ],
          },
        },
        chk1: {
          type: 'Checklist',
          props: {
            items: [
              { label: 'Three-account list', checked: true },
              { label: 'Access picker', checked: false },
            ],
          },
        },
        tbl1: {
          type: 'Table',
          props: { columns: ['App', 'Status'], rows: [['Doop Design', 'Ready']] },
        },
        img1: {
          type: 'Image',
          props: { url: 'https://example.com/screen.png', alt: 'Account screen', caption: 'Latest render' },
        },
        lnk1: {
          type: 'Link',
          props: { label: 'Open Canvas', url: 'https://example.com/canvas', description: 'View live', variant: 'primary' },
        },
      },
    };

    // 1. MCP Apps host (Claude Desktop) gets structuredContent.ui + renderedInHost: true + Vault redaction.
    const uiInit = await mcpRpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: { extensions: { [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } } },
      clientInfo: { name: 'claude-desktop', version: '1.0.0' },
    });
    const uiShow = await mcpRpc(
      'tools/call',
      { name: 'loop__show', arguments: { title: 'Screens Ready', ui: sampleUi } },
      { sessionId: uiInit.sessionId },
    );
    assert.equal(uiShow.status, 200);
    assert.equal(Boolean(uiShow.json.result.isError), false);
    assert.equal(uiShow.json.result.structuredContent.renderedInHost, true);
    assert.equal(uiShow.json.result.structuredContent.ui.root, 'c1');
    assert.equal(JSON.stringify(uiShow.json).includes('sk-live-never-leak-99887766'), false);

    // 2. Non-UI host (Codex CLI) gets clean GitHub-Flavored Markdown in content[0].text + renderedInHost: false.
    const cliInit = await mcpRpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'codex-cli', version: '1.0.0' },
    });
    const cliShow = await mcpRpc(
      'tools/call',
      { name: 'loop__show', arguments: { ui: sampleUi } },
      { sessionId: cliInit.sessionId },
    );
    assert.equal(cliShow.status, 200);
    assert.equal(Boolean(cliShow.json.result.isError), false);
    assert.equal(cliShow.json.result.structuredContent.renderedInHost, false);
    const md = cliShow.json.result.content[0].text;
    assert.match(md, /### Screens Ready/);
    assert.match(md, /Production/);
    assert.match(md, /\| Screens \| Secret Check \|/);
    assert.match(md, /\*\*Setup:\*\* .* \*\*75%\*\*/);
    assert.match(md, /\*\*By App\*\*/);
    assert.match(md, /- ✓ \*\*Connect Google Drive\*\*/);
    assert.match(md, /- \*\*Google Drive\*\* `Sign in`/);
    assert.match(md, /- \[x\] Three-account list/);
    assert.match(md, /- \[ \] Access picker/);
    assert.match(md, /!\[Account screen\]\(https:\/\/example\.com\/screen\.png\)/);
    assert.match(md, /\*\*\[Open Canvas\]\(https:\/\/example\.com\/canvas\)\*\*/);
    assert.equal(md.includes('sk-live-never-leak-99887766'), false);

    // 3. Rejects unsafe image URLs and interactive components cleanly.
    const badImg = await mcpRpc(
      'tools/call',
      {
        name: 'loop__show',
        arguments: {
          ui: {
            root: 'i1',
            elements: {
              i1: { type: 'Image', props: { url: 'javascript:alert(1)' } },
            },
          },
        },
      },
      { sessionId: cliInit.sessionId },
    );
    assert.equal(badImg.json.result.isError, true);

    const badSvg = await mcpRpc(
      'tools/call',
      {
        name: 'loop__show',
        arguments: {
          ui: {
            root: 'i1',
            elements: {
              i1: { type: 'Image', props: { url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } },
            },
          },
        },
      },
      { sessionId: cliInit.sessionId },
    );
    assert.equal(badSvg.json.result.isError, true);

    // 4. Read-only restricted agent can still call loop__show cleanly.
    const roShow = await mcpRpc(
      'tools/call',
      {
        name: 'loop__show',
        arguments: {
          ui: {
            root: 'c1',
            elements: { c1: { type: 'Card', props: { title: 'Read Only OK' } } },
          },
        },
      },
      { token: restrictedToken },
    );
    assert.equal(Boolean(roShow.json.result.isError), false);
    assert.match(roShow.json.result.content[0].text, /### Read Only OK/);
  });

  it('omits ui:// resources from resources/list for non-UI clients, exposes them for UI clients, and serves all via resources/read', async () => {
    // Non-UI client (no io.modelcontextprotocol/ui extension)
    const plainInit = await mcpRpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'claude-code', version: '2.0.0' },
    });
    const plainList = await mcpRpc('resources/list', {}, { sessionId: plainInit.sessionId });
    assert.equal(plainList.status, 200);
    assert.equal(plainList.json.result.resources.some((r) => r.uri.startsWith('ui://loop/')), false);

    // MCP Apps-capable client
    const uiInit = await mcpRpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {
        extensions: {
          [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] },
        },
      },
      clientInfo: { name: 'claude-desktop', version: '2.0.0' },
    });
    const uiList = await mcpRpc('resources/list', {}, { sessionId: uiInit.sessionId });
    assert.equal(uiList.status, 200);
    const listedUris = uiList.json.result.resources.map((r) => r.uri);
    for (const expected of listLoopAppResources()) {
      assert.ok(listedUris.includes(expected.uri), `Expected ${expected.uri} in resources/list`);
    }

    // Reading every built-in widget returns valid text/html;profile=mcp-app with strict CSP and no unsafe DOM sinks.
    for (const uri of Object.values(LOOP_WIDGET_URIS)) {
      const readRes = await mcpRpc('resources/read', { uri }, { sessionId: plainInit.sessionId });
      assert.equal(readRes.status, 200);
      const item = readRes.json.result.contents[0];
      assert.equal(item.uri, uri);
      assert.equal(item.mimeType, MCP_APP_MIME_TYPE);
      assert.match(item.text, /ui\/initialize/);
      assert.match(item.text, /ui\/notifications\/tool-result/);
      assert.equal(item.text.includes("pill('MCP App'"), false);
      assert.deepEqual(item._meta.ui.csp.connectDomains, []);
      assert.deepEqual(item._meta.ui.csp.resourceDomains, []);
      assert.equal(/\binnerHTML\b|\bouterHTML\b|\bdocument\.write\b|\beval\s*\(|\bfetch\s*\(/i.test(item.text), false);
      const scripts = extractWidgetScripts(item.text);
      assert.ok(scripts.length >= 2, `Expected inline scripts in ${uri}`);
      for (const code of scripts) {
        assert.doesNotThrow(() => new vm.Script(code, { filename: uri }), `Syntax error in ${uri}`);
      }
    }

    // Unknown ui:// resource is rejected cleanly.
    const unknown = await mcpRpc('resources/read', { uri: 'ui://loop/nonexistent' }, { sessionId: uiInit.sessionId });
    assert.equal(unknown.json.error?.code, -32602);
    assert.equal(readLoopAppResource('ui://loop/nonexistent'), null);
  });

  it('omits _meta.ui metadata for SMS surface clients', async () => {
    const smsInit = await mcpRpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: { experimental: { loop: { surface: 'sms' } } },
      clientInfo: { name: 'loop-text', version: '1.0.0' },
    });
    const smsTools = await mcpRpc('tools/list', {}, { sessionId: smsInit.sessionId });
    for (const tool of smsTools.json.result.tools) {
      assert.equal(tool._meta, undefined, `Expected no _meta on ${tool.name} for SMS surface`);
    }
  });

  it('serves /inspector and strict double-sandboxed /inspector/sandbox with proper CSP and X-Frame-Options', async () => {
    const page = await fetch(`${baseUrl}/inspector`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    const pageHtml = await page.text();
    assert.match(pageHtml, /MCP Inspector/);
    assert.match(pageHtml, /script-src 'self'/);

    const directHtml = await fetch(`${baseUrl}/inspector.html`);
    assert.equal(directHtml.status, 404);

    const sandbox = await fetch(`${baseUrl}/inspector/sandbox`);
    assert.equal(sandbox.status, 200);
    assert.equal(sandbox.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(sandbox.headers.get('content-security-policy'), MCP_INSPECTOR_SANDBOX_CSP);
    const sandboxHtml = await sandbox.text();
    assert.match(sandboxHtml, /sandbox="allow-scripts"/);
    assert.match(sandboxHtml, /ui\/notifications\/sandbox-proxy-ready/);
  });

  it('protects /api/inspector/* behind owner auth and runs RPC, simulation, trace redaction, and audit checks', async () => {
    // Unauthenticated requests to /api/inspector/* are blocked.
    const unauth = await fetch(`${baseUrl}/api/inspector/context`);
    assert.equal(unauth.status, 401);

    // Context endpoint returns agents (never raw tokens), profiles, and built-in widgets.
    const ctx = await api('/api/inspector/context');
    assert.equal(ctx.status, 200);
    assert.equal(ctx.json.builtInWidgets.length, 5);
    assert.equal(ctx.json.extension, MCP_APP_EXTENSION);
    assert.equal(JSON.stringify(ctx.json).includes(ownerToken), false);
    assert.equal(JSON.stringify(ctx.json).includes('sk-live-never-leak-99887766'), false);

    // Initialize and call loop__search via /api/inspector/rpc
    const initRpc = await api('/api/inspector/rpc', {
      method: 'POST',
      body: JSON.stringify({
        rpc: {
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: { extensions: { [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } } },
            clientInfo: { name: 'loop-inspector', version: '2.0.0' },
          },
        },
        mcpApps: true,
      }),
    });
    assert.equal(initRpc.status, 200);
    assert.ok(initRpc.json.sessionId);

    const searchRpc = await api('/api/inspector/rpc', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: initRpc.json.sessionId,
        rpc: {
          method: 'tools/call',
          params: { name: 'loop__search', arguments: { type: 'all' } },
        },
      }),
    });
    assert.equal(searchRpc.status, 200);
    assert.equal(searchRpc.json.widgetUri, LOOP_WIDGET_URIS.search);
    assert.equal(searchRpc.json.response.error, undefined);

    // Simulate restricted agent (no memory access) -> loop__search({ type: 'memory' }) is denied cleanly.
    const simDenied = await api('/api/inspector/rpc', {
      method: 'POST',
      body: JSON.stringify({
        agentId: restrictedAgentId,
        rpc: {
          method: 'tools/call',
          params: { name: 'loop__search', arguments: { type: 'memory' } },
        },
      }),
    });
    assert.equal(simDenied.status, 200);
    assert.equal(simDenied.json.response.result.isError, true);

    // Trace captures both /mcp and /api/inspector/rpc calls and redacts Vault secrets!
    await mcpRpc('tools/call', {
      name: 'loop__search',
      arguments: { type: 'all', query: 'sk-live-never-leak-99887766' },
    });
    const trace = await api('/api/inspector/trace');
    assert.equal(trace.status, 200);
    assert.ok(trace.json.entries.length >= 3);
    assert.equal(JSON.stringify(trace.json).includes('sk-live-never-leak-99887766'), false);
    assert.ok(trace.json.entries.some((e) => e.source === 'mcp'));
    assert.ok(trace.json.entries.some((e) => e.source === 'inspector'));

    // Clear trace
    const cleared = await api('/api/inspector/trace', { method: 'DELETE' });
    assert.equal(cleared.status, 200);
    const traceAfter = await api('/api/inspector/trace');
    assert.equal(traceAfter.json.entries.length, 0);

    // Audit endpoint passes all protocol + MCP Apps widget checks.
    const audit = await api('/api/inspector/audit');
    assert.equal(audit.status, 200);
    assert.equal(audit.json.summary.fail, 0);
    const byId = new Map(audit.json.checks.map((c) => [c.id, c]));
    assert.equal(byId.get('protocol-version').status, 'pass');
    assert.equal(byId.get('mcp-apps-capability').status, 'pass');
    assert.equal(byId.get('tool-widget-links').status, 'pass');
    assert.equal(byId.get('ui-resources-listed').status, 'pass');
    assert.equal(byId.get('ui-resources-read').status, 'pass');
  });

  it('caps InspectorTraceStore entries in memory and rejects malformed RPC bodies', async () => {
    const store = new InspectorTraceStore({ maxEntries: 3 });
    for (let i = 0; i < 5; i += 1) {
      await store.record({
        source: 'mcp',
        request: { jsonrpc: '2.0', id: i, method: 'ping' },
        response: { jsonrpc: '2.0', id: i, result: {} },
      });
    }
    assert.equal(store.list({ limit: 10 }).length, 3);

    const badRpc = await api('/api/inspector/rpc', {
      method: 'POST',
      body: JSON.stringify({ rpc: { method: '' } }),
    });
    assert.equal(badRpc.status, 400);
  });

  it('validates opt-in widget CSP domains strictly and rejects local, private, http, and wildcard origins', async () => {
    const normalized = normalizeWidgetCsp({
      connectDomains: [
        'https://api.example.com',
        'http://api.example.com',
        'https://localhost',
        'https://127.0.0.1:8799',
        'https://10.0.0.1',
        'https://192.168.1.5',
        'https://*.example.com',
        'https://evil.example.com/path;script-src',
      ],
      resourceDomains: ['https://cdn.example.com', 'javascript:alert(1)'],
      frameDomains: ['https://embed.example.com'],
      baseUriDomains: [],
    });
    assert.deepEqual(normalized, {
      connectDomains: ['https://api.example.com'],
      resourceDomains: ['https://cdn.example.com'],
      frameDomains: ['https://embed.example.com'],
      baseUriDomains: [],
    });

    assert.equal(buildSandboxCsp(null), MCP_INSPECTOR_SANDBOX_CSP);
    assert.equal(buildSandboxCsp({ connectDomains: ['http://127.0.0.1:8799'] }), MCP_INSPECTOR_SANDBOX_CSP);

    const optInHeader = buildSandboxCsp(normalized);
    assert.match(optInHeader, /^sandbox allow-scripts;/);
    assert.match(optInHeader, /connect-src https:\/\/api\.example\.com;/);
    assert.match(optInHeader, /script-src 'unsafe-inline' https:\/\/cdn\.example\.com;/);
    assert.match(optInHeader, /frame-src https:\/\/embed\.example\.com;/);
    assert.match(optInHeader, /frame-ancestors 'self'$/);

    const sandboxRes = await fetch(
      `${baseUrl}/inspector/sandbox?csp=${encodeURIComponent(JSON.stringify({ connectDomains: ['https://api.example.com', 'https://127.0.0.1'] }))}`,
    );
    assert.equal(sandboxRes.status, 200);
    const cspHdr = sandboxRes.headers.get('content-security-policy') || '';
    assert.match(cspHdr, /connect-src https:\/\/api\.example\.com;/);
    assert.equal(cspHdr.includes('127.0.0.1'), false);
  });

  it('pushes redacted live MCP traffic over /events SSE as inspector_trace', async () => {
    const ac = new AbortController();
    const sseRes = await fetch(`${baseUrl}/events`, {
      headers: { Cookie: ownerCookie, Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let gotTrace = null;

    const readLoop = (async () => {
      try {
        while (!gotTrace) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split('\n\n');
          buf = frames.pop() || '';
          for (const frame of frames) {
            if (frame.includes('event: inspector_trace')) {
              const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
              if (dataLine) gotTrace = JSON.parse(dataLine.slice(5).trim());
            }
          }
        }
      } catch {
        // Expected on abort.
      }
    })();

    await new Promise((r) => setTimeout(r, 50));
    await mcpRpc('tools/call', {
      name: 'loop__search',
      arguments: { type: 'all', query: 'sk-live-never-leak-99887766' },
    });

    await Promise.race([readLoop, new Promise((r) => setTimeout(r, 2000))]);
    ac.abort();
    await readLoop;

    assert.ok(gotTrace, 'Expected inspector_trace SSE event');
    assert.equal(gotTrace.source, 'mcp');
    assert.equal(gotTrace.method, 'tools/call');
    assert.equal(JSON.stringify(gotTrace).includes('sk-live-never-leak-99887766'), false);
  });

  it('rejects unknown or invalid /api/inspector/elicit/:id responses cleanly', async () => {
    const unauth = await fetch(`${baseUrl}/api/inspector/elicit/iel_0123456789abcdef`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept' }),
    });
    assert.equal(unauth.status, 401);

    const missing = await api('/api/inspector/elicit/iel_0123456789abcdef', {
      method: 'POST',
      body: JSON.stringify({ action: 'accept' }),
    });
    assert.equal(missing.status, 404);
  });
});
