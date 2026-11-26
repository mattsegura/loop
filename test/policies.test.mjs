import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { APPROVAL_MODES, VAULT_TYPES, Vault } from '../lib/vault.mjs';
import {
  CategoryStore,
  GENERAL_CATEGORY,
  categorizeItem,
  slugifyCategory,
} from '../lib/categories.mjs';
import {
  ApprovalQueue,
  DEFAULT_POLICIES,
  MAX_PENDING_PER_AGENT,
  MAX_PENDING_TOTAL,
  PolicyStore,
  approvalFingerprint,
} from '../lib/policies.mjs';

async function createTempDir(prefix = 'loop-policies-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('Typed Vault', () => {
  let dir;
  let vault;

  beforeEach(async () => {
    dir = await createTempDir('loop-typed-vault-');
    vault = new Vault(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exports frozen VAULT_TYPES and APPROVAL_MODES', () => {
    assert.deepEqual(VAULT_TYPES, ['api_key', 'login', 'payment', 'note']);
    assert.deepEqual(APPROVAL_MODES, ['inherit', 'auto', 'always_ask', 'guard']);
    assert.ok(Object.isFrozen(VAULT_TYPES));
    assert.ok(Object.isFrozen(APPROVAL_MODES));
  });

  it('keeps set() backward-compatible with string descriptions and preserves existing type/approval', async () => {
    const legacy = await vault.set('API_KEY', 'sk-live-12345678', 'Legacy API key');
    assert.equal(legacy.key, 'API_KEY');
    assert.equal(legacy.description, 'Legacy API key');
    assert.equal(legacy.type, 'api_key');
    assert.equal(legacy.approval, 'inherit');
    assert.equal(legacy.masked, '••••');

    const card = await vault.set('PERSONAL_VISA', '4242-4242-4242-4242', {
      description: 'Personal Visa',
      type: 'payment',
      approval: 'always_ask',
    });
    assert.equal(card.type, 'payment');
    assert.equal(card.approval, 'always_ask');
    assert.equal(card.description, 'Personal Visa');

    // Updating value with a plain string description must preserve existing type & approval
    const rotated = await vault.set('PERSONAL_VISA', '5555-5555-5555-9999', 'Rotated Visa');
    assert.equal(rotated.description, 'Rotated Visa');
    assert.equal(rotated.type, 'payment');
    assert.equal(rotated.approval, 'always_ask');
    assert.equal(rotated.masked, '••••');
    assert.equal(await vault.get('PERSONAL_VISA'), '5555-5555-5555-9999');

    // Updating with omitted 3rd arg also preserves description, type & approval
    const rotatedNoDesc = await vault.set('PERSONAL_VISA', '6666-6666-6666-1111');
    assert.equal(rotatedNoDesc.description, 'Rotated Visa');
    assert.equal(rotatedNoDesc.type, 'payment');
    assert.equal(rotatedNoDesc.approval, 'always_ask');
    assert.equal(rotatedNoDesc.masked, '••••');

    // Updating with an options object overrides type & approval and validates invalid values
    const invalidOpts = await vault.set('BAD_OPTS', 'secret-value-0000', {
      description: '  Defaults on bad enums  ',
      type: 'cryptocurrency',
      approval: 'yolo',
    });
    assert.equal(invalidOpts.description, 'Defaults on bad enums');
    assert.equal(invalidOpts.type, 'api_key');
    assert.equal(invalidOpts.approval, 'inherit');
  });

  it('defaults missing legacy type and approval in list() and getMeta()', async () => {
    await vault.set('NEW_LOGIN', 'hunter2-login', {
      description: 'Bank login',
      type: 'login',
      approval: 'auto',
    });

    // Inject a legacy vault entry without type/approval directly on disk
    const raw = JSON.parse(await readFile(path.join(dir, 'vault.json'), 'utf8'));
    raw.entries.LEGACY_TOKEN = {
      iv: raw.entries.NEW_LOGIN.iv,
      tag: raw.entries.NEW_LOGIN.tag,
      data: raw.entries.NEW_LOGIN.data,
      description: 'Old token',
      updatedAt: '2026-01-01T00:00:00.000Z',
      masked: '••••9999',
    };
    await writeFile(path.join(dir, 'vault.json'), JSON.stringify(raw, null, 2), 'utf8');

    const listed = await vault.list();
    assert.equal(listed.length, 2);

    const legacyItem = listed.find((i) => i.key === 'LEGACY_TOKEN');
    assert.deepEqual(legacyItem, {
      key: 'LEGACY_TOKEN',
      description: 'Old token',
      type: 'api_key',
      category: '',
      approval: 'inherit',
      updatedAt: '2026-01-01T00:00:00.000Z',
      masked: '••••',
      allowedSinks: [],
      profiles: ['all'],
    });

    const loginMeta = await vault.getMeta('NEW_LOGIN');
    assert.equal(loginMeta.type, 'login');
    assert.equal(loginMeta.approval, 'auto');
    assert.equal(loginMeta.description, 'Bank login');
    assert.equal(await vault.getMeta('NON_EXISTENT'), null);
    assert.equal(await vault.getMeta(''), null);
  });

  it('getMeta() and updateMeta() never decrypt or alter encrypted ciphertext', async () => {
    const plaintext = 'super-sensitive-card-4242-9876';
    await vault.set('CORP_CARD', plaintext, {
      description: 'Corp card',
      type: 'payment',
      approval: 'inherit',
    });

    const beforeRaw = JSON.parse(await readFile(path.join(dir, 'vault.json'), 'utf8'));
    const beforeEntry = beforeRaw.entries.CORP_CARD;

    const updated = await vault.updateMeta('CORP_CARD', {
      description: 'Corp Amex',
      type: 'note',
      approval: 'always_ask',
    });
    assert.equal(updated.key, 'CORP_CARD');
    assert.equal(updated.description, 'Corp Amex');
    assert.equal(updated.type, 'note');
    assert.equal(updated.approval, 'always_ask');
    assert.equal(updated.masked, beforeEntry.masked);

    const afterRaw = JSON.parse(await readFile(path.join(dir, 'vault.json'), 'utf8'));
    const afterEntry = afterRaw.entries.CORP_CARD;
    assert.equal(afterEntry.iv, beforeEntry.iv);
    assert.equal(afterEntry.tag, beforeEntry.tag);
    assert.equal(afterEntry.data, beforeEntry.data);
    assert.equal(afterEntry.masked, beforeEntry.masked);
    assert.equal(await vault.get('CORP_CARD'), plaintext);

    // Partial update & invalid values preserve current valid values
    const partial = await vault.updateMeta('CORP_CARD', {
      type: 'not_a_type',
      approval: 'not_a_mode',
    });
    assert.equal(partial.type, 'note');
    assert.equal(partial.approval, 'always_ask');
    assert.equal(partial.description, 'Corp Amex');

    assert.equal(await vault.updateMeta('DOES_NOT_EXIST', { type: 'login' }), null);
    await assert.rejects(() => vault.updateMeta('CORP_CARD', null), /must be an object/);
    await assert.rejects(() => vault.updateMeta('CORP_CARD', []), /must be an object/);

    // Prove getMeta and updateMeta never read vault.key or attempt decryption
    const noKeyVault = new Vault(dir);
    await unlink(path.join(dir, 'vault.key'));
    const metaWithoutKey = await noKeyVault.getMeta('CORP_CARD');
    assert.equal(metaWithoutKey.type, 'note');
    const updatedWithoutKey = await noKeyVault.updateMeta('CORP_CARD', { type: 'payment' });
    assert.equal(updatedWithoutKey.type, 'payment');
  });
});

describe('PolicyStore', () => {
  let dir;
  let policies;

  beforeEach(async () => {
    dir = await createTempDir('loop-policy-store-');
    policies = new PolicyStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns DEFAULT_POLICIES initially and persists updates cleanly with 0600 mode', async () => {
    assert.deepEqual(await policies.get(), DEFAULT_POLICIES);

    const updated = await policies.update({
      default: 'always_ask',
      vaultTypes: { payment: 'auto', unknown_type: 'always_ask' },
      categories: { 'commerce-finance': 'always_ask' },
      connections: { stripe: 'auto' },
      tools: { stripe__charge: 'always_ask' },
      actions: { cleanup: 'auto', custom_export: 'always_ask' },
    });

    assert.equal(updated.default, 'always_ask');
    assert.deepEqual(updated.vaultTypes, {
      payment: 'auto',
      login: 'always_ask',
      api_key: 'auto',
      note: 'auto',
    });
    assert.deepEqual(updated.categories, { 'commerce-finance': 'always_ask' });
    assert.deepEqual(updated.connections, { stripe: 'auto' });
    assert.deepEqual(updated.tools, { stripe__charge: 'always_ask' });
    assert.deepEqual(updated.actions, {
      cleanup: 'auto',
      organize: 'always_ask',
      delete: 'always_ask',
      add_local: 'always_ask',
      repoint: 'always_ask',
      custom_export: 'always_ask',
    });

    // Persists across fresh instances with owner-only permissions
    const reloaded = new PolicyStore(dir);
    assert.deepEqual(await reloaded.get(), updated);
    const info = await stat(path.join(dir, 'policies.json'));
    assert.equal(info.mode & 0o777, 0o600);

    // Setting overrides to 'inherit' or null cleanly removes override keys
    const cleared = await policies.update({
      default: 'inherit',
      vaultTypes: { payment: null },
      categories: { 'commerce-finance': 'inherit' },
      connections: { stripe: null },
      tools: { stripe__charge: 'inherit' },
      actions: { cleanup: 'inherit', custom_export: null },
    });
    assert.deepEqual(cleared, DEFAULT_POLICIES);
    assert.equal(Object.hasOwn(cleared.categories, 'commerce-finance'), false);
    assert.equal(Object.hasOwn(cleared.connections, 'stripe'), false);
    assert.equal(Object.hasOwn(cleared.tools, 'stripe__charge'), false);
    assert.equal(Object.hasOwn(cleared.actions, 'custom_export'), false);

    // Validation & concurrent updates
    await assert.rejects(() => policies.update(null), /Policy patch must be an object/);
    await assert.rejects(() => policies.update([]), /Policy patch must be an object/);

    await Promise.all([
      policies.update({ connections: { conn_a: 'always_ask' } }),
      policies.update({ connections: { conn_b: 'auto' } }),
      policies.update({ tools: { conn_a__read: 'auto' } }),
    ]);
    const finalState = await policies.get();
    assert.deepEqual(finalState.connections, { conn_a: 'always_ask', conn_b: 'auto' });
    assert.deepEqual(finalState.tools, { conn_a__read: 'auto' });
  });

  it('enforces full monotone two-axis evaluateRun() precedence chain with nothing hardcoded', async () => {
    // The tools say what they do, so the tool-kind rule (covered in its own test) stays out of the way.
    const stripe = {
      id: 'stripe',
      name: 'Stripe',
      tools: [
        { name: 'list_customers', annotations: { readOnlyHint: true } },
        { name: 'charge', annotations: { readOnlyHint: false, destructiveHint: false } },
        { name: 'sign_in', annotations: { readOnlyHint: false, destructiveHint: false } },
      ],
    };
    const paymentSecret = { key: 'VISA_CARD', type: 'payment', approval: 'inherit' };
    const loginSecret = { key: 'BANK_PW', type: 'login', approval: 'inherit' };
    const apiSecret = { key: 'STRIPE_KEY', type: 'api_key', approval: 'inherit' };

    // 7. Global default policy (auto)
    let res = await policies.evaluateRun({
      conn: stripe,
      toolName: 'list_customers',
      categoryId: 'commerce-finance',
      referencedSecrets: [apiSecret],
    });
    assert.equal(res.decision, 'auto');
    assert.equal(res.source, 'default');

    // 4. Default payment & login vaultTypes escalate to always_ask
    res = await policies.evaluateRun({
      conn: stripe,
      toolName: 'charge',
      categoryId: 'commerce-finance',
      referencedSecrets: [paymentSecret],
    });
    assert.equal(res.decision, 'always_ask');
    assert.equal(res.source, 'vaultType:payment');
    assert.match(res.reason, /VISA_CARD/);

    res = await policies.evaluateRun({
      conn: stripe,
      toolName: 'sign_in',
      referencedSecrets: [loginSecret],
    });
    assert.equal(res.decision, 'always_ask');
    assert.equal(res.source, 'vaultType:login');

    // User can override payment vaultType to auto (nothing hardcoded!)
    await policies.update({ vaultTypes: { payment: 'auto' } });
    res = await policies.evaluateRun({
      conn: stripe,
      toolName: 'charge',
      referencedSecrets: [paymentSecret],
    });
    assert.equal(res.decision, 'auto');
    assert.equal(res.source, 'default');

    // Reset payment vaultType back to always_ask
    await policies.update({ vaultTypes: { payment: 'always_ask' } });

    // 6. Category override beats global default (even when referencing api_key secret)
    await policies.update({ categories: { 'commerce-finance': 'always_ask' } });
    res = await policies.evaluateRun({
      conn: stripe,
      toolName: 'list_customers',
      categoryId: 'commerce-finance',
      referencedSecrets: [apiSecret],
    });
    assert.equal(res.decision, 'always_ask');
    assert.equal(res.source, 'category:commerce-finance');

    // 5. Connection 'auto' beats category 'always_ask' when no secret escalates
    await policies.update({ connections: { stripe: 'auto' } });
    res = await policies.evaluateRun({
      conn: stripe,
      toolName: 'list_customers',
      categoryId: 'commerce-finance',
      referencedSecrets: [apiSecret],
    });
    assert.equal(res.decision, 'auto');
    assert.equal(res.source, 'connection:stripe');

    // 4. Inherited vaultType 'always_ask' escalates over connection 'auto' and category 'auto'
    await policies.update({ categories: { 'commerce-finance': 'auto' } });
    res = await policies.evaluateRun({
      conn: stripe,
      toolName: 'charge',
      categoryId: 'commerce-finance',
      referencedSecrets: [paymentSecret],
    });
    assert.equal(res.decision, 'always_ask');
    assert.equal(res.source, 'vaultType:payment');

    // 2. Explicit secret 'always_ask' beats connection 'auto'
    const secretAsk = { key: 'VISA_CARD', type: 'payment', approval: 'always_ask' };
    res = await policies.evaluateRun({
      conn: stripe,
      toolName: 'charge',
      categoryId: 'commerce-finance',
      referencedSecrets: [secretAsk],
    });
    assert.equal(res.decision, 'always_ask');
    assert.equal(res.source, 'secret:VISA_CARD');

    // 3. Monotone lattice (G2-08): connection 'always_ask' MUST beat explicit secret 'auto'
    await policies.update({ connections: { stripe: 'always_ask' } });
    const secretAuto = { key: 'VISA_CARD', type: 'payment', approval: 'auto' };
    res = await policies.evaluateRun({
      conn: stripe,
      toolName: 'charge',
      categoryId: 'commerce-finance',
      referencedSecrets: [secretAuto],
    });
    assert.equal(res.decision, 'always_ask');
    assert.equal(res.source, 'connection:stripe');

    // Explicit secret 'auto' on a payment secret suppresses ONLY its own vaultType default
    // when connection is inherit (normal)
    await policies.update({ connections: { stripe: 'inherit' }, categories: { 'commerce-finance': 'inherit' } });
    res = await policies.evaluateRun({
      conn: stripe,
      toolName: 'charge',
      categoryId: 'commerce-finance',
      referencedSecrets: [secretAuto],
    });
    assert.equal(res.decision, 'auto');
    assert.equal(res.source, 'default');

    // Explicit secret 'auto' does NOT downgrade a category 'always_ask'
    await policies.update({ categories: { 'commerce-finance': 'always_ask' } });
    res = await policies.evaluateRun({
      conn: stripe,
      toolName: 'charge',
      categoryId: 'commerce-finance',
      referencedSecrets: [secretAuto],
    });
    assert.equal(res.decision, 'always_ask');
    assert.equal(res.source, 'category:commerce-finance');
    await policies.update({ categories: { 'commerce-finance': 'inherit' } });

    // When multiple secrets are referenced, explicit 'always_ask' beats explicit 'auto'
    res = await policies.evaluateRun({
      conn: stripe,
      toolName: 'charge',
      referencedSecrets: [
        { key: 'KEY_AUTO', type: 'api_key', approval: 'auto' },
        { key: 'KEY_ASK', type: 'api_key', approval: 'always_ask' },
      ],
    });
    assert.equal(res.decision, 'always_ask');
    assert.equal(res.source, 'secret:KEY_ASK');

    // Explicit 'auto' on an api_key must NOT bypass an inheriting payment secret
    res = await policies.evaluateRun({
      conn: stripe,
      toolName: 'charge',
      referencedSecrets: [
        { key: 'KEY_AUTO', type: 'api_key', approval: 'auto' },
        paymentSecret,
      ],
    });
    assert.equal(res.decision, 'always_ask');
    assert.equal(res.source, 'vaultType:payment');

    // 1. A per-tool override beats the connection, the category and the global default. It does
    // not open a Vault item that asks: between a tool and an item the stricter rule wins.
    await policies.update({
      default: 'always_ask',
      categories: { 'commerce-finance': 'always_ask' },
      connections: { stripe: 'always_ask' },
      tools: { stripe__charge: 'auto' },
    });
    res = await policies.evaluateRun({
      conn: stripe,
      toolName: 'charge',
      categoryId: 'commerce-finance',
      referencedSecrets: [secretAuto],
    });
    assert.equal(res.decision, 'auto');
    assert.equal(res.source, 'tool:stripe__charge');
    res = await policies.evaluateRun({
      conn: stripe,
      toolName: 'charge',
      categoryId: 'commerce-finance',
      referencedSecrets: [secretAsk],
    });
    assert.equal(res.decision, 'always_ask');
    assert.equal(res.source, `secret:${secretAsk.key}`);
    res = await policies.evaluateRun({
      conn: stripe,
      toolName: 'charge',
      referencedSecrets: [paymentSecret],
    });
    assert.equal(res.decision, 'always_ask');
    assert.equal(res.source, 'vaultType:payment');

    // And per-tool 'always_ask' beats per-secret 'auto' & connection 'auto'
    await policies.update({
      connections: { stripe: 'auto' },
      tools: { stripe__charge: 'always_ask' },
    });
    res = await policies.evaluateRun({
      conn: stripe,
      toolName: 'charge',
      referencedSecrets: [secretAuto],
    });
    assert.equal(res.decision, 'always_ask');
    assert.equal(res.source, 'tool:stripe__charge');
  });

  it('G2-08: attaching an unused auto secret cannot downgrade an always_ask connection', async () => {
    const prodDb = { id: 'prod-db', name: 'Prod DB' };
    await policies.update({ connections: { 'prod-db': 'always_ask' } });

    const withoutSecret = await policies.evaluateRun({
      conn: prodDb,
      toolName: 'drop_table',
      referencedSecrets: [],
    });
    assert.equal(withoutSecret.decision, 'always_ask');
    assert.equal(withoutSecret.source, 'connection:prod-db');

    const withUnusedAutoSecret = await policies.evaluateRun({
      conn: prodDb,
      toolName: 'drop_table',
      referencedSecrets: [{ key: 'UNUSED_KEY', type: 'api_key', approval: 'auto' }],
    });
    assert.equal(withUnusedAutoSecret.decision, 'always_ask');
    assert.equal(withUnusedAutoSecret.source, 'connection:prod-db');
  });

  it('G5-04: deleteConnection removes connection and all its tool overrides without affecting others', async () => {
    await policies.update({
      connections: { stripe: 'always_ask', stripe2: 'always_ask', github: 'auto' },
      tools: {
        stripe__charge: 'auto',
        stripe__refund: 'always_ask',
        stripe2__charge: 'always_ask',
        github__create_pr: 'always_ask',
      },
    });

    const after = await policies.deleteConnection('stripe');
    assert.equal(Object.hasOwn(after.connections, 'stripe'), false);
    assert.equal(Object.hasOwn(after.tools, 'stripe__charge'), false);
    assert.equal(Object.hasOwn(after.tools, 'stripe__refund'), false);
    assert.equal(after.connections.stripe2, 'always_ask');
    assert.equal(after.connections.github, 'auto');
    assert.equal(after.tools.stripe2__charge, 'always_ask');
    assert.equal(after.tools.github__create_pr, 'always_ask');

    const reloaded = await new PolicyStore(dir).get();
    assert.deepEqual(reloaded, after);
  });

  it('G2-22: fails closed on corrupt or non-object policies.json without silently resetting', async () => {
    const file = path.join(dir, 'policies.json');

    await writeFile(file, '{not valid json', 'utf8');
    await assert.rejects(() => policies.get(), SyntaxError);
    await assert.rejects(() => policies.update({ default: 'auto' }), SyntaxError);
    assert.equal(await readFile(file, 'utf8'), '{not valid json');

    for (const badPayload of ['null', '[]', '"auto"', '42', '{"connections":"always_ask"}']) {
      await writeFile(file, badPayload, 'utf8');
      await assert.rejects(() => policies.get(), /Invalid policies file/);
      await assert.rejects(() => policies.update({ default: 'auto' }), /Invalid policies file/);
      assert.equal(await readFile(file, 'utf8'), badPayload);
    }
  });

  it('enforces evaluateAction() precedence (itemApproval > action > vaultType > default)', async () => {
    // Built-in destructive/mutating actions default to always_ask
    for (const action of ['cleanup', 'organize', 'delete', 'add_local', 'repoint']) {
      const res = await policies.evaluateAction({ action });
      assert.equal(res.decision, 'always_ask');
      assert.equal(res.source, `action:${action}`);
    }

    // Saving a payment secret uses vaultTypes.payment (always_ask)
    let res = await policies.evaluateAction({ action: 'save', vaultType: 'payment' });
    assert.equal(res.decision, 'always_ask');
    assert.equal(res.source, 'vaultType:payment');

    // Saving an api_key uses vaultTypes.api_key (auto)
    res = await policies.evaluateAction({ action: 'save', vaultType: 'api_key' });
    assert.equal(res.decision, 'auto');
    assert.equal(res.source, 'vaultType:api_key');

    // Explicit itemApproval beats action and vaultType
    res = await policies.evaluateAction({
      action: 'delete',
      vaultType: 'payment',
      itemApproval: 'auto',
    });
    assert.equal(res.decision, 'auto');
    assert.equal(res.source, 'item');

    res = await policies.evaluateAction({
      action: 'save',
      vaultType: 'api_key',
      itemApproval: 'always_ask',
    });
    assert.equal(res.decision, 'always_ask');
    assert.equal(res.source, 'item');

    // Overriding action policy to auto works
    await policies.update({ actions: { cleanup: 'auto' } });
    res = await policies.evaluateAction({ action: 'cleanup' });
    assert.equal(res.decision, 'auto');
    assert.equal(res.source, 'action:cleanup');

    // Unknown action with no vaultType falls back to global default
    res = await policies.evaluateAction({ action: 'sync' });
    assert.equal(res.decision, 'auto');
    assert.equal(res.source, 'default');

    await policies.update({ default: 'always_ask' });
    res = await policies.evaluateAction({ action: 'sync' });
    assert.equal(res.decision, 'always_ask');
    assert.equal(res.source, 'default');
  });
});

describe('approvalFingerprint', () => {
  it('produces deterministic canonical SHA-256 hex hashes independent of key order', () => {
    const fp1 = approvalFingerprint({
      kind: 'tool',
      target: 'stripe__charge',
      args: {
        currency: 'usd',
        amount: 2500,
        meta: { b: 2, a: 1, nested: [{ z: true, y: false }] },
        ignored: undefined,
      },
    });
    const fp2 = approvalFingerprint({
      args: {
        meta: { nested: [{ y: false, z: true }], a: 1, b: 2 },
        amount: 2500,
        currency: 'usd',
      },
      target: 'stripe__charge',
      kind: 'tool',
    });

    assert.match(fp1, /^[a-f0-9]{64}$/);
    assert.equal(fp1, fp2);

    // Changing any argument, target, or kind changes the hash
    const tamperedAmount = approvalFingerprint({
      kind: 'tool',
      target: 'stripe__charge',
      args: {
        currency: 'usd',
        amount: 25000,
        meta: { a: 1, b: 2, nested: [{ y: false, z: true }] },
      },
    });
    const tamperedTarget = approvalFingerprint({
      kind: 'tool',
      target: 'stripe__refund',
      args: {
        currency: 'usd',
        amount: 2500,
        meta: { a: 1, b: 2, nested: [{ y: false, z: true }] },
      },
    });
    const tamperedKind = approvalFingerprint({
      kind: 'action',
      target: 'stripe__charge',
      args: {
        currency: 'usd',
        amount: 2500,
        meta: { a: 1, b: 2, nested: [{ y: false, z: true }] },
      },
    });

    assert.notEqual(fp1, tamperedAmount);
    assert.notEqual(fp1, tamperedTarget);
    assert.notEqual(fp1, tamperedKind);
  });

  it('G2-12: includes literal __proto__ keys in canonical fingerprint', () => {
    const emptyFp = approvalFingerprint({
      kind: 'tool',
      target: 'stripe__charge',
      args: {},
    });
    const protoFp1 = approvalFingerprint({
      kind: 'tool',
      target: 'stripe__charge',
      args: JSON.parse('{"__proto__":{"isAdmin":true}}'),
    });
    const protoFp2 = approvalFingerprint({
      kind: 'tool',
      target: 'stripe__charge',
      args: JSON.parse('{"__proto__":{"isAdmin":false}}'),
    });
    const protoOrderedA = approvalFingerprint({
      kind: 'tool',
      target: 'stripe__charge',
      args: JSON.parse('{"z":1,"__proto__":{"b":2,"a":1}}'),
    });
    const protoOrderedB = approvalFingerprint({
      kind: 'tool',
      target: 'stripe__charge',
      args: JSON.parse('{"__proto__":{"a":1,"b":2},"z":1}'),
    });

    assert.notEqual(protoFp1, emptyFp);
    assert.notEqual(protoFp1, protoFp2);
    assert.equal(protoOrderedA, protoOrderedB);
  });

  it('G3a-04: binds optional sink into fingerprint without breaking callers that omit sink', () => {
    const withoutSink = approvalFingerprint({
      kind: 'run',
      target: 'stripe__charge',
      args: { amount: 100 },
    });
    const withNullSink = approvalFingerprint({
      kind: 'run',
      target: 'stripe__charge',
      args: { amount: 100 },
      sink: null,
    });
    const withSinkA = approvalFingerprint({
      kind: 'run',
      target: 'stripe__charge',
      args: { amount: 100 },
      sink: 'https://api.stripe.com/mcp',
    });
    const withSinkB = approvalFingerprint({
      kind: 'run',
      target: 'stripe__charge',
      args: { amount: 100 },
      sink: 'https://evil.example/mcp',
    });
    const withObjSink1 = approvalFingerprint({
      kind: 'run',
      target: 'stripe__charge',
      args: { amount: 100 },
      sink: { url: 'https://api.stripe.com/mcp', type: 'http' },
    });
    const withObjSink2 = approvalFingerprint({
      kind: 'run',
      target: 'stripe__charge',
      args: { amount: 100 },
      sink: { type: 'http', url: 'https://api.stripe.com/mcp' },
    });

    assert.equal(withoutSink, withNullSink);
    assert.notEqual(withSinkA, withoutSink);
    assert.notEqual(withSinkA, withSinkB);
    assert.equal(withObjSink1, withObjSink2);
  });
});

describe('ApprovalQueue', () => {
  it('creates, lists newest-first, notifies subscribers, decides, and consumes single-use approvals', () => {
    let clock = 1_700_000_000_000;
    const events = [];
    const queue = new ApprovalQueue({
      ttlMs: 10 * 60 * 1000,
      now: () => clock,
      onChange: (pending) => events.push(pending.map((p) => p.id)),
    });

    const subCalls = [];
    const unsubscribe = queue.subscribe((pending) => {
      subCalls.push(pending.length);
    });
    // Failing subscriber must not disrupt queue operations
    queue.subscribe(() => {
      throw new Error('listener boom');
    });

    const fp1 = approvalFingerprint({
      kind: 'tool',
      target: 'stripe__charge',
      args: { amount: 100, card: '{{vault:VISA}}' },
    });
    const fp2 = approvalFingerprint({
      kind: 'action',
      target: 'cleanup',
      args: { dryRun: false },
    });

    const r1 = queue.create({
      kind: 'tool',
      target: 'stripe__charge',
      title: 'Charge $1.00 on Stripe',
      detail: { amount: 100, card: '{{vault:VISA}}' },
      reason: 'Vault payment secret "VISA" requires approval',
      agentName: 'Claude Code',
      fingerprint: fp1,
      rawSecret: 'must-not-be-stored',
    });

    assert.match(r1.id, /^apr_[a-f0-9]{12}$/);
    assert.equal(r1.status, 'pending');
    assert.equal(r1.agentName, 'Claude Code');
    assert.equal(Object.hasOwn(r1, 'rawSecret'), false);
    assert.equal(Date.parse(r1.expiresAt) - Date.parse(r1.createdAt), 10 * 60 * 1000);

    // Same millisecond creation still preserves newest-first order
    const r2 = queue.create({
      kind: 'action',
      target: 'cleanup',
      title: 'Clean up unused connections',
      detail: { dryRun: false },
      reason: 'Action "cleanup" requires approval',
      agentName: 'Codex',
      fingerprint: fp2,
    });

    const pending = queue.listPending();
    assert.deepEqual(
      pending.map((p) => p.id),
      [r2.id, r1.id],
    );
    assert.equal(queue.get(r1.id).status, 'pending');
    assert.equal(queue.get('apr_000000000000'), null);

    // Cannot consume while still pending
    const stillPending = queue.consume(r1.id, fp1);
    assert.equal(stillPending.ok, false);
    assert.equal(stillPending.status, 'pending');

    // Approve r1, deny r2
    clock += 1000;
    const approved = queue.decide(r1.id, true);
    assert.equal(approved.status, 'approved');
    assert.ok(approved.decidedAt);

    // Double-deciding returns null
    assert.equal(queue.decide(r1.id, false), null);

    const denied = queue.decide(r2.id, false);
    assert.equal(denied.status, 'denied');
    assert.deepEqual(queue.listPending(), []);

    // Denied approval cannot be consumed
    const deniedConsume = queue.consume(r2.id, fp2);
    assert.equal(deniedConsume.ok, false);
    assert.equal(deniedConsume.status, 'denied');

    // Tampered arguments fingerprint is rejected without consuming the approval
    const tamperedFp = approvalFingerprint({
      kind: 'tool',
      target: 'stripe__charge',
      args: { amount: 999999, card: '{{vault:VISA}}' },
    });
    const mismatch = queue.consume(r1.id, tamperedFp);
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.status, 'mismatch');
    assert.equal(queue.get(r1.id).status, 'approved');

    // Matching fingerprint succeeds once
    const consumed = queue.consume(r1.id, fp1);
    assert.deepEqual(consumed, { ok: true });
    assert.equal(queue.get(r1.id).status, 'consumed');

    // Replay is rejected (single-use)
    const replay = queue.consume(r1.id, fp1);
    assert.equal(replay.ok, false);
    assert.equal(replay.status, 'consumed');

    // Unknown id rejected
    const missing = queue.consume('apr_deadbeefcafe', fp1);
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 'not_found');

    // Unsubscribe stops further notifications
    const beforeCount = subCalls.length;
    unsubscribe();
    queue.create({
      kind: 'action',
      target: 'delete',
      title: 'Delete',
      reason: 'Action delete requires approval',
      fingerprint: fp2,
    });
    assert.equal(subCalls.length, beforeCount);
    assert.ok(events.length >= 4);
  });

  it('prunes expired pending items and rejects expired approved tokens on consume', () => {
    let clock = 1_700_000_000_000;
    const ttlMs = 5_000;
    const queue = new ApprovalQueue({ ttlMs, now: () => clock });

    const fpPending = approvalFingerprint({ kind: 'tool', target: 'a__b', args: { x: 1 } });
    const fpApproved = approvalFingerprint({ kind: 'tool', target: 'a__c', args: { x: 2 } });

    const pendingItem = queue.create({
      kind: 'tool',
      target: 'a__b',
      title: 'Pending op',
      reason: 'Needs approval',
      fingerprint: fpPending,
    });
    const approvedItem = queue.create({
      kind: 'tool',
      target: 'a__c',
      title: 'Approved op',
      reason: 'Needs approval',
      fingerprint: fpApproved,
    });

    queue.decide(approvedItem.id, true);
    assert.equal(queue.listPending().length, 1);

    // Advance past TTL
    clock += ttlMs + 1;

    // Pending item is pruned and can no longer be decided
    assert.deepEqual(queue.listPending(), []);
    assert.equal(queue.get(pendingItem.id).status, 'expired');
    assert.equal(queue.decide(pendingItem.id, true), null);

    // Approved item cannot be consumed once expired
    const res = queue.consume(approvedItem.id, fpApproved);
    assert.equal(res.ok, false);
    assert.equal(res.status, 'expired');
    assert.equal(queue.get(approvedItem.id).status, 'expired');
  });

  it('G2-09: binds approvals to agentId and refuses cross-agent consumption', () => {
    const queue = new ApprovalQueue();
    const fp = approvalFingerprint({ kind: 'run', target: 'stripe__charge', args: { amount: 500 } });

    const created = queue.create({
      kind: 'run',
      target: 'stripe__charge',
      title: 'Charge $5',
      reason: 'Connection requires approval',
      agentId: 'agent_alpha',
      agentName: 'Alpha',
      fingerprint: fp,
    });
    assert.equal(created.agentId, 'agent_alpha');
    queue.decide(created.id, true);

    // Different agent cannot consume or steal approval
    const crossAgent = queue.consume(created.id, fp, { agentId: 'agent_beta' });
    assert.deepEqual(crossAgent, {
      ok: false,
      status: 'forbidden',
      error: 'Approval belongs to a different agent.',
    });
    assert.equal(queue.get(created.id).status, 'approved');

    // Missing/null agentId also cannot consume an agent-bound approval
    const missingAgent = queue.consume(created.id, fp);
    assert.equal(missingAgent.ok, false);
    assert.equal(missingAgent.status, 'forbidden');
    assert.equal(queue.get(created.id).status, 'approved');

    // Matching agent consumes successfully
    const ok = queue.consume(created.id, fp, { agentId: 'agent_alpha' });
    assert.deepEqual(ok, { ok: true });
    assert.equal(queue.get(created.id).status, 'consumed');
  });

  it('G2-10: deduplicates active pending approvals and enforces per-agent and global pending caps', () => {
    let clock = 1_700_000_000_000;
    const queue = new ApprovalQueue({ ttlMs: 60_000, now: () => clock });
    const fpSame = approvalFingerprint({ kind: 'run', target: 'a__b', args: { n: 1 } });

    // Identical active pending approval for same agent deduplicates
    const first = queue.create({
      kind: 'run',
      target: 'a__b',
      title: 'Op 1',
      agentId: 'agent_1',
      fingerprint: fpSame,
    });
    const dup = queue.create({
      kind: 'run',
      target: 'a__b',
      title: 'Op 1 retry',
      agentId: 'agent_1',
      fingerprint: fpSame,
    });
    assert.equal(dup.id, first.id);
    assert.equal(queue.listPending().length, 1);

    // Different agent with same fingerprint gets its own pending record
    const otherAgent = queue.create({
      kind: 'run',
      target: 'a__b',
      title: 'Op 1',
      agentId: 'agent_2',
      fingerprint: fpSame,
    });
    assert.notEqual(otherAgent.id, first.id);
    assert.equal(queue.listPending().length, 2);

    // Once decided, same (agentId, fingerprint) creates a new approval
    queue.decide(first.id, false);
    const afterDeny = queue.create({
      kind: 'run',
      target: 'a__b',
      title: 'Op 1 again',
      agentId: 'agent_1',
      fingerprint: fpSame,
    });
    assert.notEqual(afterDeny.id, first.id);

    // Fill agent_cap up to MAX_PENDING_PER_AGENT (20)
    const capQueue = new ApprovalQueue({ ttlMs: 60_000, now: () => clock });
    const createdIds = [];
    for (let i = 0; i < MAX_PENDING_PER_AGENT; i += 1) {
      const rec = capQueue.create({
        kind: 'run',
        target: `svc__op_${i}`,
        agentId: 'agent_flood',
        fingerprint: approvalFingerprint({ kind: 'run', target: `svc__op_${i}`, args: { i } }),
      });
      createdIds.push(rec.id);
    }

    // Retrying an existing pending fingerprint still deduplicates cleanly at cap
    const dedupAtCap = capQueue.create({
      kind: 'run',
      target: 'svc__op_0',
      agentId: 'agent_flood',
      fingerprint: approvalFingerprint({ kind: 'run', target: 'svc__op_0', args: { i: 0 } }),
    });
    assert.equal(dedupAtCap.id, createdIds[0]);

    // 21st distinct pending request for same agent fails with 429
    assert.throws(
      () =>
        capQueue.create({
          kind: 'run',
          target: 'svc__op_overflow',
          agentId: 'agent_flood',
          fingerprint: approvalFingerprint({ kind: 'run', target: 'svc__op_overflow', args: {} }),
        }),
      (err) => err.status === 429 && /Too many pending approval requests/.test(err.message),
    );

    // Deciding one frees a slot for that agent
    capQueue.decide(createdIds[0], false);
    const freed = capQueue.create({
      kind: 'run',
      target: 'svc__op_overflow',
      agentId: 'agent_flood',
      fingerprint: approvalFingerprint({ kind: 'run', target: 'svc__op_overflow', args: {} }),
    });
    assert.equal(freed.status, 'pending');

    // Global cap MAX_PENDING_TOTAL (200) across multiple agents
    const globalQueue = new ApprovalQueue({ ttlMs: 60_000, now: () => clock });
    const agentsNeeded = MAX_PENDING_TOTAL / MAX_PENDING_PER_AGENT;
    for (let a = 0; a < agentsNeeded; a += 1) {
      for (let i = 0; i < MAX_PENDING_PER_AGENT; i += 1) {
        globalQueue.create({
          kind: 'run',
          target: `a${a}__op${i}`,
          agentId: `agent_${a}`,
          fingerprint: approvalFingerprint({ kind: 'run', target: `a${a}__op${i}`, args: { a, i } }),
        });
      }
    }
    assert.equal(globalQueue.listPending().length, MAX_PENDING_TOTAL);
    assert.throws(
      () =>
        globalQueue.create({
          kind: 'run',
          target: 'extra__op',
          agentId: 'agent_new',
          fingerprint: approvalFingerprint({ kind: 'run', target: 'extra__op', args: {} }),
        }),
      (err) => err.status === 429 && /Too many pending approval requests/.test(err.message),
    );
  });

  it('waitForDecision wakes up immediately on approve/deny and resolves cleanly on timeout/abort/ownership', async () => {
    const queue = new ApprovalQueue({ ttlMs: 10_000 });
    const fp1 = approvalFingerprint({ kind: 'run', target: 'stripe__charge', args: { amount: 100 } });
    const fp2 = approvalFingerprint({ kind: 'run', target: 'stripe__refund', args: { amount: 50 } });
    const fp3 = approvalFingerprint({ kind: 'run', target: 'stripe__void', args: { id: 1 } });
    const fp4 = approvalFingerprint({ kind: 'run', target: 'stripe__abort', args: { id: 2 } });

    // Missing approval id
    assert.deepEqual(await queue.waitForDecision('apr_missing'), {
      status: 'not_found',
      approval: null,
    });

    // Wake up immediately on approve()
    const rApprove = queue.create({
      kind: 'run',
      target: 'stripe__charge',
      title: 'Charge',
      agentId: 'agent_a',
      fingerprint: fp1,
    });

    // Wrong agentId gets not_found immediately
    assert.deepEqual(await queue.waitForDecision(rApprove.id, { agentId: 'agent_b', timeoutMs: 5_000 }), {
      status: 'not_found',
      approval: null,
    });

    const tApproveStart = Date.now();
    const waitApprove = queue.waitForDecision(rApprove.id, { agentId: 'agent_a', timeoutMs: 5_000 });
    setTimeout(() => queue.approve(rApprove.id), 15);
    const approvedRes = await waitApprove;
    assert.equal(approvedRes.status, 'approved');
    assert.equal(approvedRes.approval.id, rApprove.id);
    assert.equal(approvedRes.approval.status, 'approved');
    assert.ok(Date.now() - tApproveStart < 1_000, 'should wake up immediately on approve');

    // Already decided resolves immediately
    const alreadyRes = await queue.waitForDecision(rApprove.id, { agentId: 'agent_a', timeoutMs: 5_000 });
    assert.equal(alreadyRes.status, 'approved');
    assert.equal(alreadyRes.approval.id, rApprove.id);

    // Wake up immediately on deny()
    const rDeny = queue.create({
      kind: 'run',
      target: 'stripe__refund',
      title: 'Refund',
      agentId: 'agent_a',
      fingerprint: fp2,
    });
    const tDenyStart = Date.now();
    const waitDeny = queue.waitForDecision(rDeny.id, { agentId: 'agent_a', timeoutMs: 5_000 });
    setTimeout(() => queue.deny(rDeny.id), 15);
    const deniedRes = await waitDeny;
    assert.equal(deniedRes.status, 'denied');
    assert.equal(deniedRes.approval.id, rDeny.id);
    assert.ok(Date.now() - tDenyStart < 1_000, 'should wake up immediately on deny');

    // Timeout returns pending + timedOut: true and cleans up listener
    const rTimeout = queue.create({
      kind: 'run',
      target: 'stripe__void',
      title: 'Void',
      fingerprint: fp3,
    });
    const timedOutRes = await queue.waitForDecision(rTimeout.id, { timeoutMs: 30 });
    assert.equal(timedOutRes.status, 'pending');
    assert.equal(timedOutRes.timedOut, true);
    assert.equal(timedOutRes.approval.id, rTimeout.id);

    // AbortSignal resolves cleanly without waiting for timeout
    const rAbort = queue.create({
      kind: 'run',
      target: 'stripe__abort',
      title: 'Abort test',
      fingerprint: fp4,
    });
    const ac = new AbortController();
    const tAbortStart = Date.now();
    const waitAbort = queue.waitForDecision(rAbort.id, { timeoutMs: 5_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 15);
    const abortedRes = await waitAbort;
    assert.equal(abortedRes.status, 'pending');
    assert.equal(abortedRes.timedOut, true);
    assert.equal(abortedRes.approval.id, rAbort.id);
    assert.ok(Date.now() - tAbortStart < 1_000, 'should wake up immediately on abort');

    // Pre-aborted signal returns immediately
    const preAborted = await queue.waitForDecision(rAbort.id, { timeoutMs: 5_000, signal: ac.signal });
    assert.equal(preAborted.status, 'pending');
    assert.equal(preAborted.timedOut, true);

    // Verify no leaked listeners remain
    assert.equal(queue._listeners.size, 0);

    // Expiry during wait transitions to expired
    const shortQueue = new ApprovalQueue({ ttlMs: 35 });
    const rExpire = shortQueue.create({
      kind: 'run',
      target: 'a__b',
      title: 'Short TTL',
      fingerprint: fp1,
    });
    const expiredRes = await shortQueue.waitForDecision(rExpire.id, { timeoutMs: 5_000 });
    assert.equal(expiredRes.status, 'expired');
    assert.equal(expiredRes.approval.status, 'expired');
    assert.equal(shortQueue._listeners.size, 0);
  });
});

describe('CategoryStore', () => {
  let dir;
  let catStore;

  beforeEach(async () => {
    dir = await createTempDir('loop-categories-');
    catStore = new CategoryStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('G5-03: fails closed on corrupt, non-object, or unreadable categories.json', async () => {
    // Missing file returns empty state
    assert.deepEqual(await catStore.load(), { categories: [], connections: {}, skills: {} });

    const file = path.join(dir, 'categories.json');
    await writeFile(file, '{corrupt json', 'utf8');
    await assert.rejects(() => catStore.load(), SyntaxError);
    await assert.rejects(() => catStore.organize({ createCategories: ['Work'] }), SyntaxError);
    assert.equal(await readFile(file, 'utf8'), '{corrupt json');

    for (const bad of ['null', '[]', '"text"', '{"categories":"bad"}', '{"connections":[]}']) {
      await writeFile(file, bad, 'utf8');
      await assert.rejects(() => catStore.load(), /Invalid categories file/);
      await assert.rejects(() => catStore.organize({ createCategories: ['Work'] }), /Invalid categories file/);
      assert.equal(await readFile(file, 'utf8'), bad);
    }

    // Unreadable file (EACCES) also throws instead of returning empty state
    if (process.getuid?.() !== 0) {
      await writeFile(file, JSON.stringify({ categories: [{ id: 'work', label: 'Work' }], connections: {}, skills: {} }));
      await chmod(file, 0o000);
      try {
        await assert.rejects(() => catStore.load(), (err) => err.code === 'EACCES');
      } finally {
        await chmod(file, 0o600);
      }
    }
  });

  it('G5-04: removeConnection deletes a connection override and saves', async () => {
    await catStore.organize({
      createCategories: [{ id: 'billing', label: 'Billing' }],
      assignConnections: { stripe: 'billing', github: 'cloud-dev' },
    });

    assert.equal(await catStore.removeConnection('nonexistent'), false);
    assert.equal(await catStore.removeConnection('stripe'), true);

    const reloaded = await new CategoryStore(dir).load();
    assert.equal(Object.hasOwn(reloaded.connections, 'stripe'), false);
    assert.equal(reloaded.connections.github, 'cloud-dev');
    assert.equal(reloaded.categories.length, 1);
  });

  it('G5-14: forbids __proto__, constructor, prototype category IDs and uses own-property lookup in categorizeItem', async () => {
    assert.equal(slugifyCategory('__proto__'), '');
    assert.equal(slugifyCategory('constructor'), '');
    assert.equal(slugifyCategory('prototype'), '');
    assert.equal(slugifyCategory('  CONSTRUCTOR  '), '');

    const state = await catStore.organize({
      createCategories: [
        '__proto__',
        'constructor',
        'prototype',
        { id: '__proto__', label: 'Sneaky' },
        { id: 'constructor', label: 'Also Sneaky' },
        { id: 'team-ops', label: 'Team Ops' },
      ],
      assignConnections: {
        stripe: 'constructor',
        github: '__proto__',
        vercel: 'prototype',
        __proto__: 'team-ops',
        constructor: 'team-ops',
        custom_conn: 'team-ops',
      },
    });

    assert.deepEqual(
      state.categories.map((c) => c.id),
      ['team-ops'],
    );
    assert.deepEqual(state.connections, { custom_conn: 'team-ops' });

    // categorizeItem must not treat inherited Object.prototype keys as assigned categories
    assert.deepEqual(categorizeItem({ id: 'toString', name: 'x' }, { state }), GENERAL_CATEGORY);
    assert.deepEqual(categorizeItem({ id: 'constructor', name: 'x' }, { state }), GENERAL_CATEGORY);
    assert.deepEqual(categorizeItem({ id: 'valueOf', name: 'x' }, { state }), GENERAL_CATEGORY);
    assert.deepEqual(categorizeItem({ id: '__proto__', name: 'x' }, { state }), GENERAL_CATEGORY);
    assert.deepEqual(categorizeItem({ id: 'custom_conn', name: 'x' }, { state }), {
      id: 'team-ops',
      label: 'Team Ops',
    });
  });
});
