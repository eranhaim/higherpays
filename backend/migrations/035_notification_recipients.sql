-- ============================================================================
-- Migration 035: who a notification is for
--
-- notifications carried only workspace_id, so the feed was filtered by event
-- TYPE alone: every agent and every account received a live record of every
-- payment in the workspace, with the amount and the account's name.
--
-- The two columns mirror commission_entries(account_id, agent_membership_id) —
-- the same pair, the same names, because it is the same two parties.
--
-- Visibility rule, total and with no NULL ambiguity: a notification is visible
-- to a caller if ANY of these holds —
--   • the caller has workspace data scope (data.view_all)
--   • agent_membership_id  = the caller's membership
--   • account_id           = the caller's linked account
-- Both columns NULL therefore means "agency-wide only".
--
-- Existing rows are left NULL/NULL, so history becomes visible only to the
-- roles that run the workspace. Agents lose backlog rather than gain reach,
-- which is the safe direction.
-- ============================================================================

BEGIN;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS account_id          uuid REFERENCES accounts(id)    ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS agent_membership_id uuid REFERENCES memberships(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_account
  ON notifications(workspace_id, account_id, created_at DESC) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_agent
  ON notifications(workspace_id, agent_membership_id, created_at DESC) WHERE agent_membership_id IS NOT NULL;

COMMIT;
