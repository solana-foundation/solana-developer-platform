import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { env } from "@/test/helpers/env";

it("backfills exact API-key wallet permissions without widening unresolved keys", async () => {
  const migrationPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0057_api_key_wallet_permission_custody_identity.sql"
  );
  const sql = readFileSync(migrationPath, "utf8");
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE api_keys (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      signing_wallet_id TEXT
    )`);
    await client.query(`CREATE TEMP TABLE custody_configs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      status TEXT NOT NULL
    )`);
    await client.query(`CREATE TEMP TABLE custody_connections (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      status TEXT NOT NULL
    )`);
    await client.query(`CREATE TEMP TABLE custody_wallets (
      id TEXT PRIMARY KEY,
      custody_config_id TEXT,
      custody_connection_id TEXT,
      wallet_id TEXT NOT NULL,
      status TEXT NOT NULL
    )`);
    await client.query(`CREATE TEMP TABLE api_key_wallet_permissions (
      id TEXT PRIMARY KEY,
      api_key_id TEXT NOT NULL,
      wallet_id TEXT NOT NULL,
      permissions TEXT NOT NULL DEFAULT '["*"]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await client.query(`CREATE UNIQUE INDEX idx_api_key_wallet_permissions_key_wallet
      ON api_key_wallet_permissions(api_key_id, wallet_id)`);

    await client.query(`INSERT INTO api_keys
      (id, organization_id, project_id, signing_wallet_id)
      VALUES
        ('key_existing', 'org_one', 'project_one', 'provider_config'),
        ('key_signing_only', 'org_one', 'project_one', 'provider_connection'),
        ('key_ambiguous', 'org_one', 'project_one', 'provider_ambiguous'),
        ('key_config_ambiguous', 'org_one', 'project_one', 'provider_config_ambiguous'),
        ('key_orphan', 'org_one', 'project_one', 'provider_missing'),
        ('key_all', 'org_one', 'project_one', NULL)`);
    await client.query(`INSERT INTO custody_configs
      (id, organization_id, project_id, status)
      VALUES
        ('config_org', 'org_one', NULL, 'active'),
        ('config_org_ambiguous', 'org_one', NULL, 'active'),
        ('config_ambiguous', 'org_one', 'project_one', 'active'),
        ('config_project_ambiguous', 'org_one', 'project_one', 'active'),
        ('config_foreign', 'org_one', 'project_two', 'active')`);
    await client.query(`INSERT INTO custody_connections
      (id, organization_id, project_id, status)
      VALUES
        ('connection_unique', 'org_one', 'project_one', 'active'),
        ('connection_ambiguous', 'org_one', 'project_one', 'active')`);
    await client.query(`INSERT INTO custody_wallets
      (id, custody_config_id, custody_connection_id, wallet_id, status)
      VALUES
        ('wallet_config', 'config_org', NULL, 'provider_config', 'active'),
        ('wallet_config_org_ambiguous', 'config_org_ambiguous', NULL, 'provider_config_ambiguous', 'active'),
        ('wallet_config_project_ambiguous', 'config_project_ambiguous', NULL, 'provider_config_ambiguous', 'active'),
        ('wallet_config_foreign', 'config_foreign', NULL, 'provider_config', 'active'),
        ('wallet_connection', NULL, 'connection_unique', 'provider_connection', 'active'),
        ('wallet_ambiguous_config', 'config_ambiguous', NULL, 'provider_ambiguous', 'active'),
        ('wallet_ambiguous_connection', NULL, 'connection_ambiguous', 'provider_ambiguous', 'active')`);
    await client.query(`INSERT INTO api_key_wallet_permissions
      (id, api_key_id, wallet_id, permissions)
      VALUES
        ('permission_config', 'key_existing', 'provider_config', '["*"]'),
        ('permission_ambiguous', 'key_ambiguous', 'provider_ambiguous', '["*"]'),
        ('permission_config_ambiguous', 'key_config_ambiguous', 'provider_config_ambiguous', '["*"]'),
        ('permission_orphan', 'key_orphan', 'provider_missing', '["*"]')`);

    const walletCountBefore = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM custody_wallets"
    );

    await client.query(sql);

    const permissions = await client.query<{
      api_key_id: string;
      wallet_id: string;
      custody_wallet_id: string | null;
    }>(`SELECT api_key_id, wallet_id, custody_wallet_id
        FROM api_key_wallet_permissions
        ORDER BY api_key_id`);
    expect(permissions.rows).toEqual([
      {
        api_key_id: "key_ambiguous",
        wallet_id: "provider_ambiguous",
        custody_wallet_id: null,
      },
      {
        api_key_id: "key_config_ambiguous",
        wallet_id: "provider_config_ambiguous",
        custody_wallet_id: null,
      },
      {
        api_key_id: "key_existing",
        wallet_id: "provider_config",
        custody_wallet_id: "wallet_config",
      },
      {
        api_key_id: "key_orphan",
        wallet_id: "provider_missing",
        custody_wallet_id: null,
      },
      {
        api_key_id: "key_signing_only",
        wallet_id: "provider_connection",
        custody_wallet_id: "wallet_connection",
      },
    ]);

    const walletCountAfter = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM custody_wallets"
    );
    expect(walletCountAfter.rows).toEqual(walletCountBefore.rows);

    await client.query("DELETE FROM custody_wallets WHERE id = 'wallet_connection'");
    const retained = await client.query<{ custody_wallet_id: string | null }>(
      `SELECT custody_wallet_id
       FROM api_key_wallet_permissions
       WHERE api_key_id = 'key_signing_only'`
    );
    expect(retained.rows).toEqual([{ custody_wallet_id: null }]);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
