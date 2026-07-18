-- Supports the dashboard's database-backed transaction ledger without adding
-- indexes for every optional low-cardinality filter. Project/date,
-- counterparty/date, and provider-reference access already have indexes.

CREATE INDEX IF NOT EXISTS idx_payment_transfers_project_status_created_id
    ON payment_transfers(project_id, status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_payment_transfers_project_wallet_created_id
    ON payment_transfers(project_id, wallet_id, created_at DESC, id DESC);
