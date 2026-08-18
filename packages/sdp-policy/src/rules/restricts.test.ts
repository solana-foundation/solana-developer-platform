import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PolicyRule } from "@sdp/types";
import { operation } from "../test-support";
import { evaluatePolicyRule } from "./index";
import { policyRuleRestricts } from "./restricts";

describe("policyRuleRestricts", () => {
  it("treats an explicit action as authoritative for every kind", () => {
    assert.equal(policyRuleRestricts({ kind: "approval", action: "allow" }), false);
    assert.equal(policyRuleRestricts({ kind: "always", action: "review" }), true);
    assert.equal(
      policyRuleRestricts({ kind: "asset", asset: "USDC", action: "provider_approval_required" }),
      true
    );
  });

  it("classifies default-action kinds by their evaluator defaults", () => {
    assert.equal(policyRuleRestricts({ kind: "approval" }), true);
    assert.equal(policyRuleRestricts({ kind: "amount", max: "100" }), true);
    assert.equal(policyRuleRestricts({ kind: "destination", allowlist: ["x"] }), true);
    assert.equal(policyRuleRestricts({ kind: "always" }), false);
    assert.equal(policyRuleRestricts({ kind: "asset", asset: "USDC" }), false);
    assert.equal(policyRuleRestricts({ kind: "operation_family", families: ["payment"] }), false);
    assert.equal(
      policyRuleRestricts({
        kind: "operation_type",
        operationTypes: ["payment_transfer_execute"],
      }),
      false
    );
  });

  it("treats vacuous rules as restrictive because they evaluate to review", () => {
    const vacuousRules: PolicyRule[] = [
      { kind: "asset" },
      { kind: "operation_family" },
      { kind: "operation_type" },
    ];
    for (const rule of vacuousRules) {
      assert.equal(policyRuleRestricts(rule), true);
      assert.equal(evaluatePolicyRule(rule, operation)?.decision, "review");
    }
  });
});
