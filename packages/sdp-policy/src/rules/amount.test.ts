import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { operation } from "../test-support";
import { evaluateAmountRule } from "./amount";

describe("evaluateAmountRule", () => {
  it("abstains when the rule's assets do not include the operation's", () => {
    assert.equal(evaluateAmountRule({ kind: "amount", asset: "SOL", max: "100" }, operation), null);
  });

  it("abstains when the operation carries no amount", () => {
    assert.equal(
      evaluateAmountRule({ kind: "amount", max: "100" }, { ...operation, amount: null }),
      null
    );
  });

  it("reviews a rule with no bounds", () => {
    assert.partialDeepStrictEqual(evaluateAmountRule({ kind: "amount" }, operation), {
      decision: "review",
      reason: "Amount rule has no min or max.",
    });
  });

  it("reviews an empty-string bound instead of treating it as absent", () => {
    assert.partialDeepStrictEqual(evaluateAmountRule({ kind: "amount", min: "" }, operation), {
      decision: "review",
      reason: "Amount rule has an invalid decimal bound.",
    });
  });

  it("reviews an invalid operation amount", () => {
    assert.partialDeepStrictEqual(
      evaluateAmountRule({ kind: "amount", max: "100" }, { ...operation, amount: "not-a-decimal" }),
      { decision: "review", reason: "Operation amount is invalid for amount policy evaluation." }
    );
  });

  it("denies below the minimum and above the maximum", () => {
    const belowMin = evaluateAmountRule({ kind: "amount", min: "200" }, operation);
    const aboveMax = evaluateAmountRule({ kind: "amount", max: "100" }, operation);
    assert.equal(belowMin?.decision, "deny");
    assert.match(belowMin?.reason as string, /below policy minimum 200/);
    assert.equal(aboveMax?.decision, "deny");
    assert.match(aboveMax?.reason as string, /exceeds policy maximum 100/);
  });

  it("allows within bounds", () => {
    const evaluation = evaluateAmountRule({ kind: "amount", min: "100", max: "200" }, operation);
    assert.equal(evaluation?.decision, "allow");
  });
});
