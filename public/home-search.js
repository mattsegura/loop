// Higher scores sort first. Compare fields separately so text cannot match across boundaries.
export function homeMatchScore(item, query) {
  const normalize = value => String(value ?? '').trim().toLowerCase();
  const q = normalize(query);
  if (!q) return 1;
  const names = [item.name, item.id, item.slug, item.accountLabel].map(normalize).filter(Boolean);
  if (Array.isArray(item._accounts)) {
    for (const acc of item._accounts) {
      if (acc?.name) names.push(normalize(acc.name));
      if (acc?.accountLabel) names.push(normalize(acc.accountLabel));
    }
  }
  if (names.includes(q)) return 4;
  if (names.some(name => name.startsWith(q))) return 3;
  if (names.some(name => name.includes(q))) return 2;
  if (normalize(item.description).includes(q)) return 1;
  if (normalize(item.connectionName).includes(q)) return 1;
  if (Array.isArray(item.tools) && item.tools.some(t => normalize(t?.name).includes(q) || normalize(t?.description).includes(q))) return 1;
  if (Array.isArray(item.skills) && item.skills.some(s => normalize(s?.name).includes(q) || normalize(s?.slug).includes(q) || normalize(s?.description).includes(q))) return 1;
  return 0;
}

export function rankedHomeMatches(groups, query) {
  // Groups already enforce profile, kind and system-skill visibility.
  return groups.flatMap(group => [
    ...group.rows.map(item => ({ item, kind: 'conn' })),
    ...group.skills.map(item => ({ item, kind: 'skill' })),
    ...group.rows.flatMap(conn => (Array.isArray(conn.skills) ? conn.skills : []).map(sk => ({
      item: {
        id: `${conn.id}__${sk.slug || sk.name || ''}`,
        slug: sk.slug || '',
        name: sk.name || sk.slug || '',
        description: sk.description || '',
        connectionId: conn.id,
        connectionName: conn.name || conn.id,
        partnerSkillsEnabled: conn.partnerSkillsEnabled === true,
      },
      kind: 'partner-skill',
    }))),
  ]).map(entry => ({ ...entry, score: homeMatchScore(entry.item, query) }))
    .filter(entry => entry.score).sort((a, b) => b.score - a.score);
}

export function resetHomeSearch(state) {
  state.homeSearch = '';
  state.homeKinds = {};
  state.homeJump = null;
}

export function findCapabilityPrompt(query, project) {
  const scope = project ? ` in the Loop project ${JSON.stringify(project)}` : ' in Loop';
  return `Use Loop's system:find-capability guide to find a capability${scope} for this request: ${JSON.stringify(query.trim())}. Check existing connections and skills first. If none fit, suggest an option before adding anything.`;
}
