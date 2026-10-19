'use strict';

/**
 * Reconciliation: the safety net for a webhook that never arrived. Two sweeps,
 * both applying provider transactions through the same service the webhook
 * uses:
 *
 *   open    — every active link older than the grace period.
 *   closed  — links written off as expired or cancelled that MantaPay may
 *             still approve. MantaPay has approved orders days after the fact
 *             (HP-FKNP-CTAE-8JXA, 14 Oct), and without this sweep that money
 *             is never ingested: the first sweep stopped looking the moment
 *             the link left 'active'.
 */

const { query, withTransaction } = require('../db');
const { log } = require('../lib/log');
const provider = require('../providers/mantapay');
const { DECLINE_SOURCE } = require('../providers/mantapay-reply');
const paymentsService = require('./payments.service');
const { recordLinkEvent } = require('./linkEvents');

const DEFAULT_GRACE_MINUTES = 10;
const LOOP_INTERVAL_MS = 10 * 60_000;

// How long after a closed link was created a MantaPay approval is still
// believed. Long enough for the real cases — the 14 Oct batch was 9 days old.
const LATE_APPROVAL_WINDOW_DAYS = 45;

// How many closed links one run may ask MantaPay about. In production ~1,150
// orders are inside the window, so the sweep rotates through them (oldest
// check first) rather than polling every one of them every ten minutes.
const LATE_APPROVAL_BATCH = 25;

// Only a settled attempt becomes a payment here. MantaPay hands back a fresh
// transaction id for a checkout that is still open, so every poll of an unpaid
// link looked like a new attempt: one phantom pending payment per link per run.
// The push notification still records a pending attempt, once, under its own id.
const SETTLED_STATUSES = ['approved', 'declined'];

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
        if (!transaction.transId || !SETTLED_STATUSES.includes(transaction.status)) continue;
        const outcome = await paymentsService.recordPaymentOutcome(c, ws.id, {
          providerTransactionId: transaction.transId,
          status: transaction.status,
          gross: transaction.amount != null
            ? Number(transaction.amount)
            : Number(link.amount || 0) + Number(link.checkout_fee || 0),
          fee: null,
          currency: (transaction.currency || link.currency || 'EUR').toString().toUpperCase(),
          linkReference: link.reference_id,
          declineCode: transaction.replyCode,
          declineReason: transaction.replyDesc,
          declineCodeSource: DECLINE_SOURCE.status,
          declineReasonSource: DECLINE_SOURCE.status,
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

    if (SETTLED_STATUSES.includes(st)) {
      const outcome = await paymentsService.recordPaymentOutcome(c, ws.id, {
        providerTransactionId: statusResp.transaction_id || ('ref-' + link.reference_id),
        status: st,
        gross: statusResp.gross_amount != null
          ? Number(statusResp.gross_amount)
          : Number(link.amount || 0) + Number(link.checkout_fee || 0),
        fee: null,
        currency: (statusResp.unit || link.currency || 'EUR').toString().toUpperCase(),
        linkReference: link.reference_id,
        declineCode: statusResp.payment_request_status_id,
        declineReason: statusResp.reply_description,
        declineCodeSource: DECLINE_SOURCE.status,
        declineReasonSource: DECLINE_SOURCE.status,
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
      summary.updated.push({ linkId: link.id, to: 'failed', paymentId: outcome.paymentId });
      if (!link.is_expired) continue;
    } else if (st === 'pending') {
      summary.skipped.push({ linkId: link.id, reason: 'status_pending' });
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

  await sweepLateApprovals(c, ws, summary);

  return summary;
}

/**
 * Closed single-use links MantaPay may still approve.
 *
 * Only an approval is acted on. A decline on a link already written off
 * changes nothing, and recording one would mint a payment row every time
 * MantaPay re-identifies a declined attempt.
 *
 * Idempotent by construction rather than by key: a link leaves this set for
 * good the moment it holds a paid payment, so one order can produce at most
 * one late approval. If MantaPay approves a second, differently-identified
 * attempt, recordPaymentOutcome flags it for review and posts no second sale.
 */
async function sweepLateApprovals(c, ws, summary) {
  const closed = (await c.query(
    `SELECT id, reference_id, amount, checkout_fee, currency
       FROM payment_links pl
      WHERE pl.workspace_id = $1
        AND pl.type = 'single_use'
        AND pl.archived_at IS NULL
        AND pl.status IN ('expired', 'cancelled')
        AND pl.created_at > now() - ($2 || ' days')::interval
        AND NOT EXISTS (
          SELECT 1 FROM payments p
           WHERE p.payment_link_id = pl.id
             AND p.status IN ('paid', 'refunded')
             AND p.archived_at IS NULL)
      ORDER BY pl.late_check_at NULLS FIRST
      LIMIT $3`,
    [ws.id, String(LATE_APPROVAL_WINDOW_DAYS), LATE_APPROVAL_BATCH])).rows;

  // Stamped before the polling, so a provider error does not park the sweep on
  // the same batch for good.
  if (closed.length) {
    await c.query('UPDATE payment_links SET late_check_at = now() WHERE id = ANY($1::uuid[])',
      [closed.map((l) => l.id)]);
  }

  for (const link of closed) {
    summary.checked++;
    let statusResp;
    try { statusResp = await provider.getPaymentStatus(ws, link.reference_id); }
    catch (e) { summary.skipped.push({ linkId: link.id, reason: 'status_error', detail: e.detail || e.message }); continue; }

    if (statusResp.status !== 'approved' || !statusResp.transaction_id) {
      summary.skipped.push({ linkId: link.id, reason: 'still_' + statusResp.status });
      continue;
    }

    const outcome = await paymentsService.recordPaymentOutcome(c, ws.id, {
      providerTransactionId: statusResp.transaction_id,
      status: 'approved',
      gross: statusResp.gross_amount != null
        ? Number(statusResp.gross_amount)
        : Number(link.amount || 0) + Number(link.checkout_fee || 0),
      fee: null,
      currency: (statusResp.unit || link.currency || 'EUR').toString().toUpperCase(),
      linkReference: link.reference_id,
      rawPayload: statusResp,
    });
    summary.updated.push({
      linkId: link.id,
      to: 'pending',
      lateApproval: true,
      paymentId: outcome.paymentId,
      newSale: outcome.newSale,
      reviewRequired: outcome.reviewRequired,
    });
  }
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
