import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0080_issuance_execution_identity.sql"
);

it("pins only exactly-one pending Issuance draft wallets", async () => {
  const sql = readFileSync(migrationPath, "utf8");
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE custody_configs (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT
    )`);
    await client.query(`CREATE TEMP TABLE custody_connections (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL
    )`);
    await client.query(`CREATE TEMP TABLE custody_wallets (
      id TEXT PRIMARY KEY, custody_config_id TEXT, custody_connection_id TEXT,
      wallet_id TEXT NOT NULL, public_key TEXT NOT NULL
    )`);
    await client.query(`CREATE TEMP TABLE issued_tokens (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
      signing_wallet_id TEXT, mint_address TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);
    await client.query(`CREATE TEMP TABLE issuance_transactions (
      id TEXT PRIMARY KEY, token_id TEXT NOT NULL, organization_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);

    await client.query(`INSERT INTO custody_configs (id, organization_id, project_id) VALUES
      ('cfg_project', 'org_a', 'prj_a'),
      ('cfg_org', 'org_a', NULL),
      ('cfg_duplicate', 'org_a', 'prj_a'),
      ('cfg_foreign_project', 'org_a', 'prj_b'),
      ('cfg_foreign_org', 'org_b', 'prj_a')`);
    await client.query(`INSERT INTO custody_connections (id, organization_id, project_id) VALUES
      ('conn_project', 'org_a', 'prj_a')`);
    await client.query(`INSERT INTO custody_wallets
      (id, custody_config_id, custody_connection_id, wallet_id, public_key) VALUES
      ('cw_project', 'cfg_project', NULL, 'provider_project', 'addr_project'),
      ('cw_org', 'cfg_org', NULL, 'provider_org', 'addr_org'),
      ('cw_connection', NULL, 'conn_project', 'provider_connection', 'addr_connection'),
      ('cw_duplicate_a', 'cfg_project', NULL, 'provider_duplicate', 'addr_duplicate_a'),
      ('cw_duplicate_b', 'cfg_duplicate', NULL, 'provider_duplicate', 'addr_duplicate_b'),
      ('cw_foreign_project', 'cfg_foreign_project', NULL, 'provider_foreign', 'addr_foreign'),
      ('cw_foreign_org', 'cfg_foreign_org', NULL, 'provider_foreign', 'addr_foreign')`);
    await client.query(`INSERT INTO issued_tokens
      (id, organization_id, project_id, signing_wallet_id, mint_address, status) VALUES
      ('tok_project', 'org_a', 'prj_a', 'provider_project', NULL, 'pending'),
      ('tok_org', 'org_a', 'prj_a', 'provider_org', NULL, 'pending'),
      ('tok_connection', 'org_a', 'prj_a', 'provider_connection', NULL, 'pending'),
      ('tok_ambiguous', 'org_a', 'prj_a', 'provider_duplicate', NULL, 'pending'),
      ('tok_foreign', 'org_a', 'prj_a', 'provider_foreign', NULL, 'pending'),
      ('tok_deployed', 'org_a', 'prj_a', 'provider_project', 'mint_deployed', 'active'),
      ('tok_no_selection', 'org_a', 'prj_a', NULL, NULL, 'pending')`);
    await client.query(`INSERT INTO issuance_transactions (id, token_id, organization_id) VALUES
      ('ttx_legacy', 'tok_deployed', 'org_a')`);

    await client.query(sql);

    expect(
      (
        await client.query(
          `SELECT id, signing_custody_wallet_id, signing_wallet_id
             FROM issued_tokens
            ORDER BY id`
        )
      ).rows
    ).toEqual([
      {
        id: "tok_ambiguous",
        signing_custody_wallet_id: null,
        signing_wallet_id: "provider_duplicate",
      },
      {
        id: "tok_connection",
        signing_custody_wallet_id: "cw_connection",
        signing_wallet_id: "provider_connection",
      },
      {
        id: "tok_deployed",
        signing_custody_wallet_id: null,
        signing_wallet_id: "provider_project",
      },
      {
        id: "tok_foreign",
        signing_custody_wallet_id: null,
        signing_wallet_id: "provider_foreign",
      },
      { id: "tok_no_selection", signing_custody_wallet_id: null, signing_wallet_id: null },
      {
        id: "tok_org",
        signing_custody_wallet_id: "cw_org",
        signing_wallet_id: "provider_org",
      },
      {
        id: "tok_project",
        signing_custody_wallet_id: "cw_project",
        signing_wallet_id: "provider_project",
      },
    ]);
    expect(
      (
        await client.query(
          "SELECT custody_wallet_id FROM issuance_transactions WHERE id = 'ttx_legacy'"
        )
      ).rows
    ).toEqual([{ custody_wallet_id: null }]);

    const constraints = await client.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype
         FROM pg_constraint
        WHERE conname IN (
          'issued_tokens_signing_custody_wallet_id_fkey',
          'issuance_transactions_custody_wallet_id_fkey'
        )
          AND conrelid IN (
            'pg_temp.issued_tokens'::regclass,
            'pg_temp.issuance_transactions'::regclass
          )
        ORDER BY conname`
    );
    expect(constraints.rows).toEqual([
      { conname: "issuance_transactions_custody_wallet_id_fkey", confdeltype: "a" },
      { conname: "issued_tokens_signing_custody_wallet_id_fkey", confdeltype: "a" },
    ]);
    expect(
      (
        await client.query(`SELECT
          to_regclass('pg_temp.idx_issued_tokens_signing_custody_wallet_id') IS NOT NULL
            AS token_index_exists,
          to_regclass('pg_temp.idx_issuance_transactions_custody_wallet_id') IS NOT NULL
            AS transaction_index_exists`)
      ).rows
    ).toEqual([{ token_index_exists: true, transaction_index_exists: true }]);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
