// Invite page for useloop.sh/j/<code>: who invited you, what you get, one button.
// After sign-in it mints a key for one agent and waits until that agent connects.
import { getAuthStatus, withAuthTimeout } from './clerk-app.js';
import { clerkColors } from './core/tone.js';

const card = typeof document !== 'undefined' ? document.getElementById('card') : null;
const code = typeof location !== 'undefined' ? (location.pathname.match(/^\/j\/([A-Za-z0-9]+)\/?$/) || [])[1] || '' : '';
const AGENTS = [
  { id: 'claude', label: 'Claude Code', mark: '✳' },
  { id: 'codex', label: 'Codex', mark: '◎' },
  { id: 'cursor', label: 'Cursor', mark: '▲' },
  { id: 'other', label: 'Other', mark: '{ }' },
];
const VALID_KINDS = new Set(AGENTS.map((a) => a.id));
let clerk = null;
let invite = null;
let agentKind = 'claude';
let minted = null;
let pollTimer = null;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (v) => String(v || 'shared').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shared';

export function joinStorageKey(joinCode) {
  return `loop.join.${String(joinCode || '').trim()}`;
}

export function readJoinDraft(joinCode, storage = globalThis.sessionStorage) {
  if (!joinCode || !storage) return { kind: 'claude', minted: null };
  try {
    const raw = JSON.parse(storage.getItem(joinStorageKey(joinCode)) || 'null');
    const kind = VALID_KINDS.has(raw?.kind) ? raw.kind : 'claude';
    const savedMinted = raw?.minted?.agentId && raw?.minted?.token && raw?.minted?.mcpUrl ? raw.minted : null;
    return { kind, minted: savedMinted };
  } catch {
    return { kind: 'claude', minted: null };
  }
}

export function writeJoinDraft(joinCode, patch, storage = globalThis.sessionStorage) {
  if (!joinCode || !storage) return;
  try {
    const prev = readJoinDraft(joinCode, storage);
    const next = {
      kind: VALID_KINDS.has(patch?.kind) ? patch.kind : prev.kind,
      minted: patch && Object.hasOwn(patch, 'minted') ? patch.minted : prev.minted,
    };
    storage.setItem(joinStorageKey(joinCode), JSON.stringify(next));
  } catch {
    // Ignore storage quota or private-mode errors.
  }
}

export function clearJoinDraft(joinCode, storage = globalThis.sessionStorage) {
  if (!joinCode || !storage) return;
  try {
    storage.removeItem(joinStorageKey(joinCode));
  } catch {
    // Ignore storage errors.
  }
}

export function pickAgentTitle(inv) {
  const me = inv?.kind === 'me' || inv?.isOwner;
  const name = inv?.profile?.name || 'this project';
  if (me) return `Connect an agent to ${name}`;
  return inv?.joined ? `You’re in ${name}` : `Join ${name}`;
}

export function pollStatusAction(err) {
  const status = Number(err?.status || 0);
  if (status === 404 || status === 403 || status === 410) return 'revoked';
  return 'retry';
}

function loadScript(src, publishableKey) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    if (publishableKey) s.dataset.clerkPublishableKey = publishableKey;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load sign-in'));
    document.head.appendChild(s);
  });
}

async function loadClerk(status, withUi) {
  const origin = new URL(status.frontendApi).origin;
  if (withUi && !window.__internal_ClerkUICtor) await loadScript(`${origin}/npm/@clerk/ui@1/dist/ui.browser.js`);
  if (!window.Clerk) await loadScript(`${origin}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, status.publishableKey);
  const c = window.Clerk;
  if (!c.loaded) {
    const here = location.origin + location.pathname;
    await withAuthTimeout(c.load({
      ...(withUi ? { ui: { ClerkUI: window.__internal_ClerkUICtor } } : {}),
      signInForceRedirectUrl: here,
      signUpForceRedirectUrl: here,
      afterSignOutUrl: here,
      telemetry: false,
    }));
  }
  return c;
}

async function call(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (clerk?.session) headers.Authorization = `Bearer ${await withAuthTimeout(clerk.session.getToken())}`;
  const res = await fetch(path, { ...opts, headers, credentials: 'same-origin', cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
  return data;
}

function connectionsHtml(names, meta = 'ready to use') {
  if (!names.length) return '<div class="row"><span class="m left">No connections in this project yet.</span></div>';
  return names.map((n) => `<div class="row"><span class="mk">${esc(n.slice(0, 1))}</span>${esc(n)}<span class="m ${meta === '● ready' ? 'okdot' : ''}">${esc(meta)}</span></div>`).join('');
}

function renderError(msg) {
  card.innerHTML = `<h1 class="h sm">Invite unavailable</h1><p class="sub err sub-gap">${esc(msg)}</p>
    <a class="btn out wide" href="/">Go to Loop</a>`;
}

function renderInvite() {
  const me = invite.kind === 'me';
  const owner = invite.ownerName || 'A Loop user';
  card.innerHTML = `
    <div class="head"><span class="av">${esc(owner.slice(0, 1).toUpperCase())}</span>
      <div><p class="sub tight">${me ? `Connect another of ${esc(owner)}’s agents to` : `${esc(owner)} invited you to`}</p><h1 class="h">${esc(invite.profile.name)}</h1></div></div>
    <div class="list">${connectionsHtml(invite.profile.connections)}</div>
    <div id="auth-slot"></div>
    <button class="btn pri wide" type="button" id="join-btn">${me ? 'Sign in to continue' : 'Join'}</button>
    <p class="fine">${me ? 'Sign in as yourself to add another agent.' : `Free. Joining makes a Loop account for you.<br>${esc(owner)}’s keys stay hidden. You can leave anytime.`}</p>`;
  document.getElementById('join-btn').onclick = () => startSignIn();
}

async function startSignIn() {
  const btn = document.getElementById('join-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Opening sign-in…'; }
  try {
    const status = await getAuthStatus();
    clerk = await loadClerk(status, true);
    if (clerk.user) return afterSignIn();
    const slot = document.getElementById('auth-slot');
    btn?.remove();
    slot.className = 'signin';
    clerk.mountSignIn(slot, {
      routing: 'hash',
      withSignUp: true, // a new account is made in the same form, so it comes back here
      forceRedirectUrl: location.origin + location.pathname,
      signUpForceRedirectUrl: location.origin + location.pathname,
      appearance: { variables: { ...clerkColors('#FFFFFF'), borderRadius: '12px', fontFamily: 'inherit' } },
    });
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
    toastErr(err.message);
  }
}

function toastErr(msg) {
  let el = document.getElementById('join-err');
  if (!el) {
    el = document.createElement('p');
    el.id = 'join-err';
    el.className = 'fine err';
    card.appendChild(el);
  }
  el.textContent = msg;
}

async function afterSignIn() {
  try {
    invite = await call(`/api/join/${code}`);
  } catch (err) {
    clearJoinDraft(code);
    return renderError(err.message);
  }
  if (invite.kind === 'me' && !invite.isOwner) {
    clearJoinDraft(code);
    return renderError(`This link is only for ${invite.ownerName || 'its owner'}’s own agents. Ask them for an invite link instead.`);
  }
  const saved = readJoinDraft(code);
  agentKind = saved.kind;
  if (saved.minted) {
    try {
      const status = await call(`/api/join/${code}/agents/${encodeURIComponent(saved.minted.agentId)}`);
      minted = saved.minted;
      if (status.connected) {
        writeJoinDraft(code, { kind: agentKind, minted: null });
        return renderConnected();
      }
      return renderCommand();
    } catch (err) {
      if (pollStatusAction(err) === 'revoked') {
        clearJoinDraft(code);
        return renderError('This invite or access was revoked by the owner.');
      }
      minted = saved.minted;
      return renderCommand();
    }
  }
  renderPickAgent();
}

function commandFor(kind, token, url, name) {
  if (kind === 'claude') return `claude mcp add --transport http --scope user ${name} ${url} --header "Authorization: Bearer ${token}"`;
  if (kind === 'codex') return `[mcp_servers.${name}]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }`;
  if (kind === 'cursor') return JSON.stringify({ mcpServers: { [name]: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  return `URL:    ${url}\nHeader: Authorization: Bearer ${token}`;
}

function howTo(kind) {
  if (kind === 'claude') return 'Paste it in your terminal, then restart Claude Code. That’s it.';
  if (kind === 'codex') return 'Add it to <code>~/.codex/config.toml</code>, then restart Codex.';
  if (kind === 'cursor') return 'Add it to <code>~/.cursor/mcp.json</code> (merge into mcpServers if you have one), then reload Cursor.';
  return 'Add a remote MCP server in your app with this URL and header.';
}

function renderPickAgent() {
  const heading = pickAgentTitle(invite);
  const joined = Boolean(invite.joined || invite.kind === 'me' || invite.isOwner);
  card.innerHTML = `
    <div class="head"><span class="check">${joined ? '✓' : '→'}</span><h1 class="h sm">${esc(heading)}</h1></div>
    <p class="sub sub-gap">Last step: pick the agent you want to connect to ${esc(invite.profile.name)}.</p>
    <div class="tabs" role="tablist">${AGENTS.map((a) => `<button class="tab" role="tab" type="button" data-kind="${a.id}" aria-selected="${a.id === agentKind}">${esc(a.mark)} ${esc(a.label)}</button>`).join('')}</div>
    <button class="btn pri wide" type="button" id="mint-btn">Get my ${esc(AGENTS.find((a) => a.id === agentKind).label)} setup</button>
    <p class="fine">This makes a key just for this agent. Remove it or leave anytime in Settings.</p>`;
  card.querySelectorAll('[data-kind]').forEach((b) => {
    b.onclick = () => {
      agentKind = b.dataset.kind;
      writeJoinDraft(code, { kind: agentKind });
      renderPickAgent();
    };
  });
  document.getElementById('mint-btn').onclick = mint;
}

async function mint() {
  const btn = document.getElementById('mint-btn');
  btn.disabled = true;
  btn.textContent = 'Making your key…';
  try {
    const u = clerk?.user;
    minted = await call(`/api/join/${code}/agents`, {
      method: 'POST',
      body: JSON.stringify({
        kind: agentKind,
        name: u?.fullName || u?.firstName || (u?.primaryEmailAddress?.emailAddress || '').split('@')[0] || '',
        email: u?.primaryEmailAddress?.emailAddress || '',
      }),
    });
    invite = { ...invite, joined: true };
    writeJoinDraft(code, { kind: agentKind, minted });
    renderCommand();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Try again';
    toastErr(err.message);
  }
}

function renderCommand() {
  const name = `loop-${slug(invite.profile.name)}`;
  const text = commandFor(agentKind, minted.token, minted.mcpUrl, name);
  const label = AGENTS.find((a) => a.id === agentKind).label;
  card.innerHTML = `
    <div class="head"><span class="check">✓</span><h1 class="h sm">Add ${esc(invite.profile.name)} to ${esc(label)}</h1></div>
    <div class="code"><pre id="cmd">${esc(text)}</pre><button class="copy" type="button" id="copy">Copy</button></div>
    <p class="note">${howTo(agentKind)} This holds your agent’s key, so treat it like a password.</p>
    <div class="wait" id="wait"><span class="pulse"></span>Waiting for ${esc(label)} to connect…<span class="m">updates live</span></div>`;
  document.getElementById('copy').onclick = async (e) => {
    try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Select and copy'; }
  };
  poll();
}

function poll() {
  clearTimeout(pollTimer);
  const started = Date.now();
  const tick = async () => {
    try {
      const s = await call(`/api/join/${code}/agents/${encodeURIComponent(minted.agentId)}`);
      if (s.connected) {
        writeJoinDraft(code, { kind: agentKind, minted: null });
        return renderConnected();
      }
    } catch (err) {
      if (pollStatusAction(err) === 'revoked') {
        clearTimeout(pollTimer);
        minted = null;
        clearJoinDraft(code);
        return renderError('This invite or access was revoked by the owner.');
      }
      // Keep waiting quietly on transient network errors; never drop the command.
    }
    if (Date.now() - started < 15 * 60 * 1000) pollTimer = setTimeout(tick, 2500);
  };
  pollTimer = setTimeout(tick, 2500);
}

function renderConnected() {
  const label = AGENTS.find((a) => a.id === agentKind).label;
  const shared = invite.kind === 'other' && !invite.isOwner;
  card.innerHTML = `
    <div class="head"><span class="check">✓</span><div><h1 class="h sm">${esc(label)} is connected</h1>
      <p class="sub sub-sm">Using ${esc(invite.profile.name)}${shared ? ` · shared by ${esc(invite.ownerName)}` : ''}</p></div></div>
    <div class="list">${connectionsHtml(invite.profile.connections, '● ready')}</div>
    <div class="done-acts">
      <button class="btn out" type="button" id="another">Add another agent</button>
      <a class="btn pri" href="/">Open my Loop</a>
    </div>
    ${shared ? '<p class="fine"><button type="button" class="btn out" id="leave-project">Leave project</button></p>' : ''}`;
  document.getElementById('another').onclick = () => {
    minted = null;
    writeJoinDraft(code, { kind: agentKind, minted: null });
    renderPickAgent();
  };
  document.getElementById('leave-project')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Leaving…';
    try {
      const res = await call('/api/shares/with-me');
      const match = (res?.shared || []).find((s) => s.code === code || s.profile === invite.profile.name);
      if (!match?.id) throw new Error('Could not find this shared project.');
      await call(`/api/shares/with-me/${encodeURIComponent(match.id)}`, { method: 'DELETE' });
      clearJoinDraft(code);
      renderError(`You left ${invite.profile.name}. Your agent keys for it were revoked.`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Leave project';
      toastErr(err.message);
    }
  });
}

async function boot() {
  if (!code) return renderError('This invite link is not valid.');
  let status = null;
  try {
    status = await getAuthStatus();
  } catch {
    status = null;
  }
  // Load Clerk quietly to learn whether this visitor is already signed in.
  if (status?.publishableKey) {
    try {
      clerk = await loadClerk(status, true);
    } catch {
      clerk = null;
    }
  }
  try {
    invite = await call(`/api/join/${code}`);
  } catch (err) {
    return renderError(err.message);
  }
  if (clerk?.user) return afterSignIn();
  renderInvite();
  if (location.hash.startsWith('#/')) startSignIn();
}

if (card) boot();
