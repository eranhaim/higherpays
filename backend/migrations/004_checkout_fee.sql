-- The checkout fee: a fixed amount the customer pays on top of the price the
-- creator set. It is HigherPays' own take, not the agency's — it never enters
-- the sale's gross, and it reaches the ledger as the transaction surcharge the
-- revenue engine already understands.
--
-- On the rate card so it is versioned like every other fee, and copied onto
-- each link so a later rate change cannot rewrite what a customer was charged.

ALTER TABLE platform_fee_rates ADD COLUMN checkout_fee numeric(14,2) NOT NULL DEFAULT 0
  CHECK (checkout_fee >= 0);

ALTER TABLE payment_links ADD COLUMN checkout_fee numeric(14,2) NOT NULL DEFAULT 0
  CHECK (checkout_fee >= 0);
