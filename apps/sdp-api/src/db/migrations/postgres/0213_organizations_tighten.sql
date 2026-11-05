-- sdp:migration-compat: breaking
-- sdp:migration-locks: blocking
-- Runs after the database reset, so organizations is empty and every lock here is momentary.
-- Nothing reads the onboarding columns; slug lookups use organizations_slug_key, and nothing filters on status alone.
-- Every organization has its creator (create.ts is the only insert), which also keeps a NULL creator from
-- escaping idx_organizations_one_created_per_user. Its predicate and the ON CONFLICT arbiter stay as they are.
ALTER TABLE organizations
  DROP COLUMN IF EXISTS onboarding_completed_at,
  DROP COLUMN IF EXISTS onboarding_version,
  ALTER COLUMN created_by_user_id SET NOT NULL,
  ADD CONSTRAINT organizations_status_check
    CHECK (status IN ('provisioning', 'active', 'suspended', 'deleted'));

DROP INDEX IF EXISTS idx_organizations_slug;
DROP INDEX IF EXISTS idx_organizations_status;
