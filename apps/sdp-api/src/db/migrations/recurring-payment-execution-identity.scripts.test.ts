import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const scriptsDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts"
);
const catchUpPath = path.join(
  scriptsDirectory,
  "backfill-recurring-payment-execution-identity.sql"
);
const auditPath = path.join(scriptsDirectory, "audit-recurring-payment-execution-identity.sql");

function catchUpTransaction(sql: string): string {
  const start = sql.indexOf("BEGIN;");
  const end = sql.indexOf("COMMIT;", start);
  if (start === -1 || end === -1) throw new Error("catch-up transaction is missing");
  return sql.slice(start + "BEGIN;".length, end);
}

function auditSection(sql: string, section: string, nextSection?: string): string {
  const marker = `\\echo '=== ${section}`;
  const markerIndex = sql.indexOf(marker);
  const start = markerIndex === -1 ? -1 : sql.indexOf("\n", markerIndex) + 1;
  const end = nextSection ? sql.indexOf(`\\echo '=== ${nextSection}`, start) : sql.length;
  if (start <= 0 || end === -1) throw new Error(`audit section ${section} is missing`);
  return sql.slice(start, end);
}

function withoutPsqlCommands(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n");
}

it("catches up exactly-one pins and audits unresolved or mismatched identity", async () => {
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
      source_custody_wallet_id TEXT, source_wallet_id TEXT NOT NULL,
      source_address TEXT NOT NULL, status TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);
    await client.query(`CREATE TEMP TABLE payment_recurring_payment_update_attempts (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
      recurring_payment_id TEXT NOT NULL, new_source_custody_wallet_id TEXT,
      changed_fields TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      after_values JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL, stage TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);

    await client.query(`INSERT INTO custody_configs (id, organization_id, project_id) VALUES
      ('cfg_project', 'org_a', 'prj_a'),
      ('cfg_duplicate', 'org_a', 'prj_a'),
      ('cfg_foreign', 'org_a', 'prj_b')`);
    await client.query(`INSERT INTO custody_connections (id, organization_id, project_id) VALUES
      ('conn_project', 'org_a', 'prj_a')`);
    await client.query(`INSERT INTO custody_wallets
      (id, custody_config_id, custody_connection_id, wallet_id, public_key) VALUES
      ('cw_project', 'cfg_project', NULL, 'provider_project', 'addr_project'),
      ('cw_connection', NULL, 'conn_project', 'provider_connection', 'addr_connection'),
      ('cw_duplicate_a', 'cfg_project', NULL, 'provider_duplicate', 'addr_duplicate'),
      ('cw_duplicate_b', 'cfg_duplicate', NULL, 'provider_duplicate', 'addr_duplicate'),
      ('cw_foreign', 'cfg_foreign', NULL, 'provider_foreign', 'addr_foreign')`);
    await client.query(`INSERT INTO payment_recurring_payments
      (id, organization_id, project_id, source_custody_wallet_id,
       source_wallet_id, source_address, status) VALUES
      ('rp_project', 'org_a', 'prj_a', NULL, 'provider_project', 'addr_project', 'activating'),
      ('rp_connection', 'org_a', 'prj_a', NULL,
       'provider_connection', 'addr_connection', 'active'),
      ('rp_ambiguous', 'org_a', 'prj_a', NULL,
       'provider_duplicate', 'addr_duplicate', 'active'),
      ('rp_mismatched', 'org_a', 'prj_a', 'cw_foreign',
       'provider_project', 'addr_project', 'active')`);

    const catchUpSql = catchUpTransaction(readFileSync(catchUpPath, "utf8"));
    await client.query(catchUpSql);
    await client.query(catchUpSql);

    expect(
      (
        await client.query(
          `SELECT id, source_custody_wallet_id FROM payment_recurring_payments ORDER BY id`
        )
      ).rows
    ).toEqual([
      { id: "rp_ambiguous", source_custody_wallet_id: null },
      { id: "rp_connection", source_custody_wallet_id: "cw_connection" },
      { id: "rp_mismatched", source_custody_wallet_id: "cw_foreign" },
      { id: "rp_project", source_custody_wallet_id: "cw_project" },
    ]);

    await client.query(`INSERT INTO payment_recurring_payment_update_attempts
      (id, organization_id, project_id, recurring_payment_id,
       new_source_custody_wallet_id, changed_fields, after_values, status, stage) VALUES
      ('update_foreign', 'org_a', 'prj_a', 'rp_project', 'cw_foreign',
       ARRAY['sourceCustodyWalletId'], '{"sourceCustodyWalletId":"cw_foreign"}'::jsonb,
       'failed', 'create_plan'),
      ('update_missing', 'org_a', 'prj_a', 'rp_project', NULL,
       ARRAY['sourceCustodyWalletId'], '{"sourceCustodyWalletId":"cw_project"}'::jsonb,
       'failed', 'claim'),
      ('update_legacy_missing', 'org_a', 'prj_a', 'rp_project', NULL,
       ARRAY['sourceWalletId'], '{"sourceWalletId":"provider_project"}'::jsonb,
       'failed', 'claim')`);

    const auditSql = readFileSync(auditPath, "utf8");
    await client.query(withoutPsqlCommands(auditSql));
    const mismatchRows = await client.query<{ id: string; resource: string }>(
      auditSection(auditSql, "2.", "2a.")
    );
    expect(mismatchRows.rows).toEqual(
      expect.arrayContaining([
        { custody_wallet_id: "cw_foreign", id: "rp_mismatched", resource: "recurring_payment" },
        { custody_wallet_id: "cw_foreign", id: "update_foreign", resource: "update_attempt" },
      ])
    );
    expect((await client.query(auditSection(auditSql, "2a."))).rows).toEqual([
      {
        id: "update_legacy_missing",
        organization_id: "org_a",
        project_id: "prj_a",
        recurring_payment_id: "rp_project",
        stage: "claim",
        status: "failed",
      },
      {
        id: "update_missing",
        organization_id: "org_a",
        project_id: "prj_a",
        recurring_payment_id: "rp_project",
        stage: "claim",
        status: "failed",
      },
    ]);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
