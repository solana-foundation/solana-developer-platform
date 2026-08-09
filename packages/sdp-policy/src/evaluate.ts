import type {
  CandidatePolicyEvaluation,
  EffectiveApiKeyPolicy,
  EffectivePolicy,
  EffectiveWalletPolicy,
  MatchedPolicyRule,
  PolicyCandidate,
  PolicyDryRunCriterion,
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

export interface EvaluateCandidatePoliciesInput {
  candidate: PolicyCandidate;
  walletPolicy: EffectiveWalletPolicy;
  apiKeyPolicy: EffectiveApiKeyPolicy | null;
}

export interface EvaluateWalletOperationPoliciesInput {
  operation: WalletOperationEnvelope;
  walletPolicy: EffectiveWalletPolicy;
  apiKeyPolicy: EffectiveApiKeyPolicy | null;
}

/**
 * Evaluate a candidate operation against its effective wallet and API-key
 * policies and combine the scope decisions, strictest wins. Pure and
 * persistence-free: the candidate needs no wallet-operation row, so dry-run
 * evaluation and real enforcement share this exact decision path.
 *
 * @param input - The candidate plus the effective policy for each scope.
 * @returns The combined evaluation with per-scope detail and matched rules.
 */
export function evaluateCandidatePolicies(
  input: EvaluateCandidatePoliciesInput
): CandidatePolicyEvaluation {
  const wallet = evaluatePolicyScope({
    scope: "wallet",
    policy: input.walletPolicy,
    operation: input.candidate,
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
    wallet,
    apiKey,
    decision: selected.decision,
    reasonCode: allScopesUseImplicitAllow ? "implicit_default_allow" : selected.reasonCode,
    reason: summarizeScopeDecisions(scopes, selected),
    matchedRules: scopes.flatMap((scope) => scope.matchedRules),
    requiresApproval: isApprovalDecision(selected.decision),
    walletPolicyRevisionId: wallet.revisionId,
    apiKeyPolicyRevisionId: apiKey === null ? null : apiKey.revisionId,
  };
}

/**
 * Describe every rule in one scope's active revision against a candidate,
 * matched or not, with the action a match would contribute. Backs dry-run
 * criteria; an inactive scope (no revision) has no rules to describe.
 *
 * @param scope - The policy scope the rules belong to.
 * @param policy - The scope's effective policy.
 * @param candidate - The candidate under evaluation.
 * @returns One criterion per rule; empty when the scope has no active revision.
 */
export function describeCandidateRuleCriteria(
  scope: PolicyRuleScope,
  policy: EffectiveWalletPolicy | EffectiveApiKeyPolicy,
  candidate: PolicyCandidate
): PolicyDryRunCriterion[] {
  if (policy.revision === null) {
    return [];
  }

  return policy.revision.rules.map((rule) => {
    const evaluation = evaluatePolicyRule(rule, candidate);
    return {
      scope,
      ruleId: rule.id === undefined ? null : rule.id,
      kind: rule.kind,
      name: rule.name === undefined ? null : rule.name,
      matched: evaluation !== null,
      action: evaluation === null ? null : evaluation.decision,
      reason: evaluation === null ? null : evaluation.reason,
    };
  });
}

/**
 * Evaluate a persisted operation against its effective policies: the
 * candidate evaluation plus the audit context recorded alongside the
 * operation row.
 *
 * @param input - The operation plus the effective policy for each scope.
 * @returns The combined evaluation with per-scope detail and audit context.
 */
export function evaluateWalletOperationPolicies(
  input: EvaluateWalletOperationPoliciesInput
): WalletOperationPolicyEvaluation {
  const evaluation = evaluateCandidatePolicies({
    candidate: input.operation,
    walletPolicy: input.walletPolicy,
    apiKeyPolicy: input.apiKeyPolicy,
  });

  return {
    ...evaluation,
    operation: input.operation,
    evaluationContext: createPolicyEvaluationContext(
      input.operation,
      evaluation.wallet,
      evaluation.apiKey
    ),
  };
}

/**
 * Evaluate the API-key scope when the caller supplies an effective API-key
 * policy, or when the candidate was made with an API key (implicit allow).
 *
 * @param input - The evaluation input.
 * @returns The API-key scope evaluation, or null when no API key is involved.
 */
function resolveApiKeyScopeEvaluation(
  input: EvaluateCandidatePoliciesInput
): PolicyScopeEvaluation | null {
  if (input.apiKeyPolicy !== null) {
    return evaluatePolicyScope({
      scope: "api_key",
      policy: input.apiKeyPolicy,
      operation: input.candidate,
    });
  }
  if (input.candidate.apiKeyId !== null) {
    return evaluatePolicyScope({
      scope: "api_key",
      policy: IMPLICIT_DEFAULT_ALLOW_POLICY,
      operation: input.candidate,
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
  operation: PolicyCandidate;
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
