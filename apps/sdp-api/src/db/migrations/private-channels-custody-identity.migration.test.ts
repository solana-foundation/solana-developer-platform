import { readFileSync } from "node:fs";
import { Client } from "pg";
import { expect, it, vi } from "vitest";
import {
  applyPostgresMigration,
  splitSqlStatements,
} from "@/scripts/lib/run-postgres-migrations.mjs";
import { adminDatabaseUrl, env } from "@/test/helpers/env";

const tables = [
  ["private_channel_verified_wallets", "wallet_id", "pubkey"],
  ["private_channel_deposits", "wallet_id", "depositor"],
  ["private_channel_withdrawals", "wallet_id", "owner"],
  ["private_channel_transfers", "sender_wallet_id", "sender"],
] as const;
const migrationFile = "0184_private_channel_custody_identity.sql";
const migrationSql = readFileSync(new URL(`./postgres/${migrationFile}`, import.meta.url), "utf8");

it("adds and backfills nullable PC custody links while retaining evidence and old writer inputs", async () => {
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const table of ["custody_configs", "custody_connections", "custody_wallets"]) {
      await client.query(
        `CREATE TEMP TABLE ${table} AS SELECT * FROM public.${table} WITH NO DATA`
      );
    }
    await client.query(`INSERT INTO custody_configs (id, organization_id, project_id)
      VALUES ('config', 'org', 'project')`);
    await client.query(`INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key)
      VALUES ('custody-source', 'config', 'provider-source', 'original-address')`);
    const before: Record<string, unknown>[] = [];
    for (const [table, source, address] of tables) {
      await client.query(
        `CREATE TEMP TABLE ${table} AS SELECT * FROM public.${table} WITH NO DATA`
      );
      await client.query(`ALTER TABLE ${table} DROP COLUMN custody_wallet_id`);
      if (table === "private_channel_verified_wallets") {
        await client.query(`INSERT INTO ${table} (id, wallet_id, pubkey)
          VALUES ('old-verification', 'provider-source', 'original-address')`);
      } else {
        const target = table === "private_channel_withdrawals" ? "destination" : "recipient";
        await client.query(`INSERT INTO ${table}
          (id, ${source}, ${address}, ${target}, amount, mint, status, signature, idempotency_key, idempotency_fingerprint)
          VALUES ('old-movement', 'provider-source', 'original-address', 'original-recipient', '1.5', 'original-mint', 'submitted', 'original-signature', 'kept-key', 'original-fingerprint')`);
        if (table !== "private_channel_transfers") {
          await client.query(`UPDATE ${table} SET context =
            '{"signedTransaction":"original-bytes","providerEvidence":{"requestId":"saved"}}'::jsonb`);
        }
      }
      await client.query(`UPDATE ${table} SET organization_id = 'org', project_id = 'project'`);
      before.push(
        (
          await client.query<{ row: Record<string, unknown> }>(
            `SELECT to_jsonb(t) AS row FROM ${table} t`
          )
        ).rows[0].row
      );
    }

    await client.query(migrationSql);
    for (const [index, [table]] of tables.entries()) {
      expect((await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t`)).rows).toEqual([
        { row: { ...before[index], custody_wallet_id: "custody-source" } },
      ]);
      // The previous writer may still omit the additive pin during deployment.
      await client.query(`INSERT INTO ${table} (id) VALUES ('previous-writer')`);
      expect(
        (await client.query(`SELECT custody_wallet_id FROM ${table} WHERE id = 'previous-writer'`))
          .rows
      ).toEqual([{ custody_wallet_id: null }]);
    }
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});

it("backfills only unique scoped PC custody links and preserves evidence and existing pins on rerun", async () => {
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const table of [
      "custody_configs",
      "custody_connections",
      "custody_wallets",
      ...tables.map(([table]) => table),
    ]) {
      await client.query(
        `CREATE TEMP TABLE ${table} AS SELECT * FROM public.${table} WITH NO DATA`
      );
    }
    await client.query(`INSERT INTO custody_configs (id, organization_id, project_id, status) VALUES
      ('archived', 'org', 'project', 'archived'),
      ('active', 'org', 'project', 'active'),
      ('other-org', 'other-org', 'project', 'active'),
      ('other-project', 'org', 'other-project', 'active')`);
    await client.query(`INSERT INTO custody_connections (id, organization_id, project_id, status) VALUES
      ('retired', 'org', 'project', 'deactivated'),
      ('unscoped', 'org', NULL, 'deactivated')`);
    await client.query(`INSERT INTO custody_wallets
      (id, custody_config_id, custody_connection_id, wallet_id, public_key, status) VALUES
      ('cw-config', 'archived', NULL, 'provider-config', 'address', 'inactive'),
      ('cw-connection', NULL, 'retired', 'provider-connection', 'address', 'inactive'),
      ('cw-duplicate-a', 'active', NULL, 'provider-duplicate', 'address', 'active'),
      ('cw-duplicate-b', 'archived', NULL, 'provider-duplicate', 'address', 'inactive'),
      ('cw-mixed-a', 'active', NULL, 'provider-mixed', 'address', 'active'),
      ('cw-mixed-b', NULL, 'retired', 'provider-mixed', 'address', 'inactive'),
      ('cw-other-org', 'other-org', NULL, 'provider-config', 'address', 'active'),
      ('cw-other-project', 'other-project', NULL, 'provider-config', 'address', 'active'),
      ('cw-foreign-only', 'other-org', NULL, 'provider-foreign', 'address', 'active'),
      ('cw-other-project-only', 'other-project', NULL, 'provider-other-project', 'address', 'active'),
      ('cw-unscoped', NULL, 'unscoped', 'provider-unscoped', 'address', 'inactive'),
      ('cw-orphan', NULL, NULL, 'provider-orphan', 'address', 'inactive')`);
    const before: Record<string, unknown>[][] = [];
    const expectedPins = [
      { id: "ambiguous-config", custody_wallet_id: null },
      { id: "ambiguous-mixed", custody_wallet_id: null },
      { id: "foreign-org", custody_wallet_id: null },
      { id: "foreign-project", custody_wallet_id: null },
      { id: "missing", custody_wallet_id: null },
      { id: "orphan", custody_wallet_id: null },
      { id: "pinned-ambiguous", custody_wallet_id: "cw-mixed-a" },
      { id: "pinned-inconsistent", custody_wallet_id: "retained-pin" },
      { id: "unique-config", custody_wallet_id: "cw-config" },
      { id: "unique-connection", custody_wallet_id: "cw-connection" },
      { id: "unscoped", custody_wallet_id: null },
      { id: "wrong-address", custody_wallet_id: null },
    ];
    for (const [table, provider, address] of tables) {
      await client.query(`INSERT INTO ${table}
        (id, organization_id, project_id, ${provider}, ${address}, custody_wallet_id) VALUES
        ('unique-config', 'org', 'project', 'provider-config', 'address', NULL),
        ('unique-connection', 'org', 'project', 'provider-connection', 'address', NULL),
        ('ambiguous-config', 'org', 'project', 'provider-duplicate', 'address', NULL),
        ('ambiguous-mixed', 'org', 'project', 'provider-mixed', 'address', NULL),
        ('foreign-org', 'org', 'project', 'provider-foreign', 'address', NULL),
        ('foreign-project', 'org', 'project', 'provider-other-project', 'address', NULL),
        ('missing', 'org', 'project', 'unknown-provider', 'address', NULL),
        ('orphan', 'org', 'project', 'provider-orphan', 'address', NULL),
        ('pinned-ambiguous', 'org', 'project', 'provider-mixed', 'address', 'cw-mixed-a'),
        ('pinned-inconsistent', 'org', 'project', 'provider-config', 'address', 'retained-pin'),
        ('unscoped', 'org', 'project', 'provider-unscoped', 'address', NULL),
        ('wrong-address', 'org', 'project', 'provider-config', 'wrong-address', NULL)`);
      await client.query(`UPDATE ${table} SET
        instance_id = 'retained-instance', created_at = '2026-01-01', updated_at = '2026-01-02'`);
      if (table === "private_channel_verified_wallets") {
        await client.query(
          `UPDATE ${table} SET user_id = 'retained-user', verified_at = '2026-01-01'`
        );
      } else {
        const target = table === "private_channel_withdrawals" ? "destination" : "recipient";
        await client.query(`UPDATE ${table} SET ${target} = 'retained-recipient', amount = '1.5',
          mint = 'retained-mint', status = 'submitted', signature = 'retained-signature',
          idempotency_key = id, idempotency_fingerprint = 'retained-fingerprint'`);
        if (table !== "private_channel_transfers") {
          await client.query(`UPDATE ${table} SET context =
            '{"signedTransaction":"retained-bytes","providerEvidence":{"requestId":"saved"}}'::jsonb`);
        }
      }
      before.push(
        (
          await client.query<{ row: Record<string, unknown> }>(
            `SELECT to_jsonb(t) - 'custody_wallet_id' AS row FROM ${table} t ORDER BY id`
          )
        ).rows.map(({ row }) => row)
      );
    }
    // Exercise backfill reruns against existing pins without re-adding the columns.
    const backfill = splitSqlStatements(migrationSql).filter(
      (sql) => !sql.startsWith("ALTER TABLE")
    );
    await client.query(`${backfill.join(";\n")};`);
    for (const [index, [table]] of tables.entries()) {
      expect(
        (await client.query(`SELECT id, custody_wallet_id FROM ${table} ORDER BY id`)).rows
      ).toEqual(expectedPins);
      expect(
        (
          await client.query<{ row: Record<string, unknown> }>(
            `SELECT to_jsonb(t) - 'custody_wallet_id' AS row FROM ${table} t ORDER BY id`
          )
        ).rows.map(({ row }) => row)
      ).toEqual(before[index]);
    }

    // A later sibling must not erase a saved identity; an old writer's late row can still catch up.
    await client.query(`INSERT INTO custody_wallets
      (id, custody_config_id, wallet_id, public_key) VALUES
      ('cw-later-sibling', 'active', 'provider-config', 'address')`);
    for (const [table, provider, address] of tables) {
      await client.query(`INSERT INTO ${table}
        (id, organization_id, project_id, ${provider}, ${address})
        VALUES ('late-row', 'org', 'project', 'provider-connection', 'address')`);
    }
    await client.query(`${backfill.join(";\n")};`);
    for (const [index, [table]] of tables.entries()) {
      expect(
        (
          await client.query(
            `SELECT id, custody_wallet_id FROM ${table} WHERE id <> 'late-row' ORDER BY id`
          )
        ).rows
      ).toEqual(expectedPins);
      expect(
        (await client.query(`SELECT custody_wallet_id FROM ${table} WHERE id = 'late-row'`)).rows
      ).toEqual([{ custody_wallet_id: "cw-connection" }]);
      expect(
        (
          await client.query<{ row: Record<string, unknown> }>(
            `SELECT to_jsonb(t) - 'custody_wallet_id' AS row FROM ${table} t WHERE id <> 'late-row' ORDER BY id`
          )
        ).rows.map(({ row }) => row)
      ).toEqual(before[index]);
    }

    for (const [table, provider, address] of tables) {
      for (const field of ["organization_id", "project_id", provider, address]) {
        await client.query(`INSERT INTO ${table}
          (id, organization_id, project_id, ${provider}, ${address})
          VALUES ('changed-${field}', 'org', 'project', 'provider-connection', 'address')`);
      }
    }
    const prepare = backfill.filter((sql) => sql.startsWith("CREATE TEMP TABLE"));
    const apply = backfill.filter((sql) => !sql.startsWith("CREATE TEMP TABLE"));
    await client.query(`${prepare.join(";\n")};`);
    // Previous writers may change a source or insert a row after the snapshots.
    for (const [table, provider, address] of tables) {
      for (const field of ["organization_id", "project_id", provider, address]) {
        await client.query(
          `UPDATE ${table} SET ${field} = 'changed' WHERE id = 'changed-${field}'`
        );
      }
      await client.query(`INSERT INTO ${table}
        (id, organization_id, project_id, ${provider}, ${address})
        VALUES ('after-snapshot', 'org', 'project', 'provider-connection', 'address')`);
    }
    await client.query(`${apply.join(";\n")};`);
    for (const [table] of tables) {
      expect(
        (
          await client.query(`SELECT custody_wallet_id FROM ${table}
        WHERE id LIKE 'changed-%' OR id = 'after-snapshot'`)
        ).rows
      ).toEqual(Array.from({ length: 5 }, () => ({ custody_wallet_id: null })));
    }
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});

it("rolls back all columns, backfills and the migration record when the last table exceeds its budget", async () => {
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    for (const table of [
      "custody_configs",
      "custody_connections",
      "custody_wallets",
      ...tables.map(([table]) => table),
      "schema_migrations",
    ]) {
      await client.query(
        `CREATE TEMP TABLE ${table} AS SELECT * FROM public.${table} WITH NO DATA`
      );
    }
    await client.query(`INSERT INTO custody_configs (id, organization_id, project_id)
      VALUES ('config', 'org', 'project')`);
    await client.query(`INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key)
      VALUES ('custody-source', 'config', 'provider-source', 'address')`);
    const before: Record<string, unknown>[] = [];
    for (const [table, provider, address] of tables) {
      await client.query(`ALTER TABLE ${table} DROP COLUMN custody_wallet_id`);
      await client.query(`INSERT INTO ${table}
        (id, organization_id, project_id, ${provider}, ${address})
        VALUES ('old-row', 'org', 'project', 'provider-source', 'address')`);
      before.push(
        (
          await client.query<{ row: Record<string, unknown> }>(
            `SELECT to_jsonb(t) AS row FROM ${table} t`
          )
        ).rows[0].row
      );
    }
    await client.query(`CREATE FUNCTION pg_temp.slow_backfill() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(10); RETURN NEW; END $$`);
    await client.query(`CREATE TRIGGER slow_backfill BEFORE UPDATE ON private_channel_transfers
      FOR EACH ROW EXECUTE FUNCTION pg_temp.slow_backfill()`);
    await expect(
      applyPostgresMigration({ client, migrationFile, sql: migrationSql })
    ).rejects.toMatchObject({ code: "57014" });
    for (const [index, [table]] of tables.entries()) {
      expect(
        (
          await client.query(`SELECT attname FROM pg_attribute
        WHERE attrelid = '${table}'::regclass
          AND attname = 'custody_wallet_id' AND NOT attisdropped`)
        ).rows
      ).toEqual([]);
      expect((await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t`)).rows).toEqual([
        { row: before[index] },
      ]);
    }
    expect((await client.query("SELECT version FROM schema_migrations")).rows).toEqual([]);
  } finally {
    await client.end();
  }
});

it("retries all custody columns and backfills after an old writer releases the last table", async () => {
  const client = new Client({ connectionString: adminDatabaseUrl });
  const blocker = new Client({ connectionString: adminDatabaseUrl });
  await Promise.all([client.connect(), blocker.connect()]);
  let release: Promise<void> | undefined;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {
    release ??= blocker.query("COMMIT").then(() => undefined);
  });
  try {
    await client.query("CREATE SCHEMA private_channel_custody_lock_test");
    await client.query("SET search_path TO private_channel_custody_lock_test");
    for (const table of [
      "custody_configs",
      "custody_connections",
      "custody_wallets",
      ...tables.map(([table]) => table),
      "schema_migrations",
    ]) {
      await client.query(`CREATE TABLE ${table} AS SELECT * FROM public.${table} WITH NO DATA`);
    }
    await client.query(`INSERT INTO custody_configs (id, organization_id, project_id)
      VALUES ('config', 'org', 'project')`);
    await client.query(`INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key)
      VALUES ('custody-source', 'config', 'provider-source', 'address')`);
    for (const [table, provider, address] of tables) {
      await client.query(`ALTER TABLE ${table} DROP COLUMN custody_wallet_id`);
      await client.query(`INSERT INTO ${table}
        (id, organization_id, project_id, ${provider}, ${address})
        VALUES ('old-row', 'org', 'project', 'provider-source', 'address')`);
    }
    await blocker.query("BEGIN");
    await blocker.query(`UPDATE private_channel_custody_lock_test.private_channel_transfers
      SET sender = sender WHERE id = 'old-row'`);

    await applyPostgresMigration({ client, migrationFile, sql: migrationSql });
    await release;
    expect(warn).toHaveBeenCalledTimes(1);
    for (const [table] of tables) {
      expect((await client.query(`SELECT custody_wallet_id FROM ${table}`)).rows).toEqual([
        { custody_wallet_id: "custody-source" },
      ]);
    }
    expect((await client.query("SELECT version FROM schema_migrations")).rows).toEqual([
      { version: migrationFile },
    ]);
  } finally {
    warn.mockRestore();
    await blocker.query("ROLLBACK");
    await client.query("DROP SCHEMA private_channel_custody_lock_test CASCADE");
    await Promise.all([client.end(), blocker.end()]);
  }
});
