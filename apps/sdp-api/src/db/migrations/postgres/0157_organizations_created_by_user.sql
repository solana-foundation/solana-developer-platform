-- The person who created an organization (HOO-2221, ADR 0012). SDP creates every organization
-- and records its creator; a person may create at most one (0158). Nullable until the
-- membership reset: existing rows have no recorded creator, and the legacy Clerk-driven
-- provisioning path inserts organizations without one. A later migration sets NOT NULL.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS created_by_user_id TEXT REFERENCES users(id);
