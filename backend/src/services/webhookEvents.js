'use strict';

/**
 * Applies one stored, authenticated MantaPay notification to the ledger. The
 * webhook route runs it on delivery; the reconciler runs it again for the
 * notifications that failed, so a timeout or a since-fixed parsing bug does
 * not lose a sale that MantaPay approved.
 */

const { query, withTransaction } = require('../db');
const { DECLINE_SOURCE } = require('../providers/mantapay-reply');
const paymentsService = require('./payments.service');
const { enqueueLifecycleEventForReference } = require('../routes/marketplace.routes');

const FINAL_PAYMENT_STATUSES = ['pending', 'approved', 'declined'];

/**
 * @param {string} workspaceId
 * @param {string} eventId  webhook_events.id
 * @param {object} ev       the parsed notification (provider.readNotification)
 * @returns {Promise<object>} the outcome, with `duplicate`, `ignored` or `lifecycleQueued`
 */
async function applyWebhookEvent(workspaceId, eventId, ev) {
  if (ev.kind !== 'chargeback' && !FINAL_PAYMENT_STATUSES.includes(ev.status)) {
    await query('UPDATE webhook_events SET processed=true, processed_at=now() WHERE id=$1', [eventId]);
    return { ignored: 'non_final_status' };
  }

  try {
    return await withTransaction(async (c) => {
      const lockedEvent = (await c.query(
        'SELECT processed FROM webhook_events WHERE id = $1 FOR UPDATE', [eventId])).rows[0];
      if (lockedEvent.processed) return { duplicate: true };

      const outcome = ev.kind === 'chargeback'
        ? await paymentsService.recordPaymentReversal(c, workspaceId, {
            originalProviderTransactionId: ev.originalTransactionId,
            providerTransactionId: ev.transactionId,
            kind: 'chargeback',
            rawPayload: ev.fields,
          })
        : await paymentsService.recordPaymentOutcome(c, workspaceId, {
            providerTransactionId: ev.transactionId,
            status: ev.status,
            gross: ev.gross,
            fee: ev.fee,
            currency: ev.currency,
            linkReference: ev.referenceId,
            paymentMethod: ev.paymentDetails,
            declineCode: ev.replyCode,
            declineReason: ev.replyDesc,
            declineCodeSource: DECLINE_SOURCE.webhookSigned,
            declineReasonSource: DECLINE_SOURCE.webhook,
            rawPayload: ev.fields,
          });
      if (ev.kind === 'chargeback' && (outcome.notFound || outcome.noSale)) {
        throw Object.assign(new Error(outcome.notFound
          ? 'chargeback_original_transaction_not_found'
          : 'chargeback_sale_not_found'), { status: 422 });
      }
      const lifecycleType = ev.kind === 'chargeback'
        ? 'payment.chargeback'
        : ev.status === 'approved' ? 'payment.approved' : null;
      if (lifecycleType) {
        await enqueueLifecycleEventForReference(c, ev.referenceId, lifecycleType, ev.transactionId);
      }
      await c.query(
        'UPDATE webhook_events SET processed=true, processed_at=now(), processing_error=NULL WHERE id=$1',
        [eventId]);
      return { ...outcome, lifecycleQueued: Boolean(lifecycleType) };
    });
  } catch (error) {
    await query(
      'UPDATE webhook_events SET processing_error = $2 WHERE id = $1',
      [eventId, String(error.code || error.message || 'processing_failed').slice(0, 500)]);
    throw error;
  }
}

module.exports = { applyWebhookEvent };
