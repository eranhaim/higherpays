'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount } = require('../helpers/tenant');
const provider = require('../../src/providers/mantapay');
const { withTransaction } = require('../../src/db');
const { reconcileWorkspace } = require('../../src/services/links.service');

test.after(async () => {
  await pool.end();
});

// The scheduler runs one reconcile pass per workspace inside a transaction.
const reconcile = (ws) => withTransaction((c) => reconcileWorkspace(c, ws, 0));

async function withStubbedStatus(replies, run) {
  const real = provider.getPaymentStatus;
  let call = 0;
  provider.getPaymentStatus = async () => replies[Math.min(call++, replies.length - 1)];
  try { return await run(); } finally { provider.getPaymentStatus = real; }
}

async function createLink(tenant, account) {
  return (await request(app).post(`/workspaces/${tenant.workspaceId}/links`).set(tenant.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 40, currency: 'EUR' }).expect(201)).body;
}

const workspaceOf = async (tenant) =>
  (await pool.query('SELECT * FROM workspaces WHERE id = $1', [tenant.workspaceId])).rows[0];

const paymentsOf = async (linkId) =>
  (await pool.query('SELECT status FROM payments WHERE payment_link_id = $1', [linkId])).rows;

// MantaPay answers a status poll for an open checkout with a brand new
// transaction id every time, so recording the poll as a payment added one
// phantom row per link per run — 2,397 of them on the live database.
test('polling an unpaid link records no payment, however often it is polled', async () => {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  const link = await createLink(tenant, account);
  const ws = await workspaceOf(tenant);

  const pendingPoll = (transactionId) => ({
    status: 'pending',
    transaction_id: transactionId,
    gross_amount: 40,
    unit: 'EUR',
    payment_request_status_id: '553',
    reply_description: 'Pending',
    transactions: [],
  });

  await withStubbedStatus([pendingPoll('900001'), pendingPoll('900002'), pendingPoll('900003')], async () => {
    for (let run = 0; run < 3; run++) {
      const summary = await reconcile(ws);
      assert.equal(summary.updated.length, 0);
      assert.deepEqual(summary.skipped.map((s) => s.reason), ['status_pending']);
    }
  });

  assert.deepEqual(await paymentsOf(link.id), []);
  assert.equal(
    (await pool.query("SELECT status FROM payment_links WHERE id = $1", [link.id])).rows[0].status,
    'active');
});

test('a settled outcome found by polling is still recorded', async () => {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  const link = await createLink(tenant, account);
  const ws = await workspaceOf(tenant);

  await withStubbedStatus([{
    status: 'declined',
    transaction_id: '900100',
    gross_amount: 40,
    unit: 'EUR',
    payment_request_status_id: '5051',
    reply_description: 'Insufficient Funds',
    transactions: [],
  }], () => reconcile(ws));

  assert.deepEqual(await paymentsOf(link.id), [{ status: 'failed' }]);
});
