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
        status TEXT DEFAULT 'active',
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
        created_by TEXT NOT NULL,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT UNIQUE NOT NULL,
        role TEXT DEFAULT 'api_user',
        permissions TEXT,
        environment TEXT DEFAULT 'sandbox',
        rate_limit_tier TEXT DEFAULT 'standard',
        status TEXT DEFAULT 'active',
        last_used_at TEXT,
        expires_at TEXT,
        revoked_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
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
        value_hash TEXT UNIQUE NOT NULL,
        tier TEXT DEFAULT 'free',
        created_by TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `),
  ]);
}

/**
 * Clears all test data (preserves schema)
 */
export async function clearTestDatabase(env: Env): Promise<void> {
  const db = env.DB;

  await db.batch([
    db.prepare("DELETE FROM audit_logs"),
    db.prepare("DELETE FROM api_keys"),
    db.prepare("DELETE FROM organization_members"),
    db.prepare("DELETE FROM users"),
    db.prepare("DELETE FROM organizations"),
    db.prepare("DELETE FROM allowlist"),
  ]);
}
