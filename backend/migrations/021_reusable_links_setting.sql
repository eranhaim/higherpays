BEGIN;

ALTER TABLE workspaces
  ADD COLUMN reusable_links_enabled boolean NOT NULL DEFAULT true;

COMMIT;
