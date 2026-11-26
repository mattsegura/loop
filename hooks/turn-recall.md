# Optional turn-by-turn recall

Turn-by-turn recall automatically injects up to **3 relevant local memories** as untrusted reference data on each message without sending raw prompts to Loop.

## How to enable

Turn it on per agent from the **Agents** tab in Loop (**Auto-recall: On**), or from the command line:

```
npm run hooks -- install --turn-recall --agent claude-code
npm run hooks -- install --turn-recall --agent codex
npm run hooks -- install --turn-recall --agent gemini
```

No server restart or `LOOP_TURN_RECALL=1` environment variable is required when toggled from Loop (though `LOOP_TURN_RECALL=1` still works as a fallback default).

## Supported capability tiers

- **Claude Code (`mcp_pair`):** Installs a paired `UserPromptSubmit` command + `loop__turn_recall` MCP hook. Only session/prompt UUIDs cross MCP; salted word hashes pass over a short-lived owner-only Unix socket.
- **Codex (`UserPromptSubmit`) & Gemini CLI (`BeforeAgent`):** Installs one local command hook (`turn-recall`). It hashes up to 48 stemmed key words locally and sends only `{ salt, keys, cwd, sessionId }` to `/api/turn-recall` using a dedicated read-only recall token stored in an owner-only (`0600`) file under Loop's data folder (never inside `hooks.json` or `settings.json`).
- **Other clients (Cursor, Claude Desktop, Zed, etc.):** Continue using startup pins and on-demand `loop__search({ type: "memory", query })`.

## Project scoping & ranking

- **Owner workspace-wide agent, inside a project:** Strongly favors the active project (resolved from the live MCP session or matched working directory), then global notes, then only strong matches from other projects (each labeled with its project).
- **Owner workspace-wide agent, no project selected:** Still recalls up to 3 relevant global and project notes, each labeled with its project or `[global]`.
- **Fixed-scope / invited agent:** Strictly locked to its granted project only.

## Privacy & limits

- Raw prompt text never leaves the local hook process and is never logged.
- Prompts over 8,192 characters, subagent events, external/off memory modes, paused workspaces, and agents without memory read access return no facts.
- Returns at most 3 distinct excerpts (300 chars each, 1,152 UTF-8 bytes total), deduplicated across recent turns in the same session.
