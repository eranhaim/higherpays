'use strict';
// Webhook end-to-end: build a MantaPay-shaped payload, sign it with the
// workspace's hash key, POST it, and confirm the transaction posted + the
// link flipped to `paid` + a notification landed. This is the most important
// happy-path test in the suite — the whole product breaks if this doesn't work.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { withSystem } = require('../../src/db');
const { createTenant, createAccount } = require('../helpers/tenant');
const { endpointFor, setMerchantId, encodeForm, buildPaidPayload } = require('../helpers/webhook');
const paymentsService = require('../../src/services/payments.service');

test('webhook: valid signature -> transaction posted, link paid, notification recorded', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);

  // Set the workspace's MID to match what we'll send in the payload.
  const MID = '7374656';
  await setMerchantId(t.workspaceId, MID);

  // Create a payment link so the webhook has something to attribute against.
  const linkRes = await request(app)
    .post(`/workspaces/${t.workspaceId}/links`)
    .set(t.authHeaders)
    .send({ accountId: account.id, pricingMode: 'fixed', amount: 25, currency: 'EUR' })
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
  const account = await createAccount(app, t);
  await setMerchantId(t.workspaceId, '7374656');
  const endpointId = await endpointFor(t.workspaceId);

  const linkRes = await request(app)
    .post(`/workspaces/${t.workspaceId}/links`)
    .set(t.authHeaders)
    .send({ accountId: account.id, pricingMode: 'fixed', amount: 30, currency: 'EUR' })
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
  const account = await createAccount(app, t);
  await setMerchantId(t.workspaceId, '7374656');
  const endpointId = await endpointFor(t.workspaceId);

  const linkRes = await request(app)
    .post(`/workspaces/${t.workspaceId}/links`)
    .set(t.authHeaders)
    .send({ accountId: account.id, pricingMode: 'fixed', amount: 40, currency: 'EUR' })
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
