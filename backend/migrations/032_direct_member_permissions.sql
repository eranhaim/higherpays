BEGIN;

ALTER TABLE workspace_users
  ADD COLUMN IF NOT EXISTS permissions text[] NOT NULL DEFAULT '{}';

ALTER TABLE invites
  ADD COLUMN IF NOT EXISTS permissions text[] NOT NULL DEFAULT '{}';

-- A workspace may already have a custom role named Member. Retire that name
-- before installing the fixed membership type, while preserving its snapshot.
UPDATE workspace_roles
   SET name = left('Retired ' || key, 80)
 WHERE key <> 'member'
   AND lower(name) = 'member';

INSERT INTO workspace_roles (workspace_id, key, name, permissions, is_system)
SELECT w.id,
       'member',
       'Member',
       COALESCE(analyst.permissions, ARRAY[
         'payments.view','payments.export','links.view','analytics.view',
         'accounts.view','agents.view','customers.view','revenue.view',
         'team.view','settings.view','data.view_all'
       ]::text[]),
       true
  FROM workspaces w
  LEFT JOIN workspace_roles analyst
    ON analyst.workspace_id = w.id AND analyst.key = 'analyst'
ON CONFLICT (workspace_id, key) DO UPDATE
  SET name = EXCLUDED.name, is_system = true;

-- Copy the exact effective legacy role permissions before roles are retired.
UPDATE workspace_users wu
   SET permissions = wr.permissions
  FROM workspace_roles wr
 WHERE wr.workspace_id = wu.workspace_id
   AND wr.key = wu.role;

UPDATE invites i
   SET permissions = wr.permissions
  FROM workspace_roles wr
 WHERE wr.workspace_id = i.workspace_id
   AND wr.key = i.role;

-- Keep a durable audit record of every retired custom-role mapping. Individual
-- seats already hold the immutable permission snapshot copied above.
INSERT INTO audit_log (workspace_id, action, entity_type, metadata)
SELECT wr.workspace_id,
       'member.permissions.custom_role_retired',
       'workspace_role',
       jsonb_build_object(
         'key', wr.key,
         'name', wr.name,
         'permissions', to_jsonb(wr.permissions),
         'memberCount', (
           SELECT count(*) FROM workspace_users wu
            WHERE wu.workspace_id = wr.workspace_id AND wu.role = wr.key
         ),
         'pendingInviteCount', (
           SELECT count(*) FROM invites i
            WHERE i.workspace_id = wr.workspace_id
              AND i.role = wr.key
              AND i.accepted_at IS NULL
         )
       )
  FROM workspace_roles wr
 WHERE wr.key NOT IN ('workspace_owner', 'workspace_admin', 'analyst', 'member', 'agent', 'account_owner');

-- Profile-backed people keep their structural type. Their copied permissions
-- preserve any former administrator or custom-role access explicitly.
UPDATE workspace_users wu
   SET role = CASE
     WHEN EXISTS (
       SELECT 1 FROM agents ag
        WHERE ag.workspace_id = wu.workspace_id AND ag.user_id = wu.user_id
     ) THEN 'agent'
     WHEN EXISTS (
       SELECT 1 FROM accounts ac
        WHERE ac.workspace_id = wu.workspace_id AND ac.user_id = wu.user_id
     ) THEN 'account_owner'
     WHEN wu.role IN ('workspace_owner', 'workspace_admin') THEN wu.role
     ELSE 'member'
   END;

UPDATE invites
   SET role = CASE
     WHEN role IN ('workspace_owner', 'workspace_admin', 'agent', 'account_owner') THEN role
     ELSE 'member'
   END;

DELETE FROM workspace_roles
 WHERE key NOT IN ('workspace_owner', 'workspace_admin', 'member', 'agent', 'account_owner');

INSERT INTO audit_log (workspace_id, action, entity_type, metadata)
SELECT w.id,
       'member.permissions.backfill',
       'workspace',
       jsonb_build_object(
         'seatCount', (SELECT count(*) FROM workspace_users wu WHERE wu.workspace_id = w.id),
         'pendingInviteCount', (
           SELECT count(*) FROM invites i
            WHERE i.workspace_id = w.id AND i.accepted_at IS NULL
         )
       )
  FROM workspaces w;

COMMIT;
