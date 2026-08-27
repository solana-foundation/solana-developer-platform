ALTER TABLE counterparties DROP COLUMN identity;
ALTER TABLE counterparties DROP COLUMN email;
DELETE FROM counterparty_accounts WHERE account_kind = 'bank_account';
