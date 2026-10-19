'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../helpers/setup');
const { createTenant, createAccount } = require('../helpers/tenant');

test('a currency that links already use can be switched off for new links', async () => {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  const currenciesUrl = `/workspaces/${tenant.workspaceId}/currencies`;
  const linksUrl = `/workspaces/${tenant.workspaceId}/links`;
  const newLink = (currency) => request(app).post(linksUrl).set(tenant.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 25, currency });

  await request(app).put(currenciesUrl).set(tenant.authHeaders)
    .send({ currencies: ['EUR', 'GBP'] }).expect(200);
  await newLink('GBP').expect(201);

  const off = (await request(app).put(currenciesUrl).set(tenant.authHeaders)
    .send({ currencies: ['EUR'] }).expect(200)).body;
  const gbp = off.currencies.find((item) => item.currency === 'GBP');
  assert.equal(gbp.enabled, false);
  assert.equal(gbp.inUse, true);

  await newLink('GBP').expect(400);
  await newLink('EUR').expect(201);

  await request(app).put(currenciesUrl).set(tenant.authHeaders)
    .send({ currencies: ['EUR', 'GBP'] }).expect(200);
  await newLink('GBP').expect(201);
});

test('the base currency cannot be switched off', async () => {
  const tenant = await createTenant(app);
  await request(app).put(`/workspaces/${tenant.workspaceId}/currencies`).set(tenant.authHeaders)
    .send({ currencies: ['GBP'] }).expect(409);
});

test('a switched-off currency nobody used is removed', async () => {
  const tenant = await createTenant(app);
  const url = `/workspaces/${tenant.workspaceId}/currencies`;
  await request(app).put(url).set(tenant.authHeaders).send({ currencies: ['EUR', 'USD'] }).expect(200);
  const after = (await request(app).put(url).set(tenant.authHeaders)
    .send({ currencies: ['EUR'] }).expect(200)).body;
  assert.deepEqual(after.currencies.map((item) => item.currency), ['EUR']);
});
