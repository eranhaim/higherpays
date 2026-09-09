'use strict';
const express = require('express');
const { query, withTransaction } = require('../db');
const { asyncHandler } = require('../lib/http');
const provider = require('../providers/mantapay');
const paymentsService = require('../services/payments.service');

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

  // Idempotency: record every event we receive (authentic or not, for audit).
  // A duplicate provider_event_id is acknowledged only once the earlier
  // delivery was fully processed; if processing failed, the provider's retry
  // is our second chance. The no-op DO UPDATE makes RETURNING yield the row.
  const event = (await query(
    `INSERT INTO webhook_events (workspace_id, provider, event_type, provider_event_id, signature_valid, payload)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (provider, provider_event_id, event_type) DO UPDATE SET provider = EXCLUDED.provider
     RETURNING id, processed`,
    [ws.id, PROVIDER, ev.status, ev.providerEventId, signatureValid, ev.fields])).rows[0];
  if (event.processed) return res.status(200).json({ ok: true, duplicate: true });

  // Rejected events count as handled: a retry with the same bad signature
  // should not keep them in the unprocessed backlog.
  if (!signatureValid || !merchantOk) {
    await query('UPDATE webhook_events SET processed=true, processed_at=now(), signature_valid=$2 WHERE id=$1', [event.id, signatureValid]);
    if (!signatureValid) return res.status(401).json({ error: 'bad_signature' });
    return res.status(400).json({ error: 'merchant_mismatch' });
  }

  if (ev.kind !== 'chargeback' && !['pending', 'approved', 'declined'].includes(ev.status)) {
    await query('UPDATE webhook_events SET processed=true, processed_at=now() WHERE id=$1', [event.id]);
    return res.status(200).json({ ok: true, ignored: 'non_final_status' });
  }

  let result;
  try {
    result = await withTransaction(async (c) => {
      const lockedEvent = (await c.query(
        'SELECT processed FROM webhook_events WHERE id = $1 FOR UPDATE', [event.id])).rows[0];
      if (lockedEvent.processed) return { duplicate: true };

      const outcome = ev.kind === 'chargeback'
        ? await paymentsService.recordPaymentReversal(c, ws.id, {
            originalProviderTransactionId: ev.originalTransactionId,
            providerTransactionId: ev.transactionId,
            kind: 'chargeback',
            rawPayload: ev.fields,
          })
        : await paymentsService.recordPaymentOutcome(c, ws.id, {
            providerTransactionId: ev.transactionId,
            status: ev.status,
            gross: ev.gross,
            fee: ev.fee,
            currency: ev.currency,
            linkReference: ev.referenceId,
            paymentMethod: ev.paymentDetails,
            rawPayload: ev.fields,
          });
      if (ev.kind === 'chargeback' && (outcome.notFound || outcome.noSale)) {
        throw Object.assign(new Error(outcome.notFound
          ? 'chargeback_original_transaction_not_found'
          : 'chargeback_sale_not_found'), { status: 422 });
      }
      await c.query(
        'UPDATE webhook_events SET processed=true, processed_at=now(), processing_error=NULL WHERE id=$1',
        [event.id]);
      return outcome;
    });
  } catch (error) {
    await query(
      'UPDATE webhook_events SET processing_error = $2 WHERE id = $1',
      [event.id, String(error.code || error.message || 'processing_failed').slice(0, 500)]);
    throw error;
  }

  res.status(200).json({
    ok: true,
    status: ev.status,
    paymentId: result.paymentId,
    duplicate: result.duplicate || result.already ? true : undefined,
  });
}));

module.exports = router;
