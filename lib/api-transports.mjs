// OpenAPI and GraphQL transports for Loop: turns any REST OpenAPI spec or GraphQL endpoint
// into native Loop MCP tools with outbound SSRF checks, Vault credential resolution, and secret redaction.

import { createRedactor, findSecretRefs, readSecrets, fillSecretRefs } from './secret-refs.mjs';
import { createOutboundPolicy } from './outbound-policy.mjs';

const MAX_SPEC_BYTES = 2 * 1024 * 1024;
const MAX_OPENAPI_TOOLS = 200;
const MAX_YAML_ALIASES = 50;
const HTTP_METHODS = ['get', 'head', 'options', 'post', 'put', 'patch', 'delete'];
const SAFE_PATH_SEGMENT_RE = /^(?!\.{1,2}$)[A-Za-z0-9._~:@!$&'()*+,;=-]{1,256}$/;

function apiError(message, status = 400, code = 'API_TRANSPORT_ERROR') {
  return Object.assign(new Error(message), { status, code });
}

// Lightweight safe YAML subset parser (handles common OpenAPI YAML docs and refuses alias bombs).
// Supports mappings, sequences, scalars, quoted strings, inline JSON-like collections, and anchors/aliases with a strict expansion cap.
export function parseYamlOrJson(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw apiError('API specification document is empty.', 400);
  }
  if (Buffer.byteLength(rawText, 'utf8') > MAX_SPEC_BYTES) {
    throw apiError('API specification exceeds 2 MiB limit.', 413);
  }
  const trimmed = rawText.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw apiError(`Invalid JSON specification: ${err?.message || 'parse error'}`, 400);
    }
  }
  return parseSafeYaml(trimmed);
}

function parseYamlScalar(raw, resolveAlias = null) {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (resolveAlias && s.startsWith('*') && s.length > 1) return resolveAlias(s);
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'))) {
    try {
      return JSON.parse(s);
    } catch {
      // Inline flow array like [a, b] or [*a, *b]
      if (s.startsWith('[') && s.endsWith(']')) {
        const inner = s.slice(1, -1).trim();
        if (!inner) return [];
        return inner.split(',').map((item) => parseYamlScalar(item, resolveAlias));
      }
    }
  }
  return s;
}

function stripYamlComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && line[i - 1] !== '\\') inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseSafeYaml(text) {
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n');
  const lines = [];
  for (const raw of rawLines) {
    const cleaned = stripYamlComment(raw);
    if (!cleaned.trim()) continue;
    const indent = cleaned.match(/^ */)[0].length;
    lines.push({ indent, text: cleaned.slice(indent).trimEnd() });
  }
  if (!lines.length) throw apiError('YAML specification is empty.', 400);

  const anchors = new Map();
  let aliasExpansions = 0;
  let expandedNodes = 0;
  const MAX_EXPANDED_NODES = 5000;
  let idx = 0;

  const cloneValue = (val, depth = 0) => {
    expandedNodes += 1;
    if (depth > 25 || expandedNodes > MAX_EXPANDED_NODES) {
      throw apiError('YAML alias expansion exceeded safe limit (possible alias bomb).', 400, 'YAML_ALIAS_BOMB');
    }
    if (Array.isArray(val)) return val.map((item) => cloneValue(item, depth + 1));
    if (val && typeof val === 'object') {
      const out = Object.create(null);
      for (const [k, v] of Object.entries(val)) out[k] = cloneValue(v, depth + 1);
      return out;
    }
    return val;
  };

  const resolveAlias = (token) => {
    const name = token.slice(1).trim();
    if (!anchors.has(name)) throw apiError(`Unknown YAML alias "*${name}".`, 400);
    aliasExpansions += 1;
    if (aliasExpansions > MAX_YAML_ALIASES) {
      throw apiError('YAML alias expansion limit exceeded (possible alias bomb).', 400, 'YAML_ALIAS_BOMB');
    }
    return cloneValue(anchors.get(name));
  };

  const parseNode = (minIndent, depth = 0) => {
    if (depth > 40) throw apiError('YAML nesting depth exceeded.', 400);
    if (idx >= lines.length) return null;
    const first = lines[idx];
    if (first.indent < minIndent) return null;

    if (first.text === '-' || first.text.startsWith('- ')) {
      const arr = [];
      const seqIndent = first.indent;
      while (idx < lines.length && lines[idx].indent === seqIndent && (lines[idx].text === '-' || lines[idx].text.startsWith('- '))) {
        const rest = lines[idx].text.slice(1).trim();
        idx += 1;
        if (!rest) {
          arr.push(parseNode(seqIndent + 1, depth + 1));
        } else if (rest.startsWith('*')) {
          arr.push(resolveAlias(rest));
        } else {
          let anchorName = null;
          let valuePart = rest;
          const anchorMatch = /^&([A-Za-z0-9_-]+)(?:\s+(.*))?$/.exec(rest);
          if (anchorMatch) {
            anchorName = anchorMatch[1];
            valuePart = (anchorMatch[2] || '').trim();
          }
          const colonIdx = findMappingColon(valuePart);
          if (colonIdx !== -1) {
            // Inline mapping item under sequence dash: `- name: foo`
            const fakeLine = { indent: seqIndent + 2, text: valuePart };
            lines.splice(idx, 0, fakeLine);
            const itemObj = parseNode(seqIndent + 2, depth + 1);
            if (anchorName) anchors.set(anchorName, itemObj);
            arr.push(itemObj);
          } else if (!valuePart) {
            const nested = parseNode(seqIndent + 1, depth + 1);
            if (anchorName) anchors.set(anchorName, nested);
            arr.push(nested);
          } else {
            const scalar = parseYamlScalar(valuePart, resolveAlias);
            if (anchorName) anchors.set(anchorName, scalar);
            arr.push(scalar);
          }
        }
      }
      return arr;
    }

    const obj = {};
    const mapIndent = first.indent;
    while (idx < lines.length && lines[idx].indent === mapIndent) {
      const line = lines[idx].text;
      if (line.startsWith('- ')) break;
      const colonIdx = findMappingColon(line);
      if (colonIdx === -1) break;
      let key = line.slice(0, colonIdx).trim();
      if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
        key = key.slice(1, -1);
      }
      let rest = line.slice(colonIdx + 1).trim();
      idx += 1;
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;

      let anchorName = null;
      const anchorMatch = /^&([A-Za-z0-9_-]+)(?:\s+(.*))?$/.exec(rest);
      if (anchorMatch) {
        anchorName = anchorMatch[1];
        rest = (anchorMatch[2] || '').trim();
      }

      let value;
      if (key === '<<' && rest.startsWith('*')) {
        const merged = resolveAlias(rest);
        if (merged && typeof merged === 'object' && !Array.isArray(merged)) {
          for (const [mk, mv] of Object.entries(merged)) {
            if (!Object.hasOwn(obj, mk)) obj[mk] = mv;
          }
        }
        continue;
      } else if (!rest) {
        value = idx < lines.length && lines[idx].indent > mapIndent ? parseNode(mapIndent + 1, depth + 1) : null;
      } else if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
        const block = [];
        const baseBlockIndent = idx < lines.length ? lines[idx].indent : mapIndent + 2;
        while (idx < lines.length && lines[idx].indent >= baseBlockIndent && lines[idx].indent > mapIndent) {
          block.push(lines[idx].text);
          idx += 1;
        }
        value = rest.startsWith('>') ? block.join(' ') : block.join('\n');
      } else if (rest.startsWith('*')) {
        value = resolveAlias(rest);
      } else {
        value = parseYamlScalar(rest, resolveAlias);
      }
      if (anchorName) anchors.set(anchorName, value);
      obj[key] = value;
    }
    return obj;
  };

  return parseNode(0, 0);
}

function findMappingColon(str) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && str[i - 1] !== '\\') inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble && (i === str.length - 1 || str[i + 1] === ' ')) {
      return i;
    }
  }
  return -1;
}

function resolveRef(root, node, seen = new Set()) {
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    if (seen.has(node.$ref)) return {};
    seen.add(node.$ref);
    const parts = node.$ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    let cur = root;
    for (const part of parts) {
      if (!cur || typeof cur !== 'object' || !Object.hasOwn(cur, part)) return {};
      cur = cur[part];
    }
    return resolveRef(root, cur, seen);
  }
  return node;
}

function slugOperationName(method, pathStr, operationId) {
  const base = (operationId || `${method}_${pathStr}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return base || `${method}_endpoint`;
}

function simplifySchema(root, raw, depth = 0) {
  if (!raw || typeof raw !== 'object' || depth > 5) return { type: 'string' };
  const s = resolveRef(root, raw);
  if (!s || typeof s !== 'object') return { type: 'string' };
  const out = {};
  if (typeof s.type === 'string') out.type = s.type;
  if (typeof s.description === 'string') out.description = s.description.slice(0, 240);
  if (Array.isArray(s.enum)) out.enum = s.enum.slice(0, 40);
  if (s.type === 'object' || s.properties) {
    out.type = 'object';
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties || {}).slice(0, 50)) {
      out.properties[k] = simplifySchema(root, v, depth + 1);
    }
    if (Array.isArray(s.required) && s.required.length) out.required = s.required.slice(0, 50);
  } else if (s.type === 'array') {
    out.items = simplifySchema(root, s.items, depth + 1);
  }
  if (!out.type) out.type = 'string';
  return out;
}

export function compileOpenApiSpec(spec, { fallbackBaseUrl = '' } = {}) {
  if (!spec || typeof spec !== 'object' || (!spec.paths && !spec.openapi && !spec.swagger)) {
    throw apiError('Document does not appear to be a valid OpenAPI or Swagger specification.', 400);
  }
  let baseUrl = '';
  if (Array.isArray(spec.servers) && typeof spec.servers[0]?.url === 'string') {
    baseUrl = spec.servers[0].url.trim();
  } else if (typeof spec.host === 'string' && spec.host.trim()) {
    const scheme = Array.isArray(spec.schemes) && spec.schemes.includes('https') ? 'https' : (spec.schemes?.[0] || 'https');
    const basePath = typeof spec.basePath === 'string' ? spec.basePath : '';
    baseUrl = `${scheme}://${spec.host.trim()}${basePath}`;
  }
  if (baseUrl && !/^https?:\/\//i.test(baseUrl) && fallbackBaseUrl) {
    try {
      baseUrl = new URL(baseUrl, fallbackBaseUrl).href;
    } catch {
      baseUrl = fallbackBaseUrl;
    }
  }
  if (!baseUrl) baseUrl = fallbackBaseUrl;
  baseUrl = String(baseUrl || '').replace(/\/+$/, '');

  const title = typeof spec.info?.title === 'string' && spec.info.title.trim() ? spec.info.title.trim() : 'OpenAPI Service';
  const description = typeof spec.info?.description === 'string' ? spec.info.description.trim().slice(0, 400) : '';
  const tools = [];
  const operations = {};
  const usedNames = new Set();

  for (const [pathTemplate, pathItemRaw] of Object.entries(spec.paths || {})) {
    if (tools.length >= MAX_OPENAPI_TOOLS) break;
    const pathItem = resolveRef(spec, pathItemRaw);
    if (!pathItem || typeof pathItem !== 'object') continue;
    const sharedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const method of HTTP_METHODS) {
      if (tools.length >= MAX_OPENAPI_TOOLS) break;
      const op = resolveRef(spec, pathItem[method]);
      if (!op || typeof op !== 'object') continue;

      let toolName = slugOperationName(method, pathTemplate, op.operationId);
      let suffix = 2;
      while (usedNames.has(toolName)) {
        toolName = `${slugOperationName(method, pathTemplate, op.operationId).slice(0, 58)}_${suffix++}`;
      }
      usedNames.add(toolName);

      const allParams = [...sharedParams, ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map((p) => resolveRef(spec, p))
        .filter((p) => p && typeof p.name === 'string');

      const properties = {};
      const required = [];
      const pathParams = [];
      const queryParams = [];
      const headerParams = [];

      for (const p of allParams) {
        if (p.in === 'body') continue;
        const propSchema = simplifySchema(spec, p.schema || p);
        if (p.description && !propSchema.description) propSchema.description = String(p.description).slice(0, 240);
        properties[p.name] = propSchema;
        if (p.required || p.in === 'path') required.push(p.name);
        if (p.in === 'path') pathParams.push(p.name);
        else if (p.in === 'query') queryParams.push(p.name);
        else if (p.in === 'header') headerParams.push(p.name);
      }

      let hasBody = false;
      const reqBody = resolveRef(spec, op.requestBody);
      if (reqBody?.content?.['application/json']?.schema) {
        hasBody = true;
        properties.body = simplifySchema(spec, reqBody.content['application/json'].schema);
        if (reqBody.required) required.push('body');
      } else {
        const bodyParam = allParams.find((p) => p.in === 'body');
        if (bodyParam) {
          hasBody = true;
          properties.body = simplifySchema(spec, bodyParam.schema || { type: 'object' });
          if (bodyParam.required) required.push('body');
        }
      }

      const upperMethod = method.toUpperCase();
      const isRead = upperMethod === 'GET' || upperMethod === 'HEAD' || upperMethod === 'OPTIONS';
      const isDelete = upperMethod === 'DELETE';
      const summary = [op.summary, op.description].filter((s) => typeof s === 'string' && s.trim()).join(' — ').slice(0, 320);

      tools.push({
        name: toolName,
        title: typeof op.summary === 'string' && op.summary.trim() ? op.summary.trim().slice(0, 120) : `${upperMethod} ${pathTemplate}`,
        description: summary || `${upperMethod} ${pathTemplate}`,
        inputSchema: {
          type: 'object',
          properties,
          ...(required.length ? { required: [...new Set(required)] } : {}),
        },
        annotations: {
          readOnlyHint: isRead,
          destructiveHint: isDelete,
          idempotentHint: isRead || upperMethod === 'PUT' || isDelete,
          openWorldHint: true,
        },
      });

      operations[toolName] = {
        method: upperMethod,
        path: pathTemplate,
        pathParams,
        queryParams,
        headerParams,
        hasBody,
      };
    }
  }

  if (tools.length === 0) {
    throw apiError('OpenAPI specification contained no callable HTTP operations.', 400);
  }

  return { title, description, baseUrl, tools, operations };
}

export const GRAPHQL_INTROSPECTION_QUERY = `
  query LoopIntrospect {
    __schema {
      queryType { name fields { name description args { name type { name kind ofType { name kind } } } } }
      mutationType { name fields { name description args { name type { name kind ofType { name kind } } } } }
    }
  }
`.trim();

function summarizeGraphqlFields(typeObj) {
  const fields = Array.isArray(typeObj?.fields) ? typeObj.fields : [];
  return fields
    .slice(0, 40)
    .map((f) => {
      const args = Array.isArray(f.args) && f.args.length
        ? `(${f.args.map((a) => `${a.name}: ${a.type?.name || a.type?.ofType?.name || a.type?.kind || 'Any'}`).join(', ')})`
        : '';
      return `${f.name}${args}`;
    })
    .join(', ');
}

export function compileGraphqlTools(schemaData = null, { name = 'GraphQL API' } = {}) {
  const schema = schemaData?.data?.__schema || schemaData?.__schema || null;
  const querySummary = summarizeGraphqlFields(schema?.queryType);
  const mutationSummary = summarizeGraphqlFields(schema?.mutationType);

  const tools = [
    {
      name: 'graphql_query',
      title: `Query ${name}`,
      description: querySummary
        ? `Run a read-only GraphQL query against ${name}. Available queries: ${querySummary}`.slice(0, 900)
        : `Run a read-only GraphQL query against ${name}.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'GraphQL query document (must be a query, not a mutation).' },
          variables: { type: 'object', description: 'Optional GraphQL variables object.' },
          operationName: { type: 'string', description: 'Optional operation name.' },
        },
        required: ['query'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: 'graphql_mutation',
      title: `Mutate ${name}`,
      description: mutationSummary
        ? `Run a GraphQL mutation against ${name}. Available mutations: ${mutationSummary}`.slice(0, 900)
        : `Run a GraphQL mutation against ${name}.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'GraphQL mutation document.' },
          variables: { type: 'object', description: 'Optional GraphQL variables object.' },
          operationName: { type: 'string', description: 'Optional operation name.' },
        },
        required: ['query'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
  ];
  return { tools };
}

export async function importApiConnection({
  kind,
  url,
  specText = null,
  name = '',
  authHeader = '',
  authValue = '',
  personal = false,
  selfIdentity = null,
  fetchImpl = null,
} = {}) {
  const mode = String(kind || '').trim().toLowerCase();
  if (mode !== 'openapi' && mode !== 'graphql') {
    throw apiError('API import kind must be "openapi" or "graphql".', 400);
  }
  const policy = createOutboundPolicy({ personal, selfIdentity });
  const targetUrl = policy.assertConnectionUrl(url);
  if (personal && authValue && !String(authValue).includes('{{vault:')) {
    // Reject raw credentials in hosted mode unless referenced through Vault.
    throw apiError('Hosted API connections must reference secrets via {{vault:KEY}} placeholders.', 400);
  }

  const safeFetch = fetchImpl || policy.createFetchForUrl(targetUrl, { allowedOrigin: targetUrl.origin });
  const headers = {};
  if (authHeader && authValue) {
    headers[String(authHeader).trim()] = String(authValue).trim();
  }

  if (mode === 'openapi') {
    let rawSpec = specText;
    if (!rawSpec) {
      const res = await safeFetch(targetUrl.href, {
        method: 'GET',
        headers: { Accept: 'application/json, application/yaml, text/yaml, */*' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw apiError(`Could not fetch OpenAPI spec (HTTP ${res.status}).`, 502);
      }
      rawSpec = await res.text();
    }
    const parsed = parseYamlOrJson(rawSpec);
    const compiled = compileOpenApiSpec(parsed, { fallbackBaseUrl: targetUrl.origin });
    const apiBase = compiled.baseUrl || targetUrl.origin;
    policy.assertConnectionUrl(apiBase);
    return {
      name: String(name || '').trim() || compiled.title,
      description: compiled.description,
      transport: 'openapi',
      url: apiBase,
      specUrl: targetUrl.href,
      headers,
      tools: compiled.tools,
      apiOperations: compiled.operations,
    };
  }

  // GraphQL introspection (best-effort; falls back cleanly if introspection is disabled).
  let schemaData = null;
  try {
    const res = await safeFetch(targetUrl.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: GRAPHQL_INTROSPECTION_QUERY }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      schemaData = await res.json().catch(() => null);
    }
  } catch {
    // Introspection may require auth; still register graphql_query / graphql_mutation tools.
  }
  const displayName = String(name || '').trim() || targetUrl.hostname;
  const compiled = compileGraphqlTools(schemaData, { name: displayName });
  return {
    name: displayName,
    description: `GraphQL endpoint at ${targetUrl.host}${targetUrl.pathname}`,
    transport: 'graphql',
    url: targetUrl.href,
    headers,
    tools: compiled.tools,
  };
}

export async function executeApiTransportTool({
  conn,
  toolName,
  args = {},
  vault = null,
  outboundPolicy = null,
  extraSecrets = [],
  signal = null,
  fetchImpl = null,
} = {}) {
  const policy = outboundPolicy || createOutboundPolicy({ personal: false });
  const baseUrl = policy.assertConnectionUrl(conn.url);
  const safeFetch = fetchImpl || policy.createFetchForUrl(baseUrl, { allowedOrigin: baseUrl.origin });

  const secretKeys = new Set([
    ...findSecretRefs(conn.headers || {}),
    ...findSecretRefs(conn.url || ''),
    ...findSecretRefs(args || {}),
  ]);
  const secretMap = vault ? await readSecrets(vault, [...secretKeys]) : new Map();
  const resolvedHeaders = fillSecretRefs(conn.headers || {}, secretMap);
  const resolvedArgs = fillSecretRefs(args || {}, secretMap);
  const redactor = createRedactor([...secretMap.values(), ...(Array.isArray(extraSecrets) ? extraSecrets : [])]);

  try {
    if (conn.transport === 'graphql') {
      const query = String(resolvedArgs.query || '').trim();
      if (!query) throw apiError('GraphQL "query" argument is required.', 400);
      if (toolName === 'graphql_query' && /^\s*mutation\b/i.test(query)) {
        throw apiError('graphql_query only allows read-only queries. Use graphql_mutation for mutations.', 400);
      }
      const res = await safeFetch(baseUrl.href, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...resolvedHeaders,
        },
        body: JSON.stringify({
          query,
          ...(resolvedArgs.variables ? { variables: resolvedArgs.variables } : {}),
          ...(resolvedArgs.operationName ? { operationName: resolvedArgs.operationName } : {}),
        }),
        signal: signal || AbortSignal.timeout(30_000),
      });
      const rawText = await res.text();
      const maskedText = redactor.redact(rawText);
      let parsed = null;
      try { parsed = JSON.parse(maskedText); } catch { /* text fallback */ }
      const hasErrors = !res.ok || (Array.isArray(parsed?.errors) && parsed.errors.length > 0);
      return {
        content: [{ type: 'text', text: maskedText }],
        ...(parsed && typeof parsed === 'object' ? { structuredContent: parsed } : {}),
        isError: hasErrors,
      };
    }

    // OpenAPI execution with strict path-escape guard.
    const op = conn.apiOperations?.[toolName];
    if (!op) {
      throw apiError(`Unknown OpenAPI operation "${toolName}" on "${conn.id}".`, 404);
    }
    let resolvedPath = op.path;
    for (const paramName of op.pathParams || []) {
      const val = resolvedArgs[paramName];
      if (val === undefined || val === null || val === '') {
        throw apiError(`Missing required path parameter "${paramName}".`, 400);
      }
      const strVal = String(val);
      if (!SAFE_PATH_SEGMENT_RE.test(strVal) || strVal.includes('/') || strVal.includes('\\') || strVal.includes('..') || /%2[ef]/i.test(strVal)) {
        throw apiError(`Path parameter "${paramName}" contains disallowed path-escape characters.`, 400, 'OPENAPI_PATH_ESCAPE');
      }
      resolvedPath = resolvedPath.replaceAll(`{${paramName}}`, encodeURIComponent(strVal));
    }

    const baseClean = baseUrl.href.replace(/\/+$/, '');
    const target = new URL(`${baseClean}${resolvedPath.startsWith('/') ? '' : '/'}${resolvedPath}`);
    if (target.origin !== baseUrl.origin) {
      throw apiError('Resolved OpenAPI path escaped the configured base origin.', 400, 'OPENAPI_PATH_ESCAPE');
    }
    const basePrefix = baseUrl.pathname.replace(/\/+$/, '');
    if (basePrefix && !target.pathname.startsWith(basePrefix)) {
      throw apiError('Resolved OpenAPI path escaped the configured base path.', 400, 'OPENAPI_PATH_ESCAPE');
    }

    for (const qName of op.queryParams || []) {
      if (resolvedArgs[qName] !== undefined && resolvedArgs[qName] !== null) {
        target.searchParams.set(qName, String(resolvedArgs[qName]));
      }
    }

    const reqHeaders = { Accept: 'application/json', ...resolvedHeaders };
    for (const hName of op.headerParams || []) {
      if (resolvedArgs[hName] !== undefined && resolvedArgs[hName] !== null) {
        reqHeaders[hName] = String(resolvedArgs[hName]);
      }
    }

    let body;
    if (op.hasBody && resolvedArgs.body !== undefined && op.method !== 'GET' && op.method !== 'HEAD') {
      reqHeaders['Content-Type'] = reqHeaders['Content-Type'] || 'application/json';
      body = typeof resolvedArgs.body === 'string' ? resolvedArgs.body : JSON.stringify(resolvedArgs.body);
    }

    const res = await safeFetch(target.href, {
      method: op.method,
      headers: reqHeaders,
      ...(body !== undefined ? { body } : {}),
      signal: signal || AbortSignal.timeout(30_000),
    });
    const rawText = await res.text();
    const maskedText = redactor.redact(rawText);
    let parsed = null;
    try { parsed = JSON.parse(maskedText); } catch { /* non-JSON body */ }
    return {
      content: [{ type: 'text', text: maskedText || `HTTP ${res.status}` }],
      ...(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { structuredContent: parsed } : {}),
      isError: !res.ok,
    };
  } catch (err) {
    const safeMsg = redactor.redact(String(err?.message || 'API request failed.'));
    throw Object.assign(new Error(safeMsg), { status: err?.status || 502, code: err?.code || 'API_EXEC_ERROR' });
  }
}
