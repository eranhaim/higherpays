'use strict';
// The HigherPays operator console, above any single workspace. Mounted behind
// requireAuth + requirePlatformAdmin.
const config = require('../config');
const express = require('express');
const crypto = require('crypto');
const { query, withTransaction } = require('../db');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { requirePlatformAdmin } = require('../middleware');
const { signImpersonationToken } = require('../auth/tokens');
const { ensureWorkspaceRoles } = require('../services/workspaceRoles');
const { isStr, badRequest } = require('../util/validate');
const { sendEmail } = require('../util/email');
const { status: vocab } = require('../schema/entities');

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const router = express.Router();
const { uid } = require('../lib/scope');
const pct = (v) => typeof v === 'number' && v >= 0 && v <= 100;
const n = (v) => Number(v || 0);
const r2 = (v) => Math.round(v * 100) / 100;

router.post('/impersonation/stop', asyncHandler(async (req, res) => {
  if (!req.user.actorId) return res.status(400).json({ error: 'not_impersonating' });
  await audit({
    workspaceId: req.user.impersonationWorkspaceId,
    actorUserId: req.user.id,
    action: 'platform.impersonation.stop',
    entityType: 'user',
    entityId: req.user.id,
  });
  res.status(204).end();
}));

router.use(requirePlatformAdmin);

router.get('/impersonation/targets', asyncHandler(async (req, res) => {
  const params = [uid(req)];
  const workspaceFilter = req.query.workspaceId ? 'AND wu.workspace_id=$2' : '';
  if (req.query.workspaceId) params.push(req.query.workspaceId);
  const rows = (await query(
    `SELECT wu.workspace_id, w.name AS workspace_name, wu.user_id,
            u.full_name, u.email, wu.role,
            CASE wu.role
              WHEN 'agent' THEN w.agent_label
              WHEN 'account_owner' THEN w.account_label || ' owner'
              ELSE wr.name
            END AS role_name
       FROM workspace_users wu
       JOIN users u ON u.id=wu.user_id
       JOIN workspaces w ON w.id=wu.workspace_id
       JOIN workspace_roles wr ON wr.workspace_id=wu.workspace_id AND wr.key=wu.role
      WHERE wu.status='active' AND w.status='active'
        AND u.is_platform_admin=false AND wu.user_id<>$1
        ${workspaceFilter}
      ORDER BY w.name, u.full_name`,
    params)).rows;
  res.json({
    targets: rows.map((row) => ({
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      userId: row.user_id,
      fullName: row.full_name,
      email: row.email,
      role: row.role,
      roleName: row.role_name,
    })),
  });
}));

router.post('/impersonation/start', asyncHandler(async (req, res) => {
  const workspaceId = String(req.body?.workspaceId || '');
  const userId = String(req.body?.userId || '');
  if (!workspaceId || !userId) return res.status(400).json({ error: 'target_required' });
  const target = (await query(
    `SELECT u.id, u.email, u.full_name, u.is_platform_admin, u.two_factor_enabled,
            wu.role, wr.name AS role_name, w.name AS workspace_name, w.currency,
            w.account_label, w.account_label_plural, w.agent_label, w.agent_label_plural
       FROM workspace_users wu
       JOIN users u ON u.id=wu.user_id
       JOIN workspaces w ON w.id=wu.workspace_id
       JOIN workspace_roles wr ON wr.workspace_id=wu.workspace_id AND wr.key=wu.role
      WHERE wu.workspace_id=$1 AND wu.user_id=$2
        AND wu.status='active' AND u.status='active' AND w.status='active'`,
    [workspaceId, userId])).rows[0];
  if (!target) return res.status(404).json({ error: 'target_not_found' });
  if (target.is_platform_admin || target.id === uid(req)) {
    return res.status(403).json({ error: 'impersonation_target_forbidden' });
  }
  const actor = (await query('SELECT id FROM users WHERE id=$1', [uid(req)])).rows[0];
  const token = signImpersonationToken({ actor, subject: target, workspaceId, role: target.role });
  await audit({
    workspaceId, actorUserId: uid(req), action: 'platform.impersonation.start',
    entityType: 'user', entityId: target.id, metadata: { role: target.role },
  });
  res.json({
    accessToken: token,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    user: {
      id: target.id,
      email: target.email,
      fullName: target.full_name,
      isPlatformAdmin: !!target.is_platform_admin,
      twoFactorEnabled: !!target.two_factor_enabled,
    },
    workspace: {
      id: workspaceId,
      name: target.workspace_name,
      currency: target.currency,
      role: target.role,
      roleName: target.role === 'agent' ? target.agent_label
        : target.role === 'account_owner' ? `${target.account_label} owner`
          : target.role_name,
      status: 'active',
      labels: {
        account: target.account_label,
        accounts: target.account_label_plural,
        agent: target.agent_label,
        agents: target.agent_label_plural,
      },
    },
  });
}));

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
     ON CONFLICT (workspace_id, user_id)
     DO UPDATE SET role='workspace_admin', status='active'`, [workspaceId]);
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
           f.blended_rate_pct, f.psp_rate_pct, f.settlement_pct, f.margin_rate_pct,
           f.psp_fixed_fee, f.checkout_fee
      FROM workspaces w
      LEFT JOIN LATERAL effective_platform_fee(w.id, now()) f ON true
     ORDER BY w.name`)).rows;
  res.json({
    workspaces: rows.map((w) => ({
      id: w.id, name: w.name, currency: w.currency, status: w.status, merchantId: w.merchant_id, createdAt: w.created_at,
      accounts: n(w.accounts), agents: n(w.agents), members: n(w.members),
      paidPayments: n(w.paid_payments), grossVolume: n(w.gross_volume), lastActivity: w.last_activity,
      blendedRatePct: n(w.blended_rate_pct), pspRatePct: n(w.psp_rate_pct),
      settlementPct: w.settlement_pct == null ? 0 : n(w.settlement_pct),
      marginRatePct: n(w.margin_rate_pct), pspFixedFee: n(w.psp_fixed_fee), checkoutFee: n(w.checkout_fee),
    })),
  });
}));

// GET /platform/workspaces/:id — detail + fee history
router.get('/workspaces/:id', asyncHandler(async (req, res) => {
  const w = (await query('SELECT id, name, currency, status, merchant_id, webhook_endpoint_id, created_at FROM workspaces WHERE id=$1', [req.params.id])).rows[0];
  if (!w) return res.status(404).json({ error: 'not_found' });
  const feeHistory = (await query('SELECT * FROM platform_fee_rates WHERE workspace_id=$1 ORDER BY effective_from DESC', [w.id])).rows;
  const settlement = (await query('SELECT * FROM effective_settlement_fees($1, now())', [w.id])).rows[0];
  const hasMoneyHistory = (await query(
    `SELECT EXISTS (
       SELECT 1 FROM payment_links WHERE workspace_id=$1
       UNION ALL SELECT 1 FROM payments WHERE workspace_id=$1
       UNION ALL SELECT 1 FROM payouts WHERE workspace_id=$1
       UNION ALL SELECT 1 FROM settlements WHERE workspace_id=$1
       UNION ALL SELECT 1 FROM transactions WHERE workspace_id=$1
     ) AS found`,
    [w.id])).rows[0].found;
  res.json({
    id: w.id, name: w.name, currency: w.currency, status: w.status, merchantId: w.merchant_id,
    webhookEndpointId: w.webhook_endpoint_id, createdAt: w.created_at,
    currencyChangeAllowed: !hasMoneyHistory,
    feeHistory: feeHistory.map(publicFee),
    settlementFee: settlement && settlement.id ? publicSettlementFee(settlement) : null,
  });
}));

// PATCH /platform/workspaces/:id/currency — only a completely unused money
// workspace may change denomination. The workspace lock makes the history
// check atomic with child-row inserts, whose foreign keys take a conflicting
// key-share lock.
router.patch('/workspaces/:id/currency', asyncHandler(async (req, res) => {
  const currency = String(req.body?.currency || '').toUpperCase();
  if (!['EUR', 'USD', 'GBP'].includes(currency)) {
    return badRequest(res, 'currency must be EUR, USD, or GBP', ['currency']);
  }
  const out = await withTransaction(async (c) => {
    const workspace = (await c.query(
      'SELECT id, currency FROM workspaces WHERE id=$1 FOR UPDATE',
      [req.params.id])).rows[0];
    if (!workspace) return { error: 'not_found', status: 404 };
    if (workspace.currency === currency) return { workspace, changed: false };
    const history = (await c.query(
      `SELECT EXISTS (
         SELECT 1 FROM payment_links WHERE workspace_id=$1
         UNION ALL SELECT 1 FROM payments WHERE workspace_id=$1
         UNION ALL SELECT 1 FROM payouts WHERE workspace_id=$1
         UNION ALL SELECT 1 FROM settlements WHERE workspace_id=$1
         UNION ALL SELECT 1 FROM transactions WHERE workspace_id=$1
       ) AS found`,
      [workspace.id])).rows[0].found;
    if (history) return { error: 'currency_history_exists', status: 409 };
    const updated = (await c.query(
      'UPDATE workspaces SET currency=$2 WHERE id=$1 RETURNING id, currency',
      [workspace.id, currency])).rows[0];
    await c.query(
      `INSERT INTO audit_log
         (workspace_id, actor_user_id, effective_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1,$2,$2,'platform.workspace.currency','workspace',$1,$3)`,
      [workspace.id, uid(req), { from: workspace.currency, to: currency }]);
    return { workspace: updated, changed: true };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json({ id: out.workspace.id, currency: out.workspace.currency, changed: out.changed });
}));

// PUT /platform/workspaces/:id/platform-fee — a new versioned rate row.
router.put('/workspaces/:id/platform-fee', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const feeModel = b.feeModel || 'flat';
  const pspFixedFee = Number(b.pspFixedFee || 0);
  const settlementPct = b.settlementPct == null ? 0 : Number(b.settlementPct);
  if (!vocab.FEE_MODEL.includes(feeModel)) return badRequest(res, 'invalid feeModel', ['feeModel']);
  if (!pct(b.pspRatePct) || !pct(b.marginRatePct)) return badRequest(res, 'pspRatePct/marginRatePct must be 0..100', ['pspRatePct', 'marginRatePct']);
  if (b.mdrPct != null && !pct(b.mdrPct)) return badRequest(res, 'mdrPct must be 0..100', ['mdrPct']);
  if (!pct(settlementPct)) return badRequest(res, 'settlementPct must be 0..100', ['settlementPct']);
  if (!(pspFixedFee >= 0)) return badRequest(res, 'pspFixedFee must be >= 0', ['pspFixedFee']);
  const checkoutFee = Number(b.checkoutFee || 0);
  if (!(checkoutFee >= 0)) return badRequest(res, 'checkoutFee must be >= 0', ['checkoutFee']);

  const ws = (await query('SELECT 1 FROM workspaces WHERE id=$1', [req.params.id])).rows[0];
  if (!ws) return res.status(404).json({ error: 'not_found' });
  const fee = (await query(
    `INSERT INTO platform_fee_rates (workspace_id, fee_model, psp_rate_pct, mdr_pct, settlement_pct, psp_fixed_fee, margin_rate_pct, checkout_fee, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.params.id, settlementPct > 0 ? 'cascade' : feeModel, b.pspRatePct,
      settlementPct > 0 ? Number(b.pspRatePct) : b.mdrPct ?? null,
      settlementPct, pspFixedFee, b.marginRatePct, checkoutFee, uid(req)])).rows[0];
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
  const settlementPct = b.settlementPct == null ? 0 : Number(b.settlementPct);
  if (!isStr(b.name, 120)) return badRequest(res, 'name is required', ['name']);
  if (!isStr(b.adminEmail, 120) || !b.adminEmail.includes('@')) return badRequest(res, 'a valid adminEmail is required', ['adminEmail']);
  if (!config.supportedCurrencies.includes(currency)) return badRequest(res, `currency ${currency} is not enabled`, ['currency']);
  if (!pct(b.pspRatePct) || !pct(b.marginRatePct)) return badRequest(res, 'pspRatePct/marginRatePct must be 0..100', ['pspRatePct', 'marginRatePct']);
  if (!pct(settlementPct)) return badRequest(res, 'settlementPct must be 0..100', ['settlementPct']);

  const token = crypto.randomBytes(32).toString('base64url');
  const out = await withTransaction(async (c) => {
    const ws = (await c.query(
      'INSERT INTO workspaces (name, currency, merchant_id) VALUES ($1,$2,$3) RETURNING id, webhook_endpoint_id',
      [b.name.trim(), currency, b.merchantId || null])).rows[0];
    await ensureWorkspaceRoles(c, ws.id);
    // Effective from the beginning of time so any backfilled history is priced.
    await c.query(
      `INSERT INTO platform_fee_rates (workspace_id, fee_model, psp_rate_pct, mdr_pct, settlement_pct, psp_fixed_fee, margin_rate_pct, checkout_fee, effective_from, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'-infinity',$9)`,
      [ws.id, settlementPct > 0 ? 'cascade' : vocab.FEE_MODEL.includes(b.feeModel) ? b.feeModel : 'flat',
        b.pspRatePct, settlementPct > 0 ? Number(b.pspRatePct) : b.mdrPct ?? null,
        settlementPct, Number(b.pspFixedFee || 0), b.marginRatePct, Number(b.checkoutFee || 0), uid(req)]);
    await c.query(
      `INSERT INTO settlement_fee_config (workspace_id, chargeback_fee, refund_fee, decline_fee, effective_from, created_by_user_id)
       VALUES ($1,$2,$3,$4,'-infinity',$5)`,
      [ws.id, Number(b.chargebackFee || 0), Number(b.refundFee || 0), Number(b.declineFee || 0), uid(req)]);
    await c.query(
      `INSERT INTO revenue_rules (workspace_id, account_split_pct, agency_split_pct, agent_pct, effective_from, created_by_user_id)
       VALUES ($1,0,100,0,'-infinity',$2)`, [ws.id, uid(req)]);
    await grantPlatformAdminsAccess(c, ws.id);
    await c.query(
      'INSERT INTO invites (workspace_id, email, role, token_hash, invited_by_user_id, expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [ws.id, b.adminEmail, 'workspace_owner', hashToken(token), uid(req), new Date(Date.now() + 7 * 86400 * 1000)]);
    return ws;
  });

  const link = `${config.appPublicBase}/accept-invite?token=${token}`;
  await sendEmail({ to: b.adminEmail, subject: `You're invited to run ${b.name} on HigherPays`, body: `Set up your login: ${link}` });
  await audit({ workspaceId: out.id, actorUserId: uid(req), action: 'platform.agency.onboard', entityType: 'workspace', entityId: out.id, metadata: { name: b.name, adminEmail: b.adminEmail } });
  res.status(201).json({
    workspaceId: out.id,
    name: b.name,
    webhookEndpointId: out.webhook_endpoint_id,
    blendedRatePct: b.pspRatePct + settlementPct + b.marginRatePct,
  });
}));

// PATCH /platform/users/:id/platform-admin  { isPlatformAdmin }
router.patch('/users/:id/platform-admin', asyncHandler(async (req, res) => {
  const on = !!(req.body || {}).isPlatformAdmin;
  if (req.params.id === uid(req) && !on) return res.status(403).json({ error: 'cannot_demote_self' });
  const user = await withTransaction(async (c) => {
    if (on) {
      const profile = (await c.query(
        `SELECT 1 FROM agents WHERE user_id=$1
         UNION ALL SELECT 1 FROM accounts WHERE user_id=$1 LIMIT 1`,
        [req.params.id])).rows[0];
      if (profile) return { error: 'profile_user_cannot_be_platform_admin' };
    }
    const u = (await c.query('UPDATE users SET is_platform_admin=$2 WHERE id=$1 RETURNING id, email, is_platform_admin', [req.params.id, on])).rows[0];
    if (!u) return null;
    if (on) {
      await c.query(
        `INSERT INTO workspace_users (workspace_id, user_id, role) SELECT id, $1, 'workspace_admin' FROM workspaces
         ON CONFLICT (workspace_id, user_id)
         DO UPDATE SET role='workspace_admin', status='active'`, [u.id]);
    }
    return u;
  });
  if (user?.error) return res.status(409).json({ error: user.error });
  if (!user) return res.status(404).json({ error: 'not_found' });
  await audit({ actorUserId: uid(req), action: 'platform.admin.grant', entityType: 'user', entityId: user.id, metadata: { isPlatformAdmin: on } });
  res.json({ id: user.id, email: user.email, isPlatformAdmin: user.is_platform_admin });
}));

// GET /platform/activity — recent actions across all agencies
router.get('/activity', asyncHandler(async (req, res) => {
  const rows = (await query(
    `SELECT a.action, a.entity_type, a.created_at, w.name AS workspace,
            actor.email AS actor, actor.full_name AS actor_name,
            effective.email AS effective_user, effective.full_name AS effective_user_name
       FROM audit_log a
       LEFT JOIN workspaces w ON w.id = a.workspace_id
       LEFT JOIN users actor ON actor.id = a.actor_user_id
       LEFT JOIN users effective ON effective.id = a.effective_user_id
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
