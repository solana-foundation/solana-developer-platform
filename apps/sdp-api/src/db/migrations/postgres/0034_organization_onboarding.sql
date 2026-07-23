ALTER TABLE organizations
  ADD COLUMN onboarding_completed_at TEXT;

ALTER TABLE organizations
  ADD COLUMN onboarding_version INTEGER NOT NULL DEFAULT 1;

-- Existing organizations predate the guided setup and must keep their current
-- dashboard behavior. Organizations created after this migration remain null.
UPDATE organizations
SET onboarding_completed_at = sdp_datetime_now()
WHERE onboarding_completed_at IS NULL;
