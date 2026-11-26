// Names that reach an agent's startup context (server instructions, the Claude Code / Codex
// hook) go through this file, so every channel applies the same rules.
//
// Why: a model cannot reliably tell data from instructions, so text in a high-authority
// channel can steer it. Names are cleaned (caps, one line) and listed only as JSON string
// values, never free prose. Agents may add things freely, and `addedBy` records which agent added
// it so the dashboard can show it. Server instructions list only the owner's own names
// (isOwnerName); an agent-added item is found by searching until the owner writes its name.
// Items saved before provenance was tracked have no `addedBy` and count as the owner's.
//
// Dependency-free on purpose: hooks/loop-hook.mjs imports it and must stay fast.

export const CONTEXT_NAME_MAX = 80;
export const CONTEXT_NAMES_MAX_LISTED = 40;

// Control, line/paragraph separators, zero-width and bidi override characters.
const UNSAFE_CHARS_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]+', 'g');

/** One short, single-line label, safe to embed as a JSON string. */
export function contextLabel(value, max = CONTEXT_NAME_MAX) {
  const flat = String(value ?? '')
    .replace(UNSAFE_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : flat;
}

/** Normalizes a stored `addedBy` record; returns null for legacy or malformed values. */
export function normalizeAddedBy(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.kind === 'owner') return { kind: 'owner' };
  // Copied from the owner's own agent config files on this machine (not text an agent sent).
  if (raw.kind === 'import') return { kind: 'import' };
  if (raw.kind !== 'agent') return null;
  const out = {
    kind: 'agent',
    name: contextLabel(raw.name || 'Agent', CONTEXT_NAME_MAX) || 'Agent',
    approved: raw.approved === true,
  };
  if (out.approved && typeof raw.approvedAt === 'string') out.approvedAt = raw.approvedAt;
  return out;
}

/**
 * Provenance for a write. `actor` is the connection-admission actor: { kind: 'owner' } for the
 * dashboard, { kind: 'agent', agent: { name } } for a keyed agent. Every write that arrives over
 * MCP is an agent's, even a keyless local one that is authorized as the owner, so MCP callers
 * also set `viaMcp: true` (and `clientName`). `actor.addedBy` overrides the result (imports).
 * `approved` is true when the owner already approved this exact write and saw the name.
 */
export function addedByFor(actor, { approved = false } = {}) {
  const explicit = normalizeAddedBy(actor?.addedBy);
  if (explicit) return explicit;
  if (actor?.kind !== 'agent' && !actor?.viaMcp) return { kind: 'owner' };
  return normalizeAddedBy({
    kind: 'agent',
    name: actor.agent?.name || actor.clientName || actor.name || 'Agent',
    approved: approved === true,
    ...(approved === true ? { approvedAt: new Date().toISOString() } : {}),
  });
}

/** The owner approving an agent-written name. */
export function approvedAddedBy(addedBy) {
  const cur = normalizeAddedBy(addedBy);
  if (!cur || cur.kind !== 'agent') return cur || { kind: 'owner' };
  return { ...cur, approved: true, approvedAt: new Date().toISOString() };
}

/** True when an item's name may appear in another agent's startup context (always: agents may add freely). */
export function isNameApproved() {
  return true;
}

/** True when the owner wrote, imported or approved this item's name. */
export function isOwnerName(item) {
  const addedBy = normalizeAddedBy(item?.addedBy);
  return !addedBy || addedBy.kind !== 'agent' || addedBy.approved;
}

/** True when an agent added the item and the owner has not approved its name yet. */
export function isNamePending(item) {
  return !isNameApproved(item);
}

/** Who pinned a memory: 'owner' or 'agent'. Legacy pins fall back to who wrote it. */
export function memoryPinnedBy(m) {
  if (!m?.pinned) return '';
  if (m.pinnedBy === 'owner' || m.pinnedBy === 'agent') return m.pinnedBy;
  return /^Owner\b/.test(String(m.writtenBy || 'Owner')) ? 'owner' : 'agent';
}

/**
 * Labels as one JSON array (deduplicated, capped by count and by characters), plus how many were
 * left out for length. JSON keeps every label visibly a string value, never free prose.
 */
export function renderNameList(names, { max = CONTEXT_NAMES_MAX_LISTED, maxChars = Infinity } = {}) {
  const seen = new Set();
  const labels = [];
  for (const raw of Array.isArray(names) ? names : []) {
    const label = contextLabel(raw);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  const shown = [];
  let chars = 2; // the array's own brackets
  for (const label of labels) {
    if (shown.length >= max) break;
    const cost = JSON.stringify(label).length + (shown.length ? 1 : 0);
    if (chars + cost > maxChars) break;
    chars += cost;
    shown.push(label);
  }
  return { json: JSON.stringify(shown), shown: shown.length, more: labels.length - shown.length };
}
