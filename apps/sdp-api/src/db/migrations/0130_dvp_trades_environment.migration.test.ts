import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SdpEnvironment } from "@sdp/types";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";
import { expectSqlstate, FK_VIOLATION, seedOrgProject } from "@/test/helpers/migration-db";

const migrationSql = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0130_dvp_trades_environment.sql"
  ),
  "utf8"
);
let client: Client;

interface TradeSeed {
  id: string;
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment | null;
}

interface TradeEnvironmentRow {
  id: string;
  project_id: string;
  environment: string | null;
}

async function insertTrade(trade: TradeSeed): Promise<void> {
  const environmentColumn = trade.environment === null ? "" : ", environment";
  const environmentValue = trade.environment === null ? "" : ", $5";
  const environmentParams = trade.environment === null ? [] : [trade.environment];
  await client.query(
    `INSERT INTO dvp_trades (
       id, organization_id, project_id, swap_dvp, settlement_authority,
       user_a, user_b, mint_a, mint_b, nonce, token_program_a, token_program_b,
       amount_a, amount_b, expiry_timestamp,
       user_a_settlement_destination, user_b_settlement_destination,
       escrow_a, escrow_b, status${environmentColumn}
     ) VALUES (
       $1, $2, $3, $4, '9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY',
       '5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn',
       '7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg',
       'ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1',
       'AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE', '42',
       'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
       'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
       '1000', '2000', '1800003600',
       '5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn',
       '7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg',
       'FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU',
       '6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y',
       'created'${environmentValue}
     )`,
    [trade.id, trade.organizationId, trade.projectId, `swap_${trade.id}`, ...environmentParams]
  );
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
    await insertTrade({
      id: "dvp_0130_backfill_production",
      organizationId: tenant.organizationId,
      projectId: productionProjectId,
      environment: null,
    });
    await insertTrade({
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
        insertTrade({
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
        insertTrade({
          id: "dvp_0130_mismatch_production_project",
          organizationId: tenant.organizationId,
          projectId: productionProjectId,
          environment: "sandbox",
        }),
      FK_VIOLATION
    );
    await insertTrade({
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

  it("accepts a trade inserted without an environment", async () => {
    const tenant = await seedOrgProject(client, "0130_unwritten");

    await insertTrade({
      id: "dvp_0130_unwritten",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      environment: null,
    });

    expect(await tradesOf(tenant.organizationId)).toEqual([
      {
        id: "dvp_0130_unwritten",
        project_id: tenant.projectId,
        environment: null,
      },
    ]);
  });

  it("refuses to switch a project that holds a trade to the other environment", async () => {
    const tenant = await seedOrgProject(client, "0130_switch");
    await insertTrade({
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
