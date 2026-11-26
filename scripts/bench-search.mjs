#!/usr/bin/env node
// Head-to-head benchmark comparing:
//   1. Legacy substring matcher (before)
//   2. New Built-In Core WITHOUT vectors (0 extra deps, 0 MB RAM)
//   3. New Core WITH Semantic Embeddings + Examples (+ Learned Examples for private tools)
//
// Run:
//   node scripts/bench-search.mjs
// Optional (uses real local ONNX / Ollama / HTTP embedder if configured):
//   LOOP_EMBEDDING_PROVIDER=local LOOP_SEARCH_RUNTIME_DIR=... node scripts/bench-search.mjs
//   LOOP_EMBEDDING_PROVIDER=ollama node scripts/bench-search.mjs

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  createCustomEmbedder,
  createEmbedder,
  l2Normalize,
  quantizeInt8,
  resolveEmbeddingConfig,
} from '../lib/embedder.mjs';
import {
  LocalBinaryVectorStore,
  SearchIndex,
  extractSchemaParamKeys,
  extractSchemaParamText,
  signCatalogBundle,
  splitIdentifiers,
} from '../lib/search-index.mjs';
import { searchMemories } from '../lib/memory.mjs';

/* ---------------- Legacy Substring Matcher (Before Baseline) ---------------- */

function legacySearch(items, query, getHaystack) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return items;
  const tokens = q.split(/[^a-z0-9._-]+/u).filter((t) => t && !['the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'my', 'i', 'how', 'what', 'can', 'this'].includes(t));
  const strict = [];
  for (let i = 0; i < items.length; i += 1) {
    const hay = getHaystack(items[i]).toLowerCase();
    let score = 0;
    if (hay.includes(q)) score = 100;
    else if (tokens.length > 0 && tokens.every((t) => hay.includes(t))) score = 60 + tokens.length * 10;
    if (score > 0) strict.push({ item: items[i], score, idx: i });
  }
  if (strict.length > 0) {
    strict.sort((a, b) => b.score - a.score || a.idx - b.idx);
    return strict.map((e) => e.item);
  }
  const sig = tokens.filter((t) => t.length >= 3);
  if (sig.length < 2) return [];
  const partial = [];
  for (let i = 0; i < items.length; i += 1) {
    const hay = getHaystack(items[i]).toLowerCase();
    const hits = sig.filter((t) => hay.includes(t)).length;
    if (hits > 0) partial.push({ item: items[i], score: hits * 20, idx: i });
  }
  partial.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return partial.map((e) => e.item);
}

/* ---------------- Realistic Multi-App Hub Fixture ---------------- */

const CONNECTIONS = [
  {
    id: 'supabase',
    name: 'Supabase Main',
    description: 'Primary Postgres database and authentication.',
    tools: [
      { name: 'execute_sql', description: 'Execute raw SQL statements against Postgres.', inputSchema: { type: 'object', properties: { sql: { type: 'string', description: 'SQL query string' } } } },
      { name: 'list_tables', description: 'List schemas and tables in Postgres.', inputSchema: { type: 'object', properties: { schema: { type: 'string' } } } },
    ],
  },
  {
    id: 'supabase_salehub',
    name: 'Supabase Salehub',
    description: 'Salehub Postgres database.',
    tools: [
      { name: 'execute_sql', description: 'Execute raw SQL statements against Salehub Postgres.', inputSchema: { type: 'object', properties: { sql: { type: 'string' } } } },
    ],
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Payments, subscriptions, and customer invoices.',
    tools: [
      { name: 'create_refund', description: 'Refund a previously created charge.', inputSchema: { type: 'object', properties: { charge_id: { type: 'string' }, amount: { type: 'integer' } } } },
      { name: 'list_invoices', description: 'List customer billing invoices.', inputSchema: { type: 'object', properties: { customer_id: { type: 'string' } } } },
      { name: 'cancel_subscription', description: 'Cancel an active recurring subscription.', inputSchema: { type: 'object', properties: { subscription_id: { type: 'string' } } } },
    ],
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Engineering issue tracking and sprint planning.',
    tools: [
      { name: 'create_issue', description: 'Create a new issue in a Linear team.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, team_id: { type: 'string' } } } },
      { name: 'list_issues', description: 'Search and filter Linear issues.', inputSchema: { type: 'object', properties: { assignee: { type: 'string' }, state: { type: 'string' } } } },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Source code repositories, pull requests, and CI.',
    tools: [
      { name: 'list_pull_requests', description: 'List open or merged pull requests in a repository.', inputSchema: { type: 'object', properties: { repo: { type: 'string' }, state: { type: 'string' } } } },
      { name: 'get_file_contents', description: 'Fetch file contents from a repository branch.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, branch: { type: 'string' } } } },
    ],
  },
  {
    id: 'vercel',
    name: 'Vercel',
    description: 'Frontend hosting and serverless deployments.',
    tools: [
      { name: 'get_deployment_logs', description: 'Fetch runtime and build logs for a deployment.', inputSchema: { type: 'object', properties: { deployment_id: { type: 'string' } } } },
      { name: 'redeploy_project', description: 'Trigger a fresh production deployment.', inputSchema: { type: 'object', properties: { project_id: { type: 'string' } } } },
    ],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Team messaging channels and direct notifications.',
    tools: [
      { name: 'post_message', description: 'Post a message to a Slack channel.', inputSchema: { type: 'object', properties: { channel_id: { type: 'string' }, text: { type: 'string' } } } },
    ],
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Headless browser automation.',
    tools: [
      { name: 'capture_screenshot', description: 'Take a PNG screenshot of the current browser viewport.', inputSchema: { type: 'object', properties: { full_page: { type: 'boolean' } } } },
    ],
  },
  {
    id: 'private_crm',
    name: 'Acme Private CRM',
    description: 'Internal company account database.',
    tools: [
      { name: 'fetch_account_health', description: 'Retrieve internal account telemetry record.', inputSchema: { type: 'object', properties: { org_slug: { type: 'string' } } } },
    ],
  },
  {
    id: 'stuffed_spam',
    name: 'Noisy Third-Party Tool',
    description: 'Generic utility.',
    tools: [
      {
        name: 'spam_widget',
        description: 'All-in-one helper for users signed up week money back refund checkout error logs notify team bug PR review screenshot.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  },
];

// Strictly SEPARATED from TOOL_EVAL_CASES so no eval query ever appears verbatim in catalog examples!
const CATALOG_EXAMPLES = {
  supabase__execute_sql: { examples: ['count new accounts created recently', 'query rows in database', 'run analytics aggregation over table'] },
  stripe__create_refund: { examples: ['reverse a charge for a buyer', 'issue refund to payment card', 'credit back billed transaction'] },
  stripe__cancel_subscription: { examples: ['end customer membership', 'terminate recurring billing plan'] },
  linear__create_issue: { examples: ['open a new engineering task', 'log a software defect for triage'] },
  github__list_pull_requests: { examples: ['show open PRs in the repo', 'check pending pull requests awaiting approval'] },
  vercel__get_deployment_logs: { examples: ['inspect crashing server logs', 'debug failed deploy output'] },
  slack__post_message: { examples: ['ping the engineering channel', 'announce an update to coworkers'] },
  playwright__capture_screenshot: { examples: ['save visual preview of the page', 'render image of website'] },
};

const TOOL_EVAL_CASES = [
  // Exact / Technical / Parameter queries
  { group: 'exact', query: 'execute_sql', expect: 'supabase__execute_sql' },
  { group: 'exact', query: 'supabase_salehub', expect: 'supabase_salehub__execute_sql' },
  { group: 'exact', query: 'deployment_id', expect: 'vercel__get_deployment_logs' },
  { group: 'exact', query: 'org_slug', expect: 'private_crm__fetch_account_health' },
  // Strictly UNSEEN everyday-English paraphrases (NOT in CATALOG_EXAMPLES!)
  { group: 'reworded', query: 'how many users signed up this week', expect: 'supabase__execute_sql' },
  { group: 'reworded', query: 'give this customer their money back', expect: 'stripe__create_refund' },
  { group: 'reworded', query: 'stop recurring monthly plan', expect: 'stripe__cancel_subscription' },
  { group: 'reworded', query: 'file a bug report for the team', expect: 'linear__create_issue' },
  { group: 'reworded', query: 'what code reviews are waiting on me', expect: 'github__list_pull_requests' },
  { group: 'reworded', query: 'why is production throwing 500 errors', expect: 'vercel__get_deployment_logs' },
  { group: 'reworded', query: 'let the team know we shipped', expect: 'slack__post_message' },
  { group: 'reworded', query: 'snap a picture of this webpage', expect: 'playwright__capture_screenshot' },
  // Private tool query (after 1 confirmed search -> run learned example using DIFFERENT phrasing!)
  { group: 'private_learned', query: 'check customer churn risk score', expect: 'private_crm__fetch_account_health' },
];

const NEGATIVE_CASES = [
  'book a Delta flight to Tokyo next Friday',
  'order pepperoni pizza for delivery',
  'tune acoustic guitar strings in drop D',
];

const MEMORY_FIXTURE = [
  { id: 'm1', key: 'styling', content: 'Always use Tailwind CSS instead of CSS modules.', scope: 'preference', project: '', tags: ['frontend'], links: [], pinned: false, source: 'Manual', writtenBy: 'Owner', updatedAt: new Date().toISOString() },
  { id: 'm2', key: 'dentist', content: 'Dentist is Dr. Patel on 5th Street.', scope: 'fact', project: '', tags: ['personal'], links: [], pinned: false, source: 'Manual', writtenBy: 'Owner', updatedAt: new Date().toISOString() },
  { id: 'm3', key: 'pkg', content: 'Use pnpm in the billing monorepo.', scope: 'project', project: 'billing', tags: ['tooling'], links: [], pinned: false, source: 'Manual', writtenBy: 'Owner', updatedAt: new Date().toISOString() },
];

const MEMORY_EVAL_CASES = [
  { query: 'what styling library do I like', expect: 'm1' },
  { query: 'who is my doctor for teeth', expect: 'm2' },
  { query: 'package manager for billing repo', expect: 'm3' },
];

/* ---------------- Fallback Simulated Semantic Embedder (when no real model configured) ---------------- */

const CONCEPT_GROUPS = [
  ['sql', 'postgres', 'database', 'query', 'table', 'users', 'signed', 'up', 'week', 'accounts', 'created', 'rows', 'count'],
  ['refund', 'money', 'back', 'charge', 'buyer', 'reverse', 'stripe', 'payment'],
  ['cancel', 'subscription', 'stop', 'recurring', 'monthly', 'plan', 'membership', 'end'],
  ['issue', 'bug', 'report', 'linear', 'task', 'engineering', 'file', 'ticket'],
  ['pull', 'requests', 'pr', 'prs', 'code', 'reviews', 'waiting', 'github', 'repo', 'branch'],
  ['deployment', 'logs', 'production', 'throwing', '500', 'errors', 'crashing', 'server', 'vercel'],
  ['slack', 'message', 'channel', 'team', 'know', 'shipped', 'ping', 'notify'],
  ['screenshot', 'picture', 'webpage', 'browser', 'viewport', 'visual', 'preview', 'snap', 'page'],
  ['churn', 'risk', 'score', 'account', 'health', 'telemetry', 'crm'],
  ['tailwind', 'css', 'styling', 'library', 'frontend', 'modules'],
  ['dentist', 'doctor', 'teeth', 'patel'],
  ['pnpm', 'package', 'manager', 'billing', 'monorepo'],
];

function makeFallbackDemoEmbedder() {
  const dims = 64;
  return createCustomEmbedder({
    provider: 'demo-semantic',
    modelId: 'demo-semantic:v1',
    dimensions: dims,
    async embed(texts) {
      return texts.map((t) => {
        const vec = new Float32Array(dims);
        const toks = splitIdentifiers(t);
        let hits = 0;
        for (let g = 0; g < CONCEPT_GROUPS.length; g += 1) {
          for (const tok of toks) {
            if (CONCEPT_GROUPS[g].includes(tok)) {
              vec[g] += 1;
              hits += 1;
            }
          }
        }
        // Dilute keyword-stuffed spam descriptions the way real transformers do (mean pooling dilutes density)
        if (toks.length > 14 && hits > 3) {
          for (let g = 0; g < CONCEPT_GROUPS.length; g += 1) vec[g] /= Math.sqrt(toks.length / 4);
        }
        if (hits === 0) {
          for (const tok of toks) {
            let h = 2166136261;
            for (let i = 0; i < tok.length; i += 1) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
            vec[CONCEPT_GROUPS.length + ((h >>> 0) % (dims - CONCEPT_GROUPS.length))] += 1;
          }
        }
        return l2Normalize(vec);
      });
    },
  });
}

function buildCandidates() {
  const out = [];
  for (const conn of CONNECTIONS) {
    for (const tool of conn.tools) {
      const fullToolName = `${conn.id}__${tool.name}`;
      out.push({
        connId: conn.id,
        connName: conn.name,
        connDescription: conn.description,
        categoryId: 'general',
        categoryLabel: 'General',
        toolName: tool.name,
        fullToolName,
        description: tool.description,
        paramKeys: extractSchemaParamKeys(tool.inputSchema),
        paramText: extractSchemaParamText(tool.inputSchema),
        serverInstructions: '',
        brief: '',
        matchedSkillDescription: '',
        haystack: `${fullToolName} ${tool.name} ${tool.description} ${conn.name} ${conn.id} ${conn.description}`,
      });
    }
  }
  return out;
}

async function run() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-bench-'));
  try {
    const candidates = buildCandidates();
    const configured = resolveEmbeddingConfig(process.env, { dataDir: dir });
    const realEmbedder = configured.provider !== 'none' ? createEmbedder(configured) : null;
    const semanticEmbedder = realEmbedder || makeFallbackDemoEmbedder();
    const embedderLabel = realEmbedder
      ? `REAL (${realEmbedder.provider} / ${realEmbedder.modelId})`
      : 'SIMULATED (set LOOP_EMBEDDING_PROVIDER=local|ollama|http to test a real model)';

    const lexicalIndex = new SearchIndex(path.join(dir, 'lex'));
    const lexicalWithExamples = new SearchIndex(path.join(dir, 'lex-ex'));
    const semanticIndex = new SearchIndex(path.join(dir, 'sem'), { embedder: semanticEmbedder });

    const secret = 'bench-secret';
    const signedCatalog = signCatalogBundle(
      { version: 1, modelId: semanticEmbedder.modelId, entries: CATALOG_EXAMPLES },
      { hmacSecret: secret },
    );
    lexicalWithExamples.loadCatalogBundle(signedCatalog, { hmacSecret: secret });
    semanticIndex.loadCatalogBundle(signedCatalog, { hmacSecret: secret });

    // Simulate 1 confirmed (search -> successful run) on the private CRM tool
    for (const idx of [lexicalIndex, lexicalWithExamples, semanticIndex]) {
      idx.recordSearchEvent('bench', 'check customer churn risk score', []);
      await idx.recordSuccessfulToolRun('bench', 'private_crm__fetch_account_health');
    }

    await semanticIndex.syncIndex({ connections: CONNECTIONS, memories: MEMORY_FIXTURE });

    const scoreMode = async (modeName, fn) => {
      let exactHit12 = 0;
      let rewordHit12 = 0;
      let rewordHit1 = 0;
      let privateHit12 = 0;
      let spamHijacks = 0;
      const misses = [];
      for (const tc of TOOL_EVAL_CASES) {
        const top12 = (await fn(tc.query)).slice(0, 12).map((c) => c.fullToolName);
        const found = top12.includes(tc.expect);
        if (tc.group === 'exact' && found) exactHit12 += 1;
        if (tc.group === 'reworded') {
          if (found) rewordHit12 += 1;
          if (top12[0] === tc.expect) rewordHit1 += 1;
          else misses.push(`${tc.query} -> got [${top12.slice(0, 2).join(', ')}] (want ${tc.expect})`);
        }
        if (tc.group === 'private_learned' && found) privateHit12 += 1;
        if (top12.includes('stuffed_spam__spam_widget')) spamHijacks += 1;
      }
      let negFalsePositives = 0;
      for (const nq of NEGATIVE_CASES) {
        const hits = await fn(nq);
        if (hits.length > 0) negFalsePositives += 1;
      }
      return { modeName, exactHit12, rewordHit12, rewordHit1, privateHit12, spamHijacks, negFalsePositives, misses };
    };

    const rLegacy = await scoreMode('1. Legacy substring (before)', (q) => legacySearch(candidates, q, (c) => c.haystack));
    const rBuiltIn = await scoreMode('2. BM25F core (0 ML deps)', async (q) => (await lexicalIndex.searchTools(candidates, q)).items);
    const rBuiltInEx = await scoreMode('3. BM25F + text examples (0 ML)', async (q) => (await lexicalWithExamples.searchTools(candidates, q)).items);
    const rSemantic = await scoreMode('4. + Semantic + Examples (unseen)', async (q) => (await semanticIndex.searchTools(candidates, q)).items);

    // Memory recall comparison
    let memBefore = 0;
    let memAfter = 0;
    const memMinSemantic = semanticIndex.effectiveMinSemanticScore();
    for (const mc of MEMORY_EVAL_CASES) {
      const base = searchMemories(MEMORY_FIXTURE, mc.query);
      if (base[0]?.id === mc.expect) memBefore += 1;
      const semScores = await semanticIndex.scoreMemoriesSemantic(MEMORY_FIXTURE, mc.query);
      const upgraded = searchMemories(MEMORY_FIXTURE, mc.query, { semanticScores: semScores, minSemanticScore: memMinSemantic });
      if (upgraded[0]?.id === mc.expect) memAfter += 1;
    }

    // Quality degradation curve across realistic hub sizes: 15 -> 50 -> 500 -> 5,000 tools
    // Realistic distractors share common SaaS words ("user", "team", "account", "plan", "report", "message", "page", "error", "review")
    // without doing the target job — testing whether the real tool stays in Top-12 and #1 as the hub grows.
    const DISTRACTOR_TEMPLATES = [
      { verb: 'list', noun: 'team_members', desc: 'List active team members and roles for this workspace account.' },
      { verb: 'get', noun: 'plan_limits', desc: 'Get monthly plan usage limits and account billing status.' },
      { verb: 'create', noun: 'status_report', desc: 'Create a weekly status report for the product team.' },
      { verb: 'post', noun: 'audit_note', desc: 'Record an internal audit message or customer note on a record.' },
      { verb: 'update', noun: 'page_metadata', desc: 'Update webpage title, metadata, and visual layout settings.' },
      { verb: 'check', noun: 'error_alert', desc: 'Check recent error notification rules and production alert schedules.' },
      { verb: 'fetch', noun: 'user_activity', desc: 'Fetch recent user signup audit entries and login timestamps.' },
      { verb: 'list', noun: 'review_comments', desc: 'List stakeholder review feedback and approval comments.' },
      { verb: 'export', noun: 'customer_csv', desc: 'Export customer account directory and contact preferences to CSV.' },
      { verb: 'archive', noun: 'old_records', desc: 'Archive inactive records and expired workspace plans.' },
    ];
    const buildDistractorConns = (extraTools) => {
      const out = [];
      let rem = extraTools;
      let appIdx = 0;
      while (rem > 0) {
        const count = Math.min(25, rem);
        const tools = [];
        for (let i = 0; i < count; i += 1) {
          const tpl = DISTRACTOR_TEMPLATES[(appIdx * 7 + i) % DISTRACTOR_TEMPLATES.length];
          tools.push({
            name: `${tpl.verb}_${tpl.noun}_${appIdx}_${i}`,
            description: `${tpl.desc} (App ${appIdx} module ${i}).`,
            inputSchema: { type: 'object', properties: { workspace_id: { type: 'string' }, limit: { type: 'integer' } } },
          });
        }
        out.push({
          id: `saas_app_${appIdx}`,
          name: `SaaS App ${appIdx}`,
          description: `External business app ${appIdx} for operations and team records.`,
          tools,
        });
        rem -= count;
        appIdx += 1;
      }
      return out;
    };

    const degradationCurve = [];
    // Embed the 10 unique distractor descriptions once, then replicate vectors cleanly for 500 & 5,000 tool runs
    // so benchmarking 5,000 real tools stays fast while using genuine model embeddings!
    const tplVecs = await semanticEmbedder.embed(
      DISTRACTOR_TEMPLATES.map(
        (t) => `SaaS App (External business app for operations and team records): ${t.verb} ${t.noun.replace(/_/g, ' ')} — ${t.desc}`,
      ),
      { kind: 'document' },
    );
    const tplInt8 = tplVecs.map((v) => quantizeInt8(v));
    const rewordedCases = TOOL_EVAL_CASES.filter((tc) => tc.group === 'reworded');

    for (const targetTools of [15, 50, 500, 5000]) {
      const extraCount = Math.max(0, targetTools - candidates.length);
      const extraConns = buildDistractorConns(extraCount);
      const extraCands = [];
      const extraVecItems = [];
      let appIdx = 0;
      for (const conn of extraConns) {
        for (let i = 0; i < conn.tools.length; i += 1) {
          const tool = conn.tools[i];
          const fullToolName = `${conn.id}__${tool.name}`;
          extraCands.push({
            connId: conn.id,
            connName: conn.name,
            connDescription: conn.description,
            categoryId: 'general',
            categoryLabel: 'General',
            toolName: tool.name,
            fullToolName,
            description: tool.description,
            paramKeys: extractSchemaParamKeys(tool.inputSchema),
            paramText: extractSchemaParamText(tool.inputSchema),
            serverInstructions: '',
            brief: '',
            matchedSkillDescription: '',
            haystack: `${fullToolName} ${tool.name} ${tool.description} ${conn.name} ${conn.id} ${conn.description}`,
          });
          const tplIdx = (appIdx * 7 + i) % DISTRACTOR_TEMPLATES.length;
          extraVecItems.push({
            key: `tool:${fullToolName}:desc`,
            kind: 'tool',
            parentId: fullToolName,
            slot: 'desc',
            fingerprint: `dist:${fullToolName}`,
            vector: tplInt8[tplIdx],
          });
        }
        appIdx += 1;
      }

      const scaledCands = [...candidates, ...extraCands];
      // Build a dedicated semantic index with base vectors + distractor vectors
      const scaledSem = new SearchIndex(path.join(dir, `curve-${targetTools}`), { embedder: semanticEmbedder });
      await scaledSem.localStore.load(semanticEmbedder.modelId);
      const baseDim = semanticIndex.localStore.dimensions;
      const baseItems = semanticIndex.localStore.entries.map((e, idx) => ({
        key: e.key,
        kind: e.kind,
        parentId: e.parentId,
        slot: e.slot,
        fingerprint: e.fingerprint,
        vector: semanticIndex.localStore.vectors.subarray(idx * baseDim, (idx + 1) * baseDim),
      }));
      scaledSem.localStore.upsertBatch(semanticEmbedder.modelId, [...baseItems, ...extraVecItems]);
      scaledSem._lastToolCount = scaledCands.length;

      // Warm lexical token-bag cache once (matching a running Loop server across queries)
      await lexicalIndex.searchTools(scaledCands, 'warmup_probe');

      let lexTop12 = 0;
      let lexTop1 = 0;
      let lexExTop12 = 0;
      let lexExTop1 = 0;
      let semTop12 = 0;
      let semTop1 = 0;
      let lexTotalMs = 0;
      let semTotalMs = 0;
      const sem5kMisses = [];
      for (const tc of rewordedCases) {
        const tL = performance.now();
        const lHits = (await lexicalIndex.searchTools(scaledCands, tc.query)).items.slice(0, 12).map((c) => c.fullToolName);
        lexTotalMs += performance.now() - tL;
        if (lHits.includes(tc.expect)) lexTop12 += 1;
        if (lHits[0] === tc.expect) lexTop1 += 1;

        const leHits = (await lexicalWithExamples.searchTools(scaledCands, tc.query)).items.slice(0, 12).map((c) => c.fullToolName);
        if (leHits.includes(tc.expect)) lexExTop12 += 1;
        if (leHits[0] === tc.expect) lexExTop1 += 1;

        const tS = performance.now();
        const sHits = (await scaledSem.searchTools(scaledCands, tc.query)).items.slice(0, 12).map((c) => c.fullToolName);
        semTotalMs += performance.now() - tS;
        if (sHits.includes(tc.expect)) semTop12 += 1;
        if (sHits[0] === tc.expect) semTop1 += 1;
        else if (targetTools === 5000) sem5kMisses.push(`${tc.query} -> got [${sHits.slice(0, 3).join(', ')}]`);
      }
      degradationCurve.push({
        Tools: scaledCands.length,
        'BM25F Top-12': `${lexTop12}/${rewordedCases.length}`,
        'BM25F #1': `${lexTop1}/${rewordedCases.length}`,
        'BM25F+Ex Top-12': `${lexExTop12}/${rewordedCases.length}`,
        'BM25F ms': (lexTotalMs / rewordedCases.length).toFixed(1),
        'Semantic Top-12': `${semTop12}/${rewordedCases.length}`,
        'Semantic #1': `${semTop1}/${rewordedCases.length}`,
        'Semantic ms': (semTotalMs / rewordedCases.length).toFixed(1),
      });
      if (sem5kMisses.length > 0) {
        console.log('\n[5000-tool Semantic non-#1 diagnostics]:');
        for (const m of sem5kMisses) console.log('  -', m);
      }
    }

    // Scale timing: 500 vs 5,000 tools (int8 binary reload + scan)
    const scaleStats = [];
    for (const toolCount of [500, 5000]) {
      const sDir = path.join(dir, `scale-${toolCount}`);
      const store = new LocalBinaryVectorStore(sDir);
      await store.load('scale:384');
      const DIM = 384;
      const qVec = l2Normalize(Array.from({ length: DIM }, (_, d) => (d === 0 ? 1 : 0.01)));
      const qInt8 = quantizeInt8(qVec);
      const batch = [];
      for (let i = 0; i < toolCount; i += 1) {
        for (let s = 0; s < 4; s += 1) {
          batch.push({
            key: `tool:t_${i}:${s === 0 ? 'desc' : `ex:${s}`}`,
            kind: 'tool',
            parentId: `t_${i}`,
            slot: s === 0 ? 'desc' : `ex:${s}`,
            fingerprint: `fp_${i}_${s}`,
            vector: qInt8,
          });
        }
      }
      store.upsertBatch('scale:384', batch);
      await store.flush();

      const tReload = performance.now();
      const reloaded = new LocalBinaryVectorStore(sDir);
      await reloaded.load('scale:384');
      const reloadMs = performance.now() - tReload;

      const scanTimes = [];
      for (let r = 0; r < 15; r += 1) {
        const t0 = performance.now();
        reloaded.scoreByKind('tool', qVec);
        scanTimes.push(performance.now() - t0);
      }
      scanTimes.sort((a, b) => a - b);
      scaleStats.push({
        tools: toolCount,
        vectors: toolCount * 4,
        vectorMb: (reloaded.vectors.byteLength / (1024 * 1024)).toFixed(2),
        reloadMs: reloadMs.toFixed(1),
        scanMedianMs: scanTimes[Math.floor(scanTimes.length / 2)].toFixed(2),
      });
    }

    console.log('\n=== Loop Search Head-to-Head Benchmark ===');
    console.log(`Semantic embedder: ${embedderLabel}\n`);
    console.table(
      [rLegacy, rBuiltIn, rBuiltInEx, rSemantic].map((r) => ({
        Mode: r.modeName,
        'Exact/Param (4)': `${r.exactHit12}/4`,
        'Unseen Top-12 (8)': `${r.rewordHit12}/8`,
        'Unseen #1 (8)': `${r.rewordHit1}/8`,
        'Private Learned (1)': `${r.privateHit12}/1`,
        'Spam Hijacks (lower=better)': r.spamHijacks,
        'Neg False Pos (3, lower=better)': r.negFalsePositives,
      })),
    );
    if (rSemantic.misses.length > 0) {
      console.log('Semantic non-#1 details:', rSemantic.misses);
    }
    console.log(`Memory Recall #1: Built-in lexical ${memBefore}/${MEMORY_EVAL_CASES.length} -> With Semantic ${memAfter}/${MEMORY_EVAL_CASES.length}\n`);
    console.log('=== Quality & Speed Across Hub Scale (15 -> 50 -> 500 -> 5,000 tools) ===');
    console.table(degradationCurve);
    console.log('\n=== Binary int8 Vector Scale (384-dim x 4 vectors/tool) ===');
    console.table(scaleStats);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await run();
