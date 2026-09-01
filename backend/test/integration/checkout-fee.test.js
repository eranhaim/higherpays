'use strict';
// The checkout fee is HigherPays' own: the customer pays it on top of the
// price, and it must never reach the agency's gross or its splits.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount } = require('../helpers/tenant');
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
    `SELECT re.gross, re.fee_surcharge, re.distributable, re.account_amount
       FROM revenue_entries re JOIN transactions t ON t.id = re.transaction_id
      WHERE t.provider_transaction_id=$1 AND re.entry_type='sale'`, [transId])).rows[0];
  assert.equal(Number(entry.gross), 100, 'the split is computed on the price');
  assert.equal(Number(entry.fee_surcharge), 2, 'the fee is recorded as ours');
});

test("the agency's fee report does not show the checkout fee", async () => {
  const t = await createTenant(app, { checkoutFee: 2 });
  const report = (await request(app).get(`/workspaces/${t.workspaceId}/fees`).set(t.authHeaders).expect(200)).body;
  assert.equal(report.platformFees.surcharge, undefined);
});
