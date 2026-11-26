import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HOST_ONLY_BUNDLED_SKILLS,
  SkillStore,
  buildSkillsBeforeAfterVisual,
  cleanupAgentSkills,
  discoverSkillSources,
  hashSkillTree,
  importSkillsFromAgents,
  isLoopSelfSkill,
  isNativeOrSystemSkill,
  parseFrontmatter,
  publicSkillMeta,
  skillSourceDefinitions,
} from '../lib/skills.mjs';

async function exists(p) {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function createSkill(dir, { name, description, body = '# Instructions\nDo the thing.\n', extraFiles = {} }) {
  await mkdir(dir, { recursive: true });
  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    body,
  ].join('\n');
  await writeFile(path.join(dir, 'SKILL.md'), frontmatter, 'utf8');
  for (const [rel, content] of Object.entries(extraFiles)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
}

describe('Frontmatter & classification helpers', () => {
  it('parses single-line, quoted, folded (>-), and literal (|) YAML frontmatter', () => {
    const simple = parseFrontmatter(`---\nname: pdf-reader\ndescription: Extract text from PDFs\n---\n# Body`);
    assert.deepEqual(simple, { name: 'pdf-reader', description: 'Extract text from PDFs' });

    const quoted = parseFrontmatter(
      `---\r\nname: "quote-skill"\r\ndescription: "Use when: user needs \\"quoted\\" text"\r\n---\r\n`,
    );
    assert.deepEqual(quoted, { name: 'quote-skill', description: 'Use when: user needs "quoted" text' });

    const singleQuoted = parseFrontmatter(
      `---\nname: 'single-skill'\ndescription: 'It''s a single-quoted value'\n---\n`,
    );
    assert.deepEqual(singleQuoted, { name: 'single-skill', description: "It's a single-quoted value" });

    const folded = parseFrontmatter(
      `---\nname: deploy-app\ndescription: >-\n  Deploy web services safely.\n  Handles rollbacks automatically.\n---\n# Deploy`,
    );
    assert.deepEqual(folded, {
      name: 'deploy-app',
      description: 'Deploy web services safely. Handles rollbacks automatically.',
    });

    const literal = parseFrontmatter(
      `---\nname: runbook\ndescription: |\n  Step one.\n  Step two.\n---\n`,
    );
    assert.deepEqual(literal, {
      name: 'runbook',
      description: 'Step one.\nStep two.',
    });

    assert.deepEqual(parseFrontmatter('# No frontmatter here'), { name: '', description: '' });
  });

  it('classifies native/system skills and Loop self skill accurately', () => {
    assert.ok(isNativeOrSystemSkill('.system', '/home/user/.codex/skills/.system'));
    assert.ok(isNativeOrSystemSkill('.DS_Store', '/home/user/.claude/skills/.DS_Store'));
    assert.ok(isNativeOrSystemSkill('guide', '/Users/me/.gemini/antigravity/builtin/skills/guide'));
    assert.ok(isNativeOrSystemSkill('helper', '/Applications/SomeApp.app/Contents/skills/helper'));
    assert.ok(isNativeOrSystemSkill('bundled', '/opt/openai-bundled/skills/bundled'));
    assert.ok(isNativeOrSystemSkill('sys-tool', '/Users/me/.codex/skills/.system/sys-tool'));
    assert.equal(isNativeOrSystemSkill('my-custom-skill', '/Users/me/.claude/skills/my-custom-skill'), null);

    assert.equal(isLoopSelfSkill('loop', '/Users/me/.claude/skills/loop'), true);
    assert.equal(isLoopSelfSkill('Loop', '/Users/me/.claude/skills/Loop'), true);
    assert.equal(isLoopSelfSkill('loop-hub', '/Users/me/Dev/loop/skills/loop'), true);
    assert.equal(isLoopSelfSkill('other-skill', '/Users/me/.claude/skills/other-skill'), false);
  });

  it('defines the 5 user skill source directories under the given home', () => {
    const defs = skillSourceDefinitions({ home: '/fake/home' });
    assert.deepEqual(
      defs.map((d) => [d.id, d.dir]),
      [
        ['claude-code', path.join('/fake/home', '.claude', 'skills')],
        ['codex', path.join('/fake/home', '.codex', 'skills')],
        ['antigravity', path.join('/fake/home', '.gemini', 'config', 'skills')],
        ['cursor', path.join('/fake/home', '.cursor', 'skills')],
        ['shared-agents', path.join('/fake/home', '.agents', 'skills')],
      ],
    );
  });
});

describe('SkillStore', () => {
  let tmp;
  let store;

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-skills-store-'));
    store = new SkillStore(path.join(tmp, 'data'), { bundledDir: null });
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('starts empty, saves from directory (skipping .git & node_modules), lists, gets, searches, and removes', async () => {
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.get('missing'), null);
    assert.equal(await store.get('../escape'), null);

    const srcSkill = path.join(tmp, 'src', 'design-review');
    await createSkill(srcSkill, {
      name: 'design-review',
      description: 'Audit UI layout, spacing, and accessibility in web apps.',
      body: '# Design Review\nCheck contrast and grid rhythm.\n',
      extraFiles: {
        'scripts/check.sh': '#!/bin/sh\necho ok\n',
        'references/checklist.md': '- Contrast >= 4.5:1\n',
        '.git/HEAD': 'ref: refs/heads/main\n',
        'node_modules/pkg/index.js': 'export default 1;\n',
      },
    });

    const saved = await store.saveFromDir('design-review', srcSkill, { source: 'Claude Code' });
    assert.equal(saved.id, 'design-review');
    assert.equal(saved.name, 'design-review');
    assert.equal(saved.source, 'Claude Code');
    assert.ok(saved.importedAt);
    assert.deepEqual(saved.files, ['references/checklist.md', 'scripts/check.sh']);

    // Verify .git and node_modules were excluded from the copied skill directory.
    assert.equal(await exists(path.join(saved.path, '.git')), false);
    assert.equal(await exists(path.join(saved.path, 'node_modules')), false);

    // Add a second skill for search and sorting checks.
    const srcSecond = path.join(tmp, 'src', 'api-tester');
    await createSkill(srcSecond, {
      name: 'api-tester',
      description: 'Run contract tests against REST and GraphQL endpoints.',
    });
    await store.saveFromDir('api-tester', srcSecond, { source: 'Codex' });

    const listed = await store.list();
    assert.deepEqual(listed.map((s) => s.id), ['api-tester', 'design-review']);

    // get() returns full SKILL.md content + auxiliary files.
    const full = await store.get('design-review');
    assert.ok(full);
    assert.equal(full.id, 'design-review');
    assert.deepEqual(full.files, ['references/checklist.md', 'scripts/check.sh']);
    assert.match(full.content, /# Design Review/);
    assert.match(full.content, /Check contrast and grid rhythm/);

    // search() matches across id, name, description, and source (tokens & substrings).
    assert.deepEqual(
      (await store.search('accessibility layout')).map((s) => s.id),
      ['design-review'],
    );
    assert.deepEqual(
      (await store.search('codex')).map((s) => s.id),
      ['api-tester'],
    );
    assert.equal((await store.search('')).length, 2);

    // Rejects invalid slugs or dirs without SKILL.md.
    await assert.rejects(() => store.saveFromDir('../bad', srcSkill), /Invalid skill slug/);
    const noMdDir = path.join(tmp, 'src', 'not-a-skill');
    await mkdir(noMdDir, { recursive: true });
    await assert.rejects(() => store.saveFromDir('not-a-skill', noMdDir), /missing a readable SKILL\.md/i);

    // remove() deletes skill directory and metadata.
    assert.equal(await store.remove('api-tester'), true);
    assert.equal(await store.remove('api-tester'), false);
    assert.equal(await store.remove('../bad'), false);
    assert.deepEqual((await store.list()).map((s) => s.id), ['design-review']);
  });

  it('includes bundled Loop workflow skills and core guide, supports user overrides, and refuses bundled deletion', async () => {
    const bundledStore = new SkillStore(path.join(tmp, 'bundled-data'));

    // Default bundledDir loads bundled Loop workflow skills including loop itself.
    const listed = await bundledStore.list();
    assert.deepEqual(listed.map((s) => s.id), ['capability-ladder', 'connections', 'dream', 'find-capability', 'fix-connection', 'learn-workflow', 'loop', 'organize', 'setup-project', 'skills', 'sync-agents', 'vault']);
    // Old bundled slug still resolves quietly as an alias.
    assert.equal((await bundledStore.get('setup-profile'))?.id, 'setup-project');
    assert.equal((await bundledStore.get('system:setup-profile'))?.id, 'setup-project');
    for (const item of listed) {
      assert.equal(item.source, 'Loop built-in');
      assert.equal(item.bundled, true);
    }

    // get() returns full content for bundled workflow skills including the core guide.
    assert.equal((await bundledStore.get('loop')).systemId, 'system:loop');
    const findSkill = await bundledStore.get('find-capability');
    assert.ok(findSkill);
    assert.equal(findSkill.source, 'Loop built-in');
    assert.equal(findSkill.bundled, true);
    assert.match(findSkill.content, /loop__save/);
    const syncSkill = await bundledStore.get('sync-agents');
    assert.ok(syncSkill);
    assert.equal(syncSkill.source, 'Loop built-in');
    assert.equal(syncSkill.bundled, true);
    assert.match(syncSkill.content, /loop_host__discover/);
    assert.match(syncSkill.content, /loop_host__import/);
    assert.match(syncSkill.content, /loop_host__cleanup/);

    const orgSkill = await bundledStore.get('organize');
    assert.ok(orgSkill);
    assert.equal(orgSkill.source, 'Loop built-in');
    assert.equal(orgSkill.bundled, true);
    assert.match(orgSkill.content, /loop__search/);
    assert.match(orgSkill.content, /loop__save/);
    assert.match(orgSkill.content, /dryRun/);

    // search() includes bundled skills with source and bundled flag.
    const allSearch = await bundledStore.search('');
    assert.deepEqual(allSearch.map((s) => s.id), ['capability-ladder', 'connections', 'dream', 'find-capability', 'fix-connection', 'learn-workflow', 'loop', 'organize', 'setup-project', 'skills', 'sync-agents', 'vault']);
    assert.equal(allSearch[0].bundled, true);
    assert.equal(allSearch[0].source, 'Loop built-in');

    const orgSearch = await bundledStore.search('categorize');
    assert.deepEqual(orgSearch.map((s) => s.id), ['organize']);
    assert.equal(orgSearch[0].bundled, true);

    const syncSearch = await bundledStore.search('sync-agents');
    assert.deepEqual(syncSearch.map((s) => s.id), ['sync-agents']);
    assert.equal(syncSearch[0].bundled, true);

    // remove() refuses to delete read-only bundled skills and returns false.
    assert.equal(await bundledStore.remove('find-capability'), false);
    assert.equal(await bundledStore.remove('sync-agents'), false);
    assert.equal(await bundledStore.remove('organize'), false);
    assert.ok(await bundledStore.get('find-capability'));
    assert.ok(await bundledStore.get('sync-agents'));
    assert.ok(await bundledStore.get('organize'));

    // User copy in skillsDir overrides bundled skill until removed.
    const overrideSrc = path.join(tmp, 'src', 'custom-organize');
    await createSkill(overrideSrc, {
      name: 'organize',
      description: 'My custom org override.',
      body: '# Custom Organize\nUse my custom buckets.\n',
    });
    await bundledStore.saveFromDir('organize', overrideSrc, { source: 'Manual' });

    const overriddenList = await bundledStore.list();
    assert.deepEqual(overriddenList.map((s) => s.id), ['capability-ladder', 'connections', 'dream', 'find-capability', 'fix-connection', 'learn-workflow', 'loop', 'organize', 'setup-project', 'skills', 'sync-agents', 'system:organize', 'vault']);
    const overriddenItem = overriddenList.find((s) => s.id === 'organize');
    assert.equal(overriddenItem.source, 'Manual');
    assert.equal(overriddenItem.bundled, undefined);

    const overriddenFull = await bundledStore.get('organize');
    assert.equal(overriddenFull.source, 'Manual');
    assert.equal(overriddenFull.bundled, undefined);
    assert.match(overriddenFull.content, /Use my custom buckets/);

    // Removing the user override succeeds and falls back to the intact bundled copy.
    assert.equal(await bundledStore.remove('organize'), true);
    assert.equal(await bundledStore.remove('organize'), false);
    const restored = await bundledStore.get('organize');
    assert.ok(restored);
    assert.equal(restored.source, 'Loop built-in');
    assert.equal(restored.bundled, true);

    // Missing custom bundledDir degrades cleanly to empty.
    const missingBundled = new SkillStore(path.join(tmp, 'missing-bundled-data'), {
      bundledDir: path.join(tmp, 'does-not-exist'),
    });
    assert.deepEqual(await missingBundled.list(), []);
    assert.equal(await missingBundled.get('organize'), null);
  });
});

describe('Discovery, Import, Cleanup, and Visual Diagram', () => {
  let tmp;
  let home;
  let store;
  let sharedTarget;
  let loopRepoSkill;
  let builtinTarget;

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-skills-hub-'));
    home = path.join(tmp, 'home');
    store = new SkillStore(path.join(tmp, 'loop-data'), { bundledDir: null });

    // Pre-populate one skill already in Loop.
    const preDir = path.join(tmp, 'pre', 'already-there');
    await createSkill(preDir, {
      name: 'already-there',
      description: 'Skill that already lives in Loop.',
    });
    await store.saveFromDir('already-there', preDir, { source: 'Manual' });

    // Create external targets for symlinks.
    loopRepoSkill = path.join(tmp, 'dev', 'loop', 'skills', 'loop');
    await createSkill(loopRepoSkill, {
      name: 'loop',
      description: 'Loop MCP gateway skill.',
    });

    builtinTarget = path.join(tmp, 'app', 'builtin', 'skills', 'harness-guide');
    await createSkill(builtinTarget, {
      name: 'harness-guide',
      description: 'Built-in harness guide.',
    });

    // Shared ~/.agents/skills directory containing a real skill symlinked by Claude & Codex.
    const sharedDir = path.join(home, '.agents', 'skills');
    sharedTarget = path.join(sharedDir, 'shared-helper');
    await createSkill(sharedTarget, {
      name: 'shared-helper',
      description: 'Shared across multiple agents via symlink.',
      extraFiles: { 'scripts/run.mjs': 'console.log("hi");\n' },
    });

    // Claude Code skills directory
    const claudeDir = path.join(home, '.claude', 'skills');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(path.join(claudeDir, '.DS_Store'), 'junk', 'utf8');
    await writeFile(path.join(claudeDir, 'notes.txt'), 'not a skill', 'utf8');
    await mkdir(path.join(claudeDir, 'empty-folder'), { recursive: true });
    await createSkill(path.join(claudeDir, 'frontend-design'), {
      name: 'frontend-design',
      description: 'Craft distinctive frontend interfaces.',
      extraFiles: { 'references/tokens.md': '# Tokens\n' },
    });
    await createSkill(path.join(claudeDir, 'already-there'), {
      name: 'already-there',
      description: 'Skill that already lives in Loop.',
    });
    await createSkill(path.join(claudeDir, 'unimported-wip'), {
      name: 'unimported-wip',
      description: 'Work-in-progress skill we will intentionally skip during partial import.',
    });
    await symlink(sharedTarget, path.join(claudeDir, 'shared-helper'));
    await symlink(loopRepoSkill, path.join(claudeDir, 'loop'));
    await symlink(path.join(tmp, 'does-not-exist'), path.join(claudeDir, 'broken-link'));

    // Codex skills directory (has .system native folder, duplicate frontend-design, unique sql-audit, loop)
    const codexDir = path.join(home, '.codex', 'skills');
    await mkdir(path.join(codexDir, '.system', 'skill-installer'), { recursive: true });
    await writeFile(path.join(codexDir, '.system', 'skill-installer', 'SKILL.md'), '---\nname: skill-installer\n---\n', 'utf8');
    await createSkill(path.join(codexDir, 'frontend-design'), {
      name: 'frontend-design',
      description: 'Craft distinctive frontend interfaces.',
      extraFiles: { 'references/tokens.md': '# Tokens\n' },
    });
    await createSkill(path.join(codexDir, 'sql-audit'), {
      name: 'sql-audit',
      description: 'Review SQL migrations for lock safety.',
    });
    await symlink(sharedTarget, path.join(codexDir, 'shared-helper'));
    await createSkill(path.join(codexDir, 'loop'), {
      name: 'loop',
      description: 'Loop skill copy.',
    });

    // Cursor skills directory (has duplicate frontend-design, native builtin symlink, unique cursor-refactor)
    const cursorDir = path.join(home, '.cursor', 'skills');
    await mkdir(cursorDir, { recursive: true });
    await createSkill(path.join(cursorDir, 'frontend-design'), {
      name: 'frontend-design',
      description: 'Craft distinctive frontend interfaces.',
      extraFiles: { 'references/tokens.md': '# Tokens\n' },
    });
    await createSkill(path.join(cursorDir, 'cursor-refactor'), {
      name: 'cursor-refactor',
      description: 'Safe multi-file refactoring checklist.',
    });
    await symlink(builtinTarget, path.join(cursorDir, 'harness-guide'));
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('discoverSkillSources skips .system (native), keeps loop (self), deduplicates, and resolves symlinks cleanly', async () => {
    const res = await discoverSkillSources(store, { home });
    const bySource = Object.fromEntries(res.sources.map((s) => [s.id, s]));

    // Claude Code checks
    const claudeSkills = Object.fromEntries(bySource['claude-code'].skills.map((s) => [s.id, s]));
    assert.equal(claudeSkills['frontend-design'].status, 'new');
    assert.equal(claudeSkills['shared-helper'].status, 'new');
    assert.equal(claudeSkills['shared-helper'].isSymlink, true);
    assert.equal(claudeSkills['already-there'].status, 'exists');
    assert.equal(claudeSkills['already-there'].reason, 'Already in Loop');
    assert.equal(claudeSkills['unimported-wip'].status, 'new');
    assert.equal(claudeSkills['loop'].status, 'self');
    assert.equal(claudeSkills['loop'].reason, 'Loop skill (always kept)');
    // .DS_Store, notes.txt, empty-folder, and broken-link are skipped cleanly
    assert.equal(claudeSkills['.DS_Store'], undefined);
    assert.equal(claudeSkills['notes.txt'], undefined);
    assert.equal(claudeSkills['empty-folder'], undefined);
    assert.equal(claudeSkills['broken-link'], undefined);

    // Codex checks
    const codexSkills = Object.fromEntries(bySource['codex'].skills.map((s) => [s.id, s]));
    assert.equal(codexSkills['.system'].status, 'native');
    assert.equal(codexSkills['.system'].reason, 'Native built-in to this harness (never imported)');
    assert.equal(codexSkills['frontend-design'].status, 'duplicate');
    assert.equal(codexSkills['frontend-design'].reason, 'Same skill as Claude Code');
    assert.equal(codexSkills['shared-helper'].status, 'duplicate');
    assert.equal(codexSkills['sql-audit'].status, 'new');
    assert.equal(codexSkills['loop'].status, 'self');

    // Cursor checks
    const cursorSkills = Object.fromEntries(bySource['cursor'].skills.map((s) => [s.id, s]));
    assert.equal(cursorSkills['frontend-design'].status, 'duplicate');
    assert.equal(cursorSkills['frontend-design'].reason, 'Same skill as Claude Code');
    assert.equal(cursorSkills['cursor-refactor'].status, 'new');
    assert.equal(cursorSkills['harness-guide'].status, 'native');

    // Shared Agents checks (shared-helper already seen via Claude Code)
    const sharedSkills = Object.fromEntries(bySource['shared-agents'].skills.map((s) => [s.id, s]));
    assert.equal(sharedSkills['shared-helper'].status, 'duplicate');
    assert.equal(sharedSkills['shared-helper'].reason, 'Same skill as Claude Code');

    // Summary counts:
    // new: frontend-design, shared-helper, unimported-wip, sql-audit, cursor-refactor = 5
    // exists: already-there = 1
    // duplicate: codex/frontend-design, codex/shared-helper, cursor/frontend-design, shared-agents/shared-helper = 4
    // native: codex/.system, cursor/harness-guide = 2
    // self: claude/loop, codex/loop = 2
    // totalFound = 14
    assert.deepEqual(res.summary, {
      totalFound: 14,
      newCount: 5,
      existsCount: 1,
      duplicateCount: 4,
      nativeCount: 2,
    });
  });

  it('importSkillsFromAgents supports source filter, dryRun preview, and selective real import', async () => {
    const codexOnly = await importSkillsFromAgents(store, { source: 'codex', dryRun: true, ctx: { home } });
    assert.deepEqual(codexOnly.sources.map((s) => s.id), ['codex']);
    // When scoped only to codex, frontend-design, shared-helper, and sql-audit are all 'new'.
    assert.equal(codexOnly.summary.newCount, 3);
    assert.equal(codexOnly.summary.nativeCount, 1);

    const preview = await importSkillsFromAgents(store, { dryRun: true, ctx: { home } });
    assert.equal(preview.before.skills, 1);
    assert.equal(preview.summary.newCount, 5);
    assert.match(preview.visual, /^### Before — /m);
    assert.match(preview.visual, /^### After Loop \(preview\)$/m);
    assert.match(preview.visual, /_Each agent keeps only native built-ins \+ `loop`\._/);
    assert.match(preview.visual, /\*\*6 shared skills ready\*\*/);
    assert.doesNotMatch(preview.visual, /[┌┐└┘│├┤─▼►]/);
    // Dry run must not write anything to store.
    assert.equal((await store.list()).length, 1);

    // Import everything EXCEPT unimported-wip using keys subset so we can test cleanup preserves unimported skills!
    const importedRes = await importSkillsFromAgents(store, {
      dryRun: false,
      keys: [
        'claude-code::frontend-design',
        'claude-code::shared-helper',
        'codex::sql-audit',
        'cursor::cursor-refactor',
      ],
      ctx: { home },
    });

    assert.equal(importedRes.before.skills, 1);
    assert.equal(importedRes.after.skills, 5);
    assert.equal(importedRes.summary.imported, 4);
    assert.ok(importedRes.summary.skipped >= 1);
    assert.deepEqual(
      importedRes.imported.map((s) => s.id).sort(),
      ['cursor-refactor', 'frontend-design', 'shared-helper', 'sql-audit'],
    );
    assert.match(importedRes.visual, /\*\*5 shared skills ready\*\*/);
    assert.doesNotMatch(importedRes.visual, /\(preview\)/);

    // Verify SkillStore.search and SkillStore.get on imported skills (including dereferenced symlink files).
    const found = await store.search('migrations lock');
    assert.deepEqual(found.map((s) => s.id), ['sql-audit']);

    const sharedRec = await store.get('shared-helper');
    assert.ok(sharedRec);
    assert.deepEqual(sharedRec.files, ['scripts/run.mjs']);
    assert.match(sharedRec.content, /Shared across multiple agents via symlink/);

    // unimported-wip was NOT imported.
    assert.equal(await store.get('unimported-wip'), null);
  });

  it('cleanupAgentSkills previews in dryRun and safely backs up & removes only Loop-confirmed skills', async () => {
    const preview = await cleanupAgentSkills(store, { dryRun: true, ctx: { home } });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.backupDir, null);
    assert.equal(preview.totalLoopSkills, 5);
    // Removals expected:
    // claude-code: already-there, frontend-design, shared-helper (3)
    // codex: frontend-design, shared-helper, sql-audit (3)
    // cursor: cursor-refactor, frontend-design (2)
    // shared-agents: shared-helper (1)
    // Total = 9
    assert.equal(preview.totalRemoved, 9);
    assert.match(preview.visual, /^### After Loop \(preview\)$/m);
    assert.match(preview.visual, /still kept: `unimported-wip`/);

    // Verify dryRun touched nothing on disk.
    assert.equal(await exists(path.join(home, '.claude', 'skills', 'frontend-design')), true);
    assert.equal(await exists(path.join(home, '.claude', 'skills', 'shared-helper')), true);

    // Execute real cleanup!
    const cleaned = await cleanupAgentSkills(store, { dryRun: false, ctx: { home } });
    assert.equal(cleaned.dryRun, false);
    assert.equal(cleaned.totalRemoved, 9);
    assert.equal(cleaned.totalLoopSkills, 5);
    assert.ok(cleaned.backupDir);
    assert.match(cleaned.visual, /^### Before — 10 scattered user skills across 4 apps$/m);
    assert.match(cleaned.visual, /^### After Loop$/m);
    assert.match(cleaned.visual, /_Each agent keeps only native built-ins \+ `loop`\._/);
    assert.match(cleaned.visual, /\*\*5 shared skills ready\*\*/);
    assert.doesNotMatch(cleaned.visual, /[┌┐└┘│├┤─▼►]/);

    // Confirmed-in-Loop skills were removed from agent dirs:
    assert.equal(await exists(path.join(home, '.claude', 'skills', 'frontend-design')), false);
    assert.equal(await exists(path.join(home, '.claude', 'skills', 'already-there')), false);
    assert.equal(await exists(path.join(home, '.claude', 'skills', 'shared-helper')), false);
    assert.equal(await exists(path.join(home, '.codex', 'skills', 'sql-audit')), false);
    assert.equal(await exists(path.join(home, '.codex', 'skills', 'shared-helper')), false);
    assert.equal(await exists(path.join(home, '.cursor', 'skills', 'cursor-refactor')), false);
    assert.equal(await exists(path.join(home, '.agents', 'skills', 'shared-helper')), false);

    // Safety guarantees: .system, loop, native builtin, unimported-wip, non-skill files ALL preserved!
    assert.equal(await exists(path.join(home, '.codex', 'skills', '.system', 'skill-installer', 'SKILL.md')), true);
    assert.equal(await exists(path.join(home, '.claude', 'skills', 'loop')), true);
    assert.equal(await exists(path.join(home, '.codex', 'skills', 'loop', 'SKILL.md')), true);
    assert.equal(await exists(path.join(home, '.cursor', 'skills', 'harness-guide')), true);
    assert.equal(await exists(path.join(home, '.claude', 'skills', 'unimported-wip', 'SKILL.md')), true);
    assert.equal(await exists(path.join(home, '.claude', 'skills', 'notes.txt')), true);
    assert.equal(await exists(path.join(home, '.claude', 'skills', '.DS_Store')), true);

    // Backups exist for moved directories AND symlinks.json manifest exists for unlinked symlinks!
    await access(path.join(cleaned.backupDir, 'claude-code', 'frontend-design', 'SKILL.md'));
    await access(path.join(cleaned.backupDir, 'claude-code', 'frontend-design', 'references', 'tokens.md'));
    await access(path.join(cleaned.backupDir, 'codex', 'sql-audit', 'SKILL.md'));
    await access(path.join(cleaned.backupDir, 'shared-agents', 'shared-helper', 'scripts', 'run.mjs'));

    const claudeSymlinks = JSON.parse(
      await readFile(path.join(cleaned.backupDir, 'claude-code', 'symlinks.json'), 'utf8'),
    );
    assert.equal(claudeSymlinks.length, 1);
    assert.equal(claudeSymlinks[0].name, 'shared-helper');
    assert.equal(claudeSymlinks[0].target, sharedTarget);

    // Loop's own copy of shared-helper is still completely intact even after ~/.agents/skills/shared-helper was moved!
    const intact = await store.get('shared-helper');
    assert.ok(intact);
    assert.deepEqual(intact.files, ['scripts/run.mjs']);
  });

  it('buildSkillsBeforeAfterVisual renders clean Markdown, truncates >4 skills, and handles empty state', () => {
    const diagram = buildSkillsBeforeAfterVisual(
      [
        {
          label: 'Claude Code',
          beforeNames: ['a', 'b', 'c', 'd', 'e', 'f'],
          afterNames: [],
          hasLoop: true,
          nativeNames: [],
        },
        {
          label: 'Codex',
          beforeNames: ['a'],
          afterNames: ['local-only'],
          hasLoop: true,
          nativeNames: ['.system'],
        },
      ],
      12,
      { dryRun: true },
    );

    assert.match(diagram, /^### Before — 7 scattered user skills across 2 apps$/m);
    assert.match(diagram, /- \*\*Claude Code\*\* \(6\): `a`, `b`, `c`, `d`, \+2 more/);
    assert.match(diagram, /^### After Loop \(preview\)$/m);
    assert.match(diagram, /_Each agent keeps only native built-ins \+ `loop`\._/);
    assert.match(diagram, /- \*\*Claude Code\*\*: `loop` — clean/);
    assert.match(diagram, /- \*\*Codex\*\*: `native \+ loop` — still kept: `local-only`/);
    assert.match(
      diagram,
      /\*\*12 shared skills ready\*\* — available to every agent via `loop__search\(\{ type: "skills" \}\)`\./,
    );
    assert.doesNotMatch(diagram, /[┌┐└┘│├┤─▼►]/);

    const empty = buildSkillsBeforeAfterVisual([], 0, { dryRun: false });
    assert.match(empty, /^### Before — 0 scattered user skills across 0 apps$/m);
    assert.match(empty, /- No scattered user skills found\./);
    assert.match(empty, /- All agents are clean\./);
    assert.match(empty, /\*\*0 shared skills ready\*\*/);
    assert.doesNotMatch(empty, /[┌┐└┘│├┤─▼►]/);
  });
});

describe('Wave 1 Skills Hardening (G6-09, G6-10, G6-14, G6-15, G6-18, G6-22, G6-25, G5-18, G3a-17, G6-26)', () => {
  it('G6-22: single-pass YAML escape decoding, trailing # comments, empty frontmatter, and save round-trip', async () => {
    // Backslash escape round-trip: \\n must become literal \n, NOT a newline!
    const escaped = parseFrontmatter(
      '---\nname: "win-path"\ndescription: "Path C:\\\\new\\\\tab \\"quoted\\" \\u0041 line1\\nline2"\n---\n# Body\n',
    );
    assert.deepEqual(escaped, {
      name: 'win-path',
      description: 'Path C:\\new\\tab "quoted" A line1\nline2',
    });

    // Unquoted trailing # comments are stripped while non-whitespace # (e.g. C#, F#) is preserved.
    const commented = parseFrontmatter(
      [
        '---',
        '# leading comment',
        'name: csharp-helper # trailing comment on name',
        'description: Build C# and F# APIs # trailing comment on desc',
        '---',
        '# Body',
      ].join('\n'),
    );
    assert.deepEqual(commented, {
      name: 'csharp-helper',
      description: 'Build C# and F# APIs',
    });

    // Quoted scalars with # inside quotes and trailing # comments outside quotes.
    const quotedComment = parseFrontmatter(
      [
        '---',
        'name: "quoted # kept" # ignored trailing comment',
        "description: 'single # kept' # ignored trailing comment",
        '---',
      ].join('\n'),
    );
    assert.deepEqual(quotedComment, {
      name: 'quoted # kept',
      description: 'single # kept',
    });

    // Empty frontmatter must NOT swallow the body up to a later horizontal rule `---`.
    const emptyLf = parseFrontmatter('---\n---\n# Real Body\nname: body-trap\ndescription: swallowed\n---\n');
    assert.deepEqual(emptyLf, { name: '', description: '' });
    const emptyCrlf = parseFrontmatter('---\r\n---\r\n# Real Body\r\nname: body-trap\r\n---\r\n');
    assert.deepEqual(emptyCrlf, { name: '', description: '' });

    // Save round-trip preserves literal backslashes and quotes.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-g6-22-'));
    try {
      const store = new SkillStore(path.join(tmp, 'data'), { bundledDir: null });
      const rawDesc = 'Inspect C:\\new\\test\\path and "quoted" strings';
      await store.saveSkillMarkdown('win-helper', {
        name: 'win-helper',
        description: rawDesc,
        content: '# Body\nSteps.\n',
      });
      const rec = await store.get('win-helper');
      assert.equal(rec.description, rawDesc);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('G6-25: saveFromDir confines symlinks within srcDir and enforces file/byte caps', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-g6-25-'));
    try {
      const store = new SkillStore(path.join(tmp, 'data'), { bundledDir: null });
      const secretOutside = path.join(tmp, 'secret_id_rsa');
      await writeFile(secretOutside, 'PRIVATE-KEY-DO-NOT-COPY', 'utf8');
      const outsideDir = path.join(tmp, 'outside-dir');
      await mkdir(outsideDir, { recursive: true });
      await writeFile(path.join(outsideDir, 'passwd.txt'), 'root:x:0:0', 'utf8');

      // 1. Escaping file symlink and escaping dir symlink are NEVER copied; internal symlink IS copied.
      const srcDir = path.join(tmp, 'src-skill');
      await createSkill(srcDir, {
        name: 'confined-skill',
        description: 'Tests symlink confinement.',
        extraFiles: { 'references/real.md': '# Safe ref\n' },
      });
      await symlink(secretOutside, path.join(srcDir, 'stolen-key.txt'));
      await symlink(outsideDir, path.join(srcDir, 'escaped-dir'));
      await symlink(path.join(srcDir, 'references', 'real.md'), path.join(srcDir, 'internal-alias.md'));

      const saved = await store.saveFromDir('confined-skill', srcDir);
      assert.equal(await exists(path.join(saved.path, 'stolen-key.txt')), false);
      assert.equal(await exists(path.join(saved.path, 'escaped-dir')), false);
      assert.equal(await exists(path.join(saved.path, 'internal-alias.md')), true);
      assert.equal(await readFile(path.join(saved.path, 'internal-alias.md'), 'utf8'), '# Safe ref\n');

      // 2. SKILL.md itself being a symlink outside srcDir is refused!
      const badSkillMdDir = path.join(tmp, 'bad-skill-md');
      await mkdir(badSkillMdDir, { recursive: true });
      await symlink(secretOutside, path.join(badSkillMdDir, 'SKILL.md'));
      await assert.rejects(
        () => store.saveFromDir('bad-md', badSkillMdDir),
        /escapes skill directory/i,
      );

      // 3. Enforce maxFiles cap cleanly.
      const manyFilesDir = path.join(tmp, 'many-files');
      await createSkill(manyFilesDir, {
        name: 'many-files',
        description: 'Too many files.',
        extraFiles: { 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' },
      });
      await assert.rejects(
        () => store.saveFromDir('many-files', manyFilesDir, { maxFiles: 2 }),
        /maximum file limit/i,
      );
      assert.equal(await store.get('many-files'), null);

      // 4. Enforce maxBytes cap cleanly.
      const bigFileDir = path.join(tmp, 'big-file');
      await createSkill(bigFileDir, {
        name: 'big-file',
        description: 'Too big.',
        extraFiles: { 'blob.bin': 'x'.repeat(2048) },
      });
      await assert.rejects(
        () => store.saveFromDir('big-file', bigFileDir, { maxBytes: 1024 }),
        /maximum size limit/i,
      );
      assert.equal(await store.get('big-file'), null);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('G6-15: rejects case-insensitive skill ID collisions without overwriting existing skills', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-g6-15-'));
    try {
      const store = new SkillStore(path.join(tmp, 'data'), { bundledDir: null });
      await store.saveSkillMarkdown('report', {
        name: 'report',
        description: 'Original lowercase report.',
        content: '# Original\n',
      });

      // Saving "Report" via saveSkillMarkdown must throw 409 and NOT overwrite "report".
      await assert.rejects(
        () =>
          store.saveSkillMarkdown('Report', {
            name: 'Report',
            description: 'Conflicting mixed-case report.',
            content: '# Overwritten\n',
          }),
        (err) => err.status === 409 && /conflicts with existing skill "report"/i.test(err.message),
      );

      // Saving "Report" via saveFromDir must also throw 409.
      const srcUpper = path.join(tmp, 'src-upper');
      await createSkill(srcUpper, {
        name: 'Report',
        description: 'From dir conflict.',
      });
      await assert.rejects(
        () => store.saveFromDir('Report', srcUpper),
        (err) => err.status === 409 && /conflicts with existing skill "report"/i.test(err.message),
      );

      // Exact-case update succeeds; wrong-case get/remove do NOT touch "report".
      assert.equal(await store.get('Report'), null);
      assert.equal(await store.remove('Report'), false);
      const original = await store.get('report');
      assert.ok(original);
      assert.equal(original.description, 'Original lowercase report.');

      const updated = await store.saveSkillMarkdown('report', {
        name: 'report',
        description: 'Updated lowercase report.',
        content: '# Updated\n',
      });
      assert.equal(updated.description, 'Updated lowercase report.');

      // Metadata file must never contain both "report" and "Report".
      const rawMeta = JSON.parse(await readFile(path.join(tmp, 'data', 'skills-meta.json'), 'utf8'));
      assert.deepEqual(Object.keys(rawMeta.skills), ['report']);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('G6-09, G6-10, G6-14, G6-18: cleanup preserves bundled-name user skills, changed skills, Loop storage symlinks, and exact source filters', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-skills-hardening-'));
    try {
      const home = path.join(tmp, 'home');
      const dataDir = path.join(tmp, 'loop-data');
      const store = new SkillStore(dataDir); // uses default bundledDir (organize, sync-agents, find-capability)

      const claudeDir = path.join(home, '.claude', 'skills');
      const codexDir = path.join(home, '.codex', 'skills');
      const cursorDir = path.join(home, '.cursor', 'skills');
      await mkdir(claudeDir, { recursive: true });
      await mkdir(codexDir, { recursive: true });
      await mkdir(cursorDir, { recursive: true });

      // G6-09: User has their own "organize" skill in Claude Code (matching Loop's bundled skill name).
      await createSkill(path.join(claudeDir, 'organize'), {
        name: 'organize',
        description: 'My personal desktop file organizer.',
      });

      // G6-10: Two skills imported into Loop: one stays identical, one is edited in Claude after import.
      const unchangedDir = path.join(claudeDir, 'unchanged-skill');
      await createSkill(unchangedDir, {
        name: 'unchanged-skill',
        description: 'Identical copy.',
        extraFiles: { 'notes.md': 'v1\n' },
      });
      const editedDir = path.join(claudeDir, 'edited-skill');
      await createSkill(editedDir, {
        name: 'edited-skill',
        description: 'Version 1.',
      });
      await store.saveFromDir('unchanged-skill', unchangedDir, { source: 'Claude Code' });
      const savedEdited = await store.saveFromDir('edited-skill', editedDir, { source: 'Claude Code' });
      assert.ok(savedEdited.contentHash, 'saved skill stores contentHash');
      assert.equal(savedEdited.contentHash, await hashSkillTree(editedDir));

      // Now modify edited-skill in Claude Code so it diverges from Loop's stored copy!
      await writeFile(path.join(editedDir, 'extra-local-work.md'), 'unsaved local edits\n', 'utf8');

      // Put identical copy of unchanged-skill in Codex too for G6-18 source filter test.
      await createSkill(path.join(codexDir, 'unchanged-skill'), {
        name: 'unchanged-skill',
        description: 'Identical copy.',
        extraFiles: { 'notes.md': 'v1\n' },
      });

      // G6-14: Symlink inside Claude Code pointing to Loop's own stored skill AND Cursor dir symlinked to Loop's skillsDir!
      await symlink(path.join(store.skillsDir, 'unchanged-skill'), path.join(claudeDir, 'loop-store-link'));
      await rm(cursorDir, { recursive: true, force: true });
      await symlink(store.skillsDir, cursorDir);

      // G6-18: Empty sources array [] cleans ZERO agents (never all agents).
      const emptyClean = await cleanupAgentSkills(store, { sources: [], dryRun: false, ctx: { home } });
      assert.equal(emptyClean.totalRemoved, 0);
      assert.equal(emptyClean.agents.length, 0);
      assert.equal(await exists(unchangedDir), true);

      // G6-18: Substring / label filter ['claude'] or ['Code'] matches ZERO agents.
      const substrClean = await cleanupAgentSkills(store, {
        sources: ['claude', 'Code'],
        dryRun: false,
        ctx: { home },
      });
      assert.equal(substrClean.totalRemoved, 0);
      assert.equal(substrClean.agents.length, 0);

      // G6-18: Empty array in importSkillsFromAgents imports ZERO agents.
      const emptyImport = await importSkillsFromAgents(store, { source: [], dryRun: true, ctx: { home } });
      assert.equal(emptyImport.sources.length, 0);

      // Run real cleanup scoped to exact ['claude-code'] only -> codex untouched!
      const claudeOnly = await cleanupAgentSkills(store, {
        sources: ['claude-code'],
        dryRun: false,
        ctx: { home },
      });
      assert.equal(claudeOnly.agents.length, 1);
      assert.equal(claudeOnly.agents[0].id, 'claude-code');
      assert.deepEqual(claudeOnly.agents[0].removed.map((r) => r.name), ['unchanged-skill']);

      // Verify Codex was untouched because source filter was exact ['claude-code'].
      assert.equal(await exists(path.join(codexDir, 'unchanged-skill')), true);

      // Verify G6-09: User's own "organize" skill was NOT removed!
      assert.equal(await exists(path.join(claudeDir, 'organize', 'SKILL.md')), true);
      assert.ok(claudeOnly.agents[0].kept.some((k) => k.name === 'organize' && k.reason === 'Not in Loop'));

      // Verify G6-10: Modified "edited-skill" was NOT removed and reported exact reason!
      assert.equal(await exists(path.join(editedDir, 'extra-local-work.md')), true);
      assert.ok(
        claudeOnly.agents[0].kept.some(
          (k) => k.name === 'edited-skill' && k.reason === 'Changed since import (differs from Loop copy)',
        ),
      );

      // Verify G6-14: Symlink pointing to Loop's own store was kept untouched, and Cursor symlinked to skillsDir is skipped!
      assert.equal(await exists(path.join(claudeDir, 'loop-store-link')), true);
      const allClean = await cleanupAgentSkills(store, { dryRun: false, ctx: { home } });
      // Codex's unchanged-skill gets cleaned, but Cursor (symlinked to store.skillsDir) is skipped and Loop's store is intact!
      assert.equal(allClean.agents.find((a) => a.id === 'cursor'), undefined);
      assert.equal(await exists(path.join(store.skillsDir, 'unchanged-skill', 'SKILL.md')), true);
      assert.equal(await exists(path.join(store.skillsDir, 'edited-skill', 'SKILL.md')), true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('G5-18, G3a-17 & G6-26: personal SkillStore strips filesystem paths, excludes host-only bundled skills, and bundled skills avoid hardcoded URLs', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'loop-skills-personal-'));
    try {
      assert.deepEqual([...HOST_ONLY_BUNDLED_SKILLS], ['sync-agents', 'organize']);

      const personalStore = new SkillStore(path.join(tmp, 'data'), { personal: true });
      const saved = await personalStore.saveSkillMarkdown('my-note', {
        name: 'my-note',
        description: 'Personal skill.',
        content: '# Note\n',
      });
      assert.equal(saved.path, undefined, 'saveSkillMarkdown omits filesystem path in personal mode');

      const listed = await personalStore.list();
      assert.deepEqual(listed.map((s) => s.id), ['capability-ladder', 'connections', 'dream', 'find-capability', 'fix-connection', 'learn-workflow', 'loop', 'my-note', 'setup-project', 'skills', 'vault']);
      for (const item of listed) {
        assert.equal(item.path, undefined);
        assert.equal(item.dir, undefined);
        assert.equal(item.filePath, undefined);
      }

      // Host-only bundled skills are excluded in personal workspaces.
      assert.equal(await personalStore.get('sync-agents'), null);
      assert.equal(await personalStore.get('organize'), null);
      const fc = await personalStore.get('find-capability');
      assert.ok(fc);
      assert.equal(fc.path, undefined);

      // publicSkillMeta helper strips path fields cleanly.
      const stripped = publicSkillMeta(
        { id: 'x', name: 'x', path: '/secret/path', dir: '/secret', filePath: '/secret/SKILL.md' },
        { stripPaths: true },
      );
      assert.deepEqual(stripped, { id: 'x', name: 'x' });

      // G6-26: Bundled skills contain no hardcoded http://127.0.0.1:8799 URLs and sync-agents documents safety guarantees.
      const localStore = new SkillStore(path.join(tmp, 'local-data'));
      for (const id of ['sync-agents', 'organize', 'find-capability', 'fix-connection', 'setup-project']) {
        const sk = await localStore.get(id);
        assert.ok(sk, `bundled skill ${id} should exist`);
        assert.doesNotMatch(sk.content, /127\.0\.0\.1:8799/, `${id} must not hardcode 127.0.0.1:8799`);
      }
      const syncMd = (await localStore.get('sync-agents')).content;
      assert.match(syncMd, /credential-matching/i);
      assert.match(syncMd, /content hash/i);
      assert.match(syncMd, /approval/i);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
