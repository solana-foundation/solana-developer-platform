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

describe("Postgres migration runner", () => {
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
