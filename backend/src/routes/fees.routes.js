'use strict';
// Itemised fee reporting: where the money actually went, by fee component.
// Behind fees.view because it is the one surface that shows HigherPays' own
// margin in currency.
const express = require('express');
const { query } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');

const router = express.Router({ mergeParams: true });
const { wid } = require('../lib/scope');
const n = (v) => Number(v || 0);
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;

function range(req) {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
  return { F: from.toISOString(), T: to.toISOString() };
}

// GET /?from&to
router.get('/', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { F, T } = range(req);
  const t = (await query(
    `SELECT
       COUNT(*) FILTER (WHERE re.entry_type='sale')                          AS sales,
       COALESCE(SUM(re.gross) FILTER (WHERE re.entry_type='sale'),0)         AS gross,
       COALESCE(SUM(re.fee_mdr),0)          AS mdr,
       COALESCE(SUM(re.fee_fixed),0)        AS fixed,
       COALESCE(SUM(re.fee_settlement),0)   AS settlement,
       COALESCE(SUM(re.platform_margin),0)  AS hp_margin,
       COALESCE(SUM(re.platform_fee),0)     AS platform_fee_total,
       COALESCE(SUM(re.chargeback_fee),0)   AS reversal_fees,
       COALESCE(SUM(re.distributable),0)    AS distributable,
       COALESCE(SUM(re.account_amount),0)   AS account,
       COALESCE(SUM(re.agent_amount),0)     AS agent,
       COALESCE(SUM(re.agency_amount),0)    AS agency
     FROM revenue_entries re JOIN transactions t ON t.id = re.transaction_id
    WHERE re.workspace_id = $3 AND t.occurred_at >= $1 AND t.occurred_at <= $2`, [F, T, wid(req)])).rows[0];
  const card = (await query('SELECT * FROM effective_platform_fee($1, now())', [wid(req)])).rows[0] || {};

  const gross = n(t.gross);
  const pct = (v) => (gross > 0 ? r4(n(v) / gross * 100) : 0);
  res.json({
    range: { from: F, to: T },
    sales: n(t.sales),
    gross: r2(gross),
    providerFees: {
      mdr: r2(t.mdr), fixed: r2(t.fixed), settlement: r2(t.settlement), reversalFees: r2(t.reversal_fees),
      total: r2(n(t.mdr) + n(t.fixed) + n(t.settlement)),
      percentOfGross: pct(n(t.mdr) + n(t.fixed) + n(t.settlement)),
    },
    platformFees: {
      margin: r2(t.hp_margin),
      total: r2(t.hp_margin),
      percentOfGross: pct(t.hp_margin),
    },
    totalDeducted: r2(t.platform_fee_total),
    effectiveRatePct: pct(t.platform_fee_total),
    distributable: r2(t.distributable),
    splits: { account: r2(t.account), agent: r2(t.agent), agency: r2(t.agency) },
    rateCard: {
      feeModel: card.fee_model || 'flat',
      mdrPct: card.mdr_pct == null ? n(card.psp_rate_pct) : n(card.mdr_pct),
      settlementPct: n(card.settlement_pct),
      fixedFee: n(card.psp_fixed_fee),
      marginPct: n(card.margin_rate_pct),
      itemised: card.mdr_pct != null,
    },
  });
}));

// GET /transactions?from&to — per-transaction itemisation, for drill-down
router.get('/transactions', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { F, T } = range(req);
  const limit = Math.min(1000, Number(req.query.limit) || 200);
  const rows = (await query(
    `SELECT t.occurred_at, t.provider_transaction_id, t.currency,
            a.name AS account, u.full_name AS agent,
            re.entry_type, re.gross, re.fee_mdr, re.fee_fixed, re.fee_settlement,
            re.platform_margin, re.platform_fee, re.chargeback_fee,
            re.distributable, re.account_amount, re.agent_amount, re.agency_amount
       FROM revenue_entries re
       JOIN transactions t ON t.id = re.transaction_id
       LEFT JOIN accounts a ON a.id = re.account_id
       LEFT JOIN agents ag ON ag.id = re.agent_id LEFT JOIN users u ON u.id = ag.user_id
      WHERE re.workspace_id = $4 AND t.occurred_at >= $1 AND t.occurred_at <= $2
      ORDER BY t.occurred_at DESC LIMIT $3`, [F, T, limit, wid(req)])).rows;
  res.json({
    transactions: rows.map((x) => ({
      date: x.occurred_at, reference: x.provider_transaction_id, currency: x.currency,
      type: x.entry_type, account: x.account, agent: x.agent,
      gross: n(x.gross),
      fees: { mdr: n(x.fee_mdr), fixed: n(x.fee_fixed), settlement: n(x.fee_settlement), higherPays: n(x.platform_margin), reversal: n(x.chargeback_fee), total: n(x.platform_fee) },
      distributable: n(x.distributable),
      accountAmount: n(x.account_amount), agentAmount: n(x.agent_amount), agencyAmount: n(x.agency_amount),
    })),
  });
}));

module.exports = router;
