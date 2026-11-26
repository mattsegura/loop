// Loop MCP Apps (SEP-1865 / io.modelcontextprotocol/ui) inline chat widgets
// and double-iframe sandbox proxy for the local MCP Inspector.
//
// Security invariants:
// - All widgets are self-contained, zero-network HTML bundles (empty CSP domain allowlists).
// - Widgets render untrusted tool payloads exclusively via DOM creation + textContent (no innerHTML).
// - Widgets receive only Loop's already-redacted MCP tool responses (never raw Vault values).
// - Guarded approvals remain owner-confirmed in Loop via ui/open-link; widgets never bypass Guard.

export const MCP_APP_EXTENSION = 'io.modelcontextprotocol/ui';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const MCP_APP_PROTOCOL_VERSION = '2026-01-26';

export const LOOP_WIDGET_URIS = Object.freeze({
  search: 'ui://loop/search',
  inspect: 'ui://loop/inspect',
  run: 'ui://loop/run',
  save: 'ui://loop/save',
  show: 'ui://loop/show',
});

export const LOOP_TOOL_WIDGETS = Object.freeze({
  loop__search: LOOP_WIDGET_URIS.search,
  loop__inspect: LOOP_WIDGET_URIS.inspect,
  loop__run: LOOP_WIDGET_URIS.run,
  loop__save: LOOP_WIDGET_URIS.save,
  loop__show: LOOP_WIDGET_URIS.show,
});

// Tools that attach _meta.ui in live chat tools/list.
// Background agent tools (loop__search, loop__inspect, loop__run) omit _meta.ui
// in chat so hosts render their native compact tool row instead of spawning dozens
// of inline cards. loop__show renders rich visual cards on demand; loop__save
// renders receipts, Vault forms, category diffs, and saved visual cards.
export const LOOP_CHAT_TOOL_WIDGETS = Object.freeze({
  loop__save: LOOP_WIDGET_URIS.save,
  loop__show: LOOP_WIDGET_URIS.show,
});

const STRICT_WIDGET_CSP = Object.freeze({
  connectDomains: [],
  resourceDomains: [],
  frameDomains: [],
  baseUriDomains: [],
});

const PRIVATE_HOST_RE =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?|\[?fe80:.*|\[?fc.*|\[?fd.*)$/i;

function normalizePublicHttpsOrigins(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  const seen = new Set();
  for (const item of rawList) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 256 || /[\s;,'"\\*]/.test(trimmed)) continue;
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) continue;
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) continue;
    if (PRIVATE_HOST_RE.test(parsed.hostname)) continue;
    const origin = parsed.origin.toLowerCase();
    if (seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Validates and normalizes an MCP App widget's declarative _meta.ui.csp object.
 * Allows only public HTTPS origins (no localhost, private IPs, wildcards, or paths).
 */
export function normalizeWidgetCsp(rawCsp) {
  if (!rawCsp || typeof rawCsp !== 'object' || Array.isArray(rawCsp)) {
    return { ...STRICT_WIDGET_CSP };
  }
  return {
    connectDomains: normalizePublicHttpsOrigins(rawCsp.connectDomains),
    resourceDomains: normalizePublicHttpsOrigins(rawCsp.resourceDomains),
    frameDomains: normalizePublicHttpsOrigins(rawCsp.frameDomains),
    baseUriDomains: normalizePublicHttpsOrigins(rawCsp.baseUriDomains),
  };
}

/**
 * Builds an HTTP Content-Security-Policy header for /inspector/sandbox.
 * Defaults strictly to zero external network access; opt-in domains are strictly public HTTPS origins.
 */
export function buildSandboxCsp(rawCsp = null) {
  const csp = normalizeWidgetCsp(rawCsp);
  const total =
    csp.connectDomains.length +
    csp.resourceDomains.length +
    csp.frameDomains.length +
    csp.baseUriDomains.length;
  if (total === 0) return MCP_INSPECTOR_SANDBOX_CSP;
  const resSrc = csp.resourceDomains.join(' ');
  const connectSrc = csp.connectDomains.length > 0 ? csp.connectDomains.join(' ') : "'none'";
  const frameSrc = csp.frameDomains.length > 0 ? csp.frameDomains.join(' ') : "'none'";
  const baseUri = csp.baseUriDomains.length > 0 ? csp.baseUriDomains.join(' ') : "'none'";
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src 'unsafe-inline'${resSrc ? ` ${resSrc}` : ''}`,
    `style-src 'unsafe-inline'${resSrc ? ` ${resSrc}` : ''}`,
    `img-src data: blob:${resSrc ? ` ${resSrc}` : ''}`,
    `font-src data:${resSrc ? ` ${resSrc}` : ''}`,
    `connect-src ${connectSrc}`,
    `frame-src ${frameSrc}`,
    "form-action 'none'",
    `base-uri ${baseUri}`,
    "frame-ancestors 'self'",
  ].join('; ');
}

const WIDGET_SPECS = Object.freeze({
  [LOOP_WIDGET_URIS.search]: Object.freeze({
    kind: 'search',
    uri: LOOP_WIDGET_URIS.search,
    name: 'Loop Search Widget',
    description:
      'Interactive inline chat widget for Loop search results (connections, tools, skills, memory, tasks, saved items, and Vault metadata).',
  }),
  [LOOP_WIDGET_URIS.inspect]: Object.freeze({
    kind: 'inspect',
    uri: LOOP_WIDGET_URIS.inspect,
    name: 'Loop Inspect Widget',
    description:
      'Interactive inline chat widget for inspecting Loop tools, connections, skills, memory, tasks, saved cards, and projects.',
  }),
  [LOOP_WIDGET_URIS.run]: Object.freeze({
    kind: 'run',
    uri: LOOP_WIDGET_URIS.run,
    name: 'Loop Run Widget',
    description:
      'Interactive inline chat widget for upstream tool execution results, batch runs, sign-in handoffs, and approval status.',
  }),
  [LOOP_WIDGET_URIS.save]: Object.freeze({
    kind: 'save',
    uri: LOOP_WIDGET_URIS.save,
    name: 'Loop Save & Organize Widget',
    description:
      'Interactive inline chat widget for Loop save receipts, category organize diffs, Vault capture links, and approvals.',
  }),
  [LOOP_WIDGET_URIS.show]: Object.freeze({
    kind: 'show',
    uri: LOOP_WIDGET_URIS.show,
    name: 'Loop Visual Card Widget',
    description:
      'Clean @json-render/core visual card widget for milestone summaries, metrics, checklists, tables, links, and images across any connected app.',
  }),
});

/**
 * Extracts MCP Apps (SEP-1865) client capability support from MCP initialize capabilities.
 */
export function extractMcpAppCapability(rawCaps) {
  const caps = rawCaps && typeof rawCaps === 'object' && !Array.isArray(rawCaps) ? rawCaps : {};
  const ext =
    (caps.extensions && typeof caps.extensions === 'object' && !Array.isArray(caps.extensions)
      ? caps.extensions[MCP_APP_EXTENSION]
      : null) ||
    (caps.experimental && typeof caps.experimental === 'object' && !Array.isArray(caps.experimental)
      ? caps.experimental[MCP_APP_EXTENSION]
      : null);
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) {
    return { supported: false, mimeTypes: [] };
  }
  const rawMimes = Array.isArray(ext.mimeTypes) ? ext.mimeTypes : [];
  const mimeTypes = rawMimes
    .filter((m) => typeof m === 'string' && m.trim())
    .map((m) => m.trim().toLowerCase())
    .slice(0, 16);
  // Per SEP-1865, declaring the extension with text/html;profile=mcp-app (or empty object) signals support.
  const supported =
    mimeTypes.length === 0 ||
    mimeTypes.some((m) => m === MCP_APP_MIME_TYPE || m.startsWith(`${MCP_APP_MIME_TYPE};`));
  return { supported, mimeTypes: mimeTypes.length > 0 ? mimeTypes : [MCP_APP_MIME_TYPE] };
}

/**
 * Returns the MCP Apps UI metadata block for a built-in Loop tool, or null.
 * Use scope: 'chat' for live chat tools/list (minimal non-spammy cards) and
 * scope: 'all' (default) for /inspector preview and trace resolution.
 */
export function toolUiMeta(toolName, { visibility = ['model', 'app'], scope = 'all' } = {}) {
  const table = scope === 'chat' ? LOOP_CHAT_TOOL_WIDGETS : LOOP_TOOL_WIDGETS;
  const resourceUri = table[toolName];
  if (!resourceUri) return null;
  return {
    ui: {
      resourceUri,
      visibility: Array.isArray(visibility) && visibility.length > 0 ? visibility : ['model', 'app'],
    },
  };
}

/**
 * Attaches _meta.ui metadata to a Loop tool descriptor when inline widgets are enabled.
 * Defaults to scope: 'chat' so high-frequency plumbing tools stay quiet in chat.
 */
export function attachToolUiMeta(tool, { enabled = true, scope = 'chat' } = {}) {
  if (!enabled || !tool || typeof tool !== 'object') return tool;
  const uiMeta = toolUiMeta(tool.name, { scope });
  if (!uiMeta) return tool;
  return {
    ...tool,
    _meta: {
      ...(tool._meta && typeof tool._meta === 'object' ? tool._meta : {}),
      ...uiMeta,
    },
  };
}

/**
 * Normalizes and validates optional _meta.ui metadata from an upstream MCP server tool.
 */
export function normalizeUpstreamToolUiMeta(rawMeta) {
  if (!rawMeta || typeof rawMeta !== 'object' || Array.isArray(rawMeta)) return undefined;
  const ui = rawMeta.ui && typeof rawMeta.ui === 'object' && !Array.isArray(rawMeta.ui)
    ? rawMeta.ui
    : null;
  const rawUri =
    typeof ui?.resourceUri === 'string'
      ? ui.resourceUri.trim()
      : typeof rawMeta['ui/resourceUri'] === 'string'
        ? rawMeta['ui/resourceUri'].trim()
        : '';
  if (!rawUri || rawUri.length > 512) return undefined;
  let parsed;
  try {
    parsed = new URL(rawUri);
  } catch {
    return undefined;
  }
  const proto = parsed.protocol.toLowerCase();
  if (proto !== 'ui:' && proto !== 'https:') return undefined;
  const rawVis = Array.isArray(ui?.visibility) ? ui.visibility : null;
  const visibility = rawVis
    ? [...new Set(rawVis.filter((v) => v === 'model' || v === 'app'))]
    : ['model', 'app'];
  return {
    ui: {
      resourceUri: rawUri,
      visibility: visibility.length > 0 ? visibility : ['model', 'app'],
    },
  };
}

/**
 * Returns the MCP resources/list descriptors for Loop's built-in inline chat widgets.
 */
export function listLoopAppResources() {
  return Object.values(WIDGET_SPECS).map((spec) => ({
    uri: spec.uri,
    name: spec.name,
    description: spec.description,
    mimeType: MCP_APP_MIME_TYPE,
    _meta: {
      ui: {
        csp: { ...STRICT_WIDGET_CSP },
        prefersBorder: true,
      },
    },
  }));
}

export function isLoopAppResourceUri(uri) {
  return typeof uri === 'string' && Object.hasOwn(WIDGET_SPECS, uri);
}

/**
 * Builds a SEP-1865 compliant ui:// proxy URI for an upstream MCP App widget resource.
 */
export function buildUpstreamWidgetUri(connId, rawUpstreamUri) {
  return `ui://loop/upstream/${encodeURIComponent(String(connId || ''))}/${encodeURIComponent(String(rawUpstreamUri || ''))}`;
}

/**
 * Parses a ui://loop/upstream/<connId>/<encodedUri> proxy URI.
 */
export function parseUpstreamWidgetUri(uri) {
  if (typeof uri !== 'string') return null;
  const m = uri.match(/^ui:\/\/loop\/upstream\/([^/]+)\/(.+)$/);
  if (!m) return null;
  try {
    const connId = decodeURIComponent(m[1]);
    const upstreamUri = decodeURIComponent(m[2]);
    if (!connId || !upstreamUri) return null;
    return { connId, upstreamUri };
  } catch {
    return null;
  }
}

/**
 * Returns a standards-compliant MCP resources/read payload for a built-in Loop widget URI.
 */
export function readLoopAppResource(uri) {
  if (!isLoopAppResourceUri(uri)) return null;
  const spec = WIDGET_SPECS[uri];
  return {
    contents: [
      {
        uri: spec.uri,
        mimeType: MCP_APP_MIME_TYPE,
        text: renderLoopWidgetHtml(spec.kind),
        _meta: {
          ui: {
            csp: { ...STRICT_WIDGET_CSP },
            prefersBorder: true,
          },
        },
      },
    ],
  };
}

const SHARED_WIDGET_CSS = `
:root {
  color-scheme: light dark;
  --bg: light-dark(#FDFCFB, #1A1614);
  --card: light-dark(#FFFFFF, #231E1D);
  --tint: light-dark(#F6F1EF, #2A2523);
  --ink: light-dark(#3F2C2A, #F2E7E5);
  --text: light-dark(#4D3533, #E6D8D6);
  --muted: light-dark(#6D5855, #B8A5A1);
  --line: light-dark(#EAE1DE, #342E2C);
  --brand: light-dark(#4D3533, #E6D8D6);
  --ok: light-dark(#2E6B47, #8FC3A2);
  --ok-bg: light-dark(#EBF4EE, #1D2821);
  --warn: light-dark(#8A541C, #E2B07E);
  --warn-bg: light-dark(#FCF3E7, #2A231A);
  --no: light-dark(#A3412F, #F0907D);
  --no-bg: light-dark(#FCECE9, #2D201E);
  --info: light-dark(#3E547F, #B4C3DF);
  --info-bg: light-dark(#EEF1F8, #21252D);
  --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  --mono: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
}
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font: 13px/1.42 var(--sans);
  -webkit-font-smoothing: antialiased;
}
body { padding: 8px 10px; }
.w-shell { display: flex; flex-direction: column; gap: 8px; }
.w-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.w-brand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--ink);
  font-size: 12.5px;
  letter-spacing: -0.01em;
}
.w-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand);
  display: inline-block;
  flex-shrink: 0;
}
.w-sub { color: var(--muted); font-size: 12px; margin: 0; line-height: 1.4; }
.w-clamp-1 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.w-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.w-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}
.w-card.is-compact { padding: 9px 12px; gap: 6px; border-radius: 10px; }
.w-card.is-ok { border-color: color-mix(in srgb, var(--ok) 35%, var(--line)); }
.w-card.is-warn { border-color: color-mix(in srgb, var(--warn) 48%, var(--line)); background: var(--warn-bg); }
.w-card.is-no { border-color: color-mix(in srgb, var(--no) 48%, var(--line)); background: var(--no-bg); }
.w-card.is-info { border-color: color-mix(in srgb, var(--info) 40%, var(--line)); }
.w-kicker {
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.w-card-title { font-weight: 650; color: var(--ink); font-size: 15px; line-height: 1.3; margin: 0; letter-spacing: -0.02em; }
.w-card-head { display: flex; flex-direction: column; gap: 2px; }
.w-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.w-title-wrap {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
  flex-wrap: wrap;
}
.w-title { font-weight: 600; color: var(--ink); font-size: 13px; margin: 0; letter-spacing: -0.01em; }
.w-meta-id {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  word-break: break-all;
}
.w-pills { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.w-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  background: var(--tint);
  color: var(--muted);
  border: 1px solid var(--line);
}
.w-pill.is-ok { background: var(--ok-bg); color: var(--ok); border-color: transparent; }
.w-pill.is-warn { background: var(--warn-bg); color: var(--warn); border-color: transparent; }
.w-pill.is-no { background: var(--no-bg); color: var(--no); border-color: transparent; }
.w-pill.is-info { background: var(--info-bg); color: var(--info); border-color: transparent; }
.w-pill.is-btn { cursor: pointer; background: var(--card); transition: background 0.12s ease; }
.w-pill.is-btn:hover { background: var(--tint); }
.w-pill.is-btn.is-active { background: var(--brand); color: var(--bg); border-color: var(--brand); }
.w-code {
  font-family: var(--mono);
  font-size: 11px;
  background: var(--tint);
  padding: 1px 5px;
  border-radius: 5px;
  color: var(--ink);
  word-break: break-word;
}
.w-pre {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--tint);
  border: 1px solid var(--line);
  font: 11.5px/1.45 var(--mono);
  color: var(--ink);
  overflow-x: auto;
  max-height: 240px;
  white-space: pre-wrap;
  word-break: break-word;
}
.w-btn {
  appearance: none;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--ink);
  font: 500 12px/1 var(--sans);
  padding: 6px 10px;
  border-radius: 7px;
  cursor: pointer;
  transition: background 0.12s ease, opacity 0.12s ease;
}
.w-btn:hover { background: var(--tint); }
.w-btn:disabled { opacity: 0.5; cursor: default; }
.w-btn.is-primary { background: var(--brand); color: var(--bg); border-color: var(--brand); }
.w-btn.is-primary:hover { opacity: 0.9; }
.w-btn.is-ghost {
  border-color: transparent;
  background: transparent;
  color: var(--muted);
  padding: 4px 7px;
  font-size: 11.5px;
}
.w-btn.is-ghost:hover { background: var(--tint); color: var(--ink); }
.w-search { display: flex; gap: 6px; }
.w-input, .w-textarea {
  width: 100%;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--ink);
  border-radius: 7px;
  padding: 5px 9px;
  font: 12.5px/1.4 var(--sans);
}
.w-input:focus, .w-textarea:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--brand) 55%, var(--line));
}
.w-textarea { font-family: var(--mono); font-size: 11.5px; min-height: 70px; resize: vertical; }
.w-list { display: flex; flex-direction: column; gap: 6px; }
.w-list-box {
  border: 1px solid var(--line);
  background: var(--card);
  border-radius: 10px;
  overflow: hidden;
}
.w-item {
  padding: 7px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-bottom: 1px solid var(--line);
}
.w-item:last-child { border-bottom: 0; }
.w-sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.w-kv {
  display: grid;
  grid-template-columns: minmax(80px, 120px) 1fr;
  gap: 4px 10px;
  font-size: 12px;
}
.w-k { color: var(--muted); }
.w-v { color: var(--ink); word-break: break-word; }
.w-table-wrap { overflow-x: auto; }
.w-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.w-table th, .w-table td {
  text-align: left;
  padding: 5px 8px;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}
.w-table tr:last-child td { border-bottom: 0; }
.w-table th { color: var(--muted); font-weight: 600; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; }
.w-details { border: 1px solid var(--line); border-radius: 8px; padding: 6px 9px; background: var(--card); }
.w-details summary { cursor: pointer; font-weight: 500; font-size: 11.5px; color: var(--muted); user-select: none; }
.w-details summary:hover { color: var(--ink); }
.w-details[open] summary { margin-bottom: 6px; color: var(--ink); }
.w-details.is-subtle { border: 0; background: transparent; padding: 2px 0 0; }
.w-details.is-subtle[open] { padding-top: 4px; }
.w-foot {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  padding: 0 2px;
}
.w-empty {
  text-align: center;
  padding: 14px 12px;
  color: var(--muted);
  border: 1px dashed var(--line);
  border-radius: 10px;
  font-size: 12px;
}
.w-img { max-width: 100%; border-radius: 8px; border: 1px solid var(--line); display: block; }
.w-drawer {
  border: 1px solid color-mix(in srgb, var(--info) 45%, var(--line));
  background: var(--tint);
  border-radius: 10px;
  padding: 9px 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.w-stack-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.w-stack-col { display: flex; flex-direction: column; gap: 6px; }
.w-metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 8px;
}
.w-metric {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--tint);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.w-metric.is-ok { background: var(--ok-bg); border-color: transparent; }
.w-metric.is-warn { background: var(--warn-bg); border-color: transparent; }
.w-metric.is-no { background: var(--no-bg); border-color: transparent; }
.w-metric-lbl { font-size: 11px; color: var(--muted); }
.w-metric-val { font-size: 18px; font-weight: 700; color: var(--ink); letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.w-metric-chg { font-size: 11px; color: var(--muted); }
.w-checklist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.w-check-item { display: flex; align-items: center; gap: 7px; font-size: 12.5px; }
.w-check-item.is-done { color: var(--ok); }
.w-divider { border: 0; border-top: 1px solid var(--line); margin: 2px 0; }
.w-link-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  text-align: left;
  width: 100%;
  border: 1px solid var(--line);
  background: var(--tint);
  color: var(--ink);
  border-radius: 9px;
  padding: 9px 11px;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.w-link-card:hover { background: var(--card); border-color: color-mix(in srgb, var(--brand) 40%, var(--line)); }
.w-cta-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.w-btn-cta {
  appearance: none;
  border: 1px solid var(--brand);
  background: var(--brand);
  color: var(--bg);
  font: 600 12.5px/1 var(--sans);
  padding: 9px 14px;
  border-radius: 8px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: opacity 0.12s ease, transform 0.08s ease;
}
.w-btn-cta:hover { opacity: 0.92; }
.w-btn-cta:active { transform: translateY(0.5px); }
.w-btn-cta.is-secondary {
  background: var(--card);
  color: var(--ink);
  border-color: var(--line);
}
.w-btn-cta.is-secondary:hover { background: var(--tint); opacity: 1; }
.w-prog { display: flex; flex-direction: column; gap: 5px; }
.w-prog-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 12px; }
.w-prog-val { font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
.w-prog-track { height: 7px; border-radius: 999px; background: var(--tint); overflow: hidden; border: 1px solid var(--line); }
.w-prog-fill { height: 100%; border-radius: 999px; background: var(--brand); transition: width 0.25s ease; }
.w-prog-fill.is-ok { background: var(--ok); }
.w-prog-fill.is-warn { background: var(--warn); }
.w-prog-fill.is-no { background: var(--no); }
.w-prog-fill.is-info { background: var(--info); }
.w-bars { display: flex; flex-direction: column; gap: 7px; }
.w-bar-row { display: flex; flex-direction: column; gap: 3px; }
.w-bar-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 12px; }
.w-bar-lbl { color: var(--ink); font-weight: 500; }
.w-bar-num { color: var(--muted); font-weight: 600; font-variant-numeric: tabular-nums; }
.w-bar-track { height: 8px; border-radius: 999px; background: var(--tint); overflow: hidden; }
.w-bar-fill { height: 100%; border-radius: 999px; background: var(--brand); }
.w-bar-fill.is-ok { background: var(--ok); }
.w-bar-fill.is-warn { background: var(--warn); }
.w-bar-fill.is-no { background: var(--no); }
.w-bar-fill.is-info { background: var(--info); }
.w-steps { display: flex; flex-direction: column; gap: 0; }
.w-step { display: flex; gap: 10px; position: relative; padding-bottom: 10px; }
.w-step:last-child { padding-bottom: 0; }
.w-step-rail { display: flex; flex-direction: column; align-items: center; width: 18px; flex-shrink: 0; }
.w-step-dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10.5px;
  font-weight: 700;
  background: var(--tint);
  color: var(--muted);
  border: 1px solid var(--line);
  flex-shrink: 0;
}
.w-step-dot.is-done { background: var(--ok-bg); color: var(--ok); border-color: transparent; }
.w-step-dot.is-active { background: var(--brand); color: var(--bg); border-color: var(--brand); }
.w-step-dot.is-error { background: var(--no-bg); color: var(--no); border-color: transparent; }
.w-step-line { width: 1.5px; flex: 1; background: var(--line); margin-top: 3px; min-height: 10px; }
.w-step:last-child .w-step-line { display: none; }
.w-step-body { display: flex; flex-direction: column; gap: 1px; padding-top: 1px; min-width: 0; }
.w-step-lbl { font-weight: 500; color: var(--ink); font-size: 12.5px; }
.w-itemlist { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--card); }
.w-il-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
}
.w-il-row:last-child { border-bottom: 0; }
.w-avatar {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--tint);
  border: 1px solid var(--line);
  color: var(--ink);
  font-size: 11px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  letter-spacing: -0.02em;
}
.w-il-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.w-il-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.w-tabs { display: flex; flex-direction: column; gap: 8px; }
.w-tab-bar {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border-radius: 9px;
  background: var(--tint);
  border: 1px solid var(--line);
  align-self: flex-start;
  flex-wrap: wrap;
}
.w-tab-btn {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--muted);
  font: 500 12px/1 var(--sans);
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.w-tab-btn:hover { color: var(--ink); }
.w-tab-btn.is-active { background: var(--card); color: var(--ink); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }
.w-bold { font-weight: 600; color: var(--ink); }
.w-inline-acts { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
`;

// Shared client runtime injected into every built-in Loop widget HTML bundle.
// Implements the SEP-1865 MCP Apps JSON-RPC 2.0 over postMessage protocol.
const SHARED_WIDGET_RUNTIME_JS = `
(function () {
  const PROTOCOL = ${JSON.stringify(MCP_APP_PROTOCOL_VERSION)};
  const KIND = window.__LOOP_WIDGET_KIND__ || 'search';
  const root = document.getElementById('app');

  let rpcSeq = 1;
  const pending = new Map();
  const state = {
    connected: false,
    hostContext: null,
    toolInput: null,
    streamingInput: false,
    toolResult: null,
    toolError: false,
    cancelled: false,
    activeFilter: 'all',
    expandedBuckets: new Set(),
    drawer: null,
    busy: false,
    runOutputs: {},
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function parseToolId(raw) {
    const str = String(raw || '').trim();
    if (!str) return { conn: '', label: '', raw: '' };
    const sep = str.indexOf('__');
    const connRaw = sep > 0 ? str.slice(0, sep) : '';
    const fnRaw = sep > 0 ? str.slice(sep + 2) : str;
    const toWords = (s) => s
      .replace(new RegExp('([a-z0-9])([A-Z])', 'g'), '$1 $2')
      .replace(new RegExp('[_-]+', 'g'), ' ')
      .trim();
    const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
    const titleCase = (s) => toWords(s).split(' ').filter(Boolean).map(cap).join(' ');
    const conn = connRaw ? titleCase(connRaw) : '';
    const words = toWords(fnRaw);
    const label = words ? cap(words.toLowerCase()) : str;
    return { conn, label, raw: str };
  }

  function humanizeKey(raw) {
    const str = String(raw || '').trim();
    if (!str) return '';
    const spaced = str
      .replace(new RegExp('([a-z0-9])([A-Z])', 'g'), '$1 $2')
      .replace(new RegExp('[_-]+', 'g'), ' ')
      .trim();
    return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase() : str;
  }

  function isValidJsonRenderSpec(spec) {
    return Boolean(
      spec &&
      typeof spec === 'object' &&
      !Array.isArray(spec) &&
      typeof spec.root === 'string' &&
      spec.root &&
      spec.elements &&
      typeof spec.elements === 'object' &&
      !Array.isArray(spec.elements),
    );
  }

  function safeHttpUrl(raw) {
    if (typeof raw !== 'string') return '';
    try {
      const u = new URL(raw.trim());
      if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password) return u.href;
    } catch {}
    return '';
  }

  function safeImageDataUrl(mime, b64) {
    const cleanMime = String(mime || '').toLowerCase().trim();
    if (!new RegExp('^image/(png|jpeg|jpg|webp|gif)$').test(cleanMime)) return '';
    if (typeof b64 !== 'string' || !b64 || b64.length > 4_000_000) return '';
    return 'data:' + cleanMime + ';base64,' + b64;
  }

  function postRpc(msg) {
    try {
      window.parent.postMessage(msg, '*');
    } catch {}
  }

  function requestHost(method, params) {
    const id = 'loop_w_' + (rpcSeq++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('Host did not respond to ' + method));
        }
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      postRpc({ jsonrpc: '2.0', id, method, params: params || {} });
    });
  }

  function notifyHost(method, params) {
    postRpc({ jsonrpc: '2.0', method, params: params || {} });
  }

  let lastH = 0;
  function reportSize() {
    const contentH = root ? Math.ceil(root.getBoundingClientRect().height) + 18 : document.documentElement.scrollHeight;
    const h = Math.max(40, contentH);
    if (Math.abs(h - lastH) < 2) return;
    lastH = h;
    notifyHost('ui/notifications/size-changed', {
      width: Math.ceil(document.documentElement.scrollWidth),
      height: h,
    });
  }

  function applyHostContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return;
    state.hostContext = Object.assign({}, state.hostContext || {}, ctx);
    if (ctx.theme === 'dark' || ctx.theme === 'light') {
      document.documentElement.setAttribute('data-theme', ctx.theme);
    }
    const vars = ctx.styles && ctx.styles.variables;
    if (vars && typeof vars === 'object') {
      const allow = {
        '--color-background-primary': '--bg',
        '--color-background-secondary': '--card',
        '--color-text-primary': '--ink',
        '--color-text-secondary': '--muted',
        '--color-border-primary': '--line',
        '--font-sans': '--sans',
        '--font-mono': '--mono',
      };
      for (const [k, target] of Object.entries(allow)) {
        if (typeof vars[k] === 'string' && vars[k].length < 120) {
          document.documentElement.style.setProperty(target, vars[k]);
        }
      }
      if (typeof vars['--color-text-primary'] === 'string' && vars['--color-text-primary'].length < 120) {
        document.documentElement.style.setProperty('--text', vars['--color-text-primary']);
      }
    }
  }

  function parseToolResult(res) {
    if (!res || typeof res !== 'object') return { parsed: null, text: '', images: [], isError: false };
    const isError = Boolean(res.isError);
    const content = Array.isArray(res.content) ? res.content : [];
    const texts = [];
    const images = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
      if (part.type === 'image') {
        const src = safeImageDataUrl(part.mimeType, part.data);
        if (src) images.push(src);
      }
    }
    const text = texts.join('\\n');
    let parsed = res.structuredContent && typeof res.structuredContent === 'object'
      ? res.structuredContent
      : null;
    if (!parsed && text.trim()) {
      try {
        const candidate = JSON.parse(text);
        if (candidate && typeof candidate === 'object') parsed = candidate;
      } catch {}
    }
    return { parsed, text, images, isError };
  }

  async function openLink(url, btn) {
    const href = safeHttpUrl(url);
    if (!href) return;
    if (btn) btn.disabled = true;
    try {
      const res = await requestHost('ui/open-link', { url: href });
      if (res && res.isError && btn) btn.textContent = 'Copy link from text';
    } catch {
      if (btn) btn.textContent = 'Open in browser: ' + href;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function callTool(name, args) {
    return await requestHost('tools/call', { name, arguments: args || {} });
  }

  function pill(label, tone) {
    return el('span', 'w-pill' + (tone ? ' is-' + tone : ''), label);
  }

  function button(label, onClick, { primary = false, ghost = false, disabled = false } = {}) {
    const cls = 'w-btn' + (primary ? ' is-primary' : ghost ? ' is-ghost' : '');
    const b = el('button', cls, label);
    b.type = 'button';
    b.disabled = Boolean(disabled);
    b.addEventListener('click', onClick);
    return b;
  }

  function kvGrid(pairs) {
    const g = el('div', 'w-kv');
    for (const [k, v, isCode] of pairs) {
      if (v === undefined || v === null || v === '') continue;
      g.appendChild(el('div', 'w-k', k));
      const val = el('div', 'w-v');
      if (isCode) val.appendChild(el('code', 'w-code', String(v)));
      else val.textContent = typeof v === 'object' ? JSON.stringify(v) : String(v);
      g.appendChild(val);
    }
    return g;
  }

  function jsonDetails(label, value, open, subtle = true) {
    const d = el('details', 'w-details' + (subtle ? ' is-subtle' : ''));
    if (open) d.open = true;
    d.appendChild(el('summary', '', label));
    d.appendChild(el('pre', 'w-pre', typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
    return d;
  }

  function renderApprovalCard(data, container) {
    const denied = data.status === 'approval_denied' || data.code === 'denied';
    const guarded = Boolean(data.guard);
    const card = el('div', 'w-card ' + (denied ? 'is-no' : 'is-warn'));
    const head = el('div', 'w-row');
    head.appendChild(el('h3', 'w-title', data.title || (denied ? 'Approval denied' : 'Approval required')));
    const pills = el('div', 'w-pills');
    pills.appendChild(pill(denied ? 'Denied' : guarded ? 'Guard' : 'Pending', denied ? 'no' : 'warn'));
    head.appendChild(pills);
    card.appendChild(head);
    if (data.reason) card.appendChild(el('p', 'w-sub', data.reason));
    const targetInfo = data.target ? parseToolId(data.target) : null;
    const facts = [];
    if (targetInfo && targetInfo.label) {
      facts.push(['Action', targetInfo.conn ? targetInfo.conn + ' · ' + targetInfo.label : targetInfo.label, false]);
    }
    if (data.destination) facts.push(['Destination', data.destination, true]);
    if (facts.length) card.appendChild(kvGrid(facts));
    if (guarded && !denied) {
      card.appendChild(el('p', 'w-sub', 'Guard requires your Loop password on the Loop page.'));
    }
    const acts = el('div', 'w-inline-acts');
    const link = safeHttpUrl(data.confirmUrl || data.approveUrl);
    if (link && !denied) {
      acts.appendChild(button('Open approval in Loop', (ev) => openLink(link, ev.currentTarget), { primary: true }));
    }
    if (!denied && !guarded && data.approvalId && state.toolInput) {
      const checkBtn = button('Check status', async () => {
        checkBtn.disabled = true;
        checkBtn.textContent = 'Checking...';
        try {
          const retryArgs = Object.assign({}, state.toolInput, {
            approvalId: data.approvalId,
            waitForApproval: true,
            waitForApprovalSeconds: 10,
          });
          const res = await callTool(KIND === 'save' ? 'loop__save' : 'loop__run', retryArgs);
          state.toolResult = res;
          render();
        } catch (err) {
          checkBtn.textContent = err.message || 'Check failed';
        } finally {
          checkBtn.disabled = false;
        }
      });
      acts.appendChild(checkBtn);
    }
    if (acts.childNodes.length) card.appendChild(acts);
    container.appendChild(card);
  }

  function renderSignInCard(data, container) {
    const url = safeHttpUrl(data.formUrl || data.signInUrl || data.updateKeyUrl || data.captureUrl || data.inviteUrl);
    if (!url) return false;
    const card = el('div', 'w-card is-info');
    const title = (data.formUrl || data.captureUrl)
      ? 'Save securely in Loop'
      : data.inviteUrl
        ? 'Invite link ready'
        : data.updateKeyUrl
          ? 'Update API key in Loop'
          : 'Sign in through Loop';
    card.appendChild(el('h3', 'w-title', title));
    if (data.message || data.nextStep || data.note) {
      card.appendChild(el('p', 'w-sub', data.message || data.nextStep || data.note));
    }
    const acts = el('div', 'w-inline-acts');
    acts.appendChild(button('Open in Loop', (ev) => openLink(url, ev.currentTarget), { primary: true }));
    card.appendChild(acts);
    container.appendChild(card);
    return true;
  }

  function renderJsonRenderReadOnly(spec, container) {
    if (!isValidJsonRenderSpec(spec)) return false;
    const specState = spec.state && typeof spec.state === 'object' ? spec.state : {};
    const getPath = (path) => {
      if (typeof path !== 'string') return undefined;
      const parts = path.replace(new RegExp('^/+'), '').split('/').filter(Boolean);
      let cur = specState;
      for (const part of parts) {
        if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
        cur = cur[part];
      }
      return cur;
    };
    const resolveProps = (raw) => {
      const out = {};
      for (const [k, v] of Object.entries(raw || {})) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          if (typeof v.$state === 'string') out[k] = getPath(v.$state);
          else if (typeof v.$bindState === 'string') out[k] = getPath(v.$bindState);
          else out[k] = v;
        } else {
          out[k] = v;
        }
      }
      return out;
    };
    const isVis = (cond) => {
      if (cond === undefined || cond === null || cond === true) return true;
      if (cond === false) return false;
      if (Array.isArray(cond)) return cond.every(isVis);
      if (typeof cond !== 'object') return Boolean(cond);
      if (Array.isArray(cond.$and)) return cond.$and.every(isVis);
      if (Array.isArray(cond.$or)) return cond.$or.some(isVis);
      if (typeof cond.$state === 'string') {
        const val = getPath(cond.$state);
        if (Object.hasOwn(cond, 'eq')) return val === cond.eq;
        if (Object.hasOwn(cond, 'neq')) return val !== cond.neq;
        if (cond.not) return !val;
        return Boolean(val);
      }
      return true;
    };
    const toneClass = (t) => (t === 'danger' ? 'no' : t || '');
    const seen = new Set();
    const draw = (key, depth) => {
      if (!key || seen.has(key) || depth > 20) return null;
      const def = spec.elements[key];
      if (!def || typeof def !== 'object') return null;
      if (!isVis(def.visible)) return null;
      seen.add(key);
      const p = resolveProps(def.props);
      const appendChildren = (target) => {
        for (const ck of Array.isArray(def.children) ? def.children : []) {
          const child = draw(ck, depth + 1);
          if (child) target.appendChild(child);
        }
      };
      if (def.type === 'Card') {
        const c = el('div', 'w-card' + (p.tone ? ' is-' + toneClass(p.tone) : ''));
        if (p.kicker || p.title || p.subtitle) {
          const head = el('div', 'w-card-head');
          if (p.kicker) head.appendChild(el('div', 'w-kicker', p.kicker));
          if (p.title) head.appendChild(el('h3', 'w-card-title', p.title));
          if (p.subtitle) head.appendChild(el('p', 'w-sub', p.subtitle));
          c.appendChild(head);
        }
        appendChildren(c);
        return c;
      }
      if (def.type === 'Stack') {
        const s = el('div', p.direction === 'row' ? 'w-stack-row' : 'w-stack-col');
        appendChildren(s);
        return s;
      }
      if (def.type === 'Heading') {
        const tag = p.level === 1 ? 'h2' : p.level === 3 ? 'h4' : 'h3';
        return el(tag, 'w-title', p.text || '');
      }
      if (def.type === 'Text') {
        return el('p', 'w-sub' + (p.bold ? ' w-bold' : ''), p.text || '');
      }
      if (def.type === 'Badge') return pill(p.label || '', toneClass(p.tone));
      if (def.type === 'Alert' || def.type === 'Callout') {
        const a = el('div', 'w-card is-compact is-' + (toneClass(p.tone) || 'info'));
        if (p.title) a.appendChild(el('strong', '', p.title));
        a.appendChild(el('span', '', p.text || ''));
        return a;
      }
      if (def.type === 'Link') {
        const href = safeHttpUrl(p.url);
        if (!href) return el('div', 'w-sub', p.label || p.url || '');
        if (p.variant === 'primary' || p.variant === 'secondary') {
          const wrap = el('div', 'w-cta-row');
          const btn = el('button', 'w-btn-cta' + (p.variant === 'secondary' ? ' is-secondary' : ''));
          btn.type = 'button';
          btn.textContent = (p.label || href) + ' ↗';
          btn.addEventListener('click', (ev) => openLink(href, ev.currentTarget));
          wrap.appendChild(btn);
          if (p.description) wrap.appendChild(el('span', 'w-sub', p.description));
          return wrap;
        }
        const btn = el('button', 'w-link-card');
        btn.type = 'button';
        btn.appendChild(el('strong', '', (p.label || href) + ' ↗'));
        if (p.description) btn.appendChild(el('span', 'w-sub', p.description));
        btn.addEventListener('click', (ev) => openLink(href, ev.currentTarget));
        return btn;
      }
      if (def.type === 'Progress') {
        const maxVal = Number(p.max) > 0 ? Number(p.max) : 100;
        const pct = Math.max(0, Math.min(100, Math.round((Number(p.value || 0) / maxVal) * 100)));
        const box = el('div', 'w-prog');
        const head = el('div', 'w-prog-head');
        head.appendChild(el('span', 'w-bar-lbl', p.label || 'Progress'));
        head.appendChild(el('span', 'w-prog-val', pct + '%'));
        box.appendChild(head);
        const track = el('div', 'w-prog-track');
        const fill = el('div', 'w-prog-fill' + (p.tone ? ' is-' + toneClass(p.tone) : ''));
        fill.style.width = pct + '%';
        track.appendChild(fill);
        box.appendChild(track);
        if (p.caption) box.appendChild(el('div', 'w-sub', p.caption));
        return box;
      }
      if (def.type === 'BarChart') {
        const items = Array.isArray(p.items) ? p.items : [];
        const wrap = el('div', 'w-bars');
        if (p.title) wrap.appendChild(el('div', 'w-title', p.title));
        const maxVal = Math.max(1, ...items.map((it) => Number(it.value) || 0));
        for (const it of items) {
          const row = el('div', 'w-bar-row');
          const top = el('div', 'w-bar-top');
          top.appendChild(el('span', 'w-bar-lbl', it.label || ''));
          top.appendChild(el('span', 'w-bar-num', it.displayValue !== undefined ? it.displayValue : String(it.value ?? 0)));
          row.appendChild(top);
          const track = el('div', 'w-bar-track');
          const pct = Math.max(2, Math.min(100, Math.round(((Number(it.value) || 0) / maxVal) * 100)));
          const fill = el('div', 'w-bar-fill' + (it.tone ? ' is-' + toneClass(it.tone) : ''));
          fill.style.width = pct + '%';
          track.appendChild(fill);
          row.appendChild(track);
          wrap.appendChild(row);
        }
        return wrap;
      }
      if (def.type === 'Steps') {
        const items = Array.isArray(p.items) ? p.items : [];
        const wrap = el('div', 'w-steps');
        const marks = { done: '✓', active: '●', pending: '', error: '!' };
        for (const it of items) {
          const st = it.status || 'pending';
          const row = el('div', 'w-step');
          const rail = el('div', 'w-step-rail');
          rail.appendChild(el('span', 'w-step-dot is-' + st, marks[st] || ''));
          rail.appendChild(el('span', 'w-step-line'));
          row.appendChild(rail);
          const body = el('div', 'w-step-body');
          body.appendChild(el('span', 'w-step-lbl', it.label || ''));
          if (it.detail) body.appendChild(el('span', 'w-sub', it.detail));
          row.appendChild(body);
          wrap.appendChild(row);
        }
        return wrap;
      }
      if (def.type === 'ItemList') {
        const items = Array.isArray(p.items) ? p.items : [];
        const list = el('div', 'w-itemlist');
        const makeMonogram = (t) => {
          const parts = String(t || '').trim().split(new RegExp('\\s+')).filter(Boolean);
          if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
          return String(t || '?').slice(0, 2).toUpperCase();
        };
        for (const it of items) {
          const row = el('div', 'w-il-row');
          row.appendChild(el('span', 'w-avatar', it.monogram || makeMonogram(it.title)));
          const main = el('div', 'w-il-main');
          main.appendChild(el('span', 'w-title w-clamp-1', it.title || ''));
          if (it.subtitle) main.appendChild(el('span', 'w-sub w-clamp-1', it.subtitle));
          row.appendChild(main);
          const right = el('div', 'w-il-right');
          if (it.badge) right.appendChild(pill(it.badge, toneClass(it.badgeTone)));
          const href = it.url ? safeHttpUrl(it.url) : '';
          if (href) {
            const actBtn = button((it.actionLabel || 'Open') + ' ↗', (ev) => openLink(href, ev.currentTarget), {
              primary: it.actionVariant === 'primary',
              ghost: it.actionVariant === 'ghost',
            });
            right.appendChild(actBtn);
          }
          row.appendChild(right);
          list.appendChild(row);
        }
        return list;
      }
      if (def.type === 'Tabs') {
        const tabs = Array.isArray(p.items) ? p.items : [];
        if (!tabs.length) return null;
        const wrap = el('div', 'w-tabs');
        const bar = el('div', 'w-tab-bar');
        const panels = [];
        const btns = [];
        const activate = (idx) => {
          for (let i = 0; i < panels.length; i += 1) {
            panels[i].hidden = i !== idx;
            btns[i].className = 'w-tab-btn' + (i === idx ? ' is-active' : '');
          }
          requestAnimationFrame(reportSize);
        };
        tabs.forEach((t, idx) => {
          const b = el('button', 'w-tab-btn' + (idx === 0 ? ' is-active' : ''), t.label || 'Tab');
          b.type = 'button';
          b.addEventListener('click', () => activate(idx));
          btns.push(b);
          bar.appendChild(b);
          const panel = el('div', 'w-stack-col');
          if (idx !== 0) panel.hidden = true;
          const contentNode = t.elementId ? draw(t.elementId, depth + 1) : null;
          if (contentNode) panel.appendChild(contentNode);
          panels.push(panel);
        });
        wrap.appendChild(bar);
        for (const panel of panels) wrap.appendChild(panel);
        return wrap;
      }
      if (def.type === 'Metric') {
        const m = el('div', 'w-metric' + (p.tone ? ' is-' + toneClass(p.tone) : ''));
        m.appendChild(el('span', 'w-metric-lbl', p.label || ''));
        m.appendChild(el('strong', 'w-metric-val', p.value || ''));
        if (p.change) m.appendChild(el('span', 'w-metric-chg', p.change));
        return m;
      }
      if (def.type === 'MetricGrid') {
        const g = el('div', 'w-metric-grid');
        for (const it of Array.isArray(p.items) ? p.items : []) {
          const m = el('div', 'w-metric' + (it.tone ? ' is-' + toneClass(it.tone) : ''));
          m.appendChild(el('span', 'w-metric-lbl', it.label || ''));
          m.appendChild(el('strong', 'w-metric-val', it.value || ''));
          if (it.change) m.appendChild(el('span', 'w-metric-chg', it.change));
          g.appendChild(m);
        }
        return g;
      }
      if (def.type === 'List') {
        const ul = el(p.ordered ? 'ol' : 'ul', '');
        for (const it of Array.isArray(p.items) ? p.items : []) ul.appendChild(el('li', '', it));
        return ul;
      }
      if (def.type === 'Checklist') {
        const ul = el('ul', 'w-checklist');
        for (const it of Array.isArray(p.items) ? p.items : []) {
          const li = el('li', 'w-check-item' + (it.checked ? ' is-done' : ''));
          li.appendChild(el('span', '', it.checked ? '✓' : '○'));
          li.appendChild(el('span', '', it.label || ''));
          ul.appendChild(li);
        }
        return ul;
      }
      if (def.type === 'Table') {
        const wrap = el('div', 'w-table-wrap');
        const tbl = el('table', 'w-table');
        const cols = Array.isArray(p.columns) ? p.columns : [];
        if (cols.length) {
          const thead = el('thead');
          const hr = el('tr');
          for (const col of cols) hr.appendChild(el('th', '', col));
          thead.appendChild(hr);
          tbl.appendChild(thead);
        }
        const tbody = el('tbody');
        for (const row of Array.isArray(p.rows) ? p.rows : []) {
          const tr = el('tr');
          for (const cell of Array.isArray(row) ? row : []) tr.appendChild(el('td', '', cell));
          tbody.appendChild(tr);
        }
        tbl.appendChild(tbody);
        wrap.appendChild(tbl);
        return wrap;
      }
      if (def.type === 'FactList') {
        return kvGrid((Array.isArray(p.items) ? p.items : []).map((i) => [i.label, i.value, Boolean(i.code)]));
      }
      if (def.type === 'Image') {
        const rawUrl = String(p.url || '').trim();
        const isDataImg = new RegExp('^data:image/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$', 'i').test(rawUrl) && rawUrl.length <= 512000;
        const safeHref = isDataImg ? '' : safeHttpUrl(rawUrl);
        if (!isDataImg && !safeHref) return null;
        const fig = el('div', 'w-stack-col');
        const img = el('img', 'w-img');
        img.src = isDataImg ? rawUrl : safeHref;
        img.alt = String(p.alt || p.caption || 'Visual');
        if (safeHref) {
          img.addEventListener('error', () => {
            img.remove();
            const fallback = el('button', 'w-link-card');
            fallback.type = 'button';
            fallback.appendChild(el('strong', '', (p.alt || p.caption || 'Open image') + ' ↗'));
            fallback.addEventListener('click', (ev) => openLink(safeHref, ev.currentTarget));
            fig.insertBefore(fallback, fig.firstChild);
            reportSize();
          });
        }
        fig.appendChild(img);
        if (p.caption) fig.appendChild(el('div', 'w-sub', p.caption));
        return fig;
      }
      if (def.type === 'CodeBlock') {
        if (p.collapsible) return jsonDetails(p.label || 'Details', p.code || '', false);
        const wrap = el('div', 'w-stack-col');
        if (p.label) wrap.appendChild(el('div', 'w-sub', p.label));
        wrap.appendChild(el('pre', 'w-pre', p.code || ''));
        return wrap;
      }
      if (def.type === 'Divider') return el('hr', 'w-divider');
      return null;
    };
    const node = draw(spec.root, 0);
    if (!node) return false;
    container.appendChild(node);
    return true;
  }

  function renderSchemaTable(schema, container) {
    const props = schema && typeof schema.properties === 'object' ? schema.properties : null;
    const reqSet = new Set(Array.isArray(schema?.required) ? schema.required : []);
    if (!props || Object.keys(props).length === 0) {
      container.appendChild(el('p', 'w-sub', 'No input parameters.'));
      return;
    }
    const wrap = el('div', 'w-table-wrap');
    const tbl = el('table', 'w-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['Parameter', 'Type', 'Description']) hr.appendChild(el('th', '', h));
    thead.appendChild(hr);
    tbl.appendChild(thead);
    const tbody = el('tbody');
    for (const [name, def] of Object.entries(props)) {
      const tr = el('tr');
      const tdName = el('td');
      tdName.appendChild(el('code', 'w-code', name));
      if (reqSet.has(name)) {
        tdName.appendChild(document.createTextNode(' '));
        tdName.appendChild(pill('required', 'warn'));
      }
      const typeText = Array.isArray(def?.enum)
        ? def.enum.join(' | ')
        : (def?.type || 'any');
      tr.appendChild(tdName);
      tr.appendChild(el('td', '', typeText));
      tr.appendChild(el('td', '', def?.description || ''));
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    container.appendChild(wrap);
  }

  function renderSearchView(parsed, rawText, container) {
    const searchBar = el('div', 'w-search');
    const qInput = el('input', 'w-input');
    qInput.type = 'search';
    qInput.placeholder = 'Filter Loop...';
    qInput.value = (state.toolInput && typeof state.toolInput.query === 'string') ? state.toolInput.query : '';
    const runLiveSearch = async () => {
      if (state.busy) return;
      state.busy = true;
      state.drawer = null;
      state.expandedBuckets = new Set();
      render();
      try {
        const nextArgs = Object.assign({}, state.toolInput || {}, { query: qInput.value.trim() || undefined });
        if (!nextArgs.query) delete nextArgs.query;
        state.toolInput = nextArgs;
        state.toolResult = await callTool('loop__search', nextArgs);
      } catch (err) {
        state.toolResult = { isError: true, content: [{ type: 'text', text: err.message || 'Search failed' }] };
      } finally {
        state.busy = false;
        render();
      }
    };
    qInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        runLiveSearch();
      }
    });
    const goBtn = button('Search', runLiveSearch, { disabled: state.busy });
    searchBar.appendChild(qInput);
    searchBar.appendChild(goBtn);
    container.appendChild(searchBar);

    if (!parsed || typeof parsed !== 'object') {
      container.appendChild(jsonDetails('Details', rawText || 'No results.', false));
      return;
    }

    if (parsed.summary && typeof parsed.summary === 'object') {
      const sumPills = el('div', 'w-pills');
      const s = parsed.summary;
      if (typeof s.total === 'number') sumPills.appendChild(pill(s.total + ' connections', 'info'));
      if (typeof s.ready === 'number' && s.ready > 0) sumPills.appendChild(pill(s.ready + ' ready', 'ok'));
      if (typeof s.needsSignIn === 'number' && s.needsSignIn > 0) sumPills.appendChild(pill(s.needsSignIn + ' need sign-in', 'warn'));
      if (typeof s.totalTools === 'number') sumPills.appendChild(pill(s.totalTools + ' tools'));
      if (typeof s.totalSkills === 'number') sumPills.appendChild(pill(s.totalSkills + ' skills'));
      if (typeof s.totalMemories === 'number') sumPills.appendChild(pill(s.totalMemories + ' memories'));
      if (typeof s.totalVault === 'number') sumPills.appendChild(pill(s.totalVault + ' vault'));
      if (sumPills.childNodes.length) container.appendChild(sumPills);
    }

    const connMap = parsed.connections && !Array.isArray(parsed.connections) && typeof parsed.connections === 'object'
      ? parsed.connections
      : null;

    const buckets = [
      ['connections', 'Connections'],
      ['tools', 'Tools'],
      ['skills', 'Skills'],
      ['memory', 'Memory'],
      ['memories', 'Memory'],
      ['tasks', 'Tasks'],
      ['saved', 'Saved'],
      ['items', 'Items'],
      ['schedules', 'Schedules'],
      ['files', 'Files'],
      ['secrets', 'Vault'],
      ['vault', 'Vault'],
      ['categories', 'Categories'],
      ['projects', 'Projects'],
      ['agents', 'Agents'],
    ].filter(([k]) => Array.isArray(parsed[k]) && parsed[k].length > 0);

    if (buckets.length > 1) {
      const pills = el('div', 'w-pills');
      const allBtn = el('button', 'w-pill is-btn' + (state.activeFilter === 'all' ? ' is-active' : ''), 'All');
      allBtn.type = 'button';
      allBtn.addEventListener('click', () => { state.activeFilter = 'all'; render(); });
      pills.appendChild(allBtn);
      for (const [k, label] of buckets) {
        const b = el('button', 'w-pill is-btn' + (state.activeFilter === k ? ' is-active' : ''), label + ' (' + parsed[k].length + ')');
        b.type = 'button';
        b.addEventListener('click', () => { state.activeFilter = k; render(); });
        pills.appendChild(b);
      }
      container.appendChild(pills);
    }

    if (state.drawer) {
      const d = el('div', 'w-drawer');
      const dh = el('div', 'w-row');
      dh.appendChild(el('strong', '', state.drawer.title));
      dh.appendChild(button('Close', () => { state.drawer = null; render(); }, { ghost: true }));
      d.appendChild(dh);
      if (state.drawer.loading) {
        d.appendChild(el('p', 'w-sub', 'Loading details...'));
      } else if (state.drawer.data) {
        renderInspectBody(state.drawer.data, state.drawer.text, d);
      } else {
        d.appendChild(el('pre', 'w-pre', state.drawer.text || 'No details.'));
      }
      container.appendChild(d);
    }

    async function inspectInline(type, id, label) {
      state.drawer = { title: label || id, loading: true, data: null, text: '' };
      render();
      try {
        const res = await callTool('loop__inspect', { type, id });
        const out = parseToolResult(res);
        state.drawer = { title: label || id, loading: false, data: out.parsed, text: out.text };
      } catch (err) {
        state.drawer = { title: label || id, loading: false, data: null, text: err.message || 'Inspect failed' };
      }
      render();
    }

    const visibleBuckets = buckets.filter(([k]) => state.activeFilter === 'all' || state.activeFilter === k);
    if (visibleBuckets.length === 0) {
      container.appendChild(el('div', 'w-empty', parsed.hint || 'No matching items in Loop.'));
      return;
    }

    const DEFAULT_LIMIT = 6;
    for (const [key, label] of visibleBuckets) {
      const allItems = parsed[key];
      const expanded = state.expandedBuckets.has(key);
      const shownItems = expanded ? allItems.slice(0, 30) : allItems.slice(0, DEFAULT_LIMIT);
      const sec = el('div', 'w-list');
      const secHead = el('div', 'w-sec-head');
      secHead.appendChild(el('div', 'w-sub', label + ' (' + allItems.length + ')'));
      if (allItems.length > DEFAULT_LIMIT) {
        const toggleLabel = expanded ? 'Show fewer' : 'Show all ' + Math.min(allItems.length, 30);
        secHead.appendChild(button(toggleLabel, () => {
          if (state.expandedBuckets.has(key)) state.expandedBuckets.delete(key);
          else state.expandedBuckets.add(key);
          render();
        }, { ghost: true }));
      }
      sec.appendChild(secHead);

      const distinctToolConns = key === 'tools'
        ? new Set(allItems.map((it) => {
          const ck = typeof it.tool === 'string' && it.tool.includes('__') ? it.tool.split('__')[0] : '';
          return it.connection || (connMap && connMap[ck]?.name) || ck;
        }).filter(Boolean))
        : null;

      const listBox = el('div', 'w-list-box');
      for (const item of shownItems) {
        const row = el('div', 'w-item');
        const top = el('div', 'w-row');
        const titleWrap = el('div', 'w-title-wrap');
        const rawPrimary = item.tool || item.name || item.title || item.label || item.key || item.slug || item.id || '(item)';
        if (key === 'tools' && item.tool) {
          const parsedTool = parseToolId(item.tool);
          titleWrap.appendChild(el('span', 'w-title', parsedTool.label));
          titleWrap.appendChild(el('span', 'w-meta-id', item.tool));
        } else {
          titleWrap.appendChild(el('span', 'w-title', rawPrimary));
        }
        top.appendChild(titleWrap);

        const right = el('div', 'w-pills');
        if (key === 'connections') {
          const status = item.statusLabel || item.readiness;
          if (status) right.appendChild(pill(status, String(status).toLowerCase() === 'ready' ? 'ok' : 'warn'));
          if (typeof item.toolCount === 'number') right.appendChild(pill(item.toolCount + ' tools'));
          if (item.signInUrl) right.appendChild(button('Sign in', (ev) => openLink(item.signInUrl, ev.currentTarget), { primary: true }));
          if (item.id) right.appendChild(button('Inspect', () => inspectInline('connection', item.id, item.name || item.id), { ghost: true }));
        } else if (key === 'tools') {
          if (item.annotations?.destructiveHint) right.appendChild(pill('Destructive', 'no'));
          const connKey = typeof item.tool === 'string' && item.tool.includes('__') ? item.tool.split('__')[0] : '';
          const connLabel = item.connection || (connMap && connMap[connKey]?.name) || '';
          if (connLabel && distinctToolConns && distinctToolConns.size > 1) right.appendChild(pill(connLabel));
          if (item.tool) right.appendChild(button('Inspect', () => inspectInline('tool', item.tool, parseToolId(item.tool).label), { ghost: true }));
        } else if (key === 'skills') {
          if (item.category) right.appendChild(pill(item.category));
          const sid = item.systemId || item.slug || item.id;
          if (sid) right.appendChild(button('Inspect', () => inspectInline('skill', sid, item.name || sid), { ghost: true }));
        } else if (key === 'vault' || key === 'secrets') {
          if (item.type) right.appendChild(pill(item.type, 'info'));
          if (item.approval && item.approval !== 'auto') right.appendChild(pill(item.approval, item.approval === 'guard' ? 'no' : 'warn'));
          if (item.placeholder) right.appendChild(el('code', 'w-code', item.placeholder));
          if (item.viewInLoop) right.appendChild(button('Open in Loop', (ev) => openLink(item.viewInLoop, ev.currentTarget), { ghost: true }));
        } else if (['memory', 'memories', 'tasks', 'saved', 'items', 'schedules', 'files', 'projects'].includes(key)) {
          if (item.status) right.appendChild(pill(item.status, item.status === 'completed' ? 'ok' : 'info'));
          if (item.kind) right.appendChild(pill(item.kind));
          const inspectType = (key === 'memory' || key === 'memories')
            ? 'memory'
            : key === 'tasks'
              ? 'task'
              : key === 'schedules'
                ? 'schedule'
                : key === 'files'
                  ? 'file'
                  : key === 'projects'
                    ? 'project'
                    : 'saved';
          const iid = item.id || item.key;
          if (iid) right.appendChild(button('Inspect', () => inspectInline(inspectType, iid, rawPrimary), { ghost: true }));
        }
        top.appendChild(right);
        row.appendChild(top);
        const desc = item.description || item.summary || item.content || item.snippet || '';
        if (desc) row.appendChild(el('div', 'w-sub w-clamp-1', String(desc).slice(0, 180)));
        listBox.appendChild(row);
      }
      sec.appendChild(listBox);
      container.appendChild(sec);
    }
  }

  function renderInspectBody(data, rawText, container) {
    if (!data || typeof data !== 'object') {
      container.appendChild(jsonDetails('Details', rawText || 'No inspection data.', false));
      return;
    }
    if (Array.isArray(data.items)) {
      if (data.items.length > 1) {
        container.appendChild(el('div', 'w-sub', data.items.length + ' items'));
      }
      const list = el('div', 'w-list');
      for (const item of data.items) renderInspectBody(item.data || item, '', list);
      container.appendChild(list);
      return;
    }
    if (data.inputSchema) {
      const card = el('div', 'w-card is-compact');
      const head = el('div', 'w-row');
      const rawTool = data.tool || data.name || 'Tool';
      const parsedTool = parseToolId(rawTool);
      const titleWrap = el('div', 'w-title-wrap');
      titleWrap.appendChild(el('h3', 'w-title', parsedTool.label || rawTool));
      if (data.tool) titleWrap.appendChild(el('span', 'w-meta-id', data.tool));
      head.appendChild(titleWrap);

      const pills = el('div', 'w-pills');
      if (data.connection) pills.appendChild(pill(data.connection));
      if (data.annotations?.destructiveHint) pills.appendChild(pill('Destructive', 'no'));
      const pol = data.approvalPolicy?.decision || data.approvalPolicy?.mode;
      if (pol && pol !== 'auto') pills.appendChild(pill(pol === 'guard' ? 'Guard' : 'Approval required', pol === 'guard' ? 'no' : 'warn'));
      if (data.route?.state && data.route.state !== 'ready') pills.appendChild(pill(data.route.state, 'warn'));
      head.appendChild(pills);
      card.appendChild(head);

      if (data.description) card.appendChild(el('p', 'w-sub w-clamp-2', data.description));

      const propCount = data.inputSchema?.properties && typeof data.inputSchema.properties === 'object'
        ? Object.keys(data.inputSchema.properties).length
        : 0;
      if (propCount > 0) {
        const paramBox = el('details', 'w-details is-subtle');
        paramBox.appendChild(el('summary', '', 'Parameters (' + propCount + ')'));
        renderSchemaTable(data.inputSchema, paramBox);
        card.appendChild(paramBox);
      }

      if (data.tool) {
        const outKey = data.tool;
        const runOut = state.runOutputs[outKey] || null;
        const tryBox = el('details', 'w-details is-subtle');
        if (runOut) tryBox.open = true;
        tryBox.appendChild(el('summary', '', 'Run this tool'));
        const body = el('div', 'w-stack-col');
        const ta = el('textarea', 'w-textarea');
        ta.value = '{}';
        const runBtn = button('Run via loop__run', async () => {
          let parsedArgs = {};
          try {
            parsedArgs = ta.value.trim() ? JSON.parse(ta.value) : {};
          } catch {
            state.runOutputs[outKey] = { error: 'Invalid JSON arguments.' };
            render();
            return;
          }
          runBtn.disabled = true;
          runBtn.textContent = 'Running...';
          try {
            const res = await callTool('loop__run', { tool: data.tool, arguments: parsedArgs });
            state.runOutputs[outKey] = parseToolResult(res);
          } catch (err) {
            state.runOutputs[outKey] = { error: err.message || 'Tool call failed.' };
          } finally {
            runBtn.disabled = false;
            runBtn.textContent = 'Run via loop__run';
            render();
          }
        }, { primary: true });
        body.appendChild(ta);
        const btnRow = el('div', 'w-inline-acts');
        btnRow.appendChild(runBtn);
        body.appendChild(btnRow);
        if (runOut) {
          body.appendChild(el('pre', 'w-pre', runOut.error || runOut.text || JSON.stringify(runOut.parsed, null, 2)));
        }
        tryBox.appendChild(body);
        card.appendChild(tryBox);
      }
      container.appendChild(card);
      return;
    }

    const cardSpec = data.ui || data.spec || data.uiSpec || data.item?.ui || data.item?.spec || data.item?.uiSpec;
    let renderedVisualCard = false;
    if (isValidJsonRenderSpec(cardSpec)) {
      renderedVisualCard = renderJsonRenderReadOnly(cardSpec, container);
    }

    const kv = [];
    for (const k of ['id', 'slug', 'status', 'transport', 'readiness', 'categoryLabel', 'scope', 'profile', 'activeProject']) {
      if (data[k] !== undefined && data[k] !== null && data[k] !== '') kv.push([humanizeKey(k), data[k], k === 'id' || k === 'slug']);
    }
    const bodyText = data.content || data.memory?.content || data.task?.content || data.item?.content || '';
    if (renderedVisualCard && kv.length === 0 && !bodyText) {
      const foot = el('div', 'w-foot');
      foot.appendChild(jsonDetails('Raw JSON', data, false, true));
      container.appendChild(foot);
      return;
    }

    const card = el('div', 'w-card');
    const title = data.name || data.title || data.item?.title || data.memory?.title || data.memory?.key || data.task?.title || data.project?.name || data.id || data.item?.id || 'Details';
    card.appendChild(el('h3', 'w-title', title));
    renderSignInCard(data, card);
    if (kv.length) card.appendChild(kvGrid(kv));
    if (bodyText) card.appendChild(el('pre', 'w-pre', bodyText));
    card.appendChild(jsonDetails('Raw JSON', data, false, true));
    container.appendChild(card);
  }

  function renderOrganizeCard(cardData, container) {
    const card = el('div', 'w-card is-info');
    const head = el('div', 'w-row');
    head.appendChild(el('h3', 'w-title', 'Organize categories'));
    const pills = el('div', 'w-pills');
    if (cardData.profile && cardData.profile !== 'all') pills.appendChild(pill(cardData.profile));
    head.appendChild(pills);
    card.appendChild(head);
    const changes = Array.isArray(cardData.changes) ? cardData.changes : [];
    if (changes.length === 0) {
      card.appendChild(el('p', 'w-sub', 'No category changes.'));
    } else {
      const wrap = el('div', 'w-table-wrap');
      const tbl = el('table', 'w-table');
      const thead = el('thead');
      const hr = el('tr');
      for (const h of ['Item', 'Kind', 'Before', 'After']) hr.appendChild(el('th', '', h));
      thead.appendChild(hr);
      tbl.appendChild(thead);
      const tbody = el('tbody');
      const fmt = (v) => v ? (v.label || v.id || 'Set') : 'None';
      for (const ch of changes) {
        const tr = el('tr');
        tr.appendChild(el('td', '', ch.name || ch.id));
        const kd = el('td');
        kd.appendChild(pill(ch.kind || 'item'));
        tr.appendChild(kd);
        tr.appendChild(el('td', '', fmt(ch.before)));
        tr.appendChild(el('td', '', fmt(ch.after)));
        tbody.appendChild(tr);
      }
      tbl.appendChild(tbody);
      wrap.appendChild(tbl);
      card.appendChild(wrap);
    }
    container.appendChild(card);
  }

  function extractConciseFacts(parsed) {
    if (!parsed || typeof parsed !== 'object') return [];
    const pairs = [];
    const skip = new Set(['ok', 'saved', 'created', 'merged', 'fetchingMetadata', 'hasCard']);
    const preferred = ['title', 'displayTitle', 'name', 'message', 'url', 'note', 'key', 'action', 'type', 'connection', 'status', 'deleted', 'echoed'];
    const source = parsed.item && typeof parsed.item === 'object' ? parsed.item : parsed;
    const seen = new Set();
    for (const k of preferred) {
      const v = source[k] !== undefined ? source[k] : parsed[k];
      if (v === undefined || v === null || v === '' || typeof v === 'object' || typeof v === 'boolean') continue;
      const str = String(v);
      if (str.length > 160) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      pairs.push([humanizeKey(k), str, k === 'url' || k === 'key']);
      if (pairs.length >= 4) return pairs;
    }
    if (pairs.length === 0) {
      for (const [k, v] of Object.entries(parsed)) {
        if (skip.has(k) || seen.has(k)) continue;
        if (v === undefined || v === null || v === '' || typeof v === 'object' || typeof v === 'boolean') continue;
        const str = String(v);
        if (str.length > 140) continue;
        pairs.push([humanizeKey(k), str, false]);
        if (pairs.length >= 3) break;
      }
    }
    return pairs;
  }

  function renderRunOrSaveView(parsed, rawText, images, isError, container) {
    if (parsed && (parsed.status === 'approval_required' || parsed.status === 'approval_denied')) {
      renderApprovalCard(parsed, container);
      return;
    }
    if (parsed && (parsed.type === 'organize_categories' || parsed.card?.type === 'organize_categories')) {
      renderOrganizeCard(parsed.card || parsed, container);
      if (parsed.dryRun || parsed.preview) container.appendChild(el('p', 'w-sub', 'Preview only. No categories changed yet.'));
      return;
    }
    if (parsed && renderSignInCard(parsed, container) && (parsed.status === 'input_required' || parsed.formUrl || parsed.captureUrl || parsed.signInUrl || parsed.inviteUrl)) {
      return;
    }

    if (!isError && KIND === 'save') {
      const savedSpec = parsed?.ui || parsed?.spec || parsed?.uiSpec || parsed?.item?.ui || parsed?.item?.spec || parsed?.item?.uiSpec || (parsed?.saved === true ? state.toolInput?.data?.ui : null);
      if (isValidJsonRenderSpec(savedSpec) && renderJsonRenderReadOnly(savedSpec, container)) {
        const foot = el('div', 'w-foot');
        const label = parsed?.item?.displayTitle || parsed?.item?.title || 'Saved to Loop';
        foot.appendChild(el('span', 'w-sub', 'Saved · ' + label));
        foot.appendChild(jsonDetails('Details', parsed, false, true));
        container.appendChild(foot);
        return;
      }
    }

    if (parsed && Array.isArray(parsed.results)) {
      const list = el('div', 'w-list');
      const okCount = parsed.results.filter((r) => r.ok !== false && !r.isError).length;
      const failCount = parsed.results.length - okCount;
      const sumText = parsed.summary || (failCount > 0 ? okCount + ' completed · ' + failCount + ' failed' : okCount + ' completed');
      list.appendChild(el('div', 'w-sub', sumText));
      for (const r of parsed.results) {
        const failed = r.ok === false || Boolean(r.isError);
        const c = el('div', 'w-card is-compact ' + (failed ? 'is-no' : 'is-ok'));
        const top = el('div', 'w-row');
        const info = parseToolId(r.tool || 'Action');
        const titleWrap = el('div', 'w-title-wrap');
        titleWrap.appendChild(el('span', 'w-title', info.label || 'Action'));
        if (info.conn) titleWrap.appendChild(el('span', 'w-sub', info.conn));
        top.appendChild(titleWrap);
        top.appendChild(pill(failed ? 'Error' : r.status || 'OK', failed ? 'no' : 'ok'));
        c.appendChild(top);
        const payload = r.error || r.output || r.result || r.outputs;
        if (failed && payload) {
          c.appendChild(el('p', 'w-sub', typeof payload === 'string' ? payload.slice(0, 260) : JSON.stringify(payload).slice(0, 260)));
        } else if (typeof payload === 'string' && payload.length <= 120) {
          c.appendChild(el('p', 'w-sub', payload));
        } else if (payload !== undefined && payload !== null) {
          c.appendChild(jsonDetails('Details', payload, false, true));
        }
        list.appendChild(c);
      }
      for (const src of images) {
        const img = el('img', 'w-img');
        img.src = src;
        img.alt = 'Output image';
        list.appendChild(img);
      }
      container.appendChild(list);
      return;
    }

    const card = el('div', 'w-card is-compact ' + (isError ? 'is-no' : 'is-ok'));
    const top = el('div', 'w-row');
    const titleWrap = el('div', 'w-title-wrap');
    if (KIND === 'save') {
      const saveTitle =
        parsed?.item?.displayTitle ||
        parsed?.item?.title ||
        parsed?.title ||
        parsed?.name ||
        parsed?.key ||
        (parsed?.deleted === true ? 'Deleted from Loop' : 'Saved to Loop');
      titleWrap.appendChild(el('h3', 'w-title', saveTitle));
      if (state.toolInput?.type) titleWrap.appendChild(el('span', 'w-sub', humanizeKey(state.toolInput.type)));
    } else {
      const info = parseToolId(state.toolInput?.tool || '');
      titleWrap.appendChild(el('h3', 'w-title', info.label || 'Completed'));
      if (info.conn) titleWrap.appendChild(el('span', 'w-sub', info.conn));
    }
    top.appendChild(titleWrap);
    const statusLabel = isError
      ? 'Error'
      : (KIND === 'save' && parsed?.saved === true)
        ? 'Saved'
        : (KIND === 'save' && parsed?.deleted === true)
          ? 'Deleted'
          : 'OK';
    top.appendChild(pill(statusLabel, isError ? 'no' : 'ok'));
    card.appendChild(top);

    for (const src of images) {
      const img = el('img', 'w-img');
      img.src = src;
      img.alt = 'Output image';
      card.appendChild(img);
    }

    if (isError) {
      const errMsg = (parsed && (parsed.error || parsed.message)) || rawText || 'Action failed.';
      card.appendChild(el('p', 'w-sub', String(errMsg).slice(0, 400)));
      if (parsed && typeof parsed === 'object') card.appendChild(jsonDetails('Details', parsed, false, true));
    } else if (parsed && typeof parsed === 'object') {
      const summaryPairs = extractConciseFacts(parsed);
      if (summaryPairs.length) card.appendChild(kvGrid(summaryPairs));
      card.appendChild(jsonDetails('Details', parsed, false, true));
    } else if (rawText) {
      if (rawText.length <= 160) card.appendChild(el('p', 'w-sub', rawText));
      else card.appendChild(jsonDetails('Details', rawText, false, true));
    }
    container.appendChild(card);
  }

  function renderShowView(parsed, rawText, isError, container) {
    if (isError) {
      const card = el('div', 'w-card is-compact is-no');
      const top = el('div', 'w-row');
      top.appendChild(el('h3', 'w-title', 'Could not render card'));
      top.appendChild(pill('Error', 'no'));
      card.appendChild(top);
      card.appendChild(el('p', 'w-sub', String((parsed && (parsed.error || parsed.message)) || rawText || 'Invalid card specification.').slice(0, 400)));
      container.appendChild(card);
      return;
    }
    const spec = parsed?.ui || parsed?.spec || state.toolInput?.ui || null;
    if (isValidJsonRenderSpec(spec) && renderJsonRenderReadOnly(spec, container)) {
      return;
    }
    const card = el('div', 'w-card is-compact');
    card.appendChild(el('h3', 'w-title', parsed?.title || state.toolInput?.title || 'Card'));
    if (parsed?.markdown || rawText) {
      card.appendChild(el('pre', 'w-pre', parsed?.markdown || rawText));
    }
    container.appendChild(card);
  }

  function render() {
    root.textContent = '';
    const shell = el('div', 'w-shell');

    const needsTopBar = KIND === 'search' || !state.toolResult || state.streamingInput || state.busy || state.cancelled;
    if (needsTopBar) {
      const head = el('div', 'w-head');
      const brand = el('div', 'w-brand');
      brand.appendChild(el('span', 'w-dot'));
      const titles = {
        search: 'Loop',
        inspect: 'Loop',
        run: 'Loop',
        save: 'Loop',
        show: 'Loop',
      };
      brand.appendChild(el('span', '', titles[KIND] || 'Loop'));
      head.appendChild(brand);
      const metaPills = el('div', 'w-pills');
      if (state.streamingInput) metaPills.appendChild(pill('Preparing...', 'warn'));
      if (state.busy) metaPills.appendChild(pill('Working...', 'warn'));
      if (state.cancelled) metaPills.appendChild(pill('Cancelled', 'no'));
      if (metaPills.childNodes.length) head.appendChild(metaPills);
      shell.appendChild(head);
    }

    if (!state.toolResult) {
      const empty = el('div', 'w-empty');
      empty.textContent = state.streamingInput
        ? 'Preparing...'
        : state.toolInput
          ? 'Working...'
          : 'Ready.';
      shell.appendChild(empty);
      root.appendChild(shell);
      reportSize();
      return;
    }

    const { parsed, text, images, isError } = parseToolResult(state.toolResult);
    if (KIND === 'search') renderSearchView(parsed, text, shell);
    else if (KIND === 'inspect') renderInspectBody(parsed, text, shell);
    else if (KIND === 'show') renderShowView(parsed, text, isError, shell);
    else renderRunOrSaveView(parsed, text, images, isError, shell);

    root.appendChild(shell);
    reportSize();
  }

  if (root) {
    root.addEventListener('toggle', () => {
      requestAnimationFrame(reportSize);
    }, true);
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
    if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message || 'Host RPC error'));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method === 'ui/notifications/host-context-changed') {
      applyHostContext(msg.params);
      reportSize();
    } else if (msg.method === 'ui/notifications/tool-input') {
      state.toolInput = msg.params?.arguments ?? msg.params ?? null;
      state.streamingInput = false;
      state.cancelled = false;
      render();
    } else if (msg.method === 'ui/notifications/tool-input-partial') {
      state.toolInput = msg.params?.arguments ?? msg.params ?? state.toolInput;
      state.streamingInput = true;
      render();
    } else if (msg.method === 'ui/notifications/tool-result') {
      state.toolResult = msg.params || null;
      state.streamingInput = false;
      state.cancelled = false;
      render();
    } else if (msg.method === 'ui/notifications/tool-cancelled') {
      state.streamingInput = false;
      state.cancelled = true;
      render();
    }
  });

  if (typeof ResizeObserver === 'function' && root) {
    const ro = new ResizeObserver(() => reportSize());
    ro.observe(root);
  }

  render();

  requestHost('ui/initialize', {
    protocolVersion: PROTOCOL,
    appInfo: { name: 'loop-widget-' + KIND, version: '2.0.0' },
    appCapabilities: {},
  }).then((res) => {
    state.connected = true;
    applyHostContext(res && res.hostContext);
    notifyHost('ui/notifications/initialized', {});
    reportSize();
  }).catch(() => {
    // Allow standalone preview even if host does not reply to ui/initialize.
  });
})();
`;

export function extractWidgetScripts(html) {
  if (typeof html !== 'string') return [];
  const scripts = [];
  const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    if (match[1].trim()) scripts.push(match[1]);
  }
  return scripts;
}

export function renderLoopWidgetHtml(kind) {
  const safeKind = Object.hasOwn(LOOP_WIDGET_URIS, kind) ? kind : 'search';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Loop ${safeKind} widget</title>
<style>${SHARED_WIDGET_CSS}</style>
</head>
<body>
<div id="app"></div>
<script>window.__LOOP_WIDGET_KIND__=${JSON.stringify(safeKind)};</script>
<script>${SHARED_WIDGET_RUNTIME_JS}</script>
</body>
</html>`;
}

/**
 * Strict double-iframe sandbox proxy served at GET /inspector/sandbox for the Local MCP Inspector.
 * Runs inside an opaque origin (HTTP CSP sandbox + iframe sandbox="allow-scripts", connect-src 'none')
 * and relays MCP Apps JSON-RPC 2.0 postMessage frames between the Inspector host and guest widget.
 */
export const MCP_INSPECTOR_SANDBOX_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

export const MCP_INSPECTOR_SANDBOX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Loop MCP App Sandbox</title>
<style>
html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
iframe { border: 0; width: 100%; height: 100%; display: block; background: transparent; }
</style>
</head>
<body>
<iframe id="guest" sandbox="allow-scripts" referrerpolicy="no-referrer" title="MCP App Widget"></iframe>
<script>
(function () {
  const guest = document.getElementById('guest');
  const queue = [];
  let guestLoaded = false;

  guest.addEventListener('load', () => {
    guestLoaded = true;
    while (queue.length > 0) {
      const item = queue.shift();
      try { guest.contentWindow.postMessage(item, '*'); } catch {}
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    if (event.source === window.parent) {
      if (msg.jsonrpc === '2.0' && msg.method === 'ui/notifications/sandbox-resource-ready') {
        const html = typeof msg.params?.html === 'string' ? msg.params.html : '';
        guestLoaded = false;
        queue.length = 0;
        guest.srcdoc = html;
        return;
      }
      if (!guestLoaded) {
        queue.push(msg);
      } else {
        try { guest.contentWindow.postMessage(msg, '*'); } catch {}
      }
      return;
    }

    if (event.source === guest.contentWindow) {
      try { window.parent.postMessage(msg, '*'); } catch {}
    }
  });

  try {
    window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }, '*');
  } catch {}
})();
</script>
</body>
</html>`;
