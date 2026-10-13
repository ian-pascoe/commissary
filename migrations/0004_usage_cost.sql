-- The cost of each usage record (ADR 0024): the attempt's token breakdown (the `acct_*` columns) priced at the model's
-- prices when the record was written, in micro-dollars (1 USD = 1,000,000). A later price change never rewrites it.
-- `unpriced` marks an attempt on a model that had no price (its `cost_micros` is 0). Records written before this
-- migration have no cost: `cost_micros` stays NULL, which sums as nothing, and they are not flagged unpriced (a price
-- override cannot cost them after the fact, so listing them as traffic to price would send an admin after nothing).
ALTER TABLE usage_records ADD COLUMN cost_micros INTEGER;
ALTER TABLE usage_records ADD COLUMN unpriced INTEGER NOT NULL DEFAULT 0;
-- The unpriced traffic of an org: the Usage page lists the models to give a price override.
CREATE INDEX IF NOT EXISTS usage_records_org_unpriced ON usage_records (org_id, requested_at) WHERE unpriced = 1;
