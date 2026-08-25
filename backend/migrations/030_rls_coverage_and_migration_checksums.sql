BEGIN;
-- 1) Two tenant tables were outside RLS. webhook_events carries full provider
--    payloads (customer PII); organizations is the billing parent of a
--    workspace. Both follow the migration-006 pattern: the platform context
--    sees everything, a workspace sees its own rows.
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webhook_events;
CREATE POLICY tenant_isolation ON webhook_events
  USING (is_platform_context() OR workspace_id = current_workspace_id())
  WITH CHECK (is_platform_context() OR workspace_id = current_workspace_id());

-- A signed-in user may read the organizations behind their own workspaces
-- (login lists them before a workspace is chosen); only the platform writes.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON organizations;
CREATE POLICY tenant_isolation ON organizations
  USING (is_platform_context()
         OR id = (SELECT organization_id FROM workspaces WHERE id = current_workspace_id())
         OR EXISTS (SELECT 1 FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
                     WHERE w.organization_id = organizations.id AND m.user_id = current_user_id()))
  WITH CHECK (is_platform_context());

-- 2) Migration bookkeeping records what was applied, not just that it was,
--    so an edited migration file is caught instead of silently diverging.
ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text;

COMMIT;
