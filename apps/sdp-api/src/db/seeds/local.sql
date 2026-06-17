-- Seed data for local development
-- Run with: pnpm db:seed:local

-- Add some allowlist entries for testing
INSERT INTO allowlist (id, type, value, tier, notes) VALUES
    ('al_001', 'domain', 'solana.org', 'enterprise', 'Solana Foundation'),
    ('al_002', 'domain', 'solana.com', 'enterprise', 'Solana team'),
    ('al_003', 'domain', 'jump.com', 'enterprise', 'Jump Crypto'),
    ('al_004', 'email', 'test@example.com', 'standard', 'Test account');

-- Create a test user
INSERT INTO users (id, email, email_verified, name, status) VALUES
    ('usr_test123456789', 'test@example.com', 1, 'Test User', 'active');

-- Create a test organization
INSERT INTO organizations (id, name, slug, tier, status) VALUES
    ('org_test123456789', 'Test Organization', 'test-org', 'individual', 'active');

-- Link user to organization as admin
INSERT INTO organization_members (id, organization_id, user_id, role, status) VALUES
    ('mem_test123456789', 'org_test123456789', 'usr_test123456789', 'admin', 'active');

-- Create a test project (api_keys.project_id is a required reference)
INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by) VALUES
    ('prj_test123456789', 'org_test123456789', 'Test Project', 'test-project', 'sandbox', 'active', 'usr_test123456789');

-- Create a test API key
-- key_hash is derived from the documented dev key via Postgres' built-in sha256(),
-- so the hash can never drift from the key. Auth uses plain SHA-256 when
-- API_KEY_PEPPER is unset; in production, use a random key and set API_KEY_PEPPER.
INSERT INTO api_keys (
    id, organization_id, project_id, created_by, name, key_prefix, key_hash,
    role, rate_limit_tier, status
) VALUES (
    'key_test123456789',
    'org_test123456789',
    'prj_test123456789',
    'usr_test123456789',
    'Development Key',
    'sk_test_abc',
    encode(sha256('sk_test_abcdefghijklmnopqrstuvwxyz123456'::bytea), 'hex'),
    'api_admin',
    'standard',
    'active'
);
