'use strict';
// A salaried creator takes no cut of a sale — the agency keeps that share —
// and is owed a fixed amount for the payout period instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount } = require('../helpers/tenant');
const { paySale } = require('../helpers/webhook');

const period = () => {
  const to = new Date();
  const from = new Date(Date.now() - 30 * 86400000);
  return { from: from.toISOString(), to: to.toISOString() };
};

test('a sale for a salaried creator leaves their share with the agency', async () => {
  const t = await createTenant(app, { agentPct: 0 });
  const account = await createAccount(app, t);
  await request(app).patch(`/workspaces/${t.workspaceId}/accounts/${account.id}`).set(t.authHeaders)
    .send({ payModel: 'salary', salaryAmount: 2000 }).expect(200);

  const { transId } = await paySale(app, t, account, 100);
  const entry = (await pool.query(
    `SELECT re.distributable, re.account_amount, re.agency_amount
       FROM revenue_entries re JOIN transactions t ON t.id = re.transaction_id
      WHERE t.provider_transaction_id = $1 AND re.entry_type = 'sale'`, [transId])).rows[0];

  assert.equal(Number(entry.account_amount), 0, 'a salaried creator earns nothing per sale');
  assert.equal(Number(entry.agency_amount), Number(entry.distributable), 'the agency keeps all of it');
});

test('the salary is owed once per period and a second run does not pay it again', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  await request(app).patch(`/workspaces/${t.workspaceId}/accounts/${account.id}`).set(t.authHeaders)
    .send({ payModel: 'salary', salaryAmount: 2000 }).expect(200);

  const { from, to } = period();
  const breakdown = (await request(app)
    .get(`/workspaces/${t.workspaceId}/payouts/breakdown?from=${from}&to=${to}`)
    .set(t.authHeaders).expect(200)).body;
  const owed = breakdown.perAccount.find((a) => a.id === account.id);
  assert.equal(owed.owed, 2000, 'the salary is what is owed for the period');

  const first = (await request(app).post(`/workspaces/${t.workspaceId}/payouts/run`).set(t.authHeaders)
    .send({ payeeType: 'account', from, to }).expect(200)).body;
  assert.equal(first.total, 2000);

  const second = (await request(app).post(`/workspaces/${t.workspaceId}/payouts/run`).set(t.authHeaders)
    .send({ payeeType: 'account', from, to }).expect(200)).body;
  assert.equal(second.ran, 0, 'the period is already covered');
});
