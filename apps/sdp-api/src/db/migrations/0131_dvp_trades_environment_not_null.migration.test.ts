import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";
import {
  expectSqlstate,
  NOT_NULL_VIOLATION,
  seedDvpTrade,
  seedOrgProject,
} from "@/test/helpers/migration-db";

const migrationSql = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0131_dvp_trades_environment_not_null.sql"
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

async function rewindPre0131Shape(): Promise<void> {
  await client.query("ALTER TABLE dvp_trades ALTER COLUMN environment DROP NOT NULL");
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

describe("0131 dvp_trades environment NOT NULL migration", () => {
  it("backfills a trade inserted without an environment with its project's environment", async () => {
    const tenant = await seedOrgProject(client, "0131_backfill");
    const productionProjectId = `${tenant.projectId}_production`;
    await rewindPre0131Shape();
    await seedDvpTrade(client, {
      id: "dvp_0131_backfill_production",
      organizationId: tenant.organizationId,
      projectId: productionProjectId,
      environment: null,
    });
    await seedDvpTrade(client, {
      id: "dvp_0131_backfill_sandbox",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      environment: null,
    });

    await client.query(migrationSql);

    expect(await tradesOf(tenant.organizationId)).toEqual([
      {
        id: "dvp_0131_backfill_production",
        project_id: productionProjectId,
        environment: "production",
      },
      {
        id: "dvp_0131_backfill_sandbox",
        project_id: tenant.projectId,
        environment: "sandbox",
      },
    ]);
  });

  it("rejects a trade inserted without an environment once applied", async () => {
    const tenant = await seedOrgProject(client, "0131_reject");
    await rewindPre0131Shape();

    await client.query(migrationSql);

    await expectSqlstate(
      client,
      () =>
        seedDvpTrade(client, {
          id: "dvp_0131_reject",
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          environment: null,
        }),
      NOT_NULL_VIOLATION
    );
    expect(await tradesOf(tenant.organizationId)).toEqual([]);
  });
});
