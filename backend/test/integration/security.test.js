'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, tag } = require('../helpers/tenant');

test('every SECURITY DEFINER function pins its search_path', async () => {
  const { rows } = await pool.query(`
    SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef`);
  assert.ok(rows.length >= 3, 'the revenue functions are SECURITY DEFINER');
  for (const r of rows) {
    assert.ok((r.proconfig || []).some((c) => c.startsWith('search_path=')), `${r.proname} pins search_path`);
  }
});

test('the schema in the database matches the entities file', async () => {
  const schema = require('../../src/schema/entities');
  const snake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  const tables = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map((r) => r.table_name);
  for (const key of Object.keys(schema)) {
    if (key === 'status') continue;
    const e = schema[key];
    assert.ok(tables.includes(e.table), `${e.table} exists`);
    const cols = (await pool.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [e.table])).rows.map((r) => r.column_name);
    for (const f of Object.keys(e.fields)) assert.ok(cols.includes(snake(f)), `${e.table}.${snake(f)} exists`);
  }
});

test('the audit log is readable by the workspace and paginated', async () => {
  const t = await createTenant(app);
  const page1 = (await request(app).get(`/workspaces/${t.workspaceId}/audit?limit=1`).set(t.authHeaders).expect(200)).body;
  assert.equal(page1.items.length, 1);
  assert.ok(page1.items[0].action);
});

test('replaying a rotated refresh token revokes the whole session', async () => {
  const t = await createTenant(app);
  const first = await request(app).post('/auth/refresh').send({ refreshToken: t.refreshToken }).expect(200);
  await request(app).post('/auth/refresh').send({ refreshToken: t.refreshToken }).expect(401);
  await request(app).post('/auth/refresh').send({ refreshToken: first.body.refreshToken }).expect(401);
});

test('a user can list and revoke their own sessions', async () => {
  const t = await createTenant(app);
  await request(app).post('/auth/login').send({ email: t.email, password: t.password }).expect(200);
  const sessions = (await request(app).get('/auth/sessions').set(t.authHeaders).expect(200)).body.sessions;
  assert.ok(sessions.length >= 2);
  const other = sessions.find((s) => !s.isCurrent);
  await request(app).delete(`/auth/sessions/${other.id}`).set(t.authHeaders).expect(204);
  const after = (await request(app).get('/auth/sessions').set(t.authHeaders).expect(200)).body.sessions;
  assert.equal(after.length, sessions.length - 1);
});

test('repeated failed sign-ins lock the account for a while', async () => {
  const email = `locked+${tag()}@test.local`;
  for (let i = 0; i < 10; i++) await request(app).post('/auth/login').send({ email, password: 'wrong' }).expect(401);
  await request(app).post('/auth/login').send({ email, password: 'wrong' }).expect(429);
});
