import type { OperationFamilyPolicyRule, WalletOperationEnvelope } from "@sdp/types";
import { type RuleEvaluation, ruleValues } from "./helpers";

/**
 * Evaluate an `operation_family` rule against an operation.
 *
 * @param rule - The rule to evaluate.
 * @param operation - The operation under evaluation.
 * @returns The rule's decision, or null when its families do not include the operation's.
 */
export function evaluateOperationFamilyRule(
  rule: OperationFamilyPolicyRule,
  operation: WalletOperationEnvelope
): RuleEvaluation | null {
  const families = ruleValues(rule.family, rule.families);

  if (families.length === 0) {
    return { rule, decision: "review", reason: "Operation family rule has no families." };
  }

  if (!families.includes(operation.operationFamily)) {
    return null;
  }

  return {
    rule,
    decision: rule.action === undefined ? "allow" : rule.action,
    reason: `Operation family ${operation.operationFamily} matched policy.`,
  };
}
