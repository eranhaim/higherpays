-- Multi-currency: an agency may transact in more than one currency.
--
-- workspaces.currency keeps its meaning and becomes the agency's BASE
-- currency: the default on a new link, the currency a salary is owed in, and
-- the currency a report falls back to. workspace_currencies is the set the
-- agency may price a link in.
--
-- Existing agencies keep working unchanged: their set starts as their base
-- currency, plus any other currency their links already use.
--
-- A link can only be priced in an allowed currency (composite foreign key, so
-- the pair also proves the currency belongs to the same workspace), and the
-- same key makes the database refuse to drop a currency a link still uses.
-- There are no per-currency fee or limit overrides: every currency inherits
-- the workspace rate card and link limits.

BEGIN;

CREATE TABLE workspace_currencies (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  currency     char(3) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, currency),
  CONSTRAINT workspace_currencies_code_check CHECK (currency ~ '^[A-Z]{3}$')
);

UPDATE payment_links SET currency = upper(currency) WHERE currency <> upper(currency);
UPDATE payments      SET currency = upper(currency) WHERE currency <> upper(currency);
UPDATE transactions  SET currency = upper(currency) WHERE currency <> upper(currency);
UPDATE workspaces    SET currency = upper(currency) WHERE currency <> upper(currency);

INSERT INTO workspace_currencies (workspace_id, currency)
SELECT id, currency FROM workspaces;

INSERT INTO workspace_currencies (workspace_id, currency)
SELECT DISTINCT workspace_id, currency FROM payment_links
ON CONFLICT (workspace_id, currency) DO NOTHING;

-- The base currency is always allowed. A trigger keeps that true for every way
-- a workspace is created or re-denominated, so no insert path can forget it.
CREATE OR REPLACE FUNCTION fn_workspace_base_currency_allowed() RETURNS trigger AS $$
BEGIN
  INSERT INTO workspace_currencies (workspace_id, currency)
  VALUES (NEW.id, NEW.currency)
  ON CONFLICT (workspace_id, currency) DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workspaces_base_currency_allowed
  AFTER INSERT OR UPDATE OF currency ON workspaces
  FOR EACH ROW EXECUTE FUNCTION fn_workspace_base_currency_allowed();

ALTER TABLE payment_links
  ADD CONSTRAINT payment_links_workspace_currency_fkey
  FOREIGN KEY (workspace_id, currency)
  REFERENCES workspace_currencies(workspace_id, currency);

-- customers.total_spend was one cached number per customer, summed over every
-- payment regardless of currency. For a customer who paid in two currencies it
-- is true in neither. Spend is now computed per currency where it is read, so
-- the column goes. Nothing is lost: it is derivable from `payments`.
ALTER TABLE customers DROP COLUMN IF EXISTS total_spend;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_currencies TO hp_app;
  END IF;
END;
$$;

COMMIT;
