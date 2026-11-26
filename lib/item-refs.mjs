// How a caller may refer to an item. Agents use an id they were given, or the name their user says
// ("Doop Design", "okx-paper"). A name counts only when one single item has it, so a guess never
// reaches a different item; the answer for a miss names the items it could have meant.

// Capitals and separators do not tell items apart: "okx-paper", "OKX Paper" and "okx_paper" are one.
export function refKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
}

// `items` are the ones this caller may use. `matches` holds the candidates when no single item fits.
export function findByRef(items, ref) {
  const wanted = String(ref ?? '').trim();
  const list = Array.isArray(items) ? items : [];
  const exact = list.find((x) => x.id === wanted);
  if (exact) return { item: exact, matches: [exact] };
  const key = refKey(wanted);
  if (!key) return { item: null, matches: [] };
  const matches = list.filter((x) => refKey(x.id) === key || refKey(x.name) === key);
  return { item: matches.length === 1 ? matches[0] : null, matches };
}

// The words of an identifier, with camelCase, snake_case and kebab-case split.
function wordsOf(name) {
  return new Set(refKey(String(name ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2')).split('_').filter(Boolean));
}

// Names that share words with a wrong one, the closest first.
export function closestNames(names, wanted, max = 5) {
  const words = wordsOf(wanted);
  if (words.size === 0) return [];
  return (Array.isArray(names) ? names : [])
    .map((name, index) => {
      const own = wordsOf(name);
      const shared = [...own].filter((w) => words.has(w)).length;
      return { name, index, shared, size: own.size };
    })
    .filter((row) => row.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.size - b.size || a.index - b.index)
    .slice(0, max)
    .map((row) => row.name);
}

// What is wrong with a reference, and what to do about it. `type` is the search type that lists them.
export function notFoundMessage(kind, ref, { matches = [], type = `${kind.toLowerCase()}s` } = {}) {
  const label = JSON.stringify(String(ref ?? '').slice(0, 80));
  if (matches.length > 1) {
    return `${kind} ${label} is not one item: ${matches.length} have this name. Use one of these ids: ${matches.slice(0, 10).map((m) => m.id).join(', ')}.`;
  }
  return `${kind} ${label} not found. Find its id with loop__search({ type: "${type}", query }).`;
}
