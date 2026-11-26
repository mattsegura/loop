// Run in a dedicated process. Only the hardcoded synthetic inventory below is reachable.
import assert from 'node:assert/strict';
import { handleMcpRequest } from '../lib/mcp-server.mjs';
import { SearchIndex } from '../lib/search-index.mjs';

const rows = [
  ['bell', 'Ferry reference', 'Ferry timetables: explain how printed sailing schedules are designed.'],
  ['reed', 'Ferry desk', 'Ferry timetables: find the next passenger boat departure.'],
  ['opal', 'Audio studio', 'Audio recordings: remove microphone hiss from interviews.'],
  ['mint', 'Audio library', 'Audio recordings: tag and archive past interviews.'],
  ['hidden', 'Hidden sentinel', 'Ferry timetables: hidden private description.'],
];
const inventory = rows.map(([id, name, description]) => ({ id, name, description, content: 'BODY_SENTINEL', enabled: true, profile: 'all' }));
const cases = [
  ['ferry timetables: when can I leave?', 'reed'], ['ferry timetables: explain the layout', 'bell'],
  ['audio recordings: quiet the static', 'opal'], ['audio recordings: file these away', 'mint'],
  ['Ferry desk', 'reed'], ['reed', 'reed'], ['zygomorphic xylophone', null], ['Hidden sentinel', null],
];
const live = process.argv.includes('--live');
if (live && !process.env.TYPESAFE_API_KEY) throw Error('Set TYPESAFE_API_KEY for --live');
const transport = globalThis.fetch;
const index = new SearchIndex(null, { strategy: 'hybrid' });
const opts = { searchIndex: index, skillStore: { list: async () => inventory }, agent: { id: 'limited', profile: 'all', canManage: false, allowedConnections: [], allowedSkills: rows.slice(0, 4).map(r => r[0]) } };
let calls = 0, judgments = 0, successful = 0;
const payloads = [];
globalThis.fetch = async (url, init) => {
  calls++;
  assert.ok(calls <= 4 && live);
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  const { state, questions } = JSON.parse(init.body);
  payloads.push(state);
  assert.ok(cases.slice(0, 4).some(([q]) => q === state.request));
  for (const c of state.candidates) assert.ok(rows.slice(0, 4).some(([, n, d]) => n === c.name && d === c.description));
  judgments += Object.keys(questions).length;
  const response = await transport(url, init);
  if (response.ok) successful++;
  return response;
};
for (const candidate of [false, true]) {
  process.env.LOOP_JEV_SKILL_RERANK = candidate ? '1' : '0';
  process.env.LOOP_JEV_ALLOW_DISCOVERY_EGRESS = live ? '1' : '0';
  let correct = 0, applied = 0;
  for (const [i, [query, expected]] of cases.entries()) {
    const before = calls;
    const res = await handleMcpRequest({ list: async () => [] }, {}, {}, { jsonrpc: '2.0', id: i+1, method: 'tools/call', params: { name: 'loop__search', arguments: { type: 'skills', query, includeContent: false } } }, i === 7 ? { ...opts, agent: { ...opts.agent, allowedSkills: [] } } : opts);
    assert.ifError(res.error); assert.ok(!res.result.isError, res.result.content[0].text);
    const result = JSON.parse(res.result.content[0].text);
    const top = result.skills[0]?.id ?? null;
    correct += Number(top === expected); applied += Number(Boolean(result.reranked));
    assert.ok(!result.skills.some(s => s.id === 'hidden'));
    if (i >= 4 || !candidate || !live) assert.equal(calls, before);
    if (i >= 4) assert.equal(top, expected);
    console.log(JSON.stringify({candidate, query, expected, top, calls: calls-before, applied: !!result.reranked}));
  }
  console.log(JSON.stringify({ candidate, correct, cases: cases.length, cumulativeCalls: calls, successful, judgments, applied }));
}
assert.ok(payloads.every(s => !JSON.stringify(s).includes('BODY_SENTINEL')));
