-- Extend payment_transfers to also record onramp/offramp ("ramp") activity so a
-- single table backs both wallet transaction history and counterparty
-- transaction history.
--
-- A ramp always has a wallet on our side: an offramp's crypto leaves our wallet
-- (source_address set, destination is fiat) and an onramp's crypto lands in our
-- wallet (destination_address set, source is fiat). So wallet_id stays NOT NULL;
-- only the fiat-side address can be absent. The fiat leg is described by
-- counterparty_id + counterparty_account_id.
--
-- The existing `type` column is the row discriminator and is extended at the
-- application layer to 'transfer' | 'transfer_confidential' | 'onramp' |
-- 'offramp'. `direction` distinguishes onramp (inbound) from offramp (outbound).
-- No CHECK constraint exists on type/status, so new values need no migration.

ALTER TABLE payment_transfers ALTER COLUMN source_address DROP NOT NULL;
ALTER TABLE payment_transfers ALTER COLUMN destination_address DROP NOT NULL;

ALTER TABLE payment_transfers ADD COLUMN IF NOT EXISTS counterparty_id TEXT;
ALTER TABLE payment_transfers ADD COLUMN IF NOT EXISTS counterparty_account_id TEXT;
ALTER TABLE payment_transfers ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE payment_transfers ADD COLUMN IF NOT EXISTS provider_reference TEXT;
ALTER TABLE payment_transfers ADD COLUMN IF NOT EXISTS fiat_currency TEXT;
ALTER TABLE payment_transfers ADD COLUMN IF NOT EXISTS fiat_amount TEXT;
ALTER TABLE payment_transfers
    ADD COLUMN IF NOT EXISTS provider_data JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'payment_transfers_provider_data_is_object'
    ) THEN
        ALTER TABLE payment_transfers
            ADD CONSTRAINT payment_transfers_provider_data_is_object
            CHECK (jsonb_typeof(provider_data) = 'object');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_transfers_counterparty'
    ) THEN
        ALTER TABLE payment_transfers
            ADD CONSTRAINT fk_payment_transfers_counterparty
            FOREIGN KEY (counterparty_id) REFERENCES counterparties(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_transfers_counterparty_account'
    ) THEN
        ALTER TABLE payment_transfers
            ADD CONSTRAINT fk_payment_transfers_counterparty_account
            FOREIGN KEY (counterparty_account_id) REFERENCES counterparty_accounts(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Powers counterparty transaction history.
CREATE INDEX IF NOT EXISTS idx_payment_transfers_counterparty_created
    ON payment_transfers(counterparty_id, created_at DESC)
    WHERE counterparty_id IS NOT NULL;

-- Idempotent webhook reconciliation: ramps dedupe on the provider reference
-- (signature is on-chain only and NULL for ramps).
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_transfers_provider_reference
    ON payment_transfers(provider, provider_reference)
    WHERE provider_reference IS NOT NULL;
