// Library (#knowledge; "brain" in the code) is one page with these parts: Memories, Skills, Saved, Files, Schedules and Tasks.
// Memories is drawn by memory-view.js, Skills by renderSkills in app.js, and the rest by saved-view.js.
// This file holds what they share, so that the page has one name, one set of addresses and one menu.
// Skills are in Library, not on Home, so that Home shows connections only.

export const BRAIN_NAME = 'Library';

export const BRAIN_PARTS = [
  { id: 'memories', label: 'Memories', hash: '#knowledge' },
  { id: 'skills', label: 'Skills', hash: '#knowledge/skills' },
  { id: 'saved', label: 'Saved', hash: '#knowledge/saved' },
  { id: 'files', label: 'Files', hash: '#knowledge/files' },
  { id: 'schedules', label: 'Schedules', hash: '#knowledge/schedules' },
  { id: 'tasks', label: 'Tasks', hash: '#knowledge/tasks' },
];

// Addresses from before Library: they stay valid, as does #brain, because bookmarks and shared links use them.
// #skills was its own page; it now opens the Skills part of Library.
const OLD_PAGES = { memory: 'memories', saved: 'saved', save: 'saved', skills: 'skills' };

/** The part that an address names, or null when the address is not in Library. */
export function brainPartOf(page, sub = '') {
  if (Object.hasOwn(OLD_PAGES, page)) return OLD_PAGES[page];
  if (page !== 'knowledge' && page !== 'brain') return null;
  return BRAIN_PARTS.some((p) => p.id === sub) ? sub : 'memories';
}

export function brainHash(part) {
  return (BRAIN_PARTS.find((p) => p.id === part) || BRAIN_PARTS[0]).hash;
}

/** One part in the side menu. A narrow window shows these rows as the names at its left edge (home-scrubber.js). */
export function brainRow(part, active, count) {
  const p = BRAIN_PARTS.find((x) => x.id === part);
  return `<button type="button" class="hm-jump ${count === 0 ? 'is-empty' : ''}" data-mark="brain" data-brain-part="${p.id}" aria-current="${p.id === active}"><span class="mem-jump-l">${p.label}</span>${Number.isFinite(count) ? `<span class="hm-jump-n">${count}</span>` : ''}</button>`;
}

export function wireBrainRows(scope) {
  scope?.querySelectorAll('[data-brain-part]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = brainHash(btn.dataset.brainPart);
      if (location.hash !== next) location.hash = next;
    });
  });
}

/** How many items the parts beside Memories hold. A part that does not answer has no number. */
export async function brainCounts(api, project = 'all') {
  const q = project && project !== 'all' ? `&profile=${encodeURIComponent(project)}` : '';
  const get = (url) => api(url).catch(() => null);
  const [saved, files, schedules, tasks, skills] = await Promise.all([
    get(`/api/saved?limit=1${q}`),
    get('/api/files'),
    get('/api/schedules'),
    get('/api/tasks?limit=1'),
    get('/api/skills'),
  ]);
  return {
    saved: saved?.total, files: files?.total, schedules: schedules?.total, tasks: tasks?.total,
    skills: Array.isArray(skills?.skills) ? skills.skills.length : undefined,
  };
}
