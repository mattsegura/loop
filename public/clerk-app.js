import { clerkColors } from './core/tone.js';
// Dashboard loads the Clerk credential SDK only. The prebuilt UI runs on the sign-in route.
const rawOAuthTx = new URLSearchParams(location.search).get('loop-oauth') || '';
export const oauthTxId = /^[A-Za-z0-9_-]{16,128}$/.test(rawOAuthTx) ? rawOAuthTx : '';
const rawDeviceParam = (new URLSearchParams(location.search).get('loop-device') || '').trim();
export const deviceCodeParam = /^(?:1|[A-Za-z0-9-]{4,16})$/.test(rawDeviceParam) ? rawDeviceParam : '';
export const POST_AUTH_URL = oauthTxId
  ? `/?loop-oauth=${encodeURIComponent(oauthTxId)}`
  : deviceCodeParam
    ? `/?loop-device=${encodeURIComponent(deviceCodeParam)}`
    : '/';
export const SIGN_IN_PATH = '/?loop-auth=sign-in';
const SIGN_UP_PATH = '/?loop-auth=sign-up';
export const signUpPage = new URLSearchParams(location.search).get('loop-auth') === 'sign-up';
export const clerkAuthPage = signUpPage || new URLSearchParams(location.search).get('loop-auth') === 'sign-in';

const TIMEOUT_MS = 12000;

export function withAuthTimeout(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Sign-in timed out')), TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

function loadScript(src, publishableKey) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => {
      script.remove();
      reject(new Error('Sign-in script timed out'));
    }, TIMEOUT_MS);
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    if (publishableKey) script.dataset.clerkPublishableKey = publishableKey;
    const done = (err) => {
      clearTimeout(timer);
      if (err) {
        script.remove();
        reject(err);
      } else resolve();
    };
    script.onload = () => done();
    script.onerror = () => done(new Error('Could not load sign-in script'));
    document.head.appendChild(script);
  });
}

export async function getAuthStatus(token) {
  const response = await fetch('/api/auth/status', {
    cache: 'no-store', credentials: 'same-origin', redirect: 'error',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('Could not check sign-in status');
  const status = await response.json();
  if (typeof status?.signedIn !== 'boolean') throw new Error('Invalid sign-in status');
  return status;
}

export async function loadClerkApp({ publishableKey, frontendApi }, showUi) {
  if (typeof publishableKey !== 'string' || !/^pk_(?:test|live)_[A-Za-z0-9+/_-]+={0,2}$/.test(publishableKey)) {
    throw new Error('Invalid sign-in configuration');
  }
  const url = new URL(frontendApi);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Invalid sign-in origin');
  }
  const keyHost = atob(publishableKey.replace(/^pk_(test|live)_/, '').replace(/-/g, '+').replace(/_/g, '/'));
  if (keyHost !== `${url.host}$`) throw new Error('Inconsistent sign-in configuration');

  const uiPath = `${url.origin}/npm/@clerk/ui@1/dist/ui.browser.js`;
  if (showUi) await loadScript(uiPath);
  await loadScript(`${url.origin}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, publishableKey);
  const clerk = window.Clerk;
  const ClerkUI = window.__internal_ClerkUICtor;
  if (!clerk || (showUi && !ClerkUI)) throw new Error('Could not initialize sign-in');
  await withAuthTimeout(clerk.load({
    ...(showUi ? { ui: { ClerkUI } } : {}),
    signInUrl: SIGN_IN_PATH, signUpUrl: SIGN_UP_PATH,
    signInForceRedirectUrl: POST_AUTH_URL, signUpForceRedirectUrl: POST_AUTH_URL,
    afterSignOutUrl: SIGN_IN_PATH,
    telemetry: false,
  }));
  if (!clerk.loaded || clerk.status === 'degraded') throw new Error('Sign-in is unavailable');
  return clerk;
}

export function mountClerkAuth(clerk, node) {
  const options = {
    routing: 'hash', forceRedirectUrl: POST_AUTH_URL,
    appearance: {
      variables: {
        ...clerkColors('#FFFFFF'),
        fontFamily: 'inherit', borderRadius: '12px',
      },
      elements: { headerTitle: 'loop-clerk-title' },
    },
  };
  if (signUpPage) clerk.mountSignUp(node, { ...options, signInUrl: SIGN_IN_PATH, signInForceRedirectUrl: POST_AUTH_URL });
  else clerk.mountSignIn(node, { ...options, signUpUrl: SIGN_UP_PATH, signUpForceRedirectUrl: POST_AUTH_URL });
}
