// Global Cmd+K / Ctrl+K Command Palette for Loop (Linear / Raycast pattern).
// Zero external dependencies, native <dialog data-modal="keep">, strict CSP compliant.
import { esc } from '../core/utils.js';

function scoreMatch(item, query) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const title = String(item.title || '').toLowerCase();
  const sub = String(item.subtitle || '').toLowerCase();
  const group = String(item.group || '').toLowerCase();
  const kw = String(item.keywords || '').toLowerCase();
  const all = `${title} ${sub} ${group} ${kw}`;

  if (title === q) return 100;
  if (title.startsWith(q)) return 85;
  if (title.includes(q)) return 70;
  if (sub.includes(q) || group.includes(q) || kw.includes(q)) return 55;

  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((t) => all.includes(t))) return 45;

  // Subsequence fuzzy check only against the item title (never across long descriptions)
  if (tokens.length === 1 && q.length >= 2) {
    let hi = 0;
    for (let qi = 0; qi < q.length; qi += 1) {
      hi = title.indexOf(q[qi], hi);
      if (hi === -1) return 0;
      hi += 1;
    }
    return 25;
  }
  return 0;
}

function groupRanked(scored) {
  const groups = new Map();
  for (const entry of scored) {
    const g = entry.item.group || '';
    let bucket = groups.get(g);
    if (!bucket) {
      bucket = { group: g, bestScore: entry.score, bestRank: entry.item.rank ?? 50, entries: [] };
      groups.set(g, bucket);
    }
    if (entry.score > bucket.bestScore) bucket.bestScore = entry.score;
    if ((entry.item.rank ?? 50) < bucket.bestRank) bucket.bestRank = entry.item.rank ?? 50;
    bucket.entries.push(entry);
  }
  const ordered = [...groups.values()].sort((a, b) => b.bestScore - a.bestScore || a.bestRank - b.bestRank);
  return ordered.flatMap((b) =>
    b.entries.sort((a, c) => c.score - a.score || (a.item.rank ?? 50) - (c.item.rank ?? 50)).map((e) => e.item),
  );
}

export function initCommandPalette({ getSources, navigate, onAction, isEnabled }) {
  let dlg = null;
  let items = [];
  let filtered = [];
  let activeIdx = 0;
  let query = '';
  let loading = false;

  function close() {
    if (!dlg) return;
    const ref = dlg;
    dlg = null;
    if (ref.open) ref.close();
    ref.remove();
  }

  function renderList() {
    if (!dlg) return;
    const listEl = dlg.querySelector('#cmdk-list');
    if (!listEl) return;
    const q = query.trim();
    const scored = items
      .map((item) => ({ item, score: scoreMatch(item, q) }))
      .filter((r) => r.score > 0);
    filtered = groupRanked(scored).slice(0, 32);

    if (activeIdx >= filtered.length) activeIdx = Math.max(0, filtered.length - 1);

    if (loading && filtered.length === 0) {
      listEl.innerHTML = '<div class="cmdk-empty">Loading workspace…</div>';
      return;
    }
    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="cmdk-empty">No matches for "${esc(q)}"</div>`;
      return;
    }

    let lastGroup = '';
    const html = [];
    filtered.forEach((item, idx) => {
      if (item.group && item.group !== lastGroup) {
        lastGroup = item.group;
        html.push(`<div class="cmdk-group" role="presentation">${esc(item.group)}</div>`);
      }
      const active = idx === activeIdx;
      html.push(`
        <button type="button" class="cmdk-row ${active ? 'is-active' : ''}" role="option" id="cmdk-opt-${idx}" aria-selected="${active}" data-cmdk-idx="${idx}">
          <span class="cmdk-main">
            <span class="cmdk-t">${esc(item.title)}</span>
            ${item.subtitle ? `<span class="cmdk-s">${esc(item.subtitle)}</span>` : ''}
          </span>
          ${item.badge ? `<span class="cmdk-badge">${esc(item.badge)}</span>` : ''}
        </button>
      `);
    });
    listEl.innerHTML = html.join('');
    listEl.querySelectorAll('[data-cmdk-idx]').forEach((btn) => {
      btn.addEventListener('mouseenter', () => {
        activeIdx = Number(btn.dataset.cmdkIdx);
        updateActiveClass();
      });
      btn.addEventListener('click', () => runIndex(Number(btn.dataset.cmdkIdx)));
    });
    updateActiveClass();
  }

  function updateActiveClass() {
    if (!dlg) return;
    const input = dlg.querySelector('#cmdk-input');
    dlg.querySelectorAll('.cmdk-row').forEach((row) => {
      const isCur = Number(row.dataset.cmdkIdx) === activeIdx;
      row.classList.toggle('is-active', isCur);
      row.setAttribute('aria-selected', String(isCur));
      if (isCur) row.scrollIntoView({ block: 'nearest' });
    });
    if (input && filtered[activeIdx]) {
      input.setAttribute('aria-activedescendant', `cmdk-opt-${activeIdx}`);
    } else if (input) {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function runIndex(idx) {
    const picked = filtered[idx];
    if (!picked) return;
    close();
    if (picked.href) navigate(picked.href);
    else if (typeof picked.run === 'function') picked.run();
    else if (picked.action) onAction(picked.action, picked.payload);
  }

  async function open() {
    if (typeof isEnabled === 'function' && !isEnabled()) return;
    if (dlg) {
      close();
      return;
    }
    query = '';
    activeIdx = 0;
    loading = true;

    dlg = document.createElement('dialog');
    dlg.className = 'cmdk-dialog';
    dlg.setAttribute('data-modal', 'keep');
    dlg.setAttribute('aria-label', 'Command palette');
    dlg.innerHTML = `
      <div class="cmdk-box">
        <div class="cmdk-head">
          <svg class="cmdk-ic" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="9" r="5.5"/><path d="M13.5 13.5L17 17"/></svg>
          <input type="search" id="cmdk-input" class="cmdk-input" placeholder="Jump to a connection, agent, memory, secret, or action…" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="cmdk-list" aria-autocomplete="list">
          <kbd class="cmdk-kbd">Esc</kbd>
        </div>
        <div id="cmdk-list" class="cmdk-list" role="listbox" aria-label="Results"></div>
        <div class="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> Move</span>
          <span><kbd>↵</kbd> Open</span>
          <span><kbd>Esc</kbd> Close</span>
        </div>
      </div>
    `;

    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      close();
    });
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) close();
    });

    const input = dlg.querySelector('#cmdk-input');
    input.addEventListener('input', () => {
      query = input.value;
      activeIdx = 0;
      renderList();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (filtered.length > 0) {
          activeIdx = (activeIdx + 1) % filtered.length;
          updateActiveClass();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (filtered.length > 0) {
          activeIdx = (activeIdx - 1 + filtered.length) % filtered.length;
          updateActiveClass();
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runIndex(activeIdx);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });

    document.body.appendChild(dlg);
    dlg.showModal();
    input.focus();

    items = buildBaseCommands();
    renderList();

    try {
      const extra = await getSources();
      if (!dlg) return;
      items = [...buildBaseCommands(), ...(Array.isArray(extra) ? extra : [])];
    } catch {
      // Keep base commands if live fetch fails
    } finally {
      loading = false;
      if (dlg) renderList();
    }
  }

  function buildBaseCommands() {
    return [
      { group: 'Actions', rank: 1, title: 'Save a link or note', subtitle: 'Add a URL, note, or file to the Library', href: '#knowledge/saved', keywords: 'bookmark clip save url link' },
      { group: 'Actions', rank: 2, title: 'Add connection', subtitle: 'Connect a Cloud or Local MCP server', action: 'add-connection', keywords: 'new mcp server url' },
      { group: 'Actions', rank: 3, title: 'Add agent', subtitle: 'Claude Code, Codex, Cursor, a text agent, and more', action: 'add-agent', keywords: 'connect install harness key invite' },
      { group: 'Actions', rank: 4, title: 'New project', subtitle: 'Create a named Project drawer', action: 'new-project', keywords: 'create profile folder' },
      { group: 'Navigate', rank: 10, title: 'Home', subtitle: 'Connections, agents, and approvals', href: '#home', keywords: 'dashboard overview' },
      { group: 'Navigate', rank: 11, title: 'Library', subtitle: 'Memories, saved links and notes, files, and schedules', href: '#knowledge', keywords: 'knowledge brain memory memories saved notes facts graph dream tidy' },
      { group: 'Navigate', rank: 12, title: 'Saved', subtitle: 'Links, notes, and rich cards in the Library', href: '#knowledge/saved', keywords: 'bookmarks clips artifacts memory' },
      { group: 'Navigate', rank: 12, title: 'Files', subtitle: 'Files in the Library that your agents share', href: '#knowledge/files', keywords: 'upload drop documents' },
      { group: 'Navigate', rank: 12, title: 'Schedules', subtitle: 'Reminders and repeat jobs in the Library', href: '#knowledge/schedules', keywords: 'reminders cron' },
      { group: 'Navigate', rank: 12, title: 'Tasks', subtitle: 'Ongoing work and agent handoffs in the Library', href: '#knowledge/tasks', keywords: 'tasks handoff inbox assigned todo' },
      { group: 'Navigate', rank: 12, title: 'Vault', subtitle: 'Encrypted API keys, logins, and cards', href: '#vault', keywords: 'secrets passwords credentials' },
      { group: 'Navigate', rank: 13, title: 'Skills', subtitle: 'Reusable workflows and system guides', href: '#skills', keywords: 'guides procedures' },
      { group: 'Navigate', rank: 14, title: 'Settings', subtitle: 'Loop Text, security, and plan', href: '#settings', keywords: 'preferences billing' },
    ];
  }

  const onKeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      if (typeof isEnabled === 'function' && !isEnabled()) return;
      e.preventDefault();
      open();
    }
  };
  document.addEventListener('keydown', onKeydown);

  return { open, close, destroy: () => { close(); document.removeEventListener('keydown', onKeydown); } };
}
