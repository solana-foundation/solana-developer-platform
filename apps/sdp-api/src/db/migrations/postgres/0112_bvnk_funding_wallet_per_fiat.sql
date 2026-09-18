UPDATE counterparty_provider_accounts
SET status = 'archived',
    metadata = '{}'::jsonb,
    updated_at = sdp_iso_now()
WHERE kind = 'funding_wallet'
  AND status = 'active';

DROP INDEX counterparty_provider_accounts_active_funding_wallet_unique;
CREATE UNIQUE INDEX counterparty_provider_accounts_active_funding_wallet_unique
    ON counterparty_provider_accounts(counterparty_id, provider, fiat_currency)
    WHERE status = 'active' AND kind = 'funding_wallet';
