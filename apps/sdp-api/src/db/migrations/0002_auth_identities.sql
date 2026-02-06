-- Auth identity mappings for external providers (e.g. Clerk)

CREATE TABLE IF NOT EXISTS auth_user_identities (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_org_identities_provider_org_unique
  ON auth_organization_identities (provider, provider_org_id);

CREATE INDEX IF NOT EXISTS idx_auth_org_identities_org
  ON auth_organization_identities (organization_id);

CREATE INDEX IF NOT EXISTS idx_auth_org_identities_provider
  ON auth_organization_identities (provider);
