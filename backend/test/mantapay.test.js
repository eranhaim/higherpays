'use strict';
// MantaPay provider unit tests — no database, no network.
//
// These pin behaviour that was established by testing against MantaPay's OWN
// tools (their Signature Generator and Signature Validator). If a change breaks
// one of these, payment links will be rejected in production with reply 500
// ("signature is invalid") — so treat a failure here as a blocker, not a nit.
//
//   npm test
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:y@127.0.0.1:1/none';

const sig = require('../src/providers/mantapay-signature');
const checkout = require('../src/providers/mantapay-checkout');
const status = require('../src/providers/mantapay-status');
const search = require('../src/providers/mantapay-search');
const provider = require('../src/providers/mantapay');

// ── Signature ────────────────────────────────────────────────────────────────

// Vector captured from MantaPay's own Signature Generator page.
test('hashing matches MantaPay Signature Generator output', () => {
  const s = '377109718015EURProduct-name0en-gbjohn+smithtest%40test.com'
          + '%2b972547880123067823012barkat+13HOLON5447778DIL999999';
  const b64 = sig.digest(s);
  assert.equal(b64, 'uaPyTpm63hyv0bdYfkfLspPXxr2lW6KOlfy4CExuRnQ=', 'base64 digest');
  assert.equal(require('crypto').createHash('sha256').update(s, 'utf8').digest('hex'),
    'b9a3f24e99bade1cafd1b7587e47cbb293d7c6bda55ba28e95fcb8084c6e4674', 'hex digest');
  assert.equal(encodeURIComponent(b64), 'uaPyTpm63hyv0bdYfkfLspPXxr2lW6KOlfy4CExuRnQ%3D', 'url-encoded form');
});

// Vector captured from MantaPay's live Signature Validator.
test('request signature matches MantaPay Signature Validator, byte for byte', () => {
  const order = ['merchantID', 'trans_type', 'trans_installments', 'trans_amount', 'trans_currency',
    'trans_refNum', 'disp_payFor', 'disp_lng', 'client_fullName', 'client_email', 'client_phoneNum',
    'notification_url', 'url_redirect', 'Brand', 'ExpiredOn'];
  const params = { merchantID: '3771097', trans_type: '0', trans_installments: '1',
    trans_amount: '20.00', trans_currency: 'EUR', trans_refNum: 'ord-test-001',
    disp_payFor: 'PPV bundle', disp_lng: 'en-US', client_fullName: 'John Smith',
    client_email: 'john@example.com', client_phoneNum: '+35799123456',
    notification_url: 'https://api.higherpays.com/webhooks/payment/abc',
    url_redirect: 'https://app.higherpays.com/thanks', Brand: '', ExpiredOn: '' };
  const r = sig.signHosted(params, '999999', { order });
  assert.equal(r.signedString,
    '37710970120.00EURord-test-001PPV+bundleen-USJohn+Smithjohn@example.com'
    + '+35799123456https://api.higherpays.com/webhooks/payment/abc'
    + 'https://app.higherpays.com/thanks999999', 'concatenation string (168 chars)');
  assert.equal(r.base64, '/o+QnAtvuyRHFRntTEtq879sWXq1oXl2P3I59ksTUkQ=', 'signature /o+QnAtvuy...');
});

test('hash input keeps + for spaces and does NOT escape anything else', () => {
  // Neither doc page states this; it came from the Validator's field-by-field output.
  assert.equal(sig.hashValue('PPV bundle'), 'PPV+bundle');
  assert.equal(sig.hashValue('john@example.com'), 'john@example.com');
  assert.equal(sig.hashValue('+35799123456'), '+35799123456');
  assert.equal(sig.hashValue('https://a.com/b?c=d'), 'https://a.com/b?c=d');
});

test('wire encoding is .NET style: space -> +, lowercase hex', () => {
  assert.equal(sig.urlEncodeDotNet('john smith'), 'john+smith');
  assert.equal(sig.urlEncodeDotNet('+972547880123'), '%2b972547880123');
  assert.equal(sig.urlEncodeDotNet('test@test.com'), 'test%40test.com');
});

test('signature refuses to build without a hash key', () => {
  assert.throws(() => sig.signHosted({ merchantID: '1' }, ''), /hash_key_missing/);
});

// ── Reply codes ──────────────────────────────────────────────────────────────

test('there are THREE pending codes, not one', () => {
  assert.equal(sig.mapReplyCode('553'), 'pending', '3DS/APM redirect');
  assert.equal(sig.mapReplyCode('663'), 'pending', 'awaiting final response');
  assert.equal(sig.mapReplyCode('001'), 'pending', 'awaiting customer (PIX/wire)');
});

test('reply codes are strings, never parsed as integers', () => {
  assert.equal(sig.mapReplyCode('000'), 'approved');
  assert.notEqual(sig.mapReplyCode('000'), sig.mapReplyCode('0'));
  assert.equal(sig.mapReplyCode('100.011'), 'declined', 'dotted code');
  assert.equal(sig.mapReplyCode('N7'), 'declined', 'alphanumeric code');
  assert.equal(sig.mapReplyCode('5C'), 'declined');
});

test('abandonment is distinguished from a bank decline', () => {
  assert.equal(sig.mapReplyCode('600'), 'abandoned', 'customer closed the window');
  assert.equal(sig.mapReplyCode('100.051'), 'declined', 'insufficient funds');
});

test('integration errors are separated from card declines', () => {
  assert.equal(sig.isConfigurationError('500'), true, 'invalid signature/merchant');
  assert.equal(sig.isConfigurationError('100.051'), false, 'insufficient funds is not our bug');
});

test('unknown codes fail safe as declined', () => {
  assert.equal(sig.mapReplyCode('004'), 'declined', 'undocumented code from their own sample');
  assert.equal(sig.mapReplyCode(''), 'unknown');
});

test('documented test amounts map to the documented outcomes', () => {
  for (const [amount, t] of Object.entries(sig.TEST_AMOUNTS)) {
    assert.equal(sig.mapReplyCode(t.code), t.expect, `amount ${amount}`);
  }
});

// ── Notification verification ────────────────────────────────────────────────

const KEY = 'AJG3CI3EX8';
const paidPayload = () => {
  const p = { reply_code: '000', reply_desc: 'SUCCESS', trans_id: '46942', trans_amount: '100',
    trans_currency: 'EUR', trans_order: 'ord-1', merchant_id: '3771097' };
  p.signature = sig.expectedNotificationSignature(p, KEY);
  return p;
};

test('a correctly signed notification verifies', () => {
  assert.equal(sig.verifyNotification(paidPayload(), KEY), true);
});

test('tampering with money-critical fields is rejected', () => {
  for (const field of ['trans_amount', 'trans_order', 'reply_code', 'trans_currency', 'trans_id']) {
    const p = paidPayload();
    p[field] = 'tampered';
    assert.equal(sig.verifyNotification(p, KEY), false, `${field} must be signed`);
  }
});

test('a missing signature or wrong key is rejected', () => {
  const p = paidPayload(); delete p.signature;
  assert.equal(sig.verifyNotification(p, KEY), false);
  assert.equal(sig.verifyNotification(paidPayload(), 'WRONGKEY'), false);
});

test('chargeback notifications use their own field set and capital Signature', () => {
  const cb = { trans_id: '32302', action: 'Chargback', reason: 'Card Not Valid',
    reasonCode: '4801', comment: 'final', originalID: '31519', OrderId: 'ord-1' };
  cb.Signature = sig.expectedNotificationSignature(cb, KEY);
  assert.equal(sig.isChargebackNotification(cb), true);
  assert.equal(sig.verifyNotification(cb, KEY), true);
  cb.originalID = '99999';
  assert.equal(sig.verifyNotification(cb, KEY), false);
});

// ── Checkout ─────────────────────────────────────────────────────────────────

const baseCheckout = {
  merchantId: '3771097', amount: 20, currency: 'EUR', reference: 'ord-1',
  description: 'PPV bundle', hashKey: KEY,
};

test('the emitted URL and its signature can never disagree', () => {
  const r = checkout.buildCheckout({ ...baseCheckout,
    customer: { fullName: 'John Smith', email: 'john@example.com', phone: '+35799123456' },
    notificationUrl: 'https://api.example.com/webhooks/payment/abc' });
  // recompute the signature from the wire exactly as MantaPay will
  const emitted = r.url.split('?')[1].split('&').map((p) => p.split('='));
  const values = emitted.filter(([k]) => k !== 'signature')
    .map(([, v]) => sig.hashValue(decodeURIComponent(String(v).replace(/\+/g, '%20'))));
  assert.equal(sig.digest(values.join('') + KEY), r.signature);
});

test('EC surcharge uses the documented parameter and format', () => {
  const r = checkout.buildCheckout({ ...baseCheckout, extraCostAmount: 2, extraCostName: 'Platform Fee' });
  assert.match(r.url, /[?&]EC=/, 'parameter is EC, not ExtraCostAmount');
  assert.equal(r.url.includes('ExtraCostAmount'), false);
});

test('EC is omitted entirely when not configured', () => {
  const r = checkout.buildCheckout(baseCheckout);
  assert.equal(r.url.includes('EC='), false);
});

test('EC is trimmed to the 50-character limit rather than silently mangled', () => {
  const v = checkout.buildExtraCost([{ amount: 2, name: 'Platform Fee',
    description: 'An extremely long description that will not fit within the limit at all' }]);
  assert.ok(v.length <= checkout.EC_MAX_LEN, `got ${v.length}`);
  assert.match(v, /^2\|Platform Fee\|/);
});

test('field values are truncated to MantaPay maximum lengths', () => {
  const r = checkout.buildCheckout({ ...baseCheckout,
    description: 'x'.repeat(100), customer: { fullName: 'y'.repeat(100) } });
  const get = (n) => r.formFields.find((f) => f.name === n).value;
  assert.equal(get('disp_payFor').length, 40);
  assert.equal(get('client_fullName').length, 50);
});

test('ExpiredOn is epoch SECONDS', () => {
  const at = Date.now() + 600000;
  const r = checkout.buildCheckout({ ...baseCheckout, expiresAt: at });
  const v = Number(r.formFields.find((f) => f.name === 'ExpiredOn').value);
  assert.ok(Math.abs(v - Math.floor(at / 1000)) <= 1, 'seconds, not milliseconds');
});

test('checkout refuses invalid input', () => {
  assert.throws(() => checkout.buildCheckout({ ...baseCheckout, amount: 0 }), /invalid_amount/);
  assert.throws(() => checkout.buildCheckout({ ...baseCheckout, hashKey: '' }), /hash_key_missing/);
});

// ── Status check ─────────────────────────────────────────────────────────────

test('an approval beats declines when one order has several attempts', () => {
  const attempts = [
    { transId: '1', status: 'declined', date: '2024-01-01T00:00:00.000Z' },
    { transId: '2', status: 'approved', date: '2024-01-02T00:00:00.000Z' },
    { transId: '3', status: 'declined', date: '2024-01-03T00:00:00.000Z' },
  ];
  const out = status.resolveOrderOutcome(attempts);
  assert.equal(out.status, 'approved');
  assert.equal(out.transaction.transId, '2');
  assert.equal(out.attempts, 3);
});

test('a pending attempt keeps the order open', () => {
  const out = status.resolveOrderOutcome([
    { transId: '1', status: 'declined', date: '2024-01-01T00:00:00.000Z' },
    { transId: '2', status: 'pending', date: '2024-01-02T00:00:00.000Z' },
  ]);
  assert.equal(out.status, 'pending');
});

test('status dates are DD/MM/YYYY, not American', () => {
  assert.equal(status.parseTransDate('28/01/2019 16:05:21'), '2019-01-28T16:05:21.000Z');
});

test('by-order signature follows CompanyNum + Order + key', () => {
  assert.equal(status.orderSignature('5722306', 'ord-1', '999999'),
    sig.digest('5722306' + 'ord-1' + '999999'));
});

// ── Search API ───────────────────────────────────────────────────────────────

test('.NET dates parse in both seconds and milliseconds', () => {
  assert.equal(search.parseDotNetDate('/Date(1702554387000+0000)/'), '2023-12-14T11:46:27.000Z');
  assert.equal(search.parseDotNetDate('/Date(1698771600+0200)/'), '2023-10-31T17:00:00.000Z');
});

test('per-transaction fees are extracted and summed', () => {
  const t = search.normaliseTransaction({
    ID: 28552, OrderId: '2005843394', Amount: 1.0, CurrencyIso: 'ILS',
    InsertDate: '/Date(1702554387000+0000)/',
    TransactionFees: { DebitFee: 1.07, TransactionFee: 0.5, HandlingFee: 0.1,
      RatioFee: 0, ChargebackFee: 0, DebitFeeChb: 0, ClarificationFee: 0 },
  });
  assert.equal(t.orderId, '2005843394', 'our reference comes back');
  assert.equal(Math.round(t.fees.total * 100) / 100, 1.67);
});

test('search body signature carries their literal prefix', () => {
  assert.match(search.bodySignature('{}', 'salt'), /^bytes-SHA256, /);
});

// ── Adapter contract ─────────────────────────────────────────────────────────

test('adapter exposes everything the routes call', () => {
  for (const fn of ['resolveApiKey', 'createCheckout', 'parseWebhook', 'verifyWebhookSignature',
    'getPaymentStatus', 'mapPaymentStatus', 'isAmbiguousStatus', 'refundPayment']) {
    assert.equal(typeof provider[fn], 'function', fn);
  }
  assert.equal(typeof provider.SIGNATURE_HEADER, 'string');
});

test('parseWebhook returns the exact field names the routes read', () => {
  const ev = provider.parseWebhook(
    'reply_code=000&trans_id=1&trans_amount=100&trans_currency=EUR&trans_order=ord-1');
  assert.equal(ev.gross, 100, 'routes read ev.gross');
  assert.ok(ev.fields, 'routes store ev.fields as webhook payload');
  assert.equal(ev.providerEventId, '1');
  assert.equal(ev.status, 'approved');
  assert.equal(ev.referenceId, 'ord-1');
});

test('MantaPay does not report fee or net in notifications', () => {
  const ev = provider.parseWebhook('reply_code=000&trans_id=1&trans_amount=100&trans_currency=EUR');
  assert.equal(ev.fee, null, 'unknown until the Search API is queried');
  assert.equal(ev.net, null);
});

test('webhook signature is verified from the body, not a header', () => {
  const p = paidPayload();
  const body = new URLSearchParams(p).toString();
  assert.equal(provider.verifyWebhookSignature(body, KEY), true);
  assert.equal(provider.verifyWebhookSignature(body.replace('trans_amount=100', 'trans_amount=999'), KEY), false);
});

test('refunds fail loudly rather than pretending to succeed', async () => {
  await assert.rejects(() => provider.refundPayment(), /refund_endpoint_not_configured/);
});
