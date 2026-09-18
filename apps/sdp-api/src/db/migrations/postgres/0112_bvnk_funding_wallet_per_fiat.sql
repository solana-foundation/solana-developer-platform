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

DROP INDEX counterparty_provider_accounts_active_funding_wallet_unique;
CREATE UNIQUE INDEX counterparty_provider_accounts_active_funding_wallet_unique
    ON counterparty_provider_accounts(counterparty_id, provider, fiat_currency)
    WHERE status = 'active' AND kind = 'funding_wallet';
