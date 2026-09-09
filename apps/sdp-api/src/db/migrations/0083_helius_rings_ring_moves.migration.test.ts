import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";
import {
  CHECK_VIOLATION,
  expectSqlstate as expectSqlstateOn,
  seedHeliusRingsConnection,
  seedOrgProject,
  UNIQUE_VIOLATION,
} from "@/test/helpers/migration-db";

// The test database is already fully migrated by src/test/node-global-setup.ts,
// so the widened check and index exist before this file runs; every test opens
// a transaction, inserts real rows against the real schema, and rolls back.

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0083_helius_rings_ring_moves.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

let client: Client;

const expectSqlstate = (work: () => Promise<unknown>, sqlstate: string) =>
  expectSqlstateOn(client, work, sqlstate);

async function seedWallet(tag: string): Promise<{
  organizationId: string;
  projectId: string;
  walletId: string;
  connectionId: string;
}> {
  const { organizationId, projectId, userId } = await seedOrgProject(client, tag);
  const connectionId = await seedHeliusRingsConnection(client, {
    organizationId,
    projectId,
    userId,
    tag,
  });
  const walletId = `hrw_${tag}`;
  await client.query(
    `INSERT INTO helius_rings_wallets (id, organization_id, project_id, sdp_wallet_id, name)
     VALUES ($1, $2, $3, $4, 'Treasury')`,
    [walletId, organizationId, projectId, `sdpw_${tag}`]
  );

  return { organizationId, projectId, walletId, connectionId };
}

function insertOperation(input: {
  id: string;
  organizationId: string;
  projectId: string;
  walletId: string;
  connectionId: string;
  opType: string;
  state?: string;
}): Promise<unknown> {
  return client.query(
    `INSERT INTO helius_rings_operations
       (id, organization_id, project_id, wallet_id, rings_connection_id, op_type, state,
        intent_key, ring_program_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'RingProgram1111111111111111111111111111111')`,
    [
      input.id,
      input.organizationId,
      input.projectId,
      input.walletId,
      input.connectionId,
      input.opType,
      input.state ?? "draft",
      `sha256:${input.id}`,
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

describe("0083_helius_rings_ring_moves schema", () => {
  it("re-running the migration is a no-op", async () => {
    await expect(client.query(migrationSql)).resolves.toBeDefined();
  });

  it("accepts ring_exit and ring_entry rows and still refuses an unknown op type", async () => {
    const seeded = await seedWallet("ring_moves");
    await expect(
      insertOperation({ id: "op_exit", ...seeded, opType: "ring_exit" })
    ).resolves.toBeDefined();
    await expect(
      insertOperation({ id: "op_entry", ...seeded, opType: "ring_entry" })
    ).resolves.toBeDefined();
    await expectSqlstate(
      () => insertOperation({ id: "op_bogus", ...seeded, opType: "ring_sideways" }),
      CHECK_VIOLATION
    );
  });

  it("the active-spend index blocks a second in-flight ring move on the same wallet", async () => {
    const seeded = await seedWallet("ring_move_guard");
    await insertOperation({ id: "op_1", ...seeded, opType: "ring_exit", state: "proving" });
    await expectSqlstate(
      () => insertOperation({ id: "op_2", ...seeded, opType: "ring_entry", state: "proving" }),
      UNIQUE_VIOLATION
    );
  });

  it("a ring move and a withdraw collide on the spend guard", async () => {
    // One spend class: a ring move consumes notes exactly like a withdraw, so
    // the two must never be in flight together on one wallet.
    const seeded = await seedWallet("ring_move_withdraw");
    await insertOperation({ id: "op_1", ...seeded, opType: "withdraw", state: "indexing" });
    await expectSqlstate(
      () => insertOperation({ id: "op_2", ...seeded, opType: "ring_exit", state: "proving" }),
      UNIQUE_VIOLATION
    );
  });
});
