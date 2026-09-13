'use strict';
// The checkout fee is HigherPays' own: the customer pays it on top of the
// price, and it must never reach the agency's gross or its splits.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount, getPlatformAdmin } = require('../helpers/tenant');
const { buildPaidPayload, postWebhook, endpointFor, newTransId } = require('../helpers/webhook');

test('the customer pays the price plus the checkout fee, and only the price is split', async () => {
  const t = await createTenant(app, { checkoutFee: 2 });
  const account = await createAccount(app, t);

  const link = (await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 100, currency: 'EUR' })
    .expect(201)).body;

  // The link is priced at 100 for the agency; the fee rides on top of it.
  assert.equal(link.amount, 100);
  const stored = (await pool.query('SELECT checkout_fee FROM payment_links WHERE id=$1', [link.id])).rows[0];
  assert.equal(Number(stored.checkout_fee), 2);

  // MantaPay reports what it actually charged the card.
  const transId = newTransId();
  const res = await postWebhook(app, await endpointFor(t.workspaceId),
    buildPaidPayload({ reference: link.referenceId, transId, amount: 102 })).expect(200);

  const payment = (await pool.query('SELECT amount FROM payments WHERE id=$1', [res.body.paymentId])).rows[0];
  assert.equal(Number(payment.amount), 100, 'the agency is credited the price, not the total');

  const tx = (await pool.query(
    'SELECT gross, surcharge FROM transactions WHERE provider_transaction_id=$1', [transId])).rows[0];
  assert.equal(Number(tx.gross), 100);
  assert.equal(Number(tx.surcharge), 2);

  const entry = (await pool.query(
    `SELECT re.gross, re.fee_mdr, re.fee_surcharge, re.distributable, re.account_amount
       FROM revenue_entries re JOIN transactions t ON t.id = re.transaction_id
      WHERE t.provider_transaction_id=$1 AND re.entry_type='sale'`, [transId])).rows[0];
  assert.equal(Number(entry.gross), 100, 'the split is computed on the price');
  assert.equal(Number(entry.fee_mdr), 8.16, 'MDR is 8% of the €102 customer charge');
  assert.equal(Number(entry.fee_surcharge), 2, 'the fee is recorded as ours');
});

test("the agency's fee report does not show the checkout fee", async () => {
  const t = await createTenant(app, { checkoutFee: 2 });
  const report = (await request(app).get(`/workspaces/${t.workspaceId}/fees`).set(t.authHeaders).expect(200)).body;
  assert.equal(report.platformFees.surcharge, undefined);
});

test('a provider webhook reporting the content amount does not subtract the checkout fee twice', async () => {
  const t = await createTenant(app, { checkoutFee: 2 });
  const account = await createAccount(app, t);
  const link = (await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 3, currency: 'EUR' })
    .expect(201)).body;

  const transId = newTransId();
  const res = await postWebhook(app, await endpointFor(t.workspaceId),
    buildPaidPayload({ reference: link.referenceId, transId, amount: 3 })).expect(200);

  const payment = (await pool.query(
    'SELECT amount FROM payments WHERE id=$1', [res.body.paymentId])).rows[0];
  assert.equal(Number(payment.amount), 3);

  const tx = (await pool.query(
    'SELECT gross, surcharge FROM transactions WHERE provider_transaction_id=$1', [transId])).rows[0];
  assert.equal(Number(tx.gross), 3);
  assert.equal(Number(tx.surcharge), 2);
});

test('additive checkout fees are rejected against the configured and actual link minimum', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const admin = await getPlatformAdmin(app);

  await request(app).patch(`/workspaces/${t.workspaceId}/link-limits`).set(t.authHeaders)
    .send({ minLinkAmount: 10, maxLinkAmount: null }).expect(200);
  const invalid = await request(app).put(`/platform/workspaces/${t.workspaceId}/platform-fee`)
    .set(admin.headers)
    .send({ feeModel: 'flat', pspRatePct: 8, marginRatePct: 5, pspFixedFee: 0, checkoutFee: 10 })
    .expect(400);
  assert.match(invalid.body.message, /less than the minimum permitted link amount/);

  await request(app).put(`/platform/workspaces/${t.workspaceId}/platform-fee`)
    .set(admin.headers)
    .send({ feeModel: 'flat', pspRatePct: 8, marginRatePct: 5, pspFixedFee: 0, checkoutFee: 5 })
    .expect(201);
  await request(app).patch(`/workspaces/${t.workspaceId}/link-limits`).set(t.authHeaders)
    .send({ minLinkAmount: 4, maxLinkAmount: null }).expect(200);
  const link = await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 4, currency: 'EUR' })
    .expect(400);
  assert.match(link.body.message, /checkout fee must be less than the link amount/);
});
