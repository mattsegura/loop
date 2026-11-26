// Offline catalog enrichment for Loop Search ("document expansion").
//
// Tool and skill descriptions are written for humans and often skip the plain job they do.
// One cheap LLM pass writes a few short requests an agent would type when it needs each item;
// Search embeds them as extra example vectors (the same slot curated catalog examples use) and
// adds them to the lexical bag. Results are cached by content hash, so only new or changed items
// cost a call. Works with any OpenAI-compatible chat endpoint.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

export const ENRICH_VERSION = 1;
const PER_ITEM = 5;

export function enrichKey(kind, item) {
  const text = kind === 'skill'
    ? `${item.id}\n${item.name}\n${item.description}\n${String(item.body || item.content || '').slice(0, 1500)}`
    : `${item.fullToolName || item.name}\n${item.description}\n${JSON.stringify(item.inputSchema?.properties ? Object.keys(item.inputSchema.properties) : [])}`;
  return createHash('sha256').update(`v${ENRICH_VERSION}\n${kind}\n${text}`).digest('hex').slice(0, 20);
}

function itemPrompt(kind, item, i) {
  if (kind === 'skill') {
    const body = String(item.body || item.content || '').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').slice(0, 700);
    return `[${i}] SKILL ${item.name || item.id}: ${String(item.description || '').slice(0, 500)} ${body ? `| Body: ${body}` : ''}`;
  }
  const params = item.inputSchema?.properties ? Object.keys(item.inputSchema.properties).slice(0, 12).join(', ') : '';
  return `[${i}] TOOL ${item.connName || item.connection || ''} ${item.name}: ${String(item.description || '').slice(0, 500)}${params ? ` | Inputs: ${params}` : ''}`;
}

export async function enrichBatch(kind, items, { url, apiKey, model, fetchImpl = fetch, timeoutMs = 180000 } = {}) {
  const sys =
    'You write search queries. For each numbered item, write ' + PER_ITEM + ' short, different requests (max 12 words each) ' +
    'that an AI agent would type into a tool search box when it needs exactly what this item does. Describe the job, not the item name. ' +
    'Vary wording: one casual, one with a concrete example input, one naming the outcome. Never invent abilities the item lacks. ' +
    'Reply with JSON only: {"items":[{"i":0,"q":["...", ...]}, ...]}';
  const user = items.map((it, i) => itemPrompt(kind, it, i)).join('\n');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, temperature: 0.4, max_tokens: 6000, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], response_format: { type: 'json_object' } }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`enrich http ${res.status}`);
    const data = await res.json();
    const txt = data?.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(txt.match(/\{[\s\S]*\}/)?.[0] || '{}');
    const out = new Array(items.length).fill(null);
    for (const row of parsed.items || []) {
      const i = Number(row?.i);
      if (!Number.isInteger(i) || i < 0 || i >= items.length || !Array.isArray(row.q)) continue;
      out[i] = row.q.map((q) => String(q || '').replace(/\s+/g, ' ').trim().slice(0, 140)).filter(Boolean).slice(0, PER_ITEM);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

// Enrich many items with a persistent cache file. Returns { [key]: string[] } for the given items.
export async function enrichAll(kind, items, { cachePath, batchSize = 20, concurrency = Number(process.env.LOOP_ENRICH_CONCURRENCY) || 6, onProgress = null, ...llm } = {}) {
  const cache = cachePath && existsSync(cachePath) ? JSON.parse(await readFile(cachePath, 'utf8')) : {};
  const todo = items.filter((it) => !cache[enrichKey(kind, it)]);
  const batches = [];
  for (let i = 0; i < todo.length; i += batchSize) batches.push(todo.slice(i, i + batchSize));
  let done = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < batches.length) {
      const b = batches[cursor++];
      let res = null;
      for (let attempt = 0; attempt < 2 && !res; attempt += 1) {
        try {
          res = await enrichBatch(kind, b, llm);
        } catch {
          res = null;
        }
      }
      if (res) b.forEach((it, i) => { if (res[i]?.length) cache[enrichKey(kind, it)] = res[i]; });
      done += 1;
      if (onProgress) onProgress(done, batches.length);
      if (cachePath && done % 10 === 0) await writeFile(cachePath, JSON.stringify(cache));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  if (cachePath) await writeFile(cachePath, JSON.stringify(cache));
  const out = {};
  for (const it of items) {
    const k = enrichKey(kind, it);
    if (cache[k]) out[kind === 'skill' ? it.id : it.fullToolName] = cache[k];
  }
  return out;
}
