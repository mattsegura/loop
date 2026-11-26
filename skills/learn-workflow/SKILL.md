---
name: "learn-workflow"
description: "Use when the user wants to turn a successful procedure or correction into a reusable Loop skill."
---

# Learn Workflow — Self-Evolving Loop Skills

Use this skill whenever:
- The user corrects how you did something and wants it done that way going forward,
- You finish a tricky multi-step workflow (API, tool sequence, formatting, or domain process) that the user is likely to ask for again, or
- The user explicitly asks you to *"learn this"*, *"save this workflow"*, or *"make a skill for this"*.

## Rules

1. **Check before creating:** Always search Loop Skills first (`loop__search({ type: "skills", query })`). If a matching user skill already exists, **update it** instead of creating a duplicate.
2. **Ask before saving** (unless the user explicitly asked you to save it): Offer a 1-line confirmation (*"Want me to save this as a reusable Loop Skill so all your agents follow it?"*).
3. **Never embed secrets:** Reference credentials via `{{vault:KEY}}` placeholders, never raw tokens or keys.
4. **Keep skills crisp & executable:** A great skill has:
   - A clear `description` stating *when* an agent should trigger it.
   - Short numbered steps referencing exact Loop Connections/tools (`<connection>__<tool>`) or concrete checks.
   - Key gotchas / edge cases learned from the real run (not generic advice).

## Save or Update via `loop__save`

```json
loop__save({
  "type": "skill",
  "id": "<kebab-case-slug>",
  "category": "<best-category>",
  "data": {
    "name": "<kebab-case-slug>",
    "description": "<1-2 sentences on what it does and when to use it>",
    "content": "<concise markdown instructions>"
  }
})
```

After saving, inspect the returned skill ID and check the stored instructions in the intended project. Report what you verified. Do not claim another agent can read the skill unless you check its grants with `loop__inspect({ type: "agent", id })`.
