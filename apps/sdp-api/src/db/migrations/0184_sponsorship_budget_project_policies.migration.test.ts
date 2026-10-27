import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDatabaseUrl, env } from "@/test/helpers/env";
import {
  CHECK_VIOLATION,
  expectSqlstate,
  RAISE_EXCEPTION,
  seedOrgProject,
  UNIQUE_VIOLATION,
} from "@/test/helpers/migration-db";
import { seedTestDatabase } from "@/test/mocks/db";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres");
const migrationSql = readFileSync(
  path.join(migrationsDir, "0184_sponsorship_budget_project_policies.sql"),
  "utf8"
);
const sponsorshipBudgetsSql = readFileSync(
  path.join(migrationsDir, "0055_sponsorship_budgets.sql"),
  "utf8"
);

const REWIND_TO_0183 = [
  "DROP TRIGGER sponsorship_budget_project_policy_for_new_project ON projects",
  "DROP FUNCTION sdp_sponsorship_budget_project_policy_for_new_project()",
  "DROP TABLE sponsorship_budget_project_policy_revisions, sponsorship_budget_project_policies",
  "DROP DOMAIN sdp_lua_safe_lamports",
  "DROP TABLE sponsorship_budget_policy_revisions, sponsorship_budget_policies",
  `ALTER TABLE sponsorship_budget_reservations
     ADD COLUMN network TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet'))`,
  "ALTER TABLE sponsorship_budget_reservations RENAME COLUMN environment TO product_environment",
  `ALTER TABLE sponsorship_budget_reservations
     RENAME CONSTRAINT sponsorship_budget_reservations_environment_check
     TO sponsorship_budget_reservations_product_environment_check`,
  "DELETE FROM sponsorship_reconciliation_state",
  `ALTER TABLE sponsorship_reconciliation_state
     DROP CONSTRAINT sponsorship_reconciliation_state_environment_check`,
  "ALTER TABLE sponsorship_reconciliation_state RENAME COLUMN environment TO network",
  `ALTER TABLE sponsorship_reconciliation_state
     ADD CONSTRAINT sponsorship_reconciliation_state_network_check
     CHECK (network IN ('devnet', 'mainnet'))`,
].join(";\n");

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await seedTestDatabase(env);
  await client.query("BEGIN");
  await client.query(REWIND_TO_0183);
  await client.query(sponsorshipBudgetsSql);
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0184 per-project sponsorship budgets keyed by environment", () => {
  it("is declared breaking, so CI holds it to a migrations-only pull request", () => {
    expect(migrationSql).toMatch(/^-- sdp:migration-compat: breaking$/m);
  });

  it("carries each project's exact override, else its environment's project default", async () => {
    const tenant = await seedOrgProject(client, "0184");
    await client.query(
      `INSERT INTO sponsorship_budget_policies (
         id, network, scope_type, scope_id, enabled, per_transaction_lamports,
         hourly_lamports, daily_lamports, version, updated_by, update_reason
       ) VALUES
         ('sbp_0184_override', 'devnet', 'project', $1, FALSE, 10, 100, 1000, 4, 'operator', 'tight'),
         ('sbp_0184_other_network', 'mainnet', 'project', $1, TRUE, 20, 200, 2000, 1, 'operator', 'other network')`,
      [tenant.projectId]
    );

    await client.query(migrationSql);

    const projectPolicies = await client.query(
      `SELECT pp.project_id, pp.enabled, pp.per_transaction_lamports, pp.hourly_lamports,
              pp.daily_lamports, pp.version, pp.updated_by, pp.update_reason,
              r.version AS revision_version
         FROM sponsorship_budget_project_policies pp
         JOIN sponsorship_budget_project_policy_revisions r ON r.policy_id = pp.id
        ORDER BY pp.project_id`
    );
    expect(projectPolicies.rows).toEqual([
      {
        project_id: tenant.projectId,
        enabled: false,
        per_transaction_lamports: "10",
        hourly_lamports: "100",
        daily_lamports: "1000",
        version: "1",
        updated_by: "migration",
        update_reason: "Carried over from the project override",
        revision_version: "1",
      },
      {
        project_id: `${tenant.projectId}_production`,
        enabled: true,
        per_transaction_lamports: "10000000",
        hourly_lamports: "100000000",
        daily_lamports: "250000000",
        version: "1",
        updated_by: "migration",
        update_reason: "Carried over from the project default",
        revision_version: "1",
      },
    ]);
    const globalPolicies = await client.query(
      "SELECT environment, enabled, hourly_lamports FROM sponsorship_budget_policies ORDER BY environment"
    );
    expect(globalPolicies.rows).toEqual([
      { environment: "production", enabled: false, hourly_lamports: "500000000" },
      { environment: "sandbox", enabled: true, hourly_lamports: "2000000000" },
    ]);
    const globalRevisions = await client.query(
      "SELECT id, environment FROM sponsorship_budget_policy_revisions ORDER BY id"
    );
    expect(globalRevisions.rows).toEqual([
      { id: "sbpr_sbp_devnet_global_1", environment: "sandbox" },
      { id: "sbpr_sbp_mainnet_global_1", environment: "production" },
    ]);
  });

  it("holds exactly one global policy per environment", async () => {
    await client.query(migrationSql);
    const insertGlobal = (environment: string) => () =>
      client.query(
        `INSERT INTO sponsorship_budget_policies (
           environment, enabled, per_transaction_lamports, hourly_lamports, daily_lamports,
           version, updated_by, update_reason
         ) VALUES ($1, TRUE, 10, 100, 1000, 1, 'test', 'seed')`,
        [environment]
      );

    await expectSqlstate(client, insertGlobal("sandbox"), UNIQUE_VIOLATION);
    await expectSqlstate(client, insertGlobal("devnet"), CHECK_VIOLATION);
  });

  it.each(["sponsorship_budget_policy_revisions", "sponsorship_budget_project_policy_revisions"])(
    "leaves %s append-only",
    async (table) => {
      await seedOrgProject(client, "0184_append_only");
      await client.query(migrationSql);

      await expectSqlstate(
        client,
        () => client.query(`UPDATE ${table} SET change_reason = 'edited'`),
        RAISE_EXCEPTION
      );
      await expectSqlstate(client, () => client.query(`DELETE FROM ${table}`), RAISE_EXCEPTION);
    }
  );
});
