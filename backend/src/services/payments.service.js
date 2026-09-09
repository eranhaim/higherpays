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
 * @param {'pending'|'approved'|'declined'} params.status
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
    providerTransactionId, status, fee = null, currency,
    linkReference = null, paymentMethod = null, rawPayload,
  } = params;

  if (!['pending', 'approved', 'declined'].includes(status)) {
    throw new Error(`recordPaymentOutcome: unsupported status "${status}"`);
  }

  // Locking the link makes approval of a single-use link a one-winner operation.
  // A second provider attempt can remain pending, but cannot post another sale.
  const link = linkReference
    ? (await client.query(
        `SELECT id, type, status, account_id, created_by_agent_id, amount, checkout_fee, currency
           FROM payment_links WHERE workspace_id = $1 AND reference_id = $2
           FOR UPDATE`,
        [workspaceId, linkReference])).rows[0]
    : null;
  // A payment must belong to an account. Without a link there is nothing to
  // credit, so the event is kept in webhook_events only.
  if (!link) {
    log.warn({ workspaceId, providerTransactionId, linkReference }, 'payment outcome without a matching link');
    return { paymentId: null, transactionId: null, linkId: null, newSale: false };
  }

  validateProviderMoney({
    providerAmount: params.gross,
    providerCurrency: currency,
    contentAmount: link.amount,
    checkoutFee: link.checkout_fee,
    expectedCurrency: link.currency,
  });

  const grossValue = Number(link.amount || 0);
  const surcharge = Number(link.checkout_fee || 0);
  const feeValue = fee != null ? fee : 0;
  const feeIsEstimate = fee == null;

  if (status === 'approved' && link.type === 'single_use') {
    const winner = (await client.query(
      `SELECT provider_payment_id
         FROM payments
        WHERE payment_link_id = $1 AND status = 'paid'
        ORDER BY occurred_at LIMIT 1`,
      [link.id])).rows[0];
    if (winner && winner.provider_payment_id !== providerTransactionId) {
      throw paymentOutcomeError('single_use_link_already_paid', {
        linkId: link.id,
        providerTransactionId,
        winningProviderTransactionId: winner.provider_payment_id,
      });
    }
  }

  const paymentStatus = status === 'approved' ? 'paid' : status === 'declined' ? 'failed' : 'pending';
  const payment = (await client.query(
    `INSERT INTO payments
       (workspace_id, account_id, payment_link_id, agent_id,
        amount, currency, status, payment_method, provider_payment_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
     ON CONFLICT (workspace_id, provider_payment_id) DO UPDATE
       SET status = CASE
         WHEN payments.status = 'refunded' THEN 'refunded'
         WHEN payments.status = 'paid' OR EXCLUDED.status = 'paid' THEN 'paid'
         WHEN payments.status = 'failed' THEN 'failed'
         ELSE EXCLUDED.status
       END
     RETURNING id, status`,
    [workspaceId, link.account_id, link.id, link.created_by_agent_id,
     grossValue, currency, paymentStatus, paymentMethod, providerTransactionId])).rows[0];

  // 3) The provider's record of the attempt.
  const tx = (await client.query(
    `INSERT INTO transactions
       (workspace_id, payment_id, type, status, gross, fee, fee_is_estimate, surcharge, net, currency, provider_transaction_id, occurred_at, raw_payload)
     VALUES ($1,$2,'payment',$3,$4,$5,$6,$7,$8,$9,$10,now(),$11)
     ON CONFLICT (workspace_id, provider_transaction_id) DO UPDATE
       SET status = CASE
         WHEN transactions.status = 'approved' OR EXCLUDED.status = 'approved' THEN 'approved'
         WHEN transactions.status = 'declined' THEN 'declined'
         ELSE EXCLUDED.status
       END,
           fee = CASE WHEN EXCLUDED.fee_is_estimate THEN transactions.fee ELSE EXCLUDED.fee END,
           fee_is_estimate = transactions.fee_is_estimate AND EXCLUDED.fee_is_estimate,
           net = CASE WHEN EXCLUDED.fee_is_estimate THEN transactions.net ELSE EXCLUDED.net END,
           raw_payload = EXCLUDED.raw_payload
     RETURNING id, status`,
    [workspaceId, payment.id, status, grossValue, feeValue, feeIsEstimate, surcharge,
     grossValue - feeValue, currency, providerTransactionId, rawPayload])).rows[0];

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
  const shouldNotify = (status === 'approved' && payment.status === 'paid' && tx.status === 'approved')
    || (status === 'declined' && payment.status === 'failed' && tx.status === 'declined');
  if (shouldNotify) {
    await notifySafely(client, payment.id, async () => {
      const account = (await client.query('SELECT name FROM accounts WHERE id = $1', [link.account_id])).rows[0];
      await notifier.notify(client, workspaceId, {
        event: status === 'approved' ? 'payment.paid' : 'payment.failed',
        title: status === 'approved' ? 'Payment received' : 'Payment declined',
        body: account ? `Creator: ${account.name}` : null,
        accountId: link.account_id,
        agentId: link.created_by_agent_id,
        amount: grossValue,
        currency,
        entityType: 'payment',
        entityId: payment.id,
      });
    });
  }

  return { paymentId: payment.id, transactionId: tx.id, linkId: link.id, newSale };
}

function toMinorUnits(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const minor = Math.round(number * 100);
  return Math.abs(number * 100 - minor) < 0.000001 ? minor : null;
}

function paymentOutcomeError(code, metadata) {
  log.error(metadata, code);
  return Object.assign(new Error(code), { code, status: 422, metadata });
}

function validateProviderMoney({
  providerAmount, providerCurrency, contentAmount, checkoutFee, expectedCurrency,
}) {
  const actualCurrency = String(providerCurrency || '').trim().toUpperCase();
  const wantedCurrency = String(expectedCurrency || '').trim().toUpperCase();
  if (!actualCurrency || actualCurrency !== wantedCurrency) {
    throw paymentOutcomeError('provider_currency_mismatch', {
      providerCurrency: actualCurrency || null,
      expectedCurrency: wantedCurrency || null,
    });
  }

  const actual = toMinorUnits(providerAmount);
  const content = toMinorUnits(contentAmount);
  const total = content == null ? null : content + (toMinorUnits(checkoutFee || 0) || 0);
  if (actual == null || content == null || (actual !== content && actual !== total)) {
    throw paymentOutcomeError('provider_amount_mismatch', {
      providerAmount,
      expectedContentAmount: contentAmount,
      expectedCustomerTotal: Number(contentAmount || 0) + Number(checkoutFee || 0),
    });
  }
}

async function notifySafely(client, paymentId, send) {
  await client.query('SAVEPOINT notify_sp');
  try {
    await send();
    await client.query('RELEASE SAVEPOINT notify_sp');
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT notify_sp').catch(() => {});
    log.error({ paymentId, err: e.message }, 'notify failed; payment still recorded');
  }
}

async function recordPaymentReversal(client, workspaceId, {
  paymentId = null,
  originalProviderTransactionId = null,
  providerTransactionId = null,
  kind,
  rawPayload = null,
}) {
  if (kind !== 'refund' && kind !== 'chargeback') {
    throw new Error(`recordPaymentReversal: unsupported kind "${kind}"`);
  }
  const p = (await client.query(
    `SELECT p.id, p.amount, p.currency, p.status, p.payment_link_id, p.account_id, p.agent_id,
            t.id AS sale_tx_id
       FROM payments p
       LEFT JOIN transactions t ON t.payment_id = p.id AND t.type = 'payment' AND t.status = 'approved'
      WHERE p.workspace_id = $1
        AND (($2::uuid IS NOT NULL AND p.id = $2::uuid)
          OR ($3::text IS NOT NULL AND t.provider_transaction_id = $3::text))
      FOR UPDATE OF p`,
    [workspaceId, paymentId, originalProviderTransactionId])).rows[0];
  if (!p) return { notFound: true };
  if (!p.sale_tx_id) return { noSale: true };

  const already = (await client.query(
    "SELECT entry_type FROM revenue_entries WHERE transaction_id=$1 AND entry_type IN ('refund','chargeback')",
    [p.sale_tx_id])).rows[0];
  if (already) return { already: already.entry_type, paymentId: p.id };

  const fn = kind === 'refund' ? 'fn_post_refund' : 'fn_post_chargeback';
  const status = kind === 'refund' ? 'refunded' : 'charged_back';
  const entry = (await client.query(`SELECT * FROM ${fn}($1)`, [p.sale_tx_id])).rows[0];
  await client.query(
    `INSERT INTO transactions
       (workspace_id, payment_id, type, status, gross, currency, provider_transaction_id, raw_payload, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
    [workspaceId, p.id, kind, status, p.amount, p.currency, providerTransactionId, rawPayload]);
  await client.query("UPDATE payments SET status = 'refunded' WHERE id = $1", [p.id]);
  if (p.payment_link_id) {
    await client.query("UPDATE payment_links SET status='refunded' WHERE id=$1 AND type='single_use'", [p.payment_link_id]);
  }
  await notifySafely(client, p.id, () => notifier.notify(client, workspaceId, {
    event: kind === 'refund' ? 'payment.refunded' : 'payment.chargeback',
    title: kind === 'refund' ? 'Refund recorded' : 'Chargeback recorded',
    accountId: p.account_id,
    agentId: p.agent_id,
    amount: Number(p.amount),
    currency: p.currency,
    entityType: 'payment',
    entityId: p.id,
  }));
  return { entry, amount: Number(p.amount), currency: p.currency, paymentId: p.id };
}

module.exports = { recordPaymentOutcome, recordPaymentReversal, validateProviderMoney };
