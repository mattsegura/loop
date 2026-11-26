// A caller may take back its own fresh save with no approval. The rule must hold when Loop itself
// changes the record (page data of a link, run times of a schedule), and it must stop when anyone
// else changes the item.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OwnSaves, TAKE_BACK_MS } from '../lib/own-saves.mjs';

const link = (extra = {}) => ({
  id: 'sv_1', kind: 'link', url: 'https://example.com/a', title: 'A page', note: 'for later', tags: ['x'],
  fetchedTitle: '', displayTitle: 'A page', summary: '', markdown: '', author: '', image: '', domain: 'example.com',
  fetchStatus: 'pending', updatedAt: '2026-11-26T03:00:00.000Z', ...extra,
});

test('a saved link stays the caller\'s own after Loop reads the page', () => {
  const own = new OwnSaves();
  own.saved('agent:a', 'saved', link(), { created: true });
  const enriched = link({ fetchedTitle: 'A page | Example', summary: 'About the page.', markdown: '# A page', author: 'Ann', image: 'https://example.com/i.png', fetchStatus: 'ok', updatedAt: '2026-11-26T03:00:05.000Z' });
  assert.equal(own.canTakeBack('agent:a', 'saved', enriched), true);
  // A failed read is also a change by Loop.
  assert.equal(own.canTakeBack('agent:a', 'saved', link({ fetchStatus: 'failed', fetchError: 'HTTP 404' })), true);
  // A change by anyone else ends it.
  assert.equal(own.canTakeBack('agent:a', 'saved', { ...enriched, note: 'the owner wrote this' }), false);
  assert.equal(own.canTakeBack('agent:a', 'saved', { ...enriched, tags: ['x', 'keep'] }), false);
  // A different caller never owns it.
  assert.equal(own.canTakeBack('agent:b', 'saved', enriched), false);
  assert.equal(own.canTakeBack(null, 'saved', enriched), false);
});

test('the text of a note is its writer\'s, so a change of it ends the take-back', () => {
  const own = new OwnSaves();
  const note = { id: 'sv_2', kind: 'note', url: '', title: '', markdown: 'Buy milk', displayTitle: 'Buy milk', updatedAt: 't1' };
  own.saved('agent:a', 'saved', note, { created: true });
  assert.equal(own.canTakeBack('agent:a', 'saved', { ...note, updatedAt: 't2' }), true);
  assert.equal(own.canTakeBack('agent:a', 'saved', { ...note, markdown: 'Buy milk and the owner added eggs' }), false);
});

test('a schedule stays the caller\'s own after it runs, and not after its content changes', () => {
  const own = new OwnSaves();
  const sched = { id: 'sch_1', title: 'Standup', kind: 'daily', timeOfDay: '09:30', status: 'active', timezone: 'America/Chicago', nextRunAt: 'n1', nextRunLocal: 'l1', runCount: 0, updatedAt: 't1' };
  own.saved('agent:a', 'schedule', sched, { created: true });
  const afterRun = { ...sched, nextRunAt: 'n2', nextRunLocal: 'l2', lastRunAt: 'r1', lastStatus: 'ok', runCount: 1, updatedAt: 't2' };
  assert.equal(own.canTakeBack('agent:a', 'schedule', afterRun), true);
  assert.equal(own.canTakeBack('agent:a', 'schedule', { ...afterRun, timeOfDay: '10:00' }), false);
  assert.equal(own.canTakeBack('agent:a', 'schedule', { ...afterRun, status: 'paused' }), false);
});

test('the right ends after an hour, after a removal, and after a save over an item of someone else', () => {
  let now = 0;
  const own = new OwnSaves({ now: () => now });
  const file = { id: 'file_1', name: 'a.txt', sha256: 'abc', note: '', updatedAt: 't1' };
  own.saved('agent:a', 'file', file, { created: true });
  now = TAKE_BACK_MS;
  assert.equal(own.canTakeBack('agent:a', 'file', file), true);
  now = TAKE_BACK_MS + 1;
  assert.equal(own.canTakeBack('agent:a', 'file', file), false);

  now = 0;
  own.saved('agent:a', 'file', file, { created: true });
  own.removed('agent:a', 'file', 'file_1');
  assert.equal(own.canTakeBack('agent:a', 'file', file), false);

  // An update of an item that was not the caller's own does not make it so.
  const theirs = { id: 'file_2', name: 'b.txt', sha256: 'def', note: '', updatedAt: 't1' };
  own.saved('agent:a', 'file', { ...theirs, note: 'mine now?' }, { created: false, previous: theirs });
  assert.equal(own.canTakeBack('agent:a', 'file', { ...theirs, note: 'mine now?' }), false);
  // An update of its own fresh save keeps it.
  own.saved('agent:a', 'file', file, { created: true });
  own.saved('agent:a', 'file', { ...file, note: 'v2' }, { created: false, previous: file });
  assert.equal(own.canTakeBack('agent:a', 'file', { ...file, note: 'v2' }), true);
});

test('for a memory, a task and a skill the full record is compared, as before', () => {
  const own = new OwnSaves();
  const memory = { id: 'mem_1', content: 'likes tea', updatedAt: 't1' };
  own.saved('agent:a', 'memory', memory, { created: true });
  assert.equal(own.canTakeBack('agent:a', 'memory', memory), true);
  assert.equal(own.canTakeBack('agent:a', 'memory', { ...memory, updatedAt: 't2' }), false);
});
