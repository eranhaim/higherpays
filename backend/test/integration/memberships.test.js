'use strict';
// Team membership: scoping, offboarding, and who may hand out which role.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { createTenant } = require('../helpers/tenant');

async function addMember(owner, role, email) {
  const invite = await request(app)
    .post(`/workspaces/${owner.workspaceId}/invites`).set(owner.authHeaders)
    .send({ email, role }).expect(201);
  await request(app)
    .post(`/invites/${invite.body.inviteToken}/accept`)
    .send({ password: 'passwordtest', fullName: 'Member' }).expect(201);
  const login = await request(app).post('/auth/login').send({ email, password: 'passwordtest' }).expect(200);
  const membershipId = (await request(app)
    .get(`/workspaces/${owner.workspaceId}/memberships/members`).set(owner.authHeaders).expect(200))
    .body.members.find((m) => m.email === email).membershipId;
  return {
    membershipId,
    refreshToken: login.body.refreshToken,
    headers: { Authorization: `Bearer ${login.body.accessToken}`, 'X-Workspace-Id': owner.workspaceId },
  };
}

const uniqueEmail = () => `m+${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@test.local`;

test('the chatter list is scoped to the workspace even for a user who belongs to two', async () => {
  const a = await createTenant(app);
  const b = await createTenant(app);
  const email = uniqueEmail();
  await addMember(a, 'chatter', email);
  const inB = await addMember(b, 'chatter', email);

  // The same person, viewing agency B, must not see their agency A seat.
  await request(app).patch(`/workspaces/${b.workspaceId}/memberships/${inB.membershipId}`)
    .set(b.authHeaders).send({ commissionPct: 12 }).expect(200);
  const bList = await request(app).get(`/workspaces/${b.workspaceId}/memberships`).set(b.authHeaders).expect(200);
  const mine = bList.body.chatters.filter((c) => c.email === email);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].commissionPct, 12);
});

test('removing a member ends their access at once', async () => {
  const owner = await createTenant(app);
  const member = await addMember(owner, 'chatter', uniqueEmail());
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
  const chatter = await addMember(owner, 'chatter', uniqueEmail());

  await request(app).patch(`/workspaces/${owner.workspaceId}/memberships/${chatter.membershipId}/role`)
    .set(admin.headers).send({ role: 'owner' }).expect(403);
  await request(app).patch(`/workspaces/${owner.workspaceId}/memberships/${chatter.membershipId}/role`)
    .set(admin.headers).send({ role: 'analyst' }).expect(200);
});
