---
name: "setup-project"
description: "Use when the user wants to create a Project, choose its favorite tools, or share restricted access."
---

# Set Up & Share a Loop Project

Use this workflow whenever the user asks to create a Project (e.g. *"make a Work project"*, *"set up a Design project with Figma and Linear"*), set favorite tools for a Project, or share a Project with a teammate or limited agent.

A Project is a named drawer that puts its Items first and sets where new Items go; opening a Project never limits the Owner's Access. For a personal Project, search existing Projects first (`loop__search({ "type": "projects" })`), create it if needed, and enter it (`loop__save({ "type": "project", "action": "enter", "id": "<slug>" })`) when requested. Do not generate a Share link unless the user asks for shared or limited access.

## Safety & Plain-Language Rules

- **Never share `all`:** Only named Projects can be shared or invited.
- **Plain language:** Say **Project**, **Connections**, **Skills**, **Local**, and **Cloud** (never `MCPs`, `stdio`, `http`, or `sse`).
- **Ask before copying to clipboard:** On local devices, only pass `copyToClipboard: true` if the user asks to copy the link.
- **Verify allowed items before sharing:** Inspect the final Connections and Skills placed in the Project before sending a Share link, and pass `createIfMissing: false` when updating an existing Project.

## Step 1 — Inspect Existing Projects, Connections & Skills

Check what already exists so you don't duplicate Projects or miss matching Skills:

```json
loop__search({ "type": "projects" })
loop__search({ "type": "all" })
```

## Step 2 — Build & Preview the Project Layout

Draft a concise Markdown summary showing the proposed Project before applying changes (unless the user gave an exact list and asked you to do it right away):

```markdown
### Project: <Name> (`<slug>`)
- **Connections:** <Connection A>, <Connection B>
- **Skills:** <Skill 1>, <Skill 2>
```

Confirm with the user if anything is ambiguous (e.g. whether to include related Skills or a specific account when multiple exist).

## Step 3 — Create/Update Project & Place Items

1. **Create or update the Project:**
   ```json
   loop__save({
     "type": "project",
     "id": "<slug>",
     "data": {
       "name": "<Display Name>",
       "description": "<short purpose>"
     }
   })
   ```
2. **Place Connections, favorite tools, and Skills** in the Project:
   ```json
   loop__save({
     "type": "project",
     "action": "add_tools",
     "id": "<slug>",
     "data": { "connections": ["<connection_id>"], "tools": [{ "connectionId": "<connection_id>", "toolName": "<tool>" }] }
   })
   ```
   Skills: `loop__save({ "type": "skill", "id": "<skill_id>", "data": { "projects": [...] } })`, preserving the Skill's existing Projects plus `<slug>`. Stop here if the user only asked to create or organize a personal Project.

## Step 4 — Generate & Send a Share Link (Only When Requested)

Create the Share link for the named Project:

```json
loop__save({
  "type": "project",
  "action": "invite",
  "id": "<slug>",
  "data": {
    "name": "<Display Name>",
    "kind": "other",
    "createIfMissing": false
  }
})
```

*(Use `"kind": "me"` for another one of the user's own agents/devices, or `"kind": "other"` when sharing with a Guest.)*

Present the returned `inviteUrl` cleanly in 1–2 lines, follow its `displayHint`, and confirm the verified Connections and Skills included in the Project.
