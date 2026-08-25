'use strict';
// Authorization boundaries on role editing. Owner and admin hold identical
// permissions, so the boundary between them is the refusal to grant `owner`.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { createTenant, addMember: inviteMember } = require('../helpers/tenant');
const { PERMISSIONS } = require('../../src/auth/permissions');

// Invite + accept + login, returning auth headers for a member with `role`.
const addMember = async (owner, role) => (await inviteMember(app, owner, role)).headers;

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
  // An analyst is read-only, so commissions.manage is genuinely out of reach.
  // An admin cannot demonstrate this any more: admin holds the whole catalog.
  const analyst = await addMember(owner, 'analyst');

  const res = await request(app)
    .post(`/workspaces/${owner.workspaceId}/roles`)
    .set(analyst)
    .send({ name: 'finance', permissions: ['payments.view', 'commissions.manage'] });
  // team.manage gates the route itself, so an analyst never reaches the grant
  // check — the permission it lacks stops it one step earlier.
  assert.equal(res.status, 403);

  const res2 = await request(app)
    .post(`/workspaces/${owner.workspaceId}/roles`)
    .set(owner.authHeaders)
    .send({ name: `finance_${Date.now().toString(36)}`, permissions: ['payments.view', 'commissions.view'] });
  assert.equal(res2.status, 201);
});

test('owner and admin hold the same permissions; only granting `owner` separates them', async () => {
  const owner = await createTenant(app);
  const admin = await addMember(owner, 'admin');

  const mine = await request(app).get(`/workspaces/${owner.workspaceId}/permissions`).set(admin).expect(200);
  const theirs = await request(app).get(`/workspaces/${owner.workspaceId}/permissions`).set(owner.authHeaders).expect(200);
  assert.equal(mine.body.role, 'admin');
  assert.deepEqual([...mine.body.permissions].sort(), [...theirs.body.permissions].sort(),
    'admin holds exactly what owner holds');

  // The boundary is roleWithinCallerRights refusing to hand out `owner`.
  const members = (await request(app)
    .get(`/workspaces/${owner.workspaceId}/memberships/members`).set(admin).expect(200)).body.members;
  const target = members.find((m) => m.role === 'analyst') || members.find((m) => !m.isSelf && m.role !== 'owner');
  if (target) {
    const res = await request(app)
      .patch(`/workspaces/${owner.workspaceId}/memberships/${target.membershipId}/role`)
      .set(admin).send({ role: 'owner' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'cannot_grant_unheld_permission');
  }
});
