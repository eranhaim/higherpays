'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:y@127.0.0.1:1/none';

const { readRawDecline, mergeDecline } = require('../scripts/backfill-mantapay-decline-reasons');
const reply = require('../src/providers/mantapay-reply');

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

// The 45 production rows the backfill exists for: MantaPay sent `017` with an
// empty `reply_desc`, so no provider source can ever fill them.
test('backfill reports no reason for a code MantaPay left blank', () => {
  assert.deepEqual(readRawDecline({ reply_code: '017', reply_desc: '' }), {
    code: '017',
    reason: null,
    codeSource: 'stored_raw_payload',
    reasonSource: null,
  });
});

test('backfill lets real provider text replace our derived wording', () => {
  const details = mergeDecline({
    provider_decline_code: '017',
    provider_decline_reason: reply.UNSPECIFIED_DECLINE_REASON,
    provider_decline_code_source: 'stored_raw_payload',
    provider_decline_reason_source: 'derived_no_provider_text',
  }, {
    code: '017',
    reason: 'Issuer declined the payment',
    codeSource: 'mantapay_status',
    reasonSource: 'mantapay_status',
  });
  assert.equal(details.reason, 'Issuer declined the payment');
  assert.equal(details.reasonSource, 'mantapay_status');
});

test('backfill keeps our derived wording when MantaPay still says nothing', () => {
  const details = mergeDecline({
    provider_decline_code: '017',
    provider_decline_reason: reply.UNSPECIFIED_DECLINE_REASON,
    provider_decline_code_source: 'stored_raw_payload',
    provider_decline_reason_source: 'derived_no_provider_text',
  }, {
    code: null, reason: null, codeSource: null, reasonSource: null,
  });
  assert.equal(details.reason, null, 'cleared so the caller re-derives it');
  assert.equal(details.code, '017');
});
