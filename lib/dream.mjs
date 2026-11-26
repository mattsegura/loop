// Loop core sleep-time memory review ("dreaming") and read-only Context Doctor
// (`dream.json` per workspace, right beside `memories.json`, `skills/`, and `history.json`).
//
// Lives in Loop core (not inside any single runtime like Pi) so every connected agent
// (Claude Code, Codex, Cursor, Loop Text/iMessage, web UI) shares the same dream settings,
// proposal queue, reflection-v2 rules, and Context Doctor audit over Loop MCP and Loop APIs.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { atomicWriteFile, createWriteQueue, readJsonWithBackup } from './json-file-store.mjs';
import { looksLikeSecret } from './memory.mjs';
import { defaultDataDir } from './vault.mjs';

export const DREAM_TRIGGER_MODES = Object.freeze(['both', 'steps', 'compaction']);
export const DREAM_APPLY_MODES = Object.freeze(['propose', 'auto']);
export const DREAM_CATEGORIES = Object.freeze(['mistake', 'preference', 'fact', 'contradiction', 'skill']);
export const DEFAULT_STEP_INTERVAL = 8;
export const MIN_STEP_INTERVAL = 3;
export const MAX_STEP_INTERVAL = 50;

const VALID_SCOPES = new Set(['global', 'preference', 'project', 'fact']);
const CATEGORY_PRIORITY = Object.freeze({
  mistake: 1,
  preference: 2,
  fact: 3,
  contradiction: 4,
  skill: 5,
});
const MAX_PROPOSALS_PER_RUN = 5;
const MAX_SKILLS_PER_RUN = 1;
const MAX_PENDING_PROPOSALS = 25;
const MAX_CONTENT_CHARS = 600;
const MAX_SKILL_CONTENT_CHARS = 2400;

export function parseDreamEnv(env = process.env) {
  const raw = env?.LOOP_SLEEPTIME_ENABLED ?? env?.SLEEPTIME_ENABLED ?? env?.DREAM_ENABLED ?? '';
  const s = String(raw).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
}

function localIsoDate(ms, tz = 'America/Chicago') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));
  }
}

function normalizeSlug(raw, fallback = 'memory') {
  const slug = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

function normalizeTextKey(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function wordTokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}

export function isOwnerWrittenMemory(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.pinned === true) return true;
  if (m.actor === 'owner') return true;
  const w = String(m.writtenBy || '').trim().toLowerCase();
  return w === 'owner' || w === 'you' || w === 'user' || w.startsWith('owner (');
}

function summarizeExistingMemories(existingMemories = [], maxItems = 60) {
  const list = Array.isArray(existingMemories) ? existingMemories : [];
  if (!list.length) return '(no existing Loop memories yet)';
  return list
    .slice(0, maxItems)
    .map((m) => {
      const ownerTag = isOwnerWrittenMemory(m) ? 'owner' : (m.writtenBy || 'agent');
      const scope = m.scope || 'global';
      const content = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 260);
      return `- ${m.id || m.key} [${scope}, by ${ownerTag}]: ${content}`;
    })
    .join('\n');
}

function summarizeExistingSkills(existingSkills = [], maxItems = 30) {
  const list = (Array.isArray(existingSkills) ? existingSkills : []).filter(
    (s) => s && !s.bundled && !String(s.id || '').startsWith('system:'),
  );
  if (!list.length) return '(no custom Loop skills yet)';
  return list
    .slice(0, maxItems)
    .map((s) => `- ${s.id} (${s.name || s.id}): ${String(s.description || '').replace(/\s+/g, ' ').trim().slice(0, 160)}`)
    .join('\n');
}

export function formatTurnsForReflection(turns = [], maxChars = 14000) {
  const list = Array.isArray(turns) ? turns : [];
  const blocks = [];
  let used = 0;
  for (const t of list) {
    if (!t || !t.user) continue;
    const header = `[Turn #${t.seq ?? t.id ?? '?'} · ${t.channel || 'chat'}${t.sentAt ? ` · ${t.sentAt}` : ''}]`;
    const toolNote = Array.isArray(t.tools) && t.tools.length ? `\nTools used: ${t.tools.slice(0, 6).join(', ')}` : '';
    const errNote = Array.isArray(t.toolErrors) && t.toolErrors.length
      ? `\nTool errors: ${t.toolErrors.map((te) => `${te.tool}: ${te.error}`).join(' | ')}`
      : '';
    const block = `${header}\nUser: ${t.user}${toolNote}${errNote}${t.assistant ? `\nAssistant: ${t.assistant}` : ''}`;
    if (used + block.length > maxChars && blocks.length > 0) break;
    blocks.push(block);
    used += block.length + 2;
  }
  return blocks.join('\n\n');
}

export function buildDreamExtractionMessages({
  transcriptText,
  existingMemories = [],
  existingSkills = [],
  referenceDate = localIsoDate(Date.now()),
  tz = 'America/Chicago',
}) {
  const system = [
    'You are Loop Core\'s background sleep-time reflection subagent, following reflection-v2 rules.',
    `Reference date: ${referenceDate} (${tz}).`,
    'Review the recent conversation transcript against existing Loop memories and custom skills. Extract ONLY durable learnings worth persisting.',
    'Prioritize strictly in this 5-level order:',
    '1. mistake — Mistakes and corrections: errors the agent made, tool failures, user feedback, behavioral corrections.',
    '2. preference — Preferences and patterns: conventions, communication style, workflow choices.',
    '3. fact — New durable facts: project details, team info, environment details, timezone/location, key decisions.',
    '4. contradiction — Contradictions: facts conflicting with an existing memory (resolve in favor of the latest user evidence using action "supersede").',
    '5. skill — Reusable procedures: repeatable multi-step workflows that belong in a Loop Skill (action "skill", AT MOST 1 skill per run; prefer updating an existing custom skill; if unsure, propose none).',
    'Hard rules:',
    '- Convert relative dates ("today", "tomorrow", "next Tuesday", "last week") into absolute ISO dates (YYYY-MM-DD) using timestamps and the reference date.',
    '- Skip ephemeral chatter, one-off task state, temporary paths, guesses the user did not confirm, and facts already captured.',
    '- NEVER save secrets, API keys, passwords, 2FA codes, tokens, or payment card numbers.',
    '- NEVER propose deleting memories, pinning memories, or editing bundled system skills.',
    '- Preserve exact names, dates, numbers, and URLs verbatim.',
    '- Return strict JSON only: {"proposals":[{"action":"create"|"supersede"|"skill","category":"mistake"|"preference"|"fact"|"contradiction"|"skill","scope":"global"|"preference"|"project"|"fact","key":"short-kebab-slug","name":"Skill Name (skill only)","description":"When to use skill (skill only)","content":"concise durable memory or markdown skill steps","supersedesId":"mem_... or null","existingSkillId":"skill-slug or null","reason":"short reason","evidence":"short verbatim quote from user"}]}',
    '- If nothing durable survives, return {"proposals":[]}. Max 5 proposals total (at most 1 skill).',
  ].join('\n');

  const user = [
    'Existing Loop memories:',
    summarizeExistingMemories(existingMemories),
    '',
    'Existing custom Loop skills:',
    summarizeExistingSkills(existingSkills),
    '',
    'Recent conversation transcript:',
    transcriptText,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function buildDreamReviewMessages({
  transcriptText,
  existingMemories = [],
  existingSkills = [],
  draftProposals = [],
  referenceDate = localIsoDate(Date.now()),
  tz = 'America/Chicago',
}) {
  const system = [
    'You are Loop Core\'s strict second-pass reflection critic ("agent reviews before applying").',
    `Reference date: ${referenceDate} (${tz}).`,
    'Audit each draft proposal against the raw transcript, existing memories, and existing skills.',
    'Reject any proposal that:',
    '1. Duplicates or paraphrases an existing memory or skill without adding durable value.',
    '2. Captures one-off task state, transient chatter, or assumptions the user did not clearly state.',
    '3. Contains unresolved relative dates ("tomorrow", "next week") instead of absolute YYYY-MM-DD dates.',
    '4. Contains or resembles any password, token, API key, code, or private financial credential.',
    '5. Uses action "supersede" without a valid existing memory ID or clear contradiction in the transcript.',
    '6. Proposes a skill for a trivial one-off task (keep at most 1 genuinely repeatable skill).',
    'Keep proposals ordered by reflection-v2 priority (mistake > preference > fact > contradiction > skill), concise, and verbatim-grounded (max 5).',
    'Return strict JSON only: {"proposals":[...],"rejected":[{"key":"...","reason":"..."}]}',
  ].join('\n');

  const user = [
    'Existing Loop memories:',
    summarizeExistingMemories(existingMemories),
    '',
    'Existing custom Loop skills:',
    summarizeExistingSkills(existingSkills),
    '',
    'Raw conversation transcript:',
    transcriptText,
    '',
    'Draft proposals to audit:',
    JSON.stringify(draftProposals, null, 2),
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function extractJsonObject(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch {}
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch {}
  }
  return null;
}

export function parseDreamProposals(rawText, existingMemories = [], existingSkills = []) {
  const parsed = extractJsonObject(rawText);
  const rawList = Array.isArray(parsed?.proposals) ? parsed.proposals : [];
  const rejected = Array.isArray(parsed?.rejected) ? parsed.rejected : [];
  const existing = Array.isArray(existingMemories) ? existingMemories : [];
  const skills = Array.isArray(existingSkills) ? existingSkills : [];
  const existingById = new Map(existing.filter((m) => m?.id).map((m) => [String(m.id), m]));
  const existingTexts = new Set(existing.map((m) => normalizeTextKey(m?.content)).filter(Boolean));
  const skillsById = new Map(skills.filter((s) => s?.id).map((s) => [String(s.id).toLowerCase(), s]));

  const seenTexts = new Set();
  const seenKeys = new Set();
  const out = [];
  let skillCount = 0;

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const isSkill = item.action === 'skill' || item.kind === 'skill' || item.category === 'skill';

    if (isSkill) {
      if (skillCount >= MAX_SKILLS_PER_RUN) continue;
      const content = String(item.content || '').trim().slice(0, MAX_SKILL_CONTENT_CHARS);
      if (content.length < 20 || looksLikeSecret(content)) continue;
      const rawName = String(item.name || item.key || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const rawKey = typeof item.key === 'string' && item.key.trim() ? item.key : rawName;
      if (String(rawKey).trim().toLowerCase().startsWith('system:')) continue;
      let key = normalizeSlug(rawKey, `workflow-${out.length + 1}`);
      if (key === 'loop' || looksLikeSecret(key)) continue;

      const requestedExisting = typeof item.existingSkillId === 'string' ? item.existingSkillId.trim().toLowerCase() : '';
      const matchedExisting = (requestedExisting && skillsById.get(requestedExisting)) || skillsById.get(key) || null;
      if (matchedExisting?.bundled || String(matchedExisting?.id || '').startsWith('system:')) continue;

      const existingSkillId = matchedExisting ? String(matchedExisting.id) : null;
      if (existingSkillId) key = existingSkillId;
      if (seenKeys.has(`skill:${key}`)) continue;
      seenKeys.add(`skill:${key}`);
      skillCount += 1;

      const description = String(item.description || item.reason || `Reusable workflow for ${rawName || key}`)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220);
      const reason = String(item.reason || '').replace(/\s+/g, ' ').trim().slice(0, 220);
      const evidence = String(item.evidence || '').replace(/\s+/g, ' ').trim().slice(0, 220);

      out.push({
        kind: 'skill',
        action: 'skill',
        category: 'skill',
        priority: CATEGORY_PRIORITY.skill,
        scope: 'project',
        key,
        name: rawName || key,
        description: looksLikeSecret(description) ? `Reusable workflow for ${key}` : description,
        content,
        supersedesId: null,
        existingSkillId,
        targetOwnerWritten: false,
        reason: looksLikeSecret(reason) ? '' : reason,
        evidence: looksLikeSecret(evidence) ? '' : evidence,
      });
      continue;
    }

    const content = String(item.content || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT_CHARS);
    if (content.length < 6 || looksLikeSecret(content)) continue;

    const norm = normalizeTextKey(content);
    if (existingTexts.has(norm) || seenTexts.has(norm)) continue;

    const scope = VALID_SCOPES.has(item.scope) ? item.scope : 'fact';
    let action = item.action === 'supersede' ? 'supersede' : 'create';
    let supersedesId = typeof item.supersedesId === 'string' && item.supersedesId.trim() ? item.supersedesId.trim() : null;
    let targetOwnerWritten = false;

    if (action === 'supersede') {
      const target = supersedesId ? existingById.get(supersedesId) : null;
      if (!target) {
        action = 'create';
        supersedesId = null;
      } else {
        targetOwnerWritten = isOwnerWrittenMemory(target);
      }
    } else {
      supersedesId = null;
    }

    const category = DREAM_CATEGORIES.includes(item.category) && item.category !== 'skill'
      ? item.category
      : action === 'supersede'
        ? 'contradiction'
        : scope === 'preference'
          ? 'preference'
          : 'fact';

    const rawKey = typeof item.key === 'string' ? item.key : content.split(/\s+/).slice(0, 5).join('-');
    let key = normalizeSlug(rawKey, `dream-${out.length + 1}`);
    if (looksLikeSecret(key)) key = `dream-${out.length + 1}`;
    while (seenKeys.has(`mem:${key}`)) key = `${key.slice(0, 58)}-${out.length + 1}`;

    seenTexts.add(norm);
    seenKeys.add(`mem:${key}`);

    const reason = String(item.reason || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    const evidence = String(item.evidence || '').replace(/\s+/g, ' ').trim().slice(0, 220);

    out.push({
      kind: 'memory',
      action,
      category,
      priority: CATEGORY_PRIORITY[category] || 3,
      scope,
      key,
      content,
      supersedesId,
      existingSkillId: null,
      targetOwnerWritten,
      reason: looksLikeSecret(reason) ? '' : reason,
      evidence: looksLikeSecret(evidence) ? '' : evidence,
    });
  }

  out.sort((a, b) => (a.priority || 3) - (b.priority || 3));
  return { proposals: out.slice(0, MAX_PROPOSALS_PER_RUN), rejected };
}

// "1 memory", "2 memories": a count with the right form of its word.
function countOf(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function buildDoctorReport({
  memories = [],
  skills = [],
  turns = [],
  dreamSummary = null,
  symptom = '',
} = {}) {
  const mems = Array.isArray(memories) ? memories : [];
  const customSkills = (Array.isArray(skills) ? skills : []).filter(
    (s) => s && !s.bundled && !String(s.id || '').startsWith('system:'),
  );
  const historyTurns = Array.isArray(turns) ? turns : [];
  const findings = [];

  const pinnedCount = mems.filter((m) => m?.pinned === true).length;
  if (mems.length >= 400) {
    findings.push({ severity: 'warn', category: 'capacity', message: `Loop Memory has ${mems.length}/500 items; review and supersede old notes.`, ids: [] });
  }
  if (pinnedCount >= 10) {
    findings.push({
      severity: 'warn',
      category: 'pinned',
      message: `${pinnedCount}/12 startup pins are full, which adds tokens to every turn.`,
      ids: mems.filter((m) => m?.pinned).map((m) => m.id).filter(Boolean),
    });
  }

  const tokenized = mems.map((m) => ({ m, norm: normalizeTextKey(m?.content), tokens: wordTokens(m?.content) }));
  const dupPairs = [];
  for (let i = 0; i < tokenized.length && dupPairs.length < 5; i += 1) {
    for (let j = i + 1; j < tokenized.length && dupPairs.length < 5; j += 1) {
      const a = tokenized[i];
      const b = tokenized[j];
      if (!a.norm || !b.norm) continue;
      if (a.norm === b.norm || jaccard(a.tokens, b.tokens) >= 0.72) {
        dupPairs.push([a.m.id || a.m.key, b.m.id || b.m.key]);
      }
    }
  }
  if (dupPairs.length) {
    findings.push({
      severity: 'warn',
      category: 'duplicates',
      message: `Found ${dupPairs.length} duplicate or overlapping memory pair${dupPairs.length === 1 ? '' : 's'} (${dupPairs.slice(0, 3).map(([a, b]) => `${a} / ${b}`).join(', ')}).`,
      ids: dupPairs.flat().filter(Boolean),
    });
  }

  const secretMems = mems.filter((m) => looksLikeSecret(m?.content)).map((m) => m.id || m.key).filter(Boolean);
  if (secretMems.length) {
    findings.push({
      severity: 'error',
      category: 'secret',
      message: `${countOf(secretMems.length, 'memory item looks', 'memory items look')} like a secret and should move to Loop Vault (${secretMems.slice(0, 3).join(', ')}).`,
      ids: secretMems,
    });
  }

  const oversized = mems.filter((m) => String(m?.content || '').length > 600).map((m) => m.id || m.key).filter(Boolean);
  if (oversized.length) {
    findings.push({
      severity: 'info',
      category: 'size',
      message: `${countOf(oversized.length, 'memory item exceeds', 'memory items exceed')} 600 characters (${oversized.slice(0, 3).join(', ')}).`,
      ids: oversized,
    });
  }

  const toolErrorCounts = new Map();
  const errorRefs = [];
  for (const t of historyTurns) {
    for (const te of t.toolErrors || []) {
      toolErrorCounts.set(te.tool, (toolErrorCounts.get(te.tool) || 0) + 1);
      errorRefs.push(`#${t.seq ?? t.id ?? te.id ?? '?'}`);
    }
  }
  if (toolErrorCounts.size) {
    const top = [...toolErrorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tool, n]) => `${tool} (${n}x)`)
      .join(', ');
    findings.push({
      severity: 'warn',
      category: 'tool_errors',
      message: `Recent chats had ${errorRefs.length} tool error${errorRefs.length === 1 ? '' : 's'}: ${top}.`,
      ids: errorRefs.slice(-6),
    });
  }

  const cleanSymptom = String(symptom || '').trim();
  if (cleanSymptom) {
    const qTokens = wordTokens(cleanSymptom);
    const matchingTurns = historyTurns.filter((t) => {
      const hay = `${t.user || ''} ${t.assistant || ''} ${(t.toolErrors || []).map((e) => `${e.tool} ${e.error}`).join(' ')}`.toLowerCase();
      return hay.includes(cleanSymptom.toLowerCase()) || [...qTokens].some((w) => hay.includes(w));
    });
    const matchingMems = mems.filter((m) => {
      const hay = `${m.key || ''} ${m.content || ''}`.toLowerCase();
      return hay.includes(cleanSymptom.toLowerCase()) || [...qTokens].some((w) => hay.includes(w));
    });
    findings.unshift({
      severity: 'info',
      category: 'symptom',
      message: `Symptom "${cleanSymptom}": matched ${matchingTurns.length} recent turn${matchingTurns.length === 1 ? '' : 's'} (${matchingTurns.slice(-3).map((t) => `#${t.seq ?? t.id}`).join(', ') || 'none'}) and ${matchingMems.length} memory item${matchingMems.length === 1 ? '' : 's'} (${matchingMems.slice(0, 3).map((m) => m.id || m.key).join(', ') || 'none'}).`,
      ids: [...matchingTurns.slice(-3).map((t) => `#${t.seq ?? t.id}`), ...matchingMems.slice(0, 3).map((m) => m.id || m.key)],
    });
  }

  const pendingCount = dreamSummary?.pendingProposals?.length || 0;
  if (pendingCount > 0) {
    findings.push({
      severity: 'info',
      category: 'pending_proposals',
      message: `${pendingCount} sleep-time proposal${pendingCount === 1 ? '' : 's'} waiting for review.`,
      ids: dreamSummary.pendingProposals.map((p) => p.id),
    });
  }

  const dreamAvailable = !dreamSummary || (dreamSummary.serverEnabled !== false && dreamSummary.enabled !== false);
  const issueCount = findings.filter((f) => f.severity === 'warn' || f.severity === 'error').length;
  const healthy = issueCount === 0;
  const nextAction = secretMems.length
    ? 'Remove secret-like memories from Loop Memory and save them in Loop Vault.'
    : pendingCount > 0
      ? 'Review queued proposals in Loop Settings or approve them via Loop MCP / DREAM APPLY.'
      : dupPairs.length > 0 || toolErrorCounts.size > 0
        ? (dreamAvailable
            ? 'Run a sleep-time reflection pass over recent chats.'
            : 'Review and clean up duplicate memories or recent tool errors manually (sleep-time review is off on this server).')
        : 'No repairs needed right now.';

  const memoryCount = countOf(mems.length, 'memory', 'memories');
  const turnCount = countOf(historyTurns.length, 'recent turn');
  const head = healthy
    ? `Context check looks healthy (${memoryCount}, ${pinnedCount} pinned, ${countOf(customSkills.length, 'custom skill')}, ${turnCount}).`
    : `Context check found ${countOf(issueCount, 'issue')} (${memoryCount}, ${pinnedCount} pinned, ${turnCount}).`;

  return {
    ok: true,
    healthy,
    symptom: cleanSymptom || null,
    metrics: {
      memoryCount: mems.length,
      pinnedCount,
      customSkillCount: customSkills.length,
      recentTurns: historyTurns.length,
      recentToolErrors: errorRefs.length,
      pendingProposals: pendingCount,
    },
    findings,
    nextAction,
    summaryText: [head, findings.slice(0, 4).map((f) => f.message).join(' '), nextAction].filter(Boolean).join(' '),
  };
}

function resolveDefaultDreamLlm(env = process.env) {
  if (env?.DEEPSEEK_API_KEY) {
    return {
      url: 'https://api.deepseek.com/v1/chat/completions',
      headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      model: env.DEEPSEEK_MODEL || 'deepseek-flash',
      extra: { reasoning_effort: 'low' },
    };
  }
  if (env?.OPENROUTER_API_KEY) {
    return {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://useloop.sh', 'X-Title': 'Loop Core Dream' },
      model: env.LOOP_DREAM_MODEL || 'openai/gpt-4o-mini',
      extra: {},
    };
  }
  if (env?.OPENAI_API_KEY) {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      model: env.LOOP_DREAM_MODEL || 'gpt-4o-mini',
      extra: {},
    };
  }
  if (env?.ANTHROPIC_API_KEY) {
    return {
      format: 'anthropic',
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      model: env.LOOP_DREAM_MODEL || 'claude-haiku-4-5',
      extra: {},
    };
  }
  return null;
}

// Why background review does not run, for the agent that reads the status.
const REVIEW_OFF_ON_SERVER = 'Background review is off on this Loop server: its operator has not set LOOP_SLEEPTIME_ENABLED=1. "enabled" is the switch of this workspace, and it takes effect when the server turns review on.';
const REVIEW_OFF_HERE = 'Background review is turned off for this workspace. Turn it on with loop__save({ type: "dream", data: { enabled: true } }).';

export class DreamStore {
  constructor(dir = defaultDataDir(), opts = {}) {
    this.dir = dir;
    this.file = path.resolve(dir, 'dream.json');
    this.memoryStore = opts.memoryStore || null;
    this.skillStore = opts.skillStore || null;
    this.historyStore = opts.historyStore || null;
    this.env = opts.env || process.env;
    this.serverEnabled = opts.enabled !== undefined ? Boolean(opts.enabled) : parseDreamEnv(this.env);
    this.defaultStepInterval = Math.max(
      MIN_STEP_INTERVAL,
      Math.min(MAX_STEP_INTERVAL, Number(opts.stepInterval || this.env?.LOOP_SLEEPTIME_STEP_INTERVAL || this.env?.SLEEPTIME_STEP_INTERVAL) || DEFAULT_STEP_INTERVAL),
    );
    this.defaultTz = opts.defaultTz || 'America/Chicago';
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.completeJsonOverride = typeof opts.completeJson === 'function' ? opts.completeJson : null;
    this.now = opts.now || (() => Date.now());
    this._lock = createWriteQueue();
    this._running = null;
  }

  _defaultState() {
    return {
      enabled: true,
      triggerMode: 'both',
      stepInterval: this.defaultStepInterval,
      reviewBeforeApply: true,
      applyMode: 'propose',
      lastReviewedSeq: 0,
      turnsSinceDream: 0,
      lastDreamAt: null,
      lastTrigger: null,
      lastStatus: null,
      lastError: null,
      totalRuns: 0,
      totalSaved: 0,
      pendingProposals: [],
      updatedAt: this.now(),
    };
  }

  async _load() {
    const { data } = await readJsonWithBackup(this.file, {
      validate: (d) => d && typeof d === 'object' && !Array.isArray(d),
    });
    return data ? { ...this._defaultState(), ...data } : this._defaultState();
  }

  async _save(state) {
    await atomicWriteFile(this.file, JSON.stringify(state, null, 2), { mode: 0o600, backup: true });
  }

  _formatSummary(state) {
    const enabled = Boolean(state.enabled);
    const active = Boolean(this.serverEnabled && enabled);
    return {
      serverEnabled: this.serverEnabled,
      enabled,
      active,
      ...(active ? {} : { inactiveReason: this.serverEnabled ? REVIEW_OFF_HERE : REVIEW_OFF_ON_SERVER }),
      triggerMode: state.triggerMode || 'both',
      stepInterval: state.stepInterval || this.defaultStepInterval,
      reviewBeforeApply: Boolean(state.reviewBeforeApply),
      applyMode: state.applyMode || 'propose',
      turnsSinceDream: state.turnsSinceDream || 0,
      lastDreamAt: state.lastDreamAt || null,
      lastTrigger: state.lastTrigger || null,
      lastStatus: state.lastStatus || null,
      lastError: state.lastError || null,
      totalRuns: state.totalRuns || 0,
      totalSaved: state.totalSaved || 0,
      pendingProposals: (state.pendingProposals || []).map((p) => ({ ...p })),
    };
  }

  async summary() {
    return this._formatSummary(await this._load());
  }

  async formatStatusText() {
    const s = await this.summary();
    if (!s.serverEnabled) return 'Sleep-time memory review is not enabled on this server right now.';
    const pending = s.pendingProposals.length;
    if (!s.enabled) {
      return `Sleep-time memory review is off.${pending ? ` You have ${pending} proposal(s) waiting — reply DREAM APPLY or DREAM SKIP.` : ''} Reply DREAM ON to turn it back on.`;
    }
    const when = s.triggerMode === 'steps'
      ? `every ${s.stepInterval} turns`
      : s.triggerMode === 'compaction'
        ? 'on context compaction'
        : `every ${s.stepInterval} turns and on compaction`;
    const modeNote = s.applyMode === 'auto' ? 'auto-save' : 'review first';
    const pendingNote = pending
      ? ` ${pending} proposal(s) waiting: "${(s.pendingProposals[0].name || s.pendingProposals[0].content).slice(0, 100)}". Reply DREAM APPLY to save or DREAM SKIP to dismiss.`
      : ' No proposals waiting.';
    return `Sleep-time memory review is on (${when}, ${modeNote}).${pendingNote} Reply DREAM NOW, DOCTOR, or DREAM OFF.`;
  }

  async setConfig(patch = {}) {
    if (patch.triggerMode !== undefined && !DREAM_TRIGGER_MODES.includes(patch.triggerMode)) {
      throw Object.assign(new Error(`triggerMode must be one of: ${DREAM_TRIGGER_MODES.join(', ')}`), { status: 400 });
    }
    if (patch.stepInterval !== undefined) {
      const n = Math.round(Number(patch.stepInterval));
      if (!Number.isFinite(n) || n < MIN_STEP_INTERVAL || n > MAX_STEP_INTERVAL) {
        throw Object.assign(new Error(`stepInterval must be between ${MIN_STEP_INTERVAL} and ${MAX_STEP_INTERVAL}`), { status: 400 });
      }
    }
    if (patch.applyMode !== undefined && !DREAM_APPLY_MODES.includes(patch.applyMode)) {
      throw Object.assign(new Error(`applyMode must be one of: ${DREAM_APPLY_MODES.join(', ')}`), { status: 400 });
    }
    return this._lock(async () => {
      const state = await this._load();
      if (typeof patch.enabled === 'boolean') state.enabled = patch.enabled;
      if (patch.triggerMode !== undefined) state.triggerMode = patch.triggerMode;
      if (patch.stepInterval !== undefined) state.stepInterval = Math.round(Number(patch.stepInterval));
      if (typeof patch.reviewBeforeApply === 'boolean') state.reviewBeforeApply = patch.reviewBeforeApply;
      if (patch.applyMode !== undefined) state.applyMode = patch.applyMode;
      state.updatedAt = this.now();
      await this._save(state);
      return this._formatSummary(state);
    });
  }

  async _completeJson(messages) {
    if (this.completeJsonOverride) return this.completeJsonOverride(messages);
    const target = resolveDefaultDreamLlm(this.env);
    if (!target) {
      throw Object.assign(new Error('No LLM API key is configured on Loop Core for sleep-time reflection.'), { status: 503 });
    }
    let body;
    if (target.format === 'anthropic') {
      const system = messages
        .filter((m) => m?.role === 'system')
        .map((m) => String(m.content || ''))
        .join('\n\n');
      const chatMessages = messages
        .filter((m) => m?.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }));
      body = {
        model: target.model,
        ...target.extra,
        temperature: 0.2,
        max_tokens: 1400,
        ...(system ? { system } : {}),
        messages: chatMessages,
      };
    } else {
      body = {
        model: target.model,
        ...target.extra,
        temperature: 0.2,
        max_tokens: 1400,
        stream: false,
        messages,
      };
    }
    const res = await this.fetchImpl(target.url, {
      method: 'POST',
      headers: target.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    if (!res?.ok) throw Object.assign(new Error(`Dream LLM returned HTTP ${res?.status || 'error'}.`), { status: 502 });
    const data = await res.json();
    const content = target.format === 'anthropic' ? data?.content : data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter((c) => c?.type === 'text').map((c) => c.text || '').join('\n');
    return '';
  }

  async _applyProposalToStores(p, { actor = 'agent', writtenBy = 'Loop Core Dream', profile = 'all' } = {}) {
    if (p.kind === 'skill' || p.action === 'skill') {
      if (!this.skillStore || (typeof this.skillStore.saveSkillMarkdown !== 'function' && typeof this.skillStore.save !== 'function')) {
        return { ok: false, saved: false, error: 'Skill store is unavailable.' };
      }
      const slug = p.existingSkillId || p.key;
      if (String(slug).startsWith('system:') || slug === 'loop') {
        return { ok: false, saved: false, error: 'Bundled Loop skills cannot be modified.' };
      }
      const skillOpts = {
        name: p.name || slug,
        description: p.description || p.reason || `Workflow for ${slug}`,
        content: p.content,
        source: p.source || 'Sleep-time dream',
        addedBy: actor === 'owner'
          ? { kind: 'owner' }
          : { kind: 'agent', name: writtenBy || 'Loop Core Dream', approved: false },
        ...(profile && profile !== 'all' ? { profiles: [profile] } : {}),
      };
      const saved = typeof this.skillStore.saveSkillMarkdown === 'function'
        ? await this.skillStore.saveSkillMarkdown(slug, skillOpts)
        : await this.skillStore.save({ id: slug, ...skillOpts });
      return { ok: true, saved: true, skill: saved };
    }
    if (!this.memoryStore?.save) return { ok: false, saved: false, error: 'Memory store is unavailable.' };
    const result = await this.memoryStore.save({
      key: p.key,
      content: p.content,
      scope: p.scope || 'fact',
      pinned: false,
      ...(p.supersedesId ? { supersedes: p.supersedesId } : {}),
      ...(profile && profile !== 'all' ? { profiles: [profile] } : {}),
      source: p.source || 'Sleep-time dream',
      writtenBy,
      actor,
    }, { enforceProfileScope: Boolean(profile && profile !== 'all') });
    return { ok: true, saved: true, memory: result?.memory || result };
  }

  _enqueueProposals(state, proposals) {
    state.pendingProposals = Array.isArray(state.pendingProposals) ? state.pendingProposals : [];
    const seen = new Set(state.pendingProposals.map((p) => `${p.kind || 'memory'}:${normalizeTextKey(p.content)}`));
    const added = [];
    for (const p of proposals) {
      const dedup = `${p.kind || 'memory'}:${normalizeTextKey(p.content)}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      const item = {
        id: `drm_${randomBytes(4).toString('hex')}`,
        kind: p.kind || (p.action === 'skill' ? 'skill' : 'memory'),
        action: p.action,
        category: p.category || (p.action === 'skill' ? 'skill' : 'fact'),
        priority: p.priority || CATEGORY_PRIORITY[p.category] || 3,
        scope: p.scope || 'fact',
        key: p.key,
        ...(p.name ? { name: p.name } : {}),
        ...(p.description ? { description: p.description } : {}),
        content: p.content,
        supersedesId: p.supersedesId || null,
        ...(p.existingSkillId ? { existingSkillId: p.existingSkillId } : {}),
        reason: p.reason || '',
        evidence: p.evidence || '',
        createdAt: this.now(),
      };
      state.pendingProposals.push(item);
      added.push(item);
    }
    if (state.pendingProposals.length > MAX_PENDING_PROPOSALS) {
      state.pendingProposals = state.pendingProposals.slice(-MAX_PENDING_PROPOSALS);
    }
    return added;
  }

  async run({ trigger = 'manual', dryRun = false, force = false, turnsOverride = null, tz, profile = 'all' } = {}) {
    if (this._running) return this._running;
    const work = (async () => {
      const snapshot = await this._load();
      if (!dryRun && !force && !this.serverEnabled) {
        throw Object.assign(new Error('Sleep-time memory review is not enabled on this server.'), { status: 409 });
      }
      if (!dryRun && !force && !snapshot.enabled) {
        return { ok: true, skipped: true, reason: 'disabled', dream: this._formatSummary(snapshot) };
      }

      try {
        let turns = [];
        let lastSeq = snapshot.lastReviewedSeq || 0;
        if (Array.isArray(turnsOverride)) {
          turns = turnsOverride;
          for (const t of turns) lastSeq = Math.max(lastSeq, Number(t?.seq) || 0);
        } else if (this.historyStore?.recent) {
          const rec = await this.historyStore.recent({ afterSeq: snapshot.lastReviewedSeq || 0, limit: 30 });
          turns = rec.turns;
          lastSeq = Math.max(lastSeq, rec.lastSeq || 0);
        }

        const transcriptText = formatTurnsForReflection(turns);
        if (!turns.length || !transcriptText) {
          if (!dryRun) {
            const updated = await this._lock(async () => {
              const s = await this._load();
              s.lastReviewedSeq = Math.max(s.lastReviewedSeq || 0, lastSeq);
              s.turnsSinceDream = 0;
              s.lastDreamAt = this.now();
              s.lastTrigger = trigger;
              s.lastStatus = 'noop';
              s.lastError = null;
              s.updatedAt = this.now();
              await this._save(s);
              return this._formatSummary(s);
            });
            return { ok: true, dryRun: false, trigger, reviewedTurns: 0, draftCount: 0, proposals: [], savedCount: 0, queuedCount: 0, dream: updated };
          }
          return { ok: true, dryRun: true, trigger, reviewedTurns: 0, draftCount: 0, proposals: [], savedCount: 0, queuedCount: 0, dream: this._formatSummary(snapshot) };
        }

        const [existingMemories, existingSkills] = await Promise.all([
          this.memoryStore?.list ? this.memoryStore.list({ profile }).catch(() => []) : [],
          this.skillStore?.list ? this.skillStore.list({ profile }).catch(() => []) : [],
        ]);
        const safeTz = tz || this.defaultTz;
        const referenceDate = localIsoDate(this.now(), safeTz);

        const draftRaw = await this._completeJson(buildDreamExtractionMessages({
          transcriptText,
          existingMemories,
          existingSkills,
          referenceDate,
          tz: safeTz,
        }));
        const firstPass = parseDreamProposals(draftRaw, existingMemories, existingSkills);
        let finalProposals = firstPass.proposals;
        let rejected = [];
        let reviewedSecondPass = false;

        if (finalProposals.length > 0 && snapshot.reviewBeforeApply) {
          reviewedSecondPass = true;
          const reviewRaw = await this._completeJson(buildDreamReviewMessages({
            transcriptText,
            existingMemories,
            existingSkills,
            draftProposals: finalProposals,
            referenceDate,
            tz: safeTz,
          }));
          const reviewed = parseDreamProposals(reviewRaw, existingMemories, existingSkills);
          finalProposals = reviewed.proposals;
          rejected = reviewed.rejected;
        }

        if (dryRun) {
          return {
            ok: true,
            dryRun: true,
            trigger,
            reviewedTurns: turns.length,
            draftCount: firstPass.proposals.length,
            reviewedSecondPass,
            proposals: finalProposals,
            rejected,
            savedCount: 0,
            queuedCount: 0,
            dream: this._formatSummary(snapshot),
          };
        }

        let savedCount = 0;
        const toQueue = [];
        if (snapshot.applyMode === 'auto') {
          for (const p of finalProposals) {
            if (p.kind === 'skill' || (p.action === 'supersede' && p.targetOwnerWritten)) {
              toQueue.push(p);
              continue;
            }
            const res = await this._applyProposalToStores(p, { profile }).catch((e) => ({ ok: false, error: e.message }));
            if (res?.saved) savedCount += 1;
            else toQueue.push(p);
          }
        } else {
          toQueue.push(...finalProposals);
        }

        const { queuedCount, summary } = await this._lock(async () => {
          const s = await this._load();
          const queued = this._enqueueProposals(s, toQueue);
          s.lastReviewedSeq = Math.max(s.lastReviewedSeq || 0, lastSeq);
          s.turnsSinceDream = 0;
          s.lastDreamAt = this.now();
          s.lastTrigger = trigger;
          s.lastStatus = savedCount || queued.length ? 'ok' : 'noop';
          s.lastError = null;
          s.totalRuns = (s.totalRuns || 0) + 1;
          s.totalSaved = (s.totalSaved || 0) + savedCount;
          s.updatedAt = this.now();
          await this._save(s);
          return { queuedCount: queued.length, summary: this._formatSummary(s) };
        });

        return {
          ok: true,
          dryRun: false,
          trigger,
          reviewedTurns: turns.length,
          draftCount: firstPass.proposals.length,
          reviewedSecondPass,
          proposals: finalProposals,
          rejected,
          savedCount,
          queuedCount,
          dream: summary,
        };
      } catch (e) {
        if (!dryRun) {
          await this._lock(async () => {
            const s = await this._load();
            s.lastStatus = 'error';
            s.lastError = String(e?.message || 'dream failed').slice(0, 200);
            s.updatedAt = this.now();
            await this._save(s);
          }).catch(() => {});
        }
        throw e;
      } finally {
        this._running = null;
      }
    })();

    this._running = work;
    return work;
  }

  async onTurnCompleted({ count = 1, tz } = {}) {
    if (!this.serverEnabled) return null;
    const shouldRun = await this._lock(async () => {
      const s = await this._load();
      if (!s.enabled) return false;
      s.turnsSinceDream = (s.turnsSinceDream || 0) + Math.max(1, Number(count) || 1);
      s.updatedAt = this.now();
      await this._save(s);
      return (s.triggerMode === 'steps' || s.triggerMode === 'both') && s.turnsSinceDream >= s.stepInterval;
    });
    if (shouldRun) return this.run({ trigger: 'steps', tz }).catch(() => null);
    return null;
  }

  async onCompaction({ turnsOverride = null, tz } = {}) {
    if (!this.serverEnabled) return null;
    const s = await this._load();
    if (!s.enabled) return null;
    if (s.triggerMode !== 'compaction' && s.triggerMode !== 'both') return null;
    return this.run({ trigger: 'compaction', turnsOverride, tz }).catch(() => null);
  }

  async remember({ text, actor = 'owner', writtenBy = 'Owner', profile = 'all' } = {}) {
    const content = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT_CHARS);
    if (content.length < 3) throw Object.assign(new Error('Give a short fact or preference to remember.'), { status: 400 });
    if (looksLikeSecret(content)) {
      throw Object.assign(new Error('That looks like a secret or key. Save secrets in Loop Vault instead of Memory.'), { status: 400 });
    }
    const isPref = /^(?:always|never|prefer|i prefer|use |keep |don't |do not |avoid )/i.test(content);
    const scope = isPref ? 'preference' : 'fact';
    const key = normalizeSlug(content.split(/\s+/).slice(0, 6).join('-'), `note-${randomBytes(2).toString('hex')}`);
    const saved = await this._applyProposalToStores(
      { kind: 'memory', action: 'create', scope, key, content, source: 'REMEMBER command' },
      { actor, writtenBy, profile },
    );
    if (!saved?.saved) throw Object.assign(new Error(saved?.error || 'Could not save memory.'), { status: 502 });
    const summary = await this._lock(async () => {
      const s = await this._load();
      s.totalSaved = (s.totalSaved || 0) + 1;
      s.updatedAt = this.now();
      await this._save(s);
      return this._formatSummary(s);
    });
    return { ok: true, saved: true, memory: saved.memory, dream: summary };
  }

  async doctor({ symptom = '', profile = 'all', includeHistory = true, includeProposals = true } = {}) {
    const [memories, skills, rec, rawDreamSummary] = await Promise.all([
      this.memoryStore?.list ? this.memoryStore.list({ profile }).catch(() => []) : [],
      this.skillStore?.list ? this.skillStore.list({ profile }).catch(() => []) : [],
      includeHistory && this.historyStore?.recent
        ? this.historyStore.recent({ afterSeq: 0, limit: 40 }).catch(() => ({ turns: [] }))
        : { turns: [] },
      includeProposals ? this.summary() : { pendingProposals: [] },
    ]);
    return buildDoctorReport({
      memories,
      skills,
      turns: rec.turns || [],
      dreamSummary: rawDreamSummary,
      symptom,
    });
  }

  async resolveProposal({ id = '', decision, all = false, actor = 'owner', writtenBy = 'Owner', profile = 'all', allowSkills = true } = {}) {
    if (decision !== 'approve' && decision !== 'dismiss') {
      throw Object.assign(new Error('decision must be "approve" or "dismiss".'), { status: 400 });
    }
    return this._lock(async () => {
      const s = await this._load();
      const list = Array.isArray(s.pendingProposals) ? s.pendingProposals : [];
      const targets = all ? [...list] : list.filter((p) => p.id === String(id || '').trim());
      if (!all && !targets.length) throw Object.assign(new Error('Proposal not found.'), { status: 404 });

      if (decision === 'dismiss') {
        const dropIds = new Set(targets.map((p) => p.id));
        s.pendingProposals = list.filter((p) => !dropIds.has(p.id));
        s.updatedAt = this.now();
        await this._save(s);
        return { ok: true, decision, dismissed: targets.length, applied: 0, dream: this._formatSummary(s) };
      }

      let applied = 0;
      const errors = [];
      const remaining = [];
      const savedMemories = [];
      const savedSkills = [];
      const targetIds = new Set(targets.map((p) => p.id));
      for (const p of list) {
        if (!targetIds.has(p.id)) {
          remaining.push(p);
          continue;
        }
        if ((p.kind === 'skill' || p.action === 'skill') && !allowSkills) {
          errors.push({ id: p.id, key: p.key, error: 'Skill updates require manager permission or owner approval in Loop.' });
          remaining.push(p);
          continue;
        }
        const res = await this._applyProposalToStores(p, { actor, writtenBy, profile }).catch((e) => ({ ok: false, error: e.message }));
        if (res?.saved) {
          applied += 1;
          if (res.memory) savedMemories.push(res.memory);
          if (res.skill) savedSkills.push(res.skill);
        } else {
          errors.push({ id: p.id, key: p.key, error: res?.error || 'Could not apply proposal.' });
          remaining.push(p);
        }
      }

      s.pendingProposals = remaining;
      s.totalSaved = (s.totalSaved || 0) + applied;
      s.updatedAt = this.now();
      await this._save(s);
      return { ok: true, decision, applied, errors, savedMemories, savedSkills, dream: this._formatSummary(s) };
    });
  }
}
