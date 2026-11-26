---
name: "organize"
description: "Use when the user wants to categorize or reorganize connections and skills in Loop."
---

# Organize Loop Categories

Use this workflow whenever the user asks to organize, group, rename, or recategorize their Loop Connections and Skills.

## Safety & Language Rules

- Preview first. A request to see a possible layout authorizes a preview only — make zero metadata or connection writes before the user confirms. For a requested restructure, use Loop’s approval policy; do not ask for both a chat confirmation and a dashboard approval.
- **Plain language:** Always refer to **`Connections`**, **`Skills`**, **`Local`**, and **`Cloud`** (never `MCPs`, `stdio`, `http`, or `sse`).

## Step 1 — Read Current Connections, Skills, and Categories

Inspect only the inventory visible to this agent in the current project:

```json
loop__search({ "type": "all" })
```

Use the returned Connections, Skills, and categories. If a role is unclear, inspect the visible item with `loop__inspect({ type: "connection", id })` or `loop__inspect({ type: "skill", id })`. A displayed description may be generated from tool information; it does not tell you whether a stored description exists.

Discovery is read-only. Do not fill in descriptions, edit items, or submit approvals while preparing a preview. Even an approved category plan covers only its category changes. If the user separately requests a description edit, handle it as a distinct operation under its own policy and report its result separately.

## Step 2 — Design Clean, Workflow-Tailored Categories

Design a clear, human-friendly category structure around how the user actually works:

- Aim for **4–7 meaningful categories** — avoid dozens of tiny single-item buckets or leaving everything in `General`.
- Reuse built-in or existing categories when they fit well, and create custom categories (e.g., `Video & UGC`, `Trading`, `Client Ops`, `Personal`) whenever the user's real tools and skills cluster around a distinct workflow.
- Move only visible items within the requested scope. Assign each affected Connection (`assignConnections`: `{ "<connection_id>": "<category_id>" }`) and Skill (`assignSkills`: `{ "<skill_id>": "<category_id>" }`) to its clearest home.
- Only include `deleteCategories` when removing unused or merged custom categories.

## Step 3 — Preview First (`dryRun: true`)

Run a dry-run preview before saving anything:

```json
loop__save({
  "type": "category",
  "dryRun": true,
  "data": {
    "createCategories": [
      {
        "id": "video-ugc",
        "label": "Video & UGC",
        "description": "Video editing, ads, and creative production"
      }
    ],
    "assignConnections": {
      "example_connection": "video-ugc"
    },
    "assignSkills": {
      "example-skill": "video-ugc"
    }
  }
})
```

*(Include `"deleteCategories": [...]` inside `data` only if deleting obsolete custom categories.)*

## Review and apply

Use the returned before-and-after card (or its Markdown fallback) to show exactly what changes. For a preview-only request, stop here without submitting approval or making any other save. For a requested restructure, submit the same data with the preview’s plan ID:

```js
loop__save({ type: "category", dryRun: false, data: { ...proposedData, planId: preview.planId } })
```

Under the default approval policy, send the returned approval link; the Home card is the owner's decision. Follow the result's retry or wait instructions. Don't ask for a second yes in chat. A pending request is not an applied change. If the plan is stale or the user wants different moves, preview and submit the new plan. Only confirm changes after Loop reports them applied. Category moves do not grant tools or share credentials.
