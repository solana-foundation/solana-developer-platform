-- SDP API Key Enhancements
-- Migration: 0003_api_key_enhancements.sql

-- Add project scoping and security features to api_keys
ALTER TABLE api_keys ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE api_keys ADD COLUMN description TEXT;
ALTER TABLE api_keys ADD COLUMN allowed_ips TEXT;                -- JSON array of CIDR ranges
ALTER TABLE api_keys ADD COLUMN rotated_from TEXT;               -- Previous key ID if rotated
ALTER TABLE api_keys ADD COLUMN rotation_deadline TEXT;          -- Grace period end for rotated keys

CREATE INDEX idx_api_keys_project ON api_keys(project_id);

-- Add login tracking to users
ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN login_count INTEGER DEFAULT 0;
