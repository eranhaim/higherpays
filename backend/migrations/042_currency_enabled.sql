-- A currency can be switched off for new links without deleting it. Before this,
-- a currency that any link had ever used could not be removed (the foreign key
-- on payment_links), so an agency could not stop offering GBP once one GBP link
-- existed. Rows stay, so history and reports keep working; `enabled` decides
-- only whether a NEW link may be priced in it.
BEGIN;

ALTER TABLE workspace_currencies
  ADD COLUMN enabled boolean NOT NULL DEFAULT true;

COMMIT;
