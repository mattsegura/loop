---
name: "find-capability"
description: "Use when a needed capability is missing from native tools and Loop. Find a suitable connection or skill and verify it fits."
---

# Find & Add a Missing Capability to Loop

Use this workflow whenever a task hits a capability wall — for example, built-in web fetch can't pull a YouTube transcript, a site requires a dedicated API, or the user needs a workflow that neither native tools nor Loop currently cover.

## Safety & Plain-Language Rules

- **Act directly when the user asked to connect an app:** If the user explicitly asks to connect an app (e.g. *"connect to my gmail"* or *"hook up notion"*), do NOT dump a menu of technical options or ask them to pick a vendor. Follow this order:
  1. **Check existing connections and connector hubs first** (`loop__search` with `type: "connections"`). If the user already has a direct connection for the app OR already has a multi-app connector hub connected (such as **Pipedream**, **Zapier**, or **Composio**), use that existing hub to connect the app instead of adding a new server.
  2. **Use a verified connector hub when no official instant-OAuth MCP exists:** For personal/workspace apps without a direct one-click OAuth MCP (such as Gmail, Google Calendar, Google Drive, Slack, HubSpot, etc.), pick a verified multi-app connector hub that works with Loop's instant one-click OAuth so one sign-in unlocks this app and future apps too:
     - **Composio** (default hub — 1,500+ apps, one-click OAuth): `https://connect.composio.dev/mcp`
     - **Pipedream** (alternative hub — 2,500+ apps, one-click OAuth): `https://mcp.pipedream.net/v2`
     - **Zapier** (alternative hub — thousands of apps, one-click OAuth): `https://mcp.zapier.com/api/v1/connect`
     Tell the user plainly which hub you are using (e.g. *"I'll connect your Gmail through Composio — tap here to sign in and connect it:\n`<signInUrl>`"*). Once connected, reuse that hub as their preferred connector for future app requests.
  3. **Never guess URLs from memory:** Never invent a vendor URL (such as `mcp.composio.dev/...`, `rube.app/mcp`, or `*.mcp.klavis.ai/mcp`) without verifying it via `loop_web__web_search` first. If you need a specific official vendor MCP (like Notion or Linear), search `loop_web__web_search` first to confirm its live URL, then call `loop__save`.
- **Instant sign-in or keep looking (self-healing fallback):** `loop__save` verifies reachability and instant OAuth before saving. If a URL is rejected (`reason: "unreachable"`, `"no_instant_oauth"`, `"oauth_incompatible"`, or `"requires_api_key"` — for example Google's raw MCP, which demands a manual Google Cloud app), **never bother the user with that error or ask them to create a developer/GCP app**. Fall back cleanly to a verified connector hub (`https://connect.composio.dev/mcp`, `https://mcp.pipedream.net/v2`, or `https://mcp.zapier.com/api/v1/connect`) and call `loop__save` on it instead.
- **One short, casual line to connect:** Once `loop__save` returns a verified `signInUrl`, reply in **one plain line** with `signInUrl` on its own line — e.g. *"I'll connect Gmail through Composio — tap here to sign in:\n`<signInUrl>`"*. **Never** list tool counts, capability summaries, internal phrases like *"load its tools"*, technical jargon (`MCP`, `stdio`, `http`, `sse`, `DCR`, `OAuth`), or guess which login screen (like Google) they will see.
- **Ask first only when unrequested or local:** If you're proposing an unrequested install, a paid third-party service, or a Local command, ask for a quick yes before saving.
- **Secrets belong in Vault:** Never hardcode raw API keys or tokens in arguments, headers, or skills; store them via Loop Vault (`{{vault:KEY}}`).

## Step 1 — Verify Loop Doesn't Already Have It

Before researching online, check Loop thoroughly:

1. Search across Connections and Skills:
   ```json
   loop__search({ "type": "all", "query": "<task keywords>" })
   ```
2. If a ready **catalog discovery tool** is available in Loop, search inside it first via `loop__run`:
   ```json
   loop__run({ "tool": "<catalog_discovery_tool>", "arguments": { "query": "<plain job description>" } })
   ```
3. If an existing Connection, Skill, or authorized catalog endpoint already solves the job, **use it right away** instead of installing anything new.

## Step 2 — Research the Best Option Online

If Loop genuinely lacks the capability, reach for Loop's built-in **`loop_web__web_search`** and **`loop_web__web_fetch`** tools (or any other enabled web search Connection in Loop) via `loop__run` to find 1–2 high-signal, trustworthy solutions in this priority order:

```json
loop__run({ "tool": "loop_web__web_search", "arguments": { "query": "<service> official MCP server OR API" } })
```

1. **Official Cloud Connection (preferred for SaaS/apps):** A vendor-hosted URL (especially one supporting OAuth sign-in) so you can add it via `loop__save`, hand the user the `signInUrl`, and finish the task cleanly on any device with zero local setup.
2. **Lightweight Skill (preferred when no server is needed):** A clean `SKILL.md` workflow using a public endpoint, an existing local CLI, or an existing Connection. Zero extra processes.
3. **Trusted Local Connection:** An official or widely used package (`npx` / `uvx`) from a reputable source with clear maintenance and minimal required permissions.

Verify for each option (fetching the official docs page with `loop_web__web_fetch` when needed):
- Exact source/maintainer (prefer official vendor or well-known open-source repo)
- Type (`Cloud` Connection, `Skill`, or `Local` Connection)
- Requirements (free, OAuth sign-in, or API key)

## Step 3 — Consent Rule (Direct Connect vs. Propose First)

- **Explicit free Cloud app request:** When the user explicitly asked to connect a free Cloud app, skip the menu and go straight to Step 4 (`loop__save`), then send the returned `signInUrl` (or proceed immediately if already ready).
- **Unrequested install, paid service, or Local command:** Present 1–2 concise options and wait for the user's explicit **yes** before saving:

> *"Loop doesn’t have a tool for `<task>` yet. I found:*
> *1. **`<Name>`** (`Cloud` / `Skill` / `Local`) — `<what it does, auth/cost, source>`.*
> *2. *(optional second choice)*
>
> *Want me to add Option 1 to your Loop, and then finish `<original request>`?"*

- **Manual browser actions are strictly a last resort:** Only fall back to driving a browser or manual UI clicks when no official Cloud Connection, public API, or lightweight Skill exists.

## Step 4 — Save to Loop, Sync, and Finish the Original Task

Once the user approves (if you do not have `loop__save` for this type, this agent may not add it: give the user the link from Loop's instructions that allows it, or let them add the option in Loop):

1. **For a Skill:** Save with a clear `description` (including when agents should reach for it) and concise `content`:
   ```json
   loop__save({
     "type": "skill",
     "id": "<slug>",
     "category": "<best-category>",
     "data": {
       "name": "<slug>",
       "description": "<clear trigger description>",
       "content": "<markdown instructions>"
     }
   })
   ```
2. **For a Connection:** Save with a plain-English 1-line `description` and `category`:
   ```json
   loop__save({
     "type": "connection",
     "category": "<best-category>",
     "data": {
       "name": "<Name>",
       "description": "<5-14 word plain-English summary>",
       "url": "<https://...>"
     }
   })
   ```
   *(For a Local Connection, pass `command`, `args`, and optional `env` using `{{vault:KEY}}` for any secrets.)*
3. **Handle approvals & sign-in cleanly:**
   - If `loop__save` returns `status: "approval_required"`, direct the user to approve the action in the Loop dashboard (using the approval URL returned by Loop, if provided) and then re-call `loop__save` with the returned `approvalId`.
   - If the new Cloud Connection needs OAuth sign-in, give the user the `signInUrl` returned by Loop (or direct them to click **Sign in** on the Connections page of the Loop dashboard), then run `loop__save({ type: "connection", action: "sync", id })`.
4. **Finish the original task immediately** using the newly added Connection or Skill so the user gets their real answer right away — and from now on, every agent connected to Loop inherits it automatically.
