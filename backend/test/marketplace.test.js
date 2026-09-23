'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:y@127.0.0.1:1/none';
process.env.MARKETPLACE_WEBHOOK_SIGNING_SECRET = 'marketplace-event-secret';

const { eventSignature } = require('../src/routes/marketplace.routes');

test('marketplace event signature covers timestamp, event id, and exact JSON body', () => {
  const timestamp = '2026-09-23T12:00:00.000Z';
  const eventId = '8a1b0ed9-0138-47ea-ab6b-5803c0c98435';
  const body = '{"amountMinor":1200,"currency":"EUR"}';
  const signature = eventSignature(timestamp, eventId, body);
  assert.match(signature, /^[a-f0-9]{64}$/);
  assert.notEqual(signature, eventSignature(timestamp, eventId, '{"amountMinor":1201,"currency":"EUR"}'));
  assert.notEqual(signature, eventSignature(timestamp, 'c77a708f-756a-4a3c-a3bc-7f3f98d20388', body));
});
