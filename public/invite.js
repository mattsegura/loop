// 3-step onboarding for /invite?t=<slug> (and /invite/<slug>).
// Step 1: Welcome → Step 2: Trust & beta overview → Step 3: Clerk sign-in & 1-tap Messages connect.
import { getAuthStatus, withAuthTimeout } from './clerk-app.js';
import { clerkColors } from './core/tone.js';

const app = document.getElementById('app');

let clerk = null;
let lookup = null;
let claimResult = null;
let pollTimer = null;
let pollStartedAt = 0;
let pollingActive = false;
let claimInFlight = false;
let authListenerUnsub = null;

function esc(value) {
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

function parseInviteParams() {
  const params = new URLSearchParams(location.search);
  let slug = (params.get('t') || '').trim();
  if (!slug) {
    const match = location.pathname.match(/^\/invite\/([A-Za-z0-9_-]+)\/?$/);
    if (match) slug = match[1];
  }
  slug = /^[A-Za-z0-9_-]{1,128}$/.test(slug) ? slug : '';
  const step = (params.get('step') || '').trim();
  return { slug, step };
}

const { slug, step: initialStep } = parseInviteParams();

function connectRedirectUrl() {
  const url = new URL('/invite', location.origin);
  if (slug) url.searchParams.set('t', slug);
  url.searchParams.set('step', 'connect');
  return url.href;
}

function formatPhoneDisplay(raw) {
  const cleaned = String(raw || '').trim();
  const us = cleaned.match(/^\+?1?(\d{3})(\d{3})(\d{4})$/);
  if (us && (cleaned.startsWith('+1') || cleaned.length === 10 || (cleaned.length === 11 && cleaned.startsWith('1')))) {
    return `+1 (${us[1]}) ${us[2]}-${us[3]}`;
  }
  return cleaned;
}

function loadScript(src, publishableKey) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => {
      script.remove();
      reject(new Error('Sign-in script timed out'));
    }, 12000);
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    if (publishableKey) script.dataset.clerkPublishableKey = publishableKey;
    const done = (err) => {
      clearTimeout(timer);
      if (err) {
        script.remove();
        reject(err);
      } else {
        resolve();
      }
    };
    script.onload = () => done();
    script.onerror = () => done(new Error('Could not load sign-in'));
    document.head.appendChild(script);
  });
}

async function loadClerk(status, withUi) {
  const { publishableKey, frontendApi } = status || {};
  if (typeof publishableKey !== 'string' || !/^pk_(?:test|live)_[A-Za-z0-9+/_-]+={0,2}$/.test(publishableKey)) {
    throw new Error('Invalid sign-in configuration');
  }
  const url = new URL(frontendApi);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Invalid sign-in origin');
  }
  const origin = url.origin;
  if (withUi && !window.__internal_ClerkUICtor) {
    await loadScript(`${origin}/npm/@clerk/ui@1/dist/ui.browser.js`);
  }
  if (!window.Clerk) {
    await loadScript(`${origin}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, publishableKey);
  }
  const c = window.Clerk;
  if (!c) throw new Error('Could not initialize sign-in');
  if (!c.loaded) {
    const redirectUrl = connectRedirectUrl();
    await withAuthTimeout(c.load({
      ...(withUi && window.__internal_ClerkUICtor ? { ui: { ClerkUI: window.__internal_ClerkUICtor } } : {}),
      signInForceRedirectUrl: redirectUrl,
      signUpForceRedirectUrl: redirectUrl,
      afterSignOutUrl: redirectUrl,
      telemetry: false,
    }));
  }
  if (!c.loaded || c.status === 'degraded') throw new Error('Sign-in is unavailable');
  return c;
}

async function apiFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (clerk?.session) {
    const token = await withAuthTimeout(clerk.session.getToken());
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(path, { ...opts, headers, credentials: 'same-origin', cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status, data });
  }
  return data;
}

async function copyToClipboard(text, button) {
  const original = button.textContent;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Select & copy';
  }
  setTimeout(() => {
    if (button.isConnected) button.textContent = original;
  }, 1800);
}

function stopPolling() {
  pollingActive = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function cleanupAuthListener() {
  if (typeof authListenerUnsub === 'function') {
    try { authListenerUnsub(); } catch {}
    authListenerUnsub = null;
  }
}

function logoHtml(small = false) {
  return `<a class="logo-link" href="/" aria-label="Loop"><img class="logo${small ? ' sm' : ''}" src="/logo.svg" alt="Loop" width="${small ? 64 : 87}" height="${small ? 28 : 38}"></a>`;
}

const ICONS = {
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
  gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5" rx="1"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  messages: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 3C6.48 3 2 6.86 2 11.62c0 2.52 1.26 4.79 3.27 6.37-.15 1.32-.71 2.48-1.45 3.32-.17.19-.02.49.23.46 1.72-.2 3.31-.86 4.46-1.69 1.09.32 2.27.5 3.49.5 5.52 0 10-3.86 10-8.62S17.52 3 12 3z"/></svg>',
};

function renderUnavailable(kind, detail = '') {
  stopPolling();
  cleanupAuthListener();
  const isExhausted = kind === 'exhausted';
  const title = isExhausted ? 'This invite link has no invites left' : 'Invite link not found';
  const inviter = String(lookup?.inviterName || '').trim();
  const sub = isExhausted
    ? (inviter ? `Ask ${inviter} for another link, or visit Loop to learn more.` : 'All invites on this link have been claimed.')
    : (detail || 'Double-check the link you received, or visit Loop to learn more.');
  app.innerHTML = `
    <div class="stage">
      ${logoHtml(false)}
      <h1 class="h">${esc(title)}</h1>
      <p class="lead">${esc(sub)}</p>
      <a class="subtle-link" href="https://useloop.sh">useloop.sh</a>
    </div>
  `;
}

function renderStep1() {
  stopPolling();
  cleanupAuthListener();
  const inviter = String(lookup?.inviterName || '').trim();
  const heading = inviter ? `Welcome, ${inviter} invited you to Loop.` : 'Welcome to Loop.';
  app.innerHTML = `
    <div class="stage">
      ${logoHtml(false)}
      <h1 class="h">${esc(heading)}</h1>
      <button type="button" class="btn pri cta-gap" id="step1-next">Get started</button>
    </div>
  `;
  document.getElementById('step1-next')?.addEventListener('click', () => renderStep2());
}

function renderStep2() {
  stopPolling();
  cleanupAuthListener();
  const quota = Number.isFinite(Number(lookup?.quota)) && Number(lookup.quota) > 0
    ? Math.floor(Number(lookup.quota))
    : 5;
  const inviteLabel = quota === 1 ? 'You have 1 invite' : `You have ${quota} invites`;

  app.innerHTML = `
    <div class="stage">
      ${logoHtml(true)}
      <ul class="points" aria-label="Before you begin">
        <li class="point">
          <span class="point-ic">${ICONS.chat}</span>
          <div class="point-body">
            <h2 class="point-title">Loop is in invite-only beta</h2>
            <p class="point-desc">Ask Loop to send feedback to the team at any time and help us improve the product.</p>
          </div>
        </li>
        <li class="point">
          <span class="point-ic">${ICONS.shield}</span>
          <div class="point-body">
            <h2 class="point-title">You’re in control of your data</h2>
            <p class="point-desc">You decide how much access and control you want to share with Loop. You can revoke access or delete your data at any time.</p>
          </div>
        </li>
        <li class="point">
          <span class="point-ic">${ICONS.gift}</span>
          <div class="point-body">
            <h2 class="point-title">${esc(inviteLabel)}</h2>
            <p class="point-desc">Share your private invite link from Settings—or text “invite” to Loop anytime—to give others access.</p>
          </div>
        </li>
      </ul>
      <button type="button" class="btn pri cta-gap" id="step2-next">Continue</button>
      <p class="err-msg" id="step2-err" hidden></p>
    </div>
  `;
  document.getElementById('step2-next')?.addEventListener('click', () => beginConnect());
}

function renderLoadingState(message) {
  app.innerHTML = `
    <div class="stage">
      ${logoHtml(true)}
      <div class="loading"><span class="spin" aria-hidden="true"></span><span>${esc(message)}</span></div>
    </div>
  `;
}

function renderClaimError(message) {
  stopPolling();
  cleanupAuthListener();
  app.innerHTML = `
    <div class="stage">
      ${logoHtml(true)}
      <h1 class="h tight">Couldn’t finish setup</h1>
      <p class="lead">${esc(message || 'Something went wrong while claiming your invite.')}</p>
      <button type="button" class="btn pri cta-gap" id="retry-claim">Try again</button>
      <a class="subtle-link" href="/">Go to Loop</a>
    </div>
  `;
  document.getElementById('retry-claim')?.addEventListener('click', () => claimInvite());
}

async function beginConnect() {
  const continueBtn = document.getElementById('step2-next');
  const errEl = document.getElementById('step2-err');
  if (continueBtn) {
    continueBtn.disabled = true;
    continueBtn.textContent = 'Continuing…';
  }
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = '';
  }

  try {
    const status = await getAuthStatus();
    if (!status.publishableKey) {
      if (status.signedIn) {
        await claimInvite();
        return;
      }
      throw new Error('Sign-in is currently unavailable.');
    }

    clerk = await loadClerk(status, true);
    if (clerk.user) {
      await claimInvite();
      return;
    }

    renderSignIn();
  } catch (err) {
    if (continueBtn && continueBtn.isConnected) {
      continueBtn.disabled = false;
      continueBtn.textContent = 'Continue';
      if (errEl) {
        errEl.textContent = err.message || 'Could not start sign-in.';
        errEl.hidden = false;
      }
    } else {
      renderClaimError(err.message || 'Could not start sign-in.');
    }
  }
}

function renderSignIn() {
  stopPolling();
  cleanupAuthListener();
  const inviter = String(lookup?.inviterName || '').trim();
  const sub = inviter
    ? `Sign in or create an account to accept ${inviter}’s invite.`
    : 'Sign in or create an account to get started with Loop.';

  app.innerHTML = `
    <div class="stage">
      ${logoHtml(true)}
      <h1 class="h tight">Sign in to Loop</h1>
      <p class="lead">${esc(sub)}</p>
      <div class="signin-wrap" id="auth-slot"></div>
    </div>
  `;

  const slot = document.getElementById('auth-slot');
  const redirectUrl = connectRedirectUrl();
  clerk.mountSignIn(slot, {
    routing: 'hash',
    withSignUp: true, // a new account is made in the same form, so it comes back here
    forceRedirectUrl: redirectUrl,
    signUpForceRedirectUrl: redirectUrl,
    appearance: {
      variables: {
        ...clerkColors('#FFFFFF'),
        borderRadius: '14px',
        fontFamily: 'inherit',
      },
    },
  });

  if (typeof clerk.addListener === 'function') {
    authListenerUnsub = clerk.addListener(({ user }) => {
      if (user && !claimInFlight) {
        cleanupAuthListener();
        try { clerk.unmountSignIn?.(slot); } catch {}
        claimInvite();
      }
    });
  }
}

async function claimInvite() {
  if (claimInFlight) return;
  claimInFlight = true;
  renderLoadingState('Setting up your invite…');

  try {
    claimResult = await apiFetch('/api/invites/claim', {
      method: 'POST',
      body: JSON.stringify({ t: slug }),
    });
  } catch (err) {
    claimInFlight = false;
    const msg = String(err?.message || '');
    if (err?.status === 410 || err?.data?.exhausted || /no invites left|exhausted/i.test(msg)) {
      renderUnavailable('exhausted');
      return;
    }
    if (err?.status === 404 || /not found/i.test(msg)) {
      renderUnavailable('not_found');
      return;
    }
    if (err?.status === 401 && clerk) {
      renderSignIn();
      return;
    }
    renderClaimError(msg);
    return;
  }

  claimInFlight = false;

  if (!claimResult?.smsEnabled) {
    renderReadyNoSms();
    return;
  }

  const smsUri = safeHref(claimResult?.linkCode?.smsUri, ['sms:', 'imessage:'], false);
  const linkCode = claimResult?.linkCode || null;
  if (smsUri || linkCode?.code || linkCode?.smsBody) {
    renderTextLoop(linkCode, smsUri);
    return;
  }

  // SMS is enabled but no link code returned (e.g., already linked). Check current SMS status.
  try {
    const smsStatus = await apiFetch('/api/sms-agent');
    if (smsStatus?.status?.linked) {
      renderConnected();
      return;
    }
  } catch {
    // Fall through to simple ready screen.
  }
  renderReadyNoSms();
}

function renderTextLoop(linkCode, smsUri) {
  stopPolling();
  const codeText = String(linkCode?.smsBody || (linkCode?.code ? `CONNECT-${linkCode.code}` : '')).trim();
  const rawPhone = String(linkCode?.phone || '').trim();
  const displayPhone = formatPhoneDisplay(rawPhone);

  app.innerHTML = `
    <div class="stage">
      ${logoHtml(true)}
      <h1 class="h tight">You’re in.</h1>
      <p class="lead">Tap below to send your one-time code in Messages—Loop will connect automatically.</p>
      ${smsUri ? `<a class="btn pri cta-gap" href="${esc(smsUri)}" id="open-messages-btn">${ICONS.messages}<span>Open Messages</span></a>` : ''}
      <div class="wait" role="status"><span class="pulse" aria-hidden="true"></span><span>Waiting for Messages to connect…</span></div>
      ${(codeText || rawPhone) ? `
        <div class="fallback">
          <p class="fallback-lbl">On desktop? Text this code to Loop in Messages:</p>
          <div class="copy-rows">
            ${codeText ? `
              <div class="copy-row">
                <span class="copy-k">Code</span>
                <code class="copy-v">${esc(codeText)}</code>
                <button type="button" class="copy-btn" data-copy-value="${esc(codeText)}">Copy</button>
              </div>
            ` : ''}
            ${rawPhone ? `
              <div class="copy-row">
                <span class="copy-k">To</span>
                <code class="copy-v">${esc(displayPhone)}</code>
                <button type="button" class="copy-btn" data-copy-value="${esc(rawPhone)}">Copy</button>
              </div>
            ` : ''}
          </div>
        </div>
      ` : ''}
    </div>
  `;

  app.querySelectorAll('[data-copy-value]').forEach((btn) => {
    btn.addEventListener('click', () => copyToClipboard(btn.dataset.copyValue || '', btn));
  });

  startSmsPoll();
}

async function checkLinkedOnce() {
  if (!pollingActive) return false;
  try {
    const data = await apiFetch('/api/sms-agent');
    if (!pollingActive) return false;
    if (data?.status?.linked === true) {
      stopPolling();
      renderConnected();
      return true;
    }
  } catch {
    // Keep polling quietly on transient network hiccups.
  }
  return false;
}

function startSmsPoll() {
  stopPolling();
  pollingActive = true;
  pollStartedAt = Date.now();

  const scheduleNext = () => {
    if (!pollingActive) return;
    if (Date.now() - pollStartedAt > 20 * 60 * 1000) {
      stopPolling();
      return;
    }
    pollTimer = setTimeout(async () => {
      const done = await checkLinkedOnce();
      if (!done && pollingActive) scheduleNext();
    }, 3000);
  };

  scheduleNext();
}

function renderConnected() {
  stopPolling();
  cleanupAuthListener();
  app.innerHTML = `
    <div class="stage">
      ${logoHtml(true)}
      <div class="check-lg" aria-hidden="true">${ICONS.check}</div>
      <h1 class="h tight">You’re connected!</h1>
      <p class="lead">Head back to Messages.</p>
      <a class="btn pri cta-gap" href="/">Open Loop</a>
    </div>
  `;
}

function renderReadyNoSms() {
  stopPolling();
  cleanupAuthListener();
  app.innerHTML = `
    <div class="stage">
      ${logoHtml(true)}
      <div class="check-lg" aria-hidden="true">${ICONS.check}</div>
      <h1 class="h tight">You’re in.</h1>
      <p class="lead">Your Loop workspace is ready to go.</p>
      <a class="btn pri cta-gap" href="/">Open Loop</a>
    </div>
  `;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && pollingActive) {
    checkLinkedOnce();
  }
});

window.addEventListener('beforeunload', () => {
  stopPolling();
  cleanupAuthListener();
});

async function boot() {
  if (!slug) {
    renderUnavailable('not_found');
    return;
  }

  try {
    const res = await fetch(`/api/invites/lookup?t=${encodeURIComponent(slug)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    lookup = await res.json().catch(() => ({ valid: false }));
  } catch {
    renderUnavailable('not_found', 'Could not verify this invite right now. Please refresh to try again.');
    return;
  }

  if (!lookup || !lookup.valid) {
    renderUnavailable(lookup?.exhausted ? 'exhausted' : 'not_found', lookup?.error || '');
    return;
  }

  const returningFromAuth = initialStep === 'connect' || location.hash.startsWith('#/');
  const remaining = typeof lookup.remaining === 'number' ? lookup.remaining : null;
  const isExhausted = Boolean(lookup.exhausted) || (remaining !== null && remaining <= 0);

  if (returningFromAuth) {
    beginConnect();
    return;
  }

  if (isExhausted) {
    renderUnavailable('exhausted');
    return;
  }

  renderStep1();
}

boot();
