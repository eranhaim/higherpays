BEGIN;

-- Provider event ids are only unique within a merchant/workspace. A PSP may
-- reuse the same numeric id for two separate merchants.
ALTER TABLE webhook_events
  DROP CONSTRAINT webhook_events_provider_provider_event_id_event_type_key;

ALTER TABLE webhook_events
  ADD CONSTRAINT webhook_events_workspace_provider_event_type_key
  UNIQUE (workspace_id, provider, provider_event_id, event_type);

COMMIT;
