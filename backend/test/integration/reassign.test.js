'use strict';
// Reassigning a link or a payment corrects the whole order: the link, every
// unarchived payment on it, and the ledger entries those payments posted.
// Reassigning the link but not its payments is what left one reference showing
// payments under two creators, and analytics disagreeing with the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount, createAgent, assignAgent } = require('../helpers/tenant');
const { paySale, postWebhook, buildPaidPayload, endpointFor, newTransId } = require('../helpers/webhook');

test('a reassigned link moves the payments already taken on it, and their splits', async () => {
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
  assert.equal(payment.account_id, to.id, 'the payment followed the link');

  const entry = (await pool.query(
    `SELECT re.account_id FROM revenue_entries re JOIN transactions t ON t.id = re.transaction_id
      WHERE t.provider_transaction_id = $1 AND re.entry_type = 'sale'`, [transId])).rows[0];
  assert.equal(entry.account_id, to.id, 'analytics reads the ledger, so the split moved too');

  const updatedLink = (await pool.query(
    'SELECT account_id FROM payment_links WHERE id = $1', [link.id])).rows[0];
  assert.equal(updatedLink.account_id, to.id);
});

// The superseded attempt moves with the order, but it is not money. Counting
// it made the dialog offer to move €840 of an order worth €420.
test('a superseded attempt is not counted in what a reassignment would move', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const endpoint = await endpointFor(t.workspaceId);
  const link = (await request(app).post(`/workspaces/${t.workspaceId}/links`).set(t.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 420, currency: 'EUR' }).expect(201)).body;

  const declinedId = newTransId();
  await postWebhook(app, endpoint, buildPaidPayload({
    reference: link.referenceId, transId: declinedId, amount: 420, replyCode: '5000',
  })).expect(200);
  const paid = (await postWebhook(app, endpoint, buildPaidPayload({
    reference: link.referenceId, transId: newTransId(), amount: 420,
  })).expect(200)).body;

  for (const path of [`links/${link.id}`, `payments/${paid.paymentId}`]) {
    const impact = (await request(app).get(`/workspaces/${t.workspaceId}/${path}/impact`)
      .set(t.authHeaders).expect(200)).body;
    assert.equal(impact.payments, 1, `${path}: one settled payment`);
    assert.equal(impact.amount, 420, `${path}: the order is worth 420, not 840`);
  }
});

test('a reversed sale cannot be reassigned through its link', async () => {
  const t = await createTenant(app);
  const from = await createAccount(app, t);
  const to = await createAccount(app, t);
  const { link, paymentId } = await paySale(app, t, from, 80);
  await request(app).post(`/workspaces/${t.workspaceId}/payments/${paymentId}/refund`).set(t.authHeaders).expect(200);

  await request(app).patch(`/workspaces/${t.workspaceId}/links/${link.id}/attribution`)
    .set(t.authHeaders).send({ accountId: to.id }).expect(400);
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

test('a member cannot reassign a link', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const { link } = await paySale(app, t, account, 40);
  const { addMember } = require('../helpers/tenant');
  const member = await addMember(app, t, 'member');

  await request(app).patch(`/workspaces/${t.workspaceId}/links/${link.id}/attribution`)
    .set(member.headers).send({ accountId: account.id }).expect(403);
});

test('a reassigned payment takes its split, and its single-use link, with it', async () => {
  const t = await createTenant(app);
  const from = await createAccount(app, t);
  const to = await createAccount(app, t);
  const { link, transId, paymentId } = await paySale(app, t, from, 100);

  const impact = (await request(app).get(`/workspaces/${t.workspaceId}/payments/${paymentId}/impact`)
    .set(t.authHeaders).expect(200)).body;
  assert.equal(impact.payments, 1);
  assert.equal(impact.paidOut, 0);
  assert.equal(impact.amount, 100);

  const moved = (await request(app).patch(`/workspaces/${t.workspaceId}/payments/${paymentId}/attribution`)
    .set(t.authHeaders).send({ accountId: to.id }).expect(200)).body;
  assert.equal(moved.accountId, to.id);
  assert.equal(moved.reposted, 1);

  const entry = (await pool.query(
    `SELECT re.account_id FROM revenue_entries re JOIN transactions t ON t.id = re.transaction_id
      WHERE t.provider_transaction_id = $1 AND re.entry_type = 'sale'`, [transId])).rows[0];
  assert.equal(entry.account_id, to.id, 'the split was re-posted against the new creator');

  const moved_link = (await pool.query('SELECT account_id FROM payment_links WHERE id = $1', [link.id])).rows[0];
  assert.equal(moved_link.account_id, to.id, 'the single-use link followed its one payment');
});

test('one payment on a reusable link moves without the link or its siblings', async () => {
  const t = await createTenant(app);
  const from = await createAccount(app, t);
  const to = await createAccount(app, t);
  const { link, paymentId } = await paySale(app, t, from, 60, { type: 'reusable' });
  const second = (await postWebhook(app, await endpointFor(t.workspaceId),
    buildPaidPayload({ reference: link.referenceId, transId: newTransId(), amount: 60 })).expect(200)).body;

  await request(app).patch(`/workspaces/${t.workspaceId}/payments/${paymentId}/attribution`)
    .set(t.authHeaders).send({ accountId: to.id }).expect(200);

  const stillThere = (await pool.query('SELECT account_id FROM payment_links WHERE id = $1', [link.id])).rows[0];
  assert.equal(stillThere.account_id, from.id, 'the reusable link stayed where it is');
  const sibling = (await pool.query('SELECT account_id FROM payments WHERE id = $1', [second.paymentId])).rows[0];
  assert.equal(sibling.account_id, from.id, 'the other payment on the link did not move');
});

test('a reversed sale cannot be reassigned as a payment', async () => {
  const t = await createTenant(app);
  const from = await createAccount(app, t);
  const to = await createAccount(app, t);
  const { link, paymentId } = await paySale(app, t, from, 80);
  await request(app).post(`/workspaces/${t.workspaceId}/payments/${paymentId}/refund`).set(t.authHeaders).expect(200);

  await request(app).patch(`/workspaces/${t.workspaceId}/payments/${paymentId}/attribution`)
    .set(t.authHeaders).send({ accountId: to.id }).expect(400);
});
