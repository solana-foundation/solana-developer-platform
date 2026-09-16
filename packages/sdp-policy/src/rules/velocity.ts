import { addDecimalAmounts, compareDecimalAmounts, isDecimalString } from "@sdp/solana/amount";
import type { PolicyCandidate, VelocityPolicyRule } from "@sdp/types";
import { isIsoDuration } from "../duration";
import { velocityObservationKeys } from "../velocity";
import { type PolicyRuleEvaluationContext, type RuleEvaluation, ruleValues } from "./helpers";

/**
 * Evaluate a `velocity` rule against an operation: does the rolling total of
 * this scope's prior operations in the window, plus this operation, exceed
 * `max` for the operation's asset?
 *
 * One deliberate difference from `amount`: for `velocity`, `action` is the
 * decision ON BREACH (default `deny`), and within the limit the rule ABSTAINS
 * (returns null) instead of emitting `allow`. ADR 0004 layer 2 depends on
 * that: a breached tier default must produce `approval_required`, and an
 * unbreached one must let the org's other rules and the default action decide.
 *
 * The rolling total is not computed here. The store measures it before
 * evaluation and hands it over through {@link PolicyRuleEvaluationContext};
 * a rule whose observation is missing reviews, so an absent or incomplete
 * port implementation fails closed instead of silently allowing.
 *
 * Like `amount`, a rule naming no asset is vacuous and reviews, as does one
 * whose window or max cannot be parsed.
 *
 * @param rule - The rule to evaluate.
 * @param operation - The operation under evaluation.
 * @param context - The evaluation context carrying the velocity lookup.
 * @returns The rule's decision, or null when it does not apply or the window is within its limit.
 */
export function evaluateVelocityRule(
  rule: VelocityPolicyRule,
  operation: PolicyCandidate,
  context: PolicyRuleEvaluationContext = {}
): RuleEvaluation | null {
  const assets = ruleValues(rule.asset, rule.assets);

  if (assets.length === 0) {
    return { rule, decision: "review", reason: "Velocity rule has no assets." };
  }
  if (typeof rule.window !== "string" || !isIsoDuration(rule.window)) {
    return { rule, decision: "review", reason: "Velocity rule has an invalid window." };
  }
  if (typeof rule.max !== "string" || !isDecimalString(rule.max)) {
    return { rule, decision: "review", reason: "Velocity rule has an invalid max." };
  }

  if (operation.asset === null || !assets.includes(operation.asset)) {
    return null;
  }
  if (operation.amount === null) {
    return null;
  }
  if (!isDecimalString(operation.amount)) {
    return {
      rule,
      decision: "review",
      reason: "Operation amount is invalid for velocity policy evaluation.",
    };
  }
  if (
    rule.operationTypes !== undefined &&
    rule.operationTypes.length > 0 &&
    !rule.operationTypes.includes(operation.operationType)
  ) {
    return null;
  }

  const key = velocityObservationKeys(rule).find((entry) => entry.asset === operation.asset);
  const observation =
    key === undefined || context.velocity === undefined ? null : context.velocity.lookup(key);
  if (observation === null) {
    return { rule, decision: "review", reason: "Velocity window unavailable." };
  }
  if (!isDecimalString(observation.total)) {
    return { rule, decision: "review", reason: "Velocity window total is invalid." };
  }

  const projected = addDecimalAmounts(observation.total, operation.amount);
  if (compareDecimalAmounts(projected, rule.max) > 0) {
    return {
      rule,
      decision: rule.action === undefined ? "deny" : rule.action,
      reason: `Window total ${observation.total} plus operation amount ${operation.amount} exceeds policy velocity maximum ${rule.max} over ${rule.window}.`,
    };
  }

  return null;
}
