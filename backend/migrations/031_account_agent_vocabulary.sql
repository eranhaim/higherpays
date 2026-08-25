-- ============================================================================
-- Migration 031: entity vocabulary — creator becomes account, chatter becomes agent
--
-- Aligns the schema with "HigherPays — Entity Definitions.md", which defines
-- Super Admin -> Workspace Owner -> Account -> Agent and states that the
-- Account replaces the concept of Creator. The `manager` role has no
-- counterpart in that model and is removed; its members become `admin`.
--
-- Renames only: ALTER ... RENAME keeps the table OID, so foreign keys, indexes,
-- triggers, grants, RLS policies and CHECK expressions all follow automatically
-- (Postgres stores those parsed by OID + attribute number, not as text). No data
-- is moved and no money table is rewritten.
--
-- The migration runner wraps this file in a single transaction, so either the
-- whole vocabulary changes or none of it does.
--
-- NOT rewritten, deliberately: audit_log.action ('creator.create', ...),
-- audit_log.entity_type and the free text in notifications.body. Those are an
-- append-only record of what happened under the vocabulary in force at the
-- time; rewriting history is worse than a vocabulary split at the cutover date.
-- Nothing queries those values. New writes use the account/agent wording.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Abort early on a custom role that would collide with a renamed one.
--    roles is UNIQUE (workspace_id, name) and an owner may create a custom role
--    with any name, so `chatter` -> `agent` can hit an existing `agent`. Fail
--    loudly with the offending rows rather than deleting someone's custom role.
-- ---------------------------------------------------------------------------
DO $$
DECLARE conflicts text;
BEGIN
  SELECT string_agg(format('%s/%s', workspace_id, name), ', ')
    INTO conflicts
    FROM roles
   WHERE NOT is_system
     AND name IN ('account', 'agent')
     AND EXISTS (
       SELECT 1 FROM roles sys
        WHERE sys.workspace_id = roles.workspace_id
          AND sys.is_system
          AND sys.name = CASE roles.name WHEN 'account' THEN 'creator' ELSE 'chatter' END);
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'custom roles collide with the renamed system roles: %. Rename them before migrating.', conflicts;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
ALTER TABLE creators            RENAME TO accounts;
ALTER TABLE creator_compliance  RENAME TO account_compliance;
ALTER TABLE creator_assignments RENAME TO account_agents;

-- ---------------------------------------------------------------------------
-- 2. Columns
--    account_agents.membership_id keeps its name: it is a plain membership FK.
--    The agent_ prefix on commission_entries exists only to tell it apart from
--    account_id in the same row.
-- ---------------------------------------------------------------------------
ALTER TABLE account_compliance  RENAME COLUMN creator_id TO account_id;
ALTER TABLE account_agents      RENAME COLUMN creator_id TO account_id;
ALTER TABLE customers           RENAME COLUMN creator_id TO account_id;
ALTER TABLE content_items       RENAME COLUMN creator_id TO account_id;
ALTER TABLE payment_links       RENAME COLUMN creator_id TO account_id;
ALTER TABLE transactions        RENAME COLUMN creator_id TO account_id;
ALTER TABLE payouts             RENAME COLUMN creator_id TO account_id;
ALTER TABLE invites             RENAME COLUMN creator_id TO account_id;

ALTER TABLE commission_rules    RENAME COLUMN creator_id        TO account_id;
ALTER TABLE commission_rules    RENAME COLUMN creator_split_pct TO account_split_pct;
ALTER TABLE commission_rules    RENAME COLUMN chatter_pct       TO agent_pct;

ALTER TABLE commission_entries  RENAME COLUMN creator_id            TO account_id;
ALTER TABLE commission_entries  RENAME COLUMN chatter_membership_id TO agent_membership_id;
ALTER TABLE commission_entries  RENAME COLUMN creator_amount        TO account_amount;
ALTER TABLE commission_entries  RENAME COLUMN chatter_amount        TO agent_amount;
ALTER TABLE commission_entries  RENAME COLUMN creator_payout_id     TO account_payout_id;
ALTER TABLE commission_entries  RENAME COLUMN chatter_payout_id     TO agent_payout_id;
ALTER TABLE commission_entries  RENAME COLUMN creator_paid_at       TO account_paid_at;
ALTER TABLE commission_entries  RENAME COLUMN chatter_paid_at       TO agent_paid_at;

-- ---------------------------------------------------------------------------
-- 3. Types
-- ---------------------------------------------------------------------------
ALTER TYPE creator_status        RENAME TO account_status;
ALTER TYPE creator_revenue_model RENAME TO account_revenue_model;

-- ---------------------------------------------------------------------------
-- 4. Constraint names (the objects follow the OID; only the names are stale).
--    Renaming a UNIQUE/PK constraint renames its backing index too.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts RENAME CONSTRAINT creators_pkey                    TO accounts_pkey;
ALTER TABLE accounts RENAME CONSTRAINT creators_workspace_id_fkey       TO accounts_workspace_id_fkey;
ALTER TABLE accounts RENAME CONSTRAINT creators_user_id_fkey            TO accounts_user_id_fkey;
ALTER TABLE accounts RENAME CONSTRAINT creators_revenue_split_pct_check TO accounts_revenue_split_pct_check;

ALTER TABLE account_compliance RENAME CONSTRAINT creator_compliance_pkey              TO account_compliance_pkey;
ALTER TABLE account_compliance RENAME CONSTRAINT creator_compliance_creator_id_key    TO account_compliance_account_id_key;
ALTER TABLE account_compliance RENAME CONSTRAINT creator_compliance_creator_id_fkey   TO account_compliance_account_id_fkey;
ALTER TABLE account_compliance RENAME CONSTRAINT creator_compliance_workspace_id_fkey TO account_compliance_workspace_id_fkey;
ALTER TABLE account_compliance RENAME CONSTRAINT creator_compliance_verified_by_fkey  TO account_compliance_verified_by_fkey;

ALTER TABLE account_agents RENAME CONSTRAINT creator_assignments_pkey                          TO account_agents_pkey;
ALTER TABLE account_agents RENAME CONSTRAINT creator_assignments_creator_id_membership_id_key  TO account_agents_account_id_membership_id_key;
ALTER TABLE account_agents RENAME CONSTRAINT creator_assignments_creator_id_fkey               TO account_agents_account_id_fkey;
ALTER TABLE account_agents RENAME CONSTRAINT creator_assignments_membership_id_fkey            TO account_agents_membership_id_fkey;
ALTER TABLE account_agents RENAME CONSTRAINT creator_assignments_workspace_id_fkey             TO account_agents_workspace_id_fkey;

ALTER TABLE customers      RENAME CONSTRAINT customers_creator_id_fkey      TO customers_account_id_fkey;
ALTER TABLE content_items  RENAME CONSTRAINT content_items_creator_id_fkey  TO content_items_account_id_fkey;
ALTER TABLE payment_links  RENAME CONSTRAINT payment_links_creator_id_fkey  TO payment_links_account_id_fkey;
ALTER TABLE transactions   RENAME CONSTRAINT transactions_creator_id_fkey   TO transactions_account_id_fkey;
ALTER TABLE payouts        RENAME CONSTRAINT payouts_creator_id_fkey        TO payouts_account_id_fkey;
ALTER TABLE invites        RENAME CONSTRAINT invites_creator_id_fkey        TO invites_account_id_fkey;

ALTER TABLE commission_rules RENAME CONSTRAINT commission_rules_creator_id_fkey         TO commission_rules_account_id_fkey;
ALTER TABLE commission_rules RENAME CONSTRAINT commission_rules_creator_split_pct_check TO commission_rules_account_split_pct_check;
ALTER TABLE commission_rules RENAME CONSTRAINT commission_rules_chatter_pct_check       TO commission_rules_agent_pct_check;

ALTER TABLE commission_entries RENAME CONSTRAINT commission_entries_creator_id_fkey            TO commission_entries_account_id_fkey;
ALTER TABLE commission_entries RENAME CONSTRAINT commission_entries_chatter_membership_id_fkey TO commission_entries_agent_membership_id_fkey;
ALTER TABLE commission_entries RENAME CONSTRAINT commission_entries_creator_payout_id_fkey     TO commission_entries_account_payout_id_fkey;
ALTER TABLE commission_entries RENAME CONSTRAINT commission_entries_chatter_payout_id_fkey     TO commission_entries_agent_payout_id_fkey;

-- ---------------------------------------------------------------------------
-- 5. Standalone indexes and the updated_at trigger
-- ---------------------------------------------------------------------------
ALTER INDEX idx_creators_ws        RENAME TO idx_accounts_ws;
ALTER INDEX idx_creators_user      RENAME TO idx_accounts_user;
ALTER INDEX uq_creator_user_per_ws RENAME TO uq_account_user_per_ws;
ALTER INDEX idx_customers_creator  RENAME TO idx_customers_account;
ALTER INDEX idx_content_creator    RENAME TO idx_content_account;
ALTER INDEX idx_links_creator      RENAME TO idx_links_account;
ALTER INDEX idx_txn_creator        RENAME TO idx_txn_account;
ALTER INDEX idx_ce_creator         RENAME TO idx_ce_account;
ALTER INDEX idx_assign_ws          RENAME TO idx_account_agents_ws;
ALTER INDEX idx_assign_member      RENAME TO idx_account_agents_member;

ALTER TRIGGER trg_creators_updated ON accounts RENAME TO trg_accounts_updated;

-- ---------------------------------------------------------------------------
-- 6. Role values stored as data.
--    memberships.role MUST move before the manager role row is deleted:
--    requireWorkspace LEFT JOINs roles on r.name = m.role, so a membership whose
--    role has no roles row silently gets permissions = NULL and falls back to a
--    matrix that no longer has a `manager` key — a 403 on every route, with no
--    error anywhere to explain it.
-- ---------------------------------------------------------------------------
UPDATE memberships SET role = 'admin'   WHERE role = 'manager';
UPDATE memberships SET role = 'agent'   WHERE role = 'chatter';
UPDATE memberships SET role = 'account' WHERE role = 'creator';

UPDATE invites SET role = 'admin'   WHERE role = 'manager';
UPDATE invites SET role = 'agent'   WHERE role = 'chatter';
UPDATE invites SET role = 'account' WHERE role = 'creator';

UPDATE roles SET name = 'agent'   WHERE name = 'chatter' AND is_system;
UPDATE roles SET name = 'account' WHERE name = 'creator' AND is_system;
DELETE FROM roles WHERE name = 'manager' AND is_system;

-- The permission vocabulary moves with the entity: roles.permissions is a jsonb
-- array of permission strings, held per workspace, so it needs a real backfill.
-- A non-null permissions array wins over the in-code matrix, so skipping this
-- would 403 every existing workspace out of the Accounts page.
UPDATE roles
   SET permissions = (
     SELECT jsonb_agg(CASE p
              WHEN 'creators.view'   THEN 'accounts.view'
              WHEN 'creators.manage' THEN 'accounts.manage'
              ELSE p END)
       FROM jsonb_array_elements_text(permissions) AS p)
 WHERE permissions::text LIKE '%creators.%';

-- ---------------------------------------------------------------------------
-- 7. payouts.payee_type — the CHECK constrains the very values being rewritten,
--    so it has to come off before the update and go back on after.
-- ---------------------------------------------------------------------------
ALTER TABLE payouts DROP CONSTRAINT payouts_payee_type_check;
UPDATE payouts SET payee_type = 'account' WHERE payee_type = 'creator';
UPDATE payouts SET payee_type = 'agent'   WHERE payee_type = 'chatter';
ALTER TABLE payouts ADD CONSTRAINT payouts_payee_type_check
  CHECK (payee_type IN ('account', 'agent', 'agency'));

-- ---------------------------------------------------------------------------
-- 8. The money functions.
--    plpgsql bodies are stored as TEXT and resolved on first call, so a rename
--    does NOT reach inside them. Without this the migration would succeed and
--    the next real payment would fail with "relation creators does not exist",
--    after the transaction row had already been written.
--    SECURITY DEFINER + the pinned search_path are carried over deliberately
--    (migration 028): dropping them reopens a search-path hijack.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_post_sale(tx uuid) RETURNS commission_entries AS $$
DECLARE
  t transactions; acct accounts; org uuid;
  margin numeric := 0; agentpct numeric := 0; m_agentpct numeric;
  b record; margin_val numeric; plat_fee numeric;
  model account_revenue_model := 'ai';
  split numeric := 0; dist numeric;
  acct_amt numeric; agent_amt numeric; agency_amt numeric;
  psp_fee_val numeric; entry commission_entries;
BEGIN
  SELECT * INTO t FROM transactions WHERE id = tx;
  IF NOT FOUND THEN RAISE EXCEPTION 'transaction % not found', tx; END IF;

  IF t.account_id IS NOT NULL THEN
    SELECT * INTO acct FROM accounts WHERE id = t.account_id;
    IF FOUND THEN model := acct.revenue_model; split := acct.revenue_split_pct; END IF;
  END IF;
  IF model <> 'revshare' THEN split := 0; END IF;

  SELECT organization_id INTO org FROM workspaces WHERE id = t.workspace_id;
  SELECT margin_rate_pct INTO margin FROM effective_platform_fee(org, t.occurred_at);
  margin := COALESCE(margin, 0);

  SELECT * INTO b FROM psp_cost_breakdown(org, t.gross, t.occurred_at);
  margin_val := round((t.gross * margin) / 100, 2);
  plat_fee   := round(b.total + margin_val, 2);

  SELECT agent_pct INTO agentpct FROM commission_rules
    WHERE workspace_id = t.workspace_id AND account_id IS NULL AND effective_from <= t.occurred_at
    ORDER BY effective_from DESC LIMIT 1;
  agentpct := COALESCE(agentpct, 0);
  IF t.attributed_membership_id IS NOT NULL THEN
    SELECT commission_pct INTO m_agentpct FROM memberships WHERE id = t.attributed_membership_id;
    IF m_agentpct IS NOT NULL THEN agentpct := m_agentpct; END IF;
  END IF;

  IF split + agentpct > 100 THEN
    RAISE EXCEPTION 'split_exceeds_100: account %%% + agent %%% on transaction %', split, agentpct, tx;
  END IF;

  IF t.fee IS NOT NULL AND t.fee > 0 THEN psp_fee_val := t.fee; ELSE psp_fee_val := b.total; END IF;

  dist := t.gross - plat_fee;
  IF dist <= 0 THEN
    RAISE EXCEPTION 'nothing_to_distribute: gross % minus fees % on transaction %', t.gross, plat_fee, tx;
  END IF;

  acct_amt   := round((dist * split) / 100, 2);
  agent_amt  := round((dist * agentpct) / 100, 2);
  agency_amt := dist - acct_amt - agent_amt;

  INSERT INTO commission_entries(
    workspace_id,transaction_id,account_id,agent_membership_id,entry_type,revenue_model,
    gross,platform_fee,platform_margin,psp_fee,distributable,
    account_amount,agent_amount,agency_amount,chargeback_fee,status,
    fee_mdr,fee_fixed,fee_settlement,fee_surcharge)
  VALUES(
    t.workspace_id,t.id,t.account_id,t.attributed_membership_id,'sale',model,
    t.gross,plat_fee,margin_val,psp_fee_val,dist,
    acct_amt,agent_amt,agency_amt,0,'locked',
    b.mdr,b.fixed,b.settlement,COALESCE(t.surcharge,0))
  RETURNING * INTO entry;
  RETURN entry;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION fn_post_refund(tx uuid) RETURNS commission_entries AS $$
DECLARE
  s commission_entries; org uuid; rfee numeric := 0;
  acct_amt numeric; agent_amt numeric; agency_amt numeric; entry commission_entries;
BEGIN
  SELECT * INTO s FROM commission_entries WHERE transaction_id = tx AND entry_type = 'sale';
  IF NOT FOUND THEN RAISE EXCEPTION 'no sale entry for transaction %', tx; END IF;
  IF EXISTS (SELECT 1 FROM commission_entries WHERE transaction_id = tx AND entry_type IN ('refund','chargeback')) THEN
    RAISE EXCEPTION 'transaction % already reversed', tx;
  END IF;

  SELECT organization_id INTO org FROM workspaces WHERE id = s.workspace_id;
  rfee := effective_refund_fee(org, now());

  agent_amt := - s.agent_amount;
  IF s.revenue_model = 'revshare' THEN
    acct_amt   := - s.account_amount - rfee;
    agency_amt := - s.agency_amount;
  ELSE
    acct_amt   := 0;
    agency_amt := - s.agency_amount - rfee;
  END IF;

  INSERT INTO commission_entries(
    workspace_id,transaction_id,account_id,agent_membership_id,entry_type,revenue_model,
    gross,platform_fee,platform_margin,psp_fee,distributable,account_amount,agent_amount,agency_amount,chargeback_fee,status)
  VALUES(
    s.workspace_id,s.transaction_id,s.account_id,s.agent_membership_id,'refund',s.revenue_model,
    - s.gross, - s.platform_fee, - s.platform_margin, - s.psp_fee, - s.distributable, acct_amt, agent_amt, agency_amt, rfee, 'locked')
  RETURNING * INTO entry;

  UPDATE commission_entries SET status = 'reversed' WHERE id = s.id;
  RETURN entry;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION fn_post_chargeback(tx uuid) RETURNS commission_entries AS $$
DECLARE
  s commission_entries; org uuid; cbfee numeric := 0;
  acct_amt numeric; agent_amt numeric; agency_amt numeric; entry commission_entries;
BEGIN
  SELECT * INTO s FROM commission_entries WHERE transaction_id = tx AND entry_type = 'sale';
  IF NOT FOUND THEN RAISE EXCEPTION 'no sale entry for transaction %', tx; END IF;
  IF EXISTS (SELECT 1 FROM commission_entries WHERE transaction_id = tx AND entry_type IN ('chargeback','refund')) THEN
    RAISE EXCEPTION 'transaction % already reversed', tx;
  END IF;

  SELECT organization_id INTO org FROM workspaces WHERE id = s.workspace_id;
  SELECT chargeback_fee INTO cbfee FROM effective_settlement_fees(org, now());
  cbfee := COALESCE(cbfee,0);

  agent_amt := - s.agent_amount;
  IF s.revenue_model = 'revshare' THEN
    acct_amt   := - s.account_amount - cbfee;
    agency_amt := - s.agency_amount;
  ELSE
    acct_amt   := 0;
    agency_amt := - s.agency_amount - cbfee;
  END IF;

  INSERT INTO commission_entries(
    workspace_id,transaction_id,account_id,agent_membership_id,entry_type,revenue_model,
    gross,platform_fee,platform_margin,psp_fee,distributable,account_amount,agent_amount,agency_amount,chargeback_fee,status)
  VALUES(
    s.workspace_id,s.transaction_id,s.account_id,s.agent_membership_id,'chargeback',s.revenue_model,
    - s.gross, - s.platform_fee, - s.platform_margin, - s.psp_fee, - s.distributable, acct_amt, agent_amt, agency_amt, cbfee, 'locked')
  RETURNING * INTO entry;

  UPDATE commission_entries SET status = 'reversed' WHERE id = s.id;
  RETURN entry;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ---------------------------------------------------------------------------
-- 9. membership_role has been unused since migration 008 turned memberships.role
--    into text. Leaving it would keep 'manager', 'chatter' and 'creator' alive
--    in the type catalogue as a description of a model that no longer exists.
-- ---------------------------------------------------------------------------
DROP TYPE membership_role;

COMMIT;
