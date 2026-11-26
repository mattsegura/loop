#!/usr/bin/env node
// npm run hooks -- install | uninstall | status [--agent claude-code|codex|gemini] [--no-skill] [--turn-recall|--no-turn-recall]
// install also links Loop's `loop` skill into each agent's skills folder; --no-skill leaves skills alone.
import { agentHookStatus, installAgentHooks, turnRecallCapability, uninstallAgentHooks } from '../lib/agent-hooks.mjs';

const [action = 'status', ...rest] = process.argv.slice(2);
const flag = (name) => {
  const at = rest.indexOf(name);
  return at !== -1 ? rest[at + 1] : undefined;
};
const opts = {};
if (flag('--agent')) opts.agents = [flag('--agent')];
if (rest.includes('--no-skill')) opts.skill = false;

if (rest.includes('--turn-recall') || rest.includes('--no-turn-recall')) {
  if (opts.agents && !turnRecallCapability(opts.agents[0]).supported) {
    throw new Error(`Turn recall is not supported for "${opts.agents[0]}". Supported agents: claude-code, codex, gemini.`);
  }
  opts.includeRecallOnly = true;
  opts.turnRecall = !rest.includes('--no-turn-recall');
}

const SKILL_NOTES = {
  created: 'skill linked',
  repaired: 'skill link repaired',
  linked: 'skill already linked',
  removed: 'skill link removed',
  kept: 'skill path left alone (something else is there)',
  error: 'skill link failed',
};
const skillNote = (r) => (SKILL_NOTES[r.skill] ? `; ${SKILL_NOTES[r.skill]}${r.skill === 'error' && r.skillReason ? `: ${r.skillReason}` : ''}  ${r.skillPath}` : '');

if (action === 'install' || action === 'uninstall') {
  const results = await (action === 'install' ? installAgentHooks(opts) : uninstallAgentHooks(opts));
  for (const r of results) console.log(`${r.label}: ${r.status}${r.reason ? ` (${r.reason})` : ''}  ${r.file}${skillNote(r)}`);
  if (action === 'install' && results.some((r) => r.id === 'codex' && r.status === 'updated')) {
    console.log('Codex asks you to review new hooks the next time it starts. Approve the Loop hook there.');
  }
  process.exit(results.some((r) => r.status === 'error') ? 1 : 0);
} else if (action === 'status') {
  for (const s of await agentHookStatus({ ...opts, includeRecallOnly: true })) {
    const state = s.error ? `error (${s.error})` : !s.agentInstalled ? 'agent not installed' : s.installed ? 'installed' : 'not installed';
    const skill = !s.agentInstalled || !s.skillPath ? '' : s.skill === 'linked' ? '; skill linked' : s.skill === 'other' ? '; skill path holds something else' : s.skill === 'broken' ? '; skill link is broken' : '; skill not linked';
    console.log(`${s.label}: ${state}  ${s.file}${skill}${s.turnRecall ? `; turn recall enabled (${s.recallMode})` : ''}`);
  }
} else {
  console.error('Usage: agent-hooks.mjs install | uninstall | status [--agent claude-code|codex|gemini] [--no-skill] [--turn-recall|--no-turn-recall]');
  process.exit(1);
}
