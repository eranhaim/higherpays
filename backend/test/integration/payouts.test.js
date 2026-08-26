'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount, createAgent, assignAgent } = require('../helpers/tenant');
const { paySale } = require('../helpers/webhook');

test('two concurrent payout runs record one payout, not two', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  await paySale(app, t, account, 100);
  const run = () => request(app).post(`/workspaces/${t.workspaceId}/payouts/run`).set(t.authHeaders).send({ payeeType: 'account' });
  const [a, b] = await Promise.all([run(), run()]);
  const ran = [a, b].map((r) => r.body.ran).sort();
  assert.deepEqual(ran, [0, 1]);
  const payouts = (await pool.query("SELECT count(*)::int AS c FROM payouts WHERE workspace_id = $1 AND payee_type = 'account'", [t.workspaceId])).rows[0].c;
  assert.equal(payouts, 1);
});

test('breakdown reports what is owed per account and per agent, what came in, and the cash position', async () => {
  const t = await createTenant(app, { feeModel: 'flat', pspRatePct: 8, marginRatePct: 5, pspFixedFee: 0 });
  const account = await createAccount(app, t, { revenueSplitPct: 70 });
  const agent = await createAgent(app, t, { commissionPct: 10 });
  await assignAgent(app, t, account.id, agent.id);
  await paySale(app, t, account, 100, { headers: agent.headers });

  const b = (await request(app).get(`/workspaces/${t.workspaceId}/payouts/breakdown`).set(t.authHeaders).expect(200)).body;
  // 100 - 13% = 87 distributable → account 60.90, agent 8.70
  const acc = b.perAccount.find((a) => a.id === account.id);
  assert.equal(acc.owed, 60.9);
  const ag = b.perAgent.find((a) => a.id === agent.id);
  assert.equal(ag.owed, 8.7);
  assert.equal(ag.sales, 1);
  assert.equal(b.cash.received, 87);
  assert.equal(b.cash.owed, 69.6);
  assert.equal(b.cash.shortfallIfPaidNow, 0);

  await request(app).post(`/workspaces/${t.workspaceId}/payouts/run`).set(t.authHeaders).send({ payeeType: 'agent', targetId: agent.id }).expect(200);
  const after = (await request(app).get(`/workspaces/${t.workspaceId}/payouts/breakdown`).set(t.authHeaders).expect(200)).body;
  assert.equal(after.perAgent.find((a) => a.id === agent.id).owed, 0);
  assert.equal(after.perAccount.find((a) => a.id === account.id).owed, 60.9);

  const mine = (await request(app).get(`/workspaces/${t.workspaceId}/me/earnings`).set(agent.headers).expect(200)).body;
  assert.equal(mine.role, 'agent');
  assert.equal(mine.period.earned, 8.7);
  assert.equal(mine.balance.paidToDate, 8.7);
});
