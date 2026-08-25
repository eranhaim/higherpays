'use strict';
const express = require('express');
const { withSystem } = require('../db');
const { asyncHandler } = require('../lib/http');
const provider = require('../providers/mantapay');
const paymentsService = require('../services/payments.service');

const router = express.Router();
const PROVIDER = 'mantapay';

// POST /webhooks/payment/:endpoint
//
// MantaPay POSTs application/x-www-form-urlencoded with the final result.
// Layered authentication, evaluated in order:
//   1. The opaque per-workspace endpoint id in the URL resolves the tenant.
//   2. verifyWebhookSignature over the raw body, keyed with the workspace's
//      per-merchant hash key (subset of fields, see mantapay-signature.js).
//   3. merchantID in the payload matches the workspace's stored MID (when set).
//
// Everything runs inside withSystem: the tenant isn't known until step 1, and
// `workspaces` is FORCE-RLS so a bare pool query returns zero rows.
router.post('/payment/:endpoint', asyncHandler(async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));

  const ws = await withSystem((c) => c.query(
    'SELECT id, mid, provider_config_ref FROM workspaces WHERE webhook_endpoint_id = $1',
    [req.params.endpoint]).then((r) => r.rows[0]));
  if (!ws) return res.status(404).json({ error: 'unknown_endpoint' });

  const apiKey = provider.resolveApiKey(ws);
  const signatureValid = provider.verifyWebhookSignature(raw, apiKey, req.headers[provider.SIGNATURE_HEADER]);

  let ev;
  try { ev = provider.parseWebhook(raw); }
  catch { return res.status(400).json({ error: 'bad_payload' }); }

  const merchantOk = !ws.mid || (ev.merchantId && ev.merchantId === ws.mid);

  // Idempotency: record every event we receive (authentic or not, for audit).
  // A duplicate provider_event_id is acknowledged only once the earlier
  // delivery was fully processed; if processing failed, the provider's retry
  // is our second chance and must run the outcome again. The no-op DO UPDATE
  // is what makes RETURNING yield the existing row.
  const event = await withSystem((c) => c.query(
    `INSERT INTO webhook_events (workspace_id, provider, event_type, provider_event_id, signature_valid, payload)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (provider, provider_event_id) DO UPDATE SET provider = EXCLUDED.provider
     RETURNING id, processed`,
    [ws.id, PROVIDER, ev.status, ev.providerEventId, signatureValid, ev.fields])
    .then((r) => r.rows[0]));
  const eventRowId = event.id;
  if (event.processed) return res.status(200).json({ ok: true, duplicate: true });

  // Rejected events count as handled: a retry with the same bad signature
  // should not keep them in the unprocessed backlog.
  if (!signatureValid || !merchantOk) {
    await withSystem((c) => c.query(
      'UPDATE webhook_events SET processed=true, processed_at=now(), signature_valid=$2 WHERE id=$1',
      [eventRowId, signatureValid]));
    if (!signatureValid) return res.status(401).json({ error: 'bad_signature' });
    return res.status(400).json({ error: 'merchant_mismatch' });
  }

  if (ev.status !== 'approved' && ev.status !== 'declined') {
    await withSystem((c) => c.query(
      'UPDATE webhook_events SET processed=true, processed_at=now() WHERE id=$1', [eventRowId]));
    return res.status(200).json({ ok: true, ignored: 'non_final_status' });
  }

  const result = await withSystem(async (c) => {
    const outcome = await paymentsService.recordPaymentOutcome(c, ws.id, {
      providerTransactionId: ev.transactionId,
      status: ev.status,
      gross: ev.gross,
      fee: ev.fee,
      net: ev.net,
      currency: ev.currency,
      linkReference: ev.referenceId,
      rawPayload: ev.fields,
    });
    await c.query(
      'UPDATE webhook_events SET processed=true, processed_at=now() WHERE id=$1', [eventRowId]);
    return outcome;
  });

  res.status(200).json({ ok: true, status: ev.status, transactionId: result.transactionId });
}));

module.exports = router;
