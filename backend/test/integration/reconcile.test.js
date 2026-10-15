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

const linkStatusOf = async (linkId) =>
  (await pool.query('SELECT status FROM payment_links WHERE id = $1', [linkId])).rows[0].status;

const salesOf = async (linkId) =>
  Number((await pool.query(
    `SELECT count(*) AS n
       FROM revenue_entries re
       JOIN transactions t ON t.id = re.transaction_id
       JOIN payments p ON p.id = t.payment_id
      WHERE p.payment_link_id = $1 AND re.entry_type = 'sale'`, [linkId])).rows[0].n);

const closeLink = (linkId) => pool.query(
  "UPDATE payment_links SET status = 'expired', expires_at = now() - interval '1 day' WHERE id = $1",
  [linkId]);

const statusReply = (status, transactionId, extra = {}) => ({
  status,
  transaction_id: transactionId,
  gross_amount: 40,
  unit: 'EUR',
  transactions: [],
  ...extra,
});

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

// MantaPay approved three orders on 14 Oct that it had already declined, and
// handed back NEW transaction ids for them. The decline is keyed on the old
// id, so it survives as its own row; the approval arrived after the link had
// been written off, where the reconciler had stopped looking.
test('a decline later approved under a new transaction id ends up paid, exactly once', async () => {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  const link = await createLink(tenant, account);
  const ws = await workspaceOf(tenant);

  await withStubbedStatus([statusReply('declined', '153674', {
    payment_request_status_id: '5000', reply_description: 'General bank decline',
  })], () => reconcile(ws));
  assert.deepEqual(await paymentsOf(link.id), [{ status: 'failed' }]);

  await closeLink(link.id);

  // The same order, now approved, under an id we have never seen.
  const approved = statusReply('approved', '127349', {
    payment_request_status_id: '000', reply_description: 'SUCCESS',
  });
  const first = await withStubbedStatus([approved], () => reconcile(ws));
  assert.deepEqual(first.updated.map((u) => u.lateApproval), [true]);

  const afterApproval = await paymentsOf(link.id);
  assert.deepEqual(
    afterApproval.map((p) => p.status).sort(),
    ['paid', 'superseded'],
    'the beaten attempt is history, not a failure');
  assert.equal(await salesOf(link.id), 1);
  assert.equal(await linkStatusOf(link.id), 'pending', 'a late approval reopens the link for its details');

  // Re-observing the approval must not mint a second payment or a second sale.
  const again = await withStubbedStatus([approved], () => reconcile(ws));
  assert.deepEqual(again.updated, []);
  assert.equal((await paymentsOf(link.id)).length, 2);
  assert.equal(await salesOf(link.id), 1);
});

// The sweep over closed links must not become a second phantom-row source.
test('a closed link MantaPay still calls pending records nothing', async () => {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  const link = await createLink(tenant, account);
  const ws = await workspaceOf(tenant);
  await closeLink(link.id);

  await withStubbedStatus([
    statusReply('pending', '248973', { payment_request_status_id: '553', reply_description: 'Pending' }),
  ], async () => {
    for (let run = 0; run < 3; run++) {
      const summary = await reconcile(ws);
      assert.deepEqual(summary.skipped.map((s) => s.reason), ['still_pending']);
    }
  });

  assert.deepEqual(await paymentsOf(link.id), []);
  assert.equal(await linkStatusOf(link.id), 'expired');
});
