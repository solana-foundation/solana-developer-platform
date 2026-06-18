import type {
  EffectiveApiKeyPolicy,
  EffectiveWalletPolicy,
  MatchedPolicyRule,
  PolicyDecision,
  PolicyEvaluationContext,
  PolicyEvaluationReasonCode,
  PolicyRule,
  PolicyRuleAction,
  PolicyRuleScope,
  PolicyScopeEvaluation,
  WalletOperationEnvelope,
  WalletOperationFamily,
  WalletOperationPolicyEvaluation,
} from "@sdp/types";
import type { CreatePolicyEvaluationInput } from "@/db/repositories";
import { compareDecimalAmounts, isDecimalString } from "@/lib/amount";

type RuntimePolicyRule = PolicyRule | Record<string, unknown>;

interface EvaluateWalletOperationPoliciesInput {
  operation: WalletOperationEnvelope;
  walletPolicy: EffectiveWalletPolicy;
  apiKeyPolicy?: EffectiveApiKeyPolicy | null;
}

interface RuleEvaluation {
  decision: PolicyDecision;
  reason: string;
  rule: RuntimePolicyRule;
}

const DECISION_RANK: Record<PolicyDecision, number> = {
  not_evaluated: 0,
  allow: 1,
  review: 2,
  provider_approval_required: 3,
  approval_required: 4,
  deny: 5,
};

const RULE_ACTIONS = new Set<PolicyRuleAction>([
  "allow",
  "deny",
  "approval_required",
  "provider_approval_required",
  "review",
]);

export function evaluateWalletOperationPolicies(
  input: EvaluateWalletOperationPoliciesInput
): WalletOperationPolicyEvaluation {
  const wallet = evaluatePolicyScope({
    scope: "wallet",
    policy: input.walletPolicy,
    operation: input.operation,
  });
  const apiKey =
    input.apiKeyPolicy || input.operation.apiKeyId
      ? evaluatePolicyScope({
          scope: "api_key",
          policy: input.apiKeyPolicy ?? createImplicitApiKeyPolicy(),
          operation: input.operation,
        })
      : null;
  const scopes = apiKey ? [wallet, apiKey] : [wallet];
  const selected = selectStrictestDecision(scopes) ?? wallet;
  const allMatchedRules = scopes.flatMap((scope) => scope.matchedRules);
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
    matchedRules: allMatchedRules,
    evaluationContext: createPolicyEvaluationContext(input.operation, wallet, apiKey),
    requiresApproval: isApprovalDecision(selected.decision),
    walletPolicyRevisionId: wallet.revisionId,
    apiKeyPolicyRevisionId: apiKey?.revisionId ?? null,
  };
}

export function createPolicyEvaluationInput(
  result: WalletOperationPolicyEvaluation
): CreatePolicyEvaluationInput {
  return {
    walletOperationId: result.operation.id,
    walletPolicyRevisionId: result.walletPolicyRevisionId,
    apiKeyPolicyRevisionId: result.apiKeyPolicyRevisionId,
    decision: result.decision,
    reasonCode: result.reasonCode,
    reason: result.reason,
    matchedRules: result.matchedRules.map((rule) => ({ ...rule })),
    evaluationContext: result.evaluationContext,
    requiresApproval: result.requiresApproval,
  };
}

function evaluatePolicyScope(input: {
  scope: PolicyRuleScope;
  policy: EffectiveWalletPolicy | EffectiveApiKeyPolicy;
  operation: WalletOperationEnvelope;
}): PolicyScopeEvaluation {
  const revision = input.policy.revision;

  if (!revision) {
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

  const ruleEvaluations = revision.rules.flatMap((rule) => {
    const evaluation = evaluatePolicyRule(rule, input.operation);
    return evaluation ? [evaluation] : [];
  });
  const selectedRule = selectStrictestDecision(ruleEvaluations);

  if (selectedRule) {
    const matchedRules = ruleEvaluations.map((evaluation) =>
      toMatchedRule(input.scope, evaluation)
    );
    return {
      scope: input.scope,
      source: input.policy.source,
      profileId: input.policy.profile?.id ?? null,
      revisionId: revision.id,
      defaultAction: input.policy.defaultAction,
      decision: selectedRule.decision,
      reasonCode: matchedPolicyReasonCode(input.scope),
      reason: selectedRule.reason,
      matchedRules,
      requiresApproval: isApprovalDecision(selectedRule.decision),
    };
  }

  const defaultDecision = decisionFromAction(input.policy.defaultAction);
  return {
    scope: input.scope,
    source: input.policy.source,
    profileId: input.policy.profile?.id ?? null,
    revisionId: revision.id,
    defaultAction: input.policy.defaultAction,
    decision: defaultDecision,
    reasonCode: matchedPolicyReasonCode(input.scope),
    reason: `No ${scopeLabel(input.scope)} policy rules matched; default action ${input.policy.defaultAction} applies.`,
    matchedRules: [],
    requiresApproval: isApprovalDecision(defaultDecision),
  };
}

function evaluatePolicyRule(
  rule: RuntimePolicyRule,
  operation: WalletOperationEnvelope
): RuleEvaluation | null {
  const raw = rule as Record<string, unknown>;

  switch (raw.kind) {
    case "always":
      return createRuleEvaluation(rule, actionDecision(raw, "allow"), "Always rule matched.");
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
    case "approval":
      return evaluateApprovalRule(rule, operation);
    default:
      return createRuleEvaluation(
        rule,
        "review",
        typeof raw.kind === "string"
          ? `Unknown policy rule kind ${raw.kind} requires manual review.`
          : "Policy rule is missing a kind and requires manual review."
      );
  }
}

function evaluateOperationFamilyRule(
  rule: RuntimePolicyRule,
  operation: WalletOperationEnvelope
): RuleEvaluation | null {
  const raw = rule as Record<string, unknown>;
  const families = stringValues(raw.family, raw.families) as WalletOperationFamily[];

  if (families.length === 0) {
    return createRuleEvaluation(rule, "review", "Operation family rule has no families.");
  }

  if (!families.includes(operation.operationFamily)) {
    return null;
  }

  return createRuleEvaluation(
    rule,
    actionDecision(raw, "allow"),
    `Operation family ${operation.operationFamily} matched policy.`
  );
}

function evaluateOperationTypeRule(
  rule: RuntimePolicyRule,
  operation: WalletOperationEnvelope
): RuleEvaluation | null {
  const raw = rule as Record<string, unknown>;
  const operationTypes = stringValues(raw.operationType, raw.operationTypes);

  if (operationTypes.length === 0) {
    return createRuleEvaluation(rule, "review", "Operation type rule has no operation types.");
  }

  if (!operationTypes.includes(operation.operationType)) {
    return null;
  }

  return createRuleEvaluation(
    rule,
    actionDecision(raw, "allow"),
    `Operation type ${operation.operationType} matched policy.`
  );
}

function evaluateAssetRule(
  rule: RuntimePolicyRule,
  operation: WalletOperationEnvelope
): RuleEvaluation | null {
  const raw = rule as Record<string, unknown>;
  const assets = stringValues(raw.asset, raw.assets);

  if (assets.length === 0) {
    return createRuleEvaluation(rule, "review", "Asset rule has no assets.");
  }

  if (!operation.asset || !assets.includes(operation.asset)) {
    return null;
  }

  return createRuleEvaluation(
    rule,
    actionDecision(raw, "allow"),
    `Asset ${operation.asset} matched policy.`
  );
}

function evaluateDestinationRule(
  rule: RuntimePolicyRule,
  operation: WalletOperationEnvelope
): RuleEvaluation | null {
  const raw = rule as Record<string, unknown>;
  const blocklist = stringValues(undefined, raw.blocklist);
  const allowlist = stringValues(raw.destination, raw.destinations).concat(
    stringValues(undefined, raw.allowlist)
  );

  if (blocklist.length === 0 && allowlist.length === 0) {
    return createRuleEvaluation(rule, "review", "Destination rule has no allowlist or blocklist.");
  }

  if (operation.destination && blocklist.includes(operation.destination)) {
    return createRuleEvaluation(
      rule,
      "deny",
      `Destination ${operation.destination} is blocked by policy.`
    );
  }

  if (allowlist.length > 0) {
    if (!operation.destination || !allowlist.includes(operation.destination)) {
      return createRuleEvaluation(
        rule,
        "deny",
        operation.destination
          ? `Destination ${operation.destination} is not allowed by policy.`
          : "Operation has no destination for destination policy evaluation."
      );
    }

    return createRuleEvaluation(
      rule,
      actionDecision(raw, "allow"),
      `Destination ${operation.destination} matched policy.`
    );
  }

  return null;
}

function evaluateAmountRule(
  rule: RuntimePolicyRule,
  operation: WalletOperationEnvelope
): RuleEvaluation | null {
  const raw = rule as Record<string, unknown>;
  const assets = stringValues(raw.asset, raw.assets);

  if (assets.length > 0 && (!operation.asset || !assets.includes(operation.asset))) {
    return null;
  }

  if (operation.amount === null) {
    return null;
  }

  if (!isDecimalString(operation.amount)) {
    return createRuleEvaluation(
      rule,
      "review",
      "Operation amount is invalid for amount policy evaluation."
    );
  }

  const min = typeof raw.min === "string" ? raw.min : null;
  const max = typeof raw.max === "string" ? raw.max : null;
  if (min === null && max === null) {
    return createRuleEvaluation(rule, "review", "Amount rule has no min or max.");
  }
  if ((min !== null && !isDecimalString(min)) || (max !== null && !isDecimalString(max))) {
    return createRuleEvaluation(rule, "review", "Amount rule has an invalid decimal bound.");
  }
  if (min !== null && compareDecimalAmounts(operation.amount, min) < 0) {
    return createRuleEvaluation(
      rule,
      "deny",
      `Operation amount ${operation.amount} is below policy minimum ${min}.`
    );
  }
  if (max !== null && compareDecimalAmounts(operation.amount, max) > 0) {
    return createRuleEvaluation(
      rule,
      "deny",
      `Operation amount ${operation.amount} exceeds policy maximum ${max}.`
    );
  }

  return createRuleEvaluation(
    rule,
    actionDecision(raw, "allow"),
    `Operation amount ${operation.amount} matched policy.`
  );
}

function evaluateApprovalRule(
  rule: RuntimePolicyRule,
  operation: WalletOperationEnvelope
): RuleEvaluation | null {
  const raw = rule as Record<string, unknown>;
  const families = stringValues(undefined, raw.families);
  const operationTypes = stringValues(undefined, raw.operationTypes);
  const assets = stringValues(undefined, raw.assets);

  if (families.length > 0 && !families.includes(operation.operationFamily)) {
    return null;
  }
  if (operationTypes.length > 0 && !operationTypes.includes(operation.operationType)) {
    return null;
  }
  if (assets.length > 0 && (!operation.asset || !assets.includes(operation.asset))) {
    return null;
  }

  return createRuleEvaluation(
    rule,
    actionDecision(raw, "approval_required"),
    "Approval policy matched operation."
  );
}

function createImplicitApiKeyPolicy(): EffectiveApiKeyPolicy {
  return {
    source: "implicit_default_allow",
    profile: null,
    revision: null,
    defaultAction: "allow",
  };
}

function createRuleEvaluation(
  rule: RuntimePolicyRule,
  decision: PolicyDecision,
  reason: string
): RuleEvaluation {
  return { rule, decision, reason };
}

function toMatchedRule(scope: PolicyRuleScope, evaluation: RuleEvaluation): MatchedPolicyRule {
  const raw = evaluation.rule as Record<string, unknown>;
  return {
    scope,
    ruleId: typeof raw.id === "string" ? raw.id : null,
    kind: typeof raw.kind === "string" ? raw.kind : "unknown",
    decision: evaluation.decision,
    reason: evaluation.reason,
    rule: { ...raw },
  };
}

function selectStrictestDecision<T extends { decision: PolicyDecision }>(items: T[]): T | null {
  return items.reduce<T | null>((selected, item) => {
    if (!selected || DECISION_RANK[item.decision] > DECISION_RANK[selected.decision]) {
      return item;
    }
    return selected;
  }, null);
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
  return {
    operation: {
      id: operation.id,
      organizationId: operation.organizationId,
      projectId: operation.projectId,
      custodyWalletId: operation.custodyWalletId,
      walletId: operation.walletId,
      apiKeyId: operation.apiKeyId,
      actor: operation.actor,
      source: operation.source,
      operationFamily: operation.operationFamily,
      operationType: operation.operationType,
      asset: operation.asset,
      amount: operation.amount,
      destination: operation.destination,
      context: operation.context,
      providerExtensions: operation.providerExtensions,
      idempotencyKey: operation.idempotencyKey,
      rawPayload: operation.rawPayload,
      createdAt: operation.createdAt,
    },
    walletPolicy: createPolicyContext(wallet),
    apiKeyPolicy: apiKey ? createPolicyContext(apiKey) : null,
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

function stringValues(single: unknown, many: unknown): string[] {
  const values: string[] = [];
  if (typeof single === "string" && single.length > 0) {
    values.push(single);
  }
  if (Array.isArray(many)) {
    values.push(...many.filter((value): value is string => typeof value === "string"));
  }
  return [...new Set(values)];
}

function actionDecision(raw: Record<string, unknown>, fallback: PolicyRuleAction): PolicyDecision {
  return decisionFromAction(isPolicyRuleAction(raw.action) ? raw.action : fallback);
}

function decisionFromAction(action: PolicyRuleAction): PolicyDecision {
  return action;
}

function isPolicyRuleAction(value: unknown): value is PolicyRuleAction {
  return typeof value === "string" && RULE_ACTIONS.has(value as PolicyRuleAction);
}

function isApprovalDecision(decision: PolicyDecision): boolean {
  return decision === "approval_required" || decision === "provider_approval_required";
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
