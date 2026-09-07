-- MantaPay reports the content amount when ExtraCostAmount is used.
-- Repair paid rows created while the webhook handler subtracted the checkout
-- fee from that already-net amount.

BEGIN;

CREATE TEMP TABLE checkout_fee_repairs ON COMMIT DROP AS
SELECT t.id AS transaction_id, pl.amount AS sale_amount
  FROM transactions t
  JOIN payments p ON p.id = t.payment_id
  JOIN payment_links pl ON pl.id = p.payment_link_id
 WHERE p.status = 'paid'
   AND t.type = 'payment'
   AND pl.checkout_fee > 0
   AND t.gross + t.surcharge = pl.amount
   AND NOT EXISTS (
     SELECT 1
       FROM revenue_entries re
      WHERE re.transaction_id = t.id
        AND (re.account_payout_id IS NOT NULL OR re.agent_payout_id IS NOT NULL)
   );

DELETE FROM revenue_entries re
 WHERE re.transaction_id IN (SELECT transaction_id FROM checkout_fee_repairs)
   AND re.entry_type = 'sale';

UPDATE payments p
   SET amount = r.sale_amount
  FROM checkout_fee_repairs r
  JOIN transactions t ON t.id = r.transaction_id
 WHERE p.id = t.payment_id;

UPDATE transactions t
   SET gross = r.sale_amount,
       net = r.sale_amount - t.fee
  FROM checkout_fee_repairs r
 WHERE t.id = r.transaction_id;

DO $$
DECLARE
  repair record;
BEGIN
  FOR repair IN SELECT transaction_id FROM checkout_fee_repairs LOOP
    PERFORM fn_post_sale(repair.transaction_id);
  END LOOP;
END;
$$;

COMMIT;
