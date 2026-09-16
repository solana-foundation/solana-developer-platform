ALTER TABLE payment_transfers
    VALIDATE CONSTRAINT payment_transfers_status_check;

ALTER TABLE issuance_transactions
    VALIDATE CONSTRAINT issuance_transactions_status_check;
