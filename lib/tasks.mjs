// Loop ongoing tasks — small shared notes about unfinished work that any agent can pick up later,
// even after a conversation reset. Optimistic concurrency (expectedRevision), idempotent retries
// (operationId), per-profile isolation, a secret guard, and tombstones so a forgotten task stays gone.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { atomicWriteFile, readJsonWithBackup } from './json-file-store.mjs';
import { looksLikeSecret } from './memory.mjs';
import { defaultDataDir } from './vault.mjs';

export const TASK_STATUSES = Object.freeze(['active', 'waiting', 'completed', 'cancelled']);
export const MAX_TASKS_PER_PROFILE = 100;
export const MAX_TASK_SOURCES = 8;
export const TASK_PAGE_SIZE = 20;

const LIMITS = Object.freeze({ title: 100, objective: 500, notes: 3000, nextStep: 300, assignedTo: 80, result: 1500 });
const SOURCE_LIMITS = Object.freeze({ reference: 300, observation: 500 });
const TASK_ID_RE = /^task_[a-z0-9_-]{1,64}$/i;
const OPERATION_ID_MAX = 100;

const ASSIGNEE_ALIASES = new Map([
  ['claude', 'claude-code'],
  ['claudecode', 'claude-code'],
  ['claude code', 'claude-code'],
  ['claude-code', 'claude-code'],
  ['cursor', 'cursor'],
  ['codex', 'codex'],
  ['openai codex', 'codex'],
  ['gemini', 'gemini'],
  ['gemini cli', 'gemini'],
  ['gemini-cli', 'gemini'],
  ['antigravity', 'antigravity'],
  ['agy', 'antigravity'],
  ['imessage', 'imessage'],
  ['loop text', 'imessage'],
  ['loop text (imessage)', 'imessage'],
  ['loop-text', 'imessage'],
  ['sms', 'imessage'],
]);

function normalizeAssigneeToken(raw) {
  const clean = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!clean) return '';
  return ASSIGNEE_ALIASES.get(clean) || clean;
}

/**
 * Check whether a task's `assignedTo` matches a candidate agent string or identity object
 * ({ id, name, kind, clientName }). Handles common aliases like "claude" <-> "Claude Code".
 */
export function agentMatchesAssignee(assignedTo, target) {
  const a = normalizeAssigneeToken(assignedTo);
  if (!a) return false;
  const candidates = [];
  if (typeof target === 'string') {
    candidates.push(target);
  } else if (target && typeof target === 'object') {
    for (const v of [target.id, target.name, target.kind, target.clientName]) {
      if (typeof v === 'string' && v.trim()) candidates.push(v);
    }
  }
  for (const raw of candidates) {
    const c = normalizeAssigneeToken(raw);
    if (!c) continue;
    if (c === a) return true;
    if (c.length >= 3 && a.length >= 3 && (c.includes(a) || a.includes(c))) return true;
  }
  return false;
}

export const TASK_CONFLICT_MESSAGE = 'This task changed since you read it. Read it again and merge your update.';
export const TASK_SECRET_MESSAGE =
  'This looks like a secret or credential. Never put secrets in a task; store them in Loop Vault and refer to them as {{vault:KEY}}.';

function taskError(message, code) {
  return Object.assign(new Error(message), { code });
}

function textField(raw, name, { required = false } = {}) {
  if (raw !== undefined && typeof raw !== 'string') throw taskError(`${name} must be a string.`, 'TASK_INVALID');
  const value = (raw ?? '').trim();
  if (required && !value) throw taskError(`${name} is required.`, 'TASK_INVALID');
  if (value.length > LIMITS[name]) throw taskError(`${name} must be at most ${LIMITS[name]} characters.`, 'TASK_INVALID');
  return value;
}

const SOURCE_SHAPE = '{ reference, observation? }: reference is where you looked (a URL, a message id or a file path) and observation is what you saw there';

function normalizeSources(raw) {
  if (!Array.isArray(raw)) throw taskError(`sources must be a list of ${SOURCE_SHAPE}.`, 'TASK_INVALID');
  if (raw.length > MAX_TASK_SOURCES) throw taskError(`sources can hold at most ${MAX_TASK_SOURCES} items.`, 'TASK_INVALID');
  return raw.map((entry) => {
    // A source given as plain text can only be its reference.
    const s = typeof entry === 'string' ? { reference: entry } : entry;
    const reference = typeof s?.reference === 'string' ? s.reference.trim() : '';
    const observation = typeof s?.observation === 'string' ? s.observation.trim() : '';
    if (!reference) throw taskError(`Each source is ${SOURCE_SHAPE}.`, 'TASK_INVALID');
    if (reference.length > SOURCE_LIMITS.reference) {
      throw taskError(`A source reference must be at most ${SOURCE_LIMITS.reference} characters.`, 'TASK_INVALID');
    }
    if (observation.length > SOURCE_LIMITS.observation) {
      throw taskError(`A source observation must be at most ${SOURCE_LIMITS.observation} characters.`, 'TASK_INVALID');
    }
    const at = new Date(s?.observedAt);
    return { reference, observation, observedAt: Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString() };
  });
}

// Session access already persists as profile. Expose the project without a second
// stored assignment or a migration for existing task records.
function taskProject(task) {
  return task.profile === 'all' ? null : task.profile ?? null;
}

// The MCP handler creates store instances per request. Serialize read-modify-write
// per ledger, not per instance, and release the key once pending writes finish.
const pendingWrites = new Map();
async function withLedgerLock(file, fn) {
  const previous = pendingWrites.get(file) || Promise.resolve();
  const next = previous.then(fn, fn);
  pendingWrites.set(file, next);
  try { return await next; }
  finally { if (pendingWrites.get(file) === next) pendingWrites.delete(file); }
}

function publicTask(task) {
  const { lastOperationId, createOperationId, ...rest } = task;
  return { ...rest, project: taskProject(task) };
}

const TASK_STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'about', 'task', 'tasks']);

/** The words of a task search. A short word or a common word says nothing about a task. */
function searchWords(needle) {
  const all = needle.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  const strong = all.filter((w) => (w.length >= 3 || /\d/.test(w)) && !TASK_STOP_WORDS.has(w));
  return strong.length ? strong : all;
}

/** How well a text fits one word: 1 for the word, 0.5 for another form of it ("migration", "migrate"). */
function wordFit(text, word) {
  if (text.includes(word)) return 1;
  return word.length >= 6 && text.includes(word.slice(0, Math.max(5, word.length - 3))) ? 0.5 : 0;
}

export function summarizeTask(task) {
  return {
    id: task.id,
    project: taskProject(task),
    title: task.title,
    status: task.status,
    nextStep: task.nextStep,
    ...(task.assignedTo ? { assignedTo: task.assignedTo } : {}),
    ...(task.requestedBy ? { requestedBy: task.requestedBy } : {}),
    ...(task.result ? { result: task.result } : {}),
    ...(task.notifyOnComplete ? { notifyOnComplete: true } : {}),
    revision: task.revision,
    updatedAt: task.updatedAt,
  };
}

export class TaskStore {
  constructor(dir = defaultDataDir()) {
    this.dir = dir;
    this.file = path.resolve(dir, 'tasks.json');
  }

  async _load() {
    const { data } = await readJsonWithBackup(this.file, {
      validate: (d) => d && typeof d === 'object' && Array.isArray(d.tasks),
    });
    return data ? data.tasks : [];
  }

  async _save(tasks) {
    await atomicWriteFile(this.file, JSON.stringify({ version: 1, tasks }, null, 2) + '\n', { backup: true });
  }

  // 'all' sees every profile; a named profile sees only its own tasks.
  static _visible(task, profile) {
    return !task.forgotten && (profile === 'all' || task.profile === profile);
  }

  async get(id, { profile = 'all' } = {}) {
    const task = (await this._load()).find((t) => t.id === id);
    return task && TaskStore._visible(task, profile) ? publicTask(task) : null;
  }

  async isForgotten(id, { profile = 'all' } = {}) {
    const task = (await this._load()).find((t) => t.id === id);
    return Boolean(task?.forgotten) && (profile === 'all' || task.profile === profile);
  }

  async list({ profile = 'all', focusProject = null, query = '', status = '', assignedTo = null, limit = TASK_PAGE_SIZE, offset = 0 } = {}) {
    const needle = String(query || '').trim().toLowerCase();
    const wanted = String(status || '').trim().toLowerCase();
    const open = new Set(['active', 'waiting']);
    const candidates = (await this._load())
      .filter((t) => TaskStore._visible(t, profile))
      .filter((t) => (wanted ? t.status === wanted : true))
      .filter((t) => (assignedTo ? agentMatchesAssignee(t.assignedTo, assignedTo) : true));

    // A search is by words, in any sequence: "billing migration" finds "Migrate billing to Stripe".
    // If no task has all the words, the tasks with some of them come back, the best fit first, and
    // the result says so (partial).
    let pool = candidates;
    let partial = false;
    const fit = new Map();
    if (needle) {
      const words = searchWords(needle);
      for (const t of candidates) {
        const text = `${t.id}\n${t.title}\n${t.objective}\n${t.notes}\n${t.nextStep || ''}\n${t.assignedTo || ''}\n${t.result || ''}`.toLowerCase();
        const scores = words.map((w) => wordFit(text, w));
        const sum = scores.reduce((a, b) => a + b, 0);
        fit.set(t, { all: text.includes(needle) || scores.every((s) => s > 0), sum });
      }
      pool = candidates.filter((t) => fit.get(t).all);
      if (pool.length === 0 && words.length > 1) {
        pool = candidates.filter((t) => fit.get(t).sum > 0);
        partial = pool.length > 0;
      }
    }
    const matches = pool
      // Open-project tasks first (when focusProject is set), then open tasks, then most recently updated.
      .sort((a, b) => {
        if (partial && fit.get(a).sum !== fit.get(b).sum) return fit.get(b).sum - fit.get(a).sum;
        if (focusProject && focusProject !== 'all') {
          const aIn = a.profile === focusProject ? 1 : 0;
          const bIn = b.profile === focusProject ? 1 : 0;
          if (aIn !== bIn) return bIn - aIn;
        }
        return Number(open.has(b.status)) - Number(open.has(a.status)) || b.updatedAt.localeCompare(a.updatedAt);
      });
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.min(Math.max(1, Number(limit) || TASK_PAGE_SIZE), 200);
    return { total: matches.length, tasks: matches.slice(start, start + size).map(publicTask), ...(partial ? { partial: true } : {}) };
  }

  async save(input = {}, { profile = 'all', writtenBy = 'Agent' } = {}) {
    const expected = input.expectedRevision;
    const operationId = input.operationId === undefined ? '' : String(input.operationId).trim();
    if (operationId.length > OPERATION_ID_MAX) {
      throw taskError(`operationId must be at most ${OPERATION_ID_MAX} characters.`, 'TASK_INVALID');
    }

    return withLedgerLock(this.file, async () => {
      const tasks = await this._load();
      const idx = input.id ? tasks.findIndex((t) => t.id === input.id) : -1;
      const current = idx >= 0 ? tasks[idx] : null;
      if (current && current.profile !== profile && profile !== 'all') {
        throw taskError(`Task "${input.id}" not found.`, 'TASK_NOT_FOUND');
      }
      if (current?.forgotten) {
        throw taskError('This task was forgotten and can no longer be updated. Create a new task instead.', 'TASK_FORGOTTEN');
      }
      if (!Number.isInteger(expected) || expected < 0) {
        if (current) {
          throw taskError(
            `expectedRevision is required to update task "${current.id}". Current revision is ${current.revision}.`,
            'TASK_INVALID',
          );
        }
        throw taskError('expectedRevision is required: 0 to create a task, or the revision you last read to update it.', 'TASK_INVALID');
      }
      // A retry of a previous create with the same operationId returns the existing task without duplicating it.
      if (!current && expected === 0 && operationId) {
        const duplicate = tasks.find((t) =>
          !t.forgotten
          && (profile === 'all' || t.profile === profile)
          && (t.createOperationId === operationId || t.lastOperationId === operationId),
        );
        if (duplicate) return { task: publicTask(duplicate), created: false, deduplicated: true };
      }
      // A retry of the last applied save returns the record as it is now.
      if (current && operationId && current.lastOperationId === operationId) return { task: publicTask(current), created: false, deduplicated: true };
      if (expected !== (current ? current.revision : 0)) {
        if (current) {
          throw taskError(
            `${TASK_CONFLICT_MESSAGE} Current revision for "${current.id}" is ${current.revision} (you passed ${expected}).`,
            'TASK_CONFLICT',
          );
        }
        throw taskError(TASK_CONFLICT_MESSAGE, 'TASK_CONFLICT');
      }
      if (!current && input.id !== undefined && !TASK_ID_RE.test(String(input.id))) {
        throw taskError('A new task id must look like "task_<letters/digits>"; omit id to have one generated.', 'TASK_INVALID');
      }

      const status = input.status === undefined ? current?.status || 'active' : String(input.status).trim().toLowerCase();
      if (!TASK_STATUSES.includes(status)) {
        throw taskError(`status must be one of: ${TASK_STATUSES.join(', ')}.`, 'TASK_INVALID');
      }
      const pick = (name) => (input[name] === undefined && current ? current[name] : textField(input[name], name, { required: name === 'title' }));
      const fields = { title: pick('title'), objective: pick('objective'), notes: pick('notes'), nextStep: pick('nextStep') };
      const assignedTo = input.assignedTo === undefined
        ? (current?.assignedTo || '')
        : textField(input.assignedTo, 'assignedTo');
      const result = input.result === undefined
        ? (current?.result || '')
        : textField(input.result, 'result');
      const notifyOnComplete = input.notifyOnComplete === undefined
        ? Boolean(current?.notifyOnComplete)
        : Boolean(input.notifyOnComplete);
      const requestedBy = current?.requestedBy || (assignedTo ? String(writtenBy || 'Agent').slice(0, 80) : '');
      const sources = input.sources === undefined && current ? current.sources : normalizeSources(input.sources ?? []);
      if ([...Object.values(fields), assignedTo, result, requestedBy, ...sources.flatMap((s) => [s.reference, s.observation])].some(looksLikeSecret)) {
        throw taskError(TASK_SECRET_MESSAGE, 'SECRET_IN_TASK');
      }

      if (!current && tasks.filter((t) => !t.forgotten && t.profile === profile).length >= MAX_TASKS_PER_PROFILE) {
        throw taskError(
          `There are already ${MAX_TASKS_PER_PROFILE} saved tasks. Ask the user which old task to forget (loop__save with type "task", action "delete"), then try again. Do not forget one on your own.`,
          'TASK_CAPACITY',
        );
      }

      const now = new Date().toISOString();
      const next = {
        id: current?.id || input.id || `task_${randomBytes(6).toString('hex')}`,
        ...fields,
        status,
        sources,
        ...(assignedTo ? { assignedTo } : {}),
        ...(requestedBy ? { requestedBy } : {}),
        ...(result ? { result } : {}),
        ...(notifyOnComplete ? { notifyOnComplete: true } : {}),
        revision: (current?.revision || 0) + 1,
        createdAt: current?.createdAt || now,
        updatedAt: now,
        writtenBy: String(writtenBy || 'Agent').slice(0, 80),
        profile: current?.profile || profile,
        ...(current?.createOperationId
          ? { createOperationId: current.createOperationId }
          : (!current && operationId ? { createOperationId: operationId } : {})),
        ...(operationId ? { lastOperationId: operationId } : {}),
      };
      if (current) tasks[idx] = next;
      else tasks.push(next);
      await this._save(tasks);
      return { task: publicTask(next), created: !current };
    });
  }

  // Forgetting wipes the content but keeps a tombstone so a delayed save can't bring the task back.
  async forget(id, { profile = 'all' } = {}) {
    return withLedgerLock(this.file, async () => {
      const tasks = await this._load();
      const idx = tasks.findIndex((t) => t.id === id);
      const current = idx >= 0 ? tasks[idx] : null;
      if (!current || (current.profile !== profile && profile !== 'all')) {
        throw taskError(`Task "${id}" not found.`, 'TASK_NOT_FOUND');
      }
      if (!current.forgotten) {
        tasks[idx] = {
          id,
          forgotten: true,
          revision: current.revision + 1,
          profile: current.profile,
          updatedAt: new Date().toISOString(),
        };
        await this._save(tasks);
      }
      return { id, forgotten: true, revision: tasks[idx].revision };
    });
  }
}
