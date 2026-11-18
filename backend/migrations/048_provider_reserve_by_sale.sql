BEGIN;

-- The reserve MantaPay still holds on each sale, estimated from the reserve
-- rate in force: the rate on the sale's gross net of its refund or chargeback.
-- A release period of 0 days means no fixed schedule: held until a platform
-- admin records a release. Recorded releases take the oldest sales first, so
-- the sum over every sale is the workspace's held reserve and a filtered view
-- (one creator, one date range) can subtract only its own sales' part.
CREATE OR REPLACE FUNCTION fn_provider_reserve_by_sale(ws uuid, cur char(3))
RETURNS TABLE (payment_id uuid, transaction_id uuid, held_on date, held numeric) AS $$
  WITH terms AS (
    SELECT COALESCE(f.reserve_pct, 0) AS pct, COALESCE(f.reserve_release_days, 0) AS days
      FROM effective_settlement_fees(ws, now()) f
  ), sales AS (
    SELECT t.payment_id, re.transaction_id, MIN(t.occurred_at)::date AS held_on,
           SUM(re.gross) * terms.pct / 100 AS amount
      FROM revenue_entries re
      JOIN transactions t ON t.id = re.transaction_id
      JOIN payments p ON p.id = t.payment_id AND p.archived_at IS NULL
      CROSS JOIN terms
     WHERE re.workspace_id = ws AND t.currency = cur
     GROUP BY t.payment_id, re.transaction_id, terms.pct
    HAVING SUM(re.gross) > 0
  ), scheduled AS (
    SELECT s.* FROM sales s, terms
     WHERE terms.days = 0 OR s.held_on + terms.days > current_date
  ), released AS (
    SELECT COALESCE(SUM(amount), 0) AS total
      FROM reserve_releases WHERE workspace_id = ws AND currency = cur
  )
  SELECT s.payment_id, s.transaction_id, s.held_on,
         GREATEST(0, LEAST(s.amount, SUM(s.amount) OVER oldest_first - released.total)) AS held
    FROM scheduled s, released
  WINDOW oldest_first AS (ORDER BY s.held_on, s.transaction_id)
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION fn_provider_reserve_by_sale(uuid, char) TO hp_app;

COMMIT;
