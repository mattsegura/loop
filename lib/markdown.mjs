import { stripVTControlCharacters } from 'node:util';

const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/g;
const MARKDOWN_SPECIAL_RE = /([\\*_`[\]<>~|])/g;

export function cleanInlineText(raw) {
  return stripVTControlCharacters(String(raw ?? ''))
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function escapeMarkdown(raw) {
  return cleanInlineText(raw).replace(MARKDOWN_SPECIAL_RE, '\\$1');
}

export function formatCodeSpan(raw) {
  const cleaned = cleanInlineText(raw);
  if (!cleaned) return '';
  let maxTicks = 0;
  for (const match of cleaned.matchAll(/`+/g)) {
    if (match[0].length > maxTicks) maxTicks = match[0].length;
  }
  const fence = '`'.repeat(maxTicks + 1);
  const needsPad =
    cleaned.startsWith('`') ||
    cleaned.endsWith('`') ||
    (maxTicks > 0 && (cleaned.startsWith(' ') || cleaned.endsWith(' ')));
  return needsPad ? `${fence} ${cleaned} ${fence}` : `${fence}${cleaned}${fence}`;
}

export function formatCodeList(items, max = 4) {
  const cleaned = (Array.isArray(items) ? items : [])
    .map((item) => formatCodeSpan(item))
    .filter(Boolean);
  if (cleaned.length === 0) return '';
  const shown = cleaned.slice(0, max).join(', ');
  const extra = cleaned.length > max ? `, +${cleaned.length - max} more` : '';
  return `${shown}${extra}`;
}

export function pluralize(count, singular, plural = `${singular}s`) {
  const n = Number(count) || 0;
  return `${n} ${n === 1 ? singular : plural}`;
}
