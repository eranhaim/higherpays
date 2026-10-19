ALTER TABLE notifications
  ADD COLUMN event_key text;

CREATE UNIQUE INDEX notifications_workspace_event_key_unique
  ON notifications (workspace_id, event, event_key)
  WHERE event_key IS NOT NULL;
