// Settings › People. A person gets a Loop of their own; the invite fills it with what the owner picks here
// (lib/people.mjs). Each connection is off, "Own sign-in" (the person uses their own account) or "Uses mine".
// The person sees in the same place what they got, and from whom.
// A Loop on one computer makes a link that holds the list itself; it opens the Loop on the person's computer.

import { wireRadioKeys } from './approval-modes.js';

const TINTS = ['green', 'blue', 'amber'];
const MODES = { own: 'Own sign-in', mine: 'Uses mine' };
const svg = (size, body, width = 1.6, cls = '') => `<svg ${cls ? `class="${cls}" ` : ''}width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const CHEV = svg(14, '<path d="M8 5l5 5-5 5"/>', 1.8, 'oc-chev');
const DOWN = svg(12, '<path d="M5 8l5 5 5-5"/>', 1.8);
const FIND = svg(16, '<circle cx="9" cy="9" r="5.5"/><path d="M13.2 13.2L17 17"/>', 1.6, 'pp-find');
const WHO = svg(16, '<circle cx="10" cy="6.8" r="3.3"/><path d="M3.6 17c.6-3.2 3.2-5 6.4-5s5.8 1.8 6.4 5"/>', 1.6, 'pp-whoic');
const TICK = svg(12, '<path d="M4.5 10.5l3.5 3.5 7.5-8"/>', 2.4);
const SHOWN = 8; // connections in view before "Show all"
const SKILL = svg(16, '<path d="M10 2.8l1.7 5.5 5.5 1.7-5.5 1.7L10 17.2l-1.7-5.5L2.8 10l5.5-1.7z"/>', 1.5);

// What is open on the page. It stays while Settings draws itself again.
const fresh = () => ({
  adding: false,
  more: '', // the person that gets more
  name: '',
  search: '',
  picks: new Map(), // connection id -> 'own' or 'mine'
  skills: new Set(),
  row: '', // the connection whose choice is open
  skillsOpen: false,
  all: false, // every connection is in view
  projectNote: '',
  busy: false,
  error: '',
  made: null,
  open: new Set(),
  links: new Map(),
});
let ui = fresh();
let options = null; // what the owner can give, with the logos
export function resetPeople() { ui = fresh(); options = null; }

function clearPicks() {
  Object.assign(ui, { search: '', picks: new Map(), skills: new Set(), row: '', skillsOpen: false, all: false, projectNote: '', error: '' });
  options = null;
}

// The same person always has the same color.
function tintOf(id) {
  let sum = 0;
  for (const ch of String(id)) sum = (sum * 31 + ch.charCodeAt(0)) >>> 0;
  return TINTS[sum % TINTS.length];
}

const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();
// In a sentence or on a button a long name becomes its first word.
const shortName = (name) => (name.length > 16 ? name.split(' ')[0] : name);
const listOf = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * Draws the section in `host` and keeps it current. `ctx`: esc, api, toast, copyText, confirmDialog, chevron,
 * renderConnLogo, projects, ownerName(), showPlan(). Returns { refresh }.
 */
export function mountPeople(host, data, ctx) {
  const { esc, api, toast, copyText, confirmDialog, renderConnLogo, chevron } = ctx;
  let state = data;

  host.innerHTML = `
    <div class="st-sh"><h3 class="st-h">People</h3><button type="button" class="pp-add" data-pp-add aria-controls="pp-panel"></button></div>
    <div class="pp-slot" id="pp-panel"></div>
    <div class="pp-list"></div>`;
  const addBtn = host.querySelector('[data-pp-add]');
  const panel = host.querySelector('.pp-slot');
  const list = host.querySelector('.pp-list');

  const mono = (name, cls) => `<span class="ln-ic" aria-hidden="true"><span class="pp-m ${cls}">${esc(clean(name).slice(0, 1).toUpperCase() || '?')}</span></span>`;
  const linkRow = (url) => `<div class="vf-f aa-linkrow pp-link"><span class="aa-url" title="${esc(url)}">${esc(url.replace(/^https?:\/\//, ''))}</span><button type="button" class="aa-copy" data-pp-copy="${esc(url)}">Copy</button></div>`;
  const switchOf = (attrs, label, on, some = false) => `<button type="button" class="sw ${on ? 'on' : some ? 'is-some' : ''}" role="${some ? 'checkbox' : 'switch'}" aria-checked="${on ? 'true' : some ? 'mixed' : 'false'}" aria-label="${esc(label)}" ${attrs}><span class="sw-knob" aria-hidden="true"></span></button>`;
  const logoOf = (item) => {
    if (item.kind === 'skill') return SKILL;
    const known = item.connId || item.ref;
    const conn = options?.mcps.get(known) || ctx.mcps?.get(known) || { name: item.name, transport: 'http' };
    return renderConnLogo(conn, { badge: false });
  };

  /* ---------- rows ---------- */

  function foldRow({ id, name, value, cls, body }) {
    const isOpen = ui.open.has(id);
    return `
      <details class="pp-p" data-pp="${esc(id)}" ${isOpen ? 'open' : ''}>
        <summary class="st-row ln ln-go">${mono(name, cls)}<span class="ln-tx"><span class="ln-t">${esc(name)}</span></span><span class="ln-v">${esc(value)}</span>${chevron}</summary>
        <div class="vd">${body()}</div>
      </details>`;
  }

  // Of a long host the end stays in view: that part says whose it is.
  const itemRow = (item, value, action = '') => `
    <li class="oc-line"><span class="oc-line-ic">${logoOf(item)}</span><span class="oc-line-t">${esc(item.name)}</span>${value ? (value === item.host ? `<span class="oc-line-v is-host" title="${esc(value)}"><bdi dir="ltr">${esc(value)}</bdi></span>` : `<span class="oc-line-v">${esc(value)}</span>`) : ''}${action}</li>`;

  // Connections one by one; many skills as one line.
  function itemsHtml(items, rowOf) {
    const skills = items.filter((i) => i.kind === 'skill');
    const single = skills.length > 4 ? items.filter((i) => i.kind !== 'skill') : items;
    const many = skills.length > 4
      ? itemRow({ kind: 'skill', name: `${skills.length} skills` }, skills.some((i) => i.state === 'offer') ? `${skills.filter((i) => i.state === 'offer').length} offered` : 'Added')
      : '';
    if (!items.length) return '';
    return `<ul class="oc-lines pp-items">${single.map(rowOf).join('')}${many}</ul>`;
  }

  // The owner can end it, also when the person removed it from their Loop.
  const isLent = (i) => i.mode === 'mine' && i.state !== 'offer';
  const ownerState = (i) => ({ offer: 'Offered', signin: 'Not yet', ready: i.kind === 'skill' ? 'Added' : 'Signed in', gone: 'Removed', mine: 'Uses mine' })[i.state] || '';

  function personRow(p) {
    const waits = p.signIns - p.signedIn;
    return foldRow({
      id: p.id,
      name: p.name,
      value: waits > 0 ? `${p.signedIn} of ${p.signIns} signed in` : 'Ready',
      cls: `is-${tintOf(p.id)}`,
      body: () => {
        if (ui.more === p.id) return `<form class="pp-form" data-pp-form="more" aria-label="Add to ${esc(p.name)}’s Loop">${pickerFrame({ title: `Add to ${p.name}’s Loop`, sub: `${shortName(p.name)} says yes in their own Loop.` })}</form>`;
        return `
          ${itemsHtml(p.items, (i) => itemRow(i, ownerState(i), isLent(i) || i.state === 'offer'
            ? `<button type="button" class="vd-act" data-pp-stop="${esc(i.id)}" data-pp-of="${esc(p.id)}">${i.state === 'offer' ? 'Undo' : 'Stop'}<span class="sr-only"> ${esc(i.name)}</span></button>` : ''))}
          <p class="vd-note pp-note">${p.items.some(isLent)
            ? `Activity shows what ${esc(shortName(p.name))}’s agents do with your account. You do not see ${esc(shortName(p.name))}’s own accounts or data.`
            : `You see only this. You do not see ${esc(shortName(p.name))}’s accounts or data.`}</p>
          <div class="pp-acts"><button type="button" class="pp-soft" data-pp-more="${esc(p.id)}">Add more</button><button type="button" class="pp-soft is-no" data-pp-remove="${esc(p.id)}">Remove<span class="sr-only"> ${esc(p.name)}</span></button></div>`;
      },
    });
  }

  function inviteRow(i) {
    const url = ui.links.get(i.id);
    return foldRow({
      id: i.id,
      name: i.name,
      value: 'Invited',
      cls: 'is-soft',
      body: () => `
        ${itemsHtml(i.items, (x) => itemRow(x, x.kind === 'skill' ? 'Skill' : MODES[x.mode]))}
        ${url ? `<div class="pp-newlink">${linkRow(url)}</div>` : ''}
        <p class="vd-note pp-note">For one person. Ends ${esc(shortDate(i.expiresAt))}.</p>
        <div class="pp-acts"><button type="button" class="pp-soft" data-pp-newlink="${esc(i.id)}">New link<span class="sr-only"> for ${esc(i.name)}</span></button><button type="button" class="pp-soft is-no" data-pp-cancel="${esc(i.id)}">Cancel invite<span class="sr-only"> of ${esc(i.name)}</span></button></div>`,
    });
  }

  function fromRow(f) {
    const offers = f.items.filter((i) => i.state === 'offer').length;
    const left = f.items.filter((i) => i.state === 'signin').length;
    return foldRow({
      id: f.id,
      name: f.owner,
      value: offers ? plural(offers, 'new offer') : left ? plural(left, 'sign-in left', 'sign-ins left') : 'Ready',
      cls: `is-${tintOf(f.id)}`,
      body: () => `
        ${itemsHtml(f.items, (i) => {
          if (i.state === 'offer') return itemRow({ ...i, ref: '' }, i.problem ? 'Try again' : i.mode === 'mine' ? `${f.owner}’s account` : i.host || '', `<button type="button" class="vd-act" data-pp-take="${esc(i.id)}" data-pp-of="${esc(f.id)}">Add<span class="sr-only"> ${esc(i.name)}</span></button>`);
          if (i.state === 'signin') {
            const [param, text, to] = { key: ['signin', 'Add key', 'for'], open: ['conn', 'Open', ''] }[i.step] || ['signin', 'Sign in', 'to'];
            return itemRow(i, '', `<a class="vd-act" href="#connections?${param}=${encodeURIComponent(i.connId)}">${text}<span class="sr-only"> ${to} ${esc(i.name)}</span></a>`);
          }
          return itemRow(i, { ready: i.kind === 'skill' ? 'Skill' : 'Your sign-in', gone: 'You removed it', mine: `${f.owner}’s account` }[i.state] || '');
        })}
        <p class="vd-note pp-note">${f.items.some((i) => i.state === 'mine')
          ? `${esc(f.owner)} sees if you signed in, and what your agents do with ${esc(f.owner)}’s account. ${esc(f.owner)} does not see your own accounts or data.`
          : `${esc(f.owner)} sees only if you signed in. ${esc(f.owner)} does not see your accounts or data.`}</p>
        <div class="pp-acts"><button type="button" class="pp-soft is-no" data-pp-leave="${esc(f.id)}">Leave<span class="sr-only"> ${esc(f.owner)}</span></button></div>`,
    });
  }

  function paintList() {
    if (state.local) {
      list.innerHTML = ui.adding ? '' : '<p class="pp-none">Invited people do not work inside your Loop. A link copies your connection addresses into their own Loop, and they sign in with their own accounts.</p>';
      return;
    }
    const rows = state.people.map(personRow).join('') + state.invites.map(inviteRow).join('');
    list.innerHTML = `
      ${rows ? `<div class="st-list">${rows}</div>` : ui.adding ? '' : '<p class="pp-none">Nobody yet. Invited people do not work inside your Loop — each person gets their own Loop with what you pick.</p>'}
      ${state.from.length ? `<p class="pp-k">From others</p><div class="st-list">${state.from.map(fromRow).join('')}</div>` : ''}`;
    const more = list.querySelector('[data-pp-form=more]');
    if (more) paintPicker(more);
  }

  /* ---------- the choice of what a person gets ---------- */

  const giver = () => shortName((ui.more ? state.people.find((p) => p.id === ui.more)?.name : clean(ui.name)) || 'This person');
  const has = (kind, ref) => Boolean(ui.more) && state.people.find((p) => p.id === ui.more)?.items.some((i) => i.kind === kind && i.ref === ref && i.state !== 'gone');
  const giveable = () => (options?.connections || []).filter((c) => !has('connection', c.id));
  const giveableSkills = () => (options?.skills || []).filter((s) => !has('skill', s.id));

  // One line holds the name (or the title) and the button; it stays in view when the list is long.
  function pickerFrame({ title = '', sub, field = '' }) {
    const go = '<button type="submit" class="pp-go" data-pp-go></button>';
    return `
      <div class="pp-who">
        ${field ? `<span class="vf-f">${WHO}${field}${go}</span>` : `<div class="pp-who-t"><h4 class="pp-t" tabindex="-1">${esc(title)}</h4>${go}</div>`}
        <p class="vm-err" role="alert" data-pp-err ${ui.error ? '' : 'hidden'}>${esc(ui.error)}</p>
      </div>
      <div class="pp-subrow"><p class="aa-sub" data-pp-sub>${esc(sub)}</p><span data-pp-projslot></span></div>
      <div class="pp-pick oc-inline"></div>`;
  }

  function goLabel() {
    const n = ui.picks.size + ui.skills.size;
    if (ui.busy) return 'One moment…';
    if (!ui.more) return state.local ? 'Make the link' : 'Make the invite';
    return n ? `Offer ${plural(n, 'item')}` : 'Offer';
  }

  function paintGo(form) {
    const go = form.querySelector('[data-pp-go]');
    if (!go) return;
    go.textContent = goLabel();
    go.disabled = ui.busy || ((Boolean(ui.more) || Boolean(state.local)) && ui.picks.size + ui.skills.size === 0);
    const err = form.querySelector('[data-pp-err]');
    err.textContent = ui.error;
    err.hidden = !ui.error;
  }

  // Draws the list again; the control in use keeps its focus.
  function paintPicker(form) {
    const box = form.querySelector('.pp-pick');
    if (!box) return;
    paintGo(form);
    if (!options) {
      box.innerHTML = '<div class="st-wait" role="status"><div class="spin" aria-hidden="true"></div></div>';
      loadOptions().then(() => { if (form.isConnected) paintPicker(form); }, (err) => {
        if (form.isConnected) box.innerHTML = `<p class="oc-note is-first">${esc(err.message)} <button type="button" class="pp-inline" data-pp-retry>Try again</button></p>`;
      });
      return;
    }
    const held = box.contains(document.activeElement) ? document.activeElement : null;
    const attr = held?.getAttributeNames().find((n) => n.startsWith('data-pp-'));
    const caret = held?.matches('input[type=search]') ? [held.selectionStart, held.selectionEnd] : null;

    const q = ui.search.trim().toLowerCase();
    const hit = (x) => !q || x.name.toLowerCase().includes(q);
    const conns = giveable().filter(hit);
    const skills = giveableSkills();
    const shownSkills = skills.filter(hit);
    const projects = (ctx.projects || []).filter((p) => giveable().some((c) => c.projects.includes(p.id)) || skills.some((s) => s.projects.includes(p.id)));
    const total = giveable().length + skills.length;
    // What is on stays in view, so that the list never hides a choice.
    const long = conns.length > SHOWN && !q;
    const shown = long && !ui.all ? conns.filter((c, n) => n < SHOWN || ui.picks.has(c.id)) : conns;
    const canSearch = giveable().length > SHOWN || skills.length > 0;
    const notHere = [
      options.onComputer ? `${options.onComputer} that ${options.onComputer === 1 ? 'works' : 'work'} only on your computer` : '',
      options.onlyYours ? `${options.onlyYours} with an address that is only yours` : '',
    ].filter(Boolean).join(', ');
    form.querySelector('[data-pp-projslot]').innerHTML = projects.length ? `<label class="pp-proj"><span>From a project</span>${DOWN}<select data-pp-project aria-label="Add from a project"><option value="">From a project</option>${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join('')}</select></label>` : '';

    const rowHtml = (c) => {
      const mode = ui.picks.get(c.id);
      const on = Boolean(mode);
      const isOpen = on && ui.row === c.id;
      const who = giver();
      return `
        <li class="pp-c ${isOpen ? 'is-open' : ''}">
          <div class="oc-line">
            <button type="button" class="pp-c-main" data-pp-row="${esc(c.id)}" aria-expanded="${isOpen}">
              <span class="oc-line-ic">${logoOf({ kind: 'connection', ref: c.id, name: c.name })}</span>
              <span class="pp-c-tx"><span class="oc-line-t">${esc(c.name)}</span>${on ? `<span class="oc-line-v">${MODES[mode]}</span>` : ''}</span>
            </button>
            <button type="button" class="pp-tick" role="switch" aria-checked="${on}" aria-label="${esc(`Give ${c.name}`)}" data-pp-conn="${esc(c.id)}">${TICK}</button>
          </div>
        </li>
        ${isOpen ? `<li class="pp-how">
            ${c.own && c.mine ? `
              <div class="vm-seg" role="radiogroup" aria-label="How ${esc(who)} uses ${esc(c.name)}">
                ${Object.entries(MODES).map(([value, text]) => `<button type="button" role="radio" aria-checked="${value === mode}" data-pp-mode="${value}" data-pp-for="${esc(c.id)}">${text}</button>`).join('')}
              </div>` : ''}
            <p class="pp-hint">${mode === 'own'
              ? `${esc(who)} signs in with an account of their own at <span class="pp-at">${esc(String(c.url || '').replace(/^https:\/\//, ''))}</span>.`
              : `${c.own ? '' : `${esc(c.name)} has an address that is yours, so it can only use yours. `}${esc(who)}’s agents use your ${esc(c.name)} account. Your approval rules apply, and Activity shows what they do. You can end it at any time.`}</p></li>` : ''}`;
    };

    const skillsOn = skills.filter((s) => ui.skills.has(s.id)).length;
    const skillsOpen = ui.skillsOpen || Boolean(q);
    box.innerHTML = `
      ${total > 0 ? canSearch ? `
        <div class="oc-find">
          ${FIND}
          <input type="search" data-pp-search value="${esc(ui.search)}" placeholder="${skills.length ? 'Search connections and skills' : 'Search connections'}" aria-label="Search your connections and skills" autocomplete="off" enterkeyhint="search">
        </div>` : '' : `<p class="oc-note is-first">${ui.more ? `${esc(giver())} has all that you can give.` : state.local ? 'You have no connection that can be in a link yet.' : 'You have no connections yet. The Loop starts blank.'}</p>`}
      ${ui.projectNote ? `<p class="pp-hint" role="status">${esc(ui.projectNote)}</p>` : ''}
      ${shown.length ? `<ul class="oc-lines pp-lines">${shown.map(rowHtml).join('')}</ul>` : ''}
      ${long ? `<button type="button" class="pp-all" data-pp-all aria-expanded="${ui.all}">${ui.all ? 'Show fewer' : `Show all ${conns.length}`}</button>` : ''}
      ${shownSkills.length ? `
        <div class="oc-group">
          <div class="oc-head-row">
            <button type="button" class="oc-head" data-pp-skills aria-expanded="${skillsOpen}">${CHEV}<span class="oc-head-l">Skills</span><span class="oc-head-n">${skillsOn} of ${skills.length}</span></button>
            ${switchOf('data-pp-allskills', 'All skills', skillsOn === skills.length, skillsOn > 0 && skillsOn < skills.length)}
          </div>
          ${skillsOpen ? `<ul class="oc-lines">${shownSkills.map((s) => {
            const on = ui.skills.has(s.id);
            return `<li><div class="oc-line ${on ? '' : 'is-off'}" data-pp-skillrow><span class="oc-line-ic">${SKILL}</span><span class="oc-line-t">${esc(s.name)}</span>${switchOf(`data-pp-skill="${esc(s.id)}"`, `Give ${s.name}`, on)}</div></li>`;
          }).join('')}</ul>` : ''}
        </div>` : ''}
      ${q && !conns.length && !shownSkills.length ? `<p class="oc-note is-first">Nothing in your Loop matches “${esc(clean(ui.search))}”. <a class="pp-inline" href="#connections?panel=add">Add a connection</a></p>` : ''}
      ${notHere && !q ? `<p class="pp-hint pp-later">Not in the list: ${notHere}.</p>` : ''}`;

    wireRadioKeys(box);
    if (attr) {
      const again = box.querySelector(`[${attr}="${CSS.escape(held.getAttribute(attr))}"]${held.dataset.ppFor ? `[data-pp-for="${CSS.escape(held.dataset.ppFor)}"]` : ''}`);
      again?.focus({ preventScroll: true });
      if (caret) try { again?.setSelectionRange(...caret); } catch { /* ignore */ }
    }
  }

  async function loadOptions() {
    const [given, mcps] = await Promise.all([api('/api/people/options'), api('/api/mcps').catch(() => ({ mcps: [] }))]);
    options = { ...given, mcps: new Map((mcps.mcps || []).map((m) => [m.id, m])) };
  }

  const formOf = (el) => el.closest('.pp-form');
  const repaint = (el) => { const form = formOf(el); if (form) paintPicker(form); };

  function toggleConn(id) {
    const c = options.connections.find((x) => x.id === id);
    if (!c) return;
    if (ui.picks.has(id)) {
      ui.picks.delete(id);
      if (ui.row === id) ui.row = '';
      return;
    }
    ui.picks.set(id, c.own ? 'own' : 'mine');
    ui.row = c.own ? '' : id; // what is lent says so at once
  }

  // A project puts its things on. Nothing is lent without a choice for that one connection.
  function addProject(id) {
    const name = ctx.projects.find((p) => p.id === id)?.name || id;
    const conns = giveable().filter((c) => c.projects.includes(id));
    const skills = giveableSkills().filter((s) => s.projects.includes(id));
    const only = conns.filter((c) => !c.own && !ui.picks.has(c.id));
    for (const c of conns) if (c.own && !ui.picks.has(c.id)) ui.picks.set(c.id, 'own');
    for (const s of skills) ui.skills.add(s.id);
    ui.projectNote = only.length
      ? `${name} is on, without ${listOf(only.map((c) => c.name))}: ${only.length === 1 ? 'it' : 'they'} can only use yours.`
      : `${name} is on.`;
  }

  const chosen = () => [
    ...[...ui.picks].map(([ref, mode]) => ({ kind: 'connection', ref, mode })),
    ...[...ui.skills].map((ref) => ({ kind: 'skill', ref })),
  ];

  /* ---------- the panel ---------- */

  const subFor = (name) => state.local
    ? `The link puts these in ${name ? `${shortName(name)}’s` : 'their'} own Loop. They sign in with their own accounts.`
    : (name ? `${shortName(name)} gets a Loop of their own. Add what ${shortName(name)} must have.` : 'They get a Loop of their own. Add what they must have.');

  function madeSummary(items) {
    const own = items.filter((i) => i.mode === 'own').length;
    const mine = items.filter((i) => i.mode === 'mine').map((i) => i.name);
    const skills = items.filter((i) => i.kind === 'skill').length;
    const parts = [
      own ? plural(own, 'own sign-in') : '',
      mine.length ? `${mine.length > 2 ? plural(mine.length, 'connection') : listOf(mine)} from you` : '',
      skills ? plural(skills, 'skill') : '',
    ].filter(Boolean);
    return parts.length ? `${parts.join(', ')}.` : 'It starts blank.';
  }

  function panelHtml() {
    if (state.canAdd === false) {
      return `
        <div class="pp-panel">
          <header class="pp-head"><h4 class="pp-t" tabindex="-1">Invite a person</h4><p class="aa-sub">You can invite people with Loop Connect.</p></header>
          <button type="button" class="btn fill aa-big" data-pp-plan>See the plan</button>
        </div>`;
    }
    if (ui.made) {
      const { invite, url } = ui.made;
      const canText = !state.local && /Mac|iPhone|iPad|Android/i.test(navigator.userAgent);
      const sms = `sms:?&body=${encodeURIComponent(`I made a Loop for you. It is yours: ${url}`)}`;
      return `
        <div class="pp-panel" role="status">
          <header class="pp-head"><h4 class="pp-t" tabindex="-1">${esc(invite.name)}’s ${state.local ? 'link' : 'Loop'} is ready</h4><p class="aa-sub">${esc(madeSummary(invite.items))}</p></header>
          ${canText
            ? `<a class="btn fill aa-big" href="${esc(sms)}"><span class="pp-cut">Text it to ${esc(shortName(invite.name))}</span></a><p class="pp-mid">or send the link</p>${linkRow(url)}`
            : `<div class="pp-gap">${linkRow(url)}</div>`}
          <p class="pp-hint">${state.local ? `${esc(shortName(invite.name))} opens it on a computer that has Loop. It holds names and addresses, no keys.` : 'For one person. Ends in 7 days.'}</p>
        </div>`;
    }
    const name = clean(ui.name);
    return `
      <form class="pp-panel pp-form" data-pp-form="invite" method="post" aria-label="Invite a person">
        ${pickerFrame({
          sub: subFor(name),
          field: `<input name="name" type="text" maxlength="60" value="${esc(ui.name)}" placeholder="Name" aria-label="Name of the person" autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="next">`,
        })}
      </form>`;
  }

  function paintPanel({ focus = false } = {}) {
    addBtn.innerHTML = ui.adding ? 'Close' : 'Invite<span class="sr-only"> a person</span>';
    addBtn.setAttribute('aria-expanded', String(ui.adding));
    panel.innerHTML = ui.adding ? panelHtml() : '';
    const form = panel.querySelector('form');
    if (form) paintPicker(form);
    if (focus) (panel.querySelector('input[name=name]') || panel.querySelector('.pp-t'))?.focus({ preventScroll: true });
  }

  /* ---------- changes ---------- */

  async function refresh({ force = false } = {}) {
    const next = await api('/api/people');
    if (!host.isConnected) return;
    state = next;
    if (!force && list.querySelector('[data-pp-form=more]')) return; // in use
    paintList();
  }

  // One change at a time; a refused change puts the list back as the server has it.
  async function change(send, done) {
    try {
      const result = await send();
      await done?.(result);
    } catch (err) {
      toast(err.message, 'err');
    }
    await refresh({ force: true }).catch(() => {});
  }

  const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body || {}) });
  const del = (url) => api(url, { method: 'DELETE' });

  async function makeInvite(form) {
    ui.name = form.elements.name.value;
    const name = clean(ui.name);
    if (!name) {
      ui.error = 'Enter a name.';
      paintGo(form);
      form.elements.name.focus();
      return;
    }
    ui.busy = true;
    ui.error = '';
    paintGo(form);
    try {
      ui.made = await post('/api/people/invites', { name, ownerName: ctx.ownerName(), items: chosen() });
      ui.links.set(ui.made.invite.id, ui.made.url);
      ui.name = '';
      clearPicks();
    } catch (err) {
      ui.error = err.message;
      if (err.data?.upgradeRequired) state.canAdd = false;
      if (err.status === 409) options = null;
    }
    ui.busy = false;
    if (!host.isConnected) return;
    if (ui.error && state.canAdd !== false) {
      paintPicker(form);
      return;
    }
    paintPanel({ focus: true });
    host.scrollIntoView({ block: 'start' });
    await refresh().catch(() => {});
  }

  async function offerMore(form) {
    ui.busy = true;
    ui.error = '';
    paintGo(form);
    const name = giver();
    try {
      await post(`/api/people/${encodeURIComponent(ui.more)}/items`, { items: chosen() });
      ui.more = '';
      clearPicks();
      toast(`Loop asks ${name}.`, 'ok');
    } catch (err) {
      ui.error = err.message;
      if (err.status === 409) options = null;
    }
    ui.busy = false;
    if (!host.isConnected) return;
    if (ui.error) paintPicker(form);
    else await refresh({ force: true }).catch(() => {});
  }

  host.addEventListener('submit', (e) => {
    const form = e.target.closest('.pp-form');
    if (!form) return;
    e.preventDefault();
    if (ui.busy) return;
    if (form.dataset.ppForm === 'more') offerMore(form);
    else makeInvite(form);
  });

  host.addEventListener('input', (e) => {
    if (e.target.name === 'name') {
      ui.name = e.target.value;
      formOf(e.target).querySelector('[data-pp-sub]').textContent = subFor(clean(ui.name));
      if (ui.error) { ui.error = ''; paintGo(formOf(e.target)); }
      if (ui.row) paintPicker(formOf(e.target));
    }
    if ('ppSearch' in e.target.dataset) {
      ui.search = e.target.value;
      repaint(e.target);
    }
  });

  host.addEventListener('change', (e) => {
    if (!('ppProject' in e.target.dataset) || !e.target.value) return;
    addProject(e.target.value);
    repaint(e.target);
  });

  host.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.closest('.pp-slot, [data-pp-form=more]')) {
      e.preventDefault();
      e.stopPropagation();
      if (e.target.closest('[data-pp-form=more]')) closeMore();
      else {
        addBtn.click();
        addBtn.focus({ preventScroll: true });
      }
    } else if (e.key === 'Enter' && 'ppSearch' in (e.target.dataset || {})) {
      e.preventDefault(); // it looks, it does not send
    } else if (e.key === 'Enter' && e.target.name === 'name' && !e.isComposing) {
      const next = clean(e.target.value) && formOf(e.target).querySelector('[data-pp-search], [data-pp-row]');
      if (next) {
        e.preventDefault(); // the name is done, the list is next: only the button makes the invite
        next.focus();
      }
    } else if (/^Arrow/.test(e.key)) {
      document.activeElement?.closest?.('[data-pp-mode]')?.click(); // nothing is saved yet, so the arrow chooses
    }
  });

  host.addEventListener('toggle', (e) => {
    const id = e.target.dataset?.pp;
    if (!id) return;
    if (e.target.open) ui.open.add(id);
    else {
      ui.open.delete(id);
      if (ui.more === id) closeMore();
    }
  }, true);

  function closeMore() {
    const id = ui.more;
    ui.more = '';
    clearPicks();
    paintList();
    list.querySelector(`[data-pp="${CSS.escape(id)}"] [data-pp-more]`)?.focus({ preventScroll: true });
  }

  host.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn || !host.contains(btn)) {
      // The whole line of a skill is its switch.
      e.target.closest('[data-pp-skillrow]')?.querySelector('.sw')?.click();
      return;
    }
    const d = btn.dataset;
    if ('ppAdd' in d) {
      const wasMore = ui.more;
      ui.adding = !ui.adding;
      Object.assign(ui, { made: null, name: '', more: '' });
      clearPicks();
      paintPanel({ focus: ui.adding });
      if (wasMore || !state.people.length) paintList();
      return;
    }
    if ('ppPlan' in d) return ctx.showPlan();
    if ('ppRetry' in d) return repaint(btn);
    if (d.ppCopy) return copyText(d.ppCopy, 'Link copied.');

    /* what a person gets */
    if (d.ppConn) {
      toggleConn(d.ppConn);
      return repaint(btn);
    }
    if (d.ppRow) {
      if (!ui.picks.has(d.ppRow)) toggleConn(d.ppRow);
      else ui.row = ui.row === d.ppRow ? '' : d.ppRow;
      return repaint(btn);
    }
    if (d.ppMode) {
      ui.picks.set(d.ppFor, d.ppMode);
      return repaint(btn);
    }
    if ('ppAll' in d) {
      ui.all = !ui.all;
      return repaint(btn);
    }
    if ('ppSkills' in d) {
      ui.skillsOpen = !ui.skillsOpen;
      return repaint(btn);
    }
    if ('ppAllskills' in d) {
      const all = giveableSkills();
      const on = all.every((s) => ui.skills.has(s.id));
      ui.skills = on ? new Set() : new Set(all.map((s) => s.id));
      return repaint(btn);
    }
    if (d.ppSkill) {
      if (!ui.skills.delete(d.ppSkill)) ui.skills.add(d.ppSkill);
      return repaint(btn);
    }

    /* people and invites */
    if (d.ppMore) {
      if (ui.adding) { ui.adding = false; ui.made = null; paintPanel(); }
      clearPicks();
      ui.more = d.ppMore;
      paintList();
      list.querySelector('[data-pp-form=more] .pp-t')?.focus({ preventScroll: true });
      return;
    }
    if (d.ppNewlink) {
      const who = state.invites.find((i) => i.id === d.ppNewlink);
      return change(() => post(`/api/people/invites/${encodeURIComponent(d.ppNewlink)}/link`), (made) => {
        ui.links.set(made.invite.id, made.url);
        if (ui.made?.invite.id === made.invite.id) { ui.made = null; ui.adding = false; paintPanel(); }
        toast(`The old link of ${who?.name || 'this person'} does not work any more.`, 'ok');
      });
    }
    if (d.ppCancel) {
      const who = state.invites.find((i) => i.id === d.ppCancel);
      return change(() => del(`/api/people/invites/${encodeURIComponent(d.ppCancel)}`), () => {
        ui.links.delete(d.ppCancel);
        if (ui.made?.invite.id === d.ppCancel) { ui.made = null; ui.adding = false; paintPanel(); }
        toast(`The link of ${who?.name || 'this person'} does not work any more.`, 'ok');
      });
    }
    if (d.ppStop) {
      const person = state.people.find((p) => p.id === d.ppOf);
      const item = person?.items.find((i) => i.id === d.ppStop);
      if (!item) return;
      if (isLent(item)) {
        const ok = await confirmDialog({ title: `Stop ${item.name}?`, message: `${person.name}’s agents lose your ${item.name} at once.`, confirmLabel: 'Stop', danger: true });
        if (!ok) return;
      }
      return change(() => del(`/api/people/${encodeURIComponent(person.id)}/items/${encodeURIComponent(item.id)}`));
    }
    if (d.ppRemove) {
      const person = state.people.find((p) => p.id === d.ppRemove);
      if (!person) return;
      const lent = person.items.filter(isLent).map((i) => i.name);
      const ok = await confirmDialog({
        title: `Remove ${person.name}?`,
        message: `${lent.length ? `${person.name}’s agents lose your ${listOf(lent)} at once. ` : ''}${person.name} keeps their own Loop, sign-ins and skills.`,
        confirmLabel: 'Remove',
        danger: true,
      });
      if (!ok) return;
      return change(() => del(`/api/people/${encodeURIComponent(person.id)}`), () => toast(`${person.name} is removed.`, 'ok'));
    }

    /* what somebody else gave */
    if (d.ppTake) {
      btn.disabled = true;
      return change(() => post(`/api/people/from/${encodeURIComponent(d.ppOf)}/items/${encodeURIComponent(d.ppTake)}`), (res) => toast(`${res.item?.name || 'It'} is in your Loop.`, 'ok'));
    }
    if (d.ppLeave) {
      const from = state.from.find((f) => f.id === d.ppLeave);
      if (!from) return;
      const lent = from.items.filter((i) => i.state === 'mine').map((i) => i.name);
      const ok = await confirmDialog({
        title: `Leave ${from.owner}?`,
        message: `${lent.length ? `You lose ${listOf(lent)} at once. ` : ''}Your own sign-ins and skills stay.`,
        confirmLabel: 'Leave',
        danger: true,
      });
      if (!ok) return;
      return change(() => del(`/api/people/from/${encodeURIComponent(from.id)}`), () => toast(`You left ${from.owner}.`, 'ok'));
    }
  });

  // The logos of what is in the list, when it is more than names.
  if (state.available && !ctx.mcps && (state.people.length || state.invites.length || state.from.length)) {
    api('/api/mcps').then((res) => {
      ctx.mcps = new Map((res.mcps || []).map((m) => [m.id, m]));
      if (host.isConnected && !list.querySelector('[data-pp-form=more]')) paintList();
    }, () => {});
  }

  paintPanel();
  paintList();
  return { refresh };
}
