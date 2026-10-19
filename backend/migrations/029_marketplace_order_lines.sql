-- Immutable line allocations for multi-creator marketplace orders (Vault Sales).
-- Each line maps to one real creator account; the payment link still belongs to
-- the synthetic Marketplace account.  After payment, fn_post_sale writes one
-- revenue_entries row per line so each creator appears in earnings and payouts.

BEGIN;

-- ── 1. Line allocations table ──────────────────────────────────────────────

CREATE TABLE marketplace_order_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace_order_id  text NOT NULL
    REFERENCES marketplace_orders(marketplace_order_id) ON DELETE CASCADE,
  line_id               text NOT NULL,
  account_id            uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  label                 text,
  UNIQUE (marketplace_order_id, line_id)
);
CREATE INDEX idx_mol_account ON marketplace_order_lines(account_id);

-- ── 2. Revenue entries: allow N sale rows per transaction ──────────────────

ALTER TABLE revenue_entries
  ADD COLUMN marketplace_order_line_id uuid
    REFERENCES marketplace_order_lines(id) ON DELETE RESTRICT;

-- The old index permits exactly one sale per transaction.  Replace it with a
-- pair: non-marketplace keeps the single-sale rule; marketplace allows one
-- sale per line.
DROP INDEX idx_revenue_entries_one_sale;
CREATE UNIQUE INDEX idx_revenue_entries_one_sale
  ON revenue_entries(transaction_id)
  WHERE entry_type = 'sale' AND marketplace_order_line_id IS NULL;
CREATE UNIQUE INDEX idx_revenue_entries_one_sale_per_line
  ON revenue_entries(transaction_id, marketplace_order_line_id)
  WHERE entry_type = 'sale' AND marketplace_order_line_id IS NOT NULL;

-- Same split for reversal entries.
CREATE UNIQUE INDEX idx_revenue_entries_one_reversal
  ON revenue_entries(transaction_id, entry_type)
  WHERE entry_type IN ('refund', 'chargeback') AND marketplace_order_line_id IS NULL;
CREATE UNIQUE INDEX idx_revenue_entries_one_reversal_per_line
  ON revenue_entries(transaction_id, marketplace_order_line_id, entry_type)
  WHERE entry_type IN ('refund', 'chargeback') AND marketplace_order_line_id IS NOT NULL;

CREATE INDEX idx_revenue_entries_mol ON revenue_entries(marketplace_order_line_id)
  WHERE marketplace_order_line_id IS NOT NULL;

-- ── 3. Marketplace orders: agent is optional for Vault Sales ───────────────

ALTER TABLE marketplace_orders ALTER COLUMN agent_id DROP NOT NULL;

-- ── 4. Updated revenue engine ──────────────────────────────────────────────

-- fn_post_sale: branches on marketplace order lines.
CREATE OR REPLACE FUNCTION fn_post_sale(tx uuid) RETURNS revenue_entries AS $$
DECLARE
  t transactions; p payments;
  split numeric := 0; agent_pct numeric := 0; margin numeric := 0;
  b record; margin_val numeric; plat_fee numeric; psp_fee_val numeric;
  dist numeric; acc_amt numeric; ag_amt numeric; agency_amt numeric;
  entry revenue_entries;
  -- multi-line state
  first_entry revenue_entries;
  line record; total_lines int; order_minor bigint;
  ln int := 0;
  a_gross numeric := 0; a_plat numeric := 0; a_margin numeric := 0;
  a_psp numeric := 0; a_dist numeric := 0;
  a_mdr numeric := 0; a_fixed numeric := 0; a_settle numeric := 0;
  a_sur numeric := 0;
  l_gross numeric; l_plat numeric; l_margin numeric; l_psp numeric; l_dist numeric;
  l_mdr numeric; l_fixed numeric; l_settle numeric; l_sur numeric;
BEGIN
  SELECT * INTO t FROM transactions WHERE id = tx;
  IF NOT FOUND THEN RAISE EXCEPTION 'transaction % not found', tx; END IF;
  SELECT * INTO p FROM payments WHERE id = t.payment_id;

  -- Check for marketplace order lines.
  SELECT count(*) INTO total_lines
    FROM marketplace_order_lines mol
    JOIN marketplace_orders mo ON mo.marketplace_order_id = mol.marketplace_order_id
   WHERE mo.payment_link_id = p.payment_link_id;

  IF total_lines = 0 THEN
    -- ─── Original single-entry path (unchanged) ───
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
  END IF;

  -- ─── Multi-line marketplace allocation ───
  SELECT margin_rate_pct INTO margin FROM effective_platform_fee(t.workspace_id, t.occurred_at);
  margin := COALESCE(margin, 0);
  SELECT * INTO b FROM psp_cost_breakdown(t.workspace_id, t.gross, t.occurred_at);
  margin_val := round((t.gross * margin) / 100, 2);
  plat_fee   := round(b.total + margin_val, 2);
  IF t.fee IS NOT NULL AND t.fee > 0 THEN psp_fee_val := t.fee; ELSE psp_fee_val := b.total; END IF;
  dist := t.gross - plat_fee;
  IF dist <= 0 THEN
    RAISE EXCEPTION 'nothing_to_distribute: gross % minus fees % on transaction %', t.gross, plat_fee, tx;
  END IF;

  SELECT mo.amount_minor INTO order_minor
    FROM marketplace_orders mo
    JOIN marketplace_order_lines mol ON mol.marketplace_order_id = mo.marketplace_order_id
   WHERE mo.payment_link_id = p.payment_link_id
   LIMIT 1;

  FOR line IN
    SELECT mol.id AS line_id, mol.account_id, mol.amount_minor
      FROM marketplace_order_lines mol
      JOIN marketplace_orders mo ON mo.marketplace_order_id = mol.marketplace_order_id
     WHERE mo.payment_link_id = p.payment_link_id
     ORDER BY mol.id
  LOOP
    ln := ln + 1;
    IF ln < total_lines THEN
      l_gross  := round(t.gross     * line.amount_minor::numeric / order_minor, 4);
      l_plat   := round(plat_fee    * line.amount_minor::numeric / order_minor, 4);
      l_margin := round(margin_val  * line.amount_minor::numeric / order_minor, 4);
      l_psp    := round(psp_fee_val * line.amount_minor::numeric / order_minor, 4);
      l_mdr    := round(b.mdr       * line.amount_minor::numeric / order_minor, 4);
      l_fixed  := round(b.fixed     * line.amount_minor::numeric / order_minor, 4);
      l_settle := round(b.settlement * line.amount_minor::numeric / order_minor, 4);
      l_sur    := round(COALESCE(t.surcharge, 0) * line.amount_minor::numeric / order_minor, 4);
    ELSE
      -- Last line absorbs rounding remainder.
      l_gross  := t.gross     - a_gross;
      l_plat   := plat_fee    - a_plat;
      l_margin := margin_val  - a_margin;
      l_psp    := psp_fee_val - a_psp;
      l_mdr    := b.mdr       - a_mdr;
      l_fixed  := b.fixed     - a_fixed;
      l_settle := b.settlement - a_settle;
      l_sur    := COALESCE(t.surcharge, 0) - a_sur;
    END IF;
    l_dist := l_gross - l_plat;

    a_gross  := a_gross  + l_gross;
    a_plat   := a_plat   + l_plat;
    a_margin := a_margin + l_margin;
    a_psp    := a_psp    + l_psp;
    a_dist   := a_dist   + l_dist;
    a_mdr    := a_mdr    + l_mdr;
    a_fixed  := a_fixed  + l_fixed;
    a_settle := a_settle + l_settle;
    a_sur    := a_sur    + l_sur;

    -- Per-creator split.  No agent in Vault Sales.
    SELECT revenue_split_pct INTO split FROM accounts WHERE id = line.account_id;
    split := COALESCE(split, 0);
    acc_amt    := round((l_dist * split) / 100, 2);
    agency_amt := l_dist - acc_amt;

    INSERT INTO revenue_entries(
      workspace_id, transaction_id, account_id, agent_id, entry_type, status,
      marketplace_order_line_id,
      gross, platform_fee, platform_margin, psp_fee, distributable,
      account_amount, agent_amount, agency_amount, chargeback_fee,
      fee_mdr, fee_fixed, fee_settlement, fee_surcharge)
    VALUES(
      t.workspace_id, t.id, line.account_id, NULL, 'sale', 'locked',
      line.line_id,
      l_gross, l_plat, l_margin, l_psp, l_dist,
      acc_amt, 0, agency_amt, 0,
      l_mdr, l_fixed, l_settle, l_sur)
    RETURNING * INTO entry;

    IF first_entry.id IS NULL THEN first_entry := entry; END IF;
  END LOOP;
  RETURN first_entry;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- fn_post_reversal: mirrors every sale entry when multiple exist.
CREATE OR REPLACE FUNCTION fn_post_reversal(tx uuid, kind text, fee numeric) RETURNS revenue_entries AS $$
DECLARE
  s revenue_entries;
  entry revenue_entries;
  first_entry revenue_entries;
  sale_count int;
  current_idx int := 0;
  total_dist numeric;
  allocated_fee numeric := 0;
  line_fee numeric;
BEGIN
  SELECT count(*) INTO sale_count
    FROM revenue_entries WHERE transaction_id = tx AND entry_type = 'sale';
  IF sale_count = 0 THEN
    RAISE EXCEPTION 'no sale entry for transaction %', tx;
  END IF;
  IF EXISTS (SELECT 1 FROM revenue_entries
              WHERE transaction_id = tx AND entry_type IN ('refund', 'chargeback')) THEN
    RAISE EXCEPTION 'transaction % already reversed', tx;
  END IF;

  SELECT COALESCE(SUM(ABS(distributable)), 0) INTO total_dist
    FROM revenue_entries WHERE transaction_id = tx AND entry_type = 'sale';

  FOR s IN
    SELECT * FROM revenue_entries
     WHERE transaction_id = tx AND entry_type = 'sale'
     ORDER BY id
  LOOP
    current_idx := current_idx + 1;
    IF current_idx < sale_count THEN
      line_fee := CASE WHEN total_dist > 0
        THEN round(fee * ABS(s.distributable) / total_dist, 2) ELSE 0 END;
    ELSE
      line_fee := fee - allocated_fee;
    END IF;
    allocated_fee := allocated_fee + line_fee;

    INSERT INTO revenue_entries(
      workspace_id, transaction_id, account_id, agent_id, entry_type, status,
      marketplace_order_line_id,
      gross, platform_fee, platform_margin, psp_fee, distributable,
      account_amount, agent_amount, agency_amount, chargeback_fee)
    VALUES(
      s.workspace_id, s.transaction_id, s.account_id, s.agent_id, kind, 'locked',
      s.marketplace_order_line_id,
      -s.gross, -s.platform_fee, -s.platform_margin, -s.psp_fee, -s.distributable,
      -s.account_amount - line_fee, -s.agent_amount, -s.agency_amount, line_fee)
    RETURNING * INTO entry;

    UPDATE revenue_entries SET status = 'reversed' WHERE id = s.id;
    IF first_entry.id IS NULL THEN first_entry := entry; END IF;
  END LOOP;

  RETURN first_entry;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

COMMIT;
