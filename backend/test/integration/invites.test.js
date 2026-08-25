'use strict';
// Invites are the second way a role can land on a person. They must be as hard
// to abuse as PATCH /memberships/:id/role, or they become the way around it.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { createTenant, addMember, inviteTokenFor } = require('../helpers/tenant');

const uniqueEmail = () => `inv+${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@test.local`;

test('an admin cannot invite anyone as owner', async () => {
  const owner = await createTenant(app);
  const admin = await addMember(app, owner, 'admin');

  const res = await request(app)
    .post(`/workspaces/${owner.workspaceId}/invites`).set(admin.headers)
    .send({ email: uniqueEmail(), role: 'owner' });

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'cannot_grant_unheld_permission');
});

test('an owner can still invite another owner', async () => {
  const owner = await createTenant(app);
  const res = await request(app)
    .post(`/workspaces/${owner.workspaceId}/invites`).set(owner.authHeaders)
    .send({ email: uniqueEmail(), role: 'owner' });
  assert.equal(res.status, 201);
});

test('the invite token is never returned to the caller', async () => {
  const owner = await createTenant(app);
  const email = uniqueEmail();
  const res = await request(app)
    .post(`/workspaces/${owner.workspaceId}/invites`).set(owner.authHeaders)
    .send({ email, role: 'analyst' }).expect(201);

  assert.equal(res.body.inviteToken, undefined);
  assert.ok(!JSON.stringify(res.body).includes(inviteTokenFor(email)));
});

test('an invite cannot re-role an existing active member', async () => {
  const owner = await createTenant(app);
  const analyst = await addMember(app, owner, 'analyst');

  // Invite the same person again as an agent — a downgrade attempt.
  await request(app)
    .post(`/workspaces/${owner.workspaceId}/invites`).set(owner.authHeaders)
    .send({ email: analyst.email, role: 'agent' }).expect(201);

  const accept = await request(app)
    .post(`/invites/${inviteTokenFor(analyst.email)}/accept`)
    .send({ password: 'passwordtest', fullName: 'Member' });

  assert.equal(accept.status, 409);
  assert.equal(accept.body.error, 'already_a_member');

  const members = (await request(app)
    .get(`/workspaces/${owner.workspaceId}/memberships/members`).set(owner.authHeaders).expect(200)).body.members;
  assert.equal(members.find((m) => m.email === analyst.email).role, 'analyst', 'role is unchanged');
});

test('an invite cannot demote the last owner', async () => {
  const owner = await createTenant(app);
  const admin = await addMember(app, owner, 'admin');

  // The admin cannot invite at owner level, so they try the reverse: invite the
  // existing owner at a lower role and accept it themselves.
  await request(app)
    .post(`/workspaces/${owner.workspaceId}/invites`).set(admin.headers)
    .send({ email: owner.email, role: 'analyst' }).expect(201);

  const accept = await request(app)
    .post(`/invites/${inviteTokenFor(owner.email)}/accept`)
    .send({ password: 'passwordtest', fullName: 'Owner' });
  assert.equal(accept.status, 409);

  const members = (await request(app)
    .get(`/workspaces/${owner.workspaceId}/memberships/members`).set(owner.authHeaders).expect(200)).body.members;
  assert.equal(members.find((m) => m.email === owner.email).role, 'owner', 'the owner still owns the workspace');
});

test('a consumed invite cannot be replayed', async () => {
  const owner = await createTenant(app);
  const email = uniqueEmail();
  await request(app)
    .post(`/workspaces/${owner.workspaceId}/invites`).set(owner.authHeaders)
    .send({ email, role: 'agent' }).expect(201);

  const token = inviteTokenFor(email);
  await request(app).post(`/invites/${token}/accept`)
    .send({ password: 'passwordtest', fullName: 'Member' }).expect(201);

  const replay = await request(app).post(`/invites/${token}/accept`)
    .send({ password: 'passwordtest', fullName: 'Member' });
  assert.equal(replay.status, 404);
});

test('an unknown role is rejected as a bad request, not a permission error', async () => {
  const owner = await createTenant(app);
  const res = await request(app)
    .post(`/workspaces/${owner.workspaceId}/invites`).set(owner.authHeaders)
    .send({ email: uniqueEmail(), role: 'sovereign' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_role');
});
