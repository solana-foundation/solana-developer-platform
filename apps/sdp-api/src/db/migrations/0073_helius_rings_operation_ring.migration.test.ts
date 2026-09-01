import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";
import {
  CHECK_VIOLATION,
  expectSqlstate as expectSqlstateOn,
  seedOrgProject,
} from "@/test/helpers/migration-db";

// The test database is already fully migrated by src/test/node-global-setup.ts,
// so the column exists before this file runs; every test opens a transaction,
// inserts real rows against the real schema, and rolls back.

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0073_helius_rings_operation_ring.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

let client: Client;

const expectSqlstate = (work: () => Promise<unknown>, sqlstate: string) =>
  expectSqlstateOn(client, work, sqlstate);

async function seedWallet(tag: string): Promise<{
  organizationId: string;
  projectId: string;
  walletId: string;
}> {
  const { organizationId, projectId } = await seedOrgProject(client, tag);
  const walletId = `hrw_${tag}`;
  await client.query(
    `INSERT INTO helius_rings_wallets (id, organization_id, project_id, sdp_wallet_id, name)
     VALUES ($1, $2, $3, $4, 'Treasury')`,
    [walletId, organizationId, projectId, `sdpw_${tag}`]
  );

  return { organizationId, projectId, walletId };
}

function insertOperation(input: {
  id: string;
  organizationId: string;
  projectId: string;
  walletId: string;
  ringProgramId: string | null;
}): Promise<unknown> {
  return client.query(
    `INSERT INTO helius_rings_operations
       (id, organization_id, project_id, wallet_id, op_type, intent_key, ring_program_id)
     VALUES ($1, $2, $3, $4, 'shield', $5, $6)`,
    [
      input.id,
      input.organizationId,
      input.projectId,
      input.walletId,
      `sha256:${input.id}`,
      input.ringProgramId,
    ]
  );
}

beforeAll(async () => {
  client = new Client({ connectionString: env.DATABASE_URL });
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

describe("0073_helius_rings_operation_ring schema", () => {
  it("re-running the migration is a no-op", async () => {
    await expect(client.query(migrationSql)).resolves.toBeDefined();
  });

  it("stores NULL for a default-ring operation", async () => {
    const seeded = await seedWallet("ring_null");
    await expect(
      insertOperation({ id: "op_1", ...seeded, ringProgramId: null })
    ).resolves.toBeDefined();
  });

  it("stores a base58 program id for a ring-bound operation", async () => {
    const seeded = await seedWallet("ring_base58");
    await expect(
      insertOperation({
        id: "op_1",
        ...seeded,
        ringProgramId: "RingProgram1111111111111111111111111111111",
      })
    ).resolves.toBeDefined();
  });

  it("refuses a ring program id that is not base58", async () => {
    const seeded = await seedWallet("ring_garbage");
    await expectSqlstate(
      () => insertOperation({ id: "op_1", ...seeded, ringProgramId: "not base58 0OIl" }),
      CHECK_VIOLATION
    );
  });
});
