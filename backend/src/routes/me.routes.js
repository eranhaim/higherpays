'use strict';
// "What am I owed?" — self-scoped earnings for the signed-in person.
//
// Deliberately narrow: a chatter sees ONLY their own commission, a creator sees
// ONLY their own share. Neither sees the other's cut, the agency's margin, or
// the itemised fee breakdown. Gated on analytics.view (which chatters have),
// NOT commissions.view (which they don't) — because this is their own data.
const express = require('express');
const { withWorkspace } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');
const n = (v) => Number(v || 0);
const r2 = (v) => Math.round(v * 100) / 100;

router.get('/earnings', requirePermission('analytics.view'), asyncHandler(async (req, res) => {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
  const F = from.toISOString(), T = to.toISOString();

  const data = await withWorkspace(wid(req), uid(req), async (c) => {
    // Which party is the signed-in user? A membership makes them a chatter;
    // a linked creator record makes them a creator.
    const me = (await c.query(
      `SELECT m.id AS membership_id, m.role, m.commission_pct,
              (SELECT id FROM creators WHERE workspace_id = $1 AND user_id = $2 LIMIT 1) AS creator_id,
              (SELECT revenue_split_pct FROM creators WHERE workspace_id = $1 AND user_id = $2 LIMIT 1) AS split_pct,
              (SELECT revenue_model FROM creators WHERE workspace_id = $1 AND user_id = $2 LIMIT 1) AS revenue_model
         FROM memberships m
        WHERE m.workspace_id = $1 AND m.user_id = $2 LIMIT 1`, [wid(req), uid(req)])).rows[0];
    if (!me) return null;

    const isCreator = !!me.creator_id;
    const amountCol = isCreator ? 'ce.creator_amount' : 'ce.chatter_amount';
    const paidCol = isCreator ? 'ce.creator_payout_id' : 'ce.chatter_payout_id';
    const scopeCol = isCreator ? 'ce.creator_id' : 'ce.chatter_membership_id';
    const scopeVal = isCreator ? me.creator_id : me.membership_id;

    const period = (await c.query(
      `SELECT COUNT(*) FILTER (WHERE ce.entry_type='sale')                          AS sales,
              COALESCE(SUM(ce.gross)         FILTER (WHERE ce.entry_type='sale'),0) AS gross,
              COALESCE(SUM(ce.platform_fee)  FILTER (WHERE ce.entry_type='sale'),0) AS deductions,
              COALESCE(SUM(ce.distributable) FILTER (WHERE ce.entry_type='sale'),0) AS distributable,
              COALESCE(SUM(${amountCol}),0)                                         AS earned
         FROM commission_entries ce
         JOIN transactions t ON t.id = ce.transaction_id
        WHERE ${scopeCol} = $1 AND t.occurred_at >= $2 AND t.occurred_at <= $3`,
      [scopeVal, F, T])).rows[0];

    // Balances are all-time, not period-scoped: what you are owed is what has
    // never been settled, regardless of when it was earned.
    const balance = (await c.query(
      `SELECT COALESCE(SUM(${amountCol}) FILTER (WHERE ${paidCol} IS NULL),0)     AS unpaid,
              COALESCE(SUM(${amountCol}) FILTER (WHERE ${paidCol} IS NOT NULL),0) AS paid
         FROM commission_entries ce WHERE ${scopeCol} = $1`, [scopeVal])).rows[0];

    return { me, isCreator, period, balance };
  });

  if (!data) return res.status(404).json({ error: 'no_membership' });

  const { me, isCreator, period, balance } = data;
  const gross = n(period.gross);
  const rate = isCreator ? n(me.split_pct) : n(me.commission_pct);

  res.json({
    range: { from: F, to: T },
    role: isCreator ? 'creator' : 'chatter',
    // The chain that explains the number, WITHOUT itemising whose fee is whose.
    period: {
      sales: n(period.sales),
      gross: r2(gross),
      deductions: r2(period.deductions),      // processing + platform, aggregated
      afterFees: r2(period.distributable),    // the base the rate is applied to
      yourRatePct: rate,
      earned: r2(period.earned),
    },
    balance: {
      owed: r2(balance.unpaid),               // not yet paid out to you
      paidToDate: r2(balance.paid),
    },
    revenueModel: isCreator ? me.revenue_model : null,
  });
}));

module.exports = router;
