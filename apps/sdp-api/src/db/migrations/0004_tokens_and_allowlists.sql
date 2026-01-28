-- Tokens and Allowlists Schema
-- Migration: 0004_tokens_and_allowlists.sql

-- ═══════════════════════════════════════════════════════════════════════════
-- Tokens Table
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE tokens (
    id TEXT PRIMARY KEY,                          -- tok_xxxxxxxxxxxx
    project_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    mint_address TEXT UNIQUE,                     -- Solana pubkey (null until deployed)
    mint_authority TEXT,                          -- Authority for minting
    freeze_authority TEXT,                        -- Authority for freezing
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    decimals INTEGER NOT NULL DEFAULT 9,
    description TEXT,
    uri TEXT,                                     -- Metadata URI
    image_url TEXT,
    extensions TEXT,                              -- JSON: Token-2022 extensions config
    total_supply TEXT DEFAULT '0',                -- Current supply (as decimal string)
    max_supply TEXT,                              -- Max supply limit (null = unlimited)
    is_mintable INTEGER DEFAULT 1,
    is_freezable INTEGER DEFAULT 1,
    requires_allowlist INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',       -- pending, active, paused, revoked
    deployed_at TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX idx_tokens_project ON tokens(project_id);
CREATE INDEX idx_tokens_org ON tokens(organization_id);
CREATE INDEX idx_tokens_mint ON tokens(mint_address);
CREATE INDEX idx_tokens_status ON tokens(status);

-- ═══════════════════════════════════════════════════════════════════════════
-- Token Transactions (mint, burn, freeze operations)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE token_transactions (
    id TEXT PRIMARY KEY,                          -- ttx_xxxxxxxxxxxx
    token_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    type TEXT NOT NULL,                           -- mint, burn, freeze, unfreeze
    status TEXT NOT NULL DEFAULT 'pending',       -- pending, processing, confirmed, finalized, failed
    signature TEXT UNIQUE,                        -- Solana transaction signature
    serialized_tx TEXT,                           -- Base64 encoded transaction
    params TEXT NOT NULL,                         -- JSON: operation parameters
    slot INTEGER,
    block_time INTEGER,
    fee INTEGER,
    error TEXT,
    initiated_by_key_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (token_id) REFERENCES tokens(id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX idx_token_tx_token ON token_transactions(token_id);
CREATE INDEX idx_token_tx_org ON token_transactions(organization_id);
CREATE INDEX idx_token_tx_status ON token_transactions(status);
CREATE INDEX idx_token_tx_signature ON token_transactions(signature);

-- ═══════════════════════════════════════════════════════════════════════════
-- Token Allowlist (per-token address allowlist)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE token_allowlists (
    id TEXT PRIMARY KEY,                          -- tal_xxxxxxxxxxxx
    token_id TEXT NOT NULL,
    address TEXT NOT NULL,                        -- Solana wallet address
    label TEXT,                                   -- Human-readable label
    kyc_status TEXT DEFAULT 'none',               -- none, pending, approved, rejected
    kyc_provider TEXT,
    kyc_verified_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',        -- active, revoked
    added_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at TEXT,
    FOREIGN KEY (token_id) REFERENCES tokens(id) ON DELETE CASCADE,
    UNIQUE(token_id, address)
);

CREATE INDEX idx_token_allowlist_token ON token_allowlists(token_id);
CREATE INDEX idx_token_allowlist_address ON token_allowlists(address);
CREATE INDEX idx_token_allowlist_status ON token_allowlists(status);

-- ═══════════════════════════════════════════════════════════════════════════
-- Frozen Accounts Tracking
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE frozen_accounts (
    id TEXT PRIMARY KEY,                          -- frz_xxxxxxxxxxxx
    token_id TEXT NOT NULL,
    account_address TEXT NOT NULL,                -- Token account or owner address
    reason TEXT,
    frozen_at TEXT NOT NULL DEFAULT (datetime('now')),
    frozen_by TEXT NOT NULL,                      -- API key or user who froze
    unfrozen_at TEXT,
    unfrozen_by TEXT,
    FOREIGN KEY (token_id) REFERENCES tokens(id) ON DELETE CASCADE,
    UNIQUE(token_id, account_address)
);

CREATE INDEX idx_frozen_accounts_token ON frozen_accounts(token_id);
CREATE INDEX idx_frozen_accounts_address ON frozen_accounts(account_address);
