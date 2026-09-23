'use strict';

// The marketplace never receives a MantaPay secret.  It creates a HigherPays
// payment link for its cart and consumes signed lifecycle events from the
// durable outbox below.
const crypto = require('crypto');
const express = require('express');
const { query, withTransaction } = require('../db');
const { asyncHandler } = require('../lib/http');
const config = require('../config');
const { generateOrderReference } = require('../lib/orderReference');

const router = express.Router();

function authorized(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !config.marketplaceIntegrationApiKeyHash) return false;
  const supplied = Buffer.from(crypto.createHash('sha256').update(token).digest('hex'), 'hex');
  const expected = Buffer.from(config.marketplaceIntegrationApiKeyHash, 'hex');
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function configured() {
  return config.marketplaceIntegrationApiKeyHash
    && config.marketplaceWorkspaceId
    && config.marketplaceAccountId
    && config.marketplaceAgentId
    && config.marketplaceWebhookUrl
    && config.marketplaceWebhookSigningSecret;
}

function marketplaceCheckoutUrl(referenceId) {
  return `${config.appPublicBase}/api/pay/${encodeURIComponent(referenceId)}`;
}

function safeReturnUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

function money(value) {
  return (Number(value) / 100).toFixed(2);
}

function lifecycleStatus(row) {
  if (row.payment_status === 'refunded') return 'refunded';
  if (row.payment_status === 'paid') return 'approved';
  if (row.link_status === 'expired') return 'expired';
  if (row.link_status === 'cancelled') return 'cancelled';
  return 'pending';
}

async function lookupOrder(c, marketplaceOrderId, lock = false) {
  return (await c.query(
    `SELECT mo.marketplace_order_id, mo.workspace_id, mo.account_id, mo.agent_id,
            mo.amount_minor, mo.currency, mo.return_url, pl.id AS payment_link_id,
            pl.reference_id, pl.checkout_url, pl.status AS link_status,
            p.id AS payment_id, p.status AS payment_status, p.provider_payment_id,
            t.provider_transaction_id
       FROM marketplace_orders mo
       JOIN payment_links pl ON pl.id=mo.payment_link_id
       LEFT JOIN payments p ON p.payment_link_id=pl.id AND p.archived_at IS NULL
       LEFT JOIN transactions t ON t.payment_id=p.id AND t.type='payment'
      WHERE mo.marketplace_order_id=$1
      ORDER BY t.created_at DESC NULLS LAST
      LIMIT 1 ${lock ? 'FOR UPDATE OF mo' : ''}`,
    [marketplaceOrderId],
  )).rows[0];
}

function publicOrder(row) {
  return {
    marketplaceOrderId: row.marketplace_order_id,
    checkoutUrl: row.checkout_url,
    paymentLinkReference: row.reference_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: lifecycleStatus(row),
    providerTransactionId: row.provider_transaction_id || row.provider_payment_id || null,
  };
}

async function queueLifecycleEventForReference(referenceId, type, providerTransactionId) {
  if (!configured()) return;
  await withTransaction(async (c) => {
    const row = (await c.query(
      `SELECT mo.marketplace_order_id, mo.amount_minor, mo.currency, pl.reference_id, p.id AS payment_id
         FROM marketplace_orders mo
         JOIN payment_links pl ON pl.id=mo.payment_link_id
         LEFT JOIN payments p ON p.payment_link_id=pl.id
        WHERE pl.reference_id=$1
        LIMIT 1 FOR UPDATE`,
      [referenceId],
    )).rows[0];
    if (!row) return;
    const eventId = crypto.randomUUID();
    const payload = {
      eventId,
      type,
      occurredAt: new Date().toISOString(),
      marketplaceOrderId: row.marketplace_order_id,
      paymentLinkReference: row.reference_id,
      paymentId: row.payment_id || null,
      providerTransactionId: providerTransactionId || null,
      amountMinor: Number(row.amount_minor),
      currency: row.currency,
    };
    await c.query(
      `INSERT INTO marketplace_event_outbox
         (marketplace_order_id, event_type, payload)
       VALUES ($1,$2,$3)
       ON CONFLICT (marketplace_order_id, event_type, (payload->>'providerTransactionId')) DO NOTHING`,
      [row.marketplace_order_id, type, payload],
    );
  });
  void drainMarketplaceOutbox();
}

function eventSignature(timestamp, eventId, body) {
  return crypto.createHmac('sha256', config.marketplaceWebhookSigningSecret)
    .update(`${timestamp}.${eventId}.${body}`).digest('hex');
}

async function drainMarketplaceOutbox() {
  if (!configured()) return;
  const rows = (await query(
    `SELECT id, payload FROM marketplace_event_outbox
      WHERE delivered_at IS NULL AND next_attempt_at <= now()
      ORDER BY created_at LIMIT 20`,
  )).rows;
  for (const row of rows) {
    const body = JSON.stringify(row.payload);
    const timestamp = new Date().toISOString();
    try {
      const response = await fetch(config.marketplaceWebhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-higherpays-event-id': row.payload.eventId,
          'x-higherpays-timestamp': timestamp,
          'x-higherpays-signature': eventSignature(timestamp, row.payload.eventId, body),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`marketplace_http_${response.status}`);
      await query('UPDATE marketplace_event_outbox SET delivered_at=now(), attempts=attempts+1, last_error=NULL WHERE id=$1', [row.id]);
    } catch (error) {
      await query(
        `UPDATE marketplace_event_outbox
            SET attempts=attempts+1, last_error=$2,
                next_attempt_at=now() + (LEAST(3600, power(2, attempts + 1)::int) || ' seconds')::interval
          WHERE id=$1`,
        [row.id, String(error.message || 'delivery_failed').slice(0, 500)],
      );
    }
  }
}

router.post('/orders', asyncHandler(async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'invalid_integration_token' });
  if (!configured()) return res.status(503).json({ error: 'marketplace_integration_not_configured' });
  const { marketplaceOrderId, amountMinor, currency, returnUrl } = req.body || {};
  const validOrder = typeof marketplaceOrderId === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(marketplaceOrderId);
  const validCurrency = typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency);
  const safeUrl = safeReturnUrl(returnUrl);
  if (!validOrder || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !validCurrency || !safeUrl) {
    return res.status(400).json({ error: 'invalid_checkout_request' });
  }

  const result = await withTransaction(async (c) => {
    const existing = await lookupOrder(c, marketplaceOrderId, true);
    if (existing) {
      if (Number(existing.amount_minor) !== amountMinor || existing.currency !== currency.toUpperCase()) return { conflict: true };
      return { order: existing };
    }
    const setup = (await c.query(
      `SELECT w.currency, w.status, a.id AS account_id, ag.id AS agent_id
         FROM workspaces w
         JOIN accounts a ON a.id=$2 AND a.workspace_id=w.id AND a.status='active'
         JOIN agents ag ON ag.id=$3 AND ag.workspace_id=w.id
         JOIN account_agents aa ON aa.account_id=a.id AND aa.agent_id=ag.id
        WHERE w.id=$1 AND w.status='active'`,
      [config.marketplaceWorkspaceId, config.marketplaceAccountId, config.marketplaceAgentId],
    )).rows[0];
    if (!setup) return { setupMissing: true };
    if (setup.currency !== currency.toUpperCase()) return { currencyMismatch: true };
    const fee = (await c.query('SELECT checkout_fee FROM effective_platform_fee($1, now())', [config.marketplaceWorkspaceId])).rows[0];
    const referenceId = generateOrderReference();
    const expiresAt = new Date(Date.now() + config.linkTtlMinutes * 60_000);
    const checkoutUrl = marketplaceCheckoutUrl(referenceId);
    const link = (await c.query(
      `INSERT INTO payment_links
         (workspace_id, account_id, created_by_agent_id, type, pricing_mode, amount, checkout_fee, currency,
          status, reference_id, provider_link_id, description, expires_at, checkout_url)
       VALUES ($1,$2,$3,'single_use','fixed',$4,$5,$6,'active',$7,$7,$8,$9,$10)
       RETURNING id`,
      [config.marketplaceWorkspaceId, setup.account_id, setup.agent_id, money(amountMinor),
        Number(fee?.checkout_fee || 0), currency.toUpperCase(), referenceId,
        `Marketplace order ${marketplaceOrderId}`, expiresAt, checkoutUrl],
    )).rows[0];
    await c.query(
      `INSERT INTO marketplace_orders
         (marketplace_order_id, workspace_id, account_id, agent_id, payment_link_id, amount_minor, currency, return_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [marketplaceOrderId, config.marketplaceWorkspaceId, setup.account_id, setup.agent_id,
        link.id, amountMinor, currency.toUpperCase(), safeUrl],
    );
    return { order: await lookupOrder(c, marketplaceOrderId) };
  });
  if (result.conflict) return res.status(409).json({ error: 'marketplace_order_mismatch' });
  if (result.setupMissing) return res.status(503).json({ error: 'marketplace_synthetic_attribution_not_ready' });
  if (result.currencyMismatch) return res.status(409).json({ error: 'currency_mismatch' });
  res.status(201).json(publicOrder(result.order));
}));

router.get('/orders/:marketplaceOrderId', asyncHandler(async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'invalid_integration_token' });
  const order = await withTransaction((c) => lookupOrder(c, req.params.marketplaceOrderId));
  if (!order) return res.status(404).json({ error: 'marketplace_order_not_found' });
  res.json(publicOrder(order));
}));

function startMarketplaceOutboxLoop() {
  const timer = setInterval(() => void drainMarketplaceOutbox(), 30_000);
  timer.unref();
  void drainMarketplaceOutbox();
  return timer;
}

module.exports = { router, queueLifecycleEventForReference, drainMarketplaceOutbox, startMarketplaceOutboxLoop, eventSignature };
