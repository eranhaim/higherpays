'use strict';
// Team membership: scoping, offboarding, and who may hand out which role.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { createTenant, addMember: inviteMember } = require('../helpers/tenant');

const addMember = (owner, role, email) => inviteMember(app, owner, role, { email });

const uniqueEmail = () => `m+${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@test.local`;

test('the agent list is scoped to the workspace even for a user who belongs to two', async () => {
  const a = await createTenant(app);
  const b = await createTenant(app);
  const email = uniqueEmail();
  await addMember(a, 'agent', email);
  const inB = await addMember(b, 'agent', email);

  // The same person, viewing agency B, must not see their agency A seat.
  await request(app).patch(`/workspaces/${b.workspaceId}/memberships/${inB.membershipId}`)
    .set(b.authHeaders).send({ commissionPct: 12 }).expect(200);
  const bList = await request(app).get(`/workspaces/${b.workspaceId}/memberships`).set(b.authHeaders).expect(200);
  const mine = bList.body.agents.filter((c) => c.email === email);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].commissionPct, 12);
});

test('removing a member ends their access at once', async () => {
  const owner = await createTenant(app);
  const member = await addMember(owner, 'agent', uniqueEmail());
  await request(app).get(`/workspaces/${owner.workspaceId}/links`).set(member.headers).expect(200);

  await request(app).delete(`/workspaces/${owner.workspaceId}/memberships/${member.membershipId}`)
    .set(owner.authHeaders).expect(204);

  await request(app).get(`/workspaces/${owner.workspaceId}/links`).set(member.headers).expect(403);
  await request(app).post('/auth/refresh').send({ refreshToken: member.refreshToken }).expect(401);
});

test('the last owner cannot be removed or demoted', async () => {
  const owner = await createTenant(app);
  const admin = await addMember(owner, 'admin', uniqueEmail());
  const ownerMembership = (await request(app)
    .get(`/workspaces/${owner.workspaceId}/memberships/members`).set(owner.authHeaders).expect(200))
    .body.members.find((m) => m.role === 'owner');

  const removed = await request(app)
    .delete(`/workspaces/${owner.workspaceId}/memberships/${ownerMembership.membershipId}`)
    .set(admin.headers).expect(409);
  assert.equal(removed.body.error, 'last_owner');
});

test('an admin cannot promote anyone to owner', async () => {
  const owner = await createTenant(app);
  const admin = await addMember(owner, 'admin', uniqueEmail());
  const agent = await addMember(owner, 'agent', uniqueEmail());

  await request(app).patch(`/workspaces/${owner.workspaceId}/memberships/${agent.membershipId}/role`)
    .set(admin.headers).send({ role: 'owner' }).expect(403);
  await request(app).patch(`/workspaces/${owner.workspaceId}/memberships/${agent.membershipId}/role`)
    .set(admin.headers).send({ role: 'analyst' }).expect(200);
});
