ALTER TABLE payment_transfers
    DROP CONSTRAINT IF EXISTS payment_transfers_delivery_mode_check;

ALTER TABLE payment_transfers
    ADD CONSTRAINT payment_transfers_delivery_mode_check
    CHECK (delivery_mode IS NULL OR delivery_mode IN ('hosted', 'manual_instructions', 'session_widget'));
