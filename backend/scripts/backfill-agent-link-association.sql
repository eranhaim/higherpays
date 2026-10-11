-- Backfill the agent association on links created by an agent who also holds
-- data.view_all, while the creation path read the owning agent out of the
-- caller's data scope instead of their agent profile. Such a seat resolves to
-- a workspace scope, so the link was stored with created_by_agent_id = NULL and
-- fell out of the agent's own list.
--
-- The code fix is in backend/src/auth/callerAgent.js; this repairs the rows
-- already written. Safe to run more than once.
--
-- DRY RUN BY DEFAULT. The last line is ROLLBACK — change it to COMMIT to apply.
--
--   docker exec -i higherpays-pg psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -v ON_ERROR_STOP=1 -f - < backfill-agent-link-association.sql

\set ON_ERROR_STOP on
\pset pager off

BEGIN;

-- This runs against a live payments database. Rather than queue behind a
-- payment webhook holding one of these links, give up and leave it alone.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- The links to repair: created through POST /links by a user who owns an agent
-- profile in that workspace, but stored with no agent. The audit log is the
-- only record of who created a link, so it is the join key.
CREATE TEMP TABLE orphaned_links ON COMMIT DROP AS
SELECT pl.id AS link_id, a.id AS agent_id, u.email, pl.created_at
  FROM payment_links pl
  JOIN audit_log al ON al.entity_id = pl.id AND al.action = 'link.create'
  JOIN users u ON u.id = al.actor_user_id
  JOIN agents a ON a.user_id = al.actor_user_id AND a.workspace_id = pl.workspace_id
 WHERE pl.created_by_agent_id IS NULL;

\echo '=== Links to be re-associated, per agent ==='
SELECT email, count(*) AS links, min(created_at) AS first, max(created_at) AS last
  FROM orphaned_links GROUP BY email ORDER BY links DESC;

-- Money check. A link carries no ledger value itself; the ledger follows
-- payments.agent_id, which this script does not touch. Anything other than
-- zero here means a sale is already posted against one of these links and the
-- re-association would disagree with the ledger — stop and escalate.
\echo '=== Posted sales on these links (expected: agent_amount only where the payment already names an agent) ==='
SELECT count(*) AS sale_entries,
       count(*) FILTER (WHERE re.agent_id IS NULL) AS sales_without_agent,
       count(*) FILTER (WHERE re.agent_payout_id IS NOT NULL) AS already_paid_out,
       COALESCE(sum(re.agent_amount), 0) AS agent_amount
  FROM orphaned_links o
  JOIN payments p ON p.payment_link_id = o.link_id AND p.archived_at IS NULL
  JOIN transactions t ON t.payment_id = p.id AND t.type = 'payment'
  JOIN revenue_entries re ON re.transaction_id = t.id AND re.entry_type = 'sale';

UPDATE payment_links pl
   SET created_by_agent_id = o.agent_id
  FROM orphaned_links o
 WHERE pl.id = o.link_id;

\echo '=== Remaining orphans for these agents after the update (expected: 0) ==='
SELECT count(*) AS still_orphaned
  FROM payment_links pl
  JOIN orphaned_links o ON o.link_id = pl.id
 WHERE pl.created_by_agent_id IS NULL;

-- Change to COMMIT to apply.
ROLLBACK;
