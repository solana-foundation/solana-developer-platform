import type {
  EffectiveApiKeyPolicy,
  EffectivePolicy,
  EffectiveWalletPolicy,
  MatchedPolicyRule,
  PolicyEvaluationContext,
  PolicyEvaluationReasonCode,
  PolicyRuleScope,
  PolicyScopeEvaluation,
  WalletOperationEnvelope,
  WalletOperationPolicyEvaluation,
} from "@sdp/types";
import { DECISION_RANK, isApprovalDecision } from "./decisions";
import { evaluatePolicyRule, type RuleEvaluation } from "./rules";

/** The effective policy applied when no profile is active for a scope. */
export const IMPLICIT_DEFAULT_ALLOW_POLICY: EffectivePolicy<never, never> = {
  source: "implicit_default_allow",
  profile: null,
  revision: null,
  defaultAction: "allow",
};

export interface EvaluateWalletOperationPoliciesInput {
  operation: WalletOperationEnvelope;
  walletPolicy: EffectiveWalletPolicy;
  apiKeyPolicy: EffectiveApiKeyPolicy | null;
}

/**
 * Evaluate an operation against its effective wallet and API-key policies and
 * combine the scope decisions, strictest wins.
 *
 * @param input - The operation plus the effective policy for each scope.
 * @returns The combined evaluation with per-scope detail and matched rules.
 */
export function evaluateWalletOperationPolicies(
  input: EvaluateWalletOperationPoliciesInput
): WalletOperationPolicyEvaluation {
  const wallet = evaluatePolicyScope({
    scope: "wallet",
    policy: input.walletPolicy,
    operation: input.operation,
  });
  const apiKey = resolveApiKeyScopeEvaluation(input);
  const scopes = apiKey === null ? [wallet] : [wallet, apiKey];
  const selected = scopes.reduce((strictest, scope) =>
    DECISION_RANK[scope.decision] > DECISION_RANK[strictest.decision] ? scope : strictest
  );
  const allScopesUseImplicitAllow = scopes.every(
    (scope) => scope.source === "implicit_default_allow" && scope.decision === "allow"
  );

  return {
    operation: input.operation,
    wallet,
    apiKey,
    decision: selected.decision,
    reasonCode: allScopesUseImplicitAllow ? "implicit_default_allow" : selected.reasonCode,
    reason: summarizeScopeDecisions(scopes, selected),
    matchedRules: scopes.flatMap((scope) => scope.matchedRules),
    evaluationContext: createPolicyEvaluationContext(input.operation, wallet, apiKey),
    requiresApproval: isApprovalDecision(selected.decision),
    walletPolicyRevisionId: wallet.revisionId,
    apiKeyPolicyRevisionId: apiKey === null ? null : apiKey.revisionId,
  };
}

/**
 * Evaluate the API-key scope when the caller supplies an effective API-key
 * policy, or when the operation was made with an API key (implicit allow).
 *
 * @param input - The evaluation input.
 * @returns The API-key scope evaluation, or null when no API key is involved.
 */
function resolveApiKeyScopeEvaluation(
  input: EvaluateWalletOperationPoliciesInput
): PolicyScopeEvaluation | null {
  if (input.apiKeyPolicy !== null) {
    return evaluatePolicyScope({
      scope: "api_key",
      policy: input.apiKeyPolicy,
      operation: input.operation,
    });
  }
  if (input.operation.apiKeyId !== null) {
    return evaluatePolicyScope({
      scope: "api_key",
      policy: IMPLICIT_DEFAULT_ALLOW_POLICY,
      operation: input.operation,
    });
  }
  return null;
}

/**
 * Evaluate one scope's effective policy: run every rule, pick the strictest
 * match, and fall back to the revision's default action when nothing matched.
 *
 * @param input - The scope, its effective policy, and the operation.
 * @returns The scope's evaluation.
 */
function evaluatePolicyScope(input: {
  scope: PolicyRuleScope;
  policy: EffectiveWalletPolicy | EffectiveApiKeyPolicy;
  operation: WalletOperationEnvelope;
}): PolicyScopeEvaluation {
  const revision = input.policy.revision;

  if (revision === null) {
    return {
      scope: input.scope,
      source: "implicit_default_allow",
      profileId: null,
      revisionId: null,
      defaultAction: input.policy.defaultAction,
      decision: "allow",
      reasonCode: missingPolicyReasonCode(input.scope),
      reason: `${scopeLabel(input.scope)} policy is not active; implicit default allow applies.`,
      matchedRules: [],
      requiresApproval: false,
    };
  }

  const profileId = input.policy.profile === null ? null : input.policy.profile.id;
  const ruleEvaluations = revision.rules.flatMap((rule) => {
    const evaluation = evaluatePolicyRule(rule, input.operation);
    return evaluation === null ? [] : [evaluation];
  });
  const selectedRule = selectStrictestRule(ruleEvaluations);

  if (selectedRule !== null) {
    return {
      scope: input.scope,
      source: input.policy.source,
      profileId,
      revisionId: revision.id,
      defaultAction: input.policy.defaultAction,
      decision: selectedRule.decision,
      reasonCode: matchedPolicyReasonCode(input.scope),
      reason: selectedRule.reason,
      matchedRules: ruleEvaluations.map((evaluation) => toMatchedRule(input.scope, evaluation)),
      requiresApproval: isApprovalDecision(selectedRule.decision),
    };
  }

  return {
    scope: input.scope,
    source: input.policy.source,
    profileId,
    revisionId: revision.id,
    defaultAction: input.policy.defaultAction,
    decision: input.policy.defaultAction,
    reasonCode: matchedPolicyReasonCode(input.scope),
    reason: `No ${scopeLabel(input.scope)} policy rules matched; default action ${input.policy.defaultAction} applies.`,
    matchedRules: [],
    requiresApproval: isApprovalDecision(input.policy.defaultAction),
  };
}

/**
 * Pick the strictest rule evaluation.
 *
 * @param evaluations - The matched-rule evaluations.
 * @returns The strictest one, or null when no rule matched.
 */
function selectStrictestRule(evaluations: RuleEvaluation[]): RuleEvaluation | null {
  let selected: RuleEvaluation | null = null;
  for (const evaluation of evaluations) {
    if (
      selected === null ||
      DECISION_RANK[evaluation.decision] > DECISION_RANK[selected.decision]
    ) {
      selected = evaluation;
    }
  }
  return selected;
}

function toMatchedRule(scope: PolicyRuleScope, evaluation: RuleEvaluation): MatchedPolicyRule {
  return {
    scope,
    ruleId: evaluation.rule.id === undefined ? null : evaluation.rule.id,
    kind: evaluation.rule.kind,
    decision: evaluation.decision,
    reason: evaluation.reason,
    rule: evaluation.rule,
  };
}

function summarizeScopeDecisions(
  scopes: PolicyScopeEvaluation[],
  selected: PolicyScopeEvaluation
): string {
  if (scopes.every((scope) => scope.source === "implicit_default_allow")) {
    return "No active wallet or API key policy exists; implicit default allow applies.";
  }

  const decisions = scopes
    .map((scope) => `${scopeLabel(scope.scope)}=${scope.decision}`)
    .join(", ");
  return `${selected.reason} Combined policy decision: ${decisions}.`;
}

function createPolicyEvaluationContext(
  operation: WalletOperationEnvelope,
  wallet: PolicyScopeEvaluation,
  apiKey: PolicyScopeEvaluation | null
): PolicyEvaluationContext {
  const { status, updatedAt, ...snapshot } = operation;
  return {
    operation: snapshot,
    walletPolicy: createPolicyContext(wallet),
    apiKeyPolicy: apiKey === null ? null : createPolicyContext(apiKey),
  };
}

function createPolicyContext(scope: PolicyScopeEvaluation) {
  return {
    source: scope.source,
    profileId: scope.profileId,
    revisionId: scope.revisionId,
    defaultAction: scope.defaultAction,
    decision: scope.decision,
    requiresApproval: scope.requiresApproval,
  };
}

function missingPolicyReasonCode(scope: PolicyRuleScope): PolicyEvaluationReasonCode {
  return scope === "wallet" ? "wallet_policy_missing" : "api_key_policy_missing";
}

function matchedPolicyReasonCode(scope: PolicyRuleScope): PolicyEvaluationReasonCode {
  return scope === "wallet" ? "wallet_policy_match" : "api_key_policy_match";
}

function scopeLabel(scope: PolicyRuleScope): string {
  return scope === "wallet" ? "wallet" : "API key";
}
