'use strict';
const { log } = require('../lib/log');

// Email sender — STUB. Logs instead of sending so invites work end-to-end now.
// Swap the body for a real provider (Postmark/SES/Resend) at go-live; the rest
// of the code doesn't change.
async function sendEmail({ to, subject, body }) {
  log.warn({ to, subject, body }, 'email not sent: no provider configured');
  return { queued: true, to, subject };
}

module.exports = { sendEmail };
