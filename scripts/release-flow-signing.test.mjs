import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const releaseFlowScript = path.join(repoRoot, ".github/scripts/release-flow.mjs");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: 20_000,
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function git(cwd, args) {
  const result = run("git", args, { cwd });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createReleaseFixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `sdp-release-flow-${process.pid}-`));
  fs.mkdirSync(path.join(cwd, ".github"), { recursive: true });

  git(cwd, ["init"]);
  git(cwd, ["config", "user.name", "Fixture Author"]);
  git(cwd, ["config", "user.email", "fixture@example.com"]);
  git(cwd, [
    "remote",
    "add",
    "origin",
    "https://github.com/solana-foundation/solana-developer-platform.git",
  ]);

  writeJson(path.join(cwd, "package.json"), {
    name: "fixture",
    version: "0.1.0",
  });
  fs.writeFileSync(path.join(cwd, "CHANGELOG.md"), "# Changelog\n");
  writeJson(path.join(cwd, ".github/.release-please-manifest.json"), { ".": "0.1.0" });

  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "chore(main): release 0.1.0"]);
  git(cwd, ["tag", "v0.1.0"]);

  fs.writeFileSync(path.join(cwd, "feature.txt"), "new feature\n");
  git(cwd, ["add", "feature.txt"]);
  git(cwd, ["commit", "-m", "feat: add signed release coverage"]);

  return cwd;
}

function createSigningKey(cwd) {
  const keyPath = path.join(cwd, ".git", "release-signing-key");
  const result = run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
  assert.equal(result.status, 0, result.stderr);
  return keyPath;
}

function releaseEnv(signingKeyPath) {
  return {
    ...process.env,
    GITHUB_REPOSITORY: "solana-foundation/solana-developer-platform",
    GITHUB_TOKEN: "fixture-token",
    RELEASE_GIT_SIGNING_KEY: fs.readFileSync(signingKeyPath, "utf8"),
    RELEASE_GIT_USER_EMAIL: "release@example.com",
    RELEASE_GIT_USER_NAME: "Release Bot",
    RUNNER_TEMP: path.join(path.dirname(signingKeyPath), "runner-temp"),
  };
}

function runReleaseFlow(cwd, args, env) {
  return run(process.execPath, [releaseFlowScript, ...args], {
    cwd,
    env,
  });
}

test("prepare signs the generated release commit", () => {
  const cwd = createReleaseFixture();
  try {
    const signingKeyPath = createSigningKey(cwd);
    const result = runReleaseFlow(cwd, ["prepare", "--skip-remote"], releaseEnv(signingKeyPath));
    assert.equal(result.status, 0, result.stderr);

    assert.equal(git(cwd, ["log", "-1", "--format=%s"]), "chore(main): release 0.2.0");
    assert.equal(
      git(cwd, ["log", "-1", "--format=%cn <%ce>"]),
      "Release Bot <release@example.com>"
    );
    assert.match(git(cwd, ["cat-file", "-p", "HEAD"]), /-----BEGIN SSH SIGNATURE-----/);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version,
      "0.2.0"
    );
  } finally {
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test("prepare fails before mutating the release files when signing config is missing", () => {
  const cwd = createReleaseFixture();
  try {
    const result = runReleaseFlow(cwd, ["prepare", "--skip-remote"], {
      ...process.env,
      GITHUB_REPOSITORY: "solana-foundation/solana-developer-platform",
      GITHUB_TOKEN: "fixture-token",
    });

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Release signing requires RELEASE_GIT_USER_NAME and RELEASE_GIT_USER_EMAIL/
    );
    assert.equal(git(cwd, ["log", "-1", "--format=%s"]), "feat: add signed release coverage");
    assert.equal(git(cwd, ["status", "--short"]), "");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version,
      "0.1.0"
    );
  } finally {
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test("publish signs the release tag", () => {
  const cwd = createReleaseFixture();
  try {
    const signingKeyPath = createSigningKey(cwd);
    const env = releaseEnv(signingKeyPath);

    const prepare = runReleaseFlow(cwd, ["prepare", "--skip-remote"], env);
    assert.equal(prepare.status, 0, prepare.stderr);

    const publish = runReleaseFlow(cwd, ["publish", "--skip-remote"], env);
    assert.equal(publish.status, 0, publish.stderr);
    assert.match(git(cwd, ["cat-file", "-p", "v0.2.0"]), /-----BEGIN SSH SIGNATURE-----/);
  } finally {
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});
