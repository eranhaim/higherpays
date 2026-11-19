'use strict';
// The reserve MantaPay withholds under the agency's settlement terms. It is
// not the agency's own rolling reserve (rollingReserve.js).
//
// Imported settlement reports are the truth when the currency has any.
// Without them the reserve is estimated per sale by fn_provider_reserve_by_sale
// (migration 048), which also explains the 0-day release period.

const { toNumber, round2 } = require('../lib/money');

const RESERVE_SQL = `
  WITH source AS (
    SELECT CASE WHEN EXISTS (SELECT 1 FROM settlements WHERE workspace_id = $1 AND currency = $2)
                THEN 'settlements' ELSE 'estimated' END AS name
  ), settled AS (
    SELECT s.settlement_date AS held_on, s.reserve AS held
      FROM settlements s
     WHERE s.workspace_id = $1 AND s.currency = $2 AND s.reserve > 0
       AND ($3::int = 0 OR s.settlement_date + $3::int > current_date)
  ), holds AS (
    SELECT held_on, held FROM settled, source WHERE source.name = 'settlements'
    UNION ALL
    SELECT held_on, held FROM fn_provider_reserve_by_sale($1, $2), source WHERE source.name = 'estimated'
  )
  SELECT (SELECT name FROM source) AS source,
         COALESCE(SUM(held), 0) AS held,
         COALESCE(SUM(held) FILTER (
           WHERE $3::int > 0 AND held_on + $3::int <= current_date + 30), 0) AS releasing_soon,
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
  const row = (await db.query(RESERVE_SQL, [workspaceId, currency, releaseDays])).rows[0];
  const released = toNumber(row.released);
  // Settlement reports state what was withheld, not what a release took back.
  const held = row.source === 'settlements' ? toNumber(row.held) - released : toNumber(row.held);
  return {
    pct,
    releaseDays,
    held: round2(Math.max(0, held)),
    released: round2(released),
    releasingSoon: round2(toNumber(row.releasing_soon)),
    source: row.source,
    currency,
  };
}

module.exports = { getProviderReserve };
