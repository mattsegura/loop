---
name: "dream"
description: "Use when the user asks to review and tidy saved memories. Propose merges and corrections before applying them."
---

# Dream — Safe Memory Consolidation & Hygiene

Use this skill when the user asks to **dream**, **tidy**, **consolidate**, or **clean up** their Loop Memory, or when you notice duplicate, contradictory, or stale memories while working.

## Core Safety Rules (Non-Negotiable)

1. **Proposal-only, never silent rewrites:** Never silently overwrite or delete the user's memories in place. Present a clear, reviewable proposal batch and wait for explicit approval before applying changes via `loop__save`.
2. **One audience / project at a time:** Never merge memories from different projects, and never promote a private/project-scoped memory into `global` or a wider audience automatically. Every merged proposal takes the **narrowest audience** of its inputs.
3. **Preserve provenance & verbatim facts:** Every proposed merge or synthesis MUST cite the exact source memory IDs (`mem_...`) and preserve exact names, numbers, dates, and URLs verbatim—never paraphrase away specifics.
4. **Never pin, never edit imports, never store secrets:**
   - Do not auto-pin synthesized memories (pinning loads into every turn-1 context and requires explicit owner choice).
   - Leave imported/external read-only memories unchanged. Report stale external rows to their owner; do not create local substitutes.
   - Never save API keys, passwords, tokens, or payment info in Memory—those belong in Loop Vault (`{{vault:KEY}}`).
5. **Supersede over delete:** Prefer updating/marking superseded memories over permanent deletion unless the user explicitly asks to delete.

## Step 1 — Inspect Sleep-Time Proposals & Current Audience

1. First check Loop Core's built-in sleep-time queue and Context Doctor (for workspace-wide agents):
   ```json
   loop__inspect({ "type": "dream" })
   loop__inspect({ "type": "doctor" })
   ```
   Review any queued `pendingProposals` with the user before approving (`loop__save({ "type": "dream", "data": { "approveProposalId": "<id>" } })`) or dismissing (`dismissProposalId`).
2. Fetch the visible memories. Page through results, then partition by exact audience before proposing changes: an owner in a Project can also see global rows. An external result is not a writable local memory ID.
   ```json
   loop__search({ "type": "memory", "query": "" })
   ```
3. Inspect candidate clusters in batches (up to 20 at a time) using `loop__inspect({ type: "memory", ids: [...] })` so you have exact text, scope, tags, links, Projects, and `writtenBy`.

## Step 2 — Identify High-Signal Consolidation Proposals

Look strictly for four things (skip anything ambiguous or still actively changing):
- **Exact / near duplicates:** Same fact or preference saved twice by different agents (e.g. iMessage and Claude Code).
- **Contradictions:** Two memories that disagree (e.g. old vs. new preference or stack choice) — keep the newer owner-confirmed truth and mark the older one superseded.
- **Fragmented facts:** 3+ tiny scattered notes on the same project/person that are cleaner as one well-structured note citing the source IDs.
- **Stale / noisy scratch notes:** Temporary checks or completed one-off reminders that no longer help future sessions.

## Step 3 — Present a Compact Reviewable Diff

Show the user a short, numbered proposal list before touching anything:
- **Merge** `mem_a` + `mem_b` → `"<exact proposed text>"` *(project: `<narrowest>`, cites `mem_a`, `mem_b`)*
- **Resolve conflict** `mem_c` vs `mem_d` → keep `mem_d` (newer), supersede `mem_c`
- **Flag for owner review** `mem_e` *(reason: one-off test note; do not substitute delete for archive)*

Ask: *"Apply all, pick specific numbers, or skip?"*

## Step 4 — Apply Only Approved Changes

Once the user confirms, apply each approved change cleanly with `loop__save({ type: "memory", ... })` (handling any `approval_required` response by giving the user the `approveUrl`). Use one source ID per supersession. If a source is pinned, explain that retaining its startup pin is a separate choice. Do not pass `pinned:true` unless the owner explicitly chooses it. Read back the keeper and each affected source before reporting; report any partial merge.

## Everyday Memory Hygiene (Between Dreams)

- **Recall before asking:** Search Loop Memory (`loop__search({ type: "memory", query })`) before asking the user for preferences, stack details, or facts they may have told another agent.
- **Save durable signal, skip noise:** Save lasting preferences, project facts, and key people in Memory; save reusable multi-step procedures as Skills via `learn-workflow`; skip ephemeral chat chatter.
