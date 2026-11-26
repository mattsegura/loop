// HTTP API route handlers for Loop's built-in Saved library, Schedules, Shared Files, and Notifications.
// Supports both authenticated owner dashboard sessions and scoped agent Bearer tokens (for Apple
// Shortcuts, browser extensions, and Loop Text quick-save calls).

import { DEFAULT_TIMEZONE } from '../owner-timezone.mjs';
import { readJsonBody, sendJson } from '../http/transport.mjs';
import { summarizeFile } from '../files.mjs';
import { summarizeTask } from '../tasks.mjs';

const MAX_FILE_UPLOAD_JSON_BYTES = 15 * 1024 * 1024; // allows 10 MB base64-encoded file payloads

export async function handleSavedAndToolsRoute(req, res, {
  pathname,
  url,
  savedStore = null,
  scheduleStore = null,
  fileStore = null,
  taskStore = null,
  notificationStore = null,
  ownerTimezone = null,
  searchIndex = null,
  outboundPolicy = null,
  fetchImpl = null,
  onSavedEnrich = null,
  onScheduleRun = null,
  deliverSms = null,
  broadcast = null,
  activity = null,
  agent = null, // non-null when authenticated via Bearer agent token (Shortcut / Extension)
} = {}) {
  const method = req.method;
  const callerProfile = agent ? (agent.profile || 'all') : (url.searchParams.get('profile') || 'all');
  const writerName = agent ? (agent.name || 'Agent') : 'Owner';
  const defaultSource = agent ? (agent.name || 'API') : 'Dashboard';

  /* ---------------- /api/saved ---------------- */
  if (pathname === '/api/saved') {
    if (!savedStore) return sendJson(res, 503, { error: 'Saved library is unavailable.' }), true;
    if (method === 'GET') {
      if (agent && agent.memoryAccess === 'none') {
        return sendJson(res, 403, { error: 'This key does not have permission to read Saved items.' }), true;
      }
      const query = url.searchParams.get('query') || url.searchParams.get('q') || '';
      const kind = url.searchParams.get('kind') || '';
      const tag = url.searchParams.get('tag') || '';
      const writtenBy = url.searchParams.get('writtenBy') || '';
      const includeArchived = url.searchParams.get('archived') === '1' || url.searchParams.get('archived') === 'true';
      const limit = Number(url.searchParams.get('limit') || 60);
      const offset = Number(url.searchParams.get('offset') || 0);
      const focusProject = !agent && callerProfile !== 'all' ? callerProfile : null;
      const filterProfile = agent ? callerProfile : 'all';

      let semanticScores = null;
      if (query && searchIndex && typeof searchIndex.scoreSavedSemantic === 'function') {
        const allItems = await savedStore.list({ profile: filterProfile, limit: 200 }).catch(() => null);
        if (allItems?.items?.length) {
          semanticScores = await searchIndex.scoreSavedSemantic(allItems.items, query).catch(() => null);
        }
      }
      const resList = await savedStore.list({
        profile: filterProfile,
        focusProject,
        query,
        kind,
        tag,
        writtenBy,
        includeArchived,
        semanticScores,
        limit,
        offset,
      });
      return sendJson(res, 200, { ok: true, ...resList }), true;
    }

    if (method === 'POST') {
      if (agent && agent.memoryAccess !== 'read_write') {
        return sendJson(res, 403, { error: 'This key does not have permission to save items.' }), true;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err?.publicMessage || 'Invalid JSON body.' }), true;
      }
      try {
        const result = await savedStore.save(body || {}, {
          profile: agent ? callerProfile : (body?.project || (Array.isArray(body?.projects) ? body.projects[0] : 'all') || 'all'),
          writtenBy: writerName,
          source: typeof body?.source === 'string' && body.source.trim() ? body.source.trim() : defaultSource,
          selfIdentity: outboundPolicy?.selfIdentity || null,
        });
        if (result.item) await searchIndex?.upsertSavedImmediate?.(result.item).catch(() => {});
        if (result.needsFetch) {
          if (body?.waitForFetch === true) {
            result.item = await savedStore.enrich(result.item.id, {
              selfIdentity: outboundPolicy?.selfIdentity || null,
              fetchImpl,
              html: typeof body?.html === 'string' ? body.html : null,
            });
            if (result.item) await searchIndex?.upsertSavedImmediate?.(result.item).catch(() => {});
          } else if (typeof body?.html === 'string' && body.html.trim()) {
            // Browser extension supplied rendered DOM HTML: extract immediately with zero network fetch.
            result.item = await savedStore.enrich(result.item.id, { html: body.html, contentType: 'text/html' });
            if (result.item) await searchIndex?.upsertSavedImmediate?.(result.item).catch(() => {});
          } else if (typeof onSavedEnrich === 'function') {
            onSavedEnrich(result.item.id);
          }
        }
        activity?.record?.({
          agentId: agent?.id || null,
          agentName: agent ? agent.name : 'Owner (dashboard)',
          method: 'saved/save',
          target: result.item.displayTitle || result.item.id,
          ok: true,
        });
        broadcast?.('saved');
        return sendJson(res, result.created ? 201 : 200, {
          ok: true,
          created: result.created,
          merged: result.merged,
          item: result.item,
        }), true;
      } catch (err) {
        return sendJson(res, err?.status || 400, { error: err?.message || 'Could not save item.', ...(err?.code ? { code: err.code } : {}) }), true;
      }
    }

    return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' }), true;
  }

  const savedRefreshMatch = pathname.match(/^\/api\/saved\/([^/]+)\/refresh$/);
  if (savedRefreshMatch) {
    if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }), true;
    if (!savedStore) return sendJson(res, 503, { error: 'Saved library is unavailable.' }), true;
    if (agent && agent.memoryAccess !== 'read_write') return sendJson(res, 403, { error: 'Write access required.' }), true;
    const id = decodeURIComponent(savedRefreshMatch[1]);
    const existing = await savedStore.get(id, { profile: agent ? callerProfile : 'all' });
    if (!existing) return sendJson(res, 404, { error: 'Saved item not found.' }), true;
    const item = await savedStore.enrich(existing.id, { selfIdentity: outboundPolicy?.selfIdentity || null, fetchImpl });
    if (item) await searchIndex?.upsertSavedImmediate?.(item).catch(() => {});
    broadcast?.('saved');
    return sendJson(res, 200, { ok: true, item }), true;
  }

  const savedIdMatch = pathname.match(/^\/api\/saved\/([^/]+)$/);
  if (savedIdMatch) {
    if (!savedStore) return sendJson(res, 503, { error: 'Saved library is unavailable.' }), true;
    const id = decodeURIComponent(savedIdMatch[1]);
    const reach = agent ? callerProfile : 'all';
    if (method === 'GET') {
      if (agent && agent.memoryAccess === 'none') return sendJson(res, 403, { error: 'Read access required.' }), true;
      const item = await savedStore.get(id, { profile: reach });
      if (!item) return sendJson(res, 404, { error: 'Saved item not found.' }), true;
      return sendJson(res, 200, { ok: true, item }), true;
    }
    if (method === 'PATCH') {
      if (agent && agent.memoryAccess !== 'read_write') return sendJson(res, 403, { error: 'Write access required.' }), true;
      const body = await readJsonBody(req);
      try {
        const resSave = await savedStore.save({ ...body, id }, {
          profile: reach,
          writtenBy: writerName,
          selfIdentity: outboundPolicy?.selfIdentity || null,
        });
        if (resSave.item) await searchIndex?.upsertSavedImmediate?.(resSave.item).catch(() => {});
        broadcast?.('saved');
        return sendJson(res, 200, { ok: true, item: resSave.item }), true;
      } catch (err) {
        return sendJson(res, err?.status || 400, { error: err?.message || 'Could not update saved item.' }), true;
      }
    }
    if (method === 'DELETE') {
      if (agent && agent.memoryAccess !== 'read_write') return sendJson(res, 403, { error: 'Write access required.' }), true;
      try {
        const del = await savedStore.delete(id, { profile: reach });
        await searchIndex?.removeItemImmediate?.('saved', del.id).catch(() => {});
        broadcast?.('saved');
        return sendJson(res, 200, { ok: true, ...del }), true;
      } catch (err) {
        return sendJson(res, err?.status || 404, { error: err?.message || 'Could not delete saved item.' }), true;
      }
    }
    return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, PATCH, DELETE' }), true;
  }

  /* ---------------- /api/schedules ---------------- */
  if (pathname === '/api/schedules') {
    if (!scheduleStore) return sendJson(res, 503, { error: 'Schedules are unavailable.' }), true;
    if (agent) return sendJson(res, 403, { error: 'Use MCP loop__search / loop__save for schedules.' }), true;
    if (method === 'GET') {
      const status = url.searchParams.get('status') || '';
      const query = url.searchParams.get('query') || '';
      const focusProject = !agent && callerProfile !== 'all' ? callerProfile : null;
      const resList = await scheduleStore.list({ status, query, focusProject });
      return sendJson(res, 200, { ok: true, ...resList }), true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const defaultTimezone = (await ownerTimezone?.get()) || DEFAULT_TIMEZONE;
      try {
        const { schedule, created } = await scheduleStore.save(body || {}, {
          writtenBy: 'Owner',
          defaultTimezone,
        });
        broadcast?.('schedules');
        return sendJson(res, created ? 201 : 200, { ok: true, created, schedule }), true;
      } catch (err) {
        return sendJson(res, err?.status || 400, { error: err?.message || 'Could not save schedule.' }), true;
      }
    }
    return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' }), true;
  }

  const schedRunsMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/runs$/);
  if (schedRunsMatch) {
    if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' }), true;
    if (!scheduleStore || agent) return sendJson(res, agent ? 403 : 503, { error: 'Unavailable.' }), true;
    const id = decodeURIComponent(schedRunsMatch[1]);
    const sched = await scheduleStore.get(id);
    if (!sched) return sendJson(res, 404, { error: 'Schedule not found.' }), true;
    const limit = Number(url.searchParams.get('limit')) || 50;
    const runs = await scheduleStore.listRuns(id, { limit });
    return sendJson(res, 200, { ok: true, scheduleId: id, runs }), true;
  }

  const schedRunMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/run$/);
  if (schedRunMatch) {
    if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }), true;
    if (!scheduleStore || agent) return sendJson(res, agent ? 403 : 503, { error: 'Unavailable.' }), true;
    const id = decodeURIComponent(schedRunMatch[1]);
    try {
      const run = typeof onScheduleRun === 'function'
        ? await onScheduleRun(id)
        : await scheduleStore.runNow(id);
      const runOk = run?.status !== 'error';
      activity?.record?.({
        agentId: null,
        agentName: 'Owner (dashboard)',
        method: 'schedule/run',
        target: `${run?.title || id} (${id})`,
        ok: runOk,
        ...(runOk ? {} : { error: run?.error || 'Schedule run failed.' }),
      });
      broadcast?.('schedules');
      return sendJson(res, runOk ? 200 : 409, {
        ok: runOk,
        ...(runOk ? {} : { error: run?.error || 'Schedule run failed.' }),
        run,
      }), true;
    } catch (err) {
      return sendJson(res, err?.status || 400, { error: err?.message || 'Could not run schedule.' }), true;
    }
  }

  const schedIdMatch = pathname.match(/^\/api\/schedules\/([^/]+)$/);
  if (schedIdMatch) {
    if (!scheduleStore || agent) return sendJson(res, agent ? 403 : 503, { error: 'Unavailable.' }), true;
    const id = decodeURIComponent(schedIdMatch[1]);
    if (method === 'GET') {
      const schedule = await scheduleStore.get(id);
      if (!schedule) return sendJson(res, 404, { error: 'Schedule not found.' }), true;
      return sendJson(res, 200, { ok: true, schedule }), true;
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      try {
        const { schedule } = await scheduleStore.save({ ...body, id }, { writtenBy: 'Owner' });
        broadcast?.('schedules');
        return sendJson(res, 200, { ok: true, schedule }), true;
      } catch (err) {
        return sendJson(res, err?.status || 400, { error: err?.message || 'Could not update schedule.' }), true;
      }
    }
    if (method === 'DELETE') {
      try {
        const del = await scheduleStore.delete(id);
        broadcast?.('schedules');
        return sendJson(res, 200, { ok: true, ...del }), true;
      } catch (err) {
        return sendJson(res, err?.status || 404, { error: err?.message || 'Could not delete schedule.' }), true;
      }
    }
    return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, PATCH, DELETE' }), true;
  }

  /* ---------------- /api/files ---------------- */
  if (pathname === '/api/files') {
    if (!fileStore) return sendJson(res, 503, { error: 'File drop is unavailable.' }), true;
    if (method === 'GET') {
      if (agent && agent.memoryAccess === 'none') return sendJson(res, 403, { error: 'Read access required.' }), true;
      const query = url.searchParams.get('query') || '';
      const focusProject = !agent && callerProfile !== 'all' ? callerProfile : null;
      const resList = await fileStore.list({ profile: agent ? callerProfile : 'all', focusProject, query });
      return sendJson(res, 200, { ok: true, total: resList.total, files: resList.files.map(summarizeFile) }), true;
    }
    if (method === 'POST') {
      if (agent && agent.memoryAccess !== 'read_write') return sendJson(res, 403, { error: 'Write access required.' }), true;
      let body;
      try {
        body = await readJsonBody(req, { maxBytes: MAX_FILE_UPLOAD_JSON_BYTES });
      } catch (err) {
        return sendJson(res, err?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err?.publicMessage || 'Invalid upload payload.' }), true;
      }
      try {
        const saved = await fileStore.save(body || {}, {
          profile: agent ? callerProfile : (body?.project || 'all'),
          writtenBy: writerName,
          source: defaultSource,
        });
        broadcast?.('files');
        return sendJson(res, saved.created ? 201 : 200, { ok: true, ...saved, file: summarizeFile(saved.file) }), true;
      } catch (err) {
        return sendJson(res, err?.status || 400, { error: err?.message || 'Could not save file.' }), true;
      }
    }
    return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' }), true;
  }

  const fileContentMatch = pathname.match(/^\/api\/files\/([^/]+)\/content$/);
  if (fileContentMatch) {
    if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' }), true;
    if (!fileStore) return sendJson(res, 503, { error: 'File drop is unavailable.' }), true;
    if (agent && agent.memoryAccess === 'none') return sendJson(res, 403, { error: 'Read access required.' }), true;
    const id = decodeURIComponent(fileContentMatch[1]);
    const rec = await fileStore.readBytes(id, { profile: agent ? callerProfile : 'all' }).catch(() => null);
    if (!rec) return sendJson(res, 404, { error: 'File not found.' }), true;
    const safeName = rec.file.name.replace(/["\\\r\n]/g, '_');
    res.writeHead(200, {
      'Content-Type': rec.file.mimeType || 'application/octet-stream',
      'Content-Length': rec.buffer.byteLength,
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(rec.buffer);
    return true;
  }

  const fileIdMatch = pathname.match(/^\/api\/files\/([^/]+)$/);
  if (fileIdMatch) {
    if (!fileStore) return sendJson(res, 503, { error: 'File drop is unavailable.' }), true;
    const id = decodeURIComponent(fileIdMatch[1]);
    const reach = agent ? callerProfile : 'all';
    if (method === 'GET') {
      if (agent && agent.memoryAccess === 'none') return sendJson(res, 403, { error: 'Read access required.' }), true;
      const file = await fileStore.get(id, { profile: reach });
      if (!file) return sendJson(res, 404, { error: 'File not found.' }), true;
      return sendJson(res, 200, { ok: true, file }), true;
    }
    if (method === 'DELETE') {
      if (agent && agent.memoryAccess !== 'read_write') return sendJson(res, 403, { error: 'Write access required.' }), true;
      try {
        const del = await fileStore.delete(id, { profile: reach });
        broadcast?.('files');
        return sendJson(res, 200, { ok: true, ...del }), true;
      } catch (err) {
        return sendJson(res, err?.status || 404, { error: err?.message || 'Could not delete file.' }), true;
      }
    }
    return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, DELETE' }), true;
  }

  /* ---------------- /api/tasks ---------------- */
  if (pathname === '/api/tasks') {
    if (!taskStore) return sendJson(res, 503, { error: 'Tasks are unavailable.' }), true;
    if (method === 'GET') {
      if (agent && agent.memoryAccess === 'none') return sendJson(res, 403, { error: 'Read access required.' }), true;
      const query = url.searchParams.get('query') || '';
      const status = url.searchParams.get('status') || '';
      const assignedTo = url.searchParams.get('assignedTo') || null;
      const limit = Number(url.searchParams.get('limit') || 100);
      const offset = Number(url.searchParams.get('offset') || 0);
      const focusProject = !agent && callerProfile !== 'all' ? callerProfile : null;
      const resList = await taskStore.list({
        profile: agent ? callerProfile : 'all',
        focusProject,
        query,
        status,
        assignedTo,
        limit,
        offset,
      });
      return sendJson(res, 200, { ok: true, total: resList.total, tasks: resList.tasks.map(summarizeTask) }), true;
    }
    if (method === 'POST') {
      if (agent && agent.memoryAccess !== 'read_write') return sendJson(res, 403, { error: 'Write access required.' }), true;
      const body = await readJsonBody(req);
      try {
        const saved = await taskStore.save(
          { expectedRevision: 0, ...(body || {}) },
          { profile: agent ? callerProfile : (body?.project || 'all'), writtenBy: writerName },
        );
        broadcast?.('tasks');
        return sendJson(res, saved.created ? 201 : 200, { ok: true, ...saved }), true;
      } catch (err) {
        return sendJson(res, err?.code === 'TASK_CAPACITY' ? 409 : 400, { error: err?.message || 'Could not save task.', ...(err?.code ? { code: err.code } : {}) }), true;
      }
    }
    return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' }), true;
  }

  const taskIdMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskIdMatch) {
    if (!taskStore) return sendJson(res, 503, { error: 'Tasks are unavailable.' }), true;
    const id = decodeURIComponent(taskIdMatch[1]);
    const reach = agent ? callerProfile : 'all';
    if (method === 'GET') {
      if (agent && agent.memoryAccess === 'none') return sendJson(res, 403, { error: 'Read access required.' }), true;
      const task = await taskStore.get(id, { profile: reach });
      if (!task) return sendJson(res, 404, { error: 'Task not found.' }), true;
      return sendJson(res, 200, { ok: true, task }), true;
    }
    if (method === 'PATCH') {
      if (agent && agent.memoryAccess !== 'read_write') return sendJson(res, 403, { error: 'Write access required.' }), true;
      const existing = await taskStore.get(id, { profile: reach });
      if (!existing) return sendJson(res, 404, { error: 'Task not found.' }), true;
      const body = await readJsonBody(req);
      try {
        const saved = await taskStore.save(
          { ...(body || {}), id, expectedRevision: body?.expectedRevision ?? existing.revision },
          { profile: reach, writtenBy: writerName },
        );
        broadcast?.('tasks');
        return sendJson(res, 200, { ok: true, ...saved }), true;
      } catch (err) {
        return sendJson(res, err?.code === 'TASK_CONFLICT' ? 409 : 400, { error: err?.message || 'Could not update task.' }), true;
      }
    }
    if (method === 'DELETE') {
      if (agent && agent.memoryAccess !== 'read_write') return sendJson(res, 403, { error: 'Write access required.' }), true;
      try {
        const del = await taskStore.forget(id, { profile: reach });
        broadcast?.('tasks');
        return sendJson(res, 200, { ok: true, ...del }), true;
      } catch (err) {
        return sendJson(res, 404, { error: err?.message || 'Could not delete task.' }), true;
      }
    }
    return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, PATCH, DELETE' }), true;
  }

  /* ---------------- /api/notifications ---------------- */
  if (pathname === '/api/notifications') {
    if (!notificationStore || agent) return sendJson(res, agent ? 403 : 503, { error: 'Unavailable.' }), true;
    if (method === 'GET') {
      const unreadOnly = url.searchParams.get('unread') === '1';
      const limit = Number(url.searchParams.get('limit') || 20);
      return sendJson(res, 200, { ok: true, ...(await notificationStore.list({ unreadOnly, limit })) }), true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (body?.action === 'read_all') {
        const resRead = await notificationStore.markRead('', { all: true });
        broadcast?.('notifications');
        return sendJson(res, 200, resRead), true;
      }
      try {
        const sent = await notificationStore.send(body || {}, {
          agentId: 'owner',
          agentName: 'Owner',
          deliverSms,
        });
        broadcast?.('notifications');
        return sendJson(res, 201, { ok: true, ...sent }), true;
      } catch (err) {
        return sendJson(res, err?.status || 400, { error: err?.message || 'Could not send notification.' }), true;
      }
    }
    return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' }), true;
  }

  const notifReadMatch = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (notifReadMatch) {
    if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }), true;
    if (!notificationStore || agent) return sendJson(res, agent ? 403 : 503, { error: 'Unavailable.' }), true;
    const id = decodeURIComponent(notifReadMatch[1]);
    const resRead = await notificationStore.markRead(id);
    broadcast?.('notifications');
    return sendJson(res, 200, resRead), true;
  }

  return false;
}
