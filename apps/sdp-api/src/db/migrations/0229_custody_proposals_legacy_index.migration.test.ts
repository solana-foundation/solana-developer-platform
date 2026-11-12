import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUCCESSFUL_PAYMENT_TRANSFER_STATUSES } from "@sdp/types/payments";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";

const migrationSql = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0229_custody_proposals_legacy_index.sql"
  ),
  "utf8"
);
let client: Client;
beforeAll(async () => {
  client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
});
afterAll(async () => {
  await client.end();
});
beforeEach(async () => {
  await client.query("BEGIN");
  await client.query(
    "CREATE TEMP TABLE payment_transfers (id TEXT PRIMARY KEY, project_id TEXT, created_at TEXT NOT NULL, status TEXT NOT NULL, provider_data JSONB NOT NULL) ON COMMIT DROP"
  );
  // Only this isolated test changes CONCURRENTLY: PostgreSQL disallows it in a transaction.
  await client.query(migrationSql.replace("INDEX CONCURRENTLY", "INDEX"));
});
afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0229 rolling proposal bridge index", () => {
  it("is nonblocking and covers pending old writes plus every terminal refusal alert", async () => {
    expect(migrationSql).toContain("-- sdp:migration-mode: non-transactional");
    expect(migrationSql).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS");
    const index = await client.query<{ predicate: string; definition: string }>(
      "SELECT pg_get_expr(indpred, indrelid) AS predicate, pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid = 'pg_temp.payment_transfers'::regclass AND indisprimary = false"
    );
    expect(index.rows).toHaveLength(1);
    const predicate = index.rows[0]?.predicate;
    expect(predicate).toContain("'processing'::text");
    for (const status of SUCCESSFUL_PAYMENT_TRANSFER_STATUSES)
      expect(predicate).toContain(`'${status}'::text`);
    expect(predicate).toContain("'proposalRefusal'::text");
    expect(predicate).toContain("'proposalRefusalAlertedAt'::text");
    expect(index.rows[0]?.definition).toContain("project_id, created_at, id");
  });
});
