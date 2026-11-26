// The access picker: Connections and Skills with per-item and per-category toggles, plus Memory and
// Vault. The connect page shows it in an expanding drawer; Add agent (add-agent.js) shows it in its
// own panel (`panel: true`): the same choices, one line per item.

import { modeLabel } from './approval-modes.js';
import { isSystemSkill } from './system-skills.js';

const SKILL_ICON =
  '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M10 2.8l1.7 5.5 5.5 1.7-5.5 1.7L10 17.2l-1.7-5.5L2.8 10l5.5-1.7z"/></svg>';
const LOCK_ICON =
  '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="9" width="11" height="8" rx="2"/><path d="M7 9V7a3 3 0 0 1 6 0v2"/></svg>';
const LAYERS_ICON =
  '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 7L10 3.5 16.5 7 10 10.5z"/><path d="M3.5 10.5L10 14l6.5-3.5"/><path d="M3.5 14L10 17.5l6.5-3.5"/></svg>';
const PLUG_ICON =
  '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3.5v4M13 3.5v4M5 7.5h10v2.5a5 5 0 0 1-10 0z"/><path d="M10 15v2.5"/></svg>';
const CHEV_ICON =
  '<svg class="hm-chev" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 8l5 5 5-5"/></svg>';

const PANEL_CHEV =
  '<svg class="oc-chev" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 5l5 5-5 5"/></svg>';

const VAULT_TYPE_LABELS = {
  api_key: 'API key',
  login: 'Login',
  payment: 'Payment',
  note: 'Note',
};

const MEMORY_MODES = [
  ['none', 'Off'],
  ['read', 'Read'],
  ['read_write', 'Read & save'],
];

function itemMatchesProfile(item, profile) {
  if (!profile || profile === 'all') return true;
  const profiles = Array.isArray(item?.profiles) ? item.profiles : [];
  return profiles.includes(profile);
}

function firstSentence(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const cut = t.search(/[.!?](\s|$)/);
  const s = cut > 0 ? t.slice(0, cut + 1) : t;
  if (s.length <= 120) return s;
  const space = s.lastIndexOf(' ', 119);
  return `${s.slice(0, space > 60 ? space : 119).replace(/[\s,;:(–—-]+$/, '')}…`;
}

function connSubtitle(m, esc) {
  const tools = Array.isArray(m.tools) ? m.tools : [];
  const disabled = new Set(Array.isArray(m.disabledTools) ? m.disabledTools : []);
  const total = typeof m.toolCount === 'number' ? m.toolCount : tools.length;
  const enabled = typeof m.enabledToolCount === 'number'
    ? m.enabledToolCount
    : tools.filter((t) => t && !disabled.has(t.name)).length;
  if (!m.enabled) return '<span class="ctl-st">Off in Loop</span>';
  if (m.tokenRejected) return '<span class="ctl-st warn">Token rejected</span>';
  if (m.authRequired) return '<span class="ctl-st warn">Needs sign-in</span>';
  if (total === 0) return '<span class="ctl-st">Not synced yet</span>';
  return `<span class="ctl-st">${esc(enabled)} ${enabled === 1 ? 'tool' : 'tools'}</span>`;
}

// The state of a Connection, as one short value at the end of its line.
function connValue(m) {
  if (!m.enabled) return { text: 'Off in Loop' };
  if (m.tokenRejected || m.authRequired) return { text: 'Needs sign-in', warn: true };
  const tools = Array.isArray(m.tools) ? m.tools : [];
  const off = new Set(Array.isArray(m.disabledTools) ? m.disabledTools : []);
  const n = typeof m.enabledToolCount === 'number' ? m.enabledToolCount : tools.filter((t) => t && !off.has(t.name)).length;
  return { text: n > 0 ? `${n} ${n === 1 ? 'tool' : 'tools'}` : '' };
}

// A group's switch: on, off, or some of it.
function groupSwitchHtml({ on, some, label, attrs }) {
  const state = on ? 'on' : some ? 'is-some' : '';
  return `<button type="button" class="sw ${state}" role="checkbox" aria-checked="${on ? 'true' : some ? 'mixed' : 'false'}" aria-label="${label}" ${attrs}><span class="sw-knob" aria-hidden="true"></span></button>`;
}

function switchHtml({ on, label, attrs }) {
  return `<button type="button" class="sw ${on ? 'on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${label}" ${attrs}><span class="sw-knob" aria-hidden="true"></span></button>`;
}

function defaultEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

/**
 * Renders the delayed handoff fallback card shown when an agent has not yet
 * completed POST /oauth/token after browser redirect. Uses a <button> (not an
 * <a href>) for retrying the redirect so browser hover-preconnect cannot open
 * an idle TCP socket against single-connection loopback listeners like Muse Code.
 */
export function renderOAuthHandoffFallback({ name = 'MCP Client', redirectUrl = '', esc = defaultEsc } = {}) {
  if (!redirectUrl) return '';
  let authCode = '';
  try {
    const base = typeof location !== 'undefined' && location?.origin ? location.origin : 'http://127.0.0.1';
    authCode = new URL(redirectUrl, base).searchParams.get('code') || '';
  } catch { /* ignore */ }

  const isMuse = /\bmuse\b/i.test(String(name || ''));
  const label = isMuse ? 'Finish in Muse Code' : `Finish in ${esc(name)}`;
  const hint = isMuse
    ? 'If your terminal shows <code>Press Enter to open it in your browser</code>, press <strong>Enter</strong> so Muse starts accepting the callback, then click <strong>Retry redirect</strong>. If you ran <code>--headless</code>, paste this full callback URL into Muse:'
    : `If <strong>${esc(name)}</strong> did not catch the redirect automatically, click <strong>Retry redirect</strong> or paste this full callback URL into your agent:`;

  return `
    <section class="card oc-code-card" id="oauth-handoff-fallback" hidden>
      <span class="lbl">${label}</span>
      <p class="oc-code-hint">${hint}</p>
      <code class="oc-code-box" id="oauth-auth-code">${esc(redirectUrl)}</code>
      <div class="acts center">
        <button type="button" class="btn fill" id="oauth-copy-callback">Copy callback URL</button>
        <button type="button" class="btn" id="oauth-open-callback">Retry redirect</button>
        ${authCode ? '<button type="button" class="btn" id="oauth-copy-code">Copy code</button>' : ''}
      </div>
    </section>
  `;
}

/**
 * Derives consistent button and summary copy from the effective grant summary.
 * Never describes a grant as "Memory only" when connection management or future-item access is on.
 */
export function describeShareGrant(sum) {
  if (!sum) return { buttonLabel: 'Share', summaryText: '' };
  const items = Number(sum.items) || 0;
  const hasMemory = Boolean(sum.memoryAccess && sum.memoryAccess !== 'none');
  const canManage = Boolean(sum.canManage);
  const includeFuture = Boolean(sum.includeFuture || sum.futureConnections || sum.futureSkills);

  if (items === 0 && !canManage && !includeFuture) {
    if (hasMemory) {
      return { buttonLabel: 'Share Memory only', summaryText: 'Memory only' };
    }
    return { buttonLabel: 'Share nothing', summaryText: 'Nothing shared' };
  }

  const parts = [];
  if (items > 0) parts.push(`${items} ${items === 1 ? 'item' : 'items'}`);
  if (includeFuture) parts.push('future items');
  if (hasMemory) parts.push('Memory');
  if (canManage) parts.push('manage connections');
  const joined = parts.length <= 2
    ? parts.join(' and ')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return {
    buttonLabel: `Share ${joined}`,
    summaryText: joined.charAt(0).toUpperCase() + joined.slice(1),
  };
}

/**
 * Mounts the expandable Home-style access picker inside the OAuth consent screen.
 * Returns a controller with `getApprovalPayload()` used when the user clicks Allow.
 */
export function mountOAuthConsentPicker(view, ctx) {
  const {
    esc,
    api,
    renderConnLogo,
    groupConnectionsByCategory,
    oauthProfiles = [],
    defaultProfile = 'all',
    clientName = 'Agent',
    currentAgent = null,
    offerOneConnection = false,
    panel = false,
    vaultMode = null,
    onChange = null,
  } = ctx;

  const expandBtn = view.querySelector('#oauth-expand');
  const expandLabel = view.querySelector('#oc-expand-label');
  const drawer = view.querySelector('#oc-drawer');
  const pickerHost = view.querySelector('#oc-picker');
  if (!pickerHost || (!drawer && !panel)) {
    if (offerOneConnection) throw new Error('Reload Loop to review access before connecting.');
    return { getApprovalPayload: () => ({ profile: defaultProfile }) };
  }

  // An app that signs in again keeps its agent, so the screen starts from what that agent may do.
  const isLoopText = /^loop[- ]?text\b/i.test(String(clientName || ''));
  const defaultMemoryAccess = currentAgent?.memoryAccess || 'read_write';
  const canPickOne = offerOneConnection && !currentAgent && !panel;
  // A client-supplied name can narrow the initial screen, never grant access.
  const personalHost = /^(?:muse(?: agent)?|meta muse|grok[ -]?bot|claude duet|openmausbot|openbot)$/i.test(String(clientName).trim());
  let pickOne = canPickOne && personalHost;
  let chosenConnection = '';
  let wholeConnection = false;
  const chosenTools = new Set();
  const existingToolGrants = offerOneConnection && currentAgent?.toolGrants;
  const existingGrantId = existingToolGrants && Object.keys(existingToolGrants).length === 1 ? Object.keys(existingToolGrants)[0] : '';
  const unchangedActions = () => chosenTools.size === existingToolGrants[existingGrantId].length &&
    existingToolGrants[existingGrantId].every((name) => chosenTools.has(name));

  const state = {
    expanded: !expandBtn,
    loading: true,
    loadError: '',
    mode: 'select', // 'all' (Include future) | 'select' (Explicit allowlist)
    profile: defaultProfile || 'all',
    search: '',
    activeJump: '',
    openGroups: new Set(),
    initializedOpen: false,
    // Loaded workspace catalog
    mcps: [],
    categories: [],
    allSkills: [],
    secrets: [],
    // Selection state (tracked as Sets of IDs)
    selectedConns: new Set(),
    selectedSkills: new Set(),
    selectedSecrets: new Set(),
    itemsTouched: false,
    includeFuture: false,
    futureTouched: false,
    legacyFutureConns: false,
    legacyFutureSkills: false,
    memoryAccess: defaultMemoryAccess,
    memoryTouched: false,
    canManage: currentAgent ? currentAgent.canManage === true : isLoopText,
    manageTouched: false,
    secretsTouched: false,
  };

  const scopedMcps = () => state.mcps.filter((m) => itemMatchesProfile(m, state.profile));
  const scopedSkills = () => state.allSkills.filter((sk) => itemMatchesProfile(sk, state.profile));
  // Loop's own guides come with every agent, so the panel neither lists them nor counts them.
  const listedSkills = () => (panel ? scopedSkills().filter((sk) => !isSystemSkill(sk)) : scopedSkills());
  const scopedSecrets = () => state.secrets.filter((s) => itemMatchesProfile(s, state.profile));

  // Vault secrets are opt-in: never select them automatically for a new or re-authorized agent.
  function resetSelectionsToAll() {
    state.selectedConns = new Set(scopedMcps().map((m) => m.id));
    state.selectedSkills = new Set(listedSkills().map((sk) => sk.id));
  }

  function applyInitialSelections() {
    const validConns = new Set(scopedMcps().map((m) => m.id));
    const validSkills = new Set(scopedSkills().map((sk) => sk.id));
    const validSecrets = new Set(scopedSecrets().map((s) => s.key));
    if (currentAgent) {
      const hasConnList = Array.isArray(currentAgent.allowedConnections);
      const hasSkillList = Array.isArray(currentAgent.allowedSkills);
      state.legacyFutureConns = !hasConnList;
      state.legacyFutureSkills = !hasSkillList;
      state.includeFuture = !hasConnList && !hasSkillList;
      state.mode = state.includeFuture ? 'all' : 'select';
      state.canManage = currentAgent.canManage === true;
      state.selectedConns = hasConnList
        ? new Set(currentAgent.allowedConnections.filter((id) => validConns.has(id)))
        : new Set(validConns);
      state.selectedSkills = hasSkillList
        ? new Set(currentAgent.allowedSkills.filter((id) => validSkills.has(id)))
        : new Set(validSkills);
      state.selectedSecrets = new Set(
        (Array.isArray(currentAgent.secrets) ? currentAgent.secrets : []).filter((k) => validSecrets.has(k)),
      );
      return;
    }
    state.legacyFutureConns = false;
    state.legacyFutureSkills = false;
    state.includeFuture = false;
    state.mode = 'select';
    state.canManage = isLoopText;
    resetSelectionsToAll();
    state.selectedSecrets = new Set();
  }

  function ensureSelectionsForProfile() {
    const validSecrets = new Set(scopedSecrets().map((s) => s.key));
    state.selectedSecrets = new Set([...state.selectedSecrets].filter((k) => validSecrets.has(k)));
    if (state.includeFuture) {
      resetSelectionsToAll();
      return;
    }
    const validConns = new Set(scopedMcps().map((m) => m.id));
    const validSkills = new Set(scopedSkills().map((sk) => sk.id));
    state.selectedConns = new Set([...state.selectedConns].filter((id) => validConns.has(id)));
    state.selectedSkills = new Set([...state.selectedSkills].filter((id) => validSkills.has(id)));
  }

  function futureEnabledNow() {
    if (state.includeFuture) return true;
    return !state.itemsTouched && !state.futureTouched && (state.legacyFutureConns || state.legacyFutureSkills);
  }

  // The items the owner picked. Explicit empty arrays ([]) stay empty tomorrow unless future items are opted in.
  function pickedItems() {
    if (state.loading || state.loadError) return { connections: [], skills: [] };
    if (state.includeFuture) return { connections: null, skills: null };
    return {
      connections: state.legacyFutureConns && !state.itemsTouched && !state.futureTouched ? null : [...state.selectedConns],
      skills: state.legacyFutureSkills && !state.itemsTouched && !state.futureTouched ? null : [...state.selectedSkills],
    };
  }

  // Connection management is an explicit opt-in for new agents (except Loop Text).
  function canManageNow() {
    if (typeof state.canManage === 'boolean') return state.canManage;
    if (currentAgent) return currentAgent.canManage === true;
    return isLoopText;
  }

  function buildSections() {
    const mcps = scopedMcps();
    const skills = listedSkills();
    const secrets = scopedSecrets();
    const q = state.search.trim().toLowerCase();

    const hitConn = (m) => !q || `${m.name || ''} ${m.id || ''} ${m.description || ''}`.toLowerCase().includes(q);
    const hitSkill = (sk) => !q || `${sk.name || sk.id || ''} ${sk.description || ''}`.toLowerCase().includes(q);
    const hitSecret = (s) => !q || `${s.key || ''} ${s.description || ''} ${s.type || ''}`.toLowerCase().includes(q);

    const catList = state.categories;
    const catOrder = new Map(catList.map((c, i) => [c.id, i]));
    const skillsByCat = new Map();
    for (const c of catList) {
      const list = (Array.isArray(c.skills) ? c.skills : []).filter((sk) => itemMatchesProfile(sk, state.profile));
      if (list.length) skillsByCat.set(c.id, list);
    }

    const grouped = groupConnectionsByCategory(mcps, catList).map((g) => ({
      id: g.id,
      label: g.label || g.id,
      mcps: g.mcps || [],
      skills: panel ? [] : skillsByCat.get(g.id) || [],
    }));
    for (const c of panel ? [] : catList) {
      if (!grouped.some((g) => g.id === c.id) && (skillsByCat.get(c.id) || []).length) {
        grouped.push({
          id: c.id,
          label: c.label || c.id,
          mcps: [],
          skills: skillsByCat.get(c.id),
        });
      }
    }
    grouped.sort((a, b) => (catOrder.get(a.id) ?? 1e9) - (catOrder.get(b.id) ?? 1e9));
    // In the panel, Skills are one group of their own.
    if (panel) grouped.push({ id: '__skills', label: 'Skills', mcps: [], skills });

    const sections = [];
    for (const g of grouped) {
      const fMcps = g.mcps.filter(hitConn);
      const fSkills = g.skills.filter(hitSkill);
      if (q && fMcps.length === 0 && fSkills.length === 0) continue;
      if (!q && g.mcps.length === 0 && g.skills.length === 0) continue;
      const total = g.mcps.length + g.skills.length;
      const selectedCount =
        g.mcps.filter((m) => state.selectedConns.has(m.id)).length +
        g.skills.filter((sk) => state.selectedSkills.has(sk.id)).length;
      sections.push({
        kind: 'category',
        id: `cat:${g.id}`,
        catId: g.id,
        label: g.label,
        allMcps: g.mcps,
        allSkills: g.skills,
        mcps: fMcps,
        skills: fSkills,
        total,
        selectedCount,
      });
    }

    const memMatches = !q || 'memory shared memory facts preferences recall'.includes(q);
    if (memMatches) {
      sections.push({
        kind: 'memory',
        id: 'sec:memory',
        label: 'Memory',
      });
    }

    if (!q || 'manage connections add change remove'.includes(q)) {
      sections.push({ kind: 'manage', id: 'sec:manage', label: 'Manage connections' });
    }

    if (!q || 'future items connections skills later auto share'.includes(q)) {
      sections.push({ kind: 'future', id: 'sec:future', label: 'Future items' });
    }

    const fSecrets = secrets.filter(hitSecret);
    if (!q || fSecrets.length > 0 || 'vault secrets passwords keys'.includes(q)) {
      sections.push({
        kind: 'vault',
        id: 'sec:vault',
        label: 'Vault',
        allSecrets: secrets,
        secrets: fSecrets,
        total: secrets.length,
        selectedCount: secrets.filter((s) => state.selectedSecrets.has(s.key)).length,
      });
    }

    if (!state.initializedOpen && sections.length > 0) {
      state.initializedOpen = true;
      const firstCats = sections.filter((s) => s.kind === 'category').slice(0, panel ? 1 : 2);
      for (const s of firstCats) state.openGroups.add(s.id);
      state.openGroups.add('sec:memory');
      state.openGroups.add('sec:manage');
      if (secrets.length > 0 && secrets.length <= 8) state.openGroups.add('sec:vault');
    }

    return sections;
  }

  function updateSummaryLabel() {
    if (!expandLabel) return;
    if (state.loading) {
      expandLabel.textContent = 'Custom';
      return;
    }
    const conns = scopedMcps();
    const skills = scopedSkills();
    const totalTools = conns.length + skills.length;
    const selectedTools = state.selectedConns.size + state.selectedSkills.size;
    const hasCustom =
      state.itemsTouched ||
      state.futureTouched ||
      state.manageTouched ||
      state.selectedSecrets.size > 0 ||
      state.memoryAccess !== defaultMemoryAccess ||
      state.profile !== 'all';

    if (!hasCustom) {
      expandLabel.textContent = 'Custom';
      return;
    }
    const parts = [];
    if (futureEnabledNow()) {
      parts.push('All + future tools');
    } else if (totalTools === 0) {
      parts.push('No tools');
    } else {
      parts.push(`${selectedTools} of ${totalTools} selected`);
    }
    if (state.memoryAccess === 'none') parts.push('Memory off');
    else if (state.memoryAccess === 'read') parts.push('Memory read only');
    if (canManageNow()) parts.push('Can manage');
    if (state.selectedSecrets.size > 0) {
      parts.push(`${state.selectedSecrets.size} Vault`);
    }
    expandLabel.textContent = parts.join(' · ');
  }

  function switchToSelectModeIfNeeded() {
    state.includeFuture = false;
    state.legacyFutureConns = false;
    state.legacyFutureSkills = false;
    if (state.mode !== 'select') {
      state.mode = 'select';
    }
  }

  // What the panel around the picker needs: the exact effective grant.
  function summary() {
    const picked = pickedItems();
    const vault = state.selectedSecrets.size;
    const connections = !Array.isArray(picked.connections) ? scopedMcps().length : state.selectedConns.size;
    const skills = listedSkills().filter((sk) => !Array.isArray(picked.skills) || state.selectedSkills.has(sk.id)).length;
    const futureConnections = !Array.isArray(picked.connections);
    const futureSkills = !Array.isArray(picked.skills);
    return {
      ready: !state.loading && !state.loadError,
      connections,
      skills,
      vault,
      memoryAccess: state.memoryAccess,
      canManage: canManageNow(),
      includeFuture: futureConnections || futureSkills,
      futureConnections,
      futureSkills,
      items: connections + skills + vault,
      total: scopedMcps().length + listedSkills().length + scopedSecrets().length,
    };
  }

  // Every change draws the list again, so the control in use gets its focus back.
  function focusSelector() {
    const el = document.activeElement;
    if (!el || !pickerHost.contains(el) || el.id === 'oc-search') return '';
    const attr = [...el.attributes].find((a) => a.name.startsWith('data-oc-'));
    if (!attr) return '';
    if (attr.name === 'data-oc-bulk') return '[data-oc-bulk]';
    return `${el.tagName.toLowerCase()}[${attr.name}="${CSS.escape(attr.value)}"]`;
  }

  function renderPanel(sections) {
    const focus = focusSelector();
    const search = document.activeElement?.id === 'oc-search' ? document.activeElement : null;
    const caret = search ? [search.selectionStart, search.selectionEnd] : null;
    const q = state.search.trim();
    const { connections, skills } = summary();
    const total = scopedMcps().length + listedSkills().length;
    const anyOn = connections + skills + state.selectedSecrets.size > 0 || state.memoryAccess !== 'none' || canManageNow() || futureEnabledNow();

    const line = ({ rowAttr, id, icon, name, value, warn, sw, on }) => `
      <li>
        <div class="oc-line ${on ? '' : 'is-off'}" ${rowAttr}="${esc(id)}">
          <span class="oc-line-ic">${icon}</span>
          <span class="oc-line-t">${esc(name)}</span>
          ${value ? `<span class="oc-line-v ${warn ? 'is-warn' : ''}">${esc(value)}</span>` : ''}
          ${sw}
        </div>
      </li>`;
    const head = (s, { count = '', control = '', open }) => `
      <div class="oc-head-row">
        <button type="button" class="oc-head" data-oc-toggle-group="${esc(s.id)}" aria-expanded="${open}">
          ${PANEL_CHEV}<span class="oc-head-l">${esc(s.label)}</span>${count ? `<span class="oc-head-n">${esc(count)}</span>` : ''}
        </button>
        ${control}
      </div>`;
    const countOf = (s) => (s.selectedCount === s.total ? String(s.total) : `${s.selectedCount} of ${s.total}`);

    // Everything on is "all", so it also covers what comes later. The owner must see that.
    const picked = pickedItems();
    const later = [picked.connections ? '' : 'connections', picked.skills ? '' : 'skills'].filter(Boolean).join(' and ');
    const laterNote = later && !q && total > 0 ? `<p class="oc-note is-later">This includes the ${later} that you add later.</p>` : '';

    const html = sections.map((s) => {
      const open = Boolean(q) || state.openGroups.has(s.id);
      let body = '';
      if (s.kind === 'category') {
        if (!s.total) return '';
        const svcCounts = new Map();
        for (const m of s.mcps) {
          const sk = m.lent ? `lent:${m.id}` : (m.serviceKey || m.name || m.id);
          svcCounts.set(sk, (svcCounts.get(sk) || 0) + 1);
        }
        body = head(s, {
          open,
          count: countOf(s),
          control: groupSwitchHtml({
            on: s.selectedCount === s.total,
            some: s.selectedCount > 0,
            label: `All of ${esc(s.label)}`,
            attrs: `data-oc-cat-sw="${esc(s.catId)}"`,
          }),
        }) + (open ? `
          <ul class="oc-lines">
            ${s.mcps.map((m) => {
              const on = state.selectedConns.has(m.id);
              const v = connValue(m);
              const sk = m.lent ? `lent:${m.id}` : (m.serviceKey || m.name || m.id);
              const label = m.accountLabel || ((svcCounts.get(sk) || 0) > 1 ? 'Default' : '');
              const displayName = label ? `${m.name} · ${label}` : m.name;
              return line({ rowAttr: 'data-oc-row-conn', id: m.id, icon: renderConnLogo(m, { badge: false }), name: displayName, value: v.text, warn: v.warn, on, sw: switchHtml({ on, label: `Share ${esc(displayName)}`, attrs: `data-oc-conn="${esc(m.id)}"` }) });
            }).join('')}
            ${s.skills.map((sk) => {
              const on = state.selectedSkills.has(sk.id);
              return line({ rowAttr: 'data-oc-row-skill', id: sk.id, icon: SKILL_ICON, name: sk.name || sk.id, on, sw: switchHtml({ on, label: `Share ${esc(sk.name || sk.id)}`, attrs: `data-oc-skill="${esc(sk.id)}"` }) });
            }).join('')}
          </ul>` : '');
      } else if (s.kind === 'memory') {
        body = head(s, { open }) + (open ? `
          <div class="oc-seg" role="group" aria-label="Memory">
            ${MEMORY_MODES.map(([val, lbl]) => `<button type="button" data-oc-mem="${esc(val)}" aria-pressed="${state.memoryAccess === val}">${esc(lbl.replace('&', 'and'))}</button>`).join('')}
          </div>` : '');
      } else if (s.kind === 'manage') {
        const on = canManageNow();
        body = `
          <div class="oc-head-row">
            <span class="oc-head is-plain"><span class="oc-head-l">Manage connections</span></span>
            ${switchHtml({ on, label: 'Can add, change and remove connections', attrs: 'data-oc-manage' })}
          </div>`;
      } else if (s.kind === 'future') {
        const on = futureEnabledNow();
        body = `
          <div class="oc-head-row">
            <span class="oc-head is-plain"><span class="oc-head-l">Future connections and skills</span></span>
            ${switchHtml({ on, label: 'Automatically share connections and skills added later', attrs: 'data-oc-future' })}
          </div>`;
      } else {
        if (!s.total) return '';
        body = head(s, {
          open,
          count: s.selectedCount === 0 ? `0 of ${s.total}` : countOf(s),
          control: groupSwitchHtml({ on: s.selectedCount === s.total, some: s.selectedCount > 0, label: 'All of the Vault', attrs: 'data-oc-vault-all' }),
        }) + (open ? `
          <ul class="oc-lines">
            ${s.secrets.map((sec) => {
              const on = state.selectedSecrets.has(sec.key);
              const name = /^capture_[0-9a-f]{32}$/.test(sec.key) && sec.description ? sec.description : sec.key;
              const mode = typeof vaultMode === 'function' ? vaultMode(sec) : '';
              return line({ rowAttr: 'data-oc-row-secret', id: sec.key, icon: LOCK_ICON, name, value: mode ? modeLabel(mode) : VAULT_TYPE_LABELS[sec.type] || '', on, sw: switchHtml({ on, label: `Share ${esc(name)}`, attrs: `data-oc-secret="${esc(sec.key)}"` }) });
            }).join('')}
          </ul>
          <p class="oc-note">The agent sees names only. Loop fills in the value and hides it from replies.</p>` : '');
      }
      return `${s.kind === 'memory' ? laterNote : ''}<div class="oc-group ${open ? 'is-open' : ''}" data-oc-group="${esc(s.id)}">${body}</div>`;
    }).join('');

    pickerHost.innerHTML = `
      <div class="oc-inline">
        ${total > 0 || state.secrets.length > 0 ? `
          <div class="oc-find">
            <input type="search" id="oc-search" value="${esc(state.search)}" placeholder="Search" aria-label="Search what it can use" autocomplete="off" enterkeyhint="search">
            ${total > 0 ? `<button type="button" class="oc-bulk" data-oc-bulk="${anyOn ? 'none' : 'all'}">${anyOn ? 'Turn all off' : 'Turn all on'}</button>` : ''}
          </div>` : '<p class="oc-note is-first">You have no connections or skills yet. New items stay off unless you turn on Future connections and skills.</p>'}
        ${html || (q ? '<p class="oc-note is-first">Nothing matches.</p>' : '')}
      </div>`;

    if (caret) {
      const input = pickerHost.querySelector('#oc-search');
      input?.focus({ preventScroll: true });
      try { input?.setSelectionRange(...caret); } catch { /* ignore */ }
    } else if (focus) {
      pickerHost.querySelector(focus)?.focus({ preventScroll: true });
    }
    wireEvents(sections);
  }

  function updateConnectButton() {
    const allow = view.querySelector('#oauth-allow');
    if ((canPickOne || existingGrantId) && allow) {
      allow.disabled = state.loading || Boolean(state.loadError) || (pickOne && (!chosenConnection || (!wholeConnection && !chosenTools.size)));
      allow.textContent = pickOne ? (wholeConnection ? 'Share connection' : 'Share selected actions') : 'Connect';
      if (existingGrantId) allow.textContent = pickOne && !unchangedActions() ? 'Save actions and reconnect' : 'Reconnect';
    }
  }

  function render() {
    updateSummaryLabel();
    onChange?.(summary());
    updateConnectButton();

    if (state.loading) {
      pickerHost.innerHTML = `
        <div class="oc-loading" role="status">
          <div class="spin" aria-hidden="true"></div>
          <span>Loading your Loop setup&hellip;</span>
        </div>`;
      return;
    }

    if (state.loadError) {
      pickerHost.innerHTML = `
        <div class="oc-empty">
          <p>${esc(state.loadError)}</p>
          <button type="button" class="btn sm" data-oc-retry>Try again</button>
        </div>`;
      pickerHost.querySelector('[data-oc-retry]')?.addEventListener('click', loadCatalog);
      return;
    }

    if (panel) {
      renderPanel(buildSections());
      return;
    }

    if (existingToolGrants && !pickOne) {
      const editableConnection = state.mcps.some((c) => c.id === existingGrantId && c.enabled && !c.authRequired);
      pickerHost.innerHTML = `<p>Reconnect with the actions you previously shared with ${esc(clientName)}.</p>
        <ul>${Object.entries(existingToolGrants).map(([id, names]) => {
          const connection = state.mcps.find((c) => c.id === id);
          const namedMap = new Map((connection?.namedActions || []).map((a) => [a.id, a]));
          return `<li><strong>${esc(connection?.name || id)}</strong>${connection?.accountLabel ? ' · ' + esc(connection.accountLabel) : ''} · ${esc(id)}
            <ul>${names.map((name) => {
              const na = namedMap.get(name);
              return `<li>${esc(na ? `${na.title} (${name})` : name)}</li>`;
            }).join('')}</ul></li>`;
        }).join('')}</ul>
        ${existingGrantId ? `<button type="button" class="btn sm" data-oc-edit-actions ${editableConnection ? '' : 'disabled'}>Change shared actions</button>
          ${editableConnection ? '' : '<p class="oc-note">Enable this connection and finish its sign-in in Loop to change its actions.</p>'}` : ''}`;
      pickerHost.querySelector('[data-oc-edit-actions]')?.addEventListener('click', () => {
        pickOne = true;
        state.profile = currentAgent.profile || 'all';
        chosenConnection = existingGrantId;
        chosenTools.clear();
        for (const name of existingToolGrants[existingGrantId]) chosenTools.add(name);
        render();
        pickerHost.querySelector('[data-oc-action]')?.focus();
      });
      return;
    }

    if (pickOne) {
      const connections = scopedMcps().filter((c) => c.enabled);
      const selected = connections.find((c) => c.id === chosenConnection);
      const tools = (selected?.tools || []).filter((t) => t.enabled !== false);
      const namedActions = Array.isArray(selected?.namedActions) ? selected.namedActions : [];
      const availableNames = new Set([...namedActions.map((a) => a.id), ...tools.map((t) => t.name)]);
      const totalSelectable = namedActions.length + tools.length;
      pickerHost.innerHTML = `
        <div class="oc-panel oc-single-grant">
          <label for="oc-one-connection">Share one connection with ${esc(clientName)}</label>
          <select class="oc-profile-sel" id="oc-one-connection" ${existingGrantId ? 'disabled' : ''}>
            <option value="">Choose a connection</option>
            ${connections.map((c) => `<option value="${esc(c.id)}" ${c.id === chosenConnection ? 'selected' : ''} ${c.authRequired ? 'disabled' : ''}>${esc(c.name || c.id)}${c.accountLabel ? ' · ' + esc(c.accountLabel) : ''}${c.name && c.name !== c.id ? ' (' + esc(c.id) + ')' : ''}${c.authRequired ? ' · Sign-in required' : ''}</option>`).join('')}
          </select>
          ${selected && !existingGrantId ? `<label for="oc-one-action">Access</label>
            <select id="oc-one-action" class="oc-profile-sel">
              <option value="selected" ${wholeConnection ? '' : 'selected'}>Only the actions I select</option>
              <option value="connection" ${wholeConnection ? 'selected' : ''}>Whole connection, including future actions</option>
            </select>` : ''}
          ${selected && !wholeConnection ? `<fieldset><legend>Choose actions</legend>
              ${totalSelectable > 8 ? '<input type="search" placeholder="Find an action" aria-label="Find an action" data-oc-find-action>' : ''}
              <div class="oc-action-list">${namedActions.map((a) => {
                const detail = [
                  'Read-only',
                  a.accountLabel ? a.accountLabel : '',
                  a.providerOperation ? `runs ${a.providerOperation}` : '',
                  firstSentence(a.description),
                ].filter(Boolean).join(' · ');
                return `<label data-oc-named-action="${esc(a.id)}"><input type="checkbox" data-oc-action value="${esc(a.id)}" ${chosenTools.has(a.id) ? 'checked' : ''}>
                  <span>${esc(a.title)}<small>${esc(detail)}</small></span></label>`;
              }).join('')}${tools.map((t) => {
                const title = t.title || t.annotations?.title || t.name;
                const detail = [title === t.name ? '' : t.name, firstSentence(t.description)].filter(Boolean).join(' · ');
                return `<label><input type="checkbox" data-oc-action value="${esc(t.name)}" ${chosenTools.has(t.name) ? 'checked' : ''}>
                  <span>${esc(title)}${detail ? `<small>${esc(detail)}</small>` : ''}</span></label>`;
              }).join('')}
              ${existingGrantId ? existingToolGrants[existingGrantId].filter((name) => !availableNames.has(name)).map((name) =>
                `<label><input type="checkbox" data-oc-action value="${esc(name)}" ${chosenTools.has(name) ? 'checked' : 'disabled'}> <span>${esc(name)}<small>Unavailable. Clear this action before saving a change.</small></span></label>`
              ).join('') : ''}</div>
              ${totalSelectable ? '<p class="oc-note">Named actions pin the operation and account. Selecting a general broker tool grants every operation that tool can run.</p>' : ''}
              ${!totalSelectable ? '<p class="oc-note">No enabled actions. Refresh this connection in Loop to discover its tools.</p>' : ''}
            </fieldset>` : selected ? `<p class="oc-note">This agent can use the tools enabled on ${esc(selected.name || selected.id)}. The provider account determines what those tools can do.</p>
            <details><summary>Enabled tools (${tools.length})</summary><ul>${tools.map((t) => `<li>${esc(t.name)}</li>`).join('')}</ul></details>` :
            !connections.length ? '<p class="oc-note">This project has no enabled connections. Add one in Loop, then return to sign in.</p>' : ''}
          <p class="oc-note">Other connections, your saved Skills, Memory, Vault items and connection management stay private. New connections require another grant.</p>
          ${existingGrantId ? '<p class="oc-note">Changing access signs out older sessions for this agent.</p>' : ''}
          <button type="button" class="btn sm" data-oc-custom>${existingGrantId ? 'Discard changes' : 'Choose access manually'}</button>
        </div>`;
      pickerHost.querySelector('#oc-one-connection').addEventListener('change', (event) => {
        const choice = connections.find((c) => c.id === event.target.value && !c.authRequired);
        chosenConnection = choice?.id || '';
        wholeConnection = false;
        chosenTools.clear();
        render();
        pickerHost.querySelector('#oc-one-connection').focus();
      });
      pickerHost.querySelector('#oc-one-action')?.addEventListener('change', (event) => {
        wholeConnection = event.target.value === 'connection';
        render();
        pickerHost.querySelector('#oc-one-action').focus();
      });
      pickerHost.querySelector('.oc-action-list')?.addEventListener('change', ({ target }) => {
        if (!target.matches('[data-oc-action]')) return;
        if (target.checked) chosenTools.add(target.value);
        else chosenTools.delete(target.value);
        updateConnectButton();
      });
      pickerHost.querySelector('[data-oc-find-action]')?.addEventListener('input', ({ target }) => {
        const query = target.value.trim().toLowerCase();
        for (const label of pickerHost.querySelectorAll('.oc-action-list label')) {
          label.hidden = !label.textContent.toLowerCase().includes(query);
        }
      });
      pickerHost.querySelector('[data-oc-custom]').addEventListener('click', () => {
        pickOne = false;
        if (existingGrantId) {
          render();
          pickerHost.querySelector('[data-oc-edit-actions]')?.focus();
          return;
        }
        state.includeFuture = false;
        state.selectedConns.clear();
        state.selectedSkills.clear();
        state.selectedSecrets.clear();
        state.memoryAccess = 'none';
        state.memoryTouched = true;
        state.canManage = false;
        render();
        pickerHost.querySelector('[data-oc-pick-one]')?.focus();
      });
      return;
    }

    const prevScroll = pickerHost.querySelector('.oc-scroll')?.scrollTop ?? 0;
    const prevRailScroll = pickerHost.querySelector('.oc-rail')?.scrollTop ?? 0;
    const activeSearch = document.activeElement?.id === 'oc-search';
    const selStart = activeSearch ? document.activeElement.selectionStart : null;
    const selEnd = activeSearch ? document.activeElement.selectionEnd : null;

    const sections = buildSections();
    const conns = scopedMcps();
    const skills = scopedSkills();
    const totalCount = conns.length + skills.length;
    const selectedCount = state.selectedConns.size + state.selectedSkills.size;
    const allSelected = totalCount > 0 && selectedCount === totalCount;
    const q = state.search.trim();

    if (!state.activeJump || !sections.some((s) => s.id === state.activeJump)) {
      state.activeJump = sections[0]?.id || '';
    }

    const railCountText = (s) => {
      if (s.kind === 'memory') {
        if (state.memoryAccess === 'none') return 'Off';
        return state.memoryAccess === 'read_write' ? 'R/W' : 'Read';
      }
      if (s.kind === 'manage') return canManageNow() ? 'On' : 'Off';
      if (s.kind === 'future') return futureEnabledNow() ? 'On' : 'Off';
      if (s.kind === 'vault') {
        if (s.total === 0) return '0';
        return s.selectedCount > 0 ? `${s.selectedCount}/${s.total}` : `0/${s.total}`;
      }
      if (s.selectedCount === s.total) return String(s.total);
      return `${s.selectedCount}/${s.total}`;
    };

    const renderCategorySection = (s) => {
      const open = Boolean(q) || state.openGroups.has(s.id);
      const allOn = s.total > 0 && s.selectedCount === s.total;
      const countText =
        s.selectedCount === s.total
          ? String(s.total)
          : `${s.selectedCount} of ${s.total}`;
      return `
        <div class="hm-group oc-group ${open ? 'is-open' : ''}" data-oc-group="${esc(s.id)}">
          <div class="oc-head-row">
            <button type="button" class="hm-head" data-oc-toggle-group="${esc(s.id)}" aria-expanded="${open ? 'true' : 'false'}">
              ${CHEV_ICON}
              <span class="hm-head-l">${esc(s.label)}</span>
              <span class="hm-head-n">${esc(countText)}</span>
            </button>
            ${switchHtml({
              on: allOn,
              label: `Toggle all items in ${esc(s.label)}`,
              attrs: `data-oc-cat-sw="${esc(s.catId)}"`,
            })}
          </div>
          ${open ? `
            <ul class="list">
              ${(() => {
                const svcCounts = new Map();
                for (const m of s.mcps) {
                  const sk = m.lent ? `lent:${m.id}` : (m.serviceKey || m.name || m.id);
                  svcCounts.set(sk, (svcCounts.get(sk) || 0) + 1);
                }
                return s.mcps.map((m) => {
                  const on = state.selectedConns.has(m.id);
                  const sk = m.lent ? `lent:${m.id}` : (m.serviceKey || m.name || m.id);
                  const label = m.accountLabel || ((svcCounts.get(sk) || 0) > 1 ? 'Default' : '');
                  const displayName = label ? `${m.name} · ${label}` : m.name;
                  return `
                  <li>
                    <div class="row ctl-row oc-row ${on ? '' : 'is-off'}" data-oc-row-conn="${esc(m.id)}">
                      ${renderConnLogo(m)}
                      <span class="txt">
                        <span class="t">${esc(displayName)}</span>
                        ${connSubtitle(m, esc)}
                      </span>
                      ${switchHtml({
                        on,
                        label: `Allow ${esc(displayName)}`,
                        attrs: `data-oc-conn="${esc(m.id)}"`,
                      })}
                    </div>
                  </li>`;
                }).join('');
              })()}
              ${s.skills.map((sk) => {
                const on = state.selectedSkills.has(sk.id);
                const desc = firstSentence(sk.description);
                return `
                  <li>
                    <div class="row ctl-row oc-row ${on ? '' : 'is-off'}" data-oc-row-skill="${esc(sk.id)}">
                      <span class="hm-lane">${SKILL_ICON}</span>
                      <span class="txt">
                        <span class="t">${esc(sk.name || sk.id)} <span class="oc-tag">Skill</span></span>
                        ${desc ? `<span class="ctl-st">${esc(desc)}</span>` : '<span class="ctl-st">Skill</span>'}
                      </span>
                      ${switchHtml({
                        on,
                        label: `Allow skill ${esc(sk.name || sk.id)}`,
                        attrs: `data-oc-skill="${esc(sk.id)}"`,
                      })}
                    </div>
                  </li>`;
              }).join('')}
            </ul>
          ` : ''}
        </div>`;
    };

    const renderMemorySection = (s) => {
      const open = Boolean(q) || state.openGroups.has(s.id);
      const memDesc =
        state.memoryAccess === 'none'
          ? 'Cannot read or save memories'
          : state.memoryAccess === 'read_write'
            ? 'Can recall and save memories'
            : 'Can recall memories, cannot save';
      return `
        <div class="hm-group oc-group ${open ? 'is-open' : ''}" data-oc-group="${esc(s.id)}">
          <div class="oc-head-row">
            <button type="button" class="hm-head" data-oc-toggle-group="${esc(s.id)}" aria-expanded="${open ? 'true' : 'false'}">
              ${CHEV_ICON}
              <span class="hm-head-l">Memory</span>
              <span class="hm-head-n">${esc(MEMORY_MODES.find(([v]) => v === state.memoryAccess)?.[1] || 'Read')}</span>
            </button>
          </div>
          ${open ? `
            <ul class="list">
              <li>
                <div class="row ctl-row oc-row oc-row-mem ${state.memoryAccess === 'none' ? 'is-off' : ''}">
                  <span class="hm-lane">${LAYERS_ICON}</span>
                  <span class="txt">
                    <span class="t">Shared memory</span>
                    <span class="ctl-st">${esc(memDesc)}</span>
                  </span>
                  <div class="seg oc-mem-seg" role="group" aria-label="Memory access">
                    ${MEMORY_MODES.map(([val, lbl]) => `
                      <button type="button" class="seg-btn" data-oc-mem="${esc(val)}" aria-pressed="${state.memoryAccess === val ? 'true' : 'false'}">${esc(lbl)}</button>
                    `).join('')}
                  </div>
                </div>
              </li>
            </ul>
          ` : ''}
        </div>`;
    };

    const renderManageSection = (s) => {
      const open = Boolean(q) || state.openGroups.has(s.id);
      const on = canManageNow();
      return `
        <div class="hm-group oc-group ${open ? 'is-open' : ''}" data-oc-group="${esc(s.id)}">
          <div class="oc-head-row">
            <button type="button" class="hm-head" data-oc-toggle-group="${esc(s.id)}" aria-expanded="${open ? 'true' : 'false'}">
              ${CHEV_ICON}
              <span class="hm-head-l">Manage connections</span>
              <span class="hm-head-n">${on ? 'On' : 'Off'}</span>
            </button>
          </div>
          ${open ? `
            <ul class="list">
              <li>
                <div class="row ctl-row oc-row oc-row-mem ${on ? '' : 'is-off'}">
                  <span class="hm-lane">${PLUG_ICON}</span>
                  <span class="txt">
                    <span class="t">Can manage connections</span>
                    <span class="ctl-st">Add, change and remove connections. Address changes still need your OK.</span>
                  </span>
                  ${switchHtml({ on, label: 'Can manage connections', attrs: 'data-oc-manage' })}
                </div>
              </li>
            </ul>
          ` : ''}
        </div>`;
    };

    const renderVaultSection = (s) => {
      const open = Boolean(q) || state.openGroups.has(s.id);
      const allVaultOn = s.total > 0 && s.selectedCount === s.total;
      return `
        <div class="hm-group oc-group ${open ? 'is-open' : ''}" data-oc-group="${esc(s.id)}">
          <div class="oc-head-row">
            <button type="button" class="hm-head" data-oc-toggle-group="${esc(s.id)}" aria-expanded="${open ? 'true' : 'false'}">
              ${CHEV_ICON}
              <span class="hm-head-l">Vault</span>
              <span class="hm-head-n">${esc(s.total === 0 ? '0' : `${s.selectedCount} of ${s.total}`)}</span>
            </button>
            ${s.total > 0 ? switchHtml({
              on: allVaultOn,
              label: 'Toggle all Vault items',
              attrs: 'data-oc-vault-all',
            }) : ''}
          </div>
          ${open ? (s.secrets.length > 0 ? `
            <ul class="list">
              ${s.secrets.map((sec) => {
                const on = state.selectedSecrets.has(sec.key);
                const typeLabel = VAULT_TYPE_LABELS[sec.type] || '';
                const sub = [typeLabel, firstSentence(sec.description)].filter(Boolean).join(' · ');
                return `
                  <li>
                    <div class="row ctl-row oc-row ${on ? '' : 'is-off'}" data-oc-row-secret="${esc(sec.key)}">
                      <span class="hm-lane">${LOCK_ICON}</span>
                      <span class="txt">
                        <span class="t">${esc(sec.key)}</span>
                        ${sub ? `<span class="ctl-st">${esc(sub)}</span>` : '<span class="ctl-st">Vault secret</span>'}
                      </span>
                      ${switchHtml({
                        on,
                        label: `Share Vault item ${esc(sec.key)}`,
                        attrs: `data-oc-secret="${esc(sec.key)}"`,
                      })}
                    </div>
                  </li>`;
              }).join('')}
            </ul>
            <p class="hm-note">Agent sees key names only. Loop fills values securely and hides them from output.</p>
          ` : `
            <p class="hm-note">${s.total === 0 ? 'No Vault items yet.' : 'No Vault items match your search.'}</p>
          `) : ''}
        </div>`;
    };

    const renderFutureSection = (s) => {
      const open = Boolean(q) || state.openGroups.has(s.id);
      const on = futureEnabledNow();
      return `
        <div class="hm-group oc-group ${open ? 'is-open' : ''}" data-oc-group="${esc(s.id)}">
          <div class="oc-head-row">
            <button type="button" class="hm-head" data-oc-toggle-group="${esc(s.id)}" aria-expanded="${open ? 'true' : 'false'}">
              ${CHEV_ICON}
              <span class="hm-head-l">Future items</span>
              <span class="hm-head-n">${on ? 'On' : 'Off'}</span>
            </button>
          </div>
          ${open ? `
            <ul class="list">
              <li>
                <div class="row ctl-row oc-row oc-row-mem ${on ? '' : 'is-off'}">
                  <span class="hm-lane">${PLUG_ICON}</span>
                  <span class="txt">
                    <span class="t">Include future connections and skills</span>
                    <span class="ctl-st">Automatically share connections and skills you add later.</span>
                  </span>
                  ${switchHtml({ on, label: 'Include future connections and skills', attrs: 'data-oc-future' })}
                </div>
              </li>
            </ul>
          ` : ''}
        </div>`;
    };

    const sectionHtml = (s) => {
      if (s.kind === 'memory') return renderMemorySection(s);
      if (s.kind === 'manage') return renderManageSection(s);
      if (s.kind === 'future') return renderFutureSection(s);
      if (s.kind === 'vault') return renderVaultSection(s);
      return renderCategorySection(s);
    };

    pickerHost.innerHTML = `
      <div class="oc-panel">
        <div class="oc-toolbar">
          ${canPickOne ? '<button type="button" class="btn sm" data-oc-pick-one>Share one connection</button>' : ''}
          <div class="oc-toolbar-right">
            ${oauthProfiles.length > 0 ? `
              <select class="oc-profile-sel" id="oauth-profile" aria-label="Project">
                <option value="all" ${state.profile === 'all' ? 'selected' : ''}>All</option>
                ${oauthProfiles.map((p) => `<option value="${esc(p.id)}" ${state.profile === p.id ? 'selected' : ''}>${esc(p.name || p.id)}</option>`).join('')}
              </select>
            ` : ''}
            ${totalCount > 0 ? `
              <button type="button" class="oc-select-all ${allSelected ? 'is-checked' : ''}" role="checkbox" aria-checked="${allSelected ? 'true' : (selectedCount > 0 ? 'mixed' : 'false')}" data-oc-bulk="${allSelected ? 'none' : 'all'}">
                <span class="oc-check-box" aria-hidden="true">${allSelected ? '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.2 6.3L4.8 8.9L9.8 3.2"/></svg>' : (selectedCount > 0 ? '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2.5 6h7"/></svg>' : '')}</span>
                <span>Select all tools</span>
              </button>
            ` : ''}
          </div>
        </div>
        <div class="oc-search-bar">
          <input type="search" class="ctl-search oc-search" id="oc-search" value="${esc(state.search)}" placeholder="Search connections, skills, and vault" aria-label="Search connections, skills, and vault">
          ${sections.length > 1 ? `
            <select class="hm-jump-sel oc-jump-sel" aria-label="Jump to a section">
              <option value="">Jump to…</option>
              ${sections.map((s) => `<option value="${esc(s.id)}">${esc(s.label)} (${esc(railCountText(s))})</option>`).join('')}
            </select>
          ` : ''}
        </div>
        <div class="oc-body">
          <nav class="oc-rail" aria-label="Categories">
            ${sections.map((s) => `
              <button type="button" class="hm-jump ${s.kind === 'vault' && s.selectedCount === 0 ? 'is-empty' : ''}" data-oc-jump="${esc(s.id)}" aria-current="${s.id === state.activeJump ? 'true' : 'false'}">
                <span>${esc(s.label)}</span>
                <span class="hm-jump-n">${esc(railCountText(s))}</span>
              </button>
            `).join('')}
          </nav>
          <div class="oc-scroll">
            ${sections.length > 0
              ? sections.map(sectionHtml).join('')
              : '<div class="empty"><p class="et">Nothing matches</p><p class="ed">Try a different search term.</p></div>'}
          </div>
        </div>
      </div>
    `;

    const scrollEl = pickerHost.querySelector('.oc-scroll');
    if (scrollEl) scrollEl.scrollTop = prevScroll;
    const railEl = pickerHost.querySelector('.oc-rail');
    if (railEl) railEl.scrollTop = prevRailScroll;

    if (activeSearch) {
      const inp = pickerHost.querySelector('#oc-search');
      if (inp) {
        inp.focus();
        if (typeof selStart === 'number' && typeof selEnd === 'number') {
          try { inp.setSelectionRange(selStart, selEnd); } catch { /* ignore */ }
        }
      }
    }

    wireEvents(sections);
  }

  function wireEvents(sections) {
    pickerHost.querySelector('[data-oc-pick-one]')?.addEventListener('click', () => {
      pickOne = true;
      chosenConnection = '';
      wholeConnection = false;
      chosenTools.clear();
      render();
      pickerHost.querySelector('#oc-one-connection').focus();
    });
    // Select All / Select segmented toggle
    pickerHost.querySelectorAll('[data-oc-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextMode = btn.dataset.ocMode;
        state.itemsTouched = true;
        if (nextMode === 'all') {
          state.mode = 'all';
          resetSelectionsToAll();
        } else {
          state.mode = 'select';
        }
        render();
      });
    });

    // Quick clear / select all tools (connections and skills only; Vault stays opt-in)
    pickerHost.querySelectorAll('[data-oc-bulk]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const action = e.currentTarget.dataset.ocBulk;
        state.itemsTouched = true;
        if (action === 'none') {
          state.mode = 'select';
          state.includeFuture = false;
          state.legacyFutureConns = false;
          state.legacyFutureSkills = false;
          state.futureTouched = true;
          state.selectedConns.clear();
          state.selectedSkills.clear();
          if (panel) {
            state.selectedSecrets.clear();
            state.memoryAccess = 'none';
            state.canManage = false;
            state.manageTouched = true;
          }
        } else {
          state.mode = 'select';
          resetSelectionsToAll();
          // Vault, Manage connections, and Future items remain explicit opt-ins.
          if (panel) {
            state.memoryAccess = 'read_write';
          }
        }
        render();
      });
    });

    // Profile selector
    pickerHost.querySelector('#oauth-profile')?.addEventListener('change', (e) => {
      state.profile = String(e.currentTarget.value || 'all');
      state.initializedOpen = false;
      state.openGroups.clear();
      ensureSelectionsForProfile();
      render();
    });

    // Search input
    pickerHost.querySelector('#oc-search')?.addEventListener('input', (e) => {
      state.search = String(e.currentTarget.value || '');
      render();
    });

    // Jump to section (desktop rail & mobile select)
    const jumpToSection = (secId) => {
      if (!secId) return;
      state.activeJump = secId;
      state.openGroups.add(secId);
      render();
      const target = pickerHost.querySelector(`[data-oc-group="${CSS.escape(secId)}"]`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    pickerHost.querySelectorAll('[data-oc-jump]').forEach((btn) => {
      btn.addEventListener('click', () => jumpToSection(btn.dataset.ocJump));
    });
    pickerHost.querySelector('.oc-jump-sel')?.addEventListener('change', (e) => {
      const val = e.currentTarget.value;
      e.currentTarget.value = '';
      jumpToSection(val);
    });

    // Expand / collapse category group
    pickerHost.querySelectorAll('[data-oc-toggle-group]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const gid = btn.dataset.ocToggleGroup;
        if (state.openGroups.has(gid)) state.openGroups.delete(gid);
        else state.openGroups.add(gid);
        state.activeJump = gid;
        render();
      });
    });

    // Category-level switch (toggles all connections & skills in that category)
    pickerHost.querySelectorAll('[data-oc-cat-sw]').forEach((sw) => {
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        const catId = sw.dataset.ocCatSw;
        const sec = sections.find((s) => s.kind === 'category' && s.catId === catId);
        if (!sec) return;
        const turnOn = sec.selectedCount < sec.total;
        state.itemsTouched = true;
        switchToSelectModeIfNeeded();
        for (const m of sec.allMcps) {
          if (turnOn) state.selectedConns.add(m.id);
          else state.selectedConns.delete(m.id);
        }
        for (const sk of sec.allSkills) {
          if (turnOn) state.selectedSkills.add(sk.id);
          else state.selectedSkills.delete(sk.id);
        }
        render();
      });
    });

    // Connection row / switch toggle
    const toggleConn = (id) => {
      state.itemsTouched = true;
      switchToSelectModeIfNeeded();
      if (state.selectedConns.has(id)) state.selectedConns.delete(id);
      else state.selectedConns.add(id);
      render();
    };
    pickerHost.querySelectorAll('[data-oc-row-conn]').forEach((row) => {
      row.addEventListener('click', () => toggleConn(row.dataset.ocRowConn));
    });

    // Skill row / switch toggle
    const toggleSkill = (id) => {
      state.itemsTouched = true;
      switchToSelectModeIfNeeded();
      if (state.selectedSkills.has(id)) state.selectedSkills.delete(id);
      else state.selectedSkills.add(id);
      render();
    };
    pickerHost.querySelectorAll('[data-oc-row-skill]').forEach((row) => {
      row.addEventListener('click', () => toggleSkill(row.dataset.ocRowSkill));
    });

    // Memory access segmented control
    pickerHost.querySelectorAll('[data-oc-mem]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.memoryAccess = btn.dataset.ocMem;
        state.memoryTouched = true;
        render();
      });
    });

    pickerHost.querySelector('[data-oc-manage]')?.addEventListener('click', () => {
      state.canManage = !canManageNow();
      state.manageTouched = true;
      render();
    });

    pickerHost.querySelector('[data-oc-future]')?.addEventListener('click', () => {
      const next = !futureEnabledNow();
      state.includeFuture = next;
      state.legacyFutureConns = false;
      state.legacyFutureSkills = false;
      state.futureTouched = true;
      state.itemsTouched = true;
      if (next) {
        state.mode = 'all';
        resetSelectionsToAll();
      } else {
        state.mode = 'select';
      }
      render();
    });

    // Vault all toggle
    pickerHost.querySelector('[data-oc-vault-all]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const secrets = scopedSecrets();
      const allOn = secrets.length > 0 && secrets.every((s) => state.selectedSecrets.has(s.key));
      state.secretsTouched = true;
      if (allOn) state.selectedSecrets.clear();
      else state.selectedSecrets = new Set(secrets.map((s) => s.key));
      render();
    });

    // Individual Vault item toggle
    pickerHost.querySelectorAll('[data-oc-row-secret]').forEach((row) => {
      row.addEventListener('click', () => {
        const key = row.dataset.ocRowSecret;
        state.secretsTouched = true;
        if (state.selectedSecrets.has(key)) state.selectedSecrets.delete(key);
        else state.selectedSecrets.add(key);
        render();
      });
    });
  }

  async function loadCatalog() {
    state.loading = true;
    state.loadError = '';
    render();
    try {
      const [overview, vaultData] = await Promise.all([
        api('/api/overview'),
        api('/api/vault').catch(() => ({ secrets: [] })),
      ]);
      state.mcps = Array.isArray(overview?.mcps) ? overview.mcps : [];
      state.categories = Array.isArray(overview?.categories) ? overview.categories : [];
      const seenSkills = new Map();
      for (const c of state.categories) {
        for (const sk of Array.isArray(c.skills) ? c.skills : []) {
          if (sk?.id && !seenSkills.has(sk.id)) seenSkills.set(sk.id, sk);
        }
      }
      state.allSkills = [...seenSkills.values()];
      state.secrets = Array.isArray(vaultData?.secrets) ? vaultData.secrets : [];
      applyInitialSelections();
      state.loading = false;
      render();
    } catch (err) {
      state.loading = false;
      state.loadError = err?.message || 'Could not load your Loop setup.';
      render();
    }
  }

  if (panel) {
    // The panel around it opens and closes it.
  } else if (expandBtn) {
    expandBtn.addEventListener('click', () => {
      state.expanded = !state.expanded;
      expandBtn.setAttribute('aria-expanded', state.expanded ? 'true' : 'false');
      drawer.classList.toggle('is-open', state.expanded);
      view.querySelector('#loop-oauth-screen')?.classList.toggle('is-expanded', state.expanded);
      updateSummaryLabel();
    });
  } else {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        drawer.classList.add('is-open');
        view.querySelector('#loop-oauth-screen')?.classList.add('is-expanded');
      });
    });
  }

  // Start loading workspace items immediately in the background so expanding is instant.
  loadCatalog();

  return {
    summary,
    /** Every choice, as the fields of an agent. Null while the list is not there yet. */
    getAccess() {
      if (state.loading || state.loadError) return null;
      const picked = pickedItems();
      return {
        allowedConnections: picked.connections,
        allowedSkills: picked.skills,
        memoryAccess: state.memoryAccess,
        canManage: canManageNow(),
        secrets: [...state.selectedSecrets],
      };
    },
    getApprovalPayload() {
      const payload = { profile: state.profile || 'all' };
      if (existingToolGrants && (!pickOne || unchangedActions())) return { profile: currentAgent.profile || 'all' };
      if (canPickOne && (state.loading || state.loadError)) throw new Error('Wait for Loop to load your connections.');
      if (pickOne) {
        if (!scopedMcps().some((c) => c.enabled && !c.authRequired && c.id === chosenConnection)) {
          throw new Error('Choose a connection to share.');
        }
        if (!wholeConnection && !chosenTools.size) throw new Error('Choose at least one action to share.');
        return { ...payload, access: {
          allowedConnections: [chosenConnection],
          allowedSkills: [],
          memoryAccess: 'none',
          canManage: false,
          secrets: [],
          ...(wholeConnection ? {} : { toolGrants: { [chosenConnection]: [...chosenTools] } }),
        } };
      }
      const access = {};

      if (!state.loading && !state.loadError) {
        const picked = pickedItems();
        if (!currentAgent || state.itemsTouched || state.futureTouched) {
          access.allowedConnections = picked.connections;
          access.allowedSkills = picked.skills;
        }
        if (!currentAgent || state.manageTouched) {
          access.canManage = canManageNow();
        }
      }

      if (state.memoryTouched) {
        access.memoryAccess = state.memoryAccess;
      }
      if (state.secretsTouched) {
        access.secrets = [...state.selectedSecrets];
      }

      if (Object.keys(access).length > 0) {
        payload.access = access;
      }
      return payload;
    },
  };
}
