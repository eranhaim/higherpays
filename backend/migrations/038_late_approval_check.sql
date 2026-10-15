-- When the late-approval sweep last asked MantaPay about a closed link.
--
-- The sweep polls links written off as expired or cancelled, in case MantaPay
-- approves one after the fact. In production that set is ~1,150 orders, which
-- is far too many to ask about every ten minutes, and most of them will never
-- be approved. The sweep therefore takes the least-recently-checked batch and
-- stamps it, so the backlog rotates instead of the same orders being polled
-- forever while the rest are never reached.
BEGIN;
ALTER TABLE payment_links ADD COLUMN late_check_at timestamptz;
CREATE INDEX idx_payment_links_late_check
    ON payment_links (workspace_id, late_check_at NULLS FIRST)
 WHERE type = 'single_use' AND archived_at IS NULL AND status IN ('expired', 'cancelled');
COMMIT;
