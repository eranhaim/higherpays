'use strict';
const { query } = require('../db');

// Revoke every refresh token a user holds. Their access tokens still expire on
// their own (15 minutes); every workspace route re-checks access on each
// request, so removal from a workspace is immediate regardless.
async function revokeUserSessions(userId) {
  await query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId]);
}

module.exports = { revokeUserSessions };
