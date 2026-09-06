BEGIN;

-- Roles are now workspace data. Custom role keys cannot fit the old fixed
-- CHECK constraints, while creator and agent profile foreign keys still keep
-- their built-in role values.
ALTER TABLE workspace_users DROP CONSTRAINT IF EXISTS workspace_users_role_check;
ALTER TABLE invites DROP CONSTRAINT IF EXISTS invites_role_check;

CREATE TABLE IF NOT EXISTS workspace_roles (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key          text NOT NULL,
  name         text NOT NULL,
  permissions  text[] NOT NULL DEFAULT '{}',
  is_system    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);
CREATE INDEX IF NOT EXISTS idx_workspace_roles_workspace_id
  ON workspace_roles(workspace_id);
DROP TRIGGER IF EXISTS trg_workspace_roles_updated ON workspace_roles;
CREATE TRIGGER trg_workspace_roles_updated BEFORE UPDATE ON workspace_roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO workspace_roles (workspace_id, key, name, permissions, is_system)
SELECT w.id, r.key, r.name, r.permissions, true
  FROM workspaces w
 CROSS JOIN (VALUES
   ('workspace_owner', 'Owner', ARRAY[
     'payments.view','payments.complete','payments.export','links.view','links.create',
     'analytics.view','accounts.view','accounts.manage','agents.view','agents.manage',
     'customers.view','customers.manage','customers.export','revenue.view','revenue.manage',
     'fees.view','team.view','team.manage','roles.manage','settings.view','settings.edit',
     'data.view_all'
   ]::text[]),
   ('workspace_admin', 'Admin', ARRAY[
     'payments.view','payments.complete','payments.export','links.view','links.create',
     'analytics.view','accounts.view','accounts.manage','agents.view','agents.manage',
     'customers.view','customers.manage','customers.export','revenue.view','revenue.manage',
     'fees.view','team.view','team.manage','roles.manage','settings.view','settings.edit',
     'data.view_all'
   ]::text[]),
   ('analyst', 'Analyst', ARRAY[
     'payments.view','payments.export','links.view','analytics.view','accounts.view',
     'agents.view','customers.view','revenue.view','team.view','settings.view','data.view_all'
   ]::text[]),
   ('agent', 'Agent', ARRAY[
     'payments.view','payments.complete','links.view','links.create','analytics.view',
     'accounts.view','customers.view','customers.manage'
   ]::text[]),
   ('account_owner', 'Creator', ARRAY[
     'payments.view','links.view','analytics.view'
   ]::text[])
 ) AS r(key, name, permissions)
ON CONFLICT (workspace_id, key) DO NOTHING;

-- Existing agencies had one seeded non-platform admin. Make that person the
-- owner; platform admins remain admins above the workspace hierarchy.
WITH candidates AS (
  SELECT DISTINCT ON (wu.workspace_id) wu.workspace_id, wu.user_id
    FROM workspace_users wu
    JOIN users u ON u.id = wu.user_id
   WHERE wu.role = 'workspace_admin'
     AND wu.status = 'active'
     AND u.is_platform_admin = false
   ORDER BY wu.workspace_id, wu.created_at, wu.user_id
)
UPDATE workspace_users wu
   SET role = 'workspace_owner'
  FROM candidates c
 WHERE wu.workspace_id = c.workspace_id
   AND wu.user_id = c.user_id
   AND NOT EXISTS (
     SELECT 1
       FROM workspace_users existing_owner
      WHERE existing_owner.workspace_id = wu.workspace_id
        AND existing_owner.role = 'workspace_owner'
   );

CREATE UNIQUE INDEX IF NOT EXISTS one_workspace_owner
  ON workspace_users(workspace_id)
 WHERE role = 'workspace_owner';

COMMIT;
