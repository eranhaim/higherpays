-- Rates belong to each creator and chatter. New rows must provide them.
ALTER TABLE accounts ALTER COLUMN revenue_split_pct DROP DEFAULT;
ALTER TABLE agents ALTER COLUMN commission_pct DROP DEFAULT;
