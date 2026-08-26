'use strict';
// Users, roles, agents and accounts: one person is one thing per workspace,
// and a profile always has a login behind it.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount, createAgent, addMember, PASSWORD, tag } = require('../helpers/tenant');

test('creating an agent creates the login, the access and the profile in one go', async () => {
  const t = await createTenant(app);
  const agent = await createAgent(app, t, { commissionPct: 12 });
  assert.equal(agent.commissionPct, 12);

  const team = (await request(app).get(`/workspaces/${t.workspaceId}/team`).set(t.authHeaders).expect(200)).body.members;
  const row = team.find((m) => m.email === agent.email);
  assert.equal(row.role, 'agent');
  assert.equal(row.agentId, agent.id);

  // The agent can sign in and sees the workspace as an agent.
  const me = (await request(app).get(`/workspaces/${t.workspaceId}/permissions`).set(agent.headers).expect(200)).body;
  assert.equal(me.role, 'agent');
  assert.ok(me.permissions.includes('links.create'));
  assert.ok(!me.permissions.includes('data.view_all'));
});

test('an account owner cannot also be made an agent in the same workspace', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const res = await request(app).post(`/workspaces/${t.workspaceId}/agents`).set(t.authHeaders)
    .send({ email: account.ownerEmail, fullName: 'Same Person', password: PASSWORD }).expect(400);
  assert.match(res.body.detail, /already a account_owner/);
});

test('a new login needs a password; an existing user is attached without one', async () => {
  const t = await createTenant(app);
  const email = `nopw+${tag()}@test.local`;
  const res = await request(app).post(`/workspaces/${t.workspaceId}/agents`).set(t.authHeaders)
    .send({ email, fullName: 'No Password' }).expect(400);
  assert.deepEqual(res.body.fields, ['password']);

  // The same person can be an agent in two agencies with one login.
  const other = await createTenant(app);
  const first = await createAgent(app, t, { email: `twice+${tag()}@test.local` });
  await request(app).post(`/workspaces/${other.workspaceId}/agents`).set(other.authHeaders)
    .send({ email: first.email, fullName: 'Twice' }).expect(201);
  const users = (await pool.query('SELECT count(*)::int AS c FROM users WHERE email = $1', [first.email])).rows[0].c;
  assert.equal(users, 1);
});

test('the database refuses an agent profile for a user without the agent role', async () => {
  const t = await createTenant(app);
  const analyst = await addMember(app, t, 'analyst');
  await assert.rejects(
    () => pool.query('INSERT INTO agents (workspace_id, user_id) VALUES ($1,$2)', [t.workspaceId, analyst.userId]),
    /foreign key/);
});

test('an account cannot be assigned an agent from another workspace', async () => {
  const a = await createTenant(app);
  const b = await createTenant(app);
  const account = await createAccount(app, a);
  const foreignAgent = await createAgent(app, b);
  await request(app).post(`/workspaces/${a.workspaceId}/accounts/${account.id}/agents`).set(a.authHeaders)
    .send({ agentId: foreignAgent.id }).expect(404);
  await assert.rejects(
    () => pool.query('INSERT INTO account_agents (workspace_id, account_id, agent_id) VALUES ($1,$2,$3)', [a.workspaceId, account.id, foreignAgent.id]),
    /foreign key/);
});

test('suspending a member ends their access but keeps the profile; removal is refused while it exists', async () => {
  const t = await createTenant(app);
  const agent = await createAgent(app, t);
  await request(app).delete(`/workspaces/${t.workspaceId}/team/${agent.userId}`).set(t.authHeaders).expect(409);

  await request(app).patch(`/workspaces/${t.workspaceId}/team/${agent.userId}/status`).set(t.authHeaders).send({ status: 'suspended' }).expect(200);
  await request(app).get(`/workspaces/${t.workspaceId}/links`).set(agent.headers).expect(403);
  const still = (await pool.query('SELECT 1 FROM agents WHERE id = $1', [agent.id])).rowCount;
  assert.equal(still, 1);
});

test('the last admin cannot be suspended, and an analyst cannot manage the team', async () => {
  const t = await createTenant(app);
  const analyst = await addMember(app, t, 'analyst');
  await request(app).patch(`/workspaces/${t.workspaceId}/team/${t.userId}/status`).set(analyst.headers).send({ status: 'suspended' }).expect(403);

  const admin2 = await addMember(app, t, 'workspace_admin');
  await request(app).patch(`/workspaces/${t.workspaceId}/team/${admin2.userId}/status`).set(t.authHeaders).send({ status: 'suspended' }).expect(200);
  // t is now the only active admin.
  await request(app).patch(`/workspaces/${t.workspaceId}/team/${t.userId}/status`).set(admin2.headers).expect(403);
  const res = await request(app).delete(`/workspaces/${t.workspaceId}/team/${t.userId}`)
    .set({ ...t.authHeaders, Authorization: admin2.headers.Authorization }).expect(403);
  assert.equal(res.body.error, 'not_a_member');
});
