import { isToolEnabled } from './store.mjs';
import { toolKindOf } from './policies.mjs';
import { isSharedConnection } from './shared-connection.mjs';
import { isRelayConnection } from './loop-connect.mjs';

const PERSONAL_LOCAL_REFUSAL_RE = /Personal MCP allows only remote HTTP or SSE/i;
const RELAY_OFFLINE_RE = /offline|disconnected|not connected|paired computer.*unavailable|device.*offline/i;

export function isWorkspaceUnsupportedConnection(c, { personal = false } = {}) {
  const local = c?.transport === 'stdio' || Boolean(c?.command);
  if (!local) return false;
  return Boolean(personal) || PERSONAL_LOCAL_REFUSAL_RE.test(String(c?.lastError || ''));
}

// Whether a connection runs 24/7 in cloud/remote, depends on a paired Mac via Loop Connect,
// or is local-only stdio on the user's machine.
export function connectionAvailability(c, { relayOnline = null } = {}) {
  if (isRelayConnection(c)) {
    if (relayOnline === true) return 'paired_mac_online';
    if (relayOnline === false) return 'paired_mac_offline';
    if (c?.relayOnline === true || c?.deviceOnline === true) return 'paired_mac_online';
    if (c?.relayOnline === false || c?.deviceOnline === false) return 'paired_mac_offline';
    if (c?.lastError && RELAY_OFFLINE_RE.test(String(c.lastError))) return 'paired_mac_offline';
    return 'paired_mac_online';
  }
  const local = c?.transport === 'stdio' || Boolean(c?.command);
  if (local) return 'local_only';
  return 'cloud_24x7';
}

// Tool readiness, not a promise that the provider has granted every advertised scope.
// Never include credentials, raw upstream errors, environment values or URLs in handoffs.
export function connectionReadiness(c, { tokenRejected = false, personal = false, relayOnline = null } = {}) {
  const tools = Array.isArray(c.tools) ? c.tools : [];
  const enabled = tools.filter(t => t?.name && isToolEnabled(c, t.name));
  const permissions = { read: 0, write: 0, destructive: 0, unmarked: 0 };
  for (const t of enabled) permissions[toolKindOf(t.annotations)]++;
  const local = c.transport === 'stdio' || Boolean(c.command);
  const availability = connectionAvailability(c, { relayOnline });
  const result = (state, label, action, nextStep, forAgents = '') => ({
    state, label, ready: state === 'ready', availability, action, nextStep,
    discoveredTools: tools.length, enabledTools: enabled.length, permissions,
    ...(state !== 'ready' ? { handoff: `Inspect the Loop connection with ID ${JSON.stringify(c.id)}. Status: ${label}. ${forAgents}${nextStep} Verify that an enabled tool is available before resuming my task. Do not ask me to paste credentials into chat.` } : {}),
  });
  if (c.enabled === false) return result('disabled', 'Off', 'enable', 'Turn on the connection in its settings.');
  if (isWorkspaceUnsupportedConnection(c, { personal })) {
    const nextStep = 'This Loop runs in hosted (personal) mode, which cannot start local command programs. Do not retry this connection here; use a remote HTTP/SSE connection, pair a computer with Loop Connect, or switch Loop to local mode.';
    return {
      state: 'unsupported_workspace',
      label: 'Cannot run here',
      ready: false,
      availability,
      action: null,
      nextStep,
      discoveredTools: tools.length,
      enabledTools: enabled.length,
      permissions,
      handoff: `Connection ${JSON.stringify(c.id)} cannot run in this Loop workspace. Status: Cannot run here. ${nextStep}`,
    };
  }
  if (tokenRejected) return result('token_rejected', 'Token rejected', 'credentials', 'Replace the rejected key in Loop, then refresh its tools.');
  if (c.signInBroken || (c.authRequired && local)) return result('setup_required', 'Setup required', 'repair', local ? 'Complete the connector setup on the computer running it, then refresh its tools.' : 'Automatic sign-in is unavailable. Use a supported connector or finish manual setup, then refresh its tools.', local ? '' : 'Inspect the fix-connection skill in Loop. ');
  if (c.authRequired) return result('needs_sign_in', 'Needs sign-in', 'sign_in', 'Sign in through Loop, then refresh its tools.');
  // Another Loop lends this one, so only its owner can do something about it.
  if (c.lastError && isSharedConnection(c)) return result('lent_off', 'Not lent now', null, 'The person who lends it must turn it on in their Loop.');
  if (c.lastError) return result('error', 'Error', 'repair', local ? 'Check the local connector installation and account setup on the computer running it, then retry the connection.' : 'Check the server address and its setup, then retry the connection.');
  if (!tools.length) return result(c.lastSyncAt ? 'no_tools' : 'not_synced', c.lastSyncAt ? 'No tools discovered' : 'Not synced', 'refresh', 'Refresh tools. If none appear, check the connector setup before using it.');
  if (!enabled.length) return result('tools_disabled', 'All tools off', 'enable_tools', 'Turn on a tool in the connection.');
  return result('ready', 'Ready', null, null);
}
