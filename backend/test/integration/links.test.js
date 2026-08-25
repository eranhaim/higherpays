'use strict';
// Payment-link creation. Exercises the MantaPay checkout signing path via the
// real HTTP handler, but never hits the provider network (buildCheckout is
// pure). Regression coverage for the Wave-0 fix that was previously calling
// the adapter with QRMoney-shaped arguments.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { createTenant, createAccount } = require('../helpers/tenant');

test('POST /workspaces/:id/links creates a link with a signed MantaPay URL', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);

  const res = await request(app)
    .post(`/workspaces/${t.workspaceId}/links`)
    .set(t.authHeaders)
    .send({ accountId: account.id, pricingMode: 'fixed', amount: 25, currency: 'EUR' })
    .expect(201);

  assert.equal(res.body.pricing_mode, 'fixed');
  assert.equal(Number(res.body.amount), 25);
  assert.match(res.body.url, /^https:\/\/uiservices\.mantapay\.biz\//);
  assert.match(res.body.url, /signature=[^&]+$/);
  assert.match(res.body.reference_id, /^ord_/);
  assert.ok(res.body.expires_at);
});

test("POST /workspaces/:id/links rejects pricingMode='open' (MantaPay signs the amount)", async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);

  const res = await request(app)
    .post(`/workspaces/${t.workspaceId}/links`)
    .set(t.authHeaders)
    .send({ accountId: account.id, pricingMode: 'open', currency: 'EUR' })
    .expect(400);
  assert.equal(res.body.error, 'validation_failed');
  assert.deepEqual(res.body.fields, ['pricingMode']);
});

test('POST /workspaces/:id/links rejects amount below provider minimum', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);

  await request(app)
    .post(`/workspaces/${t.workspaceId}/links`)
    .set(t.authHeaders)
    .send({ accountId: account.id, pricingMode: 'fixed', amount: 1, currency: 'EUR' })
    .expect(400);
});

test('POST /workspaces/:id/links 404s an unknown account', async () => {
  const t = await createTenant(app);
  const fake = '00000000-0000-0000-0000-000000000001';

  await request(app)
    .post(`/workspaces/${t.workspaceId}/links`)
    .set(t.authHeaders)
    .send({ accountId: fake, pricingMode: 'fixed', amount: 25, currency: 'EUR' })
    .expect(404);
});
