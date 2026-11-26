#!/usr/bin/env node
// Write <dataDir>/search-enrichment.json for a Loop data dir: a few agent-style requests per tool
// and skill, generated once by any OpenAI-compatible chat model and cached by content hash.
// Loop loads the file at workspace start and embeds the examples on the next index sync.
//
//   LOOP_ENRICH_URL=https://api.deepseek.com LOOP_ENRICH_API_KEY=... LOOP_ENRICH_MODEL=deepseek-chat \
//     node scripts/enrich-hub.mjs --data-dir "~/Library/Application Support/Loop Hub"
//
// Re-run after adding connections or skills; unchanged items are not sent again.
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { enrichAll } from '../lib/enrich.mjs';

const i = process.argv.indexOf('--data-dir');
const dataDir = (i >= 0 ? process.argv[i + 1] : process.env.LOOP_HUB_DATA || '').replace(/^~(?=\/)/, os.homedir());
if (!dataDir || !existsSync(dataDir)) {
  console.error('Pass --data-dir <Loop data dir>');
  process.exit(2);
}
const llm = {
  url: process.env.LOOP_ENRICH_URL || 'https://api.deepseek.com',
  apiKey: process.env.LOOP_ENRICH_API_KEY || process.env.DEEPSEEK_API_KEY || '',
  model: process.env.LOOP_ENRICH_MODEL || 'deepseek-chat',
};
if (!llm.apiKey) {
  console.error('Set LOOP_ENRICH_API_KEY');
  process.exit(2);
}

const config = JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8'));
const tools = [];
for (const conn of config.mcps || []) {
  let list = Array.isArray(conn.tools) ? conn.tools : [];
  const catalogPath = path.join(dataDir, 'catalogs', `${conn.id}.json`);
  if (list.length === 0 && existsSync(catalogPath)) {
    const cat = JSON.parse(await readFile(catalogPath, 'utf8'));
    list = Array.isArray(cat) ? cat : cat.tools || [];
  }
  for (const t of list) {
    if (!t?.name) continue;
    tools.push({ ...t, connName: conn.name || conn.id, fullToolName: `${conn.id}__${t.name}` });
  }
}
const skills = [];
const skillsDir = path.join(dataDir, 'skills');
if (existsSync(skillsDir)) {
  for (const id of await readdir(skillsDir)) {
    const md = path.join(skillsDir, id, 'SKILL.md');
    if (!existsSync(md)) continue;
    const text = await readFile(md, 'utf8');
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    const name = fm?.[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() || id;
    const description = fm?.[1].match(/^description:\s*([\s\S]*?)(?=\n[a-zA-Z_-]+:|$)/m)?.[1]?.replace(/\s+/g, ' ').trim() || '';
    skills.push({ id, name, description, body: fm ? text.slice(fm[0].length) : text });
  }
}
console.log(`tools ${tools.length}, skills ${skills.length}`);
const cache = path.join(dataDir, 'search-enrichment-cache');
const t = await enrichAll('tool', tools, { ...llm, cachePath: `${cache}-tools.json` });
const s = await enrichAll('skill', skills, { ...llm, cachePath: `${cache}-skills.json`, batchSize: 8 });
await writeFile(path.join(dataDir, 'search-enrichment.json'), JSON.stringify({ tools: t, skills: s }));
console.log(`wrote search-enrichment.json: tools ${Object.keys(t).length}/${tools.length}, skills ${Object.keys(s).length}/${skills.length}`);
