'use strict';
// The commission split: parts must sum to the whole, and a configuration that
// would pay out more than 100% is refused before it can reach the ledger.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { withSystem } = require('../../src/db');
const { createTenant, createAccount } = require('../helpers/tenant');
const { paySale } = require('../helpers/webhook');
const paymentsService = require('../../src/services/payments.service');

async function saleEntry(transId) {
  return withSystem(async (c) => (await c.query(
    `SELECT ce.* FROM commission_entries ce JOIN transactions t ON t.id = ce.transaction_id
      WHERE t.provider_transaction_id = $1 AND ce.entry_type = 'sale'`, [transId])).rows[0]);
}

test('a posted sale is split to cents and the parts sum to the distributable amount', async () => {
  const t = await createTenant(app);
  await request(app).put(`/workspaces/${t.workspaceId}/commissions`).set(t.authHeaders)
    .send({ accountSplitPct: 70, agentPct: 10 }).expect(201);
  const account = await createAccount(app, t, { revenueSplitPct: 33 });

  // 10.01 makes every cut land on a fraction of a cent.
  const { transId } = await paySale(app, t, account, 10.01);
  const e = await saleEntry(transId);
  const n = (v) => Number(v);

  for (const col of ['distributable', 'account_amount', 'agent_amount', 'agency_amount']) {
    assert.equal(Math.round(n(e[col]) * 100) / 100, n(e[col]), `${col} is whole cents`);
  }
  assert.equal(
    Math.round((n(e.account_amount) + n(e.agent_amount) + n(e.agency_amount)) * 100) / 100,
    n(e.distributable));
});

test('a rev-share split that cannot fit next to the agent commission is refused', async () => {
  const t = await createTenant(app);
  await request(app).put(`/workspaces/${t.workspaceId}/commissions`).set(t.authHeaders)
    .send({ accountSplitPct: 70, agentPct: 25 }).expect(201);

  const res = await request(app).post(`/workspaces/${t.workspaceId}/accounts`).set(t.authHeaders)
    .send({ stageName: 'Greedy', revenueModel: 'revshare', revenueSplitPct: 80 }).expect(400);
  assert.equal(res.body.error, 'validation_failed');

  // The other direction too: raising the agent rate past what accounts leave room for.
  await createAccount(app, t, { revenueSplitPct: 75 });
  await request(app).put(`/workspaces/${t.workspaceId}/commissions`).set(t.authHeaders)
    .send({ accountSplitPct: 70, agentPct: 26 }).expect(400);
});

test('a recorded refund reverses the sale and the reversal cannot be posted twice', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t, { revenueSplitPct: 70 });
  const { transId } = await paySale(app, t, account, 50);
  const txId = (await withSystem((c) => c.query(
    'SELECT id FROM transactions WHERE provider_transaction_id = $1', [transId]))).rows[0].id;

  const refund = await request(app).post(`/workspaces/${t.workspaceId}/transactions/${txId}/refund`)
    .set(t.authHeaders).send({ external: true }).expect(200);
  assert.equal(refund.body.refunded, 50);
  assert.ok(refund.body.accountAdjustment < 0, 'the account gives back its share');

  const net = await withSystem((c) => c.query(
    `SELECT SUM(account_amount) c, SUM(agent_amount) ch, SUM(gross) g FROM commission_entries WHERE transaction_id = $1`, [txId]));
  assert.equal(Number(net.rows[0].g), 0, 'gross nets to zero after the reversal');
  assert.equal(Number(net.rows[0].ch), 0);

  const again = await request(app).post(`/workspaces/${t.workspaceId}/transactions/${txId}/refund`)
    .set(t.authHeaders).send({ external: true }).expect(409);
  assert.equal(again.body.error, 'already_reversed');

  const tx = await withSystem((c) => c.query('SELECT status FROM transactions WHERE id = $1', [txId]));
  assert.equal(tx.rows[0].status, 'refunded');
});

test('a chargeback cannot be posted on top of a refund', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const { transId } = await paySale(app, t, account, 20);
  const txId = (await withSystem((c) => c.query(
    'SELECT id FROM transactions WHERE provider_transaction_id = $1', [transId]))).rows[0].id;

  await request(app).post(`/workspaces/${t.workspaceId}/transactions/${txId}/refund`)
    .set(t.authHeaders).send({ external: true }).expect(200);
  const cb = await request(app).post(`/workspaces/${t.workspaceId}/transactions/${txId}/chargeback`)
    .set(t.authHeaders).expect(409);
  assert.equal(cb.body.error, 'already_charged_back');
});

test('a declined outcome arriving after an approved one does not un-approve the sale', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const { link, transId } = await paySale(app, t, account, 25);

  await withSystem((c) => paymentsService.recordPaymentOutcome(c, t.workspaceId, {
    providerTransactionId: transId, status: 'declined', gross: 25, currency: 'EUR',
    linkReference: link.reference_id, rawPayload: {},
  }));

  const tx = await withSystem((c) => c.query(
    'SELECT status FROM transactions WHERE provider_transaction_id = $1', [transId]));
  assert.equal(tx.rows[0].status, 'approved');
  const linkAfter = await withSystem((c) => c.query('SELECT status FROM payment_links WHERE id = $1', [link.id]));
  assert.equal(linkAfter.rows[0].status, 'paid');
});
