# UI feedback round 1

Source: client review PDF (19 pages), 1 Sep 2026. Each item keeps an id so we can
work through them by name. Page numbers refer to the PDF.

Type tags: **copy** (text/label only) · **visual** (CSS, sizing, colour) ·
**bug** (behaves wrong) · **feature** (new behaviour, may need backend) ·
**question** (needs an answer before it can be built) · **answered** (settled, no work left).

Answers from the 1 Sep review are folded in below. ✅ = shipped, ◐ = partly done (see the row).

---

## A. Shell and global

| id | p | type | item |
|----|---|------|------|
| A1 ✅ | 4 | visual | The login and invite pages showed a bitmap wordmark in a different face. It is type now — the app's own font and weight, next to the mark, like the sidebar. logo-wordmark.png deleted. |
| A2 ✅ | 4 | visual | You dropped the real mark into frontend/public/favicon.svg. |
| A3 ✅ | 4, 8 | copy | Drop the explainer subtitle under page titles and modal titles ("Hosted checkout links…", "The customer pays on MantaPay's hosted page…"). Same treatment already applied to Payments. |
| A4 ◐ | 13, 15 | copy | Terminology: "Chatter" → "Agent" everywhere, "Account" → "Creator". Seed now labels agents "Agent"; the live workspace still says "Chatter" until someone changes it in Settings → Workspace (or we run one UPDATE). Export headers now say Creator/Agent. |
| A5 ✅ | 17 | bug | Two causes. The mobile nav rule assumed nav's children were the items, but they are the groups, so each group became a column — they are  now and the strip works. And both shell columns sized to their content, so a wide table or the nav strip stretched the page;  on each keeps the scrolling inside the table. Also stacked the stat cards, page header and paired form fields on phones. |
| A6 ✅ | 9 | feature | Sort and filters live in the column headers on Payments, Payment links, Customers, Creators, Agents and Team, each with an "Edit columns" chooser (and "Edit cards" where the page has stat cards). Payments, links and customers sort on the server; the three lists the server returns whole sort in the browser (`lib/sortRows.ts`). |

## B. Date range filter (shared component)

| id | p | type | item |
|----|---|------|------|
| B1 ✅ | 1 | copy | The button reads "Date: …" and the duplicated "All time" preset is gone — clearing is now a Clear button in the popover. Presets trimmed from seven to four. |
| B2 ✅ | 1 | copy | The button doesn't read as a date filter. Needs a prefix or icon ("Date: All time"). |
| B3 ✅ | 2 | visual | Replaced the native date inputs with our own month calendar — design tokens, tabular numerals, teal selection, the range shaded between the ends. |

## C. Payments

| id | p | type | item |
|----|---|------|------|
| C1 ✅ | 3 | feature | Export CSV now opens a dialog: date range (overrides the filter bar), all matching rows or only the loaded ones, and a tick-box per column. CSV only — XLSX would need a new backend dependency. |
| C2 ✅ | 3 | copy | Export columns: `amount` → "Gross Revenue"; `account` → "Creator"; drop `link`; add a "Net Revenue" column beside `platform_fee`. |
| C3 | 3 | answered | `reference` is MantaPay's transaction id (`transactions.provider_transaction_id`). The HigherPays-side id is the `link` column (`ord_…`), which C2 drops — say so if you want that kept instead. |
| C4 ✅ | 3 | copy | Merge `amount` and `currency` into one column. |
| C5 ✅ | 3 | copy | Customer carries both: the typed name and the Telegram handle. Today the export writes only the name. |
| C6 | 3 | answered | Status stays Paid / Failed / Refunded, and "Paid — details needed" stays as its own state. Nothing to change. |
| C7 ✅ | 5 | visual | Amount and Fee left-aligned in Payments and Payment links, plus wider cell padding (16px → 20px) in every table. |
| C8 ✅ | 10 | feature | "Record refund" inside a paid payment is now red; it already led to a tick-box confirmation with a red confirm button. |

## D. Payment links

| id | p | type | item |
|----|---|------|------|
| D1 — | 5 | answered | Decided: leave the six statuses as they are. Nothing to build. |
| D2 ✅ | 6 | bug | The amount boxes are debounced like the search box, so a nudge of the spinner no longer refetches per click. They now live in the Amount column header. |
| D3 ✅ | 9 | visual | Revenue stat card sizing is off next to its neighbours. |
| D4 ✅ | 9, 12 | copy | Column and detail row removed — Type and Status already say it. There was no expiry alert to remove either. The bracketed assumption did need work: how long a single-use link lives is a workspace setting now (Settings → Payment link limits), not one env var for the platform, and the new-link hint reads the real number. |
| D5 ✅ | 10 | feature | Button removed. Reconciliation now runs on a 10-minute timer in the API for every workspace (`services/links.service.js`); the endpoint stays for support. |
| D6 ✅ | 12 | visual | "Cancel link" button should be red; "Active" badge should be green. |
| D7 | 13 | feature | Reassign the Creator and the Agent on an existing link, dropdown + confirmation. The change applies only to future payments; past payments keep their original attribution, splits and payout history. The dialog says this clearly, and the change is audited. |
| D8 | 7, 8 | copy | New link modal: remove the "Fees on this link" line, "Fixed per transaction" → "Transaction Fee", "Net to workspace" → "Net Profit" and larger. No decision needed — the limits and the transaction fee are already per-workspace settings (Settings → Workspace, and the rate card); the modal already reads them. |
| D9 | 8 | feature | Decided: per workspace, on the rate card, editable only in the Platform console. The agency never sees it. The checkout link is created for amount + fee so the customer pays it, and it counts into platform gross. |
| D10 ✅ | 14, 15 | bug | A click on the overlay no longer closes any dialog — Escape and Cancel still do. Half of them are forms, and losing a half-filled one to a stray click is worse than the extra click. |

D1 - keep only the omne thaty actualy work aginst mantapay + "Paid — details needed"

## E. Payouts

| id | p | type | item |
|----|---|------|------|
| E1 ✅ | 11 | feature | Remove the "Held in reserve" card. |
| E2 ✅ | 11 | visual | "Owed to creators" / "Owed to chatters" values render smaller than "Owed in total". |

## F. Creators

| id | p | type | item |
|----|---|------|------|
| F1 ✅ | 15 | copy | Add creator: drop the "Handle" field. |
| F2 | 15 | feature | Decided: reuse the existing invite flow. Adding a creator emails them; they set their own password on the accept page. The password field goes. |
| F3 | 15 | feature | Decided: salary is a fixed amount per payout period. A salaried creator takes no cut of a sale — the agency keeps that share — and the salary shows on Payouts as its own obligation. Migration + revenue engine + Payouts. |
| F4 ✅ | 15 | copy | Rename the "Owner login" section. |
| F5 | 15 | copy | Wording for the pay model, alongside F3. |
| F6 ✅ | 15 | bug | Fixed with D10 — it was one behaviour in the shared Modal. |
| F7 ✅ | 15 | feature | Country is a field on both the add and the edit dialog. The API already took it; only the form was missing. |
| F8 ✅ | 15 | feature | One Edit dialog now holds the details, the share and the agent roster. The second button and its modal are gone. |
| F9 ✅ | 15 | copy | Remove the "Owner" column. |
| F10 ✅ | 15 | visual | Gone with F11 — the checkbox is now the Status header filter. |
| F11 ✅ | 15 | bug | A search now reaches archived creators; the plain roster still hides them. The "Show archived" checkbox became a Status filter in the header (Active and paused / Active / Paused / Archived / All). |
| F12 — | 15 | answered | Decided: no delete. Archiving already hides a creator and blocks new links, and it keeps the ledger whole. |
| F13 ✅ | 16 | visual | The right-aligned numeric columns (share, agent count) now align left like the rest, same as C7 on Payments. |
| F14 ✅ | 16 | visual | Row action buttons need spacing. |
| F15 | 13 | answered | What the code does today: pausing sets `accounts.status = 'paused'`, which blocks creating new links and nothing else. A payment on an existing link is recorded and split exactly as if the creator were active — the payment path never reads the account status, payouts don't filter on it, and the creator's own login still sees the money. That is what "nothing changes in the ledger" means. Open decision: leave it, or make a paused creator's income hold somewhere. |

## G. Agents

| id | p | type | item |
|----|---|------|------|
| G1 ✅ | 18 | bug | The field was disabled on edit and the API had no field for it. Both fixed — note the name lives on the login, so it changes in every workspace that person works in. The email stays fixed: it is how they sign in. |
| G2 | 10 | feature | Decided: delete the page, its route and its nav entry. Git keeps the code; the settlement import and reserve API stay on the backend. |

---

## Counts (46 items)

| type | count |
|------|-------|
| copy | 12 |
| visual | 10 |
| bug | 6 |
| feature | 15 |
| answered | 3 |

## Suggested order

1. **Copy and label pass** (A3, A4, C2, C4, C5, D4, F1, F4, F5, F9) — cheap, no risk, makes the next screenshots readable.
2. **Real bugs** (D2, D10/F6, F11, A5, G1) — these are the ones a demo trips over.
3. **Visual pass** (B1–B3, C7, D3, D6, E2, F10, F13, F14, A1, A2).
4. **Features, smallest first** (D5, E1, G2, F8, F7, F12, C1, C8, D1, D7, D8, D9, F2, F3, A6).

One decision still open: F15 — whether a paused creator's income should keep flowing as it does today.
