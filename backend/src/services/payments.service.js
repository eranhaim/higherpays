'use strict';
// The one place an observed payment outcome becomes rows. Two callers:
//
//   - webhook:    POST /webhooks/payment/:endpoint      (provider push)
//   - reconciler: POST /workspaces/:id/links/reconcile  (pull, when a webhook
//                 was missed)
//
// Both are idempotent by (workspace_id, provider id) and both post the sale to
// the ledger exactly once, however many times the same event is re-observed.
//
// Does NOT open its own transaction: the caller passes a client from
// withTransaction().

const notifier = require('../notify');
const { log } = require('../lib/log');

/**
 * @param {import('pg').PoolClient} client  a client inside an open transaction
 * @param {string} workspaceId
 * @param {object} params
 * @param {string}      params.providerTransactionId  unique per attempt
 * @param {'approved'|'declined'} params.status
 * @param {number|null} params.gross
 * @param {number|null} [params.fee]
 * @param {string}      params.currency
 * @param {string|null} [params.linkReference]  our reference_id, for attribution
 * @param {string|null} [params.paymentMethod]
 * @param {object}      params.rawPayload       stored verbatim
 * @returns {Promise<{ paymentId: string|null, transactionId: string|null, linkId: string|null, newSale: boolean }>}
 */
async function recordPaymentOutcome(client, workspaceId, params) {
  const {
    providerTransactionId, status, gross, fee = null, currency,
    linkReference = null, paymentMethod = null, rawPayload,
  } = params;

  if (status !== 'approved' && status !== 'declined') {
    throw new Error(`recordPaymentOutcome: unsupported status "${status}"`);
  }

  // 1) The link gives the attribution: account, agent, customer.
  const link = linkReference
    ? (await client.query(
        `SELECT id, type, status, account_id, customer_id, created_by_agent_id, amount
           FROM payment_links WHERE workspace_id = $1 AND reference_id = $2`,
        [workspaceId, linkReference])).rows[0]
    : null;
  // A payment must belong to an account. Without a link there is nothing to
  // credit, so the event is kept in webhook_events only.
  if (!link) {
    log.warn({ workspaceId, providerTransactionId, linkReference }, 'payment outcome without a matching link');
    return { paymentId: null, transactionId: null, linkId: null, newSale: false };
  }

  const grossValue = gross != null ? gross : Number(link.amount || 0);
  // MantaPay does not send fees in notifications; the ledger prices the sale
  // from the rate card and the Search API later replaces the estimate.
  const feeValue = fee != null ? fee : 0;

  // 2) The payment. An approved outcome is final: a decline observed later for
  //    the same attempt must not flip it back. The no-op DO UPDATE makes
  //    RETURNING yield the existing row either way.
  const paymentStatus = status === 'approved' ? 'paid' : 'failed';
  const payment = (await client.query(
    `INSERT INTO payments
       (workspace_id, account_id, payment_link_id, customer_id, agent_id,
        amount, currency, status, payment_method, provider_payment_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
     ON CONFLICT (workspace_id, provider_payment_id) DO UPDATE
       SET status = CASE WHEN payments.status = 'paid' THEN payments.status ELSE EXCLUDED.status END
     RETURNING id, status`,
    [workspaceId, link.account_id, link.id, link.customer_id, link.created_by_agent_id,
     grossValue, currency, paymentStatus, paymentMethod, providerTransactionId])).rows[0];

  // 3) The provider's record of the attempt.
  const tx = (await client.query(
    `INSERT INTO transactions
       (workspace_id, payment_id, type, status, gross, fee, net, currency, provider_transaction_id, occurred_at, raw_payload)
     VALUES ($1,$2,'payment',$3,$4,$5,$6,$7,$8,now(),$9)
     ON CONFLICT (workspace_id, provider_transaction_id) DO UPDATE
       SET status = CASE WHEN transactions.status = 'approved' THEN transactions.status ELSE EXCLUDED.status END,
           fee = EXCLUDED.fee, net = EXCLUDED.net
     RETURNING id, status`,
    [workspaceId, payment.id, status, grossValue, feeValue, grossValue - feeValue, currency,
     providerTransactionId, rawPayload])).rows[0];

  // 4) A paid single-use link waits for the agent to complete the details.
  //    A reusable link stays open; a declined attempt leaves either untouched
  //    so the customer can try again.
  if (payment.status === 'paid' && link.type === 'single_use' && link.status === 'active') {
    await client.query(
      "UPDATE payment_links SET status = 'pending', paid_at = now() WHERE id = $1", [link.id]);
  }

  // 5) Post the sale to the ledger once.
  let newSale = false;
  if (tx.status === 'approved') {
    const already = (await client.query(
      "SELECT 1 FROM revenue_entries WHERE transaction_id = $1 AND entry_type = 'sale'", [tx.id])).rows[0];
    if (!already) {
      await client.query('SELECT fn_post_sale($1)', [tx.id]);
      newSale = true;
    }
  }

  // 6) Notify. In a SAVEPOINT: a failed statement aborts the whole transaction
  //    in Postgres, and a notification must never lose the money.
  await client.query('SAVEPOINT notify_sp');
  try {
    const account = (await client.query('SELECT name FROM accounts WHERE id = $1', [link.account_id])).rows[0];
    await notifier.notify(client, workspaceId, {
      event: status === 'approved' ? 'payment.paid' : 'payment.failed',
      title: status === 'approved' ? 'Payment received' : 'Payment declined',
      body: account ? `Account: ${account.name}` : null,
      accountId: link.account_id,
      agentId: link.created_by_agent_id,
      amount: grossValue,
      currency,
      entityType: 'payment',
      entityId: payment.id,
    });
    await client.query('RELEASE SAVEPOINT notify_sp');
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT notify_sp').catch(() => {});
    log.error({ paymentId: payment.id, err: e.message }, 'notify failed; payment still recorded');
  }

  return { paymentId: payment.id, transactionId: tx.id, linkId: link.id, newSale };
}

module.exports = { recordPaymentOutcome };
