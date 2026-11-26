// Built-in Loop Specialist chat view (#loop) with live SSE streaming, full Loop MCP tool steps,
// runner / MausBot configuration, inline prompt flagging, and an optional live split mind map.

import { renderSkillMarkdown } from './skill-markdown.js';
import { mountMemoryGraph } from './memory-graph.js';
import { createLibraryMap, groupClass, kindWord } from './library-map.js';

const LOOP_MARK_SVG = '<svg width="24" height="14" viewBox="0 0 36 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.2 15.2C6.8 15.2 4 12.9 4 10s2.8-5.2 6.2-5.2c3.2 0 5.4 2.4 7.8 5.2 2.4 2.8 4.6 5.2 7.8 5.2 3.4 0 6.2-2.3 6.2-5.2s-2.8-5.2-6.2-5.2c-3.2 0-5.4 2.4-7.8 5.2-2.4 2.8-4.6 5.2-7.8 5.2Z"/></svg>';
const ICON_MAP = '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.9 6.3l-3.1 5.4M11.1 6.3l3.1 5.4M7 14.3h6"/><circle cx="10" cy="4.3" r="2.2"/><circle cx="4.7" cy="14.3" r="2.2"/><circle cx="15.3" cy="14.3" r="2.2"/></svg>';
const ICON_PLUS = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M7 2.5v9M2.5 7h9"/></svg>';
const ICON_SEND = '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 15.5V4.5M5.5 9L10 4.5 14.5 9"/></svg>';
const ICON_STOP = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1.8"/></svg>';
const ICON_FLAG = '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 3.5v13M4.5 4.5h9.5l-1.8 3.2 1.8 3.3H4.5"/></svg>';
const ICON_SLIDERS = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 6h12M4 14h12"/><circle cx="8" cy="6" r="2" fill="var(--bg)"/><circle cx="13" cy="14" r="2" fill="var(--bg)"/></svg>';
const ICON_TRASH = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
const ICON_CHEV = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg>';

const MAP_OPEN_KEY = 'loop.chat.mapOpen';
const ACTIVE_THREAD_KEY = 'loop.chat.threadId';

let activeSplitGraph = null;
let activeRefreshMap = null;
let activeStreamAbort = null;

export function destroyLoopChatView() {
  if (activeSplitGraph) {
    activeSplitGraph.destroy();
    activeSplitGraph = null;
  }
  activeRefreshMap = null;
}

export function refreshLoopChatMap() {
  if (typeof activeRefreshMap === 'function') {
    void activeRefreshMap();
  }
}

function readBoolPref(key, fallback = false) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* ignore */ }
  return fallback;
}

function writePref(key, val) {
  try { localStorage.setItem(key, val); } catch { /* ignore */ }
}

function readThreadPref() {
  try { return localStorage.getItem(ACTIVE_THREAD_KEY) || ''; } catch { return ''; }
}

async function* iterSseResponse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split(/\r?\n\r?\n/);
      buf = frames.pop() || '';
      for (const frame of frames) {
        let event = 'message';
        const dataLines = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (!dataLines.length) continue;
        let data = dataLines.join('\n');
        try { data = JSON.parse(data); } catch { /* keep raw */ }
        yield { event, data };
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

function clip(raw, max = 80) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export async function renderLoopChat(root, ui) {
  const {
    api,
    streamFetch,
    esc,
    toast,
    isCurrent,
    uiState,
    params,
    activeProfile,
    onCapabilitiesChange,
  } = ui;

  destroyLoopChatView();

  const fromMap = params?.get('from') === 'map';
  let mapOpen = fromMap ? true : readBoolPref(MAP_OPEN_KEY, false);
  let runnerPanelOpen = false;
  let threadsOpen = false;
  let focusedNodeId = String(params?.get('focus') || uiState.loopChatFocusNodeId || '').trim();
  let focusedNodeMeta = null;
  let caps = null;
  let threads = [];
  let activeThread = null;
  let selectedRunner = '';
  let selectedModel = '';
  let selectedEffort = '';
  let activeRunId = '';
  let liveAssistant = null; // { text, steps, createdItems, approvals, runId }
  let flagOpenForRunId = '';
  let splitMapSelectedId = focusedNodeId || null;

  const lib = createLibraryMap({ api, esc, profile: () => activeProfile?.() || 'all' });

  async function loadInitial() {
    const [capRes, thrRes] = await Promise.all([
      api('/api/loop-agent/capabilities'),
      api('/api/loop-agent/threads?limit=40'),
    ]);
    if (!isCurrent()) return false;
    caps = capRes;
    onCapabilitiesChange?.(caps);
    threads = Array.isArray(thrRes?.threads) ? thrRes.threads : [];

    const savedId = uiState.loopChatThreadId || readThreadPref();
    const targetId = threads.some((t) => t.id === savedId) ? savedId : (threads[0]?.id || '');
    if (targetId) {
      const detail = await api(`/api/loop-agent/threads/${encodeURIComponent(targetId)}`).catch(() => null);
      if (detail?.thread) activeThread = detail.thread;
    }
    if (activeThread) {
      uiState.loopChatThreadId = activeThread.id;
      writePref(ACTIVE_THREAD_KEY, activeThread.id);
    }

    syncRunnerSelection(activeThread?.runner || caps.defaultRunner, activeThread?.model || '');

    if (focusedNodeId) {
      const itemRes = await api(`/api/library/item/${encodeURIComponent(focusedNodeId)}`).catch(() => null);
      if (itemRes?.item) {
        focusedNodeMeta = {
          id: itemRes.item.id,
          kind: itemRes.item.kind || 'memory',
          title: itemRes.item.title || itemRes.item.displayTitle || itemRes.item.name || itemRes.item.content || itemRes.item.id,
        };
      }
    }
    return true;
  }

  function syncRunnerSelection(runnerId, modelOverride = '') {
    const list = caps?.runners || [];
    const found = list.find((r) => r.id === runnerId && r.available)
      || list.find((r) => r.id === caps?.defaultRunner && r.available)
      || list.find((r) => r.available)
      || list[0]
      || null;
    selectedRunner = found ? found.id : '';
    selectedModel = modelOverride || found?.model || '';
    selectedEffort = found?.effort || '';
  }

  function currentRunnerInfo() {
    return (caps?.runners || []).find((r) => r.id === selectedRunner) || null;
  }

  function stepRowHtml(step) {
    const stateCls = step.ok === false ? 'is-err' : step.ok === true ? 'is-ok' : 'is-run';
    const ms = step.durationMs ? `${Math.round(step.durationMs / 100) / 10}s` : '';
    const argsPreview = step.input && Object.keys(step.input).length > 0 ? clip(JSON.stringify(step.input), 90) : '';
    return `
      <details class="lc-step ${stateCls}">
        <summary class="lc-step-sum">
          <span class="lc-step-dot" aria-hidden="true"></span>
          <code class="lc-step-name">${esc(step.tool || 'tool')}</code>
          ${argsPreview ? `<span class="lc-step-arg">${esc(argsPreview)}</span>` : ''}
          ${ms ? `<span class="lc-step-ms">${esc(ms)}</span>` : ''}
        </summary>
        <div class="lc-step-body">
          <pre class="lc-step-pre">${esc(JSON.stringify(step.input || {}, null, 2))}</pre>
          ${step.output ? `<pre class="lc-step-pre is-out">${esc(step.output)}</pre>` : ''}
        </div>
      </details>
    `;
  }

  function createdChipsHtml(items) {
    if (!Array.isArray(items) || items.length === 0) return '';
    return `
      <div class="lc-chips" aria-label="Created or updated Loop items">
        ${items.map((it) => `
          <button type="button" class="lc-chip ${groupClass(it)}" data-focus-node="${esc(it.id)}" title="Focus on mind map">
            <span class="lc-chip-k">${esc(kindWord(it))}</span>
            <span class="lc-chip-t">${esc(clip(it.title || it.id, 44))}</span>
          </button>
        `).join('')}
      </div>
    `;
  }

  function approvalsHtml(approvals) {
    if (!Array.isArray(approvals) || approvals.length === 0) return '';
    return approvals.map((a) => `
      <div class="lc-approval" data-approval-id="${esc(a.id)}">
        <div class="lc-approval-txt">
          <strong>Approval needed</strong>
          <span>${esc(a.summary || 'Confirm this Loop action.')}</span>
        </div>
        <div class="lc-approval-acts">
          ${a.guard
            ? `<a class="btn sm fill" href="#approvals?id=${encodeURIComponent(a.id)}">Confirm with password</a>`
            : `<button type="button" class="btn sm fill" data-approve-id="${esc(a.id)}">Approve</button>
               <button type="button" class="btn sm ghost" data-deny-id="${esc(a.id)}">Deny</button>`}
        </div>
      </div>
    `).join('');
  }

  function messageHtml(msg) {
    const isUser = msg.role === 'user';
    const bodyHtml = isUser
      ? `<p class="lc-user-txt">${esc(msg.text || '')}</p>`
      : `<div class="lc-md skill-markdown">${renderSkillMarkdown(msg.text || '')}</div>`;
    const stepsHtml = !isUser && Array.isArray(msg.steps) && msg.steps.length > 0
      ? `<div class="lc-steps">${msg.steps.map(stepRowHtml).join('')}</div>`
      : '';
    const chips = !isUser ? createdChipsHtml(msg.createdItems) : '';
    const flagBtn = !isUser && msg.runId
      ? `<button type="button" class="lc-flag-btn ${msg.flagged ? 'is-flagged' : ''}" data-open-flag="${esc(msg.runId)}" title="${msg.flagged ? 'Edit flag note' : 'Flag bad prompt or tool behavior'}">${ICON_FLAG}<span>${msg.flagged ? 'Flagged' : 'Flag'}</span></button>`
      : '';
    const flagEditor = !isUser && msg.runId && flagOpenForRunId === msg.runId
      ? `
        <form class="lc-flag-form" data-flag-form="${esc(msg.runId)}">
          <input type="text" name="note" value="${esc(msg.flagNote || '')}" placeholder="What looked wrong? (saved to npm run traces)" autocomplete="off">
          <button type="submit" class="btn sm fill">Save flag</button>
          ${msg.flagged ? `<button type="button" class="btn sm ghost" data-unflag="${esc(msg.runId)}">Clear</button>` : ''}
          <button type="button" class="btn sm ghost" data-close-flag>Cancel</button>
        </form>
      `
      : (msg.flagged && msg.flagNote ? `<p class="lc-flag-note">Flagged: ${esc(msg.flagNote)}</p>` : '');

    return `
      <article class="lc-msg ${isUser ? 'is-user' : 'is-ai'}">
        ${stepsHtml}
        <div class="lc-bubble">${bodyHtml}</div>
        ${chips}
        ${!isUser && msg.runId ? `<div class="lc-msg-foot">${flagBtn}</div>` : ''}
        ${flagEditor}
      </article>
    `;
  }

  function liveMessageHtml() {
    if (!liveAssistant) return '';
    return `
      <article class="lc-msg is-ai is-live">
        ${liveAssistant.steps.length > 0 ? `<div class="lc-steps">${liveAssistant.steps.map(stepRowHtml).join('')}</div>` : ''}
        ${approvalsHtml(liveAssistant.approvals)}
        <div class="lc-bubble">
          ${liveAssistant.text
            ? `<div class="lc-md skill-markdown">${renderSkillMarkdown(liveAssistant.text)}</div>`
            : `<div class="lc-thinking"><span class="lc-dot"></span><span>Working with Loop…</span></div>`}
        </div>
        ${createdChipsHtml(liveAssistant.createdItems)}
      </article>
    `;
  }

  function runnerPanelHtml() {
    if (!runnerPanelOpen || !caps) return '';
    const localRunners = caps.runners.filter((r) => r.kind === 'local_cli');
    const apiRunners = caps.runners.filter((r) => r.kind === 'api_key');
    const mausbot = caps.mausbot || {};
    const cur = currentRunnerInfo();

    return `
      <section class="lc-drawer" aria-label="Model runners">
        <div class="lc-drawer-head">
          <strong>Connect models &amp; runners</strong>
          <button type="button" class="lc-close-btn" data-toggle-runners aria-label="Close runners">Done</button>
        </div>

        <div class="lc-drawer-grid">
          ${localRunners.length > 0 ? `
            <div class="lc-drawer-col">
              <div class="lc-drawer-k">Local CLIs (full computer + Loop MCP)</div>
              ${localRunners.map((r) => `
                <div class="lc-runner-row ${selectedRunner === r.id ? 'is-on' : ''}">
                  <div class="lc-runner-info">
                    <span class="lc-runner-name">${esc(r.label)}</span>
                    <span class="lc-runner-st ${r.available ? 'is-ok' : ''}">${r.available ? 'Ready' : 'Not installed'}</span>
                  </div>
                  ${r.available ? `<button type="button" class="btn sm ${selectedRunner === r.id ? 'fill' : 'ghost'}" data-pick-runner="${esc(r.id)}">${selectedRunner === r.id ? 'Active' : 'Use'}</button>` : ''}
                </div>
              `).join('')}
              ${cur && cur.models?.length > 0 ? `
                <div class="lc-runner-opts">
                  <label class="lc-opt">
                    <span>Model</span>
                    <select data-runner-model>
                      ${cur.models.map((m) => `<option value="${esc(m.id)}" ${selectedModel === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
                    </select>
                  </label>
                  ${cur.efforts?.length > 0 ? `
                    <label class="lc-opt">
                      <span>Effort</span>
                      <select data-runner-effort>
                        ${cur.efforts.map((ef) => `<option value="${esc(ef)}" ${selectedEffort === ef ? 'selected' : ''}>${esc(ef)}</option>`).join('')}
                      </select>
                    </label>
                  ` : ''}
                </div>
              ` : ''}
            </div>
          ` : ''}

          <div class="lc-drawer-col">
            <div class="lc-drawer-k">MausBot bridge</div>
            <form class="lc-form" data-mausbot-form>
              <input type="url" name="endpoint" value="${esc(mausbot.endpoint || '')}" placeholder="http://127.0.0.1:18880/hooks/api/bots/.../messages" autocomplete="off">
              <input type="password" name="apiKey" placeholder="${mausbot.hasKey ? 'Token saved in Vault (paste to replace)' : 'Bearer token (saved in Vault)'}" autocomplete="off">
              <div class="lc-form-acts">
                <button type="submit" class="btn sm fill">Save MausBot</button>
                ${mausbot.configured ? `<button type="button" class="btn sm ghost" data-pick-runner="mausbot">${selectedRunner === 'mausbot' ? 'Active' : 'Use'}</button>` : ''}
                ${mausbot.configured && !mausbot.fromEnv ? `<button type="button" class="btn sm ghost" data-clear-mausbot>Remove</button>` : ''}
              </div>
            </form>
          </div>

          ${apiRunners.length > 0 ? `
            <div class="lc-drawer-col">
              <div class="lc-drawer-k">Provider API keys (stored in Vault)</div>
              <div class="lc-api-list">
                ${apiRunners.map((r) => `
                  <div class="lc-runner-row ${selectedRunner === r.id ? 'is-on' : ''}">
                    <div class="lc-runner-info">
                      <span class="lc-runner-name">${esc(r.shortLabel)}</span>
                      <span class="lc-runner-st ${r.hasKey ? 'is-ok' : ''}">${r.hasKey ? 'Key in Vault' : 'No key'}</span>
                    </div>
                    <div class="lc-row-acts">
                      ${r.hasKey ? `<button type="button" class="btn sm ${selectedRunner === r.id ? 'fill' : 'ghost'}" data-pick-runner="${esc(r.id)}">${selectedRunner === r.id ? 'Active' : 'Use'}</button>` : ''}
                      ${r.hasKey ? `<button type="button" class="btn sm ghost" data-remove-key="${esc(r.id)}">Remove</button>` : ''}
                    </div>
                  </div>
                `).join('')}
              </div>
              <form class="lc-form" data-apikey-form>
                <select name="provider">
                  ${apiRunners.map((r) => `<option value="${esc(r.id)}">${esc(r.label)}</option>`).join('')}
                </select>
                <input type="password" name="key" placeholder="Paste API key (stored encrypted in Vault)" autocomplete="off" required>
                <button type="submit" class="btn sm fill">Save key</button>
              </form>
            </div>
          ` : ''}
        </div>
      </section>
    `;
  }

  function threadsDrawerHtml() {
    if (!threadsOpen) return '';
    return `
      <section class="lc-threads" aria-label="Chat history">
        <div class="lc-drawer-head">
          <strong>Conversations</strong>
          <button type="button" class="btn sm fill" data-new-thread>${ICON_PLUS}<span>New chat</span></button>
        </div>
        ${threads.length === 0
          ? '<p class="lc-empty-sub">No chats yet.</p>'
          : `<div class="lc-thread-list">${threads.map((t) => `
              <div class="lc-thread-row ${activeThread?.id === t.id ? 'is-on' : ''}">
                <button type="button" class="lc-thread-pick" data-open-thread="${esc(t.id)}">
                  <span class="lc-thread-t">${esc(t.title || 'New chat')}</span>
                  <span class="lc-thread-m">${esc(t.messageCount || 0)} msg</span>
                </button>
                <button type="button" class="lc-thread-del" data-del-thread="${esc(t.id)}" aria-label="Delete thread">${ICON_TRASH}</button>
              </div>
            `).join('')}</div>`}
      </section>
    `;
  }

  function emptyStateHtml() {
    const cur = currentRunnerInfo();
    const ready = Boolean(cur?.available);
    const starterPrompts = [
      'Map out my current projects, open tasks, and key memories in Loop',
      'Research a topic, save a structured brief, and link the main facts to my Library',
      'Check my connected services and summarize what needs attention today',
    ];
    return `
      <div class="lc-empty">
        <div class="lc-empty-mark">${LOOP_MARK_SVG}</div>
        <h2 class="lc-empty-h">Plan, think, and build your Loop.</h2>
        <p class="lc-empty-p">
          ${ready
            ? `Connected to <strong>${esc(cur.label)}</strong> with full Loop MCP access. Ask anything and watch your Library mind map update live.`
            : 'Connect Claude Code, Codex, MausBot, or a Vault API key in Runners to start.'}
        </p>
        ${ready ? `
          <div class="lc-starters">
            ${starterPrompts.map((p) => `<button type="button" class="lc-starter" data-starter="${esc(p)}">${esc(p)}</button>`).join('')}
          </div>
        ` : `<button type="button" class="btn fill" data-toggle-runners>Configure runner</button>`}
      </div>
    `;
  }

  async function mountOrRefreshSplitMap() {
    if (!mapOpen) {
      if (activeSplitGraph) {
        activeSplitGraph.destroy();
        activeSplitGraph = null;
      }
      return;
    }
    const canvas = root.querySelector('#lc-map-canvas');
    if (!canvas) return;
    const prof = activeProfile?.() || 'all';
    const q = prof && prof !== 'all' ? `?profile=${encodeURIComponent(prof)}` : '';
    const [graphRes] = await Promise.all([
      api(`/api/memory/graph${q}`).catch(() => null),
      lib.load().catch(() => false),
    ]);
    if (!isCurrent() || !canvas.isConnected) return;
    const rawGraph = graphRes?.graph || graphRes;
    const baseGraph = rawGraph && Array.isArray(rawGraph.nodes) ? rawGraph : { nodes: [], edges: [] };
    const merged = lib.merge(baseGraph);

    const layerSlot = root.querySelector('#lc-map-layers');
    if (layerSlot) layerSlot.innerHTML = lib.controlHtml();

    if (!activeSplitGraph) {
      activeSplitGraph = mountMemoryGraph(canvas, {
        graph: merged,
        selectedId: splitMapSelectedId,
        onSelect: (id) => {
          splitMapSelectedId = id || null;
          focusedNodeId = id || '';
          uiState.loopChatFocusNodeId = focusedNodeId;
          if (id) {
            const node = merged.nodes.find((n) => n.id === id);
            focusedNodeMeta = node ? { id: node.id, kind: node.kind || 'memory', title: node.title || node.label || node.id } : null;
          } else {
            focusedNodeMeta = null;
          }
          renderFocusBadge();
        },
      });
    } else {
      activeSplitGraph.update({ graph: merged, selectedId: splitMapSelectedId });
    }
    if (splitMapSelectedId) activeSplitGraph.focusNode?.(splitMapSelectedId);
  }

  activeRefreshMap = mountOrRefreshSplitMap;

  function renderFocusBadge() {
    const slot = root.querySelector('#lc-focus-slot');
    if (!slot) return;
    if (!focusedNodeId) {
      slot.innerHTML = '';
      slot.hidden = true;
      return;
    }
    slot.hidden = false;
    slot.innerHTML = `
      <span class="lc-focus-pill">
        <span>Context: ${esc(clip(focusedNodeMeta?.title || focusedNodeId, 48))}</span>
        <button type="button" class="lc-focus-x" data-clear-focus aria-label="Clear node context">&times;</button>
      </span>
    `;
    slot.querySelector('[data-clear-focus]')?.addEventListener('click', () => {
      focusedNodeId = '';
      focusedNodeMeta = null;
      splitMapSelectedId = null;
      uiState.loopChatFocusNodeId = '';
      activeSplitGraph?.update({ selectedId: null });
      renderFocusBadge();
    });
  }

  function renderMessagesOnly() {
    const feed = root.querySelector('#lc-feed');
    if (!feed) return;
    const msgs = activeThread?.messages || [];
    if (msgs.length === 0 && !liveAssistant) {
      feed.innerHTML = emptyStateHtml();
    } else {
      feed.innerHTML = `${msgs.map(messageHtml).join('')}${liveMessageHtml()}`;
    }
    feed.scrollTop = feed.scrollHeight;
    wireFeedEvents();
  }

  function wireFeedEvents() {
    const feed = root.querySelector('#lc-feed');
    if (!feed) return;
    feed.querySelectorAll('[data-starter]').forEach((btn) => {
      btn.addEventListener('click', () => sendMessage(btn.dataset.starter));
    });
    feed.querySelectorAll('[data-toggle-runners]').forEach((btn) => {
      btn.addEventListener('click', () => {
        runnerPanelOpen = !runnerPanelOpen;
        threadsOpen = false;
        paint();
      });
    });
    feed.querySelectorAll('[data-focus-node]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.focusNode;
        splitMapSelectedId = id;
        focusedNodeId = id;
        uiState.loopChatFocusNodeId = id;
        if (!mapOpen) {
          mapOpen = true;
          writePref(MAP_OPEN_KEY, '1');
          paint();
        } else {
          await mountOrRefreshSplitMap();
        }
      });
    });
    feed.querySelectorAll('[data-open-flag]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rid = btn.dataset.openFlag;
        flagOpenForRunId = flagOpenForRunId === rid ? '' : rid;
        renderMessagesOnly();
        feed.querySelector(`[data-flag-form="${CSS.escape(rid)}"] input[name="note"]`)?.focus();
      });
    });
    feed.querySelectorAll('[data-close-flag]').forEach((btn) => {
      btn.addEventListener('click', () => {
        flagOpenForRunId = '';
        renderMessagesOnly();
      });
    });
    feed.querySelectorAll('[data-unflag]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const rid = btn.dataset.unflag;
        try {
          await api(`/api/loop-agent/runs/${encodeURIComponent(rid)}/flag`, {
            method: 'POST',
            body: JSON.stringify({ flagged: false }),
          });
          if (activeThread?.messages) {
            for (const m of activeThread.messages) {
              if (m.runId === rid) { m.flagged = false; m.flagNote = ''; }
            }
          }
          flagOpenForRunId = '';
          toast('Flag cleared.', 'ok');
          renderMessagesOnly();
        } catch (err) {
          toast(err?.message || 'Could not clear flag.', 'err');
        }
      });
    });
    feed.querySelectorAll('[data-flag-form]').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const rid = form.dataset.flagForm;
        const note = String(new FormData(form).get('note') || '').trim();
        try {
          const res = await api(`/api/loop-agent/runs/${encodeURIComponent(rid)}/flag`, {
            method: 'POST',
            body: JSON.stringify({ flagged: true, note }),
          });
          if (activeThread?.messages) {
            for (const m of activeThread.messages) {
              if (m.runId === rid) {
                m.flagged = true;
                m.flagNote = res?.trace?.flagNote || note;
              }
            }
          }
          flagOpenForRunId = '';
          toast('Run flagged for prompt review.', 'ok');
          renderMessagesOnly();
        } catch (err) {
          toast(err?.message || 'Could not flag run.', 'err');
        }
      });
    });
    feed.querySelectorAll('[data-approve-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.approveId;
        btn.disabled = true;
        try {
          await api(`/api/approvals/${encodeURIComponent(id)}/approve`, { method: 'POST', body: '{}' });
          toast('Approved.', 'ok');
        } catch (err) {
          toast(err?.message || 'Approval failed.', 'err');
          btn.disabled = false;
        }
      });
    });
    feed.querySelectorAll('[data-deny-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.denyId;
        btn.disabled = true;
        try {
          await api(`/api/approvals/${encodeURIComponent(id)}/deny`, { method: 'POST', body: '{}' });
          toast('Denied.', 'ok');
        } catch (err) {
          toast(err?.message || 'Could not deny.', 'err');
          btn.disabled = false;
        }
      });
    });
  }

  async function ensureActiveThread() {
    if (activeThread) return activeThread;
    const res = await api('/api/loop-agent/threads', {
      method: 'POST',
      body: JSON.stringify({
        project: activeProfile?.() || 'all',
        runner: selectedRunner,
        model: selectedModel,
      }),
    });
    activeThread = res.thread;
    uiState.loopChatThreadId = activeThread.id;
    writePref(ACTIVE_THREAD_KEY, activeThread.id);
    threads = [activeThread, ...threads.filter((t) => t.id !== activeThread.id)];
    return activeThread;
  }

  async function sendMessage(rawText) {
    const text = String(rawText || '').trim();
    if (!text || activeRunId) return;
    const cur = currentRunnerInfo();
    if (!cur?.available) {
      runnerPanelOpen = true;
      paint();
      toast('Connect a runner first.', 'err');
      return;
    }

    const thread = await ensureActiveThread();
    const optimisticUser = { id: `tmp_${Date.now()}`, role: 'user', text, steps: [], createdItems: [] };
    thread.messages = [...(thread.messages || []), optimisticUser];
    liveAssistant = { text: '', steps: [], createdItems: [], approvals: [], runId: '' };
    renderMessagesOnly();
    syncComposerState();

    const ac = new AbortController();
    activeStreamAbort = ac;

    try {
      const res = await streamFetch(`/api/loop-agent/threads/${encodeURIComponent(thread.id)}/runs`, {
        method: 'POST',
        body: JSON.stringify({
          message: text,
          runner: selectedRunner,
          model: selectedModel,
          effort: selectedEffort,
          project: activeProfile?.() || 'all',
          ...(focusedNodeId ? { focusedNodeId } : {}),
        }),
        signal: ac.signal,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData?.error || `HTTP ${res.status}`);
      }

      for await (const { event, data } of iterSseResponse(res)) {
        if (!isCurrent()) break;
        if (event === 'run_start') {
          activeRunId = data.runId || '';
          if (liveAssistant) liveAssistant.runId = activeRunId;
          if (data.userMessage) {
            thread.messages[thread.messages.length - 1] = data.userMessage;
          }
          syncComposerState();
        } else if (event === 'delta' && liveAssistant) {
          liveAssistant.text += String(data?.text || '');
          renderMessagesOnly();
        } else if (event === 'tool_start' && liveAssistant && data?.step) {
          liveAssistant.steps.push({ ...data.step, ok: null, durationMs: 0, output: '' });
          renderMessagesOnly();
        } else if (event === 'tool_end' && liveAssistant && data?.step) {
          const hit = liveAssistant.steps.find((s) => s.callId === data.step.callId);
          if (hit) Object.assign(hit, data.step);
          else liveAssistant.steps.push(data.step);
          renderMessagesOnly();
        } else if (event === 'item_created' && liveAssistant && data?.item) {
          if (!liveAssistant.createdItems.some((i) => i.id === data.item.id)) {
            liveAssistant.createdItems.push(data.item);
          }
          splitMapSelectedId = data.item.id;
          renderMessagesOnly();
          if (mapOpen) void mountOrRefreshSplitMap();
        } else if (event === 'approval' && liveAssistant && data?.approval) {
          if (!liveAssistant.approvals.some((a) => a.id === data.approval.id)) {
            liveAssistant.approvals.push(data.approval);
          }
          renderMessagesOnly();
        } else if (event === 'done') {
          if (data?.message) thread.messages.push(data.message);
          liveAssistant = null;
          activeRunId = '';
          if (thread.title === 'New chat') {
            thread.title = clip(text, 64);
            const row = threads.find((t) => t.id === thread.id);
            if (row) row.title = thread.title;
          }
          renderMessagesOnly();
          if (mapOpen) void mountOrRefreshSplitMap();
        } else if (event === 'error') {
          const msg = data?.error || 'Run failed.';
          if (data?.status !== 'stopped') {
            thread.messages.push({
              id: `err_${Date.now()}`,
              role: 'assistant',
              text: `Error: ${msg}`,
              runId: data?.runId || activeRunId,
              steps: liveAssistant?.steps || [],
              createdItems: liveAssistant?.createdItems || [],
            });
          }
          liveAssistant = null;
          activeRunId = '';
          renderMessagesOnly();
        }
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        toast(err?.message || 'Chat run failed.', 'err');
      }
      liveAssistant = null;
      activeRunId = '';
      renderMessagesOnly();
    } finally {
      activeStreamAbort = null;
      activeRunId = '';
      syncComposerState();
    }
  }

  async function stopRun() {
    const rid = activeRunId;
    activeStreamAbort?.abort();
    if (rid) {
      await api(`/api/loop-agent/runs/${encodeURIComponent(rid)}/stop`, { method: 'POST', body: '{}' }).catch(() => {});
    }
  }

  function syncComposerState() {
    const sendBtn = root.querySelector('#lc-send-btn');
    const stopBtn = root.querySelector('#lc-stop-btn');
    const input = root.querySelector('#lc-input');
    const busy = Boolean(activeRunId || liveAssistant);
    if (sendBtn) sendBtn.hidden = busy;
    if (stopBtn) stopBtn.hidden = !busy;
    if (input) input.disabled = busy;
  }

  function paint() {
    if (!isCurrent()) return;
    if (activeSplitGraph) {
      activeSplitGraph.destroy();
      activeSplitGraph = null;
    }
    const cur = currentRunnerInfo();
    const runnerLabel = cur ? `${cur.shortLabel}${selectedModel ? ` · ${selectedModel}` : ''}` : 'Select runner';

    root.innerHTML = `
      <section class="lc-page ${mapOpen ? 'is-split' : ''}" data-loop-chat-view>
        <div class="lc-shell">
          <header class="lc-head">
            <div class="lc-head-l">
              <button type="button" class="lc-pill-btn ${threadsOpen ? 'is-on' : ''}" data-toggle-threads>
                <span>${esc(clip(activeThread?.title || 'New chat', 28))}</span>
                ${ICON_CHEV}
              </button>
              <button type="button" class="lc-icon-btn" data-new-thread title="New chat" aria-label="New chat">${ICON_PLUS}</button>
            </div>
            <div class="lc-head-r">
              <button type="button" class="lc-pill-btn ${runnerPanelOpen ? 'is-on' : ''}" data-toggle-runners title="Select model or connect API key / MausBot">
                ${ICON_SLIDERS}
                <span>${esc(runnerLabel)}</span>
              </button>
              <button type="button" class="lc-pill-btn ${mapOpen ? 'is-on' : ''}" data-toggle-map aria-pressed="${mapOpen}">
                ${ICON_MAP}
                <span>${mapOpen ? 'Hide map' : 'Show map'}</span>
              </button>
            </div>
          </header>

          ${threadsDrawerHtml()}
          ${runnerPanelHtml()}

          <div class="lc-feed" id="lc-feed" role="log" aria-live="polite"></div>

          <footer class="lc-foot">
            <div class="lc-focus-slot" id="lc-focus-slot" hidden></div>
            <form class="lc-composer" id="lc-form">
              <textarea id="lc-input" rows="1" placeholder="Plan, research, or ask Loop to update your mind map…" aria-label="Message Loop"></textarea>
              <button type="submit" class="lc-send" id="lc-send-btn" aria-label="Send">${ICON_SEND}</button>
              <button type="button" class="lc-send is-stop" id="lc-stop-btn" aria-label="Stop" hidden>${ICON_STOP}</button>
            </form>
          </footer>
        </div>

        ${mapOpen ? `
          <aside class="lc-map-pane" aria-label="Live Library mind map">
            <div class="lc-map-bar">
              <span class="lc-map-title">Live Library map</span>
              <div class="lc-map-bar-r">
                <a class="lc-map-open" href="#knowledge${splitMapSelectedId ? `?focus=${encodeURIComponent(splitMapSelectedId)}` : ''}">Open Library</a>
                <button type="button" class="lc-map-fit" data-split-fit>Fit</button>
              </div>
            </div>
            <div class="lc-map-stage">
              <canvas id="lc-map-canvas" class="mem-brain-canvas" aria-label="Live Library mind map"></canvas>
              <div id="lc-map-layers" class="lc-map-layers"></div>
            </div>
          </aside>
        ` : ''}
      </section>
    `;

    renderMessagesOnly();
    renderFocusBadge();
    syncComposerState();
    wireHeaderAndComposer();
    if (mapOpen) void mountOrRefreshSplitMap();
  }

  function wireHeaderAndComposer() {
    root.querySelector('[data-toggle-map]')?.addEventListener('click', () => {
      mapOpen = !mapOpen;
      writePref(MAP_OPEN_KEY, mapOpen ? '1' : '0');
      paint();
    });

    root.querySelector('[data-toggle-runners]')?.addEventListener('click', () => {
      runnerPanelOpen = !runnerPanelOpen;
      threadsOpen = false;
      paint();
    });

    root.querySelector('[data-toggle-threads]')?.addEventListener('click', () => {
      threadsOpen = !threadsOpen;
      runnerPanelOpen = false;
      paint();
    });

    root.querySelectorAll('[data-new-thread]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const res = await api('/api/loop-agent/threads', {
            method: 'POST',
            body: JSON.stringify({
              project: activeProfile?.() || 'all',
              runner: selectedRunner,
              model: selectedModel,
            }),
          });
          activeThread = res.thread;
          uiState.loopChatThreadId = activeThread.id;
          writePref(ACTIVE_THREAD_KEY, activeThread.id);
          threads = [activeThread, ...threads.filter((t) => t.id !== activeThread.id)];
          threadsOpen = false;
          paint();
          root.querySelector('#lc-input')?.focus();
        } catch (err) {
          toast(err?.message || 'Could not create chat.', 'err');
        }
      });
    });

    root.querySelectorAll('[data-open-thread]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.openThread;
        try {
          const res = await api(`/api/loop-agent/threads/${encodeURIComponent(id)}`);
          activeThread = res.thread;
          uiState.loopChatThreadId = activeThread.id;
          writePref(ACTIVE_THREAD_KEY, activeThread.id);
          syncRunnerSelection(activeThread.runner || selectedRunner, activeThread.model || '');
          threadsOpen = false;
          paint();
        } catch (err) {
          toast(err?.message || 'Could not open chat.', 'err');
        }
      });
    });

    root.querySelectorAll('[data-del-thread]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.delThread;
        try {
          await api(`/api/loop-agent/threads/${encodeURIComponent(id)}`, { method: 'DELETE' });
          threads = threads.filter((t) => t.id !== id);
          if (activeThread?.id === id) {
            activeThread = null;
            uiState.loopChatThreadId = '';
            writePref(ACTIVE_THREAD_KEY, '');
            if (threads[0]) {
              const res = await api(`/api/loop-agent/threads/${encodeURIComponent(threads[0].id)}`).catch(() => null);
              activeThread = res?.thread || null;
            }
          }
          paint();
        } catch (err) {
          toast(err?.message || 'Could not delete chat.', 'err');
        }
      });
    });

    root.querySelectorAll('[data-pick-runner]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.pickRunner;
        try {
          caps = await api('/api/loop-agent/runners', {
            method: 'PUT',
            body: JSON.stringify({ defaultRunner: id }),
          });
          onCapabilitiesChange?.(caps);
          syncRunnerSelection(id);
          toast(`Switched runner to ${currentRunnerInfo()?.shortLabel || id}.`, 'ok');
          paint();
        } catch (err) {
          toast(err?.message || 'Could not switch runner.', 'err');
        }
      });
    });

    root.querySelector('[data-runner-model]')?.addEventListener('change', async (e) => {
      selectedModel = e.target.value;
      try {
        caps = await api('/api/loop-agent/runners', {
          method: 'PUT',
          body: JSON.stringify({ models: { [selectedRunner]: selectedModel } }),
        });
        paint();
      } catch (err) {
        toast(err?.message || 'Could not save model.', 'err');
      }
    });

    root.querySelector('[data-runner-effort]')?.addEventListener('change', async (e) => {
      selectedEffort = e.target.value;
      try {
        caps = await api('/api/loop-agent/runners', {
          method: 'PUT',
          body: JSON.stringify({ efforts: { [selectedRunner]: selectedEffort } }),
        });
      } catch (err) {
        toast(err?.message || 'Could not save effort.', 'err');
      }
    });

    root.querySelector('[data-apikey-form]')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const provider = String(fd.get('provider') || '');
      const key = String(fd.get('key') || '').trim();
      if (!key) return;
      try {
        caps = await api('/api/loop-agent/runners', {
          method: 'PUT',
          body: JSON.stringify({ defaultRunner: provider, apiKey: { provider, key } }),
        });
        onCapabilitiesChange?.(caps);
        syncRunnerSelection(provider);
        toast('API key saved in Vault.', 'ok');
        paint();
      } catch (err) {
        toast(err?.message || 'Could not save API key.', 'err');
      }
    });

    root.querySelectorAll('[data-remove-key]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const provider = btn.dataset.removeKey;
        try {
          caps = await api('/api/loop-agent/runners', {
            method: 'PUT',
            body: JSON.stringify({ removeApiKey: provider }),
          });
          onCapabilitiesChange?.(caps);
          syncRunnerSelection(caps.defaultRunner);
          toast('Key removed from Vault.', 'ok');
          paint();
        } catch (err) {
          toast(err?.message || 'Could not remove key.', 'err');
        }
      });
    });

    root.querySelector('[data-mausbot-form]')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const endpoint = String(fd.get('endpoint') || '').trim();
      const apiKey = String(fd.get('apiKey') || '').trim();
      try {
        caps = await api('/api/loop-agent/runners', {
          method: 'PUT',
          body: JSON.stringify({
            ...(endpoint ? { defaultRunner: 'mausbot' } : {}),
            mausbot: { endpoint, ...(apiKey ? { apiKey } : {}) },
          }),
        });
        onCapabilitiesChange?.(caps);
        if (endpoint) syncRunnerSelection('mausbot');
        toast('MausBot connection saved.', 'ok');
        paint();
      } catch (err) {
        toast(err?.message || 'Could not save MausBot settings.', 'err');
      }
    });

    root.querySelector('[data-clear-mausbot]')?.addEventListener('click', async () => {
      try {
        caps = await api('/api/loop-agent/runners', {
          method: 'PUT',
          body: JSON.stringify({ mausbot: { clear: true } }),
        });
        onCapabilitiesChange?.(caps);
        syncRunnerSelection(caps.defaultRunner);
        toast('MausBot removed.', 'ok');
        paint();
      } catch (err) {
        toast(err?.message || 'Could not remove MausBot.', 'err');
      }
    });

    root.querySelector('[data-split-fit]')?.addEventListener('click', () => {
      activeSplitGraph?.fitView(true);
    });

    root.querySelector('#lc-map-layers')?.addEventListener('click', async (e) => {
      const layer = e.target.closest?.('[data-lib-layer]')?.dataset.libLayer;
      if (!layer) return;
      lib.set(layer, !lib.has(layer));
      await mountOrRefreshSplitMap();
    });

    const form = root.querySelector('#lc-form');
    const input = root.querySelector('#lc-input');
    const autoSize = () => {
      if (!input) return;
      input.style.height = 'auto';
      input.style.height = `${Math.min(180, Math.max(40, input.scrollHeight))}px`;
    };
    input?.addEventListener('input', autoSize);
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form?.requestSubmit();
      }
    });
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = input?.value || '';
      if (!val.trim()) return;
      input.value = '';
      autoSize();
      void sendMessage(val);
    });
    root.querySelector('#lc-stop-btn')?.addEventListener('click', () => void stopRun());
  }

  root.innerHTML = `<section class="lc-page"><div class="lc-shell"><div class="loading" role="status"><div class="spin" aria-hidden="true"></div><p>Loading Loop…</p></div></div></section>`;
  const ok = await loadInitial().catch((err) => {
    toast(err?.message || 'Could not load Loop chat.', 'err');
    return false;
  });
  if (!ok || !isCurrent()) return;
  paint();
  root.querySelector('#lc-input')?.focus();
}
