import { createHmac, randomBytes } from 'node:crypto';
import { isToolEnabled } from './store.mjs';

// One observation per live MCP session, never persisted. No provider output or credentials
// in cache keys. A newer attempt supersedes an older one, including failed attempts.
const observations = new WeakMap();
const key = randomBytes(32);
export const VERIFICATION_WINDOW_MS = 5 * 60_000;
export const VERIFIED_ROUTE = 'loop/verifiedRoute';

// These adapters are gateway code, not caller-supplied descriptors or upstream annotations.
function objectPayload(value) {
  if (typeof value === 'string' && value.length <= 65536) {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
const adapters = [
  { name: 'get_me', endpoint: /^https:\/\/api\.githubcopilot\.com\/mcp\/?$/, args: {},
    parse(data) {
      const { id, login } = data;
      if (!Number.isSafeInteger(id) || id < 1 || typeof login !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(login)) return null;
      return { account: { provider: 'github', id: String(id), login }, displaySummary: 'Verified GitHub profile: ' + login + '.' };
    } },
  // Composio direct managed MCP endpoint (not Connect's general execution wrapper).
  // GMAIL_GET_PROFILE is Gmail users.getProfile: message/thread counts are mailbox-wide, never unread counts.
  { name: 'GMAIL_GET_PROFILE', endpoint: /^https:\/\/backend\.composio\.dev\/v3\/mcp\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:\?user_id=[A-Za-z0-9_-]{1,128})?$/, args: { user_id: 'me' },
    parse(reply) {
      if (reply.successful !== true || reply.error) return null;
      const { emailAddress: email, messagesTotal, threadsTotal } = objectPayload(reply.data) || {};
      if (typeof email !== 'string' || email.length > 254 || !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(email) ||
          ![messagesTotal, threadsTotal].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
      return { account: { provider: 'gmail', id: email, login: email }, displaySummary: 'Gmail mailbox ' + email + ': ' + messagesTotal + ' total messages, ' + threadsTotal + ' total threads.' };
    } },
];

function adapterFor(conn, tool) {
  return adapters.find(a => (!tool || a.name === tool) && a.endpoint.test(conn?.url));
}
export function verificationArgs(conn, tool) { return { ...adapterFor(conn, tool)?.args }; }
export function verificationTool(conn) { return adapterFor(conn)?.name; }
export function supportsVerification(conn, tool, args) {
  const adapter = adapterFor(conn, tool);
  return !!adapter && tool === adapter.name && conn.transport === 'http' && !conn.command && conn.enabled &&
    !conn.authRequired && !conn.lastError && !conn.signInBroken &&
    Object.keys(conn.headers || {}).every(k => ['authorization','x-api-key'].includes(k.toLowerCase())) &&
    conn.tools?.some(t => t.name === tool && !t.annotations?.destructiveHint && t.annotations?.readOnlyHint !== false) &&
    isToolEnabled(conn, tool) && (args === undefined || JSON.stringify(args) === JSON.stringify(adapter.args));
}

function stamp(conn, access, mask) {
  return createHmac('sha256', key).update(JSON.stringify([conn, mask,
    access.agent ? ['agent', access.agent.id, access.agent.tokenHash] : ['owner'], access.profile, access.hostedExecutor === true,
    access.allowedConnections ? [...access.allowedConnections].sort() : null, access.secrets,
  ])).digest('hex');
}

export function startObservation(session, conn, access, mask, tool) {
  const attempt = { tool, stamp: stamp(conn, access, mask) };
  observations.set(session, attempt);
  return attempt;
}

export function finishObservation(session, attempt, conn, access, mask, result, now = Date.now()) {
  if (!attempt || observations.get(session) !== attempt || !supportsVerification(conn, attempt.tool) ||
      attempt.stamp !== stamp(conn, access, mask) || result?.isError) return null;
  const output = objectPayload(result?.structuredContent ?? (result?.content?.length === 1 && result.content[0]?.type === 'text' ? result.content[0].text : null));
  if (!output || output.error) return null;
  const fields = adapterFor(conn, attempt.tool).parse(output);
  if (!fields) return null;
  const credentials = [...mask, ...Object.values(conn.headers || {}).flatMap(value =>
    typeof value === 'string' ? [value, value.replace(/^(?:Bearer|Basic)\s+/i, '')] : [])];
  if (credentials.some(secret => secret && (fields.displaySummary.includes(secret) || fields.account.id.includes(secret)))) return null;
  attempt.proof = { accountVerified: true, verificationArgs: verificationArgs(conn, attempt.tool), ...fields, ...(access.hostedExecutor === true ? { deviceIndependent: true, execution: 'loop_cloud' } : {}),
    verifiedOperation: { tool: conn.id + '__' + attempt.tool, kind: 'read',
    verifiedAt: new Date(now).toISOString(), expiresAt: new Date(now + VERIFICATION_WINDOW_MS).toISOString() } };
  return attempt.proof;
}

export function priorObservation(session, conn, access, mask, tool, now = Date.now()) {
  const observed = observations.get(session);
  if (!observed?.proof || observed.tool !== tool || !supportsVerification(conn, tool) || observed.stamp !== stamp(conn, access, mask)) return null;
  const { verifiedAt, expiresAt } = observed.proof.verifiedOperation;
  return now >= Date.parse(verifiedAt) && now < Date.parse(expiresAt) ? observed.proof : null;
}
