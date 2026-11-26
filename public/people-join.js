// The page behind a person's link (useloop.sh/p/<id>#<code>). It shows what somebody's Loop starts with,
// then the sign-ins of the services in it, then where the person wants their Loop. The code is in the part
// after #, so it never reaches a server log. To look at the page does not use the link; to go on uses it one
// time, for the account that is signed in. The person gets their own Loop: their accounts stay theirs.
// The sign-in of a service leaves this page and returns to it through the dashboard (takeInviteReturn in app.js).
import { getAuthStatus, withAuthTimeout } from './clerk-app.js';
import { clerkColors } from './core/tone.js';

const card = document.getElementById('card');
const foot = document.getElementById('foot');
const id = (location.pathname.match(/^\/p\/([a-z0-9]{14})\/?$/) || [])[1] || '';
const HERE = location.origin + location.pathname;
const KEPT = `loop_person_${id}`; // sign-in changes the address, so the code waits in this tab
const RETURN = 'loop_invite_return'; // where the dashboard sends the browser after a sign-in
const RETURN_ERROR = 'loop_invite_error'; // what it says when that sign-in did not work
const CODE = /^[a-z0-9]{20}$/;

// Where each choice goes in the new Loop. `text` is there only when this Loop has a phone number.
const PLACES = {
  text: { name: 'Loop Agent', value: 'iMessage', mark: '/favicon.svg', to: '/#settings?tab=text' },
  'claude-code': { name: 'Claude Code', mark: '/agent-logos/claude.svg', to: '/#home?add=claude-code' },
  codex: { name: 'Codex', mark: '/agent-logos/codex.svg', to: '/#home?add=codex' },
  more: { name: 'More apps', mark: '', to: '/#home?add=more' },
};

let invite = null; // what /api/people/preview said
let clerk = null;
let clerkReady = null;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (body, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const SKILL = svg('<path d="M10 2.8l1.7 5.5 5.5 1.7-5.5 1.7L10 17.2l-1.7-5.5L2.8 10l5.5-1.7z"/>');
const PLUS = svg('<path d="M10 4v12M4 10h12"/>');
const GO = svg('<path d="M8 5l5 5-5 5"/>', 14);
const isImage = (url) => /^data:image\/[a-z.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(String(url || ''));

/* ---------- the code, kept for the time of the sign-in ---------- */
function readKept() {
  try {
    const kept = JSON.parse(sessionStorage.getItem(KEPT) || 'null');
    return kept && (CODE.test(kept.code) || /^[0-9a-f]{16}$/.test(kept.joined)) ? kept : null;
  } catch {
    return null;
  }
}
function keep(value) {
  try {
    if (value) sessionStorage.setItem(KEPT, JSON.stringify(value));
    else sessionStorage.removeItem(KEPT);
  } catch { /* the tab keeps nothing: the person opens the link again after sign-in */ }
}
const inHash = location.hash.slice(1);
if (CODE.test(inHash) && !readKept()?.joined) keep({ code: inHash });
const code = CODE.test(inHash) ? inHash : readKept()?.code || '';
// A link from a Loop on one computer holds its list, and this page is in the Loop of the person.
const startData = location.pathname === '/p/' && /^s1\.[A-Za-z0-9_-]+$/.test(inHash) ? inHash : '';

/* ---------- calls ---------- */
async function request(route, body) {
  const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
  if (clerk?.session) headers.Authorization = `Bearer ${await withAuthTimeout(clerk.session.getToken())}`;
  const res = await fetch(route, {
    headers, cache: 'no-store', credentials: 'same-origin', ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Loop did not answer. Try again.'), { status: res.status, code: data.code, broken: data.signInBroken === true });
  return data;
}
const call = (what) => request(`/api/people/${what}`, { id, code });

function loadScript(src, publishableKey) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    if (publishableKey) s.dataset.clerkPublishableKey = publishableKey;
    s.onload = () => resolve();
    s.onerror = () => { s.remove(); reject(new Error('Could not load sign-in')); };
    document.head.appendChild(s);
  });
}

// Sign-in returns to this page. A failed load can be tried again.
function loadClerk() {
  clerkReady ||= (async () => {
    const status = await getAuthStatus();
    const origin = new URL(status.frontendApi).origin;
    if (!window.__internal_ClerkUICtor) await withAuthTimeout(loadScript(`${origin}/npm/@clerk/ui@1/dist/ui.browser.js`));
    if (!window.Clerk) await withAuthTimeout(loadScript(`${origin}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, status.publishableKey));
    const c = window.Clerk;
    if (!c.loaded) {
      await withAuthTimeout(c.load({
        ui: { ClerkUI: window.__internal_ClerkUICtor },
        signInForceRedirectUrl: HERE, signUpForceRedirectUrl: HERE, afterSignOutUrl: HERE, telemetry: false,
      }));
    }
    clerk = c;
    return c;
  })().catch((err) => { clerkReady = null; throw err; });
  return clerkReady;
}

/* ---------- what the page shows ---------- */
const owner = () => invite?.owner || 'Somebody';
const accountName = () => clerk?.user?.firstName || clerk?.user?.fullName || clerk?.user?.primaryEmailAddress?.emailAddress || '';

function draw(html) {
  card.innerHTML = html;
  const h = card.querySelector('h1');
  if (!h) return;
  h.tabIndex = -1;
  h.focus({ preventScroll: true });
}

// Who is signed in, and the way to another account.
function drawFoot(text, { change = true } = {}) {
  const name = accountName();
  foot.textContent = [text, name && `You are signed in as ${name}.`].filter(Boolean).join(' ');
  if (!change || !clerk?.user) return;
  if (foot.textContent) foot.append(' ');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lnk';
  btn.textContent = 'Change account';
  btn.addEventListener('click', () => changeAccount(btn));
  foot.append(btn);
}

// Signs out here. The link is not used by that: the page opens again and asks for the sign-in.
async function changeAccount(btn) {
  btn.disabled = true;
  const kept = readKept();
  if (kept?.go) keep({ code: kept.code });
  try {
    await withAuthTimeout(clerk.signOut({ redirectUrl: HERE }));
    location.replace(HERE);
  } catch {
    btn.disabled = false;
    const err = card.querySelector('.err');
    if (err) err.textContent = 'Sign-out does not answer. Try again.';
  }
}

function drawEnd(title, text, button = '<a class="btn" href="/">Go to Loop</a>') {
  foot.textContent = '';
  draw(`<h1>${esc(title)}</h1><p class="sub">${esc(text)}</p>${button}`);
}
const drawEnded = () => {
  keep(null);
  drawEnd('This link has ended', `Ask ${invite?.owner || 'the person who sent it'} for a new one. If you used it before, your things are in your Loop.`);
};

const line = ({ icon, name, under = '', whole = false, value = '', more = '' }) => `${icon}<span class="tx"><span class="t">${esc(name)}</span>${under ? `<span class="h${whole ? ' is-whole' : ''}">${esc(under)}</span>` : ''}</span>${value ? `<span class="v">${esc(value)}</span>` : ''}${more}`;

// An own sign-in says which service it goes to, so that a name cannot hide another one.
function startsWith() {
  const conns = invite.items.filter((i) => i.kind === 'connection');
  const skills = invite.items.filter((i) => i.kind === 'skill');
  const rows = conns.map((i) => line({
    icon: iconOf(i),
    name: i.name,
    whole: true,
    under: i.mode === 'own' ? i.host : `${owner()} sees what your agents do in it`,
    value: i.mode === 'mine' ? `From ${owner()}` : 'You sign in',
  }));
  if (skills.length) {
    rows.push(line({
      icon: `<span class="ic" aria-hidden="true">${SKILL}</span>`,
      name: skills.length === 1 ? skills[0].name : `${skills.length} skills`,
      under: skills.length === 1 ? 'Skill' : skills.map((s) => s.name).join(', '),
      value: `From ${owner()}`,
    }));
  }
  if (!rows.length) return '';
  return `<section class="card" aria-labelledby="starts"><h2 id="starts">It starts with</h2><ul>${rows.map((r) => `<li class="ln">${r}</li>`).join('')}</ul></section>`;
}

function endsIn() {
  const days = Math.ceil((Date.parse(invite.expiresAt) - Date.now()) / 86_400_000);
  if (!Number.isFinite(days) || days <= 1) return 'Ends today.';
  return `Ends in ${days} days.`;
}

const iconOf = (i) => (isImage(i.logo) ? `<span class="ic" aria-hidden="true"><img src="${esc(i.logo)}" alt=""></span>` : `<span class="ic is-letter" aria-hidden="true">${esc(i.name.slice(0, 1).toUpperCase())}</span>`);

function drawInvite() {
  document.title = `${owner()} set up Loop for you`;
  drawFoot(`For one person. ${endsIn()}${invite.needsPlan ? ' Agents need a Loop Connect plan.' : ''}`);
  draw(`
    <h1>${esc(owner())} set up Loop for you</h1>
    <p class="sub">It is your own Loop. Your accounts stay yours.</p>
    ${startsWith()}
    <button type="button" class="btn" data-go>${clerk?.user ? 'Open my Loop' : 'Sign in to Loop'}</button>
    <p class="err" role="alert"></p>`);
}

function drawSignIn() {
  foot.textContent = '';
  // The form has its own title, so this one says what the sign-in is for.
  draw(`
    <h1>${esc(invite?.owner ? `${owner()} set up Loop for you` : 'Your Loop')}</h1>
    <p class="sub">Sign in, or make a free account.</p>
    <div class="sign"><div data-form></div></div>`); // Clerk sets the class of its own place
  clerk.mountSignIn(card.querySelector('[data-form]'), {
    // A new account is made in the same form. Another page for it does not come back to this link.
    routing: 'hash', withSignUp: true, forceRedirectUrl: HERE, signUpForceRedirectUrl: HERE,
    appearance: {
      variables: { ...clerkColors('#F7F2F0'), fontFamily: 'inherit', borderRadius: '12px' },
      elements: { rootBox: { width: '100%' }, cardBox: { width: '100%', boxShadow: 'none' } },
    },
  });
}

/* ---------- the sign-ins of the services ---------- */
// `load` gives the items, `then` is the next step. The page keeps them while the person signs in.
let signIns = null;
const WAITS = 6; // a service that did not answer yet gets some more time
const WAIT_MS = 2500;

function signInRow(i) {
  const name = esc(i.name);
  const to = esc(encodeURIComponent(i.connId || ''));
  const sr = `<span class="sr"> ${i.step === 'signin' ? 'to' : 'for'} ${name}</span>`;
  let value = '';
  let more = '';
  if (i.state === 'ready') value = 'Signed in';
  else if (i.state === 'off') value = 'Off in your Loop';
  else if (i.state !== 'signin') value = 'Not added';
  else if (i.step === 'signin') more = `<button type="button" class="act" data-signin="${to}">Sign in${sr}</button>`;
  else if (i.step === 'key') more = `<a class="act" href="/#connections?signin=${to}" target="_blank" rel="noopener">Add key${sr}</a>`;
  else if (signIns.waits > 0) value = 'One moment…';
  else more = `<a class="act" href="/#connections?conn=${to}" target="_blank" rel="noopener">Open${sr}</a>`;
  return `<li class="ln${i.state === 'ready' ? ' is-done' : ''}">${line({ icon: iconOf(i), name: i.name, under: i.host, whole: true, value, more })}</li>`;
}

function drawSignIns(error = '') {
  const { items, title, first } = signIns;
  const left = items.filter((i) => i.state === 'signin').length;
  const focus = document.activeElement?.dataset?.signin;
  document.title = 'Sign in to your services';
  foot.textContent = left ? 'You can do this later on Home.' : '';
  const html = `
    <h1>${left ? 'Sign in to your services' : 'You are ready'}</h1>
    <p class="sub">${left ? 'Use your own accounts.' : 'Your services are in your Loop.'}</p>
    <section class="card" aria-labelledby="left"><h2 id="left">${esc(title(left))}</h2><ul>${items.map(signInRow).join('')}</ul></section>
    <button type="button" class="btn" data-next>Continue</button>
    <p class="err" role="alert"></p>`;
  if (first) draw(html);
  else {
    card.innerHTML = html;
    if (focus) (card.querySelector(`[data-signin="${CSS.escape(focus)}"]`) || card.querySelector('[data-signin], [data-next]'))?.focus({ preventScroll: true });
  }
  signIns.first = false;
  if (error) card.querySelector('.err').textContent = error;
}

async function refreshSignIns() {
  const now = signIns;
  if (!now || now.busy) return;
  try {
    const items = await now.load();
    if (signIns !== now || now.busy) return;
    if (JSON.stringify(items) !== JSON.stringify(now.items)) {
      const said = card.querySelector('.err')?.textContent || '';
      now.items = items;
      drawSignIns(items.some((i) => i.state === 'signin') ? said : '');
    }
  } catch { /* what is on the page stays; the next look tries again */ }
}

async function waitForAnswers() {
  const now = signIns;
  while (signIns === now && now.waits > 0 && now.items.some((i) => i.step === 'open')) {
    await new Promise((resolve) => { setTimeout(resolve, WAIT_MS); });
    if (signIns !== now) return;
    now.waits -= 1;
    if (!now.waits && !now.busy) drawSignIns(card.querySelector('.err')?.textContent || '');
    await refreshSignIns();
  }
}

// Shows the sign-ins, or goes on when there are none.
async function openSignIns({ load, then, title }) {
  let error = '';
  try {
    error = sessionStorage.getItem(RETURN_ERROR) || '';
    sessionStorage.removeItem(RETURN_ERROR);
    sessionStorage.removeItem(RETURN);
  } catch { /* no storage: no text of the sign-in before */ }
  const items = await load();
  if (!items.length) return then();
  signIns = { items, load, then, title, first: true, busy: false, waits: WAITS };
  drawSignIns(error);
  waitForAnswers();
}

async function signInTo(connId) {
  const now = signIns;
  if (!now || now.busy) return;
  const err = card.querySelector('.err');
  const btn = card.querySelector(`[data-signin="${CSS.escape(connId)}"]`);
  err.textContent = '';
  now.busy = true;
  card.querySelectorAll('[data-signin]').forEach((b) => { b.disabled = true; });
  btn.textContent = 'One moment…';
  let said = '';
  try {
    const { authorizeUrl } = await request(`/api/mcps/${encodeURIComponent(connId)}/oauth/start`, {});
    const target = new URL(authorizeUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) throw new Error('The sign-in page is not a secure (https) address.');
    keepReturn('signin', { connId });
    location.href = target.href;
    return;
  } catch (e) {
    const name = now.items.find((i) => i.connId === connId)?.name || 'This service';
    said = e.broken ? `${name} has no sign-in page. Add its key.` : e.message;
  }
  now.busy = false;
  drawSignIns(said);
  await refreshSignIns();
}

// The dashboard sends the browser back here: after the sign-in of a service, or of this Loop.
function keepReturn(why, more = {}) {
  try {
    sessionStorage.setItem(RETURN, JSON.stringify({ why, to: startData ? `/p/#${startData}` : `/p/${id}`, at: Date.now(), ...more }));
  } catch { /* the person goes on at Home */ }
}

const leftTitle = (left) => (left ? `${left} ${left === 1 ? 'sign-in' : 'sign-ins'} left` : 'In your Loop');

// What the invite put into the Loop of this account, or null when it is not for this account.
async function joinedItems() {
  const { from } = await request('/api/people/from?logos=1');
  const mine = from.find((p) => p.id === readKept()?.joined);
  if (!mine) return null;
  return mine.items.filter((i) => i.kind === 'connection' && i.mode === 'own' && i.state !== 'gone');
}

async function openJoined() {
  foot.textContent = '';
  try {
    await loadClerk();
    if (!clerk.user) return drawSignIn();
    const first = await joinedItems();
    if (!first) {
      drawEnd('This link is for another account', 'Sign in with the account that used it.');
      return drawFoot('');
    }
    await openSignIns({ load: async () => (await joinedItems()) || [], then: drawWhere, title: leftTitle });
  } catch {
    drawEnd('Loop did not answer', 'Your things are in your Loop.', '<button type="button" class="btn" data-retry>Try again</button>');
  }
}

function drawWhere() {
  signIns = null;
  const kept = readKept() || {};
  document.title = 'Where do you want it?';
  foot.textContent = kept.needsPlan ? 'Agents need a Loop Connect plan.' : '';
  const places = Object.entries(PLACES).filter(([key]) => key !== 'text' || kept.text);
  draw(`
    <h1>Add your agent</h1>
    <p class="sub">Your Loop is ready.</p>
    <section class="card" aria-labelledby="where"><h2 id="where">Where do you want it?</h2><ul>
      ${places.map(([key, p]) => `<li><button type="button" class="ln" data-place="${key}">${line({
        icon: `<span class="ic" aria-hidden="true">${p.mark ? `<img src="${p.mark}" alt="">` : PLUS}</span>`,
        name: p.name,
        value: p.value,
        more: `<span class="go">${GO}</span>`,
      })}</button></li>`).join('')}
    </ul></section>`);
}

// The answer for the account that is signed in, when the link is not for it.
function drawForAccount() {
  if (invite.own) {
    drawEnd('This is your own Loop', `Send the link to ${invite.name || 'the person'}. You do not need it.`);
    drawFoot('');
    return true;
  }
  if (invite.already) {
    drawEnd(`You have this from ${owner()}`, 'This link is for somebody else.', '<a class="btn" href="/">Open your Loop</a>');
    drawFoot('');
    return true;
  }
  return false;
}

// Uses the link: the things of the invite go into the Loop of the account that is signed in.
async function goOn() {
  const btn = card.querySelector('[data-go]');
  const say = (text) => {
    if (btn) btn.disabled = false;
    const err = card.querySelector('.err');
    if (err) err.textContent = text;
  };
  if (btn) btn.disabled = true;
  try {
    await loadClerk();
  } catch {
    return say('Sign-in does not answer. Try again.');
  }
  if (!clerk.user) {
    keep({ code, go: true }); // after the sign-in, this page goes on without one more press
    return drawSignIn();
  }
  foot.textContent = 'Loop gets your things ready.';
  try {
    const { id: joined } = await call('join');
    keep({ joined, text: Boolean(invite.text), needsPlan: Boolean(invite.needsPlan) });
  } catch (err) {
    if (err.status === 404 || err.status === 410) return drawEnded();
    if (err.code === 'OWN_LOOP' || err.code === 'ALREADY_IN') {
      invite[err.code === 'OWN_LOOP' ? 'own' : 'already'] = true;
      return drawForAccount();
    }
    foot.textContent = '';
    return say(err.message);
  }
  return openJoined();
}

/* ---------- a link that holds its list ---------- */
const startCall = (what) => request(`/api/people/start${what}`, { data: startData });

const startSignIns = () => openSignIns({
  load: async () => (await startCall('/look')).items.filter((i) => i.state !== 'add'),
  then: () => location.replace('/#home'),
  title: leftTitle,
});

async function openStart() {
  let look;
  try {
    look = await startCall('/look');
    // With all of it in the Loop, only the sign-ins are left.
    if (look.items.every((i) => i.state !== 'add')) return await startSignIns();
  } catch (err) {
    if (err.status === 401) {
      keepReturn('login');
      return drawEnd('Sign in to your Loop', 'Then this page opens again.', '<a class="btn" href="/">Sign in</a>');
    }
    if (err.status === 400) return drawEnd('This link is not complete', 'Open the full link again, or ask for a new one.');
    return drawEnd('Loop cannot open this link', err.message, '<button type="button" class="btn" data-retry>Try again</button>');
  }
  document.title = 'Add to your Loop';
  foot.textContent = 'Look at each address. Add only what you know.';
  draw(`
    <h1>Add to your Loop</h1>
    <p class="sub">${look.owner ? `From ${esc(look.owner)}. ` : ''}You sign in with your own accounts.</p>
    <section class="card" aria-labelledby="starts"><h2 id="starts">In this link</h2><ul>${look.items.map((i) => `<li class="ln">${line({
      icon: iconOf(i),
      name: i.name,
      under: i.host,
      whole: true,
      value: { ready: 'Signed in', off: 'Off in your Loop' }[i.state] || 'You sign in',
    })}</li>`).join('')}</ul></section>
    <button type="button" class="btn" data-start>Add to my Loop</button>
    <p class="err" role="alert"></p>`);
}

async function addStart(btn) {
  const err = card.querySelector('.err');
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'One moment…';
  try {
    const done = await startCall('');
    if (!done.failed?.length) return await startSignIns();
    err.textContent = `Loop could not add ${done.failed.join(', ')}. The others are in your Loop.`;
  } catch (e) {
    err.textContent = e.message;
  }
  btn.disabled = false;
  btn.textContent = 'Try again';
}

card.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-place], [data-retry], [data-start], [data-go], [data-signin], [data-next]');
  if (!btn) return;
  if ('start' in btn.dataset) addStart(btn);
  else if ('retry' in btn.dataset) location.reload();
  else if ('go' in btn.dataset) goOn();
  else if ('signin' in btn.dataset) signInTo(btn.dataset.signin);
  else if ('next' in btn.dataset) signIns.then();
  else location.replace(PLACES[btn.dataset.place].to);
});

// Back from a service without a sign-in, or from the tab where a key was put in.
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSignIns(); });
window.addEventListener('pageshow', (e) => {
  if (!e.persisted || !signIns) return;
  signIns.busy = false;
  drawSignIns();
  refreshSignIns();
});

async function start() {
  if (startData) return openStart();
  if (readKept()?.joined) {
    if (inHash) history.replaceState(null, '', HERE);
    return openJoined();
  }
  if (!id || !code) return drawEnd('This link is not complete', 'Open the full link again, or ask for a new one.');
  const go = Boolean(readKept()?.go);
  if (CODE.test(inHash) && readKept()) history.replaceState(null, '', HERE); // the code stays out of the history
  // Sign-in of this browser, when it answers in time: the page then knows which account it is.
  const account = loadClerk().catch(() => null);
  await Promise.race([account, new Promise((resolve) => { setTimeout(resolve, 3000); })]);
  try {
    invite = await call('preview');
  } catch (err) {
    if (err.status === 400 || err.status === 404 || err.status === 410) return drawEnded();
    return drawEnd('Loop cannot open this link', err.message, '<button type="button" class="btn" data-retry>Try again</button>');
  }
  if (invite.joined) {
    keep({ joined: invite.joined, text: Boolean(invite.text), needsPlan: Boolean(invite.needsPlan) });
    return openJoined();
  }
  if (clerk?.user && drawForAccount()) return;
  if (clerk && !clerk.user && go && location.hash.startsWith('#/')) return drawSignIn(); // in the middle of a sign-in
  drawInvite();
  if (go && clerk?.user) goOn();
}
start();
