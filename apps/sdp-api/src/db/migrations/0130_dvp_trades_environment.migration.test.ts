import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";
import {
  expectSqlstate,
  FK_VIOLATION,
  seedDvpTrade,
  seedOrgProject,
} from "@/test/helpers/migration-db";

const migrationSql = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0130_dvp_trades_environment.sql"
  ),
  "utf8"
);
let client: Client;

interface TradeEnvironmentRow {
  id: string;
  project_id: string;
  environment: string | null;
}

async function tradesOf(organizationId: string): Promise<TradeEnvironmentRow[]> {
  const result = await client.query<TradeEnvironmentRow>(
    `SELECT id, project_id, environment
       FROM dvp_trades WHERE organization_id = $1 ORDER BY id`,
    [organizationId]
  );
  return result.rows;
}

beforeAll(async () => {
  client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("BEGIN");
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0130 dvp_trades environment migration", () => {
  it("backfills existing Sandbox and Production trades with their project's environment", async () => {
    const tenant = await seedOrgProject(client, "0130_backfill");
    const productionProjectId = `${tenant.projectId}_production`;
    await client.query("ALTER TABLE dvp_trades DROP COLUMN environment");
    await seedDvpTrade(client, {
      id: "dvp_0130_backfill_production",
      organizationId: tenant.organizationId,
      projectId: productionProjectId,
      environment: null,
    });
    await seedDvpTrade(client, {
      id: "dvp_0130_backfill_sandbox",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      environment: null,
    });

    await client.query(migrationSql);

    expect(await tradesOf(tenant.organizationId)).toEqual([
      {
        id: "dvp_0130_backfill_production",
        project_id: productionProjectId,
        environment: "production",
      },
      {
        id: "dvp_0130_backfill_sandbox",
        project_id: tenant.projectId,
        environment: "sandbox",
      },
    ]);
  });

  it("rejects a trade whose environment differs from its project's on insert and on update", async () => {
    const tenant = await seedOrgProject(client, "0130_mismatch");
    const productionProjectId = `${tenant.projectId}_production`;

    await expectSqlstate(
      client,
      () =>
        seedDvpTrade(client, {
          id: "dvp_0130_mismatch_sandbox_project",
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          environment: "production",
        }),
      FK_VIOLATION
    );
    await expectSqlstate(
      client,
      () =>
        seedDvpTrade(client, {
          id: "dvp_0130_mismatch_production_project",
          organizationId: tenant.organizationId,
          projectId: productionProjectId,
          environment: "sandbox",
        }),
      FK_VIOLATION
    );
    await seedDvpTrade(client, {
      id: "dvp_0130_mismatch_matching",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      environment: "sandbox",
    });
    await expectSqlstate(
      client,
      () =>
        client.query("UPDATE dvp_trades SET environment = 'production' WHERE id = $1", [
          "dvp_0130_mismatch_matching",
        ]),
      FK_VIOLATION
    );
    await expectSqlstate(
      client,
      () =>
        client.query("UPDATE dvp_trades SET project_id = $2 WHERE id = $1", [
          "dvp_0130_mismatch_matching",
          productionProjectId,
        ]),
      FK_VIOLATION
    );

    expect(await tradesOf(tenant.organizationId)).toEqual([
      {
        id: "dvp_0130_mismatch_matching",
        project_id: tenant.projectId,
        environment: "sandbox",
      },
    ]);
  });

  it("refuses to switch a project that holds a trade to the other environment", async () => {
    const tenant = await seedOrgProject(client, "0130_switch");
    await seedDvpTrade(client, {
      id: "dvp_0130_switch",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      environment: "sandbox",
    });
    await client.query("UPDATE projects SET status = 'archived' WHERE id = $1", [
      `${tenant.projectId}_production`,
    ]);

    await expectSqlstate(
      client,
      () =>
        client.query("UPDATE projects SET environment = 'production' WHERE id = $1", [
          tenant.projectId,
        ]),
      FK_VIOLATION
    );
  });
});
