# CLAUDE.md

Guidance for Claude Code working in this repository.

These are rules, not suggestions.

## 1. Communication

Keep every response **short, direct, simple, and clear**.

* Answer only what was asked.
* Lead with the result.
* No preamble, repetition, recap, or narration of tool use.
* No slang.
* Use simple English and short sentences.
* Do not explain obvious things.
* If something failed, say what failed and why.
* If something was skipped, say what and why.
* If there is one clear answer, give it. Do not present unnecessary options.

The same standard applies to code, comments, names, and documentation.

**Simple is the default.**

---

## 2. Code

Write the **simplest correct code**.

* Prefer clear and explicit code over clever or compact code.
* Prefer standard language features over custom abstractions.
* Avoid unnecessary wrappers, generics, configuration, indirection, state, and dependencies.
* Do not optimize without a real requirement or measurement.
* Do not build for hypothetical future requirements.
* If simple code and clever code both work, choose simple code.

### Naming

Names must be:

* English
* Clear
* Descriptive
* Consistent
* Easy to pronounce

Use one name for one concept everywhere.

Functions describe their effect:

```text
signProfileUrls
getUserById
deleteMedia
```

Avoid vague or implementation-based names:

```text
processData
handleThing
mapFieldsWithPresigner
```

Booleans read as assertions:

```text
isVerified
hasImage
enabled
```

Do not use negated names such as `notDisabled`.

If a name is wrong, rename it and update all call sites.

---

## 3. Scope

Make the **smallest change that fully solves the request**.

* Do not reduce requested scope.
* Do not expand scope without a reason.
* Do not fix unrelated problems.
* Do not refactor unrelated code.
* Do not add opportunistic cleanup.

If an unrelated issue is found, leave it alone unless it blocks the requested work or verification.

Small does not mean incomplete.

---

## 4. Read Before Writing

Before changing code:

* Read the relevant files and nearby code.
* Understand the data flow, types, and call sites.
* Match existing conventions.
* Check error handling.
* Do not guess when the repository can answer the question.

If an existing convention is harmful, do not silently create a second convention. State it and fix it consistently.

---

## 5. Design

For major architectural changes, design before coding.

Keep it short:

1. **Behavior** — what should happen.
2. **Design** — target structure and responsibilities.
3. **Conflicts** — what current code disagrees with it.
4. **Changes** — keep / modify / replace / split / merge / delete / add.
5. **Risks** — what may break or cannot be verified.

Do not do this for small fixes or simple changes.

For substantial changes ask:

> Would I choose this design if I were building the system today?

Existing code is evidence of past decisions, not a reason to preserve a bad design.

---

## 6. Abstractions

Use an abstraction only when it makes the code clearer.

For non-trivial abstractions, use one verdict:

* **Keep**
* **Modify**
* **Replace**
* **Split**
* **Merge**
* **Delete**
* **Add**

Warning signs:

* One caller
* Vague name
* Parameters only switch behavior
* Only forwards values
* Hides simple logic
* Exists mainly to avoid changing a caller

Prefer direct code when direct code is clearer.

---

## 7. Legacy Code

Do not preserve code just because it exists.

When new code makes old code unnecessary, delete it.

Do not add:

* Wrappers
* Adapters
* Shims
* Parallel implementations
* `_old`, `_v2`, `_legacy`
* Commented-out code

Update call sites instead.

Data migrations are the exception when existing stored data requires them. Document when they can be removed.

---

## 8. Priority

When rules conflict:

**Correctness → Simplicity → Clear Responsibilities → Maintainability**

Correctness includes edge cases, errors, failure paths, concurrency, and data consistency.

Simplicity means fewer moving parts, not fewer characters.

Each file, module, and function should have a clear responsibility.

Do not add flexibility for requirements that do not exist.

---

## 9. Implementation

Follow the design and keep the change focused.

If the design becomes wrong:

1. Stop.
2. Explain why.
3. Update the design.
4. Continue.

Do not patch around a known-bad design.

---

## 10. Comments

Comments explain **why**, not **what**.

Comment only for:

* External system behavior
* Important constraints
* Non-obvious ordering
* Deliberate omissions
* Reasons an obvious solution was rejected
* Temporary migration conditions

If code needs a comment to explain what it does, improve the code or name instead.

Delete stale comments.

---

## 11. Verification

Verify the affected code as far as the environment allows.

Available automated checks:

```bash
cd frontend && npm run lint
cd frontend && npm run build      # tsc -b && vite build
cd frontend && npm test           # Vitest

cd backend && npm test            # node:test, unit only
cd backend && npm run test:integration   # needs a live Postgres (docker compose up)
```

Run the relevant checks.

If runtime verification is possible, run it.

Clearly distinguish:

* **Verified** — actually checked.
* **Not verified** — could not be checked.
* **Reasoned about** — reviewed but not executed.

Never claim verification that did not happen.

---

## 12. Readability

Before finishing, review the changed code as a new reader.

Check:

* Clear names
* Consistent terminology
* Logical file and function order
* Related code together
* Short, understandable functions
* No unnecessary complexity
* No debug output
* No dead code
* Clear error paths
* Useful comments

A readability pass must not change behavior.

---

## 13. Repository

HigherPays: payments/ops SaaS for creator agencies. One workspace = one agency. Read `backend/src/schema/entities.js` (the data model, with its status vocabularies) and `V1-FEATURES.md` before large changes.

Two independent Node projects, plus Postgres:

* `backend/` — Express 4 API, raw SQL via `pg` (no ORM)
* `frontend/` — React 19 + TypeScript + Vite + Zustand + React Query + React Router v7
* `deploy/` — ops scripts (postgres init, nginx server block, sanity checks), not a Node project

Each of `backend/` and `frontend/` has its own `package.json` and `Dockerfile`. No workspace root. Run npm commands inside the relevant project.

Reference page implementations (copy these patterns, don't invent new ones): `Payments`, `Links`, `Accounts`, `Agents`, `Customers`, `Team`.

### Commands

```bash
# backend
cd backend
npm install
npm run migrate    # apply SQL migrations, must run as the DB owner
npm run seed
npm start           # http://localhost:3000

# frontend
cd frontend
npm install
npm run dev         # http://localhost:5173
```

Full stack (Postgres + backend + nginx-served frontend):

```bash
docker compose up -d --build
```

Requires root `.env` (see `.env.example`).

---

## 14. Environment and Ports

One root `.env` next to `docker-compose.yml`. Never commit it.

### Local dev (outside Docker)

* Backend: `http://localhost:3000`
* Frontend: `http://localhost:5173`, Vite proxies `/api` → `localhost:3000`

### Docker

* Frontend container (nginx, serves built app + proxies `/api/*`): `8083` on the host
* Backend and Postgres are not exposed outside the Docker network

### Production

`https://higherpays.com`, fronted by the EC2's system nginx (`deploy/nginx-higherpays.conf`), which proxies to the frontend container on `127.0.0.1:8083`.

Check the environment before debugging connection issues.

---

## 15. Invariants

### The schema comes from one file

`backend/src/schema/entities.js` is the data model. `npm run schema` regenerates `backend/migrations/001_init.sql` from it. The revenue engine's SQL functions live in `002_revenue_engine.sql`, by hand. Status vocabularies are exported from the entities file (`status.LINK_STATUS` …) and mirrored in `frontend/src/api/endpoints/*` — change both.

### People

`users` is the login. `workspace_users` is access: one role per user per workspace (`workspace_admin`, `analyst`, `agent`, `account_owner`). `accounts` and `agents` are the business records; each belongs to a user and its composite foreign key proves that user holds the matching role in that workspace, so the database itself refuses an agent profile on an admin, or one person being both an owner and an agent in the same agency. Creating an agent or account always creates the login (`backend/src/services/people.js`). Platform admins are `users.is_platform_admin` and hold a `workspace_users` row in every workspace.

### Workspace queries

There is no row-level security. Every query filters on `req.access.workspaceId` (`wid(req)`) itself. `requireWorkspace` refuses a header that disagrees with the URL. Which ROWS a caller sees comes from `resolveDataScope` in `backend/src/auth/dataScope.js`: an agent sees the accounts they are assigned and their own links and payments, an account owner their own account, roles with `data.view_all` the whole workspace.

### Money

Money math is exact NUMERIC in Postgres, JS `number` in the app. The ledger (splits, payouts, chargebacks) is computed server-side; the frontend only displays it. The one client-side calculation is the fee preview in `frontend/src/business/feeBreakdown.ts` (unit-tested). New currency math belongs there with a unit test, not inline in a page or component.

Money display always goes through `<Money amount={n} direction="in" | "out" emphasis />`. Never hand-format currency in a page — it carries the direction colour and tabular numerals.

### Auth and permissions

`requireAuth` → `requireWorkspace` → `requirePermission(permission)` is the standard middleware chain for a workspace route (`backend/src/middleware/index.js`). Permissions are a matrix in code keyed by role (`backend/src/auth/permissions.js`); there are no per-workspace role definitions. `requirePlatformAdmin` gates HigherPays-operator routes.

A new workspace route without `requireAuth` + `requireWorkspace` is unprotected.

### MantaPay (payment provider)

QRMoney is dead — this project fully migrated off it. Do not reintroduce it or add a second payment-provider integration path.

Live provider code: `backend/src/providers/mantapay-*.js`. Payment outcome handling (payment + transaction upsert, link status, `fn_post_sale`, notification fan-out) is centralised in `backend/src/services/payments.service.js` — called by both the webhook route and the reconciler. Keep it that way; don't duplicate outcome logic in a route handler.

Reconciliation (`backend/src/services/links.service.js`) is the safety net for a webhook that never arrived. The API process runs it every 10 minutes for every workspace; `POST /links/reconcile` runs the same function on demand. There is no button for it.

A payment link is `single_use` (dies on the first payment or after 24h) or `reusable` (many payments, until cancelled). After a payment the agent completes it (`PATCH /payments/:id/details`: customer + category); that is what moves a single-use link from `pending` to `done`.

Refunds are record-only today (`MANTAPAY_REFUND_ENABLED=false`) — the app records refunds issued in MantaPay's dashboard, it doesn't call a refund API.

### Migrations

Never edit an already-applied migration in `backend/migrations/`. On a live database a schema change is a new numbered migration written by hand, and `entities.js` is updated to match; regenerating `001_init.sql` is only for a reset.

---

## 16. Important Gotchas

### No mock data

There is no demo mode. Every page reads the backend through React Query: `pages/X/index.tsx` is the view, `pages/X/useXData.ts` owns the queries and mutations. Pages use the API types from `api/endpoints/*` directly. Do not add generated data, placeholder values, or "coming soon" controls — see `Payments`/`Links`/`Payouts` for the shape.

### Design tokens

No Tailwind. Styling is plain CSS classes in `frontend/src/theme/global.css` with tokens from `variables.css` (dark navy console palette, teal brand, Assistant for everything, monospace for ids and codes). `merchant-console-mock.html` at the repo root is the visual reference the app follows. Pages carry no inline styles except data-driven sizes (bar widths). Use the existing tokens rather than new hex values.

Sizes come from the type scale (`--text-micro` … `--text-base`), not new px values. The uppercase micro-label (section heads, field labels, column headers) is one grouped rule in `global.css` — add your selector to it rather than restating the five properties.

### Two table patterns, and which to use

Both are correct; they do different jobs.

* **`<DataTable>`** — the table *is* the content block. Renders its own `.tableblock` frame, and owns loading, empty, footer, and keyboard-accessible rows. Use it for a page's main list: `Payments`, `Links`, `Customers`, `Agents`, `Team`.
* **`.tablewrap` + raw `<table>`** — the table is *one section inside* an existing `.card`, under a `.sechead`. Use it for `Payouts`, categories, sessions, notification channels.

Do not add a flag to `DataTable` to suppress its frame — that is the wrapper's whole job. When hand-rolling, put `scope="col"` on every `<th>`, and `<th scope="row">` on the cell that names the row (see `CategoriesPane`).

### Line endings

`.gitattributes` forces LF on shell scripts, Dockerfiles, and compose files. Don't override this — CRLF breaks the Alpine containers.

### Deploy is manual

Pushing to `main` does nothing on its own. Deploy with `./deploy/deploy.sh` (optionally naming one service), which SSHes to the EC2 box, pulls `origin/main`, rebuilds, and health-checks. It uploads nothing — the server only runs pushed commits, so it refuses to deploy a dirty or unpushed tree. Target host and key live in `deploy/deploy.env` (gitignored; copy `deploy.env.example`).

---

## 17. Known Issues

`V1-FEATURES.md` is the scope; `V1-ROADMAP.md` holds the remaining spec gaps.

---

## 18. Commits

Conventional-ish, scoped, one concern each:

```text
feat(scope):
fix(scope):
refactor(scope):
chore:
infra:
docs(scope):
test(scope):
```

Keep commit messages short and clear.

---

## Final Rule

Choose the simplest correct solution.

Use clear names.

Use few moving parts.

Do not add complexity without a real reason.

**Simple code. Simple explanations. Clear names. One implementation per responsibility.**
