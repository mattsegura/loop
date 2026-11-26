// Owner-authenticated Web Dashboard Chat Console (/api/chat, /api/chat/tools).
// Lets the Owner search capabilities, inspect tools/skills/memories, run tools through the
// standard Loop MCP pipeline (Vault + Policy + Activity + Redaction), and check approvals
// directly in the browser without installing an external desktop agent.

import { handleMcpRequest } from './mcp-server.mjs';
import { createRedactor } from './secret-refs.mjs';
import { buildServicesView } from './services.mjs';

function parseSlashRun(rest) {
  const trimmed = String(rest || '').trim();
  if (!trimmed) return null;
  const spaceIdx = trimmed.search(/\s/);
  if (spaceIdx < 0) return { tool: trimmed, args: {} };
  const tool = trimmed.slice(0, spaceIdx).trim();
  const argStr = trimmed.slice(spaceIdx + 1).trim();
  if (!argStr) return { tool, args: {} };
  try {
    const parsed = JSON.parse(argStr);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'Tool arguments must be a JSON object.' };
    }
    return { tool, args: parsed };
  } catch {
    return { error: 'Could not parse JSON arguments. Example: /run conn__tool {"query":"test"}' };
  }
}

async function runGatewayTool(mcpArgs, name, args) {
  const rpc = {
    jsonrpc: '2.0',
    id: `chat_${Date.now()}`,
    method: 'tools/call',
    params: { name, arguments: args },
  };
  const { store, vault, pool, ...options } = mcpArgs;
  const response = await handleMcpRequest(store, vault, pool, rpc, options);
  const result = response?.result || null;
  const text = result?.content?.find((c) => c?.type === 'text')?.text || '';
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  }
  return {
    ok: !response?.error && result?.isError !== true,
    error: response?.error?.message || (result?.isError ? (parsed?.message || text || 'Tool call failed.') : null),
    structured: result?.structuredContent || parsed,
    text,
  };
}

async function collectSecretRedactor(vault) {
  const values = [];
  try {
    const items = await vault.list({ includeInternal: true });
    for (const item of items.slice(0, 200)) {
      const val = await vault.get(item.key).catch(() => null);
      if (typeof val === 'string' && val.length >= 6) values.push(val);
    }
  } catch {
    // Ignore vault listing errors.
  }
  return createRedactor(values);
}

export async function handleChatConsoleRoutes({
  req,
  res,
  pathname,
  method,
  store,
  vault,
  pool,
  policyStore,
  approvalQueue,
  catStore,
  memoryStore,
  skillStore,
  activity,
  searchIndex,
  personal = false,
  origin = '',
  readJsonBody,
  sendJson,
}) {
  if (pathname === '/api/chat/tools' && method === 'GET') {
    const [conns, skills] = await Promise.all([
      store.list({ clone: false }),
      skillStore ? skillStore.list().catch(() => []) : [],
    ]);
    const { services } = buildServicesView({ connections: conns });
    const tools = [];
    for (const c of conns) {
      if (c.enabled === false) continue;
      for (const t of Array.isArray(c.tools) ? c.tools : []) {
        tools.push({
          id: `${c.id}__${t.name}`,
          connectionId: c.id,
          connectionName: c.name,
          accountLabel: c.accountLabel || '',
          name: t.name,
          title: t.title || t.name,
          description: t.description || '',
        });
      }
    }
    return sendJson(res, 200, {
      tools,
      services,
      skills: skills.map((s) => ({ id: s.id, name: s.name, description: s.description || '' })),
      pendingApprovals: approvalQueue ? approvalQueue.listPending().length : 0,
    });
  }

  if (pathname === '/api/chat' && method === 'POST') {
    const body = await readJsonBody(req);
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    const directTool = typeof body?.tool === 'string' ? body.tool.trim() : '';
    const directArgs = body?.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
      ? body.arguments
      : {};

    if (!message && !directTool) {
      return sendJson(res, 400, { error: 'Send a message or specify a tool to run.' });
    }

    const redactor = await collectSecretRedactor(vault);
    const ownerAgent = {
      id: 'owner_web_console',
      name: 'Owner (dashboard chat)',
      kind: 'dashboard',
      profile: 'all',
      mode: 'default',
      canManage: false,
      memoryAccess: 'read_write',
      enabled: true,
      secrets: [],
    };
    const mcpOptions = {
      store,
      pool,
      vault,
      policyStore,
      approvalQueue,
      catStore,
      memoryStore,
      skillStore,
      activity,
      searchIndex,
      personal,
      origin,
      agent: ownerAgent,
    };

    const sanitizePayload = (payload) => {
      if (!redactor.hasSecrets) return payload;
      try {
        return JSON.parse(redactor.redact(JSON.stringify(payload)));
      } catch {
        return payload;
      }
    };

    // 1) Direct structured tool run
    if (directTool) {
      const outcome = await runGatewayTool(mcpOptions, 'loop__run', {
        tool: directTool,
        arguments: directArgs,
      });
      return sendJson(res, 200, sanitizePayload({
        mode: 'tool',
        tool: directTool,
        ok: outcome.ok,
        reply: outcome.ok
          ? `Ran ${directTool}.`
          : (outcome.error || `Tool ${directTool} returned an error.`),
        result: outcome.structured ?? outcome.text,
      }));
    }

    // 2) Slash commands
    if (message === '/help' || message === 'help') {
      return sendJson(res, 200, {
        mode: 'help',
        ok: true,
        reply: [
          'Available Loop console commands:',
          '• /services — list connected services and accounts',
          '• /approvals — list pending approval requests',
          '• /search <query> — search tools, skills, and memories',
          '• /inspect <id> — inspect a tool, connection, or skill schema',
          '• /run <connId__tool> [json] — run a tool through Loop policy and Vault',
          '• Or type any request to find matching Loop tools and skills.',
        ].join('\n'),
      });
    }

    if (message === '/services') {
      const conns = await store.list({ clone: false });
      const { services } = buildServicesView({ connections: conns });
      return sendJson(res, 200, {
        mode: 'services',
        ok: true,
        reply: services.length
          ? `${services.length} service(s) connected across ${conns.length} account(s).`
          : 'No services connected yet. Open #setup to add one.',
        services,
      });
    }

    if (message === '/approvals') {
      const pending = approvalQueue ? approvalQueue.listPending() : [];
      return sendJson(res, 200, {
        mode: 'approvals',
        ok: true,
        reply: pending.length
          ? `${pending.length} pending approval(s).`
          : 'No pending approvals.',
        pending,
      });
    }

    if (message.startsWith('/search ')) {
      const query = message.slice('/search '.length).trim();
      const outcome = await runGatewayTool(mcpOptions, 'loop__search', { query, limit: 10 });
      return sendJson(res, 200, sanitizePayload({
        mode: 'search',
        ok: outcome.ok,
        query,
        reply: outcome.ok ? `Search results for "${query}".` : outcome.error,
        result: outcome.structured ?? outcome.text,
      }));
    }

    if (message.startsWith('/inspect ')) {
      const target = message.slice('/inspect '.length).trim();
      const outcome = await runGatewayTool(mcpOptions, 'loop__inspect', { items: [target] });
      return sendJson(res, 200, sanitizePayload({
        mode: 'inspect',
        ok: outcome.ok,
        target,
        reply: outcome.ok ? `Inspected "${target}".` : outcome.error,
        result: outcome.structured ?? outcome.text,
      }));
    }

    if (message.startsWith('/run ')) {
      const parsed = parseSlashRun(message.slice('/run '.length));
      if (!parsed || parsed.error) {
        return sendJson(res, 400, { error: parsed?.error || 'Provide a tool id after /run.' });
      }
      const outcome = await runGatewayTool(mcpOptions, 'loop__run', {
        tool: parsed.tool,
        arguments: parsed.args,
      });
      return sendJson(res, 200, sanitizePayload({
        mode: 'tool',
        tool: parsed.tool,
        ok: outcome.ok,
        reply: outcome.ok ? `Ran ${parsed.tool}.` : (outcome.error || `Tool ${parsed.tool} failed.`),
        result: outcome.structured ?? outcome.text,
      }));
    }

    // 3) Natural-language capability search across Loop tools, skills, and memories
    const searchOutcome = await runGatewayTool(mcpOptions, 'loop__search', { query: message, limit: 8 });
    const matches = Array.isArray(searchOutcome.structured?.results)
      ? searchOutcome.structured.results
      : Array.isArray(searchOutcome.structured?.items)
        ? searchOutcome.structured.items
        : [];

    const reply = matches.length > 0
      ? `Found ${matches.length} matching Loop item(s) for "${message}". Pick a tool below or run /run <tool_id> {args}.`
      : `No direct tool or memory matched "${message}". Try /services, /search <keyword>, or connect a service in #setup.`;

    return sendJson(res, 200, sanitizePayload({
      mode: 'assistant',
      ok: true,
      reply,
      matches,
      result: searchOutcome.structured,
    }));
  }

  return false;
}
