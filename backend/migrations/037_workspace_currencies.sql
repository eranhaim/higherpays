-- Multi-currency: an agency may now transact in more than one currency.
--
-- workspaces.currency keeps its meaning and becomes the agency's BASE
-- currency: the default on a new link, the currency a salary is owed in, and
-- the currency a report falls back to. workspace_currencies is the set the
-- agency may transact in at all.
--
-- Amounts here are per-currency because a flat amount does not survive
-- translation: a EUR 2.00 checkout fee is not a sane fee in ILS. NULL means
-- "inherit": the rate card's checkout_fee, or the workspace's link limits.
-- The base row is created NULL on purpose, so behaviour for every existing
-- agency is unchanged. A row for any other currency is created with an
-- explicit fee, so a base-currency amount can never leak into a second
-- currency.
--
-- No existing money row is relabelled. Every payment_link, payment,
-- transaction, payout and settlement already carries its own currency, so the
-- enabled set is derived from what those rows actually say, unioned with the
-- workspace's base currency.

BEGIN;

CREATE TABLE workspace_currencies (
  workspace_id    uuid NOT NULL REFERENCES workspaces(id),
  currency        char(3) NOT NULL,
  checkout_fee    numeric(14,2),
  min_link_amount numeric(14,2),
  max_link_amount numeric(14,2),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, currency),
  CONSTRAINT workspace_currencies_code_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT workspace_currencies_checkout_fee_check
    CHECK (checkout_fee IS NULL OR checkout_fee >= 0),
  CONSTRAINT workspace_currencies_amount_range_check
    CHECK (min_link_amount IS NULL OR max_link_amount IS NULL
           OR min_link_amount <= max_link_amount)
);

-- Case was never normalised on the way in. Do it before the immutability
-- triggers below exist, and before the foreign keys that compare these values.
UPDATE payment_links SET currency = upper(currency) WHERE currency <> upper(currency);
UPDATE payments      SET currency = upper(currency) WHERE currency <> upper(currency);
UPDATE transactions  SET currency = upper(currency) WHERE currency <> upper(currency);
UPDATE payouts       SET currency = upper(currency) WHERE currency <> upper(currency);
UPDATE settlements   SET currency = upper(currency) WHERE currency <> upper(currency);
UPDATE workspaces    SET currency = upper(currency) WHERE currency <> upper(currency);

-- 1) The base currency, inheriting every amount it inherits today.
INSERT INTO workspace_currencies (workspace_id, currency)
SELECT id, currency FROM workspaces;

-- 2) Any other currency this agency has actually transacted in. A workspace
--    cannot change its base currency once money exists, so in practice this
--    finds nothing; it is here so the foreign keys below cannot fail on a
--    history we did not predict, and such a row gets a zero fee rather than
--    the base currency's.
INSERT INTO workspace_currencies (workspace_id, currency, checkout_fee)
SELECT DISTINCT workspace_id, currency, 0 FROM (
  SELECT workspace_id, currency FROM payment_links
  UNION SELECT workspace_id, currency FROM payments
  UNION SELECT workspace_id, currency FROM transactions
  UNION SELECT workspace_id, currency FROM payouts
  UNION SELECT workspace_id, currency FROM settlements
) observed
WHERE workspace_id IS NOT NULL
ON CONFLICT (workspace_id, currency) DO NOTHING;

-- A link or payment can only exist in a currency the agency is enabled for,
-- and the pair proves same-workspace, so a currency cannot be borrowed from
-- another agency.
ALTER TABLE payment_links
  ADD CONSTRAINT payment_links_workspace_currency_fkey
  FOREIGN KEY (workspace_id, currency)
  REFERENCES workspace_currencies(workspace_id, currency);

ALTER TABLE payments
  ADD CONSTRAINT payments_workspace_currency_fkey
  FOREIGN KEY (workspace_id, currency)
  REFERENCES workspace_currencies(workspace_id, currency);

-- Currency is immutable. Re-denominating a row that money has already moved
-- on would silently rewrite history: the ledger entries, the payout it was
-- settled in and the provider's own record would all still be in the old one.
CREATE OR REPLACE FUNCTION fn_currency_is_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'currency_immutable: %.% cannot change from % to %',
      TG_TABLE_NAME, OLD.id, OLD.currency, NEW.currency;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_links_currency_immutable
  BEFORE UPDATE OF currency ON payment_links
  FOR EACH ROW EXECUTE FUNCTION fn_currency_is_immutable();

CREATE TRIGGER payments_currency_immutable
  BEFORE UPDATE OF currency ON payments
  FOR EACH ROW EXECUTE FUNCTION fn_currency_is_immutable();

CREATE TRIGGER transactions_currency_immutable
  BEFORE UPDATE OF currency ON transactions
  FOR EACH ROW EXECUTE FUNCTION fn_currency_is_immutable();

-- customers.total_spend was one cached number per fan, summed over every
-- payment regardless of currency. For a fan who paid in two currencies that
-- number is true in neither. Spend is now computed per currency where it is
-- read, so the column goes rather than being left to drift.
--
-- Nothing is lost: it was always derivable from `payments`.
--
-- IF EXISTS because `entities.js` no longer declares the column, so a reset
-- that regenerates 001_init.sql from it creates a `customers` without one.
ALTER TABLE customers DROP COLUMN IF EXISTS total_spend;

-- Default privileges cover this already when the migration runs as the owner;
-- an explicit grant keeps the restricted role working if it did not.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_currencies TO hp_app;
    GRANT EXECUTE ON FUNCTION fn_currency_is_immutable() TO hp_app;
  END IF;
END;
$$;

COMMIT;
