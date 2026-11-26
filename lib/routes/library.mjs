// The dashboard's API for the Library as one connected thing (lib/library.mjs): the layers of the
// map, one item with its links, the picker for a new link, and Gather.
// Only the owner's session reaches these routes. `profile` is the Project that the page shows.

import { readJsonBody, sendJson } from '../http/transport.mjs';
import { LIBRARY_LAYERS } from '../library-graph.mjs';
import { LINK_RELATIONS } from '../library-links.mjs';

async function bodyOf(req, res) {
  try {
    return await readJsonBody(req);
  } catch (err) {
    sendJson(res, err?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err?.publicMessage || 'Invalid JSON body.' });
    return null;
  }
}

function fail(res, err, fallback) {
  return sendJson(res, err?.status || 400, { error: err?.message || fallback, ...(err?.code ? { code: err.code } : {}) });
}

export async function handleLibraryRoute(req, res, {
  pathname,
  url,
  profile = 'all',
  library = null,
  searchIndex = null,
  broadcast = null,
  activity = null,
} = {}) {
  if (pathname !== '/api/library' && !pathname.startsWith('/api/library/')) return false;
  if (!library) return sendJson(res, 503, { error: 'The Library is not available.' }), true;
  const method = req.method;

  if (pathname === '/api/library/map') {
    if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' }), true;
    const layers = String(url.searchParams.get('layers') || '')
      .split(',')
      .map((l) => l.trim())
      .filter((l) => LIBRARY_LAYERS.includes(l));
    const cap = Number(url.searchParams.get('cap')) || undefined;
    const map = await library.map({ profile, layers, cap });
    return sendJson(res, 200, { ok: true, profile, ...map }), true;
  }

  if (pathname === '/api/library/find') {
    if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' }), true;
    const items = await library.find(url.searchParams.get('q') || '', {
      profile,
      exclude: url.searchParams.get('exclude') || '',
    });
    return sendJson(res, 200, { ok: true, items }), true;
  }

  const itemMatch = pathname.match(/^\/api\/library\/item\/([^/]+)$/);
  if (itemMatch) {
    if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' }), true;
    let id;
    try { id = decodeURIComponent(itemMatch[1]); }
    catch { return sendJson(res, 400, { error: 'Invalid item id.' }), true; }
    const found = await library.item(id, { profile });
    if (!found) return sendJson(res, 404, { error: 'This item is not in the Library.' }), true;
    return sendJson(res, 200, { ok: true, ...found, relations: LINK_RELATIONS }), true;
  }

  if (pathname === '/api/library/links') {
    if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }), true;
    const body = await bodyOf(req, res);
    if (!body) return true;
    const source = String(body.source || '').trim();
    const list = Array.isArray(body.links) ? body.links : body.target ? [{ target: body.target, relation: body.relation }] : [];
    if (!source || list.length === 0) return sendJson(res, 400, { error: 'A link needs the item it starts from and the item it goes to.' }), true;
    try {
      const result = await library.addLinks(source, list, { profile, writtenBy: 'Owner' });
      if (result.links.length === 0) {
        return sendJson(res, 400, { error: result.skipped[0]?.reason || 'Could not link these items.', skipped: result.skipped }), true;
      }
      broadcast?.('memory'); // the map of every open page shows the link
      return sendJson(res, 201, { ok: true, ...result }), true;
    } catch (err) {
      return fail(res, err, 'Could not link these items.'), true;
    }
  }

  const linkMatch = pathname.match(/^\/api\/library\/links\/([^/]+)$/);
  if (linkMatch) {
    if (method !== 'DELETE') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'DELETE' }), true;
    let id;
    try { id = decodeURIComponent(linkMatch[1]); }
    catch { return sendJson(res, 400, { error: 'Invalid link id.' }), true; }
    try {
      const removed = await library.removeLink(id, { profile });
      if (!removed) return sendJson(res, 404, { error: 'Link not found.' }), true;
      broadcast?.('memory'); // the map of every open page shows the link
      return sendJson(res, 200, { ok: true, removed: true }), true;
    } catch (err) {
      return fail(res, err, 'Could not remove the link.'), true;
    }
  }

  if (pathname === '/api/library/gather') {
    if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }), true;
    const body = await bodyOf(req, res);
    if (!body) return true;
    const input = {
      ids: Array.isArray(body.ids) ? body.ids : [],
      title: typeof body.title === 'string' ? body.title : '',
      profile,
    };
    try {
      if (body.save !== true) return sendJson(res, 200, { ok: true, ...(await library.gather(input)) }), true;
      const result = await library.saveGathered({ ...input, savedId: typeof body.savedId === 'string' ? body.savedId : '', writtenBy: 'Owner' });
      await searchIndex?.upsertSavedImmediate?.(result.saved).catch(() => {});
      activity?.record?.({ agentId: null, agentName: 'Owner (dashboard)', method: 'library/gather', target: result.saved.displayTitle || result.saved.id, ok: true });
      broadcast?.('saved');
      return sendJson(res, result.created ? 201 : 200, { ok: true, ...result }), true;
    } catch (err) {
      return fail(res, err, 'Could not gather these items.'), true;
    }
  }

  return sendJson(res, 404, { error: 'Not found.' }), true;
}
