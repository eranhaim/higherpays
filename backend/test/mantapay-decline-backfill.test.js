'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:y@127.0.0.1:1/none';

const { readRawDecline, mergeDecline } = require('../scripts/backfill-mantapay-decline-reasons');

test('backfill keeps a real MantaPay code and display reason from raw payload', () => {
  const details = readRawDecline({
    reply_code: '100.051',
    reply_desc: 'Insufficient funds',
  });
  assert.deepEqual(details, {
    code: '100.051',
    reason: 'Insufficient funds',
    codeSource: 'stored_raw_payload',
    reasonSource: 'stored_raw_payload',
  });
});

test('backfill never turns pending or abandoned payloads into declines', () => {
  for (const replyCode of ['001', '553', '663', '600']) {
    assert.deepEqual(readRawDecline({
      reply_code: replyCode,
      reply_desc: 'Not a decline',
    }), {
      code: null,
      reason: null,
      codeSource: null,
      reasonSource: null,
    });
  }
});

test('backfill only fills unknown decline fields', () => {
  const details = mergeDecline({
    provider_decline_code: 'N7',
    provider_decline_reason: null,
    provider_decline_code_source: 'mantapay_webhook_signed',
    provider_decline_reason_source: null,
  }, {
    code: '100.051',
    reason: 'Insufficient funds',
    codeSource: 'mantapay_status',
    reasonSource: 'mantapay_status',
  });
  assert.deepEqual(details, {
    code: 'N7',
    reason: 'Insufficient funds',
    codeSource: 'mantapay_webhook_signed',
    reasonSource: 'mantapay_status',
  });
});
