# Payment Link & MantaPay Integration — Business Specification v3

Supersedes v1. The material change is that **customer identity is no longer a
payment authorization rule**. A Link may or may not belong to a customer, and a
payer whose details differ from the intended customer is still a valid payer.

---

## 1. Core Model

The system separates three concepts, and never collapses them:

```text
Payment Link
    │
    ├── Link Type
    │      ├── CUSTOMER
    │      └── PUBLIC
    │
    ├── Intended Customer (optional)
    │
    └── Payment Attempts
            │
            ├── Actual Payer
            ├── Amount
            ├── Currency
            ├── Provider Transaction
            └── Payment Status
```

**Customer ≠ Payment Link ≠ Payment Attempt**, and critically:

```text
Customer ≠ Payer
```

The intended customer is who the Link was created *for*. The actual payer is
whoever paid, as reported by the provider. For a Customer Link these are often
the same person, but the system must never assume it.

---

## 2. Payment Link Types

The Link type is explicit:

```text
link_type:
    CUSTOMER
    PUBLIC
```

### A. Customer Link

Associated with a specific customer. The association is for identification and
reporting, not authorization.

Contains:

* `customer_id`
* `customer_email`
* `amount`
* `currency`
* `usage_type`
* `max_payments` (optional)
* `expires_at`
* description / reference
* workspace

### B. Public Link

No customer association. It can be shared publicly and anyone may pay it.

* `customer_id` may be `NULL`
* `customer_email` may be `NULL`
* a payment must **not** be rejected because the payer is not a known customer
* actual payer information is still captured when the provider supplies it

```text
Customer Link
    customer_id    = X
    customer_email = customer@example.com

Public Link
    customer_id    = NULL
    customer_email = NULL
```

Both types behave identically in every other respect: usage rules, validation,
expiry, cancellation, reconciliation, and the ledger.

---

## 3. Link Usage

Every Link, of either type, is one of:

```text
SINGLE_USE
MULTI_USE
```

### Single-use

One successful payment. Declined, pending, abandoned or otherwise unsuccessful
attempts do **not** consume the Link.

```text
Link
  ↓
Attempt #1 → DECLINED     (link stays ACTIVE)
  ↓
Attempt #2 → APPROVED
  ↓
Link = USED
```

A later successful payment on a used Link must not create a second sale.

### Multi-use

Multiple successful payments. The configured amount applies **per payment**.

```text
Amount        = $100
Usage         = MULTI_USE
Max payments  = 3
```

```text
Payment #1 → APPROVED → $100
Payment #2 → DECLINED
Payment #3 → APPROVED → $100
Payment #4 → APPROVED → $100
```

```text
Successful payments = 3
Total paid          = $300
Link                = USED
```

`max_payments` is optional. If `NULL`, the Link stays usable until it expires or
is cancelled.

Declined and pending attempts never count toward `max_payments`.

---

## 4. Multiple Links per Customer

A customer may hold several active Links at once. Activity on one must not
affect the others.

```text
John
 ├── Link A → $100
 ├── Link B → $250
 └── Link C → $50
```

---

## 5. Payment Attempt

Every attempt is stored independently. The Link is not the payment history.

A Payment Attempt contains at least:

```text
id
link_id

provider_transaction_id
provider_order_id

payer_email
payer_name
payer_phone

amount
currency

status

provider_reply_code
provider_reply_description

created_at
updated_at
completed_at
```

One Link may therefore hold:

```text
Attempt #1 → DECLINED
Attempt #2 → PENDING
Attempt #3 → APPROVED
```

All three remain available for history and audit, including after the Link
expires, is used, or is cancelled.

Payer information is taken from the provider whenever available:

```text
Public Link
    ↓
Payment Attempt
    ↓
MantaPay
    ↓
payer_email = jane@example.com
payer_name  = Jane Smith
payer_phone = ...
```

See §16 for what MantaPay actually provides today.

---

## 6. Payer Information

**Payer-email matching is not a validation rule.** The v1 requirement
"expected customer email must equal actual payer email" is removed.

A Customer Link may carry an expected `customer_email`, but a mismatch does
**not** reject the payment:

```text
Link Customer: john@example.com
Actual Payer:  jane@example.com

→ Valid payment
→ Sale posted
→ Both values retained and exposed
```

The behaviour is:

1. Process the payment according to the provider's own result.
2. Capture the actual payer information the provider returns.
3. Store it on the Payment Attempt.
4. Expose intended customer and actual payer as separate fields.

A payment is rejected only when MantaPay rejects it, or when one of the
validations in §8 fails.

---

## 7. Link Status

The Link has its own lifecycle, independent of any attempt:

```text
ACTIVE
USED
EXPIRED
CANCELLED
```

**ACTIVE** — payment is allowed.
**USED** — a single-use Link has been paid, or a multi-use Link has reached
`max_payments`.
**EXPIRED** — `expires_at` has passed; no new payment may start.
**CANCELLED** — an authorized user disabled it.

Attempt statuses must never stand in for Link status:

```text
Link = ACTIVE

Attempt #1 = DECLINED
Attempt #2 = PENDING
Attempt #3 = APPROVED
```

The Link stays ACTIVE for as long as it remains eligible for further payments.
In particular, a declined attempt must not move the Link out of ACTIVE.

---

## 8. Payment Status and Validation

### Attempt statuses

```text
PENDING
APPROVED
DECLINED
ABANDONED
REFUNDED
CHARGED_BACK
```

MantaPay pending reply codes all map to `PENDING`:

```text
001   awaiting the customer (PIX / wire transfer)
553   3DS / APM redirect
663   awaiting final response
```

`600` maps to `ABANDONED` — the payer closed the window. It is not a decline.

Pending attempts must not consume a single-use Link or count toward
`max_payments`.

### Validation before posting a sale

```text
1. Webhook signature
2. Merchant / workspace
3. Payment Link exists
4. Link is still eligible
5. Amount matches the Link amount
6. Currency matches the Link currency
7. Payment has not already been settled
8. Single-use / max-payment rules
```

There is deliberately **no payer-email check**. For Customer Links, customer
data is association and reporting only. For Public Links there is no customer
identity to check against.

Only after all validations pass:

```text
MantaPay
    ↓
APPROVED
    ↓
Validation
    ↓
Payment Attempt = APPROVED
    ↓
Post Sale
    ↓
Update Link
```

A failed validation must still record the Payment Attempt, with the reason, so
the event is auditable rather than silently discarded.

---

## 9. Double Payment Protection

Critical requirement.

For a single-use Link:

```text
Webhook A → Approved
Webhook B → Approved
```

Only one may reach `fn_post_sale`. The other is recorded as an attempt but
posts no ledger sale.

This must be safe against **concurrent** requests. Application-level
check-then-act is not sufficient — two webhooks carrying different provider
transaction ids can pass such a check simultaneously. Use database
transactions, row locking on the Link, unique constraints, or an equivalent
concurrency-safe mechanism.

For multi-use Links, approved payments are allowed until `max_payments` is
reached, and the count itself must be evaluated under the same protection.

---

## 10. Expiration

Every Link has `expires_at`.

After expiration no new payment may be initiated, and expiry is a real Link
state — not a value computed at read time. Every consumer of Link status
(list, detail, reconciliation, analytics) must see the same answer.

All Payment Attempts are retained after the Link expires, including an attempt
that was in progress when expiry occurred.

---

## 11. Cancellation

An authorized user can cancel an ACTIVE Link. A cancelled Link accepts no new
payments. Existing Payment Attempts remain available for history and audit.

---

## 12. Webhooks

MantaPay webhooks remain the primary asynchronous notification.

```text
MantaPay Webhook
       ↓
Verify Signature
       ↓
Identify Link
       ↓
Validate Merchant
       ↓
Validate Amount
       ↓
Validate Currency
       ↓
Validate Link State
       ↓
Check Duplicate / Settlement
       ↓
Record or Update Payment Attempt
       ↓
Post Ledger Transaction
       ↓
Update Link
```

A pending notification records or updates the attempt and stops there — it must
not close the Link or post to the ledger.

Duplicate webhooks must never produce duplicate sales.

---

## 13. Reconciliation

Reconciliation is the safety net for a missing or delayed webhook. It operates
against **Payment Attempts and provider transaction ids**, not Link status.

```text
Payment Attempt = PENDING
        ↓
Reconciliation
        ↓
MantaPay Status / Search API
        ↓
APPROVED
        ↓
Update Payment Attempt
        ↓
Post Sale
```

It must also handle the case where no attempt exists locally at all — the
first webhook was lost entirely — by discovering attempts from the provider
against the Link's order reference.

Reconciliation should eventually run automatically in the background. The
existing manual endpoint remains available as an operational tool.

---

## 14. Chargebacks and Refunds

### Chargebacks

A chargeback is a real Payment Attempt lifecycle event, handled automatically:

```text
MantaPay Chargeback
        ↓
Verify
        ↓
Find Payment Attempt
        ↓
Payment Attempt = CHARGED_BACK
        ↓
Post Chargeback to Ledger
```

No manual operator step is required when a valid provider notification arrives.

### Refunds

Separate from chargebacks:

```text
APPROVED
   ↓
REFUND
   ↓
REFUNDED
```

The provider refund API may be implemented later, but the Payment Attempt model
supports `REFUNDED` from the start. Record-only refunds remain available in the
meantime.

---

## 15. Fees

Each Payment Attempt carries:

```text
gross
fee
net
```

The system must distinguish:

```text
estimated fee
actual fee
```

Initially the fee is estimated from the existing rate card. Once reliable actual
fee data is available from MantaPay, the actual value replaces or updates the
estimate — and the attempt must record which of the two it is currently
holding. Inferring "actual" from a non-zero fee is not sufficient.

---

## 16. Provider Payer Data — Investigation

Required by §19. This documents what MantaPay provides today, established by
reading the integration code.

| Source | Payer fields available | Trustworthy? |
|---|---|---|
| Payment notification (webhook) | `client_email`, `client_fullname`, `payment_details` | **Not signed** |
| Status check by order | none | — |
| Transaction Search | requested but not extracted | unknown |

Detail:

**Webhook** gives email and full name, and a `payment_details` string (masked
instrument). **There is no phone field.** None of them are covered by the
notification signature, which spans only
`trans_id, trans_order, reply_code, trans_amount, trans_currency`. They are
therefore acceptable as *reporting* data — which is exactly what §6 requires —
but must never gate money or authorization. This is a further reason the v1
payer-email rule was removed.

**Status check by order** returns reply code, transaction id, date, amount,
currency and order only. No payer data at all. It cannot populate these fields.

**Transaction Search** already sends `LoadPayer: true`, so the provider is being
asked for payer data, but the response normaliser extracts only
`PaymentDisplay` and `PaymentData.BinCountry` and discards the rest. The shape
and field names of the Payer object are **unknown and must be confirmed against
a live response** before it can be relied on.

Consequences for this specification:

* `payer_email` and `payer_name` can be populated today, from the webhook.
* `payer_phone` cannot be populated from any confirmed source.
* If Search proves to return a richer, signed payer record, it becomes the
  preferred source and the webhook values become a fallback.

This must be resolved before the payer fields in §5 are treated as complete.

---

## 17. API Requirements

The existing authorization model is unchanged.

```http
POST /workspaces/:wid/links
```

Create a Link. The request selects:

```text
link_type:   CUSTOMER | PUBLIC
usage_type:  SINGLE_USE | MULTI_USE
```

For a Customer Link, `customer_id` and `customer_email` may be provided.
For a Public Link, both null is valid.

Additional fields: `amount`, `currency`, `max_payments`, `expires_at`,
`description` / reference.

```http
GET /workspaces/:wid/links
```

List Links. Each row includes: link type, customer (if any), amount, currency,
usage type, payment count, total paid, Link status, expiration.

```http
GET /workspaces/:wid/links/:id
```

Link detail including the payment summary of §18.

```http
GET /workspaces/:wid/links/:id/transactions
```

All Payment Attempts for the Link.

```http
POST /workspaces/:wid/links/:id/cancel
```

Cancel an ACTIVE Link.

```http
POST /workspaces/:wid/links/reconcile
```

Reconcile pending / stuck Payment Attempts.

Existing transaction endpoints for refunds and chargebacks remain, with
automatic provider chargebacks added through the webhook flow.

---

## 18. Link Details

The detail response must explain the Link and its activity without a second
query, and must keep **Customer** and **Actual Payer** visibly distinct.

Customer Link:

```text
Payment Link
-------------------------
Type: Customer

Customer: John Smith
Email: john@example.com

Amount: $100
Currency: USD
Usage: Multi-use
Max payments: 3

Status: Active
Expires: 14:32

Payments:
3 attempts
2 successful
1 declined

Total paid: $200

Latest payment:
Status: Approved
Payer: jane@example.com
Transaction: MP-12345
```

Public Link:

```text
Payment Link
-------------------------
Type: Public

Customer: None

Amount: $100
Currency: USD
Usage: Single-use

Status: Used

Payments:
2 attempts
1 successful
1 declined

Total paid: $100

Latest successful payment:
Status: Approved
Payer: jane@example.com
Transaction: MP-12345
```

Note the first example: the intended customer is John, the actual payer is
Jane, and the payment is valid.

---

## 19. Final Business Rules

The implementation is correct when:

**Link model**

* A Payment Link is either CUSTOMER or PUBLIC.
* A Customer Link may be associated with a specific customer.
* A Public Link does not require a customer.
* Customer association is optional at the Link level.
* Multiple active Links can exist for the same customer.

**Payer**

* Payer email is never required to match customer email.
* Actual payer information is captured from the provider whenever available.
* Intended customer and actual payer are separate, separately exposed values.

**Usage**

* Every Link is Single-use or Multi-use.
* Single-use Links allow one successful payment.
* Multi-use Links allow multiple successful payments.
* The multi-use amount applies per payment.
* `max_payments` limits successful payments, not attempts.
* Declined payments do not consume the limit.
* Pending payments do not consume the limit.

**Attempts and status**

* Every Payment Attempt is stored independently.
* Link status is separate from Payment Attempt status.
* A declined attempt does not change the Link status.
* The current status of every Link is visible.
* The full status history of every Payment Attempt is visible.

**Integrity**

* Duplicate webhooks cannot create duplicate sales.
* Concurrent payments cannot bypass single-use or `max_payments` rules.
* Expired Links cannot accept new payments.
* Cancelled Links cannot accept new payments.

**Lifecycle**

* Missing or delayed webhooks are resolvable through reconciliation.
* Reconciliation eventually runs automatically.
* Chargebacks update the Payment Attempt and the ledger automatically.
* Refunds remain separate from chargebacks.
* Estimated and actual fees are distinguishable.

**Unchanged**

* Existing authorization rules remain as they are.

### Prerequisite

§16 must be closed before the payer fields are considered complete: confirm
against a live MantaPay response which payer fields the Search API returns, and
use the most reliable provider source available to populate `payer_email`,
`payer_name` and `payer_phone`.

---
---

# Part II — Money Distribution / Settlement Split

Every successful payment must produce a complete, balanced, auditable
distribution of the gross amount. This part defines it.

The requirement was written against an assumed model
(`MantaPay / Bank / Account / Agent`). The system already has a distribution
engine, and it does not match that shape. §20 records what actually exists,
§21 records the conflicts that must be resolved before implementation, and
§22 onward define the target model in terms of the real engine.

---

## 20. Existing Distribution Engine — Inventory

Established by reading `backend/migrations/` and `backend/src/`. This is the
source of truth to extend. **Do not build a second distribution system.**

### 20.1 Where everything lives

| # | Question | Answer |
|---|---|---|
| 1 | Global fee configuration | `platform_fee_rates`, keyed by **organization**, effective-dated (`005`, `019`, `026`) |
| 2 | MantaPay fee calculation | `psp_cost_breakdown(org, gross, at)` (`027:28`) |
| 3 | Bank allocation | **Does not exist.** No bank party anywhere in the schema |
| 4 | Account configuration | `accounts.revenue_model`, `accounts.revenue_split_pct` (`001:130`, `007:29`) |
| 5 | Agent configuration | `memberships.commission_pct` (`016:3`), falling back to `commission_rules.agent_pct` |
| 6 | Link → Account | `payment_links.account_id`, copied to `transactions.account_id` |
| 7 | Link → Agent | `payment_links.created_by` (a membership), copied to `transactions.attributed_membership_id` |
| 8 | Ledger entry creation | `fn_post_sale(tx)` — current version in `031:196` |
| 9 | Multiple entries per payment | **No.** One `commission_entries` row per event, with the parties as *columns* |
| 10 | Existing distribution logic | Yes — the payout engine, `007` onward. Reused by refunds, payouts, analytics, fees reporting |
| 11 | Existing split functions | `fn_post_sale`, `fn_post_refund`, `fn_post_chargeback`, `psp_cost_breakdown`, `effective_platform_fee`, `effective_settlement_fees`, `effective_refund_fee`, `effective_reserve`, `workspace_blended_rate` |
| 12 | Hard-coded percentages | One: `commissions.routes.js:33` defaults the console display to `70/30/0` when no rule row exists. Not used in settlement |
| 13 | Refund reversal | `fn_post_refund` (`031:262`) — negates the stored sale entry |
| 14 | Chargeback reversal | `fn_post_chargeback` (`031:297`) — same shape, different fee |

### 20.2 Configuration mapping

| Configuration source | What it controls | Applies to | Formula | Ledger destination |
|---|---|---|---|---|
| `platform_fee_rates.mdr_pct` / `psp_rate_pct` | provider processing commission | organization, effective-dated | `gross * mdr/100` | `fee_mdr` |
| `platform_fee_rates.psp_fixed_fee` | provider per-transaction fee | organization | flat | `fee_fixed` |
| `platform_fee_rates.settlement_pct` | provider settlement fee | organization | `gross * s/100` (flat model) or `(gross - mdr - fixed) * s/100` (cascade model) | `fee_settlement` |
| `platform_fee_rates.fee_model` | whether the above cascade | organization | `'flat'` or `'cascade'` | — |
| `platform_fee_rates.margin_rate_pct` | HigherPays margin | organization | `round(gross * margin/100, 2)` | `platform_margin` |
| — (derived) | total deducted from gross | — | `round(psp_total + margin, 2)` | `platform_fee` |
| `accounts.revenue_model` | whether the account shares revenue | account | `revshare` → use split; `salary` / `ai` → 0 | `revenue_model` |
| `accounts.revenue_split_pct` | account cut | **that account** | `round(distributable * split/100, 2)` | `account_amount` |
| `memberships.commission_pct` | agent cut (override) | **that agent** | `round(distributable * pct/100, 2)` | `agent_amount` |
| `commission_rules.agent_pct` | agent cut (workspace default) | workspace, effective-dated | used only when the membership value is `NULL` | `agent_amount` |
| — (derived) | agency remainder | — | `distributable - account - agent` | `agency_amount` |
| `settlement_fee_config.chargeback_fee` | flat chargeback cost | organization, effective-dated | flat | `chargeback_fee` |
| `settlement_fee_config.refund_fee` | flat refund cost | organization | flat | `chargeback_fee` (shared column) |
| `settlement_fee_config.reserve_pct` | rolling reserve held by provider | organization | not applied at settlement | — |
| `transactions.surcharge` | payer-paid extra (provider `EC`) | per transaction | passthrough | `fee_surcharge` |

### 20.3 The actual formula

`fn_post_sale` (`031:196`), exactly as implemented:

```text
b             = psp_cost_breakdown(org, gross, occurred_at)
margin_val    = round(gross * margin_rate_pct / 100, 2)
platform_fee  = round(b.total + margin_val, 2)

psp_fee       = transactions.fee   if transactions.fee > 0
              = b.total            otherwise

distributable = gross - platform_fee            -- must be > 0

account_amt   = round(distributable * split / 100, 2)
agent_amt     = round(distributable * agent_pct / 100, 2)
agency_amt    = distributable - account_amt - agent_amt   -- absorbs rounding
```

Guards already enforced:

* `split + agent_pct > 100` → `split_exceeds_100`, refuses to post.
* `distributable <= 0` → `nothing_to_distribute`, refuses to post.
* CHECK `commission_entries_sale_parts_sum`:
  `account_amount + agent_amount + agency_amount = distributable`
  (`NOT VALID`, so it binds new rows only).

The parties are therefore **five**, not four:

```text
Gross
 ├── PSP cost        (fee_mdr + fee_fixed + fee_settlement)   → provider
 ├── Platform margin (platform_margin)                        → HigherPays
 ├── Account share   (account_amount)                         → the account
 ├── Agent share     (agent_amount)                           → the agent
 └── Agency remainder(agency_amount)                          → the agency
```

`platform_fee = PSP cost + platform margin`, and
`gross = platform_fee + distributable`, and
`distributable = account + agent + agency`.

So the distribution already balances by construction. The remainder in the
requirement's example — the "$150 with no destination" — is `agency_amount`.
It is explicitly the agency's, not an unassigned residue.

---

## 21. Conflicts That Must Be Resolved First

Per the Critical requirement: these are identified, not silently decided.

### 21.1 Two sources of truth for the account split — one is inert

`commission_rules.account_split_pct` and `agency_split_pct` are written by
`POST /commissions` (`commissions.routes.js:57`), returned to the console,
and seeded by the platform routes and `seed.js`.

**`fn_post_sale` never reads either column.** The account share comes from
`accounts.revenue_split_pct`. An operator who changes the workspace split in
the console changes nothing about how money is distributed.

Only `commission_rules.agent_pct` is actually read, and only as a fallback
when the membership has no `commission_pct`.

This must be decided before implementation: either the engine starts reading
`commission_rules`, or those columns and their UI are removed. Keeping both
is the current bug.

### 21.2 There is no Bank party

The requirement names a Bank share. Nothing in the schema, the functions, or
the fee configuration models a bank. It must be established whether "Bank"
means:

* the provider settlement fee (`fee_settlement`) under a different name,
* the acquiring bank's cut inside the MDR — in which case it is already inside
  `fee_mdr` and is not separable from provider data we hold, or
* a genuinely new sixth party requiring new configuration, a new ledger column,
  and a migration.

Until this is answered, "Bank" cannot be implemented.

### 21.3 Actual fee breaks the margin decomposition

`platform_fee` is computed from the **estimated** PSP cost, while `psp_fee`
stores the **actual** one when `transactions.fee > 0`. When the two differ:

```text
platform_fee   = estimated_psp + margin        (deducted from gross)
platform_margin = margin                        (recorded as HigherPays' cut)
psp_fee        = actual_psp                     (recorded as the real cost)

real margin    = platform_fee - psp_fee  ≠  platform_margin
```

The distribution still balances against gross, but `platform_margin` stops
being true. The target model must define whether the actual fee re-prices the
settlement or is recorded as a variance.

### 21.4 Estimated vs actual is inferred, not recorded

There is no flag. `fn_post_sale` treats `transactions.fee > 0` as "actual".
A genuine zero-fee transaction is indistinguishable from an unreconciled one,
and today **every** MantaPay payment writes `fee = 0` (§16), so the estimate
branch always runs.

### 21.5 Itemised fees do not sum to the recorded total

`fee_mdr`, `fee_fixed`, `fee_settlement` are stored unrounded in
`numeric(14,4)`; `psp_fee` and `platform_fee` are rounded to 2 decimals. The
components can differ from the total by a fraction of a cent. Acceptable for
reporting, not for a balance assertion — the rounding rule in §25 must say
which one is authoritative.

### 21.6 Refund fee and chargeback fee share a column

`fn_post_refund` writes the refund fee into `commission_entries.chargeback_fee`.
Two distinct fees, one column, distinguishable only by `entry_type`.

### 21.7 Account and agent configuration is not versioned

Fee rates are effective-dated and read at `t.occurred_at`, so they are
historically stable. `accounts.revenue_split_pct` and
`memberships.commission_pct` are **current values with no history**. The posted
entry is immutable, so a historical payment's *stored* amounts never change —
but the configuration that produced them cannot be reconstructed. This is the
gap §26 closes.

### 21.8 Dead configuration

* `transactions.platform_fee_rate`, `transactions.platform_fee`,
  `transactions.platform_margin` (`005`) are never written by any code.
* `effective_decline_fee` (`020`) is displayed in the workspace settings
  response and never charged.

---

## 22. Core Principle

A successful payment does not simply create one Ledger Sale. It creates a
complete distribution record showing where every unit of the gross went.

```text
Customer Payment
      ↓
Gross Amount
      ↓
Distribution Configuration  (resolved and snapshotted)
      ↓
Distribution Calculation
      ↓
├── Provider cost   (MDR + fixed + settlement)
├── Platform margin (HigherPays)
├── Account share
├── Agent share
└── Agency remainder
```

Participants and rates come from configuration. Percentages and formulas are
never hard-coded in Payment Link or payment-processing code.

---

## 23. Configuration Levels

Two levels, with an explicit precedence.

### Global — organization level

Applies to every Link in every workspace of the organization, unless a rule
below overrides it.

```text
platform_fee_rates      provider cost model + HigherPays margin
settlement_fee_config   chargeback fee, refund fee, reserve
```

Both are effective-dated and resolved at the transaction's `occurred_at`.

### Link level — via Account and Agent

The Link does not carry its own percentages. It carries the two references
that select them:

```text
Payment Link
    │
    ├── account_id  → accounts.revenue_model, accounts.revenue_split_pct
    │
    └── created_by  → memberships.commission_pct
                       ↳ falls back to commission_rules.agent_pct
```

The Link must not duplicate Account or Agent configuration, except as the
immutable settlement snapshot of §26 — which is a record of what was used, not
a second place to configure it.

### Precedence

```text
Agent share     memberships.commission_pct
                    ↓ if NULL
                commission_rules.agent_pct (workspace default)
                    ↓ if no rule row
                0

Account share   accounts.revenue_split_pct, but only when
                accounts.revenue_model = 'revshare'
                    ↓ otherwise
                0   (salary and ai accounts are paid outside the per-sale split)

Provider cost   platform_fee_rates for the organization at occurred_at
                    ↓ if no rate row
                0
Platform margin same row; 0 when absent
```

### Missing configuration

| Situation | Behaviour |
|---|---|
| Link has no Account | account share = 0; the amount falls to the agency remainder |
| Account has no split configured | column is `NOT NULL DEFAULT 70.00`; the default applies |
| Account is not `revshare` | account share = 0 by model, not by error |
| Link has no Agent | agent share = 0 |
| Agent has no `commission_pct` | workspace default, then 0 |
| No fee rate row for the organization | provider cost and margin = 0 — **the whole gross becomes distributable**. §29 must treat this as invalid configuration rather than a free payment |

---

## 24. Distribution Must Balance

Every settled payment must satisfy:

```text
gross = provider_cost + platform_margin + account + agent + agency
```

equivalently, as the engine expresses it:

```text
gross         = platform_fee + distributable
distributable = account_amount + agent_amount + agency_amount
```

The second identity is already enforced by the
`commission_entries_sale_parts_sum` CHECK. The first holds by construction.

No portion of the gross may be unassigned. The requirement's "remaining $150"
has a destination — `agency_amount` — and that must stay explicit in every
report rather than being presented as a leftover.

If a configuration produces an unassignable remainder, or a negative
distributable, settlement is **refused**, not posted. `fn_post_sale` already
raises `nothing_to_distribute` and `split_exceeds_100`; that behaviour is
correct and must be preserved.

Money is never silently lost, duplicated, or created by rounding.

---

## 25. Decimal and Rounding Rules

All money math is exact NUMERIC in Postgres. Floating point is never used for
a financial value, in the database or in application code.

| Rule | Value |
|---|---|
| Currency precision | 2 decimal places |
| Stored fee itemisation | 4 decimal places (`numeric(14,4)`) |
| Percentage precision | 2 decimal places (`numeric(5,2)`) |
| Rounding mode | Postgres `round()` on NUMERIC — half away from zero |
| When rounding occurs | once per party, at allocation; provider components are computed unrounded and rounded only in the total |
| Who absorbs the difference | the agency remainder, computed by subtraction rather than by percentage |

Worked example of the requirement's case:

```text
Gross = 100.00,  MDR 2.995%,  settlement 1.995%

mdr        = 2.995000      (unrounded, numeric(14,4))
settlement = 1.995000
psp total  = 4.990000
margin 0%  = 0.00
platform_fee = round(4.990000 + 0.00, 2) = 4.99
distributable = 100.00 - 4.99 = 95.01
```

The residual never accumulates: because `agency_amount` is a subtraction and
not a percentage, the parts always sum to `distributable` exactly, at any
precision.

§21.5 must be closed as part of this: define whether `psp_fee` or the sum of
its three components is authoritative when they disagree in the fourth decimal.

---

## 26. Configuration Snapshot

**Option B — snapshot.** The applicable configuration is captured at
settlement and stored with the Payment Attempt.

> A historical payment must always be explainable using the exact distribution
> rules that were used when it was settled.

Changing an Account's split or an Agent's commission tomorrow must not change
how yesterday's payment appears to have been distributed, nor how it would be
explained.

The snapshot is taken **at settlement**, not at Link creation, because a
multi-use Link settles many times and each settlement is priced independently
(§28). For a single-use Link the two moments differ only by the checkout
duration.

The snapshot must record, per settled attempt:

```text
account_split_pct        the value used
account_revenue_model    the model used
agent_pct                the value used
agent_pct_source         'membership' | 'workspace_rule' | 'default'
mdr_pct, settlement_pct, psp_fixed_fee, fee_model
margin_rate_pct
platform_fee_rates row id + effective_from
commission_rules row id + effective_from   (when it was the source)
fee_basis                'estimated' | 'actual'
```

Today the effective-dated fee tables give this for provider cost and margin,
but not for the account and agent percentages (§21.7). Closing that is the
substance of this section.

---

## 27. Payment Attempt Distribution

Every settled Payment Attempt carries or references its complete distribution:

```text
Payment Attempt
-------------------------
Gross: $1,000

Distribution:
Provider (MDR + fixed + settlement): $30
Platform margin:                     $20
Account:                            $700
Agent:                              $100
Agency:                             $150
```

The system must be able to answer *why did this payment produce these exact
amounts* from stored data alone, without consulting today's configuration.

Distribution is linked to the Payment Attempt and to the provider transaction
id, so any amount can be traced back to the payment that produced it.

---

## 28. Multi-use Links

Distribution is calculated **independently for every successful Payment
Attempt**. The Link is never aggregated first and split afterward.

```text
Link, amount $100, MULTI_USE

Payment #1 → gross $100 → its own distribution, its own snapshot
Payment #2 → gross $100 → its own distribution, its own snapshot
```

Two settlements on the same Link may legitimately distribute differently if
configuration changed between them. That is correct, and the snapshot is what
makes it explainable.

---

## 29. Pending, Declined and Invalid

No ledger distribution is created for:

```text
PENDING     → no distribution
DECLINED    → no distribution
ABANDONED   → no distribution
```

Only `APPROVED` produces entries.

Before posting, the distribution configuration is validated:

```text
Account exists when the Link references one
Agent exists when the Link references one
A fee rate row exists for the organization
Percentages are within 0–100
account_split + agent_pct <= 100
All amounts are non-negative
distributable > 0
The parts sum to distributable
```

The missing-fee-rate case of §23 is an error here, not a zero. An organization
with no rate row must not settle a payment as if processing were free.

On invalid configuration the payment is **not** silently settled incorrectly.
The Payment Attempt remains recorded, marked as awaiting settlement, and is
surfaced for reconciliation or manual intervention under the existing payment
lifecycle. The Link is not advanced to USED.

---

## 30. Ledger Integration and Idempotency

```text
MantaPay
   ↓
Approved
   ↓
Validate Payment                (§8)
   ↓
Load Distribution Configuration (§23)
   ↓
Calculate Distribution          (§20.3)
   ↓
Validate Distribution Balances  (§24, §29)
   ↓
Store Payment Attempt + snapshot
   ↓
Post Ledger Entries
   ↓
Mark Payment Settled
   ↓
Update Link
```

The sale is never posted before the distribution has been calculated and
validated.

Distribution and settlement are idempotent **together**. Two deliveries of the
same webhook must produce exactly one financial settlement — not two provider
allocations, two account allocations, or two agent commissions.

The attempt record, the distribution snapshot and the ledger entries are
written in the same database transaction, under the same concurrency
protection as §9. A duplicate is detected before any entry is written, not
compensated afterward.

---

## 31. Refunds and Chargebacks

A reversal uses the **original settlement distribution**. It never recalculates
from current configuration.

```text
Original settlement          Reversal
-------------------          --------
Provider   $30               + $30 restored?  → per existing rules
Platform   $20
Account   $700               - $700
Agent     $100               - $100
Agency    $150               - $150
                             + reversal fee, per revenue model
```

The existing functions already implement this correctly: `fn_post_refund` and
`fn_post_chargeback` read the stored sale entry and negate its recorded
amounts. The reversal fee falls on the account for a `revshare` model and on
the agency otherwise, and the agent always loses the commission.

Two things must be fixed rather than reproduced:

* the refund fee must stop sharing a column with the chargeback fee (§21.6);
* a chargeback arriving from the provider must reach `fn_post_chargeback`
  automatically (Part I §14), rather than requiring an operator.

Reversal remains a single event per settlement: both functions already refuse
a second reversal of the same transaction.

---

## 32. Reporting

The Link detail response exposes the aggregate:

```text
Payment Link
-------------------------
Amount: $1,000
Status: USED

Payments: 1 successful
Total Gross: $1,000

Distribution:
Provider:        $30
Platform margin: $20
Account:        $700
Agent:          $100
Agency:         $150
```

The Payment Attempt detail exposes the same breakdown for that single payment,
plus the snapshot that produced it. Between them the system answers:

* How much was paid?
* How much went to the provider, itemised into MDR, fixed and settlement fees?
* How much was HigherPays margin?
* How much went to the Account, and under which revenue model?
* How much went to the Agent, and from which configuration source?
* What remained for the agency?
* Was the provider fee estimated or actual?
* Which configuration versions produced these amounts?

---

## 33. Auditability

For every settled Payment Attempt, retain:

```text
Gross amount, currency, surcharge

Distribution amounts       (provider itemised, margin, account, agent, agency)
Distribution percentages   (as snapshotted, §26)
Fee basis                  estimated | actual

platform_fee_rates version
commission_rules version   (when it was the agent source)
Account configuration used
Agent configuration used

Calculation timestamp

Payment Attempt id
Provider transaction id
Ledger entry ids
```

The exact calculation for any historical payment must be reconstructable from
these values alone.

---

## 34. Final Business Rules — Distribution

The distribution model is correct when:

* Every successful Payment Attempt has a complete financial distribution.
* Global settings apply to provider cost and platform margin.
* Account settings apply to the Account associated with the Link.
* Agent settings apply to the Agent associated with the Link.
* Another Account's or Agent's configuration is never used.
* The precedence in §23 is deterministic and documented, including every
  missing-configuration case.
* The distribution always balances with gross.
* No portion of gross is unassigned; the agency remainder is explicit.
* All money math is exact decimal.
* Rounding is deterministic, applied once per party, with the remainder
  absorbed by subtraction.
* Historical settlements stay explainable after configuration changes.
* Duplicate webhooks cannot create duplicate distributions.
* Concurrent settlements cannot create duplicate distributions.
* Pending, declined and abandoned payments create no distribution.
* Invalid configuration refuses settlement rather than posting a wrong one.
* Refunds and chargebacks reverse the original settlement, not a recalculation.
* Every distribution traces to its Payment Attempt and provider transaction.
* Estimated and actual provider fees are distinguishable by a stored flag,
  not inferred from a non-zero value.
* Existing authorization rules remain unchanged.

### Blocking prerequisites

Implementation cannot start until these are answered:

1. **§21.1** — does the engine read `commission_rules.account_split_pct`, or
   are those columns removed?
2. **§21.2** — what is "Bank"?
3. **§21.3** — when the actual provider fee differs from the estimate, does the
   settlement re-price or record a variance?
