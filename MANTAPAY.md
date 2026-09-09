# MantaPay Integration

How the payment provider works, what we send, what comes back, and what is
currently wrong or unverified.

MantaPay is a **hosted-checkout** provider. The payer is sent to a page on
MantaPay's domain and enters card details there. We never touch card data.

Code lives in `backend/src/providers/`. Tests in `backend/test/mantapay.test.js`.

---

## 1. Hosts and credentials

Three different hosts, three different authentication schemes.

| Purpose | Host | Auth |
|---|---|---|
| Payer hosted page | `uiservices.mantapay.biz` | provider-generated redirect |
| APM start and status polling | `process.mantapay.biz` | signed query (hash key) |
| Transaction Search (fees) | `webservices.mantapay.biz` | login → session token + body signature |

Credentials live in env only:

```
MANTAPAY_MERCHANT_ID      merchant number
MANTAPAY_HASH_KEY         signing key for checkout + status + notifications
MANTAPAY_APP_TOKEN        issued by support, sent on every webservices call
MANTAPAY_API_EMAIL        API user (role 50)
MANTAPAY_API_PASSWORD
MANTAPAY_SEARCH_SALT      salt for the search body signature
MANTAPAY_FEE_MODE         additive (default) or included
MANTAPAY_REFUND_ENABLED   false today
```

A workspace row stores a **reference** to the env var name
(`workspaces.provider_config_ref`), never the key itself — a database leak
leaks no signing material.

---

## 2. Adapter surface

`backend/src/providers/mantapay.js` is the only provider entry point the routes
import:

```
resolveApiKey        per-workspace hash key
resolveMerchantId    per-workspace MID
createCheckout       build the hosted-page URL
apm.startApm          start the public payment page and return its redirect
parseWebhook         inbound notification -> our vocabulary
verifyWebhookSignature
getPaymentStatus     poll by our order reference
mapPaymentStatus     reply code -> approved | pending | declined | abandoned
isAmbiguousStatus    always false (their codes are unambiguous)
refundPayment        throws 501 on purpose
```

Everything else is behind it:

| Module | Responsibility |
|---|---|
| `mantapay-signature.js` | request + notification signatures, reply codes |
| `mantapay-checkout.js` | hosted-page URL / form construction |
| `mantapay-status.js` | status check by order or by transaction id |
| `mantapay-search.js` | transaction search with per-transaction fees |
| `mantapay-auth.js` | webservices login + session caching |

---

## 3. Starting public checkout (outbound)

The public route calls `apm.startApm` in `mantapay-apm.js`. It sends a signed
request to `process.mantapay.biz/member/remote_charge.asp`, receives
`D3Redirect`, then redirects the payer to MantaPay's hosted CentroBill page.
Our `payment_links.reference_id` is sent as `Order`.

The request signature is:

```
base64(SHA256(CompanyNum + TransType + TypeCredit + Amount + Currency + hashKey))
```

`Amount`, `Currency`, and the signature all come from the same calculated
request values. Currency uses MantaPay's numeric ids: USD `1`, EUR `2`, GBP `3`.

### Checkout fee modes

`MANTAPAY_FEE_MODE` controls how the customer-paid checkout fee is represented:

| Mode | `Amount` | `ExtraCostAmount` | Status |
|---|---|---|---|
| `additive` | content amount | fee / content amount | Default; proven live behavior |
| `included` | content + fee | fee / customer total | Gated; not confirmed live |

`ExtraCostAmount` is a ratio, not a currency amount. The live endpoint rejects
values greater than or equal to `1`, and the current request
`Amount=100.00&ExtraCostAmount=0.02` displays a customer total of `102.00`.
Therefore included mode keeps the proven ratio semantics: for €100 content +
€2 fee it sends `Amount=102.00&ExtraCostAmount=0.01960784`. For €3 + €2 it
sends `Amount=5.00&ExtraCostAmount=0.4`.

No second fee field is sent. With no checkout fee, `ExtraCostAmount` is omitted.
Amounts are calculated in cents, emitted with two decimals, and the ratio is
limited to eight decimals.

The legacy `mantapay-checkout.js` hosted-page builder still uses its separate
`EC` field, but the public payment route does not use that path. `EC` and
`ExtraCostAmount` must not be mixed.

### Gated rollout

1. Keep production at `MANTAPAY_FEE_MODE=additive`.
2. Obtain MantaPay's written confirmation listed below.
3. Set `MANTAPAY_FEE_MODE=included` in a non-production environment and restart
   the API. Confirm the startup integration log reports `feeMode: included`.
4. Run €100 + €2 and €3 + €2 payments. Confirm the request, CentroBill display,
   amount charged, signed webhook amount, and transaction search record.
5. If MantaPay adds the fee again or reports inconsistent values, restore
   `additive` and restart.
6. Only after both vectors pass, set production to `included`, restart, and
   monitor the first real transactions. This repository does not enable or
   deploy included mode by default.

Exact confirmation still required from MantaPay:

* their bank-side display fix is live for the production merchant;
* the direct APM fee field is still named `ExtraCostAmount`;
* that field remains a ratio when `Amount` already contains the fee;
* the ratio denominator must be the full customer total;
* the fee is displayed as included and is not added to `Amount` again;
* whether the signed webhook `trans_amount` returns content or customer total.

Public documentation searches found no authoritative MantaPay page for this
contract. Until all points above are confirmed and the two vectors pass,
`additive` is the safe production mode.

---

## 4. Payment result (inbound webhook)

MantaPay POSTs `application/x-www-form-urlencoded` to `notification_url`.

The signature is a **field in the body**, not a header, and covers only a
subset:

```
payment    : trans_id + trans_order + reply_code + trans_amount + trans_currency + key
chargeback : trans_id + action + reason + reasonCode + comment + originalID + OrderId + key
```

The money-critical fields are covered. `trans_date`, `reply_desc` and all
client details are **not signed** and must never affect the ledger.

Fields returned: `trans_id`, `trans_order`, `reply_code`, `reply_desc`,
`trans_amount`, `trans_currency`, `payment_details`, `client_email`,
`client_fullname`, `trans_date`.

**MantaPay does not report the fee or the net.** `parseWebhook` sets
`fee: null, net: null`; the payout engine prices the sale from our own rate
card, and reconciliation is supposed to replace the estimate later with the
provider's actual figure.

During the fee-mode transition, `validateProviderMoney` accepts the signed
`trans_amount` as either the link content amount or content plus checkout fee.
It rejects every other amount. The ledger always records the link's stored
content as gross and its stored checkout fee as surcharge; provider display and
webhook variation cannot change the agency split.

### Reply codes

Strings, never parsed as integers — the list contains dotted codes (`100.011`),
alphanumerics (`N7`, `5C`) and leading zeros.

| Code | Meaning |
|---|---|
| `000` | approved |
| `553` | pending — 3DS/APM redirect |
| `663` | pending — awaiting final response |
| `001` | pending — awaiting customer (PIX / wire) |
| `600` | abandoned — customer closed the window |
| `500`–`534` | **our** request was malformed (signature / merchant config) |
| everything else | declined |

There are three pending codes, not one. Treating `001` or `663` as a decline
would fail a link while the customer is still completing a transfer.

### Route

`webhooks.routes.js` — layered authentication, in order:

1. the opaque per-workspace endpoint id in the URL resolves the tenant
2. `verifyWebhookSignature` over the raw body
3. `merchantID` in the payload matches the workspace MID

Then: insert into `webhook_events` (idempotent on `provider_event_id`) →
`payments.service.js` `recordPaymentOutcome`. Rejected events are marked
processed so a retry with the same bad signature does not sit in the backlog.

---

## 5. Status polling (the safety net)

`getPaymentStatus(ws, reference)` GETs
`process.mantapay.biz/member/getStatus.asp` with `CompanyNum + Order +
signature`, where the signature is `base64(SHA256(CompanyNum + Order + key))`.

Returns **every** attempt against that order — a payer can retry, so one order
can hold several declines and one approval. `resolveOrderOutcome` picks:
an approval wins → else pending → else the latest decline.

Dates come back `DD/MM/YYYY HH:mm:ss`, not American.

Used by the reconciler when a webhook never arrived: `backend/src/services/links.service.js`, which the API runs every 10 minutes for every workspace and `POST /workspaces/:wid/links/reconcile` runs on demand.

---

## 6. Transaction Search (real fees)

Different authentication entirely.

1. `POST /v2/account.svc/login` with `applicationToken` header + API-user
   credentials (role 50).
2. The response returns `CredentialsToken` **and the name of the header to put
   it in** (`CredentialsHeaderName` is the name of a header, not a literal
   header name — getting this wrong yields a 401 that looks like bad
   credentials).
3. Session cached 20 minutes. A 401 invalidates and re-logs in once.
4. `POST /v2/transactions.svc/Search` with
   `Signature: bytes-SHA256, <base64(SHA256(rawBody + salt))>`.
   The signature covers the **raw body** and carries that literal prefix.

Use the API-user role so a human changing their portal password does not
silently break the integration. Credentials expire every 3 months regardless.

`loadOptions.LoadFees: true` is required — without it there are no
per-transaction fees. Returns `TransactionFees`: debit, transaction, handling,
ratio, chargeback, chargeback-debit, clarification. This is how we would get
true margin without importing a settlement spreadsheet.

Dates are WCF format `/Date(1702554387000+0000)/`, and their examples mix
seconds and milliseconds — length decides which.

---

## 7. Refunds

Record-only. `refundPayment` throws `501` on purpose: their flow is a two-step
request that an admin approves, and it has not been implemented.
`MANTAPAY_REFUND_ENABLED=false`. The app records refunds issued in MantaPay's
dashboard.

---

## 8. Integration-mode test amounts

In integration mode the **amount** drives the outcome.

| Amount | Code | Result |
|---|---|---|
| `0.04` | 1001 | declined — soft decline |
| `0.05` | 1002 | declined — insufficient funds |
| `0.90` | 000 | approved after 5s |
| `0.95` | 000 | approved after 50s |
| `0.99` | 000 | approved after 90s |
| `55.3` | 553 | 3DS/APM redirect — see caveat below |
| `>= 1.00` | 000 | approved |

Any amount below 1.00 that is not in this table returns 596
("incorrect charge amount").

---

## 9. Open issues

Verified by the backend unit suite. The included fee mode is **not** verified
against the live provider contract — see §3 and §11.

### Money-affecting

**1. Attribution rests on an unconfirmed field mapping.**
The public APM request sends our reference as `Order`. We read it back as
`trans_order`, and `payments.service.js` looks the link up by
`reference_id = trans_order`. MantaPay has not confirmed that `Order` is echoed
there. If it is not, every payment arrives unattributed. The signature can
still verify because an empty `trans_order` contributes nothing to the hash.

**2. `resolveApiKey` falls back silently.**
`mantapay.js:33` — if a workspace has `provider_config_ref` set but that env
var is missing, it drops to the platform-wide `MANTAPAY_HASH_KEY` instead of
failing. A misconfigured tenant signs with the wrong merchant's key and gets
reply 500.

### Incomplete

**3. The Search API is dead code.**
`mantapay-search.js` is written and unit-tested, but nothing calls
`searchTransactions`. Per-transaction fees are the one thing MantaPay gives us
that the webhook does not, and we never fetch them. `getStatusById` is also
exported and uncalled.

**4. Two unused order constants.**
`HOSTED_FIELD_ORDER_REQUEST` / `HOSTED_FIELD_ORDER_JS` in
`mantapay-signature.js` use lowercase `client_billaddress1`, while
`mantapay-checkout.js` uses `client_billAddress1`. Checkout always passes its
own explicit order, so the defaults are never used — but they would be wrong if
anything did use them.

---

## 10. Questions for MantaPay

Unconfirmed points, flagged inline in the code. Worth sending back to them.

1. **Does direct APM `Order` populate `trans_order` in the notification?**
   See open issue 1 — this mapping is load-bearing.
2. **In direct APM included mode, does `trans_amount` return content or customer
   total?** Both are accepted during cutover, but MantaPay must confirm which is
   contractual.
3. **Is the `Signature` field in the login response the salt the Search API
   signs bodies with?** `mantapay-search.js` assumes so, falling back to
   `MANTAPAY_SEARCH_SALT`.
4. **Test amount `55.3`: is it reply 533 or 553?** Their Controlling Replies
   page says 533; their Reply Codes page documents 553 as the 3DS/APM redirect
   (533 is "cannot refund more than the original amount", which makes no sense
   here). Treated as a typo for 553. If it really is 533 we classify a 3DS
   redirect as a decline.
5. **The refund flow** — `PP-Refund-Request` / `Process` / `Status`. Not read,
   not implemented.

---

## 11. Documentation

There is no vendor documentation in this repo, and `mantapay.biz` /
`docs.mantapay.biz` do not resolve publicly — the integration hosts are
private. Everything above was derived from the code, its tests, and vectors
captured from MantaPay's own Signature Generator and Validator pages.
