'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:y@127.0.0.1:1/none';
process.env.MARKETPLACE_INTEGRATION_API_KEY_HASH = '0'.repeat(64);
process.env.MARKETPLACE_WORKSPACE_ID = 'marketplace-workspace';
process.env.MARKETPLACE_ACCOUNT_ID = 'marketplace-account';
process.env.MARKETPLACE_AGENT_ID = 'marketplace-agent';
process.env.MARKETPLACE_WEBHOOK_URL = 'https://marketplace.example/events';
process.env.MARKETPLACE_WEBHOOK_SIGNING_SECRET = 'marketplace-event-secret';

const {
  enqueueLifecycleEventForReference,
  eventSignature,
} = require('../src/routes/marketplace.routes');

test('marketplace event signature covers timestamp, event id, and exact JSON body', () => {
  const timestamp = '2026-09-23T12:00:00.000Z';
  const eventId = '8a1b0ed9-0138-47ea-ab6b-5803c0c98435';
  const body = '{"amountMinor":1200,"currency":"EUR"}';
  const signature = eventSignature(timestamp, eventId, body);
  assert.match(signature, /^[a-f0-9]{64}$/);
  assert.notEqual(signature, eventSignature(timestamp, eventId, '{"amountMinor":1201,"currency":"EUR"}'));
  assert.notEqual(signature, eventSignature(timestamp, 'c77a708f-756a-4a3c-a3bc-7f3f98d20388', body));
});

test('marketplace lifecycle events enqueue through the caller transaction', async () => {
  const calls = [];
  const client = {
    query: async (text, values) => {
      calls.push({ text, values });
      if (text.includes('FROM marketplace_orders')) {
        return {
          rows: [{
            marketplace_order_id: 'tel-order-001',
            amount_minor: '1200',
            currency: 'EUR',
            reference_id: 'HP-TEST-ORDER',
            payment_id: 'payment-001',
          }],
        };
      }
      return { rows: [] };
    },
  };

  await enqueueLifecycleEventForReference(
    client,
    'HP-TEST-ORDER',
    'payment.approved',
    'provider-transaction-001',
  );

  assert.equal(calls.length, 2);
  assert.match(calls[0].text, /FOR UPDATE OF mo/);
  assert.match(calls[1].text, /INSERT INTO marketplace_event_outbox/);
  const [, type, payload] = calls[1].values;
  assert.equal(type, 'payment.approved');
  assert.equal(payload.marketplaceOrderId, 'tel-order-001');
  assert.equal(payload.amountMinor, 1200);
  assert.equal(payload.currency, 'EUR');
  assert.equal(payload.providerTransactionId, 'provider-transaction-001');
});
