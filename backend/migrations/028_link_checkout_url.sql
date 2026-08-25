-- Persist the provider-signed hosted checkout URL on payment_links so the UI
-- can copy the payment URL after the initial create response is gone.
-- No RLS changes needed; the payment_links policies already cover this column.
ALTER TABLE payment_links
  ADD COLUMN IF NOT EXISTS checkout_url text;
