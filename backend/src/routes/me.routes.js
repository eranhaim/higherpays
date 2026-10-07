'use strict';
// "What am I owed?" — self-scoped earnings for the signed-in person.
//
// An agent sees ONLY their own commission, an account owner ONLY their own
// share. Neither sees the other's cut, the agency's margin, or any fee figure.
//
// Net revenue is the only revenue figure these roles get. Gross and the fee
// total are deliberately absent: either one alongside net gives away the
// platform fee by subtraction.
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

    // A salaried creator scores 0 on every sale, exactly as fn_post_sale
    // computes it. Reporting their revenue_split_pct here would promise a
    // share of net revenue that the ledger never pays them.
    const profile = isAccount
      ? (await c.query(
        `SELECT CASE WHEN pay_model = 'salary' THEN 0 ELSE COALESCE(revenue_split_pct, 0) END AS pct,
                pay_model, salary_amount
           FROM accounts WHERE id = $1`, [scopeVal])).rows[0]
      : (await c.query(
        'SELECT commission_pct AS pct, NULL AS pay_model, NULL AS salary_amount FROM agents WHERE id = $1',
        [scopeVal])).rows[0];

    const period = (await c.query(
      `SELECT COUNT(*) FILTER (WHERE re.entry_type='sale')                          AS sales,
              COALESCE(SUM(re.distributable) FILTER (WHERE re.entry_type='sale'),0) AS distributable,
              COALESCE(SUM(${amountCol}),0)                                         AS earned
         FROM revenue_entries re
         JOIN transactions t ON t.id = re.transaction_id
         JOIN payments p ON p.id = t.payment_id AND p.archived_at IS NULL
        WHERE ${scopeCol} = $1 AND t.occurred_at >= $2 AND t.occurred_at <= $3`,
      [scopeVal, F, T])).rows[0];

    // Balances are all-time: what you are owed is what was never settled.
    const balance = (await c.query(
      `SELECT COALESCE(SUM(${amountCol}) FILTER (WHERE ${paidCol} IS NULL),0)     AS unpaid,
              COALESCE(SUM(${amountCol}) FILTER (WHERE ${paidCol} IS NOT NULL),0) AS paid
         FROM revenue_entries re
         JOIN transactions t ON t.id = re.transaction_id
         JOIN payments p ON p.id = t.payment_id AND p.archived_at IS NULL
        WHERE ${scopeCol} = $1`, [scopeVal])).rows[0];

    return { isAccount, profile, period, balance };
  });

  if (!data) return res.status(404).json({ error: 'no_profile' });

  const { isAccount, profile, period, balance } = data;
  const onSalary = isAccount && profile.pay_model === 'salary';
  res.json({
    range: { from: F, to: T },
    role: isAccount ? 'account_owner' : 'agent',
    payModel: isAccount ? profile.pay_model : null,
    // A salaried creator is owed a fixed amount per payout period, not a cut
    // of net revenue, so their terms are the salary rather than a rate.
    salaryAmount: onSalary ? r2(n(profile.salary_amount)) : null,
    period: {
      sales: n(period.sales),
      netRevenue: r2(period.distributable),   // the base the rate is applied to
      yourRatePct: n(profile.pct),
      earned: r2(period.earned),
    },
    balance: { owed: r2(balance.unpaid), paidToDate: r2(balance.paid) },
  });
}));

module.exports = router;
