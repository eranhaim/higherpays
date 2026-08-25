# HigherPays — Data Model: what we have, what we want

A diagnosis of the Postgres schema and the SQL layer built on it, and the target model.

Source: `schema.sql` (live dump) and `backend/migrations/001–027`. Reviewed 2026-08-25.

---

## 1. What we have

29 tables, 12 enums, 16 functions, 43 indexes, **0 views**, 10 `updated_at` triggers.

The model has five layers. They are cleanly separated, which is the schema's main strength.

| Layer | Tables |
|---|---|
| **Identity & tenancy** | `users`, `organizations`, `workspaces`, `memberships`, `roles`, `invites`, `platform_admins`, `refresh_tokens` |
| **Catalogue** | `accounts`, `account_compliance`, `account_agents`, `customers`, `content_items` |
| **Money flow** | `payment_links` → `transactions` → `commission_entries` → `payouts` |
| **Pricing config** | `platform_fee_rates`, `settlement_fee_config`, `commission_rules`, `settlements` |
| **Ops** | `audit_log`, `webhook_events`, `notifications`, `notification_channels`, `notification_preferences`, `notification_reads`, `kpi_targets`, `schema_migrations` |

The money path is the product:

```
payment_links     one row per checkout we hand a fan
     ↓            reference_id echoed back by the provider
transactions      one row per payment attempt outcome (unique per provider txn id)
     ↓            fn_post_sale()
commission_entries one row holding ALL parties' amounts as columns
     ↓            payouts/run
payouts           one row per (payee, period)
```

Pricing is resolved through six `effective_*(org, at)` functions that pick the rate row in force
at the moment a sale happened. `psp_cost_breakdown()` decomposes provider cost into MDR, fixed and
settlement components. `fn_post_sale` / `fn_post_refund` / `fn_post_chargeback` are the only writers
of `commission_entries`.

### What is genuinely right

Do not undo these while fixing the rest.

- **RLS on every tenant table**, with `FORCE` so even the owner is subject to it, and a controlled
  `is_platform_context()` bypass rather than an application-level backdoor.
- **`idx_ce_one_sale`** — `UNIQUE (transaction_id) WHERE entry_type = 'sale'`. A partial unique
  index makes double-posting a commission *impossible*, not merely unlikely. This is stronger than
  the application check in `payments.service.js:96` and is the right way to do it.
- **`transactions_workspace_id_provider_transaction_id_key`** — webhook idempotency enforced by the
  database.
- **Temporal pricing.** `effective_from <= at ORDER BY effective_from DESC LIMIT 1` prices each sale
  at the rate that applied when it happened. Most systems get this wrong and reprice history.
- **`citext` for email**, so case never causes a duplicate account.
- **`payment_links_pricing_ck`** — a real CHECK tying `pricing_mode` to whether `amount` is set.
- **All money math in the database**, in `SECURITY DEFINER` functions, so the ledger cannot be
  written around by a careless route.

---

## 2. What is wrong

Ordered by how much money each one can lose.

### D1. `commission_entries` money columns have no scale

```sql
gross            numeric NOT NULL,   -- not numeric(14,2)
platform_fee     numeric NOT NULL,
platform_margin  numeric NOT NULL,
psp_fee          numeric NOT NULL,
distributable    numeric NOT NULL,
account_amount   numeric NOT NULL,
agent_amount     numeric NOT NULL,
agency_amount    numeric NOT NULL,
chargeback_fee   numeric NOT NULL,
```

`transactions` uses `numeric(14,2)`. The ledger derived from it uses bare `numeric` — unlimited
precision and scale. So `fn_post_sale`'s `(dist * split) / 100` is stored **verbatim**:
`33.333333333333333333`.

This corrects an earlier assumption in `PRODUCTION-READINESS.md` §P1.10: no rounding happens on
insert at all. The consequence is different and worse than drift. The ledger holds fractions of a
cent that no bank transfer can ever pay. Sum an account's entries and you get a number that is
correct to twenty decimal places and unpayable. Every display and every payout truncates it
somewhere, and nothing records where the remainder went.

The four `fee_*` columns were added later as `numeric(14,4)` — deliberate 4dp for rate maths. That
was the right instinct applied to the wrong columns: the components are 4dp and the amounts people
are actually paid are unbounded.

### D2. `total_spend` is read six times and written zero times

`customers.total_spend numeric(14,2) NOT NULL DEFAULT 0` is commented in `001_init.sql:192` as
"cached; recomputed on transaction". Nothing recomputes it. `grep` finds six readers and no writer.

It is permanently `0`, and it feeds:

- `analytics.routes.js:136` — `avg_ltv` and `arpu`, both therefore always `0`
- `customers.routes.js:38` — the customer list sorted by value, therefore sorted arbitrarily
- the CSV export, which ships zeros to the agency

An agency looking at lifetime value and ARPU on the dashboard is reading zeros presented as
measurements. `first_purchase_at` and `last_purchase_at` are in the same position — declared,
never written.

This is the most dangerous kind of schema defect: not a missing feature, but a column that answers
a question wrongly and confidently.

### D3. The ledger cannot represent a partial refund

`fn_post_refund(tx uuid)` takes only a transaction id. The route accepts `req.body.amount`
(`payouts.routes.js:255`) and passes it to the provider, then calls `fn_post_refund($1)` — which
reverses the **entire** sale regardless.

Refund €20 of a €100 sale and the ledger records a €100 reversal. Account, agent and agency all
get clawed back four times what they should. Today `MANTAPAY_REFUND_ENABLED=false` means every
refund is externally recorded, which hides this — it does not fix it.

### D4. Payout linkage is a column per payee type

```sql
commission_entries.account_payout_id  uuid REFERENCES payouts(id)
commission_entries.agent_payout_id    uuid REFERENCES payouts(id)
commission_entries.account_paid_at    timestamptz
commission_entries.agent_paid_at      timestamptz
```

Four columns to express "this entry was settled by that payout". `payouts.payee_type` already has
a CHECK allowing `'agency'` — with no `agency_payout_id` column to match, so agency payouts cannot
be linked at all. A third payee means two more columns, a fifth means two more.

This is also what forces `payouts.routes.js` to build column names as strings
(`payCol`, `paidAtCol`, `amtCol`) and interpolate them into SQL. The schema shape is the direct
cause of the string-built SQL flagged in `PRODUCTION-READINESS.md` §P3.

### D5. `payouts` is three-fifths dead columns

```sql
gross numeric(14,2), fees numeric(14,2), refunds numeric(14,2), net numeric(14,2), amount numeric(14,2)
```

The payout run (`payouts.routes.js:212`) inserts `amount` and `net` — both bound to the same
`$6` — and leaves `gross`, `fees` and `refunds` at their `0` default. Five money columns, two
populated, and the two that are populated are always identical.

### D6. No invariant ties the parts to the whole

Nothing in the database asserts:

- `account_amount + agent_amount + agency_amount = distributable`
- `distributable > 0`
- `accounts.revenue_split_pct + commission_rules.agent_pct <= 100`

Each percentage has an individual `CHECK (0..100)`. Their sum has none, so a 70% account plus a
50% agent yields a negative `agency_amount` and the system reports it as normal. These are
exactly the conditions a CHECK constraint exists to make unrepresentable, and they are enforced
nowhere — not in SQL, not in the functions, not in the routes.

### D7. Deleting a workspace deletes its financial history

18 foreign keys cascade from `workspaces`. `commission_entries` cascades from `transactions`. So:

```
DELETE FROM workspaces WHERE id = ...
  → transactions gone → commission_entries gone → payouts gone
```

A financial ledger should be append-only and outlive the entities it references. Worse, attribution
FKs are `ON DELETE SET NULL`: delete an account and every historical transaction silently loses its
`account_id`. The money stays, the answer to "whose money was it" does not. Only `customers` has a
`deleted_at`; `accounts` has none.

### D8. Dead columns and one orphaned enum

| Object | Status |
|---|---|
| `users.mfa_enabled`, `users.mfa_secret_ref` | Superseded by `twofa_enabled` / `twofa_secret` (migration 013). Zero code references. |
| `workspaces.webhook_secret` | Never referenced. Defaults to a generated secret-looking value nobody uses. |
| ~~`membership_role` enum~~ | Dropped in migration 031. `memberships.role` has been `text` since 008. |
| `payouts.gross`, `.fees`, `.refunds` | Never written. |
| `customers.first_purchase_at`, `.last_purchase_at` | Never written. |

Two parallel 2FA implementations sitting side by side is precisely what `CLAUDE.md` §7 forbids.

### D9. Type discipline drifted

The schema starts with 12 enums and ends with `text` + CHECK:

```sql
commission_entries.entry_type  text CHECK (IN ('sale','chargeback','refund'))
commission_entries.status      text DEFAULT 'locked'      -- no CHECK at all
payouts.payee_type             text CHECK (IN ('account','agent','agency'))
kpi_targets.metric             text CHECK (...)
notifications.event            text                        -- no CHECK
memberships.role               text                        -- was an enum
```

`commission_entries.status` and `notifications.event` are free text with no constraint whatsoever.
Both have a fixed, known vocabulary in the application.

### D10. Missing indexes on the columns the money path filters by

43 indexes, and the payout run's hot columns are not among them:

| Missing index | Used by |
|---|---|
| `commission_entries (account_payout_id)` | payout run UPDATE |
| `commission_entries (agent_payout_id)` | payout run UPDATE |
| `commission_entries (agent_membership_id)` | `/payouts/breakdown` GROUP BY |
| `payouts (account_id)`, `payouts (membership_id)` | unindexed FKs |
| `transactions (customer_id)`, `(attributed_membership_id)` | unindexed FKs |
| `payment_links (created_by)` | agent-scoped link list |

Unindexed FK columns also make every parent `DELETE` a sequential scan of the child table.

### D11. Four tables grow forever

`refresh_tokens`, `webhook_events`, `notifications` and `audit_log` have no retention policy and no
cleanup job. `refresh_tokens` accumulates a row per login *and* per refresh — with a 15-minute
access token, that is ~96 rows per user per day, revoked rows never pruned.

### D12. No views — every aggregate is re-derived in JavaScript

Zero views in a schema whose entire purpose is aggregation. `/payouts/summary`,
`/payouts/breakdown`, `/settlements` and `/analytics` each rebuild the same joins inline. The
`/settlements` handler runs two extra queries per row in a loop (200 rows → 400 round-trips).

There is no single SQL definition of "what an account is owed". There are three, in three route
files, and nothing keeps them agreeing.

---

## 3. What we want

Two tiers. Tier 1 is corrective and can ship incrementally. Tier 2 is the destination.

### Tier 1 — fix the model in place

**1. Give money a type.** One domain, used everywhere:

```sql
CREATE DOMAIN money_amount AS numeric(14,2);
CREATE DOMAIN rate_pct     AS numeric(6,4) CHECK (VALUE >= 0 AND VALUE <= 100);
```

Convert every unconstrained `numeric` money column. Rates keep 4dp; amounts are exactly 2dp,
enforced by the database rather than by whoever writes the next `INSERT`.

**2. Make the split arithmetic provable.**

```sql
ALTER TABLE commission_entries
  ADD CONSTRAINT ce_parts_sum_to_whole
  CHECK (account_amount + agent_amount + agency_amount = distributable);
```

For this to hold, `fn_post_sale` must round the two computed shares and derive the third as the
remainder:

```sql
c_amt  := round((dist * split)   / 100, 2);
ch_amt := round((dist * chatpct) / 100, 2);
ag_amt := dist - c_amt - ch_amt;          -- absorbs the rounding remainder
```

The constraint then makes the rounding rule impossible to break later.

**3. Add the bounds that are missing.**

```sql
ALTER TABLE commission_entries ADD CONSTRAINT ce_distributable_positive
  CHECK (entry_type <> 'sale' OR distributable > 0);
```

Plus a trigger — or a validation in `fn_post_sale` that `RAISE`s — for
`revenue_split_pct + agent_pct <= 100`, checked at posting time against the rates actually in
force.

**4. Replace the payout columns with a join table.**

```sql
CREATE TABLE payout_items (
  payout_id            uuid NOT NULL REFERENCES payouts(id) ON DELETE RESTRICT,
  commission_entry_id  uuid NOT NULL REFERENCES commission_entries(id) ON DELETE RESTRICT,
  payee_type           payee_type NOT NULL,
  amount               money_amount NOT NULL,
  PRIMARY KEY (payout_id, commission_entry_id, payee_type)
);
CREATE UNIQUE INDEX uq_entry_paid_once
  ON payout_items (commission_entry_id, payee_type);
```

That unique index is the fix for the double-payout race in `PRODUCTION-READINESS.md` §P1.1 — the
same technique as `idx_ce_one_sale`. Paying an entry twice becomes impossible rather than
merely unlikely, the four `*_payout_id` / `*_paid_at` columns disappear, agency payouts become
representable, and the string-built column names in `payouts.routes.js` disappear with them.

**5. Support partial refunds.** `fn_post_refund(tx uuid, amount money_amount DEFAULT NULL)` —
`NULL` means full. Reverse each party pro-rata against the sale entry, and constrain the sum of
reversals against a sale to never exceed it.

**6. Make the ledger append-only and durable.**

- `ON DELETE RESTRICT` from `transactions` and `commission_entries` to their parents
- `deleted_at` on `accounts` (as `customers` already has); never hard-delete an attributed entity
- Denormalize the attribution names onto the entry at posting time, so a later deletion cannot
  make a historical payout unexplainable

**7. Either compute `total_spend` or delete it.** Delete is the better default: derive it in a view
and drop the cache. If it stays, it must be maintained by a trigger on `transactions` — never by
application code, which is how it came to be zero.

**8. Add the seven missing indexes** from D10, and a retention job for the four unbounded tables.

**9. Finish the type discipline.** `CHECK` on `commission_entries.status` and
`notifications.event`; drop `webhook_secret`, the `mfa_*` columns, and the three dead `payouts`
columns. (The orphaned `membership_role` enum is already gone — migration 031.)

**10. Move the read model into views.**

```sql
CREATE VIEW v_account_balance AS
SELECT ce.workspace_id, ce.account_id,
       sum(ce.account_amount)                        AS earned,
       sum(ce.account_amount) FILTER (WHERE pi.payout_id IS NULL) AS owed
FROM commission_entries ce
LEFT JOIN payout_items pi
  ON pi.commission_entry_id = ce.id AND pi.payee_type = 'account'
GROUP BY 1, 2;
```

One definition of "owed", queried by every route that needs it. Views inherit RLS from their base
tables, so tenancy still holds.

### Tier 2 — the destination: a double-entry journal

The current design stores one wide row per transaction with a column per party. Reversals are new
rows with negated values — double-entry improvised by hand, without the property that makes double
entry safe.

The proper shape:

```sql
CREATE TABLE journal_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL,
  transaction_id uuid REFERENCES transactions(id) ON DELETE RESTRICT,
  kind           journal_kind NOT NULL,      -- sale | refund | chargeback | payout | adjustment
  occurred_at    timestamptz NOT NULL,
  reverses_id    uuid REFERENCES journal_entries(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journal_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id     uuid NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  account      account_type NOT NULL,        -- account | agent | agency | platform | psp | reserve
  party_id     uuid,                         -- account_id or membership_id; NULL for house accounts
  amount       money_amount NOT NULL,        -- signed; debits negative
  currency     char(3) NOT NULL
);
```

With one invariant, enforced by a deferred constraint trigger:

> **every entry's lines sum to zero**

That single rule buys what the current model cannot express:

| Need | Today | With a journal |
|---|---|---|
| Add a fourth payee | Schema change: new columns everywhere | Insert a line |
| Partial refund | Not representable | An entry with smaller lines |
| "Is the ledger balanced?" | Unanswerable | `sum(amount) = 0`, checkable per entry and in total |
| Party balance | Three different queries in three routes | `sum(amount) WHERE account, party_id` |
| Correct a mistake | `UPDATE` a posted row | Post a reversing entry; history intact |
| Where did the rounding go | Nowhere | An explicit rounding line |

**When this is worth doing.** Not yet. Tier 1 fixes every bug listed above and keeps the model the
team already understands. Move to a journal when the second payout rail lands, when agency payouts
become real, or when the first reconciliation dispute cannot be answered from the current tables —
whichever comes first. Committing to it before then is complexity ahead of requirement, which
`CLAUDE.md` §5 rightly rejects.

What you can do **now**, cheaply, is stop making it harder: `payout_items` (Tier 1 item 4) is the
first table of the journal design, and every constraint added in Tier 1 survives the migration.

---

## 4. Order of work

Non-breaking first, so each step ships on its own.

| Step | Work | Breaks anything? |
|---|---|---|
| 1 | Add the missing indexes (D10) | No |
| 2 | Drop dead columns and the orphaned enum (D8) | No — nothing reads them |
| 3 | Fix or delete `total_spend` (D2) | Changes analytics output, from wrong to right |
| 4 | `money_amount` / `rate_pct` domains; convert columns (D1) | Requires a rounding decision for existing rows |
| 5 | Rounding rule in `fn_post_sale` + the sum constraint (D6) | New posts only; backfill audit needed |
| 6 | `payout_items` + unique index; migrate the four columns (D4) | Route rewrite; fixes P1.1 |
| 7 | Partial refunds (D3) | New function signature, default preserves behaviour |
| 8 | `ON DELETE RESTRICT` + soft delete (D7) | Deletion paths must handle the refusal |
| 9 | Read-model views (D12) | Routes simplify; output unchanged |
| 10 | Retention jobs (D11) | No |

Steps 4 and 5 need a **data audit first**: how many existing `commission_entries` rows carry more
than two decimal places, and what the sum of those fractions is per workspace. That number is a
real liability and someone has to decide who it belongs to before it is rounded away.

```sql
SELECT workspace_id,
       count(*) FILTER (WHERE scale(account_amount) > 2) AS unrounded_rows,
       sum(account_amount - round(account_amount, 2))    AS account_fraction,
       sum(agent_amount - round(agent_amount, 2))    AS agent_fraction,
       sum(agency_amount  - round(agency_amount,  2))    AS agency_fraction
FROM commission_entries
GROUP BY workspace_id;
```

Run that before step 4. If the fractions are material, the rounding migration is a business
decision, not a technical one.

---

## 5. What not to change

- The RLS policies and the `is_platform_context()` bypass. They work and they are the tenant boundary.
- `idx_ce_one_sale` and the transaction idempotency key. Copy the pattern; do not remove it.
- The `effective_*(org, at)` temporal pricing functions. This is the part of the schema most likely
  to be "simplified" by someone who does not realise historical repricing is the bug it prevents.
- Money math living in the database. Moving it into JavaScript would lose the one guarantee the
  current design actually delivers.
