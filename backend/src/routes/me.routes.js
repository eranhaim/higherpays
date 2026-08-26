'use strict';
// "What am I owed?" — self-scoped earnings for the signed-in person.
//
// An agent sees ONLY their own commission, an account owner ONLY their own
// share. Neither sees the other's cut, the agency's margin, or the itemised
// fee breakdown.
const express = require('express');
const { withTransaction } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { resolveDataScope } = require('../auth/dataScope');

const router = express.Router({ mergeParams: true });
const n = (v) => Number(v || 0);
const r2 = (v) => Math.round(v * 100) / 100;

router.get('/earnings', requirePermission('analytics.view'), asyncHandler(async (req, res) => {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
  const F = from.toISOString(), T = to.toISOString();

  const data = await withTransaction(async (c) => {
    const scope = await resolveDataScope(c, req);
    if (scope.kind !== 'agent' && scope.kind !== 'account') return null;

    const isAccount = scope.kind === 'account';
    const amountCol = isAccount ? 're.account_amount' : 're.agent_amount';
    const paidCol = isAccount ? 're.account_payout_id' : 're.agent_payout_id';
    const scopeCol = isAccount ? 're.account_id' : 're.agent_id';
    const scopeVal = isAccount ? scope.accountId : scope.agentId;

    const rate = isAccount
      ? (await c.query('SELECT revenue_split_pct AS pct FROM accounts WHERE id = $1', [scopeVal])).rows[0]
      : (await c.query('SELECT commission_pct AS pct FROM agents WHERE id = $1', [scopeVal])).rows[0];

    const period = (await c.query(
      `SELECT COUNT(*) FILTER (WHERE re.entry_type='sale')                          AS sales,
              COALESCE(SUM(re.gross)         FILTER (WHERE re.entry_type='sale'),0) AS gross,
              COALESCE(SUM(re.platform_fee)  FILTER (WHERE re.entry_type='sale'),0) AS deductions,
              COALESCE(SUM(re.distributable) FILTER (WHERE re.entry_type='sale'),0) AS distributable,
              COALESCE(SUM(${amountCol}),0)                                         AS earned
         FROM revenue_entries re
         JOIN transactions t ON t.id = re.transaction_id
        WHERE ${scopeCol} = $1 AND t.occurred_at >= $2 AND t.occurred_at <= $3`,
      [scopeVal, F, T])).rows[0];

    // Balances are all-time: what you are owed is what was never settled.
    const balance = (await c.query(
      `SELECT COALESCE(SUM(${amountCol}) FILTER (WHERE ${paidCol} IS NULL),0)     AS unpaid,
              COALESCE(SUM(${amountCol}) FILTER (WHERE ${paidCol} IS NOT NULL),0) AS paid
         FROM revenue_entries re WHERE ${scopeCol} = $1`, [scopeVal])).rows[0];

    return { isAccount, rate: n(rate && rate.pct), period, balance };
  });

  if (!data) return res.status(404).json({ error: 'no_profile' });

  const { isAccount, rate, period, balance } = data;
  res.json({
    range: { from: F, to: T },
    role: isAccount ? 'account_owner' : 'agent',
    period: {
      sales: n(period.sales),
      gross: r2(n(period.gross)),
      deductions: r2(period.deductions),      // processing + platform, aggregated
      afterFees: r2(period.distributable),    // the base the rate is applied to
      yourRatePct: rate,
      earned: r2(period.earned),
    },
    balance: { owed: r2(balance.unpaid), paidToDate: r2(balance.paid) },
  });
}));

module.exports = router;
