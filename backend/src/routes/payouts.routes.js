'use strict';
const express = require('express');
const { withWorkspace } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const provider = require('../providers/mantapay');
const config = require('../config');
const { cashPosition } = require('../services/cash');
const { parseLimit, decodeCursor, page } = require('../lib/cursor');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');
const { resolveDataScope } = require('../auth/dataScope');

// POST /workspaces/:wid/transactions/:txId/post-sale
// Normally the webhook handler calls this when a payment settles. Exposed here
// so the flow works before the provider webhook is wired.
router.post('/transactions/:txId/post-sale', requirePermission('commissions.manage'), asyncHandler(async (req, res) => {
  const entry = await withWorkspace(wid(req), uid(req), async (c) => {
    const tx = (await c.query('SELECT 1 FROM transactions WHERE id=$1 AND workspace_id=$2', [req.params.txId, wid(req)])).rows[0];
    if (!tx) return { err: 'transaction_not_found' };
    return { row: (await c.query('SELECT * FROM fn_post_sale($1)', [req.params.txId])).rows[0] };
  });
  if (entry.err) return res.status(404).json({ error: entry.err });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'payout.post_sale', entityType: 'transaction', entityId: req.params.txId });
  res.status(201).json(entry.row);
}));

// POST /workspaces/:wid/transactions/:txId/chargeback
router.post('/transactions/:txId/chargeback', requirePermission('commissions.manage'), asyncHandler(async (req, res) => {
  const out = await withWorkspace(wid(req), uid(req), async (c) => {
    const tx = (await c.query('SELECT 1 FROM transactions WHERE id=$1 AND workspace_id=$2', [req.params.txId, wid(req)])).rows[0];
    if (!tx) return { err: 'transaction_not_found' };
    try { return { row: (await c.query('SELECT * FROM fn_post_chargeback($1)', [req.params.txId])).rows[0] }; }
    catch (e) { return { err: e.message.includes('already') ? 'already_charged_back' : 'no_sale_entry' }; }
  });
  if (out.err) return res.status(out.err === 'transaction_not_found' ? 404 : 409).json({ error: out.err });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'payout.chargeback', entityType: 'transaction', entityId: req.params.txId });
  res.status(201).json(out.row);
}));

// GET /workspaces/:wid/payouts/summary
// Net owed to each party (sales minus chargebacks), salary obligations, and the
// expected settlement figure to reconcile against the provider.
router.get('/payouts/summary', requirePermission('commissions.view'), asyncHandler(async (req, res) => {
  const data = await withWorkspace(wid(req), uid(req), async (c) => {
    const totals = (await c.query(
      `SELECT
         COALESCE(SUM(account_amount),0)  AS accounts,
         COALESCE(SUM(agent_amount),0)    AS agents,
         COALESCE(SUM(agency_amount),0)   AS agency,
         COALESCE(SUM(platform_margin),0) AS higherpays_margin,
         COALESCE(SUM(gross - psp_fee),0) - COALESCE(SUM(chargeback_fee),0) AS expected_settlement,
         COALESCE(SUM(chargeback_fee),0)  AS chargeback_fees,
         COUNT(*) FILTER (WHERE entry_type='sale' AND status='locked')  AS sales,
         COUNT(*) FILTER (WHERE entry_type='chargeback')                AS chargebacks
       FROM commission_entries WHERE workspace_id=$1`, [wid(req)])).rows[0];

    // monthly salary obligations for salaried accounts (separate from per-sale)
    const salaries = (await c.query(
      `SELECT COALESCE(SUM(salary),0) AS monthly_salaries
       FROM accounts WHERE workspace_id=$1 AND revenue_model='salary' AND status='active'`, [wid(req)])).rows[0];

    const perAccount = (await c.query(
      `SELECT a.id, a.stage_name, a.revenue_model,
              COALESCE(SUM(ce.account_amount),0) AS net_account,
              COALESCE(SUM(ce.chargeback_fee) FILTER (WHERE ce.entry_type='chargeback'),0) AS chargeback_fees,
              COUNT(*) FILTER (WHERE ce.entry_type='chargeback') AS chargebacks
       FROM accounts a LEFT JOIN commission_entries ce ON ce.account_id=a.id
       WHERE a.workspace_id=$1 GROUP BY a.id, a.stage_name, a.revenue_model
       ORDER BY net_account DESC`, [wid(req)])).rows;

    return { totals, monthlySalaries: salaries.monthly_salaries, perAccount };
  });
  res.json(data);
}));

// GET /workspaces/:wid/accounts/:id/earnings
// What a rev-share account sees on its console: net earnings + chargeback detail.
router.get('/accounts/:id/earnings', requirePermission('commissions.view'), asyncHandler(async (req, res) => {
  const data = await withWorkspace(wid(req), uid(req), async (c) => {
    const acct = (await c.query('SELECT id, stage_name, revenue_model, salary FROM accounts WHERE id=$1 AND workspace_id=$2', [req.params.id, wid(req)])).rows[0];
    if (!acct) return null;
    const e = (await c.query(
      `SELECT
         COALESCE(SUM(account_amount) FILTER (WHERE entry_type='sale'),0)        AS gross_earnings,
         COALESCE(SUM(-account_amount) FILTER (WHERE entry_type='chargeback'),0) AS chargeback_amount,
         COALESCE(SUM(chargeback_fee) FILTER (WHERE entry_type='chargeback'),0)  AS chargeback_fees,
         COALESCE(SUM(account_amount),0)                                         AS net_earnings,
         COUNT(*) FILTER (WHERE entry_type='chargeback')                         AS chargebacks
       FROM commission_entries WHERE account_id=$1`, [acct.id])).rows[0];
    return { account: acct, earnings: e };
  });
  if (!data) return res.status(404).json({ error: 'not_found' });
  res.json(data);
}));

// GET /workspaces/:wid/transactions?limit&cursor — the Payments tab feed, newest first.
// An agent sees sales credited to them; an account sees sales on its own
// record. Both lose platform_fee — gross minus fee is the agency's take, which
// is not theirs to compute. An account also loses the agent's name.
router.get('/transactions', requirePermission('payments.view'), asyncHandler(async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  const out = await withWorkspace(wid(req), uid(req), async (c) => {
    const scope = await resolveDataScope(c, req);
    const rows = (await c.query(
      `SELECT t.id, t.provider_transaction_id, t.gross, t.platform_fee, t.status, t.occurred_at,
              a.stage_name AS account, cu.alias AS customer, u.full_name AS agent
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       LEFT JOIN customers cu ON cu.id = t.customer_id
       LEFT JOIN memberships m ON m.id = t.attributed_membership_id
       LEFT JOIN users u ON u.id = m.user_id
       WHERE t.workspace_id = $1
         AND ($2::uuid IS NULL OR t.attributed_membership_id = $2::uuid)
         AND ($3::uuid IS NULL OR t.account_id = $3::uuid)
         AND ($4::timestamptz IS NULL OR (t.occurred_at, t.id) < ($4::timestamptz, $5::uuid))
       ORDER BY t.occurred_at DESC, t.id DESC LIMIT $6`,
      [wid(req),
        scope.kind === 'agent' ? scope.membershipId : null,
        scope.kind === 'account' ? scope.accountId : null,
        cursor ? cursor.ts : null, cursor ? cursor.id : null, limit + 1])).rows;
    return { rows, scope };
  });
  const rows = out.scope.kind === 'workspace' ? out.rows : out.rows.map((r) => {
    const { platform_fee, ...rest } = r;
    if (out.scope.kind === 'account') delete rest.agent;
    return rest;
  });
  res.json(page(rows, limit, (r) => r.occurred_at, (r) => r.id));
}));

// GET /workspaces/:wid/payouts/breakdown?from&to — accrued owed per account + per agent
router.get('/payouts/breakdown', requirePermission('commissions.view'), asyncHandler(async (req, res) => {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
  const F = from.toISOString(), T = to.toISOString();
  const data = await withWorkspace(wid(req), uid(req), async (c) => {
    const perAccount = (await c.query(`
      SELECT a.id, a.stage_name AS name, a.revenue_model AS model, a.salary,
             COALESCE(agg.revenue,0) AS revenue, COALESCE(agg.owed,0) AS owed
      FROM accounts a
      LEFT JOIN (
        SELECT ce.account_id, SUM(ce.gross) AS revenue, SUM(ce.account_amount) FILTER (WHERE ce.account_payout_id IS NULL) AS owed
        FROM commission_entries ce JOIN transactions t ON t.id = ce.transaction_id
        WHERE t.occurred_at >= $1 AND t.occurred_at <= $2 GROUP BY ce.account_id
      ) agg ON agg.account_id = a.id
      WHERE a.workspace_id = $3 ORDER BY owed DESC`, [F, T, wid(req)])).rows;
    const perAgent = (await c.query(`
      SELECT m.id, u.full_name AS name, COALESCE(agg.owed,0) AS owed, COALESCE(agg.sales,0) AS sales
      FROM memberships m JOIN users u ON u.id = m.user_id
      LEFT JOIN (
        SELECT ce.agent_membership_id AS mid, SUM(ce.agent_amount) FILTER (WHERE ce.agent_payout_id IS NULL) AS owed,
               COUNT(*) FILTER (WHERE ce.entry_type='sale') AS sales
        FROM commission_entries ce JOIN transactions t ON t.id = ce.transaction_id
        WHERE t.occurred_at >= $1 AND t.occurred_at <= $2 GROUP BY ce.agent_membership_id
      ) agg ON agg.mid = m.id
      WHERE m.workspace_id = $3 AND m.role = 'agent' AND m.status = 'active'
      ORDER BY owed DESC`, [F, T, wid(req)])).rows;
    return { perAccount, perAgent };
  });
  const num = (v) => Number(v || 0);
  const round2 = (v) => Math.round(v * 100) / 100;

  // Rolling reserve: the provider holds a % of settled volume. It is the agency's
  // own money, released later — but until then the agency is fronting it if it
  // pays accounts/agents their full share.
  const reserve = await withWorkspace(wid(req), uid(req), async (c) => {
    const cfg = (await c.query(
      `SELECT r.reserve_pct, r.reserve_release_days
         FROM workspaces w LEFT JOIN LATERAL effective_reserve(w.organization_id, now()) r ON true
        WHERE w.id = $1`, [wid(req)])).rows[0] || {};
    const pct = Number(cfg.reserve_pct || 0), days = Number(cfg.reserve_release_days || 0);

    // Prefer imported settlements (truth). Fall back to an estimate from the rate.
    const settled = (await c.query(
      `SELECT COALESCE(SUM(reserve),0) AS held
         FROM settlements
        WHERE reserve > 0
          AND ($1 = 0 OR (settlement_date + ($1 || ' days')::interval)::date > now()::date)`,
      [String(days)])).rows[0];
    const imported = (await c.query('SELECT count(*) AS c FROM settlements')).rows[0].c;

    if (Number(imported) > 0) return { pct, releaseDays: days, held: round2(Number(settled.held)), source: 'settlements' };

    const gross = (await c.query(
      `SELECT COALESCE(SUM(gross),0) AS g FROM transactions
        WHERE status='approved' AND occurred_at>=$1 AND occurred_at<=$2`, [F, T])).rows[0].g;
    return { pct, releaseDays: days, held: round2(Number(gross) * pct / 100), source: 'estimated' };
  });

  const accountsOwed = data.perAccount.reduce((s, r) => s + num(r.owed), 0);
  const agentsOwed = data.perAgent.reduce((s, r) => s + num(r.owed), 0);
  // What actually reached the agency this period: gross minus every fee.
  const received = await withWorkspace(wid(req), uid(req), async (c) => num((await c.query(
    `SELECT COALESCE(SUM(ce.distributable),0) AS received
       FROM commission_entries ce JOIN transactions t ON t.id = ce.transaction_id
      WHERE t.occurred_at >= $1 AND t.occurred_at <= $2`, [F, T])).rows[0].received));

  res.json({
    range: { from: F, to: T },
    perAccount: data.perAccount.map((r) => ({ id: r.id, name: r.name, model: r.model, salary: num(r.salary), revenue: num(r.revenue), owed: num(r.owed) })),
    perAgent: data.perAgent.map((r) => ({ id: r.id, name: r.name, owed: num(r.owed), sales: num(r.sales) })),
    reserve,
    cash: cashPosition({ owed: accountsOwed + agentsOwed, received, held: reserve.held }),
  });
}));

// One fixed statement set per payee type: the money path carries no
// string-built SQL. $1 from, $2 to, $3 optional target id (NULL = everyone).
const PAYOUT_SQL = {
  account: {
    unpaid: `
      SELECT ce.account_id AS rid, SUM(ce.account_amount) AS amount,
             MIN(t.occurred_at)::date AS ps, MAX(t.occurred_at)::date AS pe
        FROM commission_entries ce JOIN transactions t ON t.id = ce.transaction_id
       WHERE t.occurred_at >= $1 AND t.occurred_at <= $2
         AND ce.account_payout_id IS NULL AND ce.account_id IS NOT NULL
         AND ($3::uuid IS NULL OR ce.account_id = $3::uuid)
       GROUP BY ce.account_id HAVING SUM(ce.account_amount) > 0`,
    insert: `
      INSERT INTO payouts (workspace_id, payee_type, account_id, period_start, period_end, amount, net, currency, status)
      VALUES ($1, 'account', $2, $3, $4, $5, $5, $6, 'recorded') RETURNING id`,
    settle: `
      UPDATE commission_entries SET account_payout_id = $1, account_paid_at = now()
       WHERE account_id = $2 AND account_payout_id IS NULL
         AND transaction_id IN (SELECT id FROM transactions WHERE occurred_at >= $3 AND occurred_at <= $4)`,
  },
  agent: {
    unpaid: `
      SELECT ce.agent_membership_id AS rid, SUM(ce.agent_amount) AS amount,
             MIN(t.occurred_at)::date AS ps, MAX(t.occurred_at)::date AS pe
        FROM commission_entries ce JOIN transactions t ON t.id = ce.transaction_id
       WHERE t.occurred_at >= $1 AND t.occurred_at <= $2
         AND ce.agent_payout_id IS NULL AND ce.agent_membership_id IS NOT NULL
         AND ($3::uuid IS NULL OR ce.agent_membership_id = $3::uuid)
       GROUP BY ce.agent_membership_id HAVING SUM(ce.agent_amount) > 0`,
    insert: `
      INSERT INTO payouts (workspace_id, payee_type, membership_id, period_start, period_end, amount, net, currency, status)
      VALUES ($1, 'agent', $2, $3, $4, $5, $5, $6, 'recorded') RETURNING id`,
    settle: `
      UPDATE commission_entries SET agent_payout_id = $1, agent_paid_at = now()
       WHERE agent_membership_id = $2 AND agent_payout_id IS NULL
         AND transaction_id IN (SELECT id FROM transactions WHERE occurred_at >= $3 AND occurred_at <= $4)`,
  },
};

// POST /workspaces/:wid/payouts/run — record a payout for unpaid balances
// (one recipient or all). No rail moves money yet, so the payout row is
// `recorded`, not `paid`. Runs for the same workspace and payee type are
// serialised by an advisory lock, so a double click cannot pay twice.
router.post('/payouts/run', requirePermission('commissions.manage'), asyncHandler(async (req, res) => {
  const { payeeType, targetId = null } = req.body || {};
  const sql = PAYOUT_SQL[payeeType];
  if (!sql) return res.status(400).json({ error: 'invalid_payeeType' });
  const to = req.body.to ? new Date(req.body.to) : new Date();
  const from = req.body.from ? new Date(req.body.from) : new Date(Date.now() - 30 * 86400000);
  const F = from.toISOString(), T = to.toISOString();

  const runs = await withWorkspace(wid(req), uid(req), async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payout:${wid(req)}:${payeeType}`]);
    const cur = (await c.query('SELECT currency FROM workspaces WHERE id=$1', [wid(req)])).rows[0].currency;
    const rows = (await c.query(sql.unpaid, [F, T, targetId])).rows;
    const out = [];
    for (const r of rows) {
      const pay = (await c.query(sql.insert,
        [wid(req), r.rid, r.ps || F.slice(0, 10), r.pe || T.slice(0, 10), r.amount, cur])).rows[0];
      const settled = await c.query(sql.settle, [pay.id, r.rid, F, T]);
      if (settled.rowCount === 0) throw new Error(`payout ${pay.id} settled no entries`);
      out.push({ recipientId: r.rid, amount: Number(r.amount), payoutId: pay.id });
    }
    return out;
  });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'payout.run', metadata: { payeeType, targetId, count: runs.length, total: runs.reduce((s, r) => s + r.amount, 0) } });
  res.json({ ran: runs.length, total: runs.reduce((s, r) => s + r.amount, 0), payouts: runs });
}));

// POST /workspaces/:wid/transactions/:txId/refund  { external?: bool, amount? }
// Refunds at the provider (when the refund endpoint is configured) and posts the
// reversal to the ledger. `external: true` records a refund already issued in the
// provider's own dashboard. Idempotent: a second call is rejected by fn_post_refund.
router.post('/transactions/:txId/refund', requirePermission('commissions.manage'), asyncHandler(async (req, res) => {
  // MantaPay's refund API isn't implemented yet — it's a two-step request
  // approved by their admins. Until it is, refunds are issued in their
  // dashboard and recorded here (`external: true`). Once we build the adapter,
  // set MANTAPAY_REFUND_ENABLED=true to re-enable provider-side refunds.
  const providerRefundAvailable = !!config.mantapayRefundEnabled;
  const external = providerRefundAvailable ? !!(req.body && req.body.external) : true;
  const result = await withWorkspace(wid(req), uid(req), async (c) => {
    const t = (await c.query(
      'SELECT id, gross, currency, provider_transaction_id, payment_link_id FROM transactions WHERE id=$1 AND workspace_id=$2',
      [req.params.txId, wid(req)])).rows[0];
    if (!t) return { notFound: true };
    const sale = (await c.query("SELECT 1 FROM commission_entries WHERE transaction_id=$1 AND entry_type='sale'", [t.id])).rows[0];
    if (!sale) return { noSale: true };
    const already = (await c.query("SELECT entry_type FROM commission_entries WHERE transaction_id=$1 AND entry_type IN ('refund','chargeback')", [t.id])).rows[0];
    if (already) return { already: already.entry_type };

    if (!external) {
      const ws = (await c.query('SELECT id, mid, provider_config_ref FROM workspaces WHERE id=$1', [wid(req)])).rows[0];
      const prid = t.payment_link_id
        ? (await c.query('SELECT provider_request_id FROM payment_links WHERE id=$1', [t.payment_link_id])).rows[0]
        : null;
      const paymentRequestId = (prid && prid.provider_request_id) || t.provider_transaction_id;
      if (!paymentRequestId) return { noProviderId: true };
      await provider.refundPayment(provider.resolveApiKey(ws), paymentRequestId, req.body && req.body.amount);
    }

    const entry = (await c.query('SELECT * FROM fn_post_refund($1)', [t.id])).rows[0];
    await c.query("UPDATE transactions SET status='refunded'::txn_status WHERE id=$1", [t.id]).catch(() => {});
    if (t.payment_link_id) await c.query("UPDATE payment_links SET status='refunded' WHERE id=$1", [t.payment_link_id]);
    return { entry, gross: Number(t.gross), currency: t.currency };
  });

  if (result.notFound) return res.status(404).json({ error: 'transaction_not_found' });
  if (result.noSale) return res.status(400).json({ error: 'no_sale_to_refund' });
  if (result.already) return res.status(409).json({ error: 'already_reversed', as: result.already });
  if (result.noProviderId) return res.status(400).json({ error: 'no_provider_reference', detail: 'Cannot refund at the provider without its payment request id. Record as external instead.' });

  const e = result.entry;
  res.json({
    ok: true, external, providerRefundAvailable,
    refunded: result.gross, currency: result.currency,
    refundFee: Number(e.chargeback_fee || 0),
    accountAdjustment: Number(e.account_amount || 0),
    agentAdjustment: Number(e.agent_amount || 0),
    agencyAdjustment: Number(e.agency_amount || 0),
  });
}));

module.exports = router;
