'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateRecoveryCodes, hashRecoveryCode, normaliseRecoveryCode,
} = require('../src/auth/totp');

test('recovery codes are unique, normalised, and stored as hashes', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.ok(codes.every((code) => /^[A-F0-9]{10}-[A-F0-9]{10}$/.test(code)));
  assert.equal(normaliseRecoveryCode(codes[0].toLowerCase()), codes[0].replace('-', ''));
  assert.equal(hashRecoveryCode(codes[0]), hashRecoveryCode(codes[0].toLowerCase().replace('-', '')));
  assert.notEqual(hashRecoveryCode(codes[0]), codes[0]);
});
