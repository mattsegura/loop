// The three approval modes (Allow, Ask, Guard) as the Vault page and the connection panel show them.
// What they mean is decided in lib/policies.mjs; this file only draws and saves them.
import { esc } from './core/utils.js';

const svg = (paths, attrs = '') =>
  `<svg class="vm-g" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${attrs}>${paths}</svg>`;
const CHEV = '<svg class="vm-chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg>';
const CHECK = '<svg class="vm-check" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5l4 4 8-9"/></svg>';

export const MODES = [
  { id: 'auto', label: 'Allow', line: 'Agents use it. Loop keeps a log.', glyph: svg('<path d="M5 12h13M13 7l5 5-5 5"/>') },
  { id: 'always_ask', label: 'Ask', line: 'You say yes in the chat, by text or here.', glyph: svg('<path d="M5.5 4.5h13a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11l-4.5 3.5v-3.5h-1a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z"/>') },
  { id: 'guard', label: 'Guard', line: 'You confirm on the Loop page, every time.', glyph: svg('<path d="M12 3l7.5 2.9v5.2c0 4.5-3 8-7.5 9.9-4.5-1.9-7.5-5.4-7.5-9.9V5.9z" fill="currentColor" stroke="none"/>') },
];
const BY_ID = new Map(MODES.map((m) => [m.id, m]));
const MIXED = { id: 'mixed', label: 'Mixed', line: '', glyph: '' };
const UNAVAILABLE = {
  id: 'unavailable',
  label: 'Unavailable',
  line: 'Loop could not load this approval rule.',
  glyph: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5h.01"/>'),
};
const RANK = { auto: 0, always_ask: 1, guard: 2 };

export const modeLabel = (id) => (id === 'unavailable' ? UNAVAILABLE.label : (BY_ID.get(id) || MIXED).label);
export const modeLine = (id) => BY_ID.get(id)?.line || '';
export const modeGlyph = (id) => BY_ID.get(id)?.glyph || '';
export const isMode = (id) => BY_ID.has(id);
export const stricterMode = (a, b) => (RANK[b] > RANK[a] ? b : a);

/** What each Vault kind is called in a sentence. */
const KIND_WORDS = {
  login: { one: 'login', all: 'all logins', rest: 'The other logins are' },
  payment: { one: 'card', all: 'all cards', rest: 'The other cards are' },
  note: { one: 'item', all: 'all personal info', rest: 'The other personal info is' },
  api_key: { one: 'key', all: 'all API keys', rest: 'The other API keys are' },
};
/** A kind with its own words for "take these off Guard". */
export const kindName = (kind) => KIND_WORDS[kind]?.all || 'this';

/* ---------- the rules on tools ---------- */

const LOOP_ACTIONS = ['cleanup', 'organize', 'delete'];
// Always at least Ask, so the row writes them only to put them on Guard.
const LOOP_HELD_ACTIONS = ['add_local', 'repoint'];
const oneOf = (modes) => (modes.every((m) => m === modes[0]) ? modes[0] : 'mixed');
const fill = (keys, mode) => Object.fromEntries(keys.map((key) => [key, mode]));

/** The rows of the Tools section: the mode in use, the lowest mode it can have, and what a choice saves. */
export function toolRows(policies) {
  const floor = policies.default;
  const kinds = policies.toolKinds;
  const kindMode = (keys) => oneOf(keys.map((key) => stricterMode(kinds[key], floor)));
  return [
    {
      id: 'any',
      icon: 'plug',
      label: 'Any tool call',
      cap: 'A connection or tool with a rule of its own keeps it.',
      mode: floor,
      patch: (mode) => ({ default: mode }),
    },
    ...(kinds ? [
      {
        id: 'write',
        icon: 'write',
        label: 'Add or change',
        cap: 'Also tools that do not say what they do.',
        mode: kindMode(['write', 'unmarked']),
        floor,
        patch: (mode) => ({ toolKinds: fill(['write', 'unmarked'], mode) }),
      },
      {
        id: 'destructive',
        icon: 'delete',
        label: 'Delete or overwrite',
        cap: 'Tools that say they can remove or replace data.',
        mode: kindMode(['destructive']),
        floor,
        patch: (mode) => ({ toolKinds: { destructive: mode } }),
      },
    ] : []),
    {
      id: 'loop',
      icon: 'loop',
      label: 'Changes to Loop',
      cap: 'Agents that delete items, change categories or clean up other agents.',
      mode: oneOf(LOOP_ACTIONS.map((key) => policies.actions[key])),
      patch: (mode) => ({ actions: { ...fill(LOOP_ACTIONS, mode), ...fill(LOOP_HELD_ACTIONS, mode === 'guard' ? 'guard' : null) } }),
    },
  ];
}

/* ---------- markup ---------- */

/** The rule on a section heading: its sign, its name and a small arrow. */
export function modeHead({ id, mode, open, label }) {
  const m = mode === 'unavailable' ? UNAVAILABLE : (BY_ID.get(mode) || MIXED);
  const hint = m.id === 'unavailable' ? 'Retry loading the rule' : 'Change the rule';
  return `<button type="button" class="vm-head is-${esc(m.id)}" data-vm-open="${esc(id)}" aria-expanded="${open}" aria-label="${esc(label)}: ${esc(m.label)}. ${hint}">${m.glyph}<span>${esc(m.label)}</span>${CHEV}</button>`;
}

/** The three choices, under a section heading or a tool row. Choices under the floor are off. */
export function modeChoices({ id, mode, label, floor = 'auto', cap = '', error = '' }) {
  if (mode === 'unavailable') {
    return `
    <div class="vm-list" data-vm-list="${esc(id)}">
      <p class="vm-cap">${esc(error || UNAVAILABLE.line)}</p>
      <button type="button" class="btn sm" data-vm-retry="${esc(id)}">Retry</button>
    </div>`;
  }
  return `
    <div class="vm-list" data-vm-list="${esc(id)}">
      ${cap ? `<p class="vm-cap">${esc(cap)}</p>` : ''}
      <div role="radiogroup" aria-label="Rule for ${esc(label)}">
      ${MODES.map((m) => {
        const off = RANK[m.id] < RANK[floor];
        return `
        <button type="button" class="vm-opt is-${m.id}" role="radio" aria-checked="${m.id === mode}" data-vm-pick="${m.id}" ${off ? 'disabled' : ''}>
          <span class="vm-ic">${m.glyph}</span>
          <span class="vm-tx"><span class="vm-t">${m.label}</span><span class="vm-l">${off ? `Any tool call is on ${modeLabel(floor)}.` : m.line}</span></span>
          ${CHECK}
        </button>`;
      }).join('')}
      </div>
    </div>`;
}

/** The modes of one item, side by side, and what the choice means against the rest of its kind. */
export function modeSegment({ key, kind, mode, kindMode, label }) {
  const words = KIND_WORDS[kind] || KIND_WORDS.api_key;
  const same = mode === kindMode;
  const line = mode === 'guard' ? 'You confirm on the Loop page.' : BY_ID.get(mode)?.line || '';
  const hint = same ? `${line} Same as ${words.all}.` : `Only this ${words.one}. ${words.rest} on ${modeLabel(kindMode)}.`;
  return `
    <div class="vm-item" data-vm-item="${esc(key)}">
      <div class="vm-seg" role="radiogroup" aria-label="Rule for ${esc(label)}">
        ${MODES.map((m) => `<button type="button" class="is-${m.id}" role="radio" aria-checked="${m.id === mode}" data-vm-pick="${m.id}">${m.label}</button>`).join('')}
      </div>
      <p class="vm-hint">${esc(hint)}</p>
    </div>`;
}

/** Arrow keys move between the choices of a radio group; the one in use is the tab stop. */
export function wireRadioKeys(root) {
  root.querySelectorAll('[role="radiogroup"]').forEach((group) => {
    const options = () => [...group.querySelectorAll('[role="radio"]:not(:disabled)')];
    const list = options();
    const current = list.find((o) => o.getAttribute('aria-checked') === 'true') || list[0];
    list.forEach((o) => { o.tabIndex = o === current ? 0 : -1; });
    group.addEventListener('keydown', (e) => {
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      const all = options();
      const at = all.indexOf(document.activeElement);
      if (at < 0) return;
      e.preventDefault();
      const next = all[(at + step + all.length) % all.length];
      all.forEach((o) => { o.tabIndex = o === next ? 0 : -1; });
      next.focus();
    });
  });
}

/* ---------- saving ---------- */

/**
 * The Loop password, asked in place under `host`. `send(password)` runs on each try; a wrong
 * password stays in the form. Resolves what `send` returned, or null when it was closed.
 * With `submitLabel` the button is its own line, Esc does not close the form, and a phone does not
 * open its keyboard over the request.
 */
export function askPassword(host, { passwordName = 'Loop password', message, send, submitLabel = '' }) {
  host.querySelector('.vm-pass')?.remove();
  const form = document.createElement('form');
  form.className = 'vm-pass';
  form.setAttribute('autocomplete', 'off');
  const round = '<button type="submit" class="vf-go" aria-label="Confirm"><svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5l4 4 8-9"/></svg></button>';
  form.innerHTML = `
    ${message ? `<p class="vm-msg">${esc(message)}</p>` : ''}
    <span class="vf-f"><input name="password" type="password" required autocomplete="current-password" placeholder="${esc(passwordName)}" aria-label="${esc(passwordName)}" enterkeyhint="done">${submitLabel ? '' : round}</span>
    <p class="vm-err" role="alert" hidden></p>
    ${submitLabel ? `<button type="submit" class="btn fill vm-big">${esc(submitLabel)}</button>` : ''}`;
  host.append(form);
  const input = form.querySelector('input');
  const err = form.querySelector('.vm-err');
  const typing = !submitLabel || matchMedia('(hover: hover)').matches;
  input.autofocus = typing; // in a dialog that has not opened yet
  if (typing) input.focus();
  return new Promise((resolve, reject) => {
    const gone = new MutationObserver(() => {
      if (form.isConnected) return;
      gone.disconnect();
      resolve(null);
    });
    gone.observe(document.body, { childList: true, subtree: true });
    const finish = (value, failed) => {
      gone.disconnect();
      form.remove();
      if (failed) reject(failed);
      else resolve(value);
    };
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || submitLabel) return;
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      err.hidden = true;
      try {
        finish(await send(input.value));
      } catch (failed) {
        button.disabled = false;
        if (failed?.data?.code !== 'guard_password' && failed?.status !== 429) return finish(null, failed);
        err.textContent = failed.message;
        err.hidden = false;
        input.select();
      }
    });
  });
}

/**
 * Saves a rule. `send(password)` makes the request; when the change takes something off Guard,
 * Loop asks for the password under `host` (an element, or a function that finds it) and sends it
 * again. Resolves null when nothing changed.
 */
export async function saveRule(host, { send, what, passwordName, onNoPassword }) {
  try {
    return await send();
  } catch (err) {
    if (err?.data?.code === 'guard_no_password') {
      onNoPassword?.(err);
      return null;
    }
    if (err?.data?.code !== 'guard_password') throw err;
    return askPassword(typeof host === 'function' ? host() : host, { passwordName, send, message: `To take ${what} off Guard, enter your ${passwordName || 'Loop password'}.` });
  }
}
