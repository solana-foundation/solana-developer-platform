import type { OperationTypePolicyRule, WalletOperationEnvelope } from "@sdp/types";
import { type RuleEvaluation, ruleValues } from "./helpers";

/**
 * Evaluate an `operation_type` rule against an operation.
 *
 * @param rule - The rule to evaluate.
 * @param operation - The operation under evaluation.
 * @returns The rule's decision, or null when its types do not include the operation's.
 */
export function evaluateOperationTypeRule(
  rule: OperationTypePolicyRule,
  operation: WalletOperationEnvelope
): RuleEvaluation | null {
  const operationTypes = ruleValues(rule.operationType, rule.operationTypes);

  if (operationTypes.length === 0) {
    return { rule, decision: "review", reason: "Operation type rule has no operation types." };
  }

  if (!operationTypes.includes(operation.operationType)) {
    return null;
  }

  return {
    rule,
    decision: rule.action === undefined ? "allow" : rule.action,
    reason: `Operation type ${operation.operationType} matched policy.`,
  };
}
