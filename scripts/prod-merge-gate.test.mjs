import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Runs the real gate script against throwaway git repos, so CI fails when the
// shell behavior breaks even if the workflow text that calls it still matches.
const here = path.dirname(fileURLToPath(import.meta.url));
const gate = path.resolve(here, "../.github/scripts/prod-merge-gate.sh");
const MIGRATIONS = "apps/sdp-api/src/db/migrations/postgres";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prod-merge-gate-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "ci@example.com");
  git(dir, "config", "user.name", "ci");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "tag.gpgsign", "false");
  return dir;
}

function commit(dir, file, message) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), `-- ${message}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

function run(dir) {
  try {
    return { code: 0, out: execFileSync("bash", [gate], { cwd: dir, encoding: "utf8" }).trim() };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() };
  }
}

test("opens when the migrations directory matches the last v* tag", () => {
  const dir = repo();
  commit(dir, `${MIGRATIONS}/0001_init.sql`, "init");
  git(dir, "tag", "v0.1.0");
  commit(dir, "apps/sdp-api/src/index.ts", "code only");
  assert.deepEqual(run(dir), { code: 0, out: "open" });
});

test("holds, with the tag and file count, when a migration landed after the last v* tag", () => {
  const dir = repo();
  commit(dir, `${MIGRATIONS}/0001_init.sql`, "init");
  git(dir, "tag", "v0.1.0");
  commit(dir, `${MIGRATIONS}/0002_next.sql`, "schema");
  assert.deepEqual(run(dir), { code: 2, out: "1 migration file changed since v0.1.0" });
  commit(dir, `${MIGRATIONS}/0003_more.sql`, "more schema");
  assert.deepEqual(run(dir), { code: 2, out: "2 migration files changed since v0.1.0" });
});

test("holds instead of opening when no v* tag is reachable", () => {
  const dir = repo();
  commit(dir, `${MIGRATIONS}/0001_init.sql`, "init");
  git(dir, "tag", "release-1");
  const r = run(dir);
  assert.equal(r.code, 2);
  assert.match(r.out, /no v\* release tag/);
});

test("reopens once the release tag catches up with the migrations", () => {
  const dir = repo();
  commit(dir, `${MIGRATIONS}/0001_init.sql`, "init");
  git(dir, "tag", "v0.1.0");
  commit(dir, `${MIGRATIONS}/0002_next.sql`, "schema");
  assert.equal(run(dir).code, 2);
  git(dir, "tag", "v0.2.0");
  assert.deepEqual(run(dir), { code: 0, out: "open" });
});
