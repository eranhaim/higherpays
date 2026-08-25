'use strict';
const express = require('express');
const { withWorkspace } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { badRequest } = require('../util/validate');
const config = require('../config');
const provider = require('../providers/mantapay');
const paymentsService = require('../services/payments.service');

const router = express.Router({ mergeParams: true });
const wid = (req) => req.membership.workspaceId;
const uid = (req) => req.user.id;

const MIN_FIXED_AMOUNT = 3;             // provider minimum: 3 USD/EUR
const CHATTER_RATE_WINDOW_SECONDS = 30; // rate limit: one link per chatter per 30s

// -----------------------------------------------------------------------------
// Provider integration — MantaPay hosted checkout.
// Card data never touches our server; the fan pays on MantaPay's hosted page.
// The amount is baked into the signed URL, so pricingMode='open' isn't supported
// with MantaPay's hosted flow (see validation in POST /links below).
// -----------------------------------------------------------------------------
async function generateProviderLink({ ws, currency, amount, referenceId, description }) {
  // Per-workspace notify URL. If unset, MantaPay falls back to the URL configured
  // in the merchant profile at their portal.
  const notificationUrl = config.webhookPublicBase
    ? `${config.webhookPublicBase.replace(/\/$/, '')}/webhooks/payment/${ws.webhook_endpoint_id}`
    : undefined;

  // MantaPay honours ExpiredOn (epoch seconds). Use the workspace-wide link TTL.
  const expiresAt = new Date(Date.now() + config.linkTtlMinutes * 60_000);

  const { checkoutUrl } = await provider.createCheckout(ws, {
    amount,
    currency,
    reference: referenceId,
    description,
    notificationUrl,
    expiresAt,
  });
  return { providerLinkId: referenceId, url: checkoutUrl, expiresAt };
}

// GET /workspaces/:workspaceId/links
// Chatters see only the links they created; everyone else sees all in-workspace.
router.get('/', requirePermission('links.view'), asyncHandler(async (req, res) => {
  const chatterScoped = req.membership.role === 'chatter';
  const vals = [wid(req)];
  let scope = '';
  if (chatterScoped) { vals.push(req.membership.id); scope = `AND pl.created_by = $${vals.length}`; }
  const rows = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `SELECT pl.id, pl.pricing_mode, pl.amount, pl.currency, pl.provider_link_id,
            CASE WHEN pl.status = 'created' AND pl.created_at < now() - ($${vals.length + 1} || ' minutes')::interval
                 THEN 'expired' ELSE pl.status END AS status,
            pl.reference_id, pl.created_at, pl.paid_at, pl.checkout_url,
            cr.stage_name AS creator, cu.alias AS customer,
            u.full_name AS chatter
     FROM payment_links pl
     LEFT JOIN creators cr ON cr.id = pl.creator_id
     LEFT JOIN customers cu ON cu.id = pl.customer_id
     LEFT JOIN memberships m ON m.id = pl.created_by
     LEFT JOIN users u ON u.id = m.user_id
     WHERE pl.workspace_id = $1 ${scope}
     ORDER BY pl.created_at DESC LIMIT 200`, [...vals, config.linkTtlMinutes])).rows);
  res.json({ links: rows });
}));

// GET /workspaces/:workspaceId/links/:id
router.get('/:id', requirePermission('links.view'), asyncHandler(async (req, res) => {
  const row = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `SELECT id, creator_id, customer_id, created_by, pricing_mode, amount, currency,
            status, provider_link_id, reference_id, description, created_at, paid_at
     FROM payment_links WHERE workspace_id = $1 AND id = $2`, [wid(req), req.params.id])).rows[0]);
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (req.membership.role === 'chatter' && row.created_by !== req.membership.id) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json(row);
}));

// POST /workspaces/:workspaceId/links
// body: { creatorId, customerId?, pricingMode: 'fixed'|'open', amount?, currency, description? }
router.post('/', requirePermission('links.create'), asyncHandler(async (req, res) => {
  const { creatorId, customerId, pricingMode = 'fixed', amount, currency, description } = req.body || {};
  if (!creatorId) return badRequest(res, 'creatorId is required', ['creatorId']);
  // MantaPay's hosted checkout bakes the amount into a signed URL, so we don't
  // support 'open' pricing today. If we ever do, it'll be via our own pre-page
  // that captures the amount and hands it off to MantaPay.
  if (pricingMode !== 'fixed') {
    return badRequest(res, "pricingMode must be 'fixed' (open pricing not supported by MantaPay hosted checkout)", ['pricingMode']);
  }
  if (!/^[A-Za-z]{3}$/.test(currency || '')) return badRequest(res, 'currency must be a 3-letter code', ['currency']);

  const amt = Number(amount);
  if (!(amt > 0)) return badRequest(res, 'amount is required for a fixed link', ['amount']);
  if (amt < MIN_FIXED_AMOUNT) return badRequest(res, `minimum amount is ${MIN_FIXED_AMOUNT}`, ['amount']);
  // Workspace guardrails (set in Settings). Enforced here so the console can't be bypassed.
  const lim = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    'SELECT min_link_amount, max_link_amount FROM workspaces WHERE id=$1', [wid(req)])).rows[0]);
  if (lim && lim.min_link_amount != null && amt < Number(lim.min_link_amount)) {
    return badRequest(res, `amount is below the workspace minimum of ${Number(lim.min_link_amount)}`, ['amount']);
  }
  if (lim && lim.max_link_amount != null && amt > Number(lim.max_link_amount)) {
    return badRequest(res, `amount is above the workspace maximum of ${Number(lim.max_link_amount)}`, ['amount']);
  }

  const cur = currency.toUpperCase();
  if (!config.supportedCurrencies.includes(cur)) {
    return badRequest(res, `currency ${cur} is not enabled (supported: ${config.supportedCurrencies.join(', ')})`, ['currency']);
  }
  const referenceId = 'ord_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const result = await withWorkspace(wid(req), uid(req), async (c) => {
    // Rate limit: only for chatters, one link per CHATTER_RATE_WINDOW_SECONDS.
    if (req.membership.role === 'chatter') {
      const recent = (await c.query(
        `SELECT created_at FROM payment_links
         WHERE workspace_id = $1 AND created_by = $2
           AND created_at > now() - ($3 || ' seconds')::interval
         ORDER BY created_at DESC LIMIT 1`,
        [wid(req), req.membership.id, CHATTER_RATE_WINDOW_SECONDS])).rows[0];
      if (recent) {
        const elapsed = Math.floor((Date.now() - new Date(recent.created_at).getTime()) / 1000);
        return { rateLimited: Math.max(1, CHATTER_RATE_WINDOW_SECONDS - elapsed) };
      }
    }

    // creator must belong to this workspace
    const creator = (await c.query(
      `SELECT id FROM creators WHERE id = $1 AND workspace_id = $2`, [creatorId, wid(req)])).rows[0];
    if (!creator) return { err: 'creator_not_found' };
    if (customerId) {
      const cust = (await c.query(
        `SELECT id FROM customers WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`, [customerId, wid(req)])).rows[0];
      if (!cust) return { err: 'customer_not_found' };
    }

    // Workspace provider config (endpoint id + secret-store key name; never the key itself).
    const ws = (await c.query(
      `SELECT id, webhook_endpoint_id, provider_config_ref, mid FROM workspaces WHERE id = $1`, [wid(req)])).rows[0];

    // Ask MantaPay for the hosted checkout URL.
    const built = await generateProviderLink({ ws, currency: cur, amount: amt, referenceId, description });

    const link = (await c.query(
      `INSERT INTO payment_links
         (workspace_id, creator_id, customer_id, created_by, pricing_mode, amount, currency, status, provider_link_id, reference_id, description, expires_at, checkout_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'created',$8,$9,$10,$11,$12)
       RETURNING id, pricing_mode, amount, currency, status, provider_link_id, reference_id, created_at, expires_at, checkout_url`,
      [wid(req), creatorId, customerId || null, req.membership.id, 'fixed', amt, cur,
       built.providerLinkId, referenceId, description || null, built.expiresAt, built.url])).rows[0];
    return { link, url: built.url };
  });

  if (result.rateLimited) {
    res.setHeader('Retry-After', String(result.rateLimited));
    return res.status(429).json({ error: 'rate_limited', scope: 'chatter', retryAfterSeconds: result.rateLimited });
  }
  if (result.err) return res.status(404).json({ error: result.err });

  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'link.create', entityType: 'payment_link', entityId: result.link.id, metadata: { pricingMode: 'fixed', amount: amt, currency: cur } });
  res.status(201).json({ ...result.link, url: result.url });
}));

// POST /workspaces/:wid/links/reconcile — safety-net for links whose final
// webhook never arrived. Polls the provider status endpoint for links still
// 'created'/'opened' past their expiry (or `graceMinutes`), and applies the
// outcome idempotently (same keys the webhook uses, so it never double-posts
// and never overrides a link the webhook already resolved).
router.post('/reconcile', requirePermission('commissions.manage'), asyncHandler(async (req, res) => {
  const graceMin = Number(req.body && req.body.graceMinutes) || 10;
  const summary = { checked: 0, updated: [], skipped: [] };

  const ws = (await withWorkspace(wid(req), uid(req), (c) => c.query(
    'SELECT id, mid, provider_config_ref, webhook_endpoint_id FROM workspaces WHERE id=$1',
    [wid(req)]))).rows[0];

  await withWorkspace(wid(req), uid(req), async (c) => {
    const stuck = (await c.query(
      `SELECT id, reference_id, amount, currency, expires_at
       FROM payment_links
       WHERE status IN ('created','opened')
         AND (expires_at < now() OR (expires_at IS NULL AND created_at < now() - ($1 || ' minutes')::interval))`,
      [String(graceMin)])).rows;

    for (const link of stuck) {
      summary.checked++;

      // MantaPay's status endpoint is keyed by OUR reference (Order). No
      // reference => nothing to poll; expire the link if it's genuinely past
      // its deadline.
      if (!link.reference_id) {
        if (link.expires_at) {
          await c.query("UPDATE payment_links SET status='expired' WHERE id=$1 AND status IN ('created','opened')", [link.id]);
          summary.updated.push({ linkId: link.id, to: 'expired', via: 'no_reference' });
        } else summary.skipped.push({ linkId: link.id, reason: 'no_reference' });
        continue;
      }

      let statusResp;
      try { statusResp = await provider.getPaymentStatus(ws, link.reference_id); }
      catch (e) { summary.skipped.push({ linkId: link.id, reason: 'status_error', detail: e.detail || e.message }); continue; }

      if (statusResp.transaction_id) {
        await c.query('UPDATE payment_links SET provider_request_id=$2 WHERE id=$1',
          [link.id, statusResp.transaction_id]);
      }

      const st = statusResp.status;   // approved | declined | pending | abandoned | unknown

      if (st === 'pending') {
        summary.skipped.push({ linkId: link.id, reason: 'still_pending' });
        continue;
      }
      if (st === 'approved' || st === 'declined') {
        // Delegate to the same service the webhook uses — same idempotency,
        // same notification behaviour.
        const outcome = await paymentsService.recordPaymentOutcome(c, wid(req), {
          providerTransactionId: statusResp.transaction_id || ('ref-' + link.reference_id),
          status: st,
          gross: statusResp.gross_amount != null ? Number(statusResp.gross_amount) : Number(link.amount || 0),
          fee: null,
          net: null,
          currency: (statusResp.unit || link.currency || 'EUR').toString().toUpperCase(),
          linkReference: link.reference_id,
          rawPayload: statusResp,
        });
        summary.updated.push({
          linkId: link.id,
          to: st === 'approved' ? 'paid' : 'failed',
          transactionId: outcome.transactionId,
          newSale: outcome.newSale,
        });
        continue;
      }
      // st === 'abandoned' | 'unknown'
      if (st === 'abandoned') {
        await c.query("UPDATE payment_links SET status='failed' WHERE id=$1 AND status IN ('created','opened')",
          [link.id]);
        summary.updated.push({ linkId: link.id, to: 'failed', reason: 'abandoned' });
        continue;
      }
      summary.skipped.push({ linkId: link.id, reason: 'status_' + st });
    }
  });

  res.json(summary);
}));

module.exports = router;
