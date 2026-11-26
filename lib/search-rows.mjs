// What loop__search returns. A search answer is a list to choose from: a row carries what an agent
// needs to pick one item, and loop__inspect returns the rest of it.

import { summarizeInstructions } from './connection-chart.mjs';

// Tool names are listed only when the answer is about a few Connections.
export const FOCUSED_CONNECTIONS = 3;
const LISTED_TOOL_NAMES = 60;

// An overview lists everything in few words: its text stays within a budget however large the
// workspace is, first by shorter descriptions, then by none.
const OVERVIEW_TEXT_CHARS = 6000;
const OVERVIEW_DESCRIPTION_MAX = 90;
const OVERVIEW_DESCRIPTION_MIN = 40;
const OVERVIEW_MEMORY_CHARS = 240;
export const OVERVIEW_ROWS = 200;
export const OVERVIEW_MEMORIES = 25;
export const OVERVIEW_VAULT_ITEMS = 50;

export function overviewDescriptionChars(rows) {
  const each = Math.floor(OVERVIEW_TEXT_CHARS / Math.max(1, rows));
  return each < OVERVIEW_DESCRIPTION_MIN ? 0 : Math.min(OVERVIEW_DESCRIPTION_MAX, each);
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isRows = (value) => Array.isArray(value) && value.length > 0 && value.every(isObject);

// JSON with one row per line. Clients that page or cut output by lines keep whole rows, and no
// context goes to indentation. `depth` is how many levels of row lists are spread over lines.
export function rowsJson(value, depth = 1, pad = '') {
  if (isRows(value)) {
    return `[\n${value.map((row) => `${pad} ${rowsJson(row, depth, `${pad} `)}`).join(',\n')}\n${pad}]`;
  }
  if (depth > 0 && isObject(value) && (pad === '' || Object.values(value).some(isRows))) {
    const fields = Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .map(([key, field]) => `${pad} ${JSON.stringify(key)}: ${rowsJson(field, depth - 1, `${pad} `)}`);
    return `{\n${fields.join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

function shortText(text, maxChars) {
  return maxChars > 0 ? summarizeInstructions(text || '', maxChars) : '';
}

// `summary` comes from summarizeConnection. The recovery details stay on rows that need attention.
export function connectionRow(summary, { toolNames = 0, descriptionChars = 160, compactReadiness = false } = {}) {
  const projects = summary.projects.filter((p) => p !== 'all');
  const tools = toolNames > 0 ? summary.tools.slice(0, toolNames) : [];
  const compactR = summary.readiness && {
    state: summary.readiness.state,
    label: summary.readiness.label,
    ready: summary.readiness.ready,
    ...(summary.readiness.action ? { action: summary.readiness.action } : {}),
    enabledTools: summary.readiness.enabledTools,
  };
  return {
    id: summary.id,
    name: summary.name,
    description: shortText(summary.description, descriptionChars),
    category: summary.category,
    categoryLabel: summary.categoryLabel,
    locationLabel: summary.locationLabel,
    route: summary.route,
    connected: summary.connected,
    statusLabel: summary.statusLabel,
    toolCount: summary.toolCount,
    ...(projects.length > 0 ? { projects } : {}),
    ...(summary.pinnedTools.length > 0 ? { pinnedTools: summary.pinnedTools } : {}),
    ...(summary.resourceCount > 0 ? { resourceCount: summary.resourceCount } : {}),
    ...(summary.promptCount > 0 ? { promptCount: summary.promptCount } : {}),
    ...(summary.connected
      ? {}
      : {
          authRequired: summary.authRequired,
          readiness: compactReadiness ? compactR : summary.readiness,
          ...(summary.lastError ? { lastError: summary.lastError } : {}),
        }),
    ...(tools.length > 0
      ? { tools, ...(summary.tools.length > tools.length ? { moreTools: summary.tools.length - tools.length } : {}) }
      : {}),
  };
}

// How many rows of each kind an overview left out; empty when it lists everything.
export function notListed(totals, rows) {
  return Object.fromEntries(
    Object.entries(totals).map(([kind, total]) => [kind, total - rows[kind].length]).filter(([, left]) => left > 0),
  );
}

export function listedToolNames(connectionCount) {
  return connectionCount > 0 && connectionCount <= FOCUSED_CONNECTIONS ? Math.floor(LISTED_TOOL_NAMES / connectionCount) : 0;
}

export function overviewConnectionRow(summary, descriptionChars) {
  return {
    id: summary.id,
    name: summary.name,
    ...(descriptionChars > 0 ? { description: shortText(summary.description, descriptionChars) } : {}),
    category: summary.category,
    locationLabel: summary.locationLabel,
    statusLabel: summary.statusLabel,
    ...(summary.connected ? {} : { connected: false, authRequired: summary.authRequired }),
    toolCount: summary.toolCount,
  };
}

// A Skill's body is ranking input only. Its content reaches the agent through the budgeted
// `content` field, never as part of a row.
export function skillRow(skill, { descriptionChars = 300 } = {}) {
  return {
    id: skill.id,
    name: skill.name,
    category: skill.category,
    categoryLabel: skill.categoryLabel,
    description: shortText(skill.description, descriptionChars),
    namespace: skill.namespace,
    ...(skill.partner ? { partner: true, ...(skill.connectionId ? { connectionId: skill.connectionId } : {}) } : {}),
    ...(skill.systemId ? { systemId: skill.systemId } : {}),
    bundled: Boolean(skill.bundled),
    ...(skill.content !== undefined ? { content: skill.content } : {}),
    ...(skill.files ? { files: skill.files } : {}),
  };
}

// Only what differs from an ordinary user Skill named after its id.
export function overviewSkillRow(skill, descriptionChars) {
  const { id, name, category, categoryLabel, description, namespace, systemId, bundled, ...inline } = skillRow(skill, { descriptionChars });
  return {
    id,
    ...(name && name !== id ? { name } : {}),
    category,
    ...(description ? { description } : {}),
    ...(namespace && namespace !== 'user' ? { namespace } : {}),
    ...(systemId ? { systemId } : {}),
    ...(bundled ? { bundled } : {}),
    ...inline,
  };
}

// Memory text is the user's wording, so a long one is cut and never reworded.
function cutText(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  const slice = value.slice(0, maxChars);
  const space = slice.lastIndexOf(' ');
  return `${space > maxChars / 2 ? slice.slice(0, space) : slice}…`;
}

export function overviewMemoryRow(memory) {
  const profiles = Array.isArray(memory.profiles) ? memory.profiles : [];
  return {
    id: memory.id,
    key: memory.key,
    content: cutText(memory.content, OVERVIEW_MEMORY_CHARS),
    scope: memory.scope,
    ...(memory.project ? { project: memory.project } : {}),
    ...(memory.tags?.length ? { tags: memory.tags } : {}),
    ...(memory.pinned ? { pinned: true } : {}),
    ...(profiles.length === 1 && profiles[0] === 'all' ? {} : { projects: profiles }),
    writtenBy: memory.writtenBy,
    updatedAt: memory.updatedAt,
    ...(memory.newerMemory ? { newerMemory: memory.newerMemory } : {}),
  };
}
