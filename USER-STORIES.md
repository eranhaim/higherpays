# User stories

One workspace is one agency. Four workspace roles plus the HigherPays operator.
Every story names who, what, and the rule that makes it whole. A story is
"whole" when the person can start it, finish it, and see the result without
leaving the console or asking someone else.

Rule for every page: **if you cannot do it, you do not see it.** No disabled
controls standing in for missing permission. Read-only roles see values, not
dead inputs.

---

## Roles

| Role | Sees | Does |
|---|---|---|
| **Admin** (`workspace_admin`) | Everything in the workspace | Everything |
| **Analyst** | Everything, read-only | Exports |
| **Agent** (agency calls them "Chatter", "Closer"…) | Accounts they are assigned, their own links and payments, their own earnings | Creates links, completes paid payments, manages customers |
| **Account owner** (the "Creator", "Talent"…) | Their own account, its links and payments, their own earnings | Nothing else |
| **Platform admin** (HigherPays operator) | Every agency | Onboards agencies, sets their rates, suspends them |

---

## 1. Sign in and get set up

**1.1 Sign in.** Anyone with a login signs in with email and password; with 2FA on, a 6-digit code. A wrong password says so. A suspended member is refused.

**1.2 Accept an invite.** An invited admin or analyst opens the emailed link, sees which agency and role they were invited to, sets a password (or, if their email already has a login, just confirms), and lands on the sign-in page. An expired or used link says so and offers nothing else.

**1.3 Switch workspace.** A person in more than one agency picks which one they are looking at from the sidebar. Every page follows.

**1.4 Personal settings — every role.** Anyone can, for their own login: enable or disable 2FA, see where they are signed in and end any session, set their time zone, and choose which events reach their notification bell. This is not gated on any workspace permission.

---

## 2. Operate: get paid

**2.1 Create a link — agent, admin.** Pick one of the accounts you work, optionally the customer, single-use or reusable, and the amount. The fee preview shows what the workspace nets. Below the minimum or above the maximum is refused with the limit shown. The result is a URL you copy and send.

**2.2 See your links — everyone.** Filter by account, type, status, amount and date; search by reference, customer or agent. An agent sees only their own; an owner only their account's. Click a row to see the full link: checkout URL, when it expires, who created it.

**2.3 Cancel a link — agent, admin.** From the row or the detail. The URL stops working; nothing changes in the ledger.

**2.4 A payment arrives.** The customer pays on MantaPay's page. The payment appears in Payments as *Paid — details needed*, the link moves to *Paid — details needed*, and the bell rings for everyone subscribed to it.

**2.5 Complete the payment — agent, admin.** From the payment row, the payment detail, or the link detail: say who paid (an existing customer or a new one) and what for (a category). The payment becomes *Paid*, the single-use link *Done*. This is the step that turns money into revenue you can attribute.

**2.6 Reconcile — admin.** When a payment is suspected but no notification arrived, "Reconcile" asks MantaPay about every unresolved link and applies what it finds.

**2.7 Record a refund — admin.** The refund is issued in MantaPay's dashboard; recording it here reverses the sale in the ledger so payouts stay right. The refund fee is shown before confirming.

**2.8 Record a chargeback — admin.** Same shape as a refund, with the chargeback fee.

**2.9 Export payments — analyst, admin.** The filtered list as CSV.

---

## 3. Manage: people and customers

**3.1 Add an account — admin.** The account and its owner's login in one step. Set its revenue share and assign the agents who work it. The share must leave room for the highest agent commission.

**3.2 Edit an account — admin.** Rename, change the handle. The share is a revenue decision: only `revenue.manage` sees the field.

**3.3 Pause, reactivate, archive an account — admin.** Pausing stops new links (confirmed, because it blocks income). Archiving is for an account that has left; it disappears from pickers but keeps its history. Both are reversible.

**3.4 Add an agent — admin.** The agent and their login in one step, with their commission.

**3.5 Edit an agent — admin.** Commission (with `revenue.manage`) and country. Name and email belong to the login and are not edited here.

**3.6 Suspend and reactivate anyone — admin.** Suspending signs them out everywhere and refuses sign-in; their record and history stay. The last admin cannot be suspended.

**3.7 Remove a seat — admin.** Only an admin or analyst seat can be removed outright; an agent or account owner is suspended instead so the ledger keeps its names.

**3.8 Invite an admin or analyst — admin.** By email. Pending invites are listed; an expired one can be cleared, a live one cancelled.

**3.9 Customers — agent, admin.** Everyone who paid, what they spent, their segment. Open one to see their payments. Add one by hand, edit their details, or erase them (name and contact details are wiped; payments stay, anonymised).

**3.10 Export customers — admin.** As CSV.

---

## 4. Money: what is owed and paid

**4.1 See what is owed — admin, analyst.** For a period: what each account and agent is owed, what came in after fees, what MantaPay holds in reserve, and whether paying everyone now leaves the agency short.

**4.2 Pay — admin.** One payee or everyone of a type. Confirmed with the total. The balance is marked settled in the ledger.

**4.3 Payout history — admin, analyst.** Every payout run: who, how much, for which period, when.

**4.4 See your own earnings — agent, account owner.** Sales in the period, what was deducted, your rate, what you earned, what you are still owed and what has been paid to date. Nothing about anyone else.

**4.5 Settlement reports — admin.** Import MantaPay's daily XLSX. Each report is reconciled against our own ledger and the variance shown. The reserve schedule shows what is held and when it releases. Once imported, the reserve on Payouts is exact rather than estimated.

**4.6 Analytics — everyone, scoped.** Gross, net, take rate, average order, buyers, funnel, category mix, reversal risk. Admins and analysts pivot to one account or agent and see the agency-side split; an agent or owner sees their own figures only. Export as CSV.

---

## 5. Administer the workspace

**5.1 Workspace settings — admin edits, analyst reads.** Name, vocabulary (what the agency calls accounts and agents), default revenue split for new people, link limits, and the **MantaPay merchant ID** the agency was given. The webhook endpoint MantaPay must notify is shown for copying.

**5.2 Categories — admin.** What a sale can be for. Retiring one hides it from the picker but keeps it on past payments.

**5.3 Telegram notifications — admin.** Connect a chat by ID, choose which events it receives, test it, pause it, remove it.

**5.4 Activity — admin, analyst.** Who did what in the workspace, newest first.

---

## 6. Platform (HigherPays operator)

**6.1 See every agency.** Status, currency, merchant ID, blended rate, members, volume, last activity.

**6.2 Onboard an agency.** Name, currency, merchant ID, rate card (PSP rate, margin, fixed fee), settlement fees, default split, and the email of its first admin — who receives an invite. One form.

**6.3 Change an agency's rates.** A new versioned rate row; history is kept.

**6.4 Suspend or reactivate an agency.**

---

## Consistency rules

* One date filter: the range picker with presets, in the filter bar. Never a bare date input on a page.
* One table: `DataTable` for a page's main list; `.tablewrap` only for a table inside a card.
* One dropdown look: every select carries a visible or screen-reader label.
* Row actions are `btn ghost small`. The confirmation dialog is where a destructive action turns red.
* Money always through `<Money>`. Zero is neither in nor out and is never coloured.
* Loading, empty and error states come from the shared components, worded for the page.
