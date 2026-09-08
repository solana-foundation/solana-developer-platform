import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";
import {
  FK_VIOLATION,
  NOT_NULL_VIOLATION,
  expectSqlstate as expectSqlstateOn,
  seedHeliusRingsConnection,
  seedOrgProject,
} from "@/test/helpers/migration-db";

// The test database is already fully migrated by src/test/node-global-setup.ts,
// so the pin column exists before this file runs; every test opens a
// transaction, inserts real rows against the real schema, and rolls back.
//
// The migration's DELETE of env-era operations cannot be exercised here — the
// global setup migrates an empty database, so there are never pre-migration
// rows to clear. The NOT NULL and FK probes below are its proxies: they pin
// the contract the DELETE exists to make installable.

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0080_helius_rings_connections.sql"
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
  ringsConnectionId: string | null;
}) {
  return client.query(
    `INSERT INTO helius_rings_operations
       (id, organization_id, project_id, rings_connection_id, wallet_id, op_type, intent_key)
     VALUES ($1, $2, $3, $4, $5, 'shield', $6)`,
    [
      input.id,
      input.organizationId,
      input.projectId,
      input.ringsConnectionId,
      input.walletId,
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

describe("0080_helius_rings_connections schema", () => {
  it("re-running the migration is a no-op", async () => {
    await expect(client.query(migrationSql)).resolves.toBeDefined();
  });

  it("keeps the operation pin NOT NULL", async () => {
    const column = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'helius_rings_operations' AND column_name = 'rings_connection_id'`
    );
    expect(column.rows[0]?.is_nullable).toBe("NO");
  });

  it("accepts an operation pinned to its project's connection", async () => {
    const seeded = await seedWallet("hrc_pin");
    await expect(
      insertOperation({ id: "op_1", ...seeded, ringsConnectionId: seeded.connectionId })
    ).resolves.toBeDefined();
  });

  it("refuses an operation without a pinned connection", async () => {
    const seeded = await seedWallet("hrc_nopin");
    await expectSqlstate(
      () => insertOperation({ id: "op_1", ...seeded, ringsConnectionId: null }),
      NOT_NULL_VIOLATION
    );
  });

  it("refuses a pin to a connection that does not exist", async () => {
    const seeded = await seedWallet("hrc_ghost");
    await expectSqlstate(
      () => insertOperation({ id: "op_1", ...seeded, ringsConnectionId: "hrconn_missing" }),
      FK_VIOLATION
    );
  });

  it("refuses a pin to another project's connection", async () => {
    const seeded = await seedWallet("hrc_mine");
    const foreign = await seedWallet("hrc_theirs");
    await expectSqlstate(
      () => insertOperation({ id: "op_1", ...seeded, ringsConnectionId: foreign.connectionId }),
      FK_VIOLATION
    );
  });
});
