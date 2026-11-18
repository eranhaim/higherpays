'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount } = require('../helpers/tenant');
const { paySale } = require('../helpers/webhook');

async function setReserveTerms(workspaceId, { pct, releaseDays }) {
  await pool.query(
    `INSERT INTO settlement_fee_config (workspace_id, reserve_pct, reserve_release_days)
     VALUES ($1, $2, $3)`, [workspaceId, pct, releaseDays]);
}

const getProviderReserve = async (t) => (await request(app)
  .get(`/workspaces/${t.workspaceId}/payments/provider-reserve`).set(t.authHeaders).expect(200)).body;

const getBreakdown = async (t) => (await request(app)
  .get(`/workspaces/${t.workspaceId}/payouts/breakdown`).set(t.authHeaders).expect(200)).body;

test('a 0-day release period holds the provider reserve on every past sale until a release is recorded', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  await paySale(app, t, account, 100);
  const old = await paySale(app, t, account, 50);
  await pool.query(
    "UPDATE transactions SET occurred_at = now() - interval '200 days' WHERE payment_id = $1", [old.paymentId]);
  await setReserveTerms(t.workspaceId, { pct: 10, releaseDays: 0 });

  const reserve = await getProviderReserve(t);
  assert.equal(reserve.source, 'estimated');
  assert.equal(reserve.pct, 10);
  assert.equal(reserve.held, 15);
  assert.equal(reserve.releasingSoon, 0);
  assert.equal((await getBreakdown(t)).reserve.held, 15);

  await pool.query(
    `INSERT INTO reserve_releases (workspace_id, amount, currency, released_by_user_id)
     VALUES ($1, 6, 'EUR', $2)`, [t.workspaceId, t.userId]);
  const afterRelease = await getProviderReserve(t);
  assert.equal(afterRelease.held, 9);
  assert.equal(afterRelease.released, 6);
});

test('a scheduled release period stops holding a sale once its release date passes', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  await paySale(app, t, account, 100);
  const old = await paySale(app, t, account, 50);
  await pool.query(
    "UPDATE transactions SET occurred_at = now() - interval '40 days' WHERE payment_id = $1", [old.paymentId]);
  await setReserveTerms(t.workspaceId, { pct: 10, releaseDays: 30 });

  const reserve = await getProviderReserve(t);
  assert.equal(reserve.held, 10);
  assert.equal(reserve.releasingSoon, 10);
});

test('a refunded sale leaves the provider reserve', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const sale = await paySale(app, t, account, 100);
  await setReserveTerms(t.workspaceId, { pct: 10, releaseDays: 0 });
  assert.equal((await getProviderReserve(t)).held, 10);

  await request(app).post(`/workspaces/${t.workspaceId}/payments/${sale.paymentId}/refund`)
    .set(t.authHeaders).expect(200);
  assert.equal((await getProviderReserve(t)).held, 0);
});

test('the agency rolling reserve holds each sale, releases oldest first, and a refund reverses only what is held', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  await request(app).patch(`/workspaces/${t.workspaceId}`).set(t.authHeaders)
    .send({ rollingReserveEnabled: true, rollingReservePct: 10 }).expect(200);
  const sale = await paySale(app, t, account, 100);

  const ledger = async () => (await request(app)
    .get(`/workspaces/${t.workspaceId}/payments/rolling-reserve`).set(t.authHeaders).expect(200)).body;
  const held = await ledger();
  assert.equal(held.enabled, true);
  assert.equal(held.reserved, 10);
  assert.equal(held.currentHeld, 10);

  const summary = (await request(app)
    .get(`/workspaces/${t.workspaceId}/payments/summary`).set(t.authHeaders).expect(200)).body;
  const afterFees = (await pool.query(
    `SELECT SUM(re.distributable) AS d FROM revenue_entries re
       JOIN transactions tx ON tx.id = re.transaction_id WHERE tx.payment_id = $1`, [sale.paymentId])).rows[0].d;
  assert.equal(summary.netRevenue, Math.round((Number(afterFees) - 10) * 100) / 100);

  const release = (await request(app)
    .post(`/workspaces/${t.workspaceId}/payments/rolling-reserve/release`).set(t.authHeaders)
    .send({ currency: 'EUR', amount: 4 }).expect(200)).body;
  assert.equal(release.amount, 4);
  assert.equal((await ledger()).currentHeld, 6);

  await request(app).post(`/workspaces/${t.workspaceId}/payments/${sale.paymentId}/refund`)
    .set(t.authHeaders).expect(200);
  const reversed = await ledger();
  assert.equal(reversed.reversed, 6);
  assert.equal(reversed.currentHeld, 0);

  await request(app)
    .post(`/workspaces/${t.workspaceId}/payments/rolling-reserve/release`).set(t.authHeaders)
    .send({ currency: 'EUR' }).expect(409);
});

test('agency revenue and profit cards leave out the reserve on their own sales; fees keep the full gross', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  await paySale(app, t, account, 100);
  const old = await paySale(app, t, account, 50);
  await pool.query(
    "UPDATE transactions SET occurred_at = now() - interval '200 days' WHERE payment_id = $1", [old.paymentId]);
  await pool.query("UPDATE payments SET occurred_at = now() - interval '200 days' WHERE id = $1", [old.paymentId]);
  await setReserveTerms(t.workspaceId, { pct: 10, releaseDays: 0 });
  const recent = { from: new Date(Date.now() - 10 * 86_400_000).toISOString() };

  const paymentsSummary = async (q = {}) => (await request(app)
    .get(`/workspaces/${t.workspaceId}/payments/summary`).query(q).set(t.authHeaders).expect(200)).body;
  const linksSummary = async (q = {}) => (await request(app)
    .get(`/workspaces/${t.workspaceId}/links/summary`).query(q).set(t.authHeaders).expect(200)).body;
  const analytics = async (q) => (await request(app)
    .get(`/workspaces/${t.workspaceId}/analytics`).query(q).set(t.authHeaders).expect(200)).body.headline;

  const all = await paymentsSummary();
  assert.equal(all.grossContent, 135);
  assert.equal(all.netProfit, Math.round((135 - all.platformFees) * 100) / 100);
  assert.equal((await paymentsSummary(recent)).grossContent, 90);
  assert.equal((await linksSummary()).grossSales, 135);
  assert.equal((await analytics(recent)).gross, 90);

  // A release takes the oldest sale first: 5 from the old sale, 1 from the new one.
  await pool.query(
    `INSERT INTO reserve_releases (workspace_id, amount, currency, released_by_user_id)
     VALUES ($1, 6, 'EUR', $2)`, [t.workspaceId, t.userId]);
  assert.equal((await paymentsSummary()).grossContent, 141);
  assert.equal((await paymentsSummary(recent)).grossContent, 91);
  assert.equal((await getProviderReserve(t)).held, 9);
});
