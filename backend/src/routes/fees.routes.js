'use strict';
// Itemised fee reporting. Answers "where did the money actually go" for a
// workspace, broken down by fee component rather than one blended number.
const express = require('express');
const { withWorkspace } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');
const n = (v) => Number(v || 0);
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;

// GET /  ?from&to — every fee component for the period
router.get('/', requirePermission('commissions.view'), asyncHandler(async (req, res) => {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
  const F = from.toISOString(), T = to.toISOString();

  const data = await withWorkspace(wid(req), uid(req), async (c) => {
    const totals = (await c.query(
      `SELECT
         COUNT(*) FILTER (WHERE ce.entry_type='sale')                      AS sales,
         COALESCE(SUM(ce.gross)          FILTER (WHERE ce.entry_type='sale'),0) AS gross,
         COALESCE(SUM(ce.fee_mdr),0)          AS mdr,
         COALESCE(SUM(ce.fee_fixed),0)        AS fixed,
         COALESCE(SUM(ce.fee_settlement),0)   AS settlement,
         COALESCE(SUM(ce.fee_surcharge),0)    AS surcharge,
         COALESCE(SUM(ce.platform_margin),0)  AS hp_margin,
         COALESCE(SUM(ce.psp_fee),0)          AS psp_total,
         COALESCE(SUM(ce.platform_fee),0)     AS platform_fee_total,
         COALESCE(SUM(ce.chargeback_fee),0)   AS reversal_fees,
         COALESCE(SUM(ce.distributable),0)    AS distributable,
         COALESCE(SUM(ce.creator_amount),0)   AS creator,
         COALESCE(SUM(ce.chatter_amount),0)   AS chatter,
         COALESCE(SUM(ce.agency_amount),0)    AS agency
       FROM commission_entries ce
       JOIN transactions t ON t.id = ce.transaction_id
      WHERE t.occurred_at >= $1 AND t.occurred_at <= $2`, [F, T])).rows[0];

    // the rate card that produced these numbers, for transparency
    const card = (await c.query(
      `SELECT p.fee_model, p.psp_rate_pct, p.mdr_pct, p.settlement_pct, p.psp_fixed_fee, p.margin_rate_pct
         FROM workspaces w
         JOIN platform_fee_rates p ON p.organization_id = w.organization_id
        WHERE w.id = $1 AND p.effective_from <= now()
        ORDER BY p.effective_from DESC LIMIT 1`, [wid(req)])).rows[0] || {};

    return { totals, card };
  });

  const t = data.totals;
  const gross = n(t.gross);
  const pct = (v) => (gross > 0 ? r4(n(v) / gross * 100) : 0);

  res.json({
    range: { from: F, to: T },
    sales: n(t.sales),
    gross: r2(gross),
    // what the provider charged, itemised
    providerFees: {
      mdr: r2(t.mdr), fixed: r2(t.fixed), settlement: r2(t.settlement),
      reversalFees: r2(t.reversal_fees),
      total: r2(n(t.mdr) + n(t.fixed) + n(t.settlement)),
      percentOfGross: pct(n(t.mdr) + n(t.fixed) + n(t.settlement)),
    },
    // what HigherPays charged
    platformFees: {
      margin: r2(t.hp_margin),
      surcharge: r2(t.surcharge), // collected FROM the payer, not deducted from gross
      total: r2(n(t.hp_margin) + n(t.surcharge)),
      percentOfGross: pct(t.hp_margin),
    },
    totalDeducted: r2(t.platform_fee_total),
    effectiveRatePct: pct(t.platform_fee_total),
    distributable: r2(t.distributable),
    splits: { creator: r2(t.creator), chatter: r2(t.chatter), agency: r2(t.agency) },
    rateCard: {
      feeModel: data.card.fee_model || 'flat',
      mdrPct: data.card.mdr_pct == null ? n(data.card.psp_rate_pct) : n(data.card.mdr_pct),
      settlementPct: n(data.card.settlement_pct),
      fixedFee: n(data.card.psp_fixed_fee),
      marginPct: n(data.card.margin_rate_pct),
      itemised: data.card.mdr_pct != null,
    },
  });
}));

// GET /transactions ?from&to — per-transaction itemisation, for drill-down / export
router.get('/transactions', requirePermission('commissions.view'), asyncHandler(async (req, res) => {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
  const limit = Math.min(1000, Number(req.query.limit) || 200);

  const rows = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `SELECT t.occurred_at, t.provider_transaction_id, t.currency, t.surcharge,
            cr.stage_name AS creator, u.full_name AS chatter,
            ce.entry_type, ce.gross, ce.fee_mdr, ce.fee_fixed, ce.fee_settlement,
            ce.platform_margin, ce.platform_fee, ce.chargeback_fee,
            ce.distributable, ce.creator_amount, ce.chatter_amount, ce.agency_amount
       FROM commission_entries ce
       JOIN transactions t ON t.id = ce.transaction_id
       LEFT JOIN creators cr ON cr.id = ce.creator_id
       LEFT JOIN memberships m ON m.id = ce.chatter_membership_id
       LEFT JOIN users u ON u.id = m.user_id
      WHERE t.occurred_at >= $1 AND t.occurred_at <= $2
      ORDER BY t.occurred_at DESC LIMIT $3`,
    [from.toISOString(), to.toISOString(), limit])).rows);

  res.json({
    transactions: rows.map((x) => ({
      date: x.occurred_at, reference: x.provider_transaction_id, currency: x.currency,
      type: x.entry_type, creator: x.creator, chatter: x.chatter,
      gross: n(x.gross), surcharge: n(x.surcharge),
      fees: {
        mdr: n(x.fee_mdr), fixed: n(x.fee_fixed), settlement: n(x.fee_settlement),
        higherPays: n(x.platform_margin), reversal: n(x.chargeback_fee),
        total: n(x.platform_fee),
      },
      distributable: n(x.distributable),
      creatorAmount: n(x.creator_amount), chatterAmount: n(x.chatter_amount), agencyAmount: n(x.agency_amount),
    })),
  });
}));

module.exports = router;
