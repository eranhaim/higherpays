'use strict';
const crypto = require('crypto');

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateOrderReference() {
  let value = '';
  while (value.length < 12) {
    for (const byte of crypto.randomBytes(12)) {
      if (byte < 240) value += ALPHABET[byte % ALPHABET.length];
      if (value.length === 12) break;
    }
  }
  return `HP-${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}`;
}

module.exports = { generateOrderReference };
