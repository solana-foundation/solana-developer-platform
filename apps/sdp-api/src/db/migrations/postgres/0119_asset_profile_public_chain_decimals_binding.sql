-- SOLA9-439 remediation (data triage): the cached public_metadata projection of
-- asset_profiles used to copy the caller-supplied issuance_metadata
-- chain.decimals verbatim, so a profile could publicly advertise a unit scale
-- that disagrees with the token row every deployment and accounting path uses.
-- The projection is now derived from issued_tokens.decimals at the application
-- layer on every create/update; this heals rows cached before that fix.
--
-- Only present-but-divergent chain.decimals values are corrected. The old
-- semantics omitted the path when the metadata lacked it, and absence is not a
-- wrong served scale, so this stays strictly corrective.
UPDATE asset_profiles AS profile
SET public_metadata = jsonb_set(
        profile.public_metadata,
        '{chain,decimals}',
        to_jsonb(token.decimals)
    ),
    updated_at = sdp_iso_now()
FROM issued_tokens AS token
WHERE token.id = profile.token_id
  AND jsonb_typeof(profile.public_metadata) = 'object'
  AND jsonb_typeof(profile.public_metadata->'chain') = 'object'
  AND profile.public_metadata->'chain' ? 'decimals'
  AND profile.public_metadata->'chain'->>'decimals' IS DISTINCT FROM token.decimals::text;
