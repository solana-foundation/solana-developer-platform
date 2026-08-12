import type { ApprovalPolicyRule, PolicyCandidate } from "@sdp/types";
import { type RuleEvaluation, ruleValues } from "./helpers";

/**
 * Evaluate an `approval` rule against an operation. Matches when the operation
 * falls within the rule's families, types, and assets (each optional).
 *
 * @param rule - The rule to evaluate.
 * @param operation - The operation under evaluation.
 * @returns The rule's decision (default `approval_required`), or null when it does not apply.
 */
export function evaluateApprovalRule(
  rule: ApprovalPolicyRule,
  operation: PolicyCandidate
): RuleEvaluation | null {
  const families = ruleValues(undefined, rule.families);
  const operationTypes = ruleValues(undefined, rule.operationTypes);
  const assets = ruleValues(undefined, rule.assets);

  if (families.length > 0 && !families.includes(operation.operationFamily)) {
    return null;
  }
  if (operationTypes.length > 0 && !operationTypes.includes(operation.operationType)) {
    return null;
  }
  if (assets.length > 0 && (operation.asset === null || !assets.includes(operation.asset))) {
    return null;
  }

  return {
    rule,
    decision: rule.action === undefined ? "approval_required" : rule.action,
    reason: "Approval policy matched operation.",
  };
}
