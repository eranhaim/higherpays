'use strict';
const crypto = require('crypto');
const express = require('express');
const { query, withTransaction } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { badRequest } = require('../util/validate');
const { parseLimit, decodeCursor, page } = require('../lib/cursor');
const { resolveDataScope, scopeParams } = require('../auth/dataScope');
const { status: vocab } = require('../schema/entities');
const config = require('../config');
const provider = require('../providers/mantapay');
const paymentsService = require('../services/payments.service');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');

const MIN_FIXED_AMOUNT = 3;             // provider minimum: 3 USD/EUR
const AGENT_RATE_WINDOW_SECONDS = 30;   // one link per agent per 30s

// A single-use link that went unpaid past its deadline reads as expired even
// though the column still says active; the reconciler writes it later.
const EFFECTIVE_STATUS = `CASE WHEN pl.status = 'active' AND pl.expires_at IS NOT NULL AND pl.expires_at < now()
                               THEN 'expired' ELSE pl.status END`;

const publicLink = (l) => ({
  id: l.id, type: l.type, pricingMode: l.pricing_mode,
  amount: l.amount == null ? null : Number(l.amount), currency: l.currency,
  status: l.status, referenceId: l.reference_id, description: l.description,
  checkoutUrl: l.checkout_url, expiresAt: l.expires_at, paidAt: l.paid_at, createdAt: l.created_at,
  accountId: l.account_id, account: l.account,
  agentId: l.created_by_agent_id, agent: l.agent,
});

// -----------------------------------------------------------------------------
// MantaPay hosted checkout. Card data never touches this server; the customer
// pays on MantaPay's page. The amount is baked into the signed URL.
// -----------------------------------------------------------------------------
async function generateProviderLink({ ws, currency, amount, referenceId, description, expiresAt }) {
  const notificationUrl = config.webhookPublicBase
    ? `${config.webhookPublicBase.replace(/\/$/, '')}/webhooks/payment/${ws.webhook_endpoint_id}`
    : undefined;
  const { checkoutUrl } = await provider.createCheckout(ws, {
    amount, currency, reference: referenceId, description, notificationUrl, expiresAt: expiresAt || undefined,
  });
  return checkoutUrl;
}

// GET /?limit&cursor&status&type&min&max&from&to&q&accountId
// Newest first. An agent sees the links they created; an owner the links
// against their account; everyone else the workspace. Filtering happens here,
// not in the browser: the list is cursor-paginated.
router.get('/', requirePermission('links.view'), asyncHandler(async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  const num = (v) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const min = num(req.query.min), max = num(req.query.max);
  if (min != null && max != null && max < min) return badRequest(res, 'max must be >= min', ['min', 'max']);
  const q = typeof req.query.q === 'string' && req.query.q.trim() ? `%${req.query.q.trim().toLowerCase()}%` : null;

  const rows = await withTransaction(async (c) => {
    const scope = await resolveDataScope(c, req);
    return (await c.query(
      `WITH effective AS (
         SELECT pl.*, ${EFFECTIVE_STATUS} AS effective_status FROM payment_links pl WHERE pl.workspace_id = $1
       )
       SELECT pl.*, pl.effective_status AS status,
              a.name AS account, u.full_name AS agent
         FROM effective pl
         JOIN accounts a ON a.id = pl.account_id
         LEFT JOIN agents ag ON ag.id = pl.created_by_agent_id
         LEFT JOIN users u ON u.id = ag.user_id
        WHERE ($2::uuid IS NULL OR pl.created_by_agent_id = $2::uuid)
          AND ($3::uuid IS NULL OR pl.account_id = $3::uuid)
          AND ($4::timestamptz IS NULL OR (pl.created_at, pl.id) < ($4::timestamptz, $5::uuid))
          AND ($7::text IS NULL OR pl.effective_status = $7::text)
          AND ($8::text IS NULL OR pl.type = $8::text)
          AND ($9::numeric IS NULL OR pl.amount >= $9::numeric)
          AND ($10::numeric IS NULL OR pl.amount <= $10::numeric)
          AND ($11::timestamptz IS NULL OR pl.created_at >= $11::timestamptz)
          AND ($12::timestamptz IS NULL OR pl.created_at <= $12::timestamptz)
          AND ($13::uuid IS NULL OR pl.account_id = $13::uuid)
          AND ($14::text IS NULL OR lower(pl.reference_id) LIKE $14::text
               OR lower(u.full_name) LIKE $14::text)
        ORDER BY pl.created_at DESC, pl.id DESC LIMIT $6`,
      [wid(req), ...scopeParams(scope),
        cursor ? cursor.ts : null, cursor ? cursor.id : null, limit + 1,
        req.query.status || null, req.query.type || null, min, max,
        req.query.from || null, req.query.to || null,
        req.query.accountId || null, q])).rows;
  });
  const result = page(rows, limit, (r) => r.created_at, (r) => r.id);
  res.json({ items: result.items.map(publicLink), nextCursor: result.nextCursor });
}));

// GET /:id
router.get('/:id', requirePermission('links.view'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => {
    const scope = await resolveDataScope(c, req);
    const row = (await c.query(
      `SELECT pl.*, ${EFFECTIVE_STATUS} AS status, a.name AS account, u.full_name AS agent
         FROM payment_links pl
         JOIN accounts a ON a.id = pl.account_id
         LEFT JOIN agents ag ON ag.id = pl.created_by_agent_id
         LEFT JOIN users u ON u.id = ag.user_id
        WHERE pl.workspace_id = $1 AND pl.id = $2
          AND ($3::uuid IS NULL OR pl.created_by_agent_id = $3::uuid)
          AND ($4::uuid IS NULL OR pl.account_id = $4::uuid)`,
      [wid(req), req.params.id, ...scopeParams(scope)])).rows[0];
    return row;
  });
  if (!out) return res.status(404).json({ error: 'not_found' });
  res.json(publicLink(out));
}));

// POST /  { accountId, type: 'single_use'|'reusable', amount, currency, description? }
// The customer is attached later, when the agent completes the payment's details.
router.post('/', requirePermission('links.create'), asyncHandler(async (req, res) => {
  const { accountId, type, amount, currency, description } = req.body || {};
  if (!accountId) return badRequest(res, 'accountId is required', ['accountId']);
  if (!vocab.LINK_TYPE.includes(type)) return badRequest(res, `type must be one of ${vocab.LINK_TYPE.join(', ')}`, ['type']);
  if (!/^[A-Za-z]{3}$/.test(currency || '')) return badRequest(res, 'currency must be a 3-letter code', ['currency']);
  const amt = Number(amount);
  if (!(amt > 0)) return badRequest(res, 'amount is required', ['amount']);
  if (amt < MIN_FIXED_AMOUNT) return badRequest(res, `minimum amount is ${MIN_FIXED_AMOUNT}`, ['amount']);
  const cur = currency.toUpperCase();
  if (!config.supportedCurrencies.includes(cur)) {
    return badRequest(res, `currency ${cur} is not enabled (supported: ${config.supportedCurrencies.join(', ')})`, ['currency']);
  }

  const ws = (await query('SELECT * FROM workspaces WHERE id = $1', [wid(req)])).rows[0];
  // Workspace guardrails, enforced here so the console cannot be bypassed.
  if (ws.min_link_amount != null && amt < Number(ws.min_link_amount)) {
    return badRequest(res, `amount is below the workspace minimum of ${Number(ws.min_link_amount)}`, ['amount']);
  }
  if (ws.max_link_amount != null && amt > Number(ws.max_link_amount)) {
    return badRequest(res, `amount is above the workspace maximum of ${Number(ws.max_link_amount)}`, ['amount']);
  }

  // The provider echoes this back as the attribution key; 64 random bits and a
  // UNIQUE index mean a collision cannot credit the wrong account.
  const referenceId = 'ord_' + crypto.randomBytes(8).toString('hex');
  const expiresAt = type === 'single_use' ? new Date(Date.now() + config.linkTtlMinutes * 60_000) : null;

  const result = await withTransaction(async (c) => {
    const scope = await resolveDataScope(c, req);

    if (scope.kind === 'agent') {
      const recent = (await c.query(
        `SELECT created_at FROM payment_links
          WHERE workspace_id = $1 AND created_by_agent_id = $2 AND created_at > now() - ($3 || ' seconds')::interval
          ORDER BY created_at DESC LIMIT 1`, [wid(req), scope.agentId, AGENT_RATE_WINDOW_SECONDS])).rows[0];
      if (recent) {
        const elapsed = Math.floor((Date.now() - new Date(recent.created_at).getTime()) / 1000);
        return { rateLimited: Math.max(1, AGENT_RATE_WINDOW_SECONDS - elapsed) };
      }
    }

    // The account must be active, in this workspace and, for an agent, one
    // they are assigned. An unassigned account reports the same not-found as a
    // nonexistent one, so this is not an existence oracle.
    const account = (await c.query(
      `SELECT id FROM accounts a
        WHERE a.id = $1 AND a.workspace_id = $2 AND a.status = 'active'
          AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM account_agents ag WHERE ag.account_id = a.id AND ag.agent_id = $3::uuid))`,
      [accountId, wid(req), scope.kind === 'agent' ? scope.agentId : null])).rows[0];
    if (!account) return { err: 'account_not_found' };

    const checkoutUrl = await generateProviderLink({ ws, currency: cur, amount: amt, referenceId, description, expiresAt });

    const link = (await c.query(
      `INSERT INTO payment_links
         (workspace_id, account_id, created_by_agent_id, type, pricing_mode, amount, currency,
          status, reference_id, provider_link_id, description, expires_at, checkout_url)
       VALUES ($1,$2,$3,$4,'fixed',$5,$6,'active',$7,$7,$8,$9,$10)
       RETURNING *`,
      [wid(req), accountId, scope.kind === 'agent' ? scope.agentId : null,
        type, amt, cur, referenceId, description || null, expiresAt, checkoutUrl])).rows[0];
    return { link };
  });

  if (result.rateLimited) {
    res.setHeader('Retry-After', String(result.rateLimited));
    return res.status(429).json({ error: 'rate_limited', scope: 'agent', retryAfterSeconds: result.rateLimited });
  }
  if (result.err) return res.status(404).json({ error: result.err });

  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'link.create', entityType: 'payment_link', entityId: result.link.id, metadata: { type, amount: amt, currency: cur } });
  res.status(201).json(publicLink(result.link));
}));

// POST /:id/cancel — close a link by hand. Only an unpaid one; a paid link is
// history, not something to withdraw.
router.post('/:id/cancel', requirePermission('links.create'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => {
    const scope = await resolveDataScope(c, req);
    const row = (await c.query(
      `UPDATE payment_links SET status = 'cancelled'
        WHERE workspace_id = $1 AND id = $2 AND status = 'active'
          AND ($3::uuid IS NULL OR created_by_agent_id = $3::uuid)
          AND ($4::uuid IS NULL OR account_id = $4::uuid)
        RETURNING *`, [wid(req), req.params.id, ...scopeParams(scope)])).rows[0];
    return row;
  });
  if (!out) return res.status(404).json({ error: 'not_found_or_not_active' });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'link.cancel', entityType: 'payment_link', entityId: out.id });
  res.json(publicLink(out));
}));

// POST /reconcile — safety net for single-use links whose final webhook never
// arrived. Polls the provider for every active one older than `graceMinutes`
// and applies the outcome through the same service the webhook uses, so it
// never double-posts. Reusable links are not polled: they carry many payments
// and only the webhook can tell them apart.
router.post('/reconcile', requirePermission('revenue.manage'), asyncHandler(async (req, res) => {
  const requested = Number(req.body && req.body.graceMinutes);
  const graceMin = Number.isFinite(requested) && requested >= 0 ? requested : 10;
  const summary = { checked: 0, updated: [], skipped: [] };

  const ws = (await query('SELECT * FROM workspaces WHERE id=$1', [wid(req)])).rows[0];

  await withTransaction(async (c) => {
    const stuck = (await c.query(
      `SELECT id, reference_id, amount, currency, expires_at < now() AS is_expired
         FROM payment_links
        WHERE workspace_id = $1 AND type = 'single_use' AND status = 'active'
          AND created_at < now() - ($2 || ' minutes')::interval`,
      [wid(req), String(graceMin)])).rows;

    for (const link of stuck) {
      summary.checked++;
      let statusResp;
      try { statusResp = await provider.getPaymentStatus(ws, link.reference_id); }
      catch (e) { summary.skipped.push({ linkId: link.id, reason: 'status_error', detail: e.detail || e.message }); continue; }

      if (statusResp.transaction_id) {
        await c.query('UPDATE payment_links SET provider_request_id=$2 WHERE id=$1', [link.id, statusResp.transaction_id]);
      }
      const st = statusResp.status;   // approved | declined | pending | abandoned | unknown

      if (st === 'approved') {
        const outcome = await paymentsService.recordPaymentOutcome(c, wid(req), {
          providerTransactionId: statusResp.transaction_id || ('ref-' + link.reference_id),
          status: 'approved',
          gross: statusResp.gross_amount != null ? Number(statusResp.gross_amount) : Number(link.amount || 0),
          fee: null,
          currency: (statusResp.unit || link.currency || 'EUR').toString().toUpperCase(),
          linkReference: link.reference_id,
          rawPayload: statusResp,
        });
        summary.updated.push({ linkId: link.id, to: 'pending', paymentId: outcome.paymentId, newSale: outcome.newSale });
        continue;
      }
      // Anything short of approval leaves the link open until its deadline.
      if (link.is_expired) {
        await c.query("UPDATE payment_links SET status='expired' WHERE id=$1 AND status='active'", [link.id]);
        summary.updated.push({ linkId: link.id, to: 'expired', via: st });
        continue;
      }
      summary.skipped.push({ linkId: link.id, reason: 'status_' + st });
    }
  });

  res.json(summary);
}));

module.exports = router;
