'use strict';
const express = require('express');
const { withWorkspace } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { isStr, badRequest } = require('../util/validate');
const { parseLimit, decodeCursor, page } = require('../lib/cursor');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');
const { hasPermission } = require('../auth/permissions');

// GET /workspaces/:workspaceId/platform-fee — the blended rate the agency sees.
router.get('/platform-fee', requirePermission('payments.view'), asyncHandler(async (req, res) => {
  const r = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `SELECT workspace_blended_rate($1) AS blended,
            f.psp_rate_pct, f.margin_rate_pct,
            effective_psp_fixed_fee(w.organization_id, now()) AS fixed_fee,
            effective_refund_fee(w.organization_id, now())    AS refund_fee,
            effective_decline_fee(w.organization_id, now())   AS decline_fee,
            (SELECT reserve_pct          FROM effective_reserve(w.organization_id, now())) AS reserve_pct,
            (SELECT reserve_release_days FROM effective_reserve(w.organization_id, now())) AS reserve_release_days,
            (SELECT chargeback_fee FROM effective_settlement_fees(w.organization_id, now())) AS chargeback_fee
       FROM workspaces w
       LEFT JOIN LATERAL effective_platform_fee(w.organization_id, now()) f ON true
      WHERE w.id = $1`, [wid(req)])).rows[0]);
  const n = (v) => (v == null ? 0 : Number(v));
  // The blended rate and the fixed fee are what the link fee preview needs, so
  // every role that can create or read a link gets them. The rest — reserve,
  // reversal fees — is the agency's treasury and belongs to the roles that run
  // the agency.
  const seesTreasury = hasPermission(req.membership, 'data.view_all');
  res.json({
    blendedRatePct: n(r && r.blended),
    pspFixedFee: n(r && r.fixed_fee),
    // The provider has no refund API today; the console records refunds instead.
    providerRefundAvailable: !!require('../config').mantapayRefundEnabled,
    ...(seesTreasury ? {
      refundFee: n(r && r.refund_fee),
      chargebackFee: n(r && r.chargeback_fee),
      declineFee: n(r && r.decline_fee),
      // The reserve is the agency's own money held by the provider.
      reservePct: n(r && r.reserve_pct),
      reserveReleaseDays: n(r && r.reserve_release_days),
    } : {}),
    // The PSP/HigherPays split is operator-only — it is our cost basis and margin.
    ...(req.membership.isPlatformOperator
      ? { pspRatePct: n(r && r.psp_rate_pct), marginRatePct: n(r && r.margin_rate_pct) }
      : {}),
  });
}));

// PATCH /workspaces/:workspaceId  { name }  — rename the workspace (owner/admin).
router.patch('/', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const name = req.body && req.body.name;
  if (!isStr(name, 120)) return badRequest(res, 'name is required', ['name']);
  const row = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    'UPDATE workspaces SET name=$2, updated_at=now() WHERE id=$1 RETURNING id, name', [wid(req), name])).rows[0]);
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'workspace.rename', metadata: { name } });
  res.json(row);
}));

// GET /workspaces/:workspaceId/link-limits
router.get('/link-limits', requirePermission('payments.view'), asyncHandler(async (req, res) => {
  const r = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    'SELECT min_link_amount, max_link_amount FROM workspaces WHERE id=$1', [wid(req)])).rows[0]);
  res.json({
    minLinkAmount: r && r.min_link_amount != null ? Number(r.min_link_amount) : null,
    maxLinkAmount: r && r.max_link_amount != null ? Number(r.max_link_amount) : null,
    providerMinimum: 3,
  });
}));

// PATCH /workspaces/:workspaceId/link-limits  { minLinkAmount, maxLinkAmount }  (null clears)
router.patch('/link-limits', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const norm = (v) => (v == null || v === '' ? null : Number(v));
  const min = norm(body.minLinkAmount), max = norm(body.maxLinkAmount);
  if (min != null && !(min >= 3)) return badRequest(res, 'minimum must be at least the provider floor of 3', ['minLinkAmount']);
  if (max != null && !(max > 0)) return badRequest(res, 'maximum must be positive', ['maxLinkAmount']);
  if (min != null && max != null && max < min) return badRequest(res, 'maximum must be >= minimum', ['maxLinkAmount']);
  const row = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    'UPDATE workspaces SET min_link_amount=$2, max_link_amount=$3, updated_at=now() WHERE id=$1 RETURNING min_link_amount, max_link_amount',
    [wid(req), min, max])).rows[0]);
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'workspace.link_limits', metadata: { min, max } });
  res.json({ minLinkAmount: row.min_link_amount == null ? null : Number(row.min_link_amount),
             maxLinkAmount: row.max_link_amount == null ? null : Number(row.max_link_amount) });
}));

// GET /workspaces/:workspaceId/audit?limit&cursor — who did what, newest first.
router.get('/audit', requirePermission('settings.view'), asyncHandler(async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  const rows = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata, a.ip, a.created_at,
            u.full_name AS actor_name, u.email AS actor_email
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.workspace_id = $1
        AND ($2::timestamptz IS NULL OR (a.created_at, a.id) < ($2::timestamptz, $3::bigint))
      ORDER BY a.created_at DESC, a.id DESC LIMIT $4`,
    [wid(req), cursor ? cursor.ts : null, cursor ? cursor.id : null, limit + 1])).rows);
  const result = page(rows, limit, (r) => r.created_at, (r) => r.id);
  res.json({
    items: result.items.map((r) => ({
      id: r.id, action: r.action, entityType: r.entity_type, entityId: r.entity_id,
      metadata: r.metadata, ip: r.ip, createdAt: r.created_at,
      actor: r.actor_email ? { name: r.actor_name, email: r.actor_email } : null,
    })),
    nextCursor: result.nextCursor,
  });
}));

module.exports = router;
