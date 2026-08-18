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
  PolicyRule,
  PolicyRuleScope,
  PolicyScopeEvaluation,
  WalletOperationEnvelope,
  WalletOperationPolicyEvaluation,
} from "@sdp/types";
import { DECISION_RANK, isApprovalDecision } from "./decisions";
import { evaluatePolicyRule, type RuleEvaluation } from "./rules";

interface CandidateView {
  candidate: PolicyCandidate;
  leg: number | null;
}

type ViewRuleEvaluation = RuleEvaluation & { leg: number | null };

/** The effective policy applied when no profile is active for a scope. */
export const IMPLICIT_DEFAULT_ALLOW_POLICY: EffectivePolicy<never, never> = {
  source: "implicit_default_allow",
  profile: null,
  revision: null,
  defaultAction: "allow",
};

export interface EvaluateCandidatePoliciesInput {
  candidate: PolicyCandidate;
  legs: PolicyCandidate[];
  walletPolicy: EffectiveWalletPolicy;
  apiKeyPolicy: EffectiveApiKeyPolicy | null;
}

export interface EvaluateWalletOperationPoliciesInput {
  operation: WalletOperationEnvelope;
  legs: PolicyCandidate[];
  walletPolicy: EffectiveWalletPolicy;
  apiKeyPolicy: EffectiveApiKeyPolicy | null;
}

/**
 * Evaluate a candidate operation against its effective wallet and API-key
 * policies and combine the scope decisions, strictest wins. Pure and
 * persistence-free: the candidate needs no wallet-operation row, so dry-run
 * evaluation and real enforcement share this exact decision path.
 *
 * A multi-leg operation (a transfer batch) evaluates every leg in full and
 * the aggregate candidate for everything except destination rules: the
 * operation names its destinations on the legs, so destination rules decide
 * per leg and abstain on the aggregate view rather than failing it closed
 * for having no destination of its own.
 *
 * @param input - The candidate, its legs, and the effective policy for each scope.
 * @returns The combined evaluation with per-scope detail and matched rules.
 */
export function evaluateCandidatePolicies(
  input: EvaluateCandidatePoliciesInput
): CandidatePolicyEvaluation {
  const wallet = evaluatePolicyScope({
    scope: "wallet",
    policy: input.walletPolicy,
    views: candidateViews(input.candidate, input.legs),
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
 * Describe every rule in one scope's active revision against a candidate and
 * its legs, matched or not, with the action a match would contribute. Backs
 * dry-run criteria; an inactive scope (no revision) has no rules to describe.
 * Each leg gets its own criterion per rule, identified by `leg`.
 *
 * @param scope - The policy scope the rules belong to.
 * @param policy - The scope's effective policy.
 * @param candidate - The candidate under evaluation.
 * @param legs - The candidate's legs, empty for single-leg operations.
 * @returns One criterion per rule per evaluated view; empty when the scope has no active revision.
 */
export function describeCandidateRuleCriteria(
  scope: PolicyRuleScope,
  policy: EffectiveWalletPolicy | EffectiveApiKeyPolicy,
  candidate: PolicyCandidate,
  legs: PolicyCandidate[]
): PolicyDryRunCriterion[] {
  const revision = policy.revision;
  if (revision === null) {
    return [];
  }

  return candidateViews(candidate, legs).flatMap((view) =>
    viewRules(revision.rules, view, legs.length > 0).map((rule) => {
      const evaluation = evaluatePolicyRule(rule, view.candidate);
      return {
        scope,
        ruleId: rule.id === undefined ? null : rule.id,
        kind: rule.kind,
        name: rule.name === undefined ? null : rule.name,
        matched: evaluation !== null,
        action: evaluation === null ? null : evaluation.decision,
        reason: evaluation === null ? null : evaluation.reason,
        leg: view.leg,
      };
    })
  );
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
    legs: input.legs,
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
      views: candidateViews(input.candidate, input.legs),
    });
  }
  if (input.candidate.apiKeyId !== null) {
    return evaluatePolicyScope({
      scope: "api_key",
      policy: IMPLICIT_DEFAULT_ALLOW_POLICY,
      views: candidateViews(input.candidate, input.legs),
    });
  }
  return null;
}

/**
 * The evaluation views of a candidate: the aggregate candidate itself plus
 * one view per leg, each identified by its zero-based leg index.
 *
 * @param candidate - The aggregate candidate.
 * @param legs - The candidate's legs, empty for single-leg operations.
 * @returns The views in evaluation order, aggregate first.
 */
function candidateViews(candidate: PolicyCandidate, legs: PolicyCandidate[]): CandidateView[] {
  return [{ candidate, leg: null }, ...legs.map((leg, index) => ({ candidate: leg, leg: index }))];
}

/**
 * The rules that apply to one evaluation view. Destination rules decide per
 * leg, so on a multi-leg operation they are excluded from the aggregate view
 * whose null destination would otherwise fail them closed.
 *
 * @param rules - The revision's rules.
 * @param view - The view under evaluation.
 * @param hasLegs - Whether the operation carries legs.
 * @returns The rules the view evaluates.
 */
function viewRules(rules: PolicyRule[], view: CandidateView, hasLegs: boolean): PolicyRule[] {
  if (!hasLegs || view.leg !== null) {
    return rules;
  }
  return rules.filter((rule) => rule.kind !== "destination");
}

/**
 * Evaluate one scope's effective policy: run every rule against every view,
 * pick the strictest match, and fall back to the revision's default action
 * when nothing matched.
 *
 * @param input - The scope, its effective policy, and the operation's views.
 * @returns The scope's evaluation.
 */
function evaluatePolicyScope(input: {
  scope: PolicyRuleScope;
  policy: EffectiveWalletPolicy | EffectiveApiKeyPolicy;
  views: CandidateView[];
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
  const hasLegs = input.views.some((view) => view.leg !== null);
  const ruleEvaluations = input.views.flatMap((view) =>
    viewRules(revision.rules, view, hasLegs).flatMap((rule) => {
      const evaluation = evaluatePolicyRule(rule, view.candidate);
      return evaluation === null ? [] : [{ ...evaluation, leg: view.leg }];
    })
  );
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
      reason: viewReason(selectedRule),
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
function selectStrictestRule(evaluations: ViewRuleEvaluation[]): ViewRuleEvaluation | null {
  let selected: ViewRuleEvaluation | null = null;
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

function toMatchedRule(scope: PolicyRuleScope, evaluation: ViewRuleEvaluation): MatchedPolicyRule {
  return {
    scope,
    ruleId: evaluation.rule.id === undefined ? null : evaluation.rule.id,
    kind: evaluation.rule.kind,
    decision: evaluation.decision,
    reason: evaluation.reason,
    rule: evaluation.rule,
    leg: evaluation.leg,
  };
}

/**
 * A rule evaluation's reason, prefixed with the leg it decided when the
 * operation carries legs.
 *
 * @param evaluation - The selected rule evaluation.
 * @returns The reason to surface for the scope.
 */
function viewReason(evaluation: ViewRuleEvaluation): string {
  return evaluation.leg === null
    ? evaluation.reason
    : `Leg ${evaluation.leg + 1}: ${evaluation.reason}`;
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
