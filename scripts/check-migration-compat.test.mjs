import assert from "node:assert/strict";
import test from "node:test";
import { checkMigrationChange, findBreakingStatements } from "./check-migration-compat.mjs";

const SQL = "apps/sdp-api/src/db/migrations/postgres/0102_example.sql";
const check = (sql, changed = [SQL]) => checkMigrationChange(changed, () => sql);

test("additive migrations pass", () => {
  const sql =
    "ALTER TABLE a ADD COLUMN b TEXT;\n" +
    "CREATE INDEX IF NOT EXISTS a_b ON a (b);\n" +
    "ALTER TABLE a ADD COLUMN c TEXT NOT NULL DEFAULT '', ADD COLUMN d NUMERIC(10,2);\n" +
    "ALTER TABLE a ADD COLUMN e BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL;\n" +
    "ALTER TABLE a DROP CONSTRAINT a_old_check, ADD CONSTRAINT a_fk FOREIGN KEY (b) REFERENCES x (id);\n" +
    "INSERT INTO a (b) VALUES ('x') ON CONFLICT DO NOTHING;\n" +
    "CREATE POLICY p ON a FOR UPDATE USING (true);\n" +
    "-- DROP TABLE a;";
  assert.deepEqual(findBreakingStatements(sql), []);
  assert.deepEqual(check(sql, [SQL, "apps/sdp-api/src/routes/a.ts"]), []);
});

test("contractions are flagged per ALTER TABLE action", () => {
  const found = findBreakingStatements(
    "ALTER TABLE a DROP COLUMN b;\n" +
      "ALTER TABLE a ADD COLUMN c TEXT NOT NULL, ADD COLUMN d TEXT NOT NULL DEFAULT 'x';\n" +
      "ALTER TABLE a ALTER COLUMN e TYPE BIGINT;\n" +
      "ALTER TABLE a ALTER f SET NOT NULL;\n" +
      "ALTER TABLE a RENAME COLUMN g TO h;\n" +
      'ALTER TABLE IF EXISTS "a" DROP i;'
  );
  assert.equal(found.length, 6);
  assert.match(found[1], /adds a NOT NULL column without a DEFAULT/);
});

test("row rewrites are flagged, including through a CTE or an upsert", () => {
  const found = findBreakingStatements(
    "DELETE FROM a WHERE x = 1;\n" +
      "WITH ranked AS (SELECT id FROM a) UPDATE a SET x = 2 WHERE id IN (SELECT id FROM ranked);\n" +
      "WITH dupes AS (SELECT id FROM a) DELETE FROM a USING dupes WHERE a.id = dupes.id;\n" +
      "INSERT INTO a (id, x) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET x = EXCLUDED.x;\n" +
      "TRUNCATE a;"
  );
  assert.equal(found.length, 5);
  assert.ok(found.every((finding) => finding.startsWith("rewrites rows")));
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
