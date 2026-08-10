-- `settings.allowedIpAddresses` was accepted, stored and documented, but never
-- read by any authentication path — so every value written before this release
-- was recorded without validation and without ever deciding an access outcome.
-- Enforcement starts now, and retroactively applying an unvalidated list is how
-- an organization loses access to its own API and dashboard at the same moment,
-- with no route left to undo it: the restriction covers the endpoint that edits
-- the restriction, so recovery would take direct database access.
--
-- The values are moved aside rather than deleted, so nothing an operator wrote
-- is lost. Re-applying one is a single PATCH, which now validates the entries,
-- stores them canonically, and refuses a list that would exclude the caller.
--
-- After this runs, the only writer of the enforced key is that validated
-- endpoint, so a malformed allowlist cannot reach the fail-closed path from
-- history — only from a bug, which is what failing closed is there to catch.
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
        -- Unparseable settings hold no readable configuration, so there is
        -- nothing here to move. The enforcement treats such a blob as carrying
        -- no restriction, matching how the rest of the application already
        -- reads this column, so the row is left exactly as it is.
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
