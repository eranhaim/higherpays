BEGIN;

-- MantaPay can reuse a transaction number for different orders. Preserve the
-- original provider number and scope payment attempts to their checkout.
ALTER TABLE payments DROP CONSTRAINT payments_workspace_id_provider_payment_id_key;
ALTER TABLE payments ADD CONSTRAINT payments_order_provider_key
  UNIQUE (workspace_id, payment_link_id, provider_payment_id);

ALTER TABLE transactions DROP CONSTRAINT transactions_workspace_id_provider_transaction_id_key;
ALTER TABLE transactions ADD CONSTRAINT transactions_payment_provider_key
  UNIQUE (workspace_id, payment_id, provider_transaction_id);
CREATE INDEX transactions_provider_lookup ON transactions(workspace_id, provider_transaction_id);

ALTER TABLE webhook_events ADD COLUMN order_reference text NOT NULL DEFAULT '';
UPDATE webhook_events SET order_reference = COALESCE(payload->>'trans_order', payload->>'OrderId', '');
ALTER TABLE webhook_events DROP CONSTRAINT webhook_events_workspace_provider_event_type_key;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_order_provider_key
  UNIQUE (workspace_id, provider, provider_event_id, event_type, order_reference);

COMMIT;
