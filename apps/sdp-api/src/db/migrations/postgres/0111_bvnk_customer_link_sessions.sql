UPDATE counterparty_provider_accounts
SET
  status = CASE
    WHEN metadata ? 'status' OR metadata ? 'session' THEN status
    ELSE 'archived'
  END,
  metadata = CASE
    WHEN metadata ? 'agreements' THEN metadata - 'agreements'
    ELSE metadata
  END
WHERE provider = 'bvnk'
  AND kind = 'customer_link'
  AND (
    NOT (metadata ? 'status' OR metadata ? 'session')
    OR metadata ? 'agreements'
  );
