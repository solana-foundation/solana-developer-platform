ALTER TABLE payment_transfers
    ADD COLUMN IF NOT EXISTS ramps_memo JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_constraint
        WHERE  conname = 'payment_transfers_ramps_memo_is_object'
    ) THEN
        ALTER TABLE payment_transfers
            ADD CONSTRAINT payment_transfers_ramps_memo_is_object
            CHECK (jsonb_typeof(ramps_memo) = 'object');
    END IF;
END $$;
