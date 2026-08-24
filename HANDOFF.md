# HigherPays — Handoff

You (or your Cursor agent) are picking up a project already in progress.
Read this doc first. It captures the full mental model of the app, what
runs where, what changed most recently, and exactly what to do next.

If you only have five minutes, read sections **1**, **2**, and **9**.

*Last updated: 2026-08-20. Latest commit at time of writing:
`108983d chore: ignore local skill installs`.*

---

## 1. What is this product?

**HigherPays** is a payments + operations platform for **creator agencies**
(agencies that manage content creators, e.g. OnlyFans creators, and the
"chatters" who message their fans on their behalf).

The agency uses the app to:

1. Create **payment links** for their creators' fans (customers).
2. Take payments through **MantaPay** (the payment provider — see §7).
3. Automatically split each payment across three parties:
   - the **creator** whose fan paid (rev-share % or fixed salary)
   - the **chatter** who closed the sale (commission %)
   - the **agency** itself (whatever's left after platform + provider fees)
4. Run **payouts** to creators and chatters on a schedule.
5. See **analytics, goals, and leaderboards** for the team.

The app is **multi-tenant SaaS**: multiple agencies use the same instance,
isolated from each other by **Postgres Row-Level Security (RLS)**. A
"workspace" == one agency.

There's also a **platform (super-admin) level** for the HigherPays
operator (Eran) sitting above every workspace.

The design voice is a modern **general ledger**: paper background, ink
type, mono for every money value. Directional colour (forest green for
money in, oxidised red for money out) is the one bold move — everything
else stays quiet. See `frontend/src/theme/variables.css` for the tokens.

---

## 2. Stack, at a glance

| Layer      | Tech                                                                    |
|------------|-------------------------------------------------------------------------|
| Frontend   | React 19 + TypeScript + Vite + Zustand + React Query + React Router v7  |
| Backend    | Node 22 + Express 4 + `pg` (raw SQL, no ORM)                            |
| Database   | Postgres 16 with Row-Level Security                                     |
| Auth       | JWT (access + refresh), TOTP-based 2FA optional                         |
| Provider   | MantaPay (hosted checkout; see `backend/src/providers/mantapay-*.js`)   |
| Deploy     | Slim Docker containers, `docker compose up -d --build`                  |

**Repo layout** (monorepo):

```
higherpays/
├── frontend/         Vite + React app
├── backend/          Node/Express API + Postgres migrations
├── deploy/           Ops scripts (postgres init, nginx server block, sanity checks)
├── docker-compose.yml
└── .env.example
```

**Where it runs**:

- **Production**: EC2 at `54.173.144.0`, path `/home/ubuntu/higherpays`.
  Public URL: **`https://higherpays.com`** (both apex and `www`).
  Fronted by the EC2's system nginx which reverse-proxies to the
  frontend container on `127.0.0.1:8083`. TLS via Let's Encrypt (valid
  until 2026-11-17, auto-renewed by certbot's systemd timer).
- **Local dev**: same `docker compose up -d --build` should work.

---

## 3. Where everything runs (EC2)

SSH: `ssh -i <key.pem> ubuntu@54.173.144.0`.

Three containers, all built from this repo:

| Container         | Image (base)          | Purpose                                                                                       | Exposed port |
|-------------------|-----------------------|-----------------------------------------------------------------------------------------------|--------------|
| `higherpays-pg`   | `postgres:16-alpine`  | Data. On first boot creates a restricted `hp_app` role via `deploy/postgres-init.sh`.         | Not exposed  |
| `higherpays-api`  | `node:22-alpine`      | Express API on `:3000`. Runs migrations as the DB owner, then serves as `hp_app`.             | Not exposed  |
| `higherpays`      | `nginx:alpine`        | Serves the built React app + proxies `/api/*` → backend container.                            | `8083`       |

In front of those, the **EC2's system nginx** (not a container) fronts
every project on the box. Its config for HigherPays lives at:

- `/etc/nginx/sites-available/higherpays` on the EC2
- Committed copy at `deploy/nginx-higherpays.conf` in this repo (source of truth)

If the EC2 is ever rebuilt: drop that file into `sites-available`,
`ln -sf ... sites-enabled/`, `nginx -t && systemctl reload nginx`,
`certbot --nginx -d higherpays.com -d www.higherpays.com`.

All wired in `docker-compose.yml`. Secrets come from `.env` next to the
compose file (never committed — see `.env.example` for the shape).

**Common ops commands** (run from `~/higherpays` on the box):

```bash
docker compose ps                # what's up
docker compose logs -f backend   # tail API
docker compose logs -f frontend  # tail container nginx
docker compose restart backend   # restart API after `git pull`
docker compose up -d --build     # rebuild + restart everything
docker compose down              # stop all (data survives)
```

**Deploy a change** (this is the one that got missed for three days recently — do it):

```bash
# locally
git push origin main
# on EC2
cd ~/higherpays && git pull && docker compose up -d --build
```

Then hard-refresh the browser (Ctrl+Shift+R) so it doesn't serve stale
JS/CSS from cache.

**Login credentials seeded on first boot** (change these):

- URL: `https://higherpays.com/`
- Email: `owner@example.com`
- Password: `change-me-please`

---

## 4. How Row-Level Security actually works here

This is the single most important thing to understand or you'll write
insecure code. The DB has two roles:

- **`postgres`** — owner, used only by the **migrations** step. Superuser,
  so it can do DDL and (accidentally) bypass RLS. **The app never uses
  this role at request time.**
- **`hp_app`** — the runtime role. `NOSUPERUSER NOBYPASSRLS`. Subject to
  every RLS policy.

Every request must set two per-connection GUCs before touching data:

```sql
SET LOCAL app.workspace_id = '<workspace uuid>';
SET LOCAL app.user_id      = '<user uuid>';
```

`backend/src/db.js` and `backend/src/middleware/index.js` handle this
automatically per-request. **Never** run a raw pool query without going
through the middleware-provided client (`withWorkspace`, `withSystem`).

Boot check: `backend/src/server.js` refuses to start in production if the
runtime role can bypass RLS.

For the full picture including tenant-isolation tests, see
`BACKEND-FLOWS.md` and `backend/test/integration/tenant-isolation.test.js`.

---

## 5. Frontend architecture

`frontend/src/`:

```
api/
  endpoints/         Typed API modules (one per backend domain)
  http.ts            fetch wrapper — injects JWT, active workspace id, refresh-on-401
  types.ts           shared response types (AuthUser, AuthWorkspace, etc.)
  workspacePath.ts   builds /workspaces/:id/... URLs from the session
business/            Pure client-side money math (feeBreakdown) + timezone arithmetic
components/
  AppProviders.tsx   ErrorBoundary + QueryClientProvider
  AuthGuard.tsx      redirects to /login when not authenticated
  Layout.tsx         sidebar (grouped Money in / Money out / People / Insight / Admin), workspace picker
  NotificationBell   in-app feed from /notifications
  ui/                shared kit (PageHeader, StatCard, DataTable, Money, Pill, DateCell, EmptyState, LoadingCard, ErrorCard, …)
hooks/
  useCurrentSession  who am I + which workspace
  useTimezone        resolves user's IANA TZ from preferences
  useRateCard        the workspace rate card from /platform-fee
  usePermission      useCan() — effective permissions from /permissions (built-in matrix as fallback while loading)
lib/format/          money/date/text formatters
lib/toast.ts         toast() — fire-and-forget status messages
pages/               One folder per route: index.tsx (view) + use<Page>Data.ts (React Query) + filters.ts
rbac/                Permission vocabulary + built-in role matrix (mirrors backend/src/auth/permissions.js)
store/
  auth.ts            JWT + AuthUser + workspaces (persisted)
  session.ts         activeWorkspaceId (persisted)
  preferences.ts     tzMode + tzManual (persisted)
theme/               global.css + variables.css (ledger design system)
```

### One mode: live

There is no demo mode and no generated data. Every page reads from the
backend through React Query. The pattern: `pages/X/index.tsx` is a view;
`pages/X/useXData.ts` owns the queries and mutations (query keys include
the active workspace id; mutations invalidate). Pages use the API types
from `api/endpoints/*` directly — there is no second, UI-side type system.

**Reference implementations**: `Payments`, `Links`, `Payouts`,
`Creators`, `Customers`, `Team`. Copy those. Do NOT invent a new pattern.

Loading, error and empty states come from the UI kit (`DataTable`
handles them for tables; `LoadingCard` / `ErrorCard` / `EmptyState` for
card layouts). Styling is plain CSS classes from `theme/global.css`;
pages carry no colours or inline layout of their own.

### Design system

- **Palette**: `--paper` off-white, `--ink` near-black, `--pos` forest
  (money in), `--neg` oxidised red (money out), `--accent` ochre.
- **Type**: `Instrument Serif` for display, `Inter` for UI, `JetBrains
  Mono` for every money value / id / date.
- **Money component**: always route amounts through
  `<Money amount={n} direction="in" | "out" emphasis />`. Never
  hand-format currency in a page.

---

## 6. What each page is wired to

Every page is live. Per page:

- **Login**: login, 2FA challenge, refresh, logout.
- **Payments**: `GET /transactions`; record-only refund (`POST /transactions/:id/refund`).
- **Payment links**: list, create (creator + optional customer + amount), reconcile.
- **Payouts**: breakdown for the period; pay one payee or all of a type (`POST /payouts/run` with `targetId`).
- **Creators**: list, create (+ assign chatters), suspend/activate, edit rev-share splits.
- **Customers**: list with segment/creator/search filters, add customer, CSV export.
- **Team**: chatter list, per-chatter commission %, invite member (role from `/roles`), pending invites.
- **Analytics**: `GET /analytics` for the range (+ the previous period for deltas), scoped by creator or chatter for agency roles; CSV export.
- **Settings**: workspace rename, fees (read-only from `/platform-fee`), link limits, 2FA setup/enable/disable, time zone (local preference), role permission matrix + custom roles, notification preferences, Telegram channels.
- **Notification bell**: `GET /notifications`, mark read.

Removed from the frontend (per `V1-ROADMAP.md`): Goals, Compare (folded
into Analytics), Workspaces, Platform. The backend `platform.routes.js`
still exists and is a later removal.

---

## 7. Payment provider — MantaPay

**Important context**: this project started life integrating **QRMoney**.
It has since been fully migrated to **MantaPay**. QRMoney is dead — do
not touch it, do not reintroduce it. As of wave-4 all in-code QRMoney
references are gone; `rg -i qrmoney` returns nothing but comments in
already-applied migration files (which we leave alone).

### Live MantaPay code lives here

```
backend/src/providers/mantapay.js           — high-level facade
backend/src/providers/mantapay-auth.js      — Search API login
backend/src/providers/mantapay-checkout.js  — hosted checkout link creation
backend/src/providers/mantapay-search.js    — per-transaction fee reconciliation
backend/src/providers/mantapay-signature.js — request/notify signature verification
backend/src/providers/mantapay-status.js    — status polling
```

Payment outcome logic (idempotent insert of a transaction, link status
update, notification fan-out) is centralised in
`backend/src/services/payments.service.js` — called by both the webhook
and the `/reconcile` endpoint.

Integration tests live at `backend/test/integration/webhook.test.js`,
including good signature, bad signature, unknown endpoint, and duplicate
event handling.

### How the flow works (once wired — see §9)

1. Chatter clicks **New link** in the UI. Frontend POSTs to
   `POST /workspaces/:id/links` with amount, creator, chatter, customer.
2. Backend inserts a `payment_links` row, then calls
   `provider.createCheckout` which builds a **signed MantaPay hosted
   URL** with amount, currency, reference, `ExpiredOn`, and a
   per-workspace `notification_url`. That URL is returned to the UI.
3. Chatter shares the URL with the fan; fan pays on MantaPay's hosted
   page. Card data never touches our server.
4. MantaPay POSTs `application/x-www-form-urlencoded` to
   `https://higherpays.com/api/webhooks/payment/<workspace-webhook-endpoint-id>`.
5. Webhook route (`backend/src/routes/webhooks.routes.js`):
   - resolves tenant by endpoint id (using `withSystem` because the
     `workspaces` table is FORCE-RLS)
   - verifies signature with the workspace's per-merchant hash key
   - checks the `merchantID` in the payload matches the workspace's
     stored `mid`
   - records the event idempotently (unique on `provider_event_id`)
   - for `approved` / `declined`, calls
     `paymentsService.recordPaymentOutcome` which posts the transaction,
     updates the link status, and fans out notifications
6. UI's Payments page picks up the new row on next refetch.

### Refunds

`MANTAPAY_REFUND_ENABLED=false` today. The two-step admin-approved
refund flow isn't implemented; the app **records** refunds issued in
MantaPay's dashboard rather than calling their API. See the refund path
in `backend/src/routes/payouts.routes.js`.

---

## 8. Backend surface (what's callable)

Base URL from the browser: `/api/*` (proxied to backend by the frontend container's nginx).
Base URL from other services on the box: `http://backend:3000/*`.
Base URL from outside the box: `https://higherpays.com/api/*`.

Health: `GET /health` → `{ ok: true, env }`.

Routers registered in `backend/src/server.js` under `/workspaces/:workspaceId/...`:

- `/creators`, `/customers`, `/links`, `/commissions`
- `/{payouts,transactions,fees,me,settlements}` (all under workspaces)
- `/roles`, `/analytics`, `/targets`, `/memberships`, `/notifications`
- `/invites` (both workspace-scoped and public)
- `/permissions` (effective permissions for the current user)

Also:

- `/auth/*` — login/refresh/logout/register/register-2fa/verify-2fa
- `/platform/*` — super-admin only
- `/webhooks/*` — payment provider notifies (raw body)

The typed frontend clients live under `frontend/src/api/endpoints/`. Add
a new one when you touch a new domain rather than raw-`fetch`ing.

For the full plain-English backend flow diagrams (Mermaid), read
`BACKEND-FLOWS.md`.

---

## 9. What to do next — prioritised

### P0. Wire real MantaPay credentials so end-to-end payments work

This is the pareto of the product. Everything below it depends on it.

The workspace on the EC2 today has `mid = 'MID-SET-ME'` and
`provider_config_ref` is null. Its stable webhook endpoint id is:

```
673e969fe9df4b2680585e807457fc76
```

So the public webhook URL to give MantaPay is:

```
https://higherpays.com/api/webhooks/payment/673e969fe9df4b2680585e807457fc76
```

**What you (Eran) need to get from the customer's MantaPay portal:**

| Value                       | Where in portal                                       |
|-----------------------------|-------------------------------------------------------|
| Merchant ID (numeric-ish)   | Merchant profile / account page                       |
| Hash key (long random)      | Merchant profile → API keys / notification signature  |
| Notification URL (paste in) | Merchant profile → paste the webhook URL above        |

**Once you have the credentials, run this on the EC2:**

```bash
# 1. Add to .env alongside docker-compose.yml
cd ~/higherpays
cat >> .env <<'EOF'

# MantaPay live credentials (issued 2026-08-XX)
MANTAPAY_MERCHANT_ID=<paste merchant id here>
MANTAPAY_HASH_KEY=<paste hash key here>
WEBHOOK_PUBLIC_BASE=https://higherpays.com/api
EOF

# 2. Update the workspace's stored MID so it matches what MantaPay signs with
docker exec -it higherpays-pg psql -U postgres -d higherpays -c \
  "UPDATE workspaces SET mid = '<paste merchant id here>' WHERE mid = 'MID-SET-ME';"

# 3. Recreate the backend container so it picks up the new env
docker compose up -d --build backend
docker compose logs -f backend | head -50   # confirm it booted
```

**Then smoke-test end-to-end:**

1. Open `https://higherpays.com`, sign in, go to **Payment links** → **New link**.
2. Create a €1 link for any creator/chatter/customer. Copy the URL.
3. Open the URL in a private window — you should land on MantaPay's hosted checkout with the €1 baked in.
4. Complete the payment (real card, €1).
5. Back in the app, click **Payments** — the transaction should appear within seconds.
6. Verify the webhook row landed:
   ```bash
   docker exec higherpays-pg psql -U postgres -d higherpays -c \
     "SELECT event_type, signature_valid, processed, created_at FROM webhook_events ORDER BY created_at DESC LIMIT 3;"
   ```
   Both `signature_valid = t` and `processed = t` for the fresh row.

If the webhook doesn't arrive: check `docker compose logs -f backend`
for `bad_signature` / `merchant_mismatch` / `unknown_endpoint` errors.
Nine out of ten times it's a mismatch between the workspace's stored
`mid` and the MantaPay portal's actual merchant id.

### P1. V1 feature gaps

Every page is wired (see §6). What remains is the spec work listed in
`V1-ROADMAP.md`: 4-role model, cancel-link status, server-side payment
filters, period-over-period comparison inside Analytics, workspace audit
log page, link-expired notifications, activate/deactivate users, CSV
export for payments and links, and removal of `platform.routes.js`.

### P2. Real MantaPay features beyond happy-path

1. **Refund flow** (currently records-only). Two-step admin request per
   MantaPay's flow.
2. **Search API credentials rotation** (they expire every 90 days per
   provider policy).
3. **Settlement report import** — `/settlements` endpoint exists and
   the seed data has `MANTAPAY_SEARCH_SALT` placeholders; needs the
   real search-API credentials to reconcile per-transaction fees.

### P3. Certbot email

Renewals work silently today, but there's no email attached to the
Let's Encrypt account, so if renewal ever fails no one gets notified.
30 seconds to fix:

```bash
ssh ubuntu@54.173.144.0 "sudo certbot update_account --email <you@domain>"
```

---

## 10. Testing / verification workflow

**Frontend:**
```bash
cd frontend
npm run build      # tsc + Vite build; MUST pass before pushing
npm test           # Vitest — currently 44 tests across business/ and pages/
```

**Backend:**
```bash
cd backend
npm test                  # unit tests (signature, payout engine)
npm run test:integration  # runs against a live Postgres — needs docker compose up
```

**End-to-end sanity** (on EC2):
```bash
curl -sS https://higherpays.com/api/health
# expect: {"ok":true,"env":"production"}
```

Login smoke test:
```bash
curl -sS -X POST https://higherpays.com/api/auth/login \
  -H 'Content-Type: application/json' \
  --data '{"email":"owner@example.com","password":"change-me-please"}'
# expect: JSON with accessToken, refreshToken, user, workspaces
```

Multi-site sanity (verifies you haven't broken other projects on the EC2):
```bash
ssh ubuntu@54.173.144.0 "bash /home/ubuntu/higherpays/deploy/check-sites.sh"
```

---

## 11. Ground rules (do not skip)

1. **Never commit `.env`, `.pem` keys, or anything under `.ssh/`**. They're
   gitignored — keep them that way.
2. **Never edit an already-applied migration.** Write a new one.
3. **Never bypass RLS.** No raw `pool.query()` outside the request-scoped
   client from the middleware (`withWorkspace`, `withSystem`).
4. **Money math is exact NUMERIC in the DB, JS `number` in the app.** If
   you find yourself doing floating-point currency math in a new place,
   pull the logic into `frontend/src/business/` and add a unit test.
5. **Money display always goes through `<Money />`.** Never hand-format
   currency in a page — you'll get the direction colour and the mono
   font for free.
6. **Line endings**: the repo forces LF on shell scripts, Dockerfiles,
   and compose files via `.gitattributes`. Don't override this — CRLF
   breaks the Alpine containers.
7. **Commit style**: conventional-ish — `feat(scope):`,
   `refactor(scope):`, `fix(scope):`, `chore:`, `infra:`, `docs(scope):`.
   Small, reviewable, one concern each.
8. **After pushing, deploy**. This got missed for three days recently —
   pushing to GitHub does nothing on its own. Run
   `git pull && docker compose up -d --build` on the EC2 (see §3).
9. **When in doubt, follow the existing pattern.** `Payments`, `Links`,
   `Payouts`, `Creators`, `Customers`, `Team` are the reference
   implementations for a page. Copy them, don't reinvent.

---

## 12. Where to look when something breaks

| Symptom                                          | First place to look                                                                                          |
|--------------------------------------------------|--------------------------------------------------------------------------------------------------------------|
| Frontend can't reach backend                     | Browser network tab → is it hitting `/api/*`? Check container nginx logs: `docker compose logs -f frontend`. |
| `https://higherpays.com` shows a different app   | System nginx routing. Check `sudo nginx -T | grep -A5 higherpays` on the EC2 and confirm the server block from `deploy/nginx-higherpays.conf` is in place. |
| API returns `server_error`                       | `docker compose logs -f backend`. Also check the DB — is it healthy?                                         |
| Payments come in but no webhook fires            | Check `webhook_events` table for `signature_valid=false` rows. Almost always the workspace's stored `mid` or the env `MANTAPAY_HASH_KEY` is wrong. |
| `docker compose up` fails on postgres init       | Delete the volume: `docker compose down -v` (destroys data, dev only). Then bring it back up.                |
| Login returns 401                                | Password may have been rotated; check `backend/src/util/seed.js` for the current default.                    |
| RLS "policies not applied" warning at startup    | The `hp_app` role has `SUPERUSER` or `BYPASSRLS`. Check `deploy/postgres-init.sh` and reinit the DB.         |
| Vite dev server won't hot-reload                 | Delete `frontend/node_modules/.vite` and restart.                                                            |
| tsc errors after pulling                         | `cd frontend && rm -rf node_modules && npm ci`.                                                              |
| Certbot renewal fails                            | `sudo certbot renew --dry-run` to reproduce. Usually port 80 got blocked or the server block was edited by hand. |
| Nav tab visible but pages look empty in live     | The page hasn't been wired to its `use<Page>Data` hook yet. Check §6.                                        |

---

## 13. Contacts / accounts

- **GitHub**: `SirShabluli/higherpays` — main branch is the only branch;
  push directly (no PR workflow yet).
- **EC2**: `ubuntu@54.173.144.0`, key at `higherpays/.ssh/ec2-key.pem`
  (gitignored — ask Eran).
- **AWS account**: `584120132927`.
- **Domain (customer-owned)**: `higherpays.com` at Namecheap.
- **TLS**: Let's Encrypt via certbot, systemd-timer auto-renewal. Cert
  currently expires 2026-11-17.
- **MantaPay**: merchant account is the customer's. Sandbox availability
  and specific portal fields — ask the customer directly.

---

## 14. History — what changed in the last two sessions

For the exact commit trail run `git log --oneline`. In summary:

**Backend refactor (waves 0–5, commits `f177ad1`..`c9c6030`):**
- Fixed a bug where `links.routes.js` was still calling MantaPay with
  QRMoney-shaped arguments.
- Full HTTP integration test suite (`auth`, `tenant-isolation`, `links`,
  `webhook`) — 44 backend tests passing.
- Extracted `services/payments.service.js` (idempotent transaction
  posting + notification fan-out), used by both webhook and reconciler.
- Custom `HttpError` hierarchy + centralised error middleware.
- Full QRMoney purge (comments, config, seed messages).
- `BACKEND-FLOWS.md` — Mermaid diagrams for every backend flow in
  low-technical language.

**Frontend refactor (waves FE-0…FE-4, commits `2ebe6b9`..`00c085f`):**
- Fixed the real "navbar broken" bug: `useCan` was reading the demo
  store's role, and `Login` never called `disableDemo()` — so live
  sessions kept serving demo data.
- New ledger design system (paper + ink, Instrument Serif + Inter +
  JetBrains Mono, mono for money).
- Sidebar re-grouped by intent (Money in / Money out / People /
  Insight / Admin). Amber demo ribbon on top of `main` in demo mode.
- Payments / Links / Payouts adopted `direction` prop on money values;
  copy tightened per the frontend-design skill.
- Creators / Customers / Team wired to their live-data hooks. Loading
  and error rows added.
- Deleted `ProductTour` (dead code).

**Deploy (commits `97aa12e`):**
- System nginx server block for `higherpays.com` + `www.higherpays.com`
  reverse-proxying to `127.0.0.1:8083`. Committed at
  `deploy/nginx-higherpays.conf` as source of truth.
- Let's Encrypt cert via `certbot --nginx`.

If you're catching up, read those commit messages in order — they're
written to be read.
