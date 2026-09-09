BEGIN;

ALTER TABLE workspace_users
  DROP CONSTRAINT workspace_users_status_check;

ALTER TABLE workspace_users
  ADD CONSTRAINT workspace_users_status_check
  CHECK (status IN ('active', 'suspended', 'removed'));

COMMIT;
