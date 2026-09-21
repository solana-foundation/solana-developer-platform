UPDATE counterparty_provider_accounts cpa
SET status = 'archived',
    metadata = '{}'::jsonb,
    updated_at = sdp_iso_now()
FROM projects prj
WHERE prj.id = cpa.project_id
  AND prj.environment = 'sandbox'
  AND cpa.provider = 'bvnk'
  AND cpa.kind = 'funding_wallet'
  AND cpa.status = 'active';

UPDATE counterparty_provider_accounts cpa
SET status = 'archived',
    updated_at = sdp_iso_now()
WHERE cpa.kind = 'funding_wallet'
  AND cpa.status = 'active'
  AND EXISTS (
    SELECT 1
    FROM counterparty_provider_accounts newer
    WHERE newer.kind = 'funding_wallet'
      AND newer.status = 'active'
      AND newer.counterparty_id = cpa.counterparty_id
      AND newer.provider = cpa.provider
      AND newer.fiat_currency = cpa.fiat_currency
      AND (newer.updated_at > cpa.updated_at
        OR (newer.updated_at = cpa.updated_at AND newer.id > cpa.id))
  );

DROP INDEX counterparty_provider_accounts_active_funding_wallet_unique;
CREATE UNIQUE INDEX counterparty_provider_accounts_active_funding_wallet_unique
    ON counterparty_provider_accounts(counterparty_id, provider, fiat_currency)
    WHERE status = 'active' AND kind = 'funding_wallet';
