# Maintaining Loop's essential skills

Start with four entry guides. They own common decisions, not every procedure. A direct tool call needs no skill. Keep enforcement in code, not Markdown. Do not add a guide just because one search failed.

| Catalog ID | Availability | Job and acceptance case |
|---|---|---|
| `loop` | cloud | Entry: choose native, tool, or playbook. In a restricted project find an authorized capability without switching projects. |
| `connections` | cloud | Entry: use an existing connection or diagnose what's missing. Distinguish a disconnected account from an unavailable action. |
| `skills` | cloud | Entry: reuse, update, or create a verified procedure. Update a same-purpose user skill without duplicating it or widening access. |
| `vault` | cloud | Entry: capture or use credentials. A synthetic credential must not occur in transcripts, memory, or skill content. |
| `capability-ladder` | cloud | When blocked, try permitted existing routes; don't call a catalog result a completed task. |
| `find-capability` | cloud | Identify a missing capability; distinguish a candidate integration from one actually connected. |
| `fix-connection` | cloud | Recover an existing integration; recheck the original failed operation. |
| `learn-workflow` | cloud | Turn a verified recurring method into a user guide; preserve scope and verify the saved revision. |
| `setup-profile` | cloud | Assemble a restricted profile; a second identity cannot use an ungranted tool. |
| `dream` | cloud | Propose memory cleanup; an unapproved proposal must leave the originals unchanged. |
| `organize` | host | Categorize existing items without changing their access or losing their identities. |
| `sync-agents` | host | Import an existing agent setup; a second sync must not duplicate it or remove the only copy. |

Cloud rows are also available locally. The nested `skills/system/run-workflow` package is not a top-level SkillStore catalog entry. This table describes proposed responsibilities and acceptance cases, not claims that each behavior passes.

## Diagnose one failure before changing anything

Freeze the user request, model/version, skill revision, connection inventory, project/grants, starting records, and expected observable outcome. Save redacted traces of the actual queries, shortlist and ranks, loaded guide, tool calls/arguments/results, and final readback. Use synthetic data and reset state for each arm.

| Controlled replay | What the evidence means | Change first |
|---|---|---|
| Is the expected capability present, healthy and authorized? | Missing, down or denied is a readiness condition; a correct refusal is success. | Connection, fixture or grant; never widen scope to improve a score. |
| Call the tool directly with independently verified inputs and inspect the state. Can its schema express the operation at all? | No suitable primitive or unrepresentable input is a tool-design gap. Valid direct call with wrong state is a connector/implementation failure. | Tool contract or implementation, respectively. |
| Keep catalog and search fixed. Compare the original query with an independently written single-step query. | If only the latter works, suspect query formation/decomposition. If both fail, inspect eligibility/index first. Present but below cutoff indicates retrieval; inside shortlist but misordered indicates ranking. | Query, index, or ranker. Test fresh paraphrases before assigning cause. |
| Supply the same correct tools directly. Compare current guide, revised guide, and no guide on reset fixtures. | If only revised instructions fix the trace and outcome, change the skill. If the correct guide was never loaded, fix skill discovery. If all arms fail, do not assign blame to the guide. | Skill selection, guide, agent execution, or unresolved; record mixed causes. |
| Read final state independently, including unchanged bystanders. | A correct-looking answer or tool success receipt does not prove the user's outcome. | Verification or false claim if receipt and reality differ. |

## Release and upkeep

- Each guide gets one owner by responsibility: discovery, connections, knowledge, access, or host integrations. The contributor changing it owns its fixture and review. Add positive, paraphrase, neighboring wrong intent, missing prerequisite, and partial/failed execution cases; include ambiguity and wrong-target checks for writes.
- Use isolated fake upstreams and real Loop handlers. Derive scores from the trace and state, not prefilled booleans or exact prose. Permit alternative valid step sequences. Score tool contract, candidate recall/top choice, guide selection, workflow checks, final outcome, and forbidden side effects separately. Count direct-tool tasks as skill not applicable.
- On a change, run deterministic contract and catalog checks first. Then run blinded old/new/no-guide agent trials on the same fixtures and held-out prompts; repeat variable cases and publish per-case gains, regressions and denominators. Do not ship an unauthorized write, secret leak, false completion, or new wrong-target mutation. An inconclusive result is not a win.
- First behavioral fixtures: update an existing skill with limited sharing; distinguish a broken connection from a missing tool; resolve an ambiguous record before writing. Expand to the acceptance cases above before calling the catalog fully tested. Every reproduced incident becomes a redacted fixture. Merge or retire a specialist only after removing it does not harm held-out outcomes.
- Existing entry points: `test/skills.test.mjs`, `test/system-skills.test.mjs`, `test/dynamic-discovery.test.mjs`, and `scripts/eval-generalization.mjs`. `scripts/score-tool-skill.mjs` checks supplied observations; it is not itself an agent evaluation.
