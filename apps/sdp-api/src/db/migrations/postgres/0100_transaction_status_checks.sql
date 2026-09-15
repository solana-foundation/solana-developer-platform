ALTER TABLE payment_transfers
    ADD CONSTRAINT payment_transfers_status_check
    CHECK (status IN ('pending', 'processing', 'awaiting_payment', 'settling', 'confirmed', 'finalized', 'completed', 'failed', 'canceled', 'expired'));

ALTER TABLE issuance_transactions
    ADD CONSTRAINT issuance_transactions_status_check
    CHECK (status IN ('pending', 'processing', 'confirmed', 'finalized', 'failed'));
