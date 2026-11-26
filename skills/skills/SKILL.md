---
name: "skills"
description: "Find and use a saved playbook, or turn a repeatable workflow into a skill."
---

# Skills

Search `loop__search({ type: "skills", query: "<job>" })` before writing new instructions. Read the matching playbook in the result; if only a summary appears, call `loop__inspect({ type: "skill", id: "<returned ID>" })`. A skill describes a procedure. It does not give the agent access to tools, accounts, projects, or secrets.

When asked to save a workflow, look for an existing user skill to update. Leave bundled System guides unchanged. Capture when to use the workflow, the inputs it needs, its verified steps, and a small check for success. Omit chat history, one-off outputs, credentials, and machine-specific paths.

Save the user skill with `loop__save({ type: "skill", id: "<slug>", data: { name: "<name>", description: "<when to use it>", content: "<instructions>" } })`. Inspect the saved ID and confirm the instructions are readable in the intended project. Don't promise access to other agents without checking their grants via `loop__inspect({ type: "agent", id })`.
