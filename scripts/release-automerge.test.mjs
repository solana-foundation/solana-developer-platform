import assert from "node:assert/strict";
import test from "node:test";
import { autoMergeNeedsRearm } from "../.github/scripts/release-automerge.mjs";

const desired = "chore(main): release 0.68.0";

test("re-arms when the frozen headline names an earlier version", () => {
  // The 0.68.0 release: armed while the pull request was still 0.67.2, merged
  // as 0.67.2, and `publish` refused it against package.json 0.68.0.
  assert.equal(autoMergeNeedsRearm("chore(main): release 0.67.2", desired), true);
  // The same shape one release earlier, armed as 0.66.1 and merged as 0.66.1.
  assert.equal(autoMergeNeedsRearm("chore(main): release 0.66.1", desired), true);
});

test("leaves a headline that already matches alone", () => {
  assert.equal(autoMergeNeedsRearm(desired, desired), false);
});

test("does not re-arm when auto-merge is not armed at all", () => {
  for (const armed of [null, undefined, ""]) {
    assert.equal(autoMergeNeedsRearm(armed, desired), false);
  }
});

test("refuses to evaluate drift without a target headline", () => {
  assert.throws(() => autoMergeNeedsRearm("chore(main): release 0.67.2", ""), /desiredHeadline/);
});
