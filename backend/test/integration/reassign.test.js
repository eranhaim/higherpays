'use strict';
// Reassigning a link moves everything already taken on it. The ledger is
// rewritten rather than adjusted, which is what makes the warning necessary.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount, createAgent, assignAgent } = require('../helpers/tenant');
const { paySale } = require('../helpers/webhook');

test('a reassigned link takes its past payments and their splits with it', async () => {
  const t = await createTenant(app);
  const from = await createAccount(app, t);
  const to = await createAccount(app, t);
  const { link, transId } = await paySale(app, t, from, 100);

  const impact = (await request(app).get(`/workspaces/${t.workspaceId}/links/${link.id}/impact`)
    .set(t.authHeaders).expect(200)).body;
  assert.equal(impact.payments, 1);
  assert.equal(impact.paidOut, 0);
  assert.equal(impact.amount, 100);

  const moved = (await request(app).patch(`/workspaces/${t.workspaceId}/links/${link.id}/attribution`)
    .set(t.authHeaders).send({ accountId: to.id }).expect(200)).body;
  assert.equal(moved.accountId, to.id);
  assert.equal(moved.moved, 1);
  assert.equal(moved.reposted, 1);

  const payment = (await pool.query(
    'SELECT account_id FROM payments WHERE payment_link_id = $1', [link.id])).rows[0];
  assert.equal(payment.account_id, to.id, 'the payment moved too');

  const entry = (await pool.query(
    `SELECT re.account_id FROM revenue_entries re JOIN transactions t ON t.id = re.transaction_id
      WHERE t.provider_transaction_id = $1 AND re.entry_type = 'sale'`, [transId])).rows[0];
  assert.equal(entry.account_id, to.id, 'the split was re-posted against the new creator');
});

test('an agent must be assigned to the creator the link now belongs to', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const other = await createAccount(app, t);
  const agent = await createAgent(app, t);
  await assignAgent(app, t, account.id, agent.id);
  const { link } = await paySale(app, t, account, 40);

  await request(app).patch(`/workspaces/${t.workspaceId}/links/${link.id}/attribution`)
    .set(t.authHeaders).send({ accountId: other.id, agentId: agent.id }).expect(400);
});

test('an analyst cannot reassign a link', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const { link } = await paySale(app, t, account, 40);
  const { addMember } = require('../helpers/tenant');
  const analyst = await addMember(app, t, 'analyst');

  await request(app).patch(`/workspaces/${t.workspaceId}/links/${link.id}/attribution`)
    .set(analyst.headers).send({ accountId: account.id }).expect(403);
});
