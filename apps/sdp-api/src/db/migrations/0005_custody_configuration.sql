-- Custody Configuration Migration
-- Adds tables for custody provider configurations and async signing request tracking

-- ═══════════════════════════════════════════════════════════════════════════
-- Custody Provider Configurations
-- ═══════════════════════════════════════════════════════════════════════════

-- Stores custody provider configuration for organizations and projects
-- Config hierarchy: project-specific → org-level → env fallback
CREATE TABLE custody_configs (
    id TEXT PRIMARY KEY,                    -- cust_xxxxxxxxxxxx
    organization_id TEXT NOT NULL,
    project_id TEXT,                        -- NULL = org-level default
    provider TEXT NOT NULL,                 -- 'local', 'fireblocks', 'dfns', 'turnkey'
    config TEXT NOT NULL,                   -- Encrypted JSON config (provider-specific)
    default_wallet_id TEXT,                 -- Default wallet for operations
    status TEXT NOT NULL DEFAULT 'active',  -- 'active', 'inactive'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,

    -- Only one active config per org/project combination
    UNIQUE(organization_id, project_id)
);

-- Index for fast lookups by org and project
CREATE INDEX idx_custody_configs_org ON custody_configs(organization_id);
CREATE INDEX idx_custody_configs_project ON custody_configs(organization_id, project_id);
CREATE INDEX idx_custody_configs_status ON custody_configs(status);

-- ═══════════════════════════════════════════════════════════════════════════
-- Async Signing Request Tracking
-- ═══════════════════════════════════════════════════════════════════════════

-- Tracks async signing requests for providers that require approval workflows
-- (e.g., Fireblocks with policy approvals, Dfns with MFA)
CREATE TABLE signing_requests (
    id TEXT PRIMARY KEY,                    -- sig_xxxxxxxxxxxx
    organization_id TEXT NOT NULL,
    custody_config_id TEXT NOT NULL,        -- Reference to custody config used
    token_transaction_id TEXT,              -- Link to token_transactions if applicable
    external_request_id TEXT,               -- Provider's request ID for correlation
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'completed', 'rejected', 'failed'
    transaction_message TEXT NOT NULL,      -- Base64 encoded unsigned transaction
    signatures TEXT,                        -- JSON array of {publicKey, signature}
    metadata TEXT,                          -- JSON metadata (operation type, amount, etc.)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (custody_config_id) REFERENCES custody_configs(id) ON DELETE SET NULL,
    FOREIGN KEY (token_transaction_id) REFERENCES token_transactions(id) ON DELETE SET NULL
);

-- Index for status-based queries (polling pending requests)
CREATE INDEX idx_signing_requests_status ON signing_requests(status);

-- Index for external ID lookups (webhook correlation)
CREATE INDEX idx_signing_requests_external ON signing_requests(external_request_id);

-- Index for org-based queries
CREATE INDEX idx_signing_requests_org ON signing_requests(organization_id);

-- Index for finding requests by token transaction
CREATE INDEX idx_signing_requests_token_tx ON signing_requests(token_transaction_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- Custody Wallets (for providers that manage multiple wallets)
-- ═══════════════════════════════════════════════════════════════════════════

-- Tracks wallets managed by custody providers for each org/project
-- This is optional - some providers (like local keypair) don't use this
CREATE TABLE custody_wallets (
    id TEXT PRIMARY KEY,                    -- cwlt_xxxxxxxxxxxx
    custody_config_id TEXT NOT NULL,
    wallet_id TEXT NOT NULL,                -- Provider's wallet identifier
    public_key TEXT NOT NULL,               -- Solana public key
    label TEXT,                             -- Human-readable label
    purpose TEXT,                           -- 'mint_authority', 'freeze_authority', 'fee_payer', etc.
    status TEXT NOT NULL DEFAULT 'active',  -- 'active', 'inactive'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (custody_config_id) REFERENCES custody_configs(id) ON DELETE CASCADE,

    -- Each wallet ID should be unique within a custody config
    UNIQUE(custody_config_id, wallet_id)
);

CREATE INDEX idx_custody_wallets_config ON custody_wallets(custody_config_id);
CREATE INDEX idx_custody_wallets_public_key ON custody_wallets(public_key);
