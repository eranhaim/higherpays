BEGIN;

-- MantaPay leaves `reply_desc` empty on some reply codes, so a declined
-- attempt could be stored with a code and no readable reason. Those rows now
-- carry wording that states the provider gave no reason, which is not provider
-- text and must not claim to be.
ALTER TABLE transactions
  DROP CONSTRAINT transactions_provider_decline_reason_source_check;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_provider_decline_reason_source_check
  CHECK (
    provider_decline_reason_source IS NULL
    OR provider_decline_reason_source IN (
      'mantapay_webhook',
      'mantapay_status',
      'stored_raw_payload',
      'derived_no_provider_text'
    )
  );

COMMIT;
