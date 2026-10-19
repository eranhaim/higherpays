'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const {
  createTenant, createAccount, addMember, getPlatformAdmin,
} = require('../helpers/tenant');
const { paySale } = require('../helpers/webhook');

test('workspace vocabulary reaches other users, exports, and notifications', async () => {
  const tenant = await createTenant(app);
  const member = await addMember(app, tenant, 'member');
  await request(app).patch(`/workspaces/${tenant.workspaceId}`).set(tenant.authHeaders).send({
    accountLabel: 'Model',
    accountLabelPlural: 'Models',
    agentLabel: 'Closer',
    agentLabelPlural: 'Closers',
  }).expect(200);

  const me = (await request(app).get('/auth/me')
    .set('Authorization', member.headers.Authorization).expect(200)).body;
  const workspace = me.workspaces.find((item) => item.id === tenant.workspaceId);
  assert.deepEqual(workspace.labels, {
    account: 'Model', accounts: 'Models', agent: 'Closer', agents: 'Closers',
  });

  const csv = await request(app)
    .get(`/workspaces/${tenant.workspaceId}/payments/export?columns=creator,agent`)
    .set(tenant.authHeaders).expect(200);
  assert.match(csv.text, /Model,Closer/);

  const account = await createAccount(app, tenant);
  await paySale(app, tenant, account, 25);
  const notification = (await pool.query(
    `SELECT body FROM notifications
      WHERE workspace_id=$1 AND event='payment.paid'
      ORDER BY created_at DESC LIMIT 1`,
    [tenant.workspaceId])).rows[0];
  assert.match(notification.body, /^Model:/);
});

test('only an unused workspace can change currency and links must match it', async () => {
  const tenant = await createTenant(app);
  const platform = await getPlatformAdmin(app);

  const changed = (await request(app)
    .patch(`/platform/workspaces/${tenant.workspaceId}/currency`)
    .set(platform.headers).send({ currency: 'USD' }).expect(200)).body;
  assert.equal(changed.currency, 'USD');
  const audit = (await pool.query(
    `SELECT metadata FROM audit_log
      WHERE workspace_id=$1 AND action='platform.workspace.currency'
      ORDER BY id DESC LIMIT 1`,
    [tenant.workspaceId])).rows[0];
  assert.deepEqual(audit.metadata, { from: 'EUR', to: 'USD' });

  const account = await createAccount(app, tenant);
  await request(app).post(`/workspaces/${tenant.workspaceId}/links`).set(tenant.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 25, currency: 'EUR' }).expect(400);
  await request(app).post(`/workspaces/${tenant.workspaceId}/links`).set(tenant.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 25, currency: 'USD' }).expect(201);

  await request(app).patch(`/platform/workspaces/${tenant.workspaceId}/currency`)
    .set(platform.headers).send({ currency: 'GBP' }).expect(409);
});

// The rate card is edited from the agency's own Settings page, so the gate is
// no longer "a page only operators can open". A workspace_owner and a
// workspace_admin hold every workspace permission there is; only
// requirePlatformAdmin keeps them away from HigherPays' margin and from the
// rates the agency is billed at.
test('the rate card is closed to the agency it bills, for reads and writes', async () => {
  const tenant = await createTenant(app, { pspRatePct: 8, settlementPct: 0, marginRatePct: 5 });
  const agencyAdmin = await addMember(app, tenant, 'workspace_admin');
  const platform = await getPlatformAdmin(app);

  for (const headers of [tenant.authHeaders, agencyAdmin.headers]) {
    const read = await request(app)
      .get(`/platform/workspaces/${tenant.workspaceId}`).set(headers).expect(403);
    assert.equal(read.body.error, 'not_platform_admin');
    assert.equal(read.body.marginRatePct, undefined);
    assert.equal(read.body.feeHistory, undefined);

    const rates = await request(app)
      .put(`/platform/workspaces/${tenant.workspaceId}/platform-fee`).set(headers)
      .send({ pspRatePct: 1, settlementPct: 0, marginRatePct: 0, pspFixedFee: 0, checkoutFee: 0, feeModel: 'flat' })
      .expect(403);
    assert.equal(rates.body.error, 'not_platform_admin');

    const reversals = await request(app)
      .put(`/platform/workspaces/${tenant.workspaceId}/settlement-fee`).set(headers)
      .send({ chargebackFee: 0, refundFee: 0, declineFee: 0, settlementFeePct: 0, settlementFeeFlat: 0, reservePct: 0, reserveReleaseDays: 0 })
      .expect(403);
    assert.equal(reversals.body.error, 'not_platform_admin');

    const currency = await request(app)
      .patch(`/platform/workspaces/${tenant.workspaceId}/currency`).set(headers)
      .send({ currency: 'USD' }).expect(403);
    assert.equal(currency.body.error, 'not_platform_admin');
  }

  // Every rejected write left the rate card exactly as onboarding set it.
  const detail = (await request(app)
    .get(`/platform/workspaces/${tenant.workspaceId}`).set(platform.headers).expect(200)).body;
  assert.equal(detail.currency, 'EUR');
  assert.equal(detail.feeHistory.length, 1);
  assert.equal(detail.feeHistory[0].pspRatePct, 8);
  assert.equal(detail.feeHistory[0].marginRatePct, 5);
  assert.equal(detail.settlementFee.refundFee, 15);
  assert.equal(detail.settlementFee.chargebackFee, 60);
});

test('link creation validates currency after acquiring the workspace lock', async () => {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "UPDATE workspaces SET currency='USD' WHERE id=$1",
      [tenant.workspaceId]);
    const pending = request(app).post(`/workspaces/${tenant.workspaceId}/links`)
      .set(tenant.authHeaders)
      .send({ accountId: account.id, type: 'single_use', amount: 25, currency: 'EUR' })
      .then((response) => response);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await client.query('COMMIT');
    assert.equal((await pending).status, 400);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
  const count = (await pool.query(
    'SELECT count(*)::int AS count FROM payment_links WHERE workspace_id=$1',
    [tenant.workspaceId])).rows[0].count;
  assert.equal(count, 0);
});
