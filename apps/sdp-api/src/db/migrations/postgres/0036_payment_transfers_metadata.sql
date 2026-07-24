ALTER TABLE payment_transfers
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_constraint
        WHERE  conname = 'payment_transfers_metadata_is_object'
    ) THEN
        ALTER TABLE payment_transfers
            ADD CONSTRAINT payment_transfers_metadata_is_object
            CHECK (jsonb_typeof(metadata) = 'object');
    END IF;
END $$;
