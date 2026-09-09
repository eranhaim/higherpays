'use strict';

async function recordLinkEvent(client, {
  workspaceId,
  linkId,
  eventType,
  source,
  paymentId = null,
  idempotencyKey = null,
}) {
  await client.query(
    `INSERT INTO payment_link_events
       (workspace_id, payment_link_id, payment_id, event_type, source, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (payment_link_id, event_type, idempotency_key)
       WHERE idempotency_key IS NOT NULL
     DO NOTHING`,
    [workspaceId, linkId, paymentId, eventType, source, idempotencyKey],
  );
}

module.exports = { recordLinkEvent };
