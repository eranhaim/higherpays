'use strict';
// The revenue split: parts must sum to the whole, a configuration that would
// pay out more than 100% is refused before it reaches the ledger, and a
// reversal happens once.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount, createAgent, assignAgent, getPlatformAdmin, PASSWORD, tag } = require('../helpers/tenant');
const { paySale, endpointFor, buildPaidPayload, postWebhook } = require('../helpers/webhook');
const n = (v) => Number(v);

async function saleEntry(transId) {
  return (await pool.query(
    `SELECT re.* FROM revenue_entries re JOIN transactions t ON t.id = re.transaction_id
      WHERE t.provider_transaction_id = $1 AND re.entry_type = 'sale'`, [transId])).rows[0];
}

test('a €100 cascade deal splits to the documented figures', async () => {
  const t = await createTenant(app, { feeModel: 'cascade', mdrPct: 7, settlementPct: 1, pspFixedFee: 0.5, marginRatePct: 5, pspRatePct: 8 });
  const account = await createAccount(app, t, { revenueSplitPct: 70 });
  const agent = await createAgent(app, t, { commissionPct: 10 });
  await assignAgent(app, t, account.id, agent.id);
  const { transId } = await paySale(app, t, account, 100, { headers: agent.headers });
  const e = await saleEntry(transId);
  // PSP: 7.00 mdr + 0.50 fixed + 0.925 settlement = 8.425; + 5.00 margin = 13.425 → 13.43 taken.
  assert.equal(n(e.fee_mdr), 7);
  assert.equal(n(e.fee_fixed), 0.5);
  assert.equal(n(e.fee_settlement), 0.925);
  assert.equal(n(e.platform_margin), 5);
  assert.equal(n(e.platform_fee), 13.43);
  assert.equal(n(e.distributable), 86.57);
  assert.equal(n(e.account_amount), 60.6, '70% of 86.57, rounded');
  assert.equal(n(e.agent_amount), 8.66, '10% of 86.57, rounded');
  assert.equal(n(e.agency_amount), 17.31, 'the agency takes the remainder');
});

test('the platform admin can inspect the payment waterfall', async () => {
  const t = await createTenant(app, {
    feeModel: 'cascade', mdrPct: 7, settlementPct: 1,
    pspRatePct: 8, pspFixedFee: 0.5, marginRatePct: 5,
  });
  const account = await createAccount(app, t, { revenueSplitPct: 70 });
  const { paymentId } = await paySale(app, t, account, 100);
  const platform = await getPlatformAdmin(app);

  const flow = (await request(app)
    .get(`/workspaces/${t.workspaceId}/payments/${paymentId}/flow`)
    .set({ ...platform.headers, 'X-Workspace-Id': t.workspaceId })
    .expect(200)).body;

  assert.equal(flow.customerTotal, 100);
  assert.equal(flow.saleAmount, 100);
  assert.equal(flow.fees.provider, 8.425);
  assert.equal(flow.fees.higherPaysMargin, 5);
  assert.equal(flow.fees.platform, 13.43);
  assert.equal(flow.distributable, 86.57);
  assert.equal(flow.distribution.account.amount, 60.6);
  assert.equal(flow.distribution.agent.amount, 0);
  assert.equal(flow.distribution.agency.amount, 25.97);
  assert.equal(flow.rates.mdr.percentage, 7);
  assert.equal(flow.rates.mdr.base, 100);
  assert.equal(flow.rates.settlement.percentage, 1);
  assert.equal(flow.rates.settlement.base, 92.5);
  assert.equal(flow.rates.higherPaysMargin.percentage, 5);
  assert.equal(flow.distribution.account.percentage, 70);
  assert.equal(flow.distribution.account.base, 86.57);

  await request(app)
    .get(`/workspaces/${t.workspaceId}/payments/${paymentId}/flow`)
    .set(t.authHeaders)
    .expect(403);
});

test('a posted sale is split to cents and the parts sum to the distributable amount', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t, { revenueSplitPct: 33 });
  const agent = await createAgent(app, t, { commissionPct: 10 });
  await assignAgent(app, t, account.id, agent.id);
  // 10.01 makes every cut land on a fraction of a cent.
  const { transId } = await paySale(app, t, account, 10.01, { headers: agent.headers });
  const e = await saleEntry(transId);
  for (const col of ['distributable', 'account_amount', 'agent_amount', 'agency_amount']) {
    assert.equal(Math.round(n(e[col]) * 100) / 100, n(e[col]), `${col} is whole cents`);
  }
  assert.equal(Math.round((n(e.account_amount) + n(e.agent_amount) + n(e.agency_amount)) * 100) / 100, n(e.distributable));
});

test('a share that cannot fit next to the highest agent commission is refused, in both directions', async () => {
  const t = await createTenant(app);
  await createAgent(app, t, { commissionPct: 25 });
  const res = await request(app).post(`/workspaces/${t.workspaceId}/accounts`).set(t.authHeaders)
    .send({ email: `g+${tag()}@test.local`, fullName: 'G', password: PASSWORD, name: 'Greedy', revenueSplitPct: 80 }).expect(400);
  assert.deepEqual(res.body.fields, ['revenueSplitPct']);

  await createAccount(app, t, { revenueSplitPct: 75 });
  await request(app).post(`/workspaces/${t.workspaceId}/agents`).set(t.authHeaders)
    .send({ email: `a+${tag()}@test.local`, fullName: 'A', password: PASSWORD, commissionPct: 26 }).expect(400);
});

test('a recorded refund reverses the sale, and neither a refund nor a chargeback can follow it', async () => {
  const t = await createTenant(app, { refundFee: 15 });
  const account = await createAccount(app, t, { revenueSplitPct: 70 });
  const { paymentId, transId } = await paySale(app, t, account, 50);

  const refund = (await request(app).post(`/workspaces/${t.workspaceId}/payments/${paymentId}/refund`).set(t.authHeaders).expect(200)).body;
  assert.equal(refund.reversed, 50);
  assert.equal(refund.fee, 15);

  const sum = (await pool.query(
    `SELECT SUM(re.account_amount) AS acc, SUM(re.agent_amount) AS ag, SUM(re.agency_amount) AS agency
       FROM revenue_entries re JOIN transactions t ON t.id = re.transaction_id WHERE t.provider_transaction_id = $1`, [transId])).rows[0];
  assert.equal(n(sum.ag), 0, 'the agent loses the commission');
  assert.equal(n(sum.acc), -15, 'the account bears the refund fee');
  assert.equal(n(sum.agency), 0, 'the agency is back to zero');

  const payment = (await pool.query('SELECT status FROM payments WHERE id = $1', [paymentId])).rows[0];
  assert.equal(payment.status, 'refunded');
  const txCount = (await pool.query("SELECT count(*)::int AS c FROM transactions WHERE payment_id = $1 AND type = 'refund'", [paymentId])).rows[0].c;
  assert.equal(txCount, 1);

  await request(app).post(`/workspaces/${t.workspaceId}/payments/${paymentId}/refund`).set(t.authHeaders).expect(409);
  await request(app).post(`/workspaces/${t.workspaceId}/payments/${paymentId}/chargeback`).set(t.authHeaders).expect(409);
});

test('a declined outcome arriving after an approved one does not un-approve the sale', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const { link, transId, paymentId } = await paySale(app, t, account, 30);
  await postWebhook(app, await endpointFor(t.workspaceId),
    buildPaidPayload({ reference: link.referenceId, transId, amount: 30, replyCode: '051' })).expect(200);
  const p = (await pool.query('SELECT status FROM payments WHERE id = $1', [paymentId])).rows[0];
  assert.equal(p.status, 'paid');
  const entries = (await pool.query(
    'SELECT count(*)::int AS c FROM revenue_entries re JOIN transactions t ON t.id = re.transaction_id WHERE t.provider_transaction_id = $1', [transId])).rows[0].c;
  assert.equal(entries, 1);
});

test('rate changes do not re-price historical sales', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const { transId } = await paySale(app, t, account, 100);
  const before = await saleEntry(transId);
  const { getPlatformAdmin } = require('../helpers/tenant');
  const admin = await getPlatformAdmin(app);
  await request(app).put(`/platform/workspaces/${t.workspaceId}/platform-fee`).set(admin.headers)
    .send({ pspRatePct: 12, marginRatePct: 9, pspFixedFee: 1 }).expect(201);
  const after = await saleEntry(transId);
  assert.equal(n(after.platform_fee), n(before.platform_fee));
});
