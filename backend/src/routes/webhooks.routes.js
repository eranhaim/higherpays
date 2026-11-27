'use strict';
const crypto = require('crypto');
const express = require('express');
const { query } = require('../db');
const { asyncHandler } = require('../lib/http');
const provider = require('../providers/mantapay');
const { applyWebhookEvent } = require('../services/webhookEvents');
const { publishWorkspaceUpdate } = require('../events/workspaceEvents');
const { drainMarketplaceOutbox } = require('./marketplace.routes');

const router = express.Router();
const PROVIDER = 'mantapay';

// POST /webhooks/payment/:endpoint
//
// MantaPay POSTs application/x-www-form-urlencoded with the final result.
// Layered authentication, in order:
//   1. The opaque per-workspace endpoint id in the URL resolves the workspace.
//   2. verifyWebhookSignature over the raw body, keyed with the workspace's
//      per-merchant hash key.
//   3. merchantID in the payload matches the workspace's stored MID (when set).
router.post('/payment/:endpoint', asyncHandler(async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));

  const ws = (await query(
    'SELECT id, merchant_id, provider_config_ref FROM workspaces WHERE webhook_endpoint_id = $1', [req.params.endpoint])).rows[0];
  if (!ws) return res.status(404).json({ error: 'unknown_endpoint' });

  const apiKey = provider.resolveApiKey(ws);
  const signatureValid = provider.verifyWebhookSignature(raw, apiKey, req.headers[provider.SIGNATURE_HEADER]);

  let ev;
  try { ev = provider.parseWebhook(raw); }
  catch { return res.status(400).json({ error: 'bad_payload' }); }
  if (!ev.providerEventId) return res.status(400).json({ error: 'missing_provider_event_id' });

  const merchantOk = ev.kind === 'chargeback'
    || !ws.merchant_id
    || (ev.merchantId && ev.merchantId === ws.merchant_id);

  // Rejected deliveries are audit records, not canonical inbox rows. Their
  // noncanonical ids cannot suppress a later authentic retry of the event.
  if (!signatureValid || !merchantOk) {
    const rejection = !signatureValid ? 'bad_signature' : 'merchant_mismatch';
    await query(
      `INSERT INTO webhook_events
         (workspace_id, provider, event_type, provider_event_id, signature_valid,
          processed, processing_error, payload, processed_at)
       VALUES ($1,$2,$3,$4,$5,true,$6,$7,now())`,
      [
        ws.id,
        PROVIDER,
        ev.status,
        `${ev.providerEventId}:rejected:${crypto.randomUUID()}`,
        signatureValid,
        rejection,
        ev.fields,
      ]);
    return res.status(signatureValid ? 400 : 401).json({ error: rejection });
  }

  // Idempotency: only authenticated events occupy the provider's canonical key.
  // A duplicate provider_event_id is acknowledged only once the earlier
  // delivery was fully processed; if processing failed, the provider's retry
  // is our second chance. The no-op DO UPDATE makes RETURNING yield the row.
  const event = (await query(
    `INSERT INTO webhook_events (workspace_id, provider, event_type, provider_event_id, signature_valid, payload, order_reference)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (workspace_id, provider, provider_event_id, event_type, order_reference) DO UPDATE SET provider = EXCLUDED.provider
     RETURNING id, processed`,
    [ws.id, PROVIDER, ev.status, ev.providerEventId, signatureValid, ev.fields, ev.referenceId || ''])).rows[0];
  if (event.processed) return res.status(200).json({ ok: true, duplicate: true });

  const result = await applyWebhookEvent(ws.id, event.id, ev);
  if (result.ignored) return res.status(200).json({ ok: true, ignored: result.ignored });

  if (!result.duplicate && !result.already) publishWorkspaceUpdate(ws.id);
  if (result.lifecycleQueued) void drainMarketplaceOutbox();
  res.status(200).json({
    ok: true,
    status: ev.status,
    paymentId: result.paymentId,
    reviewRequired: result.reviewRequired || undefined,
    duplicate: result.duplicate || result.already ? true : undefined,
  });
}));

module.exports = router;
