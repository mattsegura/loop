// Agent popups: an agent's details (Activity, Access, Connect) and the locked "Connect" of a project.
// To add an agent is add-agent.js, in the same panel. All open inline under the row that was clicked (inline-expand.js) and reuse the .st-* panel styles.

import { placeInline } from './inline-expand.js';
import { confirmDialog } from './components/confirm-dialog.js';
import { HOST_KINDS, hostSetup, hostSetupHtml } from './host-setup.js';
import {
  agentRows,
  agentMark,
  kindLabel,
  agentSnippet,
  snippetTabsFor,
  defaultSnippetTab,
  isPersonalWorkspace,
  resolveGatewayEndpoint,
  installState,
} from './agents-view.js';

const CLOSE_MS = 180;
const POLL_MS = 2500;
const ACTIVITY_FIRST = 9; // rows that fit the Activity pane before "Show older"
const ACTIVITY_STEP = 50;
const ACTIVITY_PAGE_SIZE = 100;

const X_ICON = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg>';
const TAB_ICONS = {
  activity: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 15l4-5 3 3 4-6 3 4"/></svg>',
  access: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 2.8l5.8 2.3v4.3c0 3.6-2.4 6.4-5.8 7.8-3.4-1.4-5.8-4.2-5.8-7.8V5.1z"/></svg>',
  connect: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8.5 11.5l3-3"/><path d="M11 6.5l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5L14.5 10"/><path d="M9 13.5L7.5 15a2.5 2.5 0 0 1-3.5-3.5L5.5 10"/></svg>',
};
const TAB_LABELS = { activity: 'Activity', access: 'Access', connect: 'Connect', setup: 'Set up' };
TAB_ICONS.setup = TAB_ICONS.connect;

// Short names for the setup tabs; the long ones list example apps, which the popup has no room for.
const SNIPPET_LABELS = { claude: 'Claude Code', codex: 'Codex', json: 'Other apps', stdio: 'Stdio bridge' };
const MEMORY_OPTIONS = [['read_write', 'Read & save'], ['read', 'Read'], ['none', 'None']];

let pop = null; // { el, ctx, returnFocus, changed, timer, ... }

function shortAgo(iso) {
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) return '';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

// One line of status under an agent's name: on Home and in the popup.
export function agentStatus(row) {
  if (row.agent && row.agent.enabled === false) return { cls: '', text: 'Off' };
  if (row.active > 0) return { cls: 'ok', text: `${row.active} ${row.active === 1 ? 'session' : 'sessions'} now` };
  if (!row.agent) {
    if (row.lastSeenAt) return { cls: '', text: `No key yet · active ${shortAgo(row.lastSeenAt)}` };
    // Loop is in its settings, or it started signing in, but Loop has never seen it connect.
    if (row.signIn) return { cls: '', text: 'Sign-in not finished' };
    return { cls: '', text: row.apps.some((app) => app.configuredIn) ? 'Never connected' : 'No key yet' };
  }
  if (row.lastSeenAt) return { cls: '', text: `Idle · active ${shortAgo(row.lastSeenAt)}` };
  return { cls: '', text: row.apps.some((app) => app.configuredIn) ? 'Set up · restart it to connect' : 'Not connected yet' };
}

/* ---------- popup shell ---------- */

function mount(ctx, label, flow = false) {
  const was = pop?.el.__xpAnchor || null;
  closeAgentPopup({ immediate: true, quiet: true });
  const el = document.createElement('div');
  el.className = 'st-root ap-root';
  el.innerHTML = `
    <div class="st-veil" data-ap-close></div>
    <div class="st-sheet ${flow ? 'ap-flow' : ''}" role="dialog" aria-label="${ctx.esc(label)}">
      <div class="ap-in"><div class="st-wait" role="status"><div class="spin" aria-hidden="true"></div></div></div>
      <button type="button" class="st-x" data-ap-close aria-label="Close">${X_ICON}</button>
    </div>`;
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  placeInline(el, was); // opens under the row that was clicked, not over the page
  pop = { el, ctx, returnFocus, changed: false, timer: null };
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-ap-close]')) closeAgentPopup();
  });
  el.addEventListener('keydown', onKeydown);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-open')));
  el.querySelector('.st-x').focus({ preventScroll: true });
  return pop;
}

function onKeydown(e) {
  if (!pop) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeAgentPopup();
    return;
  }
  // Inline panels are part of the page: Tab moves on past them like any other content.
  if (e.key !== 'Tab' || pop.el.classList.contains('xp-panel')) return;
  const items = [...pop.el.querySelectorAll('.st-sheet button:not([disabled]):not([tabindex="-1"]), .st-sheet input:not([disabled]), .st-sheet select:not([disabled]), .st-sheet a[href]')]
    .filter((n) => n.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

export function closeAgentPopup({ immediate = false, quiet = false } = {}) {
  if (!pop) return;
  const { el, ctx, returnFocus, changed, timer } = pop;
  pop = null;
  if (timer) clearTimeout(timer);
  // Settings shares the page lock; leave it on while Settings is still open.
  if (!document.querySelector('.st-root:not(.ap-root)')) document.documentElement.classList.remove('st-lock');
  el.classList.remove('is-open');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (immediate || reduced) el.remove();
  else setTimeout(() => el.remove(), CLOSE_MS);
  if (!immediate && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  if (!quiet) ctx.onClose?.(changed);
}

const inner = (p) => p.el.querySelector('.ap-in');
const alive = (p) => pop === p;
// For add-agent.js: the same panel, one at a time.
export { mount as mountPanel, inner as panelBody, alive as isOpenPanel };

function seg(esc, field, options, current, label) {
  return `
    <span class="st-seg" role="group" aria-label="${esc(label)}" data-ap-field="${esc(field)}">
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

function profileOptionsFrom(data, current = 'all') {
  const records = Array.isArray(data?.profileRecords) ? data.profileRecords : [];
  const seen = new Map([['all', 'All']]);
  for (const r of records) {
    if (r && typeof r.id === 'string' && r.id && r.id !== 'all') {
      seen.set(r.id, String(r.name || r.id));
    }
  }
  for (const id of Array.isArray(data?.profiles) ? data.profiles : []) {
    const clean = String(id || '').trim().toLowerCase();
    if (clean && clean !== 'all' && !seen.has(clean)) seen.set(clean, clean);
  }
  if (current && current !== 'all' && !seen.has(current)) seen.set(current, current);
  return [...seen.entries()];
}

function profileLabelOf(data, id, fallbackName = '') {
  if (!id || id === 'all') return 'All';
  const rec = Array.isArray(data?.profileRecords) ? data.profileRecords.find((r) => r && r.id === id) : null;
  return rec?.name || fallbackName || id;
}

function profilePicker(esc, field, options, current) {
  // A few short names fit in one row of buttons. Longer names need the menu, or they run out of the panel.
  const letters = options.reduce((n, [, label]) => n + String(label).length, 0);
  if (options.length <= 4 && letters <= 32) return seg(esc, field, options, current, 'Project');
  return `<select class="ap-select" data-ap-select="${esc(field)}" aria-label="Project">${options.map(([val, label]) => `<option value="${esc(val)}" ${val === current ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
}

// The setup snippet for an agent, with its key masked on screen. Copy puts the real key on the clipboard.
function snippetBlock(p, kind, token, name, profileLabel = '') {
  const { esc } = p.ctx;
  if (HOST_KINDS.includes(kind)) {
    const setup = hostSetup(kind, resolveGatewayEndpoint(p.data.endpoint, p.data.port), true);
    return hostSetupHtml(setup, esc) + (setup && token
      ? `<button type="button" class="btn sm" data-host-copy="key">Copy ${setup.rawKey ? 'key' : 'Authorization value'}</button>` : '');
  }
  const tabs = snippetTabsFor(p.data, p.ctx);
  const tab = tabs.some(([id]) => id === p.snippetTab) ? p.snippetTab : defaultSnippetTab(kind, p.data, p.ctx);
  p.snippetTab = tab;
  const opts = { endpoint: p.data.endpoint, port: p.data.port, stdioPath: p.data.stdioPath };
  const masked = token ? `${token.slice(0, 4)}${'•'.repeat(16)}` : '';
  return `
    <div class="ap-tabs">${seg(esc, 'snippet', tabs.map(([id]) => [id, SNIPPET_LABELS[id] || id]), tab, `Setup for ${name}`)}</div>
    <div class="ap-code">
      <pre>${esc(agentSnippet(tab, { ...opts, token: masked }))}</pre>
      <button type="button" class="ap-copy" data-ap-copy>Copy</button>
    </div>
    ${profileLabel
      ? `<p class="st-rs ap-warn">This connection is locked to <strong>${esc(profileLabel)}</strong>. Paste it into your agent. Treat this key like a password — anyone with it gets this connection’s access.</p>`
      : `<p class="st-rs ap-warn">This holds ${esc(name)}’s key. Anyone with it gets this agent’s access, so treat it like a password.</p>`}`;
}

function bindSnippet(p, token, repaint) {
  const kind = p.row?.kind || p.flow?.kind;
  if (HOST_KINDS.includes(kind)) {
    const setup = hostSetup(kind, resolveGatewayEndpoint(p.data.endpoint, p.data.port), true);
    for (const b of p.el.querySelectorAll('[data-host-copy]')) b.addEventListener('click', () => {
      const key = b.dataset.hostCopy;
      p.ctx.copyText(key === 'key' ? (setup.rawKey ? token : `Bearer ${token}`) : setup[key], 'Copied.');
    });
    return;
  }
  p.el.querySelectorAll('[data-ap-field="snippet"] [data-val]').forEach((b) => b.addEventListener('click', () => {
    p.snippetTab = b.dataset.val;
    repaint();
    p.el.querySelector(`[data-ap-field="snippet"] [data-val="${CSS.escape(b.dataset.val)}"]`)?.focus();
  }));
  p.el.querySelector('[data-ap-copy]')?.addEventListener('click', () => {
    p.ctx.copyText(
      agentSnippet(p.snippetTab, { endpoint: p.data.endpoint, port: p.data.port, stdioPath: p.data.stdioPath, token }),
      'Copied. Paste it into the agent.',
    );
  });
}

/* ---------- an agent's popup ---------- */

export async function openAgentPopup(ctx, rowId, tab = '') {
  const p = mount(ctx, 'Agent');
  p.kind = 'agent';
  p.rowId = rowId;
  p.tab = tab;
  p.actLimit = ACTIVITY_FIRST;
  await loadAgent(p);
}

async function loadAgent(p) {
  const { api, esc } = p.ctx;
  let data;
  try {
    data = await api('/api/agents');
  } catch (err) {
    if (!alive(p)) return;
    inner(p).innerHTML = `<div class="ap-msg"><p>${esc(err.message)}</p><button type="button" class="btn sm" data-ap-retry>Try again</button></div>`;
    inner(p).querySelector('[data-ap-retry]').addEventListener('click', () => loadAgent(p));
    return;
  }
  if (!alive(p)) return;
  const rows = agentRows(data.agents || [], Array.isArray(data.connected) ? data.connected : []);
  const row = rows.find((r) => r.id === p.rowId);
  if (!row) {
    inner(p).innerHTML = '<div class="ap-msg"><p>This agent is no longer in Loop.</p></div>';
    return;
  }
  p.data = data;
  p.row = row;
  if (!Array.isArray(p.entries)) p.entries = [];
  await Promise.all([
    loadAgentActivity(p),
    row.agent?.toolGrants
      ? api('/api/overview').then((data) => { p.grantConnections = data?.mcps || []; }).catch(() => {})
      : null,
    row.agent && !row.agent.toolGrants
      ? api('/api/services').then((data) => { p.services = Array.isArray(data?.services) ? data.services : []; }).catch(() => { p.services = []; })
      : null,
  ]);
  if (!alive(p)) return;
  const tabs = row.agent ? ['activity', 'access', 'connect'] : ['activity', 'setup'];
  if (!tabs.includes(p.tab)) p.tab = row.agent ? 'access' : 'setup';
  p.tabs = tabs;
  paintAgent(p, `[data-ap-tab="${p.tab}"]`);
}

export async function refreshOpenAgentActivity() {
  if (!pop || pop.kind !== 'agent' || !pop.row || !alive(pop)) return false;
  await loadAgentActivity(pop, { append: false });
  if (!alive(pop)) return false;
  if (pop.tab === 'activity') {
    const pane = pop.el.querySelector('#ap-pane');
    if (pane) {
      pane.innerHTML = activityPane(pop);
      bindActivityPaneEvents(pop);
    }
  }
  return true;
}

async function loadAgentActivity(p, { append = false } = {}) {
  const { api } = p.ctx;
  const { row } = p;
  try {
    const q = row.agent ? `&agent=${encodeURIComponent(row.agent.id)}` : '';
    const offset = append ? (p.activityFetchedCount || 0) : 0;
    const limit = append ? ACTIVITY_PAGE_SIZE : Math.max(ACTIVITY_PAGE_SIZE, p.activityFetchedCount || 0);
    const res = await api(`/api/activity?limit=${limit}&offset=${offset}${q}`);
    if (!alive(p)) return;
    const rawEntries = Array.isArray(res.entries) ? res.entries : [];
    const names = new Set(row.apps.map((app) => String(app.name || '').toLowerCase()));
    const filtered = rawEntries.filter((e) => (row.agent
      ? e.agentId === row.agent.id
      : !e.agentId && names.has(String(e.agentName || '').toLowerCase())));
    if (append) {
      p.entries = [...(p.entries || []), ...filtered];
      p.activityFetchedCount = offset + rawEntries.length;
    } else {
      p.entries = filtered;
      p.activityFetchedCount = rawEntries.length;
    }
    p.activityHasMore = Boolean(res.hasMore);
    p.activityTotal = typeof res.total === 'number' ? res.total : p.entries.length;
    p.activityLoaded = true;
    p.activityError = '';
    p.activityUpdatedAt = new Date().toISOString();
  } catch (err) {
    if (!alive(p)) return;
    p.activityError = err?.message || 'Could not load activity.';
  }
}

function paintAgent(p, focus = null) {
  const { esc } = p.ctx;
  const { row } = p;
  const status = agentStatus(row);
  const canEdit = Boolean(row.agent && !row.agent.toolGrants && p.ctx.addAgent);
  const canForget = !row.agent && row.apps[0]?.key && !String(row.apps[0].key).startsWith('config:');
  inner(p).innerHTML = `
    <aside class="st-side">
      <div class="ap-who">
        ${agentMark(row, esc, 'ap-mark')}
        <div class="ap-who-c">
          <h2 class="ap-name" id="ap-title">${esc(row.name)}</h2>
          <div class="ap-st ${status.cls === 'ok' ? 'is-ok' : ''}">${status.cls === 'ok' ? '<i aria-hidden="true"></i>' : ''}${esc(status.text)}</div>
        </div>
      </div>
      <div class="st-tabs" role="tablist" aria-label="${esc(row.name)}" aria-orientation="vertical">
        ${p.tabs.map((t) => `<button type="button" class="st-tab" role="tab" id="ap-tab-${t}" data-ap-tab="${t}" aria-controls="ap-pane" aria-selected="${p.tab === t}" tabindex="${p.tab === t ? 0 : -1}">${TAB_ICONS[t]}<span>${esc(TAB_LABELS[t])}</span></button>`).join('')}
      </div>
      <div class="ap-side-foot">
        ${canEdit ? '<button type="button" class="ap-side-a" data-ap-edit>Edit</button>' : ''}
        ${row.agent ? `<button type="button" class="ap-side-a" data-ap-toggle>${row.agent.enabled === false ? 'Turn on' : 'Turn off'}</button>` : ''}
        ${row.agent ? '<button type="button" class="ap-side-a is-no" data-ap-remove>Remove agent</button>' : ''}
        ${canForget ? '<button type="button" class="ap-side-a is-no" data-ap-forget>Remove from list</button>' : ''}
      </div>
    </aside>
    <div class="st-body">
      <section class="st-pane" id="ap-pane" role="tabpanel" aria-labelledby="ap-tab-${p.tab}">${paneHtml(p)}</section>
    </div>`;
  p.el.querySelector('.st-sheet').setAttribute('aria-labelledby', 'ap-title');
  bindAgent(p);
  if (focus) p.el.querySelector(focus)?.focus();
}

function paneHtml(p) {
  if (p.tab === 'activity') return activityPane(p);
  if (p.tab === 'access') return accessPane(p);
  if (p.tab === 'connect') return connectPane(p);
  return setupPane(p);
}

// "supabase__list_tables" reads as "supabase · list_tables", with the connection's own name.
let connName = (id) => id;
function toolLabel(target) {
  const t = String(target || '').replace(/\s*\([^)]*\)\s*$/, '');
  const i = t.indexOf('__');
  return i > 0 ? `${connName(t.slice(0, i))} · ${t.slice(i + 2)}` : t;
}

function describe(e, esc) {
  const t = String(e.target || '');
  const arrow = t.indexOf(' → ');
  const refs = arrow >= 0 ? t.slice(0, arrow) : t;
  const em = (x) => (x ? ` <em>· ${esc(x)}</em>` : '');
  const errNote = e.ok === false ? em(e.error || 'failed') : '';
  switch (e.method) {
    case 'tools/call': return esc(toolLabel(t)) + errNote;
    case 'secret/use': return `Used Vault item${em(refs)}${errNote}`;
    case 'secret/reveal': return `Viewed Vault item${em(refs)}${errNote}`;
    case 'secret/save': return `Saved a Vault login${em(refs)}${errNote}`;
    case 'memory/save': return `Saved a memory${em(t)}${errNote}`;
    case 'memory/delete': return `Deleted a memory${em(t)}${errNote}`;
    case 'memory/read-denied': return `Tried to read memory without permission${em(t)}`;
    case 'memory/write-denied': return `Tried to save without write permission${em(t)}`;
    case 'memory/secret-blocked': return 'Tried to save a secret as a memory · blocked';
    case 'task/save': return `Saved a task${em(t)}${errNote}`;
    case 'task/forget': return `Deleted a task${em(t)}${errNote}`;
    case 'saved/save': return `Saved to the Library${em(t)}${errNote}`;
    case 'saved/refresh': return `Refreshed a saved link${em(t)}${errNote}`;
    case 'saved/delete': return `${e.ok === false ? 'Delete from Saved failed' : 'Deleted from Saved'}${em(t)}${errNote}`;
    case 'saved/read-denied': return `Tried to read Saved items without permission${em(t)}`;
    case 'schedule/save': return `Saved a schedule${em(t)}${errNote}`;
    case 'schedule/run': return `${e.ok === false ? 'Schedule run failed' : 'Ran a schedule'}${em(t)}${errNote}`;
    case 'schedule/delete': return `${e.ok === false ? 'Delete schedule failed' : 'Deleted a schedule'}${em(t)}${errNote}`;
    case 'schedule/read-denied': return `Tried to read schedules without permission${em(t)}`;
    case 'file/save': return `Saved a file${em(t)}${errNote}`;
    case 'file/delete': return `${e.ok === false ? 'Delete file failed' : 'Deleted a file'}${em(t)}${errNote}`;
    case 'file/read-denied': return `Tried to read files without permission${em(t)}`;
    case 'approval/request': return `Asked to use${em(toolLabel(t))}`;
    case 'approval/consume': return `Used your approval${em(toolLabel(t))}`;
    case 'feedback/send': return e.ok ? 'Sent feedback about Loop' : 'Tried to send feedback about Loop';
    case 'feedback/ask': return 'Wanted to send feedback about Loop';
    case 'feedback/switch': return `Turned feedback about Loop ${t === 'on' ? 'on' : 'off'}`;
    case 'resources/read': return `Read from ${esc(connName(t.split(':')[0]))}${errNote}`;
    case 'prompts/get': return `Loaded the prompt ${esc(toolLabel(t))}${errNote}`;
    default: return esc(`${e.method || 'Did something'}${t ? ` ${t}` : ''}`) + errNote;
  }
}

function activityPane(p) {
  const { esc } = p.ctx;
  connName = typeof p.ctx.connName === 'function' ? p.ctx.connName : (id) => id;
  if (p.activityError && !p.activityLoaded) {
    return `
      <h3 class="st-h">Activity</h3>
      <p class="st-sub">Activity is unavailable.</p>
      <div class="ap-empty">
        <p>${esc(p.activityError)}</p>
        <button type="button" class="btn sm" data-ap-retry-activity>Try again</button>
      </div>`;
  }
  const today = new Date().toDateString();
  const todays = p.entries.filter((e) => new Date(e.at).toDateString() === today);
  const count = (m) => todays.filter((e) => e.method === m).length;
  const failedToday = todays.filter((e) => e.ok === false).length;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const shown = p.entries.slice(0, p.actLimit);
  const hasMoreToShow = p.entries.length > shown.length || Boolean(p.activityHasMore);
  const summaryBits = [
    plural(count('tools/call'), 'tool call', 'tool calls'),
    plural(count('secret/use'), 'Vault item used', 'Vault items used'),
    plural(count('memory/save'), 'memory saved', 'memories saved'),
    ...(failedToday > 0 ? [plural(failedToday, 'blocked or failed', 'blocked or failed')] : []),
  ];
  const updatedBit = p.activityUpdatedAt ? ` · Updated ${shortAgo(p.activityUpdatedAt)}` : '';
  const staleBar = p.activityError
    ? `<div class="ap-empty"><p>Unavailable: ${esc(p.activityError)}${p.activityUpdatedAt ? ` · Last updated ${esc(shortAgo(p.activityUpdatedAt))}.` : ''}</p><button type="button" class="btn sm" data-ap-retry-activity>Retry</button></div>`
    : '';
  return `
    <h3 class="st-h">Activity</h3>
    <p class="st-sub">Today: ${esc(summaryBits.join(' · '))}${esc(updatedBit)}</p>
    ${staleBar}
    ${shown.length ? `
      <ul class="ap-feed">
        ${shown.map((e) => `
          <li class="ap-ev">
            <span class="ap-dot ${e.ok ? '' : 'is-no'}" aria-label="${e.ok ? 'Worked' : 'Failed'}"></span>
            <span class="ap-ev-t">${describe(e, esc)}</span>
            <time class="ap-ev-at" datetime="${esc(e.at)}">${esc(shortAgo(e.at))}</time>
          </li>`).join('')}
      </ul>
      ${hasMoreToShow
        ? '<button type="button" class="ap-link" data-ap-older>Show older</button>'
        : (p.entries.length > ACTIVITY_FIRST ? `<p class="st-rs">Showing all ${esc(p.entries.length)} recorded events.</p>` : '')}` : `
      <p class="ap-empty">Nothing yet. When ${esc(p.row.name)} uses a connection, a Vault item or a memory through Loop, it shows up here.</p>`}`;
}

const manageText = (p) =>
  isPersonalWorkspace(p.data, p.ctx)
    ? 'Add, change and remove connections. Address changes still need your OK.'
    : 'Add, change and remove connections. Local commands and address changes still need your OK.';

const manageSwitch = (on, attr) => `
        <button type="button" class="sw ${on ? 'on' : ''}" role="switch" aria-checked="${Boolean(on)}" aria-label="Can manage connections" ${attr}><span class="sw-knob" aria-hidden="true"></span></button>`;

// A new agent manages Connections unless the owner limits it or says no (the same rule as the server).
const canManageIn = (f) => f.canManage ?? !(f.profile && f.profile !== 'all');

function accessPane(p) {
  const { esc } = p.ctx;
  const a = p.row.agent;
  if (a.toolGrants) {
    const connections = Object.entries(a.toolGrants).map(([id, actions]) => {
      const connection = p.grantConnections?.find((c) => c.id === id);
      const label = connection?.name || p.ctx.connName?.(id) || id;
      const account = connection?.accountLabel;
      const namedMap = new Map((connection?.namedActions || []).map((item) => [item.id, item]));
      return `<li><strong>${esc(label)}</strong>${account ? ` · ${esc(account)}` : ''}
        ${label !== id ? `<code>${esc(id)}</code>` : ''}
        <ul>${actions.map((name) => {
          const na = namedMap.get(name);
          return na
            ? `<li><strong>${esc(na.title)}</strong> <code>${esc(name)}</code></li>`
            : `<li><code>${esc(name)}</code></li>`;
        }).join('')}</ul></li>`;
    });
    return `<h3 class="st-h">Access</h3>
      <p class="st-sub">These are the actions you shared with ${esc(a.name)}.</p>
      <ul>${connections.join('')}</ul>
      <p class="st-rs">If an action runs other operations, it can use the permissions that account has at the provider.</p>
      <div class="st-grp">Change access</div>
      <p>Reconnect Loop from the agent. On the Loop consent screen, choose <strong>Change shared actions</strong>, select the actions to share, and approve. Approving without changes keeps the current actions.</p>
      <p class="st-rs">Turn off stops this agent’s access. Remove agent deletes its Loop key.</p>`;
  }
  const currentProfile = a.profile || 'all';
  const scoped = currentProfile !== 'all';
  const memory = a.memoryAccess || (a.canManage ? 'read_write' : 'read');
  const secrets = Array.isArray(p.data.secrets) ? p.data.secrets : [];
  const shared = new Set(Array.isArray(a.secrets) ? a.secrets : []);
  const hasCustomConns = Array.isArray(a.allowedConnections);
  const hasCustomSkills = Array.isArray(a.allowedSkills);
  const nConns = hasCustomConns ? a.allowedConnections.length : 0;
  const nSkills = hasCustomSkills ? a.allowedSkills.length : 0;
  const connSummary = !hasCustomConns
    ? 'Every connection (including ones added later)'
    : nConns === 0
      ? 'No connections'
      : `${nConns} ${nConns === 1 ? 'connection' : 'connections'}`;
  const skillSummary = !hasCustomSkills
    ? 'every skill (including ones added later)'
    : nSkills === 0
      ? 'no custom skills'
      : 'only the skills that you picked';
  const pickedText = `${connSummary}, and ${skillSummary}.`;
  const broadRights = [
    a.canManage ? 'manage connections' : '',
    !hasCustomConns ? 'use all current and future connections' : '',
    !hasCustomSkills ? 'use all current and future skills' : '',
  ].filter(Boolean);
  return `
    <h3 class="st-h">Access</h3>
    <p class="st-sub">What this agent can reach through Loop. Changes save as you go.</p>
    ${broadRights.length ? `
    <div class="st-grp">Review broad access</div>
    <div class="st-rules">
      ${rule(
        esc,
        'Broad rights active',
        `This agent can ${broadRights.join(', ')}.`,
        '<button type="button" class="btn sm" data-ap-memory-only>Limit to Memory only</button>',
      )}
    </div>` : ''}
    ${accountsGroup(p)}
    <div class="st-grp">Connections</div>
    <div class="st-rules">
      ${scoped ? rule(esc, 'Limited to a project', `It reaches only what is in ${profileLabelOf(p.data, currentProfile)}`, '<button type="button" class="btn sm" data-ap-unscope>Remove limit</button>') : ''}
      ${hasCustomConns || hasCustomSkills ? rule(esc, 'Selected items', pickedText, '<button type="button" class="btn sm" data-ap-reset-scope>Allow all + future</button>') : ''}
      ${rule(esc, 'Can manage connections', manageText(p), manageSwitch(a.canManage, 'data-ap-manage'))}
    </div>
    <div class="st-grp">Memory</div>
    <div class="st-rules">
      ${rule(esc, 'Memory', scoped ? `Recall and save memories in ${profileLabelOf(p.data, currentProfile)}` : 'Recall and save memories', seg(esc, 'memoryAccess', MEMORY_OPTIONS, memory, 'Memory'))}
    </div>
    <div class="st-grp">Vault items it may use</div>
    ${secrets.length ? `
      <div class="ap-secrets">
        ${secrets.map((s) => `
          <label class="ap-secret" ${s.description ? `title="${esc(s.description)}"` : ''}>
            <input type="checkbox" data-ap-secret value="${esc(s.key)}" ${shared.has(s.key) ? 'checked' : ''}>
            <span>${esc(/^capture_[0-9a-f]{32}$/.test(s.key) && s.description ? s.description : s.key)}</span>
          </label>`).join('')}
      </div>
      <p class="st-rs ap-after">It sees only the names. Loop fills in the value and hides it from replies.</p>` : `
      <p class="st-rs ap-after">No Vault items yet. Add them on the <a href="#vault" data-ap-close>Vault</a> page, then share them here.</p>`}`;
}

// One account for each app that has more than one sign-in. "Any account" reaches all of them.
function accountsGroup(p) {
  const { esc } = p.ctx;
  const a = p.row.agent;
  const choice = a.accountChoice && typeof a.accountChoice === 'object' ? a.accountChoice : {};
  const services = (p.services || []).filter((svc) => Array.isArray(svc.accounts) && svc.accounts.length > 1
    && Array.isArray(svc.agents) && svc.agents.some((x) => x.id === a.id));
  if (!services.length) return '';
  return `
    <div class="st-grp">Accounts</div>
    <div class="st-rules">
      ${services.map((svc) => {
        const ids = new Set(svc.accounts.map((acc) => acc.connectionId));
        const raw = choice[svc.key];
        const current = raw && ids.has(raw) ? raw : '*';
        const label = (id) => {
          const acc = svc.accounts.find((x) => x.connectionId === id);
          return acc ? (acc.label || acc.name) : '';
        };
        const desc = current === '*'
          ? `It can use all ${svc.accounts.length} accounts`
          : `It sees only ${label(current)}`;
        const opts = [...svc.accounts.map((acc) => [acc.connectionId, acc.label || acc.name]), ['*', 'Any account']];
        return rule(esc, svc.name, desc, `<select class="ap-select" data-ap-account="${esc(svc.key)}" aria-label="Account for ${esc(svc.name)}">${opts.map(([val, text]) => `<option value="${esc(val)}" ${val === current ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select>`);
      }).join('')}
    </div>`;
}

function connectPane(p) {
  const { esc } = p.ctx;
  const a = p.row.agent;
  if (a.hasToken === false && p.ctx.addAgent) {
    return `
    <h3 class="st-h">Connect</h3>
    <div class="st-rules ap-setup">
      ${rule(esc, 'No key yet', 'It gets one when you install it, or when somebody opens its link.', '<button type="button" class="btn sm fill" data-ap-finish>Finish setup</button>')}
    </div>`;
  }
  const scoped = Boolean(a.profile && a.profile !== 'all');
  const profileLabel = scoped ? profileLabelOf(p.data, a.profile) : '';
  const targetLabel = kindLabel(a.kind) === 'Other' ? 'the agent' : kindLabel(a.kind);
  const keyLine = [a.tokenHint ? String(a.tokenHint).replace('...', '…') : '', p.row.lastSeenAt ? `last used ${shortAgo(p.row.lastSeenAt)}` : 'not used yet'].filter(Boolean).join(' · ');
  let body;
  if (p.tokenError) body = `<p class="st-rs ap-after">${esc(p.tokenError)}</p>`;
  else if (!p.token) body = '<div class="st-wait ap-wait-sm" role="status"><div class="spin" aria-hidden="true"></div></div>';
  else body = snippetBlock(p, a.kind, p.token, p.row.name, profileLabel);
  return `
    <h3 class="st-h">Connect</h3>
    <p class="st-sub">${HOST_KINDS.includes(a.kind) ? `Use this agent’s existing access in ${esc(targetLabel)}.` : scoped
      ? `This connection is locked to ${esc(profileLabel)}. Paste this where ${esc(targetLabel)} lists its connections, then restart it.`
      : `Paste this where ${esc(targetLabel)} lists its connections, then restart it.`}</p>
    ${body}
    <div class="ap-key">
      <div class="st-rule-c"><div class="st-rt">Key</div><div class="st-rs">${esc(keyLine)}</div></div>
      <button type="button" class="btn sm" data-ap-rotate>Make a new key</button>
    </div>`;
}

function setupPane(p) {
  const { esc } = p.ctx;
  const { row } = p;
  const app = row.apps[0] || {};
  const signIn = row.kind === 'codex'
    ? 'It can sign in to Loop by itself: run codex mcp login loop.'
    : row.kind === 'claude-code'
      ? 'It can sign in to Loop by itself: in Claude Code open /mcp, pick loop, then Authenticate.'
      : 'It can sign in to Loop by itself from its own settings.';
  return `
    <h3 class="st-h">Set up</h3>
    <p class="st-sub">${esc(installState(row) || `${row.name} ${app.configuredIn ? 'has Loop in its settings' : 'has talked to Loop'} but has no key of its own yet.`)}</p>
    <div class="st-rules ap-setup">
      ${rule(esc, 'Give it a key', 'Then you choose which connections, memory and Vault items it can use.', '<button type="button" class="btn sm fill" data-ap-givekey>Give it a key</button>')}
    </div>
    <p class="st-rs ap-after">${esc(signIn)}</p>
    ${app.configuredIn ? `<p class="st-rs ap-after">Set up in <code class="inline-code">${esc(app.configuredIn.replace(/^\/Users\/[^/]+/, '~'))}</code></p>` : ''}`;
}

function bindActivityPaneEvents(p) {
  p.el.querySelector('[data-ap-retry-activity]')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    await loadAgentActivity(p);
    if (alive(p)) paintAgent(p);
  });
  p.el.querySelector('[data-ap-older]')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    p.actLimit += ACTIVITY_STEP;
    if (p.entries.length < p.actLimit && p.activityHasMore) await loadAgentActivity(p, { append: true });
    if (alive(p)) paintAgent(p);
  });
}

function bindAgent(p) {
  const { api, toast } = p.ctx;
  const { row } = p;
  const el = p.el;

  el.querySelectorAll('[data-ap-tab]').forEach((b) => b.addEventListener('click', () => showTab(p, b.dataset.apTab, true)));
  el.querySelector('.st-tabs')?.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const at = p.tabs.indexOf(p.tab);
    const n = p.tabs.length;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    showTab(p, p.tabs[next], true);
  });

  bindActivityPaneEvents(p);

  // Access: every change is saved right away; a failed save puts the old value back.
  const save = async (patch, focus) => {
    const a = row.agent;
    const before = {};
    for (const k of Object.keys(patch)) before[k] = a[k];
    Object.assign(a, patch);
    paintAgent(p, focus);
    try {
      const res = await api(`/api/agents/${encodeURIComponent(a.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (!alive(p)) return;
      if (res?.agent) Object.assign(a, res.agent);
      p.changed = true;
    } catch (err) {
      if (!alive(p)) return;
      Object.assign(a, before);
      toast(err.message, 'err');
      paintAgent(p, focus);
    }
  };
  el.querySelectorAll('[data-ap-field]').forEach((group) => {
    const field = group.dataset.apField;
    if (field === 'snippet') return;
    group.querySelectorAll('[data-val]').forEach((b) => b.addEventListener('click', () => {
      if (b.getAttribute('aria-pressed') === 'true') return;
      save({ [field]: b.dataset.val }, `[data-ap-field="${field}"] [data-val="${CSS.escape(b.dataset.val)}"]`);
    }));
  });
  el.querySelectorAll('[data-ap-select]').forEach((sel) => sel.addEventListener('change', () => {
    save({ [sel.dataset.apSelect]: sel.value }, `[data-ap-select="${sel.dataset.apSelect}"]`);
  }));
  el.querySelector('[data-ap-manage]')?.addEventListener('click', () => save({ canManage: !row.agent.canManage }, '[data-ap-manage]'));
  el.querySelectorAll('[data-ap-account]').forEach((sel) => sel.addEventListener('change', () => {
    const key = sel.dataset.apAccount;
    const accountChoice = { ...(row.agent.accountChoice || {}), [key]: sel.value };
    save({ accountChoice }, `[data-ap-account="${CSS.escape(key)}"]`);
  }));
  el.querySelector('[data-ap-unscope]')?.addEventListener('click', () => save({ profile: 'all' }));
  el.querySelector('[data-ap-reset-scope]')?.addEventListener('click', () => save({ allowedConnections: null, allowedSkills: null }));
  el.querySelector('[data-ap-memory-only]')?.addEventListener('click', () => save({ canManage: false, allowedConnections: [], allowedSkills: [] }));
  el.querySelectorAll('[data-ap-secret]').forEach((box) => box.addEventListener('change', () => {
    const picked = [...el.querySelectorAll('[data-ap-secret]:checked')].map((x) => x.value);
    save({ secrets: picked }, `[data-ap-secret][value="${CSS.escape(box.value)}"]`);
  }));

  if (p.tab === 'connect' && row.agent?.hasToken !== false) {
    if (!p.token && !p.tokenError && !p.tokenLoading) loadToken(p);
    if (p.token) bindSnippet(p, p.token, () => paintAgent(p));
  }
  el.querySelector('[data-ap-rotate]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const ok = await confirmDialog({
      title: `Make a new key for ${row.name}?`,
      message: 'The old key stops working right away.',
      confirmLabel: 'Rotate key',
      danger: true,
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      const res = await api(`/api/agents/${encodeURIComponent(row.agent.id)}/rotate`, { method: 'POST' });
      if (!alive(p)) return;
      if (res?.agent) Object.assign(row.agent, res.agent);
      p.token = res.token;
      p.tokenError = '';
      p.changed = true;
      toast('New key made. Paste the new setup into the agent.', 'ok');
      paintAgent(p, '[data-ap-copy]');
    } catch (err) {
      toast(err.message, 'err');
      if (alive(p)) paintAgent(p);
    }
  });

  el.querySelector('[data-ap-toggle]')?.addEventListener('click', () => save({ enabled: row.agent.enabled === false }, '[data-ap-toggle]'));
  el.querySelector('[data-ap-remove]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: `Remove ${row.name}?`,
      message: 'Its key stops working right away.',
      confirmLabel: 'Remove agent',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/agents/${encodeURIComponent(row.agent.id)}`, { method: 'DELETE' });
      if (!alive(p)) return;
      p.changed = true;
      toast(`${row.name} removed.`, 'ok');
      closeAgentPopup();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  el.querySelector('[data-ap-forget]')?.addEventListener('click', async () => {
    try {
      await api(`/api/clients/${encodeURIComponent(row.apps[0].key)}`, { method: 'DELETE' });
      if (!alive(p)) return;
      p.changed = true;
      toast(`${row.name} removed from the list.`, 'ok');
      closeAgentPopup();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  el.querySelector('[data-ap-givekey]')?.addEventListener('click', () => {
    const { ctx } = p;
    if (ctx.addAgent) ctx.addAgent({ name: row.name, kind: row.kind });
    else openConnectFlow(ctx, { name: row.name, kind: row.kind, rowId: row.id });
  });
  // What this panel changed is still to be drawn on Home when the next panel closes.
  const addAgent = (opts) => p.ctx.addAgent({ ...opts, changed: Boolean(p.changed || p.ctx.changed) });
  el.querySelector('[data-ap-finish]')?.addEventListener('click', () => addAgent({ agentId: row.agent.id, start: 'ready' }));
  el.querySelector('[data-ap-edit]')?.addEventListener('click', () => addAgent({ agentId: row.agent.id, start: 'edit' }));
}

function showTab(p, tab, focusTab = false) {
  if (!p.tabs.includes(tab)) return;
  p.tab = tab;
  paintAgent(p, focusTab ? `[data-ap-tab="${tab}"]` : null);
}

async function loadToken(p) {
  p.tokenLoading = true;
  try {
    const { token } = await p.ctx.api(`/api/agents/${encodeURIComponent(p.row.agent.id)}/token`);
    if (!alive(p)) return;
    p.token = token;
  } catch (err) {
    if (!alive(p)) return;
    p.tokenError = /no token/i.test(err.message) ? 'No key is stored for this agent. Make a new key to get its setup.' : err.message;
  } finally {
    p.tokenLoading = false;
  }
  if (alive(p) && p.tab === 'connect') paintAgent(p);
}

/* ---------- Connect an agent to one project (the project manager) ---------- */

export async function openConnectFlow(ctx, opts = {}) {
  const prefill = opts && typeof opts === 'object' ? opts : {};
  const hasAppPrefill = Boolean(prefill.kind || prefill.name || prefill.rowId);
  const p = mount(ctx, 'Add agent', true);
  p.kind = 'flow';
  p.flow = {
    step: hasAppPrefill ? 2 : 0,
    kind: prefill.kind || '',
    name: prefill.name || '',
    profile: prefill.profile || 'all',
    profileName: prefill.profileName || '',
    memoryAccess: 'read_write',
    canManage: null,
    installable: null,
    selectedTargets: new Set(),
    installing: false,
    installResults: null,
  };
  try {
    const [agentsData, installableData] = await Promise.all([
      ctx.api('/api/agents'),
      ctx.api('/api/agents/installable').catch(() => null),
    ]);
    p.data = agentsData;
    if (installableData && Array.isArray(installableData.agents)) {
      p.flow.installable = installableData.agents;
      p.flow.paired = installableData.paired;
      for (const a of installableData.agents) {
        if (a.installed && !a.connected) p.flow.selectedTargets.add(a.id);
      }
    }
  } catch (err) {
    if (!alive(p)) return;
    inner(p).innerHTML = `<div class="ap-msg"><p>${ctx.esc(err.message)}</p></div>`;
    return;
  }
  if (!alive(p)) return;
  const localMode = !isPersonalWorkspace(p.data, p.ctx) && Array.isArray(p.flow.installable);
  if (!p.flow.method) {
    p.flow.method = localMode ? 'local' : 'device';
  }
  paintFlow(p, p.flow.step === 2 ? '#ap-name' : (localMode ? '[data-ap-install-now]' : '[data-ap-copy]'));
}

// Local workspaces connect installed Mac agents directly by writing each agent's Bearer token
// straight into its config file. Hosted workspaces (and remote/SSH terminals) use the Device Code
// CLI (`curl .../connect.mjs | node`), avoiding fragile browser-to-localhost OAuth redirects.
function quickMethodsFor(p) {
  const localMode = !isPersonalWorkspace(p.data, p.ctx) && Array.isArray(p.flow.installable);
  if (localMode) {
    return [['local', 'This Mac'], ['device', 'Terminal'], ['prompt', 'Prompt'], ['install', 'npx add-mcp']];
  }
  return [['device', 'Terminal'], ['prompt', 'Prompt'], ['install', 'npx add-mcp']];
}

function quickTexts(p) {
  const f = p.flow;
  const base = resolveGatewayEndpoint(p.data.endpoint, p.data.port);
  const scoped = Boolean(f.profile && f.profile !== 'all');
  const endpoint = scoped ? `${base}${base.includes('?') ? '&' : '?'}profile=${encodeURIComponent(f.profile)}` : base;
  const origin = new URL(base, location.origin).origin;
  // Prompt and npx sign in with OAuth, which picks the workspace at sign-in: show the same short address
  // as the landing page. A project scope keeps the workspace address.
  const signInUrl = !scoped && /\/w\/[0-9a-f]{64}\/mcp$/.test(new URL(base, location.origin).pathname) ? `${origin}/mcp` : endpoint;
  const connectUrl = `${origin}/connect.mjs`;
  const guide = new URL('/agent-setup.md', location.origin).href;
  const deviceArgs = scoped ? ` - --profile ${JSON.stringify(f.profile)}` : '';
  return {
    device: `curl -fsSL ${connectUrl} | node${deviceArgs}`,
    prompt: `Fetch ${guide} in full and follow it to connect to ${signInUrl}. If your web tool summarizes pages, use curl.`,
    install: `npx add-mcp ${scoped ? `"${signInUrl}"` : signInUrl} --name loop -g`,
  };
}

function quickBody(p, scoped, profileLabel) {
  const { esc } = p.ctx;
  const f = p.flow;
  const methods = quickMethodsFor(p);
  const method = methods.some(([id]) => id === f.method) ? f.method : methods[0][0];
  f.method = method;

  if (method === 'local') {
    const all = Array.isArray(f.installable) ? f.installable : [];
    const installed = all.filter((a) => a.installed);
    const list = installed.length > 0 ? installed : all;
    const resultById = new Map((f.installResults || []).map((r) => [r.id, r]));
    const n = f.selectedTargets.size;
    const done = n > 0 && [...f.selectedTargets].every((id) => resultById.get(id)?.ok);
    return `
      <div class="ap-tabs">${seg(esc, 'method', methods, method, 'How to connect')}</div>
      <div class="ap-inst-list" role="group" aria-label="Installed agents on this Mac">
        ${list.map((a) => {
          const checked = f.selectedTargets.has(a.id);
          const res = resultById.get(a.id);
          const state = res?.ok || (!res && a.connected) ? ['is-ok', 'Set up'] : res ? ['is-no', 'Failed'] : a.configuredWithoutToken ? ['is-warn', 'Needs key'] : null;
          return `
            <label class="ap-inst-row">
              ${agentMark(a, esc, 'ap-inst-ic')}
              <span class="ap-inst-main">
                <span class="ap-inst-l"><span class="ap-inst-name">${esc(a.name)}</span>${state ? `<span class="ap-inst-state ${state[0]}">${state[1]}</span>` : ''}</span>
                ${res && !res.ok
                  ? `<span class="ap-inst-err">${esc(res.error || 'Could not update its settings.')}</span>`
                  : `<span class="ap-inst-path" title="${esc(a.configPath)}">${esc(a.configPath)}</span>`}
              </span>
              <input type="checkbox" data-ap-inst-target value="${esc(a.id)}" ${checked ? 'checked' : ''} ${f.installing ? 'disabled' : ''}>
            </label>`;
        }).join('')}
      </div>
      <div class="ap-inst-foot">
        <p class="st-rs">${scoped ? `Locked to <strong>${esc(profileLabel)}</strong>. ` : ''}${f.paired ? 'You approve each agent in Loop Cloud. ' : ''}Loop saves a key in each settings file. Restart open agents.</p>
        <div class="ap-inst-acts">
          ${f.cloudSignIn ? `<a class="btn fill" href="${esc(f.cloudSignIn)}" target="_blank" rel="noopener noreferrer">Approve in Loop Cloud</a>` : ''}
          ${done
            ? '<button type="button" class="btn fill" data-ap-close data-ap-done>Done</button>'
            : `<button type="button" class="btn fill" data-ap-install-now ${f.installing || n === 0 ? 'disabled' : ''}>${f.installing ? 'Connecting…' : n === 0 ? 'Pick an agent' : `Connect ${n} ${n === 1 ? 'agent' : 'agents'}`}</button>`}
        </div>
      </div>`;
  }

  const status = f.copied
    ? `<div class="ap-waitrow ${f.connected ? 'is-ok' : ''}" role="status"><span class="ap-pulse" aria-hidden="true"></span><span>${f.connected ? `${esc(f.name)} is connected` : 'Waiting for your agent to sign in…'}</span></div>`
    : '';
  const hint = method === 'device'
    ? 'Run it in any terminal, also over SSH. You approve it in Loop with a short code.'
    : method === 'install'
      ? 'Run it in your terminal and pick your agents. Restart them, then sign in to Loop when asked.'
      : 'Paste it into any agent. It reads the setup guide and asks you to sign in.';
  return `
    <div class="ap-tabs">${seg(esc, 'method', methods, method, 'How to connect')}</div>
    <div class="ap-code">
      <pre>${esc(quickTexts(p)[method])}</pre>
      <button type="button" class="ap-copy" data-ap-copy>Copy</button>
    </div>
    ${status}
    <p class="st-rs ap-warn">${scoped ? `Locked to <strong>${esc(profileLabel)}</strong>. ` : ''}${esc(hint)}</p>`;
}

function quickCopy(p) {
  const f = p.flow;
  const method = f.method === 'install' || f.method === 'device' ? f.method : 'prompt';
  p.ctx.copyText(
    quickTexts(p)[method],
    method === 'prompt' ? 'Copied. Paste it into your agent.' : 'Copied. Run it in your terminal.',
  );
  if (f.copied) return;
  f.copied = true;
  paintFlow(p, '[data-ap-copy]');
  waitForNewAgent(p);
}

// After Copy, watch for an agent that wasn't there when the popup opened and has checked in.
function waitForNewAgent(p) {
  const known = new Set((p.data.agents || []).map((a) => a.id));
  const tick = async () => {
    if (!alive(p) || p.flow.connected) return;
    try {
      const data = await p.ctx.api('/api/agents');
      if (!alive(p)) return;
      const fresh = (data.agents || []).find((a) => !known.has(a.id) && a.lastSeenAt);
      if (fresh) {
        p.changed = true;
        Object.assign(p.flow, { connected: true, agentId: fresh.id, name: fresh.name || 'Your agent' });
        paintFlow(p, '[data-ap-open]');
        return;
      }
    } catch {
      /* try again on the next tick */
    }
    if (alive(p)) p.timer = setTimeout(tick, POLL_MS);
  };
  p.timer = setTimeout(tick, POLL_MS);
}

function paintFlow(p, focus = null) {
  const { esc } = p.ctx;
  const f = p.flow;
  const scoped = Boolean(f.profile && f.profile !== 'all');
  const profileLabel = profileLabelOf(p.data, f.profile, f.profileName);
  let head;
  let body;
  let foot;
  if (f.step === 0) {
    body = quickBody(p, scoped, profileLabel);
    head = f.connected
      ? { title: `${f.name} is connected`, sub: 'It signed in to Loop. Open it to fine-tune what it can reach.' }
      : {
          title: scoped ? `Connect to ${profileLabel}` : 'Add agent',
          sub: f.method === 'local' ? 'Loop adds itself to the agents that you pick.' : 'Copy one of these into your agent.',
        };
    foot = f.connected
      ? `<span class="ap-grow"></span><button type="button" class="btn sm ghost" data-ap-close>Done</button><button type="button" class="btn sm fill" data-ap-open>Open ${esc(f.name)}</button>`
      : '';
  } else if (f.step === 2) {
    const profileOpts = profileOptionsFrom(p.data, f.profile || 'all');
    head = { title: `What can ${f.name || 'it'} reach?`, sub: 'Good defaults are picked. You can change any of this later.' };
    body = `
      <label class="st-field ap-name-f"><span class="st-lbl">Name</span><input type="text" id="ap-name" maxlength="80" required value="${esc(f.name)}" autocomplete="off"></label>
      <div class="st-rules ap-flow-rules">
        ${scoped ? rule(esc, 'Project', 'Limited to this project', profilePicker(esc, 'profile', profileOpts, f.profile || 'all')) : ''}
        ${rule(esc, 'Can manage connections', manageText(p), manageSwitch(canManageIn(f), 'data-ap-flow-manage'))}
        ${rule(esc, 'Memory', scoped ? `Recall and save memories in ${profileLabel}` : 'Recall and save memories', seg(esc, 'memoryAccess', MEMORY_OPTIONS, f.memoryAccess, 'Memory'))}
        ${rule(esc, 'Vault items', scoped ? `Scoped to ${profileLabel}. Share items later under Access.` : 'None to start. Share them later under Access.', '')}
      </div>`;
    foot = `<span class="ap-grow"></span><button type="button" class="btn sm ghost" data-ap-close>Cancel</button><button type="button" class="btn sm fill" data-ap-create>Connect ${esc(f.name || 'agent')}</button>`;
  } else {
    const label = kindLabel(f.kind) === 'Other' ? f.name : kindLabel(f.kind);
    head = f.connected
      ? { title: `${f.name} is connected`, sub: 'It checked in with its new key. Open it to fine-tune what it can reach.' }
      : {
          title: `Add Loop to ${f.name}`,
          sub: scoped
            ? `This connection is locked to ${profileLabel}. Paste it into ${label}, then restart it.`
            : `Paste this into ${label}, then restart it. This updates as soon as it checks in.`,
        };
    body = `
      <div class="ap-waitrow ${f.connected ? 'is-ok' : ''}" role="status">
        <span class="ap-pulse" aria-hidden="true"></span>
        <span>${f.connected ? `${esc(f.name)} is connected` : `Waiting for ${esc(f.name)} to connect…`}</span>
      </div>
      ${f.connected ? '' : snippetBlock(p, f.kind, f.token, f.name, scoped ? profileLabel : '')}`;
    foot = f.connected
      ? `<span class="ap-grow"></span><button type="button" class="btn sm ghost" data-ap-close>Done</button><button type="button" class="btn sm fill" data-ap-open>Open ${esc(f.name)}</button>`
      : '<span class="ap-grow"></span><button type="button" class="btn sm ghost" data-ap-close>Done for now</button>';
  }
  inner(p).innerHTML = `
    <div class="ap-flow-in">
      <div class="ap-flow-top">
        <h2 class="ap-flow-t" id="ap-title">${esc(head.title)}</h2>
        <p class="st-sub">${esc(head.sub)}</p>
      </div>
      <div class="ap-flow-body">${body}</div>
      ${foot ? `<div class="ap-flow-foot">${foot}</div>` : ''}
    </div>`;
  const sheet = p.el.querySelector('.st-sheet');
  sheet.setAttribute('aria-labelledby', 'ap-title');
  sheet.classList.toggle('ap-quick', f.step === 0);
  bindFlow(p);
  if (focus) p.el.querySelector(focus)?.focus({ preventScroll: true });
}

function bindFlow(p) {
  const { api, toast } = p.ctx;
  const f = p.flow;
  const el = p.el;
  if (f.step === 0) {
    el.querySelectorAll('[data-ap-field="method"] [data-val]').forEach((b) => b.addEventListener('click', () => {
      f.method = b.dataset.val;
      paintFlow(p, `[data-ap-field="method"] [data-val="${CSS.escape(b.dataset.val)}"]`);
    }));
    el.querySelector('[data-ap-copy]')?.addEventListener('click', () => quickCopy(p));
    el.querySelectorAll('[data-ap-inst-target]').forEach((box) => box.addEventListener('change', () => {
      if (box.checked) f.selectedTargets.add(box.value);
      else f.selectedTargets.delete(box.value);
      paintFlow(p, `[data-ap-inst-target][value="${CSS.escape(box.value)}"]`);
    }));
    el.querySelector('[data-ap-install-now]')?.addEventListener('click', async () => {
      const targets = [...f.selectedTargets];
      if (!targets.length || f.installing) return;
      f.installing = true;
      paintFlow(p);
      try {
        let res = await api('/api/agents/install', {
          method: 'POST',
          body: JSON.stringify({ targets, profile: f.profile || 'all' }),
        });
        if (!alive(p)) return;
        if (res?.verificationUrl) {
          f.cloudSignIn = res.verificationUrl;
          paintFlow(p);
          const id = res.requestId;
          let polls = 0;
          const MAX_INSTALL_POLLS = 60;
          do {
            polls += 1;
            if (polls > MAX_INSTALL_POLLS) {
              f.cloudSignIn = null;
              throw new Error('Sign-in check timed out. Finish sign-in in your browser and try again.');
            }
            await new Promise(resolve => setTimeout(resolve, (res.interval || 2) * 1000));
            if (!alive(p)) return;
            res = await api('/api/local/connect/agent-requests/' + encodeURIComponent(id), { method: 'POST', body: '{}' });
          } while (res.pending);
          f.cloudSignIn = null;
        }
        f.installing = false;
        f.installResults = Array.isArray(res?.results) ? res.results : [];
        const okCount = f.installResults.filter((r) => r.ok).length;
        if (okCount > 0) {
          p.changed = true;
          const refreshed = await api('/api/agents/installable').catch(() => null);
          if (alive(p) && Array.isArray(refreshed?.agents)) f.installable = refreshed.agents;
          toast(`Connected ${okCount} ${okCount === 1 ? 'agent' : 'agents'}. Restart open agents to use Loop.`, 'ok');
        } else {
          toast(f.installResults[0]?.error || 'Could not update agent configs.', 'err');
        }
        paintFlow(p, '[data-ap-done], [data-ap-install-now]');
      } catch (err) {
        if (!alive(p)) return;
        f.installing = false;
        toast(err?.message || 'Could not connect agents.', 'err');
        paintFlow(p, '[data-ap-install-now]');
      }
    });
  }
  const nameInput = el.querySelector('#ap-name');
  nameInput?.addEventListener('input', () => {
    f.name = nameInput.value;
    const btn = el.querySelector('[data-ap-create]');
    if (btn) btn.textContent = `Connect ${f.name.trim() || 'agent'}`;
  });
  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      el.querySelector('[data-ap-create]')?.click();
    }
  });
  el.querySelectorAll('[data-ap-field]').forEach((group) => {
    const field = group.dataset.apField;
    if (field === 'snippet' || f.step === 0) return;
    group.querySelectorAll('[data-val]').forEach((b) => b.addEventListener('click', () => {
      f[field] = b.dataset.val;
      paintFlow(p, `[data-ap-field="${field}"] [data-val="${CSS.escape(b.dataset.val)}"]`);
    }));
  });
  el.querySelectorAll('[data-ap-select]').forEach((sel) => sel.addEventListener('change', () => {
    const field = sel.dataset.apSelect;
    f[field] = sel.value;
    paintFlow(p, `[data-ap-select="${CSS.escape(field)}"]`);
  }));
  el.querySelector('[data-ap-flow-manage]')?.addEventListener('click', () => {
    f.canManage = !canManageIn(f);
    paintFlow(p, '[data-ap-flow-manage]');
  });
  el.querySelector('[data-ap-create]')?.addEventListener('click', async (e) => {
    const name = String(f.name || '').trim();
    if (!name) {
      toast('Give the agent a name.', 'err');
      nameInput?.focus();
      return;
    }
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    try {
      const res = await api('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name, kind: f.kind || 'other', profile: f.profile, mode: 'default', memoryAccess: f.memoryAccess, canManage: canManageIn(f), secrets: [] }),
      });
      if (!alive(p)) return;
      p.changed = true;
      f.name = res.agent?.name || name;
      f.agentId = res.agent?.id;
      f.token = res.token;
      f.step = 3;
      paintFlow(p, '[data-ap-copy]');
      waitForAgent(p);
    } catch (err) {
      toast(err.message, 'err');
      if (!alive(p)) return;
      btn.disabled = false;
      btn.textContent = `Connect ${name}`;
    }
  });
  if (f.step === 3 && !f.connected) bindSnippet(p, f.token, () => paintFlow(p));
  el.querySelector('[data-ap-open]')?.addEventListener('click', () => {
    const { ctx } = p;
    const id = f.agentId;
    p.changed = false; // the agent popup redraws the page when it closes
    closeAgentPopup({ immediate: true, quiet: true });
    openAgentPopup({ ...ctx, onClose: () => ctx.onClose?.(true) }, id, 'access');
  });
}

// Step 3 watches for the new key's first use, so the popup can say "connected" on its own.
function waitForAgent(p) {
  const tick = async () => {
    if (!alive(p) || p.flow.connected) return;
    try {
      const data = await p.ctx.api('/api/agents');
      if (!alive(p)) return;
      const agent = (data.agents || []).find((a) => a.id === p.flow.agentId);
      const seen = agent?.lastSeenAt || (data.connected || []).some((app) => app.agentId === p.flow.agentId);
      if (seen) {
        p.flow.connected = true;
        paintFlow(p, '[data-ap-open]');
        return;
      }
    } catch {
      /* try again on the next tick */
    }
    if (alive(p)) p.timer = setTimeout(tick, POLL_MS);
  };
  p.timer = setTimeout(tick, POLL_MS);
}
