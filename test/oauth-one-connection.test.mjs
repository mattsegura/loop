import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { mountOAuthConsentPicker } from '../public/oauth-consent-view.js';

const mcps = [
  { id: 'work', name: 'Files', accountLabel: 'Work', profiles: ['work'], enabled: true, tools: [{ name: 'list_files', enabled: true }, { name: 'upload_file', enabled: true }, { name: 'archive', enabled: false }] },
  { id: 'home', name: 'Files', accountLabel: 'Personal', enabled: true, tools: [{ name: 'search' }] },
  { id: 'off', name: 'Archived', enabled: false },
];

async function openPicker(t, clientName, currentAgent) {
  const { document, Event } = parseHTML('<html><body><button id="oauth-allow"></button><button id="oauth-expand"></button><div id="oc-drawer"><div id="oc-picker"></div></div></body></html>');
  const previousDocument = globalThis.document;
  globalThis.document = document;
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  const picker = mountOAuthConsentPicker(document.body, {
    esc: String,
    api: async (route) => route === '/api/overview' ? { mcps, categories: [] } : { secrets: [{ key: 'PRIVATE_TOKEN' }] },
    renderConnLogo: () => '',
    groupConnectionsByCategory: () => [],
    clientName,
    currentAgent,
    offerOneConnection: true,
  });
  if (!currentAgent) assert.throws(() => picker.getApprovalPayload(), /load your connections/i);
  await new Promise((resolve) => setImmediate(resolve));
  function choose(id, value) {
    const select = document.getElementById(id);
    select.querySelector(`option[value="${value}"]`).selected = true;
    select.dispatchEvent(new Event('change'));
  }
  function allowTool(name) {
    const input = document.querySelector(`[data-oc-action][value="${name}"]`);
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { document, picker, choose, allowTool };
}

test('first Meta Muse sign-in requires explicit selection of enabled actions or the entire connection', async (t) => {
  const { document, picker, choose, allowTool } = await openPicker(t, 'Meta Muse');
  const button = document.getElementById('oauth-allow');
  assert.equal(button.disabled, true);
  assert.throws(() => picker.getApprovalPayload(), /choose a connection/i);
  assert.equal(document.querySelector('option[value="off"]'), null);
  assert.match(document.querySelector('option[value="work"]').textContent, /Files · Work/);
  choose('oc-one-connection', 'work');
  assert.equal(button.disabled, true);
  assert.throws(() => picker.getApprovalPayload(), /at least one action/i);
  assert.equal(document.querySelector('[data-oc-action][value="archive"]'), null);
  allowTool('list_files');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Share selected actions');
  const access = { allowedConnections: ['work'], allowedSkills: [], memoryAccess: 'none', canManage: false, secrets: [] };
  assert.deepEqual(picker.getApprovalPayload(), { profile: 'all', access: { ...access, toolGrants: { work: ['list_files'] } } });
  choose('oc-one-action', 'connection');
  assert.deepEqual(picker.getApprovalPayload(), { profile: 'all', access });
  choose('oc-one-connection', 'home');
  assert.equal(button.disabled, true);
  allowTool('search');
  assert.deepEqual(picker.getApprovalPayload(), { profile: 'all', access: { ...access, allowedConnections: ['home'], toolGrants: { home: ['search'] } } });
});

test('other new clients can explicitly choose one connection', async (t) => {
  const { document, picker, choose } = await openPicker(t, 'Custom runtime');
  assert.deepEqual(picker.getApprovalPayload().access.allowedConnections, mcps.map((c) => c.id));
  document.querySelector('[data-oc-pick-one]').click();
  choose('oc-one-connection', 'home');
  choose('oc-one-action', 'connection');
  assert.deepEqual(picker.getApprovalPayload().access, { allowedConnections: ['home'], allowedSkills: [], memoryAccess: 'none', canManage: false, secrets: [] });
});

test('a returning host can reconnect unchanged, edit the selected actions, or discard the edit', async (t) => {
  const { document, picker, allowTool } = await openPicker(t, 'Muse Code', { profile: 'work', toolGrants: { work: ['list_files'] }, allowedConnections: ['work'], allowedSkills: [], memoryAccess: 'none', canManage: false, secrets: [] });
  assert.equal(document.getElementById('oc-one-connection'), null);
  assert.match(document.getElementById('oc-picker').textContent, /list_files/);
  assert.doesNotMatch(document.getElementById('oc-picker').textContent, /upload_file/);
  assert.deepEqual(picker.getApprovalPayload(), { profile: 'work' });
  document.querySelector('[data-oc-edit-actions]').click();
  assert.equal(document.querySelector('#oc-one-connection').disabled, true);
  assert.equal(document.querySelector('#oc-one-action'), null);
  assert.ok(document.querySelector('[data-oc-action][value="list_files"]').hasAttribute('checked'));
  assert.deepEqual(picker.getApprovalPayload(), { profile: 'work' });
  allowTool('upload_file');
  assert.match(document.querySelector('#oc-picker').textContent, /signs out older sessions/);
  assert.deepEqual(picker.getApprovalPayload(), { profile: 'work', access: {
    allowedConnections: ['work'], allowedSkills: [], canManage: false, memoryAccess: 'none', secrets: [],
    toolGrants: { work: ['list_files', 'upload_file'] },
  } });
  document.querySelector('[data-oc-custom]').click();
  assert.deepEqual(picker.getApprovalPayload(), { profile: 'work' });
});
