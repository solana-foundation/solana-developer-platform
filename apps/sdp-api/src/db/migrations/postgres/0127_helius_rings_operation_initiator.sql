-- Who started a Rings operation (HOO-1889). Payments and issuance record the
-- API key that initiated a transfer or a transaction. Rings recorded it only on
-- the wallet_operations row, which the removal of the policy engine retires, so
-- nothing answered "which key moved this". NULL for an operation started from a
-- dashboard session and for every row that predates this column. Bare TEXT with
-- no foreign key, like `payment_transfers.initiated_by_key_id`, so deleting a
-- key never touches the history it left.
ALTER TABLE helius_rings_operations ADD COLUMN IF NOT EXISTS initiated_by_key_id TEXT;
