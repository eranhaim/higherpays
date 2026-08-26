-- Generated from src/schema/entities.js by scripts/generate-schema.js.
-- Do not edit by hand: change the entities file and regenerate.
--
-- Money is NUMERIC, never float. Status columns are text with a CHECK so a new
-- value is an ordinary migration rather than an ALTER TYPE.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- users
CREATE TABLE users (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                    citext NOT NULL UNIQUE,
  full_name                text NOT NULL,
  password_hash            text,
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'invited')),
  is_platform_admin        boolean NOT NULL DEFAULT false,
  two_factor_enabled       boolean NOT NULL DEFAULT false,
  two_factor_secret        text,
  last_login_at            timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- refresh_tokens
CREATE TABLE refresh_tokens (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id                uuid NOT NULL DEFAULT gen_random_uuid(),
  token_hash               text NOT NULL UNIQUE,
  expires_at               timestamptz NOT NULL,
  revoked_at               timestamptz,
  user_agent               text,
  ip                       inet,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);

-- workspaces
CREATE TABLE workspaces (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     text NOT NULL,
  currency                 char(3) NOT NULL DEFAULT 'EUR',
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  merchant_id              text,
  provider_config_ref      text,
  webhook_endpoint_id      text NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', ''),
  webhook_secret           text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  min_link_amount          numeric(14,2),
  max_link_amount          numeric(14,2),
  account_label            text NOT NULL DEFAULT 'Account',
  account_label_plural     text NOT NULL DEFAULT 'Accounts',
  agent_label              text NOT NULL DEFAULT 'Agent',
  agent_label_plural       text NOT NULL DEFAULT 'Agents',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (min_link_amount IS NULL OR max_link_amount IS NULL OR min_link_amount <= max_link_amount)
);
CREATE INDEX idx_workspaces_webhook_endpoint_id ON workspaces(webhook_endpoint_id);
CREATE TRIGGER trg_workspaces_updated BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- platform_fee_rates
CREATE TABLE platform_fee_rates (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fee_model                text NOT NULL DEFAULT 'flat' CHECK (fee_model IN ('flat', 'cascade')),
  psp_rate_pct             numeric(5,2) NOT NULL CHECK (psp_rate_pct >= 0 AND psp_rate_pct <= 100),
  mdr_pct                  numeric(5,2) CHECK (mdr_pct >= 0 AND mdr_pct <= 100),
  settlement_pct           numeric(5,2) CHECK (settlement_pct >= 0 AND settlement_pct <= 100),
  psp_fixed_fee            numeric(14,2) NOT NULL DEFAULT 0,
  margin_rate_pct          numeric(5,2) NOT NULL DEFAULT 0 CHECK (margin_rate_pct >= 0 AND margin_rate_pct <= 100),
  blended_rate_pct         numeric(6,2) GENERATED ALWAYS AS (psp_rate_pct + margin_rate_pct) STORED,
  effective_from           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_platform_fee_rates_workspace_id_effective_from ON platform_fee_rates(workspace_id, effective_from);

-- workspace_users
CREATE TABLE workspace_users (
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                     text NOT NULL CHECK (role IN ('workspace_admin', 'analyst', 'agent', 'account_owner')),
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  UNIQUE (workspace_id, user_id, role)
);
CREATE INDEX idx_workspace_users_user_id ON workspace_users(user_id);
CREATE TRIGGER trg_workspace_users_updated BEFORE UPDATE ON workspace_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- invites
CREATE TABLE invites (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email                    citext NOT NULL,
  role                     text NOT NULL CHECK (role IN ('workspace_admin', 'analyst', 'agent', 'account_owner')),
  token_hash               text NOT NULL UNIQUE,
  invited_by_user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at               timestamptz NOT NULL,
  accepted_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_invites_workspace_id ON invites(workspace_id);

-- accounts
CREATE TABLE accounts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id                  uuid NOT NULL,
  role                     text NOT NULL DEFAULT 'account_owner' CHECK (role IN ('account_owner')),
  name                     text NOT NULL,
  handle                   text,
  country                  char(2),
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  revenue_split_pct        numeric(5,2) NOT NULL DEFAULT 70 CHECK (revenue_split_pct >= 0 AND revenue_split_pct <= 100),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, user_id, role) REFERENCES workspace_users(workspace_id, user_id, role) ON DELETE RESTRICT
);
CREATE INDEX idx_accounts_workspace_id ON accounts(workspace_id);
CREATE TRIGGER trg_accounts_updated BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- agents
CREATE TABLE agents (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id                  uuid NOT NULL,
  role                     text NOT NULL DEFAULT 'agent' CHECK (role IN ('agent')),
  country                  char(2),
  commission_pct           numeric(5,2) NOT NULL DEFAULT 0 CHECK (commission_pct >= 0 AND commission_pct <= 100),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, user_id, role) REFERENCES workspace_users(workspace_id, user_id, role) ON DELETE RESTRICT
);
CREATE INDEX idx_agents_workspace_id ON agents(workspace_id);
CREATE TRIGGER trg_agents_updated BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- account_agents
CREATE TABLE account_agents (
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id               uuid NOT NULL,
  agent_id                 uuid NOT NULL,
  PRIMARY KEY (account_id, agent_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_account_agents_agent_id ON account_agents(agent_id);

-- categories
CREATE TABLE categories (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                     text NOT NULL,
  active                   boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

-- customers
CREATE TABLE customers (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                     text NOT NULL,
  telegram_name            text,
  email                    citext,
  phone                    text,
  country                  char(2),
  segment                  text NOT NULL DEFAULT 'new' CHECK (segment IN ('new', 'regular', 'high_value', 'vip', 'inactive', 'at_risk')),
  total_spend              numeric(14,2) NOT NULL DEFAULT 0,
  last_purchase_at         timestamptz,
  deleted_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_workspace_id ON customers(workspace_id);
CREATE INDEX idx_customers_workspace_id_segment ON customers(workspace_id, segment);
CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- payment_links
CREATE TABLE payment_links (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id               uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  customer_id              uuid REFERENCES customers(id) ON DELETE SET NULL,
  created_by_agent_id      uuid REFERENCES agents(id) ON DELETE SET NULL,
  description              text,
  type                     text NOT NULL CHECK (type IN ('single_use', 'reusable')),
  pricing_mode             text NOT NULL DEFAULT 'fixed' CHECK (pricing_mode IN ('fixed', 'open')),
  amount                   numeric(14,2),
  currency                 char(3) NOT NULL,
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'done', 'expired', 'cancelled', 'refunded')),
  reference_id             text,
  provider_request_id      text,
  provider_link_id         text,
  checkout_url             text,
  expires_at               timestamptz,
  paid_at                  timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (pricing_mode = 'open' OR (amount IS NOT NULL AND amount > 0)),
  CHECK (type = 'single_use' OR (expires_at IS NULL AND paid_at IS NULL))
);
CREATE INDEX idx_payment_links_workspace_id ON payment_links(workspace_id);
CREATE INDEX idx_payment_links_account_id ON payment_links(account_id);
CREATE INDEX idx_payment_links_customer_id ON payment_links(customer_id);
CREATE INDEX idx_payment_links_workspace_id_status ON payment_links(workspace_id, status);
CREATE UNIQUE INDEX idx_payment_links_workspace_id_reference_id ON payment_links(workspace_id, reference_id) WHERE reference_id IS NOT NULL;
CREATE TRIGGER trg_payment_links_updated BEFORE UPDATE ON payment_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- payments
CREATE TABLE payments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id               uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  payment_link_id          uuid REFERENCES payment_links(id) ON DELETE SET NULL,
  customer_id              uuid REFERENCES customers(id) ON DELETE SET NULL,
  category_id              uuid REFERENCES categories(id) ON DELETE SET NULL,
  agent_id                 uuid REFERENCES agents(id) ON DELETE SET NULL,
  amount                   numeric(14,2) NOT NULL,
  currency                 char(3) NOT NULL,
  status                   text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'cancelled', 'refunded')),
  payment_method           text,
  provider_payment_id      text,
  occurred_at              timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider_payment_id)
);
CREATE INDEX idx_payments_workspace_id ON payments(workspace_id);
CREATE INDEX idx_payments_account_id ON payments(account_id);
CREATE INDEX idx_payments_payment_link_id ON payments(payment_link_id);
CREATE INDEX idx_payments_workspace_id_occurred_at ON payments(workspace_id, occurred_at);
CREATE TRIGGER trg_payments_updated BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- transactions
CREATE TABLE transactions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  payment_id               uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  type                     text NOT NULL DEFAULT 'payment' CHECK (type IN ('payment', 'refund', 'chargeback', 'adjustment')),
  status                   text NOT NULL CHECK (status IN ('approved', 'declined', 'refunded', 'charged_back')),
  gross                    numeric(14,2) NOT NULL DEFAULT 0,
  fee                      numeric(14,2) NOT NULL DEFAULT 0,
  surcharge                numeric(14,2) NOT NULL DEFAULT 0,
  net                      numeric(14,2) NOT NULL DEFAULT 0,
  currency                 char(3) NOT NULL,
  provider_transaction_id  text,
  occurred_at              timestamptz NOT NULL DEFAULT now(),
  raw_payload              jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider_transaction_id)
);
CREATE INDEX idx_transactions_workspace_id ON transactions(workspace_id);
CREATE INDEX idx_transactions_payment_id ON transactions(payment_id);
CREATE INDEX idx_transactions_workspace_id_occurred_at ON transactions(workspace_id, occurred_at);

-- revenue_rules
CREATE TABLE revenue_rules (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id               uuid REFERENCES accounts(id) ON DELETE CASCADE,
  account_split_pct        numeric(5,2) NOT NULL CHECK (account_split_pct >= 0 AND account_split_pct <= 100),
  agency_split_pct         numeric(5,2) NOT NULL CHECK (agency_split_pct >= 0 AND agency_split_pct <= 100),
  agent_pct                numeric(5,2) NOT NULL DEFAULT 0 CHECK (agent_pct >= 0 AND agent_pct <= 100),
  effective_from           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_revenue_rules_workspace_id_effective_from ON revenue_rules(workspace_id, effective_from);

-- payouts
CREATE TABLE payouts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  payee_type               text NOT NULL CHECK (payee_type IN ('account', 'agent', 'agency')),
  account_id               uuid REFERENCES accounts(id) ON DELETE SET NULL,
  agent_id                 uuid REFERENCES agents(id) ON DELETE SET NULL,
  period_start             date NOT NULL,
  period_end               date NOT NULL,
  gross                    numeric(14,2) NOT NULL DEFAULT 0,
  fees                     numeric(14,2) NOT NULL DEFAULT 0,
  refunds                  numeric(14,2) NOT NULL DEFAULT 0,
  net                      numeric(14,2) NOT NULL DEFAULT 0,
  currency                 char(3) NOT NULL,
  status                   text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'on_hold')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payouts_workspace_id_period_start ON payouts(workspace_id, period_start);
CREATE TRIGGER trg_payouts_updated BEFORE UPDATE ON payouts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- revenue_entries
CREATE TABLE revenue_entries (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transaction_id           uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  account_id               uuid REFERENCES accounts(id) ON DELETE SET NULL,
  agent_id                 uuid REFERENCES agents(id) ON DELETE SET NULL,
  entry_type               text NOT NULL CHECK (entry_type IN ('sale', 'refund', 'chargeback')),
  status                   text NOT NULL DEFAULT 'locked' CHECK (status IN ('locked', 'reversed')),
  gross                    numeric(14,4) NOT NULL,
  platform_fee             numeric(14,4) NOT NULL,
  platform_margin          numeric(14,4) NOT NULL,
  psp_fee                  numeric(14,4) NOT NULL,
  distributable            numeric(14,4) NOT NULL,
  account_amount           numeric(14,4) NOT NULL,
  agent_amount             numeric(14,4) NOT NULL,
  agency_amount            numeric(14,4) NOT NULL,
  fee_mdr                  numeric(14,4) NOT NULL DEFAULT 0,
  fee_fixed                numeric(14,4) NOT NULL DEFAULT 0,
  fee_settlement           numeric(14,4) NOT NULL DEFAULT 0,
  fee_surcharge            numeric(14,4) NOT NULL DEFAULT 0,
  chargeback_fee           numeric(14,4) NOT NULL DEFAULT 0,
  account_payout_id        uuid REFERENCES payouts(id) ON DELETE SET NULL,
  agent_payout_id          uuid REFERENCES payouts(id) ON DELETE SET NULL,
  account_paid_at          timestamptz,
  agent_paid_at            timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_revenue_entries_workspace_id ON revenue_entries(workspace_id);
CREATE INDEX idx_revenue_entries_transaction_id ON revenue_entries(transaction_id);
CREATE INDEX idx_revenue_entries_account_id ON revenue_entries(account_id);

-- settlement_fee_config
CREATE TABLE settlement_fee_config (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chargeback_fee           numeric(14,2) NOT NULL DEFAULT 0,
  refund_fee               numeric(14,2) NOT NULL DEFAULT 0,
  decline_fee              numeric(14,2) NOT NULL DEFAULT 0,
  settlement_fee_pct       numeric(5,2) NOT NULL DEFAULT 0 CHECK (settlement_fee_pct >= 0 AND settlement_fee_pct <= 100),
  settlement_fee_flat      numeric(14,2) NOT NULL DEFAULT 0,
  reserve_pct              numeric(5,2) NOT NULL DEFAULT 0 CHECK (reserve_pct >= 0 AND reserve_pct <= 100),
  reserve_release_days     integer NOT NULL DEFAULT 0,
  effective_from           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_settlement_fee_config_workspace_id_effective_from ON settlement_fee_config(workspace_id, effective_from);

-- settlements
CREATE TABLE settlements (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  currency                 char(3) NOT NULL,
  period_start             date NOT NULL,
  period_end               date NOT NULL,
  settlement_date          date,
  paid                     boolean NOT NULL DEFAULT false,
  total_transactions       integer NOT NULL DEFAULT 0,
  refunds                  integer NOT NULL DEFAULT 0,
  chargebacks              integer NOT NULL DEFAULT 0,
  declined                 integer NOT NULL DEFAULT 0,
  volume                   numeric(16,4) NOT NULL DEFAULT 0,
  approved_cost            numeric(16,4) NOT NULL DEFAULT 0,
  decline_cost             numeric(16,4) NOT NULL DEFAULT 0,
  refund_cost              numeric(16,4) NOT NULL DEFAULT 0,
  chargeback_cost          numeric(16,4) NOT NULL DEFAULT 0,
  mdr                      numeric(16,4) NOT NULL DEFAULT 0,
  volume_fee               numeric(16,4) NOT NULL DEFAULT 0,
  reserve                  numeric(16,4) NOT NULL DEFAULT 0,
  total_fees               numeric(16,4) NOT NULL DEFAULT 0,
  net                      numeric(16,4) NOT NULL DEFAULT 0,
  debit                    numeric(16,4) NOT NULL DEFAULT 0,
  credit                   numeric(16,4) NOT NULL DEFAULT 0,
  report_settings          jsonb,
  source_file              text,
  imported_by_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  imported_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, currency, period_start, period_end)
);
CREATE INDEX idx_settlements_workspace_id ON settlements(workspace_id);

-- notifications
CREATE TABLE notifications (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event                    text NOT NULL,
  title                    text NOT NULL,
  body                     text,
  amount                   numeric(14,2),
  currency                 char(3),
  entity_type              text,
  entity_id                uuid,
  account_id               uuid REFERENCES accounts(id) ON DELETE SET NULL,
  agent_id                 uuid REFERENCES agents(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_workspace_id_created_at ON notifications(workspace_id, created_at);

-- notification_reads
CREATE TABLE notification_reads (
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  notification_id          uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

-- notification_channels
CREATE TABLE notification_channels (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type                     text NOT NULL CHECK (type IN ('telegram')),
  target                   text NOT NULL,
  label                    text,
  events                   text[] NOT NULL DEFAULT ARRAY['payment.paid'],
  active                   boolean NOT NULL DEFAULT true,
  last_error               text,
  last_sent_at             timestamptz,
  created_by_user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, type, target)
);

-- notification_preferences
CREATE TABLE notification_preferences (
  workspace_id             uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  events                   text[] NOT NULL DEFAULT ARRAY['payment.paid','payment.failed','payment.refunded','payment.chargeback','payout.paid'],
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- webhook_events
CREATE TABLE webhook_events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  provider                 text NOT NULL,
  event_type               text,
  provider_event_id        text,
  signature_valid          boolean,
  processed                boolean NOT NULL DEFAULT false,
  payload                  jsonb NOT NULL,
  received_at              timestamptz NOT NULL DEFAULT now(),
  processed_at             timestamptz,
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX idx_webhook_events_processed ON webhook_events(processed) WHERE processed = false;

-- audit_log
CREATE TABLE audit_log (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id             uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  actor_user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  action                   text NOT NULL,
  entity_type              text,
  entity_id                uuid,
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip                       inet,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_workspace_id_created_at ON audit_log(workspace_id, created_at);
CREATE INDEX idx_audit_log_actor_user_id_created_at ON audit_log(actor_user_id, created_at);

COMMIT;
