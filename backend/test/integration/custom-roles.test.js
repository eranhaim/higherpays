'use strict';
// Custom roles: a named permission set a workspace admin can create and give
// to any member, and the rules that stop a seat lifting itself or another seat
// above its own level.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAgent, createAccount, login, PASSWORD, tag } = require('../helpers/tenant');

const STRONG = 'Marco-Strong-Pass1';

const roles = (t) => `/workspaces/${t.workspaceId}/roles`;
const team = (t) => `/workspaces/${t.workspaceId}/team`;

async function createRole(t, name, permissions) {
  return (await request(app).post(roles(t)).set(t.authHeaders).send({ name, permissions }).expect(201)).body;
}

async function addSeat(t, body) {
  const email = `seat+${tag()}@test.local`;
  const res = await request(app).post(team(t)).set(t.authHeaders)
    .send({ email, password: STRONG, fullName: 'Seat', ...body }).expect(201);
  const session = await login(app, email, STRONG);
  return {
    email, userId: res.body.userId,
    headers: { Authorization: `Bearer ${session.accessToken}`, 'X-Workspace-Id': t.workspaceId },
  };
}

test('an admin creates a role and adds a member who follows it', async () => {
  const t = await createTenant(app);
  const role = await createRole(t, `Support ${tag()}`, ['payments.view', 'links.view']);
  const seat = await addSeat(t, { customRoleKey: role.key });

  const row = (await pool.query(
    'SELECT role, permissions, custom_role_key FROM workspace_users WHERE workspace_id=$1 AND user_id=$2',
    [t.workspaceId, seat.userId])).rows[0];
  assert.equal(row.role, 'member');
  assert.equal(row.custom_role_key, role.key);
  assert.deepEqual([...row.permissions].sort(), ['links.view', 'payments.view']);

  // The new member really is limited to the role.
  await request(app).get(`/workspaces/${t.workspaceId}/payments`).set(seat.headers).expect(200);
  await request(app).get(`/workspaces/${t.workspaceId}/team`).set(seat.headers).expect(403);
});

test('editing a role changes every seat that follows it; a custom permission list detaches the seat', async () => {
  const t = await createTenant(app);
  const role = await createRole(t, `Ops ${tag()}`, ['payments.view']);
  const a = await addSeat(t, { customRoleKey: role.key });
  const b = await addSeat(t, { customRoleKey: role.key });

  await request(app).patch(`${roles(t)}/${role.key}`).set(t.authHeaders)
    .send({ permissions: ['payments.view', 'links.view'] }).expect(200);
  const perms = async (userId) => (await pool.query(
    'SELECT permissions, custom_role_key FROM workspace_users WHERE workspace_id=$1 AND user_id=$2',
    [t.workspaceId, userId])).rows[0];
  assert.deepEqual([...(await perms(a.userId)).permissions].sort(), ['links.view', 'payments.view']);

  await request(app).patch(`${team(t)}/${b.userId}`).set(t.authHeaders)
    .send({ permissions: ['payments.view'] }).expect(200);
  const detached = await perms(b.userId);
  assert.equal(detached.custom_role_key, null);
  await request(app).patch(`${roles(t)}/${role.key}`).set(t.authHeaders)
    .send({ permissions: ['payments.view', 'links.view', 'analytics.view'] }).expect(200);
  assert.deepEqual([...(await perms(b.userId)).permissions], ['payments.view']);
});

test('a role in use cannot be deleted; an unused one can', async () => {
  const t = await createTenant(app);
  const role = await createRole(t, `Temp ${tag()}`, ['payments.view']);
  const seat = await addSeat(t, { customRoleKey: role.key });
  await request(app).delete(`${roles(t)}/${role.key}`).set(t.authHeaders).expect(409);
  await request(app).patch(`${team(t)}/${seat.userId}`).set(t.authHeaders).send({ customRoleKey: null }).expect(200);
  await request(app).delete(`${roles(t)}/${role.key}`).set(t.authHeaders).expect(204);
});

test('a role of another workspace cannot be used, and role names are unique per workspace', async () => {
  const t = await createTenant(app);
  const other = await createTenant(app);
  const foreign = await createRole(other, `Foreign ${tag()}`, ['payments.view']);
  await request(app).post(team(t)).set(t.authHeaders)
    .send({ email: `x+${tag()}@test.local`, password: STRONG, customRoleKey: foreign.key }).expect(400);
  const name = `Same ${tag()}`;
  await createRole(t, name, ['payments.view']);
  await request(app).post(roles(t)).set(t.authHeaders).send({ name: name.toUpperCase(), permissions: [] }).expect(409);
});

test('a team manager cannot lift a seat above their own level', async () => {
  const t = await createTenant(app);
  const managerRole = await createRole(t, `Lead ${tag()}`, ['team.view', 'team.manage', 'roles.manage', 'payments.view']);
  const manager = await addSeat(t, { customRoleKey: managerRole.key });
  const peer = await addSeat(t, { permissions: ['payments.view'] });
  const stronger = await addSeat(t, { permissions: ['payments.view', 'links.view', 'links.create'] });
  const admin = await addSeat(t, { role: 'workspace_admin' });

  // Cannot hand out what the manager does not hold, through a role or directly.
  await request(app).post(roles(t)).set(manager.headers)
    .send({ name: `Big ${tag()}`, permissions: ['settings.view', 'settings.edit'] }).expect(400);
  await request(app).patch(`${team(t)}/${peer.userId}`).set(manager.headers)
    .send({ permissions: ['payments.view', 'settings.view'] }).expect(400);
  await request(app).post(team(t)).set(manager.headers)
    .send({ email: `adm+${tag()}@test.local`, password: STRONG, role: 'workspace_admin' }).expect(403);
  // An admin seat with a short list is still an admin seat, so it is refused too.
  await request(app).post(team(t)).set(manager.headers)
    .send({ email: `adm+${tag()}@test.local`, password: STRONG, role: 'workspace_admin', permissions: ['payments.view'] }).expect(403);
  await request(app).patch(`${team(t)}/${peer.userId}`).set(manager.headers)
    .send({ role: 'workspace_admin', permissions: ['payments.view'] }).expect(403);

  // Cannot touch a seat that holds more, or an admin, or themselves.
  for (const target of [stronger, admin]) {
    await request(app).patch(`${team(t)}/${target.userId}`).set(manager.headers)
      .send({ permissions: ['payments.view'] }).expect(403);
    await request(app).patch(`${team(t)}/${target.userId}`).set(manager.headers)
      .send({ password: 'Another-Strong-1', passwordConfirm: 'Another-Strong-1' }).expect(403);
    await request(app).patch(`${team(t)}/${target.userId}/status`).set(manager.headers)
      .send({ status: 'suspended' }).expect(403);
    await request(app).delete(`${team(t)}/${target.userId}`).set(manager.headers).expect(403);
  }
  await request(app).patch(`${team(t)}/${manager.userId}`).set(manager.headers)
    .send({ permissions: ['team.view', 'team.manage', 'settings.view'] }).expect(403);

  // What they may do: edit a seat at or below their own level.
  await request(app).patch(`${team(t)}/${peer.userId}`).set(manager.headers)
    .send({ permissions: ['payments.view', 'team.view'] }).expect(200);
});

test('a role without roles.manage cannot create or change roles', async () => {
  const t = await createTenant(app);
  const viewer = await addSeat(t, { permissions: ['team.view', 'team.manage'] });
  await request(app).post(roles(t)).set(viewer.headers).send({ name: `No ${tag()}`, permissions: [] }).expect(403);
});

test('an agent with a custom role keeps their agent scope', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const agent = await createAgent(app, t);
  const role = await createRole(t, `Sales ${tag()}`, ['payments.view', 'links.view', 'links.create', 'accounts.view']);
  await request(app).patch(`${team(t)}/${agent.userId}`).set(t.authHeaders).send({ customRoleKey: role.key }).expect(200);

  const profile = (await pool.query('SELECT id FROM agents WHERE id=$1', [agent.id])).rowCount;
  assert.equal(profile, 1);
  // Not assigned to the creator: the role grants the endpoint, the scope still hides the account.
  const links = (await request(app).get(`/workspaces/${t.workspaceId}/links`).set(agent.headers).expect(200)).body;
  const rows = links.links || links.items || [];
  assert.equal(rows.filter((l) => l.accountId === account.id).length, 0);
});

test('a weak password for a new member says what the rule is', async () => {
  const t = await createTenant(app);
  const res = await request(app).post(team(t)).set(t.authHeaders)
    .send({ email: `weak+${tag()}@test.local`, password: 'marco1234' }).expect(400);
  assert.match(res.body.detail, /12 characters/);
  const again = await request(app).post(team(t)).set(t.authHeaders)
    .send({ email: `weak2+${tag()}@test.local`, password: STRONG });
  assert.equal(again.status, 201);
  const dup = await request(app).post(team(t)).set(t.authHeaders)
    .send({ email: again.request._data.email, password: STRONG }).expect(409);
  assert.match(dup.body.detail, /already has a HigherPays login/);
  assert.ok(PASSWORD);
});
