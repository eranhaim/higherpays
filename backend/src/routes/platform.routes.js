'use strict';
const config = require('../config');
const express = require('express');
const crypto = require('crypto');
const { withPlatformAdmin } = require('../db');
const { requirePlatformRole } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { isStr, badRequest } = require('../util/validate');
const { seedRolesForWorkspace } = require('../auth/permissions');
const { sendEmail } = require('../util/email');
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

// Mounted at /platform behind requireAuth + requirePlatformAdmin.
// Every handler runs in a platform-admin DB context (crosses tenants).
// Reads are open to every platform role; `finance` may reprice an agency;
// only `super_admin` may onboard or suspend one.
const router = express.Router();
const { uid } = require('../lib/scope');
const pct = (v) => typeof v === 'number' && v >= 0 && v <= 100;
const superAdminOnly = requirePlatformRole('super_admin');
const financeOrSuperAdmin = requirePlatformRole('super_admin', 'finance');

// GET /platform/overview — the real back office summary across all agencies.
router.get('/overview', asyncHandler(async (req, res) => {
  const data = await withPlatformAdmin(uid(req), async (c) => {
    const counts = (await c.query(`
      SELECT
        (SELECT count(*) FROM organizations)               AS agencies,
        (SELECT count(*) FROM organizations WHERE status='active') AS agencies_active,
        (SELECT count(*) FROM workspaces)                  AS workspaces,
        (SELECT count(*) FROM accounts)                     AS accounts,
        (SELECT count(*) FROM users)                       AS users`)).rows[0];
    const money = (await c.query(`
      SELECT
        COALESCE(SUM(gross),0)           AS gross,
        COALESCE(SUM(fee),0)             AS psp_fees,
        COALESCE(SUM(platform_fee),0)    AS platform_fees,
        COALESCE(SUM(platform_margin),0) AS higherpays_margin,
        COUNT(*)                         AS transactions
      FROM transactions WHERE status='approved'`)).rows[0];
    return { counts, money };
  });
  res.json(data);
}));

// GET /platform/organizations — every agency with its current blended fee.
router.get('/organizations', asyncHandler(async (req, res) => {
  const rows = await withPlatformAdmin(uid(req), async (c) => (await c.query(`
    SELECT o.id, o.name, o.slug, o.status, o.created_at,
           (SELECT count(*) FROM workspaces w WHERE w.organization_id = o.id) AS workspaces,
           pf.psp_rate_pct, pf.margin_rate_pct, pf.blended_rate_pct
    FROM organizations o
    LEFT JOIN LATERAL (
      SELECT psp_rate_pct, margin_rate_pct, blended_rate_pct
      FROM platform_fee_rates p WHERE p.organization_id = o.id
      ORDER BY effective_from DESC LIMIT 1
    ) pf ON true
    ORDER BY o.created_at DESC`)).rows);
  res.json({ organizations: rows });
}));

// GET /platform/organizations/:orgId — detail + workspaces + fee history.
router.get('/organizations/:orgId', asyncHandler(async (req, res) => {
  const data = await withPlatformAdmin(uid(req), async (c) => {
    const org = (await c.query('SELECT id, name, slug, status, created_at FROM organizations WHERE id=$1', [req.params.orgId])).rows[0];
    if (!org) return null;
    const workspaces = (await c.query('SELECT id, name, mid, currency, status FROM workspaces WHERE organization_id=$1', [org.id])).rows;
    const feeHistory = (await c.query(
      'SELECT psp_rate_pct, margin_rate_pct, blended_rate_pct, effective_from FROM platform_fee_rates WHERE organization_id=$1 ORDER BY effective_from DESC', [org.id])).rows;
    return { ...org, workspaces, feeHistory };
  });
  if (!data) return res.status(404).json({ error: 'not_found' });
  res.json(data);
}));

// PUT /platform/organizations/:orgId/platform-fee  { pspRatePct, marginRatePct }
// The operator sets an agency's PSP rate and HigherPays margin (versioned).
router.put('/organizations/:orgId/platform-fee', financeOrSuperAdmin, asyncHandler(async (req, res) => {
  const { pspRatePct, marginRatePct } = req.body || {};
  const pspFixedFee = Number((req.body || {}).pspFixedFee || 0);
  if (!pct(pspRatePct)) return badRequest(res, 'pspRatePct must be 0..100', ['pspRatePct']);
  if (!pct(marginRatePct)) return badRequest(res, 'marginRatePct must be 0..100', ['marginRatePct']);
  if (!(pspFixedFee >= 0)) return badRequest(res, 'pspFixedFee must be >= 0', ['pspFixedFee']);

  const row = await withPlatformAdmin(uid(req), async (c) => {
    const org = (await c.query('SELECT 1 FROM organizations WHERE id=$1', [req.params.orgId])).rows[0];
    if (!org) return { err: 'not_found' };
    return {
      fee: (await c.query(
        `INSERT INTO platform_fee_rates (organization_id, psp_rate_pct, margin_rate_pct, psp_fixed_fee, created_by)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING psp_rate_pct, margin_rate_pct, blended_rate_pct, psp_fixed_fee, effective_from`,
        [req.params.orgId, pspRatePct, marginRatePct, pspFixedFee, uid(req)])).rows[0],
    };
  });
  if (row.err) return res.status(404).json({ error: row.err });
  await audit({ actorUserId: uid(req), action: 'platform.fee.update', entityType: 'organization', entityId: req.params.orgId, metadata: { pspRatePct, marginRatePct, pspFixedFee, platformRole: req.platformRole } });
  res.status(201).json(row.fee);
}));

// PATCH /platform/organizations/:orgId/status  { status: 'active' | 'suspended' }
router.patch('/organizations/:orgId/status', superAdminOnly, asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'suspended', 'archived'].includes(status)) return badRequest(res, 'invalid status', ['status']);
  const org = await withPlatformAdmin(uid(req), async (c) => (await c.query(
    'UPDATE organizations SET status=$2 WHERE id=$1 RETURNING id, name, status', [req.params.orgId, status])).rows[0]);
  if (!org) return res.status(404).json({ error: 'not_found' });
  await audit({ actorUserId: uid(req), action: 'platform.org.status', entityType: 'organization', entityId: org.id, metadata: { status, platformRole: req.platformRole } });
  res.json(org);
}));

// POST /platform/agencies — super-admin onboards a NEW agency in one step:
// organization + workspace + roles + platform fee + settlement fee + commission
// splits + an owner invite (the new owner sets their own password via the link).
router.post('/agencies', superAdminOnly, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const currency = (b.currency || 'EUR').toUpperCase();
  const accountSplitPct = b.accountSplitPct == null ? 70 : Number(b.accountSplitPct);
  const agentPct = b.agentPct == null ? 0 : Number(b.agentPct);
  const chargebackFee = b.chargebackFee == null ? 0 : Number(b.chargebackFee);
  if (!isStr(b.agencyName, 120)) return badRequest(res, 'agencyName is required', ['agencyName']);
  if (!isStr(b.ownerEmail, 120) || !b.ownerEmail.includes('@')) return badRequest(res, 'a valid ownerEmail is required', ['ownerEmail']);
  if (!/^[A-Z]{3}$/.test(currency)) return badRequest(res, 'currency must be 3 letters', ['currency']);
  if (!config.supportedCurrencies.includes(currency)) {
    return badRequest(res, `currency ${currency} is not enabled (supported: ${config.supportedCurrencies.join(', ')})`, ['currency']);
  }
  if (!pct(b.pspRatePct) || !pct(b.marginRatePct)) return badRequest(res, 'pspRatePct/marginRatePct must be 0..100', ['pspRatePct', 'marginRatePct']);
  if (!pct(accountSplitPct) || !pct(agentPct)) return badRequest(res, 'splits must be 0..100', ['accountSplitPct', 'agentPct']);
  if (!(chargebackFee >= 0)) return badRequest(res, 'chargebackFee must be >= 0', ['chargebackFee']);

  const token = crypto.randomBytes(32).toString('base64url');
  const out = await withPlatformAdmin(uid(req), async (c) => {
    const slug = b.agencyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '-' + Math.random().toString(36).slice(2, 7);
    const org = (await c.query('INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id', [b.agencyName, slug])).rows[0];
    const ws = (await c.query(
      "INSERT INTO workspaces (organization_id, name, currency, mid, provider_name) VALUES ($1,$2,$3,$4,'mantapay') RETURNING id, webhook_endpoint_id",
      [org.id, b.agencyName, currency, b.mid || null])).rows[0];
    await seedRolesForWorkspace(c, ws.id);
    // Initial rates are effective from the beginning of time so any historical
    // transactions an agency backfills are still priced correctly. Later rate
    // *changes* (set-fee / set-settlement) take effect from their own date.
    await c.query("INSERT INTO platform_fee_rates (organization_id, psp_rate_pct, margin_rate_pct, psp_fixed_fee, effective_from) VALUES ($1,$2,$3,$4,'-infinity')", [org.id, b.pspRatePct, b.marginRatePct, Number(b.pspFixedFee || 0)]);
    await c.query("INSERT INTO settlement_fee_config (organization_id, chargeback_fee, refund_fee, decline_fee, effective_from) VALUES ($1,$2,$3,$4,'-infinity')", [org.id, chargebackFee, Number(b.refundFee || 0), Number(b.declineFee || 0)]);
    await c.query("INSERT INTO commission_rules (workspace_id, account_id, account_split_pct, agency_split_pct, agent_pct, effective_from) VALUES ($1,NULL,$2,$3,$4,'-infinity')",
      [ws.id, accountSplitPct, 100 - accountSplitPct, agentPct]);
    const expires = new Date(Date.now() + 7 * 86400 * 1000);
    await c.query('INSERT INTO invites (workspace_id, email, role, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [ws.id, b.ownerEmail, 'owner', hashToken(token), uid(req), expires]);
    return { orgId: org.id, wsId: ws.id, webhook: ws.webhook_endpoint_id };
  });

  const link = `https://app.higherpays.com/accept-invite?token=${token}`;
  await sendEmail({ to: b.ownerEmail, subject: `You're invited to run ${b.agencyName} on HigherPays`, body: `Set up your owner login: ${link}` });
  await audit({ actorUserId: uid(req), action: 'platform.agency.onboard', entityType: 'workspace', entityId: out.wsId, metadata: { agencyName: b.agencyName, ownerEmail: b.ownerEmail, platformRole: req.platformRole } });
  res.status(201).json({
    workspaceId: out.wsId, organizationId: out.orgId, name: b.agencyName,
    blendedRatePct: b.pspRatePct + b.marginRatePct,
    webhookEndpointId: out.webhook,
    // The owner's invite token is a bearer credential for the new workspace and
    // only ever reaches their address. Tests read it from the email stub.
  });
}));

// PUT /platform/organizations/:orgId/settlement-fee
// Super-admin sets the chargeback fee + settlement fees (mock now, editable).
router.put('/organizations/:orgId/settlement-fee', financeOrSuperAdmin, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { chargebackFee, settlementFeePct, settlementFeeFlat } = b;
  const refundFee = Number(b.refundFee || 0), declineFee = Number(b.declineFee || 0);
  const reservePct = Number(b.reservePct || 0), reserveReleaseDays = Number(b.reserveReleaseDays || 0);
  const nn = (v) => typeof v === 'number' && v >= 0;
  if (!nn(chargebackFee) || !nn(settlementFeePct) || !nn(settlementFeeFlat)) {
    return badRequest(res, 'all fees must be numbers >= 0', ['chargebackFee', 'settlementFeePct', 'settlementFeeFlat']);
  }
  if (!(refundFee >= 0) || !(declineFee >= 0)) return badRequest(res, 'refundFee and declineFee must be >= 0', ['refundFee', 'declineFee']);
  if (!(reservePct >= 0 && reservePct <= 100)) return badRequest(res, 'reservePct must be 0..100', ['reservePct']);
  if (!(reserveReleaseDays >= 0)) return badRequest(res, 'reserveReleaseDays must be >= 0', ['reserveReleaseDays']);
  const row = await withPlatformAdmin(uid(req), async (c) => {
    const org = (await c.query('SELECT 1 FROM organizations WHERE id=$1', [req.params.orgId])).rows[0];
    if (!org) return { err: 'not_found' };
    return { fee: (await c.query(
      `INSERT INTO settlement_fee_config (organization_id, chargeback_fee, settlement_fee_pct, settlement_fee_flat, refund_fee, decline_fee, reserve_pct, reserve_release_days, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING chargeback_fee, settlement_fee_pct, settlement_fee_flat, refund_fee, decline_fee, reserve_pct, reserve_release_days, effective_from`,
      [req.params.orgId, chargebackFee, settlementFeePct, settlementFeeFlat, refundFee, declineFee, reservePct, reserveReleaseDays, uid(req)])).rows[0] };
  });
  if (row.err) return res.status(404).json({ error: row.err });
  await audit({ actorUserId: uid(req), action: 'platform.settlement_fee.update', entityType: 'organization', entityId: req.params.orgId, metadata: { chargebackFee, settlementFeePct, settlementFeeFlat, refundFee, declineFee, platformRole: req.platformRole } });
  res.status(201).json(row.fee);
}));

// GET /platform/organizations/:orgId/settlement-fee
router.get('/organizations/:orgId/settlement-fee', asyncHandler(async (req, res) => {
  const fee = await withPlatformAdmin(uid(req), async (c) => (await c.query(
    `SELECT chargeback_fee, settlement_fee_pct, settlement_fee_flat, refund_fee, decline_fee, reserve_pct, reserve_release_days
       FROM settlement_fee_config WHERE organization_id=$1 AND effective_from <= now()
       ORDER BY effective_from DESC LIMIT 1`, [req.params.orgId])).rows[0] || null);
  res.json(fee || { chargeback_fee: 0, settlement_fee_pct: 0, settlement_fee_flat: 0, refund_fee: 0, decline_fee: 0, reserve_pct: 0, reserve_release_days: 0 });
}));

// GET /platform/activity — recent actions across ALL agencies (the operator feed).
router.get('/activity', asyncHandler(async (req, res) => {
  const rows = await withPlatformAdmin(uid(req), async (c) => (await c.query(
    `SELECT a.action, a.entity_type, a.created_at,
            w.name AS workspace, u.email AS actor, u.full_name AS actor_name
     FROM audit_log a
     LEFT JOIN workspaces w ON w.id = a.workspace_id
     LEFT JOIN users u ON u.id = a.actor_user_id
     ORDER BY a.created_at DESC LIMIT 100`)).rows);
  res.json({ activity: rows });
}));

// GET /platform/workspaces — every workspace with live activity counters.
router.get('/workspaces', asyncHandler(async (req, res) => {
  const rows = await withPlatformAdmin(uid(req), async (c) => (await c.query(
    `SELECT w.id, w.name, w.currency, w.status, o.name AS organization, o.id AS organization_id,
            (SELECT count(*) FROM accounts a WHERE a.workspace_id = w.id)                                     AS accounts,
            (SELECT count(*) FROM memberships m WHERE m.workspace_id = w.id AND m.status='active')            AS members,
            (SELECT count(*) FROM transactions t WHERE t.workspace_id = w.id AND t.status='approved')         AS approved_txns,
            (SELECT COALESCE(SUM(gross),0) FROM transactions t WHERE t.workspace_id = w.id AND t.status='approved') AS gross_volume,
            (SELECT max(created_at) FROM audit_log a WHERE a.workspace_id = w.id)                              AS last_activity
     FROM workspaces w JOIN organizations o ON o.id = w.organization_id
     ORDER BY o.name`)).rows);
  res.json({ workspaces: rows });
}));

// GET /platform/analytics?from&to — cross-agency analytics for the operator.
router.get('/analytics', asyncHandler(async (req, res) => {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
  const F = from.toISOString(), T = to.toISOString();
  const data = await withPlatformAdmin(uid(req), async (c) => {
    const tot = (await c.query(`
      SELECT COALESCE(SUM(ce.gross) FILTER (WHERE ce.entry_type='sale'),0) AS gross,
             COALESCE(SUM(ce.platform_margin),0) AS hp_margin,
             COALESCE(SUM(ce.distributable),0) AS net,
             COUNT(*) FILTER (WHERE ce.entry_type='sale') AS sales,
             COUNT(*) FILTER (WHERE ce.entry_type='chargeback') AS cbs
      FROM commission_entries ce JOIN transactions t ON t.id=ce.transaction_id
      WHERE t.occurred_at >= $1 AND t.occurred_at <= $2`, [F, T])).rows[0];
    const per = (await c.query(`
      SELECT w.name AS agency, o.name AS organization,
             COALESCE(SUM(ce.gross) FILTER (WHERE ce.entry_type='sale'),0) AS volume,
             COALESCE(SUM(ce.platform_margin),0) AS hp_margin,
             COUNT(*) FILTER (WHERE ce.entry_type='sale') AS sales,
             COUNT(*) FILTER (WHERE ce.entry_type='chargeback') AS cbs,
             (SELECT blended_rate_pct FROM platform_fee_rates pf WHERE pf.organization_id=o.id ORDER BY effective_from DESC LIMIT 1) AS blended
      FROM commission_entries ce
      JOIN transactions t ON t.id=ce.transaction_id
      JOIN workspaces w ON w.id=ce.workspace_id
      JOIN organizations o ON o.id=w.organization_id
      WHERE t.occurred_at >= $1 AND t.occurred_at <= $2
      GROUP BY w.name, o.name, o.id ORDER BY volume DESC`, [F, T])).rows;
    const ts = (await c.query(`
      SELECT to_char(date_trunc('day',t.occurred_at),'YYYY-MM-DD') AS d, COALESCE(SUM(ce.gross),0) AS gross
      FROM commission_entries ce JOIN transactions t ON t.id=ce.transaction_id
      WHERE t.occurred_at >= $1 AND t.occurred_at <= $2 GROUP BY 1 ORDER BY 1`, [F, T])).rows;
    return { tot, per, ts };
  });
  const per = data.per.map((r) => ({ agency: r.agency, organization: r.organization, volume: Number(r.volume), hpMargin: Number(r.hp_margin), sales: Number(r.sales), blended: Number(r.blended || 0), cbRatePct: Number(r.sales) ? +(Number(r.cbs) / Number(r.sales) * 100).toFixed(2) : 0 }));
  const t = data.tot;
  res.json({
    range: { from: F, to: T },
    totalVolume: Number(t.gross), hpMargin: Number(t.hp_margin), netToAgencies: Number(t.net),
    activeAgencies: per.filter((a) => a.volume > 0).length,
    avgBlended: per.length ? +(per.reduce((s, a) => s + a.blended, 0) / per.length).toFixed(1) : 0,
    cbRatePct: Number(t.sales) ? +(Number(t.cbs) / Number(t.sales) * 100).toFixed(2) : 0,
    timeseries: data.ts.map((r) => ({ d: r.d, gross: Number(r.gross) })),
    agencies: per,
  });
}));


// GET /platform/fees?from&to — itemised fees for EVERY agency, side by side.
// This is the operator view: what each customer costs, and what we make on them.
router.get('/fees', asyncHandler(async (req, res) => {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
  const n = (v) => Number(v || 0);
  const r2 = (v) => Math.round(v * 100) / 100;

  const rows = await withPlatformAdmin(uid(req), async (c) => (await c.query(
    `SELECT o.id AS org_id, o.name AS agency,
            COUNT(*) FILTER (WHERE ce.entry_type='sale')                            AS sales,
            COALESCE(SUM(ce.gross) FILTER (WHERE ce.entry_type='sale'),0)           AS gross,
            COALESCE(SUM(ce.fee_mdr),0)         AS mdr,
            COALESCE(SUM(ce.fee_fixed),0)       AS fixed,
            COALESCE(SUM(ce.fee_settlement),0)  AS settlement,
            COALESCE(SUM(ce.fee_surcharge),0)   AS surcharge,
            COALESCE(SUM(ce.platform_margin),0) AS hp_margin,
            COALESCE(SUM(ce.chargeback_fee),0)  AS reversal_fees,
            COALESCE(SUM(ce.platform_fee),0)    AS total_deducted,
            p.fee_model, p.mdr_pct, p.settlement_pct, p.psp_fixed_fee, p.margin_rate_pct, p.psp_rate_pct
       FROM organizations o
       JOIN workspaces w ON w.organization_id = o.id
       LEFT JOIN commission_entries ce ON ce.workspace_id = w.id
       LEFT JOIN transactions t ON t.id = ce.transaction_id
        AND t.occurred_at >= $1 AND t.occurred_at <= $2
       LEFT JOIN LATERAL (
         SELECT * FROM platform_fee_rates pr
          WHERE pr.organization_id = o.id AND pr.effective_from <= now()
          ORDER BY pr.effective_from DESC LIMIT 1
       ) p ON true
      WHERE t.id IS NOT NULL OR ce.id IS NULL
      GROUP BY o.id, o.name, p.fee_model, p.mdr_pct, p.settlement_pct, p.psp_fixed_fee, p.margin_rate_pct, p.psp_rate_pct
      ORDER BY gross DESC`, [from.toISOString(), to.toISOString()])).rows);

  const agencies = rows.map((x) => {
    const gross = n(x.gross);
    const providerTotal = n(x.mdr) + n(x.fixed) + n(x.settlement);
    const ourRevenue = n(x.hp_margin) + n(x.surcharge);
    return {
      organizationId: x.org_id, agency: x.agency, sales: n(x.sales), gross: r2(gross),
      providerFees: { mdr: r2(x.mdr), fixed: r2(x.fixed), settlement: r2(x.settlement),
                      reversalFees: r2(x.reversal_fees), total: r2(providerTotal),
                      percentOfGross: gross ? r2(providerTotal / gross * 100) : 0 },
      higherPays: { margin: r2(x.hp_margin), surcharge: r2(x.surcharge), total: r2(ourRevenue),
                    percentOfGross: gross ? r2(ourRevenue / gross * 100) : 0 },
      totalDeducted: r2(x.total_deducted),
      rateCard: { feeModel: x.fee_model || 'flat',
                  mdrPct: x.mdr_pct == null ? n(x.psp_rate_pct) : n(x.mdr_pct),
                  settlementPct: n(x.settlement_pct), fixedFee: n(x.psp_fixed_fee),
                  marginPct: n(x.margin_rate_pct) },
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
