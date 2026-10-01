-- Tracks a reviewed recovery import without changing source records in place.
-- The import script is dry-run by default and writes these rows only inside
-- its one apply transaction.

CREATE TABLE IF NOT EXISTS legacy_import_runs (
  migration_key text PRIMARY KEY,
  source_database text NOT NULL,
  source_workspace_id uuid NOT NULL,
  target_workspace_id uuid NOT NULL REFERENCES workspaces(id),
  status text NOT NULL CHECK (status IN ('dry_run', 'committed', 'blocked', 'failed')),
  source_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz
);

CREATE TABLE IF NOT EXISTS legacy_entity_mappings (
  source_database text NOT NULL,
  source_workspace_id uuid NOT NULL,
  source_table text NOT NULL,
  source_id uuid NOT NULL,
  target_id uuid NOT NULL,
  migration_key text NOT NULL REFERENCES legacy_import_runs(migration_key),
  mapping_method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_database, source_workspace_id, source_table, source_id)
);

CREATE TABLE IF NOT EXISTS creator_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  source_database text NOT NULL,
  source_account_id uuid NOT NULL,
  source_name text NOT NULL,
  canonical_account_id uuid NOT NULL REFERENCES accounts(id),
  evidence text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_database, source_account_id),
  UNIQUE (workspace_id, source_name, canonical_account_id)
);

CREATE INDEX IF NOT EXISTS creator_aliases_workspace_canonical_idx
  ON creator_aliases (workspace_id, canonical_account_id);

GRANT SELECT, INSERT, UPDATE ON legacy_import_runs, legacy_entity_mappings, creator_aliases TO hp_app;
