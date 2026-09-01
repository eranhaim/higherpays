'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { createTenant, createAccount } = require('../helpers/tenant');
const { paySale } = require('../helpers/webhook');

test('list endpoints page with a cursor and never repeat or skip a row', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  for (let i = 0; i < 5; i++) {
    await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
      .send({ accountId: account.id, type: 'single_use', amount: 10 + i, currency: 'EUR' }).expect(201);
  }
  const seen = [];
  let cursor = null;
  do {
    const url = `/workspaces/${t.workspaceId}/links?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
    const page = (await request(app).get(url).set(t.authHeaders).expect(200)).body;
    seen.push(...page.items.map((l) => l.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5);
});

test('a malformed cursor is ignored rather than failing the request', async () => {
  const t = await createTenant(app);
  await request(app).get(`/workspaces/${t.workspaceId}/links?cursor=garbage`).set(t.authHeaders).expect(200);
});

// Sorting moves the cursor onto another column, which is where keyset
// pagination breaks if the cursor still carries a timestamp.
test('payments page correctly when sorted by amount', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const amounts = [40, 10, 30, 20];
  for (const amount of amounts) await paySale(app, t, account, amount);

  const walk = async (dir) => {
    const seen = [];
    let cursor = null;
    do {
      const url = `/workspaces/${t.workspaceId}/payments?limit=1&sort=amount&dir=${dir}${cursor ? `&cursor=${cursor}` : ''}`;
      const page = (await request(app).get(url).set(t.authHeaders).expect(200)).body;
      seen.push(...page.items.map((p) => ({ id: p.id, amount: p.amount })));
      cursor = page.nextCursor;
    } while (cursor);
    return seen;
  };

  const asc = await walk('asc');
  assert.deepEqual(asc.map((p) => p.amount), [10, 20, 30, 40]);
  assert.equal(new Set(asc.map((p) => p.id)).size, 4);

  const desc = await walk('desc');
  assert.deepEqual(desc.map((p) => p.amount), [40, 30, 20, 10]);
});

test('an unknown sort falls back to the default order rather than failing', async () => {
  const t = await createTenant(app);
  await request(app).get(`/workspaces/${t.workspaceId}/payments?sort=drop%20table&dir=sideways`)
    .set(t.authHeaders).expect(200);
});
