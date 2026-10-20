/**
 * Named prepared statements against a real PostgreSQL, under the plain
 * NOSUPERUSER/NOBYPASSRLS runtime role: a statement that earned a name keeps
 * its tenant isolation once PostgreSQL caches a generic plan for it, and a
 * statement a migration made stale recovers instead of failing every request
 * that connection serves.
 */

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import {
  runWithoutDatabaseIdentity,
  runWithSystemDatabaseIdentity,
  runWithTenantDatabaseIdentity,
} from "@/db/identity";
import { adminDatabaseUrl, env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { TEST_RUNTIME_ROLE } from "@/test/runtime-role";

const ORG_A = "org_prepared_a";
const ORG_B = "org_prepared_b";
const USER_ID = "usr_prepared";
const SCRATCH_TABLE = "prepared_statement_scratch";

interface PreparedStatementRow {
  name: string;
  statement: string;
  generic_plans: number;
  custom_plans: number;
}

async function seedTwoTenants(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'Prepared A', 'prepared-a', 'individual', 'active')`
      )
      .bind(ORG_A),
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'Prepared B', 'prepared-b', 'individual', 'active')`
      )
      .bind(ORG_B),
    db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'prepared@example.com', 1, 'active')`
      )
      .bind(USER_ID),
  ]);
  for (const [organizationId, suffix] of [
    [ORG_A, "a"],
    [ORG_B, "b"],
  ] as const) {
    await seedDefaultProjects(db, {
      organizationId,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: `prj_prepared_${suffix}`, production: `prj_prepared_${suffix}_production` },
    });
    await db
      .prepare(
        `INSERT INTO counterparties
           (id, organization_id, project_id, entity_type, display_name, status, provider_data)
         VALUES (?, ?, ?, 'individual', ?, 'active', '{}'::jsonb)`
      )
      .bind(`ctp_prepared_${suffix}`, organizationId, `prj_prepared_${suffix}`, `Party ${suffix}`)
      .run();
  }
}

/** The statements prepared on the connection that serves this call, as the system identity. */
function preparedStatements(): Promise<PreparedStatementRow[]> {
  return runWithSystemDatabaseIdentity("vitest-prepared-statements", () =>
    getDb(env).queryMany<PreparedStatementRow>(
      "SELECT name, statement, generic_plans, custom_plans FROM pg_prepared_statements WHERE name LIKE 'sdp_%'"
    )
  );
}

describe("named prepared statements", () => {
  const admin = new pg.Client({ connectionString: adminDatabaseUrl });

  beforeAll(async () => {
    await admin.connect();
  });

  afterAll(async () => {
    await admin.query(`DROP TABLE IF EXISTS ${SCRATCH_TABLE}`);
    await admin.end();
  });

  beforeEach(async () => {
    await seedTestDatabase(env);
    await admin.query(`DROP TABLE IF EXISTS ${SCRATCH_TABLE}`);
    await admin.query(`CREATE TABLE ${SCRATCH_TABLE} (id INTEGER PRIMARY KEY, a TEXT)`);
    await admin.query(`INSERT INTO ${SCRATCH_TABLE} VALUES (1, 'x')`);
    await admin.query(`GRANT ALL ON ${SCRATCH_TABLE} TO ${TEST_RUNTIME_ROLE}`);
  });

  it("prepares a repeated statement once on the connection that runs it", async () => {
    const db = getDb(env);

    const prepared = await db.transaction(async (tx) => {
      for (let run = 0; run < 3; run += 1) {
        await tx.queryOne("SELECT ?::int AS probe /* prepared_statement_probe */", [run]);
      }
      return tx.queryMany<Pick<PreparedStatementRow, "name" | "statement">>(
        `SELECT name, statement FROM pg_prepared_statements
          WHERE statement LIKE '%prepared_statement_probe%' AND statement NOT LIKE '%pg_prepared_statements%'`
      );
    });

    expect(prepared).toEqual([
      {
        name: expect.stringMatching(/^sdp_[0-9a-f]{32}$/),
        statement: expect.stringContaining("prepared_statement_probe"),
      },
    ]);
  });

  it("keeps tenant isolation once PostgreSQL reuses one generic plan for the statement", async () => {
    await seedTwoTenants();
    const db = getDb(env);
    const countParties = () =>
      db.queryOne<{ n: number }>(
        "SELECT COUNT(*) AS n FROM counterparties WHERE organization_id IN (?, ?)",
        [ORG_A, ORG_B]
      );
    const runAs = {
      tenantA: () => runWithTenantDatabaseIdentity({ organizationId: ORG_A }, countParties),
      tenantB: () => runWithTenantDatabaseIdentity({ organizationId: ORG_B }, countParties),
      system: () => runWithSystemDatabaseIdentity("vitest-prepared-statements", countParties),
      nobody: () => runWithoutDatabaseIdentity("vitest-prepared-statements", countParties),
    };

    // PostgreSQL plans the first five executions with the actual parameters
    // and then adopts one generic plan; interleaving every identity well past
    // that point on one connection is what would leak a plan built for one.
    for (let round = 0; round < 10; round += 1) {
      expect(await runAs.tenantA()).toEqual({ n: 1 });
      expect(await runAs.system()).toEqual({ n: 2 });
      expect(await runAs.nobody()).toEqual({ n: 0 });
      expect(await runAs.tenantB()).toEqual({ n: 1 });
    }

    const reused = (await preparedStatements()).filter((row) =>
      row.statement.includes("FROM counterparties WHERE organization_id IN")
    );
    expect(reused.map((row) => row.generic_plans > 0)).toEqual([true]);
  });

  it("recovers a statement a migration made stale", async () => {
    const db = getDb(env);
    const read = () =>
      db.queryOne<Record<string, unknown>>(`SELECT * FROM ${SCRATCH_TABLE} WHERE id = ?`, [1]);
    await read();
    await read();
    await read();
    const before = await db.queryOne<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    expect(before).toEqual({ pid: expect.any(Number) });

    await admin.query(`ALTER TABLE ${SCRATCH_TABLE} ADD COLUMN b TEXT DEFAULT 'new'`);

    // The connection that prepared `SELECT *` now answers "cached plan must not
    // change result type"; the client closes it and runs the statement again.
    await expect(read()).resolves.toEqual({ id: 1, a: "x", b: "new" });
    const after = await db.queryOne<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    expect(after).toEqual({ pid: expect.any(Number) });
    expect(after).not.toEqual(before);
  });

  it("closes the connection of a transaction whose statement went stale", async () => {
    const db = getDb(env);
    const sql = `SELECT *, 1 AS in_transaction FROM ${SCRATCH_TABLE} WHERE id = ?`;
    await db.transaction(async (tx) => {
      await tx.queryOne(sql, [1]);
      await tx.queryOne(sql, [1]);
    });

    await admin.query(`ALTER TABLE ${SCRATCH_TABLE} ADD COLUMN c TEXT`);

    // A transaction cannot be run again halfway, so the failure reaches its
    // caller once; the connection is closed, so the next transaction works.
    await expect(db.transaction((tx) => tx.queryOne(sql, [1]))).rejects.toMatchObject({
      code: "0A000",
    });
    await expect(db.transaction((tx) => tx.queryOne(sql, [1]))).resolves.toMatchObject({
      id: 1,
      c: null,
    });
  });

  it("answers many concurrent callers of one named statement", async () => {
    const db = getDb(env);

    const answers = await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        db.queryOne<{ n: number }>("SELECT ?::int AS n;", [index])
      )
    );

    expect(answers.map((answer) => answer?.n)).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });

  it("commits and rolls back writes made through named statements", async () => {
    const db = getDb(env);
    const insert = (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], id: number) =>
      tx.queryOne<{ id: number }>(
        `INSERT INTO ${SCRATCH_TABLE} (id, a) VALUES (?, 'written') RETURNING id`,
        [id]
      );
    await db.transaction(async (tx) => {
      await insert(tx, 10);
      await insert(tx, 11);
    });

    await expect(
      db.transaction(async (tx) => {
        await insert(tx, 12);
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");

    const rows = await db.queryMany<{ id: number }>(
      `SELECT id FROM ${SCRATCH_TABLE} WHERE a = 'written' ORDER BY id`
    );
    expect(rows).toEqual([{ id: 10 }, { id: 11 }]);
  });
});
