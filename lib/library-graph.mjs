// The Library map beyond Memories: saved items, files, tasks, and the agents and people who wrote
// them, as layers on the memory graph that lib/memory.mjs builds.
//
// This file has no I/O. lib/library.mjs loads the records and the links and gives them to
// buildLibraryLayers, which returns the nodes and edges to ADD to the memory graph. It never
// changes a memory node or an edge between two memories, so the map of memories stays the same
// when a layer comes on.
//
// Every step is bounded, so a large Library gives a readable map and a fast answer:
// - a layer shows at most `cap` items: the linked ones first, then open tasks, then the newest;
// - a shared tag joins an item to the two main items of that tag, not to every item that has it;
// - words in common are found through an index of words, never by comparing every pair.

import { tokenizeText } from './memory.mjs';
import { normalizeItemProfiles } from './profiles.mjs';

export const LIBRARY_LAYERS = Object.freeze(['saved', 'files', 'tasks', 'people']);
export const DEFAULT_LAYER_CAP = 80;
const MAX_LAYER_CAP = 300;

const TAG_EDGES_PER_NODE = 3; // tags of one item that make an edge
const TAG_PARTNERS = 2; // items that one tag joins the item to
const SIMILAR_PER_NODE = 2;
const SIMILAR_MIN_SCORE = 0.28; // the same threshold that the memory graph uses
const WIKI_LINKS_PER_ITEM = 24;
const SCAN_TEXT_CHARS = 20_000;

const RELATION_LABELS = Object.freeze({
  relates: 'relates',
  extends: 'extends',
  updates: 'updates',
  contradicts: 'contradicts',
  cites: 'cites',
  derived_from: 'made from',
  part_of: 'part of',
});

export function relationLabel(relation) {
  return RELATION_LABELS[relation] || String(relation || 'relates').replace(/_/g, ' ');
}

function oneLine(raw, max) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// The same rule as the memory graph: the place it came from, or the agent that wrote it, or You.
function originOf(record) {
  const source = String(record.source || '');
  const by = String(record.writtenBy || '');
  if (by && by !== 'Owner' && !by.startsWith('Owner (')) return by;
  if (source && !['Manual', 'Loop', 'Upload', 'Import'].includes(source)) return source;
  return 'You';
}

/** The words that name an author, so "Claude Code" and "claude-code" are one author. */
export function authorKey(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** [[target]] and [[target|label]] in a text, outside code. Each target once. */
export function wikiLinkTargets(text) {
  const src = String(text || '').slice(0, SCAN_TEXT_CHARS);
  if (!src.includes('[[')) return [];
  const prose = src.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, ' ');
  const seen = new Set();
  const out = [];
  const re = /\[\[([^\]|\n]{1,120})(?:\|[^\]\n]{0,80})?\]\]/g;
  let m;
  while ((m = re.exec(prose)) !== null && out.length < WIKI_LINKS_PER_ITEM) {
    const target = m[1].trim();
    const key = target.toLowerCase();
    if (!target || seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

// ---- One node for each kind of record ----

export function savedNode(item) {
  const title = item.displayTitle || item.title || item.domain || item.url || 'Saved item';
  const sub = item.ui || item.kind === 'artifact' ? 'artifact' : item.kind === 'link' && item.url ? 'link' : 'note';
  return {
    id: item.id,
    kind: 'saved',
    sub,
    key: item.id,
    label: oneLine(title, 60),
    title: oneLine(title, 160),
    content: oneLine(item.note || item.summary || item.markdown || item.url || '', 360),
    tags: Array.isArray(item.tags) ? item.tags : [],
    profiles: normalizeItemProfiles(item.projects || item.profiles),
    source: item.source || 'Manual',
    writtenBy: item.writtenBy || 'Owner',
    origin: originOf(item),
    updatedAt: item.updatedAt || item.createdAt || null,
    ...(item.url ? { url: item.url } : {}),
    scanText: `${item.note || ''}\n${item.markdown || ''}`,
  };
}

export function fileNode(file) {
  const ext = String(file.name || '').includes('.') ? String(file.name).split('.').pop().toLowerCase().slice(0, 8) : '';
  return {
    id: file.id,
    kind: 'file',
    sub: ext || 'file',
    key: file.id,
    label: oneLine(file.name || file.id, 60),
    title: oneLine(file.name || file.id, 160),
    content: oneLine(file.note || file.extractedText || '', 360),
    tags: Array.isArray(file.tags) ? file.tags : [],
    profiles: normalizeItemProfiles(file.projects || file.profiles),
    source: file.source || 'Manual',
    writtenBy: file.writtenBy || 'Owner',
    origin: originOf(file),
    updatedAt: file.updatedAt || file.createdAt || null,
    scanText: file.note || '',
  };
}

export function taskNode(task) {
  const project = task.project || (task.profile && task.profile !== 'all' ? task.profile : null);
  return {
    id: task.id,
    kind: 'task',
    sub: task.status || 'active',
    key: task.id,
    label: oneLine(task.title || task.id, 60),
    title: oneLine(task.title || task.id, 160),
    content: oneLine(task.objective || task.nextStep || task.notes || '', 360),
    tags: [],
    profiles: normalizeItemProfiles(project ? [project] : ['all']),
    source: 'Tasks',
    writtenBy: task.writtenBy || task.requestedBy || 'Owner',
    origin: originOf({ writtenBy: task.writtenBy || task.requestedBy || 'Owner' }),
    updatedAt: task.updatedAt || task.createdAt || null,
    ...(task.assignedTo ? { assignedTo: task.assignedTo } : {}),
    sources: Array.isArray(task.sources) ? task.sources.map((s) => String(s?.reference || '')).filter(Boolean).slice(0, 24) : [],
    scanText: `${task.objective || ''}\n${task.notes || ''}\n${task.result || ''}`,
  };
}

function agentNode(agent, person) {
  return {
    id: `agent:${agent.id}`,
    kind: 'agent',
    sub: agent.kind || 'agent',
    key: `agent:${agent.id}`,
    label: oneLine(agent.name || agent.id, 40),
    title: oneLine(agent.name || agent.id, 80),
    content: person.guest ? `An agent of ${person.title}.` : 'One of your agents.',
    tags: [],
    profiles: normalizeItemProfiles([agent.profile || 'all']),
    origin: person.title,
    updatedAt: agent.lastUsedAt || agent.createdAt || null,
  };
}

function personNode({ id, name, guest }) {
  return {
    id,
    kind: 'person',
    sub: guest ? 'guest' : 'owner',
    key: id,
    label: oneLine(name, 40),
    title: oneLine(name, 80),
    content: guest ? 'A guest of a shared Project.' : 'The owner of this Workspace.',
    tags: [],
    profiles: ['all'],
    origin: name,
    updatedAt: null,
    guest: Boolean(guest),
  };
}

// The items of one layer that the map shows: the linked ones, then open tasks, then the newest.
function pickLayer(nodes, cap, linkedIds) {
  const rank = (n) => (linkedIds.has(n.id) ? 2 : 0) + (n.kind === 'task' && (n.sub === 'active' || n.sub === 'waiting') ? 1 : 0);
  return nodes
    .slice()
    .sort((a, b) => rank(b) - rank(a) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, cap);
}

/**
 * The nodes and edges that the layers add to the memory graph.
 *
 * memoryNodes: the nodes of buildMemoryGraph (never changed here).
 * saved, files, tasks: store records, a bounded list of each (only those of the layers that are on).
 * links: rows of the link store that touch these items.
 * agents, guests: for the "people" layer.
 */
export function buildLibraryLayers({
  memoryNodes = [],
  saved = [],
  files = [],
  tasks = [],
  links = [],
  agents = [],
  guests = [],
  layers = [],
  totals = {},
  cap = DEFAULT_LAYER_CAP,
} = {}) {
  const on = new Set(layers);
  const layerCap = Math.max(10, Math.min(Number(cap) || DEFAULT_LAYER_CAP, MAX_LAYER_CAP));
  const linkedIds = new Set();
  for (const l of links) {
    linkedIds.add(l.sourceId);
    linkedIds.add(l.targetId);
  }

  const shown = {};
  const extra = [];
  const addLayer = (name, nodes) => {
    if (!on.has(name)) return;
    const picked = pickLayer(nodes, layerCap, linkedIds);
    shown[name] = { shown: picked.length, total: Math.max(Number(totals[name]) || 0, nodes.length) };
    extra.push(...picked);
  };
  addLayer('saved', saved.map(savedNode));
  addLayer('files', files.map(fileNode));
  addLayer('tasks', tasks.map(taskNode));

  const byId = new Map();
  for (const n of memoryNodes) byId.set(n.id, n);
  for (const n of extra) byId.set(n.id, n);
  const isExtra = new Set(extra.map((n) => n.id));

  const edges = [];
  const pairs = new Set(); // pairs of items that an edge already joins, in any direction
  const edgeIds = new Set();
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const addEdge = (edge) => {
    if (!edge.source || !edge.target || edge.source === edge.target) return false;
    if (!byId.has(edge.source) || !byId.has(edge.target)) return false;
    if (edgeIds.has(edge.id)) return false;
    edgeIds.add(edge.id);
    pairs.add(pairKey(edge.source, edge.target));
    edges.push(edge);
    return true;
  };

  // 1. Links that a person or an agent made. A link between two memories is here only when the
  //    link store holds it (the memory graph has the links that memories hold themselves).
  for (const l of links) {
    addEdge({ id: l.id, source: l.sourceId, target: l.targetId, kind: 'link', relation: l.relation, label: relationLabel(l.relation), weight: 1 });
  }

  // 2. [[an id or a title]] in the text of an item, and the sources of a task.
  const refs = new Map(); // an id, a memory key, a title or an address in lower case -> node id
  const addRef = (key, id) => {
    const k = String(key || '').trim().toLowerCase();
    if (k && !refs.has(k)) refs.set(k, id);
  };
  for (const n of byId.values()) {
    addRef(n.id, n.id);
    if (n.key && n.key !== n.id) addRef(n.key, n.id);
  }
  for (const n of byId.values()) {
    if (n.title) addRef(n.title, n.id);
    if (n.url) addRef(n.url, n.id);
  }
  for (const n of extra) {
    for (const target of wikiLinkTargets(n.scanText)) {
      const id = refs.get(target.toLowerCase());
      if (id && !pairs.has(pairKey(n.id, id))) {
        addEdge({ id: `ref:${n.id}>${id}`, source: n.id, target: id, kind: 'link', relation: 'cites', label: 'cites', weight: 0.95 });
      }
    }
    for (const reference of n.sources || []) {
      const id = refs.get(reference.trim().toLowerCase());
      if (id && !pairs.has(pairKey(n.id, id))) {
        addEdge({ id: `src:${n.id}>${id}`, source: n.id, target: id, kind: 'link', relation: 'cites', label: 'source', weight: 0.9 });
      }
    }
  }

  // How much an item is a centre of its tag: a pinned memory, then an item with links, then a newer item.
  const explicitDegree = new Map();
  for (const e of edges) {
    explicitDegree.set(e.source, (explicitDegree.get(e.source) || 0) + 1);
    explicitDegree.set(e.target, (explicitDegree.get(e.target) || 0) + 1);
  }
  const weightOf = (n) => (n.pinned ? 1000 : 0) + (explicitDegree.get(n.id) || 0) * 10 + (Number(n.degree) || 0);
  const mainFirst = (a, b) => weightOf(b) - weightOf(a) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || a.id.localeCompare(b.id);

  // 3. A shared tag joins an item of a layer to the two main items of that tag. The rarest tags
  //    of an item say the most about it, so they make its edges.
  const byTag = new Map();
  for (const n of byId.values()) {
    for (const t of new Set(n.tags || [])) {
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t).push(n);
    }
  }
  for (const bucket of byTag.values()) bucket.sort(mainFirst);
  for (const n of extra) {
    const tags = [...new Set(n.tags || [])]
      .filter((t) => (byTag.get(t)?.length || 0) > 1)
      .sort((a, b) => byTag.get(a).length - byTag.get(b).length || a.localeCompare(b))
      .slice(0, TAG_EDGES_PER_NODE);
    for (const t of tags) {
      let joined = 0;
      for (const other of byTag.get(t)) {
        if (joined >= TAG_PARTNERS) break;
        if (other.id === n.id) continue;
        if (pairs.has(pairKey(n.id, other.id))) { joined += 1; continue; }
        if (addEdge({ id: `tag:${pairKey(n.id, other.id)}`, source: n.id, target: other.id, kind: 'tag', relation: 'shared-tag', label: `#${t}`, weight: 0.62 })) joined += 1;
      }
    }
  }

  // 4. Words in common, through an index of words. A word that very many items have says nothing.
  const tokens = new Map();
  const postings = new Map();
  for (const n of byId.values()) {
    const words = new Set(tokenizeText(`${n.title || n.key || ''} ${(n.tags || []).join(' ')} ${n.content || ''}`));
    tokens.set(n.id, words);
    for (const w of words) {
      if (!postings.has(w)) postings.set(w, []);
      postings.get(w).push(n.id);
    }
  }
  const commonAbove = Math.max(12, Math.ceil(byId.size * 0.08));
  for (const n of extra) {
    const mine = tokens.get(n.id);
    if (!mine || mine.size < 2) continue;
    const shared = new Map(); // other id -> { count, word }
    for (const w of mine) {
      const ids = postings.get(w);
      if (!ids || ids.length > commonAbove) continue;
      for (const other of ids) {
        if (other === n.id) continue;
        const cur = shared.get(other);
        if (cur) cur.count += 1;
        else shared.set(other, { count: 1, word: w });
      }
    }
    const best = [];
    for (const [other, hit] of shared) {
      if (hit.count < 2 || pairs.has(pairKey(n.id, other))) continue;
      const theirs = tokens.get(other);
      const score = hit.count / Math.sqrt(mine.size * theirs.size);
      if (score >= SIMILAR_MIN_SCORE) best.push({ other, score, word: hit.word });
    }
    best.sort((a, b) => b.score - a.score || a.other.localeCompare(b.other));
    for (const c of best.slice(0, SIMILAR_PER_NODE)) {
      addEdge({ id: `sim:${pairKey(n.id, c.other)}`, source: n.id, target: c.other, kind: 'similar', relation: 'related', label: c.word, weight: Math.min(0.6, Math.max(0.3, c.score)) });
    }
  }

  // How many edges each item of a layer has (its size on the map). Who wrote it does not count.
  const degree = new Map();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }

  // 5. People and agents, and a line from each to what they wrote. The map shows these lines only
  //    for the item or the person under the pointer, so they never crowd it.
  const actors = [];
  if (on.has('people')) {
    const owner = personNode({ id: 'person:owner', name: 'You', guest: false });
    const people = [owner];
    const personOfAgent = new Map();
    for (const g of guests) {
      if (!g?.id) continue;
      const person = personNode({ id: `person:${g.id}`, name: g.name || g.email || 'Guest', guest: true });
      people.push(person);
      for (const agentId of g.agentIds || []) personOfAgent.set(agentId, person);
    }
    const authors = new Map(); // the words of a name -> node id
    authors.set('owner', owner.id);
    authors.set('you', owner.id);
    for (const p of people) {
      actors.push(p);
      byId.set(p.id, p);
      if (p.guest) authors.set(authorKey(p.title), p.id);
    }
    for (const a of agents) {
      if (!a?.id || a.enabled === false) continue;
      const person = personOfAgent.get(a.id) || owner;
      const node = agentNode(a, person);
      actors.push(node);
      byId.set(node.id, node);
      const key = authorKey(a.name);
      if (key && !authors.has(key)) authors.set(key, node.id);
      addEdge({ id: `by:${node.id}>${person.id}`, source: node.id, target: person.id, kind: 'by', relation: 'agent-of', label: 'agent of', weight: 0.2 });
    }
    const writerOf = (n) => {
      const by = String(n.writtenBy || '');
      if (!by || by === 'Owner' || by.startsWith('Owner (')) return owner.id;
      return authors.get(authorKey(by)) || null;
    };
    for (const n of [...memoryNodes, ...extra]) {
      const writer = writerOf(n);
      if (writer) addEdge({ id: `by:${n.id}>${writer}`, source: n.id, target: writer, kind: 'by', relation: 'written-by', label: 'wrote', weight: 0.2 });
      const assignee = n.assignedTo ? authors.get(authorKey(n.assignedTo)) : null;
      if (assignee && assignee !== writer) {
        addEdge({ id: `to:${n.id}>${assignee}`, source: n.id, target: assignee, kind: 'by', relation: 'assigned-to', label: 'assigned', weight: 0.2 });
      }
    }
    shown.people = { shown: actors.length, total: actors.length };
  }

  const strip = ({ scanText, sources, ...node }) => node;
  const nodes = [...extra, ...actors].map((n) => ({
    ...strip(n),
    pinned: false,
    conflictCount: 0,
    degree: degree.get(n.id) || 0,
  }));

  return {
    nodes,
    edges,
    layers: shown,
    // Edges between an item of a layer and a memory make that memory more linked than it says.
    memoryDegree: Object.fromEntries(memoryNodes.filter((n) => degree.has(n.id) && !isExtra.has(n.id)).map((n) => [n.id, degree.get(n.id)])),
  };
}
