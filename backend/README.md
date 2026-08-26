# HigherPays — Backend

Creator-agency operating system. Node.js + Express + PostgreSQL.

HigherPays is the **platform**: it sells this system to creator agencies. It is not
itself an agency. Each customer agency is one workspace; the platform charges
each agency a margin on top of the payment provider's cost.

Card data never touches this system — payers complete payment on the provider's
hosted page, so the application is out of PCI scope.

---

## Quick start

```bash
npm install
cp .env.example .env          # then fill it in

createdb higherpays
npm run migrate               # run as the database OWNER
npm run seed                  # optional demo data

npm start
```

Open `http://localhost:3000` — the console is served from `public/index.html`.

### Database roles (important)

Run **migrations as the owner**, run **the app as a restricted role**:

```sql
CREATE ROLE hp_app LOGIN PASSWORD '...' NOSUPERUSER;
GRANT USAGE ON SCHEMA public TO hp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hp_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO hp_app;
```

The app role owns nothing and cannot run DDL, so a bug in a route cannot
alter the schema. Migrations need the owner.

---

## Tests

```bash
npm test                  # unit tests, no database needed
npm run test:integration  # every HTTP flow against a live Postgres (DATABASE_URL, as hp_app)
```

The integration tests onboard their own agencies through `/platform/agencies`,
so they run on any database built from the migrations and never need a wipe.

**Treat a failing signature test as a release blocker.** Those vectors were
verified against MantaPay's own Signature Generator and Signature Validator; if
they break, payment links are rejected in production with reply `500`.

---

## Architecture

```
src/
  schema/entities.js     THE data model; scripts/generate-schema.js emits migrations/001_init.sql
  server.js              route mounting
  config.js              all env config + production guards
  db.js                  query / withTransaction
  middleware/            auth, workspace access, permissions
  auth/permissions.js    the role -> permission matrix
  auth/dataScope.js      which rows a role sees
  services/              payment outcomes, people (login + profile), split guards
  providers/             MantaPay integration (see below)
  routes/                HTTP layer
  notify.js              in-app + Telegram notifications
  settlement/parse.js    settlement report (XLSX) parser
migrations/              001 generated, 002 the revenue engine by hand
test/                    unit + integration tests
```

### Database access

`query(text, params)` for one statement, `withTransaction(fn)` for anything
that writes more than one row. There is no row-level security: every workspace
query filters on `req.access.workspaceId` itself, and `requireWorkspace` has
already checked the caller holds an active role there.

### Money

All financial math is exact `NUMERIC` in PostgreSQL — never JavaScript floats.

`fn_post_sale(transaction_id)` writes one `revenue_entries` row per sale with
every fee itemised, split by the account's `revenue_split_pct` and the agent's
`commission_pct`. Chargebacks and refunds are posted as **negative entries**
(`fn_post_chargeback`, `fn_post_refund`), so summing the ledger gives the net
position and nothing is ever deleted.

Fee model is per-workspace and effective-dated:

| Model | On EUR 100 at 7% + 0.50 + 1% |
|---|---|
| `flat` | each % on the original gross -> 8.50 |
| `cascade` | 100 -7% = 93.00 -0.50 = 92.50 -1% -> 8.425 |

Rate changes never re-price historical transactions.

---

## MantaPay integration

The provider is MantaPay. Three different hosts:

| Purpose | Host |
|---|---|
| Hosted payment page | `uiservices.mantapay.biz` |
| Status check | `process.mantapay.biz` |
| Search API / login | `webservices.mantapay.biz` |

```
providers/
  mantapay.js            adapter — the surface routes call
  mantapay-signature.js  request + notification signatures, reply codes
  mantapay-checkout.js   hosted-page URL / POST form
  mantapay-status.js     status check (by order, by transaction id)
  mantapay-search.js     transaction search — PER-TRANSACTION FEES
  mantapay-auth.js       webservices login + session caching
```

### Signatures — read this before touching them

**Request signature:** `urlencode(base64(SHA256(values + hashKey)))`

Two rules that are easy to get wrong and are not stated plainly in their docs:

1. **The hash input is the raw value with spaces replaced by `+`** — nothing else
   escaped. Not the URL-encoded value (their Signature page implies this) and not
   the fully raw value (their Validator page says this). Both are wrong as
   written; the real behaviour came from the Validator's field-by-field output
   and is pinned in `test/mantapay.test.js`.
2. **Whatever order you emit parameters, sign in that same order.** There is no
   fixed field list. `mantapay-checkout.js` builds the query string and the
   signature from one array so they cannot diverge.

**Notification signature** covers only a subset of fields:

```
payment    trans_id + trans_order + reply_code + trans_amount + trans_currency + key
chargeback trans_id + action + reason + reasonCode + comment + originalID + OrderId + key
```

Client details, `trans_date` and `reply_desc` are **not signed** — never trust
them for anything affecting the ledger.

### Reply codes

`000` approved - `553`, `663`, `001` **all pending** - everything else declined.

Codes are **strings** — dotted (`100.011`), alphanumeric (`N7`, `5C`) and with
leading zeros (`001`). Parsing them as integers silently breaks `001`.

### What MantaPay does not send

Notifications carry **no fee and no net amount**. At notification time the sale is
priced from the agency's rate card; the Search API supplies the actual
per-transaction fee afterwards. `parseWebhook` returns `fee: null` deliberately
rather than pretending zero.

### Not yet implemented

- **Refunds** — their two-step admin-approved flow is unread. The console
  *records* refunds issued in their dashboard. Set `MANTAPAY_REFUND_ENABLED=true`
  once built.
- **Scheduled reconciliation** — the Search API client exists but no job calls it.

**Two open questions block go-live.** See `OPEN-QUESTIONS-MANTAPAY.md`.

---

## Key endpoints

| Endpoint | Purpose |
|---|---|
| `POST /webhooks/payment/:endpointId` | Provider notifications (per-workspace URL) |
| `GET  /workspaces/:id/analytics` | Role-scoped analytics |
| `GET  /workspaces/:id/payouts/breakdown` | Balances owed, reserve-aware |
| `POST /workspaces/:id/payouts/run` | Settle balances per party |
| `GET  /workspaces/:id/fees` | Itemised fee reporting |
| `GET  /workspaces/:id/me/earnings` | Self-scoped earnings (chatter / creator) |
| `POST /workspaces/:id/settlements/import` | Import a settlement report (XLSX) |
| `POST /workspaces/:id/links/reconcile` | Resolve links whose notification never arrived |
| `GET  /platform/fees` | Operator view across all agencies |

---

## Further reading

| Document | Contents |
|---|---|
| `OPEN-QUESTIONS-MANTAPAY.md` | 23 unanswered questions; 2 block go-live |
| `PROVIDER-CONSTRAINTS.md` | Provider limitations and how each is mitigated |
