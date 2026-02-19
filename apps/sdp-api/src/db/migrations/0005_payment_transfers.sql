CREATE TABLE payment_transfers (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    wallet_id TEXT NOT NULL,
    source_address TEXT NOT NULL,
    destination_address TEXT NOT NULL,
    token TEXT NOT NULL,
    amount TEXT NOT NULL,
    memo TEXT,
    type TEXT NOT NULL,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    signature TEXT UNIQUE,
    serialized_tx TEXT,
    slot INTEGER,
    block_time TEXT,
    fee INTEGER,
    error TEXT,
    initiated_by_key_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_payment_transfers_org_created ON payment_transfers(organization_id, created_at DESC);
CREATE INDEX idx_payment_transfers_project_created ON payment_transfers(project_id, created_at DESC);
CREATE INDEX idx_payment_transfers_wallet ON payment_transfers(wallet_id);
CREATE INDEX idx_payment_transfers_status ON payment_transfers(status);
