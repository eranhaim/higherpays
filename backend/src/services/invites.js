'use strict';
// One invite implementation, used by the team invite route and by creating a
// creator: both mean "here is a seat, set your own password".

const crypto = require('crypto');
const config = require('../config');
const { sendEmail } = require('../util/email');

const EXPIRY_DAYS = 7;

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

/**
 * Writes the invite and emails the link. The token is a bearer credential for
 * a seat, so it is returned to the caller only to be emailed — never in an
 * API response.
 */
async function createInvite(client, { workspaceId, email, role, invitedByUserId, subject, intro }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 86400 * 1000);
  const row = (await client.query(
    `INSERT INTO invites (workspace_id, email, role, token_hash, invited_by_user_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, role, expires_at, accepted_at`,
    [workspaceId, email, role, hashToken(token), invitedByUserId, expiresAt])).rows[0];

  const link = `${config.appPublicBase}/accept-invite?token=${token}`;
  await sendEmail({
    to: email,
    subject: subject || `You're invited to HigherPays (${role})`,
    body: `${intro ? `${intro}\n\n` : ''}Set up your login: ${link}`,
  });
  return row;
}

module.exports = { createInvite, hashToken, EXPIRY_DAYS };
