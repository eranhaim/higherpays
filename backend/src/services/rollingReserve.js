'use strict';
// The agency's own rolling reserve: an append-only ledger of one hold per sale
// (priced at the rate in force when the sale posted), releases, and the
// reversal of a refunded or charged-back sale's still-held part. Separate from
// the reserve MantaPay withholds (providerReserve.js).
//
// Holds and reversals are written by fn_hold_rolling_reserve and
// fn_reverse_rolling_reserve (migration 044) inside the sale posting.

const { toNumber, round2 } = require('../lib/money');

const SIGNED_AMOUNT = "CASE WHEN entry_type = 'hold' THEN amount ELSE -amount END";

// `from`/`to` bound the period; null leaves that side open. `held` is the
// balance at the period end, `currentHeld` the balance now (what a release can
// take), and `reserved`/`released`/`reversed` the movements inside the period.
async function getRollingReserve(db, workspaceId, currency, { from, to }) {
  const row = (await db.query(
    `SELECT w.rolling_reserve_enabled AS enabled, w.rolling_reserve_pct AS pct,
            COALESCE(SUM(${SIGNED_AMOUNT}) FILTER (WHERE e.created_at <= COALESCE($4::timestamptz, now())), 0) AS held,
            COALESCE(SUM(${SIGNED_AMOUNT}), 0) AS current_held,
            COALESCE(SUM(amount) FILTER (WHERE entry_type = 'hold' AND in_period), 0) AS reserved,
            COALESCE(SUM(amount) FILTER (WHERE entry_type = 'release' AND in_period), 0) AS released,
            COALESCE(SUM(amount) FILTER (WHERE entry_type = 'reversal' AND in_period), 0) AS reversed
       FROM workspaces w
       LEFT JOIN LATERAL (
         SELECT entry_type, amount, created_at,
                created_at >= COALESCE($3::timestamptz, '-infinity'::timestamptz)
                  AND created_at <= COALESCE($4::timestamptz, now()) AS in_period
           FROM rolling_reserve_entries
          WHERE workspace_id = w.id AND currency = $2
       ) e ON true
      WHERE w.id = $1
      GROUP BY w.id`,
    [workspaceId, currency, from || null, to || null])).rows[0];
  return {
    enabled: row.enabled,
    reservePct: toNumber(row.pct),
    held: Math.max(0, toNumber(row.held)),
    currentHeld: Math.max(0, toNumber(row.current_held)),
    reserved: toNumber(row.reserved),
    released: toNumber(row.released),
    reversed: toNumber(row.reversed),
    currency,
  };
}

// How the reserve moved the agency's revenue in a period: holds take money
// out, releases and reversals put it back.
function revenueAdjustment(reserve) {
  return round2(reserve.released + reserve.reversed - reserve.reserved);
}

// Releases `amount` (or the whole balance when null), oldest holds first, so a
// later refund can only reverse what is still held. Must run in a transaction:
// the workspace row lock serialises releases against each other and against
// new holds. Returns null when nothing is held.
async function releaseRollingReserve(c, workspaceId, { currency, amount, note, userId }) {
  await c.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
  const balances = (await c.query(
    `SELECT transaction_id, SUM(${SIGNED_AMOUNT}) AS available
       FROM rolling_reserve_entries
      WHERE workspace_id = $1 AND currency = $2
      GROUP BY transaction_id
     HAVING SUM(${SIGNED_AMOUNT}) > 0
      ORDER BY MIN(created_at), transaction_id`, [workspaceId, currency])).rows;
  const available = balances.reduce((sum, b) => sum + toNumber(b.available), 0);
  const total = round2(amount == null ? available : Math.min(amount, available));
  if (total <= 0) return null;

  const batchId = (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id;
  let remaining = total;
  for (const balance of balances) {
    if (remaining <= 0) break;
    const part = round2(Math.min(remaining, toNumber(balance.available)));
    await c.query(
      `INSERT INTO rolling_reserve_entries
         (workspace_id, transaction_id, entry_type, amount, currency, release_batch_id, note, created_by_user_id)
       VALUES ($1, $2, 'release', $3, $4, $5, $6, $7)`,
      [workspaceId, balance.transaction_id, part, currency, batchId, note, userId]);
    remaining = round2(remaining - part);
  }
  return { amount: total, currency, releaseBatchId: batchId };
}

module.exports = { getRollingReserve, revenueAdjustment, releaseRollingReserve };
