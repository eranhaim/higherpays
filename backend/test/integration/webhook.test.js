'use strict';
// Webhook end-to-end: a MantaPay-shaped payload, signed with the workspace's
// hash key, becomes a payment, a transaction, a ledger entry and a
// notification. The whole product breaks if this doesn't work.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount } = require('../helpers/tenant');
const { endpointFor, buildPaidPayload, postWebhook, newTransId, paySale } = require('../helpers/webhook');
const paymentsService = require('../../src/services/payments.service');
const signature = require('../../src/providers/mantapay-signature');

test('valid signature -> payment paid, transaction approved, link pending, ledger posted, notification recorded', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const { link, transId, paymentId } = await paySale(app, t, account, 25);

  const payment = (await pool.query('SELECT status, account_id, amount FROM payments WHERE id = $1', [paymentId])).rows[0];
  assert.equal(payment.status, 'paid');
  assert.equal(payment.account_id, account.id);
  assert.equal(Number(payment.amount), 25);

  const linkAfter = (await pool.query('SELECT status, paid_at FROM payment_links WHERE id = $1', [link.id])).rows[0];
  assert.equal(linkAfter.status, 'pending');
  assert.ok(linkAfter.paid_at);

  const entry = (await pool.query(
    `SELECT re.entry_type FROM revenue_entries re JOIN transactions tx ON tx.id = re.transaction_id
      WHERE tx.provider_transaction_id = $1`, [transId])).rows[0];
  assert.equal(entry.entry_type, 'sale');

  const feed = (await request(app).get(`/workspaces/${t.workspaceId}/notifications`).set(t.authHeaders).expect(200)).body;
  assert.ok(feed.notifications.some((n) => n.event === 'payment.paid' && n.entityId === paymentId));
});

test('a reusable link stays active after a payment and takes a second one', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const { link } = await paySale(app, t, account, 25, { type: 'reusable' });
  const after = (await pool.query('SELECT status FROM payment_links WHERE id = $1', [link.id])).rows[0];
  assert.equal(after.status, 'active');
  await postWebhook(app, await endpointFor(t.workspaceId),
    buildPaidPayload({ reference: link.referenceId, transId: newTransId(), amount: 25 })).expect(200);
  const count = (await pool.query('SELECT count(*)::int AS c FROM payments WHERE payment_link_id = $1', [link.id])).rows[0].c;
  assert.equal(count, 2);
});

test('bad signature is rejected with 401 and the event is recorded for audit', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const link = (await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 25, currency: 'EUR' }).expect(201)).body;
  const payload = buildPaidPayload({ reference: link.referenceId, transId: newTransId(), amount: 25 });
  payload.signature = 'deadbeef';
  await postWebhook(app, await endpointFor(t.workspaceId), payload).expect(401);
  const ev = (await pool.query('SELECT signature_valid, processed FROM webhook_events WHERE provider_event_id = $1', [payload.trans_id])).rows[0];
  assert.equal(ev.signature_valid, false);
  assert.equal(ev.processed, true);
  const paid = (await pool.query('SELECT count(*)::int AS c FROM payments WHERE payment_link_id = $1', [link.id])).rows[0].c;
  assert.equal(paid, 0);
});

test('unknown endpoint id returns 404', async () => {
  await postWebhook(app, 'does-not-exist', buildPaidPayload({ reference: 'x', transId: newTransId(), amount: 1 })).expect(404);
});

test('a duplicate delivery is acknowledged, not re-processed', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const link = (await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 25, currency: 'EUR' }).expect(201)).body;
  const payload = buildPaidPayload({ reference: link.referenceId, transId: newTransId(), amount: 25 });
  const endpoint = await endpointFor(t.workspaceId);
  await postWebhook(app, endpoint, payload).expect(200);
  const dup = await postWebhook(app, endpoint, payload).expect(200);
  assert.equal(dup.body.duplicate, true);
  const entries = (await pool.query(
    `SELECT count(*)::int AS c FROM revenue_entries re JOIN transactions tx ON tx.id = re.transaction_id WHERE tx.provider_transaction_id = $1`,
    [payload.trans_id])).rows[0].c;
  assert.equal(entries, 1);
});

test('a delivery that failed mid-processing is processed on the provider retry', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const link = (await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 25, currency: 'EUR' }).expect(201)).body;
  const payload = buildPaidPayload({ reference: link.referenceId, transId: newTransId(), amount: 25 });
  const endpoint = await endpointFor(t.workspaceId);

  const original = paymentsService.recordPaymentOutcome;
  paymentsService.recordPaymentOutcome = async () => { throw new Error('simulated crash'); };
  try {
    await postWebhook(app, endpoint, payload).expect(500);
  } finally {
    paymentsService.recordPaymentOutcome = original;
  }
  const before = (await pool.query('SELECT processed FROM webhook_events WHERE provider_event_id = $1', [payload.trans_id])).rows[0];
  assert.equal(before.processed, false);

  const retry = await postWebhook(app, endpoint, payload).expect(200);
  assert.equal(retry.body.duplicate, undefined);
  const after = (await pool.query('SELECT status FROM payments WHERE provider_payment_id = $1', [payload.trans_id])).rows[0];
  assert.equal(after.status, 'paid');
});

test('signed provider amount and currency mismatches stay visible and post no money', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const link = (await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 25, currency: 'EUR' }).expect(201)).body;
  const endpoint = await endpointFor(t.workspaceId);

  const wrongAmount = buildPaidPayload({ reference: link.referenceId, transId: newTransId(), amount: 26 });
  await postWebhook(app, endpoint, wrongAmount).expect(422);
  const amountEvent = (await pool.query(
    'SELECT processed, processing_error FROM webhook_events WHERE provider_event_id = $1',
    [wrongAmount.trans_id])).rows[0];
  assert.equal(amountEvent.processed, false);
  assert.equal(amountEvent.processing_error, 'provider_amount_mismatch');

  const wrongCurrency = buildPaidPayload({
    reference: link.referenceId, transId: newTransId(), amount: 25, currency: 'USD',
  });
  await postWebhook(app, endpoint, wrongCurrency).expect(422);
  const count = (await pool.query(
    'SELECT count(*)::int AS count FROM payments WHERE payment_link_id = $1',
    [link.id])).rows[0].count;
  assert.equal(count, 0);
});

test('MantaPay may sign either content amount or content plus checkout fee', async () => {
  const t = await createTenant(app, { checkoutFee: 2 });
  const account = await createAccount(app, t);
  const { paymentId } = await paySale(app, t, account, 25, { paidAmount: 27 });
  const payment = (await pool.query('SELECT amount FROM payments WHERE id = $1', [paymentId])).rows[0];
  assert.equal(Number(payment.amount), 25);
});

test('a pending attempt is preserved and can later become the approved sale', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const link = (await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 25, currency: 'EUR' }).expect(201)).body;
  const endpoint = await endpointFor(t.workspaceId);
  const transId = newTransId();

  await postWebhook(app, endpoint, buildPaidPayload({
    reference: link.referenceId, transId, amount: 25, replyCode: '663',
  })).expect(200);
  assert.equal((await pool.query(
    'SELECT status FROM payments WHERE provider_payment_id = $1', [transId])).rows[0].status, 'pending');
  assert.equal((await pool.query(
    'SELECT status FROM payment_links WHERE id = $1', [link.id])).rows[0].status, 'active');

  await postWebhook(app, endpoint, buildPaidPayload({
    reference: link.referenceId, transId, amount: 25, replyCode: '000',
  })).expect(200);
  assert.equal((await pool.query(
    'SELECT status FROM payments WHERE provider_payment_id = $1', [transId])).rows[0].status, 'paid');
  assert.equal((await pool.query(
    `SELECT count(*)::int AS count FROM revenue_entries re
      JOIN transactions tx ON tx.id = re.transaction_id
     WHERE tx.provider_transaction_id = $1 AND re.entry_type = 'sale'`, [transId])).rows[0].count, 1);
});

test('concurrent approvals of one single-use link post exactly one sale', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const link = (await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 25, currency: 'EUR' }).expect(201)).body;
  const endpoint = await endpointFor(t.workspaceId);
  const responses = await Promise.all([
    postWebhook(app, endpoint, buildPaidPayload({ reference: link.referenceId, transId: newTransId(), amount: 25 })),
    postWebhook(app, endpoint, buildPaidPayload({ reference: link.referenceId, transId: newTransId(), amount: 25 })),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 422]);
  assert.equal((await pool.query(
    `SELECT count(*)::int AS count FROM revenue_entries re
      JOIN transactions tx ON tx.id = re.transaction_id
      JOIN payments p ON p.id = tx.payment_id
     WHERE p.payment_link_id = $1 AND re.entry_type = 'sale'`, [link.id])).rows[0].count, 1);
});

test('a signed chargeback webhook uses the idempotent reversal path', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const sale = await paySale(app, t, account, 25);
  const fields = {
    trans_id: newTransId(),
    action: 'Chargback',
    reason: 'test',
    reasonCode: '1',
    comment: '',
    originalID: sale.transId,
    OrderId: sale.link.referenceId,
  };
  fields.Signature = signature.expectedNotificationSignature(fields, process.env.MANTAPAY_HASH_KEY, 'chargeback');
  const endpoint = await endpointFor(t.workspaceId);
  await postWebhook(app, endpoint, fields).expect(200);
  await postWebhook(app, endpoint, fields).expect(200);

  assert.equal((await pool.query('SELECT status FROM payments WHERE id = $1', [sale.paymentId])).rows[0].status, 'refunded');
  assert.equal((await pool.query(
    `SELECT count(*)::int AS count FROM revenue_entries re
      JOIN transactions tx ON tx.id = re.transaction_id
     WHERE tx.provider_transaction_id = $1 AND re.entry_type = 'chargeback'`,
    [sale.transId])).rows[0].count, 1);
});
