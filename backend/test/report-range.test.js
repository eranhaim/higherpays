'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DAY_MS, reportRange } = require('../src/lib/reportRange');

test('without bounds the report covers the last 30 days', () => {
  const { from, to } = reportRange();
  assert.equal(Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS), 30);
});

test('given bounds are returned as ISO instants', () => {
  assert.deepEqual(reportRange({ from: '2026-10-01', to: '2026-10-31T23:59:59Z' }), {
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-31T23:59:59.000Z',
  });
});

test('a bound that is not a date is a 400, not a 500', () => {
  assert.throws(() => reportRange({ from: 'yesterday' }),
    (err) => err.status === 400 && err.toJSON().detail === 'from must be a date');
});
