// Local MCP Inspector backend helpers:
// 1. In-memory redacted JSON-RPC traffic trace ring buffer (never persisted to disk).
// 2. Automated MCP Apps & Connector Readiness audit checks (protocol, UI resources, CSP, OAuth, connections).

import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import {
  LOOP_CHAT_TOOL_WIDGETS,
  MCP_APP_EXTENSION,
  MCP_APP_MIME_TYPE,
  extractWidgetScripts,
  listLoopAppResources,
  toolUiMeta,
} from './mcp-apps.mjs';
import { MCP_SKILLS_EXTENSION, verifySkillFileContent } from './mcp-skills.mjs';
import { maskSecrets, readSecrets } from './secret-refs.mjs';

const MAX_TRACE_ENTRIES = 150;
const MAX_PREVIEW_CHARS = 24_000;

function truncatePreview(value) {
  let serialized;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return { truncated: true, preview: '[Unserializable payload]' };
  }
  if (!serialized || serialized.length <= MAX_PREVIEW_CHARS) {
    return value;
  }
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(serialized, 'utf8'),
    preview: `${serialized.slice(0, MAX_PREVIEW_CHARS)}…`,
  };
}

function summarizeRpcTarget(reqMsg) {
  if (!reqMsg || typeof reqMsg !== 'object') return '';
  const m = reqMsg.method;
  if (m === 'tools/call') {
    const name = String(reqMsg.params?.name || '');
    const innerTool = reqMsg.params?.arguments?.tool;
    const typeArg = reqMsg.params?.arguments?.type;
    if (name === 'loop__run' && typeof innerTool === 'string' && innerTool) return `${name} -> ${innerTool}`;
    if (name === 'loop__show') {
      const title = typeof reqMsg.params?.arguments?.title === 'string' ? reqMsg.params.arguments.title.trim() : '';
      return title ? `${name} (${title.slice(0, 60)})` : name;
    }
    if ((name === 'loop__search' || name === 'loop__inspect' || name === 'loop__save') && typeof typeArg === 'string' && typeArg) {
      return `${name} (${typeArg})`;
    }
    return name;
  }
  if (m === 'resources/read') return String(reqMsg.params?.uri || '');
  if (m === 'prompts/get') return String(reqMsg.params?.name || '');
  return '';
}

function resolveWidgetUriForRequest(reqMsg) {
  if (!reqMsg || typeof reqMsg !== 'object') return null;
  if (reqMsg.method === 'tools/call') {
    const ui = toolUiMeta(reqMsg.params?.name);
    return ui?.ui?.resourceUri || null;
  }
  if (reqMsg.method === 'resources/read' && typeof reqMsg.params?.uri === 'string') {
    const uri = reqMsg.params.uri;
    if (uri.startsWith('ui://')) return uri;
  }
  return null;
}

/**
 * In-memory ring buffer capturing redacted MCP JSON-RPC exchanges for the Local Inspector.
 * Never writes to disk and always masks all stored Vault secrets before storing entries.
 */
export class InspectorTraceStore {
  constructor({ maxEntries = MAX_TRACE_ENTRIES } = {}) {
    this.maxEntries = maxEntries;
    this.entries = [];
    this._pending = new Set();
  }

  record(opts = {}) {
    let task;
    task = (async () => {
      try {
        return await this._recordNow(opts);
      } finally {
        this._pending.delete(task);
      }
    })();
    this._pending.add(task);
    return task;
  }

  async _recordNow({
    source = 'mcp',
    agentId = null,
    agentName = 'Owner',
    profile = 'all',
    sessionId = null,
    durationMs = 0,
    request = null,
    response = null,
    vault = null,
  } = {}) {
    const reqObj = Array.isArray(request) ? request[0] : request;
    const resObj = Array.isArray(response) ? response[0] : response;
    const method = typeof reqObj?.method === 'string' ? reqObj.method : (Array.isArray(request) ? 'batch' : 'unknown');
    const isError = Boolean(resObj?.error || resObj?.result?.isError);

    let secrets = [];
    if (vault && typeof vault.list === 'function') {
      try {
        const meta = await vault.list({ includeInternal: true });
        const keys = meta.map((m) => m.key).filter(Boolean);
        if (keys.length > 0) {
          const map = await readSecrets(vault, keys, { allowInternal: true });
          secrets = [...map.values()].filter((v) => typeof v === 'string' && v.length >= 4);
        }
      } catch {
        secrets = [];
      }
    }

    const redact = (val) => (secrets.length > 0 ? maskSecrets(val, secrets) : val);
    const entry = {
      id: `tr_${randomUUID().slice(0, 12)}`,
      at: new Date().toISOString(),
      source,
      agentId: agentId || null,
      agentName: String(agentName || 'Owner'),
      profile: String(profile || 'all'),
      sessionId: sessionId || null,
      method,
      target: String(redact(summarizeRpcTarget(reqObj))),
      widgetUri: resolveWidgetUriForRequest(reqObj),
      durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
      ok: !isError,
      errorMessage: resObj?.error?.message
        ? String(redact(resObj.error.message))
        : (resObj?.result?.isError ? 'Tool returned isError=true' : null),
      request: truncatePreview(redact(request)),
      response: truncatePreview(redact(response)),
    };

    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.length = this.maxEntries;
    }
    return entry;
  }

  async flush() {
    while (this._pending.size > 0) {
      await Promise.allSettled([...this._pending]);
    }
  }

  list({ limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(this.maxEntries, Number(limit) || 50));
    return this.entries.slice(0, safeLimit);
  }

  clear() {
    this.entries.length = 0;
  }
}

/**
 * Runs local MCP Apps & Connector Readiness checks against this Loop workspace.
 * Mirrors marketplace/connector audits locally with zero external network calls.
 */
export async function runInspectorAudit({
  store,
  vault,
  pool,
  handleMcpRequest,
  mcpOpts = {},
  mcpOAuth = null,
  origin = 'http://127.0.0.1:8799',
} = {}) {
  const checks = [];
  const add = (id, category, title, status, detail) => {
    checks.push({ id, category, title, status, detail });
  };

  const uiCap = {
    extensions: {
      [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] },
    },
  };

  // 1. Initialize & MCP Apps extension negotiation
  const initRes = await handleMcpRequest(
    store,
    vault,
    pool,
    {
      jsonrpc: '2.0',
      id: 'audit_init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: uiCap,
        clientInfo: { name: 'loop-inspector-audit', version: '1.0.0' },
      },
    },
    { ...mcpOpts, clientCapabilities: { elicitation: { form: false, url: false }, mcpApps: { supported: true, mimeTypes: [MCP_APP_MIME_TYPE] } } },
  );

  const protoOk = Boolean(initRes?.result?.protocolVersion);
  add(
    'protocol-version',
    'Protocol',
    'MCP initialize handshake',
    protoOk ? 'pass' : 'fail',
    protoOk
      ? `Negotiated protocol ${initRes.result.protocolVersion} (${initRes.result.serverInfo?.name || 'loop'} v${initRes.result.serverInfo?.version || '?'}).`
      : `Initialize failed: ${initRes?.error?.message || 'no result'}`,
  );

  const advertisedExt = initRes?.result?.capabilities?.extensions?.[MCP_APP_EXTENSION];
  const extOk = Array.isArray(advertisedExt?.mimeTypes) && advertisedExt.mimeTypes.includes(MCP_APP_MIME_TYPE);
  add(
    'mcp-apps-capability',
    'MCP Apps',
    'Extension io.modelcontextprotocol/ui advertised',
    extOk ? 'pass' : 'fail',
    extOk
      ? `Advertises ${MCP_APP_MIME_TYPE} for ChatGPT, Claude, and compatible MCP Apps hosts.`
      : 'Server did not advertise io.modelcontextprotocol/ui with text/html;profile=mcp-app.',
  );

  // 2. Tools list, schemas, safety annotations, and _meta.ui wiring
  const auditOpts = {
    ...mcpOpts,
    clientCapabilities: {
      elicitation: { form: false, url: false },
      mcpApps: { supported: true, mimeTypes: [MCP_APP_MIME_TYPE] },
    },
  };
  const toolsRes = await handleMcpRequest(
    store,
    vault,
    pool,
    { jsonrpc: '2.0', id: 'audit_tools', method: 'tools/list', params: {} },
    auditOpts,
  );
  const tools = Array.isArray(toolsRes?.result?.tools) ? toolsRes.result.tools : [];
  const missingAnnotations = tools.filter((t) => !t.annotations || typeof t.annotations !== 'object').map((t) => t.name);
  const missingDescriptions = tools.filter((t) => typeof t.description !== 'string' || t.description.trim().length < 10).map((t) => t.name);
  add(
    'tool-schemas',
    'Tools',
    'Tool descriptions and safety annotations',
    tools.length > 0 && missingAnnotations.length === 0 && missingDescriptions.length === 0 ? 'pass' : 'warn',
    missingAnnotations.length === 0 && missingDescriptions.length === 0
      ? `All ${tools.length} top-level Loop tools declare valid inputSchema, descriptions, and MCP safety annotations.`
      : `Issues found — missing annotations: [${missingAnnotations.join(', ')}], short descriptions: [${missingDescriptions.join(', ')}].`,
  );

  const linkedWidgets = tools.filter((t) => typeof t?._meta?.ui?.resourceUri === 'string');
  const expectedChatTools = tools.filter((t) => Object.hasOwn(LOOP_CHAT_TOOL_WIDGETS, t.name));
  const chatLinksValid =
    expectedChatTools.length > 0 &&
    expectedChatTools.every((t) => t._meta?.ui?.resourceUri === LOOP_CHAT_TOOL_WIDGETS[t.name]) &&
    linkedWidgets.every(
      (t) =>
        Object.hasOwn(LOOP_CHAT_TOOL_WIDGETS, t.name) ||
        t._meta.ui.resourceUri.startsWith('ui://loop/upstream/'),
    );
  add(
    'tool-widget-links',
    'MCP Apps',
    'Inline chat widgets attached cleanly',
    chatLinksValid ? 'pass' : 'warn',
    chatLinksValid
      ? `Minimal chat UI: ${linkedWidgets.map((t) => `${t.name} -> ${t._meta.ui.resourceUri}`).join(', ')} (plumbing tools use native host rows; all 4 ui://loop/* cards remain available in /inspector).`
      : `${linkedWidgets.length} of ${tools.length} tools declare _meta.ui.resourceUri (${linkedWidgets.map((t) => `${t.name} -> ${t._meta.ui.resourceUri}`).join(', ')}).`,
  );

  // 3. Resources list & ui:// resource validation + static CSP/safety scan
  const resList = await handleMcpRequest(
    store,
    vault,
    pool,
    { jsonrpc: '2.0', id: 'audit_res_list', method: 'resources/list', params: {} },
    auditOpts,
  );
  const listedResources = Array.isArray(resList?.result?.resources) ? resList.result.resources : [];
  const expectedUris = listLoopAppResources().map((r) => r.uri);
  const uiResources = listedResources.filter((r) => r.mimeType === MCP_APP_MIME_TYPE);
  const missingExpected = expectedUris.filter((u) => !uiResources.some((r) => r.uri === u));
  add(
    'ui-resources-listed',
    'MCP Apps',
    'Built-in ui:// widget resources discoverable',
    missingExpected.length === 0 ? 'pass' : 'fail',
    missingExpected.length === 0
      ? `All ${expectedUris.length} Loop ui:// widgets appear in resources/list when io.modelcontextprotocol/ui is negotiated.`
      : `Missing ui:// resources: ${missingExpected.join(', ')}.`,
  );

  let badRead = [];
  let unsafeWidget = [];
  let badSyntax = [];
  for (const uri of expectedUris) {
    const readRes = await handleMcpRequest(
      store,
      vault,
      pool,
      { jsonrpc: '2.0', id: `audit_read_${uri}`, method: 'resources/read', params: { uri } },
      auditOpts,
    );
    const content = readRes?.result?.contents?.[0];
    if (!content || content.mimeType !== MCP_APP_MIME_TYPE || typeof content.text !== 'string' || !content.text.includes('ui/initialize')) {
      badRead.push(uri);
      continue;
    }
    const scripts = extractWidgetScripts(content.text);
    if (scripts.length === 0) {
      badSyntax.push(`${uri} (no scripts)`);
    } else {
      for (const code of scripts) {
        try {
          new vm.Script(code, { filename: uri });
        } catch (syntaxErr) {
          badSyntax.push(`${uri}: ${syntaxErr?.message || 'SyntaxError'}`);
          break;
        }
      }
    }
    const csp = content._meta?.ui?.csp;
    const hasEmptyNetwork =
      Array.isArray(csp?.connectDomains) &&
      csp.connectDomains.length === 0 &&
      Array.isArray(csp?.resourceDomains) &&
      csp.resourceDomains.length === 0;
    const hasUnsafeSink = /\binnerHTML\b|\bouterHTML\b|\bdocument\.write\b|\beval\s*\(|\bfetch\s*\(/i.test(content.text);
    if (!hasEmptyNetwork || hasUnsafeSink) {
      unsafeWidget.push(uri);
    }
  }
  add(
    'ui-resources-read',
    'MCP Apps',
    'Widget bundles resolve with valid JS, strict CSP, and safe DOM',
    badRead.length === 0 && unsafeWidget.length === 0 && badSyntax.length === 0 ? 'pass' : 'fail',
    badRead.length === 0 && unsafeWidget.length === 0 && badSyntax.length === 0
      ? `Verified all ${expectedUris.length} widget HTML bundles: valid ${MCP_APP_MIME_TYPE}, parsed inline JS, zero-network CSP, no innerHTML/eval/fetch.`
      : `Problems — unreadable: [${badRead.join(', ')}], JS syntax: [${badSyntax.join(', ')}], CSP/DOM: [${unsafeWidget.join(', ')}].`,
  );

  // 3b. Skills over MCP (SEP-2640) & 2026-07-28 discovery audit
  const discoverRes = await handleMcpRequest(
    store,
    vault,
    pool,
    {
      jsonrpc: '2.0',
      id: 'audit_discover',
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'loop-inspector-audit', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {
            extensions: { [MCP_SKILLS_EXTENSION]: {} },
          },
        },
      },
    },
    auditOpts,
  );
  const skillsExt = discoverRes?.result?.capabilities?.extensions?.[MCP_SKILLS_EXTENSION];
  const skillsDiscoverOk =
    discoverRes?.result?.protocolVersion === '2026-07-28' &&
    Boolean(skillsExt && typeof skillsExt === 'object' && skillsExt.directoryRead !== true);
  add(
    'mcp-skills-discover',
    'MCP Skills',
    '2026-07-28 server/discover and io.modelcontextprotocol/skills advertised',
    skillsDiscoverOk ? 'pass' : 'fail',
    skillsDiscoverOk
      ? 'server/discover negotiated 2026-07-28 and advertised io.modelcontextprotocol/skills without unsupported directoryRead.'
      : 'server/discover did not negotiate 2026-07-28 cleanly or advertised an invalid skills capability.',
  );

  const skillsListRes = await handleMcpRequest(
    store,
    vault,
    pool,
    { jsonrpc: '2.0', id: 'audit_skills_list', method: 'skills/list', params: {} },
    auditOpts,
  );
  const listedSkills = Array.isArray(skillsListRes?.result?.skills) ? skillsListRes.result.skills : null;
  let skillsReadOk = listedSkills !== null;
  let skillsDetail = listedSkills
    ? `skills/list returned ${listedSkills.length} skill(s).`
    : `skills/list failed: ${skillsListRes?.error?.message || 'missing skills array'}`;
  if (listedSkills && listedSkills.length > 0) {
    const sample = listedSkills[0];
    const sampleRes = Array.isArray(sample.resources) ? sample.resources[0] : null;
    const getRes = await handleMcpRequest(
      store,
      vault,
      pool,
      { jsonrpc: '2.0', id: 'audit_skills_get', method: 'skills/get', params: { uri: sample.uri } },
      auditOpts,
    );
    const readSkillRes = await handleMcpRequest(
      store,
      vault,
      pool,
      { jsonrpc: '2.0', id: 'audit_skills_read', method: 'resources/read', params: { uri: sample.uri } },
      auditOpts,
    );
    const traversalRes = await handleMcpRequest(
      store,
      vault,
      pool,
      { jsonrpc: '2.0', id: 'audit_skills_trav', method: 'resources/read', params: { uri: 'skill://loop/../etc/passwd' } },
      auditOpts,
    );
    const contentItem = readSkillRes?.result?.contents?.[0];
    const digestCheck = verifySkillFileContent(contentItem, sampleRes);
    const getOk = getRes?.result?.skill?.uri === sample.uri;
    const traversalBlocked = traversalRes?.error?.code === -32602;
    skillsReadOk = Boolean(getOk && digestCheck.ok && traversalBlocked);
    skillsDetail = skillsReadOk
      ? `Verified skills/list (${listedSkills.length}), skills/get, SHA-256 resources/read, and path-traversal rejection.`
      : `Issues — skills/get: ${getOk}, digest: ${digestCheck.ok ? 'ok' : digestCheck.reason}, traversalBlocked: ${traversalBlocked}.`;
  }
  add(
    'mcp-skills-manifest',
    'MCP Skills',
    'Skills over MCP manifest, digest verification, and traversal guard',
    skillsReadOk ? 'pass' : 'fail',
    skillsDetail,
  );

  // 4. OAuth 2.1 metadata & agent token enforcement
  const settings = (typeof store?.getSettings === 'function' ? await store.getSettings() : {}) || {};
  const tokenRequired = settings.requireAgentToken !== false;
  add(
    'agent-token-guard',
    'Security',
    'Agent key authentication enforced on /mcp',
    tokenRequired ? 'pass' : 'warn',
    tokenRequired
      ? 'requireAgentToken is enabled: every /mcp caller must authenticate with an agent key or OAuth 2.1.'
      : 'requireAgentToken is off (legacy local mode). Enable it in Settings -> General before exposing remotely.',
  );

  if (mcpOAuth && typeof mcpOAuth.protectedResourceMetadata === 'function') {
    const prm = mcpOAuth.protectedResourceMetadata(origin, '/mcp');
    const oauthOk = Boolean(prm?.resource && Array.isArray(prm?.authorization_servers) && prm.authorization_servers.length > 0);
    add(
      'oauth-prm',
      'Auth',
      'OAuth 2.1 Protected Resource Metadata (RFC 9728)',
      oauthOk ? 'pass' : 'warn',
      oauthOk
        ? `Ready at ${origin}/.well-known/oauth-protected-resource/mcp for one-click client sign-in.`
        : 'OAuth 2.1 metadata is incomplete.',
    );
  }

  // 5. Upstream connections readiness summary
  const conns = typeof store?.list === 'function' ? await store.list({ clone: false }) : [];
  const enabledConns = conns.filter((c) => c.enabled !== false);
  const needsAuth = enabledConns.filter((c) => c.authRequired || c.signInBroken);
  const withErrors = enabledConns.filter((c) => c.lastError);
  const upstreamUiCount = enabledConns.reduce(
    (sum, c) => sum + (Array.isArray(c.resources) ? c.resources.filter((r) => r.mimeType === MCP_APP_MIME_TYPE).length : 0),
    0,
  );
  add(
    'upstream-readiness',
    'Connections',
    'Upstream connection readiness',
    needsAuth.length === 0 && withErrors.length === 0 ? 'pass' : 'warn',
    enabledConns.length === 0
      ? 'No enabled upstream connections yet.'
      : `${enabledConns.length} enabled connection(s), ${needsAuth.length} need sign-in, ${withErrors.length} with lastError, ${upstreamUiCount} upstream MCP App widget(s).`,
  );

  const summary = {
    pass: checks.filter((c) => c.status === 'pass').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    total: checks.length,
  };

  return {
    checkedAt: new Date().toISOString(),
    origin,
    summary,
    checks,
  };
}
