// What `loop__save` takes in `data`, for each type of item and action.
//
// Each `fields` line is the text an agent reads in the tool, and the same line is read back here to
// refuse a name that Loop would drop. So the text and the check cannot say different things, and an
// agent never hears "saved" for something that was not kept.
//
// A line is a list of names. `?` marks a name that can be left out. `name: { ... }` and
// `name: [{ ... }]` give the names inside an object, or inside each object of a list. Any other text
// after a name is only for the reader.
//
// `also`    names that work and that the text leaves out: an older name, or one that only a page of Loop sends.
// `actions` action-specific field lines (`save` uses the top-level `fields` and `also` by default).
// `modes`   mutually exclusive groups of keys (for example `dream` operations).
// `after`   a note that follows the fields in the tool text.
// `extra`   where a detail without a field of its own can go.
// `ownCheck` the type refuses unknown names itself, with words of its own.

const PAYLOADS = {
  connection: {
    fields: 'name, url?, command?, args?, env?, description?, pinnedTools?, enabled?, disabledTools?',
    after: '(url for a hosted MCP server, or command + args + env for a local program; enabled: false turns the connection off for every agent and true turns it on again; disabledTools: ["tool_name"] turns single tools off, for example to make a connection read only; action sync takes { waitForSignIn? })',
    also: ['id', 'accountLabel', 'agentNote', 'token', 'headers', 'cwd', 'transport', 'type', 'projects', 'profiles', 'allowedTools', 'approval',
      'allowManualAuth', 'oauth', 'mcpServers', 'remoteAccess', 'installSpec', 'toolSetupId', 'home'],
    actions: {
      sync: { fields: 'waitForSignIn?', also: [] },
      delete: { fields: '', also: [] },
    },
    extra: 'description',
  },
  skill: {
    fields: 'name, description, content, projects?',
    also: ['id', 'markdown', 'profiles', 'source'],
    actions: {
      delete: { fields: '', also: [] },
    },
    extra: 'content',
  },
  project: {
    fields: 'name, description?, repositoryUrl?, workingDirectory?',
    after: '(repositoryUrl: Git repo URL; workingDirectory: a folder on the computer that runs Loop, which the owner confirms; action invite takes { name?, description?, kind?: "other"|"me", createIfMissing?, copyToClipboard? }; action add_tools takes { connections?, tools?: [{ connectionId, toolName? }] })',
    also: ['id', 'profile'],
    actions: {
      invite: {
        fields: 'name?, description?, kind?: "other"|"me", createIfMissing?, copyToClipboard?',
        also: ['id', 'profile', 'ownerName'],
      },
      add_tools: {
        fields: 'connections?, tools?: [{ connectionId, toolName? }]',
        also: ['id', 'profile'],
      },
      enter: { fields: '', also: ['id', 'profile', 'project', 'name'] },
      exit: { fields: '', also: ['id', 'profile', 'project', 'name'] },
      delete: { fields: '', also: ['id', 'profile', 'project', 'name'] },
    },
    extra: 'description',
  },
  agent: {
    label: 'agent (action invite)',
    fields: 'name, kind?, project?, canManage?, memoryAccess?',
    also: ['profile'],
    actions: {
      invite: {
        fields: 'name, kind?, project?, canManage?, memoryAccess?',
        also: ['profile'],
      },
    },
  },
  memory: {
    fields: 'content, key?, scope?, projects?, project?, tags?, links?, pinned?, supersedes?, ephemeral?',
    after: '(projects: the ids of the Loop projects that the memory is in; project is only a label for the work that the fact is about; links: [{ target, relation? }] joins the memory to another memory, a saved item, a file or a task by id)',
    also: ['id', 'text', 'profiles', 'source'],
    actions: {
      delete: { fields: '', also: [] },
    },
    extra: 'content or tags',
  },
  task: {
    fields: 'id?, expectedRevision (0 to create), operationId?, title, objective, notes, nextStep, assignedTo?, result?, notifyOnComplete?, status: active | waiting | completed | cancelled, sources?: [{ reference, observation?, observedAt? }], links?: [{ target, relation? }]',
    after: '(action delete forgets it; links joins the task to Library items by id)',
    actions: {
      delete: { fields: '', also: [] },
    },
    extra: 'notes',
  },
  saved: {
    fields: 'url?, title?, note?, tags?, kind?: link | note | artifact, markdown?, ui?, links?: [{ target, relation? }]',
    after: '(one of url, note, markdown or ui is enough; ui is a json-render card { root, elements }; links joins the item to other Library items by id, for example a note to the sources it was made from with relation derived_from; relation is relates | cites | derived_from | part_of | extends | updates | contradicts)',
    also: ['id', 'text', 'summary', 'excerpt', 'author', 'image', 'project', 'projects', 'archived', 'fetch', 'source'],
    actions: {
      refresh: { fields: '', also: ['id', 'refresh'] },
      delete: { fields: '', also: [] },
    },
    extra: 'note',
  },
  schedule: {
    fields: 'title, message?, kind: once | daily | weekly | interval | cron, delayMinutes?, runAt?, timeOfDay?, days?, intervalMinutes?, cronExpr?, timezone?, action?: notify | task | both | tool',
    also: ['id', 'status', 'cron', 'project', 'projects', 'runNow', 'tool', 'toolConnectionId', 'toolConnId', 'toolName', 'toolArgs'],
    actions: {
      run: { fields: '', also: ['id'] },
      delete: { fields: '', also: [] },
    },
    extra: 'message',
  },
  file: {
    fields: 'name, content?, contentBase64?, mimeType?, note?, tags?, links?: [{ target, relation? }]',
    after: '(content is text; contentBase64 is for other files, up to 10 MB; links joins the file to Library items by id)',
    also: ['id', 'filename', 'project', 'projects', 'source'],
    actions: {
      delete: { fields: '', also: [] },
    },
    extra: 'note',
  },
  dream: {
    fields: 'enabled?, triggerMode?, stepInterval?, reviewBeforeApply?, applyMode?, remember?, run?, dryRun?, force?, approveProposalId?, dismissProposalId?, approveAll?, dismissAll?',
    after: '(send one dream operation per call: remember, approve, dismiss, run, or settings)',
    modes: {
      remember: ['remember'],
      approve: ['approveProposalId', 'approveAll'],
      dismiss: ['dismissProposalId', 'dismissAll'],
      run: ['run', 'dryRun', 'force'],
      settings: ['enabled', 'triggerMode', 'stepInterval', 'reviewBeforeApply', 'applyMode'],
    },
  },
  vault: {
    label: 'Vault action save',
    fields: 'key, value, description, category?, username?',
    after: ', Vault action capture { value } only (put the service name in id)',
    also: ['id', 'projects', 'profiles', 'approval'],
    actions: {
      delete: { fields: '', also: [] },
    },
    extra: 'description',
  },
  category: {
    fields: 'createCategories, deleteCategories, assignConnections, assignSkills, planId? (from preview)',
    also: ['reason'],
    ownCheck: true,
  },
  feedback: {
    fields: 'enabled',
    after: '(may agents report faults of Loop itself; only as the user says)',
  },
};

const VAULT_TYPES = new Set(['api_key', 'login', 'payment', 'note']);
// What an agent calls the item in a sentence.
const NOUN = { vault: 'Vault item', saved: 'saved item', feedback: 'feedback choice' };

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The parts of a field line, cut at the commas that are not inside brackets or quotes.
function parts(line) {
  const out = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quote = !quote;
    else if (quote) continue;
    else if ('{[('.includes(ch)) depth += 1;
    else if ('}])'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(line.slice(start, i));
      start = i + 1;
    }
  }
  out.push(line.slice(start));
  return out.map((part) => part.trim()).filter(Boolean);
}

// name -> { list, inner, shape }: `inner` holds the names of a nested object, or null when the value is free.
function readFields(line) {
  const fields = new Map();
  if (!line || !line.trim()) return fields;
  for (const part of parts(line)) {
    const found = /^([A-Za-z_]\w*)\??\s*([\s\S]*)$/.exec(part);
    if (!found) throw new Error(`Cannot read the field "${part}".`);
    const shape = found[2].startsWith(':') ? found[2].slice(1).trim() : '';
    const list = shape.startsWith('[{') && shape.endsWith('}]');
    const object = shape.startsWith('{') && shape.endsWith('}');
    fields.set(found[1], {
      list,
      inner: list ? readFields(shape.slice(2, -2)) : object ? readFields(shape.slice(1, -1)) : null,
      shape: list ? shape.slice(1, -1) : shape,
    });
  }
  return fields;
}

function compileSpec(spec) {
  const fields = readFields(spec.fields || '');
  const shown = [...fields.keys()];
  for (const name of spec.also || []) {
    if (!fields.has(name)) fields.set(name, { list: false, inner: null, shape: '' });
  }
  return { fields, shown, text: spec.fields || '' };
}

const COMPILED = new Map(Object.entries(PAYLOADS).map(([type, payload]) => {
  const base = compileSpec(payload);
  const actions = new Map([['save', base]]);
  for (const [action, spec] of Object.entries(payload.actions || {})) {
    actions.set(action, compileSpec(spec));
  }
  return [type, { base, actions }];
}));

function payloadKey(type) {
  if (VAULT_TYPES.has(type)) return 'vault';
  return type === 'profile' ? 'project' : type;
}

function normalizeAction(action) {
  const clean = typeof action === 'string' ? action.trim().toLowerCase() : '';
  return clean || 'save';
}

function actionSpec(type, action) {
  const entry = COMPILED.get(type);
  if (!entry) return null;
  return entry.actions.get(action) || entry.base;
}

function payloadText(type) {
  const payload = PAYLOADS[type];
  const after = payload.after ? (payload.after.startsWith(',') ? payload.after : ` ${payload.after}`) : '';
  return `${payload.label || type} { ${payload.fields} }${after}`;
}

// The text of `data` in the tool, for the types that this agent can save.
export function saveDataText(types, { lead = 'Item payload: ' } = {}) {
  const texts = types.map(payloadText);
  const last = texts.pop();
  return `${lead}${texts.length ? `${texts.join(', ')}, or ` : ''}${last}.`;
}

// The names of a type that the tool text shows, for the tests that keep text and check together.
export function shownFields(type, action = null) {
  const key = payloadKey(type);
  const entry = COMPILED.get(key);
  if (!entry) return [];
  if (action !== null) {
    return [...(actionSpec(key, normalizeAction(action))?.shown || [])];
  }
  const names = new Set(entry.base.shown);
  for (const spec of entry.actions.values()) {
    for (const name of spec.shown) names.add(name);
  }
  return [...names];
}

// All actions whose data fields are checked for a type.
export function checkedActions(type) {
  const entry = COMPILED.get(payloadKey(type));
  return entry ? [...entry.actions.keys()] : [];
}

function collectUnknown(value, fields, path, found) {
  for (const [key, entry] of Object.entries(value)) {
    const field = fields.get(key);
    if (!field) {
      found.push({ path, key });
      continue;
    }
    if (!field.inner) continue;
    const items = field.list ? (Array.isArray(entry) ? entry : []) : [entry];
    items.forEach((item, n) => {
      if (isPlainObject(item)) collectUnknown(item, field.inner, `${path}${key}${field.list ? `[${n}]` : ''}.`, found);
    });
  }
}

function quoted(names) {
  return names.map((name) => `"${name}"`).join(', ');
}

function findOtherActionForKeys(type, currentAction, keys) {
  const entry = COMPILED.get(type);
  if (!entry) return null;
  for (const [otherAction, spec] of entry.actions.entries()) {
    if (otherAction === currentAction || !spec.text) continue;
    const matched = keys.filter((k) => spec.fields.has(k));
    if (matched.length > 0) return { action: otherAction, keys: matched };
  }
  return null;
}

function dreamModeConflict(data) {
  const modes = PAYLOADS.dream.modes;
  const used = [];
  for (const [mode, keys] of Object.entries(modes)) {
    if (keys.some((k) => data[k] !== undefined)) used.push(mode);
  }
  if (used.length <= 1) return null;
  return `Cannot mix dream ${used.join(' and ')} fields in one call, so nothing was saved. Send one dream operation per call (${Object.keys(modes).join(', ')}).`;
}

// Null when Loop keeps every name in `data`. Otherwise the sentence for the agent: which names Loop
// would drop, that the call did nothing, and the names that the place takes.
export function unknownSaveFields(rawType, data, action = 'save') {
  const type = payloadKey(rawType);
  const payload = PAYLOADS[type];
  if (!payload || payload.ownCheck || !isPlainObject(data)) return null;
  const effAction = normalizeAction(action);
  const spec = actionSpec(type, effAction);
  if (!spec) return null;

  const found = [];
  collectUnknown(data, spec.fields, '', found);
  if (found.length === 0) {
    if (type === 'dream' && effAction === 'save') return dreamModeConflict(data);
    return null;
  }

  const noun = NOUN[type] || type;
  const nothing = effAction === 'save' ? 'nothing was saved' : 'nothing was done';
  const top = found.filter((f) => f.path === '').map((f) => f.key);
  const lines = [];
  if (top.length > 0) {
    if (!spec.text) {
      lines.push(`Loop does not keep ${quoted(top)} for ${noun} action "${effAction}", so ${nothing}. Pass id or ids instead of data.`);
    } else {
      const other = findOtherActionForKeys(type, effAction, top);
      const actionNote = other ? ` Use action "${other.action}" for ${quoted(other.keys)}.` : '';
      const scopeLabel = effAction === 'save' ? `a ${noun}` : `${noun} action "${effAction}"`;
      lines.push(`Loop does not keep ${quoted(top)} for ${scopeLabel}, so ${nothing}.${actionNote} data takes { ${spec.text} }.${effAction === 'save' && payload.extra ? ` Put other details in ${payload.extra}.` : ''}`);
    }
  }
  // One sentence for each nested place, with the shape of that place.
  const nested = new Map();
  for (const f of found.filter((f) => f.path !== '')) nested.set(f.path, [...(nested.get(f.path) || []), f.key]);
  for (const [path, keys] of nested) {
    const place = path.slice(0, -1);
    const field = place.replace(/\[\d+\]/g, '').split('.').reduce((at, name) => at?.inner?.get(name) || at?.get?.(name), spec.fields);
    lines.push(`Loop does not keep ${quoted(keys)} in data.${place}, so ${nothing}. It takes ${field?.shape || 'other fields'}.`);
  }
  return lines.join(' ');
}
