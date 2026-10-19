-- An order has one outcome; a payment row has one attempt.
--
-- MantaPay issues a NEW transaction id when it approves an order it had
-- already declined. The decline is keyed on the old id, so it stays behind as
-- its own payment row and the agency reads it as money it never received:
-- HP-NXEW-YCSX-EVMS shows one Completed payment and two Failed ones for the
-- same 998.00.
--
-- 'superseded' says what those rows are without deleting the provider's
-- evidence: the transaction, its reply code and its raw payload are untouched,
-- and the row keeps its provider id, so the attempt is still auditable.

BEGIN;

ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_status_check
  CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'superseded'));

-- Backfill: every single-use link that was paid, for the attempts it beat.
-- Archived rows are left alone; they are already out of every list and total.
UPDATE payments p
   SET status = 'superseded'
  FROM payment_links pl
 WHERE pl.id = p.payment_link_id
   AND pl.type = 'single_use'
   AND p.status IN ('pending', 'failed')
   AND p.archived_at IS NULL
   AND EXISTS (
     SELECT 1
       FROM payments winner
      WHERE winner.payment_link_id = pl.id
        AND winner.status IN ('paid', 'refunded')
        AND winner.review_reason IS NULL
        AND winner.archived_at IS NULL);

COMMIT;
