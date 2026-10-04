'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { groupRows } = require('../scripts/dedupe-payment-notifications');

const workspaceId = '11111111-1111-1111-1111-111111111111';
const paymentId = '22222222-2222-2222-2222-222222222222';

function notification(id, event, createdAt, eventKey = null) {
  return {
    id,
    workspace_id: workspaceId,
    event,
    entity_id: paymentId,
    created_at: createdAt,
    event_key: eventKey,
    read_workspace_mismatch: false,
  };
}

test('payment notification cleanup keeps the earliest row and separates outcomes', () => {
  const { repairGroups, skippedGroups } = groupRows([
    notification('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'payment.paid', '2026-10-04T12:01:00Z'),
    notification('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'payment.paid', '2026-10-04T12:00:00Z'),
    notification('cccccccc-cccc-cccc-cccc-cccccccccccc', 'payment.failed', '2026-10-04T12:02:00Z'),
  ]);

  assert.equal(skippedGroups.length, 0);
  assert.equal(repairGroups.length, 2);
  assert.deepEqual(repairGroups[0], {
    workspaceId,
    event: 'payment.paid',
    paymentId,
    canonicalId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    canonicalCreatedAt: '2026-10-04T12:00:00Z',
    eventKey: `payment.paid:${paymentId}`,
    notificationIds: [
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    ],
    duplicateIds: ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'],
  });
  assert.equal(repairGroups[1].event, 'payment.failed');
});

test('payment notification cleanup skips ambiguous event keys', () => {
  const { repairGroups, skippedGroups } = groupRows([
    notification('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'payment.paid', '2026-10-04T12:00:00Z'),
    notification('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'payment.paid', '2026-10-04T12:01:00Z', 'wrong-key'),
  ]);

  assert.equal(repairGroups.length, 0);
  assert.deepEqual(skippedGroups[0].reason, 'unexpected_event_key');
});
