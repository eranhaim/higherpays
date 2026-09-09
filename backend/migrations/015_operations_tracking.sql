BEGIN;

ALTER TABLE payment_links
  ADD COLUMN archived_at timestamptz;

CREATE TABLE payment_link_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  payment_link_id uuid NOT NULL REFERENCES payment_links(id) ON DELETE CASCADE,
  payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'created',
    'opened',
    'checkout_initiated',
    'checkout_redirected',
    'provider_pending',
    'provider_approved',
    'provider_declined',
    'details_completed',
    'cancelled',
    'expired',
    'refunded',
    'chargeback'
  )),
  source text NOT NULL CHECK (source IN ('higherpays', 'public_checkout', 'provider')),
  idempotency_key text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_link_events_link_time
  ON payment_link_events(payment_link_id, occurred_at);

CREATE UNIQUE INDEX uq_payment_link_events_idempotency
  ON payment_link_events(payment_link_id, event_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

INSERT INTO payment_link_events
  (workspace_id, payment_link_id, event_type, source, idempotency_key, occurred_at)
SELECT workspace_id, id, 'created', 'higherpays', 'created', created_at
  FROM payment_links;

INSERT INTO payment_link_events
  (workspace_id, payment_link_id, payment_id, event_type, source, idempotency_key, occurred_at)
SELECT t.workspace_id, p.payment_link_id, p.id, 'provider_' || t.status, 'provider',
       t.provider_transaction_id, t.occurred_at
  FROM transactions t
  JOIN payments p ON p.id = t.payment_id
 WHERE t.type = 'payment'
   AND t.status IN ('pending', 'approved', 'declined')
   AND p.payment_link_id IS NOT NULL
   AND t.provider_transaction_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO payment_link_events
  (workspace_id, payment_link_id, payment_id, event_type, source, idempotency_key, occurred_at)
SELECT p.workspace_id, p.payment_link_id, p.id, 'details_completed', 'higherpays', p.id::text, p.updated_at
  FROM payments p
 WHERE p.payment_link_id IS NOT NULL
   AND p.category_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO payment_link_events
  (workspace_id, payment_link_id, payment_id, event_type, source, idempotency_key, occurred_at)
SELECT t.workspace_id, p.payment_link_id, p.id,
       CASE WHEN t.type = 'refund' THEN 'refunded' ELSE 'chargeback' END,
       'higherpays', t.id::text, t.occurred_at
  FROM transactions t
  JOIN payments p ON p.id = t.payment_id
 WHERE t.type IN ('refund', 'chargeback')
   AND p.payment_link_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO payment_link_events
  (workspace_id, payment_link_id, event_type, source, idempotency_key, occurred_at)
SELECT workspace_id, id, status, 'higherpays', status, updated_at
  FROM payment_links
 WHERE status IN ('cancelled', 'expired')
ON CONFLICT DO NOTHING;

COMMIT;
