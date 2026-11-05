-- sdp:migration-compat: breaking
-- Nothing reads or writes the organization tier any more; provider access comes from settings.providerOverrides.
ALTER TABLE organizations DROP COLUMN IF EXISTS tier;
