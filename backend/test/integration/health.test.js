'use strict';
// /health is the only alarm for a payment that exists at the provider and not
// in the ledger, so it must go red for that and for nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, tag } = require('../helpers/tenant');

async function insertStaleWebhook(workspaceId, eventType) {
  await pool.query(
    `INSERT INTO webhook_events
       (workspace_id, provider, event_type, provider_event_id, signature_valid, processed, payload, received_at)
     VALUES ($1, 'mantapay', $2, $3, true, false, '{}', now() - interval '2 hours')`,
    [workspaceId, eventType, `health-${tag()}`]);
}

async function staleCount() {
  return (await request(app).get('/health')).body.staleWebhooks;
}

test('a stale unprocessed decline does not turn health red, a stale approval does', async () => {
  const t = await createTenant(app);
  const before = await staleCount();
  try {
    await insertStaleWebhook(t.workspaceId, 'declined');
    assert.equal(await staleCount(), before);

    await insertStaleWebhook(t.workspaceId, 'approved');
    assert.equal(await staleCount(), before + 1);
    assert.equal((await request(app).get('/health')).status, 503);
  } finally {
    await pool.query("DELETE FROM webhook_events WHERE workspace_id = $1 AND provider_event_id LIKE 'health-%'", [t.workspaceId]);
  }
});
