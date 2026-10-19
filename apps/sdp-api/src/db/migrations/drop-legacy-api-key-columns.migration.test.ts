import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiKeyStatus } from "@sdp/types/api-keys";
import { Client } from "pg";
import { expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";

/**
 * 0149 is the grants cutover (HOO-2099): an active key never given grants
 * is deactivated before the legacy columns go, so a rollback cannot restore
 * its role. Keys that have grants, and keys already dead, are left alone.
 */
it("deactivates exactly the active keys that predate grants, then drops the legacy columns", async () => {
  const sql = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "postgres/0149_drop_legacy_api_key_columns.sql"
    ),
    "utf8"
  );
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE api_keys (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      grants_assigned BOOLEAN NOT NULL,
      revoked_at TEXT,
      role TEXT NOT NULL DEFAULT 'api_developer',
      permissions TEXT,
      allowed_operations TEXT
    )`);
    await client.query(`INSERT INTO api_keys (id, status, grants_assigned, revoked_at) VALUES
      ('key_legacy_live', 'active', false, NULL),
      ('key_granted', 'active', true, NULL),
      ('key_legacy_revoked', 'deactivated', false, '2026-01-01T00:00:00.000Z'),
      ('key_legacy_expired', 'expired', false, NULL)`);

    await client.query(sql);

    const { rows } = await client.query<{ id: string; status: ApiKeyStatus; revoked: boolean }>(
      "SELECT id, status, revoked_at IS NOT NULL AS revoked FROM api_keys ORDER BY id"
    );
    expect(rows).toEqual([
      { id: "key_granted", status: "active", revoked: false },
      { id: "key_legacy_expired", status: "expired", revoked: false },
      { id: "key_legacy_live", status: "deactivated", revoked: true },
      { id: "key_legacy_revoked", status: "deactivated", revoked: true },
    ]);
    const { rows: columns } = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'api_keys' AND table_schema LIKE 'pg_temp%'
        ORDER BY column_name`
    );
    expect(columns.map((column) => column.column_name)).toEqual([
      "grants_assigned",
      "id",
      "revoked_at",
      "status",
    ]);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
