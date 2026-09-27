import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const migrationsDirectory = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(fileName: string): string {
  return path.join(migrationsDirectory, "postgres", fileName);
}

/**
 * SOLA9-596 / APE-794 regression: migration 0073 pinned recurring-payment
 * parents but left predecessor-written, in-flight source-changing replacement
 * attempts with the legacy `sourceWalletId` snapshot vocabulary and a NULL
 * replacement custody-wallet identity. The 0119 backfill must resolve those
 * identities tenant-scoped from the legacy snapshots, normalize the snapshot
 * vocabulary, and quarantine ambiguous or incomplete rows instead of guessing.
 */
it("backfills, normalizes, and quarantines legacy recurring update attempts", async () => {
  const identitySql = readFileSync(
    migrationPath("0073_recurring_payment_execution_identity.sql"),
    "utf8"
  );
  const legacySnapshotSql = readFileSync(
    migrationPath("0119_recurring_update_attempt_legacy_snapshots.sql"),
    "utf8"
  );
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
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
      recurring_payment_id TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
      stage TEXT NOT NULL, error TEXT,
      changed_fields TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      before_values JSONB NOT NULL DEFAULT '{}'::jsonb,
      after_values JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);

    await client.query(`INSERT INTO custody_configs (id, organization_id, project_id) VALUES
      ('cfg_project', 'org_a', 'prj_a'),
      ('cfg_dup_a', 'org_a', 'prj_a'),
      ('cfg_dup_b', 'org_a', 'prj_a'),
      ('cfg_org_wide', 'org_a', NULL),
      ('cfg_foreign_org', 'org_b', 'prj_a'),
      ('cfg_foreign_project', 'org_a', 'prj_b')`);
    await client.query(`INSERT INTO custody_connections (id, organization_id, project_id) VALUES
      ('conn_project', 'org_a', 'prj_a')`);
    await client.query(`INSERT INTO custody_wallets
      (id, custody_config_id, custody_connection_id, wallet_id, public_key) VALUES
      ('cw_old', 'cfg_project', NULL, 'wallet_old', 'addr_old'),
      ('cw_new', 'cfg_project', NULL, 'wallet_new', 'addr_new'),
      ('cw_dup_a', 'cfg_dup_a', NULL, 'wallet_dup', 'addr_dup'),
      ('cw_dup_b', 'cfg_dup_b', NULL, 'wallet_dup', 'addr_dup'),
      ('cw_org_wide', 'cfg_org_wide', NULL, 'wallet_org', 'addr_org'),
      ('cw_foreign_org', 'cfg_foreign_org', NULL, 'wallet_new', 'addr_new'),
      ('cw_foreign_project', 'cfg_foreign_project', NULL, 'wallet_foreign', 'addr_foreign'),
      ('cw_connection', NULL, 'conn_project', 'wallet_conn', 'addr_conn')`);
    await client.query(`INSERT INTO payment_recurring_payments
      (id, organization_id, project_id, source_wallet_id, source_address) VALUES
      ('rp_ok', 'org_a', 'prj_a', 'wallet_old', 'addr_old'),
      ('rp_unpinned', 'org_a', 'prj_a', 'wallet_dup', 'addr_dup')`);

    await client.query(identitySql);

    // Predecessor rows: legacy snapshot vocabulary (wallet_id values under the
    // sourceWalletId key) and no replacement custody-wallet identity.
    await client.query(`INSERT INTO payment_recurring_payment_update_attempts
      (id, organization_id, project_id, recurring_payment_id, mode, status,
       stage, changed_fields, before_values, after_values) VALUES
      ('a_resolvable', 'org_a', 'prj_a', 'rp_ok', 'replacement', 'processing',
       'create_plan', ARRAY['amount', 'sourceWalletId']::text[],
       '{"sourceWalletId":"wallet_old","amount":"25.00"}'::jsonb,
       '{"sourceWalletId":"wallet_new","amount":"35.00"}'::jsonb),
      ('a_connection', 'org_a', 'prj_a', 'rp_ok', 'replacement', 'processing',
       'create_plan', ARRAY['sourceWalletId']::text[],
       '{"sourceWalletId":"wallet_old"}'::jsonb,
       '{"sourceWalletId":"wallet_conn"}'::jsonb),
      ('a_org_wide', 'org_a', 'prj_a', 'rp_ok', 'replacement', 'processing',
       'create_plan', ARRAY['sourceWalletId']::text[],
       '{"sourceWalletId":"wallet_old"}'::jsonb,
       '{"sourceWalletId":"wallet_org"}'::jsonb),
      ('a_ambiguous', 'org_a', 'prj_a', 'rp_ok', 'replacement', 'processing',
       'create_plan', ARRAY['sourceWalletId']::text[],
       '{"sourceWalletId":"wallet_old"}'::jsonb,
       '{"sourceWalletId":"wallet_dup"}'::jsonb),
      ('a_unpinned', 'org_a', 'prj_a', 'rp_unpinned', 'replacement', 'processing',
       'create_plan', ARRAY['sourceWalletId']::text[],
       '{"sourceWalletId":"wallet_dup"}'::jsonb,
       '{"sourceWalletId":"wallet_new"}'::jsonb),
      ('a_missing_value', 'org_a', 'prj_a', 'rp_ok', 'replacement', 'processing',
       'create_plan', ARRAY['sourceWalletId']::text[],
       '{"sourceWalletId":"wallet_old"}'::jsonb, '{}'::jsonb),
      ('a_foreign_project', 'org_a', 'prj_a', 'rp_ok', 'replacement', 'processing',
       'create_plan', ARRAY['sourceWalletId']::text[],
       '{"sourceWalletId":"wallet_old"}'::jsonb,
       '{"sourceWalletId":"wallet_foreign"}'::jsonb),
      ('a_metadata', 'org_a', 'prj_a', 'rp_ok', 'metadata_schedule', 'processing',
       'update_plan', ARRAY['metadataUri']::text[],
       '{"sourceWalletId":"wallet_old","metadataUri":"https://before"}'::jsonb,
       '{"sourceWalletId":"wallet_old","metadataUri":"https://after"}'::jsonb),
      ('a_confirmed', 'org_a', 'prj_a', 'rp_ok', 'replacement', 'confirmed',
       'finalize', ARRAY['sourceWalletId']::text[],
       '{"sourceWalletId":"wallet_old"}'::jsonb,
       '{"sourceWalletId":"wallet_new"}'::jsonb)`);

    await client.query(legacySnapshotSql);

    const attempts = await client.query<{
      id: string;
      status: string;
      error: string | null;
      new_source_custody_wallet_id: string | null;
      changed_fields: string[];
      before_values: Record<string, unknown>;
      after_values: Record<string, unknown>;
    }>(`SELECT id, status, error, new_source_custody_wallet_id, changed_fields,
               before_values, after_values
          FROM payment_recurring_payment_update_attempts
         ORDER BY id`);

    expect(attempts.rows).toEqual([
      {
        id: "a_ambiguous",
        status: "failed",
        error: expect.stringContaining("could not be resolved"),
        new_source_custody_wallet_id: null,
        changed_fields: ["sourceWalletId"],
        before_values: { sourceWalletId: "wallet_old" },
        after_values: { sourceWalletId: "wallet_dup" },
      },
      {
        id: "a_confirmed",
        status: "confirmed",
        error: null,
        new_source_custody_wallet_id: null,
        changed_fields: ["sourceWalletId"],
        before_values: { sourceWalletId: "wallet_old" },
        after_values: { sourceWalletId: "wallet_new" },
      },
      {
        id: "a_connection",
        status: "processing",
        error: null,
        new_source_custody_wallet_id: "cw_connection",
        changed_fields: ["sourceCustodyWalletId"],
        before_values: { sourceCustodyWalletId: "cw_old" },
        after_values: { sourceCustodyWalletId: "cw_connection" },
      },
      {
        id: "a_foreign_project",
        status: "failed",
        error: expect.stringContaining("could not be resolved"),
        new_source_custody_wallet_id: null,
        changed_fields: ["sourceWalletId"],
        before_values: { sourceWalletId: "wallet_old" },
        after_values: { sourceWalletId: "wallet_foreign" },
      },
      {
        id: "a_metadata",
        status: "processing",
        error: null,
        new_source_custody_wallet_id: null,
        changed_fields: ["metadataUri"],
        before_values: { sourceCustodyWalletId: "cw_old", metadataUri: "https://before" },
        after_values: { sourceCustodyWalletId: "cw_old", metadataUri: "https://after" },
      },
      {
        id: "a_missing_value",
        status: "failed",
        error: expect.stringContaining("could not be resolved"),
        new_source_custody_wallet_id: null,
        changed_fields: ["sourceWalletId"],
        before_values: { sourceWalletId: "wallet_old" },
        after_values: {},
      },
      {
        id: "a_org_wide",
        status: "processing",
        error: null,
        new_source_custody_wallet_id: "cw_org_wide",
        changed_fields: ["sourceCustodyWalletId"],
        before_values: { sourceCustodyWalletId: "cw_old" },
        after_values: { sourceCustodyWalletId: "cw_org_wide" },
      },
      {
        id: "a_resolvable",
        status: "processing",
        error: null,
        new_source_custody_wallet_id: "cw_new",
        changed_fields: ["amount", "sourceCustodyWalletId"],
        before_values: { sourceCustodyWalletId: "cw_old", amount: "25.00" },
        after_values: { sourceCustodyWalletId: "cw_new", amount: "35.00" },
      },
      {
        id: "a_unpinned",
        status: "failed",
        error: expect.stringContaining("could not be resolved"),
        new_source_custody_wallet_id: null,
        changed_fields: ["sourceWalletId"],
        before_values: { sourceWalletId: "wallet_dup" },
        after_values: { sourceWalletId: "wallet_new" },
      },
    ]);

    // The recovery identity comparison in update.ts now holds for the
    // backfilled attempt: the exact replacement wallet is no longer rejected.
    const resolvable = attempts.rows.find((row) => row.id === "a_resolvable");
    expect(resolvable?.new_source_custody_wallet_id === "cw_new").toBe(true);

    // Quarantined rows left the in-flight set, so a retry creates a fresh,
    // exactly-pinned attempt instead of failing recovery forever.
    const inFlight = await client.query<{ id: string }>(
      `SELECT id
         FROM payment_recurring_payment_update_attempts
        WHERE status = 'processing'
          AND changed_fields @> ARRAY['sourceWalletId']::text[]`
    );
    expect(inFlight.rows).toEqual([]);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
