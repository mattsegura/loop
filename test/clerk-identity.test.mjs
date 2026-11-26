import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ClerkAppConfigError, loadClerkApp } from '../lib/clerk-app.mjs';

const hostname = 'renewing-bobcat-00.clerk.accounts.dev';
const issuer = `https://${hostname}`;
const pk = (value, prefix = 'test') => `pk_${prefix}_${Buffer.from(value).toString('base64').replace(/=+$/, '')}`;
const port = 8799;
const host = `127.0.0.1:${port}`;
const origin = `http://${host}`;
const keyPair = await generateKeyPair('RS256');
const jwks = { keys: [{ ...await exportJWK(keyPair.publicKey), kid: 'loop-test', alg: 'RS256' }] };
const now = Math.floor(Date.now() / 1000);
const claims = { iss: issuer, sub: 'user_A', sid: 'sess_A', azp: origin, v: 2, jti: 'a1', iat: now, nbf: now - 10, exp: now + 60 };
const header = { alg: 'RS256', typ: 'JWT', kid: 'loop-test' };
const jwt = (changes = {}, headerChanges = {}, key = keyPair.privateKey) =>
  new SignJWT({ ...claims, ...changes }).setProtectedHeader({ ...header, ...headerChanges }).sign(key);
const req = (headers) => ({ headers: { host, ...headers } });
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const cookie = (token) => ({ cookie: `preference=dark; __session=${token}` });
const verify = (app, headers) => app.verifyRequest(req(headers), port);
const identity = { userId: claims.sub, sessionId: claims.sid, issuer, expiresAt: claims.exp * 1000 };

function env(t, name, value) {
  const prior = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  });
}
function config(t) {
  env(t, 'CLERK_PUBLISHABLE_KEY', pk(`${hostname}$`));
  env(t, 'LOOP_HUB_ALLOWED_HOSTS', 'loop.example.test,other.example.test');
  return loadClerkApp({ jwks });
}

test('verifies separate Clerk users on each request using Bearer or same-origin cookie', async t => {
  const app = config(t);
  assert.equal(app.frontendApi, issuer);
  assert.equal(app.publishableKey, pk(`${hostname}$`));
  const a = await jwt();
  // Uncustomized session observed from the real development instance: active with no jti.
  const b = await jwt({ sub: 'user_B', sid: 'sess_B', sts: 'active', jti: undefined });
  assert.deepEqual(await verify(app, bearer(a)), identity);
  assert.deepEqual(await verify(app, { accept: 'text/event-stream', ...cookie(a) }), identity);
  assert.deepEqual(await verify(app, { origin, 'sec-fetch-site': 'same-origin', ...cookie(a) }), identity);
  assert.deepEqual(await verify(app, { ...bearer(b), ...cookie(a) }), { ...identity, userId: 'user_B', sessionId: 'sess_B' });
  assert.equal(await verify(app, { authorization: 'Basic broken', ...cookie(a) }), null);
  assert.equal(await verify(app, { ...bearer('broken'), ...cookie(a) }), null);
  assert.equal(await verify(app, { cookie: `__session=${a}; __session=${b}` }), null);
  assert.equal(await verify(app, {}), null);
});

test('allows only the exact canonical and validated current origins; cookies stay same-origin', async t => {
  const app = config(t);
  const a = await jwt();
  const localhost = `localhost:${port}`;
  const localhostOrigin = `http://${localhost}`;
  const local = await jwt({ azp: localhostOrigin });
  const extra = await jwt({ azp: 'https://loop.example.test' });
  assert.deepEqual(await verify(app, { host: localhost, ...bearer(a) }), identity);
  assert.deepEqual(await verify(app, { host: localhost, ...cookie(local) }), identity);
  assert.deepEqual(await verify(app, { host: 'loop.example.test', origin: 'https://loop.example.test', ...cookie(extra) }), identity);
  assert.equal(await verify(app, { host: localhost, ...cookie(a) }), null);
  assert.equal(await verify(app, { host: 'other.example.test', ...bearer(extra) }), null);
  assert.equal(await verify(app, { host: 'loop.example.test.attacker.test', ...bearer(a) }), null);
  assert.equal(await verify(app, { ...cookie(a), 'sec-fetch-site': 'cross-site' }), null);
  assert.equal(await verify(app, { ...cookie(a), 'sec-fetch-site': 'same-site' }), null);
  assert.equal(await verify(app, { ...cookie(a), origin: localhostOrigin }), null);
  assert.equal(await verify(app, { ...bearer(await jwt({ azp: `${origin}/` })) }), null);
  assert.equal(await app.verifyRequest({ ...req(bearer(a)), headersDistinct: { authorization: [`Bearer ${a}`, 'Basic other'] } }, port), null);
});

test('rejects signed tokens without the exact v2 session shape and checks signature and time', async t => {
  const app = config(t);
  const other = await generateKeyPair('RS256');
  const invalidClaims = {
    issuer: { iss: `${issuer}/` },
    otherIssuer: { iss: 'https://other.clerk.accounts.dev' },
    origin: { azp: undefined },
    session: { sid: undefined },
    wrongSession: { sid: 'user_123' },
    user: { sub: 'not_a_user' },
    version: { v: 1 },
    noVersion: { v: undefined },
    template: { v: undefined, sid: undefined, aud: 'other-app' },
    pending: { sts: 'pending' },
    ended: { sts: 'ended' },
    actor: { act: { sub: 'user_Other' } },
    delegated: { may_act: { sub: 'user_Other' } },
    nullActor: { act: null },
    expired: { exp: now },
    missingExpiry: { exp: undefined },
    issuedInFuture: { iat: now + 30 },
    notValidYet: { nbf: now + 30 },
    missingNbf: { nbf: undefined },
    swappedDates: { exp: now + 1, iat: now + 2 },
    invalidDates: { exp: now + 45.5 },
  };
  for (const [name, changes] of Object.entries(invalidClaims)) {
    assert.equal(await verify(app, bearer(await jwt(changes))), null, name);
  }
  assert.equal(await verify(app, bearer(await jwt({}, { typ: 'at+jwt' }))), null);
  assert.equal(await verify(app, bearer(await jwt({}, { kid: undefined }))), null);
  assert.equal(await verify(app, bearer(await jwt({}, {}, other.privateKey))), null);
  const hsToken = await new SignJWT(claims).setProtectedHeader({ ...header, alg: 'HS256' }).sign(new Uint8Array(32));
  assert.equal(await verify(app, bearer(hsToken)), null);
});

test('runtime fetches only the pinned HTTPS JWKS, will not follow redirects, and caches keys', async t => {
  config(t);
  const observed = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    observed.push({ url: String(url), redirect: opts.redirect, timeout: opts.signal instanceof AbortSignal });
    return Response.json(jwks);
  });
  const app = loadClerkApp();
  const token = await jwt({}, { jku: 'https://untrusted.example/jwks.json' });
  assert.deepEqual(await verify(app, bearer(token)), identity);
  assert.deepEqual(await verify(app, bearer(token)), identity);
  assert.deepEqual(observed, [{ url: `${issuer}/.well-known/jwks.json`, redirect: 'manual', timeout: true }]);

  globalThis.fetch.mock.mockImplementation(async () => Response.redirect('https://untrusted.example/jwks.json'));
  assert.equal(await verify(loadClerkApp(), bearer(token)), null);
});

test('dotenv is module-relative and read-only; missing or malformed config fails closed, legacy is explicit', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'loop-clerk-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  // Isolate the filesystem config: don't require or modify the user's real .env.local.
  await mkdir(join(folder, 'lib'));
  for (const file of ['clerk-app.mjs', 'security.mjs']) {
    await copyFile(new URL(`../lib/${file}`, import.meta.url), join(folder, 'lib', file));
  }
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(folder, 'node_modules'), 'dir');
  env(t, 'CLERK_PUBLISHABLE_KEY', undefined);
  env(t, 'CLERK_SECRET_KEY', undefined);
  const isolated = await import(pathToFileURL(join(folder, 'lib', 'clerk-app.mjs')));
  assert.equal(isolated.loadClerkApp({ legacyMode: true }), null);
  assert.throws(() => isolated.loadClerkApp(), { name: 'ClerkAppConfigError', code: 'CLERK_APP_NOT_CONFIGURED' });
  assert.throws(() => isolated.loadClerkApp({ legacyMode: 'true' }), { code: 'CLERK_APP_NOT_CONFIGURED' });
  await writeFile(join(folder, '.env.local'), `CLERK_PUBLISHABLE_KEY="${pk(`${hostname}$`)}" # test\nCLERK_SECRET_KEY=not-used\n`);
  assert.equal(isolated.loadClerkApp().frontendApi, issuer);
  assert.equal(process.env.CLERK_PUBLISHABLE_KEY, undefined);
  assert.equal(process.env.CLERK_SECRET_KEY, undefined);
  process.env.CLERK_PUBLISHABLE_KEY = pk('clerk.example.test$', 'live');
  assert.equal(isolated.loadClerkApp().frontendApi, 'https://clerk.example.test');
  for (const malformed of ['', 'not-a-publishable-key', pk(hostname), pk(`${hostname}$$`), pk(`${hostname}/path$`), pk('127.0.0.1$'), pk('0x7f.1$'), pk(`${hostname}:443$`), pk(`${hostname}@other.example$`)]) {
    process.env.CLERK_PUBLISHABLE_KEY = malformed;
    assert.throws(() => loadClerkApp(), ClerkAppConfigError);
  }
});
