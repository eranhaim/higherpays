'use strict';
// The Links screen and the Analytics screen report the same money for the same
// window, because they count the same ledger rows on the same date column.
//
// They used to disagree: Links dated revenue by payment_links.created_at, so a
// link created on one day and paid on another landed in a different window on
// each screen. The customer found the gap before we did.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, pool } = require('../helpers/setup');
const { createTenant, createAccount } = require('../helpers/tenant');
const { paySale } = require('../helpers/webhook');

const FROM = '2026-03-01T00:00:00.000Z';
const TO = '2026-03-31T23:59:59.999Z';

/** Puts a sale on the timeline: the link was made one day, the money arrived another. */
async function backdate({ link, paymentId }, { createdAt, paidAt }) {
  await pool.query('UPDATE payment_links SET created_at = $2 WHERE id = $1', [link.id, createdAt]);
  await pool.query('UPDATE payments SET occurred_at = $2 WHERE id = $1', [paymentId, paidAt]);
  await pool.query('UPDATE transactions SET occurred_at = $2 WHERE payment_id = $1', [paymentId, paidAt]);
}

test('analytics and the links summary report the same revenue for the same window', async () => {
  // A non-zero checkout fee is HigherPays' own and is charged on top of the
  // price, so neither screen may count it.
  const t = await createTenant(app, { checkoutFee: 2 });
  const account = await createAccount(app, t);

  // Made and paid inside the window.
  await backdate(await paySale(app, t, account, 100),
    { createdAt: '2026-03-10T09:00:00Z', paidAt: '2026-03-10T09:00:00Z' });
  // Made before the window, paid inside it: the money belongs to this window.
  await backdate(await paySale(app, t, account, 200),
    { createdAt: '2026-02-20T09:00:00Z', paidAt: '2026-03-05T09:00:00Z' });
  // Paid on the last day: an end-of-day bound must not drop it.
  await backdate(await paySale(app, t, account, 400),
    { createdAt: '2026-03-31T22:00:00Z', paidAt: '2026-03-31T22:00:00Z' });
  // Made inside the window, paid after it: the money belongs to the next one.
  await backdate(await paySale(app, t, account, 800),
    { createdAt: '2026-03-28T09:00:00Z', paidAt: '2026-04-05T09:00:00Z' });

  const range = `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
  const links = (await request(app).get(`/workspaces/${t.workspaceId}/links/summary?${range}`)
    .set(t.authHeaders).expect(200)).body;
  const analytics = (await request(app).get(`/workspaces/${t.workspaceId}/analytics?${range}`)
    .set(t.authHeaders).expect(200)).body;

  assert.equal(links.grossSales, analytics.headline.gross);
  assert.equal(links.netAfterFees, analytics.headline.net);
  assert.equal(links.successfulPayments, analytics.headline.paidCount);

  // The figure both screens agree on is the one the ledger holds: the three
  // sales paid in March at their content price, with no checkout fee added.
  assert.equal(links.grossSales, 700);
  assert.equal(links.successfulPayments, 3);

  // Link counts stay on the link's own date, which is what conversion measures.
  // The link paid in April still counts as a link created in March.
  assert.equal(links.totalLinks, 3);
  assert.equal(analytics.funnel.created, 3);
});
