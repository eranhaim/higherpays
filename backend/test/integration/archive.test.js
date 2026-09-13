'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount, getPlatformAdmin } = require('../helpers/tenant');
const { paySale } = require('../helpers/webhook');
const { reconcileWorkspace } = require('../../src/services/links.service');

test.after(async () => {
  await pool.end();
});

test('an owner can archive and restore a payment without changing its ledger', async () => {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  const sale = await paySale(app, tenant, account, 40);
  const before = (await pool.query(
    `SELECT
       (SELECT count(*) FROM transactions WHERE payment_id = $1)::int AS transactions,
       (SELECT count(*) FROM revenue_entries re
          JOIN transactions t ON t.id = re.transaction_id
         WHERE t.payment_id = $1)::int AS entries`,
    [sale.paymentId])).rows[0];

  await request(app)
    .post(`/workspaces/${tenant.workspaceId}/payments/${sale.paymentId}/archive`)
    .set(tenant.authHeaders)
    .expect(200);

  assert.equal((await request(app).get(`/workspaces/${tenant.workspaceId}/payments`).set(tenant.authHeaders).expect(200)).body.items.length, 0);
  assert.equal((await request(app).get(`/workspaces/${tenant.workspaceId}/payments/summary`).set(tenant.authHeaders).expect(200)).body.grossContent, 0);
  const payout = (await request(app).get(`/workspaces/${tenant.workspaceId}/payouts/breakdown`).set(tenant.authHeaders).expect(200)).body;
  assert.equal(payout.summary.grossSales, 0);

  const archived = (await request(app).get(`/workspaces/${tenant.workspaceId}/archive?type=payments`).set(tenant.authHeaders).expect(200)).body.items;
  assert.equal(archived.some((item) => item.id === sale.paymentId), true);

  const afterArchive = (await pool.query(
    `SELECT
       (SELECT count(*) FROM transactions WHERE payment_id = $1)::int AS transactions,
       (SELECT count(*) FROM revenue_entries re
          JOIN transactions t ON t.id = re.transaction_id
         WHERE t.payment_id = $1)::int AS entries`,
    [sale.paymentId])).rows[0];
  assert.deepEqual(afterArchive, before);

  await request(app)
    .post(`/workspaces/${tenant.workspaceId}/archive/payments/${sale.paymentId}/restore`)
    .set(tenant.authHeaders)
    .expect(200);
  assert.equal((await request(app).get(`/workspaces/${tenant.workspaceId}/payments`).set(tenant.authHeaders).expect(200)).body.items.length, 1);
  assert.equal((await request(app).get(`/workspaces/${tenant.workspaceId}/payments/summary`).set(tenant.authHeaders).expect(200)).body.grossContent, 40);
  const auditActions = (await pool.query(
    `SELECT action FROM audit_log
      WHERE workspace_id = $1 AND entity_type = 'payment' AND entity_id = $2
      ORDER BY created_at`,
    [tenant.workspaceId, sale.paymentId])).rows.map((row) => row.action);
  assert.deepEqual(auditActions.slice(-2), ['payment.archive', 'archive.restore']);
});

test('archived links cannot be opened or reconciled, and can be restored', async () => {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  const link = (await request(app).post(`/workspaces/${tenant.workspaceId}/links`).set(tenant.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 40, currency: 'EUR' }).expect(201)).body;

  await request(app)
    .post(`/workspaces/${tenant.workspaceId}/links/${link.id}/archive`)
    .set(tenant.authHeaders)
    .expect(200);
  await request(app).get(`/pay/${link.referenceId}`).expect(404);

  const workspace = (await pool.query('SELECT * FROM workspaces WHERE id = $1', [tenant.workspaceId])).rows[0];
  const result = await reconcileWorkspace({ query: (...args) => pool.query(...args) }, workspace);
  assert.equal(result.checked, 0);

  await request(app)
    .post(`/workspaces/${tenant.workspaceId}/archive/links/${link.id}/restore`)
    .set(tenant.authHeaders)
    .expect(200);
  assert.equal((await request(app).get(`/workspaces/${tenant.workspaceId}/links`).set(tenant.authHeaders).expect(200)).body.items.length, 1);
});

test('only an owner or platform admin can manage the archive', async () => {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  const sale = await paySale(app, tenant, account, 25);

  await request(app)
    .post(`/workspaces/${tenant.workspaceId}/payments/${sale.paymentId}/archive`)
    .set(account.ownerHeaders)
    .expect(403);

  const platform = await getPlatformAdmin(app);
  const platformHeaders = { ...platform.headers, 'X-Workspace-Id': tenant.workspaceId };
  await request(app)
    .post(`/workspaces/${tenant.workspaceId}/payments/${sale.paymentId}/archive`)
    .set(platformHeaders)
    .expect(200);
});
