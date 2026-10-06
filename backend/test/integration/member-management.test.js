'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const {
  createTenant, createAccount, createAgent, assignAgent, inviteTokenFor, login, tag,
} = require('../helpers/tenant');
const { ROLE_PERMISSIONS } = require('../../src/auth/permissions');
const { paySale } = require('../helpers/webhook');

const PASSWORD = 'MemberPassword12';

function headers(session, workspaceId) {
  return { Authorization: `Bearer ${session.accessToken}`, 'X-Workspace-Id': workspaceId };
}

test('a member seat stores direct permissions and a pending invite keeps its snapshot', async () => {
  const tenant = await createTenant(app);
  const email = `member+${tag()}@test.local`;
  const permissions = ['payments.view', 'links.view'];

  const created = await request(app).post(`/workspaces/${tenant.workspaceId}/team`)
    .set(tenant.authHeaders)
    .send({ email, fullName: 'Direct Member', password: PASSWORD, role: 'member', permissions })
    .expect(201);
  assert.deepEqual(created.body.permissions, permissions);
  const stored = (await pool.query(
    'SELECT role, permissions FROM workspace_users WHERE workspace_id=$1 AND user_id=$2',
    [tenant.workspaceId, created.body.userId])).rows[0];
  assert.equal(stored.role, 'member');
  assert.deepEqual(stored.permissions, permissions);

  const invitedEmail = `invite+${tag()}@test.local`;
  await request(app).post(`/workspaces/${tenant.workspaceId}/invites`)
    .set(tenant.authHeaders).send({ email: invitedEmail, role: 'member' }).expect(201);
  await request(app).post(`/invites/${inviteTokenFor(invitedEmail)}/accept`)
    .send({ password: PASSWORD, fullName: 'Invited Member' }).expect(201);
  const invited = await login(app, invitedEmail, PASSWORD);
  const inviteSeat = (await pool.query(
    'SELECT role, permissions FROM workspace_users WHERE workspace_id=$1 AND user_id=$2',
    [tenant.workspaceId, invited.userId])).rows[0];
  assert.equal(inviteSeat.role, 'member');
  assert.deepEqual(inviteSeat.permissions, [...ROLE_PERMISSIONS.member]);
});

test('an owner can explicitly grant an agent workspace data visibility', async () => {
  const tenant = await createTenant(app);
  const first = await createAccount(app, tenant);
  const second = await createAccount(app, tenant);
  const agent = await createAgent(app, tenant);
  await assignAgent(app, tenant, first.id, agent.id);

  const before = (await request(app).get(`/workspaces/${tenant.workspaceId}/accounts`)
    .set(agent.headers).expect(200)).body.accounts;
  assert.equal(before.some((account) => account.id === second.id), false);

  await request(app).patch(`/workspaces/${tenant.workspaceId}/team/${agent.userId}`)
    .set(tenant.authHeaders)
    .send({ permissions: [...ROLE_PERMISSIONS.agent, 'data.view_all'] })
    .expect(200);

  const after = (await request(app).get(`/workspaces/${tenant.workspaceId}/accounts`)
    .set(agent.headers).expect(200)).body.accounts;
  assert.equal(after.some((account) => account.id === second.id), true);
});

test('member identity and password updates are auditable and revoke sessions', async () => {
  const tenant = await createTenant(app);
  const email = `member+${tag()}@test.local`;
  const created = (await request(app).post(`/workspaces/${tenant.workspaceId}/team`)
    .set(tenant.authHeaders)
    .send({
      email, fullName: 'Original Member', password: PASSWORD, role: 'member',
      permissions: [...ROLE_PERMISSIONS.member],
    }).expect(201)).body;
  const session = await login(app, email, PASSWORD);
  const nextEmail = `renamed+${tag()}@test.local`;

  await request(app).patch(`/workspaces/${tenant.workspaceId}/team/${created.userId}`)
    .set(tenant.authHeaders)
    .send({
      fullName: 'Renamed Member',
      email: nextEmail,
      password: 'ReplacementPassword12',
      passwordConfirm: 'ReplacementPassword12',
    }).expect(200);
  await request(app).post('/auth/refresh').send({ refreshToken: session.refreshToken }).expect(401);
  await request(app).post('/auth/login').send({ email, password: PASSWORD }).expect(401);
  await request(app).post('/auth/login').send({ email: nextEmail, password: 'ReplacementPassword12' }).expect(200);

  const audit = (await pool.query(
    `SELECT metadata FROM audit_log
      WHERE workspace_id=$1 AND action='team.member.update' AND entity_id=$2
      ORDER BY id DESC LIMIT 1`,
    [tenant.workspaceId, created.userId])).rows[0].metadata;
  assert.equal(audit.passwordSet, true);
  assert.equal(audit.before.email, email);
  assert.equal(audit.after.email, nextEmail);
  assert.equal(JSON.stringify(audit).includes('ReplacementPassword12'), false);
});

test('customer-paid sales include checkout surcharge and reversals', async () => {
  const tenant = await createTenant(app, { checkoutFee: 2 });
  const account = await createAccount(app, tenant);
  const agent = await createAgent(app, tenant);
  await assignAgent(app, tenant, account.id, agent.id);
  const sale = await paySale(app, tenant, account, 100, {
    headers: agent.headers,
    paidAmount: 102,
  });

  let team = (await request(app).get(`/workspaces/${tenant.workspaceId}/team`)
    .set(tenant.authHeaders).expect(200)).body.members;
  assert.equal(team.find((member) => member.userId === agent.userId).totalCustomerPaid, 102);
  assert.equal(team.find((member) => member.userId === account.ownerUserId).totalCustomerPaid, 102);

  await request(app).post(`/workspaces/${tenant.workspaceId}/payments/${sale.paymentId}/refund`)
    .set(tenant.authHeaders).expect(200);
  team = (await request(app).get(`/workspaces/${tenant.workspaceId}/team`)
    .set(tenant.authHeaders).expect(200)).body.members;
  assert.equal(team.find((member) => member.userId === agent.userId).totalCustomerPaid, 0);
});

test('the member list withholds sales and pay terms from a scoped seat', async () => {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  const agent = await createAgent(app, tenant);
  await assignAgent(app, tenant, account.id, agent.id);
  await paySale(app, tenant, account, 100, { headers: agent.headers });

  // team.view is a per-seat permission, so an agent can be granted the member
  // list without ever gaining workspace-wide or revenue visibility.
  await request(app).patch(`/workspaces/${tenant.workspaceId}/team/${agent.userId}`)
    .set(tenant.authHeaders)
    .send({ permissions: [...ROLE_PERMISSIONS.agent, 'team.view'] })
    .expect(200);

  const scoped = (await request(app).get(`/workspaces/${tenant.workspaceId}/team`)
    .set(agent.headers).expect(200)).body.members;
  assert.ok(scoped.length > 0);
  for (const member of scoped) {
    for (const field of [
      'totalCustomerPaid', 'assignedCount', 'isPlatformAdmin',
      'payModel', 'revenueSplitPct', 'salaryAmount', 'commissionPct',
    ]) {
      assert.equal(field in member, false, `${field} reached a scoped seat`);
    }
  }

  // The same request from the owner carries all of it, so the assertions above
  // are a gate and not an empty response.
  const full = (await request(app).get(`/workspaces/${tenant.workspaceId}/team`)
    .set(tenant.authHeaders).expect(200)).body.members;
  const creatorRow = full.find((member) => member.userId === account.ownerUserId);
  assert.equal(creatorRow.totalCustomerPaid, 100);
  assert.equal(creatorRow.payModel, 'share');
  assert.equal(typeof creatorRow.revenueSplitPct, 'number');
  const agentRow = full.find((member) => member.userId === agent.userId);
  assert.equal(typeof agentRow.commissionPct, 'number');
  assert.equal(agentRow.assignedCount, 1);
  assert.equal(agentRow.isPlatformAdmin, false);
});

test('owner and self-protection reject unsafe member edits', async () => {
  const tenant = await createTenant(app);
  const ownHeaders = headers(tenant, tenant.workspaceId);
  await request(app).patch(`/workspaces/${tenant.workspaceId}/team/${tenant.userId}`)
    .set(ownHeaders).send({ permissions: [] }).expect(403);
});
