UPDATE counterparty_provider_accounts
SET
  metadata = CASE
    WHEN metadata ? 'status' THEN metadata - 'agreements'
    ELSE metadata
  END,
  status = CASE
    WHEN metadata ? 'status' THEN status
    ELSE 'archived'
  END
WHERE provider = 'bvnk'
  AND metadata ? 'agreements'
  AND jsonb_typeof(metadata -> 'agreements') = 'object'
  AND jsonb_typeof(metadata -> 'agreements' -> 'entries') = 'object'
  AND EXISTS (
    SELECT 1
    FROM jsonb_each(metadata -> 'agreements' -> 'entries') AS entry(key, value)
    WHERE NOT (entry.value ? 'name')
      OR jsonb_typeof(entry.value -> 'name') IS DISTINCT FROM 'string'
      OR NOT (entry.value ? 'description')
      OR jsonb_typeof(entry.value -> 'description') IS DISTINCT FROM 'string'
  );
