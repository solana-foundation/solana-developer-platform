-- SDP API Initial Schema
-- Migration: 0001_initial_schema.sql

-- Organizations table
CREATE TABLE organizations (
    id TEXT PRIMARY KEY,                              -- org_xxxxxxxxxxxx
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    tier TEXT NOT NULL DEFAULT 'free',                -- free, pro, enterprise
    status TEXT NOT NULL DEFAULT 'active',            -- active, suspended, deleted
    settings TEXT,                                    -- JSON blob
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_organizations_slug ON organizations(slug);
CREATE INDEX idx_organizations_status ON organizations(status);

-- Users table
CREATE TABLE users (
    id TEXT PRIMARY KEY,                              -- usr_xxxxxxxxxxxx
    email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'active',            -- active, suspended, deleted
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);

-- Organization members (many-to-many)
CREATE TABLE organization_members (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',              -- owner, admin, developer, viewer
    status TEXT NOT NULL DEFAULT 'active',            -- active, suspended, removed
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(organization_id, user_id)
);

CREATE INDEX idx_org_members_org ON organization_members(organization_id);
CREATE INDEX idx_org_members_user ON organization_members(user_id);

-- API keys
CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,                              -- key_xxxxxxxxxxxx
    organization_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,                         -- "sk_live_abc" for display
    key_hash TEXT NOT NULL UNIQUE,                    -- SHA-256 of full key
    role TEXT NOT NULL DEFAULT 'api_developer',       -- api_admin, api_developer, api_readonly
    permissions TEXT,                                 -- JSON array of permission overrides
    environment TEXT NOT NULL DEFAULT 'sandbox',      -- sandbox, production
    rate_limit_tier TEXT DEFAULT 'standard',          -- standard, elevated, unlimited
    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',            -- active, revoked, expired
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_api_keys_org ON api_keys(organization_id);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_status ON api_keys(status);

-- Allowlist for email/domain-based access control
CREATE TABLE allowlist (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,                               -- email, domain
    value TEXT NOT NULL,                              -- email address or domain
    tier TEXT DEFAULT 'standard',                     -- default tier for new orgs
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'active',            -- active, disabled
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(type, value)
);

CREATE INDEX idx_allowlist_type_value ON allowlist(type, value);
CREATE INDEX idx_allowlist_status ON allowlist(status);

-- Audit logs
CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY,
    organization_id TEXT,
    user_id TEXT,
    api_key_id TEXT,
    action TEXT NOT NULL,                             -- create, update, delete, revoke, etc.
    resource_type TEXT NOT NULL,                      -- organization, user, api_key, etc.
    resource_id TEXT,
    metadata TEXT,                                    -- JSON blob with additional context
    ip_address TEXT,
    user_agent TEXT,
    request_id TEXT,
    status TEXT NOT NULL DEFAULT 'success',           -- success, failure
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
);

CREATE INDEX idx_audit_logs_org ON audit_logs(organization_id);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);

-- Invitations for member onboarding
CREATE TABLE invitations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',              -- owner, admin, developer, viewer
    invited_by TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,                  -- SHA-256 of invitation token
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',           -- pending, accepted, expired, revoked
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by) REFERENCES users(id)
);

CREATE INDEX idx_invitations_org ON invitations(organization_id);
CREATE INDEX idx_invitations_email ON invitations(email);
CREATE INDEX idx_invitations_token ON invitations(token_hash);
CREATE INDEX idx_invitations_status ON invitations(status);
