# Review — `higherpays_schema_multitenant_v2.sql`

Assessment of the proposed replacement schema against correctness, the live system, and the
production-readiness work already in flight.

Reviewed 2026-08-25 against `schema.sql` (live) and `backend/migrations/001–027`.

---

## Verdict

**Good architecture, not deployable as written.**

Four ideas in here are genuinely better than what is live and should be adopted. One bug would
break payment creation on the first day. The money type is wrong for a fiat payments product. The
ledger has double-entry notation without the double-entry guarantee. RLS — which works in
production today — is demoted to a comment. And roughly ten working subsystems are silently
dropped.

Treat this as a **design proposal for the payments and revenue core**, not as a replacement schema.
Harvest the good parts into the existing database as migrations.

| | |
|---|---|
| Deployable as-is | No |
| Ideas worth adopting | 4, listed in §2 |
| Blocking bugs | 3 |
| Regressions vs live | 6 |
| Subsystems dropped | ~10 |

---

## 1. Blocking bugs

### B1. Only one pending payment can exist per provider — platform-wide

```sql
CONSTRAINT payments_provider_payment_unique
    UNIQUE NULLS NOT DISTINCT (provider, provider_payment_id)
```

`provider_payment_id` is nullable, and payments are created `PENDING` before the provider has
assigned one. `NULLS NOT DISTINCT` (PG15+) treats NULLs as **equal**, so the second row with
`('mantapay', NULL)` violates the constraint.

Effect: one pending MantaPay payment can exist in the entire database at a time. Across all
tenants. The second concurrent checkout fails with a unique violation.

The correct form is already in the file, 660 lines later:

```sql
CREATE UNIQUE INDEX ux_payments_tenant_provider_payment
    ON payments(workspace_id, provider, provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;
```

Drop the table constraint; keep the partial index.

### B2. `provider_link_id NOT NULL` is incompatible with MantaPay

```sql
provider_link_id VARCHAR(255) NOT NULL,
provider_url     TEXT NOT NULL,
```

MantaPay's hosted checkout has no provider-side link object. `createCheckout` builds a signed URL
client-side with no server call and returns `providerLinkId: null` (`providers/mantapay.js:71`).
There is nothing to put in this column until the fan actually pays.

The live code works around this by storing its own `reference_id` there. That works, but combined
with the **global** `UNIQUE (provider, provider_link_id)` at line 323 it means our own reference ids
must be globally unique across every tenant — and they are currently `'ord_' + Date.now() +
4 random chars` (`links.routes.js:113`), which is exactly the weak generator already flagged in
`PRODUCTION-READINESS.md` §P2.8.

Make it nullable, or model it honestly as `our_reference` + optional `provider_link_id`.

### B3. Money is `NUMERIC(20,8)`

Every amount in the schema — `payments.amount`, `transactions.amount`, `ledger_entries.amount`,
`revenue_snapshots.*` — is `NUMERIC(20, 8)`.

That is the crypto convention. This is a EUR card-payments product. Eight decimal places means the
ledger can hold `33.33333333` for a share that must be paid as `33.33`, and nothing in the schema
records where the remainder went.

`DATA-MODEL.md` §D1 documents this exact defect in the **current** database, where the
`commission_entries` columns are unconstrained `numeric`. This proposal does not fix it — it
formalises it at eight decimals deep and extends it to tables that are currently correct
(`transactions` is `numeric(14,2)` today).

```sql
CREATE DOMAIN money_amount AS numeric(14,2);   -- amounts people are paid
CREATE DOMAIN rate_pct     AS numeric(6,4) CHECK (VALUE BETWEEN 0 AND 100);
```

Percentages in `revenue_rule_components` are also `NUMERIC(20,8)` with a `<= 100` check. Those want
`rate_pct`. Amounts want `money_amount`. The distinction is the whole point.

---

## 2. What is genuinely better than what we have

These four are the reason to take the proposal seriously.

### G1. Splitting `payments` from `transactions`

The live schema has one `transactions` table conflating "the payment we are trying to collect" with
"what the provider did". This proposal separates them: a `payment` is the HigherPays intent, and
`transactions` are the provider-side attempts against it.

That is correct and it unlocks things the live model cannot express: multiple attempts per payment,
retries after a decline, provider fees per attempt, and — with `PARTIALLY_REFUNDED` in
`transaction_status` — partial refunds, which `DATA-MODEL.md` §D3 records as currently impossible.

**Adopt this.**

### G2. `revenue_rules` + `revenue_rule_components`

Versioned, effective-dated, scoped at `WORKSPACE | ACCOUNT | AGENT`, with components typed by
`revenue_component_type`. The live system hardcodes `creators.revenue_split_pct` plus a
`commission_rules.chatter_pct` and cannot express anything else without a schema change.

This is the right generalisation. It needs the fixes in §4 before it is usable.

**Adopt the shape.**

### G3. `provider_accounts` — workspace-scoped PSP configuration

The live system resolves one global hash key from an env var. `PRODUCTION-READINESS.md` §P0.3
documents the consequence: per-workspace provider credentials do not work at all today, so
multi-merchant is broken.

This table fixes it properly, and generalises to a second PSP. **Adopt the shape** — but see R5 on
credential storage.

### G4. Cross-workspace validation triggers

The live schema has **no** protection against a `payment_link` pointing at a customer in another
workspace. RLS blocks the read, but nothing blocks the write. Three triggers here fix that for
customers, payment links and payments.

Right instinct, incomplete execution — see §4, and prefer composite foreign keys over triggers.

Also worth keeping: `revenue_snapshots` as an explicit, period-bounded cache is a much better
pattern than an undocumented denormalised column like the live `customers.total_spend`, which
`DATA-MODEL.md` §D2 shows is read six times and written zero.

---

## 3. Regressions against the live system

### R1. RLS becomes a comment

Lines 1067–1083 describe RLS and explicitly say not to enable it:

> Do NOT enable this automatically until the application middleware consistently sets the tenant
> context inside every DB transaction.

Production **already does this**. `withWorkspace` / `withUser` / `withPlatformAdmin` /
`withSystem` set the GUCs inside every transaction, every tenant table has `ENABLE` + `FORCE ROW
LEVEL SECURITY`, there is a controlled `is_platform_context()` bypass, and `server.js:94` refuses to
boot in production if the DB role can bypass RLS.

Adopting this file as written trades enforced tenant isolation for documented tenant isolation.
That is the single largest step backwards in the proposal.

It also renames the GUC from `app.workspace_id` to `app.current_workspace_id` for no stated reason,
which breaks every existing policy.

### R2. Platform admin loses its role model

```sql
ALTER TABLE users ADD COLUMN is_platform_super_admin BOOLEAN NOT NULL DEFAULT FALSE;
```

replaces a `platform_admins` table carrying `role platform_role` (`super_admin | support |
finance`), `created_by` and `created_at`. The boolean loses role granularity, who granted it, and
when.

`platform_user_role` is created at line 993 and never used — dead type.

Note: `PRODUCTION-READINESS.md` §P1.14 says the live role enum is currently unenforced. The fix
there is to start enforcing it, not to delete the distinction.

### R3. Compliance and consent disappear

`creator_compliance` (verification status, document expiry) is gone entirely. For a creator agency
operating in adult content, age and identity verification is a legal obligation, not a feature.

`customers.consent_marketing` and `consent_recorded_at` are gone too — GDPR-relevant, and the
proposal targets EUR/EU.

### R4. Settlement and reserve tracking disappear

`settlements`, `settlement_fee_config` and the rolling-reserve functions are absent. That subsystem
is how the agency reconciles our ledger against the provider's daily batch and tracks funds the PSP
is holding. There is no equivalent here — `revenue_snapshots` is a dashboard cache, not a
reconciliation.

### R5. Provider secrets move into the database

```sql
credentials_encrypted JSONB NOT NULL DEFAULT '{}'::jsonb,
-- Encrypt secrets/tokens at the application/KMS layer.
```

The live design deliberately keeps signing keys out of Postgres: `workspaces.provider_config_ref`
stores the **name of an env var**, so a database dump leaks no keys
(`providers/mantapay.js:32`, and the comment above it says so explicitly).

This moves them in, protected by a comment asking the application to encrypt. Column names ending
in `_encrypted` have a long history of holding plaintext. Keep the reference indirection, or commit
to real envelope encryption with a KMS and say which key.

### R6. No payouts, no soft delete

There is no payout concept at all. The ledger accrues balances and nothing records settling them to
a creator — so `payouts`, and the "what is owed vs what is paid" question, has no home.

No table has `deleted_at`. Combined with `ON DELETE CASCADE` from `workspaces`, offboarding and
GDPR erasure are both destructive. `PRODUCTION-READINESS.md` §P1.11 and `DATA-MODEL.md` §D7 both
argue the opposite direction.

**Also dropped:** `invites`, `refresh_tokens`, `notifications` (+ channels, preferences, reads),
`kpi_targets`, `content_items`, `creator_assignments`, `customer_segment`,
`creator_revenue_model`. Some are deliberate simplifications; all of them are live features.

---

## 4. Correctness gaps to fix before this is usable

### C1. The ledger cannot be checked for balance

`ledger_entries` has `direction CREDIT|DEBIT` and `amount > 0` — the right notation. But there is
**no grouping column**. Entries link individually to `payment_id` / `transaction_id`, and nothing
identifies "the set of lines that must sum to zero".

Without that, no constraint and no trigger can assert debits equal credits. You get the shape of
double-entry and none of its safety, which is the one reason to adopt double-entry at all.

Add a parent:

```sql
CREATE TABLE ledger_transactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  kind         ledger_entry_type NOT NULL,
  occurred_at  timestamptz NOT NULL,
  reverses_id  uuid REFERENCES ledger_transactions(id)
);
ALTER TABLE ledger_entries
  ADD COLUMN ledger_transaction_id uuid NOT NULL REFERENCES ledger_transactions(id);
```

then enforce the invariant with a `DEFERRABLE INITIALLY DEFERRED` constraint trigger checking that
each group sums to zero. Also add `reverses_entry_id` so corrections are traceable, and a
`PAYOUT` member to `ledger_entry_type`.

### C2. Rule resolution is non-deterministic

Nothing prevents two `ACTIVE` `revenue_rules` with the same `scope_type`, same `priority` and
overlapping `[effective_from, effective_until)`. Which one prices a sale is undefined.

Use an exclusion constraint:

```sql
ALTER TABLE revenue_rules ADD CONSTRAINT revenue_rules_no_overlap
  EXCLUDE USING gist (
    workspace_id WITH =, scope_type WITH =,
    COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    COALESCE(agent_id,   '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    tstzrange(effective_from, effective_until) WITH &&
  ) WHERE (status = 'ACTIVE');
```

The live system sidesteps this with `ORDER BY effective_from DESC LIMIT 1` — crude, but at least
deterministic. Do not regress to ambiguous.

### C3. The version index enforces nothing

```sql
CREATE UNIQUE INDEX ux_revenue_rules_workspace_version
    ON revenue_rules(workspace_id, id, version);
```

`id` is the primary key, so this tuple is unique trivially. The intent was presumably one row per
(rule family, version), which needs a separate `rule_group_id`. As written, `version` is decorative.

### C4. Rule components have no sum invariant

Nothing asserts that a rule's share components sum to 100%, or that fixed and percentage components
combine sensibly. This is the same gap as `DATA-MODEL.md` §D6 — reproduced in the new design rather
than fixed.

### C5. Validation triggers miss the tables that matter most

Three triggers cover `customers`, `payment_links`, `payments`. Not covered:

| Table | Unvalidated references |
|---|---|
| `ledger_entries` | `account_id`, `agent_id`, `payment_id`, `transaction_id` — **none** checked |
| `transactions` | `account_id` vs `payment_id`'s workspace |
| `revenue_rules` | `account_id`, `agent_id` vs `workspace_id` |
| `account_agents` | `user_id` is never checked to be a member of the account's workspace |
| `revenue_snapshots` | `account_id`, `agent_id` |

The most money-sensitive table has zero scope validation.

**Replace all of them with composite foreign keys.** Add `UNIQUE (workspace_id, id)` to each parent,
then:

```sql
ALTER TABLE payments
  ADD CONSTRAINT payments_account_same_workspace
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts(workspace_id, id);
```

Declarative, race-free, no per-row plpgsql, and it cannot be forgotten on the next table. Triggers
are the wrong tool for a constraint the database can express directly.

### C6. Currency is unconstrained across the chain

`payments.currency`, `transactions.currency` and `ledger_entries.currency` are independent. A EUR
payment can carry a USD transaction and GBP ledger lines. `transactions.net_amount` has no CHECK
relating it to `amount - provider_fee`.

Either constrain currency to match along the chain, or specify the FX model — rate source, rounding
and at which point conversion happens. The live system dodges this by being EUR-only.

### C7. The one-owner index blocks ownership transfer

```sql
CREATE UNIQUE INDEX ux_workspace_one_owner
  ON workspace_members(workspace_id) WHERE role = 'OWNER';
```

A `SUSPENDED` owner still occupies the slot, so you cannot suspend an owner and promote a
replacement. Ownership transfer requires delete-then-insert in one transaction. If one owner is the
rule, add `AND status = 'ACTIVE'` to the predicate at minimum.

### C8. Redundant and contradictory unique constraints

The v2 additions add tenant-scoped unique indexes on `payment_links`, `payments` and `transactions`,
with a comment saying provider ids are "unique only inside a tenant/provider namespace". But the
**global** constraints from the base schema (lines 323, 400, 456) are never dropped, so global
uniqueness still applies and the new indexes are redundant.

Stated intent and effective behaviour disagree. Two workspaces sharing a MantaPay merchant account
would collide.

### C9. Index shapes do not match tenant access patterns

Every tenant query filters `workspace_id` first. Single-column indexes on `workspace_id` and on
low-cardinality `status` are much weaker than composites:

| Proposed | Should be |
|---|---|
| `ix_payments_status` | `(workspace_id, status)` |
| `ix_payments_created_at` | `(workspace_id, created_at DESC)` |
| `ix_transactions_status` | `(workspace_id, status)` |
| `ix_customers_email` | `(workspace_id, email)` |
| — | partial index on unprocessed webhooks (live has one) |

### C10. `provider_webhook_events` has no `workspace_id`

The live table has it. Without it you cannot scope webhook events to a tenant, apply RLS, or answer
"show me this workspace's failed webhooks".

### C11. Delete policy is internally inconsistent

`workspaces → accounts` is `CASCADE`, but `payments.account_id` is `RESTRICT`. So deleting a
workspace attempts to cascade into accounts, is blocked by payments, and fails with a confusing
error. The net policy is "cannot delete a workspace with payments" — which is right — but expressed
as a collision between two opposite rules rather than a decision. Make it `RESTRICT` throughout plus
soft delete.

---

## 5. File hygiene

- The file is a base schema (lines 1–984) plus a patch that `ALTER`s the tables it just created
  (985–1094), in one transaction. For a greenfield schema this should be one coherent set of DDL.
  As-is it reads as two documents stapled together, and the second contradicts the first (C8).
- `CREATE EXTENSION citext` appears twice (35, 990).
- Two duplicated header comment blocks (1–22, 23–31).
- `platform_user_role` created and never used.
- Renames with no migration path: `users.full_name` → `name`, `audit_log` → `audit_logs`,
  `creators` → `accounts`, `chatters` → `agents`.

---

## 6. Recommendation

**Do not adopt as a replacement.** It is not a superset of the live schema, and swapping to it
would delete working compliance, settlement, notification, invite and payout functionality while
regressing tenant isolation from enforced to aspirational.

**Do adopt the four good ideas as migrations** against the existing database, in this order:

| Step | Change | Fixes |
|---|---|---|
| 1 | `provider_accounts` (workspace-scoped PSP config, secrets stay by reference) | `PRODUCTION-READINESS.md` §P0.3 multi-merchant |
| 2 | Composite FKs `(workspace_id, id)` on every tenant table | Write-side tenant integrity, absent today |
| 3 | Split `payments` from `transactions`; add `PARTIALLY_REFUNDED` | `DATA-MODEL.md` §D3 partial refunds |
| 4 | `revenue_rules` + components, with C2's exclusion constraint | Hardcoded splits; §D6 invariants |

Each is independently shippable and each maps to a defect already documented. Keep RLS, keep
`platform_admins`, keep the `effective_*(org, at)` pricing functions, keep `idx_ce_one_sale`, and
keep money at `numeric(14,2)`.

The ledger redesign (C1) is the Tier 2 work in `DATA-MODEL.md` §3. This proposal is a reasonable
first sketch of it, and it should not be built until it can prove that debits equal credits.
