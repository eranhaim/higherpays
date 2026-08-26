'use strict';
// After the customer pays, the agent completes the details: who paid, and
// what for. That is what turns a paid single-use link into a done one.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount, createAgent, assignAgent, createCategory } = require('../helpers/tenant');
const { paySale } = require('../helpers/webhook');

test('a paid payment waits for details; completing it creates the customer and finishes the link', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const agent = await createAgent(app, t);
  await assignAgent(app, t, account.id, agent.id);
  const category = await createCategory(app, t, 'Subscription');
  const { link, paymentId } = await paySale(app, t, account, 40, { headers: agent.headers });

  const queue = (await request(app).get(`/workspaces/${t.workspaceId}/payments?needsDetails=true`).set(agent.headers).expect(200)).body.items;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].id, paymentId);
  assert.equal(queue[0].needsDetails, true);
  assert.equal(queue[0].platformFee, undefined, 'an agent does not see what the agency was charged');

  const done = (await request(app).patch(`/workspaces/${t.workspaceId}/payments/${paymentId}/details`).set(agent.headers)
    .send({ categoryId: category.id, customer: { name: 'Big Spender', telegramName: '@spender' } }).expect(200)).body;
  assert.equal(done.needsDetails, false);
  assert.equal(done.category, 'Subscription');
  assert.equal(done.customer, 'Big Spender');
  assert.equal(done.customerTelegram, '@spender');

  const linkAfter = (await pool.query('SELECT status FROM payment_links WHERE id = $1', [link.id])).rows[0];
  assert.equal(linkAfter.status, 'done');
  const customer = (await pool.query('SELECT total_spend FROM customers WHERE id = $1', [done.customerId])).rows[0];
  assert.equal(Number(customer.total_spend), 40);

  const still = (await request(app).get(`/workspaces/${t.workspaceId}/payments?needsDetails=true`).set(agent.headers).expect(200)).body.items;
  assert.equal(still.length, 0);
});

test('a retired category cannot be used; a payment that is not paid cannot be completed', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const category = await createCategory(app, t);
  await request(app).patch(`/workspaces/${t.workspaceId}/categories/${category.id}`).set(t.authHeaders).send({ active: false }).expect(200);
  const { paymentId } = await paySale(app, t, account, 40);
  await request(app).patch(`/workspaces/${t.workspaceId}/payments/${paymentId}/details`).set(t.authHeaders)
    .send({ categoryId: category.id, customer: { name: 'X' } }).expect(404);
});

test('an agent completes only their own payments; an admin any', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const mine = await createAgent(app, t);
  const other = await createAgent(app, t);
  await assignAgent(app, t, account.id, mine.id);
  await assignAgent(app, t, account.id, other.id);
  const category = await createCategory(app, t);
  const { paymentId } = await paySale(app, t, account, 40, { headers: mine.headers });

  await request(app).patch(`/workspaces/${t.workspaceId}/payments/${paymentId}/details`).set(other.headers)
    .send({ categoryId: category.id, customer: { name: 'X' } }).expect(404);
  await request(app).patch(`/workspaces/${t.workspaceId}/payments/${paymentId}/details`).set(t.authHeaders)
    .send({ categoryId: category.id, customer: { name: 'X' } }).expect(200);
});

test('an account owner sees their own payments and none of the fees', async () => {
  const t = await createTenant(app);
  const account = await createAccount(app, t);
  const otherAccount = await createAccount(app, t);
  await paySale(app, t, account, 40);
  await paySale(app, t, otherAccount, 99);
  const list = (await request(app).get(`/workspaces/${t.workspaceId}/payments`).set(account.ownerHeaders).expect(200)).body.items;
  assert.equal(list.length, 1);
  assert.equal(list[0].amount, 40);
  assert.equal(list[0].platformFee, undefined);
  const admin = (await request(app).get(`/workspaces/${t.workspaceId}/payments`).set(t.authHeaders).expect(200)).body.items;
  assert.equal(admin.length, 2);
  assert.ok(admin[0].platformFee > 0);
});
