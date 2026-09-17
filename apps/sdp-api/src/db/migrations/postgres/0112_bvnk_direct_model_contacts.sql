DELETE FROM counterparty_provider_accounts WHERE kind = 'customer_link' AND provider = 'bvnk';
DROP INDEX IF EXISTS idx_counterparty_provider_accounts_bvnk_session_reference;
ALTER TABLE counterparty_provider_accounts ALTER COLUMN provider_customer_reference DROP NOT NULL;
