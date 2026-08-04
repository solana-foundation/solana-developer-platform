import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { operation } from "../test-support";
import { evaluateOperationTypeRule } from "./operation-type";

describe("evaluateOperationTypeRule", () => {
  it("reviews a rule with no operation types", () => {
    assert.partialDeepStrictEqual(
      evaluateOperationTypeRule({ kind: "operation_type" }, operation),
      {
        decision: "review",
        reason: "Operation type rule has no operation types.",
      }
    );
  });

  it("abstains when the operation type is not named", () => {
    assert.equal(
      evaluateOperationTypeRule(
        { kind: "operation_type", operationTypes: ["token_transfer"] },
        operation
      ),
      null
    );
  });

  it("matches the operation type across singular and plural forms", () => {
    const evaluation = evaluateOperationTypeRule(
      { kind: "operation_type", operationType: "payment_request", action: "approval_required" },
      operation
    );
    assert.equal(evaluation?.decision, "approval_required");
  });
});
