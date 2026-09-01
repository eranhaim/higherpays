'use strict';
// How long an unpaid single-use link lives is the agency's own setting.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount } = require('../helpers/tenant');

test('a single-use link expires after the workspace setting, not the platform default', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);

  await request(app).patch(`/workspaces/${t.workspaceId}/link-limits`).set(t.authHeaders)
    .send({ linkTtlMinutes: 120 }).expect(200);

  const link = (await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 50, currency: 'EUR' }).expect(201)).body;

  const row = (await pool.query(
    'SELECT created_at, expires_at FROM payment_links WHERE id = $1', [link.id])).rows[0];
  const minutes = (new Date(row.expires_at) - new Date(row.created_at)) / 60000;
  assert.ok(Math.abs(minutes - 120) < 1, `expected about 120 minutes, got ${minutes}`);
});

test('a reusable link never expires, whatever the setting', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  await request(app).patch(`/workspaces/${t.workspaceId}/link-limits`).set(t.authHeaders)
    .send({ linkTtlMinutes: 60 }).expect(200);

  const link = (await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'reusable', amount: 50, currency: 'EUR' }).expect(201)).body;

  const row = (await pool.query('SELECT expires_at FROM payment_links WHERE id = $1', [link.id])).rows[0];
  assert.equal(row.expires_at, null);
});

test('the limits endpoint reports the platform default until one is set', async () => {
  const t = await createTenant(app);
  const limits = (await request(app).get(`/workspaces/${t.workspaceId}/link-limits`)
    .set(t.authHeaders).expect(200)).body;
  assert.equal(limits.linkTtlMinutes, 24 * 60);

  await request(app).patch(`/workspaces/${t.workspaceId}/link-limits`).set(t.authHeaders)
    .send({ linkTtlMinutes: 0 }).expect(400);
});
