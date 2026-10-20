/**
 * A stamped statement outside a transaction against a real PostgreSQL: the
 * stamp, the statement and COMMIT travel in one flight (client.ts,
 * `inOneFlight`). These tests hold the flight to what three separate round
 * trips guaranteed: a failing statement commits nothing and its own error is
 * the one thrown, a failing COMMIT reaches the caller instead of the
 * statement's result, and no identity outlives its statement on a pooled
 * connection.
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
import { seedTestDatabase } from "@/test/mocks/db";
import { TEST_RUNTIME_ROLE } from "@/test/runtime-role";

const PLAIN_TABLE = "stamp_flight_plain";
const DEFERRED_TABLE = "stamp_flight_deferred";
const ORG_A = "org_stamp_flight_a";
const ORG_B = "org_stamp_flight_b";

interface IdentityProbe {
  identity: string | null;
  organization: string | null;
  actor: string | null;
}

const PROBE_SQL = `SELECT current_setting('app.tenant_isolation_identity', true) AS identity,
                          current_setting('app.tenant_isolation_organization_id', true) AS organization,
                          current_setting('app.tenant_isolation_actor', true) AS actor`;

function probe(): Promise<IdentityProbe | null> {
  return getDb(env).queryOne<IdentityProbe>(PROBE_SQL);
}

/** A session that never set an identity reads its GUCs as unset (null) or, once set and reverted, as empty. */
const NO_IDENTITY: readonly (string | null)[] = [null, ""];

describe("a stamped statement outside a transaction, in one flight", () => {
  const admin = new pg.Client({ connectionString: adminDatabaseUrl });

  async function adminRowIds(table: string): Promise<number[]> {
    const result = await admin.query<{ id: number }>(`SELECT id FROM ${table} ORDER BY id`);
    return result.rows.map((row) => row.id);
  }

  beforeAll(async () => {
    await admin.connect();
  });

  afterAll(async () => {
    await admin.query(`DROP TABLE IF EXISTS ${PLAIN_TABLE}, ${DEFERRED_TABLE}`);
    await admin.end();
  });

  beforeEach(async () => {
    await seedTestDatabase(env);
    await admin.query(`DROP TABLE IF EXISTS ${PLAIN_TABLE}, ${DEFERRED_TABLE}`);
    await admin.query(`CREATE TABLE ${PLAIN_TABLE} (id INTEGER PRIMARY KEY, a TEXT)`);
    await admin.query(
      `CREATE TABLE ${DEFERRED_TABLE} (id INTEGER, UNIQUE (id) DEFERRABLE INITIALLY DEFERRED)`
    );
    await admin.query(`INSERT INTO ${PLAIN_TABLE} VALUES (1, 'x')`);
    await admin.query(`INSERT INTO ${DEFERRED_TABLE} VALUES (1)`);
    await admin.query(`GRANT ALL ON ${PLAIN_TABLE}, ${DEFERRED_TABLE} TO ${TEST_RUNTIME_ROLE}`);
  });

  it("returns what the statement returned and counts the rows the statement changed", async () => {
    const db = getDb(env);

    const inserted = await runWithTenantDatabaseIdentity({ organizationId: ORG_A }, () =>
      db.queryOne<{ id: number }>(`INSERT INTO ${PLAIN_TABLE} VALUES (?, 'y') RETURNING id`, [2])
    );
    const updated = await runWithTenantDatabaseIdentity({ organizationId: ORG_A }, () =>
      db.execute(`UPDATE ${PLAIN_TABLE} SET a = 'z'`)
    );

    expect(inserted).toEqual({ id: 2 });
    expect(updated).toBe(2);
    expect(await adminRowIds(PLAIN_TABLE)).toEqual([1, 2]);
  });

  it("throws the statement's own error and commits nothing when the statement fails", async () => {
    const db = getDb(env);

    await expect(
      runWithTenantDatabaseIdentity({ organizationId: ORG_A }, () =>
        db.execute(`INSERT INTO ${PLAIN_TABLE} VALUES (?, 'dup')`, [1])
      )
    ).rejects.toMatchObject({ code: "23505", constraint: `${PLAIN_TABLE}_pkey` });
    expect(await adminRowIds(PLAIN_TABLE)).toEqual([1]);
  });

  it("commits no part of a statement that fails after changing a row", async () => {
    const db = getDb(env);

    // No values, so this goes out as one simple query: the insert succeeds and
    // the division fails after it. COMMIT, already sent, must not keep the insert.
    await expect(
      runWithSystemDatabaseIdentity("vitest-stamp-flight", () =>
        db.execute(`INSERT INTO ${PLAIN_TABLE} VALUES (2, 'partial'); SELECT 1 / 0`)
      )
    ).rejects.toMatchObject({ code: "22012" });
    expect(await adminRowIds(PLAIN_TABLE)).toEqual([1]);
  });

  it("gives the caller the COMMIT error, not the result, when COMMIT fails", async () => {
    const db = getDb(env);

    // The deferred unique constraint is checked at COMMIT, after the insert
    // itself succeeded.
    const outcome = await runWithTenantDatabaseIdentity({ organizationId: ORG_A }, () =>
      db.queryOne(`INSERT INTO ${DEFERRED_TABLE} VALUES (?) RETURNING id`, [1])
    ).then(
      (result) => ({ result }),
      (error: Error) => ({ error })
    );

    expect(outcome).toEqual({ error: expect.objectContaining({ code: "23505" }) });
    expect(await adminRowIds(DEFERRED_TABLE)).toEqual([1]);
  });

  it("leaves the connection usable and unstamped after every kind of failure", async () => {
    const db = getDb(env);
    const failures = [
      () => db.execute(`INSERT INTO ${PLAIN_TABLE} VALUES (?, 'dup')`, [1]),
      () => db.queryOne(`INSERT INTO ${DEFERRED_TABLE} VALUES (?) RETURNING id`, [1]),
      () => db.execute(`INSERT INTO ${PLAIN_TABLE} VALUES (3, 'partial'); SELECT 1 / 0`),
    ];

    // More failures than the pool has connections, so every connection fails
    // a statement as a tenant and is then used by the next caller.
    for (let round = 0; round < 12; round += 1) {
      const fail = failures[round % failures.length];
      await expect(
        runWithTenantDatabaseIdentity({ organizationId: ORG_A }, () => fail())
      ).rejects.toBeInstanceOf(Error);
      const afterwards = await runWithoutDatabaseIdentity("vitest-stamp-flight", probe);
      expect(afterwards).not.toBeNull();
      expect(NO_IDENTITY).toContain(afterwards?.identity);
      expect(NO_IDENTITY).toContain(afterwards?.organization);
    }
    expect(await adminRowIds(PLAIN_TABLE)).toEqual([1]);
  });

  it("gives each concurrent caller its own identity on a shared pool", async () => {
    const callers = Array.from({ length: 240 }, (_, index) => {
      switch (index % 4) {
        case 0:
          return {
            expected: { identity: "tenant", organization: ORG_A, actor: "" },
            run: () => runWithTenantDatabaseIdentity({ organizationId: ORG_A }, probe),
          };
        case 1:
          return {
            expected: { identity: "tenant", organization: ORG_B, actor: "" },
            run: () => runWithTenantDatabaseIdentity({ organizationId: ORG_B }, probe),
          };
        case 2:
          return {
            expected: { identity: "system", organization: "", actor: "vitest-stamp-flight" },
            run: () => runWithSystemDatabaseIdentity("vitest-stamp-flight", probe),
          };
        default:
          return {
            expected: undefined,
            run: () => runWithoutDatabaseIdentity("vitest-stamp-flight", probe),
          };
      }
    });

    const probed = await Promise.all(callers.map((caller) => caller.run()));

    probed.forEach((seen, index) => {
      const { expected } = callers[index];
      if (expected === undefined) {
        expect(NO_IDENTITY).toContain(seen?.identity);
        expect(NO_IDENTITY).toContain(seen?.organization);
        expect(NO_IDENTITY).toContain(seen?.actor);
      } else {
        expect(seen).toEqual(expected);
      }
    });
  });
});
