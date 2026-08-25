BEGIN;
-- Money-path invariants.
--
-- 1) fn_post_sale rounds each party's cut to cents and gives the remainder to
--    the agency, so the stored parts always sum to the distributable amount.
--    It refuses to post when creator + chatter would take more than 100% or
--    when fees leave nothing to distribute, instead of silently going negative.
-- 2) The sum is enforced by a CHECK for every new sale entry. NOT VALID leaves
--    historical rows alone; they were computed before rounding was disciplined.
-- 3) SECURITY DEFINER functions run as the table owner, so their name
--    resolution is pinned. pg_temp comes last, where a caller cannot shadow
--    anything, and PUBLIC loses the ability to create temp objects at all.
-- 4) A payout run records intent, not settlement: no rail moves money yet.

CREATE OR REPLACE FUNCTION fn_post_sale(tx uuid) RETURNS commission_entries AS $$
DECLARE
  t transactions; cr creators; org uuid;
  margin numeric := 0; chatpct numeric := 0; m_chatpct numeric;
  b record; margin_val numeric; plat_fee numeric;
  model creator_revenue_model := 'ai';
  split numeric := 0; dist numeric; c_amt numeric; ch_amt numeric; ag_amt numeric;
  psp_fee_val numeric; entry commission_entries;
BEGIN
  SELECT * INTO t FROM transactions WHERE id = tx;
  IF NOT FOUND THEN RAISE EXCEPTION 'transaction % not found', tx; END IF;

  IF t.creator_id IS NOT NULL THEN
    SELECT * INTO cr FROM creators WHERE id = t.creator_id;
    IF FOUND THEN model := cr.revenue_model; split := cr.revenue_split_pct; END IF;
  END IF;
  IF model <> 'revshare' THEN split := 0; END IF;

  SELECT organization_id INTO org FROM workspaces WHERE id = t.workspace_id;
  SELECT margin_rate_pct INTO margin FROM effective_platform_fee(org, t.occurred_at);
  margin := COALESCE(margin, 0);

  SELECT * INTO b FROM psp_cost_breakdown(org, t.gross, t.occurred_at);
  margin_val := round((t.gross * margin) / 100, 2);
  plat_fee   := round(b.total + margin_val, 2);

  SELECT chatter_pct INTO chatpct FROM commission_rules
    WHERE workspace_id = t.workspace_id AND creator_id IS NULL AND effective_from <= t.occurred_at
    ORDER BY effective_from DESC LIMIT 1;
  chatpct := COALESCE(chatpct, 0);
  IF t.attributed_membership_id IS NOT NULL THEN
    SELECT commission_pct INTO m_chatpct FROM memberships WHERE id = t.attributed_membership_id;
    IF m_chatpct IS NOT NULL THEN chatpct := m_chatpct; END IF;
  END IF;

  IF split + chatpct > 100 THEN
    RAISE EXCEPTION 'split_exceeds_100: creator %%% + chatter %%% on transaction %', split, chatpct, tx;
  END IF;

  IF t.fee IS NOT NULL AND t.fee > 0 THEN psp_fee_val := t.fee; ELSE psp_fee_val := b.total; END IF;

  dist := t.gross - plat_fee;
  IF dist <= 0 THEN
    RAISE EXCEPTION 'nothing_to_distribute: gross % minus fees % on transaction %', t.gross, plat_fee, tx;
  END IF;

  c_amt  := round((dist * split) / 100, 2);
  ch_amt := round((dist * chatpct) / 100, 2);
  ag_amt := dist - c_amt - ch_amt;

  INSERT INTO commission_entries(
    workspace_id,transaction_id,creator_id,chatter_membership_id,entry_type,revenue_model,
    gross,platform_fee,platform_margin,psp_fee,distributable,
    creator_amount,chatter_amount,agency_amount,chargeback_fee,status,
    fee_mdr,fee_fixed,fee_settlement,fee_surcharge)
  VALUES(
    t.workspace_id,t.id,t.creator_id,t.attributed_membership_id,'sale',model,
    t.gross,plat_fee,margin_val,psp_fee_val,dist,
    c_amt,ch_amt,ag_amt,0,'locked',
    b.mdr,b.fixed,b.settlement,COALESCE(t.surcharge,0))
  RETURNING * INTO entry;
  RETURN entry;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

ALTER TABLE commission_entries
  ADD CONSTRAINT commission_entries_sale_parts_sum
  CHECK (entry_type <> 'sale' OR creator_amount + chatter_amount + agency_amount = distributable)
  NOT VALID;

ALTER FUNCTION fn_post_refund(uuid)     SET search_path = public, pg_temp;
ALTER FUNCTION fn_post_chargeback(uuid) SET search_path = public, pg_temp;

DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

ALTER TYPE payout_status ADD VALUE IF NOT EXISTS 'recorded';

COMMIT;
