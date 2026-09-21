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

test("reads a breaking change from a footer, not from prose", () => {
  // A real footer, which is what Conventional Commits defines.
  assert.equal(
    releaseCommitSemantics("fix(api): adjust route", "BREAKING CHANGE: the route moved").breaking,
    true
  );
  // The hyphenated spelling the spec also allows.
  assert.equal(
    releaseCommitSemantics("fix(api): adjust route", "BREAKING-CHANGE: the route moved").breaking,
    true
  );
  // A footer after other body text still counts.
  assert.equal(
    releaseCommitSemantics("fix(api): adjust route", "Some context.\n\nBREAKING CHANGE: gone")
      .breaking,
    true
  );

  // The exact prose that made 0.79.0 announce its own tooling commit as
  // breaking. It contains the substring, and it is not a footer.
  assert.equal(
    releaseCommitSemantics(
      "fix(release): surface breaking changes in the changelog",
      "a breaking commit keeps its entry in its type section and also surfaces in a BREAKING CHANGES section on top"
    ).breaking,
    false
  );
  // A mid-line mention is not a footer either.
  assert.equal(
    releaseCommitSemantics("docs: explain policy", "We document every BREAKING CHANGE: here.")
      .breaking,
    false
  );
});

test("ignores the inaccurate breaking footer on the overridden commit", () => {
  assert.equal(nextReleaseVersion("0.56.0", [overriddenCommit]), "0.56.1");
});

test("combines the overridden commit with features as a minor release", () => {
  assert.equal(nextReleaseVersion("0.56.0", [overriddenCommit, featureCommit]), "0.57.0");
});

test("keeps major bumps for every other breaking commit once past 1.0", () => {
  const breakingCommit = { breaking: true, sha: "different-commit", type: "fix" };

  assert.equal(nextReleaseVersion("1.0.0", [breakingCommit]), "2.0.0");
  assert.equal(nextReleaseVersion("2.56.0", [breakingCommit]), "3.0.0");
});

test("holds a breaking commit to the minor line while below 1.0", () => {
  const breakingCommit = { breaking: true, sha: "different-commit", type: "fix" };

  assert.equal(nextReleaseVersion("0.56.0", [breakingCommit]), "0.57.0");
  assert.equal(nextReleaseVersion("0.0.9", [breakingCommit]), "0.1.0");
});

test("does not reach 1.0.0 from a breaking marker alone", () => {
  // 2026-09-14: #1770's `feat(api)!` subject generated a 1.0.0 release PR with
  // nobody having decided to ship 1.0. This pins that it cannot happen again.
  const breakingCommit = {
    breaking: true,
    // biome-ignore lint/security/noSecrets: Public Git commit SHA, not a secret.
    sha: "cbc9486bfaa85fc1e2a3447289236148bddcfa87",
    type: "feat",
  };

  assert.equal(nextReleaseVersion("0.75.0", [breakingCommit]), "0.76.0");
});

test("keeps normal feature and patch bumps unchanged", () => {
  assert.equal(nextReleaseVersion("0.56.0", [featureCommit]), "0.57.0");
  assert.equal(nextReleaseVersion("0.56.0", [patchCommit]), "0.56.1");
});

test("rejects malformed current versions", () => {
  assert.throws(() => nextReleaseVersion("0.56", [patchCommit]), /Invalid semver version/);
});
