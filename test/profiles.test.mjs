import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FORBIDDEN_PROFILE_KEYS,
  MAX_PROFILES,
  PROFILE_DESC_MAX,
  PROFILE_ID_MAX,
  PROFILE_NAME_MAX,
  connectionMatchesProfile,
  itemEditableInProfile,
  itemMatchesProfile,
  normalizeConnectionProfiles,
  normalizeItemProfiles,
  normalizeProfileTag,
  stripProfileFromItemProfiles,
} from '../lib/profiles.mjs';
import { LoopStore } from '../lib/store.mjs';
import { Vault } from '../lib/vault.mjs';
import { MemoryStore } from '../lib/memory.mjs';
import { SkillStore, hashSkillTree } from '../lib/skills.mjs';
import { McpOAuthServer } from '../lib/mcp-oauth.mjs';
import { startServer } from '../server.mjs';

async function createTempDir(prefix = 'loop-profiles-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function makePkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

async function writeMockStdio(dir) {
  const serverModUrl = import.meta.resolve('@modelcontextprotocol/sdk/server/index.js');
  const stdioModUrl = import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js');
  const typesModUrl = import.meta.resolve('@modelcontextprotocol/sdk/types.js');
  const script = `
import { Server } from ${JSON.stringify(serverModUrl)};
import { StdioServerTransport } from ${JSON.stringify(stdioModUrl)};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(typesModUrl)};
import { createHash } from 'node:crypto';
const server = new Server({ name: 'mock-profile-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo_arg', description: 'Echo server launch args', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    { name: 'echo_input', description: 'Echo text input with sha', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'echo_input') {
    const text = String(req.params.arguments?.text ?? '');
    const sha = createHash('sha256').update(text).digest('hex').slice(0, 12);
    return { content: [{ type: 'text', text: 'got ' + text + ' sha=' + sha }] };
  }
  return { content: [{ type: 'text', text: process.argv.slice(2).join(' ') }] };
});
await server.connect(new StdioServerTransport());
`;
  const file = path.join(dir, 'mock-stdio.mjs');
  await writeFile(file, script, 'utf8');
  return file;
}

/* ========================================================================== */
/*  UNIT TESTS (no sockets — fast inside sandbox)                             */
/* ========================================================================== */

describe('Profiles helpers (unit)', () => {
  it('normalizeProfileTag normalizes, caps length, and rejects forbidden keys', () => {
    assert.equal(normalizeProfileTag('  Client   A  '), 'client-a');
    assert.equal(normalizeProfileTag('Work_Ops-2026!@#'), 'work_ops-2026');
    assert.equal(normalizeProfileTag('---leading-trailing---'), 'leading-trailing');
    assert.equal(normalizeProfileTag('all'), 'all');
    assert.equal(normalizeProfileTag('ALL'), 'all');
    assert.equal(normalizeProfileTag(''), '');
    assert.equal(normalizeProfileTag('   '), '');
    assert.equal(normalizeProfileTag('!!!'), '');
    assert.equal(normalizeProfileTag(null), '');
    assert.equal(normalizeProfileTag(undefined), '');

    for (const bad of FORBIDDEN_PROFILE_KEYS) {
      assert.equal(normalizeProfileTag(bad), '');
      assert.equal(normalizeProfileTag(bad.toUpperCase()), '');
    }

    const longInput = 'a'.repeat(PROFILE_ID_MAX + 25);
    assert.equal(normalizeProfileTag(longInput).length, PROFILE_ID_MAX);
  });

  it('normalizeConnectionProfiles preserves ["all", ...sortedTags] format', () => {
    assert.deepEqual(normalizeConnectionProfiles(undefined), ['all']);
    assert.deepEqual(normalizeConnectionProfiles([]), ['all']);
    assert.deepEqual(normalizeConnectionProfiles('Work'), ['all', 'work']);
    assert.deepEqual(
      normalizeConnectionProfiles(['all', 'Work', 'client-a', 'work', '__proto__', '!!!']),
      ['all', 'client-a', 'work'],
    );
  });

  it('normalizeItemProfiles handles default, unassigned [], explicit, and mixed ["all", tag]', () => {
    assert.deepEqual(normalizeItemProfiles(undefined), ['all']);
    assert.deepEqual(normalizeItemProfiles(null), ['all']);
    assert.deepEqual(normalizeItemProfiles([]), []);
    assert.deepEqual(normalizeItemProfiles(['all']), ['all']);
    assert.deepEqual(normalizeItemProfiles('all'), ['all']);
    assert.deepEqual(normalizeItemProfiles(['work']), ['work']);
    assert.deepEqual(normalizeItemProfiles('Work'), ['work']);
    assert.deepEqual(normalizeItemProfiles(['all', 'work']), ['work']);
    assert.deepEqual(normalizeItemProfiles(['Client B', 'all', 'client-a', 'client-b']), ['client-a', 'client-b']);
    assert.deepEqual(normalizeItemProfiles(['', '!!!', '__proto__']), []);
  });

  it('stripProfileFromItemProfiles removes deleted tag and NEVER widens single-profile items to ["all"]', () => {
    assert.deepEqual(stripProfileFromItemProfiles(['work'], 'work'), []);
    assert.deepEqual(stripProfileFromItemProfiles(['client-a', 'work'], 'work'), ['client-a']);
    assert.deepEqual(stripProfileFromItemProfiles(['all'], 'work'), ['all']);
    assert.deepEqual(stripProfileFromItemProfiles(undefined, 'work'), ['all']);
    assert.deepEqual(stripProfileFromItemProfiles([], 'work'), []);
    // Stripping 'all' or empty is a no-op
    assert.deepEqual(stripProfileFromItemProfiles(['work'], 'all'), ['work']);
    assert.deepEqual(stripProfileFromItemProfiles(['work'], ''), ['work']);
  });

  it('connectionMatchesProfile enforces strict profile membership and enabled state', () => {
    const workConn = { enabled: true, profiles: ['all', 'work'] };
    const defaultOnlyConn = { enabled: true, profiles: ['all'] };
    const disabledWorkConn = { enabled: false, profiles: ['all', 'work'] };

    assert.equal(connectionMatchesProfile(null, 'all'), false);
    assert.equal(connectionMatchesProfile(workConn, 'all'), true);
    assert.equal(connectionMatchesProfile(defaultOnlyConn, 'all'), true);
    assert.equal(connectionMatchesProfile(workConn, 'work'), true);
    assert.equal(connectionMatchesProfile(defaultOnlyConn, 'work'), false);
    assert.equal(connectionMatchesProfile(workConn, 'client-a'), false);
    assert.equal(connectionMatchesProfile(disabledWorkConn, 'work'), false);
    assert.equal(connectionMatchesProfile(disabledWorkConn, 'work', { requireEnabled: false }), true);
    assert.equal(connectionMatchesProfile(disabledWorkConn, 'all', { requireEnabled: false }), true);
  });

  it('itemMatchesProfile enforces strict visibility (no implicit sharing into named profiles)', () => {
    assert.equal(itemMatchesProfile({ profiles: ['all'] }, 'all'), true);
    assert.equal(itemMatchesProfile({ profiles: ['work'] }, 'all'), true);
    assert.equal(itemMatchesProfile({ profiles: [] }, 'all'), true);
    assert.equal(itemMatchesProfile({}, 'all'), true);

    assert.equal(itemMatchesProfile({ profiles: ['work'] }, 'work'), true);
    assert.equal(itemMatchesProfile({ profiles: ['client-a', 'work'] }, 'work'), true);
    assert.equal(itemMatchesProfile(['work'], 'work'), true);

    // Strict isolation: 'all', [], and other profiles NEVER match a named profile
    assert.equal(itemMatchesProfile({ profiles: ['all'] }, 'work'), false);
    assert.equal(itemMatchesProfile({ profiles: [] }, 'work'), false);
    assert.equal(itemMatchesProfile({ profiles: ['client-a'] }, 'work'), false);
    assert.equal(itemMatchesProfile({}, 'work'), false);
  });

  it('itemEditableInProfile allows "all" to edit anything and named profiles only exclusively owned items', () => {
    assert.equal(itemEditableInProfile({ profiles: ['all'] }, 'all'), true);
    assert.equal(itemEditableInProfile({ profiles: ['work'] }, 'all'), true);
    assert.equal(itemEditableInProfile({ profiles: [] }, 'all'), true);
    assert.equal(itemEditableInProfile({}, 'all'), true);

    assert.equal(itemEditableInProfile({ profiles: ['work'] }, 'work'), true);
    assert.equal(itemEditableInProfile(['work'], 'work'), true);

    // Shared, unassigned, other-profile, and multi-profile items are NOT editable by a scoped agent
    assert.equal(itemEditableInProfile({ profiles: ['all'] }, 'work'), false);
    assert.equal(itemEditableInProfile({ profiles: [] }, 'work'), false);
    assert.equal(itemEditableInProfile({ profiles: ['client-a'] }, 'work'), false);
    assert.equal(itemEditableInProfile({ profiles: ['client-a', 'work'] }, 'work'), false);
    assert.equal(itemEditableInProfile({}, 'work'), false);
  });
});

describe('LoopStore Profiles CRUD (unit)', () => {
  let dir;
  let store;

  beforeEach(async () => {
    dir = await createTempDir('loop-store-profiles-');
    store = new LoopStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('supports createProfile, listProfileRecords, getProfile, updateProfile, and listProfiles union', async () => {
    const work = await store.createProfile({ name: 'Work', description: 'Day job tools' });
    assert.equal(work.id, 'work');
    assert.equal(work.name, 'Work');
    assert.equal(work.description, 'Day job tools');
    assert.ok(work.createdAt);
    assert.ok(work.updatedAt);

    const clientA = await store.createProfile({ name: 'Client A', description: 'Acme Corp' });
    assert.equal(clientA.id, 'client-a');

    // Sorted by name, then id
    const records = await store.listProfileRecords();
    assert.deepEqual(
      records.map((r) => r.id),
      ['client-a', 'work'],
    );

    // getProfile returns a clone and rejects invalid / reserved IDs cleanly
    const fetched = await store.getProfile('work');
    assert.equal(fetched.name, 'Work');
    fetched.name = 'mutated-copy';
    assert.equal((await store.getProfile('work')).name, 'Work');
    assert.equal(await store.getProfile('all'), null);
    assert.equal(await store.getProfile('does-not-exist'), null);
    assert.equal(await store.getProfile('bad\nid'), null);

    // updateProfile updates metadata and preserves createdAt
    const updated = await store.updateProfile('work', {
      name: 'Work Engineering',
      description: 'Updated description',
    });
    assert.equal(updated.id, 'work');
    assert.equal(updated.name, 'Work Engineering');
    assert.equal(updated.description, 'Updated description');
    assert.equal(updated.createdAt, work.createdAt);

    // Add a connection with a legacy tag not yet in config.profiles
    await store.add({
      name: 'Legacy Conn',
      transport: 'http',
      url: 'https://legacy.example.com/mcp',
      profiles: ['legacy-tag'],
    });

    // listProfiles() preserves backwards-compatible union of persisted profiles + connection tags
    assert.deepEqual(await store.listProfiles(), ['all', 'client-a', 'legacy-tag', 'work']);

    // updateProfile promotes a legacy connection tag into a persisted profile record
    const promoted = await store.updateProfile('legacy-tag', {
      name: 'Legacy Ops',
      description: 'Promoted from connection tag',
    });
    assert.equal(promoted.id, 'legacy-tag');
    assert.equal(promoted.name, 'Legacy Ops');
    assert.equal(promoted.description, 'Promoted from connection tag');
    assert.ok(await store.getProfile('legacy-tag'));

    // Unknown unreferenced profile returns null on updateProfile
    assert.equal(await store.updateProfile('ghost-profile', { name: 'Ghost' }), null);
  });

  it('deleteProfile resets defaultProfile, strips connections, and disables bound agents WITHOUT widening agent.profile', async () => {
    await store.createProfile({ name: 'Work' });
    await store.createProfile({ name: 'Client A' });

    const singleConn = await store.add({
      name: 'Work Only',
      transport: 'http',
      url: 'https://work.example.com/mcp',
      profiles: ['work'],
    });
    const multiConn = await store.add({
      name: 'Shared Work Client',
      transport: 'http',
      url: 'https://shared.example.com/mcp',
      profiles: ['work', 'client-a'],
    });

    const workAgent = await store.addAgent({ name: 'Work Bot', profile: 'work' });
    const alreadyDisabledWorkAgent = await store.addAgent({
      name: 'Old Work Bot',
      profile: 'work',
      enabled: false,
    });
    const clientAgent = await store.addAgent({ name: 'Client Bot', profile: 'client-a' });
    const defaultAgent = await store.addAgent({ name: 'Default Bot', profile: 'all' });

    await store.updateSettings({ defaultProfile: 'work' }, { knownProfilesOnly: true });
    assert.equal((await store.getSettings()).defaultProfile, 'work');

    const res = await store.deleteProfile('work');
    assert.deepEqual(res, {
      deleted: true,
      id: 'work',
      disabledAgents: [workAgent.id],
      updatedConnections: 2,
    });

    assert.equal(await store.getProfile('work'), null);
    assert.equal((await store.getSettings()).defaultProfile, 'all');

    // Connections stripped cleanly
    assert.deepEqual((await store.get(singleConn.id)).profiles, ['all']);
    assert.deepEqual((await store.get(multiConn.id)).profiles, ['all', 'client-a']);

    // SECURITY INVARIANT: bound agent is disabled and keeps profile === 'work' (NEVER widened to 'all')
    const afterWorkAgent = await store.getAgent(workAgent.id);
    assert.equal(afterWorkAgent.enabled, false);
    assert.equal(afterWorkAgent.profile, 'work');

    const afterOldWorkAgent = await store.getAgent(alreadyDisabledWorkAgent.id);
    assert.equal(afterOldWorkAgent.enabled, false);
    assert.equal(afterOldWorkAgent.profile, 'work');

    // Other agents unaffected
    assert.equal((await store.getAgent(clientAgent.id)).enabled, true);
    assert.equal((await store.getAgent(clientAgent.id)).profile, 'client-a');
    assert.equal((await store.getAgent(defaultAgent.id)).enabled, true);
    assert.equal((await store.getAgent(defaultAgent.id)).profile, 'all');

    // Deleting an unknown unreferenced profile returns null
    assert.equal(await store.deleteProfile('never-existed'), null);
  });

  it('enforces validation errors (400), duplicate conflicts (409), and MAX_PROFILES cap', async () => {
    await assert.rejects(
      () => store.createProfile(null),
      (err) => err.status === 400,
    );
    await assert.rejects(
      () => store.createProfile({ name: '' }),
      (err) => err.status === 400,
    );
    await assert.rejects(
      () => store.createProfile({ name: '   ' }),
      (err) => err.status === 400,
    );
    await assert.rejects(
      () => store.createProfile({ name: 'All' }),
      (err) => err.status === 400 && /reserved/i.test(err.message),
    );
    await assert.rejects(
      () => store.createProfile({ id: 'all', name: 'Workspace' }),
      (err) => err.status === 400 && /reserved/i.test(err.message),
    );
    await assert.rejects(
      () => store.createProfile({ name: 'Bad\nName' }),
      (err) => err.status === 400,
    );
    await assert.rejects(
      () => store.createProfile({ id: 'bad\rid', name: 'Valid' }),
      (err) => err.status === 400,
    );
    await assert.rejects(
      () => store.createProfile({ name: 'Valid', description: 'Null\0byte' }),
      (err) => err.status === 400,
    );
    await assert.rejects(
      () => store.createProfile({ name: '!!!' }),
      (err) => err.status === 400,
    );
    await assert.rejects(
      () => store.createProfile({ name: 'x'.repeat(PROFILE_NAME_MAX + 1) }),
      (err) => err.status === 400,
    );
    await assert.rejects(
      () => store.createProfile({ name: 'Valid', description: 'd'.repeat(PROFILE_DESC_MAX + 1) }),
      (err) => err.status === 400,
    );

    for (const forbidden of FORBIDDEN_PROFILE_KEYS) {
      await assert.rejects(
        () => store.createProfile({ id: forbidden, name: 'Safe Name' }),
        (err) => err.status === 400,
      );
      await assert.rejects(
        () => store.createProfile({ name: forbidden }),
        (err) => err.status === 400,
      );
    }

    // Duplicate -> 409
    await store.createProfile({ name: 'Work' });
    await assert.rejects(
      () => store.createProfile({ name: 'work' }),
      (err) => err.status === 409,
    );

    // Fill up to MAX_PROFILES, then verify 51st fails with 400
    for (let i = 1; i < MAX_PROFILES; i += 1) {
      await store.createProfile({ id: `prof-${i}`, name: `Profile ${i}` });
    }
    assert.equal((await store.listProfileRecords()).length, MAX_PROFILES);

    await assert.rejects(
      () => store.createProfile({ id: 'prof-overflow', name: 'Overflow' }),
      (err) => err.status === 400 && /maximum/i.test(err.message),
    );
  });

  it('updateSettings({ knownProfilesOnly: true }) accepts persisted empty profiles and rejects unknown ones', async () => {
    await store.createProfile({ name: 'Empty Profile' });

    const updated = await store.updateSettings(
      { defaultProfile: 'empty-profile' },
      { knownProfilesOnly: true },
    );
    assert.equal(updated.defaultProfile, 'empty-profile');

    const reset = await store.updateSettings(
      { defaultProfile: 'all' },
      { knownProfilesOnly: true },
    );
    assert.equal(reset.defaultProfile, 'all');

    await assert.rejects(
      () => store.updateSettings({ defaultProfile: 'unknown-profile' }, { knownProfilesOnly: true }),
      (err) => err.status === 400 && /unknown profile/i.test(err.message),
    );
  });
});

describe('Vault strict profile scoping (unit)', () => {
  let dir;
  let vault;

  beforeEach(async () => {
    dir = await createTempDir('loop-vault-profiles-');
    vault = new Vault(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('supports set, updateMeta, strict list({ profile }), and stripProfile without widening', async () => {
    const def = await vault.set('DEFAULT_KEY', 'def-secret-111', { description: 'Shared' });
    assert.deepEqual(def.profiles, ['all']);

    const work = await vault.set('WORK_KEY', 'work-secret-222', {
      description: 'Work secret',
      profiles: ['Work'],
    });
    assert.deepEqual(work.profiles, ['work']);

    const multi = await vault.set('MULTI_KEY', 'multi-secret-333', {
      description: 'Work and Client A',
      profiles: ['all', 'work', 'Client A'],
    });
    assert.deepEqual(multi.profiles, ['client-a', 'work']);

    const unassigned = await vault.set('ORPHAN_KEY', 'orphan-secret-444', {
      description: 'Unassigned',
      profiles: [],
    });
    assert.deepEqual(unassigned.profiles, []);

    // Rotating value without passing profiles preserves existing profiles
    const rotated = await vault.set('WORK_KEY', 'work-secret-222-v2');
    assert.deepEqual(rotated.profiles, ['work']);

    // Strict list({ profile })
    const allList = await vault.list();
    assert.deepEqual(
      allList.map((s) => s.key),
      ['DEFAULT_KEY', 'MULTI_KEY', 'ORPHAN_KEY', 'WORK_KEY'],
    );
    const workList = await vault.list({ profile: 'work' });
    assert.deepEqual(
      workList.map((s) => s.key),
      ['MULTI_KEY', 'WORK_KEY'],
    );
    const clientList = await vault.list({ profile: 'client-a' });
    assert.deepEqual(
      clientList.map((s) => s.key),
      ['MULTI_KEY'],
    );

    // updateMeta updates profiles without altering encrypted ciphertext
    const beforeDisk = JSON.parse(await readFile(path.join(dir, 'vault.json'), 'utf8'));
    const updatedMeta = await vault.updateMeta('DEFAULT_KEY', { profiles: ['client-a'] });
    assert.deepEqual(updatedMeta.profiles, ['client-a']);
    const afterDisk = JSON.parse(await readFile(path.join(dir, 'vault.json'), 'utf8'));
    assert.equal(afterDisk.entries.DEFAULT_KEY.iv, beforeDisk.entries.DEFAULT_KEY.iv);
    assert.equal(afterDisk.entries.DEFAULT_KEY.tag, beforeDisk.entries.DEFAULT_KEY.tag);
    assert.equal(afterDisk.entries.DEFAULT_KEY.data, beforeDisk.entries.DEFAULT_KEY.data);
    assert.equal(await vault.get('DEFAULT_KEY'), 'def-secret-111');

    // Reset DEFAULT_KEY back to ['all'] so we can test stripProfile leaves ['all'] untouched
    await vault.updateMeta('DEFAULT_KEY', { profiles: ['all'] });

    // Validation rejects control chars / non-array
    await assert.rejects(
      () => vault.updateMeta('WORK_KEY', { profiles: ['bad\nprofile'] }),
      (err) => err.status === 400,
    );
    await assert.rejects(
      () => vault.updateMeta('WORK_KEY', { profiles: 123 }),
      (err) => err.status === 400,
    );

    // stripProfile('work') turns ['work'] -> [] (NEVER ['all']) and ['client-a', 'work'] -> ['client-a']
    const stripped = await vault.stripProfile('work');
    assert.deepEqual(stripped, { updated: 2 });
    assert.deepEqual((await vault.getMeta('WORK_KEY')).profiles, []);
    assert.deepEqual((await vault.getMeta('MULTI_KEY')).profiles, ['client-a']);
    assert.deepEqual((await vault.getMeta('DEFAULT_KEY')).profiles, ['all']);
    assert.equal(await vault.get('WORK_KEY'), 'work-secret-222-v2');
    assert.deepEqual(await vault.list({ profile: 'work' }), []);
    assert.deepEqual(await vault.stripProfile('all'), { updated: 0 });
  });
});

describe('MemoryStore strict profile scoping (unit)', () => {
  let dir;
  let memoryStore;

  beforeEach(async () => {
    dir = await createTempDir('loop-memory-profiles-');
    memoryStore = new MemoryStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('supports strict profile scoping, profile-safe key collision suffixing, BM25 + link isolation, graph conflict isolation, and stripProfile', async () => {
    // 1. Profile-safe key collision suffixing
    const first = await memoryStore.save({
      key: 'deploy-process',
      content: 'Work deploys via GitHub Actions on Tuesdays',
      scope: 'project',
      profiles: ['work'],
    });
    assert.equal(first.created, true);
    assert.equal(first.memory.key, 'deploy-process');
    assert.deepEqual(first.memory.profiles, ['work']);

    const second = await memoryStore.save({
      key: 'deploy-process',
      content: 'Client A deploys via manual Jenkins pipeline',
      scope: 'project',
      profiles: ['client-a'],
    });
    assert.equal(second.created, true);
    assert.equal(second.memory.key, 'deploy-process-2');
    assert.deepEqual(second.memory.profiles, ['client-a']);
    assert.notEqual(second.memory.id, first.memory.id);

    // Same profile + same key updates in place
    const updatedFirst = await memoryStore.save({
      key: 'deploy-process',
      content: 'Work deploys via GitHub Actions on Wednesdays',
      scope: 'project',
      profiles: ['work'],
    });
    assert.equal(updatedFirst.created, false);
    assert.equal(updatedFirst.memory.id, first.memory.id);

    // 2. Shared default memory & multi-profile memory
    const shared = await memoryStore.save({
      key: 'shared-note',
      content: 'Global workspace reminder about calendar hygiene',
      scope: 'global',
    });
    assert.deepEqual(shared.memory.profiles, ['all']);

    const multi = await memoryStore.save({
      key: 'shared-work-client',
      content: 'Both Work and Client A use PostgreSQL 16',
      scope: 'fact',
      profiles: ['work', 'client-a'],
    });
    assert.deepEqual(multi.memory.profiles, ['client-a', 'work']);

    // 3. BM25 + 1-hop associative link isolation across profiles
    const clientLinked = await memoryStore.save({
      key: 'client-secret-codename',
      content: 'Project Nebula launches in Q4 for Client A',
      scope: 'project',
      profiles: ['client-a'],
    });
    const workLinked = await memoryStore.save({
      key: 'work-zebra-topic',
      content: 'Zebra migration checklist for internal API',
      scope: 'project',
      links: [{ target: clientLinked.memory.id, relation: 'relates' }],
      profiles: ['work'],
    });

    const workSearch = await memoryStore.list({ profile: 'work', query: 'zebra' });
    assert.deepEqual(
      workSearch.map((m) => m.id),
      [workLinked.memory.id],
      '1-hop link to a client-a memory must never pull it into work search',
    );
    const workListAll = await memoryStore.list({ profile: 'work' });
    assert.ok(workListAll.every((m) => m.profiles.includes('work')));
    assert.ok(!workListAll.some((m) => m.id === shared.memory.id), 'default ["all"] memory must not appear in named profile');
    assert.ok(!workListAll.some((m) => m.id === clientLinked.memory.id));

    // 4. Graph & conflict isolation per profile
    const workPrefPnpm = await memoryStore.save({
      key: 'work-pkg',
      content: 'Always use pnpm for every repository',
      scope: 'preference',
      profiles: ['work'],
    });
    const clientPrefNpm = await memoryStore.save({
      key: 'client-pkg',
      content: 'Always use npm for every repository',
      scope: 'preference',
      links: [{ target: workPrefPnpm.memory.id, relation: 'contradicts' }],
      profiles: ['client-a'],
    });
    const workNoEmoji = await memoryStore.save({
      key: 'work-no-emoji',
      content: 'Avoid emojis in PR reviews',
      scope: 'preference',
      profiles: ['work'],
    });
    const workUseEmoji = await memoryStore.save({
      key: 'work-use-emoji',
      content: 'Prefer emojis in PR reviews',
      scope: 'preference',
      profiles: ['work'],
    });

    const workGraph = await memoryStore.graph({ profile: 'work' });
    const workNodeIds = new Set(workGraph.nodes.map((n) => n.id));
    assert.ok(workNodeIds.has(workPrefPnpm.memory.id));
    assert.ok(workNodeIds.has(workNoEmoji.memory.id));
    assert.ok(workNodeIds.has(workUseEmoji.memory.id));
    assert.ok(!workNodeIds.has(clientPrefNpm.memory.id));
    assert.ok(!workNodeIds.has(shared.memory.id));
    // Within-work conflict is detected; cross-profile conflict with client-a is NOT
    assert.equal(workGraph.conflicts.length, 1);
    const conflictPair = new Set([workGraph.conflicts[0].a, workGraph.conflicts[0].b]);
    assert.deepEqual(conflictPair, new Set([workNoEmoji.memory.id, workUseEmoji.memory.id]));

    const clientGraph = await memoryStore.graph({ profile: 'client-a' });
    const clientNodeIds = new Set(clientGraph.nodes.map((n) => n.id));
    assert.ok(clientNodeIds.has(clientPrefNpm.memory.id));
    assert.ok(!clientNodeIds.has(workPrefPnpm.memory.id));
    assert.equal(clientGraph.conflicts.length, 0, 'client-a graph must not conflict with work memories');

    // 5. update() can change profiles
    const moved = await memoryStore.update(workLinked.memory.id, { profiles: ['work'] });
    assert.deepEqual(moved.profiles, ['work']);

    // 6. stripProfile('work') never widens ['work'] -> ['all']
    const events = [];
    const unsub = memoryStore.subscribe((ev) => events.push(ev));
    const stripped = await memoryStore.stripProfile('work');
    unsub();

    assert.ok(stripped.updated >= 5);
    assert.ok(events.some((e) => e.action === 'stripProfile' && e.profileId === 'work'));
    assert.deepEqual((await memoryStore.get(first.memory.id)).profiles, []);
    assert.deepEqual((await memoryStore.get(multi.memory.id)).profiles, ['client-a']);
    assert.deepEqual((await memoryStore.get(shared.memory.id)).profiles, ['all']);
    assert.deepEqual(await memoryStore.list({ profile: 'work' }), []);
  });
});

describe('SkillStore strict profile scoping (unit)', () => {
  let dir;
  let bundledDir;
  let skillStore;

  beforeEach(async () => {
    dir = await createTempDir('loop-skills-profiles-');
    bundledDir = path.join(dir, 'bundled');
    await mkdir(path.join(bundledDir, 'bundled-deploy'), { recursive: true });
    await writeFile(
      path.join(bundledDir, 'bundled-deploy', 'SKILL.md'),
      '---\nname: Bundled Deploy\ndescription: Standard deploy checklist\n---\n\n# Bundled Deploy\nRun checks.\n',
      'utf8',
    );
    skillStore = new SkillStore(path.join(dir, 'data'), { bundledDir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists profile metadata strictly in skills-meta.json without touching SKILL.md or contentHash', async () => {
    const workSkill = await skillStore.saveSkillMarkdown('work-deploy', {
      name: 'Work Deploy',
      description: 'Deploy workflow for Work',
      content: '# Work Deploy\nShip cleanly.',
      profiles: ['work'],
    });
    const clientSkill = await skillStore.saveSkillMarkdown('client-deploy', {
      name: 'Client Deploy',
      description: 'Deploy workflow for Client A',
      content: '# Client Deploy\nShip to client staging.',
      profiles: ['client-a'],
    });
    const multiSkill = await skillStore.saveSkillMarkdown('shared-deploy', {
      name: 'Shared Deploy',
      description: 'Shared deploy helper',
      content: '# Shared Deploy\nShared steps.',
      profiles: ['work', 'client-a'],
    });

    const userMdPath = path.join(skillStore.skillsDir, 'work-deploy', 'SKILL.md');
    const bundledMdPath = path.join(bundledDir, 'bundled-deploy', 'SKILL.md');
    const userMdBefore = await readFile(userMdPath, 'utf8');
    const userStatBefore = await stat(userMdPath);
    const bundledMdBefore = await readFile(bundledMdPath, 'utf8');
    const bundledStatBefore = await stat(bundledMdPath);
    const hashBefore = workSkill.contentHash;
    assert.equal(hashBefore, await hashSkillTree(path.join(skillStore.skillsDir, 'work-deploy')));

    // Update profiles on BOTH user skill and bundled skill
    const updatedUser = await skillStore.updateMeta('work-deploy', { profiles: ['work'] });
    const updatedBundled = await skillStore.updateMeta('bundled-deploy', { profiles: ['work'] });
    assert.deepEqual(updatedUser.profiles, ['work']);
    assert.equal(updatedUser.contentHash, hashBefore, 'user skill contentHash must be preserved');
    assert.deepEqual(updatedBundled.profiles, ['work']);
    assert.equal(updatedBundled.bundled, true);

    // Verify SKILL.md on disk was never modified for either user or bundled skill
    assert.equal(await readFile(userMdPath, 'utf8'), userMdBefore);
    assert.equal((await stat(userMdPath)).mtimeMs, userStatBefore.mtimeMs);
    assert.equal(await readFile(bundledMdPath, 'utf8'), bundledMdBefore);
    assert.equal((await stat(bundledMdPath)).mtimeMs, bundledStatBefore.mtimeMs);

    // Verify skills-meta.json holds the profile overrides
    const metaJson = JSON.parse(await readFile(skillStore.metaFile, 'utf8'));
    assert.deepEqual(metaJson.skills['work-deploy'].profiles, ['work']);
    assert.deepEqual(metaJson.skills['bundled-deploy'].profiles, ['work']);
    assert.equal(metaJson.skills['work-deploy'].contentHash, hashBefore);

    // Strict list({ profile }) & search(q, { profile })
    assert.deepEqual(
      (await skillStore.list({ profile: 'all' })).map((s) => s.id),
      ['bundled-deploy', 'client-deploy', 'shared-deploy', 'work-deploy'],
    );
    assert.deepEqual(
      (await skillStore.list({ profile: 'work' })).map((s) => s.id),
      ['bundled-deploy', 'shared-deploy', 'work-deploy'],
    );
    assert.deepEqual(
      (await skillStore.list({ profile: 'client-a' })).map((s) => s.id),
      ['client-deploy', 'shared-deploy'],
    );

    const workSearch = await skillStore.search('deploy', { profile: 'work' });
    assert.deepEqual(
      workSearch.map((s) => s.id).sort(),
      ['bundled-deploy', 'shared-deploy', 'work-deploy'],
    );
    assert.ok(!workSearch.some((s) => s.id === clientSkill.id));

    // Reset bundled-deploy to ['all'] and verify strict profile listing excludes ['all']
    await skillStore.updateMeta('bundled-deploy', { profiles: ['all'] });
    assert.ok(!(await skillStore.list({ profile: 'work' })).some((s) => s.id === 'bundled-deploy'));

    // Re-assign bundled-deploy to ['work'] then stripProfile('work')
    await skillStore.updateMeta('bundled-deploy', { profiles: ['work'] });
    const stripped = await skillStore.stripProfile('work');
    assert.equal(stripped.updated, 3);
    assert.deepEqual((await skillStore.get('work-deploy')).profiles, []);
    assert.deepEqual((await skillStore.get('bundled-deploy')).profiles, []);
    assert.deepEqual((await skillStore.get(multiSkill.id)).profiles, ['client-a']);
    assert.deepEqual((await skillStore.get(clientSkill.id)).profiles, ['client-a']);
    assert.deepEqual(await skillStore.list({ profile: 'work' }), []);
  });
});

describe('McpOAuthServer profile consent (unit)', () => {
  it('approvePending persists chosen profile onto grant and validates invalid profile strings', () => {
    const oauth = new McpOAuthServer(null);
    const origin = 'http://127.0.0.1:8799';
    const redirectUri = 'http://localhost:51234/cb';
    const client = oauth.registerClient({ client_name: 'Cursor', redirect_uris: [redirectUri] });
    const pkce = makePkce();

    const started = oauth.startAuthorization(
      new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        state: 's1',
        resource: `${origin}/mcp`,
      }),
      origin,
    );
    assert.ok(started.txId);

    assert.throws(
      () => oauth.approvePending(started.txId, { profile: 'work\nevil' }),
      (err) => err.status === 400,
    );

    const approved = oauth.approvePending(started.txId, { profile: 'Work' });
    const code = new URL(approved.redirectUrl).searchParams.get('code');
    assert.ok(code);

    const grant = oauth.exchangeCode(
      {
        grant_type: 'authorization_code',
        code,
        code_verifier: pkce.verifier,
        redirect_uri: redirectUri,
        client_id: client.client_id,
      },
      origin,
    );
    assert.equal(grant.profile, 'work');
  });
});

/* ========================================================================== */
/*  END-TO-END HTTP + MCP + OAUTH INTEGRATION TESTS                           */
/* ========================================================================== */

describe('Profiles end-to-end (HTTP + MCP + OAuth)', () => {
  let tmp;
  let loop;
  let base;
  let mockScript;
  let cookie = '';

  async function api(route, options = {}) {
    const res = await fetch(`${base}${route}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  }

  function rpc(token, method, params, query = '') {
    return api(`/mcp${query}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  }

  async function callTool(token, name, args = {}, query = '') {
    const res = await rpc(token, 'tools/call', { name, arguments: args }, query);
    assert.equal(res.status, 200);
    if (res.json?.error) {
      return {
        isError: true,
        rpcError: res.json.error,
        text: res.json.error.message || '',
        parsed: null,
        raw: res.json,
      };
    }
    const result = res.json.result;
    const text = result?.content?.[0]?.text ?? '';
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { isError: Boolean(result?.isError), rpcError: null, text, parsed, raw: res.json };
  }

  async function createAgent(body) {
    const res = await api('/api/agents', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(res.status, 201);
    return res.json;
  }

  before(async () => {
    tmp = await createTempDir('loop-profiles-e2e-');
    mockScript = await writeMockStdio(tmp);
    loop = await startServer({
      authMode: 'local-test',
      port: 0,
      dataDir: path.join(tmp, 'data'),
      detectLocalAgents: false,
    });
    base = `http://127.0.0.1:${loop.port}`;
    const setup = await api('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ password: 'owner-pass-profiles-123' }),
    });
    assert.equal(setup.status, 200);
    cookie = setup.headers.get('set-cookie').split(';')[0];
  });

  after(async () => {
    if (loop) await loop.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it('enforces strict multi-profile isolation across REST, MCP, Vault grants, and OAuth consent', async () => {
    // 1. Create first-class profiles via REST
    const pWork = await api('/api/profiles', {
      method: 'POST',
      body: JSON.stringify({ name: 'Work', description: 'Day job profile' }),
    });
    assert.equal(pWork.status, 201);
    assert.equal(pWork.json.profile.id, 'work');
    assert.equal(pWork.json.profile.persisted, true);

    const pClient = await api('/api/profiles', {
      method: 'POST',
      body: JSON.stringify({ name: 'Client A', description: 'Client A engagement' }),
    });
    assert.equal(pClient.status, 201);
    assert.equal(pClient.json.profile.id, 'client-a');

    // Duplicate & reserved profile rejected
    assert.equal(
      (await api('/api/profiles', { method: 'POST', body: JSON.stringify({ name: 'Work' }) })).status,
      409,
    );
    assert.equal(
      (await api('/api/profiles', { method: 'POST', body: JSON.stringify({ id: 'all', name: 'All' }) })).status,
      400,
    );

    // 2. Seed Connections in Default (['all']), Work (['work']), and Client A (['client-a'])
    const workConnRes = await api('/api/mcps', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Work Mock',
        transport: 'stdio',
        command: process.execPath,
        args: [mockScript, '--label', 'work-conn'],
        profiles: ['work'],
      }),
    });
    assert.equal(workConnRes.status, 201);
    const workConn = workConnRes.json.mcp;

    const clientConnRes = await api('/api/mcps', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Client Mock',
        transport: 'stdio',
        command: process.execPath,
        args: [mockScript, '--label', 'client-a-conn'],
        profiles: ['client-a'],
      }),
    });
    assert.equal(clientConnRes.status, 201);
    const clientConn = clientConnRes.json.mcp;

    const defaultConnRes = await api('/api/mcps', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Default Mock',
        transport: 'stdio',
        command: process.execPath,
        args: [mockScript, '--label', 'default-conn'],
      }),
    });
    assert.equal(defaultConnRes.status, 201);
    const defaultConn = defaultConnRes.json.mcp;

    // 3. Seed Vault secrets in Default, Work, Client A, and Multi-profile
    assert.equal(
      (
        await api('/api/vault', {
          method: 'POST',
          body: JSON.stringify({
            key: 'WORK_SECRET',
            value: 'work-secret-val-111',
            description: 'Work API key',
            profiles: ['work'],
            allowedSinks: [`conn:${workConn.id}`],
          }),
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await api('/api/vault', {
          method: 'POST',
          body: JSON.stringify({
            key: 'CLIENT_SECRET',
            value: 'client-secret-val-222',
            description: 'Client A API key',
            profiles: ['client-a'],
          }),
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await api('/api/vault', {
          method: 'POST',
          body: JSON.stringify({
            key: 'DEFAULT_SECRET',
            value: 'default-secret-val-333',
            description: 'Default workspace secret',
          }),
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await api('/api/vault', {
          method: 'POST',
          body: JSON.stringify({
            key: 'MULTI_SECRET',
            value: 'multi-secret-val-444',
            description: 'Shared between work and client-a',
            profiles: ['work', 'client-a'],
          }),
        })
      ).status,
      201,
    );

    // 4. Seed Memories in Default, Work, Client A, and Multi-profile
    const workMemRes = await api('/api/memory', {
      method: 'POST',
      body: JSON.stringify({
        key: 'work-mem',
        content: 'Work uses TypeScript monorepo with pnpm',
        scope: 'project',
        profiles: ['work'],
      }),
    });
    assert.equal(workMemRes.status, 201);

    const clientMemRes = await api('/api/memory', {
      method: 'POST',
      body: JSON.stringify({
        key: 'client-mem',
        content: 'Client A uses Python FastAPI with uv',
        scope: 'project',
        profiles: ['client-a'],
      }),
    });
    assert.equal(clientMemRes.status, 201);

    const defaultMemRes = await api('/api/memory', {
      method: 'POST',
      body: JSON.stringify({
        key: 'shared-mem',
        content: 'Default global preference: concise answers',
        scope: 'preference',
      }),
    });
    assert.equal(defaultMemRes.status, 201);

    // 5. Create agents: Default ('all'), Work (canManage + all secrets granted), Work (no secrets), Client A
    const defaultAgent = await createAgent({
      name: 'Default Owner Agent',
      kind: 'claude-code',
      profile: 'all',
      mode: 'direct',
      canManage: true,
      memoryAccess: 'read_write',
      secrets: ['WORK_SECRET', 'CLIENT_SECRET', 'DEFAULT_SECRET', 'MULTI_SECRET'],
    });
    const workAgent = await createAgent({
      name: 'Work Agent',
      kind: 'claude-code',
      profile: 'work',
      mode: 'direct',
      canManage: true,
      memoryAccess: 'read_write',
      // Deliberately grant cross-profile secrets to verify strict profile filtering still blocks them
      secrets: ['WORK_SECRET', 'CLIENT_SECRET', 'DEFAULT_SECRET', 'MULTI_SECRET'],
    });
    const workNoSecretsAgent = await createAgent({
      name: 'Work No Secrets Agent',
      kind: 'claude-code',
      profile: 'work',
      mode: 'direct',
      canManage: false,
      memoryAccess: 'read',
      secrets: [],
    });
    const clientAgent = await createAgent({
      name: 'Client A Agent',
      kind: 'claude-code',
      profile: 'client-a',
      mode: 'direct',
      canManage: true,
      memoryAccess: 'read_write',
      secrets: ['CLIENT_SECRET', 'MULTI_SECRET'],
    });

    // 6. Seed Skills via defaultAgent loop__save, then assign profiles via PATCH /api/skills/:id
    const savedWorkSkill = await callTool(defaultAgent.token, 'loop__save', {
      type: 'skill',
      data: {
        id: 'work-skill',
        name: 'Work Skill',
        description: 'Runbook for work',
        content: '# Work Skill\nInternal steps.',
        profiles: ['work'],
      },
    });
    assert.equal(savedWorkSkill.isError, false);
    assert.deepEqual(savedWorkSkill.parsed.skill.projects, ['work']);

    const savedClientSkill = await callTool(defaultAgent.token, 'loop__save', {
      type: 'skill',
      data: {
        id: 'client-skill',
        name: 'Client Skill',
        description: 'Runbook for Client A',
        content: '# Client Skill\nClient steps.',
        profiles: ['client-a'],
      },
    });
    assert.equal(savedClientSkill.isError, false);

    const savedSharedSkill = await callTool(defaultAgent.token, 'loop__save', {
      type: 'skill',
      data: {
        id: 'shared-skill',
        name: 'Shared Skill',
        description: 'Default workspace skill',
        content: '# Shared Skill\nGeneral steps.',
      },
    });
    assert.equal(savedSharedSkill.isError, false);

    // PATCH /api/skills/:id updates profile assignment via REST
    const patchedSkill = await api('/api/skills/shared-skill', {
      method: 'PATCH',
      body: JSON.stringify({ profiles: ['all'] }),
    });
    assert.equal(patchedSkill.status, 200);
    assert.deepEqual(patchedSkill.json.skill.profiles, ['all']);

    // Verify REST profile filters & overview profileRecords
    const memWorkApi = await api('/api/memory?profile=work');
    assert.equal(memWorkApi.status, 200);
    assert.deepEqual(
      memWorkApi.json.memories.map((m) => m.key),
      ['work-mem'],
    );
    assert.equal(memWorkApi.json.graph.nodes.length, 1);

    const vaultWorkApi = await api('/api/vault?profile=work');
    assert.equal(vaultWorkApi.status, 200);
    assert.deepEqual(
      vaultWorkApi.json.secrets.map((s) => s.key),
      ['MULTI_SECRET', 'WORK_SECRET'],
    );

    const skillsWorkApi = await api('/api/skills?profile=work');
    assert.equal(skillsWorkApi.status, 200);
    assert.deepEqual(
      skillsWorkApi.json.skills.map((s) => s.id),
      ['work-skill'],
    );

    const overviewApi = await api('/api/overview');
    assert.equal(overviewApi.status, 200);
    assert.ok(Array.isArray(overviewApi.json.profileRecords));
    const overviewWork = overviewApi.json.profileRecords.find((p) => p.id === 'work');
    assert.ok(overviewWork);
    assert.deepEqual(overviewWork.counts, {
      connections: 1,
      skills: 1,
      memories: 1,
      secrets: 2,
      agents: 2,
    });

    const profilesApi = await api('/api/profiles');
    assert.equal(profilesApi.status, 200);
    assert.equal(profilesApi.json.defaultProfile, 'all');
    assert.equal(profilesApi.json.totals.connections, 3);
    assert.equal(profilesApi.json.totals.memories, 3);
    assert.equal(profilesApi.json.totals.secrets, 4);
    assert.equal(profilesApi.json.totals.agents, 4);

    // 7. Strict MCP visibility for workAgent (even if ?profile=all or ?profile=client-a is passed!)
    const workTools = (await rpc(workAgent.token, 'tools/list')).json.result.tools.map((t) => t.name);
    assert.deepEqual(workTools, ['loop__search', 'loop__inspect', 'loop__run', 'loop__save', 'loop__show', 'loop__send_feedback']);

    for (const query of ['', '?profile=all', '?profile=client-a']) {
      const conns = await callTool(workAgent.token, 'loop__search', { type: 'connections' }, query);
      assert.equal(conns.isError, false);
      assert.equal(conns.parsed.project, 'work');
      assert.deepEqual(
        conns.parsed.connections.map((c) => c.id),
        [workConn.id],
      );

      const skills = await callTool(workAgent.token, 'loop__search', { type: 'skills' }, query);
      assert.equal(skills.isError, false);
      assert.deepEqual(
        skills.parsed.skills.map((s) => s.id),
        ['work-skill'],
      );

      const mems = await callTool(workAgent.token, 'loop__search', { type: 'memory' }, query);
      assert.equal(mems.isError, false);
      assert.deepEqual(
        mems.parsed.memories.map((m) => m.key),
        ['work-mem'],
      );

      const secrets = await callTool(workAgent.token, 'loop__search', { type: 'vault' }, query);
      assert.equal(secrets.isError, false);
      assert.deepEqual(
        secrets.parsed.secrets.map((s) => s.key),
        ['MULTI_SECRET', 'WORK_SECRET'],
      );
    }

    // 8. workAgent CANNOT inspect, run, edit, or delete items from client-a or Default
    for (const [type, targetId] of [
      ['connection', clientConn.id],
      ['connection', defaultConn.id],
      ['tool', `${clientConn.id}__echo_arg`],
      ['tool', `${defaultConn.id}__echo_arg`],
      ['skill', 'client-skill'],
      ['skill', 'shared-skill'],
      ['memory', 'client-mem'],
      ['memory', 'shared-mem'],
    ]) {
      const res = await callTool(workAgent.token, 'loop__inspect', { type, id: targetId });
      assert.equal(res.isError, true, `workAgent must not inspect ${type} "${targetId}"`);
    }

    // Cannot run tools from client-a or Default (via loop__run or direct call); errors never reveal hidden profiles
    const runOutOfProfile = await callTool(workAgent.token, 'loop__run', { tool: `${clientConn.id}__echo_arg`, arguments: {} });
    const runNonexistent = await callTool(workAgent.token, 'loop__run', { tool: 'missing_conn_xyz__echo_arg', arguments: {} });
    assert.equal(runOutOfProfile.isError, true);
    assert.equal(runOutOfProfile.text.replace(clientConn.id, '<id>'), runNonexistent.text.replace('missing_conn_xyz', '<id>'));
    assert.doesNotMatch(runOutOfProfile.text, /profile|agent/i);

    assert.equal((await callTool(workAgent.token, 'loop__run', { tool: `${defaultConn.id}__echo_arg`, arguments: {} })).isError, true);
    const directDenied = await callTool(workAgent.token, `${clientConn.id}__echo_arg`, {});
    assert.equal(directDenied.isError, true);
    assert.ok(directDenied.rpcError, 'direct call to out-of-profile tool returns JSON-RPC error');
    assert.match(directDenied.rpcError.message, /not found/i);
    assert.doesNotMatch(directDenied.rpcError.message, /profile|agent/i);

    // Inspecting out-of-profile items returns the exact same plain "not found." reply as nonexistent IDs
    const inspectOutConn = await callTool(workAgent.token, 'loop__inspect', { type: 'connection', id: clientConn.id });
    const inspectMissingConn = await callTool(workAgent.token, 'loop__inspect', { type: 'connection', id: 'missing_conn_xyz' });
    assert.equal(inspectOutConn.isError, true);
    assert.equal(inspectOutConn.text.replace(clientConn.id, '<id>'), inspectMissingConn.text.replace('missing_conn_xyz', '<id>'));
    assert.doesNotMatch(inspectOutConn.text, /profile|agent/i);

    const inspectOutSkill = await callTool(workAgent.token, 'loop__inspect', { type: 'skill', id: 'client-skill' });
    const inspectMissingSkill = await callTool(workAgent.token, 'loop__inspect', { type: 'skill', id: 'missing-skill-xyz' });
    assert.equal(inspectOutSkill.isError, true);
    assert.equal(inspectOutSkill.text.replace('client-skill', '<id>'), inspectMissingSkill.text.replace('missing-skill-xyz', '<id>'));
    assert.doesNotMatch(inspectOutSkill.text, /profile|agent/i);

    const inspectOutMem = await callTool(workAgent.token, 'loop__inspect', { type: 'memory', id: 'client-mem' });
    const inspectMissingMem = await callTool(workAgent.token, 'loop__inspect', { type: 'memory', id: 'missing-mem-xyz' });
    assert.equal(inspectOutMem.isError, true);
    assert.equal(inspectOutMem.text.replace('client-mem', '<id>'), inspectMissingMem.text.replace('missing-mem-xyz', '<id>'));
    assert.doesNotMatch(inspectOutMem.text, /profile|agent/i);

    // Can run work tool with WORK_SECRET, CANNOT use CLIENT_SECRET or DEFAULT_SECRET
    const okSecretRun = await callTool(workAgent.token, `${workConn.id}__echo_input`, {
      text: 'tok={{vault:WORK_SECRET}}',
    });
    assert.equal(okSecretRun.isError, false);
    const expectedSha = createHash('sha256').update('tok=work-secret-val-111').digest('hex').slice(0, 12);
    assert.equal(okSecretRun.text, `got tok=•••• sha=${expectedSha}`);

    for (const forbiddenKey of ['CLIENT_SECRET', 'DEFAULT_SECRET']) {
      const badRun = await callTool(workAgent.token, `${workConn.id}__echo_input`, {
        text: `tok={{vault:${forbiddenKey}}}`,
      });
      assert.equal(badRun.isError, true, `workAgent must not use ${forbiddenKey}`);
      assert.ok(!badRun.text.includes('client-secret-val-222'));
      assert.ok(!badRun.text.includes('default-secret-val-333'));
    }

    // Cannot edit or delete connections, skills, memory, or vault from client-a / Default / multi-profile
    assert.equal(
      (await callTool(workAgent.token, 'loop__save', {
        type: 'connection',
        id: clientConn.id,
        data: { description: 'hijack' },
      })).isError,
      true,
    );
    assert.equal(
      (await callTool(workAgent.token, 'loop__save', {
        type: 'connection',
        action: 'delete',
        id: defaultConn.id,
      })).isError,
      true,
    );
    assert.equal(
      (await callTool(workAgent.token, 'loop__save', {
        type: 'skill',
        id: 'client-skill',
        data: { content: '# Hijacked' },
      })).isError,
      true,
    );
    assert.equal(
      (await callTool(workAgent.token, 'loop__save', {
        type: 'skill',
        action: 'delete',
        id: 'shared-skill',
      })).isError,
      true,
    );
    assert.equal(
      (await callTool(workAgent.token, 'loop__save', {
        type: 'memory',
        id: 'client-mem',
        data: { content: 'Overwritten from work' },
      })).isError,
      true,
    );
    assert.equal(
      (await callTool(workAgent.token, 'loop__save', {
        type: 'memory',
        action: 'delete',
        id: 'shared-mem',
      })).isError,
      true,
    );
    assert.equal(
      (await callTool(workAgent.token, 'loop__save', {
        type: 'api_key',
        id: 'CLIENT_SECRET',
        data: { value: 'overwritten' },
      })).isError,
      true,
    );
    assert.equal(
      (await callTool(workAgent.token, 'loop__save', {
        type: 'api_key',
        action: 'delete',
        id: 'DEFAULT_SECRET',
      })).isError,
      true,
    );
    // Multi-profile secret is readable in work, but NOT editable or deletable by a work-only agent
    assert.equal(
      (await callTool(workAgent.token, 'loop__save', {
        type: 'api_key',
        id: 'MULTI_SECRET',
        data: { description: 'Work tried to edit shared secret' },
      })).isError,
      true,
    );
    assert.equal(
      (await callTool(workAgent.token, 'loop__save', {
        type: 'api_key',
        action: 'delete',
        id: 'MULTI_SECRET',
      })).isError,
      true,
    );

    // 9. Vault secret-grant boundary (G2-06): inside 'work', agent with secrets: [] cannot see or use WORK_SECRET
    const noSecSearch = await callTool(workNoSecretsAgent.token, 'loop__search', { type: 'vault' });
    assert.equal(noSecSearch.isError, false);
    assert.deepEqual(noSecSearch.parsed.secrets, []);

    const noSecRun = await callTool(workNoSecretsAgent.token, `${workConn.id}__echo_input`, {
      text: '{{vault:WORK_SECRET}}',
    });
    assert.equal(noSecRun.isError, true);
    assert.match(noSecRun.text, /not been shared/i);
    assert.ok(!noSecRun.text.includes('work-secret-val-111'));

    const noSecPlain = await callTool(workNoSecretsAgent.token, `${workConn.id}__echo_arg`, {});
    assert.equal(noSecPlain.isError, false);
    assert.equal(noSecPlain.text, '--label work-conn');

    // 10. workAgent saving new Memory, Skill, and Vault secret auto-scopes strictly to ['work']
    //     (even if data.profiles attempts to widen to ['all'] or ['client-a']), invisible to clientAgent!
    const autoMem = await callTool(workAgent.token, 'loop__save', {
      type: 'memory',
      data: {
        key: 'work-auto-mem',
        content: 'Work quarterly review happens on Friday',
        profiles: ['all', 'client-a'],
      },
    });
    assert.equal(autoMem.isError, false);
    assert.deepEqual(autoMem.parsed.memory.projects, ['work']);

    const autoSkill = await callTool(workAgent.token, 'loop__save', {
      type: 'skill',
      data: {
        id: 'work-auto-skill',
        name: 'Work Auto Skill',
        description: 'Auto-scoped skill from work',
        content: '# Work Auto Skill\nPrivate to work.',
        profiles: ['all'],
      },
    });
    assert.equal(autoSkill.isError, false);
    assert.deepEqual(autoSkill.parsed.skill.projects, ['work']);

    const autoSecret = await callTool(workAgent.token, 'loop__save', {
      type: 'api_key',
      data: {
        key: 'WORK_AUTO_KEY',
        value: 'auto-work-secret-999',
        description: 'Auto-scoped secret from work',
        profiles: ['all'],
      },
    });
    assert.equal(autoSecret.isError, false);
    assert.deepEqual(autoSecret.parsed.projects, ['work']);

    // Verify complete invisibility to clientAgent & client-a REST filters
    const clientMems = await callTool(clientAgent.token, 'loop__search', { type: 'memory' });
    assert.deepEqual(
      clientMems.parsed.memories.map((m) => m.key),
      ['client-mem'],
    );
    assert.equal(
      (await callTool(clientAgent.token, 'loop__inspect', { type: 'memory', id: 'work-auto-mem' })).isError,
      true,
    );

    const clientSkills = await callTool(clientAgent.token, 'loop__search', { type: 'skills' });
    assert.deepEqual(
      clientSkills.parsed.skills.map((s) => s.id),
      ['client-skill'],
    );
    assert.equal(
      (await callTool(clientAgent.token, 'loop__inspect', { type: 'skill', id: 'work-auto-skill' })).isError,
      true,
    );

    const clientVaultRest = await api('/api/vault?profile=client-a');
    assert.deepEqual(
      clientVaultRest.json.secrets.map((s) => s.key),
      ['CLIENT_SECRET', 'MULTI_SECRET'],
    );
    const workVaultRest = await api('/api/vault?profile=work');
    assert.ok(workVaultRest.json.secrets.some((s) => s.key === 'WORK_AUTO_KEY'));

    // 11. Default ('all') agent sees everything across all profiles
    const defaultConns = await callTool(defaultAgent.token, 'loop__search', { type: 'connections' });
    assert.equal(defaultConns.parsed.connections.length, 3);

    const defaultSkills = await callTool(defaultAgent.token, 'loop__search', { type: 'skills' });
    const defaultSkillIds = defaultSkills.parsed.skills.map((s) => s.id);
    assert.ok(defaultSkillIds.includes('work-skill'));
    assert.ok(defaultSkillIds.includes('work-auto-skill'));
    assert.ok(defaultSkillIds.includes('client-skill'));
    assert.ok(defaultSkillIds.includes('shared-skill'));

    const defaultMems = await callTool(defaultAgent.token, 'loop__search', { type: 'memory' });
    const defaultMemKeys = defaultMems.parsed.memories.map((m) => m.key);
    assert.ok(defaultMemKeys.includes('work-mem'));
    assert.ok(defaultMemKeys.includes('work-auto-mem'));
    assert.ok(defaultMemKeys.includes('client-mem'));
    assert.ok(defaultMemKeys.includes('shared-mem'));

    const defaultVault = await callTool(defaultAgent.token, 'loop__search', { type: 'vault' });
    assert.deepEqual(
      defaultVault.parsed.secrets.map((s) => s.key),
      ['CLIENT_SECRET', 'DEFAULT_SECRET', 'MULTI_SECRET', 'WORK_SECRET'],
    );

    // Default agent CAN narrow via ?profile=client-a
    const narrowedClient = await callTool(
      defaultAgent.token,
      'loop__search',
      { type: 'connections' },
      '?profile=client-a',
    );
    assert.deepEqual(
      narrowedClient.parsed.connections.map((c) => c.id),
      [clientConn.id],
    );

    // 12. OAuth consent approvePending with { profile: 'work' } issues an isolated agent locked strictly to 'work'
    const redirectUri = 'http://localhost:54321/oauth-cb';
    const dcr = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'OAuth Work Client',
        redirect_uris: [redirectUri],
      }),
    });
    assert.equal(dcr.status, 201);
    const dcrJson = await dcr.json();

    const pkce = makePkce();
    const authUrl = new URL(`${base}/oauth/authorize`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', dcrJson.client_id);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', 'work-oauth-state');
    authUrl.searchParams.set('resource', `${base}/mcp`);

    const authRes = await fetch(authUrl, { redirect: 'manual' });
    assert.equal(authRes.status, 302);
    const txId = new URL(authRes.headers.get('location'), base).searchParams.get('loop-oauth');
    assert.ok(txId);

    const consentInfo = await api(`/api/oauth/requests/${encodeURIComponent(txId)}`);
    assert.equal(consentInfo.status, 200);
    assert.ok(consentInfo.json.profiles.includes('work'));
    assert.ok(consentInfo.json.profileRecords.some((p) => p.id === 'work'));

    const approved = await api(`/api/oauth/requests/${encodeURIComponent(txId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ profile: 'work' }),
    });
    assert.equal(approved.status, 200);
    const authCode = new URL(approved.json.redirectUrl).searchParams.get('code');
    assert.ok(authCode);

    const tokenRes = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: authCode,
        code_verifier: pkce.verifier,
        redirect_uri: redirectUri,
        client_id: dcrJson.client_id,
      }),
    });
    assert.equal(tokenRes.status, 200);
    const tokenJson = await tokenRes.json();
    assert.match(tokenJson.access_token, /^loop_/);

    // Check created OAuth agent record is locked to 'work'
    const agentsList = await api('/api/agents');
    const oauthAgentRecord = agentsList.json.agents.find((a) => a.name === 'OAuth Work Client');
    assert.ok(oauthAgentRecord);
    assert.equal(oauthAgentRecord.profile, 'work');

    // Verify OAuth agent cannot escape 'work' even with ?profile=all
    const oauthConns = await callTool(
      tokenJson.access_token,
      'loop__search',
      { type: 'connections' },
      '?profile=all',
    );
    assert.equal(oauthConns.isError, false);
    assert.equal(oauthConns.parsed.project, 'work');
    assert.deepEqual(
      oauthConns.parsed.connections.map((c) => c.id),
      [workConn.id],
    );

    const oauthMems = await callTool(tokenJson.access_token, 'loop__search', { type: 'memory' });
    assert.ok(oauthMems.parsed.memories.every((m) => m.projects.includes('work')));
    assert.ok(!oauthMems.parsed.memories.some((m) => m.key === 'client-mem'));
    assert.equal(
      (await callTool(tokenJson.access_token, 'loop__inspect', { type: 'connection', id: clientConn.id })).isError,
      true,
    );
  });

  it('executes full Profile REST lifecycle: POST -> GET -> PATCH -> DELETE with cross-store cascade and non-widening agent disable', async () => {
    // Create profile
    const created = await api('/api/profiles', {
      method: 'POST',
      body: JSON.stringify({ name: 'Sandbox Team', description: 'Temporary profile' }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.profile.id, 'sandbox-team');

    // Update profile metadata via PATCH
    const patched = await api('/api/profiles/sandbox-team', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Sandbox Ops', description: 'Updated temporary profile' }),
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.profile.name, 'Sandbox Ops');
    assert.equal(patched.json.profile.description, 'Updated temporary profile');

    // Populate one connection, skill, memory, secret, and bound agent in sandbox-team, and set defaultProfile
    const conn = (
      await api('/api/mcps', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Sandbox Mock',
          transport: 'stdio',
          command: process.execPath,
          args: [mockScript, '--label', 'sandbox-conn'],
          profiles: ['sandbox-team'],
        }),
      })
    ).json.mcp;
    assert.ok(conn.id);

    const ownerForSeed = await createAgent({
      name: 'Sandbox Seeder',
      kind: 'claude-code',
      profile: 'all',
      canManage: true,
    });
    const skillRes = await callTool(ownerForSeed.token, 'loop__save', {
      type: 'skill',
      data: {
        id: 'sandbox-only-skill',
        name: 'Sandbox Skill',
        description: 'Temp skill',
        content: '# Sandbox Skill',
        profiles: ['sandbox-team'],
      },
    });
    assert.equal(skillRes.isError, false);

    const memRes = await api('/api/memory', {
      method: 'POST',
      body: JSON.stringify({
        key: 'sandbox-only-mem',
        content: 'Sandbox temporary fact for deletion test',
        profiles: ['sandbox-team'],
      }),
    });
    assert.equal(memRes.status, 201);

    const secRes = await api('/api/vault', {
      method: 'POST',
      body: JSON.stringify({
        key: 'SANDBOX_ONLY_SECRET',
        value: 'sandbox-val-123',
        profiles: ['sandbox-team'],
      }),
    });
    assert.equal(secRes.status, 201);

    const bound = await createAgent({
      name: 'Sandbox Bound Agent',
      kind: 'codex',
      profile: 'sandbox-team',
    });

    // Set defaultProfile to sandbox-team
    const setDefault = await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ defaultProfile: 'sandbox-team' }),
    });
    assert.equal(setDefault.status, 200);
    assert.equal(setDefault.json.settings.defaultProfile, 'sandbox-team');

    // Verify GET /api/profiles counts
    const beforeDelete = await api('/api/profiles');
    assert.equal(beforeDelete.status, 200);
    assert.equal(beforeDelete.json.defaultProfile, 'sandbox-team');
    const sbRecord = beforeDelete.json.profiles.find((p) => p.id === 'sandbox-team');
    assert.ok(sbRecord);
    assert.deepEqual(sbRecord.counts, {
      connections: 1,
      skills: 1,
      memories: 1,
      secrets: 1,
      agents: 1,
    });

    // DELETE /api/profiles/sandbox-team -> verify cascade across all stores
    const deleted = await api('/api/profiles/sandbox-team', { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.json, {
      deleted: true,
      id: 'sandbox-team',
      disabledAgents: [bound.agent.id],
      updatedConnections: 1,
      updatedSkills: 1,
      updatedMemories: 1,
      updatedSecrets: 1,
    });

    // defaultProfile reset to 'all'
    const afterProfiles = await api('/api/profiles');
    assert.equal(afterProfiles.json.defaultProfile, 'all');

    // Connection stripped of sandbox-team
    const afterMcps = await api('/api/mcps');
    const afterConn = afterMcps.json.mcps.find((m) => m.id === conn.id);
    assert.deepEqual(afterConn.profiles, ['all']);

    // Skill, memory, and vault secret became [] (unassigned), NEVER widened to ['all']!
    const afterSkill = await api('/api/skills/sandbox-only-skill');
    assert.deepEqual(afterSkill.json.skill.profiles, []);

    const afterMemories = await api('/api/memory');
    const afterMem = afterMemories.json.memories.find((m) => m.key === 'sandbox-only-mem');
    assert.deepEqual(afterMem.profiles, []);

    const afterVault = await api('/api/vault');
    const afterSec = afterVault.json.secrets.find((s) => s.key === 'SANDBOX_ONLY_SECRET');
    assert.deepEqual(afterSec.profiles, []);

    // Bound agent is disabled AND keeps profile === 'sandbox-team' (NEVER widened to 'all')
    const afterAgents = await api('/api/agents');
    const afterBound = afterAgents.json.agents.find((a) => a.id === bound.agent.id);
    assert.equal(afterBound.enabled, false);
    assert.equal(afterBound.profile, 'sandbox-team');

    // Calling /mcp with the disabled agent's token is rejected with 403
    const disabledRpc = await rpc(bound.token, 'tools/list');
    assert.equal(disabledRpc.status, 403);

    // Deleting an unknown profile returns 404
    const missingDelete = await api('/api/profiles/definitely-missing-profile', { method: 'DELETE' });
    assert.equal(missingDelete.status, 404);
  });
});
