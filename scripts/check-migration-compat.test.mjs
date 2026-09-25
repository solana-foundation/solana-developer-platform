import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  checkMigrationChange,
  findBreakingStatements,
  findRemovedViewColumns,
} from "./check-migration-compat.mjs";

const SQL = "apps/sdp-api/src/db/migrations/postgres/0102_example.sql";
const POSTGRES = new URL("../apps/sdp-api/src/db/migrations/postgres/", import.meta.url);
const check = (sql, changed = [SQL]) => checkMigrationChange(changed, () => sql);
const reasons = (sql) => findBreakingStatements(sql).map((finding) => finding.split(":")[0]);

test("additive migrations pass", () => {
  const sql =
    "ALTER TABLE a ADD COLUMN b TEXT;\n" +
    "CREATE INDEX IF NOT EXISTS a_b ON a (b);\n" +
    "ALTER TABLE a ADD COLUMN c TEXT NOT NULL DEFAULT '', ADD COLUMN d NUMERIC(10,2);\n" +
    "ALTER TABLE a ADD COLUMN e BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL;\n" +
    "ALTER TABLE a ADD CONSTRAINT a_shape CHECK (b IS NULL OR c IS NOT NULL);\n" +
    "ALTER TABLE a ADD CONSTRAINT a_fk FOREIGN KEY (b) REFERENCES x (id);\n" +
    "INSERT INTO a (b) VALUES ('x') ON CONFLICT DO NOTHING;\n" +
    "CREATE POLICY p ON a FOR UPDATE USING (true);\n" +
    "CREATE TRIGGER t BEFORE UPDATE OR DELETE ON a FOR EACH STATEMENT EXECUTE FUNCTION f();\n" +
    "COMMENT ON COLUMN a.b IS 'has -- dashes; and a semicolon';\n" +
    "-- DROP TABLE a;";
  assert.deepEqual(findBreakingStatements(sql), []);
  assert.deepEqual(check(sql, [SQL, "apps/sdp-api/src/routes/a.ts"]), []);
});

test("backfills of columns and tables this file adds pass, rewrites of existing data do not", () => {
  const backfill =
    "ALTER TABLE a ADD COLUMN IF NOT EXISTS next_check_at TEXT;\n" +
    "UPDATE a SET next_check_at = COALESCE(last_checked_at, updated_at), updated_at = now() WHERE status IN ('x', 'y') AND next_check_at IS NULL;\n" +
    "CREATE TABLE b (id TEXT PRIMARY KEY, v TEXT NOT NULL);\n" +
    "INSERT INTO b (id, v) SELECT id, v FROM a ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v;\n" +
    "DELETE FROM b WHERE v = '';\n" +
    "ALTER TABLE b ADD COLUMN w TEXT NOT NULL;";
  assert.deepEqual(findBreakingStatements(backfill), []);

  assert.deepEqual(
    reasons(
      "UPDATE counterparties cpa SET provider_status = 'x', updated_at = now() FROM projects prj WHERE prj.id = cpa.project_id;\n" +
        "DELETE FROM a WHERE x = 1;\n" +
        "WITH ranked AS (SELECT id FROM a) UPDATE a SET x = 2 WHERE id IN (SELECT id FROM ranked);\n" +
        "WITH repaired AS (UPDATE a SET status = 'confirmed' WHERE status = 'finalized' RETURNING id) UPDATE p SET closed_at = NULL FROM repaired WHERE p.id = repaired.id;\n" +
        "INSERT INTO a (id, x) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET x = EXCLUDED.x;\n" +
        "TRUNCATE a;"
    ),
    [
      "rewrites rows",
      "rewrites rows",
      "rewrites rows",
      "rewrites rows",
      "rewrites rows",
      "rewrites rows",
      "rewrites rows",
    ]
  );
});

test("contractions are flagged per ALTER TABLE action and for every DROP", () => {
  assert.deepEqual(
    reasons(
      "ALTER TABLE a DROP COLUMN b;\n" +
        "ALTER TABLE a ADD COLUMN c TEXT NOT NULL, ADD COLUMN d TEXT NOT NULL DEFAULT 'x';\n" +
        "ALTER TABLE a ALTER COLUMN e TYPE BIGINT;\n" +
        "ALTER TABLE a ALTER f SET NOT NULL;\n" +
        "ALTER TABLE a RENAME COLUMN g TO h;\n" +
        'ALTER TABLE IF EXISTS "a" DROP i;\n' +
        'ALTER TABLE "public"."accounts" DROP COLUMN old;\n' +
        "ALTER TABLE ONLY public.accounts ADD COLUMN j TEXT NOT NULL;\n" +
        "ALTER TABLE a DROP CONSTRAINT a_unique;\n" +
        "DROP INDEX CONCURRENTLY IF EXISTS a_b_idx;\n" +
        "DROP FUNCTION f(text);\n" +
        "DROP TRIGGER t ON a;\n" +
        "DROP TABLE old_table;"
    ),
    [
      "drops a column",
      "adds a NOT NULL column without a DEFAULT",
      "changes a column type",
      "makes an existing column NOT NULL",
      "renames a table or column",
      "drops a column",
      "drops a column",
      "adds a NOT NULL column without a DEFAULT",
      "drops a constraint",
      "drops a index",
      "drops a function",
      "drops a trigger",
      "drops a table",
    ]
  );
});

test("dropping something this file recreates is a replace, not a contraction", () => {
  const sql =
    "ALTER TABLE a DROP CONSTRAINT IF EXISTS a_shape;\n" +
    "ALTER TABLE a ADD CONSTRAINT a_shape CHECK (x IS NOT NULL);\n" +
    "ALTER TABLE b DROP CONSTRAINT b_kind_check, ADD CONSTRAINT b_kind_check_v2 CHECK (kind IN ('x', 'y'));\n" +
    "DROP INDEX IF EXISTS a_idx;\n" +
    "CREATE UNIQUE INDEX a_idx ON a (x, y);\n" +
    "DROP TRIGGER IF EXISTS t ON a;\n" +
    "CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW EXECUTE FUNCTION f();\n" +
    "CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;\n" +
    "ALTER TABLE a ADD COLUMN tmp TEXT;\n" +
    "ALTER TABLE a DROP COLUMN tmp;\n" +
    "CREATE TABLE scratch (id TEXT);\n" +
    "DROP TABLE scratch;";
  assert.deepEqual(findBreakingStatements(sql), []);
});

test("recreating an existing object does not launder its removal", () => {
  assert.deepEqual(
    reasons(
      "DROP TABLE a;\n" +
        "CREATE TABLE a (id TEXT PRIMARY KEY);\n" +
        "CREATE TABLE IF NOT EXISTS b (id TEXT PRIMARY KEY);\n" +
        "DELETE FROM b WHERE id = 'x';\n" +
        "ALTER TABLE c DROP CONSTRAINT c_old_check;\n" +
        "ALTER TABLE c ADD CONSTRAINT c_new_check CHECK (x > 0);"
    ),
    ["drops a table", "rewrites rows", "drops a constraint"]
  );
});

test("statements inside DO blocks are checked", () => {
  const guarded =
    "DO $$\nBEGIN\n  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'a' AND column_name = 'b') THEN\n" +
    "    ALTER TABLE a DROP COLUMN b;\n  END IF;\nEND $$;";
  assert.deepEqual(reasons(guarded), ["drops a column"]);

  const readOnly =
    "DO $body$\nDECLARE\n  n INTEGER := 0;\nBEGIN\n  SELECT count(*) INTO n FROM a;\n" +
    "  IF n > 0 THEN\n    RAISE EXCEPTION 'unexpected rows: %; refusing', n;\n  END IF;\n" +
    "  ALTER TABLE a ADD COLUMN c TEXT;\nEND\n$body$;";
  assert.deepEqual(findBreakingStatements(readOnly), []);

  const scratch =
    "DO $$\nBEGIN\n  CREATE TABLE scratch (id TEXT);\n  INSERT INTO scratch SELECT id FROM a;\n" +
    "  DELETE FROM scratch WHERE id IS NULL;\n  DROP TABLE scratch;\nEND $$;";
  assert.deepEqual(findBreakingStatements(scratch), []);
  assert.deepEqual(reasons("DO $$\nBEGIN\n  DROP TABLE a;\n  CREATE TABLE a (id TEXT);\nEND $$;"), [
    "drops a table",
  ]);
  assert.deepEqual(
    reasons(
      "DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'accounts') THEN\n" +
        "    CREATE TABLE accounts (id TEXT);\n  ELSE\n    DROP TABLE accounts;\n  END IF;\nEND $$;"
    ),
    ["drops a table"]
  );
  assert.deepEqual(
    findBreakingStatements(
      "CREATE TABLE scratch (id TEXT);\n" +
        "DO $$\nBEGIN\n  IF EXISTS (SELECT 1 FROM scratch) THEN\n    DELETE FROM scratch;\n    DROP TABLE scratch;\n  END IF;\nEND $$;\n" +
        "DO $$\nBEGIN\n  CREATE TABLE t (id TEXT);\n  IF true THEN\n    DROP TABLE t;\n  END IF;\nEND $$;"
    ),
    []
  );
  assert.deepEqual(
    reasons(
      "DO $$\nBEGIN\n  IF true THEN\n    CREATE TABLE t (id TEXT);\n  END IF;\nEND $$;\nDELETE FROM t WHERE id IS NULL;"
    ),
    ["rewrites rows"]
  );
  assert.deepEqual(
    reasons(
      "DO $$\nBEGIN\n  CREATE TABLE accounts (id TEXT);\nEXCEPTION\n  WHEN duplicate_table THEN\n    DROP TABLE accounts;\nEND $$;\n" +
        "DELETE FROM accounts WHERE id IS NULL;"
    ),
    ["drops a table", "rewrites rows"]
  );
  assert.deepEqual(
    findBreakingStatements(
      "DO $$\nBEGIN\n  PERFORM 1;\nEXCEPTION\n  WHEN OTHERS THEN\n    CREATE TABLE scratch (id TEXT);\n" +
        "    INSERT INTO scratch SELECT 1;\n    DROP TABLE scratch;\nEND $$;"
    ),
    []
  );
});

test("a flagged migration needs the breaking directive", () => {
  const violations = check("ALTER TABLE a DROP COLUMN b;");
  assert.equal(violations.length, 1);
  assert.match(violations[0], /sdp:migration-compat: breaking/);
});

test("the breaking directive allows a migrations-only PR", () => {
  const sql = "-- sdp:migration-compat: breaking\nALTER TABLE a DROP COLUMN b;";
  assert.deepEqual(
    check(sql, [SQL, "apps/sdp-api/src/db/migrations/drop-b.migration.test.ts"]),
    []
  );
  assert.equal(check(sql, [SQL, "apps/sdp-api/src/routes/a.ts"]).length, 1);
});

test("files outside the postgres directory and deleted files are ignored", () => {
  assert.deepEqual(
    checkMigrationChange([SQL, "apps/sdp-api/src/routes/a.ts"], () => null),
    []
  );
  assert.deepEqual(check("DROP TABLE a;", ["apps/sdp-api/src/db/migrations/notes.sql"]), []);
});

test("IF NOT EXISTS additions do not launder later removals", () => {
  assert.deepEqual(
    reasons(
      "ALTER TABLE a ADD COLUMN IF NOT EXISTS email TEXT;\n" +
        "ALTER TABLE a DROP COLUMN email;\n" +
        "CREATE UNIQUE INDEX IF NOT EXISTS existing_uq ON a (x);\n" +
        "DROP INDEX existing_uq;\n" +
        "DROP TABLE scratch, users;\n" +
        "DROP INDEX IF EXISTS replaced_idx;\n" +
        "CREATE INDEX IF NOT EXISTS replaced_idx ON a (y);"
    ),
    ["drops a column", "drops a index", "drops a table", "drops a table"]
  );
  assert.deepEqual(
    findBreakingStatements(
      "ALTER TABLE a ADD COLUMN IF NOT EXISTS next_check_at TEXT;\nUPDATE a SET next_check_at = updated_at;"
    ),
    []
  );
});

test("defaults, new constraints, and dynamic SQL", () => {
  assert.deepEqual(
    reasons(
      "ALTER TABLE a ADD COLUMN c TEXT NOT NULL DEFAULT 'x';\n" +
        "ALTER TABLE a ALTER COLUMN c DROP DEFAULT;\n" +
        "ALTER TABLE a ALTER COLUMN existing DROP DEFAULT;\n" +
        "ALTER TABLE a ADD CONSTRAINT a_uq UNIQUE (existing_col);\n" +
        "ALTER TABLE a ADD CONSTRAINT a_fk FOREIGN KEY (existing_col) REFERENCES b (id);\n" +
        "ALTER TABLE a ADD CONSTRAINT a_ex EXCLUDE USING gist (r WITH &&);\n" +
        "DO $$\nBEGIN\n  EXECUTE format('ALTER TABLE %I DROP COLUMN old', 'a');\nEND $$;"
    ),
    [
      "removes a default the previous image relies on",
      "removes a default the previous image relies on",
      "adds a unique constraint over existing columns",
      "adds a foreign key over existing columns",
      "adds an exclusion constraint on an existing table",
      "runs dynamic SQL that cannot be checked",
    ]
  );
  assert.deepEqual(
    findBreakingStatements(
      "ALTER TABLE a ADD COLUMN nullable TEXT DEFAULT 'x';\n" +
        "ALTER TABLE a ALTER COLUMN nullable DROP DEFAULT;\n" +
        "ALTER TABLE a ADD COLUMN ref_id TEXT;\n" +
        "ALTER TABLE a ADD CONSTRAINT a_ref_fk FOREIGN KEY (ref_id) REFERENCES b (id);\n" +
        "ALTER TABLE a ADD CONSTRAINT a_ref_uq UNIQUE (ref_id);\n" +
        "ALTER TABLE a ADD CONSTRAINT a_check CHECK (x > 0);\n" +
        "CREATE TABLE n (id TEXT PRIMARY KEY, v TEXT);\n" +
        "ALTER TABLE n ADD CONSTRAINT n_uq UNIQUE (v);\n" +
        "CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW EXECUTE FUNCTION f();"
    ),
    []
  );
});

test("repeatable views: removed output columns are contractions", () => {
  const base =
    "DROP VIEW IF EXISTS unified_transactions;\n" +
    "CREATE VIEW unified_transactions WITH (security_invoker = true) AS\nSELECT\n  u.id,\n  u.kind,\n  cw.label AS custody_wallet_label,\n  COALESCE(u.status, 'x') AS status\nFROM unified u\nLEFT JOIN custody_wallets cw ON cw.id = u.custody_wallet_id;";
  const head = base.replace("  u.kind,\n", "").replace("custody_wallet_label", "wallet_label");
  assert.deepEqual(findRemovedViewColumns(base, head), [
    "removes column kind from view unified_transactions",
    "removes column custody_wallet_label from view unified_transactions",
  ]);
  assert.deepEqual(
    findRemovedViewColumns(base, `${base}\nCREATE VIEW other AS SELECT 1 AS one;`),
    []
  );
  assert.deepEqual(findRemovedViewColumns(base, ""), [
    "drops the repeatable view unified_transactions",
  ]);
  const wildcard = base.replace(/SELECT[\s\S]*?FROM unified u/, "SELECT u.* FROM unified u");
  const unverifiable = [
    "cannot verify the output columns of view unified_transactions through a wildcard projection",
  ];
  assert.deepEqual(findRemovedViewColumns(base, wildcard), unverifiable);
  assert.deepEqual(findRemovedViewColumns(wildcard, head), unverifiable);
  assert.deepEqual(findRemovedViewColumns(wildcard, wildcard.replace("u.id", "u.id")), []);

  const file = "apps/sdp-api/src/db/migrations/postgres/repeatable/unified_transactions.sql";
  assert.equal(
    checkMigrationChange(
      [file],
      () => head,
      () => base
    ).length,
    1
  );
  assert.deepEqual(
    checkMigrationChange(
      [file],
      () => base,
      () => base
    ),
    []
  );
});

test("existing migrations: a same-file backfill passes and a data repair is flagged", () => {
  const read = (name) => readFileSync(new URL(name, POSTGRES), "utf8");
  assert.deepEqual(findBreakingStatements(read("0118_earn_queued_withdrawal_schedule.sql")), []);
  assert.deepEqual(reasons(read("0116_bvnk_offramp_provider_data.sql")), [
    "rewrites rows",
    "rewrites rows",
  ]);
});
