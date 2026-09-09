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
  const analyst = await addMember(app, tenant, 'analyst');
  await request(app).patch(`/workspaces/${tenant.workspaceId}`).set(tenant.authHeaders).send({
    accountLabel: 'Model',
    accountLabelPlural: 'Models',
    agentLabel: 'Closer',
    agentLabelPlural: 'Closers',
  }).expect(200);

  const me = (await request(app).get('/auth/me')
    .set('Authorization', analyst.headers.Authorization).expect(200)).body;
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
