// Loop Schedules Store — per-workspace one-shot reminders and recurring schedules in SQLite WAL.
// Supports once (ISO or delayMinutes), intervalMinutes, daily ("HH:MM"), weekly (days + "HH:MM"),
// and standard 5-field cron expressions in the workspace's IANA timezone.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { openWorkspaceDb } from './storage/workspace-db.mjs';
import { localClock, validTz, zonedTime } from './zoned-time.mjs';
import { looksLikeSecret } from './memory.mjs';
import { itemMatchesProfile, normalizeItemProfiles } from './profiles.mjs';
import { defaultDataDir } from './vault.mjs';

export const SCHEDULE_KINDS = Object.freeze(['once', 'interval', 'daily', 'weekly', 'cron']);
export const SCHEDULE_ACTIONS = Object.freeze(['notify', 'task', 'both', 'tool']);
export const SCHEDULE_STATUSES = Object.freeze(['active', 'paused', 'completed', 'failed']);
export const MAX_SCHEDULES = 200;
const STALE_CLAIM_MS = 5 * 60_000;
const MAX_RUN_HISTORY_PER_SCHEDULE = 200;

const DAY_MAP = Object.freeze({ sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 });

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'notify',
  status TEXT NOT NULL DEFAULT 'active',
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  run_at TEXT NOT NULL DEFAULT '',
  interval_minutes INTEGER NOT NULL DEFAULT 0,
  time_of_day TEXT NOT NULL DEFAULT '',
  days_json TEXT NOT NULL DEFAULT '[]',
  cron_expr TEXT NOT NULL DEFAULT '',
  projects_json TEXT NOT NULL DEFAULT '["all"]',
  written_by TEXT NOT NULL DEFAULT 'Owner',
  next_run_at TEXT NOT NULL DEFAULT '',
  last_run_at TEXT NOT NULL DEFAULT '',
  last_status TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  last_task_id TEXT NOT NULL DEFAULT '',
  tool_conn_id TEXT NOT NULL DEFAULT '',
  tool_name TEXT NOT NULL DEFAULT '',
  tool_args_json TEXT NOT NULL DEFAULT '{}',
  claim_id TEXT NOT NULL DEFAULT '',
  claimed_at TEXT NOT NULL DEFAULT '',
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(status, next_run_at);
CREATE TABLE IF NOT EXISTS schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  result_summary TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_schedule_runs_sched ON schedule_runs(schedule_id, started_at DESC);
`;

function schedError(message, status = 400, code = 'SCHEDULE_INVALID') {
  return Object.assign(new Error(message), { status, code });
}

const pad2 = (n) => String(n).padStart(2, '0');

/** "2026-12-01 09:00" for a moment in a zone: the clock time that the owner sees. */
function localStamp(ms, tz) {
  if (!Number.isFinite(ms) || !validTz(tz)) return '';
  const c = localClock(ms, tz);
  return `${c.date} ${pad2(c.h)}:${pad2(c.mi)}`;
}

/**
 * A runAt as UTC milliseconds, or NaN. A time with no UTC offset is a clock time in the zone of the
 * schedule: not in UTC, and not in the zone of the computer that runs Loop.
 */
export function parseRunAt(raw, tz) {
  const s = String(raw ?? '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(s);
  if (iso) {
    const [y, mo, d, h, mi, sec] = [1, 2, 3, 4, 5, 6].map((i) => Number(iso[i] || 0));
    const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (mo < 1 || mo > 12 || d < 1 || d > lastDay || h > 23 || mi > 59 || sec > 59) return NaN;
    return zonedTime(y, mo, d, h, mi, tz) + sec * 1000;
  }
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return NaN;
  if (/(?:z|utc|gmt|[+-]\d{2}(?::?\d{2})?)\s*$/i.test(s) || /\b[ecmp][sd]t\b/i.test(s)) return ms;
  // Other text with no zone ("Dec 1, 2026 9:00 AM"): the clock time that was read, in the zone of the schedule.
  const dt = new Date(ms);
  return zonedTime(dt.getFullYear(), dt.getMonth() + 1, dt.getDate(), dt.getHours(), dt.getMinutes(), tz) + dt.getSeconds() * 1000;
}

function parseHHMM(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { h, mi, canonical: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` };
}

function parseDays(raw) {
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const key = String(item || '').trim().toLowerCase().slice(0, 3);
    if (Object.hasOwn(DAY_MAP, key) && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function parseCronField(field, min, max) {
  const values = new Set();
  for (const part of String(field || '').trim().split(',')) {
    const trimmed = part.trim();
    if (!trimmed) return null;
    const [rangePart, stepPart] = trimmed.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;
    let start = min;
    let end = max;
    if (rangePart !== '*') {
      if (rangePart.includes('-')) {
        const [a, b] = rangePart.split('-').map(Number);
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < min || b > max || a > b) return null;
        start = a;
        end = b;
      } else {
        const v = Number(rangePart);
        if (!Number.isInteger(v) || v < min || v > max) return null;
        start = v;
        end = stepPart === undefined ? v : max;
      }
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values.size > 0 ? values : null;
}

export function parseCronExpression(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const doms = parseCronField(parts[2], 1, 31);
  const months = parseCronField(parts[3], 1, 12);
  const dowsRaw = parseCronField(parts[4], 0, 7);
  if (!minutes || !hours || !doms || !months || !dowsRaw) return null;
  const dows = new Set([...dowsRaw].map((d) => (d === 7 ? 0 : d)));
  return { minutes, hours, doms, months, dows };
}

function localDayOfWeek(y, mo, d) {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

function nextCronTime(expr, tz, fromMs) {
  const spec = parseCronExpression(expr);
  if (!spec) return null;
  // Advance in 1-minute steps up to 370 days (fast loop: jumps whole hours/days when non-matching).
  let cursor = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const limit = fromMs + 370 * 86_400_000;
  for (let steps = 0; cursor <= limit && steps < 600_000; steps += 1) {
    const clk = localClock(cursor, tz);
    if (!spec.months.has(clk.mo)) {
      cursor += 86_400_000;
      continue;
    }
    const dow = localDayOfWeek(clk.y, clk.mo, clk.d);
    if (!spec.doms.has(clk.d) || !spec.dows.has(dow)) {
      cursor += 3_600_000;
      continue;
    }
    if (!spec.hours.has(clk.h)) {
      cursor += 60_000 * Math.max(1, 60 - clk.mi);
      continue;
    }
    if (spec.minutes.has(clk.mi)) {
      return new Date(cursor).toISOString();
    }
    cursor += 60_000;
  }
  return null;
}

export function computeNextRunAt(sched, fromMs = Date.now()) {
  const tz = validTz(sched.timezone) ? sched.timezone : 'America/Chicago';
  if (sched.status !== 'active') return '';

  if (sched.kind === 'once') {
    const ms = Date.parse(sched.runAt || '');
    if (!Number.isFinite(ms)) return '';
    return new Date(ms).toISOString();
  }

  if (sched.kind === 'interval') {
    const mins = Number(sched.intervalMinutes) || 0;
    if (mins < 1) return '';
    return new Date(fromMs + mins * 60_000).toISOString();
  }

  if (sched.kind === 'daily') {
    const hhmm = parseHHMM(sched.timeOfDay);
    if (!hhmm) return '';
    const clk = localClock(fromMs, tz);
    let candidate = zonedTime(clk.y, clk.mo, clk.d, hhmm.h, hhmm.mi, tz);
    if (candidate <= fromMs) {
      const nextDate = new Date(Date.UTC(clk.y, clk.mo - 1, clk.d + 1));
      candidate = zonedTime(nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, nextDate.getUTCDate(), hhmm.h, hhmm.mi, tz);
    }
    return new Date(candidate).toISOString();
  }

  if (sched.kind === 'weekly') {
    const hhmm = parseHHMM(sched.timeOfDay);
    const days = Array.isArray(sched.days) ? sched.days : [];
    const dowSet = new Set(days.map((d) => DAY_MAP[d]).filter((v) => v !== undefined));
    if (!hhmm || dowSet.size === 0) return '';
    const clk = localClock(fromMs, tz);
    for (let offset = 0; offset <= 7; offset += 1) {
      const dt = new Date(Date.UTC(clk.y, clk.mo - 1, clk.d + offset));
      if (!dowSet.has(dt.getUTCDay())) continue;
      const candidate = zonedTime(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), hhmm.h, hhmm.mi, tz);
      if (candidate > fromMs) return new Date(candidate).toISOString();
    }
    return '';
  }

  if (sched.kind === 'cron') {
    return nextCronTime(sched.cronExpr, tz, fromMs) || '';
  }

  return '';
}

function rowToSchedule(row) {
  if (!row) return null;
  let days = [];
  let projects = ['all'];
  let toolArgs = {};
  try { days = JSON.parse(row.days_json || '[]'); } catch { days = []; }
  try { projects = normalizeItemProfiles(JSON.parse(row.projects_json || '["all"]')); } catch { projects = ['all']; }
  try {
    const parsedArgs = JSON.parse(row.tool_args_json || '{}');
    if (parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)) toolArgs = parsedArgs;
  } catch { toolArgs = {}; }
  return {
    id: row.id,
    title: row.title,
    message: row.message || '',
    kind: row.kind,
    action: row.action,
    status: row.status,
    timezone: row.timezone,
    ...(row.run_at ? { runAt: row.run_at } : {}),
    ...(row.interval_minutes ? { intervalMinutes: row.interval_minutes } : {}),
    ...(row.time_of_day ? { timeOfDay: row.time_of_day } : {}),
    ...(days.length ? { days } : {}),
    ...(row.cron_expr ? { cronExpr: row.cron_expr } : {}),
    ...(row.tool_conn_id ? { toolConnectionId: row.tool_conn_id } : {}),
    ...(row.tool_name ? { toolName: row.tool_name } : {}),
    ...(row.tool_conn_id && row.tool_name ? { tool: `${row.tool_conn_id}__${row.tool_name}`, toolArgs } : {}),
    projects,
    profiles: projects,
    writtenBy: row.written_by,
    nextRunAt: row.next_run_at || '',
    // The same moment as a clock time in the zone of the schedule, so nobody has to convert from UTC.
    ...(row.next_run_at && localStamp(Date.parse(row.next_run_at), row.timezone)
      ? { nextRunLocal: `${localStamp(Date.parse(row.next_run_at), row.timezone)} ${row.timezone}` }
      : {}),
    ...(row.last_run_at ? { lastRunAt: row.last_run_at } : {}),
    ...(row.last_status ? { lastStatus: row.last_status } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.last_task_id ? { lastTaskId: row.last_task_id } : {}),
    runCount: Number(row.run_count) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ScheduleStore {
  constructor(dir = defaultDataDir(), { defaultTimezone = 'America/Chicago', onNextRunChange = null } = {}) {
    this.dir = dir;
    this.dbFile = path.resolve(dir, 'schedules.db');
    this.defaultTimezone = validTz(defaultTimezone) ? defaultTimezone : 'America/Chicago';
    this.onNextRunChange = typeof onNextRunChange === 'function' ? onNextRunChange : null;
  }

  _db() {
    const db = openWorkspaceDb(this.dbFile, { initSql: SCHEMA_SQL });
    if (!this._migrated) {
      this._migrated = true;
      const cols = db.prepare('PRAGMA table_info(schedules)').all().map((c) => c.name);
      const migrations = [
        ['last_task_id', "ALTER TABLE schedules ADD COLUMN last_task_id TEXT NOT NULL DEFAULT ''"],
        ['tool_conn_id', "ALTER TABLE schedules ADD COLUMN tool_conn_id TEXT NOT NULL DEFAULT ''"],
        ['tool_name', "ALTER TABLE schedules ADD COLUMN tool_name TEXT NOT NULL DEFAULT ''"],
        ['tool_args_json', "ALTER TABLE schedules ADD COLUMN tool_args_json TEXT NOT NULL DEFAULT '{}'"],
        ['claim_id', "ALTER TABLE schedules ADD COLUMN claim_id TEXT NOT NULL DEFAULT ''"],
        ['claimed_at', "ALTER TABLE schedules ADD COLUMN claimed_at TEXT NOT NULL DEFAULT ''"],
      ];
      for (const [col, sql] of migrations) {
        if (!cols.includes(col)) db.exec(sql);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS schedule_runs (
          id TEXT PRIMARY KEY,
          schedule_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT NOT NULL DEFAULT '',
          result_summary TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_schedule_runs_sched ON schedule_runs(schedule_id, started_at DESC);
      `);
    }
    return db;
  }

  _syncWakeIndex() {
    if (!this.onNextRunChange) return;
    try {
      const row = this._db()
        .prepare("SELECT MIN(next_run_at) AS next_run_at FROM schedules WHERE status = 'active' AND next_run_at != ''")
        .get();
      this.onNextRunChange(row?.next_run_at || '');
    } catch {
      // Best-effort wake index sync.
    }
  }

  async get(id, { profile = 'all' } = {}) {
    const row = this._db().prepare('SELECT * FROM schedules WHERE id = ?').get(String(id || ''));
    const sched = rowToSchedule(row);
    if (!sched) return null;
    if (profile && profile !== 'all' && !itemMatchesProfile(sched, profile)) return null;
    return sched;
  }

  async list({ profile = 'all', focusProject = null, status = '', query = '', limit = 50, offset = 0 } = {}) {
    const rows = this._db().prepare('SELECT * FROM schedules ORDER BY CASE status WHEN \'active\' THEN 0 WHEN \'paused\' THEN 1 ELSE 2 END, next_run_at ASC, updated_at DESC').all();
    const needle = String(query || '').trim().toLowerCase();
    const wantedStatus = String(status || '').trim().toLowerCase();
    const filtered = rows
      .map(rowToSchedule)
      .filter((s) => {
        if (profile && profile !== 'all' && !itemMatchesProfile(s, profile)) return false;
        if (wantedStatus && s.status !== wantedStatus) return false;
        if (needle && !`${s.title} ${s.message} ${s.kind} ${s.cronExpr || ''}`.toLowerCase().includes(needle)) return false;
        return true;
      });
    if (focusProject && focusProject !== 'all') {
      filtered.sort((a, b) => {
        const aIn = Array.isArray(a.projects) && a.projects.includes(focusProject) ? 1 : 0;
        const bIn = Array.isArray(b.projects) && b.projects.includes(focusProject) ? 1 : 0;
        return bIn - aIn;
      });
    }
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.max(1, Math.min(Number(limit) || 50, 200));
    return { total: filtered.length, schedules: filtered.slice(start, start + size) };
  }

  async save(input = {}, { profile = 'all', writtenBy = 'Owner', now = Date.now(), defaultTimezone = null } = {}) {
    const db = this._db();
    const existing = input.id ? await this.get(input.id, { profile }) : null;
    if (input.id && !existing) {
      throw schedError(`Schedule "${input.id}" not found.`, 404, 'SCHEDULE_NOT_FOUND');
    }

    const title = input.title !== undefined
      ? String(input.title || '').replace(/\s+/g, ' ').trim().slice(0, 140)
      : (existing?.title || '');
    if (!title) throw schedError('title is required for a schedule.', 400);

    const message = input.message !== undefined
      ? String(input.message || '').trim().slice(0, 1000)
      : (existing?.message || '');

    if (looksLikeSecret(title) || looksLikeSecret(message)) {
      throw schedError('Secrets cannot be stored in a schedule. Use Loop Vault instead.', 400, 'SECRET_IN_SCHEDULE');
    }

    const rawKind = input.kind !== undefined
      ? String(input.kind).trim().toLowerCase()
      : existing?.kind || (input.cronExpr || input.cron ? 'cron' : input.intervalMinutes ? 'interval' : input.days ? 'weekly' : input.timeOfDay ? 'daily' : 'once');
    if (!SCHEDULE_KINDS.includes(rawKind)) {
      throw schedError(`kind must be one of: ${SCHEDULE_KINDS.join(', ')}.`, 400);
    }

    const action = input.action !== undefined
      ? String(input.action).trim().toLowerCase()
      : (existing?.action || 'notify');
    if (!SCHEDULE_ACTIONS.includes(action)) {
      throw schedError(`action must be one of: ${SCHEDULE_ACTIONS.join(', ')}.`, 400);
    }

    let toolConnId = existing?.toolConnectionId || '';
    let toolName = existing?.toolName || '';
    let toolArgs = existing?.toolArgs || {};
    if (typeof input.tool === 'string' && input.tool.includes('__')) {
      const idx = input.tool.indexOf('__');
      toolConnId = input.tool.slice(0, idx).trim();
      toolName = input.tool.slice(idx + 2).trim();
    }
    if (input.toolConnectionId !== undefined || input.toolConnId !== undefined) {
      toolConnId = String(input.toolConnectionId ?? input.toolConnId ?? '').trim().slice(0, 120);
    }
    if (input.toolName !== undefined) {
      toolName = String(input.toolName || '').trim().slice(0, 120);
    }
    if (input.toolArgs !== undefined) {
      if (!input.toolArgs || typeof input.toolArgs !== 'object' || Array.isArray(input.toolArgs)) {
        throw schedError('toolArgs must be a JSON object.', 400);
      }
      const serialized = JSON.stringify(input.toolArgs);
      if (serialized.length > 16_384) throw schedError('toolArgs is too large.', 400);
      if (looksLikeSecret(serialized)) {
        throw schedError('Secrets cannot be stored in toolArgs. Use {{vault:KEY}} references instead.', 400, 'SECRET_IN_SCHEDULE');
      }
      toolArgs = input.toolArgs;
    }
    if (action === 'tool' && (!toolConnId || !toolName)) {
      throw schedError('toolConnectionId and toolName (or tool: "connId__toolName") are required for action "tool".', 400);
    }

    // Scheduled tool runs default to paused until explicitly activated by the Owner.
    const defaultStatus = !existing && action === 'tool' ? 'paused' : (existing?.status || 'active');
    const status = input.status !== undefined
      ? String(input.status).trim().toLowerCase()
      : defaultStatus;
    if (!SCHEDULE_STATUSES.includes(status)) {
      throw schedError(`status must be one of: ${SCHEDULE_STATUSES.join(', ')}.`, 400);
    }

    const rawTz = input.timezone || existing?.timezone || defaultTimezone || this.defaultTimezone;
    if (!validTz(rawTz)) throw schedError(`Invalid IANA timezone "${rawTz}".`, 400);

    let runAt = existing?.runAt || '';
    let intervalMinutes = existing?.intervalMinutes || 0;
    let timeOfDay = existing?.timeOfDay || '';
    let days = existing?.days || [];
    let cronExpr = existing?.cronExpr || '';

    if (rawKind === 'once') {
      if (input.delayMinutes !== undefined) {
        const delay = Number(input.delayMinutes);
        if (!Number.isFinite(delay) || delay <= 0 || delay > 525_600) {
          throw schedError('delayMinutes must be between 1 and 525600.', 400);
        }
        runAt = new Date(now + delay * 60_000).toISOString();
      } else if (input.runAt !== undefined) {
        const ms = parseRunAt(input.runAt, rawTz);
        if (!Number.isFinite(ms)) {
          throw schedError('runAt must be a valid date and time, for example 2026-12-01T09:00 (a clock time in the timezone of the schedule) or 2026-12-01T15:00:00Z.', 400);
        }
        const nextRunAtIso = new Date(ms).toISOString();
        // A time that is already past runs at once, which is never what a reminder is for. One minute
        // of tolerance lets "now" through. A runAt that did not change stays as it is.
        if (nextRunAtIso !== existing?.runAt && ms < now - 60_000) {
          throw schedError(
            `runAt is in the past: ${localStamp(ms, rawTz)} ${rawTz}. Give a later time, or use delayMinutes.`,
            400,
            'SCHEDULE_IN_PAST',
          );
        }
        runAt = nextRunAtIso;
      } else if (!runAt) {
        throw schedError('Provide runAt (ISO timestamp) or delayMinutes for a one-time schedule.', 400);
      }
    } else if (rawKind === 'interval') {
      const mins = input.intervalMinutes !== undefined ? Number(input.intervalMinutes) : intervalMinutes;
      if (!Number.isInteger(mins) || mins < 5 || mins > 43_200) {
        throw schedError('intervalMinutes must be an integer between 5 and 43200.', 400);
      }
      intervalMinutes = mins;
    } else if (rawKind === 'daily') {
      const hhmm = parseHHMM(input.timeOfDay !== undefined ? input.timeOfDay : timeOfDay);
      if (!hhmm) throw schedError('timeOfDay must be in 24-hour HH:MM format (for example "09:00").', 400);
      timeOfDay = hhmm.canonical;
    } else if (rawKind === 'weekly') {
      const hhmm = parseHHMM(input.timeOfDay !== undefined ? input.timeOfDay : timeOfDay);
      if (!hhmm) throw schedError('timeOfDay must be in 24-hour HH:MM format (for example "09:00").', 400);
      timeOfDay = hhmm.canonical;
      days = input.days !== undefined ? parseDays(input.days) : days;
      if (days.length === 0) throw schedError('days must include at least one day (sun, mon, tue, wed, thu, fri, sat).', 400);
    } else if (rawKind === 'cron') {
      cronExpr = String(input.cronExpr ?? input.cron ?? cronExpr ?? '').trim();
      if (!parseCronExpression(cronExpr)) {
        throw schedError('cronExpr must be a valid 5-field cron expression (for example "0 9 * * 1").', 400);
      }
    }

    const projects = input.projects !== undefined
      ? normalizeItemProfiles(input.projects)
      : input.project
        ? normalizeItemProfiles([input.project])
        : existing?.projects || normalizeItemProfiles(profile && profile !== 'all' ? [profile] : ['all']);

    const nextRunAt = computeNextRunAt(
      { kind: rawKind, status, timezone: rawTz, runAt, intervalMinutes, timeOfDay, days, cronExpr },
      now,
    );
    if (status === 'active' && !nextRunAt) {
      throw schedError('Could not compute next run time for this schedule.', 400);
    }

    const nowIso = new Date(now).toISOString();
    const toolArgsJson = JSON.stringify(toolArgs || {});
    if (existing) {
      db.prepare(`
        UPDATE schedules
        SET title = ?, message = ?, kind = ?, action = ?, status = ?, timezone = ?,
            run_at = ?, interval_minutes = ?, time_of_day = ?, days_json = ?, cron_expr = ?,
            projects_json = ?, tool_conn_id = ?, tool_name = ?, tool_args_json = ?,
            next_run_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        title, message, rawKind, action, status, rawTz,
        runAt, intervalMinutes, timeOfDay, JSON.stringify(days), cronExpr,
        JSON.stringify(projects), toolConnId, toolName, toolArgsJson,
        nextRunAt, nowIso, existing.id,
      );
      this._syncWakeIndex();
      return { schedule: await this.get(existing.id), created: false };
    }

    const countRow = db.prepare('SELECT COUNT(*) AS n FROM schedules').get();
    if ((countRow?.n || 0) >= MAX_SCHEDULES) {
      throw schedError(`Schedule limit (${MAX_SCHEDULES}) reached. Delete old schedules first.`, 409, 'SCHEDULE_CAPACITY');
    }

    const id = `sch_${randomBytes(6).toString('hex')}`;
    db.prepare(`
      INSERT INTO schedules (
        id, title, message, kind, action, status, timezone, run_at, interval_minutes,
        time_of_day, days_json, cron_expr, projects_json, written_by,
        tool_conn_id, tool_name, tool_args_json, next_run_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, title, message, rawKind, action, status, rawTz, runAt, intervalMinutes,
      timeOfDay, JSON.stringify(days), cronExpr, JSON.stringify(projects),
      String(writtenBy || 'Owner').slice(0, 80),
      toolConnId, toolName, toolArgsJson, nextRunAt, nowIso, nowIso,
    );
    this._syncWakeIndex();
    return { schedule: await this.get(id), created: true };
  }

  async delete(id, { profile = 'all' } = {}) {
    const sched = await this.get(id, { profile });
    if (!sched) throw schedError(`Schedule "${id}" not found.`, 404, 'SCHEDULE_NOT_FOUND');
    const db = this._db();
    db.prepare('DELETE FROM schedule_runs WHERE schedule_id = ?').run(sched.id);
    db.prepare('DELETE FROM schedules WHERE id = ?').run(sched.id);
    this._syncWakeIndex();
    return { deleted: true, id: sched.id };
  }

  async listRuns(scheduleId, { limit = 50 } = {}) {
    const db = this._db();
    const cap = Math.max(1, Math.min(Number(limit) || 50, MAX_RUN_HISTORY_PER_SCHEDULE));
    const rows = db.prepare(`
      SELECT * FROM schedule_runs
      WHERE schedule_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(String(scheduleId || ''), cap);
    return rows.map((r) => ({
      id: r.id,
      scheduleId: r.schedule_id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      ...(r.error ? { error: r.error } : {}),
      ...(r.result_summary ? { resultSummary: r.result_summary } : {}),
    }));
  }

  _tryClaim(id, now) {
    const db = this._db();
    const claimId = `clm_${randomBytes(6).toString('hex')}`;
    const nowIso = new Date(now).toISOString();
    const staleCutoff = new Date(now - STALE_CLAIM_MS).toISOString();
    const res = db.prepare(`
      UPDATE schedules
      SET claim_id = ?, claimed_at = ?
      WHERE id = ? AND (claim_id = '' OR claimed_at = '' OR claimed_at < ?)
    `).run(claimId, nowIso, id, staleCutoff);
    return res.changes > 0 ? claimId : null;
  }

  _releaseClaim(id, claimId) {
    try {
      this._db().prepare(`
        UPDATE schedules SET claim_id = '', claimed_at = ''
        WHERE id = ? AND claim_id = ?
      `).run(id, claimId);
    } catch {
      // Ignore cleanup error on shutdown.
    }
  }

  _recordRun(scheduleId, { startedAt, finishedAt, status, error = '', resultSummary = '' }) {
    try {
      const db = this._db();
      const runId = `run_${randomBytes(6).toString('hex')}`;
      db.prepare(`
        INSERT INTO schedule_runs (id, schedule_id, started_at, finished_at, status, error, result_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        scheduleId,
        startedAt,
        finishedAt,
        status,
        String(error || '').slice(0, 300),
        String(resultSummary || '').slice(0, 500),
      );
      db.prepare(`
        DELETE FROM schedule_runs
        WHERE schedule_id = ? AND id NOT IN (
          SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ?
        )
      `).run(scheduleId, scheduleId, MAX_RUN_HISTORY_PER_SCHEDULE);
      return runId;
    } catch {
      return '';
    }
  }

  async _executeSchedule(sched, { now, dispatchNotify, createTask, executeTool }) {
    const claimId = this._tryClaim(sched.id, now);
    if (!claimId) {
      return {
        id: sched.id,
        title: sched.title,
        status: 'skipped',
        reason: 'already_claimed',
        scheduleStatus: sched.status,
      };
    }

    const db = this._db();
    const nowIso = new Date(now).toISOString();
    let lastStatus = 'ok';
    let lastError = '';
    let errorCode = '';
    let createdTaskId = '';
    let resultSummary = '';
    try {
      if ((sched.action === 'notify' || sched.action === 'both') && typeof dispatchNotify === 'function') {
        const notifyRes = await dispatchNotify(sched);
        if (notifyRes && typeof notifyRes === 'object' && notifyRes.smsFailed) {
          lastStatus = 'error';
          lastError = String(notifyRes.smsNote || 'SMS delivery failed.').slice(0, 240);
          errorCode = 'SMS_FAILED';
        }
      }
      if ((sched.action === 'task' || sched.action === 'both') && typeof createTask === 'function') {
        const created = await createTask(sched);
        createdTaskId = String(created?.id || created?.task?.id || '');
      }
      if (sched.action === 'tool') {
        if (typeof executeTool !== 'function') {
          throw schedError('Scheduled tool execution is not configured.', 503, 'TOOL_DISPATCH_UNAVAILABLE');
        }
        const toolRes = await executeTool(sched);
        resultSummary = typeof toolRes?.summary === 'string'
          ? toolRes.summary.slice(0, 500)
          : (toolRes ? JSON.stringify(toolRes).slice(0, 500) : 'ok');
      }
    } catch (err) {
      lastStatus = 'error';
      errorCode = String(err?.code || '');
      lastError = String(err?.message || 'Schedule execution failed.').slice(0, 240);
    } finally {
      this._releaseClaim(sched.id, claimId);
    }

    const finishedIso = new Date(Math.max(now, Date.now())).toISOString();
    const runId = this._recordRun(sched.id, {
      startedAt: nowIso,
      finishedAt: finishedIso,
      status: lastStatus,
      error: lastError,
      resultSummary,
    });

    const MAX_ONCE_RETRIES = 5;
    const nonRetryableError =
      errorCode === 'TASK_CAPACITY' ||
      errorCode === 'TASK_INVALID' ||
      errorCode === 'SECRET_IN_TASK' ||
      errorCode === 'POLICY_APPROVAL_REQUIRED' ||
      errorCode === 'POLICY_DENIED' ||
      errorCode === 'CONNECTION_DISABLED';
    const retryFailedOnce = sched.kind === 'once'
      && lastStatus === 'error'
      && !nonRetryableError
      && (sched.runCount || 0) < MAX_ONCE_RETRIES;
    const nextStatus = sched.kind === 'once'
      ? (lastStatus === 'ok' ? 'completed' : (retryFailedOnce ? 'active' : 'failed'))
      : sched.status;
    let nextRunAt = '';
    if (retryFailedOnce) {
      const retryDelaysMin = [5, 15, 30, 60, 60];
      const delayMin = retryDelaysMin[Math.min(sched.runCount || 0, retryDelaysMin.length - 1)];
      nextRunAt = new Date(now + delayMin * 60_000).toISOString();
    } else if (nextStatus === 'active') {
      nextRunAt = computeNextRunAt({ ...sched, status: nextStatus }, now);
    }
    const countDelta = lastStatus === 'ok' || retryFailedOnce ? 1 : 0;
    db.prepare(`
      UPDATE schedules
      SET status = ?, next_run_at = ?, last_run_at = ?, last_status = ?, last_error = ?,
          last_task_id = CASE WHEN ? != '' THEN ? ELSE last_task_id END,
          run_count = run_count + ?, updated_at = ?
      WHERE id = ?
    `).run(nextStatus, nextRunAt, nowIso, lastStatus, lastError, createdTaskId, createdTaskId, countDelta, nowIso, sched.id);
    this._syncWakeIndex();

    return {
      id: sched.id,
      runId,
      title: sched.title,
      status: lastStatus,
      scheduleStatus: nextStatus,
      ...(lastError ? { error: lastError } : {}),
      ...(resultSummary ? { resultSummary } : {}),
      ...(createdTaskId ? { taskId: createdTaskId } : {}),
      nextRunAt,
    };
  }

  async runNow(id, { now = Date.now(), dispatchNotify = null, createTask = null, executeTool = null, profile = 'all' } = {}) {
    const sched = await this.get(id, { profile });
    if (!sched) throw schedError(`Schedule "${id}" not found.`, 404, 'SCHEDULE_NOT_FOUND');
    return this._executeSchedule(sched, { now, dispatchNotify, createTask, executeTool });
  }

  async tick({ now = Date.now(), dispatchNotify = null, createTask = null, executeTool = null } = {}) {
    const db = this._db();
    const nowIso = new Date(now).toISOString();
    const dueRows = db.prepare(`
      SELECT * FROM schedules
      WHERE status = 'active' AND next_run_at != '' AND next_run_at <= ?
      ORDER BY next_run_at ASC
      LIMIT 25
    `).all(nowIso);
    const results = [];
    for (const row of dueRows) {
      const sched = rowToSchedule(row);
      if (!sched) continue;
      results.push(await this._executeSchedule(sched, { now, dispatchNotify, createTask, executeTool }));
    }
    return results;
  }
}
