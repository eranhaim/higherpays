BEGIN;

ALTER TABLE users
  ADD COLUMN two_factor_recovery_codes text[] NOT NULL DEFAULT '{}';

ALTER TABLE refresh_tokens
  ADD COLUMN absolute_expires_at timestamptz,
  ADD COLUMN two_factor_authenticated boolean NOT NULL DEFAULT false;

UPDATE refresh_tokens
   SET absolute_expires_at = family.first_created_at + interval '30 days'
  FROM (
    SELECT family_id, min(created_at) AS first_created_at
      FROM refresh_tokens
     GROUP BY family_id
  ) family
 WHERE refresh_tokens.family_id = family.family_id;

UPDATE refresh_tokens
   SET expires_at = LEAST(expires_at, now() + interval '7 days', absolute_expires_at);

ALTER TABLE refresh_tokens
  ALTER COLUMN absolute_expires_at SET NOT NULL;

ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_status_check
  CHECK (status IN ('pending', 'paid', 'failed', 'refunded'));

ALTER TABLE transactions DROP CONSTRAINT transactions_status_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_status_check
  CHECK (status IN ('pending', 'approved', 'declined', 'refunded', 'charged_back'));

ALTER TABLE transactions
  ADD COLUMN fee_is_estimate boolean NOT NULL DEFAULT true;

UPDATE transactions
   SET fee_is_estimate = false
 WHERE fee <> 0;

ALTER TABLE webhook_events
  ADD COLUMN processing_error text;

ALTER TABLE webhook_events
  DROP CONSTRAINT webhook_events_provider_provider_event_id_key;
ALTER TABLE webhook_events
  ADD CONSTRAINT webhook_events_provider_provider_event_id_event_type_key
  UNIQUE (provider, provider_event_id, event_type);

CREATE UNIQUE INDEX uq_revenue_entries_transaction_entry_type
  ON revenue_entries(transaction_id, entry_type);

COMMIT;
