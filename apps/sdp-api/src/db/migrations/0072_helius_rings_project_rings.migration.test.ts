import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RING_NAME, RING_NAME_PATTERN } from "@sdp/helius-rings";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";
import {
  CHECK_VIOLATION,
  expectSqlstate as expectSqlstateOn,
  seedOrgProject,
  UNIQUE_VIOLATION,
} from "@/test/helpers/migration-db";

// The test database is already fully migrated by src/test/node-global-setup.ts,
// so the table exists before this file runs; every test opens a transaction,
// inserts real rows against the real schema, and rolls back.

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0072_helius_rings_project_rings.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

let client: Client;

const expectSqlstate = (work: () => Promise<unknown>, sqlstate: string) =>
  expectSqlstateOn(client, work, sqlstate);
const seedProject = (tag: string) => seedOrgProject(client, tag);

function insertRing(input: {
  id: string;
  organizationId: string;
  projectId: string;
  name?: string;
  ringProgramId?: string;
  status?: string;
  auditorPublicKey?: string | null;
  lookupTableAddress?: string | null;
}): Promise<unknown> {
  return client.query(
    `INSERT INTO helius_rings_project_rings
       (id, organization_id, project_id, name, ring_program_id, status,
        auditor_public_key, lookup_table_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.id,
      input.organizationId,
      input.projectId,
      input.name ?? "treasury",
      input.ringProgramId ?? "RingProgram1111111111111111111111111111111",
      input.status ?? "pending",
      input.auditorPublicKey ?? null,
      input.lookupTableAddress ?? null,
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

describe("0072_helius_rings_project_rings schema", () => {
  it("re-running the migration is a no-op", async () => {
    await expect(client.query(migrationSql)).resolves.toBeDefined();
  });

  it("allows several named rings per project", async () => {
    const { organizationId, projectId } = await seedProject("ring_multi");
    await insertRing({ id: "hrr_1", organizationId, projectId, name: "treasury" });
    await expect(
      insertRing({
        id: "hrr_2",
        organizationId,
        projectId,
        name: "payroll",
        ringProgramId: "RingProgram2111111111111111111111111111111",
      })
    ).resolves.toBeDefined();
  });

  it("refuses two rings under one name in a project", async () => {
    const { organizationId, projectId } = await seedProject("ring_name_dup");
    await insertRing({ id: "hrr_1", organizationId, projectId, name: "treasury" });

    // A name resolving to two programs would pin the wrong ring on an operation.
    await expectSqlstate(
      () =>
        insertRing({
          id: "hrr_2",
          organizationId,
          projectId,
          name: "treasury",
          ringProgramId: "RingProgram2111111111111111111111111111111",
        }),
      UNIQUE_VIOLATION
    );
  });

  it("refuses one program under two names in a project", async () => {
    const { organizationId, projectId } = await seedProject("ring_program_dup");
    await insertRing({ id: "hrr_1", organizationId, projectId, name: "treasury" });

    // One on-chain pool under two rows would split its audit trail.
    await expectSqlstate(
      () => insertRing({ id: "hrr_2", organizationId, projectId, name: "payroll" }),
      UNIQUE_VIOLATION
    );
  });

  it("allows the same name and program pair across projects", async () => {
    const a = await seedProject("ring_scope_a");
    const b = await seedProject("ring_scope_b");
    await insertRing({ id: "hrr_1", ...a, name: "treasury" });
    await expect(insertRing({ id: "hrr_2", ...b, name: "treasury" })).resolves.toBeDefined();
  });

  it("agrees with RING_NAME_PATTERN on the slug shape, and refuses the reserved word", async () => {
    const { organizationId, projectId } = await seedProject("ring_name_shape");
    // The SQL CHECK is a hand copy of the TS pattern, so the candidates are
    // judged by the exported constant: drift between the two fails this test
    // instead of shipping.
    const candidates = [
      "Treasury", // uppercase
      "-treasury", // leading hyphen
      "treasury-", // trailing hyphen
      "a".repeat(33), // over 32 chars
      "a".repeat(32), // at the limit
      "a", // single char
      "0ring", // leading digit
      "usdc-payroll-2",
    ];
    for (const [index, name] of candidates.entries()) {
      // A distinct program id per candidate, or the accepted names would trip
      // UNIQUE(project_id, ring_program_id) instead of exercising the CHECK.
      const insert = () =>
        insertRing({
          id: `hrr_shape_${index}`,
          organizationId,
          projectId,
          name,
          ringProgramId: `RingProgram${index + 1}11111111111111111111111111111`,
        });
      if (RING_NAME_PATTERN.test(name)) {
        await expect(insert()).resolves.toBeDefined();
      } else {
        await expectSqlstate(insert, CHECK_VIOLATION);
      }
    }
    // Reserved independently of shape: "default" names the default pool.
    expect(RING_NAME_PATTERN.test(DEFAULT_RING_NAME)).toBe(true);
    await expectSqlstate(
      () =>
        insertRing({
          id: "hrr_default",
          organizationId,
          projectId,
          name: DEFAULT_RING_NAME,
          ringProgramId: "RingProgram911111111111111111111111111111111",
        }),
      CHECK_VIOLATION
    );
  });

  it("refuses a status outside the closed set", async () => {
    const { organizationId, projectId } = await seedProject("ring_status");
    await expectSqlstate(
      () => insertRing({ id: "hrr_1", organizationId, projectId, status: "deployed" }),
      CHECK_VIOLATION
    );
  });

  it("refuses an active ring missing its auditor key or lookup table", async () => {
    const { organizationId, projectId } = await seedProject("ring_active");
    // 'active' is a claim the chain backs; without the key there is nothing to
    // verify the claim against, and without the table no spend can be built.
    await expectSqlstate(
      () =>
        insertRing({
          id: "hrr_1",
          organizationId,
          projectId,
          status: "active",
          lookupTableAddress: "LookupTab1e11111111111111111111111111111111",
        }),
      CHECK_VIOLATION
    );
    await expectSqlstate(
      () =>
        insertRing({
          id: "hrr_1",
          organizationId,
          projectId,
          status: "active",
          auditorPublicKey: "04abc123",
        }),
      CHECK_VIOLATION
    );
    await expect(
      insertRing({
        id: "hrr_1",
        organizationId,
        projectId,
        status: "active",
        auditorPublicKey: "04abc123",
        lookupTableAddress: "LookupTab1e11111111111111111111111111111111",
      })
    ).resolves.toBeDefined();
  });

  it("refuses a lookup table outside the base58 shape", async () => {
    const { organizationId, projectId } = await seedProject("ring_alt_shape");
    await expectSqlstate(
      () =>
        insertRing({
          id: "hrr_1",
          organizationId,
          projectId,
          lookupTableAddress: "not-base58-0OIl",
        }),
      CHECK_VIOLATION
    );
  });
});
