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
const { ROLE_PERMISSIONS } = require('../../src/auth/permissions');

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
// yields the fee by subtraction. `amount` is the sale price on a payment, and
// `amountAfterFees` sits in the same object — that pairing is the leak this
// file exists to prevent.
const GROSS_FIELDS = ['grossContent', 'gross', 'grossSales', 'amount'];

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

/** The export as a header row plus the data rows, both already split on commas. */
async function getCsv(t, headers) {
  const res = await request(app).get(`/workspaces/${t.workspaceId}/payments/export`)
    .set(headers).expect(200);
  const [header, ...rows] = res.text.replace('\ufeff', '').trim().split('\r\n');
  return { columns: header.split(','), rows: rows.map((row) => row.split(',')) };
}

/** Grants a seat more than its role comes with, the way an admin can. */
function grantPermissions(t, userId, role, ...permissions) {
  return request(app).patch(`/workspaces/${t.workspaceId}/team/${userId}`)
    .set(t.authHeaders)
    .send({ permissions: [...ROLE_PERMISSIONS[role], ...permissions] })
    .expect(200);
}

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
  assertNoFields(list, GROSS_FIELDS, 'GET /payments');

  const payment = await get(t, `/payments/${list.items[0].id}`, headers);
  assert.equal(payment.amountAfterFees, 87);
  assertNoFields(payment, FEE_FIELDS, 'GET /payments/:id');
  assertNoFields(payment, GROSS_FIELDS, 'GET /payments/:id');

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

  const list = await get(t, '/payments', agent.headers);
  assert.equal(list.items[0].amountAfterFees, 87);
  assertNoFields(list, FEE_FIELDS, 'GET /payments');
  assertNoFields(list, GROSS_FIELDS, 'GET /payments');

  const report = await get(t, '/analytics', agent.headers);
  assert.equal(report.scope, 'agent');
  assert.equal(report.headline.net, 87);
  // Averages are on a net basis too, or gross falls out of aov × paidCount.
  assert.equal(report.headline.aov, 87);
  assertNoFields(report, FEE_FIELDS, 'GET /analytics');
  assertNoFields(report, GROSS_FIELDS, 'GET /analytics');
});

test('a creator who may export downloads net revenue and no gross column', async () => {
  const { t, account } = await setup();
  await grantPermissions(t, account.ownerUserId, 'account_owner', 'payments.export');

  const { columns, rows } = await getCsv(t, account.ownerHeaders);
  assert.equal(columns.includes('Gross Revenue'), false, 'the export must not carry gross');
  assert.equal(columns.includes('Platform Fee'), false, 'the export must not carry the fee');
  assert.equal(rows[0][columns.indexOf('Net Revenue')], '87.00');

  // Naming the withheld column explicitly is a 400, not a quiet gross column.
  await request(app).get(`/workspaces/${t.workspaceId}/payments/export?columns=gross`)
    .set(account.ownerHeaders).expect(400);
});

test('an admin keeps the full fee breakdown', async () => {
  const { t } = await setup();

  const summary = await get(t, '/payments/summary', t.authHeaders);
  assert.equal(summary.grossContent, 100);
  assert.equal(summary.platformFees, 13);
  assert.equal(summary.netProfit, 87);

  const list = await get(t, '/payments', t.authHeaders);
  assert.equal(list.items[0].amount, 100);
  assert.equal(list.items[0].platformFee, 13);
  assert.equal(list.items[0].amountAfterFees, undefined);

  const payment = await get(t, `/payments/${list.items[0].id}`, t.authHeaders);
  assert.equal(payment.amount, 100);
  assert.equal(payment.platformFee, 13);

  const { columns, rows } = await getCsv(t, t.authHeaders);
  assert.equal(rows[0][columns.indexOf('Gross Revenue')], '100.00 EUR');
  assert.equal(rows[0][columns.indexOf('Platform Fee')], '13.0000');
  assert.equal(rows[0][columns.indexOf('Net Revenue')], '87.00');

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

// GET /team returns every seat in the workspace with no row scope, so the pay
// terms on those rows are a whole-workspace figure and belong behind
// `data.view_all`. `revenue.view` would not do: it is a per-seat permission an
// admin can hand to one agent, and that grant must not become everyone's split.
test('an agent seat granted team and revenue access still gets no pay terms', async () => {
  const { t, account, agent } = await setup();
  await grantPermissions(t, agent.userId, 'agent', 'team.view', 'revenue.view');

  const { members } = await get(t, '/team', agent.headers);
  const creator = members.find((m) => m.accountId === account.id);
  assert.ok(creator, 'the roster still lists the creator');
  assert.equal(creator.revenueSplitPct, undefined);
  assert.equal(creator.payModel, undefined);
  assert.equal(creator.salaryAmount, undefined);
  const self = members.find((m) => m.agentId === agent.id);
  assert.equal(self.commissionPct, undefined);

  // The owner, who does hold data.view_all, still reads them.
  const full = await get(t, '/team', t.authHeaders);
  assert.equal(full.members.find((m) => m.accountId === account.id).revenueSplitPct, 70);
  assert.equal(full.members.find((m) => m.agentId === agent.id).commissionPct, 10);
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
