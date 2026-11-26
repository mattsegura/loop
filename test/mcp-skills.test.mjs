import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import { startServer } from '../server.mjs';
import { SkillStore } from '../lib/skills.mjs';
import { MCP_SKILLS_EXTENSION } from '../lib/mcp-skills.mjs';

function sha256(text) {
  return `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`;
}

async function startSkillPartnerUpstream(secretValue) {
  const skillMd = `---\nname: triage-issues\ndescription: Triage GitHub issues.\n---\n# Issue Triage\nLabel bugs first. ${secretValue}\n`;
  const state = { tamperSkillMd: false };

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const send = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    };
    if (msg.method === 'initialize') {
      return send({
        protocolVersion: '2025-11-25',
        capabilities: { tools: {}, resources: {}, extensions: { [MCP_SKILLS_EXTENSION]: {} } },
        serverInfo: { name: 'partner-gh-upstream', version: '1.0.0' },
      });
    }
    if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
    if (msg.method === 'tools/list') {
      return send({ tools: [{ name: 'list_issues', description: 'List issues.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] });
    }
    if (msg.method === 'tools/call') return send({ content: [{ type: 'text', text: '[{"number":42}]' }] });
    if (msg.method === 'resources/list') return send({ resources: [] });
    if (msg.method === 'prompts/list') return send({ prompts: [] });
    if (msg.method === 'skills/list') {
      return send({
        skills: [{
          uri: 'skill://triage-issues/SKILL.md',
          frontmatter: { name: 'triage-issues', description: 'Triage GitHub issues.' },
          resources: [{ uri: 'skill://triage-issues/SKILL.md', size: Buffer.byteLength(skillMd, 'utf8'), digest: sha256(skillMd) }],
        }],
      });
    }
    if (msg.method === 'resources/read' && msg.params?.uri === 'skill://triage-issues/SKILL.md') {
      const text = state.tamperSkillMd ? `${skillMd}<!-- tampered -->` : skillMd;
      return send({ contents: [{ uri: msg.params.uri, mimeType: 'text/markdown', text }] });
    }
    return send({});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

describe('Skills over MCP (SEP-2640) security and end-to-end contract', () => {
  const secretValue = 'sk-partner-secret-88776655';
  let tmpDir, server, upstream, baseUrl, ownerCookie = '', fullToken = '', actionOnlyToken = '', restrictedSkillToken = '';

  async function api(route, opts = {}) {
    const res = await fetch(`${baseUrl}${route}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(ownerCookie ? { Cookie: ownerCookie } : {}), ...(opts.headers || {}) },
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
  }

  async function mcpRpc(method, params = {}, token = fullToken) {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return { status: res.status, json: await res.json() };
  }

  const meta2026 = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': { extensions: { [MCP_SKILLS_EXTENSION]: {} } },
    'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '2.1.0' },
  };

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'loop-mcp-skills-'));
    const srcSkillDir = path.join(tmpDir, '_seed-skill');
    await mkdir(path.join(srcSkillDir, 'scripts'), { recursive: true });
    await writeFile(path.join(srcSkillDir, 'SKILL.md'), '---\nname: deploy-checklist\ndescription: Deploy checks.\n---\n# Deploy\nRun tests first.\n', 'utf8');
    await writeFile(path.join(srcSkillDir, 'scripts', 'check.sh'), `#!/bin/sh\necho "${secretValue}"\n`, 'utf8');
    await new SkillStore(tmpDir).saveFromDir('deploy-checklist', srcSkillDir, { source: 'test' });
    await rm(srcSkillDir, { recursive: true, force: true });

    upstream = await startSkillPartnerUpstream(secretValue);
    server = await startServer({ port: 0, dataDir: tmpDir, authMode: 'local-test', detectLocalAgents: false });
    baseUrl = `http://127.0.0.1:${server.port}`;

    const setup = await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ password: 'skills-owner-password' }) });
    assert.equal(setup.status, 200);
    ownerCookie = (setup.headers.get('set-cookie') || '').split(';')[0];

    await api('/api/vault', { method: 'POST', body: JSON.stringify({ key: 'PARTNER_TEST_SECRET', value: secretValue, type: 'api_key' }) });
    await api('/api/mcps', { method: 'POST', body: JSON.stringify({ id: 'partner_gh', name: 'Partner GitHub', transport: 'http', url: upstream.url }) });
    await api('/api/mcps/partner_gh/sync', { method: 'POST', body: '{}' });

    fullToken = (await api('/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Claude Code', kind: 'claude-code', profile: 'all', canManage: true, memoryAccess: 'read_write' }),
    })).json.token;

    restrictedSkillToken = (await api('/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Deploy Only Bot', kind: 'other', profile: 'all', allowedConnections: null, allowedSkills: ['deploy-checklist'], canManage: false, memoryAccess: 'none' }),
    })).json.token;

    // Action-only Agent via OAuth consent with one tool grant: partner_gh:list_issues
    const redirectUri = 'http://127.0.0.1:53339/cb';
    const reg = await (await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Issue Lister', redirect_uris: [redirectUri], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    })).json();
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const authUrl = new URL(`${baseUrl}/oauth/authorize`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', reg.client_id);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('resource', `${baseUrl}/mcp`);
    const txId = new URL((await fetch(authUrl, { redirect: 'manual' })).headers.get('location'), baseUrl).searchParams.get('loop-oauth');
    const approved = await api(`/api/oauth/requests/${txId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ access: { allowedConnections: ['partner_gh'], toolGrants: { partner_gh: ['list_issues'] }, allowedSkills: [], memoryAccess: 'none', canManage: false, secrets: [] } }),
    });
    const code = new URL(approved.json.redirectUrl).searchParams.get('code');
    const tokRes = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: redirectUri, code_verifier: verifier }),
    });
    actionOnlyToken = (await tokRes.json()).access_token;
  });

  after(async () => {
    await server?.close?.();
    await upstream?.close?.();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads an authorized Skill in interactive 2026-07-28 Claude Code and blocks an action-only Agent by URI', async () => {
    const discover = await mcpRpc('server/discover', { _meta: meta2026 }, fullToken);
    assert.equal(discover.json.result.protocolVersion, '2026-07-28');
    assert.deepEqual(discover.json.result.capabilities.extensions[MCP_SKILLS_EXTENSION], {});

    const list = await mcpRpc('skills/list', { _meta: meta2026 }, fullToken);
    const entry = list.json.result.skills.find((s) => s.frontmatter?.name === 'deploy-checklist');
    assert.ok(entry);
    const mdFile = entry.resources.find((f) => f.uri === 'skill://deploy-checklist/SKILL.md');
    const scriptFile = entry.resources.find((f) => f.uri === 'skill://deploy-checklist/scripts/check.sh');

    const mdRead = await mcpRpc('resources/read', { uri: mdFile.uri, _meta: meta2026 }, fullToken);
    assert.equal(sha256(mdRead.json.result.contents[0].text), mdFile.digest);

    const scriptRead = await mcpRpc('resources/read', { uri: scriptFile.uri, _meta: meta2026 }, fullToken);
    const scriptText = scriptRead.json.result.contents[0].text;
    assert.doesNotMatch(scriptText, new RegExp(secretValue));
    assert.equal(sha256(scriptText), scriptFile.digest);

    // Traversal blocked
    assert.equal((await mcpRpc('resources/read', { uri: 'skill://deploy-checklist/%2e%2e/secret', _meta: meta2026 }, fullToken)).json.error?.code, -32602);

    // Action-only Agent cannot discover, list, get, or read the same Skill by URI
    const actionDiscover = await mcpRpc('server/discover', { _meta: meta2026 }, actionOnlyToken);
    assert.equal(actionDiscover.json.result.capabilities.extensions?.[MCP_SKILLS_EXTENSION], undefined);
    assert.deepEqual((await mcpRpc('skills/list', { _meta: meta2026 }, actionOnlyToken)).json.result.skills, []);
    assert.equal((await mcpRpc('skills/get', { uri: mdFile.uri, _meta: meta2026 }, actionOnlyToken)).json.error?.code, -32602);
    assert.equal((await mcpRpc('resources/read', { uri: mdFile.uri, _meta: meta2026 }, actionOnlyToken)).json.error?.code, -32602);
  });

  it('requires Owner opt-in for partner Skills, enforces grants across all read paths, and rejects tampered SHA-256 content', async () => {
    const partnerUri = 'skill://partner_gh__triage-issues/SKILL.md';

    // Hidden before Owner opt-in and Agents cannot enable it via loop__save
    assert.equal((await mcpRpc('resources/read', { uri: partnerUri, _meta: meta2026 }, fullToken)).json.error?.code, -32602);
    const agentAttempt = await mcpRpc('tools/call', { name: 'loop__save', arguments: { type: 'connection', action: 'update', id: 'partner_gh', partnerSkillsEnabled: true }, _meta: meta2026 }, fullToken);
    assert.equal(agentAttempt.json.result?.isError, true);

    // Owner enables partner Skills once
    const enable = await api('/api/mcps/partner_gh', { method: 'PATCH', body: JSON.stringify({ partnerSkillsEnabled: true }) });
    assert.equal(enable.status, 200);

    // Authorized Agent reads verified, secret-masked partner Skill; narrowed Agents stay blocked
    const read = await mcpRpc('resources/read', { uri: partnerUri, _meta: meta2026 }, fullToken);
    assert.match(read.json.result.contents[0].text, /Label bugs first/);
    assert.doesNotMatch(read.json.result.contents[0].text, new RegExp(secretValue));

    assert.equal((await mcpRpc('resources/read', { uri: partnerUri, _meta: meta2026 }, actionOnlyToken)).json.error?.code, -32602);
    assert.equal((await mcpRpc('resources/read', { uri: partnerUri, _meta: meta2026 }, restrictedSkillToken)).json.error?.code, -32602);

    // Tampered upstream content fails SHA-256 verification
    upstream.state.tamperSkillMd = true;
    try {
      assert.equal((await mcpRpc('resources/read', { uri: partnerUri, _meta: meta2026 }, fullToken)).json.error?.code, -32603);
    } finally {
      upstream.state.tamperSkillMd = false;
    }
  });
});
