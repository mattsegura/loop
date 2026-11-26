// An agent's face: its own picture, a tint with its first letter, or the mark of its app.
// The link page (agent-link.js) uses it too, so nothing here needs the dashboard.

export const KIND_LABELS = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  'kimi-code': 'Kimi',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  gemini: 'Gemini CLI',
  vscode: 'VS Code',
  opencode: 'OpenCode',
  windsurf: 'Windsurf',
  zed: 'Zed',
  openbot: 'OpenBot',
  muse: 'Muse Code',
  'meta-muse': 'Meta Muse',
  'claude-duet': 'Claude Duet',
  openmausbot: 'OpenMausBot',
  pi: 'Pi',
  'grok-bot': 'Grok Bot',
  imessage: 'Loop Agent',
  other: 'Other',
};

// The apps that Loop can set up by itself (INSTALLABLE_HARNESSES in lib/agent-installer.mjs).
export const INSTALL_KINDS = ['claude-code', 'codex', 'cursor', 'gemini', 'antigravity', 'vscode', 'opencode', 'windsurf', 'zed', 'kimi-code', 'muse', 'pi'];

export const PICTURE_TINTS = ['blue', 'green', 'amber'];

// Brand marks served from /agent-logos; anything unlisted falls back to an initial.
const AGENT_LOGOS = [
  ['claude', 'claude'],
  ['antigravity', 'antigravity'],
  ['codex', 'codex'],
  ['cursor', 'cursor'],
  ['gemini', 'gemini'],
  ['vscode', 'vscode'],
  ['vs code', 'vscode'],
  ['opencode', 'opencode'],
  ['windsurf', 'windsurf'],
  ['zed', 'zed'],
  ['kimi', 'kimi'],
  ['grok', 'grok'],
];

export function kindLabel(kind) {
  return KIND_LABELS[kind] || 'Other';
}

const isImage = (url) => /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(String(url || ''));
const initial = (name) => String(name || '?').trim().slice(0, 1).toUpperCase() || '?';

/** `row` is an agent, an app, or a row of both ({ agent }). */
export function agentMark(row, esc, cls = '') {
  const url = row.pictureUrl || row.agent?.pictureUrl;
  if (isImage(url)) return `<span class="home-ic mark pic ${cls}" aria-hidden="true"><img src="${esc(url)}" alt=""></span>`;
  const tint = row.picture || row.agent?.picture;
  if (PICTURE_TINTS.includes(tint)) return `<span class="home-ic mark pic is-${tint} ${cls}" aria-hidden="true">${esc(initial(row.name))}</span>`;
  const k = `${row.kind || ''} ${row.name || ''}`.toLowerCase();
  const kind = String(row.kind || '').toLowerCase();
  const hit = AGENT_LOGOS.find(([needle]) => kind.includes(needle)) || AGENT_LOGOS.find(([needle]) => k.includes(needle));
  if (hit) return `<span class="home-ic mark logo ${hit[1]} ${cls}" aria-hidden="true"><img src="/agent-logos/${hit[1]}.svg" alt="" width="20" height="20"></span>`;
  if (row.kind === 'imessage' || k.includes('imessage') || k.includes('loop text')) {
    return `<span class="home-ic mark logo loop ${cls}" aria-hidden="true"><img src="/favicon.svg" alt="" width="20" height="20"></span>`;
  }
  return `<span class="home-ic mark ${cls}" aria-hidden="true">${esc(initial(row.name))}</span>`;
}
