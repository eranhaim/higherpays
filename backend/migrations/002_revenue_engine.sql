-- The revenue engine: who is owed what for one transaction, in exact NUMERIC.
--
-- Waterfall per sale (cascade or flat, per the workspace rate card):
--   gross
--    - provider fees (mdr, fixed, settlement)
--    - HigherPays margin
--    = distributable
--        account = distributable * accounts.revenue_split_pct
--        agent   = distributable * agents.commission_pct
--        agency  = the remainder
--
-- A reversal (refund or chargeback) mirrors the sale with negative amounts:
-- the agent loses the commission, the account gives back its share and pays
-- the reversal fee, the agency gives back its own share.
--
-- Every cut is rounded to cents and the remainder goes to the agency, so the
-- parts always sum to the distributable amount. The CHECK at the end enforces
-- it. SECURITY DEFINER functions pin search_path so a caller cannot shadow
-- the tables they read.

BEGIN;

-- The rate card in force for a workspace at a moment in time.
CREATE OR REPLACE FUNCTION effective_platform_fee(ws uuid, at timestamptz)
RETURNS platform_fee_rates AS $$
  SELECT * FROM platform_fee_rates
   WHERE workspace_id = ws AND effective_from <= at
   ORDER BY effective_from DESC LIMIT 1;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION effective_settlement_fees(ws uuid, at timestamptz)
RETURNS settlement_fee_config AS $$
  SELECT * FROM settlement_fee_config
   WHERE workspace_id = ws AND effective_from <= at
   ORDER BY effective_from DESC LIMIT 1;
$$ LANGUAGE sql STABLE;

-- Only the blended number: what the agency is charged, never the PSP/margin
-- split behind it.
CREATE OR REPLACE FUNCTION workspace_blended_rate(ws uuid) RETURNS numeric AS $$
  SELECT COALESCE((SELECT blended_rate_pct FROM effective_platform_fee(ws, now())), 0);
$$ LANGUAGE sql STABLE;

-- Itemised provider cost for a gross amount.
--   FLAT    every percentage applies to the original gross
--   CASCADE each fee applies to the running balance, in order: mdr, fixed, settlement
CREATE OR REPLACE FUNCTION psp_cost_breakdown(ws uuid, gross numeric, at timestamptz)
RETURNS TABLE(mdr numeric, fixed numeric, settlement numeric, total numeric) AS $$
DECLARE
  r platform_fee_rates; m numeric; s numeric; f numeric; bal numeric;
BEGIN
  r := effective_platform_fee(ws, at);
  IF r.id IS NULL THEN
    RETURN QUERY SELECT 0::numeric, 0::numeric, 0::numeric, 0::numeric; RETURN;
  END IF;

  f := COALESCE(r.psp_fixed_fee, 0);
  m := COALESCE(r.mdr_pct, r.psp_rate_pct, 0);
  s := COALESCE(r.settlement_pct, 0);
  IF r.mdr_pct IS NULL THEN s := 0; END IF;   -- rate not itemised: all of it is MDR

  IF r.fee_model = 'cascade' THEN
    mdr := gross * m / 100;
    bal := gross - mdr;
    fixed := f;
    bal := bal - fixed;
    settlement := bal * s / 100;
  ELSE
    mdr := gross * m / 100;
    fixed := f;
    settlement := gross * s / 100;
  END IF;
  total := mdr + fixed + settlement;
  RETURN QUERY SELECT mdr, fixed, settlement, total;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION fn_post_sale(tx uuid) RETURNS revenue_entries AS $$
DECLARE
  t transactions; p payments;
  split numeric := 0; agent_pct numeric := 0; margin numeric := 0;
  b record; margin_val numeric; plat_fee numeric; psp_fee_val numeric;
  dist numeric; acc_amt numeric; ag_amt numeric; agency_amt numeric;
  entry revenue_entries;
BEGIN
  SELECT * INTO t FROM transactions WHERE id = tx;
  IF NOT FOUND THEN RAISE EXCEPTION 'transaction % not found', tx; END IF;
  SELECT * INTO p FROM payments WHERE id = t.payment_id;

  SELECT revenue_split_pct INTO split FROM accounts WHERE id = p.account_id;
  split := COALESCE(split, 0);
  IF p.agent_id IS NOT NULL THEN
    SELECT commission_pct INTO agent_pct FROM agents WHERE id = p.agent_id;
  END IF;
  agent_pct := COALESCE(agent_pct, 0);
  IF split + agent_pct > 100 THEN
    RAISE EXCEPTION 'split_exceeds_100: account %%% + agent %%% on transaction %', split, agent_pct, tx;
  END IF;

  SELECT margin_rate_pct INTO margin FROM effective_platform_fee(t.workspace_id, t.occurred_at);
  margin := COALESCE(margin, 0);
  SELECT * INTO b FROM psp_cost_breakdown(t.workspace_id, t.gross, t.occurred_at);
  margin_val := round((t.gross * margin) / 100, 2);
  plat_fee   := round(b.total + margin_val, 2);

  -- The provider's actual fee when it reported one, else the rate-card estimate.
  IF t.fee IS NOT NULL AND t.fee > 0 THEN psp_fee_val := t.fee; ELSE psp_fee_val := b.total; END IF;

  dist := t.gross - plat_fee;
  IF dist <= 0 THEN
    RAISE EXCEPTION 'nothing_to_distribute: gross % minus fees % on transaction %', t.gross, plat_fee, tx;
  END IF;

  acc_amt    := round((dist * split) / 100, 2);
  ag_amt     := round((dist * agent_pct) / 100, 2);
  agency_amt := dist - acc_amt - ag_amt;

  INSERT INTO revenue_entries(
    workspace_id, transaction_id, account_id, agent_id, entry_type, status,
    gross, platform_fee, platform_margin, psp_fee, distributable,
    account_amount, agent_amount, agency_amount, chargeback_fee,
    fee_mdr, fee_fixed, fee_settlement, fee_surcharge)
  VALUES(
    t.workspace_id, t.id, p.account_id, p.agent_id, 'sale', 'locked',
    t.gross, plat_fee, margin_val, psp_fee_val, dist,
    acc_amt, ag_amt, agency_amt, 0,
    b.mdr, b.fixed, b.settlement, COALESCE(t.surcharge, 0))
  RETURNING * INTO entry;
  RETURN entry;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- Shared by refund and chargeback: same waterfall, different fee.
CREATE OR REPLACE FUNCTION fn_post_reversal(tx uuid, kind text, fee numeric) RETURNS revenue_entries AS $$
DECLARE
  s revenue_entries; entry revenue_entries;
BEGIN
  SELECT * INTO s FROM revenue_entries WHERE transaction_id = tx AND entry_type = 'sale';
  IF NOT FOUND THEN RAISE EXCEPTION 'no sale entry for transaction %', tx; END IF;
  IF EXISTS (SELECT 1 FROM revenue_entries WHERE transaction_id = tx AND entry_type IN ('refund', 'chargeback')) THEN
    RAISE EXCEPTION 'transaction % already reversed', tx;
  END IF;

  INSERT INTO revenue_entries(
    workspace_id, transaction_id, account_id, agent_id, entry_type, status,
    gross, platform_fee, platform_margin, psp_fee, distributable,
    account_amount, agent_amount, agency_amount, chargeback_fee)
  VALUES(
    s.workspace_id, s.transaction_id, s.account_id, s.agent_id, kind, 'locked',
    - s.gross, - s.platform_fee, - s.platform_margin, - s.psp_fee, - s.distributable,
    - s.account_amount - fee, - s.agent_amount, - s.agency_amount, fee)
  RETURNING * INTO entry;

  UPDATE revenue_entries SET status = 'reversed' WHERE id = s.id;
  RETURN entry;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION fn_post_refund(tx uuid) RETURNS revenue_entries AS $$
DECLARE ws uuid; f settlement_fee_config;
BEGIN
  SELECT workspace_id INTO ws FROM transactions WHERE id = tx;
  f := effective_settlement_fees(ws, now());
  RETURN fn_post_reversal(tx, 'refund', COALESCE(f.refund_fee, 0));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION fn_post_chargeback(tx uuid) RETURNS revenue_entries AS $$
DECLARE ws uuid; f settlement_fee_config;
BEGIN
  SELECT workspace_id INTO ws FROM transactions WHERE id = tx;
  f := effective_settlement_fees(ws, now());
  RETURN fn_post_reversal(tx, 'chargeback', COALESCE(f.chargeback_fee, 0));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- At most one sale entry per transaction, and the parts must add up.
CREATE UNIQUE INDEX idx_revenue_entries_one_sale ON revenue_entries(transaction_id) WHERE entry_type = 'sale';
ALTER TABLE revenue_entries
  ADD CONSTRAINT revenue_entries_sale_parts_sum
  CHECK (entry_type <> 'sale' OR account_amount + agent_amount + agency_amount = distributable);

-- A SECURITY DEFINER function must not be able to pick up a caller's temp
-- object, and nobody but the owner creates objects in public.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

COMMIT;
