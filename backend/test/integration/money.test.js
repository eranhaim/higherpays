'use strict';
// The commission split: parts must sum to the whole, and a configuration that
// would pay out more than 100% is refused before it can reach the ledger.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { withSystem } = require('../../src/db');
const { createTenant, createCreator } = require('../helpers/tenant');
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
    .send({ creatorSplitPct: 70, chatterPct: 10 }).expect(201);
  const creator = await createCreator(app, t, { revenueSplitPct: 33 });

  // 10.01 makes every cut land on a fraction of a cent.
  const { transId } = await paySale(app, t, creator, 10.01);
  const e = await saleEntry(transId);
  const n = (v) => Number(v);

  for (const col of ['distributable', 'creator_amount', 'chatter_amount', 'agency_amount']) {
    assert.equal(Math.round(n(e[col]) * 100) / 100, n(e[col]), `${col} is whole cents`);
  }
  assert.equal(
    Math.round((n(e.creator_amount) + n(e.chatter_amount) + n(e.agency_amount)) * 100) / 100,
    n(e.distributable));
});

test('a rev-share split that cannot fit next to the chatter commission is refused', async () => {
  const t = await createTenant(app);
  await request(app).put(`/workspaces/${t.workspaceId}/commissions`).set(t.authHeaders)
    .send({ creatorSplitPct: 70, chatterPct: 25 }).expect(201);

  const res = await request(app).post(`/workspaces/${t.workspaceId}/creators`).set(t.authHeaders)
    .send({ stageName: 'Greedy', revenueModel: 'revshare', revenueSplitPct: 80 }).expect(400);
  assert.equal(res.body.error, 'validation_failed');

  // The other direction too: raising the chatter rate past what creators leave room for.
  await createCreator(app, t, { revenueSplitPct: 75 });
  await request(app).put(`/workspaces/${t.workspaceId}/commissions`).set(t.authHeaders)
    .send({ creatorSplitPct: 70, chatterPct: 26 }).expect(400);
});

test('a declined outcome arriving after an approved one does not un-approve the sale', async () => {
  const t = await createTenant(app);
  const creator = await createCreator(app, t);
  const { link, transId } = await paySale(app, t, creator, 25);

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
