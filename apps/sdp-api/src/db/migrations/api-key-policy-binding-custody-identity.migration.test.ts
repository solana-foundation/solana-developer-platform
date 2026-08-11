import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { env } from "@/test/helpers/env";

it("backfills only unambiguous in-scope custody wallet identities", async () => {
  const migrationPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0053_api_key_policy_binding_custody_identity.sql"
  );
  const sql = readFileSync(migrationPath, "utf8");
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE api_keys (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT
    )`);
    await client.query(`CREATE TEMP TABLE custody_configs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      status TEXT NOT NULL
    )`);
    await client.query(`CREATE TEMP TABLE custody_wallets (
      id TEXT PRIMARY KEY,
      custody_config_id TEXT NOT NULL,
      wallet_id TEXT NOT NULL,
      status TEXT NOT NULL
    )`);
    await client.query(`CREATE TEMP TABLE api_key_wallet_policy_bindings (
      id TEXT PRIMARY KEY,
      api_key_id TEXT NOT NULL,
      binding_scope TEXT NOT NULL,
      wallet_id TEXT,
      custody_wallet_id TEXT,
      CONSTRAINT api_key_wallet_policy_bindings_wallet_check CHECK (
        (binding_scope = 'all' AND wallet_id IS NULL AND custody_wallet_id IS NULL)
        OR (binding_scope = 'selected' AND wallet_id IS NOT NULL)
      )
    )`);
    await client.query(`CREATE UNIQUE INDEX idx_api_key_wallet_policy_bindings_selected
      ON api_key_wallet_policy_bindings(api_key_id, wallet_id)
      WHERE binding_scope = 'selected'`);
    await client.query(
      `INSERT INTO api_keys (id, organization_id, project_id)
       VALUES ($1, $2, $3)`,
      ["key_project", "org_one", "project_one"]
    );
    await client.query(
      `INSERT INTO custody_configs
         (id, organization_id, project_id, status)
       VALUES
         ($1, $2, $3, $4),
         ($5, $6, $7, $8),
         ($9, $10, $11, $12),
         ($13, $14, $15, $16)`,
      [
        "config_unique",
        "org_one",
        "project_one",
        "active",
        "config_ambiguous_one",
        "org_one",
        "project_one",
        "active",
        "config_ambiguous_two",
        "org_one",
        "project_one",
        "active",
        "config_foreign_project",
        "org_one",
        "project_two",
        "active",
      ]
    );
    await client.query(
      `INSERT INTO custody_wallets
         (id, custody_config_id, wallet_id, status)
       VALUES
         ($1, $2, $3, $4),
         ($5, $6, $7, $8),
         ($9, $10, $11, $12),
         ($13, $14, $15, $16)`,
      [
        "custody_unique",
        "config_unique",
        "provider_unique",
        "active",
        "custody_unique_foreign",
        "config_foreign_project",
        "provider_unique",
        "active",
        "custody_ambiguous_one",
        "config_ambiguous_one",
        "provider_ambiguous",
        "active",
        "custody_ambiguous_two",
        "config_ambiguous_two",
        "provider_ambiguous",
        "active",
      ]
    );
    await client.query(
      `INSERT INTO api_key_wallet_policy_bindings
         (id, api_key_id, binding_scope, wallet_id, custody_wallet_id)
       VALUES
         ($1, $2, $3, $4, $5),
         ($6, $7, $8, $9, $10),
         ($11, $12, $13, $14, $15),
         ($16, $17, $18, $19, $20)`,
      [
        "binding_all",
        "key_project",
        "all",
        null,
        null,
        "binding_unique",
        "key_project",
        "selected",
        "provider_unique",
        null,
        "binding_ambiguous",
        "key_project",
        "selected",
        "provider_ambiguous",
        null,
        "binding_orphan",
        "key_project",
        "selected",
        "provider_missing",
        null,
      ]
    );

    await client.query(sql);

    const result = await client.query<{
      id: string;
      custody_wallet_id: string | null;
    }>(`SELECT id, custody_wallet_id
        FROM api_key_wallet_policy_bindings
        ORDER BY id`);
    expect(result.rows).toEqual([
      { id: "binding_all", custody_wallet_id: null },
      { id: "binding_unique", custody_wallet_id: "custody_unique" },
    ]);
    expect(sql).toMatch(
      /OR\s+\(\s*binding_scope = 'selected'\s+AND wallet_id IS NOT NULL\s+AND custody_wallet_id IS NOT NULL\s*\)/
    );
    expect(sql).toMatch(
      /ON api_key_wallet_policy_bindings\(api_key_id, custody_wallet_id\)\s+WHERE binding_scope = 'selected'/
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
