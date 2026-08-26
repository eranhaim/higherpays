'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { createTenant, addMember, inviteTokenFor, tag, PASSWORD } = require('../helpers/tenant');

test('only admins and analysts can be invited; agents and owners are created directly', async () => {
  const t = await createTenant(app);
  for (const role of ['agent', 'account_owner', 'owner']) {
    const res = await request(app).post(`/workspaces/${t.workspaceId}/invites`).set(t.authHeaders)
      .send({ email: `x+${tag()}@test.local`, role }).expect(400);
    assert.deepEqual(res.body.fields, ['role']);
  }
});

test('the invite token is never returned to the caller', async () => {
  const t = await createTenant(app);
  const res = await request(app).post(`/workspaces/${t.workspaceId}/invites`).set(t.authHeaders)
    .send({ email: `x+${tag()}@test.local`, role: 'analyst' }).expect(201);
  assert.equal(JSON.stringify(res.body).includes('token'), false);
});

test('an invite cannot re-role an existing member, and a consumed invite cannot be replayed', async () => {
  const t = await createTenant(app);
  const analyst = await addMember(app, t, 'analyst');
  await request(app).post(`/workspaces/${t.workspaceId}/invites`).set(t.authHeaders)
    .send({ email: analyst.email, role: 'workspace_admin' }).expect(201);
  const token = inviteTokenFor(analyst.email);
  await request(app).post(`/invites/${token}/accept`).send({}).expect(409);
  await request(app).post(`/invites/${token}/accept`).send({}).expect(404);
  const me = (await request(app).get(`/workspaces/${t.workspaceId}/permissions`).set(analyst.headers).expect(200)).body;
  assert.equal(me.role, 'analyst');
});

test('a pending invite can be withdrawn and its token stops working; an analyst cannot withdraw', async () => {
  const t = await createTenant(app);
  const email = `x+${tag()}@test.local`;
  const inv = (await request(app).post(`/workspaces/${t.workspaceId}/invites`).set(t.authHeaders)
    .send({ email, role: 'analyst' }).expect(201)).body;
  const token = inviteTokenFor(email);
  const analyst = await addMember(app, t, 'analyst');
  await request(app).delete(`/workspaces/${t.workspaceId}/invites/${inv.id}`).set(analyst.headers).expect(403);
  await request(app).delete(`/workspaces/${t.workspaceId}/invites/${inv.id}`).set(t.authHeaders).expect(204);
  await request(app).get(`/invites/${token}`).expect(404);
  await request(app).post(`/invites/${token}/accept`).send({ password: PASSWORD, fullName: 'Late' }).expect(404);
});
