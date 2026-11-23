import { randomUUID } from "node:crypto";
import { copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runPostgresMigrations } from "@/scripts/lib/run-postgres-migrations.mjs";
import { adminDatabaseUrl } from "@/test/helpers/env";
import {
  CHECK_VIOLATION,
  expectSqlstate,
  FK_VIOLATION,
  RAISE_EXCEPTION,
  seedOrgProject,
} from "@/test/helpers/migration-db";
import { TEST_RUNTIME_ROLE } from "@/test/runtime-role";

const migrationFile = "0239_earn_retire_unused_storage.sql";
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres");
const migrationSql = readFileSync(path.join(migrationsDir, migrationFile), "utf8");
const retiredTables = [
  "earn_external_wallet_transactions",
  "earn_external_wallet_withdrawal_request_transactions",
  "earn_split_swap_advisories",
  "earn_provider_actions",
  "earn_provider_wallets",
] as const;
const preservedTables = [
  "earn_positions",
  "earn_movements",
  "earn_wallet_transactions",
  "earn_wallet_withdrawal_request_transactions",
  "earn_vault_withdrawal_requests",
  "earn_vault_withdrawal_request_actions",
  "earn_vault_withdrawal_request_reservations",
  "earn_vault_withdrawal_request_pda_leases",
  "operations",
  "operation_attempts",
] as const;
const org = "org_earn_schema_cleanup";
const project = "proj_earn_schema_cleanup";
const owner = "11111111111111111111111111111111";
const custodyOwner = "22222222222222222222222222222222";
const vault = "33333333333333333333333333333333";
const mint = "44444444444444444444444444444444";
const share = "55555555555555555555555555555555";
const databaseName = `earn_cleanup_${randomUUID().replaceAll("-", "")}_test`;
let admin: Client;
let client: Client;
let fixtureDir: string | undefined;
let databaseCreated = false;

// A second database on the disposable test container holds the complete parent
// schema. Small temporary table substitutes miss view, trigger and FK edges.
beforeAll(async () => {
  admin = new Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${databaseName}`;
  fixtureDir = mkdtempSync(path.join(tmpdir(), "earn-cleanup-sql-"));
  for (const file of readdirSync(migrationsDir)) {
    if (file.endsWith(".sql") && file.localeCompare(migrationFile) < 0) {
      copyFileSync(path.join(migrationsDir, file), path.join(fixtureDir, file));
    }
  }
  cpSync(path.join(migrationsDir, "repeatable"), path.join(fixtureDir, "repeatable"), {
    recursive: true,
  });
  await runPostgresMigrations({ databaseUrl: url.toString(), migrationsDir: fixtureDir });
  client = new Client({ connectionString: url.toString() });
  await client.connect();
  await client.query(`GRANT USAGE ON SCHEMA public TO ${TEST_RUNTIME_ROLE}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${TEST_RUNTIME_ROLE}`
  );
}, 60_000);

afterAll(async () => {
  await client?.end();
  if (databaseCreated) await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin?.end();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true });
});
beforeEach(async () => {
  await client.query("BEGIN");
  await seedOrgProject(client, "earn_schema_cleanup");
  await seedOrgProject(client, "earn_schema_cleanup_other");
  await seedGraph();
});
afterEach(async () => {
  await client.query("ROLLBACK");
});

async function seedGraph(): Promise<void> {
  await client.query(
    `INSERT INTO custody_configs
      (id, organization_id, project_id, provider, config_encrypted, status)
     VALUES ('cleanup_config', $1, $2, 'local', 'test-only', 'active');`,
    [org, project]
  );
  await client.query(
    `INSERT INTO custody_wallets
      (id, custody_config_id, wallet_id, public_key, status)
     VALUES ('cleanup_wallet', 'cleanup_config', 'test-wallet', $1, 'active')`,
    [custodyOwner]
  );
  await client.query(
    `INSERT INTO earn_provider_wallets
      (id, organization_id, project_id, environment, provider, provider_wallet_ref, created_by)
     VALUES ('retired_wallet', $1, $2, 'sandbox', 'retired-provider', 'test-account',
       'user_earn_schema_cleanup')`,
    [org, project]
  );
  for (const [id, custodyWalletId, ownerAddress] of [
    ["live_owner", null, owner],
    ["live_custody", "cleanup_wallet", null],
  ]) {
    await client.query(
      `INSERT INTO earn_positions
        (id, organization_id, project_id, environment, provider, kind,
         custody_wallet_id, owner_address, vault_address, token_mint, share_mint,
         label, activated_at)
       VALUES ($1, $2, $3, 'sandbox', 'veda', 'vault_direct', $4, $5, $6, $7, $8,
         $1, sdp_iso_now())`,
      [id, org, project, custodyWalletId, ownerAddress, vault, mint, share]
    );
    await client.query(
      `INSERT INTO earn_movements
        (id, organization_id, project_id, environment, provider, execution_model,
         direction, position_id, status, denomination, amount_requested,
         custody_wallet_id, owner_address, vault_address, signature,
         signed_transaction, last_valid_block_height, request_id, idempotency_fingerprint)
       VALUES ($1, $2, $3, 'sandbox', 'veda', 'vault_direct', 'deposit', $4,
         'requested', $5, '1', $6, $7, $8, $1, 'AQ==', 200, $1, 'test-fingerprint')`,
      [`movement_${id}`, org, project, id, mint, custodyWalletId, ownerAddress, vault]
    );
  }
  await client.query(
    `INSERT INTO earn_positions
      (id, organization_id, project_id, environment, provider, kind, provider_wallet_id, label)
     VALUES ('retired_position', $1, $2, 'sandbox', 'retired-provider', 'custodial',
       'retired_wallet', 'Retired program')`,
    [org, project]
  );
  await client.query(
    `INSERT INTO earn_movements
      (id, organization_id, project_id, environment, provider, execution_model,
       direction, position_id, status, denomination, amount_requested,
       request_id, idempotency_fingerprint)
     VALUES ('retired_movement', $1, $2, 'sandbox', 'retired-provider', 'custodial',
       'withdrawal', 'retired_position', 'requested', 'usd', '1', 'retired-key', 'test')`,
    [org, project]
  );
  await client.query(
    `INSERT INTO earn_vault_withdrawal_requests
      (id, organization_id, project_id, environment, provider, position_id,
       owner_address, vault_address, token_mint, share_mint, request_address,
       status, shares, quoted_assets, share_decimals, asset_decimals,
       discount_bps, maturity_timestamp, deadline_timestamp,
       client_request_id, idempotency_fingerprint)
     VALUES ('live_request', $1, $2, 'sandbox', 'veda', 'live_owner', $3, $4, $5, $6,
       'test-request-address', 'creating', '1', '1', 6, 6, 0, 10, 20, 'request-key', 'test')`,
    [org, project, owner, vault, mint, share]
  );
  await client.query(
    `INSERT INTO earn_vault_withdrawal_request_actions
      (id, organization_id, project_id, environment, withdrawal_request_id, action,
       status, signature, signed_transaction, last_valid_block_height,
       client_request_id, idempotency_fingerprint)
     VALUES ('live_action', $1, $2, 'sandbox', 'live_request', 'request', 'requested',
       'queue-signature', 'AQ==', 200, 'action-key', 'test')`,
    [org, project]
  );
  await client.query(
    `INSERT INTO earn_vault_withdrawal_request_reservations
      (id, organization_id, project_id, environment, provider, vault_address,
       owner_address, request_address, client_request_id, idempotency_fingerprint, expires_at)
     VALUES ('live_reservation', $1, $2, 'sandbox', 'veda', $3, $4,
       'test-request-address', 'reservation-key', 'test', '2099-01-01T00:00:00.000Z')`,
    [org, project, vault, owner]
  );
  await client.query(
    `INSERT INTO earn_vault_withdrawal_request_pda_leases
      (environment, request_address, lease_token, expires_at, occupied)
     VALUES ('sandbox', 'test-request-address', 'test-lease', '2099-01-01T00:00:00.000Z', true)`
  );
  for (const table of ["earn_wallet_transactions", "earn_external_wallet_transactions"]) {
    await client.query(
      `INSERT INTO ${table}
        (id, organization_id, project_id, environment, provider, direction,
         owner_address, vault_address, token_mint, share_mint, label, position_id,
         denomination, amount_requested, unsigned_transaction, last_valid_block_height,
         movement_id, consumed_at)
       VALUES ('direct_build', $1, $2, 'sandbox', 'veda', 'deposit', $3, $4, $5, $6,
         'Test build', 'live_owner', $5, '1', 'AQ==', 200, 'movement_live_owner', sdp_iso_now())`,
      [org, project, owner, vault, mint, share]
    );
  }
  for (const table of [
    "earn_wallet_withdrawal_request_transactions",
    "earn_external_wallet_withdrawal_request_transactions",
  ]) {
    await client.query(
      `INSERT INTO ${table}
        (id, organization_id, project_id, environment, provider, position_id, action,
         owner_address, vault_address, token_mint, share_mint, request_address,
         shares, quoted_assets, share_decimals, asset_decimals, discount_bps,
         maturity_timestamp, deadline_timestamp, unsigned_transaction, last_valid_block_height,
         consumed_action_id, consumed_at)
       VALUES ('queued_build', $1, $2, 'sandbox', 'veda', 'live_owner', 'request', $3, $4, $5, $6,
         'test-request-address', '1', '1', 6, 6, 0, 10, 20, 'AQ==', 200,
         'live_action', sdp_iso_now())`,
      [org, project, owner, vault, mint, share]
    );
  }
  await client.query("UPDATE earn_wallet_transactions SET operation_only = true");
  await client.query(
    "UPDATE earn_wallet_withdrawal_request_transactions SET operation_only = true"
  );
  await client.query(
    `INSERT INTO earn_provider_actions
      (id, organization_id, project_id, environment, provider, action, status,
       parent_movement_id, owner_address, vault_address, token_mint, share_mint,
       request_id, fingerprint, lease_until)
     VALUES ('retired_action', $1, $2, 'sandbox', 'retired-provider', 'cancellation',
       'preparing', 'retired_movement', $3, $4, $5, $6, 'provider-key', 'test', sdp_iso_now())`,
    [org, project, owner, vault, mint, share]
  );
  await client.query(
    `INSERT INTO earn_split_swap_advisories
      (id, organization_id, project_id, environment, provider, strategy_id,
       vault_address, owner_address, source_token_mint, deposit_token_mint,
       deposit_token_decimals, swap_source_amount, swap_min_out_amount,
       swap_min_out_atoms, swap_last_valid_block_height, baseline_deposit_token_atoms,
       resolved_at, resolution, resolved_by, resolving_movement_id)
     VALUES ('retired_advisory', $1, $2, 'sandbox', 'retired-provider', 'test-strategy',
       $3, $4, $5, $5, 6, '1', '1', '1000000', 200, '0',
       sdp_iso_now(), 'deposit_observed', 'system', 'retired_movement')`,
    [org, project, vault, owner, mint]
  );
  await client.query(
    `INSERT INTO operations
      (id, organization_id, project_id, environment, kind, status, intent, source,
       principal, action_principal, request_key, fingerprint, action_id, terms, resource_ref,
       next_check_at, recovery_check_count)
     VALUES ('live_operation', $1, $2, 'sandbox', 'earn.deposit', 'submitted',
       '{"kind":"earn.deposit"}', '{}', '{}', '{}', 'operation-key', 'test',
       'test-action', '{}', '{"type":"movement","id":"movement_live_owner"}',
       '2026-11-20T12:00:00.000Z', 3)`,
    [org, project]
  );
  await client.query(
    `INSERT INTO operation_attempts
      (id, operation_id, organization_id, project_id, environment, action_id,
       action_version, principal, signed_transaction, signature, last_valid_block_height,
       execution_requested_at)
     VALUES ('live_attempt', 'live_operation', $1, $2, 'sandbox', 'test-action', 1,
       '{}', 'AQ==', 'operation-signature', '200', sdp_iso_now())`,
    [org, project]
  );
}

async function liveRows(): Promise<Record<string, unknown>> {
  const rows: Record<string, unknown> = {};
  for (const table of preservedTables) {
    const filter =
      table === "earn_positions"
        ? "WHERE kind = 'vault_direct'"
        : table === "earn_movements"
          ? "WHERE execution_model = 'vault_direct'"
          : "";
    rows[table] = (
      await client.query(
        `SELECT to_jsonb(row) - 'provider_wallet_id' AS row FROM ${table} row ${filter}
       ORDER BY (to_jsonb(row) - 'provider_wallet_id')::text`
      )
    ).rows;
  }
  return rows;
}

async function preservedSchema(): Promise<unknown> {
  const constraints = await client.query(
    `SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint WHERE conrelid = ANY($1::regclass[])
       AND conname NOT IN ('earn_positions_kind_shape_check', 'earn_positions_provider_wallet_id_fkey')
     ORDER BY 1, 2`,
    [preservedTables]
  );
  const triggers = await client.query(
    `SELECT tgrelid::regclass::text AS table_name, tgname, pg_get_triggerdef(oid) AS definition
     FROM pg_trigger WHERE tgrelid = ANY($1::regclass[]) AND NOT tgisinternal ORDER BY 1, 2`,
    [preservedTables]
  );
  const functions = await client.query(
    `SELECT proname, pg_get_functiondef(oid) AS definition FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND (proname LIKE '%earn%' OR proname LIKE 'sdp_operation%') ORDER BY 1`
  );
  const policies = await client.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, p.polname,
       pg_get_expr(p.polqual, p.polrelid) AS read_check,
       pg_get_expr(p.polwithcheck, p.polrelid) AS write_check
     FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
     WHERE c.oid = ANY($1::regclass[]) ORDER BY 1, 4`,
    [preservedTables]
  );
  return {
    constraints: constraints.rows,
    triggers: triggers.rows,
    functions: functions.rows,
    policies: policies.rows,
  };
}

describe("0239 retired Earn storage", () => {
  it("contracts the complete parent graph and preserves live data, RLS and recovery guards", async () => {
    const applied = await client.query("SELECT version FROM schema_migrations");
    expect(applied.rowCount).toBeGreaterThan(200);
    expect(applied.rows.some((row) => row.version === "0238_earn_wallet_transactions.sql")).toBe(
      true
    );
    const beforeRows = await liveRows();
    for (const rows of Object.values(beforeRows)) expect(rows).not.toHaveLength(0);
    const beforeSchema = await preservedSchema();
    expect(
      (
        await client.query(
          "SELECT to_regclass('idx_earn_vault_withdrawal_requests_operator_live_address')::text AS name"
        )
      ).rows
    ).toEqual([{ name: "idx_earn_vault_withdrawal_requests_operator_live_address" }]);
    await client.query(migrationSql);
    expect(
      (
        await client.query(
          "SELECT to_regclass('idx_earn_vault_withdrawal_requests_operator_live_address')::text AS name"
        )
      ).rows
    ).toEqual([{ name: null }]);
    expect(
      (
        await client.query(
          "SELECT to_regclass('idx_earn_vault_withdrawal_requests_live_address')::text AS name"
        )
      ).rows
    ).toEqual([{ name: "idx_earn_vault_withdrawal_requests_live_address" }]);
    expect(await liveRows()).toEqual(beforeRows);
    expect(await preservedSchema()).toEqual(beforeSchema);
    for (const table of retiredTables) {
      expect((await client.query("SELECT to_regclass($1) AS relation", [table])).rows).toEqual([
        { relation: null },
      ]);
    }
    expect((await client.query("SELECT id FROM earn_positions ORDER BY id")).rows).toEqual([
      { id: "live_custody" },
      { id: "live_owner" },
    ]);
    expect((await client.query("SELECT id FROM earn_movements ORDER BY id")).rows).toEqual([
      { id: "movement_live_custody" },
      { id: "movement_live_owner" },
    ]);
    expect(
      (await client.query("SELECT id FROM unified_transactions WHERE module = 'earn' ORDER BY id"))
        .rows
    ).toEqual([{ id: "movement_live_custody" }, { id: "movement_live_owner" }]);
    expect(
      (
        await client.query(
          "SELECT attname FROM pg_attribute WHERE attrelid = 'earn_positions'::regclass AND attname = 'provider_wallet_id' AND NOT attisdropped"
        )
      ).rows
    ).toEqual([]);
  });

  it("fails atomically if an unexpected dependent table would be lost", async () => {
    await client.query(
      "CREATE TABLE cleanup_unexpected_dependency (build_id TEXT REFERENCES earn_external_wallet_transactions(id))"
    );
    const before = await liveRows();
    await expectSqlstate(client, () => client.query(migrationSql), "2BP01");
    expect(await liveRows()).toEqual(before);
    for (const table of retiredTables) {
      expect(
        (await client.query("SELECT to_regclass($1) AS relation", [table])).rows[0]?.relation
      ).toBe(table);
    }
  });

  it("refuses to erase a retired movement still referenced by a canonical build", async () => {
    await client.query("UPDATE earn_wallet_transactions SET movement_id = 'retired_movement'");
    await expectSqlstate(client, () => client.query(migrationSql), FK_VIOLATION);
    expect(
      (await client.query("SELECT id FROM earn_movements WHERE id = 'retired_movement'")).rowCount
    ).toBe(1);
  });

  it("keeps both build restrictions irreversible and the queue source bound to its wallet", async () => {
    await client.query(migrationSql);
    for (const table of [
      "earn_wallet_transactions",
      "earn_wallet_withdrawal_request_transactions",
    ]) {
      await expectSqlstate(
        client,
        () => client.query(`UPDATE ${table} SET operation_only = false`),
        RAISE_EXCEPTION
      );
    }
    await client.query(
      `UPDATE earn_wallet_withdrawal_request_transactions
       SET custody_wallet_id = 'cleanup_wallet', position_id = 'live_custody', owner_address = $1`,
      [custodyOwner]
    );
    await expectSqlstate(
      client,
      () =>
        client.query("UPDATE earn_wallet_withdrawal_request_transactions SET owner_address = $1", [
          owner,
        ]),
      FK_VIOLATION
    );
  });

  it("permits exactly one live signing source and rejects the retired position kind", async () => {
    await client.query(migrationSql);
    for (const [column, value] of [
      ["owner_address", null],
      ["custody_wallet_id", "cleanup_wallet"],
    ]) {
      await expectSqlstate(
        client,
        () =>
          client.query(`UPDATE earn_positions SET ${column} = $1 WHERE id = 'live_owner'`, [value]),
        CHECK_VIOLATION
      );
    }
    await expectSqlstate(
      client,
      () => client.query("UPDATE earn_positions SET kind = 'custodial' WHERE id = 'live_owner'"),
      CHECK_VIOLATION
    );
  });

  it("still enforces tenant reads and writes through the plain runtime role", async () => {
    await client.query(migrationSql);
    await client.query(`SET LOCAL ROLE ${TEST_RUNTIME_ROLE}`);
    await client.query("SELECT set_config('app.tenant_isolation_identity', 'tenant', true)");
    await client.query("SELECT set_config('app.tenant_isolation_organization_id', $1, true)", [
      org,
    ]);
    expect((await client.query("SELECT id FROM earn_wallet_transactions")).rowCount).toBe(1);
    expect(
      (await client.query("SELECT id FROM earn_wallet_withdrawal_request_transactions")).rowCount
    ).toBe(1);
    await expectSqlstate(
      client,
      () =>
        client.query(
          "UPDATE earn_wallet_transactions SET organization_id = 'org_earn_schema_cleanup_other'"
        ),
      "42501"
    );
    await client.query(
      "SELECT set_config('app.tenant_isolation_organization_id', 'org_earn_schema_cleanup_other', true)"
    );
    for (const table of preservedTables.filter((name) => !name.endsWith("_pda_leases"))) {
      expect((await client.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    }
  });
});
