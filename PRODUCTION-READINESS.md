# HigherPays — Production Readiness

Status of this repo against what a payments product needs before it holds real money for real
agencies, and the ordered work to get there.

Reviewed: 2026-08-24, branch `cleanup/raise-standard`.
Second pass added authorization internals, the commission math, the platform-admin surface, and
row-level scoping.

**How to use this file.** Work top to bottom. P0 blocks launch. P1 blocks scale. P2 is hardening.
P3 is maturity. Each item says what is wrong, where, and what to do. Tick items off as you go.

---

## Verdict

The domain modelling is strong. The infrastructure around it is not.

The ledger, the RLS tenant boundary, and the MantaPay integration were built by someone who
understood the problem. Money is exact NUMERIC, tenant isolation is enforced by Postgres rather
than by hope, and the provider adapter records *why* every byte is shaped the way it is. That core
is better than most products at this stage.

Everything that surrounds that core — CI, secrets delivery, backups, logging, container hardening,
pagination — is either missing or half-wired. The result is a system that is correct in the small
and fragile in the large: it can compute a commission perfectly and lose the payment that triggered
it, and nobody would find out.

| Area | State | Notes |
|---|---|---|
| Domain model & ledger | Strong | NUMERIC money, SECURITY DEFINER posting functions, idempotency keys |
| Tenant isolation | Strong | RLS + boot-time assertion the DB role cannot bypass it |
| Provider integration | Strong | Signature scheme verified against live vectors, regression-tested |
| Auth primitives | Good | scrypt, timingSafeEqual, hashed refresh tokens, TOTP |
| Auth hardening | Good | Rate limits + account lockout, refresh-token reuse detection, session revoke (2026-08-25) |
| Authorization | Good | Escalation closed, offboarding + role changes revoke sessions, platform roles enforced (2026-08-25) |
| Money math | Good | Cents rounding, DB-enforced sum, split bounds, no late un-approve, one payout per run (2026-08-25) |
| API surface | Fair | Keyset pagination and request ids; two error conventions and no versioning remain |
| Build & CI | Good | Tree compiles; CI runs lint, tsc, unit, integration (with RLS) and image builds (2026-08-25) |
| Secrets delivery | Good | Compose refuses to boot without secrets; the whole `.env` reaches the container (2026-08-25) |
| Data durability | Fair | Backup + restore scripts, restore-tested locally; cron, S3 and WAL archiving still to set up on the box |
| Observability | Fair | Structured request logs with ids, DB-aware health; no error tracking or alerting yet |
| Container security | Good | Non-root, read-only, resource limits, healthchecks, security headers (2026-08-25) |
| Accessibility | Fair | Dialogs, labels and tables fixed, jsx-a11y in CI; keyboard pass still to do |

Rows marked 2026-08-25 were re-graded after the fixes on branch `cleanup/raise-standard`; the
original findings are kept below with their checkboxes.

---

## P0 — Blocks launch

Nothing below this line matters until these are done.

### P0.1 The frontend does not compile — DONE 2026-08-24

The review caught the `cleanup/raise-standard` branch mid-rewrite. The demo-mode removal is
finished: every page is live, the legacy type system is gone, and the pages that carried the lint
errors (`Settings`, `Analytics`, `NotificationBell`) were rewritten.

- [x] Finish the demo-mode removal
- [x] `cd frontend && npx tsc -b` → zero errors
- [x] `cd frontend && npm run lint` → zero errors

### P0.2 Production can boot with a publicly known JWT secret

`config.js:75` refuses to start in production if the secret equals its own dev fallback:

```js
config.jwtSecret === 'dev-only-insecure-secret-change-me'
```

But `docker-compose.yml:47` supplies a *different* default:

```yaml
JWT_SECRET: ${JWT_SECRET:-dev-only-insecure-change-me}
```

The strings differ (`insecure-secret-change-me` vs `insecure-change-me`). If `.env` is missing
`JWT_SECRET`, the container boots happily with a secret that is committed to this repository.
Anyone reading the repo can forge an access token for any user id.

- [x] Delete the default from `docker-compose.yml` — compose now refuses to start without `JWT_SECRET`
- [x] Same for `POSTGRES_PASSWORD` and `HP_APP_PASSWORD`
- [x] `config.js` rejects any production secret shorter than 32 characters
- [ ] Rotate `JWT_SECRET` on the EC2 and confirm the current value is not a repo default
      (`openssl rand -base64 48`; every user signs in again afterwards)

A guard that matches one exact string is a guard that will be routed around by accident. Check the
property (length, entropy), not the value.

### P0.3 Eighteen environment variables never reach the container

The backend reads 33 env vars. `docker-compose.yml` passes 21. The gap:

```
WEBHOOK_PUBLIC_BASE     MANTAPAY_API_EMAIL      MANTAPAY_API_PASSWORD
MANTAPAY_APP_TOKEN      MANTAPAY_SEARCH_SALT    MANTAPAY_REFUND_ENABLED
MANTAPAY_HOSTED_BASE    MANTAPAY_SEARCH_BASE    MANTAPAY_PROCESS_BASE
TELEGRAM_BOT_TOKEN      TELEGRAM_API_BASE       LINK_TTL_MINUTES
SEED_MID                SEED_PSP_RATE           SEED_MARGIN_RATE
SEED_CREATOR_SPLIT      SEED_CHATTER_PCT        SEED_CHARGEBACK_FEE
```

Consequences, all silent:

- **`HANDOFF.md` §9 P0 is broken.** It instructs you to add `WEBHOOK_PUBLIC_BASE=https://higherpays.com/api`
  to `.env`. Compose never forwards it, so `config.webhookPublicBase` stays null, `notificationUrl`
  is `undefined` (`links.routes.js:28`), and every hosted checkout is built without a notify URL.
  You would follow the documented launch recipe exactly and it would not work.
- **Fee reconciliation is dead.** The Search API needs `MANTAPAY_API_EMAIL/PASSWORD/APP_TOKEN/SEARCH_SALT`.
  Without them, `fee` stays at the 0 placeholder from `payments.service.js:59` forever and the
  payout engine prices every sale from the rate card estimate with nothing ever correcting it.
- **Telegram notifications are dead.**
- **Per-workspace hash keys are unusable.** `provider_config_ref` names an env var to resolve
  (`mantapay.js:34`). That named var also cannot be passed through compose, so every workspace
  falls back to the single global `MANTAPAY_HASH_KEY`. Multi-merchant support does not work today.

- [x] The backend container now receives the whole `.env` (`env_file`), with compose only
      supplying the computed values (`DATABASE_URL`, `MIGRATIONS_DATABASE_URL`, `USE_RLS`, `PGUSER`)
- [x] `.env.example` lists every variable the backend reads
- [x] Boot logs one line per optional integration: enabled, or disabled and which variable enables it
- [ ] Test the `HANDOFF.md` §9 recipe end to end on a staging box before using it on production

Note for the EC2: the running containers were created before this change. `docker compose up -d
--build` re-creates them from `.env`; check the new startup lines say what you expect.

### P0.4 No backups

Postgres lives in a Docker volume on one EC2 instance. There is no `pg_dump` cron, no WAL
archiving, no PITR, no off-box copy, nothing in `deploy/`.

This is the transaction ledger, the commission entries, and the payout history for every agency on
the platform. One disk failure, one bad migration, one `docker compose down -v` typed while tired,
and it is gone with no recovery path.

- [x] `deploy/backup-postgres.sh` — nightly `pg_dump` (custom format), 30 local copies, S3 upload
      when `BACKUP_S3_BUCKET` is set
- [ ] On the EC2: create the bucket with lifecycle rules (30 daily, 12 monthly), give the instance
      role `s3:PutObject`, add the cron line from the script header
- [ ] Enable WAL archiving for point-in-time recovery
- [x] `deploy/restore-postgres.sh` — restores into the live database or a side-by-side one;
      restore-tested locally 2026-08-25 (29 tables, data intact)
- [ ] Restore-test on the EC2 once the cron has produced its first dump
- [x] Restore procedure written into `HANDOFF.md`
- [ ] Set a calendar reminder to restore-test quarterly

Do this before the first real payment lands, not after.

### P0.5 Webhook retries silently drop payments

`webhooks.routes.js:42-49` inserts the event row in one transaction, then processes it in another:

```js
if (!eventRowId) return res.status(200).json({ ok: true, duplicate: true });
```

If `recordPaymentOutcome` throws — a DB blip, a constraint violation, a bug — the event row is
already committed with `processed = false`. MantaPay retries. The `ON CONFLICT DO NOTHING` returns
no id, so the handler answers `200 {duplicate: true}` and never processes it. The provider stops
retrying. The payment exists at MantaPay and does not exist in your ledger.

Nothing alerts. It surfaces weeks later as an unexplained settlement variance.

- [x] Duplicates are acknowledged only when the earlier delivery was fully processed; otherwise the
      retry runs the outcome again. Rejected events (bad signature, merchant mismatch) are marked
      processed so they do not sit in the backlog
- [x] `/health` counts authentic webhooks unprocessed for over an hour and returns 503 when any
      exist (alerting on that is P1.8)
- [x] Integration test: first attempt throws, replay processes the payment

### P0.6 No TLS in the committed nginx config

`deploy/nginx-higherpays.conf` has `listen 80` and an ACME challenge location. There is no
`listen 443 ssl`, no HTTP→HTTPS redirect, and no HSTS.

Certbot's nginx plugin usually rewrites the file in place on the server, so the live box may well
have TLS that this file does not reflect. Verify which is true — the answer decides whether this is
a documentation gap or an active incident. Access tokens, refresh tokens and customer PII cross
this proxy.

- [x] `curl -I http://higherpays.com` → 301 to HTTPS; HTTPS serves. Documentation gap, not an
      incident. No HSTS header was sent.
- [x] Committed config now has the 443 block, HSTS, and the 80→443 redirect (ACME path excepted)
- [ ] On the EC2: diff the committed file against `/etc/nginx/sites-available/higherpays`, install
      it, `nginx -t && systemctl reload nginx`, confirm `curl -I https://higherpays.com` shows
      `strict-transport-security`

### P0.7 No CI

There is no `.github/`. Nothing runs lint, tests, or the build before code reaches production.
Deploy is `git pull && docker compose up -d --build` typed by hand on the box.

This is the direct cause of P0.1: a branch that does not compile sat in the working tree with
nothing to say so.

- [x] `.github/workflows/ci.yml`: frontend lint + tsc + vitest + build; backend unit tests, then
      the integration suite against the real Postgres image and init script (RLS with `hp_app`)
- [x] `docker compose build` job
- [ ] Protect `main` in GitHub settings — require the three checks before merge
- [x] `backend npm test` is unit-only again (integration is `npm run test:integration`), as
      `CLAUDE.md` documents

This is roughly forty lines of YAML and it is the highest leverage item in this document.

### P0.8 Any admin can promote themselves to owner

`roles.routes.js:41` lets anyone with `team.manage` rewrite a role's permission list:

```js
const perms = cleanPerms(req.body && req.body.permissions);
if (req.params.name === 'owner') return res.status(403).json({ error: 'owner_is_immutable' });
UPDATE roles SET permissions=$3 WHERE workspace_id=$1 AND name=$2
```

`team.manage` is held by `owner` and `admin`. `cleanPerms` accepts any string in the `PERMISSIONS`
catalog — including `settings.danger`, the single permission that separates admin from owner
(`auth/permissions.js:27`). The guard only protects the literal role name `'owner'`.

So an admin sends one request:

```
PATCH /workspaces/:id/roles/admin   { "permissions": [...all 22...] }
```

`requireWorkspace` reads permissions from the `roles` table on every request
(`middleware/index.js:34-36`), so it takes effect immediately. The admin now has `settings.danger`
and the owner/admin distinction no longer exists.

Two related holes in the same handler:

- `is_system` is checked on DELETE but not on PATCH, so the seeded system roles can be rewritten
  arbitrarily. A workspace's `analyst` role can be given `commissions.manage`.
- Nothing stops a user editing the permissions of the role they currently hold. Self-escalation is
  the default case, not an edge case.

- [x] Create and edit refuse any permission the caller does not hold (`cannot_grant_unheld_permission`)
- [x] System roles are immutable (`system_role_immutable`); custom roles carry custom sets
- [x] Callers cannot edit their own role (`cannot_edit_own_role`)
- [x] `requirePermission('settings.danger')` passes only for the owner role or a platform operator
- [x] `test/integration/roles.test.js`: admin self-escalation → 403, plus the three guards above

This is the only finding in this document that is a live authorization bypass rather than a
weakness. Fix it before the next deploy.

---

## P1 — Blocks real money at scale

### P1.1 Concurrent payout runs double-count

`payouts.routes.js:200-223` reads unpaid commission entries, inserts a `payouts` row per recipient
marked `status='paid'`, then updates the entries. There is no lock and no idempotency key.

Two concurrent calls — a double-clicked button, a retried request — both read the same unpaid rows
and both insert a payout row. The second `UPDATE` is guarded by `payCol IS NULL` so it touches zero
entries, but its `payouts` row is already committed at the full amount. You now have two paid
payout records for one set of commissions.

- [x] Runs for one workspace + payee type are serialised with `pg_advisory_xact_lock`; the second
      run sees nothing unpaid and records nothing
- [x] Payout insert and entry update happen in one transaction; a settle that touches zero rows
      throws and rolls the payout back
- [ ] Client-supplied idempotency key — not needed for a double click now that a retry is a no-op;
      add it when a payout rail makes the call non-idempotent
- [x] `test/integration/payouts.test.js` fires two runs at once and asserts one payout row

### P1.2 Payouts are marked paid without money moving

The same handler writes `status='paid'` at insert time. No money has moved — there is no payout
rail wired. The ledger records intent as completed fact.

- [ ] Model the real lifecycle: `pending` → `processing` → `paid` / `failed` — when a rail exists
- [ ] Only `paid` when something external confirms it
- [x] Payout runs now write `status = 'recorded'` (enum value added in migration 028)

### P1.3 A late decline can un-approve a paid sale

`payments.service.js:69`:

```sql
ON CONFLICT (workspace_id, provider_transaction_id)
  DO UPDATE SET status = EXCLUDED.status, fee = EXCLUDED.fee, net = EXCLUDED.net
```

A declined event arriving after an approved one for the same provider transaction id flips the
transaction to declined and marks the link failed — while the commission entries stay posted. The
ledger and the transaction now disagree.

- [x] The DO UPDATE carries `WHERE transactions.status <> 'approved'`; a late decline leaves the
      transaction, the link and the ledger untouched
- [x] `test/integration/money.test.js`: approved then declined, the sale survives

### P1.4 `shortfallIfPaidNow` does not mean what it says

`payouts.routes.js:178-183`:

```js
cash: {
  owed: round2(creatorsOwed + chattersOwed),
  heldInReserve: reserve.held,
  // negative => the agency must front cash to cover payouts this period
  shortfallIfPaidNow: round2(reserve.held),
}
```

The comment describes a signed shortfall. The value is just the reserve, always positive. It never
compares what is owed against what is available. An agency owner reading this number to decide
whether they can pay their creators is reading a number that does not answer that question.

- [x] `services/cash.js`: `available = received − held`, `shortfallIfPaidNow = max(0, owed − available)`,
      where `received` is the period's distributable total (gross minus every fee)
- [x] Unit-tested in `backend/test/cash.test.js` (the value is computed server-side, so the test
      lives there); the Payouts page shows the shortfall as a warning
- [ ] Audit the other money-facing derived fields for the same class of mistake

### P1.5 No rate limiting on authentication

Login, refresh, and both 2FA endpoints are unbounded. Password brute-force is free. `TooManyRequestsError`
exists in `lib/errors.js:46` and is never thrown anywhere. The only rate limit in the product is one
payment link per chatter per 30 seconds.

- [x] `lib/rateLimit.js`: 100 requests per IP per 15 minutes on login, refresh and 2FA; an account
      locks for 15 minutes after 10 failed sign-ins (only failures count, so a correct password is
      never blocked by someone else's guesses). In-memory — move the store before running two replicas
- [ ] Progressive lockout (longer each time)
- [x] Rate limit `/auth/refresh` and `/auth/2fa/*`
- [ ] Alert on burst failures against one account — lockouts are audited as `auth.login.locked`;
      alerting is P1.8

### P1.6 Refresh token handling

Three related weaknesses:

- 30-day refresh tokens sit in `localStorage` (`store/auth.ts:61`). Any XSS is a month of stolen
  session.
- No reuse detection. Rotation works (`auth.routes.js:162`) but replaying a revoked token just
  returns 401. A replayed token means a token was stolen — it should revoke the entire family and
  notify.
- No cap on concurrent sessions and no way for a user to see or revoke their own.

- [ ] Move refresh tokens to an `httpOnly; Secure; SameSite=Strict` cookie — needs a CSRF story
      for the same-origin console; CORS is now an allowlist, so this can proceed
- [x] Migration 029: `refresh_tokens.family_id`; rotation stays in the family, a replayed token
      revokes the whole family (`refresh_token_reused`, audited as `auth.refresh.reuse`)
- [x] `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/sessions/revoke-others`;
      Settings → Security lists sessions with End / Sign out everywhere else
- [x] CORS fixed first (P2.1)

### P1.7 No pagination

Only `/customers` accepts `limit` and `offset`. Everything else has a hardcoded cap:

| Endpoint | Cap |
|---|---|
| `GET /transactions` | `LIMIT 500` |
| `GET /links` | `LIMIT 200` |
| `GET /settlements` | `LIMIT 200` |

This is a functional gap, not a performance one. An agency doing 500 payments cannot see payment
501. There is no page two. The data is in the database and unreachable through the product.

- [x] Keyset pagination on `(timestamp, id)` for `/transactions`, `/links` and `/settlements`
      (`lib/cursor.js`; limit 50, max 200; a malformed cursor is ignored)
- [x] Envelope `{ items, nextCursor }`
- [x] Payments and Links load pages on demand ("Load more"); client-side filters apply to what is
      loaded — server-side filters are a roadmap item
- [ ] `/customers` still uses limit/offset; move it to the same cursor when its filters move
      server-side

Keyset, not offset — offset pagination drifts when rows are inserted mid-scroll, which for a live
payments feed is constantly.

### P1.8 No observability

You cannot answer "what happened to this request" in production.

- No request logging at all. No morgan, no pino, no request ids, no latency, no status codes.
- 22 bare `console.*` calls, unstructured, with no workspace or user correlation.
  `middleware/index.js:94` dumps raw stacks to stdout.
- `/health` returns `{ok:true}` without touching the database. It reports healthy while Postgres is
  down.
- No metrics, no error tracking, no alerting.
- Three paths swallow failures deliberately and correctly — audit writes (`util/audit.js:17`),
  Telegram delivery (`notify.js:90`), notifications (`payments.service.js:127`). Each is the right
  call. With no alerting, none of them will ever be noticed.

- [x] `lib/log.js`: pino, one JSON line per request with `reqId` (echoed as `X-Request-Id`),
      method, path, status, duration, workspace, user, ip. Every `console.*` in the request path is
      gone; 5xx responses return the request id instead of the stack
- [x] Redaction list covers tokens, password hashes and provider payloads
- [x] `/health` checks the DB and the webhook backlog (503 on either). `/ready` is not needed while
      one nginx fronts one container
- [ ] Error tracking (Sentry or equivalent) on both backend and frontend — needs an account/DSN
- [ ] Alert on: unprocessed webhooks (`/health` already 503s), 5xx rate, auth failure bursts
      (`auth.login.locked` audit rows), settlement variance, failed audit writes (now logged at
      `error`)
- [ ] Ship container logs off the box — they die with the instance today

### P1.9 `xlsx@0.18.5` — high severity, no fix available

`npm audit` confirms prototype pollution (GHSA-4r6h-8v6p-xvw6) and ReDoS (GHSA-5pgg-2g8v-p4x9).
SheetJS left npm, so there is no patched version to upgrade to. It parses uploaded workbooks at
`settlements.routes.js:31` — synchronously, up to 15 MB, blocking the event loop for every other
request while it runs.

- [x] Migrated to `exceljs`; `xlsx` removed. `npm audit --omit=dev` now reports one moderate
      finding in `uuid` (via exceljs, a bounds check when a caller passes its own buffer, which
      exceljs does not)
- [x] `settlement/parse.worker.js` parses off the request thread, 30 s timeout
- [x] Upload capped at 4 MB and must start with the zip magic bytes; `test/settlement.test.js`
      builds a workbook with the provider's layout and checks header-name column resolution

### P1.10 The commission split has no rounding discipline and no bounds

`fn_post_sale` (current definition, `027_fee_itemisation.sql:63`) computes the three-way split:

```sql
dist   := t.gross - plat_fee;
c_amt  := (dist * split)   / 100;   -- creator
ch_amt := (dist * chatpct) / 100;   -- chatter
ag_amt := dist - c_amt - ch_amt;    -- agency takes the remainder
```

Four problems, all in the product's central calculation.

**No rounding at all.** Correction to an earlier assumption here: the `commission_entries` money
columns are bare `numeric`, not `numeric(14,2)` — verified against the live schema. `transactions`
uses `numeric(14,2)`; the ledger derived from it does not. So `(dist * split) / 100` is stored
verbatim as `33.333333333333333333`. The ledger holds fractions of a cent that no transfer can pay,
every display truncates them somewhere, and nothing records where the remainder went. The remainder
party must absorb the rounding, which means the shares must be rounded first and the third derived
from them. See `DATA-MODEL.md` §D1 for the column-level fix.

**Splits can exceed 100%.** `creators.revenue_split_pct` and `commission_rules.chatter_pct` each
have a `CHECK (0..100)`, individually. Nothing checks their sum. A creator on 70% revshare plus a
chatter on 50% yields `ag_amt = -20%` — the agency silently pays out more than it received, and the
dashboard reports it as normal.

**Distributable can go negative.** `plat_fee` is MDR plus a fixed fee plus settlement cost plus
margin. On a small transaction — the provider floor is 3.00 — the fixed component can approach or
exceed gross. Nothing guards `dist > 0`, so every downstream amount flips sign.

**Estimated and actual fees diverge.** `psp_fee_val` is set to the actual fee when known, but
`dist` is always computed from the estimate `b.total`. Once fee reconciliation works, the recorded
`psp_fee` and the `distributable` it should have produced will disagree, and nothing reconciles
them. Dormant today only because P0.3 leaves the Search API credentials unreachable.

- [x] Migration 028: `fn_post_sale` rounds the platform fee, creator and chatter cuts to cents and
      gives the agency the exact remainder
- [x] `commission_entries_sale_parts_sum` CHECK (`NOT VALID`, so pre-028 rows are left as they are)
- [x] `fn_post_sale` raises `split_exceeds_100`; the creators, commissions and memberships routes
      refuse the change up front (`services/splits.js`)
- [x] `fn_post_sale` raises `nothing_to_distribute` when fees consume the gross
- [ ] Recompute `distributable` when an actual fee replaces an estimate — the Search API
      reconciliation does not rewrite ledger entries today; decide whether it should before P0.3's
      credentials go in
- [x] `money.test.js` posts a 10.01 sale (every cut lands on a fraction of a cent) and checks the
      parts sum; `engine.test.js` checks the documented €100 figures

The database is the right place for these invariants. A CHECK constraint cannot be forgotten by a
future caller; a code comment can.

### P1.11 There is no way to remove a team member

No endpoint deletes a membership or sets its status to anything but `active`. `grep` for membership
removal returns nothing. The only role-assignment path is `invites.routes.js:85`, which upserts on
accept.

An agency that fires a chatter cannot revoke their access. That person keeps their login, their
workspace membership, their `links.create` permission, and their view of customer data
indefinitely.

Compounding it: no permission change revokes existing sessions. Access tokens live 15 minutes and
refresh tokens 30 days, and nothing in the codebase touches `refresh_tokens` outside
`auth.routes.js`. Even once removal exists, a removed member stays authenticated until their
refresh token expires.

- [x] `DELETE /workspaces/:id/memberships/:membershipId` (archives the seat) behind `team.manage`
- [x] `PATCH /memberships/:id/role`; a caller may only assign a role whose permissions they hold,
      so an admin cannot mint an owner
- [x] `auth/sessions.js` revokes the user's refresh tokens on removal and role change; workspace
      routes re-check the membership on every request, so removal is immediate
- [x] The last owner cannot be removed or demoted (`last_owner`, 409)
- [x] All three audited; the Team page has role selects and a Remove button

### P1.12 The team list leaks rows from other workspaces

`memberships.routes.js:16` queries without a `workspace_id` filter, relying on RLS alone:

```sql
SELECT m.id, u.full_name, u.email, m.status, m.shift, m.commission_pct
  FROM memberships m JOIN users u ON u.id = m.user_id
 WHERE m.role = 'chatter' ORDER BY u.full_name
```

The `memberships` policy is deliberately wider than the current workspace
(`003_membership_self_access.sql`, carried into 006):

```sql
USING (is_platform_context() OR workspace_id = current_workspace_id() OR user_id = current_user_id())
```

That `OR user_id = current_user_id()` exists so login can list a user's own memberships before a
workspace is chosen. But `withWorkspace` sets `app.user_id` too — so inside a normal request the
policy also admits the caller's own rows from every other workspace.

Effect: a caller with `team.view` who is also a chatter at another agency on the platform sees
their own membership from that agency in this agency's team list — a duplicate row carrying the
commission rate they earn elsewhere. Narrow precondition, real leak, and a wrong list either way.

The general lesson matters more than this instance: `memberships`, `roles` and `workspaces` all
have policies with self-access `OR` clauses. On those three tables, RLS is not a substitute for a
`workspace_id` filter. Every other route that touches them constrains the rows through a join key;
this one scans.

- [x] Every membership query now filters on `workspace_id`
- [x] Every query against `roles` and `workspaces` already constrains by workspace id (checked 2026-08-25)
- [x] `memberships.routes.js` says why the filter is there
- [x] `memberships.test.js`: a chatter at two agencies sees one seat in each

### P1.13 SECURITY DEFINER functions with an unpinned search_path

Ten functions run `SECURITY DEFINER` — as the table owner, which is the `postgres` superuser. Six
pin their resolution with `SET search_path = public`. Four do not:

| Migration | Function |
|---|---|
| `016_chatter_commission_and_payout_runs.sql:62` | payout run helper |
| `019_fixed_fee_and_refunds.sql:81` | fee helper |
| `026_fee_model_cascade.sql:119` | `fn_post_sale` |
| `027_fee_itemisation.sql:117` | `fn_post_sale` (current) |

The pattern degraded over time — the newest and most important function is the least protected.

`deploy/postgres-init.sh` grants `hp_app` only `USAGE` on schema `public`, so it cannot create
shadowing objects there. But `TEMPORARY` on the database is granted to `PUBLIC` by default and was
never revoked, and `pg_temp` sits ahead of `public` in the default search path. An attacker who can
execute arbitrary SQL as `hp_app` can create a `pg_temp` object that shadows a name these functions
resolve, and have it executed as superuser.

That precondition is a SQL-injection foothold, and the codebase parameterises consistently — so
this is defence in depth, not a live hole. It is also the difference between a future SQLi being
contained to one tenant's data and being full database compromise.

- [x] Migration 028 pins `search_path = public, pg_temp` on `fn_post_sale` (the four unpinned
      definitions were all earlier versions of it), `fn_post_refund` and `fn_post_chargeback`
- [x] `REVOKE TEMPORARY ON DATABASE ... FROM PUBLIC`
- [x] `REVOKE CREATE ON SCHEMA public FROM PUBLIC`
- [x] `security.test.js` fails on any `SECURITY DEFINER` function without a search_path

### P1.14 The platform-admin role enum is decorative

`platform_role` is an enum of `super_admin | support | finance` (`006_platform_admin.sql:17`).
`requirePlatformAdmin` (`middleware/index.js:72`) checks only that a row exists, attaches
`req.platformRole` — and no route ever reads it.

All four platform write endpoints are therefore open to any platform admin of any role:

| Endpoint | What it does |
|---|---|
| `PUT /organizations/:orgId/platform-fee` | Rewrites an agency's fee rates |
| `PUT /organizations/:orgId/settlement-fee` | Rewrites settlement fees |
| `PATCH /organizations/:orgId/status` | Suspends an agency |
| `POST /agencies` | Creates an agency |

A `support` account exists to look, not to reprice every agency on the platform. The distinction is
enforced correctly in one place — `requireWorkspace` checks `pa.role === 'super_admin'` before
granting synthetic full membership (`middleware/index.js:42`) — and ignored everywhere else.

- [x] `requirePlatformRole(...)` middleware; `super_admin` for onboarding and status changes
- [x] `finance` (and `super_admin`) may set fees; `support` is read-only
- [x] Every platform write audits `platformRole`

---

## P2 — Hardening

### P2.1 CORS reflects any origin with credentials

`server.js:30-37` echoes the request's `Origin` back and sets `Access-Control-Allow-Credentials: true`.
Not exploitable today — auth is a bearer token from `localStorage`, which an attacker's page cannot
read. It becomes exploitable the moment P1.6 introduces a cookie.

- [x] `CORS_ORIGINS` allowlist (defaults to the production hosts and `localhost:5173`); other
      origins get no CORS headers at all
- [x] Done before any cookie work

### P2.2 Containers run as root

Neither Dockerfile has a `USER` directive. A Node payments API and an nginx frontend both run as
uid 0. Any RCE is immediately root inside the container.

- [x] Backend image runs as `node`
- [x] Frontend image is `nginxinc/nginx-unprivileged` on port 8080 (host mapping is now `8083:8080`)
- [x] Both containers are `read_only` with `tmpfs` for `/tmp` (and nginx's cache/run dirs);
      `no-new-privileges`
- [x] `mem_limit` / `cpus` on both
- [x] Backend healthcheck hits `/health`; the frontend waits for `service_healthy`

### P2.3 Missing security headers

Neither nginx config sets CSP, `X-Frame-Options`, `X-Content-Type-Options`, or `Referrer-Policy`.
The API has no `helmet`. For an app holding tokens in `localStorage`, a missing CSP is the
difference between an XSS being contained and an XSS being total.

- [x] The API sets `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a
      deny-all CSP and `Cache-Control: no-store` on every response (five headers, no dependency)
- [x] `frontend/nginx.conf`: CSP (`script-src 'self'`; inline styles allowed for data-driven
      widths; Google Fonts), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`
- [x] gzip on

### P2.4 Migrations run automatically on every deploy, as superuser

`entrypoint.sh` runs migrations as the owner role on every container start, then boots the API.
There is no rollback path, no dry run, and no zero-downtime story — a bad migration takes production
down and stays down.

The runner also tracks only filenames (`migrate.js:21`), not checksums. "Never edit an applied
migration" is honour-system; an edited file applies silently on a fresh database and diverges from
production forever.

- [x] `schema_migrations.checksum` (migration 030); the runner refuses to continue when an
      applied file no longer matches, and back-fills checksums for files applied before 030
- [ ] Separate migrate from deploy — an explicit step you can run and verify
- [ ] Write down the rollback procedure for each risky migration
- [ ] Take a backup immediately before migrating (`deploy/backup-postgres.sh` exists; add it to
      the deploy recipe in HANDOFF §3)

### P2.5 Two more tables outside RLS

`webhook_events` and `organizations` carry tenant data and have no RLS policy.
`webhook_events.payload` holds full provider payloads with customer PII. Not exploitable today — no
tenant route reads either table — but the protection here is "nobody wrote that query yet", which
is not a control. (`invites`, `users`, `refresh_tokens` and `platform_admins` are deliberately
excluded and documented as such.)

- [x] Migration 030 adds tenant policies to both (`organizations` also lets a member read the
      organizations behind their own workspaces, which login needs); `/auth/me/workspaces` and
      `/health` moved to the right DB context
- [x] `security.test.js` fails when a table with a `workspace_id` column has no RLS policy
      (`invites` is the documented exception)

### P2.6 PII has no lifecycle

Full provider payloads are stored verbatim in `transactions.raw_payload` and
`webhook_events.payload` — customer email, name, phone. No redaction, no retention limit, no
deletion path. EU customers, EUR, GDPR.

- [x] `npm run retention` (`src/util/redact.js`, cron line in the file header): after
      `RETENTION_DAYS` (default 90) the stored payloads keep only the fields reconciliation
      uses (ids, amount, currency, reply code, merchant, date) and drop the rest
- [ ] Add the cron line on the EC2
- [ ] Build data export and erasure for DSAR requests (`DELETE /customers/:id` already
      anonymises a customer; export is missing)
- [ ] Write down what you store, why, and for how long

### P2.7 Audit log is write-only for tenants

30 well-chosen write sites, sensible action names — and it is readable only from `/platform` routes.
A workspace owner cannot see who changed a commission rate in their own workspace.

Separately, `ipOf()` (`auth.routes.js:13`) reads `X-Forwarded-For` directly and Express never sets
`trust proxy`. A client can send that header and choose the IP recorded in the audit log.

- [x] `GET /workspaces/:id/audit?limit&cursor` behind `settings.view`, with the actor resolved
      (frontend page is roadmap item 8)
- [x] `app.set('trust proxy', 1)`; audit rows and rate limits use `req.ip`
- [ ] Log which permission gate allowed each sensitive action, not just the action

### P2.8 Weak random in identifier generation

`links.routes.js:113` builds `reference_id` from `Date.now()` plus four random chars. This is the
key MantaPay echoes back for attribution — a collision misattributes a payment to the wrong creator,
customer, and chatter. `auth.routes.js:40` has the same pattern for the org slug against a UNIQUE
constraint, where a collision throws a raw 500 during signup.

- [x] `crypto.randomBytes` in both places: 64 random bits for the reference (short enough for
      the provider field), 32 for the slug
- [x] A UNIQUE constraint on `payment_links.reference_id` already exists
      (`idx_links_reference` on `(workspace_id, reference_id)`), so a collision raises rather than
      misattributing; with 64 random bits it will not happen in practice.

### P2.9 Three abstractions built and never adopted

Each of these was written specifically to stop duplication, and is imported by nobody:

| Module | Intent | Reality |
|---|---|---|
| `lib/errors.js` | `HttpError` hierarchy | 0 route files use it; 60 raw `res.status(4xx).json()` calls across 16 files |
| `lib/scope.js` | Shared `wid`/`uid` | 0 imports; 31 local redefinitions |
| `asyncHandler` | One import path | 5 files import from `util/audit`, 2 from `lib/http` |

The error middleware handles both shapes, which is exactly why the drift went unnoticed. Every new
route file is currently a coin flip.

- [x] `asyncHandler` comes from `lib/http` only (the `util/audit` re-export is gone); `wid`/`uid`
      come from `lib/scope` in every route file — converted in one pass
- [ ] `HttpError` vs `res.status().json()`: both shapes still exist. The error middleware
      normalises them, so pick one when the routes are next touched as a whole
- [ ] Add a lint rule so the dead convention cannot come back

### P2.10 Accessibility is absent

Two ARIA attributes in the entire frontend. Only `Layout` and `Login` have any labelling. `Modal.tsx`
handles Escape and overlay clicks but has no `role="dialog"`, no `aria-modal`, no focus trap, no
focus restore, and no body scroll lock — open a modal and Tab walks out of it into the page behind.
Data tables, filter bars and the notification bell have no accessible structure at all.

This blocks enterprise and public-sector sales, and in the EU it is increasingly a legal
requirement rather than a nice-to-have.

- [x] `Modal`: `role="dialog"`, `aria-modal`, Tab trapped inside, focus returned to the opener,
      body scroll locked
- [x] `htmlFor` on every labelled input; the notification bell's unread rows are buttons;
      `autoFocus` removed
- [x] `scope="col"` on `DataTable` headers
- [ ] Keyboard-only pass over the primary flows
- [x] `eslint-plugin-jsx-a11y` (recommended) is part of `npm run lint`, which CI runs — zero findings

### P2.11 Test coverage is thin where the money is

18 route files, 4 integration test files. The MantaPay signature work is well tested (34 unit
tests). The payout engine, the settlement importer, refunds, chargebacks, and the payout run — the
parts that move money — have almost none.

- [x] Integration tests: payout run (concurrency), refund (and its idempotency), chargeback after
      refund, webhook retry; settlement parsing is unit-tested with a generated workbook
- [ ] Integration tests for settlement import and reconcile (both need a MantaPay-shaped fixture)
- [x] The split sum is asserted on every posted sale by the database CHECK; `money.test.js`
      covers the awkward-rounding case
- [ ] Coverage reporting in CI, with a floor on `services/` and `business/`

### P2.12 Commission rate changes are not audited

`audit()` is called from 30 sites and covers role changes, workspace settings, invites, links and
settlements well. It is missing from `memberships.routes.js:27` — the endpoint that sets a
chatter's personal commission percentage.

That is a direct money-affecting change to a named individual's pay, and it leaves no trace. When a
chatter disputes a payout, there is no record of what their rate was or who changed it.

- [x] `membership.commission` audit entry with `{ from, to }`; payout runs audit `payout.run`
- [ ] Sweep the remaining handlers for money-affecting writes with no audit entry
- [ ] Consider a rate history table rather than an in-place update, so past payouts stay explicable

---

## P3 — Maturity

- **API versioning.** No `/v1` prefix. Adding one later is a breaking change; adding one now is free.
- **Email is a stub.** `util/email.js` is a `console.log`. Invites cannot be delivered, and the link
  hardcodes `https://app.higherpays.com` — not the production host. Password reset does not exist at
  all, so a locked-out owner has no path back in.
- **`schema.sql`** is an untracked 2,788-line `pg_dump` at the repo root, complete with its
  `\restrict` token. It is a second source of truth beside 27 migrations. Delete it, or generate it
  into `docs/` as a build artifact.
- ~~**N+1 in settlements.**~~ Done: one aggregate query for the whole page.
- **`fn_post_sale` is redefined across 6 migrations** (007→027). Correct per the never-edit rule, but
  there is no single place to read the current definition. Generate a schema reference into
  `BACKEND-FLOWS.md`.
- **`mantapay-signature.js`** carries five responsibilities in 285 lines with two `module.exports`
  blocks. The test fixtures now live in `test/mantapay.test.js`; the split is still open.
- ~~**Page sizes.**~~ Done: `Settings` and `Analytics` use `use<Page>Data` hooks and per-pane files.
- ~~**Connection pool is unconfigured.**~~ Done: `PG_POOL_MAX` (default 20), 30 s idle timeout,
  5 s connect timeout, `PG_STATEMENT_TIMEOUT_MS` (default 30 s).
- **Root clutter.** Four untracked markdown files and `merchant-console-mock.html` at the top level.
  Move docs into `docs/`.
- ~~**String-built SQL in the payout path.**~~ Done: `payouts.routes.js` carries one fixed
  statement set per payee type (`PAYOUT_SQL`), nothing interpolated.

---

## Suggested order

Do not do these in parallel. Each one makes the next easier to verify.

| Week | Work |
|---|---|
| 0 | **P0.8 first.** It is a live authorization bypass and the fix is small |
| 1 | P0.1 build green → P0.7 CI. Nothing else is verifiable until CI can tell you the truth |
| 2 | P0.2 secrets, P0.3 env plumbing, P0.6 TLS. Then re-run the `HANDOFF.md` §9 recipe end to end |
| 3 | P0.4 backups + a real restore test. P0.5 webhook retry fix |
| 4 | P1.8 logging and alerting. You need this before the first real payment, to see it arrive |
| 5-6 | P1.1–P1.4 and P1.10 money-path correctness, with tests |
| 7 | P1.11–P1.14 authorization: offboarding, scoping, search_path, platform roles |
| 8-9 | P1.5–P1.7 auth hardening and pagination |
| Ongoing | P2 during feature work; P3 as it gets in the way |

If you only get three things done: **P0.8** (anyone can escalate), **P0.4** (no backups), and
**P0.7** (nothing checks anything). The first is a breach, the second is extinction, the third is
why the other two went unnoticed.

---

## Verification

Current results, so you can tell whether a change helped:

```bash
cd backend  && npm test                    # 41 pass (unit; engine suite skips without TEST_DATABASE_URL)
cd backend  && npm run test:integration    # 39 pass — needs the local Postgres, see HANDOFF §10
cd backend  && npm run test:db             # 12 pass — TEST_DATABASE_URL as the postgres owner
cd backend  && npm audit --omit=dev        # 1 moderate (uuid via exceljs), not reachable
cd frontend && npx vitest run              # 27 pass
cd frontend && npm run lint                # 0 errors
cd frontend && npx tsc -b                  # 0 errors
```

Results as of 2026-08-25. Not verified: the live nginx config on the EC2 (HTTP→HTTPS redirect
confirmed from outside; HSTS absent).

---

## What is already good

Protect these during the cleanup. They are the reason this project is worth hardening rather than
rewriting.

- **RLS as the tenant boundary, with a boot-time assertion** that the runtime DB role cannot bypass
  it (`server.js:94`). Most multi-tenant products enforce tenancy in a `WHERE` clause and hope.
  This one does not.
- **Four documented DB context helpers** — `withWorkspace`, `withUser`, `withPlatformAdmin`,
  `withSystem` — each with a written reason for existing and a note on when not to use it.
- **The MantaPay comments record why.** The .NET urlencode quirk, the hybrid hash input, reply codes
  as strings not integers, the deliberate refusal to normalise their typo — each with a regression
  vector asserted in a test. That is the difference between a working integration and a haunted one.
- **`recordPaymentOutcome`** centralising webhook and reconciler outcomes, with a `SAVEPOINT` around
  notification so a Telegram outage cannot roll back a payment. The comment explains the exact
  failure it prevents.
- **Money is exact.** `NUMERIC(14,2)` throughout, no floats, commission math in `SECURITY DEFINER`
  pl/pgSQL so the ledger cannot be written around.
- **Auth primitives are right.** scrypt with sane parameters, `timingSafeEqual`, refresh tokens
  stored as SHA-256, TOTP checked before any token is issued.
- **The permission catalog does not drift.** `frontend/src/rbac/permissions.ts` and
  `backend/src/auth/permissions.js` list the same 22 permissions with the same role mappings, and
  the frontend file says out loud that it is cosmetic and the server decides. Verified identical.
- **`hp_app` is genuinely restricted.** `deploy/postgres-init.sh` creates it `NOSUPERUSER
  NOBYPASSRLS` with `USAGE` — not `CREATE` — on `public`, and uses `ALTER DEFAULT PRIVILEGES` so
  later migrations stay covered without a manual grant step. This is what makes P1.13 a
  defence-in-depth gap rather than an open door.
- **Temporal fee lookups are correct.** `effective_from <= t.occurred_at ORDER BY effective_from
  DESC LIMIT 1` prices each sale with the rate that applied when it happened, not today's rate.
  Easy to get wrong, expensive when wrong, right here.
- **`CLAUDE.md` and `HANDOFF.md`** are unusually honest about what is wired and what is not. Keep
  them that way — the value is in the honesty, not the existence.
