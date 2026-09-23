# Telegram Marketplace integration

HigherPays is the only MantaPay integration. The marketplace holds catalog,
order-line, entitlement, analytics, and Telegram delivery data, but has no
MantaPay merchant ID, hash key, webhook, or reconciliation credentials.

## One-time synthetic attribution setup

In the designated HigherPays workspace:

1. Create one active creator/account named `Marketplace`.
2. Create one active agent/chatter named `Marketplace`.
3. Assign that agent to the `Marketplace` account.
4. Configure its revenue split and platform fee as the marketplace business
   requires; every marketplace cart is attributed to this pair.
5. Set `MARKETPLACE_WORKSPACE_ID`, `MARKETPLACE_ACCOUNT_ID`, and
   `MARKETPLACE_AGENT_ID` to those UUIDs. Do not use catalog-creator accounts
   or agents for these values.

Generate a dedicated random marketplace API token and an independent random
HMAC event secret. Store only the SHA-256 hexadecimal API-token digest in
`MARKETPLACE_INTEGRATION_API_KEY_HASH`. Set `MARKETPLACE_WEBHOOK_URL` to the
marketplace's HTTPS `/api/integrations/higherpays/events` endpoint and use the
same HMAC value in the marketplace's `HIGHERPAYS_EVENT_SIGNING_SECRET`.

## Lifecycle

1. The marketplace creates a cart order and calls `POST
   /integrations/marketplace/orders` with an idempotent marketplace order ID,
   exact minor-unit amount, currency, and return URL.
2. HigherPays creates a single-use payment link against the synthetic account
   and agent, starts MantaPay only when the user opens that link, validates the
   provider callback, and posts the ledger entry.
3. HigherPays writes a durable signed-event outbox. It retries lifecycle
   delivery with exponential backoff until the marketplace acknowledges it.
4. The marketplace verifies the HMAC, timestamp, event id, amount, currency,
   order ID, and payment-link reference before granting/revoking entitlement.
   Duplicate events cannot cause another delivery. Its scheduled
   reconciliation uses HigherPays' authenticated order-status endpoint if an
   event was missed.

No real payment is initiated by creating a marketplace order. The hosted
payment page is contacted only after the customer follows the returned
checkout URL.
