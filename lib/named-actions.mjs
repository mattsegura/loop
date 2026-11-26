// Named action mappings: translate a narrow, owner-selected action (for example
// "Search Work Gmail" or "List Calendar Events") into a specific provider operation and
// account without granting an agent full access to a multi-action broker tool.

import { isToolEnabled } from './store.mjs';

export const NAMED_ACTION_PREFIX = 'action:';
export const GMAIL_SEARCH_ACTION_BASE = 'action:gmail.search';
export const CALENDAR_LIST_ACTION_BASE = 'action:calendar.list_events';
export const SLACK_SEARCH_ACTION_BASE = 'action:slack.search';
export const LINEAR_LIST_ACTION_BASE = 'action:linear.list_issues';
export const GITHUB_SEARCH_ACTION_BASE = 'action:github.search_issues';

export const READ_ONLY_ACTION_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

export const GMAIL_SEARCH_ANNOTATIONS = READ_ONLY_ACTION_ANNOTATIONS;

const GMAIL_SEARCH_ALLOWED_KEYS = new Set([
  'query',
  'maxResults',
  'pageToken',
  'includeSpamTrash',
  'labelIds',
]);

export const GMAIL_SEARCH_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    query: {
      type: 'string',
      maxLength: 1000,
      description: 'Gmail search query (for example "from:alex@company.com newer_than:7d").',
    },
    maxResults: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Maximum number of messages to return (1 to 50, default 10).',
    },
    pageToken: {
      type: 'string',
      maxLength: 512,
      description: 'Pagination token from a previous Gmail search.',
    },
    includeSpamTrash: {
      type: 'boolean',
      description: 'Include messages from Spam and Trash.',
    },
    labelIds: {
      type: 'array',
      items: { type: 'string', maxLength: 100 },
      maxItems: 20,
      description: 'Optional Gmail label IDs to filter by.',
    },
  },
});

export const CALENDAR_LIST_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    timeMin: { type: 'string', maxLength: 64, description: 'ISO-8601 start time filter (inclusive).' },
    timeMax: { type: 'string', maxLength: 64, description: 'ISO-8601 end time filter (exclusive).' },
    query: { type: 'string', maxLength: 500, description: 'Optional text query for event titles or descriptions.' },
    maxResults: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum events to return (1 to 50, default 10).' },
    calendarId: { type: 'string', maxLength: 200, description: 'Optional calendar ID (default "primary").' },
  },
});

export const SLACK_SEARCH_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', maxLength: 500, description: 'Slack search query.' },
    count: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum messages to return (1 to 50, default 10).' },
    sort: { type: 'string', enum: ['score', 'timestamp'], description: 'Sort order ("score" or "timestamp").' },
  },
  required: ['query'],
});

export const LINEAR_LIST_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', maxLength: 500, description: 'Optional issue search text.' },
    team: { type: 'string', maxLength: 120, description: 'Optional team key or ID.' },
    state: { type: 'string', maxLength: 80, description: 'Optional workflow state name.' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum issues to return (1 to 50, default 20).' },
  },
});

export const GITHUB_SEARCH_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', maxLength: 500, description: 'GitHub search query (for example "repo:owner/name is:open").' },
    perPage: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum results per page (1 to 50, default 10).' },
    page: { type: 'integer', minimum: 1, maximum: 20, description: 'Page number (1 to 20).' },
  },
  required: ['query'],
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, max = 60) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>`\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function isNamedActionId(name) {
  return typeof name === 'string' && name.startsWith(NAMED_ACTION_PREFIX);
}

export function accountKeyOf(raw) {
  const trimmed = cleanText(raw, 64);
  if (!trimmed) return '';
  if (/^[A-Za-z0-9._-]{1,64}$/.test(trimmed)) return trimmed;
  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function resolveAppSignInList(conn, appSignIns) {
  if (typeof appSignIns === 'function') {
    const list = appSignIns(conn);
    return Array.isArray(list) ? list : [];
  }
  if (Array.isArray(appSignIns)) return appSignIns;
  if (Array.isArray(conn?.appSignIns)) return conn.appSignIns;
  return [];
}

function findEnabledTool(conn, predicate) {
  const tools = Array.isArray(conn?.tools) ? conn.tools : [];
  return tools.find((t) => t?.name && isToolEnabled(conn, t.name) && predicate(t)) || null;
}

function connHaystack(conn) {
  return [conn?.id, conn?.name, conn?.description, conn?.url].filter(Boolean).join(' ').toLowerCase();
}

function hasAppSignIn(appSignIns, appRe) {
  return appSignIns.some((r) => appRe.test(cleanText(r?.app, 60)));
}

function validateSimpleSchemaArgs(rawArgs, schema, label) {
  const input = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
  if (!isPlainObject(input)) {
    return { ok: false, error: `${label} arguments must be a JSON object.` };
  }
  const props = schema.properties || {};
  const allowed = new Set(Object.keys(props));
  const unknown = Object.keys(input).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `This ${label} grant only allows ${[...allowed].join(', ')} (rejected: ${unknown.join(', ')}).`,
    };
  }
  const clean = {};
  for (const reqKey of schema.required || []) {
    if (input[reqKey] === undefined || input[reqKey] === null || (typeof input[reqKey] === 'string' && !input[reqKey].trim())) {
      return { ok: false, error: `${reqKey} is required for ${label}.` };
    }
  }
  for (const [k, def] of Object.entries(props)) {
    if (input[k] === undefined) continue;
    const val = input[k];
    if (def.type === 'string') {
      if (typeof val !== 'string' || (def.maxLength && val.length > def.maxLength)) {
        return { ok: false, error: `${k} must be a string up to ${def.maxLength || 500} characters.` };
      }
      if (Array.isArray(def.enum) && !def.enum.includes(val)) {
        return { ok: false, error: `${k} must be one of: ${def.enum.join(', ')}.` };
      }
      clean[k] = val;
    } else if (def.type === 'integer') {
      if (!Number.isInteger(val) || (def.minimum !== undefined && val < def.minimum) || (def.maximum !== undefined && val > def.maximum)) {
        return { ok: false, error: `${k} must be an integer between ${def.minimum ?? 1} and ${def.maximum ?? 50}.` };
      }
      clean[k] = val;
    } else if (def.type === 'boolean') {
      if (typeof val !== 'boolean') {
        return { ok: false, error: `${k} must be a boolean.` };
      }
      clean[k] = val;
    }
  }
  return { ok: true, args: clean };
}

function wrapComposioExecution(action, opArgs) {
  if (action.mode === 'composio_multi_execute') {
    return {
      ok: true,
      toolName: action.providerTool,
      arguments: {
        tools: [
          {
            tool_slug: action.providerOperation,
            ...(action.accountId ? { connected_account_id: action.accountId } : {}),
            arguments: opArgs,
          },
        ],
        sync_response_to_workbench: false,
      },
    };
  }
  return {
    ok: true,
    toolName: action.providerTool,
    arguments: {
      tool_slug: action.providerOperation,
      ...(action.accountId ? { connected_account_id: action.accountId } : {}),
      arguments: opArgs,
    },
  };
}

function mapDirectField(props, preferredKey, altKey) {
  const has = (k) => Object.hasOwn(props, k);
  return has(altKey) && !has(preferredKey) ? altKey : preferredKey;
}

export const NAMED_ACTION_TEMPLATES = Object.freeze([
  {
    kind: 'gmail.search',
    baseId: GMAIL_SEARCH_ACTION_BASE,
    app: 'Gmail',
    appRe: /^gmail$/i,
    connRe: /\bgmail\b|googlemail|google\s+mail/,
    composioSlug: 'GMAIL_FETCH_EMAILS',
    composioDirectTool: 'gmail_fetch_emails',
    directTools: new Set([
      'gmail_fetch_emails',
      'gmail_search',
      'gmail_search_messages',
      'gmail_list_messages',
      'search_emails',
      'search_messages',
      'list_messages',
    ]),
    // Gmail preserves legacy behavior: Composio broker without app-specific sign-ins still offers Gmail search.
    brokerAlwaysOffers: true,
    inputSchema: GMAIL_SEARCH_INPUT_SCHEMA,
    annotations: READ_ONLY_ACTION_ANNOTATIONS,
    titleFor(accountLabel) {
      const clean = cleanText(accountLabel, 60);
      if (!clean) return 'Search Gmail';
      if (/gmail/i.test(clean)) return `Search ${clean}`;
      return `Search ${clean} Gmail`;
    },
    descriptionFor(accountLabel, provider, pinnedText) {
      const clean = cleanText(accountLabel, 60);
      return `Search emails in ${clean ? `${clean} Gmail` : 'Gmail'} (read-only). Runs ${provider.providerOperation} ${pinnedText}.`;
    },
    validate: (rawArgs) => validateGmailSearchArgs(rawArgs),
    translate(action, clean) {
      const { query, maxResults, pageToken, includeSpamTrash, labelIds } = clean;
      if (action.mode === 'composio_multi_execute' || action.mode === 'composio_execute') {
        return wrapComposioExecution(action, {
          user_id: 'me',
          max_results: maxResults ?? 10,
          ...(query !== undefined ? { query } : {}),
          ...(pageToken !== undefined ? { page_token: pageToken } : {}),
          ...(includeSpamTrash !== undefined ? { include_spam_trash: includeSpamTrash } : {}),
          ...(labelIds !== undefined ? { label_ids: labelIds } : {}),
        });
      }
      const props = action.providerInputSchema?.properties || {};
      const hasProp = (k) => Object.hasOwn(props, k);
      const isComposioDirect = action.providerTool.toLowerCase() === 'gmail_fetch_emails';
      const directArgs = {};
      if (isComposioDirect || hasProp('user_id')) directArgs.user_id = 'me';
      if (action.accountId && hasProp('connected_account_id')) directArgs.connected_account_id = action.accountId;
      if (query !== undefined) directArgs[mapDirectField(props, 'query', 'q')] = query;
      const limitValue = maxResults ?? (isComposioDirect ? 10 : undefined);
      if (limitValue !== undefined) directArgs[mapDirectField(props, 'max_results', 'maxResults')] = limitValue;
      if (pageToken !== undefined) directArgs[mapDirectField(props, 'page_token', 'pageToken')] = pageToken;
      if (includeSpamTrash !== undefined) directArgs[mapDirectField(props, 'include_spam_trash', 'includeSpamTrash')] = includeSpamTrash;
      if (labelIds !== undefined) directArgs[mapDirectField(props, 'label_ids', 'labelIds')] = labelIds;
      return { ok: true, toolName: action.providerTool, arguments: directArgs };
    },
  },
  {
    kind: 'calendar.list_events',
    baseId: CALENDAR_LIST_ACTION_BASE,
    app: 'Google Calendar',
    appRe: /^(?:google[ _-]?calendar|calendar|gcal)$/i,
    connRe: /\bcalendar\b|\bgcal\b/,
    composioSlug: 'GOOGLECALENDAR_EVENTS_LIST',
    composioDirectTool: 'googlecalendar_events_list',
    directTools: new Set(['googlecalendar_events_list', 'calendar_list_events', 'list_events', 'get_events']),
    brokerAlwaysOffers: false,
    inputSchema: CALENDAR_LIST_INPUT_SCHEMA,
    annotations: READ_ONLY_ACTION_ANNOTATIONS,
    titleFor(accountLabel) {
      const clean = cleanText(accountLabel, 60);
      return clean ? `List ${clean} Calendar events` : 'List Calendar events';
    },
    descriptionFor(accountLabel, provider, pinnedText) {
      const clean = cleanText(accountLabel, 60);
      return `List events from ${clean ? `${clean} Calendar` : 'Calendar'} (read-only). Runs ${provider.providerOperation} ${pinnedText}.`;
    },
    validate: (rawArgs) => validateSimpleSchemaArgs(rawArgs, CALENDAR_LIST_INPUT_SCHEMA, 'Calendar list'),
    translate(action, clean) {
      if (action.mode === 'composio_multi_execute' || action.mode === 'composio_execute') {
        return wrapComposioExecution(action, {
          calendarId: clean.calendarId || 'primary',
          maxResults: clean.maxResults ?? 10,
          ...(clean.timeMin ? { timeMin: clean.timeMin } : {}),
          ...(clean.timeMax ? { timeMax: clean.timeMax } : {}),
          ...(clean.query ? { q: clean.query } : {}),
        });
      }
      const props = action.providerInputSchema?.properties || {};
      const directArgs = {};
      if (clean.calendarId !== undefined) directArgs[mapDirectField(props, 'calendarId', 'calendar_id')] = clean.calendarId;
      if (clean.timeMin !== undefined) directArgs[mapDirectField(props, 'timeMin', 'time_min')] = clean.timeMin;
      if (clean.timeMax !== undefined) directArgs[mapDirectField(props, 'timeMax', 'time_max')] = clean.timeMax;
      if (clean.query !== undefined) directArgs[mapDirectField(props, 'query', 'q')] = clean.query;
      if (clean.maxResults !== undefined) directArgs[mapDirectField(props, 'maxResults', 'max_results')] = clean.maxResults;
      return { ok: true, toolName: action.providerTool, arguments: directArgs };
    },
  },
  {
    kind: 'slack.search',
    baseId: SLACK_SEARCH_ACTION_BASE,
    app: 'Slack',
    appRe: /^slack$/i,
    connRe: /\bslack\b/,
    composioSlug: 'SLACK_SEARCH_MESSAGES',
    composioDirectTool: 'slack_search_messages',
    directTools: new Set(['slack_search_messages', 'search_messages', 'slack_search']),
    brokerAlwaysOffers: false,
    inputSchema: SLACK_SEARCH_INPUT_SCHEMA,
    annotations: READ_ONLY_ACTION_ANNOTATIONS,
    titleFor(accountLabel) {
      const clean = cleanText(accountLabel, 60);
      return clean ? `Search ${clean} Slack` : 'Search Slack';
    },
    descriptionFor(accountLabel, provider, pinnedText) {
      const clean = cleanText(accountLabel, 60);
      return `Search messages in ${clean ? `${clean} Slack` : 'Slack'} (read-only). Runs ${provider.providerOperation} ${pinnedText}.`;
    },
    validate: (rawArgs) => validateSimpleSchemaArgs(rawArgs, SLACK_SEARCH_INPUT_SCHEMA, 'Slack search'),
    translate(action, clean) {
      if (action.mode === 'composio_multi_execute' || action.mode === 'composio_execute') {
        return wrapComposioExecution(action, {
          query: clean.query,
          count: clean.count ?? 10,
          ...(clean.sort ? { sort: clean.sort } : {}),
        });
      }
      const props = action.providerInputSchema?.properties || {};
      const directArgs = { [mapDirectField(props, 'query', 'q')]: clean.query };
      if (clean.count !== undefined) directArgs[mapDirectField(props, 'count', 'limit')] = clean.count;
      if (clean.sort !== undefined) directArgs.sort = clean.sort;
      return { ok: true, toolName: action.providerTool, arguments: directArgs };
    },
  },
  {
    kind: 'linear.list_issues',
    baseId: LINEAR_LIST_ACTION_BASE,
    app: 'Linear',
    appRe: /^linear$/i,
    connRe: /\blinear\b/,
    composioSlug: 'LINEAR_LIST_ISSUES',
    composioDirectTool: 'linear_list_issues',
    directTools: new Set(['linear_list_issues', 'list_issues', 'search_issues']),
    brokerAlwaysOffers: false,
    inputSchema: LINEAR_LIST_INPUT_SCHEMA,
    annotations: READ_ONLY_ACTION_ANNOTATIONS,
    titleFor(accountLabel) {
      const clean = cleanText(accountLabel, 60);
      return clean ? `List ${clean} Linear issues` : 'List Linear issues';
    },
    descriptionFor(accountLabel, provider, pinnedText) {
      const clean = cleanText(accountLabel, 60);
      return `List issues in ${clean ? `${clean} Linear` : 'Linear'} (read-only). Runs ${provider.providerOperation} ${pinnedText}.`;
    },
    validate: (rawArgs) => validateSimpleSchemaArgs(rawArgs, LINEAR_LIST_INPUT_SCHEMA, 'Linear list'),
    translate(action, clean) {
      if (action.mode === 'composio_multi_execute' || action.mode === 'composio_execute') {
        return wrapComposioExecution(action, {
          limit: clean.limit ?? 20,
          ...(clean.query ? { query: clean.query } : {}),
          ...(clean.team ? { team: clean.team } : {}),
          ...(clean.state ? { state: clean.state } : {}),
        });
      }
      const directArgs = {};
      if (clean.query !== undefined) directArgs.query = clean.query;
      if (clean.team !== undefined) directArgs.team = clean.team;
      if (clean.state !== undefined) directArgs.state = clean.state;
      if (clean.limit !== undefined) directArgs.limit = clean.limit;
      return { ok: true, toolName: action.providerTool, arguments: directArgs };
    },
  },
  {
    kind: 'github.search_issues',
    baseId: GITHUB_SEARCH_ACTION_BASE,
    app: 'GitHub',
    appRe: /^github$/i,
    connRe: /\bgithub\b/,
    composioSlug: 'GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS',
    composioDirectTool: 'github_search_issues',
    directTools: new Set(['github_search_issues', 'search_issues', 'list_issues']),
    brokerAlwaysOffers: false,
    inputSchema: GITHUB_SEARCH_INPUT_SCHEMA,
    annotations: READ_ONLY_ACTION_ANNOTATIONS,
    titleFor(accountLabel) {
      const clean = cleanText(accountLabel, 60);
      return clean ? `Search ${clean} GitHub issues` : 'Search GitHub issues';
    },
    descriptionFor(accountLabel, provider, pinnedText) {
      const clean = cleanText(accountLabel, 60);
      return `Search issues and pull requests in ${clean ? `${clean} GitHub` : 'GitHub'} (read-only). Runs ${provider.providerOperation} ${pinnedText}.`;
    },
    validate: (rawArgs) => validateSimpleSchemaArgs(rawArgs, GITHUB_SEARCH_INPUT_SCHEMA, 'GitHub search'),
    translate(action, clean) {
      if (action.mode === 'composio_multi_execute' || action.mode === 'composio_execute') {
        return wrapComposioExecution(action, {
          q: clean.query,
          per_page: clean.perPage ?? 10,
          ...(clean.page ? { page: clean.page } : {}),
        });
      }
      const props = action.providerInputSchema?.properties || {};
      const directArgs = { [mapDirectField(props, 'q', 'query')]: clean.query };
      if (clean.perPage !== undefined) directArgs[mapDirectField(props, 'per_page', 'perPage')] = clean.perPage;
      if (clean.page !== undefined) directArgs.page = clean.page;
      return { ok: true, toolName: action.providerTool, arguments: directArgs };
    },
  },
]);

const TEMPLATE_BY_KIND = new Map(NAMED_ACTION_TEMPLATES.map((t) => [t.kind, t]));

function resolveTemplateProvider(template, conn, appSignIns = []) {
  const matchesApp = hasAppSignIn(appSignIns, template.appRe) || template.connRe.test(connHaystack(conn));
  const multiExec = findEnabledTool(conn, (t) => t.name.toLowerCase() === 'composio_multi_execute_tool');
  if (multiExec && (template.brokerAlwaysOffers || matchesApp)) {
    return {
      mode: 'composio_multi_execute',
      providerTool: multiExec.name,
      providerOperation: template.composioSlug,
      providerInputSchema: multiExec.inputSchema || null,
    };
  }
  const singleExec = findEnabledTool(conn, (t) => t.name.toLowerCase() === 'composio_execute_tool');
  if (singleExec && (template.brokerAlwaysOffers || matchesApp)) {
    return {
      mode: 'composio_execute',
      providerTool: singleExec.name,
      providerOperation: template.composioSlug,
      providerInputSchema: singleExec.inputSchema || null,
    };
  }
  const composioDirect = findEnabledTool(conn, (t) => t.name.toLowerCase() === template.composioDirectTool);
  if (composioDirect) {
    return {
      mode: 'direct',
      providerTool: composioDirect.name,
      providerOperation: composioDirect.name,
      providerInputSchema: composioDirect.inputSchema || null,
    };
  }
  if (matchesApp) {
    const direct = findEnabledTool(conn, (t) => template.directTools.has(t.name.toLowerCase()));
    if (direct) {
      return {
        mode: 'direct',
        providerTool: direct.name,
        providerOperation: direct.name,
        providerInputSchema: direct.inputSchema || null,
      };
    }
  }
  return null;
}

function buildActionFromTemplate(template, { id, accountLabel = '', accountId = '', signInId = '', provider }) {
  const cleanLabel = cleanText(accountLabel, 60);
  const cleanId = cleanText(accountId, 120);
  const title = template.titleFor(cleanLabel);
  const pinnedText = cleanLabel
    ? `pinned to ${cleanLabel}${cleanId ? ` (${cleanId})` : ''}`
    : cleanId
      ? `pinned to account ${cleanId}`
      : 'pinned to this connection';
  return {
    id,
    kind: template.kind,
    app: template.app,
    title,
    description: template.descriptionFor(cleanLabel, provider, pinnedText),
    accountLabel: cleanLabel,
    accountId: cleanId,
    ...(signInId ? { signInId } : {}),
    providerTool: provider.providerTool,
    providerOperation: provider.providerOperation,
    mode: provider.mode,
    providerInputSchema: provider.providerInputSchema,
    inputSchema: template.inputSchema,
    annotations: template.annotations,
  };
}

// Lists the named actions available for one connection.
// When app sign-ins exist behind a multi-account connector, only confirmed ("ready")
// accounts are offered so a pending second account cannot be granted before confirmation.
export function listNamedActionsForConnection(conn, { appSignIns = null } = {}) {
  if (!conn || conn.enabled === false) return [];
  const signIns = resolveAppSignInList(conn, appSignIns);
  const out = [];
  const seenIds = new Set();

  for (const template of NAMED_ACTION_TEMPLATES) {
    const provider = resolveTemplateProvider(template, conn, signIns);
    if (!provider) continue;

    const appRows = signIns.filter((r) => template.appRe.test(cleanText(r?.app, 60)));
    if (appRows.length > 0) {
      for (const rec of appRows) {
        if (rec.state !== 'ready') continue;
        const key = accountKeyOf(rec.accountId || rec.accountLabel || rec.id);
        if (!key) continue;
        const id = `${template.baseId}:${key}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        out.push(
          buildActionFromTemplate(template, {
            id,
            accountLabel: rec.accountLabel || conn.accountLabel || '',
            accountId: rec.accountId || '',
            signInId: rec.id || '',
            provider,
          }),
        );
      }
      continue;
    }

    if (!seenIds.has(template.baseId)) {
      seenIds.add(template.baseId);
      out.push(
        buildActionFromTemplate(template, {
          id: template.baseId,
          accountLabel: conn.accountLabel || '',
          accountId: '',
          provider,
        }),
      );
    }
  }
  return out;
}

export function publicNamedAction(action) {
  return {
    id: action.id,
    kind: action.kind,
    app: action.app,
    title: action.title,
    description: action.description,
    ...(action.accountLabel ? { accountLabel: action.accountLabel } : {}),
    ...(action.accountId ? { accountId: action.accountId } : {}),
    providerTool: action.providerTool,
    providerOperation: action.providerOperation,
    readOnly: action.annotations?.readOnlyHint === true,
  };
}

export function namedActionToTool(action) {
  return {
    name: action.id,
    title: action.title,
    description: action.description,
    inputSchema: action.inputSchema,
    annotations: action.annotations,
    namedAction: {
      id: action.id,
      kind: action.kind,
      app: action.app,
      title: action.title,
      accountLabel: action.accountLabel || '',
      accountId: action.accountId || '',
      ...(action.signInId ? { signInId: action.signInId } : {}),
      providerTool: action.providerTool,
      providerOperation: action.providerOperation,
      mode: action.mode,
      providerInputSchema: action.providerInputSchema || null,
    },
  };
}

// Resolves a named action on either an unprojected connection or a grant-projected connection.
export function resolveNamedAction(conn, actionName, { appSignIns = null } = {}) {
  if (!conn || !isNamedActionId(actionName)) return null;
  const fromCatalog = listNamedActionsForConnection(conn, { appSignIns }).find((a) => a.id === actionName);
  if (fromCatalog) return fromCatalog;

  // Projected connections carry the granted synthetic tool directly on conn.tools
  // (already checked against isToolEnabled(rawConn, providerTool) during projection).
  const projected = (Array.isArray(conn.tools) ? conn.tools : []).find(
    (t) => t?.name === actionName && t.namedAction && t.namedAction.id === actionName,
  );
  if (!projected) return null;
  const meta = projected.namedAction;
  const template = TEMPLATE_BY_KIND.get(meta.kind);
  if (Array.isArray(conn.disabledTools) && conn.disabledTools.includes(meta.providerTool)) return null;
  if (meta.signInId || meta.accountId) {
    const signIns = resolveAppSignInList(conn, appSignIns);
    if (signIns.length > 0) {
      const stillReady = signIns.some(
        (r) =>
          r.state === 'ready' &&
          (meta.signInId ? r.id === meta.signInId : true) &&
          (meta.accountId ? r.accountId === meta.accountId : true),
      );
      if (!stillReady) return null;
    }
  }
  return {
    ...meta,
    inputSchema: projected.inputSchema || template?.inputSchema || GMAIL_SEARCH_INPUT_SCHEMA,
    annotations: projected.annotations || template?.annotations || READ_ONLY_ACTION_ANNOTATIONS,
  };
}

export function validateGmailSearchArgs(rawArgs) {
  const input = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
  if (!isPlainObject(input)) {
    return { ok: false, error: 'Gmail search arguments must be a JSON object.' };
  }
  const unknown = Object.keys(input).filter((k) => !GMAIL_SEARCH_ALLOWED_KEYS.has(k));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `This Gmail search grant only allows query, maxResults, pageToken, includeSpamTrash, and labelIds (rejected: ${unknown.join(', ')}).`,
    };
  }
  const clean = {};
  if (input.query !== undefined) {
    if (typeof input.query !== 'string' || input.query.length > 1000) {
      return { ok: false, error: 'query must be a string up to 1000 characters.' };
    }
    clean.query = input.query;
  }
  if (input.maxResults !== undefined) {
    if (!Number.isInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > 50) {
      return { ok: false, error: 'maxResults must be an integer between 1 and 50.' };
    }
    clean.maxResults = input.maxResults;
  }
  if (input.pageToken !== undefined) {
    if (typeof input.pageToken !== 'string' || input.pageToken.length > 512) {
      return { ok: false, error: 'pageToken must be a string up to 512 characters.' };
    }
    clean.pageToken = input.pageToken;
  }
  if (input.includeSpamTrash !== undefined) {
    if (typeof input.includeSpamTrash !== 'boolean') {
      return { ok: false, error: 'includeSpamTrash must be a boolean.' };
    }
    clean.includeSpamTrash = input.includeSpamTrash;
  }
  if (input.labelIds !== undefined) {
    if (
      !Array.isArray(input.labelIds) ||
      input.labelIds.length > 20 ||
      input.labelIds.some((item) => typeof item !== 'string' || !item.trim() || item.length > 100)
    ) {
      return { ok: false, error: 'labelIds must be an array of up to 20 non-empty strings.' };
    }
    clean.labelIds = input.labelIds.map((item) => item.trim());
  }
  return { ok: true, args: clean };
}

export function translateNamedActionCall(action, rawArgs) {
  const template = action ? TEMPLATE_BY_KIND.get(action.kind) : null;
  if (!template) {
    return { ok: false, error: 'Unsupported named action.' };
  }
  const validated = template.validate(rawArgs);
  if (!validated.ok) return validated;
  return template.translate(action, validated.args);
}
