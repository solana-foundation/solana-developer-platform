ALTER TABLE counterparty_provider_accounts
    DROP CONSTRAINT counterparty_provider_accounts_counterparty_provider_unique,
    ADD COLUMN external_account_reference TEXT,
    ADD COLUMN fiat_currency TEXT,
    ADD COLUMN destination_country TEXT,
    ADD COLUMN provider_status TEXT,
    ADD CONSTRAINT counterparty_provider_accounts_corridor_completeness_check
        CHECK ((fiat_currency IS NULL) = (destination_country IS NULL));

CREATE UNIQUE INDEX counterparty_provider_accounts_customer_unique
    ON counterparty_provider_accounts(counterparty_id, provider)
    WHERE fiat_currency IS NULL;

CREATE UNIQUE INDEX counterparty_provider_accounts_active_corridor_unique
    ON counterparty_provider_accounts(
        counterparty_id,
        provider,
        fiat_currency,
        destination_country
    )
    WHERE status = 'active' AND fiat_currency IS NOT NULL;
