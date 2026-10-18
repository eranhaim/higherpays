'use strict';
// Onboarding a new agency from the platform console.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { getPlatformAdmin, login, tag } = require('../helpers/tenant');

test('a platform admin can create an agency whose first admin signs in at once with a password', async () => {
  const platform = await getPlatformAdmin(app);
  const email = `first+${tag()}@test.local`;
  const res = await request(app).post('/platform/agencies').set(platform.headers).send({
    name: `No email ${tag()}`, adminEmail: email, adminPassword: 'FirstAdmin12345', currency: 'EUR',
    pspRatePct: 8, marginRatePct: 5,
  }).expect(201);
  const session = await login(app, email, 'FirstAdmin12345');
  const seat = (await pool.query(
    'SELECT role FROM workspace_users WHERE workspace_id=$1 AND user_id=$2', [res.body.workspaceId, session.userId])).rows[0];
  assert.equal(seat.role, 'workspace_owner');
  const invites = (await pool.query('SELECT count(*)::int AS c FROM invites WHERE workspace_id=$1', [res.body.workspaceId])).rows[0].c;
  assert.equal(invites, 0);
});

test('an agency admin password that is too weak is refused before anything is created', async () => {
  const platform = await getPlatformAdmin(app);
  const name = `Weak ${tag()}`;
  await request(app).post('/platform/agencies').set(platform.headers).send({
    name, adminEmail: `weak+${tag()}@test.local`, adminPassword: 'short', currency: 'EUR', pspRatePct: 8, marginRatePct: 5,
  }).expect(400);
  const created = (await pool.query('SELECT count(*)::int AS c FROM workspaces WHERE name=$1', [name])).rows[0].c;
  assert.equal(created, 0);
});
