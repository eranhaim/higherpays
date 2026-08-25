--
-- PostgreSQL database dump
--

\restrict iO1Pm0qcnteVhMP3Ik1j8KxcOB7d4JgrUvez8LWEB37pYgAA5hkkmSleX3toeA7

-- Dumped from database version 16.11
-- Dumped by pg_dump version 16.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: account_revenue_model; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.account_revenue_model AS ENUM (
    'revshare',
    'salary',
    'ai'
);


--
-- Name: account_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.account_status AS ENUM (
    'onboarding',
    'active',
    'paused',
    'archived'
);


--
-- Name: compliance_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.compliance_status AS ENUM (
    'unverified',
    'pending_review',
    'verified',
    'rejected',
    'expired'
);


--
-- Name: content_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.content_type AS ENUM (
    'photo',
    'video',
    'ppv',
    'custom',
    'vip'
);


--
-- Name: customer_segment; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.customer_segment AS ENUM (
    'new',
    'regular',
    'high_value',
    'vip',
    'inactive',
    'at_risk'
);


--
-- Name: entity_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.entity_status AS ENUM (
    'active',
    'suspended',
    'pending',
    'archived'
);


--
-- Name: link_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.link_status AS ENUM (
    'created',
    'opened',
    'paid',
    'failed',
    'refunded',
    'expired'
);


--
-- Name: payout_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payout_status AS ENUM (
    'pending',
    'approved',
    'paid',
    'on_hold',
    'recorded'
);


--
-- Name: platform_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.platform_role AS ENUM (
    'super_admin',
    'support',
    'finance'
);


--
-- Name: pricing_mode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pricing_mode AS ENUM (
    'fixed',
    'open'
);


--
-- Name: txn_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.txn_status AS ENUM (
    'approved',
    'declined',
    'refunded',
    'charged_back'
);


--
-- Name: txn_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.txn_type AS ENUM (
    'payment',
    'refund',
    'chargeback',
    'adjustment'
);


--
-- Name: current_user_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_user_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;


--
-- Name: current_workspace_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_workspace_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid;
$$;


--
-- Name: effective_decline_fee(uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.effective_decline_fee(org uuid, at timestamp with time zone) RETURNS numeric
    LANGUAGE sql STABLE
    AS $$
  SELECT COALESCE((SELECT decline_fee FROM settlement_fee_config
                   WHERE organization_id = org AND effective_from <= at
                   ORDER BY effective_from DESC LIMIT 1), 0);
$$;


--
-- Name: effective_platform_fee(uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.effective_platform_fee(org uuid, at timestamp with time zone) RETURNS TABLE(psp_rate_pct numeric, margin_rate_pct numeric, blended_rate_pct numeric)
    LANGUAGE sql STABLE
    AS $$
  SELECT psp_rate_pct, margin_rate_pct, blended_rate_pct
  FROM platform_fee_rates
  WHERE organization_id = org AND effective_from <= at
  ORDER BY effective_from DESC
  LIMIT 1;
$$;


--
-- Name: effective_psp_fixed_fee(uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.effective_psp_fixed_fee(org uuid, at timestamp with time zone) RETURNS numeric
    LANGUAGE sql STABLE
    AS $$
  SELECT COALESCE((SELECT psp_fixed_fee FROM platform_fee_rates
                   WHERE organization_id = org AND effective_from <= at
                   ORDER BY effective_from DESC LIMIT 1), 0);
$$;


--
-- Name: effective_refund_fee(uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.effective_refund_fee(org uuid, at timestamp with time zone) RETURNS numeric
    LANGUAGE sql STABLE
    AS $$
  SELECT COALESCE((SELECT refund_fee FROM settlement_fee_config
                   WHERE organization_id = org AND effective_from <= at
                   ORDER BY effective_from DESC LIMIT 1), 0);
$$;


--
-- Name: effective_reserve(uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.effective_reserve(org uuid, at timestamp with time zone) RETURNS TABLE(reserve_pct numeric, reserve_release_days integer)
    LANGUAGE sql STABLE
    AS $$
  SELECT reserve_pct, reserve_release_days FROM settlement_fee_config
   WHERE organization_id = org AND effective_from <= at
   ORDER BY effective_from DESC LIMIT 1;
$$;


--
-- Name: effective_settlement_fees(uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.effective_settlement_fees(org uuid, at timestamp with time zone) RETURNS TABLE(chargeback_fee numeric, settlement_fee_pct numeric, settlement_fee_flat numeric)
    LANGUAGE sql STABLE
    AS $$
  SELECT chargeback_fee, settlement_fee_pct, settlement_fee_flat
  FROM settlement_fee_config
  WHERE organization_id = org AND effective_from <= at
  ORDER BY effective_from DESC LIMIT 1;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: commission_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    account_id uuid,
    agent_membership_id uuid,
    entry_type text NOT NULL,
    revenue_model public.account_revenue_model,
    gross numeric NOT NULL,
    platform_fee numeric NOT NULL,
    platform_margin numeric NOT NULL,
    psp_fee numeric NOT NULL,
    distributable numeric NOT NULL,
    account_amount numeric NOT NULL,
    agent_amount numeric NOT NULL,
    agency_amount numeric NOT NULL,
    chargeback_fee numeric DEFAULT 0 NOT NULL,
    status text DEFAULT 'locked'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    account_payout_id uuid,
    agent_payout_id uuid,
    account_paid_at timestamp with time zone,
    agent_paid_at timestamp with time zone,
    fee_mdr numeric(14,4) DEFAULT 0 NOT NULL,
    fee_fixed numeric(14,4) DEFAULT 0 NOT NULL,
    fee_settlement numeric(14,4) DEFAULT 0 NOT NULL,
    fee_surcharge numeric(14,4) DEFAULT 0 NOT NULL,
    CONSTRAINT commission_entries_entry_type_check CHECK ((entry_type = ANY (ARRAY['sale'::text, 'chargeback'::text, 'refund'::text])))
);

ALTER TABLE ONLY public.commission_entries FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN commission_entries.fee_mdr; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.commission_entries.fee_mdr IS 'Provider processing commission (MDR).';


--
-- Name: COLUMN commission_entries.fee_fixed; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.commission_entries.fee_fixed IS 'Provider per-approved-transaction fee.';


--
-- Name: COLUMN commission_entries.fee_settlement; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.commission_entries.fee_settlement IS 'Provider settlement fee.';


--
-- Name: COLUMN commission_entries.fee_surcharge; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.commission_entries.fee_surcharge IS 'Surcharge collected FROM the payer (revenue, not a cost).';


--
-- Name: fn_post_chargeback(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_post_chargeback(tx uuid) RETURNS public.commission_entries
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  s commission_entries; org uuid; cbfee numeric := 0;
  acct_amt numeric; agent_amt numeric; agency_amt numeric; entry commission_entries;
BEGIN
  SELECT * INTO s FROM commission_entries WHERE transaction_id = tx AND entry_type = 'sale';
  IF NOT FOUND THEN RAISE EXCEPTION 'no sale entry for transaction %', tx; END IF;
  IF EXISTS (SELECT 1 FROM commission_entries WHERE transaction_id = tx AND entry_type IN ('chargeback','refund')) THEN
    RAISE EXCEPTION 'transaction % already reversed', tx;
  END IF;

  SELECT organization_id INTO org FROM workspaces WHERE id = s.workspace_id;
  SELECT chargeback_fee INTO cbfee FROM effective_settlement_fees(org, now());
  cbfee := COALESCE(cbfee,0);

  agent_amt := - s.agent_amount;
  IF s.revenue_model = 'revshare' THEN
    acct_amt   := - s.account_amount - cbfee;
    agency_amt := - s.agency_amount;
  ELSE
    acct_amt   := 0;
    agency_amt := - s.agency_amount - cbfee;
  END IF;

  INSERT INTO commission_entries(
    workspace_id,transaction_id,account_id,agent_membership_id,entry_type,revenue_model,
    gross,platform_fee,platform_margin,psp_fee,distributable,account_amount,agent_amount,agency_amount,chargeback_fee,status)
  VALUES(
    s.workspace_id,s.transaction_id,s.account_id,s.agent_membership_id,'chargeback',s.revenue_model,
    - s.gross, - s.platform_fee, - s.platform_margin, - s.psp_fee, - s.distributable, acct_amt, agent_amt, agency_amt, cbfee, 'locked')
  RETURNING * INTO entry;

  UPDATE commission_entries SET status = 'reversed' WHERE id = s.id;
  RETURN entry;
END $$;


--
-- Name: fn_post_refund(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_post_refund(tx uuid) RETURNS public.commission_entries
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  s commission_entries; org uuid; rfee numeric := 0;
  acct_amt numeric; agent_amt numeric; agency_amt numeric; entry commission_entries;
BEGIN
  SELECT * INTO s FROM commission_entries WHERE transaction_id = tx AND entry_type = 'sale';
  IF NOT FOUND THEN RAISE EXCEPTION 'no sale entry for transaction %', tx; END IF;
  IF EXISTS (SELECT 1 FROM commission_entries WHERE transaction_id = tx AND entry_type IN ('refund','chargeback')) THEN
    RAISE EXCEPTION 'transaction % already reversed', tx;
  END IF;

  SELECT organization_id INTO org FROM workspaces WHERE id = s.workspace_id;
  rfee := effective_refund_fee(org, now());

  agent_amt := - s.agent_amount;
  IF s.revenue_model = 'revshare' THEN
    acct_amt   := - s.account_amount - rfee;
    agency_amt := - s.agency_amount;
  ELSE
    acct_amt   := 0;
    agency_amt := - s.agency_amount - rfee;
  END IF;

  INSERT INTO commission_entries(
    workspace_id,transaction_id,account_id,agent_membership_id,entry_type,revenue_model,
    gross,platform_fee,platform_margin,psp_fee,distributable,account_amount,agent_amount,agency_amount,chargeback_fee,status)
  VALUES(
    s.workspace_id,s.transaction_id,s.account_id,s.agent_membership_id,'refund',s.revenue_model,
    - s.gross, - s.platform_fee, - s.platform_margin, - s.psp_fee, - s.distributable, acct_amt, agent_amt, agency_amt, rfee, 'locked')
  RETURNING * INTO entry;

  UPDATE commission_entries SET status = 'reversed' WHERE id = s.id;
  RETURN entry;
END $$;


--
-- Name: fn_post_sale(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_post_sale(tx uuid) RETURNS public.commission_entries
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  t transactions; acct accounts; org uuid;
  margin numeric := 0; agentpct numeric := 0; m_agentpct numeric;
  b record; margin_val numeric; plat_fee numeric;
  model account_revenue_model := 'ai';
  split numeric := 0; dist numeric;
  acct_amt numeric; agent_amt numeric; agency_amt numeric;
  psp_fee_val numeric; entry commission_entries;
BEGIN
  SELECT * INTO t FROM transactions WHERE id = tx;
  IF NOT FOUND THEN RAISE EXCEPTION 'transaction % not found', tx; END IF;

  IF t.account_id IS NOT NULL THEN
    SELECT * INTO acct FROM accounts WHERE id = t.account_id;
    IF FOUND THEN model := acct.revenue_model; split := acct.revenue_split_pct; END IF;
  END IF;
  IF model <> 'revshare' THEN split := 0; END IF;

  SELECT organization_id INTO org FROM workspaces WHERE id = t.workspace_id;
  SELECT margin_rate_pct INTO margin FROM effective_platform_fee(org, t.occurred_at);
  margin := COALESCE(margin, 0);

  SELECT * INTO b FROM psp_cost_breakdown(org, t.gross, t.occurred_at);
  margin_val := round((t.gross * margin) / 100, 2);
  plat_fee   := round(b.total + margin_val, 2);

  SELECT agent_pct INTO agentpct FROM commission_rules
    WHERE workspace_id = t.workspace_id AND account_id IS NULL AND effective_from <= t.occurred_at
    ORDER BY effective_from DESC LIMIT 1;
  agentpct := COALESCE(agentpct, 0);
  IF t.attributed_membership_id IS NOT NULL THEN
    SELECT commission_pct INTO m_agentpct FROM memberships WHERE id = t.attributed_membership_id;
    IF m_agentpct IS NOT NULL THEN agentpct := m_agentpct; END IF;
  END IF;

  IF split + agentpct > 100 THEN
    RAISE EXCEPTION 'split_exceeds_100: account %%% + agent %%% on transaction %', split, agentpct, tx;
  END IF;

  IF t.fee IS NOT NULL AND t.fee > 0 THEN psp_fee_val := t.fee; ELSE psp_fee_val := b.total; END IF;

  dist := t.gross - plat_fee;
  IF dist <= 0 THEN
    RAISE EXCEPTION 'nothing_to_distribute: gross % minus fees % on transaction %', t.gross, plat_fee, tx;
  END IF;

  acct_amt   := round((dist * split) / 100, 2);
  agent_amt  := round((dist * agentpct) / 100, 2);
  agency_amt := dist - acct_amt - agent_amt;

  INSERT INTO commission_entries(
    workspace_id,transaction_id,account_id,agent_membership_id,entry_type,revenue_model,
    gross,platform_fee,platform_margin,psp_fee,distributable,
    account_amount,agent_amount,agency_amount,chargeback_fee,status,
    fee_mdr,fee_fixed,fee_settlement,fee_surcharge)
  VALUES(
    t.workspace_id,t.id,t.account_id,t.attributed_membership_id,'sale',model,
    t.gross,plat_fee,margin_val,psp_fee_val,dist,
    acct_amt,agent_amt,agency_amt,0,'locked',
    b.mdr,b.fixed,b.settlement,COALESCE(t.surcharge,0))
  RETURNING * INTO entry;
  RETURN entry;
END;
$$;


--
-- Name: is_platform_context(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_platform_context() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT current_setting('app.platform_admin', true) = 'on';
$$;


--
-- Name: psp_cost(uuid, numeric, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.psp_cost(org uuid, gross numeric, at timestamp with time zone) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  r record; mdr numeric; sett numeric; fixed numeric; bal numeric; cost numeric;
BEGIN
  SELECT fee_model, psp_rate_pct, mdr_pct, settlement_pct, psp_fixed_fee
    INTO r
    FROM platform_fee_rates
   WHERE organization_id = org AND effective_from <= at
   ORDER BY effective_from DESC LIMIT 1;
  IF NOT FOUND THEN RETURN 0; END IF;

  fixed := COALESCE(r.psp_fixed_fee, 0);
  -- When mdr/settlement are not itemised, treat psp_rate_pct as the whole percentage.
  mdr   := COALESCE(r.mdr_pct, r.psp_rate_pct, 0);
  sett  := COALESCE(r.settlement_pct, 0);
  IF r.mdr_pct IS NULL THEN sett := 0; END IF;

  IF r.fee_model = 'cascade' THEN
    bal  := gross - (gross * mdr / 100);   -- 1) processing commission
    bal  := bal - fixed;                   -- 2) per-approved-transaction fee
    bal  := bal - (bal * sett / 100);      -- 3) settlement fee on the remainder
    cost := gross - bal;
  ELSE
    cost := (gross * mdr / 100) + fixed + (gross * sett / 100);
  END IF;
  RETURN cost;
END;
$$;


--
-- Name: psp_cost_breakdown(uuid, numeric, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.psp_cost_breakdown(org uuid, gross numeric, at timestamp with time zone) RETURNS TABLE(mdr numeric, fixed numeric, settlement numeric, total numeric)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  r record; m numeric; s numeric; f numeric; bal numeric;
BEGIN
  SELECT fee_model, psp_rate_pct, mdr_pct, settlement_pct, psp_fixed_fee
    INTO r FROM platform_fee_rates
   WHERE organization_id = org AND effective_from <= at
   ORDER BY effective_from DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::numeric, 0::numeric, 0::numeric, 0::numeric; RETURN;
  END IF;

  f := COALESCE(r.psp_fixed_fee, 0);
  m := COALESCE(r.mdr_pct, r.psp_rate_pct, 0);
  s := COALESCE(r.settlement_pct, 0);
  IF r.mdr_pct IS NULL THEN s := 0; END IF;   -- rate not itemised: all of it is MDR

  IF r.fee_model = 'cascade' THEN
    mdr := gross * m / 100;
    bal := gross - mdr;
    fixed := f;
    bal := bal - fixed;
    settlement := bal * s / 100;
  ELSE
    mdr := gross * m / 100;
    fixed := f;
    settlement := gross * s / 100;
  END IF;
  total := mdr + fixed + settlement;
  RETURN QUERY SELECT mdr, fixed, settlement, total;
END;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: workspace_blended_rate(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.workspace_blended_rate(ws uuid) RETURNS numeric
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE((
    SELECT pf.blended_rate_pct
    FROM platform_fee_rates pf
    JOIN workspaces w ON w.organization_id = pf.organization_id
    WHERE w.id = ws
    ORDER BY pf.effective_from DESC
    LIMIT 1
  ), 0);
$$;


--
-- Name: account_agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.account_agents FORCE ROW LEVEL SECURITY;


--
-- Name: account_compliance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_compliance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    status public.compliance_status DEFAULT 'unverified'::public.compliance_status NOT NULL,
    age_verified boolean DEFAULT false NOT NULL,
    date_of_birth date,
    id_document_ref text,
    verification_method text,
    verified_by uuid,
    verified_at timestamp with time zone,
    expires_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.account_compliance FORCE ROW LEVEL SECURITY;


--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    stage_name text NOT NULL,
    handle text,
    legal_name text,
    country character(2),
    status public.account_status DEFAULT 'onboarding'::public.account_status NOT NULL,
    revenue_split_pct numeric(5,2) DEFAULT 70.00 NOT NULL,
    brand jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revenue_model public.account_revenue_model DEFAULT 'revshare'::public.account_revenue_model NOT NULL,
    salary numeric,
    salary_increase_pct numeric DEFAULT 0,
    user_id uuid,
    CONSTRAINT accounts_revenue_split_pct_check CHECK (((revenue_split_pct >= (0)::numeric) AND (revenue_split_pct <= (100)::numeric)))
);

ALTER TABLE ONLY public.accounts FORCE ROW LEVEL SECURITY;


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    workspace_id uuid,
    actor_user_id uuid,
    action text NOT NULL,
    entity_type text,
    entity_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    ip inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.audit_log FORCE ROW LEVEL SECURITY;


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: commission_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    account_id uuid,
    account_split_pct numeric(5,2) NOT NULL,
    agency_split_pct numeric(5,2) NOT NULL,
    agent_pct numeric(5,2) DEFAULT 0 NOT NULL,
    effective_from timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commission_rules_account_split_pct_check CHECK (((account_split_pct >= (0)::numeric) AND (account_split_pct <= (100)::numeric))),
    CONSTRAINT commission_rules_agency_split_pct_check CHECK (((agency_split_pct >= (0)::numeric) AND (agency_split_pct <= (100)::numeric))),
    CONSTRAINT commission_rules_agent_pct_check CHECK (((agent_pct >= (0)::numeric) AND (agent_pct <= (100)::numeric)))
);

ALTER TABLE ONLY public.commission_rules FORCE ROW LEVEL SECURITY;


--
-- Name: content_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    type public.content_type NOT NULL,
    category text,
    price_suggestion numeric(12,2),
    currency character(3),
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    storage_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.content_items FORCE ROW LEVEL SECURITY;


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    account_id uuid,
    alias text NOT NULL,
    email public.citext,
    phone text,
    country character(2),
    segment public.customer_segment DEFAULT 'new'::public.customer_segment NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    total_spend numeric(14,2) DEFAULT 0 NOT NULL,
    first_purchase_at timestamp with time zone,
    last_purchase_at timestamp with time zone,
    consent_marketing boolean DEFAULT false NOT NULL,
    consent_recorded_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.customers FORCE ROW LEVEL SECURITY;


--
-- Name: invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    email text NOT NULL,
    role text NOT NULL,
    account_id uuid,
    token_hash text NOT NULL,
    invited_by uuid,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: kpi_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kpi_targets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    membership_id uuid,
    metric text NOT NULL,
    target_value numeric NOT NULL,
    period text DEFAULT 'month'::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT kpi_targets_metric_check CHECK ((metric = ANY (ARRAY['gross'::text, 'sales'::text, 'aov'::text, 'buyers'::text, 'conversion'::text]))),
    CONSTRAINT kpi_targets_period_check CHECK ((period = ANY (ARRAY['day'::text, 'week'::text, 'month'::text, 'quarter'::text]))),
    CONSTRAINT kpi_targets_target_value_check CHECK ((target_value >= (0)::numeric))
);

ALTER TABLE ONLY public.kpi_targets FORCE ROW LEVEL SECURITY;


--
-- Name: memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    status public.entity_status DEFAULT 'active'::public.entity_status NOT NULL,
    shift text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    commission_pct numeric,
    CONSTRAINT memberships_commission_pct_check CHECK (((commission_pct IS NULL) OR ((commission_pct >= (0)::numeric) AND (commission_pct <= (100)::numeric))))
);

ALTER TABLE ONLY public.memberships FORCE ROW LEVEL SECURITY;


--
-- Name: notification_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    type text NOT NULL,
    target text NOT NULL,
    label text,
    events text[] DEFAULT ARRAY['payment.paid'::text] NOT NULL,
    active boolean DEFAULT true NOT NULL,
    last_error text,
    last_sent_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_channels_type_check CHECK ((type = 'telegram'::text))
);

ALTER TABLE ONLY public.notification_channels FORCE ROW LEVEL SECURITY;


--
-- Name: notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_preferences (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    events text[] DEFAULT ARRAY['payment.paid'::text, 'payment.failed'::text, 'payment.refunded'::text, 'payment.chargeback'::text, 'payout.paid'::text] NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.notification_preferences FORCE ROW LEVEL SECURITY;


--
-- Name: notification_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_reads (
    notification_id uuid NOT NULL,
    user_id uuid NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    event text NOT NULL,
    title text NOT NULL,
    body text,
    amount numeric(14,2),
    currency character(3),
    entity_type text,
    entity_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.notifications FORCE ROW LEVEL SECURITY;


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    status public.entity_status DEFAULT 'active'::public.entity_status NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.organizations FORCE ROW LEVEL SECURITY;


--
-- Name: payment_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    customer_id uuid,
    created_by uuid,
    content_id uuid,
    description text,
    amount numeric(12,2),
    currency character(3) NOT NULL,
    status public.link_status DEFAULT 'created'::public.link_status NOT NULL,
    provider_link_id text,
    reference_id text,
    expires_at timestamp with time zone,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    pricing_mode public.pricing_mode DEFAULT 'fixed'::public.pricing_mode NOT NULL,
    provider_request_id text,
    CONSTRAINT payment_links_pricing_ck CHECK ((((pricing_mode = 'fixed'::public.pricing_mode) AND (amount IS NOT NULL) AND (amount > (0)::numeric)) OR ((pricing_mode = 'open'::public.pricing_mode) AND (amount IS NULL))))
);

ALTER TABLE ONLY public.payment_links FORCE ROW LEVEL SECURITY;


--
-- Name: payouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    payee_type text NOT NULL,
    account_id uuid,
    membership_id uuid,
    period_start date NOT NULL,
    period_end date NOT NULL,
    gross numeric(14,2) DEFAULT 0 NOT NULL,
    fees numeric(14,2) DEFAULT 0 NOT NULL,
    refunds numeric(14,2) DEFAULT 0 NOT NULL,
    net numeric(14,2) DEFAULT 0 NOT NULL,
    amount numeric(14,2) DEFAULT 0 NOT NULL,
    currency character(3) NOT NULL,
    status public.payout_status DEFAULT 'pending'::public.payout_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payouts_payee_type_check CHECK ((payee_type = ANY (ARRAY['account'::text, 'agent'::text, 'agency'::text])))
);

ALTER TABLE ONLY public.payouts FORCE ROW LEVEL SECURITY;


--
-- Name: platform_admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_admins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    role public.platform_role DEFAULT 'super_admin'::public.platform_role NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_fee_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_fee_rates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    psp_rate_pct numeric(5,2) NOT NULL,
    margin_rate_pct numeric(5,2) DEFAULT 0 NOT NULL,
    blended_rate_pct numeric(6,2) GENERATED ALWAYS AS ((psp_rate_pct + margin_rate_pct)) STORED,
    effective_from timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    psp_fixed_fee numeric(14,2) DEFAULT 0 NOT NULL,
    fee_model text DEFAULT 'flat'::text NOT NULL,
    mdr_pct numeric(5,2),
    settlement_pct numeric(5,2),
    CONSTRAINT platform_fee_rates_fee_model_check CHECK ((fee_model = ANY (ARRAY['flat'::text, 'cascade'::text]))),
    CONSTRAINT platform_fee_rates_margin_rate_pct_check CHECK (((margin_rate_pct >= (0)::numeric) AND (margin_rate_pct <= (100)::numeric))),
    CONSTRAINT platform_fee_rates_mdr_pct_check CHECK (((mdr_pct IS NULL) OR ((mdr_pct >= (0)::numeric) AND (mdr_pct <= (100)::numeric)))),
    CONSTRAINT platform_fee_rates_psp_fixed_fee_check CHECK ((psp_fixed_fee >= (0)::numeric)),
    CONSTRAINT platform_fee_rates_psp_rate_pct_check CHECK (((psp_rate_pct >= (0)::numeric) AND (psp_rate_pct <= (100)::numeric))),
    CONSTRAINT platform_fee_rates_settlement_pct_check CHECK (((settlement_pct IS NULL) OR ((settlement_pct >= (0)::numeric) AND (settlement_pct <= (100)::numeric))))
);

ALTER TABLE ONLY public.platform_fee_rates FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN platform_fee_rates.mdr_pct; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.platform_fee_rates.mdr_pct IS 'Processing commission. NULL => fall back to psp_rate_pct as a single combined rate.';


--
-- Name: COLUMN platform_fee_rates.settlement_pct; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.platform_fee_rates.settlement_pct IS 'Settlement fee, applied after the fixed fee under the cascade model.';


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    user_agent text,
    ip inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    family_id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    permissions jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.roles FORCE ROW LEVEL SECURITY;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    filename text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    checksum text
);


--
-- Name: settlement_fee_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settlement_fee_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    chargeback_fee numeric DEFAULT 0 NOT NULL,
    settlement_fee_pct numeric DEFAULT 0 NOT NULL,
    settlement_fee_flat numeric DEFAULT 0 NOT NULL,
    effective_from timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    refund_fee numeric DEFAULT 0 NOT NULL,
    decline_fee numeric DEFAULT 0 NOT NULL,
    reserve_pct numeric DEFAULT 0 NOT NULL,
    reserve_release_days integer DEFAULT 0 NOT NULL,
    CONSTRAINT settlement_fee_config_chargeback_fee_check CHECK ((chargeback_fee >= (0)::numeric)),
    CONSTRAINT settlement_fee_config_decline_fee_check CHECK ((decline_fee >= (0)::numeric)),
    CONSTRAINT settlement_fee_config_refund_fee_check CHECK ((refund_fee >= (0)::numeric)),
    CONSTRAINT settlement_fee_config_reserve_pct_check CHECK (((reserve_pct >= (0)::numeric) AND (reserve_pct <= (100)::numeric))),
    CONSTRAINT settlement_fee_config_reserve_release_days_check CHECK ((reserve_release_days >= 0)),
    CONSTRAINT settlement_fee_config_settlement_fee_flat_check CHECK ((settlement_fee_flat >= (0)::numeric)),
    CONSTRAINT settlement_fee_config_settlement_fee_pct_check CHECK ((settlement_fee_pct >= (0)::numeric))
);

ALTER TABLE ONLY public.settlement_fee_config FORCE ROW LEVEL SECURITY;


--
-- Name: settlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settlements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    currency character(3) NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    settlement_date date,
    paid boolean DEFAULT false NOT NULL,
    first_transaction text,
    last_transaction text,
    total_transactions integer DEFAULT 0 NOT NULL,
    refunds integer DEFAULT 0 NOT NULL,
    chargebacks integer DEFAULT 0 NOT NULL,
    declined integer DEFAULT 0 NOT NULL,
    volume numeric(16,4) DEFAULT 0 NOT NULL,
    approved_cost numeric(16,4) DEFAULT 0 NOT NULL,
    decline_cost numeric(16,4) DEFAULT 0 NOT NULL,
    refund_cost numeric(16,4) DEFAULT 0 NOT NULL,
    chargeback_cost numeric(16,4) DEFAULT 0 NOT NULL,
    mdr numeric(16,4) DEFAULT 0 NOT NULL,
    volume_fee numeric(16,4) DEFAULT 0 NOT NULL,
    reserve numeric(16,4) DEFAULT 0 NOT NULL,
    total_fees numeric(16,4) DEFAULT 0 NOT NULL,
    net numeric(16,4) DEFAULT 0 NOT NULL,
    debit numeric(16,4) DEFAULT 0 NOT NULL,
    credit numeric(16,4) DEFAULT 0 NOT NULL,
    report_settings jsonb,
    source_file text,
    imported_by uuid,
    imported_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.settlements FORCE ROW LEVEL SECURITY;


--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    payment_link_id uuid,
    account_id uuid,
    customer_id uuid,
    attributed_membership_id uuid,
    type public.txn_type DEFAULT 'payment'::public.txn_type NOT NULL,
    status public.txn_status NOT NULL,
    gross numeric(14,2) DEFAULT 0 NOT NULL,
    fee numeric(14,2) DEFAULT 0 NOT NULL,
    net numeric(14,2) DEFAULT 0 NOT NULL,
    currency character(3) NOT NULL,
    provider_transaction_id text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    raw_payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    platform_fee_rate numeric(6,2),
    platform_fee numeric(14,2),
    platform_margin numeric(14,2),
    surcharge numeric(14,2) DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY public.transactions FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN transactions.surcharge; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.surcharge IS 'Extra amount charged to the payer on top of gross (provider "EC"). Platform revenue.';


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email public.citext NOT NULL,
    password_hash text,
    full_name text NOT NULL,
    status public.entity_status DEFAULT 'active'::public.entity_status NOT NULL,
    mfa_enabled boolean DEFAULT false NOT NULL,
    mfa_secret_ref text,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    twofa_secret text,
    twofa_enabled boolean DEFAULT false NOT NULL
);


--
-- Name: webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid,
    provider text NOT NULL,
    event_type text,
    provider_event_id text,
    signature_valid boolean,
    processed boolean DEFAULT false NOT NULL,
    payload jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone
);

ALTER TABLE ONLY public.webhook_events FORCE ROW LEVEL SECURITY;


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    mid text,
    currency character(3) DEFAULT 'EUR'::bpchar NOT NULL,
    brand jsonb DEFAULT '{}'::jsonb NOT NULL,
    status public.entity_status DEFAULT 'active'::public.entity_status NOT NULL,
    provider_name text,
    provider_config_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    webhook_endpoint_id text DEFAULT replace((gen_random_uuid())::text, '-'::text, ''::text),
    webhook_secret text DEFAULT (replace((gen_random_uuid())::text, '-'::text, ''::text) || replace((gen_random_uuid())::text, '-'::text, ''::text)),
    min_link_amount numeric(14,2),
    max_link_amount numeric(14,2),
    CONSTRAINT ws_link_limits_sane CHECK (((min_link_amount IS NULL) OR (max_link_amount IS NULL) OR (max_link_amount >= min_link_amount)))
);

ALTER TABLE ONLY public.workspaces FORCE ROW LEVEL SECURITY;


--
-- Name: account_agents account_agents_account_id_membership_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_agents
    ADD CONSTRAINT account_agents_account_id_membership_id_key UNIQUE (account_id, membership_id);


--
-- Name: account_agents account_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_agents
    ADD CONSTRAINT account_agents_pkey PRIMARY KEY (id);


--
-- Name: account_compliance account_compliance_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_compliance
    ADD CONSTRAINT account_compliance_account_id_key UNIQUE (account_id);


--
-- Name: account_compliance account_compliance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_compliance
    ADD CONSTRAINT account_compliance_pkey PRIMARY KEY (id);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: commission_entries commission_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_entries
    ADD CONSTRAINT commission_entries_pkey PRIMARY KEY (id);


--
-- Name: commission_entries commission_entries_sale_parts_sum; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.commission_entries
    ADD CONSTRAINT commission_entries_sale_parts_sum CHECK (((entry_type <> 'sale'::text) OR (((account_amount + agent_amount) + agency_amount) = distributable))) NOT VALID;


--
-- Name: commission_rules commission_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_rules
    ADD CONSTRAINT commission_rules_pkey PRIMARY KEY (id);


--
-- Name: content_items content_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_pkey PRIMARY KEY (id);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: invites invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_pkey PRIMARY KEY (id);


--
-- Name: invites invites_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_token_hash_key UNIQUE (token_hash);


--
-- Name: kpi_targets kpi_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kpi_targets
    ADD CONSTRAINT kpi_targets_pkey PRIMARY KEY (id);


--
-- Name: memberships memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (id);


--
-- Name: memberships memberships_workspace_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_workspace_id_user_id_key UNIQUE (workspace_id, user_id);


--
-- Name: notification_channels notification_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_pkey PRIMARY KEY (id);


--
-- Name: notification_channels notification_channels_workspace_id_type_target_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_workspace_id_type_target_key UNIQUE (workspace_id, type, target);


--
-- Name: notification_preferences notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (workspace_id, user_id);


--
-- Name: notification_reads notification_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_pkey PRIMARY KEY (notification_id, user_id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_slug_key UNIQUE (slug);


--
-- Name: payment_links payment_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_links
    ADD CONSTRAINT payment_links_pkey PRIMARY KEY (id);


--
-- Name: payouts payouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payouts
    ADD CONSTRAINT payouts_pkey PRIMARY KEY (id);


--
-- Name: platform_admins platform_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_admins
    ADD CONSTRAINT platform_admins_pkey PRIMARY KEY (id);


--
-- Name: platform_admins platform_admins_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_admins
    ADD CONSTRAINT platform_admins_user_id_key UNIQUE (user_id);


--
-- Name: platform_fee_rates platform_fee_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_fee_rates
    ADD CONSTRAINT platform_fee_rates_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: roles roles_workspace_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_workspace_id_name_key UNIQUE (workspace_id, name);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (filename);


--
-- Name: settlement_fee_config settlement_fee_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_fee_config
    ADD CONSTRAINT settlement_fee_config_pkey PRIMARY KEY (id);


--
-- Name: settlements settlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_pkey PRIMARY KEY (id);


--
-- Name: settlements settlements_workspace_id_currency_period_start_period_end_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_workspace_id_currency_period_start_period_end_key UNIQUE (workspace_id, currency, period_start, period_end);


--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);


--
-- Name: transactions transactions_workspace_id_provider_transaction_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_workspace_id_provider_transaction_id_key UNIQUE (workspace_id, provider_transaction_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: webhook_events webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_events
    ADD CONSTRAINT webhook_events_pkey PRIMARY KEY (id);


--
-- Name: webhook_events webhook_events_provider_provider_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_events
    ADD CONSTRAINT webhook_events_provider_provider_event_id_key UNIQUE (provider, provider_event_id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: workspaces workspaces_webhook_endpoint_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_webhook_endpoint_id_key UNIQUE (webhook_endpoint_id);


--
-- Name: idx_account_agents_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_agents_member ON public.account_agents USING btree (membership_id);


--
-- Name: idx_account_agents_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_agents_ws ON public.account_agents USING btree (workspace_id);


--
-- Name: idx_accounts_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_user ON public.accounts USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_accounts_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_ws ON public.accounts USING btree (workspace_id);


--
-- Name: idx_audit_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_actor ON public.audit_log USING btree (actor_user_id, created_at);


--
-- Name: idx_audit_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_ws ON public.audit_log USING btree (workspace_id, created_at);


--
-- Name: idx_ce_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ce_account ON public.commission_entries USING btree (account_id);


--
-- Name: idx_ce_one_sale; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_ce_one_sale ON public.commission_entries USING btree (transaction_id) WHERE (entry_type = 'sale'::text);


--
-- Name: idx_ce_txn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ce_txn ON public.commission_entries USING btree (transaction_id);


--
-- Name: idx_ce_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ce_ws ON public.commission_entries USING btree (workspace_id);


--
-- Name: idx_commrules_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_commrules_ws ON public.commission_rules USING btree (workspace_id, effective_from);


--
-- Name: idx_compliance_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_compliance_ws ON public.account_compliance USING btree (workspace_id);


--
-- Name: idx_content_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_account ON public.content_items USING btree (account_id);


--
-- Name: idx_content_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_ws ON public.content_items USING btree (workspace_id);


--
-- Name: idx_customers_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_account ON public.customers USING btree (account_id);


--
-- Name: idx_customers_segment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_segment ON public.customers USING btree (workspace_id, segment);


--
-- Name: idx_customers_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_ws ON public.customers USING btree (workspace_id);


--
-- Name: idx_invites_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invites_ws ON public.invites USING btree (workspace_id);


--
-- Name: idx_kpi_targets_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kpi_targets_ws ON public.kpi_targets USING btree (workspace_id);


--
-- Name: idx_links_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_links_account ON public.payment_links USING btree (account_id);


--
-- Name: idx_links_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_links_customer ON public.payment_links USING btree (customer_id);


--
-- Name: idx_links_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_links_reference ON public.payment_links USING btree (workspace_id, reference_id) WHERE (reference_id IS NOT NULL);


--
-- Name: idx_links_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_links_status ON public.payment_links USING btree (workspace_id, status);


--
-- Name: idx_links_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_links_ws ON public.payment_links USING btree (workspace_id);


--
-- Name: idx_memberships_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memberships_user ON public.memberships USING btree (user_id);


--
-- Name: idx_memberships_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memberships_ws ON public.memberships USING btree (workspace_id);


--
-- Name: idx_notif_channels_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notif_channels_ws ON public.notification_channels USING btree (workspace_id);


--
-- Name: idx_notifications_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_ws ON public.notifications USING btree (workspace_id, created_at DESC);


--
-- Name: idx_payouts_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payouts_ws ON public.payouts USING btree (workspace_id, period_start);


--
-- Name: idx_platform_fee_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_fee_org ON public.platform_fee_rates USING btree (organization_id, effective_from);


--
-- Name: idx_refresh_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_family ON public.refresh_tokens USING btree (family_id);


--
-- Name: idx_refresh_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_user ON public.refresh_tokens USING btree (user_id);


--
-- Name: idx_roles_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roles_ws ON public.roles USING btree (workspace_id);


--
-- Name: idx_settlement_fee_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_settlement_fee_org ON public.settlement_fee_config USING btree (organization_id, effective_from);


--
-- Name: idx_settlements_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_settlements_ws ON public.settlements USING btree (workspace_id, period_end DESC);


--
-- Name: idx_txn_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_txn_account ON public.transactions USING btree (account_id);


--
-- Name: idx_txn_link; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_txn_link ON public.transactions USING btree (payment_link_id);


--
-- Name: idx_txn_occurred; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_txn_occurred ON public.transactions USING btree (workspace_id, occurred_at);


--
-- Name: idx_txn_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_txn_ws ON public.transactions USING btree (workspace_id);


--
-- Name: idx_webhook_unprocessed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_unprocessed ON public.webhook_events USING btree (processed) WHERE (processed = false);


--
-- Name: idx_workspaces_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspaces_org ON public.workspaces USING btree (organization_id);


--
-- Name: idx_ws_webhook_endpoint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ws_webhook_endpoint ON public.workspaces USING btree (webhook_endpoint_id);


--
-- Name: uq_account_user_per_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_account_user_per_ws ON public.accounts USING btree (workspace_id, user_id) WHERE (user_id IS NOT NULL);


--
-- Name: uq_kpi_target; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_kpi_target ON public.kpi_targets USING btree (workspace_id, COALESCE(membership_id, '00000000-0000-0000-0000-000000000000'::uuid), metric, period);


--
-- Name: accounts trg_accounts_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_accounts_updated BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: account_compliance trg_compliance_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_compliance_updated BEFORE UPDATE ON public.account_compliance FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: content_items trg_content_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_content_updated BEFORE UPDATE ON public.content_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: customers trg_customers_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: payment_links trg_links_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_links_updated BEFORE UPDATE ON public.payment_links FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: memberships trg_memberships_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_memberships_updated BEFORE UPDATE ON public.memberships FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: organizations trg_organizations_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_organizations_updated BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: payouts trg_payouts_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payouts_updated BEFORE UPDATE ON public.payouts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: users trg_users_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: workspaces trg_workspaces_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_workspaces_updated BEFORE UPDATE ON public.workspaces FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: account_agents account_agents_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_agents
    ADD CONSTRAINT account_agents_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: account_agents account_agents_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_agents
    ADD CONSTRAINT account_agents_membership_id_fkey FOREIGN KEY (membership_id) REFERENCES public.memberships(id) ON DELETE CASCADE;


--
-- Name: account_agents account_agents_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_agents
    ADD CONSTRAINT account_agents_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: account_compliance account_compliance_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_compliance
    ADD CONSTRAINT account_compliance_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: account_compliance account_compliance_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_compliance
    ADD CONSTRAINT account_compliance_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id);


--
-- Name: account_compliance account_compliance_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_compliance
    ADD CONSTRAINT account_compliance_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: accounts accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: accounts accounts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: audit_log audit_log_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;


--
-- Name: commission_entries commission_entries_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_entries
    ADD CONSTRAINT commission_entries_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: commission_entries commission_entries_account_payout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_entries
    ADD CONSTRAINT commission_entries_account_payout_id_fkey FOREIGN KEY (account_payout_id) REFERENCES public.payouts(id) ON DELETE SET NULL;


--
-- Name: commission_entries commission_entries_agent_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_entries
    ADD CONSTRAINT commission_entries_agent_membership_id_fkey FOREIGN KEY (agent_membership_id) REFERENCES public.memberships(id) ON DELETE SET NULL;


--
-- Name: commission_entries commission_entries_agent_payout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_entries
    ADD CONSTRAINT commission_entries_agent_payout_id_fkey FOREIGN KEY (agent_payout_id) REFERENCES public.payouts(id) ON DELETE SET NULL;


--
-- Name: commission_entries commission_entries_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_entries
    ADD CONSTRAINT commission_entries_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;


--
-- Name: commission_entries commission_entries_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_entries
    ADD CONSTRAINT commission_entries_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: commission_rules commission_rules_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_rules
    ADD CONSTRAINT commission_rules_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: commission_rules commission_rules_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_rules
    ADD CONSTRAINT commission_rules_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: commission_rules commission_rules_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_rules
    ADD CONSTRAINT commission_rules_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: content_items content_items_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: content_items content_items_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: customers customers_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: customers customers_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: invites invites_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: invites invites_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id);


--
-- Name: invites invites_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: kpi_targets kpi_targets_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kpi_targets
    ADD CONSTRAINT kpi_targets_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: kpi_targets kpi_targets_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kpi_targets
    ADD CONSTRAINT kpi_targets_membership_id_fkey FOREIGN KEY (membership_id) REFERENCES public.memberships(id) ON DELETE CASCADE;


--
-- Name: kpi_targets kpi_targets_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kpi_targets
    ADD CONSTRAINT kpi_targets_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: memberships memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: memberships memberships_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: notification_channels notification_channels_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: notification_channels notification_channels_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: notification_preferences notification_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notification_preferences notification_preferences_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: notification_reads notification_reads_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.notifications(id) ON DELETE CASCADE;


--
-- Name: notification_reads notification_reads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: payment_links payment_links_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_links
    ADD CONSTRAINT payment_links_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


--
-- Name: payment_links payment_links_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_links
    ADD CONSTRAINT payment_links_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content_items(id) ON DELETE SET NULL;


--
-- Name: payment_links payment_links_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_links
    ADD CONSTRAINT payment_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.memberships(id) ON DELETE SET NULL;


--
-- Name: payment_links payment_links_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_links
    ADD CONSTRAINT payment_links_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: payment_links payment_links_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_links
    ADD CONSTRAINT payment_links_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: payouts payouts_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payouts
    ADD CONSTRAINT payouts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: payouts payouts_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payouts
    ADD CONSTRAINT payouts_membership_id_fkey FOREIGN KEY (membership_id) REFERENCES public.memberships(id) ON DELETE SET NULL;


--
-- Name: payouts payouts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payouts
    ADD CONSTRAINT payouts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: platform_admins platform_admins_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_admins
    ADD CONSTRAINT platform_admins_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: platform_admins platform_admins_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_admins
    ADD CONSTRAINT platform_admins_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: platform_fee_rates platform_fee_rates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_fee_rates
    ADD CONSTRAINT platform_fee_rates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: platform_fee_rates platform_fee_rates_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_fee_rates
    ADD CONSTRAINT platform_fee_rates_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: roles roles_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: settlement_fee_config settlement_fee_config_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_fee_config
    ADD CONSTRAINT settlement_fee_config_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: settlement_fee_config settlement_fee_config_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_fee_config
    ADD CONSTRAINT settlement_fee_config_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: settlements settlements_imported_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: settlements settlements_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: transactions transactions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: transactions transactions_attributed_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_attributed_membership_id_fkey FOREIGN KEY (attributed_membership_id) REFERENCES public.memberships(id) ON DELETE SET NULL;


--
-- Name: transactions transactions_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: transactions transactions_payment_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_payment_link_id_fkey FOREIGN KEY (payment_link_id) REFERENCES public.payment_links(id) ON DELETE SET NULL;


--
-- Name: transactions transactions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: webhook_events webhook_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_events
    ADD CONSTRAINT webhook_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;


--
-- Name: workspaces workspaces_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: account_agents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.account_agents ENABLE ROW LEVEL SECURITY;

--
-- Name: account_compliance; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.account_compliance ENABLE ROW LEVEL SECURITY;

--
-- Name: accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: commission_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commission_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: commission_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commission_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: content_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.content_items ENABLE ROW LEVEL SECURITY;

--
-- Name: customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

--
-- Name: kpi_targets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kpi_targets ENABLE ROW LEVEL SECURITY;

--
-- Name: memberships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_channels; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_channels ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: organizations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_links ENABLE ROW LEVEL SECURITY;

--
-- Name: payouts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payouts ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_fee_rates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_fee_rates ENABLE ROW LEVEL SECURITY;

--
-- Name: roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

--
-- Name: settlement_fee_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.settlement_fee_config ENABLE ROW LEVEL SECURITY;

--
-- Name: settlements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.settlements ENABLE ROW LEVEL SECURITY;

--
-- Name: account_agents tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.account_agents USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()))) WITH CHECK ((public.is_platform_context() OR (workspace_id = public.current_workspace_id())));


--
-- Name: account_compliance tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.account_compliance USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()))) WITH CHECK ((public.is_platform_context() OR (workspace_id = public.current_workspace_id())));


--
-- Name: accounts tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.accounts USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()))) WITH CHECK ((public.is_platform_context() OR (workspace_id = public.current_workspace_id())));


--
-- Name: audit_log tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.audit_log USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()))) WITH CHECK (true);


--
-- Name: commission_entries tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.commission_entries USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()))) WITH CHECK ((public.is_platform_context() OR (workspace_id = public.current_workspace_id())));


--
-- Name: commission_rules tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.commission_rules USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()))) WITH CHECK ((public.is_platform_context() OR (workspace_id = public.current_workspace_id())));


--
-- Name: content_items tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.content_items USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()))) WITH CHECK ((public.is_platform_context() OR (workspace_id = public.current_workspace_id())));


--
-- Name: customers tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.customers USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()))) WITH CHECK ((public.is_platform_context() OR (workspace_id = public.current_workspace_id())));


--
-- Name: kpi_targets tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.kpi_targets USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()))) WITH CHECK ((public.is_platform_context() OR (workspace_id = public.current_workspace_id())));


--
-- Name: memberships tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.memberships USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()) OR (user_id = public.current_user_id()))) WITH CHECK ((public.is_platform_context() OR (workspace_id = public.current_workspace_id())));


--
-- Name: notification_channels tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.notification_channels USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()))) WITH CHECK ((public.is_platform_context() OR (workspace_id = public.current_workspace_id())));


--
-- Name: notification_preferences tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.notification_preferences USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()))) WITH CHECK ((public.is_platform_context() OR (workspace_id = public.current_workspace_id())));


--
-- Name: notifications tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.notifications USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()))) WITH CHECK ((public.is_platform_context() OR (workspace_id = public.current_workspace_id())));


--
-- Name: organizations tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.organizations USING ((public.is_platform_context() OR (id = ( SELECT workspaces.organization_id
   FROM public.workspaces
  WHERE (workspaces.id = public.current_workspace_id()))) OR (EXISTS ( SELECT 1
   FROM (public.workspaces w
     JOIN public.memberships m ON ((m.workspace_id = w.id)))
  WHERE ((w.organization_id = organizations.id) AND (m.user_id = public.current_user_id())))))) WITH CHECK (public.is_platform_context());


--
-- Name: payment_links tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.payment_links USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()))) WITH CHECK ((public.is_platform_context() OR (workspace_id = public.current_workspace_id())));


--
-- Name: payouts tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.payouts USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()))) WITH CHECK ((public.is_platform_context() OR (workspace_id = public.current_workspace_id())));


--
-- Name: platform_fee_rates tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.platform_fee_rates USING ((public.is_platform_context() OR (organization_id = ( SELECT workspaces.organization_id
   FROM public.workspaces
  WHERE (workspaces.id = public.current_workspace_id()))))) WITH CHECK (public.is_platform_context());


--
-- Name: roles tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.roles USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()) OR (EXISTS ( SELECT 1
   FROM public.memberships m
  WHERE ((m.workspace_id = roles.workspace_id) AND (m.user_id = public.current_user_id())))))) WITH CHECK ((public.is_platform_context() OR (workspace_id = public.current_workspace_id())));


--
-- Name: settlement_fee_config tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.settlement_fee_config USING ((public.is_platform_context() OR (organization_id = ( SELECT workspaces.organization_id
   FROM public.workspaces
  WHERE (workspaces.id = public.current_workspace_id()))))) WITH CHECK (public.is_platform_context());


--
-- Name: settlements tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.settlements USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()))) WITH CHECK ((public.is_platform_context() OR (workspace_id = public.current_workspace_id())));


--
-- Name: transactions tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.transactions USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()))) WITH CHECK ((public.is_platform_context() OR (workspace_id = public.current_workspace_id())));


--
-- Name: webhook_events tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.webhook_events USING ((public.is_platform_context() OR (workspace_id = public.current_workspace_id()))) WITH CHECK ((public.is_platform_context() OR (workspace_id = public.current_workspace_id())));


--
-- Name: workspaces tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.workspaces USING ((public.is_platform_context() OR (id = public.current_workspace_id()) OR (EXISTS ( SELECT 1
   FROM public.memberships m
  WHERE ((m.workspace_id = workspaces.id) AND (m.user_id = public.current_user_id())))))) WITH CHECK ((public.is_platform_context() OR (id = public.current_workspace_id())));


--
-- Name: transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

--
-- Name: workspaces; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict iO1Pm0qcnteVhMP3Ik1j8KxcOB7d4JgrUvez8LWEB37pYgAA5hkkmSleX3toeA7

