---
name: "fix-connection"
description: "Use when a Loop connection cannot sign in, stops responding, or no longer lists an expected tool."
---

# Fix & Self-Heal a Loop Connection

Use this workflow whenever a Connection stops working, returns a 401/error, is missing a tool you need, or the user says *"my Gmail/Figma/Linear/Slack isn't working."*

## Safety & Plain-Language Rules

- **Never ask for raw API keys, tokens, or passwords in chat:** Always send the user Loop's `signInUrl` or `updateKeyUrl` so credentials go straight into Loop Vault.
- **Plain language:** Say **Connections**, **Skills**, **Local**, and **Cloud** (never `MCPs`, `stdio`, `http`, or `sse`).
- **Finish the original job:** Once the Connection is healed (or replaced), immediately retry and complete the user's original request.

## Step 1 — Diagnose the Connection

Inspect the Connection's live state before guessing:

```json
loop__search({ "type": "connections", "query": "<app name>" })
```

If you need full error details, auth state, or enabled tools, inspect it directly:

```json
loop__inspect({ "type": "connection", "id": "<connection_id>" })
```

Check which failure mode applies:

1. **Needs sign-in (`authRequired: true` with `signInUrl`):** OAuth session expired or wasn't completed.
2. **Token rejected (`updateKeyUrl` present):** Saved API key/token was revoked or refused.
3. **Stale or missing tools:** Connection is ready, but its tool list is outdated or missing the capability needed.
4. **Disabled or outside this agent's Access:** Connection is turned `Off`, or this session does not have Access to it (`loop__search({ "type": "projects" })`). Note: an unsuccessful scoped lookup cannot distinguish `Off` from out-of-scope — say honestly that it is not visible from this session.
5. **Upstream outage / broken endpoint:** Repeated network or server errors even after sync.

## Step 2 — Self-Heal by Root Cause

### A. Needs Sign-In (OAuth)
1. Give the user the `signInUrl` in 1–2 short lines (if no link is returned, tell them to open Loop Connections and reconnect it; never fabricate a link).
2. If this agent has manage permission, wait with a bounded check:
   ```json
   loop__save({
     "type": "connection",
     "action": "sync",
     "id": "<connection_id>",
     "data": { "waitForSignIn": true }
   })
   ```
3. `waitForSignIn` is bounded: if it times out (`synced: false`, `signedIn: false`), do **not** retry the original action yet — ask the user to confirm once they finish sign-in. Once synced, verify with a small read and retry the original action.

### B. Token / API Key Rejected
1. Tell the user the saved key was refused and give them the `updateKeyUrl` to paste a fresh key safely in Loop (never ask them to paste it in chat).
2. Wait with `waitForSignIn: true` the same way, then retry only after confirmed recovery.

### C. Missing or Outdated Tools (Self-Configure)
1. First re-sync the Connection to pull fresh tools:
   ```json
   loop__save({ "type": "connection", "action": "sync", "id": "<connection_id>" })
   ```
2. Search again (`loop__search({ "type": "tools", "connection": "<connection_id>", "query": "<job>" })`).
3. If the Connection **still** lacks the tool (or is deprecated/broken):
   - Research a better official Cloud Connection or lightweight Skill via `loop_web__web_search` (following `find-capability`).
   - Offer clearly in plain language:
     > *"Hey, `<App>` doesn't currently have a tool for `<job>`. I found `<Option>` — I can install it for you to get this done. Want me to add it?"*
   - Once approved, install via `loop__save`, complete sign-in if needed, and finish the task.

### D. Disabled or Outside This Agent's Access
- State honestly when a Connection is turned off or not visible from this session, and offer to enable it or ask the Owner to grant Access in Loop.

## Step 3 — Self-Improve Your Skills

If you discovered a recurring quirk, required parameter, or reliable workaround while fixing the app:
1. Check if a user Skill already exists for that app (`loop__search({ type: "skills", query: "<app>" })`).
2. Offer (or apply, if the user asked you to remember it) a quick update via `loop__save({ type: "skill", ... })` (following `learn-workflow`) so every connected agent self-heals faster next time.
