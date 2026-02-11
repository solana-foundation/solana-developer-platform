CREATE TABLE payment_wallet_policies (
    id TEXT PRIMARY KEY,
    custody_wallet_id TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL DEFAULT 'none',
    destination_allowlist TEXT NOT NULL DEFAULT '[]',
    max_transfer_amount TEXT,
    max_daily_amount TEXT,
    created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id) ON DELETE CASCADE
);
CREATE INDEX idx_payment_wallet_policies_wallet ON payment_wallet_policies(custody_wallet_id);
