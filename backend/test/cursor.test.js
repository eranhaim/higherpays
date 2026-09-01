'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseLimit, encodeCursor, decodeCursor, page } = require('../src/lib/cursor');

test('parseLimit falls back and caps', () => {
  assert.equal(parseLimit(undefined), 50);
  assert.equal(parseLimit('0'), 50);
  assert.equal(parseLimit('abc'), 50);
  assert.equal(parseLimit('10'), 10);
  assert.equal(parseLimit('9999'), 200);
});

test('a cursor round-trips a timestamp, an amount and a status', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const ts = new Date('2026-08-31T20:13:00.000Z');
  assert.deepEqual(decodeCursor(encodeCursor(ts, id)), { value: ts.toISOString(), id });
  assert.deepEqual(decodeCursor(encodeCursor('120.00', id)), { value: '120.00', id });
  assert.deepEqual(decodeCursor(encodeCursor('paid', id)), { value: 'paid', id });
});

test('a malformed cursor is no cursor', () => {
  assert.equal(decodeCursor(undefined), null);
  assert.equal(decodeCursor(''), null);
  assert.equal(decodeCursor(Buffer.from('no-separator').toString('base64url')), null);
  assert.equal(decodeCursor(Buffer.from('|no-value').toString('base64url')), null);
  assert.equal(decodeCursor(Buffer.from('no-id|').toString('base64url')), null);
});

// A sort value could contain the separator; the id never does.
test('the id survives a value containing the separator', () => {
  const id = 'abc-def';
  assert.deepEqual(decodeCursor(encodeCursor('a|b', id)), { value: 'a|b', id });
});

test('page trims the extra row and points the cursor at the last kept one', () => {
  const rows = [{ id: 'a', at: 3 }, { id: 'b', at: 2 }, { id: 'c', at: 1 }];
  const result = page(rows, 2, (r) => r.at, (r) => r.id);
  assert.deepEqual(result.items.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(decodeCursor(result.nextCursor), { value: '2', id: 'b' });
});

test('a full page with nothing beyond it has no next cursor', () => {
  const rows = [{ id: 'a', at: 3 }, { id: 'b', at: 2 }];
  assert.equal(page(rows, 2, (r) => r.at, (r) => r.id).nextCursor, null);
  assert.equal(page([], 2, (r) => r.at, (r) => r.id).nextCursor, null);
});
