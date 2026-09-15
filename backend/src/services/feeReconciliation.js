'use strict';

const { query, withTransaction } = require('../db');
const provider = require('../providers/mantapay');

const minor = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return Math.abs(n * 100 - cents) < 0.000001 ? cents : null;
};

async function reconcileWorkspaceFees(workspaceId, from, to) {
  const ws = (await query('SELECT * FROM workspaces WHERE id=$1', [workspaceId])).rows[0];
  if (!ws) return { error: 'not_found' };

  const result = await provider.search.searchTransactions({
    from,
    to,
    transType: provider.search.TRANS_TYPE.captured,
  });
  const transactions = result.transactions.filter((item) => item.transId && item.fees.total >= 0);
  if (!transactions.length) return { searched: result.count, matched: 0, updated: 0, skipped: [] };

  return withTransaction(async (client) => {
    const transIds = transactions.map((item) => item.transId);
    const orderIds = transactions.map((item) => item.orderId).filter(Boolean);
    const rows = (await client.query(
      `SELECT t.id, t.provider_transaction_id, t.gross, t.surcharge, t.currency,
              t.fee_is_estimate, pl.reference_id
         FROM transactions t
         JOIN payments p ON p.id=t.payment_id
         LEFT JOIN payment_links pl ON pl.id=p.payment_link_id
        WHERE t.workspace_id=$1 AND t.type='payment'
          AND (t.provider_transaction_id = ANY($2::text[])
            OR pl.reference_id = ANY($3::text[]))`,
      [workspaceId, transIds, orderIds],
    )).rows;

    const byTransaction = new Map(rows.map((row) => [`id:${row.provider_transaction_id}`, row]));
    const byOrder = new Map(rows.filter((row) => row.reference_id).map((row) => [`order:${row.reference_id}`, row]));
    const skipped = [];
    let updated = 0;

    for (const item of transactions) {
      const row = byTransaction.get(`id:${item.transId}`) || byOrder.get(`order:${item.orderId}`);
      if (!row) {
        skipped.push({ transId: item.transId, reason: 'not_matched' });
        continue;
      }
      if (String(row.currency).toUpperCase() !== String(item.currency || '').toUpperCase()) {
        skipped.push({ transId: item.transId, reason: 'currency_mismatch' });
        continue;
      }
      const providerAmount = minor(item.amount);
      const contentAmount = minor(row.gross);
      const customerTotal = contentAmount == null ? null : contentAmount + (minor(row.surcharge) || 0);
      if (providerAmount == null || (providerAmount !== contentAmount && providerAmount !== customerTotal)) {
        skipped.push({ transId: item.transId, reason: 'amount_mismatch' });
        continue;
      }
      if (!row.fee_is_estimate) continue;

      const fee = Number(item.fees.total);
      await client.query(
        `UPDATE transactions
            SET fee=$2, fee_is_estimate=false, net=gross-$2, raw_payload=COALESCE(raw_payload, '{}'::jsonb) || $3::jsonb
          WHERE id=$1 AND fee_is_estimate=true`,
        [row.id, fee, JSON.stringify({ searchFees: item.fees, searchDate: item.date })],
      );
      await client.query(
        `UPDATE revenue_entries SET psp_fee=$2
          WHERE transaction_id=$1 AND entry_type='sale'`,
        [row.id, fee],
      );
      updated++;
    }
    return { searched: result.count, matched: rows.length, updated, skipped };
  });
}

module.exports = { reconcileWorkspaceFees };
