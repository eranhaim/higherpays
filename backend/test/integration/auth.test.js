'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { createTenant } = require('../helpers/tenant');

test('POST /auth/login accepts correct credentials and lists the workspace with its labels', async () => {
  const t = await createTenant(app);
  const res = await request(app).post('/auth/login').send({ email: t.email, password: t.password }).expect(200);
  assert.ok(res.body.accessToken);
  assert.equal(res.body.user.isPlatformAdmin, false);
  const ws = res.body.workspaces.find((w) => w.id === t.workspaceId);
  assert.equal(ws.role, 'workspace_admin');
  assert.deepEqual(ws.labels, { account: 'Account', accounts: 'Accounts', agent: 'Agent', agents: 'Agents' });
});

test('POST /auth/login rejects a wrong password with 401', async () => {
  const t = await createTenant(app);
  const res = await request(app).post('/auth/login').send({ email: t.email, password: 'nope-nope' }).expect(401);
  assert.equal(res.body.error, 'invalid_credentials');
});

test('POST /auth/refresh rotates the refresh token and returns a new access token', async () => {
  const t = await createTenant(app);
  const res = await request(app).post('/auth/refresh').send({ refreshToken: t.refreshToken }).expect(200);
  assert.ok(res.body.accessToken);
  assert.notEqual(res.body.refreshToken, t.refreshToken);
  await request(app).get('/auth/me').set('Authorization', `Bearer ${res.body.accessToken}`).expect(200);
});

test('GET /auth/me requires a bearer token', async () => {
  await request(app).get('/auth/me').expect(401);
});

test('a token opens only its own workspaces; a header that disagrees with the URL is refused', async () => {
  const a = await createTenant(app);
  const b = await createTenant(app);
  const res = await request(app).get(`/workspaces/${b.workspaceId}/accounts`).set(a.authHeaders).expect(400);
  assert.equal(res.body.error, 'validation_failed');
  await request(app).get(`/workspaces/${b.workspaceId}/accounts`)
    .set({ Authorization: a.authHeaders.Authorization, 'X-Workspace-Id': b.workspaceId }).expect(403);
  const { getPlatformAdmin } = require('../helpers/tenant');
  const admin = await getPlatformAdmin(app);
  await request(app).get(`/workspaces/${b.workspaceId}/accounts`)
    .set({ Authorization: admin.headers.Authorization, 'X-Workspace-Id': b.workspaceId }).expect(200);
});
