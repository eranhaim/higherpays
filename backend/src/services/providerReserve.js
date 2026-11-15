'use strict';
// The reserve MantaPay withholds under the agency's settlement terms. It is
// not the agency's own rolling reserve (rollingReserve.js).
//
// Imported settlement reports are the truth when the currency has any.
// Without them the reserve is estimated: the reserve rate on each sale's gross,
// net of its refund or chargeback.
//
// A release period of 0 days means MantaPay has no fixed schedule: the
// reserve stays held until a platform admin records a release.

const { toNumber, round2 } = require('../lib/money');

const RESERVE_SQL = `
  WITH source AS (
    SELECT CASE WHEN EXISTS (SELECT 1 FROM settlements WHERE workspace_id = $1 AND currency = $2)
                THEN 'settlements' ELSE 'estimated' END AS name
  ), holds AS (
    SELECT s.settlement_date AS held_on, s.reserve AS amount
      FROM settlements s, source
     WHERE source.name = 'settlements'
       AND s.workspace_id = $1 AND s.currency = $2 AND s.reserve > 0
    UNION ALL
    SELECT MIN(t.occurred_at)::date, SUM(re.gross) * $3::numeric / 100
      FROM revenue_entries re
      JOIN transactions t ON t.id = re.transaction_id
      JOIN payments p ON p.id = t.payment_id AND p.archived_at IS NULL
      CROSS JOIN source
     WHERE source.name = 'estimated'
       AND re.workspace_id = $1 AND t.currency = $2
     GROUP BY re.transaction_id
    HAVING SUM(re.gross) > 0
  )
  SELECT (SELECT name FROM source) AS source,
         COALESCE(SUM(amount) FILTER (
           WHERE $4::int = 0 OR held_on + $4::int > current_date), 0) AS held,
         COALESCE(SUM(amount) FILTER (
           WHERE $4::int > 0 AND held_on + $4::int > current_date
             AND held_on + $4::int <= current_date + 30), 0) AS releasing_soon,
         (SELECT COALESCE(SUM(amount), 0) FROM reserve_releases
           WHERE workspace_id = $1 AND currency = $2) AS released
    FROM holds`;

// The workspace's current position in one currency. `held` is net of the
// releases a platform admin recorded; `releasingSoon` is what the schedule
// releases in the next 30 days.
async function getProviderReserve(db, workspaceId, currency) {
  const terms = (await db.query(
    'SELECT reserve_pct, reserve_release_days FROM effective_settlement_fees($1, now())',
    [workspaceId])).rows[0];
  const pct = toNumber(terms?.reserve_pct);
  const releaseDays = toNumber(terms?.reserve_release_days);
  const row = (await db.query(RESERVE_SQL, [workspaceId, currency, pct, releaseDays])).rows[0];
  const released = toNumber(row.released);
  return {
    pct,
    releaseDays,
    held: round2(Math.max(0, toNumber(row.held) - released)),
    released: round2(released),
    releasingSoon: round2(toNumber(row.releasing_soon)),
    source: row.source,
    currency,
  };
}

module.exports = { getProviderReserve };
