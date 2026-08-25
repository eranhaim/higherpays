'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { withSystem } = require('../../src/db');
const { createTenant } = require('../helpers/tenant');

test('every SECURITY DEFINER function pins its search_path', async () => {
  const { rows } = await withSystem((c) => c.query(`
    SELECT p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
       AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) cfg WHERE cfg LIKE 'search_path=%')`));
  assert.deepEqual(rows.map((r) => r.proname), []);
});

test('replaying a rotated refresh token revokes the whole session', async () => {
  const t = await createTenant(app);
  const rotated = await request(app).post('/auth/refresh').send({ refreshToken: t.refreshToken }).expect(200);

  // The old token comes back — a copy is in play, so the new one dies too.
  const replay = await request(app).post('/auth/refresh').send({ refreshToken: t.refreshToken }).expect(401);
  assert.equal(replay.body.error, 'refresh_token_reused');
  await request(app).post('/auth/refresh').send({ refreshToken: rotated.body.refreshToken }).expect(401);
});

test('a user can list and revoke their own sessions', async () => {
  const t = await createTenant(app);
  const second = await request(app).post('/auth/login').send({ email: t.email, password: t.password }).expect(200);
  const auth = { Authorization: `Bearer ${t.accessToken}` };

  const list = await request(app).get('/auth/sessions').set(auth).expect(200);
  assert.equal(list.body.sessions.length, 2);

  const kept = await request(app).post('/auth/sessions/revoke-others').set(auth)
    .send({ refreshToken: t.refreshToken }).expect(200);
  assert.equal(kept.body.revoked, 1);
  await request(app).post('/auth/refresh').send({ refreshToken: second.body.refreshToken }).expect(401);
  await request(app).post('/auth/refresh').send({ refreshToken: t.refreshToken }).expect(200);
});

test('repeated failed sign-ins lock the account for a while', async () => {
  const t = await createTenant(app);
  for (let i = 0; i < 10; i++) {
    await request(app).post('/auth/login').send({ email: t.email, password: 'wrong' }).expect(401);
  }
  const locked = await request(app).post('/auth/login').send({ email: t.email, password: t.password }).expect(429);
  assert.equal(locked.body.error, 'rate_limited');
});
