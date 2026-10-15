import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";
import {
  applyPostgresMigration,
  applyRepeatableMigration,
  getPostgresMigrationMode,
} from "../../scripts/lib/run-postgres-migrations.mjs";

const SET_LOCK_TIMEOUT = "SELECT set_config('lock_timeout', $1, true)";
const RECORD_MIGRATION = "INSERT INTO schema_migrations (version) VALUES ($1)";

function migrationClient(
  options: { invalidIndex?: boolean; fail?: (query: string) => Error | undefined } = {}
) {
  return {
    query: vi.fn(async (query: string, _values?: string[]) => {
      const failure = options.fail?.(query);
      if (failure) throw failure;
      return {
        rows: query.includes("FROM pg_index")
          ? options.invalidIndex
            ? [{ indisvalid: false }]
            : []
          : [],
      };
    }),
  };
}

function sqlstateError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

/** Fails `sql` with a lock timeout the first `times` it runs. */
function lockTimeouts(sql: string, times: number) {
  let remaining = times;
  return (query: string) =>
    query === sql && remaining-- > 0
      ? sqlstateError("55P03", "canceling statement due to lock timeout")
      : undefined;
}

function queries(client: ReturnType<typeof migrationClient>) {
  return client.query.mock.calls.map(([query]) => query);
}

function readMigration(migrationFile: string) {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  return readFileSync(path.join(testDir, "../db/migrations/postgres", migrationFile), "utf8");
}

/**
 * The last migration number that two files share. The runner records each file
 * by its full name, so those historical pairs apply; a new duplicate means two
 * branches picked the same number and their order is down to the suffix.
 */
const LAST_SHARED_MIGRATION_NUMBER = 125;

describe("Postgres migration numbering", () => {
  it("gives every migration after the historical pairs its own number", () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(path.join(testDir, "../db/migrations/postgres")).filter((file) =>
      file.endsWith(".sql")
    );
    const byNumber = new Map<number, string[]>();
    for (const file of files) {
      const prefix = /^(\d{4})/.exec(file)?.[1];
      if (prefix === undefined) throw new Error(`Migration ${file} has no four-digit number`);
      const number = Number(prefix);
      byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
    }
    const shared = [...byNumber]
      .filter(([number, names]) => number > LAST_SHARED_MIGRATION_NUMBER && names.length > 1)
      .map(([, names]) => names.sort());
    expect(shared).toEqual([]);
  });
});

describe("Postgres migration runner", () => {
  it("backfills historical confirmed burns before enabling replay bookkeeping", () => {
    const sql = readMigration("0050_issuance_supply_bookkeeping.sql");

    expect(sql).toMatch(
      /UPDATE issuance_transactions\s+SET supply_bookkeeping_applied_at = updated_at\s+WHERE type IN \('burn', 'force_burn'\)\s+AND status = 'confirmed'\s+AND supply_bookkeeping_applied_at IS NULL;/
    );
  });

  it("backfills rings wallet owners before the identity pair check", () => {
    const sql = readMigration("0067_helius_rings_money_flows.sql");
    const ownerBackfill = sql.search(
      /UPDATE helius_rings_wallets w\s+SET owner_address = cw\.public_key/
    );
    const pairCheck = sql.lastIndexOf("helius_rings_wallets_owner_identity_pair_check");

    expect(ownerBackfill).toBeGreaterThan(-1);
    expect(pairCheck).toBeGreaterThan(ownerBackfill);
  });

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

  it("keeps ordinary migrations atomic under a default lock timeout set before the file runs", async () => {
    const client = migrationClient();

    await applyPostgresMigration({
      client,
      migrationFile: "0001_example.sql",
      sql: "CREATE TABLE example (id TEXT PRIMARY KEY);",
    });

    expect(client.query.mock.calls).toEqual([
      ["BEGIN"],
      [SET_LOCK_TIMEOUT, ["5s"]],
      ["CREATE TABLE example (id TEXT PRIMARY KEY);"],
      [RECORD_MIGRATION, ["0001_example.sql"]],
      ["COMMIT"],
    ]);
  });

  describe("after a lock timeout", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("rolls back and retries the whole migration", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const sql = "ALTER TABLE example ADD COLUMN note TEXT;";
      const client = migrationClient({ fail: lockTimeouts(sql, 1) });

      await applyPostgresMigration({
        client,
        migrationFile: "0002_example.sql",
        sql,
        lockRetryDelaysMs: [0, 0],
      });

      expect(queries(client)).toEqual([
        "BEGIN",
        SET_LOCK_TIMEOUT,
        sql,
        "ROLLBACK",
        "BEGIN",
        SET_LOCK_TIMEOUT,
        sql,
        RECORD_MIGRATION,
        "COMMIT",
      ]);
      expect(warn).toHaveBeenCalledWith(
        "0002_example.sql: canceling statement due to lock timeout; retrying in 0 ms (attempt 2 of 3)"
      );
    });

    it("gives up once every retry has timed out, recording nothing", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const sql = "ALTER TABLE example ADD COLUMN note TEXT;";
      const client = migrationClient({ fail: lockTimeouts(sql, 3) });

      await expect(
        applyPostgresMigration({
          client,
          migrationFile: "0002_example.sql",
          sql,
          lockRetryDelaysMs: [0, 0],
        })
      ).rejects.toMatchObject({ code: "55P03" });

      expect(queries(client).filter((query) => query === "BEGIN")).toHaveLength(3);
      expect(queries(client).filter((query) => query === "ROLLBACK")).toHaveLength(3);
      expect(queries(client)).not.toContain(RECORD_MIGRATION);
    });

    it("never retries a migration that failed for another reason", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const sql = "ALTER TABLE example ADD CONSTRAINT example_unique UNIQUE (id);";
      const client = migrationClient({
        fail: (query) => (query === sql ? sqlstateError("23505", "duplicate key") : undefined),
      });

      await expect(
        applyPostgresMigration({ client, migrationFile: "0003_example.sql", sql })
      ).rejects.toMatchObject({ code: "23505" });

      expect(queries(client)).toEqual(["BEGIN", SET_LOCK_TIMEOUT, sql, "ROLLBACK"]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("retries a repeatable file the same way", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const sql = "DROP VIEW IF EXISTS example_view; CREATE VIEW example_view AS SELECT 1 AS one;";
      const client = migrationClient({ fail: lockTimeouts(sql, 1) });

      await applyRepeatableMigration({
        client,
        repeatableFile: "example_view.sql",
        sql,
        lockRetryDelaysMs: [0],
      });

      expect(client.query.mock.calls).toEqual([
        ["BEGIN"],
        [SET_LOCK_TIMEOUT, ["5s"]],
        [sql],
        ["ROLLBACK"],
        ["BEGIN"],
        [SET_LOCK_TIMEOUT, ["5s"]],
        [sql],
        ["COMMIT"],
      ]);
      expect(warn).toHaveBeenCalledWith(
        "repeatable/example_view.sql: canceling statement due to lock timeout; retrying in 0 ms (attempt 2 of 2)"
      );
    });
  });

  it("runs one annotated concurrent index outside a transaction", async () => {
    const client = migrationClient();
    const sql = `-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_example ON example(id);`;

    expect(getPostgresMigrationMode(sql)).toBe("non-transactional");
    await applyPostgresMigration({ client, migrationFile: "0028_example.sql", sql });

    expect(queries(client)).not.toContain("BEGIN");
    expect(queries(client)).not.toContain("COMMIT");
    expect(queries(client)).toEqual([
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

describe("Postgres migration runner under live lock contention", () => {
  const table = "migration_lock_probe";
  const probeVersion = "9900_lock_probe.sql";
  const defaultVersion = "9901_lock_default.sql";
  const overrideVersion = "9902_lock_override.sql";
  const versions = [probeVersion, defaultVersion, overrideVersion];
  let migrator: Client;
  let blocker: Client;
  let traffic: Client;
  let migratorPid: number;

  async function untilMigratorWaitsOnLock(): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt++) {
      const { rows } = await traffic.query<{ wait_event_type: string | null }>(
        "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
        [migratorPid]
      );
      const [backend] = rows;
      if (!backend) throw new Error(`backend ${migratorPid} is gone`);
      if (backend.wait_event_type === "Lock") return;
      await sleep(10);
    }
    throw new Error("the migration never waited on a lock");
  }

  async function recorded(): Promise<string[]> {
    const { rows } = await traffic.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = ANY($1) ORDER BY version",
      [versions]
    );
    return rows.map((row) => row.version);
  }

  beforeAll(async () => {
    migrator = new Client({ connectionString: adminDatabaseUrl });
    blocker = new Client({ connectionString: adminDatabaseUrl });
    traffic = new Client({ connectionString: adminDatabaseUrl });
    await Promise.all([migrator.connect(), blocker.connect(), traffic.connect()]);
    const { rows } = await migrator.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const [backend] = rows;
    if (!backend) throw new Error("pg_backend_pid() returned no row");
    migratorPid = backend.pid;
  });

  afterAll(async () => {
    await Promise.all([migrator.end(), blocker.end(), traffic.end()]);
  });

  beforeEach(async () => {
    await traffic.query(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
    await traffic.query(`INSERT INTO ${table} VALUES (1)`);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await blocker.query("ROLLBACK");
    await traffic.query(`DROP TABLE IF EXISTS ${table}, ${table}_default, ${table}_override`);
    await traffic.query("DELETE FROM schema_migrations WHERE version = ANY($1)", [versions]);
  });

  it("gives up its place in the lock queue so queries behind it run, and records nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await blocker.query("BEGIN");
    await blocker.query(`SELECT id FROM ${table}`);

    const migration = applyPostgresMigration({
      client: migrator,
      migrationFile: probeVersion,
      sql: `ALTER TABLE ${table} ADD COLUMN note TEXT`,
      lockTimeout: "300ms",
      lockRetryDelaysMs: [10, 10],
    });
    const rejected = expect(migration).rejects.toMatchObject({ code: "55P03" });
    await untilMigratorWaitsOnLock();

    // Queued behind the migration's ACCESS EXCLUSIVE request, this read would
    // wait for the blocker's commit without a lock timeout.
    const { rows } = await traffic.query(`SELECT count(*)::int AS total FROM ${table}`);
    expect(rows).toEqual([{ total: 1 }]);

    await rejected;
    expect(await recorded()).toEqual([]);
    const columns = await traffic.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'note'",
      [table]
    );
    expect(columns.rows).toEqual([]);
  });

  it("applies the migration on a retry once the lock frees", async () => {
    let release: Promise<void> | undefined;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      release ??= blocker.query("COMMIT").then(() => undefined);
    });
    await blocker.query("BEGIN");
    await blocker.query(`SELECT id FROM ${table}`);

    await applyPostgresMigration({
      client: migrator,
      migrationFile: probeVersion,
      sql: `ALTER TABLE ${table} ADD COLUMN note TEXT`,
      lockTimeout: "100ms",
      lockRetryDelaysMs: [50, 50, 50, 50],
    });
    await release;

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("(attempt 2 of 5)"));
    expect(await recorded()).toEqual([probeVersion]);
  });

  it("lets a file's own SET LOCAL lock_timeout win and leaves the session without one", async () => {
    await applyPostgresMigration({
      client: migrator,
      migrationFile: defaultVersion,
      sql: `CREATE TABLE ${table}_default AS SELECT current_setting('lock_timeout') AS value`,
    });
    await applyPostgresMigration({
      client: migrator,
      migrationFile: overrideVersion,
      sql: `SET LOCAL lock_timeout = '2s';
CREATE TABLE ${table}_override AS SELECT current_setting('lock_timeout') AS value`,
    });

    const settings = await traffic.query(
      `SELECT 'default' AS source, value FROM ${table}_default
       UNION ALL SELECT 'override', value FROM ${table}_override ORDER BY source`
    );
    expect(settings.rows).toEqual([
      { source: "default", value: "5s" },
      { source: "override", value: "2s" },
    ]);
    expect((await migrator.query("SHOW lock_timeout")).rows).toEqual([{ lock_timeout: "0" }]);
  });

  it("lets a concurrent index build wait out an open write instead of timing out", async () => {
    await blocker.query("BEGIN");
    await blocker.query(`INSERT INTO ${table} VALUES (2)`);

    let settled = false;
    const migration = applyPostgresMigration({
      client: migrator,
      migrationFile: probeVersion,
      sql: `-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${table}_id ON ${table} (id);`,
      lockTimeout: "50ms",
      lockRetryDelaysMs: [],
    }).finally(() => {
      settled = true;
    });
    await untilMigratorWaitsOnLock();
    await sleep(300);
    expect(settled).toBe(false);

    await blocker.query("COMMIT");
    await migration;
    const index = await traffic.query(
      "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)",
      [`idx_${table}_id`]
    );
    expect(index.rows).toEqual([{ indisvalid: true }]);
  });
});
