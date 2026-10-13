import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";

const MIGRATION_SQL = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0132_organization_members_removed_at.sql"
  ),
  "utf8"
);

/**
 * Runs the migration over a TEMP copy of the table it touches, seeded by the
 * caller, then reads the result back before rolling everything back.
 *
 * @param seed - Inserts the fixture rows into the TEMP table.
 * @param read - Reads what the migration left behind.
 * @returns What `read` returned.
 */
async function migrate<T>(
  seed: (client: Client) => Promise<void>,
  read: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE organization_members (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL
    )`);
    await seed(client);
    await client.query(MIGRATION_SQL);
    return await read(client);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

it("stamps every non-active membership with the migration time and leaves active ones unset", async () => {
  const result = await migrate(
    async (client) => {
      await client.query(`INSERT INTO organization_members (id, organization_id, user_id, status) VALUES
        ('mem_removed', 'org_a', 'usr_removed', 'removed'),
        ('mem_suspended', 'org_a', 'usr_suspended', 'suspended'),
        ('mem_active', 'org_a', 'usr_active', 'active')`);
    },
    async (client) => {
      const { rows } = await client.query<{ id: string; removed_at: string | null }>(
        "SELECT id, removed_at FROM organization_members ORDER BY id"
      );
      const {
        rows: [now],
      } = await client.query<{ value: string }>("SELECT sdp_iso_now() AS value");
      return { rows, now };
    }
  );

  expect(result.rows).toEqual([
    { id: "mem_active", removed_at: null },
    { id: "mem_removed", removed_at: result.now.value },
    { id: "mem_suspended", removed_at: result.now.value },
  ]);
});
