// The built-in calculator, date tool and data tool say "exact" in their descriptions. An agent uses
// them so that it does not calculate by itself, so a wrong result or a silent default goes to the user.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callUtilsTool, evaluateMathExpression } from '../lib/builtin-utils.mjs';

const NOW = Date.parse('2026-11-26T03:00:00Z');
const run = (tool, args, tz = 'America/Chicago') => callUtilsTool(tool, args, { defaultTimezone: tz, now: NOW });
const calc = async (expression, precision) => {
  const { expression: _e, ...rest } = await run('calc', { expression, ...(precision === undefined ? {} : { precision }) });
  return rest;
};
const refuses = (promise, pattern) => assert.rejects(promise, (err) => {
  assert.equal(err.code, 'INVALID_INPUT', err.message);
  assert.equal(err.status, 400);
  assert.match(err.message, pattern);
  return true;
});

test('calc keeps every digit of an integer and of a decimal', async () => {
  assert.deepEqual(await calc('9007199254740993 + 1'), { result: 9007199254740994, exact: true });
  assert.deepEqual(await calc('0.1 + 0.2'), { result: 0.3, exact: true });
  assert.deepEqual(await calc('(1250 * 1.08) / 12'), { result: 112.5, exact: true });
  assert.deepEqual(await calc('5.5 % 2'), { result: 1.5, exact: true });

  // A result that a JSON number cannot hold comes back as text, and the answer says why.
  const big = await calc('2^200');
  assert.equal(big.result, '1606938044258990275541962092341162602522202993782792835301376');
  assert.equal(big.exact, true);
  assert.match(big.note, /text/);
  assert.equal((await calc('99999999999999999999 * 99999999999999999999')).result, '9999999999999999999800000000000000000001');
});

test('calc rounds a half away from zero', async () => {
  assert.deepEqual(await calc('round(2.675, 2)'), { result: 2.68, exact: true });
  assert.deepEqual(await calc('round(-2.675, 2)'), { result: -2.68, exact: true });
  assert.deepEqual(await calc('round(2.5)'), { result: 3, exact: true });
  assert.deepEqual(await calc('round(1.005, 2)'), { result: 1.01, exact: true });
  assert.deepEqual(await calc('floor(-1.5)'), { result: -2, exact: true });
  assert.deepEqual(await calc('ceil(-1.5)'), { result: -1, exact: true });
});

test('calc says when a result is not exact', async () => {
  assert.deepEqual(await calc('1/3'), { result: 0.333333333333, exact: false, fraction: '1/3' });
  assert.deepEqual(await calc('(1250 * 1.0825) / 12', 2), { result: 112.76, exact: false });
  assert.deepEqual(await calc('sqrt(16)'), { result: 4, exact: true });
  assert.equal((await calc('sqrt(2)')).exact, false);
  assert.equal((await calc('pi * 2')).exact, false);
  assert.deepEqual(await calc('2.50 * 4', 2), { result: 10, exact: true });
});

test('calc uses the sign rule of mathematics', async () => {
  assert.equal((await calc('-2 ^ 2')).result, -4);
  assert.equal((await calc('(-2) ^ 2')).result, 4);
  assert.equal((await calc('2 ^ -2')).result, 0.25);
  assert.equal((await calc('2 ^ 3 ^ 2')).result, 512);
  assert.equal((await calc('-10 % 3')).result, -1);
});

test('calc refuses bad input as INVALID_INPUT and never runs code', async () => {
  await refuses(run('calc', { expression: '1/0' }), /Division by zero/);
  await refuses(run('calc', { expression: '0 ^ -1' }), /Division by zero/);
  await refuses(run('calc', { expression: 'process.exit(1)' }), /Unsupported|Unknown/);
  await refuses(run('calc', { expression: 'pow(2)' }), /two arguments/);
  await refuses(run('calc', { expression: '2 +' }), /Unexpected end/);
  await refuses(run('calc', { expression: '9^9^9' }), /not a finite number/);
  assert.equal(evaluateMathExpression('round(sqrt(2), 4)'), 1.4142);
  assert.equal(evaluateMathExpression('sum(10, 20, 30) / avg(2, 4)'), 20);
});

test('date_math stops at the last day of the month', async () => {
  const fromStamp = await run('date_math', { operation: 'add', date: '2026-01-31T12:00:00Z', amount: 1, unit: 'months' });
  assert.equal(fromStamp.result.date, '2026-02-28');
  assert.equal(fromStamp.result.time24, '06:00');
  assert.match(fromStamp.note, /last day/);

  const fromDate = await run('date_math', { operation: 'add', date: '2026-01-31', amount: 1, unit: 'months' });
  assert.equal(fromDate.result.date, '2026-02-28');
  assert.equal(fromDate.result.time24, '00:00');

  assert.equal((await run('date_math', { operation: 'add', date: '2024-02-29', amount: 1, unit: 'years' })).result.date, '2025-02-28');
  assert.equal((await run('date_math', { operation: 'add', date: '2026-03-31', amount: -1, unit: 'months' })).result.date, '2026-02-28');
  const plain = await run('date_math', { operation: 'add', date: '2026-01-15', amount: 1, unit: 'months' });
  assert.equal(plain.result.date, '2026-02-15');
  assert.equal(plain.note, undefined);
});

test('date_math reads a date with no time as a calendar date in the time zone', async () => {
  const added = await run('date_math', { operation: 'add', date: '2026-11-25', amount: 10, unit: 'days' });
  assert.equal(added.result.date, '2026-12-05');
  assert.equal(added.result.time24, '00:00');
  // The base and the result are in the same zone.
  assert.equal(added.baseLocal, '2026-11-25 00:00 America/Chicago');

  const tokyo = await run('date_math', { operation: 'add', date: '2027-01-15T09:00:00', amount: 0, unit: 'days', timezone: 'Asia/Tokyo' });
  assert.equal(tokyo.base, '2027-01-15T00:00:00.000Z');
  assert.equal(tokyo.result.time24, '09:00');
});

test('date_math keeps the clock time across a clock change', async () => {
  const fall = await run('date_math', { operation: 'add', date: '2026-11-01', amount: 1, unit: 'days' });
  assert.equal(fall.result.date, '2026-11-02');
  assert.equal(fall.result.time24, '00:00');
  const spring = await run('date_math', { operation: 'add', date: '2026-03-07T18:00:00Z', amount: 1, unit: 'days' });
  assert.equal(spring.result.date, '2026-03-08');
  assert.equal(spring.result.time24, '12:00');
  // Hours are elapsed time.
  const hours = await run('date_math', { operation: 'add', date: '2026-03-07T18:00:00Z', amount: 24, unit: 'hours' });
  assert.equal(hours.result.time24, '13:00');
  await refuses(run('date_math', { operation: 'add', date: '2026-01-31', amount: 1.5, unit: 'months' }), /whole number/);
});

test('date_math diff counts whole days between two dates, and needs both dates', async () => {
  const week = await run('date_math', { operation: 'diff', date: '2026-11-23', endDate: '2026-11-30' });
  assert.equal(week.days, 7);
  assert.equal(week.calendarDays, 7);
  assert.equal(week.businessDays, 5);
  // 31 days, also with the clock change of March between the two dates.
  const march = await run('date_math', { operation: 'diff', date: '2026-03-01', endDate: '2026-04-01' });
  assert.equal(march.days, 31);
  assert.equal(march.businessDays, 22);
  assert.equal((await run('date_math', { operation: 'diff', date: '2026-11-30', endDate: '2026-11-23' })).days, -7);
  await refuses(run('date_math', { operation: 'diff', date: '2026-11-25' }), /endDate is required/);
  await refuses(run('date_math', { operation: 'add', date: '2026-02-30', amount: 1, unit: 'days' }), /Invalid date/);
  await refuses(run('date_math', { operation: 'frobnicate' }), /add, diff or convert/);
});

test('date_math convert reads an input with no offset in the zone of the workspace', async () => {
  const naive = await run('date_math', { operation: 'convert', date: '2027-01-15T09:00:00', timezone: 'Asia/Tokyo' });
  assert.equal(naive.isoUtc, '2027-01-15T15:00:00.000Z');
  assert.equal(naive.date, '2027-01-16');
  assert.match(naive.note, /America\/Chicago/);
  const stamped = await run('date_math', { operation: 'convert', date: '2027-01-15T09:00:00Z', timezone: 'Asia/Tokyo' });
  assert.equal(stamped.time24, '18:00');
  assert.equal(stamped.note, undefined);
});

test('an unknown time zone is refused, not replaced', async () => {
  await refuses(run('time_now', { timezone: 'Mars/Olympus' }), /Unknown time zone "Mars\/Olympus"/);
  await refuses(run('time_now', { convertTo: ['UTC', 'Nope/Zone'] }), /Unknown time zone "Nope\/Zone"/);
  await refuses(run('date_math', { operation: 'convert', date: '2026-01-31', timezone: 'Mars/Olympus' }), /IANA/);
  const ok = await run('time_now', { timezone: 'Asia/Tokyo', convertTo: ['UTC'] });
  assert.equal(ok.timezone, 'Asia/Tokyo');
  assert.equal(ok.time24, '12:00');
  assert.equal(ok.conversions[0].timezone, 'UTC');
  assert.equal((await run('time_now', {})).timezone, 'America/Chicago');
});

test('query_data refuses data that it cannot read and a field that does not exist', async () => {
  await refuses(run('query_data', { data: '[{"a":1},' }), /not valid JSON/);
  await refuses(run('query_data', { data: '{"a":1}' }), /array of objects/);
  await refuses(run('query_data', { data: [1, 2, 3] }), /Item 0 is not an object/);
  await refuses(run('query_data', { data: '   ' }), /data is empty/);
  await refuses(run('query_data', { data: 42 }), /JSON array of objects or CSV text/);

  const rows = [{ plan: 'pro', n: 1 }, { plan: 'team', n: 2 }];
  await refuses(run('query_data', { data: rows, groupBy: 'plna' }), /Unknown field "plna" in groupBy\. Fields: "plan", "n"\./);
  await refuses(run('query_data', { data: rows, aggregate: { op: 'sum', field: 'nn' } }), /Unknown field "nn"/);
  await refuses(run('query_data', { data: rows, aggregate: { op: 'sum' } }), /needs a field name/);
  await refuses(run('query_data', { data: rows, filter: [{ field: 'x', op: 'eq', value: 1 }] }), /Unknown field "x" in filter\[0\]/);
  await refuses(run('query_data', { data: rows, sortBy: 'zzz' }), /Unknown field "zzz" in sortBy/);
  await refuses(run('query_data', { data: [{ n: 'x' }, { n: 'y' }], aggregate: { op: 'sum', field: 'n' } }), /has no numbers/);
});

test('query_data gives exact sums and says which values it did not count', async () => {
  assert.equal((await run('query_data', { data: [{ a: 0.1 }, { a: 0.2 }], aggregate: { op: 'sum', field: 'a' } })).aggregate, 0.3);

  const csv = await run('query_data', {
    format: 'csv',
    data: 'plan,seats,mrr\npro,2,24\npro,5,60\nteam,10,240',
    filter: [{ field: 'plan', op: 'eq', value: 'pro' }],
    aggregate: { op: 'sum', field: 'mrr' },
  });
  assert.equal(csv.totalRows, 2);
  assert.equal(csv.aggregate, 84);

  const mixed = await run('query_data', { data: [{ n: 1 }, { n: '' }, { n: null }, { n: '2.5' }], aggregate: { op: 'avg', field: 'n' } });
  assert.equal(mixed.aggregate, 1.75);
  assert.match(mixed.note, /2 values are not a number in "n"/);

  const grouped = await run('query_data', { data: [{ g: 'a', n: 3 }, { g: 'a', n: 1 }, { g: 'b', n: 5 }], groupBy: 'g', aggregate: { op: 'min', field: 'n' } });
  assert.deepEqual(grouped.groups, [{ group: 'a', count: 2, value: 1 }, { group: 'b', count: 1, value: 5 }]);
  assert.equal((await run('query_data', { data: [{ a: 1 }, { a: 22 }, { a: 3 }], aggregate: { op: 'max', field: 'a' } })).aggregate, 22);
  assert.equal((await run('query_data', { data: [{ a: 1 }, { a: 2 }], aggregate: { op: 'count' } })).aggregate, 2);
});
