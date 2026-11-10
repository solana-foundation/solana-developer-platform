-- HOO-2303: mark invitations after approved age-based PII scrubbing.
-- Nullable so the previous image keeps serving during migration.
ALTER TABLE invitations ADD COLUMN pii_pseudonymized_at TEXT;
