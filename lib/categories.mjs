// Deterministic default categorization + persistent custom categories & overrides
// so both fast agents (automatic defaults) and smart agents (custom categories via loop__organize)
// can organize Connections & Skills cleanly.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, createWriteQueue } from './json-file-store.mjs';
import { cleanInlineText, escapeMarkdown, formatCodeList, pluralize } from './markdown.mjs';
import { defaultDataDir } from './vault.mjs';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const GENERATED_ID_RE = /^(?:cat_[0-9a-f]{8,16}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?_[0-9a-f]{8}(?:_\d+)?)$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isForbiddenKey(raw) {
  if (typeof raw !== 'string') return false;
  return FORBIDDEN_KEYS.has(raw.trim().toLowerCase());
}

function canonicalLabel(raw) {
  return String(raw || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function shortHash(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 8);
}

function hasDistinguishingSymbols(raw) {
  const canon = canonicalLabel(raw);
  return /[^\p{L}\p{N}\s\-_&]/u.test(canon);
}

function toNullProtoMap(raw) {
  const out = Object.create(null);
  if (!isPlainObject(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const cleanKey = String(k).trim();
    if (!cleanKey || isForbiddenKey(cleanKey)) continue;
    if (typeof v === 'string' && v.trim() && !isForbiddenKey(v)) {
      out[cleanKey] = v.trim();
    }
  }
  return out;
}

function sanitizeStringMap(raw) {
  return Object.fromEntries(Object.entries(toNullProtoMap(raw)));
}

export const CATEGORIES = [
  {
    id: 'design-media',
    description:
      'Visual and interface design, app and web design references, image, video and media creation, illustration, diagrams and canvases',
    label: 'Design & Media',
    pattern:
      /(?:\b(doop|figma|canva|pencil|mobbin|higgsfield|excalidraw|blender|hyperframes|media|video|dubbing|clips|lightreel|invideo|ui-prototype|web-design|design|canvas|lockscreen|anatomy|remotion)\b|(?<!okx[-_])\bpaper\b(?!\s*trad))/i,
  },
  {
    id: 'cloud-dev',
    description:
      'Writing and shipping software: code hosting, databases, cloud platforms and infrastructure, deployment, SDKs, developer tooling and observability',
    label: 'Cloud & Dev',
    pattern:
      /\b(supabase|aws|amazon-bedrock|bedrock|cloudflare|github|gitlab|langsmith|langfuse|vercel|react|postgres|sqlite|docker|rill|phoenix|cdk|iam|observability|bb-cli|sdk|database|deploy|kubernetes)\b/i,
  },
  {
    id: 'browser-gui',
    description:
      'Computer use: operating web browsers, desktop apps, phones or simulators by clicking, typing and reading the screen, and the sandboxes or virtual machines that run them',
    label: 'Browser & GUI',
    pattern:
      /\b(cua|cua-driver|cua-sandboxes|cua-spaces|cua-volume|aside|browser|gui|chrome|playwright|puppeteer|mobile-next|apple-apps|desktop|computer-use)\b/i,
  },
  {
    id: 'growth-marketing',
    description:
      'Advertising, social media, SEO, lead generation, outreach and growing an audience or customer base',
    label: 'Growth & Marketing',
    pattern:
      /\b(meta-ads|foreplay|treg|lead-signals|lead|recruit|make-ugc|ugc|ads|marketing|seo|social|tiktok|instagram|linkedin|youtube|twitter|reddit|campaign)\b/i,
  },
  {
    id: 'commerce-finance',
    description:
      'Online stores, orders, payments, billing, invoices, wallets, crypto and trading',
    label: 'Commerce & Finance',
    pattern:
      /\b(shopify|stripe|okx|wallet|payment|financial|billing|cost-management|commerce|trade|btc|crypto|invoice|checkout)\b/i,
  },
  {
    id: 'data-research',
    description:
      'Web search, scraping and crawling, pulling data out of sites and documents, analytics and research',
    label: 'Data & Research',
    pattern:
      /\b(brightdata|scrapling|web-access|scrape|scraper|crawler|crawl|enrich|analytics|windsor|supermetrics|graphify|search|research)\b/i,
  },
  {
    id: 'agents-ops',
    description:
      'Building, running and coordinating AI agents: agent memory, workflows, prompts, agent setup and operations',
    label: 'Agents & Ops',
    pattern:
      /\b(hindsight|langflow|letta|agent|agents|bot-fleet|composio|grill|grilling|router|memory|workflow|ops|operations|prompt|orchestrat)\b/i,
  },
];

export const GENERAL_CATEGORY = { id: 'general', label: 'General', description: 'Anything that does not clearly fit one of the other categories' };

// Model filings (lib/category-filer.mjs) are used when their top probability reaches this.
export const AUTO_FILING_MIN_PROBABILITY = 0.5;

export function slugifyCategory(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const lowered = trimmed.toLowerCase();
  if (FORBIDDEN_KEYS.has(lowered)) return '';
  if (GENERATED_ID_RE.test(lowered)) return lowered;
  const slug = lowered
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (slug) {
    if (FORBIDDEN_KEYS.has(slug)) return '';
    return slug;
  }
  const normalized = canonicalLabel(trimmed);
  if (!/[\p{L}\p{N}]/u.test(normalized)) return '';
  return `cat_${shortHash(normalized)}`;
}

function titleFromSlug(slug) {
  return String(slug || '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ') || 'General';
}

export function normalizeCategoryQuery(raw) {
  return String(raw || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function defaultCategorizeItem(item = {}) {
  const haystack = [
    item.id,
    item.name,
    item.description,
    item.url,
    item.command,
    ...(Array.isArray(item.args) ? item.args : []),
  ]
    .filter(Boolean)
    .join(' ');

  for (const cat of CATEGORIES) {
    if (cat.pattern.test(haystack)) {
      return { id: cat.id, label: cat.label };
    }
  }
  return GENERAL_CATEGORY;
}

function resolveCategoryByIdOrLabel(raw, customList = []) {
  const clean = String(raw || '').trim();
  if (!clean || isForbiddenKey(clean)) return null;
  const slug = slugifyCategory(clean);
  if (!slug || FORBIDDEN_KEYS.has(slug)) return null;
  const canon = canonicalLabel(clean);
  const norm = normalizeCategoryQuery(clean);
  const cleanLower = clean.toLowerCase();

  // 1. Exact ID or exact canonical label match on custom categories.
  for (const c of customList) {
    if (c.id === cleanLower || canonicalLabel(c.label) === canon) {
      return { id: c.id, label: c.label, description: c.description || '' };
    }
  }

  // 2. Slug / normalized query match on custom categories, refusing silent symbol collisions ("C++" vs "C#").
  for (const c of customList) {
    const sameNorm = norm && (normalizeCategoryQuery(c.id) === norm || normalizeCategoryQuery(c.label) === norm);
    if (c.id === slug || sameNorm) {
      if (hasDistinguishingSymbols(clean) || hasDistinguishingSymbols(c.label)) {
        continue;
      }
      return { id: c.id, label: c.label, description: c.description || '' };
    }
  }

  // 3. Built-in categories.
  for (const c of CATEGORIES) {
    if (c.id === cleanLower || canonicalLabel(c.label) === canon) {
      return { id: c.id, label: c.label, description: '' };
    }
    if (
      !hasDistinguishingSymbols(clean) &&
      (c.id === slug || (norm && (normalizeCategoryQuery(c.id) === norm || normalizeCategoryQuery(c.label) === norm)))
    ) {
      return { id: c.id, label: c.label, description: '' };
    }
  }

  if (slug === GENERAL_CATEGORY.id || norm === 'general') {
    return { ...GENERAL_CATEGORY, description: '' };
  }

  // 4. Unmatched custom category: disambiguate deterministically if base slug belongs to a different label.
  let nextId = slug;
  if (
    customList.some((c) => c.id === nextId && canonicalLabel(c.label) !== canon) ||
    CATEGORIES.some((c) => c.id === nextId && canonicalLabel(c.label) !== canon)
  ) {
    nextId = `${slug.slice(0, 51)}_${shortHash(canon)}`;
  }
  const displayLabel =
    /[^\x00-\x7f]/.test(clean) || hasDistinguishingSymbols(clean) || clean.includes(' ') || /[A-Z]/.test(clean)
      ? clean
      : titleFromSlug(slug);
  return { id: nextId || 'general', label: displayLabel, description: '' };
}

export function categorizeItem(item = {}, { kind = 'connection', state = null } = {}) {
  if (state && typeof item?.id === 'string' && item.id) {
    const bucket = kind === 'skill' ? state.skills : state.connections;
    if (bucket && typeof bucket === 'object' && Object.hasOwn(bucket, item.id)) {
      const assigned = bucket[item.id];
      if (typeof assigned === 'string' && assigned) {
        const resolved = resolveCategoryByIdOrLabel(assigned, state.categories || []);
        if (resolved) return { id: resolved.id, label: resolved.label };
      }
    }
  }
  const auto = autoFiling(item, kind, state);
  if (auto) return auto;
  return defaultCategorizeItem(item);
}

function autoFiling(item, kind, state) {
  if (!state?.auto || typeof item?.id !== 'string' || !item.id) return null;
  const bucket = kind === 'skill' ? state.auto.skills : state.auto.connections;
  if (!bucket || !Object.hasOwn(bucket, item.id)) return null;
  const entry = bucket[item.id];
  const min = Number(state.autoMinProbability) > 0 ? Number(state.autoMinProbability) : AUTO_FILING_MIN_PROBABILITY;
  if (!entry || typeof entry.category !== 'string' || !(Number(entry.p) >= min)) return null;
  if (entry.category === GENERAL_CATEGORY.id) return { id: GENERAL_CATEGORY.id, label: GENERAL_CATEGORY.label };
  const custom = (state.categories || []).find((c) => c.id === entry.category);
  if (custom) return { id: custom.id, label: custom.label || custom.id };
  const builtIn = CATEGORIES.find((c) => c.id === entry.category);
  return builtIn ? { id: builtIn.id, label: builtIn.label } : null;
}

function sanitizeAuto(raw) {
  const out = { connections: {}, skills: {} };
  if (!isPlainObject(raw)) return out;
  for (const bucket of ['connections', 'skills']) {
    if (!isPlainObject(raw[bucket])) continue;
    for (const [k, v] of Object.entries(raw[bucket])) {
      const id = String(k).trim();
      if (!id || isForbiddenKey(id) || !isPlainObject(v)) continue;
      if (typeof v.category !== 'string' || !v.category || isForbiddenKey(v.category)) continue;
      out[bucket][id] = {
        category: v.category,
        p: Number(v.p) || 0,
        ...(Number.isFinite(v.fit) ? { fit: Number(v.fit) } : {}),
        key: typeof v.key === 'string' ? v.key : '',
        ...(typeof v.at === 'string' ? { at: v.at } : {}),
      };
    }
  }
  return out;
}

export function matchesCategory(item, categoryQuery, opts = {}) {
  const q = normalizeCategoryQuery(categoryQuery);
  if (!q || q === 'all') return true;
  const cat = categorizeItem(item, opts);
  const rawQ = canonicalLabel(categoryQuery);
  if (rawQ !== q && canonicalLabel(cat.label) === rawQ) return true;
  if (rawQ !== q && canonicalLabel(cat.label) !== rawQ && normalizeCategoryQuery(cat.label) === q) {
    if (hasDistinguishingSymbols(categoryQuery) || hasDistinguishingSymbols(cat.label)) {
      return false;
    }
  }
  return (
    normalizeCategoryQuery(cat.id).includes(q) ||
    normalizeCategoryQuery(cat.label).includes(q)
  );
}

export function groupByCategory(connections = [], skills = [], state = null) {
  const map = new Map();
  const customCategories = Array.isArray(state?.categories) ? state.categories : [];
  const ensure = (cat) => {
    if (!map.has(cat.id)) {
      const custom = customCategories.find((x) => x.id === cat.id);
      map.set(cat.id, {
        id: cat.id,
        label: custom?.label || cat.label,
        description: custom?.description || '',
        connections: [],
        skills: [],
      });
    }
    return map.get(cat.id);
  };

  for (const c of connections) {
    const cat = categorizeItem(c, { kind: 'connection', state });
    ensure(cat).connections.push(c);
  }
  for (const s of skills) {
    const cat = categorizeItem(s, { kind: 'skill', state });
    ensure(cat).skills.push(s);
  }

  // Show custom categories first (in user/agent-defined order), then built-ins, then General.
  const order = [
    ...customCategories.map((c) => c.id),
    ...CATEGORIES.map((c) => c.id),
    GENERAL_CATEGORY.id,
  ];
  const seen = new Set();
  const result = [];
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    const g = map.get(id);
    if (g && (g.connections.length > 0 || g.skills.length > 0)) result.push(g);
  }
  for (const [id, g] of map) {
    if (!seen.has(id) && (g.connections.length > 0 || g.skills.length > 0)) result.push(g);
  }
  return result;
}

function disambiguatedLabels(items, getName) {
  const counts = new Map();
  for (const item of items) {
    const key = cleanInlineText(getName(item)).toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return (subset) =>
    subset
      .map((item) => {
        const name = cleanInlineText(getName(item));
        const id = cleanInlineText(item?.id);
        if (!name) return id;
        if (id && (counts.get(name.toLowerCase()) || 0) > 1) {
          return `${name} [${id}]`;
        }
        return name;
      })
      .filter(Boolean);
}

export function renderLoopHubBox(loopStats, connections = [], skills = [], state = null) {
  const stats = loopStats || {};
  const totalConnections = Number(stats.connections) || 0;
  const local = Number(stats.local) || 0;
  const cloud = Number(stats.cloud) || 0;
  const tools = Number(stats.tools) || 0;
  const ready = Number(stats.ready) || 0;
  const needsSignIn = Number(stats.needsSignIn) || 0;
  const failed = Number(stats.failed) || 0;
  const off = Number(stats.off) || 0;

  const groups = groupByCategory(connections, skills, state);
  const labelConnections = disambiguatedLabels(connections, (c) => c?.name || c?.id);
  const labelSkills = disambiguatedLabels(skills, (s) => s?.name || s?.id);

  const out = [
    '### Loop Hub',
    '',
    `**${pluralize(totalConnections, 'connection')}** (${local} Local, ${cloud} Cloud · ${pluralize(tools, 'tool')}) · **${pluralize(skills.length, 'skill')}**`,
  ];

  if (totalConnections > 0) {
    const statusParts = [`${ready} ready`];
    if (needsSignIn > 0) {
      statusParts.push(`${needsSignIn} ${needsSignIn === 1 ? 'needs' : 'need'} sign-in`);
    }
    if (failed > 0) {
      statusParts.push(pluralize(failed, 'error'));
    }
    if (off > 0) {
      statusParts.push(`${off} off`);
    }
    out.push(statusParts.join(' · '));
  }

  out.push('');
  if (groups.length === 0) {
    out.push('_No connections or skills yet._');
    return out;
  }

  for (const g of groups) {
    const countParts = [];
    if (g.connections.length > 0) countParts.push(pluralize(g.connections.length, 'connection'));
    if (g.skills.length > 0) countParts.push(pluralize(g.skills.length, 'skill'));
    const desc = cleanInlineText(g.description);
    const descSuffix = desc ? ` — ${escapeMarkdown(desc)}` : '';
    out.push(`- **${escapeMarkdown(g.label)}** (${countParts.join(', ')})${descSuffix}`);
    if (g.connections.length > 0) {
      out.push(`  - Connections: ${formatCodeList(labelConnections(g.connections), 4)}`);
    }
    if (g.skills.length > 0) {
      out.push(`  - Skills: ${formatCodeList(labelSkills(g.skills), 4)}`);
    }
  }

  return out;
}

/* ---------------- Persistent CategoryStore ---------------- */

export class CategoryStore {
  constructor(dir = defaultDataDir()) {
    this.dir = dir;
    this.file = path.join(dir, 'categories.json');
    this._lock = createWriteQueue();
  }

  _withLock(fn) {
    return this._lock(fn);
  }

  async load() {
    let text;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return { categories: [], connections: {}, skills: {} };
      }
      throw err;
    }

    const raw = JSON.parse(text);
    if (!isPlainObject(raw)) {
      throw new Error(`Invalid categories file "${this.file}": expected a JSON object.`);
    }
    if (raw.categories !== undefined && !Array.isArray(raw.categories)) {
      throw new Error(`Invalid categories file "${this.file}": "categories" must be an array.`);
    }
    if (raw.connections !== undefined && !isPlainObject(raw.connections)) {
      throw new Error(`Invalid categories file "${this.file}": "connections" must be an object.`);
    }
    if (raw.skills !== undefined && !isPlainObject(raw.skills)) {
      throw new Error(`Invalid categories file "${this.file}": "skills" must be an object.`);
    }

    const categories = (raw.categories || []).filter(
      (c) =>
        isPlainObject(c) &&
        typeof c.id === 'string' &&
        c.id.trim().length > 0 &&
        !FORBIDDEN_KEYS.has(c.id) &&
        !isForbiddenKey(c.id),
    );
    return {
      categories,
      connections: raw.connections ? sanitizeStringMap(raw.connections) : {},
      skills: raw.skills ? sanitizeStringMap(raw.skills) : {},
      ...(raw.auto !== undefined ? { auto: sanitizeAuto(raw.auto) } : {}),
      ...(Array.isArray(raw.dismissedSuggestions)
        ? { dismissedSuggestions: raw.dismissedSuggestions.filter((k) => typeof k === 'string' && k && !isForbiddenKey(k)).slice(0, 2000) }
        : {}),
    };
  }

  // Hide category suggestions for these keys ("connection:<id>", "skill:<id>", "split:<category id>").
  async dismissSuggestions(keys = []) {
    const clean = (Array.isArray(keys) ? keys : [])
      .map((k) => String(k || '').trim())
      .filter((k) => /^(?:connection|skill|split):.{1,200}$/.test(k) && !isForbiddenKey(k));
    return this._withLock(async () => {
      const state = await this.load();
      state.dismissedSuggestions = [...new Set([...(state.dismissedSuggestions || []), ...clean])].slice(-2000);
      await this._save(state);
      return state;
    });
  }

  // Replace the model filings (lib/category-filer.mjs). Explicit assignments are untouched and still win.
  async setAuto(auto) {
    return this._withLock(async () => {
      const state = await this.load();
      state.auto = sanitizeAuto(auto);
      await this._save(state);
      return state;
    });
  }

  async _save(state) {
    await atomicWriteFile(this.file, JSON.stringify(state, null, 2) + '\n', {
      mode: 0o600,
      backup: false,
      fsync: true,
    });
  }

  async removeConnection(connId) {
    const cleanId = typeof connId === 'string' ? connId.trim() : '';
    if (!cleanId || isForbiddenKey(cleanId)) {
      return false;
    }
    return this._withLock(async () => {
      const state = await this.load();
      if (!Object.hasOwn(state.connections, cleanId)) {
        return false;
      }
      delete state.connections[cleanId];
      await this._save(state);
      return true;
    });
  }

  async organize({ createCategories = [], deleteCategories = [], assignConnections = {}, assignSkills = {}, dryRun = false } = {}, inspectPlan = null) {
    return this._withLock(async () => {
      const state = await this.load();
      const byId = new Map(state.categories.map((c) => [c.id, { ...c }]));
      const connectionsMap = toNullProtoMap(state.connections);
      const skillsMap = toNullProtoMap(state.skills);

      const ensureCategory = (entry) => {
        const isObj = isPlainObject(entry);
        const hasExplicitId = isObj && typeof entry.id === 'string' && entry.id.trim().length > 0;
        if (isObj && entry.id !== undefined && isForbiddenKey(String(entry.id))) {
          return null;
        }
        const rawLabel =
          typeof entry === 'string'
            ? entry.trim()
            : typeof entry?.label === 'string'
              ? entry.label.trim()
              : '';
        const rawIdInput =
          typeof entry === 'string'
            ? entry.trim()
            : hasExplicitId
              ? entry.id.trim()
              : rawLabel;
        if (!rawIdInput || isForbiddenKey(rawIdInput)) return null;

        const canonLabel = rawLabel ? canonicalLabel(rawLabel) : '';

        // Without an explicit id, reuse an existing category with the exact same label.
        if (!hasExplicitId && canonLabel) {
          for (const existing of byId.values()) {
            if (canonicalLabel(existing.label) === canonLabel) {
              const description =
                (isObj && typeof entry.description === 'string'
                  ? entry.description.trim()
                  : existing.description) || '';
              const updated = { ...existing, description };
              byId.set(existing.id, updated);
              return updated;
            }
          }
        }

        let targetId = slugifyCategory(rawIdInput);
        if (!targetId || FORBIDDEN_KEYS.has(targetId)) return null;

        const existingCustom = byId.get(targetId);
        const existingBuiltIn = CATEGORIES.find((c) => c.id === targetId);
        const existingOwnerLabel = existingCustom?.label || existingBuiltIn?.label || null;

        if (
          existingOwnerLabel &&
          canonLabel &&
          canonicalLabel(existingOwnerLabel) !== canonLabel
        ) {
          if (hasExplicitId) {
            throw Object.assign(
              new Error(`Category id "${targetId}" is already in use by "${existingOwnerLabel}".`),
              { status: 409 },
            );
          }
          // Auto-generated slug collision (e.g. "C++" vs "C#" both slugging to "c"):
          // disambiguate deterministically instead of silently overwriting the prior category.
          let candidate = `${targetId.slice(0, 51)}_${shortHash(canonLabel)}`;
          let n = 2;
          while (
            (byId.has(candidate) && canonicalLabel(byId.get(candidate).label) !== canonLabel) ||
            CATEGORIES.some((c) => c.id === candidate)
          ) {
            candidate = `${targetId.slice(0, 48)}_${shortHash(canonLabel)}_${n++}`;
          }
          targetId = candidate;
        }

        const existingForTarget = byId.get(targetId);
        const resolved = resolveCategoryByIdOrLabel(rawLabel || targetId, [...byId.values()]);
        const label =
          rawLabel ||
          existingForTarget?.label ||
          existingBuiltIn?.label ||
          resolved?.label ||
          titleFromSlug(targetId);
        const description =
          (isObj && typeof entry.description === 'string'
            ? entry.description.trim()
            : existingForTarget?.description) || '';
        const next = { id: targetId, label, description };
        byId.set(targetId, next);
        return next;
      };

      for (const c of Array.isArray(createCategories) ? createCategories : []) {
        ensureCategory(c);
      }

      for (const del of Array.isArray(deleteCategories) ? deleteCategories : []) {
        const cleanDel = String(del || '').trim();
        if (!cleanDel || isForbiddenKey(cleanDel)) continue;
        let targetId = null;
        if (byId.has(cleanDel.toLowerCase())) {
          targetId = cleanDel.toLowerCase();
        } else {
          const canonDel = canonicalLabel(cleanDel);
          for (const c of byId.values()) {
            if (canonicalLabel(c.label) === canonDel) {
              targetId = c.id;
              break;
            }
          }
        }
        if (!targetId) targetId = slugifyCategory(cleanDel);
        if (!targetId) continue;
        byId.delete(targetId);
        for (const [k, v] of Object.entries(connectionsMap)) {
          if (v === targetId) delete connectionsMap[k];
        }
        for (const [k, v] of Object.entries(skillsMap)) {
          if (v === targetId) delete skillsMap[k];
        }
      }

      const assignMap = (target, updates) => {
        if (!updates || typeof updates !== 'object') return;
        for (const [itemId, catVal] of Object.entries(updates)) {
          const cleanItem = String(itemId || '').trim();
          if (!cleanItem || isForbiddenKey(cleanItem)) continue;
          if (catVal === null || catVal === '') {
            delete target[cleanItem];
            continue;
          }
          const resolved = resolveCategoryByIdOrLabel(catVal, [...byId.values()]);
          if (!resolved || FORBIDDEN_KEYS.has(resolved.id)) continue;
          // Auto-create custom category if it's not a built-in one
          if (
            !byId.has(resolved.id) &&
            !CATEGORIES.some((c) => c.id === resolved.id) &&
            resolved.id !== GENERAL_CATEGORY.id
          ) {
            ensureCategory({ id: resolved.id, label: resolved.label });
          }
          target[cleanItem] = resolved.id;
        }
      };

      assignMap(connectionsMap, assignConnections);
      assignMap(skillsMap, assignSkills);

      const before = inspectPlan ? { ...state } : null;
      state.categories = [...byId.values()];
      state.connections = Object.fromEntries(Object.entries(connectionsMap));
      state.skills = Object.fromEntries(Object.entries(skillsMap));
      if (inspectPlan) await inspectPlan(before, state);
      if (!dryRun) {
        await this._save(state);
      }
      return state;
    });
  }
}
