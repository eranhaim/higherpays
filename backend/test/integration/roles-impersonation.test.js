'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const {
  createTenant, createAgent, addMember, getPlatformAdmin, tag,
} = require('../helpers/tenant');
const { verifyAccessToken } = require('../../src/auth/tokens');

test('roles enforce dependencies, profile restrictions, and explicit owner transfer', async () => {
  const owner = await createTenant(app);
  const member = await addMember(app, owner, 'analyst', { email: `role-member+${tag()}@test.local` });

  const invalid = await request(app)
    .post(`/workspaces/${owner.workspaceId}/roles`).set(owner.authHeaders)
    .send({ name: 'Exporter', permissions: ['payments.export'] }).expect(400);
  assert.equal(invalid.body.error, 'permission_dependency_missing');

  const role = (await request(app)
    .post(`/workspaces/${owner.workspaceId}/roles`).set(owner.authHeaders)
    .send({ name: 'Payment reader', permissions: ['payments.view', 'data.view_all'] }).expect(201)).body;
  await request(app)
    .patch(`/workspaces/${owner.workspaceId}/team/${member.userId}/role`).set(owner.authHeaders)
    .send({ role: role.key }).expect(200);

  const agent = await createAgent(app, owner);
  const locked = await request(app)
    .patch(`/workspaces/${owner.workspaceId}/team/${agent.userId}/role`).set(owner.authHeaders)
    .send({ role: role.key }).expect(409);
  assert.equal(locked.body.error, 'profile_role_locked');

  await request(app)
    .post(`/workspaces/${owner.workspaceId}/team/owner-transfer`).set(owner.authHeaders)
    .send({ userId: member.userId }).expect(200);
  const roles = (await pool.query(
    'SELECT user_id, role FROM workspace_users WHERE workspace_id=$1 AND user_id=ANY($2)',
    [owner.workspaceId, [owner.userId, member.userId]])).rows;
  assert.equal(roles.find((row) => row.user_id === owner.userId).role, 'workspace_admin');
  assert.equal(roles.find((row) => row.user_id === member.userId).role, 'workspace_owner');
});

test('impersonation is exact, workspace-scoped, non-refreshable, and dual-audited', async () => {
  const target = await createTenant(app);
  const other = await createTenant(app);
  const admin = await getPlatformAdmin(app);

  const started = (await request(app).post('/platform/impersonation/start').set(admin.headers)
    .send({ workspaceId: target.workspaceId, userId: target.userId }).expect(200)).body;
  const claims = verifyAccessToken(started.accessToken);
  assert.equal(claims.actor, admin.userId);
  assert.equal(claims.sub, target.userId);
  assert.ok(claims.exp - claims.iat <= 900);
  assert.equal(started.refreshToken, undefined);

  const impersonated = {
    Authorization: `Bearer ${started.accessToken}`,
    'X-Workspace-Id': target.workspaceId,
  };
  await request(app).get(`/workspaces/${other.workspaceId}/team`)
    .set({ ...impersonated, 'X-Workspace-Id': other.workspaceId }).expect(403);
  await request(app).post('/platform/impersonation/start').set(impersonated)
    .send({ workspaceId: target.workspaceId, userId: target.userId }).expect(403);

  await request(app).post(`/workspaces/${target.workspaceId}/roles`).set(impersonated)
    .send({ name: `Audit ${tag()}`, permissions: ['team.view', 'data.view_all'] }).expect(201);
  const audit = (await pool.query(
    `SELECT actor_user_id, effective_user_id
       FROM audit_log
      WHERE workspace_id=$1 AND action='role.create'
      ORDER BY id DESC LIMIT 1`,
    [target.workspaceId])).rows[0];
  assert.equal(audit.actor_user_id, admin.userId);
  assert.equal(audit.effective_user_id, target.userId);

  await request(app).post('/platform/impersonation/stop').set(impersonated).expect(204);
});
