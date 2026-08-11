import { compareDecimalAmounts, isDecimalString } from "@sdp/solana/amount";
import type { AmountPolicyRule, PolicyCandidate } from "@sdp/types";
import { type RuleEvaluation, ruleValues } from "./helpers";

/**
 * Evaluate an `amount` rule against an operation. Denies outside the [min, max]
 * bounds; reviews when the bounds or the operation amount are not valid decimals.
 *
 * @param rule - The rule to evaluate.
 * @param operation - The operation under evaluation.
 * @returns The rule's decision, or null when it does not apply to the operation.
 */
export function evaluateAmountRule(
  rule: AmountPolicyRule,
  operation: PolicyCandidate
): RuleEvaluation | null {
  const assets = ruleValues(rule.asset, rule.assets);

  if (assets.length > 0 && (operation.asset === null || !assets.includes(operation.asset))) {
    return null;
  }

  if (operation.amount === null) {
    return null;
  }

  if (!isDecimalString(operation.amount)) {
    return {
      rule,
      decision: "review",
      reason: "Operation amount is invalid for amount policy evaluation.",
    };
  }

  if (rule.min === undefined && rule.max === undefined) {
    return { rule, decision: "review", reason: "Amount rule has no min or max." };
  }
  if (
    (rule.min !== undefined && !isDecimalString(rule.min)) ||
    (rule.max !== undefined && !isDecimalString(rule.max))
  ) {
    return { rule, decision: "review", reason: "Amount rule has an invalid decimal bound." };
  }
  if (rule.min !== undefined && compareDecimalAmounts(operation.amount, rule.min) < 0) {
    return {
      rule,
      decision: "deny",
      reason: `Operation amount ${operation.amount} is below policy minimum ${rule.min}.`,
    };
  }
  if (rule.max !== undefined && compareDecimalAmounts(operation.amount, rule.max) > 0) {
    return {
      rule,
      decision: "deny",
      reason: `Operation amount ${operation.amount} exceeds policy maximum ${rule.max}.`,
    };
  }

  return {
    rule,
    decision: rule.action === undefined ? "allow" : rule.action,
    reason: `Operation amount ${operation.amount} matched policy.`,
  };
}
