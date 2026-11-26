// Pre-flight JSON Schema validation for upstream MCP tool arguments.

import { closestNames } from './item-refs.mjs';

const VAULT_REF_PATTERN = /\{\{vault:[A-Za-z0-9_.-]{1,100}\}\}/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describeValueType(val) {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  return typeof val;
}

function formatType(propSchema) {
  if (!isPlainObject(propSchema)) return 'any';
  if (typeof propSchema.type === 'string') return propSchema.type;
  if (Array.isArray(propSchema.type) && propSchema.type.length > 0) {
    return propSchema.type.join(' | ');
  }
  if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) {
    const preview = propSchema.enum.slice(0, 8).map((v) => JSON.stringify(v)).join(', ');
    return propSchema.enum.length > 8 ? `enum(${preview}, ...)` : `enum(${preview})`;
  }
  if (Array.isArray(propSchema.anyOf) && propSchema.anyOf.length > 0) {
    return propSchema.anyOf.map(formatType).filter(Boolean).join(' | ') || 'any';
  }
  if (Array.isArray(propSchema.oneOf) && propSchema.oneOf.length > 0) {
    return propSchema.oneOf.map(formatType).filter(Boolean).join(' | ') || 'any';
  }
  return 'any';
}

function allowsNull(propSchema) {
  if (!isPlainObject(propSchema)) return false;
  if (propSchema.type === 'null') return true;
  if (Array.isArray(propSchema.type) && propSchema.type.includes('null')) return true;
  if (propSchema.nullable === true) return true;
  if (Array.isArray(propSchema.enum) && propSchema.enum.includes(null)) return true;
  if (Array.isArray(propSchema.anyOf) && propSchema.anyOf.some((sub) => allowsNull(sub))) return true;
  if (Array.isArray(propSchema.oneOf) && propSchema.oneOf.some((sub) => allowsNull(sub))) return true;
  return false;
}

function matchesJsonSchemaType(val, expectedType) {
  switch (expectedType) {
    case 'string':
      return typeof val === 'string';
    case 'number':
      return typeof val === 'number' && Number.isFinite(val);
    case 'integer':
      return typeof val === 'number' && Number.isInteger(val);
    case 'boolean':
      return typeof val === 'boolean';
    case 'array':
      return Array.isArray(val);
    case 'object':
      return isPlainObject(val);
    case 'null':
      return val === null;
    default:
      return true;
  }
}

function deepEqualJson(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqualJson(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object') {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.hasOwn(b, key) || !deepEqualJson(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

function formatEnumExpected(values) {
  const limit = 12;
  const shown = values.slice(0, limit).map((v) => JSON.stringify(v)).join(', ');
  return values.length > limit
    ? `one of: ${shown}, ... (${values.length} total)`
    : `one of: ${shown}`;
}

const MAX_VALIDATION_DEPTH = 5;

function validateObjectSchema(schema, obj, prefix, missingRequired, invalidFields, depth = 0) {
  if (!isPlainObject(schema) || !isPlainObject(obj) || depth > MAX_VALIDATION_DEPTH) return;

  const props = isPlainObject(schema.properties) ? schema.properties : null;
  const hasUnion = Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf);
  const missingNames = new Set();

  if (!hasUnion && Array.isArray(schema.required)) {
    for (const reqKey of schema.required) {
      if (typeof reqKey !== 'string' || !reqKey) continue;
      const propSchema = props && Object.hasOwn(props, reqKey) ? props[reqKey] : null;
      const hasKey = Object.hasOwn(obj, reqKey);
      const val = hasKey ? obj[reqKey] : undefined;
      const isMissing = !hasKey || val === undefined || (val === null && !allowsNull(propSchema));
      if (isMissing) {
        missingNames.add(reqKey);
        missingRequired.push({
          name: prefix ? `${prefix}.${reqKey}` : reqKey,
          type: formatType(propSchema),
          description: typeof propSchema?.description === 'string' ? propSchema.description : '',
        });
      }
    }
  }

  if (!props) return;
  for (const [key, val] of Object.entries(obj)) {
    if (!Object.hasOwn(props, key)) continue;
    if (val === undefined || missingNames.has(key)) continue;

    const propSchema = props[key];
    if (!isPlainObject(propSchema)) continue;

    // Skip strict type/enum validation when the agent passes a Vault placeholder.
    if (typeof val === 'string' && VAULT_REF_PATTERN.test(val)) continue;

    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (typeof propSchema.type === 'string' || Array.isArray(propSchema.type)) {
      const expectedTypes = Array.isArray(propSchema.type)
        ? propSchema.type.filter((t) => typeof t === 'string')
        : [propSchema.type];
      const allowedTypes =
        propSchema.nullable === true && !expectedTypes.includes('null')
          ? [...expectedTypes, 'null']
          : expectedTypes;
      if (allowedTypes.length > 0 && !allowedTypes.some((t) => matchesJsonSchemaType(val, t))) {
        invalidFields.push({
          name: fullPath,
          expected: allowedTypes.join(' | '),
          received: describeValueType(val),
        });
        continue;
      }
    }

    if (Array.isArray(propSchema.enum) && !propSchema.enum.some((allowed) => deepEqualJson(val, allowed))) {
      invalidFields.push({
        name: fullPath,
        expected: formatEnumExpected(propSchema.enum),
        received: JSON.stringify(val),
      });
      continue;
    }

    if (isPlainObject(val) && (isPlainObject(propSchema.properties) || Array.isArray(propSchema.required))) {
      validateObjectSchema(propSchema, val, fullPath, missingRequired, invalidFields, depth + 1);
    }
  }
}

/**
 * Validates arguments against a synced connection tool's inputSchema before calling upstream.
 * Returns `null` when valid (or when schema validation is not applicable), or a structured
 * validation error payload when arguments fail pre-flight checks.
 */
export function validateToolArgs(conn, toolName, rawArgs) {
  // Step 1: Arguments must be a plain JSON object.
  if (!isPlainObject(rawArgs)) {
    return {
      error: 'Tool arguments must be a JSON object.',
      missingRequired: [],
      invalidFields: [
        {
          name: '(arguments)',
          expected: 'object',
          received: describeValueType(rawArgs),
        },
      ],
      inputSchema: null,
    };
  }

  // Step 2: Look up tool on synced connections.
  const tools = Array.isArray(conn?.tools) ? conn.tools : [];
  if (tools.length === 0) return null;

  const tool = tools.find((t) => t && t.name === toolName);
  if (!tool) {
    const names = tools.map((t) => t?.name).filter((name) => typeof name === 'string' && name.length > 0);
    const closest = closestNames(names, toolName);
    return {
      error: `Tool "${toolName}" was not found on connection "${conn?.name || conn?.id || 'unknown'}".`,
      ...(closest.length > 0 ? { closestTools: closest } : {}),
      missingRequired: [],
      invalidFields: [],
      availableTools: names.slice(0, 20),
      inputSchema: null,
    };
  }

  // Step 3: Validate against tool.inputSchema (including nested object schemas).
  const schema = tool.inputSchema;
  if (!isPlainObject(schema)) return null;

  const missingRequired = [];
  const invalidFields = [];
  validateObjectSchema(schema, rawArgs, '', missingRequired, invalidFields, 0);

  if (missingRequired.length === 0 && invalidFields.length === 0) return null;

  const parts = [];
  if (missingRequired.length > 0) {
    const label = missingRequired.length === 1 ? 'argument' : 'arguments';
    parts.push(
      `Missing required ${label}: ${missingRequired.map((m) => `${m.name} (${m.type})`).join(', ')}.`,
    );
  }
  if (invalidFields.length > 0) {
    const label = invalidFields.length === 1 ? 'argument' : 'arguments';
    parts.push(
      `Invalid ${label}: ${invalidFields.map((f) => `${f.name} (expected ${f.expected}, received ${f.received})`).join(', ')}.`,
    );
  }

  return {
    error: `Validation failed for tool "${toolName}": ${parts.join(' ')}`,
    missingRequired,
    invalidFields,
    inputSchema: schema,
    nextStep:
      'Put the tool\'s arguments inside `arguments` and call loop__run again with the missing fields filled from inputSchema. ' +
      'If you do not know a value (such as an id), find it first with a list or search tool on the same connection.',
  };
}
