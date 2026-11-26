// Thin REST + OpenAPI 3.1 bridge over Loop's MCP gateway.
// Every request executes through handleMcpRequest so Loop's policies, Guard,
// Vault injection & masking, rate limits, modules, toolMode, and audit logs
// apply identically to non-MCP hosts (Python scripts, curl, OpenAI custom GPTs,
// LangChain, CrewAI, or generic REST agents).

import { MAX_JSON_BODY_BYTES, isPlainObject, readJsonBody, sendJson } from './http/transport.mjs';

const MAX_LIST_PAGES = 10;
const MAX_OPENAPI_TOOLS = 100;

export async function listToolsViaMcp(runMcp) {
  const all = [];
  let cursor = undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const rpc = await runMcp({
      jsonrpc: '2.0',
      id: page + 1,
      method: 'tools/list',
      params: cursor ? { cursor } : {},
    });
    if (rpc?.error) {
      throw Object.assign(new Error(rpc.error.message || 'Failed to list tools.'), {
        status: rpc.error.code === -32003 ? 403 : 400,
      });
    }
    const items = Array.isArray(rpc?.result?.tools) ? rpc.result.tools : [];
    all.push(...items);
    cursor = rpc?.result?.nextCursor;
    if (!cursor) break;
  }
  return all;
}

export async function callToolViaMcp(runMcp, { name, arguments: toolArgs = {}, meta = null }) {
  const rpc = await runMcp({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name,
      arguments: isPlainObject(toolArgs) ? toolArgs : {},
      ...(isPlainObject(meta) ? { _meta: meta } : {}),
    },
  });
  if (rpc?.error) {
    const code = rpc.error.code;
    const status = code === -32003 ? 403 : code === -32001 ? 401 : code === -32602 ? 400 : 500;
    return {
      status,
      body: {
        ok: false,
        error: rpc.error.message || 'Tool call failed.',
        code,
      },
    };
  }
  const result = rpc?.result || {};
  const content = Array.isArray(result.content) ? result.content : [];
  const textParts = content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text);
  const text = textParts.join('\n');
  let parsed = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  return {
    status: 200,
    body: {
      ok: !result.isError,
      isError: Boolean(result.isError),
      tool: name,
      content,
      ...(text ? { text } : {}),
      ...(parsed !== undefined ? { data: parsed } : {}),
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    },
  };
}

export function buildOpenApiDocument({ origin, basePath = '/api/v1', tools = [], serverVersion = '2.0.0' }) {
  const paths = {
    [`${basePath}/tools`]: {
      get: {
        operationId: 'listLoopTools',
        summary: 'List Loop tools available to this agent token.',
        responses: {
          200: {
            description: 'Available tools with JSON input schemas.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    count: { type: 'integer' },
                    tools: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    [`${basePath}/tools/{name}/call`]: {
      post: {
        operationId: 'callLoopTool',
        summary: 'Invoke a Loop tool by name.',
        parameters: [
          {
            name: 'name',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Exact tool name from GET /tools (for example loop__search or loop_utils__calc).',
          },
        ],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  arguments: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Tool execution result.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  };

  for (const tool of (Array.isArray(tools) ? tools : []).slice(0, MAX_OPENAPI_TOOLS)) {
    if (!tool?.name || typeof tool.name !== 'string') continue;
    const safeOp = tool.name.replace(/[^A-Za-z0-9_]+/g, '_').slice(0, 64);
    paths[`${basePath}/tools/${encodeURIComponent(tool.name)}/call`] = {
      post: {
        operationId: `call_${safeOp}`,
        summary: String(tool.title || tool.name).slice(0, 120),
        description: String(tool.description || '').slice(0, 500),
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  arguments: isPlainObject(tool.inputSchema)
                    ? tool.inputSchema
                    : { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Tool execution result.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Loop Gateway Tool API',
      version: serverVersion,
      description: 'Bearer-authenticated REST bridge over Loop MCP tools, policies, and Vault masking.',
    },
    servers: [{ url: origin }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Loop agent token (loop_...).',
        },
      },
    },
    paths,
  };
}

export async function handleRestBridgeRequest(
  req,
  res,
  { subpath, origin, basePath = '/api/v1', serverVersion = '2.0.0', runMcp },
) {
  if (subpath === '/tools') {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' });
    }
    const tools = await listToolsViaMcp(runMcp);
    return sendJson(res, 200, { count: tools.length, tools });
  }

  if (subpath === '/openapi.json') {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' });
    }
    const tools = await listToolsViaMcp(runMcp);
    return sendJson(res, 200, buildOpenApiDocument({ origin, basePath, tools, serverVersion }));
  }

  const callMatch = /^\/tools\/([^/]+)\/call$/.exec(subpath);
  if (callMatch) {
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' });
    }
    let toolName;
    try {
      toolName = decodeURIComponent(callMatch[1]).trim();
    } catch {
      return sendJson(res, 400, { error: 'Invalid tool name encoding.' });
    }
    if (!toolName || toolName.length > 160) {
      return sendJson(res, 400, { error: 'Invalid tool name.' });
    }
    let body = {};
    try {
      body = await readJsonBody(req, { maxBytes: MAX_JSON_BODY_BYTES });
    } catch (err) {
      if (err?.code === 'BODY_TOO_LARGE') {
        return sendJson(res, 413, { error: err.publicMessage }, { Connection: 'close' });
      }
      return sendJson(res, 400, { error: 'Invalid JSON body.' });
    }
    if (!isPlainObject(body)) {
      return sendJson(res, 400, { error: 'Request body must be a JSON object.' });
    }
    const hasExplicitArgs = Object.hasOwn(body, 'arguments');
    if (hasExplicitArgs && body.arguments !== undefined && !isPlainObject(body.arguments)) {
      return sendJson(res, 400, { error: '"arguments" must be a JSON object.' });
    }
    const toolArgs = hasExplicitArgs ? (body.arguments || {}) : body;
    const meta = isPlainObject(body._meta) ? body._meta : null;
    const result = await callToolViaMcp(runMcp, { name: toolName, arguments: toolArgs, meta });
    return sendJson(res, result.status, result.body);
  }

  return sendJson(res, 404, { error: 'Not found.' });
}
