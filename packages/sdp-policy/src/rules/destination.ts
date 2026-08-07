import type { DestinationPolicyRule, WalletOperationEnvelope } from "@sdp/types";
import { type RuleEvaluation, ruleValues } from "./helpers";

/**
 * Evaluate a `destination` rule against an operation. A blocklist hit denies; an
 * allowlist denies anything not on it; an empty rule falls to review.
 *
 * @param rule - The rule to evaluate.
 * @param operation - The operation under evaluation.
 * @returns The rule's decision, or null when only a blocklist is set and the destination is absent from it.
 */
export function evaluateDestinationRule(
  rule: DestinationPolicyRule,
  operation: WalletOperationEnvelope
): RuleEvaluation | null {
  const blocklist = ruleValues(undefined, rule.blocklist);
  const allowlist = ruleValues(rule.destination, rule.destinations).concat(
    ruleValues(undefined, rule.allowlist)
  );

  if (blocklist.length === 0 && allowlist.length === 0) {
    return { rule, decision: "review", reason: "Destination rule has no allowlist or blocklist." };
  }

  if (operation.destination !== null && blocklist.includes(operation.destination)) {
    return {
      rule,
      decision: "deny",
      reason: `Destination ${operation.destination} is blocked by policy.`,
    };
  }

  if (allowlist.length > 0) {
    if (operation.destination === null || !allowlist.includes(operation.destination)) {
      return {
        rule,
        decision: "deny",
        reason:
          operation.destination === null
            ? "Operation has no destination for destination policy evaluation."
            : `Destination ${operation.destination} is not allowed by policy.`,
      };
    }

    return {
      rule,
      decision: rule.action === undefined ? "allow" : rule.action,
      reason: `Destination ${operation.destination} matched policy.`,
    };
  }

  return null;
}
