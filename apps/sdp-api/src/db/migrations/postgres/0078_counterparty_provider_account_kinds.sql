ALTER TABLE counterparty_provider_accounts
    ADD COLUMN kind TEXT;

UPDATE counterparty_provider_accounts
SET kind = CASE WHEN fiat_currency IS NULL THEN 'customer_link' ELSE 'payout_account' END;

ALTER TABLE counterparty_provider_accounts
    ALTER COLUMN kind SET NOT NULL,
    ADD CONSTRAINT counterparty_provider_accounts_kind_check
        CHECK (kind IN ('customer_link', 'payout_account', 'funding_wallet', 'merchant_wallet')),
    DROP CONSTRAINT counterparty_provider_accounts_corridor_completeness_check,
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
            OR (kind IN ('funding_wallet', 'merchant_wallet')
                AND fiat_currency IS NOT NULL
                AND destination_country IS NULL)
        );

DROP INDEX counterparty_provider_accounts_customer_unique;
CREATE UNIQUE INDEX counterparty_provider_accounts_customer_unique
    ON counterparty_provider_accounts(counterparty_id, provider)
    WHERE kind = 'customer_link';

DROP INDEX counterparty_provider_accounts_active_corridor_idx;
CREATE INDEX counterparty_provider_accounts_active_corridor_idx
    ON counterparty_provider_accounts(
        counterparty_id,
        provider,
        fiat_currency,
        destination_country
    )
    WHERE status = 'active' AND kind = 'payout_account';

DROP INDEX counterparty_provider_accounts_pending_reservation_unique;
CREATE UNIQUE INDEX counterparty_provider_accounts_pending_reservation_unique
    ON counterparty_provider_accounts(
        counterparty_id,
        provider,
        fiat_currency,
        destination_country,
        payment_rail
    )
    WHERE status = 'active'
      AND kind = 'payout_account'
      AND external_account_reference IS NULL
      AND payment_rail IS NOT NULL;

CREATE UNIQUE INDEX counterparty_provider_accounts_active_merchant_wallet_unique
    ON counterparty_provider_accounts(counterparty_id, provider, fiat_currency)
    WHERE status = 'active' AND kind = 'merchant_wallet';

CREATE UNIQUE INDEX counterparty_provider_accounts_active_funding_wallet_unique
    ON counterparty_provider_accounts(counterparty_id, provider, (metadata->>'onrampKey'))
    WHERE status = 'active' AND kind = 'funding_wallet';

UPDATE counterparties
SET provider_data = provider_data - 'bvnk'
WHERE provider_data ? 'bvnk';

DROP INDEX IF EXISTS idx_counterparties_bvnk_customer_reference_active;
DROP INDEX IF EXISTS idx_counterparties_bvnk_customer_reference_denormalized_active;
DROP INDEX IF EXISTS idx_counterparties_bvnk_customer_reference;
ALTER TABLE counterparties DROP COLUMN bvnk_customer_reference;
