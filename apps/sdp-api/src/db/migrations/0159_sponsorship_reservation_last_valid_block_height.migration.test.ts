import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";
import { seedOrgProject } from "@/test/helpers/migration-db";

const migrationSql = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0159_sponsorship_reservation_last_valid_block_height.sql"
  ),
  "utf8"
);

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("BEGIN");
  await client.query(
    "ALTER TABLE sponsorship_budget_reservations DROP COLUMN last_valid_block_height"
  );
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0159 sponsorship reservation last valid block height", () => {
  it("adds a nullable bound and leaves an admitted reservation intact", async () => {
    const tenant = await seedOrgProject(client, "0159");
    await client.query(
      `INSERT INTO sponsorship_budget_reservations (
         id, network, product_environment, organization_id, project_id, actor_type, actor_id,
         transaction_digest, fee_payer, provider_config_fingerprint, recent_blockhash,
         reserved_lamports, hour_bucket, day_bucket, policy_versions, status
       ) VALUES ('sbr_0159', 'devnet', 'sandbox', $1, $2, 'api_key', 'key_0159', 'digest_0159',
                 'fee_payer_0159', 'config_0159', 'blockhash_0159', 5,
                 '2026-08-03T10:00:00.000Z', '2026-08-03T00:00:00.000Z', '{}', 'submitted')`,
      [tenant.organizationId, tenant.projectId]
    );

    await client.query(migrationSql);

    const reservations = await client.query(
      `SELECT id, status, recent_blockhash, last_valid_block_height
         FROM sponsorship_budget_reservations WHERE id = 'sbr_0159'`
    );
    expect(reservations.rows).toEqual([
      {
        id: "sbr_0159",
        status: "submitted",
        recent_blockhash: "blockhash_0159",
        last_valid_block_height: null,
      },
    ]);
  });
});
