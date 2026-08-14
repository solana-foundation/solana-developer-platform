import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.resolve(here, "../.github/scripts/verify-release-identity.sh");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function releaseRepository(version = "1.2.3") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sdp-release-identity-"));
  git(directory, "init", "--initial-branch=main");
  git(directory, "config", "user.name", "Release Test");
  git(directory, "config", "user.email", "release-test@example.com");
  fs.writeFileSync(path.join(directory, "package.json"), `${JSON.stringify({ version })}\n`);
  git(directory, "add", "package.json");
  git(directory, "commit", "-m", `chore(main): release ${version}`);
  const sha = git(directory, "rev-parse", "HEAD");
  git(directory, "-c", "tag.gpgSign=false", "tag", `v${version}`);
  git(directory, "update-ref", "refs/remotes/origin/main", sha);
  return { directory, sha, tag: `v${version}` };
}

test("accepts an exact version tag and SHA contained in origin/main", (t) => {
  const fixture = releaseRepository();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));

  const output = execFileSync(verifier, [fixture.tag, fixture.sha], {
    cwd: fixture.directory,
    encoding: "utf8",
  });

  assert.match(output, /Verified v1\.2\.3 at [0-9a-f]{40} on origin\/main/);
});

test("rejects a tag whose version differs from package.json", (t) => {
  const fixture = releaseRepository();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  git(fixture.directory, "-c", "tag.gpgSign=false", "tag", "v1.2.4");

  const result = spawnSync(verifier, ["v1.2.4", fixture.sha], {
    cwd: fixture.directory,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match package\.json version 1\.2\.3/);
});

test("rejects a release commit outside origin/main", (t) => {
  const fixture = releaseRepository();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  git(fixture.directory, "checkout", "--orphan", "untrusted");
  fs.writeFileSync(
    path.join(fixture.directory, "package.json"),
    `${JSON.stringify({ version: "2.0.0" })}\n`
  );
  git(fixture.directory, "add", "package.json");
  git(fixture.directory, "commit", "-m", "chore(main): release 2.0.0");
  const untrustedSha = git(fixture.directory, "rev-parse", "HEAD");
  git(fixture.directory, "-c", "tag.gpgSign=false", "tag", "v2.0.0");

  const result = spawnSync(verifier, ["v2.0.0", untrustedSha], {
    cwd: fixture.directory,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is not contained in origin\/main/);
});
