import { organizeApprovalCard, renderOrganizeApproval } from './organize-approval.js';
// Loop MCP Gateway — dashboard (Home, Library, Vault, Settings; connections and agents open as popups).

import { homeMatchScore, rankedHomeMatches, resetHomeSearch, findCapabilityPrompt } from './home-search.js';
import { renderSkillMarkdown } from './skill-markdown.js';
import { homeSystemGuides, isSystemSkill, mountContextGuide, renderSystemSection, systemTitle } from './system-skills.js';
import { mountScrubber } from './home-scrubber.js';
import './inline-expand.js'; // pop-ups and dialogs open inline under their row
import { agentRows, agentMark, mountSmsAgentCard, renderImportFromAgents } from './agents-view.js';
import { openAgentPopup, openConnectFlow, closeAgentPopup, agentStatus, refreshOpenAgentActivity } from './agent-popup.js';
import { openAddAgent } from './add-agent.js';
import { openConnectionPopup, openAddConnectionPopup, closeConnectionPopup, refreshOpenConnectionStatus, postSignInSummary } from './connection-popup.js';
import { destroyMemoryView, renderMemory } from './memory-view.js';
import { renderSaved, refreshSavedLive } from './saved-view.js';
import { BRAIN_NAME, BRAIN_PARTS, brainCounts, brainHash, brainPartOf, brainRow, wireBrainRows } from './brain-parts.js';
import { openShareSheet } from './share.js';
import { mountPeople, resetPeople } from './people.js';
import { INSTALL_KINDS } from './agent-mark.js';
import { mountOAuthConsentPicker, renderOAuthHandoffFallback } from './oauth-consent-view.js';
import { SIGN_IN_PATH, signUpPage, clerkAuthPage, oauthTxId, deviceCodeParam, getAuthStatus, loadClerkApp, mountClerkAuth, withAuthTimeout } from './clerk-app.js';
import { initCommandPalette } from './components/command-palette.js';
import { confirmDialog, promptDialog } from './components/confirm-dialog.js';
import { renderJsonRenderDom } from './json-render-dom.js';
import { askPassword, isMode, kindName, modeChoices, modeGlyph, modeHead, modeLabel, modeSegment, saveRule, stricterMode, toolRows, wireRadioKeys } from './approval-modes.js';
import { destroySetupView, renderChat, renderServicePage, renderSetup } from './v3-hybrid-views.js';
import { destroyLoopChatView, refreshLoopChatMap, renderLoopChat } from './loop-chat-view.js';

const PAGES = {
  loop: 'Loop',
  home: 'Home',
  setup: 'Setup',
  service: 'Services',
  chat: 'Chat',
  agents: 'Agents', // no page of its own: opens an agent popup over Home
  vault: 'Vault',
  library: 'Home', // the Library is Home now; old links land there
  connections: 'Connections', // no page of its own: opens a connection popup over Home
  skills: 'Skills', // a skill's details, reached from Home
  brain: BRAIN_NAME,
  knowledge: BRAIN_NAME, // two views: memory (Memories) and saved (Saved, Files, Schedules)
  memory: BRAIN_NAME,
  saved: BRAIN_NAME,
  save: BRAIN_NAME,
  settings: 'Settings',
};
// The pages whose name takes the place of the Loop logo in the top bar.
const TITLED_PAGES = new Set([BRAIN_NAME, 'Vault', 'Settings']);
// The bottom bar's tab for each page: skill details belong to Home.
const NAV_OF = { setup: 'home', service: 'home', chat: 'home' };
const navOf = (section) => (brainPartOf(section) ? 'brain' : NAV_OF[section] || section);

let specialistCaps = { loaded: false, enabled: false, hosted: false, runners: [], defaultRunner: '', mausbot: null };
let specialistCapsPromise = null;

function applySpecialistCapabilities(next) {
  if (!next || typeof next !== 'object') return;
  specialistCaps = {
    loaded: true,
    enabled: Boolean(next.enabled),
    hosted: Boolean(next.hosted),
    runners: Array.isArray(next.runners) ? next.runners : [],
    defaultRunner: next.defaultRunner || '',
    mausbot: next.mausbot || null,
  };
  syncSpecialistNav();
}

function syncSpecialistNav() {
  // The nav has no Loop chat button. The top logo opens Loop chat when it is on.
  const topLogo = document.getElementById('top-logo-link');
  if (topLogo) topLogo.href = specialistCaps.enabled ? '#loop' : '#home';
}

async function ensureSpecialistCaps({ force = false } = {}) {
  if (!auth.signedIn) return specialistCaps;
  if (specialistCaps.loaded && !force) return specialistCaps;
  if (specialistCapsPromise && !force) return specialistCapsPromise;
  specialistCapsPromise = api('/api/loop-agent/capabilities')
    .then((res) => {
      applySpecialistCapabilities(res);
      return specialistCaps;
    })
    .catch(() => {
      specialistCaps.loaded = true;
      specialistCaps.enabled = false;
      syncSpecialistNav();
      return specialistCaps;
    })
    .finally(() => {
      specialistCapsPromise = null;
    });
  return specialistCapsPromise;
}

const DEFAULT_POLICIES = {
  default: 'auto',
  vaultTypes: {
    payment: 'always_ask',
    login: 'always_ask',
    api_key: 'auto',
    note: 'auto',
  },
  categories: {},
  connections: {},
  tools: {},
  // By what a tool says about itself; mirrors lib/policies.mjs.
  toolKinds: {
    write: 'auto',
    destructive: 'auto',
    unmarked: 'auto',
  },
  actions: {
    cleanup: 'always_ask',
    organize: 'always_ask',
    delete: 'always_ask',
    add_local: 'always_ask',
    repoint: 'always_ask',
  },
};

// What a tool says about itself, from its annotations; mirrors toolKindOf in lib/policies.mjs.
function toolKindOf(annotations) {
  const a = annotations && typeof annotations === 'object' && !Array.isArray(annotations) ? annotations : null;
  if (a?.readOnlyHint === true) return 'read';
  if (a?.destructiveHint === true) return 'destructive';
  if (a?.destructiveHint === false) return 'write';
  return 'unmarked';
}

const VAULT_TYPE_META = {
  api_key: { label: 'API Key', option: 'API Key', desc: 'Tokens and developer API keys' },
  login: { label: 'Login', option: 'Login / Password', desc: 'Account passwords and sign-in credentials' },
  payment: { label: 'Payment', option: 'Payment / Card', desc: 'Cards, billing, and checkout credentials' },
  note: { label: 'Note', option: 'Note', desc: 'Private notes and misc values' },
};

const uiState = {
  activeProfile: 'all',
  vaultModeOpen: '',
  profileMenu: false,
  profileQuery: '',
  skillSearch: '',
  skillCategory: 'all',
  expandedSkills: new Set(),
  skillCache: new Map(), // skillId -> { loading, error, data }
  homeSearch: '',
  homeOpenGroups: null, // Set of open category ids on Home; null until loaded
  homeJump: null,
  homeCat: '', // wide Home: the one category the pills show ('' = all)
  homeCatMore: false,
  homeKinds: {}, // Home: each category's own filter, category id -> 'all' | 'conn' | 'skill'
  homeSkillsAll: new Set(), // categories showing every skill, not just the first few
  homeAdd: '', // phone Home: '' closed, 'list' the choices, 'category' the new-category form
  homeAddName: '',
  homeAddConn: '',
  homeAdded: null, // what an agent added while the Add panel was open: { kind, id, name, agent }
  homeFamOpen: new Set(), // `${categoryId}:fam:${prefix}` skill families opened on Home
  memorySearch: '',
  memoryScope: 'all',
  memoryPanel: null, // null | 'add' | 'import' | 'setup'
  memoryView: null, // null -> load saved localStorage preference ('graph' | 'list')
  memoryGroupBy: 'scope', // 'scope' | 'source'
  memorySelectedId: null,
  vaultSearch: '',
};

let latestProfileRecords = [];
let profileRecordsLoaded = false;
// Home's categories, for the top-left switcher on narrow windows (wide Home has its row of pills).
// Projects stay on the server (agents and items keep their project), but the dashboard does not show them.
const PROJECTS_IN_UI = false;
let latestHomeCats = [];
let homeCatPick = null; // set by Home: shows one category ('' = all)
let homeCatShown = ''; // the category that the switcher button names

function switcherCats() {
  if (shownSection !== 'home' || SIDE_MQ?.matches || !latestHomeCats.length || !homeCatPick) return [];
  return [{ id: '', label: 'All' }, ...latestHomeCats];
}

let renderSeq = 0;
let approvalsSeq = 0;
let pendingApprovals = [];
const inFlightApprovals = new Set();
// Home lists pending approvals in its Needs you group; while it is on screen it registers a repaint
// here and the banner above the page stays empty so a request is not shown twice.
let approvalsOnHome = null;
const phoneHome = window.matchMedia?.('(max-width: 640px)') || { matches: false };
phoneHome.addEventListener?.('change', () => approvalsOnHome?.());
// The scrubber takes the place of the side menu wherever the window is too narrow to show it, and on
// Home on wide windows too, where category pills take the side menu's place.
const noRail = window.matchMedia?.('(max-width: 979px)') || { matches: false };
// Home has the side menu on wide windows like every tab, so the scrubber is only for narrow windows.
const scrubOn = {
  get matches() { return noRail.matches; },
  addEventListener: (type, fn) => noRail.addEventListener?.(type, fn),
};
if (document.getElementById('main')) mountScrubber(document.getElementById('main'), scrubOn);

const auth = { mode: null, setUp: true, signedIn: false };
let clerk = null;
let activeClerkSession = null;
let authCheck = null;
let authFailed = false;
let leavingDashboard = false;
const canImportFromMac = () => auth.mode !== 'clerk' ||
  (auth.workspace === 'local' && auth.canImportLocal === true);
const canRestoreMac = () => auth.mode === 'clerk' && auth.workspace === 'personal' && auth.localAvailable === true;
let dashboardEvents = null;
let dashboardEventsReconnectTimer = null;
let dashboardEventsBackoffIdx = 0;
let dashboardEventsBootId = null;
const SSE_RECONNECT_BACKOFF_MS = [2000, 5000, 15000];
let connectionsRefreshWaiting = false; // a Connections update is held until the form in use is done
let connectionsRefreshTimer = null;
let agentsRefreshWaiting = false; // an Agents update is held until the form/row/dialog in use is done
let agentsRefreshTimer = null;
let memoryRefreshWaiting = false; // a Memory update is held until editing/panels close
let memoryRefreshTimer = null;
let oauthFinishing = false;

const PENDING_OAUTH_KEY = 'loop_pending_oauth';
const POST_LOGIN_HASH_KEY = 'loop_post_login_hash';
const PENDING_OAUTH_TTL_MS = 15 * 60 * 1000;
let pendingOAuthMemory = null;
let pendingApprovalsFocus = false;
let pendingApprovalFocusId = '';
let activeApprovalDialog = null;

// Explicit allowlist for OAuth callback errors (G7-11). Never echo attacker-controlled URL text.
const OAUTH_ERROR_DEFAULT = 'Sign-in could not be completed. Try again.';
const OAUTH_ERROR_MESSAGES = Object.freeze({
  expired: 'This sign-in session expired. Start sign-in again.',
  denied: 'Sign-in was canceled or denied by the provider.',
  access_denied: 'Sign-in was canceled or denied by the provider.',
  invalid_request: 'The sign-in request was invalid. Try again.',
  issuer_mismatch: 'The provider identity did not match. Sign-in was blocked for your safety.',
  state_mismatch: 'The sign-in state did not match or expired. Start sign-in again.',
  invalid_state: 'The sign-in state did not match or expired. Start sign-in again.',
  token_exchange_failed: 'Could not complete token exchange with the provider. Try again.',
  callback_failed: 'The sign-in callback could not be verified. Try again.',
  not_found: 'The connection for this sign-in could not be found.',
  unauthorized: 'You are not authorized to complete this sign-in.',
  unauthorized_client: 'This client is not authorized by the provider.',
  server_error: 'The sign-in provider reported an error. Try again later.',
  temporarily_unavailable: 'The sign-in provider is temporarily unavailable. Try again later.',
  invalid_scope: 'The requested permissions were rejected by the provider.',
  invalid_client: 'Provider client registration was rejected. Try signing in again.',
  invalid_grant: 'The sign-in code was rejected or already used. Start sign-in again.',
  unsupported_response_type: 'The sign-in provider does not support this sign-in method.',
  discovery_failed: 'Sign-in finished, but tool discovery failed. Retry discovery in Loop.',
  oauth_failed: 'Sign-in could not be completed. Try again.',
});

function formatOAuthError(rawCode) {
  if (typeof rawCode !== 'string') return OAUTH_ERROR_DEFAULT;
  const code = rawCode.trim().toLowerCase();
  if (!code || !/^[a-z0-9_-]{1,64}$/.test(code)) return OAUTH_ERROR_DEFAULT;
  return Object.hasOwn(OAUTH_ERROR_MESSAGES, code) ? OAUTH_ERROR_MESSAGES[code] : OAUTH_ERROR_DEFAULT;
}

function classifyOAuthFinishError(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (!msg) return 'oauth_failed';
  if (msg.includes('issuer')) return 'issuer_mismatch';
  if (msg.includes('expired')) return 'expired';
  if (msg.includes('state')) return 'state_mismatch';
  if (msg.includes('not found')) return 'not_found';
  if (msg.includes('unauthorized') || msg.includes('forbidden')) return 'unauthorized';
  if (msg.includes('token')) return 'token_exchange_failed';
  if (msg.includes('denied') || msg.includes('cancel')) return 'access_denied';
  if (msg.includes('callback')) return 'callback_failed';
  return 'oauth_failed';
}

function readSessionJson(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeSessionValue(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    // sessionStorage may be unavailable in restricted contexts
  }
}

// Pulls OAuth callback parameters out of the fragment immediately at boot (before Clerk loads)
// so the one-time code never lingers in the address bar or history and survives a full sign-in.
function captureOAuthFromHash() {
  const rawHash = location.hash.replace(/^#\/?/, '');
  const qIndex = rawHash.indexOf('?');
  if (qIndex < 0) return;
  const section = rawHash.slice(0, qIndex).split('/')[0].toLowerCase();
  if (section !== 'connections') return;
  const hashParams = new URLSearchParams(rawHash.slice(qIndex + 1));
  const code = hashParams.get('oauth_code');
  const state = hashParams.get('oauth_state');
  const iss = hashParams.get('oauth_iss') ?? hashParams.get('iss');
  const error = hashParams.get('oauth_error');
  if (code && state) {
    pendingOAuthMemory = { code, state, ...(iss ? { iss } : {}), at: Date.now() };
    writeSessionValue(PENDING_OAUTH_KEY, pendingOAuthMemory);
    history.replaceState(null, '', '#connections');
  } else if (error) {
    const codeKey = String(error).trim().toLowerCase();
    const safeCode = /^[a-z0-9_-]{1,64}$/.test(codeKey) && Object.hasOwn(OAUTH_ERROR_MESSAGES, codeKey)
      ? codeKey
      : 'oauth_failed';
    pendingOAuthMemory = { error: safeCode, at: Date.now() };
    writeSessionValue(PENDING_OAUTH_KEY, pendingOAuthMemory);
    history.replaceState(null, '', '#connections');
  }
}

function takePendingOAuth() {
  const stored = readSessionJson(PENDING_OAUTH_KEY);
  writeSessionValue(PENDING_OAUTH_KEY, null);
  const candidate = stored || pendingOAuthMemory;
  pendingOAuthMemory = null;
  if (!candidate || typeof candidate !== 'object') return null;
  if (!Number.isFinite(candidate.at) || Date.now() - candidate.at > PENDING_OAUTH_TTL_MS) return null;
  return candidate;
}

// The page of an invite (people-join.js) keeps its address here while the person signs in, to a service or to
// this Loop. Only that page can be the target.
const INVITE_RETURN_KEY = 'loop_invite_return';
function takeInviteReturn(why) {
  const back = readSessionJson(INVITE_RETURN_KEY);
  if (!back || back.why !== why) return null;
  writeSessionValue(INVITE_RETURN_KEY, null);
  const fresh = Number.isFinite(back.at) && Date.now() - back.at <= PENDING_OAUTH_TTL_MS;
  const safe = typeof back.to === 'string' && /^\/p\/(?:[a-z0-9]{14}|#s1\.[A-Za-z0-9_-]{1,6000})$/.test(back.to);
  return fresh && safe ? back : null;
}

// A sign-in that started on the page of an invite ends there, with its result.
function returnToInvite(connectedId, error) {
  const back = error || connectedId ? takeInviteReturn('signin') : null;
  if (!back || (!error && back.connId !== connectedId)) return false;
  if (error) writeSessionValue('loop_invite_error', formatOAuthError(error));
  location.replace(back.to);
  return true;
}

function isSafeRouteHash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith('#') || hash.length > 2048) return false;
  const seg = hash.replace(/^#\/?/, '').split(/[/?]/)[0].toLowerCase();
  return seg === 'approvals' || Object.hasOwn(PAGES, seg);
}

function savePostLoginHash() {
  if (isSafeRouteHash(location.hash)) {
    writeSessionValue(POST_LOGIN_HASH_KEY, location.hash);
  }
}

function restorePostLoginHash() {
  let saved = null;
  try {
    saved = sessionStorage.getItem(POST_LOGIN_HASH_KEY);
    sessionStorage.removeItem(POST_LOGIN_HASH_KEY);
  } catch {
    saved = null;
  }
  if (!location.hash && isSafeRouteHash(saved)) {
    history.replaceState(null, '', saved);
  }
}

const SIGN_OUT_STORAGE_KEY = 'loop.auth.signout';

function notifyOtherTabsSignOut() {
  try {
    localStorage.setItem(SIGN_OUT_STORAGE_KEY, String(Date.now()));
  } catch {
    // Ignore storage errors in private browsing or restricted iframes.
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key !== SIGN_OUT_STORAGE_KEY || !e.newValue || !auth.signedIn) return;
    clearPendingAuthStorage();
    closeSettings({ immediate: true });
    clearApprovalBanner();
    auth.signedIn = false;
    authCheck = null;
    if (auth.mode === 'clerk') {
      leavingDashboard = true;
      lockDashboard(false);
      location.replace(SIGN_IN_PATH);
      return;
    }
    render();
  });
}

function clearPendingAuthStorage() {
  pendingOAuthMemory = null;
  writeSessionValue(PENDING_OAUTH_KEY, null);
  writeSessionValue(POST_LOGIN_HASH_KEY, null);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function clearToast() {
  clearTimeout(toast._timer);
  const el = document.getElementById('toast');
  if (el) el.classList.remove('show');
}

function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = String(msg || '');
  el.className = 'toast show' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : '');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    el.classList.remove('show');
  }, 2800);
}

async function copyText(text, successMsg = 'Copied to clipboard.') {
  const str = String(text ?? '');
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(str);
    } else {
      const ta = document.createElement('textarea');
      ta.value = str;
      ta.className = 'offscreen';
      document.body.appendChild(ta);
      ta.select();
      try {
        if (!document.execCommand('copy')) throw new Error('Copy failed');
      } finally {
        ta.remove();
      }
    }
    toast(successMsg, 'ok');
  } catch {
    toast('Could not copy to clipboard.', 'err');
  }
}

// Data for a page starts loading when a link to it is hovered, focused or pressed, so the
// page is usually ready by the time the click lands. Each early response is used at most once,
// only within PREFETCH_MS, and any change made through the API discards them all.
const PREFETCH_MS = 10000;
const PAGE_DATA = {
  home: ['/api/overview'],
  agents: ['/api/agents', '/api/activity?limit=50'],
  vault: ['/api/vault', '/api/policies'],
  connections: ['/api/mcps'],
  skills: ['/api/skills'],
  settings: ['/api/settings'],
};
const prefetched = new Map(); // url -> { at, promise }

function prefetchPage(link) {
  if (!auth.signedIn || auth.mode === 'clerk') return;
  const page = (link.getAttribute('href') || '').replace(/^#\/?/, '').split(/[/?]/)[0].toLowerCase();
  if (!Object.hasOwn(PAGE_DATA, page) || page === shownSection) return;
  for (const url of PAGE_DATA[page]) {
    const early = prefetched.get(url);
    if (early && Date.now() - early.at < PREFETCH_MS) continue;
    const promise = requestJson(url);
    promise.catch(() => {}); // an unused early request that fails is not an error
    prefetched.set(url, { at: Date.now(), promise });
  }
}

for (const type of ['pointerover', 'pointerdown', 'focusin']) {
  document.addEventListener(type, (e) => {
    const link = e.target instanceof Element ? e.target.closest('a[href^="#"]') : null;
    if (link) prefetchPage(link);
  }, { passive: true });
}

async function api(url, opts = {}) {
  if ((opts.method || 'GET').toUpperCase() !== 'GET') {
    prefetched.clear();
    // A sign-in that starts here ends here.
    if (url.endsWith('/oauth/start')) writeSessionValue(INVITE_RETURN_KEY, null);
  } else {
    const early = prefetched.get(url);
    prefetched.delete(url);
    if (early && Date.now() - early.at < PREFETCH_MS) return early.promise;
  }
  return requestJson(url, opts);
}

async function requestJson(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const appMode = auth.mode === 'clerk';
  const sessionId = activeClerkSession;
  if (appMode) {
    const target = new URL(url, location.origin);
    if (target.origin !== location.origin || !target.pathname.startsWith('/api/')) throw new Error('Invalid Loop API URL');
    if (!auth.signedIn || !sessionId || clerk?.session?.id !== sessionId) throw new Error('Sign-in required');
    try {
      headers.Authorization = `Bearer ${await clerkSessionToken(sessionId)}`;
    } catch {
      if (auth.signedIn && sessionId === activeClerkSession) lockDashboard();
      throw new Error('Could not verify sign-in');
    }
  }
  const res = await fetch(url, { ...opts, ...(appMode ? { credentials: 'same-origin', cache: 'no-store', redirect: 'error' } : {}), headers });
  const data = await res.json().catch(() => ({}));
  if (appMode && (!auth.signedIn || sessionId !== activeClerkSession || sessionId !== clerk.session?.id)) {
    throw new Error('The active session has changed');
  }
  if (res.status === 401 && data.auth === 'required') {
    if (appMode) lockDashboard();
    else {
      auth.signedIn = false;
      authCheck = null;
      clearApprovalBanner();
      setTimeout(render, 0);
    }
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (HTTP ${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function streamFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const appMode = auth.mode === 'clerk';
  const sessionId = activeClerkSession;
  if (appMode) {
    const target = new URL(url, location.origin);
    if (target.origin !== location.origin || !target.pathname.startsWith('/api/')) throw new Error('Invalid Loop API URL');
    if (!auth.signedIn || !sessionId || clerk?.session?.id !== sessionId) throw new Error('Sign-in required');
    headers.Authorization = `Bearer ${await clerkSessionToken(sessionId)}`;
  }
  return fetch(url, {
    ...opts,
    credentials: 'same-origin',
    cache: 'no-store',
    headers,
  });
}

// Upstream sign-in pages may only be opened over https, or over http on this computer.
function safeSignInAuthorizeUrl(raw) {
  let target;
  try {
    target = new URL(String(raw || ''));
  } catch {
    throw new Error('Invalid sign-in address.');
  }
  const host = target.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (target.protocol === 'https:' || (target.protocol === 'http:' && loopback)) return target;
  throw new Error('The sign-in page is not a secure (https) address.');
}

async function startInstantSignIn(connId, { triggerBtn = null, onFallback = null } = {}) {
  const prevText = triggerBtn ? triggerBtn.textContent : '';
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = 'Signing in…';
  }
  try {
    const res = await api(`/api/mcps/${encodeURIComponent(connId)}/oauth/start`, { method: 'POST' });
    const target = safeSignInAuthorizeUrl(res?.authorizeUrl);
    location.href = target.href;
    return true;
  } catch (err) {
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.textContent = prevText || 'Sign in';
    }
    if (err?.status === 503) {
      toast(err.message || 'Could not reach server to start sign-in.', 'err');
      return false;
    }
    if (typeof onFallback === 'function') {
      onFallback(err);
      return false;
    }
    toast(err.message || 'Could not start sign-in.', 'err');
    return false;
  }
}

function normalizeVaultType(raw) {
  const clean = String(raw || '').trim().toLowerCase();
  return Object.hasOwn(VAULT_TYPE_META, clean) ? clean : 'api_key';
}

// The Vault group an item shows under: its category, or its type when it has none.
// A category named like a built-in group ("API keys") joins that group.
function vaultGroupOf(item, groups) {
  const category = String(item?.category || '').trim();
  if (!category) return normalizeVaultType(item?.type);
  const builtIn = groups.find(([, title]) => title.toLowerCase() === category.toLowerCase());
  return builtIn ? builtIn[0] : `cat-${category.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other'}`;
}

function normalizeApprovalMode(raw, fallback = 'inherit') {
  const clean = String(raw || '').trim().toLowerCase();
  if (clean === 'inherit' || isMode(clean)) return clean;
  return fallback;
}

function normalizeDecisionMode(raw, fallback = 'auto') {
  const clean = String(raw || '').trim().toLowerCase();
  if (isMode(clean)) return clean;
  return fallback;
}

// What a Vault row is called: a card by its description, the rest by the key.
const vaultItemName = (s) => (normalizeVaultType(s.type) === 'payment' && s.description ? s.description : s.key);
// What the owner's password is called here, and where to set one up.
const passwordName = () => (auth.mode === 'clerk' ? 'Vault password' : 'Loop password');
const noGuardPassword = () => {
  toast(`Guard needs a ${passwordName()}. Set one up here first.`, 'err');
  openSettings('vault');
};

function normalizePolicies(raw) {
  const src = raw?.policies && typeof raw.policies === 'object' ? raw.policies : (raw && typeof raw === 'object' ? raw : {});
  return {
    default: normalizeDecisionMode(src.default, DEFAULT_POLICIES.default),
    vaultTypes: {
      ...DEFAULT_POLICIES.vaultTypes,
      ...(src.vaultTypes && typeof src.vaultTypes === 'object' ? src.vaultTypes : {}),
    },
    categories: { ...(src.categories && typeof src.categories === 'object' ? src.categories : {}) },
    connections: { ...(src.connections && typeof src.connections === 'object' ? src.connections : {}) },
    tools: { ...(src.tools && typeof src.tools === 'object' ? src.tools : {}) },
    // null when the running Loop does not have tool-kind rules yet (it has not been restarted
    // since the update); the dashboard then leaves them out instead of showing rules that
    // would not be enforced.
    toolKinds: src.toolKinds && typeof src.toolKinds === 'object'
      ? { ...DEFAULT_POLICIES.toolKinds, ...src.toolKinds }
      : null,
    actions: {
      ...DEFAULT_POLICIES.actions,
      ...(src.actions && typeof src.actions === 'object' ? src.actions : {}),
    },
  };
}

function effectiveSecretApproval(secret, policies) {
  const mode = normalizeApprovalMode(secret?.approval, 'inherit');
  return mode !== 'inherit' ? mode : vaultKindMode(normalizeVaultType(secret?.type), policies);
}

// The rule of a whole Vault kind (Cards, Logins …).
function vaultKindMode(kind, policies) {
  return normalizeDecisionMode(policies?.vaultTypes?.[kind], DEFAULT_POLICIES.vaultTypes[kind] || 'auto');
}

function effectiveConnectionApproval(conn, policies) {
  const connId = typeof conn === 'string' ? conn : conn?.id;
  const explicit = normalizeApprovalMode(conn?.approval ?? policies?.connections?.[connId], 'inherit');
  if (explicit !== 'inherit') return explicit;
  const cat = typeof conn === 'object' ? conn?.category : null;
  if (cat) {
    const catMode = normalizeApprovalMode(policies?.categories?.[cat], 'inherit');
    if (catMode !== 'inherit') return catMode;
  }
  if (isMode(conn?.effectiveApproval)) return conn.effectiveApproval;
  return normalizeDecisionMode(policies?.default, DEFAULT_POLICIES.default);
}

function effectiveToolApproval(conn, toolName, policies) {
  const connId = typeof conn === 'string' ? conn : conn?.id;
  const tName = typeof toolName === 'object' ? toolName?.name : toolName;
  const key = connId && tName ? `${connId}__${tName}` : String(tName || '');
  const toolMap = policies?.tools && typeof policies.tools === 'object'
    ? policies.tools
    : (policies && typeof policies === 'object' && !policies.connections && !policies.default ? policies : {});
  const override = normalizeApprovalMode(toolMap?.[key], 'inherit');
  if (override !== 'inherit') return override;
  // What the tool says about itself asks first, unless the connection or its category has a
  // rule of its own. Only known when the caller passes the tool itself, not just its name.
  if (policies?.toolKinds && toolName && typeof toolName === 'object') {
    const connMode = normalizeApprovalMode(conn?.approval ?? policies?.connections?.[connId], 'inherit');
    const cat = conn && typeof conn === 'object' ? conn.category : null;
    const catMode = cat ? normalizeApprovalMode(policies?.categories?.[cat], 'inherit') : 'inherit';
    if (connMode === 'inherit' && catMode === 'inherit') {
      const kindMode = normalizeDecisionMode(policies.toolKinds[toolKindOf(toolName.annotations)]);
      return stricterMode(kindMode, effectiveConnectionApproval(conn, policies));
    }
  }
  return effectiveConnectionApproval(conn, policies);
}

function defaultPinnedTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map((t) => (typeof t === 'string' ? t : t?.name))
    .filter((name) => typeof name === 'string' && /(^|_)(catalog_search|search_catalog)$/i.test(name))
    .slice(0, 2);
}

function effectivePinnedTools(conn) {
  const saved = Array.isArray(conn?.pinnedTools) ? conn.pinnedTools : [];
  if (conn?.pinsCustomized === true || saved.length > 0) return saved;
  return defaultPinnedTools(Array.isArray(conn?.tools) ? conn.tools : conn?.toolNames);
}

/* ===========================
   LIVE APPROVAL BANNER (#banner)
   =========================== */
function clearApprovalBanner() {
  pendingApprovals = [];
  inFlightApprovals.clear();
  const banner = document.getElementById('banner');
  if (banner) banner.innerHTML = '';
}

function formatApprovalValue(val, depth = 0) {
  if (val === null) return 'null';
  if (val === undefined) return '';
  if (typeof val === 'string') {
    if (val.length <= 240) return val;
    const head = `${val.slice(0, 200)}…`;
    const tailRefs = val.slice(200).match(/\{\{vault:[^}]+\}\}/g);
    return tailRefs ? `${head} [${tailRefs.join(', ')}]` : head;
  }
  if (typeof val === 'number' || typeof val === 'boolean') {
    return String(val);
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    return val.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.key === 'string') {
        const meta = item.type ? ` (${formatApprovalValue(item.type, depth + 1)})` : '';
        return `${item.key}${meta}`;
      }
      return formatApprovalValue(item, depth + 1);
    }).join(', ');
  }
  if (typeof val === 'object') {
    const entries = Object.entries(val).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    if (depth > 4) {
      try { return JSON.stringify(val); } catch { return String(val); }
    }
    return `{ ${entries.map(([k, v]) => `${k}: ${formatApprovalValue(v, depth + 1)}`).join(', ')} }`;
  }
  return String(val);
}

function formatSinkObject(sink) {
  if (!sink) return '';
  if (typeof sink === 'string') return sink.trim();
  if (typeof sink !== 'object' || Array.isArray(sink)) return String(sink);
  if (typeof sink.origin === 'string' && sink.origin.trim()) {
    return sink.origin.trim();
  }
  if (typeof sink.url === 'string' && sink.url.trim()) {
    return sink.url.trim();
  }
  if (typeof sink.command === 'string' && sink.command.trim()) {
    const args = Array.isArray(sink.args) ? sink.args.map(String).filter((s) => s.length > 0) : [];
    const cmdLine = [sink.command.trim(), ...args].join(' ');
    const cwd = typeof sink.cwd === 'string' && sink.cwd.trim() ? sink.cwd.trim() : '';
    return cwd ? `${cmdLine} (cwd: ${cwd})` : cmdLine;
  }
  return '';
}

function extractApprovalDestination(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return '';
  if (typeof detail.destination === 'string' && detail.destination.trim()) {
    return detail.destination.trim();
  }
  if (detail.destination && typeof detail.destination === 'object') {
    const formatted = formatSinkObject(detail.destination);
    if (formatted) return formatted;
  }
  if (detail.sink) {
    const formatted = formatSinkObject(detail.sink);
    if (formatted) return formatted;
  }
  return '';
}

function formatApprovalDetail(detail) {
  if (detail === null || detail === undefined) return '';
  if (typeof detail === 'string') {
    const trimmed = detail.trim();
    return trimmed.length > 480 ? `${trimmed.slice(0, 400)}…` : trimmed;
  }
  if (Array.isArray(detail)) {
    return detail.length === 0 ? '' : formatApprovalValue(detail);
  }
  if (typeof detail === 'object') {
    const entries = Object.entries(detail).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '';
    const destination = extractApprovalDestination(detail);
    const lines = [];
    if (destination) {
      lines.push(`destination: ${destination}`);
    }
    for (const [key, val] of entries) {
      if (destination && (key === 'destination' || (key === 'sink' && formatSinkObject(val) === destination))) {
        continue;
      }
      if (key === 'rule') continue; // Loop's own rule id; the reason line says it in words
      if (key === 'arguments' && val && typeof val === 'object' && !Array.isArray(val)) {
        const argEntries = Object.entries(val).filter(([, av]) => av !== undefined);
        if (argEntries.length === 0) {
          lines.push('arguments: {}');
        } else {
          for (const [argKey, argVal] of argEntries) {
            lines.push(`arguments.${argKey}: ${formatApprovalValue(argVal)}`);
          }
        }
      } else {
        lines.push(`${key}: ${formatApprovalValue(val)}`);
      }
    }
    return lines.join('\n');
  }
  return String(detail);
}

function renderApprovalDetail(detail) {
  if (detail === null || detail === undefined) return '';
  if (typeof detail === 'string' || Array.isArray(detail) || typeof detail !== 'object') {
    const text = formatApprovalDetail(detail);
    return text ? `<div class="approval-detail mono">${esc(text)}</div>` : '';
  }

  const entries = Object.entries(detail).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '';

  const destination = extractApprovalDestination(detail);
  const topRows = [];
  let argRows = [];
  let secretsVal = null;

  for (const [key, val] of entries) {
    if (destination && (key === 'destination' || (key === 'sink' && formatSinkObject(val) === destination))) {
      continue;
    }
    if (key === 'rule') continue; // Loop's own rule id; the reason line says it in words
    if (key === 'arguments' && val && typeof val === 'object' && !Array.isArray(val)) {
      argRows = Object.entries(val).filter(([, av]) => av !== undefined);
    } else if (key === 'referencedSecrets') {
      if (Array.isArray(val) ? val.length > 0 : Boolean(val)) {
        secretsVal = val;
      }
    } else {
      topRows.push([key, val]);
    }
  }

  const sections = [];
  if (destination) {
    sections.push(`
      <div class="approval-kv-group">
        <div class="approval-kv-row approval-kv-secrets approval-kv-destination">
          <dt>Destination</dt>
          <dd><strong>${esc(destination)}</strong></dd>
        </div>
      </div>
    `);
  }
  if (topRows.length > 0) {
    sections.push(`
      <div class="approval-kv-group">
        ${topRows.map(([k, v]) => `
          <div class="approval-kv-row">
            <dt>${esc(k)}</dt>
            <dd>${esc(formatApprovalValue(v))}</dd>
          </div>
        `).join('')}
      </div>
    `);
  }
  if (argRows.length > 0) {
    sections.push(`
      <div class="approval-kv-group">
        <div class="approval-kv-group-title">Arguments</div>
        ${argRows.map(([k, v]) => `
          <div class="approval-kv-row">
            <dt>${esc(k)}</dt>
            <dd>${esc(formatApprovalValue(v))}</dd>
          </div>
        `).join('')}
      </div>
    `);
  }
  if (secretsVal !== null) {
    sections.push(`
      <div class="approval-kv-group">
        <div class="approval-kv-row approval-kv-secrets">
          <dt>Vault secrets <span class="sr-only">(referencedSecrets)</span></dt>
          <dd>${esc(formatApprovalValue(secretsVal))}</dd>
        </div>
      </div>
    `);
  }

  if (sections.length === 0) return '';
  return `<dl class="approval-detail approval-kv mono">${sections.join('')}</dl>`;
}

// A card or a login that asks keeps its own rule, so a rule on the tool would change nothing there.
function canAlwaysAllowApproval(item) {
  const rule = String(item?.detail?.rule || '');
  return Boolean(
    item &&
    item.kind === 'run' &&
    !item.guard &&
    !rule.startsWith('secret:') &&
    !rule.startsWith('vaultType:') &&
    typeof item.target === 'string' &&
    item.target.includes('__'),
  );
}

// Loop asked because of what the tool says about itself (not a rule the owner set), so the
// owner can also choose to stop being asked for that whole connection.
function canAlwaysAllowConnection(item) {
  return Boolean(
    item &&
    item.kind === 'run' &&
    !item.guard &&
    item.detail &&
    typeof item.detail === 'object' &&
    typeof item.detail.connectionId === 'string' &&
    item.detail.connectionId &&
    String(item.detail.rule || '').startsWith('toolKind:'),
  );
}

// An agent asks to add something new. `target` is made by Loop, not by the agent.
const isAddQuestion = (item) => item?.kind === 'save' && /^(connection|skill):add$/.test(String(item.target || ''));

function approvalConnectionName(item) {
  return String(item?.detail?.connection || item?.detail?.connectionId || 'this connection');
}

function isDeleteApproval(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.kind === 'delete' || item.kind === 'cleanup') return true;
  return /\b(?:delete|remove|forget|cleanup)\b/i.test(`${item.title || ''} ${item.target || ''}`);
}

let approvalBannerShownAt = 0;
const APPROVAL_BANNER_CLICK_GUARD_MS = 450;

function isPanelOpenOnPage() {
  return Boolean(document.querySelector?.('dialog[open], .st-root') || uiState.profileMenu);
}

function renderApprovalBanner() {
  const banner = document.getElementById('banner');
  if (!banner) return;
  if (approvalsOnHome) {
    if (isPanelOpenOnPage()) {
      connectionsRefreshWaiting = true;
    } else {
      banner.innerHTML = '';
      approvalsOnHome();
      return;
    }
  }
  if (!auth.signedIn || pendingApprovals.length === 0) {
    banner.innerHTML = '';
    approvalBannerShownAt = 0;
    return;
  }

  const wasEmpty = !banner.querySelector?.('.approval-banner');
  if (wasEmpty) approvalBannerShownAt = Date.now();

  banner.innerHTML = `
    <section class="approval-banner" id="approvals-banner" tabindex="-1" role="region" aria-label="Pending approvals">
      <div class="approval-banner-head">
        <span>Approval required</span>
        ${pendingApprovals.length > 1 ? `<span class="approval-count">${esc(pendingApprovals.length)} pending</span>` : ''}
      </div>
      <div class="approval-list">
        ${pendingApprovals.map((item) => {
          const title = item.title || item.target || item.kind || 'Approval requested';
          const showTarget = Boolean(item.target && !isAddQuestion(item) && !String(title).includes(String(item.target)));
          const card = organizeApprovalCard(item);
          const detailHtml = card ? renderOrganizeApproval(card, esc) : renderApprovalDetail(item.detail);
          const busy = inFlightApprovals.has(item.id);
          const alwaysAllow = canAlwaysAllowApproval(item);
          const isDel = isDeleteApproval(item);
          return `
            <div class="approval-item${canAlwaysAllowConnection(item) ? ' is-wide' : ''}" data-approval-id="${esc(item.id)}">
              <div class="approval-body">
                <div class="approval-meta">
                  <span class="tag approval-agent">${esc(item.agentName || 'Agent')}</span>
                  <strong class="approval-title">${esc(title)}</strong>
                  ${showTarget ? `<code class="inline-code">${esc(item.target)}</code>` : ''}
                </div>
                ${item.reason ? `<div class="approval-reason">${esc(item.reason)}</div>` : ''}
                ${detailHtml}
              </div>
              <div class="approval-acts">
                <button type="button" class="btn sm${isDel ? '' : ' fill'}" data-approve="${esc(item.id)}" ${busy ? 'disabled' : ''}>${item.guard ? 'Confirm' : isAddQuestion(item) ? 'Add' : 'Approve'}</button>
                ${alwaysAllow ? `<button type="button" class="btn sm" data-approve-always="${esc(item.id)}" ${busy ? 'disabled' : ''}>Approve &amp; Always Allow</button>` : ''}
                ${canAlwaysAllowConnection(item) ? `<button type="button" class="btn sm" data-approve-always-conn="${esc(item.id)}" title="Stop asking for any tool on this connection" ${busy ? 'disabled' : ''}>Always allow all of ${esc(approvalConnectionName(item))}</button>` : ''}
                <button type="button" class="btn sm danger-outline" data-deny="${esc(item.id)}" ${busy ? 'disabled' : ''}>${isAddQuestion(item) ? 'Not now' : 'Deny'}</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </section>
  `;

  const guardedApprove = (fn) => () => {
    if (approvalBannerShownAt && Date.now() - approvalBannerShownAt < APPROVAL_BANNER_CLICK_GUARD_MS) return;
    fn();
  };
  banner.querySelectorAll('[data-approve]').forEach((btn) => {
    btn.addEventListener('click', guardedApprove(() => handleApprovalDecision(btn.dataset.approve, true)));
  });
  banner.querySelectorAll('[data-approve-always]').forEach((btn) => {
    btn.addEventListener('click', guardedApprove(() => handleApprovalDecision(btn.dataset.approveAlways, true, { alwaysAllow: true })));
  });
  banner.querySelectorAll('[data-approve-always-conn]').forEach((btn) => {
    btn.addEventListener('click', guardedApprove(() => handleApprovalDecision(btn.dataset.approveAlwaysConn, true, { alwaysAllow: 'connection' })));
  });
  banner.querySelectorAll('[data-deny]').forEach((btn) => {
    btn.addEventListener('click', () => handleApprovalDecision(btn.dataset.deny, false));
  });
}

function focusApprovalsBanner() {
  const banner = document.getElementById('banner');
  const bannerRegion = banner?.querySelector?.('.approval-banner');
  if (bannerRegion) {
    if (!bannerRegion.hasAttribute('tabindex')) bannerRegion.setAttribute('tabindex', '-1');
    bannerRegion.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    (bannerRegion.querySelector?.('[data-approve]') || bannerRegion).focus?.({ preventScroll: true });
    return true;
  }
  const homeApprovals = document.querySelector?.('[data-hm-group="needs"]') || document.querySelector?.('[data-hm-group="__attention"]');
  if (homeApprovals) {
    if (!homeApprovals.hasAttribute('tabindex')) homeApprovals.setAttribute('tabindex', '-1');
    homeApprovals.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    (homeApprovals.querySelector?.('[data-hm-approve]') || homeApprovals).focus?.({ preventScroll: true });
    return true;
  }
  return false;
}

async function handleApprovalDecision(id, approved, { alwaysAllow = false } = {}) {
  if (!id || inFlightApprovals.has(id)) return;
  const item = pendingApprovals.find((p) => p.id === id);
  // Guard: the yes is given on the request's own page, with the password.
  if (approved && item?.guard) {
    if (shownSection === 'home') openApprovalFocusDialog(id);
    else location.hash = `#approvals?id=${encodeURIComponent(id)}`;
    return;
  }
  const label = item?.title || item?.target || 'request';
  const useAlwaysAllow = Boolean(approved && alwaysAllow);
  inFlightApprovals.add(id);
  renderApprovalBanner();

  try {
    const reqOpts = { method: 'POST' };
    const letManage = useAlwaysAllow && alwaysAllow === 'agent';
    if (letManage) {
      await api(`/api/agents/${encodeURIComponent(item.agentId)}`, { method: 'PATCH', body: JSON.stringify({ canManage: true }) });
    } else if (useAlwaysAllow) {
      reqOpts.body = JSON.stringify({ alwaysAllow: alwaysAllow === 'connection' ? 'connection' : true });
    }
    const res = await api(`/api/approvals/${encodeURIComponent(id)}/${approved ? 'approve' : 'deny'}`, reqOpts);
    inFlightApprovals.delete(id);
    pendingApprovals = pendingApprovals.filter((p) => p.id !== id);
    renderApprovalBanner();
    const toastMsg = isAddQuestion(item)
      ? !approved ? 'Not added.' : letManage ? `${item.agentName || 'The agent'} can manage connections now.` : `${item.agentName || 'The agent'} can add it now.`
      : !approved
      ? `Denied "${label}".`
      : useAlwaysAllow && res?.alwaysAllowed
        ? res?.scope === 'connection'
          ? `Approved. ${approvalConnectionName(item)} tools now run without asking.`
          : `Approved & always allowed "${label}".`
        : `Approved "${label}".`;
    toast(toastMsg, approved ? 'ok' : '');
    refreshApprovals();
  } catch (err) {
    inFlightApprovals.delete(id);
    toast(err.message, 'err');
    refreshApprovals();
  }
}

function closeActiveApprovalDialog({ clearHash = false } = {}) {
  const dlg = activeApprovalDialog;
  if (dlg) {
    activeApprovalDialog = null;
    dlg.__xpAnchor?.classList.remove('xp-anchor');
    try { if (dlg.open) dlg.close(); } catch { /* ignore */ }
    dlg.remove();
  }
  if (clearHash && /^#\/?approvals\b/i.test(location.hash)) {
    history.replaceState(null, '', '#home');
  }
}

// Under its row in Needs you; at the top of the list when that row is gone (then it returns true).
function placeApprovalDialog(dlg, root) {
  const row = [...root.querySelectorAll('[data-hm-approve]')]
    .find((btn) => btn.dataset.hmApprove === dlg.dataset.approvalId)?.closest('li');
  if (row?.getClientRects().length) {
    row.after(dlg);
    row.classList.add('xp-anchor');
    dlg.__xpAnchor = row;
    return false;
  }
  (root.querySelector('.ctl-scroll') || root).prepend(dlg);
  dlg.__xpAnchor = null;
  return true;
}

// Home is drawn again when an approval comes or goes. An open one keeps its place, and the
// password being typed. Call the result after the redraw.
function holdApprovalDialog(root) {
  const dlg = activeApprovalDialog;
  if (!dlg || !root.contains(dlg)) return () => false;
  const focused = dlg.contains(document.activeElement) ? document.activeElement : null;
  return () => {
    const onTop = placeApprovalDialog(dlg, root);
    focused?.focus({ preventScroll: true });
    return onTop;
  };
}

async function openApprovalFocusDialog(approvalId) {
  const id = String(approvalId || '').trim();
  if (!id || !auth.signedIn) return;
  closeActiveApprovalDialog();

  const dlg = document.createElement('dialog');
  dlg.className = 'loop-dialog approval-focus-dialog';
  dlg.dataset.approvalId = id;
  dlg.setAttribute('aria-labelledby', 'approval-focus-title');
  activeApprovalDialog = dlg;
  document.body.appendChild(dlg);

  const renderSettled = (status, label) => {
    const isOk = status === 'approved' || status === 'consumed';
    const heading = status === 'approved'
      ? 'Approved'
      : status === 'consumed'
        ? 'Already approved and run'
        : status === 'denied'
          ? 'Denied'
          : status === 'expired'
            ? 'Approval expired'
            : 'Approval not found';
    const note = status === 'approved'
      ? 'Your agent can proceed now.'
      : status === 'consumed'
        ? 'This action already ran.'
        : status === 'denied'
          ? 'Nothing was run.'
          : status === 'expired'
            ? 'Ask your agent again if you still want to run this.'
            : 'This approval link is no longer active.';
    dlg.innerHTML = `
      <div class="apf-card">
        <div class="apf-kicker">Loop approval</div>
        <h2 id="approval-focus-title" class="apf-state ${isOk ? 'is-ok' : ''}">${esc(heading)}</h2>
        ${label ? `<p class="apf-title">${esc(label)}</p>` : ''}
        <p class="apf-sub">${esc(note)}</p>
        <div class="apf-acts">
          <button type="button" class="btn fill" data-apf-close>Done</button>
        </div>
      </div>
    `;
    dlg.querySelector('[data-apf-close]')?.addEventListener('click', () => closeActiveApprovalDialog({ clearHash: true }));
  };

  // A request on Guard: what it is, then the password. Nothing in an agent's app can answer it.
  const renderGuardItem = (item, title) => {
    const detail = item.detail && typeof item.detail === 'object' ? item.detail : {};
    const agent = String(item.agentName || 'An agent');
    // The Vault item whose rule this is, when it is one.
    const held = (Array.isArray(detail.referencedSecrets) ? detail.referencedSecrets : [])
      .find((s) => detail.rule === `secret:${s?.key}` || detail.rule === `vaultType:${s?.type}`);
    const heldKey = String(held?.key || '');
    const heading = heldKey ? `${agent} wants to use ${heldKey}` : `${agent} wants your OK`;
    const destination = extractApprovalDestination(item.detail);
    const row = (label, value) => (value ? `<div class="apg-row"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>` : '');
    const card = organizeApprovalCard(item);
    const detailHtml = card ? renderOrganizeApproval(card, esc) : renderApprovalDetail(item.detail);
    const mins = Math.max(1, Math.round((Date.parse(item.expiresAt) - Date.now()) / 60000)) || 10;
    dlg.innerHTML = `
      <div class="apg">
        <div class="apg-k">${modeGlyph('guard')}Guard</div>
        <h2 id="approval-focus-title" class="apg-h">${esc(heading)}</h2>
        <dl class="apg-rows">
          ${row('To', title)}
          ${row('At', destination)}
          ${row('Good for', `One use. You have ${mins} ${mins === 1 ? 'minute' : 'minutes'}.`)}
        </dl>
        ${detailHtml ? `<details class="apg-more"><summary>Details</summary>${item.reason ? `<p>${esc(item.reason)}</p>` : ''}${detailHtml}</details>` : ''}
        <div data-apg-pass></div>
        <div class="apg-acts">
          <button type="button" class="btn danger-outline" data-apg-deny>Deny</button>
        </div>
        <p class="apg-foot">An agent cannot answer this page for you.</p>
      </div>`;
    dlg.querySelector('[data-apg-deny]').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api(`/api/approvals/${encodeURIComponent(item.id)}/deny`, { method: 'POST' });
        settle('denied');
      } catch (err) {
        e.target.disabled = false;
        toast(err.message, 'err');
      }
    });
    const settle = (status) => {
      pendingApprovals = pendingApprovals.filter((p) => p.id !== item.id);
      renderApprovalBanner();
      refreshApprovals();
      renderSettled(status, title);
    };
    const host = dlg.querySelector('[data-apg-pass]');
    if (auth.mode === 'clerk' && !auth.vaultPasswordSet) {
      host.innerHTML = `<p class="vm-msg">Guard needs a ${passwordName()}. <a href="#settings?tab=vault">Set one up</a></p>`;
      host.querySelector('a').addEventListener('click', () => closeActiveApprovalDialog());
      return;
    }
    askPassword(host, {
      passwordName: passwordName(),
      submitLabel: 'Approve once',
      send: (password) => api(`/api/approvals/${encodeURIComponent(item.id)}/approve`, { method: 'POST', body: JSON.stringify({ password }) }),
    }).then((res) => {
      if (res) settle('approved');
    }, (err) => {
      toast(err.message, 'err');
      if (activeApprovalDialog === dlg) openApprovalFocusDialog(item.id);
    });
  };

  const renderItem = (item) => {
    const title = String(item?.title || item?.target || 'Approval requested');
    if (!item) {
      renderSettled('not_found', '');
      return;
    }
    if (item.status && item.status !== 'pending') {
      renderSettled(item.status, title);
      return;
    }
    if (item.guard) {
      renderGuardItem(item, title);
      return;
    }
    if (item.uiSpec && item.uiSpec.root && item.uiSpec.elements) {
      dlg.innerHTML = '';
      const rendered = renderJsonRenderDom(item.uiSpec, {
        titleId: 'approval-focus-title',
        onAction: async ({ optionId, decision, alwaysAllow, values }) => {
          rendered.setBusy(true);
          rendered.showError('');
          try {
            await api(`/api/approvals/${encodeURIComponent(item.id)}/decide`, {
              method: 'POST',
              body: JSON.stringify({ optionId, decision, alwaysAllow, values }),
            });
            pendingApprovals = pendingApprovals.filter((p) => p.id !== item.id);
            renderApprovalBanner();
            refreshApprovals();
            renderSettled(decision === 'deny' ? 'denied' : 'approved', title);
          } catch (err) {
            rendered.setBusy(false);
            rendered.showError(err?.message || 'Could not save your decision.');
          }
        },
      });
      dlg.appendChild(rendered.element);
      return;
    }
    const showTarget = Boolean(item.target && !isAddQuestion(item) && !title.includes(String(item.target)));
    const destination = extractApprovalDestination(item.detail);
    const card = organizeApprovalCard(item);
    const detailHtml = card ? renderOrganizeApproval(card, esc) : renderApprovalDetail(item.detail);
    const alwaysAllow = canAlwaysAllowApproval(item);
    const alwaysConn = canAlwaysAllowConnection(item);
    dlg.innerHTML = `
      <div class="apf-card">
        <div class="apf-kicker">${isAddQuestion(item) ? 'Loop approval' : `${esc(item.agentName || 'An agent')} wants to run an action`}</div>
        <h2 id="approval-focus-title">${esc(title)}</h2>
        ${item.reason ? `<p class="apf-sub">${esc(item.reason)}</p>` : ''}
        ${showTarget ? `<div class="apf-row"><span class="apf-lbl">Tool</span><code class="inline-code">${esc(item.target)}</code></div>` : ''}
        ${destination ? `<div class="apf-row"><span class="apf-lbl">Destination</span><code class="inline-code">${esc(destination)}</code></div>` : ''}
        ${detailHtml ? `<div class="apf-detail">${detailHtml}</div>` : ''}
        <p class="field-err" data-apf-err hidden></p>
        <div class="apf-choices">
          <button type="button" class="btn fill apf-yes" data-apf-approve>${isAddQuestion(item) ? 'Add' : 'Yes, Approve'}</button>
          <button type="button" class="btn danger-outline apf-no" data-apf-deny>${isAddQuestion(item) ? 'Not now' : 'No, Deny'}</button>
        </div>
        ${alwaysAllow || alwaysConn ? `
          <div class="apf-extra">
            ${alwaysAllow ? '<button type="button" class="btn sm" data-apf-always>Approve &amp; always allow this tool</button>' : ''}
            ${alwaysConn ? `<button type="button" class="btn sm" data-apf-always-conn>Always allow all of ${esc(approvalConnectionName(item))}</button>` : ''}
          </div>
        ` : ''}
      </div>
    `;
    const decide = async (approved, opts = {}) => {
      const buttons = dlg.querySelectorAll('button');
      buttons.forEach((b) => { b.disabled = true; });
      const errEl = dlg.querySelector('[data-apf-err]');
      if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
      try {
        const reqOpts = { method: 'POST' };
        if (approved && opts.alwaysAllow) {
          reqOpts.body = JSON.stringify({ alwaysAllow: opts.alwaysAllow === 'connection' ? 'connection' : true });
        }
        await api(`/api/approvals/${encodeURIComponent(item.id)}/${approved ? 'approve' : 'deny'}`, reqOpts);
        pendingApprovals = pendingApprovals.filter((p) => p.id !== item.id);
        renderApprovalBanner();
        refreshApprovals();
        renderSettled(approved ? 'approved' : 'denied', title);
      } catch (err) {
        buttons.forEach((b) => { b.disabled = false; });
        if (errEl) {
          errEl.textContent = err?.message || 'Could not save your decision.';
          errEl.hidden = false;
        }
      }
    };
    dlg.querySelector('[data-apf-approve]')?.addEventListener('click', () => decide(true));
    dlg.querySelector('[data-apf-deny]')?.addEventListener('click', () => decide(false));
    dlg.querySelector('[data-apf-always]')?.addEventListener('click', () => decide(true, { alwaysAllow: true }));
    dlg.querySelector('[data-apf-always-conn]')?.addEventListener('click', () => decide(true, { alwaysAllow: 'connection' }));
  };

  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeActiveApprovalDialog({ clearHash: true });
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) closeActiveApprovalDialog({ clearHash: true });
  });

  const cached = pendingApprovals.find((p) => p.id === id) || null;
  if (cached) {
    renderItem(cached);
  } else {
    dlg.innerHTML = '<div class="apf-card"><div class="apf-kicker">Loop approval</div><p class="apf-sub">Loading approval details…</p></div>';
  }
  try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
  // Opened by its link, not from a row: it goes under its row too.
  const home = shownSection === 'home' ? dlg.closest('.view') : null;
  if (home && !dlg.__xpAnchor) {
    placeApprovalDialog(dlg, home);
    dlg.querySelector('[autofocus]')?.focus({ preventScroll: true }); // a move drops the focus
  }

  try {
    const res = await api(`/api/approvals/${encodeURIComponent(id)}`);
    if (activeApprovalDialog !== dlg) return;
    const fresh = res?.approval || null;
    // The same open question again: the password being typed stays.
    if (cached?.guard && fresh?.guard && fresh.status === 'pending') return;
    renderItem(fresh);
  } catch {
    if (activeApprovalDialog !== dlg) return;
    if (!cached) renderSettled('not_found', '');
  }
}

async function refreshApprovals() {
  if (!auth.signedIn) {
    clearApprovalBanner();
    return;
  }
  const seq = ++approvalsSeq;
  try {
    const data = await api('/api/approvals');
    if (seq !== approvalsSeq || !auth.signedIn) return;
    const before = JSON.stringify(pendingApprovals);
    pendingApprovals = Array.isArray(data?.pending)
      ? data.pending
      : (Array.isArray(data?.approvals) ? data.approvals : []);
    // The same approvals again: Home is not drawn again, so an open panel stays.
    if (!approvalsOnHome || JSON.stringify(pendingApprovals) !== before) renderApprovalBanner();
    if (pendingApprovalFocusId) {
      const idToOpen = pendingApprovalFocusId;
      pendingApprovalFocusId = '';
      pendingApprovalsFocus = false;
      onHomeShown(() => openApprovalFocusDialog(idToOpen));
      return;
    }
    if (pendingApprovalsFocus) {
      if (pendingApprovals.length > 0) {
        if (focusApprovalsBanner()) pendingApprovalsFocus = false;
      } else {
        pendingApprovalsFocus = false;
        toast('No pending approvals right now.');
      }
    }
  } catch {
    // Degrade silently on background approval poll errors.
  }
}

function parseRoute(rawHashInput = location.hash, rawSearchInput = location.search) {
  const rawHash = String(rawHashInput || '').replace(/^#\/?/, '');
  const qIndex = rawHash.indexOf('?');
  const pathPart = qIndex >= 0 ? rawHash.slice(0, qIndex) : rawHash;
  const hashQuery = qIndex >= 0 ? rawHash.slice(qIndex + 1) : '';
  const seg = pathPart.split('/')[0].toLowerCase();

  const params = new URLSearchParams(String(rawSearchInput || ''));
  const hashParams = new URLSearchParams(hashQuery);
  for (const [k, v] of hashParams.entries()) {
    params.set(k, v);
  }
  const queryTab = !seg ? String(params.get('tab') || '').toLowerCase() : '';
  const pathSeg = !seg && location.pathname === '/save' ? 'saved' : '';
  const effectiveSeg = seg || pathSeg || (Object.hasOwn(PAGES, queryTab) ? queryTab : '');
  const focusApprovals = effectiveSeg === 'approvals';
  const approvalId = focusApprovals ? String(params.get('id') || '').trim() : '';
  const subSeg = (pathPart.split('/')[1] || '').trim();
  const part = focusApprovals ? null : brainPartOf(effectiveSeg, subSeg.toLowerCase());
  const defaultSec = specialistCaps.enabled ? 'loop' : 'home';
  const rawSection = focusApprovals
    ? 'home'
    : part
      ? (part === 'memories' ? 'memory' : part === 'skills' ? 'skills' : 'saved')
      : (Object.hasOwn(PAGES, effectiveSeg) ? effectiveSeg : defaultSec);
  const section = rawSection === 'loop' && !specialistCaps.enabled ? 'home' : rawSection;
  return { section, part, subSeg, params, hasHashQuery: qIndex >= 0, focusApprovals, approvalId };
}

function getTransport(mcp) {
  const raw = String(mcp?.transport || '').toLowerCase();
  if (raw === 'stdio' || raw === 'sse' || raw === 'http') return raw;
  return mcp?.command && !mcp?.url ? 'stdio' : 'http';
}

const LOCAL_ICON = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="13" height="9" rx="1.6"/><path d="M2 15.5h16"/></svg>';
const CLOUD_ICON = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.2 15.5h8.1a3.2 3.2 0 0 0 .5-6.36A4.7 4.7 0 0 0 5.6 7.5a3.5 3.5 0 0 0 .6 8Z"/></svg>';
// Letter tiles: a calm colour picked from the name, so the same connection always looks the same.
const TILE_TONE_COUNT = 8;
function tileToneIndex(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % TILE_TONE_COUNT;
}
function connInitial(name) {
  const word = String(name || '?').replace(/^[^a-z0-9]+/i, '');
  return (word[0] || '?').toUpperCase();
}

// A connection's mark: its logo (or a letter tile when none was found), with a small badge
// saying where it runs: a laptop for this Mac, a cloud for a remote server.
function renderConnLogo(mcp, { badge = true } = {}) {
  // A relay link (relay.useloop.sh) reaches a program on a paired computer, so it is local too.
  const local = getTransport(mcp) === 'stdio' || (typeof mcp?.url === 'string' && mcp.url.startsWith('https://relay.useloop.sh/d/'));
  const where = local ? 'Local, runs on this Mac' : 'Cloud, remote server';
  const mark = mcp.logo
    ? `<img src="${esc(mcp.logo)}" alt="" width="24" height="24" loading="lazy" decoding="async">`
    : `<span class="conn-logo-letter conn-tile-${tileToneIndex(mcp.name)}">${esc(connInitial(mcp.name))}</span>`;
  return `<span class="conn-logo ${mcp.logo ? 'has-img' : ''}" title="${esc(where)}">${mark}${badge ? `<span class="conn-logo-badge" aria-label="${local ? 'Local' : 'Cloud'}">${local ? LOCAL_ICON : CLOUD_ICON}</span>` : ''}</span>`;
}

// Change logo: upload an image, paste an image address, or go back to the one Loop found.
function openLogoDialog(mcp, onDone) {
  const dlg = document.createElement('dialog');
  dlg.className = 'loop-dialog logo-dialog';
  dlg.setAttribute('aria-labelledby', 'logo-dialog-title');
  dlg.innerHTML = `
    <div class="cat-add-head">
      <h3 id="logo-dialog-title">Logo for ${esc(mcp.name)}</h3>
      <button type="button" class="btn sm ghost" data-logo-cancel>Cancel</button>
    </div>
    <div class="logo-dialog-now">${renderConnLogo(mcp, { badge: false })}<span>${mcp.logo ? 'Loop found this logo. Replace it with your own:' : 'Loop could not find a logo. Add one:'}</span></div>
    <form class="form-grid" data-logo-form>
      <label class="field">
        <span class="lbl">Image file</span>
        <input type="file" name="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/x-icon">
      </label>
      <label class="field">
        <span class="lbl">Or an image address</span>
        <input type="url" name="url" placeholder="https://example.com/logo.png" autocomplete="off">
      </label>
      <p class="hint">PNG, JPEG, GIF, WebP, SVG or ICO, up to 256 KB.</p>
      <div class="acts">
        <button type="submit" class="btn fill">Save logo</button>
        <button type="button" class="btn ghost" data-logo-reset>Use the logo Loop finds</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  const close = () => dlg.close();
  dlg.addEventListener('close', () => dlg.remove());
  dlg.querySelector('[data-logo-cancel]').onclick = close;
  const finish = async (request, btn, busyLabel) => {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyLabel;
    try {
      await request();
      close();
      onDone?.();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
      btn.textContent = label;
    }
  };
  dlg.querySelector('[data-logo-reset]').onclick = (e) => finish(
    () => api(`/api/mcps/${encodeURIComponent(mcp.id)}/logo`, { method: 'DELETE' }),
    e.currentTarget,
    'Looking…',
  );
  dlg.querySelector('[data-logo-form]').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const file = form.file.files?.[0] || null;
    const url = form.url.value.trim();
    if (!file && !url) {
      toast('Choose an image file or paste an image address.', 'err');
      return;
    }
    if (file && file.size > 256 * 1024) {
      toast('That image is over 256 KB.', 'err');
      return;
    }
    finish(async () => {
      const image = file ? await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read that file.'));
        reader.readAsDataURL(file);
      }) : null;
      await api(`/api/mcps/${encodeURIComponent(mcp.id)}/logo`, {
        method: 'POST',
        body: JSON.stringify(image ? { image } : { url }),
      });
    }, form.querySelector('button[type="submit"]'), 'Saving…');
  });
  dlg.showModal();
}

function groupConnectionsByCategory(mcps = [], categories = []) {
  const byId = new Map(mcps.map((m) => [m.id, m]));
  const used = new Set();
  const groups = [];

  for (const cat of Array.isArray(categories) ? categories : []) {
    const items = [];
    for (const ref of Array.isArray(cat.connections) ? cat.connections : []) {
      const m = byId.get(ref.id);
      if (m && !used.has(m.id)) {
        used.add(m.id);
        items.push(m);
      }
    }
    if (items.length > 0 || cat.custom) {
      groups.push({
        id: cat.id,
        label: cat.label || cat.id,
        description: cat.description || '',
        custom: Boolean(cat.custom),
        mcps: items,
      });
    }
  }

  // Fallback for any connection not present in data.categories
  const extraByCat = new Map();
  for (const m of mcps) {
    if (used.has(m.id)) continue;
    const id = m.category || 'general';
    const label = m.categoryLabel || 'General';
    if (!extraByCat.has(id)) extraByCat.set(id, { id, label, description: '', mcps: [] });
    extraByCat.get(id).mcps.push(m);
  }
  for (const g of extraByCat.values()) groups.push(g);

  return groups.map((g) => ({
    ...g,
    mcps: [...g.mcps].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
    needsSignIn: g.mcps.filter((m) => m.authRequired && !m.tokenRejected).length,
  }));
}

function getToolCounts(mcp) {
  const tools = Array.isArray(mcp?.tools) ? mcp.tools : [];
  const disabledSet = new Set(Array.isArray(mcp?.disabledTools) ? mcp.disabledTools : []);
  let enabled = 0;
  for (const t of tools) {
    const isOff = disabledSet.has(t.name) || t.enabled === false;
    if (!isOff) enabled += 1;
  }
  return { total: tools.length, enabled, disabledSet };
}

function customProfilesOf(mcp) {
  return (Array.isArray(mcp?.profiles) ? mcp.profiles : []).filter((p) => p && p !== 'all');
}

function formatUpdatedAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function parseArgsInput(str) {
  const raw = String(str ?? '').trim();
  if (!raw) return [];
  const args = [];
  let current = '';
  let hasToken = false;
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
    } else if (quote === '"') {
      if (ch === '\\' && i + 1 < raw.length) {
        const next = raw[i + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next;
          i += 1;
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '\\') {
      if (i + 1 < raw.length) {
        current += raw[i + 1];
        hasToken = true;
        i += 1;
      } else {
        throw new Error('Invalid trailing backslash in arguments.');
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        args.push(current);
        current = '';
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (quote) {
    throw new Error(`Unclosed ${quote === '"' ? 'double' : 'single'} quote in arguments.`);
  }
  if (hasToken) args.push(current);
  return args;
}

function parseHeaderLines(str) {
  const headers = {};
  const seen = new Map();
  for (const line of String(str || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) {
      throw new Error(`Invalid header line: "${trimmed}" (use Key: Value).`);
    }
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (!key || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key)) {
      throw new Error(`Invalid header name: "${key}" (use a valid HTTP header name).`);
    }
    if (!val) {
      throw new Error(`Header "${key}" cannot have an empty value.`);
    }
    if (/[\r\n\0]/.test(val)) {
      throw new Error(`Header "${key}" contains invalid control characters.`);
    }
    const lower = key.toLowerCase();
    if (seen.has(lower)) {
      throw new Error(`Duplicate header "${key}" (already defined as "${seen.get(lower)}").`);
    }
    seen.set(lower, key);
    headers[key] = val;
  }
  return headers;
}

function parseEnvLines(str) {
  const env = {};
  for (const line of String(str || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.replace(/^export[ \t]+/, '');
    const idx = body.indexOf('=');
    if (idx <= 0) {
      throw new Error(`Invalid env line: "${trimmed}" (use KEY=VALUE).`);
    }
    const key = body.slice(0, idx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid env variable name: "${key}" (use letters, numbers, and underscores).`);
    }
    const rawVal = body.slice(idx + 1).trim();
    let val = rawVal;
    if (rawVal.startsWith('"')) {
      let parsed = '';
      let closed = false;
      let endIdx = -1;
      for (let i = 1; i < rawVal.length; i += 1) {
        const ch = rawVal[i];
        if (ch === '\\' && i + 1 < rawVal.length) {
          const next = rawVal[i + 1];
          if (next === 'n') parsed += '\n';
          else if (next === 'r') parsed += '\r';
          else if (next === 't') parsed += '\t';
          else if (next === '"' || next === '\\' || next === '$') parsed += next;
          else parsed += `\\${next}`;
          i += 1;
        } else if (ch === '"') {
          closed = true;
          endIdx = i;
          break;
        } else {
          parsed += ch;
        }
      }
      if (!closed) {
        throw new Error(`Unclosed double quote in env value for "${key}".`);
      }
      const trailing = rawVal.slice(endIdx + 1).trim();
      if (trailing && !trailing.startsWith('#')) {
        throw new Error(`Invalid quoted env value for "${key}".`);
      }
      val = parsed;
    } else if (rawVal.startsWith("'")) {
      const endIdx = rawVal.indexOf("'", 1);
      if (endIdx < 0) {
        throw new Error(`Unclosed single quote in env value for "${key}".`);
      }
      const trailing = rawVal.slice(endIdx + 1).trim();
      if (trailing && !trailing.startsWith('#')) {
        throw new Error(`Invalid quoted env value for "${key}".`);
      }
      val = rawVal.slice(1, endIdx);
    }
    env[key] = val;
  }
  return env;
}

function extractJsonNumberTokens(raw) {
  const tokens = [];
  const len = raw.length;
  for (let i = 0; i < len; i += 1) {
    const ch = raw[i];
    if (ch === '"') {
      i += 1;
      while (i < len) {
        if (raw[i] === '\\') {
          i += 2;
          continue;
        }
        if (raw[i] === '"') break;
        i += 1;
      }
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const start = i;
      i += 1;
      while (i < len && /[0-9.eE+-]/.test(raw[i])) i += 1;
      tokens.push(raw.slice(start, i));
      i -= 1;
    }
  }
  return tokens;
}

function prettyPrintJsonLossless(raw) {
  const out = [];
  const len = raw.length;
  let depth = 0;
  for (let i = 0; i < len; i += 1) {
    const ch = raw[i];
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < len) {
        if (raw[i] === '\\') {
          i += 2;
          continue;
        }
        if (raw[i] === '"') break;
        i += 1;
      }
      out.push(raw.slice(start, Math.min(i + 1, len)));
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    if (ch === '{' || ch === '[') {
      const closer = ch === '{' ? '}' : ']';
      let look = i + 1;
      while (look < len && (raw[look] === ' ' || raw[look] === '\t' || raw[look] === '\n' || raw[look] === '\r')) {
        look += 1;
      }
      if (look < len && raw[look] === closer) {
        out.push(ch, closer);
        i = look;
      } else {
        depth += 1;
        out.push(ch, '\n', '  '.repeat(depth));
      }
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth = Math.max(0, depth - 1);
      out.push('\n', '  '.repeat(depth), ch);
      continue;
    }
    if (ch === ',') {
      out.push(',\n', '  '.repeat(depth));
      continue;
    }
    if (ch === ':') {
      out.push(': ');
      continue;
    }
    out.push(ch);
  }
  return out.join('');
}

function safePrettyJson(raw) {
  if (typeof raw !== 'string') return String(raw ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return raw;
  }
  const stringified = JSON.stringify(parsed, null, 2);
  const origNums = extractJsonNumberTokens(trimmed);
  const newNums = extractJsonNumberTokens(stringified);
  if (origNums.length === newNums.length && origNums.every((tok, idx) => tok === newNums[idx])) {
    return stringified;
  }
  return prettyPrintJsonLossless(trimmed);
}

function formatToolResult(payload) {
  const data = payload?.result !== undefined ? payload.result : payload;
  if (data && typeof data === 'object' && Array.isArray(data.content)) {
    const allText = data.content.length > 0 && data.content.every((c) => c && c.type === 'text' && typeof c.text === 'string');
    if (allText) {
      const joined = data.content.map((c) => c.text).join('\n');
      return { text: safePrettyJson(joined), isError: Boolean(data.isError) };
    }
  }
  if (typeof data === 'string') return { text: data, isError: false };
  return {
    text: JSON.stringify(data ?? {}, null, 2),
    isError: Boolean(data && typeof data === 'object' && data.isError),
  };
}

function renderLoading(root, label = 'Loading…') {
  if (!root || root.childElementCount > 0) return;
  root.innerHTML = `
    <div class="loading-skeleton" role="status" aria-label="${esc(label)}">
      <div class="skel-bar skel-title"></div>
      <div class="skel-row"></div>
      <div class="skel-row"></div>
      <div class="skel-row"></div>
    </div>
  `;
}

function renderErrorState(root, err, onRetry) {
  root.innerHTML = `
    <div class="empty err">
      <p class="et">Could not load data</p>
      <p class="ed">${esc(err?.message || 'Unexpected error.')}</p>
      <div class="acts center">
        <button type="button" class="btn sm" id="retry-view">Try again</button>
      </div>
    </div>
  `;
  root.querySelector('#retry-view')?.addEventListener('click', onRetry);
}

/* ===========================
   1. HOME VIEW (#home) & PROFILES
   =========================== */
// Home remembers which category groups are open and which project is active, per browser.
const HOME_OPEN_KEY = 'loop.home.openGroups';
const ACTIVE_PROFILE_KEY = 'loop.activeProfile';
const HOME_SKILL_PREVIEW = 6; // skill rows shown in an unfolded category before "Show more"
const HM_SKILL_ICON = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M10 2.8l1.7 5.5 5.5 1.7-5.5 1.7L10 17.2l-1.7-5.5L2.8 10l5.5-1.7z"/></svg>';
const HM_LINK_ICON = '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.3 11.7l3.4-3.4"/><path d="M7 9.4l-1.9 1.9a2.7 2.7 0 0 0 3.8 3.8l1.9-1.9"/><path d="M13 10.6l1.9-1.9a2.7 2.7 0 0 0-3.8-3.8L9.2 6.8"/></svg>';
const HM_LOCK_ICON = '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="9" width="11" height="8" rx="2"/><path d="M7 9V7a3 3 0 0 1 6 0v2"/></svg>';
const HM_LAYERS_ICON = '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 7L10 3.5 16.5 7 10 10.5z"/><path d="M3.5 10.5L10 14l6.5-3.5"/><path d="M3.5 14L10 17.5l6.5-3.5"/></svg>';
const HM_FOLDER_ICON = '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M3 5.8A1.3 1.3 0 0 1 4.3 4.5h3.2l1.8 2h6.4A1.3 1.3 0 0 1 17 7.8v6.4a1.3 1.3 0 0 1-1.3 1.3H4.3A1.3 1.3 0 0 1 3 14.2z"/></svg>';
const HM_PLUS_ICON = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11"/></svg>';
const PF_UPDOWN_ICON = '<svg class="pf-chev" width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8l4-4 4 4M6 12l4 4 4-4"/></svg>';
const PF_ICON = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 7.5L10 4l6.5 3.5L10 11z"/><path d="M3.5 11L10 14.5l6.5-3.5"/><path d="M3.5 14.5L10 18l6.5-3.5"/></svg>';
const PF_CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>';
const PF_GEAR_ICON = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="2.5"/><path d="M10 3.2v1.6M10 15.2v1.6M3.2 10h1.6M15.2 10h1.6M5.2 5.2l1.1 1.1M13.7 13.7l1.1 1.1M14.8 5.2l-1.1 1.1M6.3 13.7l-1.1 1.1"/></svg>';
const chevron = (cls) => `<svg class="${cls}" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 8l5 5 5-5"/></svg>`;
const HM_GO_ICON = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 5l5 5-5 5"/></svg>';

// "3 min", "2 h", "4 d": short ages for Home's activity and requests.
function shortAgo(iso) {
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) return '';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

// Skills that share a first word ("remotion-render", "remotion-captions", …) fold into one family
// row on Home once three or more of them sit in the same category.
function skillEntries(list) {
  const byHead = new Map();
  for (const sk of list) {
    const head = String(sk.name || sk.id).split('-')[0];
    if (!byHead.has(head)) byHead.set(head, []);
    byHead.get(head).push(sk);
  }
  const out = [];
  for (const [head, items] of byHead) {
    if (items.length >= 3) out.push({ family: true, id: `fam:${head}`, name: head, items });
    else for (const sk of items) out.push({ family: false, id: sk.id, name: sk.name || sk.id, skill: sk });
  }
  return out;
}

const firstSentence = (text) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const cut = t.search(/[.!?](\s|$)/);
  return (cut > 0 ? t.slice(0, cut + 1) : t).slice(0, 160);
};
function readLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writeLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage off: Home still works, it just forgets */
  }
}

function loadSavedActiveProfile() {
  try {
    const raw = localStorage.getItem(ACTIVE_PROFILE_KEY);
    if (raw == null) return 'all';
    let val = raw;
    try { val = JSON.parse(raw); } catch { /* plain string */ }
    return typeof val === 'string' && val.trim() ? val.trim().toLowerCase() : 'all';
  } catch {
    return 'all';
  }
}

function setActiveProfile(id) {
  const clean = typeof id === 'string' && id.trim() ? id.trim().toLowerCase() : 'all';
  uiState.activeProfile = clean;
  try {
    localStorage.setItem(ACTIVE_PROFILE_KEY, clean);
  } catch {
    /* storage off */
  }
}

function extractProfileRecords(data) {
  if (Array.isArray(data?.profileRecords)) {
    return data.profileRecords
      .filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id && r.id !== 'all')
      .map((r) => ({
        id: r.id,
        name: String(r.name || r.id),
        icon: r.icon, color: r.color,
        description: String(r.description || ''),
        persisted: r.persisted !== false,
        createdAt: r.createdAt || null,
        updatedAt: r.updatedAt || null,
        counts: r.counts && typeof r.counts === 'object' ? r.counts : null,
      }));
  }
  if (Array.isArray(data?.profiles)) {
    return data.profiles
      .map((p) => String(p || '').trim().toLowerCase())
      .filter((p) => p && p !== 'all')
      .map((id) => ({ id, name: id, description: '', persisted: false, counts: null }));
  }
  return [];
}

function normalizeActiveProfile(profileRecords = []) {
  const cur = uiState.activeProfile || 'all';
  if (cur === 'all') return 'all';
  const list = Array.isArray(profileRecords) ? profileRecords : [];
  if (!list.some((r) => r && r.id === cur)) {
    setActiveProfile('all');
    return 'all';
  }
  return cur;
}

function profileNameOf(id, profileRecords = []) {
  const list = Array.isArray(profileRecords) ? profileRecords : [];
  if (!id || id === 'all') return 'All';
  const rec = list.find((r) => r && r.id === id);
  return rec?.name || id;
}

// Strict profile isolation: 'all' shows everything; a named profile shows ONLY items assigned to it.
function itemInActiveProfile(item, activeProfile = uiState.activeProfile) {
  return !activeProfile || activeProfile === 'all'
    || (Array.isArray(item?.profiles) && item.profiles.includes(activeProfile));
}

function profileCountSummary(counts) {
  if (!counts || typeof counts !== 'object') return '';
  const parts = [];
  if (Number(counts.connections) > 0) parts.push(`${counts.connections} conn`);
  if (Number(counts.secrets) > 0) parts.push(`${counts.secrets} vault`);
  else if (Number(counts.skills) > 0) parts.push(`${counts.skills} ${counts.skills === 1 ? 'skill' : 'skills'}`);
  if (parts.length < 2 && Number(counts.memories) > 0) parts.push(`${counts.memories} mem`);
  return parts.slice(0, 2).join(' · ');
}

// The open Profile Switcher menu closes on any click outside it; the active view registers its closer here.
let closeProfileMenu = null;
document.addEventListener('mousedown', (e) => {
  if (closeProfileMenu && !e.target.closest?.('.pf-wrap')) closeProfileMenu();
});

// The header every tab shares: a serif title and one line under it. Only Home puts Connect on the right.
// hideTitle keeps the title for screen readers only (the Library page shows no visible title).
function pageTop({ title, sub, right = '', hideTitle = false }) {
  return `
    <div class="lib-top">
      <div class="lib-top-c">
        <h1 class="${hideTitle ? 'sr-only' : 'lib-t'}">${esc(title)}</h1>
        ${sub ? `<p class="lib-sub">${sub}</p>` : ''}
      </div>
      ${right ? `<div class="lib-top-r">${right}</div>` : ''}
    </div>`;
}

// The side menu beside a scrolling list, as on Home: the page's name as its heading, then a line for
// each group of the list with its count.
// A side menu: the page's name, then the rows in the part that scrolls (.hm-rail-list).
function railHtml(items, label = 'On this page') {
  return `<div class="hm-rail-k">${esc(label)}</div><div class="hm-rail-list">${items.map((it) => `
    <button type="button" class="hm-jump ${it.count === 0 ? 'is-empty' : ''}" data-rail-jump="${esc(it.id)}" aria-current="false"><span>${esc(it.label)}</span>${it.count === undefined ? '' : `<span class="hm-jump-n">${esc(it.count)}</span>`}</button>`).join('')}</div>`;
}

// Clicking a line scrolls to its group; scrolling lights the group at the top of the list.
// Groups are the [data-rail-group] elements inside the scroller.
function wireSideRail(scroller, rail) {
  if (!scroller || !rail) return;
  const mark = (id) => rail.querySelectorAll('[data-rail-jump]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.railJump === id)));
  // Where a group sits in the scrolled list, wherever it is nested.
  const topOf = (el) => el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  const spy = () => {
    if (Date.now() < (scroller.railLockUntil || 0) || !scroller.clientHeight) return;
    const groups = [...scroller.querySelectorAll('[data-rail-group]')];
    if (!groups.length) return;
    let current = groups[0].dataset.railGroup;
    const atEnd = scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    if (atEnd) current = groups[groups.length - 1].dataset.railGroup;
    else for (const g of groups) if (topOf(g) <= scroller.scrollTop + 24) current = g.dataset.railGroup;
    mark(current);
  };
  rail.querySelectorAll('[data-rail-jump]').forEach((b) => b.addEventListener('click', () => {
    const target = scroller.querySelector(`[data-rail-group="${CSS.escape(b.dataset.railJump)}"]`);
    if (!target) return;
    scroller.railLockUntil = Date.now() + 900;
    mark(b.dataset.railJump);
    scroller.scrollTo({ top: topOf(target), behavior: 'smooth' });
  }));
  if (!scroller.railWired) {
    scroller.railWired = true;
    scroller.addEventListener('scroll', spy, { passive: true });
  }
  whenShown(scroller, spy);
}

// Runs fn once el is on screen. A page is drawn out of sight first; showView() tells it when it is shown.
function whenShown(el, fn) {
  if (el.clientHeight) return fn();
  el.closest('.view')?.addEventListener('view-shown', () => fn(), { once: true });
}

const profileIcons = { smile: '☻', star: '★', diamond: '◆', sun: '☀', leaf: '❧', briefcase: '▣' };
const profileColors = ['slate', 'blue', 'green', 'purple', 'rose', 'amber'];
function profileBadge(rec) {
  const glyph = rec && Object.hasOwn(profileIcons, rec.icon) ? profileIcons[rec.icon] : rec ? profileIcons.smile : PF_ICON;
  const color = profileColors.includes(rec?.color) ? rec.color : 'slate';
  return '<span aria-hidden="true" class="pf-badge pf-color-' + color + '">' + glyph + '</span>';
}

// Top-left Profile Switcher pill: Default = everything in Loop, named profiles are strictly scoped.
function profileSwitcherHtml(profileRecords = [], opts = {}) {
  const list = Array.isArray(profileRecords) ? profileRecords : [];
  const active = opts.normalize !== false && profileRecordsLoaded
    ? normalizeActiveProfile(list)
    : (uiState.activeProfile || 'all');
  const cats = switcherCats();
  const catPicked = cats.find((c) => c.id && c.id === uiState.homeCat) || null;
  // A category picked on narrow Home shows in the button, after the project when there is one.
  const activeLabel = catPicked ? catPicked.label : 'All';
  // The side column shows a letter tile and a quiet line under the name.
  const activeRec = list.find((rec) => rec.id === active);
  const agentCount = Number(activeRec?.counts?.agents) || 0;
  const activeSub = active === 'all'
    ? 'Everything in Loop'
    : agentCount > 0 ? `${agentCount} ${agentCount === 1 ? 'agent uses' : 'agents use'} it` : (profileCountSummary(activeRec?.counts) || 'Nothing in it yet');
  const activeBadge = profileBadge(activeRec);
  const pq = String(uiState.profileQuery || '').trim().toLowerCase();
  const shownCats = cats.filter((c) => !pq || c.label.toLowerCase().includes(pq));
  const catOptionHtml = (c) => {
    const selected = (uiState.homeCat || '') === c.id;
    return `<div class="pf-row" data-selected="${selected}">
      <button type="button" class="hm-opt pf-opt pf-cat ${c.warn ? 'is-warn' : ''}" role="menuitemradio" aria-checked="${selected}" data-pf-cat="${esc(c.id)}">
        <span class="hm-opt-name">${esc(c.label)}</span>${c.id ? `<span class="hm-jump-n">${esc(c.count)}</span>` : ''}<span class="pf-check" aria-hidden="true">${PF_CHECK_ICON}</span>
      </button>
    </div>`;
  };
  // Projects stay on the server only. The menu lists Home's categories.
  const findLabel = 'Find a category';
  const menu = uiState.profileMenu ? `
    <div class="hm-menu pf-menu" role="menu" aria-label="Categories">
      ${cats.length > 8 ? `<input type="search" class="hm-menu-q" id="pf-q" value="${esc(uiState.profileQuery || '')}" placeholder="${findLabel}" aria-label="${findLabel}" autocomplete="off">` : ''}
      <div class="hm-menu-k">Categories</div>
      ${shownCats.map(catOptionHtml).join('')}
      ${pq && !shownCats.length ? '<p class="hm-menu-empty">No category matches</p>' : ''}
    </div>` : '';
  return `
    <div class="pf-wrap">
      <button type="button" class="pf-btn ${catPicked ? 'has-cat' : ''}" id="pf-btn" aria-haspopup="menu" aria-expanded="${uiState.profileMenu}">
        <span class="pf-ic" aria-hidden="true">${activeBadge}</span>
        <span class="pf-tile" aria-hidden="true">${activeBadge}</span>
        <span class="pf-c"><span class="pf-name">${esc(activeLabel)}</span><span class="pf-sub">${esc(activeSub)}</span></span>
        ${PF_UPDOWN_ICON}
      </button>
      ${menu}
    </div>`;
}

function wireProfileSwitcher(root, profileRecords = [], { repaint, onChange = null, onMutated = null, ctx = agentPopupCtx() } = {}) {
  const closeMenu = (focusButton) => {
    uiState.profileMenu = false;
    uiState.profileQuery = '';
    closeProfileMenu = null;
    repaint?.();
    if (focusButton) root.querySelector('#pf-btn')?.focus();
  };
  closeProfileMenu = uiState.profileMenu ? () => closeMenu(false) : null;

  root.querySelector('#pf-btn')?.addEventListener('click', () => {
    if (uiState.profileMenu) return closeMenu(true);
    uiState.profileMenu = true;
    uiState.profileQuery = '';
    repaint?.();
    (root.querySelector('#pf-q') || root.querySelector('.pf-menu .pf-opt[aria-checked="true"]') || root.querySelector('.pf-menu .pf-opt'))?.focus();
  });

  root.querySelector('.pf-wrap .pf-menu')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu(true);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...root.querySelectorAll('.pf-menu button')];
    const at = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1);
    items[next]?.focus();
  });

  root.querySelector('#pf-q')?.addEventListener('input', (e) => {
    uiState.profileQuery = e.currentTarget.value;
    repaint?.();
    const input = root.querySelector('#pf-q');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });

  root.querySelectorAll('.pf-menu [data-pf-pick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.pfPick || 'all';
      const changed = id !== (uiState.activeProfile || 'all');
      uiState.profileMenu = false;
      uiState.profileQuery = '';
      closeProfileMenu = null;
      if (changed) {
        setActiveProfile(id);
        if (typeof onChange === 'function') onChange(id);
        else repaint?.();
      } else {
        repaint?.();
      }
      root.querySelector('#pf-btn')?.focus();
    });
  });

  root.querySelectorAll('.pf-menu [data-pf-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      uiState.profileMenu = false;
      uiState.profileQuery = '';
      closeProfileMenu = null;
      const id = btn.dataset.pfCat || '';
      if (id !== (uiState.homeCat || '') && homeCatPick) homeCatPick(id);
      else repaint?.();
      root.querySelector('#pf-btn')?.focus();
    });
  });

  root.querySelector('[data-pf-new]')?.addEventListener('click', () => {
    uiState.profileMenu = false;
    uiState.profileQuery = '';
    closeProfileMenu = null;
    repaint?.();
    openNewProfileDialog({
      onCreated: (created) => {
        if (created?.id) {
        latestProfileRecords = [...latestProfileRecords.filter((p) => p && p.id !== created.id), created];
        setActiveProfile(created.id);
      }
        if (typeof onMutated === 'function') onMutated(created?.id || uiState.activeProfile);
        else render();
      },
    });
  });

  const menu = root.querySelector('.pf-menu');
  const changed = () => onMutated ? onMutated(uiState.activeProfile) : render();
  root.querySelectorAll('[data-pf-more]').forEach((trigger) => trigger.addEventListener('click', () => {
    const rec = profileRecords.find((p) => p.id === trigger.dataset.pfMore);
    if (!rec || rec.id === 'all') return;
    const wasOpen = trigger.getAttribute('aria-expanded') === 'true';
    root.querySelector('.pf-actions')?.remove();
    root.querySelectorAll('[data-pf-more]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    if (wasOpen) return;
    trigger.setAttribute('aria-expanded', 'true');
    const panel = document.createElement('div');
    panel.className = 'pf-actions';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', 'Options for ' + rec.name);
    menu.after(panel);
    const dismiss = () => { panel.remove(); trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); };
    const place = () => {
      const bounds = menu.getBoundingClientRect(), row = trigger.getBoundingClientRect();
      const w = panel.offsetWidth, h = panel.offsetHeight;
      panel.style.left = panel.style.top = '0px';
      const origin = panel.getBoundingClientRect();
      panel.style.left = (Math.max(6, bounds.left > w + 6 ? bounds.left - w + 2 : Math.min(innerWidth - w - 6, bounds.right - 2)) - origin.left) + 'px';
      panel.style.top = (Math.max(6, Math.min(innerHeight - h - 6, row.top)) - origin.top) + 'px';
    };
    const actions = [['name', 'Edit name', '✎'], ['icon', 'Change Icon', '☻'], ['color', 'Change Color', '◉'], ['settings', 'Settings', PF_GEAR_ICON], ['delete', 'Delete project', '×']];
    panel.innerHTML = actions.map(([key, label, glyph]) => `<button type="button" role="menuitem" data-action="${key}"><span aria-hidden="true">${glyph}</span>${label}${['color','icon'].includes(key) ? HM_GO_ICON : ''}</button>`).join('');
    place(); panel.querySelector('button').focus({ preventScroll: true });
    panel.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); dismiss(); }
      if (!['ArrowUp','ArrowDown'].includes(e.key)) return;
      const buttons = [...panel.querySelectorAll('button')];
      e.preventDefault(); buttons[(buttons.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    });
    const save = async (key, value) => {
      if (panel.dataset.saving) return;
      panel.dataset.saving = '1';
      try {
        await api('/api/profiles/' + encodeURIComponent(rec.id), { method: 'PATCH', body: JSON.stringify({ [key]: value }) });
        closeMenu(true); changed();
      } catch (err) { delete panel.dataset.saving; toast(err.message, 'err'); }
    };
    panel.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const key = b.dataset.action;
      if (b.dataset.choice) return save(panel.dataset.field, b.dataset.choice);
      if (key === 'settings' || key === 'delete') {
        closeMenu(false); openProfileManager(rec.id, { ctx, section: 'settings', armDelete: key === 'delete', onChanged: changed });
      } else if (key === 'name') {
        panel.innerHTML = `<form><label>Edit name<input required name="name" value="${esc(rec.name)}"></label><button type="submit">Save name</button></form>`;
        panel.querySelector('form').onsubmit = ev => { ev.preventDefault(); const name = ev.target.elements.name.value.trim(); if (name) save('name', name); };
        panel.querySelector('input').select(); place();
      } else if (key === 'icon' || key === 'color') {
        panel.dataset.field = key;
        const values = key === 'icon' ? Object.keys(profileIcons) : profileColors;
        panel.innerHTML = values.map(v => `<button type="button" role="menuitemradio" aria-checked="${v === (rec[key] || values[0])}" data-choice="${v}">${profileBadge({ ...rec, [key]: v })}${v[0].toUpperCase() + v.slice(1)}</button>`).join('');
        place(); panel.querySelector('button').focus();
      }
    });
  }));
}

// The Profile Switcher is only on Home: in the side column beside the page title, above the side
// menu, on windows wide enough to show it; on narrower ones it is in the header.
const SIDE_MQ = typeof matchMedia === 'function' ? matchMedia('(min-width: 980px)') : null;

// Every page's side menu. On wide windows the side column above it holds Loop and the profile.
// Home's side menu is not one: wide windows hide it (category pills take its place), so it never
// gets the switcher. Leave it out everywhere, or the check below keeps redrawing the switcher.
function sideRails() {
  return [...document.querySelectorAll('#main .view .hm-rail')].filter((rail) => !rail.closest('.hm-home'));
}

function onHome() {
  return parseRoute().section === 'home';
}

function profileSideHosts() {
  if (!SIDE_MQ?.matches) return [];
  return sideRails().map((rail) => {
    let host = rail.previousElementSibling;
    if (!host?.classList.contains('pf-side')) {
      host = document.createElement('div');
      host.className = 'pf-side';
      rail.before(host);
    }
    return host;
  });
}

// The switcher sits at the bottom of the side column; CSS places it, so clear any old inline spot.
function placeProfileSide(host) {
  host.style.top = '';
}

function syncTopChrome(profileRecords, { loaded = false, force = false } = {}) {
  if (Array.isArray(profileRecords)) {
    latestProfileRecords = profileRecords;
    if (loaded) profileRecordsLoaded = true;
  }
  const profileSlot = document.getElementById('top-profile-slot');
  const backEl = document.getElementById('back');
  if (!auth.signedIn || oauthTxId) {
    if (profileSlot) profileSlot.hidden = true;
    document.querySelectorAll('.pf-side').forEach((el) => { el.innerHTML = ''; });
    return;
  }
  const sideHosts = switcherCats().length ? profileSideHosts() : [];
  if (!SIDE_MQ?.matches || !sideHosts.length) document.querySelectorAll('.pf-side').forEach((el) => { el.innerHTML = ''; });
  // The switcher picks a Home category on narrow screens. With no categories to pick, it stays hidden.
  const wanted = switcherCats().length > 0;
  const showInHeader = wanted && sideHosts.length === 0 && (!backEl || backEl.hidden);
  if (profileSlot) {
    profileSlot.hidden = !showInHeader;
    if (!showInHeader) profileSlot.innerHTML = '';
  }
  if (!showInHeader && sideHosts.length === 0) {
    if (uiState.profileMenu) {
      uiState.profileMenu = false;
      uiState.profileQuery = '';
      closeProfileMenu = null;
    }
    return;
  }
  const hosts = showInHeader ? [profileSlot].filter(Boolean) : sideHosts;
  const wasBtnFocused = document.activeElement?.id === 'pf-btn';
  for (const host of hosts) {
    if (uiState.profileMenu && !force && host.childElementCount > 0) continue;
    host.innerHTML = profileSwitcherHtml(latestProfileRecords);
    wireProfileSwitcher(host, latestProfileRecords, {
      repaint: () => syncTopChrome(latestProfileRecords, { force: true }),
      onChange: () => {
        uiState.homeJump = null;
        syncTopChrome(latestProfileRecords, { force: true });
        render();
      },
      onMutated: () => {
        syncTopChrome(latestProfileRecords, { force: true });
        render();
      },
    });
    if (host.classList.contains('pf-side')) placeProfileSide(host);
    if (wasBtnFocused && !uiState.profileMenu) host.querySelector('#pf-btn')?.focus({ preventScroll: true });
  }
}

// Pages draw their side menus after the header is synced, so place the switcher when one appears,
// and move it between the side column and the header as the window crosses the breakpoint.
if (typeof MutationObserver === 'function') {
  let pending = false;
  new MutationObserver(() => {
    if (pending || !SIDE_MQ?.matches || !auth.signedIn || oauthTxId) return;
    if (!switcherCats().length) return; // no switcher on wide screens now that projects are hidden
    const rails = sideRails();
    const missing = rails.some((rail) => !rail.previousElementSibling?.classList.contains('pf-side') || !rail.previousElementSibling.childElementCount);
    // A page without a side menu replaced one that had it: the switcher goes back to the header.
    const slot = document.getElementById('top-profile-slot');
    const back = document.getElementById('back');
    const stranded = (rails.length === 0 && onHome() && slot?.hidden && (!back || back.hidden))
      || (!onHome() && slot && !slot.hidden);
    if (!missing && !stranded) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      syncTopChrome(latestProfileRecords, { force: true });
    });
  }).observe(document.getElementById('main') || document.body, { childList: true, subtree: true });
}
SIDE_MQ?.addEventListener?.('change', () => {
  syncTopChrome(latestProfileRecords, { force: true });
  approvalsOnHome?.(); // Home: the side menu and every category, or the switcher and one category
});

// Wide windows: every tab's side menu is one box of the same height (SIDE_MENU_HEIGHT, less in a
// short window), centred between the line of the search box (SIDE_MENU_TOP under where the page
// starts) and the profile. Its heading stays in place from tab to tab, and a longer list scrolls
// under the heading. The profile at the bottom is centred on the nav pill's row.
const SIDE_MENU_TOP = 28;
const SIDE_MENU_HEIGHT = 440;
const SIDE_MENU_GAP = 16; // clear space between the menu's box and the profile
function alignSideColumn() {
  for (const rail of sideRails()) {
    const host = rail.previousElementSibling?.classList.contains('pf-side') ? rail.previousElementSibling : null;
    if (!SIDE_MQ?.matches) {
      rail.style.top = '';
      rail.style.height = '';
      if (host) host.style.bottom = '';
      continue;
    }
    const nav = document.querySelector('.nav:not([hidden])');
    if (host?.offsetParent) watchSideBox(host.offsetParent);
    if (host?.childElementCount && nav) {
      const n = nav.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      const delta = (n.top + n.height / 2) - (h.top + h.height / 2);
      if (h.height && Math.abs(delta) >= 0.5) host.style.bottom = `${Math.round(parseFloat(getComputedStyle(host).bottom) - delta)}px`;
    }
    const view = rail.closest('.view');
    if (!view) continue;
    const start = view.getBoundingClientRect().top + SIDE_MENU_TOP;
    const below = (host?.childElementCount ? host : nav)?.getBoundingClientRect();
    const end = (below?.height ? below.top : window.innerHeight) - SIDE_MENU_GAP;
    const height = Math.round(Math.max(Math.min(SIDE_MENU_HEIGHT, end - start), 0));
    if (rail.style.height !== `${height}px`) rail.style.height = `${height}px`;
    const want = start + Math.max(0, (end - start - height) / 2);
    const top = rail.getBoundingClientRect().top;
    if (Math.abs(want - top) >= 0.5) rail.style.top = `${Math.round(parseFloat(getComputedStyle(rail).top) + want - top)}px`;
    markSideScroll(rail);
  }
}
// What a side menu's list hides: app.css fades an edge with rows past it (data-more), and a small
// button at the bottom counts the rows below and scrolls to them.
const SIDE_NEXT_ARROW = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2.5v7M3 6.5l3 3 3-3"/></svg>';
function markSideScroll(rail) {
  const list = rail.querySelector(':scope > .hm-rail-list');
  let next = rail.querySelector(':scope > .hm-rail-next');
  if (!list) {
    next?.remove();
    return;
  }
  const up = list.scrollTop > 1;
  const down = list.scrollTop + list.clientHeight < list.scrollHeight - 1;
  const more = [up ? 'up' : '', down ? 'down' : ''].filter(Boolean).join(' ');
  if ((rail.dataset.more || '') !== more) rail.dataset.more = more;
  if (!next) {
    next = document.createElement('button');
    next.type = 'button';
    next.className = 'hm-rail-next';
    next.innerHTML = `${SIDE_NEXT_ARROW}<span></span>`;
    next.addEventListener('click', () => {
      const to = rail.querySelector(':scope > .hm-rail-list');
      to?.scrollBy({ top: Math.max(60, to.clientHeight - 90), behavior: reducedMotion?.matches ? 'auto' : 'smooth' });
    });
    rail.append(next);
  }
  // A row counts as below when the button and the fade cover its middle.
  const edge = list.getBoundingClientRect().bottom - 30;
  const hidden = down ? [...list.querySelectorAll('.hm-jump')].filter((row) => {
    const r = row.getBoundingClientRect();
    return r.height && r.top + r.height / 2 > edge;
  }).length : 0;
  const label = `${hidden} more`;
  if (hidden && next.lastElementChild.textContent !== label) next.lastElementChild.textContent = label;
  if (next.hidden !== !hidden) next.hidden = !hidden;
}
// The selected row of each side menu is in view when its page opens.
function showSideCurrent() {
  for (const rail of sideRails()) {
    const list = rail.querySelector(':scope > .hm-rail-list');
    const row = list?.querySelector('.hm-jump[aria-current=true]');
    if (!row || !list.clientHeight) continue;
    const l = list.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.top < l.top + 8) list.scrollTop += r.top - l.top - 8;
    else if (r.bottom > l.bottom - 40) list.scrollTop += r.bottom - l.bottom + 40;
    markSideScroll(rail);
  }
}
// Scroll events do not bubble; the capture phase sees each menu's, also after a page redraws it.
document.addEventListener('scroll', (e) => {
  if (e.target instanceof Element && e.target.matches('.hm-rail-list')) markSideScroll(e.target.parentElement);
}, { capture: true, passive: true });
let queueAlign = () => {};
// A page's box can change height after it draws (content loading in), which moves the profile
// without any new elements; re-check when it does.
const sideBoxObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => queueAlign()) : null;
const watchedSideBoxes = new WeakSet();
function watchSideBox(el) {
  if (!sideBoxObserver || watchedSideBoxes.has(el)) return;
  watchedSideBoxes.add(el);
  sideBoxObserver.observe(el);
}
if (typeof MutationObserver === 'function') {
  let queued = false;
  queueAlign = () => {
    if (queued) return;
    queued = true;
    // Hidden pages get no animation frames, and live updates can still change the menu then.
    const later = document.hidden ? (fn) => setTimeout(fn, 0) : requestAnimationFrame;
    later(() => { queued = false; alignSideColumn(); });
  };
  new MutationObserver(queueAlign).observe(document.getElementById('main') || document.body, { childList: true, subtree: true, characterData: true });
  addEventListener('resize', queueAlign);
  document.fonts?.ready?.then(queueAlign);
}

function openNewProfileDialog({ onCreated, managerOpens = false } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = 'loop-dialog pf-dialog';
  dlg.setAttribute('aria-labelledby', 'pf-new-title');
  dlg.innerHTML = `
    <div class="cat-add-head">
      <h3 id="pf-new-title">New project</h3>
      <button type="button" class="btn sm ghost" data-pf-cancel>Cancel</button>
    </div>
    <div class="sub">Choose the connections to include in this project.</div>
    <form class="form-grid" data-pf-new-form>
      <label class="field">
        <span class="lbl">Name</span>
        <input name="name" type="text" required maxlength="60" placeholder="e.g. Video research, Development" autocomplete="off">
      </label>
      <div class="field pf-new-conns" data-pf-new-conns><span class="lbl">Your connections</span><p class="d sm">Loading…</p></div>
      <div class="acts">
        <button type="submit" class="btn fill">Create project</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  mountContextGuide(dlg.querySelector('.sub'), api, 'setup-project', 'Project setup guide');
  dlg.querySelector('[data-pf-cancel]').onclick = () => dlg.close();
  let newProfileMcps = [];
  api('/api/mcps').then((res) => {
    newProfileMcps = (Array.isArray(res?.mcps) ? res.mcps : []).slice().sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
    const box = dlg.querySelector('[data-pf-new-conns]');
    if (!box) return;
    box.innerHTML = `<span class="lbl">Your connections <span class="pf-new-count" data-pf-new-count>0 on</span></span>${newProfileMcps.length
      ? `<div class="pf-new-list">${newProfileMcps.map((m) => `
        <label class="pf-new-row"><span class="pf-new-n">${esc(m.name || m.id)}</span>
          <input type="checkbox" class="pf-new-sw" role="switch" data-pf-new-conn="${esc(m.id)}"></label>`).join('')}</div>`
      : '<p class="d sm">No connections in Loop yet. You can add them to this project later.</p>'}`;
    box.addEventListener('change', () => {
      const n = box.querySelectorAll('[data-pf-new-conn]:checked').length;
      const c = box.querySelector('[data-pf-new-count]');
      if (c) c.textContent = `${n} on`;
    });
  }).catch(() => {
    const box = dlg.querySelector('[data-pf-new-conns]');
    if (box) box.remove();
  });
  dlg.querySelector('[data-pf-new-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    const description = String(fd.get('description') || '').trim();
    if (!name) {
      toast('Give the project a name.', 'err');
      form.querySelector('input[name="name"]')?.focus();
      return;
    }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const res = await api('/api/profiles', {
        method: 'POST',
        body: JSON.stringify({ name, ...(description ? { description } : {}) }),
      });
      const created = res?.profile || null;
      const picked = [...dlg.querySelectorAll('[data-pf-new-conn]:checked')].map((el) => el.dataset.pfNewConn);
      if (created?.id && picked.length) {
        btn.textContent = 'Adding connections…';
        await Promise.all(picked.map(async (id) => {
          const m = newProfileMcps.find((x) => x.id === id);
          const tags = new Set((Array.isArray(m?.profiles) ? m.profiles : []).filter((t) => t && t !== 'all'));
          tags.add(created.id);
          await api(`/api/mcps/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ profiles: ['all', ...[...tags].sort()] }),
          }).catch((err) => toast(err.message, 'err'));
        }));
      }
      if (created?.id) {
        latestProfileRecords = [...latestProfileRecords.filter((p) => p && p.id !== created.id), created];
        setActiveProfile(created.id);
      }
      dlg.close();
      toast(`Created project "${created?.name || name}".`, 'ok');
      onCreated?.(created);
      if (created?.id && !managerOpens) openProfileManager(created.id, { section: 'items', onChanged: () => render() });
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
      btn.textContent = 'Create project';
    }
  });
  dlg.showModal();
  dlg.querySelector('input[name="name"]')?.focus();
}

function openProfileManager(initialProfileId = '', { onChanged, ctx = agentPopupCtx(), section = 'items', armDelete = false } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = 'loop-dialog pf-mgr-dialog';
  dlg.setAttribute('aria-labelledby', 'pf-mgr-title');
  dlg.innerHTML = '<div class="loading" role="status"><div class="spin" aria-hidden="true"></div><p>Loading projects…</p></div>';
  document.body.appendChild(dlg);

  let profiles = [];
  let agentData = { agents: [], connected: [] };
  let localFolderManagement = false;
  let allMcps = [];
  let allSkills = [];
  let allSecrets = [];
  let selectedId = initialProfileId && initialProfileId !== 'all' ? initialProfileId : '';
  let activeSec = ['items', 'keys', 'settings'].includes(section) ? section : 'items';
  let itemQuery = '';
  let confirmDelete = armDelete;
  let changed = false;

  dlg.addEventListener('close', () => {
    dlg.remove();
    if (changed) onChanged?.();
  });

  const inProfile = (item, profileId) => Array.isArray(item?.profiles) && item.profiles.includes(profileId);

  function recomputeCounts(rec) {
    if (!rec) return;
    rec.counts = {
      ...(rec.counts && typeof rec.counts === 'object' ? rec.counts : {}),
      connections: allMcps.filter((m) => inProfile(m, rec.id)).length,
      skills: allSkills.filter((s) => inProfile(s, rec.id)).length,
      secrets: allSecrets.filter((s) => inProfile(s, rec.id)).length,
    };
  }

  function countLine(counts) {
    if (!counts || typeof counts !== 'object') return '';
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    return [
      plural(Number(counts.connections) || 0, 'connection', 'connections'),
      plural(Number(counts.skills) || 0, 'skill', 'skills'),
      plural(Number(counts.memories) || 0, 'memory', 'memories'),
      plural(Number(counts.secrets) || 0, 'secret', 'secrets'),
    ].join(' · ');
  }

  function itemsPaneHtml(rec) {
    const q = itemQuery.trim().toLowerCase();
    const totalCount = allMcps.length + allSkills.length + allSecrets.length;
    if (totalCount === 0) {
      return '<p class="d sm">No connections, skills, or Vault secrets in Loop yet. Add one first, then assign it to projects here.</p>';
    }
    const connHits = allMcps.filter((m) => !q || `${m.name || ''} ${m.id || ''} ${m.categoryLabel || ''}`.toLowerCase().includes(q));
    const skillHits = allSkills.filter((s) => !q || `${s.name || ''} ${s.id || ''} ${s.categoryLabel || ''}`.toLowerCase().includes(q));
    const secretHits = allSecrets.filter((s) => !q || `${s.key || ''} ${s.description || ''} ${s.category || ''}`.toLowerCase().includes(q));
    const anyMatch = connHits.length + skillHits.length + secretHits.length > 0;

    const groupHtml = (title, items, renderItem) => (items.length === 0 ? '' : `
      <div class="pf-mgr-items-group">${esc(title)} <span>${esc(items.length)}</span></div>
      ${items.map(renderItem).join('')}`);

    return `
      <p class="d sm">Pick which Connections, Skills, and Vault secrets belong to <strong>${esc(rec.name)}</strong>. Changes save immediately.</p>
      ${totalCount > 8 ? `<input type="search" class="pf-mgr-search" id="pf-mgr-item-q" value="${esc(itemQuery)}" placeholder="Filter items…" aria-label="Filter items in All" autocomplete="off">` : ''}
      <div class="pf-mgr-items" id="pf-mgr-items">
        ${!anyMatch ? '<p class="d sm pf-mgr-items-empty">Nothing matches that filter.</p>' : `
          ${groupHtml('Connections', connHits, (m) => `
            <label class="pf-mgr-item">
              <input type="checkbox" data-pf-item-kind="conn" data-pf-item-id="${esc(m.id)}" ${inProfile(m, rec.id) ? 'checked' : ''}>
              <span class="pf-mgr-item-n">${esc(m.name || m.id)}</span>
              ${m.categoryLabel ? `<span class="pf-mgr-item-m">${esc(m.categoryLabel)}</span>` : ''}
            </label>`)}
          ${groupHtml('Skills', skillHits, (s) => `
            <label class="pf-mgr-item">
              <input type="checkbox" data-pf-item-kind="skill" data-pf-item-id="${esc(s.id)}" ${inProfile(s, rec.id) ? 'checked' : ''}>
              <span class="pf-mgr-item-n">${esc(s.name || s.id)}</span>
              ${s.categoryLabel ? `<span class="pf-mgr-item-m">${esc(s.categoryLabel)}</span>` : ''}
            </label>`)}
          ${groupHtml('Vault secrets', secretHits, (s) => {
            const type = normalizeVaultType(s.type);
            const label = type === 'payment' && s.description ? s.description : s.key;
            const meta = VAULT_TYPE_META[type]?.label || '';
            return `
              <label class="pf-mgr-item">
                <input type="checkbox" data-pf-item-kind="vault" data-pf-item-id="${esc(s.key)}" ${inProfile(s, rec.id) ? 'checked' : ''}>
                <span class="pf-mgr-item-n">${esc(label)}</span>
                ${meta ? `<span class="pf-mgr-item-m">${esc(meta)}</span>` : ''}
              </label>`;
          })}
        `}
      </div>`;
  }

  function keysPaneHtml(rec, profileAgents) {
    return `
      <div class="pf-mgr-sec-head">
        <h4>Connected MCP keys</h4>
        <div class="acts">
          <button type="button" class="btn sm ghost" data-pf-mgr-copy-invite>Copy invite link</button>
          <button type="button" class="btn sm fill" data-pf-mgr-connect>+ Connect to ${esc(rec.name)}</button>
        </div>
      </div>
      ${profileAgents.length === 0 ? `
        <p class="d sm">No MCP keys locked to ${esc(rec.name)} yet. Connect an agent to give it isolated access to this project.</p>
      ` : `
        <ul class="pf-key-list">
          ${profileAgents.map((row) => {
            const st = agentStatus(row);
            return `
              <li>
                <button type="button" class="pf-key-row ${row.agent?.enabled === false ? 'is-off' : ''}" data-pf-mgr-agent="${esc(row.id)}">
                  ${agentMark(row, esc, 'pf-key-av')}
                  <span class="pf-key-c">
                    <span class="pf-key-n">${esc(row.name)}</span>
                    <span class="pf-key-st ${st.cls === 'ok' ? 'is-ok' : ''}">${esc(st.text)}</span>
                  </span>
                  <span class="chev" aria-hidden="true">&rsaquo;</span>
                </button>
              </li>`;
          }).join('')}
        </ul>
      `}`;
  }

  async function renderWorkingFolder(box, projectId) {
    const route = '/api/profiles/' + encodeURIComponent(projectId) + '/folder';
    try {
      const folder = await api(route);
      if (!box.isConnected) return;
      const attached = folder.status === 'attached';
      box.innerHTML = `<form class="form-grid">
        <p class="d sm" role="status">${attached ? 'Attached on this device.' : folder.status === 'unavailable' ? 'Folder moved or unavailable. Reattach it to use it again.' : 'No folder attached.'}</p>
        <label class="field"><span class="lbl">Folder path on this device</span>
          <input name="folderPath" type="text" required maxlength="4096" spellcheck="false" autocomplete="off" value="${esc(folder.path || '')}" placeholder="~/Documents/my-project"></label>
        <div class="acts"><button class="btn sm" type="submit">${attached ? 'Update folder' : 'Attach folder'}</button>
          ${folder.status !== 'none' ? '<button type="button" class="btn sm ghost" data-detach>Detach</button>' : ''}</div>
      </form>`;
      const form = box.querySelector('form');
      const save = async (method) => {
        const buttons = form.querySelectorAll('button');
        buttons.forEach(b => { b.disabled = true; });
        try {
          await api(route, { method, ...(method === 'PUT' ? { body: JSON.stringify({ path: form.elements.folderPath.value }) } : {}) });
          if (box.isConnected) await renderWorkingFolder(box, projectId);
        } catch (err) {
          if (box.isConnected) toast(err.message, 'err');
        } finally { buttons.forEach(b => { b.disabled = false; }); }
      };
      form.addEventListener('submit', (event) => { event.preventDefault(); save('PUT'); });
      form.querySelector('[data-detach]')?.addEventListener('click', () => save('DELETE'));
    } catch { box.textContent = 'Could not load this device’s folder settings. Reopen Settings to retry.'; }
  }

  function settingsPaneHtml(rec) {
    return `
      <form class="form-grid pf-mgr-form" data-pf-mgr-edit>
        <label class="field">
          <span class="lbl">Name</span>
          <input name="name" type="text" required maxlength="60" value="${esc(rec.name)}" autocomplete="off">
        </label>
        <label class="field">
          <span class="lbl">Description (optional)</span>
          <input name="description" type="text" maxlength="200" value="${esc(rec.description || '')}" placeholder="What belongs in this project" autocomplete="off">
        </label>
        <div class="acts">
          <button type="submit" class="btn sm fill">Save changes</button>
        </div>
      </form>

      ${localFolderManagement ? `<section class="pf-mgr-sec" aria-label="Working folder">
        <h4>Working folder</h4>
        <p class="d sm">Local agents can use this folder when working on this project. Attaching it doesn't share files or grant permissions.</p>
        ${rec.persisted ? '<div data-pf-folder role="group" aria-label="Local folder attachment">Loading folder…</div>' : '<p class="d sm">Save this project first to attach a folder.</p>'}
      </section>` : ''}

      <section class="pf-mgr-sec pf-mgr-danger" aria-label="Delete project">
        <h4>Delete project</h4>
        <p class="d sm">Items in ${esc(rec.name)} won’t be deleted from All, and any MCP keys locked to ${esc(rec.name)} will be turned off.</p>
        ${confirmDelete ? `
          <div class="callout bad pf-mgr-confirm" role="alert">
            <p>Delete <strong>${esc(rec.name)}</strong>? Any MCP keys locked to it will stop working right away.</p>
            <div class="acts">
              <button type="button" class="btn sm danger" data-pf-mgr-del-confirm>Delete ${esc(rec.name)}</button>
              <button type="button" class="btn sm ghost" data-pf-mgr-del-cancel>Cancel</button>
            </div>
          </div>
        ` : `
          <div class="acts">
            <button type="button" class="btn sm danger-outline" data-pf-mgr-del-arm>Delete ${esc(rec.name)}</button>
          </div>
        `}
      </section>`;
  }

  function paintDialog() {
    if (!dlg.isConnected) return;
    const prevScroll = dlg.querySelector('#pf-mgr-items')?.scrollTop ?? 0;
    if (!selectedId || !profiles.some((p) => p.id === selectedId)) {
      selectedId = profiles[0]?.id || '';
      confirmDelete = false;
    }
    const rec = profiles.find((p) => p.id === selectedId) || null;
    const allAgentRows = agentRows(
      Array.isArray(agentData.agents) ? agentData.agents : [],
      Array.isArray(agentData.connected) ? agentData.connected : [],
    );
    const profileAgents = rec
      ? allAgentRows.filter((row) => row.agent && row.agent.profile === rec.id)
      : [];

    dlg.innerHTML = `
      <div class="cat-add-head">
        <h3 id="pf-mgr-title">${rec ? esc(rec.name) : 'Manage projects'}</h3>
        <div class="pf-mgr-head-acts">
          ${rec && rec.id !== 'all' ? `<button type="button" class="btn sm fill" data-pf-mgr-connect>Connect</button>
          ${auth.mode === 'clerk' && auth.workspace === 'personal' ? '<button type="button" class="btn sm" data-pf-mgr-share>Share</button>' : ''}` : ''}
          <button type="button" class="btn sm" data-pf-mgr-new>+ New project</button>
          <button type="button" class="btn sm ghost" data-pf-mgr-close>Done</button>
        </div>
      </div>
      ${profiles.length === 0 ? `
        <div class="empty">
          <p class="et">No projects yet</p>
          <p class="ed">Create a project to keep Connections, Skills, Memory, and Vault strictly isolated.</p>
          <div class="acts">
            <button type="button" class="btn sm fill" data-pf-mgr-new>Create project</button>
          </div>
        </div>
      ` : `
        ${profiles.length > 1 ? `
          <div class="pf-mgr-tabs" role="tablist" aria-label="Projects">
            ${profiles.map((p) => `<button type="button" class="pf-mgr-tab" role="tab" aria-selected="${p.id === rec.id}" data-pf-mgr-tab="${esc(p.id)}">${esc(p.name)}</button>`).join('')}
          </div>
        ` : ''}
        ${rec.counts ? `<p class="pf-mgr-counts" id="pf-mgr-counts">${esc(countLine(rec.counts))}</p>` : ''}
        <div class="seg pf-mgr-sec-tabs" role="tablist" aria-label="Project sections">
          <button type="button" class="seg-btn" role="tab" data-pf-mgr-sec="items" aria-selected="${activeSec === 'items'}" aria-pressed="${activeSec === 'items'}">Items</button>
          <button type="button" class="seg-btn" role="tab" data-pf-mgr-sec="keys" aria-selected="${activeSec === 'keys'}" aria-pressed="${activeSec === 'keys'}">Keys${profileAgents.length ? ` (${esc(profileAgents.length)})` : ''}</button>
          <button type="button" class="seg-btn" role="tab" data-pf-mgr-sec="settings" aria-selected="${activeSec === 'settings'}" aria-pressed="${activeSec === 'settings'}">Settings</button>
        </div>
        <div class="pf-mgr-body">
          ${activeSec === 'items'
            ? itemsPaneHtml(rec)
            : activeSec === 'keys'
              ? keysPaneHtml(rec, profileAgents)
              : settingsPaneHtml(rec)}
        </div>
      `}
    `;

    const folderBox = dlg.querySelector('[data-pf-folder]');
    if (folderBox && rec) renderWorkingFolder(folderBox, rec.id);
    const itemsBox = dlg.querySelector('#pf-mgr-items');
    if (itemsBox && prevScroll) itemsBox.scrollTop = prevScroll;

    dlg.querySelector('[data-pf-mgr-close]')?.addEventListener('click', () => dlg.close());
    dlg.querySelectorAll('[data-pf-mgr-connect]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!rec) return;
        const profileId = rec.id;
        const profileName = rec.name;
        dlg.close();
        openConnectFlow({
          ...ctx,
          onClose: (didChange) => {
            if (didChange) onChanged?.();
          },
        }, { profile: profileId, profileName });
      });
    });
    dlg.querySelector('[data-pf-mgr-copy-invite]')?.addEventListener('click', async () => {
      if (!rec) return;
      try {
        const res = await api(`/api/profiles/${encodeURIComponent(rec.id)}/invite`);
        await copyText(res.inviteUrl || `${location.origin}/mcp?project=${encodeURIComponent(rec.id)}`, `Invite link for ${rec.name} copied.`);
      } catch {
        await copyText(`${location.origin}/mcp?project=${encodeURIComponent(rec.id)}`, `Invite link for ${rec.name} copied.`);
      }
    });
    dlg.querySelector('[data-pf-mgr-share]')?.addEventListener('click', () => {
      openShareSheet({ api, esc, toast, ownerName: clerk?.user?.firstName || clerk?.user?.fullName || '' }, { profileId: rec.id, profileName: rec.name });
    });
    dlg.querySelectorAll('[data-pf-mgr-new]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const hadChanges = changed;
        changed = false; // prevent double callback before reopening
        dlg.close();
        openNewProfileDialog({
          managerOpens: true,
          onCreated: (created) => {
            if (created?.id) {
        latestProfileRecords = [...latestProfileRecords.filter((p) => p && p.id !== created.id), created];
        setActiveProfile(created.id);
      }
            onChanged?.();
            if (created?.id) {
              openProfileManager(created.id, { section: 'items', ctx, onChanged });
            } else if (hadChanges) {
              onChanged?.();
            }
          },
        });
      });
    });
    dlg.querySelectorAll('[data-pf-mgr-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedId = btn.dataset.pfMgrTab;
        confirmDelete = false;
        paintDialog();
      });
    });
    dlg.querySelectorAll('[data-pf-mgr-sec]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeSec = btn.dataset.pfMgrSec;
        confirmDelete = false;
        paintDialog();
      });
    });

    const itemSearchInput = dlg.querySelector('#pf-mgr-item-q');
    itemSearchInput?.addEventListener('input', (e) => {
      itemQuery = e.currentTarget.value;
      paintDialog();
      const nextInput = dlg.querySelector('#pf-mgr-item-q');
      if (nextInput) {
        nextInput.focus();
        nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
      }
    });

    dlg.querySelectorAll('[data-pf-item-kind]').forEach((box) => {
      box.addEventListener('change', async () => {
        if (!rec) return;
        const kind = box.dataset.pfItemKind;
        const id = box.dataset.pfItemId;
        const add = box.checked;
        const item = kind === 'conn'
          ? allMcps.find((m) => m.id === id)
          : kind === 'skill'
            ? allSkills.find((s) => s.id === id)
            : allSecrets.find((s) => s.key === id);
        if (!item) return;

        const nextSet = new Set((Array.isArray(item.profiles) ? item.profiles : []).filter((p) => p && p !== 'all'));
        if (add) nextSet.add(rec.id);
        else nextSet.delete(rec.id);
        const sorted = Array.from(nextSet).sort((a, b) => a.localeCompare(b));
        const nextProfiles = kind === 'conn'
          ? ['all', ...sorted]
          : (sorted.length > 0 ? sorted : ['all']);
        const endpoint = kind === 'conn'
          ? `/api/mcps/${encodeURIComponent(id)}`
          : kind === 'skill'
            ? `/api/skills/${encodeURIComponent(id)}`
            : `/api/vault/${encodeURIComponent(id)}`;

        box.disabled = true;
        try {
          const res = await api(endpoint, {
            method: 'PATCH',
            body: JSON.stringify({ profiles: nextProfiles }),
          });
          const updated = kind === 'conn' ? res?.mcp : kind === 'skill' ? res?.skill : res?.secret;
          item.profiles = Array.isArray(updated?.profiles) ? updated.profiles : nextProfiles;
          recomputeCounts(rec);
          changed = true;
          const countsEl = dlg.querySelector('#pf-mgr-counts');
          if (countsEl && rec.counts) countsEl.textContent = countLine(rec.counts);
        } catch (err) {
          box.checked = !add;
          toast(err.message, 'err');
        } finally {
          if (box.isConnected) box.disabled = false;
        }
      });
    });

    dlg.querySelector('[data-pf-mgr-edit]')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!rec) return;
      const form = e.currentTarget;
      const fd = new FormData(form);
      const name = String(fd.get('name') || '').trim();
      const description = String(fd.get('description') || '').trim();
      if (!name) {
        toast('Project name cannot be empty.', 'err');
        return;
      }
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        const res = await api(`/api/profiles/${encodeURIComponent(rec.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ name, description }),
        });
        if (res?.profile) Object.assign(rec, res.profile);
        else { rec.name = name; rec.description = description; }
        changed = true;
        toast('Project saved.', 'ok');
        paintDialog();
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
        btn.textContent = 'Save changes';
      }
    });

    dlg.querySelectorAll('[data-pf-mgr-agent]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rowId = btn.dataset.pfMgrAgent;
        dlg.close();
        openAgentPopup({
          ...ctx,
          onClose: (didChange) => {
            if (didChange) onChanged?.();
          },
        }, rowId);
      });
    });

    dlg.querySelector('[data-pf-mgr-del-arm]')?.addEventListener('click', () => {
      confirmDelete = true;
      paintDialog();
      dlg.querySelector('[data-pf-mgr-del-confirm]')?.focus();
    });

    dlg.querySelector('[data-pf-mgr-del-cancel]')?.addEventListener('click', () => {
      confirmDelete = false;
      paintDialog();
    });

    dlg.querySelector('[data-pf-mgr-del-confirm]')?.addEventListener('click', async (e) => {
      if (!rec) return;
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Deleting…';
      try {
        await api(`/api/profiles/${encodeURIComponent(rec.id)}`, { method: 'DELETE' });
        if (uiState.activeProfile === rec.id) setActiveProfile('all');
        changed = true;
        toast(`Deleted project "${rec.name}".`, 'ok');
        dlg.close();
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
        btn.textContent = `Delete ${rec.name}`;
      }
    });
  }

  dlg.showModal();
  Promise.all([
    api('/api/profiles'),
    api('/api/agents').catch(() => ({ agents: [], connected: [] })),
    api('/api/mcps').catch(() => ({ mcps: [] })),
    api('/api/skills').catch(() => ({ skills: [] })),
    api('/api/vault').catch(() => ({ secrets: [] })),
  ]).then(([profRes, agRes, mcpsRes, skillsRes, vaultRes]) => {
    localFolderManagement = profRes?.localFolderManagement === true;
    profiles = extractProfileRecords({ profileRecords: profRes?.profiles || profRes?.profileRecords || [] });
    agentData = agRes || { agents: [], connected: [] };
    allMcps = (Array.isArray(mcpsRes?.mcps) ? mcpsRes.mcps : [])
      .slice()
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
    allSkills = (Array.isArray(skillsRes?.skills) ? skillsRes.skills : [])
      .filter((s) => !isSystemSkill(s))
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
    allSecrets = (Array.isArray(vaultRes?.secrets) ? vaultRes.secrets : (Array.isArray(vaultRes?.items) ? vaultRes.items : []))
      .slice()
      .sort((a, b) => String(a.key || '').localeCompare(String(b.key || '')));
    paintDialog();
  }).catch((err) => {
    if (!dlg.isConnected) return;
    dlg.innerHTML = `
      <div class="cat-add-head">
        <h3 id="pf-mgr-title">Manage projects</h3>
        <button type="button" class="btn sm ghost" data-pf-mgr-close>Close</button>
      </div>
      <div class="callout bad" role="alert"><p>${esc(err?.message || 'Could not load projects.')}</p></div>`;
    dlg.querySelector('[data-pf-mgr-close]')?.addEventListener('click', () => dlg.close());
  });
}

// Who lends which connection to this Loop (lib/people.mjs), from the last Home.
let lentBy = new Map();

// Connection problems that only the owner can end.
const NEEDS_OWNER = new Set(['sign_in', 'credentials']);

// Home: every connection and skill by category, scoped strictly to the active profile.
async function renderHome(root, seq) {
  renderLoading(root, 'Loading overview…');
  let data;
  try {
    data = await api('/api/overview');
  } catch (err) {
    if (seq !== renderSeq) return;
    renderErrorState(root, err, () => render());
    return;
  }
  if (seq !== renderSeq) return;

  const profileRecords = extractProfileRecords(data);
  const allAgentRows = agentRows(
    Array.isArray(data.agentKeys) ? data.agentKeys : [],
    Array.isArray(data.agents) ? data.agents : [],
  );
  syncTopChrome(profileRecords, { loaded: true });
  const mcps = Array.isArray(data.mcps) ? data.mcps : [];
  const toolSetups = Array.isArray(data.toolSetups) ? data.toolSetups : [];
  const connectDevices = Array.isArray(data.connectDevices) ? data.connectDevices : [];
  const isHostedHome = Array.isArray(data.connectDevices);
  let selectedComputer = '';
  try { selectedComputer = localStorage.getItem('loop.installComputer') || ''; } catch {}
  if (!connectDevices.some(d => d.id === selectedComputer)) selectedComputer = '';

  const catRequests = Array.isArray(data.home?.categoryRequests) ? data.home.categoryRequests : [];
  const catList = Array.isArray(data.categories) ? data.categories : [];
  const skillsByCat = new Map(catList.map((c) => [c.id, Array.isArray(c.skills) ? c.skills : []]));
  const allSkills = [...skillsByCat.values()].flat();
  const systemGuides = homeSystemGuides(allSkills);
  const catOrder = new Map(catList.map((c, i) => [c.id, i]));
  const libGroups = groupConnectionsByCategory(mcps, catList)
    .map((g) => ({ ...g, skills: skillsByCat.get(g.id) || [] }));
  for (const c of catList) {
    if (!libGroups.some((g) => g.id === c.id) && (skillsByCat.get(c.id) || []).length) {
      libGroups.push({ id: c.id, label: c.label || c.id, mcps: [], skills: skillsByCat.get(c.id) });
    }
  }
  libGroups.sort((a, b) => (catOrder.get(a.id) ?? 1e9) - (catOrder.get(b.id) ?? 1e9));

  const connLabel = (id) => mcps.find((m) => m.id === id)?.name || id;

  // What others gave to this Loop: sign-ins that are left, what they lend, and what they offer.
  const given = (Array.isArray(data.from) ? data.from : []).flatMap((f) => f.items.map((i) => ({ ...i, owner: f.owner, personId: f.id })));
  const givenByConn = new Map(given.filter((i) => i.connId).map((i) => [i.connId, i]));
  lentBy = new Map(given.filter((i) => i.connId && i.state === 'mine').map((i) => [i.connId, i.owner]));

  const serviceGroupKey = (m) => {
    if (!m || typeof m !== 'object') return '';
    if (m.lent) return `lent:${m.id}`;
    if (typeof m.serviceKey === 'string' && m.serviceKey) return m.serviceKey;
    const t = String(m.transport || '').toLowerCase();
    if (t === 'builtin') return `builtin:${m.id}`;
    if (t === 'stdio' || m.command) {
      const cmd = String(m.command || '').trim();
      if (!cmd) return `local:${m.id}`;
      const base = cmd.split('/').pop() || cmd;
      const args = Array.isArray(m.args) ? m.args.filter((a) => typeof a === 'string').map((a) => a.trim()).filter(Boolean) : [];
      return `local:${[base, ...args].join(' ').toLowerCase().slice(0, 180)}`;
    }
    if (typeof m.url === 'string' && m.url.trim()) {
      try {
        const u = new URL(m.url.trim());
        return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
      } catch { /* fall through */ }
    }
    return `conn:${m.id}`;
  };

  const baseNameOf = (m) => {
    const raw = String(m?.name || m?.id || '');
    const suffix = m?.accountLabel ? ` (${m.accountLabel})` : '';
    return suffix && raw.endsWith(suffix) ? raw.slice(0, -suffix.length) : raw;
  };

  // Option A: collapse multiple accounts of one service into a single Home row.
  const groupServiceRows = (list) => {
    const byKey = new Map();
    const order = [];
    for (const m of list) {
      const key = serviceGroupKey(m);
      let bucket = byKey.get(key);
      if (!bucket) {
        bucket = [];
        byKey.set(key, bucket);
        order.push(bucket);
      }
      bucket.push(m);
    }
    return order.map((accounts) => {
      if (accounts.length === 1) return accounts[0];
      const primary = accounts.find((a) => a.enabled !== false && a.readiness?.ready)
        || accounts.find((a) => a.enabled !== false)
        || accounts[0];
      return {
        ...primary,
        name: baseNameOf(primary),
        _accounts: accounts,
      };
    });
  };

  const isRelayMcp = (m) => typeof m?.url === 'string' && m.url.startsWith('https://relay.useloop.sh/d/');

  // Sign-ins for an app behind a connection that the owner can do now (lib/app-sign-ins.mjs).
  const appAsks = (m) => (m.enabled && m.readiness?.ready ? (m.appSignIns || []).filter((s) => s.state === 'open' && s.url && !s.opened) : []);

  function connStatus(m) {
    const counts = getToolCounts(m);
    const r = m.readiness;
    const asks = appAsks(m);
    if (asks.length) {
      const labels = asks.map((s) => {
        const base = s.app || 'An app';
        return s.accountLabel && !base.toLowerCase().includes(String(s.accountLabel).toLowerCase())
          ? `${base} (${s.accountLabel})`
          : base;
      });
      return `<span class="ctl-st warn">${esc(labels.join(', '))} needs sign-in</span>`;
    }
    if (!r?.ready) return `<span class="ctl-st ${r?.state === 'disabled' ? '' : 'warn'}">${esc(r?.label || 'Status unavailable')}</span>`;
    if (m.lent) return `<span class="ctl-st">${lentBy.has(m.id) ? `From ${esc(lentBy.get(m.id))}` : 'From another Loop'}</span>`;
    const extras = [];
    if (m.transport === 'stdio' && m.portable === false) extras.push('This computer only');
    else if ((m.transport === 'stdio' || isRelayMcp(m)) && m.remoteAccess === 'ask_approval') extras.push('Remote 2FA');
    else if ((m.transport === 'stdio' || isRelayMcp(m)) && m.remoteAccess === 'local_only') extras.push('Local only');
    const tail = extras.length ? ` · ${esc(extras.join(' · '))}` : '';
    return `<span class="ctl-st">${esc(counts.enabled)} ${counts.enabled === 1 ? 'tool' : 'tools'}${tail}</span>`;
  }

  function openGroups(sections) {
    if (!uiState.homeOpenGroups) {
      const saved = readLocal(HOME_OPEN_KEY, null);
      // First visit: open the first two categories and fold the rest.
      uiState.homeOpenGroups = new Set(Array.isArray(saved) ? saved : sections.filter((s) => !s.pinned).slice(0, 2).map((s) => s.id));
    }
    return uiState.homeOpenGroups;
  }
  const saveOpenGroups = () => writeLocal(HOME_OPEN_KEY, [...uiState.homeOpenGroups]);

  // Home: Needs you, and Connections & Skills strictly scoped to the active profile.
  function paintOverview() {
    if (seq !== renderSeq) return;
    const activeProfile = normalizeActiveProfile(profileRecords);
    const activeProfileName = profileNameOf(activeProfile, profileRecords);
    const scopedMcps = mcps.filter((m) => itemInActiveProfile(m, activeProfile));
    const scopedSkills = allSkills.filter((sk) => itemInActiveProfile(sk, activeProfile));
    const q = String(uiState.homeSearch || '').trim().toLowerCase();
    const hit = (item) => homeMatchScore(item, q) > 0;
    const skillHit = hit;
    const kindOf = (id) => (['conn', 'skill'].includes(uiState.homeKinds[id]) ? uiState.homeKinds[id] : 'all');

    const top = [];
    const needsConn = (m) => Boolean(m.enabled && (m.readiness?.action || appAsks(m).length));
    // Needs you: only what stops an agent and only the owner can do. Approvals, sign-ins and rejected
    // keys. Any other problem stays in its category, where agents can fix it.
    // The sign-ins of an invite have a box of their own.
    const isLeft = (m) => givenByConn.get(m.id)?.state === 'signin';
    const needsAll = scopedMcps.filter((m) => m.enabled && (NEEDS_OWNER.has(m.readiness?.action) || appAsks(m).length) && hit(m));
    const leftConns = scopedMcps.filter((m) => m.enabled && isLeft(m) && hit(m));
    const leftButton = (m, i) => {
      const { action } = m.readiness || {};
      const keyed = action === 'credentials' || Boolean(m.signInBroken);
      const attr = keyed ? 'data-open-conn-creds' : action === 'sign_in' ? 'data-open-conn-signin' : 'data-open-conn';
      const label = keyed || action === 'sign_in' ? 'Sign in' : 'Open';
      return `<button type="button" class="hm-left-go ${i === 0 ? 'is-first' : ''}" ${attr}="${esc(m.id)}" aria-label="${label === 'Open' ? 'Open' : 'Sign in to'} ${esc(m.name)}">${label}</button>`;
    };
    const needsConns = needsAll.filter((m) => !isLeft(m));
    const offers = given.filter((i) => i.state === 'offer' && (!q || i.name.toLowerCase().includes(q)));
    const visibleApprovals = q ? pendingApprovals.filter((a) => `${a.title || ''} ${a.target || ''} ${a.agentName || ''}`.toLowerCase().includes(q)) : pendingApprovals;
    const visibleRequests = q ? catRequests.filter((r) => `${r.target.label} ${r.reason}`.toLowerCase().includes(q)) : catRequests;
    const needsCount = visibleApprovals.length + visibleRequests.length + needsConns.length;
    if (needsCount > 0) {
      top.push({
        id: 'needs',
        label: 'Needs you',
        warn: true,
        pinned: true,
        count: needsCount,
        railCount: needsCount,
        approvals: visibleApprovals,
        requests: visibleRequests,
        rows: needsConns,
        skills: [],
      });
    }

    // Connections that cannot run in this Loop (a local program on hosted Loop) are not on Home:
    // they have no section and do not show in their category. Search still finds them, so one can be removed.
    const cannotRunHere = (m) => m.readiness?.state === 'unsupported_workspace';

    if (leftConns.length || offers.length) {
      // A host is shown as a whole: its end says whose it is.
      const leftRow = (logo, name, under, btn) => `<li class="oc-line"><span class="oc-line-ic">${logo}</span><span class="hm-left-tx"><span class="oc-line-t">${esc(name)}</span>${under ? `<span class="hm-left-h">${esc(under)}</span>` : ''}</span>${btn}</li>`;
      const owners = [...new Set(offers.map((i) => i.owner))];
      top.push({
        id: 'given',
        label: leftConns.length ? 'Sign-ins left' : 'New for you',
        pinned: true,
        railCount: leftConns.length || offers.length,
        rows: [],
        skills: [],
        block: () => `
          <div class="hm-group is-open" data-hm-group="given">
            ${leftConns.length ? `
              <section class="hm-left" aria-labelledby="hm-left-t">
                <h2 id="hm-left-t">${leftConns.length} ${leftConns.length === 1 ? 'sign-in' : 'sign-ins'} left</h2>
                <ul class="oc-lines">${leftConns.map((m, i) => leftRow(renderConnLogo(m, { badge: false }), m.name, '', leftButton(m, i))).join('')}</ul>
              </section>` : ''}
            ${offers.length ? `
              <section class="hm-left" aria-labelledby="hm-offer-t">
                <h2 id="hm-offer-t">New from ${esc(owners.length === 1 ? owners[0] : 'other Loops')}</h2>
                <ul class="oc-lines">${offers.map((i) => leftRow(i.kind === 'skill' ? HM_SKILL_ICON : renderConnLogo({ name: i.name, transport: 'http' }, { badge: false }), i.name, i.kind === 'skill' ? 'Skill' : i.mode === 'mine' ? `${i.owner}’s account` : i.host || '', `<button type="button" class="hm-left-go" data-hm-take="${esc(i.id)}" data-hm-of="${esc(i.personId)}" aria-label="Add ${esc(i.name)}">Add</button>`)).join('')}</ul>
              </section>` : ''}
          </div>`,
      });
    }

    const availableSetups = toolSetups.filter((s) => {
      if (!s || !s.enabled || s.home === 'cloud') return false;
      if (!itemInActiveProfile(s, activeProfile)) return false;
      if (!hit(s)) return false;
      if (!isHostedHome) {
        if (s.localStatus === 'ready' || s.localStatus === 'cloud_ready') return false;
        return true;
      }
      return !selectedComputer || s.installations?.[selectedComputer]?.status !== 'ready';
    });

    if (availableSetups.length > 0) {
      const hasOnlineDevice = connectDevices.some((d) => d.online);
      const setupRowHtml = (s) => {
        const originLabel = s.originDeviceName || 'Original computer';
        const ver = s.installSpec?.version ? ` · v${s.installSpec.version}` : '';
        const isNeedsAttention = s.localStatus === 'needs_attention' || s.localStatus === 'error';
        let statusLine = '';
        let actionHtml = '';
        if (!s.portable) {
          statusLine = `Local · ${originLabel} only`;
          actionHtml = '';
        } else if (isNeedsAttention) {
          statusLine = `Local · ${s.localInstall?.missingStep || s.localInstall?.lastError || 'Needs attention'}`;
          actionHtml = `<button type="button" class="btn sm fill" data-setup-install="${esc(s.id)}">Fix &amp; Retry</button>`;
        } else if (isHostedHome && !hasOnlineDevice) {
          statusLine = `Local · Needs Loop app${ver}`;
          actionHtml = `<button type="button" class="btn sm" data-setup-install-app="${esc(s.id)}">Install Loop</button>`;
        } else {
          statusLine = `Local · Not on this computer${ver}`;
          actionHtml = `<button type="button" class="btn sm fill" data-setup-install="${esc(s.id)}">Install</button>`;
          if (isHostedHome && !selectedComputer) actionHtml += ` <button type="button" class="btn sm" data-setup-install-app="${esc(s.id)}">Pair this computer</button>`;
        }
        return `
          <li>
            <div class="row ctl-row hm-conn-row hm-setup-row ${s.enabled === false ? 'is-off' : ''}">
              <div class="hm-conn-main">
                <span class="hm-lane">${HM_LAYERS_ICON}</span>
                <span class="txt">
                  <span class="t">${esc(s.name || s.id)}</span>
                  <span class="ctl-st ${isNeedsAttention ? 'warn' : ''}">${esc(statusLine)}</span>
                </span>
              </div>
              ${actionHtml ? `<div class="hm-setup-meta">${actionHtml}</div>` : ''}
            </div>
          </li>`;
      };
      top.push({
        id: 'available-setups',
        label: 'Saved local tools',
        pinned: true,
        count: availableSetups.length,
        railCount: availableSetups.length,
        rows: [],
        skills: [],
        block: () => `
          <div class="hm-group is-open" data-hm-group="available-setups">
            <div class="hm-lib">
              <h2 class="hm-lib-t">Saved local tools</h2>
              ${isHostedHome && connectDevices.length ? `<label>This computer <select data-install-computer><option value="">Choose this computer</option>${connectDevices.map(d => `<option value="${esc(d.id)}" ${d.id === selectedComputer ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>` : ''}
            </div>
            <ul class="list">
              ${availableSetups.map(setupRowHtml).join('')}
            </ul>
          </div>`,
      });
    }

    const scopedServiceCounts = new Map();
    for (const m of scopedMcps) {
      if (cannotRunHere(m)) continue;
      const k = serviceGroupKey(m);
      scopedServiceCounts.set(k, (scopedServiceCounts.get(k) || 0) + 1);
    }

    const lib = [];
    for (const g of libGroups) {
      const scopedInGroup = g.mcps.filter((m) => itemInActiveProfile(m, activeProfile) && (q || !cannotRunHere(m)));
      const allRows = groupServiceRows(scopedInGroup).filter((m) => hit(m));
      // Skills are not listed on Home: they are in Library (#knowledge/skills). A category here holds its
      // connections and one Skills row with the count, which opens Library on that category.
      const groupSkills = [];
      // The same skills as Library shows for the category, System guides included, so the two numbers agree.
      const skillCount = q ? 0 : g.skills.filter((sk) => itemInActiveProfile(sk, activeProfile)).length;
      if (!allRows.length && !skillCount) continue;
      const kind = 'conn';
      lib.push({
        id: g.id, label: g.label, libTitle: true, pinned: true, kind, skillCount,
        rows: kind === 'skill' ? [] : allRows,
        skills: kind === 'conn' ? [] : groupSkills,
        kinds: { all: allRows.length + groupSkills.length, conn: allRows.length, skill: groupSkills.length },
        railCount: allRows.length + skillCount,
      });
    }
    if (lib[0]) lib[0].libFirst = true;
    const systemGroup = { id: '@system', label: 'System', rows: [], railCount: systemGuides.length, pinned: true };
    // Search on Home finds connections only; skills are searched in Library.
    const matches = q ? rankedHomeMatches(lib, q).filter((x) => x.kind === 'conn') : [];
    const matchingSystem = [];
    const searchGroup = { id: '@matches', label: 'Matching connections', pinned: true,
      count: matches.length + matchingSystem.length, railCount: matches.length + matchingSystem.length, rows: [], skills: [] };
    const sections = q ? [...(matches.length ? [searchGroup] : []), ...top] : [...top, ...lib];
    // Phones: System is the last part of the page, so the scrubber reaches it like any other section.
    const onPhone = phoneHome.matches;
    // A row of category pills at the top: one pill shows one category. Wide windows show it in place of
    // the side list; narrow ones as a row that scrolls sideways.
    const wide = Boolean(SIDE_MQ?.matches);
    // Wide windows show every category, with the side menu open to jump between them. Narrow windows
    // pick one category in the top-left switcher.
    const cat = !q && !wide && sections.some((s) => s.id === uiState.homeCat) ? uiState.homeCat : '';
    // Narrow windows pick a category in the top-left switcher: it reads them from here.
    let switcherStale = false;
    if (!q) {
      const cats = sections.map((s) => ({ id: s.id, label: s.label, count: s.railCount ?? s.rows.length, warn: Boolean(s.warn) }));
      switcherStale = JSON.stringify(cats) !== JSON.stringify(latestHomeCats) || !homeCatPick;
      latestHomeCats = cats;
    }
    homeCatPick = (id) => {
      uiState.homeSearch = '';
      uiState.homeCatMore = false;
      uiState.homeCat = id;
      uiState.homeJump = id || null;
      paintOverview();
      root.querySelector('.ctl-scroll')?.scrollTo({ top: 0 });
      window.scrollTo({ top: 0 });
    };
    const viewingSystem = false; // System guides are skills: they are in Library now.
    const open = openGroups(sections);
    const isOpen = (s) => s.pinned || Boolean(q) || open.has(s.id);
    const foldable = sections.filter((s) => !s.pinned);
    const anyOpen = foldable.some((s) => open.has(s.id));
    const jumpTo = sections.some((s) => s.id === uiState.homeJump) ? uiState.homeJump : sections[0]?.id;

    const groupStatus = (accounts) => {
      const needList = accounts.filter((a) => needsConn(a));
      if (needList.length > 0) {
        const allSignIn = needList.every((a) => a.readiness?.action === 'sign_in' || appAsks(a).length > 0);
        const detail = allSignIn
          ? `${needList.length} ${needList.length === 1 ? 'needs' : 'need'} sign-in`
          : `${needList.length} ${needList.length === 1 ? 'needs' : 'need'} attention`;
        return `<span class="ctl-st warn">${esc(accounts.length)} accounts · ${esc(detail)}</span>`;
      }
      const labels = accounts.map((a, idx) => a.accountLabel || (idx === 0 ? 'Default' : `Account ${idx + 1}`));
      const preview = labels.slice(0, 3).join(', ') + (labels.length > 3 ? ` +${labels.length - 3}` : '');
      return `<span class="ctl-st">${esc(accounts.length)} accounts · ${esc(preview)}</span>`;
    };

    // A row in Needs you says "Sign in" and signs in at once. In a category the same row says "Connect"
    // and opens the connection page, where you name the account first (a service can have many).
    const rowHtml = (m, where) => {
      const inNeeds = where === 'needs';
      const signAttr = inNeeds ? 'data-open-conn-signin' : 'data-open-conn-connect';
      const signLabel = inNeeds ? 'Sign in' : 'Connect';
      const accounts = Array.isArray(m._accounts) && m._accounts.length > 1 ? m._accounts : null;
      if (accounts) {
        const actionTarget = accounts.find((a) => needsConn(a)) || null;
        const allOff = accounts.every((a) => a.enabled === false);
        const labelHtml = `
          <span class="txt">
            <span class="t">${esc(m.name)}</span>
            ${groupStatus(accounts)}
          </span>`;
        if (actionTarget) {
          const action = actionTarget.readiness?.action;
          const attr = action === 'sign_in' ? signAttr : action === 'credentials' ? 'data-open-conn-creds' : 'data-open-conn';
          const actionAttr = `${attr}="${esc(actionTarget.id)}"`;
          const actionLabel = appAsks(actionTarget).length ? 'Sign in' : ({ sign_in: signLabel, credentials: 'Update key', repair: 'Repair connection', refresh: 'Review tools', enable_tools: 'Choose tools' })[action] || 'Review';
          return `
            <li>
              <div class="row ctl-row hm-conn-row ${allOff ? 'is-off' : ''}">
                <button type="button" class="hm-conn-main" data-open-conn="${esc(m.id)}">
                  ${renderConnLogo(m)}
                  ${labelHtml}
                </button>
                <button type="button" class="btn sm" ${actionAttr}>${actionLabel}</button>
              </div>
            </li>`;
        }
        return `
          <li>
            <button type="button" class="row ctl-row hm-conn-row ${allOff ? 'is-off' : ''}" data-open-conn="${esc(m.id)}">
              ${renderConnLogo(m)}
              ${labelHtml}
            </button>
          </li>`;
      }
      const needsAction = needsConn(m);
      const multiInService = (scopedServiceCounts.get(serviceGroupKey(m)) || 0) > 1;
      const pillLabel = m.accountLabel || (multiInService ? 'Default' : '');
      const acctTag = pillLabel ? ` <span class="hm-loc-pill">${esc(pillLabel)}</span>` : '';
      const labelHtml = `
        <span class="txt">
          <span class="t">${esc(m.name)}${acctTag}</span>
          ${connStatus(m)}
        </span>`;
      if (needsAction) {
        const action = m.readiness.action;
        const attr = action === 'sign_in' ? signAttr : action === 'credentials' ? 'data-open-conn-creds' : 'data-open-conn';
        const actionAttr = `${attr}="${esc(m.id)}"`;
        const actionLabel = appAsks(m).length ? 'Sign in' : ({ sign_in: signLabel, credentials: 'Update key', repair: 'Repair connection', refresh: 'Review tools', enable_tools: 'Choose tools' })[action] || 'Review';
        return `
          <li>
            <div class="row ctl-row hm-conn-row ${m.enabled ? '' : 'is-off'}">
              <button type="button" class="hm-conn-main" data-open-conn="${esc(m.id)}">
                ${renderConnLogo(m)}
                ${labelHtml}
              </button>
              <button type="button" class="btn sm" ${actionAttr}>${actionLabel}</button>
            </div>
          </li>`;
      }
      return `
        <li>
          <button type="button" class="row ctl-row hm-conn-row ${m.enabled ? '' : 'is-off'}" data-open-conn="${esc(m.id)}">
            ${renderConnLogo(m)}
            ${labelHtml}
          </button>
        </li>`;
    };
    // Needs you: a pending approval, with the request's details one click away.
    const approvalHtml = (item) => {
      const busy = inFlightApprovals.has(item.id);
      const title = String(item.title || item.target || 'Approval requested');
      const when = item.createdAt ? shortAgo(item.createdAt) : '';
      const addAsk = isAddQuestion(item);
      const showTarget = Boolean(item.target && !addAsk && !title.includes(String(item.target)));
      const destination = extractApprovalDestination(item.detail);
      const accountLabel = typeof item.detail?.account === 'string' && item.detail.account.trim()
        ? item.detail.account.trim()
        : '';
      const showAccountBanner = Boolean(accountLabel && !title.toLowerCase().includes(accountLabel.toLowerCase()));
      const card = organizeApprovalCard(item);
      const detail = card ? renderOrganizeApproval(card, esc) : renderApprovalDetail(item.detail);
      const more = showTarget || detail || item.reason;
      const letManage = addAsk && item.agentId;
      return `
        <li>
          <div class="row ctl-row hm-need${card || letManage || canAlwaysAllowConnection(item) ? ' is-wide' : ''}">
            <span class="hm-lane is-warn">${HM_LOCK_ICON}</span>
            <div class="txt">
              <div class="t">${esc(title)}</div>
              <span class="ctl-st warn">${esc([item.agentName || 'An agent', when === 'just now' ? 'asked just now' : when ? `asked ${when} ago` : ''].filter(Boolean).join(' · '))}</span>
              ${showAccountBanner ? `<div class="approval-destination">Account: <strong>${esc(accountLabel)}</strong></div>` : ''}
              ${destination ? `<div class="approval-destination mono">Destination: <strong>${esc(destination)}</strong></div>` : ''}
              ${card ? detail : more ? `
                <details class="hm-need-more">
                  <summary>Details</summary>
                  ${item.reason ? `<p>${esc(item.reason)}</p>` : ''}
                  ${showTarget ? `<code class="inline-code">${esc(item.target)}</code>` : ''}
                  ${detail}
                </details>` : ''}
            </div>
            <div class="hm-acts">
              <button type="button" class="btn sm" data-hm-deny="${esc(item.id)}" ${busy ? 'disabled' : ''}>${addAsk ? 'Not now' : 'Deny'}</button>
              ${letManage ? `<button type="button" class="btn sm" data-hm-approve-agent="${esc(item.id)}" title="Turns on “Can manage connections” for this agent" ${busy ? 'disabled' : ''}>Always let ${esc(item.agentName || 'this agent')} manage connections</button>` : ''}
              ${canAlwaysAllowConnection(item) ? `<button type="button" class="btn sm" data-hm-approve-always-conn="${esc(item.id)}" title="Stop asking for any tool on this connection" ${busy ? 'disabled' : ''}>Always allow all of ${esc(approvalConnectionName(item))}</button>` : ''}
              ${canAlwaysAllowApproval(item) ? `<button type="button" class="btn sm" data-hm-approve-always="${esc(item.id)}" ${busy ? 'disabled' : ''}>Approve &amp; Always Allow</button>` : ''}
              <button type="button" class="btn sm${isDeleteApproval(item) ? '' : ' fill'}" data-hm-approve="${esc(item.id)}" ${busy ? 'disabled' : ''}>${item.guard ? 'Confirm' : addAsk ? 'Add' : 'Approve'}</button>
            </div>
          </div>
        </li>`;
    };
    // Needs you: an agent kept looking for these in the wrong place and asks to file them better.
    const requestHtml = (r) => {
      const who = r.askedBy.length > 1 ? `${r.askedBy[0]} and ${r.askedBy.length - 1} more` : r.askedBy[0];
      const n = `${r.items.length} ${r.items.length === 1 ? 'item' : 'items'}`;
      const times = `${r.finds} ${r.finds === 1 ? 'time' : 'times'}`;
      return `
        <li>
          <div class="row ctl-row hm-need hm-catreq is-wide" data-hm-catreq="${esc(r.id)}">
            <span class="hm-lane is-warn">${HM_FOLDER_ICON}</span>
            <div class="txt">
              <div class="t">${r.target.isNew ? `Make a category: ${esc(r.target.label)}` : `Move ${esc(n)} to ${esc(r.target.label)}`}</div>
              <span class="ctl-st warn">${esc(`${who} asked ${shortAgo(r.createdAt) === 'just now' ? 'just now' : `${shortAgo(r.createdAt)} ago`}`)}</span>
              <p class="hm-catreq-why">“${esc(r.reason)}”</p>
              <p class="hm-catreq-why">${esc(times)[0].toUpperCase()}${esc(times).slice(1)}, agents looked in ${esc(r.looked.join(' or '))} first.</p>
              <details class="hm-need-more">
                <summary>${r.target.isNew ? `${esc(n)} would move there` : 'What would move'}</summary>
                <ul class="hm-catreq-items">${r.items.map((it) => `<li>${esc(it.name)} <span>${it.kind === 'skill' ? 'Skill' : 'Connection'}, now in ${esc(it.fromLabel)}</span></li>`).join('')}</ul>
              </details>
              <p class="field-err" role="alert" hidden></p>
            </div>
            <div class="hm-acts">
              <button type="button" class="btn sm" data-hm-catreq-no>Deny</button>
              <button type="button" class="btn sm fill" data-hm-catreq-yes>Approve</button>
            </div>
          </div>
        </li>`;
    };
    // A category's skills as one row: the count, and a link to Library's Skills on that category.
    const skillsRowHtml = (s) => `
      <li>
        <a class="row ctl-row hm-conn-row hm-skills-row" href="#knowledge/skills?cat=${encodeURIComponent(s.id)}" aria-label="${esc(`${s.skillCount} ${s.skillCount === 1 ? 'skill' : 'skills'} in ${s.label}, open in Library`)}">
          <span class="hm-lane">${HM_SKILL_ICON}</span>
          <span class="txt"><span class="t">Skills</span></span>
          <span class="hm-skills-n">${esc(s.skillCount)}</span>
          ${LN_CHEV}
        </a>
      </li>`;
    // Skills sit in their category under its connections, folded to one line until opened.
    const skillLink = (sk, member = false) => `
      <li>
        <div class="row ctl-row hm-skill ${member ? 'is-member' : ''}">
          <span class="hm-lane">${HM_SKILL_ICON}</span>
          <a class="txt" href="#skills?q=${encodeURIComponent(sk.name || sk.id)}">
            <div class="t">${esc(sk.name || sk.id)}</div>
            <span class="ctl-st">${esc([sk.bundled ? 'Bundled with Loop' : '', firstSentence(sk.description)].filter(Boolean).join(' · ') || 'Skill')}</span>
          </a>
        </div>
      </li>`;
    const partnerSkillLink = (sk) => `
      <li>
        <div class="row ctl-row hm-conn-row hm-skill ${sk.partnerSkillsEnabled ? '' : 'is-off'}">
          <button type="button" class="hm-conn-main" data-open-conn="${esc(sk.connectionId)}">
            <span class="hm-lane">${HM_SKILL_ICON}</span>
            <span class="txt">
              <span class="t">${esc(sk.name || sk.slug || sk.id)}</span>
              <span class="ctl-st">${esc([`Offered by ${sk.connectionName}`, sk.partnerSkillsEnabled ? 'Enabled' : 'Off', firstSentence(sk.description)].filter(Boolean).join(' · '))}</span>
            </span>
          </button>
          <button type="button" class="btn sm ${sk.partnerSkillsEnabled ? '' : 'fill'}" data-hm-partner-skills="${esc(sk.connectionId)}" data-next="${sk.partnerSkillsEnabled ? 'false' : 'true'}">${sk.partnerSkillsEnabled ? 'Disable partner Skills' : 'Enable partner Skills'}</button>
        </div>
      </li>`;
    const skillEntryHtml = (catId, en) => {
      if (!en.family) return skillLink(en.skill);
      const key = `${catId}:${en.id}`;
      const famOpen = uiState.homeFamOpen.has(key);
      const members = en.items.map((sk) => {
        const nm = String(sk.name || sk.id);
        return nm === en.name ? nm : nm.slice(en.name.length + 1) || nm;
      });
      return `
        <li>
          <div class="row ctl-row hm-skill">
            <span class="hm-lane">${HM_SKILL_ICON}</span>
            <button type="button" class="txt hm-fam" data-hm-fam="${esc(key)}" aria-expanded="${famOpen}">
              <div class="t">${esc(en.name)} <span class="hm-fam-n">${esc(en.items.length)} skills</span></div>
              <span class="ctl-st">${esc(members.join(', '))}</span>
            </button>
            <span class="hm-fam-chev">${chevron('hm-chev')}</span>
          </div>
        </li>
        ${famOpen ? en.items.map((sk) => skillLink(sk, true)).join('') : ''}`;
    };
    const skillsBlock = (s) => {
      if (!s.skills || !s.skills.length) return '';
      const entries = skillEntries(s.skills);
      const forced = s.kind === 'skill' || Boolean(q);
      const shown = forced || uiState.homeSkillsAll.has(s.id) ? entries : entries.slice(0, HOME_SKILL_PREVIEW);
      const restCount = entries.slice(shown.length).reduce((k, en) => k + (en.family ? en.items.length : 1), 0);
      return shown.map((en) => skillEntryHtml(s.id, en)).join('')
        + (restCount ? `<li><button type="button" class="hm-more" data-hm-more="${esc(s.id)}">Show ${esc(restCount)} more ${restCount === 1 ? 'skill' : 'skills'}</button></li>` : '');
    };

    const libHead = (s) => `
      <div class="hm-lib">
        <h2 class="hm-lib-t">${esc(s ? s.label : 'Library')}</h2>
        ${s && s.kinds?.skill ? `
          <div class="seg hm-kinds" role="group" aria-label="Show in ${esc(s.label)}">
            ${[['all', 'All'], ['conn', 'Connections'], ['skill', 'Skills']]
              .map(([id, label]) => `<button type="button" class="seg-btn" data-hm-kind="${esc(s.id)}" data-kind="${id}" aria-pressed="${s.kind === id}" ${s.kinds[id] ? '' : 'disabled'}>${label} <span>${esc(s.kinds[id])}</span></button>`).join('')}
          </div>` : ''}
      </div>`;

    // Phones: each section has its own box, so its name can stay at the top while you are in it.
    const sectionHtml = (s) => (onPhone ? `<section class="hm-sec">${sectionBody(s)}</section>` : sectionBody(s));
    const sectionBody = (s) => {
      if (s.block) return s.block();
      const expanded = isOpen(s);
      return `
        ${s.libTitle ? libHead(s) : ''}
        <div class="hm-group ${expanded ? 'is-open' : ''}" data-hm-group="${esc(s.id)}">
          ${s.libTitle ? '' : `<button type="button" class="hm-head ${s.warn ? 'is-warn' : ''}" ${s.pinned ? 'disabled' : `data-hm-toggle="${esc(s.id)}"`} aria-expanded="${expanded}">
            ${chevron('hm-chev')}<span class="hm-head-l">${esc(s.label)}</span><span class="hm-head-n">${esc(s.count)}</span>
          </button>`}
          ${expanded ? `<ul class="list">${(s.approvals || []).map(approvalHtml).join('')}${(s.requests || []).map(requestHtml).join('')}${s.rows.map((m) => rowHtml(m, s.id)).join('')}${skillsBlock(s)}${s.skillCount ? skillsRowHtml(s) : ''}</ul>` : ''}
        </div>`;
    };

    const addPrompt = activeProfile === 'all' ? 'Add to my Loop:' : `Add to my Loop, in the project ${JSON.stringify(activeProfileName)}:`;
    // What an agent added while the panel was open.
    const addedHtml = (added) => {
      const m = added.kind === 'connection' ? mcps.find((x) => x.id === added.id) : null;
      const signIn = m && needsConn(m) && m.readiness.action === 'sign_in';
      const by = `Added by ${added.agent}.`;
      return `
        <div role="status">
          <h3 class="hm-add-t">${esc(m?.name || added.name)} is in your Loop</h3>
          <p class="hm-add-s">${esc(signIn ? `${by} Sign in, and your agents can use it.` : m && needsConn(m) ? `${by} It needs one more step.` : `${by} Your agents can use it.`)}</p>
        </div>
        <ul class="hm-add-list">${m ? rowHtml(m) : ''}<li><button type="button" class="hm-add-opt" data-hm-add-more><span>Add one more</span>${LN_CHEV}</button></li></ul>`;
    };
    // Phones: adding sits under Agents, next to what it adds to. Wider windows keep it in the title row.
    const addHtml = () => {
      const listOpen = Boolean(uiState.homeAdd);
      const choice = (id, label) => `<li><button type="button" class="hm-add-opt" data-hm-add="${id}" ${id === 'category' ? `aria-expanded="${uiState.homeAdd === 'category'}"` : ''}><span>${label}</span>${LN_CHEV}</button></li>`;
      const form = uiState.homeAdd !== 'category' ? '' : `
        <form class="hm-add-form" data-hm-add-form novalidate>
          <label for="hm-add-name">Name</label>
          <input type="text" id="hm-add-name" maxlength="60" autocomplete="off" value="${esc(uiState.homeAddName)}">
          <label for="hm-add-first">First connection</label>
          <select id="hm-add-first">
            ${scopedMcps.map((m) => `<option value="${esc(m.id)}" ${uiState.homeAddConn === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
          </select>
          <p class="field-err" role="alert" hidden></p>
          <button type="submit" class="btn sm fill">Add category</button>
        </form>`;
      return `
        <div class="hm-add">
          <div class="hm-lib">
            <h2 class="hm-lib-t">Connections</h2>
            <button type="button" class="btn sm ghost" data-hm-add-toggle aria-expanded="${listOpen}">${listOpen ? 'Close' : '+ Add'}</button>
          </div>
          ${listOpen ? `
            <div class="hm-add-panel">
              ${uiState.homeAdded ? addedHtml(uiState.homeAdded) : `
                <h3 class="hm-add-t">Add to Loop</h3>
                <p class="hm-add-s">Paste this into your agent. Then type the app or skill.</p>
                <p class="hm-add-prompt">${esc(addPrompt)}</p>
                <button type="button" class="btn fill hm-add-copy" data-hm-add-copy>Copy</button>
                <p class="hm-add-n">It shows here when your agent adds it.</p>
                <ul class="hm-add-list">
                  ${choice('connection', 'Enter an address')}
                  ${scopedMcps.length ? choice('category', 'New category') : ''}
                </ul>${form}`}
            </div>` : ''}
        </div>`;
    };

    const noMatches = (title) => `<div class="empty"><p class="et">${esc(title)}</p>
      <p class="ed">Show all connections, or copy a request to paste into your agent.</p>
      <div class="acts"><button type="button" class="btn sm" data-hm-show-all>Show all connections</button>
      <button type="button" class="btn sm" data-hm-find>Copy find-capability request</button></div></div>`;
    const searchResults = () => {
      const matchedItemsHtml = matches.length
        ? `<section class="hm-group is-open" data-hm-group="@matches"><h2 class="hm-lib-t">Matching connections</h2><ul class="list">${matches.map(({ item, kind }) => kind === 'conn' ? rowHtml(item) : kind === 'partner-skill' ? partnerSkillLink(item) : skillLink(item)).join('')}</ul></section>`
        : '';
      const matchedSysHtml = matchingSystem.length
        ? renderSystemSection(matchingSystem, { home: false, esc, expanded: uiState.expandedSkills, drawer: sk => renderSkillDrawer(sk, uiState.skillCache.get(sk.id)) })
        : '';
      if (!matchedItemsHtml && !matchedSysHtml && !top.length) return noMatches('No matching connections');
      return matchedItemsHtml + matchedSysHtml + top.map(sectionHtml).join('');
    };
    const systemSection = () => renderSystemSection(systemGuides.filter(skillHit), { home: true, esc, expanded: uiState.expandedSkills, drawer: sk => renderSkillDrawer(sk, uiState.skillCache.get(sk.id)) });
    const systemOnPhone = () => {
      const html = systemSection();
      return html ? `<section class="hm-sec"><div class="hm-group is-open" data-hm-group="${systemGroup.id}">${html}</div></section>` : '';
    };
    const addFocus = ['hm-add-name', 'hm-add-first'].find((id) => document.activeElement?.id === id);
    const listScroll = root.querySelector('.ctl-scroll')?.scrollTop ?? 0;
    const railScroll = root.querySelector('.hm-rail-list')?.scrollTop ?? 0;
    const pillScroll = root.querySelector('.hm-cat-pills')?.scrollLeft ?? 0;

    // Home shows no title or count line (user request); the heading stays for screen readers.
    const libraryTop = '<h1 class="sr-only">Home</h1>';

    const hasScopedItems = scopedMcps.length > 0 || availableSetups.length > 0;
    const showFirstRunBanner = !q && activeProfile === 'all' && mcps.length === 0 && availableSetups.length === 0;

    const keepApproval = holdApprovalDialog(root);
    root.innerHTML = `
      <section class="home-connections hm hm-libpage hm-home ctl-sec ctl-first" aria-label="Home">
        ${libraryTop}
        ${hasScopedItems ? `
          <input type="search" class="ctl-search" id="home-search" value="${esc(uiState.homeSearch || '')}" placeholder="${activeProfile !== 'all' ? `Search ${esc(activeProfileName)}` : 'Search connections'}" aria-label="Search connections">
          <div class="hm-bar">
            <span class="hm-meta"></span>
            ${foldable.length && !q ? `<button type="button" class="hm-fold" id="hm-fold">${anyOpen ? 'Collapse all' : 'Expand all'}</button>` : ''}
          </div>
` : ''}
        <div class="hm-body">
          <nav class="hm-rail" aria-label="On this page">
            ${sections.length ? `
              <div class="hm-rail-k">${esc(PAGES.home)}</div>
              <div class="hm-rail-list">${(cat ? sections.filter((s) => s.id === cat) : sections).map((s) => `<button type="button" class="hm-jump ${s.warn ? 'is-warn' : ''}" data-hm-jump="${esc(s.id)}" aria-current="${s.id === jumpTo}"><span>${esc(s.label)}</span><span class="hm-jump-n">${esc(s.railCount ?? s.rows.length)}</span></button>`).join('')}</div>` : ''}
          </nav>
          <div class="ctl-scroll">
            ${data.cloudWorkspaceUrl && !viewingSystem ? `<p><a class="btn sm fill" href="${esc(data.cloudWorkspaceUrl)}">Open workspace in Loop Cloud</a> <span>Manage tools installed on this computer below.</span></p>` : ''}
            ${!viewingSystem && showFirstRunBanner ? `
              <div class="callout hm-welcome" role="region" aria-label="Get started with Loop">
                <p><strong>Welcome to Loop.</strong> ${allAgentRows.length ? 'Now add the connections that your agents can use.' : 'Add an agent, then the connections that it can use. Every agent shares the same tools.'}</p>
                <div class="acts">
                  ${allAgentRows.length ? '' : '<button type="button" class="btn sm fill" data-hm-add-agent>Add agent</button>'}
                  <button type="button" class="btn sm ${allAgentRows.length ? 'fill' : ''}" ${canImportFromMac() ? 'data-hm-import-mac>Import from Mac' : 'data-hm-import-json>Import JSON'}</button>
                </div>
              </div>
            ` : ''}
            ${viewingSystem ? (systemSection() || (q ? noMatches('No matching system guides') : '<p class="empty">No system guides.</p>')) : q ? searchResults() : !hasScopedItems && activeProfile !== 'all' ? `
              ${top.map(sectionHtml).join('')}${addHtml()}
              <div class="empty">
                <p class="et">Nothing in ${esc(activeProfileName)} yet</p>
                <p class="ed">Add something new, or put items that you have in this project.</p>
                <div class="acts">
                  <button type="button" class="btn sm fill" data-hm-pick-default>Pick from All</button>
                  <button type="button" class="btn sm" data-hm-show-all>Show all connections</button>
                </div>
              </div>
            ` : mcps.length === 0 ? `
              ${top.map(sectionHtml).join('')}${addHtml()}
              <div class="empty">
                <p class="et">No connections yet</p>
                <p class="ed">Add one here, or ask your agent to add one.</p>
              </div>
            ` : top.length === 0 && lib.length === 0 ? `
              <div class="empty"><p class="et">Nothing matches</p><p class="ed">Add a connection or skill to get started.</p></div>
            ` : cat ? sectionHtml(sections.find((s) => s.id === cat)) : `${top.map(sectionHtml).join('')}${addHtml()}${lib.map(sectionHtml).join('')}`}
          </div>
        </div>
      </section>
    `;

    for (const sk of allSkills) {
      const cached = uiState.skillCache.get(sk.id);
      if (cached?.data && sk.updatedAt && cached.updatedAt !== sk.updatedAt) {
        uiState.skillCache.delete(sk.id);
      }
    }

    const loadHomeSkillDetail = async (id) => {
      if (!id) return;
      const summary = allSkills.find((s) => s.id === id);
      uiState.skillCache.set(id, { loading: true });
      paintOverview();
      try {
        const res = await api('/api/skills/' + encodeURIComponent(id));
        const detail = res.skill || res;
        uiState.skillCache.set(id, { data: detail, updatedAt: detail?.updatedAt || summary?.updatedAt || '' });
      } catch (err) {
        uiState.skillCache.set(id, { error: err.message });
      }
      if (seq === renderSeq) paintOverview();
    };
    root.querySelectorAll('[data-skill-read]').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.skillRead;
      if (uiState.expandedSkills.has(id)) {
        uiState.expandedSkills.delete(id);
        if (seq === renderSeq) paintOverview();
      } else {
        uiState.expandedSkills.add(id);
        const summary = allSkills.find((s) => s.id === id);
        const cached = uiState.skillCache.get(id);
        if (!cached?.data || (summary?.updatedAt && cached.updatedAt !== summary.updatedAt)) {
          await loadHomeSkillDetail(id);
        } else if (seq === renderSeq) {
          paintOverview();
        }
      }
    }));
    root.querySelectorAll('[data-skill-retry]').forEach(btn => btn.addEventListener('click', () => {
      loadHomeSkillDetail(btn.dataset.skillRetry);
    }));
    root.querySelectorAll('[data-copy-skill]').forEach(btn => btn.addEventListener('click', () => {
      const cached = uiState.skillCache.get(btn.dataset.copySkill);
      copyText(cached?.data?.content ?? '', 'Copied SKILL.md.');
    }));
    const approvalOnTop = keepApproval();
    if (switcherStale || homeCatShown !== cat) {
      homeCatShown = cat;
      syncTopChrome(latestProfileRecords);
    }
    const listEl = root.querySelector('.ctl-scroll');
    if (listEl) listEl.scrollTop = approvalOnTop ? 0 : listScroll;
    const railEl = root.querySelector('.hm-rail');
    const railList = railEl?.querySelector('.hm-rail-list');
    if (railList) railList.scrollTop = railScroll;
    const pillRow = root.querySelector('.hm-cat-pills');
    if (pillRow) pillRow.scrollLeft = pillScroll;

    const openAdd = () => openAddConnectionPopup(connectionPopupCtx(), { profile: activeProfile });
    if (addFocus) root.querySelector(`#${addFocus}`)?.focus({ preventScroll: true });
    const setAdd = (next, focusSel) => {
      if (root.querySelector('.hm-add .xp-panel')) closeConnectionPopup();
      uiState.homeAdd = next;
      uiState.homeAdded = null;
      if (next !== 'category') { uiState.homeAddName = ''; uiState.homeAddConn = ''; }
      paintOverview();
      root.querySelector(focusSel)?.focus();
    };
    root.querySelector('[data-hm-add-toggle]')?.addEventListener('click', () => setAdd(uiState.homeAdd ? '' : 'list', '[data-hm-add-toggle]'));
    root.querySelector('[data-hm-add="connection"]')?.addEventListener('click', openAdd);
    root.querySelector('[data-hm-add-more]')?.addEventListener('click', () => setAdd('list', '[data-hm-add-copy]'));
    root.querySelector('[data-hm-add-copy]')?.addEventListener('click', () => copyText(`${addPrompt} `, 'Copied. Paste it into your agent.'));
    root.querySelector('[data-hm-add="category"]')?.addEventListener('click', () => {
      const opening = uiState.homeAdd !== 'category';
      setAdd(opening ? 'category' : 'list', opening ? '#hm-add-name' : '[data-hm-add="category"]');
    });
    const addForm = root.querySelector('[data-hm-add-form]');
    addForm?.addEventListener('input', () => {
      uiState.homeAddName = addForm.querySelector('#hm-add-name').value;
      uiState.homeAddConn = addForm.querySelector('#hm-add-first').value;
      addForm.querySelector('.field-err').hidden = true;
      addForm.querySelector('#hm-add-name').removeAttribute('aria-invalid');
    });
    addForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameEl = addForm.querySelector('#hm-add-name');
      const btn = addForm.querySelector('[type=submit]');
      const refuse = (text) => {
        const err = addForm.querySelector('.field-err');
        err.textContent = text;
        err.hidden = false;
      };
      const name = nameEl.value.trim().replace(/\s+/g, ' ');
      if (!/[\p{L}\p{N}]/u.test(name)) {
        nameEl.setAttribute('aria-invalid', 'true');
        refuse('Write a name for the category.');
        nameEl.focus();
        return;
      }
      if (btn.disabled) return;
      btn.disabled = true;
      // A name that already exists moves the connection there instead of making a second category.
      const same = catList.find((c) => String(c.label || c.id).toLowerCase() === name.toLowerCase());
      try {
        const res = await api('/api/categories', {
          method: 'POST',
          body: JSON.stringify({
            ...(same ? { id: same.id, label: same.label || same.id, description: same.description || '' } : { label: name }),
            connections: [addForm.querySelector('#hm-add-first').value],
          }),
        });
        uiState.homeAdd = '';
        uiState.homeAddName = '';
        uiState.homeAddConn = '';
        toast(same ? `Moved it to ${same.label || same.id}.` : `Added ${res?.category?.label || name}.`, 'ok');
        render();
      } catch {
        btn.disabled = false;
        refuse('That did not save. Try again.');
      }
    });
    root.querySelectorAll('[data-hm-import-mac]').forEach((btn) => btn.addEventListener('click', () => {
      openAddConnectionPopup(connectionPopupCtx(), { tab: 'agents', profile: activeProfile });
    }));
    root.querySelectorAll('[data-hm-import-json]').forEach((btn) => btn.addEventListener('click', () => {
      openAddConnectionPopup(connectionPopupCtx(), { tab: 'import', profile: activeProfile });
    }));
    root.querySelectorAll('[data-open-agent]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.openAgent;
        if (id) openAgentPopup(agentPopupCtx({ connName: connLabel }), id);
      });
    });
    root.querySelectorAll('[data-hm-pick-default]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openProfileManager(activeProfile, {
          section: 'items',
          ctx: agentPopupCtx({ connName: connLabel }),
          onChanged: () => render(),
        });
      });
    });
    root.querySelectorAll('[data-hm-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.hmCat || '';
        uiState.homeCatMore = false;
        uiState.homeCat = id;
        uiState.homeJump = id || null;
        paintOverview();
        root.querySelector('.ctl-scroll')?.scrollTo({ top: 0 });
        const picked = [...root.querySelectorAll(`.hm-cat-pills [data-hm-cat="${CSS.escape(id)}"]`)].find((b) => b.offsetParent);
        if (picked) {
          picked.focus({ preventScroll: true });
          picked.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } else {
          root.querySelector('[data-hm-cat-more]')?.focus({ preventScroll: true });
        }
      });
    });
    // The category menu: More at the end of the pills (wide windows).
    const wireCatMenu = (key, opener, boxSel) => {
      root.querySelector(`[${opener}]`)?.addEventListener('click', () => {
        uiState[key] = !uiState[key];
        paintOverview();
        if (uiState[key]) {
          const menu = root.querySelector(`${boxSel} .hm-cat-menu`);
          (menu?.querySelector('[aria-checked="true"]') || menu?.querySelector('.hm-opt'))?.focus();
          // Any click outside the menu closes it.
          const away = (e) => {
            if (e.target.closest?.(boxSel)) return;
            document.removeEventListener('mousedown', away);
            if (!uiState[key]) return;
            uiState[key] = false;
            if (root.isConnected) paintOverview();
          };
          document.addEventListener('mousedown', away);
        } else {
          root.querySelector(`[${opener}]`)?.focus();
        }
      });
      root.querySelector(`${boxSel} .hm-cat-menu`)?.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          uiState[key] = false;
          paintOverview();
          root.querySelector(`[${opener}]`)?.focus();
          return;
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const items = [...root.querySelectorAll(`${boxSel} .hm-cat-menu .hm-opt`)];
        const at = items.indexOf(document.activeElement);
        items[e.key === 'ArrowDown' ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1)]?.focus();
      });
    };
    wireCatMenu('homeCatMore', 'data-hm-cat-more', '.hm-cat-more');
    // Add agent from the welcome box. The other way in is Settings, Agents.
    root.querySelectorAll('[data-hm-add-agent]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openAddAgent(agentPopupCtx({ connName: connLabel }), { project: activeProfile });
      });
    });
    root.querySelectorAll('[data-hm-take]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await api(`/api/people/from/${encodeURIComponent(btn.dataset.hmOf)}/items/${encodeURIComponent(btn.dataset.hmTake)}`, { method: 'POST', body: '{}' });
          toast(`${res.item?.name || 'It'} is in your Loop.`, 'ok');
          if (seq === renderSeq) render();
        } catch (err) {
          btn.disabled = false;
          toast(err.message, 'err');
        }
      });
    });
    root.querySelectorAll('[data-hm-partner-skills]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const connId = btn.dataset.hmPartnerSkills;
        const next = btn.dataset.next === 'true';
        if (!connId) return;
        btn.disabled = true;
        try {
          await api(`/api/mcps/${encodeURIComponent(connId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ partnerSkillsEnabled: next }),
          });
          toast(next ? 'Partner Skills enabled for this connection.' : 'Partner Skills disabled for this connection.', 'ok');
          if (seq === renderSeq) render();
        } catch (err) {
          btn.disabled = false;
          toast(err.message || 'Could not update partner Skills setting.', 'err');
        }
      });
    });
    root.querySelectorAll('[data-open-conn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.openConn;
        if (id) openConnectionPopup(connectionPopupCtx(), id);
      });
    });
    root.querySelectorAll('[data-open-conn-signin]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.openConnSignin;
        if (!id) return;
        startInstantSignIn(id, {
          triggerBtn: btn,
          onFallback: (err) => {
            const target = mcps.find((m) => m.id === id);
            if (target && err?.data?.signInBroken) {
              target.signInBroken = err.data.detail || err.message || 'Sign-in needs input.';
            }
            openConnectionPopup(connectionPopupCtx(), id, {
              focusCredentials: true,
              authModeHint: err?.data?.authModeHint || null,
            });
          },
        });
      });
    });
    root.querySelectorAll('[data-open-conn-connect]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.openConnConnect;
        if (id) openConnectionPopup(connectionPopupCtx(), id, { connectAccount: true });
      });
    });
    root.querySelectorAll('[data-open-conn-creds]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.openConnCreds;
        if (id) openConnectionPopup(connectionPopupCtx(), id, { focusCredentials: true });
      });
    });

    root.querySelectorAll('[data-setup-install-app]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const setupId = btn.dataset.setupInstallApp;
        toast('Install and pair the Loop app on this computer, then install will resume.', 'ok');
        location.hash = `#settings?tab=billing&resume_install=${encodeURIComponent(setupId || '')}`;
      });
    });

    root.querySelector('[data-install-computer]')?.addEventListener('change', event => {
      selectedComputer = event.target.value;
      try { localStorage.setItem('loop.installComputer', selectedComputer); } catch {}
      paintOverview();
    });
    root.querySelectorAll('[data-setup-install]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const setupId = btn.dataset.setupInstall;
        if (!setupId || btn.disabled) return;
        const setup = toolSetups.find((s) => s.id === setupId);
        if (isHostedHome && !selectedComputer && connectDevices.length) {
          root.querySelector('[data-install-computer]')?.focus();
          toast('Choose this computer once to install here.', 'err');
          return;
        }
        const localConfig = { paths: {}, osPermissions: {} };
        const reqs = Array.isArray(setup?.installSpec?.localRequirements) ? setup.installSpec.localRequirements : [];
        for (const reqItem of reqs) {
          if (['folder_path', 'local_path'].includes(reqItem?.kind) && reqItem.required !== false && reqItem.key) {
            const val = await promptDialog({
              title: setup?.name || setupId,
              message: reqItem.label || `Enter local folder path for ${setup?.name || setupId}.`,
              label: 'Folder path',
              placeholder: '/Users/you/Documents/...',
              confirmLabel: 'Continue',
            });
            if (!val || !val.trim()) return;
            localConfig.paths[reqItem.key] = val.trim();
          }
        }
        const prevText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Installing…';
        try {
          const endpointPath = isHostedHome
            ? `/api/connect/tool-setups/${encodeURIComponent(setupId)}/install`
            : `/api/local/tool-setups/${encodeURIComponent(setupId)}/install`;
          const res = await api(endpointPath, {
            method: 'POST',
            body: JSON.stringify({ localConfig, ...(isHostedHome ? { deviceId: selectedComputer } : {}) }),
          });
          if (res?.needsLoopApp) {
            toast(res.message || 'Install and pair the Loop app on this computer first.', 'ok');
            location.hash = `#settings?tab=billing&resume_install=${encodeURIComponent(setupId)}`;
            return;
          }
          if (res?.ok || res?.install?.status === 'ready') {
            toast(`${setup?.name || setupId} is ready on this computer.`, 'ok');
            render();
            return;
          }
          const missing = res?.install?.missingStep || res?.install?.lastError || 'Installation needs attention.';
          toast(missing, 'err');
          render();
        } catch (err) {
          toast(err?.message || 'Could not install tool.', 'err');
          btn.disabled = false;
          btn.textContent = prevText;
        }
      });
    });

    root.querySelectorAll('[data-hm-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.hmToggle;
        if (open.has(id)) open.delete(id);
        else open.add(id);
        saveOpenGroups();
        paintOverview();
        root.querySelector(`[data-hm-toggle="${CSS.escape(id)}"]`)?.focus();
      });
    });
    root.querySelectorAll('[data-hm-approve]').forEach((btn) => btn.addEventListener('click', () => handleApprovalDecision(btn.dataset.hmApprove, true)));
    root.querySelectorAll('[data-hm-approve-agent]').forEach((btn) => btn.addEventListener('click', () => handleApprovalDecision(btn.dataset.hmApproveAgent, true, { alwaysAllow: 'agent' })));
    root.querySelectorAll('[data-hm-approve-always]').forEach((btn) => btn.addEventListener('click', () => handleApprovalDecision(btn.dataset.hmApproveAlways, true, { alwaysAllow: true })));
    root.querySelectorAll('[data-hm-approve-always-conn]').forEach((btn) => btn.addEventListener('click', () => handleApprovalDecision(btn.dataset.hmApproveAlwaysConn, true, { alwaysAllow: 'connection' })));
    root.querySelectorAll('[data-hm-deny]').forEach((btn) => btn.addEventListener('click', () => handleApprovalDecision(btn.dataset.hmDeny, false)));
    root.querySelectorAll('[data-hm-catreq]').forEach((row) => {
      const answer = async (approved) => {
        const btns = [...row.querySelectorAll('.hm-acts button')];
        if (btns.some((b) => b.disabled)) return;
        btns.forEach((b) => { b.disabled = true; });
        try {
          const res = await api(`/api/categories/requests/${encodeURIComponent(row.dataset.hmCatreq)}/${approved ? 'approve' : 'deny'}`, { method: 'POST' });
          toast(approved ? `Moved ${res.moved} ${res.moved === 1 ? 'item' : 'items'} to ${res.label}.` : 'Denied. Agents will not ask about these again.', approved ? 'ok' : '');
          render();
        } catch (err) {
          if (/no longer open/.test(err?.message || '')) { render(); return; }
          btns.forEach((b) => { b.disabled = false; });
          const line = row.querySelector('.field-err');
          line.textContent = 'That did not save. Try again.';
          line.hidden = false;
        }
      };
      row.querySelector('[data-hm-catreq-yes]').addEventListener('click', () => answer(true));
      row.querySelector('[data-hm-catreq-no]').addEventListener('click', () => answer(false));
    });
    root.querySelectorAll('[data-hm-kind]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.hmKind;
        uiState.homeKinds[id] = btn.dataset.kind;
        paintOverview();
        root.querySelector(`[data-hm-kind="${CSS.escape(id)}"][data-kind="${CSS.escape(btn.dataset.kind)}"]`)?.focus();
      });
    });
    root.querySelectorAll('[data-hm-more]').forEach((btn) => {
      btn.addEventListener('click', () => {
        uiState.homeSkillsAll.add(btn.dataset.hmMore);
        paintOverview();
      });
    });
    root.querySelectorAll('[data-hm-fam]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.hmFam;
        if (uiState.homeFamOpen.has(key)) uiState.homeFamOpen.delete(key);
        else uiState.homeFamOpen.add(key);
        paintOverview();
        root.querySelector(`[data-hm-fam="${CSS.escape(key)}"]`)?.focus();
      });
    });
    root.querySelector('#hm-fold')?.addEventListener('click', () => {
      if (anyOpen) foldable.forEach((s) => open.delete(s.id));
      else foldable.forEach((s) => open.add(s.id));
      saveOpenGroups();
      paintOverview();
      root.querySelector('#hm-fold')?.focus();
    });

    const jump = (id) => {
      if (!id) return;
      uiState.homeJump = id;
      uiState.homeJumpUntil = Date.now() + 900;
      if (!open.has(id) && !sections.find((s) => s.id === id)?.pinned) {
        open.add(id);
        saveOpenGroups();
      }
      paintOverview();
      const scroller = root.querySelector('.ctl-scroll');
      const target = root.querySelector(`[data-hm-group="${CSS.escape(id)}"]`);
      if (scroller && target) scroller.scrollTo({ top: target.offsetTop, behavior: 'smooth' });
    };
    root.querySelectorAll('[data-hm-jump]').forEach((btn) => btn.addEventListener('click', () => jump(btn.dataset.hmJump)));

    // The rail follows the list: the group at the top of the scroller is the current one.
    if (listEl && railEl && !viewingSystem) {
      listEl.addEventListener('scroll', () => {
        if (Date.now() < (uiState.homeJumpUntil || 0)) return;
        const top = listEl.scrollTop + 8;
        let current = sections[0]?.id;
        for (const el of listEl.querySelectorAll('[data-hm-group]')) {
          if (el.offsetTop <= top) current = el.dataset.hmGroup;
        }
        if (current === uiState.homeJump) return;
        uiState.homeJump = current;
        railEl.querySelectorAll('[data-hm-jump]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.hmJump === current)));
      }, { passive: true });
    }

    root.querySelector('[data-hm-show-all]')?.addEventListener('click', () => {
      resetHomeSearch(uiState);
      const { params } = parseRoute();
      if (params.has('profile')) {
        params.delete('profile');
        history.replaceState(null, '', '#home' + (params.size ? '?' + params : ''));
      }
      setActiveProfile('all');
      syncTopChrome(profileRecords, { loaded: true, force: true });
      paintOverview();
      root.querySelector('#home-search')?.focus();
    });
    root.querySelector('[data-hm-find]')?.addEventListener('click', () => {
      copyText(findCapabilityPrompt(uiState.homeSearch, activeProfile === 'all' ? '' : activeProfileName), 'Request copied. Paste it into your agent.');
    });
    root.querySelector('#home-search')?.addEventListener('input', (e) => {
      uiState.homeSearch = e.currentTarget.value;
      paintOverview();
      const input = root.querySelector('#home-search');
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
  }

  approvalsOnHome = () => {
    if (seq !== renderSeq || !root.isConnected) return;
    if (isPanelOpenOnPage()) {
      connectionsRefreshWaiting = true;
      return;
    }
    paintOverview();
  };
  paintOverview();
  renderApprovalBanner();
  if (pendingApprovalsFocus && pendingApprovals.length > 0) {
    const scroller = root.querySelector('.ctl-scroll');
    const target = root.querySelector('[data-hm-group="needs"]');
    if (scroller && target) scroller.scrollTo({ top: 0, behavior: 'smooth' });
    pendingApprovalsFocus = false;
  }
}

/* ===========================
   2. VAULT VIEW (#vault)
   =========================== */
async function renderVaultCapture(root, seq, formId) {
  const request = body => api('/api/vault/capture', { method: 'POST', redirect: 'error', cache: 'no-store', body: JSON.stringify(body) });
  const openVaultNow = () => {
    if (location.hash !== '#vault') location.hash = '#vault';
    else render();
  };
  const mountOpenVault = () => {
    root.querySelector('[data-capture-open-vault]')?.addEventListener('click', openVaultNow);
  };
  renderLoading(root, 'Opening secure form…');
  try {
    const { label } = await request({ form: formId });
    if (seq !== renderSeq) return;
    root.innerHTML = '<section data-capture-view><h2>Save a credential</h2><p data-capture-label></p><p>This creates a new Vault item. It does not share the credential with an agent or connection.</p><form autocomplete="off" class="form-grid"><label class="field">Credential<input required type="password" maxlength="65536" autocomplete="off" spellcheck="false"></label><button type="submit" class="btn fill">Save to Vault</button></form><p role="status"></p><div class="acts" data-capture-done hidden><button type="button" class="btn fill" data-capture-open-vault>Open Vault</button></div></section>';
    root.querySelector('[data-capture-label]').textContent = label;
    mountOpenVault();
    const form = root.querySelector('form');
    form.onsubmit = async event => {
      event.preventDefault();
      const button = form.querySelector('button');
      if (button.disabled) return;
      button.disabled = true;
      const input = form.querySelector('input');
      try {
        await request({ form: formId, value: input.value });
        input.value = '';
        form.remove();
        root.querySelector('[role=status]').textContent = 'Saved to Vault. No access was granted.';
        const done = root.querySelector('[data-capture-done]');
        if (done) done.hidden = false;
        if (seq === renderSeq) history.replaceState(null, '', '#vault');
      } catch {
        root.querySelector('[role=status]').textContent = 'Save not confirmed. Check Vault before attempting again.';
        button.disabled = false;
      }
    };
  } catch {
    if (seq === renderSeq) {
      root.innerHTML = '<section data-capture-view><h2>Secure form unavailable</h2><p>This secure form is unavailable. Request a new capture link from Loop.</p><div class="acts"><button type="button" class="btn fill" data-capture-open-vault>Open Vault</button></div></section>';
      mountOpenVault();
    }
  }
}

async function renderVault(root, seq, routeParams = null) {
  if (routeParams?.has('capture')) return renderVaultCapture(root, seq, routeParams.get('capture'));
  const focusKey = routeParams?.get('key') || null;
  renderLoading(root, 'Loading vault…');
  let data;
  let policiesRes;
  try {
    [data, policiesRes] = await Promise.all([
      api('/api/vault'),
      api('/api/policies').catch(() => null),
    ]);
  } catch (err) {
    if (seq !== renderSeq) return;
    renderErrorState(root, err, () => render());
    return;
  }
  if (seq !== renderSeq) return;

  const profileRecords = extractProfileRecords(data);
  syncTopChrome(profileRecords, { loaded: true });
  const secrets = Array.isArray(data.secrets) ? data.secrets : (Array.isArray(data.items) ? data.items : []);
  let policies = normalizePolicies(data.policies || policiesRes);

  root.innerHTML = `
    <dialog class="payment-dialog vf" aria-label="Add card">
      <form id="payment-form" class="vf-form" autocomplete="off">
        <p class="pf-add-hint" id="payment-profile-hint" hidden></p>
        <div class="vf-g">
        <span class="vf-f is-wide"><input name="number" type="text" required inputmode="numeric" pattern="[0-9 ]{12,23}" maxlength="23" placeholder="Card number" aria-label="Card number" enterkeyhint="next"></span>
        <span class="vf-f"><input name="exp" type="text" required inputmode="numeric" pattern="(0[1-9]|1[0-2]) / [0-9]{2}" maxlength="7" placeholder="MM / YY" aria-label="Expiry date" title="Month and year, like 04 / 29"></span>
        <span class="vf-f is-short"><input name="cvv" type="password" required inputmode="numeric" pattern="[0-9]{3,4}" maxlength="4" placeholder="CVV" aria-label="CVV" title="The 3 or 4 digits of the security code"></span>
        <span class="vf-f"><input name="zip" type="text" maxlength="16" placeholder="ZIP" aria-label="ZIP code (optional)" enterkeyhint="done"><button type="submit" class="vf-go" aria-label="Save"><svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5l4 4 8-9"/></svg></button></span>
        </div>
      </form>
    </dialog>
    <dialog class="loop-dialog vault-editor vf" aria-label="Add secret">
      <form id="vault-form" class="vf-form">
        <p class="pf-add-hint" id="vault-profile-hint" hidden></p>
        <input type="hidden" name="type" value="api_key"><input type="hidden" name="category" value="">
        <div class="vf-g">
        <span class="vf-f"><input name="key" type="text" required placeholder="Name" aria-label="Name" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="next"></span>
        <span class="vf-f" id="vault-username-field" hidden><input name="username" type="text" inputmode="email" maxlength="200" placeholder="Username" aria-label="Username or email" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next"></span>
        <span class="vf-f"><input name="value" type="password" required placeholder="Key" aria-label="Key" autocomplete="new-password" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done"><button type="submit" class="vf-go" aria-label="Save"><svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5l4 4 8-9"/></svg></button></span>
        </div>
      </form>
    </dialog>

    <section class="home-connections hm hm-libpage vault-page" aria-label="Vault">
      <div id="vault-top-slot"></div>
      <input type="search" class="ctl-search" id="vault-search" value="${esc(uiState.vaultSearch || '')}" placeholder="Search the vault" aria-label="Search the vault">
      <div class="hm-body">
        <nav class="hm-rail" id="vault-rail" aria-label="On this page"></nav>
        <div class="ctl-scroll" id="vault-list-slot"></div>
      </div>
    </section>
  `;

  let didScrollFocus = false;

  const syncDialogProfileHints = () => {
    const activeProfile = normalizeActiveProfile(profileRecords);
    const activeName = profileNameOf(activeProfile, profileRecords);
    for (const id of ['#payment-profile-hint', '#vault-profile-hint']) {
      const el = root.querySelector(id);
      if (!el) continue;
      if (activeProfile !== 'all') {
        el.hidden = false;
        el.innerHTML = `Will be added to <strong>${esc(activeName)}</strong>`;
      } else {
        el.hidden = true;
        el.textContent = '';
      }
    }
  };

  const vaultSub = () => {
    const activeProfile = normalizeActiveProfile(profileRecords);
    const activeProfileName = profileNameOf(activeProfile, profileRecords);
    const shownCount = secrets.filter((s) => itemInActiveProfile(s, activeProfile)).length;
    return `${esc(shownCount)} ${shownCount === 1 ? 'login, card or key' : 'logins, cards and keys'}${activeProfile !== 'all' ? ` in ${esc(activeProfileName)}` : ''}, kept encrypted`;
  };

  function paintTop() {
    const slot = root.querySelector('#vault-top-slot');
    if (!slot) return;
    slot.innerHTML = pageTop({
      title: 'Vault',
      sub: vaultSub(),
      hideTitle: true,
    });
  }

  // The rules on tools, after the items: one line each, the three choices open under it.
  function toolsHtml() {
    return `
      <section class="vault-group vault-tools" data-rail-group="tools" aria-label="Tools">
        <h2>Tools</h2>
        <ul>${toolRows(policies).map((row) => {
          const id = `tool:${row.id}`;
          const open = uiState.vaultModeOpen === id;
          return `
          <li>
            <button type="button" class="ln" data-vm-open="${esc(id)}" aria-expanded="${open}">
              ${lnIcon(row.icon)}
              <span class="ln-tx"><span class="ln-t">${esc(row.label)}</span></span>
              <span class="ln-v vm-own is-${esc(row.mode)}">${esc(modeLabel(row.mode))}</span>
              ${LN_CHEV}
            </button>
            ${open ? modeChoices({ id, mode: row.mode, label: row.label, floor: row.floor, cap: row.cap }) : ''}
          </li>`;
        }).join('')}</ul>
      </section>`;
  }

  // Rules: a heading or a tool row opens its three choices; a choice saves at once and closes them.
  function wireModes(slot) {
    wireRadioKeys(slot);
    const openMode = (id, focusId = id) => {
      uiState.vaultModeOpen = id;
      paintSecrets();
      slot.querySelector(`[data-vm-open="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
    };
    slot.querySelectorAll('[data-vm-open]').forEach((btn) => btn.addEventListener('click', () => {
      openMode(uiState.vaultModeOpen === btn.dataset.vmOpen ? '' : btn.dataset.vmOpen, btn.dataset.vmOpen);
    }));
    const pick = async (btn, host, opts) => {
      if (btn.getAttribute('aria-checked') === 'true' || host.classList.contains('is-busy')) return;
      host.classList.add('is-busy');
      host.querySelector('.vm-pass')?.remove();
      // Show the choice at once; it goes back when nothing was saved.
      const buttons = [...host.querySelectorAll('[data-vm-pick]')];
      const before = buttons.find((b) => b.getAttribute('aria-checked') === 'true') || null;
      const show = (on) => buttons.forEach((b) => b.setAttribute('aria-checked', String(b === on)));
      show(btn);
      try {
        const res = await saveRule(host, { ...opts, passwordName: passwordName(), onNoPassword: noGuardPassword });
        host.classList.remove('is-busy');
        if (res) opts.saved(res);
        else show(before);
      } catch (err) {
        host.classList.remove('is-busy');
        show(before);
        toast(err.message, 'err');
      }
    };
    slot.querySelectorAll('[data-vm-list]').forEach((list) => {
      const id = list.dataset.vmList;
      const row = id.startsWith('tool:') ? toolRows(policies).find((r) => `tool:${r.id}` === id) : null;
      const what = row ? `“${row.label}”` : kindName(id);
      list.querySelectorAll('[data-vm-pick]').forEach((btn) => btn.addEventListener('click', () => {
        const mode = btn.dataset.vmPick;
        const patch = row ? row.patch(mode) : { vaultTypes: { [id]: mode } };
        pick(btn, list, {
          what,
          send: (password) => api('/api/policies', { method: 'PATCH', body: JSON.stringify({ ...patch, ...(password ? { password } : {}) }) }),
          saved: (res) => {
            policies = normalizePolicies(res);
            openMode('', id);
          },
        });
      }));
    });
    slot.querySelectorAll('[data-vm-item]').forEach((host) => {
      const key = host.dataset.vmItem;
      host.querySelectorAll('[data-vm-pick]').forEach((btn) => btn.addEventListener('click', () => {
        const item = secrets.find((s) => s.key === key);
        if (!item) return;
        const mode = btn.dataset.vmPick;
        // The section's own mode means no rule on the item: it follows the section again.
        const approval = mode === vaultKindMode(normalizeVaultType(item.type), policies) ? 'inherit' : mode;
        pick(btn, host, {
          what: `“${vaultItemName(item)}”`,
          send: (password) => api(`/api/vault/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify({ approval, ...(password ? { password } : {}) }) }),
          saved: (res) => {
            Object.assign(item, res?.secret && typeof res.secret === 'object' ? res.secret : { approval });
            paintSecrets();
            slot.querySelector(`[data-vm-item="${CSS.escape(key)}"] [aria-checked="true"]`)?.focus({ preventScroll: true });
          },
        });
      }));
    });
  }

  function paintSecrets() {
    const slot = root.querySelector('#vault-list-slot');
    if (!slot) return;
    const groups = [
      ['login', 'Logins'],
      ['payment', 'Cards'],
      ['note', 'Personal info'],
      ['api_key', 'API keys'],
    ];
    const expanded = new Set([...slot.querySelectorAll('details[open]')].map(row => row.dataset.secretRow));
    const activeProfile = normalizeActiveProfile(profileRecords);
    const activeProfileName = profileNameOf(activeProfile, profileRecords);
    const sub = root.querySelector('#vault-top-slot .lib-sub');
    if (sub) sub.innerHTML = vaultSub();
    const scopedSecrets = secrets.filter((item) => itemInActiveProfile(item, activeProfile));
    const q = String(uiState.vaultSearch || '').trim().toLowerCase();
    const hit = (item) => !q || `${item.key} ${item.category || ''} ${item.description || ''} ${item.username || ''}`.toLowerCase().includes(q);
    const listScroll = slot.scrollTop;
    // Groups: the four kinds, always. A group says what an item is. A category (Langfuse, SSH keys)
    // is a smaller heading inside the item's kind, never a group of its own.
    const isKind = new Set(groups.map(([kind]) => kind));
    const groupOfItem = (item) => normalizeVaultType(item.type);
    const categoryOf = (item) => (isKind.has(vaultGroupOf(item, groups)) ? '' : String(item.category).trim());
    const custom = new Map();
    for (const item of scopedSecrets) {
      const category = categoryOf(item);
      if (category && !custom.has(category.toLowerCase())) custom.set(category.toLowerCase(), category);
    }
    // Inside a kind: the items with no category first, then each category, A to Z.
    const byCategory = (items) => items
      .map((item, i) => ({ item, i, c: categoryOf(item) }))
      .sort((a, b) => (a.c ? 1 : 0) - (b.c ? 1 : 0) || a.c.localeCompare(b.c, undefined, { sensitivity: 'base' }) || a.i - b.i)
      .map((x) => x.item);
    const allGroups = groups.map(([kind, title]) => ({ kind, title, addType: kind }));
    // Searching hides the groups with nothing that matches, as on Home.
    const shown = allGroups
      .map((g) => {
        const all = scopedSecrets.filter((item) => groupOfItem(item) === g.kind);
        return { ...g, all, items: byCategory(all.filter(hit)) };
      })
      .filter((g) => !q || g.items.length);
    // Groups with something in them come first; empty ones fade and sink to the bottom.
    const fullGroups = shown.filter((g) => g.items.length);
    const emptyGroups = shown.filter((g) => !g.items.length);
    // "Show under" choices for moving an item: its kind (no category), or any category.
    const moveOptions = (item) => {
      const kindTitle = groups.find(([kind]) => kind === normalizeVaultType(item.type))?.[1] || 'its type';
      const current = categoryOf(item);
      return `<option value="" ${current ? '' : 'selected'}>${esc(kindTitle)}</option>
        ${[...custom.values()].sort((a, b) => a.localeCompare(b)).map((c) => `<option value="${esc(c)}" ${c.toLowerCase() === current.toLowerCase() ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        <option value="__new">New category…</option>`;
    };
    const railItems = [
      ...fullGroups.map((g) => ({ id: g.kind, label: g.title, count: g.items.length })),
      ...emptyGroups.map((g) => ({ id: g.kind, label: g.title, count: 0 })),
      ...(q ? [] : [{ id: 'tools', label: 'Tools' }]),
    ];
    // An open form sits in this list; it must not go with the rows that are drawn again.
    slot.querySelectorAll('dialog.vf').forEach((form) => {
      form.close();
      root.prepend(form);
    });
    const rail = root.querySelector('#vault-rail');
    if (rail) rail.innerHTML = railItems.length ? railHtml(railItems, PAGES.vault) : '';
    slot.innerHTML = (shown.length ? '' : '<div class="empty"><p class="et">Nothing matches</p><p class="ed">Try another search.</p></div>')
      + [...fullGroups, ...emptyGroups].map(({ kind, title, items, addType, addCat }) => {
      const kindMode = vaultKindMode(kind, policies);
      const modeOpen = uiState.vaultModeOpen === kind;
      return `
      <section class="vault-group${items.length ? '' : ' is-empty'}" data-rail-group="${esc(kind)}" aria-label="${esc(title)}">
        <h2>${esc(title)}${modeHead({ id: kind, mode: kindMode, open: modeOpen, label: title })}<button type="button" ${addType ? `data-add-type="${addType}"` : `data-add-cat="${esc(addCat)}"`} ><span class="va-add">+ Add<span class="sr-only"> to ${esc(title)}</span></span><span class="va-close"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 4l12 12M16 4L4 16"/></svg><span class="sr-only">Cancel</span></span></button></h2>
        ${modeOpen ? modeChoices({ id: kind, mode: kindMode, label: title }) : ''}
        ${items.length === 0 ? '' : `
          <ul>
            ${items.map((s, i) => {
              const sub = categoryOf(s);
              const subHead = sub && (i === 0 || categoryOf(items[i - 1]).toLowerCase() !== sub.toLowerCase())
                ? `<li class="vault-sub">${esc(sub)}</li>` : '';
              const updated = formatUpdatedAt(s.updatedAt);
              const ref = `{{vault:${s.key}}}`;
              const type = normalizeVaultType(s.type);
              // One line: the name, then the one thing that tells two items apart.
              const name = vaultItemName(s);
              const detail = s.username || (type === 'payment' ? '' : s.description) || '';
              const mode = effectiveSecretApproval(s, policies);
              const sCustomProfiles = customProfilesOf(s);
              const sProfileVal = sCustomProfiles.includes(activeProfile) ? activeProfile : (sCustomProfiles[0] || '');
              return `${subHead}
                <li><details class="secret-row${focusKey === s.key ? ' focus' : ''}" data-secret-row="${esc(s.key)}" ${expanded.has(s.key) || (!didScrollFocus && focusKey === s.key) ? 'open' : ''}>
                  <summary class="ln">
                    ${lnIcon(type)}
                    <span class="ln-tx"><span class="ln-t">${esc(name)}</span>${detail ? `<span class="ln-d">${esc(detail)}</span>` : ''}</span>
                    ${mode === kindMode ? '' : `<span class="ln-v vm-own is-${mode}">${modeLabel(mode)}</span>`}
                    ${LN_CHEV}
                  </summary>
                  <div class="vd">
                    ${modeSegment({ key: s.key, kind: type, mode, kindMode, label: name })}
                    ${name === s.key ? (s.key.length > 24 ? `<p class="vd-note mono">${esc(s.key)}</p>` : '') : ''}
                    ${s.description && type !== 'payment' ? `<p class="vd-note">${esc(s.description)}</p>` : ''}
                    ${s.username ? `
                    <div class="vd-row"><span class="vd-k">Username</span><span class="vd-v">${esc(s.username)}</span></div>` : ''}
                    <div class="vd-row" data-value-row><span class="vd-k">Value</span><span class="vd-v">${esc(s.masked || '••••')}</span><button type="button" class="vd-act" data-reveal="${esc(s.key)}">Show</button></div>
                    <label class="vd-row">
                      <span class="vd-k">Group</span>
                      <span class="ln-sel"><select data-vault-category="${esc(s.key)}" aria-label="Show ${esc(s.key)} under">${moveOptions(s)}</select>${LN_CHEV}</span>
                    </label>
                    ${profileRecords.length > 0 ? `
                    <label class="vd-row">
                      <span class="vd-k">Project</span>
                      <span class="ln-sel"><select
                        data-vault-profile="${esc(s.key)}"
                        data-prev="${esc(sProfileVal)}"
                        aria-label="Project for ${esc(s.key)}"
                      >
                        <option value="" ${!sProfileVal ? 'selected' : ''}>All</option>
                        ${profileRecords.map((rec) => `<option value="${esc(rec.id)}" ${sProfileVal === rec.id ? 'selected' : ''}>${esc(rec.name)}</option>`).join('')}
                      </select>${LN_CHEV}</span>
                    </label>` : ''}
                    <div class="vd-foot">
                      <button type="button" class="vd-act" data-copy-vault="${esc(ref)}">Copy reference</button>
                      <button type="button" class="vd-act is-no" data-del-vault="${esc(s.key)}">Delete</button>
                      ${updated ? `<span class="vd-when">Updated ${esc(updated)}</span>` : ''}
                    </div>
                  </div>
                </details></li>
              `;
            }).join('')}
          </ul>
        `}
      </section>`;
    }).join('') + (q ? '' : toolsHtml());
    slot.scrollTop = listScroll;
    wireSideRail(slot, rail);
    wireModes(slot);

    const editor = root.querySelector('.vault-editor');
    // The section decides what the form asks for. Approval, group and project are on the item's own page.
    const syncVaultFormType = (typeVal, category = '') => {
      const t = normalizeVaultType(typeVal);
      const f = editor.querySelector('form').elements;
      f.type.value = t;
      f.category.value = category;
      editor.querySelector('#vault-username-field').hidden = t !== 'login';
      f.key.parentElement.classList.toggle('is-wide', t === 'login');
      f.key.autocapitalize = t === 'api_key' ? 'characters' : 'words';
      const label = category ? 'Value' : { api_key: 'Key', login: 'Password' }[t] || 'Value';
      f.value.placeholder = label;
      f.value.setAttribute('aria-label', label);
    };
    const resetEditor = () => {
      editor.querySelector('form').reset();
      syncVaultFormType('api_key');
    };
    // The close event comes late: by then the form can be open again in another section.
    editor.onclose = () => { if (!editor.open) resetEditor(); };
    // One form at a time, so the page stays short. A card that is being saved stays open.
    const closeForm = (dialog) => {
      if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
    };
    const openForm = (dialog) => {
      slot.querySelectorAll('dialog.vf[open]').forEach(closeForm);
      if (dialog === editor) resetEditor();
      dialog.showModal();
    };
    slot.querySelectorAll('[data-add-type]').forEach(button => {
      button.onclick = () => {
        syncDialogProfileHints();
        if (button.dataset.addType === 'payment') {
          openForm(paymentDialog);
          return;
        }
        const titles = { login: 'Add login', note: 'Add personal info', api_key: 'Add API key' };
        editor.setAttribute('aria-label', titles[button.dataset.addType]);
        openForm(editor);
        syncVaultFormType(button.dataset.addType);
        editor.querySelector('[name="key"]').focus();
      };
    });
    // A category you or an agent made: add straight into it.
    slot.querySelectorAll('[data-add-cat]').forEach((button) => {
      button.onclick = () => {
        syncDialogProfileHints();
        editor.setAttribute('aria-label', `Add to ${button.dataset.addCat}`);
        openForm(editor);
        syncVaultFormType('api_key', button.dataset.addCat);
        editor.querySelector('[name="key"]').focus();
      };
    });
    // Move an item to another group, or a new one.
    slot.querySelectorAll('[data-vault-category]').forEach((select) => {
      const before = select.value;
      select.addEventListener('change', async () => {
        const key = select.dataset.vaultCategory;
        let category = select.value;
        if (category === '__new') {
          const entered = await promptDialog({
            title: 'New Vault group',
            label: 'Group name',
            placeholder: 'e.g. Work, Finance, Travel',
            confirmLabel: 'Create group',
          });
          category = String(entered || '').trim();
          if (!category) {
            select.value = before;
            return;
          }
        }
        select.disabled = true;
        try {
          const res = await api(`/api/vault/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify({ category }) });
          const item = secrets.find((x) => x.key === key);
          if (item) item.category = res?.secret?.category ?? category;
          toast(category ? `Moved to ${category}.` : 'Moved back under its type.', 'ok');
          paintSecrets();
        } catch (err) {
          toast(err.message, 'err');
          select.value = before;
          select.disabled = false;
        }
      });
    });

    slot.querySelectorAll('[data-vault-profile]').forEach((select) => {
      select.addEventListener('change', async () => {
        const key = select.dataset.vaultProfile;
        const prev = select.dataset.prev || '';
        const val = select.value;
        const nextProfiles = val ? [val] : ['all'];
        select.disabled = true;
        try {
          const res = await api(`/api/vault/${encodeURIComponent(key)}`, {
            method: 'PATCH',
            body: JSON.stringify({ profiles: nextProfiles }),
          });
          const idx = secrets.findIndex((item) => item.key === key);
          if (idx !== -1) {
            secrets[idx] = {
              ...secrets[idx],
              ...(res?.secret && typeof res.secret === 'object' ? res.secret : {}),
              profiles: res?.secret?.profiles ?? nextProfiles,
            };
          }
          toast(val ? `Moved "${key}" to ${profileNameOf(val, profileRecords)}.` : `Moved "${key}" to All.`, 'ok');
          paintTop();
          paintSecrets();
        } catch (err) {
          select.value = prev;
          select.disabled = false;
          toast(err.message, 'err');
        }
      });
    });

    slot.querySelectorAll('[data-copy-vault]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ref = btn.dataset.copyVault;
        copyText(ref, `Copied ${ref}`);
      });
    });

    if (focusKey && !didScrollFocus) {
      const focused = slot.querySelector('.secret-row.focus');
      if (focused) {
        didScrollFocus = true;
        focused.scrollIntoView({ block: 'center' });
      }
    }

    // Showing a value always asks for the Loop password again, and hides it after 30 seconds.
    slot.querySelectorAll('[data-reveal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (auth.mode === 'clerk' && !auth.vaultPasswordSet) {
          openSettings('vault');
          return;
        }
        const key = btn.dataset.reveal;
        const row = btn.closest('[data-secret-row]');
        if (!row) return;
        const existingBox = row.querySelector('.reveal-box');
        if (existingBox) {
          clearTimeout(existingBox._hideTimer);
          existingBox.remove();
          btn.textContent = 'Show';
          return;
        }
        const box = document.createElement('form');
        box.className = 'reveal-box';
        box.innerHTML = `
          <input name="password" type="password" required autocomplete="current-password" placeholder="Password" aria-label="${auth.mode === 'clerk' ? 'Vault' : 'Loop'} password to show ${esc(key)}">
          <button type="submit" class="btn sm fill">Show</button>
          <button type="button" class="vd-act" data-cancel-reveal>Cancel</button>
        `;
        const hideBox = () => {
          clearTimeout(box._hideTimer);
          box.remove();
          if (btn.isConnected) btn.textContent = 'Show';
        };
        btn.closest('[data-value-row]').after(box);
        box.querySelector('input')?.focus();
        box.querySelector('[data-cancel-reveal]')?.addEventListener('click', hideBox);
        box.addEventListener('submit', async (e) => {
          e.preventDefault();
          const password = String(new FormData(box).get('password') || '');
          const submit = box.querySelector('button[type="submit"]');
          submit.disabled = true;
          try {
            const res = await api(`/api/vault/${encodeURIComponent(key)}/reveal`, {
              method: 'POST',
              body: JSON.stringify({ password }),
            });
            box.innerHTML = `
              <pre class="code">${esc(res.value)}</pre>
              <span class="vd-when">Hides in 30 seconds</span>
              <button type="button" class="vd-act" data-copy-revealed>Copy</button>
            `;
            box.classList.add('is-shown');
            btn.textContent = 'Hide';
            box.querySelector('[data-copy-revealed]')?.addEventListener('click', () => copyText(res.value, 'Copied value.'));
            box._hideTimer = setTimeout(hideBox, 30000);
          } catch (err) {
            toast(err.message, 'err');
            submit.disabled = false;
          }
        });
      });
    });

    slot.querySelectorAll('[data-del-vault]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.delVault;
        const ok = await confirmDialog({
          title: `Delete "${key}"?`,
          message: `Any connection or agent using {{vault:${key}}} will stop working.`,
          confirmLabel: 'Delete secret',
          danger: true,
        });
        if (!ok) return;
        btn.disabled = true;
        btn.textContent = 'Deleting…';
        try {
          await api(`/api/vault/${encodeURIComponent(key)}`, { method: 'DELETE' });
          toast(`Deleted secret "${key}".`, 'ok');
          renderVault(root, seq);
        } catch (err) {
          toast(err.message, 'err');
          btn.disabled = false;
          btn.textContent = 'Delete';
        }
      });
    });
  }

  const paymentDialog = root.querySelector('.payment-dialog');
  const paymentForm = paymentDialog.querySelector('form');
  const numberInput = paymentForm.elements.number;
  const expInput = paymentForm.elements.exp;
  paymentForm.oninput = (event) => {
    if (event.target === expInput) {
      let d = expInput.value.replace(/[^0-9]/g, '');
      if (d.length === 6) d = d.slice(0, 2) + d.slice(4);
      if (/^[2-9]/.test(d)) d = `0${d}`;
      const deleting = event.inputType?.startsWith('delete');
      expInput.value = d.length > 2 || (d.length === 2 && !deleting) ? `${d.slice(0, 2)} / ${d.slice(2, 4)}` : d;
      if (d.length >= 4 && expInput.matches(':valid')) paymentForm.elements.cvv.focus();
    }
    const digits = numberInput.value.replace(/ /g, '');
    // Groups like the ones on the card (4-6-5 on Amex), only while the cursor is at the end.
    const amex = /^3[47]/.test(digits);
    if (event.target === numberInput && /^[0-9]+$/.test(digits) && numberInput.selectionStart === numberInput.value.length) {
      numberInput.value = (amex ? digits.replace(/^(.{4})(.{1,6})(.*)$/, '$1 $2 $3') : digits.replace(/(.{4})/g, '$1 ')).trim();
    }
    numberInput.setCustomValidity(/^[0-9]{12,19}$/.test(digits) ? '' : 'Enter a valid card number.');
    // A number pad has no Next key, so a full number goes on to the date.
    if (event.target === numberInput && !event.inputType?.startsWith('delete') && digits.length === (amex ? 15 : 16) && !expInput.value && numberInput.matches(':valid')) expInput.focus();
  };
  // Enter (Next on a phone keyboard) goes to the next empty field, and saves when none is left.
  root.querySelectorAll('.vf-form').forEach((form) => form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.target.tagName !== 'INPUT') return;
    const fields = [...form.querySelectorAll('input')].filter((f) => f.offsetParent);
    const next = fields.slice(fields.indexOf(e.target) + 1).find((f) => !f.value);
    if (!next) return;
    e.preventDefault();
    next.focus();
  }));
  paymentDialog.onclose = () => {
    paymentForm.reset();
    numberInput.setCustomValidity('');
  };
  paymentForm.onsubmit = async event => {
    event.preventDefault();
    if (paymentForm.inert) return;
    const fields = Object.fromEntries(new FormData(paymentForm));
    const number = fields.number.replace(/ /g, '');
    const brand = [[/^4/, 'Visa'], [/^(5[1-5]|2[2-7])/, 'Mastercard'], [/^3[47]/, 'Amex'], [/^6(011|4|5)/, 'Discover']].find(([re]) => re.test(number))?.[1] || 'Card';
    const name = `${brand} ${number.slice(-4)}`;
    const [expiryMonth, expiryYear] = fields.exp.split(' / ');
    const key = 'CARD_' + crypto.randomUUID().replaceAll('-', '');
    const value = JSON.stringify({ number, expiryMonth, expiryYear,
      cvv: fields.cvv, billingZip: fields.zip.trim(), lastFour: number.slice(-4) });
    const activeProfile = normalizeActiveProfile(profileRecords);
    paymentForm.inert = true;
    paymentDialog.classList.add('is-busy');
    paymentDialog.oncancel = event => event.preventDefault();
    try {
      await api('/api/vault', { method: 'POST', body: JSON.stringify({
        key, value, type: 'payment', description: name, approval: 'inherit',
        ...(activeProfile !== 'all' ? { profiles: [activeProfile] } : {}),
      }) });
      paymentDialog.close();
      toast('Card saved.', 'ok');
      if (seq === renderSeq) renderVault(root, seq);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      paymentForm.inert = false;
      paymentDialog.classList.remove('is-busy');
      paymentDialog.oncancel = null;
    }
  };

  root.querySelector('#vault-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (form.inert) return;
    const fd = new FormData(form);
    // A Vault name has no spaces: "github login" is saved as github_login.
    const key = String(fd.get('key') || '').trim().replace(/\s+/g, '_');
    const value = String(fd.get('value') || '');
    const username = String(fd.get('username') || '').trim();
    const type = normalizeVaultType(fd.get('type'));
    const category = String(fd.get('category') || '').trim();
    if (!key || !value) return;
    const activeProfile = normalizeActiveProfile(profileRecords);
    const payload = {
      key,
      value,
      type,
      ...(type === 'login' && username ? { username } : {}),
      ...(category ? { category } : {}),
      ...(activeProfile !== 'all' ? { profiles: [activeProfile] } : {}),
    };
    const typeLabels = { api_key: 'API key', login: 'login', payment: 'card', note: 'personal info' };

    form.inert = true;
    form.parentElement.classList.add('is-busy');
    try {
      await api('/api/vault', { method: 'POST', body: JSON.stringify(payload) });
      toast(`Saved secret "${key}".`, 'ok');
      renderVault(root, seq);
    } catch (err) {
      if (err?.status === 409 && err?.data?.code === 'VAULT_EXISTS') {
        const existing = err.data.existing || secrets.find((s) => s.key === key) || { key, type: 'api_key', approval: 'inherit' };
        const beforeType = normalizeVaultType(existing.type);
        const beforeMode = err.data.existingApproval || effectiveSecretApproval(existing, policies);
        const afterMode = effectiveSecretApproval({ ...existing, type }, policies);
        const who = existing.username ? ` (${existing.username})` : '';
        const parts = [
          `"${key}" already exists as a ${typeLabels[beforeType] || beforeType}${who}.`,
          beforeType !== type
            ? `Replacing it changes its type to ${typeLabels[type] || type}.`
            : 'Replacing it overwrites the saved value.',
          beforeMode !== afterMode
            ? `Its approval rule will change from ${modeLabel(beforeMode)} to ${modeLabel(afterMode)}.`
            : `Its approval rule stays ${modeLabel(beforeMode)}.`,
          'Cancel keeps the existing item unchanged.',
        ];
        const ok = await confirmDialog({
          title: `Replace "${key}"?`,
          message: parts.join(' '),
          confirmLabel: 'Replace item',
          danger: true,
        });
        if (!ok) {
          form.inert = false;
          form.parentElement.classList.remove('is-busy');
          return;
        }
        try {
          await api('/api/vault', { method: 'POST', body: JSON.stringify({ ...payload, overwrite: true }) });
          toast(`Replaced secret "${key}".`, 'ok');
          renderVault(root, seq);
          return;
        } catch (replaceErr) {
          toast(replaceErr.message, 'err');
          form.inert = false;
          form.parentElement.classList.remove('is-busy');
          return;
        }
      }
      toast(err.message, 'err');
      form.inert = false;
      form.parentElement.classList.remove('is-busy');
    }
  });

  paintTop();
  paintSecrets();
  root.querySelector('#vault-search')?.addEventListener('input', (e) => {
    uiState.vaultSearch = e.currentTarget.value;
    paintSecrets();
  });
}

/* ===========================
   2B. SKILLS BROWSER (#skills)
   =========================== */
function slugifyCategoryLabel(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'general';
}

function normalizeSkillsCatalog(data) {
  const rawSkills = Array.isArray(data?.skills) ? data.skills : [];
  const rawCats = Array.isArray(data?.categories) ? data.categories : [];

  const catOrder = [];
  const catById = new Map();
  const catByLabel = new Map();
  const skillToCat = new Map();

  function registerCategory(idRaw, labelRaw) {
    const label = String(labelRaw || idRaw || 'General').trim() || 'General';
    const id = slugifyCategoryLabel(idRaw || label);
    if (!catById.has(id)) {
      const entry = { id, label };
      catById.set(id, entry);
      catByLabel.set(label.toLowerCase(), entry);
      catOrder.push(id);
    }
    return catById.get(id);
  }

  for (const c of rawCats) {
    if (typeof c === 'string') {
      registerCategory(c, c);
      continue;
    }
    if (!c || typeof c !== 'object') continue;
    const entry = registerCategory(c.id || c.label, c.label || c.id);
    if (Array.isArray(c.skills)) {
      for (const s of c.skills) {
        const sid = typeof s === 'string' ? s : s?.id;
        if (sid) skillToCat.set(String(sid), entry);
      }
    }
  }

  const skills = rawSkills.map((s) => {
    let cat = null;
    if (s.category && typeof s.category === 'object') {
      cat = registerCategory(s.category.id || s.category.label, s.category.label || s.category.id);
    } else if (typeof s.category === 'string' && s.category.trim()) {
      const clean = s.category.trim();
      cat = catById.get(slugifyCategoryLabel(clean))
        || catByLabel.get(clean.toLowerCase())
        || registerCategory(clean, clean);
    } else if (s.categoryId || s.categoryLabel) {
      const existing = s.categoryId ? catById.get(slugifyCategoryLabel(s.categoryId)) : null;
      cat = existing || registerCategory(s.categoryId || s.categoryLabel, s.categoryLabel || s.categoryId);
    } else if (skillToCat.has(String(s.id))) {
      cat = skillToCat.get(String(s.id));
    } else {
      cat = registerCategory('general', 'General');
    }

    const bundled = isSystemSkill(s);
    return {
      ...s,
      id: bundled ? s.systemId : s.id,
      _cat: cat,
      _bundled: bundled,
    };
  });

  const counts = new Map();
  for (const s of skills) {
    counts.set(s._cat.id, (counts.get(s._cat.id) || 0) + 1);
  }

  const activeCategories = catOrder
    .filter((id) => (counts.get(id) || 0) > 0)
    .map((id) => ({ ...catById.get(id), count: counts.get(id) }));

  // Keep General at the end if present alongside other categories.
  const nonGeneral = activeCategories.filter((c) => c.id !== 'general');
  const general = activeCategories.filter((c) => c.id === 'general');

  return {
    skills,
    categories: [...nonGeneral, ...general],
  };
}

function renderProfileChipsEditor(item, profileRecords, { dataAttr, itemId, label, kindLabel }) {
  const list = Array.isArray(profileRecords) ? profileRecords : [];
  if (list.length === 0) return '';
  const current = new Set((Array.isArray(item?.profiles) ? item.profiles : []).filter((p) => p && p !== 'all'));
  return `
    <div class="drawer-sec">
      <div class="drawer-rule-copy">
        <span class="drawer-rule-title">Projects</span>
        <span class="d sm">Choose which isolated projects can see and use this ${esc(kindLabel)}.</span>
      </div>
      <div class="pf-chips" role="group" aria-label="Projects for ${esc(label)}">
        ${list.map((rec) => {
          const on = current.has(rec.id);
          return `<button type="button" class="pf-chip" ${dataAttr}="${esc(itemId)}" data-profile-id="${esc(rec.id)}" aria-pressed="${on}">
            <span class="pf-chip-ic" aria-hidden="true">${on ? PF_CHECK_ICON : ''}</span>
            <span>${esc(rec.name)}</span>
          </button>`;
        }).join('')}
      </div>
    </div>
  `;
}

function renderSkillDrawer(skill, cached, profileRecords = []) {
  // Projects are hidden in the dashboard, so the skill drawer has no Projects editor.
  const profilesSection = PROJECTS_IN_UI && !isSystemSkill(skill) ? renderProfileChipsEditor(skill, profileRecords, {
    dataAttr: 'data-skill-profile',
    itemId: skill.id,
    label: skill.name || skill.id,
    kindLabel: 'skill',
  }) : '';

  if (!cached || cached.loading) {
    return `
      <div class="conn-drawer">
        ${profilesSection}
        <div class="skill-drawer-loading" role="status">
          <span class="spin sm" aria-hidden="true"></span>
          <span>Loading SKILL.md…</span>
        </div>
      </div>
    `;
  }

  if (cached.error) {
    return `
      <div class="conn-drawer">
        ${profilesSection}
        <div class="callout bad" role="alert">
          <p>${esc(cached.error)}</p>
          <div class="acts">
            <button type="button" class="btn sm" data-skill-retry="${esc(skill.id)}">Try again</button>
          </div>
        </div>
      </div>
    `;
  }

  const detail = cached.data || {};
  const content = typeof detail.content === 'string' ? detail.content : '';
  const files = Array.isArray(detail.files)
    ? detail.files
    : (Array.isArray(skill.files) ? skill.files : []);

  return `
    <div class="conn-drawer">
      ${profilesSection}
      <div class="drawer-sec">
        <div class="drawer-title">
          <span>SKILL.md</span>
          <span class="mono">${esc(skill.id)}</span>
        </div>
        <div class="codewrap">
          <div class="skill-markdown">${renderSkillMarkdown(content || '(Empty SKILL.md)')}</div>
          <button type="button" class="btn sm copybtn" data-copy-skill="${esc(skill.id)}">Copy</button>
        </div>
      </div>

      ${files.length > 0 ? `
        <div class="drawer-sec">
          <div class="drawer-title"><span>Bundled files (${esc(files.length)})</span></div>
          <div class="skill-files">
            ${files.map((f) => `<span class="schema-param">${esc(f)}</span>`).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function renderSkillCard(skill, profileRecords = []) {
  const isExpanded = uiState.expandedSkills.has(skill.id);
  const cached = uiState.skillCache.get(skill.id);
  const fileCount = Array.isArray(skill.files) ? skill.files.length : 0;
  const customProfiles = customProfilesOf(skill);

  return `
    <article class="conn-card">
      <div class="conn-head">
        <div class="conn-top">
          <div class="conn-info">
            <div class="conn-meta">
              <span class="conn-title">${esc(skill.name || skill.id)}</span>
              <span class="tag profile">${esc(skill._cat.label)}</span>
              ${customProfiles.map((p) => `<span class="tag profile">${esc(profileNameOf(p, profileRecords))}</span>`).join('')}
              ${skill._bundled
                ? '<span class="tag info">Loop built-in</span>'
                : (skill.source ? `<span class="tag muted">${esc(skill.source)}</span>` : '')}
              ${fileCount > 0 ? `<span class="tag muted">${esc(fileCount)} file${fileCount === 1 ? '' : 's'}</span>` : ''}
            </div>
            ${skill.description ? `<div class="d">${esc(skill.description)}</div>` : ''}
          </div>
          <div class="conn-acts">
            <button type="button" class="btn sm" data-skill-read="${esc(skill.id)}" aria-expanded="${isExpanded}">
              ${isExpanded ? 'Hide' : 'Read'}
            </button>
            ${skill._bundled ? '' : `<button type="button" class="btn sm ghost" data-skill-del="${esc(skill.id)}">Remove</button>`}
          </div>
        </div>
      </div>
      ${isExpanded ? renderSkillDrawer(skill, cached, profileRecords) : ''}
    </article>
  `;
}

async function renderSkills(root, seq, routeParams = null) {
  // Skills are a part of Library. A link can name a skill or a family of skills as #skills?q=<name>,
  // or a category as #knowledge/skills?cat=<id> (the Skills row in a Home category).
  const askedFor = routeParams?.get('q');
  const askedCat = routeParams?.get('cat');
  if (askedFor) uiState.skillSearch = askedFor;
  if (askedCat) {
    uiState.skillCategory = askedCat;
    if (!askedFor) uiState.skillSearch = '';
  }
  if (askedFor || askedCat) history.replaceState(null, '', '#knowledge/skills');
  renderLoading(root, 'Loading skills…');
  let data;
  try {
    data = await api('/api/skills');
  } catch (err) {
    if (seq !== renderSeq) return;
    renderErrorState(root, err, () => render());
    return;
  }
  if (seq !== renderSeq) return;

  const profileRecords = extractProfileRecords(data);
  syncTopChrome(profileRecords, { loaded: true });
  let rawSkills = Array.isArray(data.skills) ? data.skills : [];
  for (const s of rawSkills) {
    const cached = uiState.skillCache.get(s.id);
    if (cached?.data && s.updatedAt && cached.updatedAt !== s.updatedAt) {
      uiState.skillCache.delete(s.id);
    }
  }

  // The same frame as the other parts of Library. The parts are in the side menu: the rail on a
  // wide window, and the names at the left edge (home-scrubber.js) on a narrow one.
  root.innerHTML = `
    <section class="home-connections hm hm-libpage brain-page skills-page" aria-label="${BRAIN_NAME}">
      ${pageTop({ title: BRAIN_NAME, sub: '', hideTitle: true })}
      <input type="search" class="ctl-search" id="skills-search" value="${esc(uiState.skillSearch)}" placeholder="Search skills" aria-label="Search skills">
      <div class="hm-body">
        <nav class="hm-rail brain-rail" aria-label="Parts of ${BRAIN_NAME}">
          <div class="hm-rail-k">${BRAIN_NAME}</div>
          <div class="hm-rail-list" id="skills-rail-list">${BRAIN_PARTS.map((p) => brainRow(p.id, 'skills', p.id === 'skills' ? rawSkills.length : undefined)).join('')}</div>
        </nav>
        <div class="ctl-scroll">
          <div class="saved-page skills-list">
            <div id="skills-profile-bar"></div>
            <div id="skills-chips"></div>
            <div id="skills-body"></div>
          </div>
        </div>
      </div>
    </section>
  `;
  wireBrainRows(root.querySelector('.brain-rail'));
  brainCounts(api).then((counts) => {
    if (seq !== renderSeq) return;
    const list = root.querySelector('#skills-rail-list');
    if (!list) return;
    list.innerHTML = BRAIN_PARTS.map((p) => brainRow(p.id, 'skills', p.id === 'skills' ? rawSkills.length : counts[p.id])).join('');
    wireBrainRows(root.querySelector('.brain-rail'));
  });

  async function loadSkillDetail(id) {
    const summary = rawSkills.find((s) => s.id === id);
    uiState.skillCache.set(id, { loading: true, error: null, data: null });
    paintList();
    try {
      const res = await api(`/api/skills/${encodeURIComponent(id)}`);
      const detail = res?.skill && typeof res.skill === 'object' ? res.skill : res;
      uiState.skillCache.set(id, {
        loading: false,
        error: null,
        data: detail,
        updatedAt: detail?.updatedAt || summary?.updatedAt || '',
      });
    } catch (err) {
      uiState.skillCache.set(id, { loading: false, error: err.message || 'Could not load skill.', data: null });
    }
    if (seq === renderSeq) paintList();
  }

  function paintList() {
    const chipsSlot = root.querySelector('#skills-chips');
    const bodySlot = root.querySelector('#skills-body');
    const profileBar = root.querySelector('#skills-profile-bar');
    const introEl = root.querySelector('#skills-intro');
    if (!chipsSlot || !bodySlot) return;

    const activeProfile = normalizeActiveProfile(profileRecords);
    const activeProfileName = profileNameOf(activeProfile, profileRecords);
    const scopedRawSkills = rawSkills.filter((s) => itemInActiveProfile(s, activeProfile));
    const catalog = normalizeSkillsCatalog({ skills: scopedRawSkills, categories: data.categories });

    if (introEl) {
      introEl.textContent = activeProfile !== 'all'
        ? `Skills in ${activeProfileName}.`
        : 'Playbooks and instructions in Loop.';
    }
    if (profileBar) {
      profileBar.innerHTML = activeProfile !== 'all' ? `
        <div class="pf-scope-bar">
          <span>Showing skills in <b>${esc(activeProfileName)}</b> (${esc(scopedRawSkills.length)} of ${esc(rawSkills.length)})</span>
          <button type="button" class="hm-inline" data-pf-show-all>Show All to assign existing</button>
        </div>` : '';
      profileBar.querySelector('[data-pf-show-all]')?.addEventListener('click', () => {
        setActiveProfile('all');
        syncTopChrome(profileRecords, { loaded: true, force: true });
        paintList();
      });
    }

    const { skills, categories } = catalog;
    if (uiState.skillCategory !== 'all' && !categories.some((c) => c.id === uiState.skillCategory)) {
      uiState.skillCategory = 'all';
    }

    chipsSlot.innerHTML = categories.length > 0 ? `
      <div class="chips chips-scroll" role="group" aria-label="Filter skills by category">
        <button type="button" class="chip" data-skill-cat="all" aria-pressed="${uiState.skillCategory === 'all'}">
          All <span>${esc(skills.length)}</span>
        </button>
        ${categories.map((c) => `
          <button type="button" class="chip" data-skill-cat="${esc(c.id)}" aria-pressed="${uiState.skillCategory === c.id}">
            ${esc(c.label)} <span>${esc(c.count)}</span>
          </button>
        `).join('')}
      </div>
    ` : '';

    const rawQuery = uiState.skillSearch.trim().toLowerCase();
    const tokens = rawQuery ? rawQuery.split(/\s+/).filter(Boolean) : [];

    const filtered = skills.filter((s) => {
      if (uiState.skillCategory !== 'all' && s._cat.id !== uiState.skillCategory) return false;
      if (tokens.length === 0) return true;
      const haystack = `${isSystemSkill(s) ? `system ${systemTitle(s)}` : ''} ${s.id || ''} ${s.name || ''} ${s.description || ''} ${s.source || ''} ${s._cat.label} ${s._cat.id}`.toLowerCase();
      return tokens.every((t) => haystack.includes(t));
    });

    if (skills.length === 0) {
      bodySlot.innerHTML = activeProfile !== 'all' && rawSkills.length > 0 ? `
        <div class="empty">
          <p class="et">No skills in ${esc(activeProfileName)} yet</p>
          <p class="ed">Pick existing skills from All or switch back to All.</p>
          <div class="acts">
            <button type="button" class="btn sm fill" data-pf-pick-default>Pick from All</button>
            <button type="button" class="btn sm" data-pf-show-all>Show All</button>
          </div>
        </div>
      ` : `
        <div class="empty">
          <p class="et">No skills yet</p>
          <p class="ed">${canImportFromMac() ? 'Import skills from your installed agents or save a skill to Loop.' : 'Save a skill to Loop for your agents.'}</p>
        </div>
      `;
    } else if (filtered.length === 0) {
      bodySlot.innerHTML = `
        <div class="empty">
          <p class="et">No matching skills</p>
          <p class="ed">Try another search phrase or switch back to all categories.</p>
          <div class="acts center">
            <button type="button" class="btn sm" id="skills-clear-filter">Clear filter</button>
          </div>
        </div>
      `;
    } else {
      const systemHtml = renderSystemSection(filtered, {
        esc, expanded: uiState.expandedSkills,
        drawer: (s) => renderSkillDrawer(s, uiState.skillCache.get(s.id)),
      });
      const userSkills = filtered.filter((s) => !isSystemSkill(s));
      const userHtml = categories.map((cat) => {
        const group = userSkills.filter((s) => s._cat.id === cat.id);
        if (!group.length) return '';
        return `<section class="skill-group" aria-label="${esc(cat.label)}"><h3>${esc(cat.label)} <small>${group.length}</small></h3>
          <div class="conn-list">${group.map((s) => renderSkillCard(s, profileRecords)).join('')}</div></section>`;
      }).join('');
      bodySlot.innerHTML = systemHtml + (userSkills.length ? `<section class="skill-group" aria-label="Your skills"><h2>Your skills <small>${userSkills.length}</small></h2>${userHtml}</section>` : '');
    }

    // The chosen category's chip is in view, also when the chips scroll sideways. The page can be drawn
    // while it is still hidden (before the swap to the new page), so wait until the row has a width.
    const showPickedChip = (tries = 20) => {
      const picked = chipsSlot.querySelector('[data-skill-cat][aria-pressed="true"]');
      const row = picked?.parentElement;
      if (!picked || !row || !chipsSlot.isConnected) return;
      if (!row.clientWidth) {
        if (tries > 0) requestAnimationFrame(() => showPickedChip(tries - 1));
        return;
      }
      const left = picked.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft;
      if (row.scrollWidth > row.clientWidth) row.scrollLeft = Math.max(0, left - 16);
    };
    showPickedChip();
    chipsSlot.querySelectorAll('[data-skill-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        uiState.skillCategory = btn.dataset.skillCat;
        paintList();
      });
    });

    bodySlot.querySelectorAll('[data-pf-show-all]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setActiveProfile('all');
        syncTopChrome(profileRecords, { loaded: true, force: true });
        paintList();
      });
    });
    bodySlot.querySelectorAll('[data-pf-pick-default]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openProfileManager(activeProfile, {
          section: 'items',
          onChanged: () => renderSkills(root, seq),
        });
      });
    });

    bodySlot.querySelector('#skills-clear-filter')?.addEventListener('click', () => {
      uiState.skillSearch = '';
      uiState.skillCategory = 'all';
      const searchInput = root.querySelector('#skills-search');
      if (searchInput) searchInput.value = '';
      paintList();
    });

    bodySlot.querySelectorAll('[data-skill-read]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.skillRead;
        if (uiState.expandedSkills.has(id)) {
          uiState.expandedSkills.delete(id);
          paintList();
          return;
        }
        uiState.expandedSkills.add(id);
        const summary = rawSkills.find((s) => s.id === id);
        const cached = uiState.skillCache.get(id);
        if (!cached?.data || cached.error || (summary?.updatedAt && cached.updatedAt !== summary.updatedAt)) {
          loadSkillDetail(id);
        } else {
          paintList();
        }
      });
    });

    bodySlot.querySelectorAll('[data-skill-profile]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.skillProfile;
        const profileId = btn.dataset.profileId;
        const target = rawSkills.find((s) => s.id === id);
        if (!target || !profileId) return;
        const nextSet = new Set((Array.isArray(target.profiles) ? target.profiles : []).filter((p) => p && p !== 'all'));
        const removing = nextSet.has(profileId);
        if (removing) nextSet.delete(profileId);
        else nextSet.add(profileId);
        const nextProfiles = nextSet.size > 0 ? Array.from(nextSet).sort((a, b) => a.localeCompare(b)) : ['all'];
        btn.disabled = true;
        try {
          const res = await api(`/api/skills/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ profiles: nextProfiles }),
          });
          target.profiles = Array.isArray(res?.skill?.profiles) ? res.skill.profiles : nextProfiles;
          const cached = uiState.skillCache.get(id);
          if (cached?.data) cached.data.profiles = target.profiles;
          const pName = profileNameOf(profileId, profileRecords);
          toast(removing ? `Removed "${target.name || id}" from ${pName}.` : `Added "${target.name || id}" to ${pName}.`, 'ok');
          paintList();
        } catch (err) {
          toast(err.message, 'err');
          btn.disabled = false;
        }
      });
    });

    bodySlot.querySelectorAll('[data-skill-retry]').forEach((btn) => {
      btn.addEventListener('click', () => {
        loadSkillDetail(btn.dataset.skillRetry);
      });
    });

    bodySlot.querySelectorAll('[data-copy-skill]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cached = uiState.skillCache.get(btn.dataset.copySkill);
        const content = cached?.data?.content ?? '';
        copyText(content, 'Copied SKILL.md.');
      });
    });

    bodySlot.querySelectorAll('[data-skill-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.skillDel;
        const target = rawSkills.find((s) => s.id === id);
        const ok = await confirmDialog({
          title: `Remove skill "${target?.name || id}"?`,
          message: 'Agents will no longer find or load this skill from Loop.',
          confirmLabel: 'Remove skill',
          danger: true,
        });
        if (!ok) return;
        btn.disabled = true;
        btn.textContent = 'Removing…';
        try {
          await api(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
          uiState.expandedSkills.delete(id);
          uiState.skillCache.delete(id);
          rawSkills = rawSkills.filter((s) => s.id !== id);
          toast(`Removed skill "${target?.name || id}".`, 'ok');
          paintList();
        } catch (err) {
          toast(err.message, 'err');
          btn.disabled = false;
          btn.textContent = 'Remove';
        }
      });
    });
  }

  root.querySelector('#skills-search')?.addEventListener('input', (e) => {
    uiState.skillSearch = e.currentTarget.value;
    paintList();
  });

  paintList();
}

/* ===========================
   4. SETTINGS (#settings)
   =========================== */
// Settings is a page like Home, Memory and Vault: the shared header, then a row of sections.
// Every change saves on its own, as before.
const SETTINGS_TABS = [
  { id: 'general', label: 'General', icon: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 6h12M4 14h12"/><circle cx="8" cy="6" r="2" fill="var(--st-dot)"/><circle cx="13" cy="14" r="2" fill="var(--st-dot)"/></svg>' },
  { id: 'people', label: 'People' },
  { id: 'agents', label: 'Agents' },
  { id: 'text', label: 'Loop Agent', optional: true, icon: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5c-4.1 0-7.2 2.6-7.2 5.9 0 1.8.9 3.4 2.4 4.5l-.9 2.6 2.9-1.2c.9.2 1.8.4 2.8.4 4.1 0 7.2-2.6 7.2-6.3S14.1 3.5 10 3.5z"/></svg>' },
  { id: 'vault', label: 'Security', icon: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="9" width="12" height="8" rx="2"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/></svg>' },
  { id: 'billing', label: 'Plan', icon: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="14" height="10" rx="2"/><path d="M3 9h14"/></svg>' },
  { id: 'account', label: 'Account', icon: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="7.5" r="3"/><path d="M4.5 16a5.5 5.5 0 0 1 11 0"/></svg>' },
];
let settingsPop = null; // the Settings page on screen: { el, tab, token }

// The sections this workspace has: General holds only settings of a Loop on this computer.
function settingsTabs(smsEnabled = false, people = true) {
  return SETTINGS_TABS.filter((t) => (t.id !== 'general' || auth.mode !== 'clerk') && (t.id !== 'people' || people) && (!t.optional || smsEnabled));
}

function settingsTabOk(tab) {
  return SETTINGS_TABS.some((t) => t.id === tab) ? tab : 'general';
}

// Goes to the Settings page, on one of its sections.
function openSettings(tab = 'general') {
  const want = settingsTabOk(tab);
  location.hash = want === 'general' ? '#settings' : `#settings?tab=${want}`;
}

// Every section on one scrolling page, with a side menu like Home's that follows the scroll.
function renderSettings(root, seq, params) {
  // Approval rules moved to the Vault; old links go there.
  if (params?.get('tab') === 'approvals') {
    location.replace('#vault');
    return;
  }
  const requestedTab = params?.get('upgrade') === '1'
    ? 'billing'
    : (params?.get('tab') || 'general');
  const want = settingsTabOk(requestedTab);
  resetPeople();
  root.innerHTML = `
    <section class="home-connections hm hm-libpage st-page" aria-label="Settings">
      ${pageTop({ title: 'Settings', sub: 'Changes save as you go', hideTitle: true })}
      <div class="hm-body">
        <nav class="hm-rail" id="st-rail" aria-label="Settings sections">${railHtml(settingsTabs(), PAGES.settings)}</nav>
        <div class="ctl-scroll"><div class="st-body" id="st-body"></div></div>
      </div>
    </section>
  `;
  settingsPop = { el: root, tab: want, token: 0, seq };
  return loadSettingsPopup();
}

// One tab in the bottom bar is lit: the page's own tab.
function syncNavCurrent() {
  const { section } = parseRoute();
  const current = navOf(section);
  document.querySelectorAll('.nav [data-nav]').forEach((a) => {
    if (a.dataset.nav === current) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

// Settings is a page now; leaving it only forgets the page, the next page replaces it on screen.
function closeSettings() {
  settingsPop = null;
}

// Brings one section to the top of the list (a link like #settings?tab=vault).
function showSettingsTab(tab) {
  if (!settingsPop) return;
  const want = settingsTabOk(tab);
  settingsPop.tab = want;
  const scroller = settingsPop.el.querySelector('.ctl-scroll');
  const pane = settingsPop.el.querySelector(`[data-st-pane="${want}"]`);
  if (scroller && pane && want !== 'general') {
    whenShown(scroller, () => {
      scroller.scrollTop = pane.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    });
  }
  wireSideRail(scroller, settingsPop.el.querySelector('#st-rail'));
}

async function loadSettingsPopup() {
  if (!settingsPop) return;
  const pop = settingsPop;
  const token = ++pop.token;
  const body = pop.el.querySelector('#st-body');
  const current = () => settingsPop === pop && pop.token === token;
  if (!body.firstElementChild) body.innerHTML = '<div class="st-wait" role="status"><div class="spin" aria-hidden="true"></div></div>';
  let data;
  let billingRes;
  let smsRes = { enabled: false };
  let connectRes = null;
  let people = null;
  let feedback = null;
  let agentsRes = null;
  const isHostedWorkspace = auth.mode === 'clerk' && !canImportFromMac();
  try {
    [data, people, billingRes, smsRes, connectRes, feedback, agentsRes] = await Promise.all([
      api('/api/settings'),
      api('/api/people').catch(() => null),
      api('/api/billing').catch(() => null),
      api('/api/sms-agent').catch(() => ({ enabled: false })),
      api(isHostedWorkspace ? '/api/connect/devices' : '/api/local/connect').catch(() => null),
      api('/api/feedback').catch(() => null),
      api('/api/agents').catch(() => null),
    ]);
  } catch (err) {
    if (!current()) return;
    renderErrorState(body, err, () => loadSettingsPopup());
    return;
  }
  if (!current()) return;
  const sms = smsRes && smsRes.enabled ? smsRes : { enabled: false };
  const rail = pop.el.querySelector('#st-rail');
  if (rail) {
    rail.innerHTML = railHtml(settingsTabs(sms.enabled, Boolean(people)), PAGES.settings);
  }
  const agentList = agentsRes ? agentRows(
    Array.isArray(agentsRes.agents) ? agentsRes.agents : [],
    Array.isArray(agentsRes.connected) ? agentsRes.connected : [],
  ) : null;
  fillSettings(body, data, billingRes, sms, connectRes, people, feedback, agentList);
  showSettingsTab(pop.tab);
}

// Vault and Settings rows are one line each: an icon, what it is,
// and on the right one value, switch or chevron. What else there is to say opens under the row.
const ST_ICON_PATHS = {
  auto: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/>',
  progressive: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  direct: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5M3 16.5l9 5 9-5"/>',
  person: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  look: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" stroke="none"/>',
  plug: '<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0z"/><path d="M12 16v5"/>',
  key: '<circle cx="8.5" cy="15.5" r="4"/><path d="M11.5 12.5L20 4M17 7l2.5 2.5M15 9l2 2"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
  shield: '<path d="M12 3l7 2.8v5.2c0 4.3-2.9 7.7-7 9.4-4.1-1.7-7-5.1-7-9.4V5.8z"/>',
  payment: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h3"/>',
  login: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c4.5 4.6 4.5 12.4 0 17-4.5-4.6-4.5-12.4 0-17z"/>',
  api_key: '<circle cx="8.5" cy="15.5" r="4"/><path d="M11.5 12.5L20 4M17 7l2.5 2.5M15 9l2 2"/>',
  write: '<path d="M4.5 19.5l1-4L16 5l3 3L8.5 18.5z"/><path d="M14 7l3 3"/>',
  text: '<path d="M12 4c-4.8 0-8.5 3-8.5 7 0 2.2 1.1 4.1 2.9 5.4L5.5 20l3.7-1.6c.9.2 1.8.3 2.8.3 4.8 0 8.5-3.2 8.5-7.4S16.8 4 12 4z"/>',
  signout: '<path d="M14 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H14M10 12h10M16.5 8.5L20 12l-3.5 3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  note: '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8h5M9 12.5h6M9 16h4"/>',
  delete: '<path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 13h10l1-13M10 11v5.5M14 11v5.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>',
  cloud: '<path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.4 9.1 4.7 4.7 0 0 0 7 18.5z"/>',
  team: '<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 6.3a3.2 3.2 0 0 1 0 5.4M17.5 14.2a5.5 5.5 0 0 1 3 4.8"/>',
  enterprise: '<path d="M4 20.5V6l8-3v17.5M12 9h8v11.5M3 20.5h18M7 8.5h2M7 12h2M7 15.5h2M15 12.5h2M15 16h2"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4.5V9h4.5"/>',
};
const ST_LOOP_MARK = '<svg width="22" height="12" viewBox="0 0 26 14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M13 7c-2.2-3.2-4-5-6.3-5A5 5 0 0 0 6.7 12c2.3 0 4.1-1.8 6.3-5zm0 0c2.2 3.2 4 5 6.3 5a5 5 0 0 0 0-10c-2.3 0-4.1 1.8-6.3 5z"/></svg>';
const LN_CHEV = '<svg class="ln-chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 3l3 3-3 3"/></svg>';
function lnIcon(name) {
  if (name === 'loop') return `<span class="ln-ic" aria-hidden="true">${ST_LOOP_MARK}</span>`;
  return `<span class="ln-ic" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ST_ICON_PATHS[name] || ''}</svg></span>`;
}
// System, Light or Dark. theme-boot.js applies and keeps the choice on this device.
const LOOKS = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
function lookSegment() {
  const now = window.loopTheme?.get() || 'system';
  return `<div class="vm-seg st-look" role="radiogroup" aria-label="Look">${LOOKS.map(([id, label]) => `<button type="button" role="radio" aria-checked="${id === now}" data-look="${id}">${label}</button>`).join('')}</div>`;
}
function wireLook(root) {
  const seg = root.querySelector('.st-look');
  if (!seg) return;
  wireRadioKeys(seg.parentElement);
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-look]');
    if (!btn) return;
    window.loopTheme?.set(btn.dataset.look);
    seg.querySelectorAll('[data-look]').forEach((b) => {
      const on = b === btn;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  });
}
function stHead(title, cap = '') {
  return `<div class="st-sh"><h3 class="st-h">${esc(title)}</h3>${cap ? `<span class="st-cap">${esc(cap)}</span>` : ''}</div>`;
}
// In all three rows below, title, sub and value are trusted HTML: callers escape what comes from data.
// A row with a control. Its text is a button that opens one quiet line of help under it.
function stRow({ icon, title, sub = '', ctl = '', attrs = '' }) {
  const text = `<span class="ln-t">${title}</span>${sub ? `<span class="ln-d">${sub}</span>` : ''}`;
  return `
    <div class="st-row ln" ${attrs}>
      ${lnIcon(icon)}
      ${sub ? `<button type="button" class="ln-tx" data-st-help aria-expanded="false">${text}</button>` : `<span class="ln-tx">${text}</span>`}
      ${ctl}
    </div>`;
}
// A row that does something or opens a form: the whole line is the button.
function stGo({ icon, title, sub = '', value = '', cls = '', attrs = '', href = '' }) {
  const inner = `${lnIcon(icon)}
      <span class="ln-tx"><span class="ln-t">${title}</span>${sub ? `<span class="ln-d">${sub}</span>` : ''}</span>
      ${value ? `<span class="ln-v">${value}</span>` : ''}${LN_CHEV}`;
  return href
    ? `<a class="st-row ln ln-go ${cls}" href="${href}" ${attrs}>${inner}</a>`
    : `<button type="button" class="st-row ln ln-go ${cls}" ${attrs}>${inner}</button>`;
}
// A row that folds open in place.
function stFold({ key, icon, title, value = '', body = '', open = false }) {
  return `
    <details class="st-fold" data-fold="${esc(key)}" ${open ? 'open' : ''}>
      <summary class="st-row ln ln-go">${lnIcon(icon)}<span class="ln-tx"><span class="ln-t">${title}</span></span>${value ? `<span class="ln-v">${value}</span>` : ''}${LN_CHEV}</summary>
      <div class="st-fold-b">${body}</div>
    </details>`;
}

// Agent feedback (lib/feedback.mjs). Where somebody else reads the reports, agents can ask first.
const FEEDBACK_CHOICES = [['ask', 'Ask', null], ['on', 'On', true], ['off', 'Off', false]];
const FEEDBACK_SAID = {
  ask: 'Agents ask you before they send feedback about Loop.',
  on: 'Agents can send feedback about Loop.',
  off: 'Agents no longer send feedback about Loop.',
};
function feedbackRowHtml(feedback) {
  return stRow({
    icon: 'write',
    title: 'Agent feedback',
    sub: feedback.shared ? 'Agents can tell the team that runs Loop about its faults' : 'Agents can report when Loop itself fails. Reports stay on this computer',
    attrs: 'data-fb-row',
    ctl: feedback.shared
      ? `<div class="vm-seg st-fb-seg" role="radiogroup" aria-label="Agent feedback">${FEEDBACK_CHOICES.map(([id, label]) => `<button type="button" role="radio" aria-checked="${id === feedback.state}" data-fb-set="${id}">${label}</button>`).join('')}</div>`
      : `<input type="checkbox" class="st-sw st-sw-input" role="switch" id="settings-agent-feedback" aria-label="Agent feedback" ${feedback.state === 'off' ? '' : 'checked'}>`,
  });
}
// What agents reported, newest first. The text is data from an agent: always escaped.
function feedbackFoldHtml(feedback, open) {
  return feedback.reports.length ? stFold({
    key: 'feedback',
    icon: 'note',
    title: 'Feedback that agents sent',
    value: String(feedback.reports.length),
    open,
    body: `<ul class="st-fb">${feedback.reports.map((r) => `
      <li data-fb="${esc(r.id)}">
        <p class="st-fb-t">${esc(r.content)}</p>
        <div class="st-acts">
          <span class="st-rs">${esc([{ bug: 'Bug', improvement: 'Improvement' }[r.type], r.about, r.client, shortAgo(r.createdAt)].filter(Boolean).join(' · '))}</span>
          <button type="button" class="vd-act is-no" data-fb-del="${esc(r.id)}">Delete</button>
        </div>
      </li>`).join('')}
    </ul>`,
  }) : '';
}
function feedbackHtml(feedback, open = false) {
  if (!feedback) return '';
  return (feedback.available ? feedbackRowHtml(feedback) : '') + feedbackFoldHtml(feedback, open);
}

function fillSettings(root, data, billingRes, smsRes = { enabled: false }, connectRes = null, people = null, feedback = null, agentList = null) {
  const settings = data.settings || data;
  const openFolds = new Set([...root.querySelectorAll('details[data-fold][open]')].map((d) => d.dataset.fold));
  const billing = billingRes && typeof billingRes === 'object' ? billingRes : null;
  const sms = smsRes && smsRes.enabled ? smsRes : { enabled: false };
  const appMode = auth.mode === 'clerk';
  const isHostedCloud = appMode && !canImportFromMac();
  const hasPassword = !appMode || auth.vaultPasswordSet === true;
  const profileRecords = extractProfileRecords(data);
  syncTopChrome(profileRecords, { loaded: true });
  const selChev = LN_CHEV;
  const loopConnectActive = Boolean(billing?.loopConnectActive);
  const planName = billing?.selfHosted
    ? 'Loop (Local)'
    : loopConnectActive
      ? (billing?.invited && billing?.plan === 'free' ? 'Loop Connect (Invited)' : (billing?.planName || 'Loop Connect'))
      : 'Loop Cloud (Locked)';
  const planLine = billing?.selfHosted
    ? 'Free forever on 1 local device · Unlimited local connections & agents · Local-only'
    : loopConnectActive
      ? (billing?.cancelAtPeriodEnd && billing?.currentPeriodEnd
          ? `Cancels on ${new Date(billing.currentPeriodEnd).toLocaleDateString()}`
          : 'Active Loop Connect · Up to 2 connected devices, unlimited connections & agents')
      : 'Unlock Loop Connect ($12/mo) to use Loop Cloud and share connections across 2 devices — or run Loop locally for free on 1 computer';
  const buyConnect = Boolean(billing?.billingEnabled && !loopConnectActive);
  const planGo = (plan, icon, title, price, sub) => stGo({ icon, title, sub, value: price, attrs: `data-st-waitlist="${plan}" aria-expanded="false" aria-controls="billing-waitlist-form"` });
  const extraDevices = Number(billing?.extraDevices) || 0;
  const extraPriceUsd = Number(billing?.extraDevicePriceMonthly) || 5;
  const canManageExtraDevices = Boolean(billing?.canManageExtraDevices);
  const hostedDevices = isHostedCloud && Array.isArray(connectRes?.devices) ? connectRes.devices : [];
  const hostedDefaultDeviceId = isHostedCloud ? (connectRes?.defaultDeviceId || '') : '';
  const hostedMaxDevices = isHostedCloud ? (connectRes?.maxDevices ?? (2 + extraDevices)) : 2;
  const localLinkState = !isHostedCloud && connectRes && typeof connectRes === 'object' ? connectRes : { linked: false };
  const transportLabelOf = (mode) => (
    mode === 'tailscale' ? 'Tailscale' : mode === 'cloudflare_tunnel' ? 'Cloudflare Tunnel' : 'Outbound TLS'
  );
  const loopConnectSectionHtml = isHostedCloud
    ? `
      <div class="st-grp">Devices <span>${esc(hostedDevices.length)}${hostedMaxDevices ? ` of ${esc(hostedMaxDevices)}` : ''}${extraDevices > 0 ? ` · ${esc(extraDevices)} extra` : ''}</span></div>
      <div class="st-list">
        ${hostedDevices.length > 0 ? stRow({
          icon: 'plug',
          title: '<span id="lc-def-dev-label">Default computer</span>',
          sub: 'Used when a cloud or phone agent calls a local tool without naming a computer',
          ctl: `<span class="ln-sel">
            <select id="lc-default-device-select" aria-labelledby="lc-def-dev-label">
              <option value="" ${!hostedDefaultDeviceId ? 'selected' : ''}>Ask when needed</option>
              ${hostedDevices.map((d) => `<option value="${esc(d.id)}" ${d.id === hostedDefaultDeviceId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
            </select>${selChev}</span>`,
        }) : ''}
        ${hostedDevices.map((dev) => {
          const metaParts = [
            dev.lastSyncAt ? `Last synced ${new Date(dev.lastSyncAt).toLocaleString()}` : 'Paired with your Loop',
            transportLabelOf(dev.transportMode) + (dev.requirePrivateTunnel ? ' (required)' : ''),
            dev.keyFingerprint ? `Key ${dev.keyFingerprint}` : '',
          ].filter(Boolean);
          return stFold({
            key: `dev-${dev.id}`,
            icon: 'plug',
            title: esc(dev.name),
            value: `${dev.isDefault ? 'Default · ' : ''}${dev.online ? '<span class="is-ok">Online</span>' : 'Offline'}`,
            open: openFolds.has(`dev-${dev.id}`),
            body: `<p class="st-rs">${esc(metaParts.join(' · '))}</p><div class="st-acts"><button type="button" class="vd-act is-no" data-lc-remove="${esc(dev.id)}">Disconnect</button></div>`,
          });
        }).join('')}
        ${loopConnectActive
          ? stGo({ icon: 'cloud', title: 'Pair a computer', sub: `2 included, then $${esc(extraPriceUsd)}/mo each`, attrs: 'id="lc-mint-code"' })
          : stRow({ icon: 'cloud', title: 'Pair a computer', sub: 'Needs an active Loop Connect plan' })}
        ${canManageExtraDevices ? stGo({ icon: 'plus', title: 'Add a device slot', value: `$${esc(extraPriceUsd)}/mo`, attrs: 'id="lc-add-device-slot"' }) : ''}
        ${canManageExtraDevices && extraDevices > 0 && (hostedMaxDevices === null || hostedDevices.length < hostedMaxDevices)
          ? stGo({ icon: 'minus', title: 'Remove a device slot', value: `−$${esc(extraPriceUsd)}/mo`, attrs: 'id="lc-remove-device-slot"' }) : ''}
      </div>
      <div id="lc-pair-code-box" class="st-form st-inline-form" hidden></div>
      ${hostedDevices.length > 0 ? `
        <details class="st-fold" data-fold="network" ${openFolds.has('network') ? 'open' : ''}>
          <summary class="st-row ln ln-go">${lnIcon('direct')}<span class="ln-tx"><span class="ln-t">Network</span><span class="ln-d">Tailscale or Cloudflare Tunnel</span></span>${LN_CHEV}</summary>
          <div class="st-fold-b">
            <p class="st-rs">Built-in encrypted outbound TLS works out of the box with no open ports. Add Tailscale or Cloudflare Tunnel per computer for private-network routing.</p>
            ${hostedDevices.map((dev) => `
              <form class="st-form" data-lc-net-form="${esc(dev.id)}">
                <div class="st-rt">${esc(dev.name)}</div>
                <div class="st-form-row">
                  <label class="st-field">
                    <span class="st-lbl">Transport</span>
                    <span class="st-select st-select-field">
                      <select name="transportMode">
                        <option value="loop_relay" ${(dev.transportMode || 'loop_relay') === 'loop_relay' ? 'selected' : ''}>Built-in Outbound TLS (Default)</option>
                        <option value="tailscale" ${dev.transportMode === 'tailscale' ? 'selected' : ''}>Tailscale</option>
                        <option value="cloudflare_tunnel" ${dev.transportMode === 'cloudflare_tunnel' ? 'selected' : ''}>Cloudflare Tunnel</option>
                      </select>${selChev}
                    </span>
                  </label>
                  <label class="st-field">
                    <span class="st-lbl">Tunnel endpoint (optional)</span>
                    <input name="tunnelEndpoint" type="url" value="${esc(dev.tunnelEndpoint || '')}" placeholder="https://my-mac.tail123.ts.net">
                  </label>
                </div>
                <label class="st-net-check">
                  <input type="checkbox" name="requirePrivateTunnel" ${dev.requirePrivateTunnel ? 'checked' : ''}>
                  <span>Require private tunnel only (fail closed if tunnel is unreachable)</span>
                </label>
                <div class="st-acts"><button type="submit" class="btn st-btn">Save network</button></div>
              </form>
            `).join('')}
          </div>
        </details>
      ` : ''}
    `
    : `
      <div class="st-grp">Devices</div>
      <div class="st-list">
        ${localLinkState.linked
          ? stFold({
              key: 'this-device',
              icon: 'cloud',
              title: esc(localLinkState.deviceName || 'This computer'),
              value: localLinkState.lastError ? '<span class="is-warn">Needs a look</span>' : '<span class="is-ok">Connected</span>',
              open: openFolds.has('this-device'),
              body: `<p class="st-rs">${esc([
                localLinkState.cloudUrl,
                transportLabelOf(localLinkState.transportMode) + (localLinkState.requirePrivateTunnel ? ' (required)' : ''),
                localLinkState.keyFingerprint ? `Key ${localLinkState.keyFingerprint}` : '',
                localLinkState.lastSyncAt ? `Last synced ${new Date(localLinkState.lastSyncAt).toLocaleString()}` : '',
                localLinkState.lastError || '',
              ].filter(Boolean).join(' · '))}</p><div class="st-acts"><button type="button" class="vd-act" id="lc-local-sync">Refresh tools</button><button type="button" class="vd-act is-no" id="lc-local-unlink">Disconnect</button></div>`,
            })
          : stGo({ icon: 'cloud', title: 'Connect a second device', sub: 'Share this setup with another computer', attrs: 'id="lc-local-toggle" aria-expanded="false" aria-controls="lc-local-link-form"' })}
      </div>
      ${localLinkState.linked ? `
        <details class="st-fold" data-fold="network" ${openFolds.has('network') ? 'open' : ''}>
          <summary class="st-row ln ln-go">${lnIcon('direct')}<span class="ln-tx"><span class="ln-t">Network</span><span class="ln-d">Tailscale or Cloudflare Tunnel</span></span>${LN_CHEV}</summary>
          <div class="st-fold-b">
            <p class="st-rs">Built-in encrypted outbound TLS works out of the box with no open ports. Optionally route remote calls over Tailscale or Cloudflare Tunnel.</p>
            <form id="lc-local-network-form" class="st-form">
              <div class="st-form-row">
                <label class="st-field">
                  <span class="st-lbl">Transport</span>
                  <span class="st-select st-select-field">
                    <select name="transportMode">
                      <option value="loop_relay" ${(localLinkState.transportMode || 'loop_relay') === 'loop_relay' ? 'selected' : ''}>Built-in Outbound TLS (Default)</option>
                      <option value="tailscale" ${localLinkState.transportMode === 'tailscale' ? 'selected' : ''}>Tailscale</option>
                      <option value="cloudflare_tunnel" ${localLinkState.transportMode === 'cloudflare_tunnel' ? 'selected' : ''}>Cloudflare Tunnel</option>
                    </select>${selChev}
                  </span>
                </label>
                <label class="st-field">
                  <span class="st-lbl">Tunnel endpoint (optional)</span>
                  <input name="tunnelEndpoint" type="url" value="${esc(localLinkState.tunnelEndpoint || '')}" placeholder="https://my-mac.tail123.ts.net">
                </label>
              </div>
              <label class="st-net-check">
                <input type="checkbox" name="requirePrivateTunnel" ${localLinkState.requirePrivateTunnel ? 'checked' : ''}>
                <span>Require private tunnel only (fail closed if tunnel is unreachable)</span>
              </label>
              <div class="st-acts"><button type="submit" class="btn st-btn">Save network</button></div>
            </form>
          </div>
        </details>
      ` : `
        <form id="lc-local-link-form" class="st-form st-inline-form" method="post" aria-label="Pair with Loop Connect" hidden>
          <p class="st-rs">Loop stays on this computer until you pair it. Loop Connect is $12/mo for 2 devices.</p>
          <div class="st-form-row">
            <label class="st-field"><span class="st-lbl">Loop Cloud URL</span><input name="cloudUrl" type="url" required value="https://useloop.sh"></label>
            <label class="st-field"><span class="st-lbl">Pairing code</span><input name="code" type="text" required maxlength="20" placeholder="LP-ABCD-2345" autocomplete="off"></label>
            <label class="st-field"><span class="st-lbl">Device name</span><input name="deviceName" type="text" maxlength="80" value="${esc(localLinkState.defaultDeviceName || '')}" placeholder="My MacBook"></label>
          </div>
          <div class="st-acts"><button type="submit" class="btn st-btn st-btn-dark">Connect this device</button></div>
        </form>
      `}
    `;

  root.innerHTML = `
    ${appMode ? '' : `
    <section class="st-pane" id="st-pane-general" data-st-pane="general" data-rail-group="general">
      ${stHead('General')}
      <div class="st-list">
        ${stRow({
          icon: 'key',
          title: 'Require an agent key',
          sub: 'Only agents you have connected to Loop can use it',
          ctl: `<input type="checkbox" class="st-sw st-sw-input" role="switch" id="settings-require-token" aria-label="Require an agent key" ${settings.requireAgentToken !== false ? 'checked' : ''}>`,
        })}
        ${stGo({ icon: 'download', title: 'Export settings', sub: 'Settings and connections only (excludes Vault secrets, memories, saved items, files, and schedules)', href: '/api/export', attrs: 'download="loop-config.json"' })}
        ${stGo({ icon: 'restore', title: 'Restore backup', sub: 'From a loop-config.json file', attrs: 'id="settings-restore-btn"' })}
        ${stGo({ icon: 'direct', title: 'MCP Inspector', sub: 'Test tools, inline chat widgets, traffic, and checks', href: '/inspector', attrs: 'target="_blank" rel="noopener noreferrer"' })}
      </div>
      <input type="file" id="settings-restore-file" accept=".json,application/json" aria-label="Backup file" hidden>
    </section>
    `}

    ${people ? '<section class="st-pane" id="st-pane-people" data-st-pane="people" data-rail-group="people"></section>' : ''}

    <section class="st-pane" id="st-pane-agents" data-st-pane="agents" data-rail-group="agents">
      ${stHead('Agents', 'Open one to see its calls')}
      <div class="st-list">
        ${agentList === null ? '<p class="st-rs">Agents did not load. Reload the page to try again.</p>' : ''}
        ${(agentList || []).map((row) => `<button type="button" class="st-row ln ln-go" data-st-agent="${esc(row.id)}"><span class="ln-ic st-agent-ic" aria-hidden="true">${agentMark(row, esc, 'pf-agent-mark')}</span><span class="ln-tx"><span class="ln-t">${esc(row.name)}</span><span class="ln-d">${esc(agentStatus(row).text)}</span></span>${LN_CHEV}</button>`).join('')}
        ${stGo({ icon: 'plus', title: 'Add agent', attrs: 'data-st-add-agent' })}
      </div>
    </section>

    ${sms.enabled ? `
    <section class="st-pane" id="st-pane-text" data-st-pane="text" data-rail-group="text">
      ${stHead('Loop Agent')}
      <div class="st-list">
        ${stFold({
          key: 'text',
          icon: 'text',
          title: 'iMessage',
          value: sms.status?.linked ? (esc(sms.status.phoneMasked || '') || '<span class="is-ok">Linked</span>') : 'Not linked',
          open: openFolds.has('text') || settingsPop?.tab === 'text',
          body: '<div id="st-sms-agent"></div>',
        })}
      </div>
    </section>
    ` : ''}

    <section class="st-pane" id="st-pane-vault" data-st-pane="vault" data-rail-group="vault">
      ${stHead('Security')}
      <div class="st-list">
        ${stGo({
          icon: 'lock',
          title: appMode ? 'Vault password' : 'Loop password',
          sub: appMode ? 'Reveals secrets, separate from signing in' : 'Opens this dashboard and shows secrets',
          value: hasPassword ? 'Change' : 'Set up',
          attrs: 'id="st-pw-toggle" aria-expanded="false" aria-controls="password-form"',
        })}
        ${feedbackHtml(feedback, openFolds.has('feedback'))}
      </div>
      <form id="password-form" class="st-form st-inline-form" method="post" hidden>
        <p class="st-rs">${appMode ? 'An optional extra password to reveal secrets in the Vault, separate from signing in.' : 'Protects this dashboard and is needed to view any secret. Agents never get it.'}</p>
        ${hasPassword ? `
          <label class="st-field"><span class="st-lbl">Current password</span><input name="current" type="password" required autocomplete="current-password"></label>
        ` : ''}
        <label class="st-field"><span class="st-lbl">New password</span><input name="next" type="password" required minlength="8" autocomplete="new-password" placeholder="At least 8 characters"></label>
        <div class="st-acts"><button type="submit" class="btn st-btn st-btn-dark">${hasPassword ? 'Change password' : 'Set Vault password'}</button></div>
      </form>
    </section>

    <section class="st-pane" id="st-pane-billing" data-st-pane="billing" data-rail-group="billing">
      ${stHead('Plan')}
      <div class="st-list">
        ${stRow({ icon: 'loop', title: esc(planName), sub: esc(planLine), ctl: '<span class="ln-v">Current</span>' })}
        ${billing?.canManageBilling ? stGo({ icon: 'payment', title: 'Manage billing', attrs: 'id="billing-manage"' }) : ''}
        ${loopConnectActive && !billing?.selfHosted ? '' : buyConnect
          ? stGo({ icon: 'cloud', title: 'Unlock Loop Connect', sub: '2 devices, unlimited connections and agents', value: '$12/mo', attrs: 'id="billing-upgrade-pro"' })
          : planGo('pro', 'cloud', 'Loop Connect', '$12/mo', '2 devices, unlimited connections and agents')}
        ${planGo('team', 'team', 'Loop Team', '$24/seat', 'Shared Vaults and connections')}
        ${planGo('enterprise', 'enterprise', 'Enterprise', 'Custom', 'SSO, SCIM and audit export')}
      </div>
      </div>
      ${loopConnectSectionHtml}
      <form id="billing-waitlist-form" class="st-form st-inline-form" method="post" aria-label="Join the waitlist" hidden>
        <p class="st-rs" data-wait-note></p>
        <div class="st-form-row">
          <label class="st-field"><span class="st-lbl">Work email</span><input name="email" type="email" required autocomplete="email" placeholder="you@company.com"></label>
          <label class="st-field">
            <span class="st-lbl">Plan</span>
            <span class="st-select st-select-field"><select name="plan">
              <option value="team">Loop Team</option>
              <option value="enterprise">Enterprise</option>
              <option value="pro">Loop Connect</option>
            </select>${selChev}</span>
          </label>
          <label class="st-field"><span class="st-lbl">Team size</span><input name="teamSize" type="text" maxlength="40" placeholder="Optional"></label>
        </div>
        <div class="st-acts"><button type="submit" class="btn st-btn st-btn-dark">Join waitlist</button></div>
      </form>
    </section>

    <section class="st-pane" id="st-pane-account" data-st-pane="account" data-rail-group="account">
      ${stHead('Account')}
      <div class="st-list">
        ${stRow({ icon: 'person', title: 'Signed in', ctl: `<span class="ln-v">${appMode ? (canImportFromMac() ? 'Loop account' : 'Loop Cloud') : 'Loop password'}</span>` })}
        ${canRestoreMac() ? stGo({
          icon: 'restore',
          title: 'Restore this Mac’s workspace',
          attrs: 'id="st-restore-toggle" aria-expanded="false" aria-controls="restore-local-form"',
        }) : ''}
        ${stRow({ icon: 'look', title: 'Look', ctl: lookSegment() })}
        ${stGo({ icon: 'signout', title: 'Sign out', cls: 'is-no', attrs: 'id="sign-out"' })}
      </div>
      </div>
      ${canRestoreMac() ? `
        <form id="restore-local-form" class="st-form st-inline-form" method="post" aria-label="Restore this Mac’s workspace" hidden>
          <p class="st-rs">Links the workspace already on this Mac to your Loop account. Use that workspace’s original Loop password, not your account or Vault password.</p>
          <label class="st-field"><span class="st-lbl">Original Loop password</span><input name="password" type="password" required autocomplete="current-password"></label>
          <div class="st-acts"><button type="submit" class="btn st-btn st-btn-dark">Restore workspace</button></div>
        </form>
      ` : ''}
      <div id="st-shared-with-me"></div>
    </section>
  `;

  if (settingsPop) settingsPop.people = null;
  if (settingsPop && people) {
    settingsPop.people = mountPeople(root.querySelector('#st-pane-people'), people, {
      esc, api, toast, copyText, confirmDialog, renderConnLogo, chevron: LN_CHEV,
      projects: profileRecords.filter((r) => r && r.id && r.id !== 'all'),
      ownerName: () => clerk?.user?.firstName || clerk?.user?.fullName || '',
      showPlan: () => showSettingsTab('billing'),
    });
  }

  // Help for a row with a control: its text opens one quiet line under it.
  root.querySelectorAll('[data-st-help]').forEach((btn) => btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
  }));

  // Rows that open a small form under them.
  const wireReveal = (btn, form, onOpen) => {
    if (!btn || !form) return;
    btn.addEventListener('click', () => {
      const open = form.hidden;
      form.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      if (open) {
        onOpen?.();
        form.querySelector('input')?.focus();
      }
    });
  };
  wireReveal(root.querySelector('#st-pw-toggle'), root.querySelector('#password-form'));
  wireReveal(root.querySelector('#st-restore-toggle'), root.querySelector('#restore-local-form'));
  const waitForm = root.querySelector('#billing-waitlist-form');
  root.querySelectorAll('[data-st-waitlist]').forEach((btn) => btn.addEventListener('click', () => {
    if (!waitForm) return;
    const plan = btn.dataset.stWaitlist;
    const sameOpen = !waitForm.hidden && waitForm.plan.value === plan;
    waitForm.plan.value = plan;
    waitForm.hidden = sameOpen;
    btn.after(waitForm);
    waitForm.querySelector('[data-wait-note]').textContent = {
      pro: `Join the waitlist. Loop Cloud and 2 connected devices, unlimited connections and agents. +$${extraPriceUsd}/mo for each extra device.`,
      team: 'Join the waitlist. Shared Vaults and connections, unlimited devices, org-wide approvals and a 365-day audit log.',
      enterprise: 'Join the waitlist. SSO, SCIM, SIEM export, BYOK and a commercial license.',
    }[plan] || '';
    root.querySelectorAll('[data-st-waitlist]').forEach((b) => b.setAttribute('aria-expanded', String(!sameOpen && b === btn)));
    if (!sameOpen) waitForm.querySelector('input[name="email"]')?.focus();
  }));

  root.querySelectorAll('[data-st-close-link]').forEach((a) => a.addEventListener('click', () => closeSettings({ immediate: true })));

  const smsHost = root.querySelector('#st-sms-agent');
  if (smsHost && sms.enabled) {
    mountSmsAgentCard(smsHost, sms, { esc, api, toast, copyText }, {
      onReload: () => loadSettingsPopup(),
    });
  }

  async function patchSetting(body, okMsg, revert) {
    try {
      await api('/api/settings', { method: 'PATCH', body: JSON.stringify(body) });
      toast(okMsg, 'ok');
      return true;
    } catch (err) {
      toast(err.message, 'err');
      revert();
      return false;
    }
  }

  const tokenBox = root.querySelector('#settings-require-token');
  tokenBox?.addEventListener('change', async () => {
    if (!tokenBox.checked) {
      const ok = await confirmDialog({
        title: 'Turn off agent keys?',
        message: 'Any program on this Mac will be able to use Loop without an agent key.',
        confirmLabel: 'Turn off keys',
        danger: true,
      });
      if (!ok) {
        tokenBox.checked = true;
        return;
      }
    }
    tokenBox.disabled = true;
    patchSetting(
      { requireAgentToken: tokenBox.checked },
      tokenBox.checked ? 'Agent keys are required.' : 'Agent keys are no longer required.',
      () => { tokenBox.checked = !tokenBox.checked; },
    ).finally(() => { tokenBox.disabled = false; });
  });

  const wireFeedback = () => {
    const box = root.querySelector('#settings-agent-feedback');
    box?.addEventListener('change', () => {
      box.disabled = true;
      patchSetting(
        { agentFeedback: box.checked },
        FEEDBACK_SAID[box.checked ? 'on' : 'off'],
        () => { box.checked = !box.checked; },
      ).finally(() => { box.disabled = false; });
    });
    const seg = root.querySelector('[data-fb-row] .st-fb-seg');
    if (seg) wireRadioKeys(seg.parentElement);
    seg?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-fb-set]');
      const was = seg.querySelector('[aria-checked=true]');
      if (!btn || btn === was) return;
      const show = (one) => seg.querySelectorAll('[data-fb-set]').forEach((b) => {
        b.setAttribute('aria-checked', String(b === one));
        b.tabIndex = b === one ? 0 : -1;
      });
      show(btn);
      await patchSetting(
        { agentFeedback: FEEDBACK_CHOICES.find(([id]) => id === btn.dataset.fbSet)[2] },
        FEEDBACK_SAID[btn.dataset.fbSet],
        () => show(was),
      );
    });
    root.querySelectorAll('[data-fb-del]').forEach((btn) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api(`/api/feedback/${encodeURIComponent(btn.dataset.fbDel)}`, { method: 'DELETE' });
      } catch (err) {
        btn.disabled = false;
        toast(err.message, 'err');
        return;
      }
      const fold = btn.closest('details');
      btn.closest('li').remove();
      const left = fold.querySelectorAll('[data-fb]').length;
      if (left) fold.querySelector('.ln-v').textContent = String(left);
      else fold.remove();
    }));
  };
  wireFeedback();
  // An agent sent a report, or turned feedback on or off.
  if (settingsPop) {
    settingsPop.feedback = feedback?.available ? {
      async refresh() {
        const now = await api('/api/feedback');
        const row = root.querySelector('[data-fb-row]');
        if (!row || !root.isConnected) return;
        const fold = root.querySelector('[data-fold=feedback]');
        row.insertAdjacentHTML('afterend', feedbackHtml(now, fold?.open));
        fold?.remove();
        row.remove();
        wireFeedback();
      },
    } : null;
  }

  const restoreBtn = root.querySelector('#settings-restore-btn');
  const restoreInput = root.querySelector('#settings-restore-file');
  restoreBtn?.addEventListener('click', () => restoreInput?.click());
  restoreInput?.addEventListener('change', async () => {
    const file = restoreInput.files?.[0];
    restoreInput.value = '';
    if (!file) return;
    restoreBtn.disabled = true;
    try {
      let backup;
      try {
        backup = JSON.parse(await file.text());
      } catch {
        throw new Error('Choose a valid loop-config.json backup file.');
      }
      const res = await api('/api/restore', {
        method: 'POST',
        body: JSON.stringify({ backup }),
      });
      const addedCount = Array.isArray(res?.added) ? res.added.length : 0;
      const skippedCount = Array.isArray(res?.skipped) ? res.skipped.length : 0;
      const parts = [];
      if (addedCount > 0) parts.push(`Restored ${addedCount} ${addedCount === 1 ? 'connection' : 'connections'}`);
      if (res?.settings) parts.push(addedCount > 0 ? 'settings updated' : 'Settings restored');
      if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
      toast(parts.length ? `${parts.join(' · ')}.` : 'Backup restored.', 'ok');
      loadSettingsPopup();
    } catch (err) {
      toast(err?.message || 'Could not restore backup.', 'err');
    } finally {
      if (restoreBtn.isConnected) restoreBtn.disabled = false;
    }
  });

  root.querySelector('#password-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const button = form.querySelector('button[type="submit"]');
    const current = fd.get('current');
    button.disabled = true;
    try {
      const result = await api(appMode ? '/api/auth/vault-password' : '/api/auth/password', {
        method: 'POST', body: JSON.stringify({ ...(current !== null ? { current } : {}), next: fd.get('next') }),
      });
      if (result?.ok === false) throw new Error('Could not save password');
      if (!form.isConnected) return;
      form.reset();
      toast(appMode ? 'Vault password saved.' : 'Password changed.', 'ok');
      form.hidden = true;
      root.querySelector('#st-pw-toggle')?.setAttribute('aria-expanded', 'false');
      if (appMode && !auth.vaultPasswordSet) {
        auth.vaultPasswordSet = true;
        loadSettingsPopup(); // now it asks for the current password too
      }
    } catch (err) {
      if (form.isConnected) toast(err.message, 'err');
    } finally {
      button.disabled = false;
    }
  });

  root.querySelector('#billing-upgrade-pro')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      const result = await api('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ plan: 'pro' }) });
      if (result?.url) location.assign(result.url);
    } catch (err) {
      toast(err.message, 'err');
      button.disabled = false;
    }
  });

  root.querySelector('#billing-manage')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      const result = await api('/api/billing/portal', { method: 'POST', body: '{}' });
      if (result?.url) location.assign(result.url);
    } catch (err) {
      toast(err.message, 'err');
      button.disabled = false;
    }
  });

  root.querySelector('#lc-local-toggle')?.addEventListener('click', (e) => {
    const form = root.querySelector('#lc-local-link-form');
    if (!form) return;
    const nextHidden = !form.hidden;
    form.hidden = nextHidden;
    e.currentTarget.setAttribute('aria-expanded', String(!nextHidden));
    if (!nextHidden) form.querySelector('input[name="code"]')?.focus();
  });

  root.querySelector('#lc-local-link-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api('/api/local/connect/link', {
        method: 'POST',
        body: JSON.stringify({
          cloudUrl: fd.get('cloudUrl'),
          code: fd.get('code'),
          deviceName: fd.get('deviceName'),
        }),
      });
      toast('Computer paired. Use Add Agent to connect your agents to Loop Cloud.', 'ok');
      await loadSettingsPopup();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  });

  root.querySelector('#lc-local-sync')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api('/api/local/connect/sync', { method: 'POST', body: '{}' });
      toast('Device tools refreshed.', 'ok');
      await loadSettingsPopup();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  });

  root.querySelector('#lc-local-unlink')?.addEventListener('click', async (e) => {
    const ok = await confirmDialog({
      title: 'Disconnect from Loop Connect?',
      message: 'Your local connections and secrets stay untouched.',
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api('/api/local/connect', { method: 'DELETE' });
      toast('Disconnected from Loop Connect.', 'ok');
      await loadSettingsPopup();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  });

  root.querySelector('#lc-add-device-slot')?.addEventListener('click', async (e) => {
    const ok = await confirmDialog({
      title: 'Add 1 extra device slot?',
      message: `Adds 1 extra connected device slot to your Loop Connect subscription (+$${extraPriceUsd}/mo, prorated).`,
      confirmLabel: 'Add slot',
    });
    if (!ok) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api('/api/billing/devices', { method: 'POST', body: JSON.stringify({ delta: 1 }) });
      toast('Added 1 extra device slot!', 'ok');
      await loadSettingsPopup();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  });

  root.querySelector('#lc-remove-device-slot')?.addEventListener('click', async (e) => {
    const ok = await confirmDialog({
      title: 'Remove 1 extra device slot?',
      message: 'Removes 1 unused extra device slot from your Loop Connect subscription.',
      confirmLabel: 'Remove slot',
      danger: true,
    });
    if (!ok) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api('/api/billing/devices', { method: 'POST', body: JSON.stringify({ delta: -1 }) });
      toast('Removed 1 extra device slot.', 'ok');
      await loadSettingsPopup();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  });

  root.querySelector('#lc-mint-code')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const box = root.querySelector('#lc-pair-code-box');
    btn.disabled = true;
    try {
      const resume = new URLSearchParams(location.hash.split('?')[1] || '').get('resume_install');
      const pair = await api('/api/connect/pair-code', { method: 'POST', body: JSON.stringify(resume ? { pendingSetupId: resume } : {}) });
      if (box && pair?.code) {
        box.hidden = false;
        box.innerHTML = `<p class="st-rs">Enter this single-use code in your local Loop under <strong>Settings → Plan → Connect a second device</strong> (expires in 10 minutes):</p><div class="st-acts"><code class="lc-pair-code">${esc(pair.code)}</code></div>`;
      }
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  for (const rmBtn of root.querySelectorAll('[data-lc-remove]')) {
    rmBtn.addEventListener('click', async () => {
      const devId = rmBtn.getAttribute('data-lc-remove');
      if (!devId) return;
      const ok = await confirmDialog({
        title: 'Disconnect this device?',
        message: 'This computer will stop relaying local tools until paired again.',
        confirmLabel: 'Disconnect',
        danger: true,
      });
      if (!ok) return;
      rmBtn.disabled = true;
      try {
        await api(`/api/connect/devices/${encodeURIComponent(devId)}`, { method: 'DELETE' });
        toast('Device disconnected.', 'ok');
        await loadSettingsPopup();
      } catch (err) {
        toast(err.message, 'err');
        rmBtn.disabled = false;
      }
    });
  }

  root.querySelector('#lc-default-device-select')?.addEventListener('change', async (e) => {
    const sel = e.currentTarget;
    const prev = hostedDefaultDeviceId;
    sel.disabled = true;
    try {
      await api('/api/connect/devices/default', {
        method: 'PATCH',
        body: JSON.stringify({ deviceId: sel.value || null }),
      });
      toast(sel.value ? 'Default computer updated.' : 'Default computer cleared.', 'ok');
      await loadSettingsPopup();
    } catch (err) {
      sel.value = prev;
      sel.disabled = false;
      toast(err.message || 'Could not update default computer.', 'err');
    }
  });

  for (const netForm of root.querySelectorAll('[data-lc-net-form]')) {
    netForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const devId = netForm.getAttribute('data-lc-net-form');
      const btn = netForm.querySelector('button[type="submit"]');
      const fd = new FormData(netForm);
      if (btn) btn.disabled = true;
      try {
        await api(`/api/connect/devices/${encodeURIComponent(devId)}/network`, {
          method: 'PATCH',
          body: JSON.stringify({
            transportMode: String(fd.get('transportMode') || 'loop_relay'),
            tunnelEndpoint: String(fd.get('tunnelEndpoint') || '').trim() || null,
            requirePrivateTunnel: Boolean(netForm.querySelector('input[name="requirePrivateTunnel"]')?.checked),
          }),
        });
        toast('Network settings saved.', 'ok');
        await loadSettingsPopup();
      } catch (err) {
        toast(err.message || 'Could not save network settings.', 'err');
        if (btn) btn.disabled = false;
      }
    });
  }

  root.querySelector('#lc-local-network-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const btn = form.querySelector('button[type="submit"]');
    const fd = new FormData(form);
    if (btn) btn.disabled = true;
    try {
      await api('/api/local/connect/network', {
        method: 'PATCH',
        body: JSON.stringify({
          transportMode: String(fd.get('transportMode') || 'loop_relay'),
          tunnelEndpoint: String(fd.get('tunnelEndpoint') || '').trim() || null,
          requirePrivateTunnel: Boolean(form.querySelector('input[name="requirePrivateTunnel"]')?.checked),
        }),
      });
      toast('Network settings saved.', 'ok');
      await loadSettingsPopup();
    } catch (err) {
      toast(err.message || 'Could not save network settings.', 'err');
      if (btn) btn.disabled = false;
    }
  });

  root.querySelector('#billing-waitlist-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const res = await api('/api/billing/waitlist', {
        method: 'POST',
        body: JSON.stringify({
          email: fd.get('email'),
          plan: fd.get('plan'),
          teamSize: fd.get('teamSize'),
        }),
      });
      if (!form.isConnected) return;
      form.reset();
      toast(res?.alreadyJoined ? 'You’re already on the waitlist — details updated.' : 'You’re on the waitlist!', 'ok');
    } catch (err) {
      if (form.isConnected) toast(err.message, 'err');
    } finally {
      button.disabled = false;
    }
  });

  root.querySelector('#restore-local-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!canRestoreMac()) return;
    const form = e.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const ok = await confirmDialog({
      title: 'Restore this Mac workspace?',
      message: 'Restore the workspace on this Mac to your signed-in Loop account.',
      confirmLabel: 'Restore workspace',
    });
    if (!ok) return;
    const password = new FormData(form).get('password');
    button.disabled = true;
    try {
      const result = await api('/api/auth/claim-local', { method: 'POST', body: JSON.stringify({ password }) });
      if (result?.ok === false) throw new Error('Could not restore workspace');
      form.reset();
      lockDashboard(false);
      history.replaceState(null, '', '/#settings?tab=account');
      location.reload();
    } catch (err) {
      if (form.isConnected) toast(err.message, 'err');
    } finally {
      button.disabled = false;
    }
  });

  // Shared projects that the user joined as a guest (Loop Cloud only), with a direct Leave button.
  const sharedHost = root.querySelector('#st-shared-with-me');
  if (sharedHost && appMode) {
    const loadSharedWithMe = async () => {
      try {
        const res = await api('/api/shares/with-me');
        if (!sharedHost.isConnected) return;
        const list = Array.isArray(res?.shared) ? res.shared : [];
        if (!list.length) {
          sharedHost.innerHTML = '';
          return;
        }
        sharedHost.innerHTML = `
          <div class="st-grp">Shared with me</div>
          <div class="st-list">
            ${list.map((s) => `
              <div class="ln">
                <span class="ln-tx">
                  <span class="ln-t">${esc(s.profile)}</span>
                  <span class="ln-sub">Shared by ${esc(s.ownerName || 'A Loop user')} · ${esc(s.connections)} ${s.connections === 1 ? 'connection' : 'connections'} · ${esc(s.agents)} ${s.agents === 1 ? 'agent' : 'agents'}</span>
                </span>
                ${s.id ? `<button type="button" class="btn sm ghost danger-text" data-share-leave="${esc(s.id)}" data-share-name="${esc(s.profile)}">Leave</button>` : ''}
              </div>`).join('')}
          </div>`;
        sharedHost.querySelectorAll('[data-share-leave]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const shareId = btn.dataset.shareLeave;
            const shareName = btn.dataset.shareName || 'this project';
            const ok = await confirmDialog({
              title: `Leave ${shareName}?`,
              message: 'Your agent keys for this shared project will stop working right away.',
              confirmLabel: 'Leave project',
              danger: true,
            });
            if (!ok) return;
            btn.disabled = true;
            try {
              await api(`/api/shares/with-me/${encodeURIComponent(shareId)}`, { method: 'DELETE' });
              toast(`Left ${shareName}.`, 'ok');
              await loadSharedWithMe();
            } catch (err) {
              toast(err.message || 'Could not leave project.', 'err');
              btn.disabled = false;
            }
          });
        });
      } catch {
        // Local mode or offline: omit the Shared with me section quietly.
      }
    };
    void loadSharedWithMe();
  }

  wireLook(root);
  root.querySelectorAll('[data-st-agent]').forEach((btn) => btn.addEventListener('click', () => {
    openAgentPopup(agentPopupCtx(), btn.dataset.stAgent, 'activity');
  }));
  root.querySelector('[data-st-add-agent]')?.addEventListener('click', () => {
    openAddAgent(agentPopupCtx(), { project: uiState.activeProfile });
  });
  root.querySelector('#sign-out')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      if (auth.mode === 'clerk') {
        clearPendingAuthStorage();
        notifyOtherTabsSignOut();
        leavingDashboard = true;
        lockDashboard(false);
        await withAuthTimeout(clerk.signOut({ redirectUrl: SIGN_IN_PATH }));
        location.replace(SIGN_IN_PATH);
        return;
      }
      clearPendingAuthStorage();
      const result = await api('/api/auth/logout', { method: 'POST' });
      if (result?.ok === false) throw new Error('Sign-out failed');
      notifyOtherTabsSignOut();
      closeSettings({ immediate: true });
      auth.signedIn = false;
      authCheck = null;
      clearApprovalBanner();
      render();
    } catch {
      if (auth.mode === 'clerk') {
        closeSettings({ immediate: true });
        renderAuthUnavailable('Could not sign out. Retry to check your session.');
      } else toast('Could not sign out. Refresh the page and try again.', 'err');
    } finally {
      button.disabled = false;
    }
  });
}

/* ===========================
   ROUTER
   =========================== */
// A page draws into a hidden view while the one on screen stays put, then the two swap in one
// step, so moving between tabs never shows an empty page while data loads.
const VIEW_SWAP_WAIT_MS = 800; // a slow page shows anyway after this, with whatever it has drawn
function stageView(main) {
  const view = document.createElement('div');
  view.className = 'view is-staged'; // app.css: rules about the page on screen skip a staged one
  view.style.display = 'none';
  main.appendChild(view);
  return view;
}
function showView(main, view) {
  if (!view.isConnected || view.style.display !== 'none') return;
  for (const el of [...main.children]) if (el !== view) el.remove();
  view.classList.remove('is-staged');
  view.style.display = '';
  view.dispatchEvent(new Event('view-shown'));
  alignSideColumn(); // the side menu is in its place in the first frame
  showSideCurrent();
}

function resetView(main) {
  destroyMemoryView();
  main.innerHTML = '<div class="view"></div>';
  return main.lastElementChild;
}

function renderAuthScreen(root) {
  const isSetup = !auth.setUp;
  root.innerHTML = `
    <section class="hero">
      <h1>${isSetup ? 'Create your Loop password' : 'Sign in'}</h1>
      <p class="intro">${isSetup
        ? 'This password protects your Loop dashboard and is needed to view any saved secret. Your agents never get it. Loop cannot recover it, so keep it somewhere safe.'
        : 'Enter your Loop password to manage agents, connections and secrets.'}</p>
    </section>
    <section class="card">
      <form id="auth-form" class="form-grid" method="post">
        <label class="field">
          <span class="lbl">Password</span>
          <input name="password" type="password" required ${isSetup ? 'minlength="8" autocomplete="new-password"' : 'autocomplete="current-password"'} autofocus>
        </label>
        ${isSetup ? `
          <label class="field">
            <span class="lbl">Type it again</span>
            <input name="confirm" type="password" required minlength="8" autocomplete="new-password">
          </label>
        ` : ''}
        <div class="acts">
          <button type="submit" class="btn fill">${isSetup ? 'Create password' : 'Sign in'}</button>
        </div>
      </form>
    </section>
  `;
  root.querySelector('#auth-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const password = String(fd.get('password') || '');
    if (isSetup && password !== String(fd.get('confirm') || '')) {
      toast('The two passwords do not match.', 'err');
      return;
    }
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const result = await api(isSetup ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      if (result?.ok === false) throw new Error('Authentication failed');
      auth.setUp = true;
      auth.signedIn = true;
      render();
    } catch {
      toast(isSetup ? 'Could not create your Loop password. Try again.' : 'Could not sign in. Check your Loop password and try again.', 'err');
      btn.disabled = false;
    }
  });
}

function makeUi(seq) {
  return {
    esc,
    api,
    toast,
    copyText,
    confirmDialog,
    renderLoading,
    renderErrorState,
    canImportFromMac,
    isCurrent: () => seq === renderSeq,
  };
}

// The page on screen, so render() can tell a move to another page from a redraw of the same one.
let shownSection = null;
// Resolves once the page being drawn is on screen and loaded, or a newer draw has replaced it.
let pageShown = Promise.resolve();

// Runs fn once Home is on screen. A panel opened any earlier goes away with the page Home replaces.
async function onHomeShown(fn) {
  let waited;
  do {
    waited = pageShown;
    await waited;
  } while (waited !== pageShown);
  if (auth.signedIn && shownSection === 'home') fn();
}
let currentPageTurn = null;
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

// What the agent popups need from the dashboard. Closing one after a change redraws the page.
function agentPopupCtx(extra = {}) {
  return {
    ...extra,
    esc,
    api,
    toast,
    copyText,
    canImportFromMac,
    renderConnLogo,
    groupConnectionsByCategory,
    addAgent: (opts) => openAddAgent(agentPopupCtx(extra), opts),
    vaultModeOf: async () => {
      const policies = normalizePolicies(await api('/api/policies'));
      return (secret) => effectiveSecretApproval(secret, policies);
    },
    ownerName: () => clerk?.user?.firstName || clerk?.user?.fullName || '',
    onClose: (changed) => {
      if (changed && auth.signedIn) render();
    },
  };
}

// What the connection popups need from the dashboard.
function connectionPopupCtx() {
  return {
    api,
    esc,
    toast,
    copyText,
    renderConnLogo,
    openLogoDialog,
    getToolCounts,
    formatToolResult,
    formatOAuthError,
    parseArgsInput,
    parseEnvLines,
    parseHeaderLines,
    normalizeApprovalMode,
    effectiveConnectionApproval,
    effectiveToolApproval,
    effectivePinnedTools,
    passwordName,
    lentBy: (id) => lentBy.get(id) || '',
    noGuardPassword,
    isPersonalWorkspace: () => auth.mode === 'clerk' && !canImportFromMac(),
    activeProfile: () => uiState.activeProfile,
    renderImportFromAgents: (container, onDone) => renderImportFromAgents(container, makeUi(renderSeq), onDone),
    openAgent: (id, tab = 'access') => openAgentPopup(agentPopupCtx(), id, tab),
    onClose: (changed) => {
      if (changed && auth.signedIn) render();
    },
  };
}

function hideDashboardNavigation() {
  closeSettings({ immediate: true });
  closeAgentPopup({ immediate: true, quiet: true });
  closeConnectionPopup({ immediate: true, quiet: true });
  uiState.profileMenu = false;
  uiState.profileQuery = '';
  closeProfileMenu = null;
  for (const selector of ['.nav', '#toplink-settings', '#back', '#top-profile-slot']) {
    const el = document.querySelector(selector);
    if (el) el.hidden = true;
  }
}

function renderAuthUnavailable(message = 'Loop could not verify your sign-in. Check your connection and try again.') {
  const main = document.getElementById('main');
  if (!main) return;
  document.title = 'Sign in · Loop';
  const view = resetView(main);
  view.innerHTML = `
    <section id="loop-auth-screen" class="hero">
      <h1>Sign in to Loop</h1>
      <p class="intro" role="alert">${esc(message)}</p>
      <div class="acts center"><button type="button" class="btn fill" id="auth-retry">Retry</button></div>
    </section>
  `;
  view.querySelector('#auth-retry')?.addEventListener('click', () => location.reload());
}

function lockDashboard(blocked = true) {
  auth.signedIn = false;
  authFailed = blocked;
  activeClerkSession = null;
  shownSection = null;
  latestProfileRecords = [];
  profileRecordsLoaded = false;
  specialistCaps = { loaded: false, enabled: false, hosted: false, runners: [], defaultRunner: '', mausbot: null };
  specialistCapsPromise = null;
  syncSpecialistNav();
  destroyLoopChatView();
  ++renderSeq;
  prefetched.clear();
  uiState.skillCache.clear();
  syncDashboardEvents();
  clearApprovalBanner();
  if (currentPageTurn) currentPageTurn.skipTransition();
  const notice = document.getElementById('toast');
  if (notice) {
    clearTimeout(toast._timer);
    notice.textContent = '';
    notice.className = 'toast';
  }
  hideDashboardNavigation();
  if (blocked) renderAuthUnavailable();
  else document.getElementById('main')?.replaceChildren();
}

async function clerkSessionToken(sessionId) {
  const session = clerk?.session;
  if (session?.id !== sessionId || clerk.status === 'degraded') throw new Error('Sign-in required');
  const token = await withAuthTimeout(session.getToken());
  if (!token || clerk.session?.id !== sessionId || clerk.status === 'degraded') throw new Error('Sign-in required');
  return token;
}

function renderClerkScreen(canContinue, subtitle = '') {
  const main = document.getElementById('main');
  if (!main) return;
  const title = signUpPage && !canContinue ? 'Create your Loop account' : 'Sign in to Loop';
  document.title = `${title} · Loop`;
  const view = resetView(main);
  view.innerHTML = `
    <section class="hero" id="loop-auth-screen">
      ${canContinue ? `
        <h1>${title}</h1>
        <p class="intro">Manage your agents, connections, and Vault in one workspace.</p>
        <div class="acts center"><a class="btn fill" href="/">Continue to Loop</a></div>
      ` : `${subtitle ? `<p class="intro">${esc(subtitle)}</p>` : ''}<div id="loop-clerk-mount"></div>`}
    </section>
  `;
  if (!canContinue) mountClerkAuth(clerk, view.querySelector('#loop-clerk-mount'));
}

async function renderOAuthConsentScreen() {
  hideDashboardNavigation();
  const main = document.getElementById('main');
  if (!main) return;
  document.title = 'Connect agent · Loop';
  const view = resetView(main);
  view.innerHTML = `
    <section class="hero" id="loop-oauth-screen">
      <div class="loading" role="status"><div class="spin" aria-hidden="true"></div><p>Loading connection request&hellip;</p></div>
    </section>
  `;

  const stopPendingRedirect = () => {
    try {
      if (typeof window !== 'undefined' && typeof window.stop === 'function') window.stop();
    } catch {
      // ignore
    }
  };

  const renderHandoffResult = (status, name, errMsg = '') => {
    stopPendingRedirect();
    if (status === 'connected') {
      document.title = 'Connected · Loop';
      view.innerHTML = `
        <section class="hero" id="loop-oauth-screen">
          <h1>"${esc(name)}" connected</h1>
          <p class="intro">Confirmed &mdash; <strong>${esc(name)}</strong> finished signing in to Loop. You can close this tab.</p>
          <div class="acts center"><a class="btn fill" href="/">Open Loop</a></div>
        </section>
      `;
      return;
    }
    if (status === 'failed') {
      document.title = 'Connection failed · Loop';
      view.innerHTML = `
        <section class="hero" id="loop-oauth-screen">
          <h1>"${esc(name)}" couldn't finish connecting</h1>
          <p class="intro" role="alert">${esc(errMsg || 'The agent could not complete the sign-in handshake. Start sign-in again in your agent.')}</p>
          <div class="acts center"><a class="btn fill" href="/">Open Loop</a></div>
        </section>
      `;
      return;
    }
    document.title = 'Sign-in expired · Loop';
    view.innerHTML = `
      <section class="hero" id="loop-oauth-screen">
        <h1>"${esc(name)}" didn't finish connecting</h1>
        <p class="intro" role="alert">The sign-in link expired before <strong>${esc(name)}</strong> completed the handshake. Start sign-in again in your agent.</p>
        <div class="acts center"><a class="btn fill" href="/">Open Loop</a></div>
      </section>
    `;
  };

  const startHandoffWatch = (name, redirectUrl = '') => {
    let stopped = false;
    let pollTimer = null;
    let fallbackTimer = null;
    const cleanup = () => {
      stopped = true;
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    };
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', cleanup, { once: true });
    }

    let authCode = '';
    if (redirectUrl) {
      try {
        authCode = new URL(redirectUrl, location.origin).searchParams.get('code') || '';
      } catch { /* ignore */ }
    }

    const fallbackHtml = redirectUrl && typeof renderOAuthHandoffFallback === 'function'
      ? renderOAuthHandoffFallback({ name, redirectUrl, esc })
      : '';

    document.title = 'Finishing connection · Loop';
    view.innerHTML = `
      <section class="hero" id="loop-oauth-screen">
        <div class="spin" aria-hidden="true"></div>
        <h1>Finishing connection to "${esc(name)}"&hellip;</h1>
        <p class="intro" role="status">${redirectUrl ? `Sending sign-in back to <strong>${esc(name)}</strong> and waiting for it to finish connecting.` : `Waiting for <strong>${esc(name)}</strong> to finish signing in to Loop.`}</p>
      </section>
      ${fallbackHtml}
    `;

    if (redirectUrl) {
      view.querySelector('#oauth-copy-code')?.addEventListener('click', () => {
        copyText(authCode || redirectUrl, 'Code copied.');
      });
      view.querySelector('#oauth-copy-callback')?.addEventListener('click', () => {
        copyText(redirectUrl, 'Callback URL copied.');
      });
      view.querySelector('#oauth-open-callback')?.addEventListener('click', () => {
        stopPendingRedirect();
        location.assign(redirectUrl);
      });
      fallbackTimer = setTimeout(() => {
        if (stopped) return;
        const fb = view.querySelector('#oauth-handoff-fallback');
        if (fb) fb.hidden = false;
      }, 2500);
    }

    const pollStatus = async () => {
      if (stopped) return;
      try {
        const st = await api(`/api/oauth/requests/${encodeURIComponent(oauthTxId)}/status`);
        if (stopped) return;
        const resolvedName = st?.clientName || name;
        if (st?.status === 'connected' || st?.status === 'failed' || st?.status === 'expired') {
          cleanup();
          renderHandoffResult(st.status, resolvedName, st.error || '');
          return;
        }
      } catch (pollErr) {
        if (stopped) return;
        if (pollErr?.status === 404) {
          cleanup();
          renderHandoffResult('expired', name);
          return;
        }
      }
      if (!stopped) pollTimer = setTimeout(pollStatus, 1000);
    };
    pollTimer = setTimeout(pollStatus, 700);
  };

  try {
    const data = await api(`/api/oauth/requests/${encodeURIComponent(oauthTxId)}`);
    const req = data.request;
    const clientName = req?.clientName || 'MCP Client';
    const workspaceLabel = data.workspace === 'local' ? 'Local Mac workspace' : 'Personal workspace';

    if (!data.canApprove) {
      view.innerHTML = `
        <section class="hero" id="loop-oauth-screen">
          <h1>Cannot connect "${esc(clientName)}"</h1>
          <p class="intro" role="alert">An app calling itself <strong>${esc(clientName)}</strong> (unverified name) targeted <code>${esc(req.resourcePath)}</code>, which does not match your active ${esc(workspaceLabel)}.</p>
          <div class="acts center">
            <button type="button" class="btn" id="oauth-deny">Back to "${esc(clientName)}"</button>
            <a class="btn fill" href="/">Open Loop</a>
          </div>
        </section>
      `;
      view.querySelector('#oauth-deny')?.addEventListener('click', async () => {
        try {
          const res = await api(`/api/oauth/requests/${encodeURIComponent(oauthTxId)}/deny`, { method: 'POST' });
          if (res?.redirectUrl) location.assign(res.redirectUrl);
        } catch {
          location.replace('/');
        }
      });
      return;
    }

    const callbackDisplay = req.redirectUri || req.redirectHost || '';
    const oauthProfiles = Array.isArray(req?.profileRecords) && req.profileRecords.length > 0
      ? req.profileRecords
      : (Array.isArray(data?.profileRecords) ? data.profileRecords : []);
    const requestedProfile = typeof req?.requestedProfile === 'string' ? req.requestedProfile : '';
    const agentProfile = typeof data?.agentAccess?.profile === 'string' ? data.agentAccess.profile : '';
    const activePref = typeof uiState !== 'undefined' && uiState?.activeProfile ? uiState.activeProfile : 'all';
    const defaultOauthProfile = (requestedProfile && oauthProfiles.some((p) => p && p.id === requestedProfile))
      ? requestedProfile
      : (agentProfile && (agentProfile === 'all' || oauthProfiles.some((p) => p && p.id === agentProfile)))
        ? agentProfile
        : (oauthProfiles.some((p) => p && p.id === activePref) ? activePref : 'all');
    const currentAgent = data.agent ? { ...data.agent, ...(data.agentAccess || {}) } : null;
    view.innerHTML = `
      <section class="hero oc-hero" id="loop-oauth-screen">
        <h1>Connect "${esc(clientName)}" to Loop</h1>
        <p class="intro">An app calling itself <strong>${esc(clientName)}</strong> (unverified name) wants access to your ${esc(workspaceLabel)}.${callbackDisplay ? ` After you approve, Loop sends a sign-in code to <code class="mono oc-cb-url">${esc(callbackDisplay)}</code>.` : ''}</p>
        <div class="acts center">
          <button type="button" class="btn fill" id="oauth-allow">Connect</button>
          <button type="button" class="btn" id="oauth-deny">Cancel</button>
        </div>
      </section>
      <section class="oc-drawer" id="oc-drawer" aria-label="Choose what ${esc(clientName)} can access">
        <div class="oc-drawer-in">
          <div id="oc-picker"></div>
        </div>
      </section>
    `;

    const pickerCtrl = typeof mountOAuthConsentPicker === 'function'
      ? mountOAuthConsentPicker(view, {
          esc,
          api,
          renderConnLogo,
          groupConnectionsByCategory,
          oauthProfiles,
          defaultProfile: defaultOauthProfile,
          clientName,
          currentAgent,
          offerOneConnection: true,
        })
      : { getApprovalPayload() { throw new Error('Reload Loop to review access before connecting.'); } };

    view.addEventListener('click', async (e) => {
      const btn = e.target?.closest?.('#oauth-allow, [data-oauth-allow]');
      if (!btn || btn.disabled) return;
      const allAllowBtns = [...view.querySelectorAll('#oauth-allow, [data-oauth-allow]')];
      const labels = allAllowBtns.map((b) => b.textContent);
      for (const b of allAllowBtns) {
        b.disabled = true;
        b.textContent = 'Connecting…';
      }
      try {
        const payload = pickerCtrl.getApprovalPayload();
        const approveOpts = { method: 'POST' };
        if (payload && (payload.access || (payload.profile && payload.profile !== 'all'))) {
          approveOpts.body = JSON.stringify(payload);
        }
        const res = await api(`/api/oauth/requests/${encodeURIComponent(oauthTxId)}/approve`, approveOpts);
        if (!res?.redirectUrl) throw new Error('Missing callback URL');
        startHandoffWatch(clientName, res.redirectUrl);
        location.assign(res.redirectUrl);
      } catch (err) {
        toast(err?.message || 'Could not authorize agent.', 'err');
        for (const [index, b] of allAllowBtns.entries()) {
          b.disabled = false;
          b.textContent = labels[index];
        }
      }
    });

    view.querySelector('#oauth-deny')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        const res = await api(`/api/oauth/requests/${encodeURIComponent(oauthTxId)}/deny`, { method: 'POST' });
        if (res?.redirectUrl) location.assign(res.redirectUrl);
        else location.replace('/');
      } catch {
        location.replace('/');
      }
    });
  } catch (err) {
    if (err?.status === 404) {
      try {
        const st = await api(`/api/oauth/requests/${encodeURIComponent(oauthTxId)}/status`);
        const name = st?.clientName || 'MCP Client';
        if (st?.status === 'connected' || st?.status === 'failed') {
          renderHandoffResult(st.status, name, st.error || '');
          return;
        }
        if (st?.status === 'waiting') {
          startHandoffWatch(name, '');
          return;
        }
      } catch {
        // Fall through to expired state below.
      }
    }
    view.innerHTML = `
      <section class="hero" id="loop-oauth-screen">
        <h1>Sign-in request expired</h1>
        <p class="intro" role="alert">${esc(err?.message || 'Click Authenticate again in your agent to start a fresh sign-in.')}</p>
        <div class="acts center"><a class="btn fill" href="/">Open Loop</a></div>
      </section>
    `;
  }
}

async function renderDeviceApprovalScreen(initialCode = deviceCodeParam) {
  hideDashboardNavigation();
  const main = document.getElementById('main');
  if (!main) return;
  document.title = 'Connect device · Loop';
  const view = resetView(main);

  const showCodeEntry = (errorMsg = '') => {
    view.innerHTML = `
      <section class="hero" id="loop-device-screen">
        <h1>Connect your agents to Loop</h1>
        <p class="intro">Enter the 8-character code shown in your terminal.</p>
      </section>
      <section class="card oc-code-card dc-entry-card">
        <form id="dc-code-form" class="dc-form">
          <input type="text" id="dc-code-input" class="dc-code-input" placeholder="ABCD-EFGH" autocomplete="off" spellcheck="false" maxlength="12" aria-label="Sign-in code" required>
          ${errorMsg ? `<p class="oc-code-hint" role="alert">${esc(errorMsg)}</p>` : ''}
          <div class="acts center">
            <button type="submit" class="btn fill">Continue</button>
            <a class="btn" href="/">Cancel</a>
          </div>
        </form>
      </section>
    `;
    const input = view.querySelector('#dc-code-input');
    input?.focus();
    view.querySelector('#dc-code-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const entered = String(input?.value || '').trim();
      if (entered) renderDeviceApprovalScreen(entered);
    });
  };

  if (!initialCode || initialCode === '1') {
    showCodeEntry();
    return;
  }

  view.innerHTML = `
    <section class="hero" id="loop-device-screen">
      <div class="loading" role="status"><div class="spin" aria-hidden="true"></div><p>Loading sign-in code&hellip;</p></div>
    </section>
  `;

  try {
    const data = await api(`/api/oauth/device/${encodeURIComponent(initialCode)}`);
    const req = data.request;
    const clientName = req?.clientName || 'Loop CLI';
    const userCode = req?.userCode || initialCode;
    const agents = Array.isArray(req?.agents) ? req.agents : [];
    const selectedIds = new Set(agents.map((a) => a.id));
    const oauthProfiles = Array.isArray(data?.profileRecords) ? data.profileRecords : [];
    const requestedProfile = typeof req?.requestedProfile === 'string' ? req.requestedProfile : '';
    const activePref = typeof uiState !== 'undefined' && uiState?.activeProfile ? uiState.activeProfile : 'all';
    const defaultProfile = (requestedProfile && oauthProfiles.some((p) => p && p.id === requestedProfile))
      ? requestedProfile
      : (oauthProfiles.some((p) => p && p.id === activePref) ? activePref : 'all');

    view.innerHTML = `
      <section class="hero oc-hero" id="loop-oauth-screen">
        <h1>Connect "${esc(clientName)}" to Loop</h1>
        <p class="intro">Verify code <code class="dc-code-pill">${esc(userCode)}</code> matches your terminal.</p>
        <div class="acts center">
          <button type="button" class="btn fill" id="oauth-allow">Connect</button>
          <button type="button" class="btn" id="oauth-deny">Cancel</button>
        </div>
      </section>
      ${agents.length > 0 ? `
        <section class="dc-agents-wrap" aria-label="Agents to connect">
          <div class="dc-agents" id="dc-agents">
            ${agents.map((a) => `
              <label class="dc-agent-chip">
                <input type="checkbox" value="${esc(a.id)}" checked>
                <span>${esc(a.name)}</span>
              </label>
            `).join('')}
          </div>
        </section>
      ` : ''}
      <section class="oc-drawer" id="oc-drawer" aria-label="Choose what ${esc(clientName)} can access">
        <div class="oc-drawer-in">
          <div id="oc-picker"></div>
        </div>
      </section>
    `;

    view.querySelectorAll('#dc-agents input[type="checkbox"]').forEach((box) => {
      box.addEventListener('change', () => {
        if (box.checked) selectedIds.add(box.value);
        else selectedIds.delete(box.value);
      });
    });

    const pickerCtrl = typeof mountOAuthConsentPicker === 'function'
      ? mountOAuthConsentPicker(view, {
          esc,
          api,
          renderConnLogo,
          groupConnectionsByCategory,
          oauthProfiles,
          defaultProfile,
          clientName,
        })
      : { getApprovalPayload: () => ({ profile: defaultProfile }) };

    view.addEventListener('click', async (e) => {
      const btn = e.target?.closest?.('#oauth-allow');
      if (!btn || btn.disabled) return;
      if (agents.length > 0 && selectedIds.size === 0) {
        toast('Select at least one agent to connect.', 'err');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Connecting…';
      try {
        const payload = pickerCtrl.getApprovalPayload() || {};
        if (agents.length > 0) payload.agents = [...selectedIds];
        const res = await api(`/api/oauth/device/${encodeURIComponent(userCode)}/approve`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        const count = Array.isArray(res?.agents) ? res.agents.length : selectedIds.size;
        const names = Array.isArray(res?.agents) ? res.agents.map((a) => a.name).join(', ') : clientName;
        document.title = 'Connected · Loop';
        view.innerHTML = `
          <section class="hero" id="loop-device-screen">
            <h1>Approved</h1>
            <p class="intro">Loop authorized <strong>${esc(names || clientName)}</strong> (${count} ${count === 1 ? 'agent' : 'agents'}). Your terminal will write the config files automatically. You can close this tab.</p>
            <div class="acts center"><a class="btn fill" href="/">Open Loop</a></div>
          </section>
        `;
      } catch (err) {
        toast(err?.message || 'Could not approve device sign-in.', 'err');
        btn.disabled = false;
        btn.textContent = 'Connect';
      }
    });

    view.querySelector('#oauth-deny')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api(`/api/oauth/device/${encodeURIComponent(userCode)}/deny`, { method: 'POST' });
      } catch {
        // Ignore errors and return to Loop home.
      }
      location.replace('/');
    });
  } catch (err) {
    showCodeEntry(err?.message || 'That code is invalid or expired. Check your terminal and try again.');
  }
}

async function checkAuth() {
  try {
    const initial = await getAuthStatus();
    auth.mode = initial.mode || 'local';
    if (auth.mode !== 'clerk') {
      if (typeof initial.setUp !== 'boolean') throw new Error('Invalid sign-in status');
      auth.setUp = initial.setUp;
      auth.signedIn = initial.signedIn;
      if (auth.signedIn) {
        if (oauthTxId) await renderOAuthConsentScreen();
        else if (deviceCodeParam) await renderDeviceApprovalScreen();
        else render();
      } else {
        document.title = 'Sign in · Loop';
        const main = document.getElementById('main');
        if (main) renderAuthScreen(resetView(main));
      }
      return;
    }

    clerk = await loadClerkApp(initial, clerkAuthPage || Boolean(oauthTxId || deviceCodeParam));
    const sessionId = clerk.session?.id;
    if (!sessionId) {
      if (initial.signedIn) throw new Error('Could not reconcile session');
      if (oauthTxId || deviceCodeParam) renderClerkScreen(false, 'Sign in to Loop to connect your agents.');
      else if (clerkAuthPage) renderClerkScreen(false);
      else {
        savePostLoginHash();
        location.replace(SIGN_IN_PATH);
      }
      return;
    }

    // A dev session may not be visible to the server until Clerk obtains its first token.
    const status = await getAuthStatus(await clerkSessionToken(sessionId));
    if (clerk.session?.id !== sessionId || status.mode !== 'clerk' || !status.signedIn ||
        (status.userId && status.userId !== clerk.user?.id)) throw new Error('Could not verify session');
    if (clerkAuthPage && !oauthTxId && !deviceCodeParam) {
      // No automatic redirect from here for an existing session. This prevents a redirect loop.
      renderClerkScreen(true);
      clerk.addListener(({ session }) => {
        if (session?.id !== sessionId) location.reload();
      }, { skipInitialEmit: true });
      return;
    }

    activeClerkSession = sessionId;
    auth.workspace = status.workspace;
    auth.vaultPasswordSet = status.vaultPasswordSet === true;
    auth.canImportLocal = status.canImportLocal === true;
    auth.localAvailable = status.localAvailable === true;
    auth.signedIn = true;
    clerk.addListener(({ session }) => {
      if (!leavingDashboard && auth.signedIn && session?.id !== activeClerkSession) {
        // A fresh document also clears state retained inside the Agents module.
        leavingDashboard = true;
        lockDashboard(false);
        location.reload();
      }
    }, { skipInitialEmit: true });
    if (oauthTxId) {
      await renderOAuthConsentScreen();
      return;
    }
    if (deviceCodeParam) {
      await renderDeviceApprovalScreen();
      return;
    }
    restorePostLoginHash();
    render();
  } catch {
    lockDashboard();
  }
}

async function render() {
  if (!auth.signedIn) {
    hideDashboardNavigation();
    syncDashboardEvents();
    if (!authFailed && !authCheck) authCheck = checkAuth();
    return;
  }
  if (oauthTxId) {
    await renderOAuthConsentScreen();
    return;
  }
  if (deviceCodeParam) {
    await renderDeviceApprovalScreen();
    return;
  }
  const inviteBack = takeInviteReturn('login');
  if (inviteBack) {
    location.replace(inviteBack.to);
    return;
  }
  const seq = ++renderSeq;
  connectionsRefreshWaiting = false; // this draw loads current data
  agentsRefreshWaiting = false;
  memoryRefreshWaiting = false;
  if (!specialistCaps.loaded) {
    await ensureSpecialistCaps();
    if (seq !== renderSeq || !auth.signedIn) return;
  }
  syncSpecialistNav();
  syncDashboardEvents();
  const navEl = document.querySelector('.nav');
  if (navEl) navEl.hidden = false;
  const topSettingsLink = document.getElementById('toplink-settings');
  if (topSettingsLink) topSettingsLink.hidden = false;
  const back = document.getElementById('back');

  const { section, part, subSeg, params, focusApprovals, approvalId } = parseRoute();
  // Old addresses (#memory, #saved, #brain) show the address of their part.
  const oldAddress = location.hash.match(/^#\/?(?:memory|saved|save|brain)(?=$|[/?])[^?]*(\?.*)?$/i);
  if (part && oldAddress) history.replaceState(null, '', `${brainHash(part)}${oldAddress[1] || ''}`);
  const requestedProfileParam = params.get('project') || params.get('profile');
  if (requestedProfileParam && requestedProfileParam !== uiState.activeProfile) {
    setActiveProfile(requestedProfileParam);
  }
  if (section !== 'connections' || focusApprovals) {
    closeConnectionPopup({ immediate: true, quiet: true });
  }
  if (section !== 'agents' || focusApprovals) {
    closeAgentPopup({ immediate: true, quiet: true });
  }
  if (section === 'library') {
    history.replaceState(null, '', '#home');
    return render();
  }
  if (section === 'agents') {
    // Old #agents links open the agent they name over Home, or else the list of agents in Settings.
    const agentId = params.get('agent');
    history.replaceState(null, '', '#home');
    if (agentId) {
      if (shownSection !== 'home') render();
      return onHomeShown(() => openAgentPopup(agentPopupCtx(), agentId, params.get('tab') || ''));
    }
    // The list of agents is in Settings now.
    history.replaceState(null, '', '#settings?tab=agents');
    return render();
  }
  // The page of an invite goes on here: the new Loop, with Add agent open at the app that was picked.
  if (section === 'home' && !focusApprovals && params.get('add')) {
    const kind = params.get('add');
    history.replaceState(null, '', '#home');
    if (shownSection !== 'home') render();
    return onHomeShown(() => {
      openAddAgent(agentPopupCtx(), { project: uiState.activeProfile, ...(INSTALL_KINDS.includes(kind) ? { kind } : { allApps: true }) });
    });
  }
  if (section === 'connections') {
    // Connections open as centered popups over Home; never stay on #connections.
    captureOAuthFromHash();
    const pendingOAuth = takePendingOAuth();
    const oauthCode = pendingOAuth?.code || params.get('oauth_code');
    const oauthState = pendingOAuth?.state || params.get('oauth_state');
    const oauthIss = pendingOAuth?.iss || params.get('oauth_iss') || params.get('iss') || '';
    let oauthError = pendingOAuth?.error || params.get('oauth_error') || '';
    let connectedId = params.get('oauth_connected') || params.get('connected') || '';
    const oauthStateResult = params.get('oauth_state_result') || '';
    let oauthResult = null;
    const connId = params.get('conn') || '';
    const signInId = params.get('signin') || '';
    const panel = params.get('panel') || '';

    history.replaceState(null, '', `${location.pathname || '/'}#home`);

    if (oauthCode && oauthState) {
      oauthFinishing = true;
      try {
        const res = await api('/api/mcps/oauth/finish', {
          method: 'POST',
          body: JSON.stringify({
            code: oauthCode,
            state: oauthState,
            ...(oauthIss ? { iss: oauthIss } : {}),
          }),
        });
        oauthResult = res && typeof res === 'object' ? res : null;
        if (returnToInvite(res?.connected, oauthResult?.ready === false ? 'discovery_failed' : '')) return;
        if (seq !== renderSeq) return;
        if (res?.connected) connectedId = res.connected;
      } catch (err) {
        if (returnToInvite('', classifyOAuthFinishError(err))) return;
        if (seq !== renderSeq) return;
        oauthError = classifyOAuthFinishError(err);
      } finally {
        oauthFinishing = false;
      }
      connectionsRefreshWaiting = false;
    } else if (connectedId && !oauthError && auth.signedIn) {
      try {
        const statusRes = await api(`/api/mcps/${encodeURIComponent(connectedId)}/read-status`);
        if (seq !== renderSeq) return;
        if (statusRes && typeof statusRes === 'object') {
          oauthResult = {
            connected: connectedId,
            ready: Boolean(statusRes.readiness?.ready),
            readiness: statusRes.readiness || null,
            readEvidence: statusRes.readEvidence || null,
            discoveryError: statusRes.readiness?.ready ? null : (statusRes.lastError || statusRes.readiness?.nextStep || null),
            name: statusRes.name || '',
          };
        }
      } catch {
        if (oauthStateResult) {
          oauthResult = {
            connected: connectedId,
            ready: oauthStateResult === 'ready',
            readiness: { state: oauthStateResult, ready: oauthStateResult === 'ready' },
          };
        }
      }
    }

    if (returnToInvite(connectedId, oauthError || (oauthResult?.ready === false ? 'discovery_failed' : ''))) return;
    if (oauthError) {
      toast(formatOAuthError(oauthError), 'err');
    } else if (connectedId) {
      const signInNotice = postSignInSummary(oauthResult || {
        ready: oauthStateResult === 'ready',
        readiness: { state: oauthStateResult || 'not_synced', ready: oauthStateResult === 'ready' },
      });
      toast(signInNotice.toast, signInNotice.tone);
    }

    const targetConnId = signInId || connId || connectedId;
    const openTarget = () => {
      if (!auth.signedIn) return;
      if (signInId) {
        toast('Opening sign-in…');
        startInstantSignIn(signInId, {
          onFallback: (err) => onHomeShown(() => {
            openConnectionPopup(connectionPopupCtx(), signInId, {
              focusCredentials: true,
              authModeHint: err?.data?.authModeHint || null,
            });
          }),
        });
      } else if (targetConnId) {
        onHomeShown(() => openConnectionPopup(connectionPopupCtx(), targetConnId, {
          ...(oauthError ? { oauthError } : {}),
          ...(oauthResult ? { oauthResult } : {}),
        }));
      } else if (panel === 'add' || panel === 'import') {
        onHomeShown(() => openAddConnectionPopup(connectionPopupCtx(), {
          tab: panel === 'import' ? 'import' : 'add',
          profile: uiState.activeProfile,
        }));
      }
    };

    if (shownSection === 'home' && !connectedId) {
      openTarget();
      return;
    }
    const homeRender = render();
    openTarget();
    return homeRender;
  }
  pendingApprovalsFocus = Boolean(focusApprovals && !approvalId);
  pendingApprovalFocusId = focusApprovals ? approvalId : '';
  if (focusApprovals) {
    uiState.homeJump = null;
    uiState.homeCat = '';
  }
  if (pendingApprovalFocusId && auth.signedIn) {
    const idToOpen = pendingApprovalFocusId;
    pendingApprovalFocusId = '';
    // After this draw has started, so it waits for the Home it opens on.
    setTimeout(() => onHomeShown(() => openApprovalFocusDialog(idToOpen)));
  }
  refreshApprovals();

  document.title = focusApprovals ? 'Approvals \u00b7 Loop' : `${PAGES[section]} \u00b7 Loop`;

  // Library, Vault and Settings put their name in the top bar in place of the Loop logo.
  const topTitleText = !focusApprovals && TITLED_PAGES.has(PAGES[section]) ? PAGES[section] : '';
  const topTitle = document.getElementById('top-title');
  const topLogo = document.querySelector('.top .logo');
  if (topTitle) {
    topTitle.textContent = topTitleText;
    topTitle.hidden = !topTitleText;
  }
  if (topLogo) topLogo.hidden = Boolean(topTitleText);

  syncNavCurrent();

  // Skill details sit under Home, so they get a way back to it (hiding the left Profile Switcher).
  if (back) {
    const parent = NAV_OF[section];
    back.hidden = !parent;
    if (parent) {
      back.href = `#${parent}`;
      const label = document.getElementById('back-label');
      if (label) label.textContent = PAGES[parent];
    }
  }

  const isPageChange = shownSection !== null && shownSection !== section;
  if (isPageChange) {
    clearToast();
    if (uiState.profileMenu) {
      uiState.profileMenu = false;
      uiState.profileQuery = '';
      closeProfileMenu = null;
    }
  }
  syncTopChrome(latestProfileRecords);

  const main = document.getElementById('main');
  if (!main) return;

  // Returns the page's load promise. The page shows when it has loaded, by which time a newer
  // render may have started. turn: the old page fades into this one (turnPage).
  const draw = ({ turn = null } = {}) => {
    if (seq !== renderSeq) return null;
    const view = stageView(main);
    const loading = drawInto(view);
    let settled;
    pageShown = Promise.all([new Promise((resolve) => { settled = resolve; }), Promise.resolve(loading).catch(() => {})]);
    let revealed = false;
    const swap = () => {
      settled();
      if (seq !== renderSeq) {
        view.remove();
        return;
      }
      if (section !== 'memory') destroyMemoryView();
      if (section !== 'loop') destroyLoopChatView();
      if (section !== 'setup') destroySetupView();
      if (section !== 'settings') closeSettings();
      if (turn) main.scrollTop = 0;
      showView(main, view);
    };
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      if (seq !== renderSeq || !turn) swap();
      else turn(swap);
    };
    const timer = setTimeout(reveal, VIEW_SWAP_WAIT_MS);
    Promise.resolve(loading).catch(() => {}).finally(() => {
      clearTimeout(timer);
      reveal();
    });
    return loading;
  };
  const drawInto = (view) => {
    if (section === 'loop') {
      return renderLoopChat(view, {
        ...makeUi(seq),
        streamFetch,
        params,
        uiState,
        activeProfile: () => uiState.activeProfile,
        onCapabilitiesChange: (next) => applySpecialistCapabilities(next),
      });
    }
    if (section === 'home') return renderHome(view, seq);
    if (section === 'saved') {
      return renderSaved(view, {
        ...makeUi(seq),
        params,
        part,
        pageTop,
        onRetry: () => render(),
        activeProfile: () => uiState.activeProfile,
        syncTopChrome: (recs) => syncTopChrome(recs, { loaded: true }),
        passwordName,
        noGuardPassword,
      });
    }
    if (section === 'vault') return renderVault(view, seq, params);
    if (section === 'setup') return renderSetup(view, makeUi(seq));
    if (section === 'service') return renderServicePage(view, makeUi(seq), decodeURIComponent(subSeg || ''));
    if (section === 'chat') return renderChat(view, makeUi(seq));
    if (section === 'skills') return renderSkills(view, seq, params);
    if (section === 'settings') return renderSettings(view, seq, params);
    if (section === 'memory') {
      return renderMemory(view, {
        ...makeUi(seq),
        params,
        uiState,
        specialistEnabled: specialistCaps.enabled,
        canImportFromMac,
        onRetry: () => render(),
        pageTop,
        activeProfile: () => uiState.activeProfile,
        profileName: (id, recs) => profileNameOf(id, recs),
        syncTopChrome: (recs) => syncTopChrome(recs, { loaded: true }),
        profileSwitcher: {
          records: extractProfileRecords,
          normalize: normalizeActiveProfile,
          active: (records) => normalizeActiveProfile(records),
          name: profileNameOf,
        },
      });
    }
    return null;
  };

  // Moving to another page animates; redrawing the page on screen (live agent updates) does not.
  shownSection = section;
  if (section !== 'home' && approvalsOnHome) {
    approvalsOnHome = null;
    renderApprovalBanner();
  }
  draw({ turn: isPageChange ? turnPage : null });
}

// Moves to another page: the old page stays on screen while the new one loads, then fades into it
// ("Page turns" in app.css). What the two pages share (Loop, the side menu's place, the profile,
// the nav) is the same picture in both, so it stays still. Browsers without view transitions swap
// the pages in one step.
function turnPage(swap) {
  if (typeof document.startViewTransition !== 'function' || document.hidden || reducedMotion?.matches) return swap();
  const turn = document.startViewTransition(swap);
  currentPageTurn = turn;
  turn.ready.catch(() => {}); // skipped (a newer page turn, a hidden tab): the pages have swapped all the same
  turn.finished.catch(() => {}).finally(() => { if (currentPageTurn === turn) currentPageTurn = null; });
}

window.addEventListener('hashchange', render);
document.querySelector('.nav [data-nav="vault"]')?.addEventListener('click', () => {
  if (location.hash === '#vault' && document.querySelector('[data-capture-view]')) render();
});
window.addEventListener('pagehide', (e) => {
  if (e.persisted && auth.mode === 'clerk' && auth.signedIn) lockDashboard(false);
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted && auth.mode === 'clerk') location.reload();
});
// Projects are not in the dashboard any more. The server keeps them, but the dashboard always shows All.
uiState.activeProfile = 'all';

initCommandPalette({
  isEnabled: () => Boolean(auth.signedIn && !oauthTxId && !deviceCodeParam),
  navigate: (href) => { location.hash = href; },
  onAction: (action, payload) => {
    if (action === 'add-connection') {
      if (shownSection !== 'home') {
        location.hash = '#connections?panel=add';
      } else {
        openAddConnectionPopup(connectionPopupCtx(), { profile: uiState.activeProfile });
      }
    } else if (action === 'add-agent') {
      if (shownSection !== 'home') location.hash = '#home';
      setTimeout(() => onHomeShown(() => {
        openAddAgent(agentPopupCtx(), { project: uiState.activeProfile });
      }));
    } else if (action === 'new-project') {
      openNewProfileDialog({
        onCreated: (created) => {
          if (created?.id) {
        latestProfileRecords = [...latestProfileRecords.filter((p) => p && p.id !== created.id), created];
        setActiveProfile(created.id);
      }
          render();
        },
      });
    } else if (action === 'switch-project' && payload?.id) {
      setActiveProfile(payload.id);
      syncTopChrome(latestProfileRecords, { force: true });
      render();
    } else if (action === 'open-conn' && payload?.id) {
      if (shownSection !== 'home') {
        location.hash = `#connections?conn=${encodeURIComponent(payload.id)}`;
      } else {
        openConnectionPopup(connectionPopupCtx(), payload.id);
      }
    } else if (action === 'open-agent' && payload?.id) {
      openAgentPopup(agentPopupCtx(), payload.id);
    }
  },
  getSources: async () => {
    const [ov, memRes, vaultRes, skillsRes, savedRes] = await Promise.all([
      api('/api/overview').catch(() => null),
      api('/api/memory').catch(() => null),
      api('/api/vault').catch(() => null),
      api('/api/skills').catch(() => null),
      api('/api/saved?limit=40').catch(() => null),
    ]);
    const out = [];
    for (const s of Array.isArray(savedRes?.items) ? savedRes.items : []) {
      out.push({
        group: BRAIN_NAME,
        rank: 18,
        title: s.displayTitle || s.title || s.url || 'Saved item',
        subtitle: s.note || s.summary || s.domain || s.kind,
        badge: s.ui ? 'Card' : (s.domain || s.kind),
        href: `#knowledge/saved?focus=${encodeURIComponent(s.id)}`,
        keywords: `saved bookmark link clip ${s.url || ''} ${(s.tags || []).join(' ')}`,
      });
    }
    for (const c of Array.isArray(ov?.mcps) ? ov.mcps : []) {
      out.push({
        group: 'Connections',
        rank: 20,
        title: c.name || c.id,
        subtitle: c.description || c.url || c.command || 'Connection',
        badge: c.enabled === false ? 'Off' : (c.authRequired ? 'Sign in' : `${c.toolCount ?? (c.tools?.length || 0)} tools`),
        action: 'open-conn',
        payload: { id: c.id },
        keywords: `connection mcp ${c.id}`,
      });
    }
    const mergedAgents = agentRows(
      Array.isArray(ov?.agentKeys) ? ov.agentKeys : [],
      Array.isArray(ov?.agents) ? ov.agents : [],
    );
    for (const a of mergedAgents) {
      out.push({
        group: 'Agents',
        rank: 30,
        title: a.name || a.id,
        subtitle: a.kind || 'Agent',
        badge: a.agent?.enabled === false ? 'Off' : (a.active > 0 ? 'Active' : 'Agent'),
        action: 'open-agent',
        payload: { id: a.id },
        keywords: `agent bot ${a.kind || ''} ${a.id}`,
      });
    }
    for (const s of Array.isArray(vaultRes?.secrets) ? vaultRes.secrets : []) {
      out.push({
        group: 'Vault',
        rank: 40,
        title: s.key,
        subtitle: s.description || s.type || 'Vault secret',
        badge: s.type || 'Vault',
        href: `#vault?key=${encodeURIComponent(s.key)}`,
        keywords: `vault secret key ${s.type || ''} ${s.category || ''}`,
      });
    }
    for (const sk of Array.isArray(skillsRes?.skills) ? skillsRes.skills : []) {
      out.push({
        group: 'Skills',
        rank: 50,
        title: sk.name || sk.id,
        subtitle: sk.description || 'Skill',
        href: `#skills?q=${encodeURIComponent(sk.name || sk.id)}`,
        keywords: `skill guide ${sk.id}`,
      });
    }
    for (const m of (Array.isArray(memRes?.memories) ? memRes.memories : []).slice(0, 60)) {
      const txt = String(m.content || '').replace(/\s+/g, ' ').trim();
      out.push({
        group: BRAIN_NAME,
        rank: 60,
        title: txt.length > 72 ? `${txt.slice(0, 71)}…` : (txt || m.key),
        subtitle: `${m.writtenBy || 'Owner'}${m.pinned ? ' · Pinned' : ''}`,
        href: `#knowledge?focus=${encodeURIComponent(m.id)}`,
        keywords: `memory note ${m.key || ''} ${(m.tags || []).join(' ')}`,
      });
    }
    return out;
  },
});
captureOAuthFromHash();
render();

// Keep change notifications and live approvals scoped to signed-in owners.
function syncDashboardEvents() {
  if (!auth.signedIn) {
    dashboardEvents?.close();
    dashboardEvents = null;
    clearTimeout(dashboardEventsReconnectTimer);
    dashboardEventsReconnectTimer = null;
    dashboardEventsBackoffIdx = 0;
    agentsRefreshWaiting = false;
    connectionsRefreshWaiting = false;
    memoryRefreshWaiting = false;
    return;
  }
  if (dashboardEvents || dashboardEventsReconnectTimer || typeof EventSource === 'undefined') return;
  const es = new EventSource('/events');
  dashboardEvents = es;
  const isCurrent = () => auth.signedIn && dashboardEvents === es;
  es.addEventListener('hello', (e) => {
    if (!isCurrent()) return;
    dashboardEventsBackoffIdx = 0;
    if (dashboardEventsBootId && e.data && e.data !== dashboardEventsBootId) {
      location.reload();
      return;
    }
    dashboardEventsBootId = e.data;
    refreshApprovals();
  });
  es.addEventListener('reload', (e) => {
    if (!isCurrent()) return;
    const isDataChange = typeof e.data === 'string' && e.data.trim().startsWith('{');
    if (isDataChange) {
      prefetched.clear();
      if (document.querySelector('dialog[open], .st-root') || uiState.profileMenu) {
        connectionsRefreshWaiting = true;
      } else {
        render();
      }
      return;
    }
    location.reload();
  });
  es.addEventListener('approvals', () => {
    if (isCurrent()) refreshApprovals();
  });
  es.addEventListener('policies', () => {
    if (isCurrent()) prefetched.clear();
  });
  es.addEventListener('profiles', () => {
    if (isCurrent()) prefetched.clear();
  });
  es.addEventListener('agents', () => {
    if (!isCurrent()) return;
    prefetched.clear();
    agentsRefreshWaiting = true;
    applyAgentsRefresh();
    void refreshOpenAgentActivity();
  });
  es.addEventListener('activity', () => {
    if (!isCurrent()) return;
    void refreshOpenAgentActivity();
  });
  es.addEventListener('connections', () => {
    if (!isCurrent()) return;
    void refreshOpenConnectionStatus();
    uiState.skillCache.clear();
    prefetched.clear();
    connectionsRefreshWaiting = true;
    applyConnectionsRefresh();
  });
  es.addEventListener('added', (e) => {
    if (!isCurrent()) return;
    let added;
    try { added = JSON.parse(e.data); } catch { return; }
    if (!added?.id || !added.name) return;
    uiState.skillCache.clear();
    prefetched.clear();
    if (shownSection === 'home' && uiState.homeAdd === 'list') uiState.homeAdded = added;
    else toast(`${added.agent} added ${added.name}.`, 'ok');
    connectionsRefreshWaiting = true;
    applyConnectionsRefresh();
  });
  es.addEventListener('memory', () => {
    if (!isCurrent()) return;
    prefetched.clear();
    memoryRefreshWaiting = true;
    applyMemoryRefresh();
    if (shownSection === 'loop') refreshLoopChatMap();
  });
  es.addEventListener('feedback', () => {
    if (isCurrent()) settingsPop?.feedback?.refresh().catch(() => {});
  });
  es.addEventListener('people', () => {
    if (!isCurrent()) return;
    prefetched.clear();
    settingsPop?.people?.refresh().catch(() => {});
    if (shownSection === 'home') {
      connectionsRefreshWaiting = true;
      applyConnectionsRefresh();
    }
  });
  for (const evName of ['saved', 'schedules', 'files', 'tasks']) {
    es.addEventListener(evName, () => {
      if (!isCurrent()) return;
      prefetched.clear();
      if (shownSection === 'saved' && !document.querySelector('dialog[open], .st-root')) {
        void refreshSavedLive();
      } else if (shownSection === 'memory') {
        memoryRefreshWaiting = true; // the side menu counts these too
        applyMemoryRefresh();
      } else if (shownSection === 'loop') {
        refreshLoopChatMap();
      }
    });
  }
  es.addEventListener('notifications', async () => {
    if (!isCurrent() || !auth.signedIn) return;
    try {
      const res = await api('/api/notifications?unread=1&limit=1');
      const latest = res?.notifications?.[0];
      if (latest) {
        toast(`${latest.title ? `${latest.title}: ` : ''}${latest.message}`, latest.level === 'urgent' ? 'err' : 'ok');
      }
    } catch { /* ignore */ }
  });
  es.onerror = () => {
    if (!isCurrent()) return;
    if (auth.mode !== 'clerk') return;
    es.close();
    dashboardEvents = null;
    const sessionId = activeClerkSession;
    const scheduleReconnect = () => {
      if (!auth.signedIn || auth.mode !== 'clerk' || !sessionId || sessionId !== activeClerkSession) return;
      const delay = SSE_RECONNECT_BACKOFF_MS[Math.min(dashboardEventsBackoffIdx, SSE_RECONNECT_BACKOFF_MS.length - 1)];
      dashboardEventsBackoffIdx = Math.min(dashboardEventsBackoffIdx + 1, SSE_RECONNECT_BACKOFF_MS.length - 1);
      clearTimeout(dashboardEventsReconnectTimer);
      dashboardEventsReconnectTimer = setTimeout(async () => {
        dashboardEventsReconnectTimer = null;
        if (!auth.signedIn || auth.mode !== 'clerk' || sessionId !== activeClerkSession) return;
        try {
          await clerkSessionToken(sessionId);
        } catch {
          scheduleReconnect();
          return;
        }
        if (!auth.signedIn || sessionId !== activeClerkSession) return;
        syncDashboardEvents();
      }, delay);
    };
    scheduleReconnect();
  };
}

// A Connections update that arrives while a form, popup, or dialog is in use is held, not dropped.
function connectionsRefreshBlocked() {
  if (oauthFinishing) return true;
  if (uiState.profileMenu) return true;
  const activeTag = document.activeElement?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return true;
  return Boolean(document.querySelector('dialog[open], .st-root'));
}

function applyConnectionsRefresh() {
  if (!connectionsRefreshWaiting || !auth.signedIn) return;
  const { section } = parseRoute();
  if (section !== 'connections' && section !== 'home') {
    connectionsRefreshWaiting = false; // other pages load fresh data when they open
    return;
  }
  if (connectionsRefreshBlocked()) return;
  render();
}

// Checked a moment after focus moves or a click lands, so the click's own handler runs first.
function scheduleConnectionsRefresh() {
  if (!connectionsRefreshWaiting || connectionsRefreshTimer) return;
  connectionsRefreshTimer = setTimeout(() => {
    connectionsRefreshTimer = null;
    applyConnectionsRefresh();
  }, 250);
}

// An Agents update that arrives while an agent edit form, popup, or modal dialog is active is
// held until the owner finishes editing or closes the popup/dialog.
function agentsRefreshBlocked() {
  if (uiState.profileMenu) return true;
  const activeTag = document.activeElement?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return true;
  if (document.querySelector('dialog[open], .st-root')) return true;
  const { section } = parseRoute();
  return section === 'agents' && Boolean(document.querySelector('.agent-row.open'));
}

function applyAgentsRefresh() {
  if (!agentsRefreshWaiting || !auth.signedIn) return;
  const { section } = parseRoute();
  if (section !== 'agents' && section !== 'home') {
    agentsRefreshWaiting = false;
    return;
  }
  if (agentsRefreshBlocked()) return;
  render();
}

function scheduleAgentsRefresh() {
  if (!agentsRefreshWaiting || agentsRefreshTimer) return;
  agentsRefreshTimer = setTimeout(() => {
    agentsRefreshTimer = null;
    applyAgentsRefresh();
  }, 250);
}

function memoryRefreshBlocked() {
  if (uiState.profileMenu) return true;
  const activeTag = document.activeElement?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return true;
  if (document.querySelector('dialog[open], .st-root')) return true;
  if (uiState.memoryPanel) return true;
  return Boolean(document.querySelector('[data-mem-edit-form], #mem-link-form'));
}

function applyMemoryRefresh() {
  if (!memoryRefreshWaiting || !auth.signedIn) return;
  const { section } = parseRoute();
  if (section !== 'memory' && section !== 'home') {
    memoryRefreshWaiting = false;
    return;
  }
  if (memoryRefreshBlocked()) return;
  render();
}

function scheduleMemoryRefresh() {
  if (!memoryRefreshWaiting || memoryRefreshTimer) return;
  memoryRefreshTimer = setTimeout(() => {
    memoryRefreshTimer = null;
    applyMemoryRefresh();
  }, 250);
}

function scheduleDeferredRefreshes() {
  scheduleConnectionsRefresh();
  scheduleAgentsRefresh();
  scheduleMemoryRefresh();
}

document.addEventListener('focusout', scheduleDeferredRefreshes);
document.addEventListener('click', scheduleDeferredRefreshes);
document.addEventListener('close', scheduleDeferredRefreshes, true); // a dialog's close does not bubble
