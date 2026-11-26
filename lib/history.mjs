// Loop cross-channel conversation history store (`history.json` per workspace).
//
// Channels (SMS/iMessage via loop-text, web chat, CLI hooks) push compact, secret-redacted
// finished turns here so any connected agent can recall past conversations across compactions
// via `loop__search({ type: "history", query })` and sleep-time dreaming / Context Doctor can
// inspect raw workspace transcripts without tying state to a single runtime like Pi.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { atomicWriteFile, createWriteQueue, readJsonWithBackup } from './json-file-store.mjs';
import { looksLikeSecret } from './memory.mjs';
import { defaultDataDir } from './vault.mjs';

const MAX_TURNS = 1000;
const MAX_TEXT_CHARS = 1200;
const MAX_ERRORS_PER_TURN = 4;
const INTERNAL_TURN_RE = /^\[(Automatic update|Scheduled task|Heartbeat check-in|Context handoff)/i;

function redactSecrets(raw) {
  const s = String(raw || '');
  if (!s) return '';
  if (looksLikeSecret(s)) return '[redacted text containing sensitive credential]';
  return s
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|loop_[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,})\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]');
}

function clip(raw, max = 320) {
  const clean = String(raw || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function normalizeTurn(raw, seq) {
  if (!raw || typeof raw !== 'object') return null;
  const rawUser = String(raw.user || raw.userText || '').trim();
  if (!rawUser || INTERNAL_TURN_RE.test(rawUser)) return null;
  const user = redactSecrets(rawUser).slice(0, MAX_TEXT_CHARS);
  const rawAssistant = String(raw.assistant || raw.assistantText || '').trim();
  const assistant = rawAssistant ? redactSecrets(rawAssistant).slice(0, MAX_TEXT_CHARS) : '';
  const channel = String(raw.channel || 'unknown').trim().toLowerCase().slice(0, 40) || 'unknown';
  const externalId = typeof raw.externalId === 'string' && raw.externalId.trim()
    ? raw.externalId.trim().slice(0, 120)
    : null;
  const tools = Array.isArray(raw.tools)
    ? [...new Set(raw.tools.map((t) => String(t || '').trim().slice(0, 80)).filter(Boolean))].slice(0, 8)
    : [];
  const toolErrors = Array.isArray(raw.toolErrors)
    ? raw.toolErrors
        .slice(0, MAX_ERRORS_PER_TURN)
        .map((e) => ({
          id: e?.id != null ? String(e.id).slice(0, 40) : null,
          tool: String(e?.tool || 'tool').trim().slice(0, 80),
          error: redactSecrets(String(e?.error || '').replace(/\s+/g, ' ').trim()).slice(0, 180),
        }))
        .filter((e) => e.tool)
    : [];

  return {
    id: `turn_${randomBytes(5).toString('hex')}`,
    seq,
    externalId,
    channel,
    agentId: typeof raw.agentId === 'string' && raw.agentId.trim() ? raw.agentId.trim().slice(0, 80) : null,
    agentName: typeof raw.agentName === 'string' && raw.agentName.trim() ? raw.agentName.trim().slice(0, 80) : null,
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId.trim() ? raw.sessionId.trim().slice(0, 120) : null,
    sentAt: typeof raw.sentAt === 'string' && raw.sentAt.trim() ? raw.sentAt.trim().slice(0, 80) : null,
    at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : Date.now(),
    user,
    assistant,
    tools,
    toolErrors,
  };
}

export class HistoryStore {
  constructor(dir = defaultDataDir()) {
    this.dir = dir;
    this.file = path.resolve(dir, 'history.json');
    this._lock = createWriteQueue();
  }

  async _load() {
    const { data } = await readJsonWithBackup(this.file, {
      validate: (d) => d && typeof d === 'object' && Array.isArray(d.turns),
    });
    if (!data) return { nextSeq: 1, turns: [] };
    const nextSeq = Number.isInteger(data.nextSeq) && data.nextSeq > 0
      ? data.nextSeq
      : (data.turns.reduce((m, t) => Math.max(m, Number(t?.seq) || 0), 0) + 1);
    return { nextSeq, turns: data.turns };
  }

  async _save(state) {
    await atomicWriteFile(this.file, JSON.stringify(state, null, 2), { mode: 0o600, backup: true });
  }

  async append(turn) {
    const res = await this.appendBatch([turn]);
    return res[0] || null;
  }

  async appendBatch(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return [];
    return this._lock(async () => {
      const state = await this._load();
      const seenExternal = new Set(state.turns.map((t) => t.externalId).filter(Boolean));
      const added = [];
      for (const raw of list) {
        const ext = typeof raw?.externalId === 'string' && raw.externalId.trim() ? raw.externalId.trim() : null;
        if (ext && seenExternal.has(ext)) continue;
        const normalized = normalizeTurn(raw, state.nextSeq);
        if (!normalized) continue;
        state.nextSeq += 1;
        state.turns.push(normalized);
        if (ext) seenExternal.add(ext);
        added.push(normalized);
      }
      if (!added.length) return [];
      if (state.turns.length > MAX_TURNS) {
        state.turns = state.turns.slice(-MAX_TURNS);
      }
      await this._save(state);
      return added;
    });
  }

  async recent({ afterSeq = 0, channel = '', limit = 30 } = {}) {
    const cap = Math.max(1, Math.min(Number(limit) || 30, 200));
    const minSeq = Math.max(0, Number(afterSeq) || 0);
    const ch = String(channel || '').trim().toLowerCase();
    const state = await this._load();
    const filtered = state.turns.filter((t) => (Number(t.seq) || 0) > minSeq && (!ch || t.channel === ch));
    const lastSeq = filtered.length ? Number(filtered[filtered.length - 1].seq) || minSeq : minSeq;
    return {
      turns: filtered.slice(-cap),
      lastSeq,
      total: filtered.length,
    };
  }

  async search({ query = '', channel = '', limit = 8 } = {}) {
    const cap = Math.max(1, Math.min(Number(limit) || 8, 20));
    const ch = String(channel || '').trim().toLowerCase();
    const state = await this._load();
    const turns = ch ? state.turns.filter((t) => t.channel === ch) : state.turns;
    const q = String(query || '').trim().toLowerCase();

    if (!q) {
      const latest = turns.slice(-cap).reverse();
      return {
        query: '',
        totalMatches: turns.length,
        matches: latest.map((t) => ({
          id: t.id,
          seq: t.seq,
          channel: t.channel,
          sentAt: t.sentAt || new Date(t.at).toISOString(),
          user: clip(t.user),
          assistant: clip(t.assistant),
        })),
      };
    }

    const terms = [...new Set(q.replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter((w) => w.length >= 2))];
    const scored = [];
    for (let i = 0; i < turns.length; i += 1) {
      const t = turns[i];
      const uLow = String(t.user || '').toLowerCase();
      const aLow = String(t.assistant || '').toLowerCase();
      let score = 0;
      if (uLow.includes(q)) score += 6;
      else if (aLow.includes(q)) score += 3;
      let matched = 0;
      for (const term of terms) {
        const inU = uLow.includes(term);
        const inA = aLow.includes(term);
        if (inU || inA) matched += 1;
        if (inU) score += 2;
        if (inA) score += 1;
      }
      if (score <= 0) continue;
      if (terms.length > 1) score += (matched / terms.length) * 2;
      scored.push({ t, score, idx: i });
    }
    scored.sort((a, b) => (b.score - a.score) || (b.idx - a.idx));
    return {
      query: String(query || '').trim(),
      totalMatches: scored.length,
      matches: scored.slice(0, cap).map(({ t }) => ({
        id: t.id,
        seq: t.seq,
        channel: t.channel,
        sentAt: t.sentAt || new Date(t.at).toISOString(),
        user: clip(t.user),
        assistant: clip(t.assistant),
      })),
    };
  }

  async clear({ channel = '' } = {}) {
    const ch = String(channel || '').trim().toLowerCase();
    return this._lock(async () => {
      const state = await this._load();
      state.turns = ch ? state.turns.filter((t) => t.channel !== ch) : [];
      await this._save(state);
    });
  }
}
