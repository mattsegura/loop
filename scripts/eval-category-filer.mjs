#!/usr/bin/env node
// Compare TypeSafe category filing with the built-in default against hand-filed categories.
// Usage: TYPESAFE_API_KEY=… node scripts/eval-category-filer.mjs <copy-of-data-dir> [--reverse] [--json out.json]
// Point it at a COPY of the Loop data dir (config.json, catalogs/, skills/, skills-meta.json, categories.json).

import { writeFileSync } from 'node:fs';
import { LoopStore } from '../lib/store.mjs';
import { SkillStore } from '../lib/skills.mjs';
import { CategoryStore, categorizeItem } from '../lib/categories.mjs';
import { categoryOptions, fileOne, hasEvidence, resolveFilerConfig } from '../lib/category-filer.mjs';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const reverse = args.includes('--reverse');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
if (!dir) { console.error('usage: eval-category-filer.mjs <data-dir-copy> [--reverse] [--json out.json]'); process.exit(2); }
const cfg = resolveFilerConfig();
if (!cfg.enabled) { console.error(`filer disabled: ${cfg.reason}`); process.exit(2); }

const store = new LoopStore(dir, { seedBuiltins: false });
const skillStore = new SkillStore(dir);
const state = await new CategoryStore(dir).load();
const conns = await store.list();
const skills = await skillStore.list({ includeContent: true });
let options = categoryOptions(state);
if (reverse) options = [...options].reverse();
const noExplicit = { ...state, connections: {}, skills: {}, auto: null };

const items = [
  ...conns.map((item) => ({ kind: 'connection', item, hand: state.connections[item.id] || null })),
  ...skills.map((item) => ({ kind: 'skill', item, hand: state.skills[item.id] || null })),
];
const rows = [];
let cursor = 0;
let tokens = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: 6 }, async () => {
  while (cursor < items.length) {
    const job = items[cursor++];
    const def = categorizeItem(job.item, { kind: job.kind, state: noExplicit }).id;
    let r = null;
    let error = null;
    const t = Date.now();
    if (!hasEvidence(job.item, job.kind)) { rows.push({ kind: job.kind, id: job.item.id, hand: job.hand, regex: def, jev: null, p: null, ms: 0, error: null, skipped: true }); continue; }
    try { r = await fileOne(job.item, job.kind, options, cfg); } catch (e) { error = String(e.message || e); }
    tokens += r?.inputTokens || 0;
    rows.push({ kind: job.kind, id: job.item.id, hand: job.hand, regex: def, jev: r?.category || null, p: r?.probability ?? null, ms: Date.now() - t, error });
  }
}));
const elapsed = Date.now() - t0;

const hand = rows.filter((r) => r.hand);
const rate = (list, f) => `${list.filter(f).length}/${list.length}`;
console.log(`items ${rows.length} (hand-filed ${hand.length}), options ${options.length}${reverse ? ' reversed' : ''}, errors ${rows.filter((r) => r.error).length}, skipped (nothing to read) ${rows.filter((r) => r.skipped).map((r) => r.id).join(', ') || 0}`);
console.log(`input tokens ${tokens} (${Math.round(tokens / Math.max(1, rows.length))}/item), wall ${elapsed} ms, median call ${rows.map((r) => r.ms).sort((a, b) => a - b)[rows.length >> 1]} ms`);
for (const kind of ['connection', 'skill']) {
  const h = hand.filter((r) => r.kind === kind);
  console.log(`${kind}s hand-filed: regex ${rate(h, (r) => r.regex === r.hand)}, jev ${rate(h, (r) => r.jev === r.hand)}, jev p>=${cfg.minProbability} accepted else regex ${rate(h, (r) => ((r.p ?? 0) >= cfg.minProbability ? r.jev : r.regex) === r.hand)}`);
}
for (const th of [0.5, 0.6, 0.7, 0.8, 0.9]) {
  const acc = hand.filter((r) => (r.p ?? 0) >= th);
  console.log(`  p>=${th}: jev used on ${acc.length}/${hand.length}, right on ${rate(acc, (r) => r.jev === r.hand)}`);
}
console.log('\nhand-filed misses (id hand | regex | jev p):');
for (const r of hand.filter((r) => r.jev !== r.hand)) console.log(`  ${r.kind[0]} ${r.id}: ${r.hand} | ${r.regex} | ${r.jev} ${r.p?.toFixed(2)}`);
console.log('\nnot hand-filed, jev differs from regex (id regex -> jev p):');
for (const r of rows.filter((r) => !r.hand && r.jev && r.jev !== r.regex)) console.log(`  ${r.kind[0]} ${r.id}: ${r.regex} -> ${r.jev} ${r.p?.toFixed(2)}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 2));
