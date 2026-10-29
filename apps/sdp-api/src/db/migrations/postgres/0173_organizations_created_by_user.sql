-- The person who created an organization (HOO-2221, ADR 0012). SDP creates every organization
-- and records its creator; a person may create at most one (0174). Nullable until the
-- membership reset: existing rows have no recorded creator, and the legacy Clerk-driven
-- provisioning path inserts organizations without one. A later migration sets NOT NULL.
-- The foreign key is added NOT VALID so it takes no blocking scan of organizations; 0175
-- validates it.
ALTER TABLE organizations
    ADD COLUMN created_by_user_id TEXT;

ALTER TABLE organizations
    ADD CONSTRAINT organizations_created_by_user_id_fkey
    FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    NOT VALID;
