'use strict';
// Authorization boundaries on role editing. The owner/admin split is the one
// permission (`settings.danger`) an admin must never be able to grant itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { createTenant } = require('../helpers/tenant');
const { PERMISSIONS } = require('../../src/auth/permissions');

// Invite + accept + login, returning auth headers for a member with `role`.
async function addMember(owner, role) {
  const email = `member+${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@test.local`;
  const invite = await request(app)
    .post(`/workspaces/${owner.workspaceId}/invites`)
    .set(owner.authHeaders)
    .send({ email, role })
    .expect(201);
  await request(app)
    .post(`/invites/${invite.body.inviteToken}/accept`)
    .send({ password: 'passwordtest', fullName: 'Member' })
    .expect(201);
  const login = await request(app).post('/auth/login').send({ email, password: 'passwordtest' }).expect(200);
  return {
    Authorization: `Bearer ${login.body.accessToken}`,
    'X-Workspace-Id': owner.workspaceId,
  };
}

test('an admin cannot rewrite the admin role to gain owner permissions', async () => {
  const owner = await createTenant(app);
  const admin = await addMember(owner, 'admin');

  await request(app)
    .patch(`/workspaces/${owner.workspaceId}/roles/admin`)
    .set(admin)
    .send({ permissions: PERMISSIONS })
    .expect(403);

  const roles = await request(app).get(`/workspaces/${owner.workspaceId}/roles`).set(admin).expect(200);
  const adminRole = roles.body.roles.find((r) => r.name === 'admin');
  assert.ok(!adminRole.permissions.includes('settings.danger'));
});

test('system roles are immutable even for the owner', async () => {
  const owner = await createTenant(app);
  const res = await request(app)
    .patch(`/workspaces/${owner.workspaceId}/roles/analyst`)
    .set(owner.authHeaders)
    .send({ permissions: ['commissions.manage'] })
    .expect(403);
  assert.equal(res.body.error, 'system_role_immutable');
});

test('a custom role cannot be granted a permission the caller does not hold', async () => {
  const owner = await createTenant(app);
  const admin = await addMember(owner, 'admin');

  const res = await request(app)
    .post(`/workspaces/${owner.workspaceId}/roles`)
    .set(admin)
    .send({ name: 'finance', permissions: ['payments.view', 'settings.danger'] })
    .expect(403);
  assert.equal(res.body.error, 'cannot_grant_unheld_permission');

  await request(app)
    .post(`/workspaces/${owner.workspaceId}/roles`)
    .set(admin)
    .send({ name: 'finance', permissions: ['payments.view', 'commissions.view'] })
    .expect(201);
});

test('settings.danger is owner-only regardless of the permission list', async () => {
  const owner = await createTenant(app);
  const admin = await addMember(owner, 'admin');
  const res = await request(app).get(`/workspaces/${owner.workspaceId}/permissions`).set(admin).expect(200);
  assert.equal(res.body.role, 'admin');
  assert.ok(!res.body.permissions.includes('settings.danger'));
});
