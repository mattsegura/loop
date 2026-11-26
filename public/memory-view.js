// Library, Memories (#knowledge): the graph. Clicking a memory zooms in on it and opens its card.
// The side menu (like Home's) narrows the map to one kind of memory or one tag.
// The map can expand to the whole window, behind the side menu, which stays where it is. On narrow
// windows the side menu is a menu under the pill at the map's top right.
// Hovering a memory in the graph (or selecting it) shows a Delete button beside it.

import { BRAIN_NAME, brainCounts, brainRow, wireBrainRows } from './brain-parts.js';
import { linkedIds, mountMemoryGraph } from './memory-graph.js';
import {
  MAX_GATHER, createLibraryMap, findRowsHtml, groupClass, isMemoryId, itemBodyHtml, itemMetaHtml, layerOfId, linkFormHtml,
  linksHtml, openGatherDialog, openHashOf,
} from './library-map.js';
import { agentMark } from './agents-view.js';

const SCOPE_LABELS = { global: 'About you', preference: 'Preferences', project: 'Work notes', fact: 'Facts' };
// The branches Loop defines itself, whatever the memories are: the map's centre ring, and the
// pins an agent asked for that wait for the owner.
const BUILT_IN = { startup: 'Startup context', approval: 'Approvals' };
const waitingPin = (m) => Boolean(m.pinned) && m.pinnedBy === 'agent';

// The picked memory's card: docked on the graph's right, or a sheet along the bottom when narrow.
const CARD_WIDTH = 300;
const CARD_SHEET_BELOW = 560;
// Where the side menu shows beside the map (the same breakpoint as every tab's rail).
const RAIL_FROM = 980;
// What stays clear on the expanded map: the pill along the top, the nav along the bottom.
const PILL_ROOM = 60;
const NAV_ROOM = 92;
// How long the map takes to expand or collapse, and what sits on it to fade out and in.
const WIDE_MS = 360;

const ICONS = {
  trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>',
  chevLeft: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  chevRight: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  locate: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  gather: '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 2h5L11 4.5V12H3.5zM8.5 2v2.5H11M5.5 7h3.5M5.5 9.5h3.5"/></svg>',
  clear: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>',
  chevDown: '<svg class="mem-pill-chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg>',
  expand: '<svg class="mem-pill-out" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 2H12v3.5M12 2L8.2 5.8M5.5 12H2V8.5M2 12l3.8-3.8"/></svg>',
  collapse: '<svg class="mem-pill-in" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.8 5.5H8.5V2.2M8.5 5.5l3.7-3.7M2.2 8.500h3.300v3.300M5.500 8.500l-3.700 3.700"/></svg>',
  loopMark: '<svg width="20" height="12" viewBox="0 0 36 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.2 15.2C6.8 15.2 4 12.9 4 10s2.8-5.2 6.2-5.2c3.2 0 5.4 2.4 7.8 5.2 2.4 2.8 4.6 5.2 7.8 5.2 3.4 0 6.2-2.3 6.2-5.2s-2.8-5.2-6.2-5.2c-3.2 0-5.4 2.4-7.8 5.2-2.4 2.8-4.6 5.2-7.8 5.2Z"/></svg>',
  brain: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5a3 3 0 0 0-5.6-1.5A3 3 0 0 0 4 8a3 3 0 0 0 .5 5.3A3.5 3.5 0 0 0 9 18.5 3 3 0 0 0 12 20m0-15a3 3 0 0 1 5.6-1.5A3 3 0 0 1 20 8a3 3 0 0 1-.5 5.3 3.5 3.5 0 0 1-4.5 5.2A3 3 0 0 1 12 20m0-15v15"/></svg>',
};

let activeGraphCtrl = null;
let activeKeydownHandler = null;
let activeResizeObserver = null;
// The pill's filter menu stays open across live redraws, and closes when Memory is left.
let filterMenuOpen = false;

export function destroyMemoryView({ redraw = false } = {}) {
  if (!redraw) filterMenuOpen = false;
  if (activeKeydownHandler) {
    document.removeEventListener('keydown', activeKeydownHandler);
    activeKeydownHandler = null;
  }
  if (activeResizeObserver) {
    activeResizeObserver.disconnect();
    activeResizeObserver = null;
  }
  if (activeGraphCtrl) {
    activeGraphCtrl.destroy();
    activeGraphCtrl = null;
  }
}

function memoryAgo(iso) {
  const diff = Date.now() - Date.parse(iso || '');
  if (Number.isNaN(diff)) return '';
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Who a memory came from and what they did, from what the store records on save:
// an agent's own name, "Owner" for the dashboard, or "Owner (imported from X)" for a sync.
function activityOf(m) {
  const by = String(m.writtenBy || 'Owner');
  const source = String(m.source || '');
  const edited = Date.parse(m.updatedAt) - Date.parse(m.createdAt) > 1000;
  const synced = by.match(/^Owner \(imported from (.+)\)$/);
  if (synced) return { who: synced[1], verb: 'synced' };
  if (by === 'Owner (import)') {
    return { who: source && source !== 'Import' && source !== 'Manual' ? source : 'You', verb: 'imported' };
  }
  if (by === 'Owner') return { who: 'You', verb: edited ? 'edited' : 'added' };
  return { who: by, verb: edited ? 'updated' : 'saved' };
}

export async function renderMemory(root, ui) {
  const {
    esc,
    api,
    toast,
    copyText,
    renderErrorState,
    isCurrent,
    params,
    uiState,
    specialistEnabled = false,
    onRetry,
    pageTop,
    profileSwitcher,
    syncTopChrome,
    activeProfile: uiActiveProfile,
    profileName: uiProfileName,
  } = ui;

  destroyMemoryView({ redraw: Boolean(document.querySelector('.mem-stage')) });

  const initialFocusParam = String(params?.get('focus') || '').trim();
  const initialPanelParam = String(params?.get('panel') || '').trim();

  const resolveRequestedProfile = () => {
    if (typeof uiActiveProfile === 'function') return uiActiveProfile() || 'all';
    if (typeof uiActiveProfile === 'string' && uiActiveProfile) return uiActiveProfile;
    return uiState.activeProfile || 'all';
  };

  const fetchMemory = (profileId) => {
    const url = profileId && profileId !== 'all'
      ? `/api/memory?profile=${encodeURIComponent(profileId)}`
      : '/api/memory';
    return api(url);
  };

  let data;
  try {
    const requestedProfile = resolveRequestedProfile();
    data = await fetchMemory(requestedProfile);
    if (!isCurrent()) return;
    const initialRecords = profileSwitcher
      ? profileSwitcher.records(data)
      : (Array.isArray(data?.profileRecords) ? data.profileRecords : []);
    const normalized = profileSwitcher ? profileSwitcher.normalize(initialRecords) : requestedProfile;
    if (requestedProfile !== 'all' && normalized === 'all') {
      data = await fetchMemory('all');
    }
  } catch (err) {
    if (!isCurrent()) return;
    renderErrorState(root, err, onRetry);
    return;
  }
  if (!isCurrent()) return;

  let profileRecords = [];
  let memories = [];
  let graph = { nodes: [], edges: [], conflicts: [], sources: [], stats: {} };
  let config = { mode: 'local', externalConnectionId: '' };
  let externalStatus = null;
  let selectableConnections = [];
  // Tidy: conflicts, grouped duplicate/update clusters, temporary notes, and restorable set-aside memories.
  let tidy = { suggestions: [], clusters: [], temporary: [], replaced: [] };

  function applyData(nextData) {
    profileRecords = profileSwitcher
      ? profileSwitcher.records(nextData)
      : (Array.isArray(nextData?.profileRecords) ? nextData.profileRecords : []);
    profileSwitcher?.normalize(profileRecords);
    syncTopChrome?.(profileRecords);
    memories = Array.isArray(nextData?.memories) ? nextData.memories : [];
    graph = nextData?.graph || { nodes: [], edges: [], conflicts: [], sources: [], stats: {} };
    config = nextData?.config || { mode: 'local', externalConnectionId: '' };
    externalStatus = nextData?.externalStatus || null;
    selectableConnections = Array.isArray(nextData?.selectableConnections) ? nextData.selectableConnections : [];
    tidy = {
      suggestions: Array.isArray(nextData?.tidy?.suggestions) ? nextData.tidy.suggestions : [],
      clusters: Array.isArray(nextData?.tidy?.clusters) ? nextData.tidy.clusters : [],
      temporary: Array.isArray(nextData?.tidy?.temporary) ? nextData.tidy.temporary : [],
      replaced: Array.isArray(nextData?.tidy?.replaced) ? nextData.tidy.replaced : [],
    };
    if (isMemoryId(uiState.memorySelectedId) && !memories.some((m) => m.id === uiState.memorySelectedId)) {
      uiState.memorySelectedId = null;
    }
  }

  applyData(data);

  let partCounts = {};
  const activeProfile = () => (profileSwitcher?.active
    ? profileSwitcher.active(profileRecords)
    : resolveRequestedProfile());
  const activeProfileName = () => {
    const id = activeProfile();
    if (profileSwitcher?.name) return profileSwitcher.name(id, profileRecords);
    if (typeof uiProfileName === 'function') return uiProfileName(id, profileRecords);
    if (typeof uiProfileName === 'string' && uiProfileName) return uiProfileName;
    if (!id || id === 'all') return 'All';
    return profileRecords.find((r) => r && r.id === id)?.name || id;
  };

  // What the map shows beside memories: saved items, files, tasks, and who wrote them (library-map.js).
  const lib = createLibraryMap({ api, esc, profile: () => activeProfile() });
  const mapGraph = () => lib.merge(graph);
  const memoryOn = (id) => memories.find((m) => m.id === id) || null;
  // An item on the map by id: a memory, or an item of a layer.
  const itemOn = (id) => memoryOn(id) || lib.node(id);
  // What the card of an item got from the server ({ item, links, refs }), until the page loads again.
  const itemDetails = new Map();
  // The item whose card shows the form for a new link.
  let linkFormFor = null;

  const scopeOf = (m) => (SCOPE_LABELS[m.scope] ? m.scope : 'global');
  const tagsOf = (m) => (Array.isArray(m.tags) ? m.tags.filter((t) => typeof t === 'string' && t) : []);

  // The side menu's choice: one kind, one tag, or everything (null).
  function currentFilter() {
    const f = uiState.memoryFilter;
    if (f?.kind === 'scope' && SCOPE_LABELS[f.value]) return f;
    if (f?.kind === 'built' && BUILT_IN[f.value]) return f;
    if (f?.kind === 'tag' && memories.some((m) => tagsOf(m).includes(f.value))) return f;
    uiState.memoryFilter = null;
    return null;
  }
  function matchesSearch(m) {
    const q = String(uiState.memorySearch || '').trim().toLowerCase();
    if (!q) return true;
    const hay = [
      m.content || '',
      m.key || '',
      m.project || '',
      m.writtenBy || '',
      ...(Array.isArray(m.tags) ? m.tags : []),
    ].join(' ').toLowerCase();
    return q.split(/\s+/).filter(Boolean).every((tok) => hay.includes(tok));
  }
  function matches(m, f) {
    if (!matchesSearch(m)) return false;
    if (!f) return true;
    if (f.kind === 'built') return f.value === 'approval' ? waitingPin(m) : Boolean(m.pinned) && !waitingPin(m);
    return f.kind === 'scope' ? scopeOf(m) === f.value : tagsOf(m).includes(f.value);
  }
  // Memory shows the graph only. The page has no List and Graph switch and no Add memory button:
  // agents add memories, and an empty Memory shows its own Add memory button.
  function isListView() {
    uiState.memoryView = 'graph';
    return false;
  }

  // Review opens the panel on the graph's right side: in the side menu while items wait for you,
  // and in the pill on the map.
  const PANEL_ICONS = {
    review: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13l2.5-7.5A2 2 0 0 1 7.4 4h9.2a2 2 0 0 1 1.9 1.5L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/></svg>',
  };
  function panelJumpsHtml() {
    const n = tidyActionCount();
    return `
        ${n > 0 ? `<button type="button" class="hm-jump mem-panel-jump" data-mem-panel="review" aria-controls="mem-review" aria-pressed="${reviewOpen()}" title="${esc(`Review ${n} ${n === 1 ? 'item' : 'items'}`)}">${PANEL_ICONS.review}<span class="mem-jump-l">Review</span><span class="hm-jump-n mem-panel-n">${esc(n)}</span></button>` : ''}`;
  }
  function wirePanelJumps(scope) {
    scope?.querySelectorAll('[data-mem-panel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setReviewOpen(!reviewOpen());
      });
    });
  }

  function filterCounts() {
    const counts = Object.fromEntries(Object.keys(SCOPE_LABELS).map((k) => [k, 0]));
    const tagCounts = new Map();
    for (const m of memories) {
      counts[scopeOf(m)] += 1;
      for (const t of new Set(tagsOf(m))) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }
    const tags = [...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const built = Object.fromEntries(Object.keys(BUILT_IN).map((k) => [k, memories.filter((m) => matches(m, { kind: 'built', value: k })).length]));
    return { counts, tags, built };
  }
  // One row of the side menu, or of the pill's menu.
  // Each kind's dot is the colour it has on the map, so the menu doubles as the map's key.
  function filterRowHtml(kind, value, label, n, mark = '') {
      const f = currentFilter();
      const on = kind === 'all' ? !f : f?.kind === kind && f.value === value;
      return `<button type="button" class="hm-jump ${n === 0 ? 'is-empty' : ''}" ${mark ? `data-mark="${mark}"` : ''} data-mem-filter="${kind}" data-mem-value="${esc(value)}" aria-current="${on}"><span class="mem-jump-l">${esc(label)}</span><span class="hm-jump-n">${esc(n)}</span></button>`;
  }
  const filterName = (f) => (!f ? 'All memories' : f.kind === 'tag' ? `#${f.value}` : f.kind === 'built' ? BUILT_IN[f.value] : SCOPE_LABELS[f.value]);

  function railHtml() {
    const { counts, tags, built } = filterCounts();
    const item = filterRowHtml;
    // The page's name, then the rows in the part that scrolls: every tag is in the list.
    return `
      <nav class="hm-rail mem-rail" aria-label="Parts of ${BRAIN_NAME}, memory kinds and tags">
        <div class="hm-rail-k">${BRAIN_NAME}</div>
        <div class="hm-rail-list">
          ${filterRowHtml('all', '', 'Memories', memories.length, 'all')}
          ${['skills', 'saved', 'files', 'schedules', 'tasks'].map((p) => brainRow(p, 'memories', partCounts[p])).join('')}
          <div class="hm-rail-k brain-rail-k">In Memories</div>
          ${Object.entries(BUILT_IN).map(([k, label]) => item('built', k, label, built[k], k)).join('')}
          ${panelJumpsHtml()}
          ${Object.entries(SCOPE_LABELS).map(([k, label]) => item('scope', k, label, counts[k], k)).join('')}
          ${tags.length ? `
            ${tags.map(([t, n]) => item('tag', t, `#${t}`, n)).join('')}` : ''}
        </div>
      </nav>`;
  }

  // The line at the top: shown only when Memory is off or kept elsewhere. Loop's own memory shows no count.
  function headSub() {
    if (config.mode === 'off') return 'Turned off, so each agent uses its own memory';
    if (config.mode === 'external') {
      const ext = selectableConnections.find((c) => c.id === config.externalConnectionId);
      const name = ext?.name || externalStatus?.name || config.externalConnectionId || 'your external memory service';
      return `Kept in ${esc(name)}, with pinned startup context from Loop`;
    }
    return '';
  }

  // The side panel is Review: it shows when there is something to settle, archive, or undo.
  function tidyPairs() {
    const ids = new Set(memories.map((m) => m.id));
    return tidy.suggestions.filter((t) => ids.has(t.a) && ids.has(t.b));
  }
  function tidyConflicts() {
    return tidyPairs().filter((t) => t.kind === 'conflict');
  }
  function tidyClusters() {
    const ids = new Set(memories.map((m) => m.id));
    if (Array.isArray(tidy.clusters) && tidy.clusters.length > 0) {
      return tidy.clusters
        .map((cl) => ({ ...cl, ids: (cl.ids || []).filter((id) => ids.has(id)) }))
        .filter((cl) => cl.ids.length >= 2);
    }
    return tidyPairs()
      .filter((t) => t.kind !== 'conflict')
      .map((t) => ({ id: t.id, kind: t.kind, reason: t.reason, keep: t.keep, ids: [t.a, t.b] }));
  }
  function tidyTemporary() {
    const ids = new Set(memories.map((m) => m.id));
    return (tidy.temporary || []).filter((m) => ids.has(m.id));
  }
  function tidyActionCount() {
    return tidyConflicts().length + tidyClusters().length + tidyTemporary().length;
  }
  // Ordered tidy items to cycle through one at a time with Yes / No.
  function tidyTargets() {
    const items = [];
    for (const t of tidyConflicts()) {
      const key = `conflict:${[t.a, t.b].sort().join(':')}`;
      items.push({ key, kind: 'conflict', focusId: t.keep || t.a, memberIds: [t.a, t.b], item: t });
    }
    for (const cl of tidyClusters()) {
      const key = `cluster:${cl.id || [...cl.ids].sort().join(':')}`;
      items.push({ key, kind: 'cluster', focusId: cl.keep || cl.ids[0], memberIds: cl.ids, item: cl });
    }
    for (const m of tidyTemporary()) {
      items.push({ key: `temp:${m.id}`, kind: 'temporary', focusId: m.id, memberIds: [m.id], item: m });
    }
    return items;
  }
  function tidyTargetIndex(targets) {
    if (!targets.length) return -1;
    if (uiState.memoryTidyKey) {
      const byKey = targets.findIndex((t) => t.key === uiState.memoryTidyKey);
      if (byKey >= 0) {
        uiState.memoryTidyIndex = byKey;
        return byKey;
      }
    }
    const raw = Number(uiState.memoryTidyIndex);
    const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(targets.length - 1, raw)) : 0;
    uiState.memoryTidyIndex = clamped;
    uiState.memoryTidyKey = targets[clamped].key;
    return clamped;
  }
  function chosenKeepId(entry) {
    const picked = uiState.memoryTidyKeepChoice?.[entry.key];
    if (picked && entry.memberIds.includes(picked)) return picked;
    return entry.focusId;
  }
  function describeTidyEntry(entry, byId, overrideKeepId = null) {
    if (entry.kind === 'conflict') {
      const t = entry.item;
      const keepId = (overrideKeepId && entry.memberIds.includes(overrideKeepId))
        ? overrideKeepId
        : chosenKeepId(entry);
      const otherId = t.a === keepId ? t.b : t.a;
      const primary = byId.get(keepId);
      const other = byId.get(otherId);
      if (!primary || !other) return null;
      return {
        kindLabel: t.pinnedInvolved ? 'Disagrees · Pinned' : 'Disagrees',
        warn: true,
        question: 'Keep this one and set the other aside?',
        reason: t.reason || '',
        primary,
        others: [other],
        suggestedId: t.keep,
        yesSub: 'Keep this',
        noSub: 'Keep both',
        yesPayload: { a: t.a, b: t.b, keep: keepId },
        noPayload: { a: t.a, b: t.b, keep: 'both' },
        yesToast: 'Kept it. The other one is set aside.',
        noToast: 'Kept both.',
      };
    }
    if (entry.kind === 'cluster') {
      const cl = entry.item;
      const keepId = (overrideKeepId && entry.memberIds.includes(overrideKeepId))
        ? overrideKeepId
        : chosenKeepId(entry);
      const primary = byId.get(keepId);
      const others = cl.ids.filter((id) => id !== keepId).map((id) => byId.get(id)).filter(Boolean);
      if (!primary || others.length === 0) return null;
      const isUpdate = cl.kind === 'update';
      const n = others.length;
      return {
        kindLabel: isUpdate ? 'Updated memory' : 'Duplicate',
        warn: false,
        question: isUpdate
          ? (n === 1 ? 'Keep this version and set the older one aside?' : `Keep this version and set aside ${n} older copies?`)
          : (n === 1 ? 'Keep this one and set the duplicate aside?' : `Keep this one and set aside ${n} duplicates?`),
        reason: cl.reason || '',
        primary,
        others,
        suggestedId: cl.keep,
        yesSub: n === 1 ? 'Keep this' : `Set ${n} aside`,
        noSub: 'Keep all',
        yesPayload: { ids: cl.ids, keep: keepId },
        noPayload: { ids: cl.ids, keep: 'all' },
        yesToast: `Kept it. ${n} ${n === 1 ? 'other is' : 'others are'} set aside.`,
        noToast: 'Kept all of them.',
      };
    }
    const m = byId.get(entry.item.id) || entry.item;
    if (!m) return null;
    return {
      kindLabel: 'Temporary note',
      warn: false,
      question: 'Set aside this temporary note?',
      reason: 'Looks like a scratch or test note. Agents stop seeing it, and you can undo anytime.',
      primary: m,
      others: [],
      suggestedId: m.id,
      yesSub: 'Set aside',
      noSub: 'Keep it',
      yesPayload: { dropIds: [m.id] },
      noPayload: { keepIds: [m.id] },
      yesToast: 'Set aside.',
      noToast: 'Kept it.',
    };
  }
  function reviewOpen() {
    const hasItems = tidyActionCount() > 0 || (Boolean(uiState.memoryReviewKeepOpen) && tidy.replaced.length > 0);
    return Boolean(hasItems && !uiState.memoryReviewDismissed);
  }
  // The map fills the window (its own choice, kept on this device), or sits in the page's column.
  function wideOn() {
    if (typeof uiState.memoryWide === 'boolean') return uiState.memoryWide;
    try { uiState.memoryWide = localStorage.getItem('loop.memory.view') === 'wide'; } catch { uiState.memoryWide = false; }
    return uiState.memoryWide;
  }
  // The pill holds the filter whenever the side menu is not there.
  const pillFilters = () => window.innerWidth < RAIL_FROM;
  const menuOpen = () => filterMenuOpen && pillFilters();
  const mapSelectedId = () => (menuOpen() ? null : uiState.memorySelectedId);

  // One pill at the map's top right, always in the same corner: the filter (when the side menu is
  // away), Review, Add (expanded) and expand or collapse.
  function pillHtml() {
    const f = currentFilter();
    const n = tidyActionCount();
    return `<div class="mem-pill" role="group" aria-label="Map controls" data-filter="${f ? (f.kind === 'tag' ? 'tag' : esc(f.value)) : 'all'}">
      <button type="button" class="mem-pill-b mem-pill-f" data-mem-menu-toggle aria-controls="mem-menu" aria-expanded="${menuOpen()}"><i class="mem-pill-dot" aria-hidden="true"></i><span class="mem-pill-l">${esc(filterName(f))}</span><span class="mem-pill-n">${esc(f ? matchIdsOf(f).size : memories.length)}</span>${ICONS.chevDown}</button>
      <button type="button" class="mem-pill-b mem-pill-x" data-mem-pill-clear aria-label="Show all memories" title="Show all memories" ${f ? '' : 'hidden'}>${ICONS.clear}</button>
      <span class="mem-pill-r mem-pill-fr" aria-hidden="true"></span>
      ${n > 0 ? `<button type="button" class="mem-pill-b" data-mem-review-open aria-controls="mem-review" aria-expanded="${reviewOpen()}" aria-label="${esc(`Review ${n} ${n === 1 ? 'item' : 'items'}`)}" title="${esc(`Review ${n} ${n === 1 ? 'item' : 'items'}`)}"><span class="mem-pill-t">Review</span><span class="mem-feed-btn-n">${esc(n)}</span></button>
      <span class="mem-pill-r" aria-hidden="true"></span>` : ''}
      <button type="button" class="mem-pill-b mem-pill-g" data-mem-gather aria-label="Gather these items into one note" title="Put the items that show on one page" ${gatherIds().length > 1 ? '' : 'hidden'}>${ICONS.gather}<span class="mem-pill-t">Gather</span></button>
      <span class="mem-pill-r mem-pill-gr" aria-hidden="true" ${gatherIds().length > 1 ? '' : 'hidden'}></span>
      <button type="button" class="mem-pill-b mem-pill-i" data-mem-wide aria-pressed="${wideOn()}" aria-label="${wideOn() ? 'Collapse the map' : 'Expand the map'}" title="${wideOn() ? 'Collapse the map (F)' : 'Expand the map (F)'}">${ICONS.expand}${ICONS.collapse}</button>
    </div>`;
  }

  // The side menu's choices, under the pill. Tags are chips here, so all of them fit.
  function menuHtml() {
    const f = currentFilter();
    const { counts, tags, built } = filterCounts();
    return `<div class="mem-menu ${menuOpen() ? 'is-open' : ''}" id="mem-menu" role="group" aria-label="Memory kinds and tags" ${menuOpen() ? '' : 'inert'}>
      <div class="hm-rail-k">Memories</div>
      ${filterRowHtml('all', '', 'All memories', memories.length, 'all')}
      ${Object.entries(BUILT_IN).map(([k, label]) => filterRowHtml('built', k, label, built[k], k)).join('')}
      ${Object.entries(SCOPE_LABELS).map(([k, label]) => filterRowHtml('scope', k, label, counts[k], k)).join('')}
      ${tags.length ? `
        <div class="hm-rail-k mem-rail-k2">Tags</div>
        <div class="mem-menu-tags">${tags.map(([t, n]) => `<button type="button" class="mem-mchip" data-mem-filter="tag" data-mem-value="${esc(t)}" aria-pressed="${f?.kind === 'tag' && f.value === t}">#${esc(t)} <span>${esc(n)}</span></button>`).join('')}</div>` : ''}
    </div>`;
  }

  // Arrow keys move between items waiting for review; returns true when it moved.
  function stepTidy(delta) {
    const targets = tidyTargets();
    if (targets.length <= 1) return false;
    const cur = tidyTargetIndex(targets);
    const next = (cur + delta + targets.length) % targets.length;
    uiState.memoryTidyIndex = next;
    uiState.memoryTidyKey = targets[next].key;
    refreshReview();
    root.querySelector('.mem-review .mem-tidy-deck.is-current')?.scrollIntoView({ block: 'nearest' });
    syncTidyGraphFocus();
    return true;
  }

  function reviewHtml() {
    const byId = new Map(memories.map((m) => [m.id, m]));
    const targets = tidyTargets();
    const replaced = tidy.replaced;
    const idx = tidyTargetIndex(targets);
    const open = reviewOpen();

    // Every item waiting for review is its own row.
    const decks = targets.map((entry, i) => {
      const info = describeTidyEntry(entry, byId);
      if (!info) return '';
      const m = info.primary;
      const who = activityOf(m).who;
      const at = m.updatedAt || m.createdAt;
      const text = String(m.content || '').trim();
      const why = info.reason || (entry.kind === 'cluster'
        ? (entry.item.kind === 'update' ? 'A newer version says the same thing.' : 'These say the same thing.')
        : '');
      const hint = [`${info.kindLabel}.`, info.question, why].filter(Boolean).join(' ');
      const current = i === idx;
      return `
            <div class="mem-tidy-deck ${current ? 'is-current' : ''}" data-tidy-key="${esc(entry.key)}" title="${esc(hint)}">
              <span class="mem-act-h">
                ${agentMark({ name: who }, esc, 'mem-act-av')}
                <b class="mem-act-who">${esc(who)}</b>
                ${at ? `<time datetime="${esc(at)}" title="${esc(new Date(at).toLocaleString())}">${esc(memoryAgo(at))}</time>` : ''}
              </span>
              <span class="mem-act-q">${esc(text.length > 1200 ? `${text.slice(0, 1200)}…` : text)}</span>
              ${(why || info.question) ? `<span class="mem-tidy-reason">${esc(why || info.question)}</span>` : ''}
              <div class="mem-tidy-foot">
                <span class="mem-tidy-op ${info.warn ? 'is-warn' : ''}" title="${esc(hint)}">${esc(info.kindLabel || 'Review')}</span>
                <span class="mem-tidy-yn" role="group" aria-label="Review decision">
                  <button type="button" class="mem-tidy-yn-btn is-no" data-tidy-answer="no" aria-label="Decline: ${esc(info.noSub)}" title="Decline: ${esc(info.noSub)}${current ? ' (N)' : ''}">${ICONS.x}</button>
                  <button type="button" class="mem-tidy-yn-btn is-yes" data-tidy-answer="yes" aria-label="Confirm: ${esc(info.yesSub)}" title="Confirm: ${esc(info.yesSub)}${current ? ' (Y)' : ''}">${ICONS.check}</button>
                </span>
              </div>
            </div>`;
    }).join('');

    return `
      <section class="mem-review ${open ? 'is-open' : ''}" id="mem-review" aria-label="Review memories" ${open ? '' : 'inert aria-hidden="true"'}>
          ${decks ? decks : `
            <div class="mem-tidy-done">
              <span class="mem-tidy-done-ic" aria-hidden="true">${ICONS.check}</span>
              <span class="mem-tidy-done-t">All clear. Nothing left to tidy.</span>
              <button type="button" class="mem-tidy-done-x" data-mem-review-close>Hide</button>
            </div>`}
          ${replaced.length > 0 ? `
            <details class="mem-tidy-rep-drawer" ${uiState.memoryTidyReplacedOpen ? 'open' : ''}>
              <summary class="mem-tidy-rep-sum">
                <span>Set aside</span>
                <span class="mem-tidy-rep-n">${esc(replaced.length)}</span>
              </summary>
              <ul class="mem-tidy-rep-list">
                ${replaced.map((m) => `
                  <li class="mem-tidy-rep-item">
                    <span class="mem-tidy-rep-q">${esc(m.content)}</span>
                    <span class="mem-tidy-rep-m">${esc(memoryAgo(m.supersededAt))}</span>
                    <button type="button" class="mem-tidy-undo" data-tidy-undo="${esc(m.id)}">Bring back</button>
                  </li>`).join('')}
              </ul>
            </details>` : ''}
      </section>`;
  }

  function panelHtml() {
    const n = tidyActionCount();
    const open = reviewOpen();
    return `
      <aside class="mem-feed ${open ? 'is-open' : ''}" id="mem-feed" aria-label="Review" ${open ? '' : 'inert aria-hidden="true"'}>
        <div class="mem-feed-head">
          <div class="mem-feed-ht"><h2 class="mem-feed-t">Review</h2>${n > 0 ? `<span class="mem-feed-sub">${esc(n)}</span>` : ''}</div>
          <button type="button" class="mem-feed-x" data-mem-feed-close aria-label="Close panel">${ICONS.x}</button>
        </div>
        <div class="mem-feed-scroll">
        ${reviewHtml()}
        </div>
      </aside>`;
  }

  // What the graph area shows instead of nodes, or '' to draw the graph.
  function graphNoticeHtml() {
    const prof = activeProfile();
    const profName = activeProfileName();
    if (config.mode === 'off') {
      return `
        <span class="mem-empty-ic">${ICONS.brain}</span>
        <h2 class="mem-empty-title">Loop Memory is off</h2>
        <p class="d">Each agent is using its own memory.${memories.length > 0 ? ` Your ${esc(memories.length)} saved ${memories.length === 1 ? 'memory is' : 'memories are'} kept on disk.` : ''}</p>
        <div class="mem-off-acts"><button type="button" class="btn fill" id="btn-mem-turn-on">Turn it on</button></div>`;
    }
    if (memories.length === 0) {
      if (prof !== 'all') {
        return `
          <span class="mem-empty-ic">${ICONS.brain}</span>
          <h2 class="mem-empty-title">No memories in ${esc(profName)} yet</h2>
          <p class="d">When an agent connected to ${esc(profName)} saves a memory, it lands here.</p>
          <div class="mem-off-acts"><button type="button" class="btn fill" data-mem-empty-add>Add memory</button></div>`;
      }
      return `
        <span class="mem-empty-ic">${ICONS.brain}</span>
        <h2 class="mem-empty-title">Nothing remembered yet</h2>
        <p class="d">Tell any agent “remember that…” or add one yourself.</p>
        <div class="mem-off-acts"><button type="button" class="btn fill" data-mem-empty-add>Add memory</button></div>`;
    }
    return '';
  }

  let syncNodeActs = () => {};

  // Picking a memory zooms in on it together with the memories linked to it, in the part of the
  // graph its card leaves open; letting go of it zooms back out to the whole graph.
  // The graph's width not covered by the open Review card.
  function graphOpenWidth() {
    const shell = root.querySelector('.mem-brain-shell');
    const w = shell?.clientWidth || 0;
    const panel = reviewOpen()
      ? (root.querySelector('.mem-side')?.offsetWidth || 0)
      : menuOpen() && !menuIsSheet() ? (root.querySelector('.mem-menu')?.offsetWidth || 0) : 0;
    // On a phone the panel covers the whole graph; then the graph keeps its full width behind it.
    return panel && w - panel - 26 >= 200 ? w - panel - 26 : w;
  }

  // How much of the graph's right side the open panel covers (what fitting the graph avoids).
  function graphInset() {
    const w = root.querySelector('.mem-brain-shell')?.clientWidth || 0;
    return w ? w - graphOpenWidth() : 0;
  }

  // The expanded map runs behind the side menu; its memories stay to the right of it.
  function railInset() {
    if (!wideOn() || pillFilters()) return 0;
    const rail = root.querySelector('.mem-rail')?.getBoundingClientRect();
    if (!rail?.width) return 0;
    const edge = Math.max(0, Math.round(rail.right));
    root.querySelector('.mem-brain-shell')?.style.setProperty('--rail-r', `${edge}px`);
    return edge + 24;
  }

  function cardIsSheet() {
    return graphOpenWidth() < CARD_SHEET_BELOW;
  }

  function menuIsSheet() {
    return (root.querySelector('.mem-brain-shell')?.clientWidth || 0) < CARD_SHEET_BELOW;
  }

  // The room the graph keeps clear: an open panel, and on the expanded map the pill and the nav.
  function graphInsets() {
    const wide = wideOn();
    const sheet = menuOpen() && menuIsSheet() ? root.querySelector('.mem-menu')?.offsetHeight || 0 : 0;
    const room = (root.querySelector('.mem-brain-shell')?.clientHeight || 0) - sheet >= 220;
    return { insetLeft: railInset(), insetRight: graphInset(), insetTop: wide ? PILL_ROOM : 24, insetBottom: sheet && room ? sheet : wide ? NAV_ROOM : 0 };
  }

  function focusSelected(id) {
    if (!activeGraphCtrl || !id) return;
    const shell = root.querySelector('.mem-brain-shell');
    const acts = root.querySelector('#mem-node-acts');
    const below = wideOn() ? NAV_ROOM : 0;
    const insetLeft = railInset();
    if (reviewOpen() || (menuOpen() && !menuIsSheet())) {
      activeGraphCtrl.focusNode(id, { insetLeft, insetTop: 40, insetBottom: Math.max(12, below), insetRight: graphInset() });
    } else if (cardIsSheet()) {
      const sheet = Math.min(acts?.offsetHeight || 180, Math.round((shell?.clientHeight || 360) * 0.5));
      activeGraphCtrl.focusNode(id, { insetTop: 48, insetBottom: sheet + 6 });
    } else {
      activeGraphCtrl.focusNode(id, { insetLeft, insetTop: 40, insetBottom: Math.max(16, below), insetRight: CARD_WIDTH + 20 });
    }
  }

  function select(id, { fromGraph = false } = {}) {
    const had = uiState.memorySelectedId;
    // Picking a memory on the map closes an open menu (a click on empty paper does too).
    if (menuOpen()) {
      uiState.memorySelectedId = id;
      setMenuOpen(false, { refocus: false });
    }
    // Picking one while Review is open shows its card in Review's place.
    if (id && reviewOpen()) {
      closeReview();
      syncPanels({ skipFocus: true });
    }
    uiState.memorySelectedId = id;
    syncNodeActs();
    if (activeGraphCtrl) {
      if (!fromGraph) activeGraphCtrl.update({ selectedId: id });
      if (id) focusSelected(id);
      else if (had) activeGraphCtrl.fitView(true);
    }
  }

  // Open a memory directly at its location on the map (closing any side panel if open).
  function focusMemoryOnMap(id) {
    if (!id) return;
    const m = memories.find((x) => x.id === id);
    if (!m) {
      focusLayerItem(id);
      return;
    }
    const f = currentFilter();
    if (f && !matches(m, f)) {
      uiState.memoryFilter = null;
      applyFilter();
      repaintRail();
    }
    const hadPanel = reviewOpen() || menuOpen();
    filterMenuOpen = false;
    closeReview();
    if (hadPanel) syncPanels({ skipFocus: true });
    select(id);
  }

  // What a search or a tag keeps of the layers. A kind of memory keeps none of them.
  function layerMatches(n, f) {
    const q = String(uiState.memorySearch || '').trim().toLowerCase();
    if (q) {
      const hay = [n.title || n.label || '', n.content || '', n.writtenBy || '', ...(n.tags || [])].join(' ').toLowerCase();
      if (!q.split(/\s+/).filter(Boolean).every((tok) => hay.includes(tok))) return false;
    }
    if (!f) return true;
    return f.kind === 'tag' && (n.tags || []).includes(f.value);
  }
  // The items that the side menu's choice and the search keep, or null when they keep everything.
  function matchIdsOf(f) {
    if (!f && !String(uiState.memorySearch || '').trim()) return null;
    return new Set([
      ...memories.filter((m) => matches(m, f)).map((m) => m.id),
      ...lib.nodes().filter((n) => layerMatches(n, f)).map((n) => n.id),
    ]);
  }

  // Gather: the items that a search or a tag keeps, on one page.
  function gatherIds() {
    const ids = matchIdsOf(currentFilter());
    return ids ? [...ids].filter((id) => layerOfId(id) !== 'people') : [];
  }
  function openGather(ids, title) {
    openGatherDialog({
      ids: ids.filter((id) => layerOfId(id) !== 'people').slice(0, MAX_GATHER),
      title,
      api,
      esc,
      toast,
      copyText,
      profile: () => activeProfile(),
      modal: wideOn(),
      // The new note shows on the map, picked, with the lines to what it was made from.
      onSaved: (item) => {
        if (!item?.id) return;
        lib.set('saved', true);
        uiState.memoryFilter = null;
        uiState.memorySearch = '';
        uiState.memorySelectedId = item.id;
        uiState.memoryReviewDismissed = true;
        onRetry?.();
      },
    });
  }

  // The control that turns the layers on, redrawn in place. The button you are on stays yours.
  function syncLayerControl() {
    const old = root.querySelector('.lib-layers');
    if (!old) return;
    const held = old.contains(document.activeElement) ? document.activeElement.dataset.libLayer : '';
    const tmp = document.createElement('div');
    tmp.innerHTML = lib.controlHtml();
    old.replaceWith(tmp.firstElementChild);
    if (held) root.querySelector(`.lib-layers [data-lib-layer="${held}"]`)?.focus({ preventScroll: true });
  }

  // Gets the layers and puts them on the map in place, so the memories keep their places.
  async function loadLayers({ fit = false } = {}) {
    const fresh = await lib.load();
    if (!isCurrent()) return;
    syncLayerControl();
    // A picked item that the layers do not have (its layer went off, or it was deleted) lets go.
    const sel = uiState.memorySelectedId;
    const gone = Boolean(sel && !isMemoryId(sel) && !lib.node(sel));
    if (gone) uiState.memorySelectedId = null;
    if ((!fresh && !gone) || !activeGraphCtrl) return;
    activeGraphCtrl.update({ graph: mapGraph(), matchIds: matchIdsOf(currentFilter()), selectedId: mapSelectedId() });
    syncPill();
    syncNodeActs();
    if (reviewOpen() || menuOpen()) return;
    if (uiState.memorySelectedId) focusSelected(uiState.memorySelectedId);
    else if (fit) activeGraphCtrl.fitView(true);
  }

  function toggleLayer(id) {
    lib.set(id, !lib.has(id));
    syncLayerControl();
    loadLayers({ fit: true });
  }

  // An item of a layer, picked from a link: its layer comes on when it is off. An item that the
  // map does not show (the layer is full) opens in its own part of Library.
  async function focusLayerItem(id) {
    const layer = layerOfId(id);
    if (!layer) return;
    if (!lib.node(id)) {
      if (!lib.has(layer)) lib.set(layer, true);
      await loadLayers();
      if (!isCurrent()) return;
    }
    const node = lib.node(id);
    if (!node) {
      const hash = openHashOf({ id, kind: layer === 'saved' ? 'saved' : layer === 'files' ? 'file' : layer === 'tasks' ? 'task' : '' });
      if (hash) location.hash = hash;
      return;
    }
    const kept = matchIdsOf(currentFilter());
    if (kept && !kept.has(id)) {
      uiState.memoryFilter = null;
      uiState.memorySearch = '';
      const search = root.querySelector('#mem-search');
      if (search) search.value = '';
      applyFilter();
      repaintRail();
    }
    const hadPanel = reviewOpen() || menuOpen();
    filterMenuOpen = false;
    closeReview();
    if (hadPanel) syncPanels({ skipFocus: true });
    select(id);
  }

  function closeReview() {
    uiState.memoryReviewDismissed = true;
    uiState.memoryReviewKeepOpen = false;
  }

  function syncFeedEnd() {
    const list = root.querySelector('.mem-feed-scroll');
    if (list) list.classList.toggle('is-end', list.scrollTop + list.clientHeight >= list.scrollHeight - 4);
  }

  function refreshReview() {
    const panel = root.querySelector('.mem-feed');
    if (!panel) return;
    const top = panel.querySelector('.mem-feed-scroll')?.scrollTop || 0;
    panel.outerHTML = panelHtml();
    const list = root.querySelector('.mem-feed-scroll');
    if (list) list.scrollTop = top;
    wirePanel();
    wireReview();
    syncPanels({ skipFocus: true });
    syncFeedEnd();
  }

  function syncTidyGraphFocus() {
    if (!activeGraphCtrl || !reviewOpen()) return;
    if (graphOpenWidth() < 220) return;
    const targets = tidyTargets();
    const idx = tidyTargetIndex(targets);
    if (idx < 0) return;
    const focusId = chosenKeepId(targets[idx]);
    if (!focusId || !memories.some((m) => m.id === focusId)) return;
    uiState.memorySelectedId = focusId;
    activeGraphCtrl.update({ selectedId: focusId });
    focusSelected(focusId);
  }

  function syncPanels({ skipFocus = false } = {}) {
    const open = reviewOpen();
    const panel = root.querySelector('.mem-feed');
    const review = root.querySelector('.mem-review');
    const revBtn = root.querySelector('[data-mem-review-open]');

    panel?.classList.toggle('is-open', open);
    panel?.toggleAttribute('inert', !open);
    if (open) panel?.removeAttribute('aria-hidden'); else panel?.setAttribute('aria-hidden', 'true');

    review?.classList.toggle('is-open', open);
    review?.toggleAttribute('inert', !open);
    if (open) review?.removeAttribute('aria-hidden'); else review?.setAttribute('aria-hidden', 'true');

    root.querySelector('.mem-brain-shell')?.classList.toggle('feed-open', open && Boolean(panel));
    syncMenu();
    revBtn?.setAttribute('aria-expanded', String(open));
    root.querySelector('[data-mem-panel="review"]')?.setAttribute('aria-pressed', String(open));

    if (!skipFocus) {
      if (open) {
        syncFeedEnd();
        root.querySelector('[data-mem-feed-close]')?.focus({ preventScroll: true });
      } else {
        revBtn?.focus({ preventScroll: true });
      }
    }
    syncNodeActs();
    syncInsets();
    if (open) syncTidyGraphFocus();
    else if (mapSelectedId()) focusSelected(uiState.memorySelectedId);
  }

  function wirePill() {
    root.querySelector('[data-mem-review-open]')?.addEventListener('click', () => setReviewOpen(!reviewOpen()));
    root.querySelector('[data-mem-menu-toggle]')?.addEventListener('click', () => setMenuOpen(!menuOpen()));
    root.querySelector('[data-mem-pill-clear]')?.addEventListener('click', () => {
      pickFilter('all', '');
      root.querySelector('[data-mem-menu-toggle]')?.focus({ preventScroll: true });
    });
    root.querySelector('[data-mem-wide]')?.addEventListener('click', () => setWide(!wideOn()));
    root.querySelector('[data-mem-gather]')?.addEventListener('click', () => {
      const f = currentFilter();
      openGather(gatherIds(), String(uiState.memorySearch || '').trim() || (f ? filterName(f).replace(/^#/, '') : ''));
    });
  }

  // The pill's words and states, in place (so the button you clicked keeps the keyboard).
  function syncPill() {
    const pill = root.querySelector('.mem-pill');
    if (!pill) return;
    const f = currentFilter();
    const wide = wideOn();
    pill.dataset.filter = f ? (f.kind === 'tag' ? 'tag' : f.value) : 'all';
    pill.querySelector('.mem-pill-l').textContent = filterName(f);
    pill.querySelector('.mem-pill-n').textContent = String(f ? matchIdsOf(f).size : memories.length);
    pill.querySelector('.mem-pill-x').hidden = !f;
    const canGather = gatherIds().length > 1;
    pill.querySelectorAll('.mem-pill-g, .mem-pill-gr').forEach((el) => { el.hidden = !canGather; });
    const w = pill.querySelector('[data-mem-wide]');
    w.setAttribute('aria-pressed', String(wide));
    w.setAttribute('aria-label', wide ? 'Collapse the map' : 'Expand the map');
    w.title = wide ? 'Collapse the map (F)' : 'Expand the map (F)';
    const back = root.querySelector('#mem-back span');
    if (back) back.textContent = filterName(f);
  }

  function syncMenu() {
    const menu = root.querySelector('.mem-menu');
    if (!menu) return;
    const open = menuOpen();
    menu.classList.toggle('is-sheet', menuIsSheet());
    menu.classList.toggle('is-open', open);
    menu.toggleAttribute('inert', !open);
    root.querySelector('[data-mem-menu-toggle]')?.setAttribute('aria-expanded', String(open));
    if (!open) activeGraphCtrl?.update({ previewIds: null, selectedId: mapSelectedId() });
  }

  // Only one of the menu, Review, and the memory card shows at a time.
  function setMenuOpen(open, { refocus = true } = {}) {
    filterMenuOpen = open;
    if (open) closeReview();
    syncPanels({ skipFocus: true });
    // The menu picks from the whole map, so the map steps out of a focused memory while it is open.
    const sel = uiState.memorySelectedId;
    if (sel && activeGraphCtrl) {
      if (open) {
        activeGraphCtrl.update({ selectedId: null });
        activeGraphCtrl.fitView(true);
      }
      else focusSelected(sel);
    }
    if (!refocus) return;
    if (open) root.querySelector('.mem-menu [aria-current="true"], .mem-menu [aria-pressed="true"]')?.focus({ preventScroll: true });
    else root.querySelector('[data-mem-menu-toggle]')?.focus({ preventScroll: true });
  }

  // Tells the graph the room to keep clear. While the map expands or collapses, setWide does that
  // itself, frame by frame.
  function syncInsets() {
    if (!wideMove) activeGraphCtrl?.update(graphInsets());
  }

  // The map on its way between its place in the page and the whole window: { insets }, the room
  // the graph keeps clear this frame.
  let wideMove = null;

  // Grows the map from its place in the page to the whole window, or back.
  function setWide(on) {
    const shell = root.querySelector('.mem-brain-shell');
    if (!shell || !root.querySelector('#mem-graph-canvas') || on === wideOn()) return;
    const from = shell.getBoundingClientRect();
    const animated = Boolean(shell.animate) && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The whole map moves in step with its box. A picked memory or Review keeps its own camera.
    const glide = animated && activeGraphCtrl && !uiState.memorySelectedId && !reviewOpen() ? { insets: wideMove?.insets || graphInsets() } : null;
    uiState.memoryWide = on;
    try { localStorage.setItem('loop.memory.view', on ? 'wide' : 'column'); } catch { /* per-viewer nicety only */ }
    filterMenuOpen = false;
    shell.getAnimations?.().forEach((a) => a.cancel());
    const fromCorner = getComputedStyle(shell).borderTopLeftRadius;
    shell.classList.remove('is-moving');
    shell.classList.toggle('is-wide', on);
    const to = shell.getBoundingClientRect();
    wideMove = glide;
    syncPill();
    syncPanels({ skipFocus: true });
    if (!glide && !uiState.memorySelectedId) activeGraphCtrl?.fitView(true);
    if (!animated) return;
    const roomFrom = glide?.insets;
    const roomTo = glide && graphInsets();
    const at = (r, corner) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, borderRadius: corner });
    const toCorner = getComputedStyle(shell).borderTopLeftRadius;
    shell.classList.add('is-moving');
    const move = { duration: WIDE_MS, easing: 'cubic-bezier(.2, .8, .2, 1)' };
    const grow = shell.animate([at(from, fromCorner), at(to, toCorner)], move);
    // Each frame the graph gets the room that goes with the box's size in that frame, so the
    // memories travel with the box and never run ahead of it or jump.
    const follow = () => {
      if (!glide || wideMove !== glide) return;
      const done = grow.playState === 'finished';
      const p = done ? 1 : grow.effect?.getComputedTiming().progress ?? 0;
      glide.insets = Object.fromEntries(Object.keys(roomTo).map((k) => [k, roomFrom[k] + (roomTo[k] - roomFrom[k]) * p]));
      activeGraphCtrl?.glide(glide.insets, p);
      if (done) wideMove = null;
      else requestAnimationFrame(follow);
    };
    follow();
    grow.onfinish = () => {
      shell.classList.remove('is-moving');
      follow();
      syncInsets();
    };
    holdPaper(shell, from, to, move);
  }

  // The Loop title, side menu and profile stay exactly as they are while the map expands or
  // collapses. The paper behind them (app.css) keeps its place in the window while the map moves, so
  // the map's edge uncovers it or covers it again and no memory ever shows through them. It moves by
  // its margins, which the browser lays out in the same frame as the map's box; a transform can run
  // a frame ahead of the box and flicker. On the way back the map's outline stays away until its
  // edge is clear of the side menu.
  let paperMoves = [];
  function holdPaper(shell, from, to, move) {
    paperMoves.forEach((a) => a.cancel());
    paperMoves = [];
    if (window.innerWidth < RAIL_FROM) return;
    const stay = (margin, a, b, pseudoElement) => {
      const anim = shell.animate([{ [margin]: `${-a}px` }, { [margin]: `${-b}px` }], { ...move, pseudoElement });
      if (anim.effect?.pseudoElement === pseudoElement) paperMoves.push(anim);
      else anim.cancel();
    };
    stay('marginLeft', from.left, to.left, '::before');
    stay('marginTop', from.top, to.top, '::after');
    if (wideOn()) return;
    const line = getComputedStyle(shell).borderTopColor;
    paperMoves.push(shell.animate([{ borderColor: 'transparent' }, { borderColor: 'transparent', offset: 0.4 }, { borderColor: line }], { duration: WIDE_MS }));
  }

  // A row or chip: that kind or tag, or everything again when it is already the choice.
  function pickFilter(kind, value) {
    const cur = currentFilter();
    const same = cur && cur.kind === kind && cur.value === value;
    uiState.memoryFilter = kind === 'all' || same ? null : { kind, value };
    if (!reviewOpen()) uiState.memorySelectedId = null;
    activeGraphCtrl?.update({ previewIds: null });
    if (menuOpen() && menuIsSheet()) setMenuOpen(false);
    applyFilter();
    if (!uiState.memorySelectedId) activeGraphCtrl?.fitView(true);
  }

  // A row under the pointer (or reached with the keyboard) shows its memories on the map first.
  function wireFilters(scope) {
    if (!scope) return;
    const rowOf = (e) => e.target.closest?.('[data-mem-filter]');
    const preview = (row) => {
      if (!activeGraphCtrl) return;
      const kind = row?.dataset.memFilter;
      const cur = currentFilter();
      const f = kind && kind !== 'all' ? { kind, value: row.dataset.memValue } : null;
      const same = f && cur && cur.kind === f.kind && cur.value === f.value;
      activeGraphCtrl.update({ previewIds: !kind || same ? null : f ? matchIdsOf(f) : cur ? new Set(memories.map((m) => m.id)) : null });
    };
    scope.addEventListener('click', (e) => {
      const row = rowOf(e);
      if (row) pickFilter(row.dataset.memFilter, row.dataset.memValue);
    });
    scope.addEventListener('pointerover', (e) => { if (e.pointerType === 'mouse') preview(rowOf(e)); });
    scope.addEventListener('pointerleave', () => preview(null));
    scope.addEventListener('focusin', (e) => { const row = rowOf(e); if (row?.matches(':focus-visible')) preview(row); });
    scope.addEventListener('focusout', () => preview(null));
  }

  async function reloadMemoryInPlace() {
    try {
      const nextData = await fetchMemory(activeProfile());
      if (!isCurrent()) return;
      applyData(nextData);
      itemDetails.clear();
      await lib.load();
      if (!isCurrent()) return;
      syncLayerControl();
      if (memories.length === 0 || !root.querySelector('#mem-graph-canvas')) {
        onRetry?.();
        return;
      }
      if (tidyActionCount() === 0 && tidy.replaced.length === 0) {
        uiState.memoryReviewKeepOpen = false;
      }
      paintTop();
      repaintRail();
      const redraw = (sel, html) => {
        const old = root.querySelector(sel);
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        const next = tmp.firstElementChild;
        if (!old || !next) return;
        // The button you are on stays yours.
        const held = old.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
        const top = old.scrollTop;
        old.replaceWith(next);
        next.scrollTop = top;
        if (held) [...next.querySelectorAll('button')].find((b) => JSON.stringify({ ...b.dataset }) === JSON.stringify(held))?.focus({ preventScroll: true });
      };
      redraw('.mem-pill', pillHtml());
      wirePill();
      redraw('.mem-menu', menuHtml());
      wireFilters(root.querySelector('.mem-menu'));
      syncMenu();
      activeGraphCtrl?.update({
        graph: mapGraph(),
        selectedId: mapSelectedId(),
        matchIds: matchIdsOf(currentFilter()),
      });
      refreshReview();
      syncNodeActs();
      if (isListView()) {
        paintListBody();
        return;
      }
      if (reviewOpen()) {
        syncTidyGraphFocus();
      } else if (mapSelectedId()) {
        focusSelected(uiState.memorySelectedId);
      }
    } catch {
      onRetry?.();
    }
  }

  function wireReview() {
    const review = root.querySelector('.mem-review');
    if (!review) return;
    review.querySelectorAll('[data-mem-review-close]').forEach((btn) => {
      btn.addEventListener('click', () => setReviewOpen(false));
    });
    review.querySelectorAll('[data-tidy-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const deck = btn.closest('[data-tidy-key]');
        const key = deck?.dataset.tidyKey;
        const id = btn.dataset.tidyPick;
        if (!key || !id) return;
        uiState.memoryTidyKeepChoice = { ...(uiState.memoryTidyKeepChoice || {}), [key]: id };
        refreshReview();
        syncTidyGraphFocus();
      });
    });
    review.querySelectorAll('[data-tidy-locate]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.tidyLocate;
        if (id) focusMemoryOnMap(id);
      });
    });
    // Picking a row (not its buttons) makes it the current one: the graph shows it
    // and the Y / N / arrow keys act on it.
    review.querySelectorAll('.mem-tidy-deck[data-tidy-key]').forEach((deck) => {
      deck.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const key = deck.dataset.tidyKey;
        if (!key || key === uiState.memoryTidyKey) return;
        uiState.memoryTidyKey = key;
        review.querySelectorAll('.mem-tidy-deck.is-current').forEach((el) => el.classList.remove('is-current'));
        deck.classList.add('is-current');
        syncTidyGraphFocus();
      });
    });
    review.querySelectorAll('[data-tidy-answer]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const deck = btn.closest('.mem-tidy-deck');
        if (!deck) return;
        const targets = tidyTargets();
        const idx = targets.findIndex((t) => t.key === deck.dataset.tidyKey);
        const entry = idx >= 0 ? targets[idx] : null;
        if (!entry) return;
        const byId = new Map(memories.map((m) => [m.id, m]));
        const info = describeTidyEntry(entry, byId);
        if (!info) return;
        const isYes = btn.dataset.tidyAnswer === 'yes';
        const payload = isYes ? info.yesPayload : info.noPayload;
        const isLast = targets.length === 1;
        const msg = isLast ? `${isYes ? info.yesToast : info.noToast} All clear.` : (isYes ? info.yesToast : info.noToast);
        const allBtns = [...deck.querySelectorAll('button')];
        allBtns.forEach((b) => { b.disabled = true; });
        try {
          await api('/api/memory/tidy', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
          if (uiState.memoryTidyKeepChoice) delete uiState.memoryTidyKeepChoice[entry.key];
          uiState.memoryTidyKey = null;
          uiState.memoryTidyIndex = idx;
          if (isLast && isYes) uiState.memoryReviewKeepOpen = true;
          toast(msg, 'ok');
          await reloadMemoryInPlace();
        } catch (err) {
          toast(err?.message || 'Could not update that memory.', 'err');
          allBtns.forEach((b) => { b.disabled = false; });
        }
      });
    });
    const drawer = review.querySelector('.mem-tidy-rep-drawer');
    if (drawer) {
      drawer.addEventListener('toggle', () => {
        uiState.memoryTidyReplacedOpen = drawer.open;
      });
    }
    review.querySelectorAll('[data-tidy-undo]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api('/api/memory/restore', { method: 'POST', body: JSON.stringify({ id: btn.dataset.tidyUndo }) });
          toast('Brought it back.', 'ok');
          await reloadMemoryInPlace();
        } catch (err) {
          toast(err?.message || 'Could not bring that memory back.', 'err');
          btn.disabled = false;
        }
      });
    });
  }

  function wirePanel() {
    root.querySelector('[data-mem-feed-close]')?.addEventListener('click', () => setReviewOpen(false));
    root.querySelector('.mem-feed-scroll')?.addEventListener('scroll', syncFeedEnd, { passive: true });
  }

  function setReviewOpen(open) {
    if (open) {
      uiState.memoryReviewDismissed = false;
      filterMenuOpen = false;
    } else closeReview();
    syncPanels();
  }

  function wireRail() {
    wireBrainRows(root.querySelector('.mem-rail'));
    wireFilters(root.querySelector('.mem-rail'));
  }

  // Redraw only the side menu, keeping its scroll.
  function repaintRail() {
    const old = root.querySelector('.mem-rail');
    if (!old) return;
    const scroll = old.querySelector('.hm-rail-list')?.scrollTop ?? 0;
    const tmp = document.createElement('div');
    tmp.innerHTML = railHtml();
    const next = tmp.firstElementChild;
    old.replaceWith(next);
    const list = next.querySelector('.hm-rail-list');
    if (list) list.scrollTop = scroll;
    wireRail();
    wirePanelJumps(next);
  }

  // A new side-menu choice: mark it, and dim the rest of the graph in place
  // (no rebuild, so the graph keeps its layout and zoom).
  function applyFilter() {
    const f = currentFilter();
    root.querySelectorAll('[data-mem-filter]').forEach((b) => {
      const on = b.dataset.memFilter === 'all' ? !f : f?.kind === b.dataset.memFilter && f.value === b.dataset.memValue;
      b.setAttribute('aria-current', String(on));
      if (b.classList.contains('mem-mchip')) b.setAttribute('aria-pressed', String(on));
    });
    const sel = memories.find((m) => m.id === uiState.memorySelectedId);
    if (sel && !matches(sel, f)) uiState.memorySelectedId = null;
    syncPill();
    if (isListView()) {
      paintListBody();
      return;
    }
    activeGraphCtrl?.update({ matchIds: matchIdsOf(f), selectedId: mapSelectedId() });
    syncNodeActs();
  }

  function openMemoryEditorDialog(existing = null) {
    const dlg = document.createElement('dialog');
    dlg.className = 'loop-dialog mem-editor-dialog';
    dlg.setAttribute('aria-labelledby', 'mem-ed-title');
    const prof = activeProfile();
    const profName = activeProfileName();
    const curScope = existing ? scopeOf(existing) : 'global';
    const curTags = existing ? tagsOf(existing).join(', ') : '';
    const curPinned = Boolean(existing?.pinned);
    dlg.innerHTML = `
      <div class="cat-add-head">
        <h3 id="mem-ed-title">${existing ? 'Edit memory' : 'Add memory'}</h3>
        <button type="button" class="btn sm ghost" data-mem-ed-close>Cancel</button>
      </div>
      ${!existing && prof !== 'all' ? `<p class="pf-add-hint">Will be added to <strong>${esc(profName)}</strong></p>` : ''}
      <form id="mem-ed-form" class="form-grid">
        <label class="field">
          <span class="lbl">Memory</span>
          <textarea name="content" rows="4" required maxlength="2000" placeholder="e.g. Always use TypeScript with strict mode enabled.">${esc(existing?.content || '')}</textarea>
        </label>
        <div class="form-row">
          <label class="field">
            <span class="lbl">Kind</span>
            <select name="scope">
              ${Object.entries(SCOPE_LABELS).map(([k, label]) => `<option value="${esc(k)}" ${curScope === k ? 'selected' : ''}>${esc(label)}</option>`).join('')}
            </select>
          </label>
          <label class="field">
            <span class="lbl">Tags (comma-separated)</span>
            <input name="tags" type="text" placeholder="coding, preferences" value="${esc(curTags)}">
          </label>
        </div>
        <label class="mem-ed-check">
          <input type="checkbox" name="pinned" ${curPinned ? 'checked' : ''}>
          <span>Pin to Startup Context (included at the start of every agent session)</span>
        </label>
        <div class="acts">
          <button type="submit" class="btn sm fill">${existing ? 'Save changes' : 'Save memory'}</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.querySelector('[data-mem-ed-close]')?.addEventListener('click', () => dlg.close());
    dlg.querySelector('#mem-ed-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const fd = new FormData(form);
      const content = String(fd.get('content') || '').trim();
      if (!content) return;
      const scope = String(fd.get('scope') || 'global');
      const tags = String(fd.get('tags') || '').split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
      const pinned = fd.get('pinned') === 'on';
      const btn = form.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      try {
        if (existing) {
          await api(`/api/memory/${encodeURIComponent(existing.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ content, scope, tags, pinned }),
          });
          toast('Memory updated.', 'ok');
        } else {
          await api('/api/memory', {
            method: 'POST',
            body: JSON.stringify({
              content,
              scope,
              tags,
              pinned,
              ...(prof !== 'all' ? { profiles: [prof] } : {}),
            }),
          });
          toast('Memory saved.', 'ok');
        }
        dlg.close();
        onRetry?.();
      } catch (err) {
        toast(err?.message || 'Could not save memory.', 'err');
        if (btn) btn.disabled = false;
      }
    });
    dlg.showModal();
    dlg.querySelector('textarea[name="content"]')?.focus();
  }

  function paintTop() {
    const topEl = root.querySelector('#mem-top-slot');
    if (!topEl) return;
    topEl.innerHTML = pageTop({
      title: BRAIN_NAME,
      sub: headSub(),
      hideTitle: true,
    }) + `
      <div class="mem-toolbar">
        ${memories.length > 0 ? `
          <div class="mem-search-bar">
            <input type="search" id="mem-search" class="ctl-search mem-search" value="${esc(uiState.memorySearch || '')}" placeholder="Search memories" aria-label="Search memories">
          </div>
        ` : '<div class="mem-search-spacer"></div>'}
      </div>
    `;
    const searchEl = topEl.querySelector('#mem-search');
    searchEl?.addEventListener('input', (e) => {
      uiState.memorySearch = e.currentTarget.value;
      if (isListView()) {
        paintListBody();
      } else {
        activeGraphCtrl?.update({ matchIds: matchIdsOf(currentFilter()), selectedId: mapSelectedId() });
        syncPill();
      }
    });
  }

  function listViewHtml() {
    const f = currentFilter();
    const visible = memories
      .filter((m) => matches(m, f))
      .slice()
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
    const q = String(uiState.memorySearch || '').trim();
    const targets = tidyTargets();
    const byId = new Map(memories.map((m) => [m.id, m]));
    const reviewBanner = targets.length > 0 ? `
      <section class="mem-list-review" aria-label="Memories needing review">
        <div class="mem-list-review-head">
          <strong>Needs review (${esc(targets.length)})</strong>
          <span class="d sm">Confirm or decline suggested updates and pin requests.</span>
        </div>
        <ul class="mem-list-review-items">
          ${targets.map((entry) => {
            const info = describeTidyEntry(entry, byId);
            if (!info) return '';
            const m = info.primary;
            const other = Array.isArray(info.others) && info.others[0] ? info.others[0] : null;
            const why = info.reason || info.question || '';
            return `<li class="mem-list-review-card" data-tidy-key="${esc(entry.key)}">
              <div class="mem-list-review-meta">
                <span class="mem-tidy-op ${info.warn ? 'is-warn' : ''}">${esc(info.kindLabel || 'Review')}</span>
                <span class="d sm">${esc(why)}</span>
              </div>
              <div class="mem-review-compare">
                <div class="mem-review-pane">
                  <span class="mem-review-lbl">${esc(other ? 'Proposed / Newer' : 'Memory')}</span>
                  <p>${esc(String(m.content || '').slice(0, 420))}</p>
                </div>
                ${other ? `<div class="mem-review-pane is-other">
                  <span class="mem-review-lbl">Existing / Conflicting</span>
                  <p>${esc(String(other.content || '').slice(0, 420))}</p>
                </div>` : ''}
              </div>
              <div class="acts">
                <button type="button" class="btn sm fill" data-list-tidy-yes="${esc(entry.key)}">${esc(info.yesSub || 'Confirm')}</button>
                <button type="button" class="btn sm" data-list-tidy-no="${esc(entry.key)}">${esc(info.noSub || 'Decline')}</button>
              </div>
            </li>`;
          }).join('')}
        </ul>
      </section>
    ` : '';

    if (visible.length === 0) {
      return `${reviewBanner}<div class="empty"><p class="et">${q ? `No memories match "${esc(q)}"` : 'No memories in this view'}</p><p class="ed">Clear your search or add a new memory.</p></div>`;
    }

    return `${reviewBanner}<ul class="mem-list-ul" role="list">
      ${visible.map((m) => {
        const sc = scopeOf(m);
        const act = activityOf(m);
        const at = m.updatedAt || m.createdAt;
        const tags = tagsOf(m);
        const needsPin = waitingPin(m);
        const focused = uiState.memorySelectedId && uiState.memorySelectedId === m.id;
        return `<li class="mem-list-item ${focused ? 'is-focused' : ''}" data-mem-id="${esc(m.id)}">
          <div class="mem-list-meta">
            <span class="mem-scope-pill" data-scope="${esc(sc)}">${esc(SCOPE_LABELS[sc] || 'Fact')}</span>
            <span class="mem-list-who">${esc(act.who)}</span>
            ${m.pinned ? `<span class="tag ${needsPin ? 'warn' : 'ok'}">${needsPin ? 'Pin awaiting OK' : 'Startup context'}</span>` : ''}
            ${at ? `<time class="mem-list-time" datetime="${esc(at)}">${esc(memoryAgo(at))}</time>` : ''}
          </div>
          <p class="mem-list-text">${esc(m.content || '')}</p>
          ${tags.length ? `<div class="mem-list-tags">${tags.map((t) => `<span class="mem-list-tag">#${esc(t)}</span>`).join('')}</div>` : ''}
          <div class="mem-list-acts">
            <button type="button" class="btn sm ghost" data-ml-edit="${esc(m.id)}">Edit</button>
            <button type="button" class="btn sm ghost" data-ml-pin="${esc(m.id)}">${m.pinned ? (needsPin ? 'Approve pin' : 'Unpin') : 'Pin'}</button>
            <button type="button" class="btn sm ghost" data-ml-copy="${esc(m.id)}">Copy</button>
            <button type="button" class="btn sm ghost danger-text" data-ml-del="${esc(m.id)}">Delete</button>
          </div>
        </li>`;
      }).join('')}
    </ul>`;
  }

  function wireListBody(host) {
    if (!host) return;
    host.querySelectorAll('[data-ml-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = memories.find((x) => x.id === btn.dataset.mlEdit);
        if (m) openMemoryEditorDialog(m);
      });
    });
    host.querySelectorAll('[data-ml-copy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = memories.find((x) => x.id === btn.dataset.mlCopy);
        if (m) copyText?.(String(m.content || ''), 'Copied memory.');
      });
    });
    host.querySelectorAll('[data-ml-pin]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const m = memories.find((x) => x.id === btn.dataset.mlPin);
        if (!m) return;
        const approving = m.pinned && m.pinnedBy === 'agent';
        const nextPinned = approving ? true : !m.pinned;
        btn.disabled = true;
        try {
          await api(`/api/memory/${encodeURIComponent(m.id)}`, { method: 'PATCH', body: JSON.stringify({ pinned: nextPinned }) });
          toast(approving ? 'Pin approved.' : (nextPinned ? 'Pinned to startup context.' : 'Unpinned.'), 'ok');
          await reloadMemoryInPlace();
        } catch (err) {
          toast(err?.message || 'Could not update pin.', 'err');
          btn.disabled = false;
        }
      });
    });
    host.querySelectorAll('[data-ml-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const now = Date.now();
        if (btn.dataset.armed !== '1') {
          btn.dataset.armed = '1';
          btn.dataset.armedAt = String(now);
          btn.textContent = 'Confirm delete';
          setTimeout(() => {
            if (btn.isConnected && btn.dataset.armed === '1' && !btn.disabled) {
              btn.dataset.armed = '';
              btn.dataset.armedAt = '';
              btn.textContent = 'Delete';
            }
          }, 6000);
          return;
        }
        // Ignore a rapid double-click so one accidental double-click never deletes a memory.
        if (now - Number(btn.dataset.armedAt || 0) < 450) return;
        btn.disabled = true;
        try {
          await api(`/api/memory/${encodeURIComponent(btn.dataset.mlDel)}`, { method: 'DELETE' });
          toast('Memory deleted.', 'ok');
          await reloadMemoryInPlace();
        } catch (err) {
          toast(err?.message || 'Could not delete memory.', 'err');
          btn.disabled = false;
        }
      });
    });
    host.querySelectorAll('[data-list-tidy-yes], [data-list-tidy-no]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.listTidyYes || btn.dataset.listTidyNo;
        const isYes = Boolean(btn.dataset.listTidyYes);
        const entry = tidyTargets().find((t) => t.key === key);
        if (!entry) return;
        const byId = new Map(memories.map((m) => [m.id, m]));
        const info = describeTidyEntry(entry, byId);
        if (!info) return;
        btn.disabled = true;
        try {
          await api('/api/memory/tidy', {
            method: 'POST',
            body: JSON.stringify(isYes ? info.yesPayload : info.noPayload),
          });
          toast(isYes ? info.yesToast : info.noToast, 'ok');
          await reloadMemoryInPlace();
        } catch (err) {
          toast(err?.message || 'Could not settle review item.', 'err');
          btn.disabled = false;
        }
      });
    });
  }

  function paintListBody() {
    const host = root.querySelector('#mem-list-host');
    if (!host) return;
    host.innerHTML = listViewHtml();
    wireListBody(host);
    if (uiState.memorySelectedId) {
      host.querySelector('.mem-list-item.is-focused')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function paint() {
    if (!isCurrent()) return;
    if (activeGraphCtrl) {
      activeGraphCtrl.destroy();
      activeGraphCtrl = null;
    }

    const notice = graphNoticeHtml();
    const listMode = !notice && isListView();

    root.innerHTML = `
      <header class="mem-top" id="mem-top-slot"></header>
      <section class="mem-stage" aria-label="Memory">
        ${railHtml()}
        <div class="mem-brain-shell ${!notice && !listMode && wideOn() ? 'is-wide' : ''} ${listMode ? 'is-list' : ''}">
          ${notice ? `<div class="mem-brain-notice">${notice}</div>` : listMode ? `
            <div class="mem-list-wrap" id="mem-list-host" role="region" aria-label="Memory list">
              ${listViewHtml()}
            </div>
          ` : `
            <canvas id="mem-graph-canvas" class="mem-brain-canvas" aria-label="Memory graph. Click a memory to read it."></canvas>
            <div class="mem-node-acts" id="mem-node-acts" hidden>
              <div class="mem-node-card" id="mem-node-card" hidden>
                <p class="mem-node-text" id="mem-node-text"></p>
                <div class="lib-read" id="mem-node-read" hidden></div>
                <div class="mem-node-meta" id="mem-node-meta"></div>
                <div class="mem-node-tidy" id="mem-node-tidy" hidden></div>
                <div class="mem-node-links" id="mem-node-links" hidden></div>
              </div>
              <div class="mem-node-btns">
                <button type="button" class="mem-node-del mem-node-copy" id="mem-node-open" hidden>Open</button>
                <button type="button" class="mem-node-del mem-node-copy" id="mem-node-edit" hidden>Edit</button>
                <button type="button" class="mem-node-del mem-node-copy" id="mem-node-pin" hidden>Pin</button>
                <button type="button" class="mem-node-del mem-node-copy" id="mem-node-copy" hidden>Copy</button>
                <button type="button" class="mem-node-del" id="mem-node-del">${ICONS.trash}<span>Delete</span></button>
              </div>
            </div>
            <button type="button" class="mem-feed-btn mem-back" id="mem-back" hidden>${ICONS.chevLeft}<span>${esc(filterName(currentFilter()))}</span></button>
            <div class="mem-brain-zoom" aria-label="Graph zoom controls">
              <button type="button" class="mem-zoom-btn" data-zoom="in" aria-label="Zoom in" title="Zoom in">+</button>
              <button type="button" class="mem-zoom-btn" data-zoom="out" aria-label="Zoom out" title="Zoom out">−</button>
              <button type="button" class="mem-zoom-btn mem-zoom-fit" data-zoom="fit" aria-label="Fit graph to view" title="Fit to view">Fit</button>
            </div>
            ${specialistEnabled ? `
              <button type="button" class="lib-chat-dock" data-lib-chat-open title="Open Loop chat">
                <span class="lib-chat-mark" aria-hidden="true">${ICONS.loopMark}</span>
                <span class="lib-chat-label" id="lib-chat-label">Ask Loop…</span>
              </button>
            ` : ''}
            ${lib.controlHtml()}
            ${pillHtml()}
            ${menuHtml()}
            <div class="mem-side">
              ${panelHtml()}
            </div>`}
        </div>
      </section>
    `;

    paintTop();
    if (listMode) {
      wireListBody(root.querySelector('#mem-list-host'));
    }

    root.querySelector('[data-mem-empty-add]')?.addEventListener('click', () => openMemoryEditorDialog(null));

    root.querySelector('#btn-mem-turn-on')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const res = await api('/api/memory/config', {
          method: 'PATCH',
          body: JSON.stringify({ mode: 'local', externalConnectionId: '' }),
        });
        config = res.config || config;
        toast('Loop Memory turned on.', 'ok');
        paint();
      } catch (err) {
        toast(err?.message || 'Could not turn Loop Memory on.', 'err');
        btn.disabled = false;
      }
    });

    wireRail();
    wirePanelJumps(root.querySelector('.mem-rail'));
    wirePanel();
    wireReview();
    root.querySelector('.mem-brain-shell')?.classList.toggle('feed-open', reviewOpen() && Boolean(root.querySelector('.mem-feed')));
    wirePill();
    wireFilters(root.querySelector('.mem-menu'));
    syncMenu();
    syncFeedEnd();

    const canvas = root.querySelector('#mem-graph-canvas');
    syncNodeActs = () => {};
    if (!canvas) return;

    // Beside a hovered memory: Delete. Beside the selected one: its full text, contextual Tidy actions, Edit, Pin, Copy and Delete.
    // It follows the node as the graph moves, stays up while the pointer travels onto it,
    // and asks once more before deleting.
    const acts = root.querySelector('#mem-node-acts');
    const delBtn = root.querySelector('#mem-node-del');
    let hoverId = null;
    let overActs = false;
    let shownId = null;
    let armed = false;
    let hideTimer = null;
    let raf = null;
    const labelOf = (id) => String(memories.find((m) => m.id === id)?.content || 'this memory').slice(0, 80);
    const setLabel = () => {
      delBtn.querySelector('span').textContent = armed ? 'Delete it?' : 'Delete';
      delBtn.classList.toggle('is-armed', armed);
      delBtn.setAttribute('aria-label', armed ? `Confirm deleting: ${labelOf(shownId)}` : `Delete memory: ${labelOf(shownId)}`);
    };
    const card = root.querySelector('#mem-node-card');
    const tidySlot = root.querySelector('#mem-node-tidy');
    const editBtn = root.querySelector('#mem-node-edit');
    const pinBtn = root.querySelector('#mem-node-pin');
    const copyBtn = root.querySelector('#mem-node-copy');
    const openBtn = root.querySelector('#mem-node-open');
    const readSlot = root.querySelector('#mem-node-read');
    const shell = root.querySelector('.mem-brain-shell');
    const backBtn = root.querySelector('#mem-back');
    const linksSlot = root.querySelector('#mem-node-links');
    let framedFor = '';
    // The picked memory's card stays in one place, off the group: on the right, or along the bottom
    // when narrow. Delete goes beside a hovered node: to its right, or to its left when that would
    // run past the graph's edge, and kept inside the graph top to bottom.
    const place = () => {
      raf = null;
      if (!acts.isConnected || acts.hidden || !activeGraphCtrl) return;
      const p = activeGraphCtrl.nodeScreen(shownId);
      if (!p) { hide(); return; }
      const W = graphOpenWidth();
      const H = shell.clientHeight;
      const isCard = acts.classList.contains('is-card');
      const sheet = isCard && cardIsSheet();
      acts.classList.toggle('is-sheet', sheet);
      shell.classList.toggle('has-sheet', sheet);
      const w = acts.offsetWidth;
      const h = acts.offsetHeight;
      if (isCard) {
        // A card that changed size, or a resized graph, leaves the group different room.
        const size = `${shownId}:${W}x${H}:${sheet ? h : 'side'}`;
        if (framedFor !== size) {
          framedFor = size;
          if (cardId()) focusSelected(shownId);
        }
        const y = sheet ? H - h : 60;
        acts.style.transform = `translate(${sheet ? 0 : W - w - 12}px, ${Math.round(y)}px)`;
        return;
      }
      let x = p.x + p.r + 8;
      if (x + w > W - 8 && p.x - p.r - 8 - w >= 8) x = p.x - p.r - 8 - w;
      const y = Math.max(8, Math.min(H - h - 8, p.y - h / 2));
      acts.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      raf = requestAnimationFrame(place);
    };
    const clipCardText = (s, n = 96) => {
      const t = String(s || '').replace(/\s+/g, ' ').trim();
      return t.length > n ? `${t.slice(0, n - 1)}…` : t;
    };
    const nodeTidyHtml = (m) => {
      const targets = tidyTargets();
      const idx = targets.findIndex((t) => t.memberIds.includes(m.id));
      if (idx === -1) return '';
      const entry = targets[idx];
      const byId = new Map(memories.map((x) => [x.id, x]));
      const info = describeTidyEntry(entry, byId, m.id);
      if (!info) return '';
      const canCycle = targets.length > 1;
      const prev = canCycle ? targets[(idx - 1 + targets.length) % targets.length] : null;
      const next = canCycle ? targets[(idx + 1) % targets.length] : null;
      return `
        <div class="mem-node-tidy-head">
          <span class="mem-tidy-pill ${info.warn ? 'is-warn' : ''}">${esc(info.kindLabel)}</span>
          <div class="mem-node-tidy-nav-btns">
            <span class="mem-tidy-count">${esc(idx + 1)} / ${esc(targets.length)}</span>
            ${canCycle ? `
              <button type="button" class="mem-tidy-step is-sm" data-node-jump="${esc(prev.focusId)}" aria-label="Previous item">${ICONS.chevLeft}</button>
              <button type="button" class="mem-tidy-step is-sm" data-node-jump="${esc(next.focusId)}" aria-label="Next item">${ICONS.chevRight}</button>
            ` : ''}
          </div>
        </div>
        <div class="mem-node-tidy-q">${esc(info.question)}</div>
        ${info.reason ? `<div class="mem-node-tidy-why">${esc(info.reason)}</div>` : ''}
        ${info.others.length > 0 ? `
          <div class="mem-node-tidy-others">
            ${info.others.slice(0, 2).map((o) => `
              <button type="button" class="mem-node-tidy-other" data-node-jump="${esc(o.id)}" title="Jump to this memory on the map">
                “${esc(clipCardText(o.content, 92))}”
              </button>`).join('')}
            ${info.others.length > 2 ? `<span class="mem-node-tidy-why">+${esc(info.others.length - 2)} more</span>` : ''}
          </div>` : ''}
        <div class="mem-tidy-yn is-compact" data-node-tidy-id="${esc(m.id)}" data-node-tidy-key="${esc(entry.key)}">
          <button type="button" class="mem-tidy-yn-btn is-no" data-node-tidy-answer="no">
            <span class="mem-tidy-yn-top">${ICONS.x}<span>No</span></span>
            <span class="mem-tidy-yn-sub">${esc(info.noSub)}</span>
          </button>
          <button type="button" class="mem-tidy-yn-btn is-yes" data-node-tidy-answer="yes">
            <span class="mem-tidy-yn-top">${ICONS.check}<span>Yes</span></span>
            <span class="mem-tidy-yn-sub">${esc(info.yesSub)}</span>
          </button>
        </div>`;
    };
    // What the server knows of an item: its whole text and its links. null until the answer comes;
    // the card fills again when it does.
    const detailOf = (id) => {
      const hit = itemDetails.get(id);
      if (hit) return hit.data;
      itemDetails.set(id, { data: null });
      const p = activeProfile();
      const done = (data) => {
        if (!itemDetails.has(id)) return;
        itemDetails.set(id, { data });
        if (acts.isConnected && shownId === id) fillCard();
      };
      api(`/api/library/item/${encodeURIComponent(id)}${p && p !== 'all' ? `?profile=${encodeURIComponent(p)}` : ''}`)
        .then(done)
        .catch(() => done({ item: null, links: { out: [], in: [] }, refs: {} }));
      return null;
    };
    const briefOn = (id) => {
      const m = memoryOn(id);
      if (m) return { id, kind: 'memory', scope: scopeOf(m), title: m.content };
      const n = lib.node(id);
      return n ? { id, kind: n.kind, sub: n.sub, title: n.title || n.label } : null;
    };
    // The links of the picked item, then the items that Loop put near it itself (a shared tag, the
    // same words), and why, when it is one or two reasons. For a person: what they wrote.
    const nodeLinksHtml = (it) => {
      if (linkFormFor === it.id) return linkFormHtml(it, esc);
      const person = layerOfId(it.id) === 'people';
      const edges = mapGraph().edges.filter((e) => (e.source === it.id || e.target === it.id) && (person ? e.kind === 'by' : e.kind !== 'link' && e.kind !== 'by'));
      // A person's list is what they wrote. Their agents show on the map, with a line to them.
      const ids = linkedIds(edges, it.id).filter((id) => !person || layerOfId(id) !== 'people');
      const related = ids.slice(0, 24).map(briefOn).filter(Boolean);
      const why = [...new Set(edges.map((e) => (e.kind === 'tag' || e.kind === 'project' ? e.label : '')))];
      const nearText = person
        ? `Wrote {n} ${ids.length === 1 ? 'item' : 'items'} on the map`
        : `{n} near${why.length <= 2 && why.every(Boolean) ? ` by ${why.join(', ')}` : ''}`;
      return linksHtml({ links: person ? null : detailOf(it.id)?.links || null, related, nearText, nearCount: person ? ids.length : undefined, canLink: !person, esc });
    };
    // The ids for Gather from the card: the picked item, its links, then the items near it.
    const aroundIds = (it) => {
      const links = itemDetails.get(it.id)?.data?.links;
      const near = mapGraph().edges.filter((e) => (e.source === it.id || e.target === it.id) && e.kind !== 'by');
      return [...new Set([it.id, ...(links?.out || []).map((l) => l.item.id), ...(links?.in || []).map((l) => l.item.id), ...linkedIds(near, it.id)])];
    };
    let bodyFor = null; // the item and the answer that the reader shows now
    // A selected item shows its full text and its links; a hovered memory just offers Delete.
    const fillCard = () => {
      // With Review open, its current row is the picked memory.
      const it = shownId === uiState.memorySelectedId && !reviewOpen() && !menuOpen() ? itemOn(shownId) : null;
      const m = it ? memoryOn(it.id) : null;
      card.hidden = !it;
      if (editBtn) editBtn.hidden = !m;
      if (pinBtn) {
        pinBtn.hidden = !m;
        // An agent's pin waits for the owner before it reaches startup context.
        if (m) pinBtn.textContent = m.pinned ? (m.pinnedBy === 'agent' ? 'Approve pin' : 'Unpin') : 'Pin';
      }
      copyBtn.hidden = !it || layerOfId(it.id) === 'people';
      openBtn.hidden = !it || Boolean(m) || !openHashOf(it);
      // Delete is for a memory. An item of a layer is deleted in its own part of Library.
      delBtn.hidden = Boolean(it && !m);
      acts.classList.toggle('is-card', Boolean(it));
      if (!it) {
        if (tidySlot) { tidySlot.hidden = true; tidySlot.innerHTML = ''; }
        linksSlot.hidden = true;
        readSlot.hidden = true;
        acts.classList.remove('is-sheet');
        shell.classList.remove('has-sheet');
        return;
      }
      const linksHtmlNow = nodeLinksHtml(it);
      if (linksSlot.dataset.html !== linksHtmlNow) {
        linksSlot.dataset.html = linksHtmlNow;
        linksSlot.innerHTML = linksHtmlNow;
      }
      linksSlot.hidden = !linksHtmlNow;
      if (m) {
        root.querySelector('#mem-node-text').textContent = String(m.content || '').trim();
        const scope = scopeOf(m);
        card.className = `mem-node-card s-${scope}${linkFormFor === it.id ? ' is-linking' : ''}`;
        readSlot.hidden = true;
        bodyFor = null;
        root.querySelector('#mem-node-meta').innerHTML = `<span class="mem-node-kind">${esc(SCOPE_LABELS[scope])}</span>${tagsOf(m).map((t) => `<span>#${esc(t)}</span>`).join('')}`;
      } else {
        const person = layerOfId(it.id) === 'people';
        const detail = person ? null : detailOf(it.id);
        root.querySelector('#mem-node-text').textContent = String(it.title || it.label || '').trim();
        card.className = `mem-node-card is-item ${groupClass(it)}${linkFormFor === it.id ? ' is-linking' : ''}`;
        // The reader is drawn once for each answer, so a page keeps its scroll while the pointer moves.
        if (!bodyFor || bodyFor.id !== it.id || bodyFor.detail !== detail) {
          bodyFor = { id: it.id, detail };
          const body = itemBodyHtml(it, detail, esc);
          readSlot.innerHTML = body;
          readSlot.hidden = !body;
        }
        root.querySelector('#mem-node-meta').innerHTML = itemMetaHtml(it, detail, esc);
      }
      if (tidySlot) {
        const html = m ? nodeTidyHtml(m) : '';
        tidySlot.innerHTML = html;
        tidySlot.hidden = !html;
      }
    };
    const show = (id) => {
      if (shownId !== id) {
        shownId = id;
        acts.scrollTop = 0;
        armed = false;
        if (linkFormFor !== id) linkFormFor = null;
        setLabel();
      }
      fillCard();
      acts.hidden = false;
      if (!raf) raf = requestAnimationFrame(place);
    };
    function hide() {
      acts.hidden = true;
      framedFor = '';
      acts.classList.remove('is-sheet');
      shell.classList.remove('has-sheet');
      shownId = null;
      armed = false;
      linkFormFor = null;
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    }
    // While a memory is picked its card stays up, so moving over the linked ones never swaps it away.
    const cardId = () => (uiState.memorySelectedId && !reviewOpen() && !menuOpen() && itemOn(uiState.memorySelectedId) ? uiState.memorySelectedId : null);
    const targetId = () => cardId() || hoverId || (overActs ? shownId : null) || (menuOpen() ? null : uiState.memorySelectedId);
    syncNodeActs = () => {
      clearTimeout(hideTimer);
      backBtn.hidden = !cardId();
      if (cardId()) { show(cardId()); return; }
      const id = targetId();
      if (id && (id === hoverId || (!hoverId && id === uiState.memorySelectedId))) show(id);
      else if (id) hideTimer = setTimeout(() => { const next = targetId(); if (next) show(next); else hide(); }, 220);
      else hideTimer = setTimeout(() => { if (!targetId()) hide(); }, 220);
    };
    const advanceAfterMapTidy = (resolvedMemberIds = []) => {
      const dropped = new Set(resolvedMemberIds);
      const remaining = tidyTargets().filter((t) => !t.memberIds.some((id) => dropped.has(id)));
      uiState.memorySelectedId = remaining[0]?.focusId || null;
    };
    function wireNodeActs() {
      acts.addEventListener('pointerenter', () => { overActs = true; syncNodeActs(); });
      acts.addEventListener('pointerleave', () => { overActs = false; syncNodeActs(); });
      backBtn.addEventListener('click', () => select(null));
      const hint = (e) => activeGraphCtrl?.update({ hintId: e.target.closest?.('[data-node-link]')?.dataset.nodeLink || null });
      linksSlot.addEventListener('pointerover', hint);
      linksSlot.addEventListener('pointerleave', hint);
      const refreshLinks = async (id) => {
        linkFormFor = null;
        itemDetails.delete(id);
        await reloadMemoryInPlace();
      };
      let findSeq = 0;
      const runFind = async (text) => {
        const slot = linksSlot.querySelector('[data-lib-find]');
        const id = shownId;
        if (!slot || !id) return;
        const mine = ++findSeq;
        const p = activeProfile();
        const query = [`q=${encodeURIComponent(text)}`, `exclude=${encodeURIComponent(id)}`, p && p !== 'all' ? `profile=${encodeURIComponent(p)}` : ''].filter(Boolean).join('&');
        try {
          const res = await api(`/api/library/find?${query}`);
          if (mine === findSeq && slot.isConnected) slot.innerHTML = findRowsHtml(Array.isArray(res?.items) ? res.items : [], esc);
        } catch {
          if (mine === findSeq && slot.isConnected) slot.innerHTML = '<p class="lib-find-none">Could not search. Try again.</p>';
        }
      };
      let findTimer = null;
      linksSlot.addEventListener('input', (e) => {
        if (e.target?.name !== 'q') return;
        clearTimeout(findTimer);
        const text = e.target.value;
        findTimer = setTimeout(() => runFind(text), 180);
      });
      linksSlot.addEventListener('submit', (e) => e.preventDefault());
      linksSlot.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !linkFormFor) return;
        e.stopPropagation();
        linkFormFor = null;
        fillCard();
        linksSlot.querySelector('[data-link-add]')?.focus({ preventScroll: true });
      });
      linksSlot.addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (!btn || btn.disabled) return;
        const id = shownId;
        if (btn.dataset.linkAdd !== undefined) {
          linkFormFor = id;
          fillCard();
          linksSlot.querySelector('input[name="q"]')?.focus({ preventScroll: true });
          runFind('');
          return;
        }
        if (btn.dataset.linkCancel !== undefined) {
          linkFormFor = null;
          fillCard();
          linksSlot.querySelector('[data-link-add]')?.focus({ preventScroll: true });
          return;
        }
        if (btn.dataset.gatherItem !== undefined) {
          const it = itemOn(id);
          if (it) openGather(aroundIds(it), memoryOn(id) ? '' : String(it.title || it.label || ''));
          return;
        }
        if (btn.dataset.linkTarget) {
          const relation = linksSlot.querySelector('select[name="relation"]')?.value || 'relates';
          const p = activeProfile();
          btn.disabled = true;
          try {
            await api(`/api/library/links${p && p !== 'all' ? `?profile=${encodeURIComponent(p)}` : ''}`, {
              method: 'POST',
              body: JSON.stringify({ source: id, target: btn.dataset.linkTarget, relation }),
            });
            toast('Linked.', 'ok');
            // The item at the other end shows on the map: its layer comes on.
            const layer = layerOfId(btn.dataset.linkTarget);
            if (layer && !lib.has(layer)) lib.set(layer, true);
            await refreshLinks(id);
          } catch (err) {
            toast(err?.message || 'Could not link these items.', 'err');
            btn.disabled = false;
          }
          return;
        }
        if (btn.dataset.linkRemove) {
          const p = activeProfile();
          btn.disabled = true;
          try {
            await api(`/api/library/links/${encodeURIComponent(btn.dataset.linkRemove)}${p && p !== 'all' ? `?profile=${encodeURIComponent(p)}` : ''}`, { method: 'DELETE' });
            toast('Link removed.', 'ok');
            await refreshLinks(id);
          } catch (err) {
            toast(err?.message || 'Could not remove the link.', 'err');
            btn.disabled = false;
          }
          return;
        }
        const target = btn.closest('[data-node-link]')?.dataset.nodeLink;
        if (!target) return;
        activeGraphCtrl?.update({ hintId: null });
        focusMemoryOnMap(target);
      });
      // A [[name]] in a page goes to the item that it names.
      readSlot.addEventListener('click', (e) => {
        const target = e.target.closest('[data-node-link]')?.dataset.nodeLink;
        if (target) focusMemoryOnMap(target);
      });
      openBtn.addEventListener('click', () => {
        const hash = openHashOf(itemOn(shownId));
        if (hash) location.hash = hash;
      });
      tidySlot?.addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (!btn || btn.disabled) return;
        if (btn.dataset.nodeJump) {
          focusMemoryOnMap(btn.dataset.nodeJump);
          return;
        }
        if (btn.dataset.nodeTidyAnswer) {
          const wrap = btn.closest('[data-node-tidy-key]');
          const key = wrap?.dataset.nodeTidyKey;
          const memId = wrap?.dataset.nodeTidyId;
          const entry = tidyTargets().find((t) => t.key === key);
          if (!entry) return;
          const byId = new Map(memories.map((x) => [x.id, x]));
          const info = describeTidyEntry(entry, byId, memId);
          if (!info) return;
          const isYes = btn.dataset.nodeTidyAnswer === 'yes';
          const payload = isYes ? info.yesPayload : info.noPayload;
          const buttons = [...tidySlot.querySelectorAll('button')];
          buttons.forEach((bEl) => { bEl.disabled = true; });
          try {
            await api('/api/memory/tidy', { method: 'POST', body: JSON.stringify(payload) });
            toast(isYes ? info.yesToast : info.noToast, 'ok');
            advanceAfterMapTidy(entry.memberIds);
            await reloadMemoryInPlace();
          } catch (err) {
            toast(err?.message || 'Could not update that memory.', 'err');
            buttons.forEach((bEl) => { bEl.disabled = false; });
          }
        }
      });
      editBtn?.addEventListener('click', () => {
        const m = memories.find((x) => x.id === shownId);
        if (m) openMemoryEditorDialog(m);
      });
      pinBtn?.addEventListener('click', async () => {
        const m = memories.find((x) => x.id === shownId);
        if (!m) return;
        pinBtn.disabled = true;
        const approving = m.pinned && m.pinnedBy === 'agent';
        try {
          await api(`/api/memory/${encodeURIComponent(m.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ pinned: approving ? true : !m.pinned }),
          });
          toast(
            approving
              ? 'Pin approved. It is in Startup Context for every agent.'
              : m.pinned ? 'Unpinned from Startup Context.' : 'Pinned to Startup Context.',
            'ok',
          );
          onRetry?.();
        } catch (err) {
          toast(err?.message || 'Could not update pin state.', 'err');
          pinBtn.disabled = false;
        }
      });
      copyBtn.addEventListener('click', () => {
        const m = memories.find((x) => x.id === shownId);
        if (m) {
          copyText?.(String(m.content || ''), 'Copied.');
          return;
        }
        const it = lib.node(shownId);
        const full = itemDetails.get(shownId)?.data?.item;
        if (it) copyText?.(String(full?.markdown || full?.text || full?.note || full?.objective || full?.url || it.title || ''), 'Copied.');
      });
      delBtn.addEventListener('click', async () => {
        const id = shownId;
        if (!id || !memoryOn(id)) return;
        if (!armed) {
          armed = true;
          setLabel();
          return;
        }
        delBtn.disabled = true;
        try {
          await api(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
          if (uiState.memorySelectedId === id) uiState.memorySelectedId = null;
          toast('Memory deleted.', 'ok');
          hide();
          onRetry?.();
        } catch (err) {
          toast(err?.message || 'Could not delete that memory.', 'err');
          delBtn.disabled = false;
        }
      });
    }
    activeGraphCtrl = mountMemoryGraph(canvas, {
      graph: mapGraph(),
      selectedId: mapSelectedId(),
      matchIds: matchIdsOf(currentFilter()),
      groupBy: uiState.memoryGroupBy,
      selectedCard: true,
      ...graphInsets(),
      onSelect: (id) => select(id, { fromGraph: true }),
      onHover: (id) => {
        // Delete beside a node is for a memory. Other items say what they are on the map itself.
        hoverId = id && memoryOn(id) ? id : null;
        syncNodeActs();
      },
    });
    wireNodeActs();
    shell.addEventListener('click', (e) => {
      const layer = e.target.closest?.('[data-lib-layer]')?.dataset.libLayer;
      if (layer) {
        toggleLayer(layer);
        return;
      }
      if (e.target.closest?.('[data-lib-chat-open]')) {
        const sel = uiState.memorySelectedId || '';
        uiState.loopChatFocusNodeId = sel;
        location.hash = `#loop?from=map${sel ? `&focus=${encodeURIComponent(sel)}` : ''}`;
      }
    });
    const settleView = () => {
      if (!root.isConnected) return;
      syncFeedEnd();
      syncMenu();
      syncInsets();
      if (mapSelectedId()) {
        focusSelected(uiState.memorySelectedId);
        syncNodeActs();
        setTimeout(() => {
          if (root.isConnected && mapSelectedId()) {
            focusSelected(uiState.memorySelectedId);
            syncNodeActs();
          }
        }, 240);
      } else if (reviewOpen()) {
        syncTidyGraphFocus();
      }
    };
    // The side menu keeps its place in the column as the window changes, so the room beside it moves.
    if (typeof ResizeObserver === 'function') {
      if (activeResizeObserver) activeResizeObserver.disconnect();
      activeResizeObserver = new ResizeObserver(() => {
        if (!canvas.isConnected) return;
        syncInsets();
        if (!acts.hidden && acts.classList.contains('is-card')) place();
      });
      activeResizeObserver.observe(canvas);
    }
    let pressAt = null;
    canvas.addEventListener('pointerdown', (e) => { pressAt = [e.clientX, e.clientY]; });
    canvas.addEventListener('click', (e) => {
      const moved = pressAt && Math.hypot(e.clientX - pressAt[0], e.clientY - pressAt[1]) > 4;
      if (menuOpen() && !moved) setMenuOpen(false, { refocus: false });
      // The memory Review points at is already the picked one; a click on it still opens its card.
      if (reviewOpen() && !moved && hoverId && hoverId === uiState.memorySelectedId) select(hoverId);
    });
    if (canvas.clientHeight > 0) requestAnimationFrame(settleView);
    else root.closest('.view')?.addEventListener('view-shown', settleView, { once: true });
    root.querySelectorAll('[data-zoom]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.zoom;
        if (act === 'in') activeGraphCtrl?.zoomBy(1.22);
        else if (act === 'out') activeGraphCtrl?.zoomBy(0.82);
        else if (uiState.memorySelectedId && !reviewOpen()) select(null);
        else activeGraphCtrl?.fitView(true);
      });
    });
  }

  // Deep-link to a memory on the map (?focus=<id>) or straight to the Yes/No review deck (?panel=tidy or ?panel=review).
  if (initialFocusParam && memories.some((m) => m.id === initialFocusParam)) {
    const targetMem = memories.find((m) => m.id === initialFocusParam);
    if (targetMem && currentFilter() && !matches(targetMem, currentFilter())) {
      uiState.memoryFilter = null;
    }
    uiState.memorySelectedId = initialFocusParam;
    uiState.memoryReviewDismissed = true;
    try { if (window.location.hash !== '#knowledge') history.replaceState(null, '', '#knowledge'); } catch { /* ignore */ }
  } else if (initialFocusParam && ['saved', 'files', 'tasks'].includes(layerOfId(initialFocusParam))) {
    lib.set(layerOfId(initialFocusParam), true);
    uiState.memorySelectedId = initialFocusParam;
    uiState.memoryReviewDismissed = true;
    try { if (window.location.hash !== '#knowledge') history.replaceState(null, '', '#knowledge'); } catch { /* ignore */ }
  } else if (initialPanelParam === 'tidy' || initialPanelParam === 'review') {
    if (tidyActionCount() > 0 || tidy.replaced.length > 0) {
      uiState.memoryReviewDismissed = false;
      if (tidyActionCount() === 0 && tidy.replaced.length > 0) uiState.memoryReviewKeepOpen = true;
    }
    try { if (window.location.hash !== '#knowledge') history.replaceState(null, '', '#knowledge'); } catch { /* ignore */ }
  }

  // Keyboard shortcuts: Escape closes/deselects; in Review mode ←/→ cycles and Y/N answers.
  activeKeydownHandler = (e) => {
    if (!isCurrent()) return;
    if (document.querySelector('dialog[open]')) return;
    const el = document.activeElement;
    const tag = el?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
    if (e.key === 'Escape') {
      if (menuOpen()) setMenuOpen(false);
      else if (uiState.memorySelectedId && !reviewOpen()) select(null);
      else if (reviewOpen() && root.querySelector('.mem-review')) setReviewOpen(false);
      else if (uiState.memorySelectedId) select(null);
      else if (wideOn()) setWide(false);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'f' && !e.repeat) {
      e.preventDefault();
      setWide(!wideOn());
      return;
    }
    if (!reviewOpen()) return;
    const deck = root.querySelector('.mem-review .mem-tidy-deck.is-current');
    if (!deck) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (stepTidy(e.key === 'ArrowLeft' ? -1 : 1)) e.preventDefault();
    } else if (e.key === 'y' || e.key === 'Y') {
      const yesBtn = deck.querySelector('[data-tidy-answer="yes"]');
      if (yesBtn && !yesBtn.disabled) { e.preventDefault(); yesBtn.click(); }
    } else if (e.key === 'n' || e.key === 'N') {
      const noBtn = deck.querySelector('[data-tidy-answer="no"]');
      if (noBtn && !noBtn.disabled) { e.preventDefault(); noBtn.click(); }
    }
  };
  document.addEventListener('keydown', activeKeydownHandler);

  paint();
  // The layers come after the map too. On a redraw of the page the map already has the last ones.
  loadLayers();

  // The other parts' numbers come after the map, so the map never waits for them.
  brainCounts(api, activeProfile()).then((counts) => {
    if (!isCurrent()) return;
    partCounts = counts;
    repaintRail();
  });
}
