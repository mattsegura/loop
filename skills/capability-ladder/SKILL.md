---
name: "capability-ladder"
description: "Use when a task is blocked and you need to choose between native tools, Loop connections, existing skills, or finding a new capability."
---

# Capability Ladder — Right Tool, Right Order

For local files, code edits, and local shell work, use your native built-in tools first. Whenever a user asks you to connect an app, access external accounts, fetch live data, or use shared skills/memory, follow this order:

1. **Existing Loop Connections & Skills (fastest, safest):**
   - Check `loop__search({ "type": "all", "query": "<task>" })` and verify readiness and fit (`ambiguous`, `lowConfidence`, `noGoodMatch`). If an authorized Connection or Skill clearly fits, use it directly.
2. **Built-in Loop Tools & Storage (zero external accounts required):**
   - For saving or searching links, notes, `json-render` cards, reminders/schedules, or files up to 10 MB, use `loop__save` / `loop__search` / `loop__inspect` with `type: "saved"`, `"schedule"`, or `"file"` directly — do not send the user to connect an external app for ordinary saves.
   - For public web info, docs, news, URLs, or RSS/Atom feeds, use `loop_web` (`web_search`, `web_fetch`, `web_feed`). For exact time/date math, safe arithmetic, or CSV/JSON queries, use `loop_utils`. To alert the owner when long work finishes, use `loop_notify__notify_owner`.
3. **Discover & Add a Cloud Connector or Skill (`find-capability`):**
   - If the user asks to connect an app (Google Drive, Gmail, Calendar, Notion, Dropbox, Linear, Slack, etc.) or needs capabilities beyond Loop's built-in limits (such as files over 10 MB, large videos/datasets, or live collaborative Docs/Sheets), offer to connect that app and inspect `find-capability` (`loop__inspect({ "type": "skill", "id": "find-capability" })`) to follow its exact consent and sign-in rules. Keep a pointer in `type: "saved"` when helpful so every agent can find the cloud item.
   - If the user asks you to "sign in for me" on a Loop OAuth `signInUrl`, state plainly in one short line that they must tap the link to authorize it, put the link on its own line, and never guess which provider screen appears.
4. **Host-Dependent Browser Automation (only when exposed by the current host):**
   - Only when no Loop Connection, public API, or Skill fits **and** the current host exposes secure browser/secret tools (`computer_use`, `request_info`, `type_secret`), open the site's login URL, request credentials through a secure one-time form (never in chat), enter placeholders with `type_secret`, verify with a read, and finish the task.
   - If the current host does not expose those tools, explain clearly that no connector exists yet and never ask the user to paste passwords or 2FA codes in chat.
