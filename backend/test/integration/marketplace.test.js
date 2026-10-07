'use strict';
// MARKETPLACE_WORKSPACE_ID is an environment value and has already been found
// pointing at a live agency. These tests hold the line that only a workspace
// designated in the database can receive marketplace carts.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount, createAgent, assignAgent, tag } = require('../helpers/tenant');
// The synthetic attribution only exists once a tenant has been built, so the
// integration's settings are applied here rather than through process.env.
const config = require('../../src/config');

const TOKEN = 'test-marketplace-service-token';
const authHeaders = { Authorization: `Bearer ${TOKEN}` };

function configureMarketplace(tenant, account, agent) {
  config.marketplaceIntegrationApiKeyHash = crypto.createHash('sha256').update(TOKEN).digest('hex');
  config.marketplaceWorkspaceId = tenant.workspaceId;
  config.marketplaceAccountId = account.id;
  config.marketplaceAgentId = agent.id;
  config.marketplaceWebhookUrl = 'https://marketplace.test/events';
  config.marketplaceWebhookSigningSecret = 'marketplace-event-secret';
}

async function createMarketplaceTenant() {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  const agent = await createAgent(app, tenant);
  await assignAgent(app, tenant, account.id, agent.id);
  return { tenant, account, agent };
}

const designate = (workspaceId, value) =>
  pool.query('UPDATE workspaces SET is_marketplace = $2 WHERE id = $1', [workspaceId, value]);

test('a cart is refused until its workspace is designated the marketplace', async () => {
  const { tenant, account, agent } = await createMarketplaceTenant();
  configureMarketplace(tenant, account, agent);
  const order = {
    marketplaceOrderId: `tel-${tag()}`,
    amountMinor: 2500,
    currency: 'EUR',
    returnUrl: 'https://marketplace.test/orders/done',
  };

  const refused = await request(app).post('/integrations/marketplace/orders')
    .set(authHeaders).send(order).expect(503);
  assert.equal(refused.body.error, 'marketplace_workspace_not_designated');
  const booked = (await pool.query(
    'SELECT count(*)::int AS rows FROM payment_links WHERE workspace_id = $1', [tenant.workspaceId])).rows[0];
  assert.equal(booked.rows, 0, 'a refused cart books nothing into the workspace');

  await designate(tenant.workspaceId, true);
  try {
    const created = await request(app).post('/integrations/marketplace/orders')
      .set(authHeaders).send(order).expect(201);
    assert.equal(created.body.marketplaceOrderId, order.marketplaceOrderId);
    assert.equal(created.body.amountMinor, 2500);
    assert.equal(created.body.status, 'pending');
  } finally {
    await designate(tenant.workspaceId, false);
  }
});

test('only one workspace can be the marketplace', async () => {
  const first = await createTenant(app);
  const second = await createTenant(app);
  await designate(first.workspaceId, true);
  try {
    await assert.rejects(
      () => designate(second.workspaceId, true),
      (err) => err.code === '23505',
    );
  } finally {
    await designate(first.workspaceId, false);
  }
});
