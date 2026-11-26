// Add agent: one flow, in the Agents section of Home. Pick an app (or the Loop Agent in Loop Cloud), give
// the agent a face, a name and a project, choose what it can use, then install it here or send a link.
// The agent is made at "Share"; its key is made when it is installed or when somebody opens its link.

import { mountPanel, panelBody, isOpenPanel, closeAgentPopup, openAgentPopup } from './agent-popup.js';
import { describeShareGrant, mountOAuthConsentPicker } from './oauth-consent-view.js';
import { agentRows, isPersonalWorkspace, resolveGatewayEndpoint } from './agents-view.js';
import { agentMark, kindLabel, INSTALL_KINDS, PICTURE_TINTS } from './agent-mark.js';
import { HOST_KINDS, hostSetup, hostSetupHtml } from './host-setup.js';

const POLL_MS = 2500;
const FIRST_APPS = 5; // how many apps the hosted list shows before "More apps"
const PICTURE_PX = 192;

const svg = (size, body, width = 1.6) => `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const CHEV = svg(14, '<path d="M8 5l5 5-5 5"/>', 1.8);
const BACK = svg(18, '<path d="M12 4.5L6.5 10l5.5 5.5"/>');
const PLUS = svg(17, '<path d="M10 4v12M4 10h12"/>');
const PENCIL = svg(14, '<path d="M4 16l.8-3.4L12.9 4.5a1.6 1.6 0 0 1 2.3 0l.3.3a1.6 1.6 0 0 1 0 2.3l-8.1 8.1z"/>', 1.8);
const PHOTO = svg(18, '<rect x="3" y="4" width="14" height="12" rx="2.5"/><circle cx="7.5" cy="8.3" r="1.2"/><path d="M4 14.5l4-3.5 2.5 2 3-3 3 3"/>');
const FOLDER = svg(17, '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3l1.8 2h6.2A1.5 1.5 0 0 1 17 8.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z"/>');
const DOWN = svg(13, '<path d="M5 8l5 5 5-5"/>', 1.8);
// The places where the Loop Agent can talk with you. A place is in this list only when it works.
const CHANNELS = [{
  id: 'imessage',
  name: 'iMessage',
  mark: '<span class="home-ic mark imessage aa-mk" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 3C6.48 3 2 6.86 2 11.62c0 2.52 1.26 4.79 3.27 6.37-.15 1.32-.71 2.48-1.45 3.32-.17.19-.02.49.23.46 1.72-.2 3.31-.86 4.46-1.69 1.09.32 2.27.5 3.49.5 5.52 0 10-3.86 10-8.62S17.52 3 12 3z"/></svg></span>',
}];

const isMac = () => /Mac/i.test(navigator.platform || '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * opts: project (chosen first), kind and name (an app that Loop already knows), agentId with
 * `start: 'ready'` (an agent with no key yet) or `start: 'edit'` (change its face and what it can use).
 */
export async function openAddAgent(ctx, opts = {}) {
  const p = mountPanel(ctx, 'Add agent', true);
  p.kind = 'add';
  p.changed = Boolean(opts.changed);
  p.el.classList.add('aa-root');
  p.el.querySelector('.st-sheet').classList.add('aa-sheet');
  p.add = {
    step: 1,
    kind: '',
    name: '',
    named: false,
    picture: null, // null (the app's mark), a tint, or an image as a data URL
    pictureChanged: false,
    pictureOpen: false,
    project: opts.project && opts.project !== 'all' ? opts.project : '',
    allApps: opts.allApps === true,
    channels: false, // the channels of the Loop Agent are open
    all: null, // the apps of "Add all": they share one list
    channel: '',
    picker: null,
    agent: null,
    link: null,
    linkError: '',
    copied: false,
    installed: false,
    connected: false,
    busy: '',
    edit: opts.start === 'edit',
    since: Date.now(),
  };
  try {
    const [agents, installable, vaultMode] = await Promise.all([
      ctx.api('/api/agents'),
      ctx.api('/api/agents/installable').catch(() => null),
      ctx.vaultModeOf ? ctx.vaultModeOf().catch(() => null) : null,
    ]);
    if (!isOpenPanel(p)) return;
    p.data = agents;
    p.vaultMode = vaultMode;
    p.apps = Array.isArray(installable?.agents) ? installable.agents : null;
    p.paired = Boolean(installable?.paired);
    p.cloudUrl = installable?.cloudUrl;
    // The apps on this computer, when this is the computer that Loop runs on.
    p.local = Boolean(p.apps) && !isPersonalWorkspace(agents, ctx);
  } catch (err) {
    if (!isOpenPanel(p)) return;
    panelBody(p).innerHTML = `<div class="ap-msg"><p>${ctx.esc(err.message)}</p></div>`;
    return;
  }
  panelBody(p).innerHTML = `
    <div class="aa" data-step="1">
      <section class="aa-s1"></section>
      <div class="aa-cols">
        <section class="aa-me"></section>
        <section class="aa-share">
          <div class="aa-share-head"></div>
          <div id="oc-picker"></div>
          <div class="aa-bar"><button type="button" class="btn fill aa-big" data-aa-share disabled></button></div>
        </section>
      </div>
      <section class="aa-s4" aria-live="polite"></section>
    </div>`;
  bind(p);
  loadTextAgent(p);

  const known = opts.agentId ? (p.data.agents || []).find((a) => a.id === opts.agentId) : null;
  if (known) {
    Object.assign(p.add, {
      agent: known,
      kind: known.kind || 'other',
      name: known.name,
      named: true,
      picture: known.pictureUrl || (PICTURE_TINTS.includes(known.picture) ? known.picture : null),
      project: known.project || '',
      step: p.add.edit ? 2 : 4,
    });
    startPicker(p, known);
    paint(p);
    if (p.add.step === 4) watch(p);
    return;
  }
  if (opts.kind || opts.name) {
    pick(p, opts.kind || 'other', opts.name || '');
    return;
  }
  paint(p);
  focusIn(p, '.aa-s1 [data-aa-app]');
}

/* ---------- pieces ---------- */

const root = (p) => p.el.querySelector('.aa');

// A control on a computer, the heading on a phone: a phone must not open its keyboard by itself.
function focusIn(p, selector) {
  p.el.querySelector(selector)?.focus({ preventScroll: true });
}

// Draws a part again. The focus stays in it, because Esc works only from inside the panel.
function draw(box, html) {
  const held = box.contains(document.activeElement) ? document.activeElement : null;
  const attr = held?.getAttributeNames().find((n) => n.startsWith('data-'));
  const same = attr && `[${attr}="${CSS.escape(held.getAttribute(attr))}"]:not([disabled])`;
  box.innerHTML = html;
  if (held) ((same && box.querySelector(same)) || box.querySelector('.ap-flow-t')).focus({ preventScroll: true });
}

function headHtml(p, { title, sub = '', step = 0, back = '' }) {
  const { esc } = p.ctx;
  return `
    <header class="aa-head">
      ${back ? `<button type="button" class="aa-back" data-aa-back="${esc(back)}" aria-label="Back">${BACK}</button>` : ''}
      <div class="aa-head-c">
        <h2 class="ap-flow-t" tabindex="-1">${esc(title)}</h2>
        ${sub ? `<p class="aa-sub">${esc(sub)}</p>` : ''}
      </div>
      ${step ? `<span class="aa-steps" role="img" aria-label="Step ${step} of 3">${[1, 2, 3].map((n) => `<i class="${n <= step ? 'is-on' : ''}"></i>`).join('')}</span>` : ''}
    </header>`;
}

// Any agent can start from this address: it signs in, and then the owner chooses.
const address = (p) => resolveGatewayEndpoint(p.local ? p.data.endpoint : '');

const appName = (p) => (p.add.kind === 'other' ? 'Another app' : p.apps?.find((a) => a.id === p.add.kind)?.name || kindLabel(p.add.kind));
const cleanName = (p) => String(p.add.name || '').replace(/\s+/g, ' ').trim();
const shownName = (p) => (p.add.all ? `all ${p.add.all.length}` : cleanName(p) || 'the agent');

// The agent as it looks now, for agentMark().
function face(p) {
  const { kind, picture } = p.add;
  return {
    kind,
    name: cleanName(p) || kindLabel(kind),
    ...(PICTURE_TINTS.includes(picture) ? { picture } : picture ? { pictureUrl: picture } : {}),
  };
}

function projects(p) {
  const list = Array.isArray(p.data?.profileRecords) ? p.data.profileRecords : [];
  return list.filter((r) => r && r.id && r.id !== 'all');
}

function projectName(p) {
  return projects(p).find((r) => r.id === p.add.project)?.name || '';
}

/* ---------- step 1: which agent ---------- */

function appRows(p) {
  const all = p.local
    ? p.apps
    : INSTALL_KINDS.map((id) => ({ id, name: kindLabel(id), installed: true }));
  const here = all.filter((a) => a.installed);
  return here.length ? here : all;
}

function paintPick(p) {
  const { esc } = p.ctx;
  const rows = appRows(p);
  const shown = p.local || p.add.allApps ? rows : rows.slice(0, FIRST_APPS);
  const open = p.local ? rows.filter((a) => !a.connected) : [];
  const line = (attrs, icon, name, value = '', cls = '', more = '', chev = CHEV) => `
    <li><button type="button" class="ln" ${attrs}>
      <span class="ln-ic">${icon}</span>
      <span class="ln-tx"><span class="ln-t">${esc(name)}</span></span>
      ${value ? `<span class="ln-v ${cls}">${esc(value)}</span>` : ''}
      <span class="ln-chev">${chev}</span>
    </button>${more}</li>`;
  // On this computer the row shows too, because the Loop Agent works from Loop Cloud.
  const { channels } = p.add;
  const loopRow = p.text?.enabled || (p.local && p.text)
    ? line(
      `data-aa-loop aria-expanded="${channels}"`,
      agentMark({ kind: 'imessage', name: 'Loop Agent' }, esc, 'aa-mk'),
      'Loop Agent',
      p.text.status?.linked ? 'Added' : '',
      '',
      channels
        ? `<ul class="aa-list aa-chan">${CHANNELS.map((c) => line(`data-aa-channel="${c.id}"`, c.mark, c.name, p.text.status?.linked ? 'Connected' : '')).join('')}</ul>`
        : '',
      DOWN,
    )
    : '';
  draw(p.el.querySelector('.aa-s1'), `
    ${headHtml(p, { title: 'Add agent', sub: 'Pick one. You name it next.', step: 1 })}
    <div class="aa-in">
      <div class="aa-k"><span>Install directly</span>${open.length > 1 ? '<button type="button" class="aa-link" data-aa-all>Add all</button>' : ''}</div>
      <ul class="aa-list">
        ${shown.map((a) => line(
          `data-aa-app="${esc(a.id)}"`,
          agentMark({ kind: a.id, name: a.name }, esc, 'aa-mk'),
          a.name,
          a.connected ? 'Added' : p.failed?.[a.id] ? 'Failed' : '',
          p.failed?.[a.id] ? 'is-no' : '',
        )).join('')}
        ${rows.length > shown.length ? line('data-aa-more', PLUS, 'More apps') : ''}
        ${p.paired ? '' : line('data-aa-app="other"', PLUS, p.local ? `Another app on this ${isMac() ? 'Mac' : 'computer'}` : 'Another app or computer', p.local ? 'Local only' : '')}
      </ul>
      <div class="aa-k"><span>Connect in the app</span></div>
      <ul class="aa-list">${HOST_KINDS.map((id) => line(`data-aa-app="${id}"`, agentMark({ kind: id, name: kindLabel(id) }, esc, 'aa-mk'), kindLabel(id))).join('')}</ul>
      ${loopRow ? `<div class="aa-k"><span>Loop Cloud</span></div><ul class="aa-list">${loopRow}</ul>` : ''}
      <p class="aa-hint aa-addr">Or give an agent your address, and choose when it signs in.</p>
      <div class="vf-f aa-f aa-linkrow"><span class="aa-url" title="${esc(address(p))}">${esc(address(p).replace(/^https?:\/\//, ''))}</span><button type="button" class="aa-copy" data-aa-address>Copy<span class="sr-only"> the address</span></button></div>
    </div>`);
}

async function loadTextAgent(p) {
  const text = await p.ctx.api('/api/sms-agent').catch(() => null);
  if (!isOpenPanel(p)) return;
  p.text = text;
  if (p.add.step === 1) paintPick(p);
}

function pick(p, kind, name = '') {
  const a = p.add;
  a.all = null;
  a.kind = kind;
  if (!a.named) a.name = name || (kind === 'other' ? '' : appName(p));
  if (HOST_KINDS.includes(kind) && (!a.project || p.paired)) {
    a.ownerSetup = true;
    return go(p, 4);
  }
  if (p.paired) {
    pairedInstall(p);
    return;
  }
  startPicker(p);
  go(p, 2);
}

// An app that is added opens its agent.
function openAdded(p, app) {
  const rows = agentRows(p.data.agents || [], Array.isArray(p.data.connected) ? p.data.connected : []);
  const row = rows.find((r) => r.agent && r.agent.id === app.agentId)
    || rows.find((r) => r.agent && r.agent.kind === app.id)
    || rows.find((r) => r.kind === app.id);
  if (!row) return pick(p, app.id);
  openAgentPopup(nextCtx(p), row.id, row.agent ? 'access' : '');
}

// "Add all": one list for every app on this computer that is not added. One agent can change later.
function pickAll(p) {
  const all = appRows(p).filter((a) => !a.connected);
  if (all.length < 2 || p.add.busy) return;
  p.add.all = all;
  if (p.paired) {
    pairedInstall(p);
    return;
  }
  startPicker(p);
  go(p, 3);
}

async function addAll(p) {
  const a = p.add;
  const access = a.picker?.getAccess();
  if (!access || a.busy) return;
  a.busy = 'all';
  paintShareLabel(p);
  try {
    const results = await installApps(p, { targets: a.all.map((app) => app.id), access });
    if (!isOpenPanel(p)) return;
    const ok = results.filter((r) => r.ok);
    p.failed = Object.fromEntries(results.filter((r) => !r.ok).map((r) => [r.id, true]));
    if (a.project) await Promise.all(ok.map((r) => p.ctx.api(`/api/agents/${encodeURIComponent(r.agentId)}`, { method: 'PATCH', body: JSON.stringify({ project: a.project }) }).catch(() => null)));
    const fresh = await p.ctx.api('/api/agents/installable').catch(() => null);
    if (!isOpenPanel(p)) return;
    if (Array.isArray(fresh?.agents)) p.apps = fresh.agents;
    p.data = await p.ctx.api('/api/agents').catch(() => p.data);
    if (!isOpenPanel(p)) return;
    p.changed = p.changed || ok.length > 0;
    p.ctx.toast(ok.length ? `${plural(ok.length, 'agent is', 'agents are')} added. Restart open apps.` : results[0]?.error || 'Loop could not add them.', ok.length ? 'ok' : 'err');
  } catch (err) {
    if (!isOpenPanel(p)) return;
    p.ctx.toast(err.message, 'err');
    a.busy = '';
    paintShareLabel(p);
    return;
  }
  a.busy = '';
  go(p, 1);
}

/** Puts Loop in the settings of apps on this computer. A paired computer asks in Loop Cloud first. */
async function installApps(p, body, onApprove = null) {
  let res;
  try {
    res = await p.ctx.api('/api/agents/install', { method: 'POST', body: JSON.stringify(body) });
  } catch (err) {
    if (Array.isArray(err?.data?.results) && err.data.results.length) return err.data.results;
    throw err;
  }
  if (res?.verificationUrl) {
    onApprove?.(res.verificationUrl);
    const route = `/api/local/connect/agent-requests/${encodeURIComponent(res.requestId)}`;
    const wait = (res.interval || 2) * 1000;
    for (let polls = 0; ; polls += 1) {
      if (polls >= 150) throw new Error('Loop stopped waiting. Start again.');
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (!isOpenPanel(p)) return [];
      res = await p.ctx.api(route, { method: 'POST', body: '{}' });
      if (!res.pending) break;
    }
  }
  return Array.isArray(res?.results) ? res.results : [];
}

/* ---------- a paired computer: the agent lives in Loop Cloud ---------- */

async function pairedInstall(p) {
  const a = p.add;
  Object.assign(a, { busy: 'paired', approveUrl: '', error: '', installed: false });
  go(p, 5);
  try {
    const results = await installApps(p, { targets: a.all ? a.all.map((app) => app.id) : [a.kind] }, (url) => {
      a.approveUrl = url;
      paint(p);
    });
    if (!isOpenPanel(p)) return;
    const failed = results.filter((r) => !r.ok);
    p.changed = p.changed || results.some((r) => r.ok);
    if (failed.length || !results.length) throw new Error(failed[0]?.error || 'Loop could not add it.');
    a.installed = true;
    p.changed = true;
  } catch (err) {
    if (!isOpenPanel(p)) return;
    a.error = err.message;
  }
  a.busy = '';
  paint(p);
}

function paintPaired(p) {
  const { esc } = p.ctx;
  const a = p.add;
  const name = a.all ? `${a.all.length} agents` : appName(p);
  p.el.querySelector('.aa-s4').innerHTML = `
    ${headHtml(p, {
      title: a.installed ? `${name} ${a.all ? 'are' : 'is'} added` : `Add ${name}`,
      sub: a.installed ? `Restart ${a.all ? 'the apps' : name} to use Loop.` : `You choose in Loop Cloud what ${a.all ? 'they' : 'it'} can use.`,
      back: a.installed ? '' : '1',
    })}
    <div class="aa-in">
      ${a.installed ? `<button type="button" class="btn fill aa-big" data-ap-close>Done</button>` : a.error
        ? `<p class="aa-err" role="alert">${esc(a.error)}</p><button type="button" class="btn fill aa-big" data-aa-paired>Try again</button>`
        : `${a.approveUrl ? `<a class="btn fill aa-big" href="${esc(a.approveUrl)}" target="_blank" rel="noopener noreferrer">Approve in Loop Cloud</a>` : '<button type="button" class="btn fill aa-big" disabled>Starting…</button>'}
          ${a.approveUrl ? waitHtml('Loop waits for your yes.') : ''}`}
    </div>`;
}

/* ---------- the Loop Agent: it works from Loop Cloud ---------- */

function pickChannel(p, id) {
  // Loop has the phone number: the code for your phone is in Settings.
  if (p.text?.enabled) {
    closeAgentPopup({ immediate: true });
    location.hash = '#settings?tab=text';
    return;
  }
  p.add.channel = id;
  go(p, 6);
}

// This Loop is on one computer and has no phone number, so say so here. Nothing leaves this Loop.
function paintChannel(p) {
  const { esc } = p.ctx;
  const channel = CHANNELS.find((c) => c.id === p.add.channel) || CHANNELS[0];
  const mac = isMac() ? 'Mac' : 'computer';
  draw(p.el.querySelector('.aa-s4'), `
    ${headHtml(p, { title: 'Loop Agent', sub: channel.name, back: '1' })}
    <div class="aa-in">
      <div class="aa-pic">${agentMark({ kind: 'imessage', name: 'Loop Agent' }, esc, 'aa-xl')}</div>
      <p class="aa-say">It needs a phone number, and the Loop on this ${mac} has none. Only Loop Cloud can give it one now.</p>
    </div>`);
}

/* ---------- step 2: its face ---------- */

function localOnlyNoticeHtml(p) {
  const a = p.add;
  if (!p.local || p.paired || a.edit || a.all) return '';
  const here = p.apps.some((x) => x.id === a.kind);
  if (here) return '';
  const mac = isMac() ? 'Mac' : 'computer';
  return `<p class="aa-hint aa-local-note" role="note">Local Loop works on this ${mac} only. The setup link works on this ${mac} only; use Loop Cloud for another computer.</p>`;
}

function paintMe(p) {
  const { esc } = p.ctx;
  const a = p.add;
  const list = projects(p);
  p.el.querySelector('.aa-me').innerHTML = `
    ${headHtml(p, { title: a.edit ? a.agent.name : appName(p), sub: a.edit ? '' : 'Make it yours, or just go on.', step: a.edit ? 0 : 2, back: a.edit ? 'agent' : a.agent ? '' : '1' })}
    <div class="aa-in">
      <div class="aa-pic">
        <span class="aa-pic-now">${agentMark(face(p), esc, 'aa-xl')}</span>
        <button type="button" class="aa-pen" data-aa-pen aria-expanded="${a.pictureOpen}" aria-label="Change the picture">${PENCIL}</button>
      </div>
      <div class="aa-pics" ${a.pictureOpen ? '' : 'hidden'}>${picturesHtml(p)}</div>
      <label class="vf-f aa-f"><input type="text" id="aa-name" maxlength="80" value="${esc(a.name)}" placeholder="Name" aria-label="Name" autocomplete="off" autocapitalize="words" enterkeyhint="next"></label>
      ${list.length ? `
        <label class="vf-f aa-f aa-proj">
          <span class="aa-f-ic">${FOLDER}</span>
          <span class="aa-f-l">Project</span>
          <select id="aa-project" aria-label="Project">
            <option value="">None</option>
            ${list.map((r) => `<option value="${esc(r.id)}" ${r.id === a.project ? 'selected' : ''}>${esc(r.name || r.id)}</option>`).join('')}
          </select>
          <span class="aa-f-chev">${DOWN}</span>
        </label>
        <p class="aa-hint">A project keeps things in order. It does not limit the agent.</p>` : ''}
      ${localOnlyNoticeHtml(p)}
      <button type="button" class="btn fill aa-big aa-next" data-aa-next>Next</button>
      <button type="button" class="btn fill aa-big aa-share-wide" data-aa-share disabled></button>
    </div>`;
  paintShareLabel(p);
}

function picturesHtml(p) {
  const { esc } = p.ctx;
  const { picture } = p.add;
  const base = { kind: p.add.kind, name: cleanName(p) || kindLabel(p.add.kind) };
  const custom = Boolean(picture) && !PICTURE_TINTS.includes(picture);
  return `
    <button type="button" data-aa-pic="" aria-pressed="${!picture}" aria-label="The mark of the app">${agentMark(base, esc, 'aa-md')}</button>
    ${PICTURE_TINTS.map((t) => `<button type="button" data-aa-pic="${t}" aria-pressed="${picture === t}" aria-label="Letter on ${t}">${agentMark({ ...base, picture: t }, esc, 'aa-md')}</button>`).join('')}
    <button type="button" class="aa-up" data-aa-upload aria-pressed="${custom}" aria-label="Use an image">${PHOTO}</button>
    <input type="file" accept="image/*" data-aa-file hidden>`;
}

// The face changes without a new field, so that typing is not interrupted.
function repaintFace(p) {
  const { esc } = p.ctx;
  const me = p.el.querySelector('.aa-me');
  const now = me?.querySelector('.aa-pic-now');
  if (!now) return;
  now.innerHTML = agentMark(face(p), esc, 'aa-xl');
  const focus = document.activeElement?.closest?.('.aa-pics') ? document.activeElement.dataset.aaPic : undefined;
  me.querySelector('.aa-pics').innerHTML = picturesHtml(p);
  if (focus !== undefined) focusIn(p, `.aa-pics [data-aa-pic="${CSS.escape(focus)}"]`);
  const title = p.el.querySelector('.aa-share-head .ap-flow-t');
  if (title) title.textContent = `What can ${shownName(p)} use?`;
}

// A square, small image: Loop keeps it beside the agent, so it must not be a whole photo.
async function squareImage(file) {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = PICTURE_PX;
  canvas.height = PICTURE_PX;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, PICTURE_PX, PICTURE_PX);
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, PICTURE_PX, PICTURE_PX);
  bmp.close?.();
  const webp = canvas.toDataURL('image/webp', 0.86);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.86);
}

function setPicture(p, picture) {
  p.add.picture = picture || null;
  p.add.pictureChanged = true;
  repaintFace(p);
}

/* ---------- step 3: what it can use ---------- */

function startPicker(p, currentAgent = null) {
  if (p.add.picker) return;
  p.add.picker = mountOAuthConsentPicker(p.el.querySelector('.aa-share'), {
    esc: p.ctx.esc,
    api: p.ctx.api,
    renderConnLogo: p.ctx.renderConnLogo,
    groupConnectionsByCategory: p.ctx.groupConnectionsByCategory,
    clientName: currentAgent?.name || 'Agent',
    currentAgent,
    panel: true,
    vaultMode: p.vaultMode,
    onChange: (sum) => {
      p.add.sum = sum;
      if (!isOpenPanel(p)) return;
      paintShareLabel(p);
      const facts = p.el.querySelector('.aa-face-d');
      if (facts) facts.textContent = factsText(p);
    },
  });
}

function paintShareHead(p) {
  const a = p.add;
  p.el.querySelector('.aa-share-head').innerHTML = headHtml(p, {
    title: `What can ${shownName(p)} use?`,
    sub: a.all ? 'You can change one agent later.' : 'Turn off what it must not use.',
    step: a.edit ? 0 : a.all ? 2 : 3,
    back: a.all ? '1' : '2',
  }) + (a.all ? `<div class="aa-faces" role="img" aria-label="${p.ctx.esc(a.all.map((app) => app.name).join(', '))}">${a.all.map((app) => agentMark({ kind: app.id, name: app.name }, p.ctx.esc, 'aa-fc')).join('')}</div>` : '') + localOnlyNoticeHtml(p);
}

function paintShareLabel(p) {
  const { sum, busy, edit, all } = p.add;
  const wait = busy === 'share' || busy === 'all';
  const grant = describeShareGrant(sum);
  const label = wait ? 'One moment…' : all ? `Add ${all.length} agents` : edit ? 'Save' : grant.buttonLabel;
  p.el.querySelectorAll('[data-aa-share]').forEach((b) => {
    b.textContent = label;
    b.disabled = !sum?.ready || wait;
  });
}

async function share(p) {
  const a = p.add;
  const access = a.picker?.getAccess();
  if (!access || a.busy) return;
  const name = cleanName(p) || (a.kind === 'other' ? 'Agent' : appName(p));
  a.name = name;
  a.busy = 'share';
  paintShareLabel(p);
  const body = {
    name,
    kind: a.kind || 'other',
    project: a.project || null,
    ...access,
    ...(a.pictureChanged ? { picture: a.picture } : {}),
  };
  try {
    const res = a.agent
      ? await p.ctx.api(`/api/agents/${encodeURIComponent(a.agent.id)}`, { method: 'PATCH', body: JSON.stringify(body) })
      : await p.ctx.api('/api/agents', { method: 'POST', body: JSON.stringify({ ...body, key: false }) });
    if (!isOpenPanel(p)) return;
    a.agent = res.agent;
    a.pictureChanged = false;
    a.busy = '';
    p.changed = true;
    paintHomeRow(p);
    if (a.edit) {
      backToAgent(p, 'Saved.');
      return;
    }
    go(p, 4);
    if (!a.link) makeLink(p);
    watch(p);
  } catch (err) {
    if (!isOpenPanel(p)) return;
    a.busy = '';
    paintShareLabel(p);
    p.ctx.toast(err.message, 'err');
  }
}

// Home draws its rows again when the panel closes. Until then, update or insert the row immediately.
function paintHomeRow(p) {
  const { agent } = p.add;
  if (!agent?.id) return;
  const row = document.querySelector(`[data-open-agent="${CSS.escape(agent.id)}"]`);
  if (row) {
    const t = row.querySelector('.t');
    if (t) t.textContent = agent.name;
    const ic = row.querySelector('.home-ic');
    if (ic) ic.outerHTML = agentMark(agent, p.ctx.esc);
    return;
  }
  const list = document.querySelector('[data-hm-group="agents"] > ul.list');
  if (!list) return;
  list.querySelector('.hm-agent-add')?.closest('li')?.remove();
  const li = document.createElement('li');
  li.innerHTML = `
    <button type="button" class="row ctl-row hm-agent" data-open-agent="${p.ctx.esc(agent.id)}">
      ${agentMark(agent, p.ctx.esc)}
      <span class="txt">
        <span class="t">${p.ctx.esc(agent.name)}</span>
        <span class="ctl-st">Waiting to connect</span>
      </span>
    </button>`;
  const btn = li.querySelector('[data-open-agent]');
  btn?.addEventListener('click', () => openAgentPopup(nextCtx(p), agent.id));
  list.prepend(li);
}

// Back to the agent that this panel was opened from.
function backToAgent(p, message = '') {
  if (message) p.ctx.toast(message, 'ok');
  openAgentPopup(nextCtx(p), p.add.agent?.id, 'access');
}

// For a panel that takes the place of this one: Home draws what changed here when that panel closes.
function nextCtx(p) {
  const { ctx } = p;
  return p.changed ? { ...ctx, changed: true, onClose: () => ctx.onClose?.(true) } : ctx;
}

/* ---------- step 4: ready ---------- */

function factsText(p) {
  const { sum, kind } = p.add;
  const where = [kind === 'other' ? 'Any app' : appName(p), projectName(p)].filter(Boolean).join(', ');
  if (!sum?.ready) return `${where}.`;
  const grant = describeShareGrant(sum);
  return `${where}. ${grant.summaryText || 'Nothing shared'}.`;
}

function waitHtml(text, ok = false) {
  return `<div class="ap-waitrow aa-wait ${ok ? 'is-ok' : ''}" role="status"><span class="ap-pulse" aria-hidden="true"></span><span>${text}</span></div>`;
}

function paintReady(p) {
  const { esc } = p.ctx;
  const a = p.add;
  const name = a.agent?.name || shownName(p);
  const app = appName(p);
  const here = p.local && p.apps.some((x) => x.id === a.kind);
  const { link } = a;

  if (a.ownerSetup) {
    const setup = hostSetup(a.kind, resolveGatewayEndpoint(p.data.endpoint));
    const cloud = setup ? new URL(setup.url).origin : 'https://useloop.sh';
    draw(p.el.querySelector('.aa-s4'), `
      ${headHtml(p, { title: `Connect ${app}`, back: '1' })}
      <div class="aa-in">${p.paired && a.project ? '' : hostSetupHtml(setup, esc)}
        ${setup && !(p.paired && a.project) ? '<p class="aa-hint">After sign-in, open this connection under Agents to review its activity or turn it off.</p>' : ''}
        ${p.paired || !setup ? `<a class="btn fill aa-big" href="${esc(cloud)}" target="_blank" rel="noreferrer">Open Loop Cloud</a>` : '<button type="button" class="btn aa-big" data-aa-restrict>Share selected access with a key</button>'}
      </div>`);
    return;
  }

  let main = '';
  if (a.connected) {
    main = `${waitHtml(`${esc(name)} is connected`, true)}<button type="button" class="btn fill aa-big" data-ap-close>Done</button>`;
  } else if (a.installed) {
    main = `${waitHtml(`Restart ${esc(app)}. Loop waits for ${esc(name)}.`)}<button type="button" class="btn fill aa-big" data-ap-close>Done</button>`;
  } else if (here) {
    main = `<button type="button" class="btn fill aa-big" data-aa-install ${a.busy ? 'disabled' : ''}>${a.busy === 'install' ? 'One moment…' : `Install on this ${isMac() ? 'Mac' : 'computer'}`}</button>`;
  } else if (HOST_KINDS.includes(a.kind)) {
    main = link && !link.thisComputerOnly ? `<a class="btn fill aa-big" href="${esc(link.url)}" target="_blank" rel="noreferrer">Set up in ${esc(app)}</a>` : '';
  } else if (a.kind !== 'other') {
    main = `<button type="button" class="btn fill aa-big" data-aa-command ${link ? '' : 'disabled'}>Copy the terminal command</button>
      <p class="aa-hint">Run it on the computer that has ${esc(app)}.</p>`;
  }

  let send = '';
  if (!a.installed && !a.connected) {
    const only = !main;
    const row = link
      ? `<div class="vf-f aa-f aa-linkrow"><span class="aa-url" title="${esc(link.url)}">${esc(link.url.replace(/^https?:\/\//, ''))}</span><button type="button" class="aa-copy" data-aa-copy>Copy</button></div>`
      : a.linkError
        ? `<p class="aa-err" role="alert">${esc(a.linkError)}</p><button type="button" class="btn aa-big" data-aa-mklink>Try again</button>`
        : a.busy === 'link'
          ? '<div class="vf-f aa-f aa-linkrow"><span class="aa-url">One moment…</span></div>'
          : `<button type="button" class="btn aa-big" data-aa-mklink>Make a link</button>`;
    const note = !link
      ? 'A new link ends the one that you made before.'
      : link.thisComputerOnly
        ? `This link opens on this ${isMac() ? 'Mac' : 'computer'} only. Use Loop Cloud to send one. One use, ends in 24 hours.`
        : 'For you on another computer, or for anyone. One use, ends in 24 hours. It gets only what you shared.';
    send = `
      ${only ? '' : `<div class="aa-or"><span>${link?.thisComputerOnly ? 'or use a link' : 'or send it'}</span></div>`}
      ${row}
      <p class="aa-hint">${esc(note)}</p>
      ${only && link ? '<button type="button" class="btn fill aa-big" data-aa-copy>Copy the link</button>' : ''}
      ${a.copied ? waitHtml(`Loop waits for ${esc(name)}.`) : ''}`;
  }

  draw(p.el.querySelector('.aa-s4'), `
    ${headHtml(p, { title: a.connected ? `${name} is connected` : `${name} is ready`, back: a.installed || a.connected ? '' : '3' })}
    <div class="aa-in">
      <div class="aa-face">
        ${agentMark(face(p), esc, 'aa-lg')}
        <div class="aa-face-c"><div class="aa-face-n">${esc(name)}</div><div class="aa-face-d">${esc(factsText(p))}</div></div>
      </div>
      ${main}
      ${send}
    </div>`);
}

async function makeLink(p) {
  const a = p.add;
  if (!a.agent || a.busy === 'link') return;
  a.busy = 'link';
  a.linkError = '';
  if (a.step === 4) paintReady(p);
  try {
    const from = p.ctx.ownerName ? p.ctx.ownerName() : '';
    const link = await p.ctx.api(`/api/agents/${encodeURIComponent(a.agent.id)}/link`, { method: 'POST', body: JSON.stringify({ from }) });
    if (!isOpenPanel(p)) return;
    a.link = link;
  } catch (err) {
    if (!isOpenPanel(p)) return;
    a.linkError = err.message;
  }
  a.busy = '';
  if (a.step === 4) paintReady(p);
}

async function install(p) {
  const a = p.add;
  if (a.busy) return;
  a.busy = 'install';
  paintReady(p);
  try {
    const [result] = await installApps(p, { targets: [a.kind], agentId: a.agent.id });
    if (!isOpenPanel(p)) return;
    if (!result?.ok) throw new Error(result?.error || `Loop could not change the settings of ${appName(p)}.`);
    a.installed = true;
    a.link = null; // the key is in the app now, so the link has ended
    p.changed = true;
  } catch (err) {
    if (!isOpenPanel(p)) return;
    p.ctx.toast(err.message, 'err');
  }
  a.busy = '';
  paintReady(p);
  focusIn(p, '.aa-s4 [data-ap-close], .aa-s4 [data-aa-install]');
}

// The panel says "connected" by itself when the new key is used for the first time.
function watch(p) {
  const a = p.add;
  if (p.timer || a.connected) return;
  const tick = async () => {
    p.timer = null;
    if (!isOpenPanel(p) || a.connected) return;
    try {
      const data = await p.ctx.api('/api/agents');
      if (!isOpenPanel(p)) return;
      const now = (data.agents || []).find((x) => x.id === a.agent?.id);
      if (now && Date.parse(now.lastSeenAt) >= a.since) {
        a.connected = true;
        p.changed = true;
        if (now.kind && now.kind !== a.kind) a.kind = now.kind;
        if (a.step === 4) paintReady(p);
        return;
      }
    } catch {
      /* try again on the next tick */
    }
    if (isOpenPanel(p)) p.timer = setTimeout(tick, POLL_MS);
  };
  p.timer = setTimeout(tick, POLL_MS);
}

/* ---------- moving between the steps ---------- */

function paint(p) {
  const { step, all } = p.add;
  root(p).dataset.step = String(step);
  root(p).classList.toggle('is-all', Boolean(all));
  if (step === 1) paintPick(p);
  else if (step === 2 || step === 3) {
    if (!all) paintMe(p);
    paintShareHead(p);
    paintShareLabel(p);
  } else if (step === 4) paintReady(p);
  else if (step === 6) paintChannel(p);
  else paintPaired(p);
}

function go(p, step) {
  p.add.step = step;
  if (step !== 2) p.add.pictureOpen = false;
  paint(p);
  const part = { 1: '.aa-s1', 2: '.aa-me', 3: '.aa-share', 4: '.aa-s4', 5: '.aa-s4', 6: '.aa-s4' }[step];
  // A long list is above a short step: bring the top of the panel back into view, under the section heading.
  const lid = p.el.__xpAnchor?.isConnected ? p.el.__xpAnchor.getBoundingClientRect() : null;
  const edge = Math.max(p.el.closest('.ctl-scroll')?.getBoundingClientRect().top || 0, lid?.bottom || 0);
  const top = p.el.querySelector(`${part} .ap-flow-t`)?.getBoundingClientRect().top ?? 0;
  if (top < edge || top > window.innerHeight * 0.7) {
    p.el.style.scrollMarginTop = `${Math.round((lid?.height || 0) + 8)}px`;
    p.el.scrollIntoView({ block: 'start' });
  }
  focusIn(p, `${part} .ap-flow-t`);
}

function bind(p) {
  const a = p.add;
  p.el.addEventListener('click', (e) => {
    const hit = (sel) => e.target.closest(sel);
    const app = hit('[data-aa-app]');
    if (app) {
      const id = app.dataset.aaApp;
      const known = p.apps?.find((x) => x.id === id);
      if (p.local && known?.connected) return openAdded(p, known);
      return pick(p, id);
    }
    if (hit('[data-aa-more]')) {
      a.allApps = true;
      paintPick(p);
      return focusIn(p, `.aa-s1 li:nth-child(${FIRST_APPS + 1}) .ln`);
    }
    if (hit('[data-aa-all]')) return pickAll(p);
    if (hit('[data-aa-address]')) return void p.ctx.copyText(address(p), 'Address copied.');
    if (hit('[data-aa-loop]')) {
      a.channels = !a.channels;
      paintPick(p);
      if (a.channels) p.el.querySelector('.aa-chan').scrollIntoView({ block: 'nearest' });
      return undefined;
    }
    const channel = hit('[data-aa-channel]');
    if (channel) return pickChannel(p, channel.dataset.aaChannel);
    const back = hit('[data-aa-back]');
    if (back) {
      if (back.dataset.aaBack === 'agent') return backToAgent(p);
      if (back.dataset.aaBack === '1') a.ownerSetup = false;
      return go(p, Number(back.dataset.aaBack));
    }
    if (hit('[data-aa-pen]')) {
      a.pictureOpen = !a.pictureOpen;
      p.el.querySelector('.aa-pics').hidden = !a.pictureOpen;
      p.el.querySelector('[data-aa-pen]').setAttribute('aria-expanded', String(a.pictureOpen));
      return;
    }
    const pic = hit('[data-aa-pic]');
    if (pic) return setPicture(p, pic.dataset.aaPic);
    if (hit('[data-aa-upload]')) return p.el.querySelector('[data-aa-file]').click();
    if (hit('[data-aa-next]')) return go(p, 3);
    if (hit('[data-aa-restrict]')) {
      a.ownerSetup = false;
      startPicker(p);
      return go(p, 2);
    }
    const hostCopy = hit('[data-host-copy]');
    if (hostCopy) {
      const setup = hostSetup(a.kind, resolveGatewayEndpoint(p.data.endpoint));
      if (setup) p.ctx.copyText(setup[hostCopy.dataset.hostCopy], 'Copied.');
      return;
    }
    if (hit('[data-aa-share]')) return void (a.all ? addAll(p) : share(p));
    if (hit('[data-aa-install]')) return void install(p);
    if (hit('[data-aa-mklink]')) return void makeLink(p);
    if (hit('[data-aa-paired]')) return void pairedInstall(p);
    if (hit('[data-aa-copy]') || hit('[data-aa-command]')) {
      if (!a.link) return;
      const command = Boolean(hit('[data-aa-command]'));
      p.ctx.copyText(command ? a.link.command : a.link.url, command ? 'Copied. Run it in a terminal.' : 'Link copied.');
      if (!a.copied) {
        a.copied = true;
        paintReady(p);
        focusIn(p, command ? '[data-aa-command]' : '[data-aa-copy]');
      }
    }
  });
  p.el.addEventListener('input', (e) => {
    if (e.target.id !== 'aa-name') return;
    a.name = e.target.value;
    a.named = Boolean(cleanName(p));
    repaintFace(p);
  });
  p.el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.id !== 'aa-name') return;
    e.preventDefault();
    const next = p.el.querySelector('[data-aa-next]');
    if (next?.offsetParent) next.click();
    else e.target.blur();
  });
  p.el.addEventListener('focusin', (e) => {
    if (e.target.id === 'aa-name' && !a.named) e.target.select();
  });
  p.el.addEventListener('change', async (e) => {
    if (e.target.id === 'aa-project') a.project = e.target.value;
    if (!e.target.matches('[data-aa-file]') || !e.target.files?.[0]) return;
    try {
      const image = await squareImage(e.target.files[0]);
      if (isOpenPanel(p)) setPicture(p, image);
    } catch {
      if (isOpenPanel(p)) p.ctx.toast('Loop cannot read that image. Try a PNG or a JPEG.', 'err');
    }
  });
}
