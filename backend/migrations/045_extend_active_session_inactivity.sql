-- Existing, still-valid sessions should get the same six-hour window as new
-- sessions. The token's creation time is its last refresh, and the absolute
-- session limit still applies. Never revive expired or revoked sessions.
UPDATE refresh_tokens
   SET expires_at = LEAST(created_at + interval '6 hours', absolute_expires_at)
 WHERE revoked_at IS NULL
   AND expires_at > now()
   AND expires_at < LEAST(created_at + interval '6 hours', absolute_expires_at);
