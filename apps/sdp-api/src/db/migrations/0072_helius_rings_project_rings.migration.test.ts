import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

// The test database is already fully migrated by src/test/node-global-setup.ts,
// so the table exists before this file runs; every test opens a transaction,
// inserts real rows against the real schema, and rolls back.

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0072_helius_rings_project_rings.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

let client: Client;

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

/** See 0057's test for why the savepoint wraps only the violating statement. */
async function expectSqlstate(work: () => Promise<unknown>, sqlstate: string): Promise<void> {
  await client.query("SAVEPOINT probe");
  await expect(work()).rejects.toMatchObject({ code: sqlstate });
  await client.query("ROLLBACK TO SAVEPOINT probe");
}

async function seedProject(tag: string): Promise<{ organizationId: string; projectId: string }> {
  const organizationId = `org_${tag}`;
  const projectId = `proj_${tag}`;
  const userId = `user_${tag}`;

  await client.query("INSERT INTO organizations (id, name, slug) VALUES ($1, $1, $1)", [
    organizationId,
  ]);
  await client.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
    userId,
    `${tag}@example.test`,
  ]);
  await client.query(
    "INSERT INTO projects (id, organization_id, name, slug, created_by) VALUES ($1, $2, $1, $1, $3)",
    [projectId, organizationId, userId]
  );

  return { organizationId, projectId };
}

function insertRing(input: {
  id: string;
  organizationId: string;
  projectId: string;
  ringProgramId?: string;
  status?: string;
  auditorPublicKey?: string | null;
}): Promise<unknown> {
  return client.query(
    `INSERT INTO helius_rings_project_rings
       (id, organization_id, project_id, ring_program_id, status, auditor_public_key)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.id,
      input.organizationId,
      input.projectId,
      input.ringProgramId ?? "RingProgram1111111111111111111111111111111",
      input.status ?? "pending",
      input.auditorPublicKey ?? null,
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

  it("allows exactly one ring per project", async () => {
    const { organizationId, projectId } = await seedProject("ring_unique");
    await insertRing({ id: "hrr_1", organizationId, projectId });

    // A second ring would split the project's shielded balance across pools
    // that cannot see each other.
    await expectSqlstate(
      () =>
        insertRing({
          id: "hrr_2",
          organizationId,
          projectId,
          ringProgramId: "RingProgram2111111111111111111111111111111",
        }),
      UNIQUE_VIOLATION
    );
  });

  it("refuses a status outside the closed set", async () => {
    const { organizationId, projectId } = await seedProject("ring_status");
    await expectSqlstate(
      () => insertRing({ id: "hrr_1", organizationId, projectId, status: "deployed" }),
      CHECK_VIOLATION
    );
  });

  it("refuses an active ring without its published auditor key", async () => {
    const { organizationId, projectId } = await seedProject("ring_auditor");
    // 'active' is a claim the chain backs; without the key there is nothing to
    // verify the claim against.
    await expectSqlstate(
      () => insertRing({ id: "hrr_1", organizationId, projectId, status: "active" }),
      CHECK_VIOLATION
    );
    await expect(
      insertRing({
        id: "hrr_1",
        organizationId,
        projectId,
        status: "active",
        auditorPublicKey: "04abc123",
      })
    ).resolves.toBeDefined();
  });
});
