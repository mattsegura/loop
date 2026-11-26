// End-to-end tests for Loop release publishing, download routes, SHA-256 verification,
// `loop` CLI update/rollback, and hosted agent `connect.mjs --update`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server.mjs';
import { isNodeVersionSupported, isValidTarballFilename, sha256Buffer, sha256File } from '../lib/release.mjs';
import { runConnectCli } from '../scripts/connect-agents.mjs';
import { runLoopCli, validateReleaseOrigin } from '../scripts/loop-cli.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function makeMockReleaseArchive(outDir, { releaseTag, commit, notes = '' }) {
  const stage = await mkdtemp(path.join(os.tmpdir(), 'loop-tar-stage-'));
  try {
    await writeFile(path.join(stage, 'RELEASE'), `${releaseTag} ${commit}\n`);
    await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'loop-local-hub', version: '1.0.0', type: 'module' }));
    await writeFile(path.join(stage, 'server.mjs'), 'export const loaded = true;\n');
    await mkdir(path.join(stage, 'scripts'), { recursive: true });
    await writeFile(path.join(stage, 'scripts', 'loop-cli.mjs'), 'console.log("ok");\n');
    await mkdir(path.join(stage, 'hooks'), { recursive: true });
    await writeFile(path.join(stage, 'hooks', 'loop-hook.mjs'), '#!/usr/bin/env node\n');
    await mkdir(path.join(stage, 'skills', 'loop'), { recursive: true });
    await writeFile(path.join(stage, 'skills', 'loop', 'SKILL.md'), `---\nname: "loop"\n---\n# Loop ${releaseTag}\n`);

    const safeTag = releaseTag.replace(/\//g, '-');
    const filename = `loop-${safeTag}.tar.gz`;
    const tarPath = path.join(outDir, filename);
    execFileSync('tar', ['-czf', tarPath, '-C', stage, '.']);
    const sha256 = await sha256File(tarPath);
    const bytes = (await readFile(tarPath)).length;
    const manifest = {
      release: releaseTag,
      commit,
      publishedAt: '2026-11-25T12:00:00Z',
      notes,
      tarball: { filename, sha256, bytes },
    };
    await writeFile(path.join(outDir, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { filename, tarPath, sha256, bytes, manifest };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

test('release helpers validate semver, filenames, and update origins strictly', () => {
  assert.equal(isNodeVersionSupported('22.13.0', '22.13.0'), true);
  assert.equal(isNodeVersionSupported('24.0.0', '22.13.0'), true);
  assert.equal(isNodeVersionSupported('22.12.9', '22.13.0'), false);

  assert.equal(isValidTarballFilename('loop-release-20261125-120000.tar.gz'), true);
  assert.equal(isValidTarballFilename('../loop-latest.tar.gz'), false);
  assert.equal(isValidTarballFilename('other.tar.gz'), false);

  assert.equal(validateReleaseOrigin('https://useloop.sh/release.json'), 'https://useloop.sh');
  assert.equal(validateReleaseOrigin('http://127.0.0.1:8799'), 'http://127.0.0.1:8799');
  assert.throws(() => validateReleaseOrigin('http://evil.example.com'), /https/);
  assert.throws(() => validateReleaseOrigin('https://user:pass@useloop.sh'), /credentials/);
});

test('server serves /release.json, /install.sh, /agent-files/*, /downloads/*, real MCP version, and /health version', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'loop-rel-srv-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const releasesDir = path.join(home, 'releases');
  await mkdir(releasesDir, { recursive: true });
  await mkdir(path.join(home, 'data'), { recursive: true });
  const rel1 = await makeMockReleaseArchive(releasesDir, {
    releaseTag: 'release/20261125-120000',
    commit: '1111111111111111111111111111111111111111',
    notes: 'First downloadable release.',
  });

  const srv = await startServer({
    port: 0,
    dataDir: path.join(home, 'data'),
    home,
    releasesDir,
    authMode: 'local-test',
    detectLocalAgents: false,
    autoSync: false,
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;

  // /health includes version and keeps app/ok fields.
  const health = await (await fetch(`${base}/health?detail=1`)).json();
  assert.equal(health.app, 'loop-hub');
  assert.equal(health.ok, true);
  assert.ok(typeof health.version === 'string' && health.version.length > 0);

  // MCP initialize exposes real build/version instead of hardcoded 2.0.0.
  const setupRes = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password-1234' }),
  });
  const cookie = setupRes.headers.get('set-cookie').split(';')[0];
  const agentRes = await (await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Version Checker', kind: 'other', profile: 'all', canManage: true }),
  })).json();
  const initRes = await (await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${agentRes.token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } }),
  })).json();
  assert.equal(initRes.result.serverInfo.version, health.version);
  assert.notEqual(initRes.result.serverInfo.version, '2.0.0');

  // /release.json lists tarball + agent file hashes.
  const manifest = await (await fetch(`${base}/release.json`)).json();
  assert.equal(manifest.release, 'release/20261125-120000');
  assert.equal(manifest.tarball.sha256, rel1.sha256);
  assert.equal(manifest.tarball.url, `${base}/downloads/loop-latest.tar.gz`);
  assert.equal(manifest.tarball.versionedUrl, `${base}/downloads/${rel1.filename}`);
  assert.match(manifest.agentFiles.skill.sha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.agentFiles.hook.sha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.agentFiles.connect.sha256, /^[0-9a-f]{64}$/);

  // /downloads/loop-latest.tar.gz matches SHA-256 and blocks path traversal.
  const dlRes = await fetch(manifest.tarball.url);
  assert.equal(dlRes.status, 200);
  const dlBuf = Buffer.from(await dlRes.arrayBuffer());
  assert.equal(sha256Buffer(dlBuf), rel1.sha256);
  assert.equal((await fetch(`${base}/downloads/..%2Fsecret.tar.gz`)).status, 404);

  // /agent-files/* match manifest hashes.
  const skillRes = await fetch(manifest.agentFiles.skill.url);
  assert.equal(skillRes.status, 200);
  assert.equal(sha256Buffer(Buffer.from(await skillRes.arrayBuffer())), manifest.agentFiles.skill.sha256);
  const hookRes = await fetch(manifest.agentFiles.hook.url);
  assert.equal(hookRes.status, 200);
  assert.equal(sha256Buffer(Buffer.from(await hookRes.arrayBuffer())), manifest.agentFiles.hook.sha256);

  // /install.sh substitutes the server origin.
  const installScript = await (await fetch(`${base}/install.sh`)).text();
  assert.ok(installScript.includes(`DEFAULT_ORIGIN='${base}'`));

  // /connect.mjs bundle loads without syntax or duplicate identifier errors.
  const connectRes = await fetch(`${base}/connect.mjs`);
  assert.equal(connectRes.status, 200);
  const bundlePath = path.join(home, 'connect-bundle.mjs');
  await writeFile(bundlePath, await connectRes.text());
  execFileSync(process.execPath, ['--check', bundlePath]);
});

test('connect-agents --update and --check refresh hosted agent skill and hook with SHA-256 check and no sign-in', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'loop-agent-upd-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await mkdir(path.join(home, '.codex'), { recursive: true });
  await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark' }, null, 2));

  const srv = await startServer({
    port: 0,
    dataDir: path.join(home, 'data'),
    home,
    authMode: 'local-test',
    detectLocalAgents: false,
    autoSync: false,
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;

  const logs = [];
  const checkBefore = await runConnectCli(['--url', base, '--check'], { home, env: {}, log: (l) => logs.push(l) });
  assert.equal(checkBefore.updateAvailable, true);

  const updated = await runConnectCli(['--url', base, '--update'], { home, env: {}, log: (l) => logs.push(l) });
  assert.equal(updated.ok, true);
  assert.equal(updated.updated, true);

  // Verify standalone files were written and symlinked into Claude Code and Codex.
  const skillText = await readFile(path.join(home, '.loop', 'agent-files', 'skills', 'loop', 'SKILL.md'), 'utf8');
  assert.match(skillText, /loop__search/);
  const claudeLink = await lstat(path.join(home, '.claude', 'skills', 'loop'));
  assert.equal(claudeLink.isSymbolicLink(), true);
  const codexLink = await lstat(path.join(home, '.codex', 'skills', 'loop'));
  assert.equal(codexLink.isSymbolicLink(), true);

  // Verify SessionStart hook was added while preserving existing keys.
  const claudeSettings = JSON.parse(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claudeSettings.theme, 'dark');
  assert.ok(claudeSettings.hooks.SessionStart.some((g) => g.hooks.some((h) => h.command.includes('loop-hook.mjs'))));

  // Subsequent --check reports up to date.
  const checkAfter = await runConnectCli(['--url', base, '--check'], { home, env: {}, log: () => {} });
  assert.equal(checkAfter.updateAvailable, false);
});

test('loop CLI downloads, verifies SHA-256, updates, refuses corrupt checksums, and rolls back cleanly', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'loop-cli-upd-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const releasesDir = path.join(home, 'srv-releases');
  await mkdir(releasesDir, { recursive: true });
  await makeMockReleaseArchive(releasesDir, {
    releaseTag: 'release/20261125-120000',
    commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    notes: 'Initial release.',
  });

  const srv = await startServer({
    port: 0,
    dataDir: path.join(home, 'srv-data'),
    home: path.join(home, 'srv-home'),
    releasesDir,
    authMode: 'local-test',
    detectLocalAgents: false,
    autoSync: false,
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;

  const clientHome = path.join(home, 'client-home');
  const installRoot = path.join(clientHome, '.loop', 'app');
  const binDir = path.join(clientHome, '.local', 'bin');
  const deps = {
    home: clientHome,
    env: {},
    installRoot,
    binDir,
    log: () => {},
    skipNpmCi: true,
    skipRestart: true,
  };

  // First update installs release 1 and writes the `loop` shim.
  const first = await runLoopCli(['update', '--url', base, '--no-hooks'], deps);
  assert.equal(first.ok, true);
  assert.equal(first.updated, true);
  assert.equal(first.version, 'release/20261125-120000');
  const shim = await readFile(path.join(binDir, 'loop'), 'utf8');
  assert.match(shim, /loop-cli\.mjs/);

  // Re-running update when already on latest is a no-op.
  const noop = await runLoopCli(['update', '--url', base, '--no-hooks'], deps);
  assert.equal(noop.updated, false);

  // Publish release 2, then update and verify previous symlink + rollback.
  await makeMockReleaseArchive(releasesDir, {
    releaseTag: 'release/20261125-130000',
    commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    notes: 'Second release.',
  });

  const checked = await runLoopCli(['check', '--url', base], deps);
  assert.equal(checked.updateAvailable, true);
  assert.equal(checked.latest, 'release/20261125-130000');

  const second = await runLoopCli(['update', '--url', base, '--no-hooks'], deps);
  assert.equal(second.updated, true);
  assert.equal(second.version, 'release/20261125-130000');
  assert.equal(second.previous, 'release/20261125-120000');

  // Tamper with release.json sha256 -> update MUST refuse and keep release 2 active.
  const tampered = JSON.parse(await readFile(path.join(releasesDir, 'release.json'), 'utf8'));
  tampered.release = 'release/20261125-140000';
  tampered.tarball.sha256 = '0'.repeat(64);
  await writeFile(path.join(releasesDir, 'release.json'), JSON.stringify(tampered));
  await assert.rejects(() => runLoopCli(['update', '--url', base, '--no-hooks'], deps), /SHA-256 mismatch/);
  assert.equal(await realpath(path.join(installRoot, 'current')), await realpath(second.dir));

  // Rollback switches cleanly back to release 1.
  const rolled = await runLoopCli(['rollback', '--no-hooks'], deps);
  assert.equal(rolled.ok, true);
  assert.equal(rolled.rolledBack, true);
  assert.equal(rolled.version, 'release/20261125-120000');
  assert.equal(await realpath(path.join(installRoot, 'current')), await realpath(first.dir));
});
