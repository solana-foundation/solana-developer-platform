-- Organizations present when open signup launches were already approved for
-- production access. Preserve that entitlement and keep them out of the new
-- organization setup flow. Organizations created after this migration retain
-- the normal tier and onboarding defaults.
UPDATE organizations
SET tier = 'enterprise',
    onboarding_completed_at = COALESCE(onboarding_completed_at, sdp_datetime_now()),
    updated_at = sdp_datetime_now()
WHERE tier <> 'enterprise'
   OR onboarding_completed_at IS NULL;
