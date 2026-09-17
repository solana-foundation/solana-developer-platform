DELETE FROM counterparty_provider_accounts WHERE provider = 'bvnk' AND kind = 'funding_wallet';

UPDATE counterparty_provider_accounts SET kind = 'virtual_funding_wallet' WHERE kind = 'funding_wallet';

ALTER TABLE counterparty_provider_accounts
    DROP CONSTRAINT counterparty_provider_accounts_kind_check,
    ADD CONSTRAINT counterparty_provider_accounts_kind_check
        CHECK (kind IN ('customer_link', 'payout_account', 'virtual_funding_wallet', 'merchant_wallet'));

ALTER TABLE counterparty_provider_accounts
    DROP CONSTRAINT counterparty_provider_accounts_kind_shape_check,
    ADD CONSTRAINT counterparty_provider_accounts_kind_shape_check
        CHECK (
            (kind = 'customer_link'
                AND fiat_currency IS NULL
                AND destination_country IS NULL
                AND external_account_reference IS NULL
                AND payment_rail IS NULL)
            OR (kind = 'payout_account'
                AND fiat_currency IS NOT NULL
                AND destination_country IS NOT NULL)
            OR (kind IN ('virtual_funding_wallet', 'merchant_wallet')
                AND fiat_currency IS NOT NULL
                AND destination_country IS NULL)
        );

DROP INDEX IF EXISTS counterparty_provider_accounts_active_funding_wallet_unique;

CREATE UNIQUE INDEX counterparty_provider_accounts_active_virtual_funding_wallet_unique
    ON counterparty_provider_accounts(counterparty_id, provider, fiat_currency)
    WHERE status = 'active' AND kind = 'virtual_funding_wallet';
