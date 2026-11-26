// Origin is assigned by the store. Names, source labels and frontmatter are not proof of origin.
export const isSystemSkill = (skill) => skill?.namespace === 'system';

const homeGuideIds = ['system:loop', 'system:connections', 'system:skills', 'system:organize', 'system:vault'];
export function homeSystemGuides(rows) {
  return homeGuideIds.flatMap(id => {
    const guide = rows.find(row => isSystemSkill(row) && row.systemId === id);
    return guide ? [{ ...guide, id }] : [];
  });
}

// Read the native guide explicitly, even if the user imported a same-name skill.
export function mountContextGuide(slot, api, id, title) {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = title;
  const body = document.createElement('pre');
  details.className = 'context-guide';
  details.append(summary, body);
  slot.append(details);
  let loaded = false;
  details.addEventListener('toggle', async () => {
    if (!details.open || loaded) return;
    loaded = true;
    body.textContent = 'Loading guide…';
    try {
      const { skill } = await api('/api/skills/' + encodeURIComponent('system:' + id));
      body.textContent = skill.content;
    } catch {
      loaded = false;
      body.textContent = 'Guide unavailable. Close and reopen to try again.';
    }
  });
}

const paths = new Map(Object.entries({
  connections: 'M10 13a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2M14 11a4 4 0 0 0-6 0l-4 4a4 4 0 0 0 6 6l2-2',
  skills: 'm3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4',
  vault: 'M4 4h16v16H4zM8 9v6m5-3h4m-2-2v4',
  loop: 'M12 7c-2-4-8-3-8 2 0 5 6 6 8 1 2-5 8-4 8 1 0 5-6 6-8 2',
  'capability-ladder': 'M6 20V4m12 16V4M6 7h12M6 12h12M6 17h12',
  dream: 'M20 14a8 8 0 0 1-10-11 9 9 0 1 0 10 11Z',
  'find-capability': 'M15 15l5 5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
  'fix-connection': 'm14 7 3 3 4-4a6 6 0 0 1-8 8l-7 7-3-3 7-7a6 6 0 0 1 8-8Z',
  'learn-workflow': 'm3 8 9-5 9 5-9 5-9-5Zm4 3v5l5 3 5-3v-5',
  organize: 'M3 7V5h7l2 3h9v11H3V7Z',
  'setup-project': 'M8 8a4 4 0 1 0 8 0 4 4 0 1 0-8 0ZM4 20c0-7 16-7 16 0',
  'setup-profile': 'M8 8a4 4 0 1 0 8 0 4 4 0 1 0-8 0ZM4 20c0-7 16-7 16 0',
  'sync-agents': 'M3 6h15l-3-3m3 3-3 3m6 9H6l3 3m-3-3 3-3',
}));
const fallbackPath = 'M5 4h10l4 4v12H5V4Zm9 0v5h5M8 13h8m-8 3h6';
export function systemTitle(skill) {
  const name = skill.displayName || skill.name || skill.id;
  return /^[a-z0-9-]+$/.test(name) ? name.replace(/(^|-)(\w)/g, (_, sep, ch) => (sep ? ' ' : '') + ch.toUpperCase()) : name;
}
export function renderSystemSection(skills, { esc, expanded, drawer, home = false }) {
  const system = home ? homeSystemGuides(skills) : skills.filter(isSystemSkill).sort((a, b) => Number(b.systemId === 'system:loop') - Number(a.systemId === 'system:loop') || systemTitle(a).localeCompare(systemTitle(b)));
  if (!system.length) return '';
  return `<section class="skill-group system-skills" aria-label="System skills"><h2>System <small>${system.length}</small></h2><div class="sys-list">${system.map((s) => {
    const open = expanded.has(s.id);
    return `<article><button type="button" class="sys-row" data-skill-read="${esc(s.id)}" aria-expanded="${open}"><span class="sys-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="${paths.get(s.systemId?.slice('system:'.length)) || fallbackPath}"/></svg></span><span class="sys-copy"><strong>${esc(systemTitle(s))}</strong><span>${esc(s.description || '')}</span></span></button>${open ? drawer(s) : ''}</article>`;
  }).join('')}</div></section>`;
}
