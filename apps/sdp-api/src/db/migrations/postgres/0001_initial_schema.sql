-- Local Postgres baseline for SDP API.
-- This consolidates the current application schema into a single idempotent bootstrap file.

CREATE OR REPLACE FUNCTION sdp_datetime_now() RETURNS TEXT LANGUAGE SQL AS $$
  SELECT to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS');
$$;

CREATE OR REPLACE FUNCTION sdp_iso_now() RETURNS TEXT LANGUAGE SQL AS $$
  SELECT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;


-- Source: 0001_initial_schema.sql
-- Initial schema (consolidated baseline)
-- Promoted from the local Postgres baseline during the database cutover

CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,                              
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    tier TEXT NOT NULL DEFAULT 'enterprise',          
    status TEXT NOT NULL DEFAULT 'active',            
    settings TEXT,                                    
    created_at TEXT NOT NULL DEFAULT sdp_datetime_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_datetime_now()
);
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,                              
    email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'active',            
    created_at TEXT NOT NULL DEFAULT sdp_datetime_now()
, last_login_at TEXT, login_count INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS organization_members (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',              
    status TEXT NOT NULL DEFAULT 'active',            
    created_at TEXT NOT NULL DEFAULT sdp_datetime_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(organization_id, user_id)
);
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,                              
    organization_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    environment TEXT NOT NULL DEFAULT 'sandbox',      
    settings TEXT,                                    
    status TEXT NOT NULL DEFAULT 'active',            
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT sdp_datetime_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_datetime_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id),
    UNIQUE(organization_id, slug)
);
CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,                              
    organization_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,                         
    key_hash TEXT NOT NULL UNIQUE,                    
    role TEXT NOT NULL DEFAULT 'api_developer',       
    permissions TEXT,                                 
    environment TEXT NOT NULL DEFAULT 'sandbox',      
    rate_limit_tier TEXT DEFAULT 'standard',          
    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',            
    created_at TEXT NOT NULL DEFAULT sdp_datetime_now(), project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, description TEXT, allowed_ips TEXT, rotated_from TEXT, rotation_deadline TEXT,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS allowlist (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,                               
    value TEXT NOT NULL,                              
    tier TEXT DEFAULT 'standard',                     
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'active',            
    created_at TEXT NOT NULL DEFAULT sdp_datetime_now(),
    UNIQUE(type, value)
);
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    organization_id TEXT,
    user_id TEXT,
    api_key_id TEXT,
    action TEXT NOT NULL,                             
    resource_type TEXT NOT NULL,                      
    resource_id TEXT,
    metadata TEXT,                                    
    ip_address TEXT,
    user_agent TEXT,
    request_id TEXT,
    status TEXT NOT NULL DEFAULT 'success',           
    created_at TEXT NOT NULL DEFAULT sdp_datetime_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',              
    invited_by TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,                  
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',           
    created_at TEXT NOT NULL DEFAULT sdp_datetime_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS project_members (
    id TEXT PRIMARY KEY,                              
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'developer',           
    created_at TEXT NOT NULL DEFAULT sdp_datetime_now(),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(project_id, user_id)
);
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,                              
    user_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    auth_method TEXT NOT NULL,                        
    ip_address TEXT,
    user_agent TEXT,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_datetime_now(),
    last_activity_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS magic_links (
    id TEXT PRIMARY KEY,                              
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,                  
    organization_id TEXT,                             
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_datetime_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS issued_tokens (
    id TEXT PRIMARY KEY,                          
    project_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    mint_address TEXT UNIQUE,                     
    mint_authority TEXT,                          
    freeze_authority TEXT,                        
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    decimals INTEGER NOT NULL DEFAULT 9,
    description TEXT,
    uri TEXT,                                     
    image_url TEXT,
    -- Cached to avoid frequent RPC reads; refreshed asynchronously.
    total_supply_cached TEXT NOT NULL DEFAULT '0', 
    total_supply_updated_at TEXT,
    max_supply TEXT,                              
    is_mintable INTEGER DEFAULT 1,
    freeze_authority_enabled INTEGER DEFAULT 1,
    allowlist_enabled INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',       
    deployed_at TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    template TEXT NOT NULL DEFAULT 'custom',
    abl_list_address TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS issued_token_extensions (
    id TEXT PRIMARY KEY,                          
    token_id TEXT NOT NULL,
    extension TEXT NOT NULL,
    config TEXT,                                  
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (token_id) REFERENCES issued_tokens(id) ON DELETE CASCADE,
    UNIQUE(token_id, extension)
);
CREATE TABLE IF NOT EXISTS issuance_transactions (
    id TEXT PRIMARY KEY,                          
    token_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    type TEXT NOT NULL,                           
    status TEXT NOT NULL DEFAULT 'pending',       
    idempotency_key TEXT,
    idempotency_fingerprint TEXT,
    signature TEXT UNIQUE,                        
    serialized_tx TEXT,                           
    operation_params TEXT NOT NULL,               
    slot INTEGER,
    block_time TEXT,
    fee INTEGER,
    error TEXT,
    initiated_by_key_id TEXT,                     
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (token_id) REFERENCES issued_tokens(id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS issuance_transaction_statuses (
    id TEXT PRIMARY KEY,                          
    transaction_id TEXT NOT NULL,
    status TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (transaction_id) REFERENCES issuance_transactions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS token_allowlists (
    id TEXT PRIMARY KEY,                          
    token_id TEXT NOT NULL,
    address TEXT NOT NULL,                        
    label TEXT,                                   
    status TEXT NOT NULL DEFAULT 'active',        
    added_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    revoked_at TEXT,
    FOREIGN KEY (token_id) REFERENCES issued_tokens(id) ON DELETE CASCADE,
    UNIQUE(token_id, address)
);
CREATE TABLE IF NOT EXISTS token_allowlist_statuses (
    id TEXT PRIMARY KEY,                          
    allowlist_id TEXT NOT NULL,
    status TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (allowlist_id) REFERENCES token_allowlists(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS frozen_accounts (
    id TEXT PRIMARY KEY,                          
    token_id TEXT NOT NULL,
    account_address TEXT NOT NULL,                
    reason TEXT,
    frozen_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    frozen_by TEXT NOT NULL,                      
    unfrozen_at TEXT,
    unfrozen_by TEXT,
    FOREIGN KEY (token_id) REFERENCES issued_tokens(id) ON DELETE CASCADE,
    UNIQUE(token_id, account_address)
);
CREATE TABLE IF NOT EXISTS custody_configs (
    id TEXT PRIMARY KEY,                    
    organization_id TEXT NOT NULL,
    project_id TEXT,
    provider TEXT NOT NULL,                 
    -- AES-256-GCM encrypted JSON (HKDF per org; key in CUSTODY_ENCRYPTION_KEY).
    config_encrypted TEXT NOT NULL,         
    encryption_version TEXT NOT NULL DEFAULT 'sdp-custody-encryption-v1',
    default_wallet_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,

    UNIQUE(organization_id, project_id, provider)
);
CREATE TABLE IF NOT EXISTS signing_requests (
    id TEXT PRIMARY KEY,                    
    organization_id TEXT NOT NULL,
    custody_config_id TEXT,                 
    token_transaction_id TEXT,              
    external_request_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending', 
    transaction_message TEXT NOT NULL,      
    signatures TEXT,                        
    metadata TEXT,                          
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    completed_at TEXT,

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (custody_config_id) REFERENCES custody_configs(id) ON DELETE SET NULL,
    FOREIGN KEY (token_transaction_id) REFERENCES issuance_transactions(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS custody_wallets (
    id TEXT PRIMARY KEY,                    
    custody_config_id TEXT NOT NULL,
    wallet_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    label TEXT,
    purpose TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (custody_config_id) REFERENCES custody_configs(id) ON DELETE CASCADE,
    UNIQUE(custody_config_id, wallet_id)
);
CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);
CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_org_members_org ON organization_members(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys(organization_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(status);
CREATE INDEX IF NOT EXISTS idx_allowlist_type_value ON allowlist(type, value);
CREATE INDEX IF NOT EXISTS idx_allowlist_status ON allowlist(status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_invitations_org ON invitations(organization_id);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token_hash);
CREATE INDEX IF NOT EXISTS idx_invitations_status ON invitations(status);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(organization_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(organization_id, slug);
CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions(organization_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);
CREATE INDEX IF NOT EXISTS idx_magic_links_token ON magic_links(token_hash);
CREATE INDEX IF NOT EXISTS idx_magic_links_expires ON magic_links(expires_at);
CREATE INDEX IF NOT EXISTS idx_api_keys_project ON api_keys(project_id);
CREATE INDEX IF NOT EXISTS idx_issued_tokens_project ON issued_tokens(project_id);
CREATE INDEX IF NOT EXISTS idx_issued_tokens_org ON issued_tokens(organization_id);
CREATE INDEX IF NOT EXISTS idx_issued_tokens_mint ON issued_tokens(mint_address);
CREATE INDEX IF NOT EXISTS idx_issued_tokens_status ON issued_tokens(status);
CREATE INDEX IF NOT EXISTS idx_issued_tokens_template ON issued_tokens(template);
CREATE INDEX IF NOT EXISTS idx_issued_tokens_abl_list ON issued_tokens(abl_list_address);
CREATE INDEX IF NOT EXISTS idx_issued_token_extensions_token ON issued_token_extensions(token_id);
CREATE INDEX IF NOT EXISTS idx_issuance_tx_token ON issuance_transactions(token_id);
CREATE INDEX IF NOT EXISTS idx_issuance_tx_org ON issuance_transactions(organization_id);
CREATE INDEX IF NOT EXISTS idx_issuance_tx_status ON issuance_transactions(status);
CREATE INDEX IF NOT EXISTS idx_issuance_tx_signature ON issuance_transactions(signature);
CREATE UNIQUE INDEX IF NOT EXISTS idx_issuance_tx_org_idempotency_key ON issuance_transactions(organization_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_issuance_tx_status_tx ON issuance_transaction_statuses(transaction_id);
CREATE INDEX IF NOT EXISTS idx_issuance_tx_status_status ON issuance_transaction_statuses(status);
CREATE INDEX IF NOT EXISTS idx_token_allowlist_token ON token_allowlists(token_id);
CREATE INDEX IF NOT EXISTS idx_token_allowlist_address ON token_allowlists(address);
CREATE INDEX IF NOT EXISTS idx_token_allowlist_status ON token_allowlists(status);
CREATE INDEX IF NOT EXISTS idx_token_allowlist_statuses_entry ON token_allowlist_statuses(allowlist_id);
CREATE INDEX IF NOT EXISTS idx_token_allowlist_statuses_status ON token_allowlist_statuses(status);
CREATE INDEX IF NOT EXISTS idx_frozen_accounts_token ON frozen_accounts(token_id);
CREATE INDEX IF NOT EXISTS idx_frozen_accounts_address ON frozen_accounts(account_address);
CREATE INDEX IF NOT EXISTS idx_custody_configs_org ON custody_configs(organization_id);
CREATE INDEX IF NOT EXISTS idx_custody_configs_project ON custody_configs(organization_id, project_id);
CREATE INDEX IF NOT EXISTS idx_custody_configs_status ON custody_configs(status);
CREATE INDEX IF NOT EXISTS idx_signing_requests_status ON signing_requests(status);
CREATE INDEX IF NOT EXISTS idx_signing_requests_external ON signing_requests(external_request_id);
CREATE INDEX IF NOT EXISTS idx_signing_requests_org ON signing_requests(organization_id);
CREATE INDEX IF NOT EXISTS idx_signing_requests_token_tx ON signing_requests(token_transaction_id);
CREATE INDEX IF NOT EXISTS idx_custody_wallets_config ON custody_wallets(custody_config_id);
CREATE INDEX IF NOT EXISTS idx_custody_wallets_public_key ON custody_wallets(public_key);


-- Source: 0002_auth_identities.sql
-- Auth identity mappings for external providers (e.g. Clerk)

CREATE TABLE IF NOT EXISTS auth_user_identities (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT sdp_datetime_now(),
  updated_at TEXT NOT NULL DEFAULT sdp_datetime_now()
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_user_identities_provider_user_unique
  ON auth_user_identities (provider, provider_user_id);

CREATE INDEX IF NOT EXISTS idx_auth_user_identities_user
  ON auth_user_identities (user_id);

CREATE INDEX IF NOT EXISTS idx_auth_user_identities_provider
  ON auth_user_identities (provider);

CREATE TABLE IF NOT EXISTS auth_organization_identities (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_org_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug TEXT,
  created_at TEXT NOT NULL DEFAULT sdp_datetime_now(),
  updated_at TEXT NOT NULL DEFAULT sdp_datetime_now()
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_org_identities_provider_org_unique
  ON auth_organization_identities (provider, provider_org_id);

CREATE INDEX IF NOT EXISTS idx_auth_org_identities_org
  ON auth_organization_identities (organization_id);

CREATE INDEX IF NOT EXISTS idx_auth_org_identities_provider
  ON auth_organization_identities (provider);


-- Source: 0003_api_keys_signing_wallet.sql
-- Add API-key scoped signing wallet binding.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS signing_wallet_id TEXT;

CREATE INDEX IF NOT EXISTS idx_api_keys_signing_wallet_id ON api_keys(signing_wallet_id);


-- Source: 0004_payment_wallet_policies.sql
CREATE TABLE IF NOT EXISTS payment_wallet_policies (
    id TEXT PRIMARY KEY,
    custody_wallet_id TEXT NOT NULL,
    policy_type TEXT NOT NULL,
    policy TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id) ON DELETE CASCADE,
    UNIQUE (custody_wallet_id, policy_type)
);
CREATE INDEX IF NOT EXISTS idx_payment_wallet_policies_wallet ON payment_wallet_policies(custody_wallet_id);


-- Source: 0005_payment_transfers.sql
CREATE TABLE IF NOT EXISTS payment_transfers (
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

CREATE INDEX IF NOT EXISTS idx_payment_transfers_org_created ON payment_transfers(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_transfers_project_created ON payment_transfers(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_transfers_wallet ON payment_transfers(wallet_id);
CREATE INDEX IF NOT EXISTS idx_payment_transfers_status ON payment_transfers(status);


-- Source: 0006_custody_scope_defaults.sql
-- Add explicit default custody configuration pointer per scope.

CREATE TABLE IF NOT EXISTS custody_scope_defaults (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT,
  default_custody_config_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (default_custody_config_id) REFERENCES custody_configs(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_custody_scope_defaults_org_project_not_null
  ON custody_scope_defaults(organization_id, project_id)
  WHERE project_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_custody_scope_defaults_org_null_project
  ON custody_scope_defaults(organization_id)
  WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_custody_scope_defaults_default_config
  ON custody_scope_defaults(default_custody_config_id);



-- Source: 0007_api_key_wallet_permissions.sql
CREATE TABLE IF NOT EXISTS api_key_wallet_permissions (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '["*"]',
  created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_wallet_permissions_key_wallet
  ON api_key_wallet_permissions(api_key_id, wallet_id);

CREATE INDEX IF NOT EXISTS idx_api_key_wallet_permissions_key
  ON api_key_wallet_permissions(api_key_id);



-- Source: 0008_custody_wallets_updated_at.sql
ALTER TABLE custody_wallets ADD COLUMN IF NOT EXISTS updated_at TEXT;

UPDATE custody_wallets
SET updated_at = COALESCE(updated_at, created_at, sdp_iso_now())
WHERE updated_at IS NULL;


-- Source: 0009_token_signing_wallet.sql
ALTER TABLE issued_tokens ADD COLUMN IF NOT EXISTS signing_wallet_id TEXT;


-- Source: 0010_performance_indexes.sql
-- Add composite indexes for the hottest filtered + ordered queries.

CREATE INDEX IF NOT EXISTS idx_org_members_org_status_created
  ON organization_members(organization_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_org_members_org_role_created
  ON organization_members(organization_id, role, created_at);

CREATE INDEX IF NOT EXISTS idx_invitations_org_email_status
  ON invitations(organization_id, email, status);

CREATE INDEX IF NOT EXISTS idx_api_keys_org_created
  ON api_keys(organization_id, created_at);

CREATE INDEX IF NOT EXISTS idx_sessions_user_revoked_created
  ON sessions(user_id, revoked_at, created_at);

CREATE INDEX IF NOT EXISTS idx_api_key_wallet_permissions_key_created
  ON api_key_wallet_permissions(api_key_id, created_at);

CREATE INDEX IF NOT EXISTS idx_issued_tokens_project_created
  ON issued_tokens(project_id, created_at);

CREATE INDEX IF NOT EXISTS idx_issued_tokens_project_status_created
  ON issued_tokens(project_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_issuance_tx_token_created
  ON issuance_transactions(token_id, created_at);

CREATE INDEX IF NOT EXISTS idx_issuance_tx_token_status_created
  ON issuance_transactions(token_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_token_allowlist_token_status_created
  ON token_allowlists(token_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_frozen_accounts_token_frozen_active
  ON frozen_accounts(token_id, frozen_at)
  WHERE unfrozen_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_custody_configs_org_project_status_updated
  ON custody_configs(organization_id, project_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_custody_wallets_config_status
  ON custody_wallets(custody_config_id, status);

CREATE INDEX IF NOT EXISTS idx_custody_wallets_config_purpose_status
  ON custody_wallets(custody_config_id, purpose, status);

CREATE INDEX IF NOT EXISTS idx_payment_transfers_status_updated
  ON payment_transfers(status, updated_at);


-- Source: 0011_metadata_authority.sql
ALTER TABLE issued_tokens ADD COLUMN IF NOT EXISTS metadata_authority TEXT;

UPDATE issued_tokens
SET metadata_authority = mint_authority
WHERE metadata_authority IS NULL;


ALTER TABLE invitations ADD COLUMN IF NOT EXISTS accepted_at TEXT;
