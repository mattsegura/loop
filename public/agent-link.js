// The page behind an agent's link (useloop.sh/a/<id>#<code>): who sent it, what the agent can use, and
// one button. The code is in the part after #, so it never reaches a server log. To look at the page
// does not use the link; the terminal command, or "Another app", uses it one time.
import { agentMark, kindLabel, INSTALL_KINDS } from './agent-mark.js';
import { HOST_KINDS, hostSetup, hostSetupHtml } from './host-setup.js';

const POLL_MS = 2500;
const card = typeof document !== 'undefined' ? document.getElementById('card') : null;
const foot = typeof document !== 'undefined' ? document.getElementById('foot') : null;
const id = typeof location !== 'undefined' ? ((location.pathname.match(/^\/a\/([a-z0-9]+)\/?$/i) || [])[1] || '') : '';
const claimCode = typeof location !== 'undefined' ? decodeURIComponent(location.hash.slice(1)) : '';

let link = null; // what /api/agent-handoff/preview said
let kind = ''; // the app the receiver adds it to
let claimed = null; // the address and key, only for "Another app"
let timer = null;
let state = 'look'; // look, pick, command, key, added, connected

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (body) => `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  plug: svg('<path d="M7 3.5v4M13 3.5v4M5 7.5h10v2.5a5 5 0 0 1-10 0z"/><path d="M10 15v2.5"/>'),
  skill: svg('<path d="M10 2.8l1.7 5.5 5.5 1.7-5.5 1.7L10 17.2l-1.7-5.5L2.8 10l5.5-1.7z"/>'),
  memory: svg('<path d="M3.5 7L10 3.5 16.5 7 10 10.5z"/><path d="M3.5 10.5L10 14l6.5-3.5"/><path d="M3.5 14L10 17.5l6.5-3.5"/>'),
  lock: svg('<rect x="4.5" y="9" width="11" height="8" rx="2"/><path d="M7 9V7a3 3 0 0 1 6 0v2"/>'),
  go: svg('<path d="M8 5l5 5-5 5"/>'),
};

async function call(what, body = {}) {
  const res = await fetch(`/api/agent-handoff/${what}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, claimCode, ...body }),
    cache: 'no-store',
    credentials: 'omit',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Loop did not answer. Try again.'), { status: res.status });
  return data;
}

const sender = () => link?.from || 'the person who sent it';
const command = () => `curl -fsSL ${location.origin}/connect.mjs | node - --claim ${claimCode}${kind && kind !== 'other' ? ` --agents ${kind}` : ''}`;

function draw(html, { focus = true } = {}) {
  card.innerHTML = html;
  const h = card.querySelector('h1');
  if (focus && h) {
    h.tabIndex = -1;
    h.focus({ preventScroll: true });
  }
}

function drawEnd(title, text) {
  clearTimeout(timer);
  foot.textContent = '';
  draw(`<h1>${esc(title)}</h1><p class="sub">${esc(text)}</p><a class="btn" href="/">Go to Loop</a>`);
}

export function rowsHtml({ agent, from }) {
  const row = (icon, t, v) => `<li>${icon}<span class="t">${esc(t)}</span><span class="v">${esc(v)}</span></li>`;
  const rows = [];
  if (agent.connectionCount > 0) {
    const rest = agent.connectionCount - agent.connections.length;
    const names = rest > 0 ? `${agent.connections.join(', ')} and ${rest} more` : agent.connections.join(' and ');
    const base = `${agent.connectionCount} ${agent.connectionCount === 1 ? 'connection' : 'connections'}`;
    rows.push(row(ICONS.plug, names, agent.futureConnections ? `${base} + future` : base));
  } else if (agent.futureConnections) {
    rows.push(row(ICONS.plug, 'Connections', 'Any added later'));
  }
  if (agent.skillCount > 0) {
    rows.push(row(ICONS.skill, 'Skills', agent.futureSkills ? `${agent.skillCount} + future` : agent.skillCount));
  } else if (agent.futureSkills) {
    rows.push(row(ICONS.skill, 'Skills', 'Any added later'));
  }
  if (agent.canManage) {
    rows.push(row(ICONS.plug, 'Manage connections', 'Add, change and remove'));
  }
  if (agent.memoryAccess !== 'none') rows.push(row(ICONS.memory, 'Memory', agent.memoryAccess === 'read' ? 'Read' : 'Read and save'));
  for (const item of agent.vault || []) {
    const asks = from ? `Asks ${from}` : 'Asks the owner';
    rows.push(row(ICONS.lock, item.name, item.mode === 'guard' ? 'Guard' : item.mode === 'always_ask' ? asks : 'Allow'));
  }
  return rows.length ? `<ul class="rows">${rows.join('')}</ul>` : '<p class="sub">Nothing is shared with it yet.</p>';
}

function drawLook() {
  const { agent } = link;
  const app = kind === 'other' ? '' : kindLabel(kind);
  const from = [link.from ? `From ${link.from}` : '', app ? `for ${app}` : ''].filter(Boolean).join(', ');
  const expires = link.expiresAt ? new Date(link.expiresAt).toLocaleString() : '';
  foot.textContent = `One use${expires ? `, expires ${expires}` : ''}. ${link.from || 'Its owner'} can turn ${agent.name} off at any time.`;
  document.title = `Add ${agent.name} · Loop`;
  draw(`
    ${agentMark(agent, esc)}
    <h1>Add ${esc(agent.name)}</h1>
    ${from ? `<p class="sub">${esc(from.charAt(0).toUpperCase() + from.slice(1))}</p>` : ''}
    ${rowsHtml(link)}
    <button type="button" class="btn" data-do="${HOST_KINDS.includes(kind) ? 'host' : app ? 'command' : 'pick'}">${app ? `Add to ${esc(app)}` : 'Pick an app'}</button>
    ${app ? '<button type="button" class="alt" data-do="pick">Use a different app</button>' : ''}`);
}

function drawPick() {
  draw(`
    <h1>Where do you use ${esc(link.agent.name)}?</h1>
    <ul class="pick">
      ${[...HOST_KINDS, ...INSTALL_KINDS].map((k) => `<li><button type="button" data-kind="${k}">${agentMark({ kind: k, name: kindLabel(k) }, esc)}<span>${esc(kindLabel(k))}</span><span class="go">${ICONS.go}</span></button></li>`).join('')}
      <li><button type="button" data-do="key">${agentMark({ name: '+' }, esc)}<span>Another app</span><span class="go">${ICONS.go}</span></button></li>
    </ul>
    <button type="button" class="alt" data-do="look">Back</button>`);
}

function drawCommand() {
  const app = kindLabel(kind);
  draw(`
    ${agentMark(link.agent, esc)}
    <h1>Add ${esc(link.agent.name)} to ${esc(app)}</h1>
    <p class="sub">Run this in a terminal on the computer that has ${esc(app)}. It needs Node.js.</p>
    <div class="code"><pre>${esc(command())}</pre><button type="button" data-do="copy">Copy</button></div>
    <div class="wait" role="status"><span class="pulse" aria-hidden="true"></span><span>Loop waits for the command.</span></div>
    <button type="button" class="alt" data-do="pick">Use a different app</button>`);
}

function drawKey() {
  if (HOST_KINDS.includes(kind)) {
    const setup = hostSetup(kind, claimed?.mcp_url || link.mcpUrl, true);
    draw(`<h1>Connect ${esc(kindLabel(kind))}</h1>
      ${hostSetupHtml(setup, esc)}
      ${setup && !claimed ? '<button type="button" class="btn" data-do="claim-host">Get the shared credential</button>' : ''}
      ${setup && claimed ? `<button type="button" class="btn" data-host-copy="key">Copy ${setup.rawKey ? 'key' : 'Authorization value'}</button>
        <p class="note" role="status">Waiting for this agent to contact Loop.</p>` : ''}
      ${!claimed ? '<button type="button" class="alt" data-do="pick">Use a different app</button>' : ''}`);
    return;
  }
  const text = `URL: ${claimed.mcp_url}\nAuthorization: Bearer ${claimed.access_token}`;
  draw(`
    ${agentMark(link.agent, esc)}
    <h1>${esc(link.agent.name)} is yours</h1>
    <p class="sub">Put this in the MCP settings of your app. Loop shows the key one time.</p>
    <div class="code"><pre>${esc(text)}</pre><button type="button" data-do="copy">Copy</button></div>
    <p class="note">Anyone with this key can use ${esc(link.agent.name)}. Keep it like a password.</p>
    <div class="wait" role="status"><span class="pulse" aria-hidden="true"></span><span>Loop waits for ${esc(link.agent.name)}.</span></div>`);
}

function drawAdded(connected) {
  const app = kind && kind !== 'other' ? kindLabel(kind) : 'your app';
  draw(`
    ${agentMark(link.agent, esc)}
    <h1>${esc(link.agent.name)} is ${connected ? 'connected' : 'added'}</h1>
    <p class="sub">${connected ? `It can use what ${esc(sender())} shared.` : `Restart ${esc(app)} to use it.`}</p>
    <div class="wait ${connected ? 'is-ok' : ''}" role="status"><span class="pulse" aria-hidden="true"></span><span>${connected ? 'You can close this page.' : `Loop waits for ${esc(link.agent.name)}.`}</span></div>`);
}

function show(next) {
  state = next;
  if (next === 'look') drawLook();
  else if (next === 'pick') drawPick();
  else if (next === 'command') drawCommand();
  else if (next === 'key' || next === 'host') drawKey();
  else drawAdded(next === 'connected');
  if (['command', 'key', 'added'].includes(next)) poll();
}

// After the command or the key, wait until the agent is added and then connected.
function poll() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      const now = await call('status');
      if (now.connected && state !== 'connected') return show('connected');
      if (now.claimed && state === 'command') return show('added');
    } catch (err) {
      if (err.status === 404 && state === 'command') return drawEnd('This link has ended', `Ask ${sender()} for a new one.`);
    }
    if (['command', 'key', 'added'].includes(state)) poll();
  }, POLL_MS);
}

async function takeKey(btn) {
  btn.disabled = true;
  try {
    claimed = await call('claim', { clientId: kind || 'other' });
    show('key');
  } catch (err) {
    if (err.status === 409 || err.status === 404) return drawEnd('This link has ended', `Ask ${sender()} for a new one.`);
    btn.disabled = false;
    foot.textContent = err.message;
  }
}

async function start() {
  if (!id || !claimCode) return drawEnd('This link is not complete', 'Open the full link again, or ask for a new one.');
  try {
    link = await call('preview');
  } catch (err) {
    if (err.status === 404 || err.status === 400 || err.status === 410) return drawEnd('This link has ended', 'Ask for a new link.');
    return drawEnd('Loop cannot open this link', err.message);
  }
  kind = [...INSTALL_KINDS, ...HOST_KINDS].includes(link.agent.kind) ? link.agent.kind : 'other';
  if (link.claimed) return drawEnd('This link was used', `A link works one time. Ask ${sender()} for a new one.`);
  show('look');
}

if (card) {
  card.addEventListener('click', async (e) => {
    const app = e.target.closest('[data-kind]');
    if (app) {
      kind = app.dataset.kind;
      return show(HOST_KINDS.includes(kind) ? 'host' : 'command');
    }
    const hostBtn = e.target.closest('[data-host-copy]');
    if (hostBtn) {
      const setup = hostSetup(kind, claimed?.mcp_url || link.mcpUrl, true);
      if (!setup) return;
      const field = hostBtn.dataset.hostCopy;
      const value = field === 'key' && claimed
        ? (setup.rawKey ? claimed.access_token : `Bearer ${claimed.access_token}`) : setup[field];
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        foot.textContent = 'Copied.';
      } catch {
        const field = document.createElement('textarea');
        field.readOnly = true;
        field.setAttribute('aria-label', 'Select and copy this value');
        field.value = value;
        hostBtn.after(field);
        field.select();
        field.addEventListener('blur', () => field.remove(), { once: true });
      }
      return;
    }
    const btn = e.target.closest('[data-do]');
    if (!btn) return;
    const what = btn.dataset.do;
    if (what === 'key') { kind = 'other'; return takeKey(btn); }
    if (what === 'claim-host') return takeKey(btn);
    if (what !== 'copy') return show(what);
    try {
      await navigator.clipboard.writeText(card.querySelector('.code pre').textContent);
      btn.textContent = 'Copied';
      setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy'; }, 2000);
    } catch {
      getSelection().selectAllChildren(card.querySelector('.code pre'));
    }
  });
  start();
}
