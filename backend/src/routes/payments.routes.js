'use strict';
// Payments: one row per checkout attempt. Created by the webhook or the
// reconciler, completed by the agent (customer + category), reversed here.
const express = require('express');
const { query, withTransaction } = require('../db');
const { requirePermission, requirePlatformAdmin } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { isStr, isOptStr, badRequest, toCSV } = require('../util/validate');
const { parseLimit, decodeCursor, page } = require('../lib/cursor');
const { resolveDataScope, scopeParams } = require('../auth/dataScope');
const { hasPermission } = require('../auth/permissions');
const { resolveAttribution, repostSales } = require('../services/attribution');
const notifier = require('../notify');
const config = require('../config');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');

const SELECT = `
  SELECT p.*, a.name AS account, cu.name AS customer, cu.telegram_name AS customer_telegram,
         ca.name AS category, u.full_name AS agent, pl.reference_id AS link_reference, pl.type AS link_type,
         t.provider_transaction_id, t.fee AS provider_fee,
         (SELECT platform_fee FROM revenue_entries re WHERE re.transaction_id = t.id AND re.entry_type = 'sale') AS platform_fee
    FROM payments p
    JOIN accounts a ON a.id = p.account_id
    LEFT JOIN customers cu ON cu.id = p.customer_id
    LEFT JOIN categories ca ON ca.id = p.category_id
    LEFT JOIN agents ag ON ag.id = p.agent_id
    LEFT JOIN users u ON u.id = ag.user_id
    LEFT JOIN payment_links pl ON pl.id = p.payment_link_id
    LEFT JOIN transactions t ON t.payment_id = p.id AND t.type = 'payment'`;

// Whether the platform fee is shown depends on who asks: an agent or an owner
// sees the payment, not what the agency was charged for it.
function publicPayment(p, { seesFees }) {
  return {
    id: p.id, amount: Number(p.amount), currency: p.currency, status: p.status,
    paymentMethod: p.payment_method, providerPaymentId: p.provider_payment_id,
    providerTransactionId: p.provider_transaction_id, occurredAt: p.occurred_at,
    accountId: p.account_id, account: p.account,
    agentId: p.agent_id, agent: p.agent,
    customerId: p.customer_id, customer: p.customer, customerTelegram: p.customer_telegram,
    categoryId: p.category_id, category: p.category,
    linkId: p.payment_link_id, linkReference: p.link_reference, linkType: p.link_type,
    needsDetails: p.status === 'paid' && p.category_id == null,
    ...(seesFees ? { platformFee: p.platform_fee == null ? null : Number(p.platform_fee) } : {}),
  };
}

// What a caller may sort by. Not free text: the key picks the expression, the
// cast the cursor comparison, and `keyOf` reads the value back off a row for
// the next cursor. Mirrored in frontend/src/api/endpoints/payments.ts.
const PAYMENT_SORTS = {
  date: { expr: 'p.occurred_at', cast: 'timestamptz', keyOf: (r) => r.occurred_at },
  amount: { expr: 'p.amount', cast: 'numeric', keyOf: (r) => r.amount },
  status: { expr: 'p.status', cast: 'text', keyOf: (r) => r.status },
};
const DEFAULT_SORT = 'date';

function sortFor(req) {
  const key = typeof req.query.sort === 'string' && PAYMENT_SORTS[req.query.sort] ? req.query.sort : DEFAULT_SORT;
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
  return { ...PAYMENT_SORTS[key], dir, after: dir === 'ASC' ? '>' : '<' };
}

// The list and the export answer the same question with the same filters;
// only the page size differs. `cursor` null and `limit` null mean "all".
async function listPayments(c, req, { cursor, limit }) {
  const sort = sortFor(req);
  const scope = await resolveDataScope(c, req);
  const q = typeof req.query.q === 'string' && req.query.q.trim() ? `%${req.query.q.trim().toLowerCase()}%` : null;
  return (await c.query(
    `${SELECT}
      WHERE p.workspace_id = $1
        AND ($2::uuid IS NULL OR p.agent_id = $2::uuid)
        AND ($3::uuid IS NULL OR p.account_id = $3::uuid)
        AND ($4::text IS NULL OR (${sort.expr}, p.id) ${sort.after} ($4::${sort.cast}, $5::uuid))
        AND ($7::text IS NULL OR p.status = $7::text)
        AND ($8::uuid IS NULL OR p.account_id = $8::uuid)
        AND ($9::uuid IS NULL OR p.agent_id = $9::uuid)
        AND ($10::timestamptz IS NULL OR p.occurred_at >= $10::timestamptz)
        AND ($11::timestamptz IS NULL OR p.occurred_at <= $11::timestamptz)
        AND ($12::text IS NULL OR lower(coalesce(t.provider_transaction_id,'')) LIKE $12::text
             OR lower(coalesce(cu.name,'')) LIKE $12::text OR lower(a.name) LIKE $12::text
             OR lower(coalesce(u.full_name,'')) LIKE $12::text OR lower(coalesce(pl.reference_id,'')) LIKE $12::text)
        AND (NOT $13::boolean OR (p.status = 'paid' AND p.category_id IS NULL))
      ORDER BY ${sort.expr} ${sort.dir}, p.id ${sort.dir} LIMIT $6`,
    [wid(req), ...scopeParams(scope), cursor ? cursor.value : null, cursor ? cursor.id : null, limit,
      req.query.status || null, req.query.accountId || null, req.query.agentId || null,
      req.query.from || null, req.query.to || null, q, req.query.needsDetails === 'true'])).rows;
}

// GET /?limit&cursor&sort&dir&status&accountId&agentId&from&to&q&needsDetails
router.get('/', requirePermission('payments.view'), asyncHandler(async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  const rows = await withTransaction((c) => listPayments(c, req, { cursor, limit: limit + 1 }));
  const seesFees = hasPermission(req.access, 'data.view_all');
  const result = page(rows, limit, sortFor(req).keyOf, (r) => r.id);
  res.json({ items: result.items.map((r) => publicPayment(r, { seesFees })), nextCursor: result.nextCursor });
}));

// Every column the export can carry, in file order. Headers are what the agency
// reads in the file, not our column names; 'Reference' is MantaPay's
// transaction id. `feesOnly` columns reach only a caller who sees the whole
// workspace. Mirrored in frontend/src/api/endpoints/payments.ts.
const EXPORT_COLUMNS = [
  { key: 'date', header: 'Date', value: (r) => new Date(r.occurred_at).toISOString() },
  { key: 'reference', header: 'Reference', value: (r) => r.provider_transaction_id },
  { key: 'status', header: 'Status', value: (r) => r.status },
  { key: 'gross', header: 'Gross Revenue', value: (r) => `${r.amount} ${r.currency}` },
  { key: 'fee', header: 'Platform Fee', feesOnly: true, value: (r) => r.platform_fee },
  { key: 'net', header: 'Net Revenue', feesOnly: true,
    value: (r) => (r.platform_fee == null ? null : (Number(r.amount) - Number(r.platform_fee)).toFixed(2)) },
  { key: 'customer', header: 'Customer', value: (r) => r.customer },
  { key: 'telegram', header: 'Telegram', value: (r) => r.customer_telegram },
  { key: 'creator', header: 'Creator', value: (r) => r.account },
  { key: 'agent', header: 'Agent', value: (r) => r.agent },
  { key: 'category', header: 'Category', value: (r) => r.category },
];

// GET /export?columns&limit — the filtered list as CSV. Capped so a runaway
// range cannot hold a connection open building a file nobody can open.
const EXPORT_MAX_ROWS = 20000;
router.get('/export', requirePermission('payments.export'), asyncHandler(async (req, res) => {
  const seesFees = hasPermission(req.access, 'data.view_all');
  // No `columns` means every column the caller may see.
  const requested = typeof req.query.columns === 'string' && req.query.columns.trim()
    ? new Set(req.query.columns.split(',').map((k) => k.trim()))
    : null;
  const columns = EXPORT_COLUMNS.filter((c) => (!c.feesOnly || seesFees) && (!requested || requested.has(c.key)));
  if (columns.length === 0) return badRequest(res, 'columns must name at least one column', ['columns']);

  const asked = Number(req.query.limit);
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, EXPORT_MAX_ROWS) : EXPORT_MAX_ROWS;

  const rows = await withTransaction((c) => listPayments(c, req, { cursor: null, limit }));
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'payment.export', metadata: { count: rows.length }, ip: req.ip || null });
  const csv = toCSV(columns.map((c) => c.header), rows.map((r) => columns.map((c) => c.value(r))));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="payments_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('\ufeff' + csv);
}));

async function loadScoped(c, req, id) {
  const scope = await resolveDataScope(c, req);
  return (await c.query(
    `${SELECT} WHERE p.workspace_id = $1 AND p.id = $2
        AND ($3::uuid IS NULL OR p.agent_id = $3::uuid)
        AND ($4::uuid IS NULL OR p.account_id = $4::uuid)`, [wid(req), id, ...scopeParams(scope)])).rows[0];
}

// GET /:id
router.get('/:id', requirePermission('payments.view'), asyncHandler(async (req, res) => {
  const row = await withTransaction((c) => loadScoped(c, req, req.params.id));
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(publicPayment(row, { seesFees: hasPermission(req.access, 'data.view_all') }));
}));

// GET /:id/flow — the immutable sale waterfall for HigherPays operators.
// This is intentionally separate from the payment list: workspace members see
// the payment they need to operate, while only the platform can inspect every
// fee and allocation that produced the result.
router.get('/:id/flow', requirePermission('payments.view'), requirePlatformAdmin, asyncHandler(async (req, res) => {
  const row = (await query(
    `SELECT p.id, p.status, p.amount, p.currency,
            t.provider_transaction_id, t.gross AS transaction_gross, t.surcharge,
            re.id AS sale_entry_id, re.gross AS sale_gross,
            re.fee_mdr, re.fee_fixed, re.fee_settlement, re.psp_fee,
            re.platform_fee, re.platform_margin, re.distributable,
            re.account_amount, re.agent_amount, re.agency_amount,
            a.name AS account, u.full_name AS agent,
            pf.fee_model, pf.mdr_pct, pf.psp_rate_pct, pf.settlement_pct,
            pf.margin_rate_pct
       FROM payments p
       LEFT JOIN transactions t ON t.payment_id = p.id AND t.type = 'payment'
       LEFT JOIN revenue_entries re ON re.transaction_id = t.id AND re.entry_type = 'sale'
       LEFT JOIN accounts a ON a.id = re.account_id
       LEFT JOIN agents ag ON ag.id = re.agent_id
       LEFT JOIN users u ON u.id = ag.user_id
       LEFT JOIN LATERAL effective_platform_fee(p.workspace_id, COALESCE(t.occurred_at, p.occurred_at)) pf ON true
      WHERE p.workspace_id = $1 AND p.id = $2`,
    [wid(req), req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: 'not_found' });

  const saleAmount = Number(row.sale_gross ?? row.transaction_gross ?? row.amount);
  const checkoutFee = Number(row.surcharge || 0);
  const mdrAmount = Number(row.fee_mdr || 0);
  const fixedAmount = Number(row.fee_fixed || 0);
  const settlementBase = row.fee_model === 'cascade'
    ? saleAmount - mdrAmount - fixedAmount
    : saleAmount;
  const percentage = (amount, base) => base > 0 ? Math.round((amount / base) * 10000) / 100 : 0;
  const mdrRate = row.mdr_pct == null ? Number(row.psp_rate_pct || 0) : Number(row.mdr_pct);
  const settlementRate = row.mdr_pct == null ? 0 : Number(row.settlement_pct || 0);
  const marginRate = Number(row.margin_rate_pct || 0);
  const providerItemised = Number(row.fee_mdr || 0) + Number(row.fee_fixed || 0) + Number(row.fee_settlement || 0);
  res.json({
    paymentId: row.id,
    status: row.status,
    currency: row.currency,
    providerTransactionId: row.provider_transaction_id,
    customerTotal: saleAmount + checkoutFee,
    saleAmount,
    checkoutFee,
    settled: Boolean(row.sale_entry_id),
    fees: {
      mdr: Number(row.fee_mdr || 0),
      fixed: Number(row.fee_fixed || 0),
      settlement: Number(row.fee_settlement || 0),
      provider: Number(row.psp_fee || providerItemised),
      platform: Number(row.platform_fee || 0),
      higherPaysMargin: Number(row.platform_margin || 0),
    },
    distributable: Number(row.distributable || 0),
    distribution: {
      account: {
        name: row.account,
        amount: Number(row.account_amount || 0),
        percentage: percentage(Number(row.account_amount || 0), Number(row.distributable || 0)),
        base: Number(row.distributable || 0),
      },
      agent: {
        name: row.agent,
        amount: Number(row.agent_amount || 0),
        percentage: percentage(Number(row.agent_amount || 0), Number(row.distributable || 0)),
        base: Number(row.distributable || 0),
      },
      agency: {
        amount: Number(row.agency_amount || 0),
        percentage: percentage(Number(row.agency_amount || 0), Number(row.distributable || 0)),
        base: Number(row.distributable || 0),
      },
    },
    rates: {
      mdr: { percentage: mdrRate, base: saleAmount },
      settlement: row.settlement_pct == null || row.mdr_pct == null
        ? null
        : { percentage: settlementRate, base: settlementBase },
      higherPaysMargin: { percentage: marginRate, base: saleAmount },
    },
  });
}));

// PATCH /:id/details  { categoryId, customerId? | customer?: { name, telegramName? } }
// The agent completes a paid payment: who paid, and what for. A new customer
// is created inline so the name is typed once and reused on later payments.
router.patch('/:id/details', requirePermission('payments.complete'), asyncHandler(async (req, res) => {
  const { categoryId, customerId, customer } = req.body || {};
  if (!isStr(categoryId)) return badRequest(res, 'categoryId is required', ['categoryId']);
  if (customer != null && (!isStr(customer.name, 200) || !isOptStr(customer.telegramName, 100))) {
    return badRequest(res, 'customer.name is required', ['customer']);
  }

  const out = await withTransaction(async (c) => {
    const payment = await loadScoped(c, req, req.params.id);
    if (!payment) return { err: 'not_found', code: 404 };
    if (payment.status !== 'paid') return { err: 'payment_not_paid', code: 409 };

    const category = (await c.query(
      'SELECT id FROM categories WHERE id = $1 AND workspace_id = $2 AND active', [categoryId, wid(req)])).rows[0];
    if (!category) return { err: 'category_not_found', code: 404 };

    let resolvedCustomerId = customerId || null;
    if (resolvedCustomerId) {
      const found = (await c.query(
        'SELECT id FROM customers WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL', [resolvedCustomerId, wid(req)])).rows[0];
      if (!found) return { err: 'customer_not_found', code: 404 };
    } else if (customer) {
      resolvedCustomerId = (await c.query(
        'INSERT INTO customers (workspace_id, name, telegram_name) VALUES ($1,$2,$3) RETURNING id',
        [wid(req), customer.name.trim(), customer.telegramName || null])).rows[0].id;
    } else {
      resolvedCustomerId = payment.customer_id;
    }

    await c.query(
      'UPDATE payments SET category_id = $2, customer_id = $3 WHERE id = $1', [payment.id, category.id, resolvedCustomerId]);
    if (resolvedCustomerId) {
      await c.query(
        `UPDATE customers SET total_spend = (SELECT COALESCE(SUM(amount),0) FROM payments WHERE customer_id = $1 AND status = 'paid'),
                              last_purchase_at = GREATEST(coalesce(last_purchase_at, $2), $2)
          WHERE id = $1`, [resolvedCustomerId, payment.occurred_at]);
    }
    // A single-use link is finished once its one payment is complete.
    if (payment.payment_link_id) {
      await c.query(
        "UPDATE payment_links SET status = 'done' WHERE id = $1 AND type = 'single_use' AND status = 'pending'", [payment.payment_link_id]);
    }
    return { row: await loadScoped(c, req, payment.id) };
  });
  if (out.err) return res.status(out.code).json({ error: out.err });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'payment.complete', entityType: 'payment', entityId: out.row.id, metadata: { categoryId } });
  res.json(publicPayment(out.row, { seesFees: hasPermission(req.access, 'data.view_all') }));
}));

// GET /:id/impact — whether this payment has already been paid out. Read
// before the confirmation, so the dialog can say it in numbers rather than in
// general. Same shape as a link's impact, over the one payment.
router.get('/:id/impact', requirePermission('revenue.manage'), asyncHandler(async (req, res) => {
  const row = (await query(`
    SELECT count(*)::int AS payments,
           count(*) FILTER (WHERE re.account_payout_id IS NOT NULL OR re.agent_payout_id IS NOT NULL)::int AS paid_out,
           COALESCE(SUM(p.amount), 0) AS amount
      FROM payments p
      LEFT JOIN transactions t ON t.payment_id = p.id AND t.type = 'payment'
      LEFT JOIN revenue_entries re ON re.transaction_id = t.id AND re.entry_type = 'sale'
     WHERE p.workspace_id = $1 AND p.id = $2`, [wid(req), req.params.id])).rows[0];
  res.json({ payments: row.payments, paidOut: row.paid_out, amount: Number(row.amount) });
}));

// PATCH /:id/attribution  { accountId?, agentId? }
// Moves one payment to another creator or agent. The sale is re-posted against
// the new attribution, so a payout that already paid the old creator for it is
// left overpaid — /impact says so before confirming.
router.patch('/:id/attribution', requirePermission('revenue.manage'), asyncHandler(async (req, res) => {
  const { accountId, agentId } = req.body || {};
  if (accountId === undefined && agentId === undefined) {
    return badRequest(res, 'accountId or agentId is required', ['accountId', 'agentId']);
  }

  const out = await withTransaction(async (c) => {
    const payment = (await c.query(
      'SELECT * FROM payments WHERE workspace_id = $1 AND id = $2', [wid(req), req.params.id])).rows[0];
    if (!payment) return { notFound: true };
    // A reversed sale cannot be moved: only its sale entry would be re-posted,
    // leaving the refund that mirrors it against the old creator.
    if (payment.status === 'refunded') return { err: 'payment_reversed', fields: [] };

    const next = await resolveAttribution(c, wid(req), {
      accountId: accountId === undefined ? payment.account_id : accountId,
      agentId: agentId === undefined ? payment.agent_id : (agentId || null),
    });
    if (next.err) return next;

    await c.query(
      'UPDATE payments SET account_id = $2, agent_id = $3 WHERE id = $1',
      [payment.id, next.accountId, next.agentId]);
    // A single-use link carries exactly this payment, so it follows it. A
    // reusable link stays where it is: its other payments have not moved.
    if (payment.payment_link_id) {
      await c.query(
        "UPDATE payment_links SET account_id = $2, created_by_agent_id = $3 WHERE id = $1 AND type = 'single_use'",
        [payment.payment_link_id, next.accountId, next.agentId]);
    }
    const reposted = await repostSales(c, [payment.id]);
    return {
      row: await loadScoped(c, req, payment.id),
      reposted,
      from: { accountId: payment.account_id, agentId: payment.agent_id },
    };
  });

  if (out.notFound) return res.status(404).json({ error: 'not_found' });
  if (out.err) return badRequest(res, out.err, out.fields);
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'payment.reassign',
    entityType: 'payment', entityId: req.params.id,
    metadata: {
      from: out.from,
      to: { accountId: out.row.account_id, agentId: out.row.agent_id },
      reposted: out.reposted,
    },
  });
  res.json({ ...publicPayment(out.row, { seesFees: hasPermission(req.access, 'data.view_all') }), reposted: out.reposted });
}));

// A refund or chargeback reverses the sale in the ledger and records a second
// transaction under the same payment. Idempotent: the ledger refuses a second
// reversal.
async function reverse(req, res, kind) {
  const status = kind === 'refund' ? 'refunded' : 'charged_back';
  const fn = kind === 'refund' ? 'fn_post_refund' : 'fn_post_chargeback';
  const result = await withTransaction(async (c) => {
    const p = (await c.query(
      `SELECT p.id, p.amount, p.currency, p.status, p.payment_link_id, p.account_id, p.agent_id,
              t.id AS sale_tx_id
         FROM payments p LEFT JOIN transactions t ON t.payment_id = p.id AND t.type = 'payment' AND t.status = 'approved'
        WHERE p.id = $1 AND p.workspace_id = $2`, [req.params.id, wid(req)])).rows[0];
    if (!p) return { notFound: true };
    if (!p.sale_tx_id) return { noSale: true };
    const already = (await c.query(
      "SELECT entry_type FROM revenue_entries WHERE transaction_id=$1 AND entry_type IN ('refund','chargeback')", [p.sale_tx_id])).rows[0];
    if (already) return { already: already.entry_type };

    const entry = (await c.query(`SELECT * FROM ${fn}($1)`, [p.sale_tx_id])).rows[0];
    await c.query(
      `INSERT INTO transactions (workspace_id, payment_id, type, status, gross, currency, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())`, [wid(req), p.id, kind, status, p.amount, p.currency]);
    await c.query('UPDATE payments SET status = $2 WHERE id = $1', [p.id, 'refunded']);
    if (p.payment_link_id) {
      await c.query("UPDATE payment_links SET status='refunded' WHERE id=$1 AND type='single_use'", [p.payment_link_id]);
    }
    await notifier.notify(c, wid(req), {
      event: kind === 'refund' ? 'payment.refunded' : 'payment.chargeback',
      title: kind === 'refund' ? 'Refund recorded' : 'Chargeback recorded',
      accountId: p.account_id, agentId: p.agent_id,
      amount: Number(p.amount), currency: p.currency, entityType: 'payment', entityId: p.id,
    });
    return { entry, amount: Number(p.amount), currency: p.currency };
  });

  if (result.notFound) return res.status(404).json({ error: 'not_found' });
  if (result.noSale) return res.status(400).json({ error: 'no_sale_to_reverse' });
  if (result.already) return res.status(409).json({ error: 'already_reversed', as: result.already });

  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: `payment.${kind}`, entityType: 'payment', entityId: req.params.id });
  const e = result.entry;
  res.json({
    ok: true, reversed: result.amount, currency: result.currency,
    fee: Number(e.chargeback_fee || 0),
    accountAdjustment: Number(e.account_amount || 0),
    agentAdjustment: Number(e.agent_amount || 0),
    agencyAdjustment: Number(e.agency_amount || 0),
  });
}

// POST /:id/refund — records a refund issued in MantaPay's dashboard. The
// provider has no refund API today (MANTAPAY_REFUND_ENABLED=false).
router.post('/:id/refund', requirePermission('revenue.manage'), asyncHandler(async (req, res) => {
  if (config.mantapayRefundEnabled) return res.status(501).json({ error: 'provider_refund_not_implemented' });
  return reverse(req, res, 'refund');
}));

// POST /:id/chargeback
router.post('/:id/chargeback', requirePermission('revenue.manage'), asyncHandler((req, res) => reverse(req, res, 'chargeback')));

module.exports = router;
