BEGIN;

-- Agency-managed rolling reserves are separate from the reserve MantaPay
-- withholds under its settlement terms. Rates are snapshotted on each hold.
ALTER TABLE workspaces
  ADD COLUMN rolling_reserve_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN rolling_reserve_pct numeric(5,2) NOT NULL DEFAULT 0
    CHECK (rolling_reserve_pct >= 0 AND rolling_reserve_pct <= 100);

CREATE TABLE rolling_reserve_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  transaction_id uuid NOT NULL REFERENCES transactions(id),
  entry_type text NOT NULL CHECK (entry_type IN ('hold', 'release', 'reversal')),
  amount numeric(16,2) NOT NULL CHECK (amount > 0),
  rate_pct numeric(5,2) CHECK (rate_pct >= 0 AND rate_pct <= 100),
  currency char(3) NOT NULL,
  release_batch_id uuid,
  note text,
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((entry_type = 'release') = (release_batch_id IS NOT NULL)),
  CHECK ((entry_type = 'hold') = (rate_pct IS NOT NULL))
);

CREATE UNIQUE INDEX rolling_reserve_one_hold_per_transaction
  ON rolling_reserve_entries(transaction_id) WHERE entry_type = 'hold';
CREATE UNIQUE INDEX rolling_reserve_one_reversal_per_transaction
  ON rolling_reserve_entries(transaction_id) WHERE entry_type = 'reversal';
CREATE INDEX rolling_reserve_workspace_currency_date_idx
  ON rolling_reserve_entries(workspace_id, currency, created_at);
CREATE INDEX rolling_reserve_source_transaction_idx
  ON rolling_reserve_entries(transaction_id, entry_type);

-- Called in the same transaction as posting a new sale. The unique index and
-- ON CONFLICT make retries idempotent; updating attribution never reprices an
-- already captured reserve.
CREATE OR REPLACE FUNCTION fn_hold_rolling_reserve(tx uuid) RETURNS void AS $$
DECLARE
  sale transactions;
  reserve_pct numeric;
  gross numeric;
BEGIN
  SELECT t.* INTO sale FROM transactions t
   WHERE t.id = tx AND t.type = 'payment' AND t.status = 'approved';
  IF sale.id IS NULL THEN RETURN; END IF;

  SELECT w.rolling_reserve_pct INTO reserve_pct
    FROM workspaces w WHERE w.id = sale.workspace_id AND w.rolling_reserve_enabled
    FOR UPDATE;
  IF reserve_pct IS NULL OR reserve_pct <= 0 THEN RETURN; END IF;

  SELECT COALESCE(SUM(re.gross), 0) INTO gross
    FROM revenue_entries re WHERE re.transaction_id = tx AND re.entry_type = 'sale';
  IF gross <= 0 THEN RETURN; END IF;

  INSERT INTO rolling_reserve_entries(workspace_id, transaction_id, entry_type, amount, currency, rate_pct)
  VALUES (sale.workspace_id, tx, 'hold', round(gross * reserve_pct / 100, 2), sale.currency, reserve_pct)
  ON CONFLICT (transaction_id) WHERE entry_type = 'hold' DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- A refund or chargeback releases only the still-held part of its own reserve.
-- Any previously released portion remains reflected in the ordinary revenue
-- reversal, while this event prevents the held balance from remaining stale.
CREATE OR REPLACE FUNCTION fn_reverse_rolling_reserve(tx uuid) RETURNS void AS $$
DECLARE
  ws uuid;
  cur char(3);
  held numeric;
BEGIN
  SELECT workspace_id, currency INTO ws, cur
    FROM rolling_reserve_entries WHERE transaction_id = tx AND entry_type = 'hold';
  IF ws IS NULL THEN RETURN; END IF;
  PERFORM 1 FROM workspaces WHERE id = ws FOR UPDATE;

  SELECT COALESCE(SUM(CASE WHEN entry_type = 'hold' THEN amount ELSE -amount END), 0)
    INTO held FROM rolling_reserve_entries WHERE transaction_id = tx;
  IF held <= 0 THEN RETURN; END IF;

  INSERT INTO rolling_reserve_entries(workspace_id, transaction_id, entry_type, amount, currency)
  VALUES (ws, tx, 'reversal', held, cur)
  ON CONFLICT (transaction_id) WHERE entry_type = 'reversal' DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

GRANT SELECT, INSERT ON rolling_reserve_entries TO hp_app;
GRANT EXECUTE ON FUNCTION fn_hold_rolling_reserve(uuid), fn_reverse_rolling_reserve(uuid) TO hp_app;

COMMIT;
