-- Whether a request was served by a private credential (ADR 0023): its traffic belongs to the credential's owner, so
-- org-wide summaries, series, listings and exports leave it out, and only its owner reads it. `0` for every record
-- written before private credentials existed (every credential was shared then), and for shared credentials.
ALTER TABLE usage_records ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
