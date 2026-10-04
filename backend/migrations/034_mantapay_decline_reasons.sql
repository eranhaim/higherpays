ALTER TABLE transactions
  ADD COLUMN provider_decline_code text,
  ADD COLUMN provider_decline_reason text,
  ADD COLUMN provider_decline_code_source text,
  ADD COLUMN provider_decline_reason_source text;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_provider_decline_code_source_check
  CHECK (
    provider_decline_code_source IS NULL
    OR provider_decline_code_source IN (
      'mantapay_webhook_signed',
      'mantapay_status',
      'stored_raw_payload'
    )
  ),
  ADD CONSTRAINT transactions_provider_decline_reason_source_check
  CHECK (
    provider_decline_reason_source IS NULL
    OR provider_decline_reason_source IN (
      'mantapay_webhook',
      'mantapay_status',
      'stored_raw_payload'
    )
  );

CREATE INDEX transactions_workspace_decline_code_idx
  ON transactions (workspace_id, provider_decline_code)
  WHERE provider_decline_code IS NOT NULL;
