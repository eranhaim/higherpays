-- HigherPays Multi-Tenant v2
-- PostgreSQL
--
-- Tenant model:
--   Platform
--      ├── Super Admin (global)
--      └── Workspaces (tenants)
--             ├── Members
--             ├── Accounts
--             ├── Agents
--             ├── Customers
--             ├── Payment Links
--             ├── Payments
--             ├── Transactions
--             └── Revenue / Ledger
--
-- Important:
--   workspace_id is the tenant boundary.
--   Users are global identities and can belong to multiple Workspaces.
--   Platform fees are global; Workspace revenue rules are tenant-scoped.
--   This schema is designed to be RLS-ready.
--
-- HigherPays Database Schema
-- PostgreSQL
-- Generated from the HigherPays entity definitions.
-- Notes:
--   * Monetary values use NUMERIC, never FLOAT.
--   * PSP/provider identifiers are namespaced by provider.
--   * Revenue rules are versioned/effective-dated.
--   * Revenue allocation is represented by an internal ledger.
--   * Provider transactions remain distinct from HigherPays payments.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE workspace_status AS ENUM (
    'ACTIVE',
    'SUSPENDED',
    'ARCHIVED'
);

CREATE TYPE user_status AS ENUM (
    'ACTIVE',
    'INVITED',
    'SUSPENDED',
    'DEACTIVATED'
);

CREATE TYPE workspace_member_role AS ENUM (
    'OWNER',
    'ADMIN',
    'AGENT',
    'VIEWER'
);

CREATE TYPE account_status AS ENUM (
    'ACTIVE',
    'SUSPENDED',
    'ARCHIVED'
);

CREATE TYPE account_agent_status AS ENUM (
    'ACTIVE',
    'INACTIVE'
);

CREATE TYPE payment_link_type AS ENUM (
    'CUSTOMER',
    'PUBLIC',
    'REUSABLE'
);

CREATE TYPE payment_link_amount_type AS ENUM (
    'FIXED',
    'CUSTOMER_DEFINED',
    'PROVIDER_DEFINED'
);

CREATE TYPE payment_link_usage_type AS ENUM (
    'SINGLE',
    'MULTIPLE',
    'UNLIMITED'
);

CREATE TYPE payment_link_status AS ENUM (
    'ACTIVE',
    'EXPIRED',
    'DISABLED',
    'ARCHIVED'
);

CREATE TYPE payment_status AS ENUM (
    'PENDING',
    'PAID',
    'FAILED',
    'REFUNDED'
);

CREATE TYPE transaction_status AS ENUM (
    'PENDING',
    'SUCCEEDED',
    'FAILED',
    'REFUNDED',
    'PARTIALLY_REFUNDED',
    'REVERSED'
);

CREATE TYPE revenue_rule_scope AS ENUM (
    'WORKSPACE',
    'ACCOUNT',
    'AGENT'
);

CREATE TYPE revenue_rule_status AS ENUM (
    'DRAFT',
    'ACTIVE',
    'INACTIVE',
    'ARCHIVED'
);

CREATE TYPE fee_calculation_type AS ENUM (
    'PERCENTAGE',
    'FIXED'
);

CREATE TYPE revenue_component_type AS ENUM (
    'PLATFORM_FEE',
    'PROVIDER_FEE',
    'WORKSPACE_SHARE',
    'ACCOUNT_SHARE',
    'AGENT_SHARE',
    'OTHER'
);

CREATE TYPE ledger_entry_type AS ENUM (
    'GROSS_PAYMENT',
    'PROVIDER_FEE',
    'PLATFORM_FEE',
    'WORKSPACE_REVENUE',
    'ACCOUNT_REVENUE',
    'AGENT_REVENUE',
    'REFUND',
    'ADJUSTMENT',
    'OTHER'
);

CREATE TYPE ledger_direction AS ENUM (
    'CREDIT',
    'DEBIT'
);

CREATE TYPE webhook_status AS ENUM (
    'RECEIVED',
    'PROCESSING',
    'PROCESSED',
    'FAILED',
    'IGNORED'
);

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- ============================================================
-- USERS
-- ============================================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email CITEXT NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    status user_status NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- WORKSPACES
-- ============================================================

CREATE TABLE workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    status workspace_status NOT NULL DEFAULT 'ACTIVE',
    default_currency CHAR(3) NOT NULL DEFAULT 'USD',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT workspaces_default_currency_chk
        CHECK (default_currency ~ '^[A-Z]{3}$')
);

CREATE TABLE workspace_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role workspace_member_role NOT NULL,
    status user_status NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT workspace_members_unique_user
        UNIQUE (workspace_id, user_id)
);

-- Only one OWNER per workspace.
CREATE UNIQUE INDEX ux_workspace_one_owner
    ON workspace_members(workspace_id)
    WHERE role = 'OWNER';

-- ============================================================
-- ACCOUNTS
-- ============================================================

CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    external_reference VARCHAR(255),
    status account_status NOT NULL DEFAULT 'ACTIVE',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT accounts_unique_name_per_workspace
        UNIQUE (workspace_id, name)
);

CREATE INDEX ix_accounts_workspace_id
    ON accounts(workspace_id);

CREATE TABLE account_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status account_agent_status NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT account_agents_unique
        UNIQUE (account_id, user_id)
);

CREATE INDEX ix_account_agents_user_id
    ON account_agents(user_id);

-- ============================================================
-- CUSTOMERS
-- ============================================================

CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    email CITEXT,
    name VARCHAR(255),
    phone VARCHAR(50),
    external_reference VARCHAR(255),
    provider_customer_id VARCHAR(255),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_customers_workspace_id
    ON customers(workspace_id);

CREATE INDEX ix_customers_account_id
    ON customers(account_id);

CREATE INDEX ix_customers_email
    ON customers(email);

CREATE INDEX ix_customers_provider_customer
    ON customers(provider_customer_id);

-- ============================================================
-- PAYMENT LINKS / PAGES
-- ============================================================

CREATE TABLE payment_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES users(id) ON DELETE SET NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,

    provider VARCHAR(100) NOT NULL,
    provider_link_id VARCHAR(255) NOT NULL,
    provider_url TEXT NOT NULL,

    link_type payment_link_type NOT NULL,
    amount_type payment_link_amount_type NOT NULL,
    amount NUMERIC(20, 8),
    currency CHAR(3),

    usage_type payment_link_usage_type NOT NULL DEFAULT 'UNLIMITED',
    max_uses INTEGER,
    expires_at TIMESTAMPTZ,

    status payment_link_status NOT NULL DEFAULT 'ACTIVE',
    provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT payment_links_provider_id_unique
        UNIQUE (provider, provider_link_id),

    CONSTRAINT payment_links_amount_non_negative
        CHECK (amount IS NULL OR amount >= 0),

    CONSTRAINT payment_links_max_uses_positive
        CHECK (max_uses IS NULL OR max_uses > 0),

    CONSTRAINT payment_links_currency_chk
        CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),

    CONSTRAINT payment_links_fixed_amount_chk
        CHECK (
            amount_type <> 'FIXED'
            OR amount IS NOT NULL
        ),

    CONSTRAINT payment_links_max_uses_chk
        CHECK (
            usage_type <> 'MULTIPLE'
            OR max_uses IS NOT NULL
        )
);

CREATE INDEX ix_payment_links_workspace_id
    ON payment_links(workspace_id);

CREATE INDEX ix_payment_links_account_id
    ON payment_links(account_id);

CREATE INDEX ix_payment_links_agent_id
    ON payment_links(agent_id);

CREATE INDEX ix_payment_links_customer_id
    ON payment_links(customer_id);

CREATE INDEX ix_payment_links_status
    ON payment_links(status);

-- ============================================================
-- PAYMENTS
-- ============================================================

CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    agent_id UUID REFERENCES users(id) ON DELETE SET NULL,
    payment_link_id UUID REFERENCES payment_links(id) ON DELETE SET NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,

    provider VARCHAR(100) NOT NULL,
    provider_payment_id VARCHAR(255),

    amount NUMERIC(20, 8) NOT NULL,
    currency CHAR(3) NOT NULL,

    status payment_status NOT NULL DEFAULT 'PENDING',
    payment_method VARCHAR(100),

    paid_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    refunded_at TIMESTAMPTZ,

    provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT payments_amount_positive
        CHECK (amount > 0),

    CONSTRAINT payments_currency_chk
        CHECK (currency ~ '^[A-Z]{3}$'),

    CONSTRAINT payments_provider_payment_unique
        UNIQUE NULLS NOT DISTINCT (provider, provider_payment_id)
);

CREATE INDEX ix_payments_workspace_id
    ON payments(workspace_id);

CREATE INDEX ix_payments_account_id
    ON payments(account_id);

CREATE INDEX ix_payments_agent_id
    ON payments(agent_id);

CREATE INDEX ix_payments_payment_link_id
    ON payments(payment_link_id);

CREATE INDEX ix_payments_customer_id
    ON payments(customer_id);

CREATE INDEX ix_payments_status
    ON payments(status);

CREATE INDEX ix_payments_created_at
    ON payments(created_at);

-- ============================================================
-- PROVIDER / HIGHERPAYS TRANSACTIONS
-- ============================================================

CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,

    provider VARCHAR(100) NOT NULL,
    provider_transaction_id VARCHAR(255) NOT NULL,

    amount NUMERIC(20, 8) NOT NULL,
    currency CHAR(3) NOT NULL,

    status transaction_status NOT NULL DEFAULT 'PENDING',

    provider_fee NUMERIC(20, 8) NOT NULL DEFAULT 0,
    net_amount NUMERIC(20, 8) NOT NULL,

    provider_created_at TIMESTAMPTZ,
    settled_at TIMESTAMPTZ,
    reconciled_at TIMESTAMPTZ,

    provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT transactions_provider_id_unique
        UNIQUE (provider, provider_transaction_id),

    CONSTRAINT transactions_amount_positive
        CHECK (amount > 0),

    CONSTRAINT transactions_provider_fee_non_negative
        CHECK (provider_fee >= 0),

    CONSTRAINT transactions_currency_chk
        CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE INDEX ix_transactions_payment_id
    ON transactions(payment_id);

CREATE INDEX ix_transactions_account_id
    ON transactions(account_id);

CREATE INDEX ix_transactions_workspace_id
    ON transactions(workspace_id);

CREATE INDEX ix_transactions_status
    ON transactions(status);

CREATE INDEX ix_transactions_provider_created_at
    ON transactions(provider_created_at);

-- ============================================================
-- PLATFORM FEE RULES
-- Super Admin controlled / global.
-- ============================================================

CREATE TABLE platform_fee_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name VARCHAR(255) NOT NULL,
    fee_type revenue_component_type NOT NULL,
    calculation_type fee_calculation_type NOT NULL,

    value NUMERIC(20, 8) NOT NULL,
    currency CHAR(3),

    effective_from TIMESTAMPTZ NOT NULL,
    effective_until TIMESTAMPTZ,

    status revenue_rule_status NOT NULL DEFAULT 'ACTIVE',

    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT platform_fee_rules_value_non_negative
        CHECK (value >= 0),

    CONSTRAINT platform_fee_rules_percentage_chk
        CHECK (
            calculation_type <> 'PERCENTAGE'
            OR value <= 100
        ),

    CONSTRAINT platform_fee_rules_date_chk
        CHECK (
            effective_until IS NULL
            OR effective_until > effective_from
        ),

    CONSTRAINT platform_fee_rules_currency_chk
        CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$')
);

CREATE INDEX ix_platform_fee_rules_effective
    ON platform_fee_rules(effective_from, effective_until);

-- ============================================================
-- WORKSPACE REVENUE RULES
-- ============================================================

CREATE TABLE revenue_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

    name VARCHAR(255) NOT NULL,
    scope_type revenue_rule_scope NOT NULL,

    account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES users(id) ON DELETE CASCADE,

    priority INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,

    effective_from TIMESTAMPTZ NOT NULL,
    effective_until TIMESTAMPTZ,

    status revenue_rule_status NOT NULL DEFAULT 'DRAFT',

    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT revenue_rules_scope_chk
        CHECK (
            (scope_type = 'WORKSPACE' AND account_id IS NULL AND agent_id IS NULL)
            OR
            (scope_type = 'ACCOUNT' AND account_id IS NOT NULL AND agent_id IS NULL)
            OR
            (scope_type = 'AGENT' AND agent_id IS NOT NULL)
        ),

    CONSTRAINT revenue_rules_date_chk
        CHECK (
            effective_until IS NULL
            OR effective_until > effective_from
        ),

    CONSTRAINT revenue_rules_priority_positive
        CHECK (priority >= 0),

    CONSTRAINT revenue_rules_version_positive
        CHECK (version > 0)
);

CREATE INDEX ix_revenue_rules_workspace_id
    ON revenue_rules(workspace_id);

CREATE INDEX ix_revenue_rules_account_id
    ON revenue_rules(account_id);

CREATE INDEX ix_revenue_rules_agent_id
    ON revenue_rules(agent_id);

CREATE INDEX ix_revenue_rules_effective
    ON revenue_rules(workspace_id, effective_from, effective_until);

CREATE UNIQUE INDEX ux_revenue_rules_workspace_version
    ON revenue_rules(workspace_id, id, version);

-- ============================================================
-- REVENUE RULE COMPONENTS
-- ============================================================

CREATE TABLE revenue_rule_components (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    revenue_rule_id UUID NOT NULL REFERENCES revenue_rules(id) ON DELETE CASCADE,

    component_type revenue_component_type NOT NULL,
    calculation_type fee_calculation_type NOT NULL,

    value NUMERIC(20, 8) NOT NULL,
    fixed_amount NUMERIC(20, 8),
    currency CHAR(3),

    priority INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT revenue_components_value_non_negative
        CHECK (value >= 0),

    CONSTRAINT revenue_components_fixed_amount_non_negative
        CHECK (fixed_amount IS NULL OR fixed_amount >= 0),

    CONSTRAINT revenue_components_percentage_chk
        CHECK (
            calculation_type <> 'PERCENTAGE'
            OR value <= 100
        ),

    CONSTRAINT revenue_components_fixed_chk
        CHECK (
            calculation_type <> 'FIXED'
            OR fixed_amount IS NOT NULL
        ),

    CONSTRAINT revenue_components_currency_chk
        CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$')
);

CREATE INDEX ix_revenue_rule_components_rule_id
    ON revenue_rule_components(revenue_rule_id);

-- ============================================================
-- INTERNAL REVENUE LEDGER
-- ============================================================

CREATE TABLE ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

    account_id UUID REFERENCES accounts(id) ON DELETE RESTRICT,
    agent_id UUID REFERENCES users(id) ON DELETE RESTRICT,

    payment_id UUID REFERENCES payments(id) ON DELETE RESTRICT,
    transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,

    entry_type ledger_entry_type NOT NULL,
    amount NUMERIC(20, 8) NOT NULL,
    currency CHAR(3) NOT NULL,
    direction ledger_direction NOT NULL,

    description TEXT,

    revenue_rule_id UUID REFERENCES revenue_rules(id) ON DELETE SET NULL,
    rule_version INTEGER,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ledger_entries_amount_positive
        CHECK (amount > 0),

    CONSTRAINT ledger_entries_currency_chk
        CHECK (currency ~ '^[A-Z]{3}$'),

    CONSTRAINT ledger_entries_rule_version_chk
        CHECK (
            rule_version IS NULL
            OR rule_version > 0
        )
);

CREATE INDEX ix_ledger_entries_workspace_id
    ON ledger_entries(workspace_id);

CREATE INDEX ix_ledger_entries_account_id
    ON ledger_entries(account_id);

CREATE INDEX ix_ledger_entries_agent_id
    ON ledger_entries(agent_id);

CREATE INDEX ix_ledger_entries_payment_id
    ON ledger_entries(payment_id);

CREATE INDEX ix_ledger_entries_transaction_id
    ON ledger_entries(transaction_id);

CREATE INDEX ix_ledger_entries_created_at
    ON ledger_entries(created_at);

-- ============================================================
-- REVENUE SNAPSHOTS
-- Optional aggregation/cache layer for dashboards.
-- ============================================================

CREATE TABLE revenue_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES users(id) ON DELETE CASCADE,

    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,

    gross_revenue NUMERIC(20, 8) NOT NULL DEFAULT 0,
    provider_fees NUMERIC(20, 8) NOT NULL DEFAULT 0,
    platform_fees NUMERIC(20, 8) NOT NULL DEFAULT 0,
    workspace_revenue NUMERIC(20, 8) NOT NULL DEFAULT 0,
    account_revenue NUMERIC(20, 8) NOT NULL DEFAULT 0,
    agent_revenue NUMERIC(20, 8) NOT NULL DEFAULT 0,
    net_revenue NUMERIC(20, 8) NOT NULL DEFAULT 0,

    currency CHAR(3) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT revenue_snapshots_period_chk
        CHECK (period_end > period_start),

    CONSTRAINT revenue_snapshots_currency_chk
        CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE INDEX ix_revenue_snapshots_workspace_period
    ON revenue_snapshots(workspace_id, period_start, period_end);

CREATE INDEX ix_revenue_snapshots_account_period
    ON revenue_snapshots(account_id, period_start, period_end);

CREATE INDEX ix_revenue_snapshots_agent_period
    ON revenue_snapshots(agent_id, period_start, period_end);

-- ============================================================
-- PROVIDER WEBHOOK EVENTS
-- ============================================================

CREATE TABLE provider_webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    provider VARCHAR(100) NOT NULL,
    provider_event_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(255) NOT NULL,

    payload JSONB NOT NULL,
    signature TEXT,

    status webhook_status NOT NULL DEFAULT 'RECEIVED',

    processed_at TIMESTAMPTZ,
    error_message TEXT,

    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT provider_webhook_events_unique
        UNIQUE (provider, provider_event_id)
);

CREATE INDEX ix_provider_webhook_events_status
    ON provider_webhook_events(status);

CREATE INDEX ix_provider_webhook_events_received_at
    ON provider_webhook_events(received_at);

-- ============================================================
-- AUDIT LOG
-- ============================================================

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,

    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100) NOT NULL,
    entity_id UUID,

    old_values JSONB,
    new_values JSONB,

    ip_address INET,
    user_agent TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_audit_logs_workspace_id
    ON audit_logs(workspace_id);

CREATE INDEX ix_audit_logs_user_id
    ON audit_logs(user_id);

CREATE INDEX ix_audit_logs_entity
    ON audit_logs(entity_type, entity_id);

CREATE INDEX ix_audit_logs_created_at
    ON audit_logs(created_at);

-- ============================================================
-- UPDATED_AT TRIGGERS
-- ============================================================

CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_workspaces_updated_at
BEFORE UPDATE ON workspaces
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_workspace_members_updated_at
BEFORE UPDATE ON workspace_members
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_accounts_updated_at
BEFORE UPDATE ON accounts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_account_agents_updated_at
BEFORE UPDATE ON account_agents
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_customers_updated_at
BEFORE UPDATE ON customers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_payment_links_updated_at
BEFORE UPDATE ON payment_links
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_payments_updated_at
BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_transactions_updated_at
BEFORE UPDATE ON transactions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_platform_fee_rules_updated_at
BEFORE UPDATE ON platform_fee_rules
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_revenue_rules_updated_at
BEFORE UPDATE ON revenue_rules
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- BASIC CROSS-TABLE CONSISTENCY
-- ============================================================

-- Ensure an account belongs to the same workspace as its customer.
CREATE OR REPLACE FUNCTION validate_customer_account_workspace()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.account_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1
            FROM accounts a
            WHERE a.id = NEW.account_id
              AND a.workspace_id = NEW.workspace_id
        ) THEN
            RAISE EXCEPTION
                'Customer account_id % does not belong to workspace %',
                NEW.account_id,
                NEW.workspace_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_customer_account_workspace
BEFORE INSERT OR UPDATE ON customers
FOR EACH ROW EXECUTE FUNCTION validate_customer_account_workspace();

-- Ensure Payment Link references stay inside the same workspace/account.
CREATE OR REPLACE FUNCTION validate_payment_link_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM accounts a
        WHERE a.id = NEW.account_id
          AND a.workspace_id = NEW.workspace_id
    ) THEN
        RAISE EXCEPTION
            'Payment Link account_id % does not belong to workspace %',
            NEW.account_id,
            NEW.workspace_id;
    END IF;

    IF NEW.customer_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1
            FROM customers c
            WHERE c.id = NEW.customer_id
              AND c.workspace_id = NEW.workspace_id
        ) THEN
            RAISE EXCEPTION
                'Payment Link customer_id % does not belong to workspace %',
                NEW.customer_id,
                NEW.workspace_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_payment_link_scope
BEFORE INSERT OR UPDATE ON payment_links
FOR EACH ROW EXECUTE FUNCTION validate_payment_link_scope();

-- Ensure Payment references remain inside the same workspace/account.
CREATE OR REPLACE FUNCTION validate_payment_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM accounts a
        WHERE a.id = NEW.account_id
          AND a.workspace_id = NEW.workspace_id
    ) THEN
        RAISE EXCEPTION
            'Payment account_id % does not belong to workspace %',
            NEW.account_id,
            NEW.workspace_id;
    END IF;

    IF NEW.payment_link_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1
            FROM payment_links pl
            WHERE pl.id = NEW.payment_link_id
              AND pl.workspace_id = NEW.workspace_id
              AND pl.account_id = NEW.account_id
        ) THEN
            RAISE EXCEPTION
                'Payment Link % does not belong to the same workspace/account',
                NEW.payment_link_id;
        END IF;
    END IF;

    IF NEW.customer_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1
            FROM customers c
            WHERE c.id = NEW.customer_id
              AND c.workspace_id = NEW.workspace_id
        ) THEN
            RAISE EXCEPTION
                'Payment customer_id % does not belong to workspace %',
                NEW.customer_id,
                NEW.workspace_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_payment_scope
BEFORE INSERT OR UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION validate_payment_scope();

-- ============================================================
-- END
-- ============================================================

-- ============================================================
-- MULTI-TENANT V2 ADDITIONS
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- Global platform-level role.
CREATE TYPE platform_user_role AS ENUM ('SUPER_ADMIN');

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_platform_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS ix_users_platform_super_admin
    ON users(id)
    WHERE is_platform_super_admin = TRUE;

-- Stable tenant slug.
ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS slug CITEXT;

-- Existing workspaces need a slug before the UNIQUE constraint is added.
-- For existing data, populate this column with a migration-specific value
-- before making it NOT NULL.
CREATE UNIQUE INDEX IF NOT EXISTS ux_workspaces_slug
    ON workspaces(slug)
    WHERE slug IS NOT NULL;

ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ============================================================
-- WORKSPACE-SCOPED PSP ACCOUNTS
-- Allows MantaPay today and additional PSPs later.
-- ============================================================

CREATE TABLE IF NOT EXISTS provider_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

    provider VARCHAR(100) NOT NULL,
    provider_account_id VARCHAR(255) NOT NULL,
    display_name VARCHAR(255),

    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',

    -- Encrypt secrets/tokens at the application/KMS layer.
    credentials_encrypted JSONB NOT NULL DEFAULT '{}'::jsonb,
    configuration JSONB NOT NULL DEFAULT '{}'::jsonb,

    is_default BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT provider_accounts_provider_id_unique
        UNIQUE (workspace_id, provider, provider_account_id)
);

CREATE INDEX IF NOT EXISTS ix_provider_accounts_workspace
    ON provider_accounts(workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_provider_accounts_one_default
    ON provider_accounts(workspace_id)
    WHERE is_default = TRUE AND status = 'ACTIVE';

-- ============================================================
-- TENANT-SAFE UNIQUE INDEXES
-- These make it explicit that provider IDs are unique only
-- inside a tenant/provider namespace.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_links_tenant_provider
    ON payment_links(workspace_id, provider, provider_link_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_tenant_provider_payment
    ON payments(workspace_id, provider, provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_tenant_provider
    ON transactions(workspace_id, provider, provider_transaction_id);

-- ============================================================
-- RLS PREPARATION
--
-- The application can later establish:
--
--   SET LOCAL app.current_workspace_id = '<workspace UUID>';
--
-- Then enable RLS per tenant table with:
--
--   USING (
--      workspace_id =
--      current_setting('app.current_workspace_id', true)::uuid
--   )
--
-- Do NOT enable this automatically until the application middleware
-- consistently sets the tenant context inside every DB transaction.
-- ============================================================

COMMENT ON TABLE workspaces IS
    'Primary tenant boundary for HigherPays.';

COMMENT ON COLUMN users.is_platform_super_admin IS
    'Global platform privilege. Not tied to a Workspace.';

COMMENT ON TABLE provider_accounts IS
    'Workspace-scoped PSP configuration; supports MantaPay and future PSPs.';

COMMIT;
