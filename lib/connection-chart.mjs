import { stripVTControlCharacters } from 'node:util';

const clean = (text) => stripVTControlCharacters(text).replace(/\s+/gu, ' ').trim();

// Short display defaults for connections imported before descriptions were saved.
const purposes = new Map(Object.entries({
  pencil: 'A design editor for app screens and layouts in .pen files.',
  treg: 'A catalog for finding and calling APIs by task.',
  'clips-kitty': 'A library of short-form video references and templates.',
  'doop design': 'A shared design canvas for layouts and prototypes.',
  higgsfield: 'An AI studio for creating images and videos.',
  mobbin: 'A reference library of real app screens and user flows.',
  'okx-paper': 'An OKX connection for market data and paper trading.',
  paper: 'A design canvas for creating and inspecting interface layouts.',
  'aws-mcp': 'Tools for working with AWS resources and tasks.',
  cloudflare: 'Tools for managing Cloudflare services.',
  langsmith: 'Tools for tracing and evaluating AI applications.',
  supabase: 'Tools for working with Supabase projects and databases.',
  'supabase-salehub': 'A Supabase database connection for Salehub.',
  aside: 'Browser automation with saved browser profiles.',
  cua: 'Tools for managing and using virtual computer workspaces.',
  'cua-driver': 'Desktop controls for interacting with apps and windows.',
  foreplay: 'An ad research library for finding and saving creative examples.',
  'meta-ads': 'Tools for managing Meta ad campaigns and reading results.',
  shopify: 'A store connection for looking up products and orders.',
  brightdata: 'Tools for searching the web and extracting page content.',
  scrapling: 'A web scraper for extracting structured page data.',
  hindsight: 'A searchable memory and knowledge store for agents.',
  langflow: 'A workspace for building and running AI workflows.',
  'computer-use': 'Tools for interacting with a computer screen.',
  'kimi-cu': 'A computer-use connection for Kimi.',
}));

// Where the last whole sentence in the first `max` characters ends. The period of "e.g." ends none, and
// neither does the number of a step ("1. Sign in 2. Search").
function lastSentenceEnd(text, max) {
  let end = 0;
  for (const { index } of text.slice(0, max + 1).matchAll(/[.!?](?= )/g)) {
    const before = text.slice(0, index + 1);
    const step = /(?:^|\s)(\d{1,2})\.$/.exec(before);
    const isStep = step && (step[1] === '1' || before.includes(`${step[1] - 1}. `));
    if (!isStep && !/(?:^|[^\p{L}])(?:\p{L}\.){2,}$/u.test(before)) end = index + 1;
  }
  return end;
}

export function summarizeInstructions(raw, maxLen = 160) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const cleaned = stripVTControlCharacters(raw)
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxLen) return cleaned;
  const slice = cleaned.slice(0, maxLen);
  const minSentence = Math.floor(maxLen * 0.4);
  const end = lastSentenceEnd(cleaned, maxLen);
  if (end >= minSentence) return cleaned.slice(0, end);
  const wordBreak = slice.lastIndexOf(' ');
  const cut = wordBreak >= minSentence ? slice.slice(0, wordBreak) : slice;
  return `${cut.replace(/[,;:\-–—\s]+$/, '')}…`;
}

export function connectionPurpose(c, tools) {
  const saved = clean(c.description || '');
  if (saved) return saved;
  const fromInstructions = summarizeInstructions(c.serverInstructions || '', 160);
  if (fromInstructions) return fromInstructions;
  const name = clean(c.name).toLowerCase().replaceAll('_', '-');
  const known = purposes.get(name);
  if (known) return known;
  const packages = [c.command, ...(c.args || [])].join(' ');
  if (/arizeai|arize-phoenix|phoenix-mcp/i.test(packages)) return 'Tools for tracing and evaluating AI applications.';
  if (/rilldata/i.test(packages)) return 'An analytics workspace for exploring metrics and dashboards.';
  // No text of its own: what it can do, from the names of its tools.
  const actions = tools.filter(t => t.name).map(t => clean(t.name).replace(/[_-]+/g, ' '));
  if (!actions.length) return 'Purpose unavailable.';
  const more = actions.length > 3 ? ` and ${actions.length - 3} more` : '';
  return `Available ${actions.length === 1 ? 'action' : 'actions'} — ${actions.slice(0, 3).join(', ')}${more}.`;
}
