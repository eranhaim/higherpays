-- How a creator is paid: a share of each sale, or a salary.
--
-- A salaried creator takes no cut of a sale — the agency keeps that share and
-- owes the salary once per payout period instead. revenue_split_pct is left
-- alone so switching back restores the old share.

ALTER TABLE accounts ADD COLUMN pay_model text NOT NULL DEFAULT 'share'
  CHECK (pay_model IN ('share', 'salary'));
ALTER TABLE accounts ADD COLUMN salary_amount numeric(14,2) NOT NULL DEFAULT 0
  CHECK (salary_amount >= 0);

-- The only change to the sale: a salaried creator's share is zero, so the
-- distributable that would have been theirs stays with the agency.
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

  SELECT CASE WHEN pay_model = 'salary' THEN 0 ELSE COALESCE(revenue_split_pct, 0) END
    INTO split FROM accounts WHERE id = p.account_id;
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
