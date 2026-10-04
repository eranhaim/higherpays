'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

// Password hashing with scrypt (built into Node — no native build step).
// Stored format: scrypt$N$r$p$saltHex$hashHex
const N = 16384, r = 8, p = 1, KEYLEN = 64;

function validatePasswordStrength(plain) {
  if (typeof plain !== 'string' || plain.length < 12) return 'password_too_short';
  if (!/[a-z]/.test(plain)) return 'password_lowercase_required';
  if (!/[A-Z]/.test(plain)) return 'password_uppercase_required';
  if (!/\d/.test(plain)) return 'password_number_required';
  return null;
}

async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(plain, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(plain, stored) {
  try {
    const [scheme, n, rr, pp, saltHex, hashHex] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = await scrypt(plain, salt, expected.length, {
      N: parseInt(n, 10), r: parseInt(rr, 10), p: parseInt(pp, 10),
    });
    // constant-time comparison
    return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword, validatePasswordStrength };
