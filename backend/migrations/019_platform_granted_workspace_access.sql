ALTER TABLE workspace_users
  ADD COLUMN platform_granted boolean NOT NULL DEFAULT false;

-- Existing rows may predate a platform-admin promotion, so their original
-- ownership cannot be inferred safely. Preserve them as ordinary seats.
-- Only missing seats are known to be platform-created and removable later.
INSERT INTO workspace_users (workspace_id, user_id, role, platform_granted)
SELECT w.id, u.id, 'workspace_admin', true
  FROM workspaces w
 CROSS JOIN users u
 WHERE u.is_platform_admin
ON CONFLICT (workspace_id, user_id) DO NOTHING;
