'use strict';
const { log } = require('../lib/log');

// Email sender — STUB. Logs instead of sending so invites work end-to-end now.
// Swap the body for a real provider (Postmark/SES/Resend) at go-live; the rest
// of the code doesn't change.
//
// `outbox` exists so tests can read an invite token the way the recipient would,
// instead of the API returning the token to its caller — that would let anyone
// with team.manage provision a seat at an address they don't control. Delete it
// together with the stub.
const outbox = [];

async function sendEmail({ to, subject, body }) {
  outbox.push({ to, subject, body, at: new Date() });
  log.warn({ to, subject, body }, 'email not sent: no provider configured');
  return { queued: true, to, subject };
}

/** Most recent message sent to an address, or undefined. Test helper. */
function lastEmailTo(to) {
  return [...outbox].reverse().find((m) => m.to === to);
}

module.exports = { sendEmail, outbox, lastEmailTo };
