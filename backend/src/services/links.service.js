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
 *
 * MantaPay is asked outside any database transaction, and each outcome is
 * recorded in its own short one. A run used to be one transaction per
 * workspace: one record MantaPay reported with an unexpected amount rolled back
 * every other payment of the run, on every run, and the link locks held across
 * hundreds of HTTP calls made the webhooks of that workspace time out.
 */

const { query, withTransaction } = require('../db');
const { log } = require('../lib/log');
const provider = require('../providers/mantapay');
const { DECLINE_SOURCE } = require('../providers/mantapay-reply');
const paymentsService = require('./payments.service');
const { recordLinkEvent } = require('./linkEvents');
const { publishWorkspaceUpdate } = require('../events/workspaceEvents');

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

// Records one provider outcome. A failure skips only this outcome and is
// logged; it returns null.
async function recordOutcome(ws, link, outcome, summary) {
  try {
    const recorded = await withTransaction((c) => paymentsService.recordPaymentOutcome(c, ws.id, {
      ...outcome,
      fee: null,
      linkReference: link.reference_id,
    }));
    summary.changed = true;
    return recorded;
  } catch (e) {
    log.warn({ workspaceId: ws.id, linkId: link.id, err: e.code || e.message }, 'reconcile skipped an outcome');
    summary.skipped.push({ linkId: link.id, reason: e.code || 'record_error' });
    return null;
  }
}

async function expireLink(ws, link, summary, via) {
  await withTransaction(async (c) => {
    await c.query("UPDATE payment_links SET status='expired' WHERE id=$1 AND status='active'", [link.id]);
    await recordLinkEvent(c, {
      workspaceId: ws.id, linkId: link.id, eventType: 'expired',
      source: 'higherpays', idempotencyKey: 'expired',
    });
  });
  summary.changed = true;
  summary.updated.push({ linkId: link.id, to: 'expired', via });
}

const amountFrom = (providerAmount, link) => (providerAmount != null
  ? Number(providerAmount)
  : Number(link.amount || 0) + Number(link.checkout_fee || 0));

const currencyFrom = (providerCurrency, link) =>
  (providerCurrency || link.currency || 'EUR').toString().toUpperCase();

async function reconcileReusableLink(ws, link, statusResp, summary) {
  for (const [index, transaction] of (statusResp.transactions || []).entries()) {
    if (!transaction.transId || !SETTLED_STATUSES.includes(transaction.status)) continue;
    const recorded = await recordOutcome(ws, link, {
      providerTransactionId: transaction.transId,
      status: transaction.status,
      gross: amountFrom(transaction.amount, link),
      currency: currencyFrom(transaction.currency, link),
      declineCode: transaction.replyCode,
      declineReason: transaction.replyDesc,
      declineCodeSource: DECLINE_SOURCE.status,
      declineReasonSource: DECLINE_SOURCE.status,
      rawPayload: transaction,
    }, summary);
    if (!recorded) continue;
    summary.updated.push({
      linkId: link.id,
      paymentId: recorded.paymentId,
      newSale: recorded.newSale,
      reviewRequired: recorded.reviewRequired,
      attempt: index + 1,
    });
  }
}

async function reconcileSingleUseLink(ws, link, statusResp, summary) {
  const st = statusResp.status;   // approved | declined | pending | abandoned | unknown

  if (SETTLED_STATUSES.includes(st)) {
    const recorded = await recordOutcome(ws, link, {
      providerTransactionId: statusResp.transaction_id || ('ref-' + link.reference_id),
      status: st,
      gross: amountFrom(statusResp.gross_amount, link),
      currency: currencyFrom(statusResp.unit, link),
      declineCode: statusResp.payment_request_status_id,
      declineReason: statusResp.reply_description,
      declineCodeSource: DECLINE_SOURCE.status,
      declineReasonSource: DECLINE_SOURCE.status,
      rawPayload: statusResp,
    }, summary);
    if (st === 'approved') {
      if (recorded) {
        summary.updated.push({
          linkId: link.id,
          to: 'pending',
          paymentId: recorded.paymentId,
          newSale: recorded.newSale,
          reviewRequired: recorded.reviewRequired,
        });
      }
      return;
    }
    if (recorded) summary.updated.push({ linkId: link.id, to: 'failed', paymentId: recorded.paymentId });
  } else if (st === 'pending') {
    summary.skipped.push({ linkId: link.id, reason: 'status_pending' });
  }
  // Anything short of approval leaves the link open until its deadline.
  if (link.is_expired) {
    await expireLink(ws, link, summary, st);
    return;
  }
  if (!SETTLED_STATUSES.includes(st) && st !== 'pending') {
    summary.skipped.push({ linkId: link.id, reason: 'status_' + st });
  }
}

async function reconcileWorkspace(ws, graceMinutes = DEFAULT_GRACE_MINUTES) {
  const summary = { checked: 0, updated: [], skipped: [], changed: false };

  const stuck = (await query(
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
      await query('UPDATE payment_links SET provider_request_id=$2 WHERE id=$1', [link.id, statusResp.transaction_id]);
    }

    if (link.type === 'reusable') await reconcileReusableLink(ws, link, statusResp, summary);
    else await reconcileSingleUseLink(ws, link, statusResp, summary);
  }

  await sweepLateApprovals(ws, summary);

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
async function sweepLateApprovals(ws, summary) {
  // Stamped before the polling, so a provider error does not park the sweep on
  // the same batch for good.
  const closed = (await query(
    `UPDATE payment_links SET late_check_at = now()
      WHERE id IN (
        SELECT pl.id FROM payment_links pl
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
         LIMIT $3)
      RETURNING id, reference_id, amount, checkout_fee, currency`,
    [ws.id, String(LATE_APPROVAL_WINDOW_DAYS), LATE_APPROVAL_BATCH])).rows;

  for (const link of closed) {
    summary.checked++;
    let statusResp;
    try { statusResp = await provider.getPaymentStatus(ws, link.reference_id); }
    catch (e) { summary.skipped.push({ linkId: link.id, reason: 'status_error', detail: e.detail || e.message }); continue; }

    if (statusResp.status !== 'approved' || !statusResp.transaction_id) {
      summary.skipped.push({ linkId: link.id, reason: 'still_' + statusResp.status });
      continue;
    }

    const recorded = await recordOutcome(ws, link, {
      providerTransactionId: statusResp.transaction_id,
      status: 'approved',
      gross: amountFrom(statusResp.gross_amount, link),
      currency: currencyFrom(statusResp.unit, link),
      rawPayload: statusResp,
    }, summary);
    if (!recorded) continue;
    summary.updated.push({
      linkId: link.id,
      to: 'pending',
      lateApproval: true,
      paymentId: recorded.paymentId,
      newSale: recorded.newSale,
      reviewRequired: recorded.reviewRequired,
    });
  }
}

async function reconcileAllWorkspaces() {
  const workspaces = (await query('SELECT * FROM workspaces')).rows;
  for (const ws of workspaces) {
    try {
      const summary = await reconcileWorkspace(ws);
      if (summary.changed) publishWorkspaceUpdate(ws.id);
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
