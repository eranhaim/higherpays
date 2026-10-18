-- Custom roles come back as named permission sets (workspace_roles rows with
-- is_system = false). A seat links to one through custom_role_key; the seat's
-- own permissions array stays what every request reads, so the permission check
-- is unchanged. The composite key proves the role belongs to the same
-- workspace. A NULL key (the existing seats) skips the check.
BEGIN;

ALTER TABLE workspace_users
  ADD COLUMN custom_role_key text;

ALTER TABLE workspace_users
  ADD CONSTRAINT workspace_users_custom_role_fkey
  FOREIGN KEY (workspace_id, custom_role_key)
  REFERENCES workspace_roles (workspace_id, key);

COMMIT;
