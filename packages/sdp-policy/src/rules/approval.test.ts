import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { operation } from "../test-support";
import { evaluateApprovalRule } from "./approval";

describe("evaluateApprovalRule", () => {
  it("requires approval by default when the predicates match", () => {
    assert.partialDeepStrictEqual(
      evaluateApprovalRule({ kind: "approval", families: ["payment"] }, operation),
      { decision: "approval_required", reason: "Approval policy matched operation." }
    );
  });

  it("matches unconditionally when it names no predicates", () => {
    assert.equal(
      evaluateApprovalRule({ kind: "approval" }, operation)?.decision,
      "approval_required"
    );
  });

  it("abstains when a predicate does not match", () => {
    assert.equal(
      evaluateApprovalRule({ kind: "approval", families: ["issuance"] }, operation),
      null
    );
    assert.equal(
      evaluateApprovalRule(
        { kind: "approval", operationTypes: ["issuance_mint_execute"] },
        operation
      ),
      null
    );
    assert.equal(evaluateApprovalRule({ kind: "approval", assets: ["SOL"] }, operation), null);
  });

  it("applies a pinned action verbatim", () => {
    const evaluation = evaluateApprovalRule(
      { kind: "approval", families: ["payment"], action: "provider_approval_required" },
      operation
    );
    assert.equal(evaluation?.decision, "provider_approval_required");
  });
});
