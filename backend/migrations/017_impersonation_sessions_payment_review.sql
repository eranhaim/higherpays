BEGIN;

CREATE TABLE impersonation_sessions (
  jti uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (actor_user_id <> subject_user_id)
);

CREATE INDEX idx_impersonation_sessions_actor_user_id
  ON impersonation_sessions(actor_user_id);
CREATE INDEX idx_impersonation_sessions_subject_user_id
  ON impersonation_sessions(subject_user_id);
CREATE INDEX idx_impersonation_sessions_workspace_id
  ON impersonation_sessions(workspace_id);

ALTER TABLE payments
  ADD COLUMN review_reason text,
  ADD CONSTRAINT payments_review_reason_check
    CHECK (review_reason IS NULL OR review_reason = 'duplicate_single_use_charge');

COMMIT;
