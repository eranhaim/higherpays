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
| Hosted checkout page | `uiservices.mantapay.biz` | signed URL (hash key) |
| Status polling | `process.mantapay.biz` | signed query (hash key) |
| Transaction Search (fees) | `webservices.mantapay.biz` | login → session token + body signature |

Credentials live in env only:

```
MANTAPAY_MERCHANT_ID      merchant number
MANTAPAY_HASH_KEY         signing key for checkout + status + notifications
MANTAPAY_APP_TOKEN        issued by support, sent on every webservices call
MANTAPAY_API_EMAIL        API user (role 50)
MANTAPAY_API_PASSWORD
MANTAPAY_SEARCH_SALT      salt for the search body signature
MANTAPAY_REFUND_ENABLED   false today
```

A workspace row stores a **reference** to the env var name
(`workspaces.provider_config_ref`), never the key itself — a database leak
leaks no signing material.

---

## 2. Adapter surface

`backend/src/providers/mantapay.js` is the only file the routes import:

```
resolveApiKey        per-workspace hash key
resolveMerchantId    per-workspace MID
createCheckout       build the hosted-page URL
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

## 3. Creating a payment link (outbound)

`createCheckout(ws, {...})` makes **no HTTP call**. It builds a signed URL and
returns it. There is no provider-side link id until someone pays, so
`providerLinkId` is `null` and our own `reference_id` is the join key.

Fields sent (`mantapay-checkout.js`):

| Field | Value |
|---|---|
| `merchantID` | workspace MID |
| `trans_type` | `0` — debit (auth + capture) |
| `trans_installments` | `1` — regular, non-instalment |
| `trans_amount` | 2dp |
| `trans_currency` | ISO code |
| `trans_refNum` | **our reference** |
| `disp_payFor` | description (max 40) |
| `disp_lng` | `en-US` |
| `client_fullName` / `client_email` / `client_phoneNum` | payer details |
| `notification_url` | our webhook endpoint |
| `url_redirect` | thank-you page |
| `Brand` | attribution tag |
| `ExpiredOn` | **epoch seconds**, GMT |
| `EC` | optional surcharge, `price\|Name\|Description`, 50-char cap |

### Signature

```
urlencode( base64( SHA256_raw( concat(values) + hashKey ) ) )
```

* base64 of the **raw 32 digest bytes**, not of the hex string
* values concatenated with **no delimiter**; empty values contribute nothing
  but still hold their position in the order
* the order of the signature must match the order of the request string
* POST sends the un-encoded base64 instead

Two traps, both fatal because the hash is byte-exact, both handled:

* **Hash input** is the raw value with **spaces replaced by `+`**, nothing else
  escaped. Neither doc page says this — the Signature page shows fully
  URL-encoded values, the Validator page says raw values, and both are wrong as
  written. The truth came from the Validator's field-by-field output.
* **Wire encoding** is .NET `HttpUtility.UrlEncode`, not `encodeURIComponent`:
  space → `+`, hex escapes lowercase (`%2b`, not `%2B`).

`buildCheckout` derives the query string and the signature from **one ordered
array**, so they cannot drift.

### Verified vectors

Both captured from MantaPay's own tools and asserted in the test suite:

```
Generator : 377109718015EURProduct-name0en-gbjohn+smith...
            -> uaPyTpm63hyv0bdYfkfLspPXxr2lW6KOlfy4CExuRnQ=
Validator : 168-char concat -> /o+QnAtvuyRHFRntTEtq879sWXq1oXl2P3I59ksTUkQ=
```

If MantaPay ever changes the scheme, `npm test` fails instead of production
silently emitting links that get reply 500.

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

Verified by reading the code and running `node --test test/mantapay.test.js`
(34/34 pass). **Not** verified against the vendor spec — see §11.

### Money-affecting

**1. Inbound chargebacks are dropped.**
`parseWebhook` fully parses a chargeback and returns `status: 'chargeback'`.
`webhooks.routes.js:66` then matches only `approved` / `declined` and answers
`ignored: 'non_final_status'`. The ledger has `fn_post_chargeback` and
`POST /transactions/:txId/chargeback`, but only an operator can trigger it by
hand. The provider notification never reaches it.

**2. Attribution rests on an unconfirmed field name.**
We send our reference as `trans_refNum`. We read it back as `trans_order`, and
`payments.service.js:51` looks the link up by `reference_id = trans_order`.
Which request field actually populates `trans_order` is unconfirmed. If it is
any other name, every payment arrives unattributed — and the signature still
verifies, because an empty `trans_order` contributes nothing to the hash. The
status poll makes the same assumption via its `Order=` parameter.

**3. `resolveApiKey` falls back silently.**
`mantapay.js:33` — if a workspace has `provider_config_ref` set but that env
var is missing, it drops to the platform-wide `MANTAPAY_HASH_KEY` instead of
failing. A misconfigured tenant signs with the wrong merchant's key and gets
reply 500.

### Incomplete

**4. The Search API is dead code.**
`mantapay-search.js` is written and unit-tested, but nothing calls
`searchTransactions`. Per-transaction fees are the one thing MantaPay gives us
that the webhook does not, and we never fetch them. `getStatusById` is also
exported and uncalled.

**5. `refundPayment` argument mismatch.**
`payouts.routes.js:308` calls `provider.refundPayment(apiKey, paymentRequestId,
amount)`; the adapter takes no parameters and always throws. Harmless while
refunds are disabled, but the call site encodes a signature that does not
exist.

**6. Two unused order constants.**
`HOSTED_FIELD_ORDER_REQUEST` / `HOSTED_FIELD_ORDER_JS` in
`mantapay-signature.js` use lowercase `client_billaddress1`, while
`mantapay-checkout.js` uses `client_billAddress1`. Checkout always passes its
own explicit order, so the defaults are never used — but they would be wrong if
anything did use them.

---

## 10. Questions for MantaPay

Unconfirmed points, flagged inline in the code. Worth sending back to them.

1. **Which request field populates `trans_order` in the notification?**
   We send `trans_refNum`. See open issue 2 — this one is load-bearing.
2. **Does the notification's `trans_amount` include the `EC` surcharge, or only
   the base amount?** Their worked example (100 + 100 + 10 = 210) shows extras
   are added on top of `trans_amount` in the request, but says nothing about the
   reply.
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

`OPEN-QUESTIONS-MANTAPAY.md` is referenced twice in `mantapay.js`. It has never
existed in this repository. §10 replaces it — update the two comments to point
here.
