import type { AlwaysPolicyRule } from "@sdp/types";
import type { RuleEvaluation } from "./helpers";

/**
 * Evaluate an `always` rule, which matches every operation unconditionally.
 *
 * @param rule - The rule to evaluate.
 * @returns The rule's decision, defaulting to `allow`.
 */
export function evaluateAlwaysRule(rule: AlwaysPolicyRule): RuleEvaluation {
  return {
    rule,
    decision: rule.action === undefined ? "allow" : rule.action,
    reason: "Always rule matched.",
  };
}
