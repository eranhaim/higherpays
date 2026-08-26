'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { createTenant, createAccount } = require('../helpers/tenant');

test('a single-use link carries a signed MantaPay URL and a deadline', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const res = await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 25, currency: 'EUR' }).expect(201);
  assert.equal(res.body.status, 'active');
  assert.match(res.body.checkoutUrl, /^https:\/\//);
  assert.match(res.body.checkoutUrl, /signature=/i);
  const config = require('../../src/config');
  const minutes = (new Date(res.body.expiresAt) - Date.now()) / 60000;
  assert.ok(minutes > config.linkTtlMinutes - 1 && minutes <= config.linkTtlMinutes,
    `expires in ~${config.linkTtlMinutes}m, got ${minutes}`);
});

test('a reusable link has no deadline', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const res = await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'reusable', amount: 25, currency: 'EUR' }).expect(201);
  assert.equal(res.body.expiresAt, null);
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
