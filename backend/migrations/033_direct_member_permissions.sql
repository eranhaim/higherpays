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

-- These three ownerless workspaces were reconciled with explicit customer
-- approval. UUIDs bind the assignment to the reviewed active membership, not
-- to a mutable display name or email address.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('5f099129-a37a-4fe6-9936-777345675565'::uuid, '0a5f041d-bfb8-4d90-adf1-9c5ae486b15e'::uuid),
        ('b69b68c5-e7af-4601-80ea-c6e201823bdd'::uuid, '7447d345-1c92-4d7d-a41c-105e101c2871'::uuid),
        ('42fee9ae-ffb0-4565-9084-1e1cc994fd1b'::uuid, 'f261057e-c86b-45ca-927c-eede06642668'::uuid)
      ) AS approved(workspace_id, user_id)
      LEFT JOIN workspace_users wu
        ON wu.workspace_id = approved.workspace_id AND wu.user_id = approved.user_id
      LEFT JOIN users u ON u.id = approved.user_id
     WHERE wu.user_id IS NULL
        OR wu.status <> 'active'
        OR u.status <> 'active'
        OR wu.role NOT IN ('workspace_admin', 'workspace_owner')
        OR EXISTS (
          SELECT 1 FROM agents a
           WHERE a.workspace_id = approved.workspace_id AND a.user_id = approved.user_id
        )
        OR EXISTS (
          SELECT 1 FROM accounts a
           WHERE a.workspace_id = approved.workspace_id AND a.user_id = approved.user_id
        )
  ) THEN
    RAISE EXCEPTION 'approved owner assignment no longer matches an active plain admin membership';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('5f099129-a37a-4fe6-9936-777345675565'::uuid, '0a5f041d-bfb8-4d90-adf1-9c5ae486b15e'::uuid),
        ('b69b68c5-e7af-4601-80ea-c6e201823bdd'::uuid, '7447d345-1c92-4d7d-a41c-105e101c2871'::uuid),
        ('42fee9ae-ffb0-4565-9084-1e1cc994fd1b'::uuid, 'f261057e-c86b-45ca-927c-eede06642668'::uuid)
      ) AS approved(workspace_id, user_id)
     WHERE EXISTS (
       SELECT 1 FROM workspace_users owner
        WHERE owner.workspace_id = approved.workspace_id
          AND owner.role = 'workspace_owner'
          AND owner.user_id <> approved.user_id
     )
  ) THEN
    RAISE EXCEPTION 'approved workspace already has a different owner';
  END IF;
END
$$;

WITH approved(workspace_id, user_id) AS (
  VALUES
    ('5f099129-a37a-4fe6-9936-777345675565'::uuid, '0a5f041d-bfb8-4d90-adf1-9c5ae486b15e'::uuid),
    ('b69b68c5-e7af-4601-80ea-c6e201823bdd'::uuid, '7447d345-1c92-4d7d-a41c-105e101c2871'::uuid),
    ('42fee9ae-ffb0-4565-9084-1e1cc994fd1b'::uuid, 'f261057e-c86b-45ca-927c-eede06642668'::uuid)
), assigned AS (
  UPDATE workspace_users wu
     SET role = 'workspace_owner'
    FROM approved
   WHERE wu.workspace_id = approved.workspace_id
     AND wu.user_id = approved.user_id
     AND NOT EXISTS (
       SELECT 1 FROM workspace_users owner
        WHERE owner.workspace_id = approved.workspace_id
          AND owner.role = 'workspace_owner'
     )
  RETURNING wu.workspace_id, wu.user_id
)
INSERT INTO audit_log (workspace_id, action, entity_type, entity_id, metadata)
SELECT assigned.workspace_id,
       'member.permissions.owner_assignment',
       'user',
       assigned.user_id,
       jsonb_build_object(
         'source', 'approved_production_owner_assignment',
         'workspaceId', assigned.workspace_id,
         'userId', assigned.user_id,
         'fromRole', 'workspace_admin',
         'toRole', 'workspace_owner'
       )
  FROM assigned;

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

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM workspaces w
     WHERE (SELECT count(*) FROM workspace_users wu
             WHERE wu.workspace_id = w.id AND wu.role = 'workspace_owner') <> 1
  ) THEN
    RAISE EXCEPTION 'workspace owner invariant failed after member permission migration';
  END IF;
END
$$;

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
