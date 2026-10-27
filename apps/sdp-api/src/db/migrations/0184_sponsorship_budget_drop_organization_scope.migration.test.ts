import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runPostgresMigrations } from "@/scripts/lib/run-postgres-migrations.mjs";
import { adminDatabaseUrl as databaseUrl, env } from "@/test/helpers/env";
import { CHECK_VIOLATION, RAISE_EXCEPTION, seedOrgProject } from "@/test/helpers/migration-db";
import { seedTestDatabase } from "@/test/mocks/db";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres");
const migrationFile = "0184_sponsorship_budget_drop_organization_scope.sql";
const seededPolicyIds = [
  "sbp_devnet_global",
  "sbp_devnet_project_default",
  "sbp_mainnet_global",
  "sbp_mainnet_project_default",
];
let client: Client;

async function insertPolicyWithRevision(input: {
  id: string;
  scopeType: "organization" | "project";
  scopeId: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO sponsorship_budget_policies (
       id, network, scope_type, scope_id, enabled, per_transaction_lamports,
       hourly_lamports, daily_lamports, version, updated_by, update_reason
     ) VALUES ($1, 'devnet', $2, $3, TRUE, 10, 100, 1000, 1, 'test', 'seed')`,
    [input.id, input.scopeType, input.scopeId]
  );
  await client.query(
    `INSERT INTO sponsorship_budget_policy_revisions (
       id, policy_id, network, scope_type, scope_id, enabled, per_transaction_lamports,
       hourly_lamports, daily_lamports, version, changed_by, change_reason
     ) VALUES ('sbpr_' || $1::text || '_1', $1, 'devnet', $2, $3, TRUE, 10, 100, 1000, 1, 'test', 'seed')`,
    [input.id, input.scopeType, input.scopeId]
  );
}

async function idsOf(
  table: "sponsorship_budget_policies" | "sponsorship_budget_policy_revisions"
): Promise<string[]> {
  const result = await client.query<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`);
  return result.rows.map((row) => row.id);
}

beforeAll(async () => {
  client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("SET app.tenant_isolation_identity = 'system'");
});

afterAll(async () => {
  await client.end();
});

describe("0184 drop the organization sponsorship budget scope", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await client.query(
      `ALTER TABLE sponsorship_budget_policies
         DROP CONSTRAINT sponsorship_budget_policies_scope_type_check;
       ALTER TABLE sponsorship_budget_policies
         ADD CONSTRAINT sponsorship_budget_policies_scope_type_check
         CHECK (scope_type IN ('global', 'organization', 'project'));
       DELETE FROM schema_migrations WHERE version = '${migrationFile}'`
    );
  });

  afterEach(async () => {
    await seedTestDatabase(env);
    await runPostgresMigrations({ databaseUrl, migrationsDir });
  });

  it("is declared breaking, so CI holds it to a migrations-only pull request", () => {
    expect(readFileSync(path.join(migrationsDir, migrationFile), "utf8")).toMatch(
      /^-- sdp:migration-compat: breaking$/m
    );
  });

  it("deletes organization policies and their revisions and keeps global and project rows", async () => {
    const tenant = await seedOrgProject(client, "0184");
    await insertPolicyWithRevision({
      id: "sbp_0184_org",
      scopeType: "organization",
      scopeId: tenant.organizationId,
    });
    await insertPolicyWithRevision({
      id: "sbp_0184_project",
      scopeType: "project",
      scopeId: tenant.projectId,
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    const policyIds = [...seededPolicyIds, "sbp_0184_project"].sort();
    expect(await idsOf("sponsorship_budget_policies")).toEqual(policyIds);
    expect(await idsOf("sponsorship_budget_policy_revisions")).toEqual(
      policyIds.map((id) => `sbpr_${id}_1`)
    );
  });

  it("refuses an organization policy once the scope is gone", async () => {
    const tenant = await seedOrgProject(client, "0184_check");
    await runPostgresMigrations({ databaseUrl, migrationsDir });

    await expect(
      insertPolicyWithRevision({
        id: "sbp_0184_check_org",
        scopeType: "organization",
        scopeId: tenant.organizationId,
      })
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it("leaves the revisions append-only after suspending the trigger", async () => {
    await runPostgresMigrations({ databaseUrl, migrationsDir });

    await expect(
      client.query(
        "UPDATE sponsorship_budget_policy_revisions SET change_reason = 'edited' WHERE id = $1",
        ["sbpr_sbp_devnet_global_1"]
      )
    ).rejects.toMatchObject({ code: RAISE_EXCEPTION });
    await expect(
      client.query("DELETE FROM sponsorship_budget_policy_revisions WHERE id = $1", [
        "sbpr_sbp_devnet_global_1",
      ])
    ).rejects.toMatchObject({ code: RAISE_EXCEPTION });
  });
});
