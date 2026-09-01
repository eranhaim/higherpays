'use strict';
// The HigherPays operator console, above any single workspace. Mounted behind
// requireAuth + requirePlatformAdmin.
const config = require('../config');
const express = require('express');
const crypto = require('crypto');
const { query, withTransaction } = require('../db');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { isStr, badRequest } = require('../util/validate');
const { sendEmail } = require('../util/email');
const { status: vocab } = require('../schema/entities');

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const router = express.Router();
const { uid } = require('../lib/scope');
const pct = (v) => typeof v === 'number' && v >= 0 && v <= 100;
const n = (v) => Number(v || 0);
const r2 = (v) => Math.round(v * 100) / 100;

const publicFee = (f) => ({
  feeModel: f.fee_model, pspRatePct: n(f.psp_rate_pct), mdrPct: f.mdr_pct == null ? null : n(f.mdr_pct),
  settlementPct: f.settlement_pct == null ? null : n(f.settlement_pct), pspFixedFee: n(f.psp_fixed_fee),
  marginRatePct: n(f.margin_rate_pct), checkoutFee: n(f.checkout_fee),
  blendedRatePct: n(f.blended_rate_pct), effectiveFrom: f.effective_from,
});
const publicSettlementFee = (s) => ({
  chargebackFee: n(s.chargeback_fee), refundFee: n(s.refund_fee), declineFee: n(s.decline_fee),
  settlementFeePct: n(s.settlement_fee_pct), settlementFeeFlat: n(s.settlement_fee_flat),
  reservePct: n(s.reserve_pct), reserveReleaseDays: n(s.reserve_release_days), effectiveFrom: s.effective_from,
});

// A platform admin holds a workspace_users row in every workspace; creating a
// workspace grants every platform admin, and promoting a user grants them
// everywhere. Both go through here.
async function grantPlatformAdminsAccess(c, workspaceId) {
  await c.query(
    `INSERT INTO workspace_users (workspace_id, user_id, role)
     SELECT $1, id, 'workspace_admin' FROM users WHERE is_platform_admin
     ON CONFLICT (workspace_id, user_id) DO NOTHING`, [workspaceId]);
}

router.get('/me', (req, res) => res.json({ isPlatformAdmin: true }));

// GET /platform/overview
router.get('/overview', asyncHandler(async (req, res) => {
  const counts = (await query(`
    SELECT (SELECT count(*) FROM workspaces) AS workspaces,
           (SELECT count(*) FROM workspaces WHERE status='active') AS workspaces_active,
           (SELECT count(*) FROM accounts) AS accounts,
           (SELECT count(*) FROM agents) AS agents,
           (SELECT count(*) FROM users) AS users`)).rows[0];
  const money = (await query(`
    SELECT COALESCE(SUM(re.gross) FILTER (WHERE re.entry_type='sale'),0) AS gross,
           COALESCE(SUM(re.psp_fee),0) AS psp_fees,
           COALESCE(SUM(re.platform_fee),0) AS platform_fees,
           COALESCE(SUM(re.platform_margin),0) AS higherpays_margin,
           COUNT(*) FILTER (WHERE re.entry_type='sale') AS sales
      FROM revenue_entries re`)).rows[0];
  res.json({ counts, money });
}));

// GET /platform/workspaces — every agency with its rate and live counters.
router.get('/workspaces', asyncHandler(async (req, res) => {
  const rows = (await query(`
    SELECT w.id, w.name, w.currency, w.status, w.merchant_id, w.created_at,
           (SELECT count(*) FROM accounts a WHERE a.workspace_id = w.id) AS accounts,
           (SELECT count(*) FROM agents ag WHERE ag.workspace_id = w.id) AS agents,
           (SELECT count(*) FROM workspace_users wu WHERE wu.workspace_id = w.id AND wu.status='active') AS members,
           (SELECT count(*) FROM payments p WHERE p.workspace_id = w.id AND p.status='paid') AS paid_payments,
           (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.workspace_id = w.id AND p.status='paid') AS gross_volume,
           (SELECT max(created_at) FROM audit_log a WHERE a.workspace_id = w.id) AS last_activity,
           f.blended_rate_pct
      FROM workspaces w
      LEFT JOIN LATERAL effective_platform_fee(w.id, now()) f ON true
     ORDER BY w.name`)).rows;
  res.json({
    workspaces: rows.map((w) => ({
      id: w.id, name: w.name, currency: w.currency, status: w.status, merchantId: w.merchant_id, createdAt: w.created_at,
      accounts: n(w.accounts), agents: n(w.agents), members: n(w.members),
      paidPayments: n(w.paid_payments), grossVolume: n(w.gross_volume), lastActivity: w.last_activity,
      blendedRatePct: n(w.blended_rate_pct),
    })),
  });
}));

// GET /platform/workspaces/:id — detail + fee history
router.get('/workspaces/:id', asyncHandler(async (req, res) => {
  const w = (await query('SELECT id, name, currency, status, merchant_id, webhook_endpoint_id, created_at FROM workspaces WHERE id=$1', [req.params.id])).rows[0];
  if (!w) return res.status(404).json({ error: 'not_found' });
  const feeHistory = (await query('SELECT * FROM platform_fee_rates WHERE workspace_id=$1 ORDER BY effective_from DESC', [w.id])).rows;
  const settlement = (await query('SELECT * FROM effective_settlement_fees($1, now())', [w.id])).rows[0];
  res.json({
    id: w.id, name: w.name, currency: w.currency, status: w.status, merchantId: w.merchant_id,
    webhookEndpointId: w.webhook_endpoint_id, createdAt: w.created_at,
    feeHistory: feeHistory.map(publicFee),
    settlementFee: settlement && settlement.id ? publicSettlementFee(settlement) : null,
  });
}));

// PUT /platform/workspaces/:id/platform-fee — a new versioned rate row.
router.put('/workspaces/:id/platform-fee', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const feeModel = b.feeModel || 'flat';
  const pspFixedFee = Number(b.pspFixedFee || 0);
  if (!vocab.FEE_MODEL.includes(feeModel)) return badRequest(res, 'invalid feeModel', ['feeModel']);
  if (!pct(b.pspRatePct) || !pct(b.marginRatePct)) return badRequest(res, 'pspRatePct/marginRatePct must be 0..100', ['pspRatePct', 'marginRatePct']);
  if (b.mdrPct != null && !pct(b.mdrPct)) return badRequest(res, 'mdrPct must be 0..100', ['mdrPct']);
  if (b.settlementPct != null && !pct(b.settlementPct)) return badRequest(res, 'settlementPct must be 0..100', ['settlementPct']);
  if (!(pspFixedFee >= 0)) return badRequest(res, 'pspFixedFee must be >= 0', ['pspFixedFee']);
  const checkoutFee = Number(b.checkoutFee || 0);
  if (!(checkoutFee >= 0)) return badRequest(res, 'checkoutFee must be >= 0', ['checkoutFee']);

  const ws = (await query('SELECT 1 FROM workspaces WHERE id=$1', [req.params.id])).rows[0];
  if (!ws) return res.status(404).json({ error: 'not_found' });
  const fee = (await query(
    `INSERT INTO platform_fee_rates (workspace_id, fee_model, psp_rate_pct, mdr_pct, settlement_pct, psp_fixed_fee, margin_rate_pct, checkout_fee, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.params.id, feeModel, b.pspRatePct, b.mdrPct ?? null, b.settlementPct ?? null, pspFixedFee, b.marginRatePct, checkoutFee, uid(req)])).rows[0];
  await audit({ workspaceId: req.params.id, actorUserId: uid(req), action: 'platform.fee.update', entityType: 'workspace', entityId: req.params.id, metadata: b });
  res.status(201).json(publicFee(fee));
}));

// PUT /platform/workspaces/:id/settlement-fee
router.put('/workspaces/:id/settlement-fee', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const nn = (v) => typeof v === 'number' && v >= 0;
  const vals = {
    chargebackFee: Number(b.chargebackFee || 0), refundFee: Number(b.refundFee || 0), declineFee: Number(b.declineFee || 0),
    settlementFeePct: Number(b.settlementFeePct || 0), settlementFeeFlat: Number(b.settlementFeeFlat || 0),
    reservePct: Number(b.reservePct || 0), reserveReleaseDays: Number(b.reserveReleaseDays || 0),
  };
  if (!Object.values(vals).every(nn)) return badRequest(res, 'all fees must be numbers >= 0');
  if (!pct(vals.reservePct) || !pct(vals.settlementFeePct)) return badRequest(res, 'percentages must be 0..100', ['reservePct', 'settlementFeePct']);

  const ws = (await query('SELECT 1 FROM workspaces WHERE id=$1', [req.params.id])).rows[0];
  if (!ws) return res.status(404).json({ error: 'not_found' });
  const row = (await query(
    `INSERT INTO settlement_fee_config (workspace_id, chargeback_fee, refund_fee, decline_fee, settlement_fee_pct, settlement_fee_flat, reserve_pct, reserve_release_days, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.params.id, vals.chargebackFee, vals.refundFee, vals.declineFee, vals.settlementFeePct, vals.settlementFeeFlat, vals.reservePct, vals.reserveReleaseDays, uid(req)])).rows[0];
  await audit({ workspaceId: req.params.id, actorUserId: uid(req), action: 'platform.settlement_fee.update', entityType: 'workspace', entityId: req.params.id, metadata: vals });
  res.status(201).json(publicSettlementFee(row));
}));

// PATCH /platform/workspaces/:id/status  { status }
router.patch('/workspaces/:id/status', asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  if (!vocab.WORKSPACE_STATUS.includes(status)) return badRequest(res, 'invalid status', ['status']);
  const w = (await query('UPDATE workspaces SET status=$2 WHERE id=$1 RETURNING id, name, status', [req.params.id, status])).rows[0];
  if (!w) return res.status(404).json({ error: 'not_found' });
  await audit({ workspaceId: w.id, actorUserId: uid(req), action: 'platform.workspace.status', entityType: 'workspace', entityId: w.id, metadata: { status } });
  res.json(w);
}));

// POST /platform/agencies — onboard a new agency in one step: workspace,
// rate card, settlement fees, default split, and an invite for its first
// admin (who sets their own password via the link).
router.post('/agencies', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const currency = (b.currency || 'EUR').toUpperCase();
  const accountSplitPct = b.accountSplitPct == null ? 70 : Number(b.accountSplitPct);
  const agentPct = b.agentPct == null ? 0 : Number(b.agentPct);
  if (!isStr(b.name, 120)) return badRequest(res, 'name is required', ['name']);
  if (!isStr(b.adminEmail, 120) || !b.adminEmail.includes('@')) return badRequest(res, 'a valid adminEmail is required', ['adminEmail']);
  if (!config.supportedCurrencies.includes(currency)) return badRequest(res, `currency ${currency} is not enabled`, ['currency']);
  if (!pct(b.pspRatePct) || !pct(b.marginRatePct)) return badRequest(res, 'pspRatePct/marginRatePct must be 0..100', ['pspRatePct', 'marginRatePct']);
  if (!pct(accountSplitPct) || !pct(agentPct) || accountSplitPct + agentPct > 100) return badRequest(res, 'splits must be 0..100 and fit together', ['accountSplitPct', 'agentPct']);

  const token = crypto.randomBytes(32).toString('base64url');
  const out = await withTransaction(async (c) => {
    const ws = (await c.query(
      'INSERT INTO workspaces (name, currency, merchant_id) VALUES ($1,$2,$3) RETURNING id, webhook_endpoint_id',
      [b.name.trim(), currency, b.merchantId || null])).rows[0];
    // Effective from the beginning of time so any backfilled history is priced.
    await c.query(
      `INSERT INTO platform_fee_rates (workspace_id, fee_model, psp_rate_pct, mdr_pct, settlement_pct, psp_fixed_fee, margin_rate_pct, checkout_fee, effective_from, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'-infinity',$9)`,
      [ws.id, vocab.FEE_MODEL.includes(b.feeModel) ? b.feeModel : 'flat', b.pspRatePct, b.mdrPct ?? null, b.settlementPct ?? null, Number(b.pspFixedFee || 0), b.marginRatePct, Number(b.checkoutFee || 0), uid(req)]);
    await c.query(
      `INSERT INTO settlement_fee_config (workspace_id, chargeback_fee, refund_fee, decline_fee, effective_from, created_by_user_id)
       VALUES ($1,$2,$3,$4,'-infinity',$5)`,
      [ws.id, Number(b.chargebackFee || 0), Number(b.refundFee || 0), Number(b.declineFee || 0), uid(req)]);
    await c.query(
      `INSERT INTO revenue_rules (workspace_id, account_split_pct, agency_split_pct, agent_pct, effective_from, created_by_user_id)
       VALUES ($1,$2,$3,$4,'-infinity',$5)`, [ws.id, accountSplitPct, 100 - accountSplitPct, agentPct, uid(req)]);
    await grantPlatformAdminsAccess(c, ws.id);
    await c.query(
      'INSERT INTO invites (workspace_id, email, role, token_hash, invited_by_user_id, expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [ws.id, b.adminEmail, 'workspace_admin', hashToken(token), uid(req), new Date(Date.now() + 7 * 86400 * 1000)]);
    return ws;
  });

  const link = `${config.appPublicBase}/accept-invite?token=${token}`;
  await sendEmail({ to: b.adminEmail, subject: `You're invited to run ${b.name} on HigherPays`, body: `Set up your login: ${link}` });
  await audit({ workspaceId: out.id, actorUserId: uid(req), action: 'platform.agency.onboard', entityType: 'workspace', entityId: out.id, metadata: { name: b.name, adminEmail: b.adminEmail } });
  res.status(201).json({ workspaceId: out.id, name: b.name, webhookEndpointId: out.webhook_endpoint_id, blendedRatePct: b.pspRatePct + b.marginRatePct });
}));

// PATCH /platform/users/:id/platform-admin  { isPlatformAdmin }
router.patch('/users/:id/platform-admin', asyncHandler(async (req, res) => {
  const on = !!(req.body || {}).isPlatformAdmin;
  if (req.params.id === uid(req) && !on) return res.status(403).json({ error: 'cannot_demote_self' });
  const user = await withTransaction(async (c) => {
    const u = (await c.query('UPDATE users SET is_platform_admin=$2 WHERE id=$1 RETURNING id, email, is_platform_admin', [req.params.id, on])).rows[0];
    if (!u) return null;
    if (on) {
      await c.query(
        `INSERT INTO workspace_users (workspace_id, user_id, role) SELECT id, $1, 'workspace_admin' FROM workspaces
         ON CONFLICT (workspace_id, user_id) DO NOTHING`, [u.id]);
    }
    return u;
  });
  if (!user) return res.status(404).json({ error: 'not_found' });
  await audit({ actorUserId: uid(req), action: 'platform.admin.grant', entityType: 'user', entityId: user.id, metadata: { isPlatformAdmin: on } });
  res.json({ id: user.id, email: user.email, isPlatformAdmin: user.is_platform_admin });
}));

// GET /platform/activity — recent actions across all agencies
router.get('/activity', asyncHandler(async (req, res) => {
  const rows = (await query(
    `SELECT a.action, a.entity_type, a.created_at, w.name AS workspace, u.email AS actor, u.full_name AS actor_name
       FROM audit_log a LEFT JOIN workspaces w ON w.id = a.workspace_id LEFT JOIN users u ON u.id = a.actor_user_id
      ORDER BY a.created_at DESC LIMIT 100`)).rows;
  res.json({ activity: rows });
}));

// GET /platform/fees?from&to — itemised fees for every agency, side by side.
router.get('/fees', asyncHandler(async (req, res) => {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
  const rows = (await query(
    `SELECT w.id AS workspace_id, w.name AS agency,
            COUNT(re.id) FILTER (WHERE re.entry_type='sale')                    AS sales,
            COALESCE(SUM(re.gross) FILTER (WHERE re.entry_type='sale'),0)       AS gross,
            COALESCE(SUM(re.fee_mdr),0) AS mdr, COALESCE(SUM(re.fee_fixed),0) AS fixed,
            COALESCE(SUM(re.fee_settlement),0) AS settlement, COALESCE(SUM(re.fee_surcharge),0) AS surcharge,
            COALESCE(SUM(re.platform_margin),0) AS hp_margin, COALESCE(SUM(re.chargeback_fee),0) AS reversal_fees,
            COALESCE(SUM(re.platform_fee),0) AS total_deducted,
            p.fee_model, p.mdr_pct, p.settlement_pct, p.psp_fixed_fee, p.margin_rate_pct, p.psp_rate_pct
       FROM workspaces w
       LEFT JOIN revenue_entries re ON re.workspace_id = w.id
       LEFT JOIN transactions t ON t.id = re.transaction_id AND t.occurred_at >= $1 AND t.occurred_at <= $2
       LEFT JOIN LATERAL effective_platform_fee(w.id, now()) p ON true
      WHERE t.id IS NOT NULL OR re.id IS NULL
      GROUP BY w.id, w.name, p.fee_model, p.mdr_pct, p.settlement_pct, p.psp_fixed_fee, p.margin_rate_pct, p.psp_rate_pct
      ORDER BY gross DESC`, [from.toISOString(), to.toISOString()])).rows;

  const agencies = rows.map((x) => {
    const gross = n(x.gross);
    const providerTotal = n(x.mdr) + n(x.fixed) + n(x.settlement);
    const ourRevenue = n(x.hp_margin) + n(x.surcharge);
    return {
      workspaceId: x.workspace_id, agency: x.agency, sales: n(x.sales), gross: r2(gross),
      providerFees: { mdr: r2(x.mdr), fixed: r2(x.fixed), settlement: r2(x.settlement), reversalFees: r2(x.reversal_fees), total: r2(providerTotal), percentOfGross: gross ? r2(providerTotal / gross * 100) : 0 },
      higherPays: { margin: r2(x.hp_margin), surcharge: r2(x.surcharge), total: r2(ourRevenue), percentOfGross: gross ? r2(ourRevenue / gross * 100) : 0 },
      totalDeducted: r2(x.total_deducted),
      rateCard: { feeModel: x.fee_model || 'flat', mdrPct: x.mdr_pct == null ? n(x.psp_rate_pct) : n(x.mdr_pct), settlementPct: n(x.settlement_pct), fixedFee: n(x.psp_fixed_fee), marginPct: n(x.margin_rate_pct) },
    };
  });
  res.json({
    range: { from: from.toISOString(), to: to.toISOString() },
    agencies,
    totals: {
      gross: r2(agencies.reduce((s, a) => s + a.gross, 0)),
      providerFees: r2(agencies.reduce((s, a) => s + a.providerFees.total, 0)),
      higherPaysRevenue: r2(agencies.reduce((s, a) => s + a.higherPays.total, 0)),
    },
  });
}));

module.exports = router;
