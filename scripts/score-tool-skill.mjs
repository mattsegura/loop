// Score tool contract probes independently from a replay of the workflow with known-good tools.
// expectedOutput/actualOutput are normalized by the fixture (omit timestamps etc.).
import { isDeepStrictEqual as equal } from 'node:util';
export function scoreLayers({toolProbes, workflow, outcome}) {
  const tool = toolProbes.map(({id, expectedOutput, actualOutput}) => ({id, pass: expectedOutput !== undefined && equal(actualOutput, expectedOutput)}));
  const skill = workflow == null ? null : workflow.requiredChecks.map(id => ({id, pass: workflow.observedChecks[id] === true}));
  return {tool, skill, outcome: outcome.expected !== undefined && equal(outcome.observed, outcome.expected)};
}
