'use strict';
// Which currencies an agency may use, and which one a report is about.
//
// There is no conversion anywhere in HigherPays. A figure is always in one
// currency, and every aggregate endpoint resolves exactly one reporting
// currency through `resolveReportingCurrency` before it sums anything. That is
// what stops a report adding EUR 100 to GBP 100 and calling it 200.

const config = require('../config');
const { CURRENCY_IDS } = require('../providers/mantapay-apm');

/** A currency the platform knows at all. Env-driven: SUPPORTED_CURRENCIES. */
function isPlatformCurrency(code) {
  return config.supportedCurrencies.includes(normalise(code));
}

/**
 * Whether MantaPay can actually take a payment in this currency.
 *
 * Separate from `isPlatformCurrency` on purpose. MantaPay's APM request needs
 * its own numeric currency id, and we only hold confirmed ids for USD, EUR and
 * GBP (`mantapay-apm.CURRENCY_IDS`). A currency with no id can be enabled on a
 * workspace — its history and its reports work — but no link may be priced in
 * it, because checkout would fail at the provider.
 */
function isCheckoutSupported(code) {
  return Boolean(CURRENCY_IDS[normalise(code)]);
}

function normalise(code) {
  return String(code || '').trim().toUpperCase();
}

function isCurrencyCode(code) {
  return /^[A-Z]{3}$/.test(normalise(code));
}

/**
 * Every currency this agency is enabled for, base first.
 *
 * `checkoutFee`, `minLinkAmount` and `maxLinkAmount` are already resolved
 * here: a NULL on the row means "inherit", and inheriting is a property of the
 * currency, not of each caller.
 */
async function listCurrencies(client, workspaceId) {
  const rows = (await client.query(
    `SELECT wc.currency,
            COALESCE(wc.checkout_fee, card.checkout_fee, 0) AS checkout_fee,
            wc.checkout_fee IS NULL AS checkout_fee_inherited,
            COALESCE(wc.min_link_amount, w.min_link_amount) AS min_link_amount,
            COALESCE(wc.max_link_amount, w.max_link_amount) AS max_link_amount,
            wc.currency = w.currency AS is_base,
            EXISTS (
              SELECT 1 FROM payments p
               WHERE p.workspace_id = wc.workspace_id AND p.currency = wc.currency
            ) OR EXISTS (
              SELECT 1 FROM payment_links pl
               WHERE pl.workspace_id = wc.workspace_id AND pl.currency = wc.currency
            ) AS has_activity
       FROM workspace_currencies wc
       JOIN workspaces w ON w.id = wc.workspace_id
       LEFT JOIN LATERAL effective_platform_fee(wc.workspace_id, now()) card ON true
      WHERE wc.workspace_id = $1
      ORDER BY (wc.currency = w.currency) DESC, wc.currency`,
    [workspaceId])).rows;
  return rows.map((r) => ({
    currency: r.currency,
    checkoutFee: Number(r.checkout_fee),
    checkoutFeeInherited: r.checkout_fee_inherited,
    minLinkAmount: r.min_link_amount == null ? null : Number(r.min_link_amount),
    maxLinkAmount: r.max_link_amount == null ? null : Number(r.max_link_amount),
    isBase: r.is_base,
    hasActivity: r.has_activity,
    checkoutSupported: isCheckoutSupported(r.currency),
  }));
}

/** One enabled currency with its resolved amounts, or null. */
async function getCurrency(client, workspaceId, code) {
  const wanted = normalise(code);
  const all = await listCurrencies(client, workspaceId);
  return all.find((c) => c.currency === wanted) || null;
}

/**
 * The single currency an aggregate is reported in.
 *
 * Never "all": a caller who asks for nothing, or for a currency this agency
 * does not use, gets the base currency rather than a sum across currencies.
 */
async function resolveReportingCurrency(client, workspaceId, requested) {
  const wanted = normalise(requested);
  const row = (await client.query(
    `SELECT COALESCE(
              (SELECT wc.currency FROM workspace_currencies wc
                WHERE wc.workspace_id = w.id AND wc.currency = $2),
              w.currency) AS currency
       FROM workspaces w WHERE w.id = $1`,
    [workspaceId, isCurrencyCode(wanted) ? wanted : null])).rows[0];
  return row ? row.currency : null;
}

module.exports = {
  isPlatformCurrency,
  isCheckoutSupported,
  isCurrencyCode,
  normalise,
  listCurrencies,
  getCurrency,
  resolveReportingCurrency,
};
