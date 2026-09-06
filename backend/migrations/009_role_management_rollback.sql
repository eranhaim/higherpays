-- Role management was moved off main after its migration reached production.
-- Restore the fixed role model that this branch's application code supports.

BEGIN;

UPDATE workspace_users
   SET role = CASE WHEN role = 'workspace_owner' THEN 'workspace_admin' ELSE 'analyst' END
 WHERE role NOT IN ('workspace_admin', 'analyst', 'agent', 'account_owner');

UPDATE invites
   SET role = CASE WHEN role = 'workspace_owner' THEN 'workspace_admin' ELSE 'analyst' END
 WHERE role NOT IN ('workspace_admin', 'analyst', 'agent', 'account_owner');

DROP INDEX IF EXISTS one_workspace_owner;
DROP TABLE IF EXISTS workspace_roles;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'workspace_users_role_check'
       AND conrelid = 'workspace_users'::regclass
  ) THEN
    ALTER TABLE workspace_users
      ADD CONSTRAINT workspace_users_role_check
      CHECK (role IN ('workspace_admin', 'analyst', 'agent', 'account_owner'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'invites_role_check'
       AND conrelid = 'invites'::regclass
  ) THEN
    ALTER TABLE invites
      ADD CONSTRAINT invites_role_check
      CHECK (role IN ('workspace_admin', 'analyst', 'agent', 'account_owner'));
  END IF;
END;
$$;

COMMIT;
