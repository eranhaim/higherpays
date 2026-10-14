'use strict';
const express = require('express');
const { pool, query } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { isStr, badRequest } = require('../util/validate');
const { parseLimit, decodeCursor, page } = require('../lib/cursor');
const { hasPermission } = require('../auth/permissions');
const currencies = require('../services/currencies.service');
const config = require('../config');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');
const n = (v) => (v == null ? 0 : Number(v));

const LABELS = { accountLabel: 'account_label', accountLabelPlural: 'account_label_plural', agentLabel: 'agent_label', agentLabelPlural: 'agent_label_plural' };

const publicWorkspace = (w) => ({
  // `currency` is the agency's BASE currency: what a report defaults to and
  // what a salary is denominated in. The full set it may transact in comes
  // from GET /currencies.
  id: w.id, name: w.name, currency: w.currency, status: w.status,
  labels: { account: w.account_label, accounts: w.account_label_plural, agent: w.agent_label, agents: w.agent_label_plural },
  minLinkAmount: w.min_link_amount == null ? null : Number(w.min_link_amount),
  maxLinkAmount: w.max_link_amount == null ? null : Number(w.max_link_amount),
  // The agency's own MantaPay identity: the MID it sends on every link, and
  // the endpoint MantaPay must be told to notify.
  merchantId: w.merchant_id,
  webhookEndpointId: w.webhook_endpoint_id,
});

// GET /workspaces/:id — the agency and its settings.
router.get('/', requirePermission('settings.view'), asyncHandler(async (req, res) => {
  const w = (await query('SELECT * FROM workspaces WHERE id = $1', [wid(req)])).rows[0];
  res.json(publicWorkspace(w));
}));

// PATCH /workspaces/:id  { name?, accountLabel?, …, merchantId? }
router.patch('/', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const sets = [], vals = [];
  if ('name' in body) {
    if (!isStr(body.name, 120)) return badRequest(res, 'name is required', ['name']);
    vals.push(body.name.trim()); sets.push(`name = $${vals.length}`);
  }
  // Empty clears it, which falls the server back to MANTAPAY_MERCHANT_ID.
  if ('merchantId' in body) {
    const operator = (await query('SELECT is_platform_admin FROM users WHERE id=$1', [uid(req)])).rows[0];
    if (!operator?.is_platform_admin) return res.status(403).json({ error: 'platform_admin_required' });
    const mid = body.merchantId == null ? '' : String(body.merchantId).trim();
    if (mid.length > 64) return badRequest(res, 'merchantId is at most 64 characters', ['merchantId']);
    vals.push(mid || null); sets.push(`merchant_id = $${vals.length}`);
  }
  for (const [key, col] of Object.entries(LABELS)) {
    if (!(key in body)) continue;
    if (!isStr(body[key], 40)) return badRequest(res, `${key} must be 1-40 characters`, [key]);
    vals.push(body[key].trim()); sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return badRequest(res, 'no updatable fields provided');
  vals.push(wid(req));
  const w = (await query(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals)).rows[0];
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'workspace.update', metadata: body });
  res.json(publicWorkspace(w));
}));

// GET /workspaces/:id/currencies — every currency this agency may transact
// in, base first, with the amounts already resolved.
//
// `checkoutSupported` is false for a currency MantaPay has no id for: its
// history and reports work, but no link may be priced in it. The UI must not
// offer an unsupported currency on the link form.
router.get('/currencies', requirePermission('payments.view'), asyncHandler(async (req, res) => {
  const list = await currencies.listCurrencies(pool, wid(req));
  res.json({ currencies: list });
}));

// GET /workspaces/:id/platform-fee?currency= — the rate the agency is charged.
//
// The percentage rates are the agency's rate card and apply to every currency.
// The checkout fee is a flat amount and so is per currency; it is resolved for
// the requested one.
router.get('/platform-fee', requirePermission('payments.view'), asyncHandler(async (req, res) => {
  const currency = await currencies.resolveReportingCurrency(pool, wid(req), req.query.currency);
  const enabled = await currencies.getCurrency(pool, wid(req), currency);
  const r = (await query(
    `SELECT workspace_blended_rate($1) AS blended,
            f.psp_rate_pct, f.settlement_pct, f.margin_rate_pct,
            f.psp_fixed_fee, f.checkout_fee,
            s.refund_fee, s.decline_fee, s.chargeback_fee, s.reserve_pct, s.reserve_release_days
       FROM (SELECT 1) AS one
       LEFT JOIN LATERAL effective_platform_fee($1, now()) f ON true
       LEFT JOIN LATERAL effective_settlement_fees($1, now()) s ON true`, [wid(req)])).rows[0] || {};
  // The blended rate and the fixed fee are what the link fee preview needs, so
  // every role that can read a link gets them. The rest is the agency's
  // treasury and belongs to the roles that run the agency.
  const seesTreasury = hasPermission(req.access, 'data.view_all');
  res.json({
    currency,
    blendedRatePct: n(r.blended),
    pspRatePct: n(r.psp_rate_pct),
    settlementPct: n(r.settlement_pct),
    marginRatePct: n(r.margin_rate_pct),
    // Still one flat amount for every currency. MantaPay's own fixed fee is
    // not documented per currency and we have not confirmed it, so it is left
    // as the rate card states it rather than guessed at per currency.
    pspFixedFee: n(r.psp_fixed_fee),
    checkoutFee: enabled ? enabled.checkoutFee : n(r.checkout_fee),
    providerRefundAvailable: !!config.mantapayRefundEnabled,
    ...(seesTreasury ? {
      refundFee: n(r.refund_fee),
      chargebackFee: n(r.chargeback_fee),
      declineFee: n(r.decline_fee),
      reservePct: n(r.reserve_pct),
      reserveReleaseDays: n(r.reserve_release_days),
    } : {}),
  });
}));

// GET /workspaces/:id/link-limits?currency=
//
// The amounts are per currency — a floor that is sane in euros is not a floor
// in shekels — and come from the enabled currency, which inherits the
// workspace-wide amounts when it sets none of its own. The TTL and the
// reusable-link switch are currency-free.
router.get('/link-limits', requirePermission('payments.view'), asyncHandler(async (req, res) => {
  const currency = await currencies.resolveReportingCurrency(pool, wid(req), req.query.currency);
  const enabled = await currencies.getCurrency(pool, wid(req), currency);
  const w = (await query(
    'SELECT min_link_amount, max_link_amount, link_ttl_minutes, reusable_links_enabled FROM workspaces WHERE id=$1', [wid(req)])).rows[0];
  res.json({
    currency,
    minLinkAmount: enabled ? enabled.minLinkAmount : (w.min_link_amount == null ? null : Number(w.min_link_amount)),
    maxLinkAmount: enabled ? enabled.maxLinkAmount : (w.max_link_amount == null ? null : Number(w.max_link_amount)),
    linkTtlMinutes: w.link_ttl_minutes == null ? config.linkTtlMinutes : Number(w.link_ttl_minutes),
    reusableLinksEnabled: w.reusable_links_enabled,
    // MantaPay's floor. We have only ever seen it stated as a bare 3, with no
    // per-currency table, so it is reported as 3 in whichever currency is
    // asked for. Not verified per currency — see the handover notes.
    providerMinimum: 3,
  });
}));

// PATCH /workspaces/:id/link-limits  { minLinkAmount, maxLinkAmount, linkTtlMinutes, reusableLinksEnabled }
//
// These are the workspace-wide amounts, which every enabled currency inherits
// unless a platform operator gave that currency its own. (null clears an
// amount; a null TTL falls back to the platform default.)
router.patch('/link-limits', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const norm = (v) => (v == null || v === '' ? null : Number(v));
  const min = norm(body.minLinkAmount), max = norm(body.maxLinkAmount);
  if (min != null && !(min >= 3)) return badRequest(res, 'minimum must be at least the provider floor of 3', ['minLinkAmount']);
  if (max != null && !(max > 0)) return badRequest(res, 'maximum must be positive', ['maxLinkAmount']);
  if (min != null && max != null && max < min) return badRequest(res, 'maximum must be >= minimum', ['maxLinkAmount']);
  const ttl = 'linkTtlMinutes' in body ? norm(body.linkTtlMinutes) : undefined;
  if (ttl != null && !(Number.isInteger(ttl) && ttl > 0)) {
    return badRequest(res, 'linkTtlMinutes must be a whole number of minutes above zero', ['linkTtlMinutes']);
  }
  const reusableLinksEnabled = 'reusableLinksEnabled' in body ? body.reusableLinksEnabled : undefined;
  if (reusableLinksEnabled !== undefined && typeof reusableLinksEnabled !== 'boolean') {
    return badRequest(res, 'reusableLinksEnabled must be boolean', ['reusableLinksEnabled']);
  }
  const w = (await query(
    `UPDATE workspaces SET min_link_amount=$2, max_link_amount=$3,
            link_ttl_minutes = CASE WHEN $5::boolean THEN $4::int ELSE link_ttl_minutes END,
            reusable_links_enabled = CASE WHEN $7::boolean THEN $6::boolean ELSE reusable_links_enabled END
      WHERE id=$1 RETURNING min_link_amount, max_link_amount, link_ttl_minutes, reusable_links_enabled`,
    [wid(req), min, max, ttl ?? null, ttl !== undefined, reusableLinksEnabled ?? null, reusableLinksEnabled !== undefined])).rows[0];
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'workspace.link_limits',
    metadata: { min, max, ttl, reusableLinksEnabled },
  });
  res.json({
    minLinkAmount: w.min_link_amount == null ? null : Number(w.min_link_amount),
    maxLinkAmount: w.max_link_amount == null ? null : Number(w.max_link_amount),
    linkTtlMinutes: w.link_ttl_minutes == null ? config.linkTtlMinutes : Number(w.link_ttl_minutes),
    reusableLinksEnabled: w.reusable_links_enabled,
  });
}));

// GET /workspaces/:id/audit?limit&cursor — who did what, newest first.
router.get('/audit', requirePermission('settings.view'), asyncHandler(async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  const rows = (await query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata, a.ip, a.created_at,
            actor.full_name AS actor_name, actor.email AS actor_email,
            effective.full_name AS effective_name, effective.email AS effective_email
       FROM audit_log a
       LEFT JOIN users actor ON actor.id = a.actor_user_id
       LEFT JOIN users effective ON effective.id = a.effective_user_id
      WHERE a.workspace_id = $1
        AND ($2::timestamptz IS NULL OR (a.created_at, a.id) < ($2::timestamptz, $3::bigint))
      ORDER BY a.created_at DESC, a.id DESC LIMIT $4`,
    [wid(req), cursor ? cursor.value : null, cursor ? cursor.id : null, limit + 1])).rows;
  const result = page(rows, limit, (r) => r.created_at, (r) => r.id);
  res.json({
    items: result.items.map((r) => ({
      id: r.id, action: r.action, entityType: r.entity_type, entityId: r.entity_id,
      metadata: r.metadata, ip: r.ip, createdAt: r.created_at,
      actor: r.actor_email ? { name: r.actor_name, email: r.actor_email } : null,
      effectiveUser: r.effective_email ? { name: r.effective_name, email: r.effective_email } : null,
    })),
    nextCursor: result.nextCursor,
  });
}));

module.exports = router;
