import { projectToolConnection } from './profiles.mjs';
import { isToolEnabled } from './store.mjs';
import { isNamedActionId, listNamedActionsForConnection, namedActionToTool } from './named-actions.mjs';

// Exact OAuth grants are snapshots. A newly installed tool must not become
// available to a client until the owner selects it.
export function actionGrantConnection(conn, toolGrants, { appSignIns = null } = {}) {
  if (toolGrants == null || !conn) return conn;
  const names = Object.hasOwn(toolGrants, conn.id) && toolGrants[conn.id];
  if (!Array.isArray(names)) return null;
  const directTools = (conn.tools || []).filter(t => names.includes(t.name) && isToolEnabled(conn, t.name));
  const grantedActionIds = names.filter(isNamedActionId);
  const namedTools = grantedActionIds.length > 0
    ? listNamedActionsForConnection(conn, { appSignIns })
        .filter(action => grantedActionIds.includes(action.id))
        .map(namedActionToTool)
    : [];
  const tools = [...directTools, ...namedTools];
  if (!tools.length) return null;
  const toolNames = tools.map(t => t.name);
  return { ...conn, tools, toolNames, allowedTools: toolNames, pinnedTools: [],
    prompts: [], resources: [], skills: [], partnerSkillsEnabled: false, serverInstructions: '', syncWarnings: [] };
}

// A request-scoped store facade for tool discovery and execution. Other store
// operations keep their normal receiver; only connection reads are projected.
export function projectToolCatalogView(store, profile, toolGrants = null, { appSignIns = null } = {}) {
  if (profile === 'all' && toolGrants == null) return store;
  const project = (conn) => actionGrantConnection(projectToolConnection(conn, profile), toolGrants, { appSignIns });
  return new Proxy(store, {
    get(target, key) {
      if (key === 'get') return async (id) => project(await target.get(id));
      if (key === 'list') return async (...args) => (await target.list(...args)).map(project).filter(Boolean);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
