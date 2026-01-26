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
  ]);
}

/**
 * Clears all test data by dropping and recreating tables
 * This is more reliable than DELETE in test isolation
 */
export async function clearTestDatabase(env: Env): Promise<void> {
  const db = env.DB;

  // Drop tables if they exist
  const tables = [
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
