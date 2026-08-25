-- ============================================================================
-- Migration 034: indexes for per-caller row scoping
--
-- Agents and accounts now read narrowed slices instead of whole tables, so the
-- narrowing columns need to be indexed. Each of these is filtered on every
-- request made by a low-privilege role.
--
-- account_agents needs nothing: idx_account_agents_member and the
-- UNIQUE (account_id, membership_id) already serve both directions of the
-- assignment lookup.
-- ============================================================================

BEGIN;

-- Sales credited to an agent: /me/earnings, analytics, the leaderboard.
CREATE INDEX IF NOT EXISTS idx_ce_agent ON commission_entries(agent_membership_id)
  WHERE agent_membership_id IS NOT NULL;

-- Links an agent created.
CREATE INDEX IF NOT EXISTS idx_links_created_by ON payment_links(created_by)
  WHERE created_by IS NOT NULL;

-- The payments feed keyset-paginates on (occurred_at DESC, id DESC) and now
-- also filters by the attributed agent, so the index has to carry both or the
-- filter forces a sort.
CREATE INDEX IF NOT EXISTS idx_txn_attributed
  ON transactions(attributed_membership_id, occurred_at DESC, id DESC)
  WHERE attributed_membership_id IS NOT NULL;

COMMIT;
