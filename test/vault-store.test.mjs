import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../lib/vault.mjs';
import {
  MASK,
  PLACEHOLDER_RE,
  VAULT_KEY_PATTERN,
  connectionSecretKeys,
  createRedactor,
  expandSecretVariants,
  fillSecretRefs,
  findSecretRefs,
  hasInternalSecretRefs,
  isInternalVaultKey,
  maskSecrets,
  readSecrets,
} from '../lib/secret-refs.mjs';
import { LoopStore } from '../lib/store.mjs';

async function createTempDir(prefix = 'loop-unit-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('Vault', () => {
  let dir;
  let vault;

  beforeEach(async () => {
    dir = await createTempDir('loop-vault-');
    vault = new Vault(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sets, gets, lists (with masking), and deletes secrets', async () => {
    assert.deepEqual(await vault.list(), []);
    assert.equal(await vault.get('MISSING'), null);

    const shortMeta = await vault.set('SHORT_KEY', 'abc123', 'Short token');
    assert.equal(shortMeta.key, 'SHORT_KEY');
    assert.equal(shortMeta.description, 'Short token');
    assert.equal(shortMeta.masked, '••••');
    assert.ok(shortMeta.updatedAt);

    const longMeta = await vault.set('API_TOKEN', 'super-secret-value-9876', '  Production API  ');
    assert.equal(longMeta.key, 'API_TOKEN');
    assert.equal(longMeta.description, 'Production API');
    assert.equal(longMeta.masked, '••••');

    assert.equal(await vault.get('SHORT_KEY'), 'abc123');
    assert.equal(await vault.delete('SHORT_KEY', null, { expectedValue: 'replaced-value' }), false);
    assert.equal(await vault.get('SHORT_KEY'), 'abc123');
    assert.equal(await vault.get('API_TOKEN'), 'super-secret-value-9876');

    const listed = await vault.list();
    assert.equal(listed.length, 2);
    // Alphabetically sorted
    assert.deepEqual(
      listed.map((s) => s.key),
      ['API_TOKEN', 'SHORT_KEY'],
    );
    assert.equal(listed[0].masked, '••••');
    assert.equal(listed[0].description, 'Production API');
    assert.equal(listed[1].masked, '••••');

    assert.equal(await vault.delete('API_TOKEN'), true);
    assert.equal(await vault.delete('API_TOKEN'), false);
    assert.equal(await vault.get('API_TOKEN'), null);
    assert.deepEqual(
      (await vault.list()).map((s) => s.key),
      ['SHORT_KEY'],
    );
  });

  it('hides __ internal keys in list() unless includeInternal is true', async () => {
    await vault.set('USER_KEY', 'user-secret-1234', 'User secret');
    await vault.set('__oauth_access_github', 'oauth-access-token-5678', 'Internal OAuth');
    await vault.set('__oauth_refresh_github', 'oauth-refresh-token-9999');

    const publicList = await vault.list();
    assert.deepEqual(
      publicList.map((s) => s.key),
      ['USER_KEY'],
    );

    const fullList = await vault.list({ includeInternal: true });
    assert.deepEqual(
      fullList.map((s) => s.key),
      ['__oauth_access_github', '__oauth_refresh_github', 'USER_KEY'],
    );

    // Internal keys are still readable via get()
    assert.equal(await vault.get('__oauth_access_github'), 'oauth-access-token-5678');
  });

  it('encrypts secrets with AES-256-GCM on disk and never writes plaintext to vault.json', async () => {
    const plaintext = 'top-secret-credential-xyz-4242';
    await vault.set('MY_SECRET', plaintext, 'Encrypted check');

    const keyBuf = await readFile(path.join(dir, 'vault.key'));
    assert.equal(keyBuf.length, 32);

    const rawVaultJson = await readFile(path.join(dir, 'vault.json'), 'utf8');
    assert.equal(rawVaultJson.includes(plaintext), false, 'Plaintext must not appear in vault.json');
    assert.equal(rawVaultJson.includes('top-secret-credential'), false);

    const parsed = JSON.parse(rawVaultJson);
    assert.equal(parsed.version, 1);
    const entry = parsed.entries.MY_SECRET;
    assert.ok(entry);
    assert.equal(typeof entry.iv, 'string');
    assert.equal(typeof entry.tag, 'string');
    assert.equal(typeof entry.data, 'string');
    assert.equal(Buffer.from(entry.iv, 'base64').length, 12);
    assert.equal(Buffer.from(entry.tag, 'base64').length, 16);

    // A fresh Vault instance using the same directory decrypts identically
    const freshVault = new Vault(dir);
    assert.equal(await freshVault.get('MY_SECRET'), plaintext);
  });

  it('resolves {{vault:KEY}} placeholders in resolveString and resolveRecord and throws on missing keys', async () => {
    await vault.set('TOKEN_A', 'alpha-secret');
    await vault.set('TOKEN_B', 'beta-secret');

    // No placeholder
    assert.equal(await vault.resolveString('plain text'), 'plain text');
    assert.equal(await vault.resolveString(123), 123);

    // Single, multiple, and repeated placeholders
    assert.equal(
      await vault.resolveString('Bearer {{vault:TOKEN_A}}'),
      'Bearer alpha-secret',
    );
    assert.equal(
      await vault.resolveString('{{vault:TOKEN_A}}:{{vault:TOKEN_B}}:{{vault:TOKEN_A}}'),
      'alpha-secret:beta-secret:alpha-secret',
    );

    // Missing key throws
    await assert.rejects(
      () => vault.resolveString('Bearer {{vault:DOES_NOT_EXIST}}'),
      /Vault secret "DOES_NOT_EXIST" not found/,
    );

    // resolveRecord
    const resolved = await vault.resolveRecord({
      Authorization: 'Bearer {{vault:TOKEN_A}}',
      'X-Secondary': '{{vault:TOKEN_B}}',
      'X-Plain': 'static',
      Numeric: 42,
    });
    assert.deepEqual(resolved, {
      Authorization: 'Bearer alpha-secret',
      'X-Secondary': 'beta-secret',
      'X-Plain': 'static',
      Numeric: 42,
    });

    assert.deepEqual(await vault.resolveRecord(null), {});

    await assert.rejects(
      () => vault.resolveRecord({ Authorization: 'Bearer {{vault:MISSING_KEY}}' }),
      /Vault secret "MISSING_KEY" not found/,
    );
  });

  it('validates vault key names', async () => {
    await assert.rejects(() => vault.set('', 'val'), /Vault key must be/);
    await assert.rejects(() => vault.set('bad key with spaces', 'val'), /Vault key must be/);
    await assert.rejects(() => vault.set('bad/slash', 'val'), /Vault key must be/);
  });

  it('serializes concurrent set() calls without losing writes', async () => {
    await Promise.all([
      vault.set('KEY_1', 'value-one-1111'),
      vault.set('KEY_2', 'value-two-2222'),
      vault.set('KEY_3', 'value-three-3333'),
    ]);

    assert.equal(await vault.get('KEY_1'), 'value-one-1111');
    assert.equal(await vault.get('KEY_2'), 'value-two-2222');
    assert.equal(await vault.get('KEY_3'), 'value-three-3333');
    assert.equal((await vault.list()).length, 3);
  });

  it('is immune to quadratic ReDoS on 20,000 unclosed placeholders (G2-07)', async () => {
    await vault.set('X', 'x-value-123456');
    const malicious = '{{vault:'.repeat(20000);

    const t0 = performance.now();
    const resolved = await vault.resolveString(malicious);
    const resolveMs = performance.now() - t0;

    assert.equal(resolved, malicious);
    assert.ok(resolveMs < 50, `resolveString took ${resolveMs.toFixed(1)}ms, expected <50ms`);

    const t1 = performance.now();
    const refs = findSecretRefs({ headers: { Authorization: malicious } });
    const scanMs = performance.now() - t1;

    assert.deepEqual(refs, []);
    assert.ok(scanMs < 50, `findSecretRefs took ${scanMs.toFixed(1)}ms, expected <50ms`);
  });

  it('blocks internal __* credentials in resolveString/resolveRecord while keeping get/getInternal working (G6-01)', async () => {
    await vault.set('__agent_token_x', 'agent-secret-token-9999');
    await vault.set('__oauth_access_gh', 'oauth-secret-token-8888');
    await vault.set('USER_TOKEN', 'user-secret-token-1111');

    // Direct internal reads continue to work via get() and getInternal()
    assert.equal(await vault.get('__agent_token_x'), 'agent-secret-token-9999');
    assert.equal(await vault.getInternal('__agent_token_x'), 'agent-secret-token-9999');
    assert.equal(await vault.getInternal('__missing'), null);

    // Placeholder resolution refuses internal keys
    await assert.rejects(
      () => vault.resolveString('{{vault:__agent_token_x}}'),
      /Vault secret references cannot access internal Loop credentials/,
    );
    await assert.rejects(
      () => vault.resolveString('Bearer {{vault:MISSING}} {{vault:__agent_token_x}}'),
      /Vault secret references cannot access internal Loop credentials/,
    );
    await assert.rejects(
      () => vault.resolveRecord({ 'X-Telemetry-Id': '{{vault:__oauth_access_gh}}' }),
      /Vault secret references cannot access internal Loop credentials/,
    );

    // Normal user secrets still resolve cleanly
    assert.equal(
      await vault.resolveString('Bearer {{vault:USER_TOKEN}}'),
      'Bearer user-secret-token-1111',
    );
  });

  it('refuses to generate a new vault.key when vault.json already contains encrypted secrets (G2-13)', async () => {
    await vault.set('EXISTING_SECRET', 'keep-me-safe-1234');
    const keyPath = path.join(dir, 'vault.key');
    const savedKey = await readFile(keyPath);

    await unlink(keyPath);

    const freshVault = new Vault(dir);
    await assert.rejects(
      () => freshVault.set('NEW_SECRET', 'should-fail-5678'),
      /Vault key file \(vault\.key\) is missing while vault\.json contains encrypted secrets/,
    );

    // Confirm vault.key was NOT regenerated
    await assert.rejects(() => readFile(keyPath), { code: 'ENOENT' });

    // Restoring vault.key restores full read/write functionality
    await writeFile(keyPath, savedKey, { mode: 0o600 });
    assert.equal(await freshVault.get('EXISTING_SECRET'), 'keep-me-safe-1234');
    await freshVault.set('NEW_SECRET', 'now-works-5678');
    assert.equal(await freshVault.get('NEW_SECRET'), 'now-works-5678');
  });

  it('allows generating a new vault.key when vault.json has no entries', async () => {
    await writeFile(
      path.join(dir, 'vault.json'),
      JSON.stringify({ version: 1, entries: {} }, null, 2),
      'utf8',
    );
    await vault.set('FIRST_KEY', 'brand-new-secret');
    assert.equal(await vault.get('FIRST_KEY'), 'brand-new-secret');
  });

  it('handles secret-refs discovery, internal filtering, fill, and readSecrets', async () => {
    assert.equal(VAULT_KEY_PATTERN.test('VALID_key-1.2'), true);
    assert.equal(VAULT_KEY_PATTERN.test('bad/key'), false);
    assert.equal(PLACEHOLDER_RE.global, true);
    assert.equal(MASK, '••••');
    assert.equal(isInternalVaultKey('__agent_token_1'), true);
    assert.equal(isInternalVaultKey('USER_KEY'), false);
    assert.equal(isInternalVaultKey(null), false);

    // findSecretRefs detects both normal and internal keys (including in object keys)
    const payload = {
      url: 'https://api.example.test/?k={{vault:API_KEY}}',
      headers: {
        Authorization: 'Bearer {{vault:__agent_token_1}}',
        'X-{{vault:HDR_KEY}}': '{{vault:API_KEY}}',
      },
    };
    assert.deepEqual(findSecretRefs(payload), ['API_KEY', '__agent_token_1', 'HDR_KEY']);
    assert.equal(hasInternalSecretRefs(payload), true);
    assert.equal(hasInternalSecretRefs({ a: '{{vault:API_KEY}}' }), false);

    // connectionSecretKeys extracts refs across url, headers, env, args
    assert.deepEqual(
      connectionSecretKeys({
        url: 'https://api.example.test/?t={{vault:URL_TOK}}',
        headers: { Authorization: 'Bearer {{vault:HDR_TOK}}' },
        env: { KEY: '{{vault:ENV_TOK}}' },
        args: ['--token', '{{vault:ARG_TOK}}'],
      }),
      ['URL_TOK', 'HDR_TOK', 'ENV_TOK', 'ARG_TOK'],
    );

    // fillSecretRefs never substitutes __* keys even if present in values Map
    const values = new Map([
      ['API_KEY', 'real-api-key-9999'],
      ['__agent_token_1', 'internal-token-never-fill'],
    ]);
    const filled = fillSecretRefs(
      {
        ok: 'Bearer {{vault:API_KEY}}',
        blocked: 'Bearer {{vault:__agent_token_1}}',
        unknown: '{{vault:MISSING}}',
      },
      values,
    );
    assert.deepEqual(filled, {
      ok: 'Bearer real-api-key-9999',
      blocked: 'Bearer {{vault:__agent_token_1}}',
      unknown: '{{vault:MISSING}}',
    });

    // readSecrets skips internal keys by default and allows them with allowInternal: true
    await vault.set('PUBLIC_KEY', 'pub-secret-1234');
    await vault.set('__internal_key', 'int-secret-5678');

    const safeMap = await readSecrets(vault, ['PUBLIC_KEY', '__internal_key']);
    assert.equal(safeMap.get('PUBLIC_KEY'), 'pub-secret-1234');
    assert.equal(safeMap.has('__internal_key'), false);

    const internalMap = await readSecrets(vault, ['PUBLIC_KEY', '__internal_key'], {
      allowInternal: true,
    });
    assert.equal(internalMap.get('PUBLIC_KEY'), 'pub-secret-1234');
    assert.equal(internalMap.get('__internal_key'), 'int-secret-5678');
  });

  it('redacts raw, JSON-escaped, PHP, Python, double-JSON, URL, Base64, Error, and object-key copies of secrets', () => {
    const PEM_KEY =
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0\r\tAbCdEfGh\n-----END PRIVATE KEY-----';
    const QUOTE_PW = 'pa"ss\\word-9911-quoted';
    const UNI_PW = 'pässwörd/ünïcode-7788';
    const SLASH_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY+abc=';
    const SPACE_PW = 'my secret key/value';
    const KEYED = 'sk-live-keyed-secret-123456';

    const emptyRedactor = createRedactor(['']);
    assert.equal(emptyRedactor.hasSecrets, false);
    assert.equal(emptyRedactor.redact('abc stays unmasked'), 'abc stays unmasked');

    const shortRedactor = createRedactor(['abc', '']);
    assert.equal(shortRedactor.hasSecrets, true);
    assert.equal(shortRedactor.redact('abc stays masked'), `${MASK} stays masked`);
    assert.equal(shortRedactor.redact('abcd stays intact'), 'abcd stays intact');

    const redactor = createRedactor([PEM_KEY, QUOTE_PW, UNI_PW, SLASH_KEY, SPACE_PW, KEYED]);
    assert.equal(redactor.hasSecrets, true);

    // 1. Raw
    assert.equal(redactor.redact(`token=${KEYED}`), `token=${MASK}`);

    // 2. JSON-escaped (\n, \r, \t, \", \\)
    const pemEcho = `echo:${JSON.stringify({ v: PEM_KEY })}`;
    const maskedPemEcho = redactor.redact(pemEcho);
    assert.equal(JSON.parse(maskedPemEcho.replace(/^echo:/, '')).v, MASK);

    const quoteEcho = `echo:${JSON.stringify({ v: QUOTE_PW })}`;
    const maskedQuoteEcho = redactor.redact(quoteEcho);
    assert.equal(JSON.parse(maskedQuoteEcho.replace(/^echo:/, '')).v, MASK);

    // 3. PHP/HTML slash-escaped JSON (\/)
    const phpJson = JSON.stringify({ v: SLASH_KEY }).replace(/\//g, '\\/');
    const maskedPhp = redactor.redact(phpJson);
    assert.equal(JSON.parse(maskedPhp).v, MASK);

    // 4. Python ensure_ascii JSON (\uXXXX lowercase & uppercase, normal & slash-escaped)
    const pyLower = JSON.stringify({ v: UNI_PW }).replace(
      /[\u007f-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
    const pyUpper = JSON.stringify({ v: UNI_PW }).replace(
      /[\u007f-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
    );
    assert.equal(JSON.parse(redactor.redact(pyLower)).v, MASK);
    assert.equal(JSON.parse(redactor.redact(pyUpper)).v, MASK);
    assert.equal(JSON.parse(redactor.redact(pyLower.replace(/\//g, '\\/'))).v, MASK);
    assert.equal(JSON.parse(redactor.redact(pyUpper.replace(/\//g, '\\/'))).v, MASK);

    // 5. Double-JSON-escaped (JSON inside JSON error message)
    const doubleEscaped = JSON.stringify({ err: JSON.stringify({ v: QUOTE_PW }) });
    const maskedDouble = redactor.redact(doubleEscaped);
    assert.equal(maskedDouble.includes(QUOTE_PW), false);
    assert.equal(JSON.parse(JSON.parse(maskedDouble).err).v, MASK);

    // 6. URL-encoded (uppercase hex, lowercase hex, and %20 -> + form encoding)
    const urlUpper = `GET https://api.example.test/?k=${encodeURIComponent(SLASH_KEY)}`;
    const urlLower = `GET https://api.example.test/?k=${encodeURIComponent(SLASH_KEY).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())}`;
    const formUpper = `q=${encodeURIComponent(SPACE_PW).replace(/%20/g, '+')}`;
    const formLower = `q=${encodeURIComponent(SPACE_PW)
      .replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())
      .replace(/%20/g, '+')}`;
    assert.equal(redactor.redact(urlUpper), `GET https://api.example.test/?k=${MASK}`);
    assert.equal(redactor.redact(urlLower), `GET https://api.example.test/?k=${MASK}`);
    assert.equal(redactor.redact(formUpper), `q=${MASK}`);
    assert.equal(redactor.redact(formLower), `q=${MASK}`);

    // 7. Base64 and Base64url (>= 6 chars only)
    const b64 = Buffer.from(SLASH_KEY, 'utf8').toString('base64');
    const b64url = Buffer.from(SLASH_KEY, 'utf8').toString('base64url');
    assert.equal(redactor.redact(`Basic ${b64}`), `Basic ${MASK}`);
    assert.equal(redactor.redact(`tok=${b64url}`), `tok=${MASK}`);

    const shortVariants = expandSecretVariants('12345');
    assert.equal(shortVariants.includes(Buffer.from('12345', 'utf8').toString('base64')), false);
    assert.deepEqual(expandSecretVariants('123'), []);

    // 8. Object keys in structuredContent (G2-11) & maskSecrets convenience wrapper
    const toolResult = {
      content: [{ type: 'text', text: 'see structured' }],
      structuredContent: {
        [KEYED]: {
          valid: true,
          nested: { [`prefix-${SLASH_KEY}`]: KEYED },
        },
      },
    };
    const maskedResult = maskSecrets(toolResult, [KEYED, SLASH_KEY]);
    assert.equal(Object.keys(maskedResult.structuredContent).includes(KEYED), false);
    assert.deepEqual(maskedResult.structuredContent, {
      [MASK]: {
        valid: true,
        nested: { [`prefix-${MASK}`]: MASK },
      },
    });

    // 9. Prototype pollution safety on __proto__ keys
    const protoPayload = JSON.parse(`{"__proto__":{"leaked":"${KEYED}"},"safe":"ok"}`);
    const maskedProto = maskSecrets(protoPayload, [KEYED]);
    assert.equal(Object.getPrototypeOf(maskedProto), Object.prototype);
    assert.equal(({}).leaked, undefined);
    assert.equal(Object.hasOwn(maskedProto, '__proto__'), true);
    assert.equal(maskedProto['__proto__'].leaked, MASK);

    // 10. Error instances
    const err = new TypeError(`Rejected key ${KEYED}`);
    err.detail = { token: KEYED };
    const maskedErr = redactor.redact(err);
    assert.ok(maskedErr instanceof Error);
    assert.equal(maskedErr.name, 'TypeError');
    assert.equal(maskedErr.message, `Rejected key ${MASK}`);
    assert.equal(maskedErr.stack.includes(KEYED), false);
    assert.deepEqual(maskedErr.detail, { token: MASK });
  });
});

describe('LoopStore', () => {
  let dir;
  let store;

  beforeEach(async () => {
    dir = await createTempDir('loop-store-');
    store = new LoopStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('gets default settings, updates settings, and validates inputs', async () => {
    assert.deepEqual(await store.getSettings(), {
      defaultProfile: 'all',
      requireAgentToken: true,
      paused: false,
      turnRecall: false,
    });

    const updated = await store.updateSettings({
      defaultProfile: '  Work Team  ',
    });
    assert.deepEqual(updated, {
      defaultProfile: 'work-team',
      requireAgentToken: true,
      paused: false,
      turnRecall: false,
    });

    // Persists across instances
    const reloaded = new LoopStore(dir);
    assert.deepEqual(await reloaded.getSettings(), {
      defaultProfile: 'work-team',
      requireAgentToken: true,
      paused: false,
      turnRecall: false,
    });

    const keyless = await store.updateSettings({ requireAgentToken: false });
    assert.equal(keyless.requireAgentToken, false);

    // Validation errors
    await assert.rejects(() => store.updateSettings(null), /Settings patch must be an object/);
    await assert.rejects(() => store.updateSettings([]), /Settings patch must be an object/);
    await assert.rejects(
      () => store.updateSettings({ defaultProfile: '   ' }),
      /Default profile must be a non-empty string/,
    );
  });

  it('adds, reads, updates, and removes HTTP and stdio connections', async () => {
    // HTTP connection (using streamable-http alias)
    const httpConn = await store.add({
      name: 'Figma Design',
      transport: 'streamable-http',
      url: 'https://mcp.figma.example/mcp',
      headers: { Authorization: 'Bearer {{vault:FIGMA}}', 'X-Empty': '   ' },
      profiles: ['Design', 'work'],
    });

    assert.equal(httpConn.id, 'figma_design');
    assert.equal(httpConn.transport, 'http');
    assert.equal(httpConn.url, 'https://mcp.figma.example/mcp');
    assert.deepEqual(httpConn.headers, { Authorization: 'Bearer {{vault:FIGMA}}' });
    assert.deepEqual(httpConn.profiles, ['all', 'design', 'work']);
    assert.equal(httpConn.enabled, true);

    // Duplicate name gets suffixed id
    const httpConn2 = await store.add({
      name: 'Figma Design',
      url: 'https://mcp.figma.example/v2',
    });
    assert.equal(httpConn2.id, 'figma_design_2');

    // Stdio connection (auto-inferred from command)
    const stdioConn = await store.add({
      name: 'Local FS',
      command: 'node',
      args: ['server.mjs', '--readonly'],
      env: { API_KEY: '{{vault:LOCAL_KEY}}' },
      profiles: ['dev'],
    });

    assert.equal(stdioConn.id, 'local_fs');
    assert.equal(stdioConn.transport, 'stdio');
    assert.equal(stdioConn.url, null);
    assert.equal(stdioConn.command, 'node');
    assert.deepEqual(stdioConn.args, ['server.mjs', '--readonly']);
    assert.deepEqual(stdioConn.env, { API_KEY: '{{vault:LOCAL_KEY}}' });
    assert.deepEqual(stdioConn.profiles, ['all', 'dev']);

    // Validation errors
    await assert.rejects(() => store.add({ name: '' }), /Name is required/);
    await assert.rejects(
      () => store.add({ name: 'Bad URL', url: 'ftp://example.com' }),
      /URL must use http or https/,
    );
    await assert.rejects(
      () => store.add({ name: 'Missing Cmd', transport: 'stdio' }),
      /Command is required for stdio transport/,
    );

    // Update HTTP connection
    const updatedHttp = await store.update(httpConn.id, {
      name: 'Figma Enterprise',
      enabled: false,
      profiles: ['design'],
      id: 'hacked_id',
    });
    assert.equal(updatedHttp.id, httpConn.id, 'id must remain immutable');
    assert.equal(updatedHttp.createdAt, httpConn.createdAt, 'createdAt must remain immutable');
    assert.equal(updatedHttp.name, 'Figma Enterprise');
    assert.equal(updatedHttp.enabled, false);
    assert.deepEqual(updatedHttp.profiles, ['all', 'design']);

    // Update stdio connection
    const updatedStdio = await store.update(stdioConn.id, {
      args: ['server.mjs', '--rw'],
      env: { API_KEY: '{{vault:NEW_KEY}}', DEBUG: '1' },
    });
    assert.deepEqual(updatedStdio.args, ['server.mjs', '--rw']);
    assert.deepEqual(updatedStdio.env, { API_KEY: '{{vault:NEW_KEY}}', DEBUG: '1' });

    // Non-existent update returns null
    assert.equal(await store.update('nonexistent', { name: 'Nope' }), null);

    // Remove
    assert.equal(await store.remove(httpConn2.id), true);
    assert.equal(await store.remove(httpConn2.id), false);
    assert.equal(await store.get(httpConn2.id), null);

    const remaining = await store.list();
    assert.deepEqual(
      remaining.map((c) => c.id),
      ['figma_design', 'local_fs'],
    );
  });

  it('toggles individual tools via toggleTool()', async () => {
    const conn = await store.add({
      name: 'GitHub',
      url: 'https://mcp.github.example/mcp',
    });

    const disabled = await store.toggleTool(conn.id, 'delete_repo', false);
    assert.deepEqual(disabled.disabledTools, ['delete_repo']);

    // Disabling same tool twice does not duplicate
    const disabledAgain = await store.toggleTool(conn.id, 'delete_repo', false);
    assert.deepEqual(disabledAgain.disabledTools, ['delete_repo']);

    await store.toggleTool(conn.id, 'force_push', false);
    const reenabled = await store.toggleTool(conn.id, 'delete_repo', true);
    assert.deepEqual(reenabled.disabledTools, ['force_push']);

    assert.equal(await store.toggleTool('missing_id', 'tool', false), null);
    await assert.rejects(() => store.toggleTool(conn.id, '   ', false), /Tool name is required/);
  });

  it('lists all unique profiles sorted alphabetically with "all" first', async () => {
    assert.deepEqual(await store.listProfiles(), ['all']);

    await store.add({
      name: 'Server A',
      url: 'https://a.example/mcp',
      profiles: ['zeta', 'Design'],
    });
    await store.add({
      name: 'Server B',
      command: 'node',
      args: ['b.mjs'],
      profiles: ['design', 'analytics'],
    });

    assert.deepEqual(await store.listProfiles(), ['all', 'analytics', 'design', 'zeta']);
  });

  it('imports mcpServers JSON with url, serverUrl, command, and deduplication', async () => {
    const payload = JSON.stringify({
      mcpServers: {
        Linear: {
          url: 'https://mcp.linear.example/mcp',
          headers: { 'X-Workspace': 'linear-team' },
        },
        VaultRefAttempt: {
          url: 'https://evil.example/mcp',
          headers: { Authorization: 'Bearer {{vault:LINEAR}}' },
        },
        Notion: {
          serverUrl: 'https://mcp.notion.example/sse',
          type: 'sse',
        },
        Filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          env: { LOG_LEVEL: 'info' },
        },
        InvalidEntry: {
          url: 'not-a-valid-url',
        },
      },
    });

    const first = await store.importMcpJson(payload, { profile: 'imported' });
    assert.equal(first.added.length, 3);
    assert.equal(first.skipped.length, 2);
    assert.ok(first.skipped.some((s) => s.name === 'InvalidEntry'));
    assert.ok(first.skipped.some((s) => s.name === 'VaultRefAttempt'), 'vault placeholders in pasted JSON must be refused');

    const linear = first.added.find((m) => m.name === 'Linear');
    assert.equal(linear.transport, 'http');
    assert.equal(linear.url, 'https://mcp.linear.example/mcp');
    assert.deepEqual(linear.profiles, ['all', 'imported']);

    const notion = first.added.find((m) => m.name === 'Notion');
    assert.equal(notion.transport, 'sse');
    assert.equal(notion.url, 'https://mcp.notion.example/sse');

    const fsEntry = first.added.find((m) => m.name === 'Filesystem');
    assert.equal(fsEntry.transport, 'stdio');
    assert.equal(fsEntry.command, 'npx');
    assert.deepEqual(fsEntry.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
    assert.deepEqual(fsEntry.env, { LOG_LEVEL: 'info' });

    // Second import with duplicates + one new server
    const second = await store.importMcpJson({
      mcpServers: {
        LinearClone: { url: 'https://mcp.linear.example/mcp' },
        FsClone: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        },
        NewStdio: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
        },
      },
    });

    assert.equal(second.added.length, 1);
    assert.equal(second.added[0].name, 'NewStdio');
    assert.equal(second.skipped.length, 2);
    assert.deepEqual(
      second.skipped.map((s) => s.name),
      ['LinearClone', 'FsClone'],
    );
    assert.ok(second.skipped.every((s) => s.reason === 'Already exists.'));
  });

  it('migrates legacy mcps.json into config.json on first load', async () => {
    const legacyPayload = {
      mcps: [
        {
          id: 'legacy_github',
          name: 'Legacy GitHub',
          url: 'https://legacy.github.example/mcp',
          headers: { Authorization: 'Bearer old-token' },
          enabled: true,
          tools: [{ name: 'list_issues', description: 'List issues' }],
        },
      ],
    };

    await writeFile(path.join(dir, 'mcps.json'), JSON.stringify(legacyPayload, null, 2), 'utf8');

    const mcps = await store.list();
    assert.equal(mcps.length, 1);
    assert.equal(mcps[0].id, 'legacy_github');
    assert.equal(mcps[0].name, 'Legacy GitHub');
    assert.equal(mcps[0].transport, 'http');
    assert.deepEqual(mcps[0].profiles, ['all']);
    assert.deepEqual(mcps[0].disabledTools, []);
    assert.equal(mcps[0].tools.length, 1);
    assert.equal(mcps[0].tools[0].name, 'list_issues');

    // Verify config.json was created on disk with default settings and migrated mcps
    const migratedRaw = await readFile(path.join(dir, 'config.json'), 'utf8');
    const migrated = JSON.parse(migratedRaw);
    assert.deepEqual(migrated.settings, {
      defaultProfile: 'all',
      requireAgentToken: false,
      paused: false,
      turnRecall: false,
    });
    assert.equal(migrated.mcps.length, 1);
    assert.equal(migrated.mcps[0].id, 'legacy_github');
  });
});
