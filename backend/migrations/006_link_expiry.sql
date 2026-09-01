-- How long a single-use link lives, per agency. Null means the platform
-- default (LINK_TTL_MINUTES), so nothing changes for a workspace that never
-- sets one.

ALTER TABLE workspaces ADD COLUMN link_ttl_minutes integer
  CHECK (link_ttl_minutes IS NULL OR link_ttl_minutes > 0);
