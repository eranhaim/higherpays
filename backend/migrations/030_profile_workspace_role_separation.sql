-- A business profile (agent or creator) must stay attached to its workspace,
-- but its sign-in permission role may be upgraded without changing financial
-- attribution or profile history.
DO $$
DECLARE
  constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conrelid::regclass AS table_name, conname
      FROM pg_constraint
     WHERE contype = 'f'
       AND confrelid = 'workspace_users'::regclass
       AND conrelid IN ('accounts'::regclass, 'agents'::regclass)
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',
      constraint_row.table_name, constraint_row.conname);
  END LOOP;
END
$$;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_workspace_user_fkey
  FOREIGN KEY (workspace_id, user_id)
  REFERENCES workspace_users(workspace_id, user_id)
  ON DELETE RESTRICT;

ALTER TABLE agents
  ADD CONSTRAINT agents_workspace_user_fkey
  FOREIGN KEY (workspace_id, user_id)
  REFERENCES workspace_users(workspace_id, user_id)
  ON DELETE RESTRICT;
