// Three parts of Library: Saved (#knowledge/saved), Files (#knowledge/files) and Schedules (#knowledge/schedules), and
// the quick-save capture page (/save?url=&title=&text=&auto_close=1). Zero raw HTML injection.

import { BRAIN_NAME, BRAIN_PARTS, brainHash, brainRow, wireBrainRows } from './brain-parts.js';
import { renderJsonRenderDom } from './json-render-dom.js';
import { renderSkillMarkdown } from './skill-markdown.js';
import { isMode, modeChoices, modeHead, saveRule, wireRadioKeys } from './approval-modes.js';

export const SAVED_TITLE_MAX = 300;
export const SAVED_NOTE_MAX = 4000;
export const SAVED_TEXT_MAX = 40_000;
export const SAVED_PAGE_STEP = 60;

export function formatItemProjects(item, profiles = []) {
  const list = Array.isArray(profiles) ? profiles : [];
  const raw = Array.isArray(item?.projects) ? item.projects : Array.isArray(item?.profiles) ? item.profiles : [];
  const namedIds = raw.filter((p) => p && p !== 'all');
  if (!namedIds.length) return { namedIds: [], labels: ['All'], text: 'All' };
  const labels = namedIds.map((id) => list.find((p) => p && p.id === id)?.name || id);
  return { namedIds, labels, text: labels.join(', ') };
}

function isOtherProjectItem(projInfo, activeProject) {
  if (!activeProject || activeProject === 'all') return false;
  return !projInfo.namedIds.includes(activeProject);
}

const SAVED_RULE_META = {
  saved: {
    key: 'saved',
    label: 'Agent saves to Saved',
    what: 'Saved',
    cap: 'Applies when an agent saves, refreshes, or removes Saved links, notes, or cards.',
  },
  file: {
    key: 'file',
    label: 'Agent saves to Files',
    what: 'Files',
    cap: 'Applies when an agent uploads or deletes shared files.',
  },
  schedule: {
    key: 'schedule',
    label: 'Agent changes to Schedules',
    what: 'Schedules',
    cap: 'Applies when an agent adds, runs, or deletes reminders and schedules.',
  },
};

function ago(iso) {
  const diff = Date.now() - Date.parse(iso || '');
  if (Number.isNaN(diff)) return '';
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 60) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function kindGlyph(item) {
  if (item.ui) return '✦';
  if (item.kind === 'link') return '↗';
  if (item.kind === 'artifact') return '◆';
  return '≡';
}

function makeBookmarkletHref(origin) {
  const base = String(origin || location.origin).replace(/\/+$/, '');
  return `javascript:void(window.open('${base}/save?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)+'&auto_close=1','loop_save','width=460,height=440'))`;
}

const savedViewState = {
  filter: 'all', // all | link | note | card | agents
  query: '',
  expandedId: '',
  modeOpen: '', // '' | 'saved' | 'file' | 'schedule'
};

let activeLiveRefresh = null;

/**
 * Refreshes the currently mounted Library list in-place on live SSE updates
 * without tearing down composers, drafts, cursor positions, or focus.
 */
export async function refreshSavedLive() {
  if (typeof activeLiveRefresh !== 'function') return false;
  return activeLiveRefresh();
}

const PARTS = new Set(['saved', 'files', 'schedules', 'tasks']);

function staleBannerHtml(state, label, esc) {
  if (!state?.error || !state?.loaded) return '';
  const when = state.updatedAt ? ` Showing data from ${ago(state.updatedAt)}.` : '';
  return `
    <div class="saved-empty is-stale" role="status">
      <p class="t">${esc(label)} unavailable</p>
      <p class="d sm">${esc(state.error)}${esc(when)}</p>
      <div><button type="button" class="btn sm" data-saved-retry>Retry</button></div>
    </div>`;
}

export async function renderSaved(root, ui) {
  const {
    esc,
    api,
    toast,
    copyText,
    confirmDialog,
    isCurrent,
    params,
    activeProfile,
    syncTopChrome,
    passwordName,
    noGuardPassword,
    pageTop,
  } = ui;
  const part = PARTS.has(ui.part) ? ui.part : 'saved';

  const isQuickSaveLaunch =
    location.pathname === '/save' ||
    Boolean(params?.get('url') || params?.get('text') || params?.get('title'));
  const incomingUrl = String(params?.get('url') || '').trim();
  const incomingTitle = String(params?.get('title') || '').trim();
  const incomingText = String(params?.get('text') || '').trim();
  const autoClose = params?.get('auto_close') === '1';

  const focusId = String(params?.get('focus') || '').trim();
  if (focusId) savedViewState.expandedId = focusId;

  const currentProject = () => {
    const p = typeof activeProfile === 'function' ? activeProfile() : 'all';
    return p && p !== 'all' ? p : 'all';
  };

  const savedState = { loaded: false, items: [], total: undefined, queryTotal: 0, pageCount: SAVED_PAGE_STEP, error: '', updatedAt: '' };
  const filesState = { loaded: false, items: [], error: '', updatedAt: '' };
  const schedulesState = { loaded: false, items: [], error: '', updatedAt: '' };
  const tasksState = { loaded: false, items: [], total: 0, error: '', updatedAt: '' };
  const policiesState = {
    loaded: false,
    actions: { saved: 'unavailable', file: 'unavailable', schedule: 'unavailable' },
    error: '',
    updatedAt: '',
  };
  let memoryCount;
  let profiles = [];
  let pendingListRepaint = false;

  async function fetchSavedWindow(targetCount = savedState.pageCount) {
    const proj = currentProject();
    const collected = [];
    const seen = new Set();
    let total = 0;
    let offset = 0;
    const desired = Math.max(SAVED_PAGE_STEP, Number(targetCount) || SAVED_PAGE_STEP);
    while (collected.length < desired) {
      const chunk = Math.min(200, desired - collected.length);
      const qs = new URLSearchParams();
      if (proj !== 'all') qs.set('profile', proj);
      if (savedViewState.query.trim()) qs.set('query', savedViewState.query.trim());
      qs.set('limit', String(chunk));
      if (offset > 0) qs.set('offset', String(offset));
      const res = await api(`/api/saved?${qs}`);
      const batch = Array.isArray(res?.items) ? res.items : [];
      total = Number.isFinite(Number(res?.total)) ? Number(res.total) : collected.length + batch.length;
      for (const item of batch) {
        if (!item?.id || seen.has(item.id)) continue;
        seen.add(item.id);
        collected.push(item);
      }
      if (batch.length < chunk || collected.length >= total) break;
      offset += batch.length;
    }
    return { items: collected, total };
  }

  async function loadAll() {
    const proj = currentProject();
    const projQs = proj !== 'all' ? `?profile=${encodeURIComponent(proj)}` : '';
    const nowIso = new Date().toISOString();

    const [savedOut, filesOut, schedOut, tasksOut, ovOut, polOut] = await Promise.allSettled([
      fetchSavedWindow(savedState.pageCount),
      api(`/api/files${projQs}`),
      api(`/api/schedules${projQs}`),
      api(`/api/tasks${projQs}`),
      api('/api/overview'),
      api('/api/policies'),
    ]);

    if (savedOut.status === 'fulfilled') {
      savedState.items = Array.isArray(savedOut.value?.items) ? savedOut.value.items : [];
      savedState.queryTotal = Number.isFinite(Number(savedOut.value?.total))
        ? Number(savedOut.value.total)
        : savedState.items.length;
      if (!savedViewState.query.trim()) savedState.total = savedState.queryTotal;
      savedState.loaded = true;
      savedState.error = '';
      savedState.updatedAt = nowIso;
    } else {
      savedState.error = savedOut.reason?.message || 'Could not load Saved items.';
    }

    if (filesOut.status === 'fulfilled') {
      filesState.items = Array.isArray(filesOut.value?.files) ? filesOut.value.files : [];
      filesState.loaded = true;
      filesState.error = '';
      filesState.updatedAt = nowIso;
    } else {
      filesState.error = filesOut.reason?.message || 'Could not load files.';
    }

    if (schedOut.status === 'fulfilled') {
      schedulesState.items = Array.isArray(schedOut.value?.schedules) ? schedOut.value.schedules : [];
      schedulesState.loaded = true;
      schedulesState.error = '';
      schedulesState.updatedAt = nowIso;
    } else {
      schedulesState.error = schedOut.reason?.message || 'Could not load schedules.';
    }

    if (tasksOut.status === 'fulfilled') {
      tasksState.items = Array.isArray(tasksOut.value?.tasks) ? tasksOut.value.tasks : [];
      tasksState.total = Number.isFinite(Number(tasksOut.value?.total)) ? Number(tasksOut.value.total) : tasksState.items.length;
      tasksState.loaded = true;
      tasksState.error = '';
      tasksState.updatedAt = nowIso;
    } else {
      tasksState.error = tasksOut.reason?.message || 'Could not load tasks.';
    }

    if (ovOut.status === 'fulfilled') {
      profiles = Array.isArray(ovOut.value?.profileRecords) ? ovOut.value.profileRecords : [];
      if (profiles.length && typeof syncTopChrome === 'function') {
        syncTopChrome(profiles, { loaded: true });
      }
    }

    if (polOut.status === 'fulfilled' && polOut.value?.policies) {
      const actions = polOut.value.policies.actions || {};
      const defMode = isMode(polOut.value.policies.default) ? polOut.value.policies.default : 'auto';
      policiesState.actions = {
        saved: isMode(actions.saved) ? actions.saved : defMode,
        file: isMode(actions.file) ? actions.file : defMode,
        schedule: isMode(actions.schedule) ? actions.schedule : defMode,
      };
      policiesState.loaded = true;
      policiesState.error = '';
      policiesState.updatedAt = nowIso;
    } else {
      policiesState.error = polOut.status === 'rejected'
        ? (polOut.reason?.message || 'Could not load approval rules.')
        : 'Could not load approval rules.';
      if (!policiesState.loaded) {
        policiesState.actions = { saved: 'unavailable', file: 'unavailable', schedule: 'unavailable' };
      }
    }
  }

  await loadAll();
  if (!isCurrent()) return;

  const origin = location.origin;
  const bookmarklet = makeBookmarkletHref(origin);
  const activeRuleKey = part === 'files' ? 'file' : part === 'schedules' ? 'schedule' : 'saved';
  const activeRule = SAVED_RULE_META[activeRuleKey];

  function filteredSaved() {
    const f = savedViewState.filter;
    return savedState.items.filter((item) => {
      if (f === 'link') return item.kind === 'link';
      if (f === 'note') return item.kind === 'note';
      if (f === 'card') return Boolean(item.ui) || item.kind === 'artifact';
      if (f === 'agents') return String(item.writtenBy || 'Owner').toLowerCase() !== 'owner';
      return true;
    });
  }

  function isEditingExpandedCard() {
    const active = document.activeElement;
    if (active && active.closest?.('[data-saved-edit-form]')) return true;
    return Boolean(root.querySelector('[data-saved-edit-form][data-dirty="1"]'));
  }

  function paintShell() {
    const defaultQuickInput = incomingUrl || incomingText || '';
    const defaultQuickNote = incomingUrl && incomingText && incomingText !== incomingUrl ? incomingText : '';

    root.innerHTML = `
      <section class="home-connections hm hm-libpage brain-page" aria-label="${BRAIN_NAME}">
        ${pageTop({ title: BRAIN_NAME, sub: '', hideTitle: true })}
        ${part === 'saved' ? `<input type="search" class="ctl-search" id="saved-search-input" value="${esc(savedViewState.query)}" placeholder="Search saved" aria-label="Search saved items">` : ''}
        <div class="hm-body">
          <nav class="hm-rail brain-rail" aria-label="Parts of ${BRAIN_NAME}">
            <div class="hm-rail-k">${BRAIN_NAME}</div>
            <div class="hm-rail-list" id="saved-rail-list"></div>
          </nav>
          <div class="ctl-scroll">
          <div class="saved-page vault-group">
          <div id="saved-rule-slot"></div>
          ${part === 'files' ? '<input type="file" id="saved-file-input" hidden>' : ''}
          ${part === 'saved' ? `
          <form id="saved-quick-form" class="saved-composer" autocomplete="off">
            <span class="vf-f">
              <input
                type="text"
                id="saved-quick-input"
                name="input"
                value="${esc(defaultQuickInput)}"
                maxlength="${SAVED_TEXT_MAX}"
                placeholder="Paste a link or write a note"
                aria-label="Paste a link or note"
                required
              >
              <button type="submit" class="vf-go" id="saved-quick-submit" aria-label="Save"><svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5l4 4 8-9"/></svg></button>
            </span>
            <div class="saved-composer-extra" id="saved-composer-extra" ${isQuickSaveLaunch ? '' : 'hidden'}>
              <span class="vf-f"><input type="text" name="title" value="${esc(incomingTitle)}" maxlength="${SAVED_TITLE_MAX}" placeholder="Title" aria-label="Title"></span>
              <span class="vf-f"><input type="text" name="note" value="${esc(defaultQuickNote)}" maxlength="${SAVED_NOTE_MAX}" placeholder="Why you saved this (max ${SAVED_NOTE_MAX} chars)" aria-label="Note"></span>
              <span class="vf-f"><input type="text" name="tags" placeholder="Tags, with commas" aria-label="Tags"></span>
            </div>
            <p class="d sm" id="saved-limit-hint" hidden></p>
            <button type="button" class="saved-more-btn" id="saved-more-toggle">${isQuickSaveLaunch ? 'Hide options' : '+ Add note or tags'}</button>
          </form>

          <div id="saved-pills-slot"></div>` : ''}
          ${part === 'schedules' ? `
          <form id="saved-schedule-form" class="saved-sched-form">
            <div class="saved-sched-grid">
              <label class="saved-sched-field"><span>Title</span><input type="text" name="title" class="saved-input sm" placeholder="e.g. Check weekly metrics" required></label>
              <label class="saved-sched-field"><span>Repeat</span><select name="kind" class="saved-input sm" aria-label="Schedule kind">
                <option value="once">Once (minutes or ISO date)</option>
                <option value="daily">Daily (HH:MM)</option>
                <option value="interval">Every N minutes</option>
                <option value="cron">Custom schedule (5-field cron)</option>
              </select></label>
              <label class="saved-sched-field"><span>When</span><input type="text" name="value" class="saved-input sm" placeholder="e.g. 30, 09:00, or 0 9 * * 1" required></label>
              <label class="saved-sched-field"><span>Action</span><select name="action" class="saved-input sm" aria-label="Schedule action">
                <option value="notify">Notify me</option>
                <option value="task">Create Task</option>
                <option value="both">Notify + Task</option>
              </select></label>
            </div>
            <div class="saved-composer-row">
              <label class="saved-sched-field saved-sched-msg"><span>Message (optional)</span><input type="text" name="message" class="saved-input sm" placeholder="Optional details for the reminder or task"></label>
              <button type="submit" class="btn sm fill">Add schedule</button>
            </div>
          </form>` : ''}

        <div id="saved-content"></div>

        ${part === 'saved' ? `<details class="saved-setup-fold">
          <summary>Save from iPhone Share Sheet (Apple Shortcut) or Bookmarklet</summary>
          <div class="saved-setup-body">
            <div class="saved-setup-item">
              <strong>1. Paste directly here or text Loop</strong>
              <p class="d sm">Paste any link above (or press <code>⌘V</code> anywhere on this page) and Loop reads the title and clean text automatically. You can also text links to the <strong>Loop Agent</strong> or tell any agent "save this to my Loop".</p>
            </div>
            <div class="saved-setup-item">
              <strong>2. iPhone &amp; Mac Share Sheet (Apple Shortcut)</strong>
              <p class="d sm">Create an Apple Shortcut that receives URLs and text from the Share Sheet, then runs <em>Get Contents of URL</em>:</p>
              <pre class="jr-code">POST ${esc(origin)}/api/saved
Authorization: Bearer &lt;your Loop agent key&gt;
Content-Type: application/json

{"text": "[Shortcut Input]", "source": "Apple Shortcut"}</pre>
              <button type="button" class="btn sm" id="saved-copy-api">Copy endpoint URL</button>
            </div>
            <div class="saved-setup-item">
              <strong>3. One-click Bookmarklet (no extension)</strong>
              <p class="d sm">Drag this button to your bookmarks bar or copy the script:</p>
              <div class="saved-setup-acts">
                <a class="btn sm" href="${esc(bookmarklet)}">Save to Loop</a>
                <button type="button" class="btn sm" id="saved-copy-bm">Copy bookmarklet</button>
              </div>
            </div>
          </div>
        </details>
` : ''}
          </div>
          </div>
        </div>
      </section>
    `;
  }

  function paintRail() {
    const railList = root.querySelector('#saved-rail-list');
    if (!railList) return;
    const counts = {
      memories: memoryCount,
      saved: savedState.loaded ? savedState.total : undefined,
      files: filesState.loaded ? filesState.items.length : undefined,
      schedules: schedulesState.loaded ? schedulesState.items.length : undefined,
      tasks: tasksState.loaded ? tasksState.total : undefined,
    };
    railList.innerHTML = BRAIN_PARTS.map((p) => brainRow(p.id, part, counts[p.id])).join('');
    wireBrainRows(root.querySelector('.brain-rail'));
  }

  function paintRuleSlot() {
    const slot = root.querySelector('#saved-rule-slot');
    if (!slot) return;
    if (part === 'tasks') {
      slot.innerHTML = '<h2>Tasks</h2>';
      return;
    }
    const activeMode = policiesState.loaded ? policiesState.actions[activeRuleKey] : 'unavailable';
    const ruleOpen = savedViewState.modeOpen === activeRuleKey;
    slot.innerHTML = `
      <h2>${esc(activeRule.what)}${modeHead({ id: activeRuleKey, mode: activeMode, open: ruleOpen, label: activeRule.label })}${part === 'files' ? '<button type="button" id="saved-file-add">+ Add<span class="sr-only"> a file</span></button>' : ''}</h2>
      ${ruleOpen ? modeChoices({ id: activeRuleKey, mode: activeMode, label: activeRule.label, cap: activeRule.cap, error: policiesState.error }) : ''}
    `;
    wireRadioKeys(slot);
    slot.querySelector('#saved-file-add')?.addEventListener('click', () => root.querySelector('#saved-file-input')?.click());

    slot.querySelectorAll('[data-vm-open]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.vmOpen || '';
        savedViewState.modeOpen = savedViewState.modeOpen === key ? '' : key;
        paintRuleSlot();
        slot.querySelector(`[data-vm-open="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
      });
    });

    slot.querySelectorAll('[data-vm-retry]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        await loadAll();
        if (isCurrent()) paintDynamic();
      });
    });

    slot.querySelectorAll('[data-vm-list]').forEach((list) => {
      const key = list.dataset.vmList;
      const meta = SAVED_RULE_META[key];
      if (!meta) return;
      list.querySelectorAll('[data-vm-pick]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (btn.getAttribute('aria-checked') === 'true' || list.classList.contains('is-busy')) return;
          const mode = btn.dataset.vmPick;
          list.classList.add('is-busy');
          list.querySelector('.vm-pass')?.remove();
          const buttons = [...list.querySelectorAll('[data-vm-pick]')];
          const before = buttons.find((b) => b.getAttribute('aria-checked') === 'true') || null;
          const show = (on) => buttons.forEach((b) => b.setAttribute('aria-checked', String(b === on)));
          show(btn);
          try {
            const res = await saveRule(list, {
              what: meta.what,
              passwordName: typeof passwordName === 'function' ? passwordName() : 'Loop password',
              send: (password) => api('/api/policies', {
                method: 'PATCH',
                body: JSON.stringify({ actions: { [key]: mode }, ...(password ? { password } : {}) }),
              }),
              onNoPassword: (err) => {
                if (typeof noGuardPassword === 'function') {
                  noGuardPassword(err);
                  return;
                }
                toast(err?.message || 'Guard needs a Loop password. Set one up in Settings under Security.', 'err');
                location.hash = '#settings?tab=vault';
              },
            });
            list.classList.remove('is-busy');
            if (res?.policies?.actions) {
              const actions = res.policies.actions;
              const defMode = isMode(res?.policies?.default) ? res.policies.default : 'auto';
              policiesState.actions = {
                saved: isMode(actions.saved) ? actions.saved : defMode,
                file: isMode(actions.file) ? actions.file : defMode,
                schedule: isMode(actions.schedule) ? actions.schedule : defMode,
              };
              policiesState.loaded = true;
              policiesState.error = '';
              savedViewState.modeOpen = '';
              paintRuleSlot();
              slot.querySelector(`[data-vm-open="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
            } else {
              show(before);
            }
          } catch (err) {
            list.classList.remove('is-busy');
            show(before);
            toast(err.message || 'Could not update approval rule.', 'err');
          }
        });
      });
    });
  }

  function paintPills() {
    const slot = root.querySelector('#saved-pills-slot');
    if (!slot) return;
    const f = savedViewState.filter;
    const allCount = savedViewState.query.trim()
      ? savedState.queryTotal
      : (savedState.total ?? savedState.items.length);
    const pills = [
      ['all', savedState.loaded ? `All (${allCount})` : 'All'],
      ['link', 'Links'],
      ['note', 'Notes'],
      ['card', 'Cards'],
      ['agents', 'By agents'],
    ];
    slot.innerHTML = `
      <div class="saved-pills" role="group" aria-label="Filter saved items">
        ${pills.map(([key, label]) => `
          <button type="button" class="saved-pill ${f === key ? 'is-active' : ''}" data-saved-filter="${key}" aria-pressed="${f === key}">${esc(label)}</button>
        `).join('')}
      </div>`;
    slot.querySelectorAll('[data-saved-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        savedViewState.filter = btn.dataset.savedFilter || 'all';
        paintPills();
        paintContent();
      });
    });
  }

  function paintContent() {
    const content = root.querySelector('#saved-content');
    if (!content) return;
    pendingListRepaint = false;
    const shown = filteredSaved();
    const viewOpts = {
      profiles,
      activeProject: currentProject(),
      query: savedViewState.query,
      filter: savedViewState.filter,
      total: savedViewState.query.trim()
        ? savedState.queryTotal
        : (savedState.total ?? savedState.items.length),
    };
    content.innerHTML = part === 'files'
      ? renderFilesSection(filesState, esc, viewOpts)
      : part === 'schedules'
        ? renderSchedulesSection(schedulesState, esc, viewOpts)
        : part === 'tasks'
          ? renderTasksSection(tasksState, esc, viewOpts)
          : renderSavedList(savedState, shown, savedViewState.expandedId, esc, viewOpts);

    if (part === 'saved' && savedViewState.expandedId) {
      const expandedItem = shown.find((x) => x.id === savedViewState.expandedId);
      const cardMount = content.querySelector('[data-saved-card-mount]');
      if (expandedItem?.ui && cardMount) {
        const rendered = renderJsonRenderDom(expandedItem.ui, { readOnly: true, titleId: '' });
        cardMount.replaceChildren(rendered.element);
      }
    }

    wireContentEvents(content);
  }

  function paintDynamic({ fromLive = false } = {}) {
    if (!isCurrent() || !root.isConnected) return;
    paintRail();
    paintRuleSlot();
    paintPills();
    if (fromLive && isEditingExpandedCard()) {
      pendingListRepaint = true;
      return;
    }
    paintContent();
  }

  function wireContentEvents(content) {
    content.querySelectorAll('[data-saved-retry]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        await loadAll();
        if (isCurrent()) paintDynamic();
      });
    });

    content.querySelectorAll('[data-saved-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.savedToggle;
        savedViewState.expandedId = savedViewState.expandedId === id ? '' : id;
        paintContent();
      });
    });

    content.querySelectorAll('[data-saved-refresh]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.savedRefresh;
        btn.disabled = true;
        btn.textContent = 'Reading…';
        try {
          await api(`/api/saved/${encodeURIComponent(id)}/refresh`, { method: 'POST', body: '{}' });
          toast('Metadata updated.', 'ok');
          await loadAll();
          paintDynamic();
        } catch (err) {
          toast(err.message || 'Could not refresh link.', 'err');
          btn.disabled = false;
          btn.textContent = 'Refresh';
        }
      });
    });

    content.querySelectorAll('[data-saved-copy]').forEach((btn) => {
      btn.addEventListener('click', () => copyText(btn.dataset.savedCopy || '', 'Copied.'));
    });

    content.querySelectorAll('[data-saved-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.savedDel;
        const item = savedState.items.find((x) => x.id === id);
        const label = item?.title || item?.url || id;
        const proj = formatItemProjects(item, profiles).text;
        if (typeof confirmDialog === 'function') {
          const ok = await confirmDialog({
            title: `Delete "${label}"?`,
            message: `Project: ${proj}. This permanently deletes this saved item from Loop.`,
            confirmLabel: `Delete (${proj})`,
            danger: true,
          });
          if (!ok) return;
        }
        try {
          await api(`/api/saved/${encodeURIComponent(id)}`, { method: 'DELETE' });
          if (savedViewState.expandedId === id) savedViewState.expandedId = '';
          toast('Deleted from Saved.', 'ok');
          await loadAll();
          paintDynamic();
        } catch (err) {
          toast(err.message || 'Could not delete item.', 'err');
        }
      });
    });

    content.querySelectorAll('[data-saved-edit-form]').forEach((form) => {
      form.addEventListener('input', () => {
        form.dataset.dirty = '1';
      });
      form.addEventListener('focusout', () => {
        setTimeout(() => {
          if (pendingListRepaint && !isEditingExpandedCard()) paintContent();
        }, 120);
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = form.dataset.savedEditForm;
        const fd = new FormData(form);
        const note = String(fd.get('note') || '');
        if (note.trim().length > SAVED_NOTE_MAX) {
          toast(`Note must be at most ${SAVED_NOTE_MAX} characters.`, 'err');
          return;
        }
        const tags = String(fd.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean);
        try {
          await api(`/api/saved/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ note, tags }),
          });
          delete form.dataset.dirty;
          toast('Saved changes.', 'ok');
          await loadAll();
          paintDynamic();
        } catch (err) {
          toast(err.message || 'Could not update item.', 'err');
        }
      });
    });

    content.querySelectorAll('[data-saved-more]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Loading…';
        savedState.pageCount = Math.max(savedState.pageCount, savedState.items.length) + SAVED_PAGE_STEP;
        await loadAll();
        if (isCurrent()) paintDynamic();
      });
    });

    content.querySelectorAll('[data-saved-clear-search]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        savedViewState.query = '';
        savedState.pageCount = SAVED_PAGE_STEP;
        const input = root.querySelector('#saved-search-input');
        if (input) input.value = '';
        await loadAll();
        if (isCurrent()) paintDynamic();
      });
    });

    content.querySelectorAll('[data-saved-clear-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        savedViewState.filter = 'all';
        paintPills();
        paintContent();
      });
    });

    content.querySelectorAll('[data-file-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.fileDel;
        const file = filesState.items.find((f) => f.id === id);
        const proj = formatItemProjects(file, profiles).text;
        if (typeof confirmDialog === 'function') {
          const ok = await confirmDialog({
            title: `Delete "${file?.name || id}"?`,
            message: `Project: ${proj}. This permanently deletes this shared file from Loop.`,
            confirmLabel: `Delete (${proj})`,
            danger: true,
          });
          if (!ok) return;
        }
        try {
          await api(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
          toast(`Deleted "${file?.name || 'file'}" (${proj}).`, 'ok');
          await loadAll();
          paintDynamic();
        } catch (err) {
          toast(err.message || 'Could not delete file.', 'err');
        }
      });
    });

    content.querySelectorAll('[data-sched-run]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.schedRun;
        const sched = schedulesState.items.find((s) => s.id === id);
        const proj = formatItemProjects(sched, profiles).text;
        const isFailed = sched?.status === 'failed' || sched?.lastStatus === 'error';
        if (typeof confirmDialog === 'function') {
          const ok = await confirmDialog({
            title: `${isFailed ? 'Retry' : 'Run'} "${sched?.title || id}" now?`,
            message: `Project: ${proj}. Action: ${sched?.action || 'notify'}.`,
            confirmLabel: `${isFailed ? 'Retry' : 'Run now'} (${proj})`,
          });
          if (!ok) return;
        }
        try {
          const res = await api(`/api/schedules/${encodeURIComponent(id)}/run`, { method: 'POST', body: '{}' });
          const taskBit = res?.run?.taskId ? ` Created task ${res.run.taskId}.` : '';
          toast(`Schedule ran (${proj}).${taskBit}`, 'ok');
          await loadAll();
          paintDynamic();
        } catch (err) {
          toast(err.message || 'Could not run schedule.', 'err');
          await loadAll();
          paintDynamic();
        }
      });
    });

    content.querySelectorAll('[data-sched-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.schedDel;
        const sched = schedulesState.items.find((s) => s.id === id);
        const proj = formatItemProjects(sched, profiles).text;
        if (typeof confirmDialog === 'function') {
          const ok = await confirmDialog({
            title: `Delete "${sched?.title || id}"?`,
            message: `Project: ${proj}. This permanently removes the schedule.`,
            confirmLabel: `Delete (${proj})`,
            danger: true,
          });
          if (!ok) return;
        }
        try {
          await api(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
          toast(`Deleted "${sched?.title || 'schedule'}" (${proj}).`, 'ok');
          await loadAll();
          paintDynamic();
        } catch (err) {
          toast(err.message || 'Could not delete schedule.', 'err');
        }
      });
    });

    content.querySelectorAll('[data-task-done]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.taskDone;
        const task = tasksState.items.find((t) => t.id === id);
        try {
          await api(`/api/tasks/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'completed', expectedRevision: task?.revision }),
          });
          toast('Task marked completed.', 'ok');
          await loadAll();
          paintDynamic();
        } catch (err) {
          toast(err.message || 'Could not update task.', 'err');
        }
      });
    });

    content.querySelectorAll('[data-task-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.taskDel;
        const task = tasksState.items.find((t) => t.id === id);
        const proj = formatItemProjects({ projects: task?.project ? [task.project] : ['all'] }, profiles).text;
        if (typeof confirmDialog === 'function') {
          const ok = await confirmDialog({
            title: `Forget "${task?.title || id}"?`,
            message: `Project: ${proj}. This permanently removes the task.`,
            confirmLabel: `Forget (${proj})`,
            danger: true,
          });
          if (!ok) return;
        }
        try {
          await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
          toast('Task forgotten.', 'ok');
          await loadAll();
          paintDynamic();
        } catch (err) {
          toast(err.message || 'Could not delete task.', 'err');
        }
      });
    });
  }

  function wireStaticShell() {
    root.querySelector('#saved-more-toggle')?.addEventListener('click', () => {
      const box = root.querySelector('#saved-composer-extra');
      const btn = root.querySelector('#saved-more-toggle');
      if (!box || !btn) return;
      box.hidden = !box.hidden;
      btn.textContent = box.hidden ? '+ Add note or tags' : 'Hide options';
    });

    const quickForm = root.querySelector('#saved-quick-form');
    const limitHint = root.querySelector('#saved-limit-hint');
    const updateLimitHint = () => {
      if (!quickForm || !limitHint) return;
      const rawInput = String(quickForm.elements.input?.value || '').trim();
      const noteVal = String(quickForm.elements.note?.value || '').trim();
      const titleVal = String(quickForm.elements.title?.value || '').trim();
      const hasUrl = /https?:\/\/[^\s<>()]+/i.test(rawInput);
      const msgs = [];
      if (titleVal.length > SAVED_TITLE_MAX) {
        msgs.push(`Title is ${titleVal.length}/${SAVED_TITLE_MAX} characters.`);
      }
      if (!noteVal && !hasUrl && rawInput.length > 3500) {
        msgs.push(`Note is ${rawInput.length}/${SAVED_NOTE_MAX} characters.`);
      } else if (noteVal.length > 3500) {
        msgs.push(`Annotation is ${noteVal.length}/${SAVED_NOTE_MAX} characters.`);
      }
      if (msgs.length) {
        limitHint.textContent = msgs.join(' ');
        limitHint.hidden = false;
      } else {
        limitHint.hidden = true;
        limitHint.textContent = '';
      }
    };
    quickForm?.addEventListener('input', updateLimitHint);

    quickForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const fd = new FormData(form);
      const rawInput = String(fd.get('input') || '').trim();
      const title = String(fd.get('title') || '').trim();
      const note = String(fd.get('note') || '').trim();
      const tagsRaw = String(fd.get('tags') || '').trim();
      if (!rawInput) return;

      const hasUrl = /https?:\/\/[^\s<>()]+/i.test(rawInput);
      if (title.length > SAVED_TITLE_MAX) {
        toast(`Title must be at most ${SAVED_TITLE_MAX} characters.`, 'err');
        return;
      }
      if (!note && !hasUrl && rawInput.length > SAVED_NOTE_MAX) {
        toast(`Note must be at most ${SAVED_NOTE_MAX} characters (got ${rawInput.length}).`, 'err');
        return;
      }
      if (note.length > SAVED_NOTE_MAX) {
        toast(`Note must be at most ${SAVED_NOTE_MAX} characters (got ${note.length}).`, 'err');
        return;
      }
      if (rawInput.length > SAVED_TEXT_MAX) {
        toast(`Text must be at most ${SAVED_TEXT_MAX} characters.`, 'err');
        return;
      }

      const btn = form.querySelector('#saved-quick-submit');
      btn.disabled = true;

      const payload = {
        text: rawInput,
        ...(title ? { title } : {}),
        ...(note ? { note } : {}),
        ...(tagsRaw ? { tags: tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
        ...(currentProject() !== 'all' ? { project: currentProject() } : {}),
        source: isQuickSaveLaunch ? 'Quick Save' : 'Dashboard',
      };

      try {
        const res = await api('/api/saved', { method: 'POST', body: JSON.stringify(payload) });
        toast(res?.merged ? 'Updated existing saved link.' : 'Saved to Loop.', 'ok');
        if (autoClose) {
          setTimeout(() => { window.close(); }, 650);
          return;
        }
        if (location.pathname === '/save') {
          history.replaceState(null, '', `/${brainHash('saved')}`);
        }
        form.reset();
        updateLimitHint();
        btn.disabled = false;
        if (res?.item?.id) savedViewState.expandedId = res.item.id;
        await loadAll();
        paintDynamic();
      } catch (err) {
        toast(err.message || 'Could not save item.', 'err');
        btn.disabled = false;
      }
    });

    root.querySelector('#saved-file-input')?.addEventListener('change', async (e) => {
      const input = e.currentTarget;
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) {
        toast('File is over the 10 MB limit.', 'err');
        input.value = '';
        return;
      }
      try {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        const contentBase64 = btoa(binary);
        await api('/api/files', {
          method: 'POST',
          body: JSON.stringify({
            name: file.name,
            mimeType: file.type || undefined,
            contentBase64,
            ...(currentProject() !== 'all' ? { project: currentProject() } : {}),
            source: 'Dashboard',
          }),
        });
        input.value = '';
        toast(`Saved file "${file.name}".`, 'ok');
        await loadAll();
        paintDynamic();
      } catch (err) {
        toast(err.message || 'Could not upload file.', 'err');
      }
    });

    let searchTimer = null;
    root.querySelector('#saved-search-input')?.addEventListener('input', (e) => {
      savedViewState.query = e.currentTarget.value;
      savedState.pageCount = SAVED_PAGE_STEP;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        await loadAll();
        if (isCurrent()) paintDynamic();
      }, 180);
    });

    root.querySelector('#saved-schedule-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const fd = new FormData(form);
      const title = String(fd.get('title') || '').trim();
      const message = String(fd.get('message') || '').trim();
      const kind = String(fd.get('kind') || 'once');
      const value = String(fd.get('value') || '').trim();
      const action = String(fd.get('action') || 'notify');
      if (!title) return;
      const payload = {
        title,
        message,
        kind,
        action,
        ...(currentProject() !== 'all' ? { project: currentProject() } : {}),
      };
      if (kind === 'once') {
        if (/^-?\d+(?:\.\d+)?$/.test(value)) {
          const mins = Number(value);
          if (!Number.isInteger(mins) || mins < 1 || mins > 525_600) {
            toast('Delay must be a whole number of minutes between 1 and 525600.', 'err');
            return;
          }
          payload.delayMinutes = mins;
        } else {
          payload.runAt = value;
        }
      } else if (kind === 'daily') {
        if (!value) {
          toast('Enter a daily time in 24-hour HH:MM format (for example 09:00).', 'err');
          return;
        }
        payload.timeOfDay = value;
      } else if (kind === 'interval') {
        const mins = /^\d+$/.test(value) ? Number(value) : NaN;
        if (!Number.isInteger(mins) || mins < 5 || mins > 43_200) {
          toast('Interval must be a whole number of minutes between 5 and 43200.', 'err');
          return;
        }
        payload.intervalMinutes = mins;
      } else if (kind === 'cron') {
        if (!value) {
          toast('Enter a 5-field cron expression (for example 0 9 * * 1).', 'err');
          return;
        }
        payload.cronExpr = value;
      }
      try {
        await api('/api/schedules', { method: 'POST', body: JSON.stringify(payload) });
        form.reset();
        toast('Schedule created.', 'ok');
        await loadAll();
        paintDynamic();
      } catch (err) {
        toast(err.message || 'Could not create schedule.', 'err');
      }
    });

    root.querySelector('#saved-copy-api')?.addEventListener('click', () => {
      copyText(`${origin}/api/saved`, 'Copied /api/saved URL.');
    });
    root.querySelector('#saved-copy-bm')?.addEventListener('click', () => {
      copyText(bookmarklet, 'Copied bookmarklet script.');
    });

    // Paste a URL anywhere on Saved to save it immediately with zero extra clicks.
    const onPagePaste = (e) => {
      if (!root.isConnected || !isCurrent()) {
        window.removeEventListener('paste', onPagePaste);
        return;
      }
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
      const pasted = String(e.clipboardData?.getData('text/plain') || '').trim();
      if (!/^https?:\/\/\S+$/i.test(pasted)) return;
      const quickInput = root.querySelector('#saved-quick-input');
      const quickFormEl = root.querySelector('#saved-quick-form');
      if (!quickInput || !quickFormEl) return;
      e.preventDefault();
      quickInput.value = pasted;
      quickFormEl.requestSubmit();
    };
    window.removeEventListener('paste', savedViewState._pasteHandler);
    savedViewState._pasteHandler = onPagePaste;
    window.addEventListener('paste', onPagePaste);
  }

  paintShell();
  wireStaticShell();
  paintDynamic();

  activeLiveRefresh = async () => {
    if (!root.isConnected || !isCurrent()) {
      activeLiveRefresh = null;
      return false;
    }
    await loadAll();
    if (!root.isConnected || !isCurrent()) return false;
    paintDynamic({ fromLive: true });
    return true;
  };

  // The number of memories comes after the page, so the page never waits for it.
  const proj = currentProject();
  api(`/api/memory${proj !== 'all' ? `?profile=${encodeURIComponent(proj)}` : ''}`).then((res) => {
    if (!isCurrent() || !Array.isArray(res?.memories)) return;
    memoryCount = res.memories.length;
    paintRail();
  }).catch(() => {});
}

export function renderSavedList(savedState, items, expandedId, esc, opts = {}) {
  if (savedState?.error && !savedState?.loaded) {
    return `
      <div class="saved-empty is-error" role="alert">
        <p class="t">Saved items unavailable</p>
        <p class="d sm">${esc(savedState.error)}</p>
        <div><button type="button" class="btn sm" data-saved-retry>Retry</button></div>
      </div>
    `;
  }
  const stale = staleBannerHtml(savedState, 'Saved items', esc);
  const query = String(opts.query || '').trim();
  const filter = String(opts.filter || 'all');
  const profiles = Array.isArray(opts.profiles) ? opts.profiles : [];
  const total = Number.isFinite(Number(opts.total)) ? Number(opts.total) : (savedState?.items?.length || items.length);
  const loadedCount = Array.isArray(savedState?.items) ? savedState.items.length : items.length;
  const hasMore = loadedCount < total;

  if (!items.length) {
    if (query) {
      return `${stale}
        <div class="saved-empty">
          <p class="t">No saved items match "${esc(query)}".</p>
          <p class="d sm">Try a different keyword or clear the search filter.</p>
          <div><button type="button" class="btn sm" data-saved-clear-search>Clear search</button></div>
        </div>
      `;
    }
    if (filter !== 'all' && loadedCount > 0) {
      return `${stale}
        <div class="saved-empty">
          <p class="t">No saved items in this filter.</p>
          <p class="d sm">Switch back to All to see your other saved items.</p>
          <div><button type="button" class="btn sm" data-saved-clear-filter>Show all</button></div>
        </div>
      `;
    }
    return `${stale}
      <div class="saved-empty">
        <p class="t">Nothing saved here yet.</p>
        <p class="d sm">Paste a link above, text a link to the Loop Agent, or tell any connected agent "save this to my Loop".</p>
      </div>
    `;
  }
  return `${stale}
    <ul class="saved-list">
      ${items.map((item) => {
        const isOpen = item.id === expandedId;
        const proj = formatItemProjects(item, profiles);
        const metaBits = [
          item.domain || item.kind,
          ago(item.updatedAt),
          item.writtenBy && item.writtenBy !== 'Owner' ? item.writtenBy : (item.source !== 'Dashboard' ? item.source : 'You'),
          ...(proj.namedIds.length ? proj.labels : []),
        ].filter(Boolean);
        const showPrimaryPreview = item.kind === 'note' && item.markdown && item.markdown !== item.displayTitle;
        return `
          <li class="saved-card ${isOpen ? 'is-open' : ''}">
            <div class="saved-card-head">
              <button type="button" class="saved-card-main" data-saved-toggle="${esc(item.id)}" aria-expanded="${isOpen}">
                <span class="saved-glyph ${item.ui ? 'is-card' : ''}" aria-hidden="true">${kindGlyph(item)}</span>
                <span class="saved-card-copy">
                  <span class="saved-meta">${esc(metaBits.join(' · '))}${item.fetchStatus === 'pending' ? ' · reading…' : ''}</span>
                  <span class="saved-title">${esc(item.displayTitle)}</span>
                  ${showPrimaryPreview ? `<span class="saved-summary">${esc(item.markdown.slice(0, 240))}</span>` : ''}
                  ${item.note ? `<span class="saved-note">${esc(item.note)}</span>` : ''}
                  ${!item.note && !showPrimaryPreview && item.summary ? `<span class="saved-summary">${esc(item.summary)}</span>` : ''}
                  ${item.tags?.length ? `<span class="saved-tags">${item.tags.map((t) => `<span class="mem-list-tag">#${esc(t)}</span>`).join('')}</span>` : ''}
                </span>
              </button>
              <div class="saved-card-acts">
                ${item.url ? `<a class="btn sm" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">Open</a>` : ''}
                <button type="button" class="btn sm" data-saved-copy="${esc(item.url || item.markdown || item.note || item.displayTitle)}">Copy</button>
              </div>
            </div>
            ${isOpen ? `
              <div class="saved-card-body">
                ${item.ui ? '<div class="saved-jr-mount" data-saved-card-mount></div>' : ''}
                ${item.summary && item.note ? `<p class="d sm"><strong>Summary:</strong> ${esc(item.summary)}</p>` : ''}
                ${item.markdown ? `<div class="saved-md">${renderSkillMarkdown(item.markdown.slice(0, 12000))}</div>` : ''}
                <form class="saved-edit-form" data-saved-edit-form="${esc(item.id)}">
                  <label class="jr-field">
                    <span class="jr-field-lbl">Your note</span>
                    <textarea name="note" rows="2" maxlength="${SAVED_NOTE_MAX}" class="jr-input">${esc(item.note || '')}</textarea>
                  </label>
                  <label class="jr-field">
                    <span class="jr-field-lbl">Tags</span>
                    <input type="text" name="tags" class="jr-input" value="${esc((item.tags || []).join(', '))}" placeholder="comma separated tags">
                  </label>
                  <div class="saved-edit-acts">
                    <button type="submit" class="btn sm fill">Save note</button>
                    ${item.url ? `<button type="button" class="btn sm" data-saved-refresh="${esc(item.id)}">Refresh</button>` : ''}
                    <button type="button" class="btn sm danger-text" data-saved-del="${esc(item.id)}">Delete</button>
                  </div>
                </form>
              </div>
            ` : ''}
          </li>
        `;
      }).join('')}
    </ul>
    ${hasMore ? `
      <div class="saved-pager">
        <span class="d sm">Showing ${loadedCount} of ${total}</span>
        <button type="button" class="btn sm" data-saved-more>Load more</button>
      </div>` : ''}
  `;
}

export function renderFilesSection(filesState, esc, opts = {}) {
  if (filesState?.error && !filesState?.loaded) {
    return `
      <div class="saved-empty is-error" role="alert">
        <p class="t">Files unavailable</p>
        <p class="d sm">${esc(filesState.error)}</p>
        <div><button type="button" class="btn sm" data-saved-retry>Retry</button></div>
      </div>
    `;
  }
  const files = Array.isArray(filesState?.items) ? filesState.items : [];
  const stale = staleBannerHtml(filesState, 'Files', esc);
  const profiles = Array.isArray(opts.profiles) ? opts.profiles : [];
  const activeProject = opts.activeProject || 'all';
  if (!files.length) {
    return `${stale}
      <div class="saved-empty">
        <p class="t">No dropped files yet.</p>
        <p class="d sm">Choose "+ Add" to share a PDF, CSV, Markdown, or text file with all your agents.</p>
      </div>
    `;
  }
  return `${stale}
    <ul class="saved-list">
      ${files.map((f) => {
        const proj = formatItemProjects(f, profiles);
        const other = isOtherProjectItem(proj, activeProject);
        return `
        <li class="saved-card" data-file-id="${esc(f.id)}" data-project="${esc(proj.text)}">
          <div class="saved-card-head">
            <div class="saved-card-main">
              <span class="saved-glyph" aria-hidden="true">📄</span>
              <span class="saved-card-copy">
                <span class="saved-meta">${esc(f.mimeType)} · ${esc(formatBytes(f.sizeBytes))} · ${esc(ago(f.updatedAt))} · ${esc(f.writtenBy)}</span>
                <span class="saved-title-row"><span class="saved-title">${esc(f.name)}</span><span class="saved-proj-badge${other ? ' is-other' : ''}" data-item-project="${esc(proj.text)}">${esc(proj.text)}</span></span>
                ${f.note ? `<span class="saved-note">${esc(f.note)}</span>` : ''}
                <span class="d sm">${f.hasText ? 'Readable text indexed for agents' : 'Binary attachment'}</span>
              </span>
            </div>
            <div class="saved-card-acts">
              <a class="btn sm" href="/api/files/${encodeURIComponent(f.id)}/content" download="${esc(f.name)}">Download</a>
              <button type="button" class="btn sm danger-text" data-file-del="${esc(f.id)}" aria-label="Delete ${esc(f.name)} (${esc(proj.text)})">Delete</button>
            </div>
          </div>
        </li>`;
      }).join('')}
    </ul>
  `;
}

export function renderSchedulesSection(schedulesState, esc, opts = {}) {
  if (schedulesState?.error && !schedulesState?.loaded) {
    return `
      <div class="saved-empty is-error" role="alert">
        <p class="t">Schedules unavailable</p>
        <p class="d sm">${esc(schedulesState.error)}</p>
        <div><button type="button" class="btn sm" data-saved-retry>Retry</button></div>
      </div>
    `;
  }
  const schedules = Array.isArray(schedulesState?.items) ? schedulesState.items : [];
  const stale = staleBannerHtml(schedulesState, 'Schedules', esc);
  const profiles = Array.isArray(opts.profiles) ? opts.profiles : [];
  const activeProject = opts.activeProject || 'all';
  if (!schedules.length) {
    return `${stale}
      <div class="saved-empty">
        <p class="t">No schedules yet.</p>
        <p class="d sm">Create a reminder above or tell any agent "remind me every Monday at 9am to check open tasks".</p>
      </div>
    `;
  }
  return `${stale}
    <ul class="saved-list">
      ${schedules.map((s) => {
        const isFailed = s.status === 'failed' || s.lastStatus === 'error';
        const proj = formatItemProjects(s, profiles);
        const other = isOtherProjectItem(proj, activeProject);
        const stateText = isFailed
          ? 'Failed'
          : s.nextRunAt
            ? `Next: ${new Date(s.nextRunAt).toLocaleString()}`
            : s.status === 'paused'
              ? 'Paused'
              : 'Completed';
        return `
        <li class="saved-card${isFailed ? ' is-failed' : ''}" data-sched-id="${esc(s.id)}" data-project="${esc(proj.text)}">
          <div class="saved-card-head">
            <div class="saved-card-main">
              <span class="saved-glyph" aria-hidden="true">⏰</span>
              <span class="saved-card-copy">
                <span class="saved-meta">${esc(s.kind)} · ${esc(s.action)} · ${esc(s.status)} · ${esc(s.timezone)}</span>
                <span class="saved-title-row"><span class="saved-title">${esc(s.title)}</span><span class="saved-proj-badge${other ? ' is-other' : ''}" data-item-project="${esc(proj.text)}">${esc(proj.text)}</span></span>
                ${s.message ? `<span class="saved-note">${esc(s.message)}</span>` : ''}
                ${isFailed && s.lastError ? `<span class="saved-note no">${esc(s.lastError)}</span>` : ''}
                <span class="d sm">${esc(stateText)} · Runs: ${s.runCount}${s.lastTaskId ? ` · Task: ${esc(s.lastTaskId)}` : ''}</span>
              </span>
            </div>
            <div class="saved-card-acts">
              <button type="button" class="btn sm" data-sched-run="${esc(s.id)}" aria-label="${isFailed ? 'Retry' : 'Run now'} ${esc(s.title)} (${esc(proj.text)})">${isFailed ? 'Retry' : 'Run now'}</button>
              <button type="button" class="btn sm danger-text" data-sched-del="${esc(s.id)}" aria-label="Delete ${esc(s.title)} (${esc(proj.text)})">Delete</button>
            </div>
          </div>
        </li>`;
      }).join('')}
    </ul>
  `;
}

export function renderTasksSection(tasksState, esc, opts = {}) {
  if (tasksState?.error && !tasksState?.loaded) {
    return `
      <div class="saved-empty is-error" role="alert">
        <p class="t">Tasks unavailable</p>
        <p class="d sm">${esc(tasksState.error)}</p>
        <div><button type="button" class="btn sm" data-saved-retry>Retry</button></div>
      </div>
    `;
  }
  const tasks = Array.isArray(tasksState?.items) ? tasksState.items : [];
  const stale = staleBannerHtml(tasksState, 'Tasks', esc);
  const profiles = Array.isArray(opts.profiles) ? opts.profiles : [];
  const activeProject = opts.activeProject || 'all';
  if (!tasks.length) {
    return `${stale}
      <div class="saved-empty">
        <p class="t">No tasks yet.</p>
        <p class="d sm">Tasks appear here when an agent hands off ongoing work or a schedule creates a task.</p>
      </div>
    `;
  }
  return `${stale}
    <ul class="saved-list">
      ${tasks.map((t) => {
        const proj = formatItemProjects({ projects: t.project ? [t.project] : ['all'] }, profiles);
        const other = isOtherProjectItem(proj, activeProject);
        const isOpen = t.status === 'active' || t.status === 'waiting';
        const metaBits = [
          t.status,
          t.assignedTo ? `Assigned: ${t.assignedTo}` : '',
          t.requestedBy ? `From: ${t.requestedBy}` : '',
          ago(t.updatedAt),
        ].filter(Boolean);
        return `
        <li class="saved-card" data-task-id="${esc(t.id)}" data-project="${esc(proj.text)}">
          <div class="saved-card-head">
            <div class="saved-card-main">
              <span class="saved-glyph" aria-hidden="true">☑</span>
              <span class="saved-card-copy">
                <span class="saved-meta">${esc(metaBits.join(' · '))}</span>
                <span class="saved-title-row"><span class="saved-title">${esc(t.title)}</span><span class="saved-proj-badge${other ? ' is-other' : ''}" data-item-project="${esc(proj.text)}">${esc(proj.text)}</span></span>
                ${t.nextStep ? `<span class="saved-note">Next: ${esc(t.nextStep)}</span>` : ''}
                ${t.result ? `<span class="saved-summary">Result: ${esc(t.result)}</span>` : ''}
              </span>
            </div>
            <div class="saved-card-acts">
              ${isOpen ? `<button type="button" class="btn sm" data-task-done="${esc(t.id)}">Complete</button>` : ''}
              <button type="button" class="btn sm danger-text" data-task-del="${esc(t.id)}">Forget</button>
            </div>
          </div>
        </li>`;
      }).join('')}
    </ul>
  `;
}
