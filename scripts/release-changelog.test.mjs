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

// Release notes describe the net difference between the two tags, not the path
// taken to get there. A revert and the in-range commit it undoes cancel out; a
// revert of an earlier release is a real removal and stands.

test("net difference: a change added and not reverted is announced", () => {
  const markdown = buildSectionMarkdown(REPO, "0.79.0", "v0.78.0", [
    commit({ sha: "a1".padEnd(40, "0"), type: "feat", description: "**ramps:** add a provider" }),
  ]);
  assert.match(markdown, /### Features/);
  assert.match(markdown, /\*\*ramps:\*\* add a provider/);
});

test("net difference: a change added and reverted in the same release says nothing", () => {
  // 0.79.0 with Hercle. Neither tag contains it, so the notes have nothing to
  // report. Previously it was announced under Features and repeated under the
  // reverted commit's own title, so nothing said it had been pulled.
  const feature = "b1".padEnd(40, "0");
  const markdown = buildSectionMarkdown(REPO, "0.79.0", "v0.78.0", [
    commit({
      sha: feature,
      type: "feat",
      description: "**ramps:** add a provider",
      prNumber: "1501",
    }),
    commit({
      sha: "b2".padEnd(40, "0"),
      type: "revert",
      description: '"feat(ramps): add a provider (#1501)"',
      body: `This reverts commit ${feature}.`,
      prNumber: "1901",
    }),
  ]);
  assert.doesNotMatch(markdown, /provider/);
  assert.doesNotMatch(markdown, /### Features/);
  assert.doesNotMatch(markdown, /### Reverts/);
});

test("net difference: reverting an earlier release is a removal and is listed", () => {
  const markdown = buildSectionMarkdown(REPO, "0.79.0", "v0.78.0", [
    commit({
      sha: "c1".padEnd(40, "0"),
      type: "revert",
      description: '"feat: something users already had"',
      body: "This reverts commit 9999999999999999999999999999999999999999.",
    }),
  ]);
  assert.match(markdown, /### Reverts/);
  assert.match(markdown, /something users already had/);
});

test("net difference: a revert that is itself reverted restores the change", () => {
  const feature = "d1".padEnd(40, "0");
  const firstRevert = "d2".padEnd(40, "0");
  const markdown = buildSectionMarkdown(REPO, "0.79.0", "v0.78.0", [
    commit({ sha: feature, type: "feat", description: "**ramps:** add a provider" }),
    commit({
      sha: firstRevert,
      type: "revert",
      description: '"feat(ramps): add a provider"',
      body: `This reverts commit ${feature}.`,
    }),
    commit({
      sha: "d3".padEnd(40, "0"),
      type: "revert",
      description: '"revert: feat(ramps): add a provider"',
      body: `This reverts commit ${firstRevert}.`,
    }),
  ]);
  assert.match(markdown, /### Features/);
  assert.match(markdown, /\*\*ramps:\*\* add a provider/);
  assert.doesNotMatch(markdown, /### Reverts/);
});

test("net difference: an even deeper chain nets back to removed", () => {
  const feature = "e1".padEnd(40, "0");
  const r1 = "e2".padEnd(40, "0");
  const r2 = "e3".padEnd(40, "0");
  const markdown = buildSectionMarkdown(REPO, "0.79.0", "v0.78.0", [
    commit({ sha: feature, type: "feat", description: "add a provider" }),
    commit({
      sha: r1,
      type: "revert",
      description: '"feat: add a provider"',
      body: `This reverts commit ${feature}.`,
    }),
    commit({
      sha: r2,
      type: "revert",
      description: '"revert 1"',
      body: `This reverts commit ${r1}.`,
    }),
    commit({
      sha: "e4".padEnd(40, "0"),
      type: "revert",
      description: '"revert 2"',
      body: `This reverts commit ${r2}.`,
    }),
  ]);
  assert.doesNotMatch(markdown, /add a provider/);
});

test("net difference: an abbreviated revert footer resolves the same way", () => {
  const feature = "f1".padEnd(40, "0");
  const markdown = buildSectionMarkdown(REPO, "0.79.0", "v0.78.0", [
    commit({ sha: feature, type: "feat", description: "add a provider" }),
    commit({
      sha: "f2".padEnd(40, "0"),
      type: "revert",
      description: '"feat: add a provider"',
      body: `This reverts ${feature.slice(0, 9)}.`,
    }),
  ]);
  assert.doesNotMatch(markdown, /add a provider/);
});

test("net difference: a breaking change reverted in the same release is not announced as breaking", () => {
  const breaking = "a2".padEnd(40, "0");
  const markdown = buildSectionMarkdown(REPO, "0.79.0", "v0.78.0", [
    commit({ sha: breaking, type: "feat", description: "breaking thing", breaking: true }),
    commit({
      sha: "a3".padEnd(40, "0"),
      type: "revert",
      description: '"feat!: breaking thing"',
      body: `This reverts commit ${breaking}.`,
    }),
  ]);
  assert.doesNotMatch(markdown, /BREAKING CHANGES/);
  assert.doesNotMatch(markdown, /breaking thing/);
});
