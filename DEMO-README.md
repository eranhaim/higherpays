# HigherPays — demo

A local demo with two agencies already set up. No real money and no real
provider: payments are simulated with a signed webhook, exactly as MantaPay
would send one.

## Start

```bash
docker compose up -d
```

Open **http://localhost:8083**. Password for every login below is
`change-me-please` (set by `SEED_PASSWORD`).

## Who you can sign in as

| Login | Role | Sees |
|---|---|---|
| `admin@acme.test` | Admin | Everything in Acme |
| `analyst@acme.test` | Analyst | Everything in Acme, read-only, no fee breakdown |
| `dayagent@acme.test` | Chatter | Only the creators they work and their own links and payments |
| `luna@acme.test` | Creator owner | Only her own account and earnings |
| `admin@northstar.test` | Admin | Everything in Northstar |
| `platform@higherpays.test` | Platform admin | Every agency, plus the Platform page |
| `finance@higherpays.test` | Analyst in both | The same person in two agencies — use the workspace picker |

The two agencies deliberately differ, so anything hardcoded to one breaks
visibly:

|  | Acme Agency | Northstar Media |
|---|---|---|
| currency | EUR | USD |
| calls accounts | **Creators** | **Talent** |
| calls agents | **Chatters** | **Closers** |
| fees | cascade: 7% MDR + €0.50 + 1% settle, 5% margin | flat: 6.5% + $0.30, 3% margin |
| split | 70 / 22 / 8 | 60 / 30 / 10 |

## The walkthrough

Sign in as `dayagent@acme.test`.

1. **Payment links → New link.** Pick Luna, single use, €120. The fee panel
   shows what the agency keeps before you commit. Create it and copy the URL.
   - *Single use* dies on the first payment, or after 24h unpaid.
   - *Reusable* stays open through many payments until cancelled.

2. **Pay it.** Nobody is going to type a card number, so simulate the
   provider's callback. Take the `Ref` from the links table:

   ```bash
   cd backend
   node scripts/demo-pay.js ord_ab12cd34            # paid
   node scripts/demo-pay.js ord_ab12cd34 --decline  # declined
   ```

   The link moves to **Paid — details needed**. A declined attempt leaves a
   link active so the customer can try again.

   An agent is limited to one new link every 30 seconds, so a second click
   comes back as *rate limited* — that is the guardrail working, not a bug.

3. **Payments.** The payment is waiting. Open it → *Complete details*: type a
   customer name and a Telegram name, pick a category. That is the agent's job
   after every sale, and it is what closes the link to **Done**.

4. **Look at the same data as someone else.** Sign in as `admin@acme.test`:
   Payouts now shows what Luna and the chatter are owed, the cash position
   after MantaPay's rolling reserve, and Analytics has a sale in it. The agent
   never saw the platform fee; the admin does.

Then sign in as `luna@acme.test` and see how little an account owner gets —
her own payments and earnings, no agency figures, no other creators.

## Reset it

```bash
docker exec higherpays-pg psql -U postgres -c "DROP DATABASE higherpays;" -c "CREATE DATABASE higherpays;"
docker compose restart backend      # re-runs the migrations
docker exec higherpays-api node src/util/seed.js
```

Re-granting `hp_app` is only needed if you also recreate the role — see
`backend/README.md`.

## What is real and what is not

Real: the schema, the permission model, the revenue split (exact NUMERIC in
Postgres), the webhook signature check, idempotency, the audit log.

Not real: the payment itself. `demo-pay.js` signs a notification with the
workspace's own hash key and posts it to the webhook, so the server cannot
tell it from MantaPay — but no card is charged and no money moves. Refunds are
record-only in production too: the app records a refund issued in MantaPay's
dashboard, it never calls a refund API.



## demo payment
Test Cards
Only the following credit card number are allowed while in test environment:

Card Number	Issuer

4580000000000000	VISA (IL)
5326140000000000	MasterCard (IL)
91000000	IsraCard (IL)

* Use any future expiry date with these test cards.
** For other credit card types, pass any three digits as CVV2.