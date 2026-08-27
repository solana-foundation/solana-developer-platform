-- Retires the counterparty PII encryption rollout. No environment ever advanced
-- past dual_write, the plaintext columns are authoritative, and as of this
-- release no code references the ciphertext columns or the state table.
ALTER TABLE counterparties DROP COLUMN pii_encrypted;
ALTER TABLE counterparties DROP COLUMN provider_data_encrypted;
ALTER TABLE counterparty_accounts DROP COLUMN sensitive_data_encrypted;
DROP TABLE counterparty_pii_migration_state;
