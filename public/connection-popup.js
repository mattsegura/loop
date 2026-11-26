// Connection popups: a connection's details (Overview, Tools) and the "Add connection / Import JSON" flow.
// Both open inline under the row that was clicked (inline-expand.js), reusing the .st-* and .ap-* panel shell.

import { readOnlyPresetTargets, readOnlyPresetHtml } from './connection-preset.js';
import { placeInline } from './inline-expand.js';
import { confirmDialog } from './components/confirm-dialog.js';
import { agentMark } from './agent-mark.js';
import { MODES, isMode, modeLabel, modeLine, saveRule, stricterMode } from './approval-modes.js';

const CLOSE_MS = 180;

export function connectionSaveToast(mcp, fallbackName = 'Connection') {
  const name = mcp?.name || fallbackName;
  const status = String(mcp?.status || '').toLowerCase();
  if (status === 'ready' || status === 'connected') {
    return { message: `${name} connected.`, tone: 'ok' };
  }
  if (mcp?.lastError) {
    return { message: `${name} saved, but connection check failed: ${mcp.lastError}`, tone: 'err' };
  }
  if (status === 'auth_required') {
    return { message: `${name} saved. Complete sign-in or update its key to connect.`, tone: 'err' };
  }
  return { message: `${name} saved (not verified yet).`, tone: 'ok' };
}

// Formats the real post-sign-in discovery check result. Never claims the connection is ready
// when discovery failed, and reserves "Read succeeded" strictly for an actual observed read.
export function postSignInSummary(result, fallbackName = 'Connection') {
  const name = result?.mcp?.name || result?.name || fallbackName;
  const readiness = result?.readiness || result?.mcp?.readiness || null;
  const ready = typeof result?.ready === 'boolean' ? result.ready : Boolean(readiness?.ready);
  const state = readiness?.state || (ready ? 'ready' : 'error');
  const readEvidence = result?.readEvidence || result?.mcp?.readEvidence || null;
  const detail = result?.discoveryError || result?.lastError || result?.mcp?.lastError || readiness?.nextStep || '';

  if (ready) {
    const enabledCount = Number.isFinite(readiness?.enabledTools)
      ? readiness.enabledTools
      : Number.isFinite(readiness?.discoveredTools)
        ? readiness.discoveredTools
        : null;
    const toolsText = enabledCount !== null
      ? ` ${enabledCount} ${enabledCount === 1 ? 'tool' : 'tools'} available.`
      : '';
    return {
      ready: true,
      state: 'ready',
      tone: 'ok',
      canRetry: false,
      readSucceeded: Boolean(readEvidence?.succeededAt),
      toast: `${name} signed in.${toolsText} You can return to your agent.`,
      bannerTitle: `${name} signed in`,
      bannerDetail: enabledCount !== null
        ? `Tools available (${enabledCount} ${enabledCount === 1 ? 'tool' : 'tools'}). You can return to your agent.`
        : 'Tools available. You can return to your agent.',
    };
  }

  if (state === 'needs_sign_in' || state === 'token_rejected') {
    return {
      ready: false,
      state,
      tone: 'err',
      canRetry: true,
      readSucceeded: false,
      toast: `${name} sign-in finished, but tool discovery failed: sign-in is still required.`,
      bannerTitle: 'Tool discovery failed after sign-in',
      bannerDetail: detail || 'The server rejected the new sign-in during tool discovery. Sign in again or retry discovery.',
    };
  }

  if (state === 'no_tools' || state === 'not_synced') {
    return {
      ready: false,
      state,
      tone: 'err',
      canRetry: true,
      readSucceeded: false,
      toast: `${name} signed in, but Loop found no tools yet. Retry tool discovery.`,
      bannerTitle: 'No tools discovered after sign-in',
      bannerDetail: detail || 'Sign-in finished, but Loop did not discover any tools. Retry discovery before using this connection.',
    };
  }

  if (state === 'tools_disabled') {
    return {
      ready: false,
      state,
      tone: 'err',
      canRetry: false,
      readSucceeded: false,
      toast: `${name} signed in, but all tools are turned off. Enable a tool before using it.`,
      bannerTitle: 'All tools are turned off',
      bannerDetail: detail || 'Turn on a tool before returning to your agent.',
    };
  }

  return {
    ready: false,
    state,
    tone: 'err',
    canRetry: true,
    readSucceeded: false,
    toast: `${name} signed in, but tool discovery failed. Retry discovery in Loop.`,
    bannerTitle: 'Tool discovery failed after sign-in',
    bannerDetail: detail || 'Sign-in finished, but Loop could not verify the server tools. Retry discovery.',
  };
}

const X_ICON = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg>';
const CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>';
const PENCIL_ICON = '<svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 3.5l3 3L7 16H4v-3z"/></svg>';

const BUILTIN_CATEGORIES = [
  { id: 'design-media', label: 'Design & Media', description: '', custom: false },
  { id: 'cloud-dev', label: 'Cloud & Dev', description: '', custom: false },
  { id: 'browser-gui', label: 'Browser & GUI', description: '', custom: false },
  { id: 'growth-marketing', label: 'Growth & Marketing', description: '', custom: false },
  { id: 'commerce-finance', label: 'Commerce & Finance', description: '', custom: false },
  { id: 'data-research', label: 'Data & Research', description: '', custom: false },
  { id: 'agents-ops', label: 'Agents & Ops', description: '', custom: false },
  { id: 'general', label: 'General', description: '', custom: false },
];

const APPROVAL_OPTIONS = [
  ['inherit', 'Default'],
  ...MODES.map((m) => [m.id, m.label]),
];

const REMOTE_ACCESS_OPTIONS = [
  ['local_only', 'This computer'],
  ['ask_approval', 'Ask me'],
  ['remote_auto', 'Remote auto'],
];

const FOCUSABLE_SELECTOR = [
  '.st-sheet button:not([disabled]):not([tabindex="-1"])',
  '.st-sheet input:not([disabled]):not([type="hidden"])',
  '.st-sheet select:not([disabled])',
  '.st-sheet textarea:not([disabled])',
  '.st-sheet a[href]',
  '.st-sheet summary',
  '.st-sheet [tabindex]:not([tabindex="-1"])',
].join(', ');

let pop = null; // { el, ctx, returnFocus, changed, ... }

/* ---------- small pure helpers ---------- */

// Upstream sign-in pages may only be opened over https, or over http on this computer.
function safeAuthorizeUrl(raw) {
  let target;
  try {
    target = new URL(String(raw || ''));
  } catch {
    throw new Error('Invalid sign-in address.');
  }
  const host = target.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (target.protocol === 'https:' || (target.protocol === 'http:' && loopback)) return target;
  throw new Error('The sign-in page is not a secure (https) address.');
}

function suggestNameFromUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    const host = u.hostname.replace(/^www\./i, '').replace(/^(mcp|api)\./i, '');
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host === 'localhost' || host === '[::1]') {
      return u.port ? `Local MCP (${u.port})` : 'Local MCP';
    }
    const base = host.split('.')[0] || u.hostname || 'MCP Server';
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return 'MCP Server';
  }
}

function getTransport(mcp) {
  if (mcp?.transport) return String(mcp.transport).toLowerCase();
  return mcp?.command ? 'stdio' : 'http';
}

function transportLabel(mcp) {
  const t = getTransport(mcp);
  if (t === 'stdio') return 'Local (stdio)';
  if (t === 'sse') return 'Server-Sent Events (sse)';
  return 'Streamable HTTP (http)';
}

function formatSyncTime(iso) {
  if (!iso) return 'Not synced yet';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'Not synced yet';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'Just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function isPersonal(ctx) {
  return typeof ctx?.isPersonalWorkspace === 'function'
    ? Boolean(ctx.isPersonalWorkspace())
    : Boolean(ctx?.isPersonalWorkspace);
}

function currentActiveProfile(ctx) {
  const raw = typeof ctx?.activeProfile === 'function' ? ctx.activeProfile() : 'all';
  const clean = String(raw || '').trim().toLowerCase();
  return clean || 'all';
}

function normApproval(ctx, val, fallback = 'inherit') {
  if (typeof ctx?.normalizeApprovalMode === 'function') {
    return ctx.normalizeApprovalMode(val, fallback);
  }
  const clean = String(val || '').trim().toLowerCase();
  if (clean === 'inherit' || isMode(clean)) return clean;
  return fallback;
}

function toolCountsOf(ctx, mcp) {
  const raw = typeof ctx?.getToolCounts === 'function' ? ctx.getToolCounts(mcp) : null;
  const tools = Array.isArray(mcp?.tools) ? mcp.tools : [];
  const disabledSet = raw?.disabledSet instanceof Set
    ? raw.disabledSet
    : new Set(Array.isArray(mcp?.disabledTools) ? mcp.disabledTools : []);
  if (raw && typeof raw.total === 'number' && typeof raw.enabled === 'number') {
    return { total: raw.total, enabled: raw.enabled, disabledSet };
  }
  let enabled = 0;
  for (const t of tools) {
    if (!disabledSet.has(t.name) && t.enabled !== false) enabled += 1;
  }
  return { total: tools.length, enabled, disabledSet };
}

function pinnedSetOf(ctx, mcp) {
  if (typeof ctx?.effectivePinnedTools === 'function') {
    const list = ctx.effectivePinnedTools(mcp);
    if (Array.isArray(list)) return new Set(list);
  }
  return new Set(Array.isArray(mcp?.pinnedTools) ? mcp.pinnedTools : []);
}

function formatTestOutput(ctx, payload) {
  const formatted = typeof ctx?.formatToolResult === 'function' ? ctx.formatToolResult(payload) : null;
  if (typeof formatted === 'string') {
    return {
      text: formatted,
      isError: Boolean(payload?.result?.isError || payload?.isError),
    };
  }
  if (formatted && typeof formatted === 'object') {
    return {
      text: String(formatted.text ?? ''),
      isError: Boolean(formatted.isError),
    };
  }
  const data = payload?.result !== undefined ? payload.result : payload;
  return {
    text: typeof data === 'string' ? data : JSON.stringify(data ?? {}, null, 2),
    isError: Boolean(data && typeof data === 'object' && data.isError),
  };
}

function extractProfiles(data) {
  const seen = new Map();
  const add = (rec) => {
    if (!rec) return;
    if (typeof rec === 'string') {
      const id = rec.trim().toLowerCase();
      if (id && id !== 'all' && !seen.has(id)) {
        seen.set(id, { id, name: id, description: '' });
      }
      return;
    }
    if (typeof rec === 'object' && typeof rec.id === 'string') {
      const id = rec.id.trim().toLowerCase();
      if (id && id !== 'all') {
        seen.set(id, {
          id,
          name: String(rec.name || id),
          description: String(rec.description || ''),
        });
      }
    }
  };
  if (Array.isArray(data?.profileRecords)) data.profileRecords.forEach(add);
  if (Array.isArray(data?.profiles)) data.profiles.forEach(add);
  return [...seen.values()];
}

function profileNameOf(id, profileRecords) {
  if (!id || id === 'all') return 'All';
  const rec = (Array.isArray(profileRecords) ? profileRecords : []).find((r) => r && r.id === id);
  return rec?.name || id;
}

function buildCategoriesList(mcpsData, policiesRes, mcp) {
  const byId = new Map();
  const add = (cat, isCustomFallback = false) => {
    if (!cat || typeof cat !== 'object' || typeof cat.id !== 'string') return;
    const id = cat.id.trim();
    if (!id) return;
    const prev = byId.get(id);
    byId.set(id, {
      id,
      label: String(cat.label || prev?.label || id),
      description: String(cat.description ?? prev?.description ?? ''),
      custom: Boolean(cat.custom ?? prev?.custom ?? isCustomFallback),
    });
  };
  if (Array.isArray(policiesRes?.categories)) {
    for (const c of policiesRes.categories) add(c);
  }
  if (Array.isArray(mcpsData?.categories)) {
    for (const c of mcpsData.categories) add(c);
  }
  for (const builtIn of BUILTIN_CATEGORIES) {
    if (!byId.has(builtIn.id)) add(builtIn, false);
  }
  if (mcp?.category && !byId.has(mcp.category)) {
    add({ id: mcp.category, label: mcp.categoryLabel || mcp.category, description: '', custom: false });
  }
  const builtInIds = new Set(BUILTIN_CATEGORIES.map((c) => c.id));
  const custom = [];
  const builtins = [];
  for (const c of byId.values()) {
    if (c.custom && !builtInIds.has(c.id)) custom.push(c);
    else if (c.id !== 'general') builtins.push(c);
  }
  const builtInRank = (id) => {
    const i = BUILTIN_CATEGORIES.findIndex((b) => b.id === id);
    return i >= 0 ? i : 500;
  };
  builtins.sort((a, b) => builtInRank(a.id) - builtInRank(b.id) || a.label.localeCompare(b.label));
  const general = byId.get('general') || BUILTIN_CATEGORIES[BUILTIN_CATEGORIES.length - 1];
  return [...custom, ...builtins, general];
}

function mergeMcp(prev, next) {
  if (!next || typeof next !== 'object') return prev;
  return {
    ...prev,
    ...next,
    ...(next.readiness ? { readEvidence: next.readEvidence ?? null } : {}),
    logo: next.logo !== undefined ? next.logo : prev.logo,
    category: next.category !== undefined ? next.category : prev.category,
    categoryLabel: next.categoryLabel !== undefined ? next.categoryLabel : prev.categoryLabel,
    approval: next.approval !== undefined ? next.approval : prev.approval,
  };
}

// Update only the status so an open tool or credential form retains its draft.
export async function refreshOpenConnectionStatus() {
  const p = pop;
  if (p?.kind !== 'connection' || !p.mcp || p.mcp.lent) return;
  const request = p.statusRequest = (p.statusRequest || 0) + 1;
  try {
    const data = await p.ctx.api(`/api/mcps/${encodeURIComponent(p.connId)}/read-status`);
    if (!alive(p) || request !== p.statusRequest) return;
    p.mcp.readEvidence = data.readEvidence;
    p.mcp.readiness = data.readiness;
    paintStatus(p);
  } catch {
    if (!alive(p) || request !== p.statusRequest) return;
    p.mcp.readEvidence = null;
    paintStatus(p);
  }
}

const KNOWN_LOGIN_ORIGINS = [
  [/gmail|googlemail/, 'https://mail.google.com'],
  [/google\s*calendar|gcal/, 'https://calendar.google.com'],
  [/google\s*drive|gdrive/, 'https://drive.google.com'],
  [/github/, 'https://github.com'],
  [/linear/, 'https://linear.app'],
  [/notion/, 'https://www.notion.so'],
  [/slack/, 'https://slack.com'],
  [/figma/, 'https://www.figma.com'],
  [/stripe/, 'https://dashboard.stripe.com'],
  [/composio/, 'https://app.composio.dev'],
  [/vercel/, 'https://vercel.com'],
  [/supabase/, 'https://supabase.com'],
  [/jira|atlassian/, 'https://id.atlassian.com'],
  [/hubspot/, 'https://app.hubspot.com'],
  [/airtable/, 'https://airtable.com'],
  [/discord/, 'https://discord.com'],
  [/spotify/, 'https://accounts.spotify.com'],
];

function suggestLoginOrigin(mcp) {
  if (mcp?.agentLogin?.origin) return mcp.agentLogin.origin;
  if (typeof mcp?.websiteUrl === 'string' && /^https:\/\//i.test(mcp.websiteUrl.trim())) {
    try { return new URL(mcp.websiteUrl.trim()).origin; } catch { /* ignore */ }
  }
  const hay = `${mcp?.name || ''} ${mcp?.url || ''}`.toLowerCase();
  for (const [re, origin] of KNOWN_LOGIN_ORIGINS) {
    if (re.test(hay)) return origin;
  }
  if (typeof mcp?.url === 'string' && /^https:\/\//i.test(mcp.url.trim())) {
    try {
      const u = new URL(mcp.url.trim());
      const stripped = u.hostname.replace(/^(mcp|api|connect)\./i, '');
      if (stripped && stripped.includes('.')) return `https://${stripped}`;
      return u.origin;
    } catch { /* ignore */ }
  }
  return '';
}

function defaultCredTab(mcp, hint = null) {
  if (mcp?.tokenRejected) return 'api_key';
  if (hint === 'api_key') return 'api_key';
  if (hint === 'oauth_client') return 'oauth_client';
  if (mcp?.agentLogin) return 'agent_login';
  if (mcp?.signInBroken) {
    if (/Could not discover OAuth/i.test(mcp.signInBroken)) return 'api_key';
    return 'agent_login';
  }
  return 'api_key';
}

function eligibleAgentsForConn(agents, mcp) {
  const connProfiles = Array.isArray(mcp?.profiles) && mcp.profiles.length > 0 ? mcp.profiles : ['all'];
  const allProfiles = connProfiles.includes('all');
  return (Array.isArray(agents) ? agents : []).filter((a) => {
    if (!a || a.enabled === false) return false;
    if (allProfiles) return true;
    const ap = String(a.profile || 'all').trim().toLowerCase() || 'all';
    return ap === 'all' || connProfiles.includes(ap);
  });
}

function getEffectiveConnApproval(ctx, mcp, policies) {
  if (typeof ctx?.effectiveConnectionApproval === 'function') {
    const val = ctx.effectiveConnectionApproval(mcp.id, policies);
    if (isMode(val)) return val;
  }
  const connMode = normApproval(ctx, mcp.approval ?? policies?.connections?.[mcp.id], 'inherit');
  if (isMode(connMode)) return connMode;
  const catMode = mcp.category ? policies?.categories?.[mcp.category] : null;
  if (isMode(catMode)) return catMode;
  return isMode(policies?.default) ? policies.default : 'auto';
}

// `tool` is the tool itself when the caller has it (so what it says about itself can count),
// or just its name.
function getEffectiveToolApproval(ctx, mcp, tool, policies) {
  if (typeof ctx?.effectiveToolApproval === 'function') {
    const val = ctx.effectiveToolApproval(tool && typeof tool === 'object' ? mcp : mcp.id, tool, policies);
    if (isMode(val)) return val;
  }
  const toolName = tool && typeof tool === 'object' ? tool.name : tool;
  const toolKey = `${mcp.id}__${toolName}`;
  const toolMode = normApproval(ctx, policies?.tools?.[toolKey], 'inherit');
  if (isMode(toolMode)) return toolMode;
  return getEffectiveConnApproval(ctx, mcp, policies);
}

// The rule of one tool. With no rule of its own it shows the mode that is in use.
function toolRuleHtml(p, tool, override) {
  const { esc } = p.ctx;
  const inUse = modeLabel(getEffectiveToolApproval(p.ctx, p.mcp, tool, p.policies));
  return `
    <select
      class="cp-tool-rule ${override === 'inherit' ? '' : `is-own is-${esc(override)}`}"
      data-cp-tool-approval="${esc(tool.name)}"
      aria-label="Approval rule for ${esc(tool.name)}"
    >
      <option value="inherit" ${override === 'inherit' ? 'selected' : ''}>Default: ${esc(inUse)}</option>
      ${MODES.map((m) => `<option value="${m.id}" ${override === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
    </select>`;
}

function seedArgsFromSchema(inputSchema) {
  const props = inputSchema?.properties;
  const required = Array.isArray(inputSchema?.required) ? inputSchema.required : [];
  if (!props || typeof props !== 'object' || required.length === 0) return '{}';
  const seed = {};
  for (const key of required) {
    if (!Object.hasOwn(props, key)) continue;
    const spec = props[key];
    const rawType = Array.isArray(spec?.type) ? spec.type[0] : spec?.type;
    if (spec && Object.hasOwn(spec, 'default')) seed[key] = spec.default;
    else if (Array.isArray(spec?.enum) && spec.enum.length > 0) seed[key] = spec.enum[0];
    else if (rawType === 'number' || rawType === 'integer') seed[key] = 0;
    else if (rawType === 'boolean') seed[key] = false;
    else if (rawType === 'array') seed[key] = [];
    else if (rawType === 'object') seed[key] = {};
    else seed[key] = '';
  }
  return Object.keys(seed).length > 0 ? JSON.stringify(seed, null, 2) : '{}';
}

function renderSchemaHints(esc, inputSchema) {
  const props = inputSchema?.properties;
  if (!props || typeof props !== 'object' || Object.keys(props).length === 0) {
    return '<div class="st-rs">No input parameters required.</div>';
  }
  const reqSet = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
  return `
    <div class="schema-list" aria-label="Tool parameters">
      ${Object.entries(props).map(([name, spec]) => {
        const typeLabel = Array.isArray(spec?.type) ? spec.type.join('|') : (spec?.type || 'any');
        const req = reqSet.has(name) ? '<span class="req" title="Required">*</span>' : '';
        const titleAttr = spec?.description ? ` title="${esc(spec.description)}"` : '';
        return `<span class="schema-param"${titleAttr}>${esc(name)}${req}: ${esc(typeLabel)}</span>`;
      }).join('')}
    </div>`;
}

function seg(esc, field, options, current, label) {
  return `
    <span class="st-seg" role="group" aria-label="${esc(label)}" data-cp-field="${esc(field)}">
      ${options.map(([val, text]) => `<button type="button" data-val="${esc(val)}" aria-pressed="${val === current}">${esc(text)}</button>`).join('')}
    </span>`;
}

function rule(esc, title, desc, control) {
  return `
    <div class="st-rule">
      <div class="st-rule-c"><div class="st-rt">${esc(title)}</div>${desc ? `<div class="st-rs">${esc(desc)}</div>` : ''}</div>
      ${control}
    </div>`;
}

/* ---------- popup shell ---------- */

// Projects are kept on the server but not shown in the dashboard.
const PROJECTS_SHOWN = false;

const BACK_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6l-6 6 6 6"/></svg>';

// A connection opens as a page of its own over the dashboard. It adds one history entry, so the
// browser's Back closes it like the back arrow does. The URL does not change.
let pageInHistory = false;

// The page's top bar: the logo sits where the header logo is, so it stays still when the page opens.
// backAttr is data-cp-back on a painted page and data-cp-close while it loads or shows an error.
function pageBarHtml(esc, backLabel, { backAttr = 'data-cp-back', backClass = '' } = {}) {
  return `
    <div class="cp-pg-bar">
      <button type="button" class="cp-back ${backClass}" ${backAttr}>${BACK_ICON}<span>${esc(backLabel)}</span></button>
      <a class="cp-pg-logo" href="#home" aria-label="Loop, go to Home"><img src="./logo.svg" alt="" width="64" height="28"></a>
    </div>`;
}

function backLabelNow() {
  const t = String(document.title || '').split(' · ')[0].trim();
  return t && t !== 'Loop' && t.length <= 24 ? t : 'Back';
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    if (!pageInHistory) return;
    pageInHistory = false;
    if (pop?.page) closeConnectionPopup();
  });
  // Another page of the dashboard opened: the connection page goes with it.
  window.addEventListener('hashchange', () => {
    if (!pop?.page) return;
    pageInHistory = false;
    closeConnectionPopup({ immediate: true, keepHistory: true });
  });
  document.addEventListener('click', (e) => {
    if (!pop?.page || !e.target?.closest?.('.nav a')) return;
    pageInHistory = false;
    closeConnectionPopup({ immediate: true, keepHistory: true });
  }, true);
}

function mount(ctx, label, sheetClass = 'cp-sheet', { returnFocus: inheritedFocus = null, page = false } = {}) {
  closeConnectionPopup({ immediate: true, quiet: true, keepHistory: page });
  const returnFocus = inheritedFocus
    || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const el = document.createElement('div');
  if (page) {
    el.className = 'st-root cp-root cp-page';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', label);
    el.innerHTML = `<div class="ap-in cp-in">${pageBarHtml(ctx.esc, backLabelNow(), { backAttr: 'data-cp-close', backClass: 'is-in' })}<div class="st-wait" role="status"><div class="spin" aria-hidden="true"></div></div></div>`;
    document.body.appendChild(el);
    document.documentElement.classList.add('st-lock');
    if (!pageInHistory) {
      try { history.pushState(history.state, '', location.href); pageInHistory = true; } catch { /* history off */ }
    }
  } else {
    el.className = 'st-root cp-root';
    el.innerHTML = `
    <div class="st-veil" data-cp-close></div>
    <div class="st-sheet ${sheetClass}" role="dialog" aria-label="${ctx.esc(label)}">
      <div class="ap-in cp-in"><div class="st-wait" role="status"><div class="spin" aria-hidden="true"></div></div></div>
      <button type="button" class="st-x" data-cp-close aria-label="Close">${X_ICON}</button>
    </div>`;
    placeInline(el); // opens under the row that was clicked, not over the page
  }
  pop = { el, ctx, returnFocus, changed: false, page, backLabel: page ? backLabelNow() : '' };
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-cp-close]')) closeConnectionPopup();
  });
  el.addEventListener('keydown', onKeydown);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-open')));
  if (!page) el.querySelector('.st-x')?.focus({ preventScroll: true });
  return pop;
}

function onKeydown(e) {
  if (!pop) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    // On the connection page, Esc goes back one level like the back arrow.
    if (pop.page && pop.view && pop.view !== 'main') {
      const from = pop.view;
      pop.view = 'main';
      pop.tab = 'overview';
      paintConnection(pop, `[data-cp-go="${from}"]`);
      return;
    }
    closeConnectionPopup();
    return;
  }
  // Inline panels and the connection page are part of the page: Tab moves on like any other content.
  if (e.key !== 'Tab' || pop.page || pop.el.classList.contains('xp-panel')) return;
  const items = [...pop.el.querySelectorAll(FOCUSABLE_SELECTOR)]
    .filter((n) => n.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!pop.el.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return;
  }
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

export function closeConnectionPopup({ immediate = false, quiet = false, keepHistory = false } = {}) {
  if (!pop) return;
  const { el, ctx, returnFocus, changed, page } = pop;
  pop = null;
  if (page && pageInHistory && !keepHistory) {
    pageInHistory = false;
    try { history.back(); } catch { /* history off */ }
  }
  // Leave scroll lock active if Settings or another .st-root popup is still open.
  if (!document.querySelector('.st-root:not(.cp-root)')) {
    document.documentElement.classList.remove('st-lock');
  }
  el.classList.remove('is-open');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (immediate || reduced) el.remove();
  else setTimeout(() => el.remove(), CLOSE_MS);
  if (!immediate && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  if (!quiet) ctx.onClose?.(changed);
}

const inner = (p) => p.el.querySelector('.cp-in');
const alive = (p) => pop === p;

function transitionToConnection(p, connId, opts = {}) {
  const { ctx, returnFocus } = p;
  const nextCtx = { ...ctx, onClose: () => ctx.onClose?.(true) };
  p.changed = false; // the follow-up popup reports changed=true when it closes
  closeConnectionPopup({ immediate: true, quiet: true, keepHistory: true });
  return openConnectionPopup(nextCtx, connId, { ...opts, _returnFocus: returnFocus });
}

/* ---------- 1. Connection configuration popup ---------- */

export async function openConnectionPopup(ctx, connId, opts = {}) {
  const p = mount(ctx, 'Connection', 'cp-sheet', { returnFocus: opts?._returnFocus || null, page: true });
  p.kind = 'connection';
  p.connId = String(connId || '');
  p.tab = opts?.tab === 'tools' ? 'tools' : 'overview';
  p.view = p.tab === 'tools' ? 'tools' : 'main';
  p.autoSignIn = Boolean(opts?.autoSignIn);
  p.connectAccount = Boolean(opts?.connectAccount);
  p.focusCredentials = Boolean(opts?.focusCredentials);
  p.authModeHint = opts?.authModeHint || null;
  p.oauthError = opts?.oauthError
    ? (typeof ctx?.formatOAuthError === 'function' ? ctx.formatOAuthError(opts.oauthError) : String(opts.oauthError))
    : '';
  p.oauthResult = opts?.oauthResult && typeof opts.oauthResult === 'object' ? opts.oauthResult : null;
  p.toolQuery = '';
  p.openTesters = new Map();
  p.confirmRemove = false;
  p.credOpen = false;
  p.credTab = null;
  p.credDraft = null;
  p.agents = [];
  p.syncing = false;
  p.removing = false;
  p.savingDesc = false;
  p.savingKey = false;
  p.savingLogin = false;
  p.startingOAuth = false;
  await loadConnection(p);
}

async function loadConnection(p, focus = null) {
  const { api, esc } = p.ctx;
  let mcpsData;
  let policiesRes;
  let agentsRes;
  let servicesRes;
  try {
    [mcpsData, policiesRes, agentsRes, servicesRes] = await Promise.all([
      api('/api/mcps'),
      api('/api/policies').catch(() => null),
      api('/api/agents').catch(() => null),
      api('/api/services').catch(() => null),
    ]);
  } catch (err) {
    if (!alive(p)) return;
    inner(p).innerHTML = `${p.page ? pageBarHtml(esc, p.backLabel || 'Back', { backAttr: 'data-cp-close' }) : ''}
      <div class="ap-msg">
        <p>${esc(err.message || 'Could not load connection.')}</p>
        <button type="button" class="btn sm" data-cp-retry>Try again</button>
        <button type="button" class="btn sm ghost" data-cp-close>Back</button>
      </div>`;
    inner(p).querySelector('[data-cp-retry]')?.addEventListener('click', () => loadConnection(p));
    return;
  }
  if (!alive(p)) return;

  const list = Array.isArray(mcpsData?.mcps) ? mcpsData.mcps : [];
  const rawMcp = list.find((m) => m.id === p.connId);
  if (!rawMcp) {
    inner(p).innerHTML = `${p.page ? pageBarHtml(esc, p.backLabel || 'Back', { backAttr: 'data-cp-close' }) : ''}
      <div class="ap-msg">
        <p>This connection is no longer in Loop.</p>
        <button type="button" class="btn sm" data-cp-close>Back</button>
      </div>`;
    return;
  }

  const policies = policiesRes?.policies || mcpsData?.policies || {};
  const toolApprovals = {
    ...(policies?.tools && typeof policies.tools === 'object' ? policies.tools : {}),
    ...(mcpsData?.toolApprovals && typeof mcpsData.toolApprovals === 'object' ? mcpsData.toolApprovals : {}),
  };

  p.mcpsData = mcpsData;
  p.localConnectLinked = Boolean(mcpsData?.localConnectLinked);
  p.policies = { ...policies, tools: toolApprovals };
  p.toolApprovals = toolApprovals;
  p.profileRecords = extractProfiles(mcpsData);
  p.agents = Array.isArray(agentsRes?.agents) ? agentsRes.agents : [];
  p.service = (Array.isArray(servicesRes?.services) ? servicesRes.services : [])
    .find((svc) => Array.isArray(svc.accounts) && svc.accounts.some((acc) => acc.connectionId === p.connId)) || null;
  // Right after Add account (and its sign-in), the new account asks which agents use it.
  try {
    if (sessionStorage.getItem(PICK_AGENTS_KEY) === p.connId && (p.service?.accounts?.length || 0) > 1) p.pickAgents = true;
  } catch { /* storage off */ }
  p.mcp = {
    ...rawMcp,
    approval: normApproval(p.ctx, rawMcp.approval ?? policies?.connections?.[rawMcp.id], 'inherit'),
    ...(rawMcp.lent ? { lentOwner: p.ctx.lentBy?.(rawMcp.id) || '' } : {}),
  };
  p.categories = buildCategoriesList(mcpsData, policiesRes, p.mcp);

  if (!p.credTab) p.credTab = defaultCredTab(p.mcp, p.authModeHint);
  if (!p.credDraft) {
    const eligible = eligibleAgentsForConn(p.agents, p.mcp);
    const sharedIds = p.mcp.agentLogin?.vaultKey
      ? eligible.filter((a) => Array.isArray(a.secrets) && a.secrets.includes(p.mcp.agentLogin.vaultKey)).map((a) => a.id)
      : [];
    p.credDraft = {
      headerMode: 'bearer',
      customHeader: '',
      token: '',
      origin: suggestLoginOrigin(p.mcp),
      username: p.mcp.agentLogin?.username || '',
      password: '',
      clientId: '',
      clientSecret: '',
      agentIds: new Set(sharedIds.length > 0 ? sharedIds : eligible.map((a) => a.id)),
    };
  }
  if (p.focusCredentials || p.mcp.tokenRejected || (p.mcp.authRequired && p.mcp.signInBroken && !p.mcp.agentLogin)) {
    p.credOpen = true;
  }

  const initialFocus = focus
    || (p.tab === 'tools' ? '#cp-tool-q' : null)
    || (p.focusCredentials ? credFocusSelector(p.credTab) : null)
    || (showConnectCard(p) ? '[data-cp-connect-form] input[name="accountLabel"]' : null);
  p.focusCredentials = false;
  paintConnection(p, initialFocus);

  if (p.autoSignIn) {
    p.autoSignIn = false;
    if (p.mcp.readiness?.action === 'sign_in') {
      await startConnectionOAuth(p);
    } else if (p.mcp.tokenRejected || (p.mcp.authRequired && p.mcp.signInBroken)) {
      p.credOpen = true;
      paintConnection(p, credFocusSelector(p.credTab));
    }
  }
}

function credFocusSelector(tab) {
  if (tab === 'agent_login') return '[data-cp-login-form] input[name="username"]';
  if (tab === 'oauth_client') return '[data-cp-oauth-client-form] input[name="clientId"]';
  return '[data-cp-key-form] input[name="token"]';
}

function paintConnection(p, focus = null) {
  const { esc } = p.ctx;
  const { mcp } = p;
  const counts = toolCountsOf(p.ctx, mcp);
  const view = p.view === 'tools' || p.view === 'more' ? p.view : 'main';
  const backLabel = view === 'main' ? (p.backLabel || 'Back') : mcp.name;
  const body = view === 'tools' ? toolsPageHtml(p, counts) : view === 'more' ? morePageHtml(p) : mainPageHtml(p, counts);
  const firstPaint = !p.painted;
  p.painted = true;
  // Slide only when the view changes, not when a status refresh paints the same view again.
  const moved = !firstPaint && p.paintedView && p.paintedView !== view;
  const dir = firstPaint ? 'is-fwd' : moved ? (view === 'main' ? 'is-bwd' : 'is-fwd') : '';
  p.paintedView = view;
  inner(p).innerHTML = `
    ${pageBarHtml(esc, backLabel, { backClass: moved ? 'is-in' : '' })}
    <div class="cp-pg ${dir}" data-view="${esc(view)}">${body}</div>`;
  p.el.setAttribute('aria-label', view === 'main' ? mcp.name : `${mcp.name}: ${view === 'tools' ? 'Tools' : 'More settings'}`);
  bindConnection(p);
  bindPage(p);
  if (focus) p.el.querySelector(focus)?.focus({ preventScroll: true });
  else if (firstPaint) p.el.querySelector('[data-cp-back]')?.focus({ preventScroll: true });
}

const LINE_ICONS = {
  power: '<path d="M12 3v8"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
  tools: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 10l3 2.5L7 15M12.5 15H17"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
};
const LINE_CHEV = '<svg class="cp-line-chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 3l3 3-3 3"/></svg>';
const LINE_DOWN = '<svg class="cp-line-chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg>';

// One 48px line of the connection page: icon lane, name, quiet value, and a tail.
function lineHtml(esc, { icon, name, value = '', tail = 'chev', attrs = '', tone = '', tag = 'button', mono = false, expanded = null }) {
  const ic = `<span class="cp-line-ic" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${LINE_ICONS[icon] || ''}</svg></span>`;
  const end = tail === 'chev' ? LINE_CHEV : tail === 'down' ? LINE_DOWN : (tail && tail !== 'none' ? tail : '');
  const val = value ? `<span class="cp-line-v ${mono ? 'mono' : ''}">${esc(value)}</span>` : '';
  const exp = expanded === null ? '' : ` aria-expanded="${expanded}"`;
  const inside = `${ic}<span class="cp-line-n">${esc(name)}</span>${val}${end}`;
  return tag === 'button'
    ? `<button type="button" class="cp-line ${tone ? `is-${tone}` : ''}" ${attrs}${exp}>${inside}</button>`
    : `<div class="cp-line ${tone ? `is-${tone}` : ''}" ${attrs}>${inside}</div>`;
}

// The page says how the connection is in one line, with at most one fix beside it.
function pageStatus(p, counts) {
  const { mcp } = p;
  const r = mcp.readiness || {};
  const isStdio = getTransport(mcp) === 'stdio';
  const sync = (label) => `<button type="button" class="btn sm" data-cp-sync ${p.syncing ? 'disabled' : ''}>${p.syncing ? 'Trying…' : label}</button>`;
  const post = postSignInFailure(p);
  if (mcp.enabled === false) return { cls: '', text: 'Off. Agents cannot use it.', action: '' };
  if (r.action === 'sign_in' && !mcp.signInBroken) {
    return { cls: 'warn', text: 'Needs sign-in', action: `<button type="button" class="btn sm fill cp-signin" data-cp-oauth ${p.startingOAuth ? 'disabled' : ''}>${p.startingOAuth ? 'Signing in…' : 'Sign in'}</button>` };
  }
  if (mcp.tokenRejected) return { cls: 'no', text: 'The saved key does not work', action: '' };
  if (post) return { cls: 'no', text: post.bannerTitle, action: post.canRetry ? sync('Try again') : '' };
  if (mcp.readiness?.state === 'unsupported_workspace') return { cls: 'no', text: 'Cannot run in hosted mode', action: '' };
  if (mcp.lastError && !mcp.authRequired) {
    return { cls: 'warn', text: isStdio ? 'Can’t start on this computer' : 'Can’t reach the server', action: sync('Try again') };
  }
  if (!r.ready && (r.state === 'no_tools' || r.state === 'not_synced')) return { cls: 'warn', text: r.label || 'No tools yet', action: sync('Refresh') };
  if (!r.ready) return { cls: r.state === 'disabled' ? '' : 'warn', text: r.label || 'Not ready', action: '' };
  const tools = `${counts.total} ${counts.total === 1 ? 'tool' : 'tools'}`;
  if (mcp.lent) return { cls: 'ok', text: `Ready · ${tools} from ${mcp.lentOwner || 'another Loop'}`, action: '' };
  // "Read succeeded" only after an actual read went through.
  const proof = mcp.readEvidence;
  if (proof?.connectionId === mcp.id && proof.succeededAt) return { cls: 'ok', text: `Ready · ${tools} · Read succeeded`, action: '' };
  return { cls: 'ok', text: `Ready · ${tools}`, action: '' };
}

function postSignInFailure(p) {
  const { mcp } = p;
  if (!p.oauthResult || mcp.readiness?.ready) return null;
  const summary = postSignInSummary({
    ...p.oauthResult,
    name: mcp.name || p.oauthResult.name,
    readiness: mcp.readiness || p.oauthResult.readiness,
    discoveryError: mcp.lastError || p.oauthResult.discoveryError,
    readEvidence: mcp.readEvidence || p.oauthResult.readEvidence || null,
  });
  return summary && !summary.ready ? summary : null;
}

const STATUS_CLS = { ok: 'is-ok', warn: 'is-warn', no: 'is-no' };

function mainPageHtml(p, counts) {
  const { esc, renderConnLogo } = p.ctx;
  const { mcp } = p;
  const st = pageStatus(p, counts);
  const logoHtml = typeof renderConnLogo === 'function' ? renderConnLogo(mcp, { badge: true }) : '';
  const isStdio = getTransport(mcp) === 'stdio';
  const isBuiltin = getTransport(mcp) === 'builtin';
  const isRelay = typeof mcp.url === 'string' && mcp.url.startsWith('https://relay.useloop.sh/d/');
  const isCloudHome = Boolean(mcp.home === 'cloud' || mcp.cloudRouted || (isPersonal(p.ctx) && !isStdio && !isRelay));
  // Cloud or Local shows here, on the connection's own page. Home rows show it only as the logo's badge.
  const runsAt = isCloudHome ? 'Cloud' : (isStdio || isRelay ? 'Local' : '');
  const tags = [
    mcp.accountLabel && !(p.service?.accounts?.length > 1) ? `<span class="cp-loc-pill">${esc(mcp.accountLabel)}</span>` : '',
    runsAt ? `<span class="cp-loc-pill is-${runsAt.toLowerCase()}">${runsAt}</span>` : '',
  ].filter(Boolean).join('');

  // Approval: the value says the rule in use; the three modes open under the line.
  const connApproval = normApproval(p.ctx, mcp.approval, 'inherit');
  const effective = getEffectiveConnApproval(p.ctx, mcp, p.policies);
  const approvalValue = connApproval === 'inherit' ? `${modeLabel(effective)} (default)` : modeLabel(connApproval);
  const approvalOpen = Boolean(p.approvalOpen);

  const toolsValue = counts.total
    ? `${counts.enabled} of ${counts.total} on`
    : st.cls === 'ok' ? 'None' : 'Shows when it works';

  const stdioCmd = isStdio ? [mcp.command || '', ...(Array.isArray(mcp.args) ? mcp.args : [])].filter(Boolean).join(' ') : '';
  let where = { name: 'Runs', value: stdioCmd, icon: 'terminal', mono: true };
  if (isBuiltin) where = { name: 'Runs', value: 'Built into Loop', icon: 'terminal', mono: false };
  else if (mcp.lent) where = { name: 'Lent by', value: mcp.lentOwner || 'Another Loop', icon: 'globe', mono: false };
  else if (!isStdio) {
    let host = mcp.url || '';
    try { host = new URL(mcp.url).host; } catch { /* keep the raw value */ }
    where = { name: 'Server', value: host, icon: 'globe', mono: true };
  }

  const r = mcp.readiness || {};
  const post = postSignInFailure(p);
  const errText = post?.bannerDetail || mcp.lastError || (r.state === 'unsupported_workspace' ? r.nextStep : '') || '';
  const hasError = Boolean(errText || r.handoff);
  const errOpen = Boolean(p.errorOpen);
  const category = (p.categories || []).find((c) => c.id === (mcp.category || 'general'));
  const signedIn = (mcp.appSignIns || []).filter((s) => s.state === 'ready').map((s) => formatAppSignInName(s)).filter(Boolean).join(', ');

  return `
    <header class="cp-top cp-ph" ${post ? 'data-cp-post-signin-error' : ''}>
      <button type="button" class="cp-logo-btn" data-cp-logo title="Change logo" aria-label="Change logo for ${esc(mcp.name)}">
        ${logoHtml}
        <span class="cp-logo-edit" aria-hidden="true">${PENCIL_ICON}</span>
      </button>
      <div class="cp-top-c">
        <h2 class="cp-name" id="cp-title"><span>${esc(mcp.name)}</span>${tags}</h2>
        <div class="ap-st cp-st ${STATUS_CLS[st.cls] || ''}">${st.cls ? '<i aria-hidden="true"></i>' : ''}${esc(st.text)}</div>
      </div>
      ${st.action && !showConnectCard(p) ? `<div class="cp-top-r">${st.action}</div>` : ''}
    </header>
    ${connectCardHtml(p)}
    ${appSignInsHtml(p)}
    ${pageAlertsHtml(p)}
    ${namePendingHtml(p)}
    ${accountsHtml(p)}
    <section class="cp-sec cp-pg-sec" aria-labelledby="cp-set-t">
      <h3 class="cp-sec-t" id="cp-set-t">Settings</h3>
      <div class="cp-lines">
        ${lineHtml(esc, {
          icon: 'power', name: 'On', tag: 'div',
          tail: `<button type="button" class="sw ${mcp.enabled ? 'on' : ''}" role="switch" aria-checked="${Boolean(mcp.enabled)}" aria-label="Agents can use ${esc(mcp.name)}" data-cp-toggle><span class="sw-knob" aria-hidden="true"></span></button>`,
        })}
        ${lineHtml(esc, { icon: 'shield', name: 'Approval', value: approvalValue, tail: approvalOpen ? 'down' : 'chev', attrs: 'data-cp-approval-open', expanded: approvalOpen })}
        ${approvalOpen ? `<div class="cp-approval cp-line-x">${rule(esc, 'Before a tool runs', approvalDescOf(p), seg(esc, 'approval', APPROVAL_OPTIONS, connApproval, `Approval rule for ${mcp.name}`))}</div>` : ''}
        ${lineHtml(esc, { icon: 'tools', name: 'Tools', value: toolsValue, tail: counts.total ? 'chev' : 'none', tag: counts.total ? 'button' : 'div', attrs: counts.total ? 'data-cp-go="tools"' : '' })}
      </div>
    </section>
    <section class="cp-sec cp-pg-sec" aria-labelledby="cp-det-t">
      <h3 class="cp-sec-t" id="cp-det-t">Details</h3>
      <div class="cp-lines">
        ${where.value ? lineHtml(esc, { icon: where.icon, name: where.name, value: where.value, tail: 'none', tag: 'div', mono: where.mono }) : ''}
        ${signedIn ? lineHtml(esc, { icon: 'globe', name: 'Signed in to', value: signedIn, tail: 'none', tag: 'div' }) : ''}
        ${hasError ? lineHtml(esc, { icon: 'alert', name: 'Last error', value: errOpen ? 'Hide' : 'Show', tail: errOpen ? 'down' : 'chev', attrs: 'data-cp-err-open', expanded: errOpen }) : ''}
        ${hasError && errOpen ? `
          <div class="cp-line-x cp-err">
            ${errText ? `<pre class="cp-err-msg">${esc(errText)}</pre>` : ''}
            ${r.nextStep && r.nextStep !== errText ? `<p class="st-rs">${esc(r.nextStep)}</p>` : ''}
            ${r.handoff ? '<div class="cp-acc-acts"><button type="button" class="btn sm" data-cp-copy-handoff>Copy a repair request for your agent</button></div>' : ''}
          </div>` : ''}
        ${lineHtml(esc, { icon: 'sliders', name: 'More settings', value: category?.label || '', attrs: 'data-cp-go="more"' })}
        ${p.confirmRemove ? removeHtml(p) : lineHtml(esc, { icon: 'trash', name: 'Remove connection', tone: 'no', tail: 'none', attrs: 'data-cp-remove' })}
      </div>
    </section>`;
}

// Only what needs the owner now: a failed sign-in and the sign-in or key form.
function pageAlertsHtml(p) {
  const { esc } = p.ctx;
  const oauthErr = p.oauthError ? `
    <div class="callout bad cp-alert" role="alert">
      <div class="cp-alert-row">
        <div class="cp-alert-copy">
          <strong>Sign-in failed</strong>
          <p class="cp-alert-sub">${esc(p.oauthError)}</p>
        </div>
        <button type="button" class="btn sm ghost" data-cp-dismiss-oauth-err>Dismiss</button>
      </div>
    </div>` : '';
  return `${oauthErr}${credentialsCardHtml(p)}`;
}

function toolsPageHtml(p, counts) {
  const { esc } = p.ctx;
  return `
    <div class="cp-pg-h">
      <h2 class="cp-pg-t" id="cp-title">Tools</h2>
      <p class="cp-pg-sub">An agent sees only the tools that are on.</p>
    </div>
    ${toolsPaneHtml(p, counts)}`;
}

function morePageHtml(p) {
  const { esc } = p.ctx;
  return `
    <div class="cp-pg-h">
      <h2 class="cp-pg-t" id="cp-title">More settings</h2>
      <p class="cp-pg-sub">${esc(p.mcp.name)}</p>
    </div>
    ${settingsHtml(p)}`;
}

function bindPage(p) {
  const el = p.el;
  el.querySelector('[data-cp-back]')?.addEventListener('click', () => {
    if (p.view && p.view !== 'main') {
      const from = p.view;
      p.view = 'main';
      p.tab = 'overview';
      paintConnection(p, `[data-cp-go="${from}"]`);
      return;
    }
    closeConnectionPopup();
  });
  el.querySelector('.cp-pg-logo')?.addEventListener('click', (e) => {
    e.preventDefault();
    closeConnectionPopup();
    if (location.hash !== '#home') location.hash = '#home';
  });
  el.querySelectorAll('[data-cp-go]').forEach((btn) => btn.addEventListener('click', () => {
    p.view = btn.dataset.cpGo === 'tools' ? 'tools' : 'more';
    p.tab = p.view === 'tools' ? 'tools' : 'overview';
    paintConnection(p, '[data-cp-back]');
    p.el.scrollTop = 0;
  }));
  el.querySelector('[data-cp-approval-open]')?.addEventListener('click', () => {
    p.approvalOpen = !p.approvalOpen;
    paintConnection(p, '[data-cp-approval-open]');
  });
  el.querySelector('[data-cp-err-open]')?.addEventListener('click', () => {
    p.errorOpen = !p.errorOpen;
    paintConnection(p, '[data-cp-err-open]');
  });
}

function credentialsCardHtml(p) {
  const { esc } = p.ctx;
  const { mcp } = p;
  const isRemote = getTransport(mcp) !== 'stdio' && getTransport(mcp) !== 'builtin';
  if (!isRemote) return '';

  // Saved agent login calm summary (when not currently editing)
  if (mcp.agentLogin && !p.credOpen && !mcp.tokenRejected) {
    const eligible = eligibleAgentsForConn(p.agents, mcp);
    const sharedNames = eligible
      .filter((a) => Array.isArray(a.secrets) && a.secrets.includes(mcp.agentLogin.vaultKey))
      .map((a) => a.name);
    const detailParts = [
      mcp.agentLogin.username || '',
      mcp.agentLogin.origin || '',
    ].filter(Boolean);
    return `
      <div class="callout cp-alert cp-signin-saved" role="status">
        <div class="cp-alert-row">
          <div class="cp-alert-copy">
            <strong>Agent login saved in Vault</strong>
            <p class="cp-alert-sub">${esc(detailParts.join(' · '))}${sharedNames.length ? ` · Shared with ${esc(sharedNames.join(', '))}` : ''}</p>
          </div>
          <div class="cp-signin-saved-acts">
            <button type="button" class="btn sm" data-cp-edit-login>Update login</button>
            <button type="button" class="btn sm ghost" data-cp-open-creds="api_key">API key / OAuth</button>
          </div>
        </div>
      </div>`;
  }

  // Instant OAuth is available and the user hasn't expanded manual input fields yet
  if (mcp.readiness?.action === 'sign_in' && !mcp.signInBroken && !p.credOpen) {
    return `
      <div class="cp-alt-bar">
        <span>${showConnectCard(p) ? 'To use a key instead, you can' : 'Click <strong>Sign in</strong> above for one-click sign-in, or'}</span>
        <button type="button" class="ap-link" data-cp-open-creds="api_key">enter credentials or a login for your agent</button>
      </div>`;
  }

  if (!p.credOpen && !mcp.tokenRejected) return '';

  const draft = p.credDraft || {
    headerMode: 'bearer', customHeader: '', token: '', origin: suggestLoginOrigin(mcp),
    username: '', password: '', clientId: '', clientSecret: '', agentIds: new Set(),
  };
  const tab = p.credTab || defaultCredTab(mcp, p.authModeHint);
  const canHide = !mcp.tokenRejected && !(mcp.authRequired && mcp.signInBroken && !mcp.agentLogin);
  const callbackUrl = `${location.origin}/oauth/callback`;
  const eligible = eligibleAgentsForConn(p.agents, mcp);

  const heading = mcp.tokenRejected
    ? 'Token rejected — enter new credentials'
    : `Connect ${mcp.name}`;
  const sub = mcp.tokenRejected
    ? 'This server rejected the saved key. Paste a replacement token — it moves to your encrypted Vault automatically.'
    : tab === 'agent_login'
      ? 'Enter your account login so your agent can sign in for you. Saved encrypted in Vault and locked to this site.'
      : tab === 'oauth_client'
        ? 'Enter your OAuth app credentials and Loop will open sign-in immediately.'
        : 'Paste an API key or token. Loop saves it encrypted in Vault and connects right away.';

  let formHtml = '';
  if (tab === 'agent_login') {
    formHtml = `
      <form class="form-grid cp-signin-form" data-cp-login-form>
        <label class="field">
          <span class="lbl">Sign-in website</span>
          <input type="url" name="origin" required placeholder="https://mail.google.com" value="${esc(draft.origin)}" autocomplete="url" ${p.savingLogin ? 'disabled' : ''}>
        </label>
        <div class="form-row">
          <label class="field">
            <span class="lbl">Email or username</span>
            <input type="text" name="username" placeholder="you@example.com" value="${esc(draft.username)}" autocomplete="username" ${p.savingLogin ? 'disabled' : ''}>
          </label>
          <label class="field">
            <span class="lbl">Password</span>
            <input type="password" name="password" required placeholder="Account password" value="${esc(draft.password)}" autocomplete="current-password" ${p.savingLogin ? 'disabled' : ''}>
          </label>
        </div>
        ${eligible.length > 0 ? `
          <div class="field">
            <span class="lbl">Share login with agents</span>
            <div class="pf-chips cp-agent-chips" role="group" aria-label="Agents that can use this login">
              ${eligible.map((a) => {
                const on = draft.agentIds instanceof Set ? draft.agentIds.has(a.id) : true;
                return `<button type="button" class="pf-chip" data-cp-login-agent="${esc(a.id)}" aria-pressed="${on}" ${p.savingLogin ? 'disabled' : ''}>
                  <span class="pf-chip-ic" aria-hidden="true">${on ? CHECK_ICON : ''}</span>
                  <span>${esc(a.name)}</span>
                </button>`;
              }).join('')}
            </div>
          </div>
        ` : ''}
        <div class="cp-signin-acts">
          <button type="submit" class="btn sm fill" ${p.savingLogin ? 'disabled' : ''}>${p.savingLogin ? 'Saving…' : 'Save login for agent'}</button>
        </div>
      </form>`;
  } else if (tab === 'oauth_client') {
    formHtml = `
      <form class="form-grid cp-signin-form" data-cp-oauth-client-form>
        <div class="form-row">
          <label class="field">
            <span class="lbl">Client ID</span>
            <input type="text" name="clientId" required placeholder="Paste OAuth Client ID" value="${esc(draft.clientId)}" autocomplete="off" spellcheck="false" ${p.startingOAuth ? 'disabled' : ''}>
          </label>
          <label class="field">
            <span class="lbl">Client Secret (optional)</span>
            <input type="password" name="clientSecret" placeholder="Paste OAuth Client Secret" value="${esc(draft.clientSecret)}" autocomplete="new-password" ${p.startingOAuth ? 'disabled' : ''}>
          </label>
        </div>
        <div class="cp-callback-row">
          <span class="cp-callback-lbl">Callback URL</span>
          <code class="inline-code">${esc(callbackUrl)}</code>
          <button type="button" class="btn sm ghost" data-cp-copy-callback="${esc(callbackUrl)}">Copy</button>
        </div>
        <div class="cp-signin-acts">
          <button type="submit" class="btn sm fill" ${p.startingOAuth ? 'disabled' : ''}>${p.startingOAuth ? 'Opening sign-in…' : 'Continue to sign in'}</button>
        </div>
      </form>`;
  } else {
    formHtml = `
      <form class="form-grid cp-signin-form" data-cp-key-form>
        <div class="cp-key-row">
          <label class="field cp-key-token-field">
            <span class="lbl">${draft.headerMode === 'bearer' ? 'API key or Bearer token' : 'Header value'}</span>
            <input type="password" name="token" required placeholder="Paste API key or bearer token" value="${esc(draft.token)}" autocomplete="new-password" aria-label="API key or token for ${esc(mcp.name)}" ${p.savingKey ? 'disabled' : ''}>
          </label>
          <label class="field cp-key-header-field">
            <span class="lbl">Send as</span>
            <select name="headerMode" class="ap-select" ${p.savingKey ? 'disabled' : ''}>
              <option value="bearer" ${draft.headerMode === 'bearer' ? 'selected' : ''}>Bearer token</option>
              <option value="X-Api-Key" ${draft.headerMode === 'X-Api-Key' ? 'selected' : ''}>X-Api-Key</option>
              <option value="Api-Key" ${draft.headerMode === 'Api-Key' ? 'selected' : ''}>Api-Key</option>
              <option value="custom" ${draft.headerMode === 'custom' ? 'selected' : ''}>Custom header</option>
            </select>
          </label>
        </div>
        ${draft.headerMode === 'custom' ? `
          <label class="field">
            <span class="lbl">Header name</span>
            <input type="text" name="customHeader" required placeholder="e.g. X-Auth-Token" value="${esc(draft.customHeader)}" autocomplete="off" spellcheck="false" ${p.savingKey ? 'disabled' : ''}>
          </label>
        ` : ''}
        <div class="cp-signin-acts">
          <button type="submit" class="btn sm fill" ${p.savingKey ? 'disabled' : ''}>${p.savingKey ? 'Connecting…' : 'Save & connect'}</button>
        </div>
      </form>`;
  }

  return `
    <div class="callout ${mcp.tokenRejected ? 'bad' : ''} cp-alert cp-signin-card" role="${mcp.tokenRejected ? 'alert' : 'region'}" aria-label="Connect ${esc(mcp.name)}">
      <div class="cp-signin-head">
        <div class="cp-alert-copy">
          <strong>${esc(heading)}</strong>
          <p class="cp-alert-sub">${esc(sub)}</p>
        </div>
        ${canHide ? '<button type="button" class="ap-link cp-signin-hide" data-cp-close-creds>Hide</button>' : ''}
      </div>
      <div class="cp-signin-tabs">
        <span class="st-seg" role="tablist" aria-label="Sign-in method">
          <button type="button" role="tab" data-cp-cred-tab="api_key" aria-selected="${tab === 'api_key'}" aria-pressed="${tab === 'api_key'}">API key</button>
          <button type="button" role="tab" data-cp-cred-tab="agent_login" aria-selected="${tab === 'agent_login'}" aria-pressed="${tab === 'agent_login'}">Agent login</button>
          <button type="button" role="tab" data-cp-cred-tab="oauth_client" aria-selected="${tab === 'oauth_client'}" aria-pressed="${tab === 'oauth_client'}">OAuth app</button>
        </span>
      </div>
      ${formHtml}
    </div>`;
}

// An agent added or renamed this connection: its name stays out of other agents' startup
// context until the owner approves it (lib/context-names.mjs).
function namePendingHtml(p) {
  const { esc } = p.ctx;
  const { mcp } = p;
  if (!mcp.namePending) return '';
  const who = mcp.addedBy?.name || 'An agent';
  return `
    <div class="callout cp-alert" role="status">
      <div class="cp-alert-row">
        <div class="cp-alert-copy">
          <strong>Added by ${esc(who)}</strong>
          <p class="cp-alert-sub">Other agents find it by searching, but its name stays out of their startup context until you approve it.</p>
        </div>
        <button type="button" class="btn sm" data-cp-approve-name ${p.approvingName ? 'disabled' : ''}>${p.approvingName ? 'Approving…' : 'Approve name'}</button>
      </div>
    </div>`;
}

function formatAppSignInName(s) {
  const base = s?.app || s?.host || '';
  if (!base) return '';
  if (s?.accountLabel && !base.toLowerCase().includes(String(s.accountLabel).toLowerCase())) {
    return `${base} (${s.accountLabel})`;
  }
  return base;
}

// Sign-ins that this connection asked for during a call, for an app behind it. The whole address is
// shown before it opens (lib/app-sign-ins.mjs).
function appSignInsHtml(p) {
  const { esc } = p.ctx;
  const open = (p.mcp.appSignIns || []).filter((s) => s.state === 'open');
  return open.map((s) => {
    const named = formatAppSignInName(s);
    const title = s.app ? `Sign in to ${named}` : `${p.mcp.name} asks for a sign-in`;
    const acctDetail = s.accountId ? `Account ID: ${s.accountId}` : '';
    const who = s.askedBy ? `${s.askedBy} needs it.` : '';
    const says = !s.app && s.message ? `It says: “${s.message}”` : '';
    if (!s.url) {
      return `
    <div class="callout cp-alert" role="status" data-cp-app-signin-row="${esc(s.id)}">
      <div class="cp-alert-row">
        <div class="cp-alert-copy">
          <strong>${esc(title)}</strong>
          <p class="cp-alert-sub">${esc([acctDetail, 'The link has ended. Ask your agent to try again.'].filter(Boolean).join(' · '))}</p>
        </div>
        <button type="button" class="btn sm ghost" data-cp-app-remove="${esc(s.id)}" aria-label="Remove: ${esc(title)}">Remove</button>
      </div>
    </div>`;
    }
    const sub = s.opened
      ? [acctDetail, 'Pending confirmation. When you are done, tell your agent.'].filter(Boolean).join(' · ')
      : [acctDetail, who, says].filter(Boolean).join(' · ');
    return `
    <div class="callout cp-alert" role="status" data-cp-app-signin-row="${esc(s.id)}">
      <div class="cp-alert-row">
        <div class="cp-alert-copy">
          <strong>${esc(title)}</strong>
          ${sub ? `<p class="cp-alert-sub">${esc(sub)}</p>` : ''}
        </div>
        <a class="btn sm ${s.opened ? '' : 'fill'}" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" data-cp-app-signin="${esc(s.id)}">${s.opened ? 'Open again' : 'Sign in'}</a>
      </div>
      <p class="cp-app-url mono">${esc(s.url)}</p>
    </div>`;
  }).join('');
}

/* ---------- Accounts: each sign-in of a service, and which agents use it ---------- */

const PICK_AGENTS_KEY = 'loop.pickAgentsFor';
const ACCOUNT_NAMES = ['Personal', 'Work', 'All projects', 'One project', 'Read-only'];
const ACC_CHEV = '<svg class="cp-acc-chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 3l3 3-3 3"/></svg>';
const ACC_OK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 8.4l3.1 3.1 6.5-6.8"/></svg>';

function canAddAccount(mcp) {
  const t = getTransport(mcp);
  return t !== 'stdio' && t !== 'builtin' && Boolean(mcp.url) && !mcp.lent;
}

function accountState(acc) {
  if (acc.enabled === false) return { cls: '', text: 'Off' };
  if (acc.ready) return { cls: 'is-ok', text: 'active' };
  return { cls: 'is-warn', text: 'Needs sign-in' };
}

function accountDisplayLabel(acc, many = false) {
  if (acc?.accountLabel) return acc.accountLabel;
  if (many) return 'Default';
  return acc?.label || acc?.name || 'Default';
}

// The agents that use one account: held to it, or allowed every account of the service.
function agentsOnAccount(p, connId) {
  const svc = p.service;
  if (!svc) return [];
  return svc.agents.filter((a) => a.connectionId === connId || (a.choice === 'any' && svc.accounts.length > 1));
}

function agentRowOf(p, id) {
  const raw = p.agents.find((a) => a.id === id);
  return raw ? { ...raw, agent: raw } : null;
}

function accountLabelOf(p, connId) {
  const many = (p.service?.accounts?.length || 0) > 1;
  const acc = p.service?.accounts.find((a) => a.connectionId === connId);
  return acc ? accountDisplayLabel(acc, many) : '';
}

// Connect (from a Home row): name the account first, then sign in. A service can have many accounts,
// for example three Google Calendars, so the name tells them apart.
function showConnectCard(p) {
  const { mcp } = p;
  return Boolean(p.connectAccount && mcp && mcp.enabled !== false && mcp.readiness?.action === 'sign_in' && !mcp.signInBroken);
}

function connectCardHtml(p) {
  if (!showConnectCard(p)) return '';
  const { esc } = p.ctx;
  const { mcp } = p;
  const others = (p.service?.accounts || []).filter((a) => a.connectionId !== p.connId);
  const taken = new Set(others.map((a) => String(a.accountLabel || '').toLowerCase()));
  const chips = ACCOUNT_NAMES.filter((n) => !taken.has(n.toLowerCase()));
  const draft = p.connectDraft ?? (mcp.accountLabel || '');
  const busy = Boolean(p.connectBusy || p.startingOAuth);
  return `
    <section class="cp-sec cp-connect" aria-labelledby="cp-connect-t">
      <h3 class="cp-sec-t" id="cp-connect-t">Connect ${esc(mcp.name)}</h3>
      <form class="cp-acc-add" data-cp-connect-form>
        <div class="cp-acc-inline">
          <input type="text" name="accountLabel" maxlength="60" placeholder="Account label (work, personal, project-x)" aria-label="Account label" autocomplete="off" value="${esc(draft)}">
          <button type="submit" class="btn sm fill" ${busy ? 'disabled' : ''}>${busy ? 'Connecting…' : 'Continue'}</button>
        </div>
        ${chips.length ? `<div class="cp-acc-chips">${chips.map((n) => `<button type="button" class="saved-pill" data-cp-connect-chip="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
        <p class="st-rs">Next, sign in to this account. To connect more accounts later, use Add account.</p>
      </form>
    </section>`;
}

function bindConnectCard(p) {
  const { api, toast } = p.ctx;
  const form = inner(p).querySelector('[data-cp-connect-form]');
  if (!form) return;
  const input = form.querySelector('input[name="accountLabel"]');
  input.addEventListener('input', () => { p.connectDraft = input.value; });
  form.querySelectorAll('[data-cp-connect-chip]').forEach((chip) => chip.addEventListener('click', () => {
    input.value = chip.dataset.cpConnectChip;
    p.connectDraft = input.value;
    input.focus();
  }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (p.connectBusy || p.startingOAuth) return;
    const accountLabel = String(input.value || '').trim();
    p.connectBusy = true;
    paintConnection(p);
    try {
      if (accountLabel !== String(p.mcp.accountLabel || '')) {
        const res = await api(`/api/mcps/${encodeURIComponent(p.connId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ accountLabel }),
        });
        if (!alive(p)) return;
        p.mcp = mergeMcp(p.mcp, res?.mcp || { accountLabel });
        p.mcp.accountLabel = res?.mcp?.accountLabel ?? accountLabel;
        p.changed = true;
      }
      p.connectBusy = false;
      await startConnectionOAuth(p);
    } catch (err) {
      if (!alive(p)) return;
      p.connectBusy = false;
      toast(err?.message || 'Could not save the account label.', 'err');
      paintConnection(p, '[data-cp-connect-form] input[name="accountLabel"]');
    }
  });
}

function accountsHtml(p) {
  const { esc } = p.ctx;
  const svc = p.service;
  if (!svc || !canAddAccount(p.mcp)) return '';
  const many = svc.accounts.length > 1;
  const firstUnnamed = svc.accounts.length === 1 && !svc.accounts[0]?.accountLabel;
  const rows = svc.accounts.map((acc) => {
    const st = accountState(acc);
    const users = agentsOnAccount(p, acc.connectionId);
    const marks = users.slice(0, 3).map((u) => {
      const row = agentRowOf(p, u.id);
      return row ? agentMark(row, esc, 'cp-acc-mark') : '';
    }).join('');
    const who = !many ? '' : users.length ? `${marks}<span>${users.length}</span>` : '<span>No agents</span>';
    const here = acc.connectionId === p.connId;
    const isDefault = acc.connectionId === svc.defaultConnectionId;
    const label = accountDisplayLabel(acc, many);
    const statusIcon = st.cls === 'is-ok'
      ? `<span class="cp-acc-check-ic" aria-hidden="true">${ACC_OK}</span>`
      : `<i class="cp-acc-dot ${st.cls}" aria-hidden="true"></i>`;
    const confirming = p.disconnectAccountId === acc.connectionId;
    const rowActions = !many ? '' : confirming ? `
      <div class="cp-acc-row-acts">
        <button type="button" class="btn sm" data-cp-acc-disconnect-yes="${esc(acc.connectionId)}" ${p.disconnectingAccount ? 'disabled' : ''}>${p.disconnectingAccount ? 'Removing…' : 'Remove'}</button>
        <button type="button" class="cp-acc-link" data-cp-acc-disconnect-no ${p.disconnectingAccount ? 'disabled' : ''}>Cancel</button>
      </div>` : `
      <div class="cp-acc-row-acts">
        ${!isDefault ? `<button type="button" class="cp-acc-link" data-cp-acc-default="${esc(acc.connectionId)}" ${p.settingDefault ? 'disabled' : ''}>Set default</button>` : ''}
        <button type="button" class="cp-acc-link is-no" data-cp-acc-disconnect="${esc(acc.connectionId)}">Disconnect</button>
      </div>`;
    return `<li class="cp-acc-item ${here ? 'is-here' : ''}"><button type="button" class="cp-acc ${here ? 'is-here' : ''}" data-cp-account="${esc(acc.connectionId)}" ${here ? 'aria-current="true"' : ''}>
      ${statusIcon}
      <span class="cp-acc-tx"><span class="cp-acc-l">${esc(label)}${many && isDefault ? '<small>Default</small>' : ''}</span><span class="cp-acc-d ${st.cls}">${esc(st.text)}</span></span>
      ${who ? `<span class="cp-acc-who">${who}</span>` : ''}
      ${here ? '' : ACC_CHEV}
    </button>${rowActions}</li>`;
  }).join('');
  const taken = new Set(svc.accounts.map((a) => String(a.accountLabel || a.label || '').toLowerCase()));
  const chips = ACCOUNT_NAMES.filter((n) => !taken.has(n.toLowerCase()));
  const addForm = p.addAccountOpen ? `
    <form class="cp-acc-add" data-cp-acc-form>
      <div class="cp-acc-inline">
        <input type="text" name="accountLabel" maxlength="60" required placeholder="Account label (work, personal, project-x)" aria-label="Account label" autocomplete="off" value="${esc(p.addAccountDraft || '')}">
        <button type="submit" class="btn sm fill" ${p.addingAccount ? 'disabled' : ''}>${p.addingAccount ? 'Adding…' : 'Continue'}</button>
      </div>
      ${firstUnnamed ? `<input type="text" name="firstAccountLabel" maxlength="60" placeholder="Optional: name current account (e.g. All projects)" aria-label="Current account label" autocomplete="off" value="${esc(p.firstAccountDraft || '')}">` : ''}
      ${chips.length ? `<div class="cp-acc-chips">${chips.map((n) => `<button type="button" class="saved-pill" data-cp-acc-chip="${esc(n)}">${esc(n)}</button>`).join('')}<button type="button" class="cp-acc-link" data-cp-acc-cancel>Cancel</button></div>` : `<div class="cp-acc-acts"><button type="button" class="btn sm" data-cp-acc-cancel>Cancel</button></div>`}
      <p class="st-rs">Next, sign in or enter a key for this account. Your other accounts stay as they are.</p>
    </form>` : '';
  return `
    <section class="cp-sec cp-accounts" aria-labelledby="cp-acc-t">
      <div class="cp-acc-h"><h3 class="cp-sec-t" id="cp-acc-t">Accounts</h3>${p.addAccountOpen ? '' : '<button type="button" class="cp-acc-addbtn" data-cp-add-account>Add account</button>'}</div>
      ${addForm}
      ${p.pickAgents ? pickAgentsHtml(p) : ''}
      <ul class="cp-acc-list">${rows}</ul>
      ${many ? '<p class="cp-acc-note">Each agent uses one account. A new agent starts on the Default account until you pick another.</p>' : ''}
      ${many ? usedByHtml(p) : ''}
    </section>`;
}

function usedByHtml(p) {
  const { esc } = p.ctx;
  const svc = p.service;
  if (!svc.agents.length) return '';
  return `
    <div class="cp-acc-used">
      <div class="cp-acc-k">Used by</div>
      <ul class="cp-acc-list">${svc.agents.map((a) => {
        const row = agentRowOf(p, a.id);
        const on = a.choice === 'any' ? 'Any account' : accountLabelOf(p, a.connectionId) || 'Default account';
        return `<li><button type="button" class="cp-acc" data-cp-acc-agent="${esc(a.id)}">
          ${row ? agentMark(row, esc, 'cp-acc-mark is-lead') : ''}
          <span class="cp-acc-tx"><span class="cp-acc-l">${esc(a.name)}</span><span class="cp-acc-d">${esc(on)}</span></span>
          ${ACC_CHEV}
        </button></li>`;
      }).join('')}</ul>
    </div>`;
}

function pickAgentsHtml(p) {
  const { esc } = p.ctx;
  const label = accountLabelOf(p, p.connId) || 'this account';
  const svc = p.service;
  const agents = p.agents.filter((a) => a && a.enabled !== false);
  if (!p.pickDraft) p.pickDraft = new Set(agentsOnAccount(p, p.connId).filter((a) => a.choice !== 'any').map((a) => a.id));
  const nowOn = (id) => {
    const entry = svc.agents.find((a) => a.id === id);
    if (!entry) return 'Cannot use this app';
    if (entry.choice === 'any') return 'Uses any account now';
    return entry.connectionId === p.connId ? 'Uses this account' : `Uses ${accountLabelOf(p, entry.connectionId) || 'the default account'} now`;
  };
  return `
    <div class="cp-acc-pick" role="group" aria-labelledby="cp-pick-t">
      <h4 id="cp-pick-t">Who uses ${esc(label)}?</h4>
      <p class="st-rs">An agent you leave off keeps the account it uses now.</p>
      <ul class="cp-acc-list">${agents.map((a) => {
        const row = { ...a, agent: a };
        const reachable = svc.agents.some((x) => x.id === a.id);
        return `<li><label class="cp-acc cp-acc-check ${reachable ? '' : 'is-off'}">
          ${agentMark(row, esc, 'cp-acc-mark is-lead')}
          <span class="cp-acc-tx"><span class="cp-acc-l">${esc(a.name)}</span><span class="cp-acc-d">${esc(nowOn(a.id))}</span></span>
          <input type="checkbox" data-cp-pick="${esc(a.id)}" ${p.pickDraft.has(a.id) ? 'checked' : ''} ${reachable ? '' : 'disabled'}>
        </label></li>`;
      }).join('') || '<li class="st-rs">No agents yet.</li>'}</ul>
      <div class="cp-acc-acts">
        <button type="button" class="btn sm fill" data-cp-pick-done ${p.savingPick ? 'disabled' : ''}>${p.savingPick ? 'Saving…' : 'Done'}</button>
        <button type="button" class="btn sm" data-cp-pick-skip>Not now</button>
      </div>
    </div>`;
}

function endPickAgents(p) {
  p.pickAgents = false;
  p.pickDraft = null;
  try { sessionStorage.removeItem(PICK_AGENTS_KEY); } catch { /* storage off */ }
}

function bindAccounts(p) {
  const { api, toast } = p.ctx;
  const root = inner(p);
  bindConnectCard(p);
  root.querySelector('[data-cp-add-account]')?.addEventListener('click', () => {
    p.addAccountOpen = true;
    p.addAccountDraft = '';
    p.firstAccountDraft = '';
    p.disconnectAccountId = null;
    paintConnection(p, '[data-cp-acc-form] input[name="accountLabel"]');
  });
  const form = root.querySelector('[data-cp-acc-form]');
  form?.querySelector('[data-cp-acc-cancel]')?.addEventListener('click', () => {
    p.addAccountOpen = false;
    paintConnection(p, '[data-cp-add-account]');
  });
  form?.querySelector('input[name="accountLabel"]')?.addEventListener('input', (e) => { p.addAccountDraft = e.currentTarget.value; });
  form?.querySelector('input[name="firstAccountLabel"]')?.addEventListener('input', (e) => { p.firstAccountDraft = e.currentTarget.value; });
  form?.querySelectorAll('[data-cp-acc-chip]').forEach((chip) => chip.addEventListener('click', () => {
    const input = form.querySelector('input[name="accountLabel"]');
    input.value = chip.dataset.cpAccChip;
    p.addAccountDraft = input.value;
    input.focus();
  }));
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const accountLabel = String(form.querySelector('input[name="accountLabel"]').value || '').trim();
    const firstAccountLabel = String(form.querySelector('input[name="firstAccountLabel"]')?.value || '').trim();
    if (!accountLabel || p.addingAccount) return;
    p.addingAccount = true;
    paintConnection(p);
    try {
      const res = await api(`/api/mcps/${encodeURIComponent(p.connId)}/accounts`, {
        method: 'POST',
        body: JSON.stringify({
          accountLabel,
          ...(firstAccountLabel ? { firstAccountLabel } : {}),
        }),
      });
      const id = res?.mcp?.id;
      if (!id) throw new Error('Loop did not add the account.');
      try { sessionStorage.setItem(PICK_AGENTS_KEY, id); } catch { /* storage off */ }
      p.changed = true;
      p.addingAccount = false;
      p.addAccountOpen = false;
      p.firstAccountDraft = '';
      // The new account opens and starts its own sign-in. Back from it, it asks which agents use it.
      await transitionToConnection(p, id, { autoSignIn: true, focusCredentials: res.mcp.readiness?.action !== 'sign_in' });
    } catch (err) {
      p.addingAccount = false;
      toast(err?.message || 'Could not add the account.', 'err');
      paintConnection(p, '[data-cp-acc-form] input[name="accountLabel"]');
    }
  });
  root.querySelectorAll('[data-cp-account]').forEach((btn) => btn.addEventListener('click', () => {
    const id = btn.dataset.cpAccount;
    if (id && id !== p.connId) transitionToConnection(p, id);
  }));
  root.querySelectorAll('[data-cp-acc-default]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.dataset.cpAccDefault;
    if (!id || p.settingDefault) return;
    p.settingDefault = true;
    paintConnection(p);
    try {
      await api(`/api/mcps/${encodeURIComponent(id)}/default-account`, { method: 'POST' });
      p.settingDefault = false;
      p.changed = true;
      toast(`${accountLabelOf(p, id) || 'This account'} is now the default for new agents.`, 'ok');
      await loadConnection(p);
    } catch (err) {
      p.settingDefault = false;
      toast(err?.message || 'Could not set default account.', 'err');
      paintConnection(p);
    }
  }));
  root.querySelectorAll('[data-cp-acc-disconnect]').forEach((btn) => btn.addEventListener('click', () => {
    p.disconnectAccountId = btn.dataset.cpAccDisconnect || null;
    paintConnection(p, `[data-cp-acc-disconnect-yes="${CSS.escape(p.disconnectAccountId || '')}"]`);
  }));
  root.querySelector('[data-cp-acc-disconnect-no]')?.addEventListener('click', () => {
    p.disconnectAccountId = null;
    paintConnection(p);
  });
  root.querySelectorAll('[data-cp-acc-disconnect-yes]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.dataset.cpAccDisconnectYes;
    if (!id || p.disconnectingAccount) return;
    const removedLabel = accountLabelOf(p, id) || 'Account';
    const nextAcc = (p.service?.accounts || []).find((a) => a.connectionId !== id);
    p.disconnectingAccount = true;
    paintConnection(p);
    try {
      await api(`/api/mcps/${encodeURIComponent(id)}`, { method: 'DELETE' });
      p.disconnectingAccount = false;
      p.disconnectAccountId = null;
      p.changed = true;
      toast(`Removed ${removedLabel}.`, 'ok');
      if (id === p.connId && nextAcc) {
        await transitionToConnection(p, nextAcc.connectionId);
      } else {
        await loadConnection(p);
      }
    } catch (err) {
      p.disconnectingAccount = false;
      toast(err?.message || 'Could not remove this account.', 'err');
      paintConnection(p);
    }
  }));
  root.querySelectorAll('[data-cp-acc-agent]').forEach((btn) => btn.addEventListener('click', () => {
    const id = btn.dataset.cpAccAgent;
    if (id && typeof p.ctx.openAgent === 'function') {
      closeConnectionPopup({ immediate: true, quiet: true });
      p.ctx.openAgent(id, 'access');
    }
  }));
  root.querySelectorAll('[data-cp-pick]').forEach((box) => box.addEventListener('change', () => {
    if (!p.pickDraft) p.pickDraft = new Set();
    if (box.checked) p.pickDraft.add(box.dataset.cpPick);
    else p.pickDraft.delete(box.dataset.cpPick);
  }));
  root.querySelector('[data-cp-pick-skip]')?.addEventListener('click', () => {
    endPickAgents(p);
    paintConnection(p);
  });
  root.querySelector('[data-cp-pick-done]')?.addEventListener('click', async () => {
    const key = p.service?.key;
    if (!key || p.savingPick) return;
    p.savingPick = true;
    paintConnection(p);
    const picked = [...(p.pickDraft || [])];
    try {
      for (const id of picked) {
        const agent = p.agents.find((a) => a.id === id);
        if (!agent) continue;
        const accountChoice = { ...(agent.accountChoice || {}), [key]: p.connId };
        await api(`/api/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ accountChoice }) });
      }
      p.savingPick = false;
      endPickAgents(p);
      p.changed = true;
      toast(picked.length ? `${picked.length} ${picked.length === 1 ? 'agent uses' : 'agents use'} ${accountLabelOf(p, p.connId) || 'this account'} now.` : 'No agent moved.', 'ok');
      await loadConnection(p);
    } catch (err) {
      p.savingPick = false;
      toast(err?.message || 'Could not save.', 'err');
      paintConnection(p);
    }
  });
}

function approvalDescOf(p) {
  const { mcp } = p;
  const connApproval = normApproval(p.ctx, mcp.approval, 'inherit');
  const effectiveApproval = getEffectiveConnApproval(p.ctx, mcp, p.policies);
  // With no rule of its own, a connection follows the Tools rules of the Vault page, which can be
  // stricter for tools that change things, can delete or carry no safety label.
  const kindRules = p.policies?.toolKinds || {};
  const kindsOn = (mode) => [
    kindRules.destructive === mode ? 'can delete' : '',
    kindRules.unmarked === mode ? 'have no safety label' : '',
    kindRules.write === mode ? 'change things' : '',
  ].filter(Boolean).join(' or ');
  const inheritedText = [
    modeLabel(effectiveApproval),
    ...['always_ask', 'guard']
      .filter((mode) => stricterMode(effectiveApproval, mode) !== effectiveApproval && kindsOn(mode))
      .map((mode) => `${modeLabel(mode)} for tools that ${kindsOn(mode)}`),
  ].join(', ');
  const approvalDesc = connApproval === 'inherit'
    ? `Follows the Vault page: ${inheritedText}.`
    : modeLine(connApproval);
  return approvalDesc;
}

function settingsHtml(p) {
  const { esc } = p.ctx;
  const { mcp, profileRecords, categories } = p;
  const activeCat = mcp.category || 'general';
  const assignedProfiles = new Set((Array.isArray(mcp.profiles) ? mcp.profiles : []).filter((id) => id && id !== 'all'));
  const isStdio = getTransport(mcp) === 'stdio';
  const isRelay = typeof mcp.url === 'string' && mcp.url.startsWith('https://relay.useloop.sh/d/');
  const isLocalWorkspace = !isPersonal(p.ctx);
  const canPromoteToCloud = Boolean(isLocalWorkspace && p.localConnectLinked && !isStdio && !isRelay && !mcp.cloudRouted && getTransport(mcp) !== 'builtin');
  const isCloudRouted = Boolean(mcp.cloudRouted);
  const currentRemoteAccess = ['local_only', 'ask_approval', 'remote_auto'].includes(mcp.remoteAccess)
    ? mcp.remoteAccess
    : 'remote_auto';
  const remoteAccessDesc = currentRemoteAccess === 'local_only'
    ? 'Runs on this computer only. Blocks remote calls from other devices.'
    : currentRemoteAccess === 'ask_approval'
      ? 'Remote calls pause and ask for your approval (2FA) before running.'
      : 'Remote devices can call this tool automatically while this computer is online.';
  const stdioCmd = isStdio
    ? [mcp.command || '', ...(Array.isArray(mcp.args) ? mcp.args : [])].filter(Boolean).join(' ')
    : '';
  const authSummary = mcp.hasOAuth
    ? 'OAuth'
    : mcp.hasAuth
      ? (Array.isArray(mcp.headerKeys) && mcp.headerKeys.length > 0
        ? `Saved credentials (${mcp.headerKeys.join(', ')})`
        : 'Saved credentials')
      : mcp.agentLogin
        ? `Agent login in Vault (${mcp.agentLogin.origin})`
        : 'None';
  const resourceCount = Array.isArray(mcp.resources) ? mcp.resources.length : 0;
  const promptCount = Array.isArray(mcp.prompts) ? mcp.prompts.length : 0;
  const partnerSkills = Array.isArray(mcp.skills) ? mcp.skills : [];
  const skillCount = partnerSkills.length;

  return `
    <div class="cp-sec">
    <h3 class="cp-sec-t">Settings</h3>
    <div class="st-rules cp-rules">
      ${skillCount > 0 ? rule(
        esc,
        'Partner skills',
        mcp.partnerSkillsEnabled
          ? `${skillCount} ${skillCount === 1 ? 'skill' : 'skills'} enabled. Agents see only the skills their grant allows.`
          : `Off — ${skillCount} ${skillCount === 1 ? 'skill' : 'skills'} offered by this provider. Enable to let authorized agents load them.`,
        `<button type="button" class="sw ${mcp.partnerSkillsEnabled ? 'on' : ''}" role="switch" aria-checked="${Boolean(mcp.partnerSkillsEnabled)}" aria-label="Enable partner Skills for ${esc(mcp.name)}" data-cp-partner-skills><span class="sw-knob" aria-hidden="true"></span></button>`,
      ) : ''}
      ${skillCount > 0 ? `
      <div class="st-rule cp-prof-rule">
        <div class="st-rule-c">
          <div class="st-rt">Offered skills</div>
          <ul class="st-rs" style="margin:6px 0 0;padding-left:18px" aria-label="Partner skills offered by ${esc(mcp.name)}">
            ${partnerSkills.map((sk) => `<li><strong>${esc(sk.name || sk.slug)}</strong>${sk.description ? ` — ${esc(sk.description)}` : ''}</li>`).join('')}
          </ul>
        </div>
      </div>` : ''}
      ${canPromoteToCloud ? rule(
        esc,
        'Where it runs',
        'On this computer. Move to Loop Cloud to run it from any device and remove this local copy.',
        `<button type="button" class="btn sm fill" data-cp-promote ${p.promoting ? 'disabled' : ''}>${p.promoting ? 'Moving…' : 'Move to Loop Cloud'}</button>`,
      ) : ''}
      ${isCloudRouted ? rule(
        esc,
        'Where it runs',
        'Running in Loop Cloud. No local copy stays on this computer.',
        `<button type="button" class="btn sm" data-cp-demote ${p.demoting ? 'disabled' : ''}>${p.demoting ? 'Switching…' : 'Switch back to local'}</button>`,
      ) : ''}
      ${isStdio && isLocalWorkspace ? rule(
        esc,
        'Remote access',
        remoteAccessDesc,
        seg(esc, 'remoteAccess', REMOTE_ACCESS_OPTIONS, currentRemoteAccess, `Remote access for ${mcp.name}`),
      ) : ''}
      ${rule(
        esc,
        'Category',
        'Where it shows on Home.',
        `<select class="ap-select" data-cp-category aria-label="Category for ${esc(mcp.name)}">
          ${categories.map((c) => `<option value="${esc(c.id)}" ${c.id === activeCat ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
        </select>`,
      )}
    ${PROJECTS_SHOWN && profileRecords.length > 0 ? `
    <div class="st-rule cp-prof-rule">
      <div class="st-rule-c"><div class="st-rt">Projects</div><div class="st-rs">Always in All; add others.</div></div>
        <div class="pf-chips" role="group" aria-label="Projects for ${esc(mcp.name)}">
          ${profileRecords.map((rec) => {
            const on = assignedProfiles.has(rec.id);
            return `<button type="button" class="pf-chip" data-cp-profile="${esc(rec.id)}" aria-pressed="${on}">
              <span class="pf-chip-ic" aria-hidden="true">${on ? CHECK_ICON : ''}</span>
              <span>${esc(rec.name)}</span>
            </button>`;
          }).join('')}
        </div>
      </div>` : ''}
    </div>
    ${isStdio && isLocalWorkspace && mcp.portable === false ? `
      <div class="cp-portable-card">
        <div class="cp-portable-head">
          <div>
            <div class="st-rt">Not portable yet</div>
            <div class="st-rs">${esc(mcp.nonPortableReason || 'This command points to a local path, so other computers cannot install it with one click.')}</div>
          </div>
          <button type="button" class="btn sm" data-cp-portable-toggle aria-expanded="${Boolean(p.portableOpen)}">${p.portableOpen ? 'Hide' : 'Make portable'}</button>
        </div>
        ${p.portableOpen ? `
          <form class="form-grid cp-portable-form" data-cp-portable-form>
            <div class="form-row">
              <label class="field">
                <span class="lbl">Source</span>
                <select name="source" class="ap-select">
                  <option value="npm">npm package (npx)</option>
                  <option value="pypi">Python package (uvx)</option>
                  <option value="docker">Docker image</option>
                  <option value="git">Git repository</option>
                </select>
              </label>
              <label class="field">
                <span class="lbl">Package or repository</span>
                <input type="text" name="pkg" required placeholder="@org/mcp-notes" spellcheck="false">
              </label>
            </div>
            <div class="form-row">
              <label class="field">
                <span class="lbl">Pinned version</span>
                <input type="text" name="version" required placeholder="1.2.3" spellcheck="false">
              </label>
              <label class="field">
                <span class="lbl">SHA-256 hash (optional)</span>
                <input type="text" name="sha256" placeholder="64-character hex digest" spellcheck="false">
              </label>
            </div>
            <div class="cp-signin-acts">
              <button type="submit" class="btn sm fill" ${p.savingPortable ? 'disabled' : ''}>${p.savingPortable ? 'Saving…' : 'Save portable setup'}</button>
            </div>
          </form>
        ` : ''}
      </div>
    ` : ''}
    </div>

    <div class="cp-sec cp-details">
      <h3 class="cp-sec-t">Details</h3>
      <div class="st-rt cp-desc-t">Account label</div>
      <p class="st-rs">Shown in setup, OAuth consent, and approval cards to separate accounts (for example Personal or Work).</p>
      <form class="drawer-desc-form cp-desc-form" data-cp-account-form>
        <input
          type="text"
          name="accountLabel"
          maxlength="60"
          value="${esc(mcp.accountLabel || '')}"
          placeholder="e.g. Work or Personal"
          aria-label="Account label for ${esc(mcp.name)}"
        >
        <button type="submit" class="btn sm" ${p.savingAccountLabel ? 'disabled' : ''}>${p.savingAccountLabel ? 'Saving…' : 'Save'}</button>
      </form>
      <div class="st-rt cp-desc-t">Description</div>
      <p class="st-rs">What agents see about this connection.</p>
      <form class="drawer-desc-form cp-desc-form" data-cp-desc-form>
        <input
          type="text"
          name="description"
          maxlength="500"
          value="${esc(mcp.description || '')}"
          placeholder="e.g. Issue tracker and project planning"
          aria-label="Description for ${esc(mcp.name)}"
        >
        <button type="submit" class="btn sm" ${p.savingDesc ? 'disabled' : ''}>${p.savingDesc ? 'Saving…' : 'Save'}</button>
      </form>
      <dl class="cp-meta">
        <div class="cp-meta-row">
          <dt>Tool prefix</dt>
          <dd><code class="inline-code">${esc(mcp.id)}__</code></dd>
        </div>
        ${(mcp.appSignIns || []).some((s) => s.state === 'ready') ? `
        <div class="cp-meta-row">
          <dt>Signed in to</dt>
          <dd>${esc(mcp.appSignIns.filter((s) => s.state === 'ready').map((s) => formatAppSignInName(s)).join(', '))}</dd>
        </div>` : ''}
        <div class="cp-meta-row">
          <dt>Transport</dt>
          <dd>${esc(transportLabel(mcp))}</dd>
        </div>
        ${isStdio ? `
          <div class="cp-meta-row">
            <dt>Command</dt>
            <dd class="mono">${esc(stdioCmd || '—')}</dd>
          </div>
          ${mcp.cwd ? `
            <div class="cp-meta-row">
              <dt>Working dir</dt>
              <dd class="mono">${esc(mcp.cwd)}</dd>
            </div>
          ` : ''}
        ` : `
          <div class="cp-meta-row">
            <dt>${mcp.lent ? 'Account' : 'Server URL'}</dt>
            <dd ${mcp.lent ? '' : 'class="mono"'}>${mcp.lent ? `${esc(mcp.lentOwner || 'The owner')} lends it. ${esc(mcp.lentOwner || 'The owner')}’s approval rules apply too, and their Activity shows what your agents do with it.` : esc(mcp.url || '—')}</dd>
          </div>
        `}
        <div class="cp-meta-row" ${mcp.lent ? 'hidden' : ''}>
          <dt>Auth</dt>
          <dd>
            <span>${esc(authSummary)}</span>
            ${mcp.hasOAuth && !mcp.authRequired && !mcp.tokenRejected
              ? ` <button type="button" class="ap-link cp-reauth" data-cp-oauth ${p.startingOAuth ? 'disabled' : ''}>${p.startingOAuth ? 'Starting…' : 'Re-authenticate'}</button>`
              : ''}
          </dd>
        </div>
        <div class="cp-meta-row">
          <dt>Last synced</dt>
          <dd>${esc(formatSyncTime(mcp.lastSyncAt))}</dd>
        </div>
        ${resourceCount > 0 || promptCount > 0 || skillCount > 0 ? `
          <div class="cp-meta-row">
            <dt>Extras</dt>
            <dd>${esc([
              skillCount > 0 ? `${skillCount} ${skillCount === 1 ? 'partner skill' : 'partner skills'}` : '',
              resourceCount > 0 ? `${resourceCount} ${resourceCount === 1 ? 'resource' : 'resources'}` : '',
              promptCount > 0 ? `${promptCount} ${promptCount === 1 ? 'prompt' : 'prompts'}` : '',
            ].filter(Boolean).join(' · '))}</dd>
          </div>
        ` : ''}
      </dl>
      ${getTransport(mcp) === 'stdio' && !isPersonal(p.ctx) ? `<div class="cp-danger-row"><button type="button" class="ap-link" data-cp-uninstall ${p.uninstalling ? 'disabled' : ''}>${p.uninstalling ? 'Uninstalling…' : 'Uninstall from this computer'}</button></div>` : ''}
    </div>`;
}

function removeHtml(p) {
  const { esc } = p.ctx;
  const { mcp } = p;
  if (p.confirmRemove) {
    return `
      <div class="cp-confirm" role="alertdialog" aria-label="Remove ${esc(mcp.name)}">
        <p class="cp-confirm-t">Remove <strong>${esc(mcp.name)}</strong>? Agents lose access right away.</p>
        <div class="cp-confirm-acts">
          <button type="button" class="btn sm danger" data-cp-remove-confirm ${p.removing ? 'disabled' : ''}>${p.removing ? 'Removing…' : 'Remove'}</button>
          <button type="button" class="btn sm ghost" data-cp-remove-cancel ${p.removing ? 'disabled' : ''}>Cancel</button>
        </div>
      </div>`;
  }
  return '';
}

function toolsPaneHtml(p, counts) {
  const { esc } = p.ctx;
  const { mcp } = p;
  const tools = Array.isArray(mcp.tools) ? mcp.tools : [];
  return `
    <div class="cp-tools-h">
      <span class="cp-count" data-cp-tools-sub>${esc(counts.enabled)} of ${esc(counts.total)} on</span>
      ${mcp.readiness?.action === 'sign_in' ? '' : `<button type="button" class="ap-link cp-refresh" data-cp-sync title="Ask the server for its latest tools" ${p.syncing ? 'disabled' : ''}>${p.syncing ? 'Refreshing…' : 'Refresh'}</button>`}
    </div>
    ${readOnlyPresetHtml(mcp, esc)}
    ${tools.length > 0 ? `
      <div class="cp-tool-bar">
        <input
          type="search"
          id="cp-tool-q"
          class="cp-tool-search"
          value="${esc(p.toolQuery)}"
          placeholder="Search tools by name or description…"
          aria-label="Search tools on ${esc(mcp.name)}"
          autocomplete="off"
        >
      </div>
    ` : ''}
    <div id="cp-tool-list-wrap">${toolsListHtml(p, counts)}</div>`;
}

function toolsListHtml(p, counts) {
  const { esc } = p.ctx;
  const { mcp } = p;
  const tools = Array.isArray(mcp.tools) ? mcp.tools : [];
  if (tools.length === 0) {
    const emptyText = mcp.readiness?.nextStep || 'Refresh tools to check again.';
    return `<p class="ap-empty">${esc(emptyText)}</p>`;
  }

  const tokens = String(p.toolQuery || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = tokens.length === 0
    ? tools
    : tools.filter((t) => {
      const hay = `${t.name || ''} ${t.description || ''}`.toLowerCase();
      return tokens.every((tok) => hay.includes(tok));
    });

  if (filtered.length === 0) {
    return `
      <div class="cp-empty">
        <p class="ap-empty">No tools match “${esc(p.toolQuery.trim())}”.</p>
        <button type="button" class="btn sm ghost" data-cp-clear-search>Clear search</button>
      </div>`;
  }

  const pinnedSet = pinnedSetOf(p.ctx, mcp);
  return `
    <div class="tool-list cp-tool-list">
      ${filtered.map((t) => {
        const isEnabled = !counts.disabledSet.has(t.name) && t.enabled !== false;
        const isPinned = Boolean(t.pinned || pinnedSet.has(t.name));
        const tester = p.openTesters.get(t.name);
        const toolKey = `${mcp.id}__${t.name}`;
        const toolOverride = normApproval(p.ctx, p.toolApprovals?.[toolKey], 'inherit');
        const ann = t.annotations && typeof t.annotations === 'object' ? t.annotations : null;
        const isReadOnly = ann?.readOnlyHint === true;
        const isDestructive = ann?.destructiveHint === true;

        return `
          <div class="tool-item cp-tool-item ${isEnabled ? '' : 'off'}">
            <div class="tool-row cp-tool-row">
              <div class="tool-info cp-tool-info">
                <div class="cp-tool-title">
                  <span class="tool-name" title="${esc(toolKey)}">${esc(t.name)}</span>
                  ${isReadOnly ? '<span class="tag ok cp-ann">Read-only</span>' : ''}
                  ${isDestructive ? '<span class="tag no cp-ann">Destructive</span>' : ''}
                </div>
                ${t.description ? `<span class="tool-desc" title="${esc(t.description)}">${esc(t.description)}</span>` : ''}
              </div>
              <div class="tool-acts cp-tool-acts">
                <button
                  type="button"
                  class="btn sm ${isPinned ? 'fill' : 'ghost'}"
                  data-cp-tool-pin="${esc(t.name)}"
                  data-pinned="${isPinned ? 'true' : 'false'}"
                  aria-pressed="${isPinned}"
                  title="Pin this tool so it is exposed directly in Search-first mode."
                >${isPinned ? 'Pinned' : 'Pin'}</button>
                ${toolRuleHtml(p, t, toolOverride)}
                <button
                  type="button"
                  class="btn sm ghost"
                  data-cp-tool-test="${esc(t.name)}"
                  aria-expanded="${Boolean(tester)}"
                >${tester ? 'Close' : 'Test'}</button>
                <button
                  type="button"
                  class="sw ${isEnabled ? 'on' : ''}"
                  role="switch"
                  aria-checked="${isEnabled}"
                  aria-label="Enable tool ${esc(t.name)}"
                  data-cp-tool-toggle="${esc(t.name)}"
                ><span class="sw-knob" aria-hidden="true"></span></button>
              </div>
            </div>

            ${tester ? `
              <div class="tool-tester cp-tool-test">
                ${renderSchemaHints(esc, t.inputSchema)}
                <label class="field">
                  <span class="lbl">Arguments (JSON)</span>
                  <textarea
                    class="code-input"
                    rows="3"
                    data-cp-tester-args="${esc(t.name)}"
                    spellcheck="false"
                  >${esc(tester.argsText)}</textarea>
                </label>
                <div class="tester-bar">
                  <button
                    type="button"
                    class="btn sm fill"
                    data-cp-run-tool="${esc(t.name)}"
                    ${tester.running ? 'disabled' : ''}
                  >${tester.running ? 'Running…' : 'Run'}</button>
                  <button
                    type="button"
                    class="btn sm ghost"
                    data-cp-reset-tester="${esc(t.name)}"
                    ${tester.running ? 'disabled' : ''}
                  >Reset {}</button>
                </div>
                ${tester.output !== null ? `
                  <div class="tester-out">
                    <div class="drawer-title">
                      <span>Output</span>
                      ${tester.isError ? '<span class="tag no">Error</span>' : '<span class="tag ok">OK</span>'}
                    </div>
                    <pre class="code mini">${esc(tester.output)}</pre>
                  </div>
                ` : ''}
              </div>
            ` : ''}
          </div>`;
      }).join('')}
    </div>`;
}

function updateToolsListOnly(p, focusSelector = null) {
  const wrap = p.el.querySelector('#cp-tool-list-wrap');
  if (!wrap) {
    paintConnection(p, focusSelector);
    return;
  }
  const counts = toolCountsOf(p.ctx, p.mcp);
  wrap.innerHTML = toolsListHtml(p, counts);
  const sub = p.el.querySelector('[data-cp-tools-sub]');
  if (sub) sub.textContent = `${counts.enabled} of ${counts.total} on`;
  paintStatus(p);
  bindToolsList(p);
  if (focusSelector) p.el.querySelector(focusSelector)?.focus();
}

function paintStatus(p) {
  const statusEl = p.el.querySelector('.cp-st');
  if (statusEl) {
    const status = pageStatus(p, toolCountsOf(p.ctx, p.mcp));
    statusEl.className = `ap-st cp-st ${STATUS_CLS[status.cls] || ''}`;
    statusEl.innerHTML = `${status.cls ? '<i aria-hidden="true"></i>' : ''}${p.ctx.esc(status.text)}`;
  }
}

async function startConnectionOAuth(p, { clientId = '', clientSecret = '' } = {}) {
  const { api, toast } = p.ctx;
  const { mcp } = p;
  p.startingOAuth = true;
  paintConnection(p);
  try {
    const init = { method: 'POST' };
    if (clientId) {
      init.body = JSON.stringify({
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
      });
    }
    const res = await api(`/api/mcps/${encodeURIComponent(mcp.id)}/oauth/start`, init);
    if (!alive(p)) return;
    const target = safeAuthorizeUrl(res.authorizeUrl);
    location.href = target.href;
  } catch (err) {
    if (!alive(p)) return;
    p.startingOAuth = false;
    if (!clientId && err?.data?.signInBroken) {
      p.mcp.signInBroken = err.data.detail || err.message || 'Sign-in needs input.';
      p.authModeHint = err.data.authModeHint || null;
      p.credTab = defaultCredTab(p.mcp, p.authModeHint);
      p.credOpen = true;
      p.changed = true;
      await loadConnection(p); // re-read the persisted sign-in failure and recovery action
      return;
    }
    toast(err.message || 'Could not start sign-in.', 'err');
    paintConnection(p);
  }
}

async function syncConnection(p) {
  const { api, toast } = p.ctx;
  const { mcp } = p;
  if (p.syncing) return;
  p.syncing = true;
  paintConnection(p);
  try {
    const res = await api(`/api/mcps/${encodeURIComponent(mcp.id)}/sync`, { method: 'POST' });
    if (!alive(p)) return;
    if (res?.mcp) p.mcp = mergeMcp(p.mcp, res.mcp);
    p.changed = true;
    p.syncing = false;
    if (p.mcp.readiness?.ready) p.oauthResult = null;
    if (p.mcp.tokenRejected) {
      toast('Token was rejected by this server.', 'err');
    } else if (p.mcp.lastError) {
      toast(p.mcp.lastError, 'err');
    } else {
      const counts = toolCountsOf(p.ctx, p.mcp);
      toast(`Synced ${counts.total} ${counts.total === 1 ? 'tool' : 'tools'}.`, 'ok');
    }
    paintConnection(p);
  } catch (err) {
    if (!alive(p)) return;
    p.syncing = false;
    toast(err.message || 'Could not sync connection.', 'err');
    paintConnection(p);
  }
}

function bindConnection(p) {
  const { api, toast, openLogoDialog, copyText } = p.ctx;
  const { mcp } = p;
  const el = p.el;
  bindAccounts(p);

  el.querySelectorAll('[data-cp-app-signin]').forEach((link) => {
    const sign = (mcp.appSignIns || []).find((s) => s.id === link.dataset.cpAppSignin);
    try { safeAuthorizeUrl(sign?.url); } catch { link.removeAttribute('href'); }
    // The browser follows the link itself; Loop only notes that the owner opened it.
    link.addEventListener('click', () => {
      api(`/api/mcps/${encodeURIComponent(mcp.id)}/app-sign-ins/${encodeURIComponent(sign.id)}/open`, { method: 'POST', body: '{}' })
        .then(() => { sign.opened = true; })
        .catch(() => { sign.url = null; })
        .finally(() => { p.changed = true; if (alive(p)) paintConnection(p); });
    });
  });
  el.querySelectorAll('[data-cp-app-remove]').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await api(`/api/mcps/${encodeURIComponent(mcp.id)}/app-sign-ins/${encodeURIComponent(btn.dataset.cpAppRemove)}`, { method: 'DELETE' });
      mcp.appSignIns = (mcp.appSignIns || []).filter((s) => s.id !== btn.dataset.cpAppRemove);
      p.changed = true;
      if (alive(p)) paintConnection(p);
    } catch (err) {
      btn.disabled = false;
      toast(err.message || 'Could not remove it.', 'err');
    }
  }));

  el.querySelector('[data-cp-copy-handoff]')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(mcp.readiness.handoff); toast('Repair request copied.', 'ok'); }
    catch { toast('Select and copy the repair request shown above.', 'err'); }
  });

  el.querySelector('[data-cp-apply-read-only]')?.addEventListener('click', async ({currentTarget}) => {
    currentTarget.disabled = true;
    let changed = 0;
    try {
      for (const toolName of readOnlyPresetTargets(mcp)) {
        if (!alive(p)) break;
        await api(`/api/mcps/${encodeURIComponent(mcp.id)}/tools/toggle`, { method: 'POST', body: JSON.stringify({toolName, enabled:false}) });
        changed++;
        p.changed = true;
      }
      if (alive(p)) toast(`Turned off ${changed} tools.`, 'ok');
    } catch { toast(`Stopped after turning off ${changed} tools. Review the remaining tools.`, 'err'); }
    if (alive(p)) await loadConnection(p);
  });

  // Refresh / Try again
  el.querySelectorAll('[data-cp-sync]').forEach((btn) => {
    btn.addEventListener('click', () => syncConnection(p));
  });

  el.querySelector('[data-cp-logo]')?.addEventListener('click', () => {
    if (typeof openLogoDialog !== 'function') return;
    openLogoDialog(mcp, () => {
      if (!alive(p)) return;
      p.changed = true;
      toast('Logo updated.', 'ok');
      loadConnection(p);
    });
  });

  el.querySelector('[data-cp-uninstall]')?.addEventListener('click', async () => {
    if (p.uninstalling) return;
    const ok = await confirmDialog({
      title: `Uninstall "${mcp.name}"?`,
      message: 'Removes it from this computer. Your saved setup stays in Loop, ready to install again.',
      confirmLabel: 'Uninstall',
      danger: true,
    });
    if (!ok) return;
    p.uninstalling = true;
    paintConnection(p);
    try {
      const setupId = mcp.toolSetupId || mcp.id;
      await api(`/api/local/tool-setups/${encodeURIComponent(setupId)}/uninstall`, { method: 'POST', body: '{}' });
      if (!alive(p)) return;
      p.changed = true;
      toast(`Uninstalled "${mcp.name}" from this computer.`, 'ok');
      closeConnectionPopup();
    } catch (err) {
      if (!alive(p)) return;
      p.uninstalling = false;
      toast(err.message || 'Could not uninstall from this computer.', 'err');
      paintConnection(p);
    }
  });

  el.querySelector('[data-cp-promote]')?.addEventListener('click', async () => {
    if (p.promoting) return;
    p.promoting = true;
    paintConnection(p);
    try {
      await api(`/api/local/mcps/${encodeURIComponent(mcp.id)}/promote`, { method: 'POST', body: '{}' });
      if (!alive(p)) return;
      p.changed = true;
      toast(`Moved "${mcp.name}" to Loop Cloud and removed the local copy.`, 'ok');
      await loadConnection(p);
    } catch (err) {
      if (!alive(p)) return;
      p.promoting = false;
      toast(err.message || 'Could not move to Loop Cloud. Your local copy was kept.', 'err');
      paintConnection(p);
    }
  });

  el.querySelector('[data-cp-demote]')?.addEventListener('click', async () => {
    if (p.demoting) return;
    p.demoting = true;
    paintConnection(p);
    try {
      await api(`/api/local/mcps/${encodeURIComponent(mcp.id)}/demote`, { method: 'POST', body: '{}' });
      if (!alive(p)) return;
      p.changed = true;
      toast(`Switched "${mcp.name}" back to this computer.`, 'ok');
      await loadConnection(p);
    } catch (err) {
      if (!alive(p)) return;
      p.demoting = false;
      toast(err.message || 'Could not switch back to local.', 'err');
      paintConnection(p);
    }
  });

  el.querySelectorAll('[data-cp-field="remoteAccess"] [data-val]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.getAttribute('aria-pressed') === 'true') return;
      const prev = mcp.remoteAccess || 'remote_auto';
      const next = btn.dataset.val;
      p.mcp.remoteAccess = next;
      paintConnection(p, `[data-cp-field="remoteAccess"] [data-val="${CSS.escape(next)}"]`);
      try {
        const res = await api(`/api/local/mcps/${encodeURIComponent(mcp.id)}/remote-access`, {
          method: 'PATCH',
          body: JSON.stringify({ remoteAccess: next }),
        });
        if (!alive(p)) return;
        p.mcp.remoteAccess = res?.remoteAccess || next;
        p.changed = true;
        toast('Remote access updated.', 'ok');
        paintConnection(p, `[data-cp-field="remoteAccess"] [data-val="${CSS.escape(p.mcp.remoteAccess)}"]`);
      } catch (err) {
        if (!alive(p)) return;
        p.mcp.remoteAccess = prev;
        toast(err.message || 'Could not update remote access.', 'err');
        paintConnection(p, `[data-cp-field="remoteAccess"] [data-val="${CSS.escape(prev)}"]`);
      }
    });
  });

  el.querySelector('[data-cp-portable-toggle]')?.addEventListener('click', () => {
    p.portableOpen = !p.portableOpen;
    paintConnection(p, p.portableOpen ? '[data-cp-portable-form] input[name="pkg"]' : '[data-cp-portable-toggle]');
  });

  el.querySelector('[data-cp-portable-form]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (p.savingPortable) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    const source = String(fd.get('source') || 'npm');
    const pkg = String(fd.get('pkg') || '').trim();
    const version = String(fd.get('version') || '').trim();
    const sha256 = String(fd.get('sha256') || '').trim();
    if (!pkg || !version) return;
    p.savingPortable = true;
    paintConnection(p);
    try {
      await api(`/api/local/mcps/${encodeURIComponent(mcp.id)}/make-portable`, {
        method: 'POST',
        body: JSON.stringify({
          installSpec: {
            source,
            package: pkg,
            version,
            ...(sha256 ? { sha256 } : {}),
            command: source === 'npm' ? 'npx' : source === 'pypi' ? 'uvx' : source === 'docker' ? 'docker' : (mcp.command || 'node'),
            args: source === 'npm' ? ['-y', `${pkg}@${version}`] : source === 'pypi' ? [`${pkg}==${version}`] : Array.isArray(mcp.args) ? mcp.args : [],
          },
        }),
      });
      if (!alive(p)) return;
      p.portableOpen = false;
      p.savingPortable = false;
      p.changed = true;
      toast(`Saved portable setup for "${mcp.name}".`, 'ok');
      await loadConnection(p);
    } catch (err) {
      if (!alive(p)) return;
      p.savingPortable = false;
      toast(err.message || 'Could not save portable setup.', 'err');
      paintConnection(p);
    }
  });

  el.querySelector('[data-cp-remove]')?.addEventListener('click', () => {
    p.confirmRemove = true;
    paintConnection(p, '[data-cp-remove-cancel]');
  });

  el.querySelector('[data-cp-remove-cancel]')?.addEventListener('click', () => {
    p.confirmRemove = false;
    paintConnection(p, '[data-cp-remove]');
  });

  el.querySelector('[data-cp-remove-confirm]')?.addEventListener('click', async () => {
    if (p.removing) return;
    p.removing = true;
    paintConnection(p);
    try {
      await api(`/api/mcps/${encodeURIComponent(mcp.id)}`, { method: 'DELETE' });
      if (!alive(p)) return;
      p.changed = true;
      toast(`Removed "${mcp.name}".`, 'ok');
      closeConnectionPopup();
    } catch (err) {
      if (!alive(p)) return;
      p.removing = false;
      toast(err.message || 'Could not remove connection.', 'err');
      paintConnection(p);
    }
  });

  // Dismiss OAuth error banner
  el.querySelector('[data-cp-dismiss-oauth-err]')?.addEventListener('click', () => {
    p.oauthError = '';
    paintConnection(p);
  });

  // OAuth Sign in / Re-auth (instant redirect)
  el.querySelectorAll('[data-cp-oauth]').forEach((btn) => {
    btn.addEventListener('click', () => startConnectionOAuth(p));
  });

  // Open / switch / close credentials & agent-login input panel
  el.querySelectorAll('[data-cp-open-creds]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.cpOpenCreds || defaultCredTab(mcp, p.authModeHint);
      p.credTab = targetTab;
      p.credOpen = true;
      paintConnection(p, credFocusSelector(targetTab));
    });
  });
  el.querySelector('[data-cp-edit-login]')?.addEventListener('click', () => {
    p.credTab = 'agent_login';
    p.credOpen = true;
    paintConnection(p, credFocusSelector('agent_login'));
  });
  el.querySelector('[data-cp-close-creds]')?.addEventListener('click', () => {
    p.credOpen = false;
    paintConnection(p);
  });
  el.querySelectorAll('[data-cp-cred-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.cpCredTab;
      if (!next || next === p.credTab) return;
      p.credTab = next;
      paintConnection(p, credFocusSelector(next));
    });
  });

  // API key / custom header form
  const keyForm = el.querySelector('[data-cp-key-form]');
  if (keyForm) {
    keyForm.addEventListener('input', (e) => {
      if (!p.credDraft) return;
      if (e.target?.name === 'token') p.credDraft.token = e.target.value;
      if (e.target?.name === 'customHeader') p.credDraft.customHeader = e.target.value;
    });
    keyForm.addEventListener('change', (e) => {
      if (e.target?.name === 'headerMode' && p.credDraft) {
        p.credDraft.headerMode = e.target.value;
        paintConnection(p, e.target.value === 'custom' ? '[data-cp-key-form] input[name="customHeader"]' : '[data-cp-key-form] input[name="token"]');
      }
    });
    keyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (p.savingKey) return;
      const token = String(keyForm.querySelector('input[name="token"]')?.value || '').trim();
      if (!token) return;
      const mode = p.credDraft?.headerMode || 'bearer';
      const customHeader = String(keyForm.querySelector('input[name="customHeader"]')?.value || p.credDraft?.customHeader || '').trim();
      let patchBody;
      if (mode === 'bearer') {
        patchBody = { token };
      } else {
        const headerName = mode === 'custom' ? customHeader : mode;
        if (!headerName || /[\r\n:\s]/.test(headerName)) {
          toast('Enter a valid header name (e.g. X-Api-Key).', 'err');
          return;
        }
        patchBody = { headers: { [headerName]: token } };
      }
      p.savingKey = true;
      paintConnection(p);
      try {
        await api(`/api/mcps/${encodeURIComponent(mcp.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(patchBody),
        });
        if (!alive(p)) return;
        const syncRes = await api(`/api/mcps/${encodeURIComponent(mcp.id)}/sync`, { method: 'POST' });
        if (!alive(p)) return;
        if (syncRes?.mcp) p.mcp = mergeMcp(p.mcp, syncRes.mcp);
        p.changed = true;
        if (p.mcp.tokenRejected) {
          toast('That key was rejected by the server.', 'err');
        } else if (p.mcp.authRequired) {
          toast('Server still requested sign-in. Check the key or header name.', 'err');
        } else if (p.mcp.lastError) {
          toast(p.mcp.lastError, 'err');
        } else {
          if (p.credDraft) p.credDraft.token = '';
          p.credOpen = false;
          const counts = toolCountsOf(p.ctx, p.mcp);
          toast(`Connected${counts.total ? ` — ${counts.total} ${counts.total === 1 ? 'tool' : 'tools'} ready.` : '.'}`, 'ok');
        }
      } catch (err) {
        if (!alive(p)) return;
        toast(err.message || 'Could not save credentials.', 'err');
      } finally {
        if (alive(p)) {
          p.savingKey = false;
          paintConnection(p);
        }
      }
    });
  }

  // Agent login form (saved encrypted in Vault, bound to https origin, shared with selected agents)
  const loginForm = el.querySelector('[data-cp-login-form]');
  if (loginForm) {
    loginForm.addEventListener('input', (e) => {
      if (!p.credDraft) return;
      if (e.target?.name === 'origin') p.credDraft.origin = e.target.value;
      if (e.target?.name === 'username') p.credDraft.username = e.target.value;
      if (e.target?.name === 'password') p.credDraft.password = e.target.value;
    });
    loginForm.querySelectorAll('[data-cp-login-agent]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const aid = btn.dataset.cpLoginAgent;
        if (!aid || !p.credDraft) return;
        if (!(p.credDraft.agentIds instanceof Set)) p.credDraft.agentIds = new Set();
        if (p.credDraft.agentIds.has(aid)) p.credDraft.agentIds.delete(aid);
        else p.credDraft.agentIds.add(aid);
        paintConnection(p, `[data-cp-login-agent="${CSS.escape(aid)}"]`);
      });
    });
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (p.savingLogin) return;
      const origin = String(loginForm.querySelector('input[name="origin"]')?.value || '').trim();
      const username = String(loginForm.querySelector('input[name="username"]')?.value || '').trim();
      const password = String(loginForm.querySelector('input[name="password"]')?.value || '');
      if (!origin || !password) return;
      const agentIds = p.credDraft?.agentIds instanceof Set ? [...p.credDraft.agentIds] : undefined;
      p.savingLogin = true;
      paintConnection(p);
      try {
        const res = await api(`/api/mcps/${encodeURIComponent(mcp.id)}/login`, {
          method: 'POST',
          body: JSON.stringify({
            origin,
            username,
            password,
            ...(Array.isArray(agentIds) ? { agentIds } : {}),
          }),
        });
        if (!alive(p)) return;
        if (res?.mcp) p.mcp = mergeMcp(p.mcp, res.mcp);
        if (res?.login?.key && Array.isArray(p.agents)) {
          const grantedIds = new Set((res.login.sharedWith || []).map((a) => a.id));
          for (const a of p.agents) {
            if (grantedIds.has(a.id)) {
              const list = Array.isArray(a.secrets) ? a.secrets : [];
              if (!list.includes(res.login.key)) a.secrets = [...list, res.login.key];
            }
          }
        }
        if (p.credDraft) p.credDraft.password = '';
        p.credOpen = false;
        p.changed = true;
        const who = (res?.login?.sharedWith || []).map((a) => a.name).join(', ');
        toast(who ? `Login saved in Vault and shared with ${who}.` : 'Login saved in Vault.', 'ok');
      } catch (err) {
        if (!alive(p)) return;
        toast(err.message || 'Could not save login.', 'err');
      } finally {
        if (alive(p)) {
          p.savingLogin = false;
          paintConnection(p);
        }
      }
    });
  }

  // OAuth App (static Client ID + Secret -> immediate OAuth redirect)
  const oauthClientForm = el.querySelector('[data-cp-oauth-client-form]');
  if (oauthClientForm) {
    oauthClientForm.addEventListener('input', (e) => {
      if (!p.credDraft) return;
      if (e.target?.name === 'clientId') p.credDraft.clientId = e.target.value;
      if (e.target?.name === 'clientSecret') p.credDraft.clientSecret = e.target.value;
    });
    oauthClientForm.querySelector('[data-cp-copy-callback]')?.addEventListener('click', (e) => {
      const cb = e.currentTarget.dataset.cpCopyCallback || `${location.origin}/oauth/callback`;
      if (typeof copyText === 'function') copyText(cb, 'Copied callback URL.');
      else navigator.clipboard?.writeText?.(cb).then(() => toast('Copied callback URL.', 'ok')).catch(() => {});
    });
    oauthClientForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (p.startingOAuth) return;
      const clientId = String(oauthClientForm.querySelector('input[name="clientId"]')?.value || '').trim();
      const clientSecret = String(oauthClientForm.querySelector('input[name="clientSecret"]')?.value || '').trim();
      if (!clientId) return;
      await startConnectionOAuth(p, { clientId, clientSecret });
    });
  }

  el.querySelector('[data-cp-approve-name]')?.addEventListener('click', async () => {
    p.approvingName = true;
    paintConnection(p);
    try {
      const res = await api(`/api/mcps/${encodeURIComponent(mcp.id)}/approve-name`, { method: 'POST' });
      if (!alive(p)) return;
      if (res?.mcp) p.mcp = mergeMcp(p.mcp, res.mcp);
      p.changed = true;
      toast('Name approved. Agents see it in their startup context from their next session.', 'ok');
    } catch (err) {
      if (!alive(p)) return;
      toast(err.message || 'Could not approve the name.', 'err');
    } finally {
      if (alive(p)) {
        p.approvingName = false;
        paintConnection(p);
      }
    }
  });

  // Enabled switch
  el.querySelector('[data-cp-toggle]')?.addEventListener('click', async () => {
    const prev = Boolean(mcp.enabled);
    const next = !prev;
    p.mcp.enabled = next;
    paintConnection(p, '[data-cp-toggle]');
    try {
      const res = await api(`/api/mcps/${encodeURIComponent(mcp.id)}/toggle`, {
        method: 'POST',
        body: JSON.stringify({ enabled: next }),
      });
      if (!alive(p)) return;
      if (res?.mcp) p.mcp = mergeMcp(p.mcp, res.mcp);
      p.changed = true;
      paintConnection(p, '[data-cp-toggle]');
    } catch (err) {
      if (!alive(p)) return;
      p.mcp.enabled = prev;
      toast(err.message || 'Could not update connection.', 'err');
      paintConnection(p, '[data-cp-toggle]');
    }
  });

  // Partner Skills opt-in switch (Owner only)
  el.querySelector('[data-cp-partner-skills]')?.addEventListener('click', async () => {
    const prev = Boolean(mcp.partnerSkillsEnabled);
    const next = !prev;
    p.mcp.partnerSkillsEnabled = next;
    paintConnection(p, '[data-cp-partner-skills]');
    try {
      const res = await api(`/api/mcps/${encodeURIComponent(mcp.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ partnerSkillsEnabled: next }),
      });
      if (!alive(p)) return;
      if (res?.mcp) p.mcp = mergeMcp(p.mcp, res.mcp);
      p.changed = true;
      toast(next ? 'Partner Skills enabled for this connection.' : 'Partner Skills disabled for this connection.', 'ok');
      paintConnection(p, '[data-cp-partner-skills]');
    } catch (err) {
      if (!alive(p)) return;
      p.mcp.partnerSkillsEnabled = prev;
      toast(err.message || 'Could not update partner Skills setting.', 'err');
      paintConnection(p, '[data-cp-partner-skills]');
    }
  });

  // Category select
  el.querySelector('[data-cp-category]')?.addEventListener('change', async (e) => {
    const sel = e.currentTarget;
    const prevId = mcp.category || 'general';
    const prevLabel = mcp.categoryLabel || 'General';
    const nextId = sel.value;
    const targetCat = p.categories.find((c) => c.id === nextId);
    if (!targetCat) return;
    sel.disabled = true;
    try {
      const res = await api('/api/categories', {
        method: 'POST',
        body: JSON.stringify({
          id: targetCat.id,
          label: targetCat.label,
          description: targetCat.description || '',
          connections: [mcp.id],
        }),
      });
      if (!alive(p)) return;
      p.mcp.category = targetCat.id;
      p.mcp.categoryLabel = targetCat.label;
      if (Array.isArray(res?.categories)) {
        p.categories = buildCategoriesList(p.mcpsData, { categories: res.categories }, p.mcp);
      }
      p.changed = true;
      toast(`Moved "${mcp.name}" to ${targetCat.label}.`, 'ok');
      paintConnection(p, '[data-cp-category]');
    } catch (err) {
      if (!alive(p)) return;
      p.mcp.category = prevId;
      p.mcp.categoryLabel = prevLabel;
      toast(err.message || 'Could not update category.', 'err');
      paintConnection(p, '[data-cp-category]');
    }
  });

  // Approval rule segmented control
  el.querySelectorAll('[data-cp-field="approval"] [data-val]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.getAttribute('aria-pressed') === 'true') return;
      const prev = normApproval(p.ctx, mcp.approval, 'inherit');
      const next = btn.dataset.val;
      p.mcp.approval = next;
      paintConnection(p, `[data-cp-field="approval"] [data-val="${CSS.escape(next)}"]`);
      try {
        const res = await saveRule(() => el.querySelector('.cp-approval'), {
          what: mcp.name,
          passwordName: p.ctx.passwordName?.(),
          onNoPassword: p.ctx.noGuardPassword,
          send: (password) => api('/api/policies', {
            method: 'PATCH',
            body: JSON.stringify({ connections: { [mcp.id]: next }, password }),
          }),
        });
        if (!alive(p)) return;
        if (!res) {
          p.mcp.approval = prev;
          paintConnection(p, `[data-cp-field="approval"] [data-val="${CSS.escape(prev)}"]`);
          return;
        }
        if (res?.policies && typeof res.policies === 'object') {
          p.policies = res.policies;
          p.toolApprovals = { ...(res.policies.tools || {}) };
        }
        const saved = res?.policies?.connections
          ? normApproval(p.ctx, res.policies.connections[mcp.id], 'inherit')
          : normApproval(p.ctx, next, 'inherit');
        p.mcp.approval = saved;
        p.changed = true;
        toast('Approval rule updated.', 'ok');
        paintConnection(p, `[data-cp-field="approval"] [data-val="${CSS.escape(saved)}"]`);
      } catch (err) {
        if (!alive(p)) return;
        p.mcp.approval = prev;
        toast(err.message || 'Could not update approval rule.', 'err');
        paintConnection(p, `[data-cp-field="approval"] [data-val="${CSS.escape(prev)}"]`);
      }
    });
  });

  // Profile chips toggle
  el.querySelectorAll('[data-cp-profile]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const profileId = btn.dataset.cpProfile;
      if (!profileId) return;
      const nextSet = new Set((Array.isArray(mcp.profiles) ? mcp.profiles : []).filter((id) => id && id !== 'all'));
      const removing = nextSet.has(profileId);
      if (removing) nextSet.delete(profileId);
      else nextSet.add(profileId);
      const nextProfiles = ['all', ...Array.from(nextSet).sort((a, b) => a.localeCompare(b))];
      btn.disabled = true;
      try {
        const res = await api(`/api/mcps/${encodeURIComponent(mcp.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ profiles: nextProfiles }),
        });
        if (!alive(p)) return;
        p.mcp = mergeMcp(p.mcp, res?.mcp || { profiles: nextProfiles });
        if (!Array.isArray(res?.mcp?.profiles)) p.mcp.profiles = nextProfiles;
        p.changed = true;
        const pName = profileNameOf(profileId, p.profileRecords);
        toast(removing ? `Removed "${mcp.name}" from ${pName}.` : `Added "${mcp.name}" to ${pName}.`, 'ok');
        paintConnection(p, `[data-cp-profile="${CSS.escape(profileId)}"]`);
      } catch (err) {
        if (!alive(p)) return;
        btn.disabled = false;
        toast(err.message || 'Could not update projects.', 'err');
      }
    });
  });

  // Account label form
  el.querySelector('[data-cp-account-form]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (p.savingAccountLabel) return;
    const input = e.currentTarget.querySelector('input[name="accountLabel"]');
    const accountLabel = String(input?.value || '').trim();
    p.savingAccountLabel = true;
    paintConnection(p);
    try {
      const res = await api(`/api/mcps/${encodeURIComponent(mcp.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ accountLabel }),
      });
      if (!alive(p)) return;
      p.mcp = mergeMcp(p.mcp, res?.mcp || { accountLabel });
      p.mcp.accountLabel = res?.mcp?.accountLabel ?? (accountLabel || '');
      p.changed = true;
      toast('Account label saved.', 'ok');
    } catch (err) {
      if (!alive(p)) return;
      toast(err.message || 'Could not save account label.', 'err');
    } finally {
      if (alive(p)) {
        p.savingAccountLabel = false;
        paintConnection(p, '[data-cp-account-form] input[name="accountLabel"]');
      }
    }
  });

  // Description form
  el.querySelector('[data-cp-desc-form]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (p.savingDesc) return;
    const input = e.currentTarget.querySelector('input[name="description"]');
    const description = String(input?.value || '').trim();
    p.savingDesc = true;
    paintConnection(p);
    try {
      const res = await api(`/api/mcps/${encodeURIComponent(mcp.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ description }),
      });
      if (!alive(p)) return;
      p.mcp = mergeMcp(p.mcp, res?.mcp || { description });
      p.mcp.description = res?.mcp?.description ?? description;
      p.changed = true;
      toast('Description saved.', 'ok');
    } catch (err) {
      if (!alive(p)) return;
      toast(err.message || 'Could not save description.', 'err');
    } finally {
      if (alive(p)) {
        p.savingDesc = false;
        paintConnection(p, '[data-cp-desc-form] input[name="description"]');
      }
    }
  });

  // Tools search input (live-filters list without stealing focus)
  el.querySelector('#cp-tool-q')?.addEventListener('input', (e) => {
    p.toolQuery = e.currentTarget.value;
    updateToolsListOnly(p);
  });

  bindToolsList(p);
}

function bindToolsList(p) {
  const { api, toast } = p.ctx;
  const { mcp } = p;
  const wrap = p.el.querySelector('#cp-tool-list-wrap');
  if (!wrap) return;

  wrap.querySelector('[data-cp-clear-search]')?.addEventListener('click', () => {
    p.toolQuery = '';
    const input = p.el.querySelector('#cp-tool-q');
    if (input) input.value = '';
    updateToolsListOnly(p, '#cp-tool-q');
  });

  // Pin / unpin tool
  wrap.querySelectorAll('[data-cp-tool-pin]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const toolName = btn.dataset.cpToolPin;
      const nextPinned = btn.dataset.pinned !== 'true';
      btn.disabled = true;
      try {
        const res = await api(`/api/mcps/${encodeURIComponent(mcp.id)}/tools/pin`, {
          method: 'POST',
          body: JSON.stringify({ toolName, pinned: nextPinned }),
        });
        if (!alive(p)) return;
        if (res?.mcp) p.mcp = mergeMcp(p.mcp, res.mcp);
        p.changed = true;
        toast(nextPinned ? `Pinned "${mcp.id}__${toolName}" top-level.` : `Unpinned "${mcp.id}__${toolName}".`, 'ok');
        updateToolsListOnly(p, `[data-cp-tool-pin="${CSS.escape(toolName)}"]`);
      } catch (err) {
        if (!alive(p)) return;
        btn.disabled = false;
        toast(err.message || 'Could not update pin.', 'err');
      }
    });
  });

  // Per-tool approval toggle
  wrap.querySelectorAll('[data-cp-tool-approval]').forEach((select) => {
    select.addEventListener('change', async () => {
      const toolName = select.dataset.cpToolApproval;
      const next = select.value;
      const toolKey = `${mcp.id}__${toolName}`;
      const again = `[data-cp-tool-approval="${CSS.escape(toolName)}"]`;
      select.disabled = true;
      try {
        const res = await saveRule(() => select.closest('.cp-tool-item'), {
          what: toolName,
          passwordName: p.ctx.passwordName?.(),
          onNoPassword: p.ctx.noGuardPassword,
          send: (password) => api('/api/policies', {
            method: 'PATCH',
            body: JSON.stringify({ tools: { [toolKey]: next }, password }),
          }),
        });
        if (!alive(p)) return;
        if (!res) {
          updateToolsListOnly(p, again);
          return;
        }
        if (res?.policies && typeof res.policies === 'object') {
          p.policies = res.policies;
          p.toolApprovals = { ...(res.policies.tools || {}) };
        } else if (next === 'inherit') {
          delete p.toolApprovals[toolKey];
        } else {
          p.toolApprovals[toolKey] = next;
        }
        p.changed = true;
        toast(next === 'inherit' ? `"${toolName}" follows the default.` : `"${toolName}" is on ${modeLabel(next)}.`, 'ok');
        updateToolsListOnly(p, again);
      } catch (err) {
        if (!alive(p)) return;
        toast(err.message || 'Could not update tool approval.', 'err');
        updateToolsListOnly(p, again);
      }
    });
  });

  // Per-tool enable/disable switch
  wrap.querySelectorAll('[data-cp-tool-toggle]').forEach((sw) => {
    sw.addEventListener('click', async () => {
      const toolName = sw.dataset.cpToolToggle;
      const nextEnabled = sw.getAttribute('aria-checked') !== 'true';
      sw.disabled = true;
      try {
        const res = await api(`/api/mcps/${encodeURIComponent(mcp.id)}/tools/toggle`, {
          method: 'POST',
          body: JSON.stringify({ toolName, enabled: nextEnabled }),
        });
        if (!alive(p)) return;
        if (res?.mcp) {
          p.mcp = mergeMcp(p.mcp, res.mcp);
        } else {
          const set = new Set(p.mcp.disabledTools || []);
          if (nextEnabled) set.delete(toolName);
          else set.add(toolName);
          p.mcp.disabledTools = Array.from(set);
        }
        p.changed = true;
        paintConnection(p, `[data-cp-tool-toggle="${CSS.escape(toolName)}"]`);
      } catch (err) {
        if (!alive(p)) return;
        sw.disabled = false;
        toast(err.message || 'Could not update tool.', 'err');
      }
    });
  });

  // Toggle inline tool tester
  wrap.querySelectorAll('[data-cp-tool-test]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const toolName = btn.dataset.cpToolTest;
      if (p.openTesters.has(toolName)) {
        p.openTesters.delete(toolName);
        updateToolsListOnly(p, `[data-cp-tool-test="${CSS.escape(toolName)}"]`);
      } else {
        const tool = (Array.isArray(mcp.tools) ? mcp.tools : []).find((t) => t.name === toolName);
        p.openTesters.set(toolName, {
          argsText: seedArgsFromSchema(tool?.inputSchema),
          output: null,
          isError: false,
          running: false,
        });
        updateToolsListOnly(p, `[data-cp-tester-args="${CSS.escape(toolName)}"]`);
      }
    });
  });

  // Track tester JSON edits
  wrap.querySelectorAll('[data-cp-tester-args]').forEach((ta) => {
    ta.addEventListener('input', () => {
      const st = p.openTesters.get(ta.dataset.cpTesterArgs);
      if (st) st.argsText = ta.value;
    });
  });

  // Reset tester JSON
  wrap.querySelectorAll('[data-cp-reset-tester]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const toolName = btn.dataset.cpResetTester;
      const st = p.openTesters.get(toolName);
      if (!st) return;
      st.argsText = '{}';
      st.output = null;
      st.isError = false;
      updateToolsListOnly(p, `[data-cp-tester-args="${CSS.escape(toolName)}"]`);
    });
  });

  // Run tool test
  wrap.querySelectorAll('[data-cp-run-tool]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const toolName = btn.dataset.cpRunTool;
      const st = p.openTesters.get(toolName);
      if (!st || st.running) return;

      let parsedArgs;
      try {
        const raw = (st.argsText || '{}').trim() || '{}';
        parsedArgs = JSON.parse(raw);
        if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
          throw new Error('Arguments must be a JSON object.');
        }
      } catch (err) {
        toast(err.message || 'Arguments must be valid JSON.', 'err');
        return;
      }

      st.running = true;
      updateToolsListOnly(p);
      try {
        const res = await api(`/api/mcps/${encodeURIComponent(mcp.id)}/tools/test`, {
          method: 'POST',
          body: JSON.stringify({ toolName, arguments: parsedArgs }),
        });
        if (!alive(p)) return;
        const formatted = formatTestOutput(p.ctx, res);
        st.output = formatted.text;
        st.isError = formatted.isError;
      } catch (err) {
        if (!alive(p)) return;
        st.output = err.message || 'Tool call failed.';
        st.isError = true;
      } finally {
        if (alive(p)) {
          st.running = false;
          updateToolsListOnly(p, `[data-cp-run-tool="${CSS.escape(toolName)}"]`);
        }
      }
    });
  });
}

/* ---------- 2. Add Connection & Import JSON popup ---------- */

const SECRET_QUERY_KEY_RE = /(key|token|secret|passw|pwd|auth|credential|bearer|cookie|session|private|signature|jwt)|^(?:sig|pass|pat)$/i;

function remoteEndpointKey(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return '';
  try {
    const u = new URL(rawUrl.trim());
    const base = `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
    const kept = [];
    for (const [k, v] of u.searchParams.entries()) {
      const lk = String(k || '').trim().toLowerCase();
      if (!lk || SECRET_QUERY_KEY_RE.test(lk)) continue;
      const sv = String(v ?? '').trim();
      if (sv.includes('{{vault:')) continue;
      kept.push(`${lk}=${sv}`);
    }
    if (!kept.length) return base;
    kept.sort();
    return `${base}?${kept.join('&')}`;
  } catch {
    return '';
  }
}

function findExistingRemoteMatch(existingMcps, rawUrl) {
  const key = remoteEndpointKey(rawUrl);
  if (!key || !Array.isArray(existingMcps)) return null;
  const matches = existingMcps.filter((m) => {
    if (!m || m.lent) return false;
    const t = getTransport(m);
    if (t === 'stdio' || t === 'builtin' || !m.url) return false;
    return remoteEndpointKey(m.url) === key;
  });
  if (!matches.length) return null;
  return matches.find((m) => m.enabled !== false && m.readiness?.ready)
    || matches.find((m) => m.enabled !== false)
    || matches[0];
}

export async function openAddConnectionPopup(ctx, opts = {}) {
  const p = mount(ctx, 'Add connection', 'ap-flow cp-add-sheet');
  p.kind = 'add';
  const allowLocal = !isPersonal(ctx);
  const requestedProfile = typeof opts?.profile === 'string' && opts.profile.trim()
    ? opts.profile.trim().toLowerCase()
    : currentActiveProfile(ctx);

  p.add = {
    tab: opts?.tab === 'import' || (opts?.tab === 'agents' && allowLocal && typeof ctx.renderImportFromAgents === 'function') ? opts.tab : 'add',
    allowLocal,
    transportMode: 'remote',
    profileRecords: [],
    existingMcps: [],
    selectedProfiles: new Set(),
    remote: {
      url: '',
      name: '',
      accountLabel: '',
      transport: 'auto',
      token: '',
      probeToken: '',
      headers: '',
      description: '',
      probing: false,
      submitting: false,
      status: null,
      error: '',
      redirectUrl: '',
      suggestedName: '',
      probeTransport: '',
      existingMatch: null,
      existingLabel: '',
      existingUrl: '',
      existingTransport: '',
      advancedOpen: false,
    },
    stdio: {
      name: '',
      accountLabel: '',
      description: '',
      command: '',
      args: '',
      env: '',
      cwd: '',
      submitting: false,
    },
    imp: {
      json: '',
      profile: 'all',
      submitting: false,
      summary: null,
    },
  };

  const [profileRes, mcpsRes] = await Promise.all([
    ctx.api('/api/profiles').catch(() => null),
    ctx.api('/api/mcps').catch(() => null),
  ]);
  if (!alive(p)) return;

  const profileData = profileRes || mcpsRes;
  p.add.existingMcps = Array.isArray(mcpsRes?.mcps) ? mcpsRes.mcps : [];
  const records = extractProfiles(profileData);
  const explicitProfile = typeof opts?.profile === 'string' ? opts.profile.trim().toLowerCase() : '';
  if (explicitProfile && explicitProfile !== 'all' && !records.some((r) => r.id === explicitProfile)) {
    records.push({ id: explicitProfile, name: explicitProfile, description: '' });
  }
  p.add.profileRecords = records;
  if (requestedProfile && requestedProfile !== 'all') {
    if (records.some((r) => r.id === requestedProfile)) {
      p.add.selectedProfiles.add(requestedProfile);
      p.add.imp.profile = requestedProfile;
    }
  }

  paintAdd(p, { import: '#cp-import-json', agents: '[data-cp-add-tab="agents"]' }[p.add.tab] || '#cp-add-url');
}

function selectedProfilesPayload(selectedSet) {
  const tags = Array.from(selectedSet || []).filter((id) => id && id !== 'all').sort((a, b) => a.localeCompare(b));
  return ['all', ...tags];
}

function renderProfileHint(esc, selectedSet, profileRecords) {
  const names = Array.from(selectedSet || [])
    .filter((id) => id && id !== 'all')
    .map((id) => profileNameOf(id, profileRecords));
  if (names.length === 0) return '';
  return `<p class="pf-add-hint">Will be added to <strong>${esc(names.join(', '))}</strong></p>`;
}

function renderAddProfileChips(esc, selectedSet, profileRecords) {
  if (!Array.isArray(profileRecords) || profileRecords.length === 0) return '';
  return `
    <div class="field">
      <span class="lbl">Projects (optional)</span>
      <div class="pf-chips" role="group" aria-label="Assign projects">
        ${profileRecords.map((rec) => {
          const on = selectedSet.has(rec.id);
          return `<button type="button" class="pf-chip" data-cp-add-profile="${esc(rec.id)}" aria-pressed="${on}">
            <span class="pf-chip-ic" aria-hidden="true">${on ? CHECK_ICON : ''}</span>
            <span>${esc(rec.name)}</span>
          </button>`;
        }).join('')}
      </div>
      <span class="hint">Always available in All. Pick any additional projects for this connection.</span>
    </div>`;
}

function renderImportSummary(esc, summary) {
  if (!summary) return '';
  const hasNotes = (summary.skipped?.length || 0) > 0 || (summary.dropped?.length || 0) > 0;
  const updatedCount = Number(summary.updatedCount || 0);
  const importedNames = Array.isArray(summary.addedNames) && summary.addedNames.length > 0 && summary.addedNames.length <= 8
    ? ` (${summary.addedNames.join(', ')})`
    : '';
  const updatedNames = Array.isArray(summary.updatedNames) && summary.updatedNames.length > 0 && summary.updatedNames.length <= 8
    ? ` (${summary.updatedNames.join(', ')})`
    : '';
  const leadParts = [];
  if (summary.addedCount > 0 || updatedCount === 0) {
    leadParts.push(`Imported ${summary.addedCount} connection${summary.addedCount === 1 ? '' : 's'}${importedNames}`);
  }
  if (updatedCount > 0) {
    leadParts.push(`Updated ${updatedCount} connection${updatedCount === 1 ? '' : 's'}${updatedNames}`);
  }
  const vaultNote = summary.secretsMoved > 0
    ? ` · ${summary.secretsMoved} key${summary.secretsMoved === 1 ? '' : 's'} moved to Vault`
    : '';
  return `
    <div class="callout ${hasNotes ? 'warn' : ''} import-summary-callout" role="status">
      <div class="import-summary-head">
        <div>
          <strong>${esc(leadParts.join(' · '))}</strong>${esc(vaultNote)}
        </div>
      </div>
      ${summary.skipped?.length ? `
        <div class="import-summary-group">
          <strong>Skipped (${esc(summary.skipped.length)}):</strong>
          <ul class="import-summary-list">
            ${summary.skipped.map((item) => {
              if (typeof item === 'string') return `<li>${esc(item)}</li>`;
              const name = item?.name || item?.key || item?.id || 'Server';
              const reason = item?.existing?.name ? `Already in Loop as ${item.existing.name}.` : item?.reason || item?.error || 'Skipped';
              return `<li><strong>${esc(name)}</strong> — ${esc(reason)}</li>`;
            }).join('')}
          </ul>
        </div>
      ` : ''}
      ${summary.dropped?.length ? `
        <div class="import-summary-group">
          <strong>Dropped unusable settings:</strong>
          <ul class="import-summary-list">
            ${summary.dropped.map((entry) => {
              const items = Array.isArray(entry.settings)
                ? entry.settings.map((s) => (typeof s === 'string' ? s : (s?.setting || s?.field || s?.reason || JSON.stringify(s)))).join(', ')
                : String(entry.settings || '');
              return `<li>${entry.name ? `<strong>${esc(entry.name)}</strong>: ` : ''}${esc(items)}</li>`;
            }).join('')}
          </ul>
        </div>
      ` : ''}
    </div>`;
}

function paintAdd(p, focus = null) {
  const { esc } = p.ctx;
  const a = p.add;

  const isImport = a.tab === 'import';
  const isAgentsImport = a.allowLocal && a.tab === 'agents' && typeof p.ctx.renderImportFromAgents === 'function';
  const isStdio = a.allowLocal && a.transportMode === 'stdio';
  const r = a.remote;
  const s = a.stdio;
  const imp = a.imp;
  const hasAdvanced = Boolean(
    r.advancedOpen
    || (r.transport && r.transport !== 'auto')
    || r.token
    || r.headers
    || r.description,
  );

  let title = 'Add connection';
  let sub = a.allowLocal
    ? 'Paste a remote MCP server URL, or open Advanced for local command servers.'
    : 'Paste a remote HTTPS MCP server URL. Loop detects OAuth or API keys automatically.';
  if (isImport) {
    title = 'Import JSON';
    sub = a.allowLocal
      ? 'Paste any mcp_config.json, Claude Code, Codex, Cursor, or 1MCP configuration. Saved keys move to your encrypted Vault automatically.'
      : 'Paste any mcp_config.json, Claude Code, Codex, Cursor, or 1MCP configuration. Remote URL servers are imported and keys move to Vault; local commands are skipped in hosted workspaces.';
  } else if (isAgentsImport) {
    title = 'Import from your agents';
    sub = 'Use the servers that Claude Code, Codex, Cursor, Antigravity and other apps on this Mac already have. Saved keys and tokens move to your encrypted Vault.';
  } else if (isStdio) {
    title = 'Add local connection';
    sub = 'Run a local command-line MCP server on this Mac.';
  }

  let bodyHtml = '';
  let footHtml = '';

  if (isAgentsImport) {
    bodyHtml = a.imported ? renderImportSummary(esc, a.imported) : '<div id="cp-agents-import-slot"></div>';
    footHtml = `<span class="ap-grow"></span><button type="button" class="btn sm ${a.imported ? 'fill' : 'ghost'}" data-cp-close>${a.imported ? 'Done' : 'Cancel'}</button>`;
  } else if (isImport) {
    const placeholder = a.allowLocal
      ? '{ "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } } }'
      : '{ "mcpServers": { "linear": { "url": "https://mcp.linear.app/mcp" } } }';
    const selectedProfileName = profileNameOf(imp.profile, a.profileRecords);
    bodyHtml = `
      ${imp.profile && imp.profile !== 'all' ? `<p class="pf-add-hint">Will be added to <strong>${esc(selectedProfileName)}</strong></p>` : ''}
      ${imp.summary ? renderImportSummary(esc, imp.summary) : ''}
      <form id="cp-import-form" class="form-grid">
        <label class="field">
          <span class="lbl">Configuration JSON</span>
          <textarea
            id="cp-import-json"
            name="json"
            required
            class="code-input"
            rows="7"
            spellcheck="false"
            placeholder="${esc(placeholder)}"
          >${esc(imp.json)}</textarea>
        </label>
        <label class="field">
          <span class="lbl">Project</span>
          <select name="profile" class="ap-select cp-profile-select">
            <option value="all" ${imp.profile === 'all' ? 'selected' : ''}>All</option>
            ${a.profileRecords.map((rec) => `<option value="${esc(rec.id)}" ${imp.profile === rec.id ? 'selected' : ''}>${esc(rec.name)}</option>`).join('')}
          </select>
        </label>
      </form>`;
    footHtml = `
      <span class="ap-grow"></span>
      <button type="button" class="btn sm ghost" data-cp-close>${imp.summary ? 'Done' : 'Cancel'}</button>
      <button type="submit" form="cp-import-form" class="btn sm fill" ${imp.submitting ? 'disabled' : ''}>${imp.submitting ? 'Importing…' : 'Import connections'}</button>`;
  } else if (isStdio) {
    bodyHtml = `
      <div class="advanced-local-row">
        <span class="hint">Running a local MCP command on this Mac.</span>
        <button type="button" class="btn sm ghost" data-cp-transport-mode="remote">Use a Server URL instead</button>
      </div>
      ${renderProfileHint(esc, a.selectedProfiles, a.profileRecords)}
      <form id="cp-add-form" class="form-grid">
        <div class="form-row">
          <label class="field">
            <span class="lbl">Name</span>
            <input id="cp-stdio-name" name="name" type="text" required placeholder="e.g. Local Filesystem" value="${esc(s.name)}">
          </label>
          <label class="field">
            <span class="lbl">Account label (optional)</span>
            <input name="accountLabel" type="text" maxlength="60" placeholder="e.g. Work or Personal" value="${esc(s.accountLabel)}">
          </label>
        </div>
        <div class="form-row">
          <label class="field">
            <span class="lbl">Command</span>
            <input name="command" type="text" required class="code-input" placeholder="npx" spellcheck="false" value="${esc(s.command)}">
          </label>
          <label class="field">
            <span class="lbl">Arguments (optional)</span>
            <input name="args" type="text" class="code-input" placeholder="-y @modelcontextprotocol/server-filesystem /tmp" spellcheck="false" value="${esc(s.args)}">
          </label>
        </div>
        <label class="field">
          <span class="lbl">Environment Variables (optional)</span>
          <textarea name="env" class="code-input" rows="3" placeholder="GITHUB_TOKEN={{vault:GITHUB_TOKEN}}" spellcheck="false">${esc(s.env)}</textarea>
          <span class="hint">One <code class="inline-code">KEY=VALUE</code> per line. Supports <code class="inline-code">{{vault:KEY}}</code> placeholders.</span>
        </label>
        <div class="form-row">
          <label class="field">
            <span class="lbl">Working Directory (optional)</span>
            <input name="cwd" type="text" class="code-input" placeholder="/path/to/workspace" spellcheck="false" value="${esc(s.cwd)}">
          </label>
          <label class="field">
            <span class="lbl">Description (optional)</span>
            <input name="description" type="text" maxlength="500" placeholder="e.g. Read and edit files in a folder." value="${esc(s.description)}">
          </label>
        </div>
        ${renderAddProfileChips(esc, a.selectedProfiles, a.profileRecords)}
      </form>`;
    footHtml = `
      <span class="ap-grow"></span>
      <button type="button" class="btn sm ghost" data-cp-close>Cancel</button>
      <button type="submit" form="cp-add-form" class="btn sm fill" ${s.submitting ? 'disabled' : ''}>${s.submitting ? 'Adding…' : 'Add connection'}</button>`;
  } else {
    const busy = r.probing || r.submitting;
    const submitLabel = r.status === 'api_key'
      ? (busy ? 'Connecting…' : 'Save & Connect')
      : (r.probing ? 'Checking…' : r.submitting ? 'Connecting…' : 'Connect');
    bodyHtml = `
      ${renderProfileHint(esc, a.selectedProfiles, a.profileRecords)}
      <form id="cp-add-form" class="form-grid">
        <label class="field">
          <span class="lbl">Server URL</span>
          <input id="cp-add-url" name="url" type="url" required placeholder="https://mcp.linear.app/mcp" value="${esc(r.url)}">
        </label>
        <div class="form-row">
          <label class="field">
            <span class="lbl">Name (optional)</span>
            <input name="name" type="text" placeholder="Auto-detected from server" value="${esc(r.name)}">
          </label>
          <label class="field">
            <span class="lbl">Account label (optional)</span>
            <input name="accountLabel" type="text" maxlength="60" placeholder="e.g. Work or Personal" value="${esc(r.accountLabel)}">
          </label>
        </div>

        ${renderAddProfileChips(esc, a.selectedProfiles, a.profileRecords)}

        ${r.status === 'redirect' ? `
          <div class="callout warn add-conn-step" role="status">
            <p>This address redirects to <code class="inline-code">${esc(r.redirectUrl || '')}</code>.</p>
            <div class="acts">
              <button type="button" class="btn sm fill" data-cp-use-redirect ${busy ? 'disabled' : ''}>Use new address</button>
            </div>
          </div>
        ` : ''}

        ${r.status === 'exists' && r.existingMatch ? (() => {
          const m = r.existingMatch;
          const mProfiles = Array.isArray(m.profiles) ? m.profiles : ['all'];
          const missingProjects = Array.from(a.selectedProfiles || []).filter((id) => id && id !== 'all' && !mProfiles.includes(id));
          const missingNames = missingProjects.map((id) => profileNameOf(id, a.profileRecords)).join(', ');
          const stateText = m.enabled === false
            ? 'Turned off in Loop.'
            : m.readiness?.ready
              ? `Ready · ${Array.isArray(m.tools) ? m.tools.length : 0} tools`
              : (m.readiness?.label || 'Needs sign-in');
          const openLabel = m.enabled === false
            ? `Turn on ${m.name}`
            : m.readiness?.action === 'sign_in'
              ? `Sign in to ${m.name}`
              : `Open ${m.name}`;
          const urlChanged = Boolean(r.existingUrl && m.url && r.existingUrl !== m.url);
          return `
          <div class="callout add-conn-step cp-exists-card" role="status" data-cp-exists-card>
            <p><strong>${esc(m.name)} is already in your Loop.</strong> ${esc(stateText)}</p>
            <div class="cp-acc-inline">
              <input id="cp-exists-label" name="existingLabel" type="text" maxlength="60" placeholder="Account label (work, personal, project-x)" aria-label="Account label for new account" autocomplete="off" value="${esc(r.existingLabel || '')}" ${busy ? 'disabled' : ''}>
              <button type="button" class="btn sm fill" data-cp-exists-add ${busy ? 'disabled' : ''}>${busy ? 'Adding…' : 'Add account'}</button>
            </div>
            <div class="cp-acc-acts">
              <button type="button" class="btn sm" data-cp-exists-open ${busy ? 'disabled' : ''}>${esc(openLabel)}</button>
              ${missingProjects.length ? `<button type="button" class="btn sm" data-cp-exists-share ${busy ? 'disabled' : ''}>Add to ${esc(missingNames)}</button>` : ''}
              ${urlChanged ? `<button type="button" class="btn sm" data-cp-exists-update ${busy ? 'disabled' : ''}>Update address</button>` : ''}
            </div>
          </div>`;
        })() : ''}

        ${r.status === 'api_key' ? `
          <div class="callout add-conn-step" role="status">
            <p><strong>This server requires an API key or bearer token.</strong> Your key moves to the encrypted Vault automatically.</p>
            <label class="field probe-key-field">
              <span class="lbl">API key or Bearer token</span>
              <input id="cp-probe-token" name="probeToken" type="password" required placeholder="Paste API key or bearer token" autocomplete="new-password" value="${esc(r.probeToken)}">
            </label>
          </div>
        ` : ''}

        ${r.status === 'error' ? `
          <div class="callout bad add-conn-step" role="alert">
            <p>${esc(r.error || 'Could not reach this server.')}</p>
          </div>
        ` : ''}

        <details class="advanced-details" data-cp-advanced ${hasAdvanced ? 'open' : ''}>
          <summary>Advanced</summary>
          <div class="form-grid advanced-body">
            ${a.allowLocal ? `
              <div class="advanced-local-row">
                <span class="hint">Need a local command-line MCP server on this Mac?</span>
                <button type="button" class="btn sm" data-cp-transport-mode="stdio">Local (Command)</button>
              </div>
            ` : ''}
            <label class="field">
              <span class="lbl">Transport</span>
              <select name="transport">
                <option value="auto" ${(r.transport || 'auto') === 'auto' ? 'selected' : ''}>Auto</option>
                <option value="http" ${r.transport === 'http' ? 'selected' : ''}>Streamable HTTP (http)</option>
                <option value="sse" ${r.transport === 'sse' ? 'selected' : ''}>Server-Sent Events (sse)</option>
              </select>
            </label>
            <label class="field">
              <span class="lbl">Bearer Token (optional)</span>
              <input name="token" type="password" value="${esc(r.token)}" placeholder="Saved encrypted in Vault — leave blank if public or OAuth" autocomplete="new-password">
            </label>
            <label class="field">
              <span class="lbl">Extra Headers (optional)</span>
              <textarea name="headers" class="code-input" rows="3" placeholder="X-Api-Key: {{vault:API_KEY}}" spellcheck="false">${esc(r.headers)}</textarea>
              <span class="hint">One <code class="inline-code">Header: Value</code> per line. Supports <code class="inline-code">{{vault:KEY}}</code> placeholders.</span>
            </label>
            <label class="field">
              <span class="lbl">Description (optional)</span>
              <input name="description" type="text" maxlength="500" value="${esc(r.description)}" placeholder="e.g. Issue tracker and project planning">
            </label>
          </div>
        </details>
      </form>`;
    footHtml = `
      <span class="ap-grow"></span>
      <button type="button" class="btn sm ghost" data-cp-close>Cancel</button>
      ${r.status === 'exists' ? '' : `<button type="submit" form="cp-add-form" class="btn sm fill" ${busy ? 'disabled' : ''}>${esc(submitLabel)}</button>`}`;
  }

  inner(p).innerHTML = `
    <div class="ap-flow-in cp-add-in">
      <div class="ap-flow-top cp-add-top">
        <h2 class="ap-flow-t" id="cp-title">${esc(title)}</h2>
        <p class="st-sub">${esc(sub)}</p>
        <div class="ap-tabs cp-add-tabs" role="tablist" aria-label="Add connection mode">
          <span class="st-seg">
            <button type="button" role="tab" data-cp-add-tab="add" aria-selected="${!isImport && !isAgentsImport}" aria-pressed="${!isImport && !isAgentsImport}">New</button>
            <button type="button" role="tab" data-cp-add-tab="import" aria-selected="${isImport}" aria-pressed="${isImport}">Import JSON</button>
            ${a.allowLocal && typeof p.ctx.renderImportFromAgents === 'function' ? `<button type="button" role="tab" data-cp-add-tab="agents" aria-selected="${isAgentsImport}" aria-pressed="${isAgentsImport}">This Mac</button>` : ''}
          </span>
        </div>
      </div>
      <div class="ap-flow-body cp-add-body">${bodyHtml}</div>
      <div class="ap-flow-foot cp-add-foot">${footHtml}</div>
    </div>`;

  p.el.querySelector('.st-sheet')?.setAttribute('aria-labelledby', 'cp-title');
  bindAdd(p);
  if (focus) p.el.querySelector(focus)?.focus();
}

async function runAddRemoteProbe(p) {
  const { api, toast } = p.ctx;
  const a = p.add;
  const r = a.remote;

  r.probing = true;
  r.status = null;
  r.error = '';
  r.redirectUrl = '';
  r.probeToken = '';
  paintAdd(p);

  let probe;
  try {
    const probeBody = { url: r.url };
    if (r.transport === 'http' || r.transport === 'sse') {
      probeBody.transport = r.transport;
    }
    probe = await api('/api/mcps/probe', {
      method: 'POST',
      body: JSON.stringify(probeBody),
    });
  } catch (err) {
    if (!alive(p)) return;
    r.probing = false;
    r.status = 'error';
    r.error = err.message || 'Could not probe this server.';
    paintAdd(p, '#cp-add-url');
    return;
  }
  if (!alive(p)) return;

  if (probe?.status === 'redirect') {
    r.probing = false;
    r.status = 'redirect';
    r.redirectUrl = probe.redirectUrl || '';
    paintAdd(p, '[data-cp-use-redirect]');
    return;
  }

  if (probe?.status === 'api_key') {
    const existingMatch = !String(r.accountLabel || '').trim()
      ? findExistingRemoteMatch(a.existingMcps, probe.url || r.url)
      : null;
    if (existingMatch) {
      r.probing = false;
      r.status = 'exists';
      r.existingMatch = existingMatch;
      r.existingUrl = probe.url || r.url;
      r.existingTransport = probe.transport || (r.transport === 'sse' ? 'sse' : 'http');
      r.existingLabel = '';
      paintAdd(p, '#cp-exists-label');
      return;
    }
    r.probing = false;
    r.status = 'api_key';
    r.url = probe.url || r.url;
    r.suggestedName = probe.suggestedName || '';
    r.probeTransport = probe.transport || '';
    paintAdd(p, '#cp-probe-token');
    return;
  }

  if (probe?.status === 'error' || !probe?.status) {
    r.probing = false;
    r.status = 'error';
    r.error = probe?.error || 'Could not reach this server.';
    paintAdd(p, '#cp-add-url');
    return;
  }

  const targetUrl = probe.url || r.url;
  const finalName = r.name || probe.suggestedName || suggestNameFromUrl(targetUrl);
  const accountLabel = String(r.accountLabel || '').trim();
  const chosenTransport = probe.transport || (r.transport === 'sse' ? 'sse' : 'http');
  const profiles = selectedProfilesPayload(a.selectedProfiles);

  if (!accountLabel) {
    const existingMatch = findExistingRemoteMatch(a.existingMcps, targetUrl);
    if (existingMatch) {
      r.probing = false;
      r.status = 'exists';
      r.existingMatch = existingMatch;
      r.existingUrl = targetUrl;
      r.existingTransport = chosenTransport;
      r.existingLabel = '';
      paintAdd(p, '#cp-exists-label');
      return;
    }
  }

  if (probe.status === 'ready') {
    try {
      const res = await api('/api/mcps', {
        method: 'POST',
        body: JSON.stringify({
          name: finalName,
          ...(accountLabel ? { accountLabel } : {}),
          url: targetUrl,
          transport: chosenTransport,
          profiles,
          description: r.description,
        }),
      });
      if (!alive(p)) return;
      p.changed = true;
      toast(`${res?.mcp?.name || finalName} connected.`, 'ok');
      if (res?.mcp?.id) {
        transitionToConnection(p, res.mcp.id);
      } else {
        closeConnectionPopup();
      }
    } catch (err) {
      if (!alive(p)) return;
      r.probing = false;
      r.status = 'error';
      r.error = err.message || 'Could not save this connection.';
      paintAdd(p);
    }
    return;
  }

  if (probe.status === 'oauth') {
    let created;
    try {
      const res = await api('/api/mcps', {
        method: 'POST',
        body: JSON.stringify({
          name: finalName,
          ...(accountLabel ? { accountLabel } : {}),
          url: targetUrl,
          transport: chosenTransport,
          profiles,
          description: r.description,
          skipSync: true,
        }),
      });
      created = res?.mcp;
      if (!created?.id) throw new Error('Connection created without an id.');
    } catch (err) {
      if (!alive(p)) return;
      r.probing = false;
      r.status = 'error';
      r.error = err.message || 'Could not add this connection.';
      paintAdd(p);
      return;
    }
    if (!alive(p)) return;
    p.changed = true;

    try {
      const startRes = await api(`/api/mcps/${encodeURIComponent(created.id)}/oauth/start`, { method: 'POST' });
      if (!alive(p)) return;
      const target = safeAuthorizeUrl(startRes.authorizeUrl);
      location.href = target.href;
      return;
    } catch (err) {
      if (!alive(p)) return;
      // Sync once so the saved connection records Needs sign-in (instead of Not synced yet) and surfaces credentials/sign-in inputs.
      await api(`/api/mcps/${encodeURIComponent(created.id)}/sync`, { method: 'POST' }).catch(() => {});
      if (!alive(p)) return;
      toast(`Saved ${created.name || finalName}. Enter its credentials or login below.`, 'err');
      transitionToConnection(p, created.id, {
        focusCredentials: true,
        authModeHint: err?.data?.authModeHint || null,
      });
    }
  }
}

function bindAdd(p) {
  const { api, toast, parseArgsInput, parseEnvLines, parseHeaderLines } = p.ctx;
  const a = p.add;
  const el = p.el;

  // Top mode tabs: Add connection / Import JSON / Import from Mac
  el.querySelectorAll('[data-cp-add-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.cpAddTab;
      if (next === a.tab) return;
      a.tab = next;
      a.imported = null;
      paintAdd(p, next === 'import' ? '#cp-import-json' : next === 'agents' ? null : (a.transportMode === 'stdio' ? '#cp-stdio-name' : '#cp-add-url'));
    });
  });

  if (a.allowLocal && a.tab === 'agents' && typeof p.ctx.renderImportFromAgents === 'function') {
    const slot = el.querySelector('#cp-agents-import-slot');
    if (slot) {
      p.ctx.renderImportFromAgents(slot, (res) => {
        if (!alive(p)) return;
        const updatedList = Array.isArray(res.updated) ? res.updated : [];
        if (res.added.length || updatedList.length) p.changed = true;
        a.imported = {
          addedCount: res.added.length,
          addedNames: res.added.map((item) => item.name || item.id),
          updatedCount: updatedList.length,
          updatedNames: updatedList.map((item) => item.name || item.id),
          secretsMoved: res.secretsMoved,
          skipped: res.skipped,
        };
        paintAdd(p, '.cp-add-foot [data-cp-close]');
      });
    }
  }

  // Switch between Remote URL and Local stdio (when allowed)
  el.querySelectorAll('[data-cp-transport-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!a.allowLocal) {
        a.transportMode = 'remote';
        return;
      }
      const nextMode = btn.dataset.cpTransportMode === 'stdio' ? 'stdio' : 'remote';
      if (nextMode === 'stdio' && !a.stdio.name && a.remote.name) a.stdio.name = a.remote.name;
      if (nextMode === 'remote' && !a.remote.name && a.stdio.name) a.remote.name = a.stdio.name;
      a.transportMode = nextMode;
      paintAdd(p, nextMode === 'stdio' ? '#cp-stdio-name' : '#cp-add-url');
    });
  });

  // Profile pills on Add tab
  el.querySelectorAll('[data-cp-add-profile]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.cpAddProfile;
      if (!id) return;
      if (a.selectedProfiles.has(id)) a.selectedProfiles.delete(id);
      else a.selectedProfiles.add(id);
      paintAdd(p, `[data-cp-add-profile="${CSS.escape(id)}"]`);
    });
  });

  // Keep <details> open state across repaints
  el.querySelector('[data-cp-advanced]')?.addEventListener('toggle', (e) => {
    a.remote.advancedOpen = Boolean(e.currentTarget.open);
  });

  // Use redirected URL from probe
  el.querySelector('[data-cp-use-redirect]')?.addEventListener('click', () => {
    if (!a.remote.redirectUrl) return;
    a.remote.url = a.remote.redirectUrl;
    runAddRemoteProbe(p);
  });

  // Existing-service choices (avoid creating accidental copies)
  el.querySelector('[data-cp-exists-open]')?.addEventListener('click', async () => {
    const m = a.remote.existingMatch;
    if (!m?.id || a.remote.submitting) return;
    if (m.enabled === false) {
      a.remote.submitting = true;
      paintAdd(p);
      try {
        await api(`/api/mcps/${encodeURIComponent(m.id)}/toggle`, { method: 'POST', body: JSON.stringify({ enabled: true }) });
        p.changed = true;
      } catch (err) {
        a.remote.submitting = false;
        toast(err?.message || 'Could not turn on this connection.', 'err');
        paintAdd(p);
        return;
      }
      if (!alive(p)) return;
      a.remote.submitting = false;
    }
    await transitionToConnection(p, m.id, { autoSignIn: m.readiness?.action === 'sign_in' });
  });

  el.querySelector('[data-cp-exists-share]')?.addEventListener('click', async () => {
    const m = a.remote.existingMatch;
    if (!m?.id || a.remote.submitting) return;
    const nextProfiles = [...new Set([...(Array.isArray(m.profiles) ? m.profiles : ['all']), ...selectedProfilesPayload(a.selectedProfiles)])];
    a.remote.submitting = true;
    paintAdd(p);
    try {
      await api(`/api/mcps/${encodeURIComponent(m.id)}`, { method: 'PATCH', body: JSON.stringify({ profiles: nextProfiles }) });
      if (!alive(p)) return;
      p.changed = true;
      a.remote.submitting = false;
      toast(`Added ${m.name} to this project.`, 'ok');
      await transitionToConnection(p, m.id);
    } catch (err) {
      if (!alive(p)) return;
      a.remote.submitting = false;
      toast(err?.message || 'Could not update projects.', 'err');
      paintAdd(p);
    }
  });

  el.querySelector('[data-cp-exists-update]')?.addEventListener('click', async () => {
    const m = a.remote.existingMatch;
    if (!m?.id || !a.remote.existingUrl || a.remote.submitting) return;
    a.remote.submitting = true;
    paintAdd(p);
    try {
      await api(`/api/mcps/${encodeURIComponent(m.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          url: a.remote.existingUrl,
          ...(a.remote.existingTransport ? { transport: a.remote.existingTransport } : {}),
          applyToService: true,
        }),
      });
      if (!alive(p)) return;
      p.changed = true;
      a.remote.submitting = false;
      toast(`Updated ${m.name}.`, 'ok');
      await transitionToConnection(p, m.id);
    } catch (err) {
      if (!alive(p)) return;
      a.remote.submitting = false;
      toast(err?.message || 'Could not update this connection.', 'err');
      paintAdd(p);
    }
  });

  const submitExistingAddAccount = async () => {
    const m = a.remote.existingMatch;
    const label = String(a.remote.existingLabel || '').trim();
    if (!m?.id || a.remote.submitting) return;
    if (!label) {
      toast('Enter an account label, for example Work or Project X.', 'err');
      p.el.querySelector('#cp-exists-label')?.focus();
      return;
    }
    a.remote.submitting = true;
    paintAdd(p);
    try {
      const res = await api(`/api/mcps/${encodeURIComponent(m.id)}/accounts`, {
        method: 'POST',
        body: JSON.stringify({
          accountLabel: label,
          ...(a.remote.existingUrl ? { url: a.remote.existingUrl } : {}),
        }),
      });
      if (!alive(p)) return;
      const newId = res?.mcp?.id;
      if (!newId) throw new Error('Loop did not add the account.');
      try { sessionStorage.setItem(PICK_AGENTS_KEY, newId); } catch { /* storage off */ }
      p.changed = true;
      a.remote.submitting = false;
      await transitionToConnection(p, newId, { autoSignIn: true, focusCredentials: res.mcp.readiness?.action !== 'sign_in' });
    } catch (err) {
      if (!alive(p)) return;
      a.remote.submitting = false;
      toast(err?.message || 'Could not add this account.', 'err');
      paintAdd(p, '#cp-exists-label');
    }
  };
  el.querySelector('[data-cp-exists-add]')?.addEventListener('click', submitExistingAddAccount);

  // Sync remote or stdio field drafts on input
  const addForm = el.querySelector('#cp-add-form');
  if (addForm && a.tab === 'add') {
    const isStdio = a.allowLocal && a.transportMode === 'stdio';
    if (isStdio) {
      addForm.addEventListener('input', (e) => {
        const target = e.target;
        if (target?.name && Object.hasOwn(a.stdio, target.name)) {
          a.stdio[target.name] = target.value;
        }
      });
    } else {
      addForm.addEventListener('input', (e) => {
        const target = e.target;
        if (!target?.name) return;
        if (Object.hasOwn(a.remote, target.name)) {
          a.remote[target.name] = target.value;
        }
        if (target.name === 'url' && a.remote.status) {
          const pos = target.selectionStart;
          a.remote.status = null;
          a.remote.error = '';
          a.remote.redirectUrl = '';
          a.remote.probeToken = '';
          a.remote.existingMatch = null;
          a.remote.existingLabel = '';
          a.remote.existingUrl = '';
          a.remote.existingTransport = '';
          paintAdd(p);
          const nextInput = p.el.querySelector('#cp-add-url');
          if (nextInput) {
            nextInput.focus();
            if (typeof pos === 'number') nextInput.setSelectionRange(pos, pos);
          }
        }
      });
      addForm.addEventListener('change', (e) => {
        const target = e.target;
        if (target?.name === 'transport') a.remote.transport = target.value;
      });
    }

    // Ensure pressing Enter in any single-line input submits even when the submit button is linked via form="...".
    addForm.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target?.tagName === 'INPUT') {
        e.preventDefault();
        if (e.target.id === 'cp-exists-label') {
          submitExistingAddAccount();
          return;
        }
        if (typeof addForm.requestSubmit === 'function') addForm.requestSubmit();
        else addForm.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });

    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const profiles = selectedProfilesPayload(a.selectedProfiles);

      if (isStdio) {
        if (a.stdio.submitting) return;
        let payload;
        try {
          const args = typeof parseArgsInput === 'function' ? parseArgsInput(a.stdio.args) : [];
          const env = typeof parseEnvLines === 'function' ? parseEnvLines(a.stdio.env) : {};
          const cwd = String(a.stdio.cwd || '').trim();
          const accountLabel = String(a.stdio.accountLabel || '').trim();
          payload = {
            name: String(a.stdio.name || '').trim(),
            ...(accountLabel ? { accountLabel } : {}),
            description: String(a.stdio.description || '').trim(),
            transport: 'stdio',
            command: String(a.stdio.command || '').trim(),
            args,
            env,
            ...(cwd ? { cwd } : {}),
            profiles,
          };
        } catch (err) {
          toast(err.message || 'Invalid local command settings.', 'err');
          return;
        }
        if (!payload.name || !payload.command) {
          toast('Name and command are required.', 'err');
          return;
        }

        a.stdio.submitting = true;
        paintAdd(p);
        try {
          const res = await api('/api/mcps', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
          if (!alive(p)) return;
          p.changed = true;
          toast(`${res?.mcp?.name || payload.name} added.`, 'ok');
          if (res?.mcp?.id) transitionToConnection(p, res.mcp.id);
          else closeConnectionPopup();
        } catch (err) {
          if (!alive(p)) return;
          a.stdio.submitting = false;
          toast(err.message || 'Could not add connection.', 'err');
          paintAdd(p);
        }
        return;
      }

      // Remote submit
      const r = a.remote;
      if (r.probing || r.submitting) return;
      r.url = String(r.url || '').trim();
      r.name = String(r.name || '').trim();
      r.accountLabel = String(r.accountLabel || '').trim();
      r.description = String(r.description || '').trim();
      r.token = String(r.token || '').trim();
      r.probeToken = String(r.probeToken || '').trim();
      if (!r.url) {
        toast('Enter a server URL.', 'err');
        p.el.querySelector('#cp-add-url')?.focus();
        return;
      }

      let parsedHeaders = {};
      try {
        parsedHeaders = typeof parseHeaderLines === 'function' ? parseHeaderLines(r.headers) : {};
      } catch (err) {
        toast(err.message || 'Invalid header format.', 'err');
        return;
      }

      const manualToken = r.probeToken || r.token;
      const hasManualHeaders = Object.keys(parsedHeaders).length > 0;

      // Direct save when the user explicitly supplied credentials or extra headers.
      if (manualToken || hasManualHeaders) {
        const finalName = r.name || r.suggestedName || suggestNameFromUrl(r.url);
        const chosenTransport = (r.transport === 'http' || r.transport === 'sse')
          ? r.transport
          : (r.probeTransport || 'http');
        r.submitting = true;
        paintAdd(p);
        try {
          const res = await api('/api/mcps', {
            method: 'POST',
            body: JSON.stringify({
              name: finalName,
              ...(r.accountLabel ? { accountLabel: r.accountLabel } : {}),
              description: r.description,
              transport: chosenTransport,
              url: r.url,
              token: manualToken,
              headers: parsedHeaders,
              profiles,
            }),
          });
          if (!alive(p)) return;
          p.changed = true;
          const notice = connectionSaveToast(res?.mcp, finalName);
          toast(notice.message, notice.tone);
          if (res?.mcp?.id) transitionToConnection(p, res.mcp.id);
          else closeConnectionPopup();
        } catch (err) {
          if (!alive(p)) return;
          r.submitting = false;
          toast(err.message || 'Could not save connection.', 'err');
          paintAdd(p);
        }
        return;
      }

      // Clean URL-first Connect: probe first with zero credentials sent.
      await runAddRemoteProbe(p);
    });
  }

  // Import JSON form
  const importForm = el.querySelector('#cp-import-form');
  if (importForm && a.tab === 'import') {
    importForm.querySelector('textarea[name="json"]')?.addEventListener('input', (e) => {
      a.imp.json = e.currentTarget.value;
    });
    importForm.querySelector('select[name="profile"]')?.addEventListener('change', (e) => {
      a.imp.profile = e.currentTarget.value || 'all';
      paintAdd(p, '#cp-import-form select[name="profile"]');
    });
    importForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (a.imp.submitting) return;
      const rawJson = String(a.imp.json || '').trim();
      const profile = String(a.imp.profile || 'all').trim().toLowerCase() || 'all';
      a.imp.submitting = true;
      paintAdd(p);
      try {
        const res = await api('/api/mcps/import', {
          method: 'POST',
          body: JSON.stringify({ json: rawJson, profile }),
        });
        if (!alive(p)) return;
        const addedList = Array.isArray(res.added) ? res.added : [];
        const addedCount = Array.isArray(res.added) ? res.added.length : Number(res.added || 0);
        const updatedList = Array.isArray(res.updated) ? res.updated : [];
        const updatedCount = Array.isArray(res.updated) ? res.updated.length : Number(res.updated || 0);
        const skippedList = Array.isArray(res.skipped) ? res.skipped : [];
        const skippedCount = Array.isArray(res.skipped) ? res.skipped.length : Number(res.skipped || 0);
        const secretsMoved = Number(res.secretsMoved || 0);
        const droppedEntries = [];
        for (const item of [...addedList, ...updatedList]) {
          if (Array.isArray(item?.droppedSettings) && item.droppedSettings.length > 0) {
            droppedEntries.push({
              name: item.name || item.id || 'Connection',
              settings: item.droppedSettings,
            });
          }
        }
        if (Array.isArray(res.droppedSettings) && res.droppedSettings.length > 0) {
          for (const entry of res.droppedSettings) {
            if (typeof entry === 'string') {
              droppedEntries.push({ name: '', settings: [entry] });
            } else if (entry && typeof entry === 'object') {
              droppedEntries.push({
                name: entry.name || entry.server || entry.id || '',
                settings: Array.isArray(entry.settings)
                  ? entry.settings
                  : (Array.isArray(entry.dropped) ? entry.dropped : [entry.setting || entry.reason || JSON.stringify(entry)]),
              });
            }
          }
        }

        if (addedCount > 0 || updatedCount > 0) p.changed = true;
        a.imp.submitting = false;
        a.imp.summary = {
          addedCount,
          addedNames: addedList.map((item) => item?.name || item?.id).filter(Boolean),
          updatedCount,
          updatedNames: updatedList.map((item) => item?.name || item?.id).filter(Boolean),
          secretsMoved,
          skipped: skippedList,
          dropped: droppedEntries,
        };
        if (addedCount > 0 || updatedCount > 0) a.imp.json = '';
        const toastParts = [];
        if (addedCount > 0 || updatedCount === 0) toastParts.push(`Imported ${addedCount} connection${addedCount === 1 ? '' : 's'}`);
        if (updatedCount > 0) toastParts.push(`Updated ${updatedCount} connection${updatedCount === 1 ? '' : 's'}`);
        toast(
          `${toastParts.join(', ')}${secretsMoved ? `, ${secretsMoved} key${secretsMoved === 1 ? '' : 's'} moved to Vault` : ''}${skippedCount ? ` (${skippedCount} skipped)` : ''}.`,
          (addedCount > 0 || updatedCount > 0) ? 'ok' : '',
        );
        paintAdd(p);
      } catch (err) {
        if (!alive(p)) return;
        a.imp.submitting = false;
        toast(err.message || 'Could not import configuration.', 'err');
        paintAdd(p);
      }
    });
  }
}
