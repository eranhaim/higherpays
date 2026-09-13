'use strict';

/**
 * Reconciliation: the safety net for a webhook that never arrived. Polls every
 * active link older than the grace period and applies provider transactions
 * through the same service the webhook uses.
 */

const { query, withTransaction } = require('../db');
const { log } = require('../lib/log');
const provider = require('../providers/mantapay');
const paymentsService = require('./payments.service');
const { recordLinkEvent } = require('./linkEvents');

const DEFAULT_GRACE_MINUTES = 10;
const LOOP_INTERVAL_MS = 10 * 60_000;

async function reconcileWorkspace(c, ws, graceMinutes = DEFAULT_GRACE_MINUTES) {
  const summary = { checked: 0, updated: [], skipped: [] };

  const stuck = (await c.query(
    `SELECT id, reference_id, type, amount, checkout_fee, currency, expires_at < now() AS is_expired
       FROM payment_links
      WHERE workspace_id = $1 AND status = 'active'
        AND archived_at IS NULL
        AND created_at < now() - ($2 || ' minutes')::interval`,
    [ws.id, String(graceMinutes)])).rows;

  for (const link of stuck) {
    summary.checked++;
    let statusResp;
    try { statusResp = await provider.getPaymentStatus(ws, link.reference_id); }
    catch (e) { summary.skipped.push({ linkId: link.id, reason: 'status_error', detail: e.detail || e.message }); continue; }

    if (statusResp.transaction_id) {
      await c.query('UPDATE payment_links SET provider_request_id=$2 WHERE id=$1', [link.id, statusResp.transaction_id]);
    }

    if (link.type === 'reusable') {
      for (const [index, transaction] of (statusResp.transactions || []).entries()) {
        if (!transaction.transId || !['approved', 'pending', 'declined'].includes(transaction.status)) continue;
        const outcome = await paymentsService.recordPaymentOutcome(c, ws.id, {
          providerTransactionId: transaction.transId,
          status: transaction.status,
          gross: transaction.amount != null
            ? Number(transaction.amount)
            : Number(link.amount || 0) + Number(link.checkout_fee || 0),
          fee: null,
          currency: (transaction.currency || link.currency || 'EUR').toString().toUpperCase(),
          linkReference: link.reference_id,
          rawPayload: transaction,
        });
        summary.updated.push({
          linkId: link.id,
          paymentId: outcome.paymentId,
          newSale: outcome.newSale,
          reviewRequired: outcome.reviewRequired,
          attempt: index + 1,
        });
      }
      continue;
    }

    const st = statusResp.status;   // approved | declined | pending | abandoned | unknown

    if (st === 'approved' || (st === 'pending' && statusResp.transaction_id)) {
      const outcome = await paymentsService.recordPaymentOutcome(c, ws.id, {
        providerTransactionId: statusResp.transaction_id || ('ref-' + link.reference_id),
        status: st,
        gross: statusResp.gross_amount != null
          ? Number(statusResp.gross_amount)
          : Number(link.amount || 0) + Number(link.checkout_fee || 0),
        fee: null,
        currency: (statusResp.unit || link.currency || 'EUR').toString().toUpperCase(),
        linkReference: link.reference_id,
        rawPayload: statusResp,
      });
      if (st === 'approved') {
        summary.updated.push({
          linkId: link.id,
          to: 'pending',
          paymentId: outcome.paymentId,
          newSale: outcome.newSale,
          reviewRequired: outcome.reviewRequired,
        });
        continue;
      }
      summary.skipped.push({ linkId: link.id, reason: 'status_pending', paymentId: outcome.paymentId });
      if (!link.is_expired) continue;
    }
    // Anything short of approval leaves the link open until its deadline.
    if (link.is_expired) {
      await c.query("UPDATE payment_links SET status='expired' WHERE id=$1 AND status='active'", [link.id]);
      await recordLinkEvent(c, {
        workspaceId: ws.id, linkId: link.id, eventType: 'expired',
        source: 'higherpays', idempotencyKey: 'expired',
      });
      summary.updated.push({ linkId: link.id, to: 'expired', via: st });
      continue;
    }
    summary.skipped.push({ linkId: link.id, reason: 'status_' + st });
  }

  return summary;
}

// One transaction per workspace, so one agency's provider trouble cannot roll
// back another's settled payments.
async function reconcileAllWorkspaces() {
  const workspaces = (await query('SELECT * FROM workspaces')).rows;
  for (const ws of workspaces) {
    try {
      const summary = await withTransaction((c) => reconcileWorkspace(c, ws));
      if (summary.checked > 0) {
        log.info({ workspaceId: ws.id, checked: summary.checked, updated: summary.updated.length, skipped: summary.skipped.length }, 'reconcile');
      }
    } catch (e) {
      log.error({ workspaceId: ws.id, err: e.message }, 'reconcile failed');
    }
  }
}

/**
 * Runs the reconciler on a timer for the life of the process. A run that
 * overruns the interval is not started twice; the timer does not hold the
 * process open.
 */
function startReconcileLoop() {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await reconcileAllWorkspaces(); }
    finally { running = false; }
  }, LOOP_INTERVAL_MS);
  timer.unref();
  return timer;
}

module.exports = { reconcileWorkspace, reconcileAllWorkspaces, startReconcileLoop, DEFAULT_GRACE_MINUTES };
