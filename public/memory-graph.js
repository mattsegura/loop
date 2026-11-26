// Interactive HTML5 Canvas brain-node graph for Loop Shared Memory.
// Zero dependencies, strict-CSP safe, tuned to Loop's warm ivory/espresso editorial palette.

import { isDark, tone } from './core/tone.js';

const SCOPE_META = {
  global: { label: 'About you', color: '#8A5A44', tint: 'rgba(138, 90, 68, 0.065)' },
  preference: { label: 'Preferences', color: '#4B5E86', tint: 'rgba(75, 94, 134, 0.065)' },
  project: { label: 'Work notes', color: '#3F7556', tint: 'rgba(63, 117, 86, 0.065)' },
  fact: { label: 'Facts', color: '#B07A2A', tint: 'rgba(176, 122, 42, 0.065)' },
};

const SOURCE_PALETTE = [
  '#4D3533',
  '#8A5A44',
  '#3F7556',
  '#4B5E86',
  '#B07A2A',
  '#6B5B8E',
  '#A0603A',
  '#3F5F7A',
];

const SCOPE_ORDER = ['global', 'preference', 'project', 'fact'];

// What the Library adds to the map beside memories. A memory is one fact. A source is a link or a
// file as it came in. A note is a page that somebody wrote from sources and facts. The colour says
// the group and the shape says the kind, so the map reads without a key.
const EXTRA_LOBES = {
  sources: { label: 'Sources', color: '#3F5F7A' },
  notes: { label: 'Notes', color: '#6B5B8E' },
  tasks: { label: 'Tasks', color: '#A0603A' },
  people: { label: 'People', color: '#4D3533' },
};
// Where each group sits around the four kinds of memory, in units of the map's two radii.
const EXTRA_SPOTS = {
  sources: { x: -1.85, y: 0 },
  notes: { x: 1.85, y: 0 },
  tasks: { x: 0, y: 2.05 },
  people: { x: 0, y: -2.05 },
};
// Above this many items, an item pushes away only the items near it (a grid finds them).
const GRID_FROM = 220;
const REPEL_REACH = 240;

/** The group of an item that is not a memory, or null for a memory. */
export function lobeOf(n) {
  if (!n || !n.kind || n.kind === 'memory') return null;
  if (n.kind === 'saved') return n.sub === 'link' ? 'sources' : 'notes';
  if (n.kind === 'file') return 'sources';
  if (n.kind === 'task') return 'tasks';
  return 'people';
}

const taskDone = (n) => n.kind === 'task' && (n.sub === 'completed' || n.sub === 'cancelled');

// The outline of an item: a memory is a pebble, a saved item a rounded square, a file a page with
// a folded corner, a task a diamond, an agent a hexagon. `kind` is one of those words.
export function shapePath(ctx, kind, x, y, r) {
  ctx.beginPath();
  if (kind === 'saved') {
    const s = r * 0.92;
    const c = s * 0.42;
    ctx.moveTo(x - s + c, y - s);
    ctx.arcTo(x + s, y - s, x + s, y + s, c);
    ctx.arcTo(x + s, y + s, x - s, y + s, c);
    ctx.arcTo(x - s, y + s, x - s, y - s, c);
    ctx.arcTo(x - s, y - s, x + s, y - s, c);
  } else if (kind === 'file') {
    const w = r * 0.84;
    const h = r * 1.04;
    const fold = r * 0.62;
    ctx.moveTo(x - w, y - h);
    ctx.lineTo(x + w - fold, y - h);
    ctx.lineTo(x + w, y - h + fold);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x - w, y + h);
  } else if (kind === 'task') {
    const d = r * 1.16;
    ctx.moveTo(x, y - d);
    ctx.lineTo(x + d, y);
    ctx.lineTo(x, y + d);
    ctx.lineTo(x - d, y);
  } else if (kind === 'agent') {
    const d = r * 1.08;
    for (let i = 0; i < 6; i += 1) {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      if (i === 0) ctx.moveTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
      else ctx.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
    }
  } else {
    ctx.arc(x, y, r, 0, Math.PI * 2);
    return;
  }
  ctx.closePath();
}

function hexToRgba(hex, alpha) {
  const clean = String(hex || '#4D3533').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return `rgba(77, 53, 51, ${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function hashAngle(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 360) * (Math.PI / 180);
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function bezierPoint(t, p0, p1, p2) {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
  };
}

function edgeControlPoint(a, b, idx) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const sign = idx % 2 === 0 ? 1 : -1;
  const bend = Math.min(34, dist * 0.14) * sign;
  return {
    x: mx + (-dy / dist) * bend,
    y: my + (dx / dist) * bend,
  };
}

// ---- Focus: one memory and the memories linked to it, seen up close ----

// How many linked memories come along when one has focus (the strongest links first).
const FOCUS_GROUP = 8;
// Graph units: how far out a linked memory may sit, and how close two may be, while one has focus.
const FOCUS_REACH = 84;
const FOCUS_GAP = 54;
const FOCUS_MAX_SCALE = 3.8;
const FOCUS_LINE = 17; // px, one line of a label
const MAX_SCALE = 4.2;

// The memories linked to `id`, strongest link first, each once.
export function linkedIds(edges, id) {
  const best = new Map();
  for (const e of edges || []) {
    const other = e.source === id ? e.target : e.target === id ? e.source : null;
    if (!other || other === id) continue;
    const w = Number(e.weight) || 0;
    if (!best.has(other) || best.get(other) < w) best.set(other, w);
  }
  return [...best].sort((a, b) => b[1] - a[1]).map(([other]) => other);
}

// Where a focused memory and its linked ones sit: each keeps its direction from the focused one,
// far ones come in to FOCUS_REACH, and none touch. `members` = [{ id, x, y }], the focused one first.
export function placeFocusGroup(members) {
  const pts = members.map((m) => ({ id: m.id, x: m.x, y: m.y }));
  const [c, ...rest] = pts;
  rest.forEach((p, i) => {
    let dx = p.x - c.x;
    let dy = p.y - c.y;
    let d = Math.hypot(dx, dy);
    if (d < 0.5) {
      const a = (i / rest.length) * Math.PI * 2;
      dx = Math.cos(a);
      dy = Math.sin(a);
      d = 1;
    }
    const far = Math.min(FOCUS_REACH, d);
    p.x = c.x + (dx / d) * far;
    p.y = c.y + (dy / d) * far;
  });
  for (let t = 0; t < 80; t += 1) {
    let moved = false;
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        const a = pts[i];
        const b = pts[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= FOCUS_GAP - 0.01) continue;
        if (d < 0.01) {
          dx = Math.cos(i + j);
          dy = Math.sin(i + j);
          d = 1;
        }
        const push = (FOCUS_GAP - d) / d;
        const share = i === 0 ? 1 : 0.5;
        if (i !== 0) {
          a.x -= dx * push * 0.5;
          a.y -= dy * push * 0.5;
        }
        b.x += dx * push * share;
        b.y += dy * push * share;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return new Map(pts.map((p) => [p.id, { x: p.x, y: p.y }]));
}

// The camera that fills `rect` (screen px) with the points and their labels.
export function frameFocusGroup(points, { width, height, rect, labelW = 140, labelH = 36, maxScale = FOCUS_MAX_SCALE }) {
  const r = Math.max(...points.map((p) => p.r));
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  const w = Math.max(120, rect.right - rect.left);
  const h = Math.max(120, rect.bottom - rect.top);
  const scale = Math.max(0.6, Math.min(
    maxScale,
    Math.max(40, w - labelW - 16) / Math.max(1, spanX),
    Math.max(40, w - 28) / (spanX + 2 * r),
    Math.max(60, h - 2 * (labelH + 14)) / (spanY + 2 * r),
  ));
  return {
    x: (Math.max(...xs) + Math.min(...xs)) / 2 - ((rect.left + rect.right) / 2 - width / 2) / scale,
    y: (Math.max(...ys) + Math.min(...ys)) / 2 - ((rect.top + rect.bottom) / 2 - height / 2) / scale,
    scale,
  };
}

// Break a label into at most `maxLines` lines no wider than `maxW`.
export function wrapLabel(text, maxW, measure, maxLines = 2) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
  const clip = (line) => {
    let t = line;
    while (t.length > 1 && measure(`${t}…`) > maxW) t = t.slice(0, -1);
    return `${t.trimEnd()}…`;
  };
  const lines = [];
  let line = '';
  for (let i = 0; i < words.length; i += 1) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (measure(next) <= maxW) {
      line = next;
      continue;
    }
    if (lines.length === maxLines - 1 || !line) {
      lines.push(clip(lines.length === maxLines - 1 ? words.slice(line ? i - line.split(' ').length : i).join(' ') : words[i]));
      line = '';
      if (lines.length >= maxLines) return lines;
      continue;
    }
    lines.push(line);
    line = words[i];
    if (measure(line) > maxW) {
      lines.push(clip(words.slice(i).join(' ')));
      return lines.slice(0, maxLines);
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

// How much wider than usual the groups sit in an open space of this shape, so a wide map uses its width.
export function mapStretch(w, h) {
  if (w < 520 || h <= 0) return 1;
  return Math.max(1, Math.min(1.6, w / h / 1.35));
}

export function sameIds(a, b) {
  if (!(a instanceof Set) || !(b instanceof Set)) return (a || null) === (b || null);
  return a.size === b.size && [...a].every((id) => b.has(id));
}

export function mountMemoryGraph(canvas, initialOpts = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { update() {}, focusNode() {}, nodeScreen() { return null; }, fitView() {}, glide() {}, zoomBy() {}, destroy() {} };

  const reducedMotion = Boolean(
    typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  let width = Math.max(320, canvas.clientWidth || 680);
  let height = Math.max(300, canvas.clientHeight || 440);
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  let state = {
    graph: initialOpts.graph || { nodes: [], edges: [], conflicts: [], sources: [] },
    selectedId: initialOpts.selectedId || null,
    matchIds: initialOpts.matchIds || null, // Set<string> | null (null = all match)
    previewIds: null, // Set<string> | null: what a menu row under the pointer would show
    groupBy: initialOpts.groupBy || 'scope', // 'scope' | 'source'
    onSelect: initialOpts.onSelect || (() => {}),
    onHover: initialOpts.onHover || (() => {}), // (id | null) when the pointer moves onto or off a node
    insetLeft: Number(initialOpts.insetLeft) || 0, // px on the left under the side menu (the expanded map)
    insetRight: Number(initialOpts.insetRight) || 0, // px on the right covered by a panel; fitting avoids it
    insetTop: Number(initialOpts.insetTop) || 0, // px kept clear at the top and bottom (the pill, the nav)
    insetBottom: Number(initialOpts.insetBottom) || 0,
    selectedCard: Boolean(initialOpts.selectedCard), // the page draws the selected memory's text itself
    hintId: null, // a memory the page points at (a row under the pointer in the card)
  };

  const simNodes = new Map(); // id -> { ...node, x, y, vx, vy, r }
  let simEdges = [];
  let lobeAnchors = new Map(); // key -> { x, y, label, color, tint }
  let sourceColors = new Map();

  let alpha = 1;
  let rafId = null;
  let destroyed = false;
  let pulsePhase = 0;
  let lastFrameAt = performance.now();

  const camera = { x: 0, y: 0, scale: 1 };
  let cameraTarget = null; // { x, y, scale }
  // The room the camera keeps filled with the focused group while the layout settles; any pan or zoom drops it.
  let follow = null; // { insetLeft, insetTop, insetRight, insetBottom, labelW }
  // The memory seen up close with its linked ones gathered around it (until the view zooms back out).
  let focusedId = null;
  let groupIds = new Set();
  let groupSpots = new Map(); // id -> { x, y }, where each of the group is drawn
  let restSpots = new Map(); // id -> { x, y }, where the others step aside to
  let focusT = 0; // 0 = whole map, 1 = up close
  let focusLabelW = 140;
  let focusLabelLines = 2;

  let hoveredId = null;
  let dragNode = null;
  let panning = false;
  let pointerDown = null;
  let didDrag = false;
  let hasFittedOnce = false;
  let userMovedCamera = false;
  // How far apart the groups sit sideways, eased toward what the open space allows.
  let stretch = 1;
  let settleFit = false; // keep the whole map in view while the groups move apart or together
  // While the page moves the canvas itself (glide): how far the camera was from the whole map when
  // the move started ({ x, y, scale }), and how much of that is left (1 to 0).
  let glide = null;

  function stretchGoal() {
    return mapStretch(width - state.insetLeft - state.insetRight, height - state.insetTop - state.insetBottom);
  }

  // The open space changed shape: let the groups spread to it.
  function reshape() {
    if (!hasFittedOnce || reducedMotion) {
      if (stretch !== stretchGoal()) {
        stretch = stretchGoal();
        computeAnchors();
      }
    }
    if (hasFittedOnce && (reducedMotion || Math.abs(stretchGoal() - stretch) > 0.01)) {
      alpha = Math.max(alpha, 0.3);
      settleFit = !userMovedCamera;
    }
  }

  function computeAnchors() {
    lobeAnchors = new Map();
    sourceColors = new Map();
    const compact = width < 520;
    const rx = compact ? 112 : 185 * stretch;
    const ry = compact ? 132 : 132;

    if (state.groupBy === 'source') {
      const origins = [];
      const seen = new Set();
      for (const n of state.graph.nodes || []) {
        const key = n.origin || 'You';
        if (!seen.has(key)) {
          seen.add(key);
          origins.push(key);
        }
      }
      if (origins.length === 0) origins.push('You');
      origins.forEach((origin, i) => {
        const color = SOURCE_PALETTE[i % SOURCE_PALETTE.length];
        sourceColors.set(origin, color);
        const angle = origins.length === 1 ? -Math.PI / 2 : -Math.PI / 2 + (i * Math.PI * 2) / origins.length;
        const mult = origins.length === 1 ? 0 : 1;
        lobeAnchors.set(origin, {
          x: Math.cos(angle) * rx * mult,
          y: Math.sin(angle) * ry * mult,
          label: origin,
          color,
          tint: hexToRgba(color, 0.065),
        });
      });
      return;
    }

    const quad = {
      global: { x: -rx * 0.92, y: -ry * 0.88 },
      preference: { x: rx * 0.92, y: -ry * 0.88 },
      project: { x: -rx * 0.92, y: ry * 0.88 },
      fact: { x: rx * 0.92, y: ry * 0.88 },
    };
    for (const id of SCOPE_ORDER) {
      const m = SCOPE_META[id];
      lobeAnchors.set(id, {
        x: quad[id].x,
        y: quad[id].y,
        label: m.label,
        color: m.color,
        tint: m.tint,
      });
    }
    // A group of the Library has a place only while it has items, so the map of memories alone
    // is the size it always was.
    const present = new Set();
    for (const n of state.graph.nodes || []) {
      const lobe = lobeOf(n);
      if (lobe) present.add(lobe);
    }
    for (const id of Object.keys(EXTRA_LOBES)) {
      if (!present.has(id)) continue;
      const m = EXTRA_LOBES[id];
      lobeAnchors.set(id, {
        x: EXTRA_SPOTS[id].x * rx,
        y: EXTRA_SPOTS[id].y * ry,
        label: m.label,
        color: m.color,
        tint: hexToRgba(m.color, 0.06),
      });
    }
  }

  function nodeColor(n) {
    if (state.groupBy === 'source') {
      return sourceColors.get(n.origin || 'You') || SOURCE_PALETTE[0];
    }
    const lobe = lobeOf(n);
    if (lobe) return EXTRA_LOBES[lobe].color;
    return SCOPE_META[n.scope]?.color || '#6F5A57';
  }

  function nodeAnchor(n) {
    if (n.pinned) {
      const ang = hashAngle(n.id);
      return { x: Math.cos(ang) * 46, y: Math.sin(ang) * 40 };
    }
    const key = state.groupBy === 'source' ? (n.origin || 'You') : lobeOf(n) || n.scope;
    return lobeAnchors.get(key) || { x: 0, y: 0 };
  }

  function syncGraphData(reheat = 0.65) {
    computeAnchors();
    const rawNodes = Array.isArray(state.graph?.nodes) ? state.graph.nodes : [];
    const rawEdges = Array.isArray(state.graph?.edges) ? state.graph.edges : [];

    const nextIds = new Set(rawNodes.map((n) => n.id));
    for (const id of [...simNodes.keys()]) {
      if (!nextIds.has(id)) simNodes.delete(id);
    }

    for (const n of rawNodes) {
      const existing = simNodes.get(n.id);
      const r = n.kind === 'person' ? 11
        : Math.min(18, (n.pinned ? 12.5 : lobeOf(n) ? 8 : 8.5) + Math.min(4.5, (n.degree || 0) * 0.95));
      if (existing) {
        Object.assign(existing, n, { r });
      } else {
        const anchor = nodeAnchor(n);
        const angle = hashAngle(`${n.id}:${n.key}`);
        const spread = n.pinned ? 24 : 58;
        simNodes.set(n.id, {
          ...n,
          r,
          x: anchor.x + Math.cos(angle) * spread,
          y: anchor.y + Math.sin(angle) * spread,
          vx: 0,
          vy: 0,
          // How far from its place in the map it is drawn (gathered around the focused memory).
          ox: 0,
          oy: 0,
        });
      }
    }

    simEdges = rawEdges
      .filter((e) => simNodes.has(e.source) && simNodes.has(e.target))
      .map((e, idx) => ({ ...e, _idx: idx }));
    if (focusedId && !simNodes.has(focusedId)) releaseFocus();

    alpha = Math.max(alpha, reheat);
    if (!hasFittedOnce && rawNodes.length > 0) {
      hasFittedOnce = true;
      // Pre-settle a few ticks synchronously so the first frame already looks composed.
      for (let i = 0; i < 42; i += 1) stepSimulation();
      fitView(false);
    }
    ensureRunning();
  }

  function stepSimulation() {
    const nodes = [...simNodes.values()];
    const count = nodes.length;
    if (count === 0) {
      alpha = 0;
      return;
    }

    const k = alpha;

    // 1. Lobe / Core-ring attraction
    for (const n of nodes) {
      if (dragNode && dragNode.id === n.id) continue;
      const anchor = nodeAnchor(n);
      const pull = n.pinned ? 0.085 : 0.052;
      n.vx += (anchor.x - n.x) * pull * k;
      n.vy += (anchor.y - n.y) * pull * k;
    }

    // 2. Pairwise repulsion & collision separation
    const repel = (a, b) => {
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) {
        dx = 0.5;
        dy = -0.5;
        d2 = 0.5;
      }
      const dist = Math.sqrt(d2);

      // Soft long-range repulsion
      if (dist < REPEL_REACH) {
        const repulse = (720 / (d2 + 120)) * k;
        const fx = (dx / dist) * repulse;
        const fy = (dy / dist) * repulse;
        if (!dragNode || dragNode.id !== a.id) {
          a.vx -= fx;
          a.vy -= fy;
        }
        if (!dragNode || dragNode.id !== b.id) {
          b.vx += fx;
          b.vy += fy;
        }
      }

      // Strict collision avoidance so nodes never stack
      const minDist = a.r + b.r + 22;
      if (dist < minDist) {
        const push = ((minDist - dist) / dist) * 0.42;
        const px = dx * push;
        const py = dy * push;
        if (!dragNode || dragNode.id !== a.id) {
          a.vx -= px;
          a.vy -= py;
        }
        if (!dragNode || dragNode.id !== b.id) {
          b.vx += px;
          b.vy += py;
        }
      }
    };
    if (count <= GRID_FROM) {
      for (let i = 0; i < count; i += 1) {
        for (let j = i + 1; j < count; j += 1) repel(nodes[i], nodes[j]);
      }
    } else {
      // Nothing farther away than REPEL_REACH has an effect, so each item meets only the items in
      // its own cell and in the cells beside it. Each pair meets once.
      const cells = new Map();
      for (const n of nodes) {
        const cx = Math.floor(n.x / REPEL_REACH);
        const cy = Math.floor(n.y / REPEL_REACH);
        const key = `${cx},${cy}`;
        let cell = cells.get(key);
        if (!cell) cells.set(key, (cell = { cx, cy, list: [] }));
        cell.list.push(n);
      }
      for (const { cx, cy, list } of cells.values()) {
        for (let i = 0; i < list.length; i += 1) {
          for (let j = i + 1; j < list.length; j += 1) repel(list[i], list[j]);
        }
        for (const [ox, oy] of [[1, 0], [-1, 1], [0, 1], [1, 1]]) {
          const other = cells.get(`${cx + ox},${cy + oy}`);
          if (!other) continue;
          for (const a of list) for (const b of other.list) repel(a, b);
        }
      }
    }

    // 3. Edge springs
    for (const e of simEdges) {
      // Who wrote an item is not a reason to sit near that person.
      if (e.kind === 'by') continue;
      const a = simNodes.get(e.source);
      const b = simNodes.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      // A line between two groups (a note and the memory it was made from) is long and soft, so
      // each group keeps its place and the memories stay where they were.
      const across = lobeOf(a) !== lobeOf(b);
      const targetLen = across ? 168 : e.kind === 'link' ? 88 : e.kind === 'project' ? 102 : e.kind === 'conflict' ? 96 : 124;
      const strength = (across ? (e.kind === 'link' ? 0.009 : 0.003) : e.kind === 'link' ? 0.042 : e.kind === 'project' ? 0.024 : 0.014) * k;
      const force = (dist - targetLen) * strength;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (!dragNode || dragNode.id !== a.id) {
        a.vx += fx;
        a.vy += fy;
      }
      if (!dragNode || dragNode.id !== b.id) {
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    // 4. Integrate velocity with warm damping
    for (const n of nodes) {
      if (dragNode && dragNode.id === n.id) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx *= 0.82;
      n.vy *= 0.82;
      n.x += Math.max(-14, Math.min(14, n.vx));
      n.y += Math.max(-14, Math.min(14, n.vy));
    }

    alpha = dragNode ? Math.max(alpha, 0.22) : alpha * 0.965;
    if (alpha < 0.004) alpha = 0;
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - width / 2) / camera.scale + camera.x,
      y: (sy - height / 2) / camera.scale + camera.y,
    };
  }

  function hitTest(sx, sy) {
    const pt = screenToWorld(sx, sy);
    let hit = null;
    let bestD = Infinity;
    for (const n of simNodes.values()) {
      const d = Math.hypot(pt.x - drawX(n), pt.y - drawY(n));
      const pad = Math.max(n.r + (focusedId ? 2 : 7), 16 / camera.scale);
      // A faded memory under one of the focused group never takes its click.
      if (hit && groupIds.has(hit.id) && !groupIds.has(n.id)) continue;
      if (d <= pad && (d < bestD || (groupIds.has(n.id) && !groupIds.has(hit.id)))) {
        bestD = d;
        hit = n;
      }
    }
    return hit;
  }

  const drawX = (n) => n.x + n.ox;
  const drawY = (n) => n.y + n.oy;

  function releaseFocus() {
    focusedId = null;
    groupIds = new Set();
    groupSpots = new Map();
    restSpots = new Map();
    follow = null;
  }

  // Recompute where the focused group sits (its places in the map may still be settling).
  function layoutFocus() {
    const c = focusedId ? simNodes.get(focusedId) : null;
    if (!c) return;
    const members = [c, ...linkedIds(simEdges, focusedId).slice(0, FOCUS_GROUP).map((id) => simNodes.get(id))].filter(Boolean);
    groupIds = new Set(members.map((n) => n.id));
    groupSpots = placeFocusGroup(members);
    // Anything else standing in the middle of the group steps out around it, so the group reads alone.
    restSpots = new Map();
    const pts = [...groupSpots.values()];
    if (pts.length < 2) return;
    const cx = pts.reduce((t, p) => t + p.x, 0) / pts.length;
    const cy = pts.reduce((t, p) => t + p.y, 0) / pts.length;
    const reach = Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.y - cy))) + 44;
    for (const n of simNodes.values()) {
      if (groupIds.has(n.id)) continue;
      const d = Math.hypot(n.x - cx, n.y - cy);
      if (d >= reach) continue;
      const a = d < 0.5 ? hashAngle(n.id) : Math.atan2(n.y - cy, n.x - cx);
      const out = reach + (d / reach) * 26;
      restSpots.set(n.id, { x: cx + Math.cos(a) * out, y: cy + Math.sin(a) * out });
    }
  }

  function focusCamera() {
    const pts = [...groupSpots].map(([id, p]) => ({ ...p, r: simNodes.get(id)?.r || 10 }));
    let maxScale = FOCUS_MAX_SCALE;
    // Nothing linked: keep its nearest neighbors in view, so it is never alone on empty paper.
    if (pts.length === 1) {
      maxScale = 2.4;
      const c = pts[0];
      const around = [...simNodes.values()]
        .filter((n) => n.id !== focusedId && Math.hypot(n.x - c.x, n.y - c.y) < 170)
        .sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y))
        .slice(0, 3);
      for (const n of around) pts.push({ x: n.x, y: n.y, r: n.r });
    }
    return frameFocusGroup(pts, {
      width,
      height,
      rect: {
        left: follow.insetLeft,
        top: follow.insetTop,
        right: width - follow.insetRight,
        bottom: height - follow.insetBottom,
      },
      labelW: follow.labelW,
      labelH: focusLabelLines * FOCUS_LINE,
      maxScale,
    });
  }

  function activeNeighbors(id) {
    const set = new Set();
    if (!id) return set;
    set.add(id);
    for (const e of simEdges) {
      if (e.source === id) set.add(e.target);
      else if (e.target === id) set.add(e.source);
    }
    return set;
  }

  function draw() {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 1. Warm architectural paper background
    ctx.fillStyle = tone('#FAF6F4');
    ctx.fillRect(0, 0, width, height);

    // Subtle dot grid in world coordinates
    const gridSpacing = 24 * camera.scale;
    if (gridSpacing >= 10) {
      const offsetX = (((width / 2 - camera.x * camera.scale) % gridSpacing) + gridSpacing) % gridSpacing;
      const offsetY = (((height / 2 - camera.y * camera.scale) % gridSpacing) + gridSpacing) % gridSpacing;
      ctx.fillStyle = tone('rgba(77, 53, 51, 0.085)');
      for (let gx = offsetX; gx < width; gx += gridSpacing) {
        for (let gy = offsetY; gy < height; gy += gridSpacing) {
          ctx.beginPath();
          ctx.arc(gx, gy, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // World transform
    ctx.translate(width / 2, height / 2);
    ctx.scale(camera.scale, camera.scale);
    ctx.translate(-camera.x, -camera.y);

    // 2. Subtle lobe clouds & Startup Context core ring
    for (const anchor of lobeAnchors.values()) {
      const grad = ctx.createRadialGradient(anchor.x, anchor.y, 8, anchor.x, anchor.y, 118);
      grad.addColorStop(0, tone(anchor.tint));
      grad.addColorStop(1, tone('rgba(250, 246, 244, 0)'));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(anchor.x, anchor.y, 118, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.font = '500 13px "Iowan Old Style", Palatino, Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = tone(hexToRgba(anchor.color, 0.56 * (1 - focusT)));
      ctx.fillText(anchor.label, anchor.x, anchor.y - 84);
      ctx.restore();
    }

    // Core Startup Context ring at (0, 0)
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, 74, 0, Math.PI * 2);
    ctx.fillStyle = tone('rgba(255, 253, 249, 0.55)');
    ctx.fill();
    ctx.setLineDash([4, 5]);
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = tone(`rgba(77, 53, 51, ${0.16 - 0.1 * focusT})`);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '600 9px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = tone(`rgba(77, 53, 51, ${0.36 * (1 - focusT)})`);
    ctx.fillText('STARTUP CONTEXT', 0, 62);
    ctx.restore();

    // Up close, the focused memory stays the subject while the pointer moves over its linked ones.
    const focusId = focusedId || hoveredId || state.selectedId;
    const focusSet = focusedId ? groupIds : activeNeighbors(focusId);
    // Lines and rings grow much less than the nodes do when zoomed in.
    const thin = Math.max(1, camera.scale / 1.7);
    // One reason for every link is said once, in the card; captions appear only when reasons differ.
    const captions = new Set(simEdges.filter((e) => e.source === focusId || e.target === focusId).map((e) => e.label || e.kind));
    const captionEdges = !focusedId || captions.size > 1;
    const previewing = state.previewIds instanceof Set;
    const shownIds = previewing ? state.previewIds : state.matchIds;
    const hasFilter = shownIds instanceof Set;

    // 3. Curved synaptic edges
    for (const e of simEdges) {
      const a = simNodes.get(e.source);
      const b = simNodes.get(e.target);
      if (!a || !b) continue;

      const isFocusEdge = Boolean(focusId && (e.source === focusId || e.target === focusId));
      if (e.kind === 'by' && !isFocusEdge) continue;
      const bothMatch = !hasFilter || (shownIds.has(e.source) && shownIds.has(e.target));
      const inGroup = Boolean(focusedId && groupIds.has(e.source) && groupIds.has(e.target));
      const dim = previewing ? !bothMatch : (focusId && !isFocusEdge) || (hasFilter && !bothMatch && !inGroup);
      // Up close, a line to a memory out of view would only cross the group.
      const edgeAlpha = inGroup || !focusedId ? 1 : 1 - 0.8 * focusT;

      const pa = { x: drawX(a), y: drawY(a) };
      const pb = { x: drawX(b), y: drawY(b) };
      const cp = edgeControlPoint(pa, pb, e._idx);

      ctx.save();
      ctx.globalAlpha = edgeAlpha;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.quadraticCurveTo(cp.x, cp.y, pb.x, pb.y);

      if (e.kind === 'conflict') {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = tone(dim ? 'rgba(163, 65, 47, 0.12)' : isFocusEdge ? 'rgba(163, 65, 47, 0.78)' : 'rgba(176, 122, 42, 0.52)');
        ctx.lineWidth = isFocusEdge ? 2 : 1.4;
      } else if (e.kind === 'link') {
        if (e.relation === 'contradicts') ctx.setLineDash([4, 3]);
        ctx.strokeStyle = tone(dim ? 'rgba(77, 53, 51, 0.12)' : isFocusEdge ? 'rgba(77, 53, 51, 0.78)' : 'rgba(77, 53, 51, 0.42)');
        ctx.lineWidth = isFocusEdge ? 2.1 : 1.5;
      } else if (e.kind === 'project') {
        ctx.strokeStyle = tone(dim ? 'rgba(63, 117, 86, 0.08)' : isFocusEdge ? 'rgba(63, 117, 86, 0.68)' : 'rgba(63, 117, 86, 0.28)');
        ctx.lineWidth = isFocusEdge ? 1.8 : 1.2;
      } else if (e.kind === 'tag') {
        ctx.strokeStyle = tone(dim ? 'rgba(75, 94, 134, 0.07)' : isFocusEdge ? 'rgba(75, 94, 134, 0.62)' : 'rgba(75, 94, 134, 0.24)');
        ctx.lineWidth = isFocusEdge ? 1.6 : 1.1;
      } else if (e.kind === 'by') {
        ctx.setLineDash([1.5 / thin, 4 / thin]);
        ctx.lineCap = 'round';
        ctx.strokeStyle = tone(dim ? 'rgba(77, 53, 51, 0.08)' : 'rgba(77, 53, 51, 0.46)');
        ctx.lineWidth = 1.4;
      } else {
        ctx.strokeStyle = tone(dim ? 'rgba(77, 53, 51, 0.05)' : isFocusEdge ? 'rgba(138, 90, 68, 0.52)' : 'rgba(77, 53, 51, 0.14)');
        ctx.lineWidth = isFocusEdge ? 1.5 : 1;
      }
      ctx.lineWidth /= thin;
      ctx.stroke();
      ctx.setLineDash([]);

      // Traveling soft synaptic pulse along highlighted edges
      if (isFocusEdge && e.kind !== 'by' && (inGroup || !focusedId) && !reducedMotion) {
        const t = (pulsePhase + (e._idx * 0.27)) % 1;
        const p = bezierPoint(t, pa, cp, pb);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.7 / thin, 0, Math.PI * 2);
        ctx.fillStyle = tone(e.kind === 'conflict' ? '#A3412F' : '#4D3533');
        ctx.fill();
      }

      // Edge relation caption when focused
      if (isFocusEdge && (inGroup || !focusedId) && captionEdges && e.label && (e.kind === 'link' || e.kind === 'project' || e.kind === 'tag')) {
        const mid = bezierPoint(0.5, pa, cp, pb);
        const text = e.label.length > 18 ? `${e.label.slice(0, 17)}…` : e.label;
        const k = labelShrink();
        ctx.font = `500 ${9.5 / k}px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;
        const tw = ctx.measureText(text).width + 10 / k;
        roundRectPath(ctx, mid.x - tw / 2, mid.y - 8 / k, tw, 16 / k, 8 / k);
        ctx.fillStyle = tone('rgba(255, 253, 249, 0.94)');
        ctx.fill();
        ctx.strokeStyle = tone('rgba(77, 53, 51, 0.18)');
        ctx.lineWidth = 0.8 / k;
        ctx.stroke();
        ctx.fillStyle = tone('#6F5A57');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, mid.x, mid.y + 0.5);
      }
      ctx.restore();
    }

    // 4. Nodes
    // The focused group is drawn over the faded rest.
    const nodeList = [...simNodes.values()].sort((a, b) => Number(groupIds.has(a.id)) - Number(groupIds.has(b.id)));
    const showAllLabels = nodeList.length <= 18 || camera.scale >= 1.15;
    const labelsToDraw = [];

    for (const n of nodeList) {
      const color = nodeColor(n);
      const isSelected = n.id === state.selectedId;
      const isHovered = n.id === hoveredId || n.id === state.hintId;
      const x = drawX(n);
      const y = drawY(n);
      const isNeighbor = Boolean(focusId && focusSet.has(n.id));
      const isMatch = !hasFilter || shownIds.has(n.id);
      const dim = previewing ? !isMatch : (focusId && !isNeighbor) || (hasFilter && !isMatch && !(focusedId && isNeighbor));
      const nodeAlpha = dim ? (isHovered && focusedId ? 0.5 : 0.2 - 0.08 * focusT) : 1;

      ctx.save();
      ctx.globalAlpha = nodeAlpha;

      // Soft warm glow on pinned, hovered, selected, or search-matched nodes
      if (n.pinned || isSelected || isHovered || (hasFilter && isMatch && !focusedId)) {
        const haloR = n.r + (isSelected ? 11 : isHovered ? 9 : 7) / thin;
        const pulse = !reducedMotion && (isSelected || n.pinned) ? Math.sin(pulsePhase * Math.PI * 2) * 1.4 / thin : 0;
        const glow = ctx.createRadialGradient(x, y, n.r * 0.4, x, y, haloR + pulse);
        glow.addColorStop(0, tone(hexToRgba(color, isSelected ? 0.3 : 0.2)));
        glow.addColorStop(1, tone(hexToRgba(color, 0)));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, haloR + pulse, 0, Math.PI * 2);
        ctx.fill();
      }

      // Conflict warning dashed halo
      if (n.conflictCount > 0) {
        ctx.beginPath();
        ctx.arc(x, y, n.r + 5 / thin, 0, Math.PI * 2);
        ctx.setLineDash([3 / thin, 3 / thin]);
        ctx.lineWidth = 1.4 / thin;
        ctx.strokeStyle = tone('#B07A2A');
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Pinned outer espresso ring
      if (n.pinned) {
        ctx.beginPath();
        ctx.arc(x, y, n.r + 3.2 / thin, 0, Math.PI * 2);
        ctx.lineWidth = 1.4 / thin;
        ctx.strokeStyle = tone(isSelected ? '#3F2C2A' : hexToRgba('#4D3533', 0.48));
        ctx.stroke();
      }

      // A person has a ring around them, as the people they are to the Library.
      if (n.kind === 'person') {
        ctx.beginPath();
        ctx.arc(x, y, n.r + 3.4 / thin, 0, Math.PI * 2);
        ctx.lineWidth = 1.3 / thin;
        ctx.strokeStyle = tone(hexToRgba(color, isSelected ? 0.9 : 0.5));
        ctx.stroke();
      }

      // Main pebble node, in the shape of its kind. A task that is done is an outline.
      const done = taskDone(n);
      ctx.lineJoin = 'round';
      shapePath(ctx, n.kind, x, y, n.r);
      ctx.fillStyle = tone(done ? '#FFFDF9' : color);
      ctx.shadowColor = isDark() ? 'rgba(0, 0, 0, 0.5)' : 'rgba(63, 44, 42, 0.18)';
      ctx.shadowBlur = isSelected || isHovered ? 12 : 6;
      ctx.shadowOffsetY = 2;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      // Crisp ivory inner border
      ctx.lineWidth = (isSelected ? 2.5 : 1.8) / thin;
      ctx.strokeStyle = tone(isSelected ? '#3F2C2A' : done ? color : '#FFFFFF');
      ctx.stroke();

      // The fold of a page, so a file reads as a document.
      if (n.kind === 'file') {
        const w = n.r * 0.84;
        const h = n.r * 1.04;
        const fold = n.r * 0.62;
        ctx.beginPath();
        ctx.moveTo(x + w - fold, y - h);
        ctx.lineTo(x + w - fold, y - h + fold);
        ctx.lineTo(x + w, y - h + fold);
        ctx.lineWidth = 1.1 / thin;
        ctx.strokeStyle = tone('rgba(255, 253, 249, 0.85)');
        ctx.stroke();
      }

      // Tiny warm highlight pip for pinned nodes
      if (n.pinned) {
        ctx.beginPath();
        ctx.arc(x, y, 2.8, 0, Math.PI * 2);
        ctx.fillStyle = tone('#FFFDF9');
        ctx.fill();
      }

      ctx.restore();

      const shouldLabel =
        isSelected ||
        isHovered ||
        isNeighbor ||
        (!focusedId && hasFilter && isMatch) ||
        (!dim && (n.pinned || showAllLabels));

      // When the page shows the selected memory in a card beside it, its pill label would sit under that card.
      if (shouldLabel && !focusedId && !(isSelected && state.selectedCard)) {
        labelsToDraw.push({
          n,
          priority: isSelected ? 4 : isHovered ? 3 : isNeighbor ? 2 : n.pinned ? 1 : 0,
          dim,
        });
      }
    }

    // 5. Crisp pill labels (highest priority drawn on top)
    // Where memories crowd, a label that would cover another label or another memory waits for a
    // hover or a closer zoom.
    const maxPillChars = width < 480 ? 24 : 42;
    const placed = [];
    labelsToDraw.sort((a, b) => b.priority - a.priority || b.n.r - a.n.r);
    for (const item of labelsToDraw) {
      const { n, priority } = item;
      const rawText = String(n.label || n.key || '');
      const text = rawText.length > maxPillChars ? `${rawText.slice(0, maxPillChars - 1).trimEnd()}…` : rawText;
      // Labels keep their on-screen size when zoomed in, so zooming gives the nodes room instead
      // of making the text huge.
      const k = labelShrink();
      const fontSize = (priority >= 3 ? 11.5 : 10.5) / k;
      ctx.save();
      ctx.font = `${priority >= 3 || n.pinned ? '600' : '500'} ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;
      const tw = ctx.measureText(text).width;
      ctx.restore();
      const padX = 7 / k;
      const boxW = tw + padX * 2;
      const boxH = fontSize + 8 / k;
      const bx = drawX(n) - boxW / 2;
      const by = drawY(n) + n.r + 6 / k;
      if (priority < 2) {
        const covers = placed.some((b) => bx < b.bx + b.boxW && b.bx < bx + boxW && by < b.by + b.boxH && b.by < by + boxH)
          || nodeList.some((o) => o !== n && Math.hypot(
            Math.max(bx - drawX(o), 0, drawX(o) - bx - boxW),
            Math.max(by - drawY(o), 0, drawY(o) - by - boxH),
          ) < o.r * 0.8);
        if (covers) continue;
      }
      placed.push({ ...item, text, k, fontSize, bx, by, boxW, boxH });
    }
    for (const { n, priority, dim, text, k, fontSize, bx, by, boxW, boxH } of placed.reverse()) {
      ctx.save();
      ctx.globalAlpha = dim ? 0.35 : 1;
      ctx.font = `${priority >= 3 || n.pinned ? '600' : '500'} ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;
      roundRectPath(ctx, bx, by, boxW, boxH, boxH / 2);
      ctx.fillStyle = tone(priority >= 3 ? '#FFFFFF' : 'rgba(255, 253, 249, 0.92)');
      ctx.fill();
      ctx.lineWidth = (priority >= 3 ? 1.2 : 0.8) / k;
      ctx.strokeStyle = tone(priority >= 3 ? '#4D3533' : 'rgba(77, 53, 51, 0.16)');
      ctx.stroke();

      ctx.fillStyle = tone(priority >= 3 ? '#3F2C2A' : '#4D3533');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, drawX(n), by + boxH / 2 + 0.5);
      ctx.restore();
    }

    ctx.restore();
    if (focusedId && focusT > 0.02) drawFocusLabels();
  }

  // Up close there is room for real text: two lines beside each linked memory, on the side facing
  // out of the group, skipping any that would cover a memory or another label.
  function drawFocusLabels() {
    const lineH = FOCUS_LINE;
    const placed = [];
    const discs = [];
    const items = [];
    let sumY = 0;
    for (const id of groupIds) {
      const n = simNodes.get(id);
      if (!n) continue;
      const p = nodeScreen(id);
      discs.push({ id, ...p });
      sumY += p.y;
      if (id !== focusedId) items.push({ n, p });
    }
    // With nothing linked, a pointed-at faded memory still says what it is.
    const pointed = hoveredId || state.hintId;
    if (pointed && !groupIds.has(pointed) && simNodes.has(pointed)) items.push({ n: simNodes.get(pointed), p: nodeScreen(pointed) });
    const midY = discs.length ? sumY / discs.length : height / 2;
    items.sort((a, b) => Number(b.n.id === pointed) - Number(a.n.id === pointed));
    const overlaps = (box, id) => placed.some((o) => box.x < o.x + o.w && o.x < box.x + box.w && box.y < o.y + o.h && o.y < box.y + box.h) ||
      discs.some((d) => {
        if (d.id === id) return false;
        const nx = Math.max(box.x, Math.min(d.x, box.x + box.w));
        const ny = Math.max(box.y, Math.min(d.y, box.y + box.h));
        return Math.hypot(d.x - nx, d.y - ny) < d.r + 2;
      });
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '500 12.5px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = focusT;
    for (const { n, p } of items) {
      const lines = wrapLabel(lobeOf(n) ? n.title || n.label || n.key : n.content || n.label || n.key, focusLabelW, (t) => ctx.measureText(t).width, focusLabelLines);
      const w = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 6;
      const h = lines.length * lineH;
      const up = { x: p.x - w / 2, y: p.y - p.r - 8 - h, w, h };
      const down = { x: p.x - w / 2, y: p.y + p.r + 8, w, h };
      const box = (p.y < midY - 1 ? [up, down] : [down, up]).find((c) => !overlaps(c, n.id)) || (n.id === pointed ? down : null);
      if (!box) continue;
      placed.push(box);
      lines.forEach((t, i) => {
        const ty = box.y + lineH * (i + 0.5);
        ctx.lineWidth = 5;
        ctx.strokeStyle = tone('rgba(250, 246, 244, 0.92)');
        ctx.strokeText(t, p.x, ty);
        ctx.fillStyle = tone('#3F2C2A');
        ctx.fillText(t, p.x, ty);
      });
    }
    ctx.restore();
  }

  function tick(now) {
    rafId = null;
    if (destroyed) return;

    const dt = Math.min(0.05, Math.max(0.004, (now - lastFrameAt) / 1000));
    lastFrameAt = now;

    const spread = stretchGoal();
    let spreading = false;
    if (Math.abs(spread - stretch) > 0.002) {
      stretch += (spread - stretch) * (1 - Math.pow(0.001, dt));
      if (Math.abs(spread - stretch) <= 0.002) stretch = spread;
      else spreading = true;
      computeAnchors();
    }
    if (alpha > 0) stepSimulation();
    if (settleFit) {
      if (userMovedCamera || focusedId || (alpha < 0.02 && !spreading)) settleFit = false;
      else if (!glide) cameraTarget = fitTarget();
    }
    if (focusedId && alpha > 0) layoutFocus();
    if (follow && focusedId && (alpha > 0 || cameraTarget)) cameraTarget = focusCamera();

    const ease = 1 - Math.pow(0.001, dt);
    // Linked memories glide in around the focused one, and home again when it lets go.
    let gathering = false;
    for (const n of simNodes.values()) {
      const spot = focusedId ? groupSpots.get(n.id) || restSpots.get(n.id) : null;
      const tx = spot ? spot.x - n.x : 0;
      const ty = spot ? spot.y - n.y : 0;
      if (reducedMotion || Math.hypot(tx - n.ox, ty - n.oy) < 0.05) {
        n.ox = tx;
        n.oy = ty;
      } else {
        n.ox += (tx - n.ox) * ease;
        n.oy += (ty - n.oy) * ease;
        gathering = true;
      }
    }
    const focusGoal = focusedId ? 1 : 0;
    if (reducedMotion || Math.abs(focusGoal - focusT) < 0.01) focusT = focusGoal;
    else {
      focusT += (focusGoal - focusT) * ease;
      gathering = true;
    }

    // Smooth camera lerp
    let cameraMoving = false;
    if (cameraTarget) {
      const f = reducedMotion ? 1 : ease;
      // Move the target straight to the middle of the screen while zooming by a steady ratio, so
      // zooming in never throws the group out of view on the way.
      const sx = (cameraTarget.x - camera.x) * camera.scale * (1 - f);
      const sy = (cameraTarget.y - camera.y) * camera.scale * (1 - f);
      camera.scale *= Math.pow(cameraTarget.scale / camera.scale, f);
      camera.x = cameraTarget.x - sx / camera.scale;
      camera.y = cameraTarget.y - sy / camera.scale;
      if (
        Math.abs(cameraTarget.x - camera.x) < 0.3 &&
        Math.abs(cameraTarget.y - camera.y) < 0.3 &&
        Math.abs(cameraTarget.scale - camera.scale) < 0.003
      ) {
        camera.x = cameraTarget.x;
        camera.y = cameraTarget.y;
        camera.scale = cameraTarget.scale;
        cameraTarget = null;
      } else {
        cameraMoving = true;
      }
    }

    const animatePulse = !reducedMotion && Boolean(hoveredId || state.selectedId || [...simNodes.values()].some((n) => n.pinned));
    if (animatePulse) {
      pulsePhase = (pulsePhase + dt * 0.28) % 1;
    }

    draw();

    if (alpha > 0 || cameraMoving || gathering || spreading || dragNode || (!reducedMotion && (hoveredId || state.selectedId))) {
      rafId = requestAnimationFrame(tick);
    }
  }

  function ensureRunning() {
    if (destroyed) return;
    if (rafId === null) {
      lastFrameAt = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  }

  function resize() {
    const prevW = width;
    const prevH = height;
    const rect = canvas.getBoundingClientRect();
    width = Math.max(280, Math.round(rect.width || canvas.parentElement?.clientWidth || 680));
    height = Math.max(280, Math.round(rect.height || 440));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Setting a canvas size clears the canvas, also when the size is the same: only set a new one.
    const pxW = Math.round(width * dpr);
    const pxH = Math.round(height * dpr);
    const cleared = canvas.width !== pxW || canvas.height !== pxH;
    if (cleared) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
    if ((prevW !== width || prevH !== height) && hasFittedOnce && !userMovedCamera && !state.selectedId && simNodes.size > 0) {
      computeAnchors();
      if (glide) glideCamera();
      else fitView(false);
    }
    reshape();
    if (follow && focusedId) cameraTarget = focusCamera();
    // A cleared canvas gets its picture back now, so a growing map never blinks.
    if (hasFittedOnce && cleared) draw();
    ensureRunning();
  }

  // The whole map; a focused memory lets go of its linked ones.
  function fitView(animate = true) {
    releaseFocus();
    glide = null;
    userMovedCamera = false;
    const target = fitTarget();
    if (animate) cameraTarget = target;
    else {
      cameraTarget = null;
      Object.assign(camera, target);
    }
    ensureRunning();
  }

  // The whole map in the open space as it is this frame, less what is left of the camera's own offset.
  function glideCamera() {
    const t = fitTarget();
    cameraTarget = null;
    camera.scale = t.scale * Math.pow(glide.scale, glide.left);
    camera.x = t.x + glide.x * glide.left;
    camera.y = t.y + glide.y * glide.left;
  }

  // Where the camera sees everything, or only what the filter keeps, in the open space.
  function fitTarget() {
    const all = [...simNodes.values()];
    if (all.length === 0) return { x: 0, y: 0, scale: 1 };
    const kept = state.matchIds instanceof Set ? all.filter((n) => state.matchIds.has(n.id)) : [];
    const nodes = kept.length ? kept : all;
    let minX = kept.length ? Infinity : -110;
    let maxX = kept.length ? -Infinity : 110;
    let minY = kept.length ? Infinity : -100;
    let maxY = kept.length ? -Infinity : 100;
    const maxPillChars = width < 480 ? 24 : 42;
    ctx.save();
    ctx.font = '600 10.5px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
    for (const n of nodes) {
      const rawText = String(n.label || n.key || '');
      const text = rawText.length > maxPillChars ? `${rawText.slice(0, maxPillChars - 1).trimEnd()}…` : rawText;
      const labelHalfW = Math.max(44, ctx.measureText(text).width / 2 + 12);
      minX = Math.min(minX, n.x - labelHalfW);
      maxX = Math.max(maxX, n.x + labelHalfW);
      minY = Math.min(minY, n.y - 46);
      maxY = Math.max(maxY, n.y + 68);
    }
    ctx.restore();
    // Each group's label is drawn above its anchor; keep it in view too.
    if (!kept.length) for (const a of lobeAnchors.values()) {
      minX = Math.min(minX, a.x - 82);
      maxX = Math.max(maxX, a.x + 82);
      minY = Math.min(minY, a.y - 104);
      maxY = Math.max(maxY, a.y + 44);
    }
    const spanX = Math.max(220, maxX - minX);
    const spanY = Math.max(200, maxY - minY);
    const right = Math.max(0, Math.min(width - 200, state.insetRight || 0));
    const left = Math.max(0, Math.min(width - 200 - right, state.insetLeft || 0));
    const minScale = width < 520 ? 0.34 : 0.46;
    const top = state.insetTop;
    const bottom = state.insetBottom;
    const tall = Math.max(160, height - top - bottom - 48);
    const scale = Math.max(minScale, Math.min(kept.length ? 2 : 1.5, (width - left - right - 32) / spanX, tall / spanY));
    return {
      x: (minX + maxX) / 2 + (right - left) / 2 / scale,
      y: (minY + maxY) / 2 + (bottom - top) / 2 / scale,
      scale,
    };
  }

  // How much to shrink labels (in graph units) so they stay their normal size on screen when zoomed in.
  function labelShrink() {
    return Math.max(1, camera.scale);
  }

  // Where a node is drawn now, in the canvas's CSS pixels, so the page can place controls beside it.
  function nodeScreen(id) {
    const n = simNodes.get(id);
    if (!n) return null;
    return {
      x: (drawX(n) - camera.x) * camera.scale + width / 2,
      y: (drawY(n) - camera.y) * camera.scale + height / 2,
      r: n.r * camera.scale,
    };
  }

  // Zoom in on a memory together with the ones linked to it, filling the part of the canvas the
  // page leaves open (insets, screen px). Moving within the same group barely moves the camera.
  function focusNode(id, { insetLeft = 0, insetTop = 0, insetRight = 0, insetBottom = 0 } = {}) {
    if (!simNodes.has(id)) return;
    focusedId = id;
    focusLabelW = width - insetLeft - insetRight >= 440 ? 140 : 120;
    const tall = height - insetTop - insetBottom;
    focusLabelLines = tall >= 380 ? 3 : tall >= 170 ? 2 : 1;
    follow = { insetLeft, insetTop, insetRight, insetBottom, labelW: focusLabelW };
    layoutFocus();
    if (groupIds.size > 6) focusLabelLines = Math.min(2, focusLabelLines); // a crowd gets shorter labels
    cameraTarget = focusCamera();
    ensureRunning();
  }

  function zoomBy(factor, anchorX = width / 2, anchorY = height / 2) {
    cameraTarget = null;
    follow = null;
    userMovedCamera = true;
    const before = screenToWorld(anchorX, anchorY);
    const nextScale = Math.max(0.45, Math.min(MAX_SCALE, camera.scale * factor));
    camera.scale = nextScale;
    const after = screenToWorld(anchorX, anchorY);
    camera.x += before.x - after.x;
    camera.y += before.y - after.y;
    ensureRunning();
  }

  function localCoords(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  const activePointers = new Map();
  let pinchState = null;

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    canvas.setPointerCapture?.(e.pointerId);
    const pt = localCoords(e);
    activePointers.set(e.pointerId, pt);
    if (activePointers.size === 2) {
      const [p1, p2] = [...activePointers.values()];
      pinchState = {
        dist: Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y)),
        scale: camera.scale,
      };
      dragNode = null;
      panning = false;
      didDrag = true;
      cameraTarget = null;
      follow = null;
      settleFit = false;
      return;
    }
    pointerDown = { x: pt.x, y: pt.y, camX: camera.x, camY: camera.y };
    didDrag = false;
    cameraTarget = null;
    follow = null;
    settleFit = false;

    const hit = hitTest(pt.x, pt.y);
    if (hit) {
      dragNode = hit;
      alpha = Math.max(alpha, 0.35);
      canvas.dataset.cursor = 'grabbing';
      ensureRunning();
    } else {
      panning = true;
      canvas.dataset.cursor = 'grabbing';
    }
  }

  function onPointerMove(e) {
    const pt = localCoords(e);
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, pt);
      if (activePointers.size === 2 && pinchState) {
        const [p1, p2] = [...activePointers.values()];
        const nextDist = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y));
        const nextScale = Math.max(0.28, Math.min(3.5, pinchState.scale * (nextDist / pinchState.dist)));
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        const before = screenToWorld(midX, midY);
        camera.scale = nextScale;
        const after = screenToWorld(midX, midY);
        camera.x += before.x - after.x;
        camera.y += before.y - after.y;
        userMovedCamera = true;
        ensureRunning();
        return;
      }
    }
    if (dragNode && pointerDown) {
      if (Math.hypot(pt.x - pointerDown.x, pt.y - pointerDown.y) > 4) didDrag = true;
      const w = screenToWorld(pt.x, pt.y);
      dragNode.x = w.x - dragNode.ox;
      dragNode.y = w.y - dragNode.oy;
      dragNode.vx = 0;
      dragNode.vy = 0;
      alpha = Math.max(alpha, 0.25);
      ensureRunning();
      return;
    }
    if (panning && pointerDown) {
      const dx = pt.x - pointerDown.x;
      const dy = pt.y - pointerDown.y;
      if (Math.hypot(dx, dy) > 4) {
        didDrag = true;
        userMovedCamera = true;
      }
      camera.x = pointerDown.camX - dx / camera.scale;
      camera.y = pointerDown.camY - dy / camera.scale;
      ensureRunning();
      return;
    }
    const hit = hitTest(pt.x, pt.y);
    const nextHover = hit ? hit.id : null;
    if (nextHover !== hoveredId) {
      hoveredId = nextHover;
      canvas.dataset.cursor = hit ? 'pointer' : 'grab';
      state.onHover(hoveredId);
      ensureRunning();
    }
  }

  function onPointerUp(e) {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchState = null;
    const pt = localCoords(e);
    if (!didDrag && pointerDown) {
      const hit = hitTest(pt.x, pt.y);
      const nextId = hit ? hit.id : null;
      if (nextId !== state.selectedId) {
        state.selectedId = nextId;
        state.onSelect(nextId);
        ensureRunning();
      }
    }
    dragNode = null;
    panning = false;
    pointerDown = null;
    canvas.dataset.cursor = hoveredId ? 'pointer' : 'grab';
    ensureRunning();
  }

  function onDoubleClick(e) {
    const pt = localCoords(e);
    const hit = hitTest(pt.x, pt.y);
    if (hit) {
      state.selectedId = hit.id;
      state.onSelect(hit.id); // the page zooms in on it
    } else {
      fitView(true);
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const pt = localCoords(e);
    const factor = e.deltaY < 0 ? 1.1 : 0.91;
    zoomBy(factor, pt.x, pt.y);
  }

  function onPointerLeave() {
    if (!dragNode && !panning && hoveredId !== null) {
      hoveredId = null;
      canvas.dataset.cursor = 'grab';
      state.onHover(null);
      ensureRunning();
    }
  }

  canvas.dataset.cursor = 'grab';
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // The Look changed (Settings, another tab or the system): draw again in the new palette.
  const onTheme = () => { if (!destroyed) draw(); };
  window.addEventListener('loop-theme', onTheme);

  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => resize());
    ro.observe(canvas);
  }

  resize();
  syncGraphData(1);

  return {
    update(next = {}) {
      const groupChanged = next.groupBy !== undefined && next.groupBy !== state.groupBy;
      const graphChanged = next.graph !== undefined && next.graph !== state.graph;
      const insetChanged = ['insetLeft', 'insetRight', 'insetTop', 'insetBottom'].some((k) => next[k] !== undefined && next[k] !== state[k]);
      const filterChanged = next.matchIds !== undefined && !sameIds(next.matchIds, state.matchIds);
      state = { ...state, ...next };
      if (next.selectedId === null && focusedId) releaseFocus();
      if (insetChanged) reshape();
      if ((insetChanged || filterChanged) && !state.selectedId) fitView(true);
      if (graphChanged || groupChanged) {
        syncGraphData(groupChanged ? 0.9 : 0.45);
      } else {
        ensureRunning();
      }
    },
    // The page is moving and resizing the canvas itself (the map expanding or collapsing) and calls
    // this each frame with the room to keep clear now and how far the move is (0 to 1). The whole
    // map stays in view in step with the canvas, with no camera animation of its own on top.
    glide(insets, p) {
      if (state.selectedId || focusedId || simNodes.size === 0) {
        glide = null;
        this.update(insets);
        return;
      }
      if (!glide || p <= 0) {
        const t = fitTarget();
        glide = { x: camera.x - t.x, y: camera.y - t.y, scale: camera.scale / t.scale, left: 1 };
      }
      state = { ...state, ...insets };
      glide.left = Math.max(0, 1 - p);
      userMovedCamera = false;
      reshape();
      glideCamera();
      if (p >= 1) glide = null;
      ensureRunning();
    },
    focusNode,
    nodeScreen,
    fitView,
    zoomBy,
    destroy() {
      destroyed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('loop-theme', onTheme);
      ro?.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
