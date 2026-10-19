CREATE TABLE legacy_import_exclusions (
  source_database text NOT NULL,
  source_workspace_id uuid NOT NULL,
  source_table text NOT NULL,
  source_id uuid NOT NULL,
  migration_key text NOT NULL REFERENCES legacy_import_runs(migration_key),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_database, source_workspace_id, source_table, source_id)
);

CREATE TABLE legacy_recovery_entities (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  migration_key text NOT NULL REFERENCES legacy_import_runs(migration_key),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity_type, reason)
);

GRANT SELECT, INSERT ON legacy_import_exclusions, legacy_recovery_entities TO hp_app;
