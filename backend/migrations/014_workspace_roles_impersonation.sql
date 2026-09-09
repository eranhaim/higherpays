BEGIN;

ALTER TABLE workspace_users DROP CONSTRAINT IF EXISTS workspace_users_role_check;
ALTER TABLE invites DROP CONSTRAINT IF EXISTS invites_role_check;

CREATE TABLE workspace_roles (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}',
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key),
  UNIQUE (workspace_id, name),
  CHECK (key ~ '^[a-z][a-z0-9_]{2,63}$'),
  CHECK (length(trim(name)) BETWEEN 1 AND 80)
);

CREATE TRIGGER trg_workspace_roles_updated
  BEFORE UPDATE ON workspace_roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO workspace_roles (workspace_id, key, name, permissions, is_system)
SELECT w.id, role.key, role.name, role.permissions, true
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
 ) AS role(key, name, permissions);

WITH owner_candidates AS (
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
  FROM owner_candidates candidate
 WHERE wu.workspace_id = candidate.workspace_id
   AND wu.user_id = candidate.user_id;

WITH pending_owner_invites AS (
  SELECT DISTINCT ON (i.workspace_id) i.id
    FROM invites i
   WHERE i.role = 'workspace_admin'
     AND i.accepted_at IS NULL
     AND i.expires_at > now()
     AND NOT EXISTS (
       SELECT 1 FROM workspace_users wu
        WHERE wu.workspace_id = i.workspace_id
          AND wu.role = 'workspace_owner'
     )
   ORDER BY i.workspace_id, i.created_at
)
UPDATE invites i
   SET role = 'workspace_owner'
  FROM pending_owner_invites candidate
 WHERE i.id = candidate.id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM workspaces w
     WHERE NOT EXISTS (
       SELECT 1 FROM workspace_users wu
        WHERE wu.workspace_id = w.id
          AND wu.role = 'workspace_owner'
     )
       AND NOT EXISTS (
         SELECT 1 FROM invites i
          WHERE i.workspace_id = w.id
            AND i.role = 'workspace_owner'
            AND i.accepted_at IS NULL
            AND i.expires_at > now()
       )
  ) THEN
    RAISE EXCEPTION 'workspace without owner or unexpired pending owner invite';
  END IF;
END
$$;

CREATE UNIQUE INDEX one_workspace_owner
  ON workspace_users(workspace_id)
  WHERE role = 'workspace_owner';

ALTER TABLE workspace_users
  ADD CONSTRAINT workspace_users_workspace_role_fkey
  FOREIGN KEY (workspace_id, role)
  REFERENCES workspace_roles(workspace_id, key)
  ON DELETE RESTRICT;

ALTER TABLE invites
  ADD CONSTRAINT invites_workspace_role_fkey
  FOREIGN KEY (workspace_id, role)
  REFERENCES workspace_roles(workspace_id, key)
  ON DELETE RESTRICT;

ALTER TABLE audit_log
  ADD COLUMN effective_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_audit_log_effective_user_id_created_at
  ON audit_log(effective_user_id, created_at);

COMMIT;
