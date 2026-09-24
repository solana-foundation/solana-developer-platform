import assert from "node:assert/strict";
import test from "node:test";
import { checkMigrationChange, findBreakingStatements } from "./check-migration-compat.mjs";

const SQL = "apps/sdp-api/src/db/migrations/postgres/0102_example.sql";
const check = (sql, changed = [SQL]) => checkMigrationChange(changed, () => sql);

test("additive migrations pass", () => {
  const sql =
    "ALTER TABLE a ADD COLUMN b TEXT;\n" +
    "CREATE INDEX IF NOT EXISTS a_b ON a (b);\n" +
    "ALTER TABLE a ADD COLUMN c TEXT NOT NULL DEFAULT '';\n" +
    "-- DROP TABLE a;";
  assert.deepEqual(findBreakingStatements(sql), []);
  assert.deepEqual(check(sql, [SQL, "apps/sdp-api/src/routes/a.ts"]), []);
});

test("contractions and row rewrites are flagged", () => {
  const sql =
    "ALTER TABLE a DROP COLUMN b;\n" +
    "ALTER TABLE a ADD COLUMN c TEXT NOT NULL;\n" +
    "ALTER TABLE a ALTER COLUMN d TYPE BIGINT;\n" +
    "DELETE FROM a WHERE x = 1;";
  assert.equal(findBreakingStatements(sql).length, 4);
  assert.equal(check(sql).length, 1);
  assert.match(check(sql)[0], /sdp:migration-compat: breaking/);
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
