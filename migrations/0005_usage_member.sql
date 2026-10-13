-- The org member who made each request (ADR 0022): a plain member reads only their own records, and an admin filters
-- and groups usage by member or team. `NULL` for records written before members existed, and for a request whose
-- caller was admitted without a member record (a platform admin who is no member of the org, or an unregistered
-- service token in an org with auto-join on); such records still carry the Access principal (`principal_id`).
ALTER TABLE usage_records ADD COLUMN member_id TEXT;
CREATE INDEX IF NOT EXISTS usage_records_org_member ON usage_records (org_id, member_id, requested_at);
