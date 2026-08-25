'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { withSystem } = require('../../src/db');
const { createTenant, createAccount } = require('../helpers/tenant');
const { paySale } = require('../helpers/webhook');

test('two concurrent payout runs record one payout, not two', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t, { revenueSplitPct: 70 });
  await paySale(app, t, account, 100);

  const run = () => request(app)
    .post(`/workspaces/${t.workspaceId}/payouts/run`)
    .set(t.authHeaders)
    .send({ payeeType: 'account', targetId: account.id });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.ran + b.body.ran, 1, 'exactly one run found something to pay');

  const payouts = await withSystem((c) => c.query(
    "SELECT status, amount FROM payouts WHERE workspace_id = $1 AND account_id = $2", [t.workspaceId, account.id]));
  assert.equal(payouts.rows.length, 1);
  assert.equal(payouts.rows[0].status, 'recorded');
});

test('breakdown reports what is owed, what came in, and the cash shortfall', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t, { revenueSplitPct: 70 });
  await paySale(app, t, account, 100);

  const from = new Date(Date.now() - 86400000).toISOString();
  const to = new Date(Date.now() + 86400000).toISOString();
  const res = await request(app)
    .get(`/workspaces/${t.workspaceId}/payouts/breakdown?from=${from}&to=${to}`)
    .set(t.authHeaders).expect(200);

  const c = res.body.cash;
  assert.ok(c.received > 0 && c.received <= 100, 'received is gross minus fees');
  assert.ok(c.owed > 0 && c.owed <= c.received, 'what is owed comes out of what was received');
  assert.equal(c.available, Math.round((c.received - c.heldInReserve) * 100) / 100);
  assert.equal(c.shortfallIfPaidNow, Math.max(0, Math.round((c.owed - c.available) * 100) / 100));
});
