CREATE TABLE payment_wallet_policies (
    id TEXT PRIMARY KEY,
    custody_wallet_id TEXT NOT NULL,
    policy_type TEXT NOT NULL,
    policy TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id) ON DELETE CASCADE,
    UNIQUE (custody_wallet_id, policy_type)
);
CREATE INDEX idx_payment_wallet_policies_wallet ON payment_wallet_policies(custody_wallet_id);
