ALTER TABLE counterparty_provider_accounts
    ADD COLUMN payment_rail TEXT;

DROP INDEX counterparty_provider_accounts_active_corridor_unique;

CREATE INDEX counterparty_provider_accounts_active_corridor_idx
    ON counterparty_provider_accounts(
        counterparty_id,
        provider,
        fiat_currency,
        destination_country
    )
    WHERE status = 'active' AND fiat_currency IS NOT NULL;
