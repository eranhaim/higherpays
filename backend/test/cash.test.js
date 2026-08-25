'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cashPosition } = require('../src/services/cash');

test('no shortfall when receipts minus reserve cover what is owed', () => {
  const c = cashPosition({ owed: 700, received: 1000, held: 100 });
  assert.equal(c.available, 900);
  assert.equal(c.shortfallIfPaidNow, 0);
});

test('shortfall is the gap between what is owed and what is available', () => {
  const c = cashPosition({ owed: 700, received: 800, held: 200 });
  assert.equal(c.available, 600);
  assert.equal(c.shortfallIfPaidNow, 100);
});

test('rounds to cents and never reports a negative shortfall', () => {
  const c = cashPosition({ owed: 10.005, received: 10.004, held: 0 });
  assert.equal(c.owed, 10.01);
  assert.equal(c.received, 10);
  assert.equal(c.shortfallIfPaidNow, 0.01);
  assert.equal(cashPosition({ owed: 0, received: 0, held: 0 }).shortfallIfPaidNow, 0);
});
