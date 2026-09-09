'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount } = require('../helpers/tenant');
const { endpointFor, buildPaidPayload, postWebhook, newTransId } = require('../helpers/webhook');

test('a single-use link carries its HigherPays order in the public URL and has a deadline', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const res = await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 25, currency: 'EUR' }).expect(201);
  assert.equal(res.body.status, 'active');
  assert.match(res.body.referenceId, /^HP-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(new URL(res.body.checkoutUrl).pathname.endsWith(`/api/pay/${res.body.referenceId}`), true);
  const config = require('../../src/config');
  const minutes = (new Date(res.body.expiresAt) - Date.now()) / 60000;
  assert.ok(minutes > config.linkTtlMinutes - 1 && minutes <= config.linkTtlMinutes,
    `expires in ~${config.linkTtlMinutes}m, got ${minutes}`);
});

test('link attempts and summaries use all matching rows without replacing lifecycle status', async () => {
  const t = await createTenant(app, { checkoutFee: 2 });
  const account = await createAccount(app, t);
  const create = (type, amount) => request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type, amount, currency: 'EUR' }).expect(201).then((res) => res.body);
  const reusable = await create('reusable', 40);
  await create('single_use', 20);
  const endpoint = await endpointFor(t.workspaceId);
  const transactionIds = [newTransId(), newTransId()];
  for (const transId of transactionIds) {
    await postWebhook(app, endpoint, buildPaidPayload({
      reference: reusable.referenceId,
      transId,
      amount: 40,
    })).expect(200);
  }

  const list = (await request(app).get(`/workspaces/${t.workspaceId}/links?q=${transactionIds[1]}`)
    .set(t.authHeaders).expect(200)).body;
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].status, 'active');
  assert.equal(list.items[0].latestProviderAttempt.status, 'approved');
  assert.equal(list.items[0].latestProviderAttempt.replyCode, '000');
  assert.equal(list.items[0].latestProviderAttempt.replyDescription, 'Approved');
  assert.ok(transactionIds.includes(list.items[0].latestProviderAttempt.transactionId));

  const summary = (await request(app).get(`/workspaces/${t.workspaceId}/links/summary`)
    .set(t.authHeaders).expect(200)).body;
  assert.equal(summary.totalLinks, 2);
  assert.equal(summary.paidLinks, 1);
  assert.equal(summary.successfulPayments, 2);
  assert.equal(summary.grossSales, 80);
  assert.ok(summary.netAfterFees < summary.grossSales);

  const approved = (await request(app).get(`/workspaces/${t.workspaceId}/links/summary?providerStatus=approved`)
    .set(t.authHeaders).expect(200)).body;
  assert.equal(approved.totalLinks, 1);
});

test('a reusable link has no deadline', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const res = await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'reusable', amount: 25, currency: 'EUR' }).expect(201);
  assert.equal(res.body.expiresAt, null);
});

test('existing ord references remain valid public lookup keys and searchable orders', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const link = (await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 25, currency: 'EUR' }).expect(201)).body;
  const legacyReference = `ord_${Date.now().toString(16)}`;
  await request(app).post(`/workspaces/${t.workspaceId}/links/${link.id}/cancel`).set(t.authHeaders).expect(200);
  await pool.query('UPDATE payment_links SET reference_id = $2 WHERE id = $1', [link.id, legacyReference]);

  await request(app).get(`/pay/${legacyReference}`).expect(410);
  const found = (await request(app).get(`/workspaces/${t.workspaceId}/links?q=${legacyReference}`)
    .set(t.authHeaders).expect(200)).body.items;
  assert.equal(found.length, 1);
  assert.equal(found[0].referenceId, legacyReference);
});

test('type is required, the provider minimum is enforced, and an unknown account is 404', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, amount: 25, currency: 'EUR' }).expect(400);
  await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 1, currency: 'EUR' }).expect(400);
  await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: '00000000-0000-0000-0000-000000000000', type: 'single_use', amount: 25, currency: 'EUR' }).expect(404);
});

test('a paused account takes no new links', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  await request(app).patch(`/workspaces/${t.workspaceId}/accounts/${account.id}`).set(t.authHeaders).send({ status: 'paused' }).expect(200);
  await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 25, currency: 'EUR' }).expect(404);
});

test('an active link can be cancelled once; filters are applied server-side', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const make = (amount, type = 'single_use') => request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type, amount, currency: 'EUR' }).expect(201).then((r) => r.body);
  const a = await make(10);
  await make(20, 'reusable');
  await make(30);

  await request(app).post(`/workspaces/${t.workspaceId}/links/${a.id}/cancel`).set(t.authHeaders).expect(200);
  await request(app).post(`/workspaces/${t.workspaceId}/links/${a.id}/cancel`).set(t.authHeaders).expect(404);

  const active = (await request(app).get(`/workspaces/${t.workspaceId}/links?status=active`).set(t.authHeaders).expect(200)).body.items;
  assert.equal(active.length, 2);
  const reusable = (await request(app).get(`/workspaces/${t.workspaceId}/links?type=reusable`).set(t.authHeaders).expect(200)).body.items;
  assert.equal(reusable.length, 1);
  const big = (await request(app).get(`/workspaces/${t.workspaceId}/links?min=25`).set(t.authHeaders).expect(200)).body.items;
  assert.deepEqual(big.map((l) => l.amount), [30]);
});
