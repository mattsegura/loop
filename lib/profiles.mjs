// Shared Profile normalization, validation, and visibility rules across
// Connections, Skills, Memory, Vault, and Agents.

export const MAX_PROFILES = 50;
export const PROFILE_ID_MAX = 60;
export const PROFILE_NAME_MAX = 60;
export const PROFILE_DESC_MAX = 200;

export const FORBIDDEN_PROFILE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const PROFILE_CONTROL_RE = /[\r\n\0]/;

export function normalizeProfileTag(tag) {
  const clean = String(tag || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, PROFILE_ID_MAX);
  if (!clean || FORBIDDEN_PROFILE_KEYS.has(clean)) return '';
  return clean;
}

// Every named project: saved records, plus ids that exist only as a tag or an exact tool grant on
// an item. Search, enter and session start all use this list, so any project that search shows opens.
export function listNamedProjects(records = [], items = []) {
  const byId = new Map();
  const add = (rawId, { name = '', description = '', repositoryUrl = '' } = {}) => {
    const id = normalizeProfileTag(rawId);
    if (id && id !== 'all' && !byId.has(id)) {
      byId.set(id, {
        id,
        name: name || id,
        description,
        ...(repositoryUrl ? { repositoryUrl } : {}),
      });
    }
  };
  for (const record of records) add(record?.id, record);
  for (const item of items) {
    for (const tag of Array.isArray(item?.profiles) ? item.profiles : []) add(tag);
    for (const tag of Object.keys(item?.projectToolGrants || {})) add(tag);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

// Connection profiles preserve the ['all', ...sortedTags] storage format
// used by config.json and existing store tests.
export function normalizeConnectionProfiles(profiles) {
  const raw = Array.isArray(profiles)
    ? profiles
    : typeof profiles === 'string'
      ? [profiles]
      : [];
  const tags = new Set();
  for (const item of raw) {
    const clean = normalizeProfileTag(item);
    if (clean && clean !== 'all') tags.add(clean);
  }
  return ['all', ...Array.from(tags).sort((a, b) => a.localeCompare(b))];
}

// Item profiles for Skills, Memory, and Vault:
// - undefined / null -> ['all'] (Default profile only; strictly excluded from named profiles)
// - [] -> [] (unassigned: visible only in workspace-wide 'all' view, never in named profiles)
// - ['all'] -> ['all'] (Default profile only; never implicitly shared into named profiles)
// - ['work', ...] -> sorted unique specific profile IDs (visible in those profiles + 'all' view)
export function normalizeItemProfiles(profiles) {
  if (profiles === undefined || profiles === null) return ['all'];
  const raw = Array.isArray(profiles)
    ? profiles
    : typeof profiles === 'string'
      ? [profiles]
      : [];
  if (Array.isArray(profiles) && profiles.length === 0) return [];
  const tags = new Set();
  let sawAll = false;
  for (const item of raw) {
    const clean = normalizeProfileTag(item);
    if (!clean) continue;
    if (clean === 'all') sawAll = true;
    else tags.add(clean);
  }
  if (tags.size > 0) return Array.from(tags).sort((a, b) => a.localeCompare(b));
  return sawAll ? ['all'] : [];
}

// Removes a deleted profile ID from an item's profiles list without widening
// exclusivity into 'all' (a single-profile item becomes [] / unassigned).
export function stripProfileFromItemProfiles(profiles, deletedId) {
  const cleanDeleted = normalizeProfileTag(deletedId);
  if (!cleanDeleted || cleanDeleted === 'all') return normalizeItemProfiles(profiles);
  const current = normalizeItemProfiles(profiles);
  if (current.includes('all')) return ['all'];
  const next = current.filter((p) => p !== cleanDeleted);
  return next;
}

export function connectionMatchesProfile(conn, profile, { requireEnabled = true } = {}) {
  if (!conn) return false;
  if (requireEnabled && !conn.enabled) return false;
  const target = normalizeProfileTag(profile) || 'all';
  if (target === 'all') return true;
  return Array.isArray(conn.profiles) && conn.profiles.includes(target);
}

// Strict profile matching across Skills, Memory, and Vault:
// - When profile is 'all' (default workspace / no profile selected): matches everything.
// - When profile is a specific named profile (e.g. 'work'): matches ONLY items whose
//   `profiles` explicitly include that profile. No implicit sharing across profiles.
export function itemMatchesProfile(itemOrProfiles, profile) {
  const target = normalizeProfileTag(profile) || 'all';
  if (target === 'all') return true;
  const list = Array.isArray(itemOrProfiles)
    ? itemOrProfiles
    : itemOrProfiles && typeof itemOrProfiles === 'object' && 'profiles' in itemOrProfiles
      ? itemOrProfiles.profiles
      : undefined;
  return Array.isArray(list) && list.includes(target);
}

// Strict ownership check for mutations/deletes by an agent restricted to a named profile.
// A scoped agent may only edit/delete items exclusively belonging to its profile.
export function itemEditableInProfile(itemOrProfiles, agentProfile) {
  const target = normalizeProfileTag(agentProfile) || 'all';
  if (target === 'all') return true;
  const list = Array.isArray(itemOrProfiles)
    ? itemOrProfiles
    : itemOrProfiles && typeof itemOrProfiles === 'object' && 'profiles' in itemOrProfiles
      ? itemOrProfiles.profiles
      : undefined;
  if (!Array.isArray(list)) return false;
  return list.length === 1 && list[0] === target;
}

// Exact per-tool grants are separate from whole-connection membership. Never feed
// a projected connection back into a write, or use it to authorize non-tool reads.
export function normalizeProjectToolGrants(raw) {
  const grants = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return grants;
  for (const [id, names] of Object.entries(raw)) {
    if (id === 'all' || id !== normalizeProfileTag(id) || !id || !Array.isArray(names)) continue;
    const valid = [...new Set(names.filter((n) => typeof n === 'string' && n.trim()))].sort();
    if (valid.length) grants[id] = valid;
  }
  return grants;
}

export function projectToolConnection(conn, profile = 'all') {
  const id = normalizeProfileTag(profile);
  if (!conn || !id) return null;
  if (connectionMatchesProfile(conn, id, { requireEnabled: false })) return conn;
  const grants = conn.projectToolGrants;
  if (!conn.enabled || !grants || !Object.hasOwn(grants, id) || !Array.isArray(grants[id])) return null;
  const names = new Set(grants[id]);
  const tools = (conn.tools || []).filter(({ name }) => names.has(name)
    && (!conn.allowedTools?.length || conn.allowedTools.includes(name)) && !conn.disabledTools?.includes(name));
  // An empty allowedTools list is unrestricted in the legacy format. Never
  // return an empty narrow view, including when the last tool is revoked.
  if (!tools.length) return null;
  const toolNames = tools.map((tool) => tool.name);
  const { projectToolGrants: _, ...base } = conn;
  return { ...base, profiles: [id], tools, toolNames, allowedTools: toolNames,
    pinnedTools: (conn.pinnedTools || []).filter((n) => toolNames.includes(n)), disabledTools: [],
    prompts: [], resources: [], serverInstructions: '', syncWarnings: [] };
}

// What an agent reads says `project` and `projects`. A stored item says `profile` and `profiles`,
// and some stores add the new name beside the old one. This gives the item with the new names
// only: the old name goes away, and its value moves to the new name when the item has no such name.
const AGENT_NAMES = new Map([['profile', 'project'], ['profiles', 'projects']]);
export function projectNames(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const named = [];
  for (const [key, value] of Object.entries(item)) {
    const name = AGENT_NAMES.get(key);
    if (!name) named.push([key, value]);
    else if (!Object.hasOwn(item, name)) named.push([name, value]);
  }
  return Object.fromEntries(named);
}
