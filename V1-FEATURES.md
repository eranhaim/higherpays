# HigherPays V1 — Features & User Stories

What ships in the first version. Pairs with `V1-ROADMAP.md` (effort and
sequencing) — this doc is scope only: what a user can do.

## Roles

| Role | Who | Sees |
|---|---|---|
| `owner` | Owns the workspace | Everything, including the danger zone |
| `admin` | Runs the agency | Everything except the danger zone |
| `analyst` | Reporting / finance | Read-only across the workspace, can export |
| `agent` | Closes sales | Only their assigned accounts, own customers, own links/stats |
| `account` | The talent | Only their own dashboard and earnings |

Names follow `HigherPays — Entity Definitions.md`: an Account is what used
to be called a Creator, an Agent what used to be called a Chatter.

---

## 1. Login

- As any user, I log in with email + password to reach my workspace.
- As a workspace admin, I invite a teammate by email with a specific
  role, so they only get access to what their job needs.
- As an invited teammate, I follow the invite link and set a password to
  activate my account.
- As a workspace admin, I deactivate a user who's left, so their access
  is revoked immediately.

## 2. Customers

- As an agent, I search for a customer by name, phone, email, or
  customer ID before creating a link, so I don't duplicate them.
- As an agent, I'm warned if a customer with that phone/email already
  exists, so the agency doesn't end up with two records for one fan.
- As any user, I open a customer's profile and see everything in one
  place — details, every payment link, full payment history, current
  status, which account/agent they belong to, and recent activity.

## 3. Payment Links

- As an agent, I create a payment link for my assigned account's fan,
  set the amount, and share the checkout URL.
- As an agent, I cancel a link I created by mistake or no longer need,
  before the fan pays it — it can't be paid after that.
- Statuses I see on a link: **Active, Paid, Expired, Cancelled** (and
  **Refunded** if a paid link is later reversed).
- As a workspace admin, I see and search every link in the agency; as an agent, only the ones I created.

## 4. Payments

- As a workspace admin or analyst, I see every payment with its status
  (**Pending, Paid, Failed, Cancelled, Refunded**), method, amount,
  and which account/agent it belongs to.
- As an account, I see only payments tied to me.
- As any of the above, I filter payments by status, account, agent,
  date range, amount, or transaction ID.

## 5. Dashboard & Statistics

- As a workspace admin or analyst, I see agency-wide KPIs: total and
  pending amounts, transaction count, links created, and link-to-payment
  conversion rate — filterable by date, account, or agent.
- As an account, I see my own stats and compare my performance against
  other accounts.
- As an agent, I see my own stats and compare my performance against
  other agents.

## 6. Account ↔ Agent Assignment

- As a workspace admin, I assign one or more agents to an account (and
  change or remove that assignment later) — this is what decides what an agent can see and act on.

## 7. Audit Log

- As a workspace admin, I see a log of who did what and when: link
  created/cancelled, payment status changes and refunds, customer
  created/edited, users created, permissions changed, and account↔agent
  assignment changes — each with the before/after value where relevant.

## 8. Notifications

- As an agent or account, I get an in-app notification when a payment
  I'm tied to is received or fails, or when one of my links expires.

## 9. Data Export

- As a workspace admin, I export customers, payments, or payment links
  to CSV to hand off to accounting or import elsewhere.

---

## Explicitly not in V1

Goals (gamification), multi-workspace switching, and the HigherPays
platform super-admin console — see `V1-ROADMAP.md` for why.
