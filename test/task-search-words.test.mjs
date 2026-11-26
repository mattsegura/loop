// An agent that takes work from a different agent must find the task with the words that it has, in
// any sequence. An empty result must not look like "there are no tasks".

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TaskStore } from '../lib/tasks.mjs';

async function withTasks(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-task-words-'));
  try {
    const store = new TaskStore(dir);
    const add = (title, objective = '') => store.save({ title, objective, nextStep: 'Start', expectedRevision: 0 }, { writtenBy: 'Test' });
    await add('loop-eval: count days for the release note', 'Count the days between two dates');
    await add('Migrate billing to Stripe', 'Move invoices and subscriptions');
    await add('Write the Q4 investor update', 'Draft the letter and send it');
    const titles = async (query) => {
      const res = await store.list({ query });
      return { titles: res.tasks.map((t) => t.title), partial: res.partial === true, total: res.total };
    };
    return await fn({ store, titles });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test('task search finds each word, in any sequence', async () => {
  await withTasks(async ({ titles }) => {
    const note = ['loop-eval: count days for the release note'];
    assert.deepEqual((await titles('release note')).titles, note);
    assert.deepEqual((await titles('release note days')).titles, note);
    assert.deepEqual((await titles('days release')).titles, note);
    assert.deepEqual((await titles('stripe billing')).titles, ['Migrate billing to Stripe']);
    // A common word in the query does not hide the task.
    assert.deepEqual((await titles('migrate the billing')).titles, ['Migrate billing to Stripe']);
    // Another form of the same word.
    assert.deepEqual(await titles('billing migration'), { titles: ['Migrate billing to Stripe'], partial: false, total: 1 });
    assert.deepEqual((await titles('q4 update')).titles, ['Write the Q4 investor update']);
  });
});

test('when no task has all the words, the nearest tasks come back and the result says so', async () => {
  await withTasks(async ({ titles }) => {
    const near = await titles('q4 billing plan');
    assert.equal(near.partial, true);
    assert.deepEqual(near.titles.sort(), ['Migrate billing to Stripe', 'Write the Q4 investor update']);
    assert.deepEqual(await titles('kubernetes'), { titles: [], partial: false, total: 0 });
    assert.equal((await titles('')).total, 3);
  });
});

test('a task is found by its id', async () => {
  await withTasks(async ({ store }) => {
    const { tasks } = await store.list();
    const found = await store.list({ query: tasks[0].id });
    assert.deepEqual(found.tasks.map((t) => t.id), [tasks[0].id]);
  });
});
