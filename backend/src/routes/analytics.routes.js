'use strict';
// Real aggregations over the revenue ledger. A sale is a positive 'sale' row
// and a reversal a negative row, so summing a column yields the true
// reversal-adjusted figure. Scope:
//   workspace — everything, plus the agent/account pivots
//   agent     — only rows credited to them
//   account   — only rows for their account
// Scoped callers also lose the agency-side figures.
const express = require('express');
const { withTransaction } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { resolveDataScope } = require('../auth/dataScope');

const router = express.Router({ mergeParams: true });
const { wid } = require('../lib/scope');
const num = (v) => Number(v || 0);

function range(req) {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
  return { from: from.toISOString(), to: to.toISOString(), days: Math.max(1, Math.round((to - from) / 86400000)) };
}

router.get('/', requirePermission('analytics.view'), asyncHandler(async (req, res) => {
  const { from, to, days } = range(req);

  const out = await withTransaction(async (c) => {
    const scope = await resolveDataScope(c, req);
    let col = null, linkCol = null, payCol = null, val = null;
    if (scope.kind === 'agent') {
      col = 're.agent_id'; linkCol = 'pl.created_by_agent_id'; payCol = 'p.agent_id'; val = scope.agentId;
    } else if (scope.kind === 'account') {
      col = 're.account_id'; linkCol = 'pl.account_id'; payCol = 'p.account_id'; val = scope.accountId;
    } else if (req.query.agentId) {
      col = 're.agent_id'; linkCol = 'pl.created_by_agent_id'; payCol = 'p.agent_id'; val = req.query.agentId;
    } else if (req.query.accountId) {
      col = 're.account_id'; linkCol = 'pl.account_id'; payCol = 'p.account_id'; val = req.query.accountId;
    }
    const scoped = val != null;
    // $1 from, $2 to, $3 workspace, ($4 scope)
    const P = scoped ? [from, to, wid(req), val] : [from, to, wid(req)];
    const RE_FROM = 'FROM revenue_entries re JOIN transactions t ON t.id = re.transaction_id JOIN payments p ON p.id = t.payment_id';
    const RE_WHERE = 'WHERE re.workspace_id = $3 AND t.occurred_at >= $1 AND t.occurred_at <= $2' + (scoped ? ` AND ${col} = $4` : '');

    const h = (await c.query(`
      SELECT
        COALESCE(SUM(re.gross) FILTER (WHERE re.entry_type='sale'),0)             AS gross_sales,
        COALESCE(SUM(re.distributable),0)                                          AS net,
        COALESCE(SUM(re.platform_fee),0)                                           AS platform_fee,
        COALESCE(SUM(re.account_amount),0)                                         AS account_payout,
        COALESCE(SUM(re.agent_amount),0)                                           AS agent_payout,
        COALESCE(SUM(re.agency_amount),0)                                          AS agency_keep,
        COUNT(*) FILTER (WHERE re.entry_type='sale')                               AS sale_count,
        COUNT(*) FILTER (WHERE re.entry_type IN ('chargeback','refund'))           AS cb_count,
        COALESCE(-SUM(re.gross) FILTER (WHERE re.entry_type IN ('chargeback','refund')),0) AS cb_gross,
        COALESCE(SUM(re.chargeback_fee) FILTER (WHERE re.entry_type IN ('chargeback','refund')),0) AS cb_fee,
        COALESCE(-SUM(re.account_amount) FILTER (WHERE re.entry_type IN ('chargeback','refund')),0) AS cb_account_borne,
        COALESCE(-SUM(re.agency_amount)  FILTER (WHERE re.entry_type IN ('chargeback','refund')),0) AS cb_agency_borne,
        COUNT(DISTINCT p.customer_id) FILTER (WHERE re.entry_type='sale')          AS buyers
      ${RE_FROM} ${RE_WHERE}`, P)).rows[0];
    const grossSales = num(h.gross_sales), agencyKeep = num(h.agency_keep), saleCount = num(h.sale_count);

    const ts = (await c.query(`
      SELECT to_char(date_trunc('day', t.occurred_at),'YYYY-MM-DD') AS d,
             COALESCE(SUM(re.gross),0) AS gross, COALESCE(SUM(re.distributable),0) AS net
      ${RE_FROM} ${RE_WHERE} GROUP BY 1 ORDER BY 1`, P)).rows
      .map((r) => ({ d: r.d, gross: num(r.gross), net: num(r.net) }));

    // Link funnel: links issued in the window, and what happened to them.
    const linkWhere = 'WHERE pl.workspace_id = $3 AND pl.created_at >= $1 AND pl.created_at <= $2' + (scoped ? ` AND ${linkCol} = $4` : '');
    const fn = (await c.query(`
      SELECT COUNT(*) AS created,
        COUNT(*) FILTER (WHERE pl.status IN ('pending','done') OR pl.paid_at IS NOT NULL
                            OR EXISTS (SELECT 1 FROM payments p WHERE p.payment_link_id = pl.id AND p.status = 'paid')) AS paid,
        COUNT(*) FILTER (WHERE pl.status = 'cancelled') AS cancelled,
        COUNT(*) FILTER (WHERE pl.status = 'expired' OR (pl.status = 'active' AND pl.expires_at < now())) AS expired
      FROM payment_links pl ${linkWhere}`, P)).rows[0];
    const created = num(fn.created);
    const failed = num((await c.query(`
      SELECT COUNT(*) AS c FROM payments p
       WHERE p.workspace_id = $3 AND p.status = 'failed' AND p.occurred_at >= $1 AND p.occurred_at <= $2
         ${scoped ? `AND ${payCol} = $4` : ''}`, P)).rows[0].c);

    const agents = (await c.query(`
      SELECT u.full_name AS name, ag.id AS agent_id,
             COALESCE(SUM(re.gross),0) AS revenue, COALESCE(SUM(re.agency_amount),0) AS agency_profit,
             COUNT(*) FILTER (WHERE re.entry_type='sale') AS sales
      ${RE_FROM} JOIN agents ag ON ag.id = re.agent_id JOIN users u ON u.id = ag.user_id
      ${RE_WHERE} GROUP BY u.full_name, ag.id ORDER BY revenue DESC`, P)).rows;
    const agentLinks = (await c.query(`
      SELECT pl.created_by_agent_id AS agent_id, COUNT(*) AS created,
             COUNT(*) FILTER (WHERE pl.status IN ('pending','done')) AS paid
      FROM payment_links pl ${linkWhere} AND pl.created_by_agent_id IS NOT NULL GROUP BY pl.created_by_agent_id`, P)).rows;
    const byAgent = Object.fromEntries(agentLinks.map((r) => [r.agent_id, r]));

    const accounts = (await c.query(`
      SELECT a.name, COALESCE(SUM(re.gross),0) AS revenue,
             COALESCE(SUM(re.account_amount),0) AS account_payout, COALESCE(SUM(re.agency_amount),0) AS agency_profit
      ${RE_FROM} JOIN accounts a ON a.id = re.account_id
      ${RE_WHERE} GROUP BY a.name ORDER BY revenue DESC`, P)).rows;

    const perCust = (await c.query(`
      SELECT p.customer_id AS id, COALESCE(SUM(re.gross),0) AS rev
      ${RE_FROM} ${RE_WHERE} AND re.entry_type='sale' AND p.customer_id IS NOT NULL
      GROUP BY p.customer_id ORDER BY rev DESC`, P)).rows.map((r) => num(r.rev));
    const totRev = perCust.reduce((a, b) => a + b, 0) || 1;
    const topShare = (share) => { const k = Math.max(1, Math.ceil(perCust.length * share)); return Math.round(perCust.slice(0, k).reduce((a, b) => a + b, 0) / totRev * 100); };

    // Repeat buying is all-time, not period-scoped: a fan is a repeat buyer
    // whenever their second purchase happened.
    const repeat = (await c.query(`
      SELECT COUNT(*) FILTER (WHERE n>=2) AS repeat_c, COUNT(*) AS any_c, COALESCE(AVG(n),0) AS freq
        FROM (SELECT p.customer_id, COUNT(*) n FROM payments p
               WHERE p.workspace_id = $1 AND p.status='paid' AND p.customer_id IS NOT NULL
                 AND ($2::uuid IS NULL OR ${payCol || 'p.id'} = $2::uuid)
               GROUP BY p.customer_id) q`, [wid(req), scoped ? val : null])).rows[0];
    const categories = (await c.query(`
      SELECT COALESCE(ca.name, 'Uncategorised') AS category, COALESCE(SUM(re.gross),0) AS rev
      ${RE_FROM} LEFT JOIN categories ca ON ca.id = p.category_id
      ${RE_WHERE} AND re.entry_type='sale' GROUP BY ca.name ORDER BY rev DESC`, P)).rows
      .map((r) => ({ category: r.category, revenue: num(r.rev) }));
    const nr = (await c.query(`
      WITH firsts AS (SELECT customer_id, MIN(occurred_at) AS first_ts FROM payments WHERE workspace_id = $3 AND status='paid' GROUP BY customer_id)
      SELECT COALESCE(SUM(re.gross) FILTER (WHERE f.first_ts >= $1),0) AS new_rev,
             COALESCE(SUM(re.gross) FILTER (WHERE f.first_ts <  $1),0) AS ret_rev
      ${RE_FROM} JOIN firsts f ON f.customer_id = p.customer_id
      ${RE_WHERE} AND re.entry_type='sale'`, P)).rows[0];

    const heatRows = (await c.query(`
      SELECT EXTRACT(DOW FROM t.occurred_at)::int AS dow, EXTRACT(HOUR FROM t.occurred_at)::int AS hr, COALESCE(SUM(re.gross),0) AS rev
      ${RE_FROM} ${RE_WHERE} AND re.entry_type='sale' GROUP BY 1,2`, P)).rows;
    const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
    heatRows.forEach((r) => { heatmap[r.dow][r.hr] = num(r.rev); });

    const seesAgencyFigures = scope.kind === 'workspace';
    return {
      range: { from, to, days }, scope: seesAgencyFigures ? 'agency' : scope.kind,
      timeseries: ts,
      headline: {
        gross: grossSales, net: num(h.net),
        ...(seesAgencyFigures ? {
          platformFee: num(h.platform_fee),
          accountPayout: num(h.account_payout), agentPayout: num(h.agent_payout), agencyKeep,
          takeRatePct: grossSales ? +(agencyKeep / grossSales * 100).toFixed(1) : 0,
        } : {}),
        aov: saleCount ? +(grossSales / saleCount).toFixed(2) : 0,
        paidCount: saleCount, uniqueBuyers: num(h.buyers),
      },
      reversals: {
        count: num(h.cb_count), valueReversed: num(h.cb_gross), feeCost: num(h.cb_fee),
        ratePct: saleCount ? +(num(h.cb_count) / saleCount * 100).toFixed(2) : 0,
        rateValuePct: grossSales ? +(num(h.cb_gross) / grossSales * 100).toFixed(2) : 0,
        ...(seesAgencyFigures ? { byBearer: { account: num(h.cb_account_borne), agency: num(h.cb_agency_borne) } } : {}),
      },
      funnel: {
        created, paid: num(fn.paid), failed, expired: num(fn.expired), cancelled: num(fn.cancelled),
        conversionPct: created ? Math.round(num(fn.paid) / created * 100) : 0,
        revenuePerLink: created ? +(grossSales / created).toFixed(2) : 0,
      },
      // Per-party tables compare people to each other, so they belong to the
      // roles that manage the workspace.
      agents: seesAgencyFigures ? agents.map((r) => {
        const l = byAgent[r.agent_id]; const cCreated = l ? num(l.created) : 0; const cPaid = l ? num(l.paid) : 0;
        return { name: r.name, revenue: num(r.revenue), agencyProfit: num(r.agency_profit), sales: num(r.sales),
          conversionPct: cCreated ? Math.round(cPaid / cCreated * 100) : null,
          aov: num(r.sales) ? num(r.revenue) / num(r.sales) : 0 };
      }) : [],
      accounts: seesAgencyFigures ? accounts.map((r) => ({
        name: r.name, revenue: num(r.revenue), accountPayout: num(r.account_payout), agencyProfit: num(r.agency_profit),
      })) : [],
      customers: {
        repeatRatePct: num(repeat.any_c) ? Math.round(num(repeat.repeat_c) / num(repeat.any_c) * 100) : 0,
        freq: +num(repeat.freq).toFixed(1),
        concentration: { top1: topShare(0.01), top5: topShare(0.05), top10: topShare(0.10) },
        categories, newVsReturning: { newRev: num(nr.new_rev), retRev: num(nr.ret_rev) },
      },
      heatmap,
    };
  });
  res.json(out);
}));

module.exports = router;
