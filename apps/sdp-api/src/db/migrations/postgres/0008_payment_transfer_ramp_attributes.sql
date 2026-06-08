ALTER TABLE payment_transfers
    ADD COLUMN IF NOT EXISTS counterparty_id TEXT,
    ADD COLUMN IF NOT EXISTS provider TEXT,
    ADD COLUMN IF NOT EXISTS provider_reference TEXT,
    ADD COLUMN IF NOT EXISTS delivery_mode TEXT,
    ADD COLUMN IF NOT EXISTS fiat_currency TEXT,
    ADD COLUMN IF NOT EXISTS fiat_amount TEXT,
    ADD COLUMN IF NOT EXISTS provider_data JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE payment_transfers
    ALTER COLUMN source_address DROP NOT NULL,
    ALTER COLUMN destination_address DROP NOT NULL,
    ALTER COLUMN amount DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_constraint
        WHERE  conname = 'payment_transfers_provider_data_is_object'
    ) THEN
        ALTER TABLE payment_transfers
            ADD CONSTRAINT payment_transfers_provider_data_is_object
            CHECK (jsonb_typeof(provider_data) = 'object');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_constraint
        WHERE  conname = 'payment_transfers_delivery_mode_check'
    ) THEN
        ALTER TABLE payment_transfers
            ADD CONSTRAINT payment_transfers_delivery_mode_check
            CHECK (delivery_mode IS NULL OR delivery_mode IN ('hosted', 'manual_instructions'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_constraint
        WHERE  conname = 'payment_transfers_counterparty_scope_fkey'
    ) THEN
        ALTER TABLE payment_transfers
            ADD CONSTRAINT payment_transfers_counterparty_scope_fkey
            FOREIGN KEY (counterparty_id, organization_id, project_id)
            REFERENCES counterparties(id, organization_id, project_id);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_transfers_provider_reference
    ON payment_transfers(provider, provider_reference)
    WHERE provider IS NOT NULL AND provider_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_transfers_counterparty_created
    ON payment_transfers(counterparty_id, created_at DESC)
    WHERE counterparty_id IS NOT NULL;
