'use strict';

// The marketplace never receives a MantaPay secret.  It creates a HigherPays
// payment link for its cart and consumes signed lifecycle events from the
// durable outbox below.
//
// Vault Sales extension: when `lines[]` are provided, the order carries
// immutable per-creator allocations.  fn_post_sale writes one revenue entry
// per line so each creator appears in earnings and payouts.
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

async function lookupOrderLines(c, marketplaceOrderId) {
  return (await c.query(
    `SELECT mol.id, mol.line_id, mol.account_id, mol.amount_minor, mol.label,
            a.name AS account_name
       FROM marketplace_order_lines mol
       JOIN accounts a ON a.id = mol.account_id
      WHERE mol.marketplace_order_id = $1
      ORDER BY mol.id`,
    [marketplaceOrderId],
  )).rows;
}

function publicOrder(row, lines) {
  const out = {
    marketplaceOrderId: row.marketplace_order_id,
    checkoutUrl: row.checkout_url,
    paymentLinkReference: row.reference_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: lifecycleStatus(row),
    providerTransactionId: row.provider_transaction_id || row.provider_payment_id || null,
  };
  if (lines && lines.length) {
    out.lines = lines.map((l) => ({
      lineId: l.line_id,
      accountId: l.account_id,
      accountName: l.account_name,
      amountMinor: Number(l.amount_minor),
      label: l.label || null,
    }));
  }
  return out;
}

async function enqueueLifecycleEventForReference(c, referenceId, type, providerTransactionId) {
  if (!configured()) return;
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
}

async function queueLifecycleEventForReference(referenceId, type, providerTransactionId) {
  await withTransaction((c) => enqueueLifecycleEventForReference(c, referenceId, type, providerTransactionId));
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

// ── Validate lines payload ─────────────────────────────────────────────────

function validateLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return 'lines must be a non-empty array';
  const lineIds = new Set();
  for (const line of lines) {
    if (typeof line.lineId !== 'string' || line.lineId.length < 1 || line.lineId.length > 160) return 'each line must have a lineId';
    if (typeof line.accountId !== 'string' || !/^[0-9a-f-]{36}$/.test(line.accountId)) return 'each line must have a valid accountId (uuid)';
    if (!Number.isSafeInteger(line.amountMinor) || line.amountMinor <= 0) return 'each line must have amountMinor > 0';
    if (lineIds.has(line.lineId)) return 'duplicate lineId';
    lineIds.add(line.lineId);
  }
  return null;
}

// ── POST /orders ───────────────────────────────────────────────────────────

router.post('/orders', asyncHandler(async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'invalid_integration_token' });
  if (!configured()) return res.status(503).json({ error: 'marketplace_integration_not_configured' });
  const { marketplaceOrderId, amountMinor, currency, returnUrl, lines } = req.body || {};
  const validOrder = typeof marketplaceOrderId === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(marketplaceOrderId);
  const validCurrency = typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency);
  const safeUrl = safeReturnUrl(returnUrl);
  if (!validOrder || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !validCurrency || !safeUrl) {
    return res.status(400).json({ error: 'invalid_checkout_request' });
  }

  const hasLines = Array.isArray(lines) && lines.length > 0;
  if (hasLines) {
    const lineErr = validateLines(lines);
    if (lineErr) return res.status(400).json({ error: 'invalid_checkout_request', detail: lineErr });
    const lineSum = lines.reduce((sum, l) => sum + l.amountMinor, 0);
    if (lineSum !== amountMinor) {
      return res.status(400).json({ error: 'invalid_checkout_request', detail: 'lines amountMinor must sum to order amountMinor' });
    }
  }

  // When lines are absent, the synthetic agent is required (legacy path).
  if (!hasLines && !config.marketplaceAgentId) {
    return res.status(503).json({ error: 'marketplace_integration_not_configured' });
  }

  const result = await withTransaction(async (c) => {
    const existing = await lookupOrder(c, marketplaceOrderId, true);
    if (existing) {
      if (Number(existing.amount_minor) !== amountMinor || existing.currency !== currency.toUpperCase()) return { conflict: true };
      return { order: existing, lines: await lookupOrderLines(c, marketplaceOrderId) };
    }

    // Validate workspace + synthetic account.
    const setupQuery = hasLines
      ? `SELECT w.currency, w.status, w.is_marketplace, a.id AS account_id
           FROM workspaces w
           JOIN accounts a ON a.id=$2 AND a.workspace_id=w.id AND a.status='active'
          WHERE w.id=$1 AND w.status='active'`
      : `SELECT w.currency, w.status, w.is_marketplace, a.id AS account_id, ag.id AS agent_id
           FROM workspaces w
           JOIN accounts a ON a.id=$2 AND a.workspace_id=w.id AND a.status='active'
           JOIN agents ag ON ag.id=$3 AND ag.workspace_id=w.id
           JOIN account_agents aa ON aa.account_id=a.id AND aa.agent_id=ag.id
          WHERE w.id=$1 AND w.status='active'`;
    const setupParams = hasLines
      ? [config.marketplaceWorkspaceId, config.marketplaceAccountId]
      : [config.marketplaceWorkspaceId, config.marketplaceAccountId, config.marketplaceAgentId];
    const setup = (await c.query(setupQuery, setupParams)).rows[0];
    if (!setup) return { setupMissing: true };
    if (!setup.is_marketplace) return { workspaceNotDesignated: true };
    if (setup.currency !== currency.toUpperCase()) return { currencyMismatch: true };

    // When lines are present, validate every creator account.
    if (hasLines) {
      const accountIds = [...new Set(lines.map((l) => l.accountId))];
      const found = (await c.query(
        `SELECT id FROM accounts WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND status = 'active'`,
        [accountIds, config.marketplaceWorkspaceId],
      )).rows;
      if (found.length !== accountIds.length) {
        const foundIds = new Set(found.map((r) => r.id));
        const missing = accountIds.filter((id) => !foundIds.has(id));
        return { badAccounts: missing };
      }
    }

    const fee = (await c.query('SELECT checkout_fee FROM effective_platform_fee($1, now())', [config.marketplaceWorkspaceId])).rows[0];
    const referenceId = generateOrderReference();
    const expiresAt = new Date(Date.now() + config.linkTtlMinutes * 60_000);
    const checkoutUrl = marketplaceCheckoutUrl(referenceId);
    const agentId = hasLines ? null : setup.agent_id;
    const link = (await c.query(
      `INSERT INTO payment_links
         (workspace_id, account_id, created_by_agent_id, type, pricing_mode, amount, checkout_fee, currency,
          status, reference_id, provider_link_id, description, expires_at, checkout_url)
       VALUES ($1,$2,$3,'single_use','fixed',$4,$5,$6,'active',$7,$7,$8,$9,$10)
       RETURNING id`,
      [config.marketplaceWorkspaceId, setup.account_id, agentId, money(amountMinor),
        Number(fee?.checkout_fee || 0), currency.toUpperCase(), referenceId,
        `Marketplace order ${marketplaceOrderId}`, expiresAt, checkoutUrl],
    )).rows[0];
    await c.query(
      `INSERT INTO marketplace_orders
         (marketplace_order_id, workspace_id, account_id, agent_id, payment_link_id, amount_minor, currency, return_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [marketplaceOrderId, config.marketplaceWorkspaceId, setup.account_id, agentId,
        link.id, amountMinor, currency.toUpperCase(), safeUrl],
    );

    // Persist line allocations.
    let orderLines = [];
    if (hasLines) {
      for (const line of lines) {
        await c.query(
          `INSERT INTO marketplace_order_lines
             (marketplace_order_id, line_id, account_id, amount_minor, label)
           VALUES ($1, $2, $3, $4, $5)`,
          [marketplaceOrderId, line.lineId, line.accountId, line.amountMinor, line.label || null],
        );
      }
      orderLines = await lookupOrderLines(c, marketplaceOrderId);
    }
    return { order: await lookupOrder(c, marketplaceOrderId), lines: orderLines };
  });
  if (result.conflict) return res.status(409).json({ error: 'marketplace_order_mismatch' });
  if (result.setupMissing) return res.status(503).json({ error: 'marketplace_synthetic_attribution_not_ready' });
  if (result.currencyMismatch) return res.status(409).json({ error: 'currency_mismatch' });
  if (result.badAccounts) return res.status(400).json({ error: 'invalid_creator_accounts', accounts: result.badAccounts });
  res.status(201).json(publicOrder(result.order, result.lines));
}));

// ── GET /orders/:marketplaceOrderId ────────────────────────────────────────

router.get('/orders/:marketplaceOrderId', asyncHandler(async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'invalid_integration_token' });
  const order = await withTransaction(async (c) => {
    const row = await lookupOrder(c, req.params.marketplaceOrderId);
    if (!row) return null;
    const lines = await lookupOrderLines(c, req.params.marketplaceOrderId);
    return { row, lines };
  });
  if (!order) return res.status(404).json({ error: 'marketplace_order_not_found' });
  res.json(publicOrder(order.row, order.lines));
}));

// ── GET /directory ─────────────────────────────────────────────────────────
// Returns the active creator accounts in the marketplace workspace, excluding
// the synthetic checkout account.  The Telegram admin uses this to map catalog
// creators to real HigherPays accounts.

router.get('/directory', asyncHandler(async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'invalid_integration_token' });
  if (!config.marketplaceWorkspaceId) {
    return res.status(503).json({ error: 'marketplace_integration_not_configured' });
  }
  const workspace = (await query(
    `SELECT id, name, currency, account_label, account_label_plural,
            agent_label, agent_label_plural
       FROM workspaces WHERE id = $1 AND status = 'active'`,
    [config.marketplaceWorkspaceId],
  )).rows[0];
  if (!workspace) return res.status(503).json({ error: 'marketplace_workspace_not_found' });

  const accounts = (await query(
    `SELECT a.id, u.full_name AS name, a.handle, a.revenue_split_pct
       FROM accounts a
       JOIN users u ON u.id = a.user_id
      WHERE a.workspace_id = $1 AND a.status = 'active'
        AND ($2::uuid IS NULL OR a.id <> $2::uuid)
      ORDER BY u.full_name`,
    [config.marketplaceWorkspaceId, config.marketplaceAccountId],
  )).rows;

  const agents = (await query(
    `SELECT ag.id, u.full_name AS name
       FROM agents ag
       JOIN users u ON u.id = ag.user_id
      WHERE ag.workspace_id = $1
        AND ($2::uuid IS NULL OR ag.id <> $2::uuid)
      ORDER BY u.full_name`,
    [config.marketplaceWorkspaceId, config.marketplaceAgentId || null],
  )).rows;

  res.json({
    workspaces: [{
      id: workspace.id,
      name: workspace.name,
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, handle: a.handle })),
      agents: agents.map((a) => ({ id: a.id, name: a.name })),
    }],
  });
}));

function startMarketplaceOutboxLoop() {
  const timer = setInterval(() => void drainMarketplaceOutbox(), 30_000);
  timer.unref();
  void drainMarketplaceOutbox();
  return timer;
}

module.exports = { router, queueLifecycleEventForReference, enqueueLifecycleEventForReference, drainMarketplaceOutbox, startMarketplaceOutboxLoop, eventSignature };
