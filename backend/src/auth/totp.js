'use strict';
// Dependency-free TOTP (RFC 6238 / HOTP RFC 4226), HMAC-SHA1, 6 digits, 30s step.
const crypto = require('crypto');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  str = String(str).replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of str) {
    const idx = B32.indexOf(ch); if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function generateSecret(bytes = 20) { return base32Encode(crypto.randomBytes(bytes)); }

function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { buf[i] = c & 0xff; c = Math.floor(c / 256); }
  const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16)
             | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return (code % 1000000).toString().padStart(6, '0');
}
function totp(secretB32, { time = Date.now(), step = 30 } = {}) {
  return hotp(base32Decode(secretB32), Math.floor((time / 1000) / step));
}
function verifyTotp(secretB32, token, { time = Date.now(), step = 30, window = 1 } = {}) {
  token = String(token || '').trim();
  if (!/^\d{6}$/.test(token)) return false;
  const buf = base32Decode(secretB32);
  const counter = Math.floor((time / 1000) / step);
  for (let w = -window; w <= window; w++) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(buf, counter + w)), Buffer.from(token))) return true;
  }
  return false;
}
function otpauthUrl(secretB32, { issuer = 'HigherPays', account = 'user' } = {}) {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account);
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function normaliseRecoveryCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');
}
function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const value = crypto.randomBytes(10).toString('hex').toUpperCase();
    return `${value.slice(0, 10)}-${value.slice(10)}`;
  });
}

module.exports = {
  generateSecret, base32Encode, base32Decode, hotp, totp, verifyTotp, otpauthUrl,
  generateRecoveryCodes, hashRecoveryCode, normaliseRecoveryCode,
};
