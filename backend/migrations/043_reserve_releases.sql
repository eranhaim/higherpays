-- Platform admin can record that the provider released held reserve funds.
-- The breakdown query subtracts released amounts from the computed reserve.

CREATE TABLE IF NOT EXISTS reserve_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  amount numeric(16, 4) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  note text,
  released_by_user_id uuid NOT NULL REFERENCES users(id),
  released_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reserve_releases_workspace_idx
  ON reserve_releases (workspace_id, currency);

GRANT SELECT, INSERT ON reserve_releases TO hp_app;
