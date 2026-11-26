import MarkdownIt from './vendor/markdown-it.js';
// Skill text may come from another account. Do not execute HTML or load external images.
const md = new MarkdownIt({ html: false }).disable('image');
export function renderSkillMarkdown(raw) {
  return md.render(raw.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ''));
}
