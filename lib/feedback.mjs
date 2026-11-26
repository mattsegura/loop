// Agent feedback about Loop itself, sent with one MCP tool.
//
// It goes in through MCP and never comes back out through MCP. The text is untrusted: any agent, or
// any page that an agent read, can shape it. The operator of this Loop reads it with
// scripts/feedback.mjs (triage: lib/feedback-triage.mjs), and each workspace sees and deletes its own
// reports in Settings. One file per server holds the reports of all workspaces, so who sent a report
// is kept only as a keyed one-way tag.

import { createHmac, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { clientLabel } from './clients.mjs';
import { looksLikeSecret } from './memory.mjs';
import { openWorkspaceDb } from './storage/workspace-db.mjs';
import { defaultDataDir } from './vault.mjs';

export const FEEDBACK_TOOL = 'loop__send_feedback';
export const FEEDBACK_TYPES = Object.freeze(['bug', 'improvement']);
export const FEEDBACK_SOURCES = Object.freeze(['model', 'user']);

export const feedbackToolSchema = Object.freeze({
  name: FEEDBACK_TOOL,
  description:
    'Send feedback about Loop itself to the people who run it. Use this tool ONLY for feedback about Loop: its own `loop__*` tools, search results, error messages, instructions, built-in skills, sign-in or approvals. NEVER for a connected service or its tools, a task that needs a service the user has not connected, another app, the host, or the user’s own work. Call it without being asked when you find a genuine problem with Loop: a Loop tool that failed unexpectedly (also if you found another way), a wrong or unhelpful result, or a missing feature of Loop’s own tools. Call it when the user asks you to send feedback about Loop. Do the user’s task first. Send one short report for each problem. A report is anonymous and nobody can reply to it: before you send, remove all personal data (also a name or contact details that the user gives for a reply), credentials and content of the user’s accounts or files, and write placeholders such as "[name]" instead.',
  annotations: Object.freeze({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }),
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'What Loop did, what you expected, and what would be better, in at most five short sentences and your own words. No names, contact details or other personal data, no credentials and no pasted output.',
      },
      type: {
        type: 'string',
        enum: [...FEEDBACK_TYPES],
        description: '"bug" if Loop does not do what it says, "improvement" if something is missing or can be better.',
      },
      source: {
        type: 'string',
        enum: [...FEEDBACK_SOURCES],
        description: '"user" if the user explicitly asked to send feedback, "model" if you send it on your own.',
      },
      about: {
        type: 'string',
        description: 'Optional. The part of Loop, for example "loop__search" or "sign-in".',
      },
      task: {
        type: 'string',
        description: 'Optional. What you tried to do, as one general sentence without names or private details. Loop is tested on it later.',
      },
    },
    required: ['content', 'type', 'source'],
    additionalProperties: false,
  },
});

// One line for the start of a session: apps that load tools on demand show only a tool's name.
export const FEEDBACK_INSTRUCTION =
  `If Loop itself fails, even if another way worked, report it once with \`${FEEDBACK_TOOL}\` after the task. Do not ask first.`;

const LIMITS = Object.freeze({
  raw: 8000,
  content: 2000,
  about: 80,
  task: 300,
  modelPerHour: 5,
  modelPerDay: 20,
  userPerHour: 20,
  workspacePerDay: 100,
  keepDays: 180,
  askAgainDays: 7,
  keepRows: 5000,
});

/* ---------------- Cleaning ---------------- */

const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
// Characters that a person cannot see. Line breaks and tabs are kept as spaces and breaks.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}]/gu;
// The same, limited to what has no use in a report: text direction overrides, invisible tag letters
// and terminal control sequences.
const HIDDEN_RE = /[\u001b\u202a-\u202e\u2066-\u2069\u{e0000}-\u{e007f}]/u;
const URL_RE = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s<>"'`)\]}]+/gi;
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const HOME_RE = /(?:\/(?:Users|home)\/|\b[A-Za-z]:\\Users\\)[^\s/\\"'`]+/g;
const IP_RE = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\d)|(?<![\w:.])(?=:{0,2}[\da-f])[\da-f]{0,4}(?::[\da-f]{0,4}){3,7}(?![\w:])/gi;
const NUMBER_RE = /(?<![\w.])\+?\(?\d[\d ().-]{6,}\d(?!\w)/g;
const DATE_RE = /^\d{4}-\d{2}-\d{2} \d{1,2}$/;
const TOKEN_RE = /(?<![\w-])[A-Za-z0-9_-]{16,}(?![\w-])/g;

// Only this much of a text is looked at, so that no text can hold the server up.
function rawText(raw) {
  return typeof raw === 'string' ? raw.slice(0, LIMITS.raw) : '';
}

function visibleText(raw) {
  return rawText(raw)
    .normalize('NFC')
    .replace(ANSI_RE, '')
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/\t/g, ' ')
    .replace(INVISIBLE_RE, (ch) => (ch === '\n' ? ch : ''));
}

function linkLabel(url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // A broken address keeps no host.
  }
  return /[a-z]/i.test(host) ? `[link ${host}]` : '[link]';
}

function maskPersonal(text) {
  return text
    .replace(URL_RE, linkLabel)
    .replace(EMAIL_RE, '[email]')
    .replace(HOME_RE, '[home]')
    .replace(IP_RE, '[ip]')
    .replace(TOKEN_RE, (m) => ((m.match(/\d/g) || []).length >= 4 && /[A-Za-z]/.test(m) ? '[id]' : m))
    .replace(NUMBER_RE, (m) => (m.replace(/\D/g, '').length >= 9 && !DATE_RE.test(m) ? '[number]' : m));
}

/** The text that is safe to keep and to show, and what was found in the text that came in. */
export function cleanFeedbackText(raw, max = LIMITS.content, cover = (text) => text) {
  const visible = visibleText(raw);
  const masked = maskPersonal(cover(visible));
  const chars = [...masked
    .replace(/\p{Zs}+/gu, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()];
  return {
    text: (chars.length > max ? [...chars.slice(0, max - 1), '…'] : chars).join(''),
    hidden: HIDDEN_RE.test(rawText(raw)),
    masked: masked !== visible,
  };
}

function oneLine(raw, max, cover) {
  return cleanFeedbackText(raw, max, cover).text.replace(/\s+/g, ' ');
}

// A name or version that an app gives for itself.
function appLabel(raw, max) {
  return visibleText(raw).replace(/[^\p{L}\p{N} ._+()/:-]+/gu, ' ').replace(/ +/g, ' ').trim().slice(0, max);
}

function choice(raw, allowed, fallback) {
  const value = String(raw ?? '').trim().toLowerCase();
  return allowed.includes(value) ? value : fallback;
}

/* ---------------- Store ---------------- */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'model',
  about TEXT NOT NULL DEFAULT '',
  task TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  masked INTEGER NOT NULL DEFAULT 0,
  workspace TEXT NOT NULL,
  reporter TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '',
  client_version TEXT NOT NULL DEFAULT '',
  protocol_version TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL DEFAULT '',
  surface TEXT NOT NULL DEFAULT '',
  build TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL,
  times INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  reason TEXT NOT NULL DEFAULT '',
  issue TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_workspace ON reports(workspace, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);
CREATE TABLE IF NOT EXISTS asked (workspace TEXT PRIMARY KEY, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  area TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'low',
  status TEXT NOT NULL DEFAULT 'open',
  problems TEXT NOT NULL DEFAULT '[]',
  review TEXT NOT NULL DEFAULT '',
  pushed_to TEXT NOT NULL DEFAULT '',
  returned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const REPORT_STATUSES = Object.freeze(['new', 'held', 'dropped', 'grouped']);
export const ISSUE_STATUSES = Object.freeze(['open', 'accepted', 'pushed', 'closed', 'rejected']);

function rowToReport(row) {
  return {
    id: row.id,
    content: row.content,
    type: row.type,
    source: row.source,
    about: row.about,
    task: row.task,
    client: row.client,
    clientVersion: row.client_version,
    protocolVersion: row.protocol_version,
    transport: row.transport,
    surface: row.surface,
    build: row.build,
    hidden: Boolean(row.hidden),
    masked: Boolean(row.masked),
    workspace: row.workspace,
    reporter: row.reporter,
    times: row.times,
    status: row.status,
    reason: row.reason,
    issue: row.issue,
    createdAt: row.created_at,
    lastAt: row.last_at,
  };
}

function rowToIssue(row) {
  let problems = [];
  let review = null;
  try { problems = JSON.parse(row.problems); } catch { /* keep the empty list */ }
  try { review = row.review ? JSON.parse(row.review) : null; } catch { /* no review */ }
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    area: row.area,
    severity: row.severity,
    status: row.status,
    problems,
    review,
    pushedTo: row.pushed_to,
    returned: Boolean(row.returned),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class FeedbackStore {
  constructor(dir = defaultDataDir(), { limits = {}, build = '', now = Date.now } = {}) {
    this.dir = dir;
    this.dbFile = path.resolve(dir, 'feedback.db');
    this.limits = { ...LIMITS, ...limits };
    this.build = build;
    this.now = now;
    this.tagKey = null;
    this.made = false;
  }

  /** True when this server has feedback. A look at an empty Settings page writes no file. */
  exists() {
    return existsSync(this.dbFile);
  }

  _db() {
    if (!this.made) {
      // The reports of every workspace are in this file, so only the server's own user may read it.
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      closeSync(openSync(this.dbFile, 'a', 0o600));
      this.made = true;
    }
    return openWorkspaceDb(this.dbFile, { initSql: SCHEMA_SQL });
  }

  _meta(key, bytes) {
    const db = this._db();
    db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(key, randomBytes(bytes).toString('hex'));
    return db.prepare('SELECT value FROM meta WHERE key = ?').get(key).value;
  }

  _tag(text) {
    this.tagKey ||= this._meta('tag-key', 32);
    return createHmac('sha256', this.tagKey).update(text).digest('hex').slice(0, 16);
  }

  _workspaceTag(workspaceId) {
    return this._tag(`workspace\n${workspaceId || 'local'}`);
  }

  _count(where, params, sinceMs) {
    return this._db()
      .prepare(`SELECT COUNT(*) AS n FROM reports WHERE ${where} AND created_at >= ?`)
      .get(...params, new Date(this.now() - sinceMs).toISOString()).n;
  }

  _overLimit({ workspace, reporter, source }) {
    const HOUR = 3_600_000;
    const l = this.limits;
    const mine = (from, ms) => this._count('reporter = ? AND source = ?', [reporter, from], ms);
    if (this._count('workspace = ?', [workspace], 24 * HOUR) >= l.workspacePerDay) return true;
    if (source === 'user') return mine('user', HOUR) >= l.userPerHour;
    return mine('model', HOUR) >= l.modelPerHour || mine('model', 24 * HOUR) >= l.modelPerDay;
  }

  /**
   * Keeps one report. `who`: { workspaceId, agentId, clientName, clientVersion, protocolVersion,
   * transport, surface }. `cover` hides values of the workspace's Vault. What it hides must not change
   * the answer, or an agent could test guesses with it.
   * Returns { status: 'received' | 'empty' | 'secret' | 'limit', id? }.
   */
  add(input = {}, who = {}, { cover } = {}) {
    const content = cleanFeedbackText(input.content, this.limits.content, cover);
    if (!content.text) return { status: 'empty' };
    const parts = [input.content, input.about, input.task];
    if (parts.some((v) => looksLikeSecret(rawText(v)) || looksLikeSecret(visibleText(v)))) return { status: 'secret' };

    const type = choice(input.type, FEEDBACK_TYPES, '');
    const source = choice(input.source, FEEDBACK_SOURCES, 'model');
    const about = oneLine(input.about, this.limits.about, cover);
    const task = cleanFeedbackText(input.task, this.limits.task, cover);
    const client = appLabel(clientLabel(who.clientName), 60);
    const workspace = this._workspaceTag(who.workspaceId);
    const reporter = this._tag(`reporter\n${who.workspaceId || 'local'}\n${who.agentId || client}`);
    const words = [type, visibleText(input.about), visibleText(input.content)].join('\n');
    const fingerprint = this._tag(`report\n${words.toLowerCase().replace(/[^\p{L}]+/gu, ' ')}`);
    const db = this._db();
    const at = new Date(this.now()).toISOString();

    const same = db.prepare('SELECT id FROM reports WHERE reporter = ? AND fingerprint = ?').get(reporter, fingerprint);
    if (same) {
      db.prepare('UPDATE reports SET times = MIN(times + 1, 1000), last_at = ? WHERE id = ?').run(at, same.id);
      return { status: 'received', id: same.id };
    }
    if (this._overLimit({ workspace, reporter, source })) return { status: 'limit' };

    const id = `fb_${randomBytes(6).toString('hex')}`;
    db.prepare(`
      INSERT INTO reports (
        id, content, type, source, about, task, hidden, masked, workspace, reporter, client, client_version,
        protocol_version, transport, surface, build, fingerprint, created_at, last_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, content.text, type, source, about, task.text,
      parts.some((v) => HIDDEN_RE.test(rawText(v))) ? 1 : 0, content.masked || task.masked ? 1 : 0,
      workspace, reporter, client, appLabel(who.clientVersion, 40), appLabel(who.protocolVersion, 40),
      appLabel(who.transport, 12), appLabel(who.surface, 12), appLabel(this.build, 60), fingerprint, at, at,
    );
    this._prune();
    return { status: 'received', id };
  }

  _prune() {
    const db = this._db();
    db.prepare('DELETE FROM reports WHERE last_at < ?')
      .run(new Date(this.now() - this.limits.keepDays * 86_400_000).toISOString());
    db.prepare('DELETE FROM reports WHERE id NOT IN (SELECT id FROM reports ORDER BY last_at DESC, rowid DESC LIMIT ?)')
      .run(this.limits.keepRows);
  }

  /** May an agent ask its user now if agents may send feedback? Only once in a while: no answer is no yes. */
  mayAsk(workspaceId) {
    const db = this._db();
    const workspace = this._workspaceTag(workspaceId);
    const last = db.prepare('SELECT at FROM asked WHERE workspace = ?').get(workspace)?.at;
    if (last && this.now() - Date.parse(last) < this.limits.askAgainDays * 86_400_000) return false;
    db.prepare('INSERT INTO asked (workspace, at) VALUES (?, ?) ON CONFLICT(workspace) DO UPDATE SET at = excluded.at')
      .run(workspace, new Date(this.now()).toISOString());
    return true;
  }

  /** The owner wants to be asked, so the next agent may do it at once. */
  askAgain(workspaceId) {
    if (this.exists()) this._db().prepare('DELETE FROM asked WHERE workspace = ?').run(this._workspaceTag(workspaceId));
  }

  /** What agents of one workspace sent, for its own Settings page. */
  ownReports(workspaceId, { limit = 50 } = {}) {
    if (!this.exists()) return [];
    return this._db()
      .prepare('SELECT * FROM reports WHERE workspace = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(this._workspaceTag(workspaceId), Math.max(1, Math.min(Number(limit) || 50, 200)))
      .map((row) => ({
        id: row.id,
        content: row.content,
        type: row.type,
        source: row.source,
        about: row.about,
        task: row.task,
        client: row.client,
        times: row.times,
        createdAt: row.created_at,
      }));
  }

  removeOwnReport(workspaceId, id) {
    if (!this.exists()) return false;
    const res = this._db()
      .prepare('DELETE FROM reports WHERE workspace = ? AND id = ?')
      .run(this._workspaceTag(workspaceId), String(id || ''));
    return Number(res.changes) > 0;
  }

  /* -------- For the operator (scripts/feedback.mjs), never over MCP or HTTP -------- */

  /** A closed account: all its reports go. Returns how many. */
  removeWorkspace(workspaceId) {
    if (!this.exists()) return 0;
    this.askAgain(workspaceId);
    return Number(this._db().prepare('DELETE FROM reports WHERE workspace = ?').run(this._workspaceTag(workspaceId)).changes);
  }

  reports({ status = '', issue = '', limit = 1000 } = {}) {
    if (!this.exists()) return [];
    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (issue) { where.push('issue = ?'); params.push(issue); }
    return this._db()
      .prepare(`SELECT * FROM reports ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, rowid LIMIT ?`)
      .all(...params, Math.max(1, Math.min(Number(limit) || 1000, 10_000)))
      .map(rowToReport);
  }

  setReport(id, { status, reason = '', issue = '' }) {
    if (!REPORT_STATUSES.includes(status)) throw new Error(`Unknown report status "${status}".`);
    // Back to new: a person read it, so the hidden characters that were in it hold it no longer.
    const res = this._db()
      .prepare('UPDATE reports SET status = ?, reason = ?, issue = ?, hidden = CASE WHEN ? THEN 0 ELSE hidden END WHERE id = ?')
      .run(status, oneLine(reason, 160), issue, status === 'new' ? 1 : 0, String(id));
    return Number(res.changes) > 0;
  }

  issues({ status = '' } = {}) {
    if (!this.exists()) return [];
    const rows = status
      ? this._db().prepare('SELECT * FROM issues WHERE status = ? ORDER BY created_at').all(status)
      : this._db().prepare('SELECT * FROM issues ORDER BY created_at').all();
    return rows.map(rowToIssue);
  }

  issue(id) {
    if (!this.exists()) return null;
    const row = this._db().prepare('SELECT * FROM issues WHERE id = ?').get(String(id || ''));
    return row ? rowToIssue(row) : null;
  }

  addIssue({ title, type = '', area = '', severity = 'low', problems = [] }) {
    const id = `iss_${randomBytes(4).toString('hex')}`;
    const at = new Date(this.now()).toISOString();
    this._db()
      .prepare('INSERT INTO issues (id, title, type, area, severity, problems, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, title, type, area, severity, JSON.stringify(problems), at, at);
    return this.issue(id);
  }

  updateIssue(id, patch) {
    const now = this.issue(id);
    if (!now) return null;
    const next = { ...now, ...patch };
    if (!ISSUE_STATUSES.includes(next.status)) throw new Error(`Unknown issue status "${next.status}".`);
    this._db()
      .prepare('UPDATE issues SET title = ?, type = ?, area = ?, severity = ?, status = ?, problems = ?, review = ?, pushed_to = ?, returned = ?, updated_at = ? WHERE id = ?')
      .run(
        next.title, next.type, next.area, next.severity, next.status, JSON.stringify(next.problems),
        next.review ? JSON.stringify(next.review) : '', next.pushedTo, next.returned ? 1 : 0,
        new Date(this.now()).toISOString(), now.id,
      );
    return this.issue(id);
  }

  exportReports() {
    return this.exists() ? { server: this._meta('server-id', 8), reports: this.reports({ limit: 10_000 }) } : { server: '', reports: [] };
  }

  /**
   * Takes in the export of another server. A report that is here already keeps its state, and one that
   * was deleted there is deleted here too. Returns { added, removed }.
   */
  importReports({ server, reports: rows } = {}) {
    if (!/^[0-9a-f]{16}$/.test(String(server)) || !Array.isArray(rows)) throw new Error('This is not an export of agent feedback.');
    const db = this._db();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO reports (
        id, content, type, source, about, task, hidden, masked, workspace, reporter, client, client_version,
        protocol_version, transport, surface, build, fingerprint, times, origin, created_at, last_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let added = 0;
    let removed = 0;
    const there = new Set(rows.map((r) => r?.id));
    for (const { id } of db.prepare('SELECT id FROM reports WHERE origin = ?').all(server)) {
      if (!there.has(id)) removed += Number(db.prepare('DELETE FROM reports WHERE id = ?').run(id).changes);
    }
    for (const r of rows) {
      const content = cleanFeedbackText(r?.content, this.limits.content);
      const at = Date.parse(r?.createdAt);
      if (!content.text || !/^fb_[0-9a-f]{12}$/.test(String(r?.id)) || !Number.isFinite(at)) continue;
      const last = Date.parse(r.lastAt);
      const tag = (v) => (/^[0-9a-f]{16}$/.test(String(v)) ? String(v) : this._tag(`import\n${v}`));
      const res = insert.run(
        r.id, content.text, choice(r.type, FEEDBACK_TYPES, ''), choice(r.source, FEEDBACK_SOURCES, 'model'),
        oneLine(r.about, this.limits.about), cleanFeedbackText(r.task, this.limits.task).text,
        r.hidden || content.hidden ? 1 : 0, r.masked || content.masked ? 1 : 0, tag(r.workspace), tag(r.reporter),
        appLabel(r.client, 60), appLabel(r.clientVersion, 40), appLabel(r.protocolVersion, 40), appLabel(r.transport, 12),
        appLabel(r.surface, 12), appLabel(r.build, 60), r.id, Math.max(1, Math.min(Number(r.times) || 1, 1000)), server,
        new Date(at).toISOString(), new Date(Number.isFinite(last) ? last : at).toISOString(),
      );
      added += Number(res.changes);
    }
    return { added, removed };
  }
}

/* ---------------- The tool ---------------- */

/** The operator can take feedback away from the whole server. */
export function feedbackIsAvailable(env = process.env) {
  return !['0', 'off', 'false', 'no'].includes(String(env.LOOP_AGENT_FEEDBACK || '').trim().toLowerCase());
}

/**
 * 'on', 'off' or 'ask': the choice of the owner. On a server where other people have a Loop somebody
 * else reads the reports, so there an owner who has not decided is asked before the first one.
 */
export function feedbackState(settings, { shared = false, env = process.env } = {}) {
  if (!feedbackIsAvailable(env)) return 'off';
  if (typeof settings?.agentFeedback === 'boolean') return settings.agentFeedback ? 'on' : 'off';
  return shared ? 'ask' : 'on';
}

const TURN_ON = '`loop__save({ type: "feedback", data: { enabled: true } })`';

const ANSWERS = {
  received: 'Feedback received. Thanks!',
  kept: 'Feedback received. It is kept in this Loop on this computer, for its owner, and goes to nobody else.',
  empty: 'Feedback not saved: `content` is required.',
  secret: 'Feedback not saved: it holds something that looks like a credential. Write it again in your own words, without pasted output, and send it once more.',
  ask: `Not sent: the user has not allowed it yet. At the end of your next message, ask one time: “May your agents send the team that runs this Loop server a short report when Loop itself fails? Reports are about Loop, not about your work. You can see and delete each one in Loop’s Settings.” After a yes, call ${TURN_ON} and send this report again with the same arguments. After a no, call it with \`enabled: false\`. Do not answer for the user. If the user’s next message does not answer, drop it: change nothing and do not ask again.`,
  wait: `Not sent: the user has not allowed it yet and was asked a short time ago. If the user just said yes, call ${TURN_ON} and send it again with the same arguments. If not, do not ask again, and go on with the user’s task.`,
  limit: 'Feedback not saved: this agent sent enough of it for now. Do not send more, and go on with the user’s task.',
  failed: 'Feedback not saved: Loop could not keep it. Do not send it again, and go on with the user’s task.',
};

/** What the agent reads. Only what it can correct is an error. */
export function feedbackAnswer(status, surface = '') {
  const text = status === 'received' && surface === 'local' ? ANSWERS.kept : ANSWERS[status];
  return { text: text || ANSWERS.failed, isError: status === 'empty' || status === 'secret' };
}

const STATES = {
  on: 'Agent feedback is on: agents may send short reports about faults of Loop to the team that runs this Loop server. The user can see and delete each one in Loop’s Settings.',
  kept: 'Agent feedback is on: agents may report faults of Loop. The reports stay in this Loop on this computer.',
  ask: 'Agent feedback is not decided: an agent asks the user before it sends the first report about Loop.',
  off: 'Agent feedback is off: agents send no reports about Loop and do not ask. What they sent stays until the user deletes it in Loop’s Settings.',
};

/** What an agent reads after it turned feedback on or off for the user, or asked how it is. */
export function feedbackStateText(state, { shared = false } = {}) {
  return `${state === 'on' && !shared ? STATES.kept : STATES[state]} To change it as the user says: \`loop__save({ type: "feedback", data: { enabled: true | false } })\`.`;
}

/** An error of Loop's own code or storage, and not an answer that Loop gives on purpose. */
export function isLoopFault(err) {
  if (err?.message === 'fetch failed') return false;
  return ['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError'].includes(err?.name) || err?.code === 'ERR_SQLITE_ERROR';
}

// Small models forget the first instruction when they find another way, but not what the error says.
export const FAULT_HINT = `This looks like a fault of Loop. When the task is done, report it once with \`${FEEDBACK_TOOL}\`.`;

/** Which Loop this is, so that a report can be matched with a release. */
export function loopBuild(root, env = process.env) {
  if (env.LOOP_BUILD) return String(env.LOOP_BUILD).slice(0, 60);
  const read = (file) => {
    try { return readFileSync(path.join(root, file), 'utf8').trim(); } catch { return ''; }
  };
  const release = read('RELEASE');
  if (release) return release.split(/\s+/)[0];
  const head = read('.git/HEAD');
  const ref = /^ref: (\S+)$/.exec(head)?.[1];
  const sha = ref ? read(`.git/${ref}`) : head;
  if (/^[0-9a-f]{40}$/.test(sha)) return `git ${sha.slice(0, 12)}`;
  try { return `v${JSON.parse(read('package.json')).version}`; } catch { return ''; }
}
