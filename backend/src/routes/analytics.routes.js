'use strict';
// ============================================================================
// Analytics engine — real aggregations over the commission ledger.
//
// Money comes from commission_entries: each sale is a positive 'sale' row and
// each reversal a negative 'chargeback' row, so summing a column yields the
// TRUE chargeback-adjusted figure. Joined to transactions for the sale date
// (occurred_at) and the customer. Scope is enforced server-side:
//   • agency roles (owner/admin/manager/analyst) → the whole workspace (RLS)
//   • chatter                                     → only their attributed rows
// ============================================================================
const express = require('express');
const { withWorkspace } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const config = require('../config');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');
const num = (v) => Number(v || 0);

function range(req) {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
  return { from: from.toISOString(), to: to.toISOString(), days: Math.max(1, Math.round((to - from) / 86400000)) };
}

router.get('/', requirePermission('analytics.view'), asyncHandler(async (req, res) => {
  const { from, to, days } = range(req);
  const role = req.membership.role;
  const ttl = config.linkTtlMinutes;

  const out = await withWorkspace(wid(req), uid(req), async (c) => {
    // Scope server-side by role: a chatter sees only rows attributed to their
    // membership; a creator sees only rows for the creator record linked to
    // their user. Agency roles see the whole workspace.
    let scopeCol = null, linkCol = null, scopeVal = null;
    if (role === 'chatter') {
      scopeCol = 'ce.chatter_membership_id'; linkCol = 'pl.created_by'; scopeVal = req.membership.id;
    } else if (role === 'creator') {
      const cr = (await c.query('SELECT id FROM creators WHERE workspace_id = $1 AND user_id = $2 LIMIT 1', [wid(req), uid(req)])).rows[0];
      scopeCol = 'ce.creator_id'; linkCol = 'pl.creator_id';
      scopeVal = cr ? cr.id : '00000000-0000-0000-0000-000000000000'; // unlinked creator → empty result
    } else {
      // agency roles may explicitly scope to one chatter/creator (for comparisons)
      if (req.query.chatterId) { scopeCol = 'ce.chatter_membership_id'; linkCol = 'pl.created_by'; scopeVal = req.query.chatterId; }
      else if (req.query.creatorId) { scopeCol = 'ce.creator_id'; linkCol = 'pl.creator_id'; scopeVal = req.query.creatorId; }
    }
    const scoped = scopeVal != null;
    // ledger params: $1 from, $2 to, ($3 scope). FROM+joins kept separate from WHERE
    // so downstream queries can add their own JOINs before the WHERE clause.
    const ceP = scoped ? [from, to, scopeVal] : [from, to];
    const CE_FROM = 'FROM commission_entries ce JOIN transactions t ON t.id = ce.transaction_id';
    const CE_WHERE = 'WHERE t.occurred_at >= $1 AND t.occurred_at <= $2' + (scoped ? ` AND ${scopeCol} = $3` : '');

    const h = (await c.query(`
      SELECT
        COALESCE(SUM(ce.gross) FILTER (WHERE ce.entry_type='sale'),0)          AS gross_sales,
        COALESCE(SUM(ce.distributable),0)                                       AS net,
        COALESCE(SUM(ce.platform_fee),0)                                        AS platform_fee,
        COALESCE(SUM(ce.platform_margin),0)                                     AS hp_margin,
        COALESCE(SUM(ce.creator_amount),0)                                      AS creator_payout,
        COALESCE(SUM(ce.chatter_amount),0)                                      AS chatter_payout,
        COALESCE(SUM(ce.agency_amount),0)                                       AS agency_keep,
        COUNT(*) FILTER (WHERE ce.entry_type='sale')                            AS sale_count,
        COUNT(*) FILTER (WHERE ce.entry_type='chargeback')                      AS cb_count,
        COALESCE(-SUM(ce.gross) FILTER (WHERE ce.entry_type='chargeback'),0)    AS cb_gross,
        COALESCE(SUM(ce.chargeback_fee) FILTER (WHERE ce.entry_type='chargeback'),0) AS cb_fee,
        COALESCE(-SUM(ce.creator_amount) FILTER (WHERE ce.entry_type='chargeback'),0) AS cb_creator_borne,
        COALESCE(-SUM(ce.agency_amount)  FILTER (WHERE ce.entry_type='chargeback'),0) AS cb_agency_borne,
        COUNT(DISTINCT t.customer_id) FILTER (WHERE ce.entry_type='sale')       AS buyers
      ${CE_FROM} ${CE_WHERE}`, ceP)).rows[0];
    const grossSales = num(h.gross_sales), agencyKeep = num(h.agency_keep), saleCount = num(h.sale_count);

    const ts = (await c.query(`
      SELECT to_char(date_trunc('day', t.occurred_at),'YYYY-MM-DD') AS d,
             COALESCE(SUM(ce.gross),0) AS gross, COALESCE(SUM(ce.distributable),0) AS net
      ${CE_FROM} ${CE_WHERE} GROUP BY 1 ORDER BY 1`, ceP)).rows
      .map(r => ({ d: r.d, gross: num(r.gross), net: num(r.net) }));

    // link funnel (effective status via the confirmed TTL, which is a safe config int)
    const linkP = scoped ? [from, to, scopeVal] : [from, to];
    const linkWhere = 'WHERE pl.created_at >= $1 AND pl.created_at <= $2' + (scoped ? ` AND ${linkCol} = $3` : '');
    const fn = (await c.query(`
      SELECT COUNT(*) AS created,
        COUNT(*) FILTER (WHERE pl.status='paid') AS paid,
        COUNT(*) FILTER (WHERE pl.status='failed') AS failed,
        COUNT(*) FILTER (WHERE pl.status='created' AND pl.created_at < now() - interval '${ttl} minutes') AS expired
      FROM payment_links pl ${linkWhere}`, linkP)).rows[0];
    const created = num(fn.created);

    const chatterRows = (await c.query(`
      SELECT u.full_name AS name, m.id AS membership_id,
             COALESCE(SUM(ce.gross),0) AS revenue,
             COALESCE(SUM(ce.agency_amount),0) AS agency_profit,
             COUNT(*) FILTER (WHERE ce.entry_type='sale') AS sales
      ${CE_FROM}
      JOIN memberships m ON m.id = ce.chatter_membership_id
      JOIN users u ON u.id = m.user_id
      ${CE_WHERE} AND ce.chatter_membership_id IS NOT NULL
      GROUP BY u.full_name, m.id ORDER BY revenue DESC`, ceP)).rows;
    const chatterLinks = (await c.query(`
      SELECT pl.created_by AS membership_id, COUNT(*) AS created,
             COUNT(*) FILTER (WHERE pl.status='paid') AS paid
      FROM payment_links pl ${linkWhere} AND pl.created_by IS NOT NULL
      GROUP BY pl.created_by`, linkP)).rows;
    const clMap = Object.fromEntries(chatterLinks.map(r => [r.membership_id, r]));
    const chatters = chatterRows.map(r => {
      const l = clMap[r.membership_id]; const cCreated = l ? num(l.created) : 0; const cPaid = l ? num(l.paid) : 0;
      return { name: r.name, revenue: num(r.revenue), agencyProfit: num(r.agency_profit), sales: num(r.sales),
               conversionPct: cCreated ? Math.round(cPaid / cCreated * 100) : null,
               aov: num(r.sales) ? num(r.revenue) / num(r.sales) : 0 };
    });

    const creators = (await c.query(`
      SELECT cr.stage_name AS name, cr.revenue_model AS model, cr.salary,
             COALESCE(SUM(ce.gross),0) AS revenue,
             COALESCE(SUM(ce.creator_amount),0) AS creator_payout,
             COALESCE(SUM(ce.agency_amount),0) AS agency_profit
      ${CE_FROM}
      JOIN creators cr ON cr.id = ce.creator_id
      ${CE_WHERE} AND ce.creator_id IS NOT NULL
      GROUP BY cr.stage_name, cr.revenue_model, cr.salary ORDER BY revenue DESC`, ceP)).rows
      .map(r => ({ name: r.name, model: r.model, salary: num(r.salary), revenue: num(r.revenue),
                   creatorPayout: num(r.creator_payout), agencyProfit: num(r.agency_profit) }));

    const perCust = (await c.query(`
      SELECT t.customer_id AS id, COALESCE(SUM(ce.gross),0) AS rev
      ${CE_FROM} ${CE_WHERE} AND ce.entry_type='sale' AND t.customer_id IS NOT NULL
      GROUP BY t.customer_id ORDER BY rev DESC`, ceP)).rows.map(r => num(r.rev));
    const totRev = perCust.reduce((a, b) => a + b, 0) || 1;
    const topShare = (p) => { const n = Math.max(1, Math.ceil(perCust.length * p)); return Math.round(perCust.slice(0, n).reduce((a, b) => a + b, 0) / totRev * 100); };

    const crm = (await c.query(`
      SELECT COALESCE(AVG(total_spend) FILTER (WHERE total_spend>0),0) AS avg_ltv,
             COALESCE(AVG(total_spend),0) AS arpu, COUNT(*) AS total FROM customers`)).rows[0];
    const repeat = (await c.query(`
      SELECT COUNT(*) FILTER (WHERE n>=2) AS repeat_c, COUNT(*) AS any_c, COALESCE(AVG(n),0) AS freq
      FROM (SELECT customer_id, COUNT(*) n FROM transactions WHERE status='approved' AND customer_id IS NOT NULL GROUP BY customer_id) q`)).rows[0];
    const segRows = (await c.query(`
      SELECT cu.segment AS segment, COALESCE(SUM(ce.gross),0) AS rev
      ${CE_FROM}
      JOIN customers cu ON cu.id = t.customer_id
      ${CE_WHERE} AND ce.entry_type='sale'
      GROUP BY cu.segment ORDER BY rev DESC`, ceP)).rows.map(r => ({ segment: r.segment, revenue: num(r.rev) }));
    const nr = (await c.query(`
      WITH firsts AS (SELECT customer_id, MIN(occurred_at) AS first_ts FROM transactions WHERE status='approved' GROUP BY customer_id)
      SELECT
        COALESCE(SUM(ce.gross) FILTER (WHERE f.first_ts >= $1),0) AS new_rev,
        COALESCE(SUM(ce.gross) FILTER (WHERE f.first_ts <  $1),0) AS ret_rev
      ${CE_FROM}
      JOIN firsts f ON f.customer_id = t.customer_id
      ${CE_WHERE} AND ce.entry_type='sale'`, ceP)).rows[0];

    const heatRows = (await c.query(`
      SELECT EXTRACT(DOW FROM t.occurred_at)::int AS dow, EXTRACT(HOUR FROM t.occurred_at)::int AS hr,
             COALESCE(SUM(ce.gross),0) AS rev
      ${CE_FROM} ${CE_WHERE} AND ce.entry_type='sale' GROUP BY 1,2`, ceP)).rows;
    const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
    heatRows.forEach(r => { heatmap[r.dow][r.hr] = num(r.rev); });

    return {
      range: { from, to, days }, scope: role === 'chatter' ? 'chatter' : role === 'creator' ? 'creator' : 'agency',
      timeseries: ts,
      headline: {
        gross: grossSales, net: num(h.net), platformFee: num(h.platform_fee),
        // HigherPays' own margin is operator-only; agencies see the blended platform fee.
        ...(req.membership.isPlatformOperator ? { hpMargin: num(h.hp_margin) } : {}),
        creatorPayout: num(h.creator_payout), chatterPayout: num(h.chatter_payout), agencyKeep,
        takeRatePct: grossSales ? +(agencyKeep / grossSales * 100).toFixed(1) : 0,
        aov: saleCount ? +(grossSales / saleCount).toFixed(2) : 0,
        paidCount: saleCount, uniqueBuyers: num(h.buyers),
      },
      chargebacks: {
        count: num(h.cb_count), valueReversed: num(h.cb_gross), feeCost: num(h.cb_fee),
        ratePct: saleCount ? +(num(h.cb_count) / saleCount * 100).toFixed(2) : 0,
        rateValuePct: grossSales ? +(num(h.cb_gross) / grossSales * 100).toFixed(2) : 0,
        byBearer: { creator: num(h.cb_creator_borne), agency: num(h.cb_agency_borne) },
      },
      funnel: {
        created, paid: num(fn.paid), failed: num(fn.failed), expired: num(fn.expired),
        conversionPct: created ? Math.round(num(fn.paid) / created * 100) : 0,
        declinePct: created ? Math.round(num(fn.failed) / created * 100) : 0,
        expiryPct: created ? Math.round(num(fn.expired) / created * 100) : 0,
        revenuePerLink: created ? +(grossSales / created).toFixed(2) : 0,
      },
      chatters, creators,
      customers: {
        avgLtv: num(crm.avg_ltv), arpu: num(crm.arpu),
        repeatRatePct: num(repeat.any_c) ? Math.round(num(repeat.repeat_c) / num(repeat.any_c) * 100) : 0,
        freq: +num(repeat.freq).toFixed(1),
        concentration: { top1: topShare(0.01), top5: topShare(0.05), top10: topShare(0.10) },
        segments: segRows, newVsReturning: { newRev: num(nr.new_rev), retRev: num(nr.ret_rev) },
      },
      heatmap,
    };
  });
  res.json(out);
}));

module.exports = router;
