import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";

/**
 * A key stored with the old `transfer` family must keep its Rings access under
 * the new `privacy` name, in the shape the API writes.
 */
it("rewrites the transfer family to privacy and leaves other lists alone", async () => {
  const migrationPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0126_rename_allowed_operations_transfer_family.sql"
  );
  const sql = readFileSync(migrationPath, "utf8");
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE api_keys (
      id TEXT PRIMARY KEY,
      allowed_operations TEXT
    )`);
    await client.query(
      `INSERT INTO api_keys (id, allowed_operations) VALUES
         ('key_transfer', $1),
         ('key_both', $2),
         ('key_other', $3),
         ('key_empty', '[]'),
         ('key_null', NULL)`,
      [
        JSON.stringify(["transfer"]),
        JSON.stringify(["payment", "privacy", "transfer"]),
        JSON.stringify(["issuance", "rings_shield"]),
      ]
    );

    await client.query(sql);

    const { rows } = await client.query<{ id: string; allowed_operations: string | null }>(
      "SELECT id, allowed_operations FROM api_keys ORDER BY id"
    );
    const byId = new Map(rows.map((row) => [row.id, row.allowed_operations]));

    expect(byId.get("key_transfer")).toBe(JSON.stringify(["privacy"]));
    expect(byId.get("key_both")).toBe(JSON.stringify(["payment", "privacy"]));
    expect(byId.get("key_other")).toBe(JSON.stringify(["issuance", "rings_shield"]));
    expect(byId.get("key_empty")).toBe("[]");
    expect(byId.get("key_null")).toBeNull();
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
