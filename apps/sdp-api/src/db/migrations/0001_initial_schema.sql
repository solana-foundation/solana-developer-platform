-- Initial schema (consolidated baseline)
-- Generated from local D1 export

CREATE TABLE organizations (
    id TEXT PRIMARY KEY,                              
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    tier TEXT NOT NULL DEFAULT 'free',                
    status TEXT NOT NULL DEFAULT 'active',            
    settings TEXT,                                    
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE users (
    id TEXT PRIMARY KEY,                              
    email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'active',            
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
, last_login_at TEXT, login_count INTEGER DEFAULT 0);
CREATE TABLE organization_members (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',              
    status TEXT NOT NULL DEFAULT 'active',            
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(organization_id, user_id)
);
CREATE TABLE api_keys (
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
    created_at TEXT NOT NULL DEFAULT (datetime('now')), project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, description TEXT, allowed_ips TEXT, rotated_from TEXT, rotation_deadline TEXT,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE TABLE allowlist (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,                               
    value TEXT NOT NULL,                              
    tier TEXT DEFAULT 'standard',                     
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'active',            
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(type, value)
);
CREATE TABLE audit_logs (
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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
);
CREATE TABLE invitations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',              
    invited_by TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,                  
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',           
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by) REFERENCES users(id)
);
CREATE TABLE projects (
    id TEXT PRIMARY KEY,                              
    organization_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    environment TEXT NOT NULL DEFAULT 'sandbox',      
    settings TEXT,                                    
    status TEXT NOT NULL DEFAULT 'active',            
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id),
    UNIQUE(organization_id, slug)
);
CREATE TABLE project_members (
    id TEXT PRIMARY KEY,                              
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'developer',           
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(project_id, user_id)
);
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,                              
    user_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    auth_method TEXT NOT NULL,                        
    ip_address TEXT,
    user_agent TEXT,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_activity_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE TABLE magic_links (
    id TEXT PRIMARY KEY,                              
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,                  
    organization_id TEXT,                             
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
);
CREATE TABLE issued_tokens (
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
    created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
    template TEXT NOT NULL DEFAULT 'custom',
    abl_list_address TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE TABLE issued_token_extensions (
    id TEXT PRIMARY KEY,                          
    token_id TEXT NOT NULL,
    extension TEXT NOT NULL,
    config TEXT,                                  
    created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (token_id) REFERENCES issued_tokens(id) ON DELETE CASCADE,
    UNIQUE(token_id, extension)
);
CREATE TABLE issuance_transactions (
    id TEXT PRIMARY KEY,                          
    token_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    type TEXT NOT NULL,                           
    status TEXT NOT NULL DEFAULT 'pending',       
    signature TEXT UNIQUE,                        
    serialized_tx TEXT,                           
    operation_params TEXT NOT NULL,               
    slot INTEGER,
    block_time TEXT,
    fee INTEGER,
    error TEXT,
    initiated_by_key_id TEXT,                     
    created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (token_id) REFERENCES issued_tokens(id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE TABLE issuance_transaction_statuses (
    id TEXT PRIMARY KEY,                          
    transaction_id TEXT NOT NULL,
    status TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (transaction_id) REFERENCES issuance_transactions(id) ON DELETE CASCADE
);
CREATE TABLE token_allowlists (
    id TEXT PRIMARY KEY,                          
    token_id TEXT NOT NULL,
    address TEXT NOT NULL,                        
    label TEXT,                                   
    status TEXT NOT NULL DEFAULT 'active',        
    added_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
    revoked_at TEXT,
    FOREIGN KEY (token_id) REFERENCES issued_tokens(id) ON DELETE CASCADE,
    UNIQUE(token_id, address)
);
CREATE TABLE token_allowlist_statuses (
    id TEXT PRIMARY KEY,                          
    allowlist_id TEXT NOT NULL,
    status TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (allowlist_id) REFERENCES token_allowlists(id) ON DELETE CASCADE
);
CREATE TABLE frozen_accounts (
    id TEXT PRIMARY KEY,                          
    token_id TEXT NOT NULL,
    account_address TEXT NOT NULL,                
    reason TEXT,
    frozen_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
    frozen_by TEXT NOT NULL,                      
    unfrozen_at TEXT,
    unfrozen_by TEXT,
    FOREIGN KEY (token_id) REFERENCES issued_tokens(id) ON DELETE CASCADE,
    UNIQUE(token_id, account_address)
);
CREATE TABLE custody_configs (
    id TEXT PRIMARY KEY,                    
    organization_id TEXT NOT NULL,
    project_id TEXT,
    provider TEXT NOT NULL,                 
    -- AES-256-GCM encrypted JSON (HKDF per org; key in CUSTODY_ENCRYPTION_KEY).
    config_encrypted TEXT NOT NULL,         
    encryption_version TEXT NOT NULL DEFAULT 'sdp-custody-encryption-v1',
    default_wallet_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,

    UNIQUE(organization_id, project_id, provider)
);
CREATE TABLE signing_requests (
    id TEXT PRIMARY KEY,                    
    organization_id TEXT NOT NULL,
    custody_config_id TEXT,                 
    token_transaction_id TEXT,              
    external_request_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending', 
    transaction_message TEXT NOT NULL,      
    signatures TEXT,                        
    metadata TEXT,                          
    created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
    completed_at TEXT,

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (custody_config_id) REFERENCES custody_configs(id) ON DELETE SET NULL,
    FOREIGN KEY (token_transaction_id) REFERENCES issuance_transactions(id) ON DELETE SET NULL
);
CREATE TABLE custody_wallets (
    id TEXT PRIMARY KEY,                    
    custody_config_id TEXT NOT NULL,
    wallet_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    label TEXT,
    purpose TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),

    FOREIGN KEY (custody_config_id) REFERENCES custody_configs(id) ON DELETE CASCADE,
    UNIQUE(custody_config_id, wallet_id)
);
CREATE INDEX idx_organizations_slug ON organizations(slug);
CREATE INDEX idx_organizations_status ON organizations(status);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_org_members_org ON organization_members(organization_id);
CREATE INDEX idx_org_members_user ON organization_members(user_id);
CREATE INDEX idx_api_keys_org ON api_keys(organization_id);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_status ON api_keys(status);
CREATE INDEX idx_allowlist_type_value ON allowlist(type, value);
CREATE INDEX idx_allowlist_status ON allowlist(status);
CREATE INDEX idx_audit_logs_org ON audit_logs(organization_id);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_invitations_org ON invitations(organization_id);
CREATE INDEX idx_invitations_email ON invitations(email);
CREATE INDEX idx_invitations_token ON invitations(token_hash);
CREATE INDEX idx_invitations_status ON invitations(status);
CREATE INDEX idx_projects_org ON projects(organization_id);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_slug ON projects(organization_id, slug);
CREATE INDEX idx_project_members_project ON project_members(project_id);
CREATE INDEX idx_project_members_user ON project_members(user_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_org ON sessions(organization_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_magic_links_email ON magic_links(email);
CREATE INDEX idx_magic_links_token ON magic_links(token_hash);
CREATE INDEX idx_magic_links_expires ON magic_links(expires_at);
CREATE INDEX idx_api_keys_project ON api_keys(project_id);
CREATE INDEX idx_issued_tokens_project ON issued_tokens(project_id);
CREATE INDEX idx_issued_tokens_org ON issued_tokens(organization_id);
CREATE INDEX idx_issued_tokens_mint ON issued_tokens(mint_address);
CREATE INDEX idx_issued_tokens_status ON issued_tokens(status);
CREATE INDEX idx_issued_tokens_template ON issued_tokens(template);
CREATE INDEX idx_issued_tokens_abl_list ON issued_tokens(abl_list_address);
CREATE INDEX idx_issued_token_extensions_token ON issued_token_extensions(token_id);
CREATE INDEX idx_issuance_tx_token ON issuance_transactions(token_id);
CREATE INDEX idx_issuance_tx_org ON issuance_transactions(organization_id);
CREATE INDEX idx_issuance_tx_status ON issuance_transactions(status);
CREATE INDEX idx_issuance_tx_signature ON issuance_transactions(signature);
CREATE INDEX idx_issuance_tx_status_tx ON issuance_transaction_statuses(transaction_id);
CREATE INDEX idx_issuance_tx_status_status ON issuance_transaction_statuses(status);
CREATE INDEX idx_token_allowlist_token ON token_allowlists(token_id);
CREATE INDEX idx_token_allowlist_address ON token_allowlists(address);
CREATE INDEX idx_token_allowlist_status ON token_allowlists(status);
CREATE INDEX idx_token_allowlist_statuses_entry ON token_allowlist_statuses(allowlist_id);
CREATE INDEX idx_token_allowlist_statuses_status ON token_allowlist_statuses(status);
CREATE INDEX idx_frozen_accounts_token ON frozen_accounts(token_id);
CREATE INDEX idx_frozen_accounts_address ON frozen_accounts(account_address);
CREATE INDEX idx_custody_configs_org ON custody_configs(organization_id);
CREATE INDEX idx_custody_configs_project ON custody_configs(organization_id, project_id);
CREATE INDEX idx_custody_configs_status ON custody_configs(status);
CREATE INDEX idx_signing_requests_status ON signing_requests(status);
CREATE INDEX idx_signing_requests_external ON signing_requests(external_request_id);
CREATE INDEX idx_signing_requests_org ON signing_requests(organization_id);
CREATE INDEX idx_signing_requests_token_tx ON signing_requests(token_transaction_id);
CREATE INDEX idx_custody_wallets_config ON custody_wallets(custody_config_id);
CREATE INDEX idx_custody_wallets_public_key ON custody_wallets(public_key);
