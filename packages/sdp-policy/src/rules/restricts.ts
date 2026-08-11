import type { PolicyRule } from "@sdp/types";
import { ruleValues } from "./helpers";

/**
 * Whether a rule can produce anything other than `allow`.
 *
 * An explicit `action` is authoritative for every kind; without one, each kind
 * falls to its evaluator default. A rule with no criteria is not inert: every
 * evaluator resolves a vacuous rule to `review`, which restricts.
 *
 * @param rule - The rule to classify.
 * @returns True when the rule can deny, review, or require approval.
 */
export function policyRuleRestricts(rule: PolicyRule): boolean {
  if (rule.action !== undefined) {
    return rule.action !== "allow";
  }

  switch (rule.kind) {
    case "approval":
      return true;
    case "amount":
      return true;
    case "destination":
      return true;
    case "asset":
      return ruleValues(rule.asset, rule.assets).length === 0;
    case "operation_family":
      return ruleValues(rule.family, rule.families).length === 0;
    case "operation_type":
      return ruleValues(rule.operationType, rule.operationTypes).length === 0;
    case "always":
      return false;
    default: {
      const exhaustive: never = rule;
      throw new Error(`Unhandled policy rule kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
