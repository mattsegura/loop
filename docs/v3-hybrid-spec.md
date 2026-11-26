# Loop v3 hybrid: build spec (Nov 24, 2026)

Builders A (backend core), B (integrations), C (frontend) each own the files listed. Do not edit files owned by another builder. If you need a change there, write it under "Requests for other builders" in your final report.

## Words
- Service: what Loop can reach (Gmail). Derived, not stored: `serviceKeyOf(conn)`.
- Account: one connection record. A service with two connections has two accounts.
- Access set: a named list an agent may use. Built-ins `everything`, `read-only`; owner-made custom sets.
- Agent, Person, Brain, Vault: unchanged.

## Data (owner: A)
Connection, new editable fields (store add/patch/normalize, connection-admission ALLOWED_WRITE_FIELDS, hosted CONNECTION_FIELDS):
- `accountLabel` string, max 60, trimmed, control chars stripped. Default empty (UI falls back to account email/name).
- `agentNote` string, max 280. Shown to agents with the connection in search and inspect, labeled as owner note (data, not instructions).
Connection, new transports (accepted by store and admission; hosted requires https): `openapi`, `graphql` with fields `specUrl` (openapi), `url` (endpoint/base URL), `authHeader` (optional header name), `authValue` (string that may contain `{{vault:KEY}}`; never a raw secret in hosted mode: reject values without a vault placeholder when they look like secrets). Execution belongs to B.

`serviceKeyOf(conn)` (lib/services.mjs, A): builtin -> `builtin:<id>`; http/sse/openapi/graphql -> lowercase host + pathname without trailing slash (no query); stdio -> `local:<basename of command>`. `serviceNameOf(conn, catalog?)`: catalog name when the key matches a catalog entry URL, else conn.name.

Agent, new fields (normalizeAgent, updateAgent, PATCH /api/agents/:id):
- `accessSet`: string id or null. null = current behavior (unchanged for existing agents).
- `approvalMode`: `ask` | `allow` | `guard` | null. null = unchanged. New agents created through OAuth consent default to `ask`.
- `accountChoice`: object `{ [serviceKey]: connectionId }`.

Access sets stored in workspace settings `accessSets`: `[{ id, name, connections: { [connectionId]: string[] /* tool names */ }, skills: string[] }]`. Ids: lowercase slug, unique, not `everything`/`read-only`.

## Enforcement (A, in resolveAccess / connectionAllowedForAccess / skillAllowedForAccess / run-time tool checks; search, inspect and run must agree)
- `everything`: no extra limit.
- `read-only`: a tool is allowed only if `toolKindOf(tool.annotations) === 'read'`. Unmarked tools are not reads. Skills allowed. `canManage` treated as false. Never grows to writes.
- custom set: connection allowed only if listed; tool allowed only if its name is listed for that connection (fixed list: tools added upstream later are not allowed until the owner adds them); skills allowed only if listed.
- Always intersect with existing limits (profile, allowedConnections, allowedSkills). Strictest wins.
- `accountChoice`: for each service key in it, every other connection with the same service key is not allowed for that agent.
- `approvalMode` applies to tools whose kind is write, destructive or unmarked: `ask` -> always_ask, `guard` -> guard, `allow` -> no extra rule. Combine with existing policies, stricter wins. Payment Vault items keep their own rule.
- A blocked call returns a clear error naming the set ("Stopped: the Research set allows reads only") and is recorded in Activity with outcome `blocked`.

## HTTP API
A:
- GET /api/access-sets -> `{ sets: [{ id, name, builtin, kind: 'all'|'read_only'|'custom', connections, skills, agents: [{id, name}] }] }`
- POST /api/access-sets `{ name, connections, skills }` -> `{ set }`; PATCH /api/access-sets/:id (same fields); DELETE /api/access-sets/:id -> 409 `{ error, agents }` while agents use it.
- GET /api/services -> `{ services: [{ key, name, accounts: [{ connectionId, label, note, status, ready, enabled }], tools: [{ name, description, kind }], agents: [{ id, name, accessSet, connectionId }] }] }` (tools from the first ready account; kind from toolKindOf).
- PATCH /api/agents/:id accepts `accessSet`, `approvalMode`, `accountChoice` (validate ids exist).
- OAuth consent: the request payload the consent UI loads adds `accessSets` (as GET /api/access-sets) and `services` (key, name, accounts with >1 account only). POST /api/oauth/requests/:tx/approve accepts `accessSet`, `approvalMode` (default `ask`), `accountChoice`; the issued agent gets them.
- GET /api/setup/status -> `{ agents: [{ id, name, kind, createdAt, lastSeenAt }], firstCall: { at, agentName, target, ms, ok } | null, connections: number }`. firstCall = newest activity entry with method tools/call (or run) since `?since=<iso>`.
- Activity: retention 30 days by time (cap 20,000 entries). Entries add `connectionId`, `account` (accountLabel), `tool`, `toolKind`, `outcome` (`ok`|`error`|`blocked`|`waiting`), `vaultKey` for vault use. GET /api/activity adds `?filter=agents|people|vault|approvals|stopped` and `?before=<iso>`.
B:
- GET /api/catalog -> `{ items: [{ id, name, logo, description, url, auth: 'oauth'|'key'|'google', available: boolean, reason?, parts? }] }`. Only services whose OAuth metadata was checked. Google item has `parts: [{ id, label, kind: 'read'|'write', scopes, product }]`; `available:false, reason` when GOOGLE_OAUTH_CLIENT_ID/SECRET are not set.
- POST /api/catalog/:id/add `{ accountLabel?, parts? }` -> `{ connection(s), signIn: { url } | null }` (reuses existing upstream OAuth start).
- POST /api/mcps/import-api `{ kind: 'openapi'|'graphql', url, name?, authHeader?, authValue? }` -> `{ connection }` with generated tools (openapi: one tool per operation, GET/HEAD -> readOnlyHint true, DELETE -> destructiveHint true, others destructiveHint false; graphql: `graphql_query` (readOnlyHint) and `graphql_mutation` (destructiveHint false) with the schema summary in the description).
- People: POST /api/people/:personId/items/:itemId/check -> `{ ok, ms, tools, label }` (refreshes the tool list of that own-sign-in connection in the recipient's Loop; returns counts only, never data). Invited people get Loop Connect through the owner's free invites by default.
- B wires its routes through one exported handler in `lib/catalog-routes.mjs` called from server.mjs at one hook line.

## Frontend (C)
- `#setup`: three steps (agent with live detection via GET /api/setup/status every 2 s; accounts from GET /api/catalog with the Google parts picker; first prompt with firstCall detection). Opens for a workspace with no agents and no connections; Home's welcome banner links to it. "Signed in earlier" counts as connected.
- Home: Services grouped by service key ("2 accounts: Work, Personal"), agents show "<set name> · writes ask/allowed/guard".
- `#service/<key>`: accounts (inline edit label and note), tools with kind tags, who uses it, sharing default note.
- Settings tabs: Access (sets list + editor with tool switches), Activity (filters, 30 days), People (exists).
- Consent view and agent popup Access tab: set radio (Everything, Read-only, custom sets, Pick items = current toggles), approvals segmented (Ask me default for new), account choice per service with >1 account.
- People: SMS body `You've been invited to join ${owner}'s Loop. Tap to join: ${url}`; join page heading `You're invited to ${owner}'s Loop`; owner person view adds "Check it works" calling the People check route.
- Bring your own: in Add connection, an "API address" option posting to /api/mcps/import-api.
- Match the canvas: warm ground, serif headings, dotted rows, tint panels, no new colors.
