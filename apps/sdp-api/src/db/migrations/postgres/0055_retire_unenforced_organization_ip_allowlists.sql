-- `settings.allowedIpAddresses` was stored but never read, so pre-existing
-- values were never validated and never decided access. Enforcement starts
-- now; applying them retroactively could lock an organization out of its API
-- and dashboard at once, unrecoverable through the API (the restriction covers
-- the endpoint that edits it). Values are parked as legacyAllowedIpAddresses
-- rather than deleted — re-applying one is a single, now-validated PATCH.
DO $$
DECLARE
  organization_id TEXT;
  raw_settings TEXT;
  parsed_settings JSONB;
  moved_count INTEGER := 0;
BEGIN
  FOR organization_id, raw_settings IN
    SELECT id, settings
      FROM organizations
     WHERE settings LIKE '%allowedIpAddresses%'
  LOOP
    BEGIN
      parsed_settings := raw_settings::jsonb;
    EXCEPTION
      WHEN others THEN
        -- Nothing readable to move; enforcement reads such a blob as
        -- unrestricted, so the row stays as it is.
        RAISE WARNING 'organization % has unparseable settings; left untouched', organization_id;
        CONTINUE;
    END;

    IF parsed_settings ? 'allowedIpAddresses' THEN
      UPDATE organizations
         SET settings = (
               (parsed_settings - 'allowedIpAddresses')
               || jsonb_build_object(
                    'legacyAllowedIpAddresses',
                    parsed_settings -> 'allowedIpAddresses'
                  )
             )::text,
             updated_at = sdp_datetime_now()
       WHERE id = organization_id;

      moved_count := moved_count + 1;
      RAISE NOTICE 'organization %: retired unenforced allowedIpAddresses %',
        organization_id, parsed_settings -> 'allowedIpAddresses';
    END IF;
  END LOOP;

  RAISE NOTICE 'retired unenforced allowedIpAddresses on % organization(s)', moved_count;
END $$;
