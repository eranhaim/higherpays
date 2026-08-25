'use strict';
// Webhook end-to-end: build a MantaPay-shaped payload, sign it with the
// workspace's hash key, POST it, and confirm the transaction posted + the
// link flipped to `paid` + a notification landed. This is the most important
// happy-path test in the suite — the whole product breaks if this doesn't work.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { withSystem } = require('../../src/db');
const { createTenant, createCreator } = require('../helpers/tenant');
const sig = require('../../src/providers/mantapay-signature');
const paymentsService = require('../../src/services/payments.service');

// `workspaces` is FORCE-RLS, so a bare pool query returns zero rows. Use the
// same trusted system context the webhook itself uses.
async function endpointFor(workspaceId) {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      "SELECT webhook_endpoint_id FROM workspaces WHERE id = $1", [workspaceId]);
    return rows[0].webhook_endpoint_id;
  });
}

async function setMerchantId(workspaceId, mid) {
  await withSystem((c) => c.query(
    'UPDATE workspaces SET mid = $2 WHERE id = $1', [workspaceId, mid]));
}

function encodeForm(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function buildPaidPayload({ reference, transId, amount, currency = 'EUR', merchantId }) {
  const fields = {
    trans_id: transId,
    trans_order: reference,
    reply_code: '000',
    reply_desc: 'Approved',
    trans_amount: String(amount),
    trans_currency: currency,
    merchant_id: merchantId,
    trans_date: '01/01/2026 12:00:00',
    client_email: 'buyer@test.local',
  };
  // Notifications sign a subset:
  //   trans_id + trans_order + reply_code + trans_amount + trans_currency + hashKey
  const hashKey = process.env.MANTAPAY_HASH_KEY;
  const base = fields.trans_id + fields.trans_order + fields.reply_code +
               fields.trans_amount + fields.trans_currency;
  fields.signature = sig.digest(base + hashKey);
  return fields;
}

test('webhook: valid signature -> transaction posted, link paid, notification recorded', async () => {
  const t = await createTenant(app);
  const creator = await createCreator(app, t);

  // Set the workspace's MID to match what we'll send in the payload.
  const MID = '7374656';
  await setMerchantId(t.workspaceId, MID);

  // Create a payment link so the webhook has something to attribute against.
  const linkRes = await request(app)
    .post(`/workspaces/${t.workspaceId}/links`)
    .set(t.authHeaders)
    .send({ creatorId: creator.id, pricingMode: 'fixed', amount: 25, currency: 'EUR' })
    .expect(201);

  const endpointId = await endpointFor(t.workspaceId);
  const payload = buildPaidPayload({
    reference: linkRes.body.reference_id,
    transId: `mp_${Date.now()}`,
    amount: 25,
    merchantId: MID,
  });

  const res = await request(app)
    .post(`/webhooks/payment/${endpointId}`)
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send(encodeForm(payload))
    .expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, 'approved');

  // Link flipped to paid.
  const linkAfter = await withSystem((c) => c.query(
    'SELECT status FROM payment_links WHERE id = $1', [linkRes.body.id]));
  assert.equal(linkAfter.rows[0].status, 'paid');

  // A commission_entries sale row exists for this transaction.
  const entry = await withSystem((c) => c.query(
    `SELECT ce.entry_type
     FROM commission_entries ce
     JOIN transactions tx ON tx.id = ce.transaction_id
     WHERE tx.provider_transaction_id = $1`, [payload.trans_id]));
  assert.equal(entry.rows[0].entry_type, 'sale');
});

test('webhook: bad signature is rejected with 401 (event is recorded for audit)', async () => {
  const t = await createTenant(app);
  await setMerchantId(t.workspaceId, '7374656');
  const endpointId = await endpointFor(t.workspaceId);

  const payload = buildPaidPayload({
    reference: 'ord_no_match',
    transId: `mp_bad_${Date.now()}`,
    amount: 25,
    merchantId: '7374656',
  });
  payload.signature = 'obviously-wrong-signature-value';

  await request(app)
    .post(`/webhooks/payment/${endpointId}`)
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send(encodeForm(payload))
    .expect(401);

  const rec = await withSystem((c) => c.query(
    'SELECT signature_valid FROM webhook_events WHERE provider_event_id = $1',
    [payload.trans_id]));
  assert.equal(rec.rows[0].signature_valid, false);
});

test('webhook: unknown endpoint id returns 404', async () => {
  await request(app)
    .post('/webhooks/payment/does-not-exist')
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send('trans_id=x')
    .expect(404);
});

test('webhook: duplicate provider_event_id is acknowledged, not re-processed', async () => {
  const t = await createTenant(app);
  const creator = await createCreator(app, t);
  await setMerchantId(t.workspaceId, '7374656');
  const endpointId = await endpointFor(t.workspaceId);

  const linkRes = await request(app)
    .post(`/workspaces/${t.workspaceId}/links`)
    .set(t.authHeaders)
    .send({ creatorId: creator.id, pricingMode: 'fixed', amount: 30, currency: 'EUR' })
    .expect(201);

  const payload = buildPaidPayload({
    reference: linkRes.body.reference_id,
    transId: `mp_dup_${Date.now()}`,
    amount: 30,
    merchantId: '7374656',
  });

  await request(app).post(`/webhooks/payment/${endpointId}`)
    .set('Content-Type', 'application/x-www-form-urlencoded').send(encodeForm(payload)).expect(200);

  const res = await request(app).post(`/webhooks/payment/${endpointId}`)
    .set('Content-Type', 'application/x-www-form-urlencoded').send(encodeForm(payload)).expect(200);
  assert.equal(res.body.duplicate, true);
});

test('webhook: a delivery that failed mid-processing is processed on the provider retry', async () => {
  const t = await createTenant(app);
  const creator = await createCreator(app, t);
  await setMerchantId(t.workspaceId, '7374656');
  const endpointId = await endpointFor(t.workspaceId);

  const linkRes = await request(app)
    .post(`/workspaces/${t.workspaceId}/links`)
    .set(t.authHeaders)
    .send({ creatorId: creator.id, pricingMode: 'fixed', amount: 40, currency: 'EUR' })
    .expect(201);
  const payload = buildPaidPayload({
    reference: linkRes.body.reference_id,
    transId: `mp_retry_${Date.now()}`,
    amount: 40,
    merchantId: '7374656',
  });

  // First delivery: the outcome handler blows up after the event row exists.
  const real = paymentsService.recordPaymentOutcome;
  paymentsService.recordPaymentOutcome = async () => { throw new Error('simulated db blip'); };
  try {
    await request(app).post(`/webhooks/payment/${endpointId}`)
      .set('Content-Type', 'application/x-www-form-urlencoded').send(encodeForm(payload)).expect(500);
  } finally {
    paymentsService.recordPaymentOutcome = real;
  }

  // Provider retry: must process, not be waved through as a duplicate.
  const retry = await request(app).post(`/webhooks/payment/${endpointId}`)
    .set('Content-Type', 'application/x-www-form-urlencoded').send(encodeForm(payload)).expect(200);
  assert.equal(retry.body.duplicate, undefined);
  assert.equal(retry.body.status, 'approved');

  const linkAfter = await withSystem((c) => c.query(
    'SELECT status FROM payment_links WHERE id = $1', [linkRes.body.id]));
  assert.equal(linkAfter.rows[0].status, 'paid');
  const event = await withSystem((c) => c.query(
    'SELECT processed FROM webhook_events WHERE provider_event_id = $1', [payload.trans_id]));
  assert.equal(event.rows[0].processed, true);
});
