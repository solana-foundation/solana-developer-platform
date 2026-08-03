import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { operation } from "../test-support";
import { evaluateOperationFamilyRule } from "./operation-family";

describe("evaluateOperationFamilyRule", () => {
  it("reviews a rule with no families", () => {
    assert.partialDeepStrictEqual(
      evaluateOperationFamilyRule({ kind: "operation_family" }, operation),
      { decision: "review", reason: "Operation family rule has no families." }
    );
  });

  it("abstains when the operation family is not named", () => {
    assert.equal(
      evaluateOperationFamilyRule({ kind: "operation_family", families: ["issuance"] }, operation),
      null
    );
  });

  it("merges singular and plural family forms", () => {
    const evaluation = evaluateOperationFamilyRule(
      { kind: "operation_family", family: "payment", families: ["issuance"] },
      operation
    );
    assert.equal(evaluation?.decision, "allow");
  });

  it("applies a pinned action on match", () => {
    const evaluation = evaluateOperationFamilyRule(
      { kind: "operation_family", families: ["payment"], action: "deny" },
      operation
    );
    assert.equal(evaluation?.decision, "deny");
  });
});
