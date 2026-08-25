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

// The list is cursor-paginated, so filtering has to happen in SQL. A
// client-side filter would only ever search the first page and report "no
// matches" for anything older.
test('link filters are applied server-side, across pages', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const other = await createAccount(app, t, { stageName: 'Other' });

  const make = (accountId, amount) => request(app)
    .post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId, pricingMode: 'fixed', amount, currency: 'EUR' }).expect(201);

  for (const amount of [10, 50, 250, 900]) await make(account.id, amount);
  await make(other.id, 500);

  const list = async (qs) => (await request(app)
    .get(`/workspaces/${t.workspaceId}/links?${qs}`).set(t.authHeaders).expect(200)).body.items;

  // A page size of 1 forces the filter to be the thing doing the work, not luck
  // about which rows happen to be on the first page.
  const expensive = await list('min=200&limit=1');
  assert.equal(expensive.length, 1);
  assert.ok(Number(expensive[0].amount) >= 200);

  assert.deepEqual(
    (await list('min=40&max=300')).map((l) => Number(l.amount)).sort((a, b) => a - b),
    [50, 250],
    'both bounds are inclusive and applied together');

  assert.equal((await list(`accountId=${other.id}`)).length, 1, 'scoped to one account');
  assert.equal((await list('min=10000')).length, 0, 'a range nothing matches returns empty');

  const inverted = await request(app)
    .get(`/workspaces/${t.workspaceId}/links?min=100&max=10`).set(t.authHeaders);
  assert.equal(inverted.status, 400, 'an inverted range is refused, not silently empty');
});
