'use strict';
// Payments service — the single source of truth for "an outcome was observed
// for a payment attempt". Two callers converge on this:
//
//   - webhook: /webhooks/payment/:endpoint  (provider push)
//   - reconciler: POST /workspaces/:id/links/reconcile  (pull, when a webhook
//     was missed)
//
// Both must be idempotent by (workspace_id, provider_transaction_id) and both
// must invoke fn_post_sale exactly once for an approved outcome, however many
// times the same event is re-observed. Duplication between the two used to be
// a fertile source of bugs; centralising the logic here fixes that.
//
// This service does NOT open its own transaction. The caller is expected to
// pass a client from withSystem() (webhook, where the tenant is trusted-context
// resolved) or withWorkspace() (reconciler, where the caller is authenticated).

const notifier = require('../notify');

/**
 * Record an outcome (approved or declined) for a payment attempt.
 *
 * @param {import('pg').PoolClient} client  a client inside an open transaction
 * @param {string} workspaceId
 * @param {object} params
 * @param {string}      params.providerTransactionId  unique per attempt
 * @param {'approved'|'declined'} params.status
 * @param {number|null} params.gross
 * @param {number|null} [params.fee]
 * @param {number|null} [params.net]
 * @param {string}      params.currency
 * @param {string|null} [params.linkReference]  our reference_id, for attribution
 * @param {object}      params.rawPayload       stored verbatim
 * @returns {Promise<{ transactionId: string, linkId: string|null, newSale: boolean }>}
 */
async function recordPaymentOutcome(client, workspaceId, params) {
  const {
    providerTransactionId, status, gross, fee = null, net = null, currency,
    linkReference = null, rawPayload,
  } = params;

  if (status !== 'approved' && status !== 'declined') {
    throw new Error(`recordPaymentOutcome: unsupported status "${status}"`);
  }

  // 1) Look up the payment link (for attribution) if we have a reference.
  const link = linkReference
    ? (await client.query(
        `SELECT id, creator_id, customer_id, created_by, amount
         FROM payment_links WHERE workspace_id = $1 AND reference_id = $2`,
        [workspaceId, linkReference])).rows[0]
    : null;

  const grossValue = gross != null ? gross : (link ? Number(link.amount) : 0);
  // MantaPay doesn't send fees in notifications; the payout engine prices the
  // sale from the rate card, and the Search API later replaces the estimate
  // with the provider's actual figure. The transactions table requires a NUMERIC
  // fee, so we store 0 as the pre-reconcile placeholder.
  const feeValue = fee != null ? fee : 0;
  const netValue = net != null ? net : grossValue - feeValue;

  // 2) Insert transaction (idempotent on (workspace_id, provider_transaction_id)).
  //    An approved sale is final: a decline observed later for the same
  //    attempt must not flip it back, or the ledger and the transaction
  //    would disagree. The DO UPDATE returns no row in that case, so the
  //    existing row is read back.
  const upserted = (await client.query(
    `INSERT INTO transactions
       (workspace_id, payment_link_id, creator_id, customer_id, attributed_membership_id,
        type, status, gross, fee, net, currency, provider_transaction_id, occurred_at, raw_payload)
     VALUES ($1,$2,$3,$4,$5,'payment'::txn_type,$6::txn_status,$7,$8,$9,$10,$11,now(),$12)
     ON CONFLICT (workspace_id, provider_transaction_id)
       DO UPDATE SET status = EXCLUDED.status, fee = EXCLUDED.fee, net = EXCLUDED.net
       WHERE transactions.status <> 'approved'
     RETURNING id`,
    [workspaceId,
     link ? link.id : null,
     link ? link.creator_id : null,
     link ? link.customer_id : null,
     link ? link.created_by : null,
     status, grossValue, feeValue, netValue, currency, providerTransactionId, rawPayload]))
    .rows[0];
  const tx = upserted ?? (await client.query(
    'SELECT id FROM transactions WHERE workspace_id = $1 AND provider_transaction_id = $2',
    [workspaceId, providerTransactionId])).rows[0];
  const ignoredLateDecline = !upserted && status === 'declined';

  // 3) Flip the link status if we attributed to one.
  if (link && !ignoredLateDecline) {
    if (status === 'approved') {
      await client.query(
        "UPDATE payment_links SET status='paid'::link_status, paid_at=now() WHERE id=$1",
        [link.id]);
    } else {
      await client.query(
        "UPDATE payment_links SET status='failed'::link_status WHERE id=$1",
        [link.id]);
    }
  }

  // 4) Invoke the payout engine ONCE per approved sale. Reruns are cheap to
  //    check but expensive to duplicate (would double-post commissions).
  let newSale = false;
  if (status === 'approved') {
    const already = (await client.query(
      "SELECT 1 FROM commission_entries WHERE transaction_id=$1 AND entry_type='sale'",
      [tx.id])).rows[0];
    if (!already) {
      await client.query('SELECT fn_post_sale($1)', [tx.id]);
      newSale = true;
    }
  }

  // 5) Fire the notification (in-app feed + Telegram). Wrapped in a SAVEPOINT
  //    because in Postgres a failed statement aborts the whole transaction; the
  //    catch alone (without ROLLBACK TO SAVEPOINT) would still lose the money.
  await client.query('SAVEPOINT notify_sp');
  try {
    const creatorName = link && link.creator_id
      ? ((await client.query(
          'SELECT stage_name FROM creators WHERE id=$1', [link.creator_id])).rows[0] || {}).stage_name
      : null;

    await notifier.notify(client, workspaceId, {
      event: status === 'approved' ? 'payment.paid' : 'payment.failed',
      title: status === 'approved' ? 'Payment received' : 'Payment declined',
      body: creatorName ? `Creator: ${creatorName}` : null,
      amount: grossValue,
      currency,
      entityType: 'transaction',
      entityId: tx.id,
    });
    await client.query('RELEASE SAVEPOINT notify_sp');
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT notify_sp').catch(() => {});
    console.error('[payments] notify failed (payment still recorded):', e.message);
  }

  return { transactionId: tx.id, linkId: link ? link.id : null, newSale };
}

module.exports = { recordPaymentOutcome };
