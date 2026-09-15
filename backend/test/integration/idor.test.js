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

  const foreignWorkspace = (path) => request(app).get(path).set(a.authHeaders).expect(403);
  await foreignWorkspace(`/workspaces/${b.workspaceId}/accounts`);
  await foreignWorkspace(`/workspaces/${b.workspaceId}/links`);
  await foreignWorkspace(`/workspaces/${b.workspaceId}/payments/export`);
  await foreignWorkspace(`/workspaces/${b.workspaceId}/customers/export`);
  await foreignWorkspace(`/workspaces/${b.workspaceId}/archive?type=links`);
  await foreignWorkspace(`/workspaces/${b.workspaceId}/settlements`);

  await request(app).get(`/workspaces/${b.workspaceId}/links/${link.id}`)
    .set({ ...a.authHeaders, 'X-Workspace-Id': b.workspaceId })
    .expect(403);

  const platform = await request(app).get('/platform/workspaces').set(a.authHeaders).expect(403);
  assert.equal(platform.body.error, 'not_platform_admin');
});
