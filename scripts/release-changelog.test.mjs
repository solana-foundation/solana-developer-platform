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
