import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { operation } from "../test-support";
import { evaluateAssetRule } from "./asset";

describe("evaluateAssetRule", () => {
  it("reviews a rule with no assets", () => {
    assert.partialDeepStrictEqual(evaluateAssetRule({ kind: "asset" }, operation), {
      decision: "review",
      reason: "Asset rule has no assets.",
    });
  });

  it("abstains when the operation asset is not named", () => {
    assert.equal(evaluateAssetRule({ kind: "asset", assets: ["SOL"] }, operation), null);
  });

  it("abstains when the operation carries no asset", () => {
    assert.equal(
      evaluateAssetRule({ kind: "asset", assets: ["USDC"] }, { ...operation, asset: null }),
      null
    );
  });

  it("applies a pinned action on match", () => {
    const evaluation = evaluateAssetRule(
      { kind: "asset", asset: "USDC", action: "deny" },
      operation
    );
    assert.equal(evaluation?.decision, "deny");
  });
});
