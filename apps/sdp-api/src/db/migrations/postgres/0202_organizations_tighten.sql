-- sdp:migration-compat: breaking
-- sdp:migration-locks: blocking
-- Runs after the database reset, so organizations is empty and every lock here is momentary.
-- Nothing reads the onboarding columns; slug lookups use organizations_slug_key, and nothing filters on status alone.
ALTER TABLE organizations
  DROP COLUMN IF EXISTS onboarding_completed_at,
  DROP COLUMN IF EXISTS onboarding_version,
  ADD CONSTRAINT organizations_status_check
    CHECK (status IN ('provisioning', 'active', 'suspended', 'deleted'));

DROP INDEX IF EXISTS idx_organizations_slug;
DROP INDEX IF EXISTS idx_organizations_status;
