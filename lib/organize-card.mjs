import { categorizeItem } from './categories.mjs';
import { approvalFingerprint } from './policies.mjs';

// Only category metadata, never connection configuration or skill contents.
export function organizeCard({ before, after, connections, skills, restricted = false, profile, action, input }) {
  const changes = [];
  const add = (kind, id, name, from, to) => {
    if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ kind, id, name, before: from, after: to });
  };
  const defs = [before, after].map(state => new Map(state.categories.map(c => [c.id, { id: c.id, label: c.label, description: c.description || '' }])));
  for (const id of [...new Set(defs.flatMap(m => [...m.keys()]))].sort()) {
    add('category', id, id, defs[0].get(id) || null, defs[1].get(id) || null);
  }
  for (const [kind, items, bucket] of [['connection', connections, 'connections'], ['skill', skills, 'skills']]) {
    const byId = new Map(items.map(i => [i.id, i]));
    for (const id of [...new Set([...byId.keys(), ...Object.keys(before[bucket]), ...Object.keys(after[bucket]), ...Object.keys(before.auto?.[bucket] || {})])].sort()) {
      const item = byId.get(id) || { id };
      const value = state => ({ ...categorizeItem(item, { kind, state }), assignment: Object.hasOwn(state[bucket], id) ? 'explicit' : 'automatic' });
      const from = value(before), to = value(after);
      if ((restricted || profile !== 'all') && !byId.has(id)) {
        if (JSON.stringify(from) !== JSON.stringify(to)) throw new Error('This category plan affects items outside the current project.');
        continue;
      }
      add(kind, id, item.name || id, from, to);
    }
  }
  const card = { type: 'organize_categories', version: 1, profile, changes };
  return { ...card, planId: approvalFingerprint({ kind: 'category-plan', target: action, args: { input, card } }) };
}

const md = s => String(s).replace(/[\\`*_{}\[\]()<>#|!~]/g, '\\$&').replace(/[\r\n]+/g, ' ');
export function organizeVisual(card) {
  const value = v => v ? `${md(v.label)} (${md(v.id)})${v.assignment ? `, ${v.assignment}` : ''}${v.description ? `: ${md(v.description)}` : ''}` : 'Not defined';
  return ['### Organize categories', `Project: ${md(card.profile)}`, '', ...(!card.changes.length ? ['No category changes.'] : card.changes.map(r => `- **${md(r.name)}** (${r.kind}: ${md(r.id)}): Before: ${value(r.before)} → After: ${value(r.after)}`))].join('\n');
}
