# Audit checks

Pass/fail checks for the 20 high-severity findings of the audit from 2026-11-20. Each one replays the attack against this checkout and reports whether it still works.

    npm run test:audit

It takes under a minute and is not part of `npm test`. Run it through npm: a bare `node --test` would also start every probe file as if it were a test.

Everything runs in a throw-away home and data folder on random ports. Your real Loop data, your agents' config files and the Loop service on port 8799 are not touched.

## Reading the result

`known-open.json` is the list of findings that are not fixed yet. The run is green when the code matches that list.

| What the probe finds | Listed in `known-open.json` | Result |
|---|---|---|
| still reproduces | yes | pass |
| no longer reproduces | yes | **fail**: delete the line to record the fix |
| no longer reproduces | no | pass |
| reproduces | no | **fail**: a closed finding is back |
| could not tell (probe crashed, timed out, or the scenario stopped early) | either | **fail** |

The run ends with a table of all 20 and where each one stands.

## Closing a finding

1. Fix the code.
2. Run `npm run test:audit`. The finding's test fails with "no longer reproduces".
3. Delete its line from `known-open.json` and run again. Commit the fix and that deletion together.

If a fix makes Loop refuse an earlier step of the scenario, the test reports "could not be judged". Update the probe, or its check in `highs.test.mjs`, so that it asserts the refusal. Do not add a line to `known-open.json` to get a green run.

## What is here

- `highs.test.mjs`: one check per finding, with the conditions for "still reproduces" written out.
- `probes/`: the audit's attack scripts. Run one alone with, for example, `node test/audit/probes/G2/p9-redos.mjs`.
- `harness.mjs`: starts Loop in a sandbox for the probes. If `startServer` changes how hosted and Mac modes are chosen, update `startMulti` here to start the hosted one.
  Its mock tools carry a safety label (MCP annotations) unless a probe sets its own. Loop asks the owner before running a tool with no label, and these scenarios are about what happens once a call runs; a hostile server would label its tools the same way to avoid the question.
- `probes/G7/live-app-fns.mjs`: runs functions taken from `public/app.js`, so the two dashboard checks follow the real code.

## Limits

- Covers the 20 high-severity regression scenarios from the 2026-11-20 security audit.
- Two checks (G2-07, G5-01) measure time and run alone at the end. On a very busy machine they can report "could not be judged"; run again.
- The two dashboard checks (G7-01, G7-02) read the text the code produces. They cannot see CSS, so text that is hidden or scrolled out of view still counts as shown. G7-01 also looks for wording that marks an app's name as unverified; the accepted phrases are listed in `probes/G7/p6-consent-sse.mjs`.
