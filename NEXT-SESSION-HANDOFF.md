# HigherPays — Next Cursor Session Handoff

**Last verified:** 2026-09-24  
**Repository root:** `higherpays/`  
**Current branch:** `marketplace-cart-integration`  
**HEAD at handoff:** `a43246b` — `Compact payment links on mobile`

Start here before making further changes. This document reflects the current
code and Git working tree, rather than relying on older handover documents.

## 1. Product purpose and boundaries

HigherPays is a multi-tenant operating and payments platform sold to creator
agencies. A customer agency is a **workspace**. It contains creators/accounts,
chatters/agents, customers, payment links, payments, and payout records.
HigherPays charges each workspace a margin on top of the payment provider's
costs.

Important boundaries:

- **MantaPay is the payment provider.** Card entry occurs only on MantaPay's
  hosted page. Do not implement card collection or a server-to-server card
  payment flow; keeping card data out of HigherPays keeps the application out
  of PCI card-data scope.
- All financial calculations and posting happen in PostgreSQL with exact
  `NUMERIC` values. Do not move money calculations to JavaScript floats.
- Refunds and chargebacks are negative ledger entries, never deletions.
- Each workspace has a single currency. Foreign exchange is deliberately out
  of scope.
- Provider credentials and integration secrets belong in environment variables,
  never in the database, source code, chat, or Git.

## 2. Current architecture

```text
Browser
  -> nginx frontend container (port 8083 locally / HTTPS in production)
  -> /api proxy
  -> Express API (Node)
  -> PostgreSQL 16 (local Docker or external RDS)
```

- `frontend/`: React 19 + TypeScript + Vite, React Query, Zustand.
- `backend/`: CommonJS Node/Express API, `pg`, PostgreSQL business logic.
- `backend/migrations/`: ordered SQL migrations; current repository ends at
  `028_marketplace_cart_sales.sql`.
- `deploy/`: production deployment, monitoring, and backup scripts.
- `docker-compose.yml`: local full stack.
- `docker-compose.rds.yml`: overlays the base compose file so the backend uses
  an external database.

Key paths:

| Concern | Path |
|---|---|
| Server and route mounting | `backend/src/server.js` |
| Configuration | `backend/src/config.js` |
| Database access / transactions | `backend/src/db.js` |
| MantaPay adapter | `backend/src/providers/` |
| Payment posting | `backend/src/services/payments.service.js` |
| Link reconciliation | `backend/src/services/links.service.js` |
| Marketplace integration | `backend/src/routes/marketplace.routes.js` |
| React routes | `frontend/src/App.tsx` |
| HTTP client | `frontend/src/api/http.ts` |
| Deployment script | `deploy/deploy.sh` |

## 3. Documentation caveat — some older docs are stale

Several root-level historical documents contain information from an earlier
implementation. Do not copy their claims forward without checking the code:

- `HANDOVER.md` describes an older single-file frontend layout, RLS helpers,
  27 migrations, and a different route count. The active project is the
  `frontend/` + `backend/` monorepo and currently has migrations `001`–`028`.
- `PRODUCTION-READINESS.md` refers to an older QRMoney provider and says RLS is
  the active tenant boundary.
- The current `backend/src/db.js` explicitly says tenant isolation is enforced
  through workspace-scoped queries and access middleware, not PostgreSQL RLS.
- `backend/README.md` has useful MantaPay and money-engine detail but contains
  the same stale RLS statement. Prefer the actual `db.js`, middleware, and
  migrations when changing authorization or database access.

`MANTAPAY.md` and `docs/marketplace-integration.md` are the most useful current
provider/integration references, but source code and tests remain authoritative.

## 4. Database and RDS situation

### Environments

- **Production:** encrypted PostgreSQL 16 RDS instance `higherpays-prod` in
  `us-east-1`. It is intended to be reachable only from the EC2 security group
  and an allowlisted administrator IP. Repository documentation says automated
  backups retain seven days and deletion protection is enabled.
- **Development database:** `higherpays_dev`; its password is stored in AWS SSM
  Parameter Store at `/higherpays/development/database-password`.
- **Local development:** Docker Postgres named `higherpays`, started by the
  normal compose file.

Do not assume the documentation proves the live AWS configuration is still
correct. Inspect AWS/RDS state before changing live infrastructure.

### Database identities and URLs

There must be distinct credentials:

| Use | Environment variable | Required privilege |
|---|---|---|
| API runtime | `DATABASE_URL` | restricted application user |
| migrations / schema work | `MIGRATIONS_DATABASE_URL` | schema owner |
| nightly dump | `BACKUP_DATABASE_URL` (or migration URL fallback) | able to read the database |

The runtime user must not be the owner or a superuser. It should be the
restricted `hp_app` role with only data DML, sequence usage, and function
execution privileges. Run migrations as the owner. Do **not** run `seed`,
database resets, or destructive development tooling against RDS production.

### Compose and deployment behavior

- Base `docker-compose.yml` runs local Postgres. It uses external URLs only
  when they are present in `.env`.
- The deployment script detects non-empty `DATABASE_URL` and
  `MIGRATIONS_DATABASE_URL`, then adds `docker-compose.rds.yml`.
- The backend container is not publicly exposed; nginx proxies `/api`.
- Production secrets stay only in the production server's `.env`. The deploy
  script intentionally does not upload, read, or overwrite that file.

### Backup and restore

- `deploy/backup-postgres.sh` dumps the external database if
  `BACKUP_DATABASE_URL` or `MIGRATIONS_DATABASE_URL` is configured.
- It keeps 30 local dumps by default and can upload dumps to the S3 bucket
  named by `BACKUP_S3_BUCKET`.
- A production S3 backup bucket must be private, encrypted, versioned, have
  Block Public Access enabled, lifecycle retention, and a narrowly scoped
  backup identity.
- `deploy/restore-postgres.sh` currently restores **into the local Docker
  Postgres container**, not directly into RDS. It is suitable for restore
  testing but must not be treated as an RDS restore runbook.
- Run and document a non-production restore test before relying on a backup.

## 5. Deployment workflow

`deploy/deploy.sh` is designed to deploy **only `main`**:

1. It refuses to run from another branch, with uncommitted changes, or when
   local `HEAD` does not exactly match `origin/main`.
2. It SSHes to the configured server, executes a fast-forward pull of `main`,
   builds the Compose services, starts them, and polls
   `http://localhost:8083/api/health`.
3. Host and SSH key live in ignored `deploy/deploy.env`; copy
   `deploy/deploy.env.example` to create it. Do not commit it.

Consequences for the current work:

- The checked-out branch is `marketplace-cart-integration`, not `main`.
- There are uncommitted changes (listed in section 8).
- None of those changes can use the scripted production deploy until they are
  reviewed, tested, committed, merged/pushed to `main`, and the branch is
  checked out cleanly.

## 6. Local development and verification

Prerequisites: Node 20+, Docker Desktop, npm.

```powershell
# From repository root
docker compose up -d postgres

# API
cd backend
npm install
npm run migrate       # use owner credentials
npm run seed          # local/demo only
npm run dev

# UI, in another terminal
cd frontend
npm install
npm run dev
```

The Vite UI runs on `http://localhost:5173` and proxies to the backend on port
3000. The Docker full stack exposes the UI at `http://localhost:8083`.

Useful checks:

```powershell
cd backend
npm test
npm run test:integration     # needs a deliberately configured non-production DB

cd ../frontend
npm run lint
npm run test
npm run build
```

Never point integration tests, seeds, migration experiments, restore tests, or
manual SQL at production RDS.

### Verification snapshot at this handoff

- `backend`: `npm test` passed — 65 tests, including the uncommitted
  workspace-event unit tests.
- `frontend`: `npm run build` passed.
- `frontend`: `npm run lint` currently fails on two existing accessibility
  rules in `src/components/Layout.tsx:207` (`click-events-have-key-events` and
  `no-noninteractive-element-interactions`). That file is not part of the
  current uncommitted SSE change. Fix the underlying interaction semantics
  before treating a fully clean frontend lint as a release gate.

## 7. Payments and MantaPay

MantaPay uses three distinct endpoints:

| Purpose | Host |
|---|---|
| Hosted checkout | `uiservices.mantapay.biz` |
| Status/APM processing | `process.mantapay.biz` |
| Search API | `webservices.mantapay.biz` |

Critical implementation facts:

- The deployed public checkout flow is in `mantapay-apm.js`; it uses
  `ExtraCostAmount` for the checkout fee.
- Keep `MANTAPAY_FEE_MODE=additive` in production. `included` is gated until
  MantaPay confirms the contract and real integration vectors pass.
- Provider reply codes are **strings**: `000` is approved; `553`, `663`, and
  `001` are pending; other codes decline (with `600` abandoned). Do not parse
  them as integers.
- Provider fees are not carried in the webhook; actual transaction fees must
  come from the Search API. The application currently posts calculated fee
  estimates and marks them accordingly.
- Link reconciliation runs automatically every 10 minutes and can be run on
  demand through the link-reconcile endpoint. It is a safety net for absent
  callbacks, not a substitute for validating webhooks.
- The provider refund flow remains record-only:
  `MANTAPAY_REFUND_ENABLED=false`; `refundPayment` intentionally returns 501.

Before a real MantaPay cutover, obtain written answers and validate them in
integration mode. The unresolved questions are recorded in
`OPEN-QUESTIONS-MANTAPAY.md`; the most important are:

1. Which outgoing request field becomes signed webhook `trans_order`?
2. Whether signed webhook `trans_amount` is content only or includes the
   checkout surcharge.
3. The exact `ExtraCostAmount` behavior and included-fee contract.
4. Actual fee schedule, Search API reliability, and the refund contract.

## 8. Current repository state — preserve this work

### Committed work on the feature branch

Recent material changes include:

- Marketplace checkout integration (`33ef2f0`):
  - authenticated marketplace order API;
  - synthetic marketplace creator/chatter attribution;
  - idempotent payment-link creation;
  - durable, HMAC-signed lifecycle-event outbox with retry;
  - migration `028_marketplace_cart_sales.sql`;
  - setup instructions in `docs/marketplace-integration.md`.
- Operational hardening:
  - production health monitoring;
  - fee-reconciliation service and safer backup behavior;
  - RDS deployment support;
  - session/2FA security, recovery codes, RBAC, impersonation controls.
- Product/UI:
  - payment and link reassignment;
  - payment lifecycle/tracking tools;
  - agency-management consolidation;
  - mobile navigation and compact mobile payment/link/agency views;
  - payment filtering across visible fields.

### Uncommitted work in progress: workspace real-time refresh

The current working tree contains an incomplete, uncommitted server-sent events
(SSE) feature. It should be treated as work in progress, not released:

| File / area | Change |
|---|---|
| `backend/src/events/workspaceEvents.js` | in-memory workspace-scoped subscriber registry and event publisher |
| `backend/src/routes/events.routes.js` | authenticated `GET /events` SSE stream with heartbeat and JWT-expiry close |
| `backend/src/middleware/workspaceUpdates.js` | publishes an update after successful mutating workspace/platform responses |
| `backend/src/services/links.service.js` | publishes after reconciliation actually changes a workspace |
| `backend/src/middleware/index.js` | exposes JWT access-token expiry on `req.user` |
| `frontend/src/hooks/useWorkspaceUpdates.ts` | stream reader, token refresh, retry, and React Query invalidation |
| `frontend/src/components/AuthGuard.tsx` | starts the workspace-update hook |
| `frontend/nginx.conf` | disables proxy buffering for the stream |
| `backend/test/workspace-events.test.js` | initial unit coverage for workspace subscriber filtering |

Before committing this feature:

1. Run backend tests and the frontend build/lint.
2. Add an end-to-end/Supertest test for the protected `/events` behavior if
   feasible; the present test checks only the in-memory publisher.
3. Review lifecycle behavior under multiple Node instances. The subscriber map
   is process-local, so it does **not** broadcast across horizontally scaled
   API containers. Use Redis/pub-sub or another shared event transport before
   claiming multi-instance realtime support.
4. Verify expired/rotated sessions, platform-admin access, workspace membership
   changes, and browser reconnect behavior.
5. Review whether publishing after every successful mutation creates excess
   refetch load; debounce or emit more specific events if it becomes noisy.

## 9. Marketplace integration

HigherPays is the only service that may hold MantaPay credentials. The
marketplace holds catalog, order, entitlement, analytics, and Telegram
delivery data but should never receive the merchant ID, hash key, webhook
credentials, or reconciliation credentials.

One-time configuration, documented fully in `docs/marketplace-integration.md`:

1. Create active synthetic `Marketplace` creator/account and chatter/agent in
   the designated HigherPays workspace and assign them to each other.
2. Set the dedicated environment variables:
   `MARKETPLACE_WORKSPACE_ID`, `MARKETPLACE_ACCOUNT_ID`,
   `MARKETPLACE_AGENT_ID`, `MARKETPLACE_WEBHOOK_URL`,
   `MARKETPLACE_WEBHOOK_SIGNING_SECRET`, and
   `MARKETPLACE_INTEGRATION_API_KEY_HASH`.
3. Store only the SHA-256 digest of the marketplace bearer token in
   HigherPays; do not store the raw token.
4. The marketplace must verify the event HMAC, timestamp, event ID, amount,
   currency, order ID, and payment-link reference before modifying entitlements.

Lifecycle: marketplace creates an idempotent order -> HigherPays creates a
single-use link -> payer opens hosted checkout -> MantaPay callback posts the
payment -> HigherPays writes a durable outbox event -> marketplace ACKs the
signed event. The marketplace should reconcile missed events through the
authenticated order-status endpoint.

## 10. Access control and operator console

- Authentication uses short-lived access tokens and refresh sessions; two-factor
  authentication is required for platform administration.
- Workspace authorization is resolved by `requireWorkspace`, role/permission
  middleware, and explicit workspace constraints in queries. Preserve that
  scoping on every new route and query.
- Platform operators are users with `is_platform_admin`; this is above a
  workspace role.
- The platform page route is `/platform` and is guarded separately from the
  normal workspace navigation.
- Locally, the Docker console is `http://localhost:8083`; platform console is
  `http://localhost:8083/platform`.

Never weaken access checks for convenience, and never allow an agency admin to
promote itself to workspace owner/platform administrator.

## 11. Near-term development priorities

Prioritize in this order unless the product owner changes direction:

1. Finish, test, and either commit or deliberately discard the SSE workspace
   updates currently in the working tree.
2. Confirm MantaPay's blocking checkout/webhook contract before live cutover.
3. Test MantaPay integration mode with a public HTTPS tunnel; provider
   callbacks cannot reach `localhost`.
4. Validate Search API credentials and response data, then implement scheduled
   actual-fee reconciliation only after validating real `TransactionFees`.
5. Read/confirm the MantaPay refund contract before implementing provider-side
   refunds.
6. Verify RDS connectivity, least-privilege database roles, backup upload, and
   a non-production restore procedure.
7. Close lower-risk UI/product gaps as needed: chatter earnings display,
   durable user preferences/tour state, additional notification-event emission,
   and real Telegram delivery testing.

## 12. Rules for future sessions

- Start with `git status --short`, branch/remote status, and this document.
- Do not commit existing uncommitted work accidentally or overwrite it with
  resets/checkout commands.
- Never expose `.env`, production URLs with credentials, access keys, database
  passwords, MantaPay keys, marketplace tokens, or Telegram tokens in source,
  tests, logs, or chat.
- Use small, additive migrations; do not edit an applied migration.
- Preserve financial auditability: do not mutate or delete posted money history.
- Add tests around provider signatures, payment state transitions,
  authorization, and money movement for every behavior change.
- Do not deploy from a feature branch. The scripted release path demands a
  clean, pushed `main` that equals `origin/main`.
