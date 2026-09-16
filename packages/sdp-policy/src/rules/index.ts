import type { PolicyCandidate, PolicyRule } from "@sdp/types";
import { evaluateAlwaysRule } from "./always";
import { evaluateAmountRule } from "./amount";
import { evaluateApprovalRule } from "./approval";
import { evaluateAssetRule } from "./asset";
import { evaluateDestinationRule } from "./destination";
import type { PolicyRuleEvaluationContext, RuleEvaluation } from "./helpers";
import { evaluateOperationFamilyRule } from "./operation-family";
import { evaluateOperationTypeRule } from "./operation-type";
import { evaluateVelocityRule } from "./velocity";

export type { PolicyRuleEvaluationContext, RuleEvaluation } from "./helpers";

/**
 * Evaluate a single policy rule against an operation.
 *
 * @param rule - The rule to evaluate.
 * @param operation - The operation under evaluation.
 * @param context - Side inputs some kinds need (the velocity lookup).
 * @returns The rule's evaluation, or null when the rule does not apply.
 */
export function evaluatePolicyRule(
  rule: PolicyRule,
  operation: PolicyCandidate,
  context: PolicyRuleEvaluationContext = {}
): RuleEvaluation | null {
  switch (rule.kind) {
    case "always":
      return evaluateAlwaysRule(rule);
    case "operation_family":
      return evaluateOperationFamilyRule(rule, operation);
    case "operation_type":
      return evaluateOperationTypeRule(rule, operation);
    case "asset":
      return evaluateAssetRule(rule, operation);
    case "destination":
      return evaluateDestinationRule(rule, operation);
    case "amount":
      return evaluateAmountRule(rule, operation);
    case "velocity":
      return evaluateVelocityRule(rule, operation, context);
    case "approval":
      return evaluateApprovalRule(rule, operation);
    default: {
      const exhaustive: never = rule;
      throw new Error(`Unhandled policy rule kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
