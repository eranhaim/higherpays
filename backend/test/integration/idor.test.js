'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { createTenant, createAccount } = require('../helpers/tenant');

test('a workspace user cannot substitute another workspace into object, export, archive, or settlement routes', async () => {
  const a = await createTenant(app);
  const b = await createTenant(app);
  const account = await createAccount(app, b);
  const link = (await request(app).post(`/workspaces/${b.workspaceId}/links`)
    .set(b.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 20, currency: 'EUR' })
    .expect(201)).body;

  // The attack: A's token, but B's id in BOTH the header and the path, so the
  // request is internally consistent and only the membership check can stop it.
  const spoofed = { Authorization: `Bearer ${a.accessToken}`, 'X-Workspace-Id': b.workspaceId };
  const foreignWorkspace = async (path) => {
    const res = await request(app).get(path).set(spoofed).expect(403);
    assert.equal(res.body.error, 'not_a_member');
  };
  await foreignWorkspace(`/workspaces/${b.workspaceId}/accounts`);
  await foreignWorkspace(`/workspaces/${b.workspaceId}/links`);
  await foreignWorkspace(`/workspaces/${b.workspaceId}/links/${link.id}`);
  await foreignWorkspace(`/workspaces/${b.workspaceId}/payments/export`);
  await foreignWorkspace(`/workspaces/${b.workspaceId}/customers/export`);
  await foreignWorkspace(`/workspaces/${b.workspaceId}/archive?type=links`);
  await foreignWorkspace(`/workspaces/${b.workspaceId}/settlements`);

  await request(app).post(`/workspaces/${b.workspaceId}/links`).set(spoofed)
    .send({ accountId: account.id, type: 'single_use', amount: 20, currency: 'EUR' })
    .expect(403);
  await request(app).patch(`/workspaces/${b.workspaceId}/accounts/${account.id}`).set(spoofed)
    .send({ revenueSplitPct: 1 })
    .expect(403);

  // A header that disagrees with the path is a malformed request, refused
  // before membership is ever looked up.
  const mismatch = await request(app).get(`/workspaces/${b.workspaceId}/accounts`)
    .set(a.authHeaders).expect(400);
  assert.equal(mismatch.body.message, 'workspace_mismatch');

  const platform = await request(app).get('/platform/workspaces').set(a.authHeaders).expect(403);
  assert.equal(platform.body.error, 'not_platform_admin');
});
