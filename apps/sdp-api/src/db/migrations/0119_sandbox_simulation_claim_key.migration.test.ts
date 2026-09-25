import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0119_sandbox_simulation_claim_key.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");
let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  await client.query("SET app.tenant_isolation_identity = 'system'");
});

afterAll(async () => {
  await client.end();
});

describe("0119 sandbox simulation claim key", () => {
  it("moves bvnk.simulation to sandboxSimulation and keeps transfers without simulation unchanged", async () => {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ('org_0119', 'Org 0119', 'org-0119')`
    );
    await client.query(
      `INSERT INTO users (id, email) VALUES ('usr_0119', 'owner-0119@example.test')`
    );
    await client.query(
      `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
       VALUES ('prj_0119', 'org_0119', 'Default Sandbox Project', 'default-sandbox', 'sandbox', 'active', 'usr_0119')`
    );
    await client.query(
      `INSERT INTO payment_transfers (
         id, organization_id, project_id, wallet_id, token, type, direction, status,
         provider, provider_reference, delivery_mode, fiat_currency, fiat_amount,
         provider_data, created_at, updated_at
       ) VALUES
         ('xfr_with_0119', 'org_0119', 'prj_0119', 'wal_0119', 'USDC', 'onramp', 'inbound', 'awaiting_payment',
          'bvnk', 'ref_with_0119', 'manual_instructions', 'USD', '120.50',
          '{"bvnk":{"simulation":{"requestedAt":"2026-09-01T00:00:00.000Z"}}}',
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
         ('xfr_without_0119', 'org_0119', 'prj_0119', 'wal_0119', 'USDC', 'onramp', 'inbound', 'awaiting_payment',
          'bvnk', 'ref_without_0119', 'manual_instructions', 'USD', '120.50',
          '{"bvnk":{"payin":{"transactionId":"tx_0119"}}}',
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`
    );

    await client.query(migrationSql);

    const rows = await client.query<{ id: string; provider_data: Record<string, unknown> }>(
      `SELECT id, provider_data FROM payment_transfers WHERE id IN ('xfr_with_0119', 'xfr_without_0119') ORDER BY id`
    );
    expect(rows.rows).toEqual([
      {
        id: "xfr_with_0119",
        provider_data: {
          bvnk: {},
          sandboxSimulation: { requestedAt: "2026-09-01T00:00:00.000Z" },
        },
      },
      {
        id: "xfr_without_0119",
        provider_data: { bvnk: { payin: { transactionId: "tx_0119" } } },
      },
    ]);
    await client.query("ROLLBACK");
  });
});
