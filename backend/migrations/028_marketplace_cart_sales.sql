BEGIN;

-- One marketplace cart has one HigherPays payment link.  The fixed account
-- and agent are intentionally stored here so all accounting is attributed to
-- the Marketplace synthetic creator/chatter, never to a catalog creator.
CREATE TABLE marketplace_orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace_order_id  text NOT NULL UNIQUE,
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  account_id            uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  agent_id              uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  payment_link_id       uuid NOT NULL UNIQUE REFERENCES payment_links(id) ON DELETE RESTRICT,
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  currency              char(3) NOT NULL,
  return_url            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_marketplace_orders_link ON marketplace_orders(payment_link_id);
CREATE TRIGGER trg_marketplace_orders_updated
  BEFORE UPDATE ON marketplace_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Durable outbox. A payment is committed before the marketplace is notified;
-- retries therefore cannot lose fulfillment when either service is unavailable.
CREATE TABLE marketplace_event_outbox (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace_order_id  text NOT NULL REFERENCES marketplace_orders(marketplace_order_id) ON DELETE CASCADE,
  event_type            text NOT NULL CHECK (event_type IN ('payment.approved', 'payment.refunded', 'payment.chargeback')),
  payload               jsonb NOT NULL,
  attempts              int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at          timestamptz,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_marketplace_event_outbox_lifecycle
  ON marketplace_event_outbox(marketplace_order_id, event_type, (payload->>'providerTransactionId'));
CREATE INDEX idx_marketplace_event_outbox_pending
  ON marketplace_event_outbox(next_attempt_at)
  WHERE delivered_at IS NULL;

COMMIT;
