'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const {
  createTenant, createAccount, createAgent, addMember, getPlatformAdmin, tag,
} = require('../helpers/tenant');
const { verifyAccessToken } = require('../../src/auth/tokens');
const { ROLE_PERMISSIONS } = require('../../src/auth/permissions');

test('member permissions are direct, custom roles are disabled, and ownership transfers safely', async () => {
  const owner = await createTenant(app);
  const member = await addMember(app, owner, 'member', { email: `role-member+${tag()}@test.local` });

  await request(app)
    .post(`/workspaces/${owner.workspaceId}/roles`).set(owner.authHeaders)
    .send({ name: 'Retired', permissions: ['payments.view'] }).expect(410);
  await request(app)
    .patch(`/workspaces/${owner.workspaceId}/team/${member.userId}`).set(owner.authHeaders)
    .send({ permissions: ['payments.view'] }).expect(200);

  const agent = await createAgent(app, owner);
  await request(app)
    .patch(`/workspaces/${owner.workspaceId}/team/${agent.userId}`).set(owner.authHeaders)
    .send({ permissions: [...ROLE_PERMISSIONS.agent, 'data.view_all'] }).expect(200);

  await request(app)
    .post(`/workspaces/${owner.workspaceId}/team/owner-transfer`).set(owner.authHeaders)
    .send({ userId: member.userId }).expect(200);
  const roles = (await pool.query(
    'SELECT user_id, role, permissions FROM workspace_users WHERE workspace_id=$1 AND user_id=ANY($2)',
    [owner.workspaceId, [owner.userId, member.userId]])).rows;
  assert.equal(roles.find((row) => row.user_id === owner.userId).role, 'workspace_admin');
  assert.equal(roles.find((row) => row.user_id === member.userId).role, 'workspace_owner');
  assert.deepEqual(roles.find((row) => row.user_id === owner.userId).permissions, [...ROLE_PERMISSIONS.workspace_admin]);
});

test('impersonation is exact, workspace-scoped, non-refreshable, and dual-audited', async () => {
  const target = await createTenant(app);
  const other = await createTenant(app);
  const admin = await getPlatformAdmin(app);
  const member = await addMember(app, target, 'member');

  const started = (await request(app).post('/platform/impersonation/start').set(admin.headers)
    .send({ workspaceId: target.workspaceId, userId: target.userId }).expect(200)).body;
  const claims = verifyAccessToken(started.accessToken);
  assert.equal(claims.actor, admin.userId);
  assert.equal(claims.sub, target.userId);
  assert.ok(claims.jti);
  assert.ok(claims.exp - claims.iat <= 900);
  assert.equal(started.refreshToken, undefined);
  assert.equal((await pool.query(
    'SELECT count(*)::int AS count FROM impersonation_sessions WHERE jti=$1',
    [claims.jti])).rows[0].count, 1);

  const impersonated = {
    Authorization: `Bearer ${started.accessToken}`,
    'X-Workspace-Id': target.workspaceId,
  };
  await request(app).get(`/workspaces/${other.workspaceId}/team`)
    .set({ ...impersonated, 'X-Workspace-Id': other.workspaceId }).expect(403);
  await request(app).post('/platform/impersonation/start').set(impersonated)
    .send({ workspaceId: target.workspaceId, userId: target.userId }).expect(403);

  await request(app).patch(`/workspaces/${target.workspaceId}/team/${member.userId}`).set(impersonated)
    .send({ permissions: ['payments.view'] }).expect(200);
  const audit = (await pool.query(
    `SELECT actor_user_id, effective_user_id
       FROM audit_log
      WHERE workspace_id=$1 AND action='team.member.update'
      ORDER BY id DESC LIMIT 1`,
    [target.workspaceId])).rows[0];
  assert.equal(audit.actor_user_id, admin.userId);
  assert.equal(audit.effective_user_id, target.userId);

  const requestAudit = (await pool.query(
    `SELECT actor_user_id, effective_user_id, metadata
       FROM audit_log
      WHERE workspace_id=$1 AND action='platform.impersonation.request'
        AND metadata->>'path'=$2
      ORDER BY id DESC LIMIT 1`,
    [target.workspaceId, `/workspaces/${target.workspaceId}/team/${member.userId}`])).rows[0];
  assert.equal(requestAudit.actor_user_id, admin.userId);
  assert.equal(requestAudit.effective_user_id, target.userId);
  assert.equal(requestAudit.metadata.method, 'PATCH');

  await request(app).get('/auth/me').set(impersonated).expect(200);
  for (const endpoint of [
    ['post', '/auth/2fa/setup'],
    ['post', '/auth/2fa/enable'],
    ['post', '/auth/2fa/disable'],
    ['post', '/auth/2fa/recovery-codes'],
    ['get', '/auth/sessions'],
    ['delete', '/auth/sessions/00000000-0000-4000-8000-000000000000'],
    ['post', '/auth/sessions/revoke-others'],
  ]) {
    await request(app)[endpoint[0]](endpoint[1]).set(impersonated).send({}).expect(403);
  }

  await request(app).post('/platform/impersonation/stop').set(impersonated).expect(204);
  await request(app).get(`/workspaces/${target.workspaceId}/team`).set(impersonated).expect(401);
  await request(app).post('/platform/impersonation/stop').set(impersonated).expect(401);
});

test('platform owner recovery appoints only an active plain member when no owner exists', async () => {
  const tenant = await createTenant(app);
  const admin = await getPlatformAdmin(app);
  const member = await addMember(app, tenant, 'member');
  const agent = await createAgent(app, tenant);
  const account = await createAccount(app, tenant);
  const path = `/platform/workspaces/${tenant.workspaceId}/owner-recovery`;

  await request(app).post(path).set(admin.headers)
    .send({ userId: member.userId }).expect(409);
  await pool.query(
    "UPDATE workspace_users SET role='workspace_admin' WHERE workspace_id=$1 AND role='workspace_owner'",
    [tenant.workspaceId]);

  await request(app).post(path).set(admin.headers)
    .send({ userId: agent.userId }).expect(409);
  await request(app).post(path).set(admin.headers)
    .send({ userId: account.ownerUserId }).expect(409);
  await request(app).post(path).set(admin.headers)
    .send({ userId: admin.userId }).expect(409);

  const recovered = (await request(app).post(path).set(admin.headers)
    .send({ userId: member.userId }).expect(200)).body;
  assert.equal(recovered.ownerUserId, member.userId);
  const owner = (await pool.query(
    "SELECT user_id FROM workspace_users WHERE workspace_id=$1 AND role='workspace_owner'",
    [tenant.workspaceId])).rows[0];
  assert.equal(owner.user_id, member.userId);
  const action = (await pool.query(
    `SELECT actor_user_id, entity_id FROM audit_log
      WHERE workspace_id=$1 AND action='platform.workspace.owner_recovery'
      ORDER BY id DESC LIMIT 1`,
    [tenant.workspaceId])).rows[0];
  assert.equal(action.actor_user_id, admin.userId);
  assert.equal(action.entity_id, member.userId);
});

test('an agent with explicit full workspace access stays workspace-scoped', async () => {
  const tenant = await createTenant(app);
  const other = await createTenant(app);
  const agent = await createAgent(app, tenant);
  await request(app)
    .patch(`/workspaces/${tenant.workspaceId}/team/${agent.userId}`).set(tenant.authHeaders)
    .send({ permissions: [...ROLE_PERMISSIONS.workspace_admin] }).expect(200);

  await request(app).get(`/workspaces/${tenant.workspaceId}/accounts`).set(agent.headers).expect(200);
  await request(app).get(`/workspaces/${tenant.workspaceId}/archive`).set(agent.headers).expect(200);
  await request(app).post(`/workspaces/${tenant.workspaceId}/roles`).set(agent.headers)
    .send({ name: 'Administrator copy' }).expect(410);
  await request(app).patch(`/workspaces/${tenant.workspaceId}`)
    .set(agent.headers).send({ accountLabel: 'Creator' }).expect(200);
  await request(app).patch(`/workspaces/${tenant.workspaceId}`)
    .set(agent.headers).send({ merchantId: 'attacker-merchant' }).expect(403);
  await request(app).get(`/workspaces/${other.workspaceId}/accounts`)
    .set({ ...agent.headers, 'X-Workspace-Id': other.workspaceId }).expect(403);
  await request(app).get('/platform/overview').set(agent.headers).expect(403);
});

test('platform admin promotion preserves existing roles, rejects profiles, and demotion removes only granted seats', async () => {
  const tenant = await createTenant(app);
  const admin = await getPlatformAdmin(app);
  const member = await addMember(app, tenant, 'member');
  const agent = await createAgent(app, tenant);
  const setPlatformAdmin = (userId, isPlatformAdmin) => request(app)
    .patch(`/platform/users/${userId}/platform-admin`)
    .set(admin.headers)
    .send({ isPlatformAdmin });

  const profilePromotion = await setPlatformAdmin(agent.userId, true).expect(409);
  assert.equal(profilePromotion.body.error, 'profile_user_cannot_be_platform_admin');

  await setPlatformAdmin(member.userId, true).expect(200);
  let seat = (await pool.query(
    `SELECT role, platform_granted
       FROM workspace_users
      WHERE workspace_id=$1 AND user_id=$2`,
    [tenant.workspaceId, member.userId])).rows[0];
  assert.equal(seat.role, 'member');
  assert.equal(seat.platform_granted, false);
  await setPlatformAdmin(member.userId, false).expect(200);
  seat = (await pool.query(
    'SELECT role FROM workspace_users WHERE workspace_id=$1 AND user_id=$2',
    [tenant.workspaceId, member.userId])).rows[0];
  assert.equal(seat.role, 'member');

  await setPlatformAdmin(tenant.userId, true).expect(200);
  assert.equal((await pool.query(
    'SELECT role FROM workspace_users WHERE workspace_id=$1 AND user_id=$2',
    [tenant.workspaceId, tenant.userId])).rows[0].role, 'workspace_owner');
  await setPlatformAdmin(tenant.userId, false).expect(200);
  assert.equal((await pool.query(
    'SELECT role FROM workspace_users WHERE workspace_id=$1 AND user_id=$2',
    [tenant.workspaceId, tenant.userId])).rows[0].role, 'workspace_owner');

  const platformOnly = (await pool.query(
    `INSERT INTO users (email, full_name)
     VALUES ($1, 'Platform only') RETURNING id`,
    [`platform-only+${tag()}@test.local`])).rows[0];
  await setPlatformAdmin(platformOnly.id, true).expect(200);
  const granted = (await pool.query(
    `SELECT platform_granted
       FROM workspace_users
      WHERE workspace_id=$1 AND user_id=$2`,
    [tenant.workspaceId, platformOnly.id])).rows[0];
  assert.equal(granted.platform_granted, true);
  await setPlatformAdmin(platformOnly.id, false).expect(200);
  assert.equal((await pool.query(
    'SELECT count(*)::int AS count FROM workspace_users WHERE user_id=$1',
    [platformOnly.id])).rows[0].count, 0);
});

test('an agency owner cannot change the PSP merchant identity', async () => {
  const tenant = await createTenant(app);
  await request(app).patch(`/workspaces/${tenant.workspaceId}`)
    .set(tenant.authHeaders)
    .send({ merchantId: 'attacker-merchant' })
    .expect(403);
});
