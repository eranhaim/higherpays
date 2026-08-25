'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

// Short-lived access token (stateless JWT). `sid` is the refresh-token family
// the token was issued from, so a request can tell which session it is on.
function signAccessToken(user, sessionId) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.full_name, sid: sessionId },
    config.jwtSecret,
    { expiresIn: config.accessTokenTtl }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, config.jwtSecret); // throws if invalid/expired
}

// Refresh token: an opaque random string given to the client; only its SHA-256
// hash is stored in the DB, so a DB leak can't be used to mint sessions.
function generateRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}
function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
};
