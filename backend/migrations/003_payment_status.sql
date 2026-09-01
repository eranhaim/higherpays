-- Narrow payments.status to the outcomes the app actually writes.
--
-- A payment row is only ever inserted with the provider's verdict (paid or
-- failed) and only ever updated to refunded, so 'pending' and 'cancelled' were
-- unreachable: they showed up as filter options that could never match a row.
-- The default goes with them — the insert always supplies the status.

ALTER TABLE payments ALTER COLUMN status DROP DEFAULT;

ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('paid', 'failed', 'refunded'));
