'use strict';
// Itemised fee reporting: where the money actually went, by fee component.
// Behind fees.view because it is the one surface that shows HigherPays' own
// margin in currency.
const express = require('express');
const { query } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const currencies = require('../services/currencies.service');

const router = express.Router({ mergeParams: true });
const { wid } = require('../lib/scope');
const { toNumber, round2 } = require('../lib/money');
const { reportRange } = require('../lib/reportRange');
const r4 = (v) => Math.round(v * 10000) / 10000;

// GET /?from&to
router.get('/', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { from, to } = reportRange(req.query);
  // Fees are in one currency; summing across currencies would be meaningless.
  const currency = await currencies.resolveReportingCurrency({ query }, wid(req), req.query.currency);
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
     FROM revenue_entries re
     JOIN transactions t ON t.id = re.transaction_id
     JOIN payments p ON p.id = t.payment_id AND p.archived_at IS NULL
    WHERE re.workspace_id = $3 AND t.occurred_at >= $1 AND t.occurred_at <= $2 AND t.currency = $4`, [from, to, wid(req), currency])).rows[0];
  const card = (await query('SELECT * FROM effective_platform_fee($1, now())', [wid(req)])).rows[0] || {};

  const gross = toNumber(t.gross);
  const pct = (v) => (gross > 0 ? r4(toNumber(v) / gross * 100) : 0);
  res.json({
    range: { from, to },
    currency,
    sales: toNumber(t.sales),
    gross: round2(gross),
    providerFees: {
      mdr: round2(t.mdr), fixed: round2(t.fixed), settlement: round2(t.settlement), reversalFees: round2(t.reversal_fees),
      total: round2(toNumber(t.mdr) + toNumber(t.fixed) + toNumber(t.settlement)),
      percentOfGross: pct(toNumber(t.mdr) + toNumber(t.fixed) + toNumber(t.settlement)),
    },
    platformFees: {
      margin: round2(t.hp_margin),
      total: round2(t.hp_margin),
      percentOfGross: pct(t.hp_margin),
    },
    totalDeducted: round2(t.platform_fee_total),
    effectiveRatePct: pct(t.platform_fee_total),
    distributable: round2(t.distributable),
    splits: { account: round2(t.account), agent: round2(t.agent), agency: round2(t.agency) },
    rateCard: {
      feeModel: card.fee_model || 'flat',
      mdrPct: card.mdr_pct == null ? toNumber(card.psp_rate_pct) : toNumber(card.mdr_pct),
      settlementPct: toNumber(card.settlement_pct),
      fixedFee: toNumber(card.psp_fixed_fee),
      marginPct: toNumber(card.margin_rate_pct),
      itemised: card.mdr_pct != null,
    },
  });
}));

// GET /transactions?from&to — per-transaction itemisation, for drill-down
router.get('/transactions', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { from, to } = reportRange(req.query);
  const limit = Math.min(1000, Number(req.query.limit) || 200);
  const currency = await currencies.resolveReportingCurrency({ query }, wid(req), req.query.currency);
  const rows = (await query(
    `SELECT t.occurred_at, t.provider_transaction_id, t.currency,
            a.name AS account, u.full_name AS agent,
            re.entry_type, re.gross, re.fee_mdr, re.fee_fixed, re.fee_settlement,
            re.platform_margin, re.platform_fee, re.chargeback_fee,
            re.distributable, re.account_amount, re.agent_amount, re.agency_amount
       FROM revenue_entries re
       JOIN transactions t ON t.id = re.transaction_id
       JOIN payments p ON p.id = t.payment_id AND p.archived_at IS NULL
       LEFT JOIN accounts a ON a.id = re.account_id
       LEFT JOIN agents ag ON ag.id = re.agent_id LEFT JOIN users u ON u.id = ag.user_id
      WHERE re.workspace_id = $4 AND t.occurred_at >= $1 AND t.occurred_at <= $2 AND t.currency = $5
      ORDER BY t.occurred_at DESC LIMIT $3`, [from, to, limit, wid(req), currency])).rows;
  res.json({
    transactions: rows.map((x) => ({
      date: x.occurred_at, reference: x.provider_transaction_id, currency: x.currency,
      type: x.entry_type, account: x.account, agent: x.agent,
      gross: toNumber(x.gross),
      fees: { mdr: toNumber(x.fee_mdr), fixed: toNumber(x.fee_fixed), settlement: toNumber(x.fee_settlement), higherPays: toNumber(x.platform_margin), reversal: toNumber(x.chargeback_fee), total: toNumber(x.platform_fee) },
      distributable: toNumber(x.distributable),
      accountAmount: toNumber(x.account_amount), agentAmount: toNumber(x.agent_amount), agencyAmount: toNumber(x.agency_amount),
    })),
  });
}));

module.exports = router;
