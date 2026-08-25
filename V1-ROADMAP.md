# HigherPays — First Version Roadmap

Reconciled against the "V1 Requirements — Payment CRM" spec and the
actual codebase (2026-08-24). Estimates are dev-days.

---

## Decisions locked in

- **Role model: 5 roles** — `owner`, `admin`, `analyst`, `agent`,
  `account` (done, migration 031). `manager` was removed and its members
  became `admin`. `owner` and `admin` are separated only by
  `settings.danger`, which stays owner-only. The vocabulary follows
  `HigherPays — Entity Definitions.md`: an Account is what used to be a
  Creator, an Agent what used to be a Chatter.
- **Platform admin removed for v1**, not deferred — no `/platform/*`
  console. One agency today; direct DB access covers ops needs. Revisit
  when a second agency onboards.
- **"Cancelled" is a real new capability** on payment links, not a label
  over `expired`/`failed` — needs its own status so "we cancelled this"
  is distinct from "the fan never paid."
- **Analytics/Compare stay in v1** (correcting the first draft, which cut
  them as extras). Spec §5 requires role-scoped stats and account/agent
  comparison as core — the backend (`analytics.routes.js`) already
  computes it, this is frontend wiring. Fold "Compare" into the Dashboard
  as a view rather than a separate page.
- **Still cut**: Goals (gamification, not in spec), multi-workspace
  switcher (one agency today).

---

## Gap analysis, by spec section

| # | Area | Status today | Work needed | Days |
|---|---|---|---|---|
| 1 | Auth & Roles | 5 roles, renamed and backfilled (031); email+password login, 2FA and session revocation all work; `npm run seed` creates two tenants with one login per role | "Last admin" lockout guard; invite/accept-invite UI (backend endpoints exist) | 1.5 |
| 2 | Customer Mgmt | CRUD, alias/email search, CSV export exist | Search by phone/customer ID/transaction ID; dedupe warning on create; single Customer 360 endpoint | 2 |
| 3 | Payment Links | No cancel action | `cancelled` status + gated endpoint + audit + UI; keep `refunded` as a visible 5th state | 1 |
| 4 | Payments | `GET /transactions` has zero filters | Server-side filters: status, account, agent, date, amount, txn ID | 1 |
| 5 | Dashboard & Stats | Backend exceeds spec already | Wire frontend to `analytics.routes.js`, fold in comparison view | 1.5 |
| 6 | Search/Filter | — | Covered by #2 and #4 | — |
| 7 | Account↔Agent | Fully built (`account_agents`, audited) | Confirm/finish frontend assign UI | 0.5 |
| 8 | Audit Log | Backend writes broadly already | Workspace-scoped `GET /audit` + frontend page (today only platform admins can read it) | 1 |
| 9 | Notifications | Bell reads demo data | Wire to real `GET /notifications`; add "link expired" trigger | 1.5 |
| 10 | User Mgmt | Invite + role assignment work | Activate/deactivate endpoint + audit + UI toggle | 1 |
| 11 | Data Export | Customers CSV exists | Same pattern for payments and links; stats export deferred | 1 |

---

## Supporting work (not spec-derived, still required)

| Item | Days |
|---|---|
| Settings — wire fee %/link-limit editing | 1.5 |
| Clearance process — reconciler cron (webhook-miss safety net) | 1 |
| Raise the standard — security review, rebuild `NotificationBell` on the shared UI kit, consistent states | 1.5 |
| Delete irrelevant pages — Goals/Workspaces trim + full Platform removal (routes, middleware, table) | 1 |
| Deploy — push, rebuild on EC2, smoke test, fix-forward buffer | 0.5 |

---

## Total: ~19 dev-days (≈ 4 weeks)

**Not on this clock**: MantaPay credentials from the customer — nothing
above is blocked by that wait; it runs in parallel.

**Open item**: cancel-link flow (§3) needs a short design pass on one
edge case — a link cancelled while a checkout is already open in the
fan's browser — before that piece starts.
