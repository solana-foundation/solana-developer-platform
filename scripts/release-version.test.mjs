import assert from "node:assert/strict";
import test from "node:test";
import { nextReleaseVersion, releaseCommitSemantics } from "../.github/scripts/release-version.mjs";

const overriddenCommit = {
  breaking: true,
  // biome-ignore lint/security/noSecrets: Public Git commit SHA, not a secret.
  sha: "c3485d8c035d57cbd58c4058e2f4203369441459",
  type: "fix",
};
const featureCommit = { breaking: false, sha: "feature", type: "feat" };
const patchCommit = { breaking: false, sha: "patch", type: "fix" };

test("classifies conventional and breaking commits", () => {
  assert.deepEqual(releaseCommitSemantics("feat(api): add route", ""), {
    type: "feat",
    breaking: false,
  });
  assert.deepEqual(releaseCommitSemantics("fix(api): adjust route", "BREAKING CHANGE: no"), {
    type: "fix",
    breaking: true,
  });
});

test("ignores the inaccurate breaking footer on the overridden commit", () => {
  assert.equal(nextReleaseVersion("0.56.0", [overriddenCommit]), "0.56.1");
});

test("combines the overridden commit with features as a minor release", () => {
  assert.equal(nextReleaseVersion("0.56.0", [overriddenCommit, featureCommit]), "0.57.0");
});

test("keeps major bumps for every other breaking commit", () => {
  const breakingCommit = { breaking: true, sha: "different-commit", type: "fix" };

  assert.equal(nextReleaseVersion("0.56.0", [breakingCommit]), "1.0.0");
  assert.equal(nextReleaseVersion("2.56.0", [breakingCommit]), "3.0.0");
});

test("keeps normal feature and patch bumps unchanged", () => {
  assert.equal(nextReleaseVersion("0.56.0", [featureCommit]), "0.57.0");
  assert.equal(nextReleaseVersion("0.56.0", [patchCommit]), "0.56.1");
});

test("rejects malformed current versions", () => {
  assert.throws(() => nextReleaseVersion("0.56", [patchCommit]), /Invalid semver version/);
});
