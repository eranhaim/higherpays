'use strict';
// One agency, several currencies. The rule under test everywhere here is that
// no figure is ever summed across currencies and no figure is ever converted.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount, getPlatformAdmin } = require('../helpers/tenant');
const { paySale } = require('../helpers/webhook');

/** Replace the agency's enabled set as a platform operator would. */
async function enable(tenant, currencies) {
  const admin = await getPlatformAdmin(app);
  return (await request(app)
    .put(`/platform/workspaces/${tenant.workspaceId}/currencies`)
    .set(admin.headers)
    .send({ currencies })
    .expect(200)).body.currencies;
}

const summary = (tenant, currency) => request(app)
  .get(`/workspaces/${tenant.workspaceId}/payments/summary${currency ? `?currency=${currency}` : ''}`)
  .set(tenant.authHeaders)
  .expect(200)
  .then((r) => r.body);

test('an agency is enabled for its base currency only, inheriting every amount', async () => {
  const tenant = await createTenant(app);
  const listed = (await request(app).get(`/workspaces/${tenant.workspaceId}/currencies`)
    .set(tenant.authHeaders).expect(200)).body.currencies;
  assert.equal(listed.length, 1);
  assert.deepEqual(
    { currency: listed[0].currency, isBase: listed[0].isBase, inherited: listed[0].checkoutFeeInherited },
    { currency: 'EUR', isBase: true, inherited: true });
  // Onboarding set a zero checkout fee on the rate card, and the base row
  // inherits it rather than carrying its own copy.
  assert.equal(listed[0].checkoutFee, 0);
});

test('totals are reported per currency and never summed across them', async () => {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  await enable(tenant, [{ currency: 'EUR' }, { currency: 'GBP', checkoutFee: 0 }]);

  await paySale(app, tenant, account, 100, { currency: 'EUR' });
  await paySale(app, tenant, account, 40, { currency: 'GBP' });

  const base = await summary(tenant);
  assert.equal(base.currency, 'EUR', 'no currency asked for means the base one');
  assert.equal(base.grossContent, 100);
  assert.equal(base.approvedPayments, 1);

  const gbp = await summary(tenant, 'GBP');
  assert.equal(gbp.currency, 'GBP');
  assert.equal(gbp.grossContent, 40);
  assert.equal(gbp.approvedPayments, 1);

  // The figure 140 must not be reachable: not by asking for both, and not by
  // asking for something nonsensical.
  for (const asked of ['ALL', 'all', 'EUR,GBP', 'XXX', 'JPY']) {
    const out = await summary(tenant, asked);
    assert.equal(out.currency, 'EUR', `"${asked}" fell back to the base currency`);
    assert.equal(out.grossContent, 100);
  }
});

test('a payments list shows only the currency its totals describe', async () => {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  await enable(tenant, [{ currency: 'EUR' }, { currency: 'USD', checkoutFee: 0 }]);
  await paySale(app, tenant, account, 100, { currency: 'EUR' });
  await paySale(app, tenant, account, 55, { currency: 'USD' });

  const usd = (await request(app).get(`/workspaces/${tenant.workspaceId}/payments?currency=USD`)
    .set(tenant.authHeaders).expect(200)).body;
  assert.equal(usd.currency, 'USD');
  assert.deepEqual(usd.items.map((p) => p.currency), ['USD']);
  assert.deepEqual(usd.items.map((p) => p.amount), [55]);

  const eur = (await request(app).get(`/workspaces/${tenant.workspaceId}/payments`)
    .set(tenant.authHeaders).expect(200)).body;
  assert.deepEqual(eur.items.map((p) => p.currency), ['EUR']);
});

test('a link and its payment are priced in a currency that cannot be changed', async () => {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  await enable(tenant, [{ currency: 'EUR' }, { currency: 'GBP', checkoutFee: 0 }]);
  const { link, paymentId } = await paySale(app, tenant, account, 30, { currency: 'GBP' });

  for (const [table, id] of [['payment_links', link.id], ['payments', paymentId]]) {
    await assert.rejects(
      pool.query(`UPDATE ${table} SET currency='EUR' WHERE id=$1`, [id]),
      (err) => err.message.includes('currency_immutable'),
      `${table}.currency must be immutable once money has moved`);
  }
  const txId = (await pool.query('SELECT id FROM transactions WHERE payment_id=$1', [paymentId])).rows[0].id;
  await assert.rejects(
    pool.query("UPDATE transactions SET currency='EUR' WHERE id=$1", [txId]),
    (err) => err.message.includes('currency_immutable'));
});

test('a link cannot be priced in a currency the agency is not enabled for', async () => {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  const rejected = await request(app).post(`/workspaces/${tenant.workspaceId}/links`)
    .set(tenant.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 25, currency: 'GBP' })
    .expect(400);
  assert.match(rejected.body.detail, /not enabled for this workspace/);
});

test('a currency MantaPay cannot charge is reportable but not chargeable', async () => {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  const listed = await enable(tenant, [{ currency: 'EUR' }, { currency: 'ILS', checkoutFee: 5 }]);
  const ils = listed.find((c) => c.currency === 'ILS');
  assert.equal(ils.checkoutSupported, false, 'MantaPay has no currency id for ILS');

  const rejected = await request(app).post(`/workspaces/${tenant.workspaceId}/links`)
    .set(tenant.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 100, currency: 'ILS' })
    .expect(400);
  assert.match(rejected.body.detail, /MantaPay cannot take a payment in ILS/);

  // Reporting in it still works: it answers with zero, not with another
  // currency's money.
  const out = await summary(tenant, 'ILS');
  assert.equal(out.currency, 'ILS');
  assert.equal(out.grossContent, 0);
});

test('per-currency amounts apply, and the base currency keeps the rate card', async () => {
  const tenant = await createTenant(app, { checkoutFee: 2 });
  const account = await createAccount(app, tenant);
  await enable(tenant, [
    { currency: 'EUR' },
    { currency: 'ILS', checkoutFee: 7.5, minLinkAmount: 50, maxLinkAmount: 900 },
  ]);

  const base = (await request(app).get(`/workspaces/${tenant.workspaceId}/link-limits`)
    .set(tenant.authHeaders).expect(200)).body;
  assert.equal(base.currency, 'EUR');
  const shekels = (await request(app).get(`/workspaces/${tenant.workspaceId}/link-limits?currency=ILS`)
    .set(tenant.authHeaders).expect(200)).body;
  assert.deepEqual(
    { currency: shekels.currency, min: shekels.minLinkAmount, max: shekels.maxLinkAmount },
    { currency: 'ILS', min: 50, max: 900 });

  // The flat checkout fee is per currency: the rate card's 2.00 is the euro
  // fee and must not be charged as 2.00 in shekels.
  const eurFee = (await request(app).get(`/workspaces/${tenant.workspaceId}/platform-fee`)
    .set(tenant.authHeaders).expect(200)).body;
  const ilsFee = (await request(app).get(`/workspaces/${tenant.workspaceId}/platform-fee?currency=ILS`)
    .set(tenant.authHeaders).expect(200)).body;
  assert.equal(eurFee.checkoutFee, 2);
  assert.equal(ilsFee.checkoutFee, 7.5);
  // The percentage rate card is the agency's and applies to every currency.
  assert.equal(ilsFee.blendedRatePct, eurFee.blendedRatePct);

  const link = (await request(app).post(`/workspaces/${tenant.workspaceId}/links`)
    .set(tenant.authHeaders)
    .send({ accountId: account.id, type: 'single_use', amount: 120, currency: 'EUR' })
    .expect(201)).body;
  const stored = (await pool.query(
    'SELECT currency, checkout_fee FROM payment_links WHERE id=$1', [link.id])).rows[0];
  assert.equal(stored.currency, 'EUR');
  assert.equal(Number(stored.checkout_fee), 2, 'the euro fee is copied onto a euro link');
});

test('a payout is per currency: one run pays one currency and settles only its entries', async () => {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  await enable(tenant, [{ currency: 'EUR' }, { currency: 'GBP', checkoutFee: 0 }]);
  await paySale(app, tenant, account, 200, { currency: 'EUR' });
  await paySale(app, tenant, account, 100, { currency: 'GBP' });

  const owedIn = async (currency) => (await request(app)
    .get(`/workspaces/${tenant.workspaceId}/payouts/breakdown?currency=${currency}`)
    .set(tenant.authHeaders).expect(200)).body;
  const eurOwed = await owedIn('EUR');
  const gbpOwed = await owedIn('GBP');
  assert.equal(eurOwed.currency, 'EUR');
  assert.equal(gbpOwed.currency, 'GBP');
  const forAccount = (body) => body.perAccount.find((a) => a.id === account.id).owed;
  assert.ok(forAccount(eurOwed) > 0 && forAccount(gbpOwed) > 0);
  assert.notEqual(forAccount(eurOwed), forAccount(gbpOwed));

  const run = (currency) => request(app).post(`/workspaces/${tenant.workspaceId}/payouts/run`)
    .set(tenant.authHeaders).send({ payeeType: 'account', currency }).expect(200).then((r) => r.body);

  const eurRun = await run('EUR');
  assert.equal(eurRun.currency, 'EUR');
  assert.equal(eurRun.ran, 1);
  assert.equal(eurRun.total, forAccount(eurOwed));

  // The GBP entries are untouched by the EUR payout, so they are still owed.
  assert.equal(forAccount(await owedIn('GBP')), forAccount(gbpOwed));
  assert.equal(forAccount(await owedIn('EUR')), 0);

  const gbpRun = await run('GBP');
  assert.equal(gbpRun.currency, 'GBP');
  assert.equal(gbpRun.total, forAccount(gbpOwed));

  const payouts = (await pool.query(
    'SELECT currency, net FROM payouts WHERE workspace_id=$1 ORDER BY currency', [tenant.workspaceId])).rows;
  assert.deepEqual(payouts.map((p) => p.currency), ['EUR', 'GBP']);
});

test('a currency that priced a link cannot be withdrawn', async () => {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  await enable(tenant, [{ currency: 'EUR' }, { currency: 'GBP', checkoutFee: 0 }]);
  await paySale(app, tenant, account, 20, { currency: 'GBP' });

  const admin = await getPlatformAdmin(app);
  const refused = await request(app)
    .put(`/platform/workspaces/${tenant.workspaceId}/currencies`)
    .set(admin.headers).send({ currencies: [{ currency: 'EUR' }] }).expect(409);
  assert.equal(refused.body.error, 'currency_in_use');
  assert.deepEqual(refused.body.currencies, ['GBP']);
});

test('the base currency stays enabled even if a request leaves it out', async () => {
  const tenant = await createTenant(app);
  const listed = await enable(tenant, [{ currency: 'USD', checkoutFee: 1 }]);
  assert.deepEqual(listed.map((c) => c.currency), ['EUR', 'USD']);
  assert.equal(listed[0].isBase, true);
});

test('a fan who paid in two currencies has two spends, not one', async () => {
  const tenant = await createTenant(app);
  const account = await createAccount(app, tenant);
  const category = (await request(app).post(`/workspaces/${tenant.workspaceId}/categories`)
    .set(tenant.authHeaders).send({ name: 'Subscription' }).expect(201)).body;
  await enable(tenant, [{ currency: 'EUR' }, { currency: 'GBP', checkoutFee: 0 }]);

  const first = await paySale(app, tenant, account, 40, { currency: 'EUR' });
  const done = (await request(app)
    .patch(`/workspaces/${tenant.workspaceId}/payments/${first.paymentId}/details`)
    .set(tenant.authHeaders)
    .send({ categoryId: category.id, customer: { name: 'Two Currency Fan' } })
    .expect(200)).body;

  const second = await paySale(app, tenant, account, 100, { currency: 'GBP' });
  await request(app).patch(`/workspaces/${tenant.workspaceId}/payments/${second.paymentId}/details`)
    .set(tenant.authHeaders)
    .send({ categoryId: category.id, customerId: done.customerId })
    .expect(200);

  const detail = (await request(app).get(`/workspaces/${tenant.workspaceId}/customers/${done.customerId}`)
    .set(tenant.authHeaders).expect(200)).body;
  assert.deepEqual(detail.spendByCurrency, [
    { currency: 'GBP', totalSpend: 100 },
    { currency: 'EUR', totalSpend: 40 },
  ]);

  const inEur = (await request(app).get(`/workspaces/${tenant.workspaceId}/customers`)
    .set(tenant.authHeaders).expect(200)).body;
  assert.equal(inEur.currency, 'EUR');
  assert.equal(inEur.customers.find((c) => c.id === done.customerId).totalSpend, 40);
  const inGbp = (await request(app).get(`/workspaces/${tenant.workspaceId}/customers?currency=GBP`)
    .set(tenant.authHeaders).expect(200)).body;
  assert.equal(inGbp.customers.find((c) => c.id === done.customerId).totalSpend, 100);
});
