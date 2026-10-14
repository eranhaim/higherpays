'use strict';
const express = require('express');
const { pool, query, withTransaction } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { cashPosition } = require('../services/cash');
const currencies = require('../services/currencies.service');
const { status: vocab } = require('../schema/entities');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');
const num = (v) => Number(v || 0);
const round2 = (v) => Math.round(v * 100) / 100;

function range(req, source) {
  const to = source.to ? new Date(source.to) : new Date();
  const from = source.from ? new Date(source.from) : new Date(Date.now() - 30 * 86400000);
  return { F: from.toISOString(), T: to.toISOString() };
}

// GET /?limit&q&payeeType&status&from&to&currency — payout history, newest
// first. Every row carries its own currency and nothing here is totalled, so
// `currency` is an optional filter rather than a resolved reporting currency.
router.get('/', requirePermission('revenue.view'), asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const payeeType = req.query.payeeType || null;
  const status = req.query.status || null;
  if (payeeType && !vocab.PAYEE_TYPE.includes(payeeType)) return res.status(400).json({ error: 'invalid_payeeType' });
  if (status && !vocab.PAYOUT_STATUS.includes(status)) return res.status(400).json({ error: 'invalid_status' });
  const search = String(req.query.q || '').trim() || null;
  const from = req.query.from || null;
  const to = req.query.to || null;
  const rows = (await query(`
    SELECT p.id, p.payee_type, p.period_start::text AS period_start, p.period_end::text AS period_end, p.net, p.currency, p.status, p.created_at,
           COALESCE(a.name, u.full_name, w.name) AS payee
      FROM payouts p
      JOIN workspaces w ON w.id = p.workspace_id
      LEFT JOIN accounts a ON a.id = p.account_id
      LEFT JOIN agents ag ON ag.id = p.agent_id
      LEFT JOIN users u ON u.id = ag.user_id
     WHERE p.workspace_id = $1
       AND ($2::text IS NULL OR COALESCE(a.name, u.full_name, w.name, '') ILIKE '%' || $2 || '%')
       AND ($3::text IS NULL OR p.payee_type = $3)
       AND ($4::text IS NULL OR p.status = $4)
       AND ($5::date IS NULL OR p.created_at >= $5::date)
       AND ($6::date IS NULL OR p.created_at < $6::date + interval '1 day')
       AND ($7::text IS NULL OR p.currency = $7::text)
     ORDER BY p.created_at DESC, p.id DESC LIMIT $8`,
    [wid(req), search, payeeType, status, from, to,
      currencies.isCurrencyCode(req.query.currency) ? currencies.normalise(req.query.currency) : null,
      limit])).rows;
  res.json({
    payouts: rows.map((r) => ({
      id: r.id, payeeType: r.payee_type, payee: r.payee, periodStart: r.period_start, periodEnd: r.period_end,
      amount: num(r.net), currency: r.currency, status: r.status, createdAt: r.created_at,
    })),
  });
}));

// GET /breakdown?from&to&currency — accrued owed per account and per agent,
// the reserve the provider holds, and whether the agency can pay everyone
// today — all in ONE currency, resolved server-side and echoed back.
//
// Nothing on this route is summed across currencies. "Currently owed" in two
// currencies is two debts, settled by two payouts, and a single figure for
// them would be payable in neither.
router.get('/breakdown', requirePermission('revenue.view'), asyncHandler(async (req, res) => {
  const { F, T } = range(req, req.query);
  const currency = await currencies.resolveReportingCurrency(pool, wid(req), req.query.currency);
  const baseCurrency = (await query('SELECT currency FROM workspaces WHERE id=$1', [wid(req)])).rows[0].currency;
  // A salaried creator earns nothing per sale; they are owed one salary for
  // the period, unless a payout already covers part of it. The salary is owed
  // in the base currency only, so it does not appear in a second currency's
  // breakdown at all.
  const perAccount = (await query(`
    SELECT a.id, a.name, a.pay_model, COALESCE(agg.revenue,0) AS revenue,
           CASE WHEN a.pay_model = 'salary'
                THEN CASE WHEN paid.covered OR $4::text <> $5::text THEN 0 ELSE a.salary_amount END
                ELSE COALESCE(agg.owed,0) END AS owed
      FROM accounts a
      LEFT JOIN (
        SELECT re.account_id, SUM(re.gross) AS revenue,
               SUM(re.account_amount) FILTER (WHERE re.account_payout_id IS NULL) AS owed
          FROM revenue_entries re
          JOIN transactions t ON t.id = re.transaction_id
          JOIN payments pay ON pay.id = t.payment_id AND pay.archived_at IS NULL
         WHERE re.workspace_id = $3 AND t.occurred_at >= $1 AND t.occurred_at <= $2
           AND t.currency = $4::text
         GROUP BY re.account_id
      ) agg ON agg.account_id = a.id
      LEFT JOIN LATERAL (
        SELECT true AS covered FROM payouts p
         WHERE p.workspace_id = $3 AND p.account_id = a.id AND p.currency = $4::text
           AND p.period_start <= $2::date AND p.period_end >= $1::date LIMIT 1
      ) paid ON true
     WHERE a.workspace_id = $3 ORDER BY owed DESC`, [F, T, wid(req), currency, baseCurrency])).rows;
  const perAgent = (await query(`
    SELECT ag.id, u.full_name AS name, COALESCE(agg.owed,0) AS owed, COALESCE(agg.sales,0) AS sales
      FROM agents ag JOIN users u ON u.id = ag.user_id
      LEFT JOIN (
        SELECT re.agent_id, SUM(re.agent_amount) FILTER (WHERE re.agent_payout_id IS NULL) AS owed,
               COUNT(*) FILTER (WHERE re.entry_type='sale') AS sales
          FROM revenue_entries re
          JOIN transactions t ON t.id = re.transaction_id
          JOIN payments pay ON pay.id = t.payment_id AND pay.archived_at IS NULL
         WHERE re.workspace_id = $3 AND t.occurred_at >= $1 AND t.occurred_at <= $2
           AND t.currency = $4::text
         GROUP BY re.agent_id
      ) agg ON agg.agent_id = ag.id
     WHERE ag.workspace_id = $3 ORDER BY owed DESC`, [F, T, wid(req), currency])).rows;

  // Rolling reserve: the provider holds a % of settled volume. It is the
  // agency's own money, released later, but until then the agency fronts it.
  const cfg = (await query('SELECT reserve_pct, reserve_release_days FROM effective_settlement_fees($1, now())', [wid(req)])).rows[0] || {};
  const pct = num(cfg.reserve_pct), days = num(cfg.reserve_release_days);
  const settled = (await query(
    `SELECT count(*) AS imported, COALESCE(SUM(reserve) FILTER (
        WHERE reserve > 0 AND ($2 = 0 OR (settlement_date + ($2 || ' days')::interval)::date > now()::date)), 0) AS held
       FROM settlements WHERE workspace_id = $1 AND currency = $3::text`,
    [wid(req), String(days), currency])).rows[0];
  let reserve;
  if (num(settled.imported) > 0) {
    reserve = { pct, releaseDays: days, held: round2(num(settled.held)), source: 'settlements' };
  } else {
    const gross = (await query(
      `SELECT GREATEST(COALESCE(SUM(re.gross),0),0) AS g
         FROM revenue_entries re
         JOIN transactions t ON t.id = re.transaction_id
         JOIN payments pay ON pay.id = t.payment_id AND pay.archived_at IS NULL
        WHERE re.workspace_id = $3 AND t.occurred_at >= $1 AND t.occurred_at <= $2
          AND t.currency = $4::text`,
      [F, T, wid(req), currency])).rows[0].g;
    reserve = { pct, releaseDays: days, held: round2(num(gross) * pct / 100), source: 'estimated' };
  }

  const received = num((await query(
    `SELECT COALESCE(SUM(re.distributable - re.chargeback_fee),0) AS received
       FROM revenue_entries re
       JOIN transactions t ON t.id = re.transaction_id
       JOIN payments pay ON pay.id = t.payment_id AND pay.archived_at IS NULL
      WHERE re.workspace_id = $3 AND t.occurred_at >= $1 AND t.occurred_at <= $2
        AND t.currency = $4::text`, [F, T, wid(req), currency])).rows[0].received);
  const accountsOwed = perAccount.reduce((s, r) => s + num(r.owed), 0);
  const agentsOwed = perAgent.reduce((s, r) => s + num(r.owed), 0);
  const summary = (await query(
    `SELECT COALESCE(SUM(re.gross) FILTER (WHERE re.entry_type='sale'),0) AS gross_sales,
            COALESCE(SUM(re.distributable),0) AS distributable,
            COUNT(*) FILTER (WHERE re.entry_type='sale')::int AS successful_sales
       FROM revenue_entries re
       JOIN transactions t ON t.id = re.transaction_id
       JOIN payments pay ON pay.id = t.payment_id AND pay.archived_at IS NULL
      WHERE re.workspace_id = $3 AND t.occurred_at >= $1 AND t.occurred_at <= $2
        AND t.currency = $4::text`,
    [F, T, wid(req), currency])).rows[0];
  const paidToDate = (await query(
    `SELECT COALESCE(SUM(net),0) AS paid
       FROM payouts
      WHERE workspace_id=$1 AND status IN ('approved','paid') AND currency = $2::text`,
    [wid(req), currency])).rows[0].paid;

  res.json({
    range: { from: F, to: T },
    currency,
    summary: {
      grossSales: num(summary.gross_sales),
      distributable: num(summary.distributable),
      successfulSales: num(summary.successful_sales),
      paidToDate: num(paidToDate),
      currentlyOwed: accountsOwed + agentsOwed,
    },
    perAccount: perAccount.map((r) => ({
      id: r.id, name: r.name, payModel: r.pay_model, revenue: num(r.revenue), owed: num(r.owed),
    })),
    perAgent: perAgent.map((r) => ({ id: r.id, name: r.name, owed: num(r.owed), sales: num(r.sales) })),
    reserve,
    cash: cashPosition({ owed: accountsOwed + agentsOwed, received, held: reserve.held }),
  });
}));

// One fixed statement set per payee type: the money path carries no
// string-built SQL. $1 workspace, $2 from, $3 to, $4 optional target
// (NULL = everyone), $5 currency.
//
// A payout is one amount paid to one payee, so it is in one currency. The
// unpaid balance is therefore grouped by the transaction's currency and never
// summed across them, and `settle` marks only the entries in that currency —
// otherwise a EUR payout would close out the GBP entries it never paid.
const PAYOUT_SQL = {
  account: {
    unpaid: `
      SELECT re.account_id AS rid, SUM(re.account_amount) AS amount,
             MIN(t.occurred_at)::date AS ps, MAX(t.occurred_at)::date AS pe
        FROM revenue_entries re
        JOIN transactions t ON t.id = re.transaction_id
        JOIN payments pay ON pay.id = t.payment_id AND pay.archived_at IS NULL
       WHERE re.workspace_id = $1 AND t.occurred_at >= $2 AND t.occurred_at <= $3
         AND re.account_payout_id IS NULL AND re.account_id IS NOT NULL
         AND ($4::uuid IS NULL OR re.account_id = $4::uuid)
         AND t.currency = $5::text
       GROUP BY re.account_id HAVING SUM(re.account_amount) > 0`,
    insert: `
      INSERT INTO payouts (workspace_id, payee_type, account_id, period_start, period_end, net, currency, status)
      VALUES ($1, 'account', $2, $3, $4, $5, $6, 'approved') RETURNING id`,
    settle: `
      UPDATE revenue_entries SET account_payout_id = $1, account_paid_at = now()
       WHERE workspace_id = $5 AND account_id = $2 AND account_payout_id IS NULL
         AND transaction_id IN (
           SELECT t.id FROM transactions t
           JOIN payments p ON p.id = t.payment_id AND p.archived_at IS NULL
          WHERE t.occurred_at >= $3 AND t.occurred_at <= $4 AND t.currency = $6::text
         )`,
  },
  agent: {
    unpaid: `
      SELECT re.agent_id AS rid, SUM(re.agent_amount) AS amount,
             MIN(t.occurred_at)::date AS ps, MAX(t.occurred_at)::date AS pe
        FROM revenue_entries re
        JOIN transactions t ON t.id = re.transaction_id
        JOIN payments pay ON pay.id = t.payment_id AND pay.archived_at IS NULL
       WHERE re.workspace_id = $1 AND t.occurred_at >= $2 AND t.occurred_at <= $3
         AND re.agent_payout_id IS NULL AND re.agent_id IS NOT NULL
         AND ($4::uuid IS NULL OR re.agent_id = $4::uuid)
         AND t.currency = $5::text
       GROUP BY re.agent_id HAVING SUM(re.agent_amount) > 0`,
    insert: `
      INSERT INTO payouts (workspace_id, payee_type, agent_id, period_start, period_end, net, currency, status)
      VALUES ($1, 'agent', $2, $3, $4, $5, $6, 'approved') RETURNING id`,
    settle: `
      UPDATE revenue_entries SET agent_payout_id = $1, agent_paid_at = now()
       WHERE workspace_id = $5 AND agent_id = $2 AND agent_payout_id IS NULL
         AND transaction_id IN (
           SELECT t.id FROM transactions t
           JOIN payments p ON p.id = t.payment_id AND p.archived_at IS NULL
          WHERE t.occurred_at >= $3 AND t.occurred_at <= $4 AND t.currency = $6::text
         )`,
  },
};

// POST /run  { payeeType, targetId?, from?, to?, currency? } — record a payout
// for unpaid balances in ONE currency. No rail moves money yet, so the row is
// `approved`, not `paid`. Runs for the same workspace, payee type and currency
// are serialised by an advisory lock, so a double click cannot pay twice.
router.post('/run', requirePermission('revenue.manage'), asyncHandler(async (req, res) => {
  const { payeeType, targetId = null } = req.body || {};
  const sql = PAYOUT_SQL[payeeType];
  if (!sql) return res.status(400).json({ error: 'invalid_payeeType' });
  const { F, T } = range(req, req.body || {});

  const out = await withTransaction(async (c) => {
    const cur = await currencies.resolveReportingCurrency(c, wid(req), (req.body || {}).currency);
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payout:${wid(req)}:${payeeType}:${cur}`]);
    const rows = (await c.query(sql.unpaid, [wid(req), F, T, targetId, cur])).rows;
    const runs = [];
    for (const r of rows) {
      const pay = (await c.query(sql.insert, [wid(req), r.rid, r.ps || F.slice(0, 10), r.pe || T.slice(0, 10), r.amount, cur])).rows[0];
      const settled = await c.query(sql.settle, [pay.id, r.rid, F, T, wid(req), cur]);
      if (settled.rowCount === 0) throw new Error(`payout ${pay.id} settled no entries`);
      runs.push({ recipientId: r.rid, amount: Number(r.amount), payoutId: pay.id });
    }

    // A salary has no revenue entries to settle: it is owed for the period
    // itself. An overlapping payout means this period is already covered, so
    // running the same range twice cannot pay it twice.
    //
    // salary_amount carries no currency of its own, so a salary is owed in the
    // agency's base currency. The overlap guard is therefore per currency as
    // well: a GBP sales payout for the same period is a different debt and
    // must not read as the salary already being covered.
    if (payeeType === 'account') {
      const salaried = (await c.query(`
        SELECT a.id, a.salary_amount FROM accounts a
         WHERE a.workspace_id = $1 AND a.pay_model = 'salary' AND a.salary_amount > 0
           AND a.status <> 'archived'
           AND ($2::uuid IS NULL OR a.id = $2::uuid)
           AND $5::text = (SELECT w.currency FROM workspaces w WHERE w.id = $1)
           AND NOT EXISTS (
             SELECT 1 FROM payouts p
              WHERE p.workspace_id = $1 AND p.account_id = a.id
                AND p.currency = $5::text
                AND p.period_start <= $4::date AND p.period_end >= $3::date)`,
        [wid(req), targetId, F, T, cur])).rows;
      for (const s of salaried) {
        const pay = (await c.query(sql.insert,
          [wid(req), s.id, F.slice(0, 10), T.slice(0, 10), s.salary_amount, cur])).rows[0];
        runs.push({ recipientId: s.id, amount: Number(s.salary_amount), payoutId: pay.id, salary: true });
      }
    }
    return { runs, currency: cur };
  });
  const total = out.runs.reduce((s, r) => s + r.amount, 0);
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'payout.run', metadata: { payeeType, targetId, currency: out.currency, count: out.runs.length, total } });
  res.json({ ran: out.runs.length, total, currency: out.currency, payouts: out.runs });
}));

module.exports = router;
