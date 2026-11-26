// Library, Memories (#knowledge): what the map shows beside memories, and how items join.
//
// A memory is one fact. A source is a saved web page or a file as it came in. A note is a page that a person
// or an agent wrote from sources and facts. This file adds sources, notes, tasks and people to the
// map of memories as layers, shows the links of an item in its card, makes a new link, and gathers
// items into one note. memory-view.js owns the page and calls in here; the server side is
// lib/library.mjs.

import { renderSkillMarkdown } from './skill-markdown.js';

// The layers, in the sequence of the control on the map. `mark` is the shape an item has there.
export const LAYERS = [
  { id: 'saved', label: 'Saved', what: 'notes, web pages and cards', mark: 'saved' },
  { id: 'files', label: 'Files', what: 'files', mark: 'file' },
  { id: 'tasks', label: 'Tasks', what: 'tasks', mark: 'task' },
  { id: 'people', label: 'People', what: 'the agents and people who wrote the items', mark: 'agent' },
];
const LAYER_OF_KIND = { saved: 'saved', file: 'files', task: 'tasks', agent: 'people', person: 'people' };
const LAYER_KEY = 'loop.library.layers';
export const MAX_GATHER = 40;

// How a link reads from the item it starts at, and from the item it goes to.
const RELATION_WORDS = {
  relates: 'relates to',
  derived_from: 'made from',
  cites: 'cites',
  part_of: 'part of',
  extends: 'extends',
  updates: 'updates',
  contradicts: 'contradicts',
};
const RELATION_BACK = {
  relates: 'relates to',
  derived_from: 'used in',
  cites: 'cited by',
  part_of: 'contains',
  extends: 'extended by',
  updates: 'updated by',
  contradicts: 'contradicts',
};
const RELATION_ORDER = ['relates', 'derived_from', 'cites', 'part_of', 'extends', 'updates', 'contradicts'];

const ICON_PLUS = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M7 2.5v9M2.5 7h9"/></svg>';
const ICON_X = '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';

export const isMemoryId = (id) => typeof id === 'string' && !/^(sav_|file_|task_|agent:|person:)/.test(id);

/** The layer that shows an item with this id, or null for a memory. */
export function layerOfId(id) {
  const s = String(id || '');
  if (s.startsWith('sav_')) return 'saved';
  if (s.startsWith('file_')) return 'files';
  if (s.startsWith('task_')) return 'tasks';
  if (s.startsWith('agent:') || s.startsWith('person:')) return 'people';
  return null;
}

/** The colour group of an item (app.css): a kind of memory, or notes, sources, tasks, people. */
export function groupClass(item) {
  const kind = item?.kind || 'memory';
  if (kind === 'memory') return `s-${['global', 'preference', 'project', 'fact'].includes(item?.scope || item?.sub) ? item.scope || item.sub : 'global'}`;
  if (kind === 'saved') return item.sub === 'link' ? 'k-sources' : 'k-notes';
  if (kind === 'file') return 'k-sources';
  if (kind === 'task') return 'k-tasks';
  return 'k-people';
}

/** The shape of an item on the map, as a word for data-kind. */
export const markOf = (item) => (item?.kind === 'person' ? 'person' : item?.kind && item.kind !== 'memory' ? item.kind : 'memory');

/** What an item is, in one word. */
export function kindWord(item) {
  const kind = item?.kind || 'memory';
  if (kind === 'saved') return item.sub === 'link' ? 'Web page' : item.sub === 'artifact' ? 'Card' : 'Note';
  if (kind === 'file') return 'File';
  if (kind === 'task') return 'Task';
  if (kind === 'agent') return 'Agent';
  if (kind === 'person') return item.sub === 'guest' || item.guest ? 'Guest' : 'Owner';
  return 'Memory';
}

function readLayers() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYER_KEY) || '[]');
    return new Set((Array.isArray(saved) ? saved : []).filter((id) => LAYERS.some((l) => l.id === id)));
  } catch {
    return new Set();
  }
}

// What the last answer was for these layers in this Project, so a redraw of the page shows the
// layers at once and not a moment later.
let lastAnswer = { key: '', extra: null, text: '' };
const EMPTY = Object.freeze({ nodes: [], edges: [], layers: {}, memoryDegree: {} });

/** The layers of the map: which are on, what they hold, and the control that turns them on. */
export function createLibraryMap({ api, esc, profile }) {
  const layers = readLayers();
  const keyNow = () => `${profile() || 'all'}|${[...layers].sort().join(',')}`;
  let extra = lastAnswer.key === keyNow() && lastAnswer.extra ? lastAnswer.extra : EMPTY;
  let byId = new Map(extra.nodes.map((n) => [n.id, n]));
  const memo = { graph: null, extra: null, out: null };

  return {
    layers,
    has: (id) => layers.has(id),
    node: (id) => byId.get(id) || null,
    nodes: () => extra.nodes,
    counts: () => extra.layers || {},

    set(id, on) {
      if (!LAYERS.some((l) => l.id === id)) return;
      if (on) layers.add(id);
      else layers.delete(id);
      try { localStorage.setItem(LAYER_KEY, JSON.stringify([...layers])); } catch { /* this device only */ }
    },

    /** Gets what the layers add. Resolves true when the map must change: the answer is new and for the layers that are on now. */
    async load() {
      const key = keyNow();
      const p = profile();
      const query = [`layers=${[...layers].join(',')}`, p && p !== 'all' ? `profile=${encodeURIComponent(p)}` : ''].filter(Boolean).join('&');
      let res;
      try {
        res = await api(`/api/library/map?${query}`);
      } catch {
        return false; // the map of memories shows without the layers
      }
      if (key !== keyNow()) return false;
      const next = {
        nodes: Array.isArray(res?.nodes) ? res.nodes : [],
        edges: Array.isArray(res?.edges) ? res.edges : [],
        layers: res?.layers || {},
        memoryDegree: res?.memoryDegree || {},
      };
      // The same answer as the map shows now: nothing moves.
      const text = JSON.stringify(next);
      if (lastAnswer.key === key && lastAnswer.text === text && extra === lastAnswer.extra) return false;
      extra = next;
      byId = new Map(extra.nodes.map((n) => [n.id, n]));
      lastAnswer = { key, extra, text };
      return true;
    },

    /** The graph of memories with the layers on it. The same graph comes back until one of them changes. */
    merge(graph) {
      if (memo.graph === graph && memo.extra === extra) return memo.out;
      const bump = extra.memoryDegree || {};
      const nodes = [
        ...(graph.nodes || []).map((n) => (bump[n.id] ? { ...n, degree: (n.degree || 0) + bump[n.id] } : n)),
        ...extra.nodes,
      ];
      const ids = new Set(nodes.map((n) => n.id));
      const edges = [...(graph.edges || []), ...extra.edges.filter((e) => ids.has(e.source) && ids.has(e.target))];
      Object.assign(memo, { graph, extra, out: { ...graph, nodes, edges } });
      return memo.out;
    },

    // The control at the map's lower left. It is also the key to the shapes on the map.
    controlHtml() {
      const counts = extra.layers || {};
      return `<div class="lib-layers" role="group" aria-label="Show on the map">${LAYERS.map((l) => {
        const on = layers.has(l.id);
        const c = on ? counts[l.id] : null;
        const n = c ? (c.total > c.shown ? `${c.shown} of ${c.total}` : String(c.shown)) : '';
        const title = on
          ? `Hide ${l.what}${c && c.total > c.shown ? `. The map shows the ${c.shown} that have links or are newest.` : ''}`
          : `Show ${l.what} on the map`;
        return `<button type="button" class="lib-layer" data-lib-layer="${l.id}" aria-pressed="${on}" title="${esc(title)}"><i class="lib-mark" data-kind="${l.mark}" aria-hidden="true"></i><span class="lib-layer-l">${l.label}</span>${n ? `<span class="lib-layer-n">${esc(n)}</span>` : ''}</button>`;
      }).join('')}</div>`;
    },
  };
}

/* ---------------- the card of an item that is not a memory ---------------- */

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function fileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// [[an id or a name]] in a page becomes a button that goes to that item, when Loop found it.
// The button says what the writer wrote: the label, or the name. An id shows as the item's title.
function withRefs(html, refs, esc) {
  if (!refs || !html.includes('[[')) return html;
  return html.replace(/\[\[([^\]|\n<&]{1,120})(?:\|([^\]\n<&]{0,80}))?\]\]/g, (all, target, label) => {
    const name = target.trim();
    const hit = refs[name];
    if (!hit) return all;
    const text = (label || '').trim() || (/^(mem|sav|file|task)_[0-9a-f]+$/i.test(name) ? clip(hit.title, 32) : name);
    return `<button type="button" class="lib-ref ${groupClass(hit)}" data-node-link="${esc(hit.id)}" title="${esc(clip(hit.title, 200))}">${esc(text)}</button>`;
  });
}

// The card shows the title of a page above it, so a first heading that says the same goes.
function withoutTitle(markdown, title) {
  const first = /^\s*#\s+(.+?)\s*#*\s*(?:\n|$)/.exec(markdown);
  const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  return first && same(first[1], String(title || '')) ? markdown.slice(first[0].length) : markdown;
}

/**
 * What the card shows for an item that is not a memory. `node` is the item as the map has it, and
 * `detail` is the answer of /api/library/item (null until it comes).
 */
export function itemBodyHtml(node, detail, esc) {
  const it = detail?.item;
  if (!it) return node.content ? `<p class="lib-read-p">${esc(node.content)}</p>` : '';
  const parts = [];
  if (it.kind === 'saved') {
    if (it.url) parts.push(`<a class="lib-url" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.domain || it.url)}</a>`);
    if (it.note) parts.push(`<p class="lib-read-p">${esc(it.note)}</p>`);
    if (it.ui) parts.push('<p class="lib-read-p is-soft">This item is a card. Open it in Saved to see it.</p>');
    else if (it.markdown) parts.push(`<div class="lib-read-md skill-markdown">${withRefs(renderSkillMarkdown(withoutTitle(it.markdown, it.title || node.title).slice(0, 12000)), detail.refs, esc)}</div>`);
    else if (it.summary) parts.push(`<p class="lib-read-p">${esc(it.summary)}</p>`);
  } else if (it.kind === 'file') {
    parts.push(`<p class="lib-read-p is-soft">${esc([it.mimeType, fileSize(it.sizeBytes)].filter(Boolean).join(' · '))}</p>`);
    if (it.note) parts.push(`<p class="lib-read-p">${esc(it.note)}</p>`);
    if (it.text) parts.push(`<pre class="lib-read-pre">${esc(it.text.slice(0, 4000))}</pre>`);
  } else if (it.kind === 'task') {
    if (it.objective) parts.push(`<p class="lib-read-p">${esc(it.objective)}</p>`);
    if (it.nextStep) parts.push(`<p class="lib-read-p"><b>Next</b> ${esc(it.nextStep)}</p>`);
    if (it.result) parts.push(`<p class="lib-read-p"><b>Result</b> ${esc(it.result)}</p>`);
    if (it.notes) parts.push(`<p class="lib-read-p is-soft">${esc(clip(it.notes, 600))}</p>`);
  }
  return parts.join('');
}

/** The line under the text of the card: what the item is, who wrote it, its tags. */
export function itemMetaHtml(node, detail, esc) {
  const it = detail?.item || {};
  const who = String(it.writtenBy || node.writtenBy || '');
  const by = who && who !== 'Owner' && !who.startsWith('Owner (') ? who : '';
  const status = node.kind === 'task' ? String(it.status || node.sub || '') : '';
  return [
    `<span class="mem-node-kind">${esc(kindWord(node))}</span>`,
    status ? `<span>${esc(status)}</span>` : '',
    by ? `<span>by ${esc(by)}</span>` : '',
    ...(node.tags || []).slice(0, 6).map((t) => `<span>#${esc(t)}</span>`),
  ].join('');
}

/** Where an item opens in its own part of Library, or '' for one that has no page. */
export function openHashOf(node) {
  if (node?.kind === 'saved') return `#knowledge/saved?focus=${encodeURIComponent(node.id)}`;
  if (node?.kind === 'file') return '#knowledge/files';
  if (node?.kind === 'task') return '#knowledge/tasks';
  return '';
}

/* ---------------- the links of an item ---------------- */

const linkRow = (item, word, esc, removeId = '') => `
  <div class="lib-link-row">
    <button type="button" class="mem-node-link ${groupClass(item)}" data-node-link="${esc(item.id)}" title="${esc(clip(item.title, 200))}"><i class="lib-mark" data-kind="${markOf(item)}" aria-hidden="true"></i>${word ? `<em class="lib-rel">${esc(word)}</em>` : ''}<span>${esc(clip(item.title, 120))}</span></button>
    ${removeId ? `<button type="button" class="lib-link-x" data-link-remove="${esc(removeId)}" aria-label="${esc(`Remove the link to ${clip(item.title, 60)}`)}" title="Remove this link">${ICON_X}</button>` : ''}
  </div>`;

/**
 * The links part of a card. `links` = { out, in } as the server gives them (null until they come),
 * `related` = items that Loop put near this one itself ([{ id, kind, sub|scope, title }]), and
 * `nearText` is the line above them.
 */
export function linksHtml({ links, related = [], nearText = '', nearCount, canLink = true, esc }) {
  const out = links?.out || [];
  const inn = links?.in || [];
  const made = out.length + inn.length;
  const linked = new Set([...out, ...inn].map((l) => l.item.id));
  const near = related.filter((r) => !linked.has(r.id));
  if (!made && !near.length && !canLink) return '';
  const tools = `
    <span class="lib-links-tools">
      ${made + near.length > 0 ? '<button type="button" class="lib-links-btn" data-gather-item title="Put this item and the items around it on one page">Gather</button>' : ''}
      ${canLink ? `<button type="button" class="lib-links-btn" data-link-add title="Link this item to another item">${ICON_PLUS}<span>Link</span></button>` : ''}
    </span>`;
  return `
    ${canLink || made ? `<div class="mem-node-links-h lib-links-h"><span>${made ? `${made} ${made === 1 ? 'link' : 'links'}` : 'No links yet'}</span>${tools}</div>` : ''}
    ${made ? `<div class="mem-node-links-list">
      ${out.map((l) => linkRow(l.item, RELATION_WORDS[l.relation] || l.label, esc, l.id)).join('')}
      ${inn.map((l) => linkRow(l.item, RELATION_BACK[l.relation] || l.label, esc, l.id)).join('')}
    </div>` : ''}
    ${near.length ? `
      <div class="mem-node-links-h lib-near-h">${esc((nearText || '{n} near').replace('{n}', String(nearCount ?? near.length)))}</div>
      <div class="mem-node-links-list">${near.map((r) => linkRow(r, '', esc)).join('')}</div>` : ''}`;
}

/** The form that finds an item and links to it. Its id keeps a live redraw of the page away. */
export function linkFormHtml(source, esc) {
  const first = source?.kind === 'saved' && source.sub !== 'link' ? 'derived_from' : 'relates';
  return `
    <form id="mem-link-form" class="lib-link-form" autocomplete="off">
      <div class="lib-link-form-top">
        <select name="relation" class="lib-link-rel" aria-label="How this item relates to the other item">
          ${RELATION_ORDER.map((r) => `<option value="${r}" ${r === first ? 'selected' : ''}>${esc(RELATION_WORDS[r])}</option>`).join('')}
        </select>
        <input type="search" name="q" class="lib-link-q" placeholder="Find an item" aria-label="Find an item to link to" maxlength="120">
      </div>
      <div class="lib-find" data-lib-find aria-live="polite"></div>
      <div class="lib-link-form-foot"><button type="button" class="lib-links-btn" data-link-cancel>Cancel</button></div>
    </form>`;
}

/** The rows of the link form: the items that the search found. */
export function findRowsHtml(items, esc) {
  if (!items.length) return '<p class="lib-find-none">No item found.</p>';
  return items.map((it) => `<button type="button" class="mem-node-link ${groupClass(it)}" data-link-target="${esc(it.id)}" title="${esc(clip(it.title, 200))}"><i class="lib-mark" data-kind="${markOf(it)}" aria-hidden="true"></i><em class="lib-rel">${esc(kindWord(it))}</em><span>${esc(clip(it.title, 120))}</span></button>`).join('');
}

/* ---------------- Gather: some items on one page ---------------- */

/**
 * Opens the page that Gather makes from these items. The owner can leave items out, save the page
 * as a note that is linked to each item, or copy it with a request for an agent to write it well.
 * `onSaved(item)` runs after a save.
 */
export function openGatherDialog({ ids, title = '', api, esc, toast, copyText, profile, onSaved, modal = false }) {
  const all = [...new Set(ids)].slice(0, MAX_GATHER);
  const off = new Set();
  let draft = null;
  let savedId = '';
  let seq = 0;
  const dlg = document.createElement('dialog');
  dlg.className = 'loop-dialog lib-gather';
  dlg.setAttribute('aria-labelledby', 'lib-gather-t');
  // Loop opens a form in the page, under what you clicked. The expanded map has no page under
  // it, so there the form is a dialog on the map.
  if (modal) dlg.setAttribute('data-modal', 'keep');
  dlg.innerHTML = `
    <div class="cat-add-head">
      <h3 id="lib-gather-t">Gather into one note</h3>
      <button type="button" class="btn sm ghost" data-gather-close>Close</button>
    </div>
    <p class="pf-add-hint">Loop puts these items on one page. Save it as a note that stays linked to each item, or give it to an agent to write a better page from it.</p>
    <label class="field"><span class="lbl">Title</span><input type="text" name="title" maxlength="160" value="${esc(title)}" placeholder="Name the page"></label>
    <div class="lib-gather-cols">
      <ul class="lib-gather-items" aria-label="Items on the page"></ul>
      <div class="lib-gather-preview skill-markdown" aria-label="The page" aria-live="polite"><p class="lib-find-none">One moment…</p></div>
    </div>
    <div class="acts">
      <button type="button" class="btn sm" data-gather-copy disabled>Copy text</button>
      <button type="button" class="btn sm" data-gather-prompt disabled>Copy for an agent</button>
      <button type="button" class="btn sm fill" data-gather-save disabled>Save as a note</button>
    </div>`;
  const list = dlg.querySelector('.lib-gather-items');
  const preview = dlg.querySelector('.lib-gather-preview');
  const titleEl = dlg.querySelector('input[name="title"]');
  const buttons = [...dlg.querySelectorAll('.acts button')];
  const q = () => {
    const p = profile();
    return p && p !== 'all' ? `?profile=${encodeURIComponent(p)}` : '';
  };
  const picked = () => all.filter((id) => !off.has(id));

  async function refresh({ items = false } = {}) {
    const mine = ++seq;
    try {
      const res = await api(`/api/library/gather${q()}`, { method: 'POST', body: JSON.stringify({ ids: picked(), title: titleEl.value.trim() }) });
      if (mine !== seq || !dlg.isConnected) return;
      draft = res;
      if (!titleEl.value.trim()) titleEl.placeholder = res.title || 'Name the page';
      if (items) {
        // The first answer says which of the ids are items that this Project has.
        const known = new Set(res.items.map((it) => it.id));
        for (const id of all.slice()) if (!known.has(id)) all.splice(all.indexOf(id), 1);
        list.innerHTML = res.items.map((it) => `<li><label class="lib-gather-item ${groupClass(it)}"><input type="checkbox" data-gather-id="${esc(it.id)}" checked><i class="lib-mark" data-kind="${markOf(it)}" aria-hidden="true"></i><em class="lib-rel">${esc(kindWord(it))}</em><span>${esc(clip(it.title, 140))}</span></label></li>`).join('');
      }
      preview.innerHTML = res.items.length ? renderSkillMarkdown(res.markdown) : '<p class="lib-find-none">Pick one item or more.</p>';
      buttons.forEach((b) => { b.disabled = res.items.length === 0; });
    } catch (err) {
      if (mine !== seq || !dlg.isConnected) return;
      preview.innerHTML = `<p class="lib-find-none">${esc(err?.message || 'Could not gather these items.')}</p>`;
      buttons.forEach((b) => { b.disabled = true; });
    }
  }

  list.addEventListener('change', (e) => {
    const id = e.target?.dataset?.gatherId;
    if (!id) return;
    if (e.target.checked) off.delete(id);
    else off.add(id);
    refresh();
  });
  let typing = null;
  titleEl.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => refresh(), 260);
  });
  dlg.querySelector('[data-gather-close]').addEventListener('click', () => dlg.close());
  dlg.querySelector('[data-gather-copy]').addEventListener('click', () => { if (draft) copyText?.(draft.markdown, 'Copied the page.'); });
  dlg.querySelector('[data-gather-prompt]').addEventListener('click', () => { if (draft) copyText?.(draft.prompt, 'Copied. Paste it to an agent that is connected to Loop.'); });
  dlg.querySelector('[data-gather-save]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const res = await api(`/api/library/gather${q()}`, {
        method: 'POST',
        body: JSON.stringify({ ids: picked(), title: titleEl.value.trim() || draft?.title || '', save: true, savedId }),
      });
      savedId = res.saved?.id || savedId;
      toast(res.created ? 'Saved as a note. It is linked to each item.' : 'Updated the note.', 'ok');
      dlg.close();
      onSaved?.(res.saved);
    } catch (err) {
      toast(err?.message || 'Could not save the note.', 'err');
      btn.disabled = false;
    }
  });
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  titleEl.focus();
  titleEl.select();
  refresh({ items: true });
  return dlg;
}
