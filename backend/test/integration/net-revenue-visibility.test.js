'use strict';
// Creators and agents are paid out of the distributable, so they read net
// revenue — and only net revenue. No fee figure reaches them under any name,
// and no gross figure sits beside net where the fee could be subtracted out.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount, createAgent, assignAgent } = require('../helpers/tenant');
const { paySale } = require('../helpers/webhook');

// 8% PSP + 5% margin, no fixed fee: a 100 sale leaves 87 to distribute.
const RATES = { feeModel: 'flat', pspRatePct: 8, marginRatePct: 5, pspFixedFee: 0 };

// Every name the fee has ever carried through the API, in any response shape.
// A scoped caller must see none of them: each one either is the platform fee
// or reveals how it is composed.
const FEE_FIELDS = [
  'platformFee', 'platformFees', 'platformMargin', 'higherPaysMargin',
  'pspFee', 'feeMdr', 'feeFixed', 'feeSettlement', 'feeSurcharge',
  'providerFee', 'surcharge', 'feeCost', 'feesDeducted', 'deductions',
  'netProfit', 'checkoutFeeRevenue',
];

// Gross under each of the names it is served by. Beside net, any of them
// yields the fee by subtraction.
const GROSS_FIELDS = ['grossContent', 'gross', 'grossSales'];

function keysDeep(value, found = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((v) => keysDeep(v, found));
  } else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      found.add(key);
      keysDeep(v, found);
    }
  }
  return found;
}

function assertNoFields(body, fields, where) {
  const present = [...keysDeep(body)].filter((k) => fields.includes(k));
  assert.deepEqual(present, [], `${where} must not expose ${present.join(', ')}`);
}

async function setup() {
  const t = await createTenant(app, RATES);
  const account = await createAccount(app, t, { revenueSplitPct: 70 });
  const agent = await createAgent(app, t, { commissionPct: 10 });
  await assignAgent(app, t, account.id, agent.id);
  await paySale(app, t, account, 100, { headers: agent.headers });
  return { t, account, agent };
}

const get = (t, path, headers) =>
  request(app).get(`/workspaces/${t.workspaceId}${path}`).set(headers).expect(200).then((r) => r.body);

test('a creator reads net revenue and is shown no fee or gross figure', async () => {
  const { t, account } = await setup();
  const headers = account.ownerHeaders;

  const earnings = await get(t, '/me/earnings', headers);
  assert.equal(earnings.role, 'account_owner');
  assert.equal(earnings.period.netRevenue, 87);
  assert.equal(earnings.period.yourRatePct, 70);
  assert.equal(earnings.period.earned, 60.9);
  assertNoFields(earnings, FEE_FIELDS, 'GET /me/earnings');
  assertNoFields(earnings, GROSS_FIELDS, 'GET /me/earnings');

  const summary = await get(t, '/payments/summary', headers);
  assert.equal(summary.afterFees, 87);
  assertNoFields(summary, FEE_FIELDS, 'GET /payments/summary');
  assertNoFields(summary, GROSS_FIELDS, 'GET /payments/summary');

  const list = await get(t, '/payments', headers);
  assert.equal(list.items[0].amountAfterFees, 87);
  assertNoFields(list, FEE_FIELDS, 'GET /payments');

  const links = await get(t, '/links/summary', headers);
  assert.equal(links.netAfterFees, 87);
  assertNoFields(links, FEE_FIELDS, 'GET /links/summary');
  assertNoFields(links, GROSS_FIELDS, 'GET /links/summary');

  const report = await get(t, '/analytics', headers);
  assert.equal(report.scope, 'account');
  assert.equal(report.headline.net, 87);
  assertNoFields(report, FEE_FIELDS, 'GET /analytics');
  assertNoFields(report, GROSS_FIELDS, 'GET /analytics');
});

test('an agent reads net revenue on the same terms as a creator', async () => {
  const { t, agent } = await setup();

  const earnings = await get(t, '/me/earnings', agent.headers);
  assert.equal(earnings.role, 'agent');
  assert.equal(earnings.payModel, null);
  assert.equal(earnings.period.netRevenue, 87);
  assert.equal(earnings.period.earned, 8.7);
  assertNoFields(earnings, FEE_FIELDS, 'GET /me/earnings');
  assertNoFields(earnings, GROSS_FIELDS, 'GET /me/earnings');

  const summary = await get(t, '/payments/summary', agent.headers);
  assert.equal(summary.afterFees, 87);
  assertNoFields(summary, FEE_FIELDS, 'GET /payments/summary');
  assertNoFields(summary, GROSS_FIELDS, 'GET /payments/summary');

  const report = await get(t, '/analytics', agent.headers);
  assert.equal(report.scope, 'agent');
  assert.equal(report.headline.net, 87);
  // Averages are on a net basis too, or gross falls out of aov × paidCount.
  assert.equal(report.headline.aov, 87);
  assertNoFields(report, FEE_FIELDS, 'GET /analytics');
  assertNoFields(report, GROSS_FIELDS, 'GET /analytics');
});

test('an admin keeps the full fee breakdown', async () => {
  const { t } = await setup();

  const summary = await get(t, '/payments/summary', t.authHeaders);
  assert.equal(summary.grossContent, 100);
  assert.equal(summary.platformFees, 13);
  assert.equal(summary.netProfit, 87);

  const list = await get(t, '/payments', t.authHeaders);
  assert.equal(list.items[0].platformFee, 13);

  const links = await get(t, '/links/summary', t.authHeaders);
  assert.equal(links.grossSales, 100);
  assert.equal(links.netAfterFees, 87);

  const report = await get(t, '/analytics', t.authHeaders);
  assert.equal(report.scope, 'agency');
  assert.equal(report.headline.gross, 100);
  assert.equal(report.headline.net, 87);
  assert.equal(report.headline.platformFee, 13);
  assert.equal(report.timeseries[0].gross, 100);
});

test('a salaried creator is never promised a share of net revenue', async () => {
  const t = await createTenant(app, RATES);
  const account = await createAccount(app, t, { revenueSplitPct: 70 });
  await request(app).patch(`/workspaces/${t.workspaceId}/accounts/${account.id}`)
    .set(t.authHeaders).send({ payModel: 'salary', salaryAmount: 500 }).expect(200);
  await paySale(app, t, account, 100);

  const earnings = await get(t, '/me/earnings', account.ownerHeaders);
  assert.equal(earnings.payModel, 'salary');
  assert.equal(earnings.salaryAmount, 500);
  // The ledger scores a salaried creator 0 on every sale; the rate must agree
  // rather than advertising the revenue_split_pct still on the row.
  assert.equal(earnings.period.yourRatePct, 0);
  assert.equal(earnings.period.earned, 0);
  assert.equal(earnings.period.netRevenue, 87);

  const entry = (await pool.query(
    `SELECT re.account_amount, re.agency_amount
       FROM revenue_entries re
       JOIN transactions tx ON tx.id = re.transaction_id
       JOIN payments p ON p.id = tx.payment_id
      WHERE p.account_id = $1 AND re.entry_type = 'sale'`, [account.id])).rows[0];
  assert.equal(Number(entry.account_amount), 0, 'the agency keeps the share');
  assert.equal(Number(entry.agency_amount), 87);
});
