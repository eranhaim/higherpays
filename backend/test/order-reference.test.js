'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateOrderReference } = require('../src/lib/orderReference');

test('HigherPays order references are short, readable, and collision-resistant', () => {
  const references = Array.from({ length: 1000 }, generateOrderReference);
  for (const reference of references) {
    assert.match(reference, /^HP-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
  }
  assert.equal(new Set(references).size, references.length);
});
