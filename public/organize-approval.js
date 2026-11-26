export function organizeApprovalCard(item) {
  const card = item?.detail?.card;
  return item?.kind === 'save' && ['category:organize', 'category:delete'].includes(item.target) &&
    card?.type === 'organize_categories' && card.version === 1 && Array.isArray(card.changes) ? card : null;
}

export function renderOrganizeApproval(card, esc) {
  const value = v => v ? `<strong>${esc(v.label)}</strong><small>${esc(v.id)}${v.assignment ? ` · ${esc(v.assignment)}` : ''}</small>${v.description ? `<span>${esc(v.description)}</span>` : ''}` : '<span>Not defined</span>';
  return `<section class="organize-approval" aria-label="Category changes">
    <p>Project: <strong>${esc(card.profile)}</strong> · ${card.changes.length} ${card.changes.length === 1 ? 'change' : 'changes'}</p>
    ${card.changes.length ? `<table><thead><tr><th>Item</th><th>Before</th><th>After</th></tr></thead><tbody>${card.changes.map(r => `<tr><th scope="row">${esc(r.name)}<small>${esc(r.kind)} · ${esc(r.id)}</small></th><td>${value(r.before)}</td><td>${value(r.after)}</td></tr>`).join('')}</tbody></table>` : '<p>No category changes.</p>'}
  </section>`;
}
