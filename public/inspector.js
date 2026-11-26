import { getAuthStatus, loadClerkApp } from './clerk-app.js';

const MCP_APP_EXTENSION = 'io.modelcontextprotocol/ui';
const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
const MCP_APP_PROTOCOL_VERSION = '2026-01-26';
const BUILTIN_TOOL_WIDGET_URIS = {
  loop__search: 'ui://loop/search',
  loop__inspect: 'ui://loop/inspect',
  loop__run: 'ui://loop/run',
  loop__save: 'ui://loop/save',
  loop__show: 'ui://loop/show',
};

const els = {
  endpoint: document.getElementById('insp-endpoint'),
  agentSelect: document.getElementById('insp-agent'),
  profileSelect: document.getElementById('insp-profile'),
  uiCapCheck: document.getElementById('insp-ui-cap'),
  elicitCapCheck: document.getElementById('insp-elicit-cap'),
  connectBtn: document.getElementById('insp-connect-btn'),
  themeBtn: document.getElementById('insp-theme-btn'),
  banner: document.getElementById('insp-banner'),
  filterInput: document.getElementById('insp-filter'),
  refreshBtn: document.getElementById('insp-refresh-btn'),
  sideList: document.getElementById('insp-side-list'),
  reqTitle: document.getElementById('insp-req-title'),
  reqSub: document.getElementById('insp-req-sub'),
  streamArgsCheck: document.getElementById('insp-stream-args'),
  rawToggle: document.getElementById('insp-raw-toggle'),
  runBtn: document.getElementById('insp-run-btn'),
  tabTraffic: document.getElementById('insp-tab-traffic'),
  presets: document.getElementById('insp-presets'),
  schemaWrap: document.getElementById('insp-schema-wrap'),
  schemaSummary: document.getElementById('insp-schema-summary'),
  schemaForm: document.getElementById('insp-schema-form'),
  editorLabel: document.getElementById('insp-editor-label'),
  copyRpcBtn: document.getElementById('insp-copy-rpc'),
  copyCurlBtn: document.getElementById('insp-copy-curl'),
  jsonInput: document.getElementById('insp-json-input'),
  formatBtn: document.getElementById('insp-format-btn'),
  reqMeta: document.getElementById('insp-req-meta'),
  statusPill: document.getElementById('insp-status-pill'),
  latency: document.getElementById('insp-latency'),
  outWidget: document.getElementById('insp-out-widget'),
  outResponse: document.getElementById('insp-out-response'),
  outProtocol: document.getElementById('insp-out-protocol'),
  widgetBar: document.getElementById('insp-widget-bar'),
  widgetUri: document.getElementById('insp-widget-uri'),
  widgetCspBtn: document.getElementById('insp-widget-csp'),
  widgetAlt: document.getElementById('insp-widget-alt'),
  widgetState: document.getElementById('insp-widget-state'),
  widgetReload: document.getElementById('insp-widget-reload'),
  widgetEmpty: document.getElementById('insp-widget-empty'),
  widgetStage: document.getElementById('insp-widget-stage'),
  sandboxFrame: document.getElementById('insp-sandbox-frame'),
  responsePre: document.getElementById('insp-response-pre'),
  protocolList: document.getElementById('insp-protocol-list'),
  clearLogBtn: document.getElementById('insp-clear-log'),
  elicitDialog: document.getElementById('insp-elicit-dialog'),
  elicitMode: document.getElementById('insp-elicit-mode'),
  elicitGuard: document.getElementById('insp-elicit-guard'),
  elicitTitle: document.getElementById('insp-elicit-title'),
  elicitMsg: document.getElementById('insp-elicit-msg'),
  elicitForm: document.getElementById('insp-elicit-form'),
  elicitUrlBox: document.getElementById('insp-elicit-url-box'),
  elicitUrl: document.getElementById('insp-elicit-url'),
  elicitOpenUrl: document.getElementById('insp-elicit-open-url'),
  elicitCancel: document.getElementById('insp-elicit-cancel'),
  elicitDecline: document.getElementById('insp-elicit-decline'),
  elicitAccept: document.getElementById('insp-elicit-accept'),
};

const LOOP_TOOL_PRESETS = {
  loop__search: [
    { label: 'Overview (all)', args: { type: 'all' } },
    { label: 'Connections', args: { type: 'connections' } },
    { label: 'Tools', args: { type: 'tools', limit: 12 } },
    { label: 'Skills', args: { type: 'skills' } },
    { label: 'Memory', args: { type: 'memory' } },
    { label: 'Vault metadata', args: { type: 'vault' } },
  ],
  loop__inspect: [
    { label: 'Doctor check', args: { type: 'doctor' } },
    { label: 'Active project', args: { type: 'project' } },
    { label: 'System Loop guide', args: { type: 'skill', id: 'system:loop' } },
  ],
  loop__run: [
    { label: 'Discover local agents', args: { tool: 'loop_host__discover', arguments: { scope: 'all' } } },
  ],
  loop__save: [
    {
      label: 'Preview categories (dryRun)',
      args: { type: 'category', dryRun: true, data: { createCategories: [{ label: 'Analytics', description: 'Metrics and charts' }] } },
    },
    { label: 'Vault capture link', args: { type: 'api_key', action: 'capture', id: 'Example Service' } },
  ],
};

const state = {
  clerk: null,
  context: null,
  sessionId: null,
  sideTab: 'tools',
  outTab: 'widget',
  rawMode: false,
  selected: null, // { kind: 'tool' | 'widget' | 'resource' | 'prompt' | 'raw', item }
  tools: [],
  resources: [],
  prompts: [],
  trace: [],
  audit: null,
  wireLog: [],
  widgetTheme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  sandboxReady: false,
  sandboxSrc: '',
  widgetInitialized: false,
  activeWidgetUri: null,
  altWidgetUri: null,
  activeWidgetHtml: null,
  activeWidgetCsp: null,
  optInCspUris: new Set(),
  pendingToolInput: null,
  pendingToolResult: null,
  widgetCache: new Map(), // uri -> { html, csp }
  sseConnected: false,
  sseSource: null,
  sseReconnectTimer: null,
  pollTimer: null,
  replaySource: null, // { id, agentId, agentName, profile, ok, missingAgent }
  activeElicit: null,
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function safeHttpUrl(raw) {
  if (typeof raw !== 'string') return '';
  try {
    const u = new URL(raw.trim());
    if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password) return u.href;
  } catch {
    return '';
  }
  return '';
}

function showBanner(msg, { isError = false, linkHref = '', linkText = '' } = {}) {
  els.banner.textContent = '';
  els.banner.className = `insp-banner${isError ? ' is-err' : ''}`;
  els.banner.appendChild(document.createTextNode(msg));
  if (linkHref && linkText) {
    els.banner.appendChild(document.createTextNode(' '));
    const a = el('a', '', linkText);
    a.href = linkHref;
    els.banner.appendChild(a);
  }
  els.banner.hidden = false;
}

function clearBanner() {
  els.banner.hidden = true;
  els.banner.textContent = '';
}

function setStatus(label, tone = '', latencyMs = null) {
  els.statusPill.textContent = label;
  els.statusPill.className = `insp-pill${tone ? ` is-${tone}` : ''}`;
  els.latency.textContent = Number.isFinite(latencyMs) ? `${Math.round(latencyMs)} ms` : '';
}

function setWidgetStatus(label, tone = '') {
  els.widgetState.textContent = label;
  els.widgetState.className = `insp-pill${tone ? ` is-${tone}` : ''}`;
}

function summarizeWirePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const contents = payload?.result?.contents;
  if (Array.isArray(contents) && contents.some((c) => c?.mimeType === MCP_APP_MIME_TYPE && typeof c?.text === 'string' && c.text.length > 500)) {
    return {
      ...payload,
      result: {
        ...payload.result,
        contents: contents.map((c) => (
          c?.mimeType === MCP_APP_MIME_TYPE && typeof c?.text === 'string' && c.text.length > 500
            ? { ...c, text: `[MCP App HTML bundle, ${(c.text.length / 1024).toFixed(1)} KB]` }
            : c
        )),
      },
    };
  }
  return payload;
}

function appendWireLog(direction, label, payload) {
  state.wireLog.unshift({
    at: new Date().toLocaleTimeString(),
    direction,
    label,
    payload: summarizeWirePayload(payload),
  });
  if (state.wireLog.length > 80) state.wireLog.length = 80;
  renderWireLog();
}

function renderWireLog() {
  els.protocolList.textContent = '';
  if (state.wireLog.length === 0) {
    els.protocolList.appendChild(el('div', 'insp-empty', 'No wire messages yet.'));
    return;
  }
  for (const row of state.wireLog) {
    const card = el('div', 'insp-proto-row');
    const head = el('div', 'insp-item-top');
    const left = el('div', 'insp-badges');
    const tone = row.direction.includes('Err') ? 'no' : row.direction.includes('Widget') ? 'info' : 'ok';
    left.appendChild(el('span', `insp-pill is-${tone}`, row.direction));
    left.appendChild(el('strong', '', row.label));
    head.appendChild(left);
    head.appendChild(el('span', 'insp-muted', row.at));
    card.appendChild(head);
    const pre = el('pre', '', typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload, null, 2));
    card.appendChild(pre);
    els.protocolList.appendChild(card);
  }
}

async function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (state.clerk?.session) {
    const tok = await state.clerk.session.getToken().catch(() => null);
    if (tok) headers.Authorization = `Bearer ${tok}`;
  }
  return headers;
}

async function api(route, opts = {}) {
  const headers = await authHeaders();
  const res = await fetch(route, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...opts,
    headers: { ...headers, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = new Error(json?.error || `Request failed (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function rpcCall(method, params = {}) {
  const payload = {
    rpc: { jsonrpc: '2.0', method, params },
    agentId: els.agentSelect.value || null,
    profile: els.profileSelect.value || 'all',
    sessionId: state.sessionId,
    mcpApps: els.uiCapCheck.checked,
    elicit: Boolean(els.elicitCapCheck?.checked),
  };
  appendWireLog('Client -> MCP', method, payload.rpc);
  const out = await api('/api/inspector/rpc', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (out.sessionId) state.sessionId = out.sessionId;
  const isErr = Boolean(out.response?.error || out.response?.result?.isError);
  appendWireLog(isErr ? 'MCP -> Client (Err)' : 'MCP -> Client', `${method} (${out.durationMs} ms)`, out.response);
  return out;
}

function setOutTab(tab) {
  state.outTab = tab;
  document.querySelectorAll('[data-out-tab]').forEach((btn) => {
    const active = btn.dataset.outTab === tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  els.outWidget.hidden = tab !== 'widget';
  els.outResponse.hidden = tab !== 'response';
  els.outProtocol.hidden = tab !== 'protocol';
}

function setSideTab(tab) {
  state.sideTab = tab;
  document.querySelectorAll('[data-side-tab]').forEach((btn) => {
    const active = btn.dataset.sideTab === tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  if (tab === 'traffic') refreshTraffic();
  else if (tab === 'checks') refreshAudit();
  else renderSideList();
}

function sendToSandbox(msg) {
  const win = els.sandboxFrame.contentWindow;
  if (!win) return;
  win.postMessage(msg, '*');
}

function pushPendingToWidget() {
  if (!state.widgetInitialized) return;
  if (state.pendingToolInput !== null) {
    const msg = {
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input',
      params: { arguments: state.pendingToolInput },
    };
    appendWireLog('Host -> Widget', 'ui/notifications/tool-input', msg);
    sendToSandbox(msg);
  }
  if (state.pendingToolResult !== null) {
    const msg = {
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: state.pendingToolResult,
    };
    appendWireLog('Host -> Widget', 'ui/notifications/tool-result', msg);
    sendToSandbox(msg);
  }
}

function countCspDomains(csp) {
  if (!csp || typeof csp !== 'object') return 0;
  return ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'].reduce(
    (sum, k) => sum + (Array.isArray(csp[k]) ? csp[k].length : 0),
    0,
  );
}

function listCspDomains(csp) {
  if (!csp || typeof csp !== 'object') return [];
  const out = [];
  for (const k of ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains']) {
    for (const d of Array.isArray(csp[k]) ? csp[k] : []) out.push(`${k}: ${d}`);
  }
  return out;
}

function updateCspButton() {
  const count = countCspDomains(state.activeWidgetCsp);
  if (!state.activeWidgetUri || count === 0) {
    els.widgetCspBtn.hidden = true;
    return;
  }
  const allowed = state.optInCspUris.has(state.activeWidgetUri);
  els.widgetCspBtn.hidden = false;
  els.widgetCspBtn.className = `insp-btn is-sm${allowed ? ' is-primary' : ''}`;
  els.widgetCspBtn.textContent = allowed ? `CSP allowed (${count})` : `Allow CSP (${count})`;
  els.widgetCspBtn.title = allowed
    ? `External widget domains enabled:\n${listCspDomains(state.activeWidgetCsp).join('\n')}\nClick to return to strict connect-src 'none'.`
    : `Blocked by default (connect-src 'none'). Click to allow widget's declared public HTTPS domains:\n${listCspDomains(state.activeWidgetCsp).join('\n')}`;
}

function ensureSandboxLoaded(targetSrc = '/inspector/sandbox') {
  if (state.sandboxSrc !== targetSrc || !els.sandboxFrame.getAttribute('src')) {
    state.sandboxReady = false;
    state.sandboxSrc = targetSrc;
    els.sandboxFrame.setAttribute('src', targetSrc);
  }
}

function waitForWidgetReady(timeoutMs = 3000) {
  if (state.widgetInitialized) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (state.widgetInitialized) return resolve(true);
      if (Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(tick, 30);
    };
    tick();
  });
}

function buildPartialInputSteps(argsObj) {
  if (!argsObj || typeof argsObj !== 'object' || Array.isArray(argsObj)) return [];
  const entries = Object.entries(argsObj);
  if (entries.length === 0) return [{}];
  const steps = [];
  const acc = {};
  for (const [k, v] of entries) {
    if (typeof v === 'string' && v.length > 4) {
      acc[k] = v.slice(0, Math.ceil(v.length / 2));
      steps.push({ ...acc });
    }
    acc[k] = v;
    steps.push({ ...acc });
  }
  return steps.slice(0, 6);
}

async function loadAndShowWidget(uri, { toolInput = null, toolResult = null, altUri = null, forceReload = false } = {}) {
  if (!uri) return;
  state.activeWidgetUri = uri;
  state.altWidgetUri = altUri || null;
  state.pendingToolInput = toolInput;
  state.pendingToolResult = toolResult;
  els.widgetBar.hidden = false;
  els.widgetUri.textContent = uri;
  if (state.altWidgetUri) {
    els.widgetAlt.hidden = false;
    els.widgetAlt.textContent = (state.altWidgetUri.startsWith('ui://loop/') && !state.altWidgetUri.startsWith('ui://loop/upstream/')) ? 'Loop view' : 'App widget';
  } else {
    els.widgetAlt.hidden = true;
  }
  els.widgetEmpty.hidden = true;
  els.widgetStage.hidden = false;
  els.sandboxFrame.style.height = '240px';
  setOutTab('widget');
  setWidgetStatus('Loading...', 'warn');

  let cached = forceReload ? null : state.widgetCache.get(uri);
  if (!cached) {
    const readOut = await rpcCall('resources/read', { uri });
    const content = readOut.response?.result?.contents?.[0];
    if (!content || typeof content.text !== 'string') {
      setWidgetStatus('Read failed', 'no');
      els.responsePre.textContent = JSON.stringify(readOut.response, null, 2);
      return;
    }
    cached = {
      html: content.text,
      csp: readOut.widgetCsp || content._meta?.ui?.csp || null,
    };
    state.widgetCache.set(uri, cached);
  }

  state.activeWidgetHtml = cached.html;
  state.activeWidgetCsp = cached.csp;
  updateCspButton();

  const useOptInCsp = state.optInCspUris.has(uri) && countCspDomains(cached.csp) > 0;
  const targetSandboxSrc = useOptInCsp
    ? `/inspector/sandbox?csp=${encodeURIComponent(JSON.stringify(cached.csp))}`
    : '/inspector/sandbox';

  state.widgetInitialized = false;
  ensureSandboxLoaded(targetSandboxSrc);
  if (state.sandboxReady) {
    sendToSandbox({
      jsonrpc: '2.0',
      method: 'ui/notifications/sandbox-resource-ready',
      params: { html: cached.html },
    });
  }
}

// Official SEP-1865 MCP Apps Host message listener for the sandboxed iframe.
window.addEventListener('message', async (event) => {
  if (event.source !== els.sandboxFrame.contentWindow) return;
  const msg = event.data;
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;

  if (msg.method === 'ui/notifications/sandbox-proxy-ready') {
    state.sandboxReady = true;
    if (state.activeWidgetHtml) {
      sendToSandbox({
        jsonrpc: '2.0',
        method: 'ui/notifications/sandbox-resource-ready',
        params: { html: state.activeWidgetHtml },
      });
    }
    return;
  }

  appendWireLog('Widget -> Host', msg.method || 'reply', msg);

  if (msg.method === 'ui/initialize' && msg.id !== undefined) {
    const reply = {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: MCP_APP_PROTOCOL_VERSION,
        hostInfo: { name: 'loop-inspector', version: '2.0.0' },
        hostCapabilities: { openLinks: {}, serverTools: {} },
        hostContext: { theme: state.widgetTheme },
      },
    };
    appendWireLog('Host -> Widget', 'ui/initialize (result)', reply);
    sendToSandbox(reply);
    return;
  }

  if (msg.method === 'ui/notifications/initialized') {
    state.widgetInitialized = true;
    setWidgetStatus('Connected', 'ok');
    pushPendingToWidget();
    return;
  }

  if (msg.method === 'ui/notifications/size-changed') {
    const h = Number(msg.params?.height);
    if (Number.isFinite(h) && h > 0) {
      const clamped = Math.max(72, Math.min(960, Math.ceil(h) + 8));
      els.sandboxFrame.style.height = `${clamped}px`;
    }
    return;
  }

  if (msg.method === 'ui/open-link' && msg.id !== undefined) {
    const href = safeHttpUrl(msg.params?.url);
    if (!href) {
      sendToSandbox({ jsonrpc: '2.0', id: msg.id, result: { isError: true } });
      return;
    }
    window.open(href, '_blank', 'noopener,noreferrer');
    sendToSandbox({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'tools/call' && msg.id !== undefined) {
    try {
      const out = await rpcCall('tools/call', {
        name: msg.params?.name,
        arguments: msg.params?.arguments || {},
      });
      const reply = out.response?.error
        ? { jsonrpc: '2.0', id: msg.id, error: out.response.error }
        : { jsonrpc: '2.0', id: msg.id, result: out.response?.result || {} };
      appendWireLog('Host -> Widget', `tools/call (${msg.params?.name})`, reply);
      sendToSandbox(reply);
    } catch (err) {
      sendToSandbox({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: err.message || 'Tool call failed' },
      });
    }
  }
});

function buildSchemaForm(schema) {
  els.schemaForm.textContent = '';
  const props = schema && typeof schema.properties === 'object' ? schema.properties : null;
  const entries = props ? Object.entries(props) : [];
  if (entries.length === 0) {
    els.schemaWrap.hidden = true;
    return;
  }
  els.schemaWrap.hidden = false;
  els.schemaSummary.textContent = `Parameters (${entries.length})`;
  els.schemaWrap.open = entries.length <= 5;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);

  const readCurrentArgs = () => {
    try {
      const parsed = JSON.parse(els.jsonInput.value || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  const initialArgs = readCurrentArgs();
  const writeArg = (key, value) => {
    const cur = readCurrentArgs();
    if (value === '' || value === undefined) delete cur[key];
    else cur[key] = value;
    els.jsonInput.value = JSON.stringify(cur, null, 2);
  };

  for (const [key, def] of entries) {
    const field = el('div', 'insp-field');
    const head = el('div', 'insp-field-head');
    head.appendChild(el('span', 'insp-field-name', key));
    const badges = el('div', 'insp-badges');
    if (required.has(key)) badges.appendChild(el('span', 'insp-pill is-warn', 'required'));
    badges.appendChild(el('span', 'insp-pill', def?.type || 'any'));
    head.appendChild(badges);
    field.appendChild(head);

    if (Array.isArray(def?.enum)) {
      const sel = document.createElement('select');
      sel.dataset.paramKey = key;
      sel.dataset.paramType = 'enum';
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '(unset)';
      sel.appendChild(blank);
      for (const opt of def.enum) {
        const o = document.createElement('option');
        o.value = String(opt);
        o.textContent = String(opt);
        if (initialArgs[key] === opt) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => writeArg(key, sel.value || undefined));
      field.appendChild(sel);
    } else if (def?.type === 'boolean') {
      const wrap = el('label', 'insp-field-check');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.paramKey = key;
      cb.dataset.paramType = 'boolean';
      cb.checked = initialArgs[key] === true;
      cb.addEventListener('change', () => writeArg(key, cb.checked ? true : undefined));
      wrap.appendChild(cb);
      wrap.appendChild(el('span', '', 'true'));
      field.appendChild(wrap);
    } else if (def?.type === 'integer' || def?.type === 'number') {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.dataset.paramKey = key;
      inp.dataset.paramType = 'number';
      if (initialArgs[key] !== undefined) inp.value = String(initialArgs[key]);
      inp.placeholder = def.description ? def.description.slice(0, 60) : '';
      inp.addEventListener('input', () => {
        const v = inp.value.trim();
        writeArg(key, v === '' ? undefined : Number(v));
      });
      field.appendChild(inp);
    } else if (def?.type === 'object' || def?.type === 'array') {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.dataset.paramKey = key;
      inp.dataset.paramType = 'json';
      if (initialArgs[key] !== undefined) inp.value = JSON.stringify(initialArgs[key]);
      inp.placeholder = def.type === 'array' ? 'JSON array, e.g. ["a", "b"]' : 'JSON object, e.g. {}';
      inp.addEventListener('change', () => {
        const v = inp.value.trim();
        if (!v) return writeArg(key, undefined);
        try {
          writeArg(key, JSON.parse(v));
        } catch {
          // Leave raw JSON editor editable for complex nested structures.
        }
      });
      field.appendChild(inp);
    } else {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.dataset.paramKey = key;
      inp.dataset.paramType = 'string';
      if (typeof initialArgs[key] === 'string') inp.value = initialArgs[key];
      inp.placeholder = def?.description ? def.description.slice(0, 80) : '';
      inp.addEventListener('input', () => writeArg(key, inp.value || undefined));
      field.appendChild(inp);
    }

    if (def?.description) {
      field.appendChild(el('div', 'insp-field-hint', def.description.slice(0, 180)));
    }
    els.schemaForm.appendChild(field);
  }
}

function syncFormFromJson() {
  let parsed;
  try {
    parsed = els.jsonInput.value.trim() ? JSON.parse(els.jsonInput.value) : {};
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  for (const ctrl of els.schemaForm.querySelectorAll('[data-param-key]')) {
    const key = ctrl.dataset.paramKey;
    const kind = ctrl.dataset.paramType;
    const val = parsed[key];
    if (kind === 'boolean') {
      ctrl.checked = val === true;
    } else if (kind === 'enum') {
      ctrl.value = val !== undefined && val !== null ? String(val) : '';
    } else if (kind === 'number') {
      ctrl.value = typeof val === 'number' && Number.isFinite(val) ? String(val) : '';
    } else if (kind === 'json') {
      ctrl.value = val !== undefined ? JSON.stringify(val) : '';
    } else {
      ctrl.value = typeof val === 'string' ? val : (val !== undefined && val !== null ? String(val) : '');
    }
  }
}

function buildCurrentRpcEnvelope() {
  const raw = els.jsonInput.value.trim();
  const parsed = raw ? JSON.parse(raw) : {};
  if (!state.selected || state.selected.kind === 'raw') {
    return {
      jsonrpc: '2.0',
      id: 1,
      method: typeof parsed?.method === 'string' ? parsed.method : 'tools/list',
      params: parsed?.params && typeof parsed.params === 'object' ? parsed.params : {},
    };
  }
  if (state.selected.kind === 'tool') {
    return {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: state.selected.item.name, arguments: parsed },
    };
  }
  if (state.selected.kind === 'widget' || state.selected.kind === 'resource') {
    return {
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: { uri: parsed?.uri || state.selected.item.uri },
    };
  }
  if (state.selected.kind === 'prompt') {
    return {
      jsonrpc: '2.0',
      id: 1,
      method: 'prompts/get',
      params: { name: state.selected.item.name, arguments: parsed },
    };
  }
  return { jsonrpc: '2.0', id: 1, method: 'ping', params: {} };
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

function flashButtonLabel(btn, nextText) {
  const prev = btn.dataset.origLabel || btn.textContent;
  btn.dataset.origLabel = prev;
  btn.textContent = nextText;
  clearTimeout(Number(btn.dataset.flashTimer || 0));
  const timer = setTimeout(() => {
    btn.textContent = prev;
  }, 1400);
  btn.dataset.flashTimer = String(timer);
}

function renderPresets(toolName) {
  const list = LOOP_TOOL_PRESETS[toolName] || [];
  els.presets.textContent = '';
  if (list.length === 0) {
    els.presets.hidden = true;
    return;
  }
  els.presets.hidden = false;
  for (const preset of list) {
    const btn = el('button', 'insp-btn is-sm', preset.label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      els.jsonInput.value = JSON.stringify(preset.args, null, 2);
      if (state.selected?.kind === 'tool') buildSchemaForm(state.selected.item.inputSchema);
      runSelected();
    });
    els.presets.appendChild(btn);
  }
}

function currentIdentityLabel() {
  const opt = els.agentSelect?.selectedOptions?.[0];
  return opt?.textContent || (els.agentSelect?.value ? els.agentSelect.value : 'Owner (full access)');
}

function renderReplayIdentityBanner() {
  const src = state.replaySource;
  if (!src || state.selected?.kind !== 'raw') return;
  els.reqMeta.hidden = false;
  els.reqMeta.textContent = '';
  const origActor = src.agentName || 'Owner';
  const origProfile = src.profile || 'all';
  const curAgentId = els.agentSelect.value || null;
  const curProfile = els.profileSelect.value || 'all';
  const sameAgent = (src.agentId || null) === curAgentId;
  const sameProfile = origProfile === curProfile;

  els.reqMeta.appendChild(el('strong', '', 'Trace replay'));
  els.reqMeta.appendChild(el('span', 'insp-pill', `Original: ${origActor} (${origProfile})`));
  if (src.missingAgent) {
    els.reqMeta.appendChild(el('span', 'insp-pill is-no', 'Recorded agent unavailable — choose an identity before running'));
    els.runBtn.disabled = true;
    return;
  }
  const mismatch = !sameAgent || !sameProfile;
  els.reqMeta.appendChild(
    el(
      'span',
      `insp-pill ${mismatch ? 'is-warn' : 'is-ok'}`,
      `Replay as: ${currentIdentityLabel()} (${curProfile})${mismatch ? ' · differs from original' : ''}`,
    ),
  );
  els.runBtn.disabled = false;
}

function selectItem(kind, item) {
  state.rawMode = kind === 'raw';
  state.selected = { kind, item };
  if (kind !== 'raw') state.replaySource = null;
  els.runBtn.disabled = false;
  els.rawToggle.textContent = state.rawMode ? 'Structured' : 'Raw RPC';
  els.reqMeta.hidden = true;
  els.reqMeta.textContent = '';

  if (kind === 'raw') {
    els.reqTitle.textContent = 'Raw JSON-RPC Request';
    els.reqSub.textContent = 'Send any MCP method directly to Loop (/api/inspector/rpc).';
    els.reqSub.title = els.reqSub.textContent;
    els.presets.hidden = true;
    els.schemaWrap.hidden = true;
    els.schemaForm.textContent = '';
    els.editorLabel.textContent = 'JSON-RPC Body ({ method, params })';
    if (!els.jsonInput.value.includes('"method"')) {
      els.jsonInput.value = JSON.stringify({ method: 'tools/list', params: {} }, null, 2);
    }
    return;
  }

  if (kind === 'tool') {
    els.reqTitle.textContent = item.name;
    els.reqSub.textContent = item.description || 'MCP tool';
    els.reqSub.title = els.reqSub.textContent;
    els.editorLabel.textContent = 'Tool Arguments JSON';
    els.jsonInput.value = JSON.stringify(LOOP_TOOL_PRESETS[item.name]?.[0]?.args || {}, null, 2);
    buildSchemaForm(item.inputSchema);
    renderPresets(item.name);
    if (item._meta?.ui?.resourceUri) {
      els.reqMeta.hidden = false;
      els.reqMeta.appendChild(el('strong', '', 'Inline Chat Widget (MCP App)'));
      els.reqMeta.appendChild(el('code', '', item._meta.ui.resourceUri));
      const vis = Array.isArray(item._meta.ui.visibility) ? item._meta.ui.visibility.join(', ') : 'model, app';
      els.reqMeta.appendChild(el('span', 'insp-muted', `Visibility: ${vis}`));
    }
  } else if (kind === 'widget' || kind === 'resource') {
    els.reqTitle.textContent = item.name || item.uri;
    els.reqSub.textContent = item.description || item.uri;
    els.reqSub.title = els.reqSub.textContent;
    els.presets.hidden = true;
    els.schemaWrap.hidden = true;
    els.schemaForm.textContent = '';
    els.editorLabel.textContent = 'resources/read Params JSON';
    els.jsonInput.value = JSON.stringify({ uri: item.uri }, null, 2);
    if (kind === 'widget' || item.mimeType === MCP_APP_MIME_TYPE) {
      loadAndShowWidget(item.uri, { toolInput: null, toolResult: null });
    }
  } else if (kind === 'prompt') {
    els.reqTitle.textContent = item.name;
    els.reqSub.textContent = item.description || 'MCP prompt';
    els.reqSub.title = els.reqSub.textContent;
    els.presets.hidden = true;
    els.editorLabel.textContent = 'Prompt Arguments JSON';
    const props = {};
    const required = [];
    for (const a of Array.isArray(item.arguments) ? item.arguments : []) {
      props[a.name] = { type: 'string', description: a.description || '' };
      if (a.required) required.push(a.name);
    }
    els.jsonInput.value = '{}';
    buildSchemaForm({ type: 'object', properties: props, required });
  }
  renderSideList();
}

function renderSideList() {
  els.sideList.textContent = '';
  const q = els.filterInput.value.trim().toLowerCase();

  if (state.sideTab === 'tools') {
    const items = state.tools.filter((t) =>
      !q || t.name.toLowerCase().includes(q) || String(t.description || '').toLowerCase().includes(q),
    );
    if (items.length === 0) {
      els.sideList.appendChild(el('div', 'insp-empty', 'No tools found. Click Initialize to load.'));
      return;
    }
    for (const t of items) {
      const isSelected = state.selected?.kind === 'tool' && state.selected.item?.name === t.name;
      const btn = el('button', `insp-item${isSelected ? ' is-selected' : ''}`);
      btn.type = 'button';
      const top = el('div', 'insp-item-top');
      top.appendChild(el('span', 'insp-item-name', t.name));
      const badges = el('div', 'insp-badges');
      if (t._meta?.ui?.resourceUri) badges.appendChild(el('span', 'insp-pill is-info', 'UI'));
      if (t.annotations?.readOnlyHint) badges.appendChild(el('span', 'insp-pill is-ok', 'read'));
      if (t.annotations?.destructiveHint) badges.appendChild(el('span', 'insp-pill is-no', 'destructive'));
      top.appendChild(badges);
      btn.appendChild(top);
      if (t.description) btn.appendChild(el('div', 'insp-item-desc', t.description));
      btn.addEventListener('click', () => selectItem('tool', t));
      els.sideList.appendChild(btn);
    }
    return;
  }

  if (state.sideTab === 'widgets') {
    const widgets = [
      ...(state.context?.builtInWidgets || []),
      ...(state.context?.upstreamWidgets || []),
    ].filter((w) => !q || w.uri.toLowerCase().includes(q) || String(w.name || '').toLowerCase().includes(q));
    if (widgets.length === 0) {
      els.sideList.appendChild(el('div', 'insp-empty', 'No MCP App widgets available.'));
      return;
    }
    for (const w of widgets) {
      const isSelected = state.selected?.kind === 'widget' && state.selected.item?.uri === w.uri;
      const btn = el('button', `insp-item${isSelected ? ' is-selected' : ''}`);
      btn.type = 'button';
      const top = el('div', 'insp-item-top');
      top.appendChild(el('span', 'insp-item-name', w.name || w.uri));
      top.appendChild(el('span', 'insp-pill is-info', (w.uri.startsWith('ui://loop/') && !w.uri.startsWith('ui://loop/upstream/')) ? 'Loop' : 'Upstream'));
      btn.appendChild(top);
      btn.appendChild(el('div', 'insp-item-desc', w.uri));
      btn.addEventListener('click', () => selectItem('widget', w));
      els.sideList.appendChild(btn);
    }
    return;
  }

  if (state.sideTab === 'resources') {
    const items = state.resources.filter((r) =>
      !q || r.uri.toLowerCase().includes(q) || String(r.name || '').toLowerCase().includes(q),
    );
    if (items.length === 0) {
      els.sideList.appendChild(el('div', 'insp-empty', 'No resources listed for this session.'));
      return;
    }
    for (const r of items) {
      const isSelected = state.selected?.kind === 'resource' && state.selected.item?.uri === r.uri;
      const btn = el('button', `insp-item${isSelected ? ' is-selected' : ''}`);
      btn.type = 'button';
      const top = el('div', 'insp-item-top');
      top.appendChild(el('span', 'insp-item-name', r.name || r.uri));
      if (r.mimeType) top.appendChild(el('span', `insp-pill${r.mimeType === MCP_APP_MIME_TYPE ? ' is-info' : ''}`, r.mimeType === MCP_APP_MIME_TYPE ? 'mcp-app' : r.mimeType));
      btn.appendChild(top);
      btn.appendChild(el('div', 'insp-item-desc', r.uri));
      btn.addEventListener('click', () => selectItem('resource', r));
      els.sideList.appendChild(btn);
    }
    return;
  }

  if (state.sideTab === 'prompts') {
    const items = state.prompts.filter((p) =>
      !q || p.name.toLowerCase().includes(q) || String(p.description || '').toLowerCase().includes(q),
    );
    if (items.length === 0) {
      els.sideList.appendChild(el('div', 'insp-empty', 'No upstream prompts connected.'));
      return;
    }
    for (const p of items) {
      const isSelected = state.selected?.kind === 'prompt' && state.selected.item?.name === p.name;
      const btn = el('button', `insp-item${isSelected ? ' is-selected' : ''}`);
      btn.type = 'button';
      btn.appendChild(el('span', 'insp-item-name', p.name));
      if (p.description) btn.appendChild(el('div', 'insp-item-desc', p.description));
      btn.addEventListener('click', () => selectItem('prompt', p));
      els.sideList.appendChild(btn);
    }
    return;
  }

  if (state.sideTab === 'traffic') {
    const headRow = el('div', 'insp-item-top');
    const leftMeta = el('div', 'insp-badges');
    leftMeta.appendChild(el('span', `insp-pill ${state.sseConnected ? 'is-ok' : 'is-warn'}`, state.sseConnected ? 'Live SSE' : 'Polling'));
    leftMeta.appendChild(el('span', 'insp-muted', `${state.trace.length} call(s)`));
    headRow.appendChild(leftMeta);
    const clearBtn = el('button', 'insp-link-btn', 'Clear');
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', async () => {
      await api('/api/inspector/trace', { method: 'DELETE' });
      state.trace = [];
      updateTrafficTabLabel();
      renderSideList();
    });
    headRow.appendChild(clearBtn);
    els.sideList.appendChild(headRow);

    const items = state.trace.filter((e) =>
      !q || e.method.toLowerCase().includes(q) || String(e.target || '').toLowerCase().includes(q) || String(e.agentName || '').toLowerCase().includes(q),
    );
    if (items.length === 0) {
      els.sideList.appendChild(el('div', 'insp-empty', 'No traffic recorded yet.'));
      return;
    }
    for (const entry of items) {
      const btn = el('button', 'insp-item');
      btn.type = 'button';
      const top = el('div', 'insp-item-top');
      top.appendChild(el('span', 'insp-item-name', entry.target || entry.method));
      const badges = el('div', 'insp-badges');
      badges.appendChild(el('span', `insp-pill ${entry.ok ? 'is-ok' : 'is-no'}`, entry.ok ? `${entry.durationMs}ms` : 'err'));
      badges.appendChild(el('span', 'insp-pill', entry.source === 'mcp' ? 'Live' : 'Insp'));
      top.appendChild(badges);
      btn.appendChild(top);
      btn.appendChild(el('div', 'insp-item-desc', `${entry.agentName} · ${new Date(entry.at).toLocaleTimeString()}`));
      btn.addEventListener('click', () => {
        els.responsePre.textContent = JSON.stringify(entry.response, null, 2);
        const recAgentId = entry.agentId || null;
        const recProfile = entry.profile || 'all';
        const agentOpts = [...(els.agentSelect?.options || [])];
        const profileOpts = [...(els.profileSelect?.options || [])];
        let missingAgent = false;
        if (recAgentId) {
          if (agentOpts.some((o) => o.value === recAgentId)) {
            if (els.agentSelect.value !== recAgentId) state.sessionId = null;
            els.agentSelect.value = recAgentId;
          } else {
            missingAgent = true;
            state.sessionId = null;
          }
        } else {
          if (els.agentSelect.value !== '') state.sessionId = null;
          els.agentSelect.value = '';
        }
        if (profileOpts.some((o) => o.value === recProfile)) {
          if (els.profileSelect.value !== recProfile) state.sessionId = null;
          els.profileSelect.value = recProfile;
        }
        state.replaySource = {
          id: entry.id,
          agentId: recAgentId,
          agentName: entry.agentName || (recAgentId || 'Owner'),
          profile: recProfile,
          ok: entry.ok,
          missingAgent,
        };
        selectItem('raw', entry.request);
        renderReplayIdentityBanner();
        if (missingAgent) {
          showBanner(
            `Recorded agent "${entry.agentName || recAgentId}" is not available. Pick an identity in the toolbar to run this replay.`,
            { isError: true },
          );
        } else {
          clearBanner();
        }
        els.jsonInput.value = JSON.stringify(
          { method: entry.request?.method || entry.method, params: entry.request?.params || {} },
          null,
          2,
        );
        if (entry.widgetUri && entry.response?.result) {
          loadAndShowWidget(entry.widgetUri, {
            toolInput: entry.request?.params?.arguments || null,
            toolResult: entry.response.result,
          });
        } else {
          setOutTab('response');
        }
      });
      els.sideList.appendChild(btn);
    }
    return;
  }

  if (state.sideTab === 'checks') {
    if (!state.audit) {
      els.sideList.appendChild(el('div', 'insp-empty', 'Running checks...'));
      return;
    }
    const s = state.audit.summary;
    const summaryCard = el('div', 'insp-check-card');
    const sumTop = el('div', 'insp-item-top');
    sumTop.appendChild(el('strong', '', 'Connector Readiness'));
    const badges = el('div', 'insp-badges');
    badges.appendChild(el('span', 'insp-pill is-ok', `${s.pass} pass`));
    if (s.warn) badges.appendChild(el('span', 'insp-pill is-warn', `${s.warn} warn`));
    if (s.fail) badges.appendChild(el('span', 'insp-pill is-no', `${s.fail} fail`));
    sumTop.appendChild(badges);
    summaryCard.appendChild(sumTop);
    els.sideList.appendChild(summaryCard);

    for (const check of state.audit.checks) {
      const card = el('div', `insp-check-card is-${check.status}`);
      const top = el('div', 'insp-item-top');
      top.appendChild(el('span', 'insp-item-name', check.title));
      const tone = check.status === 'pass' ? 'ok' : check.status === 'warn' ? 'warn' : 'no';
      top.appendChild(el('span', `insp-pill is-${tone}`, check.status));
      card.appendChild(top);
      card.appendChild(el('div', 'insp-item-desc', check.detail));
      els.sideList.appendChild(card);
    }
  }
}

async function runSelected() {
  if (!state.selected) return;
  let parsed;
  try {
    parsed = els.jsonInput.value.trim() ? JSON.parse(els.jsonInput.value) : {};
  } catch (err) {
    setStatus('Invalid JSON', 'no');
    els.responsePre.textContent = err.message || 'Invalid JSON input.';
    setOutTab('response');
    return;
  }

  els.runBtn.disabled = true;
  setStatus('Running...', 'warn');
  try {
    let out;
    let toolInputForWidget = null;
    const streamEnabled = Boolean(els.streamArgsCheck?.checked);
    const preWidgetUri =
      state.selected.kind === 'tool'
        ? state.selected.item?._meta?.ui?.resourceUri || BUILTIN_TOOL_WIDGET_URIS[state.selected.item?.name] || null
        : null;

    if (streamEnabled && preWidgetUri && state.selected.kind === 'tool') {
      await loadAndShowWidget(preWidgetUri, { toolInput: null, toolResult: null });
      const ready = await waitForWidgetReady(2500);
      if (ready) {
        for (const partial of buildPartialInputSteps(parsed)) {
          const pMsg = {
            jsonrpc: '2.0',
            method: 'ui/notifications/tool-input-partial',
            params: { arguments: partial },
          };
          appendWireLog('Host -> Widget', 'ui/notifications/tool-input-partial', pMsg);
          sendToSandbox(pMsg);
          await new Promise((r) => setTimeout(r, 70));
        }
      }
    }

    if (state.selected.kind === 'raw') {
      if (!parsed || typeof parsed.method !== 'string' || !parsed.method.trim()) {
        throw new Error('Raw RPC JSON must include a "method" string.');
      }
      toolInputForWidget = parsed.params?.arguments || null;
      out = await rpcCall(parsed.method.trim(), parsed.params || {});
    } else if (state.selected.kind === 'tool') {
      toolInputForWidget = parsed;
      out = await rpcCall('tools/call', { name: state.selected.item.name, arguments: parsed });
    } else if (state.selected.kind === 'widget' || state.selected.kind === 'resource') {
      out = await rpcCall('resources/read', { uri: parsed.uri || state.selected.item.uri });
    } else if (state.selected.kind === 'prompt') {
      out = await rpcCall('prompts/get', { name: state.selected.item.name, arguments: parsed });
    }

    const isErr = Boolean(out.response?.error || out.response?.result?.isError);
    setStatus(isErr ? 'Error' : 'OK', isErr ? 'no' : 'ok', out.durationMs);
    els.responsePre.textContent = JSON.stringify(out.response, null, 2);

    if (out.widgetUri && !out.response?.error) {
      const isDirectWidget = state.selected.kind === 'widget' || state.selected.kind === 'resource';
      if (streamEnabled && state.widgetInitialized && state.activeWidgetUri === out.widgetUri && !isDirectWidget) {
        state.altWidgetUri = out.altWidgetUri || null;
        state.pendingToolInput = toolInputForWidget;
        state.pendingToolResult = out.response.result;
        pushPendingToWidget();
      } else {
        await loadAndShowWidget(out.widgetUri, {
          toolInput: isDirectWidget ? null : toolInputForWidget,
          toolResult: isDirectWidget ? null : out.response.result,
          altUri: out.altWidgetUri || null,
        });
      }
    } else {
      setOutTab('response');
    }
  } catch (err) {
    setStatus('Failed', 'no');
    els.responsePre.textContent = err.message || 'Request failed.';
    setOutTab('response');
  } finally {
    els.runBtn.disabled = false;
  }
}

function updateTrafficTabLabel() {
  if (!els.tabTraffic) return;
  els.tabTraffic.textContent = state.trace.length > 0 ? `Traffic (${state.trace.length})` : 'Traffic';
}

function openElicitDialog(payload) {
  if (!payload || !payload.elicitId || !els.elicitDialog) return;
  state.activeElicit = payload;
  appendWireLog('MCP -> Client', 'elicitation/create', payload.rpc || payload.params);
  els.elicitMode.textContent = payload.mode === 'url' ? 'elicitation/create (url)' : 'elicitation/create (form)';
  els.elicitGuard.hidden = !payload.guard;
  els.elicitTitle.textContent = payload.title || 'MCP Elicitation Request';
  els.elicitMsg.textContent = payload.params?.message || 'Confirm this request.';
  els.elicitForm.textContent = '';

  const isUrlMode = payload.mode === 'url' || payload.params?.mode === 'url';
  if (isUrlMode) {
    const safeUrl = safeHttpUrl(payload.params?.url || '');
    els.elicitUrlBox.hidden = !safeUrl;
    els.elicitUrl.textContent = safeUrl;
    els.elicitOpenUrl.onclick = () => {
      if (safeUrl) window.open(safeUrl, '_blank', 'noopener,noreferrer');
    };
    els.elicitAccept.textContent = 'Opened (Wait)';
  } else {
    els.elicitUrlBox.hidden = true;
    els.elicitAccept.textContent = 'Accept';
    const props = payload.params?.requestedSchema?.properties || {};
    for (const [key, def] of Object.entries(props)) {
      const field = el('div', 'insp-field');
      const head = el('div', 'insp-field-head');
      head.appendChild(el('span', 'insp-field-name', def?.title || key));
      field.appendChild(head);
      if (Array.isArray(def?.enum) || Array.isArray(def?.oneOf)) {
        const sel = document.createElement('select');
        sel.dataset.elicitKey = key;
        const choices = Array.isArray(def.oneOf)
          ? def.oneOf.map((o) => ({ value: o.const, label: o.title || o.const }))
          : def.enum.map((v, i) => ({ value: v, label: (Array.isArray(def.enumNames) && def.enumNames[i]) || v }));
        for (const c of choices) {
          const opt = document.createElement('option');
          opt.value = String(c.value);
          opt.textContent = String(c.label);
          if (def.default === c.value) opt.selected = true;
          sel.appendChild(opt);
        }
        field.appendChild(sel);
      } else if (def?.type === 'boolean') {
        const wrap = el('label', 'insp-field-check');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.elicitKey = key;
        cb.dataset.elicitType = 'boolean';
        cb.checked = def.default === true;
        wrap.appendChild(cb);
        wrap.appendChild(el('span', '', def.description || 'Yes'));
        field.appendChild(wrap);
      } else {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.dataset.elicitKey = key;
        if (def?.default !== undefined) inp.value = String(def.default);
        field.appendChild(inp);
      }
      if (def?.description && def?.type !== 'boolean') {
        field.appendChild(el('div', 'insp-field-hint', def.description));
      }
      els.elicitForm.appendChild(field);
    }
  }
  if (!els.elicitDialog.open) els.elicitDialog.showModal();
}

async function submitElicitReply(action) {
  const active = state.activeElicit;
  if (!active) return;
  state.activeElicit = null;
  let content;
  if (action === 'accept' && active.mode !== 'url') {
    content = {};
    for (const ctrl of els.elicitForm.querySelectorAll('[data-elicit-key]')) {
      const k = ctrl.dataset.elicitKey;
      content[k] = ctrl.dataset.elicitType === 'boolean' ? Boolean(ctrl.checked) : ctrl.value;
    }
  }
  if (els.elicitDialog.open) els.elicitDialog.close();
  const replyBody = { action, ...(content ? { content } : {}) };
  appendWireLog('Client -> MCP', `elicitation/create (${action})`, replyBody);
  try {
    await api(`/api/inspector/elicit/${encodeURIComponent(active.elicitId)}`, {
      method: 'POST',
      body: JSON.stringify(replyBody),
    });
  } catch (err) {
    showBanner(err.message || 'Could not submit elicitation response.', { isError: true });
  }
}

function startTrafficPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(() => {
    if (!state.sseConnected) void refreshTraffic();
  }, 2500);
}

function stopTrafficPolling() {
  if (!state.pollTimer) return;
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function connectTraceEvents() {
  if (typeof EventSource !== 'function' || state.sseSource) return;
  try {
    const es = new EventSource('/events');
    state.sseSource = es;
    es.addEventListener('hello', () => {
      state.sseConnected = true;
      stopTrafficPolling();
      void refreshTraffic();
      if (state.sideTab === 'traffic') renderSideList();
    });
    es.addEventListener('inspector_elicit', (ev) => {
      try {
        openElicitDialog(JSON.parse(ev.data));
      } catch {
        // Ignore malformed elicitation frames.
      }
    });
    es.addEventListener('inspector_trace', (ev) => {
      try {
        const entry = JSON.parse(ev.data);
        if (!entry || !entry.id) return;
        if (state.trace.some((e) => e.id === entry.id)) return;
        state.trace.unshift(entry);
        if (state.trace.length > 150) state.trace.length = 150;
        updateTrafficTabLabel();
        if (state.sideTab === 'traffic') renderSideList();
      } catch {
        // Ignore malformed SSE trace frames.
      }
    });
    es.onerror = () => {
      state.sseConnected = false;
      es.close();
      if (state.sseSource === es) state.sseSource = null;
      startTrafficPolling();
      if (state.sideTab === 'traffic') renderSideList();
      clearTimeout(state.sseReconnectTimer);
      state.sseReconnectTimer = setTimeout(() => connectTraceEvents(), 4000);
    };
  } catch {
    state.sseConnected = false;
    startTrafficPolling();
  }
}

async function refreshTraffic() {
  try {
    const data = await api('/api/inspector/trace?limit=80');
    state.trace = Array.isArray(data.entries) ? data.entries : [];
    updateTrafficTabLabel();
    renderSideList();
  } catch (err) {
    showBanner(err.message || 'Could not load traffic.', { isError: true });
  }
}

async function refreshAudit() {
  try {
    state.audit = await api('/api/inspector/audit');
    renderSideList();
  } catch (err) {
    showBanner(err.message || 'Could not run readiness checks.', { isError: true });
  }
}

async function initializeSession() {
  clearBanner();
  setStatus('Initializing...', 'warn');
  state.sessionId = null;
  state.widgetCache.clear();
  try {
    const caps = els.uiCapCheck.checked
      ? { extensions: { [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } } }
      : {};
    const initOut = await rpcCall('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: caps,
      clientInfo: { name: 'loop-inspector', version: '2.0.0' },
    });
    const [toolsOut, resOut, promptsOut] = await Promise.all([
      rpcCall('tools/list', {}),
      rpcCall('resources/list', {}),
      rpcCall('prompts/list', {}),
    ]);
    state.tools = Array.isArray(toolsOut.response?.result?.tools) ? toolsOut.response.result.tools : [];
    state.resources = Array.isArray(resOut.response?.result?.resources) ? resOut.response.result.resources : [];
    state.prompts = Array.isArray(promptsOut.response?.result?.prompts) ? promptsOut.response.result.prompts : [];

    setStatus('Ready', 'ok', initOut.durationMs);
    els.responsePre.textContent = JSON.stringify(initOut.response, null, 2);
    renderSideList();

    if (!state.selected && state.tools.length > 0) {
      selectItem('tool', state.tools[0]);
    }
  } catch (err) {
    setStatus('Auth required', 'no');
    if (err.status === 401) {
      showBanner('Sign in to your Loop dashboard first, then reload this page.', {
        isError: true,
        linkHref: '/',
        linkText: 'Open Loop',
      });
    } else {
      showBanner(err.message || 'Could not initialize MCP session.', { isError: true });
    }
  }
}

async function boot() {
  try {
    const authStatus = await getAuthStatus().catch(() => null);
    if (authStatus?.mode === 'clerk' && authStatus.publishableKey && authStatus.frontendApi) {
      state.clerk = await loadClerkApp(authStatus, false).catch(() => null);
    }
  } catch {
    // Continue with cookie-based local auth.
  }

  try {
    const ctx = await api('/api/inspector/context');
    state.context = ctx;
    els.endpoint.textContent = ctx.endpoint || '/mcp';

    els.agentSelect.textContent = '';
    els.agentSelect.appendChild(el('option', '', 'Owner (full access)'));
    els.agentSelect.options[0].value = '';
    for (const a of ctx.agents || []) {
      const opt = el('option', '', `${a.name}${a.enabled === false ? ' (off)' : ''}`);
      opt.value = a.id;
      els.agentSelect.appendChild(opt);
    }

    els.profileSelect.textContent = '';
    for (const p of ctx.profiles || [{ id: 'all', name: 'All' }]) {
      const opt = el('option', '', p.name || p.id);
      opt.value = p.id;
      els.profileSelect.appendChild(opt);
    }
    await initializeSession();
    connectTraceEvents();
    refreshTraffic().catch(() => {});
  } catch (err) {
    if (err.status === 401) {
      showBanner('Sign in to your Loop dashboard first, then reload MCP Inspector.', {
        isError: true,
        linkHref: '/',
        linkText: 'Open Loop',
      });
    } else {
      showBanner(err.message || 'Could not load Loop Inspector context.', { isError: true });
    }
  }
}

document.querySelectorAll('[data-side-tab]').forEach((btn) => {
  btn.addEventListener('click', () => setSideTab(btn.dataset.sideTab));
});
document.querySelectorAll('[data-out-tab]').forEach((btn) => {
  btn.addEventListener('click', () => setOutTab(btn.dataset.outTab));
});

els.filterInput.addEventListener('input', () => renderSideList());
els.connectBtn.addEventListener('click', () => initializeSession());
els.agentSelect.addEventListener('change', async () => {
  if (state.replaySource) {
    state.replaySource.missingAgent = false;
    clearBanner();
    renderReplayIdentityBanner();
  }
  await initializeSession();
  if (state.replaySource) renderReplayIdentityBanner();
});
els.profileSelect.addEventListener('change', async () => {
  if (state.replaySource) renderReplayIdentityBanner();
  await initializeSession();
  if (state.replaySource) renderReplayIdentityBanner();
});
els.uiCapCheck.addEventListener('change', () => initializeSession());
els.refreshBtn.addEventListener('click', () => {
  if (state.sideTab === 'traffic') refreshTraffic();
  else if (state.sideTab === 'checks') refreshAudit();
  else initializeSession();
});
els.runBtn.addEventListener('click', () => runSelected());
els.rawToggle.addEventListener('click', () => {
  if (state.rawMode && state.tools.length > 0) selectItem('tool', state.tools[0]);
  else selectItem('raw', null);
});
els.formatBtn.addEventListener('click', () => {
  try {
    els.jsonInput.value = JSON.stringify(JSON.parse(els.jsonInput.value || '{}'), null, 2);
    syncFormFromJson();
  } catch (err) {
    setStatus('Invalid JSON', 'no');
    els.responsePre.textContent = err.message;
  }
});
els.jsonInput.addEventListener('input', () => syncFormFromJson());
els.jsonInput.addEventListener('keydown', (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter' && !els.runBtn.disabled) {
    ev.preventDefault();
    runSelected();
  }
});
els.copyRpcBtn.addEventListener('click', async () => {
  try {
    const env = buildCurrentRpcEnvelope();
    const ok = await copyTextToClipboard(JSON.stringify(env, null, 2));
    flashButtonLabel(els.copyRpcBtn, ok ? 'Copied RPC' : 'Copy failed');
  } catch (err) {
    setStatus('Invalid JSON', 'no');
    els.responsePre.textContent = err.message;
  }
});
els.copyCurlBtn.addEventListener('click', async () => {
  try {
    const env = buildCurrentRpcEnvelope();
    const endpoint = state.context?.endpoint || `${location.origin}/mcp`;
    const bodyStr = JSON.stringify(env).replace(/'/g, "'\\''");
    const cmd = `curl -sS -X POST '${endpoint}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Accept: application/json, text/event-stream' \\\n  -H 'Authorization: Bearer <LOOP_AGENT_TOKEN>' \\\n  -d '${bodyStr}'`;
    const ok = await copyTextToClipboard(cmd);
    flashButtonLabel(els.copyCurlBtn, ok ? 'Copied cURL' : 'Copy failed');
  } catch (err) {
    setStatus('Invalid JSON', 'no');
    els.responsePre.textContent = err.message;
  }
});
document.querySelectorAll('[data-widget-width]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const w = btn.dataset.widgetWidth;
    document.querySelectorAll('[data-widget-width]').forEach((b) => b.classList.toggle('is-active', b === btn));
    if (w === 'full') delete els.widgetStage.dataset.width;
    else els.widgetStage.dataset.width = w;
  });
});
els.elicitAccept?.addEventListener('click', () => submitElicitReply('accept'));
els.elicitDecline?.addEventListener('click', () => submitElicitReply('decline'));
els.elicitCancel?.addEventListener('click', () => submitElicitReply('cancel'));
els.elicitDialog?.addEventListener('cancel', (ev) => {
  ev.preventDefault();
  submitElicitReply('cancel');
});
els.clearLogBtn.addEventListener('click', () => {
  state.wireLog = [];
  renderWireLog();
});
els.widgetReload.addEventListener('click', () => {
  if (state.activeWidgetUri) {
    loadAndShowWidget(state.activeWidgetUri, {
      toolInput: state.pendingToolInput,
      toolResult: state.pendingToolResult,
      altUri: state.altWidgetUri,
      forceReload: true,
    });
  }
});
els.widgetAlt.addEventListener('click', () => {
  if (state.activeWidgetUri && state.altWidgetUri) {
    const nextUri = state.altWidgetUri;
    const prevUri = state.activeWidgetUri;
    loadAndShowWidget(nextUri, {
      toolInput: state.pendingToolInput,
      toolResult: state.pendingToolResult,
      altUri: prevUri,
    });
  }
});
els.widgetCspBtn.addEventListener('click', () => {
  if (!state.activeWidgetUri || countCspDomains(state.activeWidgetCsp) === 0) return;
  if (state.optInCspUris.has(state.activeWidgetUri)) {
    state.optInCspUris.delete(state.activeWidgetUri);
  } else {
    state.optInCspUris.add(state.activeWidgetUri);
  }
  loadAndShowWidget(state.activeWidgetUri, {
    toolInput: state.pendingToolInput,
    toolResult: state.pendingToolResult,
    altUri: state.altWidgetUri,
  });
});
els.themeBtn.addEventListener('click', () => {
  state.widgetTheme = state.widgetTheme === 'dark' ? 'light' : 'dark';
  els.themeBtn.textContent = state.widgetTheme === 'dark' ? 'Light widget' : 'Dark widget';
  if (state.widgetInitialized) {
    const msg = {
      jsonrpc: '2.0',
      method: 'ui/notifications/host-context-changed',
      params: { theme: state.widgetTheme },
    };
    appendWireLog('Host -> Widget', 'ui/notifications/host-context-changed', msg);
    sendToSandbox(msg);
  }
});

els.themeBtn.textContent = state.widgetTheme === 'dark' ? 'Light widget' : 'Dark widget';
renderWireLog();
boot();
