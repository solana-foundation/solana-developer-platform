import assert from "node:assert/strict";
import test from "node:test";
import { buildSectionMarkdown } from "../.github/scripts/release-changelog.mjs";

const REPO = "solana-foundation/solana-developer-platform";

function commit(overrides) {
  return {
    sha: "a".repeat(40),
    type: "feat",
    description: "plain feature",
    prNumber: null,
    breaking: false,
    ...overrides,
  };
}

test("surfaces a breaking commit in a dedicated section AND its type section", () => {
  const markdown = buildSectionMarkdown(REPO, "0.78.0", "v0.77.0", [
    commit({
      sha: "b".repeat(40),
      description: "**api:** remove the legacy field",
      prNumber: "1234",
      breaking: true,
    }),
    commit({ sha: "c".repeat(40), type: "fix", description: "small fix" }),
  ]);

  const breakingSection = markdown.split("### Features")[0];
  assert.match(breakingSection, /### ⚠ BREAKING CHANGES/);
  assert.match(breakingSection, /remove the legacy field.*#1234/);
  assert.match(markdown, /### Features\n\n\* \*\*api:\*\* remove the legacy field/);
  assert.match(markdown, /### Bug Fixes\n\n\* small fix/);
});

test("omits the breaking section when no commit is breaking", () => {
  const markdown = buildSectionMarkdown(REPO, "0.78.0", "v0.77.0", [
    commit({ description: "plain feature" }),
  ]);

  assert.doesNotMatch(markdown, /BREAKING/);
});

test("honors the non-breaking override set the version bump honors", () => {
  const markdown = buildSectionMarkdown(REPO, "0.78.0", "v0.77.0", [
    commit({
      // biome-ignore lint/security/noSecrets: Public Git commit SHA, not a secret.
      sha: "c3485d8c035d57cbd58c4058e2f4203369441459",
      description: "retained an inaccurate footer",
      breaking: true,
    }),
  ]);

  assert.doesNotMatch(markdown, /BREAKING/);
  assert.match(markdown, /### Features\n\n\* retained an inaccurate footer/);
});

test("renders a revert under Reverts and drops the commit it undoes", () => {
  // 0.79.0 shipped this shape: a provider added and reverted in the same range.
  // The notes announced it under Features and repeated it under Other Changes
  // using the reverted commit's own title, so nothing said it had been pulled.
  const feature = "b".repeat(40);
  const markdown = buildSectionMarkdown(REPO, "0.79.0", "v0.78.0", [
    commit({
      sha: feature,
      type: "feat",
      description: "**ramps:** add a provider",
      prNumber: "1501",
    }),
    commit({
      sha: "c".repeat(40),
      type: "revert",
      description: '"feat(ramps): add a provider (#1501)"',
      body: `This reverts ${feature.slice(0, 9)}.`,
      prNumber: "1901",
    }),
  ]);

  assert.match(markdown, /### Reverts/);
  assert.match(markdown, /"feat\(ramps\): add a provider \(#1501\)"/);
  assert.doesNotMatch(markdown, /### Features/);
  assert.doesNotMatch(markdown, /\*\*ramps:\*\* add a provider/);
});

test("accepts the full git revert footer as well as an abbreviated sha", () => {
  const feature = "d".repeat(40);
  const markdown = buildSectionMarkdown(REPO, "0.79.0", "v0.78.0", [
    commit({ sha: feature, type: "feat", description: "shipped then pulled" }),
    commit({
      sha: "e".repeat(40),
      type: "revert",
      description: '"feat: shipped then pulled"',
      body: `This reverts commit ${feature}.\n\nBecause it broke.`,
    }),
  ]);

  assert.doesNotMatch(markdown, /shipped then pulled\b(?!")/);
  assert.match(markdown, /### Reverts/);
});

test("a revert of something outside this release leaves the range untouched", () => {
  const markdown = buildSectionMarkdown(REPO, "0.79.0", "v0.78.0", [
    commit({ sha: "f".repeat(40), type: "feat", description: "unrelated feature" }),
    commit({
      sha: "1".repeat(40),
      type: "revert",
      description: '"feat: something from an older release"',
      body: "This reverts commit 9999999999999999999999999999999999999999.",
    }),
  ]);

  assert.match(markdown, /### Features/);
  assert.match(markdown, /unrelated feature/);
  assert.match(markdown, /### Reverts/);
});

test("a breaking commit that is reverted in the same release is not announced as breaking", () => {
  const breaking = "2".repeat(40);
  const markdown = buildSectionMarkdown(REPO, "0.79.0", "v0.78.0", [
    commit({ sha: breaking, type: "feat", description: "breaking thing", breaking: true }),
    commit({
      sha: "3".repeat(40),
      type: "revert",
      description: '"feat!: breaking thing"',
      body: `This reverts commit ${breaking}.`,
    }),
  ]);

  assert.doesNotMatch(markdown, /BREAKING CHANGES/);
});

test("a revert that is itself reverted restores the change to the notes", () => {
  // Greptile on #1906: with flat suppression the original stayed hidden and both
  // reversions were listed, so the notes omitted a change the release contains.
  const feature = "7".repeat(40);
  const firstRevert = "8".repeat(40);
  const markdown = buildSectionMarkdown(REPO, "0.79.0", "v0.78.0", [
    commit({ sha: feature, type: "feat", description: "**ramps:** add a provider" }),
    commit({
      sha: firstRevert,
      type: "revert",
      description: '"feat(ramps): add a provider"',
      body: `This reverts commit ${feature}.`,
    }),
    commit({
      sha: "9".repeat(40),
      type: "revert",
      description: '"revert: feat(ramps): add a provider"',
      body: `This reverts commit ${firstRevert}.`,
    }),
  ]);

  // The provider is in the released code, so it must be announced.
  assert.match(markdown, /### Features/);
  assert.match(markdown, /\*\*ramps:\*\* add a provider/);
  // The revert that was itself undone is not news and must not be listed.
  assert.doesNotMatch(markdown, /"feat\(ramps\): add a provider"/);
});
