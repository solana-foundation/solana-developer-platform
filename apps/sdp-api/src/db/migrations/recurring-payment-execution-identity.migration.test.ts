import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0073_recurring_payment_execution_identity.sql"
);

it("pins only exactly-one tenant-scoped recurring payment sources", async () => {
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
    await client.query(`CREATE TEMP TABLE payment_recurring_payments (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
      source_wallet_id TEXT NOT NULL, source_address TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);
    await client.query(`CREATE TEMP TABLE payment_recurring_payment_update_attempts (
      id TEXT PRIMARY KEY, recurring_payment_id TEXT NOT NULL
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
      ('cw_duplicate_a', 'cfg_project', NULL, 'provider_duplicate', 'addr_duplicate'),
      ('cw_duplicate_b', 'cfg_duplicate', NULL, 'provider_duplicate', 'addr_duplicate'),
      ('cw_foreign_project', 'cfg_foreign_project', NULL, 'provider_foreign', 'addr_foreign'),
      ('cw_foreign_org', 'cfg_foreign_org', NULL, 'provider_foreign', 'addr_foreign')`);
    await client.query(`INSERT INTO payment_recurring_payments
      (id, organization_id, project_id, source_wallet_id, source_address) VALUES
      ('rp_project', 'org_a', 'prj_a', 'provider_project', 'addr_project'),
      ('rp_org', 'org_a', 'prj_a', 'provider_org', 'addr_org'),
      ('rp_connection', 'org_a', 'prj_a', 'provider_connection', 'addr_connection'),
      ('rp_ambiguous', 'org_a', 'prj_a', 'provider_duplicate', 'addr_duplicate'),
      ('rp_foreign', 'org_a', 'prj_a', 'provider_foreign', 'addr_foreign')`);

    await client.query(sql);

    expect(
      (
        await client.query(
          `SELECT id, source_custody_wallet_id
             FROM payment_recurring_payments
            ORDER BY id`
        )
      ).rows
    ).toEqual([
      { id: "rp_ambiguous", source_custody_wallet_id: null },
      { id: "rp_connection", source_custody_wallet_id: "cw_connection" },
      { id: "rp_foreign", source_custody_wallet_id: null },
      { id: "rp_org", source_custody_wallet_id: "cw_org" },
      { id: "rp_project", source_custody_wallet_id: "cw_project" },
    ]);

    const constraints = await client.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype
         FROM pg_constraint
        WHERE conname IN (
          'payment_recurring_payments_source_custody_wallet_id_fkey',
          'payment_recurring_updates_new_source_custody_wallet_id_fkey'
        )
          AND conrelid IN (
            'pg_temp.payment_recurring_payments'::regclass,
            'pg_temp.payment_recurring_payment_update_attempts'::regclass
          )
        ORDER BY conname`
    );
    expect(constraints.rows).toEqual([
      {
        conname: "payment_recurring_payments_source_custody_wallet_id_fkey",
        confdeltype: "a",
      },
      {
        conname: "payment_recurring_updates_new_source_custody_wallet_id_fkey",
        confdeltype: "a",
      },
    ]);
    expect(
      (
        await client.query(`SELECT
          to_regclass('pg_temp.idx_payment_recurring_payments_source_custody_wallet_id') IS NOT NULL
            AS parent_index_exists,
          to_regclass('pg_temp.idx_recurring_updates_new_source_custody_wallet_id') IS NOT NULL
            AS attempt_index_exists`)
      ).rows
    ).toEqual([{ attempt_index_exists: true, parent_index_exists: true }]);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
