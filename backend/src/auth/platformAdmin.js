'use strict';
const { query } = require('../db');

async function isPlatformAdmin(userId) {
  const row = (await query('SELECT is_platform_admin FROM users WHERE id = $1', [userId])).rows[0];
  return row?.is_platform_admin === true;
}

// During impersonation the request carries the subject's identity, so the
// operator's own rights must not apply to it.
async function isActingPlatformAdmin(user) {
  return !user.actorId && isPlatformAdmin(user.id);
}

module.exports = { isPlatformAdmin, isActingPlatformAdmin };
