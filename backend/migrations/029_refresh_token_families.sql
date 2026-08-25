BEGIN;
-- Every refresh token descends from the sign-in that started its session.
-- Rotation issues the next token in the same family; presenting an already
-- rotated token means it was copied, and the whole family is revoked.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS family_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);
COMMIT;
