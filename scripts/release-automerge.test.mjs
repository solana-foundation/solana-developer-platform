import assert from "node:assert/strict";
import test from "node:test";
import {
  autoMergeNeedsRearm,
  reconcileReleaseAutoMerge,
} from "../.github/scripts/release-automerge.mjs";

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

function recorder(armedHeadline) {
  const calls = [];
  return {
    calls,
    deps: {
      desiredHeadline: desired,
      readArmedHeadline: async () => {
        calls.push("read");
        return armedHeadline;
      },
      arm: async () => {
        calls.push("arm");
      },
      disarm: async () => {
        calls.push("disarm");
      },
      log: (message) => {
        calls.push(`log:${message}`);
      },
    },
  };
}

test("arms an unarmed pull request without disarming anything", async () => {
  for (const armed of [null, undefined, ""]) {
    const { calls, deps } = recorder(armed);
    assert.equal(await reconcileReleaseAutoMerge(deps), "armed");
    assert.deepEqual(calls, ["read", "arm"]);
  }
});

test("leaves a pull request armed with the right headline untouched", async () => {
  const { calls, deps } = recorder(desired);
  assert.equal(await reconcileReleaseAutoMerge(deps), "unchanged");
  assert.deepEqual(calls, ["read"]);
});

test("disarms before re-arming when the frozen headline is stale", async () => {
  // #1650: armed as 0.72.1, renamed to 0.73.0, merged as 0.72.1 because a
  // repeat enable returned success and kept the frozen headline. #1658 sat the
  // same way as 0.73.1 under a 0.74.0 title.
  const { calls, deps } = recorder("chore(main): release 0.67.2");
  assert.equal(await reconcileReleaseAutoMerge(deps), "rearmed");
  assert.deepEqual(calls, [
    "read",
    'log:Re-arming auto-merge: headline was "chore(main): release 0.67.2", expected "chore(main): release 0.68.0"',
    "disarm",
    "arm",
  ]);
});

test("does not arm when disarming fails", async () => {
  const { calls, deps } = recorder("chore(main): release 0.67.2");
  deps.disarm = async () => {
    calls.push("disarm");
    throw new Error("disable failed");
  };
  await assert.rejects(reconcileReleaseAutoMerge(deps), /disable failed/);
  assert.equal(calls.includes("arm"), false);
});

test("refuses to reconcile without a target headline", async () => {
  const { deps } = recorder(null);
  deps.desiredHeadline = "";
  await assert.rejects(reconcileReleaseAutoMerge(deps), /desiredHeadline/);
});
