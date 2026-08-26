'use strict';
// Payments: one row per checkout attempt. Created by the webhook or the
// reconciler, completed by the agent (customer + category), reversed here.
const express = require('express');
const { withTransaction } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { isStr, isOptStr, badRequest } = require('../util/validate');
const { parseLimit, decodeCursor, page } = require('../lib/cursor');
const { resolveDataScope, scopeParams } = require('../auth/dataScope');
const { hasPermission } = require('../auth/permissions');
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

// GET /?limit&cursor&status&accountId&agentId&from&to&q&needsDetails
router.get('/', requirePermission('payments.view'), asyncHandler(async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  const q = typeof req.query.q === 'string' && req.query.q.trim() ? `%${req.query.q.trim().toLowerCase()}%` : null;
  const rows = await withTransaction(async (c) => {
    const scope = await resolveDataScope(c, req);
    return (await c.query(
      `${SELECT}
        WHERE p.workspace_id = $1
          AND ($2::uuid IS NULL OR p.agent_id = $2::uuid)
          AND ($3::uuid IS NULL OR p.account_id = $3::uuid)
          AND ($4::timestamptz IS NULL OR (p.occurred_at, p.id) < ($4::timestamptz, $5::uuid))
          AND ($7::text IS NULL OR p.status = $7::text)
          AND ($8::uuid IS NULL OR p.account_id = $8::uuid)
          AND ($9::uuid IS NULL OR p.agent_id = $9::uuid)
          AND ($10::timestamptz IS NULL OR p.occurred_at >= $10::timestamptz)
          AND ($11::timestamptz IS NULL OR p.occurred_at <= $11::timestamptz)
          AND ($12::text IS NULL OR lower(coalesce(t.provider_transaction_id,'')) LIKE $12::text
               OR lower(coalesce(cu.name,'')) LIKE $12::text OR lower(a.name) LIKE $12::text
               OR lower(coalesce(u.full_name,'')) LIKE $12::text OR lower(coalesce(pl.reference_id,'')) LIKE $12::text)
          AND (NOT $13::boolean OR (p.status = 'paid' AND p.category_id IS NULL))
        ORDER BY p.occurred_at DESC, p.id DESC LIMIT $6`,
      [wid(req), ...scopeParams(scope), cursor ? cursor.ts : null, cursor ? cursor.id : null, limit + 1,
        req.query.status || null, req.query.accountId || null, req.query.agentId || null,
        req.query.from || null, req.query.to || null, q, req.query.needsDetails === 'true'])).rows;
  });
  const seesFees = hasPermission(req.access, 'data.view_all');
  const result = page(rows, limit, (r) => r.occurred_at, (r) => r.id);
  res.json({ items: result.items.map((r) => publicPayment(r, { seesFees })), nextCursor: result.nextCursor });
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
