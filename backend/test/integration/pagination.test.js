'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { createTenant, createAccount } = require('../helpers/tenant');

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
