'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { createTenant, createAccount } = require('../helpers/tenant');

test('list endpoints page with a cursor and never repeat or skip a row', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const made = [];
  for (let i = 0; i < 3; i++) {
    const res = await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
      .send({ accountId: account.id, pricingMode: 'fixed', amount: 10 + i, currency: 'EUR' }).expect(201);
    made.push(res.body.id);
  }

  const first = await request(app).get(`/workspaces/${t.workspaceId}/links?limit=2`).set(t.authHeaders).expect(200);
  assert.equal(first.body.items.length, 2);
  assert.ok(first.body.nextCursor, 'a further page exists');

  const second = await request(app)
    .get(`/workspaces/${t.workspaceId}/links?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
    .set(t.authHeaders).expect(200);
  assert.equal(second.body.items.length, 1);
  assert.equal(second.body.nextCursor, null);

  const seen = [...first.body.items, ...second.body.items].map((l) => l.id).sort();
  assert.deepEqual(seen, [...made].sort());
});

test('a malformed cursor is ignored rather than failing the request', async () => {
  const t = await createTenant(app);
  const res = await request(app).get(`/workspaces/${t.workspaceId}/transactions?cursor=garbage`).set(t.authHeaders).expect(200);
  assert.deepEqual(res.body, { items: [], nextCursor: null });
});
