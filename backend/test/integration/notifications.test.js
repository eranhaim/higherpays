'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { withTransaction } = require('../../src/db');
const { createTenant, createAccount, addMember } = require('../helpers/tenant');
const { endpointFor, buildPaidPayload, newTransId, paySale, postWebhook } = require('../helpers/webhook');
const { recordPaymentOutcome } = require('../../src/services/payments.service');

async function feed(headers, workspaceId) {
  return (await request(app).get(`/workspaces/${workspaceId}/notifications`).set(headers).expect(200)).body;
}

test('a repeated reconciliation keeps a read payment notification read and creates no duplicate', async () => {
  const tenant = await createTenant(app);
  const member = await addMember(app, tenant, 'member');
  const account = await createAccount(app, tenant);
  const sale = await paySale(app, tenant, account, 47, { type: 'reusable' });

  const first = await feed(tenant.authHeaders, tenant.workspaceId);
  const notification = first.notifications.find((item) => item.entityId === sale.paymentId);
  assert.ok(notification);
  assert.equal(first.unread, 1);
  assert.equal((await feed(member.headers, tenant.workspaceId)).unread, 1);

  await request(app).post(`/workspaces/${tenant.workspaceId}/notifications/read`)
    .set(tenant.authHeaders).send({ ids: [notification.id] }).expect(200);
  assert.equal((await feed(tenant.authHeaders, tenant.workspaceId)).unread, 0);
  assert.equal((await feed(member.headers, tenant.workspaceId)).unread, 1);

  await withTransaction((client) => recordPaymentOutcome(client, tenant.workspaceId, {
    providerTransactionId: sale.transId,
    status: 'approved',
    gross: 47,
    currency: 'EUR',
    linkReference: sale.link.referenceId,
    rawPayload: {},
  }));

  const afterRepeat = await feed(tenant.authHeaders, tenant.workspaceId);
  assert.equal(afterRepeat.unread, 0);
  assert.equal(afterRepeat.notifications.find((item) => item.id === notification.id)?.read, true);
  assert.equal((await pool.query(
    `SELECT count(*)::int AS count FROM notifications
      WHERE workspace_id=$1 AND event='payment.paid' AND entity_id=$2`,
    [tenant.workspaceId, sale.paymentId],
  )).rows[0].count, 1);

  const nextTransaction = newTransId();
  await postWebhook(app, await endpointFor(tenant.workspaceId), buildPaidPayload({
    reference: sale.link.referenceId, transId: nextTransaction, amount: 47,
  })).expect(200);
  assert.equal((await feed(tenant.authHeaders, tenant.workspaceId)).unread, 1);
  assert.equal((await feed(member.headers, tenant.workspaceId)).unread, 2);

  await request(app).post(`/workspaces/${tenant.workspaceId}/notifications/read`)
    .set(tenant.authHeaders).send({}).expect(200);
  assert.equal((await feed(tenant.authHeaders, tenant.workspaceId)).unread, 0);
  assert.equal((await feed(member.headers, tenant.workspaceId)).unread, 2);
});
