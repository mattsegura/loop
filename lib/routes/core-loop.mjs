// Unified HTTP handlers for Loop Core history and sleep-time review ("dream").
// Shared by workspace routes (/api/history, /api/dream*) and
// Loop Text settings routes (/api/sms-agent/dream*).
import { readJsonBody, sendJson } from '../http/transport.mjs';

export async function handleCoreLoopRoute(req, res, {
  pathname,
  url,
  prefix = '/api',
  historyStore = null,
  dreamStore = null,
  searchIndex = null,
  scheduleSearchReindex = null,
  broadcast = null,
} = {}) {
  const method = req.method;

  if (prefix === '/api' && pathname === '/api/history' && method === 'GET') {
    if (!historyStore) return sendJson(res, 503, { error: 'Conversation history is unavailable.' }), true;
    const query = url.searchParams.get('query') || '';
    const channel = url.searchParams.get('channel') || '';
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 20) || 20, 50));
    return sendJson(res, 200, { ok: true, ...(await historyStore.search({ query, channel, limit })) }), true;
  }

  if (pathname === `${prefix}/dream`) {
    if (method !== 'GET' && method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' }), true;
    }
    if (!dreamStore) {
      return sendJson(res, 503, { error: 'Sleep-time memory review is unavailable.' }), true;
    }
    if (method === 'GET') {
      return sendJson(res, 200, { ok: true, dream: await dreamStore.summary() }), true;
    }
    const body = await readJsonBody(req);
    if (body?.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return sendJson(res, 400, { error: 'enabled must be a boolean.' }), true;
    }
    if (body?.reviewBeforeApply !== undefined && typeof body.reviewBeforeApply !== 'boolean') {
      return sendJson(res, 400, { error: 'reviewBeforeApply must be a boolean.' }), true;
    }
    try {
      const dream = await dreamStore.setConfig({
        ...(typeof body?.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(body?.triggerMode !== undefined ? { triggerMode: body.triggerMode } : {}),
        ...(body?.stepInterval !== undefined ? { stepInterval: body.stepInterval } : {}),
        ...(typeof body?.reviewBeforeApply === 'boolean' ? { reviewBeforeApply: body.reviewBeforeApply } : {}),
        ...(body?.applyMode !== undefined ? { applyMode: body.applyMode } : {}),
      });
      return sendJson(res, 200, { ok: true, dream }), true;
    } catch (err) {
      return sendJson(res, err?.status || 400, { error: err?.message || 'Invalid dream configuration.' }), true;
    }
  }

  if (pathname === `${prefix}/dream/run`) {
    if (method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }), true;
    }
    if (!dreamStore) {
      return sendJson(res, 503, { error: 'Sleep-time memory review is unavailable.' }), true;
    }
    const body = await readJsonBody(req);
    try {
      const result = await dreamStore.run({
        trigger: 'manual',
        dryRun: Boolean(body?.dryRun),
        force: Boolean(body?.force),
      });
      if (result?.savedCount > 0) scheduleSearchReindex?.();
      return sendJson(res, 200, result), true;
    } catch (err) {
      return sendJson(res, err?.status || 502, { error: err?.message || 'Sleep-time memory review failed.' }), true;
    }
  }

  if (pathname === `${prefix}/dream/proposals`) {
    if (method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }), true;
    }
    if (!dreamStore) {
      return sendJson(res, 503, { error: 'Sleep-time memory review is unavailable.' }), true;
    }
    const body = await readJsonBody(req);
    const decision = typeof body?.decision === 'string' ? body.decision.trim() : '';
    if (decision !== 'approve' && decision !== 'dismiss') {
      return sendJson(res, 400, { error: 'decision must be "approve" or "dismiss".' }), true;
    }
    const all = Boolean(body?.all);
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!all && !id) {
      return sendJson(res, 400, { error: 'id is required unless all is true.' }), true;
    }
    try {
      const result = await dreamStore.resolveProposal({
        id,
        decision,
        all,
        actor: 'owner',
        writtenBy: 'Owner',
        allowSkills: true,
      });
      if (result?.applied > 0) {
        scheduleSearchReindex?.();
        broadcast?.('memory');
      }
      return sendJson(res, 200, result), true;
    } catch (err) {
      return sendJson(res, err?.status || 400, { error: err?.message || 'Could not resolve proposal.' }), true;
    }
  }

  if (pathname === `${prefix}/dream/doctor`) {
    if (method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }), true;
    }
    if (!dreamStore) {
      return sendJson(res, 503, { error: 'Sleep-time memory review is unavailable.' }), true;
    }
    const body = await readJsonBody(req);
    const symptom = typeof body?.symptom === 'string' ? body.symptom.trim().slice(0, 200) : '';
    return sendJson(res, 200, await dreamStore.doctor({ symptom })), true;
  }

  if (pathname === `${prefix}/dream/remember`) {
    if (method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }), true;
    }
    if (!dreamStore) {
      return sendJson(res, 503, { error: 'Sleep-time memory review is unavailable.' }), true;
    }
    const body = await readJsonBody(req);
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (text.length < 3 || text.length > 600) {
      return sendJson(res, 400, { error: 'text must be between 3 and 600 characters.' }), true;
    }
    try {
      const result = await dreamStore.remember({ text, actor: 'owner', writtenBy: 'Owner' });
      if (result?.memory) await searchIndex?.upsertMemoryImmediate(result.memory).catch(() => {});
      broadcast?.('memory');
      return sendJson(res, 200, result), true;
    } catch (err) {
      return sendJson(res, err?.status || 400, { error: err?.message || 'Could not save memory.' }), true;
    }
  }

  return false;
}
