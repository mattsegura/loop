import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readPub = (name) => readFile(path.join(root, 'public', name), 'utf8');

test('D1 & D11: connection-popup shows truthful hosted-mode notice without Try again or aria-modal', async () => {
  const src = await readPub('connection-popup.js');
  assert.match(src, /mcp\.readiness\?\.state === 'unsupported_workspace'/);
  assert.match(src, /Cannot run in hosted mode/);
  const blockStart = src.indexOf("mcp.readiness?.state === 'unsupported_workspace'");
  const blockEnd = src.indexOf('if (mcp.lastError && !mcp.authRequired', blockStart);
  assert.ok(blockStart > 0 && blockEnd > blockStart);
  const block = src.slice(blockStart, blockEnd);
  assert.doesNotMatch(block, /data-cp-sync|Try again/);
  assert.doesNotMatch(src, /role="dialog"\s+aria-modal="true"/);
});

test('D2 & D13: saved-view confirms saved-item deletion and labels schedule form fields', async () => {
  const src = await readPub('saved-view.js');
  const delStart = src.indexOf("querySelectorAll('[data-saved-del]')");
  const delBlock = src.slice(delStart, delStart + 900);
  assert.match(delBlock, /confirmDialog\(/);
  assert.match(src, /<label class="saved-sched-field"><span>Title<\/span>/);
  assert.match(src, /<label class="saved-sched-field"><span>Repeat<\/span>/);
  assert.match(src, /<label class="saved-sched-field"><span>When<\/span>/);
  assert.match(src, /<label class="saved-sched-field"><span>Action<\/span>/);
  assert.match(src, /Custom schedule \(5-field cron\)/);
});

test('D3, D4, D5: app.js keeps connections that cannot run here off Home, avoids closing open panels, and guards delete approvals', async () => {
  const src = await readPub('app.js');
  // The owner asked not to see "Cannot run here" on Home: no section, and no row in a category unless searched for.
  assert.doesNotMatch(src, /id:\s*'unavailable'/);
  assert.match(src, /const cannotRunHere = \(m\) => m\.readiness\?\.state === 'unsupported_workspace'/);
  assert.match(src, /\(q \|\| !cannotRunHere\(m\)\)/);
  assert.match(src, /function isPanelOpenOnPage\(/);
  assert.match(src, /APPROVAL_BANNER_CLICK_GUARD_MS/);
  assert.match(src, /function isDeleteApproval\(/);
  assert.match(src, /btn sm\$\{isDel \? '' : ' fill'\}/);
  assert.match(src, /btn sm\$\{isDeleteApproval\(item\) \? '' : ' fill'\}/);
});

test('D10 & D12: memory-view lists Skills and Tasks in Library rail and guards double-click delete', async () => {
  const src = await readPub('memory-view.js');
  // Skills moved from Home into Library, as its second part.
  assert.match(src, /\['skills',\s*'saved',\s*'files',\s*'schedules',\s*'tasks'\]/);
  assert.match(src, /dataset\.armedAt/);
  assert.match(src, /< 450/);
});

test('D11 & grammar: agent-popup omits aria-modal, preserves tab focus on click, and fixes broad-rights wording', async () => {
  const src = await readPub('agent-popup.js');
  assert.doesNotMatch(src, /role="dialog"\s+aria-modal="true"/);
  assert.match(src, /showTab\(p,\s*b\.dataset\.apTab,\s*true\)/);
  assert.doesNotMatch(src, /This agent can use \$\{broadRights/);
  assert.match(src, /This agent can \$\{broadRights\.join\(', '\)\}\./);
});

test('D5 & skill markdown CSS: approval banner floats fixed and ordered lists keep numbers', async () => {
  const css = await readPub('app.css');
  assert.match(css, /\.approval-banner\s*\{[\s\S]*?position:\s*fixed;/);
  assert.match(css, /\.skill-markdown ol\s*\{\s*list-style:\s*decimal;\s*\}/);
  assert.match(css, /\.skill-markdown ul\s*\{\s*list-style:\s*disc;\s*\}/);
});
