'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, tag, PASSWORD } = require('../helpers/tenant');
const { hashPassword } = require('../../src/auth/passwords');
const { hashRefreshToken } = require('../../src/auth/tokens');
const { totp } = require('../../src/auth/totp');

test('POST /auth/login accepts correct credentials and lists the workspace with its labels', async () => {
  const t = await createTenant(app);
  const res = await request(app).post('/auth/login').send({ email: t.email, password: t.password }).expect(200);
  assert.ok(res.body.accessToken);
  assert.equal(res.body.user.isPlatformAdmin, false);
  const ws = res.body.workspaces.find((w) => w.id === t.workspaceId);
  assert.equal(ws.role, 'workspace_owner');
  assert.equal(ws.roleName, 'Owner');
  assert.deepEqual(ws.labels, { account: 'Creator', accounts: 'Creators', agent: 'Agent', agents: 'Agents' });
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

test('platform admins can bootstrap 2FA but cannot use platform routes before enabling it', async () => {
  const email = `platform-bootstrap+${tag()}@test.local`;
  const user = (await pool.query(
    `INSERT INTO users (email, full_name, password_hash, is_platform_admin)
     VALUES ($1, 'Bootstrap Admin', $2, true) RETURNING id`,
    [email, await hashPassword(PASSWORD)])).rows[0];
  const login = (await request(app).post('/auth/login').send({ email, password: PASSWORD }).expect(200)).body;
  const headers = { Authorization: `Bearer ${login.accessToken}` };
  const blocked = await request(app).get('/platform/overview').set(headers).expect(403);
  assert.equal(blocked.body.error, 'platform_two_factor_required');

  const setup = (await request(app).post('/auth/2fa/setup').set(headers).send({}).expect(200)).body;
  const enabled = (await request(app).post('/auth/2fa/enable').set(headers)
    .send({ code: totp(setup.secret) }).expect(200)).body;
  assert.equal(enabled.recoveryCodes.length, 10);
  headers.Authorization = `Bearer ${enabled.accessToken}`;
  await request(app).get('/platform/overview').set(headers).expect(200);
  assert.equal((await pool.query(
    'SELECT two_factor_enabled FROM users WHERE id = $1', [user.id])).rows[0].two_factor_enabled, true);
});

test('a recovery code signs in once and is then consumed', async () => {
  const t = await createTenant(app);
  const setup = (await request(app).post('/auth/2fa/setup').set(t.authHeaders).send({}).expect(200)).body;
  const enabled = (await request(app).post('/auth/2fa/enable').set(t.authHeaders)
    .send({ code: totp(setup.secret) }).expect(200)).body;
  const recoveryCode = enabled.recoveryCodes[0];

  const prompt = await request(app).post('/auth/login').send({ email: t.email, password: t.password }).expect(200);
  assert.equal(prompt.body.twoFactorRequired, true);
  const recovered = await request(app).post('/auth/login')
    .send({ email: t.email, password: t.password, totp: recoveryCode }).expect(200);
  assert.ok(recovered.body.accessToken);
  const reused = await request(app).post('/auth/login')
    .send({ email: t.email, password: t.password, totp: recoveryCode }).expect(200);
  assert.equal(reused.body.twoFactorRequired, true);
});

test('refresh rotation preserves the absolute limit and enforces inactivity expiry', async () => {
  const t = await createTenant(app);
  const first = (await pool.query(
    'SELECT absolute_expires_at FROM refresh_tokens WHERE token_hash = $1',
    [hashRefreshToken(t.refreshToken)])).rows[0];
  const rotated = (await request(app).post('/auth/refresh')
    .send({ refreshToken: t.refreshToken }).expect(200)).body;
  const next = (await pool.query(
    'SELECT absolute_expires_at FROM refresh_tokens WHERE token_hash = $1',
    [hashRefreshToken(rotated.refreshToken)])).rows[0];
  assert.equal(new Date(next.absolute_expires_at).getTime(), new Date(first.absolute_expires_at).getTime());

  await pool.query(
    "UPDATE refresh_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1",
    [hashRefreshToken(rotated.refreshToken)]);
  const expired = await request(app).post('/auth/refresh')
    .send({ refreshToken: rotated.refreshToken }).expect(401);
  assert.equal(expired.body.error, 'session_expired');
});
