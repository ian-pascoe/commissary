-- The org of each usage record (ADR 0021): every usage query filters on it, so one org never reads another's history.
-- Records written before orgs existed belong to the org `global`, the default. The indexes lead with `org_id` for
-- the org-filtered range scans of the listing, summary, series and queue queries.
ALTER TABLE usage_records ADD COLUMN org_id TEXT NOT NULL DEFAULT 'global';
CREATE INDEX IF NOT EXISTS usage_records_org ON usage_records (org_id, requested_at);
CREATE INDEX IF NOT EXISTS usage_records_org_unexported ON usage_records (org_id, requested_at) WHERE exported_at IS NULL;
