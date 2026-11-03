-- Incident restoration uses a dedicated revision, independent of profile edits.
-- Additive: the previous API revision can continue serving during migration.
ALTER TABLE organizations
    ADD COLUMN status_control_version INTEGER NOT NULL DEFAULT 0;
