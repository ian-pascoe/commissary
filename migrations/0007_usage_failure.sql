-- Zero data retention (ADR 0027): a usage record keeps a failed attempt's status code and the error's type and code,
-- never its body, which can echo prompt text. `fail_body` is cleared for every record written before this migration and
-- is never written again; the column stays (always NULL) so a Worker from before this change that still runs while the
-- migration is being applied can insert its records. Records written before this migration have no type or code.
ALTER TABLE usage_records ADD COLUMN fail_type TEXT;
ALTER TABLE usage_records ADD COLUMN fail_code TEXT;
UPDATE usage_records SET fail_body = NULL WHERE fail_body IS NOT NULL;
