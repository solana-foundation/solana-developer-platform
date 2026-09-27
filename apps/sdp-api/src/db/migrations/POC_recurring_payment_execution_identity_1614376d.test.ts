import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { env } from "@/test/helpers/env";

/**
 * Proof statement: prove that migration 0073 pins the recurring-payment row but
 * leaves a predecessor-created, source-changing processing attempt with a NULL
 * replacement custody-wallet id. The current recovery comparison therefore
 * rejects the exact replacement wallet forever, while the same comparison
 * succeeds when the attempt field is populated. This uses only a real
 * PostgreSQL transaction and the repository migration SQL; no provider or RPC
 * behavior is mocked because the rejection occurs before replacement execution.
 */
it("leaves a predecessor source-changing attempt unrecoverable", async () => {
  const migrationPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0073_recurring_payment_execution_identity.sql"
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
      stage TEXT NOT NULL, changed_fields TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      before_values JSONB NOT NULL DEFAULT '{}'::jsonb,
      after_values JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);

    await client.query(`INSERT INTO custody_configs (id, organization_id, project_id)
      VALUES ('cfg_project', 'org_a', 'prj_a')`);
    await client.query(`INSERT INTO custody_wallets
      (id, custody_config_id, wallet_id, public_key) VALUES
      ('cw_old', 'cfg_project', 'wallet_old', 'addr_old'),
      ('cw_new', 'cfg_project', 'wallet_new', 'addr_new')`);
    await client.query(`INSERT INTO payment_recurring_payments
      (id, organization_id, project_id, source_wallet_id, source_address)
      VALUES ('rp_source_change', 'org_a', 'prj_a', 'wallet_old', 'addr_old')`);

    // This is the predecessor's INSERT shape: it has no column for the field
    // introduced by 0073, even though the attempt is a source-wallet change.
    await client.query(`INSERT INTO payment_recurring_payment_update_attempts
      (id, organization_id, project_id, recurring_payment_id, mode, status,
       stage, changed_fields, before_values, after_values)
      VALUES ('attempt_before_migration', 'org_a', 'prj_a', 'rp_source_change',
              'replacement', 'processing', 'create_plan',
              ARRAY['sourceWalletId']::text[],
              '{"sourceWalletId":"wallet_old"}'::jsonb,
              '{"sourceWalletId":"wallet_new"}'::jsonb)`);

    await client.query(readFileSync(migrationPath, "utf8"));

    const pinnedState = await client.query<{
      recurring_source_custody_wallet_id: string | null;
      attempt_new_source_custody_wallet_id: string | null;
    }>(`SELECT
          rp.source_custody_wallet_id AS recurring_source_custody_wallet_id,
          attempt.new_source_custody_wallet_id AS attempt_new_source_custody_wallet_id
        FROM payment_recurring_payments rp
        JOIN payment_recurring_payment_update_attempts attempt
          ON attempt.recurring_payment_id = rp.id
        WHERE rp.id = 'rp_source_change'
          AND attempt.id = 'attempt_before_migration'`);

    expect(pinnedState.rows).toEqual([
      {
        recurring_source_custody_wallet_id: "cw_old",
        attempt_new_source_custody_wallet_id: null,
      },
    ]);

    // The predecessor can also create this same NULL-valued row after the DDL
    // has committed while it is still serving production traffic.
    await client.query(`INSERT INTO payment_recurring_payment_update_attempts
      (id, organization_id, project_id, recurring_payment_id, mode, status,
       stage, changed_fields, before_values, after_values)
      VALUES ('attempt_after_column', 'org_a', 'prj_a', 'rp_source_change',
              'replacement', 'processing', 'authorize_subscription',
              ARRAY['sourceWalletId']::text[],
              '{"sourceWalletId":"wallet_old"}'::jsonb,
              '{"sourceWalletId":"wallet_new"}'::jsonb)`);

    const nullAttempts = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count
      FROM payment_recurring_payment_update_attempts
      WHERE mode = 'replacement' AND status = 'processing'
        AND new_source_custody_wallet_id IS NULL`);
    expect(nullAttempts.rows[0]?.count).toBe("2");

    // This is the current update.ts recovery invariant:
    // existing.new_source_custody_wallet_id === input.newSourceCustodyWalletId.
    const requestedReplacementCustodyWalletId = "cw_new";
    const nullAttempt = null;
    expect(nullAttempt === requestedReplacementCustodyWalletId).toBe(false);

    await client.query(`UPDATE payment_recurring_payment_update_attempts
      SET new_source_custody_wallet_id = 'cw_new'
      WHERE id = 'attempt_after_column'`);
    const repairedAttempt = await client.query<{ new_source_custody_wallet_id: string | null }>(
      `SELECT new_source_custody_wallet_id
         FROM payment_recurring_payment_update_attempts
        WHERE id = 'attempt_after_column'`
    );
    expect(repairedAttempt.rows[0]?.new_source_custody_wallet_id).toBe(
      requestedReplacementCustodyWalletId
    );
    expect(
      repairedAttempt.rows[0]?.new_source_custody_wallet_id === requestedReplacementCustodyWalletId
    ).toBe(true);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
