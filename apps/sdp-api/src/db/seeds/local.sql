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

-- Create a test API key
-- Note: This is the hash of "sk_test_abcdefghijklmnopqrstuvwxyz123456"
-- In production, use proper random generation
INSERT INTO api_keys (
    id, organization_id, created_by, name, key_prefix, key_hash,
    role, environment, rate_limit_tier, status
) VALUES (
    'key_test123456789',
    'org_test123456789',
    'usr_test123456789',
    'Development Key',
    'sk_test_abc',
    '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'api_admin',
    'sandbox',
    'standard',
    'active'
);
