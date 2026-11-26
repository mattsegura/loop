#!/usr/bin/env node
import { connectionReadiness } from './lib/connection-readiness.mjs';
import { listNamedActionsForConnection, publicNamedAction } from './lib/named-actions.mjs';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, watch } from 'node:fs';
import { access, constants as fsConstants, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseLoopPort } from './lib/json-file-store.mjs';
import { APPROVAL_MODES, VAULT_TYPES, Vault } from './lib/vault.mjs';
import { AGENT_KINDS, LoopStore, agentRightsDigest, effectivePinnedTools, isToolEnabled } from './lib/store.mjs';
import { ConnectionPool, needsAutoSync } from './lib/mcp-client.mjs';
import {
  connectionAuthInfo,
  countEnabledToolsForProfile as countProfileEnabledTools,
  estimateToolsSchemaBytes,
  handleMcpRequest,
  runLentTool,
  isTokenRejected,
  findWorkspaceProjects,
  resolveAccess,
  rpcError,
} from './lib/mcp-server.mjs';
import {
  MCP_APP_EXTENSION,
  MCP_APP_MIME_TYPE,
  MCP_INSPECTOR_SANDBOX_CSP,
  MCP_INSPECTOR_SANDBOX_HTML,
  buildSandboxCsp,
  buildUpstreamWidgetUri,
  listLoopAppResources,
  normalizeWidgetCsp,
  toolUiMeta,
} from './lib/mcp-apps.mjs';
import { InspectorTraceStore, runInspectorAudit } from './lib/mcp-inspector.mjs';
import { finishOAuthFlow, startOAuthFlow } from './lib/oauth.mjs';
import { hashRefreshToken, inferAgentKind, isLoopbackHost, McpOAuthServer, resolvePublicOrigin } from './lib/mcp-oauth.mjs';
import { DeviceAuthServer } from './lib/device-auth.mjs';
import { AgentHandoffStore } from './lib/agent-handoff.mjs';
import { AgentPictureStore } from './lib/agent-pictures.mjs';
import {
  agentInstallTargets,
  detectInstallableAgents,
  INSTALLABLE_HARNESSES,
  installLoopIntoAgent,
} from './lib/agent-installer.mjs';
import { ProjectFolders } from './lib/project-folders.mjs';
import { ActivityLog } from './lib/activity.mjs';
import { ClientRegistry, summarizeClientCapabilities } from './lib/clients.mjs';
import {
  buildApprovalUiSpec,
  parseMcpElicitationAnswer,
  resolveSpecDecisionOption,
  sanitizeSpecValues,
  specToMcpElicitation,
} from './lib/json-render-ui.mjs';
import {
  agentTokenVaultKey,
  extractBearerToken,
  findAgentByRecallToken,
  findAgentByToken,
  generateAgentToken,
  hashAgentToken,
  tokenHint,
  isAgentTokenFormat,
  isRecallTokenFormat,
  isTurnRecallEnabled,
  issueAgentToken,
  issueRecallToken,
  publicAgent,
  readAgentToken,
  revokeRecallToken,
} from './lib/agents.mjs';
import {
  ALLOWED_RECALL_EVENTS,
  parseSketch,
  readRecallConfig,
  recallFromSketch,
  removeRecallConfig,
  writeRecallConfig,
} from './lib/turn-recall.mjs';
import {
  agentHookStatus,
  installAgentHooks,
  turnRecallCapability,
} from './lib/agent-hooks.mjs';
import {
  guardRequest,
  isBearerMcpCorsPath,
  isLocalDeviceRequest,
  isOAuthPublicCorsPath,
  resolveClientIp,
  SECURITY_HEADERS,
  validateAllowedHosts,
} from './lib/security.mjs';
import { OwnerAuth } from './lib/owner.mjs';
import { loadClerkApp } from './lib/clerk-app.mjs';
import { AppWorkspaces } from './lib/app-workspaces.mjs';
import { BillingStore, hasLoopConnectAccess } from './lib/billing.mjs';
import { isCloudRouteConnection, isRelayConnection, LoopConnectClient, LoopConnectServer } from './lib/loop-connect.mjs';
import {
  LocalInstallStore,
  ToolSetupStore,
  analyzeStdioPortability,
  defaultRemoteAccessFor,
  slugifySetupId,
} from './lib/tool-setups.mjs';
import {
  ensureSmsAgentRecord,
  isPlanActiveForSms,
  loadSmsAgentConfig,
  SMS_AGENT_BILLING_URL,
  SMS_AGENT_DEFAULT_ID,
  SMS_BRAIN_MODES,
  SMS_CLI_AUTH_PROVIDERS,
  SmsAgentClient,
  SmsAgentError,
  stripSensitiveBrainFields,
} from './lib/sms-agent.mjs';
import {
  handleSmsBridge,
  isBrowserRequest,
  isSmsBridgePath,
  saveOwnerLogin,
  smsBridgeSecretMatches,
} from './lib/sms-bridge.mjs';
import { createEmbedder, resolveEmbeddingConfig } from './lib/embedder.mjs';
import { createReranker, resolveRerankConfig } from './lib/reranker.mjs';
import { SearchIndex } from './lib/search-index.mjs';
import {
  assertPersonalStoredConnection,
  listPersonalUpstreamOrigins,
} from './lib/personal-upstreams.mjs';
import {
  buildSelfIdentity,
  createOutboundPolicy,
  getHostedOriginPolicy,
  probeConnection,
} from './lib/outbound-policy.mjs';
import {
  admitConnectionWrite,
  deleteConnection,
  extractUrlSecrets,
  isSecretEnv,
  isSecretHeader,
  looksLikeSecretValue,
  secretArgs,
} from './lib/connection-admission.mjs';
import { LogoStore, LOGO_RESPONSE_HEADERS } from './lib/logos.mjs';
import { defaultDataDir } from './lib/vault.mjs';
import {
  candidatesFromMcpJson,
  discoverConnectedLocalAgents,
  discoverSources,
  importCandidates,
  isDuplicateEntry,
  publicSources,
} from './lib/importers.mjs';
import { publicSkillMeta, SkillStore } from './lib/skills.mjs';
import {
  buildMemoryGraph,
  detectExternalMemoryConnections,
  discoverMemorySources,
  exportMemoriesMarkdown,
  extractMemoriesFromExternalResult,
  MEMORY_MODES,
  MEMORY_RELATIONS,
  MEMORY_SCOPES,
  MemoryStore,
  parsePastedMemories,
  pickExternalMemoryTools,
  suggestKeep,
} from './lib/memory.mjs';
import { HygieneQueue, MemoryHygieneStore, OUTDATING_RELATIONS, resolveHygieneConfig } from './lib/memory-hygiene.mjs';
import { HistoryStore } from './lib/history.mjs';
import { OwnerTimezone } from './lib/owner-timezone.mjs';
import { DreamStore } from './lib/dream.mjs';
import { CategoryRequests } from './lib/category-requests.mjs';
import { CategoryStore, categorizeItem, groupByCategory, slugifyCategory } from './lib/categories.mjs';
import { categorySuggestions, fileAll, resolveFilerConfig } from './lib/category-filer.mjs';
import { ShareStore, TokenRouter, handleShareApi, shareCodeFromPath } from './lib/shares.mjs';
import {
  PeopleStore,
  SharedCallError,
  addressParts,
  createSharedDispatcher,
  handleLocalPeople,
  handlePeopleApi,
  handlePeopleJoin,
  peopleInviteIdFromPath,
  fromViews,
  signInsLeft,
} from './lib/people.mjs';
import { isSharedConnection } from './lib/shared-connection.mjs';
import { InviteError, InviteStore, formatInviteShare } from './lib/invites.mjs';
import {
  ApprovalQueue,
  DEFAULT_POLICIES,
  PolicyStore,
  canAlwaysAllow,
  patchSetsGuard,
  vaultItemLeavesGuard,
  vaultItemMode,
} from './lib/policies.mjs';
import { approvedAddedBy, isNamePending, normalizeAddedBy } from './lib/context-names.mjs';
import {
  PROFILE_CONTROL_RE,
  connectionMatchesProfile,
  itemMatchesProfile,
  normalizeProfileTag,
} from './lib/profiles.mjs';
import {
  MAX_FORM_BODY_BYTES,
  MAX_JSON_BODY_BYTES,
  MIME_TYPES,
  escapeHtml,
  extractRawTopLevelIdToken,
  formatErrorResponse,
  isPlainObject,
  isRawInternalError,
  keepSlowCallAlive,
  mcpUnauthorizedMessage,
  readFormOrJsonBody,
  readJsonBody,
  readRawBody,
  resolveLoopPublicOrigin,
  rpcBodyText,
  sendJson,
  sendRpcJson,
} from './lib/http/transport.mjs';
import { createRequestId, logger } from './lib/http/logger.mjs';
import { FeedbackStore, feedbackIsAvailable, feedbackState, loopBuild } from './lib/feedback.mjs';
import {
  buildReleaseManifest,
  currentLoopVersion,
  parseReleaseFile,
  resolveReleasesDir,
  resolveTarballDownload,
  sha256Buffer,
} from './lib/release.mjs';
import { handleCoreLoopRoute } from './lib/routes/core-loop.mjs';
import { handleSavedAndToolsRoute } from './lib/routes/saved-and-tools.mjs';
import { handleLibraryRoute } from './lib/routes/library.mjs';
import { createLibrary } from './lib/library.mjs';
import { LibraryLinkStore } from './lib/library-links.mjs';
import { SavedStore } from './lib/saved.mjs';
import { ScheduleStore } from './lib/schedules.mjs';
import { FileStore } from './lib/files.mjs';
import { NotificationStore } from './lib/notifications.mjs';
import { TaskStore } from './lib/tasks.mjs';
import { handleBillingRoute, handleInviteRoute } from './lib/routes/billing-and-invites.mjs';
import { handleCatalogAndV3Routes, VERIFIED_CATALOG } from './lib/catalog-routes.mjs';
import { handleChatConsoleRoutes } from './lib/chat-console.mjs';
import { LoopAgentStore } from './lib/loop-agent-store.mjs';
import { createRunTokenRegistry } from './lib/loop-agent-tokens.mjs';
import { createLoopAgentHandler } from './lib/routes/loop-agent.mjs';
import { WebhookStore } from './lib/webhooks.mjs';
import { OutboundAlertStore } from './lib/outbound-alerts.mjs';
import { MetricsCollector } from './lib/metrics.mjs';
import { accountsOfService, buildServicesView, listAllAccessSets, resolveAccessSetRecord, serviceKeyOf } from './lib/services.mjs';
import { closeAllWorkspaceDbs } from './lib/storage/workspace-db.mjs';
import { ScheduleWakeIndex } from './lib/storage/schedule-index.mjs';
import { LegacyMcpSseManager } from './lib/mcp-sse-legacy.mjs';
import { handleRestBridgeRequest } from './lib/rest-bridge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const SAVE_VERDICT_WAIT_MS = 1500; // how long a memory save waits to hear what it updates

function sendOAuthErrorHtml(res, status, error, description, headOnly = false) {
  const safeCode = escapeHtml(error || 'invalid_request');
  const safeDesc = escapeHtml(description || 'The authorization request could not be completed.');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Loop — Authorization Error</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1115; color: #f1f3f5; margin: 0; padding: 3rem 1.25rem; display: flex; justify-content: center; }
  main { max-width: 34rem; width: 100%; background: #171a21; border: 1px solid #2b303b; border-radius: 12px; padding: 1.75rem; }
  h1 { margin: 0 0 0.75rem; font-size: 1.2rem; }
  p { margin: 0 0 0.75rem; line-height: 1.5; color: #c7ccd6; }
  code { background: #232834; padding: 0.15rem 0.4rem; border-radius: 4px; color: #ffb4b4; font-size: 0.9rem; }
</style>
</head>
<body>
  <main>
    <h1>Sign-in request rejected</h1>
    <p>${safeDesc}</p>
    <p>Error code: <code>${safeCode}</code></p>
  </main>
</body>
</html>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(headOnly ? '' : html);
}

const ALLOWED_OAUTH_ERROR_CODES = new Set([
  'expired',
  'denied',
  'issuer_mismatch',
  'state_mismatch',
  'token_exchange_failed',
  'callback_failed',
  'oauth_failed',
]);

// Maps upstream OAuth callback errors to fixed allowlisted opaque codes (G7-11).
function mapOAuthCallbackErrorCode({ errorParam = '', errorDescription = '', err = null, missingParams = false } = {}) {
  const rawCode = String(errorParam || '').trim().toLowerCase();
  if (rawCode === 'access_denied' || rawCode === 'denied' || rawCode === 'user_cancelled' || rawCode === 'canceled') {
    return 'denied';
  }
  if (ALLOWED_OAUTH_ERROR_CODES.has(rawCode)) return rawCode;

  if (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('issuer')) return 'issuer_mismatch';
    if (msg.includes('expired')) return 'expired';
    if (msg.includes('state')) return 'state_mismatch';
    if (msg.includes('denied') || msg.includes('cancel')) return 'denied';
    if (msg.includes('token')) return 'token_exchange_failed';
    if (msg.includes('callback')) return 'callback_failed';
    return 'oauth_failed';
  }

  if (rawCode === 'invalid_request' || rawCode === 'invalid_state') {
    return 'callback_failed';
  }
  if (rawCode || errorDescription) {
    const desc = String(errorDescription || '').toLowerCase();
    if (desc.includes('denied') || desc.includes('cancel')) return 'denied';
    if (desc.includes('expired')) return 'expired';
    return 'oauth_failed';
  }
  if (missingParams) {
    return 'callback_failed';
  }
  return 'oauth_failed';
}

// A sign-in page sends the browser back from another site, so the callback itself never touches
// sessions or exchanges codes: it hands code and state to Loop's own page in the fragment, where
// the signed-in dashboard finishes via POST /api/mcps/oauth/finish.
function bounceSignInCallback(res, url) {
  const params = new URLSearchParams();
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const iss = url.searchParams.get('iss');
  const errorParam = url.searchParams.get('error') || '';
  const errorDescription = url.searchParams.get('error_description') || '';
  if (errorParam || errorDescription || !code || !state) {
    params.set(
      'oauth_error',
      mapOAuthCallbackErrorCode({
        errorParam,
        errorDescription,
        missingParams: !code || !state,
      }),
    );
  } else {
    params.set('oauth_code', code);
    params.set('oauth_state', state);
    if (iss) params.set('oauth_iss', iss);
  }
  res.writeHead(302, { Location: `/#connections?${params}` });
  res.end();
}

// Upstream sign-in pages must be https, or http on this computer.
function isSafeAuthorizeUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || ''));
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
}

function sanitizeMcp(mcp, { personal = false } = {}) {
  const disabledTools = Array.isArray(mcp.disabledTools) ? mcp.disabledTools : [];
  const pinnedTools = effectivePinnedTools(mcp);
  const pinnedSet = new Set(pinnedTools);
  const { headerKeys, hasOAuth, hasAuth } = connectionAuthInfo(mcp);
  const envKeys = mcp.env && typeof mcp.env === 'object' ? Object.keys(mcp.env) : [];

  const transport = mcp.transport || (mcp.command ? 'stdio' : 'http');
  const isStdio = transport === 'stdio';
  const portability = isStdio
    ? analyzeStdioPortability({
        name: mcp.name,
        command: mcp.command,
        args: mcp.args,
        env: mcp.env,
        cwd: mcp.cwd,
        installSpec: mcp.installSpec || null,
      })
    : null;
  const home =
    mcp.home ||
    (isCloudRouteConnection(mcp) ? 'cloud' : isStdio ? 'local' : isRelayConnection(mcp) ? 'local' : null);
  const remoteAccess = isStdio || isRelayConnection(mcp)
    ? (mcp.remoteAccess || defaultRemoteAccessFor(mcp))
    : (mcp.remoteAccess || null);

  return {
    id: mcp.id,
    name: mcp.name,
    serviceKey: serviceKeyOf(mcp),
    ...(mcp.accountLabel ? { accountLabel: mcp.accountLabel } : {}),
    description: mcp.description || '',
    serverInstructions: mcp.serverInstructions || '',
    transport,
    url: mcp.url ?? null,
    command: mcp.command ?? null,
    args: Array.isArray(mcp.args) ? mcp.args : [],
    cwd: mcp.cwd ?? null,
    envKeys,
    headerKeys,
    profiles: Array.isArray(mcp.profiles) ? mcp.profiles : ['all'],
    enabled: Boolean(mcp.enabled),
    ...(home ? { home } : {}),
    ...(isSharedConnection(mcp) ? { lent: true } : {}),
    ...(mcp.cloudRouted || isCloudRouteConnection(mcp) ? { cloudRouted: true } : {}),
    ...(remoteAccess ? { remoteAccess } : {}),
    ...(mcp.toolSetupId ? { toolSetupId: mcp.toolSetupId } : {}),
    ...(mcp.installSpec ? { installSpec: mcp.installSpec } : {}),
    ...(portability
      ? {
          portable: portability.portable,
          versionPinned: portability.versionPinned,
          nonPortableReason: portability.reason,
        }
      : {}),
    hasAuth,
    hasOAuth,
    authRequired: Boolean(mcp.authRequired),
    tokenRejected: isTokenRejected(mcp),
    readiness: connectionReadiness(mcp, { tokenRejected: isTokenRejected(mcp), personal }),
    disabledTools,
    pinnedTools,
    tools: (Array.isArray(mcp.tools) ? mcp.tools : []).map((t) => ({
      ...t,
      enabled: isToolEnabled(mcp, t.name),
      pinned: pinnedSet.has(t.name),
    })),
    resources: Array.isArray(mcp.resources) ? mcp.resources : [],
    prompts: Array.isArray(mcp.prompts) ? mcp.prompts : [],
    skills: Array.isArray(mcp.skills) ? mcp.skills : [],
    partnerSkillsEnabled: mcp.partnerSkillsEnabled === true,
    lastSyncAt: mcp.lastSyncAt ?? null,
    lastError: mcp.lastError ?? null,
    signInBroken: mcp.signInBroken ?? null,
    agentLogin: mcp.agentLogin ?? null,
    websiteUrl: mcp.websiteUrl ?? null,
    ...(mcp.serverVersion ? { serverVersion: mcp.serverVersion } : {}),
    createdAt: mcp.createdAt ?? null,
    addedBy: normalizeAddedBy(mcp.addedBy),
    namePending: isNamePending(mcp),
  };
}

function decorateMcp(mcp, catState = null, policies = null, { personal = false } = {}) {
  const base = sanitizeMcp(mcp, { personal });
  const cat = categorizeItem(mcp, { kind: 'connection', state: catState });
  const approval = policies?.connections?.[mcp.id] || 'inherit';
  return {
    ...base,
    category: cat.id,
    categoryLabel: cat.label,
    approval,
  };
}

function publicCategoryGroups(mcps, skills, catState) {
  const customList = Array.isArray(catState?.categories) ? catState.categories : [];
  const customIds = new Set(customList.map((c) => c.id));
  const groups = groupByCategory(mcps, skills, catState).map((g) => ({
    id: g.id,
    label: g.label,
    description: g.description || '',
    custom: customIds.has(g.id),
    connections: g.connections.map((c) => ({ id: c.id, name: c.name, description: c.description || '' })),
    skills: g.skills.map((s) => ({ id: s.id, name: s.name, description: String(s.description || '').slice(0, 200), namespace: s.namespace, ...(s.systemId ? { systemId: s.systemId } : {}), bundled: Boolean(s.bundled) })),
  }));
  // Keep user-created custom categories visible even before any connection is moved into them.
  const present = new Set(groups.map((g) => g.id));
  for (const c of customList) {
    if (!c?.id || present.has(c.id)) continue;
    groups.push({
      id: c.id,
      label: c.label || c.id,
      description: c.description || '',
      custom: true,
      connections: [],
      skills: [],
    });
  }
  return groups;
}

// Syncs freshly imported connections a few at a time without blocking the response.
function syncInBackground(pool, ids, concurrency = 4) {
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      await pool.sync(id).catch(() => {});
    }
  };
  return Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

// Key prefix of an Agents-page row that stands for a sign-in an app started and never finished.
const SIGN_IN_ROW_PREFIX = 'signin:';
const AGENT_FIELDS = ['name', 'kind', 'profile', 'project', 'mode', 'toolMode', 'modules', 'canManage', 'memoryAccess', 'secrets', 'allowedConnections', 'allowedSkills', 'accessSet', 'approvalMode', 'approvalTtlSeconds', 'hostApprovalDelegation', 'accountChoice', 'rateLimitPerMin', 'enabled', 'turnRecall'];
const AGENT_STRING_FIELDS = new Set(['name', 'kind', 'profile', 'project', 'mode', 'toolMode', 'memoryAccess', 'accessSet', 'approvalMode', 'hostApprovalDelegation']);

function pickAgentFields(body) {
  const out = {};
  for (const field of AGENT_FIELDS) {
    if (body?.[field] !== undefined) {
      const value = body[field];
      const nullableString = (field === 'project' || field === 'accessSet' || field === 'approvalMode' || field === 'hostApprovalDelegation') && value === null;
      if (AGENT_STRING_FIELDS.has(field) && !nullableString) {
        if (typeof value !== 'string' || /[\r\n\0]/.test(value)) {
          throw Object.assign(new Error(`Invalid agent field "${field}".`), { status: 400 });
        }
      }
      out[field] = value;
    }
  }
  return out;
}

function hasInternalVaultPlaceholder(str) {
  if (typeof str !== 'string') return false;
  return /\{\{vault:__[^}]*\}\}|%7[Bb]%7[Bb]vault(?:%3[Aa]|:)__[^%]*%7[Dd]%7[Dd]/i.test(str);
}

function redactUrlForExport(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return null;
  let cleaned = rawUrl.replace(
    /%7[Bb]%7[Bb]vault(?:%3[Aa]|:)([A-Za-z0-9_.-]{1,100})%7[Dd]%7[Dd]/g,
    '{{vault:$1}}',
  );
  cleaned = cleaned.replace(/\{\{vault:__[A-Za-z0-9_.-]{0,100}\}\}/g, 'REDACTED');
  return extractUrlSecrets(cleaned).maskUrl('REDACTED');
}

function redactArgsForExport(rawArgs) {
  const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
  if (!args.length) return [];
  const out = [...args];
  for (const hit of secretArgs(out)) {
    out[hit.index] = `${hit.prefix}[REDACTED]`;
  }
  for (let i = 0; i < out.length; i += 1) {
    const val = out[i];
    if (hasInternalVaultPlaceholder(val)) {
      out[i] = val.replace(/\{\{vault:__[A-Za-z0-9_.-]{0,100}\}\}/g, '[REDACTED]');
      continue;
    }
    if (val.includes('{{vault:') || val.includes('[REDACTED]')) continue;
    if (looksLikeSecretValue(val)) {
      out[i] = '[REDACTED]';
    }
  }
  return out;
}

function redactHeadersForExport(rawHeaders) {
  const out = {};
  if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) return out;
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (typeof v !== 'string') continue;
    if (v.includes('{{vault:')) {
      out[k] = hasInternalVaultPlaceholder(v) ? '[REDACTED]' : v;
    } else if (!isSecretHeader(k, v)) {
      out[k] = v;
    } else {
      out[k] = '[REDACTED]';
    }
  }
  return out;
}

function redactEnvForExport(rawEnv) {
  const out = {};
  if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) return out;
  for (const [k, v] of Object.entries(rawEnv)) {
    if (typeof v !== 'string') continue;
    if (v.includes('{{vault:')) {
      out[k] = hasInternalVaultPlaceholder(v) ? '[REDACTED]' : v;
    } else if (!isSecretEnv(k, v)) {
      out[k] = v;
    } else {
      out[k] = '[REDACTED]';
    }
  }
  return out;
}

function buildExportPayload(settings, mcps) {
  const exportedConnections = [];
  const mcpServers = {};
  const exportedMcps = [];

  for (const m of mcps) {
    const transport = m.transport || (m.command ? 'stdio' : 'http');
    const isStdio = transport === 'stdio';
    const safeUrl = isStdio ? null : redactUrlForExport(m.url);
    const safeHeaders = isStdio ? {} : redactHeadersForExport(m.headers);
    const safeArgs = isStdio ? redactArgsForExport(m.args) : [];
    const safeEnv = isStdio ? redactEnvForExport(m.env) : {};
    const profiles = Array.isArray(m.profiles) ? [...m.profiles] : ['all'];
    const disabledTools = Array.isArray(m.disabledTools) ? [...m.disabledTools] : [];
    const pinnedTools = effectivePinnedTools(m);
    const allowedTools = Array.isArray(m.allowedTools) ? [...m.allowedTools] : null;

    exportedConnections.push({
      id: m.id,
      name: m.name,
      description: m.description || '',
      transport,
      ...(isStdio
        ? { command: m.command ?? null, args: safeArgs, env: safeEnv, cwd: m.cwd ?? null }
        : { url: safeUrl, headers: safeHeaders }),
      profiles,
      enabled: Boolean(m.enabled),
      disabledTools,
      ...(allowedTools ? { allowedTools } : {}),
      pinnedTools,
    });

    let serverKey = String(m.name || m.id || 'mcp').trim() || m.id;
    if (Object.hasOwn(mcpServers, serverKey)) {
      serverKey = `${serverKey} (${m.id})`;
    }
    mcpServers[serverKey] = isStdio
      ? {
          transport: 'stdio',
          command: m.command ?? null,
          args: safeArgs,
          ...(Object.keys(safeEnv).length ? { env: safeEnv } : {}),
          ...(m.cwd ? { cwd: m.cwd } : {}),
          enabled: Boolean(m.enabled),
          profiles,
          ...(disabledTools.length ? { disabledTools } : {}),
          ...(allowedTools ? { allowedTools } : {}),
        }
      : {
          transport,
          url: safeUrl,
          ...(Object.keys(safeHeaders).length ? { headers: safeHeaders } : {}),
          enabled: Boolean(m.enabled),
          profiles,
          ...(disabledTools.length ? { disabledTools } : {}),
          ...(allowedTools ? { allowedTools } : {}),
        };

    exportedMcps.push({
      ...sanitizeMcp(m),
      url: safeUrl,
      args: safeArgs,
    });
  }

  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    settings,
    mcpServers,
    connections: exportedConnections,
    mcps: exportedMcps,
  };
}

function stripRedactedRecord(record) {
  const out = {};
  if (!isPlainObject(record)) return out;
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === 'string' && v.trim() === '[REDACTED]') continue;
    out[k] = v;
  }
  return out;
}

async function deleteConnectionOAuthKeys(vault, id, mcp = null) {
  const keys = new Set([
    `__oauth_access_${id}`,
    `__oauth_refresh_${id}`,
    `__oauth_client_secret_${id}`,
  ]);
  if (mcp?.oauth?.accessTokenVaultKey) keys.add(mcp.oauth.accessTokenVaultKey);
  if (mcp?.oauth?.refreshTokenVaultKey) keys.add(mcp.oauth.refreshTokenVaultKey);
  if (mcp?.oauth?.clientSecretVaultKey) keys.add(mcp.oauth.clientSecretVaultKey);
  for (const key of keys) {
    await vault.delete(key).catch(() => {});
  }
}

function parseProfileQueryParam(url) {
  const raw = url.searchParams.get('project') ?? url.searchParams.get('profile');
  if (raw === null || raw === '') return 'all';
  if (PROFILE_CONTROL_RE.test(raw)) {
    throw Object.assign(new Error('Invalid profile filter.'), { status: 400 });
  }
  return normalizeProfileTag(raw) || 'all';
}

async function buildProfileRecords({
  store,
  skillStore,
  memoryStore,
  vault,
  persistedRecords = null,
  mcps = null,
  skills = null,
  memories = null,
  secrets = null,
  agents = null,
} = {}) {
  const [rawRecords, rawMcps, rawSkills, rawMemories, rawSecrets, rawAgents] = await Promise.all([
    persistedRecords !== null ? persistedRecords : store.listProfileRecords(),
    mcps !== null ? mcps : store.list(),
    skills !== null ? skills : skillStore.list().catch(() => []),
    memories !== null ? memories : memoryStore.list().catch(() => []),
    secrets !== null ? secrets : vault.list().catch(() => []),
    agents !== null ? agents : store.listAgents(),
  ]);

  const byId = new Map();
  for (const rec of Array.isArray(rawRecords) ? rawRecords : []) {
    const id = normalizeProfileTag(rec?.id);
    if (!id || id === 'all') continue;
    byId.set(id, {
      id,
      name: rec.name || id,
      description: rec.description || '',
      ...(rec.repositoryUrl ? { repositoryUrl: rec.repositoryUrl } : {}),
      icon: rec.icon, color: rec.color,
      persisted: true,
      createdAt: rec.createdAt || null,
      updatedAt: rec.updatedAt || null,
    });
  }

  const addReferenced = (rawTag) => {
    const id = normalizeProfileTag(rawTag);
    if (!id || id === 'all' || byId.has(id)) return;
    byId.set(id, {
      id,
      name: id,
      description: '',
      persisted: false,
      createdAt: null,
      updatedAt: null,
    });
  };

  for (const c of rawMcps) {
    for (const p of Array.isArray(c?.profiles) ? c.profiles : []) addReferenced(p);
  }
  for (const sk of rawSkills) {
    for (const p of Array.isArray(sk?.profiles) ? sk.profiles : []) addReferenced(p);
  }
  for (const mem of rawMemories) {
    for (const p of Array.isArray(mem?.profiles) ? mem.profiles : []) addReferenced(p);
  }
  for (const sec of rawSecrets) {
    for (const p of Array.isArray(sec?.profiles) ? sec.profiles : []) addReferenced(p);
  }
  for (const ag of rawAgents) {
    addReferenced(ag?.profile);
  }

  const profileRecords = [];
  for (const [id, meta] of byId.entries()) {
    const counts = {
      connections: rawMcps.filter((c) => connectionMatchesProfile(c, id, { requireEnabled: false })).length,
      skills: rawSkills.filter((sk) => itemMatchesProfile(sk, id)).length,
      memories: rawMemories.filter((mem) => itemMatchesProfile(mem, id)).length,
      secrets: rawSecrets.filter((sec) => itemMatchesProfile(sec, id)).length,
      agents: rawAgents.filter((ag) => normalizeProfileTag(ag?.profile) === id || ag?.project === id).length,
    };
    profileRecords.push({
      id: meta.id,
      name: meta.name,
      description: meta.description,
      icon: meta.icon, color: meta.color,
      persisted: meta.persisted,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      counts,
    });
  }

  profileRecords.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const sortedIds = [...byId.keys()].sort((a, b) => a.localeCompare(b));
  const profiles = ['all', ...sortedIds];
  const totals = {
    connections: rawMcps.length,
    skills: rawSkills.length,
    memories: rawMemories.length,
    secrets: rawSecrets.length,
    agents: rawAgents.length,
  };

  return { profileRecords, profiles, totals };
}

async function getEnabledToolBudgetForProfile(store, profile) {
  const conns = await store.list({ clone: false });
  return {
    enabledToolCount: countProfileEnabledTools(conns, profile),
    enabledToolBytes: estimateToolsSchemaBytes(conns, profile),
  };
}

// A workspace is a handler and its own stores, never another listening server.
function createWorkspace(opts, dataDir, id, legacy, mcpOAuth = null, getServerPort = null, sharedSearch = null) {
  let closed = false;
  const personal = !!id;
  const stdioPath = personal ? 'stdio.mjs' : path.join(here, 'stdio.mjs');
  const portRef = { current: typeof getServerPort === 'function' ? getServerPort() : getServerPort };
  const setPort = (p) => {
    if (p != null && Number.isFinite(Number(p)) && Number(p) > 0) {
      portRef.current = Number(p);
    }
  };
  const resolvePort = (activePort = null) =>
    activePort ?? portRef.current ?? (typeof getServerPort === 'function' ? getServerPort() : null);
  const getSelfIdentity = (activePort = null) =>
    buildSelfIdentity({ port: resolvePort(activePort), stdioPath });
  const getOutboundPolicy = (activePort = null) =>
    createOutboundPolicy({ personal, selfIdentity: getSelfIdentity(activePort) });
  const dynamicSelfIdentity = {
    get port() {
      return resolvePort();
    },
    isSelfUrl: (raw) => getSelfIdentity().isSelfUrl(raw),
    isSelfStdio: (cmd, args) => getSelfIdentity().isSelfStdio(cmd, args),
  };

  const vault = new Vault(dataDir);
  const inNodeTest = process.execArgv.includes('--test');
  const resolvedDataDir = path.resolve(dataDir);
  const resolvedTmpDir = path.resolve(os.tmpdir());
  const inTmpDir = resolvedDataDir === resolvedTmpDir || resolvedDataDir.startsWith(resolvedTmpDir + path.sep);
  const store = new LoopStore(dataDir, {
    seedBuiltins: opts.seedBuiltins ?? (process.env.LOOP_SEED_BUILTINS === '1' || (process.env.LOOP_SEED_BUILTINS !== '0' && !inNodeTest && !opts.localTest && !inTmpDir)),
  });
  const projectFolders = !personal && !sharedSearch?.hosted ? new ProjectFolders(dataDir, store) : null;
  // A deleted project keeps no folder, and no session stays in it.
  const projectGone = async (project) => {
    if (!project || project === 'all') return;
    await clients.leaveProject(project);
    if (projectFolders) await projectFolders.detach(project);
  };
  const skillStore = new SkillStore(dataDir, {
    ...(opts.bundledSkillsDir !== undefined ? { bundledDir: opts.bundledSkillsDir } : {}),
    personal,
    hosted: sharedSearch?.hosted,
    stripPaths: personal || sharedSearch?.hosted,
  });
  const memoryStore = new MemoryStore(dataDir);
  const taskStore = new TaskStore(dataDir);
  const savedStore = new SavedStore(dataDir);
  const scheduleStore = new ScheduleStore(dataDir, {
    onNextRunChange: (nextRunAt) => {
      sharedSearch?.scheduleWakeIndex?.update(id || 'local', nextRunAt);
    },
  });
  const activeMcpRequests = new Map(); // `${sessionId || '__stateless'}::${requestId}` -> { ac, agentId, cancelledByClient }
  const fileStore = new FileStore(dataDir);
  // The Library as one connected thing: the links between memories, saved items, files and tasks.
  const library = createLibrary({
    memoryStore,
    savedStore,
    fileStore,
    taskStore,
    links: new LibraryLinkStore(dataDir),
    agentStore: store,
    shares: sharedSearch?.shares || null,
    workspaceId: id || null,
  });
  const notificationStore = new NotificationStore(dataDir);
  const historyStore = new HistoryStore(dataDir);
  const ownerTimezone = new OwnerTimezone(dataDir);
  const dreamStore = new DreamStore(dataDir, {
    memoryStore,
    skillStore,
    historyStore,
    env: opts.dreamEnv || process.env,
    ...(opts.dream || {}),
  });
  const catStore = new CategoryStore(dataDir);
  const categoryRequests = new CategoryRequests(dataDir, { catStore, onChange: () => { if (!closed) scheduleConnectionsBroadcast(); } });
  const policyStore = new PolicyStore(dataDir, { listConnections: () => store.list({ clone: false }) });
  const agentPictures = new AgentPictureStore(dataDir);
  const approvalQueue = new ApprovalQueue({ dir: dataDir });
  const searchIndex = new SearchIndex(dataDir, {
    embedder: sharedSearch?.embedder || null,
    hosted: Boolean(sharedSearch?.hosted || personal),
    autoSemanticThreshold: Boolean(sharedSearch?.autoSemanticThreshold),
    ...(sharedSearch?.semanticMinTools !== undefined ? { semanticMinTools: sharedSearch.semanticMinTools } : {}),
    reranker: sharedSearch?.reranker || null,
    ...(opts.searchIndexOptions || {}),
  });
  // Optional enrichment (lib/enrich.mjs output): <dataDir>/search-enrichment.json or LOOP_SEARCH_ENRICHMENT.
  try {
    const enrichPath = process.env.LOOP_SEARCH_ENRICHMENT || path.join(dataDir, 'search-enrichment.json');
    if (existsSync(enrichPath)) searchIndex.loadEnrichment(JSON.parse(readFileSync(enrichPath, 'utf8')));
  } catch {
    // Enrichment is optional; a bad file never blocks search.
  }
  let searchReindexTimer = null;
  const runSearchReindex = async () => {
    if (closed) return null;
    try {
      const [conns, skills, memories, catState] = await Promise.all([
        store.list({ clone: false }),
        skillStore.list({ includeContent: true }).catch(() => []),
        memoryStore.list().catch(() => []),
        catStore.load().catch(() => null),
      ]);
      return await searchIndex.syncIndex({
        connections: conns,
        skills,
        memories,
        categoryFor: (item, kind) => categorizeItem(item, { kind, state: catState }).label,
      });
    } catch {
      return null;
    }
  };
  // Category filing (lib/category-filer.mjs): TypeSafe files new or changed Connections and Skills
  // in the background. Off without a key; under `node --test` only with an injected fetch.
  // A hosted workspace uses only a key saved in its own Vault, never the server's environment.
  let filingTimer = null;
  let filingChain = Promise.resolve();
  const resolveFiler = async () => {
    if (inNodeTest && !opts.categoryFilerFetch) return null;
    const env = opts.categoryFilerEnv || (personal || inNodeTest ? {} : process.env);
    let cfg = resolveFilerConfig(env);
    if (!cfg.enabled && cfg.reason === 'missing_api_key') {
      const key = await vault.get('TYPESAFE_API_KEY').catch(() => null);
      if (key) cfg = resolveFilerConfig({ ...env, LOOP_TYPESAFE_API_KEY: key });
    }
    if (!cfg.enabled) return null;
    return opts.categoryFilerFetch ? { ...cfg, fetchImpl: opts.categoryFilerFetch } : cfg;
  };
  const filingPass = async () => {
    if (closed) return null;
    const cfg = await resolveFiler();
    if (!cfg) return null;
    const [conns, skills, catState] = await Promise.all([
      store.list({ clone: false }),
      skillStore.list({ includeContent: true }).catch(() => []),
      catStore.load(),
    ]);
    const result = await fileAll({ connections: conns, skills }, catState, cfg);
    if (closed || !result.changed) return result;
    await catStore.setAuto(result.auto);
    scheduleConnectionsBroadcast();
    scheduleSearchReindex();
    return result;
  };
  // Passes run one after another; a failed pass leaves items on their default category until the next change.
  const runCategoryFiling = () => {
    const pass = filingChain.then(filingPass, filingPass);
    filingChain = pass.catch(() => null);
    return filingChain;
  };
  const currentCategorySuggestions = async (catState = null, lists = null) => {
    const [conns, skills, state] = await Promise.all([
      lists?.connections || store.list({ clone: false }),
      lists?.skills || skillStore.list().catch(() => []),
      catState || catStore.load(),
    ]);
    return categorySuggestions({ connections: conns, skills }, state);
  };
  // For loop__save: file what was just added (waiting at most a few seconds), then report any
  // suggestion that involves an item filed in the last two minutes.
  const fileCategoriesNow = async ({ timeoutMs = 5000 } = {}) => {
    let timer = null;
    await Promise.race([
      runCategoryFiling(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    const state = await catStore.load();
    const since = Date.now() - 120000;
    const recent = new Set();
    for (const [kind, bucket] of [['connection', 'connections'], ['skill', 'skills']]) {
      for (const [itemId, entry] of Object.entries(state.auto?.[bucket] || {})) {
        if (Date.parse(entry.at || '') >= since) recent.add(`${kind}:${itemId}`);
      }
    }
    const suggestions = await currentCategorySuggestions(state);
    return suggestions.filter((sug) => sug.items.some((it) => recent.has(`${it.kind}:${it.id}`)));
  };
  function scheduleCategoryFiling() {
    if (closed || filingTimer) return;
    filingTimer = setTimeout(() => {
      filingTimer = null;
      if (!closed) track(runCategoryFiling());
    }, 1500);
    filingTimer.unref?.();
  }
  const scheduleSearchReindex = () => {
    scheduleCategoryFiling();
    if (closed || !searchIndex.embedder?.isAvailable()) return;
    if (searchReindexTimer) return;
    searchReindexTimer = setTimeout(() => {
      searchReindexTimer = null;
      if (!closed) track(runSearchReindex());
    }, 300);
    searchReindexTimer.unref?.();
  };
  let syncBroadcastTimer = null;
  const scheduleConnectionsBroadcast = () => {
    if (syncBroadcastTimer) return;
    syncBroadcastTimer = setTimeout(() => {
      syncBroadcastTimer = null;
      broadcastSse('connections', { at: Date.now() });
    }, 250);
    syncBroadcastTimer.unref?.();
  };
  // Connection logos are found in the background and cached here; a new one refreshes open dashboards.
  const logos = new LogoStore(dataDir, { allowNetwork: !personal, allowLocalApps: !personal && process.platform === 'darwin' });
  const refreshLogos = (conns) => {
    const list = (Array.isArray(conns) ? conns : [conns]).filter(Boolean);
    if (!list.length) return;
    track(logos.resolveAll(list, { onChange: () => { if (!closed) scheduleConnectionsBroadcast(); } }).catch(() => {}));
  };
  const toolSetupStore = new ToolSetupStore(dataDir);
  const localInstallStore = new LocalInstallStore(dataDir);
  const hostedRelayDispatcher =
    sharedSearch?.hosted && sharedSearch?.loopConnectServer
      ? sharedSearch.loopConnectServer.createHostedRelayDispatcher(dataDir, id || 'local')
      : null;
  let localRelayRef = null;
  const pool = new ConnectionPool(store, vault, {
    personal,
    selfIdentity: dynamicSelfIdentity,
    ...(opts.upstreamFetch ? { upstreamFetch: opts.upstreamFetch } : {}),
    sharedDispatcher: id && sharedSearch?.hosted && sharedSearch.people
      ? createSharedDispatcher({
        people: sharedSearch.people,
        workspaceId: id,
        openWorkspace: (wsId) => sharedSearch.openWorkspace?.(wsId) || null,
        hasPlan: (wsId) => sharedSearch.hasPlan(wsId),
      })
      : null,
    relayDispatcher: hostedRelayDispatcher || {
      handles: (conn) => Boolean(localRelayRef?.handles(conn)),
      listCloudRoutes: () => localRelayRef?.listCloudRoutes?.() || localInstallStore.listCloudRoutes(),
      catalogFor: async (devId) => localRelayRef?.catalogFor(devId) || {},
      callCloudTool: (conn, toolName, args, callOpts) => localRelayRef.callCloudTool(conn, toolName, args, callOpts),
      callTool: (conn, toolName, args, callOpts) => localRelayRef.callTool(conn, toolName, args, callOpts),
    },
    onSync: (updated) => {
      if (closed) return;
      scheduleConnectionsBroadcast();
      if (updated?.transport === 'stdio') localConnect?.scheduleCatalog();
      refreshLogos(updated);
      scheduleSearchReindex();
    },
    onCatalogChanged: ({ toolsChanged, resourcesChanged, promptsChanged, skillsChanged }) => {
      if (closed) return;
      if (toolsChanged) {
        broadcastMcpNotification('notifications/tools/list_changed');
        scheduleSearchReindex();
      }
      if (resourcesChanged) broadcastMcpNotification('notifications/resources/list_changed');
      if (promptsChanged) broadcastMcpNotification('notifications/prompts/list_changed');
      if (skillsChanged) {
        scheduleSearchReindex();
        broadcastSse('skills', { at: Date.now() });
      }
    },
  });
  pool.signIns.onChange = () => { if (!closed) scheduleConnectionsBroadcast(); };
  pool.onReadEvidenceChange = pool.signIns.onChange;
  vault.onWrite = () => pool.clearReadEvidence();
  const connectionRuntimeStatus = (conn) => {
    const appSignIns = pool.signIns.list(conn);
    const readEvidence = pool.readEvidence(conn);
    const namedActions = listNamedActionsForConnection(conn, { appSignIns }).map(publicNamedAction);
    return {
      ...(appSignIns.length ? { appSignIns } : {}),
      ...(readEvidence ? { readEvidence } : {}),
      ...(namedActions.length ? { namedActions } : {}),
    };
  };
  const activity = new ActivityLog(dataDir);
  const deliverSms = async ({ message, dedupKey } = {}) => {
    if (typeof sharedSearch?.sendOwnerSms !== 'function') return { sent: false, reason: 'Loop Text not configured' };
    return sharedSearch.sendOwnerSms({ workspaceKey: id || 'local', message, idempotencyKey: dedupKey });
  };
  const enqueueSavedEnrich = (itemId) => {
    if (closed || !itemId) return;
    let p;
    p = (async () => {
      try {
        const enriched = await savedStore.enrich(itemId, {
          selfIdentity: dynamicSelfIdentity,
          ...(opts.builtinFetch ? { fetchImpl: opts.builtinFetch } : {}),
        });
        if (enriched) await searchIndex?.upsertSavedImmediate?.(enriched).catch(() => {});
        if (!closed) broadcastSse('saved', { at: Date.now() });
      } catch {
        // Non-fatal background fetch error.
      }
    })().finally(() => background.delete(p));
    background.add(p);
  };
  const webhookStore = new WebhookStore(dataDir, { vault });
  const loopAgentStore = new LoopAgentStore(dataDir);
  const runTokens = createRunTokenRegistry();
  const loopAgentHandler = createLoopAgentHandler({
    hosted: Boolean(sharedSearch?.specialistHosted ?? sharedSearch?.hosted),
    env: opts.env || process.env,
    ...(opts.loopAgentDetectClis ? { detectClisImpl: opts.loopAgentDetectClis } : {}),
    ...(opts.loopAgentRunnerImpls ? { runnerImpls: opts.loopAgentRunnerImpls } : {}),
  });
  const resolveMcpAgent = async (token) => {
    if (!token) return null;
    const ephemeral = runTokens.resolve(token, { workspaceId: id || 'local' });
    if (ephemeral) return ephemeral;
    return findAgentByToken(store, token);
  };
  const outboundAlerts = new OutboundAlertStore(dataDir, {
    vault,
    personal,
    getOutboundPolicy: () => getOutboundPolicy(portRef.current),
    fetchImpl: opts.outboundAlertFetch || fetch,
    allowLoopback: Boolean(opts.allowLoopbackAlerts),
  });
  const emitOutboundAlert = (eventType, data) => {
    if (closed) return;
    let p;
    p = outboundAlerts.emit(eventType, data).catch(() => {}).finally(() => background.delete(p));
    background.add(p);
  };
  const unsubscribeApprovalEvents = approvalQueue.onEvent((eventType, approval) => {
    const base = sharedSearch?.publicOrigin || (portRef.current ? `http://127.0.0.1:${portRef.current}` : 'http://127.0.0.1:8799');
    emitOutboundAlert(eventType, {
      approvalId: approval.id,
      kind: approval.kind,
      target: approval.target,
      title: approval.title,
      reason: approval.reason,
      status: approval.status,
      guard: Boolean(approval.guard),
      agentId: approval.agentId,
      agentName: approval.agentName,
      expiresAt: approval.expiresAt,
      approveUrl: `${base}/#approvals?id=${encodeURIComponent(approval.id)}`,
    });
  });

  const executeAutomatedTool = async ({ toolConnectionId, toolName, toolArgs = {}, actorName = 'Loop Schedules', targetLabel = '' }) => {
    const conn = await store.get(toolConnectionId);
    if (!conn || conn.enabled === false) {
      throw Object.assign(new Error(`Connection "${toolConnectionId}" is missing or disabled.`), {
        status: 409,
        code: 'CONNECTION_DISABLED',
      });
    }
    const toolObj = Array.isArray(conn.tools) ? conn.tools.find((t) => t.name === toolName) : null;
    if (!toolObj) {
      throw Object.assign(new Error(`Tool "${toolName}" is not available on connection "${conn.name}".`), {
        status: 404,
        code: 'TOOL_NOT_FOUND',
      });
    }
    const catState = await catStore.load().catch(() => null);
    const categoryId = catState?.connectionCategories?.[conn.id] || null;
    const evalRes = await policyStore.evaluateRun({
      conn,
      toolName,
      args: toolArgs || {},
      categoryId,
    });
    if (evalRes.decision === 'deny') {
      activity.record({
        agentId: null,
        agentName: actorName,
        method: 'automation/run',
        target: `${conn.id}__${toolName}`,
        connectionId: conn.id,
        tool: toolName,
        outcome: 'blocked',
        ok: false,
        error: evalRes.reason || 'Denied by policy.',
      });
      throw Object.assign(new Error(evalRes.reason || 'Automated tool run denied by policy.'), {
        status: 403,
        code: 'POLICY_DENIED',
      });
    }
    if (evalRes.decision === 'always_ask' || evalRes.decision === 'guard') {
      activity.record({
        agentId: null,
        agentName: actorName,
        method: 'automation/run',
        target: `${conn.id}__${toolName}`,
        connectionId: conn.id,
        tool: toolName,
        outcome: 'blocked',
        ok: false,
        error: `Requires ${evalRes.decision} approval.`,
      });
      throw Object.assign(
        new Error(`Automated tool "${conn.id}__${toolName}" requires "${evalRes.decision}" approval and cannot run unattended.`),
        { status: 403, code: 'POLICY_APPROVAL_REQUIRED' },
      );
    }
    const t0 = Date.now();
    const resTool = await pool.callTool(conn.id, toolName, toolArgs || {});
    const ms = Date.now() - t0;
    const isErr = resTool?.isError === true;
    const textOut = resTool?.content?.find((c) => c?.type === 'text')?.text || '';
    const summary = textOut || JSON.stringify(resTool?.structuredContent ?? resTool ?? {}).slice(0, 500);
    activity.record({
      agentId: null,
      agentName: actorName,
      method: 'automation/run',
      target: targetLabel || `${conn.id}__${toolName}`,
      connectionId: conn.id,
      tool: toolName,
      outcome: isErr ? 'error' : 'ok',
      ok: !isErr,
      ms,
      ...(isErr ? { error: summary.slice(0, 240) } : {}),
    });
    if (isErr) {
      throw Object.assign(new Error(summary.slice(0, 240) || 'Automated tool returned an error.'), {
        status: 502,
        code: 'TOOL_ERROR',
      });
    }
    return { ok: true, summary, result: resTool };
  };

  const dispatchWebhookDelivery = async (webhook, payload, { deliveryId, eventId }) => {
    const cfg = webhook.targetConfig || {};
    if (webhook.targetType === 'notify') {
      await notificationStore.send(
        {
          title: String(cfg.title || `Webhook: ${webhook.name}`).slice(0, 120),
          message: String(cfg.message || JSON.stringify(payload)).slice(0, 1000),
          level: 'info',
          dedupKey: `wh:${webhook.id}:${eventId || deliveryId}`,
        },
        { agentId: 'loop_webhooks', agentName: 'Loop Webhooks', deliverSms },
      );
      if (!closed) broadcastSse('notifications', { at: Date.now() });
      return { ok: true };
    }
    if (webhook.targetType === 'task') {
      await taskStore.save(
        {
          expectedRevision: 0,
          title: String(cfg.title || `Webhook: ${webhook.name}`).slice(0, 100),
          objective: String(cfg.objective || JSON.stringify(payload)).slice(0, 500),
          notes: `Triggered by webhook "${webhook.name}" (${webhook.id}, delivery ${deliveryId}).`,
          nextStep: String(cfg.nextStep || 'Review inbound webhook payload.').slice(0, 300),
          status: 'active',
          sources: [],
        },
        { profile: cfg.profile || 'all', writtenBy: 'Loop Webhooks' },
      );
      if (!closed) broadcastSse('tasks', { at: Date.now() });
      return { ok: true };
    }
    if (webhook.targetType === 'tool') {
      const mergedArgs = {
        ...(cfg.toolArgs && typeof cfg.toolArgs === 'object' ? cfg.toolArgs : {}),
        ...(cfg.passPayloadAs ? { [String(cfg.passPayloadAs)]: payload } : {}),
      };
      return executeAutomatedTool({
        toolConnectionId: cfg.toolConnectionId,
        toolName: cfg.toolName,
        toolArgs: mergedArgs,
        actorName: 'Loop Webhooks',
        targetLabel: `${cfg.toolConnectionId}__${cfg.toolName} (${webhook.id})`,
      });
    }
    throw new Error(`Unsupported webhook targetType: ${webhook.targetType}`);
  };

  const scheduleDispatchOpts = () => ({
    dispatchNotify: async (sched) => {
      const sent = await notificationStore.send(
        {
          title: `Reminder: ${sched.title}`,
          message: sched.message || sched.title,
          level: 'info',
          project: sched.projects?.[0] && sched.projects[0] !== 'all' ? sched.projects[0] : '',
          dedupKey: `sched:${sched.id}:${sched.nextRunAt || Date.now()}`,
        },
        { agentId: 'loop_schedules', agentName: 'Loop Schedules', deliverSms },
      );
      if (!closed) broadcastSse('notifications', { at: Date.now() });
      const smsNote = sent?.notification?.smsNote || '';
      const smsUnconfigured = !smsNote || smsNote === 'Loop Text not configured' || smsNote === 'Loop Text not connected';
      const smsFailed = Boolean(!sent?.deliveredSms && !smsUnconfigured);
      return { deliveredSms: Boolean(sent?.deliveredSms), smsFailed, ...(smsNote ? { smsNote } : {}) };
    },
    createTask: async (sched) => {
      const targetProfile = sched.projects?.[0] || 'all';
      return taskStore.save(
        {
          expectedRevision: 0,
          title: sched.title.slice(0, 100),
          objective: (sched.message || sched.title).slice(0, 500),
          notes: `Created automatically by schedule "${sched.title}" (${sched.id}).`,
          nextStep: (sched.message || sched.title).slice(0, 300),
          status: 'active',
          sources: [],
        },
        { profile: targetProfile, writtenBy: 'Loop Schedules' },
      );
    },
    executeTool: async (sched) =>
      executeAutomatedTool({
        toolConnectionId: sched.toolConnectionId,
        toolName: sched.toolName,
        toolArgs: sched.toolArgs || {},
        actorName: 'Loop Schedules',
        targetLabel: `${sched.toolConnectionId}__${sched.toolName} (${sched.id})`,
      }),
  });
  const runScheduleById = (schedId, extra = {}) => scheduleStore.runNow(schedId, { ...extra, ...scheduleDispatchOpts() });
  const tickWorkspaceSchedules = async (now = Date.now()) => {
    const fired = await scheduleStore.tick({ now, ...scheduleDispatchOpts() });
    await webhookStore.processRetries({ handler: dispatchWebhookDelivery, now }).catch(() => {});
    await outboundAlerts.processRetries({ now }).catch(() => {});
    return fired;
  };
  pool.builtinContext = {
    ownerTimezone,
    notificationStore,
    deliverSms,
    broadcast: (type) => { if (!closed) broadcastSse(type, { at: Date.now() }); },
    activity,
  };
  if (opts.builtinFetch) pool.builtinFetch = opts.builtinFetch;
  const hygieneStore = new MemoryHygieneStore(dataDir);

  // Incremental memory hygiene (lib/memory-hygiene.mjs): checks only top-K neighbors of changed
  // memories and caches pair verdicts on disk. Uses TypeSafe/Jev when a key is configured (in
  // `node --test` only with an injected fetch); otherwise stays strictly high-precision local.
  let hygieneTimer = null;
  const hygieneQueue = new HygieneQueue();
  const hygienePendingIds = new Set();
  let hygieneNeedFullSync = false;
  const resolveHygiene = async () => {
    if (inNodeTest && !opts.memoryHygieneFetch) return null;
    const env = opts.memoryHygieneEnv || (personal || inNodeTest ? {} : process.env);
    let cfg = resolveHygieneConfig(env);
    if (!cfg.enabled && cfg.reason === 'missing_api_key') {
      const key = await vault.get('TYPESAFE_API_KEY').catch(() => null);
      if (key) cfg = resolveHygieneConfig({ ...env, LOOP_TYPESAFE_API_KEY: key });
    }
    if (!cfg.enabled) return null;
    return opts.memoryHygieneFetch ? { ...cfg, fetchImpl: opts.memoryHygieneFetch } : cfg;
  };
  const hygienePass = async () => {
    if (closed) return null;
    const focusIds = [...hygienePendingIds];
    const doFull = hygieneNeedFullSync;
    hygienePendingIds.clear();
    hygieneNeedFullSync = false;
    const [allActive, cfg] = await Promise.all([
      memoryStore.list().catch(() => []),
      resolveHygiene().catch(() => null),
    ]);
    if (closed) return null;
    let changed = false;
    if (focusIds.length > 0 && !doFull) {
      const byId = new Map(allActive.map((m) => [m.id, m]));
      for (const fid of focusIds) {
        const mem = byId.get(fid);
        if (!mem) continue;
        const res = await hygieneStore.reviewMemory(mem, allActive, {
          searchIndex,
          classifierConfig: cfg,
        }).catch(() => null);
        if (res?.changed) changed = true;
      }
    } else {
      const res = await hygieneStore.syncAll(allActive, {
        searchIndex,
        classifierConfig: cfg,
      }).catch(() => null);
      if (res?.changed) changed = true;
    }
    if (!closed && changed) broadcastSse('memory', { at: Date.now() });
    return { changed };
  };
  const runMemoryHygiene = () => hygieneQueue.pass(hygienePass);
  function scheduleMemoryHygiene(focusId = null) {
    if (closed) return;
    if (focusId) hygienePendingIds.add(focusId);
    else hygieneNeedFullSync = true;
    if (hygieneTimer) return;
    hygieneTimer = setTimeout(() => {
      hygieneTimer = null;
      if (!closed) track(runMemoryHygiene());
    }, 350);
    hygieneTimer.unref?.();
  }
  // What loop__save and loop__search know about memories that replace or contradict each other. A
  // save checks the new memory against its nearest ones now, so the agent hears it in the same
  // reply; it waits only briefly, and a slower check still ends up in the cache. Search reads only
  // the cache.
  const memoryVerdicts = {
    cached: (memories) => hygieneStore.activeVerdictMap(memories, { relations: OUTDATING_RELATIONS }),
    async forSave(memory, visible) {
      const cfg = await resolveHygiene();
      if (!cfg || closed) return null;
      const review = hygieneQueue.saveCheck(() =>
        closed ? null : hygieneStore.reviewMemory(memory, visible, { searchIndex, classifierConfig: cfg, concurrency: 12 }))
        .then((res) => {
          if (!closed && res?.changed) broadcastSse('memory', { at: Date.now() });
        }).catch(() => null);
      track(review);
      let timer;
      await Promise.race([
        review,
        new Promise((resolve) => { timer = setTimeout(resolve, SAVE_VERDICT_WAIT_MS); timer.unref?.(); }),
      ]);
      clearTimeout(timer);
      return hygieneStore.activeVerdictMap(visible);
    },
  };

  // What Home shows besides connections: memories that disagree, what agents did lately, and
  // today's counts. Pending approvals reach Home live through /api/approvals. Owner actions are left out of the feed.
  const OWNER_METHODS = new Set(['secret/reveal', 'approval/approve', 'approval/always-allow', 'approval/deny']);
  async function buildHomeFeed({ memories, secrets }) {
    const recent = (await activity.list({ limit: 500 })).filter((e) => !OWNER_METHODS.has(e.method));
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const today = recent.filter((e) => Date.parse(e.at) >= dayStart.getTime() && e.ok);
    const countToday = (method) => today.filter((e) => e.method === method).length;

    let conflicts = [];
    if (memories.length > 1) {
      try {
        const verdicts = await hygieneStore.activeVerdictMap(memories);
        // Home's "Needs you" only alerts on genuine disagreements; duplicates & updates stay in Memory -> Tidy.
        conflicts = (buildMemoryGraph(memories, { verdicts }).conflicts || []).filter((c) => c.kind === 'contradiction');
      } catch {
        conflicts = [];
      }
    }
    const memById = new Map(memories.map((m) => [m.id, m]));
    const memLite = (m) => (m ? { id: m.id, content: String(m.content || '').slice(0, 160), writtenBy: m.writtenBy || '', source: m.source || '' } : null);

    const enrichedConflicts = conflicts
      .map((c) => {
        const ma = memById.get(c.a);
        const mb = memById.get(c.b);
        if (!ma || !mb) return null;
        const keep = suggestKeep(ma, mb);
        const pinnedInvolved = Boolean(ma.pinned || mb.pinned);
        const latestAt = Math.max(Date.parse(ma.updatedAt || '') || 0, Date.parse(mb.updatedAt || '') || 0);
        return {
          id: c.id,
          kind: c.kind,
          reason: c.reason,
          keep: keep.id,
          pinnedInvolved,
          updatedAtA: ma.updatedAt || '',
          updatedAtB: mb.updatedAt || '',
          a: memLite(ma),
          b: memLite(mb),
          _latestAt: latestAt,
        };
      })
      .filter(Boolean)
      .sort((x, y) => Number(y.pinnedInvolved) - Number(x.pinnedInvolved) || y._latestAt - x._latestAt);

    const vaultByType = {};
    for (const s of secrets) vaultByType[s.type] = (vaultByType[s.type] || 0) + 1;

    return {
      conflicts: enrichedConflicts
        .slice(0, 3)
        .map(({ _latestAt, ...rest }) => rest),
      conflictsTotal: enrichedConflicts.length,
      activity: recent.slice(0, 8).map((e) => ({
        at: e.at, agentId: e.agentId || null, agentName: e.agentName || '', method: e.method, target: e.target || '', ok: e.ok !== false,
      })),
      today: {
        toolCalls: countToday('tools/call'),
        secretUses: countToday('secret/use'),
        memorySaves: countToday('memory/save'),
      },
      vaultByType,
    };
  }

  const clients = new ClientRegistry(dataDir);
  const inspectorTrace = new InspectorTraceStore();
  const pendingInspectorElicitations = new Map(); // elicitId -> { resolve, timer }
  const owner = new OwnerAuth(dataDir);
  const background = new Set();
  const track = (promise) => {
    background.add(promise);
    promise.finally(() => background.delete(promise));
  };
  // G4a-10: Migrate any legacy inline OAuth secrets out of config.json into Vault on startup.
  track(store.migrateLegacyOAuthSecrets(vault).catch(() => {}));
  // File anything added or changed while Loop was off.
  scheduleCategoryFiling();
  if (!inNodeTest || opts.memoryHygieneFetch) scheduleMemoryHygiene();

  // Upstream sign-in: each pending flow is saved in this workspace's own data directory and bound
  // to this workspace, with outbound policy and self-identity enforced in both local and hosted modes.
  const signInOptions = (connUrl = null, activePort = portRef.current) => {
    const policy = getOutboundPolicy(activePort);
    return {
      dataDir,
      workspace: id || 'local',
      vault,
      selfIdentity: policy.selfIdentity,
      // In local finishOAuthFlow (connUrl === null), omit `network` so oauth.mjs binds the
      // network policy to flow.connUrl while still enforcing policy.selfIdentity.
      ...(personal || connUrl ? { network: policy.oauthNetwork(connUrl) } : {}),
    };
  };

  async function finishSignIn(code, state, { iss = undefined, activePort = portRef.current } = {}) {
    const { connId, connUrl, oauth } = await finishOAuthFlow(code, state, vault, {
      ...signInOptions(null, activePort),
      ...(iss !== undefined ? { iss } : {}),
    });
    let updated;
    try {
      const existing = await store.get(connId);
      if (!existing) {
        throw Object.assign(new Error('This connection no longer exists.'), { status: 404 });
      }
      if (connUrl && existing.url) {
        let sameOrigin = false;
        try { sameOrigin = new URL(existing.url).origin === new URL(connUrl).origin; } catch { sameOrigin = false; }
        if (!sameOrigin) {
          throw Object.assign(new Error('This connection changed while you were signing in. Start the sign-in again.'), { status: 400 });
        }
      } else if (personal) {
        throw Object.assign(new Error('This connection changed while you were signing in. Start the sign-in again.'), { status: 400 });
      }
      if (personal) {
        try {
          assertPersonalStoredConnection({ ...existing, oauth }, { selfIdentity: getSelfIdentity(activePort) });
        } catch (err) {
          throw err?.status ? err : Object.assign(new Error(err?.message || 'Unsupported personal MCP connection.'), { status: 400 });
        }
      }
      updated = await store.update(connId, {
        oauth,
        authRequired: false,
        signInRejectedCall: false,
        signInBroken: null,
        lastError: null,
      });
      if (!updated) {
        throw Object.assign(new Error('This connection no longer exists.'), { status: 404 });
      }
    } catch (err) {
      await deleteConnectionOAuthKeys(vault, connId, { oauth });
      throw err;
    }
    const beforeSeq = toolsBroadcastSeq;
    await pool.retire(connId);
    let syncError = null;
    const syncedFromPool = await pool.sync(connId).catch((err) => {
      syncError = err?.message || 'Could not discover tools.';
      return null;
    });
    const synced = syncedFromPool || (await store.get(connId)) || updated;
    if (toolsBroadcastSeq === beforeSeq) {
      broadcastMcpNotification('notifications/tools/list_changed');
    }
    const readiness = connectionReadiness(synced, { tokenRejected: isTokenRejected(synced) });
    const readEvidence = pool.readEvidence(synced);
    const discoveryError = readiness.ready
      ? null
      : (synced.lastError || syncError || readiness.nextStep || readiness.label || 'Could not discover tools.');
    return {
      connId,
      ready: Boolean(readiness.ready),
      readiness,
      readEvidence,
      discoveryError,
      mcp: { ...sanitizeMcp(synced), ...connectionRuntimeStatus(synced) },
    };
  }

  async function listConnectedApps(activePort) {
    const [seenApps, localAgents] = await Promise.all([
      clients.list(),
      personal || opts.detectLocalAgents === false
        ? []
        : discoverConnectedLocalAgents({
            home: opts.home,
            loopPort: activePort,
            loopStdioPath: stdioPath,
          }).catch(() => []),
    ]);

    const merged = seenApps.map((app) => ({ ...app, configuredIn: null }));
    for (const loc of localAgents) {
      // The key in its settings says which agent it is, also before it connects for the first time.
      const agentId = (await findAgentByToken(store, loc.token))?.id ?? null;
      const targetName = String(loc.name || '').trim().toLowerCase();
      const existing = merged.find(
        (a) => agentId ? a.agentId === agentId :
          String(a.name || '').trim().toLowerCase() === targetName ||
          String(a.clientName || '').trim().toLowerCase() === String(loc.id || '').toLowerCase(),
      );
      if (existing) {
        existing.configuredIn = loc.configPath;
      } else {
        merged.push({
          key: `config:${loc.id}`,
          name: loc.name,
          clientName: loc.id,
          clientVersion: null,
          agentId,
          transport: loc.transport || 'http',
          configuredIn: loc.configPath,
          firstSeenAt: null,
          lastSeenAt: null,
          sessionsActive: 0,
          sessionsTotal: 0,
        });
      }
    }

    // Sign-ins an app started and never finished, so a half-finished install is visible:
    // on that app's row when it has one, otherwise as a row of its own.
    const attempts = unfinishedSignIns();
    if (attempts.length) {
      const agents = await store.listAgents().catch(() => []);
      const sameApp = (attempt, name) =>
        attempt.kind === 'other'
          ? String(name || '').trim().toLowerCase() === attempt.name.toLowerCase()
          : inferAgentKind(name) === attempt.kind;
      for (const attempt of attempts) {
        // An agent of this kind has a key already: the earlier tries no longer matter.
        const hasKey = agents.some((agent) =>
          attempt.kind === 'other' ? sameApp(attempt, agent.name) : agent.kind === attempt.kind);
        if (hasKey) continue;
        const signIn = { attempts: attempt.attempts, lastAttemptAt: attempt.lastAttemptAt };
        const rows = merged.filter(
          (app) => !app.agentId && (sameApp(attempt, app.name) || sameApp(attempt, app.clientName)),
        );
        if (rows.length) {
          for (const row of rows) row.signIn = signIn;
          continue;
        }
        merged.push({
          key: `${SIGN_IN_ROW_PREFIX}${attempt.name}`,
          name: attempt.name,
          clientName: attempt.kind === 'other' ? attempt.name : attempt.kind,
          clientVersion: null,
          agentId: null,
          transport: 'http',
          configuredIn: null,
          firstSeenAt: null,
          lastSeenAt: null,
          sessionsActive: 0,
          sessionsTotal: 0,
          signIn,
        });
      }
    }

    return merged.sort(
      (a, b) =>
        b.sessionsActive - a.sessionsActive ||
        Date.parse(b.lastSeenAt || 0) - Date.parse(a.lastSeenAt || 0) ||
        String(a.name || '').localeCompare(String(b.name || '')),
    );
  }

  // Local hub only: on a hosted server a registration belongs to no account until one
  // approves it, so it cannot be shown to (or forgotten by) any one of them.
  function unfinishedSignIns() {
    if (!mcpOAuth || personal || mcpOAuth.hostedRoot) return [];
    try {
      return mcpOAuth.unfinishedSignIns();
    } catch {
      return [];
    }
  }

  async function agentsPayload(activePort, endpoint) {
    let vaultError = false;
    const hookEnvOpts = {
      includeRecallOnly: true,
      ...(opts.installerHome ? { home: opts.installerHome } : {}),
      ...(opts.installerEnv ? { env: opts.installerEnv } : {}),
    };
    const [agents, connected, secrets, settings, hookStatuses] = await Promise.all([
      store.listAgents(),
      listConnectedApps(activePort),
      vault.list().catch((err) => {
        console.error('[loop-server] Failed to read vault while listing agents:', err);
        vaultError = true;
        return [];
      }),
      store.getSettings(),
      personal ? [] : agentHookStatus(hookEnvOpts).catch(() => []),
    ]);
    const hookById = new Map(hookStatuses.map((h) => [h.id, h]));
    const profileData = await buildProfileRecords({
      store,
      skillStore,
      memoryStore,
      vault,
      agents,
      secrets,
    });
    const list = [];
    for (const a of agents) {
      const capability = turnRecallCapability(a.kind);
      const hook = hookById.get(a.kind) || null;
      list.push(
        publicAgent(a, {
          pictureUrl: await agentPictures.url(a),
          lastSeenAt: await activity.lastSeenFor(a.id),
          turnRecallEffective: isTurnRecallEnabled(a, settings),
          turnRecallCapability: capability,
          ...(hook ? { hookTurnRecall: Boolean(hook.turnRecall), hookInstalled: Boolean(hook.agentInstalled) } : {}),
        }),
      );
    }
    return {
      agents: list,
      connected,
      totalConnected: connected.length,
      kinds: AGENT_KINDS,
      profiles: profileData.profiles,
      profileRecords: profileData.profileRecords,
      secrets: secrets.map((x) => ({
        key: x.key,
        description: x.description,
        type: x.type,
        approval: x.approval,
        profiles: x.profiles,
      })),
      ...(vaultError ? { vaultError: true } : {}),
      turnRecallDefault: Boolean(settings.turnRecall),
      localHooksAvailable: !personal,
      endpoint,
      port: activePort,
      stdioPath,
    };
  }

  const bootId = randomBytes(8).toString('hex');
  const sseClients = new Map(); // response -> a function that checks its session is still valid
  const broadcastSse = (eventName, data) => {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [client, active] of sseClients) {
      try {
        if (!active()) {
          sseClients.delete(client);
          client.end();
          continue;
        }
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  };
  const mcpSseClients = new Map(); // sessionId -> Set<{ res, agentId, heartbeat }>
  const legacySse = new LegacyMcpSseManager();
  const pendingElicitations = new Map(); // rpcId -> { sessionId, agentId, resolve, timer }
  let toolsBroadcastSeq = 0;
  const cancelPendingElicitationsForSession = (sessionId) => {
    if (!sessionId) return;
    for (const [rpcId, entry] of [...pendingElicitations.entries()]) {
      if (entry.sessionId !== sessionId) continue;
      pendingElicitations.delete(rpcId);
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
  };
  const cancelAllPendingElicitations = () => {
    for (const [rpcId, entry] of [...pendingElicitations.entries()]) {
      pendingElicitations.delete(rpcId);
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
  };
  const sendSessionMcpSseEvent = (sessionId, payload) => {
    if (!sessionId) return false;
    const set = mcpSseClients.get(sessionId);
    if (!set || set.size === 0) return false;
    const wire = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const entry of [...set]) {
      if (entry.res.writableEnded || entry.res.destroyed) {
        removeMcpSseEntry(sessionId, entry);
        continue;
      }
      try {
        entry.res.write(wire);
        return true;
      } catch {
        removeMcpSseEntry(sessionId, entry);
        try { entry.res.end(); } catch { /* ignore */ }
      }
    }
    return false;
  };
  const removeMcpSseEntry = (sessionId, entry) => {
    clearInterval(entry.heartbeat);
    const set = mcpSseClients.get(sessionId);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) mcpSseClients.delete(sessionId);
  };
  const broadcastMcpNotification = (method) => {
    if (method === 'notifications/tools/list_changed') {
      scheduleSearchReindex();
    }
    if (closed) return;
    if (method === 'notifications/tools/list_changed') toolsBroadcastSeq += 1;
    if (mcpSseClients.size === 0) return;
    const payload = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method })}\n\n`;
    for (const [sid, set] of [...mcpSseClients.entries()]) {
      for (const entry of [...set]) {
        if (entry.res.writableEnded || entry.res.destroyed) {
          removeMcpSseEntry(sid, entry);
          continue;
        }
        try {
          entry.res.write(payload);
        } catch {
          removeMcpSseEntry(sid, entry);
          try { entry.res.end(); } catch { /* ignore */ }
        }
      }
    }
  };
  const closeMcpSseSession = (sessionId) => {
    cancelPendingElicitationsForSession(sessionId);
    if (!sessionId) return;
    const set = mcpSseClients.get(sessionId);
    if (!set) return;
    mcpSseClients.delete(sessionId);
    for (const entry of [...set]) {
      clearInterval(entry.heartbeat);
      try {
        if (!entry.res.writableEnded && !entry.res.destroyed) entry.res.end();
      } catch {
        // ignore
      }
    }
  };
  const closeAllMcpSse = () => {
    cancelAllPendingElicitations();
    for (const sid of [...mcpSseClients.keys()]) {
      closeMcpSseSession(sid);
    }
  };
  const notifyCatalogChange = (change = null) => {
    if (closed) return;
    if (typeof change === 'string' && change.startsWith('notifications/')) {
      broadcastMcpNotification(change);
      return;
    }
    if (!change || typeof change !== 'object') {
      broadcastMcpNotification('notifications/tools/list_changed');
      return;
    }
    if (typeof change.method === 'string' && change.method.startsWith('notifications/')) {
      broadcastMcpNotification(change.method);
      return;
    }
    const toolsChanged = change.toolsChanged ?? change.tools;
    const resourcesChanged = change.resourcesChanged ?? change.resources;
    const promptsChanged = change.promptsChanged ?? change.prompts;
    if (toolsChanged) broadcastMcpNotification('notifications/tools/list_changed');
    if (resourcesChanged) broadcastMcpNotification('notifications/resources/list_changed');
    if (promptsChanged) broadcastMcpNotification('notifications/prompts/list_changed');
    if (
      toolsChanged === undefined &&
      resourcesChanged === undefined &&
      promptsChanged === undefined
    ) {
      broadcastMcpNotification('notifications/tools/list_changed');
    }
  };
  const unsubscribeApprovals = approvalQueue.subscribe((pending) => {
    broadcastSse('approvals', { count: pending.length });
  });
  const unsubscribeClients = clients.subscribe(() => {
    broadcastSse('agents', { at: Date.now() });
  });
  const unsubscribeActivity = activity.subscribe((entry) => {
    broadcastSse('activity', { agentId: entry?.agentId || null, at: entry?.at || new Date().toISOString() });
  });
  const unsubscribeMemory = memoryStore.subscribe((ev) => {
    broadcastSse('memory', { at: Date.now() });
    scheduleSearchReindex();
    if (!inNodeTest || opts.memoryHygieneFetch) {
      if (ev?.action === 'save' || ev?.action === 'update' || ev?.action === 'restore') {
        scheduleMemoryHygiene(ev.id || null);
      } else if (ev?.action === 'remove' || ev?.action === 'tidy') {
        scheduleMemoryHygiene(null);
      }
    }
  });
  let reloadTimer = null;
  let startupSyncTimer = null;
  let publicWatcher = null;
  // Connections are re-synced when the workspace is used, not on a clock: one sweep shortly after
  // the workspace loads, then one whenever a signed-in request arrives and the last sweep is older
  // than the interval. A workspace nobody is using does no background work and holds no timer.
  const autoSyncEnabled = opts.autoSync !== undefined ? Boolean(opts.autoSync) : opts.authMode !== 'local-test' && opts.port !== 0;
  const sweepIntervalMs = Number.isFinite(Number(opts.autoSyncIntervalMs)) ? Math.max(1000, Number(opts.autoSyncIntervalMs)) : 30 * 60 * 1000;
  let lastSweepAt = Date.now();
  const sweepStaleConnections = () => {
    lastSweepAt = Date.now();
    track(pool.syncStale().catch(() => {}));
  };
  const sweepIfDue = () => {
    if (autoSyncEnabled && !closed && Date.now() - lastSweepAt >= sweepIntervalMs) sweepStaleConnections();
  };
  if (autoSyncEnabled) {
    const startDelay = Number.isFinite(Number(opts.autoSyncDelayMs)) ? Math.max(0, Number(opts.autoSyncDelayMs)) : 1200;
    startupSyncTimer = setTimeout(() => {
      startupSyncTimer = null;
      if (!closed) {
        sweepStaleConnections();
        scheduleSearchReindex();
      }
    }, startDelay);
    startupSyncTimer.unref?.();
  } else if (searchIndex.embedder?.isAvailable()) {
    scheduleSearchReindex();
  }
  try {
    if (!personal) publicWatcher = watch(publicDir, { persistent: false }, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        broadcastSse('reload', Date.now());
      }, 80);
    });
  } catch {
    publicWatcher = null;
  }

  // Guard. The owner's yes counts only with the Loop password, checked for this one request.
  // Each of these answers null to go on, or what to send back.
  async function guardSetupRefusal() {
    if (await owner.isSetUp()) return null;
    return { status: 409, body: { code: 'guard_no_password', error: 'Guard needs a Loop password. Set one up in Settings, under Security.' } };
  }

  async function guardPasswordRefusal(body, target) {
    const refusal = await guardSetupRefusal();
    if (refusal) return refusal;
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!password) return { status: 403, body: { code: 'guard_password', error: 'Enter your Loop password.' } };
    if (await owner.verify(password)) return null;
    activity.record({ agentId: null, agentName: 'Owner (dashboard)', method: 'approval/approve', target, ok: false, error: 'wrong password' });
    return { status: 403, body: { code: 'guard_password', error: 'Wrong password.' } };
  }

  /** A Vault item that goes onto Guard needs a password to exist; one that leaves it needs the password. */
  async function vaultGuardRefusal(key, body) {
    if (body.approval === 'guard') return guardSetupRefusal();
    if (body.approval === undefined && body.type === undefined) return null;
    const before = await vault.getMeta(key);
    if (!before) return null;
    const after = { type: body.type ?? before.type, approval: body.approval ?? before.approval };
    if (!vaultItemLeavesGuard(await policyStore.get(), before, after)) return null;
    return guardPasswordRefusal(body, `vault:${key}`);
  }

  /** "Always allow" never takes anything off Guard: the one request runs, the rule stays. */
  async function alwaysAllowRule(patch) {
    try {
      await policyStore.update(patch);
      return true;
    } catch (err) {
      if (err?.code === 'guard_password') return false;
      throw err;
    }
  }

  // Lets AppWorkspaces drop this workspace from memory once it has been unused for a while: nothing
  // may be going on in it (requests, open dashboards, syncs, calls, approvals waiting for an answer).
  let inFlight = 0;
  let lastUsedAt = Date.now();
  const isIdle = (idleMs, now = Date.now()) =>
    !closed && inFlight === 0 && sseClients.size === 0 && mcpSseClients.size === 0 && background.size === 0 &&
    now - lastUsedAt >= idleMs && pool.isIdle() && approvalQueue.listPending().length === 0;

  async function handle(req, res, activePort, identity = null) {
    setPort(activePort);
    inFlight += 1;
    lastUsedAt = Date.now();
    res.once('close', () => {
      inFlight -= 1;
      lastUsedAt = Date.now();
    });
    const origin = resolveLoopPublicOrigin(req, activePort);
    const deviceFolders = projectFolders && isLocalDeviceRequest(req, activePort) ? projectFolders : null;
    const paired = localConnect ? await localConnect.pairing() : null;
    const endpoint = paired ? paired.cloudUrl + '/mcp' : `${origin}${id ? `/w/${id}` : ''}/mcp`;

    try {
      const url = new URL(req.url, `http://127.0.0.1:${activePort}`);
      const pathname = (id && url.pathname === `/w/${id}/mcp`)
        ? '/mcp'
        : (id && url.pathname === `/w/${id}/mcp/whoami`)
          ? '/mcp/whoami'
          : url.pathname;
      const method = req.method;

      if (personal && (pathname === '/api/import/sources' || pathname === '/api/memory/import/sources' ||
          /\/tools\/test$/.test(pathname))) {
        return sendJson(res, 403, { error: 'This operation is only available in the local device workspace.' });
      }

      if (legacy) {
      // Owner sign-in. Everything under /api/ except these needs a signed-in session.
      if (pathname === '/api/auth/status' && method === 'GET') {
        return sendJson(res, 200, { setUp: await owner.isSetUp(), signedIn: owner.isSignedIn(req) });
      }

      if (pathname === '/api/auth/setup' && method === 'POST') {
        const body = await readJsonBody(req);
        const token = await owner.setup(String(body.password ?? ''));
        return sendJson(res, 200, { signedIn: true }, { 'Set-Cookie': owner.cookie(token) });
      }

      if (pathname === '/api/auth/login' && method === 'POST') {
        const body = await readJsonBody(req);
        const token = await owner.login(String(body.password ?? ''));
        return sendJson(res, 200, { signedIn: true }, { 'Set-Cookie': owner.cookie(token) });
      }

      if (pathname === '/api/auth/logout' && method === 'POST') {
        owner.logout(req);
        return sendJson(res, 200, { signedIn: false }, { 'Set-Cookie': owner.clearCookie() });
      }

      if ((pathname.startsWith('/api/') || pathname === '/events' || pathname === '/oauth/callback') && !owner.isSignedIn(req)) {
        return sendJson(res, 401, { error: 'Sign in to Loop to continue.', auth: 'required' });
      }
      if (pathname === '/api/auth/password' && method === 'POST') {
        const body = await readJsonBody(req);
        const token = await owner.changePassword(String(body.current ?? ''), String(body.next ?? ''));
        return sendJson(res, 200, { changed: true }, { 'Set-Cookie': owner.cookie(token) });
      }

      } else if ((pathname.startsWith('/api/') || pathname === '/events' || pathname === '/oauth/callback') && !identity) {
        return sendJson(res, 401, { error: 'Sign in to Loop to continue.', auth: 'required' });
      }

      // The owner is using the dashboard.
      if (pathname.startsWith('/api/') || pathname === '/events') sweepIfDue();

      if (!legacy && pathname === '/api/auth/vault-password' && method === 'POST') {
        const body = await readJsonBody(req);
        await owner.setVaultPassword(String(body.current ?? ''), String(body.next ?? ''));
        return sendJson(res, 200, { changed: true });
      }

      // Showing a secret value always needs the owner's password again.
      const revealMatch = pathname.match(/^\/api\/vault\/([^/]+)\/reveal$/);
      if (revealMatch && method === 'POST') {
        const key = decodeURIComponent(revealMatch[1]);
        const body = await readJsonBody(req);
        const ok = await owner.verify(String(body.password ?? ''));
        if (!ok || key.startsWith('__')) {
          activity.record({ agentId: null, agentName: 'Owner (dashboard)', method: 'secret/reveal', target: key, ok: false, error: ok ? 'reserved' : 'wrong password' });
          return sendJson(res, ok ? 400 : 401, { error: ok ? 'This secret is managed by Loop.' : 'Wrong password.' });
        }
        const value = await vault.get(key);
        if (value === null) return sendJson(res, 404, { error: 'Secret not found.' });
        activity.record({ agentId: null, agentName: 'Owner (dashboard)', method: 'secret/reveal', target: key, ok: true });
        return sendJson(res, 200, { key, value });
      }

      if (pathname === '/events' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-store',
          Connection: 'keep-alive',
        });
        res.write(`event: hello\ndata: ${bootId}\n\n`);
        const active = identity ? () => identity.expiresAt > Date.now() : () => owner.isSignedIn(req);
        const timer = identity ? setTimeout(() => res.end(), Math.max(1, Math.min(3600000, identity.expiresAt - Date.now()))) : null;
        timer?.unref();
        sseClients.set(res, active);
        req.on('close', () => { clearTimeout(timer); sseClients.delete(res); });
        return;
      }

      if (paired && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const shared = /^\/api\/(?:memory|skills|tasks|vault|profiles|categories|agents|policies)(?:\/|$)/.test(pathname);
        const deviceAction = pathname === '/api/agents/install' || /^\/api\/profiles\/[^/]+\/folder$/.test(pathname);
        if (shared && !deviceAction) {
          return sendJson(res, 409, { code: 'USE_CLOUD_WORKSPACE', cloudUrl: paired.cloudUrl,
            error: 'Open ' + paired.cloudUrl + ' to edit the shared workspace.' });
        }
      }
      // Agent self-inspection endpoint: returns caller identity and scope without any secret values.
      if (pathname === '/mcp/whoami' && method === 'GET') {
        const token = extractBearerToken(req);
        const caller = await resolveMcpAgent(token);
        if (!caller) {
          const settings = await store.getSettings();
          if (!legacy || settings.requireAgentToken) {
            return sendJson(res, 401, { error: 'Valid Loop agent token required.' });
          }
        }
        if (caller && !caller.enabled) {
          return sendJson(res, 403, { error: `Agent "${caller.name}" is turned off in Loop.` });
        }
        const [settings, conns] = await Promise.all([store.getSettings(), store.list({ clone: false })]);
        const effAccess = resolveAccess(settings, { agent: caller, profile: url.searchParams.get('profile') || null, personal });
        const reachable = conns.filter((c) => c.enabled !== false && (!effAccess.allowedConnections || effAccess.allowedConnections.has(c.id)));
        return sendJson(res, 200, {
          authenticated: Boolean(caller),
          workspace: personal ? 'personal' : 'local',
          agent: caller
            ? {
                id: caller.id,
                name: caller.name,
                kind: caller.kind,
                profile: effAccess.profile,
                accessSet: caller.accessSet || null,
                approvalMode: caller.approvalMode || null,
                accountChoice: caller.accountChoice || {},
                canManage: effAccess.canManage,
                memoryAccess: effAccess.memoryAccess,
                ownerSession: Boolean(effAccess.ownerSession),
                rateLimitPerMin: caller.rateLimitPerMin || null,
                secretCount: Array.isArray(caller.secrets) ? caller.secrets.length : 0,
              }
            : null,
          connections: reachable.map((c) => ({
            id: c.id,
            name: c.name,
            ...(c.accountLabel ? { accountLabel: c.accountLabel } : {}),
            transport: c.transport,
            toolCount: Array.isArray(c.tools) ? c.tools.length : 0,
          })),
        });
      }

      // Single Loop MCP Gateway endpoint
      if (pathname === '/mcp' && paired) return sendRpcJson(res, 409, rpcError(null, -32001, 'Reconnect this agent through Add Agent. This computer uses ' + endpoint));
      if (pathname === '/mcp') {
        try {
          const wwwAuth = mcpOAuth
            ? { 'WWW-Authenticate': mcpOAuth.wwwAuthenticateHeader(origin, url.pathname) }
            : {};
          const sessionId = String(req.headers['mcp-session-id'] || '').slice(0, 64) || null;
          let verifiedAgent = null;
          if (!legacy) {
            verifiedAgent = await resolveMcpAgent(extractBearerToken(req));
            if (!verifiedAgent) return sendRpcJson(res, 401, rpcError(null, -32001, mcpUnauthorizedMessage(origin)), wwwAuth);
            const boundComputer = verifiedAgent.oauthClientId?.match(/^paired:(dev_[a-f0-9]{16}):/)?.[1];
            if (boundComputer && !(await sharedSearch.loopConnectServer.listDevices(dataDir)).some(d => d.id === boundComputer)) return sendRpcJson(res, 403, rpcError(null, -32001, 'This computer has been disconnected.'));
            if (!verifiedAgent.enabled) return sendRpcJson(res, 403, rpcError(null, -32001, 'Agent is disabled.'));
            if (sessionId) {
              const existingSess = await clients.getSession(sessionId);
              const canRecoverPost = method === 'POST' && !existingSess && !url.searchParams.get('project');
              if (!canRecoverPost && (!existingSess || existingSess.closedAt || existingSess.agentId !== verifiedAgent.id)) {
                return sendRpcJson(res, 404, rpcError(null, -32001, 'Unknown agent session.'));
              }
            }
          }
          // An agent is using the workspace.
          sweepIfDue();
          if (method === 'DELETE') {
            if (legacy) {
              const token = extractBearerToken(req);
              const caller = await resolveMcpAgent(token);
              if (token ? !caller?.enabled : (await store.getSettings()).requireAgentToken) return sendRpcJson(res, 401, rpcError(null, -32001, 'Authentication required.'));
              if (!await clients.ownsSession(sessionId, caller?.id ?? null)) return sendRpcJson(res, 404, rpcError(null, -32001, 'Unknown agent session.'));
            }
            // Streamable HTTP clients close their session this way.
            closeMcpSseSession(sessionId);
            await clients.endSession(sessionId);
            res.writeHead(204);
            return res.end();
          }
          if (method === 'GET') {
            let sseAgent = verifiedAgent;
            if (legacy) {
              const token = extractBearerToken(req);
              if (token) {
                sseAgent = await resolveMcpAgent(token);
                if (!sseAgent) {
                  return sendRpcJson(
                    res,
                    401,
                    rpcError(null, -32001, 'Unknown Loop agent token. Copy a fresh one from Agents on Loop Home.'),
                    wwwAuth,
                  );
                }
                if (!sseAgent.enabled) {
                  return sendRpcJson(
                    res,
                    403,
                    rpcError(null, -32001, `Agent "${sseAgent.name}" is turned off in Loop.`),
                  );
                }
                activity.touch(sseAgent.id);
              } else {
                const settings = await store.getSettings();
                if (settings.requireAgentToken) {
                  return sendRpcJson(
                    res,
                    401,
                    rpcError(
                      null,
                      -32001,
                      `Loop needs an agent token. Open ${origin}/#agents, add this agent, and connect with its token.`,
                    ),
                    wwwAuth,
                  );
                }
              }
            }
            const accept = String(req.headers.accept || '').toLowerCase();
            if (!accept.includes('text/event-stream')) {
              return sendJson(res, 406, { error: 'Accept header must include text/event-stream.' });
            }
            if (!sessionId) {
              return sendRpcJson(res, 400, rpcError(null, -32600, 'Missing Mcp-Session-Id header.'));
            }
            if (legacy) {
              const sess = await clients.getSession(sessionId);
              if (!sess || sess.closedAt || sess.agentId !== (sseAgent?.id || null)) {
                return sendRpcJson(res, 404, rpcError(null, -32001, 'Unknown agent session.'));
              }
            }
            if (closed) {
              return sendJson(res, 503, { error: 'Server is shutting down.' });
            }
            await clients.touchSession(sessionId);
            if (closed || res.writableEnded || res.destroyed) return;
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-store',
              Connection: 'keep-alive',
              'Mcp-Session-Id': sessionId,
            });
            res.write(': connected\n\n');
            const entry = {
              res,
              agentId: sseAgent?.id || null,
              heartbeat: null,
            };
            entry.heartbeat = setInterval(() => {
              if (closed || res.writableEnded || res.destroyed) {
                removeMcpSseEntry(sessionId, entry);
                return;
              }
              try {
                res.write(': ping\n\n');
              } catch {
                removeMcpSseEntry(sessionId, entry);
                try { res.end(); } catch { /* ignore */ }
              }
            }, 25_000);
            entry.heartbeat.unref?.();
            let set = mcpSseClients.get(sessionId);
            if (!set) {
              set = new Set();
              mcpSseClients.set(sessionId, set);
            }
            set.add(entry);
            const cleanup = () => removeMcpSseEntry(sessionId, entry);
            req.on('close', cleanup);
            res.on('close', cleanup);
            return;
          }
          if (method !== 'POST') {
            res.setHeader('Allow', 'GET, POST, DELETE');
            return sendRpcJson(res, 405, rpcError(null, -32600, 'Use GET, POST, or DELETE for MCP Streamable HTTP.'));
          }
          let rawText;
          try {
            rawText = await readRawBody(req, { maxBytes: MAX_JSON_BODY_BYTES });
          } catch (bodyErr) {
            if (bodyErr?.code === 'BODY_TOO_LARGE') {
              return sendRpcJson(res, 413, rpcError(null, -32600, bodyErr.publicMessage), { Connection: 'close' });
            }
            return sendRpcJson(res, 400, rpcError(null, -32700, 'Invalid JSON.'));
          }
          let msg;
          let rawUnsafeId = null;
          const trimmedBody = rawText.trim();
          if (!trimmedBody) {
            msg = {};
          } else {
            try {
              msg = JSON.parse(trimmedBody);
            } catch {
              return sendRpcJson(res, 400, rpcError(null, -32700, 'Invalid JSON.'));
            }
            if (isPlainObject(msg)) {
              rawUnsafeId = extractRawTopLevelIdToken(trimmedBody);
            }
          }
          const isSingleObject = isPlainObject(msg);
          const singleMsgId = isSingleObject ? (msg.id ?? null) : null;

          const token = extractBearerToken(req);
          let agent = null;
          if (token) {
            agent = verifiedAgent || await resolveMcpAgent(token);
            if (!agent) {
              return sendRpcJson(
                res,
                401,
                rpcError(singleMsgId, -32001, 'Unknown Loop agent token. Copy a fresh one from Agents on Loop Home.'),
                wwwAuth,
                rawUnsafeId,
              );
            }
            if (!agent.enabled) {
              return sendRpcJson(
                res,
                403,
                rpcError(singleMsgId, -32001, `Agent "${agent.name}" is turned off in Loop.`),
                {},
                rawUnsafeId,
              );
            }
            activity.touch(agent.id);
          } else {
            const settings = await store.getSettings();
            if (settings.requireAgentToken) {
              return sendRpcJson(
                res,
                401,
                rpcError(
                  singleMsgId,
                  -32001,
                  `Loop needs an agent token. Open ${origin}/#agents, add this agent, and connect with its token.`,
                ),
                wwwAuth,
                rawUnsafeId,
              );
            }
          }

          const reqMeta = isSingleObject && isPlainObject(msg.params?._meta) ? msg.params._meta : null;
          const metaClientInfo = isPlainObject(reqMeta?.['io.modelcontextprotocol/clientInfo'])
            ? reqMeta['io.modelcontextprotocol/clientInfo']
            : null;
          const metaClientCaps = isPlainObject(reqMeta?.['io.modelcontextprotocol/clientCapabilities'])
            ? reqMeta['io.modelcontextprotocol/clientCapabilities']
            : null;
          const metaProtocolVersion =
            typeof reqMeta?.['io.modelcontextprotocol/protocolVersion'] === 'string'
              ? reqMeta['io.modelcontextprotocol/protocolVersion'].trim()
              : null;

          let mcpClientInfo = null;
          const queryProfile = url.searchParams.get('profile') || null;
          const queryRoleRaw = url.searchParams.get('role');
          const queryRole = typeof queryRoleRaw === 'string' && queryRoleRaw.trim()
            ? queryRoleRaw.trim().toLowerCase().slice(0, 64)
            : null;
          const rawActor =
            (typeof req.headers['x-loop-actor'] === 'string' && req.headers['x-loop-actor'].trim())
              ? req.headers['x-loop-actor'].trim()
              : (typeof reqMeta?.actor === 'string' && reqMeta.actor.trim() ? reqMeta.actor.trim() : null);
          if (queryRole) {
            const agentSet = agent?.accessSet ? String(agent.accessSet).toLowerCase() : null;
            if (agentSet && agentSet !== 'everything' && agentSet !== queryRole) {
              return sendRpcJson(res, 403, rpcError(singleMsgId, -32003, 'Role cannot widen an agent access set.'));
            }
            const curSettings = await store.getSettings();
            if (!resolveAccessSetRecord(queryRole, curSettings?.accessSets)) {
              return sendRpcJson(res, 400, rpcError(singleMsgId, -32602, `Unknown role "${queryRole}".`));
            }
          }
          let initialProject = null, baseGrant = null;
          if (isSingleObject && (msg.method === 'initialize' || msg.method === 'server/discover')) {
            baseGrant = resolveAccess(await store.getSettings(), { agent, profile: queryProfile, role: queryRole, actor: rawActor });
            const requested = url.searchParams.get('project');
            if (requested) {
              const target = normalizeProfileTag(requested);
              if (!target || target !== requested || target === 'all' ||
                  (baseGrant.profile !== 'all' ? baseGrant.profile !== target : !baseGrant.canManage) ||
                  !(await findWorkspaceProjects({ store, pool, skillStore, access: baseGrant })).some((p) => p.id === target)) {
                return sendRpcJson(res, 400, rpcError(singleMsgId, -32602, 'Project is unavailable for this session.'));
              }
              if (baseGrant.profile === 'all') initialProject = target;
            }
          }
          let activeSessionId = sessionId;
          let recoveredSessionId = null;
          let session = sessionId ? await clients.getSession(sessionId) : null;
          if (sessionId && (!session || session.closedAt || session.agentId !== (agent?.id ?? null))) {
            const canRecover =
              !session &&
              agent &&
              agent.enabled !== false &&
              !url.searchParams.get('project') &&
              !(isSingleObject && msg.method === 'initialize');
            if (canRecover) {
              const recGrant = resolveAccess(await store.getSettings(), {
                agent,
                profile: queryProfile,
                role: queryRole,
                actor: rawActor,
              });
              recoveredSessionId = await clients.startSession({
                clientInfo: metaClientInfo || { name: agent.name || 'Recovered client' },
                clientCapabilities: metaClientCaps || null,
                protocolVersion: metaProtocolVersion || req.headers['mcp-protocol-version'] || '2025-03-26',
                agent,
                baseProfile: recGrant.profile,
                project: null,
                transport: req.headers['x-loop-bridge'] === 'stdio' ? 'stdio' : 'http',
              });
              activeSessionId = recoveredSessionId;
              session = await clients.getSession(recoveredSessionId);
            } else {
              return sendRpcJson(res, 404, rpcError(singleMsgId, -32001, 'Unknown agent session.'));
            }
          }
          if (isSingleObject && msg.method === 'initialize') {
            mcpClientInfo = msg.params?.clientInfo || metaClientInfo || null;
          } else if (metaClientInfo) {
            mcpClientInfo = metaClientInfo;
          } else if (activeSessionId) {
            mcpClientInfo = session?.clientName ? { name: session.clientName } : null;
          }

          const ac = new AbortController();
          const onResClose = () => {
            if (!res.writableEnded) ac.abort();
          };
          res.on('close', onResClose);
          const reqCancelKey = isSingleObject && singleMsgId !== null && Object.hasOwn(msg, 'method')
            ? `${sessionId || '__stateless'}::${String(singleMsgId)}`
            : null;
          const reqCancelEntry = reqCancelKey
            ? { ac, agentId: agent?.id ?? null, cancelledByClient: false }
            : null;
          if (reqCancelKey && reqCancelEntry) {
            activeMcpRequests.set(reqCancelKey, reqCancelEntry);
          }

          const slowCall = keepSlowCallAlive(req, res, msg, opts.slowCall);

          const elicitCaps = session?.capabilities?.elicitation || null;
          const canElicitForm = Boolean(elicitCaps?.form);
          const canElicitUrl = Boolean(elicitCaps?.url);
          const hasElicitTransport = Boolean(
            sessionId &&
            (slowCall.canStream || (mcpSseClients.get(sessionId)?.size || 0) > 0),
          );
          const elicitApproval = (canElicitForm || canElicitUrl) && hasElicitTransport
            ? async ({ approval, approveUrl, timeoutMs = 120_000, signal: elicitSignal = null }) => {
                if (closed || ac.signal.aborted || elicitSignal?.aborted) {
                  return { outcome: 'fallback' };
                }
                const rpcId = `elicit_${randomBytes(8).toString('hex')}`;
                // A form is answered inside the agent's own app. Guard takes its yes only on the
                // Loop page, so the app may open the link and nothing else.
                if (approval?.guard && !canElicitUrl) return { outcome: 'fallback' };
                const useForm = canElicitForm && !approval?.guard;
                const spec = approval?.uiSpec || buildApprovalUiSpec({
                  kind: approval?.kind,
                  target: approval?.target,
                  title: approval?.title,
                  reason: approval?.reason,
                  detail: approval?.detail,
                  agentName: approval?.agentName,
                });
                const params = specToMcpElicitation(spec, {
                  approveUrl,
                  protocolVersion: session?.protocolVersion || '2025-11-25',
                  useForm,
                  elicitationId: approval?.id || '',
                });

                const rpcPayload = {
                  jsonrpc: '2.0',
                  id: rpcId,
                  method: 'elicitation/create',
                  params,
                };

                const responsePromise = new Promise((resolve) => {
                  const finish = (value) => {
                    const existing = pendingElicitations.get(rpcId);
                    if (!existing) return;
                    pendingElicitations.delete(rpcId);
                    clearTimeout(existing.timer);
                    if (elicitSignal) elicitSignal.removeEventListener('abort', onAbort);
                    ac.signal.removeEventListener('abort', onAbort);
                    resolve(value);
                  };
                  const onAbort = () => finish(null);
                  const timer = setTimeout(() => finish(null), Math.max(1000, timeoutMs));
                  timer.unref?.();
                  pendingElicitations.set(rpcId, {
                    sessionId,
                    agentId: agent?.id ?? null,
                    resolve: finish,
                    timer,
                  });
                  if (elicitSignal) {
                    if (elicitSignal.aborted) { finish(null); return; }
                    elicitSignal.addEventListener('abort', onAbort, { once: true });
                  }
                  if (ac.signal.aborted) { finish(null); return; }
                  ac.signal.addEventListener('abort', onAbort, { once: true });
                });

                const sent = slowCall.canStream
                  ? slowCall.sendEvent(rpcPayload)
                  : sendSessionMcpSseEvent(sessionId, rpcPayload);
                if (!sent) {
                  const existing = pendingElicitations.get(rpcId);
                  if (existing) existing.resolve(null);
                  return { outcome: 'fallback' };
                }

                const clientReply = await responsePromise;
                return parseMcpElicitationAnswer(spec, clientReply, { useForm });
              }
            : null;

          const effectiveClientCaps = isSingleObject && msg.method === 'initialize'
            ? summarizeClientCapabilities(msg.params?.capabilities || metaClientCaps || null, mcpClientInfo)
            : metaClientCaps
              ? summarizeClientCapabilities(metaClientCaps, mcpClientInfo)
              : (session?.capabilities || null);

          const mcpOpts = {
            serverVersion: sharedSearch?.serverVersion || currentLoopVersion(path.dirname(fileURLToPath(import.meta.url))),
            hostedExecutor: sharedSearch?.hosted === true,
            memberAgent: Boolean(id && agent && sharedSearch?.shares && await sharedSearch.shares.isMemberAgent(id, agent.id)),
            profile: queryProfile, initialProject,
            ...(agent && deviceFolders ? { resolveProjectFolder: (projectId) => deviceFolders.resolve(projectId), projectFolders: deviceFolders } : {}),
            projectSession: session?.baseProfile ? {
              read: () => clients.getSession(activeSessionId),
              set: (project) => clients.setSessionProject(activeSessionId, agent?.id ?? null, project),
            } : null,
            onProjectDeleted: (project) => projectGone(project),
            agent,
            role: queryRole,
            actor: rawActor,
            executionDevice: agent?.oauthClientId?.match(/^paired:(dev_[a-f0-9]{16}):/)?.[1] || url.searchParams.get('device') || null,
            clientInfo: mcpClientInfo,
            clientCapabilities: effectiveClientCaps,
            feedback: sharedSearch?.feedback ? {
              ...sharedSearch.feedback,
              workspaceId: id || 'local',
              clientVersion: session?.clientVersion,
              protocolVersion: session?.protocolVersion || metaProtocolVersion || req.headers['mcp-protocol-version'],
              transport: session?.transport,
              surface: sharedSearch.feedback.shared ? 'cloud' : 'local',
            } : null,
            sessionId: activeSessionId,
            elicitApproval,
            onSignInRequired: (info) => emitOutboundAlert('signin.required', info),
            onPolicyChange: (target) => broadcastSse('policies', { target, at: Date.now() }),
            onClientResponse: (rpcMsg) => {
              if (!sessionId || rpcMsg?.id === undefined || rpcMsg?.id === null) return;
              const entry = pendingElicitations.get(String(rpcMsg.id));
              if (!entry) return;
              if (entry.sessionId !== sessionId || entry.agentId !== (agent?.id ?? null)) return;
              entry.resolve(rpcMsg);
            },
            onCancelRequest: ({ requestId, reason }) => {
              const targetKey = `${sessionId || '__stateless'}::${String(requestId)}`;
              const entry = activeMcpRequests.get(targetKey);
              if (!entry) return;
              if (entry.agentId !== (agent?.id ?? null)) return;
              entry.cancelledByClient = true;
              entry.ac.abort(new Error(reason || 'Request cancelled by client.'));
            },
            activity,
            skillStore,
            memoryStore,
            taskStore,
            savedStore,
            scheduleStore,
            fileStore,
            historyStore,
            dreamStore,
            ownerTimezone,
            onSavedEnrich: enqueueSavedEnrich,
            onScheduleRun: runScheduleById,
            broadcast: (type, data = {}) => { if (!closed) broadcastSse(type, { at: Date.now(), ...data }); },
            catStore,
            categoryRequests,
            policyStore,
            approvalQueue,
            searchIndex,
            memoryVerdicts,
            shareStore: sharedSearch?.shares || null,
            library,
            agentHandoffs: sharedSearch?.agentHandoffs || null,
            workspaceId: id || null,
            clipboardWriter: opts.clipboardWriter || null,
            onNeedSearchIndex: scheduleSearchReindex,
            fileCategoriesNow,
            personal,
            loopPort: activePort,
            loopStdioPath: stdioPath,
            outboundPolicy: getOutboundPolicy(activePort),
            dashboardUrl: `${origin}/`,
            signInsLeft: id && sharedSearch?.hosted && sharedSearch.people
              ? () => signInsLeft(sharedSearch.people, { id, peopleContext })
              : null,
            signal: ac.signal,
            onTaskDispatched: async (task, meta) => {
              const info = sharedSearch?.loopConnectServer
                ? await sharedSearch.loopConnectServer.getDevicesInfo(dataDir).catch(() => null)
                : null;
              const onlineDevices = (info?.devices || []).filter((d) => d.online).map((d) => ({ id: d.id, name: d.name }));
              let liveDispatch = null;
              if (typeof opts.onTaskDispatch === 'function') {
                liveDispatch = await opts.onTaskDispatch(task, { workspaceId: id || 'local', onlineDevices, access: meta?.access }).catch(() => null);
              }
              return {
                mode: liveDispatch?.dispatched ? 'live' : 'inbox',
                assignedTo: task.assignedTo,
                onlineDevicesCount: onlineDevices.length,
                ...(liveDispatch ? { liveDispatch } : {}),
              };
            },
            onTaskCompleted: async (task, meta) => {
              emitOutboundAlert('task.completed', {
                taskId: task?.id || null,
                title: task?.title || '',
                status: task?.status || 'completed',
                actorName: meta?.access?.agent?.name || 'Agent',
              });
              await sharedSearch?.onTaskCompleted?.(task, {
                workspaceKey: id || 'local',
                actorName: meta?.access?.agent?.name || 'Agent',
              });
            },
            onCatalogMutation: (ev) => {
              notifyCatalogChange(ev);
              scheduleSearchReindex();
              scheduleConnectionsBroadcast();
            },
          };

          let reply;
          try {
            // Master switch: while Loop is paused, agents see no tools and every call is refused.
            if (isSingleObject && (msg.method === 'tools/list' || msg.method === 'tools/call')) {
              const { paused } = await store.getSettings();
              if (paused) {
                if (msg.id === undefined) {
                  return sendRpcJson(res, 202, null);
                }
                const result = msg.method === 'tools/list'
                  ? { tools: [] }
                  : { content: [{ type: 'text', text: 'Loop is paused. Turn it back on from the Loop dashboard (Home).' }], isError: true };
                return sendRpcJson(res, 200, { jsonrpc: '2.0', id: msg.id, result }, {}, rawUnsafeId);
              }
            } else if (
              Array.isArray(msg) &&
              msg.some((m) => isPlainObject(m) && (m.method === 'tools/list' || m.method === 'tools/call'))
            ) {
              const { paused } = await store.getSettings();
              if (paused) {
                const replies = [];
                for (const item of msg) {
                  if (isPlainObject(item) && (item.method === 'tools/list' || item.method === 'tools/call')) {
                    if (item.id !== undefined) {
                      const result = item.method === 'tools/list'
                        ? { tools: [] }
                        : { content: [{ type: 'text', text: 'Loop is paused. Turn it back on from the Loop dashboard (Home).' }], isError: true };
                      replies.push({ jsonrpc: '2.0', id: item.id, result });
                    }
                  } else {
                    const sub = await handleMcpRequest(store, vault, pool, item, mcpOpts);
                    if (sub !== null) replies.push(sub);
                  }
                }
                if (res.writableEnded || res.destroyed) return;
                if (sessionId) await clients.touchSession(sessionId);
                return sendRpcJson(res, replies.length === 0 ? 202 : 200, replies.length === 0 ? null : replies);
              }
            }

            const mcpCallStart = Date.now();
            reply = await handleMcpRequest(store, vault, pool, msg, mcpOpts);
            inspectorTrace.record({
              source: 'mcp',
              agentId: agent?.id || null,
              agentName: agent?.name || 'Unauthenticated client',
              profile: initialProject || baseGrant?.profile || mcpOpts.profile || 'all',
              sessionId,
              durationMs: Date.now() - mcpCallStart,
              request: msg,
              response: reply,
              vault,
            }).then((entry) => {
              if (!closed && entry) broadcastSse('inspector_trace', entry);
            }).catch(() => {});
          } catch (err) {
            if (!slowCall.streaming) throw err;
            console.error('[loop-mcp] Internal MCP request error:', err);
            reply = rpcError(msg.id, -32603, 'Internal error.');
          } finally {
            slowCall.stop();
            res.off('close', onResClose);
            if (reqCancelKey && activeMcpRequests.get(reqCancelKey) === reqCancelEntry) {
              activeMcpRequests.delete(reqCancelKey);
            }
          }

          if (res.writableEnded || res.destroyed) return;
          if (reqCancelEntry?.cancelledByClient) {
            res.writeHead(204);
            res.end();
            return;
          }

          const extraHeaders = {};
          if (isSingleObject && msg.method === 'initialize' && reply && !reply.error) {
            // One app (Claude Code, Codex, Kimi…) = one agent; each initialize = one session.
            extraHeaders['Mcp-Session-Id'] = await clients.startSession({
              clientInfo: msg.params?.clientInfo,
              clientCapabilities: msg.params?.capabilities || null,
              protocolVersion: reply.result?.protocolVersion || null,
              agent,
              baseProfile: baseGrant.profile, project: initialProject,
              transport: req.headers['x-loop-bridge'] === 'stdio' ? 'stdio' : 'http',
            });
          } else if (recoveredSessionId) {
            extraHeaders['Mcp-Session-Id'] = recoveredSessionId;
            extraHeaders['X-Loop-Session-Recovered'] = '1';
            await clients.touchSession(recoveredSessionId, { used: msg?.method === 'tools/call' });
          } else if (activeSessionId) {
            await clients.touchSession(activeSessionId, { used: msg?.method === 'tools/call' });
          }
          if (slowCall.streaming) return slowCall.end(reply, rawUnsafeId);
          return sendRpcJson(res, reply === null ? 202 : 200, reply, extraHeaders, rawUnsafeId);
        } catch (mcpErr) {
          if (res.writableEnded) return;
          if (res.headersSent) {
            try { res.end(); } catch { /* ignore */ }
            return;
          }
          if (mcpErr?.code === 'BODY_TOO_LARGE') {
            return sendRpcJson(res, 413, rpcError(null, -32600, mcpErr.publicMessage), { Connection: 'close' });
          }
          if (mcpErr?.code === 'INVALID_JSON') {
            return sendRpcJson(res, 400, rpcError(null, -32700, 'Invalid JSON.'));
          }
          console.error('[loop-mcp] Internal MCP request error:', mcpErr);
          return sendRpcJson(res, 500, rpcError(null, -32603, 'Internal error.'));
        }
      }

      // A Loop on one computer: the link holds the list, and opens the Loop on the computer of the person.
      if (!id && (pathname === '/api/people' || pathname.startsWith('/api/people/'))) {
        return await handleLocalPeople({ req, res, pathname, method, ctx: peopleContext, origin, readJsonBody, sendJson });
      }

      // Agents: one identity, token and set of permissions per MCP client
      if (pathname === '/api/agents' && method === 'GET') {
        return sendJson(res, 200, await agentsPayload(activePort, endpoint));
      }

      if (pathname === '/api/agents/installable' && method === 'GET') {
        if (personal || sharedSearch?.hosted) {
          return sendJson(res, 403, { error: 'Direct agent install is only available on a local Mac workspace.' });
        }
        const installOpts = {
          endpoint,
          ...(opts.installerHome ? { home: opts.installerHome } : {}),
          ...(opts.installerPlatform ? { platform: opts.installerPlatform } : {}),
          ...(opts.installerEnv ? { env: opts.installerEnv } : {}),
        };
        const [detected, existingAgents, apps] = await Promise.all([
          detectInstallableAgents(installOpts),
          store.listAgents(),
          listConnectedApps(activePort),
        ]);
        // An app that signed in to Loop by itself is connected, with no key in its settings.
        const enabledIds = new Set(existingAgents.filter((a) => a.enabled !== false).map((a) => a.id));
        const signedIn = new Set(apps.filter((app) => app.configuredIn && enabledIds.has(app.agentId))
          .flatMap((app) => [app.name, app.clientName]).map((name) => String(name || '').toLowerCase()));
        const byDirectClient = new Map();
        for (const a of existingAgents) {
          if (a.enabled !== false && typeof a.oauthClientId === 'string' && a.oauthClientId.startsWith('direct:')) {
            byDirectClient.set(a.oauthClientId.slice('direct:'.length), a);
          }
        }
        const agents = detected.map((item) => {
          const bound = byDirectClient.get(item.id);
          const bySignIn = item.configuredWithoutToken && (signedIn.has(item.id) || signedIn.has(item.name.toLowerCase()));
          return {
            ...item,
            ...(bySignIn ? { connected: true, configuredWithoutToken: false } : {}),
            ...(bound ? { agentId: bound.id, agentName: bound.name, profile: bound.profile || 'all' } : {}),
          };
        });
        return sendJson(res, 200, { endpoint, agents, paired: Boolean(paired), ...(paired ? { cloudUrl: paired.cloudUrl } : {}) });
      }

      if (pathname === '/api/agents/install' && method === 'POST') {
        if (personal || sharedSearch?.hosted) {
          return sendJson(res, 403, { error: 'Direct agent install is only available on a local Mac workspace.' });
        }
        const body = await readJsonBody(req);
        const rawTargets = Array.isArray(body?.targets) ? body.targets : [];
        const allowedSet = new Set(INSTALLABLE_HARNESSES);
        const targetIds = [];
        const seenTargets = new Set();
        for (const raw of rawTargets) {
          const clean = String(raw || '').trim().toLowerCase();
          if (!allowedSet.has(clean)) {
            return sendJson(res, 400, { error: `Unsupported agent target "${clean}".` });
          }
          if (!seenTargets.has(clean)) {
            seenTargets.add(clean);
            targetIds.push(clean);
          }
        }
        if (targetIds.length === 0) {
          return sendJson(res, 400, { error: 'Choose at least one agent to connect.' });
        }

        let requestedProfile = 'all';
        if (body?.profile !== undefined && body.profile !== null && body.profile !== '') {
          if (typeof body.profile !== 'string' || PROFILE_CONTROL_RE.test(body.profile)) {
            return sendJson(res, 400, { error: 'Profile must be a valid string without control characters.' });
          }
          requestedProfile = normalizeProfileTag(body.profile) || 'all';
        }
        const serverName = typeof body?.serverName === 'string' && body.serverName.trim()
          ? body.serverName.trim()
          : 'loop';
        let requestedAccess = null;
        if (body?.memoryAccess === 'none' || body?.memoryAccess === 'read' || body?.memoryAccess === 'read_write') {
          requestedAccess = { memoryAccess: body.memoryAccess };
        }
        if (body?.access && typeof body.access === 'object' && !Array.isArray(body.access)) {
          requestedAccess = { ...(requestedAccess || {}), ...body.access };
        }

        const installEnvOpts = {
          ...(opts.installerHome ? { home: opts.installerHome } : {}),
          ...(opts.installerPlatform ? { platform: opts.installerPlatform } : {}),
          ...(opts.installerEnv ? { env: opts.installerEnv } : {}),
        };
        const targetDefs = new Map(agentInstallTargets(installEnvOpts).map((t) => [t.id, t]));
        // Add agent: the owner made this agent already, so it gets the key and keeps its own access.
        let named = null;
        if (body?.agentId !== undefined) {
          named = typeof body.agentId === 'string' && !paired ? await store.getAgent(body.agentId) : null;
          if (!named) return sendJson(res, 404, { error: 'Agent not found.' });
          if (targetIds.length !== 1) return sendJson(res, 400, { error: 'Install one agent into one app.' });
          requestedProfile = normalizeProfileTag(named.profile) || 'all';
        }
        const targetUrl = requestedProfile !== 'all'
          ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}project=${encodeURIComponent(requestedProfile)}`
          : endpoint;

        if (paired) {
          const handoff = await localConnect.beginAgents(targetIds.map((id) => ({ id, name: targetDefs.get(id).name })), requestedProfile, serverName);
          return sendJson(res, 202, handoff);
        }
        const results = [];
        for (const targetId of targetIds) {
          const def = targetDefs.get(targetId);
          try {
            const { agent, token } = named ? await issueAgentToken(store, vault, named.id) : await issueOAuthAgentToken(def.name, `direct:${targetId}`, {
              byOwner: true,
              profile: requestedProfile,
              ...(requestedAccess ? { access: requestedAccess } : {}),
            });
            const written = await installLoopIntoAgent(targetId, {
              url: targetUrl,
              token,
              serverName,
              ...installEnvOpts,
            });
            if (named) {
              // An app holds one Loop key: the agent that had this app before is not in it any more.
              for (const other of await store.listAgents()) {
                if (other.id !== agent.id && other.oauthClientId === `direct:${targetId}`) await store.updateAgent(other.id, { oauthClientId: null });
              }
              await store.updateAgent(agent.id, { oauthClientId: `direct:${targetId}`, kind: def.kind });
              sharedSearch?.agentHandoffs?.revokeLink(id || null, agent.id);
            }
            activity.record({
              agentId: null, // the owner did this: the agent itself has not called Loop
              agentName: agent.name,
              method: 'agent/install',
              target: def.name,
              ok: true,
            });
            results.push({
              ok: true,
              id: targetId,
              name: def.name,
              kind: def.kind,
              agentId: agent.id,
              configPath: written.configPath,
              ...(written.backupPath ? { backupPath: written.backupPath } : {}),
            });
          } catch (err) {
            results.push({
              ok: false,
              id: targetId,
              name: def?.name || targetId,
              error: err?.message || 'Could not update agent config.',
            });
          }
        }
        broadcastSse('agents', { at: Date.now() });
        const anyOk = results.some((r) => r.ok);
        return sendJson(res, anyOk ? 200 : 400, { endpoint: targetUrl, results });
      }

      if (pathname === '/api/agents/handoff' && method === 'POST') {
        if (!sharedSearch?.agentHandoffs) return sendJson(res, 503, { error: 'Agent handoffs are unavailable.' });
        const body = await readJsonBody(req);
        try {
          const handoff = sharedSearch.agentHandoffs.create({
            workspaceId: id || null,
            name: body?.name || body?.kind || 'Agent',
            agentKind: body?.kind || '',
            profile: body?.profile || 'all',
            canManage: body?.canManage === true,
            memoryAccess: body?.memoryAccess || 'read_write',
            createdBy: 'Owner',
            origin,
          });
          activity.record({
            agentId: null,
            agentName: 'Owner',
            method: 'agent/invite',
            target: `${handoff.name} (${handoff.profile})`,
            ok: true,
          });
          return sendJson(res, 201, { ok: true, handoff });
        } catch (err) {
          return sendJson(res, err?.status || 400, { error: err?.publicMessage || err?.message || 'Could not create agent connect link.' });
        }
      }

      if (pathname === '/api/agents' && method === 'POST') {
        const body = await readJsonBody(req);
        const created = await store.addAgent(pickAgentFields(body));
        try {
          let made = created;
          if (body?.picture !== undefined) {
            made = await store.updateAgent(created.id, { picture: await agentPictures.save(created.id, body.picture) });
          }
          if (body?.key === false) {
            // Add agent: it gets its key when the owner installs it or somebody opens its link.
            broadcastSse('agents', { at: Date.now() });
            return sendJson(res, 201, { agent: publicAgent(made, { pictureUrl: await agentPictures.url(made) }) });
          }
          const { agent, token } = await issueAgentToken(store, vault, created.id);
          if (id) sharedSearch.tokenRouter?.remember(token, id);
          return sendJson(res, 201, { agent: publicAgent(agent), token });
        } catch (err) {
          await store.removeAgent(created.id).catch(() => {});
          await agentPictures.remove(created.id);
          await vault.delete(agentTokenVaultKey(created.id)).catch(() => {});
          throw err;
        }
      }

      const agentLinkMatch = pathname.match(/^\/api\/agents\/([a-z0-9_]+)\/link$/);
      if (agentLinkMatch && method === 'POST') {
        if (!sharedSearch?.agentHandoffs) return sendJson(res, 503, { error: 'Agent links are unavailable.' });
        const agent = await store.getAgent(agentLinkMatch[1]);
        if (!agent) return sendJson(res, 404, { error: 'Agent not found.' });
        if (agent.enabled === false) return sendJson(res, 409, { error: 'Turn this agent on first.' });
        const body = await readJsonBody(req);
        const link = sharedSearch.agentHandoffs.create({
          workspaceId: id || null,
          agentId: agent.id,
          name: agent.name,
          agentKind: agent.kind,
          profile: agent.profile || 'all',
          canManage: agent.canManage === true,
          memoryAccess: agent.memoryAccess,
          from: typeof body?.from === 'string' ? body.from : '',
          origin,
        });
        activity.record({ agentId: null, agentName: 'Owner', method: 'agent/invite', target: agent.name, ok: true });
        return sendJson(res, 201, {
          url: `${link.setupUrl}#${link.claimCode}`,
          command: link.cliCommand,
          expiresAt: link.expiresAt,
          // Another computer cannot open an address on this one.
          thisComputerOnly: !personal && !sharedSearch?.hosted,
        });
      }
      if (agentLinkMatch && method === 'DELETE') {
        return sendJson(res, 200, { ended: Boolean(sharedSearch?.agentHandoffs?.revokeLink(id || null, agentLinkMatch[1])) });
      }

      const agentTokenMatch = pathname.match(/^\/api\/agents\/([a-z0-9_]+)\/token$/);
      if (agentTokenMatch && method === 'GET') {
        const agent = await store.getAgent(agentTokenMatch[1]);
        if (!agent) return sendJson(res, 404, { error: 'Agent not found.' });
        const token = await readAgentToken(vault, agent.id);
        if (!token || hashAgentToken(token) !== agent.tokenHash) return sendJson(res, 404, { error: 'No token stored. Rotate to create one.' });
        return sendJson(res, 200, { token });
      }

      const agentRotateMatch = pathname.match(/^\/api\/agents\/([a-z0-9_]+)\/rotate$/);
      if (agentRotateMatch && method === 'POST') {
        const existing = await store.getAgent(agentRotateMatch[1]);
        if (!existing) return sendJson(res, 404, { error: 'Agent not found.' });
        const { agent, token } = await issueAgentToken(store, vault, existing.id);
        mcpOAuth?.revokeRefreshTokens({ agentId: existing.id, workspaceId: id || null });
        if (id) sharedSearch.tokenRouter?.remember(token, id);
        return sendJson(res, 200, { agent: publicAgent(agent), token });
      }

      const agentTurnRecallMatch = pathname.match(/^\/api\/agents\/([a-z0-9_]+)\/turn-recall$/);
      if (agentTurnRecallMatch && method === 'POST') {
        const body = await readJsonBody(req);
        if (typeof body?.enabled !== 'boolean') {
          return sendJson(res, 400, { error: 'enabled must be a boolean.' });
        }
        const existing = await store.getAgent(agentTurnRecallMatch[1]);
        if (!existing) return sendJson(res, 404, { error: 'Agent not found.' });
        const enabled = body.enabled;
        const cap = turnRecallCapability(existing.kind);
        let updated = await store.updateAgent(existing.id, { turnRecall: enabled });
        let hookResult = null;
        if (!personal && cap.supported) {
          const hookEnvOpts = {
            agents: [existing.kind],
            turnRecall: enabled,
            skill: 'repair',
            recallDataDir: dataDir,
            ...(opts.installerHome ? { home: opts.installerHome } : {}),
            ...(opts.installerEnv ? { env: opts.installerEnv } : {}),
          };
          if (enabled && cap.mode === 'command') {
            const issued = await issueRecallToken(store, existing.id);
            updated = issued.agent;
            if (id) sharedSearch.tokenRouter?.remember(issued.token, id);
            const recallUrl = paired
              ? `${paired.cloudUrl}/api/turn-recall`
              : `${origin}${id ? `/w/${id}` : ''}/api/turn-recall`;
            await writeRecallConfig(
              existing.kind,
              { url: recallUrl, token: issued.token, agentId: existing.id, eventName: cap.event },
              { dataDir },
            );
          } else if (!enabled && cap.mode === 'command') {
            updated = await revokeRecallToken(store, existing.id);
            const curCfg = await readRecallConfig(existing.kind, { dataDir }).catch(() => null);
            if (!curCfg || !curCfg.agentId || curCfg.agentId === existing.id) {
              await removeRecallConfig(existing.kind, { dataDir }).catch(() => {});
            }
          }
          const installed = await installAgentHooks(hookEnvOpts);
          hookResult = installed[0] || null;
        } else if (!enabled && existing.recallTokenHash) {
          updated = await revokeRecallToken(store, existing.id);
        }
        broadcastMcpNotification('notifications/tools/list_changed');
        broadcastSse('agents', { at: Date.now() });
        const settings = await store.getSettings();
        return sendJson(res, 200, {
          agent: publicAgent(updated, {
            turnRecallEffective: isTurnRecallEnabled(updated, settings),
            turnRecallCapability: cap,
          }),
          capability: cap,
          hookResult,
        });
      }

      const agentItemMatch = pathname.match(/^\/api\/agents\/([a-z0-9_]+)$/);
      if (agentItemMatch && method === 'PATCH') {
        const existing = await store.getAgent(agentItemMatch[1]);
        if (!existing) return sendJson(res, 404, { error: 'Agent not found.' });
        const body = await readJsonBody(req);
        const patch = pickAgentFields(body);
        if (body?.picture !== undefined) {
          patch.picture = await agentPictures.save(agentItemMatch[1], body.picture);
        }
        const updated = await store.updateAgent(agentItemMatch[1], patch);
        if (!updated) return sendJson(res, 404, { error: 'Agent not found.' });
        if (updated.enabled === false || agentRightsDigest(existing) !== agentRightsDigest(updated)) {
          mcpOAuth?.revokeRefreshTokens({ agentId: updated.id, workspaceId: id || null });
        }
        if (body.turnRecall !== undefined || body.enabled === false || body.memoryAccess !== undefined) {
          broadcastMcpNotification('notifications/tools/list_changed');
        }
        return sendJson(res, 200, { agent: publicAgent(updated, { pictureUrl: await agentPictures.url(updated) }) });
      }

      if (agentItemMatch && method === 'DELETE') {
        const existing = await store.getAgent(agentItemMatch[1]);
        const removed = await store.removeAgent(agentItemMatch[1]);
        if (!removed) return sendJson(res, 404, { error: 'Agent not found.' });
        mcpOAuth?.revokeRefreshTokens({ agentId: agentItemMatch[1], workspaceId: id || null });
        await vault.delete(agentTokenVaultKey(agentItemMatch[1])).catch(() => {});
        // Its sessions belong to the key that just ended: without this the row stayed on Home as "N sessions now".
        await clients.forget(`agent:${agentItemMatch[1]}`).catch(() => {});
        await agentPictures.remove(agentItemMatch[1]);
        sharedSearch?.agentHandoffs?.revokeLink(id || null, agentItemMatch[1]);
        if (!personal && existing && turnRecallCapability(existing.kind).mode === 'command') {
          const curCfg = await readRecallConfig(existing.kind, { dataDir }).catch(() => null);
          if (curCfg && curCfg.agentId === existing.id) {
            await removeRecallConfig(existing.kind, { dataDir }).catch(() => {});
          }
        }
        return sendJson(res, 200, { removed: true });
      }

      const agentAppMatch = pathname.match(/^\/api\/clients\/(.+)$/);
      if (agentAppMatch && method === 'DELETE') {
        let key;
        try {
          key = decodeURIComponent(agentAppMatch[1]);
        } catch {
          return sendJson(res, 400, { error: 'Invalid app id.' });
        }
        // A "sign-in not finished" row is not a seen app: forgetting it drops that app's
        // unfinished registrations.
        if (key.startsWith(SIGN_IN_ROW_PREFIX)) {
          const name = key.slice(SIGN_IN_ROW_PREFIX.length);
          const known = unfinishedSignIns().some((attempt) => attempt.name.toLowerCase() === name.toLowerCase());
          if (!known || !mcpOAuth.forgetUnfinishedSignIns(name)) {
            return sendJson(res, 404, { error: 'That sign-in is in progress or already gone.' });
          }
          return sendJson(res, 200, { removed: true });
        }
        if (!(await clients.forget(key))) return sendJson(res, 404, { error: 'App not found.' });
        return sendJson(res, 200, { removed: true });
      }

      if (pathname === '/api/activity' && method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || 100);
        const offset = Number(url.searchParams.get('offset') || 0);
        const agentId = url.searchParams.get('agent') || null;
        const actor = url.searchParams.get('actor') || '';
        const filter = url.searchParams.get('filter') || '';
        const before = url.searchParams.get('before') || '';
        const callId = url.searchParams.get('callId') || url.searchParams.get('ref') || '';
        return sendJson(res, 200, await activity.listPage({ agentId, actor, filter, before, callId, limit, offset }));
      }

      // Import from every agent installed on this machine
      if (pathname === '/api/import/sources' && method === 'GET') {
        const sources = await discoverSources(store, { loopPort: activePort, loopStdioPath: stdioPath, vault });
        return sendJson(res, 200, { sources: publicSources(sources) });
      }

      if (pathname === '/api/import/sources' && method === 'POST') {
        const body = await readJsonBody(req);
        const wanted = new Set(Array.isArray(body.keys) ? body.keys.map(String) : []);
        if (wanted.size === 0) return sendJson(res, 400, { error: 'Choose at least one server to import.' });
        // Re-read the files server-side; the browser only names what to import.
        const sources = await discoverSources(store, { loopPort: activePort, loopStdioPath: stdioPath, vault });
        const items = [];
        for (const source of sources) {
          for (const server of source.servers) {
            if (!wanted.has(server.key)) continue;
            if (server.status === 'self' || server.status === 'unsupported') {
              items.push({ name: server.name, label: `${source.label} ${server.name}`, skipReason: server.reason });
              continue;
            }
            items.push({
              name: server.name,
              label: `${source.label} ${server.name}`,
              candidate: server.candidate,
              enabled: server.enabled,
              warnings: server.warnings,
              ...(server.updateTargetId ? { updateTargetId: server.updateTargetId } : {}),
            });
          }
        }
        const { added, updated = [], skipped } = await importCandidates(store, vault, items, {
          profile: body.profile || 'all',
          policy: getOutboundPolicy(activePort),
          updateExisting: true,
        });
        for (const u of updated) {
          if (u.entry.enabled === false) await pool.invalidate(u.entry.id);
          else await pool.retire(u.entry.id);
        }
        const syncIds = [...added, ...updated].filter((a) => a.entry.enabled !== false).map((a) => a.entry.id);
        if (syncIds.length) track(syncInBackground(pool, syncIds));
        if (added.length > 0 || updated.length > 0) broadcastMcpNotification('notifications/tools/list_changed');
        return sendJson(res, 200, {
          added: added.map((a) => ({ ...sanitizeMcp(a.entry), secretsMoved: a.secretsMoved, warnings: a.warnings })),
          updated: updated.map((u) => ({ ...sanitizeMcp(u.entry), secretsMoved: u.secretsMoved, warnings: u.warnings })),
          skipped,
          secretsMoved: [...added, ...updated].reduce((n, a) => n + a.secretsMoved, 0),
        });
      }

      // Approvals API
      if (pathname === '/api/approvals' && method === 'GET') {
        return sendJson(res, 200, { pending: approvalQueue.listPending() });
      }

      const singleApprovalMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
      if (singleApprovalMatch && method === 'GET') {
        let id;
        try {
          id = decodeURIComponent(singleApprovalMatch[1]);
        } catch {
          return sendJson(res, 400, { error: 'Invalid approval id.' });
        }
        const approval = approvalQueue.get(id);
        if (!approval) return sendJson(res, 404, { error: 'Approval request not found.' });
        return sendJson(res, 200, { approval });
      }

      const decideApprovalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/decide$/);
      if (decideApprovalMatch && method === 'POST') {
        let id;
        try {
          id = decodeURIComponent(decideApprovalMatch[1]);
        } catch {
          return sendJson(res, 400, { error: 'Invalid approval id.' });
        }
        const body = await readJsonBody(req);
        const existing = approvalQueue.get(id);
        if (!existing) return sendJson(res, 404, { error: 'Approval request not found.' });
        const opt = existing.uiSpec
          ? resolveSpecDecisionOption(existing.uiSpec, {
              optionId: body?.optionId || '',
              decision: body?.decision || '',
              alwaysAllow: body?.alwaysAllow ?? null,
            })
          : null;
        const resolvedDecision = opt?.decision || (body?.decision === 'approve' || body?.decision === 'deny' ? body.decision : null);
        if (!resolvedDecision) return sendJson(res, 400, { error: 'Invalid approval decision.' });
        const values = existing.uiSpec ? sanitizeSpecValues(existing.uiSpec, body?.values) : {};
        const resolution = {
          ...(opt?.optionId || body?.optionId ? { optionId: opt?.optionId || String(body.optionId) } : {}),
          ...(Object.keys(values).length > 0 ? { values } : {}),
        };
        const guarded = resolvedDecision === 'approve' && existing.guard && existing.status === 'pending';
        const refusal = guarded ? await guardPasswordRefusal(body, `${existing.target} (${id})`) : null;
        if (refusal) return sendJson(res, refusal.status, refusal.body);
        const outcome = resolvedDecision === 'approve'
          ? approvalQueue.approve(id, resolution, { ownerConfirmed: guarded })
          : approvalQueue.deny(id, resolution);
        if (!outcome.ok) {
          return sendJson(res, outcome.status, {
            error: outcome.error,
            ...(outcome.approval ? { approval: outcome.approval } : {}),
          });
        }
        activity.record({
          agentId: null,
          agentName: 'Owner (dashboard)',
          method: resolvedDecision === 'approve' ? 'approval/approve' : 'approval/deny',
          target: `${outcome.approval.target} (${id})`,
          ok: true,
        });
        let alwaysAllowed = false;
        let alwaysScope = null;
        let alsoApproved = 0;
        const effectiveAlways = resolvedDecision === 'approve' && canAlwaysAllow(outcome.approval)
          ? (opt?.alwaysAllow || (body?.alwaysAllow === 'connection' ? 'connection' : body?.alwaysAllow === true || body?.alwaysAllow === 'tool' ? 'tool' : null))
          : null;
        const approvalDetail =
          outcome.approval.detail && typeof outcome.approval.detail === 'object' ? outcome.approval.detail : {};
        const approvalConnId = typeof approvalDetail.connectionId === 'string' ? approvalDetail.connectionId : '';
        if (
          effectiveAlways === 'connection' &&
          outcome.approval.kind === 'run' &&
          approvalConnId &&
          String(approvalDetail.rule || '').startsWith('toolKind:') &&
          await alwaysAllowRule({ connections: { [approvalConnId]: 'auto' } })
        ) {
          alwaysAllowed = true;
          alwaysScope = 'connection';
          activity.record({
            agentId: null,
            agentName: 'Owner (dashboard)',
            method: 'approval/always-allow',
            target: `${approvalConnId}__* (${id})`,
            ok: true,
          });
          for (const other of approvalQueue.listPending()) {
            const detail = other.detail && typeof other.detail === 'object' ? other.detail : {};
            if (other.kind !== 'run' || detail.connectionId !== approvalConnId) continue;
            if (!String(detail.rule || '').startsWith('toolKind:')) continue;
            if (!approvalQueue.approve(other.id).ok) continue;
            alsoApproved += 1;
            activity.record({
              agentId: null,
              agentName: 'Owner (dashboard)',
              method: 'approval/approve',
              target: `${other.target} (${other.id})`,
              ok: true,
            });
          }
          broadcastSse('policies', { target: approvalConnId, at: Date.now() });
        } else if (
          effectiveAlways === 'tool' &&
          outcome.approval.kind === 'run' &&
          typeof outcome.approval.target === 'string' &&
          outcome.approval.target.includes('__') &&
          await alwaysAllowRule({ tools: { [outcome.approval.target]: 'auto' } })
        ) {
          alwaysAllowed = true;
          alwaysScope = 'tool';
          activity.record({
            agentId: null,
            agentName: 'Owner (dashboard)',
            method: 'approval/always-allow',
            target: `${outcome.approval.target} (${id})`,
            ok: true,
          });
          broadcastSse('policies', { target: outcome.approval.target, at: Date.now() });
        }
        return sendJson(
          res,
          200,
          alwaysAllowed
            ? {
                approval: outcome.approval,
                alwaysAllowed: true,
                scope: alwaysScope,
                ...(alwaysScope === 'connection' ? { alsoApproved } : {}),
              }
            : { approval: outcome.approval },
        );
      }

      const approveMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
      if (approveMatch && method === 'POST') {
        let id;
        try {
          id = decodeURIComponent(approveMatch[1]);
        } catch {
          return sendJson(res, 400, { error: 'Invalid approval id.' });
        }
        const body = await readJsonBody(req);
        const existing = approvalQueue.get(id);
        const guarded = existing?.guard === true && existing.status === 'pending';
        const refusal = guarded ? await guardPasswordRefusal(body, `${existing.target} (${id})`) : null;
        if (refusal) return sendJson(res, refusal.status, refusal.body);
        const outcome = approvalQueue.approve(id, null, { ownerConfirmed: guarded });
        if (!outcome.ok) {
          return sendJson(res, outcome.status, {
            error: outcome.error,
            ...(outcome.approval ? { approval: outcome.approval } : {}),
          });
        }
        activity.record({
          agentId: null,
          agentName: 'Owner (dashboard)',
          method: 'approval/approve',
          target: `${outcome.approval.target} (${id})`,
          ok: true,
        });
        let alwaysAllowed = false;
        let alwaysScope = null;
        let alsoApproved = 0;
        const approvalDetail =
          outcome.approval.detail && typeof outcome.approval.detail === 'object' ? outcome.approval.detail : {};
        const approvalConnId = typeof approvalDetail.connectionId === 'string' ? approvalDetail.connectionId : '';
        if (
          body?.alwaysAllow === 'connection' &&
          canAlwaysAllow(outcome.approval) &&
          approvalConnId &&
          String(approvalDetail.rule || '').startsWith('toolKind:') &&
          // Loop asked because of what this tool says about itself. The owner trusts the whole
          // connection: its tools stop asking (Vault rules and per-tool "always ask" still apply).
          await alwaysAllowRule({ connections: { [approvalConnId]: 'auto' } })
        ) {
          alwaysAllowed = true;
          alwaysScope = 'connection';
          activity.record({
            agentId: null,
            agentName: 'Owner (dashboard)',
            method: 'approval/always-allow', // an owner action: kept out of Home's agent feed
            target: `${approvalConnId}__* (${id})`,
            ok: true,
          });
          // The same decision covers this connection's other requests that asked for the same
          // reason, so an agent waiting on one of them is not left waiting. Requests that
          // asked because of a Vault secret or one of the owner's own rules stay as they are.
          for (const other of approvalQueue.listPending()) {
            const detail = other.detail && typeof other.detail === 'object' ? other.detail : {};
            if (other.kind !== 'run' || detail.connectionId !== approvalConnId) continue;
            if (!String(detail.rule || '').startsWith('toolKind:')) continue;
            if (!approvalQueue.approve(other.id).ok) continue;
            alsoApproved += 1;
            activity.record({
              agentId: null,
              agentName: 'Owner (dashboard)',
              method: 'approval/approve',
              target: `${other.target} (${other.id})`,
              ok: true,
            });
          }
          broadcastSse('policies', { target: approvalConnId, at: Date.now() });
        } else if (
          body?.alwaysAllow === true &&
          canAlwaysAllow(outcome.approval) &&
          typeof outcome.approval.target === 'string' &&
          outcome.approval.target.includes('__') &&
          await alwaysAllowRule({ tools: { [outcome.approval.target]: 'auto' } })
        ) {
          alwaysAllowed = true;
          alwaysScope = 'tool';
          activity.record({
            agentId: null,
            agentName: 'Owner (dashboard)',
            method: 'approval/always-allow',
            target: `${outcome.approval.target} (${id})`,
            ok: true,
          });
          broadcastSse('policies', { target: outcome.approval.target, at: Date.now() });
        }
        return sendJson(
          res,
          200,
          alwaysAllowed
            ? {
                approval: outcome.approval,
                alwaysAllowed: true,
                scope: alwaysScope,
                ...(alwaysScope === 'connection' ? { alsoApproved } : {}),
              }
            : { approval: outcome.approval },
        );
      }

      const denyMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/deny$/);
      if (denyMatch && method === 'POST') {
        let id;
        try {
          id = decodeURIComponent(denyMatch[1]);
        } catch {
          return sendJson(res, 400, { error: 'Invalid approval id.' });
        }
        const outcome = approvalQueue.deny(id);
        if (!outcome.ok) {
          return sendJson(res, outcome.status, {
            error: outcome.error,
            ...(outcome.approval ? { approval: outcome.approval } : {}),
          });
        }
        activity.record({
          agentId: null,
          agentName: 'Owner (dashboard)',
          method: 'approval/deny',
          target: `${outcome.approval.target} (${id})`,
          ok: true,
        });
        return sendJson(res, 200, { approval: outcome.approval });
      }

      // Policies API
      if (pathname === '/api/policies' && method === 'GET') {
        const [policies, mcps, skills, catState] = await Promise.all([
          policyStore.get(),
          store.list(),
          skillStore.list(),
          catStore.load(),
        ]);
        return sendJson(res, 200, {
          policies,
          defaults: DEFAULT_POLICIES,
          categories: publicCategoryGroups(mcps, skills, catState),
        });
      }

      if (pathname === '/api/policies' && method === 'PATCH') {
        const { password, ...patch } = await readJsonBody(req);
        if (patchSetsGuard(patch)) {
          const refusal = await guardSetupRefusal();
          if (refusal) return sendJson(res, refusal.status, refusal.body);
        }
        let policies;
        try {
          policies = await policyStore.update(patch);
        } catch (err) {
          if (err?.code !== 'guard_password') throw err;
          const refusal = await guardPasswordRefusal({ password }, 'policies');
          if (refusal) return sendJson(res, refusal.status, refusal.body);
          policies = await policyStore.update(patch, { ownerConfirmed: true });
        }
        return sendJson(res, 200, { policies });
      }

      // Categories API
      if (pathname === '/api/categories' && method === 'POST') {
        const body = await readJsonBody(req);
        const label = String(body?.label || body?.name || '').trim().slice(0, 60);
        const id = slugifyCategory(body?.id || label);
        if (!label || !id) {
          return sendJson(res, 400, { error: 'Category name is required.' });
        }
        const description = String(body?.description || '').trim().slice(0, 240);
        const assignConnections = {};
        if (Array.isArray(body?.connections)) {
          for (const connId of body.connections) {
            const clean = String(connId || '').trim();
            if (clean) assignConnections[clean] = id;
          }
        }
        const assignSkills = {};
        if (Array.isArray(body?.skills)) {
          for (const skillId of body.skills) {
            const clean = String(skillId || '').trim();
            if (clean) assignSkills[clean] = id;
          }
        }
        const nextState = await catStore.organize({
          createCategories: [{ id, label, description }],
          assignConnections,
          assignSkills,
          dryRun: false,
        });
        scheduleSearchReindex();
        const [mcps, skills] = await Promise.all([store.list(), skillStore.list()]);
        const categories = publicCategoryGroups(mcps, skills, nextState);
        const category = categories.find((c) => c.id === id) || { id, label, description, custom: true, connections: [], skills: [] };
        return sendJson(res, 201, { category, categories });
      }

      if (pathname === '/api/categories/suggestions/dismiss' && method === 'POST') {
        const body = await readJsonBody(req);
        if (!Array.isArray(body?.keys) || body.keys.length === 0 || body.keys.length > 500) {
          return sendJson(res, 400, { error: 'keys must be a non-empty list.' });
        }
        const nextState = await catStore.dismissSuggestions(body.keys);
        return sendJson(res, 200, { dismissed: true, categorySuggestions: await currentCategorySuggestions(nextState) });
      }

      // A category an agent asked for: the owner's yes or no.
      const categoryRequestMatch = pathname.match(/^\/api\/categories\/requests\/(crq_[0-9a-f]{12})\/(approve|deny)$/);
      if (categoryRequestMatch && method === 'POST') {
        const approved = categoryRequestMatch[2] === 'approve';
        const [reqMcps, reqSkills] = await Promise.all([store.list(), skillStore.list()]);
        const outcome = await categoryRequests.decide(categoryRequestMatch[1], approved, { connections: reqMcps, skills: reqSkills });
        if (!outcome.ok) return sendJson(res, 404, { error: 'This request is no longer open.' });
        activity.record({
          agentId: null,
          agentName: 'Owner (dashboard)',
          method: approved ? 'approval/approve' : 'approval/deny',
          target: `category:${outcome.request.target.id} (${outcome.request.id})`,
          ok: true,
        });
        if (outcome.moved) scheduleSearchReindex();
        return sendJson(res, 200, { ok: true, label: outcome.request.target.label, isNew: outcome.request.target.isNew, moved: outcome.moved });
      }

      const categoryItemMatch = pathname.match(/^\/api\/categories\/([^/]+)$/);
      if (categoryItemMatch && method === 'DELETE') {
        let id;
        try {
          id = decodeURIComponent(categoryItemMatch[1]);
        } catch {
          return sendJson(res, 400, { error: 'Invalid category id.' });
        }
        const nextState = await catStore.organize({
          deleteCategories: [id],
          dryRun: false,
        });
        scheduleSearchReindex();
        const [mcps, skills] = await Promise.all([store.list(), skillStore.list()]);
        return sendJson(res, 200, {
          removed: true,
          categories: publicCategoryGroups(mcps, skills, nextState),
        });
      }

      // Profiles API (first-class strict profile scoping)
      if (pathname === '/api/profiles' && method === 'GET') {
        const [settings, profileData] = await Promise.all([
          store.getSettings(),
          buildProfileRecords({ store, skillStore, memoryStore, vault }),
        ]);
        return sendJson(res, 200, {
          localFolderManagement: !!deviceFolders,
          profiles: profileData.profileRecords,
          defaultProfile: settings.defaultProfile,
          totals: profileData.totals,
        });
      }

      if (pathname === '/api/profiles' && method === 'POST') {
        const body = await readJsonBody(req);
        const created = await store.createProfile({
          icon: body.icon, color: body.color,
          name: body.name,
          ...(body.id !== undefined ? { id: body.id } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.repositoryUrl !== undefined ? { repositoryUrl: body.repositoryUrl } : {}),
        });
        broadcastSse('reload', { at: Date.now() });
        const { profileRecords } = await buildProfileRecords({ store, skillStore, memoryStore, vault });
        const profile = profileRecords.find((p) => p.id === created.id) || {
          ...created,
          persisted: true,
          counts: { connections: 0, skills: 0, memories: 0, secrets: 0, agents: 0 },
        };
        return sendJson(res, 201, { profile });
      }

      const folderRoute = pathname.match(/^\/api\/profiles\/([^/]+)\/folder$/);
      if (folderRoute) {
        if (!deviceFolders) return sendJson(res, 403, { error: 'Working folders are available only on this device.' });
        const projectId = folderRoute[1];
        if (projectId !== normalizeProfileTag(projectId) || projectId === 'all') return sendJson(res, 400, { error: 'Choose a named project.' });
        if (!(await store.getProfile(projectId))) return sendJson(res, 404, { error: 'Save the project before attaching a folder.' });
        if (method === 'GET') return sendJson(res, 200, await deviceFolders.inspect(projectId));
        if (method === 'PUT') return sendJson(res, 200, await deviceFolders.attach(projectId, (await readJsonBody(req)).path));
        if (method === 'DELETE') return sendJson(res, 200, await deviceFolders.detach(projectId));
        return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, PUT, DELETE' });
      }

      const profileInviteMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/invite$/);
      if (profileInviteMatch && method === 'GET') {
        let rawId;
        try {
          rawId = decodeURIComponent(profileInviteMatch[1]);
        } catch {
          return sendJson(res, 400, { error: 'Invalid profile id.' });
        }
        const cleanId = normalizeProfileTag(rawId);
        if (!cleanId || cleanId === 'all') {
          return sendJson(res, 400, { error: 'A named profile is required. Default cannot be shared.' });
        }
        let profileRec = await store.getProfile(cleanId);
        if (!profileRec) {
          const { profileRecords } = await buildProfileRecords({ store, skillStore, memoryStore, vault });
          profileRec = profileRecords.find((p) => p.id === cleanId) || null;
        }
        if (!profileRec) return sendJson(res, 404, { error: 'Profile not found.' });
        const mcpUrl = `${origin}/mcp?project=${encodeURIComponent(profileRec.id)}`;
        const dashboardUrl = `${origin}/?project=${encodeURIComponent(profileRec.id)}`;
        let inviteUrl = mcpUrl;
        let mode = 'local-connect';
        let shareCode = null;
        if (sharedSearch?.shares && id) {
          const kind = url.searchParams.get('kind') === 'me' ? 'me' : 'other';
          try {
            const link = await sharedSearch.shares.linkFor({ workspaceId: id, profile: profileRec.id, kind, ownerName: '' });
            inviteUrl = `${origin}/j/${link.code}`;
            shareCode = link.code;
            mode = 'cloud-share';
          } catch {
            // Local workspace fallback
          }
        }
        return sendJson(res, 200, {
          profile: profileRec,
          mode,
          inviteUrl,
          ...(shareCode ? { shareCode } : {}),
          mcpUrl,
          dashboardUrl,
        });
      }

      const profileItemMatch = pathname.match(/^\/api\/profiles\/([^/]+)$/);
      if (profileItemMatch && method === 'PATCH') {
        let rawId;
        try {
          rawId = decodeURIComponent(profileItemMatch[1]);
        } catch {
          return sendJson(res, 400, { error: 'Invalid profile id.' });
        }
        const body = await readJsonBody(req);
        const patch = {};
        if (body.name !== undefined) patch.name = body.name;
        if (body.description !== undefined) patch.description = body.description;
        if (body.repositoryUrl !== undefined) patch.repositoryUrl = body.repositoryUrl;
        if (body.icon !== undefined) patch.icon = body.icon;
        if (body.color !== undefined) patch.color = body.color;
        let updated = await store.updateProfile(rawId, patch);
        if (!updated) {
          const cleanId = normalizeProfileTag(rawId);
          const { profileRecords } = await buildProfileRecords({ store, skillStore, memoryStore, vault });
          if (cleanId && profileRecords.some((p) => p.id === cleanId)) {
            updated = await store.createProfile({
              icon: patch.icon, color: patch.color,
              id: cleanId,
              name: patch.name !== undefined ? patch.name : cleanId,
              ...(patch.description !== undefined ? { description: patch.description } : {}),
              ...(patch.repositoryUrl !== undefined ? { repositoryUrl: patch.repositoryUrl } : {}),
            });
          }
        }
        if (!updated) return sendJson(res, 404, { error: 'Profile not found.' });
        broadcastSse('reload', { at: Date.now() });
        const { profileRecords } = await buildProfileRecords({ store, skillStore, memoryStore, vault });
        const profile = profileRecords.find((p) => p.id === updated.id) || {
          ...updated,
          persisted: true,
          counts: { connections: 0, skills: 0, memories: 0, secrets: 0, agents: 0 },
        };
        return sendJson(res, 200, { profile });
      }

      if (profileItemMatch && method === 'DELETE') {
        let rawId;
        try {
          rawId = decodeURIComponent(profileItemMatch[1]);
        } catch {
          return sendJson(res, 400, { error: 'Invalid profile id.' });
        }
        const storeRes = await store.deleteProfile(rawId);
        const cleanId = storeRes?.id || normalizeProfileTag(rawId);
        await projectGone(cleanId);
        const [vaultRes, memRes, skillRes] = await Promise.all([
          vault.stripProfile(cleanId),
          memoryStore.stripProfile(cleanId),
          skillStore.stripProfile(cleanId),
        ]);
        const updatedSecrets = vaultRes?.updated || 0;
        const updatedMemories = memRes?.updated || 0;
        const updatedSkills = skillRes?.updated || 0;
        const updatedConnections = storeRes?.updatedConnections || 0;
        const disabledAgents = Array.isArray(storeRes?.disabledAgents) ? storeRes.disabledAgents : [];
        if (!storeRes && updatedSecrets === 0 && updatedMemories === 0 && updatedSkills === 0) {
          return sendJson(res, 404, { error: 'Profile not found.' });
        }
        broadcastSse('reload', { at: Date.now() });
        broadcastMcpNotification('notifications/tools/list_changed');
        broadcastMcpNotification('notifications/resources/list_changed');
        broadcastMcpNotification('notifications/prompts/list_changed');
        return sendJson(res, 200, {
          deleted: true,
          id: cleanId,
          disabledAgents,
          updatedConnections,
          updatedSkills,
          updatedMemories,
          updatedSecrets,
        });
      }

      // Memory API (portable cross-agent semantic memory)
      if (pathname === '/api/memory' && method === 'GET') {
        const query = url.searchParams.get('query') || '';
        const scope = url.searchParams.get('scope') || '';
        const pinnedOnly = url.searchParams.get('pinned') === 'true';
        const profileFilter = parseProfileQueryParam(url);
        let memSemanticScores = null;
        const memMinSemantic = searchIndex.effectiveMinSemanticScore();
        if (query && searchIndex.embedder?.isAvailable()) {
          const scopeMems = await memoryStore.list({ scope, profile: profileFilter }).catch(() => []);
          memSemanticScores = await searchIndex
            .scoreMemoriesSemantic(scopeMems, query)
            .catch(() => null);
        }
        const [memories, scopedAllMemories, workspaceMemories, config, conns] = await Promise.all([
          memoryStore.list({
            query,
            scope,
            pinnedOnly,
            profile: profileFilter,
            semanticScores: memSemanticScores,
            minSemanticScore: memMinSemantic,
          }),
          query || scope || pinnedOnly ? memoryStore.list({ profile: profileFilter }) : Promise.resolve(null),
          profileFilter !== 'all' ? memoryStore.list() : Promise.resolve(null),
          memoryStore.getConfig(),
          store.list(),
        ]);
        const fullList = scopedAllMemories || memories;
        const verdicts = await hygieneStore.activeVerdictMap(fullList).catch(() => null);
        const [graph, tidy] = await Promise.all([
          memoryStore.graph({ profile: profileFilter, verdicts }),
          memoryStore.tidy({ profile: profileFilter, verdicts }),
        ]);
        const profileData = await buildProfileRecords({
          store,
          skillStore,
          memoryStore,
          vault,
          mcps: conns,
          memories: workspaceMemories || fullList,
        });
        const externalCandidates = detectExternalMemoryConnections(conns);
        const selectableConnections = conns
          .filter((c) => c.enabled !== false)
          .map((c) => {
            const picked = pickExternalMemoryTools(c);
            return {
              id: c.id,
              name: c.name || c.id,
              description: c.description || '',
              ready: connectionReadiness(c, { tokenRejected: isTokenRejected(c) }).ready,
              detected: externalCandidates.some((m) => m.id === c.id),
              canPull: Boolean(picked.listTool?.noArgs || picked.searchTool?.simpleQuery),
              searchTool: picked.searchTool?.name || '',
              saveTool: picked.saveTool?.name || '',
            };
          });
        let externalStatus = null;
        if (config.mode === 'external' && config.externalConnectionId) {
          const rawExt = conns.find((c) => c.id === config.externalConnectionId) || null;
          if (!rawExt) {
            externalStatus = { state: 'missing', id: config.externalConnectionId, name: config.externalConnectionId };
          } else if (rawExt.enabled === false) {
            externalStatus = { state: 'disabled', id: rawExt.id, name: rawExt.name || rawExt.id };
          } else if (rawExt.authRequired) {
            externalStatus = { state: 'needs_auth', id: rawExt.id, name: rawExt.name || rawExt.id };
          } else {
            const readiness = connectionReadiness(rawExt, { tokenRejected: isTokenRejected(rawExt) });
            externalStatus = { state: readiness.state, id: rawExt.id, name: rawExt.name || rawExt.id };
          }
        }
        return sendJson(res, 200, {
          memories,
          total: fullList.length,
          pinnedCount: fullList.filter((m) => m.pinned).length,
          scopes: MEMORY_SCOPES,
          relations: MEMORY_RELATIONS,
          modes: MEMORY_MODES,
          config,
          externalStatus,
          graph,
          tidy,
          externalCandidates,
          selectableConnections,
          profiles: profileData.profiles,
          profileRecords: profileData.profileRecords,
        });
      }

      if (pathname === '/api/memory/graph' && method === 'GET') {
        const profileFilter = parseProfileQueryParam(url);
        const scoped = await memoryStore.list({ profile: profileFilter });
        const verdicts = await hygieneStore.activeVerdictMap(scoped).catch(() => null);
        const graph = await memoryStore.graph({ profile: profileFilter, verdicts });
        return sendJson(res, 200, {
          graph,
          total: graph.stats.nodeCount,
          pinnedCount: graph.stats.pinnedCount,
        });
      }

      if (pathname === '/api/memory/config' && method === 'PATCH') {
        const body = await readJsonBody(req);
        try {
          if (body?.externalConnectionId) {
            const conns = await store.list();
            const found = conns.some((c) => c.id === String(body.externalConnectionId).trim());
            if (!found) {
              return sendJson(res, 400, { error: `Connection "${body.externalConnectionId}" was not found in Loop.` });
            }
          }
          const config = await memoryStore.updateConfig(body, {
            home: opts.home,
            allowSyncFolders: !personal,
          });
          return sendJson(res, 200, { config });
        } catch (err) {
          return sendJson(res, err.status || 400, { error: err.message, code: err.code || undefined });
        }
      }

      if (pathname === '/api/memory/export' && method === 'GET') {
        const allMemories = await memoryStore.list();
        const markdown = exportMemoriesMarkdown(allMemories);
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': 'attachment; filename="MEMORY.md"',
          'Cache-Control': 'no-store',
        });
        return res.end(markdown);
      }

      if (pathname === '/api/memory/pull-external' && method === 'POST') {
        const body = await readJsonBody(req);
        const cfg = await memoryStore.getConfig();
        const connId = String(body?.connectionId || cfg.externalConnectionId || '').trim();
        if (!connId) {
          return sendJson(res, 400, { error: 'No external memory connection configured.' });
        }
        const conn = await store.get(connId);
        if (!conn || conn.enabled === false) {
          return sendJson(res, 404, { error: `Connection "${connId}" is not available.` });
        }
        if (personal) {
          try {
            assertPersonalStoredConnection(conn, { selfIdentity: getSelfIdentity(activePort) });
          } catch (err) {
            return sendJson(res, err?.status || 400, { error: err?.message || 'Unsupported personal MCP connection.' });
          }
        }
        if (conn.authRequired) {
          return sendJson(res, 400, { error: `Sign in to "${conn.name || conn.id}" in Connections first.` });
        }
        const picked = pickExternalMemoryTools(conn);
        const queryText = String(body?.query || '').trim();
        let toolName = '';
        let toolArgs = {};
        if (!queryText && picked.listTool?.noArgs) {
          toolName = picked.listTool.name;
          toolArgs = {};
        } else if (picked.searchTool?.simpleQuery) {
          toolName = picked.searchTool.name;
          toolArgs = { [picked.searchTool.queryParam]: queryText || 'user preferences projects facts' };
        } else if (picked.listTool) {
          toolName = picked.listTool.name;
          toolArgs = {};
        } else {
          return sendJson(res, 400, {
            error: `"${conn.name || conn.id}" does not expose a compatible read or search memory tool.`,
          });
        }
        try {
          const upstream = await pool.callTool(conn.id, toolName, toolArgs);
          const extracted = extractMemoriesFromExternalResult(upstream, conn.name || conn.id);
          const existing = await memoryStore.list();
          const existingFps = new Set(existing.map((m) => m.content.trim().toLowerCase()));
          const items = extracted.map((it, idx) => ({
            key: `ext:${conn.id}:${it.key || idx}`,
            memoryKey: it.key,
            content: it.content,
            scope: it.scope,
            project: it.project || '',
            tags: it.tags || [],
            source: conn.name || conn.id,
            status: existingFps.has(it.content.trim().toLowerCase()) ? 'imported' : 'new',
          }));
          return sendJson(res, 200, {
            connectionId: conn.id,
            connectionName: conn.name || conn.id,
            toolUsed: toolName,
            items,
          });
        } catch (err) {
          return sendJson(res, 502, { error: err?.message || `Could not pull memories from "${conn.name || conn.id}".` });
        }
      }

      if (pathname === '/api/memory' && method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const { memory, created, supersededId } = await memoryStore.save({
            key: body.key,
            content: body.content,
            scope: body.scope,
            project: body.project,
            tags: body.tags,
            links: body.links,
            pinned: body.pinned,
            ...(body.ephemeral !== undefined ? { ephemeral: body.ephemeral } : {}),
            ...(body.supersedes !== undefined ? { supersedes: body.supersedes } : {}),
            ...(body.profiles !== undefined ? { profiles: body.profiles } : {}),
            source: body.source || 'Manual',
            writtenBy: 'Owner',
          });
          await searchIndex.upsertMemoryImmediate(memory).catch(() => {});
          if (supersededId) await searchIndex.removeItemImmediate('memory', supersededId).catch(() => {});
          return sendJson(res, created ? 201 : 200, { memory, created, ...(supersededId ? { supersededId } : {}) });
        } catch (err) {
          return sendJson(res, err.status || 400, { error: err.message, code: err.code || undefined });
        }
      }

      if (pathname === '/api/memory/import/sources' && method === 'GET') {
        const cfg = await memoryStore.getConfig();
        const sources = await discoverMemorySources(memoryStore, {
          home: opts.home,
          syncFolders: personal ? [] : cfg.syncFolders,
          dataDir,
        });
        return sendJson(res, 200, { sources });
      }

      if (pathname === '/api/memory/import' && method === 'POST') {
        const body = await readJsonBody(req);
        const imported = [];
        const skipped = [];
        if (typeof body.text === 'string' && body.text.trim()) {
          const parsed = parsePastedMemories(body.text, String(body.source || 'Import').trim() || 'Import');
          for (const item of parsed) {
            try {
              const resSave = await memoryStore.save({ ...item, writtenBy: 'Owner (import)' });
              if (resSave.created) imported.push(resSave.memory);
              else skipped.push({ content: item.content, reason: 'Already in Loop Memory' });
            } catch (err) {
              skipped.push({ content: item.content, reason: err.message });
            }
          }
          return sendJson(res, 200, { imported, skipped });
        }
        if (personal) {
          return sendJson(res, 403, { error: 'Importing from local agent files is only available in the local Mac workspace.' });
        }
        const syncAllNew = body.syncAllNew === true;
        const wanted = new Set(Array.isArray(body.keys) ? body.keys.map(String) : []);
        if (!syncAllNew && wanted.size === 0) {
          return sendJson(res, 400, { error: 'Choose at least one memory to import, or paste text/JSON.' });
        }
        const cfg = await memoryStore.getConfig();
        const sources = await discoverMemorySources(memoryStore, {
          home: opts.home,
          syncFolders: cfg.syncFolders,
          dataDir,
        });
        for (const src of sources) {
          for (const item of src.items || []) {
            if (syncAllNew) {
              if (item.status !== 'new') continue;
            } else if (!wanted.has(item.key)) {
              continue;
            }
            try {
              const resSave = await memoryStore.save({
                key: item.memoryKey,
                content: item.content,
                scope: item.scope,
                project: item.project,
                tags: item.tags,
                source: src.label,
                writtenBy: `Owner (imported from ${src.label})`,
              });
              if (resSave.created) imported.push(resSave.memory);
              else skipped.push({ content: item.content, reason: 'Already in Loop Memory' });
            } catch (err) {
              skipped.push({ content: item.content, reason: err.message });
            }
          }
        }
        return sendJson(res, 200, { imported, skipped });
      }

      // Tidy: settle a duplicate/conflict pair, a duplicate cluster, or set aside temporary notes (restorable).
      if (pathname === '/api/memory/tidy' && method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const result = await memoryStore.resolveTidy({
            a: body?.a,
            b: body?.b,
            keep: body?.keep,
            ids: body?.ids,
            dropIds: body?.dropIds,
            keepIds: body?.keepIds,
          });
          for (const id of result?.replacedIds || []) {
            await searchIndex.removeItemImmediate('memory', id).catch(() => {});
          }
          return sendJson(res, 200, result);
        } catch (err) {
          return sendJson(res, err.status || 400, { error: err.message });
        }
      }

      if (pathname === '/api/memory/restore' && method === 'POST') {
        const body = await readJsonBody(req);
        const restored = await memoryStore.restore(body?.id);
        if (!restored) return sendJson(res, 404, { error: 'Memory not found.' });
        await searchIndex.upsertMemoryImmediate(restored).catch(() => {});
        return sendJson(res, 200, { memory: restored });
      }

      const memoryItemMatch = pathname.match(/^\/api\/memory\/([^/]+)$/);
      if (memoryItemMatch && method === 'PATCH') {
        let id;
        try { id = decodeURIComponent(memoryItemMatch[1]); }
        catch { return sendJson(res, 400, { error: 'Invalid memory id.' }); }
        const body = await readJsonBody(req);
        try {
          const updated = await memoryStore.update(id, body);
          if (!updated) return sendJson(res, 404, { error: 'Memory not found.' });
          await searchIndex.upsertMemoryImmediate(updated).catch(() => {});
          return sendJson(res, 200, { memory: updated });
        } catch (err) {
          return sendJson(res, err.status || 400, { error: err.message, code: err.code || undefined });
        }
      }

      if (memoryItemMatch && method === 'DELETE') {
        let id;
        try { id = decodeURIComponent(memoryItemMatch[1]); }
        catch { return sendJson(res, 400, { error: 'Invalid memory id.' }); }
        const removed = await memoryStore.remove(id);
        if (!removed) return sendJson(res, 404, { error: 'Memory not found.' });
        library.removed(id);
        await searchIndex.removeItemImmediate('memory', id).catch(() => {});
        return sendJson(res, 200, { removed: true });
      }

      // Cross-channel conversation history and sleep-time memory review (Loop Core)
      if (
        pathname === '/api/history' ||
        pathname === '/api/dream' ||
        pathname.startsWith('/api/dream/')
      ) {
        const handledCore = await handleCoreLoopRoute(req, res, {
          pathname,
          url,
          prefix: '/api',
          historyStore,
          dreamStore,
          searchIndex,
          scheduleSearchReindex,
          broadcast: (type) => broadcastSse(type, { at: Date.now() }),
        });
        if (handledCore) return;
      }

      if (
        pathname === '/api/catalog' ||
        pathname.startsWith('/api/catalog/') ||
        pathname === '/api/mcps/import-api' ||
        pathname === '/api/access-sets' ||
        pathname.startsWith('/api/access-sets/') ||
        pathname === '/api/services' ||
        pathname === '/api/setup/status' ||
        /^\/api\/people\/[^/]+\/items\/[^/]+\/check$/.test(pathname)
      ) {
        const handledV3 = await handleCatalogAndV3Routes({
          req,
          res,
          url,
          pathname,
          method,
          store,
          vault,
          pool,
          activity,
          personal,
          selfIdentity: getSelfIdentity(activePort),
          origin,
          startUpstreamOAuth: async (conn) =>
            startOAuthFlow(conn, `${origin}/oauth/callback`, {
              network: getOutboundPolicy(activePort).oauthNetwork(conn.url),
              selfIdentity: getSelfIdentity(activePort),
              dataDir,
              workspace: id || 'local',
              vault,
            }),
          readJsonBody,
          sendJson,
          broadcast: (type, data = {}) => broadcastSse(type, { at: Date.now(), ...data }),
          scheduleSearchReindex,
        });
        if (handledV3) return;
      }

      if (pathname === '/api/loop-agent' || pathname.startsWith('/api/loop-agent/')) {
        const directLoopback = isLocalDeviceRequest(req, activePort, { hosted: false });
        const handledSpecialist = await loopAgentHandler.handle(req, res, {
          pathname,
          url,
          requestHosted: Boolean(sharedSearch?.specialistHosted || (sharedSearch?.hosted && !directLoopback)),
          loopAgentStore,
          runTokens,
          workspaceId: id || 'local',
          store,
          vault,
          memoryStore,
          savedStore,
          fileStore,
          taskStore,
          library,
          deviceFolders,
          activePort,
          origin,
          mcpPath: id ? `/w/${id}/mcp` : '/mcp',
          buildBridgeMcpOpts,
          runBridgeRpc,
          broadcast: (type, data = {}) => { if (!closed) broadcastSse(type, { at: Date.now(), ...data }); },
        });
        if (handledSpecialist) return;
      }

      if (pathname === '/api/chat' || pathname === '/api/chat/tools') {
        const handledChat = await handleChatConsoleRoutes({
          req,
          res,
          pathname,
          method,
          store,
          vault,
          pool,
          policyStore,
          approvalQueue,
          catStore,
          memoryStore,
          skillStore,
          activity,
          searchIndex,
          personal,
          origin,
          readJsonBody,
          sendJson,
        });
        if (handledChat) return;
      }

      // Signed inbound webhooks CRUD & delivery inspection (owner-authenticated)
      if (pathname === '/api/webhooks') {
        if (method === 'GET') {
          const webhooks = await webhookStore.list();
          return sendJson(res, 200, {
            ok: true,
            webhooks: webhooks.map((w) => ({
              ...w,
              url: `${origin}${id ? `/w/${id}` : ''}/hooks/${w.id}`,
            })),
          });
        }
        if (method === 'POST') {
          const body = await readJsonBody(req);
          try {
            const { webhook, secret } = await webhookStore.create(body || {});
            activity.record({ agentId: null, agentName: 'Owner (dashboard)', method: 'webhook/create', target: `${webhook.name} (${webhook.id})`, ok: true });
            return sendJson(res, 201, {
              ok: true,
              webhook: { ...webhook, url: `${origin}${id ? `/w/${id}` : ''}/hooks/${webhook.id}` },
              secret,
            });
          } catch (err) {
            return sendJson(res, err?.status || 400, { error: err?.message || 'Could not create webhook.' });
          }
        }
        return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
      }
      if (pathname === '/api/webhooks/process-retries' && method === 'POST') {
        const results = await webhookStore.processRetries({ handler: dispatchWebhookDelivery });
        return sendJson(res, 200, { ok: true, results });
      }
      const whDelivMatch = pathname.match(/^\/api\/webhooks\/([^/]+)\/deliveries$/);
      if (whDelivMatch && method === 'GET') {
        const whId = decodeURIComponent(whDelivMatch[1]);
        const wh = await webhookStore.get(whId);
        if (!wh) return sendJson(res, 404, { error: 'Webhook not found.' });
        const deliveries = await webhookStore.listDeliveries(whId, { limit: Number(url.searchParams.get('limit')) || 50 });
        return sendJson(res, 200, { ok: true, webhookId: whId, deliveries });
      }
      const whIdMatch = pathname.match(/^\/api\/webhooks\/([^/]+)$/);
      if (whIdMatch) {
        const whId = decodeURIComponent(whIdMatch[1]);
        if (method === 'GET') {
          const wh = await webhookStore.get(whId);
          if (!wh) return sendJson(res, 404, { error: 'Webhook not found.' });
          return sendJson(res, 200, { ok: true, webhook: wh });
        }
        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          try {
            const updated = await webhookStore.update(whId, body || {});
            return sendJson(res, 200, { ok: true, webhook: updated });
          } catch (err) {
            return sendJson(res, err?.status || 400, { error: err?.message || 'Could not update webhook.' });
          }
        }
        if (method === 'DELETE') {
          try {
            const del = await webhookStore.delete(whId);
            return sendJson(res, 200, { ok: true, ...del });
          } catch (err) {
            return sendJson(res, err?.status || 404, { error: err?.message || 'Could not delete webhook.' });
          }
        }
        return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, PATCH, DELETE' });
      }

      // Signed outbound alert webhooks CRUD, retry trigger & delivery log (owner-authenticated)
      if (pathname === '/api/outbound-webhooks') {
        if (method === 'GET') {
          const webhooks = await outboundAlerts.list();
          return sendJson(res, 200, { ok: true, webhooks });
        }
        if (method === 'POST') {
          const body = await readJsonBody(req);
          try {
            const { webhook, secret } = await outboundAlerts.create(body || {});
            activity.record({ agentId: null, agentName: 'Owner (dashboard)', method: 'outbound_webhook/create', target: `${webhook.name} (${webhook.id})`, ok: true });
            return sendJson(res, 201, { ok: true, webhook, secret });
          } catch (err) {
            return sendJson(res, err?.status || 400, { error: err?.message || 'Could not create outbound webhook.', ...(err?.code ? { code: err.code } : {}) });
          }
        }
        return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
      }
      if (pathname === '/api/outbound-webhooks/process-retries' && method === 'POST') {
        const results = await outboundAlerts.processRetries();
        return sendJson(res, 200, { ok: true, results });
      }
      const owhDelivMatch = pathname.match(/^\/api\/outbound-webhooks\/([^/]+)\/deliveries$/);
      if (owhDelivMatch && method === 'GET') {
        const owhId = decodeURIComponent(owhDelivMatch[1]);
        const hook = await outboundAlerts.get(owhId);
        if (!hook) return sendJson(res, 404, { error: 'Outbound webhook not found.' });
        const deliveries = await outboundAlerts.listDeliveries(owhId, { limit: Number(url.searchParams.get('limit')) || 50 });
        return sendJson(res, 200, { ok: true, webhookId: owhId, deliveries });
      }
      const owhIdMatch = pathname.match(/^\/api\/outbound-webhooks\/([^/]+)$/);
      if (owhIdMatch) {
        const owhId = decodeURIComponent(owhIdMatch[1]);
        if (method === 'GET') {
          const hook = await outboundAlerts.get(owhId);
          if (!hook) return sendJson(res, 404, { error: 'Outbound webhook not found.' });
          return sendJson(res, 200, { ok: true, webhook: hook });
        }
        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          try {
            const updated = await outboundAlerts.update(owhId, body || {});
            return sendJson(res, 200, { ok: true, webhook: updated });
          } catch (err) {
            return sendJson(res, err?.status || 400, { error: err?.message || 'Could not update outbound webhook.' });
          }
        }
        if (method === 'DELETE') {
          try {
            const del = await outboundAlerts.delete(owhId);
            return sendJson(res, 200, { ok: true, ...del });
          } catch (err) {
            return sendJson(res, err?.status || 404, { error: err?.message || 'Could not delete outbound webhook.' });
          }
        }
        return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, PATCH, DELETE' });
      }

      if (pathname.startsWith('/api/library/')) {
        const handledLibrary = await handleLibraryRoute(req, res, {
          pathname,
          url,
          profile: parseProfileQueryParam(url),
          library,
          searchIndex,
          broadcast: (type) => broadcastSse(type, { at: Date.now() }),
          activity,
        });
        if (handledLibrary) return;
      }

      if (
        pathname === '/api/saved' ||
        pathname.startsWith('/api/saved/') ||
        pathname === '/api/schedules' ||
        pathname.startsWith('/api/schedules/') ||
        pathname === '/api/files' ||
        pathname.startsWith('/api/files/') ||
        pathname === '/api/tasks' ||
        pathname.startsWith('/api/tasks/') ||
        pathname === '/api/notifications' ||
        pathname.startsWith('/api/notifications/')
      ) {
        const handledTools = await handleSavedAndToolsRoute(req, res, {
          pathname,
          url,
          savedStore,
          scheduleStore,
          fileStore,
          taskStore,
          notificationStore,
          ownerTimezone,
          searchIndex,
          outboundPolicy: getOutboundPolicy(activePort),
          fetchImpl: opts.builtinFetch || null,
          onSavedEnrich: enqueueSavedEnrich,
          onScheduleRun: runScheduleById,
          deliverSms,
          broadcast: (type) => broadcastSse(type, { at: Date.now() }),
          activity,
        });
        if (handledTools) return;
      }

      // Overview
      if (pathname === '/api/overview' && method === 'GET') {
        const [settings, mcps, secrets, agents, skills, memories, catState, policies, apps] =
          await Promise.all([
            store.getSettings(),
            store.list(),
            vault.list(),
            store.listAgents(),
            skillStore.list(),
            memoryStore.list(),
            catStore.load(),
            policyStore.get(),
            listConnectedApps(activePort),
          ]);
        const profileData = await buildProfileRecords({
          store,
          skillStore,
          memoryStore,
          vault,
          mcps,
          skills,
          memories,
          secrets,
          agents,
        });

        let toolsTotal = 0;
        let toolsEnabled = 0;
        for (const m of mcps) {
          const tools = Array.isArray(m.tools) ? m.tools : [];
          const disabled = new Set(Array.isArray(m.disabledTools) ? m.disabledTools : []);
          toolsTotal += tools.length;
          if (m.enabled) {
            for (const t of tools) {
              if (!disabled.has(t.name)) toolsEnabled += 1;
            }
          }
        }

        const pendingApprovals = approvalQueue.listPending().length;
        const logoMap = await logos.publicMap();
        refreshLogos(mcps);
        const home = await buildHomeFeed({ memories, secrets });
        home.categoryRequests = (await categoryRequests.list({ connections: mcps, skills }).catch(() => []))
          .map(({ id, target, reason, askedBy, items, finds, looked, createdAt }) => ({ id, target, reason, askedBy, items, finds, looked, createdAt }));
        home.categorySuggestions = await currentCategorySuggestions(catState, { connections: mcps, skills }).catch(() => []);

        const cloudRoutes = !personal ? await localInstallStore.listCloudRoutes().catch(() => []) : [];
        const localStatus = localConnect ? await localConnect.getStatus().catch(() => ({ linked: false })) : null;
        const toolSetups = localConnect
          ? await localConnect.listToolSetupsForThisComputer().catch(() => [])
          : await toolSetupStore.list().catch(() => []);
        const connectDevicesInfo = sharedSearch?.hosted && sharedSearch?.loopConnectServer
          ? await sharedSearch.loopConnectServer.getDevicesInfo(dataDir).catch(() => ({ devices: [], defaultDeviceId: null }))
          : null;

        const decoratedMcps = mcps.map((m) => ({ ...decorateMcp(m, catState, policies, { personal }), ...connectionRuntimeStatus(m), logo: logoMap[m.id] || null }));
        const seenMcpIds = new Set(decoratedMcps.map((m) => m.id));
        for (const r of cloudRoutes) {
          if (!r || seenMcpIds.has(r.id)) continue;
          const virtualConn = {
            id: r.id,
            name: r.name,
            description: r.description || '',
            transport: r.transport || 'http',
            url: r.url || `https://cloud.useloop.sh/c/${r.cloudConnId || r.id}`,
            home: 'cloud',
            cloudRouted: true,
            profiles: r.profiles || ['all'],
            enabled: r.enabled !== false,
            tools: Array.isArray(r.tools) ? r.tools : [],
            lastSyncAt: r.movedAt || null,
          };
          decoratedMcps.push({ ...decorateMcp(virtualConn, catState, policies), logo: logoMap[r.id] || null });
        }

        return sendJson(res, 200, {
          endpoint,
          port: activePort,
          stdioPath,
          settings: legacy ? settings : { ...settings, requireAgentToken: true },
          profiles: profileData.profiles,
          profileRecords: profileData.profileRecords,
          pendingApprovals,
          categories: publicCategoryGroups(mcps, skills, catState),
          policies,
          toolSetups,
          localConnectLinked: Boolean(localStatus?.linked),
          ...(localStatus?.linked ? { cloudWorkspaceUrl: localStatus.cloudUrl, localDeviceId: localStatus.deviceId } : {}),
          ...(connectDevicesInfo ? { connectDevices: connectDevicesInfo.devices, defaultDeviceId: connectDevicesInfo.defaultDeviceId } : {}),
          ...(id && sharedSearch?.hosted && sharedSearch.people
            ? { from: await fromViews(sharedSearch.people, { id, peopleContext }).catch(() => []) }
            : {}),
          stats: {
            connectionsTotal: decoratedMcps.length,
            connectionsEnabled: decoratedMcps.filter((m) => m.enabled).length,
            connectionsHealthy: decoratedMcps.filter((m) => m.readiness.ready).length,
            toolsTotal,
            toolsEnabled,
            skillsTotal: skills.length,
            memoryTotal: memories.length,
            memoryPinned: memories.filter((m) => m.pinned).length,
            vaultSecrets: secrets.length,
            agentsTotal: apps.length,
            agentsActive: apps.filter((a) => a.sessionsActive > 0).length,
            agentKeysTotal: agents.length,
            agentKeysEnabled: agents.filter((a) => a.enabled).length,
            pendingApprovals,
          },
          mcps: decoratedMcps,
          agents: apps,
          agentKeys: await Promise.all(
            agents.map(async (a) => ({
              ...publicAgent(a),
              pictureUrl: await agentPictures.url(a),
              lastSeenAt: await activity.lastSeenFor(a.id),
            })),
          ),
          home,
        });
      }

      // Skills API
      if (pathname === '/api/skills' && method === 'GET') {
        const profileFilter = parseProfileQueryParam(url);
        const [skills, allSkills, mcps, catState] = await Promise.all([
          skillStore.list({ profile: profileFilter }),
          profileFilter !== 'all' ? skillStore.list() : Promise.resolve(null),
          store.list(),
          catStore.load(),
        ]);
        const profileData = await buildProfileRecords({
          store,
          skillStore,
          memoryStore,
          vault,
          mcps,
          skills: allSkills || skills,
        });
        const decorated = skills.map((s) => {
          const clean = publicSkillMeta(s, { stripPaths: personal });
          const cat = categorizeItem(clean, { kind: 'skill', state: catState });
          return { ...clean, category: cat.id, categoryLabel: cat.label };
        });
        return sendJson(res, 200, {
          skills: decorated,
          categories: publicCategoryGroups(mcps, skills, catState),
          profiles: profileData.profiles,
          profileRecords: profileData.profileRecords,
        });
      }

      const skillItemMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
      if (skillItemMatch && method === 'GET') {
        let id;
        try {
          id = decodeURIComponent(skillItemMatch[1]);
        } catch {
          return sendJson(res, 400, { error: 'Invalid skill id.' });
        }
        const [skill, catState] = await Promise.all([skillStore.get(id), catStore.load()]);
        if (!skill) return sendJson(res, 404, { error: 'Skill not found.' });
        const clean = publicSkillMeta(skill, { stripPaths: personal });
        const cat = categorizeItem(clean, { kind: 'skill', state: catState });
        return sendJson(res, 200, { skill: { ...clean, category: cat.id, categoryLabel: cat.label } });
      }

      if (skillItemMatch && method === 'PATCH') {
        let id;
        try {
          id = decodeURIComponent(skillItemMatch[1]);
        } catch {
          return sendJson(res, 400, { error: 'Invalid skill id.' });
        }
        const body = await readJsonBody(req);
        if (body.profiles === undefined) {
          return sendJson(res, 400, { error: 'profiles is required.' });
        }
        const updated = await skillStore.updateMeta(id, { profiles: body.profiles });
        if (!updated) return sendJson(res, 404, { error: 'Skill not found.' });
        await searchIndex.upsertSkillImmediate(updated).catch(() => {});
        const catState = await catStore.load();
        const clean = publicSkillMeta(updated, { stripPaths: personal });
        const cat = categorizeItem(clean, { kind: 'skill', state: catState });
        broadcastSse('reload', { at: Date.now() });
        broadcastMcpNotification('notifications/tools/list_changed');
        return sendJson(res, 200, { skill: { ...clean, category: cat.id, categoryLabel: cat.label } });
      }

      if (skillItemMatch && method === 'DELETE') {
        let id;
        try {
          id = decodeURIComponent(skillItemMatch[1]);
        } catch {
          return sendJson(res, 400, { error: 'Invalid skill id.' });
        }
        const existing = await skillStore.get(id);
        if (!existing) return sendJson(res, 404, { error: 'Skill not found.' });
        if (existing.bundled) {
          return sendJson(res, 400, { error: 'Bundled Loop skills cannot be deleted.' });
        }
        const removed = await skillStore.remove(id);
        if (!removed) return sendJson(res, 404, { error: 'Skill not found.' });
        await searchIndex.removeItemImmediate('skill', id).catch(() => {});
        scheduleSearchReindex();
        return sendJson(res, 200, { removed: true });
      }

      // REST API for managing upstream MCPs
      if (pathname === '/api/mcps' && method === 'GET') {
        const [mcps, catState, policies, cloudRoutes, localStatus] = await Promise.all([
          store.list(),
          catStore.load(),
          policyStore.get(),
          !personal ? localInstallStore.listCloudRoutes().catch(() => []) : Promise.resolve([]),
          localConnect ? localConnect.getStatus().catch(() => ({ linked: false })) : Promise.resolve(null),
        ]);
        const profileData = await buildProfileRecords({ store, skillStore, memoryStore, vault, mcps });
        const logoMap = await logos.publicMap();
        refreshLogos(mcps);
        const list = mcps.map((m) => ({ ...decorateMcp(m, catState, policies, { personal }), ...connectionRuntimeStatus(m), logo: logoMap[m.id] || null }));
        const seen = new Set(list.map((m) => m.id));
        for (const r of cloudRoutes) {
          if (!r || seen.has(r.id)) continue;
          list.push({
            ...decorateMcp({
              id: r.id,
              name: r.name,
              description: r.description || '',
              transport: r.transport || 'http',
              url: r.url || `https://cloud.useloop.sh/c/${r.cloudConnId || r.id}`,
              home: 'cloud',
              cloudRouted: true,
              profiles: r.profiles || ['all'],
              enabled: r.enabled !== false,
              tools: Array.isArray(r.tools) ? r.tools : [],
              lastSyncAt: r.movedAt || null,
            }, catState, policies),
            logo: logoMap[r.id] || null,
          });
        }
        return sendJson(res, 200, {
          endpoint,
          profiles: profileData.profiles,
          profileRecords: profileData.profileRecords,
          toolApprovals: policies.tools,
          localConnectLinked: Boolean(localStatus?.linked),
          mcps: list,
        });
      }

      if (pathname === '/api/mcps/probe' && method === 'POST') {
        const body = await readJsonBody(req);
        const transport =
          typeof body?.transport === 'string' && body.transport.trim()
            ? body.transport.trim().toLowerCase()
            : null;
        const result = await probeConnection(body?.url, {
          policy: getOutboundPolicy(activePort),
          transport,
          callbackUrl: `${origin}/oauth/callback`,
        });
        return sendJson(res, 200, result);
      }

      if (pathname === '/api/mcps' && method === 'POST') {
        const body = await readJsonBody(req);
        const isObj = body !== null && typeof body === 'object' && !Array.isArray(body);
        const skipSync = isObj && body.skipSync === true;
        let input = body;
        if (isObj && Object.hasOwn(body, 'skipSync')) {
          const { skipSync: _skipSync, ...rest } = body;
          input = rest;
        }
        const policy = getOutboundPolicy(activePort);
        const { entry: created } = await admitConnectionWrite({
          actor: { kind: 'owner' },
          policy,
          existing: null,
          input,
          allowVaultRefs: true,
          store,
          vault,
        });

        const beforeSeq = toolsBroadcastSeq;
        if (created.transport === 'stdio') {
          const portability = analyzeStdioPortability({
            name: created.name,
            command: created.command,
            args: created.args,
            env: created.env,
            cwd: created.cwd,
            installSpec: created.installSpec || null,
          });
          await toolSetupStore.upsert({
            id: slugifySetupId(created.toolSetupId || created.id),
            name: created.name,
            description: created.description || '',
            profiles: created.profiles || ['all'],
            home: 'local',
            enabled: created.enabled !== false,
            remoteAccess: defaultRemoteAccessFor(created),
            portable: portability.portable,
            nonPortableReason: portability.reason,
            installSpec: portability.installSpec,
          }).catch(() => {});
        }
        if (skipSync || created.enabled === false) {
          if (created.enabled !== false) broadcastMcpNotification('notifications/tools/list_changed');
          return sendJson(res, 201, { mcp: sanitizeMcp(created) });
        }

        const synced = (await pool.sync(created.id)) || (await store.get(created.id)) || created;
        if (toolsBroadcastSeq === beforeSeq) {
          broadcastMcpNotification('notifications/tools/list_changed');
        }
        return sendJson(res, 201, { mcp: sanitizeMcp(synced) });
      }

      if (pathname === '/api/mcps/import' && method === 'POST') {
        const body = await readJsonBody(req);
        const policy = getOutboundPolicy(activePort);
        let candidates;
        try {
          candidates = candidatesFromMcpJson(body.json, { personal, outboundPolicy: policy });
        } catch (err) {
          if (isRawInternalError(err)) throw err;
          return sendJson(res, err?.status || 400, { error: err?.message || 'Invalid MCP JSON.' });
        }
        const beforeSeq = toolsBroadcastSeq;
        const result = await importCandidates(store, vault, candidates, {
          profile: body.profile || 'all',
          personal,
          policy,
          updateExisting: true,
        });
        const updatedList = Array.isArray(result.updated) ? result.updated : [];

        const syncedAdded = await Promise.all(
          result.added.map(async ({ entry }) => {
            if (entry.enabled === false) return entry;
            try {
              return (await pool.sync(entry.id)) || entry;
            } catch {
              return (await store.get(entry.id)) || entry;
            }
          }),
        );
        const syncedUpdated = await Promise.all(
          updatedList.map(async ({ entry }) => {
            if (entry.enabled === false) {
              await pool.invalidate(entry.id);
              return entry;
            }
            try {
              await pool.retire(entry.id);
              return (await pool.sync(entry.id)) || entry;
            } catch {
              return (await store.get(entry.id)) || entry;
            }
          }),
        );

        if ((result.added.length > 0 || updatedList.length > 0) && toolsBroadcastSeq === beforeSeq) {
          broadcastMcpNotification('notifications/tools/list_changed');
        }

        return sendJson(res, 200, {
          added: syncedAdded.map((entry, idx) => ({
            ...sanitizeMcp(entry),
            secretsMoved: result.added[idx]?.secretsMoved || 0,
            warnings: result.added[idx]?.warnings || [],
            droppedSettings: result.added[idx]?.droppedSettings || [],
          })),
          updated: syncedUpdated.map((entry, idx) => ({
            ...sanitizeMcp(entry),
            secretsMoved: updatedList[idx]?.secretsMoved || 0,
            warnings: updatedList[idx]?.warnings || [],
            droppedSettings: updatedList[idx]?.droppedSettings || [],
          })),
          skipped: result.skipped,
          secretsMoved: [...result.added, ...updatedList].reduce((n, a) => n + a.secretsMoved, 0),
        });
      }

      const syncMatch = pathname.match(/^\/api\/mcps\/([a-z0-9_]+)\/sync$/);
      if (syncMatch && method === 'POST') {
        const id = syncMatch[1];
        const mcp = await store.get(id);
        if (!mcp) return sendJson(res, 404, { error: 'MCP not found.' });
        await pool.retire(id);
        const synced = await pool.sync(id);
        // Also refresh enabled, ready sibling accounts on the same service so multi-account tools never drift.
        const svcKey = serviceKeyOf(mcp);
        const siblings = accountsOfService(await store.list(), svcKey).filter(
          (s) => s.id !== id && s.enabled !== false && s.authRequired !== true,
        );
        if (siblings.length > 0) {
          track(
            Promise.allSettled(
              siblings.map(async (s) => {
                await pool.retire(s.id);
                await pool.sync(s.id);
              }),
            ),
          );
        }
        return sendJson(res, 200, { mcp: sanitizeMcp(synced), syncedSiblings: siblings.length });
      }

      // Add account: another sign-in of the same remote service. The copy keeps the address and none of the
      // first account's keys or sign-in. Agents without a choice stay on the first account; the ones the
      // owner picked move to the new one (lib/store.mjs adoptAccount).
      const addAccountMatch = pathname.match(/^\/api\/mcps\/([a-z0-9_]+)\/accounts$/);
      if (addAccountMatch && method === 'POST') {
        const source = await store.get(addAccountMatch[1]);
        if (!source) return sendJson(res, 404, { error: 'MCP not found.' });
        const transport = source.transport || (source.command ? 'stdio' : 'http');
        if (transport === 'builtin' || transport === 'stdio' || !source.url) {
          return sendJson(res, 400, { error: 'Only a remote connection can have another account. Add a local server again from Add connection.' });
        }
        const body = await readJsonBody(req);
        const accountLabel = typeof body?.accountLabel === 'string'
          ? body.accountLabel.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 60)
          : '';
        if (!accountLabel) return sendJson(res, 400, { error: 'Give the account a name, for example Work.' });
        const firstAccountLabel = typeof body?.firstAccountLabel === 'string'
          ? body.firstAccountLabel.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 60)
          : '';
        const agentIds = Array.isArray(body?.agentIds) ? body.agentIds.filter((id) => typeof id === 'string').slice(0, 200) : [];
        const svcKey = serviceKeyOf(source);
        const siblings = accountsOfService(await store.list(), svcKey);
        if (firstAccountLabel && siblings[0] && !siblings[0].accountLabel) {
          await store.update(siblings[0].id, { accountLabel: firstAccountLabel }).catch(() => {});
        }
        const sameLabel = siblings.find(
          (m) => String(m.accountLabel || '').trim().toLowerCase() === accountLabel.toLowerCase(),
        );
        if (sameLabel) {
          const isUnfinished = Boolean(
            (sameLabel.authRequired || !sameLabel.lastSyncAt) &&
            !sameLabel.oauth?.accessTokenVaultKey &&
            !sameLabel.oauth?.accessToken &&
            Object.keys(sameLabel.headers || {}).length === 0 &&
            !sameLabel.agentLogin &&
            (!Array.isArray(sameLabel.tools) || sameLabel.tools.length === 0),
          );
          if (isUnfinished) {
            if (agentIds.length) await store.adoptAccount(sameLabel.id, agentIds);
            scheduleConnectionsBroadcast();
            return sendJson(res, 200, { mcp: sanitizeMcp((await store.get(sameLabel.id)) || sameLabel), reused: true });
          }
          return sendJson(res, 409, {
            error: `An account named "${accountLabel}" already exists on ${source.name}.`,
            existingId: sameLabel.id,
          });
        }
        let targetUrl = source.url;
        if (typeof body?.url === 'string' && body.url.trim()) {
          const candidateUrl = body.url.trim();
          if (serviceKeyOf({ transport, url: candidateUrl }) === svcKey) {
            targetUrl = candidateUrl;
          }
        }
        const oldLabel = source.accountLabel ? ` (${source.accountLabel})` : '';
        const baseName = oldLabel && source.name.endsWith(oldLabel) ? source.name.slice(0, -oldLabel.length) : source.name;
        const { entry: created } = await admitConnectionWrite({
          actor: { kind: 'owner' },
          policy: getOutboundPolicy(activePort),
          existing: null,
          input: {
            name: baseName,
            description: source.description || '',
            transport,
            url: targetUrl,
            profiles: Array.isArray(source.profiles) ? source.profiles : ['all'],
            accountLabel,
          },
          allowVaultRefs: false,
          store,
          vault,
        });
        await store.update(created.id, { authRequired: true });
        await store.adoptAccount(created.id, agentIds);
        scheduleConnectionsBroadcast();
        return sendJson(res, 201, { mcp: sanitizeMcp((await store.get(created.id)) || created) });
      }

      const defaultAccountMatch = pathname.match(/^\/api\/mcps\/([a-z0-9_]+)\/default-account$/);
      if (defaultAccountMatch && method === 'POST') {
        const result = await store.setDefaultAccount(defaultAccountMatch[1]);
        if (!result) return sendJson(res, 404, { error: 'MCP not found.' });
        scheduleConnectionsBroadcast();
        return sendJson(res, 200, { ok: true, ...result });
      }

      const toggleMatch = pathname.match(/^\/api\/mcps\/([a-z0-9_]+)\/toggle$/);
      if (toggleMatch && method === 'POST') {
        const id = toggleMatch[1];
        const body = await readJsonBody(req);
        const updated = await store.toggle(id, body.enabled);
        if (!updated) return sendJson(res, 404, { error: 'MCP not found.' });
        if (!updated.enabled) {
          await pool.invalidate(id);
        } else if (needsAutoSync(updated) || updated.lastError || !updated.tools?.length) {
          track(pool.sync(id).catch(() => {}));
        }
        broadcastMcpNotification('notifications/tools/list_changed');
        if (updated.resources?.length) broadcastMcpNotification('notifications/resources/list_changed');
        if (updated.prompts?.length) broadcastMcpNotification('notifications/prompts/list_changed');
        return sendJson(res, 200, { mcp: sanitizeMcp(updated) });
      }

      // A sign-in that this connection asked for during a call (lib/app-sign-ins.mjs).
      const appSignInMatch = pathname.match(/^\/api\/mcps\/([a-z0-9_]+)\/app-sign-ins\/([0-9a-f]{16})(\/open)?$/);
      if (appSignInMatch && (appSignInMatch[3] ? method === 'POST' : method === 'DELETE')) {
        const conn = await store.get(appSignInMatch[1]);
        if (!conn) return sendJson(res, 404, { error: 'MCP not found.' });
        if (!appSignInMatch[3]) {
          return pool.signIns.remove(conn, appSignInMatch[2])
            ? sendJson(res, 200, { ok: true })
            : sendJson(res, 404, { error: 'This sign-in is no longer in Loop.' });
        }
        const opened = pool.signIns.opened(conn, appSignInMatch[2]);
        if (!opened) return sendJson(res, 410, { error: 'This link has ended. Ask your agent to try again.' });
        return sendJson(res, 200, opened);
      }

      // The owner approves an agent-written connection name for other agents' startup context.
      const approveNameMatch = pathname.match(/^\/api\/mcps\/([a-z0-9_]+)\/approve-name$/);
      if (approveNameMatch && method === 'POST') {
        const id = approveNameMatch[1];
        const current = await store.get(id);
        if (!current) return sendJson(res, 404, { error: 'MCP not found.' });
        const updated = isNamePending(current)
          ? await store.update(id, { addedBy: approvedAddedBy(current.addedBy) })
          : current;
        if (!updated) return sendJson(res, 404, { error: 'MCP not found.' });
        return sendJson(res, 200, { mcp: sanitizeMcp(updated) });
      }

      const toolToggleMatch = pathname.match(/^\/api\/mcps\/([a-z0-9_]+)\/tools\/toggle$/);
      if (toolToggleMatch && method === 'POST') {
        const id = toolToggleMatch[1];
        const body = await readJsonBody(req);
        const updated = await store.toggleTool(id, body.toolName, Boolean(body.enabled));
        if (!updated) return sendJson(res, 404, { error: 'MCP not found.' });
        broadcastMcpNotification('notifications/tools/list_changed');
        return sendJson(res, 200, { mcp: sanitizeMcp(updated) });
      }

      const toolPinMatch = pathname.match(/^\/api\/mcps\/([a-z0-9_]+)\/tools\/pin$/);
      if (toolPinMatch && method === 'POST') {
        const id = toolPinMatch[1];
        const body = await readJsonBody(req);
        const updated = await store.pinTool(id, body.toolName, Boolean(body.pinned));
        if (!updated) return sendJson(res, 404, { error: 'MCP not found.' });
        broadcastMcpNotification('notifications/tools/list_changed');
        return sendJson(res, 200, { mcp: sanitizeMcp(updated) });
      }

      const toolTestMatch = pathname.match(/^\/api\/mcps\/([a-z0-9_]+)\/tools\/test$/);
      if (toolTestMatch && method === 'POST') {
        const id = toolTestMatch[1];
        const mcp = await store.get(id);
        if (!mcp) return sendJson(res, 404, { error: 'MCP not found.' });
        const body = await readJsonBody(req);
        const toolName = String(body.toolName || '').trim();
        if (!toolName) return sendJson(res, 400, { error: 'toolName is required.' });
        let toolArgs = body.arguments ?? {};
        if (typeof toolArgs === 'string') {
          try {
            toolArgs = toolArgs.trim() ? JSON.parse(toolArgs) : {};
          } catch {
            return sendJson(res, 400, { error: 'Invalid arguments JSON.' });
          }
        }
        try {
          const result = await pool.callTool(id, toolName, toolArgs);
          return sendJson(res, 200, { result });
        } catch (err) {
          if (isRawInternalError(err)) throw err;
          return sendJson(res, err?.status || 502, { error: err?.message || 'Tool call failed.' });
        }
      }

      const oauthStartMatch = pathname.match(/^\/api\/mcps\/([a-z0-9_]+)\/oauth\/start$/);
      if (oauthStartMatch && method === 'POST') {
        const id = oauthStartMatch[1];
        const mcp = await store.get(id);
        if (!mcp) return sendJson(res, 404, { error: 'MCP not found.' });
        if (isSharedConnection(mcp)) return sendJson(res, 400, { error: 'This connection uses the account of somebody else. It needs no sign-in.' });
        const body = await readJsonBody(req);
        const rawClientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
        const rawClientSecret = typeof body?.clientSecret === 'string' ? body.clientSecret.trim() : '';
        if (rawClientId && (rawClientId.length > 512 || /[\u0000-\u001f\u007f]/.test(rawClientId))) {
          return sendJson(res, 400, { error: 'Enter a valid Client ID.' });
        }
        if (rawClientSecret && (rawClientSecret.length > 4096 || /[\u0000-\u001f\u007f]/.test(rawClientSecret))) {
          return sendJson(res, 400, { error: 'Enter a valid Client Secret.' });
        }
        try {
          if (personal) assertPersonalStoredConnection(mcp, { selfIdentity: getSelfIdentity(activePort) });
          const callbackUrl = `${origin}/oauth/callback`;
          const { authorizeUrl, sameOrigin, authHost, issuer } = await startOAuthFlow(
            mcp,
            callbackUrl,
            {
              ...signInOptions(mcp.url, activePort),
              ...(rawClientId ? { clientId: rawClientId, clientSecret: rawClientSecret || null } : {}),
            },
          );
          if (!isSafeAuthorizeUrl(authorizeUrl)) {
            const err = new Error('Its sign-in page is not a secure (https) address.');
            err.status = 400;
            throw err;
          }
          if (mcp.signInBroken) await store.update(id, { signInBroken: null }).catch(() => null);
          let connectionHost = '';
          try { connectionHost = new URL(mcp.url).host; } catch { /* shown as unknown */ }
          return sendJson(res, 200, {
            authorizeUrl,
            name: mcp.name,
            connectionHost,
            sameOrigin,
            authHost,
            issuer,
          });
        } catch (err) {
          if (isRawInternalError(err)) throw err;
          // The sign-in could not even start. Keep the real reason on the connection for agents
          // (they connect the app another way) and show the person a plain sentence, never the raw error.
          const reason = String(err?.message || 'Could not start sign-in.').slice(0, 300);
          // A network hiccup is not proof the sign-in is broken: say try again, and keep the link.
          if (/timed? ?out|abort|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket|unreachable/i.test(reason)) {
            return sendJson(res, 503, { error: `Couldn't reach ${mcp.name} to start sign-in. Try again in a minute.`, detail: reason });
          }
          const authModeHint = /Dynamic Client Registration|Client ID Metadata/i.test(reason)
            ? 'oauth_client'
            : /Could not discover OAuth/i.test(reason)
              ? 'api_key'
              : 'credentials';
          if (!rawClientId) {
            await store.update(id, { signInBroken: reason }).catch(() => null);
          }
          return sendJson(res, err?.status || 400, {
            error: rawClientId
              ? `Could not start sign-in for ${mcp.name} with those app credentials.`
              : `${mcp.name} can't be signed in to directly. Enter its credentials or a login in Loop instead.`,
            signInBroken: true,
            authModeHint,
            detail: reason,
          });
        }
      }

      const connLoginMatch = pathname.match(/^\/api\/mcps\/([a-z0-9_]+)\/login$/);
      if (connLoginMatch && method === 'POST') {
        const id = connLoginMatch[1];
        const mcp = await store.get(id);
        if (!mcp) return sendJson(res, 404, { error: 'MCP not found.' });
        const body = await readJsonBody(req);
        try {
          const saved = await saveOwnerLogin({
            vault,
            store,
            policyStore,
            origin: body?.origin,
            origins: body?.origins,
            username: body?.username,
            password: body?.password,
            label: body?.label || `Login for ${mcp.name}`,
            profiles: mcp.profiles,
            agentIds: Array.isArray(body?.agentIds) ? body.agentIds : undefined,
          });
          const updated = await store.update(id, {
            agentLogin: {
              vaultKey: saved.key,
              origin: saved.origin,
              username: saved.username || '',
              savedAt: new Date().toISOString(),
            },
          });
          activity.record({
            agentId: null,
            agentName: 'Owner',
            method: 'secret/save',
            target: `${saved.key} → ${saved.origins.join(', ')}`,
            ok: true,
          });
          broadcastSse('agents', { at: Date.now() });
          scheduleConnectionsBroadcast();
          return sendJson(res, 200, {
            ok: true,
            login: saved,
            mcp: updated ? sanitizeMcp(updated) : sanitizeMcp(mcp),
          });
        } catch (err) {
          if (isRawInternalError(err)) throw err;
          return sendJson(res, err?.status || 400, { error: err?.message || 'Could not save login.' });
        }
      }

      if (legacy && pathname === '/oauth/callback' && method === 'GET') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const iss = url.searchParams.has('iss') ? url.searchParams.get('iss') : undefined;
        const errorParam = url.searchParams.get('error') || '';
        const errorDescription = url.searchParams.get('error_description') || '';
        if (errorParam || errorDescription || !code || !state) {
          const errCode = mapOAuthCallbackErrorCode({
            errorParam,
            errorDescription,
            missingParams: !code || !state,
          });
          res.writeHead(302, {
            Location: `/#connections?oauth_error=${encodeURIComponent(errCode)}`,
          });
          return res.end();
        }
        try {
          const result = await finishSignIn(code, state, { iss, activePort });
          const params = new URLSearchParams({ connected: result.connId });
          if (result.readiness?.state) params.set('oauth_state_result', result.readiness.state);
          res.writeHead(302, { Location: `/#connections?${params}` });
          return res.end();
        } catch (err) {
          const errCode = mapOAuthCallbackErrorCode({ err });
          res.writeHead(302, {
            Location: `/#connections?oauth_error=${encodeURIComponent(errCode)}`,
          });
          return res.end();
        }
      }

      // The dashboard finishes a sign-in as the signed-in owner (same-origin POST with Bearer/session).
      if (pathname === '/api/mcps/oauth/finish' && method === 'POST') {
        const body = await readJsonBody(req);
        const code = typeof body.code === 'string' ? body.code : '';
        const state = typeof body.state === 'string' ? body.state : '';
        const iss = body.iss === undefined || body.iss === null ? undefined : String(body.iss);
        if (!code || !state) return sendJson(res, 400, { error: 'Missing OAuth code or state.' });
        try {
          const result = await finishSignIn(code, state, { iss, activePort });
          return sendJson(res, 200, {
            connected: result.connId,
            ready: result.ready,
            readiness: result.readiness,
            readEvidence: result.readEvidence,
            discoveryError: result.discoveryError,
            mcp: result.mcp,
          });
        } catch (err) {
          if (isRawInternalError(err)) throw err;
          return sendJson(res, err?.status || 400, { error: err?.message || 'OAuth authentication failed.' });
        }
      }

      // A connection's logo: served from Loop's own cache, set by the owner, or reset to the found one.
      const logoMatch = pathname.match(/^\/api\/mcps\/([a-z0-9_]+)\/logo$/);
      if (logoMatch && (method === 'GET' || method === 'HEAD')) {
        const logo = await logos.read(logoMatch[1]);
        if (!logo) return sendJson(res, 404, { error: 'No logo.' });
        res.writeHead(200, { 'Content-Type': logo.mime, 'Content-Length': logo.buf.length, ETag: `"${logo.hash}"`, ...LOGO_RESPONSE_HEADERS });
        return res.end(method === 'HEAD' ? undefined : logo.buf);
      }
      if (logoMatch && method === 'POST') {
        const id = logoMatch[1];
        if (!(await store.get(id))) return sendJson(res, 404, { error: 'MCP not found.' });
        const body = await readJsonBody(req);
        try {
          await logos.setCustom(id, { image: body?.image, url: body?.url });
        } catch (err) {
          const reason = /not a PNG|Choose an image|Logo address/.test(String(err?.message)) ? err.message : 'Loop could not get an image from that address.';
          return sendJson(res, 400, { error: reason });
        }
        scheduleConnectionsBroadcast();
        return sendJson(res, 200, { logo: await logos.publicInfo(id) });
      }
      if (logoMatch && method === 'DELETE') {
        const id = logoMatch[1];
        const conn = await store.get(id);
        if (!conn) return sendJson(res, 404, { error: 'MCP not found.' });
        await logos.clearCustom(id);
        await logos.resolve(conn, { force: true }).catch(() => false);
        scheduleConnectionsBroadcast();
        return sendJson(res, 200, { logo: await logos.publicInfo(id) });
      }

      const evidenceMatch = pathname.match(/^\/api\/mcps\/([a-z0-9_]+)\/read-status$/);
      if (evidenceMatch && method === 'GET') {
        const conn = await store.get(evidenceMatch[1]);
        if (!conn) return sendJson(res, 404, { error: 'MCP not found.' });
        const readiness = connectionReadiness(conn, { tokenRejected: isTokenRejected(conn) });
        return sendJson(res, 200, {
          name: conn.name,
          readEvidence: pool.readEvidence(conn),
          readiness,
          lastError: conn.lastError ?? null,
        });
      }

      const itemMatch = pathname.match(/^\/api\/mcps\/([a-z0-9_]+)$/);
      if (itemMatch && method === 'PATCH') {
        const id = itemMatch[1];
        const existing = await store.get(id);
        if (!existing) return sendJson(res, 404, { error: 'MCP not found.' });

        const body = await readJsonBody(req);
        const isObj = body !== null && typeof body === 'object' && !Array.isArray(body);
        const applyToService = isObj && body.applyToService === true;
        const patchInput = isObj && Object.hasOwn(body, 'applyToService')
          ? (({ applyToService: _ignored, ...rest }) => rest)(body)
          : body;
        const policy = getOutboundPolicy(activePort);
        const { entry: updated, oauthCleared } = await admitConnectionWrite({
          actor: { kind: 'owner' },
          policy,
          existing,
          input: patchInput,
          allowVaultRefs: true,
          store,
          vault,
        });

        const hasToken = typeof patchInput?.token === 'string' && Boolean(patchInput.token.trim());
        const needsInvalidate =
          hasToken ||
          oauthCleared ||
          ['transport', 'type', 'url', 'headers', 'command', 'args', 'env', 'cwd', 'enabled'].some(
            (f) => patchInput?.[f] !== undefined,
          );
        if (needsInvalidate) {
          if (updated.enabled === false) {
            await pool.invalidate(id);
          } else {
            await pool.retire(id);
            track(pool.sync(id).catch(() => {}));
          }
        }
        // When explicitly updating a remote service address/transport, keep sibling accounts that
        // shared the exact same old URL in sync without touching distinct query-scoped siblings.
        const addressChanged = Boolean(
          applyToService &&
          existing.url &&
          updated.url &&
          (existing.url !== updated.url || existing.transport !== updated.transport),
        );
        if (addressChanged) {
          const allConns = await store.list();
          const matchingSiblings = allConns.filter(
            (s) => s.id !== id && s.transport !== 'builtin' && s.transport !== 'stdio' && s.url === existing.url,
          );
          for (const sib of matchingSiblings) {
            try {
              const sibRes = await admitConnectionWrite({
                actor: { kind: 'owner' },
                policy,
                existing: sib,
                input: {
                  url: updated.url,
                  ...(updated.transport !== sib.transport ? { transport: updated.transport } : {}),
                },
                allowVaultRefs: true,
                store,
                vault,
              });
              if (sibRes.entry.enabled === false) {
                await pool.invalidate(sib.id);
              } else {
                await pool.retire(sib.id);
                track(pool.sync(sib.id).catch(() => {}));
              }
            } catch {
              // Keep primary update intact even if one sibling fails admission.
            }
          }
        }
        const scopeChanged =
          existing.enabled !== updated.enabled ||
          existing.partnerSkillsEnabled !== updated.partnerSkillsEnabled ||
          JSON.stringify(existing.profiles || []) !== JSON.stringify(updated.profiles || []);
        broadcastMcpNotification('notifications/tools/list_changed');
        if (existing.partnerSkillsEnabled !== updated.partnerSkillsEnabled) {
          scheduleSearchReindex();
          broadcastSse('skills', { at: Date.now() });
          broadcastMcpNotification('notifications/resources/list_changed');
        }
        if (scopeChanged) {
          if (existing.resources?.length || updated.resources?.length) {
            broadcastMcpNotification('notifications/resources/list_changed');
          }
          if (existing.prompts?.length || updated.prompts?.length) {
            broadcastMcpNotification('notifications/prompts/list_changed');
          }
        }
        return sendJson(res, 200, { mcp: sanitizeMcp(updated) });
      }

      if (itemMatch && method === 'DELETE') {
        const id = itemMatch[1];
        const existing = await store.get(id);
        const removed = await deleteConnection({
          id,
          store,
          vault,
          pool,
          policyStore,
          catStore,
        });
        if (!removed) return sendJson(res, 404, { error: 'MCP not found.' });
        await searchIndex.removeConnectionImmediate(id).catch(() => {});
        await logos.remove(id).catch(() => {});
        broadcastMcpNotification('notifications/tools/list_changed');
        if (existing?.resources?.length) {
          broadcastMcpNotification('notifications/resources/list_changed');
        }
        if (existing?.prompts?.length) {
          broadcastMcpNotification('notifications/prompts/list_changed');
        }
        return sendJson(res, 200, { removed: true });
      }

      // An authenticated owner submits a one-use workspace-local capture form. No raw value in responses.
      if (pathname === '/api/vault/capture' && method === 'POST') {
        const body = await readJsonBody(req, { maxBytes: 512 * 1024 });
        if (!/^[0-9a-f]{48}$/.test(body.form || '') || Object.keys(body).some(k => k !== 'form' && k !== 'value')) {
          return sendJson(res, 400, { error: 'Invalid capture request.' });
        }
        const form = vault.captureForm(body.form);
        if (!form) return sendJson(res, 410, { error: 'Capture form is expired or unavailable.' });
        if (!Object.hasOwn(body, 'value')) return sendJson(res, 200, { type: form.type, label: form.label });
        try {
          return sendJson(res, 201, await vault.submitCaptureForm(body.form, body.value));
        } catch {
          return sendJson(res, 400, { error: 'Credential could not be captured.' });
        }
      }

      // Vault API
      if (pathname === '/api/vault' && method === 'GET') {
        const profileFilter = parseProfileQueryParam(url);
        const [secrets, allSecrets, mcps] = await Promise.all([
          vault.list({ profile: profileFilter }),
          profileFilter !== 'all' ? vault.list() : Promise.resolve(null),
          store.list(),
        ]);
        const profileData = await buildProfileRecords({
          store,
          skillStore,
          memoryStore,
          vault,
          mcps,
          secrets: allSecrets || secrets,
        });
        const oauthConnections = mcps
          .filter((m) => m.oauth?.accessTokenVaultKey)
          .map((m) => ({ id: m.id, name: m.name, expiresAt: m.oauth.expiresAt }));
        return sendJson(res, 200, {
          secrets,
          oauthConnections,
          vaultTypes: VAULT_TYPES,
          approvalModes: APPROVAL_MODES,
          profiles: profileData.profiles,
          profileRecords: profileData.profileRecords,
        });
      }

      if (pathname === '/api/vault' && method === 'POST') {
        const body = await readJsonBody(req);
        if (typeof body.key !== 'string' || !body.key.trim()) {
          return sendJson(res, 400, { error: 'Vault key must be a non-empty string.' });
        }
        const key = body.key.trim();
        if (key.startsWith('__')) {
          return sendJson(res, 400, { error: 'Vault keys starting with "__" are reserved.' });
        }
        if (typeof body.value !== 'string' || body.value.length === 0) {
          return sendJson(res, 400, { error: 'Secret value must be a non-empty string.' });
        }
        const metaOpts = {};
        if (body.description !== undefined) metaOpts.description = body.description;
        if (body.type !== undefined) metaOpts.type = body.type;
        if (body.category !== undefined) metaOpts.category = body.category;
        if (body.username !== undefined) metaOpts.username = body.username;
        if (body.approval !== undefined) metaOpts.approval = body.approval;
        if (body.allowedSinks !== undefined) metaOpts.allowedSinks = body.allowedSinks;
        if (body.profiles !== undefined) metaOpts.profiles = body.profiles;
        const refusal = await vaultGuardRefusal(key, body);
        if (refusal) return sendJson(res, refusal.status, refusal.body);
        const overwrite = body.overwrite === true;
        if (!overwrite) metaOpts.createOnly = true;
        try {
          const secret = await vault.set(key, body.value, metaOpts);
          return sendJson(res, overwrite ? 200 : 201, { secret, replaced: overwrite });
        } catch (err) {
          if (err?.code === 'VAULT_EXISTS') {
            const existingApproval = vaultItemMode(await policyStore.get(), err.existing);
            return sendJson(res, 409, {
              error: err.message,
              code: 'VAULT_EXISTS',
              existing: err.existing,
              existingApproval,
            });
          }
          throw err;
        }
      }

      const vaultItemMatch = pathname.match(/^\/api\/vault\/([^/]+)$/);
      if (vaultItemMatch && method === 'PATCH') {
        let key;
        try {
          key = decodeURIComponent(vaultItemMatch[1]);
        } catch {
          return sendJson(res, 400, { error: 'Invalid vault key.' });
        }
        if (key.startsWith('__')) {
          return sendJson(res, 400, { error: 'Vault keys starting with "__" are managed by Loop.' });
        }
        const body = await readJsonBody(req);
        const patch = {};
        if (body.description !== undefined) patch.description = body.description;
        if (body.type !== undefined) patch.type = body.type;
        if (body.category !== undefined) patch.category = body.category;
        if (body.approval !== undefined) patch.approval = body.approval;
        if (body.allowedSinks !== undefined) patch.allowedSinks = body.allowedSinks;
        if (body.profiles !== undefined) patch.profiles = body.profiles;
        const refusal = await vaultGuardRefusal(key, body);
        if (refusal) return sendJson(res, refusal.status, refusal.body);
        const secret = await vault.updateMeta(key, patch);
        if (!secret) return sendJson(res, 404, { error: 'Secret not found.' });
        return sendJson(res, 200, { secret });
      }

      if (vaultItemMatch && method === 'DELETE') {
        let key;
        try {
          key = decodeURIComponent(vaultItemMatch[1]);
        } catch {
          return sendJson(res, 400, { error: 'Invalid vault key.' });
        }
        if (key.startsWith('__')) {
          return sendJson(res, 400, { error: 'Vault keys starting with "__" are managed by Loop.' });
        }
        const removed = await vault.delete(key);
        if (!removed) return sendJson(res, 404, { error: 'Secret not found.' });
        return sendJson(res, 200, { removed: true });
      }

      // Search Index status & manual reindex API (owner-authenticated)
      if (pathname === '/api/search/status' && method === 'GET') {
        const [connsNow, skillsNow, memoriesNow] = await Promise.all([
          store.list({ clone: false }),
          skillStore.list().catch(() => []),
          memoryStore.list().catch(() => []),
        ]);
        let enabledTools = 0;
        for (const c of connsNow) {
          if (c && c.enabled !== false && Array.isArray(c.tools)) enabledTools += c.tools.length;
        }
        searchIndex._lastToolCount = enabledTools;
        searchIndex._lastConnCount = connsNow.length;
        searchIndex._lastSkillCount = skillsNow.length;
        searchIndex._lastMemoryCount = memoriesNow.length;
        const status = await searchIndex.getStatus();
        return sendJson(res, 200, status);
      }

      if (pathname === '/api/search/reindex' && method === 'POST') {
        const result = await runSearchReindex();
        const status = await searchIndex.getStatus();
        return sendJson(res, 200, { ok: true, result, status });
      }

      // Settings API
      if (pathname === '/api/settings' && method === 'GET') {
        const [settings, profileData] = await Promise.all([
          store.getSettings(),
          buildProfileRecords({ store, skillStore, memoryStore, vault }),
        ]);
        return sendJson(res, 200, {
          settings: legacy ? settings : { ...settings, requireAgentToken: true },
          profiles: profileData.profiles,
          profileRecords: profileData.profileRecords,
          endpoint,
          port: activePort,
          stdioPath,
          ...(personal
            ? {
                hostedOriginMode: getHostedOriginPolicy().mode,
                trustedOrigins: listPersonalUpstreamOrigins(),
              }
            : {}),
        });
      }

      if (pathname === '/api/settings' && method === 'PATCH') {
        const body = await readJsonBody(req);
        const patch = {};
        if (body.defaultProfile !== undefined) patch.defaultProfile = body.defaultProfile;
        if (body.requireAgentToken !== undefined) {
          if (typeof body.requireAgentToken !== 'boolean') {
            return sendJson(res, 400, { error: 'requireAgentToken must be a boolean.' });
          }
          if (!legacy && body.requireAgentToken === false) {
            return sendJson(res, 400, { error: 'Loop requires a workspace agent key.' });
          }
          patch.requireAgentToken = body.requireAgentToken;
        }
        if (body.paused !== undefined) patch.paused = body.paused;
        if (body.turnRecall !== undefined) patch.turnRecall = body.turnRecall;
        if (body.agentFeedback !== undefined) patch.agentFeedback = body.agentFeedback;
        if (body.oauthRefreshTtlDays !== undefined) patch.oauthRefreshTtlDays = body.oauthRefreshTtlDays;
        const prevSettings = await store.getSettings();
        const settings = await store.updateSettings(patch, { personal });
        if (patch.agentFeedback === null) sharedSearch?.feedback?.store.askAgain(id || 'local');
        if (
          prevSettings.paused !== settings.paused ||
          prevSettings.defaultProfile !== settings.defaultProfile ||
          prevSettings.turnRecall !== settings.turnRecall ||
          prevSettings.agentFeedback !== settings.agentFeedback
        ) {
          broadcastMcpNotification('notifications/tools/list_changed');
        }
        return sendJson(res, 200, { settings });
      }

      // What agents of this workspace reported about Loop. The owner sees it and deletes it here.
      if (pathname === '/api/feedback' && method === 'GET') {
        const { store: inbox = null, shared = false } = sharedSearch?.feedback || {};
        return sendJson(res, 200, {
          available: Boolean(inbox) && feedbackIsAvailable(),
          shared,
          state: feedbackState(await store.getSettings(), { shared }),
          reports: inbox?.ownReports(id || 'local') || [],
        });
      }
      if (pathname.startsWith('/api/feedback/') && method === 'DELETE') {
        const removed = sharedSearch?.feedback?.store.removeOwnReport(id || 'local', pathname.slice('/api/feedback/'.length));
        return removed ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'This report is not here any more.' });
      }

      // Local MCP Inspector API (owner-authenticated, scoped to this workspace)
      const buildInspectorMcpOpts = ({
        agent = null,
        profile = 'all',
        sessionId: inspSessionId = null,
        session = null,
        mcpApps = true,
        elicit = false,
        signal = null,
      } = {}) => {
        const inspectorElicitApproval = elicit
          ? async ({ approval, approveUrl, timeoutMs = 120_000, signal: elicitSignal = null }) => {
              if (closed || signal?.aborted || elicitSignal?.aborted) return { outcome: 'fallback' };
              const elicitId = `iel_${randomBytes(8).toString('hex')}`;
              const useForm = !approval?.guard;
              const spec = approval?.uiSpec || buildApprovalUiSpec({
                kind: approval?.kind,
                target: approval?.target,
                title: approval?.title,
                reason: approval?.reason,
                detail: approval?.detail,
                agentName: approval?.agentName,
              });
              const params = specToMcpElicitation(spec, {
                approveUrl,
                protocolVersion: '2025-11-25',
                useForm,
                elicitationId: approval?.id || '',
              });
              const rpcPayload = {
                jsonrpc: '2.0',
                id: elicitId,
                method: 'elicitation/create',
                params,
              };
              const responsePromise = new Promise((resolve) => {
                const finish = (val) => {
                  const existing = pendingInspectorElicitations.get(elicitId);
                  if (!existing) return;
                  pendingInspectorElicitations.delete(elicitId);
                  clearTimeout(existing.timer);
                  if (elicitSignal) elicitSignal.removeEventListener('abort', onAbort);
                  if (signal) signal.removeEventListener('abort', onAbort);
                  resolve(val);
                };
                const onAbort = () => finish(null);
                const timer = setTimeout(() => finish(null), Math.max(1000, Math.min(120_000, timeoutMs)));
                timer.unref?.();
                pendingInspectorElicitations.set(elicitId, { resolve: finish, timer });
                if (elicitSignal?.aborted || signal?.aborted) {
                  finish(null);
                  return;
                }
                elicitSignal?.addEventListener('abort', onAbort, { once: true });
                signal?.addEventListener('abort', onAbort, { once: true });
              });
              broadcastSse('inspector_elicit', {
                elicitId,
                approvalId: approval?.id || '',
                guard: Boolean(approval?.guard),
                mode: useForm ? 'form' : 'url',
                title: approval?.title || 'Approval required',
                target: approval?.target || '',
                params,
                rpc: rpcPayload,
              });
              const clientReply = await responsePromise;
              return parseMcpElicitationAnswer(spec, clientReply, { useForm });
            }
          : null;

        return {
        hostedExecutor: sharedSearch?.hosted === true,
        profile: profile || 'all',
        ...(session?.baseProfile && inspSessionId ? {
          projectSession: {
            read: () => clients.getSession(inspSessionId),
            set: (project) => clients.setSessionProject(inspSessionId, agent?.id ?? null, project),
          },
        } : {}),
        onProjectDeleted: (project) => projectGone(project),
        agent,
        clientInfo: { name: 'loop-inspector', version: '2.0.0' },
        clientCapabilities: {
          elicitation: elicit ? { form: true, url: true } : { form: false, url: false },
          mcpApps: mcpApps
            ? { supported: true, mimeTypes: [MCP_APP_MIME_TYPE] }
            : { supported: false, mimeTypes: [] },
        },
        feedback: sharedSearch?.feedback ? {
          ...sharedSearch.feedback,
          workspaceId: id || 'local',
          clientVersion: '2.0.0',
          protocolVersion: '2025-11-25',
          transport: 'http',
          surface: sharedSearch.feedback.shared ? 'cloud' : 'local',
        } : null,
        sessionId: inspSessionId,
        elicitApproval: inspectorElicitApproval,
        onPolicyChange: (target) => broadcastSse('policies', { target, at: Date.now() }),
        activity,
        skillStore,
        memoryStore,
        taskStore,
        savedStore,
        scheduleStore,
        fileStore,
        historyStore,
        dreamStore,
        ownerTimezone,
        onSavedEnrich: enqueueSavedEnrich,
        onScheduleRun: runScheduleById,
        broadcast: (type, data = {}) => { if (!closed) broadcastSse(type, { at: Date.now(), ...data }); },
        catStore,
        categoryRequests,
        policyStore,
        approvalQueue,
        searchIndex,
        memoryVerdicts,
        shareStore: sharedSearch?.shares || null,
        library,
        agentHandoffs: sharedSearch?.agentHandoffs || null,
        workspaceId: id || null,
        clipboardWriter: opts.clipboardWriter || null,
        onNeedSearchIndex: scheduleSearchReindex,
        fileCategoriesNow,
        personal,
        loopPort: activePort,
        loopStdioPath: stdioPath,
        outboundPolicy: getOutboundPolicy(activePort),
        dashboardUrl: `${origin}/`,
        signal,
        onCatalogMutation: (ev) => {
          notifyCatalogChange(ev);
          scheduleSearchReindex();
          scheduleConnectionsBroadcast();
        },
      };
      };

      if (pathname === '/api/inspector/context' && method === 'GET') {
        const [settings, mcps, agents, projects] = await Promise.all([
          store.getSettings(),
          store.list({ clone: false }),
          store.listAgents(),
          findWorkspaceProjects({ store, pool, skillStore, access: resolveAccess(await store.getSettings(), {}) }).catch(() => []),
        ]);
        const builtInWidgets = listLoopAppResources();
        const upstreamWidgets = [];
        for (const conn of mcps) {
          if (!conn.enabled) continue;
          for (const r of Array.isArray(conn.resources) ? conn.resources : []) {
            if (r.mimeType === MCP_APP_MIME_TYPE) {
              upstreamWidgets.push({
                uri: buildUpstreamWidgetUri(conn.id, r.uri),
                upstreamUri: r.uri,
                connectionId: conn.id,
                connectionName: conn.name,
                name: r.name ? `[${conn.name}] ${r.name}` : `[${conn.name}] ${r.uri}`,
                description: r.description || '',
                mimeType: r.mimeType,
              });
            }
          }
        }
        await inspectorTrace.flush();
        return sendJson(res, 200, {
          endpoint,
          origin,
          personal,
          hosted: sharedSearch?.hosted === true,
          defaultProfile: settings?.defaultProfile || 'all',
          profiles: [{ id: 'all', name: 'All' }, ...projects.map((p) => ({ id: p.id, name: p.name || p.id }))],
          agents: agents.map((a) => publicAgent(a)),
          connections: mcps.map((c) => sanitizeMcp(c)),
          builtInWidgets,
          upstreamWidgets,
          extension: MCP_APP_EXTENSION,
          mimeType: MCP_APP_MIME_TYPE,
          traceCount: inspectorTrace.list({ limit: 150 }).length,
        });
      }

      if (pathname === '/api/inspector/trace' && method === 'GET') {
        await inspectorTrace.flush();
        const limit = Number.parseInt(url.searchParams.get('limit') || '80', 10);
        return sendJson(res, 200, {
          entries: inspectorTrace.list({ limit: Number.isFinite(limit) ? limit : 80 }),
        });
      }

      if (pathname === '/api/inspector/trace' && method === 'DELETE') {
        await inspectorTrace.flush();
        inspectorTrace.clear();
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/inspector/audit' && method === 'GET') {
        const report = await runInspectorAudit({
          store,
          vault,
          pool,
          handleMcpRequest,
          mcpOpts: buildInspectorMcpOpts({ profile: 'all', agent: null, mcpApps: true }),
          mcpOAuth,
          origin,
        });
        return sendJson(res, 200, report);
      }

      const inspElicitMatch = pathname.match(/^\/api\/inspector\/elicit\/(iel_[a-f0-9]{16})$/);
      if (inspElicitMatch && method === 'POST') {
        const elicitId = inspElicitMatch[1];
        const pending = pendingInspectorElicitations.get(elicitId);
        if (!pending) return sendJson(res, 404, { error: 'Elicitation request expired or not found.' });
        const body = await readJsonBody(req);
        const action = typeof body?.action === 'string' ? body.action.trim().toLowerCase() : '';
        if (!['accept', 'decline', 'cancel'].includes(action)) {
          return sendJson(res, 400, { error: 'action must be "accept", "decline", or "cancel".' });
        }
        const content = isPlainObject(body?.content) ? body.content : undefined;
        pending.resolve({
          jsonrpc: '2.0',
          id: elicitId,
          result: {
            action,
            ...(content ? { content } : {}),
          },
        });
        return sendJson(res, 200, { ok: true, elicitId, action });
      }

      if (pathname === '/api/inspector/rpc' && method === 'POST') {
        const body = await readJsonBody(req);
        const rpc = body?.rpc;
        if (!isPlainObject(rpc) || typeof rpc.method !== 'string' || !rpc.method.trim()) {
          return sendJson(res, 400, { error: 'rpc object with a valid method string is required.' });
        }
        const normalizedRpc = {
          jsonrpc: '2.0',
          id: rpc.id !== undefined ? rpc.id : `insp_${randomBytes(4).toString('hex')}`,
          method: rpc.method.trim(),
          ...(rpc.params !== undefined ? { params: rpc.params } : {}),
        };
        let simAgent = null;
        if (typeof body.agentId === 'string' && body.agentId.trim()) {
          simAgent = await store.getAgent(body.agentId.trim());
          if (!simAgent) return sendJson(res, 404, { error: 'Agent not found.' });
        }
        const reqProfile = typeof body.profile === 'string' && body.profile.trim() ? body.profile.trim() : 'all';
        const mcpApps = body.mcpApps !== false;
        const elicit = body.elicit === true;
        let inspSessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
          ? body.sessionId.trim().slice(0, 64)
          : null;
        let inspSession = inspSessionId ? await clients.getSession(inspSessionId) : null;
        if (inspSessionId && (!inspSession || inspSession.closedAt || inspSession.agentId !== (simAgent?.id ?? null))) {
          inspSessionId = null;
          inspSession = null;
        }
        const inspAc = new AbortController();
        const onInspClose = () => {
          if (!res.writableEnded) inspAc.abort();
        };
        res.on('close', onInspClose);
        const inspOpts = buildInspectorMcpOpts({
          agent: simAgent,
          profile: reqProfile,
          sessionId: inspSessionId,
          session: inspSession,
          mcpApps,
          elicit,
          signal: inspAc.signal,
        });
        const started = Date.now();
        let reply;
        try {
          reply = await handleMcpRequest(store, vault, pool, normalizedRpc, inspOpts);
        } finally {
          res.off('close', onInspClose);
        }
        if (res.writableEnded || res.destroyed) return;
        const durationMs = Date.now() - started;

        let nextSessionId = inspSessionId;
        if (normalizedRpc.method === 'initialize' && reply && !reply.error) {
          const baseGrant = resolveAccess(await store.getSettings(), { agent: simAgent, profile: reqProfile });
          nextSessionId = await clients.startSession({
            clientInfo: normalizedRpc.params?.clientInfo || { name: 'loop-inspector', version: '2.0.0' },
            clientCapabilities: normalizedRpc.params?.capabilities || (mcpApps
              ? { extensions: { [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } } }
              : {}),
            protocolVersion: reply.result?.protocolVersion || '2025-11-25',
            agent: simAgent,
            baseProfile: baseGrant.profile,
            project: null,
            transport: 'http',
            simulated: true,
          });
        } else if (nextSessionId) {
          await clients.touchSession(nextSessionId, { used: normalizedRpc.method === 'tools/call' });
        }

        let widgetUri = null;
        let altWidgetUri = null;
        const resolveUpstreamWidgetUri = async (namespacedTool) => {
          if (typeof namespacedTool !== 'string' || !namespacedTool.includes('__')) return null;
          const sep = namespacedTool.indexOf('__');
          const connId = namespacedTool.slice(0, sep);
          const toolName = namespacedTool.slice(sep + 2);
          const conn = await store.get(connId);
          const upstreamTool = conn?.tools?.find((t) => t.name === toolName);
          const rawUpstreamUri = upstreamTool?._meta?.ui?.resourceUri;
          if (typeof rawUpstreamUri === 'string' && rawUpstreamUri) {
            return buildUpstreamWidgetUri(conn.id, rawUpstreamUri);
          }
          return null;
        };
        if (normalizedRpc.method === 'tools/call') {
          const calledName = String(normalizedRpc.params?.name || '');
          widgetUri = toolUiMeta(calledName)?.ui?.resourceUri || null;
          if (calledName === 'loop__run' && typeof normalizedRpc.params?.arguments?.tool === 'string') {
            const upstreamUri = await resolveUpstreamWidgetUri(normalizedRpc.params.arguments.tool);
            if (upstreamUri) {
              // If the call completed cleanly (not an approval/error), prefer the upstream MCP App widget
              // while offering Loop's ui://loop/run view as an alternate toggle.
              const rawReplyText = String(reply?.result?.content?.[0]?.text || '');
              const isApprovalOrErr = Boolean(reply?.error || reply?.result?.isError || rawReplyText.includes('"approval_required"') || rawReplyText.includes('"approval_denied"'));
              if (!isApprovalOrErr) {
                altWidgetUri = widgetUri;
                widgetUri = upstreamUri;
              } else {
                altWidgetUri = upstreamUri;
              }
            }
          } else if (!widgetUri) {
            widgetUri = await resolveUpstreamWidgetUri(calledName);
          }
        } else if (normalizedRpc.method === 'resources/read') {
          const readUri = String(normalizedRpc.params?.uri || '');
          if (reply?.result?.contents?.[0]?.mimeType === MCP_APP_MIME_TYPE) {
            widgetUri = readUri;
          }
        }

        const traceEntry = await inspectorTrace.record({
          source: 'inspector',
          agentId: simAgent?.id || null,
          agentName: simAgent?.name || 'Owner (Inspector)',
          profile: reqProfile || 'all',
          sessionId: nextSessionId,
          durationMs,
          request: normalizedRpc,
          response: reply,
          vault,
        });
        if (!closed && traceEntry) broadcastSse('inspector_trace', traceEntry);

        const widgetCsp = normalizedRpc.method === 'resources/read' && reply?.result?.contents?.[0]?._meta?.ui?.csp
          ? normalizeWidgetCsp(reply.result.contents[0]._meta.ui.csp)
          : null;

        return sendJson(res, 200, {
          request: normalizedRpc,
          response: reply,
          durationMs,
          sessionId: nextSessionId,
          widgetUri,
          ...(altWidgetUri ? { altWidgetUri } : {}),
          ...(widgetCsp ? { widgetCsp } : {}),
          traceId: traceEntry.id,
        });
      }

      // Config export (G5-12: secret-safe, preserves {{vault:KEY}} placeholders, restorable)
      if (pathname === '/api/export' && method === 'GET') {
        const [settings, mcps] = await Promise.all([store.getSettings(), store.list()]);
        return sendJson(
          res,
          200,
          buildExportPayload(settings, mcps),
          { 'Content-Disposition': 'attachment; filename="loop-config.json"' },
        );
      }

      // Owner-only backup restore (G5-12: restores /api/export backups including {{vault:KEY}} refs safely)
      if (pathname === '/api/restore' && method === 'POST') {
        const body = await readJsonBody(req);
        let backup = body.backup !== undefined ? body.backup : body.json !== undefined ? body.json : body;
        if (typeof backup === 'string') {
          try {
            backup = JSON.parse(backup);
          } catch {
            return sendJson(res, 400, { error: 'Invalid backup JSON.' });
          }
        }
        if (!isPlainObject(backup)) {
          return sendJson(res, 400, { error: 'Backup payload must be a JSON object.' });
        }
        const hasConnections = Array.isArray(backup.connections);
        const hasMcpServers = isPlainObject(backup.mcpServers);
        const hasSettings = isPlainObject(backup.settings);
        if (!hasConnections && !hasMcpServers && !hasSettings) {
          return sendJson(res, 400, { error: 'Backup must include connections, mcpServers, or settings.' });
        }

        let restoredSettings = null;
        if (hasSettings) {
          const patch = {};
          if (backup.settings.defaultProfile !== undefined) patch.defaultProfile = backup.settings.defaultProfile;
          if (backup.settings.paused !== undefined) patch.paused = backup.settings.paused;
          // A yes counts only where it was given: on another server somebody else can read the reports.
          if (backup.settings.agentFeedback === false || (backup.settings.agentFeedback === true && !sharedSearch?.feedback?.shared)) {
            patch.agentFeedback = backup.settings.agentFeedback;
          }
          if (backup.settings.requireAgentToken !== undefined && (legacy || backup.settings.requireAgentToken === true)) {
            patch.requireAgentToken = backup.settings.requireAgentToken;
          }
          if (Object.keys(patch).length > 0) {
            restoredSettings = await store.updateSettings(patch, { personal });
          }
        }

        const rawItems = hasConnections
          ? backup.connections
          : hasMcpServers
            ? Object.entries(backup.mcpServers).map(([name, cfg]) => ({ ...(isPlainObject(cfg) ? cfg : {}), name }))
            : [];

        const policy = getOutboundPolicy(activePort);
        const existingList = await store.list();
        const added = [];
        const skipped = [];

        for (const item of rawItems) {
          if (!isPlainObject(item)) {
            skipped.push({ name: '(invalid)', reason: 'Invalid connection entry.' });
            continue;
          }
          const name = typeof item.name === 'string' ? item.name.trim() : '';
          if (!name) {
            skipped.push({ name: '(unnamed)', reason: 'Name is required.' });
            continue;
          }
          const transport = item.transport || item.type || (item.command && !item.url ? 'stdio' : 'http');
          if (String(transport).toLowerCase() === 'builtin') {
            skipped.push({ name, reason: 'Already exists.' });
            continue;
          }
          const isStdio = String(transport).toLowerCase() === 'stdio';
          const candidate = {
            name,
            ...(typeof item.description === 'string' ? { description: item.description } : {}),
            transport,
            ...(isStdio
              ? {
                  command: item.command,
                  args: Array.isArray(item.args) ? item.args.filter((a) => typeof a === 'string' && a !== '[REDACTED]') : [],
                  env: stripRedactedRecord(item.env),
                  ...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
                }
              : {
                  url: item.url,
                  headers: stripRedactedRecord(item.headers),
                }),
            ...(item.profiles !== undefined ? { profiles: item.profiles } : {}),
            ...(typeof item.enabled === 'boolean' ? { enabled: item.enabled } : {}),
            ...(Array.isArray(item.disabledTools) ? { disabledTools: item.disabledTools } : {}),
            ...(Array.isArray(item.pinnedTools) ? { pinnedTools: item.pinnedTools } : {}),
          };

          if (isDuplicateEntry(candidate, existingList)) {
            skipped.push({ name, reason: 'Already exists.' });
            continue;
          }

          try {
            const { entry } = await admitConnectionWrite({
              actor: { kind: 'owner' },
              policy,
              existing: null,
              input: candidate,
              allowVaultRefs: true,
              store,
              vault,
            });
            existingList.push(entry);
            added.push(entry);
          } catch (err) {
            if (isRawInternalError(err)) throw err;
            skipped.push({ name, reason: err?.message || 'Could not restore connection.' });
          }
        }

        const skipSync = body.skipSync === true;
        if (!skipSync) {
          const syncIds = added.filter((e) => e.enabled !== false).map((e) => e.id);
          if (syncIds.length) track(syncInBackground(pool, syncIds));
        }
        if (added.length > 0 || restoredSettings) {
          broadcastMcpNotification('notifications/tools/list_changed');
        }

        return sendJson(res, 200, {
          settings: restoredSettings,
          added: added.map(sanitizeMcp),
          skipped,
        });
      }

      if (method !== 'GET' && method !== 'HEAD') {
        return sendJson(res, 405, { error: 'Method not allowed.' });
      }

      return sendJson(res, 404, { error: 'Not found.' });
    } catch (err) {
      if (res.writableEnded) return;
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        return;
      }
      const { status, message, extraHeaders } = formatErrorResponse(err);
      sendJson(res, status, { error: message }, extraHeaders);
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    runTokens.close();
    await localConnect?.close().catch(() => {});
    unsubscribeApprovals();
    unsubscribeApprovalEvents();
    unsubscribeClients();
    unsubscribeActivity();
    unsubscribeMemory();
    if (reloadTimer) {
      clearTimeout(reloadTimer);
      reloadTimer = null;
    }
    if (syncBroadcastTimer) {
      clearTimeout(syncBroadcastTimer);
      syncBroadcastTimer = null;
    }
    if (startupSyncTimer) {
      clearTimeout(startupSyncTimer);
      startupSyncTimer = null;
    }
    if (searchReindexTimer) {
      clearTimeout(searchReindexTimer);
      searchReindexTimer = null;
    }
    if (filingTimer) {
      clearTimeout(filingTimer);
      filingTimer = null;
    }
    if (hygieneTimer) {
      clearTimeout(hygieneTimer);
      hygieneTimer = null;
    }
    if (publicWatcher) {
      publicWatcher.close();
      publicWatcher = null;
    }
    for (const client of sseClients.keys()) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    sseClients.clear();
    closeAllMcpSse();
    legacySse.closeAll();
    await approvalQueue.close().catch(() => {});
    await pool.closeAll().catch(() => {});
    await Promise.allSettled([...background]);
    await searchIndex.close().catch(() => {});
    await activity.flush().catch(() => {});
    await clients.flush().catch(() => {});
  }

  const agentOfClient = (agents, clientId) =>
    clientId ? agents.find((a) => a.enabled !== false && a.oauthClientId === clientId) || null : null;
  const agentForClient = async (clientId) => agentOfClient(await store.listAgents(), clientId);

  async function revokeOAuthAccessToken(clientId, token) {
    const agent = await store.revokeOAuthToken(clientId, hashAgentToken(token));
    if (!agent) return;
    mcpOAuth?.revokeRefreshTokens({ agentId: agent.id, clientId, workspaceId: id || null });
    await vault.delete(agentTokenVaultKey(agent.id), null, { expectedValue: token });
    activity.record({ agentId: agent.id, agentName: agent.name, method: 'oauth/revoke', target: agent.name, ok: true });
    broadcastSse('agents', { at: Date.now() });
  }

  async function renewOAuthAgentToken(clientId, { agentId = null, expectedRightsDigest = null } = {}) {
    lastUsedAt = Date.now();
    const token = generateAgentToken();
    const agent = await store.renewOAuthAgentToken({
      agentId,
      clientId,
      expectedRightsDigest,
      tokenHash: hashAgentToken(token),
      tokenHint: tokenHint(token),
      appSignIns: (conn) => pool.signIns.list(conn),
    }, (boundId) => vault.set(agentTokenVaultKey(boundId), token, 'Loop agent token'));
    activity.record({
      agentId: agent.id,
      agentName: agent.name,
      method: 'oauth/refresh',
      target: agent.name,
      ok: true,
    });
    broadcastSse('agents', { at: Date.now() });
    return { agent, token };
  }

  async function issueOAuthAgentToken(clientName, clientId = null, options = {}) {
    lastUsedAt = Date.now();
    const cleanName = String(clientName || 'MCP Client').replace(/\s+/g, ' ').trim().slice(0, 80) || 'MCP Client';
    const cleanClientId = typeof clientId === 'string' && clientId.trim() ? clientId.trim() : null;
    const requestedProfile =
      typeof options?.profile === 'string' && !PROFILE_CONTROL_RE.test(options.profile)
        ? normalizeProfileTag(options.profile) || 'all'
        : 'all';
    const requestedAccess = options?.access && typeof options.access === 'object' ? options.access : null;
    const token = generateAgentToken();
    const loopText = /^loop[- ]?text\b/i.test(cleanName);
    const agent = await store.bindOAuthAgent({
      name: cleanName, kind: loopText ? 'imessage' : inferAgentKind(cleanName), clientId: cleanClientId,
      profile: requestedProfile, access: requestedAccess, defaultCanManage: loopText ? true : undefined,
      tokenHash: hashAgentToken(token), tokenHint: tokenHint(token),
      appSignIns: (conn) => pool.signIns.list(conn),
    }, (agentId) => vault.set(agentTokenVaultKey(agentId), token, 'Loop agent token'));
    activity.record({
      agentId: options?.byOwner ? null : agent.id,
      agentName: agent.name,
      method: 'oauth/token',
      target: agent.name,
      ok: true,
    });
    broadcastSse('agents', { at: Date.now() });
    return { agent, token };
  }

  const getProfileData = () => buildProfileRecords({ store, skillStore, memoryStore, vault });

  // What somebody who opens an agent's link sees before they add it: what the owner shared with it.
  async function agentLinkView(agent) {
    const profile = normalizeProfileTag(agent.profile) || 'all';
    const [mcps, skills, secrets, policies] = await Promise.all([
      store.list(),
      skillStore.list({ profile }).catch(() => []),
      vault.list().catch(() => []),
      policyStore.get(),
    ]);
    const picked = (list, allowed) => (Array.isArray(allowed) ? list.filter((item) => allowed.includes(item.id)) : list);
    const connections = picked(mcps.filter((m) => connectionMatchesProfile(m, profile)), agent.allowedConnections);
    return {
      name: agent.name,
      kind: agent.kind,
      picture: agent.picture,
      pictureUrl: await agentPictures.url(agent),
      connections: connections.map((m) => m.name || m.id).sort((a, b) => a.localeCompare(b)).slice(0, 2),
      connectionCount: connections.length,
      futureConnections: !Array.isArray(agent.allowedConnections),
      // The skills of the owner; Loop's own guides come with every agent.
      skillCount: picked(skills, agent.allowedSkills).filter((s) => s.namespace !== 'system').length,
      futureSkills: !Array.isArray(agent.allowedSkills),
      canManage: agent.canManage === true,
      memoryAccess: agent.memoryAccess,
      vault: secrets.filter((s) => agent.secrets.includes(s.key)).map((s) => ({
        name: /^capture_[0-9a-f]{32}$/.test(s.key) && s.description ? s.description : s.key,
        mode: vaultItemMode(policies, s),
      })),
    };
  }

  // The key for the agent that a link is for. The link itself is already used up.
  async function claimAgentLink(agentId, kind) {
    const agent = await store.getAgent(agentId);
    if (!agent || agent.enabled === false) return null;
    const issued = await issueAgentToken(store, vault, agent.id);
    if (id) sharedSearch.tokenRouter?.remember(issued.token, id);
    if (kind && kind !== agent.kind) issued.agent = (await store.updateAgent(agent.id, { kind })) || issued.agent;
    broadcastSse('agents', { at: Date.now() });
    return issued;
  }

  const shareContext = {
    store,
    vault,
    activity,
    historyStore,
    dreamStore,
    searchIndex,
    scheduleSearchReindex,
    broadcast: (type) => broadcastSse(type, { at: Date.now() }),
  };
  // What lib/people.mjs needs of this Loop.
  const peopleContext = {
    store,
    skillStore,
    pool,
    activity,
    approvalQueue,
    broadcast: shareContext.broadcast,
    // Keeps this Loop in memory while something of another Loop uses it.
    hold: async (fn) => {
      inFlight += 1;
      lastUsedAt = Date.now();
      try {
        return await fn();
      } finally {
        inFlight -= 1;
        lastUsedAt = Date.now();
      }
    },
    admit: (input) => admitConnectionWrite({
      actor: { kind: 'owner' }, policy: getOutboundPolicy(), existing: null, input, allowVaultRefs: false, store, vault,
    }),
    changed: (skills) => {
      if (closed) return;
      broadcastMcpNotification('notifications/tools/list_changed');
      scheduleSearchReindex();
      scheduleConnectionsBroadcast();
      if (skills) broadcastSse('skills', { at: Date.now() });
      broadcastSse('people', { at: Date.now() });
    },
    // Small logos for the page of an invite, where nobody is signed in to this Loop.
    logosFor: async (ids) => {
      const out = {};
      for (const connId of ids.slice(0, 12)) {
        const logo = await logos.read(connId).catch(() => null);
        if (logo && logo.buf.length <= 24 * 1024) out[connId] = `data:${logo.mime};base64,${logo.buf.toString('base64')}`;
      }
      return out;
    },
    // A call of a person's agent to a connection that this Loop lends them. The rules of this Loop apply.
    runForPerson: async ({ personId, personName, connId, toolName, args, approvalId, maxQuestions, lends, signal }) => {
      const conn = await store.get(connId);
      const name = conn?.name || 'This connection';
      if ((await store.getSettings()).paused) throw new SharedCallError('The owner paused their Loop.');
      if (!conn || !lends(conn)) throw new SharedCallError('The owner turned this connection off.');
      if (conn.authRequired) throw new SharedCallError(`The owner must sign in to ${name} again.`);
      if (!(conn.tools || []).some((t) => t.name === toolName) || !isToolEnabled(conn, toolName)) {
        throw new SharedCallError(`The owner does not lend the tool "${toolName}".`);
      }
      const out = await runLentTool({
        store, vault, pool, policyStore, approvalQueue, catStore, memoryStore, conn, toolName, args,
        person: { id: personId, name: personName },
        approvalId,
        maxQuestions,
        dashboardUrl: sharedSearch?.publicOrigin ? `${sharedSearch.publicOrigin}/` : '',
        signal,
        record: (entry) => activity.record({ agentId: `person_${personId}`, agentName: personName, ...entry }),
      });
      // What the owner switched off while the call ran: nobody gets its result.
      const now = await store.get(connId);
      if (now?.authRequired) throw new SharedCallError(`The owner must sign in to ${name} again.`);
      if (!now || !lends(now) || !isToolEnabled(now, toolName) || (await store.getSettings()).paused) {
        throw new SharedCallError('The owner turned this connection off.');
      }
      // An error text can hold the address, and the address can name the owner's own project.
      if (out.result?.isError && Array.isArray(out.result.content)) {
        const hide = addressParts(conn.url);
        const hidden = (text) => hide.reduce((left, part) => left.split(part).join('its address'), text);
        const { structuredContent: structured, ...rest } = out.result;
        out.result = {
          ...rest,
          ...(structured ? { structuredContent: JSON.parse(JSON.stringify(structured), (_key, value) => (typeof value === 'string' ? hidden(value) : value)) } : {}),
          content: out.result.content.map((part) => (typeof part?.text === 'string' ? { ...part, text: hidden(part.text) } : part)),
        };
      }
      return out;
    },
  };
  const connectContext = {
    dataDir,
    personal,
    store,
    vault,
    skillStore,
    memoryStore,
    catStore,
    pool,
    activity,
    toolSetupStore,
    localInstallStore,
    approvalQueue,
    broadcast: shareContext.broadcast,
    installAgent: (target, config) => installLoopIntoAgent(target, { ...config, home: opts.installerHome, platform: opts.installerPlatform, env: opts.installerEnv }),
  };
  const localConnect = !sharedSearch?.hosted && !personal
    ? new LoopConnectClient(connectContext, {
        fetchImpl: opts.connectFetch || fetch,
        allowLoopbackHttp: Boolean(
          opts.allowLoopbackConnect ||
          opts.port === 0 ||
          process.env.LOOP_ALLOW_INSECURE_CONNECT === '1',
        ),
        ...(opts.relayPollWaitMs !== undefined ? { relayPollWaitMs: opts.relayPollWaitMs } : {}),
        ...(opts.resolveArtifactBytes ? { resolveArtifactBytes: opts.resolveArtifactBytes } : {}),
        ...(opts.checkOsPermission ? { checkOsPermission: opts.checkOsPermission } : {}),
      })
    : null;
  if (localConnect) {
    localRelayRef = localConnect.createLocalRelayDispatcher();
    if (existsSync(path.join(dataDir, 'loop-connect.json'))) {
      localConnect.startIfLinked().catch(() => {});
    }
  }

  // loop-text, server to server, acting for one agent (lib/sms-bridge.mjs). The caller has
  // already checked the shared secret and routed the key to this workspace.
  async function handleSmsBridgeRequest(req, res, activePort, url, pathname) {
    setPort(activePort);
    inFlight += 1;
    lastUsedAt = Date.now();
    res.once('close', () => {
      inFlight -= 1;
      lastUsedAt = Date.now();
    });
    const agent = await findAgentByToken(store, extractBearerToken(req));
    if (!agent || !agent.enabled) return sendJson(res, 401, { error: 'unauthorized' });
    if (agent.toolGrants != null) return sendJson(res, 403, { error: 'This agent can only call its selected connection actions.' });
    activity.touch(agent.id);
    return handleSmsBridge({
      req,
      res,
      url,
      pathname,
      agent,
      ctx: { store, vault, approvalQueue, policyStore, activity, historyStore, ownerTimezone, dreamStore, broadcast: shareContext.broadcast },
      readJsonBody,
      sendJson,
    });
  }

  // Tier 2 local command-hook recall (Codex, Gemini CLI, etc.): receives ONLY salted word
  // hashes + optional cwd/sessionId, never raw prompt text. Works on both local and hosted Loop.
  async function handleTurnRecallRequest(req, res, activePort) {
    setPort(activePort);
    inFlight += 1;
    lastUsedAt = Date.now();
    res.once('close', () => {
      inFlight -= 1;
      lastUsedAt = Date.now();
    });
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' });
    }
    if (req.headers?.origin !== undefined || req.headers?.['sec-fetch-site'] !== undefined) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    const token = extractBearerToken(req);
    const agent = (await findAgentByRecallToken(store, token)) || (await findAgentByToken(store, token));
    if (!agent) return sendJson(res, 401, { error: 'unauthorized' });
    if (!agent.enabled) return sendJson(res, 403, { error: 'Agent is disabled.' });
    if (agent.toolGrants != null) return sendJson(res, 200, {});
    const settings = await store.getSettings();
    if (!isTurnRecallEnabled(agent, settings)) return sendJson(res, 200, {});

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON.' });
    }
    const sketch = parseSketch(body);
    if (!sketch) return sendJson(res, 200, {});

    const baseProfile = agent.profile || 'all';
    let selectedProject = null;
    if (baseProfile === 'all') {
      const localFolders = projectFolders && isLocalDeviceRequest(req, activePort) ? projectFolders : null;
      if (localFolders && typeof body.cwd === 'string' && body.cwd.trim()) {
        selectedProject = await localFolders.matchWorkingDirectory(body.cwd.trim()).catch(() => null);
      }
      if (!selectedProject) {
        selectedProject = await clients.activeProjectForAgent(agent.id).catch(() => null);
      }
    }
    const hookEventName =
      typeof body.eventName === 'string' && ALLOWED_RECALL_EVENTS.has(body.eventName)
        ? body.eventName
        : 'UserPromptSubmit';
    const sessionKey =
      typeof body.sessionId === 'string' && body.sessionId.trim()
        ? `${agent.id}:${body.sessionId.trim().slice(0, 128)}`
        : null;

    const result = await recallFromSketch(sketch, {
      baseProfile,
      selectedProject,
      memoryStore,
      hookEventName,
      sessionKey,
      onRecalled: ({ count, scope }) =>
        activity.record({
          agentId: agent.id,
          agentName: agent.name,
          profile: scope,
          method: 'memory/recall',
          target: `${count} ${count === 1 ? 'note' : 'notes'} (${scope})`,
          ok: true,
        }),
    }).catch(() => ({}));
    return sendJson(res, 200, result);
  }

  // Quick-save Bearer API (/api/saved*, /api/files*) for Apple Shortcuts and CLI tools (no browser Origin).
  async function handleQuickSaveBearerRequest(req, res, activePort, url, pathname) {
    setPort(activePort);
    inFlight += 1;
    lastUsedAt = Date.now();
    res.once('close', () => {
      inFlight -= 1;
      lastUsedAt = Date.now();
    });
    if (req.headers?.origin !== undefined || req.headers?.['sec-fetch-site'] !== undefined) {
      return sendJson(res, 403, { error: 'Browser pages cannot call Bearer token endpoints directly.' });
    }
    const agent = await findAgentByToken(store, extractBearerToken(req));
    if (!agent || !agent.enabled) return sendJson(res, 401, { error: 'Invalid or disabled Loop token.' });
    if (agent.toolGrants != null) return sendJson(res, 403, { error: 'This agent can only call its selected connection actions.' });
    activity.touch(agent.id);
    const handled = await handleSavedAndToolsRoute(req, res, {
      pathname,
      url,
      savedStore,
      scheduleStore,
      fileStore,
      taskStore,
      notificationStore,
      ownerTimezone,
      searchIndex,
      outboundPolicy: getOutboundPolicy(activePort),
      fetchImpl: opts.builtinFetch || null,
      onSavedEnrich: enqueueSavedEnrich,
      onScheduleRun: runScheduleById,
      deliverSms,
      broadcast: (type) => broadcastSse(type, { at: Date.now() }),
      activity,
      agent,
    });
    if (!handled) return sendJson(res, 404, { error: 'Not found.' });
  }

  async function handleInboundWebhookRequest(req, res, activePort, webhookId) {
    setPort(activePort);
    inFlight += 1;
    lastUsedAt = Date.now();
    res.once('close', () => {
      inFlight -= 1;
      lastUsedAt = Date.now();
    });
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' });
    }
    const chunks = [];
    let totalBytes = 0;
    const MAX_HOOK_BYTES = 1024 * 1024;
    for await (const chunk of req) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_HOOK_BYTES) {
        return sendJson(res, 413, { error: 'Webhook payload exceeds 1 MiB limit.' });
      }
      chunks.push(chunk);
    }
    const rawBytes = Buffer.concat(chunks);
    const sig = String(req.headers['x-loop-signature-256'] || '');
    const eventId = String(req.headers['x-loop-event-id'] || req.headers['x-delivery-id'] || '');
    try {
      const outcome = await webhookStore.receive({
        webhookId,
        rawBytes,
        signature: sig,
        eventId,
        handler: dispatchWebhookDelivery,
      });
      return sendJson(res, outcome.status === 'ok' ? 200 : 202, { ok: outcome.status === 'ok', ...outcome });
    } catch (err) {
      return sendJson(res, err?.status || 400, {
        error: err?.message || 'Webhook rejected.',
        ...(err?.code ? { code: err.code } : {}),
      });
    }
  }

  async function authenticateBridgeCaller(req, url, origin, pathname) {
    const wwwAuth = mcpOAuth ? { 'WWW-Authenticate': mcpOAuth.wwwAuthenticateHeader(origin, pathname) } : {};
    const token = extractBearerToken(req);
    let agent = null;
    if (token) {
      agent = await findAgentByToken(store, token);
      if (!agent) return { ok: false, status: 401, error: 'Unknown Loop agent token.', headers: wwwAuth };
      if (!agent.enabled) return { ok: false, status: 403, error: `Agent "${agent.name}" is turned off in Loop.`, headers: {} };
      activity.touch(agent.id);
    } else if (!legacy || (await store.getSettings()).requireAgentToken) {
      return { ok: false, status: 401, error: mcpUnauthorizedMessage(origin), headers: wwwAuth };
    }
    const queryProfile = url.searchParams.get('profile') || null;
    const queryRoleRaw = url.searchParams.get('role');
    const queryRole = typeof queryRoleRaw === 'string' && queryRoleRaw.trim()
      ? queryRoleRaw.trim().toLowerCase().slice(0, 64)
      : null;
    const rawActor =
      typeof req.headers['x-loop-actor'] === 'string' && req.headers['x-loop-actor'].trim()
        ? req.headers['x-loop-actor'].trim()
        : null;
    if (queryRole) {
      const agentSet = agent?.accessSet ? String(agent.accessSet).toLowerCase() : null;
      if (agentSet && agentSet !== 'everything' && agentSet !== queryRole) {
        return { ok: false, status: 403, error: 'Role cannot widen an agent access set.', headers: {} };
      }
      const curSettings = await store.getSettings();
      if (!resolveAccessSetRecord(queryRole, curSettings?.accessSets)) {
        return { ok: false, status: 400, error: `Unknown role "${queryRole}".`, headers: {} };
      }
    }
    return { ok: true, agent, profile: queryProfile, role: queryRole, actor: rawActor };
  }

  function buildBridgeMcpOpts({ activePort, origin, agent, profile, initialProject = null, ownerSession = false, role, actor, sessionId = null, signal = null }) {
    return {
      serverVersion: sharedSearch?.serverVersion || currentLoopVersion(path.dirname(fileURLToPath(import.meta.url))),
      hostedExecutor: sharedSearch?.hosted === true,
      profile,
      initialProject,
      ownerSession: Boolean(ownerSession),
      role,
      actor,
      agent,
      ...(agent && projectFolders && !sharedSearch?.hosted
        ? { resolveProjectFolder: (projectId) => projectFolders.resolve(projectId), projectFolders }
        : {}),
      executionDevice: agent?.oauthClientId?.match(/^paired:(dev_[a-f0-9]{16}):/)?.[1] || null,
      clientInfo: agent ? { name: agent.name } : { name: 'REST/SSE Client' },
      sessionId,
      activity,
      skillStore,
      memoryStore,
      taskStore,
      savedStore,
      scheduleStore,
      fileStore,
      historyStore,
      dreamStore,
      ownerTimezone,
      onSavedEnrich: enqueueSavedEnrich,
      onScheduleRun: runScheduleById,
      broadcast: (type, data = {}) => { if (!closed) broadcastSse(type, { at: Date.now(), ...data }); },
      catStore,
      categoryRequests,
      policyStore,
      approvalQueue,
      searchIndex,
      memoryVerdicts,
      shareStore: sharedSearch?.shares || null,
      library,
      agentHandoffs: sharedSearch?.agentHandoffs || null,
      workspaceId: id || null,
      clipboardWriter: opts.clipboardWriter || null,
      onNeedSearchIndex: scheduleSearchReindex,
      fileCategoriesNow,
      personal,
      loopPort: activePort,
      loopStdioPath: stdioPath,
      outboundPolicy: getOutboundPolicy(activePort),
      dashboardUrl: `${origin}/`,
      signal,
      onTaskCompleted: async (task, meta) => {
        await sharedSearch?.onTaskCompleted?.(task, {
          workspaceKey: id || 'local',
          actorName: meta?.access?.agent?.name || 'Agent',
        });
      },
      onCatalogMutation: (ev) => {
        notifyCatalogChange(ev);
        scheduleSearchReindex();
        scheduleConnectionsBroadcast();
      },
    };
  }

  async function runBridgeRpc(msg, bridgeOpts) {
    if (isPlainObject(msg) && (msg.method === 'tools/list' || msg.method === 'tools/call')) {
      const { paused } = await store.getSettings();
      if (paused) {
        if (msg.id === undefined) return null;
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: msg.method === 'tools/list'
            ? { tools: [] }
            : { content: [{ type: 'text', text: 'Loop is paused. Turn it back on from the Loop dashboard (Home).' }], isError: true },
        };
      }
    }
    return handleMcpRequest(store, vault, pool, msg, bridgeOpts);
  }

  // Legacy MCP 2024-11-05 HTTP+SSE transport (GET /sse + POST /messages?sessionId=...).
  async function handleLegacySseRequest(req, res, activePort, url, pathname, { isMessages = false, messagePath = '/messages' } = {}) {
    setPort(activePort);
    inFlight += 1;
    lastUsedAt = Date.now();
    res.once('close', () => {
      inFlight -= 1;
      lastUsedAt = Date.now();
    });
    const origin = resolveLoopPublicOrigin(req, activePort);
    const auth = await authenticateBridgeCaller(req, url, origin, pathname);
    if (!auth.ok) return sendJson(res, auth.status, { error: auth.error }, auth.headers);
    sweepIfDue();

    if (!isMessages) {
      if (req.method !== 'GET') {
        return sendJson(res, 405, { error: 'Use GET to open the MCP SSE stream.' }, { Allow: 'GET' });
      }
      legacySse.openStream(req, res, {
        agentId: auth.agent?.id ?? null,
        messagePath,
        profile: auth.profile,
        role: auth.role,
        actor: auth.actor,
      });
      return;
    }

    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Use POST to send MCP messages.' }, { Allow: 'POST' });
    }
    const streamId = url.searchParams.get('sessionId') || '';
    const stream = legacySse.getStream(streamId, auth.agent?.id ?? null);
    if (!stream) {
      return sendJson(res, 404, { error: 'Unknown or closed SSE session.' });
    }
    let msg;
    try {
      msg = await readJsonBody(req, { maxBytes: MAX_JSON_BODY_BYTES });
    } catch (err) {
      if (err?.code === 'BODY_TOO_LARGE') return sendJson(res, 413, { error: err.publicMessage }, { Connection: 'close' });
      return sendJson(res, 400, { error: 'Invalid JSON.' });
    }
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const bridgeOpts = buildBridgeMcpOpts({
      activePort,
      origin,
      agent: auth.agent,
      profile: auth.profile || stream.profile,
      role: auth.role || stream.role,
      actor: auth.actor || stream.actor,
      sessionId: stream.sessionId,
      signal: ac.signal,
    });
    const reply = await runBridgeRpc(msg, bridgeOpts);
    if (reply !== null) {
      legacySse.pushMessage(streamId, auth.agent?.id ?? null, reply);
    }
    res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ accepted: true }));
  }

  // Thin Bearer-authenticated REST + OpenAPI 3.1 bridge (/api/v1/tools, /api/v1/tools/:name/call, /api/v1/openapi.json).
  async function handleRestApiRequest(req, res, activePort, url, pathname, { subpath, basePath }) {
    setPort(activePort);
    inFlight += 1;
    lastUsedAt = Date.now();
    res.once('close', () => {
      inFlight -= 1;
      lastUsedAt = Date.now();
    });
    const origin = resolveLoopPublicOrigin(req, activePort);
    const auth = await authenticateBridgeCaller(req, url, origin, pathname);
    if (!auth.ok) return sendJson(res, auth.status, { error: auth.error }, auth.headers);
    sweepIfDue();
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const bridgeOpts = buildBridgeMcpOpts({
      activePort,
      origin,
      agent: auth.agent,
      profile: auth.profile,
      role: auth.role,
      actor: auth.actor,
      signal: ac.signal,
    });
    try {
      return await handleRestBridgeRequest(req, res, {
        subpath,
        origin,
        basePath,
        serverVersion: bridgeOpts.serverVersion,
        runMcp: (rpcMsg) => runBridgeRpc(rpcMsg, bridgeOpts),
      });
    } catch (err) {
      return sendJson(res, err?.status || 500, { error: err?.message || 'REST bridge error.' });
    }
  }

  return {
    handle,
    handleSmsBridgeRequest,
    handleTurnRecallRequest,
    handleQuickSaveBearerRequest,
    handleInboundWebhookRequest,
    handleLegacySseRequest,
    handleRestApiRequest,
    close,
    owner,
    id,
    issueOAuthAgentToken,
    renewOAuthAgentToken,
    agentLinkView,
    claimAgentLink,
    agentForClient,
    validateOAuthToolGrants: (grants, profile) =>
      store.validateOAuthToolGrants(grants, profile, null, { appSignIns: (conn) => pool.signIns.list(conn) }),
    revokeOAuthAccessToken,
    getProfileData,
    isIdle,
    setPort,
    shareContext,
    peopleContext,
    activity,
    broadcast: broadcastSse,
    connectContext,
    localConnect,
    savedStore,
    scheduleStore,
    fileStore,
    notificationStore,
    tickSchedules: tickWorkspaceSchedules,
    historyStore,
    dreamStore,
  };
}

// Clerk keeps a first-party "__client_uat" cookie on the app domain; a non-zero value means
// someone is signed in. Signed-out visitors to "/" get the landing page instead of the app.
function hasClerkSessionCookie(req) {
  const raw = String(req.headers?.cookie || '');
  for (const part of raw.split(';')) {
    const [k, v] = part.trim().split('=');
    if (/^__client_uat(?:_[A-Za-z0-9-]+)?$/.test(k || '') && v && v !== '0') return true;
  }
  return false;
}

function personalizeInviteHtml(html, inviterName) {
  const safeTitle = `${escapeHtml(inviterName)} invited you to Loop`;
  let out = html.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${safeTitle}</title>`);
  out = out.replace(
    /<meta\b(?=[^>]*\bproperty=["']og:title["'])[^>]*>/i,
    () => `<meta property="og:title" content="${safeTitle}">`,
  );
  out = out.replace(
    /<meta\b(?=[^>]*\bname=["']twitter:title["'])[^>]*>/i,
    () => `<meta name="twitter:title" content="${safeTitle}">`,
  );
  return out;
}

function deriveInviteIdentity(identity, isLocal) {
  if (!identity) {
    return {
      inviterName: isLocal ? 'Loop user' : 'A friend',
      preferredSlug: '',
    };
  }
  const firstName = typeof identity.firstName === 'string' ? identity.firstName.trim()
    : typeof identity.first_name === 'string' ? identity.first_name.trim()
    : '';
  const lastName = typeof identity.lastName === 'string' ? identity.lastName.trim()
    : typeof identity.last_name === 'string' ? identity.last_name.trim()
    : '';
  const fullName = typeof identity.name === 'string' ? identity.name.trim()
    : typeof identity.fullName === 'string' ? identity.fullName.trim()
    : typeof identity.full_name === 'string' ? identity.full_name.trim()
    : [firstName, lastName].filter(Boolean).join(' ').trim();
  const email = typeof identity.email === 'string' ? identity.email.trim() : '';
  const emailPrefix = email.includes('@') ? email.split('@')[0].trim() : '';
  const username = typeof identity.username === 'string' ? identity.username.trim() : '';

  const inviterName = firstName || fullName || username || emailPrefix || (isLocal ? 'Loop user' : 'A friend');
  const preferredSlug = fullName || username || emailPrefix || firstName || '';
  return { inviterName, preferredSlug };
}

async function servePublic(req, res, pathname, clerkApp, { transformHtml = null } = {}) {
  if (!['GET','HEAD'].includes(req.method)) return sendJson(res, 405, { error: 'Method not allowed.' });
  const full = path.resolve(publicDir, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  if (!full.startsWith(publicDir + path.sep)) return sendJson(res, 403, { error: 'Forbidden.' });
  const ext = path.extname(full);
  let content;
  try {
    content = await readFile(full);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'EISDIR' || err?.code === 'ENOTDIR') {
      return sendJson(res, 404, { error: 'Not found.' });
    }
    throw err;
  }
  if (ext === '.html' && typeof transformHtml === 'function') {
    content = Buffer.from(transformHtml(content.toString('utf8')), 'utf8');
  }
  if (ext === '.html' && clerkApp?.frontendApi) {
    const api = new URL(clerkApp.frontendApi).origin;
    const csp = `default-src 'self'; script-src 'self' ${api} https://challenges.cloudflare.com https://*.protect.clerk.com; style-src 'self' 'unsafe-inline'; connect-src 'self' ${api} https://*.protect.clerk.com:* https://clerk-telemetry.com; img-src 'self' data: blob: https://img.clerk.com ${api}; frame-src 'self' ${api} https://challenges.cloudflare.com https://*.protect.clerk.com; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' ${api}`;
    content = Buffer.from(content.toString().replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, ''));
    res.setHeader('Content-Security-Policy', csp);
  }
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? '' : content);
}

export async function startServer(options = {}) {
  const opts = typeof options === 'number' ? { port: options } : options || {};
  const requestedPort = parseLoopPort(opts.port ?? process.env.LOOP_HUB_PORT, {
    fallback: 8799,
    allowZero: opts.port === 0,
  });
  validateAllowedHosts();
  const hosted = opts.hosted !== undefined
    ? Boolean(opts.hosted)
    : (process.env.LOOP_HOSTED === '1' || Boolean(process.env.LOOP_HUB_ALLOWED_HOSTS));
  // Local installs run standalone on 127.0.0.1 with OwnerAuth (no Clerk or Loop Cloud connection
  // required). Clerk is used on hosted deployments (`LOOP_HOSTED=1`) or when explicitly requested.
  const authMode = opts.authMode ?? process.env.LOOP_AUTH_MODE;
  const explicitLocal = authMode === 'local' || authMode === 'local-test';
  const explicitClerk = Boolean(opts.clerkApp) || authMode === 'clerk';
  const legacy = explicitLocal || (!hosted && !explicitClerk);
  let clerkApp = null;
  if (!legacy) {
    try { clerkApp = opts.clerkApp || loadClerkApp(); }
    catch (err) {
      if (err.code !== 'CLERK_APP_NOT_CONFIGURED') throw err;
      console.warn('Loop sign-in is unavailable: configure the app publishable key on this server.');
      clerkApp = { frontendApi: null, publishableKey: null, verifyRequest: async () => null };
    }
  }
  const dataDir = opts.dataDir || defaultDataDir();
  const billing = opts.billing || new BillingStore(dataDir, { hosted, env: opts.billingEnv || process.env, fetchImpl: opts.billingFetch || fetch });
  const smsAgentConfig = loadSmsAgentConfig(opts.smsAgentEnv || process.env);
  const smsAgentClient =
    opts.smsAgentClient || new SmsAgentClient(smsAgentConfig, { fetchImpl: opts.smsAgentFetch || fetch });
  const searchEnv = opts.searchEnv || process.env;
  const embedConfig = resolveEmbeddingConfig(searchEnv, { dataDir, personal: hosted });
  const sharedEmbedder =
    opts.embedder ||
    createEmbedder(embedConfig, {
      fetchImpl: opts.embeddingFetch || fetch,
    });
  const rawMinTools = searchEnv?.LOOP_SEMANTIC_MIN_TOOLS;
  const parsedMinTools =
    rawMinTools !== undefined && /^\d+$/.test(String(rawMinTools).trim()) ? Number(String(rawMinTools).trim()) : undefined;
  // Auto-threshold applies ONLY to local on-device models in 'auto' mode (so a small local hub pays 0 MB
  // extra RAM until its tools, Connections, Skills or memories reach a limit). Shared hosted HTTP
  // embedders cost 0 MB user RAM, so Cloud gets semantic from tool #1!
  const autoSemanticThreshold =
    opts.autoSemanticThreshold !== undefined
      ? Boolean(opts.autoSemanticThreshold)
      : !opts.embedder &&
        embedConfig.requestedProvider === 'auto' &&
        embedConfig.provider === 'local' &&
        parsedMinTools !== 0;
  const shares = new ShareStore(dataDir);
  const people = hosted && !legacy ? new PeopleStore(dataDir) : null;
  const inviteStore = opts.inviteStore || new InviteStore(dataDir, {
    ...(opts.inviteQuota !== undefined ? { quota: opts.inviteQuota } : {}),
    env: opts.inviteEnv || process.env,
  });
  const sharedReranker =
    opts.reranker !== undefined ? opts.reranker : createReranker(resolveRerankConfig(searchEnv, { dataDir }));
  const loopConnectServer = new LoopConnectServer(dataDir, {
    ...(opts.relayCallTimeoutMs !== undefined ? { relayCallTimeoutMs: opts.relayCallTimeoutMs } : {}),
    ...(opts.relayPollHoldMs !== undefined ? { pollHoldMs: opts.relayPollHoldMs } : {}),
    ...(opts.tunnelFetch ? { tunnelFetch: opts.tunnelFetch } : {}),
    allowLoopbackTunnel: Boolean(opts.allowLoopbackConnect || opts.port === 0 || process.env.LOOP_ALLOW_INSECURE_CONNECT === '1'),
  });
  const agentHandoffs = new AgentHandoffStore({
    file: path.join(dataDir, 'agent-links.json'),
    ...(opts.agentHandoffTtlMs !== undefined ? { ttlMs: opts.agentHandoffTtlMs } : {}),
    ...(opts.agentLinkTtlMs !== undefined ? { linkTtlMs: opts.agentLinkTtlMs } : {}),
  });
  const scheduleWakeIndex = new ScheduleWakeIndex(dataDir);
  const sharedSearch = {
    scheduleWakeIndex,
    feedback: {
      store: new FeedbackStore(dataDir, { build: loopBuild(here) }),
      // Other people can have a Loop on this server, so somebody else reads what their agents report.
      shared: opts.sharedServer ?? (hosted && !legacy && Boolean(process.env.LOOP_PUBLIC_ORIGIN || process.env.LOOP_HUB_ALLOWED_HOSTS)),
    },
    embedder: sharedEmbedder,
    reranker: sharedReranker,
    hosted,
    specialistHosted: opts.hosted !== undefined
      ? Boolean(opts.hosted)
      : (process.env.LOOP_HOSTED === '1' && Boolean(
          process.env.LOOP_PUBLIC_ORIGIN ||
          process.env.LOOP_HUB_ALLOWED_HOSTS ||
          process.env.LOOP_TRUST_PROXY === '1' ||
          process.env.NODE_ENV === 'production'
        )),
    shares,
    people,
    agentHandoffs,
    loopConnectServer,
    autoSemanticThreshold,
    ...(parsedMinTools !== undefined ? { semanticMinTools: parsedMinTools } : {}),
    sendOwnerSms: async ({ workspaceKey = 'local', message, idempotencyKey } = {}) => {
      if (!smsAgentClient.enabled || closing || !message) return { sent: false, reason: 'Loop Text not connected' };
      const resNudge = await smsAgentClient.nudge({
        workspaceId: workspaceKey,
        message: String(message).slice(0, 800),
        idempotencyKey,
      }).catch((err) => ({ sent: false, reason: err?.message || 'Loop Text error' }));
      return { sent: Boolean(resNudge?.sent || resNudge?.ok), ...(resNudge?.reason ? { reason: resNudge.reason } : {}) };
    },
    onTaskCompleted: async (task, { workspaceKey = 'local', actorName = 'Agent' } = {}) => {
      if (!smsAgentClient.enabled || closing || !task) return;
      const who = task.assignedTo || actorName || 'Your agent';
      const verb = task.status === 'cancelled' ? 'cancelled' : 'finished';
      const detail = String(task.result || task.notes || '').replace(/\s+/g, ' ').trim().slice(0, 220);
      const message = detail
        ? `${who} ${verb} "${task.title}": ${detail}`
        : `${who} ${verb} "${task.title}".`;
      await smsAgentClient.nudge({
        workspaceId: workspaceKey,
        message,
        idempotencyKey: `task-done:${task.id}:${task.revision}`,
      }).catch(() => {});
    },
  };
  const appRootDir = path.dirname(fileURLToPath(import.meta.url));
  const serverVersion = currentLoopVersion(appRootDir);
  const serverReleaseInfo = parseReleaseFile(appRootDir);
  const releasesDir = opts.releasesDir ? path.resolve(opts.releasesDir) : resolveReleasesDir(appRootDir);
  sharedSearch.serverVersion = serverVersion;

  const mcpOAuth = new McpOAuthServer(dataDir, {
    hostedRoot: hosted && !legacy,
    ...(opts.refreshTtlMs !== undefined ? { refreshTtlMs: opts.refreshTtlMs } : {}),
    ...(opts.refreshGraceMs !== undefined ? { refreshGraceMs: opts.refreshGraceMs } : {}),
    ...(opts.maxRegistrationsPerIp !== undefined ? { maxRegistrationsPerIp: opts.maxRegistrationsPerIp } : {}),
    ...(opts.maxAuthorizePerIp !== undefined ? { maxAuthorizePerIp: opts.maxAuthorizePerIp } : {}),
    ...(opts.allowLoopbackCimd !== undefined ? { allowLoopbackCimd: opts.allowLoopbackCimd } : {}),
    ...(opts.cimdFetch !== undefined ? { cimdFetch: opts.cimdFetch } : {}),
  });
  const inFlightRefreshes = new Map();
  const deviceAuth = new DeviceAuthServer({
    hostedRoot: hosted && !legacy,
    ...(opts.devicePollSpacingMs !== undefined ? { minPollSpacingMs: opts.devicePollSpacingMs } : {}),
    ...(opts.deviceTtlMs !== undefined ? { ttlMs: opts.deviceTtlMs } : {}),
  });
  let connectBundleCache = null;
  const buildConnectCliBundle = async (origin) => {
    if (!connectBundleCache) {
      const rootDir = path.dirname(fileURLToPath(import.meta.url));
      const [installerSrc, cliSrc] = await Promise.all([
        readFile(path.join(rootDir, 'lib', 'agent-installer.mjs'), 'utf8'),
        readFile(path.join(rootDir, 'scripts', 'connect-agents.mjs'), 'utf8'),
      ]);
      const inlinedInstaller = installerSrc
        .replace(/^import\s+os\s+from\s+'node:os';\n/m, '')
        .replace(/^export\s+/gm, '');
      const strippedCli = cliSrc
        .replace(/^#!.*\n/, '')
        .replace(/\/\/ __INLINE_INSTALLER_START__[\s\S]*?\/\/ __INLINE_INSTALLER_END__/, inlinedInstaller)
        .replace(/^export\s+/gm, '');
      connectBundleCache = `#!/usr/bin/env node\n${strippedCli}`;
    }
    return connectBundleCache.replaceAll('__DEFAULT_LOOP_URL__', String(origin || '').replace(/['"\\]/g, ''));
  };
  let boundPort = null;
  let closing = false;
  const workspaces = new AppWorkspaces(
    dataDir,
    (dir, id) => createWorkspace(opts, dir, id, legacy, mcpOAuth, () => boundPort, sharedSearch),
    { idleMs: opts.workspaceIdleMs },
  );
  const tokenRouter = new TokenRouter(workspaces.usersDir);
  sharedSearch.tokenRouter = tokenRouter;
  sharedSearch.openWorkspace = (wsId) => workspaces.personal(wsId, false);
  // Has this account Loop Connect? Without a check of plans, everybody has.
  sharedSearch.hasPlan = async (wsId) => !billing?.enabled || Boolean(wsId && (await checkHostedLoopConnect(wsId)).active);
  const checkHostedLoopConnect = async (workspaceKey) => {
    const wsKey = workspaceKey || 'local';
    const invited = await inviteStore.isInvited(wsKey);
    const billingStatus = billing ? await billing.getWorkspaceStatus(wsKey, { invited }) : null;
    const active = hasLoopConnectAccess(billingStatus, { invited });
    const maxDevices = billingStatus?.entitlements?.limits?.maxDevices;
    return { invited, billingStatus, active, maxDevices };
  };
  const resolveConnectWorkspace = async (workspaceKey) => {
    const wsKey = workspaceKey || 'local';
    const targetWs = wsKey === 'local' ? workspaces.local : workspaces.personal(wsKey, false);
    if (!targetWs?.connectContext) return null;
    const access = await checkHostedLoopConnect(wsKey);
    return {
      wsCtx: targetWs.connectContext,
      loopConnectActive: access.active,
      maxDevices: access.maxDevices,
    };
  };
  const retiredAuth = new Set(['/api/auth/setup', '/api/auth/login', '/api/auth/password', '/api/auth/logout']);
  const CONSENT_NOT_FOUND_MSG = 'This sign-in request has expired. Click Authenticate again in your agent.';
  const handleOAuthConsentApi = async (req, res, pathname, workspace, identity, device) => {
    const match = pathname.match(/^\/api\/oauth\/requests\/([^/]+)(?:\/(approve|deny|status))?$/);
    if (!match) return false;
    let txId;
    try { txId = decodeURIComponent(match[1]); }
    catch { sendJson(res, 400, { error: 'Invalid authorization request id.' }); return true; }
    const action = match[2] || '';
    if (action === 'status' && req.method === 'GET') {
      const handoff = mcpOAuth.getHandoffStatus(txId, { workspaceId: workspace.id });
      if (!handoff) { sendJson(res, 404, { error: CONSENT_NOT_FOUND_MSG }); return true; }
      sendJson(res, 200, handoff);
      return true;
    }
    if (!action && req.method === 'GET') {
      const localAvailable =
        !legacy && device && !workspaces.claimed && !workspaces.claimCorrupt && await workspaces.local.owner.isSetUp();
      const pending = mcpOAuth.getPending(txId, {
        workspaceId: workspace.id,
        allowLocalRestore: localAvailable,
      });
      if (!pending) { sendJson(res, 404, { error: CONSENT_NOT_FOUND_MSG }); return true; }
      const targetWs = pending.targetWorkspaceId;
      const needsLocalRestore = targetWs === null && workspace.id !== null && localAvailable;
      const canApprove = (targetWs === null && (workspace.id === null || (hosted && !legacy && Boolean(workspace.id)))) || (targetWs !== null && workspace.id === targetWs);
      const profileData = typeof workspace.getProfileData === 'function'
        ? await workspace.getProfileData().catch(() => ({ profiles: ['all'], profileRecords: [] }))
        : { profiles: ['all'], profileRecords: [] };
      // An app that signs in again keeps its agent: the screen starts from what that agent may do now.
      const agentNow = canApprove ? await workspace.agentForClient?.(mcpOAuth.pendingClientId(txId)) : null;
      const [wsSettings, wsConns, wsAgents] = canApprove && workspace.store
        ? await Promise.all([
            workspace.store.getSettings().catch(() => ({})),
            workspace.store.list({ clone: false }).catch(() => []),
            workspace.store.listAgents().catch(() => []),
          ])
        : [{}, [], []];
      const accessSets = listAllAccessSets(wsSettings.accessSets, wsAgents);
      const multiAccountServices = buildServicesView({
        connections: wsConns,
        agents: wsAgents,
        catalog: VERIFIED_CATALOG,
      }).services.filter((s) => s.accounts.length > 1);
      sendJson(res, 200, {
        request: pending,
        ...(agentNow ? {
          agent: { canManage: agentNow.canManage, memoryAccess: agentNow.memoryAccess },
          agentAccess: {
            profile: agentNow.profile || 'all',
            ...(agentNow.toolGrants ? { toolGrants: agentNow.toolGrants } : {}),
            allowedConnections: Array.isArray(agentNow.allowedConnections) ? [...agentNow.allowedConnections] : null,
            allowedSkills: Array.isArray(agentNow.allowedSkills) ? [...agentNow.allowedSkills] : null,
            secrets: Array.isArray(agentNow.secrets) ? [...agentNow.secrets] : [],
            accessSet: agentNow.accessSet || null,
            approvalMode: agentNow.approvalMode || null,
            accountChoice: agentNow.accountChoice || {},
          },
        } : {}),
        accessSets,
        services: multiAccountServices,
        workspace: workspace.id ? 'personal' : 'local',
        workspaceId: workspace.id,
        canApprove,
        needsLocalRestore,
        localAvailable,
        profiles: profileData.profiles,
        profileRecords: profileData.profileRecords,
      });
      return true;
    }
    if (action === 'approve' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        let profile = 'all';
        if (body?.profile !== undefined && body.profile !== null && body.profile !== '') {
          if (typeof body.profile !== 'string' || PROFILE_CONTROL_RE.test(body.profile)) {
            sendJson(res, 400, { error: 'Profile must be a valid string without control characters.' });
            return true;
          }
          profile = normalizeProfileTag(body.profile) || 'all';
        }
        let access = null;
        const rawAccess = body?.access && typeof body.access === 'object' && !Array.isArray(body.access) ? body.access : body;
        if (rawAccess && typeof rawAccess === 'object') {
          const nextAccess = {};
          if (rawAccess.allowedConnections !== undefined) nextAccess.allowedConnections = rawAccess.allowedConnections;
          if (rawAccess.allowedSkills !== undefined) nextAccess.allowedSkills = rawAccess.allowedSkills;
          if (rawAccess.toolGrants !== undefined) {
            if (!mcpOAuth.getPending(txId, { workspaceId: workspace.id })) {
              sendJson(res, 404, { error: CONSENT_NOT_FOUND_MSG }); return true;
            }
            await workspace.validateOAuthToolGrants(rawAccess.toolGrants, profile);
            nextAccess.toolGrants = rawAccess.toolGrants;
          }
          if (rawAccess.toolMode !== undefined) nextAccess.toolMode = rawAccess.toolMode;
          if (rawAccess.memoryAccess !== undefined) nextAccess.memoryAccess = rawAccess.memoryAccess;
          if (rawAccess.canManage !== undefined) nextAccess.canManage = rawAccess.canManage;
          if (rawAccess.secrets !== undefined) nextAccess.secrets = rawAccess.secrets;
          if (rawAccess.accessSet !== undefined) nextAccess.accessSet = rawAccess.accessSet;
          if (rawAccess.approvalMode !== undefined) nextAccess.approvalMode = rawAccess.approvalMode;
          if (rawAccess.accountChoice !== undefined) nextAccess.accountChoice = rawAccess.accountChoice;
          if (Object.keys(nextAccess).length > 0) access = nextAccess;
        }
        const result = mcpOAuth.approvePending(txId, {
          workspaceId: workspace.id,
          userId: identity?.userId || 'local',
          profile,
          access,
        });
        sendJson(res, 200, result);
      } catch (err) {
        const status = err.status || 400;
        sendJson(res, status, {
          error: status === 404
            ? CONSENT_NOT_FOUND_MSG
            : err.oauthDescription || err.message || 'Could not approve request.',
        });
      }
      return true;
    }
    if (action === 'deny' && req.method === 'POST') {
      try {
        sendJson(res, 200, mcpOAuth.denyPending(txId, { workspaceId: workspace.id }));
      } catch (err) {
        const status = err.status || 400;
        sendJson(res, status, {
          error: status === 404
            ? CONSENT_NOT_FOUND_MSG
            : err.oauthDescription || err.message || 'Could not deny request.',
        });
      }
      return true;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return true;
  };
  const DEVICE_NOT_FOUND_MSG = 'This sign-in code is invalid or expired. Start connect again in your terminal.';
  const handleDeviceAuthApi = async (req, res, pathname, workspace, identity, clientIp) => {
    const match = pathname.match(/^\/api\/oauth\/device\/([^/]+)(?:\/(approve|deny))?$/);
    if (!match) return false;
    let codeParam;
    try { codeParam = decodeURIComponent(match[1]); }
    catch { sendJson(res, 400, { error: 'Invalid device code.' }); return true; }
    const action = match[2] || '';
    if (!action && req.method === 'GET') {
      try {
        const pending = deviceAuth.getPendingByUserCode(codeParam, { workspaceId: workspace.id, clientIp });
        if (!pending) { sendJson(res, 404, { error: DEVICE_NOT_FOUND_MSG }); return true; }
        const profileData = typeof workspace.getProfileData === 'function'
          ? await workspace.getProfileData().catch(() => ({ profiles: ['all'], profileRecords: [] }))
          : { profiles: ['all'], profileRecords: [] };
        sendJson(res, 200, {
          request: pending,
          workspace: workspace.id ? 'personal' : 'local',
          workspaceId: workspace.id,
          canApprove: true,
          profiles: profileData.profiles,
          profileRecords: profileData.profileRecords,
        });
      } catch (err) {
        sendJson(res, err.status || 400, { error: err.oauthDescription || err.message || DEVICE_NOT_FOUND_MSG });
      }
      return true;
    }
    if (action === 'approve' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        let profile = 'all';
        if (body?.profile !== undefined && body.profile !== null && body.profile !== '') {
          if (typeof body.profile !== 'string' || PROFILE_CONTROL_RE.test(body.profile)) {
            sendJson(res, 400, { error: 'Profile must be a valid string without control characters.' });
            return true;
          }
          profile = normalizeProfileTag(body.profile) || 'all';
        }
        let access = null;
        const rawAccess = body?.access && typeof body.access === 'object' && !Array.isArray(body.access) ? body.access : body;
        if (rawAccess && typeof rawAccess === 'object') {
          const nextAccess = {};
          if (rawAccess.allowedConnections !== undefined) nextAccess.allowedConnections = rawAccess.allowedConnections;
          if (rawAccess.allowedSkills !== undefined) nextAccess.allowedSkills = rawAccess.allowedSkills;
          if (rawAccess.memoryAccess !== undefined) nextAccess.memoryAccess = rawAccess.memoryAccess;
          if (rawAccess.canManage !== undefined) nextAccess.canManage = rawAccess.canManage;
          if (rawAccess.secrets !== undefined) nextAccess.secrets = rawAccess.secrets;
          if (rawAccess.accessSet !== undefined) nextAccess.accessSet = rawAccess.accessSet;
          if (rawAccess.approvalMode !== undefined) nextAccess.approvalMode = rawAccess.approvalMode;
          if (rawAccess.accountChoice !== undefined) nextAccess.accountChoice = rawAccess.accountChoice;
          if (Object.keys(nextAccess).length > 0) access = nextAccess;
        }
        const selectedAgentIds = Array.isArray(body?.agents) ? body.agents : null;
        const result = deviceAuth.approveByUserCode(codeParam, {
          workspaceId: workspace.id,
          userId: identity?.userId || 'local',
          profile,
          access,
          selectedAgentIds,
        });
        sendJson(res, 200, result);
      } catch (err) {
        const status = err.status || 400;
        sendJson(res, status, {
          error: status === 404 ? DEVICE_NOT_FOUND_MSG : err.oauthDescription || err.message || 'Could not approve device.',
        });
      }
      return true;
    }
    if (action === 'deny' && req.method === 'POST') {
      try {
        sendJson(res, 200, deviceAuth.denyByUserCode(codeParam, { workspaceId: workspace.id }));
      } catch (err) {
        const status = err.status || 400;
        sendJson(res, status, {
          error: status === 404 ? DEVICE_NOT_FOUND_MSG : err.oauthDescription || err.message || 'Could not deny device.',
        });
      }
      return true;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return true;
  };

  const metricsToken = String(opts.metricsToken ?? process.env.LOOP_METRICS_TOKEN ?? '').trim();
  const metrics = new MetricsCollector({
    gaugesProvider: () => ({
      activeWorkspaces: 1 + (workspaces?.users?.size || 0),
    }),
  });

  async function handleIncomingRequest(req, res, port) {
    const reqStartedAt = Date.now();
    res.once('finish', () => {
      metrics.observeHttp(Date.now() - reqStartedAt, res.statusCode || 200);
    });
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const pathname = url.pathname;
      const origin = resolveLoopPublicOrigin(req, port);
      const clientIp = resolveClientIp(req);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
      res.setHeader('Cache-Control', 'no-store');
      const blocked = guardRequest(req, pathname, port);
      if (blocked) return sendJson(res, blocked.status, { error: blocked.error });
      if (people) sharedSearch.publicOrigin = origin;

      // G4a-18: Cookie-less public MCP OAuth 2.1 metadata, registration, and token endpoints
      // allow cross-origin browser MCP clients via CORS.
      if (isOAuthPublicCorsPath(pathname)) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
            'Cross-Origin-Resource-Policy': 'cross-origin',
          });
          return res.end();
        }
      }

      // Open CORS for cookie-less Bearer-authenticated MCP, legacy SSE, and REST bridge paths.
      // Never sends Access-Control-Allow-Credentials so browser cookies are never accepted cross-origin.
      if (isBearerMcpCorsPath(pathname)) {
        const hasCookie = typeof req.headers?.cookie === 'string' && req.headers.cookie.trim().length > 0;
        if (!hasCookie) {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate, X-Loop-Session-Recovered');
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Loop-Token, Mcp-Session-Id, MCP-Protocol-Version, X-Loop-Actor',
              'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate, X-Loop-Session-Recovered',
              'Access-Control-Max-Age': '600',
              'Cross-Origin-Resource-Policy': 'cross-origin',
            });
            return res.end();
          }
        }
      }

      if (pathname === '/health' && req.method === 'GET') {
        try {
          await access(dataDir, fsConstants.R_OK | fsConstants.W_OK);
          const payload = url.searchParams.get('detail') === '1'
            ? {
                app: 'loop-hub',
                ok: true,
                version: serverVersion,
                ...(serverReleaseInfo.release ? { release: serverReleaseInfo.release } : {}),
                ...(serverReleaseInfo.commit ? { commit: serverReleaseInfo.commit } : {}),
                uptimeSec: Math.floor(process.uptime()),
              }
            : { app: 'loop-hub', ok: true };
          return sendJson(res, 200, payload);
        } catch {
          return sendJson(res, 503, { app: 'loop-hub', ok: false, error: 'Data directory unavailable.' });
        }
      }

      if (pathname === '/metrics' && req.method === 'GET') {
        const bearer = extractBearerToken(req) || '';
        const tokenOk = Boolean(
          metricsToken &&
          bearer.length === metricsToken.length &&
          timingSafeEqual(Buffer.from(bearer, 'utf8'), Buffer.from(metricsToken, 'utf8')),
        );
        const localOwnerOk = !hosted && (legacy ? workspaces.local.owner.isSignedIn(req) : isLocalDeviceRequest(req, port, { hosted }));
        const loopbackNoTokenOk = !hosted && !metricsToken && isLocalDeviceRequest(req, port, { hosted });
        if (!tokenOk && !localOwnerOk && !loopbackNoTokenOk) {
          return sendJson(res, 401, { error: 'Metrics endpoint requires owner or metrics token.' });
        }
        const wantsProm =
          url.searchParams.get('format') === 'prometheus' ||
          String(req.headers.accept || '').includes('text/plain');
        if (wantsProm) {
          const text = metrics.toPrometheus();
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
          return res.end(text);
        }
        return sendJson(res, 200, metrics.toJson());
      }

      if (pathname === '/api/billing/webhook') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' });
        if (!billing.webhookEnabled) return sendJson(res, 404, { error: 'Not found.' });
        const rawBody = await readRawBody(req, { maxBytes: 512 * 1024 });
        const sig = req.headers['stripe-signature'];
        const result = await billing.handleWebhook(rawBody, sig);
        return sendJson(res, 200, result);
      }

      // MCP OAuth 2.1 Discovery, Dynamic Client Registration, Authorize, and Token endpoints
      const prmMatch = pathname.match(/^\/\.well-known\/oauth-protected-resource(\/mcp|\/w\/[a-f0-9]{64}\/mcp)?$/);
      if (prmMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const body = mcpOAuth.protectedResourceMetadata(origin, prmMatch[1] || '/mcp');
        if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(); }
        return sendJson(res, 200, body);
      }

      // Root & workspace-scoped RFC 8414 / OIDC Authorization Server Metadata (G4a-13)
      const scopedAsMatch =
        pathname.match(/^\/\.well-known\/(?:oauth-authorization-server|openid-configuration)\/w\/([a-f0-9]{64})$/) ||
        pathname.match(/^\/w\/([a-f0-9]{64})\/\.well-known\/(?:oauth-authorization-server|openid-configuration)$/);
      if (
        (pathname === '/.well-known/oauth-authorization-server' ||
          pathname === '/.well-known/openid-configuration' ||
          scopedAsMatch) &&
        (req.method === 'GET' || req.method === 'HEAD')
      ) {
        const body = mcpOAuth.authorizationServerMetadata(origin, scopedAsMatch ? scopedAsMatch[1] : null);
        if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(); }
        return sendJson(res, 200, body);
      }

      const scopedRegisterMatch = pathname.match(/^\/w\/([a-f0-9]{64})\/oauth\/register$/);
      if (pathname === '/oauth/register' || pathname === '/register' || scopedRegisterMatch) {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
        try {
          const clientInfo = mcpOAuth.registerClient(await readJsonBody(req), { clientIp });
          return sendJson(res, 201, clientInfo);
        } catch (err) {
          if (err?.code === 'BODY_TOO_LARGE') {
            return sendJson(res, 413, { error: 'invalid_client_metadata', error_description: err.publicMessage }, { Connection: 'close' });
          }
          if (isRawInternalError(err)) throw err;
          return sendJson(res, err.status || 400, { error: err.oauthError || 'invalid_client_metadata', error_description: err.oauthDescription || err.message });
        }
      }

      const scopedAuthorizeMatch = pathname.match(/^\/w\/([a-f0-9]{64})\/oauth\/authorize$/);
      if (pathname === '/oauth/authorize' || scopedAuthorizeMatch) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' });
        const started = await mcpOAuth.startAuthorizationWithCimd(url.searchParams, origin, {
          ...(scopedAuthorizeMatch ? { defaultWorkspaceId: scopedAuthorizeMatch[1] } : {}),
          clientIp,
        });
        if (started.txId) {
          res.writeHead(302, { Location: `/?loop-oauth=${encodeURIComponent(started.txId)}` });
          return res.end();
        }
        if (started.redirectErrorUrl) {
          res.writeHead(302, { Location: started.redirectErrorUrl });
          return res.end();
        }
        // G4a-08: Never redirect unconfirmed DCR clients; render an escaped HTML error page on Loop.
        return sendOAuthErrorHtml(res, started.status || 400, started.error, started.error_description, req.method === 'HEAD');
      }

      const scopedRevokeMatch = pathname.match(/^\/w\/([a-f0-9]{64})\/oauth\/revoke$/);
      if (pathname === '/oauth/revoke' || scopedRevokeMatch) {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'invalid_request' }, { Allow: 'POST' });
        let params;
        try {
          params = await readFormOrJsonBody(req);
        } catch (err) {
          return sendJson(res, err.status || 400, { error: 'invalid_request' });
        }
        let authedRevoke;
        try {
          authedRevoke = mcpOAuth.authenticateClient(params, {
            authorizationHeader: req.headers.authorization || '',
            requireRegistered: true,
          });
        } catch {
          return sendJson(res, 400, { error: 'invalid_client' });
        }
        if (typeof params.token !== 'string' || !params.token) return sendJson(res, 400, { error: 'invalid_request' });
        if (params.token.startsWith('loop_rt_')) {
          mcpOAuth.revokeRefreshTokens({
            token: params.token,
            clientId: authedRevoke.clientId,
            ...(scopedRevokeMatch ? { workspaceId: scopedRevokeMatch[1] } : {}),
          });
        } else if (isAgentTokenFormat(params.token)) {
          const workspaceId = scopedRevokeMatch?.[1] || await tokenRouter.resolve(params.token, { includeDisabledOAuth: true });
          const ws = workspaceId ? workspaces.personal(workspaceId, false) : hosted ? null : workspaces.local;
          await ws?.revokeOAuthAccessToken(authedRevoke.clientId, params.token);
        }
        return sendJson(res, 200, {}, { 'Cache-Control': 'no-store', Pragma: 'no-cache' });
      }

      const scopedTokenMatch = pathname.match(/^\/w\/([a-f0-9]{64})\/oauth\/token$/);
      if (pathname === '/oauth/token' || scopedTokenMatch) {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
        let grant = null;
        let isRefresh = false;
        try {
          const params = await readFormOrJsonBody(req);
          const authed = mcpOAuth.authenticateClient(params, {
            authorizationHeader: req.headers.authorization || '',
            requireRegistered: false,
          });
          const effectiveParams = authed.clientId && !params.client_id
            ? { ...params, client_id: authed.clientId }
            : params;
          isRefresh = String(effectiveParams?.grant_type || '') === 'refresh_token';
          const expectedWs = scopedTokenMatch ? scopedTokenMatch[1] : null;
          const resolveWsRefreshTtlMs = async (ws) => {
            const wsStore = ws?.store || ws?.shareContext?.store || null;
            const wsSettings = typeof wsStore?.getSettings === 'function'
              ? await wsStore.getSettings().catch(() => null)
              : null;
            const days = wsSettings?.oauthRefreshTtlDays;
            if (Number.isInteger(days) && days >= 1) return days * 24 * 60 * 60 * 1000;
            return undefined;
          };

          if (isRefresh) {
            const rawRt = String(effectiveParams?.refresh_token || '').trim();
            const flightKey = rawRt ? `${expectedWs || ''}::${authed.clientId || ''}::${hashRefreshToken(rawRt)}` : '';
            if (flightKey && inFlightRefreshes.has(flightKey)) {
              const sharedPayload = await inFlightRefreshes.get(flightKey);
              return sendJson(res, 200, sharedPayload, { Pragma: 'no-cache' });
            }
            const runRefresh = (async () => {
              const peekWsId = expectedWs ?? mcpOAuth.peekRefreshWorkspace(rawRt);
              const peekWs = peekWsId ? workspaces.personal(peekWsId, false) : workspaces.local;
              const wsTtlMs = peekWs ? await resolveWsRefreshTtlMs(peekWs) : undefined;
              grant = mcpOAuth.exchangeRefreshToken(
                effectiveParams,
                {
                  ...(expectedWs ? { expectedWorkspaceId: expectedWs } : {}),
                  ...(wsTtlMs !== undefined ? { ttlMs: wsTtlMs } : {}),
                },
              );
              const ws = grant.workspaceId ? workspaces.personal(grant.workspaceId, false) : workspaces.local;
              if (!ws) {
                if (grant.familyId) mcpOAuth.revokeRefreshTokens({ familyId: grant.familyId });
                throw Object.assign(new Error('Workspace not found.'), { status: 400, oauthError: 'invalid_grant', oauthDescription: 'Workspace not found.' });
              }
              const { token } = await ws.renewOAuthAgentToken(grant.clientId, {
                agentId: grant.agentId,
                expectedRightsDigest: grant.rightsDigest,
              });
              if (grant.workspaceId) tokenRouter.remember(token, grant.workspaceId);
              return {
                access_token: token,
                refresh_token: grant.refreshToken,
                expires_in: 3600,
                token_type: 'Bearer',
                scope: grant.scope,
                ...(grant.workspaceId ? { workspace_id: grant.workspaceId } : {}),
              };
            })();
            if (flightKey) inFlightRefreshes.set(flightKey, runRefresh);
            try {
              const payload = await runRefresh;
              return sendJson(res, 200, payload, { Pragma: 'no-cache' });
            } finally {
              if (flightKey && inFlightRefreshes.get(flightKey) === runRefresh) {
                inFlightRefreshes.delete(flightKey);
              }
            }
          }

          grant = mcpOAuth.exchangeCode(
            effectiveParams,
            origin,
            expectedWs ? { expectedWorkspaceId: expectedWs } : {},
          );
          const ws = grant.workspaceId ? workspaces.personal(grant.workspaceId, false) : workspaces.local;
          if (!ws) {
            if (grant.txId) mcpOAuth.failHandoff(grant.txId, 'Workspace not found.');
            return sendJson(res, 400, { error: 'invalid_grant', error_description: 'Workspace not found.' }, { Pragma: 'no-cache' });
          }
          const { agent, token } = await ws.issueOAuthAgentToken(grant.clientName, grant.clientId, {
            profile: grant.profile || 'all',
            ...(grant.access ? { access: grant.access } : {}),
          });
          if (grant.workspaceId) tokenRouter.remember(token, grant.workspaceId);
          const wsTtlMs = await resolveWsRefreshTtlMs(ws);
          const refreshOut = mcpOAuth.issueRefreshToken({
            agentId: agent.id,
            rightsDigest: agentRightsDigest(agent),
            clientId: grant.clientId,
            clientName: grant.clientName,
            workspaceId: grant.workspaceId,
            scope: grant.scope,
            ...(wsTtlMs !== undefined ? { ttlMs: wsTtlMs } : {}),
          }).refreshToken;
          return sendJson(res, 200, {
            access_token: token,
            refresh_token: refreshOut,
            expires_in: 3600,
            token_type: 'Bearer',
            scope: grant.scope,
            ...(grant.workspaceId ? { workspace_id: grant.workspaceId } : {}),
          }, { Pragma: 'no-cache' });
        } catch (err) {
          if (isRefresh && grant?.familyId) mcpOAuth.revokeRefreshTokens({ familyId: grant.familyId });
          if (grant?.txId) mcpOAuth.failHandoff(grant.txId, 'Could not issue agent token.');
          if (err?.code === 'BODY_TOO_LARGE') {
            return sendJson(res, 413, { error: 'invalid_request', error_description: err.publicMessage }, { Pragma: 'no-cache', Connection: 'close' });
          }
          if (isRawInternalError(err)) throw err;
          return sendJson(res, err.status || 400, { error: err.oauthError || 'invalid_request', error_description: err.oauthDescription || err.message }, { Pragma: 'no-cache' });
        }
      }

      const scopedDeviceCodeMatch = pathname.match(/^\/w\/([a-f0-9]{64})\/oauth\/device\/code$/);
      if (pathname === '/oauth/device/code' || scopedDeviceCodeMatch) {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
        try {
          const params = await readFormOrJsonBody(req);
          const pairedAuth = req.headers.authorization ? await loopConnectServer.authenticateDevice(req, resolveConnectWorkspace) : null;
          if (pairedAuth && scopedDeviceCodeMatch && scopedDeviceCodeMatch[1] !== pairedAuth.workspaceKey) return sendJson(res, 403, { error: 'invalid_target' });
          const started = deviceAuth.startDeviceAuth(params, origin, {
            ...(pairedAuth ? { defaultWorkspaceId: pairedAuth.workspaceKey === 'local' ? null : pairedAuth.workspaceKey, pairedDevice: pairedAuth.device.id } : {}),
            ...(scopedDeviceCodeMatch ? { defaultWorkspaceId: scopedDeviceCodeMatch[1] } : {}),
            clientIp,
          });
          return sendJson(res, 200, started, { Pragma: 'no-cache' });
        } catch (err) {
          if (err?.code === 'BODY_TOO_LARGE') {
            return sendJson(res, 413, { error: 'invalid_request', error_description: err.publicMessage }, { Pragma: 'no-cache', Connection: 'close' });
          }
          if (isRawInternalError(err)) throw err;
          return sendJson(res, err.status || 400, { error: err.oauthError || 'invalid_request', error_description: err.oauthDescription || err.message }, { Pragma: 'no-cache' });
        }
      }

      const scopedDeviceTokenMatch = pathname.match(/^\/w\/([a-f0-9]{64})\/oauth\/device\/token$/);
      if (pathname === '/oauth/device/token' || scopedDeviceTokenMatch) {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
        try {
          const params = await readFormOrJsonBody(req);
          const grant = deviceAuth.pollDeviceToken(
            params,
            scopedDeviceTokenMatch ? { expectedWorkspaceId: scopedDeviceTokenMatch[1] } : {},
          );
          const ws = grant.workspaceId ? workspaces.personal(grant.workspaceId, false) : workspaces.local;
          if (!ws) {
            return sendJson(res, 400, { error: 'invalid_grant', error_description: 'Workspace not found.' }, { Pragma: 'no-cache' });
          }
          if (grant.pairedDevice && !(await loopConnectServer.listDevices(ws.connectContext.dataDir)).some((d) => d.id === grant.pairedDevice)) return sendJson(res, 403, { error: 'invalid_grant', error_description: 'This computer was disconnected.' });
          const issuedAgents = [];
          for (const item of grant.agents) {
            const clientTag = grant.pairedDevice ? `paired:${grant.pairedDevice}:${item.id}` : item.id && item.id !== 'other' ? `device:${item.id}` : null;
            const { agent, token } = await ws.issueOAuthAgentToken(item.name, clientTag, {
              profile: grant.profile || 'all',
              ...(grant.access ? { access: grant.access } : {}),
            });
            if (grant.workspaceId) tokenRouter.remember(token, grant.workspaceId);
            issuedAgents.push({
              id: item.id,
              agent_id: agent.id,
              name: agent.name,
              kind: agent.kind,
              access_token: token,
            });
          }
          const baseMcpUrl = scopedDeviceTokenMatch && grant.workspaceId
            ? `${origin}/w/${grant.workspaceId}/mcp`
            : `${origin}/mcp`;
          const mcpUrl = grant.profile && grant.profile !== 'all'
            ? `${baseMcpUrl}?project=${encodeURIComponent(grant.profile)}`
            : baseMcpUrl;
          return sendJson(res, 200, {
            token_type: 'Bearer',
            mcp_url: mcpUrl,
            access_token: issuedAgents[0]?.access_token || '',
            agents: issuedAgents,
            ...(grant.workspaceId ? { workspace_id: grant.workspaceId } : {}),
          }, { Pragma: 'no-cache' });
        } catch (err) {
          if (err?.code === 'BODY_TOO_LARGE') {
            return sendJson(res, 413, { error: 'invalid_request', error_description: err.publicMessage }, { Pragma: 'no-cache', Connection: 'close' });
          }
          if (isRawInternalError(err)) throw err;
          return sendJson(res, err.status || 400, {
            error: err.oauthError || 'invalid_request',
            error_description: err.oauthDescription || err.message,
            ...(err.interval ? { interval: err.interval } : {}),
          }, { Pragma: 'no-cache' });
        }
      }

      if (pathname === '/connect.mjs') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
        const script = await buildConnectCliBundle(origin);
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Loop-Sha256': sha256Buffer(script),
          ...SECURITY_HEADERS,
        });
        return res.end(req.method === 'HEAD' ? '' : script);
      }

      if (pathname === '/release.json') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
        const connectBundle = await buildConnectCliBundle(origin).catch(() => null);
        const manifest = await buildReleaseManifest({
          root: appRootDir,
          origin,
          releasesDir,
          connectBundle,
        });
        const body = JSON.stringify(manifest, null, 2);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...SECURITY_HEADERS,
        });
        return res.end(req.method === 'HEAD' ? '' : body);
      }

      if (pathname === '/install.sh') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
        const rawScript = await readFile(path.join(appRootDir, 'scripts', 'install.sh'), 'utf8');
        const script = rawScript.replaceAll('__DEFAULT_LOOP_ORIGIN__', String(origin || '').replace(/['"\\]/g, ''));
        res.writeHead(200, {
          'Content-Type': 'text/x-shellscript; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Loop-Sha256': sha256Buffer(script),
          ...SECURITY_HEADERS,
        });
        return res.end(req.method === 'HEAD' ? '' : script);
      }

      if (pathname === '/agent-files/loop-skill.md' || pathname === '/agent-files/loop-hook.mjs') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
        const isSkill = pathname.endsWith('loop-skill.md');
        const targetFile = isSkill
          ? path.join(appRootDir, 'skills', 'loop', 'SKILL.md')
          : path.join(appRootDir, 'hooks', 'loop-hook.mjs');
        const buf = await readFile(targetFile);
        res.writeHead(200, {
          'Content-Type': isSkill ? 'text/markdown; charset=utf-8' : 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Loop-Sha256': sha256Buffer(buf),
          ...SECURITY_HEADERS,
        });
        return res.end(req.method === 'HEAD' ? '' : buf);
      }

      const downloadMatch = /^\/downloads\/([^/]+)$/.exec(pathname);
      if (downloadMatch) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
        let requestedName;
        try {
          requestedName = decodeURIComponent(downloadMatch[1]);
        } catch {
          return sendJson(res, 400, { error: 'Invalid download filename.' });
        }
        const dl = await resolveTarballDownload(releasesDir, requestedName);
        if (!dl) return sendJson(res, 404, { error: 'Release archive not found.' });
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Length': String(dl.bytes),
          'Content-Disposition': `attachment; filename="${dl.filename}"`,
          'Cache-Control': dl.immutable ? 'public, max-age=3600' : 'no-store',
          'X-Loop-Sha256': dl.sha256,
          ...(dl.release ? { 'X-Loop-Release': dl.release } : {}),
          ...SECURITY_HEADERS,
        });
        if (req.method === 'HEAD') return res.end();
        const stream = createReadStream(dl.filePath);
        stream.on('error', () => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
        stream.pipe(res);
        return;
      }

      const handoffSetupMatch = /^\/a\/([a-z0-9]{10,24})$/i.exec(pathname);
      if (handoffSetupMatch) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
        // A person gets a page with one button; an agent that fetches the same link gets the steps.
        if (/\btext\/html\b/i.test(String(req.headers.accept || ''))) {
          return await servePublic(req, res, '/agent-link.html', clerkApp);
        }
        const md = agentHandoffs.renderSetupMarkdown(handoffSetupMatch[1], origin);
        if (!md) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
          return res.end(req.method === 'HEAD' ? '' : 'This agent connect link is invalid or expired. Ask the owner for a fresh one.\n');
        }
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
        return res.end(req.method === 'HEAD' ? '' : md);
      }

      if (pathname === '/api/agent-handoff/preview' || pathname === '/api/agent-handoff/status') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' });
        try {
          const params = await readFormOrJsonBody(req);
          const link = agentHandoffs.peekLink({ id: params?.id || '', claimCode: params?.claimCode || '', clientIp });
          const ws = link.workspaceId ? workspaces.personal(link.workspaceId, false) : workspaces.local;
          const agent = ws && link.agentId ? await ws.shareContext.store.getAgent(link.agentId) : link.pendingAgent;
          if (!ws || !agent || agent.enabled === false) {
            return sendJson(res, 404, { error: 'This link has ended. Ask for a new one.' }, { Pragma: 'no-cache' });
          }
          if (pathname.endsWith('/status')) {
            const lastSeenAt = agent.id ? await ws.activity.lastSeenFor(agent.id) : null;
            return sendJson(res, 200, { claimed: link.claimed, connected: link.claimed && Date.parse(lastSeenAt) >= link.claimedAt }, { Pragma: 'no-cache' });
          }
          return sendJson(res, 200, {
            agent: await ws.agentLinkView(agent),
            from: link.from,
            expiresAt: link.expiresAt,
            claimed: link.claimed,
            mcpUrl: `${origin}/mcp`,
          }, { Pragma: 'no-cache' });
        } catch (err) {
          if (isRawInternalError(err)) throw err;
          return sendJson(res, err?.status || 400, { error: err?.publicMessage || 'This link has ended. Ask for a new one.' }, { Pragma: 'no-cache' });
        }
      }

      if (pathname === '/api/agent-handoff/claim') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' });
        try {
          const params = await readFormOrJsonBody(req);
          const ticket = agentHandoffs.claim({
            id: params?.id || '',
            claimCode: params?.claimCode || params?.claim_code || params?.code || '',
            agentName: params?.agentName || params?.agent_name || '',
            clientId: params?.clientId || params?.client_id || '',
            clientIp,
          });
          const ws = ticket.workspaceId ? workspaces.personal(ticket.workspaceId, false) : workspaces.local;
          if (!ws) {
            return sendJson(res, 404, { error: 'Workspace not found.' }, { Pragma: 'no-cache' });
          }
          const clientTag = ticket.agentKind && ticket.agentKind !== 'other' ? `handoff:${ticket.id}:${ticket.agentKind}` : null;
          const issued = ticket.agentId
            ? await ws.claimAgentLink(ticket.agentId, ticket.agentKind)
            : await ws.issueOAuthAgentToken(ticket.name, clientTag, {
              byOwner: true,
              profile: ticket.profile || 'all',
              access: { canManage: ticket.canManage, memoryAccess: ticket.memoryAccess },
            });
          if (!issued) return sendJson(res, 404, { error: 'This link has ended. Ask for a new one.' }, { Pragma: 'no-cache' });
          const { agent, token } = issued;
          agentHandoffs.recordClaimedAgent(ticket.id, agent.id);
          if (ticket.workspaceId) tokenRouter.remember(token, ticket.workspaceId);
          ws.activity?.record?.({
            // A link only hands over the key: the agent itself has not called Loop yet.
            agentId: null,
            agentName: agent.name,
            method: 'agent/handoff_claim',
            target: `${agent.name} (${agent.profile || 'all'})`,
            ok: true,
          });
          ws.broadcast?.('agents', { at: Date.now() });
          const baseMcpUrl = `${origin}/mcp`;
          const claimedProfile = ticket.agentId ? agent.profile : ticket.profile;
          const mcpUrl = claimedProfile && claimedProfile !== 'all'
            ? `${baseMcpUrl}?project=${encodeURIComponent(claimedProfile)}`
            : baseMcpUrl;
          if (smsAgentClient.enabled) {
            void smsAgentClient.nudge({
              workspaceId: ticket.workspaceId || 'local',
              message: `${agent.name} claimed its Loop setup key. Its first request will appear under Agents.`,
              idempotencyKey: `agent-claimed:${ticket.id}`,
            }).catch(() => {});
          }
          return sendJson(res, 200, {
            ok: true,
            token_type: 'Bearer',
            access_token: token,
            mcp_url: mcpUrl,
            agent: {
              id: agent.id,
              name: agent.name,
              kind: agent.kind,
              profile: agent.profile || 'all',
              canManage: agent.canManage === true,
              memoryAccess: agent.memoryAccess || 'read_write',
            },
          }, { Pragma: 'no-cache' });
        } catch (err) {
          if (err?.code === 'BODY_TOO_LARGE') {
            return sendJson(res, 413, { error: err.publicMessage }, { Pragma: 'no-cache', Connection: 'close' });
          }
          if (isRawInternalError(err)) throw err;
          return sendJson(res, err?.status || 400, {
            error: err?.publicMessage || err?.message || 'Could not claim connect code.',
            ...(err?.code ? { code: err.code } : {}),
          }, { Pragma: 'no-cache' });
        }
      }

      const device = legacy ? true : isLocalDeviceRequest(req, port, { hosted });
      const scoped = /^\/w\/([a-f0-9]{64})\/mcp(\/whoami)?$/.exec(pathname);
      const isWhoami = pathname === '/mcp/whoami' || scoped?.[2] === '/whoami';
      if (pathname === '/mcp' || pathname === '/mcp/whoami' || scoped) {
        if (!isWhoami) metrics.inc('mcp_requests_total', 1);
        const wwwAuth = { 'WWW-Authenticate': mcpOAuth.wwwAuthenticateHeader(origin, pathname) };
        if (!legacy && !/^loop_[\w-]+$/.test(extractBearerToken(req) || '')) {
          if (isWhoami) return sendJson(res, 401, { error: 'Valid Loop agent token required.' }, wwwAuth);
          return sendRpcJson(res, 401, rpcError(null, -32001, mcpUnauthorizedMessage(origin)), wwwAuth);
        }
        // Hosted: a plain /mcp finds the account that issued the agent's key.
        const routedId = !scoped && !device && hosted ? await tokenRouter.resolve(extractBearerToken(req)) : null;
        if (!scoped && !device && !routedId) {
          // Not the Mac, and no account issued this key: standard OAuth challenge so the agent signs in again.
          if (isWhoami) {
            return sendJson(res, hosted ? 401 : 403, { error: hosted ? 'This Loop key is not recognized.' : 'The device gateway is local only.' }, hosted ? wwwAuth : {});
          }
          if (hosted) return sendRpcJson(res, 401, rpcError(null, -32001, `This Loop key is not recognized. ${mcpUnauthorizedMessage(origin)}`), wwwAuth);
          return sendRpcJson(res, 403, rpcError(null, -32001, 'The device gateway is local only.'));
        }
        const ws = scoped ? workspaces.personal(scoped[1], false) : routedId ? workspaces.personal(routedId, false) : workspaces.local;
        if (!ws) {
          // G1-12: Return exact same 401 status, body, and WWW-Authenticate header as an existing workspace with bad token.
          if (isWhoami) return sendJson(res, 401, { error: 'Valid Loop agent token required.' }, wwwAuth);
          return sendRpcJson(res, 401, rpcError(null, -32001, mcpUnauthorizedMessage(origin)), wwwAuth);
        }
        if (hosted && billing.enabled && !isWhoami) {
          const access = await checkHostedLoopConnect(ws.id || 'local');
          if (!access.active) {
            return sendRpcJson(
              res,
              402,
              rpcError(
                null,
                -32002,
                `An active Loop Connect subscription is required to use Loop Cloud (/mcp). Upgrade at ${origin}/#settings?tab=billing`,
              ),
            );
          }
        }
        return await ws.handle(req, res, port);
      }

      // Legacy MCP 2024-11-05 HTTP+SSE transport (/sse + /messages) and scoped /w/<id>/sse + /w/<id>/messages.
      const scopedLegacySse = /^\/w\/([a-f0-9]{64})\/(sse|messages)$/.exec(pathname);
      if (pathname === '/sse' || pathname === '/messages' || scopedLegacySse) {
        const isMessages = pathname === '/messages' || scopedLegacySse?.[2] === 'messages';
        const messagePath = scopedLegacySse ? `/w/${scopedLegacySse[1]}/messages` : '/messages';
        const wwwAuth = { 'WWW-Authenticate': mcpOAuth.wwwAuthenticateHeader(origin, pathname) };
        const bearerTok = extractBearerToken(req) || '';
        if (!legacy && !/^loop_[\w-]+$/.test(bearerTok)) {
          return sendJson(res, 401, { error: mcpUnauthorizedMessage(origin) }, wwwAuth);
        }
        const routedId = !scopedLegacySse && !device && hosted ? await tokenRouter.resolve(bearerTok) : null;
        if (!scopedLegacySse && !device && !routedId) {
          return sendJson(res, hosted ? 401 : 403, { error: hosted ? 'This Loop key is not recognized.' : 'The device gateway is local only.' }, hosted ? wwwAuth : {});
        }
        const ws = scopedLegacySse ? workspaces.personal(scopedLegacySse[1], false) : routedId ? workspaces.personal(routedId, false) : workspaces.local;
        if (!ws) return sendJson(res, 401, { error: mcpUnauthorizedMessage(origin) }, wwwAuth);
        if (hosted && billing.enabled) {
          const access = await checkHostedLoopConnect(ws.id || 'local');
          if (!access.active) {
            return sendJson(res, 402, { error: `An active Loop Connect subscription is required. Upgrade at ${origin}/#settings?tab=billing` });
          }
        }
        return await ws.handleLegacySseRequest(req, res, port, url, pathname, { isMessages, messagePath });
      }

      // Thin Bearer-authenticated REST + OpenAPI 3.1 bridge (/api/v1/tools, /api/v1/tools/:name/call, /api/v1/openapi.json).
      const scopedRestApi = /^\/w\/([a-f0-9]{64})(\/api\/v1)(\/(?:tools(?:\/[^/]+\/call)?|openapi\.json))$/.exec(pathname);
      const localRestApi = !scopedRestApi ? /^(\/api\/v1)(\/(?:tools(?:\/[^/]+\/call)?|openapi\.json))$/.exec(pathname) : null;
      if (scopedRestApi || localRestApi) {
        const wwwAuth = { 'WWW-Authenticate': mcpOAuth.wwwAuthenticateHeader(origin, pathname) };
        const bearerTok = extractBearerToken(req) || '';
        if (!legacy && !/^loop_[\w-]+$/.test(bearerTok)) {
          return sendJson(res, 401, { error: mcpUnauthorizedMessage(origin) }, wwwAuth);
        }
        const routedId = !scopedRestApi && !device && hosted ? await tokenRouter.resolve(bearerTok) : null;
        if (!scopedRestApi && !device && !routedId) {
          return sendJson(res, hosted ? 401 : 403, { error: hosted ? 'This Loop key is not recognized.' : 'The device gateway is local only.' }, hosted ? wwwAuth : {});
        }
        const ws = scopedRestApi ? workspaces.personal(scopedRestApi[1], false) : routedId ? workspaces.personal(routedId, false) : workspaces.local;
        if (!ws) return sendJson(res, 401, { error: mcpUnauthorizedMessage(origin) }, wwwAuth);
        if (hosted && billing.enabled) {
          const access = await checkHostedLoopConnect(ws.id || 'local');
          if (!access.active) {
            return sendJson(res, 402, { error: `An active Loop Connect subscription is required. Upgrade at ${origin}/#settings?tab=billing` });
          }
        }
        const basePath = scopedRestApi ? `/w/${scopedRestApi[1]}/api/v1` : '/api/v1';
        const subpath = scopedRestApi ? scopedRestApi[3] : localRestApi[2];
        return await ws.handleRestApiRequest(req, res, port, url, pathname, { subpath, basePath });
      }
      // Tier 2 local hook turn recall: authenticated with a recall token (`loop_rc_...`) or
      // agent key, routed like /mcp, never accessible from a browser.
      const scopedRecall = /^\/w\/([a-f0-9]{64})\/api\/turn-recall$/.exec(pathname);
      if (pathname === '/api/turn-recall' || scopedRecall) {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' });
        }
        if (req.headers?.origin !== undefined || req.headers?.['sec-fetch-site'] !== undefined) {
          return sendJson(res, 403, { error: 'forbidden' });
        }
        const token = extractBearerToken(req) || '';
        if (!isRecallTokenFormat(token) && !/^loop_[\w-]+$/.test(token)) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        const routedId = !scopedRecall && !device && hosted ? await tokenRouter.resolve(token) : null;
        if (!scopedRecall && !device && !routedId) {
          return sendJson(res, hosted ? 401 : 403, { error: hosted ? 'unauthorized' : 'The device gateway is local only.' });
        }
        const ws = scopedRecall ? workspaces.personal(scopedRecall[1], false) : routedId ? workspaces.personal(routedId, false) : workspaces.local;
        if (!ws) return sendJson(res, 401, { error: 'unauthorized' });
        return await ws.handleTurnRecallRequest(req, res, port);
      }
      // loop-text's bridge: the agent's key, routed exactly as /mcp routes it, plus the shared
      // secret. No owner session, and never from a browser.
      if (isSmsBridgePath(pathname)) {
        if (!smsAgentConfig.secret) return sendJson(res, 404, { error: 'not_found' });
        if (isBrowserRequest(req)) return sendJson(res, 403, { error: 'forbidden' });
        const token = extractBearerToken(req) || '';
        if (!smsBridgeSecretMatches(smsAgentConfig.secret, req.headers['x-loop-text-secret']) || !/^loop_[\w-]+$/.test(token)) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        const routedId = !device && hosted ? await tokenRouter.resolve(token) : null;
        const ws = routedId ? workspaces.personal(routedId, false) : device ? workspaces.local : null;
        if (!ws) return sendJson(res, 401, { error: 'unauthorized' });
        return await ws.handleSmsBridgeRequest(req, res, port, url, pathname);
      }
      // Signed inbound webhooks: POST /hooks/:id (local) or POST /w/<64hex>/hooks/:id (hosted).
      const scopedHook = /^\/w\/([a-f0-9]{64})\/hooks\/([^/]+)$/.exec(pathname);
      const localHook = !scopedHook ? /^\/hooks\/([^/]+)$/.exec(pathname) : null;
      if (scopedHook || localHook) {
        metrics.inc('webhooks_received_total', 1);
        const ws = scopedHook ? workspaces.personal(scopedHook[1], false) : (device || legacy) ? workspaces.local : null;
        if (!ws) return sendJson(res, 404, { error: 'Webhook not found.' });
        const webhookId = decodeURIComponent(scopedHook ? scopedHook[2] : localHook[1]);
        return await ws.handleInboundWebhookRequest(req, res, port, webhookId);
      }
      // Bearer-authenticated Quick Save API (/api/saved*, /api/files*) for Apple Shortcuts and CLI
      // tools (routes by agent token just like /mcp, never accessible cross-origin from browsers).
      const isQuickSavePath =
        pathname === '/api/saved' ||
        pathname.startsWith('/api/saved/') ||
        pathname === '/api/files' ||
        pathname.startsWith('/api/files/');
      const bearerQuickSaveToken = extractBearerToken(req) || '';
      if (isQuickSavePath && /^loop_[\w-]+$/.test(bearerQuickSaveToken)) {
        const routedId = !device && hosted ? await tokenRouter.resolve(bearerQuickSaveToken) : null;
        const ws = routedId ? workspaces.personal(routedId, false) : device ? workspaces.local : null;
        if (!ws) return sendJson(res, 401, { error: 'Invalid Loop token.' });
        return await ws.handleQuickSaveBearerRequest(req, res, port, url, pathname);
      }
      if (pathname === '/oauth/client.json') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
        }
        const doc = {
          client_id: `${origin}/oauth/client.json`,
          client_name: 'Loop MCP Gateway',
          client_uri: origin,
          redirect_uris: [`${origin}/oauth/callback`],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        };
        const headers = { 'Cache-Control': 'public, max-age=300' };
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
          return res.end();
        }
        return sendJson(res, 200, doc, headers);
      }

      if (pathname === '/oauth/callback') {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' });
        if (!legacy) return bounceSignInCallback(res, url);
        const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
        const crossSite = fetchSite === 'cross-site' || fetchSite === 'same-site';
        if (!workspaces.local.owner.isSignedIn(req) || crossSite) return bounceSignInCallback(res, url);
        return await workspaces.local.handle(req, res, port);
      }
      const apiRoute = pathname.startsWith('/api/') || pathname === '/events' || pathname.startsWith('/auth/clerk/');
      if (!apiRoute) {
        if (!legacy && shareCodeFromPath(pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
          return await servePublic(req, res, '/join.html', clerkApp);
        }
        if (people && peopleInviteIdFromPath(pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
          return await servePublic(req, res, '/people-join.html', clerkApp);
        }
        if (!people && pathname === '/p/' && (req.method === 'GET' || req.method === 'HEAD')) {
          return await servePublic(req, res, '/people-join.html', clerkApp);
        }
        const invitePathMatch = /^\/invite(?:\/([^/]+))?\/?$/.exec(pathname);
        if (invitePathMatch && (req.method === 'GET' || req.method === 'HEAD')) {
          let slugParam = url.searchParams.get('t') || '';
          if (!slugParam && invitePathMatch[1]) {
            try { slugParam = decodeURIComponent(invitePathMatch[1]); } catch { slugParam = ''; }
          }
          const inviteMeta = slugParam ? await inviteStore.lookup(slugParam) : null;
          const transformHtml = inviteMeta?.valid && inviteMeta.inviterName
            ? (html) => personalizeInviteHtml(html, inviteMeta.inviterName)
            : null;
          return await servePublic(req, res, '/invite.html', clerkApp, { transformHtml });
        }
        if (pathname === '/save' && (req.method === 'GET' || req.method === 'HEAD')) {
          return await servePublic(req, res, '/index.html', clerkApp);
        }
        if ((pathname === '/inspector' || pathname === '/inspector/') && (req.method === 'GET' || req.method === 'HEAD')) {
          return await servePublic(req, res, '/inspector.html', clerkApp);
        }
        if (pathname === '/inspector/sandbox' && (req.method === 'GET' || req.method === 'HEAD')) {
          let sandboxCsp = MCP_INSPECTOR_SANDBOX_CSP;
          const rawCspParam = url.searchParams.get('csp');
          if (rawCspParam && rawCspParam.length <= 2048) {
            try {
              sandboxCsp = buildSandboxCsp(JSON.parse(rawCspParam));
            } catch {
              sandboxCsp = MCP_INSPECTOR_SANDBOX_CSP;
            }
          }
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Frame-Options': 'SAMEORIGIN',
            'Content-Security-Policy': sandboxCsp,
          });
          return res.end(req.method === 'HEAD' ? '' : MCP_INSPECTOR_SANDBOX_HTML);
        }
        if (!legacy && hosted && pathname === '/' && !url.search && (req.method === 'GET' || req.method === 'HEAD') && !hasClerkSessionCookie(req)) {
          return await servePublic(req, res, '/landing.html', clerkApp);
        }
        if (pathname === '/landing.html' || pathname === '/join.html' || pathname === '/invite.html' || pathname === '/agent-link.html' || pathname === '/people-join.html' || pathname === '/inspector.html') return sendJson(res, 404, { error: 'Not found.' });
        return await servePublic(req, res, pathname, clerkApp);
      }
      if (pathname === '/api/invites/lookup') {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' });
        const slug = url.searchParams.get('t') || '';
        return sendJson(res, 200, await inviteStore.lookup(slug));
      }
      const handleBillingApi = (ws) => handleBillingRoute(req, res, {
        pathname,
        origin,
        ws,
        billing,
        inviteStore,
        loopConnectServer,
      });
      const handleInviteApi = (ws, identity) => handleInviteRoute(req, res, {
        pathname,
        origin,
        ws,
        identity,
        inviteStore,
        billing,
        smsAgentClient,
        tokenRouter,
        deriveInviteIdentity,
      });
      const handleSmsAgentApi = async (ws, identity = null) => {
        if (!pathname.startsWith('/api/sms-agent')) return false;
        const workspaceKey = ws.id || 'local';
        const wsStore = ws.shareContext?.store;
        const wsVault = ws.shareContext?.vault;
        const broadcast = ws.shareContext?.broadcast;
        const { inviterName: defaultInviterName, preferredSlug: defaultPreferredSlug } = deriveInviteIdentity(identity, !ws.id);
        try {
          if (pathname === '/api/sms-agent') {
            if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' }), true;
            if (!smsAgentClient.enabled) {
              return sendJson(res, 200, { enabled: false }), true;
            }
            const billingStatus = billing ? await billing.getWorkspaceStatus(workspaceKey) : null;
            const invited = await inviteStore.isInvited(workspaceKey);
            const planActive = isPlanActiveForSms(billingStatus) || invited;
            const rawStatus = await smsAgentClient.getStatus(workspaceKey);
            const coreDream = ws.dreamStore ? await ws.dreamStore.summary() : null;
            const status = {
              ...rawStatus,
              ...(coreDream ? { dream: coreDream } : {}),
            };
            const rawVaultItems = wsVault ? await wsVault.list({ includeInternal: false }) : [];
            const vaultKeys = rawVaultItems
              .filter((item) => typeof item?.key === 'string' && !item.key.startsWith('__'))
              .map((item) => ({
                key: item.key,
                description: item.description || '',
                type: item.type || 'secret',
              }));
            const inviteRec = await inviteStore.getOrCreateForUser({
              workspaceId: workspaceKey,
              inviterName: defaultInviterName,
              preferredSlug: defaultPreferredSlug,
            });
            const inviteShare = formatInviteShare(inviteRec, origin);
            return sendJson(res, 200, {
              enabled: true,
              phone: status?.phone || smsAgentConfig.phone || null,
              channel: status?.channel || 'blooio',
              needsUserPhone: Boolean(status?.needsUserPhone),
              planActive,
              billingUrl: SMS_AGENT_BILLING_URL,
              status,
              vaultKeys,
              invite: {
                slug: inviteShare.slug,
                inviterName: inviteShare.inviterName,
                quota: inviteShare.quota,
                used: inviteShare.used,
                remaining: inviteShare.remaining,
                inviteUrl: inviteShare.inviteUrl,
                shareMessage: inviteShare.shareMessage,
              },
            }), true;
          }
          if (pathname === '/api/sms-agent/link-code') {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }), true;
            if (!smsAgentClient.enabled) {
              return sendJson(res, 503, { error: 'SMS agent is not configured on this Loop instance.' }), true;
            }
            let reqBody = {};
            try { reqBody = await readJsonBody(req); } catch { reqBody = {}; }
            const userPhone = typeof reqBody?.phone === 'string' && reqBody.phone.trim()
              ? reqBody.phone.trim().slice(0, 32)
              : (typeof reqBody?.userPhone === 'string' && reqBody.userPhone.trim() ? reqBody.userPhone.trim().slice(0, 32) : '');
            const billingStatus = billing ? await billing.getWorkspaceStatus(workspaceKey) : null;
            const invited = await inviteStore.isInvited(workspaceKey);
            const planActive = isPlanActiveForSms(billingStatus) || invited;
            if (!planActive) {
              return sendJson(res, 402, {
                error: 'An active plan or free trial is required to activate your SMS agent.',
                upgradeRequired: true,
                billingUrl: SMS_AGENT_BILLING_URL,
              }), true;
            }
            const { agent, token } = await ensureSmsAgentRecord(wsStore, wsVault);
            if (ws.id && token) tokenRouter.remember(token, ws.id);
            if (typeof broadcast === 'function') broadcast('agents');
            const connections = (await wsStore.list()).filter((m) => m.enabled).map((m) => m.name);
            const inviteRec = await inviteStore.getOrCreateForUser({
              workspaceId: workspaceKey,
              inviterName: defaultInviterName,
              preferredSlug: defaultPreferredSlug,
            });
            const { inviteUrl } = formatInviteShare(inviteRec, origin);
            const linkResult = await smsAgentClient.createLinkCode({
              workspaceId: workspaceKey,
              agentId: agent.id,
              agentToken: token,
              planActive,
              connections,
              inviteUrl,
              ...(userPhone ? { userPhone } : {}),
            });
            return sendJson(res, 200, { ...linkResult, agent: publicAgent(agent) }), true;
          }
          if (pathname === '/api/sms-agent/brain') {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }), true;
            if (!smsAgentClient.enabled) {
              return sendJson(res, 503, { error: 'SMS agent is not configured on this Loop instance.' }), true;
            }
            const body = await readJsonBody(req);
            const mode = typeof body?.mode === 'string' ? body.mode.trim() : '';
            if (!SMS_BRAIN_MODES.has(mode)) {
              return sendJson(res, 400, { error: 'Invalid brain mode.' }), true;
            }
            const provider = body?.provider === undefined || body?.provider === null ? undefined : String(body.provider).trim();
            const model = body?.model === undefined || body?.model === null ? undefined : String(body.model).trim();
            if (mode === 'byo_key') {
              const vaultKey = typeof body?.vaultKey === 'string' ? body.vaultKey.trim() : '';
              if (!vaultKey || vaultKey.startsWith('__')) {
                return sendJson(res, 400, { error: 'A valid Vault key name is required for byo_key mode.' }), true;
              }
              const apiKey = await wsVault.get(vaultKey);
              if (apiKey === null || apiKey === undefined) {
                return sendJson(res, 404, { error: 'Vault secret not found.' }), true;
              }
              const result = await smsAgentClient.updateBrain({
                workspaceId: workspaceKey,
                mode,
                provider,
                model,
                vaultKey,
                apiKey,
              });
              return sendJson(res, 200, stripSensitiveBrainFields(result)), true;
            }
            const result = await smsAgentClient.updateBrain({
              workspaceId: workspaceKey,
              mode,
              provider,
              model,
            });
            return sendJson(res, 200, stripSensitiveBrainFields(result)), true;
          }
          if (pathname === '/api/sms-agent/cli-auth/start') {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }), true;
            if (!smsAgentClient.enabled) {
              return sendJson(res, 503, { error: 'SMS agent is not configured on this Loop instance.' }), true;
            }
            const body = await readJsonBody(req);
            const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
            if (!SMS_CLI_AUTH_PROVIDERS.has(provider)) {
              return sendJson(res, 400, { error: 'Provider must be "claude" or "codex".' }), true;
            }
            const result = await smsAgentClient.startCliAuth({ workspaceId: workspaceKey, provider });
            return sendJson(res, 200, result), true;
          }
          if (pathname === '/api/sms-agent/cli-auth/status') {
            if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' }), true;
            if (!smsAgentClient.enabled) {
              return sendJson(res, 503, { error: 'SMS agent is not configured on this Loop instance.' }), true;
            }
            const result = await smsAgentClient.getCliAuthStatus(workspaceKey);
            return sendJson(res, 200, result), true;
          }
          if (pathname === '/api/sms-agent/traces') {
            if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' }), true;
            if (!smsAgentClient.enabled) {
              return sendJson(res, 503, { error: 'SMS agent is not configured on this Loop instance.' }), true;
            }
            const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 15) || 15, 50));
            const result = await smsAgentClient.getTraces(workspaceKey, { limit });
            return sendJson(res, 200, result), true;
          }
          if (
            pathname === '/api/sms-agent/dream' ||
            pathname.startsWith('/api/sms-agent/dream/')
          ) {
            const handledCore = await handleCoreLoopRoute(req, res, {
              pathname,
              url,
              prefix: '/api/sms-agent',
              historyStore: ws.historyStore,
              dreamStore: ws.dreamStore,
              searchIndex: ws.shareContext?.searchIndex,
              scheduleSearchReindex: ws.shareContext?.scheduleSearchReindex,
              broadcast,
            });
            if (handledCore) return true;
          }
          if (pathname === '/api/sms-agent/disconnect') {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }), true;
            if (!smsAgentClient.enabled) {
              return sendJson(res, 503, { error: 'SMS agent is not configured on this Loop instance.' }), true;
            }
            const result = await smsAgentClient.disconnect(workspaceKey);
            const existing = (await wsStore.listAgents()).find(
              (a) => a.kind === 'imessage' || a.id === SMS_AGENT_DEFAULT_ID,
            );
            if (existing && existing.enabled) {
              await wsStore.updateAgent(existing.id, { enabled: false });
              if (typeof broadcast === 'function') broadcast('agents');
            }
            return sendJson(res, 200, result), true;
          }
          return false;
        } catch (err) {
          if (err instanceof SmsAgentError) {
            return sendJson(res, err.status, { error: err.publicMessage || err.message }), true;
          }
          if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 600) {
            return sendJson(res, err.status, { error: err.publicMessage || err.message }), true;
          }
          throw err;
        }
      };
      if (legacy) {
        if (hosted && pathname.startsWith('/api/connect/')) {
          const ownerWs = workspaces.local.owner.isSignedIn(req) ? workspaces.local : null;
          if (await loopConnectServer.handleHttp({
            req, res, pathname, method: req.method, origin, ownerWorkspace: ownerWs, resolveWorkspace: resolveConnectWorkspace, readJsonBody, sendJson,
          })) return;
        }
        if (!hosted && pathname.startsWith('/api/local/') && workspaces.local.localConnect) {
          if (!workspaces.local.owner.isSignedIn(req)) return sendJson(res, 401, { error: 'Sign in to Loop to continue.', auth: 'required' });
          if (await workspaces.local.localConnect.handleHttp({ req, res, pathname, method: req.method, readJsonBody, sendJson })) return;
        }
        if (pathname.startsWith('/api/oauth/requests/')) {
          if (!workspaces.local.owner.isSignedIn(req)) return sendJson(res, 401, { error: 'Sign in to Loop to continue.', auth: 'required' });
          if (await handleOAuthConsentApi(req, res, pathname, workspaces.local, null, device)) return;
        }
        if (pathname.startsWith('/api/oauth/device/')) {
          if (!workspaces.local.owner.isSignedIn(req)) return sendJson(res, 401, { error: 'Sign in to Loop to continue.', auth: 'required' });
          if (await handleDeviceAuthApi(req, res, pathname, workspaces.local, null, clientIp)) return;
        }
        if (pathname.startsWith('/api/billing')) {
          if (!workspaces.local.owner.isSignedIn(req)) return sendJson(res, 401, { error: 'Sign in to Loop to continue.', auth: 'required' });
          if (await handleBillingApi(workspaces.local)) return;
        }
        if (pathname.startsWith('/api/invites')) {
          if (!workspaces.local.owner.isSignedIn(req)) return sendJson(res, 401, { error: 'Sign in to Loop to continue.', auth: 'required' });
          if (await handleInviteApi(workspaces.local, null)) return;
        }
        if (pathname.startsWith('/api/sms-agent')) {
          if (!workspaces.local.owner.isSignedIn(req)) return sendJson(res, 401, { error: 'Sign in to Loop to continue.', auth: 'required' });
          if (await handleSmsAgentApi(workspaces.local, null)) return;
        }
        return await workspaces.local.handle(req, res, port);
      }
      if (retiredAuth.has(pathname) || pathname.startsWith('/auth/clerk/') || pathname.startsWith('/api/auth/clerk/')) return sendJson(res, 404, { error: 'Not found.' });
      const identity = await clerkApp.verifyRequest(req, port);
      const verified = identity?.userId && identity?.sessionId && identity.issuer === clerkApp.frontendApi && identity.expiresAt > Date.now();
      const workspace = verified ? workspaces.forUser(identity, device) : null;
      if (pathname === '/api/auth/status' && req.method === 'GET') return sendJson(res, 200, {
        mode: 'clerk', publishableKey: clerkApp.publishableKey, frontendApi: clerkApp.frontendApi, signedIn: !!workspace,
        ...(workspace ? { userId: identity.userId, workspace: workspace.id ? 'personal' : 'local', vaultPasswordSet: await workspace.owner.isSetUp(),
          canImportLocal: !workspace.id && device, localAvailable: device && !workspaces.claimed && !workspaces.claimCorrupt && await workspaces.local.owner.isSetUp() } : {}),
      });
      if (people) {
        const { hasPlan } = sharedSearch;
        if (await handlePeopleJoin({ req, res, pathname, method: req.method, workspace, clientIp, workspaces, people, text: smsAgentClient.enabled, hasPlan, readJsonBody, sendJson })) return;
        if (workspace?.id && await handlePeopleApi({
          req, res, pathname, method: req.method, workspace, workspaces, people, origin, hasPlan, readJsonBody, sendJson,
        })) return;
      }
      if (pathname.startsWith('/api/connect/')) {
        if (await loopConnectServer.handleHttp({
          req, res, pathname, method: req.method, origin, ownerWorkspace: workspace, resolveWorkspace: resolveConnectWorkspace, readJsonBody, sendJson,
        })) return;
      }
      if (!hosted && pathname.startsWith('/api/local/')) {
        if (!workspace) return sendJson(res, 401, { error: 'Sign in to Loop to continue.', auth: 'required' });
        if (workspace.localConnect && await workspace.localConnect.handleHttp({ req, res, pathname, method: req.method, readJsonBody, sendJson })) return;
      }
      if (hosted && billing.enabled && pathname === '/api/shares' && req.method === 'POST' && workspace?.id) {
        const access = await checkHostedLoopConnect(workspace.id);
        if (!access.active) {
          return sendJson(res, 402, {
            error: 'An active Loop Connect subscription is required to share profiles or connect additional devices.',
            upgradeRequired: true,
            billingUrl: '/#settings?tab=billing',
          });
        }
      }
      if (await handleShareApi({
        req, res, pathname, method: req.method, workspace, identity, workspaces, shares, router: tokenRouter, origin, readJsonBody, sendJson,
      })) return;
      if (!workspace) return sendJson(res, 401, { error: 'Sign in to Loop to continue.', auth: 'required' });
      if (await handleOAuthConsentApi(req, res, pathname, workspace, identity, device)) return;
      if (await handleDeviceAuthApi(req, res, pathname, workspace, identity, clientIp)) return;
      if (await handleBillingApi(workspace)) return;
      if (await handleInviteApi(workspace, identity)) return;
      if (await handleSmsAgentApi(workspace, identity)) return;
      if (pathname === '/api/auth/claim-local' && req.method === 'POST') {
        if (!device) return sendJson(res, 403, { error: 'Use this Mac to restore its workspace.' });
        const body = await readJsonBody(req);
        await workspaces.claim(identity, String(body.password || ''));
        return sendJson(res, 200, { workspace: 'local', restored: true });
      }
      return await workspace.handle(req, res, port, identity);
    } catch (err) {
      if (res.writableEnded) return;
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        return;
      }
      const { status, message, extraHeaders } = formatErrorResponse(err);
      return sendJson(res, status, { error: message }, extraHeaders);
    }
  }

  // Agent calls that have no answer yet, so a planned restart can let them finish first.
  let openAgentCalls = 0;
  const whenAgentsIdle = async (maxMs = 60_000) => {
    const until = Date.now() + maxMs;
    while (openAgentCalls > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    return openAgentCalls === 0;
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url?.split('?')[0] === '/mcp') {
      openAgentCalls += 1;
      res.once('close', () => { openAgentCalls -= 1; });
    }
    if (closing || boundPort === null) {
      res.writeHead(503, {
        'Content-Type': 'application/json; charset=utf-8',
        Connection: 'close',
        'Cache-Control': 'no-store',
        ...SECURITY_HEADERS,
      });
      res.end(JSON.stringify({ error: 'Server is shutting down.' }));
      return;
    }
    handleIncomingRequest(req, res, boundPort).catch((err) => {
      console.error('[loop-server] Unhandled request error:', err);
      if (res.writableEnded) return;
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        return;
      }
      try {
        const status = closing ? 503 : 500;
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          ...(closing ? { Connection: 'close' } : {}),
          'Cache-Control': 'no-store',
          ...SECURITY_HEADERS,
        });
        res.end(JSON.stringify({ error: closing ? 'Server is shutting down.' : 'Internal server error.' }));
      } catch {
        try { res.destroy(); } catch { /* ignore */ }
      }
    });
  });
  // Align Node HTTP timeouts with reverse proxies (Caddy) so SSE streams never hit the 5-minute
  // default requestTimeout and keep-alive connections outlast proxy idle pools.
  server.requestTimeout = 0;
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, '127.0.0.1', resolve);
  });
  const addr = server.address();
  boundPort = addr && typeof addr === 'object' ? addr.port : requestedPort;
  workspaces.local.owner.setPort(boundPort);
  workspaces.local.setPort?.(boundPort);
  const tickSchedules = async (now = Date.now()) => {
    if (closing) return [];
    scheduleWakeIndex.bootstrapFromDisk(workspaces.usersDir, now);
    const seen = new Set();
    const targets = [];
    const pushTarget = (ws) => {
      if (!ws?.tickSchedules) return;
      const key = ws.id || 'local';
      if (seen.has(key)) return;
      seen.add(key);
      targets.push(ws);
    };
    pushTarget(workspaces.local);
    for (const ws of workspaces.users.values()) pushTarget(ws);
    for (const dueWsId of scheduleWakeIndex.dueWorkspaces(now)) {
      if (dueWsId === 'local' || seen.has(dueWsId)) continue;
      const woken = workspaces.personal(dueWsId, false);
      if (woken) pushTarget(woken);
    }
    const out = [];
    for (const ws of targets) {
      const fired = await ws.tickSchedules(now).catch(() => []);
      if (Array.isArray(fired) && fired.length > 0) {
        metrics.inc('schedules_fired_total', fired.length);
        out.push({ workspaceId: ws.id || 'local', fired });
      }
    }
    return out;
  };
  const inNodeTest = process.execArgv.includes('--test');
  if (hosted && workspaces.claimed && !inNodeTest) {
    console.warn(
      'Loop started in hosted mode (LOOP_HOSTED=1) with a claimed local workspace in this data folder. Personal workspaces cannot run local command (stdio) connections. If you run Loop only on this computer, remove LOOP_HOSTED from your service settings and restart Loop.',
    );
  }
  const schedulePollMs = Number(opts.schedulePollMs ?? (inNodeTest ? 0 : 30_000));
  let schedulePollTimer = null;
  if (schedulePollMs > 0) {
    schedulePollTimer = setInterval(() => {
      void tickSchedules();
    }, schedulePollMs);
    schedulePollTimer.unref?.();
  }
  let closePromise = null;
  const close = async () => {
    if (closePromise) return closePromise;
    closing = true;
    if (schedulePollTimer) {
      clearInterval(schedulePollTimer);
      schedulePollTimer = null;
    }
    closePromise = (async () => {
      const stopping = new Promise((resolve) => server.close(resolve));
      loopConnectServer.close();
      await workspaces.close();
      await agentHandoffs.flush();
      closeAllWorkspaceDbs();
      await sharedEmbedder.close?.().catch(() => {});
      await mcpOAuth.flush().catch(() => {});
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await stopping;
    })();
    return closePromise;
  };
  return { server, port: boundPort, close, whenAgentsIdle, tickSchedules };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { port, close, whenAgentsIdle } = await startServer().catch((err) => {
    if (err?.code !== 'EADDRINUSE') throw err;
    console.error(`Loop did not start: port ${err.port} is in use. If Loop already runs, open http://127.0.0.1:${err.port}/. Otherwise set LOOP_HUB_PORT to a free port.`);
    process.exit(1);
  });
  console.log(`Loop MCP Gateway on http://127.0.0.1:${port}/ (MCP: http://127.0.0.1:${port}/mcp)`);
  // The Loop agent hook is opt-in: startup refreshes it only where it is
  // already installed, unless LOOP_AGENT_HOOKS=1 asks for every installed agent.
  // Idempotent; never blocks startup.
  if (process.env.LOOP_NO_AGENT_HOOKS !== '1') {
    import('./lib/agent-hooks.mjs')
      .then(({ refreshAgentHooks }) =>
        refreshAgentHooks({}, {
          addNew: process.env.LOOP_AGENT_HOOKS === '1',
        }))
      .then((results) => {
        for (const r of results) {
          if (r.status === 'updated') console.log(`Loop agent hook installed for ${r.label} (${r.file}).`);
          if (r.status === 'error') console.warn(`Loop agent hook was not installed for ${r.label}: ${r.reason}`);
          if (r.skill === 'created') console.log(`Loop skill linked for ${r.label} (${r.skillPath}).`);
          if (r.skill === 'repaired') console.log(`Loop skill link repaired for ${r.label} (${r.skillPath}).`);
          if (r.skill === 'error') console.warn(`Loop skill was not linked for ${r.label}: ${r.skillReason}`);
        }
        const offered = results.filter((r) => r.status === 'not-enabled').map((r) => r.label);
        if (offered.length) {
          console.log(`Tip: run \`npm run hooks -- install\` to tell ${offered.join(' and ')} when to use Loop.`);
        }
      })
      .catch((err) => console.warn(`Loop agent hook setup failed: ${err.message}`));
  }
  process.on('unhandledRejection', (err) => {
    logger.error('unhandled_rejection', { message: err?.message || String(err) });
  });
  const shutdown = async () => {
    const deadline = setTimeout(() => {
      logger.error('shutdown_timeout', { timeoutMs: 10_000 });
      process.exit(1);
    }, 10_000);
    deadline.unref?.();
    await close();
    clearTimeout(deadline);
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  // Planned restart (scripts/restart-loop.sh --when-idle): answer the running agent calls, then stop.
  // launchd starts Loop again.
  process.once('SIGUSR2', () => { void whenAgentsIdle().then(shutdown); });
}
