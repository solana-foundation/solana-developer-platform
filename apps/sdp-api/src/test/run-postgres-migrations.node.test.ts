import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  applyPostgresMigration,
  getPostgresMigrationMode,
} from "../../scripts/lib/run-postgres-migrations.mjs";

function migrationClient(options: { invalidIndex?: boolean } = {}) {
  return {
    query: vi.fn(async (query: string) => ({
      rows: query.includes("FROM pg_index")
        ? options.invalidIndex
          ? [{ indisvalid: false }]
          : []
        : [],
    })),
  };
}

function readMigration(migrationFile: string) {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  return readFileSync(path.join(testDir, "../db/migrations/postgres", migrationFile), "utf8");
}

describe("Postgres migration runner", () => {
  it("installs pg_trgm before building each ledger index concurrently", () => {
    const extensionMigration = "0027_payment_transfer_ledger_indexes.sql";
    const extensionRepairMigration = "0027a_enable_pg_trgm.sql";
    const statusIndexMigration = "0028_payment_transfers_project_status_created_id.sql";
    const walletIndexMigration = "0029_payment_transfers_project_wallet_created_id.sql";
    const firstTrigramIndexMigration = "0032_payment_transfers_search_trgm.sql";
    const extensionSql = readMigration(extensionMigration);
    const extensionRepairSql = readMigration(extensionRepairMigration);
    const statusIndexSql = readMigration(statusIndexMigration);
    const walletIndexSql = readMigration(walletIndexMigration);

    expect(
      [
        extensionMigration,
        extensionRepairMigration,
        statusIndexMigration,
        walletIndexMigration,
        firstTrigramIndexMigration,
      ].sort((left, right) => left.localeCompare(right))
    ).toEqual([
      extensionMigration,
      extensionRepairMigration,
      statusIndexMigration,
      walletIndexMigration,
      firstTrigramIndexMigration,
    ]);
    for (const sql of [extensionSql, extensionRepairSql]) {
      expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm");
      expect(sql).not.toContain("CREATE INDEX");
      expect(getPostgresMigrationMode(sql)).toBe("transactional");
    }
    for (const sql of [statusIndexSql, walletIndexSql]) {
      expect(sql.match(/CREATE INDEX CONCURRENTLY/g)).toHaveLength(1);
      expect(getPostgresMigrationMode(sql)).toBe("non-transactional");
    }
  });

  it("keeps ordinary migrations atomic", async () => {
    const client = migrationClient();

    await applyPostgresMigration({
      client,
      migrationFile: "0001_example.sql",
      sql: "CREATE TABLE example (id TEXT PRIMARY KEY);",
    });

    expect(client.query.mock.calls.map(([query]) => query)).toEqual([
      "BEGIN",
      "CREATE TABLE example (id TEXT PRIMARY KEY);",
      "INSERT INTO schema_migrations (version) VALUES ($1)",
      "COMMIT",
    ]);
  });

  it("runs one annotated concurrent index outside a transaction", async () => {
    const client = migrationClient();
    const sql = `-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_example ON example(id);`;

    expect(getPostgresMigrationMode(sql)).toBe("non-transactional");
    await applyPostgresMigration({ client, migrationFile: "0028_example.sql", sql });

    const queries = client.query.mock.calls.map(([query]) => query);
    expect(queries).not.toContain("BEGIN");
    expect(queries).not.toContain("COMMIT");
    expect(queries).toEqual([
      expect.stringContaining("FROM pg_index"),
      sql,
      "INSERT INTO schema_migrations (version) VALUES ($1)",
    ]);
  });

  it("drops an invalid interrupted index before retrying its concurrent build", async () => {
    const client = migrationClient({ invalidIndex: true });
    const sql = `-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_example ON example(id);`;

    await applyPostgresMigration({ client, migrationFile: "0028_example.sql", sql });

    expect(client.query.mock.calls.map(([query]) => query)).toEqual([
      expect.stringContaining("FROM pg_index"),
      'DROP INDEX CONCURRENTLY IF EXISTS "idx_example"',
      sql,
      "INSERT INTO schema_migrations (version) VALUES ($1)",
    ]);
  });

  it("rejects multi-statement non-transactional migrations", async () => {
    const client = migrationClient();
    const sql = `-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_one ON example(id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_two ON example(id);`;

    await expect(
      applyPostgresMigration({ client, migrationFile: "0028_invalid.sql", sql })
    ).rejects.toThrow("must contain exactly one CREATE INDEX CONCURRENTLY");
    expect(client.query).not.toHaveBeenCalled();
  });
});
