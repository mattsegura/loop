// HTTP route handlers for Loop Billing and Invite flows.
import { readJsonBody, sendJson } from '../http/transport.mjs';
import { InviteError, formatInviteShare } from '../invites.mjs';
import { ensureSmsAgentRecord, isPlanActiveForSms, SmsAgentError } from '../sms-agent.mjs';

export async function handleBillingRoute(req, res, { pathname, origin, ws, billing, inviteStore, loopConnectServer }) {
  if (!pathname.startsWith('/api/billing')) return false;
  const workspaceKey = ws.id || 'local';
  if (pathname === '/api/billing' && req.method === 'GET') {
    const invited = await inviteStore.isInvited(workspaceKey);
    return sendJson(res, 200, await billing.getWorkspaceStatus(workspaceKey, { invited })), true;
  }
  if (pathname === '/api/billing/checkout' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const result = await billing.createCheckoutSession({
      workspaceKey,
      planId: body.plan || 'pro',
      extraDevices: body.extraDevices,
      origin,
      customerEmail: body.email,
    });
    return sendJson(res, 200, result), true;
  }
  if (pathname === '/api/billing/devices' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const [invited, pairedDevices] = await Promise.all([
      inviteStore.isInvited(workspaceKey),
      ws.connectContext ? loopConnectServer.listDevices(ws.connectContext.dataDir) : Promise.resolve([]),
    ]);
    const result = await billing.updateExtraDevices({
      workspaceKey,
      extraDevices: body.extraDevices,
      delta: body.delta,
      currentPairedDevices: pairedDevices.length,
      invited,
    });
    return sendJson(res, 200, result), true;
  }
  if (pathname === '/api/billing/portal' && req.method === 'POST') {
    const result = await billing.createPortalSession({ workspaceKey, origin });
    return sendJson(res, 200, result), true;
  }
  if (pathname === '/api/billing/waitlist' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const result = await billing.joinWaitlist({
      workspaceKey,
      email: body.email,
      plan: body.plan,
      teamSize: body.teamSize,
      note: body.note,
    });
    return sendJson(res, 200, result), true;
  }
  return false;
}

export async function handleInviteRoute(req, res, {
  pathname,
  origin,
  ws,
  identity,
  inviteStore,
  billing,
  smsAgentClient,
  tokenRouter,
  deriveInviteIdentity,
}) {
  if (!pathname.startsWith('/api/invites')) return false;
  const workspaceKey = ws.id || 'local';
  const { inviterName: defaultInviterName, preferredSlug: defaultPreferredSlug } = deriveInviteIdentity(identity, !ws.id);
  try {
    if (pathname === '/api/invites/mine') {
      if (req.method === 'GET') {
        const rec = await inviteStore.getOrCreateForUser({
          workspaceId: workspaceKey,
          inviterName: defaultInviterName,
          preferredSlug: defaultPreferredSlug,
        });
        return sendJson(res, 200, formatInviteShare(rec, origin)), true;
      }
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const rec = await inviteStore.updateForUser({
          workspaceId: workspaceKey,
          ...(body?.inviterName !== undefined ? { inviterName: body.inviterName } : {}),
          ...(body?.slug !== undefined ? { slug: body.slug } : {}),
          defaultInviterName,
          defaultPreferredSlug,
        });
        return sendJson(res, 200, formatInviteShare(rec, origin)), true;
      }
      return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, PATCH' }), true;
    }
    if (pathname === '/api/invites/claim') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }), true;
      const body = await readJsonBody(req);
      const slug = typeof body?.t === 'string' ? body.t : (typeof body?.slug === 'string' ? body.slug : '');
      const claimResult = await inviteStore.claim({ slug, claimerWorkspaceId: workspaceKey });
      const myInviteRec = await inviteStore.getOrCreateForUser({
        workspaceId: workspaceKey,
        inviterName: defaultInviterName,
        preferredSlug: defaultPreferredSlug,
      });
      const myInvite = formatInviteShare(myInviteRec, origin);
      if (!smsAgentClient.enabled) {
        return sendJson(res, 200, {
          ok: true,
          ...claimResult,
          smsEnabled: false,
          linkCode: null,
          myInvite,
        }), true;
      }
      const billingStatus = billing ? await billing.getWorkspaceStatus(workspaceKey) : null;
      const invited = Boolean(claimResult.claimed) || (await inviteStore.isInvited(workspaceKey));
      const planActive = invited || isPlanActiveForSms(billingStatus);
      if (!planActive) {
        return sendJson(res, 200, {
          ok: true,
          ...claimResult,
          smsEnabled: true,
          linkCode: null,
          myInvite,
        }), true;
      }
      const wsStore = ws.shareContext?.store;
      const wsVault = ws.shareContext?.vault;
      const broadcast = ws.shareContext?.broadcast;
      const { agent, token } = await ensureSmsAgentRecord(wsStore, wsVault);
      if (ws.id && token) tokenRouter.remember(token, ws.id);
      if (typeof broadcast === 'function') broadcast('agents');
      const connections = (await wsStore.list()).filter((m) => m.enabled).map((m) => m.name);
      const linkCode = await smsAgentClient.createLinkCode({
        workspaceId: workspaceKey,
        agentId: agent.id,
        agentToken: token,
        planActive: true,
        connections,
        inviteUrl: myInvite.inviteUrl,
      });
      return sendJson(res, 200, {
        ok: true,
        ...claimResult,
        smsEnabled: true,
        linkCode,
        myInvite,
      }), true;
    }
    return sendJson(res, 404, { error: 'Not found.' }), true;
  } catch (err) {
    if (err instanceof InviteError || err instanceof SmsAgentError) {
      return sendJson(res, err.status, { error: err.publicMessage || err.message }), true;
    }
    throw err;
  }
}
