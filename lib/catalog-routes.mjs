// Verified Service Catalog, OpenAPI/GraphQL import, Access Sets CRUD, Services view,
// and Guided Setup status routes (v3 hybrid contract).

import { importApiConnection } from './api-transports.mjs';
import {
  BUILTIN_ACCESS_SET_IDS,
  buildServicesView,
  listAllAccessSets,
  normalizeAccessSet,
  normalizeAccessSets,
  serviceKeyOf,
} from './services.mjs';

export const VERIFIED_CATALOG = Object.freeze([
  Object.freeze({
    id: 'linear',
    name: 'Linear',
    logo: 'L',
    description: 'Issues, projects, cycles, and team workflows.',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
  }),
  Object.freeze({
    id: 'notion',
    name: 'Notion',
    logo: 'N',
    description: 'Pages, databases, and workspace knowledge.',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
  }),
  Object.freeze({
    id: 'github',
    name: 'GitHub',
    logo: 'GH',
    description: 'Repositories, pull requests, issues, and code search.',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'oauth',
  }),
  Object.freeze({
    id: 'stripe',
    name: 'Stripe',
    logo: 'S',
    description: 'Customers, invoices, subscriptions, and payments.',
    url: 'https://mcp.stripe.com',
    auth: 'oauth',
  }),
  Object.freeze({
    id: 'supabase',
    name: 'Supabase',
    logo: 'SB',
    description: 'Postgres databases, edge functions, and project logs.',
    url: 'https://mcp.supabase.com/mcp',
    auth: 'oauth',
  }),
  Object.freeze({
    id: 'vercel',
    name: 'Vercel',
    logo: '▲',
    description: 'Deployments, projects, domains, and runtime logs.',
    url: 'https://mcp.vercel.com',
    auth: 'oauth',
  }),
  Object.freeze({
    id: 'sentry',
    name: 'Sentry',
    logo: 'Se',
    description: 'Error tracking, releases, and performance issues.',
    url: 'https://mcp.sentry.dev/mcp',
    auth: 'oauth',
  }),
  Object.freeze({
    id: 'cloudflare',
    name: 'Cloudflare',
    logo: 'CF',
    description: 'Workers, KV, D1, R2, and DNS management.',
    url: 'https://docs.mcp.cloudflare.com/mcp',
    auth: 'oauth',
  }),
  Object.freeze({
    id: 'google',
    name: 'Google Workspace',
    logo: 'G',
    description: 'Gmail, Google Calendar, and Google Drive with granular read/write scopes.',
    url: 'https://accounts.google.com',
    auth: 'google',
    parts: Object.freeze([
      Object.freeze({ id: 'gmail-read', label: 'Gmail (Read)', kind: 'read', product: 'gmail', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }),
      Object.freeze({ id: 'gmail-write', label: 'Gmail (Send & Draft)', kind: 'write', product: 'gmail', scopes: ['https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.send'] }),
      Object.freeze({ id: 'calendar-read', label: 'Calendar (Read)', kind: 'read', product: 'calendar', scopes: ['https://www.googleapis.com/auth/calendar.readonly'] }),
      Object.freeze({ id: 'calendar-write', label: 'Calendar (Events)', kind: 'write', product: 'calendar', scopes: ['https://www.googleapis.com/auth/calendar.events'] }),
      Object.freeze({ id: 'drive-read', label: 'Drive (Read)', kind: 'read', product: 'drive', scopes: ['https://www.googleapis.com/auth/drive.readonly'] }),
    ]),
  }),
]);

export function buildCatalogItems(env = process.env) {
  const googleConfigured = Boolean(
    String(env.GOOGLE_OAUTH_CLIENT_ID || '').trim() &&
    String(env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim(),
  );
  return VERIFIED_CATALOG.map((item) => {
    if (item.auth === 'google') {
      return {
        ...item,
        available: googleConfigured,
        ...(!googleConfigured ? { reason: 'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET on the server to enable managed Google sign-in.' } : {}),
      };
    }
    return { ...item, available: true };
  });
}

export async function handleCatalogAndV3Routes({
  req,
  res,
  url,
  pathname,
  method,
  store,
  vault,
  pool,
  activity,
  personal,
  selfIdentity,
  origin,
  startUpstreamOAuth,
  readJsonBody,
  sendJson,
  broadcast,
  scheduleSearchReindex,
  peopleCheckHandler = null,
}) {
  // 1. GET /api/catalog
  if (pathname === '/api/catalog' && method === 'GET') {
    return sendJson(res, 200, { items: buildCatalogItems() }), true;
  }

  // 2. POST /api/catalog/:id/add
  const catalogAddMatch = pathname.match(/^\/api\/catalog\/([^/]+)\/add$/);
  if (catalogAddMatch && method === 'POST') {
    const id = decodeURIComponent(catalogAddMatch[1]).trim().toLowerCase();
    const item = buildCatalogItems().find((c) => c.id === id);
    if (!item) return sendJson(res, 404, { error: `Unknown catalog item "${id}".` }), true;
    if (!item.available) return sendJson(res, 400, { error: item.reason || `${item.name} is unavailable.` }), true;

    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const accountLabel = typeof body?.accountLabel === 'string' ? body.accountLabel.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 60) : '';
    const agentNote = typeof body?.agentNote === 'string' ? body.agentNote.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 280) : '';
    const displayName = accountLabel ? `${item.name} (${accountLabel})` : item.name;

    const conn = await store.add({
      name: displayName,
      description: item.description,
      transport: 'http',
      url: item.url,
      accountLabel,
      agentNote,
      authRequired: item.auth === 'oauth' || item.auth === 'google',
      addedBy: 'Owner',
    });

    let signIn = null;
    if (typeof startUpstreamOAuth === 'function' && (item.auth === 'oauth' || item.auth === 'google')) {
      try {
        const started = await startUpstreamOAuth(conn);
        if (started?.authorizeUrl) signIn = { url: started.authorizeUrl };
      } catch {
        // Connection saved; user can complete sign-in from Home.
      }
    }
    broadcast?.('connections', { id: conn.id });
    scheduleSearchReindex?.();
    return sendJson(res, 201, { connection: conn, signIn }), true;
  }

  // 3. POST /api/mcps/import-api (OpenAPI / GraphQL)
  if (pathname === '/api/mcps/import-api' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (err) { return sendJson(res, err?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid JSON body.' }), true; }

    try {
      const compiled = await importApiConnection({
        kind: body?.kind || body?.transport,
        url: body?.url || body?.specUrl,
        specText: typeof body?.specText === 'string' ? body.specText : null,
        name: body?.name,
        authHeader: body?.authHeader,
        authValue: body?.authValue,
        personal,
        selfIdentity,
      });

      // Auto-vault plaintext authValue in local mode so credentials never rest in config.json.
      const headers = { ...(compiled.headers || {}) };
      if (!personal && body?.authHeader && body?.authValue && !String(body.authValue).includes('{{vault:')) {
        const headerName = String(body.authHeader).trim();
        const safeSlug = String(compiled.name || 'api').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28) || 'api';
        const vaultKey = `api_${safeSlug}_auth`;
        await vault.set(vaultKey, String(body.authValue), {
          type: 'api_key',
          description: `${compiled.name} (${headerName})`,
          allowedSinks: [`origin:${new URL(compiled.url).origin.toLowerCase()}`],
        });
        headers[headerName] = `{{vault:${vaultKey}}}`;
      }

      const conn = await store.add({
        name: compiled.name,
        description: compiled.description,
        transport: compiled.transport,
        url: compiled.url,
        ...(compiled.specUrl ? { specUrl: compiled.specUrl } : {}),
        ...(compiled.apiOperations ? { apiOperations: compiled.apiOperations } : {}),
        headers,
        tools: compiled.tools,
        accountLabel: typeof body?.accountLabel === 'string' ? body.accountLabel : '',
        agentNote: typeof body?.agentNote === 'string' ? body.agentNote : '',
        authRequired: false,
        lastSyncAt: new Date().toISOString(),
        addedBy: 'Owner',
      });
      broadcast?.('connections', { id: conn.id });
      scheduleSearchReindex?.();
      return sendJson(res, 201, { connection: conn, toolCount: Array.isArray(conn.tools) ? conn.tools.length : 0 }), true;
    } catch (err) {
      return sendJson(res, err?.status || 400, { error: err?.message || 'Could not import API.' }), true;
    }
  }

  // 4. GET / POST /api/access-sets
  if (pathname === '/api/access-sets') {
    if (method === 'GET') {
      const [settings, agents] = await Promise.all([store.getSettings(), store.listAgents()]);
      return sendJson(res, 200, { sets: listAllAccessSets(settings.accessSets, agents) }), true;
    }
    if (method === 'POST') {
      let body;
      try { body = await readJsonBody(req); }
      catch { return sendJson(res, 400, { error: 'Invalid JSON body.' }), true; }
      const settings = await store.getSettings();
      const existing = normalizeAccessSets(settings.accessSets);
      const takenIds = new Set(existing.map((s) => s.id));
      const created = normalizeAccessSet(body, takenIds);
      if (!created) return sendJson(res, 400, { error: 'Access set name is required.' }), true;
      if (takenIds.has(created.id)) {
        return sendJson(res, 409, { error: `Access set "${created.id}" already exists.` }), true;
      }
      await store.updateSettings({ accessSets: [...existing, created] });
      broadcast?.('settings', { accessSets: true });
      return sendJson(res, 201, { set: { ...created, builtin: false, kind: 'custom', agents: [] } }), true;
    }
    return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' }), true;
  }

  // 5. PATCH / DELETE /api/access-sets/:id
  const setMatch = pathname.match(/^\/api\/access-sets\/([^/]+)$/);
  if (setMatch) {
    const setId = decodeURIComponent(setMatch[1]).trim().toLowerCase();
    if (BUILTIN_ACCESS_SET_IDS.includes(setId)) {
      return sendJson(res, 400, { error: `Built-in access set "${setId}" cannot be edited or deleted.` }), true;
    }
    const [settings, agents] = await Promise.all([store.getSettings(), store.listAgents()]);
    const existing = normalizeAccessSets(settings.accessSets);
    const idx = existing.findIndex((s) => s.id === setId);
    if (idx === -1) return sendJson(res, 404, { error: `Access set "${setId}" not found.` }), true;

    if (method === 'PATCH') {
      let body;
      try { body = await readJsonBody(req); }
      catch { return sendJson(res, 400, { error: 'Invalid JSON body.' }), true; }
      const merged = normalizeAccessSet({
        ...existing[idx],
        ...(body?.name !== undefined ? { name: body.name } : {}),
        ...(body?.connections !== undefined ? { connections: body.connections } : {}),
        ...(body?.skills !== undefined ? { skills: body.skills } : {}),
        id: setId,
      });
      if (!merged) return sendJson(res, 400, { error: 'Invalid access set payload.' }), true;
      const next = [...existing];
      next[idx] = merged;
      await store.updateSettings({ accessSets: next });
      broadcast?.('settings', { accessSets: true });
      const users = agents.filter((a) => a.accessSet === setId).map((a) => ({ id: a.id, name: a.name }));
      return sendJson(res, 200, { set: { ...merged, builtin: false, kind: 'custom', agents: users } }), true;
    }

    if (method === 'DELETE') {
      const users = agents.filter((a) => a.accessSet === setId).map((a) => ({ id: a.id, name: a.name }));
      if (users.length > 0) {
        return sendJson(res, 409, {
          error: `Access set "${existing[idx].name}" is in use by ${users.length} agent(s).`,
          agents: users,
        }), true;
      }
      const next = existing.filter((s) => s.id !== setId);
      await store.updateSettings({ accessSets: next });
      broadcast?.('settings', { accessSets: true });
      return sendJson(res, 200, { deleted: true, id: setId }), true;
    }
    return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'PATCH, DELETE' }), true;
  }

  // 6. GET /api/services
  if (pathname === '/api/services' && method === 'GET') {
    const [connections, agents] = await Promise.all([store.list({ clone: false }), store.listAgents()]);
    const view = buildServicesView({ connections, agents, catalog: VERIFIED_CATALOG });
    return sendJson(res, 200, view), true;
  }

  // 7. GET /api/setup/status
  if (pathname === '/api/setup/status' && method === 'GET') {
    const sinceParam = url.searchParams.get('since') || '';
    const sinceMs = sinceParam ? Date.parse(sinceParam) : 0;
    const [agents, connections, recent] = await Promise.all([
      store.listAgents(),
      store.list({ clone: false }),
      activity.list({ limit: 100 }),
    ]);
    const lastSeen = typeof activity.lastSeenMap === 'function' ? activity.lastSeenMap() : activity.lastSeen;
    const agentRows = agents.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      createdAt: a.createdAt,
      lastSeenAt: lastSeen?.get?.(a.id) || null,
    }));
    const firstCallEntry = recent.find((e) => {
      if (!e || (e.method !== 'tools/call' && e.method !== 'run')) return false;
      if (Number.isFinite(sinceMs) && sinceMs > 0) {
        const atMs = Date.parse(e.at || '');
        if (!Number.isFinite(atMs) || atMs < sinceMs) return false;
      }
      return true;
    }) || null;
    const firstCall = firstCallEntry
      ? {
          at: firstCallEntry.at,
          agentName: firstCallEntry.agentName || 'Agent',
          target: firstCallEntry.target || firstCallEntry.tool || '',
          ms: firstCallEntry.ms ?? null,
          ok: Boolean(firstCallEntry.ok),
        }
      : null;
    const userConnections = connections.filter((c) => c.transport !== 'builtin').length;
    return sendJson(res, 200, { agents: agentRows, firstCall, connections: userConnections }), true;
  }

  // 8. POST /api/people/:personId/items/:itemId/check
  const peopleCheckMatch = pathname.match(/^\/api\/people\/([^/]+)\/items\/([^/]+)\/check$/);
  if (peopleCheckMatch && method === 'POST') {
    if (typeof peopleCheckHandler !== 'function') {
      return sendJson(res, 404, { error: 'People sharing is not enabled on this server.' }), true;
    }
    const personId = decodeURIComponent(peopleCheckMatch[1]);
    const itemId = decodeURIComponent(peopleCheckMatch[2]);
    return await peopleCheckHandler({ personId, itemId, req, res, sendJson }), true;
  }

  return false;
}
