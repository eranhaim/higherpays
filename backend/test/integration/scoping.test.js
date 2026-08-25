'use strict';
// Row-level scoping. Passing a permission gate decides WHICH ENDPOINT you may
// call; these tests cover WHICH ROWS come back — and that the answer follows the
// data.view_all permission rather than a role name, so a custom role cannot
// slip past it.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const {
  createTenant, createAccount, addMember, assignAgent, linkAccountUser,
} = require('../helpers/tenant');
const { paySale } = require('../helpers/webhook');

/** Owner + two accounts, an agent assigned to the first only. */
async function fixture() {
  const owner = await createTenant(app);
  const mine = await createAccount(app, owner, { stageName: 'Mine' });
  const theirs = await createAccount(app, owner, { stageName: 'Theirs' });
  const agent = await addMember(app, owner, 'agent');
  await assignAgent(app, owner, mine.id, agent.membershipId);
  return { owner, mine, theirs, agent };
}

test('an agent sees only the accounts they are assigned', async () => {
  const { agent, mine } = await fixture();
  const res = await request(app)
    .get(`/workspaces/${agent.headers['X-Workspace-Id']}/accounts`).set(agent.headers).expect(200);
  assert.deepEqual(res.body.accounts.map((a) => a.id), [mine.id]);
});

test('an agent gets 404 for an account they are not assigned', async () => {
  const { owner, agent, theirs } = await fixture();
  await request(app)
    .get(`/workspaces/${owner.workspaceId}/accounts/${theirs.id}`).set(agent.headers).expect(404);
  await request(app)
    .get(`/workspaces/${owner.workspaceId}/accounts/${theirs.id}`).set(owner.authHeaders).expect(200);
});

test("an agent cannot see an account's pay deal or KYC state", async () => {
  const { agent } = await fixture();
  const res = await request(app)
    .get(`/workspaces/${agent.headers['X-Workspace-Id']}/accounts`).set(agent.headers).expect(200);
  const row = res.body.accounts[0];
  for (const field of ['revenue_split_pct', 'revenue_model', 'salary', 'salary_increase_pct',
    'compliance_status', 'age_verified', 'agents_assigned']) {
    assert.equal(row[field], undefined, `${field} must not reach an agent`);
  }
  assert.ok(row.stage_name, 'but the account itself is still visible');
});

test('an agent cannot create a link for an unassigned account', async () => {
  const { owner, agent, theirs, mine } = await fixture();
  const denied = await request(app)
    .post(`/workspaces/${owner.workspaceId}/links`).set(agent.headers)
    .send({ accountId: theirs.id, pricingMode: 'fixed', amount: 10, currency: 'EUR' });
  assert.equal(denied.status, 404);
  assert.equal(denied.body.error, 'account_not_found',
    'same code as a nonexistent account, so this is not an existence oracle');

  await request(app)
    .post(`/workspaces/${owner.workspaceId}/links`).set(agent.headers)
    .send({ accountId: mine.id, pricingMode: 'fixed', amount: 10, currency: 'EUR' })
    .expect(201);
});

test('an agent sees only links they created', async () => {
  const { owner, agent, mine } = await fixture();
  await request(app).post(`/workspaces/${owner.workspaceId}/links`).set(owner.authHeaders)
    .send({ accountId: mine.id, pricingMode: 'fixed', amount: 25, currency: 'EUR' }).expect(201);
  const ownersLink = (await request(app)
    .get(`/workspaces/${owner.workspaceId}/links`).set(owner.authHeaders).expect(200)).body.items[0];

  const res = await request(app)
    .get(`/workspaces/${owner.workspaceId}/links`).set(agent.headers).expect(200);
  assert.equal(res.body.items.length, 0, 'the owner-created link is not the agent\'s');

  await request(app)
    .get(`/workspaces/${owner.workspaceId}/links/${ownersLink.id}`).set(agent.headers).expect(403);
});

test('an account sees its own analytics and none of the agency figures', async () => {
  const { owner, mine } = await fixture();
  const talent = await addMember(app, owner, 'account');
  await linkAccountUser(app, owner, mine.id, talent.userId);

  const res = await request(app)
    .get(`/workspaces/${owner.workspaceId}/analytics`).set(talent.headers).expect(200);
  assert.equal(res.body.scope, 'account');
  for (const field of ['agencyKeep', 'takeRatePct', 'platformFee', 'accountPayout', 'agentPayout']) {
    assert.equal(res.body.headline[field], undefined, `${field} must not reach an account`);
  }
  assert.equal(res.body.chargebacks.byBearer, undefined);
  assert.deepEqual(res.body.agents, []);
  assert.deepEqual(res.body.accounts, []);
  assert.ok(typeof res.body.headline.gross === 'number', 'but its own gross is there');
});

test('an owner still sees the agency figures', async () => {
  const { owner } = await fixture();
  const res = await request(app)
    .get(`/workspaces/${owner.workspaceId}/analytics`).set(owner.authHeaders).expect(200);
  assert.equal(res.body.scope, 'agency');
  assert.ok(typeof res.body.headline.agencyKeep === 'number');
  assert.ok(res.body.chargebacks.byBearer);
});

test('an analyst cannot read the fee breakdown; an admin can', async () => {
  const owner = await createTenant(app);
  const analyst = await addMember(app, owner, 'analyst');
  const admin = await addMember(app, owner, 'admin');

  await request(app).get(`/workspaces/${owner.workspaceId}/fees`).set(analyst.headers).expect(403);
  await request(app).get(`/workspaces/${owner.workspaceId}/fees`).set(admin.headers).expect(200);
  // but the analyst keeps "who do we owe"
  await request(app).get(`/workspaces/${owner.workspaceId}/payouts/breakdown`).set(analyst.headers).expect(200);
});

test('a payment notifies the people it concerns, not the whole workspace', async () => {
  const { owner, mine, agent } = await fixture();
  const other = await addMember(app, owner, 'agent');
  const talent = await addMember(app, owner, 'account');
  await linkAccountUser(app, owner, mine.id, talent.userId);

  // The agent sells for the account, so both are parties to this payment.
  await paySale(app, { workspaceId: owner.workspaceId, authHeaders: agent.headers }, mine, 40);

  const feed = async (headers) => (await request(app)
    .get(`/workspaces/${owner.workspaceId}/notifications`).set(headers).expect(200)).body;

  assert.equal((await feed(agent.headers)).notifications.length, 1, 'the selling agent is told');
  assert.equal((await feed(talent.headers)).notifications.length, 1, 'so is the account');
  assert.equal((await feed(other.headers)).notifications.length, 0, 'another agent is not');
  assert.ok((await feed(owner.authHeaders)).notifications.length >= 1, 'the owner sees the workspace feed');
});

test('a custom role with agent-equivalent permissions is scoped like an agent', async () => {
  const { owner, mine, theirs } = await fixture();
  await request(app).post(`/workspaces/${owner.workspaceId}/roles`).set(owner.authHeaders)
    .send({ name: 'senior_agent', permissions: ['accounts.view', 'links.view', 'links.create', 'analytics.view', 'payments.view', 'customers.view'] })
    .expect(201);
  const senior = await addMember(app, owner, 'senior_agent');
  await assignAgent(app, owner, mine.id, senior.membershipId);

  const res = await request(app)
    .get(`/workspaces/${owner.workspaceId}/accounts`).set(senior.headers).expect(200);
  assert.deepEqual(res.body.accounts.map((a) => a.id), [mine.id],
    'a role name the code has never heard of must still be scoped');
  assert.equal(res.body.accounts[0].revenue_split_pct, undefined);
  assert.ok(theirs.id);
});

test('an owner can add a second workspace to the same organization', async () => {
  const owner = await createTenant(app);

  const created = await request(app)
    .post('/workspaces').set(owner.authHeaders).send({ name: 'Second Brand' }).expect(201);
  assert.ok(created.body.id);
  assert.ok(created.body.webhookEndpointId, 'it gets its own webhook endpoint');

  const mine = (await request(app).get('/auth/me/workspaces')
    .set({ Authorization: owner.authHeaders.Authorization }).expect(200)).body.workspaces;
  assert.equal(mine.length, 2);
  assert.equal(new Set(mine.map((w) => w.organization)).size, 1, 'both under one organization');
  assert.ok(mine.every((w) => w.role === 'owner'));

  // The new workspace is a separate tenant boundary: it starts empty.
  const accounts = (await request(app).get(`/workspaces/${created.body.id}/accounts`)
    .set({ Authorization: owner.authHeaders.Authorization, 'X-Workspace-Id': created.body.id })
    .expect(200)).body.accounts;
  assert.deepEqual(accounts, []);
});

test('an analyst cannot add a workspace', async () => {
  const owner = await createTenant(app);
  const analyst = await addMember(app, owner, 'analyst');
  await request(app).post('/workspaces').set(analyst.headers).send({ name: 'Nope' }).expect(403);
});

test('a custom role granted data.view_all sees the whole workspace', async () => {
  const { owner, mine, theirs } = await fixture();
  await request(app).post(`/workspaces/${owner.workspaceId}/roles`).set(owner.authHeaders)
    .send({ name: 'auditor', permissions: ['accounts.view', 'analytics.view', 'payments.view', 'data.view_all'] })
    .expect(201);
  const auditor = await addMember(app, owner, 'auditor');

  const res = await request(app)
    .get(`/workspaces/${owner.workspaceId}/accounts`).set(auditor.headers).expect(200);
  const ids = res.body.accounts.map((a) => a.id).sort();
  assert.deepEqual(ids, [mine.id, theirs.id].sort(), 'the permission, not the role name, is the key');
});
