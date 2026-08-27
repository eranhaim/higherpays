'use strict';
const express = require('express');
const { query, withTransaction } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { cashPosition } = require('../services/cash');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');
const num = (v) => Number(v || 0);
const round2 = (v) => Math.round(v * 100) / 100;

function range(req, source) {
  const to = source.to ? new Date(source.to) : new Date();
  const from = source.from ? new Date(source.from) : new Date(Date.now() - 30 * 86400000);
  return { F: from.toISOString(), T: to.toISOString() };
}

// GET /?limit — every payout run, newest first, with who was paid.
router.get('/', requirePermission('revenue.view'), asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const rows = (await query(`
    SELECT p.id, p.payee_type, p.period_start::text AS period_start, p.period_end::text AS period_end, p.net, p.currency, p.status, p.created_at,
           COALESCE(a.name, u.full_name) AS payee
      FROM payouts p
      LEFT JOIN accounts a ON a.id = p.account_id
      LEFT JOIN agents ag ON ag.id = p.agent_id
      LEFT JOIN users u ON u.id = ag.user_id
     WHERE p.workspace_id = $1
     ORDER BY p.created_at DESC, p.id DESC LIMIT $2`, [wid(req), limit])).rows;
  res.json({
    payouts: rows.map((r) => ({
      id: r.id, payeeType: r.payee_type, payee: r.payee, periodStart: r.period_start, periodEnd: r.period_end,
      amount: num(r.net), currency: r.currency, status: r.status, createdAt: r.created_at,
    })),
  });
}));

// GET /breakdown?from&to — accrued owed per account and per agent, the reserve
// the provider holds, and whether the agency can pay everyone today.
router.get('/breakdown', requirePermission('revenue.view'), asyncHandler(async (req, res) => {
  const { F, T } = range(req, req.query);
  const perAccount = (await query(`
    SELECT a.id, a.name, COALESCE(agg.revenue,0) AS revenue, COALESCE(agg.owed,0) AS owed
      FROM accounts a
      LEFT JOIN (
        SELECT re.account_id, SUM(re.gross) AS revenue,
               SUM(re.account_amount) FILTER (WHERE re.account_payout_id IS NULL) AS owed
          FROM revenue_entries re JOIN transactions t ON t.id = re.transaction_id
         WHERE re.workspace_id = $3 AND t.occurred_at >= $1 AND t.occurred_at <= $2 GROUP BY re.account_id
      ) agg ON agg.account_id = a.id
     WHERE a.workspace_id = $3 ORDER BY owed DESC`, [F, T, wid(req)])).rows;
  const perAgent = (await query(`
    SELECT ag.id, u.full_name AS name, COALESCE(agg.owed,0) AS owed, COALESCE(agg.sales,0) AS sales
      FROM agents ag JOIN users u ON u.id = ag.user_id
      LEFT JOIN (
        SELECT re.agent_id, SUM(re.agent_amount) FILTER (WHERE re.agent_payout_id IS NULL) AS owed,
               COUNT(*) FILTER (WHERE re.entry_type='sale') AS sales
          FROM revenue_entries re JOIN transactions t ON t.id = re.transaction_id
         WHERE re.workspace_id = $3 AND t.occurred_at >= $1 AND t.occurred_at <= $2 GROUP BY re.agent_id
      ) agg ON agg.agent_id = ag.id
     WHERE ag.workspace_id = $3 ORDER BY owed DESC`, [F, T, wid(req)])).rows;

  // Rolling reserve: the provider holds a % of settled volume. It is the
  // agency's own money, released later, but until then the agency fronts it.
  const cfg = (await query('SELECT reserve_pct, reserve_release_days FROM effective_settlement_fees($1, now())', [wid(req)])).rows[0] || {};
  const pct = num(cfg.reserve_pct), days = num(cfg.reserve_release_days);
  const settled = (await query(
    `SELECT count(*) AS imported, COALESCE(SUM(reserve) FILTER (
        WHERE reserve > 0 AND ($2 = 0 OR (settlement_date + ($2 || ' days')::interval)::date > now()::date)), 0) AS held
       FROM settlements WHERE workspace_id = $1`, [wid(req), String(days)])).rows[0];
  let reserve;
  if (num(settled.imported) > 0) {
    reserve = { pct, releaseDays: days, held: round2(num(settled.held)), source: 'settlements' };
  } else {
    const gross = (await query(
      `SELECT COALESCE(SUM(gross),0) AS g FROM transactions
        WHERE workspace_id = $3 AND status='approved' AND occurred_at>=$1 AND occurred_at<=$2`, [F, T, wid(req)])).rows[0].g;
    reserve = { pct, releaseDays: days, held: round2(num(gross) * pct / 100), source: 'estimated' };
  }

  const received = num((await query(
    `SELECT COALESCE(SUM(re.distributable),0) AS received
       FROM revenue_entries re JOIN transactions t ON t.id = re.transaction_id
      WHERE re.workspace_id = $3 AND t.occurred_at >= $1 AND t.occurred_at <= $2`, [F, T, wid(req)])).rows[0].received);
  const accountsOwed = perAccount.reduce((s, r) => s + num(r.owed), 0);
  const agentsOwed = perAgent.reduce((s, r) => s + num(r.owed), 0);

  res.json({
    range: { from: F, to: T },
    perAccount: perAccount.map((r) => ({ id: r.id, name: r.name, revenue: num(r.revenue), owed: num(r.owed) })),
    perAgent: perAgent.map((r) => ({ id: r.id, name: r.name, owed: num(r.owed), sales: num(r.sales) })),
    reserve,
    cash: cashPosition({ owed: accountsOwed + agentsOwed, received, held: reserve.held }),
  });
}));

// One fixed statement set per payee type: the money path carries no
// string-built SQL. $1 workspace, $2 from, $3 to, $4 optional target (NULL = everyone).
const PAYOUT_SQL = {
  account: {
    unpaid: `
      SELECT re.account_id AS rid, SUM(re.account_amount) AS amount,
             MIN(t.occurred_at)::date AS ps, MAX(t.occurred_at)::date AS pe
        FROM revenue_entries re JOIN transactions t ON t.id = re.transaction_id
       WHERE re.workspace_id = $1 AND t.occurred_at >= $2 AND t.occurred_at <= $3
         AND re.account_payout_id IS NULL AND re.account_id IS NOT NULL
         AND ($4::uuid IS NULL OR re.account_id = $4::uuid)
       GROUP BY re.account_id HAVING SUM(re.account_amount) > 0`,
    insert: `
      INSERT INTO payouts (workspace_id, payee_type, account_id, period_start, period_end, net, currency, status)
      VALUES ($1, 'account', $2, $3, $4, $5, $6, 'approved') RETURNING id`,
    settle: `
      UPDATE revenue_entries SET account_payout_id = $1, account_paid_at = now()
       WHERE workspace_id = $5 AND account_id = $2 AND account_payout_id IS NULL
         AND transaction_id IN (SELECT id FROM transactions WHERE occurred_at >= $3 AND occurred_at <= $4)`,
  },
  agent: {
    unpaid: `
      SELECT re.agent_id AS rid, SUM(re.agent_amount) AS amount,
             MIN(t.occurred_at)::date AS ps, MAX(t.occurred_at)::date AS pe
        FROM revenue_entries re JOIN transactions t ON t.id = re.transaction_id
       WHERE re.workspace_id = $1 AND t.occurred_at >= $2 AND t.occurred_at <= $3
         AND re.agent_payout_id IS NULL AND re.agent_id IS NOT NULL
         AND ($4::uuid IS NULL OR re.agent_id = $4::uuid)
       GROUP BY re.agent_id HAVING SUM(re.agent_amount) > 0`,
    insert: `
      INSERT INTO payouts (workspace_id, payee_type, agent_id, period_start, period_end, net, currency, status)
      VALUES ($1, 'agent', $2, $3, $4, $5, $6, 'approved') RETURNING id`,
    settle: `
      UPDATE revenue_entries SET agent_payout_id = $1, agent_paid_at = now()
       WHERE workspace_id = $5 AND agent_id = $2 AND agent_payout_id IS NULL
         AND transaction_id IN (SELECT id FROM transactions WHERE occurred_at >= $3 AND occurred_at <= $4)`,
  },
};

// POST /run  { payeeType, targetId?, from?, to? } — record a payout for unpaid
// balances. No rail moves money yet, so the row is `approved`, not `paid`.
// Runs for the same workspace and payee type are serialised by an advisory
// lock, so a double click cannot pay twice.
router.post('/run', requirePermission('revenue.manage'), asyncHandler(async (req, res) => {
  const { payeeType, targetId = null } = req.body || {};
  const sql = PAYOUT_SQL[payeeType];
  if (!sql) return res.status(400).json({ error: 'invalid_payeeType' });
  const { F, T } = range(req, req.body || {});

  const runs = await withTransaction(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payout:${wid(req)}:${payeeType}`]);
    const cur = (await c.query('SELECT currency FROM workspaces WHERE id=$1', [wid(req)])).rows[0].currency;
    const rows = (await c.query(sql.unpaid, [wid(req), F, T, targetId])).rows;
    const out = [];
    for (const r of rows) {
      const pay = (await c.query(sql.insert, [wid(req), r.rid, r.ps || F.slice(0, 10), r.pe || T.slice(0, 10), r.amount, cur])).rows[0];
      const settled = await c.query(sql.settle, [pay.id, r.rid, F, T, wid(req)]);
      if (settled.rowCount === 0) throw new Error(`payout ${pay.id} settled no entries`);
      out.push({ recipientId: r.rid, amount: Number(r.amount), payoutId: pay.id });
    }
    return out;
  });
  const total = runs.reduce((s, r) => s + r.amount, 0);
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'payout.run', metadata: { payeeType, targetId, count: runs.length, total } });
  res.json({ ran: runs.length, total, payouts: runs });
}));

module.exports = router;
