'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { payUrl } = require('../src/lib/payUrl');

test('the public pay URL is a top-level /pay path, not under /api', () => {
  const url = new URL(payUrl('HP-ABCD-EFGH-JKMN'));
  assert.equal(url.pathname, '/pay/HP-ABCD-EFGH-JKMN');
});

test('the reference is URL-encoded', () => {
  assert.equal(new URL(payUrl('a b')).pathname, '/pay/a%20b');
});
