import type { AssetPolicyRule, WalletOperationEnvelope } from "@sdp/types";
import { type RuleEvaluation, ruleValues } from "./helpers";

/**
 * Evaluate an `asset` rule against an operation.
 *
 * @param rule - The rule to evaluate.
 * @param operation - The operation under evaluation.
 * @returns The rule's decision, or null when the operation's asset is not named.
 */
export function evaluateAssetRule(
  rule: AssetPolicyRule,
  operation: WalletOperationEnvelope
): RuleEvaluation | null {
  const assets = ruleValues(rule.asset, rule.assets);

  if (assets.length === 0) {
    return { rule, decision: "review", reason: "Asset rule has no assets." };
  }

  if (operation.asset === null || !assets.includes(operation.asset)) {
    return null;
  }

  return {
    rule,
    decision: rule.action === undefined ? "allow" : rule.action,
    reason: `Asset ${operation.asset} matched policy.`,
  };
}
