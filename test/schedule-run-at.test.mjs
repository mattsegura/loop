// A one-time schedule must fire at the time that the user means. A time with no UTC offset is a clock
// time in the zone of the schedule, and a time that is already past is refused.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ScheduleStore, parseRunAt } from '../lib/schedules.mjs';
import { closeAllWorkspaceDbs } from '../lib/storage/workspace-db.mjs';

const NOW = Date.parse('2026-11-26T03:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

async function withStore(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-run-at-'));
  try {
    return await fn(new ScheduleStore(dir, { defaultTimezone: 'America/Chicago' }));
  } finally {
    closeAllWorkspaceDbs();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test('parseRunAt reads a time with no offset in the zone that it gets', () => {
  assert.equal(iso(parseRunAt('2026-12-01T09:00', 'America/Chicago')), '2026-12-01T15:00:00.000Z');
  assert.equal(iso(parseRunAt('2026-12-01 09:00', 'Asia/Tokyo')), '2026-12-01T00:00:00.000Z');
  assert.equal(iso(parseRunAt('2027-01-15T09:00:00', 'Asia/Tokyo')), '2027-01-15T00:00:00.000Z');
  assert.equal(iso(parseRunAt('2026-12-01', 'America/Chicago')), '2026-12-01T06:00:00.000Z');
  // An offset in the text is stronger than the zone.
  assert.equal(iso(parseRunAt('2026-12-01T09:00:00Z', 'Asia/Tokyo')), '2026-12-01T09:00:00.000Z');
  assert.equal(iso(parseRunAt('2026-12-01T09:00:00-06:00', 'Asia/Tokyo')), '2026-12-01T15:00:00.000Z');
  assert.ok(Number.isNaN(parseRunAt('2026-02-30T09:00', 'UTC')));
  assert.ok(Number.isNaN(parseRunAt('soon', 'UTC')));
});

test('a one-time schedule uses its own time zone, and the answer shows the local time', async () => {
  await withStore(async (store) => {
    const home = await store.save({ title: 'Dentist', kind: 'once', runAt: '2026-12-01T09:00', action: 'notify' }, { now: NOW });
    assert.equal(home.schedule.runAt, '2026-12-01T15:00:00.000Z');
    assert.equal(home.schedule.nextRunLocal, '2026-12-01 09:00 America/Chicago');

    const tokyo = await store.save(
      { title: 'Tokyo call', kind: 'once', runAt: '2027-01-15T09:00:00', timezone: 'Asia/Tokyo', action: 'notify' },
      { now: NOW },
    );
    assert.equal(tokyo.schedule.runAt, '2027-01-15T00:00:00.000Z');
    assert.equal(tokyo.schedule.nextRunLocal, '2027-01-15 09:00 Asia/Tokyo');

    const daily = await store.save({ title: 'Standup', kind: 'daily', timeOfDay: '09:30', action: 'notify' }, { now: NOW });
    assert.equal(daily.schedule.nextRunLocal, '2026-11-26 09:30 America/Chicago');
  });
});

test('a one-time schedule in the past is refused, with the local time in the message', async () => {
  await withStore(async (store) => {
    await assert.rejects(
      store.save({ title: 'Too late', kind: 'once', runAt: '2020-01-01T09:00:00Z', action: 'notify' }, { now: NOW }),
      (err) => {
        assert.equal(err.code, 'SCHEDULE_IN_PAST');
        assert.equal(err.status, 400);
        assert.match(err.message, /in the past: 2020-01-01 03:00 America\/Chicago/);
        assert.match(err.message, /delayMinutes/);
        return true;
      },
    );
    assert.equal((await store.list()).total, 0, 'nothing was saved');
    await assert.rejects(store.save({ title: 'Bad', kind: 'once', runAt: 'soon', action: 'notify' }, { now: NOW }), /valid date and time/);

    // "Now" is not the past.
    const soon = await store.save({ title: 'Right now', kind: 'once', runAt: iso(NOW - 1000), action: 'notify' }, { now: NOW });
    assert.equal(soon.created, true);
  });
});

test('a schedule that is past its time can still be changed, but not moved to a past time', async () => {
  await withStore(async (store) => {
    const { schedule } = await store.save({ title: 'Dentist', kind: 'once', runAt: '2026-12-01T09:00', action: 'notify' }, { now: NOW });
    const later = NOW + 30 * 86_400_000;
    const renamed = await store.save({ id: schedule.id, title: 'Dentist (done)' }, { now: later });
    assert.equal(renamed.schedule.title, 'Dentist (done)');
    assert.equal(renamed.schedule.runAt, schedule.runAt);
    // The dashboard sends each field again, with the same time.
    const resent = await store.save({ id: schedule.id, runAt: schedule.runAt, message: 'Bring the card' }, { now: later });
    assert.equal(resent.schedule.message, 'Bring the card');
    await assert.rejects(store.save({ id: schedule.id, runAt: '2026-12-02T09:00' }, { now: later }), /in the past/);
  });
});
