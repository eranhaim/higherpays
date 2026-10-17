'use strict';
// Which currencies an agency may price a link in, and which one a report is about.
//
// There is no conversion anywhere in HigherPays. A figure is always in one
// currency, and every aggregate endpoint resolves exactly one currency through
// `resolveReportingCurrency` before it sums anything. That is what stops a
// report adding EUR 100 to GBP 100 and calling it 200.

const { CURRENCY_IDS } = require('../providers/mantapay-apm');

// What an agency can choose from. ILS is selectable but cannot be charged yet:
// MantaPay has no ILS currency id, so `isCheckoutSupported` refuses it.
const SELECTABLE_CURRENCIES = ['USD', 'EUR', 'GBP', 'ILS'];

function normalise(code) {
  return String(code || '').trim().toUpperCase();
}

function isSelectable(code) {
  return SELECTABLE_CURRENCIES.includes(normalise(code));
}

// Separate from `isSelectable` on purpose: a link priced in a currency with no
// MantaPay id would fail at checkout.
function isCheckoutSupported(code) {
  return Boolean(CURRENCY_IDS[normalise(code)]);
}

/** Every selectable currency, with whether this agency allows it. Base first, then A-Z. */
async function listCurrencies(client, workspaceId) {
  const rows = (await client.query(
    `SELECT wc.currency, w.currency AS base_currency,
            EXISTS (SELECT 1 FROM payment_links pl
                     WHERE pl.workspace_id = wc.workspace_id AND pl.currency = wc.currency) AS in_use
       FROM workspace_currencies wc
       JOIN workspaces w ON w.id = wc.workspace_id
      WHERE wc.workspace_id = $1
      ORDER BY (wc.currency = w.currency) DESC, wc.currency`,
    [workspaceId])).rows;
  return rows.map((r) => ({
    currency: r.currency,
    isBase: r.currency === r.base_currency,
    inUse: r.in_use,
    checkoutSupported: isCheckoutSupported(r.currency),
  }));
}

/**
 * Replaces the allowed set. The base currency can never be dropped, and a
 * currency that links already use cannot be removed (the foreign key on
 * payment_links would refuse it too; this gives the caller a readable error).
 * Returns { error, fields } on a refusal, otherwise { currencies }.
 */
async function setAllowedCurrencies(client, workspaceId, requested) {
  const wanted = [...new Set((requested || []).map(normalise))];
  const unknown = wanted.filter((code) => !isSelectable(code));
  if (unknown.length) {
    return { error: `unsupported currency: ${unknown.join(', ')}` };
  }
  const base = (await client.query(
    'SELECT currency FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId])).rows[0].currency;
  if (!wanted.includes(base)) {
    return { error: `the workspace currency ${base} cannot be removed` };
  }
  const current = await listCurrencies(client, workspaceId);
  const blocked = current.filter((c) => c.inUse && !wanted.includes(c.currency)).map((c) => c.currency);
  if (blocked.length) {
    return { error: `${blocked.join(', ')} cannot be removed: payment links already use it` };
  }
  await client.query(
    'DELETE FROM workspace_currencies WHERE workspace_id = $1 AND NOT (currency = ANY($2::char(3)[]))',
    [workspaceId, wanted]);
  await client.query(
    `INSERT INTO workspace_currencies (workspace_id, currency)
     SELECT $1, UNNEST($2::char(3)[]) ON CONFLICT DO NOTHING`,
    [workspaceId, wanted]);
  return { currencies: await listCurrencies(client, workspaceId) };
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
    [workspaceId, wanted || null])).rows[0];
  return row ? row.currency : null;
}

/** The workspace's base currency: what a salary is owed in. */
async function getBaseCurrency(client, workspaceId) {
  return (await client.query('SELECT currency FROM workspaces WHERE id = $1', [workspaceId])).rows[0].currency;
}

module.exports = {
  SELECTABLE_CURRENCIES,
  getBaseCurrency,
  normalise,
  isCheckoutSupported,
  listCurrencies,
  setAllowedCurrencies,
  resolveReportingCurrency,
};
