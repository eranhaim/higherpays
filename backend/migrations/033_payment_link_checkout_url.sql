BEGIN;
-- MantaPay signs the amount into the hosted checkout URL, so it cannot be
-- rebuilt from the reference afterwards. Without storing it, the URL existed
-- only in the create response and was unrecoverable once that modal closed.
-- Rows created before this migration keep NULL; the UI offers no copy action
-- for those.
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS checkout_url text;
COMMIT;
