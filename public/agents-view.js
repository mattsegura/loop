// Agents tab (identities, tokens, permissions, activity) and the
// "Import from your agents" panel. Helpers are passed in from app.js.

import { mountContextGuide } from './system-skills.js';
import { confirmDialog } from './components/confirm-dialog.js';
import { KIND_LABELS, agentMark, kindLabel } from './agent-mark.js';

export { agentMark, kindLabel };

const DEFAULT_SNIPPET = {
  'claude-code': 'claude',
  codex: 'codex',
  'claude-desktop': 'stdio',
};

const SNIPPET_TABS_LOCAL = [
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['json', 'JSON (Cursor, Antigravity…)'],
  ['stdio', 'Stdio bridge'],
];

const SNIPPET_TABS_PERSONAL = [
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['json', 'JSON (Claude Desktop, Cursor…)'],
];

export function resolveGatewayEndpoint(endpoint, port = null) {
  const raw = String(endpoint || '').trim();
  const fallbackPort = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : 8799;
  const fallbackOrigin =
    typeof location !== 'undefined' && location?.origin && location.origin !== 'null'
      ? location.origin
      : `http://127.0.0.1:${fallbackPort}`;
  if (raw) {
    try {
      const parsed = new URL(raw, fallbackOrigin);
      parsed.search = '';
      parsed.hash = '';
      return parsed.href;
    } catch {
      return raw.replace(/[?#].*$/, '');
    }
  }
  return new URL('/mcp', fallbackOrigin).href;
}

export function isPersonalWorkspace(data = {}, ui = null) {
  if (data?.personal === true || data?.workspace === 'personal' || data?.canImportLocal === false) {
    return true;
  }
  if (ui && typeof ui.canImportFromMac === 'function' && !ui.canImportFromMac()) {
    return true;
  }
  const raw = String(data?.endpoint || '').trim();
  if (raw) {
    try {
      const pathname = new URL(raw, 'http://127.0.0.1').pathname;
      if (/^\/w\/[^/]+\/mcp\/?$/i.test(pathname)) return true;
    } catch {
      if (/\/w\/[^/?#]+\/mcp(?:$|[/?#])/i.test(raw)) return true;
    }
  }
  return false;
}

export function snippetTabsFor(data = {}, ui = null) {
  return isPersonalWorkspace(data, ui) ? SNIPPET_TABS_PERSONAL : SNIPPET_TABS_LOCAL;
}

export function defaultSnippetTab(kind, data = {}, ui = null) {
  if (isPersonalWorkspace(data, ui)) {
    if (kind === 'claude-code') return 'claude';
    if (kind === 'codex') return 'codex';
    return 'json';
  }
  return DEFAULT_SNIPPET[kind] || 'json';
}

const state = {
  open: null, // the expanded row: an agent id, `app:<key>` for an app without a key, or 'new'
  prefill: null, // { name, kind } for "Add a key" from an app's row
  justCreated: null, // { id, token }
  openConnect: new Map(), // agentId -> { tab, token }
  importSelected: new Set(),
  sms: {
    linkCode: null,
    brainTab: null, // 'default' | 'byo_key' | 'cli_oauth'
    oauthPending: null,
    generatingCode: false,
    savingBrain: false,
    startingOAuth: false,
    disconnecting: false,
    byoVaultKey: null,
    byoProvider: null,
    byoModel: null,
    tracesOpen: false,
    tracesLoading: false,
    tracesError: null,
    tracesErrorsOnly: false,
    tracesLimit: 20,
    tracesUpdatedAt: '',
    traces: null, // { turns, promptVersion, convo }
    expandedTurns: new Set(),
  },
};

let smsPollTimer = null;

function stopSmsOAuthPoll() {
  if (smsPollTimer) {
    clearInterval(smsPollTimer);
    smsPollTimer = null;
  }
}

function defaultEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function safeHref(raw, allowedProtocols, allowRelative = false) {
  const str = String(raw || '').trim();
  if (!str) return '';
  if (allowRelative && str.startsWith('/') && !str.startsWith('//')) return str;
  try {
    const parsed = new URL(str);
    if (allowedProtocols.includes(parsed.protocol)) return parsed.href;
  } catch {
    return '';
  }
  return '';
}

function sandboxBadge(sandboxState) {
  if (sandboxState === 'ready') return ['ok', 'Ready'];
  if (sandboxState === 'provisioning') return ['warn', 'Setting up…'];
  return ['muted', 'Sleeping'];
}

function cliProviderLabel(provider, mode) {
  if (provider === 'codex' || mode === 'codex_oauth') return 'Codex';
  if (provider === 'claude' || mode === 'claude_oauth') return 'Claude';
  return 'CLI';
}

function resolveSmsBrainTab(brain, smsState) {
  if (smsState?.brainTab === 'default' || smsState?.brainTab === 'byo_key' || smsState?.brainTab === 'cli_oauth') {
    return smsState.brainTab;
  }
  const mode = brain?.mode || 'default';
  if (mode === 'byo_key') return 'byo_key';
  if (mode === 'claude_oauth' || mode === 'codex_oauth') return 'cli_oauth';
  return 'default';
}

function renderSmsInviteBar(invite, esc) {
  if (!invite || typeof invite !== 'object') return '';
  const inviteUrl = safeHref(invite.inviteUrl, ['https:', 'http:'], false);
  if (!inviteUrl) return '';
  const quota = Number.isFinite(Number(invite.quota)) && Number(invite.quota) > 0
    ? Math.floor(Number(invite.quota))
    : 5;
  const used = Number.isFinite(Number(invite.used)) ? Math.max(0, Math.floor(Number(invite.used))) : 0;
  const remaining = Number.isFinite(Number(invite.remaining))
    ? Math.max(0, Math.floor(Number(invite.remaining)))
    : Math.max(0, quota - used);
  const displayUrl = inviteUrl.replace(/^https?:\/\//i, '');
  const shareMessage = String(invite.shareMessage || '').trim() || inviteUrl;
  return `
    <div class="sms-agent-invite" data-sms-invite>
      <div class="sms-agent-invite-head">
        <span class="sms-agent-invite-title">Invite friends</span>
        <span class="sms-agent-invite-count" data-sms-invite-count>${esc(remaining)} of ${esc(quota)} invites left</span>
      </div>
      <div class="sms-agent-copy-row sms-agent-invite-row">
        <code class="sms-agent-code sms-agent-invite-url" data-sms-invite-url>${esc(displayUrl)}</code>
        <div class="sms-agent-invite-acts">
          <button type="button" class="btn sm" data-sms-copy-invite-url="${esc(inviteUrl)}">Copy link</button>
          <button type="button" class="btn sm" data-sms-copy-invite-msg="${esc(shareMessage)}">Copy message</button>
        </div>
      </div>
    </div>
  `;
}

function fmtTraceMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

// A tool's id like "mcp__loop__loop__search" reads as "loop search".
function traceToolLabel(name) {
  const parts = String(name || 'tool').split('__').filter((p) => p && p !== 'mcp');
  const words = parts.filter((p, i) => p !== parts[i - 1]).join(' ').replace(/[_-]+/g, ' ').trim();
  return words || 'tool';
}

// Simple inputs read as "key: value · key: value"; anything nested stays JSON.
function traceArgs(raw) {
  let v;
  try { v = JSON.parse(raw); } catch { return { text: String(raw || '').trim(), block: true }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { text: JSON.stringify(v), block: false };
  const entries = Object.entries(v);
  if (!entries.length) return { text: '', block: false };
  if (entries.every(([, x]) => x == null || typeof x !== 'object')) {
    return { text: entries.map(([k, x]) => `${k}: ${String(x).length > 120 ? `${String(x).slice(0, 120)}…` : x}`).join(' · '), block: false };
  }
  return { text: JSON.stringify(v, null, 2), block: true };
}

function firstLine(s, max = 110) {
  const line = String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// A failed tool's output as one plain line: markup wrappers and "[error]" dropped, JSON read as its message
// or its first few top-level facts.
function plainError(out) {
  const text = String(out || '').split('\n').filter((l) => !/^\s*<\/?[\w-]+>\s*$/.test(l)).join('\n')
    .replace(/^\s*\[error\]\s*/i, '').trim();
  const facts = (pairs) => pairs.slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(' · ');
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const msg = [v.error, v.message].find((x) => typeof x === 'string' && x.trim());
      if (msg) return firstLine(msg, 240);
      const pairs = Object.entries(v).filter(([, x]) => x == null || typeof x !== 'object');
      if (pairs.length) return facts(pairs);
    }
  } catch {
    const pairs = [...text.matchAll(/^ {2}"([^"]+)":\s*("[^"\n]*"|-?\d[\d.]*|true|false|null),?$/gm)].map((m) => [m[1], m[2].replace(/^"|"$/g, '')]);
    if (pairs.length) return facts(pairs);
  }
  return firstLine(text, 240);
}

// One readable timeline per turn: thoughts, each tool with its own result, replies, errors.
export function traceTimeline(t) {
  const results = new Map();
  for (const s of t.steps || []) if (s.kind === 'tool' && s.toolCallId) results.set(s.toolCallId, s);
  const used = new Set();
  const items = [];
  for (const s of t.steps || []) {
    if (s.kind === 'model') {
      for (const th of s.thinking || []) items.push({ kind: 'thought', label: 'Thought', detail: th, ms: s.durationMs });
      for (const tc of s.toolCalls || []) {
        const r = tc.id ? results.get(tc.id) : null;
        if (r) used.add(r);
        items.push({ kind: r?.isError ? 'error' : 'tool', label: traceToolLabel(tc.name), args: traceArgs(tc.arguments), result: r, ms: r?.durationMs });
      }
      if (s.text) items.push({ kind: 'reply', label: 'Replied', detail: s.text });
      if (s.errorMessage || (s.isError && !s.text && !(s.toolCalls || []).length)) {
        items.push({ kind: 'error', label: 'Model error', detail: s.errorMessage || s.stopReason || 'The model stopped early.' });
      }
    } else if (s.kind === 'tool' && !used.has(s)) {
      items.push({ kind: s.isError ? 'error' : 'tool', label: traceToolLabel(s.toolName), result: s, ms: s.durationMs });
    }
  }
  const finalReply = String(t?.finalText || '').trim();
  if (finalReply && !items.some((i) => i.kind === 'reply' && String(i.detail || '').trim() === finalReply)) {
    items.push({ kind: 'reply', label: 'Replied', detail: finalReply });
  }
  return items;
}

export function traceSummary(t, items = traceTimeline(t)) {
  const err = items.find((i) => i.kind === 'error');
  if (err) return (err.result ? plainError(err.result.output) : firstLine(err.detail)) || 'Stopped with an error';
  const lastReply = [...items].reverse().find((i) => i.kind === 'reply' && String(i.detail || '').trim());
  const replyText = String(t?.finalText || '').trim() || String(lastReply?.detail || '').trim();
  if (replyText) return firstLine(replyText);
  const tools = items.filter((i) => i.kind === 'tool').length;
  return tools ? `Used ${tools} tool${tools === 1 ? '' : 's'}, no reply` : 'No reply';
}

function traceWhen(t) {
  const d = t.startedAt ? new Date(t.startedAt) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function renderTraceStep(it, last, esc) {
  const ms = fmtTraceMs(it.ms);
  const out = it.result ? `${it.result.output || '(empty)'}${it.result.truncated ? '\n…' : ''}` : '';
  const detail = it.args
    ? (it.args.text ? (it.args.block ? `<pre class="tr-code">${esc(it.args.text)}</pre>` : `<div class="tr-d tr-mono">${esc(it.args.text)}</div>`) : '')
    : (it.detail ? `<div class="tr-d">${esc(it.detail)}</div>` : '');
  const errLine = it.kind === 'error' && it.result ? `<div class="tr-d">${esc(plainError(it.result.output) || 'The tool failed.')}</div>` : '';
  return `
    <li class="tr-step" data-kind="${it.kind}" data-last="${last ? 'yes' : 'no'}">
      <span class="tr-rail" aria-hidden="true"><span class="tr-node"></span></span>
      <div class="tr-c">
        <div class="tr-h"><span class="tr-lbl">${esc(it.label)}</span>${ms ? `<span class="tr-m">${esc(ms)}</span>` : ''}</div>
        ${detail}${errLine}
        ${out ? `<details class="tr-more"><summary>Show result</summary><pre class="tr-code">${esc(out)}</pre></details>` : ''}
      </div>
    </li>`;
}

function renderSmsDreamSection(dream, smsState, esc) {
  if (!dream || typeof dream !== 'object') return '';
  const serverOn = dream.serverEnabled !== false;
  const userOn = dream.enabled !== false;
  const saving = Boolean(smsState.savingDream);
  const running = Boolean(smsState.runningDream);
  const doctoring = Boolean(smsState.runningDoctor);
  const doctorReport = smsState.doctorReport || null;
  const triggerMode = ['both', 'steps', 'compaction'].includes(dream.triggerMode) ? dream.triggerMode : 'both';
  const stepInterval = Number(dream.stepInterval) || 8;
  const reviewBeforeApply = dream.reviewBeforeApply !== false;
  const applyMode = dream.applyMode === 'auto' ? 'auto' : 'propose';
  const proposals = Array.isArray(dream.pendingProposals) ? dream.pendingProposals : [];

  let tagCls = 'ok';
  let tagLabel = 'On';
  if (!serverOn) {
    tagCls = 'muted';
    tagLabel = 'Off on server';
  } else if (!userOn) {
    tagCls = 'muted';
    tagLabel = 'Off';
  }

  let hint;
  if (!serverOn) {
    hint = 'Set SLEEPTIME_ENABLED=1 on Loop Text to turn on background sleep-time memory review.';
  } else if (!userOn) {
    hint = 'Sleep-time memory review is off. Turn it on here or text DREAM ON.';
  } else {
    const when = triggerMode === 'steps'
      ? `after every ${stepInterval} turns`
      : triggerMode === 'compaction'
        ? 'when context compacts'
        : `after every ${stepInterval} turns or context compaction`;
    hint = `Reviews recent iMessage transcripts ${when} without interrupting active chats.`;
  }

  return `
    <div class="sms-agent-dream" data-sms-dream>
      <div class="sms-agent-hb-head">
        <div class="sms-agent-hb-title">
          <span class="lbl">Sleep-time memory review</span>
          <span class="tag ${tagCls}" data-sms-dream-badge>${esc(tagLabel)}</span>
          ${proposals.length ? `<span class="tag warn" data-sms-dream-pending-count>${esc(proposals.length)} to review</span>` : ''}
        </div>
        <div class="sms-agent-hb-acts">
          <button type="button" class="btn sm" data-sms-dream-doctor ${doctoring || saving ? 'disabled' : ''}>${doctoring ? 'Checking…' : 'Run doctor'}</button>
          ${serverOn ? `<button type="button" class="btn sm" data-sms-dream-run ${running || saving ? 'disabled' : ''}>${running ? 'Reviewing…' : 'Run now'}</button>` : ''}
          ${userOn
            ? `<button type="button" class="btn sm" data-sms-dream-toggle="off" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Turn off'}</button>`
            : `<button type="button" class="btn sm fill" data-sms-dream-toggle="on" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Turn on'}</button>`}
        </div>
      </div>
      <p class="hint sms-agent-hb-hint">${esc(hint)}</p>
      ${doctorReport ? `
        <div class="callout ${doctorReport.healthy ? '' : 'warn'}" data-sms-dream-doctor-report>
          <p>${esc(doctorReport.summaryText || '')}</p>
        </div>
      ` : ''}
      <form class="form-grid sms-agent-dream-form" data-sms-dream-form>
        <div class="form-row">
          <label class="field">
            <span class="lbl">When to run</span>
            <select name="triggerMode" ${saving ? 'disabled' : ''}>
              <option value="both" ${triggerMode === 'both' ? 'selected' : ''}>Every N turns &amp; compaction</option>
              <option value="steps" ${triggerMode === 'steps' ? 'selected' : ''}>Every N turns only</option>
              <option value="compaction" ${triggerMode === 'compaction' ? 'selected' : ''}>On compaction only</option>
            </select>
          </label>
          <label class="field">
            <span class="lbl">Turns between runs</span>
            <input type="number" name="stepInterval" min="3" max="50" value="${esc(stepInterval)}" ${saving || triggerMode === 'compaction' ? 'disabled' : ''}>
          </label>
          <label class="field">
            <span class="lbl">Updates</span>
            <select name="applyMode" ${saving ? 'disabled' : ''}>
              <option value="propose" ${applyMode === 'propose' ? 'selected' : ''}>Review proposals first</option>
              <option value="auto" ${applyMode === 'auto' ? 'selected' : ''}>Auto-save safe updates</option>
            </select>
          </label>
        </div>
        <label class="mem-ed-check sms-agent-dream-check">
          <input type="checkbox" name="reviewBeforeApply" ${reviewBeforeApply ? 'checked' : ''} ${saving ? 'disabled' : ''}>
          <span>Agent reviews before applying (second background pass to critique and trim drafts)</span>
        </label>
        <div class="acts">
          <button type="submit" class="btn sm" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save dream settings'}</button>
        </div>
      </form>
      ${proposals.length ? `
        <div class="sms-agent-dream-queue" data-sms-dream-queue>
          <div class="sms-agent-dream-qhead">
            <span class="lbl">Proposed memory &amp; skill updates (${esc(proposals.length)})</span>
            <div class="sms-agent-hb-acts">
              <button type="button" class="btn sm fill" data-sms-dream-all="approve" ${saving ? 'disabled' : ''}>Save all</button>
              <button type="button" class="btn sm" data-sms-dream-all="dismiss" ${saving ? 'disabled' : ''}>Dismiss all</button>
            </div>
          </div>
          <ul class="sms-agent-dream-list">
            ${proposals.map((p) => {
              const safeApprove = safeHref(p.approvalUrl, ['https:', 'http:'], false);
              const isSkill = p.kind === 'skill' || p.action === 'skill';
              const actionBadge = isSkill ? (p.existingSkillId ? 'Update skill' : 'New skill') : (p.action === 'supersede' ? 'Update' : 'New');
              return `
                <li class="sms-agent-dream-item" data-sms-dream-proposal="${esc(p.id)}">
                  <div class="sms-agent-dream-copy">
                    <div class="sms-agent-dream-meta">
                      <span class="tag ${isSkill ? 'ok' : 'muted'}">${esc(actionBadge)}</span>
                      ${p.category ? `<span class="tag muted">${esc(p.category)}</span>` : ''}
                      ${!isSkill ? `<span class="tag muted">${esc(p.scope || 'fact')}</span>` : ''}
                      <span class="mono">${esc(p.name || p.key || '')}</span>
                    </div>
                    ${isSkill && p.description ? `<p class="hint sms-agent-dream-ev">${esc(p.description)}</p>` : ''}
                    <p class="sms-agent-dream-text">${esc(p.content || '')}</p>
                    ${p.evidence ? `<p class="hint sms-agent-dream-ev">From chat: “${esc(p.evidence)}”</p>` : ''}
                    ${safeApprove ? `<p class="hint"><a href="${esc(safeApprove)}" target="_blank" rel="noopener noreferrer">Approve in Loop</a></p>` : ''}
                  </div>
                  <div class="sms-agent-hb-acts">
                    <button type="button" class="btn sm fill" data-sms-dream-decide="approve" data-sms-dream-id="${esc(p.id)}" ${saving ? 'disabled' : ''}>Save</button>
                    <button type="button" class="btn sm" data-sms-dream-decide="dismiss" data-sms-dream-id="${esc(p.id)}" ${saving ? 'disabled' : ''}>Dismiss</button>
                  </div>
                </li>
              `;
            }).join('')}
          </ul>
        </div>
      ` : ''}
    </div>
  `;
}

function bindSmsDream(container, { sms, api, toast, repaint, isAlive }) {
  container.querySelectorAll('[data-sms-dream-toggle]').forEach((btn) => btn.addEventListener('click', async () => {
    const enabled = btn.dataset.smsDreamToggle === 'on';
    state.sms.savingDream = true;
    repaint();
    try {
      const res = await api('/api/sms-agent/dream', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      });
      if (!isAlive()) return;
      if (sms.status && res?.dream) sms.status.dream = res.dream;
      toast(enabled ? 'Sleep-time memory review turned on.' : 'Sleep-time memory review turned off.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      state.sms.savingDream = false;
      if (isAlive()) repaint();
    }
  }));

  container.querySelector('[data-sms-dream-form]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const triggerMode = String(fd.get('triggerMode') || 'both');
    const stepInterval = Math.max(3, Math.min(50, Math.round(Number(fd.get('stepInterval')) || 8)));
    const applyMode = String(fd.get('applyMode') || 'propose');
    const reviewBeforeApply = Boolean(e.currentTarget.querySelector('input[name="reviewBeforeApply"]')?.checked);
    state.sms.savingDream = true;
    repaint();
    try {
      const res = await api('/api/sms-agent/dream', {
        method: 'POST',
        body: JSON.stringify({ triggerMode, stepInterval, applyMode, reviewBeforeApply }),
      });
      if (!isAlive()) return;
      if (sms.status && res?.dream) sms.status.dream = res.dream;
      toast('Saved dream settings.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      state.sms.savingDream = false;
      if (isAlive()) repaint();
    }
  });

  container.querySelector('[data-sms-dream-doctor]')?.addEventListener('click', async () => {
    state.sms.runningDoctor = true;
    repaint();
    try {
      const res = await api('/api/sms-agent/dream/doctor', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!isAlive()) return;
      state.sms.doctorReport = res;
      toast(res?.healthy ? 'Context doctor: looks healthy.' : 'Context doctor found items to review.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      state.sms.runningDoctor = false;
      if (isAlive()) repaint();
    }
  });

  container.querySelector('[data-sms-dream-run]')?.addEventListener('click', async () => {
    state.sms.runningDream = true;
    repaint();
    try {
      const res = await api('/api/sms-agent/dream/run', {
        method: 'POST',
        body: JSON.stringify({ force: true }),
      });
      if (!isAlive()) return;
      if (sms.status && res?.dream) sms.status.dream = res.dream;
      if (res?.reviewedTurns === 0) toast('No new conversation turns to review yet.', 'ok');
      else if (res?.savedCount) toast(`Saved ${res.savedCount} durable memory update${res.savedCount === 1 ? '' : 's'}.`, 'ok');
      else if (res?.queuedCount) toast(`Queued ${res.queuedCount} memory proposal${res.queuedCount === 1 ? '' : 's'} for review.`, 'ok');
      else toast('Reviewed recent chats — nothing new to save.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      state.sms.runningDream = false;
      if (isAlive()) repaint();
    }
  });

  const decide = async ({ id = '', decision, all = false }) => {
    state.sms.savingDream = true;
    repaint();
    try {
      const res = await api('/api/sms-agent/dream/proposals', {
        method: 'POST',
        body: JSON.stringify({ ...(id ? { id } : {}), decision, all }),
      });
      if (!isAlive()) return;
      if (sms.status && res?.dream) sms.status.dream = res.dream;
      if (decision === 'dismiss') toast('Dismissed memory proposal.', 'ok');
      else if (res?.applied) toast(`Saved ${res.applied} memory update${res.applied === 1 ? '' : 's'} to Loop.`, 'ok');
      else if (res?.approvals?.length) toast('Approval needed in Loop before saving.', 'ok');
      else toast(res?.errors?.[0]?.error || 'Could not save proposal.', 'err');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      state.sms.savingDream = false;
      if (isAlive()) repaint();
    }
  };

  container.querySelectorAll('[data-sms-dream-decide]').forEach((btn) => btn.addEventListener('click', () => {
    decide({ id: btn.dataset.smsDreamId, decision: btn.dataset.smsDreamDecide });
  }));

  container.querySelectorAll('[data-sms-dream-all]').forEach((btn) => btn.addEventListener('click', () => {
    decide({ decision: btn.dataset.smsDreamAll, all: true });
  }));
}

function renderSmsTracesSection(smsState, esc) {
  const open = Boolean(smsState.tracesOpen);
  const loading = Boolean(smsState.tracesLoading);
  const errorsOnly = Boolean(smsState.tracesErrorsOnly);
  const allTurns = Array.isArray(smsState.traces?.turns) ? smsState.traces.turns : [];
  const turns = errorsOnly ? allTurns.filter((t) => t.hasError) : allTurns;
  const expanded = smsState.expandedTurns instanceof Set ? smsState.expandedTurns : new Set();
  const errCount = allTurns.filter((t) => t.hasError).length;
  const traceLimit = Number(smsState.tracesLimit) || 20;
  const mayHaveMore = allTurns.length >= traceLimit && traceLimit < 200;
  const updatedBit = smsState.tracesUpdatedAt ? ` · Updated ${new Date(smsState.tracesUpdatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';

  return `
    <div class="sms-agent-traces" data-sms-traces>
      <div class="sms-agent-traces-head">
        <button type="button" class="btn sm" data-sms-toggle-traces aria-expanded="${open}">
          ${open ? 'Hide traces' : 'Show traces'}
        </button>
        ${open ? `
          <div class="tr-acts">
            <button type="button" class="tr-link" data-sms-traces-errors aria-pressed="${errorsOnly}">Only errors</button>
            <button type="button" class="tr-link" data-sms-traces-refresh ${loading ? 'disabled' : ''}>${loading ? 'Loading…' : 'Refresh'}</button>
          </div>
        ` : ''}
      </div>
      ${open ? `
        <div class="tr-body">
          ${smsState.tracesError ? `<div class="callout bad">${esc(smsState.tracesError)}</div>` : ''}
          ${allTurns.length ? `<p class="tr-count">${esc(allTurns.length)} most recent · ${errCount ? `${esc(errCount)} had an error` : 'no errors'}${esc(updatedBit)}</p>` : ''}
          ${loading && !allTurns.length ? `<p class="tr-empty">Loading recent texts…</p>` : ''}
          ${!loading && !smsState.tracesError && !turns.length ? `
            <p class="tr-empty">${errorsOnly ? 'No errors in recent texts.' : 'Nothing yet. Text your agent, then refresh.'}</p>
          ` : ''}
          <ul class="tr-list">
          ${turns.map((t) => {
            const isOpen = expanded.has(t.id);
            const items = traceTimeline(t);
            const meta = [traceWhen(t), fmtTraceMs(t.totalDurationMs)].filter(Boolean).join(' · ');
            return `
              <li class="tr-turn" data-status="${t.hasError ? 'error' : 'ok'}" data-sms-trace-turn="${esc(t.id)}">
                <button type="button" class="tr-row" data-sms-toggle-turn="${esc(t.id)}" aria-expanded="${isOpen}">
                  <span class="tr-dot" aria-hidden="true"></span>
                  <span class="tr-body-txt">
                    <span class="tr-q">${esc(t.userText || '(empty)')}</span>
                    <span class="tr-sum">${esc(traceSummary(t, items))}</span>
                  </span>
                  <span class="tr-meta">${esc(meta)}</span>
                  <svg class="tr-chev" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
                ${isOpen ? `
                  <div class="tr-detail">
                    ${t.resetBefore ? `<p class="tr-note">Started a fresh conversation before this text.</p>` : ''}
                    <ol class="tr-steps">${items.map((it, i) => renderTraceStep(it, i === items.length - 1, esc)).join('')}</ol>
                    <div class="tr-foot">
                      ${t.sentAt ? `<span>${esc(t.sentAt)}</span>` : ''}
                      ${t.usage?.cacheHitPct != null ? `<span>${esc(t.usage.cacheHitPct)}% from cache</span>` : ''}
                      <button type="button" class="tr-link" data-sms-copy-trace="${esc(t.id)}">Copy JSON</button>
                    </div>
                  </div>
                ` : ''}
              </li>
            `;
          }).join('')}
          </ul>
          ${mayHaveMore ? `<div class="tr-foot"><button type="button" class="btn sm" data-sms-traces-more ${loading ? 'disabled' : ''}>${loading ? 'Loading…' : 'Load older traces'}</button></div>` : ''}
        </div>
      ` : ''}
    </div>
  `;
}

function bindSmsTraces(container, { api, toast, copyText, repaint, isAlive }) {
  async function loadTraces() {
    state.sms.tracesLoading = true;
    state.sms.tracesError = null;
    repaint();
    try {
      const lim = Math.min(200, Math.max(20, Number(state.sms.tracesLimit) || 20));
      const res = await api(`/api/sms-agent/traces?limit=${lim}`);
      if (!isAlive()) return;
      state.sms.traces = res;
      state.sms.tracesUpdatedAt = new Date().toISOString();
      if (state.sms.expandedTurns.size === 0 && Array.isArray(res?.turns) && res.turns.length > 0) {
        const firstErr = res.turns.find((t) => t.hasError);
        state.sms.expandedTurns.add((firstErr || res.turns[0]).id);
      }
    } catch (err) {
      if (!isAlive()) return;
      state.sms.tracesError = err.message || 'Could not load traces.';
    } finally {
      state.sms.tracesLoading = false;
      if (isAlive()) repaint();
    }
  }

  container.querySelector('[data-sms-toggle-traces]')?.addEventListener('click', () => {
    state.sms.tracesOpen = !state.sms.tracesOpen;
    if (state.sms.tracesOpen && !state.sms.traces) {
      loadTraces();
    } else {
      repaint();
    }
  });

  container.querySelector('[data-sms-traces-refresh]')?.addEventListener('click', () => {
    loadTraces();
  });

  container.querySelector('[data-sms-traces-more]')?.addEventListener('click', () => {
    state.sms.tracesLimit = Math.min(200, (Number(state.sms.tracesLimit) || 20) + 20);
    loadTraces();
  });

  container.querySelector('[data-sms-traces-errors]')?.addEventListener('click', () => {
    state.sms.tracesErrorsOnly = !state.sms.tracesErrorsOnly;
    repaint();
  });

  container.querySelectorAll('[data-sms-toggle-turn]').forEach((btn) => btn.addEventListener('click', () => {
    const id = Number(btn.dataset.smsToggleTurn);
    if (state.sms.expandedTurns.has(id)) state.sms.expandedTurns.delete(id);
    else state.sms.expandedTurns.add(id);
    repaint();
  }));

  container.querySelectorAll('[data-sms-copy-trace]').forEach((btn) => btn.addEventListener('click', () => {
    const id = Number(btn.dataset.smsCopyTrace);
    const turn = (state.sms.traces?.turns || []).find((t) => t.id === id);
    if (!turn) return;
    copyText(JSON.stringify(turn, null, 2), 'Copied turn trace JSON.');
  }));
}

export function renderSmsAgentCard(sms, smsState = {}, esc = defaultEsc) {
  if (!sms || !sms.enabled) return '';

  const status = sms.status || {};
  const linked = Boolean(status.linked);
  const icon = agentMark({ kind: 'imessage', name: 'Loop Agent' }, esc);
  const inviteBar = renderSmsInviteBar(sms.invite, esc);

  if (!linked) {
    const needsUserPhone = Boolean(sms.needsUserPhone || status.needsUserPhone);
    const savedUserPhone = String(smsState?.userPhone || '').trim();
    const billingUrl = safeHref(sms.billingUrl, ['http:', 'https:'], true) || '/?tab=settings&upgrade=1';
    const linkCode = smsState?.linkCode || null;
    const connectText = linkCode
      ? String(linkCode.smsBody || (linkCode.code ? `CONNECT-${linkCode.code}` : '')).trim()
      : '';
    const phone = String(linkCode?.phone || sms.phone || '').trim();
    const smsUri = safeHref(linkCode?.smsUri, ['sms:', 'imessage:', 'http:', 'https:'], false);

    return `
      <section class="card sms-agent-card" aria-label="Loop Agent on iMessage" data-sms-agent-card="unlinked">
        <div class="sms-agent-head">
          ${icon}
          <div class="sms-agent-copy">
            <h2 class="sms-agent-title">Loop Agent</h2>
            <p class="sms-agent-sub">Text your Loop agent from Messages. It can use your connections, skills and Vault.</p>
          </div>
        </div>
        ${!sms.planActive ? `
          <div class="callout sms-agent-upgrade">
            <p>Start your free trial to use the Loop Agent in iMessage.</p>
            <div class="acts">
              <a class="btn sm fill" href="${esc(billingUrl)}" data-sms-upgrade>Start free trial</a>
            </div>
          </div>
        ` : linkCode ? `
          <div class="sms-agent-link-box" data-sms-link-box>
            <p class="sms-agent-link-intro">Send this one-time code in Messages to link your phone:</p>
            <div class="sms-agent-link-rows">
              ${connectText ? `
                <div class="sms-agent-copy-row">
                  <span class="sms-agent-copy-lbl">Code</span>
                  <code class="sms-agent-code" data-sms-connect-code>${esc(connectText)}</code>
                  <button type="button" class="btn sm" data-sms-copy-code="${esc(connectText)}">Copy</button>
                </div>
              ` : ''}
              ${phone ? `
                <div class="sms-agent-copy-row">
                  <span class="sms-agent-copy-lbl">To</span>
                  <code class="sms-agent-code" data-sms-phone-number>${esc(phone)}</code>
                  <button type="button" class="btn sm" data-sms-copy-phone="${esc(phone)}">Copy</button>
                </div>
              ` : ''}
            </div>
            <div class="acts">
              ${smsUri ? `<a class="btn sm fill" href="${esc(smsUri)}" data-sms-open-messages>Open Messages</a>` : ''}
              <button type="button" class="btn sm" data-sms-refresh>I’ve sent it</button>
              <button type="button" class="btn sm ghost" data-sms-link-code ${smsState.generatingCode ? 'disabled' : ''}>New code</button>
            </div>
          </div>
        ` : `
          <div class="acts sms-agent-unlinked-acts">
            ${needsUserPhone ? `
              <input type="tel" class="input sm" data-sms-user-phone value="${esc(savedUserPhone)}" placeholder="+1 (555) 123-4567" aria-label="Your iMessage phone number" autocomplete="tel" />
            ` : ''}
            <button type="button" class="btn sm fill" data-sms-link-code ${smsState.generatingCode ? 'disabled' : ''}>${smsState.generatingCode ? 'Generating code…' : 'Text your agent'}</button>
          </div>
        `}
        ${inviteBar}
      </section>
    `;
  }

  const brain = status.brain || { mode: 'default', provider: 'loop', authState: 'ok' };
  const [sandboxCls, sandboxLabel] = sandboxBadge(status.sandboxState);
  const usageToday = Number.isFinite(Number(status.usageToday)) ? Number(status.usageToday) : 0;
  const dailyCap = Number.isFinite(Number(status.dailyCap)) ? Number(status.dailyCap) : 40;
  const authBroken = brain.authState === 'expired' || brain.authState === 'error';
  const brokenLabel = cliProviderLabel(brain.provider, brain.mode);
  const reconnectProvider = (brain.provider === 'codex' || brain.mode === 'codex_oauth')
    ? 'codex'
    : (brain.provider === 'claude' || brain.mode === 'claude_oauth')
      ? 'claude'
      : '';
  const activeTab = resolveSmsBrainTab(brain, smsState);
  const vaultKeys = Array.isArray(sms.vaultKeys) ? sms.vaultKeys : [];
  const selectedVaultKey = smsState?.byoVaultKey ?? brain.vaultKey ?? (vaultKeys[0]?.key || '');
  const selectedProvider = smsState?.byoProvider
    ?? (['anthropic', 'openai', 'openrouter'].includes(brain.provider) ? brain.provider : 'anthropic');
  const selectedModel = smsState?.byoModel ?? (brain.model || '');

  const rawOAuth = smsState?.oauthPending || (status.oauthPending && status.oauthPending.status === 'pending' ? status.oauthPending : null);
  const oauthPending = rawOAuth && rawOAuth.status !== 'authenticated' ? rawOAuth : null;
  const oauthProviderLabel = oauthPending ? cliProviderLabel(oauthPending.provider, null) : '';
  const safeOAuthUrl = oauthPending ? safeHref(oauthPending.authUrl, ['https:', 'http:'], false) : '';
  const smsMemoryAccess = smsState?.memoryAccess ?? sms?.agent?.memoryAccess ?? null;
  const smsMemoryOn = smsMemoryAccess === 'read_write' || smsMemoryAccess === 'read';
  const smsMemoryLabel = smsMemoryAccess === 'read_write' ? 'On (Read & save)' : smsMemoryAccess === 'read' ? 'Read only' : 'Off';

  return `
    <section class="card sms-agent-card" aria-label="Loop Agent on iMessage" data-sms-agent-card="linked">
      <div class="sms-agent-head">
        ${icon}
        <div class="sms-agent-copy">
          <div class="sms-agent-title-row">
            <h2 class="sms-agent-title">Loop Agent</h2>
            ${status.phoneMasked ? `<span class="sms-agent-phone mono">${esc(status.phoneMasked)}</span>` : ''}
          </div>
          <div class="sms-agent-meta">
            <span class="tag ${sandboxCls}" data-sms-sandbox-state="${esc(status.sandboxState || 'none')}">${esc(sandboxLabel)}</span>
            <span class="pill sms-agent-usage"><b>${esc(usageToday)}</b> / ${esc(dailyCap)} today</span>
            ${smsMemoryAccess ? `<span class="tag ${smsMemoryOn ? 'ok' : 'muted'}" data-sms-memory-badge="${esc(smsMemoryAccess)}">Memory: ${esc(smsMemoryLabel)}</span>` : ''}
          </div>
        </div>
      </div>

      ${authBroken ? `
        <div class="callout warn sms-agent-auth-warn" role="alert" data-sms-auth-warning>
          <p><strong>Your ${esc(brokenLabel)} sign-in ${brain.authState === 'expired' ? 'expired' : 'needs attention'}</strong> — reconnect to resume texting. Loop never silently downgrades your model.${brain.authError ? ` (${esc(brain.authError)})` : ''}</p>
          ${reconnectProvider ? `
            <div class="acts">
              <button type="button" class="btn sm fill" data-sms-cli-auth="${esc(reconnectProvider)}" ${smsState.startingOAuth ? 'disabled' : ''}>Reconnect ${esc(brokenLabel)}</button>
            </div>
          ` : ''}
        </div>
      ` : ''}

      <div class="sms-agent-brain">
        <span class="lbl">Agent brain</span>
        <div class="seg sms-agent-modes" role="group" aria-label="Agent brain">
          <button type="button" class="seg-btn" data-sms-brain-mode="default" aria-pressed="${activeTab === 'default'}" ${smsState.savingBrain ? 'disabled' : ''}>Included (Loop Default)</button>
          <button type="button" class="seg-btn" data-sms-brain-mode="byo_key" aria-pressed="${activeTab === 'byo_key'}">BYO API Key (Vault)</button>
          <button type="button" class="seg-btn" data-sms-brain-mode="cli_oauth" aria-pressed="${activeTab === 'cli_oauth'}">Claude / Codex</button>
        </div>

        ${activeTab === 'default' ? `
          <p class="hint sms-agent-brain-hint">Uses Loop’s included model. No API key or external subscription required.</p>
        ` : ''}

        ${activeTab === 'byo_key' ? (
          vaultKeys.length === 0 ? `
            <div class="callout sms-agent-vault-empty" data-sms-vault-empty>
              No API keys in your Vault yet. Add an Anthropic, OpenAI, or OpenRouter key in the <strong>Vault</strong> tab, then select it here.
            </div>
          ` : `
            <form class="form-grid sms-agent-byo-form" data-sms-byo-form>
              <div class="form-row">
                <label class="field">
                  <span class="lbl">Vault API key</span>
                  <select name="vaultKey">
                    ${vaultKeys.map((k) => `<option value="${esc(k.key)}" ${k.key === selectedVaultKey ? 'selected' : ''}>${esc(k.key)}${k.description ? ` — ${esc(k.description)}` : ''}</option>`).join('')}
                  </select>
                </label>
                <label class="field">
                  <span class="lbl">Provider</span>
                  <select name="provider">
                    <option value="anthropic" ${selectedProvider === 'anthropic' ? 'selected' : ''}>Anthropic</option>
                    <option value="openai" ${selectedProvider === 'openai' ? 'selected' : ''}>OpenAI</option>
                    <option value="openrouter" ${selectedProvider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
                  </select>
                </label>
              </div>
              <label class="field">
                <span class="lbl">Model override (optional)</span>
                <input type="text" name="model" value="${esc(selectedModel)}" placeholder="Leave blank for provider default" maxlength="120">
              </label>
              <div class="acts">
                <button type="submit" class="btn sm fill" ${smsState.savingBrain ? 'disabled' : ''}>${smsState.savingBrain ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          `
        ) : ''}

        ${activeTab === 'cli_oauth' ? `
          <div class="sms-agent-cli-panel">
            ${(brain.mode === 'claude_oauth' || brain.mode === 'codex_oauth') && brain.authState === 'ok' ? `
              <p class="hint sms-agent-cli-active">Currently signed in with <strong>${esc(cliProviderLabel(brain.provider, brain.mode))}</strong>.</p>
            ` : `
              <p class="hint">Sign in with your own Claude or Codex subscription to power your texting agent.</p>
            `}
            <div class="acts">
              <button type="button" class="btn sm ${brain.mode === 'claude_oauth' && brain.authState === 'ok' ? '' : 'fill'}" data-sms-cli-auth="claude" ${smsState.startingOAuth ? 'disabled' : ''}>Sign in with Claude</button>
              <button type="button" class="btn sm ${brain.mode === 'codex_oauth' && brain.authState === 'ok' ? '' : 'fill'}" data-sms-cli-auth="codex" ${smsState.startingOAuth ? 'disabled' : ''}>Sign in with Codex</button>
            </div>
          </div>
        ` : ''}

        ${oauthPending ? `
          <div class="callout sms-agent-oauth" role="status" data-sms-oauth-pending>
            <div class="sms-agent-oauth-head">
              <span class="spin sm" aria-hidden="true"></span>
              <strong>Waiting for ${esc(oauthProviderLabel)} sign-in…</strong>
            </div>
            ${oauthPending.instructions ? `<p class="hint sms-agent-oauth-inst">${esc(oauthPending.instructions)}</p>` : ''}
            ${oauthPending.deviceCode ? `
              <div class="sms-agent-copy-row">
                <span class="sms-agent-copy-lbl">Code</span>
                <code class="sms-agent-code" data-sms-device-code>${esc(oauthPending.deviceCode)}</code>
                <button type="button" class="btn sm" data-sms-copy-device-code="${esc(oauthPending.deviceCode)}">Copy</button>
              </div>
            ` : ''}
            ${safeOAuthUrl ? `
              <div class="acts">
                <a class="btn sm fill" href="${esc(safeOAuthUrl)}" target="_blank" rel="noopener noreferrer" data-sms-oauth-url>Open ${esc(oauthProviderLabel)} sign-in</a>
              </div>
            ` : ''}
          </div>
        ` : ''}
      </div>


      ${renderSmsDreamSection(status.dream, smsState, esc)}

      ${renderSmsTracesSection(smsState, esc)}

      <div class="sms-agent-foot">
        ${smsMemoryAccess ? `<button type="button" class="btn sm" data-sms-toggle-memory ${smsState.savingMemory ? 'disabled' : ''}>${smsMemoryOn ? 'Turn Memory Off' : 'Turn Memory On'}</button>` : ''}
        <a class="btn sm" href="#vault" data-sms-approvals>Choose what needs your OK</a>
        <button type="button" class="btn sm danger-outline" data-sms-disconnect ${smsState.disconnecting ? 'disabled' : ''}>${smsState.disconnecting ? 'Disconnecting…' : 'Disconnect'}</button>
      </div>
      ${inviteBar}
    </section>
  `;
}

// "just now", "5m ago", "3h ago", "4d ago"; '' when the time is unknown.
function ago(iso) {
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return '';
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function timeAgo(iso) {
  if (!iso) return 'Never connected';
  const when = ago(iso);
  return when ? `Active ${when}` : '';
}

export function agentSnippet(tab, { endpoint, port, stdioPath, token } = {}) {
  const url = resolveGatewayEndpoint(endpoint, port);
  if (tab === 'claude') {
    return `claude mcp add --transport http --scope user loop ${url} --header "Authorization: Bearer ${token}"`;
  }
  if (tab === 'codex') {
    return `# Add to ~/.codex/config.toml\n[mcp_servers.loop]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }\ndefault_tools_approval_mode = "approve"`;
  }
  if (tab === 'json') {
    return JSON.stringify({ mcpServers: { loop: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  }
  return JSON.stringify(
    { mcpServers: { loop: { command: 'node', args: [stdioPath], env: { LOOP_HUB_URL: url, LOOP_HUB_TOKEN: token } } } },
    null,
    2,
  );
}

export function renderConnect(ui, agent, data, connect) {
  const { esc } = ui;
  const tabs = snippetTabsFor(data, ui);
  const activeTab = tabs.some(([id]) => id === connect.tab)
    ? connect.tab
    : defaultSnippetTab(agent?.kind, data, ui);
  const snippet = agentSnippet(activeTab, {
    endpoint: data.endpoint,
    port: data.port,
    stdioPath: data.stdioPath,
    token: connect.token,
  });
  return `
    <div class="conn-drawer">
      <div class="tabs" role="tablist" aria-label="Setup for ${esc(agent.name)}">
        ${tabs.map(([id, label]) => `
          <button type="button" class="tab" role="tab" data-snippet-tab="${esc(id)}" data-agent="${esc(agent.id)}" aria-selected="${activeTab === id}">${esc(label)}</button>
        `).join('')}
      </div>
      <div class="tabpanel">
        <div class="codewrap">
          <pre class="code">${esc(snippet)}</pre>
          <button type="button" class="btn sm copybtn" data-copy-snippet="${esc(agent.id)}">Copy</button>
        </div>
        <p class="hint">This contains ${esc(agent.name)}'s token. Treat it like a password: anyone with it gets this agent's access.</p>
      </div>
    </div>
  `;
}

function renderAgentForm(ui, data, agent = null, prefill = null) {
  const { esc } = ui;
  const a = agent || {
    name: prefill?.name || '',
    kind: prefill?.kind || 'claude-code',
    profile: 'all',
    mode: 'default',
    canManage: true,
    memoryAccess: 'read_write',
    secrets: [],
  };
  const profiles = Array.from(new Set(['all', ...(data.profiles || []), a.profile]));
  const formId = agent ? `edit-agent-${agent.id}` : 'add-agent-form';
  return `
    <form id="${esc(formId)}" class="form-grid" data-agent-form="${esc(agent ? agent.id : '')}">
      <div class="form-row">
        <label class="field">
          <span class="lbl">Name</span>
          <input name="name" type="text" required maxlength="80" value="${esc(a.name)}" placeholder="e.g. Muse, OpenBot mhtua, Claude Code">
        </label>
        <label class="field">
          <span class="lbl">Kind</span>
          <select name="kind">
            ${(data.kinds || Object.keys(KIND_LABELS)).map((k) => `<option value="${esc(k)}" ${k === a.kind ? 'selected' : ''}>${esc(kindLabel(k))}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="form-row">
        <label class="field">
          <span class="lbl">Project it can use</span>
          <select name="profile">
            ${profiles.map((p) => `<option value="${esc(p)}" ${p === a.profile ? 'selected' : ''}>${p === 'all' ? 'All' : esc(p)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="form-row">
        <label class="field">
          <span class="lbl">Shared memory access</span>
          <select name="memoryAccess">
            <option value="read_write" ${(a.memoryAccess || (a.canManage ? 'read_write' : 'read')) === 'read_write' ? 'selected' : ''}>Read &amp; write (can recall and save memories)</option>
            <option value="read" ${(a.memoryAccess || (a.canManage ? 'read_write' : 'read')) === 'read' ? 'selected' : ''}>Read only (can recall, cannot write)</option>
            <option value="none" ${a.memoryAccess === 'none' ? 'selected' : ''}>No access</option>
          </select>
        </label>
      </div>
      <label class="tool-row">
        <input type="checkbox" class="tool-check" name="canManage" ${a.canManage ? 'checked' : ''}>
        <span class="tool-info">
          <span class="tool-name">Can manage connections</span>
          <span class="tool-desc">${isPersonalWorkspace(data, ui) ? 'Lets this agent add, sync and remove Loop connections in this workspace.' : 'Lets this agent add, sync and remove Loop connections. Adding a local command or changing a connection destination still requires your approval.'}</span>
        </span>
      </label>
      <fieldset class="field">
        <span class="lbl">Vault secrets it may read</span>
        ${(data.secrets || []).length === 0
          ? '<span class="hint">No secrets in the Vault yet. Add passwords or keys in the Vault tab, then share them here.</span>'
          : `<div class="tool-list">${data.secrets.map((s) => `
              <label class="tool-row">
                <input type="checkbox" class="tool-check" name="secrets" value="${esc(s.key)}" ${a.secrets.includes(s.key) ? 'checked' : ''}>
                <span class="tool-info">
                  <span class="tool-name">${esc(s.key)}</span>
                  ${s.description ? `<span class="tool-desc">${esc(s.description)}</span>` : ''}
                </span>
              </label>`).join('')}</div>
            <span class="hint">The agent sees only these names. It writes <code class="inline-code">{{vault:KEY}}</code> in a tool call, Loop fills in the value, and any copy of it in the result is hidden. Every use is logged below.</span>`}
      </fieldset>
      <div class="acts">
        <button type="submit" class="btn fill">${agent ? 'Save changes' : 'Create agent'}</button>
      </div>
    </form>
  `;
}

function readAgentForm(form) {
  const fd = new FormData(form);
  return {
    name: String(fd.get('name') || '').trim(),
    kind: String(fd.get('kind') || 'other'),
    profile: String(fd.get('profile') || 'all'),
    mode: String(fd.get('mode') || 'default'),
    memoryAccess: String(fd.get('memoryAccess') || 'read'),
    canManage: fd.get('canManage') === 'on',
    secrets: fd.getAll('secrets').map(String),
  };
}

// Activity for one agent, shown inside its row.
function renderActivity(ui, entries) {
  const { esc } = ui;
  if (!entries.length) {
    return `<p class="hint">No tool calls or secret use yet.</p>`;
  }
  return `
    <ul class="list">
      ${entries.map((e) => {
        const when = new Date(e.at);
        const label = {
          'secret/use': 'Used secret',
          'secret/reveal': 'Viewed secret',
          'memory/recall': 'Auto-recalled',
          'feedback/send': 'Sent feedback',
          'feedback/ask': 'Wanted to send feedback',
          'feedback/switch': 'Turned feedback',
          'tools/call': 'Tool',
          'resources/read': 'Resource',
          'prompts/get': 'Prompt',
        }[e.method] || e.method;
        return `
          <li>
            <div class="row">
              <div class="txt">
                <div class="t">
                  <span class="tag ${e.ok ? 'ok' : 'warn'}">${e.ok ? 'OK' : 'Failed'}</span>
                  <span class="tag muted">${esc(label)}</span>
                </div>
                <div class="d mono">${esc(e.target || '')}${e.error ? ` · ${esc(e.error)}` : ''}${e.ms !== undefined ? ` · ${esc(e.ms)} ms` : ''}</div>
              </div>
              <span class="pill">${esc(when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}</span>
            </div>
          </li>
        `;
      }).join('')}
    </ul>
  `;
}

const ts = (iso) => (iso ? Date.parse(iso) || 0 : 0);

// Picks the kind for an app that connected without a key, so "Add a key" starts filled in.
function guessKind(app) {
  const name = String(app.name || '').trim().toLowerCase();
  const client = String(app.clientName || '').trim().toLowerCase();
  if ([name, client].some((value) => /^(?:meta[ -]muse|muse[ -]agent)$/.test(value))) return 'meta-muse';
  for (const [kind, label] of Object.entries(KIND_LABELS)) {
    if (kind === 'other') continue;
    if (name === label.toLowerCase() || client === kind || client.startsWith(`${kind}-`)) return kind;
  }
  return 'other';
}

// One row per agent: an agent key together with the apps that connected using it.
// Apps that connected without a key get a row of their own.
export function agentRows(agents, connected) {
  const rows = agents.map((agent) => ({ id: agent.id, agent, apps: [] }));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const app of connected) {
    const row = app.agentId ? byId.get(app.agentId) : null;
    if (row) row.apps.push(app);
    else rows.push({ id: `app:${app.key}`, agent: null, apps: [app] });
  }
  for (const row of rows) {
    row.name = row.agent ? row.agent.name : row.apps[0].name || 'Agent';
    row.kind = row.agent ? row.agent.kind : guessKind(row.apps[0]);
    row.active = row.apps.reduce((n, app) => n + (app.sessionsActive || 0), 0);
    row.sessions = row.apps.reduce((n, app) => n + (app.sessionsTotal || 0), 0);
    const last = Math.max(ts(row.agent?.lastSeenAt), ...row.apps.map((app) => ts(app.lastSeenAt)));
    row.lastSeenAt = last > 0 ? new Date(last).toISOString() : null;
    // A sign-in this app started and never finished: { attempts, lastAttemptAt }.
    row.signIn = row.agent ? null : row.apps.find((app) => app.signIn)?.signIn || null;
  }
  return rows.sort(
    (a, b) => b.active - a.active || ts(b.lastSeenAt) - ts(a.lastSeenAt) || a.name.localeCompare(b.name),
  );
}

export function rowStatus(row) {
  if (row.agent && !row.agent.enabled) return ['muted', 'Off'];
  if (row.active > 0) return ['ok', 'Active'];
  if (row.lastSeenAt) return ['muted', 'Idle'];
  // Loop is in this app's settings, or it started signing in, but Loop has never seen it
  // connect. That is not "set up": say what is missing so the owner can finish it.
  if (row.signIn) return ['warn', 'Sign-in not finished'];
  if (!row.agent && row.apps.some((app) => app.configuredIn)) return ['warn', 'Never connected'];
  return ['muted', 'Not connected yet'];
}

// How this kind of app signs in to Loop by itself.
export function signInStep(kind) {
  if (kind === 'codex') return 'run `codex mcp login loop` in a terminal';
  if (kind === 'muse') return 'run `muse mcp login loop` in a terminal';
  if (kind === 'pi') return 'run `pi mcp login loop` in a terminal';
  if (kind === 'claude-code') return 'open /mcp in Claude Code, pick loop, then Authenticate';
  return "sign in to Loop from this app's own connection settings";
}

// One plain sentence on where an app without a key stands, or '' when it has simply been used.
export function installState(row) {
  if (row.agent) return '';
  const name = row.name || 'This app';
  if (row.signIn) {
    const n = row.signIn.attempts;
    const tries = n === 1 ? 'once' : `${n} times`;
    const when = ago(row.signIn.lastAttemptAt);
    return `${name} started signing in to Loop ${tries} and never finished${when ? ` (last try ${when})` : ''}.`;
  }
  if (!row.lastSeenAt && row.apps.some((app) => app.configuredIn)) {
    return `${name} has Loop in its settings but has never connected to it.`;
  }
  return '';
}

export function mountSmsAgentCard(container, initialSms, ui, { onReload = null } = {}) {
  const { esc, api, toast, copyText } = ui;
  let sms = initialSms && initialSms.enabled ? initialSms : { enabled: false };
  stopSmsOAuthPoll();
  if (!sms.enabled || !container) {
    if (container) container.innerHTML = '';
    return;
  }

  if (sms.status?.linked) {
    state.sms.linkCode = null;
    if (sms.status.oauthPending?.status === 'pending') {
      state.sms.oauthPending = sms.status.oauthPending;
    } else if (state.sms.oauthPending && !sms.status.oauthPending) {
      state.sms.oauthPending = null;
    }
  }

  const isAlive = () => Boolean(container && (typeof container.isConnected !== 'boolean' || container.isConnected));

  async function reloadSms() {
    if (typeof onReload === 'function') {
      await onReload();
      return;
    }
    try {
      const fresh = await api('/api/sms-agent');
      if (!isAlive()) return;
      sms = fresh && fresh.enabled ? fresh : { enabled: false };
      paintCard();
    } catch {
      // Keep current view on transient errors.
    }
  }

  function startPoll() {
    stopSmsOAuthPoll();
    smsPollTimer = setInterval(async () => {
      if (!isAlive()) {
        stopSmsOAuthPoll();
        return;
      }
      try {
        const res = await api('/api/sms-agent/cli-auth/status');
        if (!isAlive()) {
          stopSmsOAuthPoll();
          return;
        }
        if (res.status === 'authenticated') {
          stopSmsOAuthPoll();
          state.sms.oauthPending = null;
          state.sms.brainTab = null;
          toast('Sign-in complete. Your texting agent is ready.', 'ok');
          await reloadSms();
          return;
        }
        if (res.status === 'failed') {
          stopSmsOAuthPoll();
          state.sms.oauthPending = null;
          toast(res.error || 'Sign-in failed. Please try again.', 'err');
          await reloadSms();
          return;
        }
        if (res.status === 'none') {
          stopSmsOAuthPoll();
          state.sms.oauthPending = null;
          paintCard();
          return;
        }
        if (res.status === 'pending') {
          const prev = state.sms.oauthPending || {};
          if (prev.authUrl !== res.authUrl || prev.deviceCode !== res.deviceCode || prev.provider !== res.provider) {
            state.sms.oauthPending = {
              provider: res.provider || prev.provider,
              status: 'pending',
              authUrl: res.authUrl || prev.authUrl,
              deviceCode: res.deviceCode || prev.deviceCode,
              instructions: res.instructions || prev.instructions,
            };
            paintCard();
          }
        }
      } catch {
        // Keep polling on transient network hiccups while card is mounted.
      }
    }, 3000);
  }

  function paintCard() {
    if (!isAlive()) return;
    container.innerHTML = renderSmsAgentCard(sms, state.sms, esc);

    container.querySelectorAll('[data-sms-user-phone]').forEach((input) => input.addEventListener('input', () => {
      state.sms.userPhone = input.value;
    }));

    container.querySelectorAll('[data-sms-link-code]').forEach((btn) => btn.addEventListener('click', async () => {
      const phoneInput = container.querySelector('[data-sms-user-phone]');
      const userPhone = String(phoneInput ? phoneInput.value : (state.sms.userPhone || '')).trim();
      if (phoneInput) state.sms.userPhone = userPhone;
      if ((sms.needsUserPhone || sms.status?.needsUserPhone) && !userPhone) {
        toast('Enter your iMessage phone number first.', 'err');
        phoneInput?.focus();
        return;
      }
      state.sms.generatingCode = true;
      paintCard();
      try {
        const res = await api('/api/sms-agent/link-code', {
          method: 'POST',
          ...(userPhone ? { body: { phone: userPhone } } : {}),
        });
        if (res?.upgradeRequired) {
          sms.planActive = false;
          if (res.billingUrl) sms.billingUrl = res.billingUrl;
          state.sms.linkCode = null;
        } else {
          state.sms.linkCode = res;
        }
      } catch (err) {
        if (err?.upgradeRequired || /402|upgrade/i.test(err?.message || '')) {
          sms.planActive = false;
        }
        toast(err.message, 'err');
      } finally {
        state.sms.generatingCode = false;
        if (isAlive()) paintCard();
      }
    }));

    container.querySelectorAll('[data-sms-copy-code]').forEach((btn) => btn.addEventListener('click', () => {
      copyText(btn.dataset.smsCopyCode, 'Copied connect code.');
    }));

    container.querySelectorAll('[data-sms-copy-phone]').forEach((btn) => btn.addEventListener('click', () => {
      copyText(btn.dataset.smsCopyPhone, 'Copied phone number.');
    }));

    container.querySelectorAll('[data-sms-copy-device-code]').forEach((btn) => btn.addEventListener('click', () => {
      copyText(btn.dataset.smsCopyDeviceCode, 'Copied sign-in code.');
    }));

    container.querySelectorAll('[data-sms-copy-invite-url]').forEach((btn) => btn.addEventListener('click', () => {
      copyText(btn.dataset.smsCopyInviteUrl, 'Copied invite link.');
    }));

    container.querySelectorAll('[data-sms-copy-invite-msg]').forEach((btn) => btn.addEventListener('click', () => {
      copyText(btn.dataset.smsCopyInviteMsg, 'Copied invite message.');
    }));

    container.querySelectorAll('[data-sms-refresh]').forEach((btn) => btn.addEventListener('click', () => {
      reloadSms();
    }));

    bindSmsDream(container, { sms, api, toast, repaint: paintCard, isAlive });
    bindSmsTraces(container, { api, toast, copyText, repaint: paintCard, isAlive });

    container.querySelectorAll('[data-sms-brain-mode]').forEach((btn) => btn.addEventListener('click', async () => {
      const mode = btn.dataset.smsBrainMode;
      state.sms.brainTab = mode;
      if (mode === 'default') {
        state.sms.savingBrain = true;
        paintCard();
        try {
          const res = await api('/api/sms-agent/brain', {
            method: 'POST',
            body: JSON.stringify({ mode: 'default' }),
          });
          if (sms.status) sms.status.brain = res.brain || { mode: 'default', provider: 'loop', authState: 'ok' };
          state.sms.brainTab = 'default';
          toast('Switched to Loop Default brain.', 'ok');
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          state.sms.savingBrain = false;
          if (isAlive()) paintCard();
        }
        return;
      }
      paintCard();
    }));

    container.querySelector('[data-sms-byo-form]')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const vaultKey = String(fd.get('vaultKey') || '').trim();
      const provider = String(fd.get('provider') || 'anthropic').trim();
      const model = String(fd.get('model') || '').trim();
      if (!vaultKey) {
        toast('Select a Vault API key first.', 'err');
        return;
      }
      state.sms.byoVaultKey = vaultKey;
      state.sms.byoProvider = provider;
      state.sms.byoModel = model;
      state.sms.savingBrain = true;
      paintCard();
      try {
        const payload = { mode: 'byo_key', provider, vaultKey };
        if (model) payload.model = model;
        const res = await api('/api/sms-agent/brain', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        if (sms.status) sms.status.brain = res.brain || { mode: 'byo_key', provider, vaultKey, model: model || null, authState: 'ok' };
        toast('Saved BYO API key brain.', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        state.sms.savingBrain = false;
        if (isAlive()) paintCard();
      }
    });

    container.querySelectorAll('[data-sms-cli-auth]').forEach((btn) => btn.addEventListener('click', async () => {
      const provider = btn.dataset.smsCliAuth;
      state.sms.startingOAuth = true;
      state.sms.brainTab = 'cli_oauth';
      paintCard();
      try {
        const res = await api('/api/sms-agent/cli-auth/start', {
          method: 'POST',
          body: JSON.stringify({ provider }),
        });
        state.sms.oauthPending = {
          provider: res.provider || provider,
          status: res.status || 'pending',
          authUrl: res.authUrl || null,
          deviceCode: res.deviceCode || null,
          instructions: res.instructions || null,
        };
        startPoll();
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        state.sms.startingOAuth = false;
        if (isAlive()) paintCard();
      }
    }));

    container.querySelector('[data-sms-toggle-memory]')?.addEventListener('click', async () => {
      const smsAgent = sms?.agent;
      if (!smsAgent?.id) return;
      const cur = state.sms.memoryAccess ?? smsAgent.memoryAccess ?? 'read_write';
      const next = cur === 'none' ? 'read_write' : 'none';
      state.sms.savingMemory = true;
      paintCard();
      try {
        await api(`/api/agents/${encodeURIComponent(smsAgent.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ memoryAccess: next }),
        });
        smsAgent.memoryAccess = next;
        state.sms.memoryAccess = next;
        toast(next === 'none' ? 'Loop Agent memory turned off.' : 'Loop Agent memory turned on.', 'ok');
        state.sms.savingMemory = false;
        await reloadSms();
      } catch (err) {
        state.sms.savingMemory = false;
        toast(err.message, 'err');
        if (isAlive()) paintCard();
      }
    });

    container.querySelector('[data-sms-disconnect]')?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Disconnect the Loop Agent from iMessage?',
        message: 'You can link your phone again anytime.',
        confirmLabel: 'Disconnect',
        danger: true,
      });
      if (!ok) return;
      stopSmsOAuthPoll();
      state.sms.disconnecting = true;
      paintCard();
      try {
        await api('/api/sms-agent/disconnect', { method: 'POST' });
        state.sms.linkCode = null;
        state.sms.oauthPending = null;
        state.sms.brainTab = null;
        toast('Loop Agent disconnected.', 'ok');
        await reloadSms();
      } catch (err) {
        state.sms.disconnecting = false;
        toast(err.message, 'err');
        if (isAlive()) paintCard();
      }
    });
  }

  paintCard();
  if (state.sms.oauthPending?.status === 'pending') startPoll();
}

/* ---------------- Import from your agents (Connections tab panel) ---------------- */

const STATUS_TEXT = {
  new: ['ok', 'New'],
  update: ['info', 'Update'],
  exists: ['muted', 'Already in Loop'],
  duplicate: ['muted', 'Duplicate'],
  self: ['muted', 'Loop'],
  unsupported: ['warn', 'Can’t import'],
};

export async function renderImportFromAgents(container, ui, onDone) {
  const { esc, api, toast } = ui;
  container.innerHTML = `<section class="card"><div class="loading" role="status"><div class="spin" aria-hidden="true"></div><p>Reading your agents’ settings…</p></div></section>`;
  let sources;
  try {
    ({ sources } = await api('/api/import/sources'));
  } catch (err) {
    container.innerHTML = `<section class="card"><div class="callout bad">${esc(err.message)}</div></section>`;
    return;
  }
  state.importSelected = new Set(
    sources.flatMap((s) => s.servers.filter((x) => (x.status === 'new' || x.status === 'update') && x.enabled !== false).map((x) => x.key)),
  );

  const goLabel = () => `Import ${state.importSelected.size} server${state.importSelected.size === 1 ? '' : 's'}`;

  function paint() {
    const found = sources.filter((s) => s.found);
    const totalNew = sources.reduce((n, s) => n + s.servers.filter((x) => x.status === 'new').length, 0);
    const totalUpdates = sources.reduce((n, s) => n + s.servers.filter((x) => x.status === 'update').length, 0);
    const summaryLead = totalUpdates > 0
      ? `Loop found ${totalNew} new server${totalNew === 1 ? '' : 's'} and ${totalUpdates} update${totalUpdates === 1 ? '' : 's'} across ${found.length} agent${found.length === 1 ? '' : 's'} on this Mac.`
      : `Loop found ${totalNew} new MCP server${totalNew === 1 ? '' : 's'} across ${found.length} agent${found.length === 1 ? '' : 's'} on this Mac.`;
    container.innerHTML = `
      <section aria-label="Import from your agents">
        <div class="panel-head">
          <p class="sub">${esc(summaryLead)} An app that needs a sign-in shows a Sign in button on Home.</p>
          <button type="button" class="btn sm fill" id="import-agents-go-top" ${state.importSelected.size ? '' : 'disabled'}>${esc(goLabel())}</button>
        </div>

        ${sources.filter((s) => s.found || s.error).map((s) => `
          <div class="drawer-sec">
            <div class="drawer-title">
              ${esc(s.label)}
              <span class="tag muted">${esc(s.servers.length)}</span>
              ${s.error ? `<span class="tag warn">${esc(s.error)}</span>` : ''}
            </div>
            ${s.found && s.servers.length ? `
              <div class="tool-list">
                ${s.servers.map((x) => {
                  const [cls, text] = STATUS_TEXT[x.status] || ['muted', x.status];
                  const selectable = x.status === 'new' || x.status === 'update' || x.status === 'duplicate';
                  return `
                    <label class="tool-item import-row ${selectable ? '' : 'off'}">
                      <span class="tool-row">
                        <input type="checkbox" class="tool-check" data-import-key="${esc(x.key)}" ${state.importSelected.has(x.key) ? 'checked' : ''} ${selectable ? '' : 'disabled'} aria-label="Import ${esc(x.name)} from ${esc(s.label)}">
                        <span class="tool-info">
                          <span class="tool-name">${esc(x.name)}
                            <span class="tag ${cls}">${esc(text)}</span>
                            ${x.transport ? `<span class="tag transport ${x.transport === 'stdio' ? 'stdio' : ''}">${x.transport === 'stdio' ? 'Local' : 'Cloud'}</span>` : ''}
                            ${x.origin !== 'user' ? `<span class="tag muted">${esc(x.origin)}</span>` : ''}
                            ${x.secretCount ? `<span class="tag info">${esc(x.secretCount)} secret${x.secretCount === 1 ? '' : 's'} → Vault</span>` : ''}
                            ${x.enabled ? '' : '<span class="tag muted">Off in this agent</span>'}
                          </span>
                          <span class="tool-desc mono">${esc(x.preview)}</span>
                          ${x.reason && x.status !== 'new' ? `<span class="tool-desc">${esc(x.reason)}</span>` : ''}
                          ${x.warnings.map((w) => `<span class="tool-desc">⚠ ${esc(w)}</span>`).join('')}
                        </span>
                      </span>
                    </label>
                  `;
                }).join('')}
              </div>
            ` : ''}
          </div>
        `).join('')}

        ${sources.some((s) => !s.found && !s.error) ? `
          <p class="hint">Not found on this Mac: ${esc(sources.filter((s) => !s.found && !s.error).map((s) => s.label).join(', '))}.</p>
        ` : ''}

        <div class="form-row">
          <label class="field">
            <span class="lbl">Project tag for imported servers (optional)</span>
            <input id="import-agents-profile" type="text" placeholder="e.g. imported">
          </label>
        </div>
        <div class="acts">
          <button type="button" class="btn fill" id="import-agents-go" ${state.importSelected.size ? '' : 'disabled'}>${esc(goLabel())}</button>
        </div>
      </section>
    `;
    bind();
  }

  function bind() {
    container.querySelectorAll('[data-import-key]').forEach((box) => box.addEventListener('change', () => {
      if (box.checked) state.importSelected.add(box.dataset.importKey);
      else state.importSelected.delete(box.dataset.importKey);
      for (const btn of container.querySelectorAll('#import-agents-go, #import-agents-go-top')) {
        btn.disabled = !state.importSelected.size;
        btn.textContent = goLabel();
      }
    }));
    const runImport = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Importing…';
      const profile = String(container.querySelector('#import-agents-profile')?.value || '').trim().toLowerCase() || 'all';
      try {
        const res = await api('/api/import/sources', {
          method: 'POST',
          body: JSON.stringify({ keys: [...state.importSelected], profile }),
        });
        const n = Array.isArray(res.added) ? res.added.length : 0;
        const u = Array.isArray(res.updated) ? res.updated.length : 0;
        const parts = [];
        if (n) parts.push(`Imported ${n} server${n === 1 ? '' : 's'}`);
        if (u) parts.push(`Updated ${u} server${u === 1 ? '' : 's'}`);
        if (!parts.length) parts.push('No servers changed');
        toast(
          `${parts.join(', ')}${res.secretsMoved ? `, ${res.secretsMoved} secret${res.secretsMoved === 1 ? '' : 's'} moved to the Vault` : ''}${res.skipped.length ? ` (${res.skipped.length} skipped)` : ''}. Connecting in the background.`,
          'ok',
        );
        onDone(res);
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
        btn.textContent = goLabel();
      }
    };
    mountContextGuide(container.querySelector('.panel-head').parentElement, api, 'sync-agents', 'Agent import guide');
    container.querySelector('#import-agents-go')?.addEventListener('click', runImport);
    container.querySelector('#import-agents-go-top')?.addEventListener('click', runImport);
  }

  paint();
}
