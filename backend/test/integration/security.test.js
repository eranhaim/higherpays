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

test('repeated failed sign-ins lock the account for a while', async () => {
  const t = await createTenant(app);
  for (let i = 0; i < 10; i++) {
    await request(app).post('/auth/login').send({ email: t.email, password: 'wrong' }).expect(401);
  }
  const locked = await request(app).post('/auth/login').send({ email: t.email, password: t.password }).expect(429);
  assert.equal(locked.body.error, 'rate_limited');
});
