-- The counterparty PII encryption rollout is retired: no environment ever
-- advanced past dual_write, so the plaintext columns are authoritative and
-- the ciphertext columns are safe to drop. The migration state table follows
-- once counterparty_accounts stops reading the phase.
ALTER TABLE counterparties DROP COLUMN pii_encrypted;
ALTER TABLE counterparties DROP COLUMN provider_data_encrypted;
