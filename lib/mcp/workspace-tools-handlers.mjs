// MCP handlers for Loop's built-in Saved library (links, notes, json-render cards/artifacts),
// Schedules (one-time reminders & repeat jobs), and Shared Files drop.

import { DEFAULT_TIMEZONE } from '../owner-timezone.mjs';
import { createHash } from 'node:crypto';
import { SAVED_DATA_WARNING, summarizeSavedItem } from '../saved.mjs';
import { FILES_DATA_WARNING, summarizeFile } from '../files.mjs';
import { normalizeProfileTag, projectNames } from '../profiles.mjs';
import { linkedBrief, linkSaved } from '../library.mjs';

function scopeProfile(access) {
  return access.ownerProjectFocus ? 'all' : (access.profile || 'all');
}

function focusProjectOf(access) {
  return access.ownerProjectFocus ? access.profile : (access.profile !== 'all' ? access.profile : null);
}

function hashText(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

async function gateWorkspaceAction({
  type,
  action,
  target,
  title,
  detail,
  fpArgs,
  policyStore,
  approvalQueue,
  approvalId,
  waitMs,
  waitForApproval,
  enforceApproval,
  approvalFingerprint,
  stricterRule,
  ownActionRule,
  ownFresh = false,
  access,
  record,
  signal,
}) {
  if (!policyStore || !approvalQueue || typeof enforceApproval !== 'function' || typeof approvalFingerprint !== 'function') {
    return null;
  }
  const combine = typeof stricterRule === 'function' ? stricterRule : (a, b) => a || b || null;
  let evalRes = await policyStore.evaluateAction({ action: type });
  if (typeof ownActionRule === 'function' && typeof policyStore.get === 'function') {
    const policies = await policyStore.get();
    const globalSaveRule = ownActionRule(policies, 'save');
    if (globalSaveRule) evalRes = combine(evalRes, globalSaveRule);
  }
  // A caller that takes back its own fresh save destroys nothing that was there before it, so the
  // delete rule does not apply. The rules for this type and for saves still do.
  if (action === 'delete' && !ownFresh) {
    const deleteRule = await policyStore.evaluateAction({ action: 'delete' });
    evalRes = combine(evalRes, deleteRule);
  }
  if (!evalRes || evalRes.decision !== 'always_ask') return null;

  return enforceApproval({
    approvalQueue,
    evalRes,
    kind: 'save',
    target,
    title,
    detail: { ...detail, rule: evalRes.source },
    fingerprint: approvalFingerprint({ kind: 'save', target, args: fpArgs }),
    approvalId,
    waitMs,
    waitForApproval,
    signal,
    callToolName: 'loop__save',
    access,
    record,
  });
}

export async function handleWorkspaceSearch({
  rawType,
  args,
  access,
  rawQuery,
  searchOffset,
  savedStore,
  scheduleStore,
  fileStore,
  searchIndex,
  record = null,
  signal,
  textResult,
  searchResult,
}) {
  const reach = scopeProfile(access);
  const focus = focusProjectOf(access);

  if (rawType === 'saved') {
    if (access.memoryAccess === 'none') {
      record?.({ method: 'saved/read-denied', target: rawQuery || 'saved', ok: false, error: 'memory_access_denied' });
      return textResult('This agent does not have permission to read Loop Saved items.', true);
    }
    if (!savedStore) return textResult('Saved library is not configured.', true);
    const wanted = args?.project !== undefined ? normalizeProfileTag(args.project) : reach;
    if (!wanted || (reach !== 'all' && wanted !== reach)) {
      return textResult('Cannot search Saved items of another project from a fixed-scope session.', true);
    }
    let semanticScores = null;
    if (rawQuery && searchIndex && typeof searchIndex.scoreSavedSemantic === 'function') {
      const allForVec = await savedStore.list({ profile: wanted, limit: 200 }).catch(() => null);
      if (allForVec?.items?.length) {
        semanticScores = await searchIndex.scoreSavedSemantic(allForVec.items, rawQuery, { signal }).catch(() => null);
      }
    }
    const { total, items, fts5 } = await savedStore.list({
      profile: wanted,
      focusProject: args?.project === undefined ? focus : null,
      query: rawQuery,
      kind: typeof args?.kind === 'string' ? args.kind : '',
      tag: typeof args?.tag === 'string' ? args.tag : '',
      semanticScores,
      limit: args?.limit,
      offset: searchOffset,
    });
    const shown = searchOffset + items.length;
    return searchResult({
      type: 'saved',
      total,
      returned: items.length,
      fts5,
      ...(total > shown && items.length > 0 ? { truncated: true, nextOffset: shown } : {}),
      dataOnlyWarning: SAVED_DATA_WARNING,
      hint: 'Short rows. Use loop__inspect({ type: "saved", id }) for full Markdown or json-render card specs.',
      items: items.map(summarizeSavedItem),
    });
  }

  if (rawType === 'schedules') {
    if (access.memoryAccess === 'none') {
      record?.({ method: 'schedule/read-denied', target: rawQuery || 'schedules', ok: false, error: 'memory_access_denied' });
      return textResult('This agent does not have permission to read Loop schedules.', true);
    }
    if (!scheduleStore) return textResult('Schedules are not configured.', true);
    const { total, schedules } = await scheduleStore.list({
      profile: reach,
      status: typeof args?.status === 'string' ? args.status : '',
      query: rawQuery,
      limit: args?.limit,
      offset: searchOffset,
    });
    return searchResult({
      type: 'schedules',
      total,
      returned: schedules.length,
      schedules: schedules.map(projectNames),
    });
  }

  if (rawType === 'files') {
    if (access.memoryAccess === 'none') {
      record?.({ method: 'file/read-denied', target: rawQuery || 'files', ok: false, error: 'memory_access_denied' });
      return textResult('This agent does not have permission to read Loop files.', true);
    }
    if (!fileStore) return textResult('Files drop is not configured.', true);
    const { total, files } = await fileStore.list({
      profile: reach,
      query: rawQuery,
      limit: args?.limit,
      offset: searchOffset,
    });
    return searchResult({
      type: 'files',
      total,
      returned: files.length,
      dataOnlyWarning: FILES_DATA_WARNING,
      hint: 'Use loop__inspect({ type: "file", id }) to read extracted text from a dropped file.',
      files: files.map(summarizeFile),
    });
  }

  return null;
}

export async function handleWorkspaceInspect({
  type,
  itemId,
  access,
  savedStore,
  scheduleStore,
  fileStore,
  library = null,
  record = null,
}) {
  const reach = scopeProfile(access);

  if (type === 'saved') {
    if (access.memoryAccess === 'none') {
      record?.({ method: 'saved/read-denied', target: itemId || 'saved', ok: false, error: 'memory_access_denied' });
      return { ok: false, error: 'This agent does not have permission to read Loop Saved items.' };
    }
    if (!savedStore) return { ok: false, error: 'Saved library is not configured.' };
    let item = await savedStore.get(itemId, { profile: reach });
    if (!item) item = await savedStore.findByUrl(itemId, { profile: reach });
    if (!item) return { ok: false, error: `Saved item "${itemId}" not found.` };
    const linked = await linkedBrief(library, item.id, { profile: reach });
    return {
      ok: true,
      data: {
        dataOnlyWarning: SAVED_DATA_WARNING,
        item: projectNames(item),
        ...(linked ? { linked } : {}),
      },
    };
  }

  if (type === 'schedule') {
    if (access.memoryAccess === 'none') {
      record?.({ method: 'schedule/read-denied', target: itemId || 'schedule', ok: false, error: 'memory_access_denied' });
      return { ok: false, error: 'This agent does not have permission to read Loop schedules.' };
    }
    if (!scheduleStore) return { ok: false, error: 'Schedules are not configured.' };
    const schedule = await scheduleStore.get(itemId, { profile: reach });
    if (!schedule) return { ok: false, error: `Schedule "${itemId}" not found.` };
    return { ok: true, data: { schedule: projectNames(schedule) } };
  }

  if (type === 'file') {
    if (access.memoryAccess === 'none') {
      record?.({ method: 'file/read-denied', target: itemId || 'file', ok: false, error: 'memory_access_denied' });
      return { ok: false, error: 'This agent does not have permission to read Loop files.' };
    }
    if (!fileStore) return { ok: false, error: 'Files drop is not configured.' };
    const file = await fileStore.get(itemId, { profile: reach });
    if (!file) return { ok: false, error: `File "${itemId}" not found.` };
    const linked = await linkedBrief(library, file.id, { profile: reach });
    return {
      ok: true,
      data: {
        dataOnlyWarning: FILES_DATA_WARNING,
        file: projectNames(file),
        ...(linked ? { linked } : {}),
      },
    };
  }

  return null;
}

async function deleteValidatedBatch({
  type,
  labelSingular,
  labelPlural,
  targets,
  getItem,
  getTitle,
  removeItem,
  afterRemove = null,
  gate,
  record,
  broadcastEvent,
  broadcast,
  textResult,
  caller = null,
  ownSaves = null,
}) {
  const uniqueTargets = [...new Set(targets.map((t) => String(t || '').trim()).filter(Boolean))];
  if (uniqueTargets.length === 0) {
    return textResult(`id or ids is required to delete ${labelPlural}.`, true);
  }

  // Validate every target before asking the owner for approval so a stale ID never causes partial deletion.
  const preResolved = [];
  const preMissing = [];
  let ownFresh = Boolean(ownSaves);
  for (const tid of uniqueTargets) {
    const item = await getItem(tid);
    if (!item) preMissing.push(tid);
    else {
      preResolved.push({ id: item.id, title: String(getTitle(item) || item.id).trim().slice(0, 80) });
      if (ownFresh && !ownSaves.canTakeBack(caller, type, item)) ownFresh = false;
    }
  }
  if (preMissing.length > 0) {
    const msg = preMissing.length === 1
      ? `${labelSingular} "${preMissing[0]}" not found. Nothing was deleted.`
      : `${labelPlural} not found (${preMissing.join(', ')}). Nothing was deleted.`;
    record({ method: `${type}/delete`, target: preMissing.join(', '), ok: false, error: 'not_found' });
    return textResult({ deleted: false, deletedIds: [], missingIds: preMissing, error: msg }, true);
  }

  const sortedIds = [...uniqueTargets].sort();
  const previewTitles = preResolved.slice(0, 3).map((x) => `"${x.title}"`).join(', ')
    + (preResolved.length > 3 ? ` and ${preResolved.length - 3} more` : '');
  const blocked = await gate({
    type,
    action: 'delete',
    target: sortedIds.length === 1 ? `${type}:delete:${sortedIds[0]}` : `${type}:delete:batch`,
    title: preResolved.length === 1
      ? `Delete ${labelSingular.toLowerCase()} "${preResolved[0].title}"`
      : `Delete ${preResolved.length} ${labelPlural.toLowerCase()}: ${previewTitles}`,
    detail: {
      type,
      action: 'delete',
      ids: sortedIds,
      items: preResolved,
    },
    fpArgs: { type, action: 'delete', ids: sortedIds },
    ownFresh,
  });
  if (blocked) return blocked;

  // Re-validate every target right after approval so nothing is partially deleted if an item went stale.
  const resolved = [];
  const missingAfterApproval = [];
  for (const tid of uniqueTargets) {
    const item = await getItem(tid);
    if (!item) missingAfterApproval.push(tid);
    else resolved.push({ id: item.id, title: String(getTitle(item) || item.id).trim().slice(0, 80) });
  }
  if (missingAfterApproval.length > 0) {
    const msg = missingAfterApproval.length === 1
      ? `${labelSingular} "${missingAfterApproval[0]}" not found after approval. Nothing was deleted.`
      : `${labelPlural} not found after approval (${missingAfterApproval.join(', ')}). Nothing was deleted.`;
    record({ method: `${type}/delete`, target: missingAfterApproval.join(', '), ok: false, error: 'not_found_after_approval' });
    return textResult({ deleted: false, deletedIds: [], missingIds: missingAfterApproval, error: msg }, true);
  }

  const deleted = [];
  const failed = [];
  for (const item of resolved) {
    try {
      const res = await removeItem(item.id);
      ownSaves?.removed(caller, type, res.id);
      if (typeof afterRemove === 'function') await afterRemove(res.id);
      deleted.push({ id: res.id, title: item.title });
    } catch (err) {
      failed.push({ id: item.id, title: item.title, error: err?.message || 'Delete failed.' });
    }
  }

  const targetSummary = deleted.map((d) => `${d.title} (${d.id})`).join(', ')
    || failed.map((f) => `${f.title} (${f.id})`).join(', ');
  if (deleted.length > 0) broadcast?.(broadcastEvent);
  if (failed.length > 0) {
    const errText = failed.map((f) => `${f.id}: ${f.error}`).join('; ');
    record({ method: `${type}/delete`, target: targetSummary, ok: false, error: errText });
    return textResult(
      {
        deleted: false,
        partial: deleted.length > 0,
        ids: deleted.map((d) => d.id),
        deletedItems: deleted,
        failed,
        error: errText,
      },
      true,
    );
  }

  record({ method: `${type}/delete`, target: targetSummary, ok: true });
  return textResult({ deleted: true, ids: deleted.map((d) => d.id), items: deleted });
}

export async function handleWorkspaceSave({
  type,
  action,
  id,
  ids,
  data,
  access,
  savedStore,
  scheduleStore,
  fileStore,
  ownerTimezone,
  policyStore = null,
  approvalQueue = null,
  approvalId = '',
  waitMs = 0,
  waitForApproval = false,
  enforceApproval = null,
  approvalFingerprint = null,
  stricterRule = null,
  ownActionRule = null,
  searchIndex,
  outboundPolicy,
  onSavedEnrich,
  onScheduleRun,
  broadcast,
  record,
  signal,
  textResult,
  caller = null,
  ownSaves = null,
  library = null,
}) {
  const reach = scopeProfile(access);
  const writer = access.agent?.name || 'Agent';
  const gate = (opts) =>
    gateWorkspaceAction({
      ...opts,
      policyStore,
      approvalQueue,
      approvalId,
      waitMs,
      waitForApproval,
      enforceApproval,
      approvalFingerprint,
      stricterRule,
      ownActionRule,
      access,
      record,
      signal,
    });

  if (type === 'saved') {
    if (access.memoryAccess !== 'read_write') {
      return textResult('This agent does not have write access to save or edit Saved items.', true);
    }
    if (!savedStore) return textResult('Saved library is not configured.', true);
    try {
      if (action === 'delete') {
        const targets = Array.isArray(ids) && ids.length > 0 ? ids : [id || data?.id].filter(Boolean);
        return await deleteValidatedBatch({
          type: 'saved',
          labelSingular: 'Saved item',
          labelPlural: 'Saved items',
          targets,
          getItem: (tid) => savedStore.get(tid, { profile: reach }),
          getTitle: (item) => item.displayTitle || item.title || item.url || item.id,
          removeItem: (tid) => savedStore.delete(tid, { profile: reach }),
          afterRemove: (removedId) => searchIndex?.removeItemImmediate?.('saved', removedId).catch(() => {}),
          gate,
          record,
          broadcastEvent: 'saved',
          broadcast,
          textResult,
          caller,
          ownSaves,
        });
      }

      if (action === 'refresh' || (action === 'save' && data?.refresh === true && (id || data?.id))) {
        const targetId = id || data?.id;
        if (!targetId) return textResult('id is required to refresh a Saved item.', true);
        const existing = await savedStore.get(targetId, { profile: reach });
        if (!existing) return textResult(`Saved item "${targetId}" not found.`, true);
        const blocked = await gate({
          type: 'saved',
          action: 'refresh',
          target: `saved:refresh:${existing.id}`,
          title: `Refresh Saved item "${String(existing.displayTitle || existing.id).slice(0, 80)}"`,
          detail: { type: 'saved', action: 'refresh', id: existing.id, ...(existing.url ? { url: existing.url } : {}) },
          fpArgs: { type: 'saved', action: 'refresh', id: existing.id },
        });
        if (blocked) return blocked;
        const enriched = await savedStore.enrich(existing.id, {
          selfIdentity: outboundPolicy?.selfIdentity || null,
          signal,
        });
        if (enriched) await searchIndex?.upsertSavedImmediate?.(enriched, { signal }).catch(() => {});
        record({ method: 'saved/refresh', target: `${existing.displayTitle || existing.id} (${existing.id})`, ok: true });
        broadcast?.('saved');
        return textResult({ ok: true, item: projectNames(enriched) });
      }

      if (action !== 'save') {
        return textResult('type "saved" supports action "save", "refresh", or "delete".', true);
      }

      const label = String(data?.title || data?.url || data?.note || data?.text || id || 'item').trim().slice(0, 80);
      const blocked = await gate({
        type: 'saved',
        action: 'save',
        target: id ? `saved:save:${id}` : 'saved:save',
        title: `Save to Loop: ${label}`,
        detail: {
          type: 'saved',
          action: 'save',
          ...(id ? { id } : {}),
          ...(data?.url ? { url: String(data.url).slice(0, 400) } : {}),
          ...(data?.title ? { title: String(data.title).slice(0, 200) } : {}),
          ...(data?.note ? { note: String(data.note).slice(0, 300) } : {}),
          ...(data?.text ? { text: String(data.text).slice(0, 300) } : {}),
          ...(Array.isArray(data?.tags) && data.tags.length ? { tags: data.tags.slice(0, 12) } : {}),
          ...(data?.ui ? { hasCard: true } : {}),
        },
        fpArgs: {
          type: 'saved',
          action: 'save',
          id: id || null,
          dataHash: hashText(JSON.stringify(data || {})),
        },
      });
      if (blocked) return blocked;

      const previousSaved = ownSaves && (id || data?.id) ? await savedStore.get(id || data.id, { profile: reach }) : null;
      const res = await savedStore.save(
        { ...data, ...(id ? { id } : {}) },
        {
          profile: access.profile || 'all',
          writtenBy: writer,
          source: access.agent?.kind === 'imessage' ? 'Loop Text' : writer,
          selfIdentity: outboundPolicy?.selfIdentity || null,
        },
      );
      if (res.item) await searchIndex?.upsertSavedImmediate?.(res.item, { signal }).catch(() => {});
      // A save that Loop merged into an item that was there is not the caller's own to take back.
      if (res.item) ownSaves?.saved(caller, 'saved', res.item, { created: res.created === true && !res.merged, previous: previousSaved });
      if (res.needsFetch && typeof onSavedEnrich === 'function') {
        onSavedEnrich(res.item.id);
      }
      record({ method: 'saved/save', target: `${res.item.displayTitle || res.item.id} (${res.item.id})`, ok: true });
      // A note is a page of the Library: its links say which sources and facts it was made from.
      const links = await linkSaved(library, res.item.id, data?.links, { profile: reach, writtenBy: writer });
      broadcast?.('saved');
      return textResult({
        saved: true,
        created: res.created,
        merged: res.merged,
        fetchingMetadata: Boolean(res.needsFetch),
        item: summarizeSavedItem(res.item),
        ...links,
      });
    } catch (err) {
      return textResult(err?.message || 'Could not save item.', true);
    }
  }

  if (type === 'schedule') {
    if (access.memoryAccess !== 'read_write') {
      return textResult('This agent does not have write access to manage schedules.', true);
    }
    if (!scheduleStore) return textResult('Schedules are not configured.', true);
    try {
      if (action === 'delete') {
        const targets = Array.isArray(ids) && ids.length > 0 ? ids : [id || data?.id].filter(Boolean);
        return await deleteValidatedBatch({
          type: 'schedule',
          labelSingular: 'Schedule',
          labelPlural: 'Schedules',
          targets,
          getItem: (tid) => scheduleStore.get(tid, { profile: reach }),
          getTitle: (sched) => sched.title || sched.id,
          removeItem: (tid) => scheduleStore.delete(tid, { profile: reach }),
          gate,
          record,
          broadcastEvent: 'schedules',
          broadcast,
          textResult,
          caller,
          ownSaves,
        });
      }
      if (action === 'run' || data?.runNow === true) {
        const targetId = id || data?.id;
        if (!targetId) return textResult('id is required to run a schedule now.', true);
        const existingSched = await scheduleStore.get(targetId, { profile: reach });
        if (!existingSched) return textResult(`Schedule "${targetId}" not found.`, true);
        const blocked = await gate({
          type: 'schedule',
          action: 'run',
          target: `schedule:run:${existingSched.id}`,
          title: `Run schedule "${String(existingSched.title || existingSched.id).slice(0, 80)}" now`,
          detail: { type: 'schedule', action: 'run', id: existingSched.id, title: existingSched.title },
          fpArgs: { type: 'schedule', action: 'run', id: existingSched.id },
        });
        if (blocked) return blocked;
        const runRes = typeof onScheduleRun === 'function'
          ? await onScheduleRun(existingSched.id, { profile: reach })
          : await scheduleStore.runNow(existingSched.id, { profile: reach });
        const runOk = runRes?.status !== 'error';
        record({
          method: 'schedule/run',
          target: `${runRes?.title || existingSched.title || existingSched.id} (${existingSched.id})`,
          ok: runOk,
          ...(runOk ? {} : { error: runRes?.error || 'Schedule execution failed.' }),
        });
        broadcast?.('schedules');
        return textResult(
          {
            ok: runOk,
            ...(runOk ? {} : { error: runRes?.error || 'Schedule execution failed.' }),
            run: runRes,
          },
          !runOk,
        );
      }
      if (action !== 'save') {
        return textResult('type "schedule" supports action "save", "run", or "delete".', true);
      }
      const schedTitle = String(data?.title || id || 'Schedule').trim().slice(0, 80);
      const blocked = await gate({
        type: 'schedule',
        action: 'save',
        target: id ? `schedule:save:${id}` : 'schedule:save',
        title: `Save schedule: ${schedTitle}`,
        detail: {
          type: 'schedule',
          action: 'save',
          ...(id ? { id } : {}),
          ...(data?.title ? { title: String(data.title).slice(0, 200) } : {}),
          ...(data?.kind ? { kind: String(data.kind) } : {}),
          ...(data?.action ? { scheduleAction: String(data.action) } : {}),
          ...(data?.message ? { message: String(data.message).slice(0, 300) } : {}),
        },
        fpArgs: {
          type: 'schedule',
          action: 'save',
          id: id || null,
          dataHash: hashText(JSON.stringify(data || {})),
        },
      });
      if (blocked) return blocked;
      const defaultTimezone = (await ownerTimezone?.get()) || DEFAULT_TIMEZONE;
      const previousSchedule = ownSaves && id ? await scheduleStore.get(id, { profile: reach }) : null;
      const { schedule, created } = await scheduleStore.save(
        { ...data, ...(id ? { id } : {}) },
        { profile: access.profile || 'all', writtenBy: writer, defaultTimezone },
      );
      ownSaves?.saved(caller, 'schedule', schedule, { created, previous: previousSchedule });
      record({ method: 'schedule/save', target: `${schedule.title} (${schedule.id})`, ok: true });
      broadcast?.('schedules');
      return textResult({ saved: true, created, schedule: projectNames(schedule) });
    } catch (err) {
      return textResult(err?.message || 'Could not save schedule.', true);
    }
  }

  if (type === 'file') {
    if (access.memoryAccess !== 'read_write') {
      return textResult('This agent does not have write access to save or delete files.', true);
    }
    if (!fileStore) return textResult('Files drop is not configured.', true);
    try {
      if (action === 'delete') {
        const targets = Array.isArray(ids) && ids.length > 0 ? ids : [id || data?.id].filter(Boolean);
        return await deleteValidatedBatch({
          type: 'file',
          labelSingular: 'File',
          labelPlural: 'Files',
          targets,
          getItem: (tid) => fileStore.get(tid, { profile: reach }),
          getTitle: (file) => file.name || file.id,
          removeItem: (tid) => fileStore.delete(tid, { profile: reach }),
          gate,
          record,
          broadcastEvent: 'files',
          broadcast,
          textResult,
          caller,
          ownSaves,
        });
      }
      if (action !== 'save') {
        return textResult('type "file" supports action "save" or "delete".', true);
      }
      const fileName = String(data?.name || 'file').trim().slice(0, 120);
      const contentSha = hashText(data?.contentBase64 || data?.content || data?.text || '');
      const blocked = await gate({
        type: 'file',
        action: 'save',
        target: 'file:save',
        title: `Save file: ${fileName}`,
        detail: {
          type: 'file',
          action: 'save',
          name: fileName,
          ...(data?.mimeType ? { mimeType: String(data.mimeType).slice(0, 100) } : {}),
          ...(data?.note ? { note: String(data.note).slice(0, 300) } : {}),
        },
        fpArgs: {
          type: 'file',
          action: 'save',
          name: fileName,
          mimeType: String(data?.mimeType || ''),
          note: String(data?.note || ''),
          contentSha,
        },
      });
      if (blocked) return blocked;
      const res = await fileStore.save(data, {
        profile: access.profile || 'all',
        writtenBy: writer,
        source: writer,
      });
      // The same content saved again is the file that was there, so it is not a new save of the caller.
      ownSaves?.saved(caller, 'file', res.file, { created: res.created === true });
      record({ method: 'file/save', target: `${res.file.name} (${res.file.id})`, ok: true });
      const links = await linkSaved(library, res.file.id, data?.links, { profile: reach, writtenBy: writer });
      broadcast?.('files');
      return textResult({
        saved: true,
        created: res.created,
        deduplicated: res.deduplicated,
        file: summarizeFile(res.file),
        ...links,
      });
    } catch (err) {
      return textResult(err?.message || 'Could not save file.', true);
    }
  }

  return null;
}
