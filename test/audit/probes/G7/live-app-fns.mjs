// Runs top-level functions of the live public/app.js, so dashboard checks follow the real code.
// (The audit used a frozen copy of these functions, which no fix could ever change.)
// app.js is a browser module, so it is not imported: the named function is cut out of the source and run in an
// empty context. Anything else it needs from app.js (another function, a top-level const) is pulled in on demand.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const PUBLIC = new URL('../../../../public/', import.meta.url);
const APP = readFileSync(new URL('app.js', PUBLIC), 'utf8');
// app.js first, then the modules of this folder that it imports: a function may move into one of them.
const SOURCES = [APP, ...[...APP.matchAll(/^import\s[^;]*?from\s+'\.\/([\w.-]+\.js)'/gm)].map((m) => readFileSync(new URL(m[1], PUBLIC), 'utf8'))];
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const REGEX_MAY_FOLLOW = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORD_BEFORE = /(?:^|[^\w$])(?:return|typeof|case|in|of|do|else|void|delete|throw|new|instanceof|yield|await)$/;

function skipQuoted(src, i) { // src[i] is ' or "; returns the index of the closing quote
  for (let j = i + 1; j < src.length; j += 1) {
    if (src[j] === '\\') j += 1;
    else if (src[j] === src[i]) return j;
    else if (src[j] === '\n') return -1;
  }
  return -1;
}

function skipTemplate(src, i) { // src[i] is a backtick; returns the index of the closing backtick
  for (let j = i + 1; j < src.length; j += 1) {
    if (src[j] === '\\') j += 1;
    else if (src[j] === '`') return j;
    else if (src[j] === '$' && src[j + 1] === '{') {
      j = scan(src, j + 1);
      if (j < 0) return -1;
    }
  }
  return -1;
}

function skipRegex(src, i) { // src[i] is /; returns the index of the closing slash or last flag, -1 if this is no regex
  let inClass = false;
  for (let j = i + 1; j < src.length; j += 1) {
    const ch = src[j];
    if (ch === '\n') return -1;
    if (ch === '\\') j += 1;
    else if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      while (/[a-z]/.test(src[j + 1] || '')) j += 1;
      return j;
    }
  }
  return -1;
}

// Walks JavaScript source, skipping strings, templates, comments and regex literals.
// Without stopAt: src[start] must be an opening bracket, and the index of its partner is returned.
// With stopAt: returns the index of the first stopAt character that is outside every bracket.
function scan(src, start, stopAt = null) {
  const closers = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  let prev = ''; // last significant character, to tell a regex from a division
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (ch === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) return -1; i += 1; continue; }
    if (ch === '"' || ch === "'") { i = skipQuoted(src, i); if (i < 0) return -1; prev = '"'; continue; }
    if (ch === '`') { i = skipTemplate(src, i); if (i < 0) return -1; prev = '`'; continue; }
    if (ch === '/' && (REGEX_MAY_FOLLOW.has(prev) || REGEX_KEYWORD_BEFORE.test(src.slice(Math.max(0, i - 12), i).trimEnd()))) {
      const end = skipRegex(src, i);
      if (end > 0) { i = end; prev = '/'; continue; }
    }
    if (stopAt && stack.length === 0 && ch === stopAt) return i;
    if (closers[ch]) stack.push(closers[ch]);
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return -1;
      if (!stopAt && stack.length === 0) return i;
    }
    if (!/\s/.test(ch)) prev = ch;
  }
  return -1;
}

function declarationIn(source, name) {
  const fn = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${name.replace(/\$/g, '\\$')}\\s*\\(`, 'm').exec(source);
  if (fn) {
    const paramsEnd = scan(source, fn.index + fn[0].length - 1);
    const bodyStart = paramsEnd < 0 ? -1 : source.indexOf('{', paramsEnd);
    const bodyEnd = bodyStart < 0 ? -1 : scan(source, bodyStart);
    return bodyEnd < 0 ? null : source.slice(fn.index, bodyEnd + 1).replace(/^export\s+/, '');
  }
  const variable = new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*=`, 'm').exec(source);
  if (!variable) return null;
  const end = scan(source, variable.index + variable[0].length, ';');
  // `var`, so the value lands on the context's global object like the functions do.
  return end < 0 ? null : source.slice(variable.index, end + 1).replace(/^(?:export\s+)?(?:const|let|var)/, 'var');
}

/** Source of a top-level function or const/let of the dashboard, or null when there is none by that name. */
function declarationSource(name) {
  if (!IDENTIFIER.test(name)) return null;
  for (const source of SOURCES) {
    const found = declarationIn(source, name);
    if (found) return found;
  }
  return null;
}

// An empty JavaScript context holding `globals`, into which top-level declarations of public/app.js are loaded by name.
function appContext(globals) {
  const context = vm.createContext({ ...globals });
  const defined = new Set();
  /** Loads one top-level declaration of app.js. False when app.js has none by that name (or it is loaded already). */
  const define = (name) => {
    if (defined.has(name)) return false;
    const source = declarationSource(name);
    if (!source) return false;
    vm.runInContext(source, context, { filename: `public/app.js#${name}` });
    defined.add(name);
    return true;
  };
  /** Runs an expression, loading whatever app.js declaration it turns out to need, until it runs through. */
  const run = async (expression) => {
    for (;;) {
      try {
        return await vm.runInContext(expression, context);
      } catch (err) {
        // Errors thrown inside the context come from its own realm, so match on the name, not instanceof.
        const missing = err?.name === 'ReferenceError' ? /^([\w$]+) is not defined$/.exec(err.message)?.[1] : null;
        if (!missing || !define(missing)) throw err;
      }
    }
  };
  const need = (name) => {
    if (!define(name)) throw new Error(`public/app.js has no top-level ${name} any more; update this check to follow the new code`);
  };
  return { define, need, run };
}

/** Calls one top-level function of public/app.js with plain arguments. */
export async function callAppFunction(name, ...args) {
  const app = appContext({ __args: args });
  app.need(name);
  return app.run(`${name}(...__args)`);
}

/** The HTML that renderApprovalBanner() in public/app.js puts on screen for these pending approvals. */
export async function renderApprovalBannerHtml(pendingApprovals) {
  const banner = { innerHTML: '', querySelectorAll: () => [] };
  const app = appContext({
    document: { getElementById: (id) => (id === 'banner' ? banner : null), querySelectorAll: () => [] },
    auth: { mode: 'clerk', setUp: true, signedIn: true },
    pendingApprovals,
    inFlightApprovals: new Set(),
    handleApprovalDecision() {},
  });
  app.need('renderApprovalBanner');
  await app.run('renderApprovalBanner()');
  return banner.innerHTML;
}

/**
 * The HTML that renderOAuthConsentScreen() in public/app.js shows for one answer of GET /api/oauth/requests/<id>.
 * That function catches its own errors and shows them on screen, so a helper it needs but does not have yet shows up
 * as "<name> is not defined" in the page: load that helper and draw again.
 */
export async function renderOAuthConsentHtml(consentResponse) {
  const view = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  const app = appContext({
    document: { getElementById: (id) => (id === 'main' ? view : null), querySelector: () => null, querySelectorAll: () => [], title: '' },
    location: { assign() {}, replace() {}, href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' },
    hideDashboardNavigation() {},
    resetView: () => view,
    toast() {},
    api: async () => consentResponse,
    oauthTxId: 'probe-request',
  });
  app.need('renderOAuthConsentScreen');
  app.need('esc');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    view.innerHTML = '';
    await app.run('renderOAuthConsentScreen()');
    const missing = /([A-Za-z_$][\w$]*) is not defined/.exec(visibleText(view.innerHTML))?.[1];
    if (!missing || !app.define(missing)) break;
  }
  return view.innerHTML;
}

/**
 * What a person reads in a piece of dashboard HTML without clicking anything: tags dropped, entities decoded.
 * The body of a closed <details> does not count (its <summary> does). Anything hidden by CSS is beyond this check.
 */
export function visibleText(html) {
  return String(html)
    .replace(/<details\b(?![^>]*\bopen\b)[^>]*>([\s\S]*?)<\/details>/gi, (_, body) => /<summary\b[^>]*>[\s\S]*?<\/summary>/i.exec(body)?.[0] ?? '')
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&hellip;/g, '…').replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
