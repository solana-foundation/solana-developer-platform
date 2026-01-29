/**
 * D1 Database test helpers
 *
 * Uses the actual D1 binding from Miniflare for realistic testing.
 */

import type { Env } from "@/types/env";

/**
 * Seeds the test database with schema
 */
export async function seedTestDatabase(env: Env): Promise<void> {
  const db = env.DB;

  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        tier TEXT DEFAULT 'free',
        status TEXT DEFAULT 'active',
        settings TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        email_verified INTEGER DEFAULT 0,
        name TEXT,
        status TEXT DEFAULT 'active',
        last_login_at TEXT,
        login_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS organization_members (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (organization_id) REFERENCES organizations(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        project_id TEXT,
        created_by TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        key_prefix TEXT NOT NULL,
        key_hash TEXT UNIQUE NOT NULL,
        role TEXT DEFAULT 'api_developer',
        permissions TEXT,
        environment TEXT DEFAULT 'sandbox',
        rate_limit_tier TEXT DEFAULT 'standard',
        allowed_ips TEXT,
        status TEXT DEFAULT 'active',
        last_used_at TEXT,
        expires_at TEXT,
        revoked_at TEXT,
        rotated_from TEXT,
        rotation_deadline TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (organization_id) REFERENCES organizations(id),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      )
    `),
    db.prepare(`
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
        status TEXT DEFAULT 'success',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS allowlist (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        value TEXT NOT NULL,
        value_hash TEXT,
        tier TEXT DEFAULT 'free',
        notes TEXT,
        status TEXT DEFAULT 'active',
        created_by TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT,
        environment TEXT DEFAULT 'sandbox',
        settings TEXT,
        status TEXT DEFAULT 'active',
        created_by TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (organization_id) REFERENCES organizations(id),
        UNIQUE(organization_id, slug)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS project_members (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT DEFAULT 'developer',
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        UNIQUE(project_id, user_id)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        auth_method TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        last_activity_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS magic_links (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        organization_id TEXT,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS tokens (
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
        extensions TEXT,
        total_supply TEXT DEFAULT '0',
        max_supply TEXT,
        is_mintable INTEGER DEFAULT 1,
        is_freezable INTEGER DEFAULT 1,
        requires_allowlist INTEGER DEFAULT 0,
        template TEXT NOT NULL DEFAULT 'custom',
        abl_list_address TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        deployed_at TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS token_transactions (
        id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        signature TEXT UNIQUE,
        serialized_tx TEXT,
        params TEXT NOT NULL,
        slot INTEGER,
        block_time INTEGER,
        fee INTEGER,
        error TEXT,
        initiated_by_key_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (token_id) REFERENCES tokens(id) ON DELETE CASCADE
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS token_allowlists (
        id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        address TEXT NOT NULL,
        label TEXT,
        kyc_status TEXT DEFAULT 'none',
        kyc_provider TEXT,
        kyc_verified_at TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        added_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        revoked_at TEXT,
        FOREIGN KEY (token_id) REFERENCES tokens(id) ON DELETE CASCADE,
        UNIQUE(token_id, address)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS frozen_accounts (
        id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        account_address TEXT NOT NULL,
        reason TEXT,
        frozen_at TEXT NOT NULL DEFAULT (datetime('now')),
        frozen_by TEXT NOT NULL,
        unfrozen_at TEXT,
        unfrozen_by TEXT,
        FOREIGN KEY (token_id) REFERENCES tokens(id) ON DELETE CASCADE,
        UNIQUE(token_id, account_address)
      )
    `),
    // Custody configuration tables
    db.prepare(`
      CREATE TABLE IF NOT EXISTS custody_configs (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        project_id TEXT,
        provider TEXT NOT NULL,
        config TEXT NOT NULL,
        default_wallet_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        UNIQUE(organization_id, project_id)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS signing_requests (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        custody_config_id TEXT NOT NULL,
        token_transaction_id TEXT,
        external_request_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        transaction_message TEXT NOT NULL,
        signatures TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (custody_config_id) REFERENCES custody_configs(id) ON DELETE SET NULL,
        FOREIGN KEY (token_transaction_id) REFERENCES token_transactions(id) ON DELETE SET NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS custody_wallets (
        id TEXT PRIMARY KEY,
        custody_config_id TEXT NOT NULL,
        wallet_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        label TEXT,
        purpose TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (custody_config_id) REFERENCES custody_configs(id) ON DELETE CASCADE,
        UNIQUE(custody_config_id, wallet_id)
      )
    `),
  ]);
}

/**
 * Clears all test data by dropping and recreating tables
 * This is more reliable than DELETE in test isolation
 */
export async function clearTestDatabase(env: Env): Promise<void> {
  const db = env.DB;

  // Drop tables if they exist (order matters for foreign keys)
  const tables = [
    "custody_wallets",
    "signing_requests",
    "custody_configs",
    "frozen_accounts",
    "token_allowlists",
    "token_transactions",
    "tokens",
    "magic_links",
    "sessions",
    "project_members",
    "projects",
    "audit_logs",
    "api_keys",
    "organization_members",
    "users",
    "organizations",
    "allowlist",
  ];

  for (const table of tables) {
    try {
      await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    } catch {
      // Ignore errors during cleanup
    }
  }
}
