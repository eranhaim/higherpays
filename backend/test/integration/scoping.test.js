'use strict';
// Which ROWS each role sees, as opposed to which endpoints it may call.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { createTenant, createAccount, createAgent, addMember, assignAgent } = require('../helpers/tenant');
const { paySale } = require('../helpers/webhook');

async function fixture() {
  const t = await createTenant(app);
  const mine = await createAccount(app, t, { name: 'Mine' });
  const other = await createAccount(app, t, { name: 'Other' });
  const agent = await createAgent(app, t);
  await assignAgent(app, t, mine.id, agent.id);
  return { t, mine, other, agent };
}

test('an agent sees only the accounts they are assigned, without the pay deal', async () => {
  const { t, mine, other, agent } = await fixture();
  const list = (await request(app).get(`/workspaces/${t.workspaceId}/accounts`).set(agent.headers).expect(200)).body.accounts;
  assert.deepEqual(list.map((a) => a.id), [mine.id]);
  assert.equal(list[0].revenueSplitPct, undefined);
  assert.equal(list[0].agentsAssigned, undefined);
  await request(app).get(`/workspaces/${t.workspaceId}/accounts/${other.id}`).set(agent.headers).expect(404);
  await request(app).get(`/workspaces/${t.workspaceId}/accounts/${mine.id}`).set(agent.headers).expect(200);
});

test('an agent cannot create a link for an unassigned account, and sees only links they created', async () => {
  const { t, mine, other, agent } = await fixture();
  await request(app).post(`/workspaces/${t.workspaceId}/links`).set(agent.headers)
    .send({ accountId: other.id, type: 'single_use', amount: 20, currency: 'EUR' }).expect(404);
  const own = (await request(app).post(`/workspaces/${t.workspaceId}/links`).set(agent.headers)
    .send({ accountId: mine.id, type: 'single_use', amount: 20, currency: 'EUR' }).expect(201)).body;
  await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: mine.id, type: 'single_use', amount: 30, currency: 'EUR' }).expect(201);
  const list = (await request(app).get(`/workspaces/${t.workspaceId}/links`).set(agent.headers).expect(200)).body.items;
  assert.deepEqual(list.map((l) => l.id), [own.id]);
  assert.equal(list[0].agentId, agent.id);
});

test('an account owner sees their own analytics and none of the agency figures; the admin sees them', async () => {
  const { t, mine, other, agent } = await fixture();
  await paySale(app, t, mine, 50, { headers: agent.headers });
  await paySale(app, t, other, 70);

  const own = (await request(app).get(`/workspaces/${t.workspaceId}/analytics`).set(mine.ownerHeaders).expect(200)).body;
  assert.equal(own.scope, 'account');
  assert.equal(own.headline.gross, 50);
  assert.equal(own.headline.agencyKeep, undefined);
  assert.deepEqual(own.agents, []);

  const admin = (await request(app).get(`/workspaces/${t.workspaceId}/analytics`).set(t.authHeaders).expect(200)).body;
  assert.equal(admin.scope, 'agency');
  assert.equal(admin.headline.gross, 120);
  assert.ok(admin.headline.agencyKeep > 0);
  assert.equal(admin.agents.length, 1);
});

test('an analyst reads across the workspace but cannot read the fee breakdown or change anything', async () => {
  const { t, mine } = await fixture();
  const analyst = await addMember(app, t, 'analyst');
  const list = (await request(app).get(`/workspaces/${t.workspaceId}/accounts`).set(analyst.headers).expect(200)).body.accounts;
  assert.equal(list.length, 2);
  assert.ok(list[0].revenueSplitPct !== undefined);
  await request(app).get(`/workspaces/${t.workspaceId}/fees`).set(analyst.headers).expect(403);
  await request(app).get(`/workspaces/${t.workspaceId}/fees`).set(t.authHeaders).expect(200);
  await request(app).patch(`/workspaces/${t.workspaceId}/accounts/${mine.id}`).set(analyst.headers).send({ name: 'X' }).expect(403);
});

test('a payment notifies the people it concerns, not the whole workspace', async () => {
  const { t, mine, other, agent } = await fixture();
  const otherAgent = await createAgent(app, t);
  await assignAgent(app, t, other.id, otherAgent.id);
  await paySale(app, t, mine, 50, { headers: agent.headers });

  const feedFor = async (headers) => (await request(app).get(`/workspaces/${t.workspaceId}/notifications`).set(headers).expect(200)).body.notifications;
  assert.equal((await feedFor(agent.headers)).length, 1);
  assert.equal((await feedFor(mine.ownerHeaders)).length, 1);
  assert.equal((await feedFor(otherAgent.headers)).length, 0);
  assert.equal((await feedFor(other.ownerHeaders)).length, 0);
  assert.equal((await feedFor(t.authHeaders)).length, 1);
});

test('agency A cannot see agency B, with either header combination', async () => {
  const a = await createTenant(app);
  const b = await createTenant(app);
  await createAccount(app, b, { name: 'B only' });
  const mine = (await request(app).get(`/workspaces/${a.workspaceId}/accounts`).set(a.authHeaders).expect(200)).body.accounts;
  assert.equal(mine.length, 0);
  await request(app).get(`/workspaces/${b.workspaceId}/accounts`)
    .set({ Authorization: a.authHeaders.Authorization, 'X-Workspace-Id': b.workspaceId }).expect(403);
});
