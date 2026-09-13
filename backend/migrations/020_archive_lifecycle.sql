BEGIN;

ALTER TABLE customers
  ADD COLUMN archived_at timestamptz;

ALTER TABLE payments
  ADD COLUMN archived_at timestamptz;

CREATE INDEX idx_customers_workspace_archived_at
  ON customers(workspace_id, archived_at);

CREATE INDEX idx_payments_workspace_archived_at
  ON payments(workspace_id, archived_at);

UPDATE workspace_roles
   SET permissions = array_append(permissions, 'archive.manage')
 WHERE key IN ('workspace_owner', 'workspace_admin')
   AND NOT ('archive.manage' = ANY(permissions));

COMMIT;
