BEGIN;

-- MARKETPLACE_WORKSPACE_ID is an environment value, and nothing stopped it
-- naming a live agency: the marketplace's carts would then be booked as that
-- agency's revenue, splits and payouts. Which workspace holds marketplace
-- carts is therefore recorded in the database, by a deliberate one-off
-- statement, and the integration refuses every workspace that is not it.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS is_marketplace boolean NOT NULL DEFAULT false;

-- At most one workspace can be the marketplace's.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_is_marketplace
  ON workspaces(is_marketplace) WHERE is_marketplace;

COMMIT;
